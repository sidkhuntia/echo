# agents.md

## Scope

This repository is a small Go + vanilla JavaScript macOS app. Keep it local-first, fast, and boring.

## Rules

- Prefer the standard library over new dependencies.
- Use the system `git` CLI; do not add a Git library.
- Serve one repository per process, rooted at the current directory.
- Bind to `127.0.0.1` only.
- Embed `web/` in the binary; do not add a frontend framework or build step.
- Keep API handlers small and explicit.
- Do not add features that are not in `decisions.md` or the changelog.
- Run `gofmt -w *.go` and `go test ./...` before handing off changes.
- Update `changelog.md` and `decisions.md` when behavior or architecture changes.
