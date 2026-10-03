// A small Vim engine. It is pure: given the text, the cursor and a key, it says what to change and
// where the cursor goes. The DOM glue (vimui.js) applies the result to the textarea.
//
// Covered: counts; h j k l w b e W B E 0 ^ $ gg G { } % f t F T ; ,; operators d c y > < with motions and
// doubled (dd, cc, yy, >>, <<); x X s S D C Y p P J ~ r; i a I A o O; u and Ctrl-r (handed to the
// browser); v and V; . to repeat the last change; / n N * for search and : for w, q, wq and line numbers.

export const newVim = () => ({ mode: 'normal', op: null, count: '', wait: '', reg: { text: '', line: false }, find: null, col: null, anchor: 0, cur: 0, dot: null, rec: null, insFrom: 0 })

const isWord = c => /[\w$]/.test(c)
const cls = (c, big) => !c || /\s/.test(c) ? 0 : big ? 1 : isWord(c) ? 1 : 2
const ls = (t, i) => t.lastIndexOf('\n', i - 1) + 1
const le = (t, i) => { const n = t.indexOf('\n', i); return n < 0 ? t.length : n }
const firstNonBlank = (t, i) => { const a = ls(t, i); let k = a; while (k < le(t, a) && /[ \t]/.test(t[k])) k++; return k }
const lineNo = (t, i) => { let n = 0; for (let k = t.indexOf('\n'); k >= 0 && k < i; k = t.indexOf('\n', k + 1)) n++; return n }
const lineAt = (t, n) => { let p = 0; for (let i = 0; i < n; i++) { const k = t.indexOf('\n', p); if (k < 0) return ls(t, t.length); p = k + 1 } return p }
const lastLineStart = t => ls(t, t.length)
// In normal mode the cursor sits on a character, never past the last one of a line.
const clampNormal = (t, i) => { const e = le(t, i), a = ls(t, i); return Math.max(a, Math.min(i, e > a ? e - 1 : a)) }

function wordFwd(t, i, big) {
  const c0 = cls(t[i], big)
  let k = i
  if (c0) while (k < t.length && cls(t[k], big) === c0) k++
  while (k < t.length && cls(t[k], big) === 0 && !(t[k] === '\n' && t[k + 1] === '\n' && k > i)) k++
  return k
}
function wordBack(t, i, big) {
  let k = i - 1
  while (k > 0 && cls(t[k], big) === 0) k--
  const c0 = cls(t[k], big)
  while (k > 0 && cls(t[k - 1], big) === c0 && c0) k--
  return Math.max(0, k)
}
function wordEnd(t, i, big) {
  let k = i + 1
  while (k < t.length && cls(t[k], big) === 0) k++
  const c0 = cls(t[k], big)
  while (k + 1 < t.length && cls(t[k + 1], big) === c0 && c0) k++
  return Math.min(k, Math.max(0, t.length - 1))
}
function para(t, i, dir) {
  let ln = lineNo(t, i)
  const lines = t.split('\n')
  ln += dir
  while (ln >= 0 && ln < lines.length && lines[ln].trim() === '') ln += dir
  while (ln >= 0 && ln < lines.length && lines[ln].trim() !== '') ln += dir
  if (ln < 0) return 0
  if (ln >= lines.length) return t.length
  return lineAt(t, ln)
}
const PAIR = { '(': ')', '[': ']', '{': '}' }, BACK = { ')': '(', ']': '[', '}': '{' }
function matchPair(t, i) {
  let k = i
  while (k < le(t, i) && !(t[k] in PAIR) && !(t[k] in BACK)) k++
  const ch = t[k]
  if (!(ch in PAIR) && !(ch in BACK)) return -1
  let depth = 0
  if (ch in PAIR) { for (let p = k; p < t.length; p++) { if (t[p] === ch) depth++; else if (t[p] === PAIR[ch] && --depth === 0) return p } }
  else for (let p = k; p >= 0; p--) { if (t[p] === ch) depth++; else if (t[p] === BACK[ch] && --depth === 0) return p }
  return -1
}

// motion returns where a motion lands: { to, linewise, inclusive }, or null when it cannot move.
function motion(vs, t, pos, key, n, wantCol) {
  const count = n || 1
  const col = pos - ls(t, pos)
  switch (key) {
    case 'h': return { to: Math.max(ls(t, pos), pos - count) }
    case 'l': return { to: Math.min(le(t, pos), pos + count) }
    case 'j': case 'k': {
      const ln = lineNo(t, pos), total = t.split('\n').length, target = key === 'j' ? Math.min(total - 1, ln + count) : Math.max(0, ln - count)
      if (target === ln) return null
      const a = lineAt(t, target), c = wantCol ?? col
      return { to: Math.min(a + c, le(t, a)), linewise: true, keepCol: true }
    }
    case 'w': case 'W': { let p = pos; for (let i = 0; i < count; i++) p = wordFwd(t, p, key === 'W'); return { to: Math.min(p, t.length) } }
    case 'b': case 'B': { let p = pos; for (let i = 0; i < count; i++) p = wordBack(t, p, key === 'B'); return { to: p } }
    case 'e': case 'E': { let p = pos; for (let i = 0; i < count; i++) p = wordEnd(t, p, key === 'E'); return { to: p, inclusive: true } }
    case '0': return { to: ls(t, pos) }
    case '^': return { to: firstNonBlank(t, pos) }
    case '$': { let p = pos; for (let i = 1; i < count; i++) { const e = le(t, p); if (e >= t.length) break; p = e + 1 } return { to: Math.max(ls(t, p), le(t, p) - 1), inclusive: true } }
    case 'G': return { to: n ? lineAt(t, n - 1) : lastLineStart(t), linewise: true, first: true }
    case 'gg': return { to: n ? lineAt(t, n - 1) : 0, linewise: true, first: true }
    case '}': return { to: para(t, pos, 1) }
    case '{': return { to: para(t, pos, -1) }
    case '%': { const m = matchPair(t, pos); return m < 0 ? null : { to: m, inclusive: true } }
    default: return null
  }
}

function findChar(t, pos, ch, kind, count, repeat = false) {
  const a = ls(t, pos), e = le(t, pos)
  let p = pos
  for (let i = 0; i < count; i++) {
    // Repeating a till-search from just before the character would not move, so it looks one further.
    const skip = repeat && i === 0 && ((kind === 't' && t[pos + 1] === ch) || (kind === 'T' && t[pos - 1] === ch)) ? 1 : 0
    if (kind === 'f' || kind === 't') { p = t.indexOf(ch, p + 1 + skip); if (p < 0 || p >= e) return null }
    else { p = t.lastIndexOf(ch, p - 1 - skip); if (p < a) return null }
  }
  if (kind === 't') p -= 1
  if (kind === 'T') p += 1
  return { to: p, inclusive: kind === 'f' || kind === 't' }
}

const range = (t, pos, m, op) => {
  let a = Math.min(pos, m.to), b = Math.max(pos, m.to)
  if (m.linewise) { a = ls(t, a); b = Math.min(t.length, le(t, b) + 1); return { a, b, line: true } }
  if (m.inclusive) b = Math.min(t.length, b + 1)
  return { a, b, line: false }
}

// feed handles one key. It returns { edit?, sel, mode, fx? } and updates vs.
export function feed(vs, key, text, s, e) {
  const out = { sel: [s, e], mode: vs.mode, fx: [] }
  const finish = (sel, edit) => { out.sel = sel; out.edit = edit; out.mode = vs.mode; return out }
  let t = text
  const pos0 = vs.mode === 'visual' || vs.mode === 'vline' ? vs.cur : s
  const ensureClamp = p => vs.mode === 'normal' ? clampNormal(t, p) : p

  // ---- insert mode: the browser types; only Escape comes here
  if (vs.mode === 'insert') {
    if (key === 'Escape' || key === 'C-[') {
      vs.mode = 'normal'
      if (vs.rec) { vs.rec.text = t.slice(vs.insFrom, s); vs.dot = vs.rec; vs.rec = null }
      return finish([clampNormal(t, Math.max(ls(t, s), s - 1))] .concat([clampNormal(t, Math.max(ls(t, s), s - 1))]))
    }
    return null
  }

  // ---- pending second key
  if (vs.wait) {
    const w = vs.wait; vs.wait = ''
    if (key === 'Escape') { vs.op = null; vs.count = ''; return finish([s, e]) }
    if (w === 'r') {
      const n = parseInt(vs.count || '1'); vs.count = ''
      const end = Math.min(le(t, s), s + n)
      if (end - s < n || key.length !== 1) return finish([s, e])
      vs.dot = { cmd: 'r', key, n }
      return finish([s + n - 1, s + n - 1], { start: s, end, text: key.repeat(n) })
    }
    if (w === 'g') {
      if (key === 'g') return applyMotion(vs, t, s, e, 'gg', out, finish, pos0)
      vs.op = null; vs.count = ''; return finish([s, e])
    }
    if ('fFtT'.includes(w)) {
      const n = parseInt(vs.count || '1') ; const m = findChar(t, pos0, key, w, n)
      vs.find = { kind: w, ch: key }
      if (!m) { vs.op = null; vs.count = ''; return finish([s, e]) }
      return applyResolved(vs, t, s, e, m, finish, pos0)
    }
  }

  if (key === 'Escape' || key === 'C-[') {
    vs.op = null; vs.count = ''
    if (vs.mode !== 'normal') { const p = clampNormal(t, vs.cur); vs.mode = 'normal'; return finish([p, p]) }
    return finish([s, e])
  }

  // ---- count
  if (/^[1-9]$/.test(key) || (key === '0' && vs.count)) { vs.count += key; return finish([s, e]) }
  const n = vs.count ? parseInt(vs.count) : 0

  // ---- visual mode keys that are not motions
  if (vs.mode === 'visual' || vs.mode === 'vline') {
    const a = vs.mode === 'vline' ? ls(t, Math.min(vs.anchor, vs.cur)) : Math.min(vs.anchor, vs.cur)
    const b = vs.mode === 'vline' ? Math.min(t.length, le(t, Math.max(vs.anchor, vs.cur)) + 1) : Math.min(t.length, Math.max(vs.anchor, vs.cur) + 1)
    const done = (edit, caret) => { vs.mode = 'normal'; vs.count = ''; return finish([caret, caret], edit) }
    if (key === 'v') { if (vs.mode === 'visual') return done(null, clampNormal(t, vs.cur)); vs.mode = 'visual'; return finish(visSel(vs, t)) }
    if (key === 'V') { if (vs.mode === 'vline') return done(null, clampNormal(t, vs.cur)); vs.mode = 'vline'; return finish(visSel(vs, t)) }
    if (key === 'o') { [vs.anchor, vs.cur] = [vs.cur, vs.anchor]; return finish(visSel(vs, t)) }
    const line = vs.mode === 'vline'
    if (key === 'y') { vs.reg = { text: t.slice(a, b), line }; out.fx.push({ yank: vs.reg.text }); return done(null, clampNormal(t, a)) }
    if (key === 'd' || key === 'x') { vs.reg = { text: t.slice(a, b), line }; out.fx.push({ yank: vs.reg.text }); return done({ start: a, end: b, text: '' }, clampNormal(t.slice(0, a) + t.slice(b), a)) }
    if (key === 'c' || key === 's') { vs.reg = { text: t.slice(a, b), line }; vs.mode = 'insert'; vs.insFrom = a; vs.rec = { cmd: 'ins' }; return finish([a, a], { start: a, end: line ? Math.max(a, b - (t[b - 1] === '\n' ? 1 : 0)) : b, text: '' }) }
    if (key === '>' || key === '<') return done(indentEdit(t, a, b, key === '<'), a)
    if (key === '~') return done({ start: a, end: b, text: swapCase(t.slice(a, b)) }, a)
    if (key === 'J') return done(joinEdit(t, a, b), a)
    if (key === 'p' || key === 'P') { const r = vs.reg; return done({ start: a, end: b, text: r.text }, a) }
  }

  // ---- operators
  if (vs.mode === 'normal' && (key === 'd' || key === 'c' || key === 'y' || key === '>' || key === '<') ) {
    if (vs.op === key) { // dd cc yy >> <<
      const cnt = (vs.opCount || 1) * (n || 1), a = ls(t, s), lastLn = lineNo(t, t.length)
      const endLn = Math.min(lineNo(t, s) + cnt - 1, lastLn)
      const b = Math.min(t.length, le(t, lineAt(t, endLn)) + 1)
      vs.op = null; vs.count = ''; vs.opCount = 0
      return runOp(vs, key, t, a, b, true, finish, s)
    }
    vs.op = key; vs.opCount = n; vs.count = ''
    return finish([s, e])
  }

  // ---- motions (move, or aim an operator)
  if (key === 'g') { vs.wait = 'g'; return finish([s, e]) }
  if ('fFtT'.includes(key) && key.length === 1) { vs.wait = key; return finish([s, e]) }
  if (key === ';' || key === ',') {
    if (!vs.find) return finish([s, e])
    const flip = { f: 'F', F: 'f', t: 'T', T: 't' }
    const kind = key === ';' ? vs.find.kind : flip[vs.find.kind]
    const m = findChar(t, pos0, vs.find.ch, kind, n || 1, true)
    vs.count = ''
    return m ? applyResolved(vs, t, s, e, m, finish, pos0) : finish([s, e])
  }
  const mkey = key
  const m = motion(vs, t, pos0, mkey, vs.op ? (vs.opCount || 1) * (n || 1) : n, vs.col)
  if (m) return applyResolved(vs, t, s, e, m, finish, pos0, mkey)

  // ---- normal-mode commands
  const cnt = n || 1
  vs.count = ''
  vs.op = null
  const cur = s
  const enterInsert = (pos, edit, rec) => { vs.mode = 'insert'; vs.insFrom = edit ? edit.start + (edit.text?.length || 0) : pos; vs.rec = rec; if (rec) rec.cnt = cnt; return finish([pos, pos], edit) }
  switch (key) {
    case 'i': return enterInsert(cur, null, { cmd: 'i' })
    case 'a': { const p = le(t, cur) > cur ? cur + 1 : cur; return enterInsert(p, null, { cmd: 'a' }) }
    case 'I': { const p = firstNonBlank(t, cur); return enterInsert(p, null, { cmd: 'I' }) }
    case 'A': { const p = le(t, cur); return enterInsert(p, null, { cmd: 'A' }) }
    case 'o': { const p = le(t, cur), ind = t.slice(ls(t, cur)).match(/^[ \t]*/)[0]; vs.mode = 'insert'; vs.insFrom = p + 1 + ind.length; vs.rec = { cmd: 'o' }; return finish([p + 1 + ind.length, p + 1 + ind.length], { start: p, end: p, text: '\n' + ind }) }
    case 'O': { const p = ls(t, cur), ind = t.slice(p).match(/^[ \t]*/)[0]; vs.mode = 'insert'; vs.insFrom = p + ind.length; vs.rec = { cmd: 'O' }; return finish([p + ind.length, p + ind.length], { start: p, end: p, text: ind + '\n' }) }
    case 'x': case 'X': case 's': {
      const a = key === 'X' ? Math.max(ls(t, cur), cur - cnt) : cur, b = key === 'X' ? cur : Math.min(le(t, cur), cur + cnt)
      if (a === b) return finish([cur, cur])
      vs.reg = { text: t.slice(a, b), line: false }; out.fx.push({ yank: vs.reg.text })
      if (key === 's') { vs.mode = 'insert'; vs.insFrom = a; vs.rec = { cmd: 's' }; return finish([a, a], { start: a, end: b, text: '' }) }
      vs.dot = { cmd: key, n: cnt }
      return finish([clampNormal(t.slice(0, a) + t.slice(b), a)].concat([clampNormal(t.slice(0, a) + t.slice(b), a)]), { start: a, end: b, text: '' })
    }
    case 'S': { const a = ls(t, cur), b = le(t, cur), ind = t.slice(a).match(/^[ \t]*/)[0]; vs.reg = { text: t.slice(a, b) + '\n', line: true }; vs.mode = 'insert'; vs.insFrom = a + ind.length; vs.rec = { cmd: 'S' }; return finish([a + ind.length, a + ind.length], { start: a, end: b, text: ind }) }
    case 'D': case 'C': {
      const b = le(t, cur)
      vs.reg = { text: t.slice(cur, b), line: false }; out.fx.push({ yank: vs.reg.text })
      if (key === 'C') { vs.mode = 'insert'; vs.insFrom = cur; vs.rec = { cmd: 'C' }; return finish([cur, cur], { start: cur, end: b, text: '' }) }
      vs.dot = { cmd: 'D' }
      const p = clampNormal(t.slice(0, cur) + t.slice(b), Math.max(ls(t, cur), cur - 1))
      return finish([p, p], { start: cur, end: b, text: '' })
    }
    case 'Y': return runOp(vs, 'y', t, ls(t, cur), Math.min(t.length, le(t, cur) + 1), true, finish, cur)
    case 'p': case 'P': {
      const r = vs.reg
      if (!r.text) return finish([cur, cur])
      vs.dot = { cmd: key }
      if (r.line) {
        const at = key === 'p' ? Math.min(t.length, le(t, cur) + 1) : ls(t, cur)
        const body = r.text.endsWith('\n') ? r.text : r.text + '\n'
        const prefix = at === t.length && !t.endsWith('\n') ? '\n' : ''
        const edit = { start: at, end: at, text: prefix + body.repeat(cnt) }
        const caret = firstNonBlank(t.slice(0, at) + edit.text, at + prefix.length)
        return finish([caret, caret], edit)
      }
      const at = key === 'p' ? Math.min(le(t, cur), cur + (t.length > cur ? 1 : 0)) : cur
      const body = r.text.repeat(cnt)
      return finish([at + body.length - 1, at + body.length - 1], { start: at, end: at, text: body })
    }
    case 'J': { const a = ls(t, cur), nl = le(t, cur); if (nl >= t.length) return finish([cur, cur]); vs.dot = { cmd: 'J' }; const ed = joinEdit(t, a, Math.min(t.length, le(t, nl + 1) + 1)); return finish([ed.at ?? nl, ed.at ?? nl], ed) }
    case '~': { const b = Math.min(le(t, cur), cur + cnt); if (b === cur) return finish([cur, cur]); vs.dot = { cmd: '~', n: cnt }; return finish([Math.min(b, clampNormal(t, b)), Math.min(b, clampNormal(t, b))], { start: cur, end: b, text: swapCase(t.slice(cur, b)) }) }
    case 'r': vs.count = n ? String(n) : ''; vs.wait = 'r'; return finish([s, e])
    case 'v': vs.mode = 'visual'; vs.anchor = vs.cur = cur; return finish([cur, cur + 1])
    case 'V': vs.mode = 'vline'; vs.anchor = vs.cur = cur; return finish(visSel(vs, t))
    case 'u': out.fx.push({ undo: true }); return finish([s, e])
    case 'C-r': out.fx.push({ redo: true }); return finish([s, e])
    case '/': out.fx.push({ search: true }); return finish([s, e])
    case 'n': out.fx.push({ searchNext: 1 }); return finish([s, e])
    case 'N': out.fx.push({ searchNext: -1 }); return finish([s, e])
    case '*': { const w = (t.slice(0, cur).match(/[\w$]*$/)[0] + t.slice(cur).match(/^[\w$]*/)[0]); if (w) out.fx.push({ searchWord: w }); return finish([s, e]) }
    case ':': out.fx.push({ ex: true }); return finish([s, e])
    case '.': return replayDot(vs, t, s, e, finish)
    default: return finish([s, e])
  }
}

function visSel(vs, t) {
  if (vs.mode === 'vline') return [ls(t, Math.min(vs.anchor, vs.cur)), Math.min(t.length, le(t, Math.max(vs.anchor, vs.cur)) + 1)]
  return [Math.min(vs.anchor, vs.cur), Math.min(t.length, Math.max(vs.anchor, vs.cur) + 1)]
}

function applyMotion(vs, t, s, e, key, out, finish, pos0) {
  const m = motion(vs, t, pos0, key, vs.count ? parseInt(vs.count) : 0)
  return m ? applyResolved(vs, t, s, e, m, finish, pos0, key) : finish([s, e])
}

// applyResolved either moves the cursor or, when an operator is waiting, applies it over the range.
function applyResolved(vs, t, s, e, m, finish, pos0, key) {
  vs.count = ''
  if (vs.op) {
    const op = vs.op; vs.op = null
    // cw behaves like ce
    if (op === 'c' && (key === 'w' || key === 'W') && /\S/.test(t[pos0] || '')) m = { to: wordEnd2(t, pos0, key === 'W'), inclusive: true }
    const r = range(t, pos0, m, op)
    return runOp(vs, op, t, r.a, r.b, r.line, finish, s, op === 'c' && r.line)
  }
  if (vs.mode === 'visual' || vs.mode === 'vline') {
    vs.cur = m.to
    if (!m.keepCol) vs.col = null
    return finish(visSel(vs, t))
  }
  vs.col = m.keepCol ? (vs.col ?? (pos0 - ls(t, pos0))) : null
  const p = clampNormal(t, m.first ? firstNonBlank(t, m.to) : m.to)
  return finish([p, p])
}

function wordEnd2(t, i, big) { let k = i; const c0 = cls(t[k], big); while (k + 1 < t.length && cls(t[k + 1], big) === c0) k++; return k }

function runOp(vs, op, t, a, b, line, finish, caret, keepLine) {
  const text = t.slice(a, b)
  vs.reg = { text, line }
  const fx = { yank: text }
  if (op === 'y') { const r = finish([Math.min(caret, a), Math.min(caret, a)]); r.fx.push(fx); return r }
  vs.dot = { cmd: 'op', op, a: a - caret, len: b - a, line, motionLen: b - a }
  if (op === '>' || op === '<') { const ed = indentEdit(t, a, b, op === '<'); return finish([firstNonBlank(applyEdit(t, ed), a), firstNonBlank(applyEdit(t, ed), a)], ed) }
  if (op === 'c') {
    vs.mode = 'insert'; vs.insFrom = a; vs.rec = { cmd: 'c' }
    const end = line ? Math.max(a, b - (t[b - 1] === '\n' ? 1 : 0)) : b
    const ind = line ? t.slice(a).match(/^[ \t]*/)[0] : ''
    const r = finish([a + ind.length, a + ind.length], { start: a, end, text: ind })
    r.fx.push(fx)
    return r
  }
  const after = t.slice(0, a) + t.slice(b)
  const p = clampNormal(after, line ? firstNonBlank(after, Math.min(a, after.length)) : a)
  const r = finish([p, p], { start: a, end: b, text: '' })
  r.fx.push(fx)
  return r
}

const applyEdit = (t, ed) => t.slice(0, ed.start) + ed.text + t.slice(ed.end)
const swapCase = s => [...s].map(c => c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase()).join('')
function indentEdit(t, a, b, out) {
  const lines = t.slice(a, b).split('\n')
  const trail = lines.at(-1) === '' ? lines.pop() !== undefined : false
  const res = lines.map(l => out ? l.replace(/^(\t| {1,4})/, '') : (l ? '\t' + l : l)).join('\n') + (trail ? '\n' : '')
  return { start: a, end: b, text: res }
}
function joinEdit(t, a, b) {
  const lines = t.slice(a, b).replace(/\n$/, '').split('\n')
  const joined = lines.map((l, i) => i ? l.replace(/^\s+/, '') : l).reduce((acc, l, i) => i ? (acc.endsWith(' ') || !l ? acc : acc + ' ') + l : l, '')
  const trail = t.slice(a, b).endsWith('\n') ? '\n' : ''
  return { start: a, end: b, text: joined + trail, at: a + lines[0].length }
}

function replayDot(vs, t, s, e, finish) {
  const d = vs.dot
  if (!d) return finish([s, e])
  let r
  if (d.cmd === 'x') r = feed(vs, 'x', t, s, e)
  else if (d.cmd === 'X') r = feed(vs, 'X', t, s, e)
  else if (d.cmd === 'D') r = feed(vs, 'D', t, s, e)
  else if (d.cmd === 'J') r = feed(vs, 'J', t, s, e)
  else if (d.cmd === 'p' || d.cmd === 'P') r = feed(vs, d.cmd, t, s, e)
  else if (d.cmd === '~') { vs.count = String(d.n); r = feed(vs, '~', t, s, e) }
  else if (d.cmd === 'r') { vs.count = String(d.n); feed(vs, 'r', t, s, e); r = feed(vs, d.key, t, s, e) }
  else if (d.cmd === 'op') {
    const a = s + d.a, b = a + d.len
    r = runOp(vs, d.op, t, a, b, d.line, finish, s)
  } else if (d.text !== undefined) {
    // an insert command: do the entry, then type what was typed before
    const first = feed(vs, d.cmd === 'ins' ? 'i' : d.cmd === 'c' ? 'i' : d.cmd, t, s, e)
    const base = first.edit ? applyEdit(t, first.edit) : t
    const at = first.sel[0]
    const typed = { start: at, end: at, text: d.text }
    vs.mode = 'normal'; vs.rec = null
    const text2 = applyEdit(base, typed)
    const combined = { start: first.edit ? Math.min(first.edit.start, at) : at, end: first.edit ? Math.max(first.edit.end, at) : at, text: '' }
    // express it as one edit from the original text
    const whole = { start: 0, end: t.length, text: text2 }
    const caret = Math.max(0, at + d.text.length - 1)
    const o = { sel: [caret, caret], mode: 'normal', fx: [], edit: whole }
    vs.dot = d
    return o
  }
  return r || finish([s, e])
}
