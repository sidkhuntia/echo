package main

import (
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// ConflictStage is one unmerged index entry for a path: 1 is the merge base,
// 2 is ours (HEAD, or the branch being rebased onto during a rebase), 3 is
// theirs (the branch being merged in).
type ConflictStage struct {
	Stage int    `json:"stage"`
	Mode  string `json:"mode"`
	Hash  string `json:"hash"`
}

// ConflictInfo describes why a path is unmerged, so the editor can offer the
// right actions instead of only showing conflict markers (which only content
// conflicts have).
type ConflictInfo struct {
	Path      string          `json:"path"`
	Code      string          `json:"code"`
	Kind      string          `json:"kind"`
	Stages    []ConflictStage `json:"stages"`
	Operation string          `json:"operation,omitempty"`
}

// conflictKind names the shape of an unmerged path from the stages git reports
// in `git ls-files -u`. The names match what `git merge` prints:
//
//	content: both sides changed the file (stages 1,2,3), markers in the file
//	deleted-by-them: we changed it, they deleted it (stages 1,2)
//	deleted-by-us: they changed it, we deleted it (stages 1,3)
//	both-added: no base, both created it differently (stages 2,3)
//	both-deleted, unknown: anything else (kept for forward compatibility)
func conflictKind(stages []int) string {
	has := func(n int) bool {
		for _, s := range stages {
			if s == n {
				return true
			}
		}
		return false
	}
	switch {
	case has(1) && has(2) && has(3):
		return "content"
	case has(1) && has(2):
		return "deleted-by-them"
	case has(1) && has(3):
		return "deleted-by-us"
	case has(2) && has(3):
		return "both-added"
	case len(stages) == 0:
		return "unknown"
	default:
		return "unknown"
	}
}

// parseUnmerged reads `git ls-files -u -z -- paths` output. With -z each record
// is "<mode> <hash> <stage>\t<path>\0". Records whose path is not one of the
// requested ones are skipped, so one call can serve several files.
func parseUnmerged(out string, want map[string]bool) map[string][]ConflictStage {
	res := map[string][]ConflictStage{}
	for _, rec := range strings.Split(out, "\x00") {
		if rec == "" {
			continue
		}
		tab := strings.Index(rec, "\t")
		if tab < 0 {
			continue
		}
		meta, p := rec[:tab], rec[tab+1:]
		p = filepath.ToSlash(filepath.Clean(p))
		if want != nil && !want[p] {
			continue
		}
		f := strings.Fields(meta)
		if len(f) != 3 {
			continue
		}
		stage := 0
		switch f[2] {
		case "1":
			stage = 1
		case "2":
			stage = 2
		case "3":
			stage = 3
		default:
			continue
		}
		res[p] = append(res[p], ConflictStage{Stage: stage, Mode: f[0], Hash: f[1]})
	}
	for p := range res {
		sort.Slice(res[p], func(i, j int) bool { return res[p][i].Stage < res[p][j].Stage })
	}
	return res
}

// unmergedStages returns the index stages for each path, or an empty slice
// when the path is not unmerged.
func (a *App) unmergedStages(paths []string) map[string][]ConflictStage {
	want := map[string]bool{}
	for _, p := range paths {
		want[filepath.ToSlash(filepath.Clean(p))] = true
	}
	out, err := a.git(append([]string{"ls-files", "-u", "-z", "--"}, paths...)...)
	if err != nil {
		return map[string][]ConflictStage{}
	}
	return parseUnmerged(out, want)
}

// conflictCode finds the porcelain code for a path in the current status, so
// the conflict endpoint can report it without another status call.
func (a *App) conflictCode(path string) string {
	out, err := a.git("status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all", "--", path)
	if err != nil {
		return ""
	}
	for _, c := range parsePorcelain(out) {
		if c.Path == path {
			return c.Code
		}
	}
	return ""
}

// handleConflict answers what kind of conflict a path holds. Content conflicts
// have markers to edit; delete and add conflicts do not, and need Keep/Delete
// actions instead of marker buttons.
func (a *App) handleConflict(w http.ResponseWriter, r *http.Request) {
	rel := r.URL.Query().Get("path")
	if _, err := a.safePath(rel); err != nil || rel == "" {
		http.Error(w, "invalid path", http.StatusBadRequest)
		return
	}
	rel = filepath.ToSlash(filepath.Clean(rel))
	stages := a.unmergedStages([]string{rel})[rel]
	var nums []int
	for _, s := range stages {
		nums = append(nums, s.Stage)
	}
	kind := conflictKind(nums)
	// A binary content conflict has markers too, but taking sides by editing
	// rarely works; the kind stays content and the page checks the file bytes.
	info := ConflictInfo{Path: rel, Code: a.conflictCode(rel), Kind: kind, Stages: stages, Operation: a.operationInProgress()}
	if info.Stages == nil {
		info.Stages = []ConflictStage{}
	}
	writeJSON(w, info)
}

// resolveSide takes one side of each conflicted path wholesale and stages the
// result. It snapshots first, because checkout and rm throw away the working
// tree version. Content and both-added conflicts come from `git checkout
// --ours/--theirs`; delete conflicts have no version on one side, so keeping
// means `git add` and dropping means `git rm`.
func (a *App) resolveSide(side string, paths []string) (string, error) {
	if len(paths) == 0 {
		return "", errors.New("paths required")
	}
	for _, p := range paths {
		if _, err := a.safePath(p); err != nil {
			return "", err
		}
	}
	if _, err := a.snapshotPaths(paths); err != nil {
		return "", errors.New("could not snapshot before resolving: " + err.Error())
	}
	stages := a.unmergedStages(paths)
	var checkout, keep, drop []string
	for _, p := range paths {
		var nums []int
		for _, s := range stages[p] {
			nums = append(nums, s.Stage)
		}
		// No unmerged stages: the file may already carry markers from an
		// earlier merge tool, or the status raced. Fall through to checkout,
		// which reports what git itself thinks.
		kind := conflictKind(nums)
		if len(nums) == 0 {
			checkout = append(checkout, p)
			continue
		}
		switch kind {
		case "deleted-by-them":
			// Stages 1,2. Ours exists, theirs deleted.
			if side == "ours" {
				keep = append(keep, p)
			} else {
				drop = append(drop, p)
			}
		case "deleted-by-us":
			// Stages 1,3. Ours deleted, theirs exists.
			if side == "ours" {
				drop = append(drop, p)
			} else {
				keep = append(keep, p)
			}
		default:
			checkout = append(checkout, p)
		}
	}
	var out strings.Builder
	flag := "--ours"
	if side == "theirs" {
		flag = "--theirs"
	}
	if len(checkout) > 0 {
		o, err := a.gitCombinedPaths(checkout, "checkout", flag, "--")
		out.WriteString(o)
		if err != nil {
			return out.String(), err
		}
		if o2, err := a.gitCombinedPaths(checkout, "add", "--"); err != nil {
			out.WriteString(o2)
			return out.String(), err
		} else {
			out.WriteString(o2)
		}
	}
	if len(keep) > 0 {
		// The wanted version is already in the working tree; staging marks it resolved.
		if _, err := os.Stat(filepath.Join(a.root, filepath.FromSlash(keep[0]))); len(keep) == 1 && err != nil && os.IsNotExist(err) {
			// The file is gone from disk (deleted outside echo after the merge).
			// Staging the deletion is what "keep the deletion" means.
			if o, err := a.gitCombinedPaths(keep, "rm", "--"); err != nil {
				out.WriteString(o)
				return out.String(), err
			} else {
				out.WriteString(o)
			}
		} else if o, err := a.gitCombinedPaths(keep, "add", "--"); err != nil {
			out.WriteString(o)
			return out.String(), err
		} else {
			out.WriteString(o)
		}
	}
	if len(drop) > 0 {
		if o, err := a.gitCombinedPaths(drop, "rm", "--"); err != nil {
			out.WriteString(o)
			return out.String(), err
		} else {
			out.WriteString(o)
		}
	}
	if out.Len() == 0 {
		return "Resolved", nil
	}
	return out.String(), nil
}
