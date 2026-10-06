package main

import (
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"text/tabwriter"
	"time"
)

const cliUsage = `usage:
  echo-desk [-no-open] [-port N] [path]  open a repository or workspace (default: the current folder)
  echo-desk ls                  list the running echo servers
  echo-desk open [path|port]    open a running server in the browser
  echo-desk stop [path|port]    stop one server (default: the current folder's)
  echo-desk stop --all          stop every server
  echo-desk update              install the latest release (shows progress while it downloads)
  echo-desk -version            print the version and exit
  echo-desk -help               show this help
  -no-open, -port, -version and -help all accept a -- double dash too, and server
  flags may appear before or after the path.`

// parseGlobalArgs extracts echo-desk's server flags wherever they appear on the command
// line. The standard flag package stops at the first path, so `echo-desk /repo -no-open`
// silently ignored the flag and opened a browser anyway (and `echo-desk /repo -port N`
// silently ignored the port). Known flags are hoisted; everything else stays in rest in
// order, so subcommand flags like `stop --all` keep working.
func parseGlobalArgs(args []string) (port int, noOpen, showVersion, showHelp bool, rest []string, err error) {
	rest = []string{}
	for i := 0; i < len(args); i++ {
		a := args[i]
		if a == "--" {
			rest = append(rest, args[i+1:]...)
			break
		}
		if a == "-no-open" || a == "--no-open" {
			noOpen = true
			continue
		}
		if s, ok := cutFlagValue(a, "no-open"); ok {
			v, perr := strconv.ParseBool(s)
			if perr != nil {
				return 0, false, false, false, nil, fmt.Errorf("invalid value %q for -no-open", a)
			}
			noOpen = v
			continue
		}
		if a == "-port" || a == "--port" {
			if i+1 >= len(args) {
				return 0, false, false, false, nil, fmt.Errorf("-port needs a port number")
			}
			p, perr := strconv.Atoi(args[i+1])
			if perr != nil || p < 1 || p > 65535 {
				return 0, false, false, false, nil, fmt.Errorf("invalid port %q (want 1-65535)", args[i+1])
			}
			port = p
			i++
			continue
		}
		if s, ok := cutFlagValue(a, "port"); ok {
			p, perr := strconv.Atoi(s)
			if perr != nil || p < 1 || p > 65535 {
				return 0, false, false, false, nil, fmt.Errorf("invalid port %q (want 1-65535)", s)
			}
			port = p
			continue
		}
		if a == "-version" || a == "--version" {
			showVersion = true
			continue
		}
		if s, ok := cutFlagValue(a, "version"); ok {
			v, perr := strconv.ParseBool(s)
			if perr != nil {
				return 0, false, false, false, nil, fmt.Errorf("invalid value %q for -version", a)
			}
			showVersion = v
			continue
		}
		if a == "-h" || a == "-help" || a == "--help" {
			showHelp = true
			continue
		}
		rest = append(rest, a)
	}
	return port, noOpen, showVersion, showHelp, rest, nil
}

// cutFlagValue reports whether s is -name=value or --name=value and returns the value.
func cutFlagValue(s, name string) (string, bool) {
	for _, p := range []string{"-" + name + "=", "--" + name + "="} {
		if strings.HasPrefix(s, p) {
			return s[len(p):], true
		}
	}
	return "", false
}

// checkCommandArgs rejects extra arguments to subcommands that do not take them, so a
// typo like `echo-desk ls foo` fails instead of silently ignoring foo.
func checkCommandArgs(args []string) error {
	switch args[0] {
	case "ls", "list", "update":
		if len(args) != 1 {
			return fmt.Errorf("%s takes no arguments", args[0])
		}
	case "open", "stop":
		if len(args) > 2 {
			return fmt.Errorf("%s takes at most one path or port", args[0])
		}
	}
	return nil
}

// runCommand runs a subcommand and reports whether args named one. A folder with one of these names
// is still reachable as ./ls.
func runCommand(args []string, noOpen bool) bool {
	if len(args) == 0 {
		return false
	}
	switch args[0] {
	case "ls", "list", "open", "stop", "update":
	default:
		return false
	}
	if err := checkCommandArgs(args); err != nil {
		fmt.Fprintln(os.Stderr, "echo:", err)
		fmt.Fprintln(os.Stderr, cliUsage)
		os.Exit(2)
	}
	authToken = loadToken()
	var err error
	switch args[0] {
	case "ls", "list":
		listInstances(os.Stdout, instances())
	case "open":
		err = openCmd(args[1:], noOpen)
	case "stop":
		err = stopCmd(args[1:])
	case "update":
		err = updateCmd()
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "echo:", err)
		os.Exit(1)
	}
	return true
}

func listInstances(w io.Writer, list []Instance) {
	if len(list) == 0 {
		fmt.Fprintln(w, "no echo servers are running")
		return
	}
	tw := tabwriter.NewWriter(w, 0, 4, 2, ' ', 0)
	fmt.Fprintln(tw, "PORT\tBRANCH\tCHANGES\tPATH")
	for _, in := range list {
		branch := in.Branch
		if len(in.Repos) > 0 {
			branch = fmt.Sprintf("(workspace, %d repos)", len(in.Repos))
		}
		fmt.Fprintf(tw, "%d\t%s\t%d\t%s\n", in.Port, branch, in.Changes, in.Root)
	}
	_ = tw.Flush()
}

// resolveTarget finds the running server a path or port names; no argument means the current folder.
func resolveTarget(arg string, list []Instance) (Instance, error) {
	if n, err := strconv.Atoi(arg); err == nil {
		for _, in := range list {
			if in.Port == n {
				return in, nil
			}
		}
		return Instance{}, fmt.Errorf("no echo is running on port %d", n)
	}
	if arg == "" {
		arg = "."
	}
	root, err := filepath.Abs(arg)
	if err != nil {
		return Instance{}, err
	}
	for _, in := range list {
		if in.Root == root {
			return in, nil
		}
	}
	return Instance{}, fmt.Errorf("no echo is running for %s (see: echo-desk ls)", root)
}

func openCmd(args []string, noOpen bool) error {
	arg := ""
	if len(args) > 0 {
		arg = args[0]
	}
	list := instances()
	if arg == "" && len(list) == 1 && runningFor(mustAbs("."), list) == 0 {
		arg = strconv.Itoa(list[0].Port) // a single server is unambiguous
	}
	in, err := resolveTarget(arg, list)
	if err != nil {
		return err
	}
	url := "http://127.0.0.1:" + strconv.Itoa(in.Port) + "/?t=" + authToken
	fmt.Println("echo", in.Root, "at", url)
	if noOpen {
		return nil
	}
	return openBrowser(url)
}

func mustAbs(p string) string {
	a, _ := filepath.Abs(p)
	return a
}

func stopCmd(args []string) error {
	list := instances()
	if len(args) > 0 && (args[0] == "--all" || args[0] == "-all") {
		if len(list) == 0 {
			fmt.Println("no echo servers are running")
			return nil
		}
		for _, in := range list {
			if stopInstance(in.Port) {
				fmt.Printf("stopped %s (port %d)\n", in.Root, in.Port)
			} else {
				fmt.Printf("could not stop port %d\n", in.Port)
			}
		}
		return nil
	}
	arg := ""
	if len(args) > 0 {
		arg = args[0]
	}
	in, err := resolveTarget(arg, list)
	if err != nil {
		return err
	}
	if !stopInstance(in.Port) {
		return fmt.Errorf("port %d did not answer the stop request", in.Port)
	}
	fmt.Printf("stopped %s (port %d)\n", in.Root, in.Port)
	return nil
}

// newerThan reports whether release tag latest is a later version than current. A dev build is
// treated as out of date, so update still installs from a source checkout.
func newerThan(latest, current string) bool {
	l, c := versionParts(latest), versionParts(current)
	if c == nil {
		return l != nil
	}
	for i := 0; i < 3; i++ {
		if l[i] != c[i] {
			return l[i] > c[i]
		}
	}
	return false
}

func versionParts(v string) []int {
	v = strings.TrimPrefix(strings.TrimSpace(v), "v")
	parts := strings.SplitN(v, ".", 3)
	if len(parts) != 3 {
		return nil
	}
	out := make([]int, 3)
	for i, p := range parts {
		n, err := strconv.Atoi(strings.SplitN(p, "-", 2)[0])
		if err != nil {
			return nil
		}
		out[i] = n
	}
	return out
}

// latestRelease reads the tag /releases/latest redirects to: no API call, no JSON, no rate limit.
func latestRelease() (string, error) {
	client := &http.Client{Timeout: 10 * time.Second}
	res, err := client.Get("https://github.com/sidkhuntia/echo/releases/latest")
	if err != nil {
		return "", fmt.Errorf("could not reach GitHub: %w", err)
	}
	defer res.Body.Close()
	tag := res.Request.URL.Path[strings.LastIndex(res.Request.URL.Path, "/")+1:]
	if versionParts(tag) == nil {
		return "", fmt.Errorf("could not find the latest release (got %q)", res.Request.URL)
	}
	return strings.TrimPrefix(tag, "v"), nil
}

// spin shows a downloading animation on stderr while a silent network step runs, so
// `echo-desk update` no longer sits quiet for seconds. It returns a stop function that
// finishes the line. Off a terminal it just prints the message once.
func spin(msg string) func() {
	if f, err := os.Stderr.Stat(); err != nil || f.Mode()&os.ModeCharDevice == 0 {
		fmt.Fprintln(os.Stderr, msg+"…")
		return func() {}
	}
	frames := []string{"⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"}
	done := make(chan struct{})
	go func() {
		t := time.NewTicker(80 * time.Millisecond)
		defer t.Stop()
		i := 0
		for {
			select {
			case <-done:
				return
			case <-t.C:
				fmt.Fprintf(os.Stderr, "\r%s %s", msg, frames[i%len(frames)])
				i++
			}
		}
	}()
	return func() {
		close(done)
		fmt.Fprintf(os.Stderr, "\r%s done\n", msg)
	}
}

// updateCmd upgrades through Homebrew when that installed this binary, and otherwise runs the
// published install script into the folder this binary lives in.
func updateCmd() error {
	stop := spin("Checking for the latest release")
	latest, err := latestRelease()
	stop()
	if err != nil {
		return err
	}
	cur := buildVersion()
	if !newerThan(latest, cur) {
		fmt.Printf("echo %s is the latest\n", cur)
		return nil
	}
	fmt.Printf("updating echo %s to %s\n", cur, latest)
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	if real, err := filepath.EvalSymlinks(exe); err == nil {
		exe = real
	}
	var cmd *exec.Cmd
	var stopSpin func()
	if strings.Contains(exe, "/Cellar/") {
		// brew prints its own progress; a spinner would garble it.
		fmt.Println("upgrading via Homebrew…")
		cmd = exec.Command("brew", "upgrade", "sidkhuntia/tap/echo-desk")
	} else {
		cmd = exec.Command("sh", "-c", "curl -fsSL --proto '=https' --tlsv1.2 https://raw.githubusercontent.com/sidkhuntia/echo/main/install.sh | sh")
		cmd.Env = append(os.Environ(), "INSTALL_DIR="+filepath.Dir(exe), "VERSION="+latest)
		// The install script's curls are silent, so this is the quiet stretch.
		stopSpin = spin(fmt.Sprintf("Downloading echo %s", latest))
	}
	cmd.Stdout, cmd.Stderr = os.Stdout, os.Stderr
	err = cmd.Run()
	if stopSpin != nil {
		stopSpin()
	}
	if err != nil {
		return fmt.Errorf("update failed: %w", err)
	}
	if n := len(instances()); n > 0 {
		fmt.Printf("%d running server(s) keep the old version until restarted: echo-desk stop --all\n", n)
	}
	return nil
}
