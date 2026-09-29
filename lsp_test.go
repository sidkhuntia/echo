package main

import (
	"bufio"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func TestAbsoluteTokens(t *testing.T) {
	// Two tokens on line 1 (chars 4 and 10), then one on line 3 at char 2.
	got := absoluteTokens([]uint32{1, 4, 3, 0, 0, 0, 6, 2, 1, 0, 2, 2, 5, 3, 1})
	want := []uint32{1, 4, 3, 0, 0, 1, 10, 2, 1, 0, 3, 2, 5, 3, 1}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("absoluteTokens = %v, want %v", got, want)
	}
}

func TestReadFrame(t *testing.T) {
	r := bufio.NewReader(strings.NewReader("Content-Length: 7\r\nContent-Type: x\r\n\r\n{\"a\":1}Content-Length: 2\r\n\r\n{}"))
	for _, want := range []string{`{"a":1}`, `{}`} {
		got, err := readFrame(r)
		if err != nil || string(got) != want {
			t.Fatalf("readFrame = %q, %v; want %q", got, err, want)
		}
	}
}

func TestServersFor(t *testing.T) {
	if s := serversFor("a/b/main.GO"); len(s) != 1 || s[0].ID != "gopls" {
		t.Errorf("serversFor(.GO) = %v", s)
	}
	if s := serversFor("notes.txt"); len(s) != 0 {
		t.Errorf("serversFor(.txt) = %v", s)
	}
}

func TestLSPTokensWithoutServer(t *testing.T) {
	a := testRepo(t)
	w := request(a, "POST", "/api/lsp/tokens", `{"path":"keep.txt","content":"x"}`)
	var res LSPResult
	if err := json.Unmarshal(w.Body.Bytes(), &res); err != nil || res.Status != "none" {
		t.Fatalf("tokens for .txt = %s", w.Body)
	}
	if w := request(a, "POST", "/api/lsp/tokens", `{"path":"../x.go","content":"x"}`); w.Code != 400 {
		t.Errorf("escaping path = %d", w.Code)
	}
	if w := request(a, "POST", "/api/lsp/install", `{"id":"rm -rf"}`); w.Code != 400 {
		t.Errorf("unknown install id = %d", w.Code)
	}
}

func TestRawServesSandboxed(t *testing.T) {
	a := testRepo(t)
	w := request(a, "GET", "/api/raw?path=keep.txt", "")
	if w.Code != 200 || !strings.Contains(w.Header().Get("Content-Security-Policy"), "sandbox") || !strings.HasPrefix(w.Body.String(), "one") {
		t.Fatalf("raw = %d %q %q", w.Code, w.Header(), w.Body)
	}
	if w := request(a, "GET", "/api/raw?path=../x", ""); w.Code != 400 {
		t.Errorf("escaping raw path = %d", w.Code)
	}
}

func TestGoplsTokens(t *testing.T) {
	if _, ok := lookPath("gopls"); !ok {
		t.Skip("gopls not installed")
	}
	a := testRepo(t)
	os.WriteFile(filepath.Join(a.root, "go.mod"), []byte("module x\n\ngo 1.21\n"), 0o644)
	src := "package main\n\nfunc main() {\n\tx := 1\n\t_ = x\n}\n"
	os.WriteFile(filepath.Join(a.root, "main.go"), []byte(src), 0o644)
	res := a.lspTokens(t.Context(), filepath.Join(a.root, "main.go"), src)
	if res.Status != "ok" || len(res.Tokens) == 0 || len(res.Tokens)%5 != 0 {
		t.Fatalf("gopls tokens = %+v", res)
	}
	// The first token is the `package` keyword at 0:0.
	if res.Tokens[0] != 0 || res.Tokens[1] != 0 || res.Legend[res.Tokens[3]] != "keyword" {
		t.Errorf("first token = %v (%s)", res.Tokens[:5], res.Legend[res.Tokens[3]])
	}
}

func TestProgressNotifications(t *testing.T) {
	c := &lspClient{progress: map[string]lspProgress{}}
	send := func(method, params string) {
		c.notification(lspMessage{Method: method, Params: json.RawMessage(params)})
	}
	send("$/progress", `{"token":"t1","value":{"kind":"begin","title":"Importing Maven project","percentage":0}}`)
	send("$/progress", `{"token":"t1","value":{"kind":"report","message":"core","percentage":40}}`)
	if got := c.progress[`"t1"`].String(); got != "Importing Maven project · core 40%" {
		t.Errorf("progress = %q", got)
	}
	send("$/progress", `{"token":"t1","value":{"kind":"end"}}`)
	send("language/status", `{"type":"Starting","message":"Init..."}`)
	if len(c.progress) != 0 || c.note != "Init..." {
		t.Errorf("after end: %v %q", c.progress, c.note)
	}
	send("language/status", `{"type":"ServiceReady","message":"ok"}`)
	if c.note != "" {
		t.Errorf("note after ready = %q", c.note)
	}
}

func TestLSPStatusEndpoint(t *testing.T) {
	a := testRepo(t)
	a.lsp.failed["zls"] = "zls did not start: boom"
	var list []LSPStatus
	if err := json.Unmarshal(request(a, "GET", "/api/lsp/status", "").Body.Bytes(), &list); err != nil || len(list) != len(lspServers) {
		t.Fatalf("status = %v, %v", list, err)
	}
	for _, s := range list {
		if s.ID == "zls" && (s.State != "failed" || s.Message == "") {
			t.Errorf("zls = %+v", s)
		}
		if len(s.Exts) == 0 || len(s.Install) == 0 {
			t.Errorf("%s lacks exts or install: %+v", s.ID, s)
		}
	}
	request(a, "POST", "/api/lsp/restart", `{"id":"zls"}`)
	if _, ok := a.lsp.failed["zls"]; ok {
		t.Error("restart kept the failed start")
	}
}

func TestJavaHomeEnv(t *testing.T) {
	dir := t.TempDir()
	jdk := func(name, version string) string {
		home := filepath.Join(dir, name)
		os.MkdirAll(home, 0o755)
		os.WriteFile(filepath.Join(home, "release"), []byte("IMPLEMENTOR=\"x\"\nJAVA_VERSION=\""+version+"\"\n"), 0o644)
		return home
	}
	if got := javaMajor(jdk("17", "17.0.18")); got != 17 {
		t.Errorf("javaMajor(17) = %d", got)
	}
	if got := javaMajor(jdk("8", "1.8.0_392")); got != 8 {
		t.Errorf("javaMajor(8) = %d", got)
	}
	if got := javaMajor(jdk("bad", "")); got != 0 {
		t.Errorf("javaMajor(empty) = %d", got)
	}
	t.Setenv("JAVA_HOME", jdk("21", "21.0.1"))
	if env := javaHomeEnv(21); env != nil {
		t.Errorf("a new enough JAVA_HOME was replaced: %v", env)
	}
	t.Setenv("JAVA_HOME", filepath.Join(dir, "17"))
	env := javaHomeEnv(21)
	if _, err := os.Stat("/usr/libexec/java_home"); err == nil && len(env) == 1 && javaMajor(strings.TrimPrefix(env[0], "JAVA_HOME=")) < 21 {
		t.Errorf("javaHomeEnv picked an old JDK: %v", env)
	}
	if got := lspEnv("JAVA_HOME=/x"); strings.Count(strings.Join(got, "\n"), "JAVA_HOME=") != 1 {
		t.Errorf("lspEnv kept the inherited JAVA_HOME: %v", got)
	}
}
