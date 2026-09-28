const $ = s => document.querySelector(s)
const state = {
  tree: [], treeStale: true, tabs: [], active: -1, selected: '',
  status: null, changes: new Map(), reviewed: {}, folded: new Map(), justStamped: '',
  config: { vim: false }, mode: 'diff', rail: 'changes',
  diffFiles: [], diffSeq: 0, current: -1, commit: '',
  palette: { items: [], sel: 0 },
}
const mod = e => e.metaKey || e.ctrlKey
const typing = e => e.target.closest?.('input, textarea, select')
const REVIEWABLE = ['head', 'worktree', 'staged']
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
const codeTag = c => `<span class="code-tag ${codeLetter(c)}">${codeWord[codeLetter(c)] || c.code.trim()}</span>`
const statHTML = c => c.binary ? '<span class="tiny">bin</span>' : `<span class="add">+${c.added}</span> <span class="del">−${c.deleted}</span>`
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
  if (!c) return setStatus('only working changes can be proofed')
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
  setStatus(done ? `proofed ${path}` : `unmarked ${path}`, done ? 'ok' : '')
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
  const first = !state.status
  state.status = s
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
  if (state.mode === 'diff' && REVIEWABLE.includes(scope())) scheduleDiff()
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
    q.innerHTML = `<div class="empty"><b>Not a repository.</b>Browsing and editing still work; git actions are off.</div>`
    return
  }
  if (!all.length) {
    q.innerHTML = `<div class="empty"><b>Clean desk.</b>Nothing to proof — the working tree matches HEAD.</div>`
    return
  }
  const filter = $('#file-filter').value.toLowerCase()
  const list = all.filter(c => !filter || c.path.toLowerCase().includes(filter))
  const todo = list.filter(c => reviewState(c.path) !== 'done')
  const done = list.filter(c => reviewState(c.path) === 'done')
  const cur = currentPath()
  const row = c => {
    const rv = reviewState(c.path)
    return `<div class="qrow rv-${rv} ${c.path === cur ? 'current' : ''}" data-path="${esc(c.path)}" title="${esc(c.path)}">
      <span class="mark-dot" data-act="review" title="toggle proofed (x)"></span>
      <span class="qpath">${nameFirst(c.path)}</span>
      <span class="qstat">${statHTML(c)}</span>
      <span class="qmeta">${codeTag(c)}${c.staged ? '<span class="staged-tag">staged</span>' : ''}${rv === 'stale' ? '<span class="stale-tag" title="changed since you proofed it">changed</span>' : ''}</span>
      <span class="qacts"><button data-act="stage">${fullyStaged(c) ? 'unstage' : 'stage'}</button><button data-act="discard">discard</button></span>
    </div>`
  }
  q.innerHTML =
    (todo.length ? `<div class="group-label"><span>to proof</span><span>${todo.length}</span></div>${todo.map(row).join('')}` : '') +
    (done.length ? `<div class="group-label"><span>proofed</span><span>${done.length}</span></div>${done.map(row).join('')}` : '') +
    (!list.length ? `<div class="empty">No changed path matches “${esc(filter)}”.</div>` : '')
}

function renderTree() {
  if (state.rail !== 'files') return
  const filter = $('#file-filter').value.toLowerCase()
  const files = state.tree.filter(f => !filter || f.path.toLowerCase().includes(filter)).slice(0, 3000)
  const open = activeTab()?.path
  $('#tree').innerHTML = files.map(f => {
    const c = state.changes.get(f.path)
    return `<div class="tree-row ${state.selected === f.path || open === f.path ? 'active' : ''}" data-path="${esc(f.path)}" title="${esc(f.path)}"><span>${nameFirst(f.path)}</span>${c ? `<span class="code-tag ${codeLetter(c)}">${codeLetter(c)}</span>` : ''}</div>`
  }).join('') || `<div class="empty">No path matches.</div>`
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
      h = { range: line.slice(0, line.indexOf('@@', 2) + 2), context: m[3], lines: [] }
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
    else if (c === '-') { h.lines.push({ t: 'del', o: o++, text: line.slice(1) }); f.deleted++ }
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
  const sc = scope()
  const params = new URLSearchParams({ scope: sc, ignoreWhitespace: $('#ignore-ws').checked ? '1' : '0' })
  if (sc === 'range') {
    const from = $('#diff-from').value.trim(), to = $('#diff-to').value.trim()
    if (!from || !to) return diffMessage('Two refs, one comparison.', 'Type a “from” and “to” ref — a branch, tag, or commit.')
    params.set('from', from); params.set('to', to)
  }
  if (sc === 'commit') {
    const ref = $('#diff-commit').value.trim()
    if (!ref) return diffMessage('Pick a commit.', 'Click one in recent history, or type a hash.')
    params.set('ref', ref)
  }
  if (state.status && !state.status.git) return diffMessage('No repository here.', 'Open files from the index to read or edit them.')
  const seq = ++state.diffSeq
  try {
    const data = await api('/api/diff?' + params)
    if (seq !== state.diffSeq) return
    state.diffFiles = parseDiff(data.text)
    renderDiff()
  } catch (e) {
    if (seq === state.diffSeq) diffMessage('Can’t diff that.', e.message)
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
  $('#diff-summary').innerHTML = files.length ? `${files.length} file${files.length === 1 ? '' : 's'} · <span class="add">+${added}</span> <span class="del">−${deleted}</span>` : ''
  if (!files.length) {
    const why = { head: ['Nothing to proof.', 'The working tree matches HEAD. When an agent writes something, it lands here.'], worktree: ['No unstaged changes.', 'Everything is staged or clean.'], staged: ['Nothing staged.', 'Stage files from the index to build a commit.'] }[scope()] || ['No differences.', 'These refs point at the same content.']
    return diffMessage(...why)
  }
  const view = $('#diff'), top = view.scrollTop
  view.innerHTML = files.map(fileHTML).join('')
  view.scrollTop = top
  state.justStamped = ''
  state.current = -1
  updateCurrent()
}

function fileHTML(f, i) {
  const reviewable = REVIEWABLE.includes(scope())
  const c = reviewable ? state.changes.get(f.path) : null
  const rv = c ? reviewState(f.path) : ''
  const folded = isFolded(f)
  const kind = f.isNew ? 'new' : f.isDeleted ? 'deleted' : 'modified'
  const letter = f.isNew ? 'A' : f.isDeleted ? 'D' : 'M'
  const stamp = c ? `<button class="stamp ${rv === 'done' ? 'done' : rv === 'stale' ? 'stale' : ''} ${state.justStamped === f.path ? 'just' : ''}" data-act="review" title="x">${rv === 'done' ? '✓ proofed' : rv === 'stale' ? '↻ re-proof' : 'mark proofed'}</button>` : ''
  const acts = [
    !f.isDeleted ? '<button data-act="open" title="o">open</button>' : '',
    c ? `<button data-act="stage">${fullyStaged(c) ? 'unstage' : 'stage'}</button><button data-act="discard">discard</button>` : '',
  ].join('')
  let body = ''
  if (!folded) {
    if (f.note) body = `<div class="dnote">${esc(f.note)}</div>`
    else if (f.binary) body = `<div class="dnote">Binary file — not shown.</div>`
    else if (!f.hunks.length) body = `<div class="dnote">${f.isNew ? 'Empty new file.' : 'Mode or metadata change only.'}</div>`
    else body = f.hunks.map(hunkHTML).join('')
  }
  const why = folded && !state.folded.has(f.path) && rv !== 'done' ? (GENERATED.test(f.path) ? ' · generated' : f.lines > 1500 ? ' · large' : '') : ''
  return `<section class="dfile ${folded ? 'folded' : ''}" data-i="${i}">
    <header class="dfile-head"><span class="fold">▸</span><span class="code-tag ${letter}">${kind}</span><span class="dpath" title="${esc(f.path)}">${fullPath(f.path)}</span><span class="dstat">${f.binary ? '' : `<span class="add">+${f.added}</span> <span class="del">−${f.deleted}</span>`}<span class="tiny">${why}</span></span><span class="spacer"></span><span class="dacts">${acts}</span>${stamp}</header>
    <div class="dbody">${body}</div>
  </section>`
}

function hunkHTML(h) {
  const rows = h.lines.map(l => {
    const cls = l.t === 'add' ? 'r-add' : l.t === 'del' ? 'r-del' : l.t === 'meta' ? 'r-meta' : ''
    const sign = l.t === 'add' ? '+' : l.t === 'del' ? '−' : ''
    return `<span class="no ${cls}">${l.o ?? ''}</span><span class="no ${cls}">${l.n ?? ''}</span><span class="sg ${cls}">${sign}</span><span class="tx ${cls}">${esc(l.text) || ' '}</span>`
  }).join('')
  return `<div class="hunk"><div class="hunk-head">${esc(h.range)} <b>${esc(h.context)}</b></div>${rows}</div>`
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
  setMode('diff')
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

async function openFile(path, focus = false) {
  let i = state.tabs.findIndex(t => t.path === path)
  if (i < 0) {
    try {
      const data = await fetchFile(path)
      state.tabs.push({ path, content: data.content, saved: data.content, hash: data.hash, binary: data.binary, mode: 'view', conflict: '', seen: state.changes.get(path)?.hash ?? null })
      i = state.tabs.length - 1
    } catch (e) { return setStatus(e.message, 'err') }
  }
  state.active = i
  state.selected = path
  setMode('file')
  renderTabs()
  renderTree()
  if (focus && activeTab().mode === 'edit') $('#editor').focus()
  setStatus(path)
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
  $('#tabs').innerHTML = state.tabs.map((t, i) => `<div class="tab ${i === state.active && state.mode === 'file' ? 'active' : ''} ${t.content !== t.saved ? 'dirty' : ''}" data-i="${i}" title="${esc(t.path)}"><span>${esc(basename(t.path))}</span><button class="x" data-close="${i}" title="close"><span>×</span></button></div>`).join('')
}

function renderEditor() {
  const file = state.mode === 'file'
  const tab = activeTab()
  const editing = file && tab?.mode === 'edit' && !tab.binary
  $('#edit-toggle').hidden = !file || !tab || tab.binary
  $('#save').hidden = !file || !tab || tab.binary
  $('#file-path').innerHTML = tab ? fullPath(tab.path) : ''
  $('#stage-count').textContent = tab && !tab.binary ? `${tab.content.split('\n').length} lines${tab.content !== tab.saved ? ' · unsaved' : ''}` : ''
  $('#highlight').classList.toggle('active', file && !editing)
  $('#editor').classList.toggle('active', editing)
  $('#save').disabled = !tab || tab.content === tab.saved
  $('#edit-toggle').textContent = tab?.mode === 'edit' ? 'view' : 'edit'
  if (editing && $('#editor').value !== tab.content) $('#editor').value = tab.content
  if (file && !editing) {
    if (!tab) $('#highlight').innerHTML = `<div class="empty"><b>No file open.</b>Press ⌘K to jump to one, or pick it from the index.</div>`
    else if (tab.binary) $('#highlight').innerHTML = `<div class="empty"><b>Binary file.</b>Not shown.</div>`
    else {
      const lines = tab.content.split('\n')
      if (lines.length > 1 && lines.at(-1) === '') lines.pop()
      $('#highlight').innerHTML = lines.map(l => `<span class="l">${esc(l) || ' '}</span>`).join('')
    }
  }
  renderBanner()
}

function renderBanner() {
  const tab = activeTab()
  const b = $('#banner')
  if (state.mode !== 'file' || !tab?.conflict) { b.hidden = true; return }
  const deleted = tab.conflict === 'deleted'
  b.innerHTML = `<span class="grow"><b>${esc(basename(tab.path))}</b> ${deleted ? 'was deleted on disk.' : 'changed on disk while you had unsaved edits.'}</span>
    ${deleted ? '<button data-banner="close">close tab</button>' : '<button data-banner="reload">take disk version</button>'}
    <button data-banner="overwrite" class="accent">${deleted ? 'recreate with mine' : 'keep mine & overwrite'}</button>`
  b.hidden = false
}

async function reloadTab(tab) {
  const data = await fetchFile(tab.path)
  Object.assign(tab, { content: data.content, saved: data.content, hash: data.hash, binary: data.binary, conflict: '' })
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
      Object.assign(tab, { content: data.content, saved: data.content, hash: data.hash, binary: data.binary, conflict: '' })
      if (tab === activeTab()) setStatus(`reloaded ${tab.path} — it changed on disk`)
    } else tab.conflict = 'changed'
    changed = true
  }
  if (changed) { renderTabs(); if (state.mode === 'file') renderEditor() }
}

async function saveFile(force = false) {
  const tab = activeTab()
  if (!tab || tab.binary || state.mode !== 'file') return
  if (tab.mode === 'edit') tab.content = $('#editor').value
  try {
    const res = await post('/api/file', { action: 'save', path: tab.path, content: tab.content, baseHash: force ? '' : tab.hash })
    Object.assign(tab, { saved: tab.content, hash: res.hash, conflict: '' })
    renderTabs(); renderEditor()
    setStatus('saved ' + tab.path, 'ok')
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
  if (action !== 'create' && !current) return setStatus('select a file first')
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
function setMode(m) {
  state.mode = m
  document.querySelectorAll('.mode-switch button').forEach(b => b.classList.toggle('on', b.dataset.mode === m))
  $('#diff-bar').hidden = m !== 'diff'
  $('#file-bar').hidden = m !== 'file'
  $('#diff').classList.toggle('active', m === 'diff')
  renderTabs(); renderEditor(); markQueueCurrent()
}

// ---------- ledger ----------
function renderGit() {
  const s = state.status || {}
  $('#branch').textContent = s.branch || (s.git === false ? 'no repository' : '—')
  $('#repo').innerHTML = s.root ? `<i>${esc(dirname(s.root))}/</i><b>${esc(basename(s.root))}</b>` : ''
  $('#repo').title = s.root || ''
  const keep = $('#branch-select').value
  $('#branch-select').innerHTML = (s.branches || []).map(b => `<option ${b === (keep || s.branch) ? 'selected' : ''}>${esc(b)}</option>`).join('')
  const staged = [...state.changes.values()].filter(c => c.staged).length
  $('#staged-count').textContent = staged ? `${staged} staged` : 'nothing staged'
  $('#stashes').innerHTML = (s.stashes || []).map(x => `<div class="list-row"><span title="${esc(x.subject)}"><b>${esc(x.ref)}</b> ${esc(x.subject)}</span><button data-ref="${esc(x.ref)}">apply</button></div>`).join('') || '<div class="list-row muted"><span>drawer is empty</span></div>'
  $('#history').innerHTML = (s.commits || []).map(c => `<div class="list-row commit-row" data-hash="${esc(c.hash)}" title="${esc(c.subject)} — ${esc(c.author)}"><span><b>${esc(c.hash)}</b>${esc(c.subject)}</span></div>`).join('') || '<div class="list-row muted"><span>no commits yet</span></div>'
  renderHistoryCurrent()
}

function renderHistoryCurrent() {
  document.querySelectorAll('.commit-row').forEach(r => r.classList.toggle('current', r.dataset.hash === state.commit))
}

async function gitAction(body) {
  try {
    setStatus(`git ${body.action}…`)
    const out = await post('/api/git', body)
    setStatus(out.output || `${body.action} done`, 'ok')
    if (body.action === 'commit' || body.action === 'amend') $('#commit-message').value = ''
  } catch (e) { setStatus(e.message, 'err') }
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
  const row = e.target.closest('.tree-row')
  if (row) { state.selected = row.dataset.path; openFile(row.dataset.path) }
})
$('#diff').addEventListener('click', e => {
  const sec = e.target.closest('.dfile')
  if (!sec) return
  const i = +sec.dataset.i, f = state.diffFiles[i]
  const act = e.target.closest('[data-act]')?.dataset.act
  if (act === 'review') toggleReviewed(f.path)
  else if (act === 'open') openFile(f.path)
  else if (act === 'stage') stageToggle(f.path)
  else if (act === 'discard') gitAction({ action: 'discard', paths: [f.path] })
  else if (e.target.closest('.dfile-head')) toggleFold(i)
})
let scrollFrame
$('#diff').addEventListener('scroll', () => { cancelAnimationFrame(scrollFrame); scrollFrame = requestAnimationFrame(updateCurrent) })
$('#tabs').addEventListener('click', e => {
  const close = e.target.closest('[data-close]')
  if (close) return closeTab(+close.dataset.close)
  const tab = e.target.closest('.tab')
  if (tab) { state.active = +tab.dataset.i; setMode('file'); renderTree() }
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
$('#history').addEventListener('click', e => {
  const row = e.target.closest('.commit-row')
  if (!row) return
  state.commit = row.dataset.hash
  $('#diff-scope').value = 'commit'
  $('#diff-commit').value = row.dataset.hash
  syncScopeInputs()
  state.commit = row.dataset.hash
  renderHistoryCurrent()
  setMode('diff')
  $('#diff').scrollTop = 0
  loadDiff()
})
$('#stashes').addEventListener('click', e => {
  const b = e.target.closest('button[data-ref]')
  if (b) gitAction({ action: 'stash:apply', stashRef: b.dataset.ref })
})

$('#edit-toggle').onclick = () => {
  const t = activeTab()
  if (!t) return
  if (t.mode === 'edit') t.content = $('#editor').value
  t.mode = t.mode === 'edit' ? 'view' : 'edit'
  renderEditor()
  if (t.mode === 'edit') $('#editor').focus()
}
$('#editor').addEventListener('input', () => {
  const t = activeTab()
  if (!t) return
  t.content = $('#editor').value
  const dirty = t.content !== t.saved
  $(`#tabs .tab[data-i="${state.active}"]`)?.classList.toggle('dirty', dirty)
  $('#save').disabled = !dirty
})
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
$('#pull').onclick = () => gitAction({ action: 'pull' })
$('#push').onclick = () => gitAction({ action: 'push' })
$('#merge').onclick = () => gitAction({ action: 'merge', from: $('#branch-select').value })
$('#rebase').onclick = () => gitAction({ action: 'rebase', from: $('#branch-select').value })
$('#stash-create').onclick = () => gitAction({ action: 'stash:create', message: $('#stash-message').value }).then(() => { $('#stash-message').value = '' })
$('#file-filter').oninput = () => { renderQueue(); renderTree() }
$('#diff-scope').onchange = () => { syncScopeInputs(); $('#diff').scrollTop = 0; loadDiff() }
$('#ignore-ws').onchange = loadDiff
for (const id of ['#diff-from', '#diff-to', '#diff-commit']) $(id).addEventListener('keydown', e => { if (e.key === 'Enter') loadDiff() })
$('#help-open').onclick = () => { $('#help').hidden = false }
$('#help').onclick = e => { if (e.target === $('#help') || e.target.dataset.close !== undefined) $('#help').hidden = true }
$('#vim-mode').onchange = async () => {
  state.config.vim = $('#vim-mode').checked
  try { await post('/api/config', state.config); setStatus('settings saved', 'ok') } catch (e) { setStatus(e.message, 'err') }
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
  if (e.key === 'Escape') { $('#help').hidden = true; if (typing(e)) e.target.blur(); return }
  if (typing(e) || e.altKey) return
  const vimStep = dir => { if (state.config.vim && state.mode === 'file') $('#highlight').scrollBy(0, dir * 60) }
  switch (e.key) {
    case '?': $('#help').hidden = false; break
    case 'n': stepFile(1); break
    case 'p': stepFile(-1); break
    case 'j': state.mode === 'diff' ? stepHunk(1) : vimStep(1); break
    case 'k': state.mode === 'diff' ? stepHunk(-1) : vimStep(-1); break
    case 'x': { const p = currentPath(); if (p && state.mode === 'diff') toggleReviewed(p, true); break }
    case 'o': { const p = currentPath(); if (p && state.mode === 'diff' && !state.diffFiles[state.current]?.isDeleted) openFile(p); break }
    default: return
  }
  e.preventDefault()
})
window.addEventListener('beforeunload', e => { if (state.tabs.some(t => t.content !== t.saved)) e.preventDefault() })

async function loadConfig() {
  try { state.config = await api('/api/config'); $('#vim-mode').checked = !!state.config.vim } catch {}
}

syncScopeInputs()
loadConfig()
refreshAll()
const events = new EventSource('/api/stream')
events.onmessage = e => applyStatus(JSON.parse(e.data))
events.onerror = () => setStatus('lost the echo server — retrying…', 'err')
