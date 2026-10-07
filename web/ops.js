// A merge, rebase, cherry-pick or revert that stopped: the bar with Continue, Skip and Abort, and
// the conflict toolbar over a file that still has markers in it.
import { ctx } from './ctx.js'
import { findConflicts, findIncomplete, resolution, resolveAll, excerpt } from './conflicts.js'
import { replaceRange, applyText } from './edit.js'

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
// Kinds that have no markers to edit: the file was deleted on one side or
// created on both. Cached per path and status so the bar does not fetch on
// every keystroke.
const kindCache = new Map()

function currentConflict(cs) {
  const ed = ctx.$('#editor')
  const at = ed ? ed.selectionStart : 0
  const inside = cs.findIndex(c => at >= c.start && at < c.end)
  if (inside >= 0) return (idx = inside)
  idx = Math.max(0, Math.min(idx, cs.length - 1))
  return idx
}

function liveText(tab) {
  const ed = ctx.$('#editor')
  if (ed && ed.classList.contains('active')) return ed.value
  return tab.content
}

function goConflict(cs, dir) {
  const ed = ctx.$('#editor'), tab = ctx.activeTab()
  if (!cs.length) return
  idx = (currentConflict(cs) + dir + cs.length) % cs.length
  const c = cs[idx]
  ed.focus({ preventScroll: true })
  ed.setSelectionRange(c.start, c.start)
  const top = ctx.lineTopAt ? ctx.lineTopAt(tab, c.startLine) : c.startLine * 20
  ed.scrollTop = Math.max(0, top - ed.clientHeight / 3)
  renderConflictBar()
}

export function renderConflictBar() {
  const bar = ctx.$('#conflict-bar'), tab = ctx.activeTab()
  if (!bar) return
  const live = ctx.state.mode === 'file' && tab && !tab.binary && !tab.tooLarge
  const text = live ? liveText(tab) : ''
  const cs = live ? findConflicts(text) : []
  const flagged = live && ctx.state.changes.get(tab.path)?.conflict
  const badLine = live ? findIncomplete(text) : -1
  if (!live || (!cs.length && !flagged && badLine < 0)) { bar.hidden = true; bar.innerHTML = ''; return }
  if (cs.length) {
    const i = currentConflict(cs), c = cs[i]
    const hasBase = c.base !== null
    const oursX = excerpt(c.ours), theirsX = excerpt(c.theirs)
    const tip = `Current is the side you are on; incoming is the other.${oursX ? `\nCurrent: ${oursX}` : ''}${theirsX ? `\nIncoming: ${theirsX}` : ''}`
    bar.innerHTML = `<span><b>${cs.length}</b> conflict${cs.length === 1 ? '' : 's'} · <b>${i + 1}</b> of ${cs.length}</span>`
      + `<span class="faint" title="${ctx.esc(tip)}">${ctx.esc(c.oursLabel || 'current')} ⇄ ${ctx.esc(c.theirsLabel || 'incoming')}</span>`
      + (badLine >= 0 ? `<span class="cf-warn" title="A start marker at line ${badLine + 1} has no end marker. Finish the edit or undo it.">· unterminated at ${badLine + 1}</span>` : '')
      + `<span class="grow"></span>`
      + `<button class="btn sm quiet" data-cf="prev" title="Previous conflict (Shift-F7)">↑</button><button class="btn sm quiet" data-cf="next" title="Next conflict (F7)">↓</button>`
      + `<button class="btn sm" data-cf="ours" title="Keep only the current side (⌘⌥1)">Accept current</button>`
      + `<button class="btn sm" data-cf="theirs" title="Keep only the incoming side (⌘⌥2)">Accept incoming</button>`
      + `<button class="btn sm" data-cf="both" title="Keep current, then incoming (⌘⌥3)">Accept both</button>`
      + `<button class="btn sm quiet" data-cf="more" title="Every conflict at once, the reverse order, or the base">More…</button>`
    bar.hidden = false
    bar.dataset.hasBase = hasBase ? '1' : ''
    return
  }
  if (badLine >= 0) {
    bar.innerHTML = `<span class="grow">Unterminated conflict marker at line <b>${badLine + 1}</b> — a <span class="mono">&lt;&lt;&lt;&lt;&lt;&lt;&lt;</span> with no end. Finish the edit or undo it.</span>`
    bar.hidden = false
    return
  }
  // Flagged by git but no markers in the text: a delete/add conflict, or the
  // markers were already resolved. The kind decides which buttons make sense.
  const seq = ctx.state.statusSeq, cached = kindCache.get(tab.path)
  if (!cached || cached.seq !== seq) {
    kindCache.set(tab.path, { seq, kind: cached?.kind || '' })
    ctx.api(`/api/conflict?path=${encodeURIComponent(tab.path)}`).then(info => {
      kindCache.set(tab.path, { seq: ctx.state.statusSeq, kind: info.kind || 'unknown', code: info.code })
      if (ctx.activeTab() === tab) renderConflictBar()
    }).catch(() => {})
  }
  const kind = cached?.kind || ''
  bar.hidden = false
  if (kind === 'deleted-by-them') {
    bar.innerHTML = `<span class="grow"><b>${ctx.esc(ctx.basename(tab.path))}</b> deleted on incoming, edited here. Keeping stages your version; deleting removes it.</span>`
      + `<button class="btn sm" data-cf="keep">Keep file</button><button class="btn sm quiet" data-cf="drop">Delete file</button>`
  } else if (kind === 'deleted-by-us') {
    bar.innerHTML = `<span class="grow"><b>${ctx.esc(ctx.basename(tab.path))}</b> deleted here, edited on incoming. Keeping stages their version; deleting keeps it deleted.</span>`
      + `<button class="btn sm" data-cf="keep">Keep file</button><button class="btn sm quiet" data-cf="drop">Delete file</button>`
  } else if (kind === 'both-added') {
    bar.innerHTML = `<span class="grow"><b>${ctx.esc(ctx.basename(tab.path))}</b> created differently on both sides with no base version.</span>`
      + `<button class="btn sm" data-cf="ours-file" title="Keep your whole file">Keep mine</button><button class="btn sm" data-cf="theirs-file" title="Take their whole file">Take theirs</button>`
  } else {
    bar.innerHTML = `<span class="grow"><b>${ctx.esc(ctx.basename(tab.path))}</b> was in conflict and no markers are left.</span><button class="btn sm primary" data-cf="stage">Mark resolved (stage)</button>`
  }
}

async function stageResolved(tab) {
  if (tab.content !== tab.saved) await ctx.saveFile()
  const after = ctx.activeTab()
  const text = ctx.$('#editor').classList.contains('active') ? ctx.$('#editor').value : after.content
  if (findConflicts(text).length || findIncomplete(text) >= 0) {
    const ok = await ctx.ask({ title: 'Stage with markers left', kicker: 'marks stay', tone: 'warn', ok: 'Stage anyway',
      html: `<p><b>${ctx.esc(after.path)}</b> still holds conflict markers. Staging marks it resolved, and the markers will be committed as text.</p>` })
    if (!ok) return
  }
  return ctx.gitAction({ action: 'add', paths: [after.path] })
}

function applyChoice(choice) {
  const ed = ctx.$('#editor')
  const cs = findConflicts(ed.value)
  if (!cs.length) return
  if (choice.startsWith('all-')) {
    const text = resolveAll(ed.value, choice.slice(4))
    applyText(ed, text)
  } else {
    const c = cs[currentConflict(cs)]
    const { replaceRange: rr } = { replaceRange }
    rr(ed, c.start, c.end, resolution(c, choice))
  }
  renderConflictBar()
  ctx.paintAll?.()
}

async function cfClick(e) {
  const b = e.target.closest('[data-cf]')
  if (!b) return
  const act = b.dataset.cf, ed = ctx.$('#editor'), tab = ctx.activeTab()
  if (!tab) return
  if (act === 'stage') return stageResolved(tab)
  if (act === 'keep') {
    if (tab.content !== tab.saved) await ctx.saveFile()
    return ctx.gitAction({ action: 'add', paths: [tab.path] })
  }
  if (act === 'drop') {
    const ok = await ctx.ask({ title: `Delete ${tab.path.split('/').pop()}`, kicker: 'resolves', tone: 'danger', ok: 'Delete file',
      html: `<p><b>${ctx.esc(tab.path)}</b> will be removed to resolve the conflict. A snapshot is kept first.</p>` })
    if (ok) return ctx.gitAction({ action: 'resolve:' + (kindCache.get(tab.path)?.kind === 'deleted-by-us' ? 'ours' : 'theirs'), paths: [tab.path] })
    return
  }
  if (act === 'ours-file' || act === 'theirs-file') {
    const side = act === 'ours-file' ? 'ours' : 'theirs'
    const ok = await ctx.ask({ title: `Take ${side === 'ours' ? 'your' : 'their'} whole file`, kicker: 'throws away', tone: 'warn', ok: `Take ${side}`,
      html: `<p>The other side of <b>${ctx.esc(tab.path)}</b> is thrown away for the whole file. A snapshot is kept first, so Restore brings it back.</p>` })
    if (ok) return ctx.gitAction({ action: 'resolve:' + side, paths: [tab.path] })
    return
  }
  const cs = findConflicts(ed.value)
  if (!cs.length) return
  if (act === 'prev') return goConflict(cs, -1)
  if (act === 'next') return goConflict(cs, 1)
  if (act === 'more') {
    const c = cs[currentConflict(cs)], hasBase = c.base !== null
    const { popMenu } = await import('./ui.js')
    popMenu([
      { label: 'All current (whole file)', run: () => applyChoice('all-ours') },
      { label: 'All incoming (whole file)', run: () => applyChoice('all-theirs') },
      { label: 'All both, current first', run: () => applyChoice('all-both') },
      { label: 'All both, incoming first', run: () => applyChoice('all-both-rev') },
      ...(hasBase ? [{ label: 'This one: take base', run: () => applyChoice('base') }] : []),
      { label: 'This one: incoming first, then current', run: () => applyChoice('both-rev') },
    ], e.clientX, e.clientY, 'Resolve all')
    return
  }
  if (['ours', 'theirs', 'both', 'both-rev', 'base'].includes(act)) return applyChoice(act)
}

export function conflictKeys(e) {
  const tab = ctx.activeTab()
  if (!tab || ctx.state.mode !== 'file' || tab.binary || tab.tooLarge) return false
  const bar = ctx.$('#conflict-bar')
  if (!bar || bar.hidden) return false
  const mod = e.metaKey || e.ctrlKey
  if (e.key === 'F7') { e.preventDefault(); e.stopPropagation(); goConflict(findConflicts(ctx.$('#editor').value), e.shiftKey ? -1 : 1); return true }
  if (mod && e.altKey && ['1', '2', '3'].includes(e.key)) {
    e.preventDefault(); e.stopPropagation()
    applyChoice(e.key === '1' ? 'ours' : e.key === '2' ? 'theirs' : 'both')
    return true
  }
  return false
}

export function initOps() {
  ctx.$('#op-bar')?.addEventListener('click', opClick)
  ctx.$('#conflict-bar')?.addEventListener('click', cfClick)
  document.addEventListener('keydown', e => { if (!e.metaKey && !e.ctrlKey && e.key === 'F7') conflictKeys(e); else if ((e.metaKey || e.ctrlKey) && e.altKey) conflictKeys(e) }, true)
}
