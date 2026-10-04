// Git actions that need more than a button: commit options and output, merge and reset choices,
// branch and commit menus, stash helpers, and the pull and push menus.
import { ctx } from './ctx.js'
import { openModal, popMenu } from './ui.js'

const c = () => ctx
const store = {
  get: k => { try { return localStorage.getItem('echo:' + k) } catch { return null } },
  set: (k, v) => { try { localStorage.setItem('echo:' + k, v) } catch {} },
}

// ---------- commit box: options, meter, template, output ----------
export function commitOpts() {
  const co = c().$('#opt-coauthor').value.split(/[,\n]/).map(s => s.trim()).filter(Boolean)
  return { signoff: c().$('#opt-signoff').checked, coAuthors: co }
}

function meter() {
  const m = c().$('#msg-meter'), text = c().$('#commit-message').value
  const lines = text.split('\n'), subject = lines[0].length
  const longBody = lines.slice(1).some(l => l.length > 72)
  m.textContent = text ? `${subject}/50${longBody ? ' · wrap body' : ''}` : ''
  m.classList.toggle('warn', subject > 50 && subject <= 72)
  m.classList.toggle('bad', subject > 72 || longBody)
}

let template = ''
export async function loadTemplate() {
  try { template = (await c().api('/api/git/template')).template || '' } catch { template = '' }
  fillTemplate()
}
export function fillTemplate() {
  const box = c().$('#commit-message')
  if (template && !box.value.trim()) { box.value = template; meter() }
}

// showOutput keeps what the last Git command printed: a hook's complaint or a push's progress is
// not something a one-line status can hold.
export function showOutput(action, text, ok) {
  let wrap = c().$('#git-out-wrap')
  if (!wrap) {
    wrap = document.createElement('details')
    wrap.id = 'git-out-wrap'
    wrap.className = 'git-out'
    c().$('#commit-hint').after(wrap)
  }
  text = String(text || '').trim()
  if (!text || (ok && !text.includes('\n') && action !== 'commit')) { wrap.hidden = true; return }
  wrap.hidden = false
  wrap.classList.toggle('err', !ok)
  wrap.open = !ok
  wrap.innerHTML = `<summary>git ${c().esc(action)}${ok ? ' output' : ' failed'}</summary><pre>${c().esc(text)}</pre>`
}

// ---------- merge and rebase ----------
// One dialog for both: pick the branch to bring in, choose Merge or Rebase, read what will happen
// (from /api/git/relation), then confirm. The target is always the branch that is checked out.
export function integrate(from, method = 'merge') {
  const { state, esc, api, setStatus, plural } = c(), st = state.status || {}, cur = st.branch
  if (!cur) return setStatus('Check out a branch first: Merge and Rebase work on the current branch', 'err')
  const names = (st.branches || []).filter(b => b !== cur)
  if (!names.length) return setStatus('There is no other branch to bring changes from', 'err')
  if (!from || from === cur) from = names.find(b => /^(origin\/)?(main|master|develop)$/.test(b)) || names[0]
  let rel = null, seq = 0
  const m = openModal({
    title: 'Bring changes into ' + cur, kicker: 'merge or rebase',
    body: `<div class="im">
      <label class="im-row">From <select class="field" data-im="from">${names.map(b => `<option ${b === from ? 'selected' : ''}>${esc(b)}</option>`).join('')}</select><span class="faint">into <b>${esc(cur)}</b>, the branch you are on</span></label>
      <div class="seg" data-im="method" role="tablist"><button data-m="merge" role="tab">Merge</button><button data-m="rebase" role="tab">Rebase</button></div>
      <div class="im-info" data-im="info" aria-live="polite">Checking…</div>
      <div class="set-sec" data-im="opts"></div></div>`,
    actions: [{ label: 'Cancel' }, { label: 'Merge', primary: true, run: async mod => {
      if (!rel || !rel.incoming) return false
      const v = mod.el.querySelector('input[name=mm]:checked')?.value
      await c().gitAction(method === 'rebase' ? { action: 'rebase', from } : { action: 'merge', from, noff: v === 'noff', squash: v === 'squash' })
    } }],
  })
  const q = s => m.el.querySelector(`[data-im="${s}"]`), go = m.root.querySelector('.xmodal-actions .primary')
  const draw = () => {
    m.el.querySelectorAll('[data-m]').forEach(b => b.classList.toggle('on', b.dataset.m === method))
    go.textContent = method === 'rebase' ? `Rebase ${cur} onto ${from}` : `Merge ${from} into ${cur}`
    const info = q('info'), opts = q('opts')
    if (!rel) { info.textContent = 'Checking…'; opts.innerHTML = ''; go.disabled = true; return }
    if (rel.error) { info.innerHTML = `<span class="im-bad">${esc(rel.error)}</span>`; opts.innerHTML = ''; go.disabled = true; return }
    const n = rel.incoming, f = `<b>${esc(from)}</b>`, t = `<b>${esc(cur)}</b>`
    go.disabled = !n
    let say
    if (!n) say = `Already up to date: ${f} has nothing that ${t} lacks.`
    else if (method === 'rebase') say = rel.ours
      ? `${plural(rel.ours, 'commit')} of ${t} will be replayed on top of ${f}, after its ${plural(n, 'new commit')}. This rewrites ${t}'s history, so avoid it once ${t} is pushed and shared.`
      : `${t} has nothing of its own, so it simply moves forward to ${f} (${plural(n, 'commit')}).`
    else say = rel.ff
      ? `${t} can fast-forward: it moves ahead ${plural(n, 'commit')} to ${f}, with no merge commit.`
      : `${plural(n, 'commit')} from ${f} come into ${t}, and a merge commit joins the two histories (${t} also has ${plural(rel.ours, 'commit')} of its own).`
    const list = n ? `<ul class="im-commits">${rel.commits.map(x => `<li><span class="mono">${esc(x.slice(0, 7))}</span> ${esc(x.slice(8))}</li>`).join('')}${n > rel.commits.length ? `<li class="faint">and ${n - rel.commits.length} more</li>` : ''}</ul>` : ''
    const dirty = rel.dirty ? `<p class="im-warn">${plural(rel.dirty, 'file')} with uncommitted changes. Commit or stash first; Git may refuse otherwise.</p>` : ''
    info.innerHTML = `<p>${say}</p>${list}${dirty}`
    opts.hidden = method !== 'merge' || !n
    opts.innerHTML = method === 'merge' && n ? `<label class="check"><input type="radio" name="mm" value="" checked> <b>${rel.ff ? 'Fast-forward' : 'Merge commit'}</b> <span class="faint">Git's default</span></label>
      ${rel.ff ? '<label class="check"><input type="radio" name="mm" value="noff"> <b>Always a merge commit</b> <span class="faint">--no-ff, keeps the branch visible in the log</span></label>' : ''}
      <label class="check"><input type="radio" name="mm" value="squash"> <b>Squash</b> <span class="faint">stage everything as one change; you commit it</span></label>` : ''
  }
  const load = async () => {
    const my = ++seq
    rel = null; draw()
    let r
    try { r = await api('/api/git/relation?from=' + encodeURIComponent(from)) } catch (e) { r = { error: e.message } }
    if (my !== seq) return
    rel = r; draw()
  }
  q('from').onchange = e => { from = e.target.value; load() }
  m.el.querySelectorAll('[data-m]').forEach(b => b.onclick = () => { method = b.dataset.m; draw() })
  load()
  return m
}

// ---------- branches ----------
export async function deleteBranch(name) {
  try {
    await c().post('/api/git', { action: 'branch:delete', from: name })
    c().setStatus(`Deleted ${name}`, 'ok')
    return c().refreshAll()
  } catch (e) {
    if (!/not fully merged/i.test(e.message)) return c().setStatus(e.message, 'err')
  }
  let list = []
  try { list = await c().api('/api/branch/unmerged?name=' + encodeURIComponent(name)) } catch {}
  openModal({
    title: `Force delete ${name}?`, kicker: 'loses commits',
    body: `<p class="say">${list.length ? `These ${list.length === 1 ? 'commit is' : 'commits are'} only on <b>${c().esc(name)}</b> and would become hard to find (the reflog keeps them for a while).` : `Git says ${c().esc(name)} is not fully merged.`}</p>
      <ul class="undone">${list.slice(0, 20).map(x => `<li class="mono">${c().esc(x.short)} ${c().esc(x.subject)}</li>`).join('')}${list.length > 20 ? `<li class="faint">and ${list.length - 20} more</li>` : ''}</ul>`,
    actions: [{ label: 'Cancel' }, { label: 'Force delete', danger: true, primary: true, run: () => c().gitAction({ action: 'branch:delete:force', from: name }) }],
  })
}

export async function renameBranch(name) {
  const to = await c().ask({ title: `Rename ${name}`, ok: 'Rename', input: { label: 'New name', value: name } })
  if (to && to !== name) await c().gitAction({ action: 'branch:rename', from: name, to })
}

export async function deleteRemoteBranch(ref) {
  const i = ref.indexOf('/'), remote = ref.slice(0, i), name = ref.slice(i + 1)
  const ok = await c().ask({ title: `Delete ${name} on ${remote}`, kicker: 'remote', tone: 'danger', ok: 'Delete on remote', html: `<p>This runs <code>git push ${c().esc(remote)} --delete ${c().esc(name)}</code>. Anyone with that branch checked out loses their upstream.</p>` })
  if (ok) await c().gitAction({ action: 'branch:delete:remote', remote, from: name })
}

// ---------- commits ----------
export async function newBranchAt(hash) {
  const name = await c().ask({ title: 'New branch from this commit', ok: 'Create & switch', html: `<p class="note">Starts at <b>${c().esc(hash.slice(0, 7))}</b>.</p>`, input: { label: 'Branch name', placeholder: 'feature/name' } })
  if (name) await c().gitAction({ action: 'branch:create', from: name, to: hash })
}

export async function cherryPick(hash) {
  const ok = await c().ask({ title: `Cherry-pick ${hash.slice(0, 7)}`, kicker: 'new commit', ok: 'Cherry-pick', html: `<p>Applies this commit's changes on top of <b>${c().esc(c().state.status?.branch || 'HEAD')}</b> as a new commit. If it conflicts, you resolve and continue.</p>` })
  if (ok) await c().gitAction({ action: 'cherry-pick', from: hash })
}

// resetChoice offers the three kinds of reset in plain words; soft keeps its own preview dialog.
export function resetChoice(hash, soft) {
  openModal({
    title: `Reset ${c().state.status?.branch || 'the branch'} to ${hash.slice(0, 7)}`, kicker: 'moves the branch',
    body: `<div class="set-sec"><label class="check"><input type="radio" name="rm" value="soft" checked> <b>Soft</b> <span class="faint">undone commits' changes stay staged</span></label>
      <label class="check"><input type="radio" name="rm" value="mixed"> <b>Mixed</b> <span class="faint">changes stay in the working tree, unstaged</span></label>
      <label class="check"><input type="radio" name="rm" value="hard"> <b>Hard</b> <span class="faint">throws away uncommitted work too — a snapshot is kept, and Restore in the Changes list brings it back</span></label></div>`,
    actions: [{ label: 'Cancel' }, { label: 'Reset', primary: true, run: async mod => {
      const v = mod.el.querySelector('input[name=rm]:checked').value
      if (v === 'soft') { await soft(hash); return }
      await c().gitAction({ action: 'reset:' + v, from: hash })
    } }],
  })
}

let remoteCache = { key: '', list: [] }
export async function remotes() {
  const key = c().state.status?.refsSig || ''
  if (remoteCache.key !== key || !remoteCache.list.length) {
    try { remoteCache = { key, list: await c().api('/api/remotes') } } catch { remoteCache = { key, list: [] } }
  }
  return remoteCache.list
}

export async function commitLink(hash) {
  const web = (await remotes()).find(r => r.web)?.web
  return web ? `${web}/commit/${hash}` : ''
}

// commitMenu is the right-click menu of a commit in the Log or History.
export async function commitMenu(hash, subject, x, y, handlers) {
  const link = await commitLink(hash)
  const copy = (text, what) => () => c().copyText(text).then(() => c().setStatus(`Copied ${what}`, 'ok'), e => c().setStatus(e.message, 'err'))
  popMenu([
    { label: 'Show diff', run: () => handlers.diff() },
    { label: 'Copy hash', run: copy(hash, 'the commit id') },
    { label: 'Copy subject', run: copy(subject, 'the subject') },
    ...(link ? [{ label: 'Copy link', run: copy(link, 'the commit link') }, { label: 'Open on the web', run: () => window.open(link, '_blank', 'noopener') }] : []),
    { sep: true },
    { label: 'New branch here…', run: () => newBranchAt(hash) },
    { label: 'Checkout (detached)', run: () => c().gitAction({ action: 'branch:detach', from: hash }) },
    { label: 'Cherry-pick…', run: () => cherryPick(hash) },
    { label: 'Revert…', run: () => handlers.revert() },
    { label: 'Reset branch here…', run: () => resetChoice(hash, handlers.soft) },
    { label: 'Rebase interactively from here…', run: () => handlers.irebase() },
    { sep: true },
    { label: 'Compare with HEAD…', run: () => handlers.compare() },
  ], x, y, hash.slice(0, 7))
}

// ---------- stash ----------
export async function stashShow(ref) {
  let text = ''
  try { text = (await c().api('/api/stash?ref=' + encodeURIComponent(ref))).text } catch (e) { return c().setStatus(e.message, 'err') }
  openModal({ title: `Stash ${ref}`, wide: true, body: diffTextHTML(text), actions: [{ label: 'Close' }] })
}

export function diffTextHTML(text) {
  const e = c().esc
  const rows = text.split('\n').map(l => {
    const k = l.startsWith('diff ') || l.startsWith('+++') || l.startsWith('---') ? 'l-file' : l.startsWith('@@') ? 'l-hunk' : l.startsWith('+') ? 'l-add' : l.startsWith('-') ? 'l-del' : ''
    return `<span class="${k}">${e(l) || ' '}</span>`
  }).join('')
  return `<pre class="diff-text">${rows}</pre>`
}

export async function stashBranch(ref) {
  const to = await c().ask({ title: `New branch from ${ref}`, ok: 'Create', input: { label: 'Branch name', placeholder: 'rescue/work' } })
  if (to) await c().gitAction({ action: 'stash:branch', stashRef: ref, to })
}

export async function stashFiles(paths) {
  const msg = await c().ask({ title: `Stash ${paths.length} file${paths.length === 1 ? '' : 's'}`, ok: 'Stash', input: { label: 'Message', value: 'echo stash' } })
  if (msg) await c().gitAction({ action: 'stash:create', message: msg, paths })
}

// ---------- ignore and intent-to-add ----------
export const ignorePaths = paths => c().gitAction({ action: 'ignore', paths })
export const intentToAdd = paths => c().gitAction({ action: 'add:intent', paths })

// ---------- pull and push menus ----------
export async function togglePullMenu(open) {
  const m = c().$('#pull-menu')
  m.hidden = !open
  if (!open) return
  const rs = c().state.status?.remotes || []
  m.innerHTML = '<button class="menu-item" data-pl="" role="menuitem">Pull (your Git settings)</button>'
    + '<button class="menu-item" data-pl="ff-only" role="menuitem" title="git pull --ff-only: fails instead of merging">Pull, fast-forward only</button>'
    + '<button class="menu-item" data-pl="rebase" role="menuitem" title="git pull --rebase">Pull with rebase</button>'
    + '<button class="menu-item" data-pl="merge" role="menuitem" title="git pull --no-rebase">Pull with merge</button>'
    + (rs.length ? '<div class="menu-sep"></div>' + rs.map(r => `<button class="menu-item" data-fetch="${c().esc(r)}" role="menuitem">Fetch ${c().esc(r)} only</button>`).join('') : '')
  const r = c().$('#pull-more').getBoundingClientRect()
  m.style.left = Math.max(8, r.right - m.offsetWidth) + 'px'
  m.style.top = r.bottom + 4 + 'px'
  m.querySelector('.menu-item').focus()
}

export function pushMenuHTML() {
  const rs = c().state.status?.remotes || [], e = c().esc
  return '<button class="menu-item" data-p="tags" role="menuitem" title="git push --tags">Push with tags</button>'
    + rs.map(r => `<button class="menu-item" data-p="up:${e(r)}" role="menuitem" title="git push -u ${e(r)} &lt;branch&gt;">Push to ${e(r)} and set upstream</button>`).join('')
    + '<div class="menu-sep"></div>'
    + '<button class="menu-item" data-p="lease" role="menuitem" title="git push --force-with-lease">Force push with lease</button>'
    + '<button class="menu-item danger" data-p="force" role="menuitem" title="git push --force">Force push (no lease)</button>'
}

export function init() {
  const box = c().$('#commit-message')
  box.addEventListener('input', meter)
  const so = c().$('#opt-signoff'), co = c().$('#opt-coauthor')
  so.checked = store.get('signoff') === '1'
  co.value = store.get('coauthor') || ''
  so.onchange = () => store.set('signoff', so.checked ? '1' : '0')
  co.oninput = () => store.set('coauthor', co.value)
  meter()
  loadTemplate()
  c().$('#pull-more')?.addEventListener('click', e => { e.stopPropagation(); togglePullMenu(c().$('#pull-menu').hidden) })
  c().$('#pull-menu').addEventListener('click', e => {
    const b = e.target.closest('.menu-item')
    if (!b) return
    togglePullMenu(false)
    if (b.dataset.fetch) c().gitAction({ action: 'fetch', remote: b.dataset.fetch })
    else c().gitAction({ action: 'pull', strategy: b.dataset.pl })
  })
  document.addEventListener('click', e => { if (!e.target.closest('#pull-menu, #pull-more')) togglePullMenu(false) })
}
