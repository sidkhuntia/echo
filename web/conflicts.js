// Merge conflict markers in a file's text: where each conflict is, and what taking a side leaves.
//
// Markers are seven or more of the same character (git's conflict-marker-size
// can be raised), with an optional label after a space. A trailing \r (a file
// that still has CRLF in it) and trailing spaces are allowed, so a marker is
// recognised even before the editor normalises the line endings.

const START = /^<{7,} ?(.*?) ?\r?$/, MID = /^={7,} ?\r?$/, END = /^>{7,} ?(.*?) ?\r?$/, BASE = /^\|{7,} ?(.*?) ?\r?$/

const isStart = l => l.startsWith('<<<<<<<') && START.test(l)
const isMid = l => l.startsWith('=======') && MID.test(l)
const isEnd = l => l.startsWith('>>>>>>>') && END.test(l)
const isBase = l => l.startsWith('|||||||') && BASE.test(l)

// findConflicts returns every complete conflict block, with character offsets into text.
export function findConflicts(text) {
  const out = []
  const lines = text.split('\n')
  let off = 0, cur = null, part = 'ours'
  lines.forEach((line, i) => {
    const len = line.length + 1
    let m
    if (!cur && (m = line.match(START)) && isStart(line)) {
      cur = { start: off, startLine: i, ours: [], base: null, theirs: [], oursLabel: (m[1] || '').trim(), theirsLabel: '' }
      part = 'ours'
    } else if (cur && part === 'ours' && isBase(line)) {
      part = 'base'
      cur.base = []
    } else if (cur && part !== 'theirs' && isMid(line)) {
      part = 'theirs'
    } else if (cur && part === 'theirs' && (m = line.match(END)) && isEnd(line)) {
      cur.end = off + len
      cur.endLine = i
      cur.theirsLabel = (m[1] || '').trim()
      out.push(cur)
      cur = null
    } else if (cur) {
      cur[part].push(line)
    }
    off += len
  })
  return out.map(c => ({ ...c, end: Math.min(c.end, text.length) }))
}

// hasMarkers reports whether the text holds at least one complete conflict.
export function hasMarkers(text) {
  return findConflicts(text).length > 0
}

// findIncomplete reports an unterminated conflict: a start marker with no end.
// It returns the zero-based line number of the start, or -1 when there is none.
// A file can hold both complete conflicts and one incomplete tail.
export function findIncomplete(text) {
  const lines = text.split('\n')
  let open = -1, part = ''
  lines.forEach((line, i) => {
    if (open < 0 && isStart(line)) {
      open = i
      part = 'ours'
    } else if (open >= 0 && part === 'ours' && isBase(line)) {
      part = 'base'
    } else if (open >= 0 && part !== 'theirs' && isMid(line)) {
      part = 'theirs'
    } else if (open >= 0 && part === 'theirs' && isEnd(line)) {
      open = -1
    }
  })
  return open
}

// conflictLines returns the zero-based lines covered by complete conflicts,
// for gutter and minimap markers. Marker lines themselves are included.
export function conflictLines(text) {
  const set = new Set()
  for (const c of findConflicts(text)) {
    for (let i = c.startLine; i <= c.endLine; i++) set.add(i)
  }
  return set
}

// excerpt is one line to show for a side in the conflict list: the first
// non-blank line, trimmed to a readable length.
export function excerpt(lines, max = 80) {
  const l = (lines || []).find(s => s.trim()) || ''
  const t = l.trim()
  return t.length > max ? t.slice(0, max - 1) + '…' : t
}

// resolution is the text that replaces a conflict block for the chosen side.
export function resolution(c, choice) {
  const j = a => (a.length ? a.join('\n') + '\n' : '')
  if (choice === 'ours') return j(c.ours)
  if (choice === 'theirs') return j(c.theirs)
  if (choice === 'both') return j(c.ours) + j(c.theirs)
  if (choice === 'both-rev') return j(c.theirs) + j(c.ours)
  if (choice === 'base') return j(c.base || [])
  throw new Error('unknown choice ' + choice)
}

// resolveAll applies one choice to every conflict, last to first so offsets stay valid.
export function resolveAll(text, choice) {
  let out = text
  for (const c of findConflicts(text).reverse()) out = out.slice(0, c.start) + resolution(c, choice) + out.slice(c.end)
  return out
}
