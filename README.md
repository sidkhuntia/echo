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

It opens your browser at `http://127.0.0.1:7777`. Each process serves one repository, so to have several open at once, give each its own port:

```sh
echo-desk -port 7778 ~/code/other-project
```

| Flag | Default | Meaning |
| --- | --- | --- |
| `-port` | `7777` | Port to listen on (always `127.0.0.1`) |
| `-no-open` | off | Print the URL instead of opening the browser |

- A directory that is not a Git repository still opens, as a plain file browser and editor.
- Theme and layout settings are global and shared by every repository.
- "Reviewed" marks are stored in the browser per repository and per port, so reopen a repository on the same port to keep them.
- While developing echo itself, `go run . -no-open` runs it from source in the current directory.

## v1

- collapsible folder tree with path filter
- multi-file tabs with in-memory unsaved edits
- plain textarea editor, always editable
- review queue of changed files with reviewed marks that reset when a file changes again
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
- keys: `n`/`p` file, `j`/`k` hunk, `x` mark reviewed, `e` edit at hunk, `o` open, `⌘K` find a file
- file create, rename, delete
- stage, unstage, discard
- test 2
- commit, amend, rebase, pull, push, branch create/switch, merge
- stash create/apply
- live Git status over SSE
- 14 open-source themes plus a System theme that follows macOS appearance
- global config file for theme, editor, and panel preferences

## Development

```sh
gofmt -w main.go
go build ./...
go test ./...
```

There is no frontend build step. The `web/` directory is embedded into the Go binary.
