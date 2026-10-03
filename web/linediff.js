// Line-level diffs for the editor's change bars (Myers' O(ND)).
// Lines without the empty string after a final newline, so the phantom last line never gets a bar.
export function splitLines(text) {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  if (lines.length && lines.at(-1) === '') lines.pop()
  return lines
}

// lineDiff compares line arrays: marks[i] is 'add' or 'mod' for changed lines of b, and dels holds the
// b positions where lines of a were removed with nothing added in their place.
export function lineDiff(a, b) {
  let s = 0
  while (s < a.length && s < b.length && a[s] === b[s]) s++
  let ea = a.length, eb = b.length
  while (ea > s && eb > s && a[ea - 1] === b[eb - 1]) { ea--; eb-- }
  const marks = [], dels = new Set()
  const ops = myers(a.slice(s, ea), b.slice(s, eb))
  if (!ops) {
    // Too different to diff cheaply: call the whole middle modified.
    for (let i = s; i < eb; i++) marks[i] = 'mod'
    if (eb === s && ea > s) dels.add(s)
    return { marks, dels }
  }
  let j = s, removed = 0, added = []
  const flush = () => {
    for (const k of added) marks[k] = removed ? 'mod' : 'add'
    if (removed && !added.length) dels.add(j)
    removed = 0; added = []
  }
  for (const op of ops) {
    if (op === '=') { flush(); j++ }
    else if (op === '-') removed++
    else { added.push(j); j++ }
  }
  flush()
  return { marks, dels }
}

// Myers' O(ND) diff, returning '=', '-', '+' ops, or null when the edit distance passes the limit.
export function myers(a, b, limit = 2000) {
  const n = a.length, m = b.length
  if (!n) return Array(m).fill('+')
  if (!m) return Array(n).fill('-')
  const max = n + m, off = max
  const v = new Int32Array(2 * max + 2)
  const trace = []
  for (let d = 0; d <= Math.min(max, limit); d++) {
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? v[off + k + 1] : v[off + k - 1] + 1
      let y = x - k
      while (x < n && y < m && a[x] === b[y]) { x++; y++ }
      v[off + k] = x
      if (x >= n && y >= m) { trace.push(v.slice(off - d, off + d + 1)); return backtrack(trace, n, m) }
    }
    trace.push(v.slice(off - d, off + d + 1))
  }
  return null
}

function backtrack(trace, n, m) {
  const ops = []
  let x = n, y = m
  for (let d = trace.length - 1; d > 0; d--) {
    const prev = trace[d - 1], at = kk => prev[kk + d - 1]
    const k = x - y
    const pk = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1
    const px = at(pk), py = px - pk
    while (x > px && y > py) { ops.push('='); x--; y-- }
    if (pk === k + 1) { ops.push('+'); y-- } else { ops.push('-'); x-- }
  }
  while (x > 0 && y > 0) { ops.push('='); x--; y-- }
  return ops.reverse()
}

