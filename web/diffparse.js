// Parses `git diff` text into files, hunks and lines.
function unquote(p) {
  p = p.replace(/\t$/, '')
  if (p.startsWith('"')) try { return JSON.parse(p) } catch {}
  return p
}

export function parseDiff(text) {
  const files = []
  let f = null, h = null, o = 0, n = 0
  const finish = () => { if (f) f.path = f.plus ?? f.minus ?? f.path }
  for (const line of text.split('\n')) {
    if (line.startsWith('diff --git ')) {
      finish()
      const rest = line.slice(11), len = (rest.length - 5) / 2
      let path = rest
      if (Number.isInteger(len) && rest.slice(2, 2 + len) === rest.slice(5 + len)) path = rest.slice(2, 2 + len)
      else { const m = rest.match(/^a\/(.*) b\/(.*)$/); if (m) path = m[2] }
      f = { path: unquote(path), hunks: [], added: 0, deleted: 0, lines: 0, isNew: false, isDeleted: false, binary: false, note: '' }
      files.push(f); h = null
      continue
    }
    if (!f) continue
    if (line.startsWith('@@')) {
      const m = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@ ?(.*)$/)
      if (!m) continue
      o = +m[1]; n = +m[2]
      h = { range: line.slice(0, line.indexOf('@@', 2) + 2), context: m[3], lines: [], nStart: n, add: 0, del: 0 }
      f.hunks.push(h)
      continue
    }
    if (!h) {
      if (line.startsWith('--- ')) { const p = line.slice(4); if (p !== '/dev/null') f.minus = unquote(p).replace(/^a\//, '') }
      else if (line.startsWith('+++ ')) { const p = line.slice(4); if (p !== '/dev/null') f.plus = unquote(p).replace(/^b\//, '') }
      else if (line.startsWith('new file')) f.isNew = true
      else if (line.startsWith('rename from ')) f.renamedFrom = unquote(line.slice(12))
      else if (line.startsWith('old mode ')) (f.mode ||= {}).from = line.slice(9)
      else if (line.startsWith('new mode ')) (f.mode ||= {}).to = line.slice(9)
      else if (line.startsWith('deleted file')) f.isDeleted = true
      else if (line.startsWith('Binary files')) f.binary = true
      else if (line.startsWith('echo: ')) f.note = line.slice(6)
      continue
    }
    const c = line[0]
    if (c === '+') { h.lines.push({ t: 'add', n: n++, text: line.slice(1) }); f.added++; h.add++ }
    // `at` is where a deleted line would sit in the new version, so it can still jump to the editor.
    else if (c === '-') { h.lines.push({ t: 'del', o: o++, at: n, text: line.slice(1) }); f.deleted++; h.del++ }
    else if (c === ' ') h.lines.push({ t: 'ctx', o: o++, n: n++, text: line.slice(1) })
    else if (c === '\\') h.lines.push({ t: 'meta', text: line.slice(2) })
    else continue
    f.lines++
  }
  finish()
  return files
}

