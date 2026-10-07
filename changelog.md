# Changelog

## 0.7.0 (2026-10-07)

- The repository switcher (`⌘⇧O`) lists every repository, grouped under its workspace, instead of collapsing a workspace to one "workspace" row. Each repository shows its own branch and change count and opens directly; the workspace heading carries the Stop button (stopping is still per process). The workspace overview's "Open elsewhere" section groups the same way.

## 0.6.2 (2026-10-07)

- Fixed `echo-desk -no-open` (and `-port`) being silently ignored when the path comes first (`echo-desk /repo -no-open` opened a browser anyway). Server flags are now recognized before or after the path; `echo-desk open` also respects `-no-open`. Unknown flags and extra paths now fail with usage instead of being ignored.
- `echo-desk update` no longer sits silent while the network works: it shows a spinner while checking the latest release and while downloading (Homebrew upgrades keep brew's own output instead). CLI flags are stricter too: ports must be 1–65535, and extra arguments to `ls`, `update`, `open` and `stop` fail with usage rather than being ignored.

## 0.6.1 (2026-10-06)

- Review: folding or expanding a file in a large diff no longer leaves the next file blank until you scroll. Bodies near the viewport are drawn right after the fold changes the layout.
- The "Discarded N files … · Restore" banner in the Changes list is gone. Discards are still snapshotted; bring the last one back with `⌘⇧P` → Restore the last discard.

## 0.6.0 (2026-10-05)

- Branch, remote and tag rows have **Tag here…** in their menu: it makes an annotated tag at that ref, named by you, with the name as its message. It is local until you push it, and Git refuses a name that is already taken, so a tag never moves.
- Tag rows also have **Push tag…**. It asks first (naming the tag, and saying that a repository that builds releases from tags will start one), then pushes that one tag, never `--tags` and never forced.

- A copy button on branch names: in the title bar beside the branch, and on hover in the Branches rail and the branch picker (local, remote and tag rows). It copies the ref exactly as shown, for example `origin/main`. The title-bar button is hidden on a detached HEAD.
- The Sync tab's sections (Branch & sync, Stash) now start open, and each one reopens the way you last left it. The choice is kept in the browser's storage, so it is per repository.

## 0.5.0 (2026-10-05)

- Branches already merged into the checked-out branch carry a `merged` marker in the Branches rail and the branch picker; deleting them loses nothing. The checked-out branch itself is never marked.
- Remote branches get the same `merged` marker when the remote-tracking branch is already merged into the checked-out branch. Each remote's default branch (what `origin/HEAD` points to) and the checked-out branch's own upstream are never marked, since deleting those is not cleanup. The marker reflects the last fetch.
- Settings → Review → **Change trace**: turns the title bar's per-file, per-hunk chart on or off (on by default). Off frees the title bar; the file count, +/− totals and staged count go with it.

## 0.4.0 (2026-10-04)

- Command-line subcommands manage running servers without a browser tab: `echo-desk ls` (port, branch, changes, path), `echo-desk open [path|port]`, `echo-desk stop [path|port]` (default: the current folder), `echo-desk stop --all`, and `echo-desk update` (Homebrew's `brew upgrade` when it installed the binary, otherwise the install script into the binary's own folder; running servers keep the old version until restarted). A folder named like a subcommand is still reachable as `./ls`.

## 0.3.1 (2026-10-04)

- A small button in the title bar opens the repository's remote page (GitHub, GitLab or Bitbucket; `origin` first) in a new browser tab. It is hidden when no remote has a web page.
- History: an open commit now shows its full subject at the top of its details, at once and before the details load. The row clips a long subject to one line, and the detail used to show only the body, so a long message could not be read anywhere.
- Review: going from Files back to Hunks restores each file's normal hunks. A file viewed whole in Files kept its whole-file context, so Hunks showed it as one big hunk.

## 0.3.0 (2026-10-04)

- The status poll and the file tree load faster. Git's independent calls (branch, status, and the three line-count diffs; the two file listings) now run at the same time instead of one after another. Same results; on a repository with 400 changes the status went from about 260 ms to 140 ms.
- Switching between a workspace's repositories is faster. The repository bar's `/ws/repos` answer is shared by simultaneous requests and reused for two seconds (fetch, pull and rescan refresh it at once), so each switch no longer runs a Git status in every repository.
- Removed Sign off and Co-author from the commit box. Commits go without trailers; the message length meter stays.
- The Git panel always starts collapsed. Only opening it yourself (the rail, ⌘J, or the title-bar button) shows it; the session no longer restores it open.

- Merge and Rebase open one dialog instead of acting at once. It says the direction ("From `feature` into `main`, the branch you are on"), lets you change the source branch and switch between Merge and Rebase, and previews the result before you confirm: how many commits come in (with their subjects), whether a merge can fast-forward or will create a merge commit, how many of your own commits a rebase would replay, and a warning when files have uncommitted changes. The confirm button names the action ("Merge feature into main"), and is disabled when there is nothing to bring in. Merge keeps its fast-forward / always a merge commit / squash choices. The branch menu's "Merge into…" and "Rebase … onto this…" open the same dialog. New read-only endpoint `/api/git/relation?from=`.
- Amend works in one step, like `git commit --amend`: choosing "Amend last commit (edit message)" fills the box with the last message and turns the commit button into "Amend last commit + N staged files"; one press adds the staged changes (unstaged ones stay out) and rewrites the message. "Cancel amend" in the same menu backs out. Before, the menu item had to be chosen a second time.
- The commit button's menu (Amend, Undo) opens upward when there is no room below it, so it is no longer cut off at the bottom of the window.

- The Git panel starts collapsed even when pinned (pinning docks it as a column; the title-bar button or ⌘J opens it). The staged-count badge on its button is no longer clipped by the button group's border.

### Review: Files view

- A **Hunks | Files** switch in the review toolbar. Files shows one changed file at a time, whole file, with no hunk headers or hunk actions; Stage, Unstage and Note stay in the file's header. ‹ › (and `n` / `p`) step between files; the trace strip and the sidebar still jump to a file. The choice is remembered per repository.

### Files tree

- Files are ordered naturally, so `V2__x.sql` comes before `V10__y.sql` (it was `V1, V10, V11, … V2`). Folders still come first.
- Dotfiles and dot-folders (`.github`, `.env`, `.gitignore`) are shown; only `.git` is left out.
- Empty folders are shown.
- Ignored files and folders (`node_modules`, build output, `.env`) are shown dimmed. An ignored folder is listed only when you open it (`/api/tree?dir=`), so a huge one costs nothing until asked for, and it stays out of search, "Expand all" and the quick-open list. This is how px0 keeps large repositories fast.

## 0.2.0 (2026-10-04)

### Workspaces

- Run `echo-desk` in a folder that is not a repository but contains repositories (for example `~/Developer/EH-Provider-Portal`) and echo opens them all in one tab. The home page lists every repository with its branch, ↑↓, and staged, unstaged, untracked and conflict counts, plus every changed file grouped by repository; a file opens its diff.
- Each repository opens at `/r/<name>/` as the usual echo page, with a bar of repository chips (branch and change count) across the top. `⌘⇧O` switches between them; what was open in each comes back.
- Fetch all, Pull all (fast-forward only, skipping repositories with local work), Rescan, and a "Changed only" filter. The folder's own loose files are under Files.
- Starting echo inside a repository that a workspace already serves opens that repository in the workspace.
- Quieter screen: the repository bar is one line of names (a count only where something changed; branch and sync are in the tooltip), the review's file filter shows only the filter box (status filter and Collapse all moved into the view menu, the status filter returns beside the box while active), the footer shortcut strip and the refresh button are gone, and the commit box shows Sign off and Co-author only while you are writing a message.
- A file's header keeps Note and Stage/Unstage; Open, File history, more context lines and Discard are in its ⋯ menu. The sidebar tabs are Changes and Files as words, with Branches and Notes as icons (Notes keeps its count).
- The repository switcher is one line per repository: name and branch, then the change count, port, and Stop.
- Log: opening it closes an open History drawer; clicking a commit only selects it and shows its details (like History); clicking one of its files opens that diff, and the Log's commits move into the left nav (a Log tab appears there) so another commit is one click away. Esc returns to the full Log.
- Tabs can be dragged into the order you like: the sidebar tabs, Review/Editor/Log, the Git panel tabs (saved in the config as `tabOrder`), and the open-file tabs.
- Hunk header: note and discard are quiet icons and the one action that moves the hunk (Stage hunk / Unstage hunk) sits last, tinted; the line range shows on hover.
- The repository bar is a row of pills: a dot and a count where something changed, the open repository filled, and the shared name prefix (`provider-`) left off (the tooltip has the full name). Settings → Layout → Repository bar turns it off (shown by default); `⌘⇧O` still switches.
- In a workspace, `⌘⇧O` now lists the workspace's repositories and, under "Elsewhere", every other echo process (repositories or workspaces outside it); the overview page has an "Open elsewhere" section too. Before, a repository opened outside the workspace never showed up in the workspace's switcher.
- Review always compares with HEAD: a three-way switch (All · Unstaged · Staged) replaces the "What to compare" menu. A commit or a range of refs only appears when you come from the Log or History, as a chip (`Commit abc1234 ×`) that takes you back to all changes.
- One toolbar row instead of two in Review: the file filter moved up beside the layout switch (the status filter is in the view menu and tints the filter box while it is on). The title bar and repository bar are a little shorter.
- Editor: tabs are quieter (the close button shows on hover, a dot marks unsaved), Save appears only when there is something to save, and line endings, note, open in…, history, blame and Format JSON are in one ⋯ menu.
- Messages in the bottom-left corner disappear after four seconds (eight for errors); "Lost the echo server" stays until the connection returns.
- The repository switcher searches names and branches by every word you type (the folder path no longer matches everything), and one row is highlighted instead of two competing boxes. The theme picker now moves with ↑/↓, previews the highlighted theme, applies it with Enter, and Escape puts the old one back.

### v2: safety, review notes, Git and editor depth

**Fixes**
- Discarding a file called like a glob (`[id].tsx`) no longer reverts its neighbours: paths are literal.
- New file and rename refuse to replace an existing file; saving writes atomically, keeps the file's mode and needs the hash the file was opened with.
- Every discard is snapshotted first; **Restore** in the Changes list brings the last one back.
- Files over 10 MB are not loaded into the editor; `.git` cannot be read from the page.
- The API requires a per-user secret (cookie from the printed link); ssh cannot hang a request on a passphrase prompt; `/api/config` is validated.
- One shared status poller for all tabs and a cached slow half of the status; the hash cache no longer grows without bound.
- Switching repositories no longer loses unsaved edits or your place: the session is also kept on the server, per repository.

**Review**
- No accept/reject marks: a note says what to change, Discard removes a hunk.
- Stage, unstage or discard a hunk or selected lines. Leave notes on a line, a run of lines or a whole file (from a diff or the editor). **Copy for agent** builds a ready-to-paste prompt (file, line, quoted code, note, plus rules for the agent); **Copy notes** is the plain list.
- Changed words are marked inside changed lines. Show more context per file. Filter by name, content, extension or decision. Next undecided hunk (`[` `]`). Images before/after, renames, mode changes. Huge diffs draw lazily.

**Git**
- Merge options, interactive rebase, cherry-pick, continue/skip/abort bar, conflict resolution, branch rename/force delete/delete on remote, stash (files, show, branch, pop), reset soft/mixed/hard, remotes, worktrees, submodules, reflog, Compare, pull strategies, push options, `.gitignore` menu, intent-to-add, restore file from commit, undo last commit, amend keeping the message, sign-off, co-authors, commit template, Git output panel, Log filters (dates, merges) and context menus.

**Editor**
- Auto-indent, closing brackets and quotes, Tab/Shift-Tab, comment toggle, line move/duplicate/delete, matching bracket, multi-cursor, find and replace (and across files), indent detection and settings, EOL indicator and conversion, trim trailing whitespace and final newline on save, autosave, minimap, indent guides, ruler, whitespace, sticky scroll, breadcrumbs, other-uses highlighting, Vim mode, CSV/image previews, JSON format, side view, file rename/duplicate/delete/move/reveal/open-in, recent files, reopen closed tab, command palette. The file tree is windowed.

**Layout pass**
- Calmer title bar (breadcrumb, one Sync button with Fetch/Pull/Push behind its caret, a **⋯** menu); the middle "Files" mode is now **Editor**; layout is an icon pair and a **View** menu holds the review switches; the commit box moved under the Changes list.
- History: clicking a commit only expands it; its diff opens from a file in it. Commits that are not pushed show an amber **↑** and a hollow node in History and Log; pushed ones show a quiet **✓**.

**Project**
- Linux builds and installer; CI on macOS and Linux with race tests, pinned tools and a release gated on CI; optional macOS notarization; `main.go` and the web code split into modules; README rewritten with screenshots; tests for the new code including a real-binary smoke test.

- **UX pass on the review loop**:
  - Staging shows its result at once: the lists, the trace and the commit button move before Git answers, and the real status replaces the guess a moment later.
  - Staging a file from the review (its **Stage** button, or `s`) moves on to the next file with work left. `u` unstages the current file.
  - The Commit button says what it will commit ("Commit 2 staged files", "Stage 4 files & Commit"). With something staged it commits only the staged files, even with "Commit stages everything" on. That setting now means "when nothing is staged". With nothing to commit the button is disabled and a line says why.
  - A single-file Discard now asks first, like Discard all. In a file header it is a quiet icon at the far left, away from Stage, and only turns red on hover. Stage is the one filled action.
  - The Git panel leads with the commit box. Branch & sync and Stash are folded sections that show the branch (with ↑/↓) and the stash count.
  - The review lists files in the same path order as the sidebar; untracked files no longer come last.
  - A clean tree shows "Watching for changes", the last commit, and where the branch stands, with a Push button when commits are waiting.
  - The key hints under the sidebar are gone; the status bar has them (now including `s` stage).
- **Install channels**: prebuilt macOS binaries (arm64, amd64) named `echo-desk`, released by pushing a `v*` tag. Install with Homebrew (`brew install sidkhuntia/tap/echo-desk`), `install.sh` (verifies the SHA-256 from `checksums.txt`), or a release tarball. New `-version` flag. Release builds are stripped and `-trimpath`: 8.9 MB, down from 11.9 MB. See `PUBLISHING.md`.
- **Security hardening**: symlinks inside a repository can no longer be followed to files outside it; the page can no longer write into `.git`; all responses now carry a CSP, `nosniff`, frame and referrer headers; request bodies are capped and the server has header/idle timeouts; Git runs with `core.fsmonitor=false`; the config directory is private (0700). The theme bootstrap moved from an inline script to `web/theme-init.js` so the CSP can forbid inline script. CI now runs `govulncheck`.
- **Switching repositories keeps your place**: coming back to a repository now restores what you left: Review, Files or Log, the sidebar tab, the Git drawer, the diff scope and your position in the diff, open tabs with caret and scroll, **unsaved edits**, the commit message you were writing, filters, the content-search query and the Log's filters. If a file changed on disk while you were away, its tab comes back with the conflict banner instead of overwriting anything. A port reused by another repository starts fresh. The browser no longer asks "Leave site?" about unsaved edits when they were stored; it still does if storage is blocked.
- Switching between editor tabs now keeps each tab's caret and scroll position.
- **Multi-select in Changes**: click picks a row, ⌘/Ctrl-click toggles, Shift-click extends a range within the group, Esc clears. With two or more picked, a bar offers Stage (or Unstage in the Staged group), and a row's own +/− acts on the whole pick.
- **Publish Branch**: a branch with no upstream shows Publish Branch in the Git panel in place of Pull (and hides Push, which would do the same). Publishing shows a 12-second card with the pull request URL, a Copy button and an open-in-new-tab button. The URL is the one the host prints in the push output, or a built link for GitHub remotes.
- The Log view opens a commit's diff in Review on a single click (Esc returns); the History tab already did.
- Stopping the repository you are viewing hops to another open repository, or closes the tab when none is left.
- Fixed the title bar breaking when there are no changes: the empty change trace reused the padded `.empty` block class, grew to 72px, and pushed the whole bar's contents down over the panels. The trace's empty state is now its own `idle` class, and the bar has one fixed row that nothing inside it can stretch.
- **Hunk headings name the right place**: echo turns on Git's per-language heading rules for its own diffs (Go, CSS, HTML, Markdown, Python, Rust, Java, C/C++ and more, plus a JavaScript/TypeScript rule). The pill shows just the name, e.g. `(a *App) network`, `clampWidth`, `button.branch::after`, `16. Visual design`. JSON, YAML, lockfiles and other data files show no heading instead of the neighbouring line. Your repository's `.gitattributes` and your global attributes still take precedence.
- **The Git rail is optional, and off by default**: open the Git panel from the title bar's Git button (which now carries the staged badge and shows when the panel is open) or with `⌘J`. Settings › Layout › Git rail › Shown brings the strip back.
- **Settings page** (the gear in the title bar, or `⌘,`): categories for Appearance (a theme grid with swatches), Layout, Review, Editor and Commit, with a switch or segmented control and a one-line explanation for each option. Settings are no longer tucked under the shortcuts card.
- **Pin the Git panel**: the pin in the Git panel's header (or Settings › Layout › Pinned) docks it as a column beside the review instead of a drawer. `⌘J` still shows and hides it.
- **Swap panel sides**: Settings › Layout › Sidebar right moves the file sidebar to the right, and the Git rail and panel to the left. Resize grips follow.
- **Closer to the Carbon mockup**: underline tabs, uppercase mono group labels, churn bars on changed files, flat full-width file sections in the diff, a bordered branch pill, and the drawer floating as a card.
- Fixed the change trace looking faded out when every file is staged.
- Fixed long hunk context overflowing its pill; it now ends in an ellipsis.
- Fixed the toolbar crowding (the whitespace toggle over the file summary) when the review column is narrow; it now drops the summary, then the toggle.
- Fixed the open-file tabs being squeezed to nothing in a narrow Files toolbar.
- **Design revamp ("Signal")**: echo now looks like an instrument for reading agent changes. Geist and Geist Mono are embedded in the binary (`web/fonts/`, SIL OFL) and served locally. echo ink is re-cut as cool graphite with an Ember amber accent, and echo paper is its light counterpart. The logo and favicon are a new mark: an "e" sending out a sound wave.
- **Change trace**: the title bar shows the whole diff as a strip with a segment per file and a tick per hunk. Additions rise and deletions drop, the current hunk is an amber playhead that follows `j`/`k` and scrolling, and fully staged files fade. Click a tick to jump to that hunk. Go to file moves to a compact `⌘K` button beside it.
- **Git drawer**: the Git panel is now a drawer opened from a rail on the right (Commit, History, Branches) or `⌘J`, so the diff keeps the full width. The rail shows staged and to-push badges. `Esc`, `⌘J` or ✕ closes the drawer.
- **Readable hunk headers**: each hunk starts with a pill reading "2/3 func (a *App) network", its +/− size and "lines 1058–1065", instead of Git's `@@` line (kept as the tooltip). The current hunk's pill turns amber.
- **Review position** in the status bar ("file 2/9 · hunk 3/18"), and the key hints are shown as keycaps.
- **18 more themes**, for 32 in all (12 light, 20 dark): GitHub Dark Dimmed, One Dark, One Light, Ayu Dark, Ayu Mirage, Ayu Light, Everforest Dark and Light, Kanagawa Wave and Lotus, Gruvbox Light, Tokyo Night Day, Catppuccin Frappé and Macchiato, Rosé Pine Moon, Night Owl, Light Owl, and Poimandres. The theme search also matches family names.
- **Find in file (`⌘F`)**: a VS Code-style bar over the editor with match case, whole word and regex, `n of m` count, `↵`/`⇧↵` (or `⌘G`/`⇧⌘G`) to step, and `Esc` to close, leaving the current match selected. Every occurrence is tinted and the current one is stronger. Selecting one line of text first seeds the query. Outside the editor (diff, Log, Markdown preview) `⌘F` stays the browser's own find.
- **`⌘⇧F` uses the selection**: with text selected in the editor it opens Search with that text as the query and runs it.
- **Search hits are marked in the file**: clicking a content-search result opens the file with every match of the query tinted (the find bar opens without taking focus; `Esc` in the editor dismisses it).
- Fixed word wrap throwing on `tabLines`, which was called but never defined.
- **File tree context menu**: right-click a file or folder for **New file here** (a folder creates inside itself; the path is prefilled), **Copy name**, **Copy relative path** and **Copy absolute path** (the repository root plus the path). `⌘⌥N` creates a file beside the selected one from anywhere (`⌘N` belongs to the browser).
- **Syntax highlighting everywhere, without language servers**: the editor, the stacked diff, the split diff and Markdown fences are colored by a vendored copy of highlight.js (`web/vendor/hljs.js`, common build: Go, JS/TS, Python, Rust, Java, Kotlin, Swift, C/C++/C#, Ruby, PHP, Lua, shell, SQL, JSON, YAML/TOML/ini, CSS/SCSS/Less, HTML/XML, Markdown, Makefile and more). It works offline with nothing to install. Diff hunks are colored as old and new streams, so a multi-line comment or string colors correctly inside a hunk. `.properties`, `.env` and `.conf` use the ini grammar, and Gradle files the Java one. Dockerfiles stay plain.
- **Removed language servers**: the LSP client (`lsp.go`), the `/api/lsp/*` endpoints, the status-bar chip and popover, the install banner, and the `lspDismissed` setting are gone. Only highlighting used them.
- **Force push**: the caret next to Push in the Git panel offers **Force push with lease** (`git push --force-with-lease`) and **Force push (no lease)** (`git push --force`). Each asks first; the lease dialog explains that Git refuses if the remote gained commits since the last fetch, and the no-lease one is marked `no lease` in danger tone, with a pointer to the safer option. Both warn how many upstream commits (as of the last fetch) would be lost. The push names the remote and upstream ref (`git push --force-with-lease <remote> HEAD:<ref>`), so a `push.default` of `matching` cannot force-push other branches. A branch with no upstream or a detached HEAD is refused (Publish comes first). Force pushes are network actions: one at a time, with the same timeout.
- Fixed the Split diff layout collapsing into a single flex row: the commit card's button group used the generic class `split`, whose `display: flex` overrode the split hunk's grid. The button group is now `btn-split`, and the hunk class stays `split`.
- **Reset and Revert** on any commit: a commit's details (History tab and Log) have **Reset branch here** and **Revert** buttons. Reset is `git reset --soft`: the branch moves back to that commit and the undone commits' changes stay staged. It asks first, listing the commits that will be undone and warning when some are already on the remote (the next push would need a force push, which echo does not offer). The server refuses a target that is not an earlier commit of the current branch, a detached HEAD, and any merge, revert, cherry-pick or rebase in progress. Revert runs `git revert --no-edit` and adds a new commit at once. A merge commit asks which parent is the mainline (`-m`, default 1). If a revert stops on conflicts, the Commit card shows a banner with **Continue** and **Abort** until it is resolved.
- **Amend last commit** with an empty message box fills the box with the last commit's message to edit; choose Amend again to rewrite the commit. A message typed first is used as it was.
- **Discard all** in the Changes group: the group header has an undo button (next to Stage all) that throws away every unstaged edit and deletes the group's untracked files, after a dialog that lists the files and says what is deleted from disk. Staged changes are kept, and a path filter narrows what is discarded, as it does for Stage all.
- **Stage all & Commit** setting (Settings, `?`): with it on, the Commit button stages everything first and commits. It always asks before doing so, with a warning that all staged and unstaged changes will be committed, the files about to be staged, and the message. A split-button menu keeps the other way one click away (Commit staged only, or Stage all & Commit when the setting is off, plus Amend). The server refuses to stage everything while a merge conflict is unresolved, since that would mark it resolved.
- The Git panel is redesigned: a Commit card with a staged/unstaged tally and one wide split button (Amend moved into its menu, and the separate Stage all button is gone, since the Changes header has it); inputs and their actions read as one joined control; Pull and Push carry arrows and sit apart from Merge and Rebase.
- Every browser `confirm` and `prompt` (discarding unsaved edits, new file, rename, new branch, stopping echo) is now an in-app dialog. It focuses Cancel when the action is destructive, Enter confirms, and `Esc` or a click outside cancels. The dialog is a ledger slip rather than a stock modal: the title with a one-word tag (`no undo`, `stages all`), dashed rules between the parts, files itemised with what happens to each (`+1`, `delete file`), and a totals line. Tone shows in the tag and the confirm button only, with no side stripe or icon. It settles in over 200ms and leaves in 100ms.
- Long lines can wrap instead of scrolling sideways: a **Wrap long lines** checkbox in Settings (`?`) soft-wraps the editor and the stacked diff. The setting is one switch for both, so Review wraps too even though it is set from the editor's preferences, and it lasts for the session. Wrapped lines are a different height each, so the line numbers, the change bars and the colored text are placed from what the browser itself measures: a hidden mirror of the editor's content box, one block per line, which is the only way to agree with it about tabs, wide characters and words too long to fit. The mirror is measured in batches and kept as numbers, so scrolling and typing stay cheap and only the visible lines are drawn, as before. Going to a line, from a search result or a diff, walks the same measurements, and the inline blame note follows the caret onto whichever row it actually sits on.
- The two side panels are resizable: drag the border between a panel and the editor, or focus it and use the arrow keys (`Shift` for a bigger step). The sidebar runs from 180px to 560px, the Git panel from 220px to 640px, and neither can be dragged over the editor, which keeps at least 360px. The widths are saved like every other setting and come back on the next start, and a width left in the config by an older build (or by hand) that no longer fits the range falls back to the default rather than breaking the desk. A hidden panel remembers its width and gets it back when you show it again. Below 1100px the window is too narrow for the layout to give, so the panels keep their fixed sizes there.
- The Files rail can fold and unfold the whole tree: the button next to the filter folds every folder at once and unfolds them again, and says which it will do. Folding is remembered per folder, like a folder you open or close on its own, and a path filter already shows the tree flattened, so the button steps aside while one is typed.
- Stashes can be deleted: every stash in the inspector has a Drop button next to Apply, which runs `git stash drop` on the ref the row shows. Like the other destructive actions in echo it asks nothing first, so the button's tooltip says where the changes go afterwards (the reflog).
- The "Staged changes" and "Changes" group headers in the Changes rail now show the lines added and deleted across the whole group, next to the file count. Each group totals its own side, so a partly staged file is counted once in each group it appears in, and the numbers follow the path filter like the file count does. A binary file has no lines to add up, so the header says `bin` rather than quietly counting it as zero. Hovering a header still swaps the total for that group's Stage all or Unstage all button, so nothing shifts.

- echo can now be stopped from the page, one repository at a time or all at once. The repository switcher (`⌘⇧O`) has a Stop button on each running repository and a Quit all echo processes button at the bottom; both ask first, and the tab that asked says the process is stopping. Work in flight is finished before the port closes, and the language servers are asked to exit the way the protocol says (`shutdown`, then `exit`) instead of being killed, so a half-written cache is not left behind. A repository stopped this way reopens with the usual `echo` command in its folder.
- `Ctrl-C` in the Terminal now stops echo gracefully rather than dropping the connection: a request being served is finished, the status stream ends, the language servers exit, and the port is released. A page still open on a stopped process says it lost the server, as it would for any other interruption.

- The Markdown preview colors code blocks by the language named in the fence, the same way the editor colors them: Go, JavaScript and TypeScript, Rust, Python, Java, Kotlin, Swift, C, C++, Objective-C, C#, Ruby, PHP, Lua, shell, SQL, JSON, YAML, TOML, INI, HTML, XML, CSS, diff, Markdown, Makefiles and Dockerfiles. Escape sequences, comments, strings, numbers, functions, types and properties each get the theme's color, so a block now reads like the same code in the editor. A language echo doesn't know stays plain text, and a block over 200,000 characters is left alone.
- The Markdown preview picks up more of the theme: headings, quotes, strikethrough, highlighted text, table zebra rows, list markers, task checkboxes, and inline code now carry their own colors instead of reading as one flat tone.
- A ` ```mermaid ` fence in Markdown renders as a diagram, in the current theme's colors. mermaid ships inside the binary as a single 1.6 MB zip (`vendor/mermaid.zip`) and is imported the first time a document has a diagram, so a repository without diagrams never pays for it and echo still works with no network. A fence mermaid cannot parse keeps its source, and diagrams are drawn again when the theme changes.
- A diagram in the Markdown preview has an expand button, so a wide flowchart can be read instead of scrolled. It opens over the page at the size mermaid drew it, with a `Fit` button to fill the window instead; `Esc`, the backdrop, or the × closes it and puts the diagram back where it was.

- Added content search, like VS Code's: press `⌘⇧F` or click the magnifier in the sidebar, and type. Results appear as you type, grouped by file with the matches marked; click one to open the file at that line. Toggle match case (`Aa`), whole word (`ab`), and regular expressions (`.*`). New untracked files are searched; ignored and binary files are not. Results stop at 2,000.

- The page has an icon: a small `e` on the echo accent square, as an SVG in `web/favicon.svg`, so browser tabs and bookmarks stop showing a blank page icon. The head also carries a description and `color-scheme` for a correct first paint and a sensible page summary.

- The editor now highlights code using language servers installed on your Mac (gopls, TypeScript, basedpyright, rust-analyzer, clangd, SourceKit-LSP, jdtls, Ruby LSP, Lua, zls, Bash). If a file's server isn't installed, a note above the editor shows the install command with Install, Copy command, and Not now; editing never waits on it.
- Markdown files open rendered, with headings, tables, task lists, alerts, code blocks, images from the repository, and links that open other files in echo. Switch between Preview and Edit in the file bar or with `⌘⇧V`.
- The status bar shows the current file's language server and what it's doing (starting, indexing with the server's progress, ready, failed, not installed). Click it to see every server, why one failed, and Install or Restart.
- Fixed: Java files were barely highlighted, because jdtls colors names but not keywords; keywords are now colored for Java, JavaScript/TypeScript, Python, and C-family files. A server still importing a large project is asked again instead of giving up after 10 seconds.
- Fixed: Java highlighting failed with "language server exited" when `JAVA_HOME` pointed at a JDK older than 21, which jdtls needs. echo now runs jdtls on an installed JDK 21+ without changing your `JAVA_HOME`, and a server that fails to start shows its actual reason.
- Fixed: the editor's line numbers and colors could stop after a few lines when the editor was drawn before it had its final size; they now repaint when the editor is resized.
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
