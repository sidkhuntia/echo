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
