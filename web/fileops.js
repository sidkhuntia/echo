// What can be done to files and folders from the tree and the tabs: rename, duplicate, delete, move,
// reveal in the file manager, open in another app, and the read-only side view.
import { ctx } from './ctx.js'
import { highlightLines } from './highlight.js'

const c = () => ctx
const inDir = (p, dir) => p === dir || p.startsWith(dir + '/')

function retarget(from, to) {
  for (const t of c().state.tabs) if (inDir(t.path, from)) t.path = to + t.path.slice(from.length)
  if (c().state.selected && inDir(c().state.selected, from)) c().state.selected = to + c().state.selected.slice(from.length)
}

async function run(body, after) {
  try {
    await c().post('/api/file', body)
    after?.()
    await c().refreshAll()
    c().renderTabs?.(); c().renderEditor?.()
  } catch (e) { c().setStatus(e.message, 'err') }
}

export async function rename(path) {
  const to = await c().ask({ title: 'Rename', ok: 'Rename', input: { label: 'New path', value: path } })
  if (to && to !== path) await run({ action: 'rename', path, newPath: to }, () => retarget(path, to))
}

export async function duplicate(path) {
  const dot = path.lastIndexOf('.'), slash = path.lastIndexOf('/')
  const guess = dot > slash + 1 ? `${path.slice(0, dot)} copy${path.slice(dot)}` : `${path} copy`
  const to = await c().ask({ title: 'Duplicate', ok: 'Duplicate', input: { label: 'Path of the copy', value: guess } })
  if (to && to !== path) { await run({ action: 'duplicate', path, newPath: to }); c().openFile(to) }
}

export async function remove(path, isDir) {
  const files = isDir ? c().state.tree.filter(f => inDir(f.path, path)).length : 1
  const ok = await c().ask({
    title: isDir ? `Delete folder ${path}` : `Delete ${path}`, kicker: 'no undo here', tone: 'danger', ok: 'Delete',
    html: isDir ? `<p>${c().plural(files, 'file')} in <b>${c().esc(path)}</b> will be deleted from disk. Tracked files can be restored with Git; untracked ones cannot.</p>` : '<p>The file is deleted from disk. If Git tracks it, you can restore it from Git; otherwise it is gone.</p>',
  })
  if (!ok) return
  await run({ action: isDir ? 'delete:dir' : 'delete', path }, () => {
    c().state.tabs = c().state.tabs.filter(t => !inDir(t.path, path))
    c().state.active = Math.min(c().state.active, c().state.tabs.length - 1)
  })
}

export async function newFolder(dir) {
  const p = await c().ask({ title: 'New folder', ok: 'Create', input: { label: 'Path, relative to the repository', value: dir ? dir + '/' : '', end: true } })
  if (p) await run({ action: 'mkdir', path: p })
}

// move is what dropping a file or folder on a folder does.
export async function move(path, destDir) {
  const name = path.slice(path.lastIndexOf('/') + 1), to = destDir ? `${destDir}/${name}` : name
  if (to === path || inDir(destDir, path)) return
  const ok = await c().ask({ title: `Move ${name}`, ok: 'Move', html: `<p><b>${c().esc(path)}</b> → <b>${c().esc(to)}</b></p>` })
  if (ok) await run({ action: 'rename', path, newPath: to }, () => retarget(path, to))
}

export const reveal = path => c().post('/api/open', { path, reveal: true }).catch(e => c().setStatus(e.message, 'err'))
export const openDefault = path => c().post('/api/open', { path }).catch(e => c().setStatus(e.message, 'err'))
export const openExternal = (path, line = 0, app = c().state.config.externalEditor || '') => c().post('/api/open', { path, line, app }).catch(e => c().setStatus(e.message, 'err'))

// ---------- the side view ----------
// A second file beside the editor, for reading while you edit. It is read-only: Swap makes it the main file.
let side = null

export async function openSide(path) {
  try {
    const d = await c().api(`/api/file?path=${encodeURIComponent(path)}`)
    if (d.binary || d.tooLarge) return c().setStatus('That file cannot be shown as text', 'err')
    side = { path, content: d.content.replace(/\r\n/g, '\n'), hash: d.hash }
    paintSide()
  } catch (e) { c().setStatus(e.message, 'err') }
}

export const sideOpen = () => !!side

export function paintSide() {
  const el = c().$('#side'), stage = c().$('.stage')
  const show = !!side && c().state.mode === 'file'
  el.hidden = !show
  stage.classList.toggle('has-side', show)
  if (!show) return
  c().$('#side-title').textContent = side.path
  c().$('#side-title').title = side.path
  const lines = side.content.split('\n')
  const rows = highlightLines(side.content.split('\n').slice(0, 4000).join('\n'), side.path)
  c().$('#side-code').innerHTML = lines.slice(0, 4000).map((l, i) => `<div class="side-row"><span class="side-no">${i + 1}</span><span class="side-tx">${rows ? rows[i] ?? '' : c().esc(l)}</span></div>`).join('') + (lines.length > 4000 ? '<div class="side-row faint">Showing the first 4,000 lines.</div>' : '')
}

// A changed file is re-read when the status says its content moved.
export async function refreshSide() {
  if (!side) return
  const h = c().state.changes.get(side.path)?.hash
  if (h && h !== side.hash) await openSide(side.path)
}

export function closeSide() { side = null; paintSide() }

export async function swapSide() {
  if (!side) return
  const p = side.path
  closeSide()
  await c().openFile(p)
}

export function initFileOps() {
  c().$('#side').addEventListener('click', e => {
    const b = e.target.closest('[data-side]')
    if (b?.dataset.side === 'close') closeSide()
    else if (b?.dataset.side === 'swap') swapSide()
  })
  // Drag a file or folder in the tree onto a folder to move it.
  const tree = c().$('#tree')
  tree.addEventListener('dragstart', e => {
    const row = e.target.closest('.tnode')
    if (!row) return
    e.dataTransfer.setData('text/x-echo-path', row.dataset.path || row.dataset.dir)
    e.dataTransfer.effectAllowed = 'move'
  })
  tree.addEventListener('dragover', e => {
    if (!e.dataTransfer.types.includes('text/x-echo-path')) return
    e.preventDefault()
    tree.querySelectorAll('.drop').forEach(n => n.classList.remove('drop'))
    e.target.closest('.tnode.dir')?.classList.add('drop')
  })
  tree.addEventListener('dragleave', e => { if (e.target === tree) tree.querySelectorAll('.drop').forEach(n => n.classList.remove('drop')) })
  tree.addEventListener('drop', e => {
    const from = e.dataTransfer.getData('text/x-echo-path')
    if (!from) return
    e.preventDefault()
    tree.querySelectorAll('.drop').forEach(n => n.classList.remove('drop'))
    const dir = e.target.closest('.tnode.dir')
    move(from, dir ? dir.dataset.dir : '')
  })
}
