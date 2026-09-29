# echo decisions

This file is the complete decision log for echo. It records decisions chosen during requirements discovery and defaults chosen while implementing v1.

Status meanings:

- **Accepted** — required direction for the product.
- **v1** — implemented in the first version.
- **Deferred** — accepted direction, but not implemented in v1.
- **Default** — an implementation choice I made where no explicit answer was required.

## 1. Product purpose

- **Accepted:** echo is a personal code review and editing tool.
- **Accepted:** the primary workflow is reviewing working-tree and branch diffs.
- **Accepted:** editing files is a primary workflow, not an afterthought.
- **Accepted:** the product is for personal daily use, not a team platform.
- **Accepted:** echo is local-first. It operates on one repository at a time.
- **Accepted:** the tool should feel like a focused desk, not a general-purpose IDE clone.
- **Accepted:** echo's main job is reviewing code written by coding agents: seeing what changed, proofing it file by file, and accepting or rejecting it.
- **Accepted:** echo reviews agent output; it does not launch, drive, or talk to agents.
- **Default:** the tool focuses on the review loop instead of pull-request hosting or collaboration.

## 2. Platform and distribution

- **Accepted:** macOS only for v1.
- **Accepted:** performance and small resource usage matter more than minimizing development time.
- **Accepted:** the app is launched from Terminal.
- **Accepted:** the app is not a double-click `.app` bundle in v1.
- **Accepted:** the app opens its interface in the default browser.
- **Accepted:** one repository is opened per process/session.
- **Accepted:** the app starts in the current Terminal directory every time.
- **Default:** the default port is `6030`. Without `-port`, echo takes the repository's last port, else the first free port in `6030`–`6049`, so several repositories can be open at once, each in its own process and browser tab. `-port N` binds exactly `N` or fails.
- **Accepted:** a repository keeps its port across restarts (`echo/ports.json` beside the config), because browser storage such as the saved theme is scoped to the origin, and so to the port.
- **Accepted:** running echo in a repository that is already open (auto port mode) opens the existing tab and exits instead of starting a second server.
- **Accepted:** the repository name in the title bar opens a switcher (`⌘⇧O`) listing running echo processes; `↑`/`↓` choose (starting on the first other repository, so `⌘⇧O` `Enter` hops away), `Enter` or click switches the current tab, `⌘Enter` or `⌘`-click opens a new tab. The server discovers siblings by asking each port in the range for `/api/instance`, so the page makes no cross-origin requests and the Host/Origin guard is unchanged.
- **Accepted:** the browser never starts echo processes; opening another repository is done from Terminal.
- **Default:** the app binds to `127.0.0.1` only.
- **Default:** the app does not support LAN, remote, or container access in v1.

## 3. Runtime architecture

- **Accepted:** use Go, not Swift or Rust.
- **Accepted:** build a clean, smaller application from scratch, not a fork of another project.
- **Accepted:** use a small Go HTTP server plus a browser UI.
- **Accepted:** use the system `git` CLI as the Git engine.
- **Accepted:** reuse existing Git credentials, SSH keys, and macOS Keychain helpers.
- **Accepted:** the app does not store Git credentials or tokens itself.
- **Accepted:** produce one self-contained binary with embedded web assets.
- **Accepted:** no Electron, Node, or frontend framework at runtime.
- **Accepted:** no frontend framework such as React.
- **Accepted:** use vanilla JavaScript modules.
- **Accepted:** do not add a frontend build step.
- **Default:** embed the `web/` directory with `go:embed`.
- **Default:** serve static assets directly from the embedded filesystem.
- **Default:** use the Go standard library for HTTP, JSON, and process execution.
- **Default:** do not add a database, ORM, or persistence layer.
- **Default:** do not add telemetry, analytics, or remote services.
- **Default:** use a global config file in the OS user config directory.

Chosen runtime shape:

```text
Terminal
  -> echo Go binary
    -> 127.0.0.1 HTTP server
      -> embedded vanilla JavaScript UI
        -> system git CLI
        -> local filesystem
        -> installed language servers (highlighting)
```

## 4. Core Git scope

The following Git capabilities were accepted as part of the product direction:

- **Accepted:** inspect working-tree changes.
- **Accepted:** inspect staged changes.
- **Accepted:** inspect branch-versus-base diffs.
- **Accepted:** inspect arbitrary commit ranges.
- **Accepted:** browse commit history.
- **Accepted:** create commits with an editable message.
- **Accepted:** amend commits.
- **Accepted:** rebase.
- **Accepted:** pull.
- **Accepted:** push.
- **Accepted:** list local and remote branches.
- **Accepted:** create branches.
- **Accepted:** switch branches.
- **Accepted:** merge branches.
- **Accepted:** stage files.
- **Accepted:** unstage files.
- **Accepted:** discard changes.
- **Accepted:** stage and unstage individual hunks.
- **Accepted:** list stashes.
- **Accepted:** create stashes.
- **Accepted:** apply stashes.
- **Default:** stash pop and drop were added to the Git action API where inexpensive, but the primary required flows are list, create, and apply.
- **Default:** `git restore` is used for stage, unstage, and discard operations.
- **Default:** `git add`, `git commit`, `git commit --amend`, `git rebase`, `git switch`, `git merge`, `git pull`, and `git push` are executed through the system CLI.
- **Default:** the app does not maintain a second Git database or reimplement Git object handling.

## 5. Diff behavior

- **Accepted:** support unified diffs.
- **Accepted:** support split diffs.
- **Accepted:** support word-level change highlighting.
- **Accepted:** support ignoring whitespace when comparing changes.
- **Accepted:** support working-tree, staged, branch/base, and arbitrary ref-range views.
- **Default:** the v1 API uses `git diff --unified=3`.
- **Accepted:** the default diff scope is "all changes": the working tree against `HEAD` (or the empty tree before the first commit), so staging a file never hides it from review.
- **Accepted:** untracked files appear in working-tree diffs as new-file diffs, because agents create files constantly.
- **Default:** untracked files larger than 1 MB are listed without their contents.
- **Default:** diffs use `--no-renames`, so every diff entry maps to exactly one path in the change list.
- **Default:** the review surface renders one section per file with old/new line numbers and a sticky file header.
- **Default:** lockfiles, generated files, and files with more than 1500 diff lines start folded.
- **Accepted:** clicking a commit in history shows that commit's diff (`git show`, first parent for merges).
- **Corrected decision:** clicking a commit no longer copies its id; browsing history would overwrite the clipboard on every click. The expanded commit has a Copy button for the full id instead.
- **Accepted:** history rows show the subject, short hash, the author's full name, and a relative time.
- **Default:** the author name uses `%aN`, so `.mailmap` maps it to the canonical full name.
- **Default:** the server sends the commit time as a Unix timestamp and the browser renders "2h ago", so the SSE status does not change just because time passed.
- **Default:** copying falls back to a hidden-textarea `execCommand('copy')` when the async Clipboard API is denied.
- **Accepted:** the diff has two layouts, "Stacked" (unified: old and new lines in one column) and "Split" (old on the left, new on the right), switched from the review toolbar.
- **Default:** the layout is saved in the global config as `diffMode` (`unified` or `split`); stacked is the default.
- **Default:** split view pairs a run of deletions with the additions that follow it row by row, pads the shorter side with empty cells, and wraps long lines so both sides stay visible.
- **Default:** the v1 UI supports the ignore-whitespace option using `--ignore-all-space`.
- **Default:** range diffs use Git ref syntax such as `from..to`.
- **Default:** the UI includes all-changes, unstaged, staged, ref-range, and single-commit scope selectors.
- **Deferred:** word-level diff rendering.

## 6. Files and navigation

- **Accepted:** use a full file tree rather than a changed-files-only view.
- **Accepted:** show Git status badges in the file tree.
- **Accepted:** file search matches paths, not file contents.
- **Accepted:** changed files should be easy to find while reviewing.
- **Accepted:** support creating files.
- **Accepted:** support deleting files.
- **Accepted:** support renaming files.
- **Accepted:** create, delete, and rename should be Git-aware where possible.
- **Accepted:** file mutations should be available from a context menu and toolbar.
- **Accepted:** the Files view in the sidebar is a folder tree built in the browser from the flat `/api/tree` path list, with change counts on folders and status badges on files.
- **Default:** folders start open when they contain a change or the open file; toggles are kept in memory for the session; filtering shows matches with every folder open.
- **Default:** the v1 file index filters paths as the user types.
- **Accepted:** the file index has two views: the changed files (the default) and all files.
- **Corrected decision:** the Changes view is grouped like VS Code's Source Control instead of a review queue: "Merge changes" (conflicts), "Staged changes" (HEAD to index), and "Changes" (index to working tree, untracked included). A partly staged file is listed in both groups, each with that side's own +/− counts and status letter.
- **Accepted:** each row stages with a `+` icon or unstages with a `−` icon, shown on hover; the group headers carry Stage all (`+`) and Unstage all (`−`), limited to the paths the filter shows. A conflicted row's `+` stages it, which marks it resolved.
- **Accepted:** discarding a row in "Changes" restores only the working tree from the index, so staged work survives; the untracked-file case still deletes the file. The diff header's Discard does the same in the Unstaged view and returns the file to HEAD in the others.
- **Default:** there is no "Discard all" in the group header; a one-click, unconfirmed discard of every file is too easy to hit.
- **Default:** clicking a row while the diff shows Unstaged or Staged switches to that row's side; All changes stays as it is. Groups fold from their header for the session.
- **Default:** the status API carries each change's staged side as `index` and unstaged side as `work` (`added`, `deleted`, `binary`), from `git diff --cached --numstat` and `git diff --numstat`.
- **Accepted:** `⌘K`/`⌘P` open a fuzzy path finder instead of a browser prompt.
- **Default:** the initial implementation skips `.git`, hidden directories, `node_modules`, `dist`, `build`, `.cache`, and `.next` from the tree.
- **Accepted:** in a Git repository the tree comes from `git ls-files --cached --others --exclude-standard`, so ignored files stay out; the same skip rules still apply. Outside Git it walks the directory.
- **Default:** file create, rename, and delete use the local filesystem directly in the first version; Git-aware rename behavior can be tightened later.
- **Default:** file delete removes the selected file without a confirmation dialog.
- **Default:** file create and rename use browser prompts for the path input, not confirmation dialogs.
- **Deferred:** richer context menus.
- **Deferred:** content search across files.

## 7. Editor behavior

- **Accepted:** the editor should be a lightweight browser editor, not a full IDE.
- **Accepted:** the first editor choice was a basic textarea/CodeMirror-style editor.
- **Accepted:** the final v1 editor choice is a plain textarea.
- **Corrected decision:** a separate read-only view is not needed; the plain textarea is always editable.
- **Accepted:** saving writes the file to disk.
- **Accepted:** editing happens in the Files editor, not inside the diff. The diff is fragments of a file, typing would reflow it, and review keys would collide with a text cursor. A short-lived in-diff hunk editor was retired for this reason.
- **Accepted:** double-clicking any diff line (in either layout) or pressing `e` opens the file in the editor with the caret on that line; a deleted line opens where it used to be. `Esc` in the editor returns to the review, at the diff line nearest the caret.
- **Default:** the jump uses the diff's line numbers only where the new side is the working tree (All changes, Unstaged); other scopes open the file at the top.
- **Accepted:** the Files editor is always editable; there is no separate view/edit toggle.
- **Accepted:** the editor gutter shows line numbers and change bars: green for added lines, blue for modified lines, a red wedge where lines were deleted.
- **Accepted:** a setting chooses what the bars compare against. HEAD (the default) shows every change since the last commit, with staged lines drawn hollow and unstaged lines solid. Index shows only unstaged changes, like most editors.
- **Default:** the setting lives under Settings in the `?` card and is saved in the global config as `gutterBase` (`head` or `index`).
- **Default:** the bars are computed in the browser with a Myers line diff against the file at HEAD and in the index (`GET /api/file?path=…&rev=head|index`), update as you type, and refetch their bases when the Git status changes. Past 2000 edits the changed region is simply marked modified.
- **Default:** files that are in neither HEAD nor the index and are not in the change set (ignored files) get no bars.
- **Default:** only visible gutter rows are drawn, so large files cost the same as small ones.
- **Default:** the textarea turns CRLF into LF, so tabs hold LF text and a file whose line endings are all CRLF is saved back with CRLF. A file with mixed endings is saved with LF.
- **Default:** status updates that arrive while the editor is showing mark the diff stale instead of re-rendering it hidden; returning to Review reloads it first and keeps the Review scroll position.
- **Default:** the diff shows the file on disk, so a file with unsaved editor changes is labelled "unsaved edits" in its diff header.
- **Accepted:** saving does not automatically stage the file.
- **Accepted:** staging remains an explicit Git action.
- **Accepted:** unsaved edits stay in memory per tab.
- **Accepted:** switching tabs preserves unsaved edits.
- **Accepted:** only explicit save writes to disk.
- **Accepted:** the interface should behave like a normal editor for basic navigation and file viewing.
- **Accepted:** the editor is highlighted from language-server semantic tokens. The textarea keeps doing all editing; its text turns transparent and a layer behind it draws only the visible lines in color, so large files cost the same as small ones.
- **Default:** while typing, lines above and below the edit keep their last tokens (shifted by the lines added or removed) and the edited lines stay plain until the server answers again, 250 ms after typing stops.
- **Accepted:** Markdown files (`.md`, `.markdown`) open rendered, like a GitHub preview, with a Preview / Edit switch in the file bar (`⌘⇧V`). Jumping to a line from the review opens the source instead.
- **Default:** the Markdown renderer is a small vanilla module (`web/markdown.js`) covering GitHub-flavored Markdown: headings, emphasis, code, fenced blocks, nested and task lists, quotes, `[!NOTE]`-style alerts, tables, reference links, autolinks, and front matter.
- **Default:** raw HTML in Markdown is allowed for layout (centered logos, `<details>`), but everything is parsed inertly and passed through an allowlist of tags and attributes; scripts, event handlers, frames, SVG, and non-web URL schemes are removed, and ids and classes survive only with an `md-` prefix so a document cannot clobber echo's own elements.
- **Default:** relative images load through `/api/raw`, which serves repository files with a `sandbox` Content-Security-Policy and `nosniff`. Remote `https` images (badges) load as in any Markdown preview. Relative links open the file in echo, `#anchors` scroll, and web links open a new browser tab.
- **Default:** file changes are held in browser memory and marked as dirty in the tab.
- **Accepted:** saving sends the hash of the content that was opened; the server refuses the save with `409` if the file changed on disk since, so an agent's edit is never silently overwritten.
- **Accepted:** clean tabs reload automatically when their file changes on disk; dirty tabs show a banner offering the disk version or an explicit overwrite.
- **Default:** tabs can be closed; closing a dirty tab asks first because the unsaved edits exist nowhere else.
- **Default:** binary files are detected (NUL bytes in the first 8000 bytes) and not shown or saved.
- **Deferred:** split editor panes.
- **Deferred:** editor undo/redo features beyond native textarea behavior.

## 8. Language servers

- **Accepted:** use installed language servers for syntax awareness.
- **Accepted:** do not maintain a hard-coded list of supported languages.
- **Accepted:** discover installed language servers automatically.
- **Accepted:** syntax highlighting is the only LSP feature required in the first direction.
- **Deferred:** diagnostics.
- **Deferred:** completion.
- **Deferred:** hover information.
- **Deferred:** go-to-definition.
- **Deferred:** references and call hierarchy.
- **Accepted:** missing language servers must not block opening or editing a file.
- **Default:** fall back to plain text when a language server is unavailable.
- **Default:** do not warn loudly or prevent editing because a server is missing.
- **Corrected decision:** servers cannot be discovered without knowing their command names, so echo keeps a small catalog (`lspServers` in `lsp.go`) mapping file extensions to server commands and install commands: gopls, typescript-language-server, basedpyright, rust-analyzer, clangd, sourcekit-lsp, jdtls, ruby-lsp, lua-language-server, zls, and bash-language-server. A file uses the first installed server for its extension.
- **Default:** servers are looked up on `PATH` plus the folders installers use that a Terminal `PATH` often lacks (`~/go/bin`, `~/.cargo/bin`, `~/.local/bin`, Homebrew, Homebrew's keg-only LLVM, and the Xcode command line tools).
- **Accepted:** when a file's server is not installed, a one-line note above the editor offers Install, Copy command, and Not now. Install runs that catalog entry's command on the server (never a command sent by the page), one at a time, with a ten-minute limit. Not now is remembered per server in the config (`lspDismissed`).
- **Default:** echo is a minimal LSP client over stdio using only the standard library: `initialize`, full-text `didOpen`/`didChange`, and `textDocument/semanticTokens/full`. It answers the server's own requests with empty results. One server process runs per catalog entry per echo process, started on first use, rooted at the repository, and it exits with echo when its stdin closes.
- **Default:** a server that fails to start is not retried until echo restarts or the server is installed from the prompt; a slow answer (a server still indexing) is retried.
- **Default:** servers that classify only names (TypeScript, Pyright, clangd) leave comments, strings, and numbers uncolored, so the editor finds those lexically and lays the server's tokens over them. This runs only when a server is answering; without one the editor stays plain text.
- **Default:** token colors come from the theme's existing tokens (accent for keywords, add for strings, warn for numbers and constants, info for types), so every theme highlights without new palette entries.

## 9. Tabs and workspace model

- **Accepted:** support multiple file tabs.
- **Accepted:** do not restore closed tabs in v1.
- **Accepted:** one repository per session.
- **Accepted:** no multi-repository workspace in v1.
- **Default:** each tab stores `path`, current content, last-saved content, and editor mode.
- **Default:** the active tab is the only tab rendered in the editor surface.
- **Default:** a dirty tab is indicated visually.
- **Deferred:** tab restore.
- **Deferred:** split tab groups.
- **Deferred:** recent-repository list.

## 9a. Review marks

- **Corrected decision:** per-file review marks were removed. Staged versus unstaged, shown as separate groups in the Changes view (§6), replaces them: stage what you have checked, and what is left is still to look at. Marks left in browser storage from earlier versions are ignored.

## 10. Conflicts

- **Accepted:** merge and rebase conflicts should be visible while reviewing.
- **Accepted:** the first direction considered a visual conflict-resolution interface.
- **Corrected decision:** a dedicated conflict-resolution UI is not required in v1.
- **Accepted:** conflict markers should be shown for manual editing.
- **Accepted:** the user is responsible for resolving the file contents manually.
- **Default:** Git conflict markers remain in the file until the user edits and saves them.
- **Default:** no ours/theirs chooser is built in v1.
- **Deferred:** dedicated conflict resolution controls.
- **Deferred:** guided “mark resolved” and continue/abort UI.

## 11. Stash behavior

- **Accepted:** list stashes.
- **Accepted:** create stashes.
- **Accepted:** apply stashes.
- **Default:** stash creation includes untracked files with `git stash push -u`.
- **Default:** stash messages are optional in the API, with a fallback message used by the UI.
- **Default:** stash entries are shown with Git’s stash ref and subject.
- **Deferred:** stash drop from the main UI.
- **Deferred:** stash pop from the main UI.
- **Deferred:** stash diff previews.

## 12. Git refresh and live updates

- **Accepted:** detect repository changes made outside the app.
- **Accepted:** detect filesystem and Git changes made from Terminal or another editor.
- **Accepted:** do not require a manual refresh for normal external Git operations.
- **Accepted:** use Server-Sent Events for live updates.
- **Default:** the server polls Git status every two seconds and only sends an SSE event when the status changed.
- **Default:** status includes each changed file's content hash, cached by size and mtime, so edits to an already-modified file are still detected.
- **Default:** every Git command runs with `--no-optional-locks`, so echo's polling never contends for `index.lock` with an agent's Git commands.
- **Default:** Git commands run with `GIT_TERMINAL_PROMPT=0`, so a push that needs credentials fails instead of hanging.
- **Default:** the implementation keeps the refresh loop deliberately simple rather than using native filesystem event libraries.
- **Default:** the UI also performs an explicit refresh after app actions.
- **Default:** the status carries a build id (a hash of the embedded web assets). A page whose build differs from the server's reloads itself, since EventSource reconnects old pages to a restarted server; with unsaved editor edits it asks you to save and reload instead. Static files are served with `Cache-Control: no-cache`.
- **Default:** the endpoint is `/api/history`, not `/api/log`, because browser ad and tracker blockers block `/api/log?…` requests (`net::ERR_BLOCKED_BY_CLIENT`), which left the History tab empty.
- **Default:** History and the Log reload after the live connection drops and reconnects. A failed History load keeps the last list on screen and retries every three seconds, instead of showing an empty list until the next ref change.
- **Default:** status updates include the working-tree status map, staged state, branch, recent commits, branches, and stashes.
- **Deferred:** native macOS filesystem event APIs.
- **Deferred:** fine-grained event deduplication and per-file invalidation.

## 12a. Git window (IntelliJ / GitLens direction)

- **Accepted:** the Git experience follows IntelliJ IDEA's Git tool window, with GitLens-style extras.
- **Accepted:** the title bar shows the current branch with incoming (↓) and outgoing (↑) commit counts against its upstream, next to Fetch and Sync buttons.
- **Accepted:** ahead/behind counts are only as fresh as the last fetch, so the Fetch button shows how long ago the repository was fetched (the mtime of `FETCH_HEAD`).
- **Accepted:** fetching is manual only; echo never touches the network unprompted. Fetch runs `git fetch --all --prune`.
- **Accepted:** Sync pulls, then pushes if the branch is still ahead. It stops if the pull fails. The pull respects the user's `pull.rebase` / `pull.ff` config, so a diverged branch with no config stops with Git's own message.
- **Accepted:** a branch with no upstream shows Publish instead of Sync (`git push -u <remote> <branch>`, preferring `origin`).
- **Default:** ahead/behind for every local branch comes from one `git for-each-ref` call with `%(upstream:track)`; the branch list shows the counts too.
- **Default:** network actions (fetch, pull, push, sync, publish) run one at a time with a timeout; a second request while one is running gets `409`.
- **Accepted:** the full commit log is a third main-surface mode, "Log" (Review · Files · Log): a filter bar (text/hash, branch, author, path), a graph table (lanes, ref chips, subject, author, date), and a details pane.
- **Accepted:** the right panel's History tab stays as a compact log with the same graph lanes; a commit row expands in place to show its details and changed files.
- **Accepted:** commit details show the subject and full body, author and committer, a copyable hash, parents, the branches and tags that contain the commit, and a collapsible folder tree of changed files with +/− counts. Clicking a file opens Review scoped to that commit at that file; `Esc` returns to the log.
- **Default:** in the History tab, clicking a commit expands it in place (one at a time) and shows its diff in Review; clicking it again folds it. Single-child folder chains in the file tree collapse into one row.
- **Default:** details come from a lazy `GET /api/commit?hash=`; `--contains` lookups load after the rest because they can be slow on large repositories.
- **Default:** commits move out of the SSE status into `GET /api/history` (paged, 200 at a time); the status carries a refs signature so the browser refetches the log only when refs change.
- **Default:** graph lanes are computed in the browser from `%H %P %D` in topological order and drawn as SVG, without a library. Lanes keep their column (no compaction), colors follow the lane, merge commits are hollow dots, and the graph is capped at 16 lanes wide.
- **Default:** "All branches" means `--branches --remotes --tags HEAD`, not `--all`, so stashes and echo's own refs never appear in the graph.
- **Default:** the Log search matches commit messages as literal, case-insensitive text; a 4–40 character hex string that names a commit jumps to that commit instead. Author and path filters work like `git log --author` and `git log -- <path>`.
- **Default:** the History tab shows the current branch (100 commits) with the same graph; the lanes continue through an expanded commit.
- **Default:** in Log, `↑`/`↓` or `j`/`k` move the selection, `Enter` or a double-click opens the diff in Review, and `Esc` in Review returns to the Log with the selection kept.
- **Accepted:** in Log mode the sidebar shows a Branches tree (local, remote, tags) that filters the log; the branch pill opens an IntelliJ-style branches popup with checkout, merge, rebase, compare, and delete.
- **Default:** the sidebar has a third rail, Branches: "All branches", "Current branch", then Local, Remote, and Tags, with names grouped into folders by their `/` prefixes and local branches showing ↓/↑. Clicking an entry shows it in the Log. Entering the Log switches the sidebar to Branches and leaving it restores the previous rail. The sidebar filter box filters branches on this rail.
- **Default:** every branch or tag has one action menu, opened from ⋯ or right-click in the sidebar or from a row in the branches popup: Checkout (a remote branch checks out its local branch, creating a tracking one if needed; a tag checks out detached), New branch from here, Merge into the current branch, Rebase the current branch onto it, Compare with the current branch, Show in Log, and Delete for local branches.
- **Default:** Delete uses `git branch -d`, so Git refuses to delete unmerged work; there is no force delete and no remote branch delete in the UI.
- **Default:** new branch names are asked with a browser prompt, like file paths.
- **Default:** in the branches popup, typing filters; Enter on a single match opens its menu, and Enter again runs the first action (usually Checkout).
- **Default:** the Log adapts to its own width (a container query), not the window's: below 860px the details pane moves under the graph, and below 620px the author column hides.
- **Accepted:** GitLens extras in scope: file history (`git log --follow` for a file), inline blame on the editor's caret line with a blame gutter toggle, and compare branches (commits only in A / only in B plus the combined diff).
- **Default:** file history is the Log filtered to one path on the current branch, following renames (`git log --follow`, used when the path is a file rather than a folder). It opens from History in the editor's file bar or a diff file header; Enter or View diff jumps to that file in the commit.
- **Default:** blame runs on the editor's text (`git blame --porcelain --contents -`), so unsaved edits line up and show as "not committed yet". It refetches 600 ms after typing stops and when a ref moves; stale blame is hidden rather than shown on the wrong lines.
- **Default:** inline blame (author, age, and subject after the caret line, GitLens-style) is on by default; Settings turns it off, saved in the config as `blame` (`line` or `off`). The Blame button in the file bar adds a per-line column for the session; clicking an entry opens that commit in the Log.
- **Default:** Compare with the current branch shows two lists in the Log, "Only in <other>" and "Only in <current>" (`a..b` and `b..a`, up to 500 each), with a swap button. "Files changed" opens the merge-base diff (`a...b`, what a pull request shows); Esc returns to the comparison.
- **Default:** the Compare refs scope has a `..` / `...` toggle: two dots compare the tips, three dots compare from the merge base.
- **Default:** delivery order: A) ahead/behind, Fetch, Sync/Publish; B) commit details and files; C) `/api/history`, graph, Log mode; D) branches sidebar and popup; E) file history, blame, compare.

## 13. Non-Git directories

- **Accepted:** the app should still open directories that are not Git repositories.
- **Accepted:** file browsing, reading, editing, and path search should still work.
- **Accepted:** Git actions should be disabled or hidden.
- **Default:** the Git status response reports `git: false` with a non-fatal message.
- **Default:** the rest of the interface remains usable as a lightweight editor.

## 14. Configuration and layout

- **Accepted:** preferences should be available in memory and persisted locally.
- **Accepted:** configuration is global, not separate per repository.
- **Accepted:** panel visibility should be configurable.
- **Accepted:** panel sizes should be configurable.
- **Accepted:** panel order should be configurable.
- **Default:** the config file is stored under the OS user config directory as `echo/config.json`.
- **Default:** the config contains vim mode, theme, diff mode, gutter base, inline blame, panel list, and panel sizes.
- **Default:** panel visibility toggles are available in the v1 header.
- **Deferred:** draggable panel resizing.
- **Deferred:** drag-to-reorder panel layout.
- **Deferred:** per-project layout profiles.
- **Default:** recent repositories are not listed because the app always starts in the current Terminal directory; `ports.json` records roots only to keep each one's port.
- **Accepted:** every echo process shares one config file, so a config POST is a patch applied to the file as it is on disk, and GET reads the file, so one repository's tab does not undo settings changed in another. Writes are atomic (temp file and rename).

## 15. Keyboard and navigation

- **Accepted:** use fixed shortcuts rather than user-configurable keybindings.
- **Accepted:** support vim-style navigation.
- **Accepted:** vim mode is opt-in, not enabled by default.
- **Accepted:** use familiar editor shortcuts where they fit the smaller scope.
- **Default:** include shortcuts for file search, tree toggle, Git panel toggle, diff toggle, save, help, and escape.
- **Default:** `e` opens the current hunk in the editor; `Esc` in the editor goes back to the review.
- **Default:** use `⌘⇧O` for the repository switcher, `⌘K`/`⌘P` for file search, `⌘B` for the file index, `⌘J` for the action ledger, `⌘D` for diff, and `⌘S` for save on macOS.
- **Default:** `?` opens the shortcut card.
- **Deferred:** full vim modal navigation and command language.
- **Deferred:** user-remappable shortcuts.

## 16. Visual design

- **Accepted:** the interface must not look like a clone of another tool.
- **Accepted:** echo should have its own visual identity.
- **Accepted:** the interface should feel focused, fast, personal, and review-oriented.
- **Accepted:** the look is professional and minimal: system UI font, monospace only for code and paths, sentence-case labels, no grain or grid texture.
- **Corrected decision:** review marks ("Reviewed", "Mark reviewed", the check circle, the reviewed tally, and the `x` key) are removed; staging is the record of what has been looked at.
- **Accepted:** three panes: sidebar (Changes / Files / Branches), main surface (Review / Files), and a Git panel. The Git panel has tabs (Commit, History) so later views can be added as tabs without changing the layout.
- **Default:** the title bar carries the repository, branch, a "Go to file" search, panel toggles, the theme picker, and help; a status bar shows the live-connection dot, status, and key hints.
- **Accepted:** support multiple open-source themes, chosen one at a time. The default "System" follows macOS appearance: echo paper when light, echo ink when dark.
- **Accepted:** the theme set is hand-curated rather than generated: echo ink/paper, GitHub light/dark, Solarized light/dark, Catppuccin Latte/Mocha, Rosé Pine/Dawn, Nord, Gruvbox Dark, Tokyo Night, and Dracula (all MIT-licensed palettes).
- **Default:** each theme is one block of about 16 tokens in `web/themes.css`; `style.css` only reads tokens and derives soft/strong tints with `color-mix`.
- **Default:** the chosen theme is saved in the global config and mirrored to `localStorage` so a small inline script can apply it before first paint.
- **Default:** no remote font service is required at runtime.

## 17. Safety and security

- **Accepted:** do not store secrets in the application config.
- **Accepted:** reuse system Git authentication.
- **Accepted:** destructive actions do not require confirmation dialogs.
- **Accepted:** the user accepts that delete, discard, and other destructive operations can happen immediately.
- **Default:** the server rejects absolute paths.
- **Default:** the server rejects paths that escape the repository root.
- **Default:** file reads and writes are constrained to the current workspace.
- **Default:** the server binds to localhost only.
- **Accepted:** the server rejects requests whose `Host` is not `127.0.0.1:<port>` or `localhost:<port>` (DNS rebinding), whose `Origin` is another site, and writes that are not `application/json` (cross-site form posts).
- **Accepted:** user-supplied refs and branch names that start with `-` or contain whitespace or control characters are rejected, so they cannot become Git options.
- **Default:** discard deletes untracked files (`git clean -f -- <path>`) and restores tracked ones, so agent-created files can be rejected.
- **Default:** no remote host flag is implemented.
- **Default:** no embedded credential store exists.
- **Default:** no telemetry or analytics data is collected.
- **Default:** browser prompts are used only to collect path input where a custom dialog has not been built.

## 18. Deliberate simplifications

These are YAGNI decisions for v1:

- No database.
- No Git library.
- No Electron.
- No React.
- No frontend bundler.
- No TypeScript build pipeline.
- No multi-repository workspace.
- No pull-request hosting or GitHub API integration.
- No AI agent integration (echo reviews agent output; it does not run agents).
- No collaboration or presence features.
- No theme marketplace or user-imported themes; the theme list is curated in `web/themes.css`.
- No plugin system.
- No native file-picker dependency.
- No conflict-resolution workflow UI.
- No virtualized editor.
- No content search.
- No full LSP feature set.
- No per-repository configuration.
- No closed-tab restore.
- No custom keybinding editor.

## 19. Deferred roadmap

These are not rejected. They are waiting until the basic review loop is proven:

2. Hunk-level stage and unstage controls.
4. Word-level diff highlighting.
5. Native file picker and richer context menus.
6. Draggable panel sizing and reordering.
7. Full vim mode.
8. Conflict continue/abort controls.
9. Stash pop/drop UI and stash diffs.
10. Large-file truncation and streaming improvements.
11. Native macOS filesystem events instead of polling.
12. Better handling of Git rename/delete metadata in the file tree.

## 20. Implementation rules

- Keep the Go server small and explicit.
- Prefer the standard library over new dependencies.
- Keep `web/` framework-free and build-step-free.
- Use the system `git` CLI for all Git state changes.
- Keep destructive behavior fast and unconfirmed, as chosen.
- Never weaken path validation or local-only binding.
- Update `changelog.md` when behavior changes.
- Update this file when a decision changes.
- Update `agents.md` when repository rules change.
- Run `gofmt -w main.go` and `go test ./...` before handoff.
