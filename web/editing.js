// Pure text-editing helpers for the editor. Each takes the text and the selection and returns an edit,
// { start, end, text, selStart, selEnd }: replace [start, end) with text, then select [selStart, selEnd).
// They never touch the DOM, so they can be tested without a browser.

export const lineStart = (t, i) => t.lastIndexOf('\n', i - 1) + 1
export const lineEnd = (t, i) => { const n = t.indexOf('\n', i); return n < 0 ? t.length : n }

// The whole lines a selection touches: from the start of the first to the end of the last (past its newline).
// A selection that ends at the very start of a line does not include that line.
export function lineSpan(t, s, e) {
  const a = lineStart(t, s)
  const last = e > s && t[e - 1] === '\n' ? e - 1 : e
  const b = lineEnd(t, last)
  return [a, Math.min(t.length, b + 1)]
}

// ---------- indentation ----------
// detectIndent reads what a file already uses: tabs, or the most common step between space indents.
export function detectIndent(text) {
  let tabs = 0, spaces = 0
  const steps = new Map()
  let prev = 0
  for (const line of text.split('\n').slice(0, 2000)) {
    if (!line.trim()) continue
    if (line[0] === '\t') { tabs++; continue }
    const n = line.match(/^ */)[0].length
    if (n > 0) spaces++
    const d = Math.abs(n - prev)
    if (d > 0 && d <= 8) steps.set(d, (steps.get(d) || 0) + 1)
    prev = n
  }
  if (tabs > spaces) return { tabs: true, size: 4 }
  if (!spaces) return null
  let best = 4, count = 0
  for (const [d, c] of steps) if (c > count || (c === count && d < best)) { best = d; count = c }
  return { tabs: false, size: best }
}

// indentUnit is the text one level of indentation inserts, from the settings and what the file uses.
export function indentUnit({ indent = 'auto', tabSize = 0 } = {}, detected = null) {
  const size = tabSize || detected?.size || 4
  if (indent === 'tabs' || (indent === 'auto' && detected?.tabs)) return '\t'
  return ' '.repeat(size)
}

// indentLines adds a level to every line of the selection, or removes one (outdent).
export function indentLines(t, s, e, unit, outdent = false) {
  const [a, b] = lineSpan(t, s, e)
  const lines = t.slice(a, b).split('\n')
  const trailing = lines.at(-1) === '' ? lines.pop() !== undefined : false
  let firstDelta = 0, total = 0
  const out = lines.map((l, i) => {
    let r = l
    if (!outdent) { if (l.length || lines.length === 1) r = unit + l }
    else if (l.startsWith(unit)) r = l.slice(unit.length)
    else if (l.startsWith('\t')) r = l.slice(1)
    else r = l.replace(new RegExp(`^ {1,${unit.length}}`), '')
    if (i === 0) firstDelta = r.length - l.length
    total += r.length - l.length
    return r
  })
  const text = out.join('\n') + (trailing ? '\n' : '')
  return { start: a, end: b, text, selStart: Math.max(a, s + firstDelta), selEnd: Math.max(a, e + total) }
}

const OPEN = { '{': '}', '(': ')', '[': ']' }

// enterEdit decides what Enter inserts: a newline plus the current line's indentation, one level
// deeper after an opening bracket or colon, and the closing bracket on its own line between a pair.
export function enterEdit(t, s, e, unit) {
  const ls = lineStart(t, s)
  const before = t.slice(ls, s)
  const base = before.match(/^[ \t]*/)[0]
  const prev = before.trimEnd().slice(-1), next = t[e]
  const opens = OPEN[prev] !== undefined || (prev === ':' && /\b(if|else|elif|for|while|def|class|try|except|finally|with|case|switch)\b|^\s*(\w+)\s*:\s*$/.test(before))
  if (OPEN[prev] && next === OPEN[prev]) {
    const mid = '\n' + base + unit, text = mid + '\n' + base
    return { start: s, end: e, text, selStart: s + mid.length, selEnd: s + mid.length }
  }
  const ind = '\n' + base + (opens ? unit : '')
  return { start: s, end: e, text: ind, selStart: s + ind.length, selEnd: s + ind.length }
}

// ---------- comments ----------
const SLASH = ['js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'go', 'java', 'kt', 'kts', 'swift', 'c', 'h', 'cc', 'cpp', 'hpp', 'cs', 'rs', 'scala', 'dart', 'php', 'groovy', 'gradle', 'proto', 'zig', 'jsonc', 'scss', 'less']
const HASH = ['py', 'rb', 'sh', 'bash', 'zsh', 'yml', 'yaml', 'toml', 'conf', 'ini', 'env', 'mk', 'pl', 'r', 'ex', 'exs', 'nix', 'tf', 'dockerfile', 'gitignore', 'properties', 'cfg', 'txt']
export function commentStyle(path) {
  const base = path.split('/').pop().toLowerCase(), ext = base.includes('.') ? base.split('.').pop() : base
  if (SLASH.includes(ext)) return { line: '//' }
  if (HASH.includes(ext) || base === 'makefile' || base === 'dockerfile') return { line: '#' }
  if (['css'].includes(ext)) return { block: ['/*', '*/'] }
  if (['html', 'htm', 'xml', 'svg', 'vue', 'md', 'markdown'].includes(ext)) return { block: ['<!--', '-->'] }
  if (['sql', 'lua', 'hs'].includes(ext)) return { line: '--' }
  if (['vim'].includes(ext)) return { line: '"' }
  return null
}

// toggleComment comments the selected lines, or uncomments them when every non-blank line already is.
export function toggleComment(t, s, e, path) {
  const st = commentStyle(path)
  if (!st) return null
  const [a, b] = lineSpan(t, s, e)
  const lines = t.slice(a, b).split('\n')
  const trailing = lines.at(-1) === '' && lines.pop() !== undefined
  const [open, close] = st.line ? [st.line, ''] : st.block
  const live = lines.filter(l => l.trim())
  const all = live.length && live.every(l => l.trimStart().startsWith(open))
  let total = 0, first = 0
  const out = lines.map((l, i) => {
    let r = l
    if (!l.trim()) return l
    if (all) {
      const ind = l.match(/^\s*/)[0]
      let rest = l.slice(ind.length).slice(open.length)
      if (rest.startsWith(' ')) rest = rest.slice(1)
      if (close) rest = rest.replace(new RegExp(`\\s?${close.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`), '')
      r = ind + rest
    } else {
      const min = Math.min(...live.map(x => x.match(/^[ \t]*/)[0].length))
      r = l.slice(0, min) + open + ' ' + l.slice(min) + (close ? ' ' + close : '')
    }
    if (i === 0) first = r.length - l.length
    total += r.length - l.length
    return r
  })
  const text = out.join('\n') + (trailing ? '\n' : '')
  return { start: a, end: b, text, selStart: Math.max(a, s + first), selEnd: Math.max(a, e + total) }
}

// ---------- lines ----------
// moveLines swaps the selected lines with the line above (dir -1) or below (+1).
export function moveLines(t, s, e, dir) {
  const [a, b] = lineSpan(t, s, e)
  if (dir < 0 && a === 0) return null
  if (dir > 0 && b >= t.length && t.endsWith(t.slice(a, b)) && !t.slice(b)) return null
  if (dir < 0) {
    const pa = lineStart(t, a - 1)
    const block = t.slice(a, b), prev = t.slice(pa, a)
    const endsNl = block.endsWith('\n')
    const moved = endsNl ? block + prev : block + '\n' + prev.replace(/\n$/, '')
    const text = endsNl ? moved : moved
    return { start: pa, end: b, text, selStart: s - prev.length, selEnd: e - prev.length }
  }
  const nb = Math.min(t.length, lineEnd(t, b) + 1) // end of the next line
  const block = t.slice(a, b), next = t.slice(b, nb)
  if (!next) return null
  const blockNl = block.endsWith('\n')
  const text = next.replace(/\n$/, '') + '\n' + (blockNl ? block : block)
  const fixed = nb === t.length && !t.endsWith('\n') ? next + '\n' + block.replace(/\n$/, '') : text
  return { start: a, end: nb, text: fixed, selStart: s + next.length, selEnd: e + next.length }
}

// duplicateLines copies the selected lines below (dir 1) or above (-1) themselves.
export function duplicateLines(t, s, e, dir) {
  const [a, b] = lineSpan(t, s, e)
  let block = t.slice(a, b)
  const noNl = !block.endsWith('\n')
  if (noNl) block += '\n'
  const text = dir > 0 ? (noNl ? '\n' + block.slice(0, -1) : block) : block
  if (dir > 0) {
    const at = noNl ? b : b
    const ins = noNl ? '\n' + block.slice(0, -1) : block
    return { start: at, end: at, text: ins, selStart: s + ins.length, selEnd: e + ins.length }
  }
  return { start: a, end: a, text: block, selStart: s, selEnd: e }
}

export function deleteLines(t, s, e) {
  const [a, b] = lineSpan(t, s, e)
  // The last line has no newline of its own, so the one before it goes with it.
  const start = b >= t.length && a > 0 && !t.endsWith('\n') ? a - 1 : a
  return { start, end: b, text: '', selStart: start, selEnd: start }
}

// ---------- brackets ----------
const CLOSE = { '}': '{', ')': '(', ']': '[' }

// matchBracket finds the bracket that pairs with the one at (or just before) pos, or -1.
export function matchBracket(t, pos) {
  for (const i of [pos, pos - 1]) {
    const ch = t[i]
    if (OPEN[ch] !== undefined) {
      let depth = 0
      for (let k = i; k < t.length; k++) {
        if (t[k] === ch) depth++
        else if (t[k] === OPEN[ch] && --depth === 0) return k
      }
      return -1
    }
    if (CLOSE[ch] !== undefined) {
      let depth = 0
      for (let k = i; k >= 0; k--) {
        if (t[k] === ch) depth++
        else if (t[k] === CLOSE[ch] && --depth === 0) return k
      }
      return -1
    }
  }
  return -1
}

// ---------- scopes ----------
const SYMBOL = /^\s*(?:(?:export\s+)?(?:default\s+)?(?:async\s+)?function\*?\s+[\w$]+|(?:export\s+)?(?:const|let|var)\s+[\w$]+\s*=\s*(?:async\s*)?(?:\([^)]*\)|[\w$]+)\s*=>|(?:export\s+)?(?:default\s+)?(?:abstract\s+)?(?:pub\s+)?(?:class|struct|enum|trait|interface|impl|module|namespace|object)\s+[\w$]+|func\s+(?:\([^)]*\)\s*)?[\w.]+|(?:async\s+)?def\s+\w+|(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+\w+|type\s+\w+\s+(?:struct|interface)|#{1,6}\s+\S|[\w.$]+\s*\([^)]*\)\s*\{\s*$)/

// enclosingScopes lists the scope headers above a line, outermost first: each is the nearest earlier
// line that looks like a declaration and is indented less than the line below it. Lines hold the file's lines.
export function enclosingScopes(lines, idx, max = 4) {
  const indentOf = l => l.replace(/\t/g, '    ').match(/^ */)[0].length
  let want = Infinity
  for (let i = idx; i >= 0 && want > 0; i--) {
    if (lines[i].trim()) { want = indentOf(lines[i]) + (i === idx ? 1 : 0); break }
  }
  const out = []
  for (let i = idx - (lines[idx]?.trim() ? 1 : 0); i >= 0 && want > 0 && out.length < max; i--) {
    const l = lines[i]
    if (!l.trim()) continue
    const ind = indentOf(l)
    if (ind < want && SYMBOL.test(l)) { out.unshift({ line: i, text: l.trim() }); want = ind }
    else if (ind < want && /^\s*[}\])]/.test(l) === false) want = Math.min(want, ind + 0) || want
  }
  return out
}

// ---------- csv ----------
// parseCSV reads comma or tab separated text, with quoted fields; rows past the limit are not read.
export function parseCSV(text, sep = ',', limit = 5000) {
  const rows = []
  let row = [], field = '', q = false
  for (let i = 0; i < text.length && rows.length < limit; i++) {
    const ch = text[i]
    if (q) {
      if (ch === '"') { if (text[i + 1] === '"') { field += '"'; i++ } else q = false }
      else field += ch
    } else if (ch === '"' && !field) q = true
    else if (ch === sep) { row.push(field); field = '' }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++
      row.push(field); rows.push(row); row = []; field = ''
    } else field += ch
  }
  if (field || row.length) { row.push(field); rows.push(row) }
  return rows
}
