package main

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// testWorkspace makes a folder with two repositories ("api" has an edit, an untracked file and a
// staged file; "web" is clean), a plain folder, and a loose file, and serves it as a workspace.
func testWorkspace(t *testing.T) (*Workspace, *httptest.Server) {
	t.Helper()
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not installed")
	}
	root := t.TempDir()
	git := func(dir string, args ...string) {
		cmd := exec.Command("git", append([]string{"-c", "commit.gpgsign=false", "-c", "user.name=t", "-c", "user.email=t@t"}, args...)...)
		cmd.Dir = dir
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, out)
		}
	}
	write := func(p, content string) {
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	for _, name := range []string{"api", "web"} {
		dir := filepath.Join(root, name)
		git(root, "init", "-q", "-b", "main", dir)
		write(filepath.Join(dir, "keep.txt"), "one\ntwo\n")
		git(dir, "add", ".")
		git(dir, "commit", "-q", "-m", "init")
	}
	api := filepath.Join(root, "api")
	write(filepath.Join(api, "keep.txt"), "one\n2\n")
	write(filepath.Join(api, "new.txt"), "new\n")
	write(filepath.Join(api, "staged.txt"), "s\n")
	git(api, "add", "staged.txt")
	write(filepath.Join(root, "docs", "plan.md"), "# plan\n")
	write(filepath.Join(root, "docker-compose.yaml"), "x: 1\n")
	write(filepath.Join(root, "node_modules", "pkg", ".git", "HEAD"), "ref: refs/heads/main\n")

	found := discoverRepos(root, 1)
	ws := newWorkspace(root, 6030, found)
	srv := httptest.NewServer(ws.routes())
	t.Cleanup(srv.Close)
	// The guard admits the listener's own host; tests run with the token check off.
	ws.host.hosts[strings.TrimPrefix(srv.URL, "http://")] = true
	return ws, srv
}

func get(t *testing.T, url string, into any) int {
	t.Helper()
	res, err := http.Get(url)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	if into != nil && res.StatusCode == 200 {
		if err := json.NewDecoder(res.Body).Decode(into); err != nil {
			t.Fatal(err)
		}
	}
	return res.StatusCode
}

func TestDiscoverRepos(t *testing.T) {
	ws, _ := testWorkspace(t)
	var ids []string
	for _, r := range ws.list() {
		ids = append(ids, r.ID)
	}
	if strings.Join(ids, ",") != "api,web" {
		t.Errorf("repos = %v, want api,web (docs is a plain folder, node_modules is skipped)", ids)
	}
	if !ws.isRepoRel("api") || ws.isRepoRel("docs") {
		t.Error("isRepoRel does not match the repositories")
	}
}

func TestDiscoverReposDepth(t *testing.T) {
	root := t.TempDir()
	for _, p := range []string{"top/.git", "group/inner/.git", "group/.hidden/.git"} {
		if err := os.MkdirAll(filepath.Join(root, p), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	if got := discoverRepos(root, 1); len(got) != 1 {
		t.Errorf("depth 1 found %v", got)
	}
	got := discoverRepos(root, 2)
	if len(got) != 2 || repoID(root, got[0]) != "group~inner" {
		t.Errorf("depth 2 found %v", got)
	}
}

func TestParseBranchLine(t *testing.T) {
	cases := []struct {
		in     string
		branch string
		up     bool
		ahead  int
		behind int
	}{
		{"## main...origin/main", "main", true, 0, 0},
		{"## main...origin/main [ahead 2, behind 3]", "main", true, 2, 3},
		{"## feat/x...origin/feat/x [behind 1]", "feat/x", true, 0, 1},
		{"## main...origin/main [gone]", "main", false, 0, 0},
		{"## dev", "dev", false, 0, 0},
		{"## No commits yet on main", "main", false, 0, 0},
		{"## HEAD (no branch)", "detached", false, 0, 0},
	}
	for _, c := range cases {
		b, up, a, bh := parseBranchLine(c.in)
		if b != c.branch || up != c.up || a != c.ahead || bh != c.behind {
			t.Errorf("parseBranchLine(%q) = %q %v %d %d", c.in, b, up, a, bh)
		}
	}
}

func TestWorkspaceSummaries(t *testing.T) {
	_, srv := testWorkspace(t)
	var out struct{ Repos []RepoSummary }
	if code := get(t, srv.URL+"/ws/repos", &out); code != 200 || len(out.Repos) != 2 {
		t.Fatalf("/ws/repos = %d %+v", code, out)
	}
	api, web := out.Repos[0], out.Repos[1]
	if api.Branch != "main" || api.Staged != 1 || api.Unstaged != 1 || api.Untracked != 1 {
		t.Errorf("api summary = %+v", api)
	}
	if web.Staged+web.Unstaged+web.Untracked != 0 {
		t.Errorf("web should be clean: %+v", web)
	}
}

func TestWorkspaceRoutesToRepos(t *testing.T) {
	ws, srv := testWorkspace(t)
	var st GitStatus
	if code := get(t, srv.URL+"/r/api/api/git/status", &st); code != 200 || st.Root != filepath.Join(ws.root, "api") || len(st.Changes) != 3 {
		t.Errorf("api status = %d root=%s changes=%d", code, st.Root, len(st.Changes))
	}
	if code := get(t, srv.URL+"/r/web/api/git/status", &st); code != 200 || len(st.Changes) != 0 {
		t.Errorf("web status = %d changes=%d", code, len(st.Changes))
	}
	// The repository's page is the app, served under its own prefix.
	res, _ := http.Get(srv.URL + "/r/api/")
	body, _ := io.ReadAll(res.Body)
	res.Body.Close()
	if res.StatusCode != 200 || !strings.Contains(string(body), `id="repo-name"`) {
		t.Errorf("/r/api/ = %d, not the app page", res.StatusCode)
	}
	// The workspace's own files are one more entry, without the child repositories.
	var tree []TreeNode
	if code := get(t, srv.URL+"/r/"+filesID+"/api/tree", &tree); code != 200 {
		t.Fatalf("files tree = %d", code)
	}
	var paths []string
	for _, n := range tree {
		paths = append(paths, n.Path)
	}
	if strings.Join(paths, ",") != "docker-compose.yaml,docs/plan.md" {
		t.Errorf("workspace files = %v", paths)
	}
	var fst GitStatus
	if get(t, srv.URL+"/r/"+filesID+"/api/git/status", &fst); fst.Git {
		t.Error("the workspace folder must not report Git")
	}
}

func TestWorkspaceRefusesUnknownRepos(t *testing.T) {
	_, srv := testWorkspace(t)
	for _, p := range []string{"/r/nope/api/git/status", "/r/%2e%2e/x/", "/r/api/api/shutdown", "/r/api/api/instances", "/r/node_modules/"} {
		if code := get(t, srv.URL+p, nil); code != 404 && code != 400 {
			t.Errorf("GET %s = %d, want 404", p, code)
		}
	}
	// A repository's id never reaches the filesystem except through the discovered list.
	req, _ := http.NewRequest(http.MethodPost, srv.URL+"/r/api/api/shutdown", strings.NewReader("{}"))
	req.Header.Set("Content-Type", "application/json")
	if res, err := http.DefaultClient.Do(req); err != nil || res.StatusCode != 404 {
		t.Errorf("shutdown through a repository prefix = %v %v", res, err)
	}
}

func TestWorkspaceRedirectsBarePrefix(t *testing.T) {
	_, srv := testWorkspace(t)
	c := &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	res, err := c.Get(srv.URL + "/r/api")
	if err != nil || res.StatusCode != http.StatusSeeOther || res.Header.Get("Location") != "/r/api/" {
		t.Errorf("/r/api = %v %v", res, err)
	}
}

func TestWorkspaceGuardCoversRepos(t *testing.T) {
	ws, _ := testWorkspace(t)
	ws.host.token = "secret-token-secret-token-secret-token"
	h := ws.routes()
	req := httptest.NewRequest(http.MethodGet, "http://127.0.0.1:6030/r/api/api/file?path=keep.txt", nil)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Errorf("without the token = %d, want 401", rec.Code)
	}
	req.Header.Set(tokenHeader, ws.host.token)
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != 200 {
		t.Errorf("with the token = %d", rec.Code)
	}
	req = httptest.NewRequest(http.MethodGet, "http://evil.example/r/api/", nil)
	req.Header.Set(tokenHeader, ws.host.token)
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusForbidden {
		t.Errorf("foreign host = %d, want 403", rec.Code)
	}
}

func TestWorkspaceChangesAndNet(t *testing.T) {
	_, srv := testWorkspace(t)
	var changes []RepoChanges
	if code := get(t, srv.URL+"/ws/changes", &changes); code != 200 || len(changes) != 1 || changes[0].ID != "api" || len(changes[0].Changes) != 3 {
		t.Errorf("/ws/changes = %d %+v", code, changes)
	}
	res, err := http.Post(srv.URL+"/ws/fetch", "application/json", strings.NewReader("{}"))
	if err != nil {
		t.Fatal(err)
	}
	var results []RepoResult
	_ = json.NewDecoder(res.Body).Decode(&results)
	res.Body.Close()
	if len(results) != 2 || !results[0].OK || !results[1].OK {
		t.Errorf("fetch all = %+v (a repository with no remote fetches nothing and succeeds)", results)
	}
	// Pull skips what it cannot fast-forward.
	res, _ = http.Post(srv.URL+"/ws/pull", "application/json", strings.NewReader("{}"))
	results = nil
	_ = json.NewDecoder(res.Body).Decode(&results)
	res.Body.Close()
	if len(results) != 2 || !results[0].Skipped || !results[1].Skipped {
		t.Errorf("pull all = %+v, want both skipped", results)
	}
}

func TestWorkspaceRescanKeepsApps(t *testing.T) {
	ws, _ := testWorkspace(t)
	before := ws.lookup("api")
	if err := os.MkdirAll(filepath.Join(ws.root, "extra", ".git"), 0o755); err != nil {
		t.Fatal(err)
	}
	ws.rescan()
	if ws.lookup("extra") == nil || ws.lookup("api") != before {
		t.Error("rescan should add new repositories and keep the existing ones")
	}
}

func TestLocate(t *testing.T) {
	list := []Instance{
		{Root: "/a/solo", Port: 6030},
		{Root: "/a/ws", Port: 6031, Repos: map[string]string{"api": "/a/ws/api", "g~x": "/a/ws/g/x"}},
	}
	for root, want := range map[string]struct {
		port int
		sub  string
	}{
		"/a/solo":    {6030, "/"},
		"/a/ws":      {6031, "/"},
		"/a/ws/api":  {6031, "/r/api/"},
		"/a/ws/g/x":  {6031, "/r/g~x/"},
		"/a/missing": {0, ""},
	} {
		if p, sub := locate(root, list); p != want.port || sub != want.sub {
			t.Errorf("locate(%s) = %d %q, want %d %q", root, p, sub, want.port, want.sub)
		}
	}
}
