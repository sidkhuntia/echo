// Small shared pieces for the feature modules: a modal that holds interactive content, and a
// context menu. (dialog.js-style confirmations stay in app.js's ask().)
import { ctx } from './ctx.js'

let current = null

// openModal shows a card with a body and action buttons. `body` is an element or trusted HTML.
// It returns { el, close }; clicking outside or pressing Esc closes it.
export function openModal({ title, kicker = '', body = '', wide = false, actions = [] }) {
  closeModal()
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
    b.onclick = async () => { if ((await a.run?.(m)) !== false) closeModal() }
    acts.append(b)
    m.buttons[a.label] = b
  }
  if (!actions.length) acts.hidden = true
  root.hidden = false
  root.onmousedown = e => { if (e.target === root) closeModal() }
  root.querySelector('[data-xclose]').onclick = closeModal
  current = m
  const first = bodyEl.querySelector('input, textarea, select') || acts.querySelector('.primary')
  first?.focus()
  return m
}

export function closeModal() {
  if (!current) return
  const root = current.root
  current = null
  root.hidden = true
  root.innerHTML = ''
}

export const modalOpen = () => !!current

document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && current) { e.preventDefault(); e.stopPropagation(); closeModal() }
}, true)

// popMenu shows a context menu at a point. items: { label, run, danger?, kbd?, sep? }.
export function popMenu(items, x, y, head = '') {
  const m = ctx.$('#xmenu')
  m.innerHTML = (head ? `<div class="menu-head"><span>${ctx.esc(head)}</span></div>` : '') + items.map((it, i) => it.sep ? '<div class="menu-sep"></div>' : `<button class="menu-item${it.danger ? ' danger' : ''}" data-i="${i}" role="menuitem"${it.disabled ? ' disabled' : ''}>${ctx.esc(it.label)}${it.kbd ? `<kbd>${ctx.esc(it.kbd)}</kbd>` : ''}</button>`).join('')
  m.hidden = false
  m.style.left = Math.max(8, Math.min(x, innerWidth - m.offsetWidth - 8)) + 'px'
  m.style.top = Math.max(8, Math.min(y, innerHeight - m.offsetHeight - 8)) + 'px'
  m.onclick = e => {
    const b = e.target.closest('.menu-item')
    if (!b || b.disabled) return
    m.hidden = true
    // After this click has finished bubbling: a popover the action opens would otherwise be closed by the same click.
    const run = items[+b.dataset.i].run
    setTimeout(() => run?.(), 0)
  }
  m.querySelector('.menu-item')?.focus()
}

export const closeMenu = () => { ctx.$('#xmenu').hidden = true }
document.addEventListener('mousedown', e => { const m = ctx.$('#xmenu'); if (m && !m.hidden && !e.target.closest('#xmenu')) m.hidden = true })
document.addEventListener('keydown', e => { const m = ctx.$('#xmenu'); if (m && !m.hidden && e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); m.hidden = true } }, true)
window.addEventListener('blur', closeMenu)
