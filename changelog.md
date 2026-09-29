# Changelog

## Unreleased

- The editor now highlights code using language servers installed on your Mac (gopls, TypeScript, basedpyright, rust-analyzer, clangd, SourceKit-LSP, jdtls, Ruby LSP, Lua, zls, Bash). If a file's server isn't installed, a note above the editor shows the install command with Install, Copy command, and Not now; editing never waits on it.
- Markdown files open rendered, with headings, tables, task lists, alerts, code blocks, images from the repository, and links that open other files in echo. Switch between Preview and Edit in the file bar or with `⌘⇧V`.
- The Changes sidebar now works like VS Code's Source Control: "Staged changes" and "Changes" are separate groups (plus "Merge changes" for conflicts), and a partly staged file appears in both with each side's own counts. Hover a row for `+` (stage), `−` (unstage), discard, and open; hover a group header for Stage all or Unstage all. Group headers fold.
- Discard in the "Changes" group, and in the Unstaged diff view, now throws away only unstaged edits and keeps what you staged.
- Clicking a row while the diff shows Unstaged or Staged switches to that row's side.
- Removed review marks: the "Mark reviewed" button, the check circles, the reviewed tally in the title bar, and the `x` key.
- The default port is now 6030. Starting echo in another repository no longer fails because the port is taken: it takes the next free port (up to 6049) and opens a new tab. Each repository keeps its port across restarts, and starting echo in a repository that is already open just opens its tab.
- Added a repository switcher: click the repository name in the title bar, or press `⌘⇧O`, to see every open echo with its branch and change count. Use `↑`/`↓` to choose (it starts on the first other repository), `Enter` to switch this tab, and `⌘Enter` or `⌘`-click to open a new one. Browser tabs are titled `repository — branch`.
- Fixed: with several echo processes open, changing a setting in one could undo a setting changed in another, because each wrote back its whole copy of the shared config.
- Fixed: in repositories with many ignored files (build output, local data folders), the Files tree could stop before `src` because the browser shows at most 3,000 paths. In a Git repository the tree now leaves out files ignored by `.gitignore`.
- The title bar shows the current branch's incoming ↓ and outgoing ↑ commits against its upstream, with Fetch (and how long ago the last fetch was) and Sync buttons. Sync pulls using your Git pull settings, then pushes if you're ahead; a branch with no upstream shows Publish instead. The branch list shows the same counts.
- Added a Log view (Review · Files · Log): a commit graph of every branch with lanes, branch and tag labels, author, and date, loaded 200 commits at a time as you scroll. Filter by message text or a pasted hash, branch, author, or path. The details pane shows the full message, the branches that contain the commit, and its changed files; `Enter` opens the diff and `Esc` comes back.
- The History tab draws the same graph for the current branch, and shows branch and tag labels on commits.
- Added file history: History in the editor or on a diff header shows the commits that changed a file, following renames.
- Added blame: who last changed the caret line appears at the end of it (Settings can turn this off), and the Blame button adds a per-line column whose entries open their commit. Blame follows unsaved edits.
- Added Compare with current branch: the Log lists what each side has that the other lacks, and "Files changed" shows the merge-base diff, like a pull request. Compare refs gained a `..` / `...` switch.
- Added a Branches view in the sidebar (local, remote, tags, grouped into folders) that filters the Log, and a branches popup on the branch name in the title bar. Each branch or tag has a menu: checkout, new branch from here, merge, rebase, diff with the current branch, show in Log, and delete.
- The Log lays itself out by its own width, so the graph stays readable with both side panels open.
- The README explains how to install echo as `echo-desk` and open any repository, several at once on different ports.
- Fixed: the History tab and Log were empty in browsers with an ad or tracker blocker, which blocked the `/api/log` request; the endpoint is now `/api/history`.
- Fixed: the History tab could show "No commits yet" for good if a load failed, for example while echo restarted. It now keeps the last list, says it is retrying, and reloads after reconnecting.
- Fixed: after echo was restarted with a new version, an open page kept running the old code against the new server. Pages now reload themselves when the server's build changes, unless an editor tab has unsaved edits.
- Commits are no longer sent in every live status update; the log is fetched separately and only reloaded when a ref moves.
- Clicking a commit in History expands it: the full message, author and committer, parents, the branches and tags that contain it, and a folder tree of changed files with +/− counts. Clicking a file jumps to it in the commit diff. The full id is copied from a Copy button instead of on every click.
- Fixed: marking a file reviewed and folding a diff file by its header threw an error, because two diff helpers had been removed by mistake.
- Fetch, pull, push, sync, and publish run one at a time with a two-minute timeout, and the buttons show progress.
- Added a Stacked / Split switch for diffs; split shows the old version on the left and the new on the right. The choice is saved in the config.
- Double-click any diff line, or press `e`, to open the file in the editor on that line; `Esc` returns to the same place in the review.
- The Files editor is always editable (no Edit toggle) and has a gutter with line numbers and change bars: added, modified, and deleted lines, with staged changes drawn hollow. A setting switches the comparison between HEAD and the index.
- Fixed: saving a CRLF file from the editor no longer converts it to LF.
- Fixed: edits saved in the editor now show in Review as soon as you go back, instead of after a manual refresh. A file with unsaved editor changes is labelled "unsaved edits" in the diff.
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
