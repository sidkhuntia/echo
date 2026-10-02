package main

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
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
