// The commit graph: lane assignment and the per-row SVG.
export const LANE = 12, HUES = 8, LOG_H = 26, HIST_H = 44
export function layoutGraph(commits) {
  const lanes = [], rows = []
  let color = 0
  const free = () => { const i = lanes.findIndex(l => !l); return i < 0 ? lanes.length : i }
  for (const c of commits) {
    const before = lanes.slice()
    let col = lanes.findIndex(l => l && l.hash === c.hash)
    if (col < 0) { col = free(); lanes[col] = { hash: c.hash, color: color++ } }
    const own = lanes[col].color
    const into = []
    lanes.forEach((l, j) => { if (l && j !== col && l.hash === c.hash) { into.push(j); lanes[j] = null } })
    const out = c.parents.map((p, k) => {
      if (k === 0) { lanes[col] = { hash: p, color: own }; return col }
      let j = lanes.findIndex(l => l && l.hash === p)
      if (j < 0) { j = free(); lanes[j] = { hash: p, color: color++ } }
      return j
    })
    if (!c.parents.length) lanes[col] = null
    while (lanes.length && !lanes[lanes.length - 1]) lanes.pop()
    rows.push({ col, color: own, before, after: lanes.slice(), into, out, merge: c.parents.length > 1 })
  }
  return rows
}

export const graphWidth = rows => LANE * Math.min(16, Math.max(1, ...rows.map(r => Math.max(r.before.length, r.after.length, r.col + 1))))
export const laneX = j => LANE / 2 + j * LANE

export function graphSVG(r, h, w) {
  const m = h / 2, cx = laneX(r.col)
  const seg = (d, color) => `<path d="${d}" class="g${color % HUES}"/>`
  const curve = (x1, y1, x2, y2) => `M${x1} ${y1}C${x1} ${(y1 + y2) / 2} ${x2} ${(y1 + y2) / 2} ${x2} ${y2}`
  let p = ''
  r.before.forEach((l, j) => {
    if (!l) return
    if (j === r.col) p += seg(`M${cx} 0V${m}`, l.color)
    else if (r.into.includes(j)) p += seg(curve(laneX(j), 0, cx, m), l.color)
    else p += seg(`M${laneX(j)} 0V${h}`, l.color)
  })
  r.out.forEach(j => { p += seg(j === r.col ? `M${cx} ${m}V${h}` : curve(cx, m, laneX(j), h), r.after[j].color) })
  return `<svg class="graph" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" aria-hidden="true">${p}<circle cx="${cx}" cy="${m}" r="3.5" class="g${r.color % HUES}${r.merge ? ' m' : ''}"/></svg>`
}

// railSVG carries the lanes below a row through a block of any height (the expanded History detail).
export function railSVG(lanes, w) {
  const p = lanes.map((l, j) => l ? `<path d="M${laneX(j)} 0V10" class="g${l.color % HUES}" vector-effect="non-scaling-stroke"/>` : '').join('')
  return `<svg class="graph rail" width="${w}" viewBox="0 0 ${w} 10" preserveAspectRatio="none" aria-hidden="true">${p}</svg>`
}

