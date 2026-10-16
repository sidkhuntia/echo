package main

// Language servers, for two things only: go-to-definition and semantic tokens (decisions §8).
// A server is started the first time a file of its language is asked about, one process per
// repository and server, and speaks LSP over stdio. echo never installs one; a file whose server
// is not on the machine keeps its highlight.js colors.
//
// Positions are UTF-16 offsets end to end, which is the LSP default and what the browser's string
// offsets are, so nothing here converts them.

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

// lspServer is a language server echo knows how to start. Langs maps a file extension to the
// languageId the server expects.
type lspServer struct {
	ID    string
	Cmd   []string
	Langs map[string]string
	// Init is the server's initializationOptions; gopls, for one, sends no semantic tokens until asked.
	Init any
}

// lspServers is the catalog, in preference order: a file uses the first installed server that
// handles its extension.
var lspServers = []lspServer{
	{ID: "gopls", Cmd: []string{"gopls"}, Langs: map[string]string{".go": "go"}, Init: map[string]any{"semanticTokens": true}},
	{ID: "typescript", Cmd: []string{"typescript-language-server", "--stdio"}, Langs: map[string]string{
		".ts": "typescript", ".mts": "typescript", ".cts": "typescript", ".tsx": "typescriptreact",
		".js": "javascript", ".mjs": "javascript", ".cjs": "javascript", ".jsx": "javascriptreact"}},
	{ID: "basedpyright", Cmd: []string{"basedpyright-langserver", "--stdio"}, Langs: map[string]string{".py": "python", ".pyi": "python"}},
	{ID: "pyright", Cmd: []string{"pyright-langserver", "--stdio"}, Langs: map[string]string{".py": "python", ".pyi": "python"}},
	{ID: "rust-analyzer", Cmd: []string{"rust-analyzer"}, Langs: map[string]string{".rs": "rust"}},
	{ID: "clangd", Cmd: []string{"clangd"}, Langs: map[string]string{
		".c": "c", ".h": "c", ".cc": "cpp", ".cpp": "cpp", ".cxx": "cpp", ".hpp": "cpp", ".hh": "cpp", ".m": "objective-c", ".mm": "objective-cpp"}},
}

const (
	// lspTimeout bounds one request; a server still indexing answers on a later try.
	lspTimeout = 10 * time.Second
	// lspStartTimeout bounds a server's answer to initialize.
	lspStartTimeout = 30 * time.Second
	// lspRetry is how long a server that would not start is left alone before the next attempt.
	lspRetry = time.Minute
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

// searchPath is PATH plus the places installers put binaries that the PATH of an app started
// from the Dock often lacks, so a server from `go install` or `cargo` is still found.
func searchPath() string {
	home, _ := os.UserHomeDir()
	dirs := filepath.SplitList(os.Getenv("PATH"))
	extra := []string{"/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"}
	if home != "" {
		extra = append(extra, filepath.Join(home, "go", "bin"), filepath.Join(home, ".cargo", "bin"), filepath.Join(home, ".local", "bin"))
	}
	if gp := os.Getenv("GOPATH"); gp != "" {
		extra = append(extra, filepath.Join(gp, "bin"))
	}
	return strings.Join(append(dirs, extra...), string(os.PathListSeparator))
}

func lookPath(name string) (string, bool) {
	if strings.ContainsRune(name, filepath.Separator) {
		fi, err := os.Stat(name)
		return name, err == nil && !fi.IsDir() && fi.Mode()&0o111 != 0
	}
	for _, dir := range filepath.SplitList(searchPath()) {
		p := filepath.Join(dir, name)
		if fi, err := os.Stat(p); err == nil && !fi.IsDir() && fi.Mode()&0o111 != 0 {
			return p, true
		}
	}
	return "", false
}

// pickServer is the first catalog server for a path that is installed; when none is, it returns
// the first catalog entry so the page can name what is missing.
func pickServer(rel string) (s lspServer, installed, known bool) {
	list := serversFor(rel)
	if len(list) == 0 {
		return lspServer{}, false, false
	}
	for _, c := range list {
		if _, ok := lookPath(c.Cmd[0]); ok {
			return c, true, true
		}
	}
	return list[0], false, true
}

// lspClient is one running language server for this repository.
type lspClient struct {
	cmd *exec.Cmd
	in  io.WriteCloser
	wmu sync.Mutex // serializes writes to the server's stdin
	smu sync.Mutex // keeps document versions in order on the wire

	mu      sync.Mutex
	nextID  int
	pending map[int]chan lspMessage
	docs    map[string]*lspDoc
	legend  []string
	mods    []string
	tokens  bool // the server offers semanticTokens/full
	dead    chan struct{}

	// disk is what the working tree looked like at the last look, for diskChanges.
	dmu      sync.Mutex
	disk     map[string]string
	dchecked time.Time
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

// lspEntry is one server's slot in the manager: a start in progress, or its outcome.
type lspEntry struct {
	done chan struct{}
	at   time.Time
	c    *lspClient
	err  error
}

// lspManager starts servers on first use and keeps one per catalog entry.
type lspManager struct {
	root    string
	mu      sync.Mutex
	entries map[string]*lspEntry
	// closed is set when echo is stopping, so a file opened during the drain does not launch a
	// server that would outlive the process.
	closed bool
}

// lspManagers is every manager in this process: a workspace has one per repository, and a stop
// must end all of them.
var (
	lspManagersMu sync.Mutex
	lspManagers   []*lspManager
)

func newLSPManager(root string) *lspManager {
	m := &lspManager{root: root, entries: map[string]*lspEntry{}}
	lspManagersMu.Lock()
	lspManagers = append(lspManagers, m)
	lspManagersMu.Unlock()
	return m
}

// stopAllLSP ends every language server this process started, at once.
func stopAllLSP() {
	lspManagersMu.Lock()
	list := lspManagers
	lspManagersMu.Unlock()
	var wg sync.WaitGroup
	for _, m := range list {
		wg.Add(1)
		go func() { defer wg.Done(); m.stopAll() }()
	}
	wg.Wait()
}

var errLSPStopping = errors.New("echo is stopping")

func (m *lspManager) client(ctx context.Context, s lspServer) (*lspClient, error) {
	m.mu.Lock()
	if m.closed {
		m.mu.Unlock()
		return nil, errLSPStopping
	}
	e := m.entries[s.ID]
	if e != nil {
		select {
		case <-e.done:
			if e.err == nil {
				select {
				case <-e.c.dead:
					// One that died soon after starting is left alone like a failed start, so a
					// crash loop does not respawn and re-index on every request.
					if time.Since(e.at) < lspRetry {
						m.mu.Unlock()
						return nil, fmt.Errorf("%s exited; trying again shortly", s.ID)
					}
					e = nil
				default:
				}
			} else if time.Since(e.at) > lspRetry {
				e = nil
			}
		default:
		}
	}
	if e == nil {
		e = &lspEntry{done: make(chan struct{}), at: time.Now()}
		m.entries[s.ID] = e
		go func() {
			c, err := startLSP(m.root, s)
			m.mu.Lock()
			closed := m.closed
			m.mu.Unlock()
			if err == nil && closed {
				c.shutdown()
				c, err = nil, errLSPStopping
			}
			e.c, e.err = c, err
			close(e.done)
		}()
	}
	m.mu.Unlock()
	select {
	case <-e.done:
		return e.c, e.err
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

// stopAll ends every language server of this repository the way the protocol says to.
func (m *lspManager) stopAll() {
	m.mu.Lock()
	m.closed = true
	entries := m.entries
	m.entries = map[string]*lspEntry{}
	m.mu.Unlock()
	for _, e := range entries {
		<-e.done
		if e.c != nil {
			e.c.shutdown()
		}
	}
}

func startLSP(root string, s lspServer) (*lspClient, error) {
	bin, ok := lookPath(s.Cmd[0])
	if !ok {
		return nil, fmt.Errorf("%s is not installed", s.Cmd[0])
	}
	cmd := exec.Command(bin, s.Cmd[1:]...)
	cmd.Dir = root
	cmd.Env = append(os.Environ(), "PATH="+searchPath())
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
	c := &lspClient{cmd: cmd, in: in, pending: map[int]chan lspMessage{}, docs: map[string]*lspDoc{}, dead: make(chan struct{})}
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
			"workspace": map[string]any{"configuration": true, "workspaceFolders": true, "didChangeWatchedFiles": map[string]any{"dynamicRegistration": true}},
			"textDocument": map[string]any{
				"synchronization": map[string]any{"dynamicRegistration": false},
				"definition":      map[string]any{"linkSupport": true},
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
	ctx, cancel := context.WithTimeout(context.Background(), lspStartTimeout)
	defer cancel()
	res, err := c.call(ctx, "initialize", init)
	if err != nil {
		c.kill()
		return nil, fmt.Errorf("%s did not start: %v", s.Cmd[0], err)
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
	// The legend is the server's own list: token types are indexes into it, not into ours.
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

func (c *lspClient) kill() { _ = c.cmd.Process.Kill() }

// shutdown asks the server to stop the way the protocol says to, then makes sure it is gone: a
// server that is indexing or writing a cache gets the chance to finish, and one that ignores the
// request is killed, so echo never leaves one behind.
func (c *lspClient) shutdown() {
	select {
	case <-c.dead:
		return
	default:
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	_, _ = c.call(ctx, "shutdown", nil)
	cancel()
	_ = c.notify("exit", nil)
	_ = c.in.Close()
	select {
	case <-c.dead:
	case <-time.After(2 * time.Second):
		c.kill()
	}
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
	// A server that stopped reading would block this write, and with it every request and the
	// shutdown; killing the process closes the pipe and fails the write.
	t := time.AfterFunc(5*time.Second, c.kill)
	defer t.Stop()
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

// read dispatches responses to their callers and answers the server's own requests, which a
// server may wait on before it does anything else (configuration, registerCapability,
// workDoneProgress/create): configuration gets empty sections, everything else null. Notifications
// need no answer and are ignored.
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

// sync makes the server's copy of a document the editor's text. Only the document being asked
// about is held open: the others are closed first, so a file an agent changed on disk since is
// read from disk again instead of from our stale copy.
func (c *lspClient) sync(uri, lang, text string) error {
	c.smu.Lock()
	defer c.smu.Unlock()
	c.mu.Lock()
	var stale []string
	for u := range c.docs {
		if u != uri {
			stale = append(stale, u)
			delete(c.docs, u)
		}
	}
	d := c.docs[uri]
	if d != nil && d.text == text {
		c.mu.Unlock()
		return c.closeAll(stale)
	}
	if d == nil {
		d = &lspDoc{}
		c.docs[uri] = d
	}
	d.version++
	d.text = text
	v := d.version
	c.mu.Unlock()
	if err := c.closeAll(stale); err != nil {
		return err
	}
	if v == 1 {
		return c.notify("textDocument/didOpen", map[string]any{"textDocument": map[string]any{"uri": uri, "languageId": lang, "version": v, "text": text}})
	}
	return c.notify("textDocument/didChange", map[string]any{
		"textDocument":   map[string]any{"uri": uri, "version": v},
		"contentChanges": []map[string]string{{"text": text}},
	})
}

func (c *lspClient) closeAll(uris []string) error {
	for _, u := range uris {
		if err := c.notify("textDocument/didClose", map[string]any{"textDocument": map[string]string{"uri": u}}); err != nil {
			return err
		}
	}
	return nil
}

// tokenTypes and tokenModifiers are the standard LSP names echo says it can color.
var (
	tokenTypes     = []string{"namespace", "type", "class", "enum", "interface", "struct", "typeParameter", "parameter", "variable", "property", "enumMember", "event", "function", "method", "macro", "keyword", "modifier", "comment", "string", "number", "regexp", "operator", "decorator", "label"}
	tokenModifiers = []string{"declaration", "definition", "readonly", "static", "deprecated", "abstract", "async", "modification", "documentation", "defaultLibrary"}
)

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

// LSPLocation is where a definition is. Path is repository-relative; a definition outside the
// repository carries External (its absolute path) instead, which the page names but cannot open.
type LSPLocation struct {
	Path      string `json:"path,omitempty"`
	External  string `json:"external,omitempty"`
	Line      int    `json:"line"`
	Character int    `json:"character"`
}

// LSPResult tells the page what a request found. Status is "ok", "none" (no known server for the
// file), "missing" (a server exists but is not installed; Message names it), "unsupported" (the
// server offers no semantic tokens) or "error".
type LSPResult struct {
	Status    string        `json:"status"`
	Message   string        `json:"message,omitempty"`
	Legend    []string      `json:"legend,omitempty"`
	Modifiers []string      `json:"modifiers,omitempty"`
	Tokens    []uint32      `json:"tokens,omitempty"`
	Locations []LSPLocation `json:"locations,omitempty"`
}

type lspRequest struct {
	Path      string `json:"path"`
	Content   string `json:"content"`
	Line      int    `json:"line"`
	Character int    `json:"character"`
}

// lspOpen finds, starts and syncs the server for a file. A non-nil result is the answer to give
// instead of going on.
func (a *App) lspOpen(ctx context.Context, req lspRequest) (*lspClient, string, string, *LSPResult) {
	abs, err := a.safeContent(req.Path)
	if err != nil || req.Path == "" {
		return nil, "", "", &LSPResult{Status: "error", Message: "invalid path"}
	}
	s, installed, known := pickServer(abs)
	if !known {
		return nil, "", "", &LSPResult{Status: "none"}
	}
	if !installed {
		return nil, "", "", &LSPResult{Status: "missing", Message: s.Cmd[0]}
	}
	c, err := a.lsp.client(ctx, s)
	if err != nil {
		return nil, "", "", &LSPResult{Status: "error", Message: lspErrMessage(err)}
	}
	a.diskChanges(ctx, c)
	uri := fileURI(abs)
	if err := c.sync(uri, s.Langs[strings.ToLower(filepath.Ext(abs))], req.Content); err != nil {
		return nil, "", "", &LSPResult{Status: "error", Message: err.Error()}
	}
	return c, uri, abs, nil
}

// lspErrMessage turns a timeout into what the user can act on: the server is usually still
// indexing, and asking again works.
func lspErrMessage(err error) string {
	if errors.Is(err, context.DeadlineExceeded) {
		return "The language server is still starting or indexing. Try again in a moment."
	}
	return err.Error()
}

func readLSPRequest(w http.ResponseWriter, r *http.Request) (lspRequest, bool) {
	var req lspRequest
	if r.Method != http.MethodPost {
		http.Error(w, "POST required", http.StatusMethodNotAllowed)
		return req, false
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return req, false
	}
	return req, true
}

// handleLSPTokens answers with the semantic tokens of the editor's text.
func (a *App) handleLSPTokens(w http.ResponseWriter, r *http.Request) {
	req, ok := readLSPRequest(w, r)
	if !ok {
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), lspTimeout)
	defer cancel()
	c, uri, _, res := a.lspOpen(ctx, req)
	if res != nil {
		writeJSON(w, res)
		return
	}
	if !c.tokens {
		writeJSON(w, LSPResult{Status: "unsupported"})
		return
	}
	toks, err := c.semanticTokens(ctx, uri)
	if err != nil {
		writeJSON(w, LSPResult{Status: "error", Message: lspErrMessage(err)})
		return
	}
	writeJSON(w, LSPResult{Status: "ok", Legend: c.legend, Modifiers: c.mods, Tokens: toks})
}

// handleLSPDefinition answers where the symbol at a position is defined. The editor's text is
// synced first, so an unsaved edit does not shift the answer.
func (a *App) handleLSPDefinition(w http.ResponseWriter, r *http.Request) {
	req, ok := readLSPRequest(w, r)
	if !ok {
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), lspTimeout)
	defer cancel()
	c, uri, _, res := a.lspOpen(ctx, req)
	if res != nil {
		writeJSON(w, res)
		return
	}
	raw, err := c.call(ctx, "textDocument/definition", map[string]any{
		"textDocument": map[string]string{"uri": uri},
		"position":     map[string]int{"line": req.Line, "character": req.Character},
	})
	if err != nil {
		writeJSON(w, LSPResult{Status: "error", Message: lspErrMessage(err)})
		return
	}
	writeJSON(w, LSPResult{Status: "ok", Locations: a.lspLocations(raw)})
}

// lspLocations reads a definition answer, which is null, one Location, a list of Locations, or a
// list of LocationLinks, into repository paths.
func (a *App) lspLocations(raw json.RawMessage) []LSPLocation {
	type pos struct {
		Line      int `json:"line"`
		Character int `json:"character"`
	}
	type rng struct {
		Start pos `json:"start"`
	}
	type item struct {
		URI                  string `json:"uri"`
		Range                rng    `json:"range"`
		TargetURI            string `json:"targetUri"`
		TargetSelectionRange rng    `json:"targetSelectionRange"`
	}
	var items []item
	if err := json.Unmarshal(raw, &items); err != nil {
		var one item
		if json.Unmarshal(raw, &one) != nil {
			return nil
		}
		items = []item{one}
	}
	out := []LSPLocation{}
	for _, it := range items {
		u, start := it.URI, it.Range.Start
		if it.TargetURI != "" {
			u, start = it.TargetURI, it.TargetSelectionRange.Start
		}
		parsed, err := url.Parse(u)
		if err != nil || parsed.Scheme != "file" {
			continue
		}
		loc := LSPLocation{Line: start.Line, Character: start.Character}
		if rel, ok := a.relInRepo(parsed.Path); ok {
			loc.Path = rel
		} else {
			loc.External = parsed.Path
		}
		out = append(out, loc)
	}
	return out
}

// relInRepo maps an absolute path to a repository-relative one when it is inside the repository
// (also by real path, because /var and /private/var name the same folder on macOS).
func (a *App) relInRepo(abs string) (string, bool) {
	inside := func(root, p string) (string, bool) {
		rel, err := filepath.Rel(root, p)
		if err != nil || rel == "." || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
			return "", false
		}
		return filepath.ToSlash(rel), true
	}
	if rel, ok := inside(a.root, abs); ok {
		return rel, true
	}
	root, err1 := filepath.EvalSymlinks(a.root)
	real, err2 := filepath.EvalSymlinks(abs)
	if err1 != nil || err2 != nil {
		return "", false
	}
	return inside(root, real)
}

// diskChanges tells a server about files that changed on disk since it last looked. Coding agents
// edit files echo never opened, and a server does not watch the disk itself, so without this a
// definition would point at where a function used to be. The changed files are the working tree's
// uncommitted ones (one `git status`, at most once a second); the first look only records them,
// because the server has just read the disk. A checkout or commit that rewrites files is not
// noticed until the server restarts.
func (a *App) diskChanges(ctx context.Context, c *lspClient) {
	c.dmu.Lock()
	defer c.dmu.Unlock()
	if time.Since(c.dchecked) < time.Second || a.noGit {
		return
	}
	c.dchecked = time.Now()
	// Bounded, because dmu is held: a stalled git must not queue every later request behind it.
	gctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	outB, err := a.gitCmdContext(gctx, "status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all").Output()
	out := string(outB)
	if err != nil {
		return
	}
	first := c.disk == nil
	now := map[string]string{}
	var events []map[string]any
	for _, ch := range parsePorcelain(out) {
		abs := filepath.Join(a.root, ch.Path)
		sig, kind := "gone", 3
		if fi, err := os.Stat(abs); err == nil && !fi.IsDir() {
			sig, kind = fmt.Sprint(fi.ModTime().UnixNano(), ":", fi.Size()), 2
		}
		now[ch.Path] = sig
		if old, had := c.disk[ch.Path]; !first && old != sig {
			if !had && kind == 2 {
				kind = 1
			}
			events = append(events, map[string]any{"uri": fileURI(abs), "type": kind})
		}
	}
	// A file that left the list was committed, reverted or deleted: its content changed too.
	for path := range c.disk {
		if _, still := now[path]; !still {
			abs := filepath.Join(a.root, path)
			kind := 2
			if _, err := os.Stat(abs); err != nil {
				kind = 3
			}
			events = append(events, map[string]any{"uri": fileURI(abs), "type": kind})
		}
	}
	c.disk = now
	if len(events) > 0 {
		_ = c.notify("workspace/didChangeWatchedFiles", map[string]any{"changes": events})
	}
}
