# Changelog

## Unreleased

- Added a Stacked / Split switch for diffs; split shows the old version on the left and the new on the right. The choice is saved in the config.
- Hunks can be edited in place while reviewing, on the new (working-tree) version only: use the hunk's Edit button, `e`, or double-click a line. Saves refuse to overwrite a file an agent changed in the meantime, and keep CRLF endings.
- History rows now show the author's full name and a relative time; clicking a commit copies its full id and shows its diff.
- Redesigned the interface as a minimal three-pane layout: a title bar with "Go to file", progress, and panel toggles; a sidebar; the Review/Files surface; and a Git panel with Commit and History tabs.
- Added 14 open-source themes (echo ink/paper, GitHub, Solarized, Catppuccin, Rosé Pine, Nord, Gruvbox, Tokyo Night, Dracula) with a searchable theme picker; "System" follows macOS appearance, and the choice is saved in the config.
- The sidebar's Files view is now a collapsible folder tree with change counts on folders.
- Review wording is now plain: "Mark reviewed" and "Reviewed" with a check circle; diff headers show a five-block add/delete balance.
- Reframed echo as a proof desk for reviewing code written by coding agents.
- Added a review queue of changed files with +/− counts, "proofed" marks that reset when a file changes again, and a proofed tally in the masthead.
- Diffs now render per file with line numbers, sticky headers, folding, and per-file open/stage/discard; lockfiles and very large diffs start folded.
- Added an "all changes" scope (working tree vs `HEAD`) as the default, and untracked files now appear as new-file diffs.
- Clicking a commit in history shows its diff.
- Added `n`/`p` file, `j`/`k` hunk, `x` proof, and `o` open shortcuts, and a fuzzy `⌘K` file finder.
- Saving refuses to overwrite a file that changed on disk since it was opened; clean tabs reload on external edits and dirty tabs show a conflict banner.
- Discard now removes untracked files too.
- Security: reject foreign `Host`/`Origin` headers and non-JSON writes, and reject refs that look like Git options.
- The SSE stream only sends status when it changed, and Git runs without optional locks.
- Fixed: tree status badges, `?` opening help while typing, rebase reading the diff "from" box, `⌘↵` commit, and tabs that could not be closed.
- Added Go tests for path safety, ref validation, the request guard, status/diff parsing, stale saves, and discard.
- Redesigned the interface with a dark ink and light paper theme.
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
