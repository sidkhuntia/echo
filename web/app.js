import { renderMarkdown, sanitize } from './markdown.js'
import { highlight, highlightLines } from './highlight.js'
import { parseDiff } from './diffparse.js'
import { splitLines, lineDiff } from './linediff.js'
import { ctx } from './ctx.js'
import * as R from './review.js'
import * as Ops from './ops.js'
import * as G from './gitui.js'
import { popMenu } from './ui.js'
import { rebaseUI } from './rebase.js'
import { compareUI } from './compare.js'
import * as T from './tools.js'
import * as Ed from './editor.js'
import * as Rp from './replace.js'
import * as Pv from './preview.js'
import * as FO from './fileops.js'
import { commands } from './commands.js'
import { wordRanges, pairRuns, injectMarks } from './wordiff.js'
import { layoutGraph, graphWidth, graphSVG, railSVG, LOG_H, HIST_H } from './graph.js'
import { BASE, WS_ID, withBase, storeKey } from './base.js'
import * as TD from './tabdrag.js'

const $ = s => document.querySelector(s)
const state = {
  fileView: false, fileIdx: 0, filePath: '',
  tree: [], treeExtra: [], ignKids: new Map(), ignoredFiles: new Set(), treeStale: true, tabs: [], active: -1, selected: '',
  status: null, changes: new Map(), folded: new Map(),
  config: { vim: false, theme: 'system', diffMode: 'unified' }, mode: 'diff', rail: 'changes', dirOpen: new Map(),
  diffFiles: [], diffSeq: 0, current: -1, hunk: -1, commit: '', returnTo: '', statusSeq: 0,
  // diffStale: the diff missed an update while Files mode was showing; it reloads on the way back to Review.
  diffStale: false, diffReady: Promise.resolve(), diffScroll: 0,
  palette: { items: [], sel: 0 },
  // History: the expanded commit, cached details (commits never change), and folders closed per commit.
  expanded: '', details: new Map(), contains: new Map(), cdirClosed: new Set(),
  // hist: the History tab (current branch). log: the Log view. refsKey: HEAD plus a ref signature;
  // both reload only when it changes. fromLog: Review was opened from the Log, so Esc goes back.
  hist: { commits: [], rows: [], seq: 0, error: '', retry: 0 }, log: { commits: [], rows: [], more: false, loading: false, loaded: false, seq: 0, sel: '' },
  refsKey: '', fromLog: false,
  // Branches rail: folders closed by the user, and the rail to restore when leaving the Log.
  bClosed: new Set(), railBeforeLog: '',
  // blameGutter: the per-line blame column (session only). rangeDots: '..' tip to tip, '...' from the merge base.
  blameGutter: false, rangeDots: '..',
  // wrap: soft wrap in the editor and the stacked diff (session only, like the blame column).
  wrap: false,
  // Changes rail groups (merge, staged, work) folded by the user.
  qClosed: new Set(),
  // qsel: rows picked in the Changes rail, as "sec\tpath" keys (one group at a time); qanchor is where Shift-click ranges start.
  qsel: new Set(), qanchor: '',
  // widths: the side panels' dragged widths, written to the desk grid as --tree-w and --git-w.
  widths: { tree: 272, git: 300 },
  // search: the Search rail. ran is the query and options the shown results came from; ctl aborts the one in flight.
  closed: [], recent: (() => { try { return JSON.parse(localStorage.getItem(storeKey('echo:recent'))) || [] } catch { return [] } })(),
  search: { opts: { case: false, word: false, regex: false }, ran: null, res: null, err: '', ctl: null, timer: 0, closed: new Set() },
}
const mod = e => e.metaKey || e.ctrlKey
const typing = e => e.target.closest?.('input, textarea, select')
// Scopes that follow the working tree and index, so they reload on every status change.
const LIVE = ['head', 'worktree', 'staged']
// Scopes whose new side is the working tree, so diff line numbers match the file in the editor.
const EDITABLE = ['head', 'worktree']
const GENERATED = /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|go\.sum|Cargo\.lock|poetry\.lock|Gemfile\.lock|composer\.lock|bun\.lockb?)$/

const api = async (url, opts) => {
  const res = await fetch(withBase(url), opts)
  const text = await res.text()
  let data
  try { data = JSON.parse(text) } catch { data = text }
  if (!res.ok) throw Object.assign(new Error(String(text || res.statusText).trim()), { status: res.status })
  return data
}
const post = (url, body) => api(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
const basename = p => p.slice(p.lastIndexOf('/') + 1)
const dirname = p => p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : ''
const nameFirst = p => `<b>${esc(basename(p))}</b>${dirname(p) ? ` <i>${esc(dirname(p))}</i>` : ''}`
const fullPath = p => `${dirname(p) ? `<i>${esc(dirname(p))}/</i>` : ''}${esc(basename(p))}`
const scope = () => $('#diff-scope').value
const activeTab = () => state.tabs[state.active]

// A message stays for a few seconds and then goes, so the corner is quiet when nothing is happening.
// A sticky one (the lost connection) stays until clearStatus() says it is over.
let statusTimer = 0, statusSticky = false
function setStatus(msg, kind = '', sticky = false) {
  const text = String(msg ?? '').trim()
  const s = $('#status')
  clearTimeout(statusTimer)
  statusSticky = sticky
  s.textContent = text.split('\n').find(l => l.trim()) || 'done'
  s.title = text
  s.className = kind
  if (!sticky && text) statusTimer = setTimeout(() => { s.textContent = ''; s.title = ''; s.className = '' }, kind === 'err' ? 8000 : 4000)
}
function clearStatus() {
  if (!statusSticky) return
  statusSticky = false
  const s = $('#status')
  s.textContent = ''; s.title = ''; s.className = ''
}

const ICON_UNDO = '<svg class="i" viewBox="0 0 16 16"><path d="M5.5 3.5 3 6l2.5 2.5"/><path d="M3 6h6.5a3.5 3.5 0 0 1 0 7H7"/></svg>'

// ---------- dialog ----------
// ask() replaces the browser's confirm and prompt: it resolves true (or the typed text, with `input`)
// when confirmed and null when cancelled by the button, Escape, or a click outside. `html` is trusted
// markup, so callers escape whatever they put in it. Destructive or sweeping dialogs focus Cancel.
let dlg = null
function ask({ title, kicker = '', html = '', tone = '', ok = 'OK', input = null }) {
  dlg?.done(null)
  const el = $('#dialog'), field = $('#dialog-input'), prev = document.activeElement
  el.classList.remove('out')
  el.dataset.tone = tone
  $('#dialog-kicker').textContent = kicker
  $('#dialog-title').textContent = title
  $('#dialog-msg').innerHTML = html
  $('#dialog-ok').textContent = ok
  $('#dialog-field').hidden = !input
  if (input) { $('#dialog-label').textContent = input.label; field.value = input.value || ''; field.placeholder = input.placeholder || '' }
  el.hidden = false
  return new Promise(resolve => {
    const done = v => {
      if (dlg?.done !== done) return
      dlg = null
      // the exit is quicker than the entrance; the answer does not wait for it
      el.classList.add('out')
      setTimeout(() => { if (!dlg) el.hidden = true; el.classList.remove('out') }, 100)
      resolve(v)
      if (prev?.isConnected) prev.focus?.()
    }
    dlg = { done, input: !!input }
    if (input) { field.focus(); input.end ? field.setSelectionRange(field.value.length, field.value.length) : field.select() }
    else (tone ? $('#dialog-cancel') : $('#dialog-ok')).focus()
  })
}
$('#dialog form').addEventListener('submit', e => {
  e.preventDefault()
  if (!dlg) return
  if (!dlg.input) return dlg.done(true)
  const v = $('#dialog-input').value.trim()
  if (v) dlg.done(v)
})
$('#dialog-cancel').onclick = () => dlg?.done(null)
$('#dialog').addEventListener('mousedown', e => { if (e.target === $('#dialog')) dlg?.done(null) })

// ---------- change codes ----------
function codeLetter(c) {
  if (c.code === '??') return 'A'
  const y = c.code[1] !== ' ' ? c.code[1] : c.code[0]
  return y === 'U' ? 'U' : y
}
const codeWord = { M: 'modified', A: 'new', D: 'deleted', R: 'renamed', C: 'copied', U: 'conflict', T: 'type' }
const badge = (letter, word = codeWord[letter]) => `<span class="st ${letter}" title="${word || letter}">${letter}</span>`
const codeTag = c => badge(codeLetter(c), codeWord[codeLetter(c)] || c.code.trim())
const statHTML = c => c.binary ? '<span class="faint">bin</span>' : `${c.added ? `<span class="add">+${c.added}</span>` : ''}${c.deleted ? `<span class="del">−${c.deleted}</span>` : ''}`
// Conflicted files sit in their own group until `git add` marks them resolved.
const conflicted = c => /U/.test(c.code) || c.code === 'AA' || c.code === 'DD'

// ---------- status ----------
function applyStatus(s) {
  // The server restarted with different web assets; this page's code no longer matches its API.
  if (state.status?.build && s.build && s.build !== state.status.build) return staleBuild()
  const first = !state.status
  state.status = s
  state.statusSeq++
  state.changes = new Map((s.changes || []).map(c => [c.path, c]))
  if (first && !s.git) setRail('files')
  state.treeStale = true
  document.body.classList.toggle('no-git-repo', !s.git)
  $('#commit-dock').hidden = state.rail !== 'changes' || !s.git
  renderGit(); renderQueue()
  if (state.rail === 'files') ensureTree().then(renderTree)
  // Files changed on disk, so shown line numbers may be stale.
  if (state.search.res) scheduleSearch()
  syncTabs()
  refreshGutter()
  Ops.renderOpBar()
  FO.refreshSide()
  if (state.mode === 'file') Ops.renderConflictBar()
  if (LIVE.includes(scope())) state.mode === 'diff' ? scheduleDiff() : (state.diffStale = true)
}

function staleBuild() {
  persistSession()
  if (!sessionSaved && state.tabs.some(t => t.content !== t.saved)) {
    setStatus('echo was updated. Save your edits, then reload the page.', 'err')
    return
  }
  location.reload()
}

async function refreshAll() {
  try {
    state.treeStale = true
    applyStatus(await api('/api/git/status'))
    await ensureTree()
    renderTree()
    await loadDiff()
  } catch (e) { setStatus(e.message, 'err') }
}

async function ensureTree() {
  if (!state.treeStale) return
  state.treeStale = false
  try {
    // Plain files drive search and the rest of the page; empty and ignored folders and ignored files only shape the Files tree.
    const nodes = await api('/api/tree')
    state.tree = nodes.filter(n => !n.dir && !n.ignored)
    state.treeExtra = nodes.filter(n => n.dir || n.ignored)
    // Opened ignored folders are listed again, so a build that rewrites them shows.
    state.ignoredFiles.clear()
    for (const dir of [...state.ignKids.keys()]) {
      try { state.ignKids.set(dir, await api('/api/tree?dir=' + encodeURIComponent(dir))) } catch { state.ignKids.delete(dir) }
    }
  } catch (e) { setStatus(e.message, 'err') }
}

// ---------- file index ----------
function setRail(rail) {
  state.rail = rail
  document.querySelectorAll('.rail-switch button').forEach(b => b.classList.toggle('on', b.dataset.rail === rail))
  $('#tree-panel').classList.toggle('rail-files', rail === 'files')
  $('#queue').hidden = rail !== 'changes'
  $('#files-pane').hidden = rail !== 'files'
  $('#branches').hidden = rail !== 'branches'
  $('#search-pane').hidden = rail !== 'search'
  $('#notes').hidden = rail !== 'notes'
  $('#log-side').hidden = rail !== 'logside'
  $('[data-rail="logside"]').hidden = rail !== 'logside'
  $('#commit-dock').hidden = rail !== 'changes' || state.status?.git === false
  $('[data-rail="search"]').hidden = rail !== 'search'
  $('.filter-row').hidden = rail === 'search' || rail === 'notes' || rail === 'logside'
  $('#file-filter').placeholder = rail === 'branches' ? 'Filter branches' : 'Filter paths'
  if (rail === 'files') ensureTree().then(renderTree)
  else if (rail === 'branches') renderBranches()
  else if (rail === 'search') $('#search-input').focus()
  else if (rail === 'notes') R.renderNotesPane()
  else if (rail === 'logside') renderLogSide()
  else renderQueue()
}

// ---------- content search ----------
// The server runs git grep; the browser only debounces, cancels the superseded request, and groups by file.
function scheduleSearch(delay = 250) {
  clearTimeout(state.search.timer)
  state.search.timer = setTimeout(runSearch, delay)
}

async function runSearch() {
  const s = state.search, q = $('#search-input').value
  s.ctl?.abort()
  if (q.length < 2) { s.ran = s.res = null; s.err = ''; return renderSearch() }
  const ran = { q, ...s.opts }, ctl = s.ctl = new AbortController()
  const params = new URLSearchParams({ q })
  for (const [k, on] of Object.entries(s.opts)) if (on) params.set(k, '1')
  try {
    s.res = await api('/api/search?' + params, { signal: ctl.signal })
    s.err = ''
  } catch (e) {
    if (ctl.signal.aborted) return
    s.res = null
    s.err = e.message
  }
  if (s.ran?.q !== ran.q) s.closed.clear()
  s.ran = ran
  renderSearch()
}

// searchRegex rebuilds the query in JavaScript to mark matches; git grep reports only where a line matched.
function searchRegex({ q, case: exact, word, regex }) {
  let src = regex ? q : q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  if (word) src = `\\b(?:${src})\\b`
  try { return new RegExp(src, exact ? 'g' : 'gi') } catch { return null }
}

function markMatches(text, re) {
  if (!re) return esc(text)
  let h = '', at = 0
  for (const m of text.matchAll(re)) {
    if (!m[0]) break
    h += esc(text.slice(at, m.index)) + `<mark>${esc(m[0])}</mark>`
    at = m.index + m[0].length
  }
  return h + esc(text.slice(at))
}

function renderSearch() {
  const s = state.search, box = $('#search-results'), meta = $('#search-meta')
  if (s.err) { meta.textContent = ''; box.innerHTML = `<div class="empty"><b>Search failed</b>${esc(s.err)}</div>`; return }
  $('#replace-files').disabled = !s.res?.matches.length
  if (!s.res) { meta.textContent = ''; box.innerHTML = ''; return }
  const files = new Map()
  for (const m of s.res.matches) files.has(m.path) ? files.get(m.path).push(m) : files.set(m.path, [m])
  const n = s.res.matches.length
  if (!n) { meta.textContent = ''; box.innerHTML = `<div class="empty">No results for “${esc(s.ran.q)}”.</div>`; return }
  meta.textContent = s.res.truncated
    ? `${n.toLocaleString()}+ results in ${files.size} files — refine your search`
    : `${n.toLocaleString()} result${n === 1 ? '' : 's'} in ${files.size} file${files.size === 1 ? '' : 's'}`
  const re = searchRegex(s.ran)
  let h = ''
  for (const [path, ms] of files) {
    const closed = s.closed.has(path)
    h += `<div class="group-label qgroup sgroup" data-path="${esc(path)}" title="${esc(path)}"><span class="tw">${closed ? '▸' : '▾'}</span><span class="gname">${nameFirst(path)}</span><span class="count">${ms.length}</span></div>`
    if (!closed) h += ms.map(m => `<div class="srow" data-path="${esc(path)}" data-line="${m.line}" title="${esc(path)}:${m.line}"><span class="sline">${m.line}</span><span class="stext">${markMatches(m.text.trimStart(), re)}</span></div>`).join('')
  }
  box.innerHTML = h
}

// The Changes rail follows VS Code: conflicts, then what is staged (HEAD → index), then what is not
// (index → working tree). A partly staged file shows in both groups with each side's own counts.
const ICON = {
  plus: '<svg class="i" viewBox="0 0 16 16"><path d="M8 3.5v9M3.5 8h9"/></svg>',
  minus: '<svg class="i" viewBox="0 0 16 16"><path d="M3.5 8h9"/></svg>',
  discard: ICON_UNDO,
  open: '<svg class="i" viewBox="0 0 16 16"><path d="M4 2h5l3 3v9H4z"/><path d="M9 2v3h3"/></svg>',
  fold: '<svg class="i" viewBox="0 0 16 16"><path d="M4 6 8 2.5 12 6M4 9.5 8 13l4-3.5"/></svg>',
  unfold: '<svg class="i" viewBox="0 0 16 16"><path d="M4 2.5 8 6l4-3.5M4 6.5 8 10l4-3.5"/></svg>',
}
const GROUPS = [
  { sec: 'merge', label: 'Merge changes', has: c => conflicted(c) },
  { sec: 'staged', label: 'Staged changes', has: c => !conflicted(c) && !!c.index },
  { sec: 'work', label: 'Changes', has: c => !conflicted(c) && !!c.work },
]
// Each group's letter describes its own side: code[0] for the index, code[1] for the working tree.
function sideTag(c, sec) {
  const y = sec === 'staged' ? c.code[0] : sec === 'work' ? (c.code === '??' ? 'A' : c.code[1]) : 'U'
  return badge(y, c.code === '??' ? 'untracked' : codeWord[y] || y)
}
const sideStat = st => !st ? '' : st.binary ? '<span class="faint">bin</span>' : `${st.added ? `<span class="add">+${st.added}</span>` : ''}${st.deleted ? `<span class="del">−${st.deleted}</span>` : ''}`
// A group header totals the same per-side counts its rows carry, so a partly staged file counts once in
// each group it appears in. A binary file has no line counts to add, so it is called out instead.
function groupStat(rows, sec) {
  const key = sec === 'staged' ? 'index' : sec === 'work' ? 'work' : null
  if (!key) return ''
  let added = 0, deleted = 0, bin = false
  for (const c of rows) {
    const st = c[key]
    if (!st) continue
    if (st.binary) { bin = true; continue }
    added += st.added; deleted += st.deleted
  }
  const nums = `${added ? `<span class="add">+${added}</span>` : ''}${deleted ? `<span class="del">−${deleted}</span>` : ''}`
  return `${nums}${bin ? (nums ? ' ' : '') + '<span class="faint">bin</span>' : ''}`
}
// A row's share of the biggest change in the list, split into added and deleted. The square root
// keeps a one-line fix visible beside a 500-line file.
function churnBar(st, most) {
  if (!st) return ''
  if (st.binary) return '<span class="faint">bin</span>'
  const n = st.added + st.deleted
  if (!n) return ''
  const w = Math.max(8, Math.sqrt(n / most) * 100)
  return `<span class="churn"><span style="width:${w.toFixed(1)}%"><i class="p" style="flex:${st.added}"></i><i class="m" style="flex:${st.deleted}"></i></span></span>`
}
const iconBtn = (act, icon, title) => `<button class="btn quiet icon xs" data-act="${act}" title="${title}">${icon}</button>`
// The group a row belongs to decides which scope shows its diff: staged rows the index, the rest the working tree.
const secScope = sec => sec === 'staged' ? 'staged' : 'worktree'

function renderQueue() {
  const q = $('#queue')
  const all = [...state.changes.values()]
  $('#change-count').textContent = all.length || ''
  if (state.status && !state.status.git) {
    q.innerHTML = `<div class="empty"><b>Not a Git repository</b>Browsing and editing still work; Git actions are off.</div>`
    return
  }
  if (!all.length) {
    q.innerHTML = discardBar() + `<div class="empty"><b>No changes</b>The working tree matches HEAD.</div>`
    return
  }
  const filter = $('#file-filter').value.toLowerCase()
  const list = all.filter(c => !filter || c.path.toLowerCase().includes(filter))
  const shown = new Set(GROUPS.flatMap(g => list.filter(g.has).map(c => qkey(g.sec, c.path))))
  for (const k of state.qsel) if (!shown.has(k)) state.qsel.delete(k)
  const size = st => st && !st.binary ? st.added + st.deleted : 0
  const most = Math.max(1, ...list.flatMap(c => [size(c.index), size(c.work)]))
  const row = (c, sec) => {
    const acts = [
      c.code[1] !== 'D' && c.code !== 'D ' ? iconBtn('open', ICON.open, 'Open file') : '',
      sec === 'work' ? iconBtn('discard', ICON.discard, c.code === '??' ? 'Delete this untracked file' : 'Discard unstaged changes') : '',
      sec === 'merge' ? `<button class="btn quiet xs" data-act="ours" title="Take our side of the whole file (the branch you are on; during a rebase, the branch being rebased onto)">Ours</button><button class="btn quiet xs" data-act="theirs" title="Take their side of the whole file">Theirs</button>` : '',
      sec === 'staged' ? iconBtn('unstage', ICON.minus, 'Unstage') : iconBtn('stage', ICON.plus, sec === 'merge' ? 'Mark resolved (stage)' : 'Stage'),
    ].join('')
    const st = sec === 'staged' ? c.index : sec === 'work' ? c.work : null
    return `<div class="qrow${state.qsel.has(qkey(sec, c.path)) ? ' picked' : ''}" data-path="${esc(c.path)}" data-sec="${sec}" title="${esc(c.path)}${st && !st.binary ? `  +${st.added} −${st.deleted}` : ''}">
      ${sideTag(c, sec)}<span class="qpath">${nameFirst(c.path)}</span>
      <span class="qacts">${acts}</span>
      <span class="qmeta">${churnBar(st, most)}</span>
    </div>`
  }
  const bulk = { staged: iconBtn('unstage-all', ICON.minus, 'Unstage all'), work: iconBtn('discard-all', ICON.discard, 'Discard all unstaged changes') + iconBtn('stage-all', ICON.plus, 'Stage all changes'), merge: iconBtn('stage-all', ICON.plus, 'Mark all resolved (stage)') }
  let h = discardBar() + pickBar()
  for (const g of GROUPS) {
    const rows = list.filter(g.has)
    if (!rows.length) continue
    const closed = state.qClosed.has(g.sec)
    h += `<div class="group-label qgroup" data-sec="${g.sec}"><span class="tw">${closed ? '▸' : '▾'}</span><span class="gname">${g.label}</span><span class="gacts">${bulk[g.sec]}</span><span class="gstat">${groupStat(rows, g.sec)}</span><span class="count">${rows.length}</span></div>`
    if (!closed) h += rows.map(c => row(c, g.sec)).join('')
  }
  q.innerHTML = h || `<div class="empty">No changed path matches “${esc(filter)}”.</div>`
  markQueueCurrent()
}

// Multi-select in the Changes rail: click picks one, Cmd/Ctrl-click toggles, Shift-click extends from the
// anchor. A pick lives in one group, since Stage and Unstage only make sense for one side at a time.
const qkey = (sec, path) => sec + '\t' + path
const pickedIn = sec => [...state.qsel].filter(k => k.startsWith(sec + '\t')).map(k => k.slice(sec.length + 1))
const pickedSec = () => state.qsel.size ? [...state.qsel][0].split('\t')[0] : ''

function discardBar() {
  const d = state.status?.lastDiscard
  if (!d) return ''
  return `<div class="pickbar restore"><span>Discarded ${plural(d.files, 'file')} ${ago(d.time)}</span><span class="grow"></span><button class="btn sm" data-restore-discard title="Put the files of the last discard back">Restore</button></div>`
}

function pickBar() {
  const sec = pickedSec()
  if (state.qsel.size < 2 || sec === 'merge') return ''
  const staged = sec === 'staged'
  return `<div class="pickbar"><b>${state.qsel.size} selected</b><span class="grow"></span>`
    + `<button class="btn sm" data-pick="${staged ? 'unstage' : 'stage'}">${staged ? ICON.minus + 'Unstage' : ICON.plus + 'Stage'}</button>`
    + `<button class="btn quiet sm" data-pick="stash" title="Stash just these files">Stash</button>`
    + `<button class="btn quiet sm" data-pick="clear" title="Clear the selection (Esc)">✕</button></div>`
}

// Returns true when the click only changed the selection, so the caller skips opening the diff.
function pick(e, sec, path) {
  const k = qkey(sec, path), rows = [...document.querySelectorAll(`.qrow[data-sec="${sec}"]`)].map(r => r.dataset.path)
  if (e.shiftKey && state.qanchor && state.qanchor.startsWith(sec + '\t') && rows.includes(state.qanchor.slice(sec.length + 1))) {
    const a = rows.indexOf(state.qanchor.slice(sec.length + 1)), b = rows.indexOf(path)
    state.qsel = new Set(rows.slice(Math.min(a, b), Math.max(a, b) + 1).map(p => qkey(sec, p)))
  } else if (mod(e)) {
    if (pickedSec() !== sec) state.qsel.clear()
    state.qsel.has(k) ? state.qsel.delete(k) : state.qsel.add(k)
    state.qanchor = k
  } else { state.qsel = new Set([k]); state.qanchor = k; return false }
  renderQueue()
  return true
}

// Bulk actions take the paths of one group as it is shown, so a filter narrows them too.
function groupRows(sec) {
  const g = GROUPS.find(g => g.sec === sec)
  const filter = $('#file-filter').value.toLowerCase()
  return [...state.changes.values()].filter(c => g.has(c) && (!filter || c.path.toLowerCase().includes(filter)))
}
const groupPaths = sec => groupRows(sec).map(c => c.path)

// A list of changed files for a dialog: the first few, then how many more.
function fileListHTML(rows, sec, max = 6, verb = false) {
  const outcome = c => verb && c.code === '??' ? '<span class="o hit">delete file</span>' : `<span class="o">${sideStat(c[sec === 'staged' ? 'index' : 'work'])}</span>`
  const items = rows.slice(0, max).map(c => `<li title="${esc(c.path)}">${sideTag(c, sec)}<span class="p">${esc(c.path)}</span>${outcome(c)}</li>`)
  if (rows.length > max) items.push(`<li class="more">…and ${rows.length - max} more</li>`)
  return `<ul class="dialog-files">${items.join('')}</ul>`
}
const plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`

// Throws away every unstaged edit in the Changes group, and deletes its untracked files. Staged work stays.
async function discardAll() {
  const rows = groupRows('work')
  if (!rows.length) return
  const fresh = rows.filter(c => c.code === '??').length
  const ok = await ask({
    title: `Discard ${plural(rows.length, 'unstaged change')}`, kicker: 'no undo', tone: 'danger', ok: 'Discard all',
    html: `${fileListHTML(rows, 'work', 6, true)}<div class="slip-total"><span>${rows.length - fresh} edited · ${fresh} untracked</span><span>staged work is kept</span></div>`,
  })
  if (ok) gitAction({ action: 'discard', paths: rows.map(c => c.path), worktree: true })
}

// Build a folder tree from the flat, sorted path list. Folders open by default when they hold a change or the open file.
function buildTree(paths, extra = []) {
  const root = { dirs: new Map(), files: [], changed: 0 }
  const ensure = (parts, upto) => {
    let node = root
    const lineage = [root]
    for (let i = 0; i < upto; i++) {
      if (!node.dirs.has(parts[i])) node.dirs.set(parts[i], { path: parts.slice(0, i + 1).join('/'), dirs: new Map(), files: [], changed: 0 })
      node = node.dirs.get(parts[i])
      lineage.push(node)
    }
    return lineage
  }
  for (const p of paths) {
    const parts = p.split('/')
    const lineage = ensure(parts, parts.length - 1)
    lineage[lineage.length - 1].files.push(p)
    if (state.changes.has(p)) lineage.forEach(n => n.changed++)
  }
  // Empty and ignored folders, ignored files, and what an opened ignored folder listed.
  for (const n of extra) {
    const parts = n.path.split('/')
    if (n.dir) {
      const lineage = ensure(parts, parts.length)
      if (n.ignored) lineage[lineage.length - 1].ignored = true
    } else {
      const lineage = ensure(parts, parts.length - 1)
      lineage[lineage.length - 1].files.push(n.path)
      if (n.ignored) state.ignoredFiles.add(n.path)
    }
  }
  return root
}

// Numeric-aware, so V2 sorts before V10; punctuation (dotfiles) first.
const natural = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' }).compare
// What the Files tree adds to the file list: not while filtering, and an ignored folder's loaded listing.
const treeExtra = () => $('#file-filter').value ? [] : [...state.treeExtra, ...[...state.ignKids.values()].flat()]

// The paths the tree shows: the filter applied; the window below decides how many are drawn.
const treePaths = () => {
  const filter = $('#file-filter').value.toLowerCase()
  return state.tree.map(f => f.path).filter(p => !filter || p.toLowerCase().includes(filter))
}
// A folder opens by default when it holds a change or the open file; a choice the user made wins.
const dirIsOpen = (d, filter, open) => filter ? true : state.dirOpen.has(d.path) ? state.dirOpen.get(d.path) : d.changed > 0 || (open || '').startsWith(d.path + '/')
const allDirs = (node, out = []) => {
  for (const [, d] of node.dirs) if (!d.ignored) { out.push(d); allDirs(d, out) }
  return out
}

// The tree draws only the rows in view (plus a margin) between two spacers, so a repository with
// a hundred thousand files costs the same to scroll as one with a hundred. Rows are a fixed 26px.
const TREE_ROW = 26, TREE_WINDOW_MIN = 400
let treeRows = []

function renderTree() {
  if (state.rail !== 'files') return
  const filter = $('#file-filter').value.toLowerCase()
  const open = activeTab()?.path
  const root = buildTree(treePaths(), treeExtra())
  const isOpen = d => dirIsOpen(d, filter, open)
  const pad = depth => `style="padding-left:${6 + depth * 14}px"`
  const name = n => {
    if (!filter) return esc(n)
    const at = n.toLowerCase().indexOf(filter)
    return at < 0 ? esc(n) : `${esc(n.slice(0, at))}<mark>${esc(n.slice(at, at + filter.length))}</mark>${esc(n.slice(at + filter.length))}`
  }
  const rows = []
  const render = (node, depth) => {
    for (const [n, d] of [...node.dirs].sort((a, b) => natural(a[0], b[0]))) {
      const o = isOpen(d)
      rows.push(`<div class="tnode dir${d.ignored ? ' ignored' : ''}" draggable="true" data-dir="${esc(d.path)}" ${pad(depth)} title="${esc(d.path)}"><span class="tw">${o ? '▾' : '▸'}</span><svg class="i ic" viewBox="0 0 16 16"><path d="M2 4.5h4l1.5 1.5H14v6.5H2z"/></svg><span class="nm">${esc(n)}</span>${d.changed ? `<span class="count">${d.changed}</span>` : ''}</div>`)
      if (o) render(d, depth + 1)
    }
    for (const p of [...node.files].sort((a, b) => natural(basename(a), basename(b)))) {
      const c = state.changes.get(p)
      rows.push(`<div class="tnode ${state.ignoredFiles.has(p) ? 'ignored ' : ''}${state.selected === p || open === p ? 'active' : ''}" draggable="true" data-path="${esc(p)}" ${pad(depth)} title="${esc(p)}"><span class="tw"></span><svg class="i ic" viewBox="0 0 16 16"><path d="M4 2h5l3 3v9H4z"/><path d="M9 2v3h3"/></svg><span class="nm">${name(basename(p))}</span>${c ? codeTag(c) : ''}</div>`)
    }
  }
  render(root, 0)
  treeRows = rows
  paintTreeWindow(true)
  syncTreeCollapse(root)
}

function paintTreeWindow(force = false) {
  const box = $('#tree'), total = treeRows.length
  if (!total) { box.innerHTML = '<div class="empty">No path matches.</div>'; return }
  if (total < TREE_WINDOW_MIN) { if (force) box.innerHTML = treeRows.join(''); return }
  const first = Math.max(0, Math.floor(box.scrollTop / TREE_ROW) - 20)
  const last = Math.min(total, Math.ceil((box.scrollTop + (box.clientHeight || 600)) / TREE_ROW) + 20)
  if (!force && box.dataset.first === String(first) && box.dataset.last === String(last)) return
  box.dataset.first = first; box.dataset.last = last
  box.innerHTML = `<div style="height:${first * TREE_ROW}px"></div>${treeRows.slice(first, last).join('')}<div style="height:${(total - last) * TREE_ROW}px"></div>`
}
let treeFrame
$('#tree').addEventListener('scroll', () => { cancelAnimationFrame(treeFrame); treeFrame = requestAnimationFrame(() => paintTreeWindow()) })

async function toggleDir(path) {
  const row = $(`#tree .tnode.dir[data-dir="${CSS.escape(path)}"]`)
  const open = row?.querySelector('.tw').textContent !== '▾'
  state.dirOpen.set(path, open)
  // An ignored folder is listed only when opened, so a huge node_modules costs nothing until asked for.
  if (open && row.classList.contains('ignored') && !state.ignKids.has(path)) {
    try { state.ignKids.set(path, await api('/api/tree?dir=' + encodeURIComponent(path))) } catch (e) { setStatus(e.message, 'err') }
  }
  renderTree()
}

// One button folds every folder in the tree and unfolds them again. A filter already shows the tree
// flattened, so there is nothing to fold while one is typed and the button steps out of the way.
function syncTreeCollapse(root = buildTree(treePaths(), treeExtra())) {
  if (state.rail !== 'files') return
  const b = $('#tree-collapse')
  b.hidden = !!$('#file-filter').value.trim()
  const open = allDirs(root).some(d => dirIsOpen(d, false, activeTab()?.path))
  b.innerHTML = ICON[open ? 'fold' : 'unfold']
  b.title = open ? 'Collapse all folders' : 'Expand all folders'
}

$('#tree-collapse').onclick = () => {
  const dirs = allDirs(buildTree(treePaths(), treeExtra()))
  const open = !dirs.some(d => dirIsOpen(d, false, activeTab()?.path))
  dirs.forEach(d => state.dirOpen.set(d.path, open))
  renderTree()
}

// Staging shows its result at once: the lists and the commit button move to the new side before Git
// answers, and the real status replaces this guess a moment later (or undoes it if Git refused).
const sumStat = (a, b) => a && b ? { ...a, added: a.added + b.added, deleted: a.deleted + b.deleted } : a || b || null
function guessStaged(paths, to) {
  for (const path of paths) {
    const c = state.changes.get(path)
    if (!c || conflicted(c)) continue
    if (to === 'staged' && c.work) {
      state.changes.set(path, { ...c, code: (c.code === '??' ? 'A' : c.code[0] !== ' ' ? c.code[0] : c.code[1]) + ' ', index: sumStat(c.index, c.work), work: null, staged: true })
    } else if (to === 'work' && c.index) {
      state.changes.set(path, { ...c, code: c.code[0] === 'A' ? '??' : ' ' + c.code[0], work: sumStat(c.work, c.index), index: null, staged: false })
    }
  }
  renderQueue(); renderGit()
  state.diffFiles.forEach((f, i) => { if (paths.includes(f.path)) rerenderFile(i) })
}
const stage = paths => { if (!paths.length) return; guessStaged(paths, 'staged'); return gitAction({ action: 'add', paths }) }
const unstage = paths => { if (!paths.length) return; guessStaged(paths, 'work'); return gitAction({ action: 'unstage', paths }) }
// In the review, staging a file is a decision made, so the view moves on to the next file with work left.
function advanceFrom(i) {
  if (scope() !== 'head') return
  const j = state.diffFiles.findIndex((f, k) => k > i && state.changes.get(f.path)?.work)
  if (j >= 0) goFile(j)
}
// From the unstaged list or view only the working tree goes back to the index; elsewhere the file returns to HEAD.
// Nothing brings a discarded change back, so one file asks too, not just "Discard all".
async function discard(paths, worktree) {
  if (!paths.length) return
  const rows = paths.map(p => state.changes.get(p)).filter(Boolean)
  const fresh = rows.filter(c => c.code === '??').length
  const ok = await ask({
    title: paths.length === 1 ? `Discard changes to ${basename(paths[0])}` : `Discard changes to ${plural(paths.length, 'file')}`,
    kicker: 'no undo', tone: 'danger', ok: 'Discard',
    html: `<p class="say">${worktree ? 'Unstaged changes go back to the index.' : 'Staged and unstaged changes go back to HEAD.'}${fresh ? ` ${plural(fresh, 'untracked file')} will be deleted.` : ''}</p>${fileListHTML(rows, worktree ? 'work' : 'staged', 6, true)}`,
  })
  if (ok) gitAction({ action: 'discard', paths, worktree })
}

// ---------- diff ----------
let diffTimer
function scheduleDiff() { clearTimeout(diffTimer); diffTimer = setTimeout(loadDiff, 120) }

async function loadDiff() {
  state.diffStale = false
  state.cleanShown = false
  const sc = scope()
  const params = new URLSearchParams({ scope: sc, ignoreWhitespace: $('#ignore-ws').checked ? '1' : '0' })
  if (sc === 'range') {
    const from = $('#diff-from').value.trim(), to = $('#diff-to').value.trim()
    if (!from || !to) return diffMessage('Compare two refs', 'Type a “from” and “to” ref — a branch, tag, or commit.')
    params.set('from', from); params.set('to', to); params.set('dots', state.rangeDots === '...' ? '3' : '2')
  }
  if (sc === 'commit') {
    const ref = $('#diff-commit').value.trim()
    if (!ref) return diffMessage('Pick a commit', 'Choose one under History in the Git panel, or type a hash.')
    params.set('ref', ref)
  }
  if (state.status && !state.status.git) return diffMessage('No repository here', 'Open files from the sidebar to read or edit them.')
  if (state.config.renames !== false) params.set('renames', '1')
  state.diffParams = params
  const seq = ++state.diffSeq
  try {
    const data = await api('/api/diff?' + params)
    if (seq !== state.diffSeq) return
    state.diffAll = parseDiff(data.text)
    // Git lists untracked files last; the sidebar runs in path order, so the review does too.
    if (LIVE.includes(sc)) state.diffAll.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
    state.diffFiles = filterFiles(state.diffAll)
    renderDiff()
  } catch (e) {
    if (seq === state.diffSeq) diffMessage('Can’t diff that', e.message)
  }
}

// A clean tree is the screen you see most while an agent works, so it says where the branch stands and
// that echo is watching, instead of only saying nothing changed.
function cleanHTML() {
  const last = state.hist.commits[0], t = state.status?.tracking
  const tracked = !!(t && t.upstream && !t.gone)
  const line = (k, v) => `<div class="quiet-row"><span>${k}</span><b>${v}</b></div>`
  return `<div class="quiet-card"><div class="quiet-watch"><span class="live"></span>Watching for changes</div>`
    + (last ? line('Last commit', `<span class="mono">${esc(last.short)}</span> ${esc(last.subject)} <span class="faint">${ago(last.time)}</span>`) : '')
    + (tracked ? line('Branch', t.ahead || t.behind ? `${t.behind ? `<span class="in">↓${t.behind}</span> ` : ''}${t.ahead ? `<span class="out">↑${t.ahead}</span> ` : ''}vs ${esc(t.upstream)}` : `up to date with ${esc(t.upstream)}`) : '')
    + (tracked && t.ahead ? `<button class="btn sm" data-empty="sync">Push ${plural(t.ahead, 'commit')}</button>` : '')
    + `</div>`
}

function diffMessage(title, body, extra = '') {
  state.diffFiles = []
  state.diffAll = []
  state.current = -1
  state.hunk = -1
  $('#diff-summary').textContent = ''
  renderTrace()
  renderPos()
  $('#diff').innerHTML = `<div class="diff-empty"><div class="empty"><b>${esc(title)}</b>${esc(body)}</div>${extra}</div>`
}

function isFolded(f) {
  if (state.folded.has(f.path)) return state.folded.get(f.path)
  return GENERATED.test(f.path) || f.lines > 1500
}

// ---------- drawing huge diffs lazily ----------
const LAZY_LINES = 6000
// Which unrendered bodies are within a screen and a half of the viewport get drawn. Driven by scroll and
// by each render, from measured positions rather than an observer, so it also works in a hidden tab.
function observeLazy() { renderNear() }
function renderNear() {
  if (!state.lazy) return
  const view = $('#diff'), vr = view.getBoundingClientRect(), margin = 1500
  for (const el of view.querySelectorAll('.dbody[data-lazy]')) {
    const r = el.getBoundingClientRect()
    if (r.top > vr.bottom + margin) break
    if (r.bottom >= vr.top - margin) renderBody(+el.closest('.dfile').dataset.i)
  }
}

function renderBody(i) {
  const f = state.diffFiles[i]
  if (!f || f.rendered || isFolded(f)) return false
  const sec = $(`#diff .dfile[data-i="${i}"]`)
  if (!sec) return false
  f.rendered = true
  const body = sec.querySelector('.dbody')
  body.removeAttribute('data-lazy'); body.style.minHeight = ''
  body.innerHTML = f.hunks.map((h, hi) => hunkHTML(h, hi, f.path, f.hunks.length, f)).join('')
  return true
}

// Navigation asks for a file before it looks for its hunks.
const ensureRendered = i => { if (state.lazy) renderBody(i) }

// stepHunk found nothing in what is drawn: draw the next file (or the previous) and look again.
function renderNextLazy(dir) {
  const from = state.current < 0 ? 0 : state.current
  for (let k = from + dir; k >= 0 && k < state.diffFiles.length; k += dir) if (renderBody(k)) return true
  return false
}

// ---------- filtering the review ----------
// Narrows the changed files by name or content and by notes; the full list stays in
// state.diffAll so clearing the filter brings every file back.
function filterFiles(all) {
  const q = ($('#diff-filter')?.value || '').trim().toLowerCase(), st = $('#diff-status')?.value || 'all'
  const ext = q.startsWith('.') && !q.slice(1).includes('.') ? q : ''
  return all.filter(f => {
    if (q && !(ext ? f.path.toLowerCase().endsWith(ext) : f.path.toLowerCase().includes(q) || (q.length > 1 && f.hunks.some(h => h.lines.some(l => l.text.toLowerCase().includes(q)))))) return false
    if (st === 'new') return f.isNew
    if (st === 'deleted') return f.isDeleted
    if (st === 'renamed') return !!f.renamedFrom
    if (st === 'modified') return !f.isNew && !f.isDeleted && !f.renamedFrom
    if (st === 'noted') return R.hasNotes(f)
    return true
  })
}

function refilter() {
  if (!state.diffAll) return
  state.diffFiles = filterFiles(state.diffAll)
  renderDiff()
}

// The next step of "show more context" for a file: 3 lines, then 12, then the whole file, then back.
async function expandFile(i) {
  const f = state.diffFiles[i]
  if (!f || !state.diffParams) return
  const next = !f.ctx || f.ctx === 3 ? 12 : f.ctx === 12 ? 100000 : 3
  const p = new URLSearchParams(state.diffParams)
  p.set('path', f.path); p.set('context', String(next))
  try {
    const nf = parseDiff((await api('/api/diff?' + p)).text)[0]
    if (!nf) return
    nf.ctx = next
    state.diffFiles[i] = nf
    const j = state.diffAll.findIndex(x => x.path === f.path)
    if (j >= 0) state.diffAll[j] = nf
    rerenderFile(i)
    setStatus(next === 100000 ? `${f.path}: whole file` : `${f.path}: ${next} lines of context`)
  } catch (e) { setStatus(e.message, 'err') }
}

function renderDiff() {
  const files = state.diffFiles
  const added = files.reduce((s, f) => s + f.added, 0), deleted = files.reduce((s, f) => s + f.deleted, 0)
  const total = state.diffAll?.length ?? files.length
  $('#diff-summary').innerHTML = files.length ? `${files.length}${total !== files.length ? ` of ${total}` : ''} file${total === 1 ? '' : 's'}  <span class="add">+${added}</span> <span class="del">−${deleted}</span>` : ''
  if (!files.length && total) {
    state.cleanShown = false
    return diffMessage('No file matches the filter', 'Clear the filter above to see all changed files again.')
  }
  if (!files.length) {
    const why = { head: ['Nothing to review', 'The working tree matches HEAD. When an agent writes something, it shows up here.'], worktree: ['No unstaged changes', 'Everything is staged or clean.'], staged: ['Nothing staged', 'Stage files from the sidebar to build a commit.'] }[scope()] || ['No differences', 'These refs point at the same content.']
    state.cleanShown = scope() === 'head'
    return diffMessage(...why, state.cleanShown ? cleanHTML() : '')
  }
  if (state.fileView) return renderFileView()
  const view = $('#diff'), top = view.scrollTop
  // A huge diff draws file bodies only as they come near the screen.
  state.lazy = files.reduce((n, f) => n + f.lines, 0) > LAZY_LINES
  files.forEach(f => { if (!state.lazy) f.rendered = true })
  view.innerHTML = files.map(fileHTML).join('')
  view.scrollTop = top
  observeLazy()
  state.current = -1
  renderTrace()
  updateCurrent()
}

// ---------- Files view: one changed file at a time, the whole file, no hunk chrome ----------
// The review's other view. It fetches a file with the whole file as context, so there is nothing to
// expand, and CSS hides the hunk headers and their actions; staging stays per file, in its header.
async function wholeFile(i) {
  const f = state.diffFiles[i]
  if (!f || f.ctx === 100000 || f.binary || f.note || !f.hunks.length || !state.diffParams) return
  const p = new URLSearchParams(state.diffParams)
  p.set('path', f.path); p.set('context', '100000')
  try {
    const nf = parseDiff((await api('/api/diff?' + p)).text)[0]
    if (!nf || state.diffFiles[i]?.path !== f.path) return
    nf.ctx = 100000
    state.diffFiles[i] = nf
    const j = state.diffAll.findIndex(x => x.path === f.path)
    if (j >= 0) state.diffAll[j] = nf
  } catch (e) { setStatus(e.message, 'err') }
}

async function renderFileView(i) {
  const files = state.diffFiles
  if (i === undefined) i = Math.max(0, files.findIndex(f => f.path === state.filePath))
  const f = files[i]
  if (!f) return
  state.fileIdx = i; state.filePath = f.path
  if (isFolded(f) && !state.folded.has(f.path)) state.folded.set(f.path, false)
  const seq = state.diffSeq
  await wholeFile(i)
  // A newer diff, another file or the other view took over while the file loaded.
  if (!state.fileView || state.fileIdx !== i || seq !== state.diffSeq && state.diffFiles[i]?.path !== f.path) return
  const cur = state.diffFiles[i], view = $('#diff'), same = view.querySelector(`.dfile[data-i="${i}"]`) && view.dataset.path === cur.path, top = view.scrollTop
  state.lazy = false
  cur.rendered = true
  view.dataset.path = cur.path
  view.innerHTML = fileHTML(cur, i)
  view.scrollTop = same ? top : 0
  state.current = -1
  renderTrace()
  updateCurrent()
  $('#file-prev').disabled = i === 0
  $('#file-next').disabled = i >= state.diffFiles.length - 1
}

function setFileView(on) {
  state.fileView = on
  try { localStorage.setItem(storeKey('echo:fileView'), on ? '1' : '') } catch {}
  $('#diff').classList.toggle('fileview', on)
  $('#file-nav').hidden = !on
  document.querySelectorAll('#view-seg button').forEach(b => b.classList.toggle('on', (b.dataset.view === 'file') === on))
  const at = state.diffFiles[state.current]?.path || state.filePath
  if (on && at) state.filePath = at
  if (state.diffFiles.length) {
    renderDiff()
    if (!on && at) { const i = state.diffFiles.findIndex(f => f.path === at); if (i >= 0) goFile(i) }
  }
}
document.querySelectorAll('#view-seg button').forEach(b => b.onclick = () => setFileView(b.dataset.view === 'file'))
$('#file-prev').onclick = () => stepFile(-1)
$('#file-next').onclick = () => stepFile(1)
try { if (localStorage.getItem(storeKey('echo:fileView'))) setFileView(true) } catch {}

// ---------- change trace ----------
// The title bar's picture of the whole diff: one segment per file, one tick per hunk. Additions rise
// above the baseline and deletions drop below it. A segment grows with the square root of its changed
// lines, so one huge file cannot squeeze the rest down to nothing.
const tickH = (n, max) => n ? Math.round(2 + max * Math.min(1, Math.sqrt(n / 30))) : 0
// In All changes, a file with nothing left unstaged has been looked at, so it fades.
const fullyStaged = f => { const c = scope() === 'head' && state.changes.get(f.path); return !!(c && c.index && !c.work && !conflicted(c)) }
// Everything staged is the finished state, not a faded one, so the strip only fades while some are left.

function renderTrace() {
  const files = state.diffFiles, box = $('#trace')
  box.classList.toggle('idle', !files.length)
  if (!files.length) { box.innerHTML = ''; return }
  const added = files.reduce((s, f) => s + f.added, 0), deleted = files.reduce((s, f) => s + f.deleted, 0)
  const done = files.map(fullyStaged), fade = done.some(d => !d)
  const segs = files.map((f, i) => {
    const n = f.hunks.length
    const ticks = f.hunks.map((h, hi) => `<i data-h="${hi}" style="left:${((hi + .5) / n * 100).toFixed(2)}%" title="${esc(`${basename(f.path)} · hunk ${hi + 1} of ${n}${h.context ? ` · ${hunkLabel(h.context)}` : ''} · +${h.add} −${h.del}`)}"><span class="a" style="height:${tickH(h.add, 14)}px"></span><span class="d" style="height:${tickH(h.del, 6)}px"></span></i>`).join('')
    return `<button class="tseg${fade && done[i] ? ' done' : ''}" data-i="${i}" style="flex-grow:${Math.sqrt(f.added + f.deleted + 1).toFixed(2)}" title="${esc(f.path)}  +${f.added} −${f.deleted}"><span class="tks">${ticks}</span><span class="tl">${esc(basename(f.path))}</span></button>`
  }).join('')
  const staged = scope() === 'head' ? done.filter(Boolean).length : -1
  box.innerHTML = `<span class="t-sum">${plural(files.length, 'file')} <span class="add">+${added}</span> <span class="del">−${deleted}</span></span><div class="t-strip">${segs}</div>${staged >= 0 ? `<span class="t-staged" title="Files with nothing left unstaged"><b>${staged}</b>/${files.length} staged</span>` : ''}`
  markTrace()
}

function markTrace() {
  const box = $('#trace')
  box.querySelectorAll('.tseg').forEach(s => s.classList.toggle('cur', +s.dataset.i === state.current))
  box.querySelector('.tks i.cur')?.classList.remove('cur')
  box.querySelector(`.tseg[data-i="${state.current}"] i[data-h="${state.hunk}"]`)?.classList.add('cur')
}

async function goHunk(i, hi) {
  if (state.mode !== 'diff') await setMode('diff')
  const f = state.diffFiles[i]
  if (!f) return
  ensureRendered(i)
  if (isFolded(f)) { state.folded.set(f.path, false); rerenderFile(i) }
  const view = $('#diff'), el = view.querySelector(`.dfile[data-i="${i}"] .hunk[data-h="${hi}"]`)
  if (!el) return goFile(i)
  view.scrollTop = offsetIn(el, view) - 60
  updateCurrent()
}

function renderPos() {
  const f = state.mode === 'diff' && state.diffFiles[state.current]
  $('#pos').innerHTML = f ? `file <b>${state.current + 1}</b>/${state.diffFiles.length}${state.hunk >= 0 ? ` · hunk <b>${state.hunk + 1}</b>/${f.hunks.length}` : ''}` : ''
}

function rerenderFile(i) {
  const sec = $(`#diff .dfile[data-i="${i}"]`)
  if (!sec) return
  state.diffFiles[i].rendered = true
  sec.outerHTML = fileHTML(state.diffFiles[i], i)
  state.current = -1
  updateCurrent()
}

function toggleFold(i) {
  const f = state.diffFiles[i]
  state.folded.set(f.path, !isFolded(f))
  rerenderFile(i)
}

// Five blocks, GitHub-style, showing the add/delete balance of a file.
function blocksHTML(f) {
  const total = f.added + f.deleted
  if (!total) return ''
  const a = Math.round((f.added / total) * 5)
  return `<span class="blocks">${[0, 1, 2, 3, 4].map(k => `<i class="${k < a ? 'a' : 'd'}"></i>`).join('')}</span>`
}

// Images show before and after side by side; the "before" side is wherever the old version lives for
// the view being shown.
const IMAGE = /\.(png|jpe?g|gif|webp|svg|bmp|ico|avif)$/i
function imageDiffHTML(f) {
  if (!IMAGE.test(f.path)) return ''
  const sc = scope(), url = rev => `${withBase('/api/raw')}?path=${encodeURIComponent(f.path)}${rev ? '&rev=' + encodeURIComponent(rev) : ''}`
  const commit = $('#diff-commit').value.trim(), from = $('#diff-from').value.trim(), to = $('#diff-to').value.trim()
  const sides = { head: ['head', ''], worktree: ['index', ''], staged: ['head', 'index'], commit: [commit + '^', commit], range: [from, to] }[sc]
  if (!sides) return ''
  const fig = (label, src) => `<figure><figcaption>${label}</figcaption><img src="${esc(src)}" alt="${esc(label)} version of ${esc(f.path)}" loading="lazy"></figure>`
  return `<div class="dimg">${f.isNew ? '' : fig('before', url(sides[0]))}${f.isDeleted ? '' : fig('after', url(sides[1]))}</div>`
}

function fileHTML(f, i) {
  const sc = scope()
  const c = LIVE.includes(sc) ? state.changes.get(f.path) : null
  const folded = isFolded(f)
  const kind = f.isNew ? 'new' : f.isDeleted ? 'deleted' : 'modified'
  const letter = f.isNew ? 'A' : f.isDeleted ? 'D' : 'M'
  const canStage = c && (c.work || conflicted(c)) && sc !== 'staged'
  const canUnstage = c && c.index && !conflicted(c) && sc !== 'worktree'
  // Discard sits alone at the far left, away from Stage, and is an icon that only turns red on hover.
  const acts = [
    R.notable() ? '<button class="btn quiet sm" data-act="note" title="Add a note for the agent on this whole file">Note</button>' : '',
    `<button class="btn quiet icon xs" data-act="more" aria-haspopup="menu" aria-label="More actions" title="Open, history, more context, discard"><svg class="i" viewBox="0 0 16 16"><circle cx="3.5" cy="8" r="1"/><circle cx="8" cy="8" r="1"/><circle cx="12.5" cy="8" r="1"/></svg></button>`,
    canUnstage ? `<button class="btn quiet sm" data-act="unstage" title="Unstage (u)">${ICON.minus}Unstage</button>` : '',
    canStage ? `<button class="btn sm do-stage" data-act="stage" title="Stage and go to the next file (s)">${ICON.plus}Stage</button>` : '',
  ].join('')
  const fnotes = !folded && f.path ? R.fileNotesHTML(f) : ''
  let body = ''
  const lazy = !folded && state.lazy && !f.rendered && f.hunks.length && !f.note && !f.binary
  if (lazy) body = ''
  else if (!folded) {
    if (f.note) body = `<div class="dnote">${esc(f.note)}</div>`
    else if (f.binary) body = imageDiffHTML(f) || `<div class="dnote">Binary file — not shown.</div>`
    else if (!f.hunks.length) body = `<div class="dnote">${f.renamedFrom ? `Renamed from <b>${esc(f.renamedFrom)}</b>${f.mode ? '; ' : '.'}` : ''}${f.mode ? `Mode changed ${esc(f.mode.from)} → ${esc(f.mode.to)}.` : ''}${!f.renamedFrom && !f.mode ? (f.isNew ? 'Empty new file.' : 'Metadata change only.') : ''}</div>`
    else body = f.hunks.map((h, hi) => hunkHTML(h, hi, f.path, f.hunks.length, f)).join('')
  }
  const unsaved = state.tabs.some(t => t.path === f.path && t.content !== t.saved)
  const why = folded && !state.folded.has(f.path) ? (GENERATED.test(f.path) ? 'generated' : f.lines > 1500 ? 'large' : '') : ''
  const chips = `${f.renamedFrom ? `<span class="note" title="Renamed from ${esc(f.renamedFrom)}">· renamed from ${esc(basename(f.renamedFrom))}</span>` : ''}${f.mode ? `<span class="note" title="${esc(f.mode.from)} → ${esc(f.mode.to)}">· mode ${esc((f.mode.from || '').slice(-3))}→${esc((f.mode.to || '').slice(-3))}</span>` : ''}`
  const stat = chips + (f.binary ? '' : `${f.added ? `<span class="add">+${f.added}</span>` : ''}${f.deleted ? `<span class="del">−${f.deleted}</span>` : ''}${blocksHTML(f)}`)
  return `<section class="dfile ${folded ? 'folded' : ''}" data-i="${i}">
    <header class="dfile-head"><span class="fold">▶</span>${badge(letter, kind)}<span class="dpath" title="${esc(f.path)}">${fullPath(f.path)}</span><span class="dstat">${stat}${why ? `<span class="note">· ${why}</span>` : ''}${unsaved ? '<span class="note unsaved" title="The diff shows the file on disk; save with ⌘S in the editor">· unsaved edits</span>' : ''}</span><span class="spacer"></span><span class="dacts">${acts}</span></header>
    <div class="dbody"${lazy ? ` data-lazy style="min-height:${f.lines * 20 + f.hunks.length * 44}px"` : ''}>${fnotes}${body}</div>
  </section>`
}

const rowClass = l => l.t === 'add' ? 'r-add' : l.t === 'del' ? 'r-del' : l.t === 'meta' ? 'r-meta' : ''
// data-n is the line in the new version; double-clicking any line opens the editor there.
const textCell = (l, cls) => `<span class="tx ${cls}" data-n="${l.n ?? l.at}"${R.lineAttr(l)}>${l.html || esc(l.text) || ' '}</span>`

// Each hunk is colored as two streams, old (context + deleted) and new (context + added), so a
// comment or string that opens above a line still colors it. Context rows take the new stream's color.
// Only what the hunk shows is seen: a token opened above the hunk is invisible to it.
function colorHunk(h, path) {
  h.colored = true
  const old = h.lines.filter(l => l.t === 'ctx' || l.t === 'del'), cur = h.lines.filter(l => l.t === 'ctx' || l.t === 'add')
  for (const side of [old, cur]) {
    const rows = highlightLines(side.map(l => l.text).join('\n'), path)
    if (rows) side.forEach((l, i) => { if (side === cur || l.t === 'del') l.html = rows[i] })
  }
  // Inside a changed line, mark the words that differ from the line it replaced.
  if (state.config.wordDiff !== false) {
    for (const [d, a] of pairRuns(h.lines)) {
      const r = wordRanges(d.text, a.text)
      if (!r) continue
      d.html = injectMarks(d.html ?? esc(d.text), r.a, 'wd wd-del')
      a.html = injectMarks(a.html ?? esc(a.text), r.b, 'wd wd-add')
    }
  }
}

// Git's hunk heading is a whole line (the server picks the right one per language); the header wants
// the name in it: a Go func with its receiver, a JS function or arrow, a class, a Markdown or HTML
// heading's text, or anything up to its opening brace (a CSS rule, a C or Java function).
function hunkLabel(line) {
  const s = line.trim()
  let m
  if (!s) return ''
  if ((m = s.match(/^#{1,6}\s+(.*?)\s*#*$/))) return m[1]
  if ((m = s.match(/^<h[1-6][^>]*>(.*?)(?:<\/h[1-6]>|$)/i))) return m[1].replace(/<[^>]*>/g, '').trim()
  if ((m = s.match(/^func\s+(\([^)]*\)\s*)?([\w.]+)/))) return (m[1] || '') + m[2]
  if ((m = s.match(/^type\s+(\w+)/))) return 'type ' + m[1]
  if ((m = s.match(/^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\*?\s+([\w$]+)/))) return m[1]
  if ((m = s.match(/^(?:export\s+)?(?:const|let|var)\s+([\w$]+)\s*=/))) return m[1]
  if ((m = s.match(/^(?:export\s+)?(?:default\s+)?(?:abstract\s+)?(?:pub\s+)?(class|struct|enum|trait|interface|impl)\s+([\w$]+)/))) return `${m[1]} ${m[2]}`
  if ((m = s.match(/^(?:async\s+)?def\s+(\w+)/))) return m[1]
  if ((m = s.match(/^(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+(\w+)/))) return m[1]
  return s.replace(/\s*\{.*$/, '').replace(/\s*[:(]$/, '') || s
}

// The header reads as a place, not Git's @@ line: which hunk of how many, the enclosing function Git
// found, its size, and the lines it covers in the new version. The raw @@ range stays as the tooltip.
function hunkHTML(h, hi, path, total, f) {
  if (!h.colored) colorHunk(h, path)
  const split = state.config.diffMode === 'split'
  const label = hunkLabel(h.context)
  const nums = h.lines.filter(l => l.n != null), olds = h.lines.filter(l => l.o != null)
  const span = (a, b, word) => a === b ? `${word} ${a}` : `${word}s ${a}–${b}`
  const where = nums.length ? span(nums[0].n, nums.at(-1).n, 'line') : olds.length ? span(olds[0].o, olds.at(-1).o, 'old line') : ''
  const size = `${h.add ? `<span class="add">+${h.add}</span>` : ''}${h.del ? `<span class="del">−${h.del}</span>` : ''}`
  return `<div class="hunk ${split ? 'split' : ''}" data-h="${hi}"><div class="hunk-head" title="${esc(`${h.range} ${h.context}`.trim())}"><span class="hpill"><b>${hi + 1}/${total}</b>${label ? `<span class="hctx">${esc(label)}</span>` : ''}</span>${f ? R.hunkActsHTML(f, h, hi) : ''}<span class="hmeta">${size}<span>${where}</span></span></div>${split ? splitRows(h, f, hi) : stackedRows(h, f, hi)}</div>`
}

function stackedRows(h, f, hi) {
  return h.lines.map(l => {
    const cls = rowClass(l)
    const sign = l.t === 'add' ? '+' : l.t === 'del' ? '−' : ''
    const da = R.lineAttr(l)
    return `<span class="no ${cls}"${da} title="Select this line to stage or discard just it">${l.o ?? ''}</span><span class="no ${cls}"${da}>${l.n ?? ''}</span><span class="sg ${cls}"${da} title="Add a note on this line">${sign}</span>${textCell(l, cls)}${f && l.t !== 'meta' ? R.noteRowsHTML(f, hi, l) : ''}`
  }).join('')
}

// Split view: old on the left, new on the right. A run of deletions followed by additions is paired
// row by row; the shorter side is padded with empty cells.
function splitRows(h, f, hi) {
  const side = (l, isNew) => {
    if (!l) return `<span class="no r-none ${isNew ? 'ns' : ''}"></span><span class="tx r-none"></span>`
    const cls = rowClass(l)
    return `<span class="no ${cls} ${isNew ? 'ns' : ''}"${R.lineAttr(l)}>${isNew ? l.n : l.o}</span>${textCell(l, cls)}`
  }
  const notes = l => (f && l ? R.noteRowsHTML(f, hi, l) : '')
  let out = '', dels = [], adds = []
  const flush = () => {
    for (let k = 0; k < Math.max(dels.length, adds.length); k++) out += side(dels[k], false) + side(adds[k], true) + notes(dels[k]) + notes(adds[k])
    dels = []; adds = []
  }
  for (const l of h.lines) {
    if (l.t === 'del') { if (adds.length) flush(); dels.push(l) }
    else if (l.t === 'add') adds.push(l)
    else { flush(); out += l.t === 'meta' ? `<span class="meta">${esc(l.text)}</span>` : side(l, false) + side(l, true) + notes(l) }
  }
  flush()
  return out
}

function setDiffMode(m) {
  state.config.diffMode = m
  document.querySelectorAll('.layout-switch button').forEach(b => b.classList.toggle('on', b.dataset.layout === m))
  const cur = state.current
  if (state.diffFiles.length) { renderDiff(); if (cur >= 0) goFile(cur) }
  post('/api/config', { diffMode: m }).catch(e => setStatus(e.message, 'err'))
}

// ---------- jump between review and editor ----------
// The editor opens on the double-clicked line; line numbers only match the file when the diff's new side is the working tree.
function openAtLine(path, line) {
  openFile(path, { line: EDITABLE.includes(scope()) ? line : 0, fromReview: true })
}

function openCurrentHunk() {
  const f = state.diffFiles[state.current]
  if (!f || f.isDeleted) return
  const sec = $(`#diff .dfile[data-i="${state.current}"]`)
  const h = f.hunks[+(sec?.querySelector('.hunk.current') || sec?.querySelector('.hunk'))?.dataset.h]
  const first = h?.lines.find(l => l.t === 'add' || l.t === 'del')
  openAtLine(f.path, first ? first.n ?? first.at : 1)
}

// Esc in the editor returns to the diff line nearest the caret.
async function backToReview() {
  const ed = $('#editor'), path = state.returnTo
  const line = ed.value.slice(0, ed.selectionStart).split('\n').length
  state.returnTo = ''
  ed.blur()
  setStatus(path)
  await setMode('diff')
  const i = state.diffFiles.findIndex(f => f.path === path)
  if (i < 0) return
  if (isFolded(state.diffFiles[i])) { state.folded.set(path, false); rerenderFile(i) }
  const view = $('#diff')
  const cells = [...view.querySelectorAll(`.dfile[data-i="${i}"] .tx[data-n]`)]
  if (!cells.length) return goFile(i)
  const best = cells.reduce((a, c) => Math.abs(c.dataset.n - line) < Math.abs(a.dataset.n - line) ? c : a)
  view.scrollTop = offsetIn(best, view) - view.clientHeight / 3
  updateCurrent()
}

// Position of an element inside the diff scroller, independent of offsetParent quirks.
const offsetIn = (el, view) => el.getBoundingClientRect().top - view.getBoundingClientRect().top + view.scrollTop

function updateCurrent() {
  const view = $('#diff')
  const secs = view.querySelectorAll('.dfile')
  let cur = secs.length ? +secs[0].dataset.i : -1
  secs.forEach(s => { if (offsetIn(s, view) - view.scrollTop <= 40) cur = +s.dataset.i })
  // The current hunk is the last one in the current file whose header has reached the top, which is
  // also where j and k leave it.
  const hunks = cur >= 0 ? [...(view.querySelector(`.dfile[data-i="${cur}"]`)?.querySelectorAll('.hunk') || [])] : []
  let hunk = -1
  for (const h of hunks) { if (hunk >= 0 && offsetIn(h, view) > view.scrollTop + 61) break; hunk = +h.dataset.h }
  if (cur === state.current && hunk === state.hunk) return
  if (cur !== state.current) { secs.forEach(s => s.classList.toggle('current', +s.dataset.i === cur)); state.current = cur; markQueueCurrent() }
  state.hunk = hunk
  view.querySelector('.hunk.current')?.classList.remove('current')
  hunks.find(h => +h.dataset.h === hunk)?.classList.add('current')
  markTrace()
  renderPos()
}

// In the Unstaged or Staged view only the row of the matching group is current; All changes marks both.
function markQueueCurrent() {
  const cur = currentPath(), sc = scope()
  document.querySelectorAll('.qrow').forEach(r => r.classList.toggle('current', r.dataset.path === cur && (sc === 'head' || secScope(r.dataset.sec) === sc)))
}

function currentPath() {
  if (state.mode === 'diff') return state.diffFiles[state.current]?.path
  return activeTab()?.path
}

function goFile(i) {
  if (state.fileView) return void (i === state.fileIdx && $(`#diff .dfile[data-i="${i}"]`) ? ($('#diff').scrollTop = 0) : renderFileView(i))
  ensureRendered(i)
  const view = $('#diff')
  const sec = view.querySelector(`.dfile[data-i="${i}"]`)
  if (!sec) return
  view.scrollTop = offsetIn(sec, view) - 14
  updateCurrent()
}

function stepFile(dir) {
  if (state.mode !== 'diff' || !state.diffFiles.length) return
  goFile(Math.max(0, Math.min(state.diffFiles.length - 1, state.current + dir)))
}

function stepHunk(dir) {
  const view = $('#diff')
  const hunks = [...view.querySelectorAll('.dfile:not(.folded) .hunk')]
  if (!hunks.length) return
  const pos = view.scrollTop + 60
  const tops = hunks.map(h => offsetIn(h, view))
  let idx = dir > 0 ? tops.findIndex(t => t > pos + 1) : tops.findLastIndex(t => t < pos - 1)
  if (idx < 0) { if (state.lazy && renderNextLazy(dir)) return stepHunk(dir); return }
  view.scrollTop = tops[idx] - 60
  updateCurrent()
}

async function goTo(path, sec = '') {
  await setMode('diff')
  // In a one-sided view, a row from the other group flips the view to that group's side.
  if (sec && (scope() === 'worktree' || scope() === 'staged') && scope() !== secScope(sec)) {
    $('#diff-scope').value = secScope(sec)
    syncScopeInputs()
    await loadDiff()
  }
  let i = state.diffFiles.findIndex(f => f.path === path)
  if (i < 0 && state.changes.has(path) && scope() !== 'head') {
    $('#diff-scope').value = 'head'
    syncScopeInputs()
    await loadDiff()
    i = state.diffFiles.findIndex(f => f.path === path)
  }
  if (i < 0) return openFile(path)
  if (isFolded(state.diffFiles[i])) { state.folded.set(path, false); rerenderFile(i) }
  goFile(i)
}

// Review always compares with HEAD: All, Unstaged or Staged. A commit or a range of refs is only ever
// reached from the Log or History, and shows as a chip that takes you back.
function syncScopeInputs() {
  const sc = scope(), live = ['head', 'worktree', 'staged'].includes(sc)
  document.querySelectorAll('#scope-seg button').forEach(b => b.classList.toggle('on', b.dataset.scope === sc))
  $('#scope-seg').hidden = !live
  $('#scope-chip').hidden = live
  $('#scope-chip-text').textContent = sc === 'commit' ? `Commit ${$('#diff-commit').value || state.commit.slice(0, 7)}` : sc === 'range' ? 'Comparing' : ''
  $('#range-inputs').hidden = sc !== 'range'
  $('#diff-commit').hidden = true
  if (scope() !== 'commit') state.commit = ''
  renderHistoryCurrent()
  // The clean-tree screen quotes the last commit, which may arrive after the diff.
  if (state.cleanShown && !state.diffFiles.length) renderDiff()
}

// ---------- files and tabs ----------
async function fetchFile(path) {
  return api(`/api/file?path=${encodeURIComponent(path)}`)
}

// The textarea turns CRLF into LF, so tabs hold LF text and remember the file's line ending for saving.
// A file that mixes endings is saved with LF.
function fromDisk(data) {
  const crlf = data.content.includes('\r\n') && !/(^|[^\r])\n/.test(data.content)
  const content = data.content.replace(/\r\n/g, '\n')
  return { content, saved: content, eol: crlf ? '\r\n' : '\n', hash: data.hash, binary: data.binary, tooLarge: !!data.tooLarge, size: data.size || 0, conflict: '' }
}

async function openFile(path, { line = 0, fromReview = false, find: hit = null } = {}) {
  let i = state.tabs.findIndex(t => t.path === path)
  if (i < 0) {
    try {
      const data = await fetchFile(path)
      state.tabs.push({ path, ...fromDisk(data), seen: state.changes.get(path)?.hash ?? null, preview: isMarkdown(path) })
      i = state.tabs.length - 1
    } catch (e) { return setStatus(e.message, 'err') }
  }
  if (line) state.tabs[i].preview = false
  state.active = i
  state.selected = path
  state.recent = [path, ...state.recent.filter(p => p !== path)].slice(0, 30)
  try { localStorage.setItem(storeKey('echo:recent'), JSON.stringify(state.recent)) } catch {}
  state.returnTo = fromReview ? path : ''
  setMode('file')
  renderTabs()
  renderTree()
  if (line && !activeTab().binary) placeCaret(line)
  if (hit) showFind(hit.q, hit, false)
  else if (find.open) paintFind()
  setStatus(fromReview ? `${path} — Esc returns to review` : path)
}

function placeCaret(line) {
  const ed = $('#editor'), text = ed.value
  let at = 0
  for (let k = 1; k < line; k++) {
    const nl = text.indexOf('\n', at)
    if (nl < 0) break
    at = nl + 1
  }
  ed.focus({ preventScroll: true })
  ed.setSelectionRange(at, at)
  ed.scrollTop = Math.max(0, lineTopAt(activeTab(), line - 1) - ed.clientHeight / 3)
  ed.scrollLeft = 0
  paintGutter()
}

async function closeTab(i, force = false) {
  const t = state.tabs[i]
  if (t.content !== t.saved && !force) {
    const ok = await ask({ title: 'Close without saving', kicker: 'unsaved', tone: 'danger', ok: 'Discard edits', html: `<p><b>${esc(t.path)}</b> has changes that were never saved.</p>` })
    if (!ok || state.tabs[i] !== t) return
  }
  state.closed.unshift({ path: t.path, caret: t.caret || 0, scroll: t.scroll || 0 })
  state.closed.length = Math.min(state.closed.length, 20)
  state.tabs.splice(i, 1)
  if (state.active >= state.tabs.length || state.active > i) state.active--
  if (state.active < 0 && state.tabs.length) state.active = 0
  renderTabs(); renderEditor()
}

async function reopenClosedTab() {
  const c = state.closed.shift()
  if (!c) return setStatus('No closed tab to reopen')
  await openFile(c.path)
  const t = activeTab()
  if (t && t.path === c.path) { t.caret = c.caret; t.scroll = c.scroll; renderEditor() }
}

function renderTabs() {
  $('#tabs').innerHTML = state.tabs.map((t, i) => `<div class="tab ${i === state.active && state.mode === 'file' ? 'active' : ''} ${t.content !== t.saved ? 'dirty' : ''}" data-i="${i}" draggable="true" title="${esc(t.path)}"><span>${esc(basename(t.path))}</span><button class="x" data-close="${i}" title="Close"><span>×</span></button></div>`).join('')
}

let shownTab = null
function renderEditor() {
  const file = state.mode === 'file'
  const tab = activeTab()
  const text = file && !!tab && !tab.binary && !tab.tooLarge
  const preview = text && isMarkdown(tab.path) && tab.preview
  const editing = text && !preview
  $('#save').hidden = !text
  $('#md-switch').hidden = !text || !isMarkdown(tab.path)
  document.querySelectorAll('#md-switch button').forEach(b => b.classList.toggle('on', (b.dataset.md === 'preview') === !!preview))
  $('#file-history').hidden = !file || !tab || !state.status?.git
  $('#blame-toggle').hidden = !editing || !state.status?.git
  $('#file-more').hidden = !editing
  $('#blame-toggle').classList.toggle('on', state.blameGutter)
  $('.stage').classList.toggle('blame-on', editing && state.blameGutter)
  if (editing) ensureBlame(tab)
  paintBlameGhost()
  $('#file-path').innerHTML = tab ? `${dirname(tab.path) ? `<i>${esc(dirname(tab.path))}/</i>` : ''}<b>${esc(basename(tab.path))}</b>` : ''
  $('#file-crumb').hidden = !file || !tab
  $('#stage-count').textContent = text ? `${lineCount(tab)} lines${tab.content !== tab.saved ? ' · unsaved' : ''}` : ''
  $('#highlight').classList.toggle('active', file && !text)
  $('#md').classList.toggle('active', !!preview)
  if (preview) renderPreview(tab)
  $('#editor').classList.toggle('active', editing)
  $('#gutter').classList.toggle('active', editing)
  $('#save').disabled = !tab || tab.content === tab.saved
  if (editing && shownTab !== tab) {
    // The textarea is shared by every tab: keep where the outgoing one was, and put the incoming one back.
    const ed = $('#editor')
    if (shownTab) Object.assign(shownTab, { caret: ed.selectionStart, scroll: ed.scrollTop })
    shownTab = tab
    if (ed.value !== tab.content) ed.value = tab.content
    const at = Math.min(tab.caret || 0, ed.value.length)
    ed.setSelectionRange(at, at)
    ed.scrollTop = tab.scroll || 0
  } else if (editing && $('#editor').value !== tab.content) $('#editor').value = tab.content
  if (file && !text) {
    $('#highlight').innerHTML = !tab
      ? `<div class="empty"><b>No file open</b>Press <kbd>⌘K</kbd> or pick a file from the sidebar.</div>`
      : tab.tooLarge ? `<div class="empty"><b>File too large to edit</b>${(tab.size / 1048576).toFixed(1)} MB. <button class="btn sm" data-open-ext>Open in default app</button></div>`
      : Pv.IMAGE.test(tab.path) ? Pv.imageViewHTML(tab)
      : `<div class="empty"><b>Binary file</b>Not shown. <button class="btn sm" data-open-ext>Open in default app</button></div>`
  }
  renderBanner()
  Ops.renderConflictBar()
  refreshGutter()
  paintSyntax()
  paintFind()
  Ed.onRender()
  $('#open-ext').hidden = !file || !tab
  $('#note-add').hidden = !text
  FO.paintSide()
}

// ---------- syntax highlighting ----------
// highlight.js colors the whole buffer; the textarea's text turns transparent and a layer behind it
// draws the visible rows. An unknown language or a huge file stays plain text.
// ponytail: re-tokenizes the buffer on each change (linear, capped at 200 KB); chunk it if it ever lags.
function paintSyntax() {
  const layer = $('#syntax'), ed = $('#editor'), tab = activeTab()
  const editing = state.mode === 'file' && ed.classList.contains('active') && !!tab
  if (editing && tab.hl?.text !== tab.content) tab.hl = { text: tab.content, rows: highlightLines(tab.content, tab.path) }
  const rows = editing && tab.hl.rows
  ed.classList.toggle('hl', !!rows)
  layer.classList.toggle('active', !!rows)
  if (!rows) { layer.innerHTML = ''; Ed.paintExtras(); return }
  const [first, last] = visibleRange(tab)
  let h = ''
  for (let i = first; i < last; i++) h += `<div class="sl" style="top:${lineTop(i) - ed.scrollTop}px">${Ed.decorateRow(rows[i] ?? '')}</div>`
  layer.innerHTML = `<div style="transform:translateX(${-ed.scrollLeft}px)">${h}</div>`
  Ed.paintExtras()
}

// ---------- markdown preview ----------
// Files that open rendered: Markdown, and CSV or TSV as a table.
const isMarkdown = p => /\.(md|markdown|mdown|mkd|csv|tsv)$/i.test(p)

// resolvePath joins a link in a document to a repository path; "/x" is the repository root, as on GitHub.
function resolvePath(from, link) {
  const parts = link.startsWith('/') ? [] : dirname(from).split('/').filter(Boolean)
  for (const seg of link.split('/')) {
    if (!seg || seg === '.') continue
    if (seg === '..') { if (!parts.length) return null; parts.pop() } else parts.push(seg)
  }
  return parts.join('/')
}

// mdURL keeps web and in-page links, points repository images at /api/raw, and drops other schemes.
function mdURL(tab) {
  return (v, kind) => {
    v = v.trim()
    if (v.startsWith('#')) return kind === 'link' ? v : null
    if (/^https?:/i.test(v) || (kind === 'link' && /^mailto:/i.test(v))) return v
    if (/^[a-z][\w+.-]*:|^\/\//i.test(v)) return null
    if (kind === 'link') return v
    let rel
    try { rel = resolvePath(tab.path, decodeURIComponent(v.split(/[?#]/)[0])) } catch { return null }
    return rel ? `${withBase('/api/raw')}?path=${encodeURIComponent(rel)}` : null
  }
}

function renderPreview(tab) {
  const view = $('#md')
  if (view.shownTab === tab && view.shownText === tab.content) return
  const same = view.shownTab === tab
  if (view.shownTab && !same) view.shownTab.mdScroll = view.scrollTop
  let doc
  if (Pv.isTable(tab.path)) doc = Pv.csvDoc(tab)
  else {
    doc = document.createElement('article')
    doc.className = 'md-doc'
    doc.append(...sanitize(renderMarkdown(tab.content), mdURL(tab)).childNodes)
  }
  view.replaceChildren(doc)
  if (!Pv.isTable(tab.path)) paintPreview(doc)
  if (!same) view.scrollTop = tab.mdScroll || 0
  view.shownTab = tab
  view.shownText = tab.content
}

// A fenced block names its language on the <code>, so the preview can color it the way the
// editor would, and a mermaid fence can become a diagram. This runs after sanitize(), which has
// already vetted the document, so what it adds is echo's own markup and never the document's.
const LANG = 'md-lang-'

function paintPreview(doc) {
  const blocks = [...doc.querySelectorAll('pre > code')].map(code => [code, langOf(code)])
  for (const [code, lang] of blocks) {
    if (!lang || lang === 'mermaid') continue
    const html = highlight(code.textContent, lang)
    if (html != null) code.innerHTML = html
  }
  // The previous document's diagrams are gone with the previous document.
  diagrams.clear()
  for (const [code, lang] of blocks) if (lang === 'mermaid') drawDiagram(code)
}

const langOf = code => [...code.classList].find(c => c.startsWith(LANG))?.slice(LANG.length).toLowerCase()

// ---------- diagrams ----------
// A ```mermaid fence renders as a diagram. mermaid's own build travels in the binary as a zip
// (vendor/mermaid.zip, served from memory) and is imported the first time a document has one, so
// a repository without diagrams never pays for it. A fence mermaid cannot parse keeps its source.
const MERMAID = '/vendor/mermaid/mermaid.esm.min.mjs'
const diagrams = new Map()
let mermaidLib = 0, diagramSeq = 0

function mermaid() {
  mermaidLib ||= import(MERMAID).then(m => m.default)
  return mermaidLib
}

// mermaidColors reads echo's theme tokens, so a diagram sits in the theme instead of on top of it.
function mermaidColors() {
  const s = getComputedStyle(document.documentElement)
  const v = n => s.getPropertyValue(n).trim()
  return {
    background: v('--sunk'), primaryColor: v('--surface-2'), primaryTextColor: v('--fg'),
    primaryBorderColor: v('--line-2'), secondaryColor: v('--surface'), tertiaryColor: v('--surface'),
    lineColor: v('--muted'), textColor: v('--fg'), mainBkg: v('--surface-2'), nodeBorder: v('--line-2'),
    clusterBkg: v('--surface'), clusterBorder: v('--line'), edgeLabelBackground: v('--sunk'),
    labelBoxBkgColor: v('--surface-2'), labelBoxBorderColor: v('--line-2'), labelTextColor: v('--fg'),
    actorBkg: v('--surface-2'), actorBorder: v('--line-2'), actorTextColor: v('--fg'),
    actorLineColor: v('--muted'), signalColor: v('--muted'), signalTextColor: v('--fg'),
    loopTextColor: v('--fg'), activationBkgColor: v('--surface-2'), activationBorderColor: v('--line-2'),
    noteBkgColor: v('--surface-2'), noteTextColor: v('--fg'), noteBorderColor: v('--line'),
    sectionBkgColor: v('--surface-2'), altSectionBkgColor: v('--surface'), gridColor: v('--line'),
    todayLineColor: v('--accent'), taskBkgColor: v('--surface-2'), taskBorderColor: v('--line-2'),
    pie1: v('--accent'), pie2: v('--info'), pie3: v('--add'), pie4: v('--warn'), pie5: v('--del'),
  }
}

async function mermaidReady() {
  const api = await mermaid()
  api.initialize({
    startOnLoad: false, securityLevel: 'strict', theme: 'base', themeVariables: mermaidColors(),
    fontFamily: getComputedStyle(document.body).fontFamily, fontSize: '14px',
  })
  return api
}

async function drawDiagram(code) {
  const src = code.textContent
  const pre = code.parentElement
  pre.classList.add('md-drawing')
  const box = document.createElement('div')
  box.className = 'md-diagram'
  const id = 'md-diagram-' + ++diagramSeq
  try {
    await paintDiagram(box, src, id)
    diagrams.set(box, src)
    pre.replaceWith(box)
  } catch {
    pre.classList.remove('md-drawing')
    document.getElementById('d' + id)?.remove()
  }
}

// paintDiagram is the one place a diagram box is filled, so a redraw cannot leave out the button.
async function paintDiagram(box, src, id) {
  box.innerHTML = await renderDiagram(src, id)
  sizeDiagram(box.querySelector(':scope > svg'), false)
  if (!box.querySelector('.md-expand')) box.append(expandButton(box))
}

// mermaid hands back an svg of width="100%" capped at the size it was drawn, which stretches a
// narrow diagram to the column and makes labels blurry on a wide screen. The viewBox says how wide
// it really is: full size is that width and no more, and Fit fills the window instead.
function sizeDiagram(svg, fit) {
  const w = svg?.viewBox.baseVal.width
  if (!w) return
  svg.style.width = fit ? '100%' : `${w}px`
  svg.style.maxWidth = fit ? 'none' : '100%'
}

// renderDiagram draws a source and returns the svg; strict mode is what keeps a label in the
// diagram from becoming markup, since mermaid sanitizes what it draws the way the page
// sanitizes a document.
async function renderDiagram(src, id) {
  return (await (await mermaidReady()).render(id, src)).svg
}

function expandButton(box) {
  const b = document.createElement('button')
  b.className = 'btn quiet icon xs md-expand'
  b.title = 'Expand the diagram (Esc closes it)'
  b.setAttribute('aria-label', 'Expand the diagram')
  b.innerHTML = '<svg class="i" viewBox="0 0 16 16"><path d="M2 6V2h4M10 2h4v4M14 10v4h-4M6 14H2v-4"/></svg>'
  b.onclick = () => openDiagram(box)
  return b
}

// ---------- the expanded diagram ----------
// Expanding moves the drawn svg into a card over the page rather than drawing it a second time:
// one copy means one set of ids and no flicker. Closing puts it back.
const expanded = { box: null, svg: null, src: '', focus: null }

function openDiagram(box) {
  const svg = box.querySelector(':scope > svg')
  if (!svg) return
  expanded.box = box
  expanded.svg = svg
  expanded.src = diagrams.get(box) || ''
  // Focus goes back to this diagram's own button, whatever the click did to the focus.
  expanded.focus = box.querySelector('.md-expand')
  $('#diagram-body').replaceChildren(svg)
  $('#diagram').hidden = false
  // Expanded means readable: the diagram opens at the size it was drawn, and the button shrinks it.
  setDiagramFit(false)
  $('#diagram-size').focus()
}

function closeDiagram() {
  if ($('#diagram').hidden) return
  $('#diagram-body').replaceChildren()
  if (expanded.box?.isConnected) expanded.box.append(expanded.svg)
  $('#diagram').hidden = true
  expanded.box = expanded.svg = null
  expanded.focus?.focus()
  expanded.focus = null
}

function setDiagramFit(fit) {
  $('#diagram-body').classList.toggle('actual', !fit)
  sizeDiagram($('#diagram-body').querySelector('svg'), fit)
  $('#diagram-size').textContent = fit ? 'Full size' : 'Fit'
}

// A theme change repaints what is on screen, so the diagrams on it follow, the open one included.
async function repaintDiagrams() {
  for (const [box, src] of diagrams) {
    if (!box.isConnected) { diagrams.delete(box); continue }
    try { await paintDiagram(box, src, 'md-diagram-' + ++diagramSeq) } catch {}
  }
  if (expanded.svg?.isConnected) {
    try {
      const body = $('#diagram-body')
      const fit = !body.classList.contains('actual')
      body.innerHTML = await renderDiagram(expanded.src, 'md-diagram-' + ++diagramSeq)
      expanded.svg = body.querySelector('svg')
      setDiagramFit(fit)
    } catch {}
  }
}

$('#diagram').onclick = e => { if (e.target === $('#diagram') || e.target.dataset.close !== undefined) closeDiagram() }
$('#diagram-size').onclick = () => setDiagramFit($('#diagram-body').classList.contains('actual'))

function setPreview(on) {
  const tab = activeTab()
  if (!tab || !isMarkdown(tab.path) || state.mode !== 'file') return
  if (tab.preview && !on) tab.mdScroll = $('#md').scrollTop
  tab.preview = on
  renderEditor()
  if (!on) $('#editor').focus({ preventScroll: true })
}

function scrollToAnchor(hash) {
  let id = hash.replace(/^#/, '')
  try { id = decodeURIComponent(id) } catch {}
  $('#md').querySelector(`[id="${CSS.escape('md-' + id.toLowerCase())}"]`)?.scrollIntoView({ block: 'start' })
}

// ---------- change bars ----------
// Bars beside the line numbers compare the editor text with HEAD (staged lines drawn hollow) or with the index.
const LINE = 20, PAD = 10
const gutterBase = () => state.config.gutterBase === 'index' ? 'index' : 'head'

function lineCount(tab) {
  if (tab.countFor !== tab.content) { tab.countFor = tab.content; tab.count = tab.content.split('\n').length }
  return tab.count
}

function tabLines(tab) {
  if (tab.linesFor !== tab.content) { tab.linesFor = tab.content; tab.lines = tab.content.split('\n') }
  return tab.lines
}

// ---------- find in file ----------
// ⌘F opens a bar over the editor; matches are tinted by a transparent-text layer above the textarea, so
// they show on top of the syntax colors and selection without touching either.
// ponytail: matches are per line (no multi-line regex), capped at FIND_MAX; a match scrolled off to the right is not revealed.
const FIND_MAX = 5000
const find = { open: false, q: '', opts: { case: false, word: false, regex: false }, idx: 0, list: [], byLine: new Map(), sig: '', text: null, bad: false }
const inEditor = () => state.mode === 'file' && $('#editor').classList.contains('active') && !!activeTab()
// What is selected in the editor, when it is focused and sits on one line: the seed for a search.
function editorSelection() {
  const ed = $('#editor')
  if (document.activeElement !== ed) return ''
  const t = ed.value.slice(ed.selectionStart, ed.selectionEnd)
  return t.includes('\n') ? '' : t
}

function computeFind(tab) {
  const sig = tab.path + '\0' + find.q + JSON.stringify(find.opts)
  if (find.sig === sig && find.text === tab.content) return
  find.sig = sig
  find.text = tab.content
  find.list = []
  find.byLine = new Map()
  const re = find.q ? searchRegex({ q: find.q, ...find.opts }) : null
  find.bad = !!find.q && !re
  if (re) {
    const lines = tabLines(tab)
    let off = 0
    for (let i = 0; i < lines.length && find.list.length < FIND_MAX; i++) {
      for (const m of lines[i].matchAll(re)) {
        if (!m[0]) break
        const x = { line: i, s: m.index, e: m.index + m[0].length, off: off + m.index }
        find.list.push(x)
        find.byLine.has(i) ? find.byLine.get(i).push(x) : find.byLine.set(i, [x])
      }
      off += lines[i].length + 1
    }
  }
  // the current match is the first one at or after the caret
  const at = find.list.findIndex(m => m.off >= $('#editor').selectionStart)
  find.idx = at < 0 ? 0 : at
}

function paintFind() {
  const layer = $('#findmarks'), ed = $('#editor'), tab = activeTab()
  const on = find.open && inEditor()
  $('#findbar').hidden = !on
  if (on) computeFind(tab)
  const n = find.list.length
  layer.classList.toggle('active', on && n > 0)
  if (!on) { layer.innerHTML = ''; return }
  const c = $('#find-count')
  c.textContent = !find.q ? '' : find.bad ? 'Invalid' : n ? `${find.idx + 1} of ${n.toLocaleString()}${n >= FIND_MAX ? '+' : ''}` : 'No results'
  c.classList.toggle('none', !!find.q && !n)
  if (!n) { layer.innerHTML = ''; return }
  const [first, last] = visibleRange(tab), lines = tabLines(tab), cur = find.list[find.idx]
  let h = ''
  for (let i = first; i < last; i++) {
    const ms = find.byLine.get(i)
    if (!ms) continue
    let at = 0, row = ''
    for (const m of ms) {
      row += esc(lines[i].slice(at, m.s)) + `<mark${m === cur ? ' class="cur"' : ''}>${esc(lines[i].slice(m.s, m.e))}</mark>`
      at = m.e
    }
    h += `<div class="sl" style="top:${lineTop(i) - ed.scrollTop}px">${row + esc(lines[i].slice(at))}</div>`
  }
  layer.innerHTML = `<div style="transform:translateX(${-ed.scrollLeft}px)">${h}</div>`
}

function revealMatch() {
  const m = find.list[find.idx]
  if (m) {
    const ed = $('#editor'), top = lineTopAt(activeTab(), m.line)
    if (top < ed.scrollTop || top + LINE > ed.scrollTop + ed.clientHeight) ed.scrollTop = Math.max(0, top - ed.clientHeight / 3)
  }
  paintFind()
}

// showFind turns the layer on for a query. Without `focus` the editor keeps it, which is how a hit
// from the content search arrives: the file opens with every occurrence marked.
function showFind(q, opts, focus = true) {
  if (!inEditor()) return false
  find.open = true
  find.sig = ''
  if (q != null) { find.q = q; if (opts) find.opts = { case: !!opts.case, word: !!opts.word, regex: !!opts.regex } }
  const box = $('#find-input')
  box.value = find.q
  document.querySelectorAll('#findbar [data-fopt]').forEach(b => b.setAttribute('aria-pressed', find.opts[b.dataset.fopt]))
  if (focus) { box.focus(); box.select() }
  revealMatch()
  return true
}

function closeFind(refocus = true) {
  if (!find.open) return
  find.open = false
  paintFind()
  const m = find.list[find.idx], ed = $('#editor')
  if (!refocus || !inEditor()) return
  ed.focus({ preventScroll: true })
  if (m) ed.setSelectionRange(m.off, m.off + m.e - m.s)
}

function stepFind(dir) {
  if (!find.list.length) return
  find.idx = (find.idx + dir + find.list.length) % find.list.length
  revealMatch()
}

$('#find-input').addEventListener('input', e => { find.q = e.target.value; paintFind(); revealMatch() })
$('#find-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') { e.preventDefault(); stepFind(e.shiftKey ? -1 : 1) }
  else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeFind() }
})
$('#find-prev').onclick = () => stepFind(-1)
$('#find-next').onclick = () => stepFind(1)
$('#find-close').onclick = () => closeFind()
document.querySelectorAll('#findbar [data-fopt]').forEach(b => b.onclick = () => {
  const o = b.dataset.fopt
  find.opts[o] = !find.opts[o]
  b.setAttribute('aria-pressed', find.opts[o])
  paintFind()
  revealMatch()
  $('#find-input').focus()
})

// ---------- word wrap ----------
// With wrap on, a line is as tall as it needs to be, so the gutter and the syntax layer can no longer
// sit on a fixed 20px pitch. The only measurement that agrees with the browser about tabs, wide
// characters and words too long to fit is the browser itself: a hidden mirror, one block per line,
// given exactly the textarea's content box. Line heights are kept as a running offset, so a keystroke
// or a scroll costs a batch of measurements, not one per line in the file.
let wrap = { tab: null, text: null, w: 0, n: 0, filled: 0, at: 0, h: [], top: [0] }

// Same left edge, same width as the textarea's content box: shift either and tabs and long lines
// break in a different place, and every line below the first is off by a row. The content box is
// narrower than the stage, because the textarea's own scrollbar sits inside it, so the width is read
// off the textarea and published for the syntax layer rather than derived from the stage.
function wrapGeom() {
  const ed = $('#editor'), cs = getComputedStyle(ed)
  const left = parseFloat(cs.paddingLeft)
  const w = ed.clientWidth - left - parseFloat(cs.paddingRight)
  $('.stage').style.setProperty('--content-w', w + 'px')
  return { left, w }
}

function wrapBox() {
  const m = $('#wrap-mirror'), g = wrapGeom()
  m.style.left = g.left + 'px'
  m.style.width = g.w + 'px'
  return m
}

// The measurements belong to one text wrapped at one width; anything else starts over.
function wrapSync(tab) {
  const n = lineCount(tab), w = wrapGeom().w
  if (wrap.tab !== tab || wrap.text !== tab.content || wrap.w !== w || wrap.n !== n) {
    wrap = { tab, text: tab.content, w, n, filled: 0, at: 0, h: [], top: [0] }
  }
}

// Measure lines up to `upto`. One write and one batch of reads, so the browser lays the batch out
// once; the blocks are dropped afterwards, since only the numbers are read again. The mirror holds
// this batch alone, so its first child is line `wrap.filled`, not line 0.
function wrapMeasure(tab, upto) {
  const to = Math.min(lineCount(tab), upto)
  if (wrap.filled >= to) return
  const from = wrap.filled, lines = tabLines(tab), m = wrapBox()
  let html = ''
  for (let i = from; i < to; i++) html += `<div>${esc(lines[i])}</div>`
  m.innerHTML = html
  const kids = m.children
  for (let i = from; i < to; i++) {
    wrap.h[i] = kids[i - from].offsetHeight
    wrap.top[i + 1] = wrap.top[i] + wrap.h[i]
  }
  wrap.filled = to
  m.innerHTML = ''
}

// Which line starts at the given offset. Only the measured prefix is searched, so the walk resumes
// from the last answer; stepping over it is arithmetic on cached numbers.
function wrapAt(y) {
  let i = Math.max(0, Math.min(wrap.at || 0, wrap.filled - 1))
  while (i > 0 && wrap.top[i] > y) i--
  while (i < wrap.filled - 1 && wrap.top[i + 1] <= y) i++
  wrap.at = i
  return i
}

// The lines the editor is showing. Without wrap that is a division by the line height; with wrap the
// measured offsets decide it, and a line can be several rows tall. A jump past what has been measured
// doubles the batch until the answer is inside it.
function visibleRange(tab) {
  const ed = $('#editor'), n = lineCount(tab)
  if (!state.wrap) {
    const first = Math.max(0, Math.floor((ed.scrollTop - PAD) / LINE) - 2)
    return [first, Math.min(n, first + Math.ceil(ed.clientHeight / LINE) + 4)]
  }
  wrapSync(tab)
  wrapMeasure(tab, Math.max(80, Math.ceil(ed.clientHeight / LINE) + 8))
  const y = ed.scrollTop - PAD, bottom = y + ed.clientHeight + 2 * LINE
  let first = 0
  for (;;) {
    first = wrapAt(y)
    if (first < wrap.filled - 1 || wrap.filled >= n) break
    wrapMeasure(tab, wrap.filled * 2 + 80)
  }
  let last = first
  while (last < wrap.filled - 1 && wrap.top[last + 1] <= bottom) last++
  return [Math.max(0, first - 1), Math.min(n, last + 2)]
}

// Where a line starts. The wrap case is only valid once the line is measured, which lineTopAt does.
const lineTop = i => state.wrap ? PAD + wrap.top[i] : PAD + i * LINE
function lineTopAt(tab, i) {
  if (state.wrap) { wrapSync(tab); wrapMeasure(tab, i + 1) }
  return lineTop(i)
}

// With wrap on, the caret is not at the end of a fixed row, so where it sits is asked of the mirror
// with a marker in the line: the same block the browser just wrapped.
function caretSpot(tab, line, col) {
  const m = wrapBox()
  m.innerHTML = `<div>${esc(tabLines(tab)[line].slice(0, col))}<i class="caret"></i></div>`
  const at = m.firstElementChild.lastElementChild
  const spot = { x: at.offsetLeft, y: at.offsetTop }
  m.innerHTML = ''
  return spot
}

// Bases are refetched whenever the status changes, since a commit or stage moves HEAD or the index.
async function ensureBase(tab) {
  if (!state.status?.git) { tab.base = null; return }
  if (tab.base?.seq === state.statusSeq) return
  const seq = state.statusSeq
  const get = rev => api(`/api/file?path=${encodeURIComponent(tab.path)}&rev=${rev}`)
  try {
    const [head, index] = await Promise.all([get('head'), get('index')])
    tab.base = { seq, head, index }
  } catch { tab.base = null }
}

async function refreshGutter() {
  const tab = activeTab()
  if (state.mode !== 'file' || !tab || tab.binary) return paintGutter()
  await ensureBase(tab)
  if (tab !== activeTab()) return
  computeMarks(tab)
  paintGutter()
}

function computeMarks(tab) {
  const b = tab.base
  const key = `${b?.seq}|${gutterBase()}`
  if (tab.marksFor === tab.content && tab.marksKey === key) return
  tab.marksFor = tab.content
  tab.marksKey = key
  tab.marks = null
  if (!b || b.head.binary || b.index.binary) return
  // Ignored files are in neither HEAD nor the index and never appear as changes, so they get no bars.
  if (!b.head.exists && !b.index.exists && !state.changes.has(tab.path)) return
  const cur = splitLines(tab.content)
  const vsIndex = lineDiff(splitLines(b.index.exists ? b.index.content : ''), cur)
  if (gutterBase() === 'index') { tab.marks = { kinds: vsIndex.marks, staged: [], dels: new Map([...vsIndex.dels].map(p => [p, false])) }; return }
  const vsHead = lineDiff(splitLines(b.head.exists ? b.head.content : ''), cur)
  // A line that differs from HEAD but not from the index is staged. Unstaged edits on top win.
  const staged = vsHead.marks.map((k, i) => !!k && !vsIndex.marks[i])
  // Unstaged deletions come from the index diff: next to a staged edit, HEAD sees the pair as one modified block.
  const dels = new Map([...vsHead.dels].map(p => [p, !vsIndex.dels.has(p)]))
  for (const p of vsIndex.dels) dels.set(p, false)
  tab.marks = { kinds: vsHead.marks, staged, dels }
}

// Only the visible rows are drawn, so large files cost the same as small ones.
function paintGutter() {
  const g = $('#gutter'), ed = $('#editor'), tab = activeTab()
  if (state.mode !== 'file' || !tab || tab.binary) { g.innerHTML = ''; return }
  const n = lineCount(tab), mk = tab.marks
  const [first, last] = visibleRange(tab)
  // The blame column labels the first line of each run of lines from the same commit.
  const bl = state.blameGutter && freshBlame(tab)
  const noteLines = R.noteLinesFor(tab.path)
  let h = ''
  for (let i = first; i < last; i++) {
    const kind = mk?.kinds[i], del = mk?.dels.get(i), end = i === n - 1 ? mk?.dels.get(n) : undefined
    let who = ''
    if (bl) {
      const k = bl.lines[i], c = bl.commits[k]
      if (c && (i === first || bl.lines[i - 1] !== k)) who = uncommitted(c) ? '<span class="gbl new">Not committed yet</span>'
        : `<span class="gbl" data-hash="${esc(c.hash)}" title="${esc(c.summary)}\n${esc(c.author)}, ${esc(new Date(c.time * 1000).toLocaleString())}\n${esc(c.hash.slice(0, 7))} · click to see the commit">${esc(c.author)} · ${ago(c.time).replace(' ago', '')}</span>`
    }
    const nid = noteLines.get(i + 1)
    h += `<div class="gl" style="top:${lineTop(i) - ed.scrollTop}px${state.wrap ? `;height:${wrap.h[i]}px` : ''}">${who}${nid ? `<i class="gn" data-nid="${esc(nid)}" title="A note is here. Click to edit."></i>` : ''}${i + 1}`
      + (kind ? `<i class="gb ${kind}${mk.staged[i] ? ' staged' : ''}" title="${kind === 'add' ? 'Added' : 'Modified'}${mk.staged[i] ? ', staged' : ''}"></i>` : '')
      + (del !== undefined ? `<i class="gd${del ? ' staged' : ''}"></i>` : '')
      + (end !== undefined ? `<i class="gd end${end ? ' staged' : ''}"></i>` : '')
      + '</div>'
  }
  g.innerHTML = h
}

function renderBanner() {
  const tab = activeTab()
  const b = $('#banner')
  if (state.mode !== 'file' || !tab?.conflict) { b.hidden = true; return }
  const deleted = tab.conflict === 'deleted'
  b.innerHTML = `<span class="grow"><b>${esc(basename(tab.path))}</b> ${deleted ? 'was deleted on disk.' : 'changed on disk while you had unsaved edits.'}</span>
    ${deleted ? '<button class="btn sm" data-banner="close">Close tab</button>' : '<button class="btn sm" data-banner="reload">Take disk version</button>'}
    <button class="btn sm primary" data-banner="overwrite">${deleted ? 'Recreate with mine' : 'Keep mine and overwrite'}</button>`
  b.hidden = false
}

async function reloadTab(tab) {
  Object.assign(tab, fromDisk(await fetchFile(tab.path)))
}

// Keep open tabs honest when an agent edits files: clean tabs reload quietly, dirty ones get a banner.
async function syncTabs() {
  let changed = false
  for (const tab of [...state.tabs]) {
    const expected = state.changes.get(tab.path)?.hash ?? null
    if (expected === tab.seen) continue
    tab.seen = expected
    if (expected && expected === tab.hash) continue
    let data
    try { data = await fetchFile(tab.path) } catch {
      tab.conflict = 'deleted'; changed = true; continue
    }
    if (data.hash === tab.hash) continue
    if (tab.content === tab.saved) {
      Object.assign(tab, fromDisk(data))
      if (tab === activeTab()) setStatus(`Reloaded ${tab.path} — it changed on disk`)
    } else tab.conflict = 'changed'
    changed = true
  }
  if (changed) { renderTabs(); if (state.mode === 'file') renderEditor() }
}

async function saveFile(force = false) {
  const tab = activeTab()
  if (!tab || tab.binary || tab.tooLarge || state.mode !== 'file') return
  Ed.beforeSave()
  tab.content = $('#editor').value
  try {
    const content = tab.eol === '\r\n' ? tab.content.replace(/\n/g, '\r\n') : tab.content
    const res = await post('/api/file', { action: 'save', path: tab.path, content, baseHash: tab.hash, force })
    Object.assign(tab, { saved: tab.content, hash: res.hash, conflict: '' })
    state.diffStale = true
    renderTabs(); renderEditor()
    setStatus('Saved ' + tab.path, 'ok')
  } catch (e) {
    if (e.status === 409) {
      tab.conflict = /deleted/.test(e.message) ? 'deleted' : 'changed'
      renderEditor()
    }
    setStatus(e.message, 'err')
  }
}

async function fileAction(action, dir = '') {
  const current = state.selected || activeTab()?.path
  if (action !== 'create' && !current) return setStatus('Select a file first')
  const path = action === 'create' ? await ask({ title: 'Name the new file', ok: 'Create', input: { label: 'Path, relative to the repository', placeholder: 'src/name.ext', value: dir && dir + '/', end: true } }) : current
  if (!path) return
  const newPath = action === 'rename' ? await ask({ title: 'Rename this file', ok: 'Rename', input: { label: 'New path', value: path } }) : ''
  if (action === 'rename' && !newPath) return
  try {
    await post('/api/file', { action, path, newPath, content: '' })
    const i = state.tabs.findIndex(t => t.path === path)
    if (i >= 0 && action === 'delete') { state.tabs.splice(i, 1); state.active = Math.min(state.active, state.tabs.length - 1) }
    if (i >= 0 && action === 'rename') state.tabs[i].path = newPath
    state.selected = action === 'delete' ? '' : newPath || path
    await refreshAll()
    if (action === 'create') openFile(path)
    else { renderTabs(); renderEditor() }
  } catch (e) { setStatus(e.message, 'err') }
}

// ---------- mode ----------
// setMode returns a promise that settles once the diff is current, so callers can scroll within it.
function setMode(m) {
  const was = state.mode
  if (was === 'diff' && m !== 'diff') { state.diffScroll = $('#diff').scrollTop; state.diffPos = diffPos() }
  state.mode = m
  document.querySelectorAll('.mode-switch button').forEach(b => b.classList.toggle('on', b.dataset.mode === m))
  $('#diff-bar').hidden = m !== 'diff'
  $('#log-extra').hidden = m !== 'log' || $('#log-more').getAttribute('aria-expanded') !== 'true'
  $('#file-bar').hidden = m !== 'file'
  $('#log-bar').hidden = m !== 'log'
  $('#log').classList.toggle('active', m === 'log')
  if (m !== 'diff') state.fromLog = false
  // The Log gets IntelliJ's branch list beside it; leaving puts the sidebar back as it was.
  if (m === 'log' && was !== 'log') {
    // The Log is the history, so a History drawer beside it is closed: the room goes to the graph.
    if (gitOpen() && $('#insp').dataset.insp === 'history') toggleGit(false)
    if (state.rail !== 'branches' && state.status?.git) { state.railBeforeLog = state.rail === 'logside' ? 'changes' : state.rail; setRail('branches') }
  }
  if (was === 'log' && m !== 'log' && state.railBeforeLog) { if (state.rail === 'branches') setRail(state.railBeforeLog); state.railBeforeLog = '' }
  if (m === 'log') { if (!state.log.loaded) loadLog(); $('#log-rows').focus({ preventScroll: true }) }
  $('#file-crumb').hidden = m !== 'file' || !activeTab()
  $('#diff').classList.toggle('active', m === 'diff')
  if (m === 'diff' && was !== 'diff') {
    $('#diff').scrollTop = state.diffScroll
    // Reload what changed while editing; otherwise re-render so "unsaved edits" notes are current.
    if (state.diffStale) state.diffReady = loadDiff()
    else { if (state.diffFiles.length) renderDiff(); state.diffReady = Promise.resolve() }
  }
  renderTabs(); renderEditor(); markQueueCurrent(); renderPos()
  return state.diffReady
}

// ---------- commit ----------
function changeTally() {
  const all = [...state.changes.values()]
  return { conflicts: all.filter(conflicted).length, staged: all.filter(c => !conflicted(c) && c.index), unstaged: all.filter(c => !conflicted(c) && c.work) }
}

// The tally says what a commit would take; the button and hint say which commit the default is.
function renderCommit() {
  const t = changeTally(), all = !!state.config.commitAll
  const ns = t.staged.length, nu = t.unstaged.length
  const bit = (cls, n, word) => n ? `<span class="${cls}"><i></i>${n} ${word}</span>` : ''
  $('#commit-tally').innerHTML = bit('s', ns, 'staged') + bit('u', nu, 'unstaged') || 'Clean'
  // The button names exactly what it will commit. With something staged that is the staged files; with
  // nothing staged it either takes everything (Commit stages everything) or waits for a file to be staged.
  const takeAll = all && !ns
  const label = takeAll ? (nu ? `Stage ${plural(nu, 'file')} & Commit` : 'Commit') : ns ? `Commit ${plural(ns, 'staged file')}` : 'Commit'
  $('#commit-label').textContent = label
  $('#commit').disabled = takeAll ? !nu : !ns
  // The rail and the title bar's Git button carry the same staged badge; one of them is on screen.
  for (const id of ['#rail-staged', '#tb-staged']) { $(id).hidden = !ns; $(id).textContent = ns }
  $('#git-toggle').title = ns ? `Git panel (⌘J) · ${plural(ns, 'file')} staged` : 'Git panel (⌘J)'
  const hint = $('#commit-hint')
  const words = takeAll && nu ? `Nothing is staged, so this commits all ${plural(nu, 'change')}, after you confirm.`
    : !takeAll && !ns ? (nu ? 'Nothing staged yet. Stage files in Changes, or press s in the review.' : '')
    : nu ? `${plural(nu, 'unstaged change')} stay out of this commit.` : ''
  hint.hidden = !words
  hint.textContent = words
  $('#revert-bar').hidden = true
  $('#commit-menu').innerHTML = (nu && (ns || !all)
    ? `<button class="menu-item" data-c="all" role="menuitem">${ns ? `Stage ${plural(nu, 'more file')} & Commit` : 'Stage all & Commit'}</button>` : '')
    + '<button class="menu-item" data-c="amend" role="menuitem">Amend last commit (edit message)</button>'
    + '<button class="menu-item" data-c="amend-keep" role="menuitem" title="Add the staged changes to the last commit and keep its message">Amend, keep message</button>'
    + '<button class="menu-item" data-c="undo" role="menuitem" title="Move the branch back one commit; its changes stay staged">Undo last commit</button>'
}

function toggleCommitMenu(open) {
  const m = $('#commit-menu')
  m.hidden = !open
  if (!open) return
  const r = $('#commit-more').getBoundingClientRect()
  m.style.left = Math.max(8, r.right - m.offsetWidth) + 'px'
  m.style.top = r.bottom + 4 + 'px'
  m.querySelector('.menu-item')?.focus()
}

// Amend replaces the last commit's message, so an empty box is filled with it to edit; choosing Amend
// again (or a message typed first) rewrites the commit with what the box holds and whatever is staged.
async function amend() {
  const box = $('#commit-message')
  if (box.value.trim()) return gitAction({ action: 'amend', message: box.value, ...G.commitOpts() })
  const head = state.status?.head
  if (!head) return setStatus('There is no commit to amend yet', 'err')
  try {
    const d = await api('/api/commit?hash=' + encodeURIComponent(head))
    box.value = d.body ? d.subject + '\n\n' + d.body : d.subject
    box.focus()
    setStatus('Edit the message, then choose Amend last commit again')
  } catch (e) { setStatus(e.message, 'err') }
}

async function undoLastCommit() {
  const last = state.hist.commits[0]
  if (!last) return setStatus('There is no commit to undo', 'err')
  const pushed = state.status?.tracking && state.status.tracking.ahead === 0 && state.status.tracking.upstream
  const ok = await ask({ title: 'Undo the last commit', kicker: 'soft reset', tone: pushed ? 'warn' : '', ok: 'Undo commit', html: `<p><span class="mono">${esc(last.short)}</span> ${esc(last.subject)}</p><p>The branch moves back one commit and its changes stay staged.</p>${pushed ? '<p class="note">This commit looks pushed; pushing the branch afterwards needs a force push.</p>' : ''}` })
  if (ok) gitAction({ action: 'undo:commit' })
}

// Committing everything is the one commit that reaches past what the user staged, so it always asks.
async function doCommit(all) {
  const message = $('#commit-message').value
  if (!message.trim()) { setStatus('Write a commit message first', 'err'); $('#commit-message').focus(); return }
  if (!all) return gitAction({ action: 'commit', message, ...G.commitOpts() })
  const t = changeTally()
  if (t.conflicts) return setStatus('Resolve the merge conflicts before staging everything', 'err')
  if (!t.staged.length && !t.unstaged.length) return setStatus('Nothing to commit')
  const fresh = t.unstaged.filter(c => c.code === '??').length
  const ok = await ask({
    title: 'Commit everything, staged or not', kicker: 'stages all', tone: 'warn', ok: 'Stage all & Commit',
    html: `<p class="say">All staged <b>and</b> unstaged changes will be committed.</p>`
      + (t.unstaged.length ? fileListHTML(t.unstaged, 'work') : '')
      + `<div class="dialog-quote">${esc(message.trim())}</div>`
      + `<div class="slip-total"><span>${t.staged.length} already staged · ${t.unstaged.length} to stage</span><span>${fresh ? `${fresh} untracked` : ''}</span></div>`,
  })
  if (ok) gitAction({ action: 'commit:all', message, ...G.commitOpts() })
}

// ---------- ledger ----------
function renderGit() {
  const s = state.status || {}
  $('#branch').textContent = s.branch || (s.git === false ? 'no repository' : '—')
  $('#repo-name').textContent = s.root ? basename(s.root) : ''
  document.title = s.root ? `${basename(s.root)} — ${s.branch || 'echo'}` : 'echo'
  renderTracking()
  const keep = $('#branch-select').value
  const local = new Map((s.local || []).map(b => [b.name, b]))
  $('#branch-select').innerHTML = (s.branches || []).map(b => `<option value="${esc(b)}" ${b === (keep || s.branch) ? 'selected' : ''}>${esc(b)}${counts(local.get(b))}</option>`).join('')
  const staged = [...state.changes.values()].filter(c => c.staged).length
  $('#staged-count').textContent = staged ? `${staged} staged` : 'Nothing staged'
  renderCommit()
  const tr = s.tracking
  $('#sum-branch').innerHTML = `${esc(s.branch || '')}${tr && !tr.gone && (tr.ahead || tr.behind) ? ` <span class="track">${tr.behind ? `<span class="in">↓${tr.behind}</span>` : ''}${tr.ahead ? `<span class="out">↑${tr.ahead}</span>` : ''}</span>` : ''}`
  $('#sum-stash').textContent = (s.stashes || []).length || ''
  $('#stashes').innerHTML = (s.stashes || []).map(x => `<div class="list-row"><span title="${esc(x.subject)}"><b>${esc(x.ref)}</b> ${esc(x.subject)}</span> <button class="btn sm quiet" data-act="show" data-ref="${esc(x.ref)}" title="See what is in this stash">Show</button><button class="btn sm" data-act="apply" data-ref="${esc(x.ref)}">Apply</button><button class="btn sm quiet" data-act="pop" data-ref="${esc(x.ref)}" title="Apply it and drop it">Pop</button><button class="btn sm quiet" data-act="stbranch" data-ref="${esc(x.ref)}" title="Make a branch from this stash">Branch</button><button class="btn sm quiet" data-act="drop" data-ref="${esc(x.ref)}" title="Drop this stash; its changes are only in the reflog afterwards">Drop</button></div>`).join('') || '<div class="list-row muted"><span>No stashes</span></div>'
  // History and the log reload only when HEAD or a ref moved; "contains" answers go stale at the same moment.
  const key = `${s.head || ''}:${s.refsSig || ''}`
  if (key !== state.refsKey) {
    state.refsKey = key
    state.contains.clear()
    T.toolsShown()
    loadHistory()
    if (state.log.loaded) loadLog()
    if (state.mode === 'file') ensureBlame(activeTab())
  }
  renderLogRefs()
  renderBranches()
  if (!$('#branch-pop').hidden) renderBranchPop()
}

// ---------- branches ----------
const ICONS = {
  branch: '<svg class="i ic" viewBox="0 0 16 16"><circle cx="5" cy="3.5" r="1.5"/><circle cx="5" cy="12.5" r="1.5"/><circle cx="11" cy="5.5" r="1.5"/><path d="M5 5v6M11 7c0 2.5-6 2-6 4"/></svg>',
  tag: '<svg class="i ic" viewBox="0 0 16 16"><path d="M2.5 2.5h5l6 6-5 5-6-6z"/><circle cx="5.5" cy="5.5" r="1"/></svg>',
  dir: '<svg class="i ic" viewBox="0 0 16 16"><path d="M2 4.5h4l1.5 1.5H14v6.5H2z"/></svg>',
}

const trackHTML = b => b && !b.gone && (b.ahead || b.behind) ? `<span class="track">${b.behind ? `<span class="in">↓${b.behind}</span>` : ''}${b.ahead ? `<span class="out">↑${b.ahead}</span>` : ''}</span>` : b?.gone ? '<span class="track"><span class="gone">gone</span></span>' : ''

function renderBranches() {
  if (state.rail !== 'branches') return
  const s = state.status || {}, f = $('#file-filter').value.toLowerCase()
  const inLog = state.mode === 'log' ? $('#log-ref').value : ''
  const local = new Map((s.local || []).map(b => [b.name, b]))
  const match = n => !f || n.toLowerCase().includes(f)
  const row = (ref, kind, label, depth, extra = '') => `<div class="tnode bref ${ref === inLog ? 'active' : ''} ${kind === 'local' && ref === s.branch ? 'current' : ''}" data-ref="${esc(ref)}" data-kind="${kind}" style="padding-left:${6 + depth * 14}px" title="${esc(ref)}\nClick to show in the Log"><span class="tw"></span>${kind === 'tag' ? ICONS.tag : ICONS.branch}<span class="nm">${esc(label)}</span>${extra}<button class="bmore" data-more title="Actions" aria-label="Actions for ${esc(ref)}">⋯</button></div>`
  // Names group into folders by their "/" prefixes, as IntelliJ does ("feat/x" sits under "feat").
  const tree = (key, names, kind, depth) => {
    const render = (node, d) => {
      let h = ''
      for (const [n, dir] of [...node.dirs].sort((a, b) => a[0].localeCompare(b[0]))) {
        const open = f || !state.bClosed.has(key + ':' + dir.path)
        h += `<div class="tnode dir" data-bdir="${esc(key + ':' + dir.path)}" style="padding-left:${6 + d * 14}px"><span class="tw">${open ? '▾' : '▸'}</span>${ICONS.dir}<span class="nm">${esc(n)}</span></div>`
        if (open) h += render(dir, d + 1)
      }
      for (const p of node.files) h += row(p, kind, basename(p), d, kind === 'local' ? trackHTML(local.get(p)) : '')
      return h
    }
    return render(buildTree(names.filter(match)), depth)
  }
  const section = (key, title, names, kind) => {
    if (!names.length) return ''
    const open = f || !state.bClosed.has(key)
    const body = tree(key, names, kind, 1)
    if (f && !body) return ''
    return `<div class="tnode dir bsec" data-bdir="${key}"><span class="tw">${open ? '▾' : '▸'}</span><span class="nm">${title}</span><span class="count">${names.length}</span></div>${open ? body : ''}`
  }
  const top = (ref, label) => `<div class="tnode bref ${inLog === ref ? 'active' : ''}" data-ref="${ref}" data-kind="view" style="padding-left:6px"><span class="tw"></span><span class="nm">${label}</span></div>`
  $('#branches').innerHTML = s.git === false ? '<div class="empty">Not a Git repository.</div>'
    : top('all', 'All branches') + top('HEAD', `Current branch${s.branch ? ` <span class="faint">${esc(s.branch)}</span>` : ''}`)
      + section('local', 'Local', (s.local || []).map(b => b.name), 'local')
      + section('remote', 'Remote', s.remote || [], 'remote')
      + section('tags', 'Tags', s.tags || [], 'tag')
}

// refActions lists what a ref's menu offers, IntelliJ-style, relative to the current branch.
function refActions(ref, kind) {
  const s = state.status || {}, cur = s.branch && !s.branch.startsWith('detached@') ? s.branch : ''
  const isCur = kind === 'local' && ref === cur
  const localNames = new Set((s.local || []).map(b => b.name))
  const short = kind === 'remote' ? ref.slice(ref.indexOf('/') + 1) : ref
  const a = []
  if (!isCur) {
    const checkout = kind === 'local' ? { action: 'branch:switch', from: ref }
      : kind === 'remote' ? (localNames.has(short) ? { action: 'branch:switch', from: short } : { action: 'branch:track', from: ref })
      : { action: 'branch:detach', from: ref }
    a.push([kind === 'tag' ? 'Checkout (detached)' : kind === 'remote' && !localNames.has(short) ? `Checkout as ${short}` : 'Checkout', checkout])
  }
  a.push(['New branch from here…', 'new'])
  if (kind === 'local') a.push(['Rename…', 'rename'])
  if (!isCur && cur) {
    a.push([`Merge into ${cur}…`, 'merge'])
    a.push([`Rebase ${cur} onto this`, { action: 'rebase', from: ref }])
    a.push([`Rebase ${cur} onto this interactively…`, 'irebase'])
    a.push(['Cherry-pick its commits…', 'pickrange'])
    a.push([`Compare with ${cur}`, 'compare'])
  }
  a.push(['Show in Log', 'log'])
  if (kind === 'local' && !isCur) a.push(['Delete', 'delete', 'danger'])
  if (kind === 'remote') a.push([`Delete on ${ref.slice(0, ref.indexOf('/'))}…`, 'delete-remote', 'danger'])
  return a
}

let menuFor = null
function openRefMenu(ref, kind, anchor) {
  const acts = refActions(ref, kind)
  menuFor = { ref, kind, acts }
  const m = $('#ref-menu')
  m.innerHTML = `<div class="menu-head" title="${esc(ref)}">${kind === 'tag' ? ICONS.tag : ICONS.branch}<span>${esc(ref)}</span></div>`
    + acts.map(([label, , cls], i) => `<button class="menu-item ${cls || ''}" data-i="${i}" role="menuitem">${esc(label)}</button>`).join('')
  m.hidden = false
  const r = anchor.getBoundingClientRect(), w = m.offsetWidth, h = m.offsetHeight
  const left = r.right + 4 + w < innerWidth ? r.right + 4 : Math.max(8, r.left - w - 4)
  m.style.left = left + 'px'
  m.style.top = Math.max(8, Math.min(r.top, innerHeight - h - 8)) + 'px'
  m.querySelector('.menu-item')?.focus()
}
const closeRefMenu = () => { $('#ref-menu').hidden = true; menuFor = null }

async function runRefAction(i) {
  const { ref, acts } = menuFor
  const [, what] = acts[i]
  closeRefMenu()
  toggleBranchPop(false)
  if (what === 'new') {
    const name = await ask({ title: 'Name the new branch', ok: 'Create', html: `<p class="note">Starts from <b>${esc(ref)}</b>.</p>`, input: { label: 'Branch name', placeholder: 'feature/name' } })
    if (name) await gitAction({ action: 'branch:create', from: name, to: ref })
  } else if (what === 'rename') await G.renameBranch(ref)
  else if (what === 'merge') G.mergeInto(ref)
  else if (what === 'delete') await G.deleteBranch(ref)
  else if (what === 'delete-remote') await G.deleteRemoteBranch(ref)
  else if (what === 'irebase') ctx.rebaseUI?.(ref)
  else if (what === 'pickrange') pickRange(ref)
  else if (what === 'compare') startCompare(state.status.branch, ref)
  else if (what === 'log') {
    await setMode('log')
    setLogRef(ref)
  } else await gitAction(what)
}

// Cherry-pick every commit a branch has that the current one lacks (cur..ref), oldest first.
async function pickRange(ref) {
  const cur = state.status?.branch
  const ok = await ask({ title: `Cherry-pick ${ref}`, kicker: 'new commits', ok: 'Cherry-pick', html: `<p>Applies the commits on <b>${esc(ref)}</b> that <b>${esc(cur)}</b> does not have, as new commits on <b>${esc(cur)}</b>.</p>` })
  if (ok) gitAction({ action: 'cherry-pick', from: `${cur}..${ref}` })
}

// setLogRef filters the Log to one ref; tags are not in the branch list, so they get an option on demand.
function setLogRef(ref) {
  state.log.compare = null
  const sel = $('#log-ref')
  if (![...sel.options].some(o => o.value === ref)) sel.add(new Option(ref, ref))
  sel.value = ref
  loadLog()
  renderBranches()
}

function toggleBranchPop(open = $('#branch-pop').hidden) {
  if (open && state.status?.git === false) return
  $('#branch-pop').hidden = !open
  if (!open) return closeRefMenu()
  toggleThemes(false)
  toggleRepoPop(false)
  $('#branch-filter').value = ''
  renderBranchPop()
  $('#branch-filter').focus()
}

function renderBranchPop() {
  const s = state.status || {}, f = $('#branch-filter').value.toLowerCase()
  const match = n => !f || n.toLowerCase().includes(f)
  const item = (ref, kind, extra = '') => `<div class="th bp-row ${kind === 'local' && ref === s.branch ? 'on' : ''}" data-ref="${esc(ref)}" data-kind="${kind}" title="${esc(ref)}"><span class="ok">${kind === 'local' && ref === s.branch ? '✓' : ''}</span><span class="nm">${esc(ref)}</span>${extra}<span class="go">›</span></div>`
  const sec = (title, rows, more = 0) => rows.length ? `<h5>${title}</h5>${rows.join('')}${more ? `<div class="bp-more faint">${more} more — keep typing</div>` : ''}` : ''
  const local = (s.local || []).filter(b => match(b.name))
  const remote = (s.remote || []).filter(match)
  const tags = (s.tags || []).filter(match)
  $('#branch-list').innerHTML = sec('Local', local.map(b => item(b.name, 'local', trackHTML(b))))
    + sec('Remote', remote.slice(0, 50).map(r => item(r, 'remote')), Math.max(0, remote.length - 50))
    + sec('Tags', tags.slice(0, 30).map(t => item(t, 'tag')), Math.max(0, tags.length - 30))
    || '<div class="bp-more faint">No branch or tag matches.</div>'
}

// ---------- repositories ----------
// Each repository runs in its own echo process on its own port; the server finds its siblings.
let repos = [], repoSel = 0
// Keys: ws:<id> is a repository of this workspace, p:<port> is another echo process.
const hereKey = () => BASE ? 'ws:' + WS_ID : 'p:' + location.port
async function toggleRepoPop(open = $('#repo-pop').hidden) {
  $('#repo-pop').hidden = !open
  $('#repo-pop').classList.toggle('in-ws', !!BASE)
  $('#repo').classList.toggle('open', open)
  if (!open) return
  toggleThemes(false)
  toggleBranchPop(false)
  $('#repo-filter').value = ''
  $('#repo-filter').focus()
  renderRepoPop()
  try {
    // Every repository open in echo: this workspace's own, then the other echo processes (a workspace is one row).
    const procs = (await api(BASE ? '/ws/instances' : '/api/instances')).filter(r => !BASE || r.port !== +location.port)
    const own = BASE ? (await api('/ws/repos')).repos.map(r => ({ key: 'ws:' + r.id, group: 'ws', root: r.root, branch: r.branch, changes: wsChanged(r) })) : []
    repos = own.concat(procs.map(r => ({ ...r, key: 'p:' + r.port, group: 'proc', workspace: !!r.repos })))
  } catch (e) { setStatus(e.message, 'err') }
  // Start on the first other repository, so ⌘⇧O then Enter hops away like an app switcher.
  repoSel = Math.max(0, repos.findIndex(r => r.key !== hereKey()))
  if (!$('#repo-pop').hidden) renderRepoPop()
}

// Every word typed must appear in the repository's name or branch. The folder path is not searched: in a
// workspace it is the same for all of them, so a word from it would match everything.
const repoMatches = () => {
  const words = $('#repo-filter').value.toLowerCase().split(/\s+/).filter(Boolean)
  return repos.filter(r => { const hay = `${basename(r.root)} ${r.branch || ''}`.toLowerCase(); return words.every(w => hay.includes(w)) })
}

function renderRepoPop() {
  const here = hereKey(), list = repoMatches()
  repoSel = Math.min(repoSel, Math.max(0, list.length - 1))
  const row = (r, i) => `<div class="th rp-row ${r.key === here ? 'on' : ''} ${i === repoSel ? 'sel' : ''}" data-key="${esc(r.key)}" data-i="${i}" title="${esc(r.root)}">
    <span class="ok">${r.key === here ? '✓' : ''}</span>
    <span class="rp-main"><span class="nm"><b>${esc(basename(r.root))}</b>${r.workspace ? '<span class="meta">workspace</span>' : r.branch ? `<span class="meta">${esc(r.branch)}</span>` : ''}</span></span>
    <span class="rp-end">${r.changes ? `<span class="rp-n" title="${r.changes} changed files">${r.changes}</span>` : ''}${r.group === 'proc' ? `<span class="port">:${r.port}</span><button class="rp-stop" data-repo-stop="${r.port}" title="Stop this echo process">Stop</button>` : ''}</span></div>`
  // In a workspace the list has two groups; each gets a heading so "outside this workspace" is plain.
  const heads = { ws: 'In this workspace', proc: BASE ? 'Elsewhere' : '' }
  let last = '', html = ''
  list.forEach((r, i) => {
    if (BASE && r.group !== last) html += `<h5 class="rp-h">${heads[r.group]}</h5>`
    last = r.group
    html += row(r, i)
  })
  $('#repo-list').innerHTML = html
    || `<div class="bp-more faint">${repos.length ? 'No open repository matches.' : 'Looking for open repositories…'}</div>`
  $('#repo-list .sel')?.scrollIntoView({ block: 'nearest' })
}

function switchRepo(key, newTab) {
  const url = key.startsWith('ws:') ? `/r/${encodeURIComponent(key.slice(3))}/` : `http://127.0.0.1:${key.slice(2)}/`
  toggleRepoPop(false)
  persistSession(true)
  if (newTab) window.open(url, '_blank')
  else if (key !== hereKey()) location.href = url
}

// stopRepo shuts one echo process down, or every one of them. The request is answered before the
// server stops, so the tab that asked can say so; a tab on the stopped repository keeps its page and
// says the server is gone, like any other lost connection.
async function stopRepo(port, all) {
  const what = all ? 'every echo process' : basename(repos.find(r => r.port === port)?.root || '')
  const ok = await ask({ title: all ? 'Stop every echo process' : `Stop ${what}`, kicker: 'stops echo', tone: 'danger', ok: 'Stop', html: `<p>${all ? 'Every repository open in echo will stop.' : `<b>${esc(what)}</b>’s echo process will stop.`}</p><p class="note">Running work is finished first. Reopen a repository with the <code>echo</code> command in its folder.</p>` })
  if (!ok) return
  try { await post('/api/shutdown', { port: all ? 0 : port, all }) } catch (e) { return setStatus(e.message, 'err') }
  if (all) return setStatus('echo is stopping.', 'ok')
  if (port === +location.port) {
    // This tab's own repository is gone: hop to another open one, or close the tab if none is left.
    const next = repos.find(r => r.port && r.port !== port)
    if (next) return void (location.href = `http://127.0.0.1:${next.port}/`)
    window.close()
    return setStatus('echo stopped. You can close this tab.', 'ok')
  }
  setStatus(`stopped ${what}`, 'ok')
  repos = repos.filter(r => r.port !== port)
  renderRepoPop()
}

// ---------- workspace bar ----------
// In a workspace every repository is a chip: a dot where something changed, and the count. It polls (a stream
// per tab would use up the browser's few connections to this one origin) and only while the tab is visible.
// Settings can turn the bar off; ⌘⇧O still switches.
let wsRepos = []
const wsChanged = r => r.staged + r.unstaged + r.untracked + r.conflicts
const wsBarOn = () => !!BASE && state.config.workspaceBar !== false
// Names that all start the same ("provider-backend", "provider-frontend") are shown without it; the tooltip has the full name.
function wsLabels(names) {
  if (names.length < 3) return names
  let p = names[0]
  for (const n of names) while (!n.startsWith(p)) p = p.slice(0, -1)
  p = p.slice(0, p.lastIndexOf('-') + 1)
  return p.length > 3 && names.every(n => n.length > p.length) ? names.map(n => n.slice(p.length)) : names
}
function renderWsBar() {
  const bar = $('#wsbar')
  bar.hidden = !wsBarOn()
  if (bar.hidden) return
  const first = !bar.firstChild, left = bar.scrollLeft
  const labels = wsLabels(wsRepos.map(r => r.name))
  const chip = (r, i) => {
    const n = wsChanged(r)
    const tip = [r.name, r.branch, r.ahead ? `${r.ahead} to push` : '', r.behind ? `${r.behind} to pull` : '', r.error].filter(Boolean).join(' · ')
    return `<a class="ws-chip ${r.id === WS_ID ? 'on' : ''} ${n ? 'dirty' : ''} ${r.conflicts ? 'conflict' : ''}" href="/r/${encodeURIComponent(r.id)}/" title="${esc(tip)}"><i class="dot"></i><span class="nm">${esc(labels[i])}</span>${n ? `<em>${n}</em>` : ''}</a>`
  }
  bar.innerHTML = `<a class="ws-home" href="/" title="Workspace overview: every repository and every change" aria-label="Workspace overview"><svg class="i" viewBox="0 0 16 16"><rect x="2.5" y="2.5" width="4.5" height="4.5" rx="1"/><rect x="9" y="2.5" width="4.5" height="4.5" rx="1"/><rect x="2.5" y="9" width="4.5" height="4.5" rx="1"/><rect x="9" y="9" width="4.5" height="4.5" rx="1"/></svg></a><span class="ws-chips">${wsRepos.map(chip).join('')}</span><a class="ws-chip files ${WS_ID === '_files' ? 'on' : ''}" href="/r/_files/" title="Files in the workspace folder that are in no repository">Files</a>`
  // The bar keeps where it was scrolled to between polls; the first time it brings this repository into view.
  if (first) bar.querySelector('.ws-chip.on')?.scrollIntoView({ block: 'nearest', inline: 'center' })
  else bar.scrollLeft = left
}
async function pollWsBar(force) {
  if (!wsBarOn() || (document.hidden && force !== true)) return
  try { wsRepos = (await api('/ws/repos')).repos; renderWsBar() } catch {}
}
function applyWsBar() {
  if (!BASE) return
  $('#wsbar').hidden = !wsBarOn()
  if (wsBarOn() && !wsRepos.length) pollWsBar(true)
  else if (wsBarOn()) renderWsBar()
}
function startWsBar() {
  pollWsBar(true)
  setInterval(pollWsBar, 5000)
  document.addEventListener('visibilitychange', () => pollWsBar())
  // The session is saved before the page leaves, which a plain link would not do.
  $('#wsbar').addEventListener('click', e => { if (e.target.closest('a') && !e.metaKey && !e.ctrlKey && !e.shiftKey) persistSession(true) })
}

// ---------- graph ----------
// layoutGraph assigns each commit a lane. lanes[j] is the commit that lane j is heading down to;
// a row records the lanes above it (before), below it (after), which lanes end in its node (into),
// and which lane each parent continues on (out). Lanes are not compacted, so a lane keeps its column.
// Decorations from %D: "HEAD -> main", "origin/main", "tag: v1", or a bare "HEAD" when detached.
function refChips(refs) {
  const local = new Set((state.status?.local || []).map(b => b.name))
  return (refs || []).map(r => {
    if (r.startsWith('HEAD -> ')) return `<span class="chip loc head" title="Current branch">${esc(r.slice(8))}</span>`
    if (r === 'HEAD') return '<span class="chip head" title="Detached HEAD">HEAD</span>'
    if (r.startsWith('tag: ')) return `<span class="chip tag">${esc(r.slice(5))}</span>`
    if (r.endsWith('/HEAD')) return ''
    return `<span class="chip ${local.has(r) ? 'loc' : 'rem'}">${esc(r)}</span>`
  }).join('')
}

// ---------- log ----------
async function loadLog(append = false) {
  const L = state.log
  L.loaded = true
  const params = new URLSearchParams({ ref: $('#log-ref').value || 'all', skip: append ? L.commits.length : 0 })
  for (const [k, id] of [['q', '#log-q'], ['author', '#log-author'], ['path', '#log-path'], ['since', '#log-since'], ['until', '#log-until'], ['merges', '#log-merges']]) {
    const v = $(id).value.trim()
    if (v) params.set(k, v)
  }
  const seq = ++L.seq
  L.loading = true
  renderCompareBar()
  try {
    if (L.compare) {
      // Two lists, each laid out on its own: what b has that a lacks, then the reverse.
      const { a, b } = L.compare
      const side = ref => { const p = new URLSearchParams(params); p.delete('skip'); p.set('limit', '500'); p.set('ref', ref); return api('/api/history?' + p) }
      const [onlyB, onlyA] = await Promise.all([side(`${a}..${b}`), side(`${b}..${a}`)])
      if (seq !== L.seq) return
      L.groups = [{ title: `Only in ${b}`, n: onlyB.commits.length, more: onlyB.more }, { title: `Only in ${a}`, n: onlyA.commits.length, more: onlyA.more }]
      L.commits = onlyB.commits.concat(onlyA.commits)
      L.rows = layoutGraph(onlyB.commits).concat(layoutGraph(onlyA.commits))
      L.more = false
      $('#log-rows').scrollTop = 0
      return renderLog()
    }
    L.groups = null
    $('#log-more-n').textContent = logFilterCount() || ''
    const data = await api('/api/history?' + params)
    if (seq !== L.seq) return
    L.commits = append ? L.commits.concat(data.commits) : data.commits
    L.more = data.more
    L.rows = layoutGraph(L.commits)
    if (!append) $('#log-rows').scrollTop = 0
    renderLog()
  } catch (e) {
    if (seq === L.seq) $('#log-rows').innerHTML = `<div class="empty"><b>Can’t load the log</b><span>${esc(e.message)}</span></div>`
  } finally { if (seq === L.seq) L.loading = false }
}

function renderLog() {
  const L = state.log, w = graphWidth(L.rows), view = $('#log-rows')
  $('#log-summary').textContent = L.commits.length ? `${L.commits.length}${L.more ? '+' : ''} commits` : ''
  if (!L.commits.length && !L.groups) {
    view.innerHTML = '<div class="empty"><b>No commits match</b><span>Clear a filter to see more history.</span></div>'
    $('#log-detail').innerHTML = ''
    return
  }
  const top = view.scrollTop
  const rowsHTML = (from, to) => L.commits.slice(from, to).map((c, k) => { const i = from + k; return `<div class="lrow ${c.hash === L.sel ? 'sel' : ''}${c.unpushed ? ' unpushed' : ''}" data-hash="${esc(c.hash)}">${graphSVG(L.rows[i], LOG_H, w)}<span class="lsub" title="${esc(c.subject)}">${pushMark(c)}${refChips(c.refs)}<span class="ltext">${esc(c.subject)}</span></span><span class="lauth">${esc(c.author)}</span><span class="ltime" title="${esc(new Date(c.time * 1000).toLocaleString())}">${ago(c.time)}</span></div>` }).join('')
  const head = g => `<div class="lgroup">${esc(g.title)}<span class="faint">${g.n}${g.more ? '+' : ''} commit${g.n === 1 ? '' : 's'}</span></div>${g.n ? '' : '<div class="lmore faint">Nothing — the other side already has all of it.</div>'}`
  view.innerHTML = L.groups ? head(L.groups[0]) + rowsHTML(0, L.groups[0].n) + head(L.groups[1]) + rowsHTML(L.groups[0].n)
    : rowsHTML(0) + (L.more ? '<div class="lmore faint">Loading more…</div>' : '')
  view.scrollTop = top
  if (L.commits.some(c => c.hash === L.sel)) paintLogDetail()
  else if (L.commits.length) selectLog(L.commits[0].hash)
  else { L.sel = ''; $('#log-detail').innerHTML = '' }
}

function selectLog(hash, scroll = false) {
  state.log.sel = hash
  $('#log-rows .lrow.sel')?.classList.remove('sel')
  const row = $(`#log-rows .lrow[data-hash="${CSS.escape(hash)}"]`)
  row?.classList.add('sel')
  if (scroll) row?.scrollIntoView({ block: 'nearest' })
  paintLogDetail()
  $('#log-detail').scrollTop = 0
  loadDetail(hash)
}

function stepLog(dir) {
  const L = state.log
  const i = Math.min(L.commits.length - 1, Math.max(0, L.commits.findIndex(c => c.hash === L.sel) + dir))
  if (L.commits[i]) selectLog(L.commits[i].hash, true)
}

function paintLogDetail() {
  const c = state.log.commits.find(c => c.hash === state.log.sel)
  $('#log-detail').innerHTML = c ? `<div class="ld-head"><div class="ld-subject">${esc(c.subject)}</div><button class="btn sm" data-diff title="Show this commit's diff in Review (Esc comes back)">View diff</button></div>
    <div class="ld-refs">${refChips(c.refs)}</div><div class="ld-body">${detailHTML(c.hash)}</div>` : ''
}

// While a commit's diff from the Log is on screen, the Log's commits move to the left nav, so another
// commit is one click away and the diff gets the room. Same rows as History: click expands, a file opens its diff.
function renderLogSide() {
  const L = state.log, w = graphWidth(L.rows), view = $('#log-side')
  view.innerHTML = L.commits.map((c, i) => `<div class="commit-row ${c.hash === L.sel ? 'open' : ''}${c.unpushed ? ' unpushed' : ''}" data-hash="${esc(c.hash)}" data-short="${esc(c.short)}" title="${esc(c.subject)}">
      <span class="c-graph">${graphSVG(L.rows[i], HIST_H, w)}</span>
      <div class="c-main"><div class="c-subject">${refChips(c.refs)}${esc(c.subject)}</div>
      <div class="c-meta">${pushMark(c)}<b>${esc(c.short)}</b><span class="c-author">${esc(c.author)}</span><span class="c-time">${ago(c.time)}</span></div></div>
    </div>${c.hash === L.sel ? `<div class="c-detail"><span class="c-graph" style="width:${w}px">${railSVG(L.rows[i].after, w)}</span><div class="c-dbody">${detailHTML(c.hash)}</div></div>` : ''}`).join('')
  view.querySelector('.commit-row.open')?.scrollIntoView({ block: 'nearest' })
}
const showLogSide = () => { if (state.log.commits.length) setRail('logside') }

function openLogDiff() {
  const c = state.log.commits.find(c => c.hash === state.log.sel)
  if (!c) return
  state.fromLog = true
  const path = $('#log-path').value.trim()
  const shown = path ? goCommitFile(c.hash, path) : showCommitDiff(c.hash, c.short)
  shown.then(() => { state.fromLog = true; showLogSide(); setStatus('Esc returns to the log') })
}

function renderLogRefs() {
  const s = state.status || {}, sel = $('#log-ref')
  const remotes = new Set(s.remotes || [])
  const names = (s.branches || []).filter(b => !remotes.has(b) && !b.endsWith('/HEAD'))
  const key = names.join('\n')
  if (sel.dataset.key === key) return
  sel.dataset.key = key
  const keep = sel.value || 'all'
  sel.innerHTML = `<option value="all">All branches</option><option value="HEAD">Current branch</option>${names.length ? `<optgroup label="Branch">${names.map(b => `<option value="${esc(b)}">${esc(b)}</option>`).join('')}</optgroup>` : ''}`
  sel.value = [...sel.options].some(o => o.value === keep) ? keep : 'all'
}

async function loadHistory() {
  const H = state.hist
  if (state.status && !state.status.git) return
  clearTimeout(H.retry)
  const seq = ++H.seq
  try {
    const data = await api('/api/history?ref=HEAD&limit=100')
    if (seq !== H.seq) return
    H.commits = data.commits
    H.rows = layoutGraph(data.commits)
    H.error = ''
  } catch (e) {
    if (seq !== H.seq) return
    // History only reloads when a ref moves, so a failed load (say, echo restarting) must retry on its own.
    // The last good list stays on screen meanwhile.
    H.error = e.message
    H.retry = setTimeout(loadHistory, 3000)
  }
  renderHistory()
}

// ---------- history ----------
// Whether a commit is on a remote: an amber ↑ for one that only exists locally, a quiet ✓ for one that is
// pushed. Nothing is drawn for a repository with no remote, since nothing could have been pushed.
function pushMark(c) {
  if (!state.status?.remotes?.length) return ''
  return c.unpushed
    ? '<span class="pm up" title="Not pushed: no remote branch has this commit yet">↑</span>'
    : '<span class="pm ok" title="Pushed: a remote branch has this commit">✓</span>'
}

function renderHistory() {
  const { commits, rows } = state.hist, w = graphWidth(rows)
  $('#history').innerHTML = commits.map((c, i) => `<div class="commit-row ${c.hash === state.expanded ? 'open' : ''}${c.unpushed ? ' unpushed' : ''}" data-hash="${esc(c.hash)}" data-short="${esc(c.short)}" title="${esc(c.subject)}\nClick to expand. Click a file in it to see its diff.">
      <span class="c-graph">${graphSVG(rows[i], HIST_H, w)}</span>
      <div class="c-main"><div class="c-subject">${refChips(c.refs)}${esc(c.subject)}</div>
      <div class="c-meta">${pushMark(c)}<b>${esc(c.short)}</b><span class="c-author">${esc(c.author)}</span><span class="c-time" title="${esc(new Date(c.time * 1000).toLocaleString())}">${ago(c.time)}</span></div></div>
    </div>${c.hash === state.expanded ? `<div class="c-detail"><span class="c-graph" style="width:${w}px">${railSVG(rows[i].after, w)}</span><div class="c-dbody">${detailHTML(c.hash)}</div></div>` : ''}`).join('')
    || `<div class="list-row muted"><span>${state.hist.error ? `Couldn’t load history (${esc(state.hist.error)}). Retrying…` : 'No commits yet'}</span></div>`
  renderHistoryCurrent()
}

function detailHTML(hash) {
  const d = state.details.get(hash)
  if (!d) return '<div class="faint">Loading…</div>'
  if (d.error) return `<div class="err">${esc(d.error)}</div>`
  const when = t => `<span title="${esc(new Date(t * 1000).toLocaleString())}">${ago(t)}</span>`
  const by = d.committer && d.committer !== d.author ? ` · committed by ${esc(d.committer)} ${when(d.commitTime)}` : ''
  const parents = d.parents.map(p => `<button class="c-link mono" data-go="${esc(p)}" title="Show parent ${esc(p)}">${esc(p.slice(0, 7))}</button>`).join(' ')
  return `${d.body ? `<div class="c-body">${esc(d.body)}</div>` : ''}
    <div class="c-line"><span title="${esc(d.authorEmail)}">${esc(d.author)}</span> ${when(d.authorTime)}${by}</div>
    <div class="c-line mono"><span class="c-hash">${esc(d.hash)}</span><button class="btn quiet sm c-copy" data-copy="${esc(d.hash)}" title="Copy the full commit id">Copy</button></div>
    ${parents ? `<div class="c-line">${d.parents.length > 1 ? 'Parents' : 'Parent'} ${parents}</div>` : '<div class="c-line faint">Root commit</div>'}
    <div class="c-line c-acts">
      <button class="btn sm" data-act="reset" ${d.hash === state.status?.head ? 'disabled' : ''} title="${d.hash === state.status?.head ? 'The branch is already at this commit; pick an older one to reset to' : 'Move the current branch back to this commit (soft, mixed or hard)'}">Reset…</button>
      <button class="btn sm" data-act="revert" title="Add a new commit that undoes this one">Revert</button>
      <button class="btn sm" data-act="pick" title="Apply this commit's changes on the current branch">Cherry-pick</button>
      <button class="btn sm" data-act="branch" title="Start a new branch at this commit">New branch…</button>
      <button class="btn sm quiet" data-act="irebase" title="Reorder, squash, reword or drop the commits from here to HEAD">Rebase from here…</button>
    </div>
    <div class="c-line c-refs">${containsHTML(hash)}</div>
    <div class="c-files-head">${d.files.length} file${d.files.length === 1 ? '' : 's'} changed${d.parents.length > 1 ? ' <span class="faint">vs first parent</span>' : ''}</div>
    <div class="c-files">${commitTreeHTML(d)}</div>`
}

function containsHTML(hash) {
  const c = state.contains.get(hash)
  if (!c) return '<span class="faint">Finding branches…</span>'
  if (c.error) return `<span class="faint">Branches unavailable</span>`
  const chip = (cls, n) => `<span class="chip ${cls}">${esc(n)}</span>`
  const n = c.branches.length + c.remotes.length
  const chips = [...c.branches.map(b => chip('loc', b)), ...c.remotes.map(b => chip('rem', b)), ...c.tags.map(t => chip('tag', t))]
  const shown = chips.slice(0, 12).join('') + (chips.length > 12 ? `<span class="faint">+${chips.length - 12} more</span>` : '')
  return n || c.tags.length ? `<span class="faint">In ${n} branch${n === 1 ? '' : 'es'}</span> ${shown}` : '<span class="faint">Not on any branch</span>'
}

function commitTreeHTML(d) {
  const files = new Map(d.files.map(f => [f.path, f]))
  const render = (node, depth) => {
    let h = ''
    for (const [n, dir] of [...node.dirs].sort((a, b) => a[0].localeCompare(b[0]))) {
      // Chains of single-child folders collapse into one row ("web/static/js"), as IntelliJ does.
      let label = n, cur = dir
      while (cur.files.length === 0 && cur.dirs.size === 1) { const [[cn, cd]] = cur.dirs; label += '/' + cn; cur = cd }
      const open = !state.cdirClosed.has(d.hash + ':' + cur.path)
      h += `<div class="tnode dir" data-cdir="${esc(cur.path)}" style="padding-left:${depth * 14}px"><span class="tw">${open ? '▾' : '▸'}</span><span class="nm">${esc(label)}</span></div>`
      if (open) h += render(cur, depth + 1)
    }
    for (const p of node.files) {
      const f = files.get(p)
      h += `<div class="tnode" data-cfile="${esc(p)}" style="padding-left:${depth * 14}px" title="${esc(p)}\nShow this file in the commit diff"><span class="tw"></span>${badge(f.code)}<span class="nm">${esc(basename(p))}</span><span class="stat">${statHTML(f)}</span></div>`
    }
    return h
  }
  return render(buildTree(d.files.map(f => f.path)), 0) || '<div class="faint">No file changes</div>'
}

async function loadDetail(hash) {
  const jobs = []
  if (!state.details.has(hash)) jobs.push(api('/api/commit?hash=' + encodeURIComponent(hash)).then(d => state.details.set(hash, d), e => state.details.set(hash, { error: e.message })))
  if (!state.contains.has(hash)) jobs.push(api('/api/commit/contains?hash=' + encodeURIComponent(hash)).then(c => state.contains.set(hash, c), e => state.contains.set(hash, { error: e.message })))
  // Details and branches arrive separately; repaint as each lands so a slow --contains never blocks the files.
  for (const j of jobs) j.then(() => paintDetail(hash))
  await Promise.all(jobs)
}

function paintDetail(hash) {
  const el = $(`#history .commit-row[data-hash="${CSS.escape(hash)}"] + .c-detail .c-dbody`)
  if (el) el.innerHTML = detailHTML(hash)
  const side = $(`#log-side .commit-row[data-hash="${CSS.escape(hash)}"] + .c-detail .c-dbody`)
  if (side) side.innerHTML = detailHTML(hash)
  if (state.log.sel === hash) paintLogDetail()
}

// Opening a commit shows its diff in Review; clicking the open row again folds it.
function selectCommit(hash, short = hash.slice(0, 7)) {
  state.expanded = state.expanded === hash ? '' : hash
  renderHistory()
  if (state.expanded) loadDetail(hash)
  $(`#history .commit-row[data-hash="${CSS.escape(hash)}"]`)?.scrollIntoView({ block: 'nearest' })
  // Expanding a commit only shows its details; the diff opens when one of its files is clicked.
}

async function showCommitDiff(hash, short) {
  const same = scope() === 'commit' && state.commit === hash && state.mode === 'diff'
  state.commit = hash
  $('#diff-scope').value = 'commit'
  $('#diff-commit').value = short
  syncScopeInputs()
  state.commit = hash
  renderHistoryCurrent()
  await setMode('diff')
  if (same) return
  $('#diff').scrollTop = 0
  await loadDiff()
}

async function goCommitFile(hash, path) {
  await showCommitDiff(hash, hash.slice(0, 7))
  const i = state.diffFiles.findIndex(f => f.path === path)
  if (i < 0) return setStatus(`${path} has no text diff in this commit`)
  if (isFolded(state.diffFiles[i])) { state.folded.set(path, false); rerenderFile(i) }
  goFile(i)
}

// Counts are against the upstream as of the last fetch, so the Fetch button carries its age.
function renderTracking() {
  const s = state.status || {}, t = s.tracking
  const remote = (s.remotes || []).length > 0
  $('#fetch').hidden = true
  $('#sync-more').hidden = !remote
  $('#sync').hidden = !remote || !t
  $('#fetched').textContent = s.fetchedAt ? ago(s.fetchedAt) : 'never'
  $('#fetch').title = `Fetch all remotes (git fetch --all --prune)\nLast fetched: ${s.fetchedAt ? new Date(s.fetchedAt * 1000).toLocaleString() : 'never'}`
  const tracked = !!(t && t.upstream && !t.gone)
  // Only non-zero directions are shown; an up-to-date branch shows nothing.
  $('#track').hidden = !t?.upstream || (!t.gone && !t.ahead && !t.behind)
  if (!$('#track').hidden) {
    $('#track').innerHTML = t.gone ? '<span class="gone">upstream gone</span>'
      : (t.behind ? `<span class="in">↓${t.behind}</span>` : '') + (t.ahead ? `<span class="out">↑${t.ahead}</span>` : '')
    $('#track').title = t.gone ? `${t.upstream} was deleted on the remote` : `${t.behind} incoming, ${t.ahead} outgoing vs ${t.upstream} (as of the last fetch)`
  }
  // A branch with no upstream has nothing to pull: the panel offers Publish Branch, which is also its push.
  const fresh = remote && !tracked
  $('#pull-label').textContent = fresh ? 'Publish Branch' : 'Pull'
  $('#pull').title = fresh ? `Push ${t?.name || s.branch || 'this branch'} and set its upstream (git push -u)` : 'git pull'
  $('#pull').classList.toggle('primary', fresh)
  document.querySelector('.push-split').hidden = fresh
  $('#pull-more').hidden = fresh
  $('#sync-label').textContent = tracked ? (t.ahead || t.behind ? `Sync ${t.behind ? t.behind + '↓' : ''}${t.ahead ? t.ahead + '↑' : ''}` : 'Sync') : 'Publish'
  $('#sync').title = tracked ? `Pull${t.behind ? ` ${t.behind}` : ''}, then push${t.ahead ? ` ${t.ahead}` : ' if ahead'} (${t.upstream})` : `Push ${t?.name || 'this branch'} and set its upstream (git push -u)`
  $('#sync').classList.toggle('attn', tracked && (t.ahead > 0 || t.behind > 0))
  $('#rail-out').hidden = !(tracked && t.ahead > 0)
  $('#rail-out').textContent = t?.ahead || ''
  $('#rail-out').parentElement.title = tracked && t.ahead ? `History · ${plural(t.ahead, 'commit')} to push` : 'History'
}

function counts(b) {
  if (!b || !b.upstream) return ''
  if (b.gone) return '  (gone)'
  return (b.behind ? `  ↓${b.behind}` : '') + (b.ahead ? `  ↑${b.ahead}` : '')
}

// ---------- blame ----------
const blameInline = () => state.config.blame !== 'off'
const uncommitted = c => !c.hash.replace(/0/g, '')
// Blame is for the text in the editor; once you type, it is stale until the next fetch lands.
const freshBlame = tab => tab?.blame && tab.blame.content === tab.content && tab.blame.key === state.refsKey ? tab.blame.data : null

async function ensureBlame(tab) {
  if (!tab || tab.binary || !state.status?.git || (!blameInline() && !state.blameGutter) || freshBlame(tab)) return
  const content = tab.content, key = state.refsKey, seq = tab.blameSeq = (tab.blameSeq || 0) + 1
  try {
    const data = await post('/api/blame', { path: tab.path, content: tab.eol === '\r\n' ? content.replace(/\n/g, '\r\n') : content })
    if (seq !== tab.blameSeq) return
    tab.blame = { content, key, data }
  } catch { return }
  if (tab === activeTab()) { paintGutter(); paintBlameGhost() }
}

let charWidth = 0
function paintBlameGhost() {
  const g = $('#blame-ghost'), ed = $('#editor'), tab = activeTab()
  const b = state.mode === 'file' && blameInline() && ed.classList.contains('active') && freshBlame(tab)
  if (!b) { g.hidden = true; return }
  const text = ed.value, pos = ed.selectionEnd
  let line = 1
  for (let k = text.indexOf('\n'); k >= 0 && k < pos; k = text.indexOf('\n', k + 1)) line++
  const c = b.commits[b.lines[line - 1]]
  const top = lineTopAt(tab, line - 1) - ed.scrollTop
  if (!c || top < 0 || top > ed.clientHeight - LINE) { g.hidden = true; return }
  const start = text.lastIndexOf('\n', pos - 1) + 1, nl = text.indexOf('\n', pos)
  const cols = [...text.slice(start, nl < 0 ? undefined : nl)].reduce((n, ch) => ch === '\t' ? n + 4 - n % 4 : n + 1, 0)
  if (!charWidth) { const cx = document.createElement('canvas').getContext('2d'); cx.font = getComputedStyle(ed).font; charWidth = cx.measureText('0000000000').width / 10 }
  g.textContent = uncommitted(c) ? 'You · not committed yet' : `${c.author}, ${ago(c.time)} · ${c.summary}`
  // A wrapped line puts the caret somewhere inside the block, so its place is measured, not counted.
  const spot = state.wrap ? caretSpot(tab, line - 1, pos - start) : { x: cols * charWidth, y: 0 }
  g.style.left = parseFloat(getComputedStyle(ed).paddingLeft) + spot.x + 36 - ed.scrollLeft + 'px'
  g.style.top = top + spot.y + 'px'
  g.hidden = false
}

// showCommitInLog opens the Log on exactly one commit, the way pasting its hash into search does.
async function showCommitInLog(hash) {
  state.log.compare = null
  $('#log-q').value = hash.slice(0, 12)
  $('#log-author').value = ''; $('#log-path').value = ''
  await setMode('log')
  loadLog()
}

async function openFileHistory(path) {
  state.log.compare = null
  $('#log-q').value = ''; $('#log-author').value = ''
  $('#log-path').value = path
  $('#log-ref').value = 'HEAD'
  await setMode('log')
  loadLog()
  setStatus(`History of ${path} on the current branch`)
}

// ---------- compare ----------
// Comparing a with b lists what each side has that the other lacks, like IntelliJ's "Compare with".
async function startCompare(a, b) {
  state.log.compare = { a, b }
  $('#log-q').value = ''; $('#log-author').value = ''; $('#log-path').value = ''
  await setMode('log')
  loadLog()
}

function renderCompareBar() {
  const c = state.log.compare
  $('#log-compare').hidden = !c
  $('#log-ref').hidden = !!c
  if (c) $('#log-compare').innerHTML = `<span class="faint">Compare</span><b title="${esc(c.a)}">${esc(c.a)}</b><button class="btn quiet sm" data-cmp="swap" title="Swap the two sides">⇄</button><b title="${esc(c.b)}">${esc(c.b)}</b>
    <button class="btn sm" data-cmp="diff" title="Files ${esc(c.b)} changed since it forked from ${esc(c.a)} (${esc(c.a)}...${esc(c.b)})">Files changed</button><button class="btn quiet sm" data-cmp="close" title="Stop comparing">×</button>`
}

async function openCompareDiff() {
  const { a, b } = state.log.compare
  $('#diff-scope').value = 'range'
  $('#diff-from').value = a
  $('#diff-to').value = b
  setRangeDots('...')
  syncScopeInputs()
  state.fromLog = true
  await setMode('diff')
  $('#diff').scrollTop = 0
  await loadDiff()
  setStatus(`Files changed on ${b} since it forked from ${a} — Esc returns to the comparison`)
}

function setRangeDots(d) {
  state.rangeDots = d
  $('#range-dots').textContent = d
}

// The async Clipboard API can be denied (embedded browsers, permissions); the textarea path still works on a click.
async function copyText(text) {
  try { return await navigator.clipboard.writeText(text) } catch {}
  const ta = Object.assign(document.createElement('textarea'), { value: text })
  ta.style.cssText = 'position:fixed;opacity:0'
  document.body.appendChild(ta)
  ta.select()
  const ok = document.execCommand('copy')
  ta.remove()
  if (!ok) throw new Error('the browser blocked clipboard access')
}

function ago(unix) {
  const s = Date.now() / 1000 - unix
  const [n, u] = s < 60 ? [0, ''] : s < 3600 ? [s / 60, 'm'] : s < 86400 ? [s / 3600, 'h'] : s < 2592000 ? [s / 86400, 'd'] : s < 31536000 ? [s / 2592000, 'mo'] : [s / 31536000, 'y']
  return u ? `${Math.floor(n)}${u} ago` : 'just now'
}

function renderHistoryCurrent() {
  document.querySelectorAll('.commit-row').forEach(r => r.classList.toggle('current', r.dataset.hash === state.commit))
}

// A short-lived card with a link: the link is shown, copyable, and opens in a new tab. Hovering keeps it.
let toastTimer = 0
function showToast(title, link) {
  const t = $('#toast')
  t.innerHTML = `<div class="toast-body"><b>${esc(title)}</b><a class="toast-url" href="${esc(link)}" target="_blank" rel="noopener" title="${esc(link)}">${esc(link)}</a></div>`
    + `<button class="btn quiet sm" data-toast="copy" title="Copy the pull request URL">Copy</button>`
    + `<button class="btn quiet icon" data-toast="open" title="Open in a new tab"><svg class="i" viewBox="0 0 16 16"><path d="M9 2.5h4.5V7M13.5 2.5 7.5 8.5M12 9.5v3a1 1 0 0 1-1 1H3.5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h3"/></svg></button>`
    + `<button class="btn quiet icon" data-toast="close" title="Dismiss">✕</button>`
  t.dataset.link = link
  t.hidden = false
  const arm = () => { clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true }, 12000) }
  t.onmouseenter = () => clearTimeout(toastTimer)
  t.onmouseleave = arm
  arm()
}
$('#toast').addEventListener('click', e => {
  const b = e.target.closest('[data-toast]'), t = $('#toast')
  if (!b) return
  if (b.dataset.toast === 'copy') copyText(t.dataset.link).then(() => { b.textContent = 'Copied' }, err => setStatus('Could not copy: ' + err.message, 'err'))
  else if (b.dataset.toast === 'open') window.open(t.dataset.link, '_blank', 'noopener')
  else { clearTimeout(toastTimer); t.hidden = true }
})

const NET = new Set(['fetch', 'pull', 'push', 'push:lease', 'push:force', 'sync', 'publish', 'branch:delete:remote', 'submodule:update'])

async function gitAction(body, button) {
  const net = NET.has(body.action)
  if (net) { document.body.classList.add('net-busy'); button?.classList.add('busy') }
  try {
    setStatus(`git ${body.action}…`)
    const out = await post('/api/git', body)
    // Remote output leads with "To <url>" or progress lines; say what happened and keep Git's text in the tooltip.
    const done = { fetch: 'Fetched all remotes', pull: 'Pulled', push: 'Pushed', 'push:lease': 'Force pushed (with lease)', 'push:force': 'Force pushed', sync: 'Synced', publish: 'Published' }[body.action]
    setStatus(done ? `${done}\n${out.output || ''}` : out.output || `git ${body.action} done`, 'ok')
    G.showOutput(body.action, out.output, true)
    if (out.pr) showToast('Branch published', out.pr)
    if (['commit', 'commit:all', 'amend'].includes(body.action)) { $('#commit-message').value = ''; G.fillTemplate(); $('#commit-message').dispatchEvent(new Event('input')) }
  } catch (e) { setStatus(e.message, 'err'); G.showOutput(body.action, e.message, false) }
  finally { if (net) { document.body.classList.remove('net-busy'); button?.classList.remove('busy') } }
  await refreshAll()
}

// ---------- palette ----------
// Subsequence match; consecutive letters and letters at word starts score higher.
function fuzzy(q, s) {
  const lower = s.toLowerCase()
  const hits = []
  let score = 0, from = 0, prev = -2
  for (const ch of q) {
    const at = lower.indexOf(ch, from)
    if (at < 0) return null
    score += 1 + (at === prev + 1 ? 4 : 0) + (at === 0 || '/-_. '.includes(s[at - 1]) ? 3 : 0)
    hits.push(at); prev = at; from = at + 1
  }
  if (hits[0] > s.lastIndexOf('/')) score += 6
  return { score: score - s.length * 0.02, hits }
}

function highlightHits(s, hits) {
  const set = new Set(hits)
  return [...s].map((ch, i) => set.has(i) ? `<mark>${esc(ch)}</mark>` : esc(ch)).join('')
}

async function openPalette(initial = '') {
  await ensureTree()
  $('#palette').hidden = false
  $('#palette-input').value = initial
  renderPalette()
  $('#palette-input').focus()
}

function renderPalette() {
  const raw = $('#palette-input').value
  $('#palette-input').placeholder = raw.startsWith('>') ? 'Run a command…' : 'Go to file…  (type > for commands)'
  if (raw.startsWith('>')) {
    const q = raw.slice(1).trim().toLowerCase().replace(/\s+/g, '')
    const items = commands().map(c => { if (!q) return { cmd: c, hits: [], score: 0 }; const m = fuzzy(q, c.title); return m && { cmd: c, hits: m.hits, score: m.score } }).filter(Boolean).sort((a, b) => b.score - a.score).slice(0, 60)
    state.palette = { items, sel: 0 }
    return paintPalette()
  }
  const q = raw.trim().toLowerCase().replace(/\s+/g, '')
  const paths = [...new Set([...state.changes.keys(), ...state.tree.map(f => f.path)])]
  let items
  if (!q) {
    // Nothing typed: the files you were just in come first.
    const recent = state.recent.filter(p => paths.includes(p)), rest = paths.filter(p => !recent.includes(p))
    items = [...recent.map(p => ({ p, hits: [], recent: true })), ...rest.map(p => ({ p, hits: [] }))].slice(0, 60)
  } else items = paths.map(p => { const m = fuzzy(q, p); return m && { p, hits: m.hits, score: m.score + (state.changes.has(p) ? 2 : 0) + (state.recent.includes(p) ? 1.5 : 0) } }).filter(Boolean).sort((a, b) => b.score - a.score).slice(0, 60)
  state.palette = { items, sel: 0 }
  paintPalette()
}

function paintPalette() {
  const { items, sel } = state.palette
  $('#palette-list').innerHTML = items.map((it, i) => {
    if (it.cmd) return `<div class="pitem cmd ${i === sel ? 'sel' : ''}" data-i="${i}"><span>${highlightHits(it.cmd.title, it.hits)}</span><i>${esc(it.cmd.group)}</i>${it.cmd.kbd ? `<kbd>${esc(it.cmd.kbd)}</kbd>` : ''}</div>`
    const c = state.changes.get(it.p)
    const cut = it.p.lastIndexOf('/') + 1
    const name = highlightHits(it.p.slice(cut), it.hits.filter(h => h >= cut).map(h => h - cut))
    const dir = highlightHits(it.p.slice(0, cut), it.hits.filter(h => h < cut))
    return `<div class="pitem ${i === sel ? 'sel' : ''}" data-i="${i}"><span>${name}</span><i>${dir}</i>${it.recent ? '<em class="recent-tag">recent</em>' : ''}${c ? codeTag(c) : ''}</div>`
  }).join('') || '<div class="empty">No match.</div>'
  $('#palette-list .sel')?.scrollIntoView({ block: 'nearest' })
}

function choosePalette(i) {
  const it = state.palette.items[i]
  if (!it) return
  $('#palette').hidden = true
  if (it.cmd) return void setTimeout(() => it.cmd.run(), 0)
  if (state.tree.some(f => f.path === it.p)) openFile(it.p)
  else goTo(it.p)
}

// ---------- themes ----------
// Ids match the [data-theme] blocks in themes.css. "system" follows macOS: echo paper when light, echo ink when dark.
const THEMES = [
  ['echo-paper', 'echo paper', 'light', 'echo'], ['ayu-light', 'Ayu Light', 'light', 'Ayu'], ['catppuccin-latte', 'Catppuccin Latte', 'light', 'Catppuccin'],
  ['everforest-light', 'Everforest Light', 'light', 'Everforest'], ['github-light', 'GitHub Light', 'light', 'Primer'], ['gruvbox-light', 'Gruvbox Light', 'light', 'Gruvbox'],
  ['kanagawa-lotus', 'Kanagawa Lotus', 'light', 'Kanagawa'], ['light-owl', 'Light Owl', 'light', 'Night Owl'], ['one-light', 'One Light', 'light', 'Atom'],
  ['rose-pine-dawn', 'Rosé Pine Dawn', 'light', 'Rosé Pine'], ['solarized-light', 'Solarized Light', 'light', 'Solarized'], ['tokyo-night-day', 'Tokyo Night Day', 'light', 'Tokyo Night'],
  ['echo-ink', 'echo ink', 'dark', 'echo'], ['ayu-dark', 'Ayu Dark', 'dark', 'Ayu'], ['ayu-mirage', 'Ayu Mirage', 'dark', 'Ayu'],
  ['catppuccin-frappe', 'Catppuccin Frappé', 'dark', 'Catppuccin'], ['catppuccin-macchiato', 'Catppuccin Macchiato', 'dark', 'Catppuccin'], ['catppuccin-mocha', 'Catppuccin Mocha', 'dark', 'Catppuccin'],
  ['dracula', 'Dracula', 'dark', 'Dracula'], ['everforest-dark', 'Everforest Dark', 'dark', 'Everforest'], ['github-dark', 'GitHub Dark', 'dark', 'Primer'],
  ['github-dark-dimmed', 'GitHub Dark Dimmed', 'dark', 'Primer'], ['gruvbox-dark', 'Gruvbox Dark', 'dark', 'Gruvbox'], ['kanagawa-wave', 'Kanagawa Wave', 'dark', 'Kanagawa'],
  ['night-owl', 'Night Owl', 'dark', 'Night Owl'], ['nord', 'Nord', 'dark', 'Nord'], ['one-dark', 'One Dark', 'dark', 'Atom'],
  ['poimandres', 'Poimandres', 'dark', 'Poimandres'], ['rose-pine', 'Rosé Pine', 'dark', 'Rosé Pine'], ['rose-pine-moon', 'Rosé Pine Moon', 'dark', 'Rosé Pine'],
  ['solarized-dark', 'Solarized Dark', 'dark', 'Solarized'], ['tokyo-night', 'Tokyo Night', 'dark', 'Tokyo Night'],
]
const osLight = matchMedia('(prefers-color-scheme: light)')
const themeId = () => THEMES.some(t => t[0] === state.config.theme) ? state.config.theme : 'system'

function applyTheme() {
  const id = themeId()
  document.documentElement.dataset.theme = id === 'system' ? (osLight.matches ? 'echo-paper' : 'echo-ink') : id
  try { localStorage.setItem('echo:theme', id) } catch {}
  // Diagrams bake their colors in, so they are drawn again in the new theme.
  if (diagrams.size) repaintDiagrams()
}

const swatches = new Map()
function swatchHTML(id) {
  if (!swatches.has(id)) {
    const probe = document.createElement('div')
    probe.dataset.theme = id
    document.body.appendChild(probe)
    const cs = getComputedStyle(probe)
    swatches.set(id, ['--surface', '--fg', '--accent', '--add', '--del'].map(v => `<i style="background:${cs.getPropertyValue(v)}"></i>`).join(''))
    probe.remove()
  }
  return `<span class="swatch">${swatches.get(id)}</span>`
}

// themeSel is the highlighted row. Moving it previews that theme; Escape puts the saved one back.
let themeSel = 0
function previewTheme() {
  const rows = [...document.querySelectorAll('#theme-list .th')]
  themeSel = Math.max(0, Math.min(themeSel, rows.length - 1))
  rows.forEach((r, i) => r.classList.toggle('sel', i === themeSel))
  const id = rows[themeSel]?.dataset.themeId
  if (!id) return
  document.documentElement.dataset.theme = id === 'system' ? (osLight.matches ? 'echo-paper' : 'echo-ink') : id
  rows[themeSel].scrollIntoView({ block: 'nearest' })
}

function renderThemes() {
  const q = $('#theme-filter').value.trim().toLowerCase()
  const cur = themeId()
  const item = (id, name, note, sw) => `<div class="th ${cur === id ? 'on' : ''}" data-theme-id="${id}"><span class="ok">${cur === id ? '✓' : ''}</span>${swatchHTML(sw)}${esc(name)}<small>${esc(note)}</small></div>`
  const group = kind => {
    const list = THEMES.filter(t => t[2] === kind && (t[1] + ' ' + t[3]).toLowerCase().includes(q))
    return list.length ? `<h5>${kind === 'light' ? 'Light' : 'Dark'}</h5>` + list.map(t => item(t[0], t[1], t[3], t[0])).join('') : ''
  }
  const system = !q || 'system'.includes(q) ? item('system', 'System', 'echo paper / ink', osLight.matches ? 'echo-paper' : 'echo-ink') : ''
  $('#theme-list').innerHTML = (system + group('light') + group('dark')) || '<div class="empty">No theme matches.</div>'
  previewTheme()
}

async function setTheme(id) {
  state.config.theme = id
  applyTheme()
  if (!$('#theme-pop').hidden) renderThemes()
  try { await post('/api/config', { theme: id }) } catch (e) { setStatus(e.message, 'err') }
}

function toggleThemes(open = $('#theme-pop').hidden) {
  const was = !$('#theme-pop').hidden
  $('#theme-pop').hidden = !open
  if (!open) return was && applyTheme()
  toggleRepoPop(false)
  $('#theme-filter').value = ''
  themeSel = Math.max(0, [...THEMES.map(t => t[0]), 'system'].indexOf(themeId()))
  renderThemes()
  $('#theme-filter').focus()
}

function setInspector(tab) {
  $('#insp').dataset.insp = tab
  T.toolsShown()
  document.querySelectorAll('.insp-switch button').forEach(b => b.classList.toggle('on', b.dataset.insp === tab))
  markRail()
}

// ---------- Git drawer ----------
// The Git panel floats over the review from the rail on the right, so the diff keeps the width until
// you ask for Git. Opening it on Commit with something staged puts the caret in the message.
const gitOpen = () => $('.desk').classList.contains('git-open')
const gitPinned = () => !!state.config.gitPinned
function toggleGit(open = !gitOpen(), tab = '') {
  if (tab) setInspector(tab)
  $('.desk').classList.toggle('git-open', open)
  markRail()
  if (open && $('#insp').dataset.insp === 'commit' && changeTally().staged.length) $('#commit-message').focus({ preventScroll: true })
  if (!open && document.activeElement?.closest('#git-panel')) document.activeElement.blur()
}
// Layout settings: the Git panel docked or as a drawer, and which side each panel sits on.
function applyLayout(changed = false) {
  const desk = $('.desk'), pinned = gitPinned()
  desk.classList.toggle('pinned', pinned)
  desk.classList.toggle('swap', !!state.config.swapPanels)
  desk.classList.toggle('no-rail', !state.config.showRail)
  document.body.classList.toggle('git-shown-rail', !!state.config.showRail)
  // Choosing pin opens the panel and unpinning closes it; loading the page leaves it collapsed, pinned or not.
  if (changed) desk.classList.toggle('git-open', pinned)
  $('#git-pin').setAttribute('aria-pressed', pinned)
  $('#git-pin').title = pinned ? 'Unpin: open the Git panel as a drawer' : 'Pin the Git panel beside the review'
  markRail()
  if (!$('#settings').hidden) renderSettings()
}
async function saveSetting(patch) {
  Object.assign(state.config, patch)
  try { await post('/api/config', patch); setStatus('Settings saved', 'ok') } catch (e) { setStatus(e.message, 'err') }
}

function openSettings() {
  $('#help').hidden = true
  toggleThemes(false)
  $('#settings').hidden = false
  renderSettings()
  $('#settings .set-body').focus?.({ preventScroll: true })
}
function showSettingsPane(pane) {
  document.querySelectorAll('#settings [data-pane]').forEach(el => {
    if (el.closest('.set-nav')) el.classList.toggle('on', el.dataset.pane === pane)
    else el.hidden = el.dataset.pane !== pane
  })
}
function renderSettings() {
  const cur = { gitPinned: gitPinned() ? '1' : '0', swapPanels: state.config.swapPanels ? '1' : '0', showRail: state.config.showRail ? '1' : '0', diffMode: state.config.diffMode }
  document.querySelectorAll('#settings [data-set]').forEach(b => b.classList.toggle('on', cur[b.dataset.set] === b.dataset.val))
  // Plain settings: an element with data-cfg shows and edits the config key it names.
  document.querySelectorAll('#settings [data-cfg]').forEach(el => {
    const v = state.config[el.dataset.cfg]
    if (el.type === 'checkbox') el.checked = !!v
    else el.value = v ?? ''
  })
  const id = themeId()
  const card = (tid, name, sw) => `<button class="set-theme ${id === tid ? 'on' : ''}" data-theme-id="${tid}" title="${esc(name)}">${swatchHTML(sw)}<span>${esc(name)}</span></button>`
  const group = kind => `<h5>${kind === 'light' ? 'Light' : 'Dark'}</h5><div class="set-grid">${THEMES.filter(t => t[2] === kind).map(t => card(t[0], t[1], t[0])).join('')}</div>`
  $('#set-themes').innerHTML = `<div class="set-grid">${card('system', 'System', osLight.matches ? 'echo-paper' : 'echo-ink')}</div>` + group('dark') + group('light')
}

function markRail() {
  const tab = gitOpen() && $('#insp').dataset.insp
  document.querySelectorAll('#git-rail [data-open]').forEach(b => b.classList.toggle('on', b.dataset.open === tab))
  $('#git-toggle').setAttribute('aria-pressed', gitOpen())
}

// ---------- wiring ----------
$('#queue').addEventListener('click', e => {
  if (e.target.closest('[data-restore-discard]')) return void gitAction({ action: 'discard:restore' })
  const bar = e.target.closest('[data-pick]')?.dataset.pick
  if (bar) {
    const paths = pickedIn(pickedSec())
    state.qsel.clear()
    if (bar === 'stage') stage(paths)
    else if (bar === 'unstage') unstage(paths)
    else if (bar === 'stash') G.stashFiles(paths)
    else renderQueue()
    return
  }
  const act = e.target.closest('[data-act]')?.dataset.act
  const group = e.target.closest('.qgroup')
  if (group) {
    const sec = group.dataset.sec
    if (act === 'stage-all') stage(groupPaths(sec))
    else if (act === 'unstage-all') unstage(groupPaths(sec))
    else if (act === 'discard-all') discardAll()
    else { state.qClosed.has(sec) ? state.qClosed.delete(sec) : state.qClosed.add(sec); renderQueue() }
    return
  }
  const row = e.target.closest('.qrow')
  if (!row) return
  const { path, sec } = row.dataset
  // A row's own button acts on the whole pick when the row is part of it.
  const batch = () => state.qsel.size > 1 && state.qsel.has(qkey(sec, path)) ? pickedIn(sec) : [path]
  if (act === 'stage') stage(batch())
  else if (act === 'unstage') unstage(batch())
  else if (act === 'ours' || act === 'theirs') gitAction({ action: 'resolve:' + act, paths: batch() })
  else if (act === 'discard') discard([path], true)
  else if (act === 'open') openFile(path)
  else if (!pick(e, sec, path)) goTo(path, sec)
})
$('#queue').addEventListener('dblclick', e => {
  const row = e.target.closest('.qrow')
  if (row && !e.target.closest('[data-act]') && state.tree.some(f => f.path === row.dataset.path)) openFile(row.dataset.path)
})
$('#queue').addEventListener('contextmenu', e => {
  const row = e.target.closest('.qrow')
  if (!row) return
  e.preventDefault()
  const { path, sec } = row.dataset, c = state.changes.get(path)
  const paths = state.qsel.size > 1 && state.qsel.has(qkey(sec, path)) ? pickedIn(sec) : [path]
  popMenu([
    sec === 'staged' ? { label: 'Unstage', run: () => unstage(paths) } : { label: sec === 'merge' ? 'Mark resolved (stage)' : 'Stage', run: () => stage(paths) },
    ...(c?.code === '??' ? [{ label: 'Add intent to add (git add -N)', run: () => G.intentToAdd(paths) }] : []),
    ...(sec === 'work' ? [{ label: c?.code === '??' ? 'Delete untracked file…' : 'Discard changes…', danger: true, run: () => discard(paths, true) }] : []),
    { sep: true },
    { label: 'Open file', run: () => openFile(path) },
    { label: 'Stash these files…', run: () => G.stashFiles(paths) },
    { label: 'Add to .gitignore', run: () => G.ignorePaths(paths) },
    { label: 'Copy path', run: () => copyText(path) },
  ], e.clientX, e.clientY, basename(path))
})
$('#search-input').oninput = () => scheduleSearch()
$('#search-input').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); scheduleSearch(0) } })
document.querySelectorAll('.search-opts button').forEach(b => b.onclick = () => {
  const on = state.search.opts[b.dataset.opt] = !state.search.opts[b.dataset.opt]
  b.setAttribute('aria-pressed', on)
  scheduleSearch(0)
  $('#search-input').focus()
})
$('#search-results').addEventListener('click', e => {
  const group = e.target.closest('.sgroup')
  if (group) {
    const c = state.search.closed, p = group.dataset.path
    c.has(p) ? c.delete(p) : c.add(p)
    return renderSearch()
  }
  const row = e.target.closest('.srow')
  if (row) openFile(row.dataset.path, { line: Number(row.dataset.line), find: state.search.ran })
})
// ---------- file menu ----------
// Right-click a tree row: copy its name or path, or start a new file beside it. A folder creates inside itself.
let fileMenuFor = null
function closeFileMenu() { $('#file-menu').hidden = true; fileMenuFor = null }
function openFileMenu(row, x, y) {
  const isDir = row.classList.contains('dir'), path = isDir ? row.dataset.dir : row.dataset.path
  const dir = isDir ? path : path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : ''
  fileMenuFor = { path, dir, isDir }
  const m = $('#file-menu'), item = (a, label, extra = '', cls = '') => `<button class="menu-item ${cls}" data-a="${a}" role="menuitem">${label}${extra}</button>`
  m.innerHTML = `<div class="menu-head" title="${esc(path)}"><span>${esc(basename(path))}</span></div>`
    + item('new', `New file${isDir ? ' in folder' : ' here'}…`, '<kbd>⌘⌥N</kbd>') + item('folder', 'New folder…')
    + '<div class="menu-sep"></div>'
    + (isDir ? '' : item('side', 'Open to the side') + item('def', 'Open in default app') + item('ext', 'Open in editor…') )
    + item('reveal', 'Reveal in file manager')
    + '<div class="menu-sep"></div>'
    + item('rename', 'Rename or move…') + (isDir ? '' : item('dup', 'Duplicate…')) + item('del', isDir ? 'Delete folder…' : 'Delete…', '', 'danger')
    + '<div class="menu-sep"></div>'
    + item('ignore', 'Add to .gitignore')
    + item('name', 'Copy name') + item('rel', 'Copy relative path') + item('abs', 'Copy absolute path')
  m.hidden = false
  m.style.left = Math.max(8, Math.min(x, innerWidth - m.offsetWidth - 8)) + 'px'
  m.style.top = Math.max(8, Math.min(y, innerHeight - m.offsetHeight - 8)) + 'px'
  m.querySelector('.menu-item').focus()
}
async function runFileMenu(a) {
  const { path, dir, isDir } = fileMenuFor
  closeFileMenu()
  if (a === 'new') return fileAction('create', dir)
  if (a === 'folder') return FO.newFolder(dir)
  if (a === 'side') return FO.openSide(path)
  if (a === 'def') return FO.openDefault(path)
  if (a === 'ext') return FO.openExternal(path)
  if (a === 'reveal') return FO.reveal(path)
  if (a === 'rename') return FO.rename(path)
  if (a === 'dup') return FO.duplicate(path)
  if (a === 'del') return FO.remove(path, isDir)
  if (a === 'ignore') return G.ignorePaths([path])
  const text = a === 'name' ? basename(path) : a === 'rel' ? path : (state.status?.root || '').replace(/\/$/, '') + '/' + path
  try { await copyText(text); setStatus('Copied ' + text) } catch (e) { setStatus(e.message, 'err') }
}
$('#tree').addEventListener('contextmenu', e => {
  const row = e.target.closest('.tnode')
  if (!row) return
  e.preventDefault()
  openFileMenu(row, e.clientX, e.clientY)
})
$('#file-menu').addEventListener('click', e => { const b = e.target.closest('.menu-item'); if (b) runFileMenu(b.dataset.a) })
$('#file-menu').addEventListener('keydown', e => {
  const items = [...document.querySelectorAll('#file-menu .menu-item')], i = items.indexOf(document.activeElement)
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); items[(i + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length]?.focus() }
})
document.addEventListener('mousedown', e => { if (!$('#file-menu').hidden && !e.target.closest('#file-menu')) closeFileMenu() })
window.addEventListener('blur', closeFileMenu)

$('#tree').addEventListener('click', e => {
  const dir = e.target.closest('.tnode.dir')
  if (dir) return toggleDir(dir.dataset.dir)
  const row = e.target.closest('.tnode')
  if (row) { state.selected = row.dataset.path; openFile(row.dataset.path) }
})
$('#diff').addEventListener('click', e => {
  if (e.altKey) {
    const cell = e.target.closest('.tx[data-l]'), sec = cell?.closest('.dfile'), hunk = cell?.closest('.hunk')
    const f = sec && state.diffFiles[+sec.dataset.i]
    if (f && hunk) { e.preventDefault(); return R.noteAt(f, +hunk.dataset.h, f.hunks[+hunk.dataset.h].lines[+cell.dataset.l]) }
  }
  if (R.handleDiffClick(e)) return
  const sec = e.target.closest('.dfile')
  if (!sec) return
  const i = +sec.dataset.i, f = state.diffFiles[i]
  const act = e.target.closest('[data-act]')?.dataset.act
  if (act === 'open') openFile(f.path, { fromReview: true })
  else if (act === 'stage') { stage([f.path]); advanceFrom(i) }
  else if (act === 'unstage') unstage([f.path])
  else if (act === 'discard') discard([f.path], scope() === 'worktree')
  else if (act === 'more') fileMenu(i, e.target.closest('[data-act]'))
  else if (act === 'note') R.addFileNote(f.path)
  else if (e.target.closest('.dfile-head')) toggleFold(i)
})
// What a file header keeps out of sight: opening it, its history, more context, and discarding.
function fileMenu(i, anchor) {
  const f = state.diffFiles[i], r = anchor.getBoundingClientRect(), sc = scope()
  popMenu([
    !f.isDeleted && { label: 'Open file', kbd: 'o', run: () => openFile(f.path, { fromReview: true }) },
    state.status?.git && { label: 'File history', run: () => openFileHistory(f.path) },
    f.hunks.length && { label: `Context lines: ${f.ctx === 100000 ? 'whole file' : f.ctx || 3} — show more`, run: () => expandFile(i) },
    state.changes.has(f.path) && { sep: true },
    state.changes.has(f.path) && { label: sc === 'worktree' ? 'Discard unstaged changes' : 'Discard all changes to this file', danger: true, run: () => discard([f.path], sc === 'worktree') },
  ].filter(Boolean), r.right - 220, r.bottom + 4)
}
$('#diff').addEventListener('click', e => { if (e.target.closest('[data-empty="sync"]')) $('#sync').click() })
$('#diff').addEventListener('dblclick', e => {
  const cell = e.target.closest('.tx[data-n]')
  const f = cell && state.diffFiles[+cell.closest('.dfile').dataset.i]
  if (!f || f.isDeleted) return
  window.getSelection()?.removeAllRanges()
  openAtLine(f.path, +cell.dataset.n)
})
let scrollFrame
$('#diff').addEventListener('scroll', () => { cancelAnimationFrame(scrollFrame); scrollFrame = requestAnimationFrame(() => { renderNear(); updateCurrent() }) })
$('#tabs').addEventListener('contextmenu', e => {
  const el = e.target.closest('.tab')
  if (!el) return
  e.preventDefault()
  const i = +el.dataset.i, t = state.tabs[i]
  popMenu([
    { label: 'Close', run: () => closeTab(i) },
    { label: 'Close others', run: async () => { for (let k = state.tabs.length - 1; k >= 0; k--) if (state.tabs[k] !== t) await closeTab(k) } },
    { sep: true },
    { label: 'Open to the side', run: () => FO.openSide(t.path) },
    { label: 'Open in editor…', run: () => FO.openExternal(t.path) },
    { label: 'Reveal in file manager', run: () => FO.reveal(t.path) },
    { label: 'Copy path', run: () => copyText(t.path) },
  ], e.clientX, e.clientY, basename(t.path))
})
$('#open-ext').onclick = () => { const t = activeTab(); if (t) FO.openExternal(t.path, lineAtCaret()) }
$('#highlight').addEventListener('click', e => { if (e.target.closest('[data-open-ext]') && activeTab()) FO.openDefault(activeTab().path) })
const lineAtCaret = () => { const ed = $('#editor'); return ed.classList.contains('active') ? ed.value.slice(0, ed.selectionStart).split('\n').length : 0 }
$('#tabs').addEventListener('click', e => {
  const close = e.target.closest('[data-close]')
  if (close) return closeTab(+close.dataset.close)
  const tab = e.target.closest('.tab')
  if (tab) { state.active = +tab.dataset.i; state.returnTo = ''; setMode('file'); renderTree() }
})
document.querySelectorAll('#md-switch button').forEach(b => b.onclick = () => setPreview(b.dataset.md === 'preview'))
$('#md').addEventListener('click', e => {
  const a = e.target.closest('a[href]')
  if (!a) return
  e.preventDefault()
  const href = a.getAttribute('href'), tab = activeTab()
  if (href.startsWith('#')) return scrollToAnchor(href)
  if (/^(https?|mailto):/i.test(href)) return window.open(href, '_blank', 'noopener')
  const [p, hash] = href.split('#')
  let rel
  try { rel = resolvePath(tab.path, decodeURIComponent(p.split('?')[0])) } catch {}
  if (!rel) return setStatus(`Can't open ${href}`, 'err')
  openFile(rel).then(() => { if (hash && activeTab()?.path === rel) scrollToAnchor(hash) })
})
$('#md').addEventListener('scroll', () => { const t = activeTab(); if (t?.preview) t.mdScroll = $('#md').scrollTop })
$('#banner').addEventListener('click', async e => {
  const act = e.target.closest('[data-banner]')?.dataset.banner
  const tab = activeTab()
  if (!act || !tab) return
  if (act === 'close') { tab.content = tab.saved; closeTab(state.active) }
  if (act === 'reload') { try { await reloadTab(tab); renderTabs(); renderEditor(); setStatus('took disk version of ' + tab.path) } catch (err) { setStatus(err.message, 'err') } }
  if (act === 'overwrite') saveFile(true)
})
document.querySelectorAll('.mode-switch button').forEach(b => b.onclick = () => setMode(b.dataset.mode))
document.querySelectorAll('.rail-switch button').forEach(b => b.onclick = () => setRail(b.dataset.rail))
document.querySelectorAll('.insp-switch button').forEach(b => b.onclick = () => setInspector(b.dataset.insp))
$('#search-open').onclick = () => openPalette()
$('#search-contents').onclick = () => { const q = $('#file-filter').value.trim(); setRail('search'); if (q) { $('#search-input').value = q; scheduleSearch(0) } $('#search-input').focus() }

// The "⋯" menu holds what is used rarely, so the title bar can stay quiet.
$('#more-open').onclick = e => {
  e.stopPropagation()
  const r = e.currentTarget.getBoundingClientRect()
  popMenu([
    { label: 'Choose theme…', run: () => $('#theme-open').click() },
    { label: 'Settings', kbd: '⌘,', run: () => $('#settings-open').click() },
    { label: 'Keyboard shortcuts', kbd: '?', run: () => $('#help-open').click() },
    { sep: true },
    { label: 'Command palette…', kbd: '⌘⇧P', run: () => openPalette('>') },
    { label: 'Switch repository…', kbd: '⌘⇧O', run: () => $('#repo').click() },
    { label: 'Fetch all remotes', run: () => gitAction({ action: 'fetch' }, $('#sync')) },
  ], r.right - 220, r.bottom + 6)
}

// Sync is one button; fetching, pulling and pushing on their own live behind its caret.
$('#sync-more').onclick = e => {
  e.stopPropagation()
  const r = e.currentTarget.getBoundingClientRect(), s = state.status || {}
  popMenu([
    { label: `Fetch all remotes${s.fetchedAt ? ` · last ${ago(s.fetchedAt)}` : ''}`, run: () => gitAction({ action: 'fetch' }, $('#sync')) },
    { label: 'Pull', run: () => gitAction({ action: 'pull' }, $('#sync')) },
    { label: 'Push', run: () => gitAction({ action: 'push' }, $('#sync')) },
  ], r.left, r.bottom + 6)
}

// View options: what used to be loose switches in the review toolbar.
$('#view-open').onclick = e => {
  e.stopPropagation()
  const r = e.currentTarget.getBoundingClientRect(), on = v => (v ? '✓  ' : '    ')
  const cfg = (k, label) => ({ label: on(state.config[k] !== false) + label, run: () => { state.config[k] = state.config[k] === false; post('/api/config', { [k]: state.config[k] }); for (const f of state.diffAll || []) for (const h of f.hunks) h.colored = false; loadDiff() } })
  popMenu([
    { label: on($('#ignore-ws').checked) + 'Hide whitespace changes', run: () => { $('#ignore-ws').checked = !$('#ignore-ws').checked; loadDiff() } },
    { label: on(state.wrap) + 'Wrap long lines', run: () => { const b = $('#word-wrap'); b.checked = !b.checked; b.dispatchEvent(new Event('change')) } },
    cfg('wordDiff', 'Mark changed words'),
    cfg('renames', 'Detect renames'),
    { sep: true },
    ...[['all', 'Show all files'], ['new', 'Show only new files'], ['modified', 'Show only modified files'], ['deleted', 'Show only deleted files'], ['renamed', 'Show only renamed files'], ['noted', 'Show only files with notes']]
      .map(([v, label]) => ({ label: on($('#diff-status').value === v) + label, run: () => { const sel = $('#diff-status'); sel.value = v; sel.dispatchEvent(new Event('change')) } })),
    { sep: true },
    { label: 'Collapse or expand all files', run: () => $('#diff-collapse').click() },
  ], r.right - 220, r.bottom + 6)
}
$('#theme-open').onclick = e => { e.stopPropagation(); toggleThemes() }
$('#theme-filter').oninput = () => { themeSel = 0; renderThemes() }
$('#theme-filter').addEventListener('keydown', e => {
  const rows = document.querySelectorAll('#theme-list .th')
  if (e.key === 'Escape') { e.preventDefault(); toggleThemes(false) }
  else if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && rows.length) {
    e.preventDefault()
    themeSel = (themeSel + (e.key === 'ArrowDown' ? 1 : rows.length - 1)) % rows.length
    previewTheme()
  } else if (e.key === 'Enter' && rows[themeSel]) { e.preventDefault(); const id = rows[themeSel].dataset.themeId; toggleThemes(false); setTheme(id) }
})
$('#theme-list').addEventListener('mousemove', e => {
  const row = e.target.closest('.th'), rows = [...document.querySelectorAll('#theme-list .th')], i = rows.indexOf(row)
  if (i >= 0 && i !== themeSel) { themeSel = i; rows.forEach((r, j) => r.classList.toggle('sel', j === i)) }
})
$('#theme-list').onclick = e => { const t = e.target.closest('[data-theme-id]'); if (t) setTheme(t.dataset.themeId) }
// Picking a theme re-renders the list, so a detached click target still counts as inside the picker.
document.addEventListener('click', e => { if (!$('#theme-pop').hidden && e.target.isConnected && !e.target.closest('#theme-pop')) toggleThemes(false) })
osLight.addEventListener('change', () => { applyTheme(); swatches.clear(); if (!$('#theme-pop').hidden) renderThemes() })
// Clicks inside commit details, shared by the History tab and the Log view. Returns false if unhandled.
// Soft reset backs the branch up and keeps the undone work staged, but it rewrites history, so it asks.
async function resetHere(hash) {
  let p
  try { p = await api('/api/reset/preview?hash=' + encodeURIComponent(hash)) } catch (e) { return setStatus(e.message, 'err') }
  const list = p.undone.map(l => `<li class="mono">${esc(l)}</li>`).join('') + (p.count > p.undone.length ? `<li class="faint">and ${p.count - p.undone.length} more</li>` : '')
  const pushed = p.pushed ? `<p class="note">${plural(p.pushed, 'of these commit')} already on the remote, so pushing the branch afterwards needs a force push.</p>` : ''
  const ok = await ask({
    title: `Move ${p.branch} back to ${hash.slice(0, 7)}?`, kicker: 'Soft reset', tone: 'warn', ok: 'Reset',
    html: `<p>${plural(p.count, 'commit')} will be undone. ${p.count === 1 ? 'Its' : 'Their'} changes stay staged, and the reflog keeps the old tip.</p><ul class="undone">${list}</ul>${pushed}`,
  })
  if (ok) await gitAction({ action: 'reset:soft', from: hash })
}

// A merge commit has no single "before", so ask which parent is the mainline to keep.
async function revertCommit(hash) {
  const body = { action: 'revert', from: hash }
  let d = state.details.get(hash)
  if (!d || d.error) {
    try { d = await api('/api/commit?hash=' + encodeURIComponent(hash)) } catch (e) { return setStatus(e.message, 'err') }
  }
  if (d.parents.length > 1) {
    const n = await ask({
      title: 'Revert a merge commit', kicker: 'Revert', ok: 'Revert',
      html: `<p>Choose the parent to keep as the mainline; the changes the merge brought in from the others are undone.</p><ul class="undone">${d.parents.map((p, i) => `<li class="mono">${i + 1} · ${esc(p.slice(0, 7))}${i === 0 ? ' <span class="faint">usually the branch you merged into</span>' : ''}</li>`).join('')}</ul>`,
      input: { label: 'Mainline parent', value: '1' },
    })
    if (!n) return
    body.parent = +n
  }
  await gitAction(body)
}

const commitAct = (act, hash) => ({
  reset: () => G.resetChoice(hash, resetHere), revert: () => revertCommit(hash), pick: () => G.cherryPick(hash),
  branch: () => G.newBranchAt(hash), irebase: () => ctx.rebaseUI?.(hash + '^'),
}[act]?.())

// Right-click a file in a commit: view it as it was, or put that version back in the working tree.
function commitFileContext(e, hash) {
  const row = e.target.closest('.tnode[data-cfile]')
  if (!row || !hash) return false
  e.preventDefault()
  const path = row.dataset.cfile
  popMenu([
    { label: 'Show this file in the diff', run: () => goCommitFile(hash, path) },
    { label: 'View the file at this commit', run: () => viewAtCommit(hash, path) },
    { label: 'Restore it to the working tree…', danger: true, run: () => restoreFromCommit(hash, path) },
    { label: 'Show history of this file', run: () => openFileHistory(path) },
  ], e.clientX, e.clientY, basename(path))
  return true
}

async function viewAtCommit(hash, path) {
  try {
    const d = await api(`/api/file?path=${encodeURIComponent(path)}&rev=${encodeURIComponent(hash)}`)
    if (!d.exists) return setStatus(`${path} does not exist at ${hash.slice(0, 7)}`, 'err')
    const m = await import('./ui.js')
    m.openModal({ title: `${basename(path)} @ ${hash.slice(0, 7)}`, wide: true, body: `<pre class="diff-text">${d.binary ? 'Binary file' : esc(d.content)}</pre>`, actions: [{ label: 'Close' }] })
  } catch (e) { setStatus(e.message, 'err') }
}

async function restoreFromCommit(hash, path) {
  const ok = await ask({ title: `Restore ${basename(path)}`, kicker: 'overwrites', tone: 'warn', ok: 'Restore', html: `<p>The working-tree copy of <b>${esc(path)}</b> becomes the version from <span class="mono">${esc(hash.slice(0, 7))}</span>. What is there now is snapshotted first, so Restore in the Changes list can bring it back.</p>` })
  if (ok) gitAction({ action: 'restore:file', from: hash, paths: [path] })
}

function commitContext(e, hash, subject) {
  e.preventDefault()
  G.commitMenu(hash, subject, e.clientX, e.clientY, {
    diff: () => showCommitDiff(hash, hash.slice(0, 7)), revert: () => revertCommit(hash), soft: resetHere,
    irebase: () => ctx.rebaseUI?.(hash + '^'), compare: () => ctx.compareUI?.('HEAD', hash),
  })
}
$('#log-detail').addEventListener('contextmenu', e => commitFileContext(e, state.log.sel))
$('#log-rows').addEventListener('contextmenu', e => { const r = e.target.closest('.lrow'); if (r) commitContext(e, r.dataset.hash, r.querySelector('.ltext')?.textContent || '') })
$('#history').addEventListener('contextmenu', e => { if (commitFileContext(e, e.target.closest('.c-detail')?.previousElementSibling?.dataset.hash)) return; const r = e.target.closest('.commit-row'); if (r) commitContext(e, r.dataset.hash, r.title.split('\n')[0]) })

function detailClick(e, hash, inLog) {
  const t = e.target, hit = sel => t.closest(sel)
  if (hit('[data-act]')) {
    const b = hit('[data-act]')
    if (!b.disabled) commitAct(b.dataset.act, hash)
  } else if (hit('[data-copy]')) {
    const b = hit('[data-copy]')
    copyText(b.dataset.copy).then(() => {
      b.textContent = 'Copied'
      setTimeout(() => { b.textContent = 'Copy' }, 1200)
    }, err => setStatus('Could not copy the commit id: ' + err.message, 'err'))
  } else if (hit('[data-go]')) {
    const p = hit('[data-go]').dataset.go
    const list = inLog ? state.log.commits : state.hist.commits
    if (!list.some(c => c.hash === p)) showCommitDiff(p, p.slice(0, 7))
    else if (inLog) selectLog(p, true)
    else if (state.expanded !== p) selectCommit(p)
  } else if (hit('[data-cdir]')) {
    const key = hash + ':' + hit('[data-cdir]').dataset.cdir
    state.cdirClosed.has(key) ? state.cdirClosed.delete(key) : state.cdirClosed.add(key)
    paintDetail(hash)
  } else if (hit('[data-cfile]')) {
    document.querySelectorAll('.c-files .tnode.active').forEach(n => n.classList.remove('active'))
    hit('[data-cfile]').classList.add('active')
    state.fromLog = inLog
    goCommitFile(hash, hit('[data-cfile]').dataset.cfile).then(() => { state.fromLog = inLog; if (inLog) showLogSide() })
  } else if (hit('[data-diff]')) openLogDiff()
  else return false
  return true
}
$('#history').addEventListener('click', e => {
  const hash = e.target.closest('.c-detail')?.previousElementSibling?.dataset.hash
  if (hash && detailClick(e, hash, false)) return
  const row = e.target.closest('.commit-row')
  if (row) selectCommit(row.dataset.hash, row.dataset.short)
})
$('#revert-bar').addEventListener('click', e => {
  const b = e.target.closest('[data-revert]')
  if (b) gitAction({ action: b.dataset.revert })
})
$('#log-detail').addEventListener('click', e => detailClick(e, state.log.sel, true))
$('#log-side').addEventListener('click', e => {
  const hash = e.target.closest('.c-detail')?.previousElementSibling?.dataset.hash
  if (hash && detailClick(e, hash, true)) return
  const row = e.target.closest('.commit-row')
  if (!row || row.dataset.hash === state.log.sel) return
  state.log.sel = row.dataset.hash
  renderLogSide()
  loadDetail(row.dataset.hash)
})
// A click only selects the commit and shows its details, as in History; a click on one of its files opens
// that file's diff, and Esc comes back to the Log.
$('#log-rows').addEventListener('click', e => { const r = e.target.closest('.lrow'); if (r) selectLog(r.dataset.hash) })
$('#log-rows').addEventListener('scroll', () => {
  const v = $('#log-rows'), L = state.log
  if (L.more && !L.loading && v.scrollTop + v.clientHeight > v.scrollHeight - 600) loadLog(true)
})
$('#log-more').onclick = () => {
  const open = $('#log-more').getAttribute('aria-expanded') !== 'true'
  $('#log-more').setAttribute('aria-expanded', open)
  $('#log-extra').hidden = !open
}
$('#log-clear').onclick = () => { for (const id of ['#log-since', '#log-until', '#log-merges']) $(id).value = ''; loadLog() }
const logFilterCount = () => ['#log-since', '#log-until', '#log-merges'].filter(id => $(id).value).length
let logTimer
for (const id of ['#log-q', '#log-author', '#log-path', '#log-since', '#log-until', '#log-merges']) $(id).addEventListener('input', () => { clearTimeout(logTimer); logTimer = setTimeout(() => loadLog(), 250) })
$('#log-ref').onchange = () => { loadLog(); renderBranches() }
$('#branches').addEventListener('click', e => {
  const dir = e.target.closest('[data-bdir]')
  if (dir) {
    const k = dir.dataset.bdir
    state.bClosed.has(k) ? state.bClosed.delete(k) : state.bClosed.add(k)
    return renderBranches()
  }
  const row = e.target.closest('.bref')
  if (!row) return
  if (e.target.closest('[data-more]')) return openRefMenu(row.dataset.ref, row.dataset.kind, e.target.closest('[data-more]'))
  if (state.mode !== 'log') setMode('log').then(() => setLogRef(row.dataset.ref))
  else setLogRef(row.dataset.ref)
})
$('#branches').addEventListener('contextmenu', e => {
  const row = e.target.closest('.bref')
  if (!row || row.dataset.kind === 'view') return
  e.preventDefault()
  openRefMenu(row.dataset.ref, row.dataset.kind, row)
})
$('#branch').onclick = e => { e.stopPropagation(); toggleBranchPop() }
$('#repo').onclick = e => { e.stopPropagation(); toggleRepoPop() }
$('#repo-filter').oninput = () => { repoSel = 0; renderRepoPop() }
$('#repo-filter').addEventListener('keydown', e => {
  const list = repoMatches()
  if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && list.length) {
    e.preventDefault()
    repoSel = (repoSel + (e.key === 'ArrowDown' ? 1 : list.length - 1)) % list.length
    renderRepoPop()
  } else if (e.key === 'Enter' && list[repoSel]) { e.preventDefault(); switchRepo(list[repoSel].key, mod(e)) }
})
$('#repo-list').addEventListener('mousemove', e => {
  const row = e.target.closest('.rp-row')
  if (row && +row.dataset.i !== repoSel) { repoSel = +row.dataset.i; renderRepoPop() }
})
$('#repo-list').addEventListener('click', e => {
  const stop = e.target.closest('[data-repo-stop]')
  if (stop) { e.stopPropagation(); e.preventDefault(); return stopRepo(+stop.dataset.repoStop, false) }
  const row = e.target.closest('.rp-row')
  if (row) switchRepo(row.dataset.key, mod(e))
})
$('#repo-pop').addEventListener('click', e => {
  if (e.target.closest('[data-repo-quit]')) { e.stopPropagation(); stopRepo(0, true) }
})
$('#branch-filter').oninput = renderBranchPop
$('#branch-filter').addEventListener('keydown', e => {
  // Enter opens the menu of the only match, so "type a name, Enter, Enter" checks it out.
  const rows = document.querySelectorAll('#branch-list .bp-row')
  if (e.key === 'Enter' && rows.length === 1) { e.preventDefault(); openRefMenu(rows[0].dataset.ref, rows[0].dataset.kind, rows[0]) }
})
$('#branch-list').addEventListener('click', e => {
  const row = e.target.closest('.bp-row')
  if (row) openRefMenu(row.dataset.ref, row.dataset.kind, row)
})
$('#bp-new').onclick = async () => {
  toggleBranchPop(false)
  const name = await ask({ title: 'Name the new branch', ok: 'Create', html: '<p class="note">Starts from the current commit.</p>', input: { label: 'Branch name', placeholder: 'feature/name' } })
  if (name) await gitAction({ action: 'branch:create', from: name })
}
$('#ref-menu').addEventListener('click', e => { const b = e.target.closest('.menu-item'); if (b && menuFor) runRefAction(+b.dataset.i) })
$('#ref-menu').addEventListener('keydown', e => {
  const items = [...document.querySelectorAll('#ref-menu .menu-item')], i = items.indexOf(document.activeElement)
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); items[(i + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length]?.focus() }
})
document.addEventListener('click', e => {
  if (!e.target.isConnected || e.target.closest('#ref-menu')) return
  if (!$('#ref-menu').hidden && !e.target.closest('[data-more], .bp-row')) closeRefMenu()
  if (!$('#branch-pop').hidden && !e.target.closest('#branch-pop')) toggleBranchPop(false)
  if (!$('#repo-pop').hidden && !e.target.closest('#repo-pop')) toggleRepoPop(false)
  })
// Only these two stash verbs are reachable from a row, whatever data-act the markup carries.
// A Map, not an object, so a key like "constructor" cannot reach the prototype.
const STASH_ACT = new Map([['apply', 'stash:apply'], ['pop', 'stash:pop'], ['drop', 'stash:drop']])
$('#stashes').addEventListener('click', e => {
  const b = e.target.closest('button[data-ref]')
  if (b?.dataset.act === 'show') return G.stashShow(b.dataset.ref)
  if (b?.dataset.act === 'stbranch') return G.stashBranch(b.dataset.ref)
  const action = b && STASH_ACT.get(b.dataset.act)
  if (action) gitAction({ action, stashRef: b.dataset.ref })
})

$('#editor').addEventListener('input', () => {
  const t = activeTab()
  if (!t) return
  t.content = $('#editor').value
  const dirty = t.content !== t.saved
  $(`#tabs .tab[data-i="${state.active}"]`)?.classList.toggle('dirty', dirty)
  $('#save').disabled = !dirty
  $('#stage-count').textContent = `${lineCount(t)} lines${dirty ? ' · unsaved' : ''}`
  paintGutter()
  paintSyntax()
  paintFind()
  Ops.renderConflictBar()
  Ed.onInput()
  clearTimeout(marksTimer)
  marksTimer = setTimeout(() => { if (t === activeTab()) { computeMarks(t); paintGutter() } }, 120)
})
let marksTimer, gutterFrame
// Repaint the gutter and colors when the editor changes size (window resize, panels, a first paint
// made before layout settled); both draw only the rows that fit.
new ResizeObserver(() => { cancelAnimationFrame(gutterFrame); gutterFrame = requestAnimationFrame(() => { paintGutter(); paintSyntax(); paintFind() }) }).observe($('#editor'))
$('#editor').addEventListener('scroll', () => { cancelAnimationFrame(gutterFrame); gutterFrame = requestAnimationFrame(() => { paintGutter(); paintSyntax(); paintFind(); paintBlameGhost() }) })
let ghostFrame, blameTimer
for (const ev of ['keyup', 'mouseup', 'focus']) $('#editor').addEventListener(ev, () => { cancelAnimationFrame(ghostFrame); ghostFrame = requestAnimationFrame(paintBlameGhost) })
$('#editor').addEventListener('input', () => {
  $('#blame-ghost').hidden = true
  clearTimeout(blameTimer)
  blameTimer = setTimeout(() => ensureBlame(activeTab()), 600)
})
$('#gutter').addEventListener('click', e => {
  const n = e.target.closest('.gn[data-nid]')
  if (n) return R.openNoteById(n.dataset.nid)
  const b = e.target.closest('.gbl[data-hash]'); if (b) showCommitInLog(b.dataset.hash)
})
$('#note-add').onclick = () => R.addEditorNote()
$('#file-history').onclick = () => { const t = activeTab(); if (t) openFileHistory(t.path) }
$('#blame-toggle').onclick = () => { state.blameGutter = !state.blameGutter; renderEditor(); paintGutter() }
// Wrapping changes every line's width and height, so the measured offsets belong to the old mode and
// are dropped. The stacked diff reads the same class, so Review wraps too.
function setWrap(on) {
  state.wrap = on
  $('.stage').classList.toggle('wrap', on)
  $('#editor').wrap = on ? 'soft' : 'off'
  wrap = { tab: null, text: null, w: 0, n: 0, filled: 0, at: 0, h: [], top: [0] }
  if (state.mode === 'file') renderEditor()
  setStatus(on ? 'Word wrap on' : 'Word wrap off')
}
$('#word-wrap').onchange = e => setWrap(e.target.checked)
$('#range-dots').onclick = () => { setRangeDots(state.rangeDots === '..' ? '...' : '..'); loadDiff() }
$('#log-compare').addEventListener('click', e => {
  const act = e.target.closest('[data-cmp]')?.dataset.cmp, c = state.log.compare
  if (!act || !c) return
  if (act === 'swap') { state.log.compare = { a: c.b, b: c.a }; loadLog() }
  else if (act === 'diff') openCompareDiff()
  else { state.log.compare = null; loadLog() }
})
$('#inline-blame').onchange = async () => {
  state.config.blame = $('#inline-blame').checked ? 'line' : 'off'
  renderEditor()
  try { await post('/api/config', { blame: state.config.blame }); setStatus('Settings saved', 'ok') } catch (e) { setStatus(e.message, 'err') }
}
$('#new-file').onclick = () => fileAction('create')
$('#rename-file').onclick = () => fileAction('rename')
$('#delete-file').onclick = () => fileAction('delete')
$('#save').onclick = () => saveFile()
// The editor's secondary actions live in one menu. The buttons stay in the page (the editor shows and hides
// them by file type); the menu lists the ones that apply and presses them.
$('#file-more').onclick = e => {
  e.stopPropagation()
  const r = e.currentTarget.getBoundingClientRect()
  const items = [['#note-add', 'Add a note for the agent…', '⌘⌥M'], ['#open-ext', 'Open in another app…'], ['#file-history', 'File history'], ['#blame-toggle', 'Blame'], ['#eol', 'Line endings'], ['#json-format', 'Format JSON']]
    .map(([sel, label, kbd]) => ({ b: $(sel), label, kbd })).filter(x => x.b && !x.b.hidden)
    .map(({ b, label, kbd }) => ({ label: b.id === 'eol' ? `${label}: ${b.textContent.trim()} — convert` : b.id === 'blame-toggle' ? (b.classList.contains('on') || b.getAttribute('aria-pressed') === 'true' ? '✓  ' : '    ') + label : label, kbd, run: () => b.click() }))
  popMenu(items, r.right - 240, r.bottom + 4)
}
$('#refresh').onclick = refreshAll
const toggleTree = () => $('.desk').classList.toggle('no-tree')
$('#tree-toggle').onclick = toggleTree
$('#git-toggle').onclick = () => toggleGit()
$('#git-close').onclick = () => toggleGit(false)
$('#git-pin').onclick = () => { saveSetting({ gitPinned: !gitPinned() }); applyLayout(true) }
$('#settings-open').onclick = openSettings
document.querySelector('[data-open-settings]').onclick = openSettings
$('#settings').addEventListener('click', e => {
  if (e.target === $('#settings') || e.target.closest('[data-close]')) { $('#settings').hidden = true; return }
  const t = e.target.closest('[data-theme-id]')
  if (t) { setTheme(t.dataset.themeId).then(renderSettings); renderSettings(); return }
  const nav = e.target.closest('.set-nav [data-pane]')
  if (nav) return showSettingsPane(nav.dataset.pane)
  const b = e.target.closest('[data-set]')
  if (!b) return
  const k = b.dataset.set, v = b.dataset.val
  if (k === 'diffMode') { setDiffMode(v); renderSettings(); return }
  saveSetting({ [k]: v === '1' })
  applyLayout(k === 'gitPinned')
})
$('#settings').addEventListener('change', async e => {
  const el = e.target.closest('[data-cfg]')
  if (!el) return
  const key = el.dataset.cfg
  let v = el.type === 'checkbox' ? el.checked : el.dataset.type === 'int' ? Math.round(Number(el.value) || 0) : el.value
  await saveSetting({ [key]: v })
  ctx.onConfig?.(key)
  if (key === 'renames' || key === 'wordDiff') {
    for (const f of state.diffAll || []) for (const h of f.hunks) h.colored = false
    loadDiff()
  }
})
$('#git-rail').onclick = e => {
  const tab = e.target.closest('[data-open]')?.dataset.open
  if (tab === 'commit') { $('.desk').classList.remove('no-tree'); setRail('changes'); $('#commit-message').focus(); return }
  if (tab === 'branches') { e.stopPropagation(); toggleBranchPop() }
  else if (tab) toggleGit(!(gitOpen() && $('#insp').dataset.insp === tab), tab)
}
$('#trace').addEventListener('click', e => {
  const seg = e.target.closest('.tseg')
  if (seg) goHunk(+seg.dataset.i, +(e.target.closest('[data-h]')?.dataset.h ?? 0))
})

// ---------- panel widths ----------
// The desk grid reads --tree-w and --git-w, so a drag is one property write per frame. The widths are
// global, like the theme, and the config keeps them. Below 1100px the tracks are fixed by the breakpoint
// and the grips are hidden, because there is nothing there to drag.
const PANEL_RANGE = { tree: [180, 560], git: [220, 640] }
// Whatever a panel is dragged to, the editor keeps this much room.
const CENTER_MIN = 360

const applyWidths = () => {
  const desk = $('.desk')
  for (const side of ['tree', 'git']) {
    const w = state.widths[side]
    desk.style.setProperty(`--${side}-w`, w + 'px')
    const grip = $(`#grip-${side}`)
    grip.setAttribute('aria-valuemin', PANEL_RANGE[side][0])
    grip.setAttribute('aria-valuemax', PANEL_RANGE[side][1])
    grip.setAttribute('aria-valuenow', w)
  }
}
// A panel stops at its own range, and early rather than at that range if the editor needs the room.
// The Git panel floats over the review, so only the rail beside it takes width from the sidebar.
const clampWidth = (side, want) => {
  const [min, max] = PANEL_RANGE[side]
  const desk = $('.desk')
  const other = (state.config.showRail ? 46 : 0) + (side === 'git' ? (desk.classList.contains('no-tree') ? 0 : state.widths.tree) : (gitPinned() && gitOpen() ? state.widths.git : 0))
  const room = Math.max(min, $('.desk').clientWidth - other - CENTER_MIN)
  return Math.round(Math.max(min, Math.min(want, max, room)))
}
let widthSave
const scheduleWidthSave = () => {
  clearTimeout(widthSave)
  // Both keys go in every patch, since the server replaces the whole panelSizes map.
  widthSave = setTimeout(() => post('/api/config', { panelSizes: { ...state.widths } }).catch(e => setStatus(e.message, 'err')), 250)
}
// A panel on the left grows with the pointer, one on the right against it; Swap trades the sides.
const gripSign = side => (side === 'tree') === !state.config.swapPanels ? 1 : -1
const dragGrip = (side, e) => {
  const grip = $(`#grip-${side}`), sign = gripSign(side)
  const from = e.clientX, start = state.widths[side]
  const move = ev => { state.widths[side] = clampWidth(side, start + sign * (ev.clientX - from)); applyWidths() }
  const done = () => {
    grip.classList.remove('on')
    document.body.classList.remove('resizing')
    grip.removeEventListener('pointermove', move)
    grip.removeEventListener('pointerup', done)
    grip.removeEventListener('pointercancel', done)
    scheduleWidthSave()
  }
  grip.setPointerCapture(e.pointerId)
  grip.classList.add('on')
  document.body.classList.add('resizing')
  grip.addEventListener('pointermove', move)
  grip.addEventListener('pointerup', done)
  grip.addEventListener('pointercancel', done)
  e.preventDefault()
}
for (const side of ['tree', 'git']) {
  const grip = $(`#grip-${side}`)
  grip.onpointerdown = e => dragGrip(side, e)
  // A focused grip resizes with the arrow keys, so the panels are not mouse-only.
  grip.onkeydown = e => {
    const dir = { ArrowRight: 1, ArrowLeft: -1 }[e.key]
    if (!dir) return
    e.preventDefault()
    state.widths[side] = clampWidth(side, state.widths[side] + dir * gripSign(side) * (e.shiftKey ? 40 : 12))
    applyWidths()
    scheduleWidthSave()
  }
}
$('#commit').onclick = () => doCommit(!!state.config.commitAll && !changeTally().staged.length)
$('#commit-more').onclick = e => { e.stopPropagation(); toggleCommitMenu($('#commit-menu').hidden) }
$('#commit-menu').addEventListener('click', e => {
  const act = e.target.closest('[data-c]')?.dataset.c
  toggleCommitMenu(false)
  if (act === 'staged') doCommit(false)
  else if (act === 'all') doCommit(true)
  else if (act === 'amend') amend()
  else if (act === 'amend-keep') gitAction({ action: 'amend:noedit', ...G.commitOpts() })
  else if (act === 'undo') undoLastCommit()
})
document.addEventListener('click', e => { if (!e.target.closest('#commit-menu, #commit-more')) toggleCommitMenu(false) })
$('#commit-all').onchange = async () => {
  state.config.commitAll = $('#commit-all').checked
  renderCommit()
  try { await post('/api/config', { commitAll: state.config.commitAll }); setStatus('Settings saved', 'ok') } catch (e) { setStatus(e.message, 'err') }
}
$('#switch-branch').onclick = () => gitAction({ action: 'branch:switch', from: $('#branch-select').value })
$('#create-branch').onclick = () => gitAction({ action: 'branch:create', from: $('#new-branch').value.trim() }).then(() => { $('#new-branch').value = '' })
const upstream = () => { const t = state.status?.tracking; return !!(t && t.upstream && !t.gone) }
$('#fetch').onclick = () => gitAction({ action: 'fetch' }, $('#fetch'))
$('#sync').onclick = () => gitAction({ action: upstream() ? 'sync' : 'publish' }, $('#sync'))
$('#pull').onclick = () => gitAction({ action: upstream() || !(state.status?.remotes || []).length ? 'pull' : 'publish' }, $('#pull'))
$('#push').onclick = () => gitAction({ action: upstream() ? 'push' : 'publish' }, $('#push'))

// Force pushes rewrite the remote branch, so each asks first. The lease is the safer default: Git
// refuses it when the remote gained commits since the last fetch. A plain force does not look.
async function forcePush(lease) {
  const t = state.status?.tracking
  if (!upstream()) return setStatus('Force push needs a branch with an upstream; Publish it first', 'err')
  const behind = t.behind ? `<p class="note">${plural(t.behind, 'commit')} on ${esc(t.upstream)} ${t.behind === 1 ? 'is' : 'are'} not in your branch (as of the last fetch) and will be lost.</p>` : ''
  const ok = await ask(lease ? {
    title: `Force push ${t.name} to ${t.upstream}?`, kicker: 'Force with lease', tone: 'warn', ok: 'Force push',
    html: `<p>${esc(t.upstream)} is replaced with your branch. Git refuses if anyone pushed to it since your last fetch, so their commits are not lost by surprise.</p>${behind}`,
  } : {
    title: `Force push ${t.name} to ${t.upstream}?`, kicker: 'No lease', tone: 'danger', ok: 'Force push',
    html: `<p>${esc(t.upstream)} is replaced with your branch <strong>without checking</strong> what is there. Commits pushed by others since your last fetch are lost from the remote.</p>${behind}<p class="note">Prefer force with lease unless you know the remote is yours alone.</p>`,
  })
  if (ok) await gitAction({ action: lease ? 'push:lease' : 'push:force' }, $('#push'))
}
function togglePushMenu(open) {
  const m = $('#push-menu')
  m.hidden = !open
  if (!open) return
  m.innerHTML = G.pushMenuHTML()
  const r = $('#push-more').getBoundingClientRect()
  m.style.left = Math.max(8, r.right - m.offsetWidth) + 'px'
  m.style.top = r.bottom + 4 + 'px'
  m.querySelector('.menu-item').focus()
}
$('#push-more').onclick = e => { e.stopPropagation(); togglePushMenu($('#push-menu').hidden) }
$('#push-menu').addEventListener('click', e => {
  const p = e.target.closest('[data-p]')?.dataset.p
  togglePushMenu(false)
  if (p === 'tags') gitAction({ action: 'push', tags: true }, $('#push'))
  else if (p?.startsWith('up:')) gitAction({ action: 'push', setUpstream: true, remote: p.slice(3) }, $('#push'))
  else if (p) forcePush(p === 'lease')
})
document.addEventListener('click', e => { if (!e.target.closest('#push-menu, #push-more')) togglePushMenu(false) })
setInterval(renderTracking, 30000)
$('#merge').onclick = () => gitAction({ action: 'merge', from: $('#branch-select').value })
$('#rebase').onclick = () => gitAction({ action: 'rebase', from: $('#branch-select').value })
$('#stash-create').onclick = () => gitAction({ action: 'stash:create', message: $('#stash-message').value }).then(() => { $('#stash-message').value = '' })
$('#file-filter').oninput = () => { renderQueue(); renderTree(); renderBranches() }
$('#diff-scope').onchange = () => { syncScopeInputs(); $('#diff').scrollTop = 0; loadDiff() }
const setScope = v => { $('#diff-scope').value = v; $('#diff-scope').dispatchEvent(new Event('change')) }
$('#scope-seg').addEventListener('click', e => { const b = e.target.closest('[data-scope]'); if (b && b.dataset.scope !== scope()) setScope(b.dataset.scope) })
$('#scope-chip-x').onclick = () => { state.fromLog = false; setScope('head') }
$('#ignore-ws').onchange = loadDiff
let filterTimer
$('#diff-filter').addEventListener('input', () => { clearTimeout(filterTimer); filterTimer = setTimeout(refilter, 150) })
$('#diff-status').onchange = () => {
  const v = $('#diff-status').value, f = $('#diff-filter')
  f.classList.toggle('filtered', v !== 'all')
  f.placeholder = v === 'all' ? 'Filter files or text' : `Only ${v === 'noted' ? 'files with notes' : v + ' files'} — filter`
  refilter()
}
$('#diff-collapse').onclick = () => {
  const collapse = state.diffFiles.some(f => !isFolded(f))
  for (const f of state.diffFiles) state.folded.set(f.path, collapse)
  $('#diff-collapse').textContent = collapse ? 'Expand all' : 'Collapse all'
  renderDiff()
}
document.querySelectorAll('.layout-switch button').forEach(b => b.onclick = () => setDiffMode(b.dataset.layout))
for (const id of ['#diff-from', '#diff-to', '#diff-commit']) $(id).addEventListener('keydown', e => { if (e.key === 'Enter') loadDiff() })
$('#help-open').onclick = () => { $('#help').hidden = false }
$('#help').onclick = e => { if (e.target === $('#help') || e.target.dataset.close !== undefined) $('#help').hidden = true }
$('#gutter-base').onchange = () => {
  state.config.gutterBase = $('#gutter-base').value
  refreshGutter()
  post('/api/config', { gutterBase: state.config.gutterBase }).then(() => setStatus('Settings saved', 'ok'), e => setStatus(e.message, 'err'))
}
$('#vim-mode').onchange = async () => {
  state.config.vim = $('#vim-mode').checked
  try { await post('/api/config', { vim: state.config.vim }); setStatus('Settings saved', 'ok') } catch (e) { setStatus(e.message, 'err') }
}
$('#palette').onclick = e => {
  if (e.target === $('#palette')) $('#palette').hidden = true
  const item = e.target.closest('.pitem')
  if (item) choosePalette(+item.dataset.i)
}
$('#palette-input').oninput = renderPalette
$('#palette-input').addEventListener('keydown', e => {
  const p = state.palette
  if (e.key === 'ArrowDown' || (e.ctrlKey && e.key === 'n')) { e.preventDefault(); p.sel = Math.min(p.items.length - 1, p.sel + 1); paintPalette() }
  else if (e.key === 'ArrowUp' || (e.ctrlKey && e.key === 'p')) { e.preventDefault(); p.sel = Math.max(0, p.sel - 1); paintPalette() }
  else if (e.key === 'Enter') { e.preventDefault(); choosePalette(p.sel) }
  else if (e.key === 'Escape') { e.preventDefault(); $('#palette').hidden = true }
})

document.addEventListener('keydown', e => {
  if (dlg) { if (e.key === 'Escape') { e.preventDefault(); dlg.done(null) } return }
  if (e.key === 'Escape' && !$('#file-menu').hidden) { e.preventDefault(); closeFileMenu(); return }
  // e.code, because ⌥N is a dead key on macOS. ⌘N itself belongs to the browser.
  if (mod(e) && e.altKey && e.code === 'KeyN') { e.preventDefault(); const d = state.selected || activeTab()?.path || ''; fileAction('create', d.includes('/') ? d.slice(0, d.lastIndexOf('/')) : ''); return }
  if (e.key === 'Escape' && state.qsel.size && !typing(e)) { e.preventDefault(); state.qsel.clear(); renderQueue(); return }
  if (e.key === 'Escape' && !$('#push-menu').hidden) { e.preventDefault(); togglePushMenu(false); $('#push-more').focus(); return }
  if (e.key === 'Escape' && !$('#commit-menu').hidden) { e.preventDefault(); toggleCommitMenu(false); $('#commit-more').focus(); return }
  if (!$('#palette').hidden) return
  if (!$('#settings').hidden && !mod(e) && e.key !== 'Escape') return
  if (mod(e)) {
    const k = e.key.toLowerCase()
    if (k === 'o' && e.shiftKey) { e.preventDefault(); toggleRepoPop() }
    else if (k === 'f' && e.shiftKey) {
      e.preventDefault()
      $('.desk').classList.remove('no-tree')
      const sel = editorSelection()
      setRail('search')
      if (sel) { $('#search-input').value = sel; scheduleSearch(0) }
      $('#search-input').select()
    }
    else if (e.altKey && e.code === 'KeyM') { if (inEditor()) { e.preventDefault(); R.addEditorNote() } }
    else if (e.altKey && e.code === 'KeyT') { e.preventDefault(); reopenClosedTab() }
    else if (k === 'f' && e.altKey) { if (inEditor()) { e.preventDefault(); const sel = editorSelection(); showFind(sel || null); Rp.toggleReplace(true) } }
    else if (k === 'f' && !e.altKey) { if (inEditor()) { e.preventDefault(); const sel = editorSelection(); showFind(sel || null) } }
    else if (k === 'g' && find.open && inEditor()) { e.preventDefault(); stepFind(e.shiftKey ? -1 : 1) }
    else if (k === 'p' && e.shiftKey) { e.preventDefault(); openPalette('>') }
    else if (k === 'k' || k === 'p') { e.preventDefault(); openPalette() }
    else if (k === 'b') { e.preventDefault(); toggleTree() }
    else if (k === 'j') { e.preventDefault(); toggleGit() }
    else if (e.key === ',') { e.preventDefault(); $('#settings').hidden ? openSettings() : ($('#settings').hidden = true) }
    else if (k === 'd') { e.preventDefault(); setMode(state.mode === 'diff' ? 'file' : 'diff') }
    else if (k === 's') { e.preventDefault(); saveFile() }
    else if (k === 'v' && e.shiftKey && state.mode === 'file' && isMarkdown(activeTab()?.path || '')) { e.preventDefault(); setPreview(!activeTab().preview) }
    else if (e.key === 'Enter' && e.target.id === 'commit-message') { e.preventDefault(); $('#commit').disabled ? setStatus('Nothing is staged yet', 'err') : $('#commit').click() }
    return
  }
  if (e.key === 'Escape' && find.open && e.target.id === 'editor') { e.preventDefault(); closeFind(false); return }
  if (e.key === 'Escape' && e.target.id === 'editor' && state.returnTo && state.returnTo === activeTab()?.path) { e.preventDefault(); backToReview(); return }
  // Keys inside the branch popup and menu belong to their buttons (Enter activates the focused item).
  if (e.key !== 'Escape' && e.target.closest?.('#ref-menu, #branch-pop')) return
  if (e.key === 'Escape' && (!$('#ref-menu').hidden || !$('#branch-pop').hidden)) { e.preventDefault(); if (!$('#ref-menu').hidden) closeRefMenu(); else toggleBranchPop(false); return }
  if (e.key === 'Escape' && !$('#settings').hidden) { e.preventDefault(); $('#settings').hidden = true; if (typing(e)) e.target.blur(); return }
  if (e.key === 'Escape' && gitOpen() && !gitPinned() && $('#help').hidden && (!typing(e) || e.target.closest('#git-panel'))) { e.preventDefault(); toggleGit(false); return }
  if (e.key === 'Escape' && state.mode === 'diff' && state.fromLog && !typing(e) && $('#help').hidden) { e.preventDefault(); setMode('log'); return }
  if (e.key === 'Escape' && !$('#diagram').hidden) { e.preventDefault(); closeDiagram(); return }
  if (e.key === 'Escape') { $('#help').hidden = true; toggleThemes(false); toggleRepoPop(false); if (typing(e)) e.target.blur(); return }
  if (typing(e) || e.altKey) return
  if (state.mode === 'log') {
    const k = { ArrowDown: 1, j: 1, ArrowUp: -1, k: -1 }[e.key]
    if (k) { e.preventDefault(); stepLog(k) }
    else if (e.key === 'Enter') { e.preventDefault(); openLogDiff() }
    else if (e.key === '?') $('#help').hidden = false
    return
  }
  const vimStep = dir => { if (state.config.vim && state.mode === 'file') $('#editor').scrollBy(0, dir * 60) }
  switch (e.key) {
    case '?': $('#help').hidden = false; break
    case 'n': stepFile(1); break
    case 'p': stepFile(-1); break
    case 'j': state.mode === 'diff' ? stepHunk(1) : vimStep(1); break
    case 'k': state.mode === 'diff' ? stepHunk(-1) : vimStep(-1); break
    case 'e': if (state.mode === 'diff') openCurrentHunk(); break
    case 's': case 'u': {
      const f = state.mode === 'diff' ? state.diffFiles[state.current] : null, c = f && state.changes.get(f.path)
      if (!c) break
      if (e.key === 's' && c.work) { stage([f.path]); advanceFrom(state.current) }
      else if (e.key === 'u' && c.index) unstage([f.path])
      break
    }
    case 'o': { const p = currentPath(); if (p && state.mode === 'diff' && !state.diffFiles[state.current]?.isDeleted) openFile(p, { fromReview: true }); break }
    default: if (R.handleKey(e)) break; return
  }
  e.preventDefault()
})
// Unsaved edits are kept with the session and come back on the next visit, so the browser only needs
// to ask when they could not be kept.
window.addEventListener('beforeunload', e => { persistSession(true); if (!sessionSaved && state.tabs.some(t => t.content !== t.saved)) e.preventDefault() })

async function loadConfig() {
  try { state.config = await api('/api/config'); $('#vim-mode').checked = !!state.config.vim; $('#commit-all').checked = !!state.config.commitAll; renderCommit() } catch {}
  if (state.config.diffMode !== 'split') state.config.diffMode = 'unified'
  // A hand-edited or older config can hold a width that no longer fits the range; keep the default.
  for (const side of ['tree', 'git']) {
    const w = Math.round(Number((state.config.panelSizes || {})[side]))
    if (w >= PANEL_RANGE[side][0] && w <= PANEL_RANGE[side][1]) state.widths[side] = w
  }
  applyWidths()
  applyLayout()
  $('#gutter-base').value = gutterBase()
  $('#inline-blame').checked = blameInline()
  document.querySelectorAll('.layout-switch button').forEach(b => b.classList.toggle('on', b.dataset.layout === state.config.diffMode))
  if (state.diffFiles.length) renderDiff()
  applyTheme()
  Ed.applySettings()
}

// ---------- session ----------
// Every repository has its own origin (its own port), so localStorage is already one store per repository.
// Switching away navigates the tab and the page reloads, so what was on screen is saved on the way out and
// put back on the way in: the mode, rails and diff scope, open tabs with unsaved edits, caret and scroll,
// the diff position, and the commit message draft. The saved root guards against a port that later serves
// another repository; a file that changed on disk meanwhile comes back with the usual conflict banner.
const SESSION_KEY = storeKey('echo:session'), DRAFT_MAX = 1 << 20
let sessionReady = false, sessionSaved = true, sessionTimer = 0

// Where the review is, as a file and an offset inside it, so edits above it do not shift the place.
function diffPos() {
  const view = $('#diff'), f = state.diffFiles[state.current]
  const el = f && view.querySelector(`.dfile[data-i="${state.current}"]`)
  return el ? { path: f.path, off: Math.round(view.scrollTop - offsetIn(el, view)) } : null
}

function snapshotSession() {
  const ed = $('#editor'), editing = state.mode === 'file' && !!activeTab()
  let room = DRAFT_MAX, kept = true
  const tabs = state.tabs.map((t, i) => {
    const live = editing && i === state.active
    const content = live ? ed.value : t.content
    const o = { path: t.path, preview: !!t.preview, mdScroll: t.mdScroll || 0, caret: live ? ed.selectionStart : t.caret || 0, scroll: live ? ed.scrollTop : t.scroll || 0 }
    if (!t.binary && content !== t.saved) {
      if (content.length <= room) { room -= content.length; o.draft = { content, hash: t.hash } } else kept = false
    }
    return o
  })
  const L = state.log, sec = state.mode === 'log' && state.railBeforeLog ? state.railBeforeLog : state.rail
  return [kept, {
    v: 1, t: Date.now(), root: state.status?.root || '',
    mode: state.mode, rail: sec, insp: $('#insp').dataset.insp, drawer: gitOpen() && !gitPinned(),
    scope: scope(), from: $('#diff-from').value, to: $('#diff-to').value, commit: $('#diff-commit').value, full: state.commit,
    ws: $('#ignore-ws').checked, dots: state.rangeDots,
    tabs, active: editing ? activeTab().path : state.tabs[state.active]?.path || '', selected: state.selected,
    diffPos: state.mode === 'diff' ? diffPos() : state.diffPos || null,
    filter: $('#file-filter').value, message: $('#commit-message').value,
    search: { q: $('#search-input').value, opts: state.search.opts },
    log: { ref: $('#log-ref').value, q: $('#log-q').value, author: $('#log-author').value, path: $('#log-path').value, sel: L.sel },
    folded: [...state.folded], dirOpen: [...state.dirOpen], qClosed: [...state.qClosed], bClosed: [...state.bClosed],
  }]
}

// The browser keeps the session per origin, which is per port: a repository that comes back on another
// port, a cleared site-data store or another browser would start from nothing. The server keeps a copy
// per repository (beside the config), and boot takes whichever is newer.
let mirrorTimer = 0
function mirrorSession(snap, final) {
  const body = JSON.stringify({ session: snap })
  clearTimeout(mirrorTimer)
  if (final && navigator.sendBeacon) return void navigator.sendBeacon(withBase('/api/drafts'), new Blob([body], { type: 'application/json' }))
  mirrorTimer = setTimeout(() => fetch(withBase('/api/drafts'), { method: 'POST', headers: { 'content-type': 'application/json' }, body }).catch(() => {}), 1500)
}

function persistSession(final = false) {
  clearTimeout(sessionTimer)
  if (!sessionReady) return
  let snap
  try {
    let kept
    ;[kept, snap] = snapshotSession()
    sessionSaved = kept
  } catch { sessionSaved = false }
  if (!snap) return
  try { localStorage.setItem(SESSION_KEY, JSON.stringify(snap)) } catch { sessionSaved = false }
  mirrorSession(snap, final)
}
const scheduleSession = () => { if (sessionReady) { clearTimeout(sessionTimer); sessionTimer = setTimeout(persistSession, 400) } }
for (const ev of ['input', 'change', 'click', 'keyup', 'scroll']) document.addEventListener(ev, scheduleSession, true)
window.addEventListener('pagehide', () => persistSession(true))
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') persistSession(true) })

function readSession(root) {
  try {
    const s = JSON.parse(localStorage.getItem(SESSION_KEY))
    return s?.v === 1 && s.root === root ? s : null
  } catch { return null }
}

// The inputs that the first render and the first diff read, put back before either runs.
function restoreInputs(s) {
  const pick = (id, v) => { if (typeof v === 'string') $(id).value = v }
  if ([...$('#diff-scope').options].some(o => o.value === s.scope)) $('#diff-scope').value = s.scope
  pick('#diff-from', s.from); pick('#diff-to', s.to); pick('#diff-commit', s.commit)
  $('#ignore-ws').checked = !!s.ws
  if (s.dots === '...') setRangeDots('...')
  syncScopeInputs()
  if (s.scope === 'commit' && typeof s.full === 'string') { state.commit = s.full; renderHistoryCurrent() }
  pick('#file-filter', s.filter); pick('#commit-message', s.message)
  state.folded = new Map(s.folded || []); state.dirOpen = new Map(s.dirOpen || [])
  state.qClosed = new Set(s.qClosed || []); state.bClosed = new Set(s.bClosed || [])
  const q = s.search || {}
  pick('#search-input', q.q)
  for (const k of Object.keys(state.search.opts)) state.search.opts[k] = !!q.opts?.[k]
  document.querySelectorAll('.search-opts button').forEach(b => b.setAttribute('aria-pressed', state.search.opts[b.dataset.opt]))
}

async function restoreTabs(s) {
  const got = await Promise.all((s.tabs || []).map(async t => { try { return [t, await fetchFile(t.path)] } catch { return [t, null] } }))
  for (const [t, data] of got) {
    const d = t.draft
    if (!data && !d) continue
    const tab = { path: t.path, seen: state.changes.get(t.path)?.hash ?? null, preview: isMarkdown(t.path) && !!t.preview, mdScroll: t.mdScroll, caret: t.caret, scroll: t.scroll }
    if (data) Object.assign(tab, fromDisk(data))
    else Object.assign(tab, { content: '', saved: null, eol: '\n', hash: d.hash, binary: false, conflict: 'deleted' })
    if (d && !tab.binary) {
      tab.content = d.content
      // The file moved on while away: keep the base the edit was made on, so saving asks before overwriting.
      if (data && data.hash !== d.hash) Object.assign(tab, { hash: d.hash, conflict: 'changed' })
    }
    state.tabs.push(tab)
  }
  state.active = state.tabs.findIndex(t => t.path === s.active)
  if (state.active < 0 && state.tabs.length) state.active = 0
  if (state.tabs.some(t => t.conflict)) setStatus('Restored your session — some files changed on disk while you were away', 'err')
}

async function restoreView(s) {
  const L = s.log || {}
  $('#log-q').value = L.q || ''; $('#log-author').value = L.author || ''; $('#log-path').value = L.path || ''
  const ref = $('#log-ref')
  if (L.ref) { if (![...ref.options].some(o => o.value === L.ref)) ref.add(new Option(L.ref, L.ref)); ref.value = L.ref }
  state.log.sel = L.sel || ''
  await restoreTabs(s)
  state.selected = s.selected || ''
  // The review is still the visible mode here, so its scroll position can be set before it is left.
  const at = s.diffPos, i = at ? state.diffFiles.findIndex(f => f.path === at.path) : -1
  if (i >= 0) {
    state.current = -1
    const view = $('#diff'), el = view.querySelector(`.dfile[data-i="${i}"]`)
    if (el) { view.scrollTop = offsetIn(el, view) + at.off; updateCurrent() }
  }
  setRail(document.querySelector(`.rail-switch [data-rail="${s.rail}"]`) && s.rail !== 'logside' ? s.rail : state.rail)
  if (document.querySelector(`.insp-switch [data-insp="${s.insp}"]`)) setInspector(s.insp)
  // Applied after the config, which decides whether the drawer is pinned open.
  if (s.drawer && !gitPinned()) { $('.desk').classList.add('git-open'); markRail() }
  const mode = s.mode === 'file' && !activeTab() ? 'diff' : s.mode
  if (['file', 'log'].includes(mode)) await setMode(mode)
  renderTabs(); renderTree(); renderQueue()
  if ((s.search?.q || '').length >= 2) scheduleSearch(0)
}

// Status messages that arrive while booting wait, so they cannot render over a half-restored page.
let booting = true, pendingStatus = null
async function boot() {
  try {
    const [, status] = await Promise.all([loadConfig(), api('/api/git/status')])
    let saved = readSession(status.root)
    const remote = await api('/api/drafts').then(d => d.session, () => null)
    if (remote?.v === 1 && remote.root === status.root && (!saved || (remote.t || 0) > (saved.t || 0))) saved = remote
    if (saved) restoreInputs(saved)
    state.treeStale = true
    applyStatus(status)
    await ensureTree()
    renderTree()
    await loadDiff()
    if (saved) await restoreView(saved)
    // The workspace overview links to a changed file as /r/<id>/#diff=<path>.
    const open = decodeURIComponent(location.hash).match(/^#diff=(.+)$/)
    if (open) {
      history.replaceState(null, '', location.pathname)
      booting = false
      await goTo(open[1])
    }
  } catch (e) { setStatus(e.message, 'err') }
  booting = false
  sessionReady = true
  if (pendingStatus) applyStatus(pendingStatus)
  persistSession()
}
syncScopeInputs()
Object.assign(ctx, { currentPath, rerenderAll: () => { if (state.diffFiles.length) renderDiff() }, undoLastCommit, openPalette, reopenClosedTab, openFileHistory, closeTab, showFind, stepFind, renderTabs, openFile, searchRegex, revealMatch, closeFind, runSearch, visibleRange, lineTop, tabLines, lineCount, find, hunkLabel, placeCaret, renderEditor, paintAll: () => { paintGutter(); paintSyntax(); paintFind() }, resetMetrics: () => { charWidth = 0; wrap.tab = null }, onConfig: () => { Ed.applySettings(); TD.applyTabOrder(); applyWsBar() }, rebaseUI, compareUI, showCommitDiff, startCompare, setMode, setLogRef, setInspector, toggleGit, setRail, saveFile, state, $, api, post, ask, setStatus, scope, gitAction, copyText, goHunk, goTo, rerenderFile, esc, plural, ago, basename, dirname, openFile, refreshAll, activeTab, loadDiff, renderDiff })
R.initReview()
Ops.initOps()
Pv.initPreview()
FO.initFileOps()
Ed.initEditor()
Rp.initReplace()
T.initTools()
G.init()
TD.initTabDrag()
boot()
// Geist Mono can arrive after the first paint; the editor's measured character width and wrap
// heights belong to whichever font was showing, so they are measured again once it is in.
document.fonts?.ready.then(() => { charWidth = 0; wrap.tab = null; if (state.mode === 'file') renderEditor() })
if (BASE) startWsBar()
const events = new EventSource(withBase('/api/stream'))
// After a lost connection the server may have restarted with new history; forget the refs key so the
// first status after reconnecting reloads History and the Log.
events.onopen = () => {
  $('.live').classList.remove('off')
  clearStatus()
  if (state.disconnected) { state.disconnected = false; state.refsKey = '' }
}
events.onmessage = e => { const st = JSON.parse(e.data); if (booting) pendingStatus = st; else applyStatus(st) }
events.onerror = () => { state.disconnected = true; $('.live').classList.add('off'); setStatus('Lost the echo server — retrying…', 'err', true) }
