// Replace in the open file (the find bar) and across files (the Search rail).
import { ctx } from './ctx.js'
import { applyText, replaceRange } from './edit.js'

const f = () => ctx.find

// The replacement for one match: literal in plain mode, with $1-style groups in regex mode.
function replacementFor(matchText, re, repl) {
  return f().opts.regex ? matchText.replace(new RegExp(re.source, re.flags.replace('g', '')), repl) : repl
}

export function replaceCurrent() {
  const find = f(), m = find.list[find.idx], ed = ctx.$('#editor')
  if (!m) return
  const repl = ctx.$('#replace-input').value
  const re = ctx.searchRegex({ q: find.q, ...find.opts })
  const text = ed.value.slice(m.off, m.off + (m.e - m.s))
  replaceRange(ed, m.off, m.off + (m.e - m.s), replacementFor(text, re, repl))
  ctx.paintAll()
  ctx.revealMatch?.()
}

export function replaceAll() {
  const find = f(), ed = ctx.$('#editor')
  if (!find.q || !find.list.length) return
  const re = ctx.searchRegex({ q: find.q, ...find.opts })
  if (!re) return
  const repl = ctx.$('#replace-input').value
  let n = 0
  const text = find.opts.regex ? ed.value.replace(re, (...a) => { n++; return replacementFor(a[0], re, repl) }) : ed.value.replace(re, () => { n++; return repl })
  applyText(ed, text)
  ctx.paintAll()
  ctx.setStatus(`Replaced ${n} match${n === 1 ? '' : 'es'}`, 'ok')
}

export async function replaceInFiles() {
  const s = ctx.state.search, repl = ctx.$('#replace-files-input').value
  if (!s.res?.matches.length || !s.ran) return
  const paths = [...new Set(s.res.matches.map(m => m.path))]
  const open = new Set(ctx.state.tabs.filter(t => t.content !== t.saved).map(t => t.path))
  const todo = paths.filter(p => !open.has(p)), skipped = paths.filter(p => open.has(p))
  const note = (s.res.truncated ? '<p class="note">The results were capped, so some matches are not listed. Run the replace again afterwards to catch the rest.</p>' : '')
    + (skipped.length ? `<p class="note">${skipped.length} file${skipped.length === 1 ? ' has' : 's have'} unsaved edits in a tab and will be skipped: ${skipped.map(ctx.esc).join(', ')}.</p>` : '')
  const ok = await ctx.ask({
    title: `Replace in ${ctx.plural(todo.length, 'file')}`, kicker: 'writes files', tone: 'warn', ok: 'Replace all',
    html: `<p><code>${ctx.esc(s.ran.q)}</code> → <code>${ctx.esc(repl) || '(nothing)'}</code> in ${ctx.plural(s.res.matches.length, 'match', 'matches')}.${s.ran.regex ? ' $1-style groups apply.' : ''}</p><ul class="dialog-files">${todo.slice(0, 8).map(p => `<li><span class="p">${ctx.esc(p)}</span></li>`).join('')}${todo.length > 8 ? `<li class="more">…and ${todo.length - 8} more</li>` : ''}</ul>${note}<p class="note">Each file is saved only if it has not changed since it was read. Nothing is staged; the diff shows what changed.</p>`,
  })
  if (!ok) return
  const re = ctx.searchRegex(s.ran)
  let changed = 0, count = 0
  const failed = []
  for (const path of todo) {
    try {
      const d = await ctx.api(`/api/file?path=${encodeURIComponent(path)}`)
      if (d.binary || d.tooLarge) continue
      let n = 0
      const next = s.ran.regex ? d.content.replace(re, (...a) => { n++; return a[0].replace(new RegExp(re.source, re.flags.replace('g', '')), repl) }) : d.content.replace(re, () => { n++; return repl })
      if (!n || next === d.content) continue
      await ctx.post('/api/file', { action: 'save', path, content: next, baseHash: d.hash })
      changed++; count += n
    } catch (e) { failed.push(`${path}: ${e.message}`) }
  }
  ctx.setStatus(`Replaced ${count} in ${changed} file${changed === 1 ? '' : 's'}${failed.length ? `; ${failed.length} failed` : ''}`, failed.length ? 'err' : 'ok')
  if (failed.length) ctx.ask({ title: 'Some files were not changed', ok: 'OK', html: `<ul class="dialog-files">${failed.map(x => `<li><span class="p">${ctx.esc(x)}</span></li>`).join('')}</ul>` })
  await ctx.refreshAll()
  ctx.runSearch?.()
}

export function initReplace() {
  ctx.$('#replace-one')?.addEventListener('click', replaceCurrent)
  ctx.$('#replace-all')?.addEventListener('click', replaceAll)
  ctx.$('#replace-files')?.addEventListener('click', replaceInFiles)
  ctx.$('#replace-input')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); e.shiftKey ? replaceAll() : replaceCurrent() }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); ctx.closeFind() }
  })
  ctx.$('#find-toggle-replace')?.addEventListener('click', () => toggleReplace())
}

export function toggleReplace(on) {
  const bar = ctx.$('#findbar'), open = on ?? !bar.classList.contains('with-replace')
  bar.classList.toggle('with-replace', open)
  ctx.$('#find-toggle-replace').setAttribute('aria-pressed', open)
  if (open) ctx.$('#replace-input').focus()
}
