// The review loop on top of the diff: stage, unstage or discard a hunk or some of its lines, and notes
// for an agent. A note belongs to a place in the working tree: a line, a run of lines, or a whole file.
// app.js calls the hooks below while it draws a diff and the editor.
import { ctx } from './ctx.js'
import { newId, noteRef, notesText, reviewPrompt, quoteFor } from './notes.js'
import { hunkPatch } from './patch.js'
import { openModal } from './ui.js'

export const review = { notes: [], sel: null, editing: null, loaded: false }
const esc = s => String(s).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]))

// ---------- storage ----------
export async function loadReview() {
  try {
    const doc = await ctx.api('/api/review')
    // Notes made on a commit or a comparison (an older version allowed them) point at code that is not in the working tree.
    review.notes = (Array.isArray(doc.notes) ? doc.notes : []).filter(n => !n.ref)
  } catch { /* a repository with no notes yet */ }
  review.loaded = true
  renderNotesPane()
}

let saveTimer = 0
function saveReview(path) {
  clearTimeout(saveTimer)
  saveTimer = setTimeout(() => ctx.post('/api/review', { notes: review.notes }).catch(e => ctx.setStatus('Could not save review notes: ' + e.message, 'err')), 500)
  renderNotesPane()
  ctx.paintAll?.()
  // The diff draws notes inline, so the file they are in is drawn again.
  if (path === true) ctx.rerenderAll?.()
  else if (path) repaintFileOf(path)
}

// Notes describe the working tree, so they can only be written while the diff shows it: all changes or
// unstaged. A commit or a comparison shows other versions of the file, whose line numbers mean something else.
export const notable = () => ['head', 'worktree'].includes(ctx.scope())
const lineSide = l => (l.t === 'del' ? 'old' : 'new')
const lineNo = l => (l.t === 'del' ? l.o : l.n)
const lastLine = n => n.end || n.line
const notesAt = (path, l) => review.notes.filter(n => n.path === path && n.line > 0 && n.side === lineSide(l) && lastLine(n) === lineNo(l))
const fileNotesOf = path => review.notes.filter(n => n.path === path && !n.line)

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
const ICO = {
  note: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 3.5h10v7H8.5L5.5 13v-2.5H3z"/></svg>',
  undo: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5.5 3.5 3 6l2.5 2.5"/><path d="M3 6h6.5a3.5 3.5 0 0 1 0 7H7"/></svg>',
}

// Quiet icons first, the one action that moves the hunk last, so it sits where Stage sits in the file header.
export function hunkActsHTML(f, h, hi) {
  const side = sideOf(f)
  const picked = review.sel && review.sel.path === f.path && review.sel.hi === hi ? review.sel.lines.size : 0
  const lines = n => `${n} line${n === 1 ? '' : 's'}`
  let quiet = '', main = ''
  if (notable()) {
    const n = review.notes.filter(x => x.path === f.path && x.line > 0 && h.lines.some(l => l.i !== undefined && x.side === lineSide(l) && lastLine(x) === lineNo(l))).length
    quiet += BTN('note', ICO.note + (n ? `<span class="n">${n}</span>` : ''), picked ? `Add a note on the ${lines(picked)} selected (c)` : n ? `${n} note${n === 1 ? '' : 's'} on this hunk. Click to add another (c)` : 'Add a note to this hunk (c)', n ? 'has' : 'icon')
  }
  if (side === 'work') {
    quiet += picked ? BTN('discard', `Discard ${picked}`, 'Throw away only the selected lines', 'danger') : BTN('discard', ICO.undo, 'Discard this hunk', 'danger icon')
    main = BTN('stage', picked ? `Stage ${lines(picked)}` : 'Stage hunk', picked ? 'Stage only the selected lines' : 'Stage this hunk', 'main')
  } else if (side === 'index') {
    main = BTN('unstage', picked ? `Unstage ${lines(picked)}` : 'Unstage hunk', picked ? 'Unstage only the selected lines' : 'Unstage this hunk', 'main')
  } else if (side === 'both') {
    main = `<span class="hint-s" title="This file has staged and unstaged changes. Use the Unstaged or Staged view to stage single hunks.">partly staged</span>`
  }
  return `<span class="hacts">${quiet}${main}</span>`
}

export const lineAttr = l => (l.t === 'meta' ? '' : ` data-l="${l.i}"`)

// ---------- notes drawn in the diff ----------
const rangeLabel = n => (n.end && n.end !== n.line ? `<span class="lnote-range">lines ${n.line}–${n.end}</span>` : '')

const noteBlock = n => `<div class="lnote${n.done ? ' done' : ''}" data-note="${esc(n.id)}"><span class="lnote-ico">${ICO.note}</span><div class="lnote-text">${rangeLabel(n)}${esc(n.text)}</div><span class="lnote-acts"><button class="hbtn" data-nact="done" title="${n.done ? 'Reopen' : 'Mark as addressed'}">${n.done ? 'Reopen' : 'Done'}</button><button class="hbtn" data-nact="edit">Edit</button><button class="hbtn danger" data-nact="delete">Delete</button></span></div>`

export function noteRowsHTML(f, hi, l) {
  let h = ''
  for (const n of notesAt(f.path, l)) h += review.editing?.id === n.id ? editorHTML(n.text, n.id) : `<div class="lnote-row">${noteBlock(n)}</div>`
  const e = review.editing
  if (e && !e.id && e.path === f.path && e.side === lineSide(l) && (e.end || e.line) === lineNo(l) && e.hi === hi) h += editorHTML('', '')
  return h
}

// Notes on the whole file sit under its header.
export function fileNotesHTML(f) {
  return fileNotesOf(f.path).map(n => `<div class="lnote-row file">${noteBlock(n)}</div>`).join('')
}

const editorHTML = (text, id) => `<div class="lnote-row"><div class="lnote-edit"><textarea class="field" rows="3" placeholder="Note for the agent. ⌘↵ saves, Esc cancels." data-nid="${esc(id)}">${esc(text)}</textarea><span class="lnote-acts"><button class="btn sm primary" data-nact="save">Save note</button><button class="btn sm quiet" data-nact="cancel">Cancel</button></span></div></div>`

export function noteAt(f, hi, l) { if (l) openEditor(f.path, hi, l) }

function openEditor(path, hi, l, range) {
  if (!notable()) return ctx.setStatus('Notes are written on All changes or Unstaged: they point at your working tree, not at a commit or a comparison.')
  const h = ctx.state.diffFiles.find(f => f.path === path)?.hunks[hi]
  // With lines picked in this hunk, the note covers them (as a run on the new side).
  const picked = range && h ? h.lines.filter(x => range.has(x.i)) : []
  const news = picked.filter(x => x.n != null)
  const first = news[0], last = news.at(-1)
  review.editing = news.length > 1
    ? { id: '', path, hi, side: 'new', line: first.n, end: last.n, code: quoteLines(news.map(x => x.text)) }
    : { id: '', path, hi, side: lineSide(l), line: lineNo(l), code: quoteFor(l.text) }
  repaintFileOf(path)
  ctx.$('#diff .lnote-edit textarea')?.focus()
}

const quoteLines = lines => {
  const shown = lines.filter(t => t.trim()).slice(0, 3).map(t => quoteFor(t, 120))
  return shown.join('\n') + (lines.length > 3 ? '\n…' : '')
}

function repaintFileOf(path) {
  const i = ctx.state.diffFiles.findIndex(f => f.path === path)
  if (i >= 0) ctx.rerenderFile(i)
}

// ---------- clicks in the diff ----------
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
    // The sign column adds a note; the line-number column selects the line for staging and for a note.
    if (no.classList.contains('sg')) { openEditor(f.path, hi, l); return true }
    if (no.classList.contains('no') && (l.t === 'add' || l.t === 'del')) { toggleLine(f, hi, l, e.shiftKey); return true }
  }
  return false
}

function toggleLine(f, hi, l, range) {
  const h = f.hunks[hi]
  if (!review.sel || review.sel.path !== f.path || review.sel.hi !== hi) review.sel = { path: f.path, hi, lines: new Set(), anchor: null }
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
  const h = f.hunks[hi]
  const picked = review.sel && review.sel.path === f.path && review.sel.hi === hi ? review.sel.lines : null
  if (act === 'note') {
    const l = (picked && h.lines.find(x => picked.has(x.i))) || h.lines.find(x => x.t === 'add' || x.t === 'del') || h.lines[0]
    return l && openEditor(f.path, hi, l, picked)
  }
  const reverse = act !== 'stage'
  const patch = hunkPatch(f, hi, { lines: picked, reverse })
  if (!patch) return ctx.setStatus('Nothing selected to apply', 'err')
  if (act === 'discard') {
    const what = picked ? `${picked.size} selected line${picked.size === 1 ? '' : 's'}` : 'this hunk'
    const ok = await ctx.ask({ title: `Discard ${what}`, kicker: 'restorable', tone: 'danger', ok: 'Discard', html: `<p class="say">${esc(f.path)} — ${esc(h.range)}</p><p class="note">A snapshot is kept, so ⌘⇧P → Restore the last discard brings it back.</p>` })
    if (!ok) return
  }
  review.sel = null
  // The diff is drawn again after Git answers; app.js focuses the hunk that takes this one's place.
  ctx.state.focusAfter = { path: f.path, hi, before: f.hunks.length }
  await ctx.gitAction({ action: 'apply', patch, target: act === 'discard' ? 'worktree' : 'index', reverse })
}

function noteAction(btn, f) {
  const act = btn.dataset.nact
  const row = btn.closest('.lnote, .lnote-edit')
  if (act === 'cancel') { review.editing = null; return repaintFileOf(f.path) }
  if (act === 'save') {
    const text = row.querySelector('textarea').value.trim()
    if (!text) { review.editing = null; return repaintFileOf(f.path) }
    const e = review.editing
    if (e?.id) { const n = review.notes.find(x => x.id === e.id); if (n) n.text = text }
    else if (e) review.notes.push({ id: newId(), path: e.path, side: e.side, line: e.line, end: e.end, code: e.code, text, ts: Date.now(), done: false })
    review.editing = null
    saveReview()
    return repaintFileOf(f.path)
  }
  const n = review.notes.find(x => x.id === row.dataset.note)
  if (!n) return
  if (act === 'done') { n.done = !n.done; saveReview(); repaintFileOf(f.path) }
  else if (act === 'edit') { review.editing = { id: n.id }; repaintFileOf(f.path); ctx.$('#diff .lnote-edit textarea')?.focus() }
  else if (act === 'delete') { review.notes = review.notes.filter(x => x.id !== n.id); saveReview(); repaintFileOf(f.path) }
}

// ⌘↵ saves and Esc cancels the note being written.
document.addEventListener('keydown', e => {
  const ta = e.target.closest?.('.lnote-edit textarea')
  if (!ta) return
  if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); ta.closest('.lnote-edit').querySelector('[data-nact="cancel"]').click() }
  else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); e.stopPropagation(); ta.closest('.lnote-edit').querySelector('[data-nact="save"]').click() }
}, true)

// ---------- notes from the editor, and on whole files ----------
// A dialog is used wherever a note is not drawn inline: on a file, in the editor, and when editing from the list.
function noteDialog({ title, kicker, quote = '', text = '', onSave, onDelete }) {
  const body = document.createElement('div')
  body.innerHTML = `${quote ? `<pre class="note-quote">${esc(quote)}</pre>` : ''}<textarea class="field note-ta" rows="5" placeholder="Note for the agent. ⌘↵ saves."></textarea>`
  const ta = body.querySelector('textarea')
  ta.value = text
  const m = openModal({
    title, kicker, body,
    actions: [{ label: 'Cancel' }, ...(onDelete ? [{ label: 'Delete', danger: true, run: () => { onDelete() } }] : []),
      { label: 'Save note', primary: true, run: () => { const v = ta.value.trim(); if (!v) return false; onSave(v) } }],
  })
  ta.focus()
  ta.addEventListener('keydown', e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); m.buttons['Save note'].click() } })
}

// A note on the whole file: a to-do the agent should know about.
export function addFileNote(path) {
  if (!path) return ctx.setStatus('Open a file first')
  noteDialog({ title: `Note on ${path.split('/').pop()}`, kicker: 'whole file', onSave: text => { review.notes.push({ id: newId(), path, side: 'new', line: 0, text, ts: Date.now(), done: false }); saveReview(path) } })
}

// A note on the lines selected in the editor, or the caret's line.
export function addEditorNote() {
  const t = ctx.activeTab(), ed = ctx.$('#editor')
  if (!t || t.binary || ctx.state.mode !== 'file') return ctx.setStatus('Open a text file in the editor first')
  const text = ed.value, s = ed.selectionStart, e = ed.selectionEnd
  const lineAt = off => text.slice(0, off).split('\n').length
  const a = lineAt(s), b = lineAt(e > s && text[e - 1] === '\n' ? e - 1 : e)
  const lines = text.split('\n').slice(a - 1, b)
  noteDialog({
    title: a === b ? `Note on line ${a}` : `Note on lines ${a}–${b}`, kicker: t.path.split('/').pop(), quote: quoteLines(lines),
    onSave: body => { review.notes.push({ id: newId(), path: t.path, side: 'new', line: a, end: b > a ? b : undefined, code: quoteLines(lines), text: body, ts: Date.now(), done: false }); saveReview(t.path) },
  })
}

export const noteLinesFor = path => {
  const set = new Map()
  for (const n of review.notes) if (n.path === path && n.line > 0 && !n.done) for (let k = n.line; k <= lastLine(n); k++) set.set(k, n.id)
  return set
}

// Clicking a note's marker in the editor edits it.
export function openNoteById(id) {
  const n = review.notes.find(x => x.id === id)
  if (!n) return
  noteDialog({
    title: 'Note', kicker: `${n.path.split('/').pop()}${n.line ? `:${n.line}${n.end && n.end !== n.line ? `–${n.end}` : ''}` : ''}`, quote: n.code || '', text: n.text,
    onSave: text => { n.text = text; saveReview(n.path) },
    onDelete: () => { review.notes = review.notes.filter(x => x.id !== n.id); saveReview(n.path) },
  })
}

// ---------- keys in the review ----------
export function handleKey(e) {
  if (e.key !== 'c' || ctx.state.mode !== 'diff' || !notable()) return false
  const s = ctx.state, f = s.diffFiles[s.current]
  if (!f || s.hunk < 0) return false
  hunkAction('note', f, s.hunk)
  return true
}

// ---------- the Notes rail ----------
export const hasNotes = f => review.notes.some(n => n.path === f.path && !n.done)

export function promptText() {
  const st = ctx.state.status || {}
  return reviewPrompt({ repo: st.root ? st.root.split('/').pop() : '', branch: st.branch || '', notes: review.notes })
}

const rowRange = n => (!n.line ? 'file' : n.end && n.end !== n.line ? `${n.line}–${n.end}` : `${n.side === 'old' ? '−' : ''}${n.line}`)

export function renderNotesPane() {
  const box = ctx.$('#notes')
  const open = review.notes.filter(n => !n.done), done = review.notes.length - open.length
  const badge = ctx.$('#note-count')
  if (badge) badge.textContent = open.length || ''
  if (!box) return
  const byFile = new Map()
  for (const n of [...review.notes].sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line)) byFile.has(n.path) ? byFile.get(n.path).push(n) : byFile.set(n.path, [n])
  let h = `<div class="notes-head"><b>${open.length}</b> open · ${done} addressed</div>`
  h += `<div class="notes-acts"><button class="btn sm primary" data-notes="prompt" ${open.length ? '' : 'disabled'} title="Copy the notes with instructions an agent can follow">Copy for agent</button><button class="btn sm" data-notes="plain" ${review.notes.length ? '' : 'disabled'} title="Copy only the file, line and note of each">Copy notes</button></div>`
  h += `<div class="notes-acts"><button class="btn sm quiet" data-notes="file" title="Add a note to the file you are looking at">+ File note</button><button class="btn sm quiet" data-notes="clear" ${done ? '' : 'disabled'} title="Remove the notes marked Done">Clear done</button><button class="btn sm quiet" data-notes="clear-all" ${review.notes.length ? '' : 'disabled'} title="Delete every note">Clear all</button></div>`
  if (!review.notes.length) h += `<div class="empty"><b>No notes yet</b>Click the sign column of a diff line, pick lines by their numbers and press <kbd>c</kbd>, or select lines in the editor and use <b>Note</b>. Add a note to a whole file from its header.</div>`
  for (const [path, ns] of byFile) {
    h += `<div class="group-label qgroup"><span class="gname">${esc(path.split('/').pop())} <i>${esc(path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '')}</i></span><span class="count">${ns.length}</span></div>`
    h += ns.map(n => `<div class="nrow${n.done ? ' done' : ''}" data-nid="${esc(n.id)}" title="${esc(noteRef(n))}"><span class="nline">${rowRange(n)}</span><span class="ntext">${esc(n.text)}</span><span class="nacts"><button class="hbtn icon" data-nedit title="Edit">✎</button><button class="hbtn icon" data-ndel title="Delete">✕</button></span></div>`).join('')
  }
  box.innerHTML = h
}

export function initReview() {
  ctx.$('#notes')?.addEventListener('click', async e => {
    const b = e.target.closest('[data-notes]')
    if (b) {
      const k = b.dataset.notes
      if (k === 'clear') { review.notes = review.notes.filter(n => !n.done); return saveReview(true) }
      if (k === 'file') return addFileNote(ctx.currentPath?.())
      if (k === 'clear-all') {
        const ok = await ctx.ask({ title: `Delete ${review.notes.length} note${review.notes.length === 1 ? '' : 's'}`, kicker: 'no undo', tone: 'danger', ok: 'Delete all', html: '<p>Every note for this repository is removed, including the ones not yet addressed.</p>' })
        if (!ok) return
        review.notes = []; review.editing = null; return saveReview(true)
      }
      const text = k === 'prompt' ? promptText() : notesText(review.notes)
      try { await ctx.copyText(text); ctx.setStatus(k === 'prompt' ? 'Copied the review prompt for your agent' : 'Copied the notes', 'ok') } catch (err) { ctx.setStatus(err.message, 'err') }
      return
    }
    const row = e.target.closest('.nrow')
    if (!row) return
    const n = review.notes.find(x => x.id === row.dataset.nid)
    if (!n) return
    if (e.target.closest('[data-nedit]')) return openNoteById(n.id)
    if (e.target.closest('[data-ndel]')) { review.notes = review.notes.filter(x => x.id !== n.id); return saveReview(n.path) }
    jumpToNote(n)
  })
  loadReview()
}

// Takes you to the note: where the diff draws it, else in the editor at its line.
async function jumpToNote(n) {
  if (ctx.state.mode === 'diff') {
    const el = ctx.$(`#diff [data-note="${CSS.escape(n.id)}"]`)
    if (el) return el.scrollIntoView({ block: 'center' })
  }
  await ctx.openFile(n.path, n.line ? { line: n.line } : {})
}
