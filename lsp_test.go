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
