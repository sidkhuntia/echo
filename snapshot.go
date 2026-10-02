package main

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// Discard is the one action in echo that cannot be undone by Git, because the work it throws away was
// never committed. Before it runs, the paths' current working-tree contents (untracked files
// included) are written to a commit under refs/echo/discards/, which no branch or log lists.
// "Restore last discard" puts those files back. Only the newest discardKeep snapshots are kept.
const (
	discardRefs = "refs/echo/discards/"
	discardKeep = 20
)

// DiscardInfo describes the newest snapshot, for the "Restore" button.
type DiscardInfo struct {
	Count int   `json:"count"`
	Time  int64 `json:"time"`
	Files int   `json:"files"`
}

// gitEnv runs git with extra environment variables, returning stdout.
func (a *App) gitEnv(env []string, args ...string) (string, error) {
	cmd := a.gitCmd(args...)
	cmd.Env = append(cmd.Env, env...)
	out, err := cmd.Output()
	if err != nil {
		var ee *exec.ExitError
		if errors.As(err, &ee) && len(ee.Stderr) > 0 {
			err = errors.New(strings.TrimSpace(string(ee.Stderr)))
		}
	}
	return string(out), err
}

// snapshotPaths records the working-tree state of paths and returns the snapshot's ref name.
func (a *App) snapshotPaths(paths []string) (string, error) {
	for _, p := range paths {
		if strings.ContainsAny(p, "\n\x00") {
			return "", errors.New("cannot snapshot a path with a line break in its name")
		}
	}
	dir, err := os.MkdirTemp("", "echo-snapshot-")
	if err != nil {
		return "", err
	}
	defer os.RemoveAll(dir)
	env := []string{"GIT_INDEX_FILE=" + filepath.Join(dir, "index"),
		"GIT_AUTHOR_NAME=echo", "GIT_AUTHOR_EMAIL=echo@localhost", "GIT_COMMITTER_NAME=echo", "GIT_COMMITTER_EMAIL=echo@localhost"}
	head := ""
	if out, err := a.git("rev-parse", "-q", "--verify", "HEAD"); err == nil {
		head = strings.TrimSpace(out)
		if _, err := a.gitEnv(env, "read-tree", head); err != nil {
			return "", err
		}
	}
	if _, err := a.gitEnv(env, append([]string{"add", "-f", "-A", "--"}, paths...)...); err != nil {
		return "", err
	}
	tree, err := a.gitEnv(env, "write-tree")
	if err != nil {
		return "", err
	}
	msg := "echo discard snapshot\n\n" + strings.Join(paths, "\n") + "\n"
	args := []string{"commit-tree", strings.TrimSpace(tree), "-m", msg}
	if head != "" {
		args = append(args, "-p", head)
	}
	commit, err := a.gitEnv(env, args...)
	if err != nil {
		return "", err
	}
	ref := discardRefs + strconv.FormatInt(time.Now().UnixNano(), 10)
	if _, err := a.git("update-ref", ref, strings.TrimSpace(commit)); err != nil {
		return "", err
	}
	a.pruneSnapshots()
	return ref, nil
}

func (a *App) pruneSnapshots() {
	out, err := a.git("for-each-ref", "--sort=-refname", "--format=%(refname)", discardRefs)
	if err != nil {
		return
	}
	refs := parseLines(out)
	for i := discardKeep; i < len(refs); i++ {
		_, _ = a.git("update-ref", "-d", refs[i])
	}
}

// lastDiscard reports the newest snapshot, or nil.
func (a *App) lastDiscard() *DiscardInfo {
	out, err := a.git("for-each-ref", "--sort=-refname", "--format=%(refname)", discardRefs)
	refs := parseLines(out)
	if err != nil || len(refs) == 0 {
		return nil
	}
	info := &DiscardInfo{Count: len(refs)}
	if ns, err := strconv.ParseInt(strings.TrimPrefix(refs[0], discardRefs), 10, 64); err == nil {
		info.Time = ns / 1e9
	}
	info.Files = len(a.snapshotPathList(refs[0]))
	return info
}

func (a *App) snapshotPathList(ref string) []string {
	out, err := a.git("log", "-1", "--format=%b", ref)
	if err != nil {
		return nil
	}
	return parseLines(strings.TrimSpace(out))
}

// restoreDiscard puts back the files of the newest snapshot, then drops that snapshot.
func (a *App) restoreDiscard() (string, error) {
	out, err := a.git("for-each-ref", "--sort=-refname", "--count=1", "--format=%(refname)", discardRefs)
	ref := strings.TrimSpace(out)
	if err != nil || ref == "" {
		return "", errors.New("nothing to restore")
	}
	var present []string
	for _, p := range a.snapshotPathList(ref) {
		// A file that did not exist in the working tree when it was discarded has nothing to bring back.
		if _, err := a.git("cat-file", "-e", ref+":"+p); err == nil {
			present = append(present, p)
		}
	}
	if len(present) > 0 {
		if out, err := a.gitCombined(append([]string{"restore", "--source=" + ref, "--worktree", "--"}, present...)...); err != nil {
			return out, err
		}
	}
	_, _ = a.git("update-ref", "-d", ref)
	return fmt.Sprintf("Restored %d file(s)", len(present)), nil
}
