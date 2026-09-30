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
- **Accepted:** the browser may stop them. The switcher has a Stop button per running repository and a Quit all button, and both go through `POST /api/shutdown`, because ending a process is the opposite of taking over the machine: it is the safe direction, and it is what makes a dozen open repositories manageable. The request is answered before the server stops, so the tab can confirm it, and a stopped repository reopens with the usual Terminal command.
- **Default:** `POST /api/shutdown` takes an optional `port` (a sibling, stopped by this process asking it, so the page still makes no cross-origin request) or `all` (every running process, this one last, so the list the page is looking at is still there). A stop request that has already happened is not repeated.
- **Default:** a stop is graceful. The status stream ends first, because it waits on a tick and would otherwise hold the drain open; in-flight requests then get three seconds, which is far longer than a git call or a read, and anything still running is closed. `Ctrl-C` (`SIGINT`) and `SIGTERM` take the same path, so a Terminal interrupt and the page's Stop behave identically. Language servers are stopped either way, so a Ctrl-C does not leave gopls and friends behind.
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
- **Default:** stash pop and drop were added to the Git action API where inexpensive; drop is now also in the main UI, and list, create, and apply remain the primary flows.
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
- **Accepted:** the `⌘K` file finder matches paths; content search is the separate Search tab below.
- **Accepted:** changed files should be easy to find while reviewing.
- **Accepted:** support creating files.
- **Accepted:** support deleting files.
- **Accepted:** support renaming files.
- **Accepted:** create, delete, and rename should be Git-aware where possible.
- **Accepted:** file mutations should be available from a context menu and toolbar.
- **Accepted:** the Files view in the sidebar is a folder tree built in the browser from the flat `/api/tree` path list, with change counts on folders and status badges on files.
- **Default:** folders start open when they contain a change or the open file; toggles are kept in memory for the session; filtering shows matches with every folder open.
- **Default:** the v1 file index filters paths as the user types.
- **Accepted:** the Files rail can fold and unfold the whole tree. One button beside the filter sets every folder at once, in the same map a folder opened on its own uses, so a fold survives the tree reloading; the button's icon and tooltip say which of the two it will do, which is the only state it needs since the tree is open by default wherever it holds a change.
- **Default:** the fold button steps aside while a path filter is typed. A filter already opens every folder to show the matches, so folding would look broken rather than do nothing quietly.
- **Accepted:** the file index has two views: the changed files (the default) and all files.
- **Corrected decision:** the Changes view is grouped like VS Code's Source Control instead of a review queue: "Merge changes" (conflicts), "Staged changes" (HEAD to index), and "Changes" (index to working tree, untracked included). A partly staged file is listed in both groups, each with that side's own +/− counts and status letter.
- **Accepted:** each row stages with a `+` icon or unstages with a `−` icon, shown on hover; the group headers carry Stage all (`+`) and Unstage all (`−`), limited to the paths the filter shows. A conflicted row's `+` stages it, which marks it resolved.
- **Accepted:** discarding a row in "Changes" restores only the working tree from the index, so staged work survives; the untracked-file case still deletes the file. The diff header's Discard does the same in the Unstaged view and returns the file to HEAD in the others.
- **Default:** there is no "Discard all" in the group header; a one-click, unconfirmed discard of every file is too easy to hit.
- **Default:** clicking a row while the diff shows Unstaged or Staged switches to that row's side; All changes stays as it is. Groups fold from their header for the session.
- **Default:** the status API carries each change's staged side as `index` and unstaged side as `work` (`added`, `deleted`, `binary`), from `git diff --cached --numstat` and `git diff --numstat`.
- **Accepted:** group headers total the lines added and deleted across the group, beside the file count. The total is summed in the browser from the per-side counts the status already carries, so no new Git call is made and the number can never disagree with the rows above it. Each group totals its own side, so a partly staged file is counted once per group it appears in.
- **Default:** the group total follows the path filter, like the file count beside it and the bulk actions, so the header always describes what is actually listed.
- **Default:** a binary file has no line counts to sum, so a group holding one says `bin` instead of counting it as zero lines.
- **Default:** the Merge changes group carries no total; a conflicted file has no meaningful line count on either side.
- **Default:** hovering a group header swaps its total for that group's Stage all or Unstage all button, matching how a row's own counts give way to its actions, so the header never shifts under the pointer.
- **Accepted:** `⌘K`/`⌘P` open a fuzzy path finder instead of a browser prompt.
- **Default:** the initial implementation skips `.git`, hidden directories, `node_modules`, `dist`, `build`, `.cache`, and `.next` from the tree.
- **Accepted:** in a Git repository the tree comes from `git ls-files --cached --others --exclude-standard`, so ignored files stay out; the same skip rules still apply. Outside Git it walks the directory.
- **Default:** file create, rename, and delete use the local filesystem directly in the first version; Git-aware rename behavior can be tightened later.
- **Default:** file delete removes the selected file without a confirmation dialog.
- **Default:** file create and rename use browser prompts for the path input, not confirmation dialogs.
- **Deferred:** richer context menus.
- **Corrected decision:** content search was deferred, then added: a fourth sidebar tab, **Search** (a magnifier icon, `⌘⇧F`), like VS Code's search view. Clicking a result opens the Files editor at that line.
- **Accepted:** the server runs `git grep -n --column -I -z`, with `--untracked` in a repository so files an agent just created are included, and `--no-index --exclude-standard` in a plain folder. Ignored and binary files are never searched, and there is no option to include them.
- **Accepted:** the options are match case, whole word, and regular expression (`-i` off, `-w`, `-E`; otherwise `-F`). There are no include/exclude globs and no Replace; Replace would be a multi-file write outside the editor's stale-save check.
- **Accepted:** results are grouped by file, with match counts, groups that fold, and the matches marked. git grep reports only where a line matched, so the browser rebuilds the query as a JavaScript regular expression to mark them.
- **Accepted:** search runs as you type, 250 ms after the last key, once the query has two characters. A new query aborts the request in flight, and the server's request context kills that git grep.
- **Default:** results stop at 2,000 matches and say "2,000+ results — refine your search", with no paging; lines are trimmed to about 200 bytes around the match. Results rerun when the repository status changes, so line numbers follow the agent's edits.

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
- **Accepted:** word wrap is a checkbox in the Settings section of the `?` card, beside the other view preferences. It is a preference about how code is read rather than a control for one view, and it covers two surfaces, which is why it is not a button in the file bar.
- **Default:** wrap is off by default, so the editor keeps the fixed-pitch layout it has always had, and it lasts for the session, like the per-line blame column rather than like the saved gutter base. A line too long to break is broken mid-token, which is what a soft-wrapped textarea does, so the color and the caret never disagree about where the text is.
- **Corrected decision:** the editor's geometry is not a fixed 20px pitch. With wrap on, a line is as tall as it needs to be, so the gutter, the change bars, the syntax layer and the inline blame note are placed from measured line heights. The measurement is a hidden mirror, one block per line, given exactly the textarea's content box, because that is the only way to agree with the browser about tabs, wide characters and words too long to fit; heights are kept as a running offset and measured in batches, so a jump into a large file doubles a batch at a time instead of measuring it twice. The content box is read off the textarea rather than derived from the stage, since the textarea's own scrollbar makes it narrower than the stage behind it, and that same width is published to the syntax layer.
- **Default:** wrapping a stacked diff gives up the hunk's max-content width so the text column can wrap, and the line-number columns stay put. The split layout already wraps both sides and is left alone.
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
- **Default:** a fenced code block in the preview is colored by the language named in the fence, using the same highlighter as the editor and diffs (§8), so a block looks like the same code in the editor. A language it does not know stays plain text, and a block over 200,000 characters is left alone rather than building a large DOM for a document to scroll past.
- **Rejected:** chroma (or goldmark) for the preview, which is the usual choice. It is the better answer for a full renderer — ~250 lexers and complete GFM — but it adds 5.7 MB of Go dependency to a binary that currently has none, and its token types are a second vocabulary that has to be mapped onto the editor's semantic tokens anyway. What it buys is breadth; what it costs is the standard-library-only rule and the shared token colors. Reconsider if the preview's languages become a complaint.
- **Default:** a ` ```mermaid ` fence renders as a diagram. mermaid's own ESM build (v12) ships in the binary as one 1.6 MB zip, `vendor/mermaid.zip`, served straight out of the archive at `/vendor/mermaid/`, and is imported only when a document actually has a diagram: 5.4 MB of loose module files compress to 1.6 MB, and the zip lives outside `web/` so it is embedded once rather than twice. The page keeps working with no network, and mermaid draws in `securityLevel: 'strict'`, which is what stops a label in a diagram from becoming markup. A fence mermaid cannot parse keeps its source, and diagrams are redrawn when the theme changes because their colors are baked into the SVG.
- **Default:** to move to another mermaid release, replace `vendor/mermaid.zip` with the new `dist` (`mermaid.esm.min.mjs` and `chunks/mermaid.esm.min/`, plus `LICENSE` and `package.json`) zipped with `zip -X -9 -r ../../vendor/mermaid.zip mermaid.esm.min.mjs chunks LICENSE package.json`. `TestMermaidServedFromZip` fails if the entry's imports are not all in the archive.
- **Default:** a diagram carries an expand button and opens in a card over the page. Expanding moves the drawn svg rather than drawing it twice, so there is one copy and no flicker; closing puts it back where it was. It opens at the width in the svg's viewBox, because mermaid's `width="100%"` otherwise stretches a small diagram to the column and blurs a large one on a wide screen, and `Fit` is the mode that fills the window instead. The card takes its height from the diagram and scrolls when the diagram is taller than the window.
- **Default:** file changes are held in browser memory and marked as dirty in the tab.
- **Accepted:** saving sends the hash of the content that was opened; the server refuses the save with `409` if the file changed on disk since, so an agent's edit is never silently overwritten.
- **Accepted:** clean tabs reload automatically when their file changes on disk; dirty tabs show a banner offering the disk version or an explicit overwrite.
- **Default:** tabs can be closed; closing a dirty tab asks first because the unsaved edits exist nowhere else.
- **Default:** binary files are detected (NUL bytes in the first 8000 bytes) and not shown or saved.
- **Deferred:** split editor panes.
- **Deferred:** editor undo/redo features beyond native textarea behavior.

## 8. Syntax highlighting

- **Accepted (supersedes language servers):** highlighting runs in the browser on a vendored copy of highlight.js (`web/vendor/hljs.js`, v11.11.1 "common" build, BSD-3, byte-identical to `@highlightjs/cdn-assets` on npm; license beside it). `web/highlight.js` is a thin wrapper. It colors the editor, both diff layouts (stacked and split) and Markdown fences the same way, using `.hljs-*` rules in `style.css` built from theme colors.
- **Why not language servers:** the only LSP feature echo used was semantic tokens. That needed per-language installs, a background process each, a status chip and a popover. Go-to-definition, hover and diagnostics were never built.
- **Why not chroma/goldmark:** goldmark is a Markdown parser, not a highlighter. Chroma runs server-side, so the editor would pay a round trip per keystroke, and it is a Go dependency. A vendored browser library keeps highlighting local and instant, with the precedent of the vendored mermaid.
- **Default:** the language comes from the file name (extension or `Makefile`). An unknown language or a buffer over 200 KB stays plain text. The common build has no Dockerfile grammar; Dockerfiles stay plain. To add a language, re-vendor a build that includes it.
- **Default:** a diff hunk is colored as two streams, old (context + deleted) and new (context + added), so multi-line comments and strings color correctly inside a hunk. A token opened above the hunk is not seen.
- **Deferred:** anything semantic (diagnostics, completion, hover, go-to-definition, references). It would mean bringing a language server back.

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
- **Accepted:** drop stashes. The API already had `stash:drop`; the inspector now exposes it as a Drop button per row, using the ref the status reported, so a drop after another drop cannot land on the wrong stash.
- **Default:** stash drop is unconfirmed, following the rule that destructive actions in echo do not ask first. The button's tooltip carries the consequence instead.
- **Default:** stash creation includes untracked files with `git stash push -u`.
- **Default:** stash messages are optional in the API, with a fallback message used by the UI.
- **Default:** stash entries are shown with Git’s stash ref and subject.
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

## 12b. Discard all and Stage all & Commit

- The Changes group header has a Discard all button. It runs the same worktree discard as the per-row button over the visible rows (untracked files are deleted, staged work stays) but confirms first, because it is many files at once.
- Setting `commitAll` (off by default) makes Commit mean "stage everything, then commit". Any stage-all commit, whether from the setting or the split-button menu, asks first with a warning that staged and unstaged changes will both be committed. Committing staged only never asks.
- `commit:all` runs `git add -A -- .` then `git commit`, and refuses while `git ls-files -u` shows conflicts, so a conflict cannot be marked resolved by accident.

## 12c. Reset and Revert

- **Accepted:** Reset branch here (soft only) and Revert are actions on a commit, shown in the commit details of the History tab and the Log. Mixed and hard reset are not offered: hard fits badly with the rule that echo's destructive actions are immediate, and soft loses no work.
- **Default:** `reset:soft` asks first (unlike discard, it rewrites history), listing up to ten commits it will undo and counting those already on the upstream. It warns about pushed commits; pushing them afterwards is a force push (section 12d). Recovery is the reflog, and the success message names the old tip.
- **Default:** the server allows a soft reset only to a strict ancestor of HEAD on a checked-out branch, with no merge, revert, cherry-pick, or rebase in progress (`/api/reset/preview` runs the same check for the dialog).
- **Default:** `revert` runs `git revert --no-edit` with no confirmation, since it only adds a commit that can be reverted in turn. A merge commit needs a mainline `parent` (1-based, `-m`); the dialog asks, defaulting to 1, and the server rejects a missing or out-of-range parent.
- **Default:** a revert that stops on conflicts leaves Git's `REVERT_HEAD`; the status reports `reverting` and the Commit card shows Continue (`revert --continue`, editor disabled) and Abort (`revert --abort`). This is the one exception to §10's "no continue/abort UI", because a stuck revert has no other exit in the app.

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

## 12d. Force push

- **Accepted:** Push has a caret menu with **Force push with lease** and **Force push (no lease)**. The plain Push button never forces.
- **Accepted:** both ask first, unlike discard: they rewrite shared history. The lease dialog is `warn`, the no-lease dialog is `danger`, and the menu lists the lease first.
- **Default:** actions are `push:lease` and `push:force`, run through the network path (single-flight, timeout, `409` when busy).
- **Default:** the server pushes `<remote> HEAD:<upstream ref>` taken from the current branch's upstream, never a bare `git push --force`, so `push.default=matching` cannot widen the blast radius. No upstream, an upstream of `.`, or a detached HEAD is refused.
- **Default:** the lease is Git's own `--force-with-lease` against the remote-tracking ref, so it only protects as well as the last fetch (a background fetch elsewhere can move that ref). `--force-if-includes` is not used, as it needs Git 2.30.
- **Default:** Sync and Publish never force.

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
- **Corrected decision:** draggable panel resizing was deferred, then added; the sidebar and the Git panel are dragged to a width and the width is saved (see section 16). Panel order is still fixed.
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
- **Default:** use `⌘⇧O` for the repository switcher, `⌘K`/`⌘P` for file search, `⌘⇧F` for content search, `⌘B` for the file index, `⌘J` for the action ledger, `⌘D` for diff, and `⌘S` for save on macOS.
- **Default:** `?` opens the shortcut card.
- **Deferred:** full vim modal navigation and command language.
- **Deferred:** user-remappable shortcuts.

## 16. Visual design

- **Accepted:** the interface must not look like a clone of another tool.
- **Accepted:** echo should have its own visual identity.
- **Accepted:** the interface should feel focused, fast, personal, and review-oriented.
- **Corrected decision (2026-09-30 revamp, "Signal"):** the look is an instrument: dense, dark first, keyboard-first. Geist for the interface and Geist Mono for code, paths, counts and hashes, both embedded in the binary (`web/fonts/`, SIL OFL, about 140 KB as two variable woff2 files) and served locally, so no font is fetched from the network. Sentence-case labels and no grain or grid texture still hold.
- **Accepted:** colour is for change. Add, delete, and the accent are the only saturated colours; chrome stays neutral. The accent (Ember amber in echo ink) marks focus only: the current file, the current hunk, and the primary action.
- **Accepted:** the change trace. The title bar shows the whole diff in the current scope as one strip: a segment per file and a tick per hunk, with additions rising above a baseline and deletions dropping below it. The current hunk is the playhead and follows `j`/`k` and scrolling. In All changes, a file with nothing left unstaged fades. Clicking a tick opens Review at that hunk, unfolding the file if needed. Around the strip are the file count with +/− totals and "n/m staged".
- **Default:** a trace segment's width grows with the square root of its changed lines, so one huge file cannot squeeze the rest to nothing. A tick's height grows with the square root of its hunk's lines, capped at 30. File names show under segments that are at least 44px wide (a container query); every segment and tick has a tooltip.
- **Accepted:** hunk headers read as places, not Git's `@@` line: a pill with "n/m" and the enclosing function Git found, then the hunk's +/− size and the lines it covers in the new version. The raw `@@` range stays as the tooltip. The current hunk's pill turns accent.
- **Accepted (2026-09-30):** the hunk heading names where the change sits, and shows nothing rather than a wrong guess. Git only uses a language's heading rule for files whose `diff` attribute names a driver; otherwise it takes the nearest line above that starts with a letter (the neighbouring CSS rule, a random Markdown bullet). echo's own diff calls turn Git's built-in drivers on by extension (Go, CSS/SCSS/Less, HTML, Markdown, Python, Rust, Java, Kotlin, Ruby, PHP, C/C++, C#, Objective-C, Perl, shell, Elixir, TeX, and more). They add a JavaScript/TypeScript rule Git lacks (function declarations, named arrow functions, classes) and give data files (JSON, YAML, TOML, lockfiles, SVG, XML, plain text, licences) no heading. They do this with `-c core.attributesFile=<echo's file>` and `-c diff.<driver>.xfuncname=…` on that one command, so neither the repository nor the user's Git config changes.
- **Default:** the attributes file is `diff.gitattributes` beside the config, written once per process. The user's global attributes (their `core.attributesFile`, or Git's XDG default) are copied in after echo's lines, and the repository's own `.gitattributes` outranks both, so the user's drivers always win. An edit to the global attributes file applies from the next start. If the file cannot be written, diffs keep Git's own headings.
- **Default:** the browser shortens the heading line to its name: a Go func with its receiver (`(a *App) network`), a JS function or named arrow (`clampWidth`), `class`/`type`/`struct` names, Python `def` and Rust `fn` names, and Markdown or HTML heading text. Anything else (a CSS rule, a C function) is kept up to its opening brace. The label is dimmer than the hunk count, the full `@@` line and heading are the tooltip, and trace tooltips use the same label.
- **Default:** the current hunk is the last hunk of the current file whose header has reached the top of the diff, which is also where `j`/`k` leave it. The status bar shows "file i/n · hunk j/m".
- **Corrected decision:** review marks ("Reviewed", "Mark reviewed", the check circle, the reviewed tally, and the `x` key) are removed; staging is the record of what has been looked at.
- **Accepted:** three panes: sidebar (Changes / Files / Branches), main surface (Review / Files), and a Git panel. The Git panel has tabs (Commit, History) so later views can be added as tabs without changing the layout.
- **Corrected decision (2026-09-30):** the Git panel is a drawer over the right side of the review, opened from a 46px rail (Commit, History, Branches) or `⌘J`, and closed with `⌘J`, `Esc`, or its ✕. The diff keeps its full width until you ask for Git. The rail shows badges for staged files and commits to push. Opening on Commit with something staged puts the caret in the message. Clicking outside does not close it, so you can scroll the diff while writing the message.
- **Accepted (2026-09-30):** the Git panel can be pinned: the pin in its header, or Settings › Layout, docks it as an ordinary column beside the review, open by default. Pinned, `⌘J` still hides and shows it, and `Esc` leaves it alone. The choice is saved in the config as `gitPinned`.
- **Accepted (2026-09-30):** Settings › Layout › Panel sides swaps the sides: the file sidebar goes to the right, and the Git rail and panel go to the left. It is saved as `swapPanels`. The grips move to the panels' inner edges and drag the right way round. The drawer then opens from the left rail.
- **Corrected decision (2026-09-30):** the Git rail is hidden by default. The title bar's Git button and `⌘J` open the panel. The button shows the staged-file badge and turns accent while the panel is open. History is a tab inside the panel, and Branches is the branch pill. Settings › Layout › Git rail › Shown brings the rail back (`showRail`); with the rail shown, the badge moves back to it, so it is never shown twice.
- **Default:** the desk grid is four columns (sidebar, review, pinned Git panel, rail), and each is sized by a variable (`--tree-c`, `--git-c`, `--rail-c`), so drawer, pinned, and swapped are one class each on the desk. Swap reverses the column order.
- **Default:** the review toolbar sheds the diff summary, then the whitespace toggle, as the review column narrows. It uses a container query on the column rather than a media query on the window, because a wide sidebar or a pinned Git panel narrows it just as a small window does.
- **Accepted (2026-09-30):** settings live on their own Settings page (the gear in the title bar, or `⌘,`), with categories down the side: Appearance (a theme grid with swatches), Layout (Git panel, panel sides), Review (diff layout, wrap), Editor (change-bar base, inline blame, vim keys), and Commit (stage everything). The shortcuts card lists only shortcuts and links to Settings.
- **Default:** the chrome follows the Carbon mockup. Sidebar rails, review modes, and Git tabs are underline tabs. Group labels are small uppercase mono. A changed-file row is the status letter, the name, and a churn bar (the square root of its share of the biggest change, added and deleted), with the counts in its tooltip. Files in the diff are flat full-width sections with a sticky header, not cards. The branch is a bordered mono pill. The drawer floats as a card inset from the edges.
- **Default:** the change trace fades fully staged files only while some files are still unstaged; once everything is staged, the strip shows at full strength.
- **Corrected decision:** draggable panel resizing was deferred, then added. Each side panel is sized by a CSS custom property on the desk (`--tree-w`, `--git-w`) rather than a track size in the stylesheet, so a drag is one property write and the collapse classes stay the only place that decides whether a panel is shown. The grab strip is a 9px band on the panel's inner edge, where the border already invites a drag, so it collapses away with the panel and needs no separate state.
- **Default:** the sidebar runs 180–560px and the Git panel 220–640px, and a drag stops at whichever comes first: the range, the editor's 360px floor, or 42% of the desk, which is what keeps a narrow window from pushing the editor out. The floor wins over the range, because a panel at its minimum is still usable.
- **Accepted:** a focused grab strip resizes with the arrow keys (12px, 40px with `Shift`), because a layout you can only reach with a mouse is not a layout.
- **Default:** widths are saved in the global config's `panelSizes`, sent as one patch with both keys since the server replaces the map, and a width in the file that no longer fits the range is ignored rather than clamped, so an old or hand-edited config degrades to the default instead of to a surprise.
- **Default:** below 1100px the tracks are fixed by the breakpoint and the grab strips are hidden, since a handle that cannot move anything is worse than no handle.
- **Corrected decision (2026-09-30):** the title bar carries the logo mark (an "e" sending out a sound wave), the repository, the branch, the change trace in the centre, a compact `⌘K` Go to file button, panel toggles, the theme picker, and help. The status bar shows the live-connection dot, the status, the review position, and key hints as keycaps.
- **Accepted:** support multiple open-source themes, chosen one at a time. The default "System" follows macOS appearance: echo paper when light, echo ink when dark.
- **Accepted:** the theme set is hand-curated rather than generated: echo ink/paper, GitHub light/dark, Solarized light/dark, Catppuccin Latte/Mocha, Rosé Pine/Dawn, Nord, Gruvbox Dark, Tokyo Night, and Dracula (all MIT-licensed palettes).
- **Accepted (2026-09-30):** the curated set grows to 32 popular themes, 12 light and 20 dark, adding GitHub Dark Dimmed, One Dark/Light, Ayu Dark/Mirage/Light, Everforest Dark/Light, Kanagawa Wave/Lotus, Gruvbox Light, Tokyo Night Day, Catppuccin Frappé/Macchiato, Rosé Pine Moon, Night Owl/Light Owl, and Poimandres. Each is still one block of the same 16 tokens, and the picker's search matches the family name as well as the theme name.
- **Default:** echo ink is cool graphite with the Ember amber accent (`#f5a94e`), and echo paper is its light counterpart (`#b5660a` accent).
- **Default:** each theme is one block of about 16 tokens in `web/themes.css`; `style.css` only reads tokens and derives soft/strong tints with `color-mix`.
- **Default:** the chosen theme is saved in the global config and mirrored to `localStorage` so a small inline script can apply it before first paint.
- **Default:** no remote font service is required at runtime.
- **Default:** the app mark is one hand-written SVG (`web/favicon.svg`) using the echo ink accent, so tabs and bookmarks are recognizable; the page head carries a description, `color-scheme`, and that icon. `app.js` still owns the title, which is `repository — branch`.

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

- Find in file matches within a line only (no multi-line regex), stops at 5,000 matches, has no replace, and does not scroll sideways to a match off-screen to the right. Its marks are a transparent-text layer above the textarea, not part of the syntax layer.
- The file tree's context menu (new file, copy name/relative/absolute path) is client-only: the absolute path is the status `root` plus the path, and there is no new endpoint. New-file shortcut is `⌘⌥N` because browsers reserve `⌘N`.
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
- No language servers; highlighting is lexical.
- No per-repository configuration.
- No closed-tab restore.
- No custom keybinding editor.

## 19. Deferred roadmap

These are not rejected. They are waiting until the basic review loop is proven:

2. Hunk-level stage and unstage controls.
4. Word-level diff highlighting.
5. Native file picker and richer context menus.
6. Drag-to-reorder panel layout. (Panel sizing is done, see section 16.)
7. Full vim mode.
8. Conflict continue/abort controls.
9. Stash pop UI and stash diffs.
10. Large-file truncation and streaming improvements.
11. Native macOS filesystem events instead of polling.
12. Better handling of Git rename/delete metadata in the file tree.

## 19a. Changes multi-select, Publish Branch, stop hop (2026-09-30)

- Changes rows select like a file manager (click, ⌘/Ctrl-click, Shift-click), one group at a time; bulk actions are Stage and Unstage only. Bulk discard stays behind the existing Discard all dialog.
- A branch without an upstream offers Publish Branch instead of Pull. The pull request link comes from the host's own push output, with a built GitHub link as the only fallback; other hosts get no link rather than a guessed one.
- Stopping the current repository navigates to another open echo, else tries `window.close()`.

## 20. Implementation rules

- Keep the Go server small and explicit.
- Prefer the standard library over new dependencies.
- Keep `web/` framework-free and build-step-free.
- Use the system `git` CLI for all Git state changes.
- Keep destructive behavior fast and unconfirmed, as chosen, with these exceptions, which ask in an in-app dialog: Discard all in the Changes group, committing with everything staged first, discarding unsaved edits when closing a tab, and stopping echo processes.
- Never use the browser's `alert`, `confirm` or `prompt`; use `ask()` in `web/app.js`.
- Never weaken path validation or local-only binding.
- Update `changelog.md` when behavior changes.
- Update this file when a decision changes.
- Update `agents.md` when repository rules change.
- Run `gofmt -w main.go` and `go test ./...` before handoff.
