import { renderMarkdown, sanitize } from './markdown.js'

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
  // Changes rail groups (merge, staged, work) folded by the user.
  qClosed: new Set(),
  // lspExt: file extensions whose language server is missing, unsupported, or failed, so they are not asked again.
  lspExt: new Map(), installing: '', lsp: [],
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
  discard: '<svg class="i" viewBox="0 0 16 16"><path d="M5.5 3.5 3 6l2.5 2.5"/><path d="M3 6h6.5a3.5 3.5 0 0 1 0 7H7"/></svg>',
  open: '<svg class="i" viewBox="0 0 16 16"><path d="M4 2h5l3 3v9H4z"/><path d="M9 2v3h3"/></svg>',
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
  const bulk = { staged: iconBtn('unstage-all', ICON.minus, 'Unstage all'), work: iconBtn('stage-all', ICON.plus, 'Stage all changes'), merge: iconBtn('stage-all', ICON.plus, 'Mark all resolved (stage)') }
  let h = ''
  for (const g of GROUPS) {
    const rows = list.filter(g.has)
    if (!rows.length) continue
    const closed = state.qClosed.has(g.sec)
    h += `<div class="group-label qgroup" data-sec="${g.sec}"><span class="tw">${closed ? '▸' : '▾'}</span><span class="gname">${g.label}</span><span class="gacts">${bulk[g.sec]}</span><span class="count">${rows.length}</span></div>`
    if (!closed) h += rows.map(c => row(c, g.sec)).join('')
  }
  q.innerHTML = h || `<div class="empty">No changed path matches “${esc(filter)}”.</div>`
  markQueueCurrent()
}

// Bulk actions take the paths of one group as it is shown, so a filter narrows them too.
function groupPaths(sec) {
  const g = GROUPS.find(g => g.sec === sec)
  const filter = $('#file-filter').value.toLowerCase()
  return [...state.changes.values()].filter(c => g.has(c) && (!filter || c.path.toLowerCase().includes(filter))).map(c => c.path)
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

function renderTree() {
  if (state.rail !== 'files') return
  const filter = $('#file-filter').value.toLowerCase()
  const files = state.tree.map(f => f.path).filter(p => !filter || p.toLowerCase().includes(filter)).slice(0, 3000)
  const open = activeTab()?.path
  const isOpen = d => filter ? true : state.dirOpen.has(d.path) ? state.dirOpen.get(d.path) : d.changed > 0 || (open || '').startsWith(d.path + '/')
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
  $('#tree').innerHTML = render(buildTree(files), 0) || `<div class="empty">No path matches.</div>`
}

function toggleDir(path) {
  const row = $(`#tree .tnode.dir[data-dir="${CSS.escape(path)}"]`)
  state.dirOpen.set(path, row?.querySelector('.tw').textContent !== '▾')
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
    else body = f.hunks.map(hunkHTML).join('')
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
const textCell = (l, cls) => `<span class="tx ${cls}" data-n="${l.n ?? l.at}">${esc(l.text) || ' '}</span>`

function hunkHTML(h, hi) {
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
  ed.scrollTop = Math.max(0, (line - 1) * LINE - ed.clientHeight / 3)
  ed.scrollLeft = 0
  paintGutter()
}

function closeTab(i) {
  const t = state.tabs[i]
  if (t.content !== t.saved && !confirm(`Discard unsaved edits to ${t.path}?`)) return
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
  paintLspStatus()
  if (editing) requestTokens(tab)
  else renderLspBanner()
}

// ---------- syntax highlighting ----------
// Colors come from an installed language server's semantic tokens. The textarea's text turns
// transparent and a layer behind it draws the visible lines in color. Without a server the
// editor stays plain text, and a missing server gets a one-line offer to install it.
const extOf = p => (p.match(/\.[^./]+$/)?.[0] || '').toLowerCase()
let tokensTimer

async function requestTokens(tab, retry = 0) {
  if (!tab || tab.binary || isMarkdown(tab.path)) return
  if (state.lspExt.has(extOf(tab.path))) return renderLspBanner()
  if (tab.hl?.text === tab.content || tab.hlAsked === tab.content) return
  const text = tab.content
  tab.hlAsked = text
  let res
  // A request that starts a server can take a while; show "starting" meanwhile.
  const cur = serverFor(tab.path)
  if (cur?.state !== 'ready') setTimeout(refreshLsp, 400)
  try { res = await post('/api/lsp/tokens', { path: tab.path, content: text }) } catch { tab.hlAsked = null; return }
  if (res.status !== 'ok' || cur?.state !== 'ready') refreshLsp()
  if (res.status === 'error') {
    tab.hlAsked = null
    // A server that would not start stays down until Restart; a slow answer (a server still
    // importing the project, like jdtls on a Maven build) is asked again every few seconds.
    if (!/deadline|cancel/i.test(res.message || '')) {
      state.lspExt.set(extOf(tab.path), res)
      if (tab === activeTab()) setStatus(`No highlighting from ${res.server?.name}: ${res.message.split('\n')[0]}`, 'err')
    } else if (retry < 60) setTimeout(() => { if (tab === activeTab() && tab.hlAsked !== tab.content) requestTokens(tab, retry + 1) }, 3000)
    return
  }
  if (res.status !== 'ok') { state.lspExt.set(extOf(tab.path), res); return renderLspBanner() }
  // A server still loading the workspace can answer with nothing at first.
  if (!res.tokens?.length && text.trim() && retry < 3) {
    setTimeout(() => { tab.hlAsked = null; if (tab === activeTab()) requestTokens(tab, retry + 1) }, 1500 * (retry + 1))
    return
  }
  tab.hl = { text, src: text.split('\n'), lines: tokenLines(res) }
  if (tab === activeTab() && state.mode === 'file') paintSyntax()
}

function tokenLines(res) {
  const bit = name => { const k = (res.modifiers || []).indexOf(name); return k < 0 ? 0 : 1 << k }
  const ro = bit('readonly'), lib = bit('defaultLibrary'), dep = bit('deprecated')
  const lines = [], t = res.tokens || []
  for (let i = 0; i + 4 < t.length; i += 5) {
    let cls = 'tk-' + String(res.legend[t[i + 3]] || 'x').replace(/[^\w-]/g, '')
    if (t[i + 4] & ro) cls += ' tk-readonly'
    if (t[i + 4] & lib) cls += ' tk-lib'
    if (t[i + 4] & dep) cls += ' tk-deprecated'
    ;(lines[t[i]] ||= []).push([t[i + 1], t[i + 2], cls])
  }
  return lines
}

// While typing, tokens describe the last text sent. Lines above and below the edit keep theirs
// (shifted by the lines added or removed); the edited lines stay plain until the next answer.
function tokenRow(tab) {
  const hl = tab.hl
  if (hl.text === tab.content) return i => i
  if (hl.mapFor !== tab.content) {
    const a = hl.src, b = tabLines(tab)
    let p = 0, q = 0
    while (p < a.length && p < b.length && a[p] === b[p]) p++
    while (q < a.length - p && q < b.length - p && a[a.length - 1 - q] === b[b.length - 1 - q]) q++
    hl.map = { p, q, na: a.length, nb: b.length }
    hl.mapFor = tab.content
  }
  const { p, q, na, nb } = hl.map
  return i => i < p ? i : i >= nb - q ? i - nb + na : -1
}

function tabLines(tab) {
  if (tab.linesFor !== tab.content) { tab.linesFor = tab.content; tab.lines = tab.content.split('\n') }
  return tab.lines
}

// Some servers (TypeScript, Pyright, clangd) only classify names, so comments, strings, and numbers
// are found lexically underneath; a server token always wins where both cover the same text.
const LEX_NUM = String.raw`\b(?:0[xXbBoO][\da-fA-F_]+|\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?)\b`
const LEX_STR = String.raw`"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'`
const LEX = {
  c: new RegExp(String.raw`(\/\/[^\n]*|\/\*[\s\S]*?(?:\*\/|$))|(${LEX_STR}|` + '`' + String.raw`(?:[^` + '`' + String.raw`\\]|\\[\s\S])*` + '`' + `)|(${LEX_NUM})`, 'g'),
  hash: new RegExp(String.raw`(#[^\n]*)|("""[\s\S]*?"""|'''[\s\S]*?'''|${LEX_STR})|(${LEX_NUM})`, 'g'),
  lua: new RegExp(String.raw`(--\[\[[\s\S]*?\]\]|--[^\n]*)|(${LEX_STR})|(${LEX_NUM})`, 'g'),
}
const lexFamily = p => /\.(py|pyi|rb|sh|bash|zsh)$/i.test(p) ? 'hash' : /\.lua$/i.test(p) ? 'lua' : 'c'

// Keywords for languages whose servers classify names but not keywords (jdtls, TypeScript, Pyright,
// clangd). They only fill gaps: strings, comments, and server tokens always win.
const KEYWORDS = Object.fromEntries(Object.entries({
  java: 'abstract assert boolean break byte case catch char class const continue default do double else enum extends final finally float for goto if implements import instanceof int interface long native new package private protected public record return sealed permits short static strictfp super switch synchronized this throw throws transient try var void volatile while yield true false null',
  js: 'as async await break case catch class const continue debugger declare default delete do else enum export extends false finally for from function get if implements import in instanceof interface keyof let namespace new null of private protected public readonly return satisfies set static super switch this throw true try type typeof undefined var void while with yield',
  py: 'False None True and as assert async await break case class continue def del elif else except finally for from global if import in is lambda match nonlocal not or pass raise return self try while with yield',
  c: 'auto bool break case catch char class const constexpr continue default delete do double else enum explicit extern false float for friend goto if inline int long namespace new noexcept nullptr operator override private protected public register return short signed sizeof static struct switch template this throw true try typedef typename union unsigned using virtual void volatile while',
}).map(([k, v]) => [k, new Set(v.split(' '))]))
const kwFamily = p => /\.java$/i.test(p) ? 'java' : /\.[mc]?[jt]sx?$/i.test(p) ? 'js' : /\.pyi?$/i.test(p) ? 'py' : /\.(c|h|cc|cpp|cxx|hpp|hh|m|mm)$/i.test(p) ? 'c' : ''

function keywordSpans(text, words) {
  if (!words) return null
  const out = []
  for (const m of text.matchAll(/[A-Za-z_]\w*/g)) if (words.has(m[0])) out.push([m.index, m[0].length, 'tk-keyword'])
  return out.length ? out : null
}

function lexLines(tab) {
  if (tab.lexFor === tab.content) return tab.lex
  const out = [], text = tab.content, re = LEX[lexFamily(tab.path)]
  let line = 0, start = 0, m
  re.lastIndex = 0
  while ((m = re.exec(text))) {
    if (!m[0]) { re.lastIndex++; continue }
    const cls = m[1] ? 'tk-comment' : m[2] ? 'tk-string' : 'tk-number'
    for (let nl = text.indexOf('\n', start); nl >= 0 && nl < m.index; nl = text.indexOf('\n', start)) { line++; start = nl + 1 }
    // A token spanning lines (block comment, template string) becomes one span per line.
    let at = m.index
    const end = m.index + m[0].length
    while (at < end) {
      const nl = text.indexOf('\n', at)
      const stop = nl < 0 || nl >= end ? end : nl
      if (stop > at) (out[line] ||= []).push([at - start, stop - at, cls])
      if (stop === end) break
      line++; start = stop + 1; at = start
    }
  }
  tab.lexFor = tab.content
  tab.lex = out
  return out
}

// lineSpans lays server tokens over lexical ones: a lexical span keeps only the parts no server
// token covers, so `"crypto/sha256"` stays a string around gopls's package-name token.
function lineSpans(server, lexical) {
  if (!lexical) return server
  if (!server) return lexical
  const out = [...server]
  for (const [c, n, cls] of lexical) {
    let at = c
    for (const [sc, sn] of server) {
      if (sc + sn <= at || sc >= c + n) continue
      if (sc > at) out.push([at, sc - at, cls])
      at = Math.max(at, sc + sn)
    }
    if (at < c + n) out.push([at, c + n - at, cls])
  }
  return out.sort((a, b) => a[0] - b[0])
}

function colorLine(text, spans) {
  if (!spans) return esc(text)
  let h = '', at = 0
  for (const [c, n, cls] of spans) {
    if (c < at || c >= text.length) continue
    const end = Math.min(text.length, c + n)
    h += esc(text.slice(at, c)) + `<span class="${cls}">${esc(text.slice(c, end))}</span>`
    at = end
  }
  return h + esc(text.slice(at))
}

// Only the visible rows are drawn, like the gutter.
function paintSyntax() {
  const layer = $('#syntax'), ed = $('#editor'), tab = activeTab()
  const on = state.mode === 'file' && ed.classList.contains('active') && !!tab?.hl
  ed.classList.toggle('hl', on)
  layer.classList.toggle('active', on)
  if (!on) { layer.innerHTML = ''; return }
  const lines = tabLines(tab), row = tokenRow(tab), lex = lexLines(tab), words = KEYWORDS[kwFamily(tab.path)]
  const first = Math.max(0, Math.floor((ed.scrollTop - PAD) / LINE) - 2)
  const last = Math.min(lines.length, first + Math.ceil(ed.clientHeight / LINE) + 4)
  let h = ''
  for (let i = first; i < last; i++) {
    const r = row(i)
    h += `<div class="sl" style="top:${PAD + i * LINE - ed.scrollTop}px">${colorLine(lines[i], lineSpans(lineSpans(r < 0 ? null : tab.hl.lines[r], lex[i]), keywordSpans(lines[i], words)))}</div>`
  }
  layer.innerHTML = `<div style="transform:translateX(${-ed.scrollLeft}px)">${h}</div>`
}

function renderLspBanner() {
  const b = $('#lsp-banner'), tab = activeTab()
  const info = state.mode === 'file' && tab && !tab.binary && !tab.preview && state.lspExt.get(extOf(tab.path))
  if (!info || info.status !== 'missing' || (state.config.lspDismissed || []).includes(info.server.id)) { b.hidden = true; return }
  const s = info.server, busy = state.installing === s.id
  b.innerHTML = `<span class="grow">Highlighting for <b>${esc(extOf(tab.path))}</b> files uses <b>${esc(s.name)}</b>, which isn't installed. <code>${esc(s.install.join(' '))}</code></span>
    <button class="btn sm quiet" data-lsp="dismiss" ${busy ? 'disabled' : ''}>Not now</button>
    <button class="btn sm" data-lsp="copy">Copy command</button>
    <button class="btn sm primary" data-lsp="install" ${state.installing ? 'disabled' : ''}>${busy ? 'Installing…' : 'Install'}</button>`
  b.hidden = false
}

async function installServer(s) {
  state.installing = s.id
  renderLspBanner()
  setStatus(`Installing ${s.name}: ${s.install.join(' ')}`)
  paintLspStatus()
  try {
    await post('/api/lsp/install', { id: s.id })
    forgetServer(s.id)
    setStatus(`Installed ${s.name}`, 'ok')
  } catch (e) { setStatus(e.message, 'err') }
  state.installing = ''
  renderLspBanner()
  refreshLsp()
  if (state.mode === 'file') requestTokens(activeTab())
}

// ---------- language server status ----------
// The status bar names the current file's server and what it is doing; the popover lists every
// server echo knows, with Install for missing ones and Restart for running or failed ones.
const LSP_WORD = { missing: 'not installed', stopped: 'not started', starting: 'starting…', busy: 'indexing…', ready: 'ready', unsupported: 'no highlighting', failed: 'failed to start', exited: 'stopped unexpectedly' }
const lspLive = s => ['starting', 'busy', 'ready', 'unsupported'].includes(s.state)
let lspPoll

async function refreshLsp() {
  clearTimeout(lspPoll)
  try { state.lsp = await api('/api/lsp/status') } catch { return }
  paintLspStatus()
  // Poll only while something is changing or the popover is open.
  if (state.lsp.some(s => s.state === 'starting' || s.state === 'busy') || !$('#lsp-pop').hidden) lspPoll = setTimeout(refreshLsp, 1500)
}

// serverFor mirrors the server's choice: the first installed server for the extension, else the first one.
function serverFor(path) {
  const list = (state.lsp || []).filter(s => s.exts.includes(extOf(path)))
  return list.find(s => s.state !== 'missing') || list[0]
}

const codeTab = () => { const t = activeTab(); return state.mode === 'file' && t && !t.binary && !isMarkdown(t.path) ? t : null }

function paintLspStatus() {
  const chip = $('#lsp-status'), tab = codeTab(), cur = tab && serverFor(tab.path)
  const live = (state.lsp || []).filter(lspLive)
  let label, kind
  if (cur) {
    label = `${cur.name} · ${cur.state === 'busy' && cur.progress?.length ? cur.progress[0] : LSP_WORD[cur.state]}`
    kind = cur.state
  } else if (tab) {
    label = `No language server for ${extOf(tab.path) || 'this file'}`
    kind = 'none'
  } else {
    label = live.length ? `${live.length} language server${live.length > 1 ? 's' : ''}` : 'Language servers'
    kind = live.some(s => s.state !== 'ready') ? 'busy' : live.length ? 'ready' : 'none'
  }
  chip.dataset.state = kind
  $('#lsp-label').textContent = label
  chip.title = cur?.message || cur?.progress?.join('\n') || 'Language servers used for highlighting'
  if (!$('#lsp-pop').hidden) renderLspPop()
}

function renderLspPop() {
  const tab = codeTab(), cur = tab && serverFor(tab.path)
  const rank = s => s === cur ? 0 : lspLive(s) || s.state === 'failed' || s.state === 'exited' ? 1 : s.state === 'stopped' ? 2 : 3
  $('#lsp-list').innerHTML = [...(state.lsp || [])].sort((a, b) => rank(a) - rank(b)).map(s => {
    const act = s.state === 'missing'
      ? `<button class="btn sm" data-lsp-install="${esc(s.id)}" ${state.installing ? 'disabled' : ''}>${state.installing === s.id ? 'Installing…' : 'Install'}</button>`
      : s.state !== 'stopped' ? `<button class="btn sm quiet" data-lsp-restart="${esc(s.id)}">Restart</button>` : ''
    return `<div class="lsp-row${s === cur ? ' cur' : ''}" data-state="${s.state}">
      <div class="lsp-top"><i class="dot"></i><b>${esc(s.name)}</b><span class="lsp-state">${esc(LSP_WORD[s.state])}${lspLive(s) && s.since ? ` · ${ago(s.since).replace(' ago', '')}` : ''}</span>${act}</div>
      <div class="lsp-sub">${esc(s.exts.join(' '))} · ${s.path ? esc(s.path) : `<code>${esc(s.install.join(' '))}</code>`}</div>
      ${s.progress?.length ? `<div class="lsp-msg">${s.progress.map(esc).join('<br>')}</div>` : ''}
      ${s.message ? `<pre class="lsp-err">${esc(s.message)}</pre>` : ''}
    </div>`
  }).join('')
}

function toggleLspPop(open = $('#lsp-pop').hidden) {
  $('#lsp-pop').hidden = !open
  if (open) { renderLspPop(); refreshLsp() }
}

// forgetServer drops what the page remembered about a server, so the next request starts fresh.
function forgetServer(id) {
  for (const [ext, info] of state.lspExt) if (info.server?.id === id) state.lspExt.delete(ext)
  // Marking tokens stale makes the next request ask again; the old colors stay until the answer.
  for (const t of state.tabs) { t.hlAsked = null; if (t.hl) t.hl.text = null }
}

async function restartServer(id) {
  try { await post('/api/lsp/restart', { id }) } catch (e) { return setStatus(e.message, 'err') }
  forgetServer(id)
  setStatus(`Restarting ${state.lsp.find(s => s.id === id)?.name || id}`)
  if (codeTab()) requestTokens(codeTab())
  setTimeout(refreshLsp, 300)
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
  if (!same) view.scrollTop = tab.mdScroll || 0
  view.shownTab = tab
  view.shownText = tab.content
}

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
  const first = Math.max(0, Math.floor((ed.scrollTop - PAD) / LINE) - 2)
  const last = Math.min(n, first + Math.ceil(ed.clientHeight / LINE) + 4)
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
    h += `<div class="gl" style="top:${PAD + i * LINE - ed.scrollTop}px">${who}${i + 1}`
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

async function fileAction(action) {
  const current = state.selected || activeTab()?.path
  if (action !== 'create' && !current) return setStatus('Select a file first')
  const path = action === 'create' ? prompt('New file path') : current
  if (!path) return
  const newPath = action === 'rename' ? prompt('New path', path) : ''
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
  $('#stashes').innerHTML = (s.stashes || []).map(x => `<div class="list-row"><span title="${esc(x.subject)}"><b>${esc(x.ref)}</b> ${esc(x.subject)}</span><button class="btn sm" data-ref="${esc(x.ref)}">Apply</button></div>`).join('') || '<div class="list-row muted"><span>No stashes</span></div>'
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
    const name = prompt(`New branch from ${ref}`, '')?.trim()
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
    <span class="port">:${r.port}</span></div>`).join('')
    || `<div class="bp-more faint">${repos.length ? 'No open repository matches.' : 'Looking for open repositories…'}</div>`
  $('#repo-list .sel')?.scrollIntoView({ block: 'nearest' })
}

function switchRepo(port, newTab) {
  const url = `http://127.0.0.1:${port}/`
  toggleRepoPop(false)
  if (newTab) window.open(url, '_blank')
  else if (port !== +location.port) location.href = url
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
  const top = PAD + (line - 1) * LINE - ed.scrollTop
  if (!c || top < 0 || top > ed.clientHeight - LINE) { g.hidden = true; return }
  const start = text.lastIndexOf('\n', pos - 1) + 1, nl = text.indexOf('\n', pos)
  const cols = [...text.slice(start, nl < 0 ? undefined : nl)].reduce((n, ch) => ch === '\t' ? n + 4 - n % 4 : n + 1, 0)
  if (!charWidth) { const cx = document.createElement('canvas').getContext('2d'); cx.font = getComputedStyle(ed).font; charWidth = cx.measureText('0000000000').width / 10 }
  g.textContent = uncommitted(c) ? 'You · not committed yet' : `${c.author}, ${ago(c.time)} · ${c.summary}`
  g.style.top = top + 'px'
  g.style.left = parseFloat(getComputedStyle(ed).paddingLeft) + cols * charWidth + 36 - ed.scrollLeft + 'px'
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

const NET = new Set(['fetch', 'pull', 'push', 'sync', 'publish'])

async function gitAction(body, button) {
  const net = NET.has(body.action)
  if (net) { document.body.classList.add('net-busy'); button?.classList.add('busy') }
  try {
    setStatus(`git ${body.action}…`)
    const out = await post('/api/git', body)
    // Remote output leads with "To <url>" or progress lines; say what happened and keep Git's text in the tooltip.
    const done = { fetch: 'Fetched all remotes', pull: 'Pulled', push: 'Pushed', sync: 'Synced', publish: 'Published' }[body.action]
    setStatus(done ? `${done}\n${out.output || ''}` : out.output || `git ${body.action} done`, 'ok')
    if (body.action === 'commit' || body.action === 'amend') $('#commit-message').value = ''
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
$('#lsp-banner').addEventListener('click', async e => {
  const act = e.target.closest('[data-lsp]')?.dataset.lsp
  const tab = activeTab(), info = tab && state.lspExt.get(extOf(tab.path))
  if (!act || !info?.server) return
  const s = info.server
  if (act === 'install') installServer(s)
  if (act === 'copy') { await copyText(s.install.join(' ')); setStatus('Copied: ' + s.install.join(' '), 'ok') }
  if (act === 'dismiss') {
    state.config.lspDismissed = [...new Set([...(state.config.lspDismissed || []), s.id])]
    renderLspBanner()
    post('/api/config', { lspDismissed: state.config.lspDismissed }).catch(err => setStatus(err.message, 'err'))
  }
})
$('#lsp-status').onclick = e => { e.stopPropagation(); toggleLspPop() }
$('#lsp-pop').addEventListener('click', e => {
  const install = e.target.closest('[data-lsp-install]')?.dataset.lspInstall
  const restart = e.target.closest('[data-lsp-restart]')?.dataset.lspRestart
  if (install) installServer(state.lsp.find(s => s.id === install))
  if (restart) restartServer(restart)
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
function detailClick(e, hash, inLog) {
  const t = e.target, hit = sel => t.closest(sel)
  if (hit('[data-copy]')) {
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
  const row = e.target.closest('.rp-row')
  if (row) switchRepo(+row.dataset.port, mod(e))
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
  const name = prompt('New branch from the current commit', '')?.trim()
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
  if (!$('#lsp-pop').hidden && !e.target.closest('#lsp-pop')) toggleLspPop(false)
})
$('#stashes').addEventListener('click', e => {
  const b = e.target.closest('button[data-ref]')
  if (b) gitAction({ action: 'stash:apply', stashRef: b.dataset.ref })
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
  clearTimeout(tokensTimer)
  tokensTimer = setTimeout(() => { if (t === activeTab()) requestTokens(t) }, 250)
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
$('#commit').onclick = () => gitAction({ action: 'commit', message: $('#commit-message').value })
$('#amend').onclick = () => gitAction({ action: 'amend', message: $('#commit-message').value })
$('#stage-all').onclick = () => { const paths = [...state.changes.keys()]; if (paths.length) gitAction({ action: 'add', paths }) }
$('#switch-branch').onclick = () => gitAction({ action: 'branch:switch', from: $('#branch-select').value })
$('#create-branch').onclick = () => gitAction({ action: 'branch:create', from: $('#new-branch').value.trim() }).then(() => { $('#new-branch').value = '' })
const upstream = () => { const t = state.status?.tracking; return !!(t && t.upstream && !t.gone) }
$('#fetch').onclick = () => gitAction({ action: 'fetch' }, $('#fetch'))
$('#sync').onclick = () => gitAction({ action: upstream() ? 'sync' : 'publish' }, $('#sync'))
$('#pull').onclick = () => gitAction({ action: 'pull' }, $('#pull'))
$('#push').onclick = () => gitAction({ action: upstream() ? 'push' : 'publish' }, $('#push'))
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
  if (e.key === 'Escape') { $('#help').hidden = true; toggleThemes(false); toggleRepoPop(false); toggleLspPop(false); if (typing(e)) e.target.blur(); return }
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
  try { state.config = await api('/api/config'); $('#vim-mode').checked = !!state.config.vim } catch {}
  if (state.config.diffMode !== 'split') state.config.diffMode = 'unified'
  $('#gutter-base').value = gutterBase()
  $('#inline-blame').checked = blameInline()
  document.querySelectorAll('.layout-switch button').forEach(b => b.classList.toggle('on', b.dataset.layout === state.config.diffMode))
  if (state.diffFiles.length) renderDiff()
  applyTheme()
}

syncScopeInputs()
loadConfig()
refreshAll()
refreshLsp()
const events = new EventSource('/api/stream')
// After a lost connection the server may have restarted with new history; forget the refs key so the
// first status after reconnecting reloads History and the Log.
events.onopen = () => {
  $('.live').classList.remove('off')
  if (state.disconnected) { state.disconnected = false; state.refsKey = '' }
}
events.onmessage = e => applyStatus(JSON.parse(e.data))
events.onerror = () => { state.disconnected = true; $('.live').classList.add('off'); setStatus('Lost the echo server — retrying…', 'err') }
