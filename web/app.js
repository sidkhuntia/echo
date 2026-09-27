const $ = s => document.querySelector(s)
const el = s => document.querySelector(s)
const state = { tree: [], files: [], tabs: [], active: -1, selected: '', status: null, config: { vim: false }, view: 'file' }
const mod = e => e.metaKey || e.ctrlKey

const api = async (url, opts) => {
  const res = await fetch(url, opts)
  const text = await res.text()
  let data
  try { data = JSON.parse(text) } catch { data = text }
  if (!res.ok) throw new Error(data?.error || text || res.statusText)
  return data
}
const post = (url, body) => api(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
const setStatus = msg => { $('#status').textContent = msg }

async function refreshAll() {
  try {
    state.tree = await api('/api/tree')
    renderTree()
    state.status = await api('/api/git/status')
    renderGit()
    if (state.active >= 0) openFile(state.tabs[state.active].path, false)
    await loadDiff()
  } catch (e) { setStatus(e.message) }
}

function renderTree() {
  const filter = $('#file-filter').value.toLowerCase()
  const files = state.tree.filter(f => !filter || f.path.toLowerCase().includes(filter))
  $('#tree').innerHTML = files.map(f => `<div class="tree-row ${state.selected === f.path || state.tabs[state.active]?.path === f.path ? 'active' : ''}" data-path="${esc(f.path)}"><span>${esc(f.name)}</span>${f.code ? `<span class="badge">${esc(f.code)}</span>` : ''}</div>`).join('')
  $('#tree').querySelectorAll('.tree-row').forEach(row => row.onclick = () => { state.selected = row.dataset.path; openFile(row.dataset.path) })
}

async function openFile(path, focus = true) {
  const existing = state.tabs.findIndex(t => t.path === path)
  if (existing >= 0) state.active = existing
  else {
    const data = await api(`/api/file?path=${encodeURIComponent(path)}`)
    state.tabs.push({ path, content: data.content, saved: data.content, mode: 'view' })
    state.active = state.tabs.length - 1
  }
  renderTabs()
  renderEditor()
  renderTree()
  if (focus) $('#editor').focus()
  setStatus(path)
}

function renderTabs() {
  $('#tabs').innerHTML = state.tabs.map((t, i) => `<div class="tab ${i === state.active ? 'active' : ''} ${t.content !== t.saved ? 'dirty' : ''}" data-i="${i}">${esc(t.path)}</div>`).join('')
  $('#tabs').querySelectorAll('.tab').forEach(tab => tab.onclick = () => { state.active = +tab.dataset.i; renderTabs(); renderEditor(); renderTree() })
}

function renderEditor() {
  const tab = state.tabs[state.active]
  $('#file-path').textContent = tab?.path || ''
  $('#stage-count').textContent = tab ? `${tab.content.split('\n').length} lines` : ''
  $('#editor').value = tab?.content || ''
  $('#highlight').textContent = tab?.content || ''
  $('#editor').classList.toggle('active', tab?.mode === 'edit')
  $('#highlight').classList.toggle('active', tab?.mode !== 'edit')
  $('#save').disabled = !tab || tab.mode !== 'edit' || tab.content === tab.saved
  $('#edit-toggle').textContent = tab?.mode === 'edit' ? 'View' : 'Edit'
  renderTree()
}

async function saveFile() {
  const tab = state.tabs[state.active]
  if (!tab) return
  try {
    await post('/api/file', { action: 'save', path: tab.path, content: $('#editor').value })
    tab.content = $('#editor').value
    tab.saved = tab.content
    renderTabs(); renderEditor(); setStatus('saved ' + tab.path)
    await refreshAll()
  } catch (e) { setStatus(e.message) }
}

function renderGit() {
  const s = state.status || {}
  $('#branch').textContent = s.branch || 'not a git repo'
  $('#repo').textContent = s.root || location.pathname
  $('#branch-select').innerHTML = (s.branches || []).map(b => `<option>${esc(b)}</option>`).join('')
  const changes = Object.entries(s.statuses || {})
  $('#change-count').textContent = changes.length ? `${changes.length} open` : 'clean'
  $('#changes').innerHTML = changes.length ? changes.map(([p, code]) => `<div class="change" data-path="${esc(p)}"><span class="${code[0] !== ' ' && code[0] !== '?' ? 'staged' : 'code'}">${esc(code)}</span><code>${esc(p)}</code><button data-act="stage">${code[0] !== ' ' && code[0] !== '?' ? 'unstage' : 'stage'}</button><button data-act="discard">discard</button></div>`).join('') : '<div class="list-row"><span>clean</span></div>'
  $('#changes').querySelectorAll('.change').forEach(row => {
    row.querySelector('[data-act="stage"]').onclick = e => { e.stopPropagation(); git(row.dataset.path, (state.status.statuses[row.dataset.path] || ' ')[0] !== ' ' && (state.status.statuses[row.dataset.path] || ' ')[0] !== '?' ? 'unstage' : 'add') }
    row.querySelector('[data-act="discard"]').onclick = e => { e.stopPropagation(); git(row.dataset.path, 'discard') }
    row.onclick = () => openFile(row.dataset.path)
  })
  $('#stashes').innerHTML = (s.stashes || []).map(x => `<div class="list-row"><span>${esc(x.ref)} ${esc(x.subject)}</span><button data-ref="${esc(x.ref)}">apply</button></div>`).join('') || '<div class="list-row"><span>none</span></div>'
  $('#stashes').querySelectorAll('button').forEach(b => b.onclick = () => gitAction({ action: 'stash:apply', stashRef: b.dataset.ref }))
  $('#history').innerHTML = (s.commits || []).map(c => `<div class="list-row"><span><b>${esc(c.hash)}</b> ${esc(c.subject)}</span></div>`).join('')
}

async function git(path, action) { await gitAction({ action, paths: [path] }) }
async function gitAction(body) {
  try { setStatus('running git…'); const out = await post('/api/git', body); setStatus(out.output || 'done'); await refreshAll() }
  catch (e) { setStatus(e.message); await refreshAll() }
}

async function loadDiff() {
  const scope = $('#diff-scope').value
  if (scope === 'file' && state.active < 0) return
  const params = new URLSearchParams({ scope, ignoreWhitespace: $('#ignore-ws').checked ? '1' : '0' })
  if (scope === 'range') { params.set('from', $('#diff-from').value); params.set('to', $('#diff-to').value) }
  try {
    const data = await api('/api/diff?' + params)
    $('#diff').innerHTML = esc(data.text).split('\n').map(line => `<div class="${line.startsWith('+') && !line.startsWith('+++') ? 'diff-add' : line.startsWith('-') && !line.startsWith('---') ? 'diff-del' : line.startsWith('@@') ? 'diff-hunk' : ''}">${line || ' '}</div>`).join('')
  } catch (e) { $('#diff').textContent = e.message }
}

function toggleDiff() { state.view = state.view === 'diff' ? 'file' : 'diff'; $('#diff').classList.toggle('active', state.view === 'diff'); $('#highlight').classList.toggle('active', state.view === 'file' && state.tabs[state.active]?.mode !== 'edit'); $('#editor').classList.toggle('active', state.view === 'file' && state.tabs[state.active]?.mode === 'edit'); if (state.view === 'diff') loadDiff() }

async function fileAction(action) {
  const current = state.selected || state.tabs[state.active]?.path
  if (action !== 'create' && !current) return setStatus('select a file first')
  const path = action === 'create' ? prompt('New file path') : current
  if (!path) return
  const newPath = action === 'rename' ? prompt('New path', path) : ''
  if (action === 'rename' && !newPath) return
  try { await post('/api/file', { action, path, newPath, content: '' }); state.selected = newPath || path; await refreshAll() }
  catch (e) { setStatus(e.message) }
}

$('#edit-toggle').onclick = () => { const t = state.tabs[state.active]; if (!t) return; t.mode = t.mode === 'edit' ? 'view' : 'edit'; renderEditor() }
$('#new-file').onclick = () => fileAction('create')
$('#rename-file').onclick = () => fileAction('rename')
$('#delete-file').onclick = () => fileAction('delete')
$('#save').onclick = saveFile
$('#refresh').onclick = refreshAll
$('#tree-toggle').onclick = () => $('#tree-panel').classList.toggle('hidden-panel')
$('#git-toggle').onclick = () => $('#git-panel').classList.toggle('hidden-panel')
$('#diff-toggle').onclick = toggleDiff
$('#commit').onclick = () => gitAction({ action: 'commit', message: $('#commit-message').value })
$('#amend').onclick = () => gitAction({ action: 'amend', message: $('#commit-message').value })
$('#switch-branch').onclick = () => gitAction({ action: 'branch:switch', from: $('#branch-select').value })
$('#create-branch').onclick = () => gitAction({ action: 'branch:create', from: $('#new-branch').value })
$('#pull').onclick = () => gitAction({ action: 'pull' })
$('#push').onclick = () => gitAction({ action: 'push' })
$('#merge').onclick = () => gitAction({ action: 'merge', from: $('#branch-select').value })
$('#rebase').onclick = () => gitAction({ action: 'rebase', from: $('#diff-from').value })
$('#stash-create').onclick = () => gitAction({ action: 'stash:create', message: $('#stash-message').value })
$('#file-filter').oninput = renderTree
$('#diff-scope').onchange = loadDiff
$('#ignore-ws').onchange = loadDiff
$('#settings').onclick = async () => { const v = prompt('Enable vim-style navigation? y/n', state.config.vim ? 'y' : 'n'); if (v === null) return; state.config.vim = /^y/i.test(v); await post('/api/config', state.config); setStatus('settings saved') }
$('#help').onclick = e => { if (e.target.dataset.close !== undefined) $('#help').hidden = true }
$('#btn-help')?.addEventListener('click', () => { $('#help').hidden = false })

document.addEventListener('keydown', e => {
  if (mod(e) && ['k', 'K', 'p', 'P'].includes(e.key)) { e.preventDefault(); const q = prompt('File path'); if (q) openFile(q); }
  if (mod(e) && e.key.toLowerCase() === 'b') { e.preventDefault(); $('#tree-panel').classList.toggle('hidden-panel') }
  if (mod(e) && e.key.toLowerCase() === 'j') { e.preventDefault(); $('#git-panel').classList.toggle('hidden-panel') }
  if (mod(e) && e.key.toLowerCase() === 'd') { e.preventDefault(); toggleDiff() }
  if (mod(e) && e.key.toLowerCase() === 's') { e.preventDefault(); saveFile() }
  if (e.key === '?') $('#help').hidden = false
  if (e.key === 'Escape') { $('#help').hidden = true }
})
$('#editor').addEventListener('input', () => { const t = state.tabs[state.active]; if (t) { t.content = $('#editor').value; renderTabs(); $('#save').disabled = t.content === t.saved } })

$('#diff-scope').value = 'worktree'
loadConfig()
refreshAll()
const events = new EventSource('/api/stream')
events.onmessage = e => { state.status = JSON.parse(e.data); renderGit() }
async function loadConfig() { state.config = await api('/api/config'); }
