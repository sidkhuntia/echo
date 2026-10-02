package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func writeFile(t *testing.T, a *App, name, content string) {
	t.Helper()
	p := filepath.Join(a.root, name)
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func readFile(t *testing.T, a *App, name string) string {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(a.root, name))
	if err != nil {
		return "<missing>"
	}
	return string(b)
}

func gitIn(t *testing.T, a *App, args ...string) string {
	t.Helper()
	out, err := a.gitCombined(append([]string{"-c", "commit.gpgsign=false", "-c", "user.name=t", "-c", "user.email=t@t"}, args...)...)
	if err != nil {
		t.Fatalf("git %v: %v\n%s", args, err, out)
	}
	return out
}

func post(t *testing.T, a *App, url string, v any) (int, string) {
	t.Helper()
	b, _ := json.Marshal(v)
	w := request(a, "POST", url, string(b))
	return w.Code, w.Body.String()
}

// A file named like a glob must be discarded alone: [id].tsx also matches i.tsx and d.tsx as a pattern.
func TestDiscardTreatsPathsLiterally(t *testing.T) {
	a := testRepo(t)
	for _, n := range []string{"app/[id].tsx", "app/i.tsx", "app/d.tsx"} {
		writeFile(t, a, n, "base\n")
	}
	gitIn(t, a, "add", "-A")
	gitIn(t, a, "commit", "-q", "-m", "routes")
	for _, n := range []string{"app/[id].tsx", "app/i.tsx", "app/d.tsx"} {
		writeFile(t, a, n, "edited\n")
	}
	if _, err := a.discard([]string{"app/[id].tsx"}, false); err != nil {
		t.Fatal(err)
	}
	if got := readFile(t, a, "app/[id].tsx"); got != "base\n" {
		t.Errorf("[id].tsx = %q, want it discarded", got)
	}
	for _, n := range []string{"app/i.tsx", "app/d.tsx"} {
		if got := readFile(t, a, n); got != "edited\n" {
			t.Errorf("%s = %q: a glob match discarded a file that was not asked for", n, got)
		}
	}
}

func TestDiscardCanBeRestored(t *testing.T) {
	a := testRepo(t) // keep.txt modified, agent.txt untracked
	if _, err := a.discard([]string{"agent.txt", "keep.txt"}, false); err != nil {
		t.Fatal(err)
	}
	if readFile(t, a, "agent.txt") != "<missing>" || readFile(t, a, "keep.txt") != "one\ntwo\n" {
		t.Fatal("discard did not discard")
	}
	if a.lastDiscard() == nil {
		t.Fatal("no snapshot recorded")
	}
	if _, err := a.restoreDiscard(); err != nil {
		t.Fatal(err)
	}
	if got := readFile(t, a, "agent.txt"); got != "made by an agent\n" {
		t.Errorf("agent.txt = %q after restore", got)
	}
	if got := readFile(t, a, "keep.txt"); got != "one\n2\nthree\n" {
		t.Errorf("keep.txt = %q after restore", got)
	}
	if a.lastDiscard() != nil {
		t.Error("restored snapshot should be gone")
	}
	if _, err := a.restoreDiscard(); err == nil {
		t.Error("restoring with nothing saved should fail")
	}
}

func TestSnapshotsArePruned(t *testing.T) {
	a := testRepo(t)
	for i := 0; i < discardKeep+3; i++ {
		if _, err := a.snapshotPaths([]string{"agent.txt"}); err != nil {
			t.Fatal(err)
		}
	}
	if got := a.lastDiscard().Count; got != discardKeep {
		t.Errorf("kept %d snapshots, want %d", got, discardKeep)
	}
}

func TestCreateAndRenameNeverOverwrite(t *testing.T) {
	a := testRepo(t)
	writeFile(t, a, "a.txt", "A")
	writeFile(t, a, "b.txt", "B")
	if code, _ := post(t, a, "/api/file", map[string]string{"action": "create", "path": "a.txt", "content": "new"}); code != http.StatusConflict {
		t.Errorf("create over existing: %d, want 409", code)
	}
	if code, _ := post(t, a, "/api/file", map[string]string{"action": "rename", "path": "a.txt", "newPath": "b.txt"}); code != http.StatusConflict {
		t.Errorf("rename over existing: %d, want 409", code)
	}
	if readFile(t, a, "a.txt") != "A" || readFile(t, a, "b.txt") != "B" {
		t.Error("a refused create or rename changed a file")
	}
	if code, _ := post(t, a, "/api/file", map[string]string{"action": "rename", "path": "a.txt", "newPath": "c.txt"}); code != 200 {
		t.Errorf("plain rename: %d", code)
	}
	if code, _ := post(t, a, "/api/file", map[string]string{"action": "duplicate", "path": "c.txt", "newPath": "d.txt"}); code != 200 || readFile(t, a, "d.txt") != "A" {
		t.Errorf("duplicate: %d %q", code, readFile(t, a, "d.txt"))
	}
}

func TestSaveIsAtomicAndKeepsMode(t *testing.T) {
	a := testRepo(t)
	writeFile(t, a, "run.sh", "echo 1\n")
	if err := os.Chmod(filepath.Join(a.root, "run.sh"), 0o755); err != nil {
		t.Fatal(err)
	}
	w := request(a, "GET", "/api/file?path=run.sh", "")
	var f struct{ Hash string }
	_ = json.Unmarshal(w.Body.Bytes(), &f)
	if code, body := post(t, a, "/api/file", map[string]string{"path": "run.sh", "content": "echo 2\n", "baseHash": f.Hash}); code != 200 {
		t.Fatalf("save: %d %s", code, body)
	}
	info, _ := os.Stat(filepath.Join(a.root, "run.sh"))
	if info.Mode().Perm() != 0o755 {
		t.Errorf("mode = %v, want 755", info.Mode().Perm())
	}
	entries, _ := os.ReadDir(a.root)
	for _, e := range entries {
		if strings.HasPrefix(e.Name(), ".echo-save-") {
			t.Errorf("temp file %s left behind", e.Name())
		}
	}
	// A new file needs no base hash.
	if code, _ := post(t, a, "/api/file", map[string]string{"path": "fresh.txt", "content": "x"}); code != 200 {
		t.Errorf("saving a new file: %d", code)
	}
}

func TestLargeFilesAreNotLoaded(t *testing.T) {
	a := testRepo(t)
	big := make([]byte, maxFileRead+1)
	if err := os.WriteFile(filepath.Join(a.root, "big.log"), big, 0o644); err != nil {
		t.Fatal(err)
	}
	var got struct {
		TooLarge bool
		Content  string
	}
	_ = json.Unmarshal(request(a, "GET", "/api/file?path=big.log", "").Body.Bytes(), &got)
	if !got.TooLarge || got.Content != "" {
		t.Errorf("large file response = %+v", got)
	}
}

func TestGitDirCannotBeRead(t *testing.T) {
	a := testRepo(t)
	for _, p := range []string{"/api/file?path=.git/config", "/api/raw?path=.git/config", "/api/file?path=.GIT/config"} {
		if w := request(a, "GET", p, ""); w.Code != http.StatusBadRequest {
			t.Errorf("%s: %d, want 400", p, w.Code)
		}
	}
}

func TestTokenGuardsTheAPI(t *testing.T) {
	a := testRepo(t)
	a.token = "s3cret-s3cret-s3cret-s3cret-s3cret"
	do := func(path string, mutate func(*http.Request)) *httptest.ResponseRecorder {
		r := httptest.NewRequest("GET", path, nil)
		r.Host = "127.0.0.1:6030"
		if mutate != nil {
			mutate(r)
		}
		w := httptest.NewRecorder()
		a.routes().ServeHTTP(w, r)
		return w
	}
	if w := do("/api/tree", nil); w.Code != http.StatusUnauthorized {
		t.Errorf("no token: %d, want 401", w.Code)
	}
	if w := do("/", nil); w.Code != http.StatusUnauthorized {
		t.Errorf("page without token: %d, want 401", w.Code)
	}
	if w := do("/api/tree", func(r *http.Request) { r.Header.Set(tokenHeader, "wrong") }); w.Code != http.StatusUnauthorized {
		t.Errorf("wrong token: %d, want 401", w.Code)
	}
	if w := do("/api/tree", func(r *http.Request) { r.Header.Set(tokenHeader, a.token) }); w.Code != 200 {
		t.Errorf("header token: %d, want 200", w.Code)
	}
	w := do("/?t="+a.token, nil)
	if w.Code != http.StatusSeeOther || !strings.Contains(w.Header().Get("Set-Cookie"), tokenCookie+"="+a.token) || !strings.Contains(w.Header().Get("Set-Cookie"), "HttpOnly") {
		t.Errorf("token link: %d %q", w.Code, w.Header().Get("Set-Cookie"))
	}
	if w := do("/api/tree", func(r *http.Request) { r.AddCookie(&http.Cookie{Name: tokenCookie, Value: a.token}) }); w.Code != 200 {
		t.Errorf("cookie token: %d, want 200", w.Code)
	}
	// A rebinding host is refused before the token is even looked at.
	if w := do("/api/tree", func(r *http.Request) { r.Host = "evil.example:6030"; r.Header.Set(tokenHeader, a.token) }); w.Code != http.StatusForbidden {
		t.Errorf("foreign host: %d, want 403", w.Code)
	}
}

func TestLoadTokenIsStable(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	first := loadToken()
	if len(first) < 32 || loadToken() != first {
		t.Errorf("token %q is not stable across loads", first)
	}
	info, err := os.Stat(filepath.Join(filepath.Dir(configPath()), "token"))
	if err != nil || info.Mode().Perm() != 0o600 {
		t.Errorf("token file: %v %v", info, err)
	}
}

func TestStatusRefsAreCachedUntilRefsMove(t *testing.T) {
	a := testRepo(t)
	first := a.gitStatus()
	if len(first.Local) == 0 {
		t.Fatal("no local branches")
	}
	stamp := a.refs.stamp
	if stamp == "" {
		t.Fatal("no refs stamp for a normal repository")
	}
	if a.gitStatus(); a.refs.stamp != stamp {
		t.Error("stamp changed with no ref change")
	}
	gitIn(t, a, "branch", "topic")
	st := a.gitStatus()
	found := false
	for _, b := range st.Local {
		found = found || b.Name == "topic"
	}
	if !found || a.refs.stamp == stamp {
		t.Errorf("new branch not noticed: %+v", st.Local)
	}
}

func TestStatusHubSharesOnePoller(t *testing.T) {
	a := testRepo(t)
	a.done = make(chan struct{})
	c1, c2 := a.hub.subscribe(a), a.hub.subscribe(a)
	for i, c := range []chan []byte{c1, c2} {
		select {
		case b := <-c:
			if !strings.Contains(string(b), `"branch":"main"`) {
				t.Errorf("subscriber %d got %s", i, b)
			}
		case <-time.After(5 * time.Second):
			t.Fatalf("subscriber %d got nothing", i)
		}
	}
	a.hub.unsubscribe(c1)
	if a.hub.stop == nil {
		t.Error("poller stopped with a subscriber left")
	}
	a.hub.unsubscribe(c2)
	if a.hub.stop != nil || len(a.hub.subs) != 0 {
		t.Error("poller still running with no subscribers")
	}
}

func TestSigCacheIsPruned(t *testing.T) {
	a := testRepo(t)
	a.gitStatus()
	if len(a.sigs) != 2 {
		t.Fatalf("sigs = %d, want 2", len(a.sigs))
	}
	_, _ = a.discard([]string{"agent.txt", "keep.txt"}, false)
	a.gitStatus()
	if len(a.sigs) != 0 {
		t.Errorf("sigs = %d after changes cleared", len(a.sigs))
	}
}

func TestConfigRejectsJunk(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	a := newApp(t.TempDir(), 6030)
	for _, body := range []string{`{"theme":"../../x"}`, `{"diffMode":"sideways"}`, `{"panelSizes":{"tree":99999}}`, `{"gutterBase":"x"}`} {
		if w := request(a, "POST", "/api/config", body); w.Code != 400 {
			t.Errorf("%s: %d, want 400", body, w.Code)
		}
	}
}
