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
  echo-desk [path]              open a repository or workspace (default: the current folder)
  echo-desk ls                  list the running echo servers
  echo-desk open [path|port]    open a running server in the browser
  echo-desk stop [path|port]    stop one server (default: the current folder's)
  echo-desk stop --all          stop every server
  echo-desk update              install the latest release
  echo-desk -version`

// runCommand runs a subcommand and reports whether args named one. A folder with one of these names
// is still reachable as ./ls.
func runCommand(args []string) bool {
	if len(args) == 0 {
		return false
	}
	switch args[0] {
	case "ls", "list", "open", "stop", "update":
	default:
		return false
	}
	authToken = loadToken()
	var err error
	switch args[0] {
	case "ls", "list":
		listInstances(os.Stdout, instances())
	case "open":
		err = openCmd(args[1:])
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

func openCmd(args []string) error {
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

// updateCmd upgrades through Homebrew when that installed this binary, and otherwise runs the
// published install script into the folder this binary lives in.
func updateCmd() error {
	latest, err := latestRelease()
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
	if strings.Contains(exe, "/Cellar/") {
		cmd = exec.Command("brew", "upgrade", "sidkhuntia/tap/echo-desk")
	} else {
		cmd = exec.Command("sh", "-c", "curl -fsSL --proto '=https' --tlsv1.2 https://raw.githubusercontent.com/sidkhuntia/echo/main/install.sh | sh")
		cmd.Env = append(os.Environ(), "INSTALL_DIR="+filepath.Dir(exe), "VERSION="+latest)
	}
	cmd.Stdout, cmd.Stderr = os.Stdout, os.Stderr
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("update failed: %w", err)
	}
	if n := len(instances()); n > 0 {
		fmt.Printf("%d running server(s) keep the old version until restarted: echo-desk stop --all\n", n)
	}
	return nil
}
