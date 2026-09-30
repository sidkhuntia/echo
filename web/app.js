import { renderMarkdown, sanitize } from './markdown.js'
import { highlight, highlightLines } from './highlight.js'

const $ = s => document.querySelector(s)
const state = {
  tree: [], treeStale: true, tabs: [], active: -1, selected: '',
  status: null, changes: new Map(), folded: new Map(),
  config: { vim: false, theme: 'system', diffMode: 'unified' }, mode: 'diff', rail: 'changes', dirOpen: new Map(),
  diffFiles: [], diffSeq: 0, current: -1, commit: '', returnTo: '', statusSeq: 0,
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
  // widths: the side panels' dragged widths, written to the desk grid as --tree-w and --git-w.
  widths: { tree: 272, git: 300 },
  // search: the Search rail. ran is the query and options the shown results came from; ctl aborts the one in flight.
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
  const res = await fetch(url, opts)
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

function setStatus(msg, kind = '') {
  const text = String(msg ?? '').trim()
  const s = $('#status')
  s.textContent = text.split('\n').find(l => l.trim()) || 'done'
  s.title = text
  s.className = kind
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
  renderGit(); renderQueue()
  if (state.rail === 'files') ensureTree().then(renderTree)
  // Files changed on disk, so shown line numbers may be stale.
  if (state.search.res) scheduleSearch()
  syncTabs()
  refreshGutter()
  if (LIVE.includes(scope())) state.mode === 'diff' ? scheduleDiff() : (state.diffStale = true)
}

function staleBuild() {
  if (state.tabs.some(t => t.content !== t.saved)) {
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
  try { state.tree = await api('/api/tree') } catch (e) { setStatus(e.message, 'err') }
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
  $('.filter-row').hidden = rail === 'search'
  $('#file-filter').placeholder = rail === 'branches' ? 'Filter branches' : 'Filter paths'
  if (rail === 'files') ensureTree().then(renderTree)
  else if (rail === 'branches') renderBranches()
  else if (rail === 'search') $('#search-input').focus()
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
    q.innerHTML = `<div class="empty"><b>No changes</b>The working tree matches HEAD.</div>`
    return
  }
  const filter = $('#file-filter').value.toLowerCase()
  const list = all.filter(c => !filter || c.path.toLowerCase().includes(filter))
  const row = (c, sec) => {
    const acts = [
      c.code[1] !== 'D' && c.code !== 'D ' ? iconBtn('open', ICON.open, 'Open file') : '',
      sec === 'work' ? iconBtn('discard', ICON.discard, c.code === '??' ? 'Delete this untracked file' : 'Discard unstaged changes') : '',
      sec === 'staged' ? iconBtn('unstage', ICON.minus, 'Unstage') : iconBtn('stage', ICON.plus, sec === 'merge' ? 'Mark resolved (stage)' : 'Stage'),
    ].join('')
    const st = sec === 'staged' ? c.index : sec === 'work' ? c.work : null
    return `<div class="qrow" data-path="${esc(c.path)}" data-sec="${sec}" title="${esc(c.path)}">
      <span class="qpath">${nameFirst(c.path)}</span>
      <span class="qacts">${acts}</span>
      <span class="qmeta">${sideStat(st)}${sideTag(c, sec)}</span>
    </div>`
  }
  const bulk = { staged: iconBtn('unstage-all', ICON.minus, 'Unstage all'), work: iconBtn('discard-all', ICON.discard, 'Discard all unstaged changes') + iconBtn('stage-all', ICON.plus, 'Stage all changes'), merge: iconBtn('stage-all', ICON.plus, 'Mark all resolved (stage)') }
  let h = ''
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
  if (ok) discard(rows.map(c => c.path), true)
}

// Build a folder tree from the flat, sorted path list. Folders open by default when they hold a change or the open file.
function buildTree(paths) {
  const root = { dirs: new Map(), files: [], changed: 0 }
  for (const p of paths) {
    const parts = p.split('/')
    let node = root
    const lineage = [root]
    for (let i = 0; i < parts.length - 1; i++) {
      const dir = parts.slice(0, i + 1).join('/')
      if (!node.dirs.has(parts[i])) node.dirs.set(parts[i], { path: dir, dirs: new Map(), files: [], changed: 0 })
      node = node.dirs.get(parts[i])
      lineage.push(node)
    }
    node.files.push(p)
    if (state.changes.has(p)) lineage.forEach(n => n.changed++)
  }
  return root
}

// The paths the tree shows: the filter, then the cap on what a browser will lay out.
const treePaths = () => {
  const filter = $('#file-filter').value.toLowerCase()
  return state.tree.map(f => f.path).filter(p => !filter || p.toLowerCase().includes(filter)).slice(0, 3000)
}
// A folder opens by default when it holds a change or the open file; a choice the user made wins.
const dirIsOpen = (d, filter, open) => filter ? true : state.dirOpen.has(d.path) ? state.dirOpen.get(d.path) : d.changed > 0 || (open || '').startsWith(d.path + '/')
const allDirs = (node, out = []) => {
  for (const [, d] of node.dirs) { out.push(d); allDirs(d, out) }
  return out
}

function renderTree() {
  if (state.rail !== 'files') return
  const filter = $('#file-filter').value.toLowerCase()
  const open = activeTab()?.path
  const root = buildTree(treePaths())
  const isOpen = d => dirIsOpen(d, filter, open)
  const pad = depth => `style="padding-left:${6 + depth * 14}px"`
  const name = n => {
    if (!filter) return esc(n)
    const at = n.toLowerCase().indexOf(filter)
    return at < 0 ? esc(n) : `${esc(n.slice(0, at))}<mark>${esc(n.slice(at, at + filter.length))}</mark>${esc(n.slice(at + filter.length))}`
  }
  const render = (node, depth) => {
    let h = ''
    for (const [n, d] of [...node.dirs].sort((a, b) => a[0].localeCompare(b[0]))) {
      const o = isOpen(d)
      h += `<div class="tnode dir" data-dir="${esc(d.path)}" ${pad(depth)} title="${esc(d.path)}"><span class="tw">${o ? '▾' : '▸'}</span><svg class="i ic" viewBox="0 0 16 16"><path d="M2 4.5h4l1.5 1.5H14v6.5H2z"/></svg><span class="nm">${esc(n)}</span>${d.changed ? `<span class="count">${d.changed}</span>` : ''}</div>`
      if (o) h += render(d, depth + 1)
    }
    for (const p of node.files) {
      const c = state.changes.get(p)
      h += `<div class="tnode ${state.selected === p || open === p ? 'active' : ''}" data-path="${esc(p)}" ${pad(depth)} title="${esc(p)}"><span class="tw"></span><svg class="i ic" viewBox="0 0 16 16"><path d="M4 2h5l3 3v9H4z"/><path d="M9 2v3h3"/></svg><span class="nm">${name(basename(p))}</span>${c ? codeTag(c) : ''}</div>`
    }
    return h
  }
  $('#tree').innerHTML = render(root, 0) || `<div class="empty">No path matches.</div>`
  syncTreeCollapse(root)
}

function toggleDir(path) {
  const row = $(`#tree .tnode.dir[data-dir="${CSS.escape(path)}"]`)
  state.dirOpen.set(path, row?.querySelector('.tw').textContent !== '▾')
  renderTree()
}

// One button folds every folder in the tree and unfolds them again. A filter already shows the tree
// flattened, so there is nothing to fold while one is typed and the button steps out of the way.
function syncTreeCollapse(root = buildTree(treePaths())) {
  if (state.rail !== 'files') return
  const b = $('#tree-collapse')
  b.hidden = !!$('#file-filter').value.trim()
  const open = allDirs(root).some(d => dirIsOpen(d, false, activeTab()?.path))
  b.innerHTML = ICON[open ? 'fold' : 'unfold']
  b.title = open ? 'Collapse all folders' : 'Expand all folders'
}

$('#tree-collapse').onclick = () => {
  const dirs = allDirs(buildTree(treePaths()))
  const open = !dirs.some(d => dirIsOpen(d, false, activeTab()?.path))
  dirs.forEach(d => state.dirOpen.set(d.path, open))
  renderTree()
}

const stage = paths => paths.length && gitAction({ action: 'add', paths })
const unstage = paths => paths.length && gitAction({ action: 'unstage', paths })
// From the unstaged list or view only the working tree goes back to the index; elsewhere the file returns to HEAD.
const discard = (paths, worktree) => paths.length && gitAction({ action: 'discard', paths, worktree })

// ---------- diff ----------
function unquote(p) {
  p = p.replace(/\t$/, '')
  if (p.startsWith('"')) try { return JSON.parse(p) } catch {}
  return p
}

function parseDiff(text) {
  const files = []
  let f = null, h = null, o = 0, n = 0
  const finish = () => { if (f) f.path = f.plus ?? f.minus ?? f.path }
  for (const line of text.split('\n')) {
    if (line.startsWith('diff --git ')) {
      finish()
      const rest = line.slice(11), len = (rest.length - 5) / 2
      let path = rest
      if (Number.isInteger(len) && rest.slice(2, 2 + len) === rest.slice(5 + len)) path = rest.slice(2, 2 + len)
      else { const m = rest.match(/^a\/(.*) b\/(.*)$/); if (m) path = m[2] }
      f = { path: unquote(path), hunks: [], added: 0, deleted: 0, lines: 0, isNew: false, isDeleted: false, binary: false, note: '' }
      files.push(f); h = null
      continue
    }
    if (!f) continue
    if (line.startsWith('@@')) {
      const m = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@ ?(.*)$/)
      if (!m) continue
      o = +m[1]; n = +m[2]
      h = { range: line.slice(0, line.indexOf('@@', 2) + 2), context: m[3], lines: [], nStart: n }
      f.hunks.push(h)
      continue
    }
    if (!h) {
      if (line.startsWith('--- ')) { const p = line.slice(4); if (p !== '/dev/null') f.minus = unquote(p).replace(/^a\//, '') }
      else if (line.startsWith('+++ ')) { const p = line.slice(4); if (p !== '/dev/null') f.plus = unquote(p).replace(/^b\//, '') }
      else if (line.startsWith('new file')) f.isNew = true
      else if (line.startsWith('deleted file')) f.isDeleted = true
      else if (line.startsWith('Binary files')) f.binary = true
      else if (line.startsWith('echo: ')) f.note = line.slice(6)
      continue
    }
    const c = line[0]
    if (c === '+') { h.lines.push({ t: 'add', n: n++, text: line.slice(1) }); f.added++ }
    // `at` is where a deleted line would sit in the new version, so it can still jump to the editor.
    else if (c === '-') { h.lines.push({ t: 'del', o: o++, at: n, text: line.slice(1) }); f.deleted++ }
    else if (c === ' ') h.lines.push({ t: 'ctx', o: o++, n: n++, text: line.slice(1) })
    else if (c === '\\') h.lines.push({ t: 'meta', text: line.slice(2) })
    else continue
    f.lines++
  }
  finish()
  return files
}

let diffTimer
function scheduleDiff() { clearTimeout(diffTimer); diffTimer = setTimeout(loadDiff, 120) }

async function loadDiff() {
  state.diffStale = false
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
  const seq = ++state.diffSeq
  try {
    const data = await api('/api/diff?' + params)
    if (seq !== state.diffSeq) return
    state.diffFiles = parseDiff(data.text)
    renderDiff()
  } catch (e) {
    if (seq === state.diffSeq) diffMessage('Can’t diff that', e.message)
  }
}

function diffMessage(title, body) {
  state.diffFiles = []
  state.current = -1
  $('#diff-summary').textContent = ''
  $('#diff').innerHTML = `<div class="diff-empty"><div class="empty"><b>${esc(title)}</b>${esc(body)}</div></div>`
}

function isFolded(f) {
  if (state.folded.has(f.path)) return state.folded.get(f.path)
  return GENERATED.test(f.path) || f.lines > 1500
}

function renderDiff() {
  const files = state.diffFiles
  const added = files.reduce((s, f) => s + f.added, 0), deleted = files.reduce((s, f) => s + f.deleted, 0)
  $('#diff-summary').innerHTML = files.length ? `${files.length} file${files.length === 1 ? '' : 's'}  <span class="add">+${added}</span> <span class="del">−${deleted}</span>` : ''
  if (!files.length) {
    const why = { head: ['Nothing to review', 'The working tree matches HEAD. When an agent writes something, it shows up here.'], worktree: ['No unstaged changes', 'Everything is staged or clean.'], staged: ['Nothing staged', 'Stage files from the sidebar to build a commit.'] }[scope()] || ['No differences', 'These refs point at the same content.']
    return diffMessage(...why)
  }
  const view = $('#diff'), top = view.scrollTop
  view.innerHTML = files.map(fileHTML).join('')
  view.scrollTop = top
  state.current = -1
  updateCurrent()
}

function rerenderFile(i) {
  const sec = $(`#diff .dfile[data-i="${i}"]`)
  if (!sec) return
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

function fileHTML(f, i) {
  const sc = scope()
  const c = LIVE.includes(sc) ? state.changes.get(f.path) : null
  const folded = isFolded(f)
  const kind = f.isNew ? 'new' : f.isDeleted ? 'deleted' : 'modified'
  const letter = f.isNew ? 'A' : f.isDeleted ? 'D' : 'M'
  const canStage = c && (c.work || conflicted(c)) && sc !== 'staged'
  const canUnstage = c && c.index && !conflicted(c) && sc !== 'worktree'
  const acts = [
    !f.isDeleted ? '<button class="btn quiet sm" data-act="open" title="o">Open</button>' : '',
    state.status?.git ? '<button class="btn quiet sm" data-act="history" title="Commits that changed this file">History</button>' : '',
    c ? `<button class="btn quiet sm" data-act="discard" title="${sc === 'worktree' ? 'Discard unstaged changes' : 'Discard every change since HEAD, staged or not'}">Discard</button>` : '',
    canUnstage ? `<button class="btn quiet sm" data-act="unstage" title="Unstage">${ICON.minus}Unstage</button>` : '',
    canStage ? `<button class="btn quiet sm" data-act="stage" title="Stage">${ICON.plus}Stage</button>` : '',
  ].join('')
  let body = ''
  if (!folded) {
    if (f.note) body = `<div class="dnote">${esc(f.note)}</div>`
    else if (f.binary) body = `<div class="dnote">Binary file — not shown.</div>`
    else if (!f.hunks.length) body = `<div class="dnote">${f.isNew ? 'Empty new file.' : 'Mode or metadata change only.'}</div>`
    else body = f.hunks.map((h, hi) => hunkHTML(h, hi, f.path)).join('')
  }
  const unsaved = state.tabs.some(t => t.path === f.path && t.content !== t.saved)
  const why = folded && !state.folded.has(f.path) ? (GENERATED.test(f.path) ? 'generated' : f.lines > 1500 ? 'large' : '') : ''
  const stat = f.binary ? '' : `${f.added ? `<span class="add">+${f.added}</span>` : ''}${f.deleted ? `<span class="del">−${f.deleted}</span>` : ''}${blocksHTML(f)}`
  return `<section class="dfile ${folded ? 'folded' : ''}" data-i="${i}">
    <header class="dfile-head"><span class="fold">▶</span>${badge(letter, kind)}<span class="dpath" title="${esc(f.path)}">${fullPath(f.path)}</span><span class="dstat">${stat}${why ? `<span class="note">· ${why}</span>` : ''}${unsaved ? '<span class="note unsaved" title="The diff shows the file on disk; save with ⌘S in the editor">· unsaved edits</span>' : ''}</span><span class="spacer"></span><span class="dacts">${acts}</span></header>
    <div class="dbody">${body}</div>
  </section>`
}

const rowClass = l => l.t === 'add' ? 'r-add' : l.t === 'del' ? 'r-del' : l.t === 'meta' ? 'r-meta' : ''
// data-n is the line in the new version; double-clicking any line opens the editor there.
const textCell = (l, cls) => `<span class="tx ${cls}" data-n="${l.n ?? l.at}">${l.html || esc(l.text) || ' '}</span>`

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
}

function hunkHTML(h, hi, path) {
  if (!h.colored) colorHunk(h, path)
  const split = state.config.diffMode === 'split'
  return `<div class="hunk ${split ? 'split' : ''}" data-h="${hi}"><div class="hunk-head"><span>${esc(h.range)}</span><b>${esc(h.context)}</b></div>${split ? splitRows(h) : stackedRows(h)}</div>`
}

function stackedRows(h) {
  return h.lines.map(l => {
    const cls = rowClass(l)
    const sign = l.t === 'add' ? '+' : l.t === 'del' ? '−' : ''
    return `<span class="no ${cls}">${l.o ?? ''}</span><span class="no ${cls}">${l.n ?? ''}</span><span class="sg ${cls}">${sign}</span>${textCell(l, cls)}`
  }).join('')
}

// Split view: old on the left, new on the right. A run of deletions followed by additions is paired
// row by row; the shorter side is padded with empty cells.
function splitRows(h) {
  const side = (l, isNew) => {
    if (!l) return `<span class="no r-none ${isNew ? 'ns' : ''}"></span><span class="tx r-none"></span>`
    const cls = rowClass(l)
    return `<span class="no ${cls} ${isNew ? 'ns' : ''}">${isNew ? l.n : l.o}</span>${textCell(l, cls)}`
  }
  let out = '', dels = [], adds = []
  const flush = () => {
    for (let k = 0; k < Math.max(dels.length, adds.length); k++) out += side(dels[k], false) + side(adds[k], true)
    dels = []; adds = []
  }
  for (const l of h.lines) {
    if (l.t === 'del') { if (adds.length) flush(); dels.push(l) }
    else if (l.t === 'add') adds.push(l)
    else { flush(); out += l.t === 'meta' ? `<span class="meta">${esc(l.text)}</span>` : side(l, false) + side(l, true) }
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
  let cur = secs.length ? 0 : -1
  secs.forEach((s, i) => { if (offsetIn(s, view) - view.scrollTop <= 40) cur = i })
  if (cur === state.current) return
  state.current = cur
  secs.forEach((s, i) => s.classList.toggle('current', i === cur))
  markQueueCurrent()
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
  if (idx < 0) return
  hunks.forEach((h, i) => h.classList.toggle('current', i === idx))
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

function syncScopeInputs() {
  $('#range-inputs').hidden = scope() !== 'range'
  $('#diff-commit').hidden = scope() !== 'commit'
  $('#ignore-ws').closest('label').hidden = false
  if (scope() !== 'commit') state.commit = ''
  renderHistoryCurrent()
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
  return { content, saved: content, eol: crlf ? '\r\n' : '\n', hash: data.hash, binary: data.binary, conflict: '' }
}

async function openFile(path, { line = 0, fromReview = false } = {}) {
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
  state.returnTo = fromReview ? path : ''
  setMode('file')
  renderTabs()
  renderTree()
  if (line && !activeTab().binary) placeCaret(line)
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

async function closeTab(i) {
  const t = state.tabs[i]
  if (t.content !== t.saved) {
    const ok = await ask({ title: 'Close without saving', kicker: 'unsaved', tone: 'danger', ok: 'Discard edits', html: `<p><b>${esc(t.path)}</b> has changes that were never saved.</p>` })
    if (!ok || state.tabs[i] !== t) return
  }
  state.tabs.splice(i, 1)
  if (state.active >= state.tabs.length || state.active > i) state.active--
  if (state.active < 0 && state.tabs.length) state.active = 0
  renderTabs(); renderEditor()
}

function renderTabs() {
  $('#tabs').innerHTML = state.tabs.map((t, i) => `<div class="tab ${i === state.active && state.mode === 'file' ? 'active' : ''} ${t.content !== t.saved ? 'dirty' : ''}" data-i="${i}" title="${esc(t.path)}"><span>${esc(basename(t.path))}</span><button class="x" data-close="${i}" title="Close"><span>×</span></button></div>`).join('')
}

function renderEditor() {
  const file = state.mode === 'file'
  const tab = activeTab()
  const text = file && !!tab && !tab.binary
  const preview = text && isMarkdown(tab.path) && tab.preview
  const editing = text && !preview
  $('#save').hidden = !text
  $('#md-switch').hidden = !text || !isMarkdown(tab.path)
  document.querySelectorAll('#md-switch button').forEach(b => b.classList.toggle('on', (b.dataset.md === 'preview') === !!preview))
  $('#file-history').hidden = !file || !tab || !state.status?.git
  $('#blame-toggle').hidden = !editing || !state.status?.git
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
  if (editing && $('#editor').value !== tab.content) $('#editor').value = tab.content
  if (file && !text) {
    $('#highlight').innerHTML = !tab
      ? `<div class="empty"><b>No file open</b>Press <kbd>⌘K</kbd> or pick a file from the sidebar.</div>`
      : `<div class="empty"><b>Binary file</b>Not shown.</div>`
  }
  renderBanner()
  refreshGutter()
  paintSyntax()
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
  if (!rows) { layer.innerHTML = ''; return }
  const [first, last] = visibleRange(tab)
  let h = ''
  for (let i = first; i < last; i++) h += `<div class="sl" style="top:${lineTop(i) - ed.scrollTop}px">${rows[i] ?? ''}</div>`
  layer.innerHTML = `<div style="transform:translateX(${-ed.scrollLeft}px)">${h}</div>`
}

// ---------- markdown preview ----------
const isMarkdown = p => /\.(md|markdown|mdown|mkd)$/i.test(p)

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
    return rel ? `/api/raw?path=${encodeURIComponent(rel)}` : null
  }
}

function renderPreview(tab) {
  const view = $('#md')
  if (view.shownTab === tab && view.shownText === tab.content) return
  const same = view.shownTab === tab
  if (view.shownTab && !same) view.shownTab.mdScroll = view.scrollTop
  const doc = document.createElement('article')
  doc.className = 'md-doc'
  doc.append(...sanitize(renderMarkdown(tab.content), mdURL(tab)).childNodes)
  view.replaceChildren(doc)
  paintPreview(doc)
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

// Lines without the empty string after a final newline, so the phantom last line never gets a bar.
function splitLines(text) {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  if (lines.length && lines.at(-1) === '') lines.pop()
  return lines
}

// lineDiff compares line arrays: marks[i] is 'add' or 'mod' for changed lines of b, and dels holds the
// b positions where lines of a were removed with nothing added in their place.
function lineDiff(a, b) {
  let s = 0
  while (s < a.length && s < b.length && a[s] === b[s]) s++
  let ea = a.length, eb = b.length
  while (ea > s && eb > s && a[ea - 1] === b[eb - 1]) { ea--; eb-- }
  const marks = [], dels = new Set()
  const ops = myers(a.slice(s, ea), b.slice(s, eb))
  if (!ops) {
    // Too different to diff cheaply: call the whole middle modified.
    for (let i = s; i < eb; i++) marks[i] = 'mod'
    if (eb === s && ea > s) dels.add(s)
    return { marks, dels }
  }
  let j = s, removed = 0, added = []
  const flush = () => {
    for (const k of added) marks[k] = removed ? 'mod' : 'add'
    if (removed && !added.length) dels.add(j)
    removed = 0; added = []
  }
  for (const op of ops) {
    if (op === '=') { flush(); j++ }
    else if (op === '-') removed++
    else { added.push(j); j++ }
  }
  flush()
  return { marks, dels }
}

// Myers' O(ND) diff, returning '=', '-', '+' ops, or null when the edit distance passes the limit.
function myers(a, b, limit = 2000) {
  const n = a.length, m = b.length
  if (!n) return Array(m).fill('+')
  if (!m) return Array(n).fill('-')
  const max = n + m, off = max
  const v = new Int32Array(2 * max + 2)
  const trace = []
  for (let d = 0; d <= Math.min(max, limit); d++) {
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? v[off + k + 1] : v[off + k - 1] + 1
      let y = x - k
      while (x < n && y < m && a[x] === b[y]) { x++; y++ }
      v[off + k] = x
      if (x >= n && y >= m) { trace.push(v.slice(off - d, off + d + 1)); return backtrack(trace, n, m) }
    }
    trace.push(v.slice(off - d, off + d + 1))
  }
  return null
}

function backtrack(trace, n, m) {
  const ops = []
  let x = n, y = m
  for (let d = trace.length - 1; d > 0; d--) {
    const prev = trace[d - 1], at = kk => prev[kk + d - 1]
    const k = x - y
    const pk = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1
    const px = at(pk), py = px - pk
    while (x > px && y > py) { ops.push('='); x--; y-- }
    if (pk === k + 1) { ops.push('+'); y-- } else { ops.push('-'); x-- }
  }
  while (x > 0 && y > 0) { ops.push('='); x--; y-- }
  return ops.reverse()
}

// Only the visible rows are drawn, so large files cost the same as small ones.
function paintGutter() {
  const g = $('#gutter'), ed = $('#editor'), tab = activeTab()
  if (state.mode !== 'file' || !tab || tab.binary) { g.innerHTML = ''; return }
  const n = lineCount(tab), mk = tab.marks
  const [first, last] = visibleRange(tab)
  // The blame column labels the first line of each run of lines from the same commit.
  const bl = state.blameGutter && freshBlame(tab)
  let h = ''
  for (let i = first; i < last; i++) {
    const kind = mk?.kinds[i], del = mk?.dels.get(i), end = i === n - 1 ? mk?.dels.get(n) : undefined
    let who = ''
    if (bl) {
      const k = bl.lines[i], c = bl.commits[k]
      if (c && (i === first || bl.lines[i - 1] !== k)) who = uncommitted(c) ? '<span class="gbl new">Not committed yet</span>'
        : `<span class="gbl" data-hash="${esc(c.hash)}" title="${esc(c.summary)}\n${esc(c.author)}, ${esc(new Date(c.time * 1000).toLocaleString())}\n${esc(c.hash.slice(0, 7))} · click to see the commit">${esc(c.author)} · ${ago(c.time).replace(' ago', '')}</span>`
    }
    h += `<div class="gl" style="top:${lineTop(i) - ed.scrollTop}px${state.wrap ? `;height:${wrap.h[i]}px` : ''}">${who}${i + 1}`
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
  if (!tab || tab.binary || state.mode !== 'file') return
  tab.content = $('#editor').value
  try {
    const content = tab.eol === '\r\n' ? tab.content.replace(/\n/g, '\r\n') : tab.content
    const res = await post('/api/file', { action: 'save', path: tab.path, content, baseHash: force ? '' : tab.hash })
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
  if (was === 'diff' && m !== 'diff') state.diffScroll = $('#diff').scrollTop
  state.mode = m
  document.querySelectorAll('.mode-switch button').forEach(b => b.classList.toggle('on', b.dataset.mode === m))
  $('#diff-bar').hidden = m !== 'diff'
  $('#file-bar').hidden = m !== 'file'
  $('#log-bar').hidden = m !== 'log'
  $('#log').classList.toggle('active', m === 'log')
  if (m !== 'diff') state.fromLog = false
  // The Log gets IntelliJ's branch list beside it; leaving puts the sidebar back as it was.
  if (m === 'log' && was !== 'log' && state.rail !== 'branches' && state.status?.git) { state.railBeforeLog = state.rail; setRail('branches') }
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
  renderTabs(); renderEditor(); markQueueCurrent()
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
  const bit = (cls, n, word) => n ? `<span class="${cls}"><i></i>${n} ${word}</span>` : ''
  $('#commit-tally').innerHTML = bit('s', t.staged.length, 'staged') + bit('u', t.unstaged.length, 'unstaged') || 'Clean'
  $('#commit-label').textContent = all ? 'Stage all & Commit' : 'Commit'
  const hint = $('#commit-hint')
  hint.hidden = !(all && t.unstaged.length)
  hint.textContent = `Stages ${plural(t.unstaged.length, 'unstaged change')} first, after you confirm.`
  $('#revert-bar').hidden = !state.status?.reverting
  $('#commit-menu').innerHTML = (all
    ? '<button class="menu-item" data-c="staged" role="menuitem">Commit staged only</button>'
    : '<button class="menu-item" data-c="all" role="menuitem">Stage all & Commit</button>')
    + '<button class="menu-item" data-c="amend" role="menuitem">Amend last commit</button>'
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
  if (box.value.trim()) return gitAction({ action: 'amend', message: box.value })
  const head = state.status?.head
  if (!head) return setStatus('There is no commit to amend yet', 'err')
  try {
    const d = await api('/api/commit?hash=' + encodeURIComponent(head))
    box.value = d.body ? d.subject + '\n\n' + d.body : d.subject
    box.focus()
    setStatus('Edit the message, then choose Amend last commit again')
  } catch (e) { setStatus(e.message, 'err') }
}

// Committing everything is the one commit that reaches past what the user staged, so it always asks.
async function doCommit(all) {
  const message = $('#commit-message').value
  if (!message.trim()) { setStatus('Write a commit message first', 'err'); $('#commit-message').focus(); return }
  if (!all) return gitAction({ action: 'commit', message })
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
  if (ok) gitAction({ action: 'commit:all', message })
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
  $('#stashes').innerHTML = (s.stashes || []).map(x => `<div class="list-row"><span title="${esc(x.subject)}"><b>${esc(x.ref)}</b> ${esc(x.subject)}</span><button class="btn sm" data-act="apply" data-ref="${esc(x.ref)}">Apply</button><button class="btn sm quiet" data-act="drop" data-ref="${esc(x.ref)}" title="Drop this stash; its changes are only in the reflog afterwards">Drop</button></div>`).join('') || '<div class="list-row muted"><span>No stashes</span></div>'
  // History and the log reload only when HEAD or a ref moved; "contains" answers go stale at the same moment.
  const key = `${s.head || ''}:${s.refsSig || ''}`
  if (key !== state.refsKey) {
    state.refsKey = key
    state.contains.clear()
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
  if (!isCur && cur) {
    a.push([`Merge into ${cur}`, { action: 'merge', from: ref }])
    a.push([`Rebase ${cur} onto this`, { action: 'rebase', from: ref }])
    a.push([`Compare with ${cur}`, 'compare'])
  }
  a.push(['Show in Log', 'log'])
  if (kind === 'local' && !isCur) a.push(['Delete', { action: 'branch:delete', from: ref }, 'danger'])
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
  } else if (what === 'compare') {
    startCompare(state.status.branch, ref)
  } else if (what === 'log') {
    await setMode('log')
    setLogRef(ref)
  } else await gitAction(what)
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
async function toggleRepoPop(open = $('#repo-pop').hidden) {
  $('#repo-pop').hidden = !open
  $('#repo').classList.toggle('open', open)
  if (!open) return
  toggleThemes(false)
  toggleBranchPop(false)
  $('#repo-filter').value = ''
  $('#repo-filter').focus()
  renderRepoPop()
  try { repos = await api('/api/instances') } catch (e) { setStatus(e.message, 'err') }
  // Start on the first other repository, so ⌘⇧O then Enter hops away like an app switcher.
  repoSel = Math.max(0, repos.findIndex(r => r.port !== +location.port))
  if (!$('#repo-pop').hidden) renderRepoPop()
}

const repoMatches = () => { const f = $('#repo-filter').value.toLowerCase(); return repos.filter(r => !f || r.root.toLowerCase().includes(f)) }

function renderRepoPop() {
  const here = +location.port, list = repoMatches()
  repoSel = Math.min(repoSel, Math.max(0, list.length - 1))
  $('#repo-list').innerHTML = list.map((r, i) => `<div class="th rp-row ${r.port === here ? 'on' : ''} ${i === repoSel ? 'sel' : ''}" data-port="${r.port}" data-i="${i}" title="${esc(r.root)}">
    <span class="ok">${r.port === here ? '✓' : ''}</span>
    <span><div class="nm">${esc(basename(r.root))}${r.branch ? ` <span class="meta">· ${esc(r.branch)}</span>` : ''}${r.changes ? ` <span class="meta">· ${r.changes} changed</span>` : ''}</div><div class="path">${esc(r.root)}</div></span>
    <span class="rp-end"><span class="port">:${r.port}</span><button class="rp-stop" data-repo-stop="${r.port}" title="Stop this echo process">Stop</button></span></div>`).join('')
    || `<div class="bp-more faint">${repos.length ? 'No open repository matches.' : 'Looking for open repositories…'}</div>`
  $('#repo-list .sel')?.scrollIntoView({ block: 'nearest' })
}

function switchRepo(port, newTab) {
  const url = `http://127.0.0.1:${port}/`
  toggleRepoPop(false)
  if (newTab) window.open(url, '_blank')
  else if (port !== +location.port) location.href = url
}

// stopRepo shuts one echo process down, or every one of them. The request is answered before the
// server stops, so the tab that asked can say so; a tab on the stopped repository keeps its page and
// says the server is gone, like any other lost connection.
async function stopRepo(port, all) {
  const what = all ? 'every echo process' : basename(repos.find(r => r.port === port)?.root || '')
  const ok = await ask({ title: all ? 'Stop every echo process' : `Stop ${what}`, kicker: 'stops echo', tone: 'danger', ok: 'Stop', html: `<p>${all ? 'Every repository open in echo will stop.' : `<b>${esc(what)}</b>’s echo process will stop.`}</p><p class="note">Running work is finished first. Reopen a repository with the <code>echo</code> command in its folder.</p>` })
  if (!ok) return
  try { await post('/api/shutdown', { port: all ? 0 : port, all }) } catch (e) { return setStatus(e.message, 'err') }
  if (all || port === +location.port) return setStatus('echo is stopping.', 'ok')
  setStatus(`stopped ${what}`, 'ok')
  repos = repos.filter(r => r.port !== port)
  renderRepoPop()
}

// ---------- graph ----------
// layoutGraph assigns each commit a lane. lanes[j] is the commit that lane j is heading down to;
// a row records the lanes above it (before), below it (after), which lanes end in its node (into),
// and which lane each parent continues on (out). Lanes are not compacted, so a lane keeps its column.
const LANE = 12, HUES = 8, LOG_H = 26, HIST_H = 44
function layoutGraph(commits) {
  const lanes = [], rows = []
  let color = 0
  const free = () => { const i = lanes.findIndex(l => !l); return i < 0 ? lanes.length : i }
  for (const c of commits) {
    const before = lanes.slice()
    let col = lanes.findIndex(l => l && l.hash === c.hash)
    if (col < 0) { col = free(); lanes[col] = { hash: c.hash, color: color++ } }
    const own = lanes[col].color
    const into = []
    lanes.forEach((l, j) => { if (l && j !== col && l.hash === c.hash) { into.push(j); lanes[j] = null } })
    const out = c.parents.map((p, k) => {
      if (k === 0) { lanes[col] = { hash: p, color: own }; return col }
      let j = lanes.findIndex(l => l && l.hash === p)
      if (j < 0) { j = free(); lanes[j] = { hash: p, color: color++ } }
      return j
    })
    if (!c.parents.length) lanes[col] = null
    while (lanes.length && !lanes[lanes.length - 1]) lanes.pop()
    rows.push({ col, color: own, before, after: lanes.slice(), into, out, merge: c.parents.length > 1 })
  }
  return rows
}

const graphWidth = rows => LANE * Math.min(16, Math.max(1, ...rows.map(r => Math.max(r.before.length, r.after.length, r.col + 1))))
const laneX = j => LANE / 2 + j * LANE

function graphSVG(r, h, w) {
  const m = h / 2, cx = laneX(r.col)
  const seg = (d, color) => `<path d="${d}" class="g${color % HUES}"/>`
  const curve = (x1, y1, x2, y2) => `M${x1} ${y1}C${x1} ${(y1 + y2) / 2} ${x2} ${(y1 + y2) / 2} ${x2} ${y2}`
  let p = ''
  r.before.forEach((l, j) => {
    if (!l) return
    if (j === r.col) p += seg(`M${cx} 0V${m}`, l.color)
    else if (r.into.includes(j)) p += seg(curve(laneX(j), 0, cx, m), l.color)
    else p += seg(`M${laneX(j)} 0V${h}`, l.color)
  })
  r.out.forEach(j => { p += seg(j === r.col ? `M${cx} ${m}V${h}` : curve(cx, m, laneX(j), h), r.after[j].color) })
  return `<svg class="graph" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" aria-hidden="true">${p}<circle cx="${cx}" cy="${m}" r="3.5" class="g${r.color % HUES}${r.merge ? ' m' : ''}"/></svg>`
}

// railSVG carries the lanes below a row through a block of any height (the expanded History detail).
function railSVG(lanes, w) {
  const p = lanes.map((l, j) => l ? `<path d="M${laneX(j)} 0V10" class="g${l.color % HUES}" vector-effect="non-scaling-stroke"/>` : '').join('')
  return `<svg class="graph rail" width="${w}" viewBox="0 0 ${w} 10" preserveAspectRatio="none" aria-hidden="true">${p}</svg>`
}

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
  for (const [k, id] of [['q', '#log-q'], ['author', '#log-author'], ['path', '#log-path']]) {
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
  const rowsHTML = (from, to) => L.commits.slice(from, to).map((c, k) => { const i = from + k; return `<div class="lrow ${c.hash === L.sel ? 'sel' : ''}" data-hash="${esc(c.hash)}">${graphSVG(L.rows[i], LOG_H, w)}<span class="lsub" title="${esc(c.subject)}">${refChips(c.refs)}<span class="ltext">${esc(c.subject)}</span></span><span class="lauth">${esc(c.author)}</span><span class="ltime" title="${esc(new Date(c.time * 1000).toLocaleString())}">${ago(c.time)}</span></div>` }).join('')
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

function openLogDiff() {
  const c = state.log.commits.find(c => c.hash === state.log.sel)
  if (!c) return
  state.fromLog = true
  const path = $('#log-path').value.trim()
  const shown = path ? goCommitFile(c.hash, path) : showCommitDiff(c.hash, c.short)
  shown.then(() => { state.fromLog = true; setStatus('Esc returns to the log') })
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
function renderHistory() {
  const { commits, rows } = state.hist, w = graphWidth(rows)
  $('#history').innerHTML = commits.map((c, i) => `<div class="commit-row ${c.hash === state.expanded ? 'open' : ''}" data-hash="${esc(c.hash)}" data-short="${esc(c.short)}" title="${esc(c.subject)}\nClick to show details and the diff">
      <span class="c-graph">${graphSVG(rows[i], HIST_H, w)}</span>
      <div class="c-main"><div class="c-subject">${refChips(c.refs)}${esc(c.subject)}</div>
      <div class="c-meta"><b>${esc(c.short)}</b><span class="c-author">${esc(c.author)}</span><span class="c-time" title="${esc(new Date(c.time * 1000).toLocaleString())}">${ago(c.time)}</span></div></div>
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
      <button class="btn sm" data-act="reset" ${d.hash === state.status?.head ? 'disabled' : ''} title="${d.hash === state.status?.head ? 'The branch is already at this commit; pick an older one to reset to' : 'Move the current branch back to this commit; the undone changes stay staged'}">Reset branch here</button>
      <button class="btn sm" data-act="revert" title="Add a new commit that undoes this one">Revert</button>
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
  if (state.log.sel === hash) paintLogDetail()
}

// Opening a commit shows its diff in Review; clicking the open row again folds it.
function selectCommit(hash, short = hash.slice(0, 7)) {
  state.expanded = state.expanded === hash ? '' : hash
  renderHistory()
  if (state.expanded) loadDetail(hash)
  $(`#history .commit-row[data-hash="${CSS.escape(hash)}"]`)?.scrollIntoView({ block: 'nearest' })
  return showCommitDiff(hash, short)
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
  $('#fetch').hidden = !remote
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
  $('#sync-label').textContent = tracked ? 'Sync' : 'Publish'
  $('#sync').title = tracked ? `Pull${t.behind ? ` ${t.behind}` : ''}, then push${t.ahead ? ` ${t.ahead}` : ' if ahead'} (${t.upstream})` : `Push ${t?.name || 'this branch'} and set its upstream (git push -u)`
  $('#sync').classList.toggle('attn', tracked && (t.ahead > 0 || t.behind > 0))
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

const NET = new Set(['fetch', 'pull', 'push', 'push:lease', 'push:force', 'sync', 'publish'])

async function gitAction(body, button) {
  const net = NET.has(body.action)
  if (net) { document.body.classList.add('net-busy'); button?.classList.add('busy') }
  try {
    setStatus(`git ${body.action}…`)
    const out = await post('/api/git', body)
    // Remote output leads with "To <url>" or progress lines; say what happened and keep Git's text in the tooltip.
    const done = { fetch: 'Fetched all remotes', pull: 'Pulled', push: 'Pushed', 'push:lease': 'Force pushed (with lease)', 'push:force': 'Force pushed', sync: 'Synced', publish: 'Published' }[body.action]
    setStatus(done ? `${done}\n${out.output || ''}` : out.output || `git ${body.action} done`, 'ok')
    if (['commit', 'commit:all', 'amend'].includes(body.action)) $('#commit-message').value = ''
  } catch (e) { setStatus(e.message, 'err') }
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

async function openPalette() {
  await ensureTree()
  $('#palette').hidden = false
  $('#palette-input').value = ''
  renderPalette()
  $('#palette-input').focus()
}

function renderPalette() {
  const q = $('#palette-input').value.trim().toLowerCase().replace(/\s+/g, '')
  const paths = [...new Set([...state.changes.keys(), ...state.tree.map(f => f.path)])]
  let items
  if (!q) items = paths.slice(0, 60).map(p => ({ p, hits: [] }))
  else items = paths.map(p => { const m = fuzzy(q, p); return m && { p, hits: m.hits, score: m.score + (state.changes.has(p) ? 2 : 0) } }).filter(Boolean).sort((a, b) => b.score - a.score).slice(0, 60)
  state.palette = { items, sel: 0 }
  paintPalette()
}

function paintPalette() {
  const { items, sel } = state.palette
  $('#palette-list').innerHTML = items.map((it, i) => {
    const c = state.changes.get(it.p)
    const cut = it.p.lastIndexOf('/') + 1
    const name = highlightHits(it.p.slice(cut), it.hits.filter(h => h >= cut).map(h => h - cut))
    const dir = highlightHits(it.p.slice(0, cut), it.hits.filter(h => h < cut))
    return `<div class="pitem ${i === sel ? 'sel' : ''}" data-i="${i}"><span>${name}</span><i>${dir}</i>${c ? codeTag(c) : ''}</div>`
  }).join('') || '<div class="empty">No path matches.</div>'
  $('#palette-list .sel')?.scrollIntoView({ block: 'nearest' })
}

function choosePalette(i) {
  const it = state.palette.items[i]
  if (!it) return
  $('#palette').hidden = true
  if (state.tree.some(f => f.path === it.p)) openFile(it.p)
  else goTo(it.p)
}

// ---------- themes ----------
// Ids match the [data-theme] blocks in themes.css. "system" follows macOS: echo paper when light, echo ink when dark.
const THEMES = [
  ['echo-paper', 'echo paper', 'light', 'echo'], ['github-light', 'GitHub Light', 'light', 'Primer'], ['solarized-light', 'Solarized Light', 'light', 'Solarized'],
  ['catppuccin-latte', 'Catppuccin Latte', 'light', 'Catppuccin'], ['rose-pine-dawn', 'Rosé Pine Dawn', 'light', 'Rosé Pine'],
  ['echo-ink', 'echo ink', 'dark', 'echo'], ['github-dark', 'GitHub Dark', 'dark', 'Primer'], ['nord', 'Nord', 'dark', 'Nord'],
  ['gruvbox-dark', 'Gruvbox Dark', 'dark', 'Gruvbox'], ['solarized-dark', 'Solarized Dark', 'dark', 'Solarized'], ['catppuccin-mocha', 'Catppuccin Mocha', 'dark', 'Catppuccin'],
  ['tokyo-night', 'Tokyo Night', 'dark', 'Tokyo Night'], ['rose-pine', 'Rosé Pine', 'dark', 'Rosé Pine'], ['dracula', 'Dracula', 'dark', 'Dracula'],
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

function renderThemes() {
  const q = $('#theme-filter').value.trim().toLowerCase()
  const cur = themeId()
  const item = (id, name, note, sw) => `<div class="th ${cur === id ? 'on' : ''}" data-theme-id="${id}"><span class="ok">${cur === id ? '✓' : ''}</span>${swatchHTML(sw)}${esc(name)}<small>${esc(note)}</small></div>`
  const group = kind => {
    const list = THEMES.filter(t => t[2] === kind && t[1].toLowerCase().includes(q))
    return list.length ? `<h5>${kind === 'light' ? 'Light' : 'Dark'}</h5>` + list.map(t => item(t[0], t[1], t[3], t[0])).join('') : ''
  }
  const system = !q || 'system'.includes(q) ? item('system', 'System', 'echo paper / ink', osLight.matches ? 'echo-paper' : 'echo-ink') : ''
  $('#theme-list').innerHTML = (system + group('light') + group('dark')) || '<div class="empty">No theme matches.</div>'
}

async function setTheme(id) {
  state.config.theme = id
  applyTheme()
  renderThemes()
  try { await post('/api/config', { theme: id }) } catch (e) { setStatus(e.message, 'err') }
}

function toggleThemes(open = $('#theme-pop').hidden) {
  $('#theme-pop').hidden = !open
  if (!open) return
  toggleRepoPop(false)
  $('#theme-filter').value = ''
  renderThemes()
  $('#theme-filter').focus()
}

function setInspector(tab) {
  $('#insp').dataset.insp = tab
  document.querySelectorAll('.insp-switch button').forEach(b => b.classList.toggle('on', b.dataset.insp === tab))
}

// ---------- wiring ----------
$('#queue').addEventListener('click', e => {
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
  if (act === 'stage') stage([path])
  else if (act === 'unstage') unstage([path])
  else if (act === 'discard') discard([path], true)
  else if (act === 'open') openFile(path)
  else goTo(path, sec)
})
$('#queue').addEventListener('dblclick', e => {
  const row = e.target.closest('.qrow')
  if (row && !e.target.closest('[data-act]') && state.tree.some(f => f.path === row.dataset.path)) openFile(row.dataset.path)
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
  if (row) openFile(row.dataset.path, { line: Number(row.dataset.line) })
})
// ---------- file menu ----------
// Right-click a tree row: copy its name or path, or start a new file beside it. A folder creates inside itself.
let fileMenuFor = null
function closeFileMenu() { $('#file-menu').hidden = true; fileMenuFor = null }
function openFileMenu(row, x, y) {
  const isDir = row.classList.contains('dir'), path = isDir ? row.dataset.dir : row.dataset.path
  const dir = isDir ? path : path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : ''
  fileMenuFor = { path, dir }
  const m = $('#file-menu')
  m.innerHTML = `<div class="menu-head" title="${esc(path)}"><span>${esc(basename(path))}</span></div>`
    + `<button class="menu-item" data-a="new" role="menuitem">New file${isDir ? ' in folder' : ' here'}…<kbd>⌘⌥N</kbd></button>`
    + '<div class="menu-sep"></div>'
    + '<button class="menu-item" data-a="name" role="menuitem">Copy name</button>'
    + '<button class="menu-item" data-a="rel" role="menuitem">Copy relative path</button>'
    + '<button class="menu-item" data-a="abs" role="menuitem">Copy absolute path</button>'
  m.hidden = false
  m.style.left = Math.max(8, Math.min(x, innerWidth - m.offsetWidth - 8)) + 'px'
  m.style.top = Math.max(8, Math.min(y, innerHeight - m.offsetHeight - 8)) + 'px'
  m.querySelector('.menu-item').focus()
}
async function runFileMenu(a) {
  const { path, dir } = fileMenuFor
  closeFileMenu()
  if (a === 'new') return fileAction('create', dir)
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
  const sec = e.target.closest('.dfile')
  if (!sec) return
  const i = +sec.dataset.i, f = state.diffFiles[i]
  const act = e.target.closest('[data-act]')?.dataset.act
  if (act === 'open') openFile(f.path, { fromReview: true })
  else if (act === 'stage') stage([f.path])
  else if (act === 'unstage') unstage([f.path])
  else if (act === 'discard') discard([f.path], scope() === 'worktree')
  else if (act === 'history') openFileHistory(f.path)
  else if (e.target.closest('.dfile-head')) toggleFold(i)
})
$('#diff').addEventListener('dblclick', e => {
  const cell = e.target.closest('.tx[data-n]')
  const f = cell && state.diffFiles[+cell.closest('.dfile').dataset.i]
  if (!f || f.isDeleted) return
  window.getSelection()?.removeAllRanges()
  openAtLine(f.path, +cell.dataset.n)
})
let scrollFrame
$('#diff').addEventListener('scroll', () => { cancelAnimationFrame(scrollFrame); scrollFrame = requestAnimationFrame(updateCurrent) })
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
$('#search-open').onclick = openPalette
$('#theme-open').onclick = e => { e.stopPropagation(); toggleThemes() }
$('#theme-filter').oninput = renderThemes
$('#theme-filter').addEventListener('keydown', e => {
  if (e.key === 'Escape') { e.preventDefault(); toggleThemes(false) }
  if (e.key === 'Enter') { const first = $('#theme-list .th'); if (first) setTheme(first.dataset.themeId) }
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

function detailClick(e, hash, inLog) {
  const t = e.target, hit = sel => t.closest(sel)
  if (hit('[data-act]')) {
    const b = hit('[data-act]')
    if (!b.disabled) (b.dataset.act === 'reset' ? resetHere : revertCommit)(hash)
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
    goCommitFile(hash, hit('[data-cfile]').dataset.cfile).then(() => { state.fromLog = inLog })
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
$('#log-rows').addEventListener('click', e => { const r = e.target.closest('.lrow'); if (r) selectLog(r.dataset.hash) })
$('#log-rows').addEventListener('dblclick', e => { if (e.target.closest('.lrow')) openLogDiff() })
$('#log-rows').addEventListener('scroll', () => {
  const v = $('#log-rows'), L = state.log
  if (L.more && !L.loading && v.scrollTop + v.clientHeight > v.scrollHeight - 600) loadLog(true)
})
let logTimer
for (const id of ['#log-q', '#log-author', '#log-path']) $(id).addEventListener('input', () => { clearTimeout(logTimer); logTimer = setTimeout(() => loadLog(), 250) })
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
  } else if (e.key === 'Enter' && list[repoSel]) { e.preventDefault(); switchRepo(list[repoSel].port, mod(e)) }
})
$('#repo-list').addEventListener('mousemove', e => {
  const row = e.target.closest('.rp-row')
  if (row && +row.dataset.i !== repoSel) { repoSel = +row.dataset.i; renderRepoPop() }
})
$('#repo-list').addEventListener('click', e => {
  const stop = e.target.closest('[data-repo-stop]')
  if (stop) { e.stopPropagation(); e.preventDefault(); return stopRepo(+stop.dataset.repoStop, false) }
  const row = e.target.closest('.rp-row')
  if (row) switchRepo(+row.dataset.port, mod(e))
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
const STASH_ACT = new Map([['apply', 'stash:apply'], ['drop', 'stash:drop']])
$('#stashes').addEventListener('click', e => {
  const b = e.target.closest('button[data-ref]')
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
  clearTimeout(marksTimer)
  marksTimer = setTimeout(() => { if (t === activeTab()) { computeMarks(t); paintGutter() } }, 120)
})
let marksTimer, gutterFrame
// Repaint the gutter and colors when the editor changes size (window resize, panels, a first paint
// made before layout settled); both draw only the rows that fit.
new ResizeObserver(() => { cancelAnimationFrame(gutterFrame); gutterFrame = requestAnimationFrame(() => { paintGutter(); paintSyntax() }) }).observe($('#editor'))
$('#editor').addEventListener('scroll', () => { cancelAnimationFrame(gutterFrame); gutterFrame = requestAnimationFrame(() => { paintGutter(); paintSyntax(); paintBlameGhost() }) })
let ghostFrame, blameTimer
for (const ev of ['keyup', 'mouseup', 'focus']) $('#editor').addEventListener(ev, () => { cancelAnimationFrame(ghostFrame); ghostFrame = requestAnimationFrame(paintBlameGhost) })
$('#editor').addEventListener('input', () => {
  $('#blame-ghost').hidden = true
  clearTimeout(blameTimer)
  blameTimer = setTimeout(() => ensureBlame(activeTab()), 600)
})
$('#gutter').addEventListener('click', e => { const b = e.target.closest('.gbl[data-hash]'); if (b) showCommitInLog(b.dataset.hash) })
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
$('#refresh').onclick = refreshAll
const narrow = matchMedia('(max-width: 1100px)')
const toggleTree = () => $('.desk').classList.toggle('no-tree')
const toggleLedger = () => $('.desk').classList.toggle(narrow.matches ? 'show-git' : 'no-git')
$('#tree-toggle').onclick = toggleTree
$('#git-toggle').onclick = toggleLedger

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
const gitShown = () => narrow.matches ? $('.desk').classList.contains('show-git') : !$('.desk').classList.contains('no-git')
// A panel stops at its own range, and early rather than at that range if the editor needs the room.
const clampWidth = (side, want) => {
  const [min, max] = PANEL_RANGE[side]
  const other = side === 'tree' ? (gitShown() ? state.widths.git : 0) : ($('.desk').classList.contains('no-tree') ? 0 : state.widths.tree)
  const room = Math.max(min, $('.desk').clientWidth - other - CENTER_MIN)
  return Math.round(Math.max(min, Math.min(want, max, room)))
}
let widthSave
const scheduleWidthSave = () => {
  clearTimeout(widthSave)
  // Both keys go in every patch, since the server replaces the whole panelSizes map.
  widthSave = setTimeout(() => post('/api/config', { panelSizes: { ...state.widths } }).catch(e => setStatus(e.message, 'err')), 250)
}
// The left grip grows with the pointer, the right one against it.
const dragGrip = (side, e) => {
  const grip = $(`#grip-${side}`), sign = side === 'tree' ? 1 : -1
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
    state.widths[side] = clampWidth(side, state.widths[side] + dir * (side === 'tree' ? 1 : -1) * (e.shiftKey ? 40 : 12))
    applyWidths()
    scheduleWidthSave()
  }
}
$('#commit').onclick = () => doCommit(!!state.config.commitAll)
$('#commit-more').onclick = e => { e.stopPropagation(); toggleCommitMenu($('#commit-menu').hidden) }
$('#commit-menu').addEventListener('click', e => {
  const act = e.target.closest('[data-c]')?.dataset.c
  toggleCommitMenu(false)
  if (act === 'staged') doCommit(false)
  else if (act === 'all') doCommit(true)
  else if (act === 'amend') amend()
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
$('#pull').onclick = () => gitAction({ action: 'pull' }, $('#pull'))
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
  m.innerHTML = '<button class="menu-item" data-p="lease" role="menuitem" title="git push --force-with-lease">Force push with lease</button>'
    + '<button class="menu-item danger" data-p="force" role="menuitem" title="git push --force">Force push (no lease)</button>'
  const r = $('#push-more').getBoundingClientRect()
  m.style.left = Math.max(8, r.right - m.offsetWidth) + 'px'
  m.style.top = r.bottom + 4 + 'px'
  m.querySelector('.menu-item').focus()
}
$('#push-more').onclick = e => { e.stopPropagation(); togglePushMenu($('#push-menu').hidden) }
$('#push-menu').addEventListener('click', e => {
  const p = e.target.closest('[data-p]')?.dataset.p
  togglePushMenu(false)
  if (p) forcePush(p === 'lease')
})
document.addEventListener('click', e => { if (!e.target.closest('#push-menu, #push-more')) togglePushMenu(false) })
setInterval(renderTracking, 30000)
$('#merge').onclick = () => gitAction({ action: 'merge', from: $('#branch-select').value })
$('#rebase').onclick = () => gitAction({ action: 'rebase', from: $('#branch-select').value })
$('#stash-create').onclick = () => gitAction({ action: 'stash:create', message: $('#stash-message').value }).then(() => { $('#stash-message').value = '' })
$('#file-filter').oninput = () => { renderQueue(); renderTree(); renderBranches() }
$('#diff-scope').onchange = () => { syncScopeInputs(); $('#diff').scrollTop = 0; loadDiff() }
$('#ignore-ws').onchange = loadDiff
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
  if (e.key === 'Escape' && !$('#push-menu').hidden) { e.preventDefault(); togglePushMenu(false); $('#push-more').focus(); return }
  if (e.key === 'Escape' && !$('#commit-menu').hidden) { e.preventDefault(); toggleCommitMenu(false); $('#commit-more').focus(); return }
  if (!$('#palette').hidden) return
  if (mod(e)) {
    const k = e.key.toLowerCase()
    if (k === 'o' && e.shiftKey) { e.preventDefault(); toggleRepoPop() }
    else if (k === 'f' && e.shiftKey) {
      e.preventDefault()
      $('.desk').classList.remove('no-tree')
      setRail('search')
      $('#search-input').select()
    }
    else if (k === 'k' || k === 'p') { e.preventDefault(); openPalette() }
    else if (k === 'b') { e.preventDefault(); toggleTree() }
    else if (k === 'j') { e.preventDefault(); toggleLedger() }
    else if (k === 'd') { e.preventDefault(); setMode(state.mode === 'diff' ? 'file' : 'diff') }
    else if (k === 's') { e.preventDefault(); saveFile() }
    else if (k === 'v' && e.shiftKey && state.mode === 'file' && isMarkdown(activeTab()?.path || '')) { e.preventDefault(); setPreview(!activeTab().preview) }
    else if (e.key === 'Enter' && e.target.id === 'commit-message') { e.preventDefault(); $('#commit').click() }
    return
  }
  if (e.key === 'Escape' && e.target.id === 'editor' && state.returnTo && state.returnTo === activeTab()?.path) { e.preventDefault(); backToReview(); return }
  // Keys inside the branch popup and menu belong to their buttons (Enter activates the focused item).
  if (e.key !== 'Escape' && e.target.closest?.('#ref-menu, #branch-pop')) return
  if (e.key === 'Escape' && (!$('#ref-menu').hidden || !$('#branch-pop').hidden)) { e.preventDefault(); if (!$('#ref-menu').hidden) closeRefMenu(); else toggleBranchPop(false); return }
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
    case 'o': { const p = currentPath(); if (p && state.mode === 'diff' && !state.diffFiles[state.current]?.isDeleted) openFile(p, { fromReview: true }); break }
    default: return
  }
  e.preventDefault()
})
window.addEventListener('beforeunload', e => { if (state.tabs.some(t => t.content !== t.saved)) e.preventDefault() })

async function loadConfig() {
  try { state.config = await api('/api/config'); $('#vim-mode').checked = !!state.config.vim; $('#commit-all').checked = !!state.config.commitAll; renderCommit() } catch {}
  if (state.config.diffMode !== 'split') state.config.diffMode = 'unified'
  // A hand-edited or older config can hold a width that no longer fits the range; keep the default.
  for (const side of ['tree', 'git']) {
    const w = Math.round(Number((state.config.panelSizes || {})[side]))
    if (w >= PANEL_RANGE[side][0] && w <= PANEL_RANGE[side][1]) state.widths[side] = w
  }
  applyWidths()
  $('#gutter-base').value = gutterBase()
  $('#inline-blame').checked = blameInline()
  document.querySelectorAll('.layout-switch button').forEach(b => b.classList.toggle('on', b.dataset.layout === state.config.diffMode))
  if (state.diffFiles.length) renderDiff()
  applyTheme()
}

syncScopeInputs()
loadConfig()
refreshAll()
const events = new EventSource('/api/stream')
// After a lost connection the server may have restarted with new history; forget the refs key so the
// first status after reconnecting reloads History and the Log.
events.onopen = () => {
  $('.live').classList.remove('off')
  if (state.disconnected) { state.disconnected = false; state.refsKey = '' }
}
events.onmessage = e => applyStatus(JSON.parse(e.data))
events.onerror = () => { state.disconnected = true; $('.live').classList.add('off'); setStatus('Lost the echo server — retrying…', 'err') }
