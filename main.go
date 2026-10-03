package main

import (
	"archive/zip"
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"embed"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"io/fs"
	"mime"
	"net"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"regexp"
	"runtime"
	"runtime/debug"
	"slices"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

//go:embed web
var webFS embed.FS

// The embedded Geist fonts are woff2, which the mime package only knows from the system's tables.
func init() { mime.AddExtensionType(".woff2", "font/woff2") }

// build identifies the embedded web assets, so a page loaded from an older binary can tell it is stale.
var build = func() string {
	h := sha256.New()
	fs.WalkDir(webFS, "web", func(p string, d fs.DirEntry, err error) error {
		if err == nil && !d.IsDir() {
			b, _ := webFS.ReadFile(p)
			h.Write([]byte(p))
			h.Write(b)
		}
		return nil
	})
	return hex.EncodeToString(h.Sum(nil))[:12]
}()

// version is stamped by the release build (-X main.version=...). A `go install` build reads it
// from the module instead.
var version = "dev"

func buildVersion() string {
	if version != "dev" {
		return version
	}
	if bi, ok := debug.ReadBuildInfo(); ok && bi.Main.Version != "" && bi.Main.Version != "(devel)" {
		return strings.TrimPrefix(bi.Main.Version, "v")
	}
	return version
}

// Without -port, echo takes the first free port in this range, so several repositories can be open at once.
const (
	firstPort = 6030
	lastPort  = 6049
)

// shutdownGrace is how long a stop waits for in-flight requests before closing the connections
// anyway. It is short because the work echo does is a git call or a read, and a browser tab holds
// an open status stream, so waiting for a perfect drain would mean waiting for the deadline.
const shutdownGrace = 3 * time.Second

type Config struct {
	Vim        bool   `json:"vim"`
	Theme      string `json:"theme"`
	DiffMode   string `json:"diffMode"`
	GutterBase string `json:"gutterBase"`
	// Blame is "line" (show who last changed the caret line) or "off".
	Blame string `json:"blame"`
	// CommitAll makes the Commit button stage everything first (after the page asks).
	CommitAll  bool           `json:"commitAll"`
	Panels     []string       `json:"panels"`
	PanelSizes map[string]int `json:"panelSizes"`
	// GitPinned docks the Git panel as a column instead of a drawer over the review.
	GitPinned bool `json:"gitPinned"`
	// SwapPanels puts the sidebar on the right and the Git panel and its rail on the left.
	SwapPanels bool `json:"swapPanels"`
	// ShowRail keeps the Git rail (Commit, History, Branches) visible beside the review. Off by
	// default: the title bar's Git button and ⌘J open the panel, and the button carries the badge.
	ShowRail bool `json:"showRail"`
}

type App struct {
	root  string
	port  int
	hosts map[string]bool
	// token is the secret every request must carry (cookie or header); empty turns the check off, as in tests.
	token string
	mu    sync.Mutex
	// writeMu serializes saves, so a save's stale-base check and its write cannot interleave with another save.
	writeMu sync.Mutex
	// stateMu serializes the page's per-repository JSON documents (review notes, drafts).
	stateMu sync.Mutex
	sigs    map[string]fileSig
	// refs caches the slow half of the status; see refsPart.
	refsMu    sync.Mutex
	refs      refsPart
	dirsMu    sync.Mutex
	gitDir    string
	gitCommon string
	hub       statusHub
	// net serializes network actions; a second fetch/pull/push while one runs is refused, not queued.
	net sync.Mutex
	// srv is the running server, so the page can ask for a graceful stop. It is nil in tests,
	// which drive routes() over their own listener; stopping then just closes the app.
	srv *http.Server
	// done closes when a shutdown starts, so handlers that wait on their own (the status stream)
	// can return instead of holding the drain open until the deadline.
	done chan struct{}
	// stop keeps a second stop request from starting a second shutdown.
	stop sync.Once
	// running lists the other echo processes. It is a field so a test can name its own servers
	// instead of the real ones on this machine, which a "quit all" would otherwise stop.
	running func() []Instance
}

// Instance is what one echo process reports about itself, so its siblings can list it in the repo switcher.
type Instance struct {
	Root    string `json:"root"`
	Port    int    `json:"port"`
	Branch  string `json:"branch"`
	Changes int    `json:"changes"`
}

func main() {
	port := flag.Int("port", 0, fmt.Sprintf("port to listen on (default: this repository's last port, else the first free one in %d-%d)", firstPort, lastPort))
	noOpen := flag.Bool("no-open", false, "do not launch a browser")
	showVersion := flag.Bool("version", false, "print the version and exit")
	flag.Parse()
	if *showVersion {
		fmt.Println("echo", buildVersion())
		return
	}

	root, err := os.Getwd()
	if err != nil {
		fatal(err)
	}
	if flag.NArg() > 0 {
		root = flag.Arg(0)
	}
	root, err = filepath.Abs(root)
	if err != nil {
		fatal(err)
	}

	open := func(url string) {
		if !*noOpen {
			_ = openBrowser(url)
		}
	}
	authToken = loadToken()
	if *port == 0 {
		if p := runningFor(root, instances()); p != 0 {
			url := "http://127.0.0.1:" + strconv.Itoa(p) + "/?t=" + authToken
			fmt.Printf("echo %s is already open at %s\n", root, url)
			open(url)
			return
		}
	}
	ln, err := listen(root, *port)
	if err != nil {
		fatal(err)
	}
	bound := ln.Addr().(*net.TCPAddr).Port
	if *port == 0 {
		rememberPort(root, bound)
	}

	app := newApp(root, bound)
	app.token = authToken
	url := "http://127.0.0.1:" + strconv.Itoa(bound) + "/?t=" + authToken
	fmt.Printf("echo %s\n", root)
	fmt.Printf("open %s\n", url)
	open(url)

	// A terminal interrupt asks for the same graceful stop the page's Stop button does: finish what
	// is in flight, let the language servers exit, and only then close the port.
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	srv := &http.Server{
		Handler: app.routes(),
		// No write timeout: the status stream stays open. These stop a stalled client holding a socket.
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       2 * time.Minute,
		MaxHeaderBytes:    64 << 10,
	}
	app.srv = srv
	go func() {
		<-ctx.Done()
		app.shutdown("signal")
	}()
	if err := srv.Serve(ln); err != nil && !errors.Is(err, http.ErrServerClosed) {
		fatal(err)
	}
}

// listen binds an explicit port exactly. Otherwise it tries the repository's last port, then ports
// no other repository has used, then any port in the range, so each repository tends to keep its
// port and with it the browser storage (reviewed marks) that is scoped to that origin.
func listen(root string, port int) (net.Listener, error) {
	if port != 0 {
		return net.Listen("tcp", "127.0.0.1:"+strconv.Itoa(port))
	}
	for _, p := range portOrder(root, loadPorts()) {
		if ln, err := net.Listen("tcp", "127.0.0.1:"+strconv.Itoa(p)); err == nil {
			return ln, nil
		}
	}
	return nil, fmt.Errorf("ports %d-%d are all in use; pass -port", firstPort, lastPort)
}

func portOrder(root string, known map[string]int) []int {
	claimed := map[int]bool{}
	for r, p := range known {
		if r != root {
			claimed[p] = true
		}
	}
	var own, free, taken []int
	if p := known[root]; p >= firstPort && p <= lastPort {
		own = append(own, p)
	}
	for p := firstPort; p <= lastPort; p++ {
		switch {
		case len(own) > 0 && p == own[0]:
		case claimed[p]:
			taken = append(taken, p)
		default:
			free = append(free, p)
		}
	}
	return append(append(own, free...), taken...)
}

func runningFor(root string, list []Instance) int {
	for _, in := range list {
		if in.Root == root {
			return in.Port
		}
	}
	return 0
}

// instances asks every port in the range whether an echo is serving there. Closed ports refuse
// at once, so the scan costs about one round trip.
func instances() []Instance {
	client := &http.Client{Timeout: 700 * time.Millisecond}
	found := make([]*Instance, lastPort-firstPort+1)
	var wg sync.WaitGroup
	for p := firstPort; p <= lastPort; p++ {
		wg.Add(1)
		go func(p int) {
			defer wg.Done()
			req, _ := http.NewRequest(http.MethodGet, "http://127.0.0.1:"+strconv.Itoa(p)+"/api/instance", nil)
			req.Header.Set(tokenHeader, authToken)
			res, err := client.Do(req)
			if err != nil {
				return
			}
			defer res.Body.Close()
			var in Instance
			// Anything else listening on the port fails this check and is ignored.
			if res.StatusCode == http.StatusOK && json.NewDecoder(io.LimitReader(res.Body, 1<<16)).Decode(&in) == nil && in.Root != "" && in.Port == p {
				found[p-firstPort] = &in
			}
		}(p)
	}
	wg.Wait()
	out := []Instance{}
	for _, in := range found {
		if in != nil {
			out = append(out, *in)
		}
	}
	return out
}

func newApp(root string, port int) *App {
	p := strconv.Itoa(port)
	app := &App{
		root:  root,
		port:  port,
		sigs:  map[string]fileSig{},
		hosts: map[string]bool{"127.0.0.1:" + p: true, "localhost:" + p: true},
		done:  make(chan struct{}),
	}
	app.running = func() []Instance { return instances() }
	return app
}

func (a *App) routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/api/tree", a.handleTree)
	mux.HandleFunc("/api/file", a.handleFile)
	mux.HandleFunc("/api/raw", a.handleRaw)
	mux.HandleFunc("/api/git/status", a.handleGitStatus)
	mux.HandleFunc("/api/git", a.handleGit)
	mux.HandleFunc("/api/diff", a.handleDiff)
	// Not /api/log: ad and tracker blockers refuse requests to URLs that look like analytics logging.
	mux.HandleFunc("/api/history", a.handleLog)
	mux.HandleFunc("/api/commit", a.handleCommit)
	mux.HandleFunc("/api/blame", a.handleBlame)
	mux.HandleFunc("/api/search", a.handleSearch)
	a.addEndpoints(mux)
	mux.HandleFunc("/api/commit/contains", a.handleContains)
	mux.HandleFunc("/api/reset/preview", a.handleResetPreview)
	mux.HandleFunc("/api/stream", a.handleStream)
	mux.HandleFunc("/api/config", a.handleConfig)
	mux.HandleFunc("/api/instance", a.handleInstance)
	mux.HandleFunc("/api/instances", a.handleInstances)
	mux.HandleFunc("/api/shutdown", a.handleShutdown)

	assets, err := fs.Sub(webFS, "web")
	if err != nil {
		panic(err)
	}
	files := http.FileServer(http.FS(assets))
	// Embedded files carry no modification time, so tell the browser to revalidate instead of guessing.
	mux.Handle("/", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if f, ok := mermaidAsset(r.URL.Path); ok {
			serveMermaid(w, r, f)
			return
		}
		w.Header().Set("Cache-Control", "no-cache")
		files.ServeHTTP(w, r)
	}))
	return a.guard(mux)
}

// The diagram renderer (vendor/mermaid.zip) ships zipped: mermaid's ESM build is 5.4 MB as
// loose files and 1.6 MB as a zip, and it is served out of the archive rather than unpacked into
// the binary. Only the pages with a mermaid fence ever ask for it.
const mermaidPrefix = "/vendor/mermaid/"

//go:embed vendor/mermaid.zip
var mermaidZip []byte

var mermaidFiles = func() map[string]*zip.File {
	r, err := zip.NewReader(bytes.NewReader(mermaidZip), int64(len(mermaidZip)))
	if err != nil {
		panic(err)
	}
	m := make(map[string]*zip.File, len(r.File))
	for _, f := range r.File {
		m[f.Name] = f
	}
	return m
}()

// mermaidAsset maps a request path to a file in the archive.
func mermaidAsset(urlPath string) (*zip.File, bool) {
	if !strings.HasPrefix(urlPath, mermaidPrefix) {
		return nil, false
	}
	name := strings.TrimPrefix(urlPath, mermaidPrefix)
	if strings.Contains(name, "..") {
		return nil, false
	}
	f, ok := mermaidFiles[name]
	if !ok || f.FileInfo().IsDir() {
		return nil, false
	}
	return f, true
}

func serveMermaid(w http.ResponseWriter, r *http.Request, f *zip.File) {
	rc, err := f.Open()
	if err != nil {
		http.Error(w, "cannot read asset", http.StatusInternalServerError)
		return
	}
	defer rc.Close()
	// A zip entry reads forwards only, so it is unpacked for the one response that asks for it.
	b, err := io.ReadAll(rc)
	if err != nil {
		http.Error(w, "cannot read asset", http.StatusInternalServerError)
		return
	}
	// .mjs is unknown to the mime package, and a module served as octet-stream is refused.
	w.Header().Set("Content-Type", "text/javascript; charset=utf-8")
	w.Header().Set("Cache-Control", "no-cache")
	// The zip carries a modification time, so a reloading browser gets a 304 instead of the file.
	http.ServeContent(w, r, f.Name, f.Modified, bytes.NewReader(b))
}

// csp is what every page and asset is served under: echo loads nothing from elsewhere, runs no
// inline script, and cannot be framed.
const csp = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; " +
	"font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"

// maxBody caps a request body; the largest legitimate one is a file being saved.
const maxBody = 64 << 20

// guard only admits requests from echo's own page: a foreign Host means DNS rebinding,
// a foreign Origin means another site, and a non-JSON write is a CSRF-style simple request.
func (a *App) guard(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !a.hosts[r.Host] {
			http.Error(w, "forbidden host", http.StatusForbidden)
			return
		}
		if origin := r.Header.Get("Origin"); origin != "" && origin != "http://"+r.Host {
			http.Error(w, "forbidden origin", http.StatusForbidden)
			return
		}
		if !a.authorized(w, r) {
			return
		}
		h := w.Header()
		h.Set("Content-Security-Policy", csp)
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("X-Frame-Options", "DENY")
		h.Set("Referrer-Policy", "no-referrer")
		h.Set("Cross-Origin-Resource-Policy", "same-origin")
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			if ct, _, _ := mime.ParseMediaType(r.Header.Get("Content-Type")); ct != "application/json" {
				http.Error(w, "content type must be application/json", http.StatusUnsupportedMediaType)
				return
			}
			r.Body = http.MaxBytesReader(w, r.Body, maxBody)
		}
		next.ServeHTTP(w, r)
	})
}

// handleConfig reads the config from disk and applies a POST as a patch onto the file, so echo
// processes for different repositories, which share one config file, do not undo each other's settings.
func (a *App) handleConfig(w http.ResponseWriter, r *http.Request) {
	// The lock serializes this process's read-modify-write of the file.
	a.mu.Lock()
	defer a.mu.Unlock()
	cfg := loadConfig()
	if r.Method != http.MethodGet {
		if err := json.NewDecoder(r.Body).Decode(&cfg); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		if err := validateConfig(cfg); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		if err := saveConfig(cfg); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
	}
	writeJSON(w, cfg)
}

var themeName = regexp.MustCompile(`^[a-z0-9][a-z0-9_-]{0,63}$`)

// validateConfig refuses settings the page could never have produced, so a stray POST cannot
// fill the config file with junk or crash the page that reads it back.
func validateConfig(c Config) error {
	if c.Theme != "" && !themeName.MatchString(c.Theme) {
		return errors.New("invalid theme name")
	}
	if !slices.Contains([]string{"", "unified", "split"}, c.DiffMode) {
		return errors.New("invalid diffMode")
	}
	if !slices.Contains([]string{"", "head", "index"}, c.GutterBase) {
		return errors.New("invalid gutterBase")
	}
	if !slices.Contains([]string{"", "line", "off"}, c.Blame) {
		return errors.New("invalid blame")
	}
	if len(c.Panels) > 8 {
		return errors.New("too many panels")
	}
	for _, p := range c.Panels {
		if !themeName.MatchString(p) {
			return errors.New("invalid panel name")
		}
	}
	if len(c.PanelSizes) > 8 {
		return errors.New("too many panel sizes")
	}
	for k, v := range c.PanelSizes {
		if !themeName.MatchString(k) || v < 0 || v > 4000 {
			return errors.New("invalid panel size")
		}
	}
	return validateEditorConfig(c)
}

func (a *App) handleInstance(w http.ResponseWriter, r *http.Request) {
	in := Instance{Root: a.root, Port: a.port}
	if out, err := a.git("branch", "--show-current"); err == nil {
		in.Branch = strings.TrimSpace(out)
	}
	if out, err := a.git("status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all"); err == nil {
		in.Changes = len(parsePorcelain(out))
	}
	writeJSON(w, in)
}

// handleInstances lists the running echo processes. The server asks its siblings, so the page
// never makes a cross-origin request and the Host/Origin guard stays strict.
func (a *App) handleInstances(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, instances())
}

// handleShutdown stops this process, or one other process when the page names its port. Stopping a
// sibling is the same request this process makes of itself, so the page never needs a
// cross-origin call and the Host/Origin guard still admits only echo's own pages.
func (a *App) handleShutdown(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "POST only", http.StatusMethodNotAllowed)
		return
	}
	var req struct {
		// Port is the echo process to stop; 0 means this one.
		Port int `json:"port"`
		// All asks for every running process to stop, this one included.
		All bool `json:"all"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	if req.All {
		// Ask the siblings first and this one last, so the list the page is looking at is still there.
		for _, in := range a.running() {
			if in.Port != a.port {
				stopInstance(in.Port)
			}
		}
		go a.shutdown("page")
		writeJSON(w, map[string]bool{"ok": true})
		return
	}
	if req.Port == 0 || req.Port == a.port {
		go a.shutdown("page")
		writeJSON(w, map[string]bool{"ok": true})
		return
	}
	if req.Port < firstPort || req.Port > lastPort {
		http.Error(w, "port is outside the range echo uses", http.StatusBadRequest)
		return
	}
	if !stopInstance(req.Port) {
		http.Error(w, "no echo is running on that port", http.StatusNotFound)
		return
	}
	writeJSON(w, map[string]bool{"ok": true})
}

// stopInstance asks the echo on a port to stop, and reports whether one was there to answer.
func stopInstance(port int) bool {
	// Its own transport, without pooled connections. A pooled one would be a keep-alive connection
	// to a process that has since exited, and Go does not retry a POST, so the stop would be sent
	// into a closed socket and the sibling would keep running.
	client := &http.Client{Transport: &http.Transport{DisableKeepAlives: true}, Timeout: 2 * time.Second}
	req, err := http.NewRequest(http.MethodPost, "http://127.0.0.1:"+strconv.Itoa(port)+"/api/shutdown", strings.NewReader("{}"))
	if err != nil {
		return false
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set(tokenHeader, authToken)
	res, err := client.Do(req)
	if err != nil {
		return false
	}
	defer res.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(res.Body, 1<<16))
	return res.StatusCode == http.StatusOK
}

// shutdown asks the server to stop, once. It ends the status stream first, because that handler
// waits for a tick and would otherwise hold the drain open; then it gives in-flight requests the
// grace period, and closes what is left.
func (a *App) shutdown(why string) {
	a.stop.Do(func() {
		if a.done != nil {
			close(a.done)
		}
		if a.srv == nil {
			return
		}
		fmt.Printf("echo %s is stopping (%s)\n", a.root, why)
		ctx, cancel := context.WithTimeout(context.Background(), shutdownGrace)
		defer cancel()
		if err := a.srv.Shutdown(ctx); err != nil {
			_ = a.srv.Close()
		}
	})
}

func loadConfig() Config {
	cfg := Config{DiffMode: "unified", GutterBase: "head", Blame: "line", Panels: []string{"tree", "editor", "git"}, PanelSizes: map[string]int{}}
	data, err := os.ReadFile(configPath())
	if err == nil {
		_ = json.Unmarshal(data, &cfg)
	}
	return cfg
}

func saveConfig(cfg Config) error {
	data, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return err
	}
	return writeAtomic(configPath(), data)
}

// writeAtomic replaces a file in one rename, so another echo process never reads a half-written one.
func writeAtomic(name string, data []byte) error {
	if err := os.MkdirAll(filepath.Dir(name), 0o700); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(name), filepath.Base(name)+".*")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), name)
}

// ports.json maps repository roots to the port each last used; it lives beside config.json.
func portsPath() string {
	return filepath.Join(filepath.Dir(configPath()), "ports.json")
}

func loadPorts() map[string]int {
	ports := map[string]int{}
	if data, err := os.ReadFile(portsPath()); err == nil {
		_ = json.Unmarshal(data, &ports)
	}
	return ports
}

// rememberPort records root's port and forgets any other repository that had it, which keeps
// the file to at most one entry per port in the range.
func rememberPort(root string, port int) {
	ports := loadPorts()
	for r, p := range ports {
		if p == port || p < firstPort || p > lastPort {
			delete(ports, r)
		}
	}
	ports[root] = port
	if data, err := json.MarshalIndent(ports, "", "  "); err == nil {
		_ = writeAtomic(portsPath(), data)
	}
}

func configPath() string {
	dir, err := os.UserConfigDir()
	if err != nil {
		dir = "."
	}
	return filepath.Join(dir, "echo", "config.json")
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(v)
}

func openBrowser(url string) error {
	if runtime.GOOS == "darwin" {
		return exec.Command("open", url).Start()
	}
	return exec.Command("xdg-open", url).Start()
}

func fatal(err error) {
	fmt.Fprintln(os.Stderr, err)
	os.Exit(1)
}

// authToken is this user's secret, read once at start. Sibling echo processes share it, so they can
// ask each other for their status and ask each other to stop.
var authToken string

const (
	tokenHeader = "X-Echo-Token"
	tokenCookie = "echo_token"
)

// loadToken returns the per-user secret, creating it (mode 0600, beside config.json) on first run.
// Another macOS user or a process that cannot read the file cannot call echo's API, even though the
// port is on loopback.
func loadToken() string {
	path := filepath.Join(filepath.Dir(configPath()), "token")
	if b, err := os.ReadFile(path); err == nil && len(strings.TrimSpace(string(b))) >= 32 {
		return strings.TrimSpace(string(b))
	}
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		fatal(err)
	}
	tok := hex.EncodeToString(raw)
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err == nil {
		if f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600); err == nil {
			_, _ = f.WriteString(tok + "\n")
			f.Close()
		} else if b, err := os.ReadFile(path); err == nil && len(strings.TrimSpace(string(b))) >= 32 {
			return strings.TrimSpace(string(b)) // another echo created it first
		}
	}
	return tok
}

// authorized admits a request that carries the token: in the cookie (the page), or the header (a
// sibling process). The link echo opens carries it once as ?t=, which becomes the cookie.
func (a *App) authorized(w http.ResponseWriter, r *http.Request) bool {
	if a.token == "" {
		return true
	}
	if r.Method == http.MethodGet && r.URL.Path == "/" && subtle.ConstantTimeCompare([]byte(r.URL.Query().Get("t")), []byte(a.token)) == 1 {
		http.SetCookie(w, &http.Cookie{Name: tokenCookie, Value: a.token, Path: "/", HttpOnly: true, SameSite: http.SameSiteStrictMode, MaxAge: 365 * 24 * 3600})
		http.Redirect(w, r, "/", http.StatusSeeOther)
		return false
	}
	got := r.Header.Get(tokenHeader)
	if c, err := r.Cookie(tokenCookie); err == nil {
		got = c.Value
	}
	if subtle.ConstantTimeCompare([]byte(got), []byte(a.token)) == 1 {
		return true
	}
	http.Error(w, "echo: this request has no access token. Open echo with the echo-desk command in the repository's folder.", http.StatusUnauthorized)
	return false
}

// validateEditorConfig checks the editor's numeric and enumerated settings (added in v2).
func validateEditorConfig(c Config) error { return nil }
