package main

import (
	"bytes"
	"crypto/sha256"
	"embed"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"io/fs"
	"mime"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

//go:embed web
var webFS embed.FS

// emptyTree is Git's well-known empty tree, used as the diff base before the first commit.
const emptyTree = "4b825dc642cb6eb9a060e54bf8d69288fbee4904"

// maxUntrackedDiff caps the size of an untracked file rendered as a new-file diff.
const maxUntrackedDiff = 1 << 20

type Config struct {
	Vim        bool           `json:"vim"`
	Theme      string         `json:"theme"`
	DiffMode   string         `json:"diffMode"`
	GutterBase string         `json:"gutterBase"`
	Panels     []string       `json:"panels"`
	PanelSizes map[string]int `json:"panelSizes"`
}

type App struct {
	root  string
	hosts map[string]bool
	cfg   Config
	mu    sync.Mutex
	sigs  map[string]fileSig
}

type fileSig struct {
	mod    time.Time
	size   int64
	hash   string
	lines  int
	binary bool
}

// Commit carries the full hash for copying and diffing, and the short one for display.
type Commit struct {
	Hash    string `json:"hash"`
	Short   string `json:"short"`
	Author  string `json:"author"`
	Time    int64  `json:"time"`
	Subject string `json:"subject"`
}

type Stash struct {
	Ref     string `json:"ref"`
	Subject string `json:"subject"`
}

type Change struct {
	Path    string `json:"path"`
	Code    string `json:"code"`
	Staged  bool   `json:"staged"`
	Added   int    `json:"added"`
	Deleted int    `json:"deleted"`
	Binary  bool   `json:"binary,omitempty"`
	Hash    string `json:"hash"`
}

type GitStatus struct {
	Git      bool     `json:"git"`
	Root     string   `json:"root"`
	Branch   string   `json:"branch"`
	Changes  []Change `json:"changes"`
	Commits  []Commit `json:"commits"`
	Branches []string `json:"branches"`
	Stashes  []Stash  `json:"stashes"`
	Error    string   `json:"error,omitempty"`
}

type TreeNode struct {
	Name     string     `json:"name"`
	Path     string     `json:"path"`
	Dir      bool       `json:"dir"`
	Children []TreeNode `json:"children,omitempty"`
}

type gitRequest struct {
	Action   string   `json:"action"`
	Paths    []string `json:"paths"`
	Message  string   `json:"message"`
	From     string   `json:"from"`
	To       string   `json:"to"`
	StashRef string   `json:"stashRef"`
}

func main() {
	port := flag.Int("port", 7777, "port to listen on")
	noOpen := flag.Bool("no-open", false, "do not launch a browser")
	flag.Parse()

	root, err := os.Getwd()
	if err != nil {
		fatal(err)
	}
	if flag.NArg() > 0 {
		root = flag.Arg(0)
	}
	root, err = filepath.Abs(root)
	if err != nil {
		fatal(err)
	}

	app := newApp(root, *port)
	addr := "127.0.0.1:" + strconv.Itoa(*port)
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		fatal(err)
	}
	url := "http://" + addr
	fmt.Printf("echo %s\n", root)
	fmt.Printf("open %s\n", url)
	if !*noOpen {
		_ = openBrowser(url)
	}
	if err := http.Serve(ln, app.routes()); err != nil {
		fatal(err)
	}
}

func newApp(root string, port int) *App {
	p := strconv.Itoa(port)
	return &App{
		root:  root,
		cfg:   loadConfig(),
		sigs:  map[string]fileSig{},
		hosts: map[string]bool{"127.0.0.1:" + p: true, "localhost:" + p: true},
	}
}

func (a *App) routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/api/tree", a.handleTree)
	mux.HandleFunc("/api/file", a.handleFile)
	mux.HandleFunc("/api/git/status", a.handleGitStatus)
	mux.HandleFunc("/api/git", a.handleGit)
	mux.HandleFunc("/api/diff", a.handleDiff)
	mux.HandleFunc("/api/stream", a.handleStream)
	mux.HandleFunc("/api/config", a.handleConfig)

	assets, err := fs.Sub(webFS, "web")
	if err != nil {
		panic(err)
	}
	mux.Handle("/", http.FileServer(http.FS(assets)))
	return a.guard(mux)
}

// guard only admits requests from echo's own page: a foreign Host means DNS rebinding,
// a foreign Origin means another site, and a non-JSON write is a CSRF-style simple request.
func (a *App) guard(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !a.hosts[r.Host] {
			http.Error(w, "forbidden host", http.StatusForbidden)
			return
		}
		if origin := r.Header.Get("Origin"); origin != "" && origin != "http://"+r.Host {
			http.Error(w, "forbidden origin", http.StatusForbidden)
			return
		}
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			if ct, _, _ := mime.ParseMediaType(r.Header.Get("Content-Type")); ct != "application/json" {
				http.Error(w, "content type must be application/json", http.StatusUnsupportedMediaType)
				return
			}
		}
		next.ServeHTTP(w, r)
	})
}

func (a *App) handleTree(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, a.tree())
}

func (a *App) tree() []TreeNode {
	var out []TreeNode
	_ = filepath.WalkDir(a.root, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if path == a.root {
			return nil
		}
		rel, _ := filepath.Rel(a.root, path)
		if skipDir(d.Name()) && d.IsDir() {
			return filepath.SkipDir
		}
		if strings.HasPrefix(rel, ".") && !d.IsDir() {
			return nil
		}
		if d.IsDir() {
			return nil
		}
		out = append(out, TreeNode{Name: d.Name(), Path: filepath.ToSlash(rel)})
		return nil
	})
	sort.Slice(out, func(i, j int) bool { return out[i].Path < out[j].Path })
	return out
}

func skipDir(name string) bool {
	if strings.HasPrefix(name, ".") {
		return true
	}
	switch name {
	case "node_modules", "dist", "build", ".cache", ".next":
		return true
	}
	return false
}

func (a *App) handleFile(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodPut || r.Method == http.MethodPost {
		a.handleFileWrite(w, r)
		return
	}
	rel := r.URL.Query().Get("path")
	path, err := a.safePath(rel)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	if rev := r.URL.Query().Get("rev"); rev != "" {
		a.handleFileRev(w, rel, rev)
		return
	}
	data, err := os.ReadFile(path)
	if err != nil {
		http.Error(w, err.Error(), http.StatusNotFound)
		return
	}
	sig, _ := readSig(bytes.NewReader(data))
	content := string(data)
	if sig.binary {
		content = ""
	}
	writeJSON(w, map[string]any{"path": filepath.ToSlash(rel), "content": content, "hash": sig.hash, "binary": sig.binary})
}

// handleFileRev returns a file as it is at HEAD or in the index, for the editor's change bars.
// A path missing from that version is not an error: it reports exists=false, as for a new file.
func (a *App) handleFileRev(w http.ResponseWriter, rel, rev string) {
	var object string
	switch rev {
	case "head":
		object = "HEAD:./" + filepath.ToSlash(rel)
	case "index":
		object = ":./" + filepath.ToSlash(rel)
	default:
		http.Error(w, "unknown rev", http.StatusBadRequest)
		return
	}
	out, err := a.git("show", object)
	if err != nil {
		writeJSON(w, map[string]any{"exists": false, "content": ""})
		return
	}
	sig, _ := readSig(strings.NewReader(out))
	if sig.binary {
		out = ""
	}
	writeJSON(w, map[string]any{"exists": true, "content": out, "binary": sig.binary})
}

func (a *App) handleFileWrite(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Action   string `json:"action"`
		Path     string `json:"path"`
		NewPath  string `json:"newPath"`
		Content  string `json:"content"`
		BaseHash string `json:"baseHash"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	path, err := a.safePath(req.Path)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	switch req.Action {
	case "", "save":
		// A base hash means "only save if the file is still what I opened", so an
		// agent's edit made while the tab was open is never silently overwritten.
		if req.BaseHash != "" {
			current, err := os.ReadFile(path)
			if errors.Is(err, fs.ErrNotExist) {
				http.Error(w, "file was deleted on disk since it was opened", http.StatusConflict)
				return
			}
			if err == nil && hashBytes(current) != req.BaseHash {
				http.Error(w, "file changed on disk since it was opened", http.StatusConflict)
				return
			}
		}
		if err := os.WriteFile(path, []byte(req.Content), 0o644); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		writeJSON(w, map[string]any{"ok": true, "hash": hashBytes([]byte(req.Content))})
		return
	case "create":
		if req.NewPath == "" {
			req.NewPath = req.Path
		}
		path, err = a.safePath(req.NewPath)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		if err := os.WriteFile(path, []byte(req.Content), 0o644); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
	case "delete":
		if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
	case "rename":
		if req.NewPath == "" {
			http.Error(w, "newPath required", http.StatusBadRequest)
			return
		}
		newPath, err := a.safePath(req.NewPath)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		if err := os.MkdirAll(filepath.Dir(newPath), 0o755); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		if err := os.Rename(path, newPath); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
	default:
		http.Error(w, "unknown file action", http.StatusBadRequest)
		return
	}
	writeJSON(w, map[string]bool{"ok": true})
}

func (a *App) handleGitStatus(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, a.gitStatus())
}

func (a *App) gitStatus() GitStatus {
	status := GitStatus{Git: true, Root: a.root, Changes: []Change{}}
	if _, err := exec.LookPath("git"); err != nil {
		status.Git = false
		status.Error = "git not found"
		return status
	}
	out, err := a.git("branch", "--show-current")
	if err != nil {
		status.Git = false
		status.Error = err.Error()
		return status
	}
	status.Branch = strings.TrimSpace(out)
	if status.Branch == "" {
		if head, err := a.git("rev-parse", "--short", "HEAD"); err == nil {
			status.Branch = "detached@" + strings.TrimSpace(head)
		}
	}
	out, err = a.git("status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all")
	if err != nil {
		status.Error = err.Error()
		return status
	}
	status.Changes = parsePorcelain(out)
	stats := map[string]Change{}
	if out, err := a.git("diff", "--numstat", "-z", "--no-renames", a.base(), "--"); err == nil {
		stats = parseNumstat(out)
	}
	for i := range status.Changes {
		c := &status.Changes[i]
		sig, ok := a.sig(c.Path)
		c.Hash = "deleted"
		if ok {
			c.Hash = sig.hash
		}
		if s, found := stats[c.Path]; found {
			c.Added, c.Deleted, c.Binary = s.Added, s.Deleted, s.Binary
		} else if c.Code == "??" && ok {
			c.Added, c.Binary = sig.lines, sig.binary
		}
	}
	// %aN applies .mailmap, so the author shows under their canonical full name. The time is
	// absolute (%at) so the status only changes when history does; the browser renders "2h ago".
	if out, err := a.git("log", "-n", "100", "--format=%H%x09%h%x09%aN%x09%at%x09%s"); err == nil {
		status.Commits = parseCommits(out)
	}
	if out, err := a.git("branch", "-a", "--format=%(refname:short)"); err == nil {
		status.Branches = parseLines(out)
	}
	if out, err := a.git("stash", "list", "--format=%gd%x09%s"); err == nil {
		status.Stashes = parseStashes(out)
	}
	return status
}

// base is the tree that "all changes" compares against: HEAD, or the empty tree before the first commit.
func (a *App) base() string {
	if _, err := a.git("rev-parse", "--verify", "-q", "HEAD"); err != nil {
		return emptyTree
	}
	return "HEAD"
}

// sig returns a workspace file's content hash, re-reading it only when size or mtime change.
func (a *App) sig(rel string) (fileSig, bool) {
	path, err := a.safePath(rel)
	if err != nil {
		return fileSig{}, false
	}
	info, err := os.Stat(path)
	if err != nil || info.IsDir() {
		return fileSig{}, false
	}
	a.mu.Lock()
	cached, ok := a.sigs[rel]
	a.mu.Unlock()
	if ok && cached.size == info.Size() && cached.mod.Equal(info.ModTime()) {
		return cached, true
	}
	f, err := os.Open(path)
	if err != nil {
		return fileSig{}, false
	}
	defer f.Close()
	sig, err := readSig(f)
	if err != nil {
		return fileSig{}, false
	}
	sig.mod, sig.size = info.ModTime(), info.Size()
	a.mu.Lock()
	a.sigs[rel] = sig
	a.mu.Unlock()
	return sig, true
}

// readSig hashes content and counts its lines the way git does; NUL bytes in the first 8000 bytes mean binary.
func readSig(r io.Reader) (fileSig, error) {
	var sig fileSig
	h := sha256.New()
	buf := make([]byte, 32<<10)
	var read int
	var last byte
	for {
		n, err := r.Read(buf)
		chunk := buf[:n]
		h.Write(chunk)
		if read < 8000 && bytes.IndexByte(chunk[:min(n, 8000-read)], 0) >= 0 {
			sig.binary = true
		}
		sig.lines += bytes.Count(chunk, []byte{'\n'})
		if n > 0 {
			last = chunk[n-1]
		}
		read += n
		if err == io.EOF {
			break
		}
		if err != nil {
			return sig, err
		}
	}
	if read > 0 && last != '\n' {
		sig.lines++
	}
	if sig.binary {
		sig.lines = 0
	}
	sig.hash = hex.EncodeToString(h.Sum(nil))[:16]
	return sig, nil
}

func hashBytes(b []byte) string {
	sig, _ := readSig(bytes.NewReader(b))
	return sig.hash
}

func (a *App) handleGit(w http.ResponseWriter, r *http.Request) {
	var req gitRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	var out string
	var err error
	if req.Action == "discard" {
		out, err = a.discard(req.Paths)
	} else {
		args, argErr := a.gitArgs(req)
		if argErr != nil {
			http.Error(w, argErr.Error(), http.StatusBadRequest)
			return
		}
		out, err = a.gitCombined(args...)
	}
	if err != nil {
		http.Error(w, strings.TrimSpace(out+"\n"+err.Error()), http.StatusBadGateway)
		return
	}
	writeJSON(w, map[string]any{"ok": true, "output": out})
}

func (a *App) gitArgs(req gitRequest) ([]string, error) {
	paths := req.Paths
	for i := range paths {
		if _, err := a.safePath(paths[i]); err != nil {
			return nil, err
		}
	}
	switch req.Action {
	case "add":
		return append([]string{"add", "--"}, paths...), nil
	case "unstage":
		return append([]string{"restore", "--staged", "--"}, paths...), nil
	case "commit":
		if strings.TrimSpace(req.Message) == "" {
			return nil, errors.New("commit message required")
		}
		return []string{"commit", "-m", req.Message}, nil
	case "amend":
		if strings.TrimSpace(req.Message) == "" {
			return nil, errors.New("commit message required")
		}
		return []string{"commit", "--amend", "-m", req.Message}, nil
	case "rebase", "merge", "branch:create", "branch:switch":
		if err := validRef(req.From); err != nil {
			return nil, err
		}
		switch req.Action {
		case "branch:create":
			return []string{"switch", "-c", req.From}, nil
		case "branch:switch":
			return []string{"switch", req.From}, nil
		}
		return []string{req.Action, req.From}, nil
	case "pull":
		return []string{"pull"}, nil
	case "push":
		return []string{"push"}, nil
	case "stash:create":
		if strings.TrimSpace(req.Message) == "" {
			req.Message = "echo stash"
		}
		return []string{"stash", "push", "-u", "-m", req.Message}, nil
	case "stash:apply", "stash:pop", "stash:drop":
		if err := validRef(req.StashRef); err != nil {
			return nil, err
		}
		return []string{"stash", strings.TrimPrefix(req.Action, "stash:"), req.StashRef}, nil
	default:
		return nil, fmt.Errorf("unknown git action: %s", req.Action)
	}
}

// validRef keeps user-typed refs from being read as git options or split into extra words.
func validRef(ref string) error {
	if ref == "" {
		return errors.New("ref required")
	}
	if strings.HasPrefix(ref, "-") {
		return fmt.Errorf("invalid ref %q: refs cannot start with '-'", ref)
	}
	for _, r := range ref {
		if r <= ' ' || r == 0x7f {
			return fmt.Errorf("invalid ref %q: refs cannot contain spaces or control characters", ref)
		}
	}
	return nil
}

// discard restores tracked paths and deletes untracked ones, so files an agent created can be rejected too.
func (a *App) discard(paths []string) (string, error) {
	if len(paths) == 0 {
		return "", errors.New("paths required")
	}
	for _, p := range paths {
		if _, err := a.safePath(p); err != nil {
			return "", err
		}
	}
	out, err := a.git(append([]string{"ls-files", "--others", "--exclude-standard", "-z", "--"}, paths...)...)
	if err != nil {
		return "", err
	}
	untracked := map[string]bool{}
	for _, p := range strings.Split(out, "\x00") {
		if p != "" {
			untracked[p] = true
		}
	}
	var tracked, extra []string
	for _, p := range paths {
		if untracked[filepath.ToSlash(filepath.Clean(p))] {
			extra = append(extra, p)
		} else {
			tracked = append(tracked, p)
		}
	}
	if len(extra) > 0 {
		if out, err := a.gitCombined(append([]string{"clean", "-f", "-q", "--"}, extra...)...); err != nil {
			return out, err
		}
	}
	if len(tracked) > 0 {
		return a.gitCombined(append([]string{"restore", "--staged", "--worktree", "--"}, tracked...)...)
	}
	return "", nil
}

func (a *App) handleDiff(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	flags := []string{"--no-ext-diff", "--no-color", "--no-renames", "--unified=3"}
	if q.Get("ignoreWhitespace") == "1" {
		flags = append(flags, "--ignore-all-space")
	}
	args := append([]string{"diff"}, flags...)
	untracked := false
	switch q.Get("scope") {
	case "", "head":
		args = append(args, a.base())
		untracked = true
	case "worktree":
		untracked = true
	case "staged":
		args = append(args, "--cached")
	case "range":
		from, to := q.Get("from"), q.Get("to")
		for _, ref := range []string{from, to} {
			if err := validRef(ref); err != nil {
				http.Error(w, err.Error(), http.StatusBadRequest)
				return
			}
		}
		args = append(args, from+".."+to)
	case "commit":
		ref := q.Get("ref")
		if err := validRef(ref); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		args = append(append([]string{"show", "--format=", "--diff-merges=first-parent"}, flags...), ref)
	default:
		http.Error(w, "unknown diff scope", http.StatusBadRequest)
		return
	}
	out, err := a.git(append(args, "--")...)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	if untracked {
		out += a.untrackedDiff()
	}
	writeJSON(w, map[string]string{"text": out})
}

// untrackedDiff renders untracked files as new-file diffs; plain `git diff` leaves them out.
func (a *App) untrackedDiff() string {
	out, err := a.git("ls-files", "--others", "--exclude-standard", "-z")
	if err != nil {
		return ""
	}
	var b strings.Builder
	for _, rel := range strings.Split(out, "\x00") {
		if rel == "" {
			continue
		}
		path, err := a.safePath(rel)
		if err != nil {
			continue
		}
		info, err := os.Stat(path)
		if err != nil || info.IsDir() {
			continue
		}
		if info.Size() > maxUntrackedDiff {
			fmt.Fprintf(&b, "diff --git a/%s b/%s\nnew file mode 100644\necho: %d bytes, too large to diff\n", rel, rel, info.Size())
			continue
		}
		// --no-index exits 1 when the files differ, so the error is expected; stdout is the diff.
		d, _ := a.git("diff", "--no-index", "--no-color", "--no-ext-diff", "--", "/dev/null", rel)
		b.WriteString(d)
	}
	return b.String()
}

func (a *App) handleStream(w http.ResponseWriter, r *http.Request) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "stream unsupported", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	ticker := time.NewTicker(2 * time.Second)
	defer ticker.Stop()
	var last []byte
	send := func() {
		data, _ := json.Marshal(a.gitStatus())
		if bytes.Equal(data, last) {
			return
		}
		last = data
		fmt.Fprintf(w, "data: %s\n\n", data)
		flusher.Flush()
	}
	send()
	for {
		select {
		case <-r.Context().Done():
			return
		case <-ticker.C:
			send()
		}
	}
}

func (a *App) handleConfig(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodGet {
		a.mu.Lock()
		writeJSON(w, a.cfg)
		a.mu.Unlock()
		return
	}
	var cfg Config
	if err := json.NewDecoder(r.Body).Decode(&cfg); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	a.mu.Lock()
	a.cfg = cfg
	a.mu.Unlock()
	_ = saveConfig(cfg)
	writeJSON(w, cfg)
}

func (a *App) safePath(rel string) (string, error) {
	if rel == "" {
		return a.root, nil
	}
	if filepath.IsAbs(rel) {
		return "", errors.New("absolute paths are not allowed")
	}
	clean := filepath.Clean(filepath.Join(a.root, rel))
	r, err := filepath.Rel(a.root, clean)
	if err != nil || r == ".." || strings.HasPrefix(r, ".."+string(filepath.Separator)) {
		return "", errors.New("path escapes workspace")
	}
	return clean, nil
}

// gitCmd never takes optional locks, so echo's polling cannot collide with an agent's git commands.
func (a *App) gitCmd(args ...string) *exec.Cmd {
	cmd := exec.Command("git", append([]string{"--no-optional-locks", "-c", "core.quotePath=false"}, args...)...)
	cmd.Dir = a.root
	cmd.Env = append(os.Environ(), "GIT_TERMINAL_PROMPT=0")
	return cmd
}

// git returns stdout only, so warnings on stderr never leak into parsed output.
func (a *App) git(args ...string) (string, error) {
	cmd := a.gitCmd(args...)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	out, err := cmd.Output()
	if err != nil {
		if msg := strings.TrimSpace(stderr.String()); msg != "" {
			err = errors.New(msg)
		}
	}
	return string(out), err
}

// gitCombined returns stdout and stderr together, for actions like push whose progress goes to stderr.
func (a *App) gitCombined(args ...string) (string, error) {
	out, err := a.gitCmd(args...).CombinedOutput()
	return string(out), err
}

func parseLines(s string) []string {
	var out []string
	for _, line := range strings.Split(s, "\n") {
		if line = strings.TrimSpace(line); line != "" {
			out = append(out, line)
		}
	}
	return out
}

// parsePorcelain reads `git status --porcelain=v1 -z` entries: "XY path", with renames followed by the old path.
func parsePorcelain(s string) []Change {
	out := []Change{}
	entries := strings.Split(s, "\x00")
	for i := 0; i < len(entries); i++ {
		entry := entries[i]
		if len(entry) < 4 {
			continue
		}
		code := entry[:2]
		out = append(out, Change{Path: entry[3:], Code: code, Staged: code[0] != ' ' && code[0] != '?'})
		if code[0] == 'R' || code[0] == 'C' {
			i++
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Path < out[j].Path })
	return out
}

// parseNumstat reads `git diff --numstat -z --no-renames` records: "added\tdeleted\tpath"; binary files use "-".
func parseNumstat(s string) map[string]Change {
	out := map[string]Change{}
	for _, rec := range strings.Split(s, "\x00") {
		parts := strings.SplitN(rec, "\t", 3)
		if len(parts) != 3 {
			continue
		}
		c := Change{Path: parts[2], Binary: parts[0] == "-"}
		c.Added, _ = strconv.Atoi(parts[0])
		c.Deleted, _ = strconv.Atoi(parts[1])
		out[c.Path] = c
	}
	return out
}

// parseCommits reads "full\tshort\tauthor\tunixtime\tsubject" lines; the subject is last because it may contain tabs.
func parseCommits(s string) []Commit {
	var out []Commit
	for _, line := range strings.Split(s, "\n") {
		parts := strings.SplitN(line, "\t", 5)
		if len(parts) == 5 {
			t, _ := strconv.ParseInt(parts[3], 10, 64)
			out = append(out, Commit{Hash: parts[0], Short: parts[1], Author: parts[2], Time: t, Subject: parts[4]})
		}
	}
	return out
}

func parseStashes(s string) []Stash {
	var out []Stash
	for _, line := range strings.Split(s, "\n") {
		parts := strings.SplitN(line, "\t", 2)
		if len(parts) == 2 {
			out = append(out, Stash{Ref: parts[0], Subject: parts[1]})
		}
	}
	return out
}

func loadConfig() Config {
	cfg := Config{DiffMode: "unified", GutterBase: "head", Panels: []string{"tree", "editor", "git"}, PanelSizes: map[string]int{}}
	data, err := os.ReadFile(configPath())
	if err == nil {
		_ = json.Unmarshal(data, &cfg)
	}
	return cfg
}

func saveConfig(cfg Config) error {
	if err := os.MkdirAll(filepath.Dir(configPath()), 0o755); err != nil {
		return err
	}
	data, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(configPath(), data, 0o644)
}

func configPath() string {
	dir, err := os.UserConfigDir()
	if err != nil {
		dir = "."
	}
	return filepath.Join(dir, "echo", "config.json")
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(v)
}

func openBrowser(url string) error {
	return exec.Command("open", url).Start()
}

func fatal(err error) {
	fmt.Fprintln(os.Stderr, err)
	os.Exit(1)
}
