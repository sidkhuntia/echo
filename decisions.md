# echo decisions

## Product

- macOS only.
- Personal, single-repository, single-window tool.
- Terminal-launched; the browser is the UI.
- Reviewing diffs and editing files are the primary workflows.

## Architecture

- Go server plus vanilla JavaScript frontend.
- One self-contained binary with embedded `web/` assets.
- No Node, Electron, or framework runtime.
- System `git` CLI is the Git engine.
- System Git credentials, SSH keys, and Keychain are reused.
- Localhost-only binding by default.

## UI

- Vanilla JavaScript, no build step.
- Configurable panel visibility, size, and order are planned; v1 has panel toggles and a global config file.
- Fixed familiar editor shortcuts.
- Vim mode is opt-in; the first version only persists the preference.

## Deliberate deferrals

- LSP highlighting: add when a real editor surface exists; a plain textarea cannot show tokens.
- Hunk staging: add when file-level staging has been tested.
- Split/word diff rendering: add after the basic diff view is useful.
- Conflict resolution UI: show conflict markers and let the user edit them manually for now.
- Virtualized large-file rendering: truncate or defer until a real need appears.
