package main

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"
)

func TestConflictKind(t *testing.T) {
	for in, want := range map[string]string{
		"1,2,3": "content", "1,2": "deleted-by-them", "1,3": "deleted-by-us",
		"2,3": "both-added", "": "unknown",
	} {
		var stages []int
		for _, s := range strings.Split(in, ",") {
			if s == "" {
				continue
			}
			stages = append(stages, int(s[0]-'0'))
		}
		if got := conflictKind(stages); got != want {
			t.Errorf("conflictKind(%v) = %q, want %q", stages, got, want)
		}
	}
}

func TestParseUnmerged(t *testing.T) {
	out := "100644 abc123abc123abc123abc123abc123abc1 1\tk.txt\x00100644 def123def123def123def123def123def1 2\tk.txt\x00"
	got := parseUnmerged(out, map[string]bool{"k.txt": true})
	if len(got["k.txt"]) != 2 || got["k.txt"][0].Stage != 1 || got["k.txt"][1].Stage != 2 {
		t.Fatalf("parseUnmerged = %+v", got)
	}
	if got := parseUnmerged(out, map[string]bool{"other.txt": true}); len(got) != 0 {
		t.Errorf("unwanted paths kept: %+v", got)
	}
}

func TestConflictEndpointReportsDeleteConflict(t *testing.T) {
	a := cleanRepo(t)
	commitFile(t, a, "k.txt", "keep\n", "k")
	gitIn(t, a, "switch", "-q", "-c", "side")
	gitIn(t, a, "rm", "-q", "k.txt")
	gitIn(t, a, "commit", "-q", "-m", "del")
	gitIn(t, a, "switch", "-q", "main")
	commitFile(t, a, "k.txt", "changed\n", "mod")
	if code, _ := post(t, a, "/api/git", map[string]any{"action": "merge", "from": "side"}); code == 200 {
		t.Fatal("merge should conflict")
	}
	w := request(a, "GET", "/api/conflict?path=k.txt", "")
	if w.Code != http.StatusOK {
		t.Fatalf("conflict endpoint: %d %s", w.Code, w.Body)
	}
	var info ConflictInfo
	if err := json.Unmarshal(w.Body.Bytes(), &info); err != nil {
		t.Fatal(err)
	}
	if info.Kind != "deleted-by-them" || len(info.Stages) != 2 {
		t.Errorf("info = %+v", info)
	}
	// Keeping stages the working-tree version; dropping removes the file.
	act(t, a, map[string]any{"action": "resolve:ours", "paths": []string{"k.txt"}})
	if readFile(t, a, "k.txt") != "changed\n" {
		t.Errorf("keep left %q", readFile(t, a, "k.txt"))
	}
}

func TestResolveSnapshotsBeforeWholeFile(t *testing.T) {
	a := cleanRepo(t)
	commitFile(t, a, "c.txt", "base\n", "c")
	gitIn(t, a, "switch", "-q", "-c", "side")
	commitFile(t, a, "c.txt", "side\n", "side")
	gitIn(t, a, "switch", "-q", "main")
	commitFile(t, a, "c.txt", "main\n", "main")
	if code, _ := post(t, a, "/api/git", map[string]any{"action": "merge", "from": "side"}); code == 200 {
		t.Fatal("merge should conflict")
	}
	act(t, a, map[string]any{"action": "resolve:theirs", "paths": []string{"c.txt"}})
	if readFile(t, a, "c.txt") != "side\n" {
		t.Errorf("c.txt = %q", readFile(t, a, "c.txt"))
	}
	if a.lastDiscard() == nil {
		t.Error("whole-file resolve left no snapshot to restore")
	}
}

func TestFileRevServesConflictStages(t *testing.T) {
	a := cleanRepo(t)
	commitFile(t, a, "c.txt", "base\n", "c")
	gitIn(t, a, "switch", "-q", "-c", "side")
	commitFile(t, a, "c.txt", "side\n", "side")
	gitIn(t, a, "switch", "-q", "main")
	commitFile(t, a, "c.txt", "main\n", "main")
	if code, _ := post(t, a, "/api/git", map[string]any{"action": "merge", "from": "side"}); code == 200 {
		t.Fatal("merge should conflict")
	}
	for rev, want := range map[string]string{"ours": "main\n", "theirs": "side\n", "base": "base\n"} {
		w := request(a, "GET", "/api/file?path=c.txt&rev="+rev, "")
		var got struct {
			Exists  bool
			Content string
		}
		_ = json.Unmarshal(w.Body.Bytes(), &got)
		if w.Code != 200 || !got.Exists || got.Content != want {
			t.Errorf("%s: %d %+v, want %q", rev, w.Code, got, want)
		}
	}
}
