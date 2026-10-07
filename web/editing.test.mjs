import test from 'node:test'
import assert from 'node:assert/strict'
import { detectIndent, indentUnit, indentLines, enterEdit, toggleComment, moveLines, duplicateLines, deleteLines, matchBracket, enclosingScopes, parseCSV, lineSpan, recordSave } from './editing.js'

const apply = (t, ed) => t.slice(0, ed.start) + ed.text + t.slice(ed.end)

test('indent is detected from the file', () => {
  assert.deepEqual(detectIndent('a\n  b\n    c\n  d\n'), { tabs: false, size: 2 })
  assert.deepEqual(detectIndent('a\n\tb\n\t\tc\n'), { tabs: true, size: 4 })
  assert.equal(detectIndent('no indent\nat all\n'), null)
  assert.equal(indentUnit({ indent: 'auto' }, { tabs: true, size: 4 }), '\t')
  assert.equal(indentUnit({ indent: 'spaces', tabSize: 2 }, { tabs: true }), '  ')
  assert.equal(indentUnit({}, null), '    ')
})

test('Tab and Shift-Tab indent and outdent whole lines', () => {
  const t = 'a\nb\nc\n'
  assert.equal(apply(t, indentLines(t, 0, 3, '  ')), '  a\n  b\nc\n')
  const u = '  a\n  b\nc\n'
  assert.equal(apply(u, indentLines(u, 0, 5, '  ', true)), 'a\nb\nc\n')
  assert.equal(apply('x', indentLines('x', 0, 0, '\t')), '\tx')
})

test('Enter keeps the indentation and goes deeper after an opening bracket', () => {
  assert.equal(apply('  foo(', enterEdit('  foo(', 6, 6, '  ')), '  foo(\n    ')
  assert.equal(apply('  x', enterEdit('  x', 3, 3, '  ')), '  x\n  ')
  const pair = 'if (a) {}'
  const ed = enterEdit(pair, 8, 8, '  ')
  assert.equal(apply(pair, ed), 'if (a) {\n  \n}')
  assert.equal(ed.selStart, 'if (a) {\n  '.length)
  assert.equal(apply('def f():', enterEdit('def f():', 8, 8, '    ')), 'def f():\n    ')
})

test('comments toggle on and off by language', () => {
  const on = toggleComment('a\n  b\n', 0, 6, 'x.go')
  assert.equal(apply('a\n  b\n', on), '// a\n//   b\n')
  assert.equal(apply('// a\n//   b\n', toggleComment('// a\n//   b\n', 0, 12, 'x.go')), 'a\n  b\n')
  assert.equal(apply('<p>x</p>', toggleComment('<p>x</p>', 0, 0, 'a.html')), '<!-- <p>x</p> -->')
  assert.equal(apply('<!-- <p>x</p> -->', toggleComment('<!-- <p>x</p> -->', 0, 0, 'a.html')), '<p>x</p>')
  assert.equal(toggleComment('x', 0, 0, 'file.unknownext'), null)
  assert.equal(apply('k: v\n', toggleComment('k: v\n', 0, 0, 'c.yml')), '# k: v\n')
})

test('lines move and duplicate and delete', () => {
  const t = 'one\ntwo\nthree\n'
  assert.equal(apply(t, moveLines(t, 4, 4, -1)), 'two\none\nthree\n')
  assert.equal(apply(t, moveLines(t, 4, 4, 1)), 'one\nthree\ntwo\n')
  assert.equal(moveLines(t, 0, 0, -1), null)
  assert.equal(apply(t, duplicateLines(t, 4, 4, 1)), 'one\ntwo\ntwo\nthree\n')
  assert.equal(apply(t, duplicateLines(t, 4, 4, -1)), 'one\ntwo\ntwo\nthree\n')
  assert.equal(apply(t, deleteLines(t, 4, 4)), 'one\nthree\n')
  assert.equal(apply('a\nb', deleteLines('a\nb', 2, 2)), 'a')
  assert.deepEqual(lineSpan('ab\ncd\n', 0, 3), [0, 3])
  assert.equal(apply('a\nb', moveLines('a\nb', 0, 0, 1)), 'b\na')
})

test('brackets pair up across lines and nesting', () => {
  const t = 'f(a, (b), c) { x }'
  assert.equal(matchBracket(t, 1), 11)
  assert.equal(matchBracket(t, 12), 1)
  assert.equal(matchBracket(t, 14), 17)
  assert.equal(matchBracket('(unclosed', 0), -1)
  assert.equal(matchBracket('none', 2), -1)
})

test('the enclosing scope of a line is found by indentation', () => {
  const lines = ['package x', '', 'type T struct {', '\tA int', '}', '', 'func (t T) Run() {', '\tif x {', '\t\tdo()', '\t}', '}']
  assert.deepEqual(enclosingScopes(lines, 8).map(s => s.text), ['func (t T) Run() {'])
  assert.deepEqual(enclosingScopes(lines, 6).map(s => s.text), ['func (t T) Run() {'])
  assert.deepEqual(enclosingScopes(lines, 1).map(s => s.text), [])
  assert.deepEqual(enclosingScopes(lines, 3).map(s => s.text), ['type T struct {'])
  const py = ['class A:', '    def m(self):', '        return 1']
  assert.deepEqual(enclosingScopes(py, 2).map(s => s.text), ['class A:', 'def m(self):'])
})

test('csv reads quotes, escaped quotes and tabs', () => {
  assert.deepEqual(parseCSV('a,"b,c",d\n1,"say ""hi""",3\n'), [['a', 'b,c', 'd'], ['1', 'say "hi"', '3']])
  assert.deepEqual(parseCSV('a\tb\r\nc\td', '\t'), [['a', 'b'], ['c', 'd']])
})

test('a save records what it sent, so typing during the request stays unsaved', () => {
  // saveFile sends tab.content, then the editor keeps changing tab.content while the request is in flight.
  const tab = { content: 'one', saved: 'old', hash: 'h0', conflict: 'changed' }
  const sent = tab.content
  tab.content = 'one two' // typed while the POST is in flight
  assert.equal(recordSave(tab, sent, 'h1'), true)
  assert.equal(tab.saved, 'one')
  assert.equal(tab.hash, 'h1')
  assert.equal(tab.conflict, '')
  const clean = { content: 'x', saved: 'y', hash: 'h0', conflict: '' }
  assert.equal(recordSave(clean, clean.content, 'h2'), false)
  assert.equal(clean.saved, 'x')
})
