// Word-level changes inside a changed line: which characters of a deleted line and its replacement differ.

const TOKEN = /\w+|\s+|[^\w\s]/g
const MAX_TOKENS = 300

const tokens = s => {
  const out = []
  let at = 0
  for (const m of s.matchAll(TOKEN)) { out.push({ s: m[0], at }); at += m[0].length }
  return out
}

// wordRanges returns the changed character ranges of each side, or null when the lines are too long
// to compare cheaply or too different for the marks to mean anything.
export function wordRanges(a, b) {
  const x = tokens(a), y = tokens(b)
  if (!x.length || !y.length || x.length > MAX_TOKENS || y.length > MAX_TOKENS) return null
  const n = x.length, m = y.length
  const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1))
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = x[i].s === y[j].s ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
  const keepX = new Set(), keepY = new Set()
  for (let i = 0, j = 0; i < n && j < m;) {
    if (x[i].s === y[j].s) { keepX.add(i); keepY.add(j); i++; j++ }
    else if (dp[i + 1][j] >= dp[i][j + 1]) i++
    else j++
  }
  // Less than a third in common reads as a rewrite, and a mark over everything says nothing.
  const common = [...keepX].reduce((sum, i) => sum + x[i].s.length, 0)
  if (common < Math.min(a.length, b.length) / 3) return null
  const ranges = (t, keep) => {
    const out = []
    t.forEach((tok, i) => {
      if (keep.has(i)) return
      const last = out.at(-1)
      if (last && last[1] === tok.at) last[1] = tok.at + tok.s.length
      else out.push([tok.at, tok.at + tok.s.length])
    })
    // Whitespace-only marks are noise.
    return out.filter(([s, e]) => (t === x ? a : b).slice(s, e).trim())
  }
  return { a: ranges(x, keepX), b: ranges(y, keepY) }
}

// pairRuns pairs the deleted and added lines of each change run: in order when the counts agree,
// otherwise each deleted line takes the next added line that resembles it.
export function pairRuns(lines) {
  const pairs = []
  let dels = [], adds = []
  const flush = () => {
    if (dels.length && adds.length && dels.length <= 30 && adds.length <= 30) {
      if (dels.length === adds.length) dels.forEach((d, k) => pairs.push([d, adds[k]]))
      else {
        let from = 0
        for (const d of dels) {
          for (let k = from; k < adds.length; k++) {
            if (wordRanges(d.text, adds[k].text)) { pairs.push([d, adds[k]]); from = k + 1; break }
          }
        }
      }
    }
    dels = []; adds = []
  }
  for (const l of lines) {
    if (l.t === 'del') { if (adds.length) flush(); dels.push(l) }
    else if (l.t === 'add') adds.push(l)
    else flush()
  }
  flush()
  return pairs
}

// injectMarks wraps the given character ranges of a syntax-highlighted line in <mark>. Entities count
// as one character, and a mark is closed around every tag and reopened after it, so the markup
// stays properly nested.
export function injectMarks(html, ranges, cls = 'wd') {
  if (!ranges?.length) return html
  const parts = html.match(/<[^>]*>|&(?:#\d+|#x[0-9a-f]+|\w+);|[^<&]|&/gi) || []
  let out = '', pos = 0, open = false
  const inside = p => ranges.some(([s, e]) => p >= s && p < e)
  for (const part of parts) {
    if (part[0] === '<') { if (open) { out += '</mark>'; open = false } out += part; continue }
    const on = inside(pos)
    if (on && !open) { out += `<mark class="${cls}">`; open = true }
    else if (!on && open) { out += '</mark>'; open = false }
    out += part
    pos++
  }
  return open ? out + '</mark>' : out
}
