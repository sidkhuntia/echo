// The review loop on top of the diff: hunk and line staging, notes, accept and reject, and the
// prompt that sends the notes to an agent. app.js calls the hooks below while it draws a diff.
import { ctx } from './ctx.js'
import { hunkKey, newId, noteRef, notesText, reviewPrompt, quoteFor } from './notes.js'
import { hunkPatch } from './patch.js'

export const review = { notes: [], marks: {}, sel: null, editing: null, loaded: false }
const esc = s => String(s).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]))

// ---------- storage ----------
export async function loadReview() {
  try {
    const doc = await ctx.api('/api/review')
    review.notes = Array.isArray(doc.notes) ? doc.notes : []
    review.marks = doc.marks && typeof doc.marks === 'object' ? doc.marks : {}
  } catch { /* a repository with no review yet */ }
  review.loaded = true
  renderNotesPane()
}

let saveTimer = 0
function saveReview() {
  clearTimeout(saveTimer)
  saveTimer = setTimeout(() => ctx.post('/api/review', { notes: review.notes, marks: review.marks }).catch(e => ctx.setStatus('Could not save review notes: ' + e.message, 'err')), 500)
  renderNotesPane()
  updateReviewBadge()
}

// A note belongs to a place in one view of a file: the working tree, or a commit or range.
const viewRef = () => { const sc = ctx.scope(); return sc === 'commit' ? ctx.$('#diff-commit').value.trim() : sc === 'range' ? `${ctx.$('#diff-from').value.trim()}${ctx.state.rangeDots}${ctx.$('#diff-to').value.trim()}` : '' }
const lineSide = l => l.t === 'del' ? 'old' : 'new'
const lineNo = l => l.t === 'del' ? l.o : l.n
const notesAt = (path, l) => review.notes.filter(n => n.path === path && n.side === lineSide(l) && n.line === lineNo(l) && (n.ref || '') === viewRef())

// ---------- what a hunk can do ----------
// The diff of "all changes" mixes the index and the working tree, so a hunk can only be staged or
// unstaged when its file has changes on one side only. The Unstaged and Staged views are always one side.
function sideOf(f) {
  const c = ctx.state.changes.get(f.path), sc = ctx.scope()
  if (sc === 'worktree') return 'work'
  if (sc === 'staged') return 'index'
  if (sc !== 'head' || !c || c.conflict) return ''
  if (c.work && !c.index) return 'work'
  if (c.index && !c.work) return 'index'
  return c.work && c.index ? 'both' : ''
}

const BTN = (act, label, title, cls = '') => `<button class="hbtn ${cls}" data-hact="${act}" title="${esc(title)}">${label}</button>`

export function hunkActsHTML(f, h, hi) {
  const key = hunkKey(f.path, h), mark = review.marks[key]?.s
  const side = sideOf(f)
  const picked = review.sel?.key === key ? review.sel.lines.size : 0
  let h1 = ''
  if (side === 'work') {
    h1 += BTN('stage', picked ? `Stage ${picked} line${picked === 1 ? '' : 's'}` : 'Stage hunk', picked ? 'Stage only the selected lines' : 'Stage this hunk')
    h1 += BTN('discard', picked ? `Discard ${picked}` : 'Discard', picked ? 'Throw away only the selected lines' : 'Throw away this hunk', 'danger')
  } else if (side === 'index') {
    h1 += BTN('unstage', picked ? `Unstage ${picked} line${picked === 1 ? '' : 's'}` : 'Unstage hunk', picked ? 'Unstage only the selected lines' : 'Unstage this hunk')
  } else if (side === 'both') {
    h1 += `<span class="hint-s" title="This file has staged and unstaged changes. Use the Unstaged or Staged view to stage single hunks.">partly staged</span>`
  }
  const notes = review.notes.filter(n => n.path === f.path && h.lines.some(l => l.i !== undefined && n.side === lineSide(l) && n.line === lineNo(l))).length
  const decide = `${BTN('accept', '✓', 'Accept this change (a)', mark === 'accepted' ? 'on ok' : 'ok')}${BTN('reject', '✗', 'Reject this change (x)', mark === 'rejected' ? 'on no' : 'no')}${BTN('note', notes ? `💬 ${notes}` : '💬', 'Add a note to this hunk (c)')}`
  return `<span class="hacts">${h1}${decide}</span>`
}

export const hunkClass = (f, h) => { const m = review.marks[hunkKey(f.path, h)]?.s; return m ? ` hk-${m}` : '' }
export const lineAttr = l => (l.t === 'meta' ? '' : ` data-l="${l.i}"`)

// ---------- notes drawn under their line ----------
export function noteRowsHTML(f, hi, l) {
  let h = ''
  for (const n of notesAt(f.path, l)) {
    if (review.editing?.id === n.id) { h += editorHTML(n.text, n.id); continue }
    h += `<div class="lnote-row"><div class="lnote${n.done ? ' done' : ''}" data-note="${esc(n.id)}"><span class="lnote-ico">💬</span><div class="lnote-text">${esc(n.text)}</div><span class="lnote-acts"><button class="hbtn" data-nact="done" title="${n.done ? 'Reopen' : 'Mark as addressed'}">${n.done ? 'Reopen' : 'Done'}</button><button class="hbtn" data-nact="edit">Edit</button><button class="hbtn danger" data-nact="delete">Delete</button></span></div></div>`
  }
  const e = review.editing
  if (e && !e.id && e.path === f.path && e.side === lineSide(l) && e.line === lineNo(l) && e.hi === hi) h += editorHTML('', '')
  return h
}

const editorHTML = (text, id) => `<div class="lnote-row"><div class="lnote-edit"><textarea class="field" rows="3" placeholder="Note for the agent. ⌘↵ saves, Esc cancels." data-nid="${esc(id)}">${esc(text)}</textarea><span class="lnote-acts"><button class="btn sm primary" data-nact="save">Save note</button><button class="btn sm quiet" data-nact="cancel">Cancel</button></span></div></div>`

export function noteAt(f, hi, l) { if (l) openEditor(f.path, hi, l) }

function openEditor(path, hi, l) {
  review.editing = { id: '', path, hi, side: lineSide(l), line: lineNo(l), code: quoteFor(l.text) }
  repaintFileOf(path)
  const ta = ctx.$('#diff .lnote-edit textarea')
  ta?.focus()
}

function repaintFileOf(path) {
  const i = ctx.state.diffFiles.findIndex(f => f.path === path)
  if (i >= 0) ctx.rerenderFile(i)
}

// ---------- clicks ----------
// Returns true when the click was a review action, so app.js does not also treat it as a fold or a jump.
export function handleDiffClick(e) {
  const sec = e.target.closest('.dfile')
  if (!sec) return false
  const i = +sec.dataset.i, f = ctx.state.diffFiles[i]
  const nact = e.target.closest('[data-nact]')
  if (nact) { noteAction(nact, f); return true }
  const hb = e.target.closest('[data-hact]')
  const hunkEl = e.target.closest('.hunk')
  const hi = hunkEl ? +hunkEl.dataset.h : -1
  if (hb && f && hi >= 0) { hunkAction(hb.dataset.hact, f, hi); return true }
  const no = e.target.closest('.no[data-l], .tx[data-l], .sg[data-l]')
  if (no && hunkEl && f) {
    const l = f.hunks[hi].lines[+no.dataset.l]
    if (!l) return false
    // The sign column adds a note; the line-number column selects the line for staging.
    if (no.classList.contains('sg')) { openEditor(f.path, hi, l); return true }
    if (no.classList.contains('no') && (l.t === 'add' || l.t === 'del')) { toggleLine(f, hi, l, e.shiftKey); return true }
  }
  return false
}

function toggleLine(f, hi, l, range) {
  const h = f.hunks[hi], key = hunkKey(f.path, h)
  if (review.sel?.key !== key) review.sel = { key, i: ctx.state.diffFiles.indexOf(f), hi, lines: new Set(), anchor: null }
  const s = review.sel
  if (range && s.anchor != null) {
    const [a, b] = [Math.min(s.anchor, l.i), Math.max(s.anchor, l.i)]
    for (const x of h.lines) if (x.i >= a && x.i <= b && (x.t === 'add' || x.t === 'del')) s.lines.add(x.i)
  } else s.lines.has(l.i) ? s.lines.delete(l.i) : s.lines.add(l.i)
  s.anchor = l.i
  if (!s.lines.size) review.sel = null
  paintSelection(f, hi)
}

function paintSelection(f, hi) {
  const hunkEl = ctx.$(`#diff .dfile[data-i="${ctx.state.diffFiles.indexOf(f)}"] .hunk[data-h="${hi}"]`)
  if (!hunkEl) return
  const sel = review.sel && review.sel.hi === hi ? review.sel.lines : new Set()
  hunkEl.querySelectorAll('[data-l]').forEach(el => el.classList.toggle('lsel', sel.has(+el.dataset.l)))
  const head = hunkEl.querySelector('.hacts')
  if (head) head.outerHTML = hunkActsHTML(f, f.hunks[hi], hi)
}

async function hunkAction(act, f, hi) {
  const h = f.hunks[hi], key = hunkKey(f.path, h)
  if (act === 'accept' || act === 'reject') return decide(f, hi, act === 'accept' ? 'accepted' : 'rejected')
  if (act === 'note') {
    const l = h.lines.find(x => x.t === 'add' || x.t === 'del') || h.lines[0]
    return l && openEditor(f.path, hi, l)
  }
  const lines = review.sel?.key === key ? review.sel.lines : null
  const reverse = act !== 'stage'
  const patch = hunkPatch(f, hi, { lines, reverse })
  if (!patch) return ctx.setStatus('Nothing selected to apply', 'err')
  if (act === 'discard') {
    const what = lines ? `${lines.size} selected line${lines.size === 1 ? '' : 's'}` : 'this hunk'
    const ok = await ctx.ask({ title: `Discard ${what}`, kicker: 'restorable', tone: 'danger', ok: 'Discard', html: `<p class="say">${esc(f.path)} — ${esc(h.range)}</p><p class="note">A snapshot is kept, so Restore in the Changes list brings it back.</p>` })
    if (!ok) return
  }
  review.sel = null
  await ctx.gitAction({ action: 'apply', patch, target: act === 'discard' ? 'worktree' : 'index', reverse })
}

function decide(f, hi, state) {
  const h = f.hunks[hi], key = hunkKey(f.path, h)
  if (review.marks[key]?.s === state) delete review.marks[key]
  else {
    const ns = h.lines.filter(l => l.n != null)
    review.marks[key] = { s: state, path: f.path, from: ns[0]?.n ?? h.nStart, to: ns.at(-1)?.n ?? h.nStart, ref: viewRef() }
  }
  saveReview()
  ctx.rerenderFile(ctx.state.diffFiles.indexOf(f))
}

function noteAction(btn, f) {
  const act = btn.dataset.nact
  const row = btn.closest('.lnote, .lnote-edit')
  if (act === 'cancel') { review.editing = null; return repaintFileOf(f.path) }
  if (act === 'save') {
    const ta = row.querySelector('textarea'), text = ta.value.trim()
    if (!text) { review.editing = null; return repaintFileOf(f.path) }
    const e = review.editing
    if (e?.id) { const n = review.notes.find(x => x.id === e.id); if (n) n.text = text }
    else if (e) review.notes.push({ id: newId(), path: e.path, side: e.side, line: e.line, code: e.code, text, ref: viewRef(), ts: Date.now(), done: false })
    review.editing = null
    saveReview()
    return repaintFileOf(f.path)
  }
  const id = row.dataset.note
  const n = review.notes.find(x => x.id === id)
  if (!n) return
  if (act === 'done') { n.done = !n.done; saveReview(); repaintFileOf(f.path) }
  else if (act === 'edit') { review.editing = { id }; repaintFileOf(f.path); ctx.$('#diff .lnote-edit textarea')?.focus() }
  else if (act === 'delete') { review.notes = review.notes.filter(x => x.id !== id); saveReview(); repaintFileOf(f.path) }
}

// ⌘↵ saves and Esc cancels the note being written.
document.addEventListener('keydown', e => {
  const ta = e.target.closest?.('.lnote-edit textarea')
  if (!ta) return
  if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); ta.closest('.lnote-edit').querySelector('[data-nact="cancel"]').click() }
  else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); e.stopPropagation(); ta.closest('.lnote-edit').querySelector('[data-nact="save"]').click() }
}, true)

// ---------- keys in the review ----------
function currentHunk() {
  const s = ctx.state, f = s.diffFiles[s.current]
  return f && s.hunk >= 0 ? { f, hi: s.hunk } : null
}

export function handleKey(e) {
  const k = e.key
  if (!['a', 'x', 'c', ']', '['].includes(k) || ctx.state.mode !== 'diff') return false
  if (k === ']' || k === '[') { stepUndecided(k === ']' ? 1 : -1); return true }
  const cur = currentHunk()
  if (!cur) return false
  if (k === 'a') decide(cur.f, cur.hi, 'accepted')
  else if (k === 'x') decide(cur.f, cur.hi, 'rejected')
  else hunkAction('note', cur.f, cur.hi)
  return true
}

// Jump to the next hunk nobody has accepted or rejected yet.
export function stepUndecided(dir) {
  const s = ctx.state, all = []
  s.diffFiles.forEach((f, i) => f.hunks.forEach((h, hi) => all.push([i, hi, !review.marks[hunkKey(f.path, h)]])))
  if (!all.length) return
  const at = all.findIndex(([i, hi]) => i === s.current && hi === s.hunk)
  const order = dir > 0 ? [...all.slice(at + 1), ...all.slice(0, at + 1)] : [...all.slice(0, Math.max(at, 0)).reverse(), ...all.slice(Math.max(at, 0)).reverse()]
  const next = order.find(x => x[2])
  if (!next) return ctx.setStatus('Every hunk has been accepted or rejected', 'ok')
  ctx.goHunk(next[0], next[1])
}

// ---------- progress and the Notes rail ----------
export function reviewProgress() {
  let total = 0, decided = 0
  for (const f of ctx.state.diffFiles) for (const h of f.hunks) { total++; if (review.marks[hunkKey(f.path, h)]) decided++ }
  return { total, decided }
}

export function updateReviewBadge() {
  const open = review.notes.filter(n => !n.done).length
  const b = ctx.$('#note-count')
  if (b) b.textContent = open || ''
}

const decidedLists = () => {
  const rejected = [], accepted = []
  for (const m of Object.values(review.marks)) {
    const where = `${m.path}:${m.from}${m.to !== m.from ? `-${m.to}` : ''}${m.ref ? ` @ ${m.ref}` : ''}`
    ;(m.s === 'rejected' ? rejected : accepted).push(where)
  }
  return { rejected: rejected.sort(), accepted: accepted.sort() }
}

export function promptText() {
  const st = ctx.state.status || {}
  const { rejected, accepted } = decidedLists()
  return reviewPrompt({ repo: st.root ? st.root.split('/').pop() : '', branch: st.branch || '', notes: review.notes, rejected, accepted })
}

export function renderNotesPane() {
  const box = ctx.$('#notes')
  if (!box) return
  updateReviewBadge()
  const { rejected, accepted } = decidedLists()
  const open = review.notes.filter(n => !n.done), done = review.notes.length - open.length
  const byFile = new Map()
  for (const n of [...review.notes].sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line)) byFile.has(n.path) ? byFile.get(n.path).push(n) : byFile.set(n.path, [n])
  const progress = reviewProgress()
  let h = `<div class="notes-head"><b>${open.length}</b> open · ${done} addressed · <span class="ok-t">${accepted.length} accepted</span> · <span class="no-t">${rejected.length} rejected</span></div>`
  h += `<div class="notes-acts"><button class="btn sm primary" data-notes="prompt" ${open.length || rejected.length ? '' : 'disabled'} title="Copy the notes with instructions an agent can follow">Copy for agent</button><button class="btn sm" data-notes="plain" ${review.notes.length ? '' : 'disabled'} title="Copy only the file, line and note of each">Copy notes</button><button class="btn sm quiet" data-notes="clear" ${done ? '' : 'disabled'} title="Remove addressed notes">Clear done</button></div>`
  if (progress.total) h += `<div class="notes-prog" title="Hunks in the diff you are looking at">${progress.decided}/${progress.total} hunks decided</div>`
  if (!review.notes.length) h += `<div class="empty"><b>No notes yet</b>Click the sign column of a diff line, or press <kbd>c</kbd> on a hunk, to leave a note for the agent.</div>`
  for (const [path, ns] of byFile) {
    h += `<div class="group-label qgroup"><span class="gname">${esc(path.split('/').pop())} <i>${esc(path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '')}</i></span><span class="count">${ns.length}</span></div>`
    h += ns.map(n => `<div class="nrow${n.done ? ' done' : ''}" data-nid="${esc(n.id)}" title="${esc(noteRef(n))}"><span class="nline">${n.side === 'old' ? '−' : ''}${n.line}</span><span class="ntext">${esc(n.text)}</span></div>`).join('')
  }
  box.innerHTML = h
}

export function initReview() {
  ctx.$('#notes')?.addEventListener('click', async e => {
    const b = e.target.closest('[data-notes]')
    if (b) {
      if (b.dataset.notes === 'clear') { review.notes = review.notes.filter(n => !n.done); return saveReview() }
      const text = b.dataset.notes === 'prompt' ? promptText() : notesText(review.notes).replace(/^/, '')
      try { await ctx.copyText(text); ctx.setStatus(b.dataset.notes === 'prompt' ? 'Copied the review prompt for your agent' : 'Copied the notes', 'ok') } catch (err) { ctx.setStatus(err.message, 'err') }
      return
    }
    const row = e.target.closest('.nrow')
    if (!row) return
    const n = review.notes.find(x => x.id === row.dataset.nid)
    if (n) jumpToNote(n)
  })
  loadReview()
}

async function jumpToNote(n) {
  await ctx.goTo(n.path)
  const el = ctx.$(`#diff [data-note="${CSS.escape(n.id)}"]`)
  if (el) el.scrollIntoView({ block: 'center' })
}

// What the Review's filter asks of a file.
const hunkKeys = f => f.hunks.map(h => hunkKey(f.path, h))
export const hasUndecided = f => hunkKeys(f).some(k => !review.marks[k])
export const hasRejected = f => hunkKeys(f).some(k => review.marks[k]?.s === 'rejected')
export const hasNotes = f => review.notes.some(n => n.path === f.path && !n.done)
