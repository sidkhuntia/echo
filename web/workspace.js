// The workspace overview: every repository's branch and change counts, and every changed file.
// Opening a repository navigates to /r/<id>/, where the usual echo page runs.
const $ = s => document.querySelector(s)
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
const basename = p => p.slice(p.lastIndexOf('/') + 1)
const dirname = p => p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : ''
const store = {
  get: k => { try { return localStorage.getItem('echo:' + k) } catch { return null } },
  set: (k, v) => { try { localStorage.setItem('echo:' + k, v) } catch {} },
}

const state = { repos: [], changes: [], filter: '', dirty: store.get('ws:dirty') === '1', folded: new Set(JSON.parse(store.get('ws:folded') || '[]')), sig: '', loaded: false, busy: false }

const api = async (url, opts) => {
  const res = await fetch(url, opts)
  const text = await res.text()
  if (!res.ok) throw new Error(text.trim() || res.statusText)
  return JSON.parse(text)
}
const post = url => api(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })

function setStatus(msg, kind = '') {
  const el = $('#status')
  el.textContent = msg
  el.className = kind
}

const count = r => r.staged + r.unstaged + r.untracked + r.conflicts
const href = id => `/r/${encodeURIComponent(id)}/`
const num = (n, cls = '') => `<span class="n ${n ? cls : 'zero'}">${n || '·'}</span>`

function visibleRepos() {
  const f = state.filter.toLowerCase()
  return state.repos.filter(r => (!f || r.name.toLowerCase().includes(f) || (r.branch || '').toLowerCase().includes(f)) && (!state.dirty || count(r) > 0))
}

function renderRepos() {
  const list = visibleRepos()
  const head = `<div class="ws-row head" role="row"><span>Repository</span><span>Branch</span><span>Sync</span><span class="r">Staged</span><span class="r">Unstaged</span><span class="r">Untracked</span><span class="r">Conflicts</span></div>`
  const row = r => {
    const sync = r.error ? `<span class="err" title="${esc(r.error)}">error</span>`
      : !r.upstream ? '<span class="faint">no upstream</span>'
      : r.ahead || r.behind ? `${r.ahead ? `<span class="ah">↑${r.ahead}</span>` : ''} ${r.behind ? `<span class="bh">↓${r.behind}</span>` : ''}`
      : '<span class="faint">in sync</span>'
    return `<a class="ws-row ${count(r) ? 'dirty' : ''}" role="row" href="${href(r.id)}" title="${esc(r.root)}">
      <span class="nm"><b>${esc(r.name)}</b></span><span class="mono">${esc(r.branch || '—')}</span><span>${sync}</span>
      ${num(r.staged, 'add')}${num(r.unstaged)}${num(r.untracked)}${num(r.conflicts, 'del')}</a>`
  }
  $('#ws-repos').innerHTML = head + (list.map(row).join('') || `<div class="empty">${state.repos.length ? 'No repository matches.' : 'No repositories found.'}</div>`)
  const dirtyN = state.repos.filter(r => count(r) > 0).length
  $('#ws-sum').textContent = `${state.repos.length} repositories · ${dirtyN} with changes`
}

const CODE = { M: 'mod', A: 'add', '?': 'add', D: 'del', U: 'del', R: 'mod', C: 'add' }

function renderChanges() {
  const f = state.filter.toLowerCase()
  const groups = state.changes
    .map(g => ({ ...g, files: g.changes.filter(c => !f || c.path.toLowerCase().includes(f) || g.name.toLowerCase().includes(f)) }))
    .filter(g => g.files.length)
  const total = groups.reduce((n, g) => n + g.files.length, 0)
  $('#ws-ch-sum').textContent = total ? `${total} files in ${groups.length} repositories` : ''
  $('#ws-changes').innerHTML = groups.map(g => {
    const folded = state.folded.has(g.id), add = g.files.reduce((n, c) => n + c.added, 0), del = g.files.reduce((n, c) => n + c.deleted, 0)
    const rows = folded ? '' : g.files.map(c => {
      const k = (c.conflict ? 'U' : c.code.trim()[0] || 'M')
      return `<a class="ws-file" href="${href(g.id)}#diff=${encodeURIComponent(c.path)}" title="${esc(c.path)}"><span class="st ${CODE[k] || 'mod'}">${esc(k)}</span>
        <span class="pth"><b>${esc(basename(c.path))}</b> <i>${esc(dirname(c.path))}</i></span>${c.staged ? '<span class="tag">staged</span>' : ''}
        <span class="ct">${c.binary ? '<span class="faint">binary</span>' : `<span class="add">+${c.added}</span> <span class="del">−${c.deleted}</span>`}</span></a>`
    }).join('')
    return `<div class="ws-group ${folded ? 'folded' : ''}"><div class="ws-gh"><button class="fold" data-fold="${esc(g.id)}" aria-expanded="${!folded}" title="${folded ? 'Expand' : 'Fold'}"><svg class="i" viewBox="0 0 16 16"><path d="m4.5 6.5 3.5 3.5 3.5-3.5"/></svg></button>
      <a class="gname" href="${href(g.id)}"><b>${esc(g.name)}</b></a><span class="mono faint">${esc(g.branch)}</span><span class="grow"></span>
      <span class="faint">${g.files.length} files</span><span class="add">+${add}</span><span class="del">−${del}</span></div>${rows}</div>`
  }).join('') || `<div class="empty">${state.loaded ? 'No changes in any repository.' : 'Loading…'}</div>`
}

// Changed files are fetched again only when a repository's counts change, not on every snapshot.
let changesTimer = 0
function scheduleChanges() {
  clearTimeout(changesTimer)
  changesTimer = setTimeout(async () => {
    try { state.changes = await api('/ws/changes'); state.loaded = true; renderChanges() } catch (e) { setStatus(e.message, 'err') }
  }, 300)
}

function applySnapshot(snap) {
  state.repos = snap.repos
  const sig = JSON.stringify(snap.repos.map(r => [r.id, r.branch, r.staged, r.unstaged, r.untracked, r.conflicts]))
  const first = state.sig === ''
  if (sig !== state.sig) { state.sig = sig; scheduleChanges() }
  renderRepos()
  if (first) renderChanges()
}

async function netAll(what, url) {
  if (state.busy) return
  state.busy = true
  document.querySelectorAll('.wsactions button').forEach(b => { b.disabled = true })
  setStatus(`${what}…`)
  try {
    const res = await post(url)
    const bad = res.filter(r => !r.ok && !r.skipped), done = res.filter(r => r.ok).length, skipped = res.filter(r => r.skipped).length
    const detail = bad.map(r => `${r.id}: ${r.message.split('\n').pop()}`).join(' · ')
    setStatus(`${what}: ${done} done${skipped ? `, ${skipped} skipped` : ''}${bad.length ? `, ${bad.length} failed — ${detail}` : ''}`, bad.length ? 'err' : 'ok')
    applySnapshot(await api('/ws/repos'))
  } catch (e) { setStatus(e.message, 'err') }
  state.busy = false
  document.querySelectorAll('.wsactions button').forEach(b => { b.disabled = false })
}

$('#ws-fetch').onclick = () => netAll('Fetch all', '/ws/fetch')
$('#ws-pull').onclick = () => netAll('Pull all', '/ws/pull')
$('#ws-rescan').onclick = async () => {
  try { applySnapshot(await post('/ws/rescan')); scheduleChanges(); setStatus('Rescanned', 'ok') } catch (e) { setStatus(e.message, 'err') }
}
$('#ws-filter').oninput = e => { state.filter = e.target.value; renderRepos(); renderChanges() }
$('#ws-dirty').checked = state.dirty
$('#ws-dirty').onchange = e => { state.dirty = e.target.checked; store.set('ws:dirty', state.dirty ? '1' : '0'); renderRepos() }
$('#ws-changes').addEventListener('click', e => {
  const b = e.target.closest('[data-fold]')
  if (!b) return
  state.folded.has(b.dataset.fold) ? state.folded.delete(b.dataset.fold) : state.folded.add(b.dataset.fold)
  store.set('ws:folded', JSON.stringify([...state.folded]))
  renderChanges()
})
document.addEventListener('keydown', e => {
  if (e.key === '/' && document.activeElement.tagName !== 'INPUT') { e.preventDefault(); $('#ws-filter').focus() }
  else if (e.key === 'Escape' && document.activeElement.tagName === 'INPUT') document.activeElement.blur()
})

api('/api/instance').then(i => { $('#ws-name').textContent = basename(i.root); document.title = `${basename(i.root)} — echo workspace` }, () => {})
const events = new EventSource('/ws/stream')
events.onopen = () => $('.live').classList.remove('off')
events.onmessage = e => applySnapshot(JSON.parse(e.data))
events.onerror = () => { $('.live').classList.add('off'); setStatus('Lost the echo server — retrying…', 'err') }
