// Language servers in the editor (decisions §8): go-to-definition, and semantic coloring laid over
// highlight.js. The server side is lsp.go; a file with no server installed keeps its hljs colors.
// Positions are UTF-16, which is what a JavaScript string offset is, so they pass through unchanged.
import { ctx } from './ctx.js'
import { overlay } from './highlight.js'

// ---------- positions ----------
// position turns a text offset into the line and character a language server asks for.
export function position(text, offset) {
  const before = text.slice(0, offset), line = before.split('\n').length - 1
  return { line, character: offset - (before.lastIndexOf('\n') + 1) }
}

// offsetOf is the inverse, clamped to the line so a stale position never lands on the next one.
export function offsetOf(text, line, character) {
  let at = 0
  for (let k = 0; k < line; k++) {
    const nl = text.indexOf('\n', at)
    if (nl < 0) return text.length
    at = nl + 1
  }
  const nl = text.indexOf('\n', at)
  return Math.min(at + character, nl < 0 ? text.length : nl)
}

// ---------- go to definition ----------
const jumps = []
const ed = () => ctx.$('#editor')
const MESSAGES = {
  none: 'No language server for this kind of file',
  unsupported: 'This language server does not offer that',
}

// goToDefinition jumps to where the word at the caret is defined.
export async function goToDefinition() {
  const tab = ctx.activeTab(), e = ed()
  if (!tab || tab.binary || ctx.state.mode !== 'file' || !e.classList.contains('active')) return
  const text = e.value, here = e.selectionStart
  const { line, character } = position(text, here)
  ctx.setStatus('Looking up the definition…')
  let res
  try { res = await ctx.post('/api/lsp/definition', { path: tab.path, content: text, line, character }) } catch (err) { return ctx.setStatus(err.message, 'err') }
  if (tab !== ctx.activeTab()) return
  if (res.status === 'missing') return ctx.setStatus(`${res.message} is not installed, so there is no definition lookup for this language`, 'err')
  if (res.status !== 'ok') return ctx.setStatus(res.message || MESSAGES[res.status] || 'Definition lookup failed', res.status === 'error' ? 'err' : '')
  const locs = res.locations || []
  if (!locs.length) return ctx.setStatus('No definition found here')
  const loc = locs[0]
  if (!loc.path) return ctx.setStatus(`Defined outside this repository: ${loc.external}:${loc.line + 1}`)
  if (locs.length === 1 && loc.path === tab.path) {
    // The caret is already on the definition itself.
    const word = /[\w$]*$/.exec(text.slice(0, here))[0].length, wordEnd = /^[\w$]*/.exec(text.slice(here))[0].length
    const at = offsetOf(text, loc.line, loc.character)
    if (at >= here - word && at <= here + wordEnd) return ctx.setStatus('This is the definition')
  }
  jumps.push({ path: tab.path, caret: here, scroll: e.scrollTop })
  if (jumps.length > 50) jumps.shift()
  await ctx.openFile(loc.path, { line: loc.line + 1 })
  const e2 = ed(), off = offsetOf(e2.value, loc.line, loc.character)
  e2.setSelectionRange(off, off)
  e2.focus({ preventScroll: true })
  ctx.paintAll?.()
  ctx.setStatus(`${loc.path}:${loc.line + 1}${locs.length > 1 ? ` (1 of ${locs.length} definitions)` : ''} — ⌃- goes back`)
}

// goBack returns to where the last jump started.
export async function goBack() {
  const j = jumps.pop()
  if (!j) return ctx.setStatus('Nowhere to go back to')
  await ctx.openFile(j.path)
  const e = ed()
  const at = Math.min(j.caret, e.value.length)
  e.setSelectionRange(at, at)
  e.scrollTop = j.scroll
  e.focus({ preventScroll: true })
  ctx.paintAll?.()
}

// ---------- semantic coloring ----------
// Each token type a server reports maps to a class; types highlight.js already colors well
// (keywords, strings, comments, numbers, operators) are left to it.
const CLASS = {
  function: 'sem-fn', method: 'sem-fn', macro: 'sem-fn',
  type: 'sem-type', class: 'sem-type', struct: 'sem-type', interface: 'sem-type', enum: 'sem-type', typeParameter: 'sem-type', namespace: 'sem-type',
  parameter: 'sem-param', enumMember: 'sem-const', property: 'sem-prop',
}
const DEBOUNCE = 600
const RETRY = 5000

// semClass picks a token's class from its type and modifiers (a readonly variable is a constant).
function semClass(type, mods) {
  if (type === 'variable') return mods.includes('readonly') ? 'sem-const' : ''
  return CLASS[type] || ''
}

// groupTokens turns the server's flat [line, char, length, type, modifiers] groups into sorted,
// non-overlapping ranges per line.
export function groupTokens(tokens, legend, modifiers) {
  const byLine = new Map()
  for (let i = 0; i + 4 < tokens.length; i += 5) {
    const [line, start, len, type, bits] = tokens.slice(i, i + 5)
    const mods = modifiers.filter((_, b) => bits & (1 << b))
    const cls = semClass(legend[type], mods)
    if (!cls) continue
    let row = byLine.get(line)
    if (!row) byLine.set(line, row = [])
    const prev = row[row.length - 1]
    if (!prev || prev.end <= start) row.push({ start, end: start + len, cls })
  }
  return byLine
}

// alignLine says which line of the old text a line of the new text is, assuming one edit: lines
// before the first change keep their index, lines after the last shift by the change in length.
export function alignLine(oldLines, newLines, i) {
  let p = 0
  const max = Math.min(oldLines.length, newLines.length)
  while (p < max && oldLines[p] === newLines[p]) p++
  let s = 0
  while (s < max - p && oldLines[oldLines.length - 1 - s] === newLines[newLines.length - 1 - s]) s++
  if (i < p) return i
  if (i >= newLines.length - s) return i - (newLines.length - oldLines.length)
  return -1
}

// decorate returns a row's highlight with the semantic ranges laid over it, but only while the line
// is the text the tokens were computed for, so typing never shows colors on the wrong characters.
export function decorate(tab, i, html) {
  const s = tab.sem
  if (!s) return html
  if (!s.lines) s.lines = s.text.split('\n')
  if (s.now !== tab.content) { s.now = tab.content; s.nowLines = tab.content.split('\n') }
  const at = alignLine(s.lines, s.nowLines, i)
  if (at < 0 || s.lines[at] !== s.nowLines[i]) return html
  const r = s.byLine.get(at)
  return r ? overlay(html, r) : html
}

let timer, abort
const unsupported = new Set()
const extOf = path => path.slice(path.lastIndexOf('.')).toLowerCase()

// refresh asks for the active tab's tokens soon, unless they are already for this text.
export function refresh(delay = 150) {
  clearTimeout(timer)
  timer = setTimeout(() => request(ctx.activeTab(), 0), delay)
}

async function request(tab, attempt) {
  const e = ed()
  if (!tab || tab !== ctx.activeTab() || tab.binary || tab.tooLarge || ctx.state.mode !== 'file' || !e.classList.contains('active')) return
  if (!tab.path.includes('.') || unsupported.has(extOf(tab.path))) return
  const text = e.value
  if (tab.sem?.text === text) return
  abort?.abort()
  abort = new AbortController()
  let res
  try { res = await ctx.api('/api/lsp/tokens', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: tab.path, content: text }), signal: abort.signal }) } catch (err) {
    if (err.name === 'AbortError') return
    return retry(tab, attempt)
  }
  if (res.status === 'none' || res.status === 'missing' || res.status === 'unsupported') return void unsupported.add(extOf(tab.path))
  if (res.status !== 'ok') return retry(tab, attempt)
  // A server that is still indexing can answer with nothing; try again shortly.
  if (!res.tokens?.length && attempt < 3) return retry(tab, attempt)
  tab.sem = { text, byLine: groupTokens(res.tokens || [], res.legend || [], res.modifiers || []) }
  if (tab === ctx.activeTab()) ctx.paintAll?.()
}

function retry(tab, attempt) {
  if (attempt >= 3) return
  clearTimeout(timer)
  timer = setTimeout(() => request(ctx.activeTab(), attempt + 1), RETRY)
}

// ---------- wiring ----------
export function initLsp() {
  const e = ed()
  e.addEventListener('input', () => refresh(DEBOUNCE))
  e.addEventListener('click', ev => { if ((ev.metaKey || ev.ctrlKey) && !ev.altKey && !ev.shiftKey) goToDefinition() })
  e.addEventListener('keydown', ev => {
    if (ev.key === 'F12' && !ev.metaKey && !ev.ctrlKey && !ev.altKey) { ev.preventDefault(); goToDefinition() }
    else if (ev.key === '-' && ev.ctrlKey && !ev.metaKey && !ev.altKey) { ev.preventDefault(); goBack() }
  })
  // While ⌘ (or Ctrl) is down a click is a jump, so the pointer says so.
  const held = ev => e.classList.toggle('cmd-held', ev.metaKey || ev.ctrlKey)
  window.addEventListener('keydown', held)
  window.addEventListener('keyup', held)
  window.addEventListener('blur', () => e.classList.remove('cmd-held'))
}
