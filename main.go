package main

import (
	"embed"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io/fs"
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

type Config struct {
	Vim        bool           `json:"vim"`
	DiffMode   string         `json:"diffMode"`
	Panels     []string       `json:"panels"`
	PanelSizes map[string]int `json:"panelSizes"`
}

type App struct {
	root string
	cfg  Config
	mu   sync.Mutex
}

type Commit struct {
	Hash    string `json:"hash"`
	Subject string `json:"subject"`
	Author  string `json:"author"`
}

type Stash struct {
	Ref     string `json:"ref"`
	Subject string `json:"subject"`
}

type GitStatus struct {
	Git      bool              `json:"git"`
	Root     string            `json:"root"`
	Branch   string            `json:"branch"`
	Statuses map[string]string `json:"statuses"`
	Staged   map[string]bool   `json:"staged"`
	Files    []string          `json:"files"`
	Commits  []Commit          `json:"commits"`
	Branches []string          `json:"branches"`
	Stashes  []Stash           `json:"stashes"`
	Error    string            `json:"error,omitempty"`
}

type TreeNode struct {
	Name     string     `json:"name"`
	Path     string     `json:"path"`
	Dir      bool       `json:"dir"`
	Children []TreeNode `json:"children,omitempty"`
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

	app := &App{root: root, cfg: loadConfig()}
	addr := "127.0.0.1:" + strconv.Itoa(*port)
	ln, err := listen(addr)
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

func listen(addr string) (net.Listener, error) {
	return net.Listen("tcp", addr)
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
	return mux
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
	data, err := os.ReadFile(path)
	if err != nil {
		http.Error(w, err.Error(), http.StatusNotFound)
		return
	}
	writeJSON(w, map[string]string{"path": filepath.ToSlash(rel), "content": string(data)})
}

func (a *App) handleFileWrite(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Action  string `json:"action"`
		Path    string `json:"path"`
		NewPath string `json:"newPath"`
		Content string `json:"content"`
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
		if err := os.WriteFile(path, []byte(req.Content), 0o644); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
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
	status := GitStatus{Git: true, Root: a.root, Statuses: map[string]string{}, Staged: map[string]bool{}}
	if _, err := exec.LookPath("git"); err != nil {
		status.Git = false
		status.Error = "git not found"
		return status
	}
	if out, err := a.git("branch", "--show-current"); err == nil {
		status.Branch = strings.TrimSpace(out)
	} else {
		status.Git = false
		status.Error = err.Error()
		return status
	}
	out, err := a.git("status", "--porcelain=v1", "--untracked-files=all")
	if err != nil {
		status.Error = err.Error()
		return status
	}
	for _, line := range strings.Split(strings.TrimSpace(out), "\n") {
		if len(line) < 4 {
			continue
		}
		code := line[:2]
		path := line[3:]
		if idx := strings.Index(path, " -> "); idx >= 0 {
			path = path[idx+4:]
		}
		path = strings.TrimSpace(path)
		status.Statuses[path] = code
		status.Staged[path] = code[0] != ' ' && code[0] != '?'
		status.Files = append(status.Files, path)
	}
	sort.Strings(status.Files)
	if out, err := a.git("log", "-n", "100", "--format=%h%x09%s%x09%an"); err == nil {
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

func (a *App) handleGit(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Action   string   `json:"action"`
		Paths    []string `json:"paths"`
		Message  string   `json:"message"`
		From     string   `json:"from"`
		To       string   `json:"to"`
		StashRef string   `json:"stashRef"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	args, err := a.gitArgs(req)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	out, err := a.git(args...)
	if err != nil {
		http.Error(w, strings.TrimSpace(out+err.Error()), http.StatusBadGateway)
		return
	}
	writeJSON(w, map[string]any{"ok": true, "output": out})
}

func (a *App) gitArgs(req struct {
	Action   string   `json:"action"`
	Paths    []string `json:"paths"`
	Message  string   `json:"message"`
	From     string   `json:"from"`
	To       string   `json:"to"`
	StashRef string   `json:"stashRef"`
}) ([]string, error) {
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
	case "discard":
		return append([]string{"restore", "--staged", "--worktree", "--"}, paths...), nil
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
	case "rebase":
		if req.From == "" {
			return nil, errors.New("rebase target required")
		}
		return []string{"rebase", req.From}, nil
	case "branch:create":
		if req.From == "" {
			return nil, errors.New("branch name required")
		}
		return []string{"switch", "-c", req.From}, nil
	case "branch:switch":
		if req.From == "" {
			return nil, errors.New("branch name required")
		}
		return []string{"switch", req.From}, nil
	case "merge":
		if req.From == "" {
			return nil, errors.New("merge target required")
		}
		return []string{"merge", req.From}, nil
	case "pull":
		return []string{"pull"}, nil
	case "push":
		return []string{"push"}, nil
	case "stash:create":
		if strings.TrimSpace(req.Message) == "" {
			req.Message = "echo stash"
		}
		return []string{"stash", "push", "-u", "-m", req.Message}, nil
	case "stash:apply":
		if req.StashRef == "" {
			return nil, errors.New("stash ref required")
		}
		return []string{"stash", "apply", req.StashRef}, nil
	case "stash:pop":
		if req.StashRef == "" {
			return nil, errors.New("stash ref required")
		}
		return []string{"stash", "pop", req.StashRef}, nil
	case "stash:drop":
		if req.StashRef == "" {
			return nil, errors.New("stash ref required")
		}
		return []string{"stash", "drop", req.StashRef}, nil
	default:
		return nil, fmt.Errorf("unknown git action: %s", req.Action)
	}
}

func (a *App) handleDiff(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	args := []string{"diff", "--no-ext-diff", "--unified=3"}
	if q.Get("scope") == "staged" {
		args = append(args, "--cached")
	}
	if q.Get("scope") == "range" {
		from, to := q.Get("from"), q.Get("to")
		if from == "" || to == "" {
			http.Error(w, "from and to required", http.StatusBadRequest)
			return
		}
		args = append(args, from+".."+to)
	}
	if q.Get("ignoreWhitespace") == "1" {
		args = append(args, "--ignore-all-space")
	}
	args = append(args, "--")
	out, err := a.git(args...)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	writeJSON(w, map[string]string{"text": out})
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
	send := func() {
		data, _ := json.Marshal(a.gitStatus())
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

func (a *App) git(args ...string) (string, error) {
	cmd := exec.Command("git", args...)
	cmd.Dir = a.root
	out, err := cmd.CombinedOutput()
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

func parseCommits(s string) []Commit {
	var out []Commit
	for _, line := range strings.Split(s, "\n") {
		parts := strings.SplitN(line, "\t", 3)
		if len(parts) == 3 {
			out = append(out, Commit{Hash: parts[0], Subject: parts[1], Author: parts[2]})
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
	cfg := Config{DiffMode: "unified", Panels: []string{"tree", "editor", "git"}, PanelSizes: map[string]int{}}
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
