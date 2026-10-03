import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseDiff } from './diffparse.js'
import { hunkPatch, filePatch, quotePath } from './patch.js'
import { wordRanges, pairRuns, injectMarks } from './wordiff.js'
import { reviewPrompt, noteRef, notesText } from './notes.js'

const git = (cwd, input, ...args) => execFileSync('git', ['-c', 'commit.gpgsign=false', '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, input, encoding: 'utf8' })

function repo(files) {
  const dir = mkdtempSync(join(tmpdir(), 'echo-patch-'))
  git(dir, '', 'init', '-q')
  for (const [n, c] of Object.entries(files)) writeFileSync(join(dir, n), c)
  git(dir, '', 'add', '-A'); git(dir, '', 'commit', '-q', '-m', 'base')
  return dir
}
const rows = n => Array.from({ length: n }, (_, i) => `row${i + 1}`)

test('a whole hunk stages, and unstages again', () => {
  const dir = repo({ 'f.txt': rows(30).join('\n') + '\n' })
  const next = rows(30); next[2] = 'TOP'; next[26] = 'BOTTOM'
  writeFileSync(join(dir, 'f.txt'), next.join('\n') + '\n')
  const [f] = parseDiff(git(dir, '', 'diff', '--no-color', '-U1'))
  assert.equal(f.hunks.length, 2)
  git(dir, hunkPatch(f, 0), 'apply', '--cached', '--recount', '-')
  assert.match(git(dir, '', 'diff', '--cached'), /\+TOP/)
  assert.doesNotMatch(git(dir, '', 'diff', '--cached'), /BOTTOM/)
  const [s] = parseDiff(git(dir, '', 'diff', '--cached', '--no-color', '-U1'))
  git(dir, hunkPatch(s, 0, { reverse: true }), 'apply', '--cached', '--recount', '-R', '-')
  assert.equal(git(dir, '', 'diff', '--cached'), '')
})

test('stage only some lines of a hunk', () => {
  const dir = repo({ 'g.txt': 'a\nb\nc\nd\n' })
  writeFileSync(join(dir, 'g.txt'), 'a\nB\nC\nd\nE\n')
  const [f] = parseDiff(git(dir, '', 'diff', '--no-color'))
  const h = f.hunks[0]
  // pick the -b/+B pair and nothing else
  const pick = new Set(h.lines.filter(l => (l.t === 'del' && l.text === 'b') || (l.t === 'add' && l.text === 'B')).map(l => l.i))
  git(dir, hunkPatch(f, 0, { lines: pick }), 'apply', '--cached', '--recount', '-')
  // Git lists the deletions before the additions, so a kept deletion's neighbour sits between them.
  assert.equal(git(dir, '', 'show', ':g.txt'), 'a\nc\nB\nd\n')
  assert.equal(readFileSync(join(dir, 'g.txt'), 'utf8'), 'a\nB\nC\nd\nE\n')
})

test('discard only some lines of a hunk from the working tree', () => {
  const dir = repo({ 'h.txt': 'a\nb\nc\nd\n' })
  writeFileSync(join(dir, 'h.txt'), 'a\nB\nC\nd\n')
  const [f] = parseDiff(git(dir, '', 'diff', '--no-color'))
  const pick = new Set(f.hunks[0].lines.filter(l => l.text === 'C' || l.text === 'c').map(l => l.i))
  git(dir, hunkPatch(f, 0, { lines: pick, reverse: true }), 'apply', '--recount', '-R', '-')
  assert.equal(readFileSync(join(dir, 'h.txt'), 'utf8'), 'a\nc\nB\nd\n')
})

test('unstage only some lines of a staged hunk', () => {
  const dir = repo({ 'u.txt': 'a\nb\nc\n' })
  writeFileSync(join(dir, 'u.txt'), 'A\nb\nC\n')
  git(dir, '', 'add', 'u.txt')
  const [f] = parseDiff(git(dir, '', 'diff', '--cached', '--no-color'))
  const pick = new Set(f.hunks[0].lines.filter(l => l.text === 'C' || l.text === 'c').map(l => l.i))
  git(dir, hunkPatch(f, 0, { lines: pick, reverse: true }), 'apply', '--cached', '--recount', '-R', '-')
  assert.equal(git(dir, '', 'show', ':u.txt'), 'A\nb\nc\n')
})

test('part of a new file can be staged', () => {
  const dir = repo({ 'base.txt': 'x\n' })
  writeFileSync(join(dir, 'new.txt'), 'l1\nl2\nl3\n')
  let text = ''
  try { git(dir, '', 'diff', '--no-index', '--no-color', '--', '/dev/null', 'new.txt') } catch (e) { text = e.stdout }
  const [f] = parseDiff(text)
  assert.equal(f.isNew, true)
  const pick = new Set(f.hunks[0].lines.filter(l => l.text !== 'l3').map(l => l.i))
  git(dir, hunkPatch(f, 0, { lines: pick }), 'apply', '--cached', '--recount', '-')
  assert.equal(git(dir, '', 'show', ':new.txt'), 'l1\nl2\n')
})

test('a file without a trailing newline keeps its marker', () => {
  const dir = repo({ 'n.txt': 'a\nb' })
  writeFileSync(join(dir, 'n.txt'), 'a\nB')
  const [f] = parseDiff(git(dir, '', 'diff', '--no-color'))
  git(dir, filePatch(f), 'apply', '--cached', '--recount', '-')
  assert.equal(git(dir, '', 'show', ':n.txt'), 'a\nB')
})

test('a patch with nothing selected is null', () => {
  const [f] = parseDiff('diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n')
  assert.equal(hunkPatch(f, 0, { lines: new Set() }), null)
})

test('names with unusual bytes are quoted like Git quotes them', () => {
  assert.equal(quotePath('a b.txt'), 'a b.txt')
  assert.equal(quotePath('é.txt'), '"\\303\\251.txt"')
  assert.equal(quotePath('q"x'), '"q\\"x"')
})

test('word ranges mark only what changed', () => {
  const r = wordRanges('const total = price * qty', 'const total = price * quantity')
  assert.deepEqual(r.a, [[22, 25]])
  assert.deepEqual(r.b, [[22, 30]])
  assert.equal(wordRanges('alpha beta gamma', 'zzz yyy xxx'), null)
})

test('runs of deletions and additions pair up', () => {
  const lines = [{ t: 'del', text: 'a x' }, { t: 'del', text: 'b y' }, { t: 'add', text: 'a X' }, { t: 'add', text: 'b Y' }, { t: 'ctx', text: 'c' }]
  const p = pairRuns(lines)
  assert.equal(p.length, 2)
  assert.equal(p[0][1].text, 'a X')
})

test('marks nest properly around highlight tags and entities', () => {
  const html = '<span class="k">if</span> (a &amp;&amp; b)'
  assert.equal(injectMarks(html, [[1, 4]]), '<span class="k">i<mark class="wd">f</mark></span><mark class="wd"> (</mark>a &amp;&amp; b)')
  assert.equal(injectMarks('x &lt; y', [[2, 3]]), 'x <mark class="wd">&lt;</mark> y')
  assert.equal(injectMarks('plain', []), 'plain')
})

test('the review prompt carries paths, lines, notes and ground rules', () => {
  const notes = [
    { path: 'src/b.go', line: 7, text: 'Why a global?', code: 'var cache = map[string]int{}' },
    { path: 'src/a.go', line: 42, text: 'Handle the error.\nDo not ignore it.', code: 'x, _ := f()' },
    { path: 'src/a.go', line: 3, side: 'old', text: 'Put this back', done: false },
    { path: 'src/a.go', line: 10, end: 14, text: 'Extract this block', code: 'for ...' },
    { path: 'src/d.go', line: 0, text: 'Add tests for this file' },
    { path: 'src/c.go', line: 1, text: 'resolved already', done: true },
  ]
  const p = reviewPrompt({ repo: 'echo', branch: 'main', notes })
  assert.match(p, /left 5 comments/)
  assert.match(p, /1\. src\/a\.go:3 \(removed line\)/)
  assert.match(p, /2\. src\/a\.go:10-14/)
  assert.match(p, /3\. src\/a\.go:42/)
  assert.match(p, /> x, _ := f\(\)/)
  assert.match(p, /src\/b\.go:7/)
  assert.match(p, /src\/d\.go \(whole file\)\n   Add tests/)
  assert.doesNotMatch(p, /resolved already/)
  assert.doesNotMatch(p, /Rejected|Accepted/)
  assert.match(p, /Do not commit, stage, unstage or discard/)
  assert.equal(noteRef({ path: 'a', line: 4, end: 6 }), 'a:4-6')
  assert.match(notesText([notes[0]]), /^1\. src\/b\.go:7\n   > var cache/)
})
