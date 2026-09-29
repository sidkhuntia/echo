package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

// lspServer describes a language server echo knows how to find, start, and install.
// Only highlighting (semantic tokens) is asked of it.
type lspServer struct {
	ID      string   `json:"id"`
	Name    string   `json:"name"`
	Cmd     []string `json:"-"`
	Install []string `json:"install"`
	// Langs maps a file extension to the LSP languageId the server expects.
	Langs map[string]string `json:"-"`
	Init  any               `json:"-"`
}

// lspServers is the catalog, in preference order: a file uses the first installed server that
// handles its extension, and when none is installed echo offers to install the first one.
var lspServers = []lspServer{
	{ID: "gopls", Name: "gopls", Cmd: []string{"gopls"}, Install: []string{"go", "install", "golang.org/x/tools/gopls@latest"},
		Langs: map[string]string{".go": "go"}, Init: map[string]any{"semanticTokens": true}},
	{ID: "typescript", Name: "TypeScript language server", Cmd: []string{"typescript-language-server", "--stdio"}, Install: []string{"npm", "install", "-g", "typescript-language-server", "typescript"},
		Langs: map[string]string{".ts": "typescript", ".mts": "typescript", ".cts": "typescript", ".tsx": "typescriptreact", ".js": "javascript", ".mjs": "javascript", ".cjs": "javascript", ".jsx": "javascriptreact"}},
	{ID: "basedpyright", Name: "basedpyright", Cmd: []string{"basedpyright-langserver", "--stdio"}, Install: []string{"npm", "install", "-g", "basedpyright"},
		Langs: map[string]string{".py": "python", ".pyi": "python"}},
	{ID: "rust-analyzer", Name: "rust-analyzer", Cmd: []string{"rust-analyzer"}, Install: []string{"rustup", "component", "add", "rust-analyzer"},
		Langs: map[string]string{".rs": "rust"}},
	{ID: "clangd", Name: "clangd", Cmd: []string{"clangd"}, Install: []string{"brew", "install", "llvm"},
		Langs: map[string]string{".c": "c", ".h": "c", ".cc": "cpp", ".cpp": "cpp", ".cxx": "cpp", ".hpp": "cpp", ".hh": "cpp", ".m": "objective-c", ".mm": "objective-cpp"}},
	{ID: "sourcekit-lsp", Name: "SourceKit-LSP", Cmd: []string{"sourcekit-lsp"}, Install: []string{"xcode-select", "--install"},
		Langs: map[string]string{".swift": "swift"}},
	{ID: "jdtls", Name: "Eclipse JDT language server", Cmd: []string{"jdtls"}, Install: []string{"brew", "install", "jdtls"},
		Langs: map[string]string{".java": "java"}},
	{ID: "ruby-lsp", Name: "Ruby LSP", Cmd: []string{"ruby-lsp"}, Install: []string{"gem", "install", "--user-install", "ruby-lsp"},
		Langs: map[string]string{".rb": "ruby"}},
	{ID: "lua-language-server", Name: "Lua language server", Cmd: []string{"lua-language-server"}, Install: []string{"brew", "install", "lua-language-server"},
		Langs: map[string]string{".lua": "lua"}},
	{ID: "zls", Name: "zls", Cmd: []string{"zls"}, Install: []string{"brew", "install", "zls"},
		Langs: map[string]string{".zig": "zig"}},
	{ID: "bash-language-server", Name: "Bash language server", Cmd: []string{"bash-language-server", "start"}, Install: []string{"npm", "install", "-g", "bash-language-server"},
		Langs: map[string]string{".sh": "shellscript", ".bash": "shellscript", ".zsh": "shellscript"}},
}

// lspTimeout bounds one highlighting request; a server still indexing answers on a later try.
const lspTimeout = 10 * time.Second

// installTimeout bounds an install command such as `go install` or `npm install -g`.
const installTimeout = 10 * time.Minute

// tokenTypes and tokenModifiers are the standard LSP names echo can color.
var (
	tokenTypes     = []string{"namespace", "type", "class", "enum", "interface", "struct", "typeParameter", "parameter", "variable", "property", "enumMember", "event", "function", "method", "macro", "keyword", "modifier", "comment", "string", "number", "regexp", "operator", "decorator", "label"}
	tokenModifiers = []string{"declaration", "definition", "readonly", "static", "deprecated", "abstract", "async", "modification", "documentation", "defaultLibrary"}
)

// serversFor lists the catalog entries that handle a path, in preference order.
func serversFor(rel string) []lspServer {
	ext := strings.ToLower(filepath.Ext(rel))
	var out []lspServer
	for _, s := range lspServers {
		if _, ok := s.Langs[ext]; ok {
			out = append(out, s)
		}
	}
	return out
}

// searchPath is PATH plus the places installers put binaries that a Terminal PATH often lacks,
// so a server installed by `go install` or found in the Xcode tools is still picked up.
func searchPath() string {
	home, _ := os.UserHomeDir()
	dirs := filepath.SplitList(os.Getenv("PATH"))
	if gobin := os.Getenv("GOBIN"); gobin != "" {
		dirs = append(dirs, gobin)
	}
	if gopath := os.Getenv("GOPATH"); gopath != "" {
		dirs = append(dirs, filepath.Join(filepath.SplitList(gopath)[0], "bin"))
	}
	dirs = append(dirs,
		filepath.Join(home, "go", "bin"), filepath.Join(home, ".cargo", "bin"), filepath.Join(home, ".local", "bin"),
		filepath.Join(home, ".npm-global", "bin"), filepath.Join(home, ".bun", "bin"), filepath.Join(home, ".volta", "bin"),
		"/opt/homebrew/bin", "/usr/local/bin", "/opt/homebrew/opt/llvm/bin", "/usr/local/opt/llvm/bin",
		"/Library/Developer/CommandLineTools/usr/bin")
	return strings.Join(dirs, string(filepath.ListSeparator))
}

// lookPath finds a command on searchPath.
func lookPath(name string) (string, bool) {
	for _, dir := range filepath.SplitList(searchPath()) {
		if dir == "" {
			continue
		}
		p := filepath.Join(dir, name)
		if info, err := os.Stat(p); err == nil && !info.IsDir() && info.Mode()&0o111 != 0 {
			return p, true
		}
	}
	return "", false
}

// lspEnv runs servers and installers with the wider PATH, so a server can find its own runtime (node, go).
func lspEnv() []string {
	env := []string{}
	for _, kv := range os.Environ() {
		if !strings.HasPrefix(kv, "PATH=") {
			env = append(env, kv)
		}
	}
	return append(env, "PATH="+searchPath())
}

// lspClient is one running language server for this repository.
type lspClient struct {
	server lspServer
	cmd    *exec.Cmd
	in     io.WriteCloser
	wmu    sync.Mutex // serializes writes to the server's stdin
	smu    sync.Mutex // keeps document versions in order on the wire

	mu      sync.Mutex
	nextID  int
	pending map[int]chan lspMessage
	docs    map[string]*lspDoc
	legend  []string
	mods    []string
	tokens  bool // the server offers semanticTokens/full
	dead    chan struct{}
}

type lspDoc struct {
	version int
	text    string
}

type lspMessage struct {
	ID     *json.RawMessage `json:"id,omitempty"`
	Method string           `json:"method,omitempty"`
	Params json.RawMessage  `json:"params,omitempty"`
	Result json.RawMessage  `json:"result,omitempty"`
	Error  *struct {
		Code    int    `json:"code"`
		Message string `json:"message"`
	} `json:"error,omitempty"`
}

// lspManager starts servers on first use and keeps one per catalog entry.
type lspManager struct {
	root    string
	mu      sync.Mutex
	clients map[string]*lspClient
	// failed remembers servers that would not start, so each request does not respawn them.
	failed  map[string]string
	install sync.Mutex
}

func newLSPManager(root string) *lspManager {
	return &lspManager{root: root, clients: map[string]*lspClient{}, failed: map[string]string{}}
}

func (m *lspManager) client(s lspServer) (*lspClient, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if c := m.clients[s.ID]; c != nil {
		select {
		case <-c.dead:
			delete(m.clients, s.ID)
		default:
			return c, nil
		}
	}
	if msg, ok := m.failed[s.ID]; ok {
		return nil, errors.New(msg)
	}
	c, err := startLSP(m.root, s)
	if err != nil {
		m.failed[s.ID] = err.Error()
		return nil, err
	}
	m.clients[s.ID] = c
	return c, nil
}

func startLSP(root string, s lspServer) (*lspClient, error) {
	bin, ok := lookPath(s.Cmd[0])
	if !ok {
		return nil, fmt.Errorf("%s is not installed", s.Cmd[0])
	}
	cmd := exec.Command(bin, s.Cmd[1:]...)
	cmd.Dir = root
	cmd.Env = lspEnv()
	cmd.Stderr = io.Discard
	in, err := cmd.StdinPipe()
	if err != nil {
		return nil, err
	}
	out, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	c := &lspClient{server: s, cmd: cmd, in: in, pending: map[int]chan lspMessage{}, docs: map[string]*lspDoc{}, dead: make(chan struct{})}
	go c.read(bufio.NewReader(out))
	go func() { _ = cmd.Wait(); c.close() }()

	uri := fileURI(root)
	init := map[string]any{
		"processId":             os.Getpid(),
		"rootUri":               uri,
		"rootPath":              root,
		"workspaceFolders":      []map[string]string{{"uri": uri, "name": filepath.Base(root)}},
		"initializationOptions": s.Init,
		"capabilities": map[string]any{
			"general":   map[string]any{"positionEncodings": []string{"utf-16"}},
			"workspace": map[string]any{"configuration": true, "workspaceFolders": true},
			"textDocument": map[string]any{
				"synchronization": map[string]any{"dynamicRegistration": false},
				"semanticTokens": map[string]any{
					"requests":                map[string]any{"full": true},
					"tokenTypes":              tokenTypes,
					"tokenModifiers":          tokenModifiers,
					"formats":                 []string{"relative"},
					"multilineTokenSupport":   false,
					"overlappingTokenSupport": false,
				},
			},
		},
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	res, err := c.call(ctx, "initialize", init)
	if err != nil {
		c.kill()
		return nil, fmt.Errorf("%s did not start: %v", s.Name, err)
	}
	var caps struct {
		Capabilities struct {
			SemanticTokensProvider *struct {
				Legend struct {
					TokenTypes     []string `json:"tokenTypes"`
					TokenModifiers []string `json:"tokenModifiers"`
				} `json:"legend"`
				Full json.RawMessage `json:"full"`
			} `json:"semanticTokensProvider"`
		} `json:"capabilities"`
	}
	_ = json.Unmarshal(res, &caps)
	if p := caps.Capabilities.SemanticTokensProvider; p != nil {
		c.legend, c.mods = p.Legend.TokenTypes, p.Legend.TokenModifiers
		c.tokens = len(p.Full) > 0 && string(p.Full) != "false"
	}
	if err := c.notify("initialized", map[string]any{}); err != nil {
		c.kill()
		return nil, err
	}
	return c, nil
}

func (c *lspClient) kill() {
	_ = c.cmd.Process.Kill()
}

// close fails every waiting call once the server exits.
func (c *lspClient) close() {
	c.mu.Lock()
	defer c.mu.Unlock()
	select {
	case <-c.dead:
		return
	default:
	}
	close(c.dead)
	for id, ch := range c.pending {
		close(ch)
		delete(c.pending, id)
	}
}

func (c *lspClient) write(msg any) error {
	body, err := json.Marshal(msg)
	if err != nil {
		return err
	}
	c.wmu.Lock()
	defer c.wmu.Unlock()
	_, err = fmt.Fprintf(c.in, "Content-Length: %d\r\n\r\n%s", len(body), body)
	return err
}

func (c *lspClient) notify(method string, params any) error {
	return c.write(map[string]any{"jsonrpc": "2.0", "method": method, "params": params})
}

func (c *lspClient) call(ctx context.Context, method string, params any) (json.RawMessage, error) {
	c.mu.Lock()
	select {
	case <-c.dead:
		c.mu.Unlock()
		return nil, errors.New("language server exited")
	default:
	}
	c.nextID++
	id := c.nextID
	ch := make(chan lspMessage, 1)
	c.pending[id] = ch
	c.mu.Unlock()
	defer func() { c.mu.Lock(); delete(c.pending, id); c.mu.Unlock() }()

	if err := c.write(map[string]any{"jsonrpc": "2.0", "id": id, "method": method, "params": params}); err != nil {
		return nil, err
	}
	select {
	case msg, ok := <-ch:
		if !ok {
			return nil, errors.New("language server exited")
		}
		if msg.Error != nil {
			return nil, errors.New(msg.Error.Message)
		}
		return msg.Result, nil
	case <-ctx.Done():
		_ = c.notify("$/cancelRequest", map[string]any{"id": id})
		return nil, ctx.Err()
	}
}

// read dispatches responses to their callers and answers the server's own requests,
// which echo does not act on: configuration gets empty sections, everything else null.
func (c *lspClient) read(r *bufio.Reader) {
	for {
		body, err := readFrame(r)
		if err != nil {
			return
		}
		var msg lspMessage
		if json.Unmarshal(body, &msg) != nil || msg.ID == nil {
			continue
		}
		if msg.Method != "" {
			var result any
			if msg.Method == "workspace/configuration" {
				var p struct {
					Items []any `json:"items"`
				}
				_ = json.Unmarshal(msg.Params, &p)
				result = make([]any, len(p.Items))
			}
			_ = c.write(map[string]any{"jsonrpc": "2.0", "id": msg.ID, "result": result})
			continue
		}
		id, err := strconv.Atoi(string(*msg.ID))
		if err != nil {
			continue
		}
		c.mu.Lock()
		if ch := c.pending[id]; ch != nil {
			ch <- msg
		}
		c.mu.Unlock()
	}
}

// readFrame reads one Content-Length framed message.
func readFrame(r *bufio.Reader) ([]byte, error) {
	n := -1
	for {
		line, err := r.ReadString('\n')
		if err != nil {
			return nil, err
		}
		line = strings.TrimSpace(line)
		if line == "" {
			break
		}
		if k, v, ok := strings.Cut(line, ":"); ok && strings.EqualFold(strings.TrimSpace(k), "Content-Length") {
			n, _ = strconv.Atoi(strings.TrimSpace(v))
		}
	}
	if n < 0 {
		return nil, errors.New("missing Content-Length")
	}
	body := make([]byte, n)
	_, err := io.ReadFull(r, body)
	return body, err
}

// sync opens a document or sends its new full text, so tokens always match what the editor shows.
func (c *lspClient) sync(uri, lang, text string) error {
	c.smu.Lock()
	defer c.smu.Unlock()
	c.mu.Lock()
	d := c.docs[uri]
	if d != nil && d.text == text {
		c.mu.Unlock()
		return nil
	}
	if d == nil {
		d = &lspDoc{}
		c.docs[uri] = d
	}
	d.version++
	d.text = text
	v := d.version
	c.mu.Unlock()
	if v == 1 {
		return c.notify("textDocument/didOpen", map[string]any{"textDocument": map[string]any{"uri": uri, "languageId": lang, "version": v, "text": text}})
	}
	return c.notify("textDocument/didChange", map[string]any{
		"textDocument":   map[string]any{"uri": uri, "version": v},
		"contentChanges": []map[string]string{{"text": text}},
	})
}

// semanticTokens returns absolute tokens as flat [line, char, length, type, modifiers] groups,
// with type and modifier indexes into the server's legend.
func (c *lspClient) semanticTokens(ctx context.Context, uri string) ([]uint32, error) {
	res, err := c.call(ctx, "textDocument/semanticTokens/full", map[string]any{"textDocument": map[string]string{"uri": uri}})
	if err != nil {
		return nil, err
	}
	var out struct {
		Data []uint32 `json:"data"`
	}
	if len(res) > 0 && string(res) != "null" {
		if err := json.Unmarshal(res, &out); err != nil {
			return nil, err
		}
	}
	return absoluteTokens(out.Data), nil
}

// absoluteTokens turns LSP's relative encoding (each token offset from the previous one) into absolute positions.
func absoluteTokens(rel []uint32) []uint32 {
	out := make([]uint32, 0, len(rel)/5*5)
	var line, char uint32
	for i := 0; i+4 < len(rel); i += 5 {
		if rel[i] > 0 {
			line += rel[i]
			char = rel[i+1]
		} else {
			char += rel[i+1]
		}
		out = append(out, line, char, rel[i+2], rel[i+3], rel[i+4])
	}
	return out
}

func fileURI(p string) string {
	return (&url.URL{Scheme: "file", Path: filepath.ToSlash(p)}).String()
}

// LSPResult tells the editor how a file is highlighted. Status is "ok" (tokens follow), "missing"
// (a server exists but is not installed), "none" (no known server), "unsupported" (the server
// offers no highlighting), or "error" (it would not start or answer).
type LSPResult struct {
	Status    string     `json:"status"`
	Server    *lspServer `json:"server,omitempty"`
	Installed bool       `json:"installed"`
	Message   string     `json:"message,omitempty"`
	Legend    []string   `json:"legend,omitempty"`
	Modifiers []string   `json:"modifiers,omitempty"`
	Tokens    []uint32   `json:"tokens,omitempty"`
}

func (a *App) handleLSPTokens(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "POST only", http.StatusMethodNotAllowed)
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
	abs, err := a.safePath(req.Path)
	if err != nil || req.Path == "" {
		http.Error(w, "bad path", http.StatusBadRequest)
		return
	}
	writeJSON(w, a.lspTokens(r.Context(), abs, req.Content))
}

func (a *App) lspTokens(ctx context.Context, abs, content string) LSPResult {
	list := serversFor(abs)
	if len(list) == 0 {
		return LSPResult{Status: "none"}
	}
	s := list[0]
	found := false
	for _, cand := range list {
		if _, ok := lookPath(cand.Cmd[0]); ok {
			s, found = cand, true
			break
		}
	}
	if !found {
		return LSPResult{Status: "missing", Server: &s}
	}
	c, err := a.lsp.client(s)
	if err != nil {
		return LSPResult{Status: "error", Server: &s, Installed: true, Message: err.Error()}
	}
	if !c.tokens {
		return LSPResult{Status: "unsupported", Server: &s, Installed: true}
	}
	uri := fileURI(abs)
	if err := c.sync(uri, s.Langs[strings.ToLower(filepath.Ext(abs))], content); err != nil {
		return LSPResult{Status: "error", Server: &s, Installed: true, Message: err.Error()}
	}
	ctx, cancel := context.WithTimeout(ctx, lspTimeout)
	defer cancel()
	toks, err := c.semanticTokens(ctx, uri)
	if err != nil {
		return LSPResult{Status: "error", Server: &s, Installed: true, Message: err.Error()}
	}
	return LSPResult{Status: "ok", Server: &s, Installed: true, Legend: c.legend, Modifiers: c.mods, Tokens: toks}
}

// handleLSPInstall runs a catalog entry's install command. Only catalog commands run, never one
// sent by the page, and only one install runs at a time.
func (a *App) handleLSPInstall(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "POST only", http.StatusMethodNotAllowed)
		return
	}
	var req struct {
		ID string `json:"id"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	var s *lspServer
	for i := range lspServers {
		if lspServers[i].ID == req.ID {
			s = &lspServers[i]
		}
	}
	if s == nil {
		http.Error(w, "unknown language server", http.StatusBadRequest)
		return
	}
	if !a.lsp.install.TryLock() {
		http.Error(w, "another install is running", http.StatusConflict)
		return
	}
	defer a.lsp.install.Unlock()
	bin, ok := lookPath(s.Install[0])
	if !ok {
		http.Error(w, fmt.Sprintf("%s is needed to install %s, and it is not installed", s.Install[0], s.Name), http.StatusFailedDependency)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), installTimeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, bin, s.Install[1:]...)
	cmd.Dir = a.root
	cmd.Env = lspEnv()
	out, err := cmd.CombinedOutput()
	if err != nil {
		http.Error(w, strings.TrimSpace(fmt.Sprintf("%s failed: %v\n%s", strings.Join(s.Install, " "), err, lastLines(string(out), 12))), http.StatusInternalServerError)
		return
	}
	a.lsp.mu.Lock()
	delete(a.lsp.failed, s.ID)
	a.lsp.mu.Unlock()
	if _, ok := lookPath(s.Cmd[0]); !ok {
		http.Error(w, fmt.Sprintf("installed, but %s is not on PATH; add its folder to PATH and restart echo", s.Cmd[0]), http.StatusInternalServerError)
		return
	}
	writeJSON(w, map[string]any{"ok": true, "output": lastLines(string(out), 12)})
}

func lastLines(s string, n int) string {
	lines := strings.Split(strings.TrimSpace(s), "\n")
	if len(lines) > n {
		lines = lines[len(lines)-n:]
	}
	return strings.Join(lines, "\n")
}
