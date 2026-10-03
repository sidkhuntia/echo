package main

import (
	"bufio"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/cookiejar"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"testing"
	"time"
)

// TestSmokeRealBinary builds echo-desk, starts it on a temporary repository with an isolated config
// directory, and drives the same endpoints the page uses: the token handshake, status, tree, a git
// action, the saved-session store, and a clean shutdown.
func TestSmokeRealBinary(t *testing.T) {
	if testing.Short() {
		t.Skip("builds the binary")
	}
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not installed")
	}
	dir := t.TempDir()
	bin := filepath.Join(dir, "echo-desk")
	if out, err := exec.Command("go", "build", "-o", bin, ".").CombinedOutput(); err != nil {
		t.Fatalf("build: %v\n%s", err, out)
	}
	repo := testRepo(t).root
	home := t.TempDir()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := ln.Addr().(*net.TCPAddr).Port
	ln.Close()

	cmd := exec.Command(bin, "-no-open", "-port", itoa(port), repo)
	cmd.Env = append(os.Environ(), "HOME="+home, "XDG_CONFIG_HOME="+filepath.Join(home, ".config"))
	stdout, _ := cmd.StdoutPipe()
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	t.Cleanup(func() { _ = cmd.Process.Kill() })

	re := regexp.MustCompile(`open (http://127\.0\.0\.1:\d+/\?t=[0-9a-f]+)`)
	var link string
	sc := bufio.NewScanner(stdout)
	deadline := time.Now().Add(10 * time.Second)
	for link == "" && time.Now().Before(deadline) && sc.Scan() {
		if m := re.FindStringSubmatch(sc.Text()); m != nil {
			link = m[1]
		}
	}
	if link == "" {
		t.Fatal("echo did not print its link")
	}
	go io.Copy(io.Discard, stdout)

	base := "http://127.0.0.1:" + itoa(port)
	if res, err := http.Get(base + "/api/git/status"); err != nil || res.StatusCode != http.StatusUnauthorized {
		t.Fatalf("a request with no token should be refused: %v %v", res, err)
	}
	jar, _ := cookiejar.New(nil)
	c := &http.Client{Jar: jar, Timeout: 10 * time.Second}
	if res, err := c.Get(link); err != nil || res.StatusCode != 200 || !strings.Contains(res.Header.Get("Content-Security-Policy"), "default-src 'self'") {
		t.Fatalf("the link should log in and serve the page: %v %v", res, err)
	}
	get := func(path string, v any) {
		t.Helper()
		res, err := c.Get(base + path)
		if err != nil || res.StatusCode != 200 {
			t.Fatalf("GET %s: %v %v", path, res, err)
		}
		defer res.Body.Close()
		if v != nil {
			if err := json.NewDecoder(res.Body).Decode(v); err != nil {
				t.Fatalf("GET %s: %v", path, err)
			}
		}
	}
	post := func(path, body string) string {
		t.Helper()
		res, err := c.Post(base+path, "application/json", strings.NewReader(body))
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		b, _ := io.ReadAll(res.Body)
		if res.StatusCode != 200 {
			t.Fatalf("POST %s: %d %s", path, res.StatusCode, b)
		}
		return string(b)
	}

	var st GitStatus
	get("/api/git/status", &st)
	if !st.Git || st.Branch != "main" || len(st.Changes) != 2 {
		t.Errorf("status = %+v", st)
	}
	var tree []TreeNode
	get("/api/tree", &tree)
	if len(tree) != 2 {
		t.Errorf("tree = %+v", tree)
	}
	post("/api/git", `{"action":"add","paths":["agent.txt"]}`)
	get("/api/git/status", &st)
	staged := 0
	for _, ch := range st.Changes {
		if ch.Staged {
			staged++
		}
	}
	if staged != 1 {
		t.Errorf("staged = %d after add", staged)
	}
	post("/api/drafts", `{"session":{"v":1,"root":"x"}}`)
	var drafts struct{ Session struct{ Root string } }
	get("/api/drafts", &drafts)
	if drafts.Session.Root != "x" {
		t.Errorf("drafts = %+v", drafts)
	}
	post("/api/shutdown", `{}`)
	select {
	case <-done:
	case <-time.After(10 * time.Second):
		t.Fatal("echo did not stop")
	}
}

func itoa(n int) string { return strconv.Itoa(n) }
