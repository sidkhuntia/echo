# echo

A small local-first proof desk for reviewing code written by coding agents, on macOS.

## Run

```sh
go run . -no-open
```

Open the printed local URL in a browser. The app starts in the current Terminal directory and binds to `127.0.0.1` only.

## v1

- collapsible folder tree with path filter
- multi-file tabs with in-memory unsaved edits
- plain textarea editor, always editable
- review queue of changed files with reviewed marks that reset when a file changes again
- per-file diffs including untracked files; all-changes, unstaged, staged, ref-range, and single-commit scopes
- stacked or split diff layout
- double-click a diff line to edit the file there; the editor gutter shows changes vs HEAD (staged hollow) or the index
- history with author names; clicking a commit copies its id
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
