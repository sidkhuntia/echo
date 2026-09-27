# Changelog

## Unreleased

- Redesigned the interface as an original amber-and-ink “local git desk” with a file index, review surface, and action ledger.
- Expanded `decisions.md` into a complete decision log covering product, architecture, Git, editor, UI, security, defaults, and deferrals.

## 0.1.0

- Added a localhost-only Go server that opens a vanilla JavaScript UI in the browser.
- Added file tree browsing, path filtering, tabs, read-only file view, and plain textarea editing.
- Added working-tree, staged, and ref-range diff views.
- Added file create, rename, delete, stage, unstage, and discard.
- Added commit, amend, rebase, pull, push, branch create/switch, merge, and stash create/apply.
- Added live Git status updates over SSE.
- Added global config persistence in the OS user config directory.
- Deferred LSP highlighting, hunk staging, conflict-resolution UI, and panel layout persistence to a later version.
