// Small shared pieces for the feature modules: a modal that holds interactive content, and a
// context menu. (dialog.js-style confirmations stay in app.js's ask().)
import { ctx } from './ctx.js'
import { nextInDialog } from './focus.js'

let current = null
// The control that had focus before the modal opened; closing gives focus back to it.
let returnFocus = null
// The control that had focus before the context menu opened.
let menuOpener = null
const FOCUSABLE = 'button, input, select, textarea, a[href], [tabindex]:not([tabindex="-1"])'

// openModal shows a card with a body and action buttons. `body` is an element or trusted HTML.
// It returns { el, close }; clicking outside or pressing Esc closes it. Tab stays inside the card,
// and closing returns focus to the control that opened it.
export function openModal({ title, kicker = '', body = '', wide = false, actions = [] }) {
  closeModal()
  returnFocus = document.activeElement
  const root = ctx.$('#xmodal')
  root.innerHTML = `<div class="modal-card xmodal-card${wide ? ' wide' : ''}" role="dialog" aria-modal="true" aria-label="${ctx.esc(title)}">
    <div class="modal-head"><span>${ctx.esc(title)}${kicker ? ` <span class="dialog-tag">${ctx.esc(kicker)}</span>` : ''}</span><button class="btn quiet icon" data-xclose title="Close (Esc)">×</button></div>
    <div class="xmodal-body"></div>
    <div class="xmodal-actions"></div></div>`
  const bodyEl = root.querySelector('.xmodal-body'), acts = root.querySelector('.xmodal-actions')
  if (typeof body === 'string') bodyEl.innerHTML = body
  else bodyEl.append(body)
  const m = { el: bodyEl, root, close: closeModal, buttons: {} }
  for (const a of actions) {
    const b = document.createElement('button')
    b.className = 'btn' + (a.primary ? ' primary' : '') + (a.danger ? ' danger' : '')
    b.textContent = a.label
    b.onclick = async () => {
      if (b.disabled) return
      b.disabled = true
      let keep = false
      try { keep = (await a.run?.(m)) === false } catch (e) { keep = true; ctx.setStatus?.(String(e?.message || e), 'err') }
      if (b.isConnected) b.disabled = false
      // Only close our own modal: an action may have opened another one.
      if (!keep && current === m) closeModal()
    }
    acts.append(b)
    m.buttons[a.label] = b
  }
  if (!actions.length) acts.hidden = true
  root.hidden = false
  // A stray click on the backdrop must not throw away typed text (Esc and Cancel still close).
  root.onmousedown = e => { if (e.target === root && ![...bodyEl.querySelectorAll('textarea')].some(t => t.value.trim())) closeModal() }
  root.querySelector('[data-xclose]').onclick = closeModal
  current = m
  const first = bodyEl.querySelector('input, textarea, select') || acts.querySelector('.primary') || acts.querySelector('button') || root.querySelector('[data-xclose]')
  first?.focus()
  return m
}

export function closeModal() {
  if (!current) return
  const root = current.root
  current = null
  root.hidden = true
  root.innerHTML = ''
  const back = returnFocus
  returnFocus = null
  if (back?.isConnected) back.focus({ preventScroll: true })
}

document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && current) { e.preventDefault(); e.stopPropagation(); closeModal() }
  else if (e.key === 'Tab' && current) {
    e.preventDefault()
    const items = [...current.root.querySelectorAll(FOCUSABLE)].filter(el => !el.disabled && !el.closest('[hidden]'))
    nextInDialog(items, document.activeElement, e.shiftKey)?.focus()
  }
}, true)

// popMenu shows a context menu at a point. items: { label, run, danger?, kbd?, sep? }.
export function popMenu(items, x, y, head = '') {
  const m = ctx.$('#xmenu')
  if (!m.contains(document.activeElement)) menuOpener = document.activeElement
  m.innerHTML = (head ? `<div class="menu-head"><span>${ctx.esc(head)}</span></div>` : '') + items.map((it, i) => it.sep ? '<div class="menu-sep"></div>' : `<button class="menu-item${it.danger ? ' danger' : ''}" data-i="${i}" role="menuitem"${it.disabled ? ' disabled' : ''}>${ctx.esc(it.label)}${it.kbd ? `<kbd>${ctx.esc(it.kbd)}</kbd>` : ''}</button>`).join('')
  m.hidden = false
  m.style.left = Math.max(8, Math.min(x, innerWidth - m.offsetWidth - 8)) + 'px'
  m.style.top = Math.max(8, Math.min(y, innerHeight - m.offsetHeight - 8)) + 'px'
  m.onclick = e => {
    const b = e.target.closest('.menu-item')
    if (!b || b.disabled) return
    m.hidden = true
    // Hand focus back first, so a modal the action opens remembers the real opener, not <body>.
    if (menuOpener?.isConnected) menuOpener.focus({ preventScroll: true })
    // After this click has finished bubbling: a popover the action opens would otherwise be closed by the same click.
    const run = items[+b.dataset.i].run
    setTimeout(() => run?.(), 0)
  }
  m.querySelector('.menu-item')?.focus()
}

export const closeMenu = () => { ctx.$('#xmenu').hidden = true }
document.addEventListener('mousedown', e => { const m = ctx.$('#xmenu'); if (m && !m.hidden && !e.target.closest('#xmenu')) m.hidden = true })
document.addEventListener('keydown', e => {
  const m = ctx.$('#xmenu')
  if (!m || m.hidden) return
  if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); m.hidden = true; menuOpener?.isConnected && menuOpener.focus({ preventScroll: true }) }
  else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault()
    const items = [...m.querySelectorAll('.menu-item:not(:disabled)')]
    if (!items.length) return
    const i = items.indexOf(document.activeElement), d = e.key === 'ArrowDown' ? 1 : -1
    items[i < 0 ? (d > 0 ? 0 : items.length - 1) : (i + d + items.length) % items.length].focus()
  } else if (e.key === 'Tab') { m.hidden = true; menuOpener?.isConnected && menuOpener.focus({ preventScroll: true }) }
}, true)
window.addEventListener('blur', closeMenu)
