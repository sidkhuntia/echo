package main

import (
	"crypto/sha1"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"
)

func (a *App) addEndpoints(mux *http.ServeMux) {
	mux.HandleFunc("/api/reflog", a.handleReflog)
	mux.HandleFunc("/api/worktrees", a.handleWorktrees)
	mux.HandleFunc("/api/submodules", a.handleSubmodules)
	mux.HandleFunc("/api/compare", a.handleCompare)
	mux.HandleFunc("/api/rebase/plan", a.handleRebasePlan)
	mux.HandleFunc("/api/stash", a.handleStashShow)
	mux.HandleFunc("/api/branch/unmerged", a.handleUnmerged)
	mux.HandleFunc("/api/git/template", a.handleTemplate)
	mux.HandleFunc("/api/review", a.handleReview)
	mux.HandleFunc("/api/open", a.handleOpen)
	mux.HandleFunc("/api/drafts", a.handleDrafts)
}

func badRequest(w http.ResponseWriter, err error) { http.Error(w, err.Error(), http.StatusBadRequest) }

// ReflogEntry is one move of HEAD, for "recover this state".
type ReflogEntry struct {
	Hash    string `json:"hash"`
	Short   string `json:"short"`
	Ref     string `json:"ref"`
	Subject string `json:"subject"`
	Time    int64  `json:"time"`
}

func (a *App) handleReflog(w http.ResponseWriter, r *http.Request) {
	n, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	if n <= 0 || n > 1000 {
		n = 200
	}
	out, err := a.git("reflog", "--format=%H%x1f%h%x1f%gd%x1f%gs%x1f%ct", "-n", strconv.Itoa(n))
	entries := []ReflogEntry{}
	if err == nil {
		for _, l := range parseLines(out) {
			f := strings.Split(l, "\x1f")
			if len(f) < 5 {
				continue
			}
			t, _ := strconv.ParseInt(f[4], 10, 64)
			entries = append(entries, ReflogEntry{Hash: f[0], Short: f[1], Ref: f[2], Subject: f[3], Time: t})
		}
	}
	writeJSON(w, entries)
}

// Worktree is one checkout of the repository.
type Worktree struct {
	Path     string `json:"path"`
	Head     string `json:"head"`
	Branch   string `json:"branch"`
	Detached bool   `json:"detached,omitempty"`
	Locked   bool   `json:"locked,omitempty"`
	Main     bool   `json:"main,omitempty"`
}

func parseWorktrees(s string) []Worktree {
	out := []Worktree{}
	var cur *Worktree
	for _, l := range strings.Split(s, "\n") {
		switch {
		case strings.HasPrefix(l, "worktree "):
			out = append(out, Worktree{Path: strings.TrimPrefix(l, "worktree "), Main: len(out) == 0})
			cur = &out[len(out)-1]
		case cur == nil:
		case strings.HasPrefix(l, "HEAD "):
			cur.Head = strings.TrimPrefix(l, "HEAD ")
		case strings.HasPrefix(l, "branch "):
			cur.Branch = strings.TrimPrefix(strings.TrimPrefix(l, "branch "), "refs/heads/")
		case l == "detached":
			cur.Detached = true
		case strings.HasPrefix(l, "locked"):
			cur.Locked = true
		}
	}
	return out
}

func (a *App) handleWorktrees(w http.ResponseWriter, r *http.Request) {
	out, _ := a.git("worktree", "list", "--porcelain")
	writeJSON(w, parseWorktrees(out))
}

// Submodule is one line of `git submodule status`.
type Submodule struct {
	Path   string `json:"path"`
	Hash   string `json:"hash"`
	State  string `json:"state"` // ok, uninitialized, modified, conflict
	Detail string `json:"detail,omitempty"`
}

func parseSubmodules(s string) []Submodule {
	out := []Submodule{}
	for _, l := range parseLines(s) {
		if len(l) < 42 {
			continue
		}
		state := map[byte]string{' ': "ok", '-': "uninitialized", '+': "modified", 'U': "conflict"}[l[0]]
		f := strings.Fields(l[1:])
		if len(f) < 2 {
			continue
		}
		sm := Submodule{Hash: f[0], Path: f[1], State: state}
		if len(f) > 2 {
			sm.Detail = strings.Trim(strings.Join(f[2:], " "), "()")
		}
		out = append(out, sm)
	}
	return out
}

func (a *App) handleSubmodules(w http.ResponseWriter, r *http.Request) {
	out, _ := a.git("submodule", "status")
	writeJSON(w, parseSubmodules(out))
}

// handleCompare answers "what is on to that is not on from": commits, files and the ahead/behind
// count, like the top of a pull request. dots=3 compares from the merge base.
func (a *App) handleCompare(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	from, to := q.Get("from"), q.Get("to")
	for _, ref := range []string{from, to} {
		if err := validRef(ref); err != nil {
			badRequest(w, err)
			return
		}
	}
	dots := ".."
	if q.Get("dots") == "3" {
		dots = "..."
	}
	spec := from + dots + to
	res := map[string]any{"commits": []Commit{}, "files": []Change{}, "ahead": 0, "behind": 0}
	out, err := a.git("log", "--topo-order", "-n", "500", logFormat, from+".."+to, "--")
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	res["commits"] = parseCommits(out)
	codes, err := a.git("diff", "--name-status", "-z", "--no-renames", spec, "--")
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	files := parseNameStatus(codes)
	stats := map[string]Change{}
	if o, err := a.git("diff", "--numstat", "-z", "--no-renames", spec, "--"); err == nil {
		stats = parseNumstat(o)
	}
	for i := range files {
		s := stats[files[i].Path]
		files[i].Added, files[i].Deleted, files[i].Binary = s.Added, s.Deleted, s.Binary
	}
	res["files"] = files
	if o, err := a.git("rev-list", "--left-right", "--count", from+"..."+to); err == nil {
		f := strings.Fields(o)
		if len(f) == 2 {
			res["behind"], _ = strconv.Atoi(f[0])
			res["ahead"], _ = strconv.Atoi(f[1])
		}
	}
	writeJSON(w, res)
}

func (a *App) handleRebasePlan(w http.ResponseWriter, r *http.Request) {
	base, err := a.resolveCommit(r.URL.Query().Get("onto"))
	if err != nil {
		badRequest(w, err)
		return
	}
	plan, err := a.rebasePlan(base)
	if err != nil {
		badRequest(w, err)
		return
	}
	writeJSON(w, plan)
}

func (a *App) handleStashShow(w http.ResponseWriter, r *http.Request) {
	ref := r.URL.Query().Get("ref")
	if err := validRef(ref); err != nil {
		badRequest(w, err)
		return
	}
	out, err := a.git("stash", "show", "-p", "--include-untracked", "--no-color", "--no-ext-diff", ref)
	if err != nil {
		out, err = a.git("stash", "show", "-p", "--no-color", "--no-ext-diff", ref)
	}
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	writeJSON(w, map[string]string{"text": out})
}

// handleUnmerged lists the commits only a branch has, which a force delete would lose.
func (a *App) handleUnmerged(w http.ResponseWriter, r *http.Request) {
	name := r.URL.Query().Get("name")
	if err := validRef(name); err != nil {
		badRequest(w, err)
		return
	}
	out, err := a.git("log", "-n", "50", logFormat, name, "--not", "--exclude="+name, "--branches", "--remotes", "--")
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	writeJSON(w, parseCommits(out))
}

// handleTemplate returns the commit message template Git is configured with, if any.
func (a *App) handleTemplate(w http.ResponseWriter, r *http.Request) {
	out, err := a.git("config", "--get", "--path", "commit.template")
	p := strings.TrimSpace(out)
	if err != nil || p == "" {
		writeJSON(w, map[string]string{"template": ""})
		return
	}
	if !filepath.IsAbs(p) {
		p = filepath.Join(a.root, p)
	}
	f, err := os.Open(p)
	if err != nil {
		writeJSON(w, map[string]string{"template": ""})
		return
	}
	defer f.Close()
	b, _ := io.ReadAll(io.LimitReader(f, 64<<10))
	writeJSON(w, map[string]string{"template": string(b)})
}

// stateFile is where per-repository state the page keeps lives: review notes and unsaved drafts.
// It is beside the config, not in the repository, so it never shows up as a change.
func (a *App) stateFile(kind string) string {
	sum := sha1.Sum([]byte(a.root))
	return filepath.Join(filepath.Dir(configPath()), kind, hex.EncodeToString(sum[:])[:16]+".json")
}

const maxState = 8 << 20

// handleJSONStore reads and replaces one JSON document per repository.
func (a *App) handleJSONStore(w http.ResponseWriter, r *http.Request, kind string) {
	a.stateMu.Lock()
	defer a.stateMu.Unlock()
	path := a.stateFile(kind)
	if r.Method == http.MethodGet {
		b, err := os.ReadFile(path)
		if err != nil {
			b = []byte("{}")
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write(b)
		return
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, maxState+1))
	if err != nil || len(body) > maxState {
		http.Error(w, "document is too large", http.StatusRequestEntityTooLarge)
		return
	}
	var doc map[string]any
	if json.Unmarshal(body, &doc) != nil {
		http.Error(w, "body must be a JSON object", http.StatusBadRequest)
		return
	}
	if err := writeAtomic(path, body); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(w, map[string]bool{"ok": true})
}

func (a *App) handleReview(w http.ResponseWriter, r *http.Request) { a.handleJSONStore(w, r, "review") }
func (a *App) handleDrafts(w http.ResponseWriter, r *http.Request) { a.handleJSONStore(w, r, "drafts") }

var editorCommands = map[string]string{"code": "code", "cursor": "cursor", "zed": "zed", "subl": "subl"}

// handleOpen opens a file in the system's default app or a known editor, or reveals it in the file
// manager. The editor is a name from a fixed list, never a command line from the page.
func (a *App) handleOpen(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Path   string `json:"path"`
		Line   int    `json:"line"`
		App    string `json:"app"`
		Reveal bool   `json:"reveal"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		badRequest(w, err)
		return
	}
	path, err := a.safeContent(req.Path)
	if err != nil || inGitDir(req.Path) {
		http.Error(w, "path not allowed", http.StatusBadRequest)
		return
	}
	if _, err := os.Lstat(path); err != nil {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	var cmd *exec.Cmd
	switch {
	case req.Reveal && runtime.GOOS == "darwin":
		cmd = exec.Command("open", "-R", path)
	case req.Reveal:
		cmd = exec.Command("xdg-open", filepath.Dir(path))
	case req.App != "":
		bin, ok := editorCommands[req.App]
		if !ok {
			http.Error(w, "unknown editor", http.StatusBadRequest)
			return
		}
		target := path
		if req.Line > 0 {
			target += ":" + strconv.Itoa(req.Line)
		}
		if _, err := exec.LookPath(bin); err != nil {
			http.Error(w, bin+" is not on PATH", http.StatusBadRequest)
			return
		}
		if bin == "subl" || bin == "zed" {
			cmd = exec.Command(bin, target)
		} else {
			cmd = exec.Command(bin, "-g", target)
		}
	case runtime.GOOS == "darwin":
		cmd = exec.Command("open", path)
	default:
		cmd = exec.Command("xdg-open", path)
	}
	if err := cmd.Start(); err != nil {
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	go func() { _ = cmd.Wait() }()
	writeJSON(w, map[string]bool{"ok": true})
}

var dateArg = regexp.MustCompile(`^[0-9A-Za-z .:/+-]{1,40}$`)
