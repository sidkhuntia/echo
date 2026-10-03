// Merge conflict markers in a file's text: where each conflict is, and what taking a side leaves.

const START = /^<{7}(?: (.*))?$/, MID = /^={7}$/, END = /^>{7}(?: (.*))?$/, BASE = /^\|{7}(?: (.*))?$/

// findConflicts returns every complete conflict block, with character offsets into text.
export function findConflicts(text) {
  const out = []
  const lines = text.split('\n')
  let off = 0, cur = null, part = 'ours'
  lines.forEach((line, i) => {
    const len = line.length + 1
    let m
    if (!cur && (m = line.match(START))) cur = { start: off, startLine: i, ours: [], base: null, theirs: [], oursLabel: m[1] || '', theirsLabel: '' }, part = 'ours'
    else if (cur && part === 'ours' && BASE.test(line)) { part = 'base'; cur.base = [] }
    else if (cur && part !== 'theirs' && MID.test(line)) part = 'theirs'
    else if (cur && part === 'theirs' && (m = line.match(END))) {
      cur.end = off + len; cur.endLine = i; cur.theirsLabel = m[1] || ''
      out.push(cur); cur = null
    } else if (cur) cur[part].push(line)
    off += len
  })
  return out.map(c => ({ ...c, end: Math.min(c.end, text.length) }))
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
