package main

import (
	"encoding/json"
	"io/fs"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

// A workspace is a folder that is not a repository but holds some. One echo process serves it:
// every child repository is its own App, reached under /r/<id>/ with the prefix stripped, and the
// folder itself is one more App (files only) under filesID. Nothing about an App knows it is in a
// workspace, so a repository behaves exactly as it does when it is served alone.
const (
	filesID = "_files"
	// wsDepth is how many folder levels below the workspace are searched for repositories.
	wsDepth = 1
	// wsInterval is how often the overview looks at every repository, and wsParallel how many Git
	// processes it runs at once. The open repository's own status stream still polls every two seconds.
	wsInterval = 5 * time.Second
	wsParallel = 3
)

type wsRepo struct {
	ID   string
	Name string
	Root string
	app  *App
	mux  *http.ServeMux
}

type Workspace struct {
	root string
	host *App // the folder itself: its files, and the process's config, instance and shutdown routes
	hub  statusHub

	mu    sync.RWMutex
	repos []*wsRepo
	byID  map[string]*wsRepo
	depth int
}

// isRepoRoot reports whether dir holds a .git entry (a directory, or a file in a linked worktree).
func isRepoRoot(dir string) bool {
	_, err := os.Lstat(filepath.Join(dir, ".git"))
	return err == nil
}

// discoverRepos returns the repositories below dir, depth folder levels down. Hidden and build
// folders are skipped, symbolic links are not followed, and a repository's own subfolders are not searched.
func discoverRepos(dir string, depth int) []string {
	ents, err := os.ReadDir(dir)
	if err != nil {
		return nil
	}
	var out []string
	for _, e := range ents {
		if !e.IsDir() || e.Type()&fs.ModeSymlink != 0 || strings.HasPrefix(e.Name(), ".") || skipDir(e.Name()) {
			continue
		}
		p := filepath.Join(dir, e.Name())
		if isRepoRoot(p) {
			out = append(out, p)
		} else if depth > 1 {
			out = append(out, discoverRepos(p, depth-1)...)
		}
	}
	return out
}

// repoID names a repository by its path under the workspace, with "/" written as "~" so it is one URL segment.
func repoID(root, repo string) string {
	rel, err := filepath.Rel(root, repo)
	if err != nil {
		rel = filepath.Base(repo)
	}
	return strings.ReplaceAll(filepath.ToSlash(rel), "/", "~")
}

func newWorkspace(root string, port int, found []string) *Workspace {
	w := &Workspace{root: root, depth: wsDepth, byID: map[string]*wsRepo{}}
	w.host = newApp(root, port)
	w.host.noGit = true
	w.host.ws = w
	w.host.skipRel = w.isRepoRel
	w.setRepos(found)
	return w
}

// setRepos makes the repository list match found, keeping the App of any repository already served.
func (w *Workspace) setRepos(found []string) {
	w.mu.Lock()
	defer w.mu.Unlock()
	old := map[string]*wsRepo{}
	for _, r := range w.repos {
		old[r.Root] = r
	}
	w.repos, w.byID = nil, map[string]*wsRepo{filesID: {ID: filesID, Name: "Workspace files", Root: w.root, app: w.host, mux: w.host.mux()}}
	for _, p := range found {
		r := old[p]
		if r == nil {
			app := newApp(p, w.host.port)
			app.token, app.done = w.host.token, w.host.done
			r = &wsRepo{ID: repoID(w.root, p), Root: p, app: app, mux: app.mux()}
			r.Name = strings.ReplaceAll(r.ID, "~", "/")
		}
		w.repos = append(w.repos, r)
		w.byID[r.ID] = r
	}
	sort.Slice(w.repos, func(i, j int) bool { return w.repos[i].ID < w.repos[j].ID })
}

func (w *Workspace) rescan() { w.setRepos(discoverRepos(w.root, w.depth)) }

// isRepoRel reports whether a path under the workspace is a repository or inside one, so the
// workspace's own file tree leaves it out.
func (w *Workspace) isRepoRel(rel string) bool {
	w.mu.RLock()
	defer w.mu.RUnlock()
	for _, r := range w.repos {
		if r.ID == strings.ReplaceAll(rel, "/", "~") {
			return true
		}
	}
	return false
}

func (w *Workspace) lookup(id string) *wsRepo {
	w.mu.RLock()
	defer w.mu.RUnlock()
	return w.byID[id]
}

func (w *Workspace) list() []*wsRepo {
	w.mu.RLock()
	defer w.mu.RUnlock()
	return append([]*wsRepo(nil), w.repos...)
}

// instanceInfo is what the workspace's entry in the repository switcher reports.
func (w *Workspace) instanceInfo() (map[string]string, int) {
	repos := map[string]string{}
	for _, r := range w.list() {
		repos[r.ID] = r.Root
	}
	changes := 0
	for _, s := range w.summaries() {
		changes += s.Staged + s.Unstaged + s.Untracked + s.Conflicts
	}
	return repos, changes
}

// RepoSummary is one row of the overview: where a repository is and how much is changed in it.
type RepoSummary struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Root      string `json:"root"`
	Branch    string `json:"branch"`
	Upstream  bool   `json:"upstream"`
	Ahead     int    `json:"ahead"`
	Behind    int    `json:"behind"`
	Staged    int    `json:"staged"`
	Unstaged  int    `json:"unstaged"`
	Untracked int    `json:"untracked"`
	Conflicts int    `json:"conflicts"`
	Error     string `json:"error,omitempty"`
}

// summary reads a repository's branch, ahead/behind and change counts with one Git process.
func (a *App) summary() RepoSummary {
	var s RepoSummary
	out, err := a.git("status", "--porcelain=v1", "-z", "--branch", "--no-renames", "--untracked-files=all")
	if err != nil {
		s.Error = err.Error()
		return s
	}
	head, rest, _ := strings.Cut(out, "\x00")
	s.Branch, s.Upstream, s.Ahead, s.Behind = parseBranchLine(head)
	for _, c := range parsePorcelain(rest) {
		switch {
		case c.Conflict:
			s.Conflicts++
		case c.Code == "??":
			s.Untracked++
		default:
			if c.Code[0] != ' ' {
				s.Staged++
			}
			if c.Code[1] != ' ' {
				s.Unstaged++
			}
		}
	}
	return s
}

// parseBranchLine reads the "## branch...upstream [ahead 1, behind 2]" header of `status --branch`.
func parseBranchLine(h string) (branch string, upstream bool, ahead, behind int) {
	h = strings.TrimPrefix(h, "## ")
	switch {
	case strings.HasPrefix(h, "No commits yet on "):
		return strings.TrimPrefix(h, "No commits yet on "), false, 0, 0
	case strings.HasPrefix(h, "HEAD (no branch)"):
		return "detached", false, 0, 0
	}
	name, tail, hasUp := strings.Cut(h, "...")
	if !hasUp {
		return name, false, 0, 0
	}
	if i := strings.Index(tail, " ["); i >= 0 {
		counts := strings.TrimSuffix(tail[i+2:], "]")
		for _, part := range strings.Split(counts, ", ") {
			switch {
			case strings.HasPrefix(part, "ahead "):
				ahead, _ = strconv.Atoi(strings.TrimPrefix(part, "ahead "))
			case strings.HasPrefix(part, "behind "):
				behind, _ = strconv.Atoi(strings.TrimPrefix(part, "behind "))
			}
		}
		// "gone" means the upstream branch was deleted on the remote.
		return name, counts != "gone", ahead, behind
	}
	return name, true, 0, 0
}

// eachRepo runs fn on every repository, wsParallel at a time, and returns the results in list order.
func eachRepo[T any](repos []*wsRepo, fn func(*wsRepo) T) []T {
	out := make([]T, len(repos))
	sem := make(chan struct{}, wsParallel)
	var wg sync.WaitGroup
	for i, r := range repos {
		wg.Add(1)
		sem <- struct{}{}
		go func() {
			defer wg.Done()
			defer func() { <-sem }()
			out[i] = fn(r)
		}()
	}
	wg.Wait()
	return out
}

func (w *Workspace) summaries() []RepoSummary {
	return eachRepo(w.list(), func(r *wsRepo) RepoSummary {
		s := r.app.summary()
		s.ID, s.Name, s.Root = r.ID, r.Name, r.Root
		return s
	})
}

func (w *Workspace) snapshot() []byte {
	data, _ := json.Marshal(map[string]any{"repos": w.summaries()})
	return data
}

// RepoChanges is one repository's changed files, for the overview's all-changes list.
type RepoChanges struct {
	ID      string   `json:"id"`
	Name    string   `json:"name"`
	Branch  string   `json:"branch"`
	Changes []Change `json:"changes"`
}

func (w *Workspace) changes() []RepoChanges {
	all := eachRepo(w.list(), func(r *wsRepo) RepoChanges {
		st := r.app.gitStatus()
		return RepoChanges{ID: r.ID, Name: r.Name, Branch: st.Branch, Changes: st.Changes}
	})
	out := []RepoChanges{}
	for _, rc := range all {
		if len(rc.Changes) > 0 {
			out = append(out, rc)
		}
	}
	return out
}

// RepoResult is what one repository answered to a fetch or pull from the overview.
type RepoResult struct {
	ID      string `json:"id"`
	OK      bool   `json:"ok"`
	Skipped bool   `json:"skipped,omitempty"`
	Message string `json:"message"`
}

// netAll runs one network action on every repository. A repository already busy with its own
// fetch, pull or push is skipped, as it would be refused from its own page.
func (w *Workspace) netAll(pull bool) []RepoResult {
	return eachRepo(w.list(), func(r *wsRepo) RepoResult {
		res := RepoResult{ID: r.ID}
		req := gitRequest{Action: "fetch"}
		if pull {
			s := r.app.summary()
			switch {
			case s.Error != "":
				res.Skipped, res.Message = true, s.Error
				return res
			case !s.Upstream || s.Behind == 0 || s.Ahead > 0 || s.Staged+s.Unstaged+s.Conflicts > 0:
				res.Skipped, res.Message = true, "nothing to fast-forward, or it has local work"
				return res
			}
			req = gitRequest{Action: "pull", Strategy: "ff-only"}
		}
		if !r.app.net.TryLock() {
			res.Skipped, res.Message = true, "another fetch, pull, or push is still running"
			return res
		}
		defer r.app.net.Unlock()
		out, err := r.app.network(req)
		res.OK, res.Message = err == nil, strings.TrimSpace(out)
		if err != nil {
			res.Message = strings.TrimSpace(out + "\n" + err.Error())
		}
		return res
	})
}

func (w *Workspace) routes() http.Handler {
	mux := http.NewServeMux()
	hostMux := w.host.mux()
	mux.HandleFunc("/ws/repos", func(w2 http.ResponseWriter, r *http.Request) {
		w2.Header().Set("Content-Type", "application/json")
		_, _ = w2.Write(w.snapshot())
	})
	// The other echo processes on this machine, so the switcher can reach repositories outside the workspace.
	mux.HandleFunc("/ws/instances", w.host.handleInstances)
	mux.HandleFunc("/ws/stream", w.handleStream)
	mux.HandleFunc("/ws/changes", func(w2 http.ResponseWriter, r *http.Request) { writeJSON(w2, w.changes()) })
	mux.HandleFunc("/ws/fetch", func(w2 http.ResponseWriter, r *http.Request) { w.handleNet(w2, r, false) })
	mux.HandleFunc("/ws/pull", func(w2 http.ResponseWriter, r *http.Request) { w.handleNet(w2, r, true) })
	mux.HandleFunc("/ws/rescan", func(w2 http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w2, "POST only", http.StatusMethodNotAllowed)
			return
		}
		w.rescan()
		w2.Header().Set("Content-Type", "application/json")
		_, _ = w2.Write(w.snapshot())
	})
	mux.HandleFunc("/r/", w.serveRepo)
	mux.HandleFunc("/", func(w2 http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/" {
			w2.Header().Set("Cache-Control", "no-cache")
			assets, _ := fs.Sub(webFS, "web")
			http.ServeFileFS(w2, r, assets, "workspace.html")
			return
		}
		hostMux.ServeHTTP(w2, r)
	})
	return w.host.guard(mux)
}

func (w *Workspace) handleStream(w2 http.ResponseWriter, r *http.Request) {
	flusher, ok := w2.(http.Flusher)
	if !ok {
		http.Error(w2, "stream unsupported", http.StatusInternalServerError)
		return
	}
	w2.Header().Set("Content-Type", "text/event-stream")
	w2.Header().Set("Cache-Control", "no-cache")
	w2.Header().Set("Connection", "keep-alive")
	ch := w.hub.subscribeTo(pollSource{produce: w.snapshot, done: w.host.done, interval: wsInterval})
	serveStream(w2, r, flusher, w.host.done, ch, &w.hub)
}

func (w *Workspace) handleNet(w2 http.ResponseWriter, r *http.Request, pull bool) {
	if r.Method != http.MethodPost {
		http.Error(w2, "POST only", http.StatusMethodNotAllowed)
		return
	}
	writeJSON(w2, w.netAll(pull))
}

// serveRepo hands /r/<id>/<rest> to that repository's own routes as /<rest>. The id must be one
// the workspace discovered, so a request can never name a folder of its own choosing.
func (w *Workspace) serveRepo(w2 http.ResponseWriter, r *http.Request) {
	id, sub, slash := strings.Cut(strings.TrimPrefix(r.URL.Path, "/r/"), "/")
	repo := w.lookup(id)
	if repo == nil {
		http.NotFound(w2, r)
		return
	}
	if !slash {
		http.Redirect(w2, r, "/r/"+url.PathEscape(id)+"/", http.StatusSeeOther)
		return
	}
	sub = "/" + sub
	// Stopping the process, and listing its siblings, belong to the workspace, not to one repository.
	switch sub {
	case "/api/shutdown", "/api/instance", "/api/instances":
		http.NotFound(w2, r)
		return
	}
	r2 := r.Clone(r.Context())
	r2.URL.Path, r2.URL.RawPath = sub, ""
	repo.mux.ServeHTTP(w2, r2)
}
