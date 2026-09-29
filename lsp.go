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
	"sort"
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
	// Env returns extra environment for the server process, such as a JAVA_HOME it can run on.
	Env func() []string `json:"-"`
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
		Langs: map[string]string{".java": "java"}, Env: func() []string { return javaHomeEnv(21) }},
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
// extra entries (KEY=value) replace inherited ones.
func lspEnv(extra ...string) []string {
	skip := map[string]bool{"PATH": true}
	for _, kv := range extra {
		k, _, _ := strings.Cut(kv, "=")
		skip[k] = true
	}
	env := []string{}
	for _, kv := range os.Environ() {
		if k, _, _ := strings.Cut(kv, "="); !skip[k] {
			env = append(env, kv)
		}
	}
	return append(append(env, extra...), "PATH="+searchPath())
}

// javaHomeEnv finds a JDK of at least version min when the inherited JAVA_HOME is older. Shells
// often pin JAVA_HOME to a project's JDK (17, say) while jdtls itself needs 21, so only the server
// process gets the newer one; the project still builds against whatever it configures.
func javaHomeEnv(min int) []string {
	if cur := os.Getenv("JAVA_HOME"); cur == "" || javaMajor(cur) >= min {
		return nil
	}
	if out, err := exec.Command("/usr/libexec/java_home", "-v", fmt.Sprintf("%d+", min)).Output(); err == nil {
		if home := strings.TrimSpace(string(out)); javaMajor(home) >= min {
			return []string{"JAVA_HOME=" + home}
		}
	}
	for _, home := range []string{"/opt/homebrew/opt/openjdk/libexec/openjdk.jdk/Contents/Home", "/usr/local/opt/openjdk/libexec/openjdk.jdk/Contents/Home"} {
		if javaMajor(home) >= min {
			return []string{"JAVA_HOME=" + home}
		}
	}
	return nil
}

// javaMajor reads a JDK's major version from its release file (JAVA_VERSION="17.0.2"), or 0.
func javaMajor(home string) int {
	data, err := os.ReadFile(filepath.Join(home, "release"))
	if err != nil {
		return 0
	}
	for _, line := range strings.Split(string(data), "\n") {
		if v, ok := strings.CutPrefix(line, "JAVA_VERSION="); ok {
			v = strings.Trim(strings.TrimSpace(v), `"`)
			v = strings.TrimPrefix(v, "1.") // 1.8 is Java 8
			if f := strings.FieldsFunc(v, func(r rune) bool { return r < '0' || r > '9' }); len(f) > 0 {
				n, _ := strconv.Atoi(f[0])
				return n
			}
			return 0
		}
	}
	return 0
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
	started time.Time
	// progress holds the server's running work by token; note is jdtls's language/status text.
	progress map[string]lspProgress
	note     string
	stderr   *tail
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
	failed map[string]string
	// starting holds servers between launch and their initialize answer; the lock is not held
	// meanwhile, so the status popover never waits behind a slow start.
	starting map[string]time.Time
	// closed is set when echo is stopping, so a file opened during the drain does not launch a
	// server that would outlive the process.
	closed  bool
	wake    *sync.Cond
	install sync.Mutex
}

func newLSPManager(root string) *lspManager {
	m := &lspManager{root: root, clients: map[string]*lspClient{}, failed: map[string]string{}, starting: map[string]time.Time{}}
	m.wake = sync.NewCond(&m.mu)
	return m
}

func (m *lspManager) client(s lspServer) (*lspClient, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	for {
		if m.closed {
			return nil, errors.New("echo is stopping")
		}
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
		if _, ok := m.starting[s.ID]; !ok {
			break
		}
		m.wake.Wait()
	}
	m.starting[s.ID] = time.Now()
	m.mu.Unlock()
	c, err := startLSP(m.root, s)
	m.mu.Lock()
	delete(m.starting, s.ID)
	m.wake.Broadcast()
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
	var extra []string
	if s.Env != nil {
		extra = s.Env()
	}
	cmd.Env = lspEnv(extra...)
	stderr := &tail{}
	cmd.Stderr = stderr
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
	c := &lspClient{server: s, cmd: cmd, in: in, pending: map[int]chan lspMessage{}, docs: map[string]*lspDoc{}, dead: make(chan struct{}),
		started: time.Now(), progress: map[string]lspProgress{}, stderr: stderr}
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
			"window":    map[string]any{"workDoneProgress": true},
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
		// The last stderr line is usually the reason ("jdtls requires at least Java 21"); lead with it.
		if why := stderr.String(); why != "" {
			lines := strings.Split(why, "\n")
			return nil, fmt.Errorf("%s did not start: %s\n%s", s.Name, strings.TrimSpace(lines[len(lines)-1]), why)
		}
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

// shutdown asks the server to stop the way the protocol says to, then makes sure it is gone. The
// request and the exit notification give a server that is indexing or writing a cache the chance to
// finish; a server that ignores them is killed, so echo never leaves one behind either way.
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

// stopAll ends every language server echo started. The wake broadcast matters: a request waiting
// for a server that is starting is released by it, and then sees the manager is closed and gives up
// rather than launching a replacement while echo is on its way out.
func (m *lspManager) stopAll() {
	m.mu.Lock()
	clients := m.clients
	m.clients = map[string]*lspClient{}
	m.closed = true
	m.wake.Broadcast()
	m.mu.Unlock()
	for _, c := range clients {
		c.shutdown()
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
		if json.Unmarshal(body, &msg) != nil {
			continue
		}
		if msg.ID == nil {
			c.notification(msg)
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

// progress records what the server says it is doing ($/progress, and jdtls's language/status),
// so the status bar can show "Importing Maven project 40%" instead of silence.
func (c *lspClient) notification(msg lspMessage) {
	switch msg.Method {
	case "$/progress":
		var p struct {
			Token json.RawMessage `json:"token"`
			Value struct {
				Kind       string `json:"kind"`
				Title      string `json:"title"`
				Message    string `json:"message"`
				Percentage *int   `json:"percentage"`
			} `json:"value"`
		}
		if json.Unmarshal(msg.Params, &p) != nil {
			return
		}
		key := string(p.Token)
		c.mu.Lock()
		defer c.mu.Unlock()
		if p.Value.Kind == "end" {
			delete(c.progress, key)
			return
		}
		pr := c.progress[key]
		if p.Value.Kind == "begin" {
			pr = lspProgress{title: p.Value.Title}
		}
		pr.message, pr.percent = p.Value.Message, p.Value.Percentage
		c.progress[key] = pr
	case "language/status":
		var p struct {
			Type    string `json:"type"`
			Message string `json:"message"`
		}
		if json.Unmarshal(msg.Params, &p) != nil {
			return
		}
		c.mu.Lock()
		defer c.mu.Unlock()
		if p.Type == "ServiceReady" || p.Type == "Started" {
			c.note = ""
		} else if p.Type == "Starting" || p.Type == "ProjectStatus" {
			c.note = p.Message
		}
	}
}

// lspProgress is one piece of running work: a begin's title plus the latest report.
type lspProgress struct {
	title, message string
	percent        *int
}

func (p lspProgress) String() string {
	parts := []string{}
	for _, s := range []string{p.title, p.message} {
		if s != "" {
			parts = append(parts, s)
		}
	}
	text := strings.Join(parts, " · ")
	if p.percent != nil {
		text += fmt.Sprintf(" %d%%", *p.percent)
	}
	return strings.TrimSpace(text)
}

// tail keeps the last few KB a server wrote to stderr, to explain why it failed.
type tail struct {
	mu  sync.Mutex
	buf []byte
}

func (t *tail) Write(p []byte) (int, error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.buf = append(t.buf, p...)
	if len(t.buf) > 4096 {
		t.buf = t.buf[len(t.buf)-4096:]
	}
	return len(p), nil
}

func (t *tail) String() string {
	t.mu.Lock()
	defer t.mu.Unlock()
	return lastLines(string(t.buf), 6)
}

// LSPStatus is one catalog entry as the status popover shows it. State is "missing", "stopped"
// (installed, not needed yet), "starting", "busy" (indexing), "ready", "unsupported" (no
// highlighting), "failed" (would not start), or "exited".
type LSPStatus struct {
	lspServer
	Exts     []string `json:"exts"`
	Path     string   `json:"path,omitempty"`
	State    string   `json:"state"`
	Message  string   `json:"message,omitempty"`
	Progress []string `json:"progress,omitempty"`
	Since    int64    `json:"since,omitempty"`
}

func (a *App) handleLSPStatus(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, a.lsp.status())
}

func (m *lspManager) status() []LSPStatus {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]LSPStatus, 0, len(lspServers))
	for i := range lspServers {
		s := &lspServers[i]
		st := LSPStatus{lspServer: *s, State: "missing"}
		for ext := range s.Langs {
			st.Exts = append(st.Exts, ext)
		}
		sort.Strings(st.Exts)
		if p, ok := lookPath(s.Cmd[0]); ok {
			st.Path, st.State = p, "stopped"
		}
		if t, ok := m.starting[s.ID]; ok {
			st.State, st.Since = "starting", t.Unix()
		} else if msg, ok := m.failed[s.ID]; ok {
			st.State, st.Message = "failed", msg
		} else if c := m.clients[s.ID]; c != nil {
			st.Since = c.started.Unix()
			select {
			case <-c.dead:
				st.State, st.Message = "exited", c.stderr.String()
			default:
				c.mu.Lock()
				for _, p := range c.progress {
					st.Progress = append(st.Progress, p.String())
				}
				if c.note != "" {
					st.Progress = append(st.Progress, c.note)
				}
				c.mu.Unlock()
				sort.Strings(st.Progress)
				switch {
				case !c.tokens:
					st.State = "unsupported"
				case len(st.Progress) > 0:
					st.State = "busy"
				default:
					st.State = "ready"
				}
			}
		}
		out = append(out, st)
	}
	return out
}

// handleLSPRestart stops a server and forgets a failed start; the next file that needs it starts it again.
func (a *App) handleLSPRestart(w http.ResponseWriter, r *http.Request) {
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
	a.lsp.mu.Lock()
	c := a.lsp.clients[req.ID]
	delete(a.lsp.clients, req.ID)
	delete(a.lsp.failed, req.ID)
	a.lsp.mu.Unlock()
	if c != nil {
		c.kill()
	}
	writeJSON(w, map[string]bool{"ok": true})
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
