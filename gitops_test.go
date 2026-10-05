package main

import (
	"encoding/json"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

// act posts one git action and fails the test unless it succeeds.
func act(t *testing.T, a *App, req map[string]any) string {
	t.Helper()
	code, body := post(t, a, "/api/git", req)
	if code != 200 {
		t.Fatalf("git %v: %d %s", req["action"], code, body)
	}
	return body
}

func actFails(t *testing.T, a *App, req map[string]any) string {
	t.Helper()
	code, body := post(t, a, "/api/git", req)
	if code == 200 {
		t.Fatalf("git %v succeeded, want failure: %s", req["action"], body)
	}
	return body
}

// commitFile writes a file and commits it, returning the new HEAD.
func commitFile(t *testing.T, a *App, name, content, msg string) string {
	t.Helper()
	writeFile(t, a, name, content)
	gitIn(t, a, "add", "--", name)
	gitIn(t, a, "commit", "-q", "-m", msg)
	return strings.TrimSpace(gitIn(t, a, "rev-parse", "HEAD"))
}

func cleanRepo(t *testing.T) *App {
	a := testRepo(t)
	_, _ = a.discard([]string{"agent.txt", "keep.txt"}, false)
	// The developer's global config may sign commits or lack an identity; the repository decides here.
	gitIn(t, a, "config", "commit.gpgsign", "false")
	gitIn(t, a, "config", "user.name", "t")
	gitIn(t, a, "config", "user.email", "t@t")
	return a
}

func TestApplyStagesPartOfANewFile(t *testing.T) {
	a := cleanRepo(t)
	writeFile(t, a, "new.txt", "l1\nl2\nl3\nl4\n")
	patch := "diff --git a/new.txt b/new.txt\nnew file mode 100644\n--- /dev/null\n+++ b/new.txt\n@@ -0,0 +1,2 @@\n+l1\n+l2\n"
	act(t, a, map[string]any{"action": "apply", "patch": patch, "target": "index"})
	if got := gitIn(t, a, "show", ":new.txt"); got != "l1\nl2\n" {
		t.Errorf("index has %q, want only the first two lines", got)
	}
	if got := readFile(t, a, "new.txt"); got != "l1\nl2\nl3\nl4\n" {
		t.Errorf("the working tree changed: %q", got)
	}
}

func TestApplyStageUnstageAndDiscardAHunk(t *testing.T) {
	a := cleanRepo(t)
	var base strings.Builder
	for i := 1; i <= 30; i++ {
		base.WriteString("line" + strings.Repeat("x", i%3) + "\n")
	}
	orig := base.String()
	commitFile(t, a, "f.txt", orig, "f")
	lines := strings.Split(orig, "\n")
	lines[2], lines[27] = "CHANGED-TOP", "CHANGED-BOTTOM"
	writeFile(t, a, "f.txt", strings.Join(lines, "\n"))
	diff := gitIn(t, a, "diff", "--no-color", "-U1", "--", "f.txt")
	hunks := strings.Split(diff, "\n@@")
	if len(hunks) != 3 {
		t.Fatalf("want two hunks, got %d:\n%s", len(hunks)-1, diff)
	}
	header := hunks[0]
	top := header + "\n@@" + hunks[1] + "\n"
	bottom := header + "\n@@" + hunks[2]
	// Stage only the top hunk.
	act(t, a, map[string]any{"action": "apply", "patch": top, "target": "index"})
	if c := gitIn(t, a, "diff", "--cached"); !strings.Contains(c, "CHANGED-TOP") || strings.Contains(c, "CHANGED-BOTTOM") {
		t.Errorf("cached diff:\n%s", c)
	}
	// Unstage it again.
	act(t, a, map[string]any{"action": "apply", "patch": top, "target": "index", "reverse": true})
	if c := gitIn(t, a, "diff", "--cached"); strings.TrimSpace(c) != "" {
		t.Errorf("still staged:\n%s", c)
	}
	// Discard the bottom hunk from the working tree; it is snapshotted first.
	act(t, a, map[string]any{"action": "apply", "patch": bottom, "target": "worktree", "reverse": true})
	got := readFile(t, a, "f.txt")
	if strings.Contains(got, "CHANGED-BOTTOM") || !strings.Contains(got, "CHANGED-TOP") {
		t.Errorf("after discarding the bottom hunk:\n%s", got)
	}
	if a.lastDiscard() == nil {
		t.Error("a hunk discard left no snapshot")
	}
	act(t, a, map[string]any{"action": "discard:restore"})
	if !strings.Contains(readFile(t, a, "f.txt"), "CHANGED-BOTTOM") {
		t.Error("restore did not bring the hunk back")
	}
}

func TestApplyRefusesBadPatches(t *testing.T) {
	a := cleanRepo(t)
	for name, patch := range map[string]string{
		"git dir":  "diff --git a/.git/hooks/x b/.git/hooks/x\nnew file mode 100755\n--- /dev/null\n+++ b/.git/hooks/x\n@@ -0,0 +1 @@\n+boom\n",
		"escape":   "diff --git a/../x b/../x\nnew file mode 100644\n--- /dev/null\n+++ b/../x\n@@ -0,0 +1 @@\n+x\n",
		"no files": "just text",
	} {
		actFails(t, a, map[string]any{"action": "apply", "patch": patch, "target": "index"})
		_ = name
	}
	actFails(t, a, map[string]any{"action": "apply", "patch": "diff --git a/k b/k\n", "target": "worktree"})
}

func TestUndoCommitKeepsChangesStaged(t *testing.T) {
	a := cleanRepo(t)
	commitFile(t, a, "u.txt", "u\n", "add u")
	act(t, a, map[string]any{"action": "undo:commit"})
	if got := strings.TrimSpace(gitIn(t, a, "log", "--format=%s", "-n", "1")); got != "init" {
		t.Errorf("HEAD is %q, want init", got)
	}
	if !strings.Contains(gitIn(t, a, "status", "--short"), "A  u.txt") {
		t.Error("the undone commit's file should be staged")
	}
}

func TestIntentToAddAndIgnore(t *testing.T) {
	a := cleanRepo(t)
	writeFile(t, a, "wip.txt", "x\n")
	act(t, a, map[string]any{"action": "add:intent", "paths": []string{"wip.txt"}})
	if !strings.Contains(gitIn(t, a, "status", "--short"), " A wip.txt") {
		t.Errorf("status: %s", gitIn(t, a, "status", "--short"))
	}
	writeFile(t, a, "dist/[a].js", "x")
	body := act(t, a, map[string]any{"action": "ignore", "paths": []string{"dist/[a].js", "dist"}})
	if !strings.Contains(body, "Added") {
		t.Errorf("ignore: %s", body)
	}
	if got := readFile(t, a, ".gitignore"); !strings.Contains(got, `/dist/\[a\].js`) || !strings.Contains(got, "/dist/\n") {
		t.Errorf(".gitignore = %q", got)
	}
	if body := act(t, a, map[string]any{"action": "ignore", "paths": []string{"dist"}}); !strings.Contains(body, "Already") {
		t.Errorf("second ignore: %s", body)
	}
}

func TestCommitTrailers(t *testing.T) {
	a := cleanRepo(t)
	gitIn(t, a, "config", "user.name", "Me")
	gitIn(t, a, "config", "user.email", "me@x")
	writeFile(t, a, "t.txt", "t\n")
	gitIn(t, a, "add", "t.txt")
	act(t, a, map[string]any{"action": "commit", "message": "with trailers", "signoff": true, "coAuthors": []string{"Ann Lee <ann@x.io>"}})
	msg := gitIn(t, a, "log", "-1", "--format=%B")
	if !strings.Contains(msg, "Signed-off-by: Me <me@x>") || !strings.Contains(msg, "Co-authored-by: Ann Lee <ann@x.io>") {
		t.Errorf("message:\n%s", msg)
	}
	actFails(t, a, map[string]any{"action": "commit", "message": "x", "coAuthors": []string{"not an address"}})
}

func TestAmendNoEditKeepsMessage(t *testing.T) {
	a := cleanRepo(t)
	commitFile(t, a, "m.txt", "1\n", "keep this message")
	writeFile(t, a, "m.txt", "2\n")
	gitIn(t, a, "add", "m.txt")
	act(t, a, map[string]any{"action": "amend:noedit"})
	if got := strings.TrimSpace(gitIn(t, a, "log", "-1", "--format=%s")); got != "keep this message" {
		t.Errorf("subject = %q", got)
	}
	if gitIn(t, a, "show", "HEAD:m.txt") != "2\n" {
		t.Error("amend did not take the staged change")
	}
}

func TestMergeOptionsAndAbort(t *testing.T) {
	a := cleanRepo(t)
	commitFile(t, a, "c.txt", "base\n", "c")
	gitIn(t, a, "switch", "-q", "-c", "side")
	commitFile(t, a, "c.txt", "side\n", "side change")
	gitIn(t, a, "switch", "-q", "main")
	commitFile(t, a, "c.txt", "main\n", "main change")
	actFails(t, a, map[string]any{"action": "merge", "from": "side"}) // conflict
	if st := a.gitStatus(); st.Operation != "merge" {
		t.Errorf("operation = %q, want merge", st.Operation)
	}
	conflict := false
	for _, c := range a.gitStatus().Changes {
		conflict = conflict || (c.Path == "c.txt" && c.Conflict)
	}
	if !conflict {
		t.Error("c.txt should be flagged as a conflict")
	}
	act(t, a, map[string]any{"action": "merge:abort"})
	if st := a.gitStatus(); st.Operation != "" {
		t.Errorf("operation after abort = %q", st.Operation)
	}
	// --no-ff makes a merge commit even when a fast-forward is possible.
	gitIn(t, a, "switch", "-q", "-c", "ff", "main")
	commitFile(t, a, "ff.txt", "x\n", "ff")
	gitIn(t, a, "switch", "-q", "main")
	act(t, a, map[string]any{"action": "merge", "from": "ff", "noff": true})
	if n := strings.Fields(gitIn(t, a, "rev-list", "--parents", "-n", "1", "HEAD")); len(n) != 3 {
		t.Errorf("expected a merge commit, parents = %v", n[1:])
	}
}

func TestCherryPickAndAbort(t *testing.T) {
	a := cleanRepo(t)
	commitFile(t, a, "p.txt", "base\n", "p")
	gitIn(t, a, "switch", "-q", "-c", "other")
	pick := commitFile(t, a, "p.txt", "other\n", "other edit")
	gitIn(t, a, "switch", "-q", "main")
	commitFile(t, a, "p.txt", "main\n", "main edit")
	actFails(t, a, map[string]any{"action": "cherry-pick", "from": pick})
	if st := a.gitStatus(); st.Operation != "cherry-pick" {
		t.Errorf("operation = %q", st.Operation)
	}
	act(t, a, map[string]any{"action": "cherry-pick:abort"})
	gitIn(t, a, "switch", "-q", "-c", "clean", "HEAD~1")
	act(t, a, map[string]any{"action": "cherry-pick", "from": pick})
	if got := strings.TrimSpace(gitIn(t, a, "log", "-1", "--format=%s")); got != "other edit" {
		t.Errorf("cherry-picked subject = %q", got)
	}
	actFails(t, a, map[string]any{"action": "cherry-pick", "from": "--exec=x"})
}

func TestInteractiveRebase(t *testing.T) {
	a := cleanRepo(t)
	base := strings.TrimSpace(gitIn(t, a, "rev-parse", "HEAD"))
	h1 := commitFile(t, a, "r1.txt", "1\n", "one")
	h2 := commitFile(t, a, "r2.txt", "2\n", "two")
	h3 := commitFile(t, a, "r3.txt", "3\n", "three")
	h4 := commitFile(t, a, "r4.txt", "4\n", "four")
	var plan []Commit
	w := request(a, "GET", "/api/rebase/plan?onto="+base, "")
	_ = json.Unmarshal(w.Body.Bytes(), &plan)
	if len(plan) != 4 || plan[0].Hash != h1 {
		t.Fatalf("plan = %+v", plan)
	}
	act(t, a, map[string]any{"action": "rebase:interactive", "from": base, "todo": []TodoItem{
		{Cmd: "reword", Hash: h1, Message: "ONE (reworded)"},
		{Cmd: "pick", Hash: h2},
		{Cmd: "fixup", Hash: h3},
		{Cmd: "drop", Hash: h4},
	}})
	subjects := strings.TrimSpace(gitIn(t, a, "log", "--format=%s", base+"..HEAD"))
	if subjects != "two\nONE (reworded)" {
		t.Errorf("subjects after rebase:\n%s", subjects)
	}
	if readFile(t, a, "r3.txt") != "3\n" || readFile(t, a, "r4.txt") != "<missing>" {
		t.Error("fixup should keep r3.txt and drop should remove r4.txt")
	}
	// An incomplete plan is refused.
	actFails(t, a, map[string]any{"action": "rebase:interactive", "from": base, "todo": []TodoItem{{Cmd: "pick", Hash: h2}}})
	_ = h4
}

func TestBranchRenameAndForceDelete(t *testing.T) {
	a := cleanRepo(t)
	gitIn(t, a, "switch", "-q", "-c", "old")
	commitFile(t, a, "b.txt", "b\n", "only on old")
	gitIn(t, a, "switch", "-q", "main")
	var un []Commit
	_ = json.Unmarshal(request(a, "GET", "/api/branch/unmerged?name=old", "").Body.Bytes(), &un)
	if len(un) != 1 || un[0].Subject != "only on old" {
		t.Errorf("unmerged = %+v", un)
	}
	actFails(t, a, map[string]any{"action": "branch:delete", "from": "old"})
	act(t, a, map[string]any{"action": "branch:rename", "from": "old", "to": "newer"})
	act(t, a, map[string]any{"action": "branch:delete:force", "from": "newer"})
	if strings.Contains(gitIn(t, a, "branch"), "newer") {
		t.Error("branch still exists")
	}
}

func TestStashSelectedFilesShowAndBranch(t *testing.T) {
	a := testRepo(t) // keep.txt modified, agent.txt untracked
	act(t, a, map[string]any{"action": "stash:create", "message": "just keep", "paths": []string{"keep.txt"}})
	if readFile(t, a, "keep.txt") != "one\ntwo\n" || readFile(t, a, "agent.txt") == "<missing>" {
		t.Error("only keep.txt should have been stashed")
	}
	var show struct{ Text string }
	_ = json.Unmarshal(request(a, "GET", "/api/stash?ref="+url.QueryEscape("stash@{0}"), "").Body.Bytes(), &show)
	if !strings.Contains(show.Text, "+three") {
		t.Errorf("stash show:\n%s", show.Text)
	}
	act(t, a, map[string]any{"action": "stash:branch", "stashRef": "stash@{0}", "to": "from-stash"})
	if strings.TrimSpace(gitIn(t, a, "branch", "--show-current")) != "from-stash" || readFile(t, a, "keep.txt") != "one\n2\nthree\n" {
		t.Error("stash branch did not check out the stashed work")
	}
}

func TestResetMixedAndHard(t *testing.T) {
	a := cleanRepo(t)
	first := strings.TrimSpace(gitIn(t, a, "rev-parse", "HEAD"))
	commitFile(t, a, "z.txt", "z\n", "z")
	act(t, a, map[string]any{"action": "reset:mixed", "from": first})
	if !strings.Contains(gitIn(t, a, "status", "--short"), "?? z.txt") {
		t.Errorf("mixed reset should leave z.txt untracked: %s", gitIn(t, a, "status", "--short"))
	}
	writeFile(t, a, "z.txt", "precious\n")
	act(t, a, map[string]any{"action": "reset:hard", "from": first})
	if a.lastDiscard() == nil {
		t.Fatal("hard reset left no snapshot")
	}
	act(t, a, map[string]any{"action": "discard:restore"})
	if readFile(t, a, "z.txt") != "precious\n" {
		t.Errorf("z.txt = %q after restore", readFile(t, a, "z.txt"))
	}
}

func TestRemoteActionsAreValidated(t *testing.T) {
	a := cleanRepo(t)
	act(t, a, map[string]any{"action": "remote:add", "from": "up", "url": "https://example.com/r.git"})
	act(t, a, map[string]any{"action": "remote:rename", "from": "up", "to": "upstream"})
	act(t, a, map[string]any{"action": "remote:seturl", "from": "upstream", "url": "https://example.com/other.git"})
	if !strings.Contains(gitIn(t, a, "remote", "-v"), "other.git") {
		t.Error("url not changed")
	}
	act(t, a, map[string]any{"action": "remote:remove", "from": "upstream"})
	for _, u := range []string{"ext::sh -c touch /tmp/pwned", "--upload-pack=x", "fd::3"} {
		actFails(t, a, map[string]any{"action": "remote:add", "from": "x", "url": u})
	}
	actFails(t, a, map[string]any{"action": "remote:add", "from": "-bad", "url": "https://x"})
}

func TestWorktreeAddListRemove(t *testing.T) {
	a := cleanRepo(t)
	dir := filepath.Join(t.TempDir(), "wt")
	act(t, a, map[string]any{"action": "worktree:add", "from": dir, "name": "wt-branch"})
	var list []Worktree
	_ = json.Unmarshal(request(a, "GET", "/api/worktrees", "").Body.Bytes(), &list)
	if len(list) != 2 || !list[0].Main || list[1].Branch != "wt-branch" {
		t.Errorf("worktrees = %+v", list)
	}
	act(t, a, map[string]any{"action": "worktree:remove", "from": dir})
	if _, err := os.Stat(dir); err == nil {
		t.Error("worktree directory still exists")
	}
}

func TestRestoreFileFromCommit(t *testing.T) {
	a := cleanRepo(t)
	first := commitFile(t, a, "h.txt", "v1\n", "v1")
	commitFile(t, a, "h.txt", "v2\n", "v2")
	act(t, a, map[string]any{"action": "restore:file", "from": first, "paths": []string{"h.txt"}})
	if readFile(t, a, "h.txt") != "v1\n" {
		t.Errorf("h.txt = %q", readFile(t, a, "h.txt"))
	}
	var at struct {
		Content string
		Exists  bool
	}
	_ = json.Unmarshal(request(a, "GET", "/api/file?path=h.txt&rev="+first, "").Body.Bytes(), &at)
	if !at.Exists || at.Content != "v1\n" {
		t.Errorf("file at rev = %+v", at)
	}
	if w := request(a, "GET", "/api/raw?path=h.txt&rev="+first, ""); w.Code != 200 || w.Body.String() != "v1\n" {
		t.Errorf("raw at rev: %d %q", w.Code, w.Body.String())
	}
}

func TestReflogCompareAndLogFilters(t *testing.T) {
	a := cleanRepo(t)
	base := strings.TrimSpace(gitIn(t, a, "rev-parse", "HEAD"))
	gitIn(t, a, "switch", "-q", "-c", "feat")
	commitFile(t, a, "q.txt", "q\n", "feature work")
	var refl []ReflogEntry
	_ = json.Unmarshal(request(a, "GET", "/api/reflog", "").Body.Bytes(), &refl)
	if len(refl) < 2 || !strings.Contains(refl[0].Subject, "feature work") {
		t.Errorf("reflog = %+v", refl)
	}
	var cmp struct {
		Commits []Commit
		Files   []Change
		Ahead   int
		Behind  int
	}
	_ = json.Unmarshal(request(a, "GET", "/api/compare?from=main&to=feat&dots=3", "").Body.Bytes(), &cmp)
	if len(cmp.Commits) != 1 || len(cmp.Files) != 1 || cmp.Ahead != 1 || cmp.Behind != 0 {
		t.Errorf("compare = %+v", cmp)
	}
	var lg struct{ Commits []Commit }
	_ = json.Unmarshal(request(a, "GET", "/api/history?merges=no&since=2000-01-01", "").Body.Bytes(), &lg)
	if len(lg.Commits) != 2 {
		t.Errorf("log = %d commits", len(lg.Commits))
	}
	if w := request(a, "GET", "/api/history?since=--output=x", ""); w.Code != http.StatusBadRequest {
		t.Errorf("bad date: %d", w.Code)
	}
	_ = base
}

func TestDiffContextPathAndRenames(t *testing.T) {
	a := cleanRepo(t)
	var b strings.Builder
	for i := 0; i < 40; i++ {
		b.WriteString("row\n")
	}
	commitFile(t, a, "big.txt", b.String(), "big")
	commitFile(t, a, "other.txt", "o\n", "other")
	lines := strings.Split(b.String(), "\n")
	lines[20] = "EDIT"
	writeFile(t, a, "big.txt", strings.Join(lines, "\n"))
	writeFile(t, a, "other.txt", "o2\n")
	var d struct{ Text string }
	_ = json.Unmarshal(request(a, "GET", "/api/diff?scope=head&path=big.txt&context=1000", "").Body.Bytes(), &d)
	if strings.Contains(d.Text, "other.txt") || strings.Count(d.Text, "\n row") < 30 {
		t.Errorf("one file with whole-file context expected:\n%s", d.Text)
	}
	gitIn(t, a, "checkout", "--", ".")
	gitIn(t, a, "mv", "big.txt", "huge.txt")
	_ = json.Unmarshal(request(a, "GET", "/api/diff?scope=staged&renames=1", "").Body.Bytes(), &d)
	if !strings.Contains(d.Text, "rename from big.txt") {
		t.Errorf("renames=1 should detect the rename:\n%s", d.Text)
	}
}

func TestCommitTemplateAndStores(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	a := cleanRepo(t)
	writeFile(t, a, ".gitmsg", "type(scope): subject\n")
	gitIn(t, a, "config", "commit.template", ".gitmsg")
	var tpl struct{ Template string }
	_ = json.Unmarshal(request(a, "GET", "/api/git/template", "").Body.Bytes(), &tpl)
	if tpl.Template != "type(scope): subject\n" {
		t.Errorf("template = %q", tpl.Template)
	}
	for _, kind := range []string{"review", "drafts"} {
		if code, _ := post(t, a, "/api/"+kind, map[string]any{"notes": []string{"a"}}); code != 200 {
			t.Fatalf("%s POST: %d", kind, code)
		}
		if body := request(a, "GET", "/api/"+kind, "").Body.String(); !strings.Contains(body, `"notes"`) {
			t.Errorf("%s GET: %s", kind, body)
		}
	}
	if w := request(a, "POST", "/api/review", "[1,2]"); w.Code != 400 {
		t.Errorf("non-object review: %d", w.Code)
	}
}

func TestPullStrategyIsValidated(t *testing.T) {
	a := cleanRepo(t)
	actFails(t, a, map[string]any{"action": "pull", "strategy": "wat"})
	actFails(t, a, map[string]any{"action": "fetch", "remote": "--upload-pack=x"})
	actFails(t, a, map[string]any{"action": "push", "setUpstream": true})
}

func TestOpenRefusesGitDirAndUnknownEditors(t *testing.T) {
	a := cleanRepo(t)
	if code, _ := post(t, a, "/api/open", map[string]any{"path": ".git/config"}); code != 400 {
		t.Errorf("open .git: %d", code)
	}
	if code, _ := post(t, a, "/api/open", map[string]any{"path": "keep.txt", "app": "sh -c evil"}); code != 400 {
		t.Errorf("unknown editor: %d", code)
	}
}

func TestPatchPathsReadsQuotedNames(t *testing.T) {
	got := patchPaths("diff --git a/plain.txt b/plain.txt\n--- a/plain.txt\ndiff --git \"a/\\303\\251.txt\" \"b/\\303\\251.txt\"\n")
	if len(got) != 2 || got[0] != "plain.txt" || got[1] != "\u00e9.txt" {
		t.Errorf("patchPaths = %q", got)
	}
	if got := patchPaths("diff --git a/with space.txt b/with space.txt\n"); len(got) != 1 || got[0] != "with space.txt" {
		t.Errorf("space name = %q", got)
	}
}

func TestRemotesAndResolve(t *testing.T) {
	a := cleanRepo(t)
	act(t, a, map[string]any{"action": "remote:add", "from": "origin", "url": "git@github.com:me/echo.git"})
	var rs []Remote
	_ = json.Unmarshal(request(a, "GET", "/api/remotes", "").Body.Bytes(), &rs)
	if len(rs) != 1 || rs[0].Web != "https://github.com/me/echo" || rs[0].Fetch != "git@github.com:me/echo.git" {
		t.Errorf("remotes = %+v", rs)
	}
	// A conflicted file can take either side whole.
	commitFile(t, a, "c.txt", "base\n", "c")
	gitIn(t, a, "switch", "-q", "-c", "side")
	commitFile(t, a, "c.txt", "side\n", "side")
	gitIn(t, a, "switch", "-q", "main")
	commitFile(t, a, "c.txt", "main\n", "main")
	actFails(t, a, map[string]any{"action": "merge", "from": "side"})
	act(t, a, map[string]any{"action": "resolve:theirs", "paths": []string{"c.txt"}})
	if readFile(t, a, "c.txt") != "side\n" {
		t.Errorf("c.txt = %q", readFile(t, a, "c.txt"))
	}
	for _, c := range a.gitStatus().Changes {
		if c.Path == "c.txt" && c.Conflict {
			t.Error("c.txt should be resolved")
		}
	}
}

func TestLogMarksUnpushedCommits(t *testing.T) {
	a := cleanRepo(t)
	// No remote: nothing is flagged.
	var lg struct{ Commits []Commit }
	_ = json.Unmarshal(request(a, "GET", "/api/history?ref=HEAD", "").Body.Bytes(), &lg)
	for _, c := range lg.Commits {
		if c.Unpushed {
			t.Fatalf("%s flagged with no remote", c.Short)
		}
	}
	bare := filepath.Join(t.TempDir(), "remote.git")
	if out, err := exec.Command("git", "init", "-q", "--bare", bare).CombinedOutput(); err != nil {
		t.Fatalf("%v %s", err, out)
	}
	act(t, a, map[string]any{"action": "remote:add", "from": "origin", "url": bare})
	gitIn(t, a, "push", "-q", "-u", "origin", "main")
	pushed := commitFile(t, a, "later.txt", "x\n", "local only")
	_ = json.Unmarshal(request(a, "GET", "/api/history?ref=HEAD", "").Body.Bytes(), &lg)
	flags := map[string]bool{}
	for _, c := range lg.Commits {
		flags[c.Subject] = c.Unpushed
	}
	if !flags["local only"] || flags["init"] {
		t.Errorf("flags = %v (head %s)", flags, pushed[:7])
	}
}

func TestStatusMarksMergedRemoteBranches(t *testing.T) {
	a := cleanRepo(t)
	bare := filepath.Join(t.TempDir(), "remote.git")
	if out, err := exec.Command("git", "init", "-q", "--bare", bare).CombinedOutput(); err != nil {
		t.Fatalf("%v %s", err, out)
	}
	act(t, a, map[string]any{"action": "remote:add", "from": "origin", "url": bare})
	gitIn(t, a, "push", "-q", "-u", "origin", "main")
	gitIn(t, a, "push", "-q", "origin", "main:done")
	gitIn(t, a, "switch", "-q", "-c", "wip")
	commitFile(t, a, "wip.txt", "x\n", "wip")
	gitIn(t, a, "push", "-q", "origin", "wip")
	gitIn(t, a, "switch", "-q", "main")
	gitIn(t, a, "fetch", "-q", "origin")
	var st GitStatus
	_ = json.Unmarshal(request(a, "GET", "/api/git/status", "").Body.Bytes(), &st)
	// done is at main's commit; wip has a commit main lacks; origin/main is main's own upstream.
	if want := []string{"origin/done"}; !slices.Equal(st.RemoteMerged, want) {
		t.Errorf("RemoteMerged = %v, want %v", st.RemoteMerged, want)
	}
}
