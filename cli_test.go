package main

import (
	"bytes"
	"strings"
	"testing"
)

func TestNewerThan(t *testing.T) {
	for _, c := range []struct {
		latest, cur string
		want        bool
	}{{"0.3.1", "0.3.0", true}, {"0.3.0", "0.3.0", false}, {"0.10.0", "0.9.9", true}, {"0.3.0", "0.3.1", false}, {"0.3.1", "dev", true}} {
		if got := newerThan(c.latest, c.cur); got != c.want {
			t.Errorf("newerThan(%s, %s) = %v", c.latest, c.cur, got)
		}
	}
}

func TestResolveTarget(t *testing.T) {
	list := []Instance{{Root: "/a", Port: 4100}, {Root: "/b", Port: 4101}}
	if in, err := resolveTarget("4101", list); err != nil || in.Root != "/b" {
		t.Fatalf("by port: %v %v", in, err)
	}
	if in, err := resolveTarget("/a", list); err != nil || in.Port != 4100 {
		t.Fatalf("by path: %v %v", in, err)
	}
	if _, err := resolveTarget("/nope", list); err == nil {
		t.Fatal("unknown path should fail")
	}
}

func TestListInstances(t *testing.T) {
	var b bytes.Buffer
	listInstances(&b, nil)
	if !strings.Contains(b.String(), "no echo servers") {
		t.Fatal(b.String())
	}
	b.Reset()
	listInstances(&b, []Instance{{Root: "/a", Port: 4100, Branch: "main", Changes: 2}})
	if !strings.Contains(b.String(), "4100") || !strings.Contains(b.String(), "main") {
		t.Fatal(b.String())
	}
}
