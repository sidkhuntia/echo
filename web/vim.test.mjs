import test from 'node:test'
import assert from 'node:assert/strict'
import { newVim, feed } from './vim.js'

// run feeds keys like a user would: in insert mode, plain characters are typed into the text.
function run(text, keys, at = 0, vs = newVim()) {
  let t = text, s = at, e = at
  const fx = []
  const toks = Array.isArray(keys) ? keys : keys.match(/C-r|Escape|<[^>]+>|./g)
  for (const k0 of toks) {
    const key = k0 === '<Esc>' ? 'Escape' : k0
    if (vs.mode === 'insert' && key !== 'Escape') { t = t.slice(0, s) + key + t.slice(e); s = e = s + key.length; continue }
    const r = feed(vs, key, t, s, e)
    if (!r) continue
    if (r.edit) t = t.slice(0, r.edit.start) + r.edit.text + t.slice(r.edit.end)
    ;[s, e] = r.sel
    fx.push(...r.fx)
  }
  return { t, s, e, vs, fx }
}

test('h j k l and counts move the cursor', () => {
  assert.equal(run('abcdef', 'lll').s, 3)
  assert.equal(run('abcdef', '3l').s, 3)
  assert.equal(run('ab\ncd\nef', 'jj').s, 6)
  assert.equal(run('abc\nd\nefg', 'llj').s, 4) // clamped to the short line
  assert.equal(run('abc\nd\nefg', 'lljj').s, 8) // and remembers the column
})

test('word motions', () => {
  assert.equal(run('foo bar baz', 'w').s, 4)
  assert.equal(run('foo bar baz', 'ww').s, 8)
  assert.equal(run('foo bar baz', 'e').s, 2)
  assert.equal(run('foo bar baz', 'wb').s, 0)
  assert.equal(run('foo.bar baz', 'w').s, 3)
  assert.equal(run('foo.bar baz', 'W').s, 8)
})

test('line motions and gg G', () => {
  assert.equal(run('  abc def', '$').s, 8)
  assert.equal(run('  abc def', '^').s, 2)
  assert.equal(run('  abc def', '$0').s, 0)
  assert.equal(run('a\nb\nc', 'G').s, 4)
  assert.equal(run('a\nb\nc', 'Ggg').s, 0)
  assert.equal(run('a\nb\nc', '2G').s, 2)
})

test('x X and ~ and r', () => {
  assert.equal(run('abc', 'x').t, 'bc')
  assert.equal(run('abc', '2x').t, 'c')
  assert.equal(run('abc', 'lX').t, 'bc')
  assert.equal(run('abc', '~~').t, 'ABc')
  assert.equal(run('abc', 'rz').t, 'zbc')
  assert.equal(run('abcd', '3rz').t, 'zzzd')
})

test('d with motions and dd', () => {
  assert.equal(run('foo bar baz', 'dw').t, 'bar baz')
  assert.equal(run('foo bar baz', 'wdw').t, 'foo baz')
  assert.equal(run('foo bar baz', 'd$').t, '')
  assert.equal(run('foo bar baz', 'wd0').t, 'bar baz')
  assert.equal(run('a\nb\nc\n', 'dd').t, 'b\nc\n')
  assert.equal(run('a\nb\nc\n', '2dd').t, 'c\n')
  assert.equal(run('a\nb\nc\n', 'dj').t, 'c\n')
  assert.equal(run('a\nb\nc', 'jdd').t, 'a\nc')
  assert.equal(run('one two', 'de').t, ' two')
  assert.equal(run('f(a, b) x', 'ldf)').t, 'f x')
})

test('cw, cc and c$ enter insert mode', () => {
  const r = run('foo bar', 'cwX<Esc>')
  assert.equal(r.t, 'X bar')
  assert.equal(r.vs.mode, 'normal')
  assert.equal(run('a b\nc d\n', 'ccX<Esc>').t, 'X\nc d\n')
  assert.equal(run('abc def', 'wC!<Esc>').t, 'abc !')
  assert.equal(run('abcdef', 'lllcl--<Esc>').t, 'abc--ef')
})

test('yank and put', () => {
  assert.equal(run('a\nb\n', 'yyp').t, 'a\na\nb\n')
  assert.equal(run('a\nb\n', 'yyP').t, 'a\na\nb\n')
  assert.equal(run('a\nb\n', 'jyyk2p').t, 'a\nb\nb\nb\n')
  assert.equal(run('ab', 'xp').t, 'ba')
  assert.equal(run('foo bar', 'yw$p').t, 'foo barfoo ')
  assert.deepEqual(run('foo', 'yw').fx.map(f => f.yank), ['foo'])
})

test('open lines, append and insert variants', () => {
  assert.equal(run('a\nb', 'ox<Esc>').t, 'a\nx\nb')
  assert.equal(run('  a\nb', 'Ox<Esc>').t, '  x\n  a\nb')
  assert.equal(run('abc', 'Ax<Esc>').t, 'abcx')
  assert.equal(run('abc', 'ix<Esc>').t, 'xabc')
  assert.equal(run('abc', 'ax<Esc>').t, 'axbc')
  assert.equal(run('  abc', 'Ix<Esc>').t, '  xabc')
  assert.equal(run('abc', 'ix<Esc>').s, 0)
})

test('join, indent and outdent lines', () => {
  assert.equal(run('a\n  b\nc', 'J').t, 'a b\nc')
  assert.equal(run('a\nb', '>>').t, '\ta\nb')
  assert.equal(run('\ta\nb', '<<').t, 'a\nb')
  assert.equal(run('a\nb\nc', '>j').t, '\ta\n\tb\nc')
})

test('f t ; , find characters on the line', () => {
  assert.equal(run('a,b,c', 'f,').s, 1)
  assert.equal(run('a,b,c', 'f,;').s, 3)
  assert.equal(run('a,b,c', 'f,;,').s, 1)
  assert.equal(run('a,b,c', 't,').s, 0)
  assert.equal(run('a,b,c', 'dt,').t, ',b,c')
  assert.equal(run('a,b,c', '$F,').s, 3)
})

test('visual mode selects, operates and cancels', () => {
  const v = run('hello world', 'vl')
  assert.deepEqual([v.s, v.e], [0, 2])
  assert.equal(run('hello world', 'vlld').t, 'lo world')
  assert.equal(run('hello world', 'vey$p').t, 'hello worldhello')
  assert.equal(run('a\nb\nc', 'Vjd').t, 'c')
  assert.equal(run('a\nb\nc', 'Vj>').t, '\ta\n\tb\nc')
  assert.equal(run('hello', 'vl<Esc>').vs.mode, 'normal')
  assert.equal(run('abc', 'vlc!<Esc>').t, '!c')
})

test('percent jumps between brackets', () => {
  assert.equal(run('f(a(b)c)', 'l%').s, 7)
  assert.equal(run('f(a(b)c)', 'l%%').s, 1)
  assert.equal(run('f(a(b)c)', 'ld%').t, 'f')
})

test('paragraph motions', () => {
  assert.equal(run('a\nb\n\nc\nd', '}').s, 4)
  assert.equal(run('a\nb\n\nc\nd', 'G{').s, 4)
})

test('dot repeats the last change', () => {
  assert.equal(run('abcdef', 'x.').t, 'cdef')
  assert.equal(run('a b c d', 'dw.').t, 'c d')
  assert.equal(run('a\nb\nc\nd\n', 'dd.').t, 'c\nd\n')
  assert.equal(run('abc', 'rxl.').t, 'xxc')
})

test('undo, redo, search, ex and star are handed to the browser', () => {
  assert.deepEqual(run('a', 'u').fx, [{ undo: true }])
  assert.deepEqual(run('a', ['C-r']).fx, [{ redo: true }])
  assert.deepEqual(run('a', '/').fx, [{ search: true }])
  assert.deepEqual(run('a', 'n').fx, [{ searchNext: 1 }])
  assert.deepEqual(run('a', ':').fx, [{ ex: true }])
  assert.deepEqual(run('foo bar', '*').fx, [{ searchWord: 'foo' }])
})

test('Escape leaves insert mode with the cursor on the last typed character', () => {
  const r = run('', 'iab<Esc>')
  assert.equal(r.t, 'ab')
  assert.equal(r.s, 1)
  assert.equal(r.vs.mode, 'normal')
})
