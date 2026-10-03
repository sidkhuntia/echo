// The Git panel's Tools tab: remotes, worktrees, submodules and the reflog.
import { ctx } from './ctx.js'
import * as G from './gitui.js'
import { compareUI } from './compare.js'

const data = { remotes: [], worktrees: [], submodules: [], reflog: [], loaded: false }
let openSec = new Set(['remotes'])

const shown = () => ctx.$('#insp')?.dataset.insp === 'tools'

export async function refreshTools() {
  if (!shown()) return
  const get = async (k, url) => { try { data[k] = await ctx.api(url) } catch { data[k] = [] } }
  await Promise.all([get('remotes', '/api/remotes'), get('worktrees', '/api/worktrees'), get('submodules', '/api/submodules'), get('reflog', '/api/reflog?limit=100')])
  data.loaded = true
  render()
}

function render() {
  const box = ctx.$('#tools'), e = ctx.esc
  if (!box) return
  if (ctx.state.status && !ctx.state.status.git) { box.innerHTML = '<div class="empty"><b>Not a Git repository</b></div>'; return }
  const sec = (id, title, count, inner) => `<details class="tool-sec" data-sec="${id}"${openSec.has(id) ? ' open' : ''}><summary><span>${title}</span><span class="count">${count}</span></summary>${inner}</details>`
  const branches = (ctx.state.status?.local || []).map(b => `<option value="${e(b.name)}">${e(b.name)}</option>`).join('')
  const remotes = data.remotes.map(r => `<div class="tool-row" data-remote="${e(r.name)}"><span class="nm" title="${e(r.fetch)}"><b>${e(r.name)}</b> <span class="sub">${e(r.fetch)}</span></span>
      <button class="btn quiet sm" data-t="fetch">Fetch</button><button class="btn quiet sm" data-t="rename">Rename</button><button class="btn quiet sm" data-t="seturl">URL</button><button class="btn quiet sm" data-t="remove" title="Remove this remote">✕</button></div>`).join('')
    + `<div class="tool-form"><input class="field" data-f="rname" placeholder="name" spellcheck="false"><input class="field" data-f="rurl" placeholder="URL" spellcheck="false"><button class="btn sm" data-t="radd">Add remote</button></div>`
  const worktrees = data.worktrees.map(w => `<div class="tool-row" data-wt="${e(w.path)}"><span class="nm" title="${e(w.path)}"><b>${e(w.branch || (w.detached ? 'detached' : ''))}</b> <span class="sub">${e(w.path)}</span></span>
      <button class="btn quiet sm" data-t="wcopy" title="Copy the command that opens it in echo">Copy open</button>${w.main ? '' : '<button class="btn quiet sm" data-t="wremove">Remove</button>'}</div>`).join('')
    + `<div class="tool-form"><input class="field" data-f="wpath" placeholder="folder, e.g. ../feature-x" spellcheck="false"><input class="field" data-f="wname" placeholder="new branch (optional)" spellcheck="false"><select class="field" data-f="wfrom"><option value="">from HEAD</option>${branches}</select><button class="btn sm" data-t="wadd">Add worktree</button></div>`
  const subs = data.submodules.length
    ? data.submodules.map(s => `<div class="tool-row"><span class="nm" title="${e(s.path)}"><b>${e(s.path)}</b> <span class="sub">${e(s.hash.slice(0, 7))} ${e(s.detail || '')}</span></span><span class="sub">${e(s.state)}</span></div>`).join('') + '<div class="tool-form"><button class="btn sm" data-t="sub-update" title="git submodule update --init --recursive">Update all (init, recursive)</button></div>'
    : '<div class="faint tool-row">No submodules</div>'
  const reflog = data.reflog.map(r => `<div class="tool-row" data-hash="${e(r.hash)}"><span class="sub">${e(r.short)}</span><span class="nm" title="${e(r.subject)}">${e(r.subject)}</span><span class="sub">${e(ctx.ago(r.time))}</span>
      <button class="btn quiet sm" data-t="rbranch" title="Start a branch at this state">Branch</button><button class="btn quiet sm" data-t="rreset" title="Reset the current branch to this state">Reset…</button></div>`).join('') || '<div class="faint tool-row">Empty</div>'
  box.innerHTML = `<div class="tool-form"><button class="btn sm" data-t="compare">Compare branches…</button></div>`
    + sec('remotes', 'Remotes', data.remotes.length, remotes)
    + sec('worktrees', 'Worktrees', data.worktrees.length, worktrees)
    + sec('submodules', 'Submodules', data.submodules.length, subs)
    + sec('reflog', 'Reflog', data.reflog.length, `<p class="faint note">Every place HEAD has been, including commits no branch points at. Recover lost work from here.</p>${reflog}`)
}

async function click(e) {
  const b = e.target.closest('[data-t]'), c = ctx
  const det = e.target.closest('details.tool-sec')
  if (det && !b) { setTimeout(() => (det.open ? openSec.add(det.dataset.sec) : openSec.delete(det.dataset.sec)), 0); return }
  if (!b) return
  const t = b.dataset.t, row = b.closest('[data-remote], [data-wt], [data-hash]')
  const field = k => c.$('#tools').querySelector(`[data-f="${k}"]`)?.value.trim() || ''
  if (t === 'compare') return compareUI()
  if (t === 'fetch') return c.gitAction({ action: 'fetch', remote: row.dataset.remote })
  if (t === 'rename') { const to = await c.ask({ title: `Rename ${row.dataset.remote}`, ok: 'Rename', input: { label: 'New name', value: row.dataset.remote } }); if (to) await c.gitAction({ action: 'remote:rename', from: row.dataset.remote, to }); return }
  if (t === 'seturl') { const cur = data.remotes.find(r => r.name === row.dataset.remote)?.fetch || ''; const url = await c.ask({ title: `URL of ${row.dataset.remote}`, ok: 'Save', input: { label: 'URL', value: cur } }); if (url) await c.gitAction({ action: 'remote:seturl', from: row.dataset.remote, url }); return }
  if (t === 'remove') { const ok = await c.ask({ title: `Remove ${row.dataset.remote}`, tone: 'danger', ok: 'Remove', html: '<p>Its remote-tracking branches go with it. Nothing on the server changes.</p>' }); if (ok) await c.gitAction({ action: 'remote:remove', from: row.dataset.remote }); return }
  if (t === 'radd') return c.gitAction({ action: 'remote:add', from: field('rname'), url: field('rurl') })
  if (t === 'wadd') return c.gitAction({ action: 'worktree:add', from: field('wpath'), name: field('wname'), to: field('wfrom') })
  if (t === 'wremove') { const ok = await c.ask({ title: 'Remove this worktree', tone: 'danger', ok: 'Remove', html: `<p>${c.esc(row.dataset.wt)} is deleted. Git refuses if it has uncommitted changes.</p>` }); if (ok) await c.gitAction({ action: 'worktree:remove', from: row.dataset.wt }); return }
  if (t === 'wcopy') return c.copyText(`echo-desk '${row.dataset.wt.replace(/'/g, `'\\''`)}'`).then(() => c.setStatus('Copied the open command', 'ok'))
  if (t === 'sub-update') return c.gitAction({ action: 'submodule:update' })
  if (t === 'rbranch') return G.newBranchAt(row.dataset.hash)
  if (t === 'rreset') return G.resetChoice(row.dataset.hash, hash => c.gitAction({ action: 'reset:soft', from: hash }))
}

export function initTools() {
  ctx.$('#tools')?.addEventListener('click', click)
}

export const toolsShown = () => { if (shown()) refreshTools() }
