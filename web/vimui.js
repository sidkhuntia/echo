// Connects the Vim engine to the editor: key capture, applying edits, the mode indicator, the block
// cursor, search and the ':' command line.
import { ctx } from './ctx.js'
import { newVim, feed } from './vim.js'
import { replaceRange } from './edit.js'

let vs = newVim()
const ed = () => ctx.$('#editor')
const on = () => !!ctx.state.config.vim && ctx.state.mode === 'file' && ed().classList.contains('active') && !!ctx.activeTab()

const LABEL = { normal: 'NORMAL', insert: 'INSERT', visual: 'VISUAL', vline: 'V-LINE' }

function indicator() {
  const el = ctx.$('#vim-mode-badge')
  if (!el) return
  const show = on()
  el.hidden = !show
  if (show) el.textContent = `-- ${LABEL[vs.mode]} --${vs.count || vs.op ? ` ${vs.count}${vs.op || ''}` : ''}`
  ed().style.caretColor = show && vs.mode !== 'insert' ? 'transparent' : ''
  paintCursor()
}

// The block cursor: the character under the caret, drawn on a layer over the text.
function paintCursor() {
  const el = ctx.$('#vimcur'), t = ctx.activeTab()
  if (!el) return
  if (!on() || vs.mode === 'insert' || vs.mode === 'visual' || vs.mode === 'vline') { el.classList.remove('active'); el.innerHTML = ''; return }
  const e = ed(), text = e.value, pos = e.selectionStart
  const ln = text.slice(0, pos).split('\n').length - 1
  const lines = ctx.tabLines(t), [first, last] = ctx.visibleRange(t)
  if (ln < first || ln >= last) { el.classList.remove('active'); el.innerHTML = ''; return }
  const col = pos - (text.lastIndexOf('\n', pos - 1) + 1), l = lines[ln] ?? ''
  const row = ctx.esc(l.slice(0, col)) + `<mark class="vcur">${ctx.esc(l[col] ?? ' ') === '\t' ? '\t' : ctx.esc(l[col] ?? ' ')}</mark>` + ctx.esc(l.slice(col + 1))
  el.classList.add('active')
  el.innerHTML = `<div style="transform:translateX(${-e.scrollLeft}px)"><div class="sl" style="top:${ctx.lineTop(ln) - e.scrollTop}px">${row}</div></div>`
}

function keyName(e) {
  if (e.key === 'Escape') return 'Escape'
  if (e.ctrlKey && e.key === '[') return 'Escape'
  if (e.ctrlKey && e.key.toLowerCase() === 'r') return 'C-r'
  if (e.ctrlKey || e.metaKey) return null
  if (e.key === 'ArrowLeft') return 'h'
  if (e.key === 'ArrowRight') return 'l'
  if (e.key === 'ArrowUp') return 'k'
  if (e.key === 'ArrowDown') return 'j'
  if (e.key === 'Backspace') return 'h'
  if (e.key === 'Enter') return 'j'
  return e.key.length === 1 ? e.key : null
}

function step(key) {
  const e = ed()
  const r = feed(vs, key, e.value, e.selectionStart, e.selectionEnd)
  if (!r) return false
  if (r.edit) replaceRange(e, r.edit.start, r.edit.end, r.edit.text)
  e.setSelectionRange(r.sel[0], r.sel[1])
  for (const fx of r.fx) effect(fx)
  indicator()
  ctx.paintAll()
  return true
}

function effect(fx) {
  if (fx.yank !== undefined) navigator.clipboard?.writeText(fx.yank).catch(() => {})
  else if (fx.undo) document.execCommand('undo')
  else if (fx.redo) document.execCommand('redo')
  else if (fx.search) ctx.showFind(null)
  else if (fx.searchNext) ctx.stepFind(fx.searchNext)
  else if (fx.searchWord) { ctx.showFind(fx.searchWord, { case: true, word: true }, false); ctx.stepFind(1) }
  else if (fx.ex) openCmd()
}

function onKeyDown(e) {
  if (!on() || e.isComposing) return
  if (vs.mode === 'insert') {
    const k = keyName(e)
    if (k === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); step('Escape') }
    return
  }
  // ⌘ shortcuts (save, find, palette) are left to the page.
  if (e.metaKey || (e.ctrlKey && !['r', '[', 'd', 'u'].includes(e.key.toLowerCase()))) return
  if (e.ctrlKey && (e.key === 'd' || e.key === 'u')) { e.preventDefault(); e.stopImmediatePropagation(); ed().scrollTop += (e.key === 'd' ? 1 : -1) * ed().clientHeight / 2; return }
  const k = keyName(e)
  e.preventDefault()
  e.stopImmediatePropagation()
  if (k) step(k)
}

// In normal and visual mode nothing is typed into the text, whatever the input method.
function onBeforeInput(e) {
  if (on() && vs.mode !== 'insert') e.preventDefault()
}

// ---------- the ':' line ----------
function openCmd() {
  const box = ctx.$('#vim-cmd')
  box.hidden = false
  box.value = ''
  box.focus()
}

function closeCmd() {
  const box = ctx.$('#vim-cmd')
  box.hidden = true
  ed().focus({ preventScroll: true })
}

async function runCmd(text) {
  const cmd = text.trim()
  if (/^\d+$/.test(cmd)) { ctx.placeCaret(+cmd); return }
  if (cmd === 'w') return ctx.saveFile()
  if (cmd === 'q' || cmd === 'q!') return ctx.closeTab(ctx.state.active, cmd === 'q!')
  if (cmd === 'wq' || cmd === 'x') { await ctx.saveFile(); return ctx.closeTab(ctx.state.active) }
  if (cmd === 'noh' || cmd === 'nohlsearch') return ctx.closeFind?.(false)
  ctx.setStatus(`Not an editor command: ${cmd}`, 'err')
}

export function initVim() {
  const e = ed()
  e.addEventListener('keydown', onKeyDown)
  e.addEventListener('beforeinput', onBeforeInput)
  e.addEventListener('mousedown', () => { if (vs.mode === 'visual' || vs.mode === 'vline') { vs.mode = 'normal'; indicator() } })
  for (const ev of ['keyup', 'mouseup', 'focus', 'blur']) e.addEventListener(ev, () => requestAnimationFrame(indicator))
  e.addEventListener('scroll', () => requestAnimationFrame(paintCursor))
  ctx.$('#vim-cmd')?.addEventListener('keydown', ev => {
    if (ev.key === 'Enter') { ev.preventDefault(); const v = ev.target.value; closeCmd(); runCmd(v) }
    else if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); closeCmd() }
  })
}

// Called after the editor paints, so the badge and cursor follow tab and mode changes.
export const refreshVim = () => indicator()
