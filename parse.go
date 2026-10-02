package main

import (
	"sort"
	"strconv"
	"strings"
)

func isHex(s string) bool {
	if len(s) < 4 || len(s) > 40 {
		return false
	}
	for _, c := range s {
		if !strings.ContainsRune("0123456789abcdefABCDEF", c) {
			return false
		}
	}
	return true
}

// parseBlame reads `git blame --porcelain`: a "<hash> <orig> <final> [<count>]" header per line,
// commit fields (author, author-time, summary) the first time a hash appears, then "\t<text>".
func parseBlame(s string) Blame {
	b := Blame{Commits: []BlameCommit{}, Lines: []int{}}
	index := map[string]int{}
	cur, final := -1, 0
	for _, line := range strings.Split(s, "\n") {
		if strings.HasPrefix(line, "\t") {
			for len(b.Lines) < final {
				b.Lines = append(b.Lines, -1)
			}
			if cur >= 0 && final > 0 {
				b.Lines[final-1] = cur
			}
			continue
		}
		f := strings.Fields(line)
		if len(f) >= 3 && len(f[0]) == 40 && isHex(f[0][:8]) {
			if _, err := strconv.Atoi(f[2]); err == nil {
				i, ok := index[f[0]]
				if !ok {
					i = len(b.Commits)
					index[f[0]] = i
					b.Commits = append(b.Commits, BlameCommit{Hash: f[0]})
				}
				cur = i
				final, _ = strconv.Atoi(f[2])
				continue
			}
		}
		if cur < 0 {
			continue
		}
		c := &b.Commits[cur]
		if v, ok := strings.CutPrefix(line, "author "); ok {
			c.Author = v
		} else if v, ok := strings.CutPrefix(line, "author-time "); ok {
			c.Time, _ = strconv.ParseInt(v, 10, 64)
		} else if v, ok := strings.CutPrefix(line, "summary "); ok {
			c.Summary = v
		}
	}
	return b
}

func parseLines(s string) []string {
	var out []string
	for _, line := range strings.Split(s, "\n") {
		if line = strings.TrimSpace(line); line != "" {
			out = append(out, line)
		}
	}
	return out
}

// parsePorcelain reads `git status --porcelain=v1 -z` entries: "XY path", with renames followed by the old path.
func parsePorcelain(s string) []Change {
	out := []Change{}
	entries := strings.Split(s, "\x00")
	for i := 0; i < len(entries); i++ {
		entry := entries[i]
		if len(entry) < 4 {
			continue
		}
		code := entry[:2]
		out = append(out, Change{Path: entry[3:], Code: code, Staged: code[0] != ' ' && code[0] != '?'})
		if code[0] == 'R' || code[0] == 'C' {
			i++
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Path < out[j].Path })
	return out
}

// parseNumstat reads `git diff --numstat -z --no-renames` records: "added\tdeleted\tpath"; binary files use "-".
func parseNumstat(s string) map[string]Change {
	out := map[string]Change{}
	for _, rec := range strings.Split(s, "\x00") {
		parts := strings.SplitN(rec, "\t", 3)
		if len(parts) != 3 {
			continue
		}
		c := Change{Path: parts[2], Binary: parts[0] == "-"}
		c.Added, _ = strconv.Atoi(parts[0])
		c.Deleted, _ = strconv.Atoi(parts[1])
		out[c.Path] = c
	}
	return out
}

// parseCommits reads logFormat records: hash, short, parents, refs, author, unix time, subject.
func parseCommits(s string) []Commit {
	out := []Commit{}
	for _, rec := range strings.Split(s, "\x1e") {
		parts := strings.SplitN(strings.TrimLeft(rec, "\n"), "\x1f", 7)
		if len(parts) != 7 {
			continue
		}
		c := Commit{Hash: parts[0], Short: parts[1], Parents: strings.Fields(parts[2]), Refs: []string{}, Author: parts[4], Subject: parts[6]}
		if parts[3] != "" {
			c.Refs = strings.Split(parts[3], ", ")
		}
		c.Time, _ = strconv.ParseInt(parts[5], 10, 64)
		out = append(out, c)
	}
	return out
}

// parseBranches reads "name\tupstream\ttrack" lines, where track is "ahead 1, behind 2", "gone", or empty.
func parseBranches(s string) []Branch {
	out := []Branch{}
	for _, line := range strings.Split(s, "\n") {
		parts := strings.SplitN(line, "\t", 3)
		if len(parts) != 3 || parts[0] == "" {
			continue
		}
		b := Branch{Name: parts[0], Upstream: parts[1], Gone: parts[2] == "gone"}
		for _, f := range strings.Split(parts[2], ", ") {
			if n, ok := strings.CutPrefix(f, "ahead "); ok {
				b.Ahead, _ = strconv.Atoi(n)
			} else if n, ok := strings.CutPrefix(f, "behind "); ok {
				b.Behind, _ = strconv.Atoi(n)
			}
		}
		out = append(out, b)
	}
	return out
}

// parseCommitDetail reads NUL-separated hash, parents, author, email, time, committer, time, message.
func parseCommitDetail(s string) (CommitDetail, bool) {
	parts := strings.SplitN(s, "\x00", 8)
	if len(parts) != 8 {
		return CommitDetail{}, false
	}
	d := CommitDetail{Hash: parts[0], Parents: strings.Fields(parts[1]), Author: parts[2], AuthorEmail: parts[3], Committer: parts[5], Files: []Change{}}
	d.AuthorTime, _ = strconv.ParseInt(parts[4], 10, 64)
	d.CommitTime, _ = strconv.ParseInt(parts[6], 10, 64)
	msg := strings.TrimRight(parts[7], "\n")
	d.Subject, d.Body, _ = strings.Cut(msg, "\n")
	d.Body = strings.Trim(d.Body, "\n")
	return d, true
}

// parseNameStatus reads `--name-status -z` output: a status letter, then the path, each NUL-terminated.
func parseNameStatus(s string) []Change {
	out := []Change{}
	f := strings.Split(strings.TrimLeft(s, "\x00\n"), "\x00")
	for i := 0; i+1 < len(f); i += 2 {
		if f[i] != "" {
			out = append(out, Change{Code: f[i][:1], Path: f[i+1]})
		}
	}
	return out
}

// parseContains sorts full ref names into local branches, remote branches, and tags. Remote HEAD
// aliases (origin/HEAD) are skipped because they duplicate the branch they point to.
func parseContains(s string) Contains {
	c := Contains{Branches: []string{}, Remotes: []string{}, Tags: []string{}}
	for _, ref := range parseLines(s) {
		if name, ok := strings.CutPrefix(ref, "refs/heads/"); ok {
			c.Branches = append(c.Branches, name)
		} else if name, ok := strings.CutPrefix(ref, "refs/remotes/"); ok && !strings.HasSuffix(name, "/HEAD") {
			c.Remotes = append(c.Remotes, name)
		} else if name, ok := strings.CutPrefix(ref, "refs/tags/"); ok {
			c.Tags = append(c.Tags, name)
		}
	}
	return c
}

func parseStashes(s string) []Stash {
	var out []Stash
	for _, line := range strings.Split(s, "\n") {
		parts := strings.SplitN(line, "\t", 2)
		if len(parts) == 2 {
			out = append(out, Stash{Ref: parts[0], Subject: parts[1]})
		}
	}
	return out
}
