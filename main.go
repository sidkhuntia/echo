package main

import (
	"archive/zip"
	"bufio"
	"bytes"
	"context"
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
	"os/signal"
	"path"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
	"unicode/utf8"
)

//go:embed web
var webFS embed.FS

// build identifies the embedded web assets, so a page loaded from an older binary can tell it is stale.
var build = func() string {
	h := sha256.New()
	fs.WalkDir(webFS, "web", func(p string, d fs.DirEntry, err error) error {
		if err == nil && !d.IsDir() {
			b, _ := webFS.ReadFile(p)
			h.Write([]byte(p))
			h.Write(b)
		}
		return nil
	})
	return hex.EncodeToString(h.Sum(nil))[:12]
}()

// emptyTree is Git's well-known empty tree, used as the diff base before the first commit.
const emptyTree = "4b825dc642cb6eb9a060e54bf8d69288fbee4904"

// netTimeout bounds fetch, pull, and push so an unreachable remote cannot hang a request forever.
const netTimeout = 2 * time.Minute

// Without -port, echo takes the first free port in this range, so several repositories can be open at once.
const (
	firstPort = 6030
	lastPort  = 6049
)

// maxUntrackedDiff caps the size of an untracked file rendered as a new-file diff.
const maxUntrackedDiff = 1 << 20

// shutdownGrace is how long a stop waits for in-flight requests before closing the connections
// anyway. It is short because the work echo does is a git call or a read, and a browser tab holds
// an open status stream, so waiting for a perfect drain would mean waiting for the deadline.
const shutdownGrace = 3 * time.Second

type Config struct {
	Vim        bool   `json:"vim"`
	Theme      string `json:"theme"`
	DiffMode   string `json:"diffMode"`
	GutterBase string `json:"gutterBase"`
	// Blame is "line" (show who last changed the caret line) or "off".
	Blame string `json:"blame"`
	// CommitAll makes the Commit button stage everything first (after the page asks).
	CommitAll  bool           `json:"commitAll"`
	Panels     []string       `json:"panels"`
	PanelSizes map[string]int `json:"panelSizes"`
	// LSPDismissed lists language servers whose install prompt was answered "Not now".
	LSPDismissed []string `json:"lspDismissed"`
}

type App struct {
	root  string
	port  int
	hosts map[string]bool
	mu    sync.Mutex
	sigs  map[string]fileSig
	// net serializes network actions; a second fetch/pull/push while one runs is refused, not queued.
	net sync.Mutex
	lsp *lspManager
	// srv is the running server, so the page can ask for a graceful stop. It is nil in tests,
	// which drive routes() over their own listener; stopping then just closes the app.
	srv *http.Server
	// done closes when a shutdown starts, so handlers that wait on their own (the status stream)
	// can return instead of holding the drain open until the deadline.
	done chan struct{}
	// stop keeps a second stop request from starting a second shutdown.
	stop sync.Once
	// running lists the other echo processes. It is a field so a test can name its own servers
	// instead of the real ones on this machine, which a "quit all" would otherwise stop.
	running func() []Instance
}

// Instance is what one echo process reports about itself, so its siblings can list it in the repo switcher.
type Instance struct {
	Root    string `json:"root"`
	Port    int    `json:"port"`
	Branch  string `json:"branch"`
	Changes int    `json:"changes"`
}

type fileSig struct {
	mod    time.Time
	size   int64
	hash   string
	lines  int
	binary bool
}

// logPage is how many commits the Log and History views load per request.
const logPage = 200

// Commit is one log row: the full hash for copying and diffing, the short one for display,
// parents for drawing the graph, and the ref names that point at it (git's %D decoration).
type Commit struct {
	Hash    string   `json:"hash"`
	Short   string   `json:"short"`
	Parents []string `json:"parents"`
	Refs    []string `json:"refs"`
	Author  string   `json:"author"`
	Time    int64    `json:"time"`
	Subject string   `json:"subject"`
}

// CommitDetail is everything the History and Log views show about one commit.
type CommitDetail struct {
	Hash        string   `json:"hash"`
	Parents     []string `json:"parents"`
	Author      string   `json:"author"`
	AuthorEmail string   `json:"authorEmail"`
	AuthorTime  int64    `json:"authorTime"`
	Committer   string   `json:"committer"`
	CommitTime  int64    `json:"commitTime"`
	Subject     string   `json:"subject"`
	Body        string   `json:"body"`
	Files       []Change `json:"files"`
}

// Contains lists the refs a commit is reachable from.
type Contains struct {
	Branches []string `json:"branches"`
	Remotes  []string `json:"remotes"`
	Tags     []string `json:"tags"`
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
	// Index is the staged side (HEAD to index) and Work the unstaged side (index to working tree);
	// each is nil when that side has nothing, so a partly staged file carries both.
	Index *LineStat `json:"index,omitempty"`
	Work  *LineStat `json:"work,omitempty"`
}

type LineStat struct {
	Added   int  `json:"added"`
	Deleted int  `json:"deleted"`
	Binary  bool `json:"binary,omitempty"`
}

// Branch is a local branch with its upstream and how far the two have moved apart since the last fetch.
type Branch struct {
	Name     string `json:"name"`
	Upstream string `json:"upstream,omitempty"`
	Ahead    int    `json:"ahead"`
	Behind   int    `json:"behind"`
	Gone     bool   `json:"gone,omitempty"`
}

type GitStatus struct {
	Build    string   `json:"build"`
	Git      bool     `json:"git"`
	Root     string   `json:"root"`
	Branch   string   `json:"branch"`
	Tracking *Branch  `json:"tracking,omitempty"`
	Local    []Branch `json:"local"`
	// Remote holds remote-tracking branches ("origin/main", without origin/HEAD); Tags holds tag names.
	Remote  []string `json:"remote"`
	Tags    []string `json:"tags"`
	Remotes []string `json:"remotes"`
	// FetchedAt is the Unix time of the last fetch (FETCH_HEAD's mtime), 0 if never.
	FetchedAt int64    `json:"fetchedAt"`
	Changes   []Change `json:"changes"`
	// Head and RefsSig change whenever history or any ref moves, so the browser knows when to reload the log.
	Head    string `json:"head"`
	RefsSig string `json:"refsSig"`
	// Reverting is true while a revert stopped on conflicts and waits for Continue or Abort.
	Reverting bool     `json:"reverting,omitempty"`
	Branches  []string `json:"branches"`
	Stashes   []Stash  `json:"stashes"`
	Error     string   `json:"error,omitempty"`
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
	// Parent is the mainline (1-based) when reverting a merge commit.
	Parent int `json:"parent"`
	// Worktree limits discard to unstaged changes, so staged work survives.
	Worktree bool `json:"worktree"`
}

func main() {
	port := flag.Int("port", 0, fmt.Sprintf("port to listen on (default: this repository's last port, else the first free one in %d-%d)", firstPort, lastPort))
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

	open := func(url string) {
		if !*noOpen {
			_ = openBrowser(url)
		}
	}
	if *port == 0 {
		if p := runningFor(root, instances()); p != 0 {
			url := "http://127.0.0.1:" + strconv.Itoa(p)
			fmt.Printf("echo %s is already open at %s\n", root, url)
			open(url)
			return
		}
	}
	ln, err := listen(root, *port)
	if err != nil {
		fatal(err)
	}
	bound := ln.Addr().(*net.TCPAddr).Port
	if *port == 0 {
		rememberPort(root, bound)
	}

	app := newApp(root, bound)
	url := "http://127.0.0.1:" + strconv.Itoa(bound)
	fmt.Printf("echo %s\n", root)
	fmt.Printf("open %s\n", url)
	open(url)

	// A terminal interrupt asks for the same graceful stop the page's Stop button does: finish what
	// is in flight, let the language servers exit, and only then close the port.
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	srv := &http.Server{Handler: app.routes()}
	app.srv = srv
	go func() {
		<-ctx.Done()
		app.shutdown("signal")
	}()
	if err := srv.Serve(ln); err != nil && !errors.Is(err, http.ErrServerClosed) {
		fatal(err)
	}
}

// listen binds an explicit port exactly. Otherwise it tries the repository's last port, then ports
// no other repository has used, then any port in the range, so each repository tends to keep its
// port and with it the browser storage (reviewed marks) that is scoped to that origin.
func listen(root string, port int) (net.Listener, error) {
	if port != 0 {
		return net.Listen("tcp", "127.0.0.1:"+strconv.Itoa(port))
	}
	for _, p := range portOrder(root, loadPorts()) {
		if ln, err := net.Listen("tcp", "127.0.0.1:"+strconv.Itoa(p)); err == nil {
			return ln, nil
		}
	}
	return nil, fmt.Errorf("ports %d-%d are all in use; pass -port", firstPort, lastPort)
}

func portOrder(root string, known map[string]int) []int {
	claimed := map[int]bool{}
	for r, p := range known {
		if r != root {
			claimed[p] = true
		}
	}
	var own, free, taken []int
	if p := known[root]; p >= firstPort && p <= lastPort {
		own = append(own, p)
	}
	for p := firstPort; p <= lastPort; p++ {
		switch {
		case len(own) > 0 && p == own[0]:
		case claimed[p]:
			taken = append(taken, p)
		default:
			free = append(free, p)
		}
	}
	return append(append(own, free...), taken...)
}

func runningFor(root string, list []Instance) int {
	for _, in := range list {
		if in.Root == root {
			return in.Port
		}
	}
	return 0
}

// instances asks every port in the range whether an echo is serving there. Closed ports refuse
// at once, so the scan costs about one round trip.
func instances() []Instance {
	client := &http.Client{Timeout: 700 * time.Millisecond}
	found := make([]*Instance, lastPort-firstPort+1)
	var wg sync.WaitGroup
	for p := firstPort; p <= lastPort; p++ {
		wg.Add(1)
		go func(p int) {
			defer wg.Done()
			res, err := client.Get("http://127.0.0.1:" + strconv.Itoa(p) + "/api/instance")
			if err != nil {
				return
			}
			defer res.Body.Close()
			var in Instance
			// Anything else listening on the port fails this check and is ignored.
			if res.StatusCode == http.StatusOK && json.NewDecoder(io.LimitReader(res.Body, 1<<16)).Decode(&in) == nil && in.Root != "" && in.Port == p {
				found[p-firstPort] = &in
			}
		}(p)
	}
	wg.Wait()
	out := []Instance{}
	for _, in := range found {
		if in != nil {
			out = append(out, *in)
		}
	}
	return out
}

func newApp(root string, port int) *App {
	p := strconv.Itoa(port)
	app := &App{
		root:  root,
		port:  port,
		sigs:  map[string]fileSig{},
		lsp:   newLSPManager(root),
		hosts: map[string]bool{"127.0.0.1:" + p: true, "localhost:" + p: true},
		done:  make(chan struct{}),
	}
	app.running = func() []Instance { return instances() }
	return app
}

func (a *App) routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/api/tree", a.handleTree)
	mux.HandleFunc("/api/file", a.handleFile)
	mux.HandleFunc("/api/raw", a.handleRaw)
	mux.HandleFunc("/api/lsp/tokens", a.handleLSPTokens)
	mux.HandleFunc("/api/lsp/install", a.handleLSPInstall)
	mux.HandleFunc("/api/lsp/status", a.handleLSPStatus)
	mux.HandleFunc("/api/lsp/restart", a.handleLSPRestart)
	mux.HandleFunc("/api/git/status", a.handleGitStatus)
	mux.HandleFunc("/api/git", a.handleGit)
	mux.HandleFunc("/api/diff", a.handleDiff)
	// Not /api/log: ad and tracker blockers refuse requests to URLs that look like analytics logging.
	mux.HandleFunc("/api/history", a.handleLog)
	mux.HandleFunc("/api/commit", a.handleCommit)
	mux.HandleFunc("/api/blame", a.handleBlame)
	mux.HandleFunc("/api/search", a.handleSearch)
	mux.HandleFunc("/api/commit/contains", a.handleContains)
	mux.HandleFunc("/api/reset/preview", a.handleResetPreview)
	mux.HandleFunc("/api/stream", a.handleStream)
	mux.HandleFunc("/api/config", a.handleConfig)
	mux.HandleFunc("/api/instance", a.handleInstance)
	mux.HandleFunc("/api/instances", a.handleInstances)
	mux.HandleFunc("/api/shutdown", a.handleShutdown)

	assets, err := fs.Sub(webFS, "web")
	if err != nil {
		panic(err)
	}
	files := http.FileServer(http.FS(assets))
	// Embedded files carry no modification time, so tell the browser to revalidate instead of guessing.
	mux.Handle("/", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if f, ok := mermaidAsset(r.URL.Path); ok {
			serveMermaid(w, r, f)
			return
		}
		w.Header().Set("Cache-Control", "no-cache")
		files.ServeHTTP(w, r)
	}))
	return a.guard(mux)
}

// The diagram renderer (vendor/mermaid.zip) ships zipped: mermaid's ESM build is 5.4 MB as
// loose files and 1.6 MB as a zip, and it is served out of the archive rather than unpacked into
// the binary. Only the pages with a mermaid fence ever ask for it.
const mermaidPrefix = "/vendor/mermaid/"

//go:embed vendor/mermaid.zip
var mermaidZip []byte

var mermaidFiles = func() map[string]*zip.File {
	r, err := zip.NewReader(bytes.NewReader(mermaidZip), int64(len(mermaidZip)))
	if err != nil {
		panic(err)
	}
	m := make(map[string]*zip.File, len(r.File))
	for _, f := range r.File {
		m[f.Name] = f
	}
	return m
}()

// mermaidAsset maps a request path to a file in the archive.
func mermaidAsset(urlPath string) (*zip.File, bool) {
	if !strings.HasPrefix(urlPath, mermaidPrefix) {
		return nil, false
	}
	name := strings.TrimPrefix(urlPath, mermaidPrefix)
	if strings.Contains(name, "..") {
		return nil, false
	}
	f, ok := mermaidFiles[name]
	if !ok || f.FileInfo().IsDir() {
		return nil, false
	}
	return f, true
}

func serveMermaid(w http.ResponseWriter, r *http.Request, f *zip.File) {
	rc, err := f.Open()
	if err != nil {
		http.Error(w, "cannot read asset", http.StatusInternalServerError)
		return
	}
	defer rc.Close()
	// A zip entry reads forwards only, so it is unpacked for the one response that asks for it.
	b, err := io.ReadAll(rc)
	if err != nil {
		http.Error(w, "cannot read asset", http.StatusInternalServerError)
		return
	}
	// .mjs is unknown to the mime package, and a module served as octet-stream is refused.
	w.Header().Set("Content-Type", "text/javascript; charset=utf-8")
	w.Header().Set("Cache-Control", "no-cache")
	// The zip carries a modification time, so a reloading browser gets a 304 instead of the file.
	http.ServeContent(w, r, f.Name, f.Modified, bytes.NewReader(b))
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

// tree lists the repository's files. In a Git repository it asks Git, so ignored files
// (build output, local data) stay out and cannot crowd real sources past the browser's cap.
func (a *App) tree() []TreeNode {
	if out, err := a.gitTree(); err == nil {
		return out
	}
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

func (a *App) gitTree() ([]TreeNode, error) {
	list, err := a.git("ls-files", "--cached", "--others", "--exclude-standard", "-z")
	if err != nil {
		return nil, err
	}
	seen := map[string]bool{}
	var out []TreeNode
	for _, rel := range strings.Split(list, "\x00") {
		if rel == "" || seen[rel] || skipPath(rel) {
			continue
		}
		seen[rel] = true
		// Deleted tracked files and submodules are listed by Git but are not files to open.
		if info, err := os.Lstat(filepath.Join(a.root, filepath.FromSlash(rel))); err != nil || info.IsDir() {
			continue
		}
		out = append(out, TreeNode{Name: path.Base(rel), Path: rel})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Path < out[j].Path })
	return out, nil
}

// skipPath applies the walk's rules to a slash path: no skipped directories, no hidden files.
func skipPath(rel string) bool {
	parts := strings.Split(rel, "/")
	for _, dir := range parts[:len(parts)-1] {
		if skipDir(dir) {
			return true
		}
	}
	return strings.HasPrefix(rel, ".")
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

// handleRaw serves a file's bytes, for images in rendered Markdown. The sandbox policy keeps an
// SVG or HTML file from running script with echo's origin.
func (a *App) handleRaw(w http.ResponseWriter, r *http.Request) {
	path, err := a.safePath(r.URL.Query().Get("path"))
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	if info, err := os.Stat(path); err != nil || info.IsDir() {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	w.Header().Set("Content-Security-Policy", "sandbox; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Cache-Control", "no-cache")
	http.ServeFile(w, r, path)
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
	status := GitStatus{Build: build, Git: true, Root: a.root, Changes: []Change{}}
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
	stats, index, work := map[string]Change{}, map[string]Change{}, map[string]Change{}
	if out, err := a.git("diff", "--numstat", "-z", "--no-renames", a.base(), "--"); err == nil {
		stats = parseNumstat(out)
	}
	if out, err := a.git("diff", "--cached", "--numstat", "-z", "--no-renames", "--"); err == nil {
		index = parseNumstat(out)
	}
	if out, err := a.git("diff", "--numstat", "-z", "--no-renames", "--"); err == nil {
		work = parseNumstat(out)
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
		if c.Staged {
			s := index[c.Path]
			c.Index = &LineStat{s.Added, s.Deleted, s.Binary}
		}
		if c.Code == "??" {
			c.Work = &LineStat{c.Added, 0, c.Binary}
		} else if c.Code[1] != ' ' {
			s := work[c.Path]
			c.Work = &LineStat{s.Added, s.Deleted, s.Binary}
		}
	}
	if out, err := a.git("rev-parse", "-q", "--verify", "HEAD"); err == nil {
		status.Head = strings.TrimSpace(out)
	}
	status.Reverting = a.gitPathExists("REVERT_HEAD")
	if out, err := a.git("for-each-ref", "--format=%(objectname) %(refname)"); err == nil {
		status.RefsSig = hashBytes([]byte(out))[:12]
	}
	if out, err := a.git("branch", "-a", "--format=%(refname:short)"); err == nil {
		status.Branches = parseLines(out)
	}
	if out, err := a.git("stash", "list", "--format=%gd%x09%s"); err == nil {
		status.Stashes = parseStashes(out)
	}
	if out, err := a.git("for-each-ref", "--format=%(refname:short)%09%(upstream:short)%09%(upstream:track,nobracket)", "refs/heads"); err == nil {
		status.Local = parseBranches(out)
	}
	for i := range status.Local {
		if status.Local[i].Name == status.Branch {
			status.Tracking = &status.Local[i]
		}
	}
	if out, err := a.git("remote"); err == nil {
		status.Remotes = parseLines(out)
	}
	if out, err := a.git("for-each-ref", "--format=%(refname)", "refs/remotes", "refs/tags"); err == nil {
		c := parseContains(out)
		status.Remote, status.Tags = c.Remotes, c.Tags
	}
	if out, err := a.git("rev-parse", "--git-path", "FETCH_HEAD"); err == nil {
		p := strings.TrimSpace(out)
		if !filepath.IsAbs(p) {
			p = filepath.Join(a.root, p)
		}
		if info, err := os.Stat(p); err == nil {
			status.FetchedAt = info.ModTime().Unix()
		}
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
		out, err = a.discard(req.Paths, req.Worktree)
	} else if req.Action == "commit:all" {
		out, err = a.commitAll(req.Message)
	} else if req.Action == "reset:soft" {
		out, err = a.resetSoft(req.From)
	} else if req.Action == "revert" {
		out, err = a.revert(req.From, req.Parent)
	} else if netActions[req.Action] {
		if !a.net.TryLock() {
			http.Error(w, "another fetch, pull, or push is still running", http.StatusConflict)
			return
		}
		defer a.net.Unlock()
		out, err = a.network(req.Action)
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
	case "rebase", "merge", "branch:create", "branch:switch", "branch:track", "branch:detach", "branch:delete":
		if err := validRef(req.From); err != nil {
			return nil, err
		}
		switch req.Action {
		case "branch:create":
			// To is an optional start point: "New branch from <ref>".
			if req.To == "" {
				return []string{"switch", "-c", req.From}, nil
			}
			if err := validRef(req.To); err != nil {
				return nil, err
			}
			return []string{"switch", "-c", req.From, req.To}, nil
		case "branch:switch":
			return []string{"switch", req.From}, nil
		case "branch:track":
			// Checking out a remote branch creates the local branch that tracks it.
			return []string{"switch", "--track", req.From}, nil
		case "branch:detach":
			return []string{"switch", "--detach", req.From}, nil
		case "branch:delete":
			// -d, not -D: Git refuses to delete a branch whose commits are not merged anywhere.
			return []string{"branch", "-d", req.From}, nil
		}
		return []string{req.Action, req.From}, nil
	case "revert:abort":
		return []string{"revert", "--abort"}, nil
	case "revert:continue":
		// core.editor=true keeps Git from opening an editor for the revert message.
		return []string{"-c", "core.editor=true", "revert", "--continue"}, nil
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

var netActions = map[string]bool{"fetch": true, "pull": true, "push": true, "sync": true, "publish": true}

// network runs the actions that talk to a remote. Pull respects the user's pull.rebase/pull.ff
// config, so a diverged branch with no config stops with Git's own explanation.
func (a *App) network(action string) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), netTimeout)
	defer cancel()
	switch action {
	case "fetch":
		return a.gitNet(ctx, "fetch", "--all", "--prune")
	case "pull":
		return a.gitNet(ctx, "pull")
	case "push":
		return a.gitNet(ctx, "push")
	case "sync":
		out, err := a.gitNet(ctx, "pull")
		if err != nil {
			return out, err
		}
		ahead, err := a.git("rev-list", "--count", "@{upstream}..HEAD")
		if err != nil || strings.TrimSpace(ahead) == "0" {
			return out, err
		}
		pushed, err := a.gitNet(ctx, "push")
		return out + pushed, err
	case "publish":
		branch, err := a.git("branch", "--show-current")
		branch = strings.TrimSpace(branch)
		if err != nil || branch == "" {
			return "", errors.New("publish needs a checked-out branch")
		}
		remotes, _ := a.git("remote")
		remote, err := pickRemote(parseLines(remotes))
		if err != nil {
			return "", err
		}
		return a.gitNet(ctx, "push", "-u", remote, branch)
	}
	return "", fmt.Errorf("unknown git action: %s", action)
}

// pickRemote chooses where a new branch is published: origin, else the only remote.
func pickRemote(remotes []string) (string, error) {
	for _, r := range remotes {
		if r == "origin" {
			return r, nil
		}
	}
	if len(remotes) == 1 {
		return remotes[0], nil
	}
	if len(remotes) == 0 {
		return "", errors.New("this repository has no remote to publish to")
	}
	return "", errors.New("several remotes and none is origin; publish from Terminal with git push -u <remote>")
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

// commitAll stages every change under the root, then commits. It refuses while a conflict is
// unresolved, because staging would mark it resolved with its markers still in the file.
func (a *App) commitAll(message string) (string, error) {
	if strings.TrimSpace(message) == "" {
		return "", errors.New("commit message required")
	}
	unmerged, err := a.git("ls-files", "-u")
	if err != nil {
		return "", err
	}
	if strings.TrimSpace(unmerged) != "" {
		return "", errors.New("resolve the merge conflicts first; staging everything would mark them resolved")
	}
	if out, err := a.gitCombined("add", "-A", "--", "."); err != nil {
		return out, err
	}
	return a.gitCombined("commit", "-m", message)
}

// discard restores tracked paths and deletes untracked ones, so files an agent created can be rejected too.
// discard deletes untracked paths and restores tracked ones. With worktree set it restores the working tree
// from the index only, like a "discard" in an editor's unstaged list; otherwise both index and working tree go back to HEAD.
func (a *App) discard(paths []string, worktree bool) (string, error) {
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
		if worktree {
			return a.gitCombined(append([]string{"restore", "--worktree", "--"}, tracked...)...)
		}
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
		// dots=3 compares from the merge base, like a pull request: only what "to" added since it forked.
		dots := ".."
		if q.Get("dots") == "3" {
			dots = "..."
		}
		args = append(args, from+dots+to)
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
// handleLog pages through history in topological order, so the browser can draw the graph.
// ref is "all" (every branch, remote, and tag), or one ref; q matches the message, or jumps to a
// commit when it is a hash; author and path filter like `git log --author` and `git log -- path`.
func (a *App) handleLog(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	skip, _ := strconv.Atoi(q.Get("skip"))
	limit, err := strconv.Atoi(q.Get("limit"))
	if err != nil || limit <= 0 || limit > 1000 {
		limit = logPage
	}
	empty := map[string]any{"commits": []Commit{}, "more": false}
	if a.base() == emptyTree {
		writeJSON(w, empty)
		return
	}
	args := []string{"log", "--topo-order", logFormat}
	var revs []string
	switch ref := q.Get("ref"); ref {
	case "", "all":
		revs = []string{"--branches", "--remotes", "--tags", "HEAD"}
	default:
		if err := validRef(ref); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		revs = []string{"--end-of-options", ref}
	}
	text := strings.TrimSpace(q.Get("q"))
	author := strings.TrimSpace(q.Get("author"))
	hash := ""
	if isHex(text) {
		hash, _ = a.resolveCommit(text)
	}
	if hash != "" {
		// A hash is a jump, not a search: show exactly that commit.
		revs, skip, limit = []string{hash}, 0, 0
		args = append(args, "--no-walk")
	} else if text != "" {
		args = append(args, "--grep="+text)
	}
	if author != "" {
		args = append(args, "--author="+author)
	}
	if text != "" || author != "" {
		// Filters are typed text, not regexes: "fix(" should match a literal "fix(".
		args = append(args, "--regexp-ignore-case", "--fixed-strings")
	}
	if skip > 0 {
		args = append(args, "--skip="+strconv.Itoa(skip))
	}
	if limit > 0 {
		args = append(args, "-n", strconv.Itoa(limit+1))
	}
	path := q.Get("path")
	if path != "" {
		abs, err := a.safePath(path)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		// A file's history follows it across renames; --follow only works for one file, not a folder.
		if info, err := os.Stat(abs); err != nil || !info.IsDir() {
			args = append(args, "--follow")
		}
	}
	args = append(append(args, revs...), "--")
	if path != "" {
		args = append(args, path)
	}
	out, err := a.git(args...)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	commits := parseCommits(out)
	more := limit > 0 && len(commits) > limit
	if more {
		commits = commits[:limit]
	}
	writeJSON(w, map[string]any{"commits": commits, "more": more})
}

func isHex(s string) bool {
	if len(s) < 4 || len(s) > 40 {
		return false
	}
	for _, c := range s {
		if !strings.ContainsRune("0123456789abcdefABCDEF", c) {
			return false
		}
	}
	return true
}

// BlameCommit is one commit that last touched some lines of a file.
type BlameCommit struct {
	Hash    string `json:"hash"`
	Author  string `json:"author"`
	Time    int64  `json:"time"`
	Summary string `json:"summary"`
}

// Blame maps each line (Lines[i] for line i+1) to an index into Commits.
type Blame struct {
	Commits []BlameCommit `json:"commits"`
	Lines   []int         `json:"lines"`
}

// handleBlame blames the editor's text rather than the file on disk, so unsaved edits line up;
// lines that are not committed come back with Git's all-zero hash.
func (a *App) handleBlame(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "POST required", http.StatusMethodNotAllowed)
		return
	}
	var req struct {
		Path    string `json:"path"`
		Content string `json:"content"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	if _, err := a.safePath(req.Path); err != nil || req.Path == "" {
		http.Error(w, "invalid path", http.StatusBadRequest)
		return
	}
	cmd := a.gitCmd("blame", "--porcelain", "--contents", "-", "--", req.Path)
	cmd.Stdin = strings.NewReader(req.Content)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	out, err := cmd.Output()
	if err != nil {
		// Files Git does not track have no blame; that is not an error worth showing.
		writeJSON(w, Blame{Commits: []BlameCommit{}, Lines: []int{}})
		return
	}
	writeJSON(w, parseBlame(string(out)))
}

// Match is one line found by content search.
type Match struct {
	Path string `json:"path"`
	Line int    `json:"line"`
	Text string `json:"text"`
}

type SearchResult struct {
	Matches   []Match `json:"matches"`
	Truncated bool    `json:"truncated"`
}

// ponytail: hard cap and no paging; a query that hits it should be narrowed, not scrolled.
const searchCap = 2000

// handleSearch greps file contents: tracked and untracked files in a repository, the plain folder
// otherwise, never ignored or binary files. The request context kills git when the browser aborts
// a search that the next keystroke replaced.
func (a *App) handleSearch(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	res := SearchResult{Matches: []Match{}}
	if q.Get("q") == "" {
		writeJSON(w, res)
		return
	}
	args := []string{"grep", "-n", "--column", "-I", "-z", "--no-color"}
	if _, err := a.git("rev-parse", "--is-inside-work-tree"); err == nil {
		args = append(args, "--untracked")
	} else {
		args = append(args, "--no-index", "--exclude-standard")
	}
	if q.Get("case") != "1" {
		args = append(args, "-i")
	}
	if q.Get("word") == "1" {
		args = append(args, "-w")
	}
	if q.Get("regex") == "1" {
		args = append(args, "-E")
	} else {
		args = append(args, "-F")
	}
	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()
	cmd := a.gitCmdContext(ctx, append(args, "-e", q.Get("q"))...)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	stdout, err := cmd.StdoutPipe()
	if err == nil {
		err = cmd.Start()
	}
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	sc := bufio.NewScanner(stdout)
	sc.Buffer(make([]byte, 64*1024), 16<<20)
	// With -z each line is "path\0line\0column\0text".
	for sc.Scan() {
		if len(res.Matches) == searchCap {
			res.Truncated = true
			break
		}
		parts := strings.SplitN(sc.Text(), "\x00", 4)
		if len(parts) < 4 {
			continue
		}
		line, _ := strconv.Atoi(parts[1])
		col, _ := strconv.Atoi(parts[2])
		res.Matches = append(res.Matches, Match{Path: filepath.ToSlash(parts[0]), Line: line, Text: snippet(strings.TrimRight(parts[3], "\r"), col-1)})
	}
	if sc.Err() != nil {
		res.Truncated = true // a line past the scanner's 16 MB limit; keep what was found
	}
	if res.Truncated {
		cancel() // stop git early; cancelling after it finished would turn a clean exit into an error
	}
	err = cmd.Wait()
	var exit *exec.ExitError
	// Exit 1 means no matches; a kill after the cap is expected. Anything else (a bad regex) is the user's to fix.
	if err != nil && !res.Truncated && !(errors.As(err, &exit) && exit.ExitCode() == 1) && r.Context().Err() == nil {
		msg := strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(stderr.String()), "fatal: "))
		if msg == "" {
			msg = err.Error()
		}
		http.Error(w, msg, http.StatusBadRequest)
		return
	}
	writeJSON(w, res)
}

// snippet trims a long line to about 200 bytes around the match, cut on rune boundaries.
func snippet(s string, at int) string {
	const width = 200
	if len(s) <= width {
		return s
	}
	start := max(0, min(at-60, len(s)-width))
	end := start + width
	for start > 0 && !utf8.RuneStart(s[start]) {
		start--
	}
	for end < len(s) && !utf8.RuneStart(s[end]) {
		end++
	}
	out := s[start:end]
	if start > 0 {
		out = "…" + out
	}
	if end < len(s) {
		out += "…"
	}
	return out
}

// parseBlame reads `git blame --porcelain`: a "<hash> <orig> <final> [<count>]" header per line,
// commit fields (author, author-time, summary) the first time a hash appears, then "\t<text>".
func parseBlame(s string) Blame {
	b := Blame{Commits: []BlameCommit{}, Lines: []int{}}
	index := map[string]int{}
	cur, final := -1, 0
	for _, line := range strings.Split(s, "\n") {
		if strings.HasPrefix(line, "\t") {
			for len(b.Lines) < final {
				b.Lines = append(b.Lines, -1)
			}
			if cur >= 0 && final > 0 {
				b.Lines[final-1] = cur
			}
			continue
		}
		f := strings.Fields(line)
		if len(f) >= 3 && len(f[0]) == 40 && isHex(f[0][:8]) {
			if _, err := strconv.Atoi(f[2]); err == nil {
				i, ok := index[f[0]]
				if !ok {
					i = len(b.Commits)
					index[f[0]] = i
					b.Commits = append(b.Commits, BlameCommit{Hash: f[0]})
				}
				cur = i
				final, _ = strconv.Atoi(f[2])
				continue
			}
		}
		if cur < 0 {
			continue
		}
		c := &b.Commits[cur]
		if v, ok := strings.CutPrefix(line, "author "); ok {
			c.Author = v
		} else if v, ok := strings.CutPrefix(line, "author-time "); ok {
			c.Time, _ = strconv.ParseInt(v, 10, 64)
		} else if v, ok := strings.CutPrefix(line, "summary "); ok {
			c.Summary = v
		}
	}
	return b
}

// resolveCommit turns a user-supplied ref into a full commit hash, so later commands never see the raw input.
func (a *App) resolveCommit(ref string) (string, error) {
	if err := validRef(ref); err != nil {
		return "", err
	}
	out, err := a.git("rev-parse", "--verify", "--quiet", "--end-of-options", ref+"^{commit}")
	if err != nil || strings.TrimSpace(out) == "" {
		return "", fmt.Errorf("no commit %q", ref)
	}
	return strings.TrimSpace(out), nil
}

// handleCommit returns a commit's message and its files. Files follow the commit diff view:
// merges are compared with their first parent.
func (a *App) handleCommit(w http.ResponseWriter, r *http.Request) {
	hash, err := a.resolveCommit(r.URL.Query().Get("hash"))
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	out, err := a.git("show", "-s", "--format=%H%x00%P%x00%aN%x00%aE%x00%at%x00%cN%x00%ct%x00%B", hash)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	d, ok := parseCommitDetail(out)
	if !ok {
		http.Error(w, "unexpected git show output", http.StatusBadGateway)
		return
	}
	diff := []string{"show", "--format=", "--no-renames", "--diff-merges=first-parent", "-z"}
	codes, err := a.git(append(diff, "--name-status", hash)...)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	stats := map[string]Change{}
	if out, err := a.git(append(diff, "--numstat", hash)...); err == nil {
		stats = parseNumstat(out)
	}
	d.Files = parseNameStatus(codes)
	for i := range d.Files {
		s := stats[d.Files[i].Path]
		d.Files[i].Added, d.Files[i].Deleted, d.Files[i].Binary = s.Added, s.Deleted, s.Binary
	}
	writeJSON(w, d)
}

// gitPathExists reports whether a file or directory exists inside the repository's git dir.
func (a *App) gitPathExists(name string) bool {
	out, err := a.git("rev-parse", "--git-path", name)
	if err != nil {
		return false
	}
	p := strings.TrimSpace(out)
	if !filepath.IsAbs(p) {
		p = filepath.Join(a.root, p)
	}
	_, err = os.Stat(p)
	return err == nil
}

// operationInProgress names a merge, revert, cherry-pick, or rebase that has not finished.
func (a *App) operationInProgress() string {
	for _, o := range [][2]string{{"MERGE_HEAD", "merge"}, {"REVERT_HEAD", "revert"}, {"CHERRY_PICK_HEAD", "cherry-pick"}, {"rebase-merge", "rebase"}, {"rebase-apply", "rebase"}} {
		if a.gitPathExists(o[0]) {
			return o[1]
		}
	}
	return ""
}

// ResetPreview says what a soft reset to a commit would undo, or why it cannot run.
type ResetPreview struct {
	Branch string   `json:"branch"`
	Target string   `json:"target"`
	Count  int      `json:"count"`
	Pushed int      `json:"pushed"`
	Undone []string `json:"undone"`
}

// resetPreview validates a soft reset target. The target must be a strict ancestor of HEAD on a
// checked-out branch, with no other operation half done; anything else is not a "back up" and is refused.
func (a *App) resetPreview(ref string) (ResetPreview, error) {
	var p ResetPreview
	target, err := a.resolveCommit(ref)
	if err != nil {
		return p, err
	}
	if op := a.operationInProgress(); op != "" {
		return p, fmt.Errorf("finish or abort the %s in progress first", op)
	}
	out, _ := a.git("branch", "--show-current")
	if p.Branch = strings.TrimSpace(out); p.Branch == "" {
		return p, errors.New("HEAD is detached; switch to a branch before resetting")
	}
	head, err := a.git("rev-parse", "HEAD")
	if err != nil {
		return p, err
	}
	if strings.TrimSpace(head) == target {
		return p, errors.New("the branch is already at this commit")
	}
	if _, err := a.git("merge-base", "--is-ancestor", target, "HEAD"); err != nil {
		return p, errors.New("this commit is not in the history of the current branch")
	}
	p.Target = target
	log, err := a.git("log", "--format=%h %s", "--max-count=10", target+"..HEAD")
	if err != nil {
		return p, err
	}
	p.Undone = parseLines(log)
	count, _ := a.git("rev-list", "--count", target+"..HEAD")
	p.Count, _ = strconv.Atoi(strings.TrimSpace(count))
	// Commits already on the upstream need a force push after the reset.
	if unpushed, err := a.git("rev-list", "--count", target+"..HEAD", "^@{upstream}"); err == nil {
		n, _ := strconv.Atoi(strings.TrimSpace(unpushed))
		p.Pushed = p.Count - n
	}
	return p, nil
}

func (a *App) handleResetPreview(w http.ResponseWriter, r *http.Request) {
	p, err := a.resetPreview(r.URL.Query().Get("hash"))
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	writeJSON(w, p)
}

// resetSoft moves the branch back to an earlier commit and keeps every change staged.
func (a *App) resetSoft(ref string) (string, error) {
	p, err := a.resetPreview(ref)
	if err != nil {
		return "", err
	}
	old, _ := a.git("rev-parse", "--short", "HEAD")
	if out, err := a.gitCombined("reset", "--soft", p.Target); err != nil {
		return out, err
	}
	s := "s"
	if p.Count == 1 {
		s = ""
	}
	return fmt.Sprintf("Moved %s back %d commit%s (was %s); the changes are staged", p.Branch, p.Count, s, strings.TrimSpace(old)), nil
}

// revert adds a commit that undoes another. A merge commit needs its mainline parent, since Git
// cannot know which side to keep.
func (a *App) revert(ref string, parent int) (string, error) {
	hash, err := a.resolveCommit(ref)
	if err != nil {
		return "", err
	}
	out, err := a.git("rev-list", "--parents", "-n", "1", hash)
	if err != nil {
		return "", err
	}
	parents := len(strings.Fields(out)) - 1
	args := []string{"revert", "--no-edit"}
	if parents > 1 {
		if parent < 1 || parent > parents {
			return "", fmt.Errorf("this is a merge commit; choose a mainline parent from 1 to %d", parents)
		}
		args = append(args, "-m", strconv.Itoa(parent))
	} else if parent > 1 {
		return "", errors.New("only merge commits have a mainline parent")
	}
	return a.gitCombined(append(args, hash)...)
}

// handleContains is separate from handleCommit because --contains walks history and can be slow.
func (a *App) handleContains(w http.ResponseWriter, r *http.Request) {
	hash, err := a.resolveCommit(r.URL.Query().Get("hash"))
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	out, err := a.git("for-each-ref", "--contains", hash, "--format=%(refname)", "refs/heads", "refs/remotes", "refs/tags")
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	writeJSON(w, parseContains(out))
}

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
		case <-a.done:
			return
		case <-ticker.C:
			send()
		}
	}
}

// handleConfig reads the config from disk and applies a POST as a patch onto the file, so echo
// processes for different repositories, which share one config file, do not undo each other's settings.
func (a *App) handleConfig(w http.ResponseWriter, r *http.Request) {
	// The lock serializes this process's read-modify-write of the file.
	a.mu.Lock()
	defer a.mu.Unlock()
	cfg := loadConfig()
	if r.Method != http.MethodGet {
		if err := json.NewDecoder(r.Body).Decode(&cfg); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		if err := saveConfig(cfg); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
	}
	writeJSON(w, cfg)
}

func (a *App) handleInstance(w http.ResponseWriter, r *http.Request) {
	in := Instance{Root: a.root, Port: a.port}
	if out, err := a.git("branch", "--show-current"); err == nil {
		in.Branch = strings.TrimSpace(out)
	}
	if out, err := a.git("status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all"); err == nil {
		in.Changes = len(parsePorcelain(out))
	}
	writeJSON(w, in)
}

// handleInstances lists the running echo processes. The server asks its siblings, so the page
// never makes a cross-origin request and the Host/Origin guard stays strict.
func (a *App) handleInstances(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, instances())
}

// handleShutdown stops this process, or one other process when the page names its port. Stopping a
// sibling is the same request this process makes of itself, so the page never needs a
// cross-origin call and the Host/Origin guard still admits only echo's own pages.
func (a *App) handleShutdown(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "POST only", http.StatusMethodNotAllowed)
		return
	}
	var req struct {
		// Port is the echo process to stop; 0 means this one.
		Port int `json:"port"`
		// All asks for every running process to stop, this one included.
		All bool `json:"all"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	if req.All {
		// Ask the siblings first and this one last, so the list the page is looking at is still there.
		for _, in := range a.running() {
			if in.Port != a.port {
				stopInstance(in.Port)
			}
		}
		go a.shutdown("page")
		writeJSON(w, map[string]bool{"ok": true})
		return
	}
	if req.Port == 0 || req.Port == a.port {
		go a.shutdown("page")
		writeJSON(w, map[string]bool{"ok": true})
		return
	}
	if req.Port < firstPort || req.Port > lastPort {
		http.Error(w, "port is outside the range echo uses", http.StatusBadRequest)
		return
	}
	if !stopInstance(req.Port) {
		http.Error(w, "no echo is running on that port", http.StatusNotFound)
		return
	}
	writeJSON(w, map[string]bool{"ok": true})
}

// stopInstance asks the echo on a port to stop, and reports whether one was there to answer.
func stopInstance(port int) bool {
	// Its own transport, without pooled connections. A pooled one would be a keep-alive connection
	// to a process that has since exited, and Go does not retry a POST, so the stop would be sent
	// into a closed socket and the sibling would keep running.
	client := &http.Client{Transport: &http.Transport{DisableKeepAlives: true}, Timeout: 2 * time.Second}
	req, err := http.NewRequest(http.MethodPost, "http://127.0.0.1:"+strconv.Itoa(port)+"/api/shutdown", strings.NewReader("{}"))
	if err != nil {
		return false
	}
	req.Header.Set("Content-Type", "application/json")
	res, err := client.Do(req)
	if err != nil {
		return false
	}
	defer res.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(res.Body, 1<<16))
	return res.StatusCode == http.StatusOK
}

// shutdown asks the server to stop, once. It ends the status stream first, because that handler
// waits for a tick and would otherwise hold the drain open; then it gives in-flight requests the
// grace period, and closes what is left. The language servers are stopped either way, so a
// Ctrl-C does not leave gopls and friends behind.
func (a *App) shutdown(why string) {
	a.stop.Do(func() {
		if a.done != nil {
			close(a.done)
		}
		a.lsp.stopAll()
		if a.srv == nil {
			return
		}
		fmt.Printf("echo %s is stopping (%s)\n", a.root, why)
		ctx, cancel := context.WithTimeout(context.Background(), shutdownGrace)
		defer cancel()
		if err := a.srv.Shutdown(ctx); err != nil {
			_ = a.srv.Close()
		}
	})
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
	return a.gitCmdContext(context.Background(), args...)
}

func (a *App) gitCmdContext(ctx context.Context, args ...string) *exec.Cmd {
	cmd := exec.CommandContext(ctx, "git", append([]string{"--no-optional-locks", "-c", "core.quotePath=false"}, args...)...)
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

// gitNet is gitCombined with a deadline, for commands that wait on a remote.
func (a *App) gitNet(ctx context.Context, args ...string) (string, error) {
	out, err := a.gitCmdContext(ctx, args...).CombinedOutput()
	if ctx.Err() == context.DeadlineExceeded {
		err = fmt.Errorf("git %s timed out after %s", args[0], netTimeout)
	}
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

// logFormat separates fields with the ASCII unit separator and records with the record separator,
// so subjects and ref names can hold tabs or newlines-free text without ambiguity.
const logFormat = "--format=%H%x1f%h%x1f%P%x1f%D%x1f%aN%x1f%at%x1f%s%x1e"

// parseCommits reads logFormat records: hash, short, parents, refs, author, unix time, subject.
func parseCommits(s string) []Commit {
	out := []Commit{}
	for _, rec := range strings.Split(s, "\x1e") {
		parts := strings.SplitN(strings.TrimLeft(rec, "\n"), "\x1f", 7)
		if len(parts) != 7 {
			continue
		}
		c := Commit{Hash: parts[0], Short: parts[1], Parents: strings.Fields(parts[2]), Refs: []string{}, Author: parts[4], Subject: parts[6]}
		if parts[3] != "" {
			c.Refs = strings.Split(parts[3], ", ")
		}
		c.Time, _ = strconv.ParseInt(parts[5], 10, 64)
		out = append(out, c)
	}
	return out
}

// parseBranches reads "name\tupstream\ttrack" lines, where track is "ahead 1, behind 2", "gone", or empty.
func parseBranches(s string) []Branch {
	out := []Branch{}
	for _, line := range strings.Split(s, "\n") {
		parts := strings.SplitN(line, "\t", 3)
		if len(parts) != 3 || parts[0] == "" {
			continue
		}
		b := Branch{Name: parts[0], Upstream: parts[1], Gone: parts[2] == "gone"}
		for _, f := range strings.Split(parts[2], ", ") {
			if n, ok := strings.CutPrefix(f, "ahead "); ok {
				b.Ahead, _ = strconv.Atoi(n)
			} else if n, ok := strings.CutPrefix(f, "behind "); ok {
				b.Behind, _ = strconv.Atoi(n)
			}
		}
		out = append(out, b)
	}
	return out
}

// parseCommitDetail reads NUL-separated hash, parents, author, email, time, committer, time, message.
func parseCommitDetail(s string) (CommitDetail, bool) {
	parts := strings.SplitN(s, "\x00", 8)
	if len(parts) != 8 {
		return CommitDetail{}, false
	}
	d := CommitDetail{Hash: parts[0], Parents: strings.Fields(parts[1]), Author: parts[2], AuthorEmail: parts[3], Committer: parts[5], Files: []Change{}}
	d.AuthorTime, _ = strconv.ParseInt(parts[4], 10, 64)
	d.CommitTime, _ = strconv.ParseInt(parts[6], 10, 64)
	msg := strings.TrimRight(parts[7], "\n")
	d.Subject, d.Body, _ = strings.Cut(msg, "\n")
	d.Body = strings.Trim(d.Body, "\n")
	return d, true
}

// parseNameStatus reads `--name-status -z` output: a status letter, then the path, each NUL-terminated.
func parseNameStatus(s string) []Change {
	out := []Change{}
	f := strings.Split(strings.TrimLeft(s, "\x00\n"), "\x00")
	for i := 0; i+1 < len(f); i += 2 {
		if f[i] != "" {
			out = append(out, Change{Code: f[i][:1], Path: f[i+1]})
		}
	}
	return out
}

// parseContains sorts full ref names into local branches, remote branches, and tags. Remote HEAD
// aliases (origin/HEAD) are skipped because they duplicate the branch they point to.
func parseContains(s string) Contains {
	c := Contains{Branches: []string{}, Remotes: []string{}, Tags: []string{}}
	for _, ref := range parseLines(s) {
		if name, ok := strings.CutPrefix(ref, "refs/heads/"); ok {
			c.Branches = append(c.Branches, name)
		} else if name, ok := strings.CutPrefix(ref, "refs/remotes/"); ok && !strings.HasSuffix(name, "/HEAD") {
			c.Remotes = append(c.Remotes, name)
		} else if name, ok := strings.CutPrefix(ref, "refs/tags/"); ok {
			c.Tags = append(c.Tags, name)
		}
	}
	return c
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
	cfg := Config{DiffMode: "unified", GutterBase: "head", Blame: "line", Panels: []string{"tree", "editor", "git"}, PanelSizes: map[string]int{}}
	data, err := os.ReadFile(configPath())
	if err == nil {
		_ = json.Unmarshal(data, &cfg)
	}
	return cfg
}

func saveConfig(cfg Config) error {
	data, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return err
	}
	return writeAtomic(configPath(), data)
}

// writeAtomic replaces a file in one rename, so another echo process never reads a half-written one.
func writeAtomic(name string, data []byte) error {
	if err := os.MkdirAll(filepath.Dir(name), 0o755); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(name), filepath.Base(name)+".*")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), name)
}

// ports.json maps repository roots to the port each last used; it lives beside config.json.
func portsPath() string {
	return filepath.Join(filepath.Dir(configPath()), "ports.json")
}

func loadPorts() map[string]int {
	ports := map[string]int{}
	if data, err := os.ReadFile(portsPath()); err == nil {
		_ = json.Unmarshal(data, &ports)
	}
	return ports
}

// rememberPort records root's port and forgets any other repository that had it, which keeps
// the file to at most one entry per port in the range.
func rememberPort(root string, port int) {
	ports := loadPorts()
	for r, p := range ports {
		if p == port || p < firstPort || p > lastPort {
			delete(ports, r)
		}
	}
	ports[root] = port
	if data, err := json.MarshalIndent(ports, "", "  "); err == nil {
		_ = writeAtomic(portsPath(), data)
	}
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
