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
