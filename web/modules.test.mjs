import test from 'node:test'
import assert from 'node:assert/strict'
import { parseDiff } from './diffparse.js'
import { lineDiff, splitLines } from './linediff.js'
import { layoutGraph } from './graph.js'

const DIFF = `diff --git a/a.txt b/a.txt
index 111..222 100644
--- a/a.txt
+++ b/a.txt
@@ -1,3 +1,3 @@ func main
 one
-two
+TWO
 three
diff --git a/old.txt b/new.txt
similarity index 90%
rename from old.txt
rename to new.txt
old mode 100644
new mode 100755
`

test('parseDiff reads hunks, lines and counts', () => {
  const [f] = parseDiff(DIFF)
  assert.equal(f.path, 'a.txt')
  assert.equal(f.added, 1)
  assert.equal(f.deleted, 1)
  assert.equal(f.hunks[0].context, 'func main')
  assert.deepEqual(f.hunks[0].lines.map(l => l.t), ['ctx', 'del', 'add', 'ctx'])
  assert.equal(f.hunks[0].lines[2].n, 2)
})

test('parseDiff reads renames and mode changes', () => {
  const f = parseDiff(DIFF)[1]
  assert.equal(f.path, 'new.txt')
  assert.equal(f.renamedFrom, 'old.txt')
  assert.deepEqual(f.mode, { from: '100644', to: '100755' })
  assert.equal(f.hunks.length, 0)
})

test('lineDiff marks added, modified and deleted lines', () => {
  const a = splitLines('a\nb\nc\n'), b = splitLines('a\nB\nc\nd\n')
  const { marks } = lineDiff(a, b)
  assert.equal(marks[1], 'mod')
  assert.equal(marks[3], 'add')
  assert.equal(marks[0], undefined)
  assert.equal(lineDiff(['x', 'y'], ['x']).dels.has(1), true)
})

test('layoutGraph gives a merge two parents on different lanes', () => {
  const rows = layoutGraph([
    { hash: 'm', parents: ['a', 'b'] }, { hash: 'a', parents: ['r'] }, { hash: 'b', parents: ['r'] }, { hash: 'r', parents: [] },
  ])
  assert.equal(rows[0].merge, true)
  assert.notEqual(rows[0].out[0], rows[0].out[1])
  assert.equal(rows.length, 4)
})

import { findConflicts, findIncomplete, hasMarkers, conflictLines, excerpt, resolution, resolveAll } from './conflicts.js'

const CONFLICT = 'top\n<<<<<<< HEAD\nmine 1\nmine 2\n=======\ntheirs\n>>>>>>> feature\nmiddle\n<<<<<<< HEAD\nx\n||||||| base\nb\n=======\ny\n>>>>>>> feature\nend\n'

test('conflict blocks are found with their sides and labels', () => {
  const cs = findConflicts(CONFLICT)
  assert.equal(cs.length, 2)
  assert.deepEqual(cs[0].ours, ['mine 1', 'mine 2'])
  assert.deepEqual(cs[0].theirs, ['theirs'])
  assert.equal(cs[0].oursLabel, 'HEAD')
  assert.equal(cs[0].theirsLabel, 'feature')
  assert.deepEqual(cs[1].base, ['b'])
  assert.equal(CONFLICT.slice(cs[0].start, cs[0].end).startsWith('<<<<<<< HEAD'), true)
  assert.equal(CONFLICT.slice(cs[0].start, cs[0].end).endsWith('>>>>>>> feature\n'), true)
})

test('each side can be taken, and all at once', () => {
  const [c] = findConflicts(CONFLICT)
  assert.equal(resolution(c, 'ours'), 'mine 1\nmine 2\n')
  assert.equal(resolution(c, 'theirs'), 'theirs\n')
  assert.equal(resolution(c, 'both'), 'mine 1\nmine 2\ntheirs\n')
  assert.equal(resolveAll(CONFLICT, 'theirs'), 'top\ntheirs\nmiddle\ny\nend\n')
  assert.equal(findConflicts('plain text\n').length, 0)
  assert.equal(findConflicts('<<<<<<< a\nno end\n').length, 0)
})

test('longer markers and stray whitespace still parse', () => {
  const t = 'a\n<<<<<<<< HEAD\nx\n========= \n y\n>>>>>>>> feature  \n'
  const cs = findConflicts(t)
  assert.equal(cs.length, 1)
  assert.equal(cs[0].oursLabel, 'HEAD')
  assert.equal(hasMarkers(t), true)
  assert.equal(findIncomplete(t), -1)
})

test('an unterminated marker is reported, not silently dropped', () => {
  const t = 'ok\n<<<<<<< HEAD\nmine\n'
  assert.equal(findConflicts(t).length, 0)
  assert.equal(findIncomplete(t), 1)
  assert.equal(hasMarkers(t), false)
  assert.equal(conflictLines(CONFLICT).has(1), true)
  assert.equal(excerpt(['', '  hello  ']), 'hello')
})
