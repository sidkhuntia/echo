const $ = s => document.querySelector(s)
const state = {
  tree: [], treeStale: true, tabs: [], active: -1, selected: '',
  status: null, changes: new Map(), reviewed: {}, folded: new Map(), justStamped: '',
  config: { vim: false, theme: 'system', diffMode: 'unified' }, mode: 'diff', rail: 'changes', dirOpen: new Map(),
  diffFiles: [], diffSeq: 0, current: -1, commit: '', returnTo: '', statusSeq: 0,
  // diffStale: the diff missed an update while Files mode was showing; it reloads on the way back to Review.
  diffStale: false, diffReady: Promise.resolve(), diffScroll: 0,
  palette: { items: [], sel: 0 },
  // History: the expanded commit, cached details (commits never change), and folders closed per commit.
  expanded: '', details: new Map(), contains: new Map(), cdirClosed: new Set(),
  // hist: the History tab (current branch). log: the Log view. refsKey: HEAD plus a ref signature;
  // both reload only when it changes. fromLog: Review was opened from the Log, so Esc goes back.
  hist: { commits: [], rows: [] }, log: { commits: [], rows: [], more: false, loading: false, loaded: false, seq: 0, sel: '' },
  refsKey: '', fromLog: false,
}
const mod = e => e.metaKey || e.ctrlKey
const typing = e => e.target.closest?.('input, textarea, select')
const REVIEWABLE = ['head', 'worktree', 'staged']
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
// A file is "fully staged" when something is in the index and nothing is left in the worktree.
const fullyStaged = c => c.staged && c.code[1] === ' '

// ---------- review marks ----------
// Marks live in localStorage as path -> content hash; a mark only counts while the hash still matches.
const reviewKey = () => 'echo:reviewed:' + (state.status?.root || '')
function loadReviewed() {
  try { state.reviewed = JSON.parse(localStorage.getItem(reviewKey())) || {} } catch { state.reviewed = {} }
}
function saveReviewed() {
  try { localStorage.setItem(reviewKey(), JSON.stringify(state.reviewed)) } catch {}
}
function reviewState(path) {
  const c = state.changes.get(path), mark = state.reviewed[path]
  if (!c || !mark) return 'todo'
  return mark === c.hash ? 'done' : 'stale'
}

function toggleReviewed(path, advance = false) {
  const c = state.changes.get(path)
  if (!c) return setStatus('Only working-tree changes can be marked reviewed')
  const done = reviewState(path) !== 'done'
  if (done) state.reviewed[path] = c.hash
  else delete state.reviewed[path]
  saveReviewed()
  state.folded.delete(path)
  state.justStamped = done ? path : ''
  renderQueue(); renderTally()
  const i = state.diffFiles.findIndex(f => f.path === path)
  if (i >= 0) {
    rerenderFile(i)
    if (done && advance) {
      const next = state.diffFiles.findIndex((f, j) => j > i && reviewState(f.path) !== 'done')
      if (next >= 0) goFile(next)
    }
  }
  setStatus(done ? `Reviewed ${path}` : `Unmarked ${path}`, done ? 'ok' : '')
}

function renderTally() {
  const all = [...state.changes.keys()]
  const done = all.filter(p => reviewState(p) === 'done').length
  $('#tally-done').textContent = done
  $('#tally-total').textContent = all.length
  $('#tally-fill').style.width = all.length ? `${(done / all.length) * 100}%` : '0'
  $('.tally').classList.toggle('complete', all.length > 0 && done === all.length)
}

// ---------- status ----------
function applyStatus(s) {
  // The server restarted with different web assets; this page's code no longer matches its API.
  if (state.status?.build && s.build && s.build !== state.status.build) return staleBuild()
  const first = !state.status
  state.status = s
  state.statusSeq++
  state.changes = new Map((s.changes || []).map(c => [c.path, c]))
  if (first) {
    loadReviewed()
    if (!s.git) setRail('files')
  }
  let pruned = false
  for (const p of Object.keys(state.reviewed)) if (!state.changes.has(p)) { delete state.reviewed[p]; pruned = true }
  if (pruned) saveReviewed()
  for (const p of state.folded.keys()) if (reviewState(p) === 'stale') state.folded.delete(p)
  state.treeStale = true
  document.body.classList.toggle('no-git-repo', !s.git)
  renderGit(); renderQueue(); renderTally()
  if (state.rail === 'files') ensureTree().then(renderTree)
  syncTabs()
  refreshGutter()
  if (REVIEWABLE.includes(scope())) state.mode === 'diff' ? scheduleDiff() : (state.diffStale = true)
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
  if (rail === 'files') ensureTree().then(renderTree)
  else renderQueue()
}

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
  const todo = list.filter(c => reviewState(c.path) !== 'done')
  const done = list.filter(c => reviewState(c.path) === 'done')
  const cur = currentPath()
  const row = c => {
    const rv = reviewState(c.path)
    const title = rv === 'stale' ? `${c.path} — changed since you reviewed it` : c.path
    return `<div class="qrow rv-${rv} ${c.path === cur ? 'current' : ''}" data-path="${esc(c.path)}" title="${esc(title)}">
      <span class="tick" data-act="review" title="Mark reviewed (x)"></span>
      <span class="qpath">${nameFirst(c.path)}</span>
      <span class="qmeta">${c.staged ? '<span class="staged-dot" title="staged"></span>' : ''}${statHTML(c)}${codeTag(c)}</span>
      <span class="qacts"><button class="btn quiet sm" data-act="stage">${fullyStaged(c) ? 'Unstage' : 'Stage'}</button><button class="btn quiet sm" data-act="discard">Discard</button></span>
    </div>`
  }
  const group = (label, n) => `<div class="group-label"><span>${label}</span><span class="count">${n}</span></div>`
  q.innerHTML =
    (todo.length ? group('To review', todo.length) + todo.map(row).join('') : '') +
    (done.length ? group('Reviewed', done.length) + done.map(row).join('') : '') +
    (!list.length ? `<div class="empty">No changed path matches “${esc(filter)}”.</div>` : '')
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

function stageToggle(path) {
  const c = state.changes.get(path)
  if (c) gitAction({ action: fullyStaged(c) ? 'unstage' : 'add', paths: [path] })
}

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
    params.set('from', from); params.set('to', to)
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
  return (REVIEWABLE.includes(scope()) && reviewState(f.path) === 'done') || GENERATED.test(f.path) || f.lines > 1500
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
  state.justStamped = ''
  state.current = -1
  updateCurrent()
}

function rerenderFile(i) {
  const sec = $(`#diff .dfile[data-i="${i}"]`)
  if (!sec) return
  sec.outerHTML = fileHTML(state.diffFiles[i], i)
  state.justStamped = ''
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
  const reviewable = REVIEWABLE.includes(scope())
  const c = reviewable ? state.changes.get(f.path) : null
  const rv = c ? reviewState(f.path) : ''
  const folded = isFolded(f)
  const kind = f.isNew ? 'new' : f.isDeleted ? 'deleted' : 'modified'
  const letter = f.isNew ? 'A' : f.isDeleted ? 'D' : 'M'
  const label = rv === 'done' ? 'Reviewed' : rv === 'stale' ? 'Review again' : 'Mark reviewed'
  const proof = c ? `<button class="proof rv-${rv} ${state.justStamped === f.path ? 'just' : ''}" data-act="review" title="${rv === 'stale' ? 'Changed since you reviewed it · ' : ''}x"><span class="tick"></span>${label}</button>` : ''
  const acts = [
    !f.isDeleted ? '<button class="btn quiet sm" data-act="open" title="o">Open</button>' : '',
    c ? `<button class="btn quiet sm" data-act="stage">${fullyStaged(c) ? 'Unstage' : 'Stage'}</button><button class="btn quiet sm" data-act="discard">Discard</button>` : '',
  ].join('')
  let body = ''
  if (!folded) {
    if (f.note) body = `<div class="dnote">${esc(f.note)}</div>`
    else if (f.binary) body = `<div class="dnote">Binary file — not shown.</div>`
    else if (!f.hunks.length) body = `<div class="dnote">${f.isNew ? 'Empty new file.' : 'Mode or metadata change only.'}</div>`
    else body = f.hunks.map(hunkHTML).join('')
  }
  const unsaved = state.tabs.some(t => t.path === f.path && t.content !== t.saved)
  const why = folded && !state.folded.has(f.path) ? (rv === 'done' ? 'reviewed' : GENERATED.test(f.path) ? 'generated' : f.lines > 1500 ? 'large' : '') : ''
  const stat = f.binary ? '' : `${f.added ? `<span class="add">+${f.added}</span>` : ''}${f.deleted ? `<span class="del">−${f.deleted}</span>` : ''}${blocksHTML(f)}`
  return `<section class="dfile ${folded ? 'folded' : ''}" data-i="${i}">
    <header class="dfile-head"><span class="fold">▶</span>${badge(letter, kind)}<span class="dpath" title="${esc(f.path)}">${fullPath(f.path)}</span><span class="dstat">${stat}${why ? `<span class="note">· ${why}</span>` : ''}${unsaved ? '<span class="note unsaved" title="The diff shows the file on disk; save with ⌘S in the editor">· unsaved edits</span>' : ''}</span><span class="spacer"></span><span class="dacts">${acts}</span>${proof}</header>
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
  post('/api/config', state.config).catch(e => setStatus(e.message, 'err'))
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

function markQueueCurrent() {
  const cur = currentPath()
  document.querySelectorAll('.qrow').forEach(r => r.classList.toggle('current', r.dataset.path === cur))
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

async function goTo(path) {
  await setMode('diff')
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
      state.tabs.push({ path, ...fromDisk(data), seen: state.changes.get(path)?.hash ?? null })
      i = state.tabs.length - 1
    } catch (e) { return setStatus(e.message, 'err') }
  }
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
  const editing = file && !!tab && !tab.binary
  $('#save').hidden = !editing
  $('#file-path').innerHTML = tab ? `${dirname(tab.path) ? `<i>${esc(dirname(tab.path))}/</i>` : ''}<b>${esc(basename(tab.path))}</b>` : ''
  $('#file-crumb').hidden = !file || !tab
  $('#stage-count').textContent = editing ? `${lineCount(tab)} lines${tab.content !== tab.saved ? ' · unsaved' : ''}` : ''
  $('#highlight').classList.toggle('active', file && !editing)
  $('#editor').classList.toggle('active', editing)
  $('#gutter').classList.toggle('active', editing)
  $('#save').disabled = !tab || tab.content === tab.saved
  if (editing && $('#editor').value !== tab.content) $('#editor').value = tab.content
  if (file && !editing) {
    $('#highlight').innerHTML = !tab
      ? `<div class="empty"><b>No file open</b>Press <kbd>⌘K</kbd> or pick a file from the sidebar.</div>`
      : `<div class="empty"><b>Binary file</b>Not shown.</div>`
  }
  renderBanner()
  refreshGutter()
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
  let h = ''
  for (let i = first; i < last; i++) {
    const kind = mk?.kinds[i], del = mk?.dels.get(i), end = i === n - 1 ? mk?.dels.get(n) : undefined
    h += `<div class="gl" style="top:${PAD + i * LINE - ed.scrollTop}px">${i + 1}`
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
  const wasDone = reviewState(tab.path) === 'done'
  try {
    const content = tab.eol === '\r\n' ? tab.content.replace(/\n/g, '\r\n') : tab.content
    const res = await post('/api/file', { action: 'save', path: tab.path, content, baseHash: force ? '' : tab.hash })
    Object.assign(tab, { saved: tab.content, hash: res.hash, conflict: '' })
    state.diffStale = true
    // Your own edit to a file you already reviewed should not undo the review.
    if (wasDone) { state.reviewed[tab.path] = res.hash; saveReviewed() }
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
  $('#repo').textContent = s.root ? basename(s.root) : ''
  $('#repo').title = s.root || ''
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
  }
  renderLogRefs()
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
  try {
    const data = await api('/api/log?' + params)
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
  if (!L.commits.length) {
    view.innerHTML = '<div class="empty"><b>No commits match</b><span>Clear a filter to see more history.</span></div>'
    $('#log-detail').innerHTML = ''
    return
  }
  const top = view.scrollTop
  view.innerHTML = L.commits.map((c, i) => `<div class="lrow ${c.hash === L.sel ? 'sel' : ''}" data-hash="${esc(c.hash)}">${graphSVG(L.rows[i], LOG_H, w)}<span class="lsub" title="${esc(c.subject)}">${refChips(c.refs)}<span class="ltext">${esc(c.subject)}</span></span><span class="lauth">${esc(c.author)}</span><span class="ltime" title="${esc(new Date(c.time * 1000).toLocaleString())}">${ago(c.time)}</span></div>`).join('')
    + (L.more ? '<div class="lmore faint">Loading more…</div>' : '')
  view.scrollTop = top
  if (L.commits.some(c => c.hash === L.sel)) paintLogDetail()
  else selectLog(L.commits[0].hash)
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
  showCommitDiff(c.hash, c.short).then(() => setStatus('Esc returns to the log'))
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
  if (state.status && !state.status.git) return
  try {
    const data = await api('/api/log?ref=HEAD&limit=100')
    state.hist.commits = data.commits
    state.hist.rows = layoutGraph(data.commits)
  } catch { state.hist.commits = []; state.hist.rows = [] }
  renderHistory()
}

// ---------- history ----------
function renderHistory() {
  const { commits, rows } = state.hist, w = graphWidth(rows)
  $('#history').innerHTML = commits.map((c, i) => `<div class="commit-row ${c.hash === state.expanded ? 'open' : ''}" data-hash="${esc(c.hash)}" data-short="${esc(c.short)}" title="${esc(c.subject)}\nClick to show details and the diff">
      <span class="c-graph">${graphSVG(rows[i], HIST_H, w)}</span>
      <div class="c-main"><div class="c-subject">${refChips(c.refs)}${esc(c.subject)}</div>
      <div class="c-meta"><b>${esc(c.short)}</b><span class="c-author">${esc(c.author)}</span><span class="c-time" title="${esc(new Date(c.time * 1000).toLocaleString())}">${ago(c.time)}</span></div></div>
    </div>${c.hash === state.expanded ? `<div class="c-detail"><span class="c-graph" style="width:${w}px">${railSVG(rows[i].after, w)}</span><div class="c-dbody">${detailHTML(c.hash)}</div></div>` : ''}`).join('') || '<div class="list-row muted"><span>No commits yet</span></div>'
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
  try { await post('/api/config', state.config) } catch (e) { setStatus(e.message, 'err') }
}

function toggleThemes(open = $('#theme-pop').hidden) {
  $('#theme-pop').hidden = !open
  if (!open) return
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
  const row = e.target.closest('.qrow')
  if (!row) return
  const act = e.target.closest('[data-act]')?.dataset.act
  const path = row.dataset.path
  if (act === 'review') toggleReviewed(path)
  else if (act === 'stage') stageToggle(path)
  else if (act === 'discard') gitAction({ action: 'discard', paths: [path] })
  else goTo(path)
})
$('#queue').addEventListener('dblclick', e => {
  const row = e.target.closest('.qrow')
  if (row && !e.target.closest('[data-act]') && state.tree.some(f => f.path === row.dataset.path)) openFile(row.dataset.path)
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
  if (act === 'review') toggleReviewed(f.path)
  else if (act === 'open') openFile(f.path, { fromReview: true })
  else if (act === 'stage') stageToggle(f.path)
  else if (act === 'discard') gitAction({ action: 'discard', paths: [f.path] })
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
$('#log-ref').onchange = () => loadLog()
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
  clearTimeout(marksTimer)
  marksTimer = setTimeout(() => { if (t === activeTab()) { computeMarks(t); paintGutter() } }, 120)
})
let marksTimer, gutterFrame
$('#editor').addEventListener('scroll', () => { cancelAnimationFrame(gutterFrame); gutterFrame = requestAnimationFrame(paintGutter) })
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
$('#file-filter').oninput = () => { renderQueue(); renderTree() }
$('#diff-scope').onchange = () => { syncScopeInputs(); $('#diff').scrollTop = 0; loadDiff() }
$('#ignore-ws').onchange = loadDiff
document.querySelectorAll('.layout-switch button').forEach(b => b.onclick = () => setDiffMode(b.dataset.layout))
for (const id of ['#diff-from', '#diff-to', '#diff-commit']) $(id).addEventListener('keydown', e => { if (e.key === 'Enter') loadDiff() })
$('#help-open').onclick = () => { $('#help').hidden = false }
$('#help').onclick = e => { if (e.target === $('#help') || e.target.dataset.close !== undefined) $('#help').hidden = true }
$('#gutter-base').onchange = () => {
  state.config.gutterBase = $('#gutter-base').value
  refreshGutter()
  post('/api/config', state.config).then(() => setStatus('Settings saved', 'ok'), e => setStatus(e.message, 'err'))
}
$('#vim-mode').onchange = async () => {
  state.config.vim = $('#vim-mode').checked
  try { await post('/api/config', state.config); setStatus('Settings saved', 'ok') } catch (e) { setStatus(e.message, 'err') }
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
    if (k === 'k' || k === 'p') { e.preventDefault(); openPalette() }
    else if (k === 'b') { e.preventDefault(); toggleTree() }
    else if (k === 'j') { e.preventDefault(); toggleLedger() }
    else if (k === 'd') { e.preventDefault(); setMode(state.mode === 'diff' ? 'file' : 'diff') }
    else if (k === 's') { e.preventDefault(); saveFile() }
    else if (e.key === 'Enter' && e.target.id === 'commit-message') { e.preventDefault(); $('#commit').click() }
    return
  }
  if (e.key === 'Escape' && e.target.id === 'editor' && state.returnTo && state.returnTo === activeTab()?.path) { e.preventDefault(); backToReview(); return }
  if (e.key === 'Escape' && state.mode === 'diff' && state.fromLog && !typing(e) && $('#help').hidden) { e.preventDefault(); setMode('log'); return }
  if (e.key === 'Escape') { $('#help').hidden = true; toggleThemes(false); if (typing(e)) e.target.blur(); return }
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
    case 'x': { const p = currentPath(); if (p && state.mode === 'diff') toggleReviewed(p, true); break }
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
  document.querySelectorAll('.layout-switch button').forEach(b => b.classList.toggle('on', b.dataset.layout === state.config.diffMode))
  if (state.diffFiles.length) renderDiff()
  applyTheme()
}

syncScopeInputs()
loadConfig()
refreshAll()
const events = new EventSource('/api/stream')
events.onopen = () => $('.live').classList.remove('off')
events.onmessage = e => applyStatus(JSON.parse(e.data))
events.onerror = () => { $('.live').classList.add('off'); setStatus('Lost the echo server — retrying…', 'err') }
