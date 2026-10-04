// Tabs can be dragged into the order you like: the sidebar's, the view switch's, the Git panel's, and
// the open-file tabs. The first three are saved in the config (tabOrder); file tabs are the session's.
import { ctx } from './ctx.js'

const STRIPS = [
  { key: 'rail', sel: '.rail-switch', id: b => b.dataset.rail },
  { key: 'mode', sel: '.mode-switch', id: b => b.dataset.mode },
  { key: 'insp', sel: '.insp-switch', id: b => b.dataset.insp },
]

// The first icon tab takes the free space, so the icons sit at the end whatever the order is.
function markIcons(el) {
  const icons = [...el.children].filter(b => b.classList.contains('ico') && !b.hidden)
  el.querySelectorAll('.ico-first').forEach(b => b.classList.remove('ico-first'))
  icons[0]?.classList.add('ico-first')
}

function apply(strip, order) {
  const el = document.querySelector(strip.sel)
  if (!el) return
  for (const id of order || []) {
    const b = [...el.children].find(x => strip.id(x) === id)
    if (b) el.append(b)
  }
  markIcons(el)
}

export function applyTabOrder() {
  const saved = ctx.state.config.tabOrder || {}
  for (const s of STRIPS) apply(s, saved[s.key])
}

// Which child the pointer is before, among the visible ones, left to right.
const insertionPoint = (el, dragged, x) => [...el.children].find(b => b !== dragged && !b.hidden && x < b.getBoundingClientRect().left + b.getBoundingClientRect().width / 2) || null

function reorderable(strip) {
  const el = document.querySelector(strip.sel)
  let dragged = null
  el.querySelectorAll('button').forEach(b => { b.draggable = true })
  el.addEventListener('dragstart', e => {
    dragged = e.target.closest('button')
    if (!dragged) return
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', strip.id(dragged))
    dragged.classList.add('dragging')
  })
  el.addEventListener('dragover', e => {
    if (!dragged) return
    e.preventDefault()
    const before = insertionPoint(el, dragged, e.clientX)
    if (before !== dragged.nextElementSibling) el.insertBefore(dragged, before)
  })
  el.addEventListener('dragend', () => {
    if (!dragged) return
    dragged.classList.remove('dragging')
    dragged = null
    markIcons(el)
    const order = [...el.children].map(strip.id)
    const tabOrder = { ...(ctx.state.config.tabOrder || {}), [strip.key]: order }
    ctx.state.config.tabOrder = tabOrder
    ctx.post('/api/config', { tabOrder }).catch(e => ctx.setStatus('Could not save the tab order: ' + e.message, 'err'))
  })
}

// Open-file tabs are re-rendered from state.tabs, so dragging moves the entry in the list.
function fileTabs() {
  const el = ctx.$('#tabs')
  let from = -1
  el.addEventListener('dragstart', e => {
    const t = e.target.closest('.tab')
    if (!t) return
    from = +t.dataset.i
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', t.title)
    t.classList.add('dragging')
  })
  el.addEventListener('dragover', e => {
    if (from < 0) return
    e.preventDefault()
    const tabs = [...el.querySelectorAll('.tab')], over = tabs.find(t => e.clientX < t.getBoundingClientRect().left + t.getBoundingClientRect().width / 2)
    const to = over ? +over.dataset.i : tabs.length
    el.querySelectorAll('.drop-before').forEach(t => t.classList.remove('drop-before'))
    over?.classList.add('drop-before')
    el.classList.toggle('drop-end', !over)
    el.dataset.to = to
  })
  el.addEventListener('dragend', () => {
    el.querySelectorAll('.drop-before').forEach(t => t.classList.remove('drop-before'))
    el.classList.remove('drop-end')
    const to = +el.dataset.to
    const f = from
    from = -1
    delete el.dataset.to
    if (f < 0 || Number.isNaN(to)) return ctx.renderTabs()
    const { state } = ctx, active = state.tabs[state.active]
    const [t] = state.tabs.splice(f, 1)
    state.tabs.splice(to > f ? to - 1 : to, 0, t)
    state.active = Math.max(0, state.tabs.indexOf(active))
    ctx.renderTabs()
  })
}

export function initTabDrag() {
  for (const s of STRIPS) reorderable(s)
  fileTabs()
  applyTabOrder()
}
