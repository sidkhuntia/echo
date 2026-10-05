package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
)

// TodoItem is one line of an interactive rebase plan, oldest commit first.
type TodoItem struct {
	Cmd     string `json:"cmd"` // pick, reword, squash, fixup, drop
	Hash    string `json:"hash"`
	Message string `json:"message,omitempty"` // the new message, for reword
}

var coAuthorRe = regexp.MustCompile(`^[^<>\r\n]+ <[^<>\s]+>$`)

// commitOpts turns the commit box's toggles into git arguments.
func commitOpts(req gitRequest) ([]string, error) {
	var args []string
	if req.Signoff {
		args = append(args, "--signoff")
	}
	for _, c := range req.CoAuthors {
		c = strings.TrimSpace(c)
		if c == "" {
			continue
		}
		if !coAuthorRe.MatchString(c) {
			return nil, fmt.Errorf("co-author %q must look like: Name <email>", c)
		}
		args = append(args, "--trailer", "Co-authored-by: "+c)
	}
	return args, nil
}

// validRange accepts "a..b" as well as a single ref, for cherry-picking a run of commits.
func validRange(s string) error {
	parts := strings.Split(s, "..")
	if len(parts) > 2 || strings.Contains(s, "...") {
		return fmt.Errorf("invalid range %q", s)
	}
	for _, p := range parts {
		if err := validRef(p); err != nil {
			return err
		}
	}
	return nil
}

var remoteURLBad = regexp.MustCompile(`(?i)^(ext|fd)::`)

func validRemote(name, url string) error {
	if err := validRef(name); err != nil {
		return err
	}
	if strings.ContainsAny(name, ":/\\") {
		return fmt.Errorf("invalid remote name %q", name)
	}
	if url != "" && (strings.HasPrefix(url, "-") || remoteURLBad.MatchString(url) || strings.ContainsAny(url, "\n\r\x00")) {
		return fmt.Errorf("invalid remote URL %q", url)
	}
	return nil
}

// patchPaths lists the files a unified diff touches, from its "diff --git a/x b/y" lines, so each can
// be checked like any other path from the page.
func patchPaths(patch string) []string {
	var out []string
	seen := map[string]bool{}
	for _, line := range strings.Split(patch, "\n") {
		if !strings.HasPrefix(line, "diff --git ") {
			continue
		}
		rest := strings.TrimPrefix(line, "diff --git ")
		// "a/x b/x": the two names are equal unless renamed; take the b side. A name with unusual bytes is
		// C-quoted by Git ("a/\303\251" "b/\303\251"), and Go's string syntax reads the same escapes.
		p := ""
		if i := strings.LastIndex(rest, ` "b/`); i >= 0 && strings.HasSuffix(rest, `"`) {
			if s, err := strconv.Unquote(rest[i+1:]); err == nil {
				p = strings.TrimPrefix(s, "b/")
			}
		} else if i := strings.LastIndex(rest, " b/"); i >= 0 {
			p = rest[i+3:]
		}
		if p != "" && !seen[p] {
			seen[p] = true
			out = append(out, p)
		}
	}
	return out
}

// applyPatch stages, unstages, or discards the hunks in a patch the page built from its own diff.
// target "index" with reverse=false stages; with reverse=true it unstages. target "worktree" with
// reverse=true throws the hunks away from the working tree (after a snapshot).
func (a *App) applyPatch(req gitRequest) (string, error) {
	if strings.TrimSpace(req.Patch) == "" {
		return "", errors.New("patch required")
	}
	if len(req.Patch) > 8<<20 {
		return "", errors.New("patch is too large")
	}
	paths := patchPaths(req.Patch)
	if len(paths) == 0 {
		return "", errors.New("the patch names no file")
	}
	for _, p := range paths {
		if _, err := a.safePath(p); err != nil || inGitDir(p) {
			return "", fmt.Errorf("patch touches a path that is not allowed: %s", p)
		}
	}
	args := []string{"apply", "--recount", "--whitespace=nowarn"}
	switch req.Target {
	case "index":
		args = append(args, "--cached")
	case "worktree":
		if !req.Reverse {
			return "", errors.New("a worktree patch must be reversed (it discards hunks)")
		}
		if _, err := a.snapshotPaths(paths); err != nil {
			return "", fmt.Errorf("could not snapshot before discarding: %w", err)
		}
	default:
		return "", errors.New("target must be index or worktree")
	}
	if req.Reverse {
		args = append(args, "-R")
	}
	cmd := a.gitCmd(args...)
	cmd.Stdin = strings.NewReader(req.Patch)
	out, err := cmd.CombinedOutput()
	return string(out), err
}

// extraGit handles the actions added in v2 that run no network command. ok is false for an action
// it does not know, so the caller falls through to the older table.
func (a *App) extraGit(req gitRequest) (out string, err error, ok bool) {
	ok = true
	switch req.Action {
	case "apply":
		out, err = a.applyPatch(req)
	case "amend:noedit":
		var opts []string
		if opts, err = commitOpts(req); err == nil {
			out, err = a.gitCombined(append([]string{"commit", "--amend", "--no-edit"}, opts...)...)
		}
	case "undo:commit":
		out, err = a.undoCommit()
	case "add:intent":
		out, err = a.gitCombinedPaths(req.Paths, "add", "--intent-to-add", "--")
	case "ignore":
		out, err = a.addToGitignore(req.Paths)
	case "merge:abort":
		out, err = a.gitCombined("merge", "--abort")
	case "merge:continue":
		out, err = a.gitCombined("-c", "core.editor=true", "merge", "--continue")
	case "rebase:abort", "rebase:continue", "rebase:skip":
		verb := strings.TrimPrefix(req.Action, "rebase:")
		out, err = a.gitCombined("-c", "core.editor=true", "rebase", "--"+verb)
	case "cherry-pick":
		if err = validRange(req.From); err == nil {
			out, err = a.gitCombined("cherry-pick", req.From)
		}
	case "cherry-pick:abort", "cherry-pick:continue", "cherry-pick:skip":
		verb := strings.TrimPrefix(req.Action, "cherry-pick:")
		out, err = a.gitCombined("-c", "core.editor=true", "cherry-pick", "--"+verb)
	case "rebase:interactive":
		out, err = a.rebaseInteractive(req.From, req.Todo)
	case "tag:create":
		out, err = a.createTag(req)
	case "branch:rename":
		if err = validRef(req.From); err == nil {
			if err = validRef(req.To); err == nil {
				out, err = a.gitCombined("branch", "-m", req.From, req.To)
			}
		}
	case "branch:delete:force":
		if err = validRef(req.From); err == nil {
			out, err = a.gitCombined("branch", "-D", req.From)
		}
	case "stash:branch":
		if err = validRef(req.StashRef); err == nil {
			if err = validRef(req.To); err == nil {
				out, err = a.gitCombined("stash", "branch", req.To, req.StashRef)
			}
		}
	case "reset:mixed", "reset:hard":
		out, err = a.resetTo(req.From, strings.TrimPrefix(req.Action, "reset:"))
	case "remote:add":
		if err = validRemote(req.From, req.URL); err == nil && req.URL == "" {
			err = errors.New("url required")
		}
		if err == nil {
			out, err = a.gitCombined("remote", "add", req.From, req.URL)
		}
	case "remote:remove":
		if err = validRemote(req.From, ""); err == nil {
			out, err = a.gitCombined("remote", "remove", req.From)
		}
	case "remote:rename":
		if err = validRemote(req.From, ""); err == nil {
			if err = validRemote(req.To, ""); err == nil {
				out, err = a.gitCombined("remote", "rename", req.From, req.To)
			}
		}
	case "remote:seturl":
		if err = validRemote(req.From, req.URL); err == nil && req.URL == "" {
			err = errors.New("url required")
		}
		if err == nil {
			out, err = a.gitCombined("remote", "set-url", req.From, req.URL)
		}
	case "worktree:add":
		out, err = a.worktreeAdd(req)
	case "worktree:remove":
		if strings.HasPrefix(req.From, "-") || req.From == "" {
			err = errors.New("worktree path required")
		} else {
			out, err = a.gitCombined("worktree", "remove", req.From)
		}
	case "resolve:ours", "resolve:theirs":
		// Take one side of a conflicted file wholesale, then mark it resolved.
		if len(req.Paths) == 0 {
			err = errors.New("paths required")
			break
		}
		side := "--" + strings.TrimPrefix(req.Action, "resolve:")
		if out, err = a.gitCombinedPaths(req.Paths, "checkout", side, "--"); err == nil {
			out, err = a.gitCombinedPaths(req.Paths, "add", "--")
		}
	case "restore:file":
		out, err = a.restoreFromCommit(req.From, req.Paths)
	default:
		ok = false
	}
	return
}

func (a *App) gitCombinedPaths(paths []string, args ...string) (string, error) {
	if len(paths) == 0 {
		return "", errors.New("paths required")
	}
	for _, p := range paths {
		if _, err := a.safePath(p); err != nil {
			return "", err
		}
	}
	return a.gitCombined(append(args, paths...)...)
}

// undoCommit moves the branch back one commit and keeps its changes staged. A root commit has no
// parent to move to, so the branch is emptied instead and everything stays staged.
func (a *App) undoCommit() (string, error) {
	if op := a.operationInProgress(); op != "" {
		return "", fmt.Errorf("finish or abort the %s in progress first", op)
	}
	if _, err := a.git("rev-parse", "--verify", "-q", "HEAD~1"); err != nil {
		if _, err := a.git("rev-parse", "--verify", "-q", "HEAD"); err != nil {
			return "", errors.New("there is no commit to undo")
		}
		return a.gitCombined("update-ref", "-d", "HEAD")
	}
	return a.gitCombined("reset", "--soft", "HEAD~1")
}

// addToGitignore appends each path as an anchored pattern to the repository's .gitignore.
func (a *App) addToGitignore(paths []string) (string, error) {
	if len(paths) == 0 {
		return "", errors.New("paths required")
	}
	file := filepath.Join(a.root, ".gitignore")
	existing, _ := os.ReadFile(file)
	have := map[string]bool{}
	for _, l := range strings.Split(string(existing), "\n") {
		have[strings.TrimSpace(l)] = true
	}
	var add []string
	for _, p := range paths {
		if _, err := a.safePath(p); err != nil {
			return "", err
		}
		if strings.ContainsAny(p, "\n\r") {
			return "", errors.New("invalid path")
		}
		pat := "/" + filepath.ToSlash(filepath.Clean(p))
		// Escape pattern characters so a file named like a glob ignores only itself.
		pat = regexp.MustCompile(`([\[\]*?\\])`).ReplaceAllString(pat, `\$1`)
		if info, err := os.Stat(filepath.Join(a.root, p)); err == nil && info.IsDir() {
			pat += "/"
		}
		if !have[pat] {
			add = append(add, pat)
			have[pat] = true
		}
	}
	if len(add) == 0 {
		return "Already ignored", nil
	}
	body := string(existing)
	if body != "" && !strings.HasSuffix(body, "\n") {
		body += "\n"
	}
	body += strings.Join(add, "\n") + "\n"
	if err := writeFileAtomic(file, []byte(body)); err != nil {
		return "", err
	}
	// A pattern does not untrack a file Git already tracks; say so, since the file will keep showing.
	if tracked, _ := a.git(append([]string{"ls-files", "--"}, paths...)...); strings.TrimSpace(tracked) != "" {
		return "Added to .gitignore. Some of these files are already tracked; run git rm --cached to stop tracking them.", nil
	}
	return "Added to .gitignore: " + strings.Join(add, ", "), nil
}

// resetTo moves the branch to a commit. mixed keeps the working tree and unstages; hard throws
// away uncommitted work, so every changed file is snapshotted first.
func (a *App) resetTo(ref, mode string) (string, error) {
	hash, err := a.resolveCommit(ref)
	if err != nil {
		return "", err
	}
	if op := a.operationInProgress(); op != "" {
		return "", fmt.Errorf("finish or abort the %s in progress first", op)
	}
	if mode == "hard" {
		if out, err := a.git("status", "--porcelain=v1", "-z", "--untracked-files=all"); err == nil {
			var paths []string
			for _, c := range parsePorcelain(out) {
				if !strings.ContainsAny(c.Path, "\n") {
					paths = append(paths, c.Path)
				}
			}
			if len(paths) > 0 {
				if _, err := a.snapshotPaths(paths); err != nil {
					return "", fmt.Errorf("could not snapshot before the hard reset: %w", err)
				}
			}
		}
	}
	return a.gitCombined("reset", "--"+mode, hash)
}

// restoreFromCommit puts a file back to how it was in a commit, after a snapshot of what is there now.
func (a *App) restoreFromCommit(ref string, paths []string) (string, error) {
	hash, err := a.resolveCommit(ref)
	if err != nil {
		return "", err
	}
	if len(paths) == 0 {
		return "", errors.New("paths required")
	}
	for _, p := range paths {
		if _, err := a.safePath(p); err != nil || inGitDir(p) {
			return "", errors.New("path not allowed")
		}
	}
	if _, err := a.snapshotPaths(paths); err != nil {
		return "", fmt.Errorf("could not snapshot before restoring: %w", err)
	}
	return a.gitCombined(append([]string{"restore", "--source=" + hash, "--worktree", "--"}, paths...)...)
}

func (a *App) worktreeAdd(req gitRequest) (string, error) {
	if req.From == "" || strings.HasPrefix(req.From, "-") || strings.ContainsAny(req.From, "\n\x00") {
		return "", errors.New("worktree path required")
	}
	path := req.From
	if !filepath.IsAbs(path) {
		path = filepath.Join(filepath.Dir(a.root), path)
	}
	switch {
	case req.To == "" && req.Name == "":
		return "", errors.New("choose a branch or give a new branch name")
	case req.Name != "": // new branch Name, starting at To (or HEAD)
		if err := validRef(req.Name); err != nil {
			return "", err
		}
		args := []string{"worktree", "add", "-b", req.Name, path}
		if req.To != "" {
			if err := validRef(req.To); err != nil {
				return "", err
			}
			args = append(args, req.To)
		}
		return a.gitCombined(args...)
	default:
		if err := validRef(req.To); err != nil {
			return "", err
		}
		return a.gitCombined("worktree", "add", path, req.To)
	}
}

// rebaseInteractive runs `git rebase -i onto` with a plan the page built, by handing Git a todo
// file instead of opening an editor. A reword becomes a pick followed by an amend with the new
// message; Git's own combined message is accepted for squashes.
func (a *App) rebaseInteractive(onto string, todo []TodoItem) (string, error) {
	base, err := a.resolveCommit(onto)
	if err != nil {
		return "", err
	}
	if op := a.operationInProgress(); op != "" {
		return "", fmt.Errorf("finish or abort the %s in progress first", op)
	}
	plan, err := a.rebasePlan(base)
	if err != nil {
		return "", err
	}
	if len(todo) != len(plan) {
		return "", errors.New("the plan must list every commit being rebased (use drop to remove one)")
	}
	full := map[string]bool{}
	for _, c := range plan {
		full[c.Hash] = true
	}
	dir, err := os.MkdirTemp("", "echo-rebase-")
	if err != nil {
		return "", err
	}
	defer os.RemoveAll(dir)
	var lines []string
	for i, t := range todo {
		h, err := a.resolveCommit(t.Hash)
		if err != nil || !full[h] {
			return "", fmt.Errorf("commit %q is not part of this rebase", t.Hash)
		}
		switch t.Cmd {
		case "pick", "squash", "fixup", "drop":
			lines = append(lines, t.Cmd+" "+h)
		case "reword":
			if strings.TrimSpace(t.Message) == "" {
				return "", errors.New("a reworded commit needs a message")
			}
			msg := filepath.Join(dir, fmt.Sprintf("msg-%d", i))
			if err := os.WriteFile(msg, []byte(t.Message), 0o600); err != nil {
				return "", err
			}
			lines = append(lines, "pick "+h, "exec git commit --amend -q -F '"+msg+"'")
		default:
			return "", fmt.Errorf("unknown rebase command %q", t.Cmd)
		}
	}
	if len(lines) > 0 && (strings.HasPrefix(lines[0], "squash") || strings.HasPrefix(lines[0], "fixup")) {
		return "", errors.New("the oldest commit cannot be squashed into anything")
	}
	file := filepath.Join(dir, "todo")
	if err := os.WriteFile(file, []byte(strings.Join(lines, "\n")+"\n"), 0o600); err != nil {
		return "", err
	}
	cmd := a.gitCmdContext(context.Background(), "rebase", "-i", base)
	cmd.Env = append(cmd.Env, "GIT_SEQUENCE_EDITOR=cp '"+file+"'", "GIT_EDITOR=true")
	out, err := cmd.CombinedOutput()
	return string(out), err
}

// rebasePlan lists the commits a rebase onto base would replay, oldest first.
func (a *App) rebasePlan(base string) ([]Commit, error) {
	if out, err := a.git("rev-list", "--merges", "-n", "1", base+"..HEAD"); err == nil && strings.TrimSpace(out) != "" {
		return nil, errors.New("this range contains a merge commit, which an interactive rebase would flatten")
	}
	out, err := a.git("log", "--reverse", "--no-merges", logFormat, base+"..HEAD")
	if err != nil {
		return nil, err
	}
	return parseCommits(out), nil
}

// validTagName holds a tag name to what Git accepts under refs/tags/, on top of validRef.
func validTagName(a *App, name string) error {
	if err := validRef(name); err != nil {
		return err
	}
	if _, err := a.git("check-ref-format", "refs/tags/"+name); err != nil {
		return fmt.Errorf("invalid tag name %q", name)
	}
	return nil
}

// createTag makes an annotated tag named req.From at req.To (default HEAD). An annotated tag needs a
// message, so it defaults to the name. It never moves a tag: Git refuses a name that is taken.
func (a *App) createTag(req gitRequest) (string, error) {
	if err := validTagName(a, req.From); err != nil {
		return "", err
	}
	msg := strings.TrimSpace(req.Message)
	if msg == "" {
		msg = req.From
	}
	args := []string{"tag", "-a", req.From, "-m", msg}
	if req.To != "" {
		if err := validRef(req.To); err != nil {
			return "", err
		}
		args = append(args, req.To)
	}
	return a.gitCombined(args...)
}
