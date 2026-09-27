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
- **Default:** the tool focuses on the review loop instead of AI agents, pull-request hosting, or collaboration.

## 2. Platform and distribution

- **Accepted:** macOS only for v1.
- **Accepted:** performance and small resource usage matter more than minimizing development time.
- **Accepted:** the app is launched from Terminal.
- **Accepted:** the app is not a double-click `.app` bundle in v1.
- **Accepted:** the app opens its interface in the default browser.
- **Accepted:** one repository is opened per process/session.
- **Accepted:** the app starts in the current Terminal directory every time.
- **Default:** the default port is `7777`.
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
        -> installed language servers, later
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
- **Default:** the v1 UI renders a unified line-based diff.
- **Default:** the v1 UI supports the ignore-whitespace option using `--ignore-all-space`.
- **Default:** range diffs use Git ref syntax such as `from..to`.
- **Default:** the v1 UI includes working-tree, staged, and range scope selectors.
- **Deferred:** split diff rendering.
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
- **Default:** the v1 file tree is a filtered, path-sorted list with indentation implied by the path.
- **Default:** the v1 file index filters paths as the user types.
- **Default:** the initial implementation skips `.git`, hidden directories, `node_modules`, `dist`, `build`, `.cache`, and `.next` from the tree.
- **Default:** file create, rename, and delete use the local filesystem directly in the first version; Git-aware rename behavior can be tightened later.
- **Default:** file delete removes the selected file without a confirmation dialog.
- **Default:** file create and rename use browser prompts for the path input, not confirmation dialogs.
- **Deferred:** full hierarchical tree rendering and richer context menus.
- **Deferred:** content search across files.

## 7. Editor behavior

- **Accepted:** the editor should be a lightweight browser editor, not a full IDE.
- **Accepted:** the first editor choice was a basic textarea/CodeMirror-style editor.
- **Accepted:** the final v1 editor choice is a plain textarea.
- **Accepted:** a read-only syntax-highlighted view and a plain textarea editing mode are both needed.
- **Accepted:** saving writes the file to disk.
- **Accepted:** saving does not automatically stage the file.
- **Accepted:** staging remains an explicit Git action.
- **Accepted:** unsaved edits stay in memory per tab.
- **Accepted:** switching tabs preserves unsaved edits.
- **Accepted:** only explicit save writes to disk.
- **Accepted:** the interface should behave like a normal editor for basic navigation and file viewing.
- **Default:** the read-only file surface currently shows plain text until LSP highlighting is implemented.
- **Default:** file changes are held in browser memory and marked as dirty in the tab.
- **Deferred:** LSP syntax highlighting.
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
- **Default:** do not add a language-server dependency until the editor surface is ready to consume tokens.

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
- **Default:** SSE broadcasts Git status updates every two seconds.
- **Default:** the implementation keeps the refresh loop deliberately simple rather than using native filesystem event libraries.
- **Default:** the UI also performs an explicit refresh after app actions.
- **Default:** status updates include the working-tree status map, staged state, branch, recent commits, branches, and stashes.
- **Deferred:** native macOS filesystem event APIs.
- **Deferred:** fine-grained event deduplication and per-file invalidation.

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
- **Default:** the config contains vim mode, diff mode, panel list, and panel sizes.
- **Default:** panel visibility toggles are available in the v1 header.
- **Deferred:** draggable panel resizing.
- **Deferred:** drag-to-reorder panel layout.
- **Deferred:** per-project layout profiles.
- **Default:** recent repositories are not persisted because the app always starts in the current Terminal directory.

## 15. Keyboard and navigation

- **Accepted:** use fixed shortcuts rather than user-configurable keybindings.
- **Accepted:** support vim-style navigation.
- **Accepted:** vim mode is opt-in, not enabled by default.
- **Accepted:** use familiar editor shortcuts where they fit the smaller scope.
- **Default:** include shortcuts for file search, tree toggle, Git panel toggle, diff toggle, save, help, and escape.
- **Default:** use `⌘K`/`⌘P` for file search, `⌘B` for the file index, `⌘J` for the action ledger, `⌘D` for diff, and `⌘S` for save on macOS.
- **Default:** `?` opens the shortcut card.
- **Deferred:** full vim modal navigation and command language.
- **Deferred:** user-remappable shortcuts.

## 16. Visual design

- **Accepted:** the interface must not look like a clone of another tool.
- **Accepted:** echo should have its own visual identity.
- **Accepted:** the interface should feel focused, fast, personal, and review-oriented.
- **Default:** the visual direction is an amber-and-ink “local git desk.”
- **Default:** the three primary areas are named File Index, Review Surface, and Action Ledger.
- **Default:** the palette uses warm paper/ink tones, amber actions, mint Git-positive states, and coral change accents.
- **Default:** the display face is a local serif stack and the code face is a local monospace stack.
- **Default:** no remote font service is required at runtime.
- **Default:** subtle grid lines, grain, and paper-like contrast provide texture without a heavy design system.
- **Default:** the header carries the workspace identity, branch, and panel toggles.
- **Default:** the bottom console shows status and keyboard hints.

## 17. Safety and security

- **Accepted:** do not store secrets in the application config.
- **Accepted:** reuse system Git authentication.
- **Accepted:** destructive actions do not require confirmation dialogs.
- **Accepted:** the user accepts that delete, discard, and other destructive operations can happen immediately.
- **Default:** the server rejects absolute paths.
- **Default:** the server rejects paths that escape the repository root.
- **Default:** file reads and writes are constrained to the current workspace.
- **Default:** the server binds to localhost only.
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
- No AI agent integration.
- No collaboration or presence features.
- No theme marketplace.
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

1. LSP syntax highlighting using installed language servers.
2. Hunk-level stage and unstage controls.
3. Split diffs.
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
