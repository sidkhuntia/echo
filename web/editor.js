// Editing behavior on top of the textarea: indentation, auto-closing, comments, line commands, the
// settings the editor reads, and the layers drawn over the text (rulers, guides, occurrences, the
// minimap, sticky scope headers, breadcrumbs).
import { ctx } from './ctx.js'
import * as E from './editing.js'
import { replaceRange, applyText } from './edit.js'
import * as MC from './multicursor.js'
import * as Vim from './vimui.js'

const ed = () => ctx.$('#editor')
const cfg = () => ctx.state.config
const tab = () => ctx.activeTab()
const inEditor = () => ctx.state.mode === 'file' && ed().classList.contains('active') && !!tab()

// ---------- settings ----------
let cw = 0
export function charW() {
  if (!cw) { const x = document.createElement('canvas').getContext('2d'); x.font = getComputedStyle(ed()).font; cw = x.measureText('0000000000').width / 10 }
  return cw
}

export function applySettings() {
  const c = cfg(), root = document.documentElement.style
  root.setProperty('--ed-fs', (c.fontSize || 12) + 'px')
  const stage = ctx.$('.stage')
  stage.classList.toggle('ws-on', !!c.whitespace)
  stage.classList.toggle('mm-on', !!c.minimap)
  cw = 0
  ctx.resetMetrics?.()
  paintTab()
  ctx.paintAll?.()
}

// The tab width the textarea draws a tab character at follows the indent unit.
function paintTab() {
  const t = tab()
  const unit = unitFor(t)
  const size = unit === '\t' ? (cfg().tabSize || t?.detected?.size || 4) : unit.length
  document.documentElement.style.setProperty('--ed-tab', size)
}

export function unitFor(t) {
  if (t && t.detected === undefined) t.detected = E.detectIndent(t.content || '')
  return E.indentUnit(cfg(), t?.detected)
}

// ---------- edits ----------
const apply = edit => { if (edit) replaceRange(ed(), edit.start, edit.end, edit.text, edit.selStart, edit.selEnd) }
const sel = () => { const e = ed(); return [e.selectionStart, e.selectionEnd, e.value] }
const PAIRS = { '(': ')', '[': ']', '{': '}', '"': '"', "'": "'", '`': '`' }
const CLOSERS = new Set([')', ']', '}', '"', "'", '`'])
const wordCh = ch => !!ch && /[\w$]/.test(ch)
let tabFocus = false

function onKeyDown(e) {
  if (!inEditor() || e.isComposing) return
  if (MC.handleKey(e)) return
  const mod = e.metaKey || e.ctrlKey, [s, en, t] = sel(), t0 = tab()
  const done = f => { e.preventDefault(); e.stopPropagation(); f() }

  if (e.key === 'm' && e.ctrlKey && !e.metaKey) return done(() => { tabFocus = !tabFocus; ctx.setStatus(tabFocus ? 'Tab moves focus (Ctrl-M to go back to indenting)' : 'Tab indents') })
  if (e.key === 'Tab' && !mod && !e.altKey && !tabFocus) {
    return done(() => {
      const unit = unitFor(t0), multi = t.slice(s, en).includes('\n')
      if (e.shiftKey || multi) apply(E.indentLines(t, s, en, unit, e.shiftKey))
      else replaceRange(ed(), s, en, unit)
    })
  }
  if (MC.active()) return
  if (e.key === 'Enter' && !mod && !e.shiftKey && !e.altKey) return done(() => apply(E.enterEdit(t, s, en, unitFor(t0))))
  if (!mod && !e.altKey && cfg().autoClose !== false && autoClose(e, t, s, en)) { e.preventDefault(); e.stopPropagation(); return }
  if (mod && !e.shiftKey && !e.altKey && e.key === '/') return done(() => { const ed1 = E.toggleComment(t, s, en, t0.path); if (ed1) apply(ed1); else ctx.setStatus('No comment syntax known for this file type') })
  if (e.altKey && !mod && (e.code === 'ArrowUp' || e.code === 'ArrowDown')) return done(() => apply(e.shiftKey ? E.duplicateLines(t, s, en, e.code === 'ArrowDown' ? 1 : -1) : E.moveLines(t, s, en, e.code === 'ArrowDown' ? 1 : -1)))
  if (mod && e.shiftKey && e.key.toLowerCase() === 'k') return done(() => apply(E.deleteLines(t, s, en)))
  if (mod && e.shiftKey && (e.key === '\\' || e.key === '|')) return done(() => {
    const m = E.matchBracket(t, s)
    if (m >= 0) { ed().setSelectionRange(m, m); ctx.paintAll?.() } else ctx.setStatus('No matching bracket')
  })
}

// autoClose returns true when it handled the key. Typing an opener adds its closer, typing a closer
// over one steps past it, Backspace between a pair removes both, and a selection is wrapped.
function autoClose(e, t, s, en) {
  const k = e.key, next = t[en], prev = t[s - 1]
  if (k in PAIRS) {
    const close = PAIRS[k]
    if (s !== en) { replaceRange(ed(), s, en, k + t.slice(s, en) + close, s + 1, en + 1); return true }
    if (k === close && next === close) { ed().setSelectionRange(s + 1, s + 1); return true }
    if (/["'`]/.test(k) && (wordCh(prev) || wordCh(next))) return false
    if (next && !/[\s)\]},;:.]/.test(next) && k !== '{') return false
    replaceRange(ed(), s, en, k + close, s + 1)
    return true
  }
  if (CLOSERS.has(k) && s === en && next === k) { ed().setSelectionRange(s + 1, s + 1); return true }
  if (k === 'Backspace' && s === en && prev && PAIRS[prev] === next && next !== undefined) { replaceRange(ed(), s - 1, s + 1, '', s - 1); return true }
  return false
}

// ---------- save-time cleanups and autosave ----------
export function beforeSave() {
  const e = ed(), t = tab()
  if (!t || !inEditor()) return
  let text = e.value
  if (cfg().trimTrailing) text = text.replace(/[ \t]+$/gm, '')
  if (cfg().finalNewline && text && !text.endsWith('\n')) text += '\n'
  if (text !== e.value) applyText(e, text)
}

let autoTimer = 0
function scheduleAutosave() {
  clearTimeout(autoTimer)
  if (cfg().autosave !== 'delay') return
  autoTimer = setTimeout(() => { const t = tab(); if (t && !t.conflict && t.content !== t.saved && inEditor()) ctx.saveFile() }, 1500)
}
function saveOnBlur() {
  if (cfg().autosave !== 'blur') return
  const t = tab()
  if (t && !t.conflict && t.content !== t.saved && inEditor()) ctx.saveFile()
}

// ---------- JSON ----------
export function formatJSON(minify = false) {
  const e = ed(), t = tab()
  if (!t || !/\.(json|jsonc|webmanifest)$/i.test(t.path)) return
  try {
    const v = JSON.parse(e.value)
    const indent = minify ? 0 : (unitFor(t) === '\t' ? '\t' : unitFor(t).length)
    applyText(e, JSON.stringify(v, null, indent) + (minify ? '' : '\n'))
    ctx.setStatus(minify ? 'Minified' : 'Formatted')
  } catch (err) { ctx.setStatus('Not valid JSON: ' + err.message, 'err') }
}

// ---------- line endings ----------
export async function convertEol() {
  const t = tab()
  if (!t || t.binary) return
  const to = t.eol === '\r\n' ? '\n' : '\r\n'
  const ok = await ctx.ask({ title: `Convert line endings to ${to === '\n' ? 'LF' : 'CRLF'}`, ok: 'Convert and save', html: `<p>${ctx.esc(t.path)} is saved with ${to === '\n' ? 'LF' : 'CRLF'} line endings. This writes the file now.</p>` })
  if (!ok) return
  t.eol = to
  await ctx.saveFile()
  ctx.renderEditor?.()
}

// ---------- layers over the text ----------
const esc = s => ctx.esc(s)

function rowsInView() {
  const t = tab()
  return t ? ctx.visibleRange(t) : [0, 0]
}

function paintRuler() {
  const el = ctx.$('#ruler'), col = cfg().ruler
  if (!el) return
  if (!col || !inEditor()) { el.hidden = true; return }
  const left = parseFloat(getComputedStyle(ed()).paddingLeft) + col * charW() - ed().scrollLeft
  el.style.left = left + 'px'
  el.hidden = false
}

function paintGuides() {
  const el = ctx.$('#guides'), t = tab()
  const on = inEditor() && cfg().indentGuides !== false && !ctx.state.wrap
  el.classList.toggle('active', on)
  if (!on) { el.innerHTML = ''; return }
  const unit = unitFor(t), cols = unit === '\t' ? (cfg().tabSize || t.detected?.size || 4) : unit.length
  const lines = ctx.tabLines(t), [first, last] = rowsInView(), w = charW(), pad = parseFloat(getComputedStyle(ed()).paddingLeft)
  const indentCols = l => { let n = 0; for (const ch of l) { if (ch === ' ') n++; else if (ch === '\t') n += cols; else break } return n }
  let html = ''
  for (let i = first; i < last; i++) {
    let c = lines[i].trim() ? indentCols(lines[i]) : 0
    if (!lines[i].trim()) {
      let a = i - 1, b = i + 1
      while (a >= 0 && !lines[a].trim()) a--
      while (b < lines.length && !lines[b].trim()) b++
      c = Math.min(a >= 0 ? indentCols(lines[a]) : 0, b < lines.length ? indentCols(lines[b]) : 0)
    }
    if (c < cols) continue
    html += `<i style="top:${ctx.lineTop(i) - ed().scrollTop}px;width:${(c - 0) * w}px;background-size:${cols * w}px 20px"></i>`
  }
  el.innerHTML = `<div style="left:${pad - ed().scrollLeft}px;position:absolute;top:0">${html}</div>`
}

// The word under the caret, marked everywhere it appears in the rows on screen.
function paintOccurrences() {
  const el = ctx.$('#occ'), t = tab()
  const [s, en] = [ed().selectionStart, ed().selectionEnd]
  let word = ''
  if (inEditor() && cfg().occurrences !== false && !ctx.find.open && s === en) {
    const text = ed().value, a = text.slice(0, s).match(/[\w$]*$/)[0], b = text.slice(s).match(/^[\w$]*/)[0]
    word = a + b
  }
  if (word.length < 2 || /^\d+$/.test(word)) { el.classList.remove('active'); el.innerHTML = ''; return }
  const re = new RegExp(`(?<![\\w$])${word.replace(/[$]/g, '\\$')}(?![\\w$])`, 'g')
  const lines = ctx.tabLines(t), [first, last] = rowsInView()
  let h = '', any = 0
  for (let i = first; i < last; i++) {
    const l = lines[i]
    if (!l.includes(word)) continue
    let at = 0, row = ''
    for (const m of l.matchAll(re)) { row += esc(l.slice(at, m.index)) + `<mark>${esc(m[0])}</mark>`; at = m.index + m[0].length; any++ }
    if (at) h += `<div class="sl" style="top:${ctx.lineTop(i) - ed().scrollTop}px">${row + esc(l.slice(at))}</div>`
  }
  el.classList.toggle('active', any > 1)
  el.innerHTML = any > 1 ? `<div style="transform:translateX(${-ed().scrollLeft}px)">${h}</div>` : ''
}

// Breadcrumbs name the declaration the caret is in; sticky headers repeat the ones scrolled out of sight.
function scopesAt(i) { return E.enclosingScopes(ctx.tabLines(tab()), i) }

function paintScopes() {
  const crumb = ctx.$('#crumb-sym'), sticky = ctx.$('#sticky'), t = tab()
  if (!inEditor()) { if (crumb) crumb.innerHTML = ''; sticky.hidden = true; return }
  const e = ed(), caretLine = lineOf(e.value, e.selectionStart)
  const at = scopesAt(caretLine)
  if (crumb) crumb.innerHTML = at.map(s => `<span class="sym" data-line="${s.line}" title="Line ${s.line + 1}">${esc(ctx.hunkLabel(s.text) || s.text)}</span>`).join('<i>›</i>')
  if (cfg().sticky === false || ctx.state.wrap || e.scrollTop < 20) { sticky.hidden = true; return }
  const first = Math.max(0, Math.floor((e.scrollTop - 10) / 20))
  const heads = scopesAt(first + 1).filter(s => s.line < first).slice(-3)
  if (!heads.length) { sticky.hidden = true; return }
  sticky.innerHTML = heads.map(s => `<div class="sticky-row" data-line="${s.line}">${esc(s.text)}</div>`).join('')
  sticky.hidden = false
}
const lineOf = (text, off) => { let n = 0; for (let k = text.indexOf('\n'); k >= 0 && k < off; k = text.indexOf('\n', k + 1)) n++; return n }

// ---------- minimap ----------
let mmTimer = 0, mmFor = null
function drawMinimap() {
  const cv = ctx.$('#minimap'), t = tab()
  const on = inEditor() && cfg().minimap && !ctx.state.wrap
  cv.hidden = !on
  ctx.$('#mm-view').hidden = !on
  if (!on) return
  const H = ed().clientHeight, W = 80, dpr = window.devicePixelRatio || 1
  cv.width = W * dpr; cv.height = H * dpr
  cv.style.height = H + 'px'
  const g = cv.getContext('2d')
  g.scale(dpr, dpr)
  const lines = ctx.tabLines(t), n = lines.length, per = Math.min(3, Math.max(0.5, H / n)), step = Math.max(1, Math.ceil(n * per / H))
  const cs = getComputedStyle(document.documentElement), col = v => cs.getPropertyValue(v).trim() || '#888'
  const base = col('--muted'), add = col('--add'), mod = col('--info')
  const marks = t.marks?.kinds || []
  for (let i = 0, y = 0; i < n; i += step, y += per) {
    const l = lines[i]
    if (!l.trim()) continue
    const lead = l.match(/^\s*/)[0].replace(/\t/g, '    ').length
    g.globalAlpha = marks[i] ? 0.95 : 0.45
    g.fillStyle = marks[i] === 'add' ? add : marks[i] ? mod : base
    g.fillRect(4 + Math.min(40, lead) * 0.5, y, Math.min(70, Math.max(2, (l.trimEnd().length - lead) * 0.5)), Math.max(1, per - 0.4))
  }
  mmFor = { n, per, H }
  paintMinimapView()
}

function paintMinimapView() {
  const v = ctx.$('#mm-view'), e = ed()
  if (!mmFor || v.hidden) return
  const total = e.scrollHeight || 1, mapH = Math.min(mmFor.H, mmFor.n * mmFor.per)
  v.style.top = (e.scrollTop / total) * mapH + 'px'
  v.style.height = Math.max(8, (e.clientHeight / total) * mapH) + 'px'
}

function minimapScroll(ev) {
  const cv = ctx.$('#minimap'), e = ed()
  if (!mmFor) return
  const r = cv.getBoundingClientRect(), mapH = Math.min(mmFor.H, mmFor.n * mmFor.per)
  const frac = Math.max(0, Math.min(1, (ev.clientY - r.top) / mapH))
  e.scrollTop = frac * e.scrollHeight - e.clientHeight / 2
}

// ---------- the one entry point app.js calls after it paints the text ----------
export function paintExtras() {
  paintRuler(); paintGuides(); paintOccurrences(); paintScopes(); paintMinimapView(); MC.paint(); Vim.refreshVim()
}

export function onRender() {
  const t = tab(), editing = inEditor()
  const eol = ctx.$('#eol')
  if (eol) { eol.hidden = !editing; if (editing) eol.textContent = t.eol === '\r\n' ? 'CRLF' : 'LF' }
  const fmt = ctx.$('#json-format')
  if (fmt) fmt.hidden = !(editing && /\.(json|jsonc|webmanifest)$/i.test(t.path))
  paintTab()
  clearTimeout(mmTimer)
  mmTimer = setTimeout(drawMinimap, 60)
}

export function onInput() {
  const t = tab()
  scheduleAutosave()
  clearTimeout(mmTimer)
  mmTimer = setTimeout(drawMinimap, 150)
}

// Decorates one highlighted row: tabs and the spaces at either end of a line, drawn faintly.
export function decorateRow(html) {
  if (!cfg().whitespace) return html
  return html.replace(/(^|>)([^<]+)/g, (m, pre, text) => pre + text
    .replace(/\t/g, '<span class="ws-t">\t</span>')
    .replace(/^ +| +$/g, s => `<span class="ws-s">${s}</span>`))
}

export function initEditor() {
  const e = ed()
  Vim.initVim()
  MC.initMulti()
  ctx.indentUnit = () => unitFor(tab())
  e.addEventListener('keydown', onKeyDown)
  e.addEventListener('blur', saveOnBlur)
  window.addEventListener('blur', saveOnBlur)
  for (const ev of ['keyup', 'mouseup', 'focus', 'select']) e.addEventListener(ev, () => requestAnimationFrame(paintExtras))
  document.addEventListener('selectionchange', () => { if (document.activeElement === e) requestAnimationFrame(paintExtras) })
  e.addEventListener('scroll', () => requestAnimationFrame(paintExtras))
  ctx.$('#eol')?.addEventListener('click', convertEol)
  ctx.$('#json-format')?.addEventListener('click', ev => formatJSON(ev.shiftKey))
  const jump = ev => {
    const row = ev.target.closest('[data-line]')
    if (!row) return
    ctx.placeCaret(+row.dataset.line + 1)
  }
  ctx.$('#sticky')?.addEventListener('click', jump)
  ctx.$('#crumb-sym')?.addEventListener('click', jump)
  const mm = ctx.$('#minimap')
  let drag = false
  mm?.addEventListener('mousedown', ev => { drag = true; minimapScroll(ev) })
  window.addEventListener('mousemove', ev => { if (drag) minimapScroll(ev) })
  window.addEventListener('mouseup', () => { drag = false })
  applySettings()
}
