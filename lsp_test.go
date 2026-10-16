package main

import (
	"bufio"
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"
	"testing"
	"time"
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
	if s := serversFor("a.py"); len(s) != 2 || s[0].ID != "basedpyright" {
		t.Errorf("serversFor(.py) = %v", s)
	}
	if s := serversFor("notes.txt"); len(s) != 0 {
		t.Errorf("serversFor(.txt) = %v", s)
	}
}

func TestLSPWithoutServer(t *testing.T) {
	a := testRepo(t)
	for _, route := range []string{"/api/lsp/tokens", "/api/lsp/definition"} {
		w := request(a, "POST", route, `{"path":"keep.txt","content":"x"}`)
		var res LSPResult
		if err := json.Unmarshal(w.Body.Bytes(), &res); err != nil || res.Status != "none" {
			t.Fatalf("%s for .txt = %s", route, w.Body)
		}
		w = request(a, "POST", route, `{"path":"../x.go","content":"x"}`)
		if err := json.Unmarshal(w.Body.Bytes(), &res); err != nil || res.Status != "error" {
			t.Errorf("%s with an escaping path = %d %s", route, w.Code, w.Body)
		}
		if w := request(a, "GET", route, ""); w.Code != 405 {
			t.Errorf("GET %s = %d", route, w.Code)
		}
	}
}

func TestLSPLocations(t *testing.T) {
	a := testRepo(t)
	in := fileURI(filepath.Join(a.root, "pkg", "a.go"))
	out := fileURI("/usr/local/go/src/fmt/print.go")
	cases := map[string]struct {
		raw  string
		want []LSPLocation
	}{
		"null":     {`null`, []LSPLocation{}},
		"one":      {`{"uri":"` + in + `","range":{"start":{"line":3,"character":5},"end":{"line":3,"character":9}}}`, []LSPLocation{{Path: "pkg/a.go", Line: 3, Character: 5}}},
		"many":     {`[{"uri":"` + in + `","range":{"start":{"line":1,"character":2}}},{"uri":"` + out + `","range":{"start":{"line":7,"character":0}}}]`, []LSPLocation{{Path: "pkg/a.go", Line: 1, Character: 2}, {External: "/usr/local/go/src/fmt/print.go", Line: 7}}},
		"links":    {`[{"targetUri":"` + in + `","targetRange":{"start":{"line":0,"character":0}},"targetSelectionRange":{"start":{"line":9,"character":4}}}]`, []LSPLocation{{Path: "pkg/a.go", Line: 9, Character: 4}}},
		"not file": {`[{"uri":"jar:file:///x.jar!/A.class","range":{"start":{"line":0,"character":0}}}]`, []LSPLocation{}},
	}
	for name, c := range cases {
		if got := a.lspLocations(json.RawMessage(c.raw)); !reflect.DeepEqual(got, c.want) && !(len(got) == 0 && len(c.want) == 0) {
			t.Errorf("%s: got %+v, want %+v", name, got, c.want)
		}
	}
	if _, ok := a.relInRepo(filepath.Join(a.root, "..", "elsewhere.go")); ok {
		t.Error("a path outside the repository counted as inside")
	}
}

// TestHelperLSP is a tiny language server for the tests below: this test binary, started with
// ECHO_FAKE_LSP set. Before it answers initialize it makes a request of its own, which a client
// that does not reply would leave it stuck on, as real servers do.
func TestHelperLSP(t *testing.T) {
	if os.Getenv("ECHO_FAKE_LSP") == "" {
		t.Skip("helper process")
	}
	r, w := bufio.NewReader(os.Stdin), bufio.NewWriter(os.Stdout)
	send := func(v any) {
		b, _ := json.Marshal(v)
		w.WriteString("Content-Length: " + strconv.Itoa(len(b)) + "\r\n\r\n")
		w.Write(b)
		w.Flush()
	}
	var initID *json.RawMessage
	for {
		body, err := readFrame(r)
		if err != nil {
			os.Exit(0)
		}
		var m lspMessage
		_ = json.Unmarshal(body, &m)
		switch {
		case m.Method == "initialize":
			initID = m.ID
			send(map[string]any{"jsonrpc": "2.0", "id": 900, "method": "client/registerCapability", "params": map[string]any{}})
		case m.Method == "" && m.ID != nil && string(*m.ID) == "900" && initID != nil:
			send(map[string]any{"jsonrpc": "2.0", "id": initID, "result": map[string]any{"capabilities": map[string]any{
				"semanticTokensProvider": map[string]any{"legend": map[string]any{"tokenTypes": []string{"zzz", "function"}, "tokenModifiers": []string{}}, "full": true},
			}}})
		case m.Method == "textDocument/definition":
			send(map[string]any{"jsonrpc": "2.0", "id": m.ID, "result": []map[string]any{{"uri": "file://" + os.Getenv("ECHO_FAKE_ROOT") + "/b.go", "range": map[string]any{"start": map[string]int{"line": 2, "character": 5}}}}})
		case m.Method == "textDocument/semanticTokens/full":
			send(map[string]any{"jsonrpc": "2.0", "id": m.ID, "result": map[string]any{"data": []int{0, 5, 3, 1, 0}}})
		case m.Method == "shutdown":
			send(map[string]any{"jsonrpc": "2.0", "id": m.ID, "result": nil})
		case m.Method == "exit":
			os.Exit(0)
		}
	}
}

func fakeServer(t *testing.T, root string) lspServer {
	t.Setenv("ECHO_FAKE_LSP", "1")
	t.Setenv("ECHO_FAKE_ROOT", root)
	return lspServer{ID: "fake", Cmd: []string{os.Args[0], "-test.run=^TestHelperLSP$"}, Langs: map[string]string{".go": "go"}}
}

func TestLSPClientAgainstFakeServer(t *testing.T) {
	a := testRepo(t)
	m := newLSPManager(a.root)
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	c, err := m.client(ctx, fakeServer(t, a.root))
	if err != nil {
		t.Fatalf("start: %v", err)
	}
	if !c.tokens || !reflect.DeepEqual(c.legend, []string{"zzz", "function"}) {
		t.Fatalf("legend = %v tokens=%v: the server's own legend must be read", c.legend, c.tokens)
	}
	uri := fileURI(filepath.Join(a.root, "a.go"))
	if err := c.sync(uri, "go", "package a\n"); err != nil {
		t.Fatal(err)
	}
	toks, err := c.semanticTokens(ctx, uri)
	if err != nil || !reflect.DeepEqual(toks, []uint32{0, 5, 3, 1, 0}) {
		t.Fatalf("tokens = %v, %v", toks, err)
	}
	raw, err := c.call(ctx, "textDocument/definition", map[string]any{"textDocument": map[string]string{"uri": uri}, "position": map[string]int{"line": 0, "character": 0}})
	if err != nil {
		t.Fatal(err)
	}
	if locs := a.lspLocations(raw); len(locs) != 1 || locs[0].Path != "b.go" || locs[0].Line != 2 || locs[0].Character != 5 {
		t.Errorf("definition = %+v", locs)
	}
	// Syncing another document closes the first, so the server never keeps a stale copy of a
	// file the editor has left.
	if err := c.sync(fileURI(filepath.Join(a.root, "c.go")), "go", "package c\n"); err != nil {
		t.Fatal(err)
	}
	if _, held := c.docs[uri]; held || len(c.docs) != 1 {
		t.Errorf("docs after switching file = %v", c.docs)
	}
	m.stopAll()
	select {
	case <-c.dead:
	case <-time.After(5 * time.Second):
		t.Fatal("the server was still running after stopAll")
	}
	if _, err := m.client(ctx, fakeServer(t, a.root)); err == nil {
		t.Error("a stopped manager started a server")
	}
}

func TestGoplsDefinition(t *testing.T) {
	if _, ok := lookPath("gopls"); !ok {
		t.Skip("gopls not installed")
	}
	a := testRepo(t)
	os.WriteFile(filepath.Join(a.root, "go.mod"), []byte("module x\n\ngo 1.21\n"), 0o644)
	src := "package main\n\nfunc helper() int { return 1 }\n\nfunc main() {\n\t_ = helper()\n}\n"
	os.WriteFile(filepath.Join(a.root, "main.go"), []byte(src), 0o644)
	t.Cleanup(a.lsp.stopAll)
	body, _ := json.Marshal(lspRequest{Path: "main.go", Content: src, Line: 5, Character: 8})
	var res LSPResult
	deadline := time.Now().Add(60 * time.Second)
	for {
		w := request(a, "POST", "/api/lsp/definition", string(body))
		if err := json.Unmarshal(w.Body.Bytes(), &res); err != nil {
			t.Fatal(err)
		}
		if res.Status == "ok" && len(res.Locations) > 0 || time.Now().After(deadline) {
			break
		}
		time.Sleep(time.Second)
	}
	if res.Status != "ok" || len(res.Locations) != 1 || res.Locations[0].Path != "main.go" || res.Locations[0].Line != 2 || res.Locations[0].Character != 5 {
		t.Fatalf("gopls definition = %+v", res)
	}
	body, _ = json.Marshal(lspRequest{Path: "main.go", Content: src})
	w := request(a, "POST", "/api/lsp/tokens", string(body))
	res = LSPResult{}
	if err := json.Unmarshal(w.Body.Bytes(), &res); err != nil || res.Status != "ok" || len(res.Tokens) == 0 || len(res.Tokens)%5 != 0 {
		t.Fatalf("gopls tokens = %s", w.Body)
	}
	if res.Legend[res.Tokens[3]] != "keyword" {
		t.Errorf("first token is %q, want the package keyword", res.Legend[res.Tokens[3]])
	}
}

// An agent edits files behind the editor's back. A definition in a file echo never opened must
// follow the file on disk, not what the server read when it started.
func TestGoplsSeesDiskEdits(t *testing.T) {
	if _, ok := lookPath("gopls"); !ok {
		t.Skip("gopls not installed")
	}
	a := testRepo(t)
	os.WriteFile(filepath.Join(a.root, "go.mod"), []byte("module x\n\ngo 1.21\n"), 0o644)
	helper := "package main\n\nfunc helper() int { return 1 }\n"
	os.WriteFile(filepath.Join(a.root, "helper.go"), []byte(helper), 0o644)
	src := "package main\n\nfunc main() {\n\t_ = helper()\n}\n"
	os.WriteFile(filepath.Join(a.root, "main.go"), []byte(src), 0o644)
	t.Cleanup(a.lsp.stopAll)
	ask := func() LSPResult {
		body, _ := json.Marshal(lspRequest{Path: "main.go", Content: src, Line: 3, Character: 7})
		var res LSPResult
		deadline := time.Now().Add(60 * time.Second)
		for {
			json.Unmarshal(request(a, "POST", "/api/lsp/definition", string(body)).Body.Bytes(), &res)
			if res.Status == "ok" && len(res.Locations) > 0 || time.Now().After(deadline) {
				return res
			}
			time.Sleep(time.Second)
		}
	}
	if res := ask(); len(res.Locations) != 1 || res.Locations[0].Line != 2 {
		t.Fatalf("before the edit: %+v", res)
	}
	os.WriteFile(filepath.Join(a.root, "helper.go"), []byte("package main\n\n// moved down\n// by an agent\n\nfunc helper() int { return 1 }\n"), 0o644)
	var line = -1
	for i := 0; i < 10 && line != 5; i++ {
		if res := ask(); len(res.Locations) == 1 {
			line = res.Locations[0].Line
		}
		if line != 5 {
			time.Sleep(500 * time.Millisecond)
		}
	}
	if line != 5 {
		t.Errorf("after the edit the definition is on line %d, want 5: the server did not see the file change", line)
	}
}
