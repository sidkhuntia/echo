// Several carets in the textarea. The browser has one selection, so the others are kept here, drawn on a
// layer over the text, and every edit is applied to all of them in one replacement (one undo step).
import { ctx } from './ctx.js'
import { replaceRange } from './edit.js'

const ed = () => ctx.$('#editor')
let extras = [] // { s, e } ranges besides the textarea's own selection

export const active = () => extras.length > 0
export function clear() {
  if (!extras.length) return
  extras = []
  paint()
  ctx.setStatus('')
}

const all = () => [...extras, { s: ed().selectionStart, e: ed().selectionEnd, primary: true }].sort((a, b) => a.s - b.s)

// Merge ranges that touch or overlap, keeping the primary one flagged.
function normalize(list) {
  const out = []
  for (const r of list.sort((a, b) => a.s - b.s || a.e - b.e)) {
    const last = out.at(-1)
    // Overlapping ranges, or two carets on the same spot, are one; ranges that merely touch stay apart.
    if (last && (r.s < last.e || r.s === last.s)) { last.e = Math.max(last.e, r.e); last.primary ||= r.primary } else out.push({ ...r })
  }
  return out
}

function setFrom(list) {
  const norm = normalize(list)
  const primary = norm.find(r => r.primary) || norm.at(-1)
  extras = norm.filter(r => r !== primary).map(({ s, e }) => ({ s, e }))
  ed().setSelectionRange(primary.s, primary.e)
  paint()
  note()
}

const note = () => ctx.setStatus(extras.length ? `${extras.length + 1} cursors — Esc to go back to one` : '')

// ---------- adding cursors ----------
function wordAt(text, i) {
  const a = text.slice(0, i).match(/[\w$]*$/)[0], b = text.slice(i).match(/^[\w$]*/)[0]
  return [i - a.length, i + b.length]
}

export function addNextOccurrence() {
  const e = ed(), text = e.value
  let [s, en] = [e.selectionStart, e.selectionEnd]
  if (s === en) {
    const [a, b] = wordAt(text, s)
    if (a === b) return
    e.setSelectionRange(a, b)
    paint()
    return
  }
  const needle = text.slice(s, en)
  const taken = all()
  let from = Math.max(...taken.map(r => r.e)), at = text.indexOf(needle, from)
  if (at < 0) at = text.indexOf(needle)
  while (at >= 0 && taken.some(r => r.s === at)) {
    const next = text.indexOf(needle, at + 1)
    if (next < 0 || next === at) { at = -1; break }
    at = next
  }
  if (at < 0) return ctx.setStatus('No more matches')
  setFrom([...taken.map(r => ({ s: r.s, e: r.e })), { s: at, e: at + needle.length, primary: true }])
  reveal(at)
}

export function selectAllOccurrences() {
  const e = ed(), text = e.value
  let [s, en] = [e.selectionStart, e.selectionEnd]
  if (s === en) { [s, en] = wordAt(text, s); if (s === en) return }
  const needle = text.slice(s, en), list = []
  for (let at = text.indexOf(needle); at >= 0 && list.length < 2000; at = text.indexOf(needle, at + needle.length)) list.push({ s: at, e: at + needle.length })
  list.find(r => r.s === s).primary = true
  setFrom(list)
}

function lineCol(text, off) {
  const ls = text.lastIndexOf('\n', off - 1) + 1
  return [text.slice(0, ls).split('\n').length - 1, off - ls]
}

export function addCursorVertical(dir) {
  const e = ed(), text = e.value, taken = all()
  const edge = dir > 0 ? taken.at(-1) : taken[0]
  const [line, col] = lineCol(text, edge.e)
  const lines = text.split('\n'), target = line + dir
  if (target < 0 || target >= lines.length) return
  let off = 0
  for (let i = 0; i < target; i++) off += lines[i].length + 1
  const at = off + Math.min(col, lines[target].length)
  setFrom([...taken.map(r => ({ s: r.s, e: r.e })), { s: at, e: at, primary: true }])
  reveal(at)
}

function reveal(off) {
  const e = ed(), line = lineCol(e.value, off)[0], top = ctx.lineTop(line)
  if (top < e.scrollTop || top + 20 > e.scrollTop + e.clientHeight) e.scrollTop = Math.max(0, top - e.clientHeight / 3)
}

// ---------- editing at every cursor ----------
// edits maps each range to its replacement text; `after` says where the caret ends up inside it.
function applyEach(fn) {
  const e = ed(), text = e.value, list = all()
  const plans = list.map(r => ({ r, ...fn(r, text) })).filter(p => p.del !== null)
  if (!plans.length) return
  // The one replaced span runs from the first edit to the last; the text between edits stays as it was.
  const lo = Math.min(...plans.map(p => p.start)), hi = Math.max(...plans.map(p => p.end))
  let out = '', cursor = lo, delta = 0
  const carets = []
  for (const p of plans.sort((a, b) => a.start - b.start)) {
    out += text.slice(cursor, p.start)
    const at = lo + out.length
    out += p.text
    carets.push({ pos: at + p.text.length, primary: !!p.r.primary })
    cursor = p.end
  }
  out += text.slice(cursor, hi)
  const primary = carets.find(c => c.primary) || carets.at(-1)
  replaceRange(e, lo, hi, out, primary.pos)
  extras = carets.filter(c => c !== primary).map(c => ({ s: c.pos, e: c.pos }))
  paint()
  note()
}

export function insertAll(str) {
  applyEach(r => ({ start: r.s, end: r.e, text: str }))
}

function onBeforeInput(ev) {
  if (!active()) return
  const t = ev.inputType
  const edit = {
    insertText: () => insertAll(ev.data ?? ''),
    insertLineBreak: () => insertAll('\n'),
    insertParagraph: () => insertAll('\n'),
    deleteContentBackward: () => applyEach((r, text) => r.s !== r.e ? { start: r.s, end: r.e, text: '' } : r.s > 0 ? { start: r.s - 1, end: r.s, text: '' } : { del: null }),
    deleteContentForward: () => applyEach((r, text) => r.s !== r.e ? { start: r.s, end: r.e, text: '' } : r.s < text.length ? { start: r.s, end: r.s + 1, text: '' } : { del: null }),
    deleteWordBackward: () => applyEach((r, text) => r.s !== r.e ? { start: r.s, end: r.e, text: '' } : { start: r.s - (text.slice(0, r.s).match(/(\s*[\w$]+|\s*[^\w\s$]|\s+)$/)?.[0].length || 0), end: r.s, text: '' }),
    deleteByCut: () => applyEach(r => ({ start: r.s, end: r.e, text: '' })),
    insertFromPaste: () => {
      const pasted = ev.dataTransfer?.getData('text/plain') ?? ''
      const lines = pasted.split('\n'), list = all()
      // As many lines as cursors: one line each, the way VS Code pastes.
      if (lines.length === list.length) { let i = 0; applyEach(r => ({ start: r.s, end: r.e, text: lines[list.findIndex(x => x.s === r.s && x.e === r.e)] ?? lines[i++] })) }
      else insertAll(pasted)
    },
  }[t]
  if (!edit) return
  ev.preventDefault()
  edit()
}

// ---------- keys ----------
export function handleKey(e) {
  const mod = e.metaKey || e.ctrlKey
  if (mod && e.altKey && e.code === 'KeyD') { e.preventDefault(); e.stopPropagation(); addNextOccurrence(); return true }
  if (mod && e.shiftKey && !e.altKey && e.key.toLowerCase() === 'l') { e.preventDefault(); e.stopPropagation(); selectAllOccurrences(); return true }
  if (mod && e.altKey && (e.code === 'ArrowDown' || e.code === 'ArrowUp')) { e.preventDefault(); e.stopPropagation(); addCursorVertical(e.code === 'ArrowDown' ? 1 : -1); return true }
  if (!active()) return false
  if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); clear(); return true }
  if (e.key === 'Tab' && !mod) { e.preventDefault(); e.stopPropagation(); insertAll(ctx.indentUnit()); return true }
  if (e.key.startsWith('Arrow') || e.key === 'Home' || e.key === 'End') { setTimeout(clear, 0); return false }
  return false
}

// ---------- drawing ----------
export function paint() {
  const el = ctx.$('#mcmarks'), t = ctx.activeTab()
  if (!el) return
  if (!extras.length || !t || ctx.state.mode !== 'file') { el.classList.remove('active'); el.innerHTML = ''; return }
  const e = ed(), lines = ctx.tabLines(t), [first, last] = ctx.visibleRange(t)
  let h = '', off = 0
  const starts = []
  for (const l of lines) { starts.push(off); off += l.length + 1 }
  for (let i = first; i < last; i++) {
    const ls = starts[i], le = ls + lines[i].length
    const segs = []
    for (const r of extras) {
      if (r.e < ls || r.s > le) continue
      segs.push([Math.max(r.s, ls) - ls, Math.min(r.e, le) - ls, r.s === r.e])
    }
    if (!segs.length) continue
    segs.sort((a, b) => a[0] - b[0])
    let at = 0, row = ''
    for (const [a, b, caret] of segs) {
      if (a < at) continue
      row += ctx.esc(lines[i].slice(at, a))
      row += caret ? '<span class="mcaret"></span>' : `<mark>${ctx.esc(lines[i].slice(a, b)) || ' '}</mark>`
      at = b
    }
    h += `<div class="sl" style="top:${ctx.lineTop(i) - e.scrollTop}px">${row + ctx.esc(lines[i].slice(at))}</div>`
  }
  el.classList.add('active')
  el.innerHTML = `<div style="transform:translateX(${-e.scrollLeft}px)">${h}</div>`
}

export function initMulti() {
  ed().addEventListener('beforeinput', onBeforeInput)
  ed().addEventListener('mousedown', () => { if (active()) clear() })
}
