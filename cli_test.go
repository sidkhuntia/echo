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

func TestParseGlobalArgs(t *testing.T) {
	// Flags work before or after the path; the standard flag package stopped at the
	// first path and silently dropped what came after it.
	for _, c := range []struct {
		args                  []string
		port                  int
		noOpen, version, help bool
		rest                  []string
	}{
		{nil, 0, false, false, false, []string{}},
		{[]string{"-no-open"}, 0, true, false, false, []string{}},
		{[]string{"--no-open"}, 0, true, false, false, []string{}},
		{[]string{"/tmp", "-no-open"}, 0, true, false, false, []string{"/tmp"}},
		{[]string{"-no-open", "/tmp"}, 0, true, false, false, []string{"/tmp"}},
		{[]string{"/tmp", "--no-open"}, 0, true, false, false, []string{"/tmp"}},
		{[]string{"-no-open=false"}, 0, false, false, false, []string{}},
		{[]string{"-port", "6031", "/tmp"}, 6031, false, false, false, []string{"/tmp"}},
		{[]string{"/tmp", "-port", "6031"}, 6031, false, false, false, []string{"/tmp"}},
		{[]string{"-port=6031"}, 6031, false, false, false, []string{}},
		{[]string{"/tmp", "--port=6031", "-no-open"}, 6031, true, false, false, []string{"/tmp"}},
		{[]string{"-version"}, 0, false, true, false, []string{}},
		{[]string{"/tmp", "-version"}, 0, false, true, false, []string{"/tmp"}},
		{[]string{"-h"}, 0, false, false, true, []string{}},
		{[]string{"stop", "--all"}, 0, false, false, false, []string{"stop", "--all"}},
		{[]string{"-no-open", "stop", "--all"}, 0, true, false, false, []string{"stop", "--all"}},
		{[]string{"--", "-no-open"}, 0, false, false, false, []string{"-no-open"}},
	} {
		port, noOpen, version, help, rest, err := parseGlobalArgs(c.args)
		if err != nil {
			t.Errorf("%q: %v", c.args, err)
			continue
		}
		if port != c.port || noOpen != c.noOpen || version != c.version || help != c.help || strings.Join(rest, "\x00") != strings.Join(c.rest, "\x00") {
			t.Errorf("%q = port %d noOpen %v version %v help %v rest %q, want port %d noOpen %v version %v help %v rest %q",
				c.args, port, noOpen, version, help, rest, c.port, c.noOpen, c.version, c.help, c.rest)
		}
	}
	for _, args := range [][]string{{"-port"}, {"-port", "abc"}, {"-port=", "/tmp"}, {"-no-open=maybe"}} {
		if _, _, _, _, _, err := parseGlobalArgs(args); err == nil {
			t.Errorf("%q should fail", args)
		}
	}
}
