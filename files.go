package main

import (
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"mime"
	"net/http"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

// maxFileRead caps what the editor loads; larger files are left on disk.
const maxFileRead = 10 << 20

// maxUntrackedDiff caps the size of an untracked file rendered as a new-file diff.
const maxUntrackedDiff = 1 << 20

type fileSig struct {
	mod    time.Time
	size   int64
	hash   string
	lines  int
	binary bool
}

type TreeNode struct {
	Name     string     `json:"name"`
	Path     string     `json:"path"`
	Dir      bool       `json:"dir"`
	Ignored  bool       `json:"ignored,omitempty"`
	Children []TreeNode `json:"children,omitempty"`
}

// maxTreeDirs bounds the walk that looks for empty folders; maxDirEntries bounds one folder listing.
const (
	maxTreeDirs   = 100000
	maxDirEntries = 5000
)

// handleTree lists the whole tree, or with ?dir= the entries of one folder (how an ignored folder opens).
func (a *App) handleTree(w http.ResponseWriter, r *http.Request) {
	if dir := strings.Trim(r.URL.Query().Get("dir"), "/"); dir != "" {
		kids, err := a.listDir(dir)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		writeJSON(w, kids)
		return
	}
	writeJSON(w, a.tree())
}

// tree lists the repository's files, plus the folders a file list cannot show: empty ones, and
// ignored ones (build output, dependencies), which are listed but not descended. Ignored top-level
// files come with ignored set. Dotfiles are files like any other; only .git is left out.
func (a *App) tree() []TreeNode {
	if !a.noGit {
		if out, err := a.gitTree(); err == nil {
			return out
		}
	}
	var out []TreeNode
	_ = filepath.WalkDir(a.root, func(p string, d fs.DirEntry, err error) error {
		if err != nil || p == a.root {
			return nil
		}
		rel, _ := filepath.Rel(a.root, p)
		rel = filepath.ToSlash(rel)
		if d.Name() == ".git" || d.Type()&fs.ModeSymlink != 0 && d.IsDir() {
			return filepath.SkipDir
		}
		if d.IsDir() {
			if a.skipRel != nil && a.skipRel(rel) {
				return filepath.SkipDir
			}
			if skipDir(d.Name()) {
				out = append(out, TreeNode{Name: d.Name(), Path: rel, Dir: true, Ignored: true})
				return filepath.SkipDir
			}
			if empty, _ := isEmptyDir(p); empty {
				out = append(out, TreeNode{Name: d.Name(), Path: rel, Dir: true})
			}
			return nil
		}
		out = append(out, TreeNode{Name: d.Name(), Path: rel})
		return nil
	})
	sort.Slice(out, func(i, j int) bool { return out[i].Path < out[j].Path })
	return out
}

func isEmptyDir(p string) (bool, error) {
	ents, err := os.ReadDir(p)
	return len(ents) == 0, err
}

func (a *App) gitTree() ([]TreeNode, error) {
	// The ignored listing does not depend on the file listing, so Git runs both at once.
	var ign string
	var ignErr error
	ignDone := make(chan struct{})
	go func() {
		defer close(ignDone)
		ign, ignErr = a.git("ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z")
	}()
	list, err := a.git("ls-files", "--cached", "--others", "--exclude-standard", "-z")
	if err != nil {
		<-ignDone
		return nil, err
	}
	seen := map[string]bool{}
	has := map[string]bool{} // folders that hold a file, so they are not "empty"
	var out []TreeNode
	mark := func(rel string) {
		for d := path.Dir(rel); d != "." && !has[d]; d = path.Dir(d) {
			has[d] = true
		}
	}
	for _, rel := range strings.Split(list, "\x00") {
		if rel == "" || seen[rel] || inGitDir(rel) {
			continue
		}
		seen[rel] = true
		// Deleted tracked files and submodules are listed by Git but are not files to open.
		if info, err := os.Lstat(filepath.Join(a.root, filepath.FromSlash(rel))); err != nil || info.IsDir() {
			continue
		}
		out = append(out, TreeNode{Name: path.Base(rel), Path: rel})
		mark(rel)
	}
	// Ignored entries: --directory collapses a wholly ignored folder to one "dir/" line.
	ignored := map[string]bool{}
	<-ignDone
	if ignErr == nil {
		for _, rel := range strings.Split(ign, "\x00") {
			isDir := strings.HasSuffix(rel, "/")
			rel = strings.TrimSuffix(rel, "/")
			if rel == "" || inGitDir(rel) || seen[rel] {
				continue
			}
			seen[rel] = true
			ignored[rel] = true
			out = append(out, TreeNode{Name: path.Base(rel), Path: rel, Dir: isDir, Ignored: true})
			mark(rel)
		}
	}
	// Empty folders: Git does not track them, so look on disk, never entering an ignored folder.
	dirs := 0
	var walk func(rel string)
	walk = func(rel string) {
		ents, err := os.ReadDir(filepath.Join(a.root, filepath.FromSlash(rel)))
		if err != nil {
			return
		}
		for _, e := range ents {
			if !e.IsDir() || e.Type()&fs.ModeSymlink != 0 || e.Name() == ".git" || dirs >= maxTreeDirs {
				continue
			}
			sub := path.Join(rel, e.Name())
			if ignored[sub] || a.skipRel != nil && a.skipRel(sub) {
				continue
			}
			dirs++
			walk(sub)
		}
		if rel != "" && !has[rel] && len(ents) == 0 {
			out = append(out, TreeNode{Name: path.Base(rel), Path: rel, Dir: true})
		}
	}
	walk("")
	sort.Slice(out, func(i, j int) bool { return out[i].Path < out[j].Path })
	return out, nil
}

// listDir lists one folder's entries as ignored nodes: the folder is only asked for when it is
// ignored (or skipped), since the main tree already holds everything else.
func (a *App) listDir(rel string) ([]TreeNode, error) {
	if inGitDir(rel) {
		return nil, errors.New("the .git directory cannot be listed")
	}
	p, err := a.safeContent(rel)
	if err != nil {
		return nil, err
	}
	ents, err := os.ReadDir(p)
	if err != nil {
		return nil, err
	}
	out := []TreeNode{}
	for _, e := range ents {
		if e.Name() == ".git" || e.IsDir() && e.Type()&fs.ModeSymlink != 0 {
			continue
		}
		if len(out) >= maxDirEntries {
			break
		}
		out = append(out, TreeNode{Name: e.Name(), Path: path.Join(rel, e.Name()), Dir: e.IsDir(), Ignored: true})
	}
	return out, nil
}

func skipDir(name string) bool {
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
	path, err := a.safeContent(rel)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	if inGitDir(rel) {
		http.Error(w, "the .git directory cannot be read from the page", http.StatusBadRequest)
		return
	}
	if rev := r.URL.Query().Get("rev"); rev != "" {
		a.handleFileRev(w, rel, rev)
		return
	}
	// A file past the cap is not loaded: the page shows a notice and offers the raw bytes, and
	// a save of the (empty) content it never received cannot happen.
	if info, err := os.Stat(path); err == nil && info.Size() > maxFileRead {
		writeJSON(w, map[string]any{"path": filepath.ToSlash(rel), "content": "", "hash": "", "binary": false, "tooLarge": true, "size": info.Size()})
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
	rel := r.URL.Query().Get("path")
	path, err := a.safeContent(rel)
	if err != nil || inGitDir(rel) {
		http.Error(w, "path not allowed", http.StatusBadRequest)
		return
	}
	if rev := r.URL.Query().Get("rev"); rev != "" {
		a.rawAtRev(w, rel, rev)
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
// The base, ours and theirs revisions read the unmerged index stages (:1:, :2:, :3:),
// so the editor can show each side of a conflict without another endpoint.
func (a *App) handleFileRev(w http.ResponseWriter, rel, rev string) {
	var object string
	switch rev {
	case "head":
		object = "HEAD:./" + filepath.ToSlash(rel)
	case "index":
		object = ":./" + filepath.ToSlash(rel)
	case "base":
		object = ":1:./" + filepath.ToSlash(rel)
	case "ours":
		object = ":2:./" + filepath.ToSlash(rel)
	case "theirs":
		object = ":3:./" + filepath.ToSlash(rel)
	default:
		hash, err := a.resolveCommit(rev)
		if err != nil {
			http.Error(w, "unknown rev", http.StatusBadRequest)
			return
		}
		object = hash + ":./" + filepath.ToSlash(rel)
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
		Action  string `json:"action"`
		Path    string `json:"path"`
		NewPath string `json:"newPath"`
		Content string `json:"content"`
		// BaseHash means "only save if the file is still what I opened"; Force is the explicit
		// "save over whatever is there" the page sends after a conflict.
		BaseHash string `json:"baseHash"`
		Force    bool   `json:"force"`
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
	// Writing into .git would let a page plant a hook or config that Git then runs.
	if inGitDir(req.Path) || inGitDir(req.NewPath) {
		http.Error(w, "the .git directory cannot be changed from the page", http.StatusBadRequest)
		return
	}
	switch req.Action {
	case "", "save":
		if path, err = a.safeContent(req.Path); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		// One save at a time per process, so the check below and the write are not split by another save.
		a.writeMu.Lock()
		defer a.writeMu.Unlock()
		current, err := os.ReadFile(path)
		switch {
		case err == nil && !req.Force && req.BaseHash == "":
			http.Error(w, "file exists; save needs the hash it was opened with", http.StatusConflict)
			return
		case err == nil && !req.Force && hashBytes(current) != req.BaseHash:
			http.Error(w, "file changed on disk since it was opened", http.StatusConflict)
			return
		case errors.Is(err, fs.ErrNotExist) && req.BaseHash != "" && !req.Force:
			http.Error(w, "file was deleted on disk since it was opened", http.StatusConflict)
			return
		}
		if err := writeFileAtomic(path, []byte(req.Content)); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		writeJSON(w, map[string]any{"ok": true, "hash": hashBytes([]byte(req.Content))})
		return
	case "create":
		if req.NewPath == "" {
			req.NewPath = req.Path
		}
		path, err = a.safeContent(req.NewPath)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		// O_EXCL: "New file" never replaces a file that is already there.
		f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o644)
		if errors.Is(err, fs.ErrExist) {
			http.Error(w, "a file already exists at that path", http.StatusConflict)
			return
		}
		if err == nil {
			_, err = f.WriteString(req.Content)
			if cerr := f.Close(); err == nil {
				err = cerr
			}
		}
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
	case "mkdir":
		if err := os.MkdirAll(path, 0o755); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
	case "delete":
		if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
	case "delete:dir":
		if req.Path == "" || filepath.Clean(path) == filepath.Clean(a.root) {
			http.Error(w, "refusing to delete the repository root", http.StatusBadRequest)
			return
		}
		info, err := os.Lstat(path)
		if err != nil || !info.IsDir() {
			http.Error(w, "not a folder", http.StatusBadRequest)
			return
		}
		if err := os.RemoveAll(path); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
	case "rename", "duplicate":
		if req.NewPath == "" {
			http.Error(w, "newPath required", http.StatusBadRequest)
			return
		}
		newPath, err := a.safePath(req.NewPath)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		// A rename or copy never replaces what is already at the destination.
		if _, err := os.Lstat(newPath); err == nil {
			http.Error(w, "something already exists at "+req.NewPath, http.StatusConflict)
			return
		}
		if err := os.MkdirAll(filepath.Dir(newPath), 0o755); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		if req.Action == "duplicate" {
			src, err := a.safeContent(req.Path)
			if err != nil {
				http.Error(w, err.Error(), http.StatusBadRequest)
				return
			}
			if err := copyFile(src, newPath); err != nil {
				http.Error(w, err.Error(), http.StatusInternalServerError)
				return
			}
			break
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

// writeFileAtomic replaces a file in one rename, so an agent or a crash never sees a half-written
// file. The existing file's permission bits are kept.
func writeFileAtomic(path string, data []byte) error {
	mode := os.FileMode(0o644)
	if info, err := os.Stat(path); err == nil {
		mode = info.Mode().Perm()
	}
	tmp, err := os.CreateTemp(filepath.Dir(path), ".echo-save-*")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Chmod(mode); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), path)
}

// copyFile copies a regular file without replacing anything; the caller checked the destination.
func copyFile(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	info, err := in.Stat()
	if err != nil || info.IsDir() {
		return errors.New("only files can be duplicated")
	}
	out, err := os.OpenFile(dst, os.O_WRONLY|os.O_CREATE|os.O_EXCL, info.Mode().Perm())
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		return err
	}
	return out.Close()
}

// sig returns a workspace file's content hash, re-reading it only when size or mtime change.
func (a *App) sig(rel string) (fileSig, bool) {
	// The file is read, so a symlink at the end must also stay inside the repository.
	path, err := a.safeContent(rel)
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

// safePath maps a repository-relative path to disk. It refuses absolute paths, "..", and any path
// whose parent directory is a symlink leading out of the repository. The last element may itself
// be a symlink: Git and delete/rename act on the link, not its target. To read or write through a
// path, use safeContent.
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
	if err := a.withinRoot(filepath.Dir(clean)); err != nil {
		return "", err
	}
	return clean, nil
}

// safeContent is safePath for code that opens the file, so a symlink at the last element is
// followed and must also stay inside the repository.
func (a *App) safeContent(rel string) (string, error) {
	p, err := a.safePath(rel)
	if err != nil {
		return "", err
	}
	if err := a.withinRoot(p); err != nil {
		return "", err
	}
	return p, nil
}

// withinRoot resolves symlinks in the longest prefix of p that exists and checks the result is
// inside the repository's real location.
func (a *App) withinRoot(p string) error {
	root, err := filepath.EvalSymlinks(a.root)
	if err != nil {
		return nil
	}
	for q := p; ; q = filepath.Dir(q) {
		if real, err := filepath.EvalSymlinks(q); err == nil {
			r, err := filepath.Rel(root, real)
			if err != nil || r == ".." || strings.HasPrefix(r, ".."+string(filepath.Separator)) {
				return errors.New("path escapes workspace through a symlink")
			}
			return nil
		}
		if q == filepath.Dir(q) {
			return nil
		}
	}
}

// inGitDir reports whether a repository-relative path is, or is inside, a .git directory.
func inGitDir(rel string) bool {
	for _, part := range strings.Split(filepath.ToSlash(filepath.Clean(rel)), "/") {
		if strings.EqualFold(part, ".git") {
			return true
		}
	}
	return false
}

// rawAtRev serves a file's bytes as they are at HEAD, in the index or in a commit, for the
// before side of an image diff. The base, ours and theirs revisions read the unmerged stages.
func (a *App) rawAtRev(w http.ResponseWriter, rel, rev string) {
	var object string
	switch rev {
	case "head":
		object = "HEAD:./" + filepath.ToSlash(rel)
	case "index":
		object = ":./" + filepath.ToSlash(rel)
	case "base":
		object = ":1:./" + filepath.ToSlash(rel)
	case "ours":
		object = ":2:./" + filepath.ToSlash(rel)
	case "theirs":
		object = ":3:./" + filepath.ToSlash(rel)
	default:
		hash, err := a.resolveCommit(rev)
		if err != nil {
			http.Error(w, "unknown rev", http.StatusBadRequest)
			return
		}
		object = hash + ":./" + filepath.ToSlash(rel)
	}
	out, err := a.gitCmd("show", object).Output()
	if err != nil {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	w.Header().Set("Content-Security-Policy", "sandbox; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Cache-Control", "no-cache")
	ct := mime.TypeByExtension(filepath.Ext(rel))
	if ct == "" {
		ct = http.DetectContentType(out)
	}
	w.Header().Set("Content-Type", ct)
	_, _ = w.Write(out)
}
