// Interactive rebase: the plan editor. The server turns the plan into a todo file for `git rebase -i`.
import { ctx } from './ctx.js'
import { openModal } from './ui.js'

const CMDS = [['pick', 'Pick'], ['reword', 'Reword'], ['squash', 'Squash'], ['fixup', 'Fixup'], ['drop', 'Drop']]

export async function rebaseUI(onto) {
  const c = ctx
  let plan
  try { plan = await c.api('/api/rebase/plan?onto=' + encodeURIComponent(onto)) } catch (e) { return c.setStatus(e.message, 'err') }
  if (!plan.length) return c.setStatus('Nothing to rebase: no commits between there and HEAD', 'err')
  const items = plan.map(p => ({ cmd: 'pick', hash: p.hash, short: p.short, subject: p.subject, message: p.subject }))
  const body = document.createElement('div')
  const draw = () => {
    body.innerHTML = `<p class="note">Oldest first. Move commits with the arrows; change what happens to each. The first commit cannot be squashed or fixed up.</p>`
      + items.map((it, i) => `<div class="rb-row${it.cmd === 'drop' ? ' dropped' : ''}" data-i="${i}">
        <select class="field" data-cmd>${CMDS.map(([v, l]) => `<option value="${v}"${v === it.cmd ? ' selected' : ''}>${l}</option>`).join('')}</select>
        <span class="mono">${c.esc(it.short)}</span><span class="msg">${c.esc(it.subject)}</span>
        <span><button class="btn quiet sm" data-mv="-1" title="Move up"${i === 0 ? ' disabled' : ''}>↑</button><button class="btn quiet sm" data-mv="1" title="Move down"${i === items.length - 1 ? ' disabled' : ''}>↓</button></span>
        ${it.cmd === 'reword' ? `<input class="field rb-msg" data-msg value="${c.esc(it.message)}" aria-label="New message">` : ''}</div>`).join('')
  }
  draw()
  body.addEventListener('change', e => {
    const row = e.target.closest('.rb-row'), it = row && items[+row.dataset.i]
    if (e.target.matches('[data-cmd]')) { it.cmd = e.target.value; draw() }
  })
  body.addEventListener('input', e => { if (e.target.matches('[data-msg]')) items[+e.target.closest('.rb-row').dataset.i].message = e.target.value })
  body.addEventListener('click', e => {
    const b = e.target.closest('[data-mv]')
    if (!b) return
    const i = +b.closest('.rb-row').dataset.i, j = i + +b.dataset.mv
    if (j < 0 || j >= items.length) return
    ;[items[i], items[j]] = [items[j], items[i]]
    draw()
  })
  openModal({
    title: 'Interactive rebase', kicker: `onto ${onto.slice(0, 12)}`, wide: true, body,
    actions: [{ label: 'Cancel' }, { label: 'Start rebase', primary: true, run: async () => {
      const first = items.find(x => x.cmd !== 'drop')
      if (first && (first.cmd === 'squash' || first.cmd === 'fixup')) { c.setStatus('The oldest remaining commit cannot be squashed or fixed up', 'err'); return false }
      if (items.some(x => x.cmd === 'reword' && !x.message.trim())) { c.setStatus('A reworded commit needs a message', 'err'); return false }
      await c.gitAction({ action: 'rebase:interactive', from: onto, todo: items.map(x => ({ cmd: x.cmd, hash: x.hash, message: x.cmd === 'reword' ? x.message : '' })) })
    } }],
  })
}
