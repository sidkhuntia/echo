# echo

A small local-first proof desk for reviewing code written by coding agents, on macOS.

## Install

Build once, under a name your shell will not confuse with its built-in `echo` command:

```sh
go build -o "$(go env GOPATH)/bin/echo-desk" .
```

`$(go env GOPATH)/bin` (usually `~/go/bin`) must be on your `PATH`. Run the same command again after pulling changes to echo; open pages reload themselves when the new version starts.

## Open any repository

echo serves the directory it starts in, or the one you pass:

```sh
cd ~/code/my-project && echo-desk
echo-desk ~/code/my-project
```

It opens your browser at `http://127.0.0.1:6030`. Each process serves one repository. Start echo in another repository and it takes the next free port (up to 6049) in a new tab; start it in a repository that is already open and it just opens that tab. Click the repository name in the title bar (`⌘⇧O`) to switch between open repositories.

| Flag | Default | Meaning |
| --- | --- | --- |
| `-port` | auto | Port to listen on (always `127.0.0.1`). Auto means the repository's last port, else the first free one in 6030–6049 |
| `-no-open` | off | Print the URL instead of opening the browser |

- A directory that is not a Git repository still opens, as a plain file browser and editor.
- Theme and layout settings are global and shared by every repository.
- Each repository remembers its port, so its tab and browser-side settings survive restarts unless you pass a different `-port`.
- While developing echo itself, `go run . -no-open` runs it from source in the current directory.

## v1

- collapsible folder tree with path filter
- multi-file tabs with in-memory unsaved edits
- plain textarea editor, always editable, syntax-highlighted in the editor and in both diff views
- Markdown files open rendered, with a Preview / Edit switch (`⌘⇧V`)
- Changes sidebar grouped like VS Code: staged and unstaged changes (and conflicts) listed separately, with `+`/`−` to stage or unstage a file and Stage all / Unstage all on each group
- per-file diffs including untracked files; all-changes, unstaged, staged, ref-range, and single-commit scopes
- stacked or split diff layout
- double-click a diff line to edit the file there; the editor gutter shows changes vs HEAD (staged hollow) or the index
- title bar with incoming ↓ / outgoing ↑ commits, Fetch, and Sync (or Publish for a branch with no upstream)
- Log view: commit graph of every branch with branch and tag labels, filters (message or hash, branch, author, path), and a details pane with the full message, containing branches, and changed files
- History tab: the current branch's graph; commits expand to show their details and files
- file history (follows renames), inline blame on the caret line, and a blame column in the editor
- compare two branches: commits only on each side, and the merge-base diff
- Branches: a sidebar tree (local, remote, tags) that filters the Log, and a branches popup on the branch name with checkout, new branch, merge, rebase, compare, and delete
- saves never overwrite a file an agent changed after you opened it
- keys: `n`/`p` file, `j`/`k` hunk, `e` edit at hunk, `o` open, `⌘K` find a file
- file create, rename, delete
- stage, unstage, discard (discarding from the unstaged list keeps staged work)
- test 2
- commit, amend, rebase, pull, push (plus force push, with or without lease), branch create/switch, merge
- stash create/apply
- live Git status over SSE
- 32 open-source themes (12 light, 20 dark) plus a System theme that follows macOS appearance
- a change trace in the title bar: every changed file and hunk at a glance, with the current hunk as the playhead
- Geist and Geist Mono embedded, so the app never fetches fonts
- global config file for theme, editor, and panel preferences

## Development

```sh
gofmt -w *.go
go build ./...
go test ./...
```

There is no frontend build step. The `web/` directory is embedded into the Go binary.
