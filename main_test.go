package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestSafePath(t *testing.T) {
	a := &App{root: "/repo"}
	for _, rel := range []string{"/etc/passwd", "../x", "a/../../x"} {
		if _, err := a.safePath(rel); err == nil {
			t.Errorf("safePath(%q) allowed an escape", rel)
		}
	}
	if got, err := a.safePath("a/./b.go"); err != nil || got != "/repo/a/b.go" {
		t.Errorf("safePath(a/./b.go) = %q, %v", got, err)
	}
}

func TestGitArgsRejectsOptionRefs(t *testing.T) {
	a := &App{root: t.TempDir()}
	bad := []gitRequest{
		{Action: "rebase", From: "--exec=touch x"},
		{Action: "merge", From: "-s"},
		{Action: "branch:switch", From: "--orphan=x"},
		{Action: "branch:create", From: "a b"},
		{Action: "stash:apply", StashRef: "--index"},
		{Action: "add", Paths: []string{"../outside"}},
	}
	for _, req := range bad {
		if args, err := a.gitArgs(req); err == nil {
			t.Errorf("gitArgs(%+v) = %v, want error", req, args)
		}
	}
	args, err := a.gitArgs(gitRequest{Action: "stash:pop", StashRef: "stash@{0}"})
	if err != nil || strings.Join(args, " ") != "stash pop stash@{0}" {
		t.Errorf("stash:pop args = %v, %v", args, err)
	}
}

func TestGuard(t *testing.T) {
	a := newApp(t.TempDir(), 7777)
	h := a.routes()
	cases := []struct {
		name, method, host, origin, ctype string
		want                              int
	}{
		{"own page", "GET", "127.0.0.1:7777", "", "", 200},
		{"rebinding host", "GET", "evil.example:7777", "", "", 403},
		{"cross-site write", "POST", "127.0.0.1:7777", "http://evil.example", "application/json", 403},
		{"simple form post", "POST", "127.0.0.1:7777", "", "text/plain", 415},
	}
	for _, c := range cases {
		r := httptest.NewRequest(c.method, "/api/config", strings.NewReader("{}"))
		r.Host = c.host
		if c.origin != "" {
			r.Header.Set("Origin", c.origin)
		}
		if c.ctype != "" {
			r.Header.Set("Content-Type", c.ctype)
		}
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		if w.Code != c.want {
			t.Errorf("%s: status %d, want %d", c.name, w.Code, c.want)
		}
	}
}

func TestParsePorcelain(t *testing.T) {
	got := parsePorcelain(" M b.go\x00?? dir/new file.txt\x00R  new.go\x00old.go\x00")
	want := []string{"b.go", "dir/new file.txt", "new.go"}
	if len(got) != len(want) {
		t.Fatalf("got %+v", got)
	}
	for i, c := range got {
		if c.Path != want[i] {
			t.Errorf("entry %d path %q, want %q", i, c.Path, want[i])
		}
	}
	if got[0].Staged || got[1].Staged || !got[2].Staged {
		t.Errorf("staged flags wrong: %+v", got)
	}
}

func TestParseNumstat(t *testing.T) {
	got := parseNumstat("3\t1\ta.go\x00-\t-\timg.png\x00")
	if got["a.go"].Added != 3 || got["a.go"].Deleted != 1 || !got["img.png"].Binary {
		t.Errorf("got %+v", got)
	}
}

func TestParseCommits(t *testing.T) {
	got := parseCommits("abc123full\x1fabc123\x1fp1 p2\x1fHEAD -> main, tag: v1\x1fAda Lovelace\x1f1700000000\x1ffix:\ttabs in subject\x1e\nroot\x1fr\x1f\x1f\x1fB\x1f1\x1fFirst\x1e\nbad\x1e")
	if len(got) != 2 {
		t.Fatalf("got %+v", got)
	}
	c := got[0]
	if c.Hash != "abc123full" || c.Short != "abc123" || c.Author != "Ada Lovelace" || c.Time != 1700000000 || c.Subject != "fix:\ttabs in subject" ||
		strings.Join(c.Parents, " ") != "p1 p2" || strings.Join(c.Refs, "|") != "HEAD -> main|tag: v1" {
		t.Errorf("got %+v", c)
	}
	if r := got[1]; len(r.Parents) != 0 || len(r.Refs) != 0 || r.Subject != "First" {
		t.Errorf("root = %+v", r)
	}
}

func TestReadSigCountsLines(t *testing.T) {
	for in, want := range map[string]int{"": 0, "a": 1, "a\n": 1, "a\nb": 2} {
		if sig, _ := readSig(strings.NewReader(in)); sig.lines != want {
			t.Errorf("lines(%q) = %d, want %d", in, sig.lines, want)
		}
	}
	if sig, _ := readSig(strings.NewReader("a\x00b")); !sig.binary {
		t.Error("NUL byte not detected as binary")
	}
}

// testRepo creates a repository with one committed file, one modified file, and one untracked file.
func testRepo(t *testing.T) *App {
	t.Helper()
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not installed")
	}
	dir := t.TempDir()
	run := func(args ...string) {
		cmd := exec.Command("git", append([]string{"-c", "commit.gpgsign=false", "-c", "user.name=t", "-c", "user.email=t@t"}, args...)...)
		cmd.Dir = dir
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, out)
		}
	}
	write := func(name, content string) {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	run("init", "-q")
	write("keep.txt", "one\ntwo\n")
	run("add", ".")
	run("commit", "-q", "-m", "init")
	write("keep.txt", "one\n2\nthree\n")
	write("agent.txt", "made by an agent\n")
	return newApp(dir, 7777)
}

func TestGitStatusChanges(t *testing.T) {
	a := testRepo(t)
	s := a.gitStatus()
	if !s.Git || len(s.Changes) != 2 {
		t.Fatalf("status = %+v", s)
	}
	byPath := map[string]Change{}
	for _, c := range s.Changes {
		byPath[c.Path] = c
	}
	if c := byPath["keep.txt"]; c.Added != 2 || c.Deleted != 1 || c.Hash == "" {
		t.Errorf("keep.txt = %+v", c)
	}
	if c := byPath["agent.txt"]; c.Code != "??" || c.Added != 1 {
		t.Errorf("agent.txt = %+v", c)
	}
}

func request(a *App, method, url, body string) *httptest.ResponseRecorder {
	r := httptest.NewRequest(method, url, strings.NewReader(body))
	r.Host = "127.0.0.1:7777"
	r.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	a.routes().ServeHTTP(w, r)
	return w
}

func TestDiffIncludesUntracked(t *testing.T) {
	a := testRepo(t)
	w := request(a, "GET", "/api/diff?scope=head", "")
	if w.Code != 200 || !strings.Contains(w.Body.String(), "+++ b/agent.txt") {
		t.Errorf("diff missing untracked file: %d %s", w.Code, w.Body)
	}
	if w := request(a, "GET", "/api/diff?scope=range&from=--output=x&to=HEAD", ""); w.Code != 400 {
		t.Errorf("option-like ref accepted: %d", w.Code)
	}
}

func TestFileRev(t *testing.T) {
	a := testRepo(t)
	stage := exec.Command("git", "add", "keep.txt")
	stage.Dir = a.root
	if out, err := stage.CombinedOutput(); err != nil {
		t.Fatalf("git add: %v\n%s", err, out)
	}
	_ = os.WriteFile(filepath.Join(a.root, "keep.txt"), []byte("on disk\n"), 0o644)
	cases := map[string]struct {
		path, rev, want string
		exists          bool
	}{
		"head":          {"keep.txt", "head", "one\ntwo\n", true},
		"index":         {"keep.txt", "index", "one\n2\nthree\n", true},
		"untracked":     {"agent.txt", "head", "", false},
		"unknown rev":   {"keep.txt", "HEAD~1", "", false},
		"escaping path": {"../x", "head", "", false},
	}
	for name, c := range cases {
		w := request(a, "GET", "/api/file?path="+c.path+"&rev="+c.rev, "")
		if name == "unknown rev" || name == "escaping path" {
			if w.Code != http.StatusBadRequest {
				t.Errorf("%s: status %d, want 400", name, w.Code)
			}
			continue
		}
		var got struct {
			Exists  bool
			Content string
		}
		_ = json.Unmarshal(w.Body.Bytes(), &got)
		if got.Exists != c.exists || got.Content != c.want {
			t.Errorf("%s: got %+v, want %q exists=%v", name, got, c.want, c.exists)
		}
	}
}

func TestSaveRejectsStaleBase(t *testing.T) {
	a := testRepo(t)
	w := request(a, "GET", "/api/file?path=keep.txt", "")
	var file struct{ Hash string }
	_ = json.Unmarshal(w.Body.Bytes(), &file)

	// An agent edits the file after the tab was opened.
	_ = os.WriteFile(filepath.Join(a.root, "keep.txt"), []byte("agent edit\n"), 0o644)
	body, _ := json.Marshal(map[string]string{"path": "keep.txt", "content": "mine", "baseHash": file.Hash})
	if w := request(a, "POST", "/api/file", string(body)); w.Code != http.StatusConflict {
		t.Errorf("stale save status %d, want 409", w.Code)
	}
	body, _ = json.Marshal(map[string]string{"path": "keep.txt", "content": "mine"})
	if w := request(a, "POST", "/api/file", string(body)); w.Code != 200 {
		t.Errorf("forced save status %d", w.Code)
	}
}

func TestDiscardRemovesUntracked(t *testing.T) {
	a := testRepo(t)
	if _, err := a.discard([]string{"agent.txt", "keep.txt"}); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(a.root, "agent.txt")); !os.IsNotExist(err) {
		t.Error("untracked file survived discard")
	}
	if s := a.gitStatus(); len(s.Changes) != 0 {
		t.Errorf("changes after discard: %+v", s.Changes)
	}
}

func TestParseBranches(t *testing.T) {
	got := parseBranches("main\torigin/main\tahead 2, behind 3\nfeat\torigin/feat\tgone\nlocal\t\t\n")
	want := []Branch{
		{Name: "main", Upstream: "origin/main", Ahead: 2, Behind: 3},
		{Name: "feat", Upstream: "origin/feat", Gone: true},
		{Name: "local"},
	}
	if len(got) != len(want) {
		t.Fatalf("got %+v", got)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("branch %d = %+v, want %+v", i, got[i], want[i])
		}
	}
}

func TestPickRemote(t *testing.T) {
	for _, c := range []struct {
		in   []string
		want string
	}{{[]string{"upstream", "origin"}, "origin"}, {[]string{"fork"}, "fork"}, {nil, ""}, {[]string{"a", "b"}, ""}} {
		got, err := pickRemote(c.in)
		if got != c.want || (c.want == "") != (err != nil) {
			t.Errorf("pickRemote(%v) = %q, %v", c.in, got, err)
		}
	}
}

// TestPublishSyncFetch walks a branch through publish, one local commit (ahead 1), sync, and fetch.
func TestPublishSyncFetch(t *testing.T) {
	a := testRepo(t)
	bare := t.TempDir()
	run := func(dir string, args ...string) {
		cmd := exec.Command("git", append([]string{"-c", "commit.gpgsign=false", "-c", "user.name=t", "-c", "user.email=t@t"}, args...)...)
		cmd.Dir = dir
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, out)
		}
	}
	run(bare, "init", "-q", "--bare")
	run(a.root, "remote", "add", "origin", bare)
	act := func(action string) {
		if w := request(a, http.MethodPost, "/api/git", `{"action":"`+action+`"}`); w.Code != http.StatusOK {
			t.Fatalf("%s: %d %s", action, w.Code, w.Body)
		}
	}
	if s := a.gitStatus(); s.Tracking == nil || s.Tracking.Upstream != "" || s.FetchedAt != 0 {
		t.Fatalf("before publish: %+v", s.Tracking)
	}
	act("publish")
	run(a.root, "commit", "-qam", "local work")
	if tr := a.gitStatus().Tracking; tr == nil || tr.Upstream == "" || tr.Ahead != 1 || tr.Behind != 0 {
		t.Fatalf("after commit: %+v", tr)
	}
	act("sync")
	if tr := a.gitStatus().Tracking; tr.Ahead != 0 || tr.Behind != 0 {
		t.Fatalf("after sync: %+v", tr)
	}
	act("fetch")
	if s := a.gitStatus(); s.FetchedAt == 0 || len(s.Remotes) != 1 {
		t.Errorf("after fetch: fetchedAt=%d remotes=%v", s.FetchedAt, s.Remotes)
	}
}

func TestParseCommitDetail(t *testing.T) {
	d, ok := parseCommitDetail("abc\x00p1 p2\x00Ada\x00a@x\x0017\x00Bob\x0018\x00Subject line\n\nBody one\nBody two\n\n")
	if !ok || d.Subject != "Subject line" || d.Body != "Body one\nBody two" || len(d.Parents) != 2 || d.AuthorTime != 17 || d.Committer != "Bob" {
		t.Errorf("got %+v, %v", d, ok)
	}
	if d, _ := parseCommitDetail("abc\x00\x00A\x00e\x001\x00A\x001\x00Only subject\n"); d.Body != "" || len(d.Parents) != 0 {
		t.Errorf("root commit: %+v", d)
	}
}

func TestParseContains(t *testing.T) {
	got := parseContains("refs/heads/main\nrefs/remotes/origin/HEAD\nrefs/remotes/origin/main\nrefs/tags/v1\n")
	if strings.Join(got.Branches, ",") != "main" || strings.Join(got.Remotes, ",") != "origin/main" || strings.Join(got.Tags, ",") != "v1" {
		t.Errorf("got %+v", got)
	}
}

func TestCommitEndpoints(t *testing.T) {
	a := testRepo(t)
	run := func(args ...string) {
		cmd := exec.Command("git", append([]string{"-c", "commit.gpgsign=false", "-c", "user.name=t", "-c", "user.email=t@t"}, args...)...)
		cmd.Dir = a.root
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, out)
		}
	}
	run("add", ".")
	run("commit", "-qm", "Second\n\nWhy it changed.")
	run("tag", "v1")
	w := request(a, http.MethodGet, "/api/commit?hash=HEAD", "")
	var d CommitDetail
	if err := json.Unmarshal(w.Body.Bytes(), &d); err != nil || w.Code != http.StatusOK {
		t.Fatalf("%d %s", w.Code, w.Body)
	}
	byPath := map[string]Change{}
	for _, f := range d.Files {
		byPath[f.Path] = f
	}
	if d.Subject != "Second" || d.Body != "Why it changed." || len(d.Parents) != 1 || len(d.Files) != 2 {
		t.Fatalf("detail = %+v", d)
	}
	if f := byPath["agent.txt"]; f.Code != "A" || f.Added != 1 {
		t.Errorf("agent.txt = %+v", f)
	}
	if f := byPath["keep.txt"]; f.Code != "M" || f.Added != 2 || f.Deleted != 1 {
		t.Errorf("keep.txt = %+v", f)
	}
	var c Contains
	w = request(a, http.MethodGet, "/api/commit/contains?hash="+d.Hash, "")
	if err := json.Unmarshal(w.Body.Bytes(), &c); err != nil || len(c.Branches) != 1 || strings.Join(c.Tags, ",") != "v1" {
		t.Errorf("contains = %d %s", w.Code, w.Body)
	}
	for _, bad := range []string{"--all", "nope", ""} {
		if w := request(a, http.MethodGet, "/api/commit?hash="+bad, ""); w.Code != http.StatusBadRequest {
			t.Errorf("hash %q: %d", bad, w.Code)
		}
	}
}

// A merge lists the files it brought in relative to its first parent, like the commit diff.
func TestCommitMergeFiles(t *testing.T) {
	a := testRepo(t)
	run := func(args ...string) {
		cmd := exec.Command("git", append([]string{"-c", "commit.gpgsign=false", "-c", "user.name=t", "-c", "user.email=t@t"}, args...)...)
		cmd.Dir = a.root
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, out)
		}
	}
	run("stash", "-u")
	run("switch", "-qc", "side")
	os.WriteFile(filepath.Join(a.root, "side.txt"), []byte("s\n"), 0o644)
	run("add", ".")
	run("commit", "-qm", "side")
	run("switch", "-q", "-")
	run("merge", "-q", "--no-ff", "-m", "Merge side", "side")
	var d CommitDetail
	json.Unmarshal(request(a, http.MethodGet, "/api/commit?hash=HEAD", "").Body.Bytes(), &d)
	if len(d.Parents) != 2 || len(d.Files) != 1 || d.Files[0].Path != "side.txt" {
		t.Errorf("merge detail = %+v", d)
	}
}

func TestLogEndpoint(t *testing.T) {
	a := testRepo(t)
	run := func(args ...string) {
		cmd := exec.Command("git", append([]string{"-c", "commit.gpgsign=false", "-c", "user.name=t", "-c", "user.email=t@t"}, args...)...)
		cmd.Dir = a.root
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, out)
		}
	}
	run("add", ".")
	run("commit", "-qm", "Fix (parser)")
	run("switch", "-qc", "side")
	os.WriteFile(filepath.Join(a.root, "side.txt"), []byte("s\n"), 0o644)
	run("add", ".")
	run("commit", "-qm", "Side work")
	run("switch", "-q", "-")
	type page struct {
		Commits []Commit
		More    bool
	}
	get := func(query string) page {
		t.Helper()
		w := request(a, http.MethodGet, "/api/log?"+query, "")
		var p page
		if err := json.Unmarshal(w.Body.Bytes(), &p); err != nil || w.Code != http.StatusOK {
			t.Fatalf("%s: %d %s", query, w.Code, w.Body)
		}
		return p
	}
	subjects := func(p page) string {
		var s []string
		for _, c := range p.Commits {
			s = append(s, c.Subject)
		}
		return strings.Join(s, ",")
	}
	if got := subjects(get("")); got != "Side work,Fix (parser),init" {
		t.Errorf("all = %s", got)
	}
	if got := subjects(get("ref=HEAD")); got != "Fix (parser),init" {
		t.Errorf("HEAD = %s", got)
	}
	if p := get("limit=1"); len(p.Commits) != 1 || !p.More {
		t.Errorf("limit=1 = %+v", p)
	}
	if p := get("skip=2&limit=5"); subjects(p) != "init" || p.More {
		t.Errorf("skip = %+v", p)
	}
	if got := subjects(get("q=fix+(")); got != "Fix (parser)" {
		t.Errorf("literal grep = %s", got)
	}
	if got := subjects(get("path=side.txt")); got != "Side work" {
		t.Errorf("path = %s", got)
	}
	head := get("ref=HEAD").Commits[1]
	if p := get("q=" + head.Short); subjects(p) != "init" {
		t.Errorf("hash jump = %s", subjects(p))
	}
	if refs := get("").Commits[0].Refs; strings.Join(refs, ",") != "side" {
		t.Errorf("refs = %v", refs)
	}
	for _, bad := range []string{"ref=--all", "path=../x"} {
		if w := request(a, http.MethodGet, "/api/log?"+bad, ""); w.Code != http.StatusBadRequest {
			t.Errorf("%s: %d", bad, w.Code)
		}
	}
}
