package main

import (
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"testing"
	"time"
	"unicode/utf8"
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
	a := newApp(t.TempDir(), 6030)
	h := a.routes()
	cases := []struct {
		name, method, host, origin, ctype string
		want                              int
	}{
		{"own page", "GET", "127.0.0.1:6030", "", "", 200},
		{"rebinding host", "GET", "evil.example:6030", "", "", 403},
		{"cross-site write", "POST", "127.0.0.1:6030", "http://evil.example", "application/json", 403},
		{"simple form post", "POST", "127.0.0.1:6030", "", "text/plain", 415},
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
	return newApp(dir, 6030)
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

// A partly staged file reports both sides with their own line counts, and an untracked file only the unstaged side.
func TestGitStatusSplitsStagedAndUnstaged(t *testing.T) {
	a := testRepo(t)
	if _, err := a.gitCombined("add", "--", "keep.txt"); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(a.root, "keep.txt"), []byte("one\n2\nthree\nfour\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	byPath := map[string]Change{}
	for _, c := range a.gitStatus().Changes {
		byPath[c.Path] = c
	}
	keep := byPath["keep.txt"]
	if keep.Index == nil || keep.Index.Added != 2 || keep.Index.Deleted != 1 {
		t.Errorf("keep.txt index = %+v", keep.Index)
	}
	if keep.Work == nil || keep.Work.Added != 1 || keep.Work.Deleted != 0 {
		t.Errorf("keep.txt work = %+v", keep.Work)
	}
	if agent := byPath["agent.txt"]; agent.Index != nil || agent.Work == nil || agent.Work.Added != 1 {
		t.Errorf("agent.txt = %+v", agent)
	}
}

// Discarding from the unstaged list keeps what was staged.
func TestDiscardWorktreeKeepsStaged(t *testing.T) {
	a := testRepo(t)
	if _, err := a.gitCombined("add", "--", "keep.txt"); err != nil {
		t.Fatal(err)
	}
	os.WriteFile(filepath.Join(a.root, "keep.txt"), []byte("scratch\n"), 0o644)
	if _, err := a.discard([]string{"keep.txt"}, true); err != nil {
		t.Fatal(err)
	}
	if b, _ := os.ReadFile(filepath.Join(a.root, "keep.txt")); string(b) != "one\n2\nthree\n" {
		t.Errorf("keep.txt = %q, want the staged content", b)
	}
	for _, c := range a.gitStatus().Changes {
		if c.Path == "keep.txt" && (c.Index == nil || c.Work != nil) {
			t.Errorf("keep.txt = %+v, want staged only", c)
		}
	}
}

func TestTreeSkipsIgnoredFiles(t *testing.T) {
	a := testRepo(t)
	for name, content := range map[string]string{".gitignore": "data/\n", "data/blob.bin": "x", "src/Main.java": "class Main {}\n"} {
		os.MkdirAll(filepath.Join(a.root, filepath.Dir(name)), 0o755)
		if err := os.WriteFile(filepath.Join(a.root, name), []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	var got []string
	for _, n := range a.tree() {
		got = append(got, n.Path)
	}
	if want := "agent.txt keep.txt src/Main.java"; strings.Join(got, " ") != want {
		t.Errorf("tree = %v, want %s", got, want)
	}
}

func request(a *App, method, url, body string) *httptest.ResponseRecorder {
	r := httptest.NewRequest(method, url, strings.NewReader(body))
	r.Host = "127.0.0.1:6030"
	r.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	a.routes().ServeHTTP(w, r)
	return w
}

// requestOn is request for an app that is listening on a port of its own, so the Host matches
// what the guard admits.
func requestOn(a *App, method, url, body string) *httptest.ResponseRecorder {
	r := httptest.NewRequest(method, url, strings.NewReader(body))
	r.Host = "127.0.0.1:" + strconv.Itoa(a.port)
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
	if _, err := a.discard([]string{"agent.txt", "keep.txt"}, false); err != nil {
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
		w := request(a, http.MethodGet, "/api/history?"+query, "")
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
		if w := request(a, http.MethodGet, "/api/history?"+bad, ""); w.Code != http.StatusBadRequest {
			t.Errorf("%s: %d", bad, w.Code)
		}
	}
}

func TestBranchActions(t *testing.T) {
	a := testRepo(t)
	run := func(args ...string) string {
		cmd := exec.Command("git", append([]string{"-c", "commit.gpgsign=false", "-c", "user.name=t", "-c", "user.email=t@t"}, args...)...)
		cmd.Dir = a.root
		out, err := cmd.CombinedOutput()
		if err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, out)
		}
		return strings.TrimSpace(string(out))
	}
	act := func(body string, want int) {
		t.Helper()
		if w := request(a, http.MethodPost, "/api/git", body); w.Code != want {
			t.Fatalf("%s: %d %s", body, w.Code, w.Body)
		}
	}
	run("stash", "-u")
	run("tag", "v1")
	first := run("rev-parse", "HEAD")
	run("commit", "-q", "--allow-empty", "-m", "second")
	act(`{"action":"branch:create","from":"old","to":"v1"}`, http.StatusOK)
	if got := run("rev-parse", "HEAD"); got != first || run("branch", "--show-current") != "old" {
		t.Errorf("branch from v1: HEAD=%s branch=%s", got, run("branch", "--show-current"))
	}
	act(`{"action":"branch:detach","from":"v1"}`, http.StatusOK)
	if run("branch", "--show-current") != "" {
		t.Error("detach left a branch checked out")
	}
	act(`{"action":"branch:delete","from":"old"}`, http.StatusOK)
	if s := a.gitStatus(); len(s.Tags) != 1 || s.Tags[0] != "v1" || len(s.Local) != 1 {
		t.Errorf("after delete: tags=%v local=%+v", s.Tags, s.Local)
	}
	act(`{"action":"branch:create","from":"x","to":"--orphan"}`, http.StatusBadRequest)
	act(`{"action":"branch:delete","from":"-D"}`, http.StatusBadRequest)
}

// Dropping a stash removes it from the list, and dropping by the ref the status reported works even
// though the refs renumber themselves after every drop.
func TestStashDrop(t *testing.T) {
	a := testRepo(t)
	if _, err := a.gitCombined("stash", "push", "-u", "-m", "first"); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(a.root, "agent.txt"), []byte("more\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := a.gitCombined("stash", "push", "-u", "-m", "second"); err != nil {
		t.Fatal(err)
	}
	s := a.gitStatus()
	if len(s.Stashes) != 2 || s.Stashes[0].Ref != "stash@{0}" || s.Stashes[0].Subject != "On main: second" {
		t.Fatalf("stashes = %+v", s.Stashes)
	}
	// The top stash is stash@{0}; dropping it must leave the one that was underneath.
	if w := request(a, http.MethodPost, "/api/git", `{"action":"stash:drop","stashRef":"stash@{0}"}`); w.Code != http.StatusOK {
		t.Fatalf("drop: %d %s", w.Code, w.Body)
	}
	s = a.gitStatus()
	if len(s.Stashes) != 1 || !strings.Contains(s.Stashes[0].Subject, "first") {
		t.Errorf("after drop: %+v", s.Stashes)
	}
	if w := request(a, http.MethodPost, "/api/git", `{"action":"stash:drop","stashRef":"--index"}`); w.Code != http.StatusBadRequest {
		t.Errorf("option ref: %d %s", w.Code, w.Body)
	}
}

func TestBlameFollowsEditorText(t *testing.T) {
	a := testRepo(t)
	run := func(args ...string) {
		cmd := exec.Command("git", append([]string{"-c", "commit.gpgsign=false", "-c", "user.name=Ada", "-c", "user.email=t@t"}, args...)...)
		cmd.Dir = a.root
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, out)
		}
	}
	run("checkout", "-q", "--", "keep.txt")
	// The editor holds "one\ntwo\n" plus an unsaved third line.
	w := request(a, http.MethodPost, "/api/blame", `{"path":"keep.txt","content":"one\ntwo\nunsaved\n"}`)
	var b Blame
	if err := json.Unmarshal(w.Body.Bytes(), &b); err != nil || w.Code != http.StatusOK {
		t.Fatalf("%d %s", w.Code, w.Body)
	}
	if len(b.Lines) != 3 || b.Lines[0] != b.Lines[1] {
		t.Fatalf("blame = %+v", b)
	}
	if c := b.Commits[b.Lines[0]]; c.Summary != "init" || c.Time == 0 {
		t.Errorf("committed line = %+v", c)
	}
	if c := b.Commits[b.Lines[2]]; strings.Trim(c.Hash, "0") != "" {
		t.Errorf("unsaved line = %+v, want the zero hash", c)
	}
	w = request(a, http.MethodPost, "/api/blame", `{"path":"agent.txt","content":"x\n"}`)
	if w.Code != http.StatusOK || !strings.Contains(w.Body.String(), `"lines":[]`) {
		t.Errorf("untracked: %d %s", w.Code, w.Body)
	}
	if w := request(a, http.MethodPost, "/api/blame", `{"path":"../x","content":""}`); w.Code != http.StatusBadRequest {
		t.Errorf("escape: %d", w.Code)
	}
}

func TestFileHistoryFollowsRenames(t *testing.T) {
	a := testRepo(t)
	run := func(args ...string) {
		cmd := exec.Command("git", append([]string{"-c", "commit.gpgsign=false", "-c", "user.name=t", "-c", "user.email=t@t"}, args...)...)
		cmd.Dir = a.root
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, out)
		}
	}
	run("stash", "-u")
	run("mv", "keep.txt", "kept.txt")
	run("commit", "-qm", "rename")
	var p struct{ Commits []Commit }
	json.Unmarshal(request(a, http.MethodGet, "/api/history?ref=HEAD&path=kept.txt", "").Body.Bytes(), &p)
	if len(p.Commits) != 2 || p.Commits[1].Subject != "init" {
		t.Errorf("history of kept.txt = %+v", p.Commits)
	}
}

func TestRangeDiffFromMergeBase(t *testing.T) {
	a := testRepo(t)
	run := func(args ...string) {
		cmd := exec.Command("git", append([]string{"-c", "commit.gpgsign=false", "-c", "user.name=t", "-c", "user.email=t@t"}, args...)...)
		cmd.Dir = a.root
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, out)
		}
	}
	run("stash", "-u")
	run("branch", "side")
	base := strings.TrimSpace(must(a.git("branch", "--show-current")))
	os.WriteFile(filepath.Join(a.root, "main-only.txt"), []byte("m\n"), 0o644)
	run("add", ".")
	run("commit", "-qm", "main moves on")
	run("switch", "-q", "side")
	os.WriteFile(filepath.Join(a.root, "side-only.txt"), []byte("s\n"), 0o644)
	run("add", ".")
	run("commit", "-qm", "side work")
	diff := func(dots string) string {
		return request(a, http.MethodGet, "/api/diff?scope=range&from="+base+"&to=side&dots="+dots, "").Body.String()
	}
	if d := diff("3"); strings.Contains(d, "main-only.txt") || !strings.Contains(d, "side-only.txt") {
		t.Errorf("three-dot diff should show only side's work: %s", d)
	}
	if d := diff("2"); !strings.Contains(d, "main-only.txt") {
		t.Errorf("two-dot diff should compare tips: %s", d)
	}
}

func must(s string, err error) string {
	if err != nil {
		panic(err)
	}
	return s
}

func TestPortOrder(t *testing.T) {
	got := portOrder("/a", map[string]int{"/a": 6033, "/b": 6030, "/c": 6031})
	if got[0] != 6033 || got[1] != 6032 || got[len(got)-2] != 6030 || got[len(got)-1] != 6031 || len(got) != lastPort-firstPort+1 {
		t.Errorf("own port, then unclaimed, then claimed: %v", got)
	}
	if got := portOrder("/new", nil); got[0] != firstPort {
		t.Errorf("a new repository starts at %d: %v", firstPort, got)
	}
	if got := portOrder("/a", map[string]int{"/a": 7777}); got[0] != firstPort {
		t.Errorf("a remembered port outside the range is ignored: %v", got)
	}
}

func TestRememberPort(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	rememberPort("/a", 6030)
	rememberPort("/b", 6031)
	rememberPort("/c", 6030)
	got := loadPorts()
	if len(got) != 2 || got["/b"] != 6031 || got["/c"] != 6030 {
		t.Errorf("taking a port forgets its previous repository: %v", got)
	}
}

func TestConfigPostIsAPatch(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	a := newApp(t.TempDir(), 6030)
	if w := request(a, "POST", "/api/config", `{"theme":"nord"}`); w.Code != 200 {
		t.Fatalf("post theme: %d %s", w.Code, w.Body)
	}
	// Another process for another repository changes a different setting.
	b := newApp(t.TempDir(), 6030)
	if w := request(b, "POST", "/api/config", `{"vim":true}`); w.Code != 200 {
		t.Fatalf("post vim: %d %s", w.Code, w.Body)
	}
	if cfg := loadConfig(); cfg.Theme != "nord" || !cfg.Vim || cfg.DiffMode != "unified" {
		t.Errorf("patches from two processes merge: %+v", cfg)
	}
}

func TestConfigLayoutSettings(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	a := newApp(t.TempDir(), 6030)
	if w := request(a, "POST", "/api/config", `{"gitPinned":true,"swapPanels":true,"showRail":true}`); w.Code != 200 {
		t.Fatalf("post layout: %d %s", w.Code, w.Body)
	}
	if w := request(a, "POST", "/api/config", `{"theme":"one-dark"}`); w.Code != 200 {
		t.Fatalf("post theme: %d %s", w.Code, w.Body)
	}
	if cfg := loadConfig(); !cfg.GitPinned || !cfg.SwapPanels || !cfg.ShowRail || cfg.Theme != "one-dark" {
		t.Errorf("layout settings survive a later patch: %+v", cfg)
	}
}

func TestInstances(t *testing.T) {
	a := testRepo(t)
	ln, err := listen(a.root, 0)
	if err != nil {
		t.Skip("no free port in range:", err)
	}
	a.port = ln.Addr().(*net.TCPAddr).Port
	a.hosts = map[string]bool{"127.0.0.1:" + strconv.Itoa(a.port): true}
	go http.Serve(ln, a.routes())
	defer ln.Close()
	list := instances()
	if runningFor(a.root, list) != a.port {
		t.Fatalf("instances() = %+v, want %s on %d", list, a.root, a.port)
	}
	for _, in := range list {
		if in.Root == a.root && (in.Branch == "" || in.Changes != 2) {
			t.Errorf("instance reports branch and changes: %+v", in)
		}
	}
}

// fresh is a client that does not pool connections. A pooled one would keep talking to a server
// that a previous test left listening on the same port, which looks like a stop that did not work.
var fresh = &http.Client{Transport: &http.Transport{DisableKeepAlives: true}, Timeout: 2 * time.Second}

// serveTest starts a real listener for the app, the way main does, and returns its port.
func serveTest(t *testing.T, a *App) int {
	t.Helper()
	ln, err := listen(a.root, 0)
	if err != nil {
		t.Skip("no free port in range:", err)
	}
	a.port = ln.Addr().(*net.TCPAddr).Port
	a.hosts = map[string]bool{"127.0.0.1:" + strconv.Itoa(a.port): true}
	a.srv = &http.Server{Handler: a.routes()}
	go a.srv.Serve(ln)
	t.Cleanup(func() { _ = a.srv.Close() })
	return a.port
}

func stopVia(t *testing.T, port int) (int, string) {
	t.Helper()
	url := "http://127.0.0.1:" + strconv.Itoa(port) + "/api/shutdown"
	res, err := fresh.Post(url, "application/json", strings.NewReader("{}"))
	if err != nil {
		return 0, err.Error()
	}
	defer res.Body.Close()
	body, _ := io.ReadAll(res.Body)
	return res.StatusCode, string(body)
}

// gone waits for a port to stop answering.
func gone(port int) bool {
	res, err := fresh.Get("http://127.0.0.1:" + strconv.Itoa(port) + "/api/instance")
	if err != nil {
		return true
	}
	res.Body.Close()
	return false
}

func TestShutdownStopsThisServer(t *testing.T) {
	a := testRepo(t)
	port := serveTest(t, a)
	code, body := stopVia(t, port)
	if code != 200 || !strings.Contains(body, `"ok":true`) {
		t.Fatalf("stop = %d %s", code, body)
	}
	// The reply has to arrive before the server goes, or the page could never confirm the stop.
	for range 100 {
		if gone(port) {
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Error("the server is still answering after a stop")
}

func TestShutdownNeedsPostAndJSON(t *testing.T) {
	a := testRepo(t)
	serveTest(t, a)
	if w := requestOn(a, "GET", "/api/shutdown", ""); w.Code != 405 {
		t.Errorf("GET /api/shutdown = %d, want 405", w.Code)
	}
	if w := requestOn(a, "POST", "/api/shutdown", "nonsense"); w.Code != 400 {
		t.Errorf("bad body = %d, want 400", w.Code)
	}
	if w := requestOn(a, "POST", "/api/shutdown", `{"port":1}`); w.Code != 400 {
		t.Errorf("port outside the range = %d, want 400", w.Code)
	}
}

func TestShutdownHappensOnce(t *testing.T) {
	a := testRepo(t)
	port := serveTest(t, a)
	stopVia(t, port)
	// A second stop must be harmless, not a second shutdown; by now the port is closed, so a
	// handler that stopped twice would show up as a panic or a second drain.
	if code, _ := stopVia(t, port); code == 200 {
		t.Error("a stopped server answered a second stop")
	}
}

func TestShutdownStopsAnotherServer(t *testing.T) {
	other := testRepo(t)
	otherPort := serveTest(t, other)
	// The page asks its own process, which asks the sibling, so no cross-origin request is needed.
	if code, body := stopVia(t, otherPort); code != 200 {
		t.Fatalf("stop the sibling = %d %s", code, body)
	}
	for range 100 {
		if gone(otherPort) {
			// A port with nothing on it is a 404, so the page can say so instead of hanging.
			if code, _ := stopVia(t, otherPort); code != 0 {
				t.Errorf("stopping a dead port = %d, want no server", code)
			}
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Error("the sibling is still answering after a stop")
}

func TestShutdownQuitsOnlyNamedServers(t *testing.T) {
	a := testRepo(t)
	other := testRepo(t)
	otherPort := serveTest(t, other)
	port := serveTest(t, a)
	// Name the two servers this test started. The real ones on this machine are left alone, which
	// is the point: a "quit all" in the page means every echo, and a test must not mean that.
	a.running = func() []Instance { return []Instance{{Root: a.root, Port: port}, {Root: other.root, Port: otherPort}} }
	if w := requestOn(a, "POST", "/api/shutdown", `{"all":true}`); w.Code != 200 {
		t.Fatalf("quit all: %d %s", w.Code, w.Body)
	}
	for range 100 {
		if gone(port) && gone(otherPort) {
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Error("quitting all left a server answering")
}

func TestShutdownEndsTheStatusStream(t *testing.T) {
	a := testRepo(t)
	port := serveTest(t, a)
	// A browser tab holds the stream open forever, so it is what would stall a drain.
	streamed := make(chan struct{})
	go func() {
		defer close(streamed)
		res, err := fresh.Get("http://127.0.0.1:" + strconv.Itoa(port) + "/api/stream")
		if err == nil {
			_, _ = io.Copy(io.Discard, res.Body)
			res.Body.Close()
		}
	}()
	// Wait for the first heartbeat, so the stream is really open before the stop.
	deadline := time.Now().Add(5 * time.Second)
	for !gone0(port) && time.Now().Before(deadline) {
		time.Sleep(20 * time.Millisecond)
	}
	start := time.Now()
	a.shutdown("test")
	if d := time.Since(start); d > shutdownGrace {
		t.Errorf("shutdown took %v, longer than the %v grace", d, shutdownGrace)
	}
	select {
	case <-streamed:
	case <-time.After(2 * time.Second):
		t.Error("the status stream was still open after the stop")
	}
}

// gone0 reports whether a port has an echo on it yet; the stream test waits for one to appear.
func gone0(port int) bool { return !gone(port) }

func TestSearch(t *testing.T) {
	a := testRepo(t)
	_ = os.WriteFile(filepath.Join(a.root, ".gitignore"), []byte("ignored.txt\n"), 0o644)
	_ = os.WriteFile(filepath.Join(a.root, "ignored.txt"), []byte("made by an agent\n"), 0o644)
	search := func(query string) SearchResult {
		t.Helper()
		w := request(a, "GET", "/api/search?"+query, "")
		var res SearchResult
		if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &res) != nil {
			t.Fatalf("%s: %d %s", query, w.Code, w.Body)
		}
		return res
	}
	if res := search("q=AGENT"); len(res.Matches) != 1 || res.Matches[0] != (Match{Path: "agent.txt", Line: 1, Text: "made by an agent"}) {
		t.Errorf("untracked match or ignored file wrong: %+v", res.Matches)
	}
	if res := search("q=AGENT&case=1"); len(res.Matches) != 0 {
		t.Errorf("match case ignored: %+v", res.Matches)
	}
	if res := search("q=t.o&regex=1"); len(res.Matches) != 0 {
		t.Errorf("regex: %+v", res.Matches)
	}
	if res := search("q=th.ee&regex=1"); len(res.Matches) != 1 || res.Matches[0].Line != 3 {
		t.Errorf("regex line: %+v", res.Matches)
	}
	if w := request(a, "GET", "/api/search?q=a(&regex=1", ""); w.Code != 400 {
		t.Errorf("bad regex: %d", w.Code)
	}
	long := strings.Repeat("é", 300) + "needle" + strings.Repeat("x", 300)
	if s := snippet(long, strings.Index(long, "needle")); !utf8.ValidString(s) || !strings.Contains(s, "needle") || len(s) > 210 {
		t.Errorf("snippet: %q", s)
	}
}

func TestMermaidServedFromZip(t *testing.T) {
	a := &App{hosts: map[string]bool{"127.0.0.1:6030": true}}
	// The entry module and a chunk it draws on, both out of the archive rather than the binary.
	for _, name := range []string{"mermaid.esm.min.mjs", "chunks/mermaid.esm.min/abnfDiagram-DGLNOSUI.mjs"} {
		w := request(a, "GET", mermaidPrefix+name, "")
		if w.Code != 200 {
			t.Fatalf("%s: %d", name, w.Code)
		}
		// A module the browser refuses to run is the failure mode worth a test.
		if ct := w.Header().Get("Content-Type"); !strings.HasPrefix(ct, "text/javascript") {
			t.Errorf("%s: content type %q", name, ct)
		}
		if w.Body.Len() == 0 {
			t.Errorf("%s: empty", name)
		}
	}
	// Everything the entry imports has to be in the archive, or the first diagram never draws.
	entry := mermaidFiles["mermaid.esm.min.mjs"]
	if entry == nil {
		t.Fatal("mermaid entry missing from the archive")
	}
	rc, err := entry.Open()
	if err != nil {
		t.Fatal(err)
	}
	defer rc.Close()
	body, err := io.ReadAll(rc)
	if err != nil {
		t.Fatal(err)
	}
	missing := 0
	for _, m := range regexp.MustCompile(`(?:from|import)\s*"(\./[^"]+)"`).FindAllStringSubmatch(string(body), -1) {
		if _, ok := mermaidFiles[path.Clean(path.Join(".", m[1]))]; !ok {
			missing++
		}
	}
	if missing > 0 {
		t.Errorf("%d of the entry's imports are not in the archive", missing)
	}
	if w := request(a, "GET", mermaidPrefix+"../main.go", ""); w.Code == 200 {
		t.Error("path out of the archive was served")
	}
	if w := request(a, "GET", mermaidPrefix+"LICENSE", ""); w.Code != 200 {
		t.Errorf("license missing: %d", w.Code)
	}
}

// Stage-all-and-commit takes staged, unstaged and untracked work in one commit.
// A rewritten branch is refused by a plain push, accepted by a force push, and a lease refuses when
// the remote holds a commit that was never fetched.
func TestForcePush(t *testing.T) {
	a := testRepo(t)
	bare, other := t.TempDir(), t.TempDir()
	run := func(dir string, args ...string) string {
		cmd := exec.Command("git", append([]string{"-c", "commit.gpgsign=false", "-c", "user.name=t", "-c", "user.email=t@t"}, args...)...)
		cmd.Dir = dir
		out, err := cmd.CombinedOutput()
		if err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, out)
		}
		return string(out)
	}
	post := func(action string) *httptest.ResponseRecorder {
		return request(a, http.MethodPost, "/api/git", `{"action":"`+action+`"}`)
	}
	run(bare, "init", "-q", "--bare")
	run(a.root, "remote", "add", "origin", bare)
	if w := post("push:force"); w.Code == http.StatusOK || !strings.Contains(w.Body.String(), "Publish it first") {
		t.Fatalf("force push without upstream: %d %s", w.Code, w.Body)
	}
	run(a.root, "commit", "-qam", "one")
	if w := post("publish"); w.Code != http.StatusOK {
		t.Fatalf("publish: %d %s", w.Code, w.Body)
	}
	branch := strings.TrimSpace(run(a.root, "branch", "--show-current"))

	run(a.root, "commit", "-q", "--amend", "-m", "one, rewritten")
	if w := post("push"); w.Code == http.StatusOK {
		t.Fatal("plain push of a rewritten branch should be rejected")
	}
	// Someone else pushes to the branch; this clone has not fetched it.
	run(other, "clone", "-q", bare, ".")
	run(other, "commit", "-q", "--allow-empty", "-m", "theirs")
	run(other, "push", "-q", "origin", "HEAD:"+branch)
	if w := post("push:lease"); w.Code == http.StatusOK {
		t.Fatal("lease should refuse a remote that moved since the last fetch")
	}
	if w := post("push:force"); w.Code != http.StatusOK {
		t.Fatalf("force push: %d %s", w.Code, w.Body)
	}
	if got, want := strings.TrimSpace(run(bare, "rev-parse", branch)), strings.TrimSpace(run(a.root, "rev-parse", "HEAD")); got != want {
		t.Errorf("remote %s, want %s", got, want)
	}

	run(a.root, "commit", "-q", "--amend", "-m", "again")
	if w := post("push:lease"); w.Code != http.StatusOK {
		t.Fatalf("lease with an up-to-date tracking ref: %d %s", w.Code, w.Body)
	}
}

func TestCommitAllTakesEverything(t *testing.T) {
	a := testRepo(t)
	if _, err := a.commitAll("  "); err == nil {
		t.Error("empty message accepted")
	}
	for _, kv := range [][2]string{{"commit.gpgsign", "false"}, {"user.name", "t"}, {"user.email", "t@t"}} {
		if _, err := a.gitCombined("config", kv[0], kv[1]); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := a.commitAll("everything"); err != nil {
		t.Fatal(err)
	}
	if s := a.gitStatus(); len(s.Changes) != 0 {
		t.Errorf("changes left after commit-all: %+v", s.Changes)
	}
}

// Soft reset backs the branch up and leaves the undone work staged; it refuses anything that is not
// an earlier commit on the current branch.
func TestResetSoft(t *testing.T) {
	a := testRepo(t)
	run := func(args ...string) string {
		cmd := exec.Command("git", append([]string{"-c", "commit.gpgsign=false", "-c", "user.name=t", "-c", "user.email=t@t"}, args...)...)
		cmd.Dir = a.root
		out, err := cmd.CombinedOutput()
		if err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, out)
		}
		return strings.TrimSpace(string(out))
	}
	act := func(body string, want int) string {
		t.Helper()
		w := request(a, http.MethodPost, "/api/git", body)
		if w.Code != want {
			t.Fatalf("%s: %d %s", body, w.Code, w.Body)
		}
		return w.Body.String()
	}
	run("config", "commit.gpgsign", "false")
	run("config", "user.name", "t")
	run("config", "user.email", "t@t")
	main := run("branch", "--show-current")
	run("stash", "-u")
	base := run("rev-parse", "HEAD")
	for _, f := range []string{"one.txt", "two.txt"} {
		if err := os.WriteFile(filepath.Join(a.root, f), []byte(f+"\n"), 0o644); err != nil {
			t.Fatal(err)
		}
		run("add", f)
		run("commit", "-q", "-m", "add "+f)
	}
	head := run("rev-parse", "HEAD")
	act(`{"action":"reset:soft","from":"`+head+`"}`, http.StatusBadGateway)
	act(`{"action":"reset:soft","from":"--hard"}`, http.StatusBadGateway)
	if w := request(a, http.MethodGet, "/api/reset/preview?hash="+base, ""); w.Code != http.StatusOK || !strings.Contains(w.Body.String(), `"count":2`) {
		t.Fatalf("preview: %d %s", w.Code, w.Body)
	}
	act(`{"action":"reset:soft","from":"`+base+`"}`, http.StatusOK)
	if got := run("rev-parse", "HEAD"); got != base {
		t.Errorf("HEAD = %s, want %s", got, base)
	}
	if got := run("diff", "--cached", "--name-only"); got != "one.txt\ntwo.txt" {
		t.Errorf("staged after reset = %q", got)
	}
	// A commit that is not an ancestor (a side branch) is refused.
	run("switch", "-q", "-c", "side", head)
	run("switch", "-q", main)
	act(`{"action":"reset:soft","from":"side"}`, http.StatusBadGateway)
}

// Revert makes a new commit; a merge commit needs a mainline parent.
func TestRevert(t *testing.T) {
	a := testRepo(t)
	run := func(args ...string) string {
		cmd := exec.Command("git", append([]string{"-c", "commit.gpgsign=false", "-c", "user.name=t", "-c", "user.email=t@t"}, args...)...)
		cmd.Dir = a.root
		out, err := cmd.CombinedOutput()
		if err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, out)
		}
		return strings.TrimSpace(string(out))
	}
	act := func(body string, want int) {
		t.Helper()
		if w := request(a, http.MethodPost, "/api/git", body); w.Code != want {
			t.Fatalf("%s: %d %s", body, w.Code, w.Body)
		}
	}
	write := func(name, text string) {
		if err := os.WriteFile(filepath.Join(a.root, name), []byte(text), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	run("config", "commit.gpgsign", "false")
	run("config", "user.name", "t")
	run("config", "user.email", "t@t")
	main := run("branch", "--show-current")
	run("stash", "-u")
	write("a.txt", "a\n")
	run("add", "a.txt")
	run("commit", "-q", "-m", "add a")
	added := run("rev-parse", "HEAD")
	act(`{"action":"revert","from":"`+added+`"}`, http.StatusOK)
	if _, err := os.Stat(filepath.Join(a.root, "a.txt")); !os.IsNotExist(err) {
		t.Error("revert left a.txt behind")
	}
	if !strings.HasPrefix(run("log", "-1", "--format=%s"), "Revert") {
		t.Error("revert did not create a Revert commit")
	}
	// merge commit
	run("switch", "-q", "-c", "topic")
	write("b.txt", "b\n")
	run("add", "b.txt")
	run("commit", "-q", "-m", "add b")
	run("switch", "-q", main)
	run("merge", "-q", "--no-ff", "-m", "merge topic", "topic")
	merge := run("rev-parse", "HEAD")
	act(`{"action":"revert","from":"`+merge+`"}`, http.StatusBadGateway)
	act(`{"action":"revert","from":"`+merge+`","parent":3}`, http.StatusBadGateway)
	act(`{"action":"revert","from":"`+merge+`","parent":1}`, http.StatusOK)
	if _, err := os.Stat(filepath.Join(a.root, "b.txt")); !os.IsNotExist(err) {
		t.Error("reverting the merge kept b.txt")
	}
	// A conflicting revert stops in the reverting state and can be aborted.
	write("c.txt", "one\n")
	run("add", "c.txt")
	run("commit", "-q", "-m", "add c")
	first := run("rev-parse", "HEAD")
	write("c.txt", "two\n")
	run("commit", "-q", "-am", "edit c")
	act(`{"action":"revert","from":"`+first+`"}`, http.StatusBadGateway)
	if !a.gitStatus().Reverting {
		t.Fatal("status does not report the revert in progress")
	}
	act(`{"action":"reset:soft","from":"HEAD~1"}`, http.StatusBadGateway)
	act(`{"action":"revert:abort"}`, http.StatusOK)
	if a.gitStatus().Reverting {
		t.Error("abort left the revert in progress")
	}
}

func TestHunkHeadings(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	t.Setenv("XDG_CONFIG_HOME", "")
	a := testRepo(t)
	run := func(args ...string) {
		cmd := exec.Command("git", append([]string{"-c", "commit.gpgsign=false", "-c", "user.name=t", "-c", "user.email=t@t"}, args...)...)
		cmd.Dir = a.root
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, out)
		}
	}
	write := func(name, content string) {
		if err := os.WriteFile(filepath.Join(a.root, name), []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	lines := func(first string, n int) string {
		var b strings.Builder
		b.WriteString(first + "\n")
		for i := 0; i < n; i++ {
			b.WriteString("  line" + strconv.Itoa(i) + ": " + strconv.Itoa(i) + ";\n")
		}
		return b.String()
	}
	write("s.css", ".a { color: red; }\n\n"+lines(".b {", 8)+"}\n")
	write("d.md", "# Title\n\n## 16. Visual design\n\n- one\n- two\n- three\n- four\n- five\n- six\n")
	write("a.js", "const x = 1\n\nclass Desk {\n\tasync render() {}\n}\n\n\tconst clampWidth = (side, want) => {\n\t\tlet a = 1\n\t\tlet b = 2\n\t\tlet c = 3\n\t\tlet d = 4\n\t}\n")
	write("p.json", "{\n  \"name\": \"x\",\n  \"a\": 1,\n  \"b\": 2,\n  \"c\": 3,\n  \"d\": 4,\n  \"e\": 5\n}\n")
	run("add", ".")
	run("commit", "-q", "-m", "files")
	write("s.css", strings.Replace(".a { color: red; }\n\n"+lines(".b {", 8)+"}\n", "line7: 7", "line7: 70", 1))
	write("d.md", "# Title\n\n## 16. Visual design\n\n- one\n- two\n- three\n- four\n- five\n- seven\n")
	write("a.js", strings.Replace("const x = 1\n\nclass Desk {\n\tasync render() {}\n}\n\n\tconst clampWidth = (side, want) => {\n\t\tlet a = 1\n\t\tlet b = 2\n\t\tlet c = 3\n\t\tlet d = 4\n\t}\n", "let d = 4", "let d = 5", 1))
	write("p.json", strings.Replace("{\n  \"name\": \"x\",\n  \"a\": 1,\n  \"b\": 2,\n  \"c\": 3,\n  \"d\": 4,\n  \"e\": 5\n}\n", "\"e\": 5", "\"e\": 6", 1))
	w := request(a, "GET", "/api/diff?scope=head", "")
	var got struct{ Text string }
	if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
		t.Fatalf("diff: %d %s", w.Code, w.Body)
	}
	heads := map[string]string{}
	file := ""
	for _, l := range strings.Split(got.Text, "\n") {
		if strings.HasPrefix(l, "diff --git ") {
			file = l[strings.LastIndex(l, " b/")+3:]
		} else if strings.HasPrefix(l, "@@ ") && file != "" {
			heads[file] = strings.TrimSpace(l[strings.Index(l[2:], "@@")+4:])
		}
	}
	want := map[string]string{
		"s.css":    ".b {",
		"d.md":     "## 16. Visual design",
		"a.js":     "const clampWidth = (side, want) => {",
		"p.json":   "",
		"keep.txt": "",
	}
	for f, h := range want {
		if heads[f] != h {
			t.Errorf("%s heading = %q, want %q (all: %q)", f, heads[f], h, heads)
		}
	}
}

func TestGithubPRURL(t *testing.T) {
	for remote, want := range map[string]string{
		"git@github.com:o/r.git":       "https://github.com/o/r/pull/new/feat/x",
		"https://github.com/o/r":       "https://github.com/o/r/pull/new/feat/x",
		"ssh://git@github.com/o/r.git": "https://github.com/o/r/pull/new/feat/x",
		"git@gitlab.com:o/r.git":       "",
		"/tmp/bare.git":                "",
	} {
		if got := githubPRURL(remote, "feat/x"); got != want {
			t.Errorf("%s: got %q, want %q", remote, got, want)
		}
	}
}
