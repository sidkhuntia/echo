// A merge, rebase, cherry-pick or revert that stopped: the bar with Continue, Skip and Abort, and
// the conflict toolbar over a file that still has markers in it.
import { ctx } from './ctx.js'
import { findConflicts, resolution, resolveAll } from './conflicts.js'
import { replaceRange } from './edit.js'

const NAMES = { merge: 'Merge', rebase: 'Rebase', 'cherry-pick': 'Cherry-pick', revert: 'Revert' }
const cap = s => s[0].toUpperCase() + s.slice(1)

export function renderOpBar() {
  const bar = ctx.$('#op-bar'), op = ctx.state.status?.operation
  if (!bar) return
  if (!op) { bar.hidden = true; bar.innerHTML = ''; return }
  const conflicts = [...ctx.state.changes.values()].filter(c => c.conflict).length
  const verbs = op === 'merge' || op === 'revert' ? ['continue', 'abort'] : ['continue', 'skip', 'abort']
  const tip = { continue: conflicts ? 'Resolve and stage the conflicted files first' : 'Carry on', skip: 'Drop this commit and carry on', abort: 'Go back to how things were before it started' }
  bar.innerHTML = `<b>${NAMES[op] || op} in progress</b><span>${conflicts ? `${conflicts} conflicted file${conflicts === 1 ? '' : 's'}` : 'no conflicts left'}</span><span class="grow"></span>`
    + verbs.map(v => `<button class="btn sm${v === 'continue' ? ' primary' : ''}" data-op="${v}" title="${ctx.esc(tip[v])}"${v === 'continue' && conflicts ? ' disabled' : ''}>${cap(v)}</button>`).join('')
  bar.hidden = false
}

async function opClick(e) {
  const b = e.target.closest('[data-op]')
  const op = ctx.state.status?.operation
  if (!b || !op) return
  const verb = b.dataset.op
  if (verb === 'abort') {
    const ok = await ctx.ask({ title: `Abort the ${op}`, kicker: 'goes back', tone: 'warn', ok: 'Abort', html: `<p>The ${op} stops and the repository returns to how it was before it started. Resolutions you made so far are dropped.</p>` })
    if (!ok) return
  }
  await ctx.gitAction({ action: `${op}:${verb}` })
}

// ---------- the conflict toolbar ----------
let idx = 0

function currentConflict(cs) {
  const ed = ctx.$('#editor'), at = ed.selectionStart
  const inside = cs.findIndex(c => at >= c.start && at < c.end)
  if (inside >= 0) return (idx = inside)
  idx = Math.min(idx, cs.length - 1)
  return idx
}

export function renderConflictBar() {
  const bar = ctx.$('#conflict-bar'), tab = ctx.activeTab()
  if (!bar) return
  const live = ctx.state.mode === 'file' && tab && !tab.binary && !tab.tooLarge
  const cs = live ? findConflicts(ctx.$('#editor').classList.contains('active') ? ctx.$('#editor').value : tab.content) : []
  const flagged = live && ctx.state.changes.get(tab.path)?.conflict
  if (!live || (!cs.length && !flagged)) { bar.hidden = true; return }
  if (!cs.length) {
    bar.innerHTML = `<span class="grow"><b>${ctx.esc(ctx.basename(tab.path))}</b> was in conflict and no markers are left.</span><button class="btn sm primary" data-cf="stage">Mark resolved (stage)</button>`
    bar.hidden = false
    return
  }
  const i = currentConflict(cs), c = cs[i]
  bar.innerHTML = `<span><b>${cs.length}</b> conflict${cs.length === 1 ? '' : 's'} · <b>${i + 1}</b> of ${cs.length}</span>
    <span class="faint" title="Current is the side you are on; incoming is the other">${ctx.esc(c.oursLabel || 'current')} ⇄ ${ctx.esc(c.theirsLabel || 'incoming')}</span><span class="grow"></span>
    <button class="btn sm quiet" data-cf="prev" title="Previous conflict">↑</button><button class="btn sm quiet" data-cf="next" title="Next conflict">↓</button>
    <button class="btn sm" data-cf="ours">Accept current</button><button class="btn sm" data-cf="theirs">Accept incoming</button><button class="btn sm" data-cf="both">Accept both</button>
    <button class="btn sm quiet" data-cf="all-ours" title="Resolve every conflict in this file with the current side">All current</button><button class="btn sm quiet" data-cf="all-theirs" title="Resolve every conflict in this file with the incoming side">All incoming</button>`
  bar.hidden = false
}

async function cfClick(e) {
  const b = e.target.closest('[data-cf]')
  if (!b) return
  const act = b.dataset.cf, ed = ctx.$('#editor'), tab = ctx.activeTab()
  if (act === 'stage') {
    if (tab.content !== tab.saved) await ctx.saveFile()
    return ctx.gitAction({ action: 'add', paths: [tab.path] })
  }
  const cs = findConflicts(ed.value)
  if (!cs.length) return
  if (act === 'prev' || act === 'next') {
    idx = (currentConflict(cs) + (act === 'next' ? 1 : -1) + cs.length) % cs.length
    const c = cs[idx]
    ed.focus({ preventScroll: true })
    ed.setSelectionRange(c.start, c.start)
    ed.scrollTop = Math.max(0, c.startLine * 20 - ed.clientHeight / 3)
    return renderConflictBar()
  }
  if (act.startsWith('all-')) {
    const text = resolveAll(ed.value, act.slice(4))
    replaceRange(ed, 0, ed.value.length, text, 0)
  } else {
    const c = cs[currentConflict(cs)]
    replaceRange(ed, c.start, c.end, resolution(c, act))
  }
  renderConflictBar()
}

export function initOps() {
  ctx.$('#op-bar')?.addEventListener('click', opClick)
  ctx.$('#conflict-bar')?.addEventListener('click', cfClick)
}
