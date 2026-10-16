// Replace in the open file (the find bar) and across files (the Search rail).
import { ctx } from './ctx.js'
import { applyText, replaceRange } from './edit.js'

const f = () => ctx.find

// A regex replacement template with $$, $&, $`, $', $1 and $<name> expanded, against the whole text so lookarounds still see their context.
function expand(repl, match, caps, pos, str, groups) {
  return repl.replace(/\$(\$|&|`|'|\d{1,2}|<[^>]*>)/g, (t, k) => {
    if (k === '$') return '$'
    if (k === '&') return match
    if (k === '`') return str.slice(0, pos)
    if (k === "'") return str.slice(pos + match.length)
    if (k[0] === '<') return groups && k.slice(1, -1) in groups ? groups[k.slice(1, -1)] ?? '' : t
    const i = +k
    return i >= 1 && i <= caps.length ? caps[i - 1] ?? '' : t
  })
}

// A String.replace callback for regex mode: leaves empty matches alone, counts the rest through hit().
function regexSub(repl, hit) {
  return (...a) => {
    const groups = typeof a[a.length - 1] === 'object' ? a.pop() : null
    const str = a.pop(), pos = a.pop(), match = a.shift()
    if (!match) return match
    hit()
    return expand(repl, match, a, pos, str, groups)
  }
}

// Whole-text matching sees every line start and end, as the per-line find list does.
const multiline = re => new RegExp(re.source, re.flags.includes('m') ? re.flags : re.flags + 'm')

export function replaceCurrent() {
  const find = f(), m = find.list[find.idx], ed = ctx.$('#editor')
  if (!m) return
  const repl = ctx.$('#replace-input').value
  let end = m.off + (m.e - m.s), out = repl
  if (find.opts.regex) {
    const re = ctx.searchRegex({ q: find.q, ...find.opts })
    if (!re) return
    const r = new RegExp(multiline(re).source, multiline(re).flags.replace('g', '') + 'y')
    r.lastIndex = m.off
    const x = r.exec(ed.value)
    if (!x || !x[0]) return
    end = m.off + x[0].length
    out = expand(repl, x[0], x.slice(1), m.off, ed.value, x.groups)
  }
  replaceRange(ed, m.off, end, out)
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
  const text = find.opts.regex ? ed.value.replace(multiline(re), regexSub(repl, () => n++)) : ed.value.replace(re, () => { n++; return repl })
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
  if (!todo.length) { ctx.setStatus('Every matching file has unsaved edits in a tab; save or close them first', 'err'); return }
  const todoSet = new Set(todo), nMatches = s.res.matches.filter(m => todoSet.has(m.path)).length
  const note = (s.res.truncated ? '<p class="note">The results were capped, so some matches are not listed. Run the replace again afterwards to catch the rest.</p>' : '')
    + (skipped.length ? `<p class="note">${skipped.length} file${skipped.length === 1 ? ' has' : 's have'} unsaved edits in a tab and will be skipped: ${skipped.map(ctx.esc).join(', ')}.</p>` : '')
  const ok = await ctx.ask({
    title: `Replace in ${ctx.plural(todo.length, 'file')}`, kicker: 'writes files', tone: 'warn', ok: 'Replace all',
    html: `<p><code>${ctx.esc(s.ran.q)}</code> → <code>${ctx.esc(repl) || '(nothing)'}</code> in ${ctx.plural(nMatches, 'match', 'matches')}.${s.ran.regex ? ' $1-style groups apply.' : ''}</p><ul class="dialog-files">${todo.slice(0, 8).map(p => `<li><span class="p">${ctx.esc(p)}</span></li>`).join('')}${todo.length > 8 ? `<li class="more">…and ${todo.length - 8} more</li>` : ''}</ul>${note}<p class="note">Each file is saved only if it has not changed since it was read. Nothing is staged; the diff shows what changed.</p>`,
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
      const next = s.ran.regex ? d.content.replace(multiline(re), regexSub(repl, () => n++)) : d.content.replace(re, () => { n++; return repl })
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
    if (e.isComposing || e.keyCode === 229) return
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
