package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// emptyTree is Git's well-known empty tree, used as the diff base before the first commit.
const emptyTree = "4b825dc642cb6eb9a060e54bf8d69288fbee4904"

// netTimeout bounds fetch, pull, and push so an unreachable remote cannot hang a request forever.
const netTimeout = 2 * time.Minute

// logPage is how many commits the Log and History views load per request.
const logPage = 200

// Commit is one log row: the full hash for copying and diffing, the short one for display,
// parents for drawing the graph, and the ref names that point at it (git's %D decoration).
type Commit struct {
	Hash    string   `json:"hash"`
	Short   string   `json:"short"`
	Parents []string `json:"parents"`
	Refs    []string `json:"refs"`
	Author  string   `json:"author"`
	Time    int64    `json:"time"`
	Subject string   `json:"subject"`
	// Unpushed is true for a commit no remote-tracking branch contains. It is only set when the
	// repository has a remote, so a repository with none does not mark everything.
	Unpushed bool `json:"unpushed,omitempty"`
}

// CommitDetail is everything the History and Log views show about one commit.
type CommitDetail struct {
	Hash        string   `json:"hash"`
	Parents     []string `json:"parents"`
	Author      string   `json:"author"`
	AuthorEmail string   `json:"authorEmail"`
	AuthorTime  int64    `json:"authorTime"`
	Committer   string   `json:"committer"`
	CommitTime  int64    `json:"commitTime"`
	Subject     string   `json:"subject"`
	Body        string   `json:"body"`
	Files       []Change `json:"files"`
}

// Contains lists the refs a commit is reachable from.
type Contains struct {
	Branches []string `json:"branches"`
	Remotes  []string `json:"remotes"`
	Tags     []string `json:"tags"`
}

type Stash struct {
	Ref     string `json:"ref"`
	Subject string `json:"subject"`
}

type Change struct {
	Path    string `json:"path"`
	Code    string `json:"code"`
	Staged  bool   `json:"staged"`
	Added   int    `json:"added"`
	Deleted int    `json:"deleted"`
	Binary  bool   `json:"binary,omitempty"`
	// Conflict marks an unmerged path: both sides changed it, or one deleted what the other changed.
	Conflict bool   `json:"conflict,omitempty"`
	Hash     string `json:"hash"`
	// Index is the staged side (HEAD to index) and Work the unstaged side (index to working tree);
	// each is nil when that side has nothing, so a partly staged file carries both.
	Index *LineStat `json:"index,omitempty"`
	Work  *LineStat `json:"work,omitempty"`
}

type LineStat struct {
	Added   int  `json:"added"`
	Deleted int  `json:"deleted"`
	Binary  bool `json:"binary,omitempty"`
}

// Branch is a local branch with its upstream and how far the two have moved apart since the last fetch.
type Branch struct {
	Name     string `json:"name"`
	Upstream string `json:"upstream,omitempty"`
	Ahead    int    `json:"ahead"`
	Behind   int    `json:"behind"`
	Gone     bool   `json:"gone,omitempty"`
}

type GitStatus struct {
	Build    string   `json:"build"`
	Git      bool     `json:"git"`
	Root     string   `json:"root"`
	Branch   string   `json:"branch"`
	Tracking *Branch  `json:"tracking,omitempty"`
	Local    []Branch `json:"local"`
	// Remote holds remote-tracking branches ("origin/main", without origin/HEAD); Tags holds tag names.
	Remote  []string `json:"remote"`
	Tags    []string `json:"tags"`
	Remotes []string `json:"remotes"`
	// FetchedAt is the Unix time of the last fetch (FETCH_HEAD's mtime), 0 if never.
	FetchedAt int64    `json:"fetchedAt"`
	Changes   []Change `json:"changes"`
	// Head and RefsSig change whenever history or any ref moves, so the browser knows when to reload the log.
	Head    string `json:"head"`
	RefsSig string `json:"refsSig"`
	// Reverting is true while a revert stopped on conflicts and waits for Continue or Abort.
	Reverting bool `json:"reverting,omitempty"`
	// Operation names a merge, rebase, cherry-pick or revert that stopped and waits for Continue or Abort.
	Operation string   `json:"operation,omitempty"`
	Branches  []string `json:"branches"`
	Stashes   []Stash  `json:"stashes"`
	// LastDiscard is the newest discard snapshot that can still be restored.
	LastDiscard *DiscardInfo `json:"lastDiscard,omitempty"`
	Error       string       `json:"error,omitempty"`
}

type gitRequest struct {
	Action   string   `json:"action"`
	Paths    []string `json:"paths"`
	Message  string   `json:"message"`
	From     string   `json:"from"`
	To       string   `json:"to"`
	StashRef string   `json:"stashRef"`
	// Parent is the mainline (1-based) when reverting a merge commit.
	Parent int `json:"parent"`
	// Worktree limits discard to unstaged changes, so staged work survives.
	Worktree bool `json:"worktree"`
	// Patch, Target and Reverse drive "apply": stage, unstage or discard the hunks in a patch.
	Patch   string `json:"patch"`
	Target  string `json:"target"`
	Reverse bool   `json:"reverse"`
	// Signoff and CoAuthors are the commit box's toggles.
	Signoff   bool     `json:"signoff"`
	CoAuthors []string `json:"coAuthors"`
	// NoFF and Squash choose how a merge is made.
	NoFF   bool `json:"noff"`
	Squash bool `json:"squash"`
	// Remote, Strategy, Tags and SetUpstream shape fetch, pull and push.
	Remote      string `json:"remote"`
	Strategy    string `json:"strategy"` // pull: ff-only, rebase, merge
	Tags        bool   `json:"tags"`
	SetUpstream bool   `json:"setUpstream"`
	// Todo is an interactive rebase plan.
	Todo []TodoItem `json:"todo"`
	// URL and Name serve remote and worktree actions.
	URL  string `json:"url"`
	Name string `json:"name"`
}

func (a *App) handleGitStatus(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, a.gitStatus())
}

func (a *App) gitStatus() GitStatus {
	status := GitStatus{Build: build, Git: true, Root: a.root, Changes: []Change{}}
	if a.noGit {
		status.Git = false
		return status
	}
	if _, err := exec.LookPath("git"); err != nil {
		status.Git = false
		status.Error = "git not found"
		return status
	}
	out, err := a.git("branch", "--show-current")
	if err != nil {
		status.Git = false
		status.Error = err.Error()
		return status
	}
	status.Branch = strings.TrimSpace(out)
	if status.Branch == "" {
		if head, err := a.git("rev-parse", "--short", "HEAD"); err == nil {
			status.Branch = "detached@" + strings.TrimSpace(head)
		}
	}
	out, err = a.git("status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all")
	if err != nil {
		status.Error = err.Error()
		return status
	}
	status.Changes = parsePorcelain(out)
	defer a.forgetSigs(status.Changes)
	stats, index, work := map[string]Change{}, map[string]Change{}, map[string]Change{}
	if out, err := a.git("diff", "--numstat", "-z", "--no-renames", a.base(), "--"); err == nil {
		stats = parseNumstat(out)
	}
	if out, err := a.git("diff", "--cached", "--numstat", "-z", "--no-renames", "--"); err == nil {
		index = parseNumstat(out)
	}
	if out, err := a.git("diff", "--numstat", "-z", "--no-renames", "--"); err == nil {
		work = parseNumstat(out)
	}
	for i := range status.Changes {
		c := &status.Changes[i]
		sig, ok := a.sig(c.Path)
		c.Hash = "deleted"
		if ok {
			c.Hash = sig.hash
		}
		if s, found := stats[c.Path]; found {
			c.Added, c.Deleted, c.Binary = s.Added, s.Deleted, s.Binary
		} else if c.Code == "??" && ok {
			c.Added, c.Binary = sig.lines, sig.binary
		}
		if c.Staged {
			s := index[c.Path]
			c.Index = &LineStat{s.Added, s.Deleted, s.Binary}
		}
		if c.Code == "??" {
			c.Work = &LineStat{c.Added, 0, c.Binary}
		} else if c.Code[1] != ' ' {
			s := work[c.Path]
			c.Work = &LineStat{s.Added, s.Deleted, s.Binary}
		}
	}
	status.Reverting = a.gitPathExists("REVERT_HEAD")
	status.Operation = a.operationInProgress()
	a.fillRefs(&status)
	return status
}

// base is the tree that "all changes" compares against: HEAD, or the empty tree before the first commit.
func (a *App) base() string {
	if _, err := a.git("rev-parse", "--verify", "-q", "HEAD"); err != nil {
		return emptyTree
	}
	return "HEAD"
}

func (a *App) handleGit(w http.ResponseWriter, r *http.Request) {
	var req gitRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	var out string
	var err error
	if req.Action == "discard" {
		out, err = a.discard(req.Paths, req.Worktree)
	} else if o, e, ok := a.extraGit(req); ok {
		out, err = o, e
	} else if req.Action == "discard:restore" {
		out, err = a.restoreDiscard()
	} else if req.Action == "commit:all" {
		var opts []string
		if opts, err = commitOpts(req); err == nil {
			out, err = a.commitAll(req.Message, opts...)
		}
	} else if req.Action == "reset:soft" {
		out, err = a.resetSoft(req.From)
	} else if req.Action == "revert" {
		out, err = a.revert(req.From, req.Parent)
	} else if netActions[req.Action] {
		if !a.net.TryLock() {
			http.Error(w, "another fetch, pull, or push is still running", http.StatusConflict)
			return
		}
		defer a.net.Unlock()
		out, err = a.network(req)
	} else {
		args, argErr := a.gitArgs(req)
		if argErr != nil {
			http.Error(w, argErr.Error(), http.StatusBadRequest)
			return
		}
		out, err = a.gitCombined(args...)
	}
	if err != nil {
		http.Error(w, strings.TrimSpace(out+"\n"+err.Error()), http.StatusBadGateway)
		return
	}
	resp := map[string]any{"ok": true, "output": out}
	if req.Action == "publish" {
		if pr := a.prURL(out); pr != "" {
			resp["pr"] = pr
		}
	}
	writeJSON(w, resp)
}

// prURL finds where to open a pull request for the branch just published. Hosts print the link in
// the push output ("Create a pull request ... https://host/o/r/pull/new/branch"); failing that,
// a GitHub remote's link is built by hand. Anything else returns "" and no link is offered.
func (a *App) prURL(pushOutput string) string {
	for _, line := range strings.Split(pushOutput, "\n") {
		l := strings.ToLower(line)
		if !strings.HasPrefix(l, "remote:") {
			continue
		}
		for _, f := range strings.Fields(line) {
			if strings.HasPrefix(f, "https://") && (strings.Contains(f, "/pull/new/") || strings.Contains(f, "merge_request") || strings.Contains(f, "pull-requests/new") || strings.Contains(f, "/compare/")) {
				return f
			}
		}
	}
	branch, _ := a.git("branch", "--show-current")
	remotes, _ := a.git("remote")
	remote, err := pickRemote(parseLines(remotes))
	if err != nil {
		return ""
	}
	raw, _ := a.git("remote", "get-url", remote)
	return githubPRURL(strings.TrimSpace(raw), strings.TrimSpace(branch))
}

// githubPRURL turns git@github.com:o/r.git or https://github.com/o/r.git into the compare link.
func githubPRURL(remote, branch string) string {
	var repo string
	switch {
	case strings.HasPrefix(remote, "git@github.com:"):
		repo = strings.TrimPrefix(remote, "git@github.com:")
	case strings.HasPrefix(remote, "ssh://git@github.com/"):
		repo = strings.TrimPrefix(remote, "ssh://git@github.com/")
	case strings.HasPrefix(remote, "https://github.com/"):
		repo = strings.TrimPrefix(remote, "https://github.com/")
	default:
		return ""
	}
	repo = strings.TrimSuffix(strings.TrimSuffix(repo, "/"), ".git")
	if branch == "" || strings.Count(repo, "/") != 1 {
		return ""
	}
	return "https://github.com/" + repo + "/pull/new/" + branch
}

func (a *App) gitArgs(req gitRequest) ([]string, error) {
	paths := req.Paths
	for i := range paths {
		if _, err := a.safePath(paths[i]); err != nil {
			return nil, err
		}
	}
	switch req.Action {
	case "add":
		return append([]string{"add", "--"}, paths...), nil
	case "unstage":
		return append([]string{"restore", "--staged", "--"}, paths...), nil
	case "commit":
		if strings.TrimSpace(req.Message) == "" {
			return nil, errors.New("commit message required")
		}
		opts, err := commitOpts(req)
		if err != nil {
			return nil, err
		}
		return append([]string{"commit", "-m", req.Message}, opts...), nil
	case "amend":
		if strings.TrimSpace(req.Message) == "" {
			return nil, errors.New("commit message required")
		}
		opts, err := commitOpts(req)
		if err != nil {
			return nil, err
		}
		return append([]string{"commit", "--amend", "-m", req.Message}, opts...), nil
	case "rebase", "merge", "branch:create", "branch:switch", "branch:track", "branch:detach", "branch:delete":
		if err := validRef(req.From); err != nil {
			return nil, err
		}
		switch req.Action {
		case "branch:create":
			// To is an optional start point: "New branch from <ref>".
			if req.To == "" {
				return []string{"switch", "-c", req.From}, nil
			}
			if err := validRef(req.To); err != nil {
				return nil, err
			}
			return []string{"switch", "-c", req.From, req.To}, nil
		case "branch:switch":
			return []string{"switch", req.From}, nil
		case "branch:track":
			// Checking out a remote branch creates the local branch that tracks it.
			return []string{"switch", "--track", req.From}, nil
		case "branch:detach":
			return []string{"switch", "--detach", req.From}, nil
		case "branch:delete":
			// -d, not -D: Git refuses to delete a branch whose commits are not merged anywhere.
			return []string{"branch", "-d", req.From}, nil
		}
		if req.Action == "merge" {
			args := []string{"merge"}
			if req.NoFF {
				args = append(args, "--no-ff")
			}
			if req.Squash {
				args = append(args, "--squash")
			}
			return append(args, req.From), nil
		}
		return []string{req.Action, req.From}, nil
	case "revert:abort":
		return []string{"revert", "--abort"}, nil
	case "revert:continue":
		// core.editor=true keeps Git from opening an editor for the revert message.
		return []string{"-c", "core.editor=true", "revert", "--continue"}, nil
	case "stash:create":
		if strings.TrimSpace(req.Message) == "" {
			req.Message = "echo stash"
		}
		args := []string{"stash", "push", "-u", "-m", req.Message}
		if len(paths) > 0 {
			args = append(args, "--")
			args = append(args, paths...)
		}
		return args, nil
	case "stash:apply", "stash:pop", "stash:drop":
		if err := validRef(req.StashRef); err != nil {
			return nil, err
		}
		return []string{"stash", strings.TrimPrefix(req.Action, "stash:"), req.StashRef}, nil
	default:
		return nil, fmt.Errorf("unknown git action: %s", req.Action)
	}
}

var netActions = map[string]bool{"branch:delete:remote": true, "submodule:update": true, "fetch": true, "pull": true, "push": true, "push:lease": true, "push:force": true, "sync": true, "publish": true}

// forcePush overwrites the current branch's upstream with the local branch. The remote and ref are
// spelled out so a push.default of "matching" cannot drag other branches into a force push. With a
// lease Git refuses if the remote branch moved since the last fetch; without one it overwrites blindly.
func (a *App) forcePush(ctx context.Context, lease bool) (string, error) {
	branch, err := a.git("branch", "--show-current")
	branch = strings.TrimSpace(branch)
	if err != nil || branch == "" {
		return "", errors.New("force push needs a checked-out branch")
	}
	out, err := a.git("for-each-ref", "--format=%(upstream:remotename) %(upstream:remoteref)", "refs/heads/"+branch)
	f := strings.Fields(out)
	if err != nil || len(f) != 2 || f[0] == "." {
		return "", fmt.Errorf("%s has no remote upstream; Publish it first", branch)
	}
	flag := "--force"
	if lease {
		flag = "--force-with-lease"
	}
	return a.gitNet(ctx, "push", flag, f[0], "HEAD:"+f[1])
}

// network runs the actions that talk to a remote. Pull respects the user's pull.rebase/pull.ff
// config, so a diverged branch with no config stops with Git's own explanation.
func (a *App) network(req gitRequest) (string, error) {
	action := req.Action
	ctx, cancel := context.WithTimeout(context.Background(), netTimeout)
	defer cancel()
	if req.Remote != "" {
		if err := validRemote(req.Remote, ""); err != nil {
			return "", err
		}
	}
	switch action {
	case "fetch":
		if req.Remote != "" {
			return a.gitNet(ctx, "fetch", "--prune", req.Remote)
		}
		return a.gitNet(ctx, "fetch", "--all", "--prune")
	case "pull":
		args := []string{"pull"}
		switch req.Strategy {
		case "":
		case "ff-only":
			args = append(args, "--ff-only")
		case "rebase":
			args = append(args, "--rebase")
		case "merge":
			args = append(args, "--no-rebase")
		default:
			return "", fmt.Errorf("unknown pull strategy %q", req.Strategy)
		}
		if req.Remote != "" {
			args = append(args, req.Remote)
		}
		return a.gitNet(ctx, args...)
	case "push":
		args := []string{"push"}
		if req.Tags {
			args = append(args, "--tags")
		}
		if req.SetUpstream {
			branch, err := a.git("branch", "--show-current")
			branch = strings.TrimSpace(branch)
			if err != nil || branch == "" || req.Remote == "" {
				return "", errors.New("set-upstream needs a checked-out branch and a remote")
			}
			args = append(args, "-u", req.Remote, branch)
		} else if req.Remote != "" {
			args = append(args, req.Remote)
		}
		return a.gitNet(ctx, args...)
	case "branch:delete:remote":
		if err := validRef(req.From); err != nil {
			return "", err
		}
		remote := req.Remote
		if remote == "" {
			return "", errors.New("remote required")
		}
		return a.gitNet(ctx, "push", remote, "--delete", req.From)
	case "submodule:update":
		return a.gitNet(ctx, "submodule", "update", "--init", "--recursive")
	case "push:lease", "push:force":
		return a.forcePush(ctx, action == "push:lease")
	case "sync":
		out, err := a.gitNet(ctx, "pull")
		if err != nil {
			return out, err
		}
		ahead, err := a.git("rev-list", "--count", "@{upstream}..HEAD")
		if err != nil || strings.TrimSpace(ahead) == "0" {
			return out, err
		}
		pushed, err := a.gitNet(ctx, "push")
		return out + pushed, err
	case "publish":
		branch, err := a.git("branch", "--show-current")
		branch = strings.TrimSpace(branch)
		if err != nil || branch == "" {
			return "", errors.New("publish needs a checked-out branch")
		}
		remote := req.Remote
		if remote == "" {
			remotes, _ := a.git("remote")
			var err error
			if remote, err = pickRemote(parseLines(remotes)); err != nil {
				return "", err
			}
		}
		return a.gitNet(ctx, "push", "-u", remote, branch)
	}
	return "", fmt.Errorf("unknown git action: %s", action)
}

// pickRemote chooses where a new branch is published: origin, else the only remote.
func pickRemote(remotes []string) (string, error) {
	for _, r := range remotes {
		if r == "origin" {
			return r, nil
		}
	}
	if len(remotes) == 1 {
		return remotes[0], nil
	}
	if len(remotes) == 0 {
		return "", errors.New("this repository has no remote to publish to")
	}
	return "", errors.New("several remotes and none is origin; publish from Terminal with git push -u <remote>")
}

// validRef keeps user-typed refs from being read as git options or split into extra words.
func validRef(ref string) error {
	if ref == "" {
		return errors.New("ref required")
	}
	if strings.HasPrefix(ref, "-") {
		return fmt.Errorf("invalid ref %q: refs cannot start with '-'", ref)
	}
	for _, r := range ref {
		if r <= ' ' || r == 0x7f {
			return fmt.Errorf("invalid ref %q: refs cannot contain spaces or control characters", ref)
		}
	}
	return nil
}

// commitAll stages every change under the root, then commits. It refuses while a conflict is
// unresolved, because staging would mark it resolved with its markers still in the file.
func (a *App) commitAll(message string, opts ...string) (string, error) {
	if strings.TrimSpace(message) == "" {
		return "", errors.New("commit message required")
	}
	unmerged, err := a.git("ls-files", "-u")
	if err != nil {
		return "", err
	}
	if strings.TrimSpace(unmerged) != "" {
		return "", errors.New("resolve the merge conflicts first; staging everything would mark them resolved")
	}
	if out, err := a.gitCombined("add", "-A", "--", "."); err != nil {
		return out, err
	}
	return a.gitCombined(append([]string{"commit", "-m", message}, opts...)...)
}

// discard restores tracked paths and deletes untracked ones, so files an agent created can be rejected too.
// discard deletes untracked paths and restores tracked ones. With worktree set it restores the working tree
// from the index only, like a "discard" in an editor's unstaged list; otherwise both index and working tree go back to HEAD.
func (a *App) discard(paths []string, worktree bool) (string, error) {
	if len(paths) == 0 {
		return "", errors.New("paths required")
	}
	for _, p := range paths {
		if _, err := a.safePath(p); err != nil {
			return "", err
		}
	}
	// What is about to be thrown away is kept in a snapshot first; a discard that cannot be
	// snapshotted does not run.
	if _, err := a.snapshotPaths(paths); err != nil {
		return "", fmt.Errorf("could not snapshot before discarding: %w", err)
	}
	out, err := a.git(append([]string{"ls-files", "--others", "--exclude-standard", "-z", "--"}, paths...)...)
	if err != nil {
		return "", err
	}
	untracked := map[string]bool{}
	for _, p := range strings.Split(out, "\x00") {
		if p != "" {
			untracked[p] = true
		}
	}
	var tracked, extra []string
	for _, p := range paths {
		if untracked[filepath.ToSlash(filepath.Clean(p))] {
			extra = append(extra, p)
		} else {
			tracked = append(tracked, p)
		}
	}
	if len(extra) > 0 {
		if out, err := a.gitCombined(append([]string{"clean", "-f", "-q", "--"}, extra...)...); err != nil {
			return out, err
		}
	}
	if len(tracked) > 0 {
		if worktree {
			return a.gitCombined(append([]string{"restore", "--worktree", "--"}, tracked...)...)
		}
		return a.gitCombined(append([]string{"restore", "--staged", "--worktree", "--"}, tracked...)...)
	}
	return "", nil
}

func (a *App) handleDiff(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	renames, context := "--no-renames", "--unified=3"
	if q.Get("renames") == "1" {
		renames = "-M"
	}
	if n, err := strconv.Atoi(q.Get("context")); err == nil && n >= 0 && n <= 100000 {
		context = "--unified=" + strconv.Itoa(n)
	}
	flags := []string{"--no-ext-diff", "--no-color", renames, context}
	if q.Get("ignoreWhitespace") == "1" {
		flags = append(flags, "--ignore-all-space")
	}
	args := append([]string{"diff"}, flags...)
	untracked := false
	switch q.Get("scope") {
	case "", "head":
		args = append(args, a.base())
		untracked = true
	case "worktree":
		untracked = true
	case "staged":
		args = append(args, "--cached")
	case "range":
		from, to := q.Get("from"), q.Get("to")
		for _, ref := range []string{from, to} {
			if err := validRef(ref); err != nil {
				http.Error(w, err.Error(), http.StatusBadRequest)
				return
			}
		}
		// dots=3 compares from the merge base, like a pull request: only what "to" added since it forked.
		dots := ".."
		if q.Get("dots") == "3" {
			dots = "..."
		}
		args = append(args, from+dots+to)
	case "commit":
		ref := q.Get("ref")
		if err := validRef(ref); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		args = append(append([]string{"show", "--format=", "--diff-merges=first-parent"}, flags...), ref)
	default:
		http.Error(w, "unknown diff scope", http.StatusBadRequest)
		return
	}
	// path narrows the diff to one file, which is how "show more context" reloads a single file.
	only := q.Get("path")
	tail := []string{"--"}
	if only != "" {
		if _, err := a.safePath(only); err != nil {
			badRequest(w, err)
			return
		}
		tail = append(tail, only)
	}
	out, err := a.git(append(funcnameArgs(), append(args, tail...)...)...)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	if untracked {
		out += a.untrackedDiff(only)
	}
	writeJSON(w, map[string]string{"text": out})
}

// untrackedDiff renders untracked files as new-file diffs; plain `git diff` leaves them out.
// handleLog pages through history in topological order, so the browser can draw the graph.
// ref is "all" (every branch, remote, and tag), or one ref; q matches the message, or jumps to a
// commit when it is a hash; author and path filter like `git log --author` and `git log -- path`.
func (a *App) handleLog(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	skip, _ := strconv.Atoi(q.Get("skip"))
	limit, err := strconv.Atoi(q.Get("limit"))
	if err != nil || limit <= 0 || limit > 1000 {
		limit = logPage
	}
	empty := map[string]any{"commits": []Commit{}, "more": false}
	if a.base() == emptyTree {
		writeJSON(w, empty)
		return
	}
	args := []string{"log", "--topo-order", logFormat}
	var revs []string
	switch ref := q.Get("ref"); ref {
	case "", "all":
		revs = []string{"--branches", "--remotes", "--tags", "HEAD"}
	default:
		if err := validRef(ref); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		revs = []string{"--end-of-options", ref}
	}
	text := strings.TrimSpace(q.Get("q"))
	author := strings.TrimSpace(q.Get("author"))
	hash := ""
	if isHex(text) {
		hash, _ = a.resolveCommit(text)
	}
	if hash != "" {
		// A hash is a jump, not a search: show exactly that commit.
		revs, skip, limit = []string{hash}, 0, 0
		args = append(args, "--no-walk")
	} else if text != "" {
		args = append(args, "--grep="+text)
	}
	if author != "" {
		args = append(args, "--author="+author)
	}
	if text != "" || author != "" {
		// Filters are typed text, not regexes: "fix(" should match a literal "fix(".
		args = append(args, "--regexp-ignore-case", "--fixed-strings")
	}
	for _, f := range [][2]string{{"since", q.Get("since")}, {"until", q.Get("until")}} {
		if f[1] != "" {
			if !dateArg.MatchString(f[1]) {
				http.Error(w, "invalid "+f[0]+" date", http.StatusBadRequest)
				return
			}
			args = append(args, "--"+f[0]+"="+f[1])
		}
	}
	switch q.Get("merges") {
	case "only":
		args = append(args, "--merges")
	case "no":
		args = append(args, "--no-merges")
	}
	if skip > 0 {
		args = append(args, "--skip="+strconv.Itoa(skip))
	}
	if limit > 0 {
		args = append(args, "-n", strconv.Itoa(limit+1))
	}
	path := q.Get("path")
	if path != "" {
		abs, err := a.safePath(path)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		// A file's history follows it across renames; --follow only works for one file, not a folder.
		if info, err := os.Stat(abs); err != nil || !info.IsDir() {
			args = append(args, "--follow")
		}
	}
	args = append(append(args, revs...), "--")
	if path != "" {
		args = append(args, path)
	}
	out, err := a.git(args...)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	commits := parseCommits(out)
	a.markUnpushed(commits)
	more := limit > 0 && len(commits) > limit
	if more {
		commits = commits[:limit]
	}
	writeJSON(w, map[string]any{"commits": commits, "more": more})
}

// BlameCommit is one commit that last touched some lines of a file.
type BlameCommit struct {
	Hash    string `json:"hash"`
	Author  string `json:"author"`
	Time    int64  `json:"time"`
	Summary string `json:"summary"`
}

// Blame maps each line (Lines[i] for line i+1) to an index into Commits.
type Blame struct {
	Commits []BlameCommit `json:"commits"`
	Lines   []int         `json:"lines"`
}

// handleBlame blames the editor's text rather than the file on disk, so unsaved edits line up;
// lines that are not committed come back with Git's all-zero hash.
func (a *App) handleBlame(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "POST required", http.StatusMethodNotAllowed)
		return
	}
	var req struct {
		Path    string `json:"path"`
		Content string `json:"content"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	if _, err := a.safePath(req.Path); err != nil || req.Path == "" {
		http.Error(w, "invalid path", http.StatusBadRequest)
		return
	}
	cmd := a.gitCmd("blame", "--porcelain", "--contents", "-", "--", req.Path)
	cmd.Stdin = strings.NewReader(req.Content)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	out, err := cmd.Output()
	if err != nil {
		// Files Git does not track have no blame; that is not an error worth showing.
		writeJSON(w, Blame{Commits: []BlameCommit{}, Lines: []int{}})
		return
	}
	writeJSON(w, parseBlame(string(out)))
}

// resolveCommit turns a user-supplied ref into a full commit hash, so later commands never see the raw input.
func (a *App) resolveCommit(ref string) (string, error) {
	if err := validRef(ref); err != nil {
		return "", err
	}
	out, err := a.git("rev-parse", "--verify", "--quiet", "--end-of-options", ref+"^{commit}")
	if err != nil || strings.TrimSpace(out) == "" {
		return "", fmt.Errorf("no commit %q", ref)
	}
	return strings.TrimSpace(out), nil
}

// handleCommit returns a commit's message and its files. Files follow the commit diff view:
// merges are compared with their first parent.
func (a *App) handleCommit(w http.ResponseWriter, r *http.Request) {
	hash, err := a.resolveCommit(r.URL.Query().Get("hash"))
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	out, err := a.git("show", "-s", "--format=%H%x00%P%x00%aN%x00%aE%x00%at%x00%cN%x00%ct%x00%B", hash)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	d, ok := parseCommitDetail(out)
	if !ok {
		http.Error(w, "unexpected git show output", http.StatusBadGateway)
		return
	}
	diff := []string{"show", "--format=", "--no-renames", "--diff-merges=first-parent", "-z"}
	codes, err := a.git(append(diff, "--name-status", hash)...)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	stats := map[string]Change{}
	if out, err := a.git(append(diff, "--numstat", hash)...); err == nil {
		stats = parseNumstat(out)
	}
	d.Files = parseNameStatus(codes)
	for i := range d.Files {
		s := stats[d.Files[i].Path]
		d.Files[i].Added, d.Files[i].Deleted, d.Files[i].Binary = s.Added, s.Deleted, s.Binary
	}
	writeJSON(w, d)
}

// gitPathExists reports whether a file or directory exists inside the repository's git dir.
func (a *App) gitPathExists(name string) bool {
	dir, _ := a.gitDirs()
	if dir == "" {
		return false
	}
	_, err := os.Stat(filepath.Join(dir, name))
	return err == nil
}

// operationInProgress names a merge, revert, cherry-pick, or rebase that has not finished.
func (a *App) operationInProgress() string {
	for _, o := range [][2]string{{"MERGE_HEAD", "merge"}, {"REVERT_HEAD", "revert"}, {"CHERRY_PICK_HEAD", "cherry-pick"}, {"rebase-merge", "rebase"}, {"rebase-apply", "rebase"}} {
		if a.gitPathExists(o[0]) {
			return o[1]
		}
	}
	return ""
}

// ResetPreview says what a soft reset to a commit would undo, or why it cannot run.
type ResetPreview struct {
	Branch string   `json:"branch"`
	Target string   `json:"target"`
	Count  int      `json:"count"`
	Pushed int      `json:"pushed"`
	Undone []string `json:"undone"`
}

// resetPreview validates a soft reset target. The target must be a strict ancestor of HEAD on a
// checked-out branch, with no other operation half done; anything else is not a "back up" and is refused.
func (a *App) resetPreview(ref string) (ResetPreview, error) {
	var p ResetPreview
	target, err := a.resolveCommit(ref)
	if err != nil {
		return p, err
	}
	if op := a.operationInProgress(); op != "" {
		return p, fmt.Errorf("finish or abort the %s in progress first", op)
	}
	out, _ := a.git("branch", "--show-current")
	if p.Branch = strings.TrimSpace(out); p.Branch == "" {
		return p, errors.New("HEAD is detached; switch to a branch before resetting")
	}
	head, err := a.git("rev-parse", "HEAD")
	if err != nil {
		return p, err
	}
	if strings.TrimSpace(head) == target {
		return p, errors.New("the branch is already at this commit")
	}
	if _, err := a.git("merge-base", "--is-ancestor", target, "HEAD"); err != nil {
		return p, errors.New("this commit is not in the history of the current branch")
	}
	p.Target = target
	log, err := a.git("log", "--format=%h %s", "--max-count=10", target+"..HEAD")
	if err != nil {
		return p, err
	}
	p.Undone = parseLines(log)
	count, _ := a.git("rev-list", "--count", target+"..HEAD")
	p.Count, _ = strconv.Atoi(strings.TrimSpace(count))
	// Commits already on the upstream need a force push after the reset.
	if unpushed, err := a.git("rev-list", "--count", target+"..HEAD", "^@{upstream}"); err == nil {
		n, _ := strconv.Atoi(strings.TrimSpace(unpushed))
		p.Pushed = p.Count - n
	}
	return p, nil
}

func (a *App) handleResetPreview(w http.ResponseWriter, r *http.Request) {
	p, err := a.resetPreview(r.URL.Query().Get("hash"))
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	writeJSON(w, p)
}

// resetSoft moves the branch back to an earlier commit and keeps every change staged.
func (a *App) resetSoft(ref string) (string, error) {
	p, err := a.resetPreview(ref)
	if err != nil {
		return "", err
	}
	old, _ := a.git("rev-parse", "--short", "HEAD")
	if out, err := a.gitCombined("reset", "--soft", p.Target); err != nil {
		return out, err
	}
	s := "s"
	if p.Count == 1 {
		s = ""
	}
	return fmt.Sprintf("Moved %s back %d commit%s (was %s); the changes are staged", p.Branch, p.Count, s, strings.TrimSpace(old)), nil
}

// revert adds a commit that undoes another. A merge commit needs its mainline parent, since Git
// cannot know which side to keep.
func (a *App) revert(ref string, parent int) (string, error) {
	hash, err := a.resolveCommit(ref)
	if err != nil {
		return "", err
	}
	out, err := a.git("rev-list", "--parents", "-n", "1", hash)
	if err != nil {
		return "", err
	}
	parents := len(strings.Fields(out)) - 1
	args := []string{"revert", "--no-edit"}
	if parents > 1 {
		if parent < 1 || parent > parents {
			return "", fmt.Errorf("this is a merge commit; choose a mainline parent from 1 to %d", parents)
		}
		args = append(args, "-m", strconv.Itoa(parent))
	} else if parent > 1 {
		return "", errors.New("only merge commits have a mainline parent")
	}
	return a.gitCombined(append(args, hash)...)
}

// handleContains is separate from handleCommit because --contains walks history and can be slow.
func (a *App) handleContains(w http.ResponseWriter, r *http.Request) {
	hash, err := a.resolveCommit(r.URL.Query().Get("hash"))
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	out, err := a.git("for-each-ref", "--contains", hash, "--format=%(refname)", "refs/heads", "refs/remotes", "refs/tags")
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	writeJSON(w, parseContains(out))
}

func (a *App) untrackedDiff(only string) string {
	lsArgs := []string{"ls-files", "--others", "--exclude-standard", "-z"}
	if only != "" {
		lsArgs = append(lsArgs, "--", only)
	}
	out, err := a.git(lsArgs...)
	if err != nil {
		return ""
	}
	var b strings.Builder
	for _, rel := range strings.Split(out, "\x00") {
		if rel == "" {
			continue
		}
		path, err := a.safePath(rel)
		if err != nil {
			continue
		}
		info, err := os.Stat(path)
		if err != nil || info.IsDir() {
			continue
		}
		if info.Size() > maxUntrackedDiff {
			fmt.Fprintf(&b, "diff --git a/%s b/%s\nnew file mode 100644\necho: %d bytes, too large to diff\n", rel, rel, info.Size())
			continue
		}
		// --no-index exits 1 when the files differ, so the error is expected; stdout is the diff.
		d, _ := a.git(append(funcnameArgs(), "diff", "--no-index", "--no-color", "--no-ext-diff", "--", "/dev/null", rel)...)
		b.WriteString(d)
	}
	return b.String()
}

// gitCmd never takes optional locks, so echo's polling cannot collide with an agent's git commands.
func (a *App) gitCmd(args ...string) *exec.Cmd {
	return a.gitCmdContext(context.Background(), args...)
}

func (a *App) gitCmdContext(ctx context.Context, args ...string) *exec.Cmd {
	cmd := exec.CommandContext(ctx, "git", append([]string{"--no-optional-locks", "-c", "core.quotePath=false", "-c", "core.fsmonitor=false"}, args...)...)
	cmd.Dir = a.root
	// Paths from the page are file names, never patterns: without this a file called [id].tsx also
	// matches i.tsx and d.tsx, and a discard of one would revert all three.
	cmd.Env = append(os.Environ(), "GIT_TERMINAL_PROMPT=0", "GIT_LITERAL_PATHSPECS=1")
	return cmd
}

// git returns stdout only, so warnings on stderr never leak into parsed output.
func (a *App) git(args ...string) (string, error) {
	cmd := a.gitCmd(args...)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	out, err := cmd.Output()
	if err != nil {
		if msg := strings.TrimSpace(stderr.String()); msg != "" {
			err = errors.New(msg)
		}
	}
	return string(out), err
}

// gitCombined returns stdout and stderr together, for actions like push whose progress goes to stderr.
func (a *App) gitCombined(args ...string) (string, error) {
	out, err := a.gitCmd(args...).CombinedOutput()
	return string(out), err
}

// gitNet is gitCombined with a deadline, for commands that wait on a remote.
func (a *App) gitNet(ctx context.Context, args ...string) (string, error) {
	cmd := a.gitCmdContext(ctx, args...)
	// ssh asks for a passphrase on the controlling terminal, which would hang until the timeout;
	// BatchMode makes it fail at once with a message. A user's own ssh command is left alone.
	if os.Getenv("GIT_SSH_COMMAND") == "" && os.Getenv("GIT_SSH") == "" {
		if out, _ := a.git("config", "--get", "core.sshCommand"); strings.TrimSpace(out) == "" {
			cmd.Env = append(cmd.Env, "GIT_SSH_COMMAND=ssh -o BatchMode=yes")
		}
	}
	out, err := cmd.CombinedOutput()
	if ctx.Err() == context.DeadlineExceeded {
		err = fmt.Errorf("git %s timed out after %s", args[0], netTimeout)
	}
	return string(out), err
}

// logFormat separates fields with the ASCII unit separator and records with the record separator,
// so subjects and ref names can hold tabs or newlines-free text without ambiguity.
const logFormat = "--format=%H%x1f%h%x1f%P%x1f%D%x1f%aN%x1f%at%x1f%s%x1e"

// refsPart is the half of the status that only changes when a ref, the stash, the remotes or the
// config change. It is recomputed only when refsStamp says one did, instead of on every poll.
type refsPart struct {
	stamp       string
	head        string
	refsSig     string
	branches    []string
	stashes     []Stash
	local       []Branch
	remotes     []string
	remote      []string
	tags        []string
	fetchedAt   int64
	lastDiscard *DiscardInfo
}

func (a *App) fillRefs(status *GitStatus) {
	stamp := a.refsStamp()
	a.refsMu.Lock()
	defer a.refsMu.Unlock()
	if stamp == "" || stamp != a.refs.stamp {
		a.refs = a.computeRefs()
		a.refs.stamp = stamp
	}
	p := &a.refs
	status.Head, status.RefsSig, status.Branches, status.Stashes = p.head, p.refsSig, p.branches, p.stashes
	status.Remotes, status.Remote, status.Tags, status.FetchedAt = p.remotes, p.remote, p.tags, p.fetchedAt
	status.LastDiscard = p.lastDiscard
	status.Local = append([]Branch(nil), p.local...)
	for i := range status.Local {
		if status.Local[i].Name == status.Branch {
			status.Tracking = &status.Local[i]
		}
	}
}

func (a *App) computeRefs() refsPart {
	var p refsPart
	if out, err := a.git("rev-parse", "-q", "--verify", "HEAD"); err == nil {
		p.head = strings.TrimSpace(out)
	}
	if out, err := a.git("for-each-ref", "--format=%(objectname) %(refname)"); err == nil {
		p.refsSig = hashBytes([]byte(out))[:12]
	}
	if out, err := a.git("branch", "-a", "--format=%(refname:short)"); err == nil {
		p.branches = parseLines(out)
	}
	if out, err := a.git("stash", "list", "--format=%gd%x09%s"); err == nil {
		p.stashes = parseStashes(out)
	}
	if out, err := a.git("for-each-ref", "--format=%(refname:short)%09%(upstream:short)%09%(upstream:track,nobracket)", "refs/heads"); err == nil {
		p.local = parseBranches(out)
	}
	if out, err := a.git("remote"); err == nil {
		p.remotes = parseLines(out)
	}
	p.lastDiscard = a.lastDiscard()
	if out, err := a.git("for-each-ref", "--format=%(refname)", "refs/remotes", "refs/tags"); err == nil {
		c := parseContains(out)
		p.remote, p.tags = c.Remotes, c.Tags
	}
	if info, err := os.Stat(filepath.Join(a.commonDir(), "FETCH_HEAD")); err == nil {
		p.fetchedAt = info.ModTime().Unix()
	}
	return p
}

// gitDirs resolves the repository's git directory and common directory once. They differ in a
// linked worktree: HEAD and the index live in the first, refs, config and FETCH_HEAD in the second.
func (a *App) gitDirs() (dir, common string) {
	a.dirsMu.Lock()
	defer a.dirsMu.Unlock()
	if a.gitDir != "" {
		return a.gitDir, a.gitCommon
	}
	// Not cached while this is not a repository, so a later `git init` is noticed.
	out, err := a.git("rev-parse", "--git-dir", "--git-common-dir")
	lines := parseLines(out)
	if err != nil || len(lines) < 2 {
		return "", ""
	}
	abs := func(p string) string {
		if filepath.IsAbs(p) {
			return p
		}
		return filepath.Join(a.root, p)
	}
	a.gitDir, a.gitCommon = abs(lines[0]), abs(lines[1])
	return a.gitDir, a.gitCommon
}

func (a *App) commonDir() string { _, c := a.gitDirs(); return c }

// refsStamp is a cheap fingerprint (file stats, no processes) of everything the refs part reads.
// An empty stamp means "cannot tell", and the part is then recomputed every time.
func (a *App) refsStamp() string {
	dir, common := a.gitDirs()
	if dir == "" {
		return ""
	}
	h := sha256.New()
	stat := func(p string) {
		if info, err := os.Stat(p); err == nil {
			fmt.Fprintf(h, "%s %d %d\n", p, info.Size(), info.ModTime().UnixNano())
		}
	}
	stat(filepath.Join(dir, "HEAD"))
	stat(filepath.Join(common, "packed-refs"))
	stat(filepath.Join(common, "config"))
	stat(filepath.Join(common, "FETCH_HEAD"))
	_ = filepath.WalkDir(filepath.Join(common, "refs"), func(p string, d fs.DirEntry, err error) error {
		if err == nil {
			if info, err := d.Info(); err == nil {
				fmt.Fprintf(h, "%s %d %d\n", p, info.Size(), info.ModTime().UnixNano())
			}
		}
		return nil
	})
	return hex.EncodeToString(h.Sum(nil))[:16]
}

// forgetSigs drops cached file hashes for paths that are no longer changed, so the cache does not
// grow with every file an agent ever touched during a long session.
func (a *App) forgetSigs(changes []Change) {
	keep := make(map[string]bool, len(changes))
	for _, c := range changes {
		keep[c.Path] = true
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	for p := range a.sigs {
		if !keep[p] {
			delete(a.sigs, p)
		}
	}
}

// markUnpushed flags the commits that exist only locally: reachable from a local branch but from no
// remote-tracking branch. Nothing is flagged when there is no remote to have pushed to.
func (a *App) markUnpushed(commits []Commit) {
	if len(commits) == 0 {
		return
	}
	if remotes, err := a.git("remote"); err != nil || strings.TrimSpace(remotes) == "" {
		return
	}
	out, err := a.git("rev-list", "--branches", "--not", "--remotes")
	if err != nil {
		return
	}
	local := map[string]bool{}
	for _, h := range parseLines(out) {
		local[h] = true
	}
	for i := range commits {
		commits[i].Unpushed = local[commits[i].Hash]
	}
}
