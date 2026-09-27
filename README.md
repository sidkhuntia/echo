# echo

A small local-first Git review and editing app for macOS.

## Run

```sh
go run . -no-open
```

Open the printed local URL in a browser. The app starts in the current Terminal directory and binds to `127.0.0.1` only.

## v1

- file tree with path filter
- multi-file tabs with in-memory unsaved edits
- read-only file view and plain textarea editingsdasda 
- working-tree, staged, and ref-range diffs
- file create, rename, delete
- stage, unstage, discard
- commit, amend, rebase, pull, push, branch create/switch, merge
- stash create/apply
- live Git status over SSE
- global config file for future panel and editor preferences

## Development

```sh
gofmt -w main.go
go build ./...
go test ./...
```

There is no frontend build step. The `web/` directory is embedded into the Go binary.
