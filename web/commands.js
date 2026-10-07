// The command palette: every action echo has, by name. Typing > in the palette (or ⌘⇧P) lists them.
import { ctx } from './ctx.js'
import * as R from './review.js'
import * as FO from './fileops.js'
import * as G from './gitui.js'
import * as Rp from './replace.js'
import * as Ed from './editor.js'
import { compareUI } from './compare.js'

const cfgToggle = key => () => { const v = !ctx.state.config[key]; ctx.state.config[key] = v; ctx.post('/api/config', { [key]: v }).then(() => ctx.setStatus(`${key}: ${v ? 'on' : 'off'}`, 'ok')); ctx.onConfig?.(key) }
const file = () => ctx.activeTab()
const git = a => () => ctx.gitAction(a)

export function commands() {
  const s = ctx.state, st = s.status || {}
  const list = [
    ['Go to file…', 'Navigate', () => ctx.openPalette(''), '⌘K'],
    ['Switch repository…', 'Navigate', () => document.querySelector('#repo').click(), '⌘⇧O'],
    ['Show Review', 'Navigate', () => ctx.setMode('diff')], ['Show Editor', 'Navigate', () => ctx.setMode('file')], ['Show Log', 'Navigate', () => ctx.setMode('log')],
    ['Toggle sidebar', 'View', () => document.querySelector('#tree-toggle').click(), '⌘B'],
    ['Toggle Git panel', 'View', () => ctx.toggleGit(), '⌘J'],
    ['Open Git tools (remotes, worktrees, reflog…)', 'View', () => ctx.toggleGit(true, 'tools')],
    ['Show review notes', 'View', () => { ctx.$('.desk').classList.remove('no-tree'); ctx.setRail('notes') }],
    ['Search file contents', 'View', () => { ctx.$('.desk').classList.remove('no-tree'); ctx.setRail('search') }, '⌘⇧F'],
    ['Settings', 'View', () => ctx.$('#settings-open').click(), '⌘,'], ['Keyboard shortcuts', 'View', () => ctx.$('#help-open').click(), '?'], ['Choose theme…', 'View', () => ctx.$('#theme-open').click()],
    ['Stacked diff layout', 'Review', () => document.querySelector('[data-layout="unified"]').click()], ['Split diff layout', 'Review', () => document.querySelector('[data-layout="split"]').click()],
    ['Collapse or expand all files', 'Review', () => ctx.$('#diff-collapse').click()],
    ['Add a note on the selected lines', 'Review', () => R.addEditorNote(), '⌘⌥M'],
    ['Add a note on this file', 'Review', () => R.addFileNote(ctx.currentPath())],
    ['Copy review prompt for the agent', 'Review', () => ctx.copyText(R.promptText()).then(() => ctx.setStatus('Copied the review prompt', 'ok'))],
    ['Reload', 'Git', ctx.refreshAll],
    ['Fetch all remotes', 'Git', git({ action: 'fetch' })], ['Pull', 'Git', git({ action: 'pull' })], ['Push', 'Git', git({ action: 'push' })],
    ['Compare branches…', 'Git', () => compareUI()],
    ['Restore the last discard', 'Git', git({ action: 'discard:restore' })],
    ['Undo the last commit', 'Git', () => ctx.undoLastCommit()],
    ['Write a commit message', 'Git', () => { ctx.setRail('changes'); ctx.$('.desk').classList.remove('no-tree'); setTimeout(() => ctx.$('#commit-message').focus(), 50) }],
    ['Stash all changes', 'Git', () => G.stashFiles([...s.changes.keys()])],
    ...(st.operation ? [[`Continue the ${st.operation}`, 'Git', git({ action: `${st.operation}:continue` })], [`Abort the ${st.operation}`, 'Git', git({ action: `${st.operation}:abort` })]] : []),
    ['Save file', 'Editor', () => ctx.saveFile(), '⌘S'],
    ['Next conflict (F7)', 'Conflicts', () => document.querySelector('#conflict-bar [data-cf="next"]')?.click()],
    ['Previous conflict (Shift-F7)', 'Conflicts', () => document.querySelector('#conflict-bar [data-cf="prev"]')?.click()],
    ['Accept current side of this conflict (⌘⌥1)', 'Conflicts', () => document.querySelector('#conflict-bar [data-cf="ours"]')?.click()],
    ['Accept incoming side of this conflict (⌘⌥2)', 'Conflicts', () => document.querySelector('#conflict-bar [data-cf="theirs"]')?.click()],
    ['Accept both sides of this conflict (⌘⌥3)', 'Conflicts', () => document.querySelector('#conflict-bar [data-cf="both"]')?.click()],
    ['Mark conflicted file resolved (stage)', 'Conflicts', () => document.querySelector('#conflict-bar [data-cf="stage"], #conflict-bar [data-cf="keep"]')?.click()],
    ['Find in file', 'Editor', () => ctx.showFind(null), '⌘F'], ['Replace in file', 'Editor', () => { ctx.showFind(null); Rp.toggleReplace(true) }, '⌘⌥F'],
    ['Format JSON', 'Editor', () => Ed.formatJSON()], ['Minify JSON', 'Editor', () => Ed.formatJSON(true)],
    ['Convert line endings…', 'Editor', () => Ed.convertEol()],
    ['Toggle word wrap', 'Editor', () => { const b = ctx.$('#word-wrap'); b.checked = !b.checked; b.dispatchEvent(new Event('change')) }],
    ['Toggle minimap', 'Editor', cfgToggle('minimap')], ['Toggle whitespace', 'Editor', cfgToggle('whitespace')], ['Toggle indent guides', 'Editor', cfgToggle('indentGuides')],
    ['Toggle sticky scroll', 'Editor', cfgToggle('sticky')], ['Toggle Vim mode', 'Editor', cfgToggle('vim')],
    ['Toggle blame column', 'Editor', () => ctx.$('#blame-toggle').click()],
    ['Reopen closed tab', 'Editor', () => ctx.reopenClosedTab(), '⌘⌥T'],
    ...(file() ? [
      ['Open file to the side', 'File', () => FO.openSide(file().path)],
      ['Open file in editor…', 'File', () => FO.openExternal(file().path)], ['Open file in default app', 'File', () => FO.openDefault(file().path)],
      ['Reveal file in file manager', 'File', () => FO.reveal(file().path)],
      ['Rename or move file…', 'File', () => FO.rename(file().path)], ['Duplicate file…', 'File', () => FO.duplicate(file().path)], ['Delete file…', 'File', () => FO.remove(file().path, false)],
      ['Add file to .gitignore', 'File', () => G.ignorePaths([file().path])],
      ['Show history of this file', 'File', () => ctx.openFileHistory(file().path)],
    ] : []),
    ['Close side view', 'File', () => FO.closeSide()],
    ['Quit all echo processes', 'echo', () => document.querySelector('[data-repo-quit]').click()],
  ]
  return list.map(([title, group, run, kbd]) => ({ title, group, run, kbd }))
}
