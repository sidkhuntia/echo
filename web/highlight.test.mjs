// Tests for the highlighter wrapper: node --test web/highlight.test.mjs
//
// The property that matters is that highlighting never changes the text: stripping the spans back
// out has to give the original back byte for byte, in every language and in the per-line form.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { highlight, highlightLines } from './highlight.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const strip = html => html.replace(/<span [^>]*>|<\/span>/g, '')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&amp;/g, '&')
const balanced = r => (r.match(/<span /g) || []).length === (r.match(/<\/span>/g) || []).length

test('leaves the text alone', () => {
  for (const name of ['main.go', 'web/app.js', 'web/style.css', 'web/index.html', 'README.md', 'go.mod']) {
    const code = readFileSync(join(root, name), 'utf8')
    const rows = highlightLines(code, name)
    if (!rows) continue
    assert.ok(rows.every(balanced), name)
    assert.equal(rows.map(strip).join('\n'), code, name)
  }
})

test('colors a language by file name, and every row stands alone', () => {
  const rows = highlightLines('a /* x\ny */ b', 'src/a.go')
  assert.equal(rows.length, 2)
  assert.ok(rows.every(balanced))
  assert.ok(rows[1].includes('hljs-comment'))
  assert.notEqual(highlightLines('all:', 'Makefile'), null)
  assert.notEqual(highlightLines('x = 1', 'a.py'), null)
  assert.ok(highlightLines('server.port=8080', 'src/main/resources/application.properties')[0].includes('hljs-attr'))
})

test('an unknown or absent language comes back untouched', () => {
  assert.equal(highlight('anything', 'brainfuck'), null)
  assert.equal(highlight('anything', ''), null)
  assert.equal(highlight('anything', undefined), null)
  assert.equal(highlightLines('x', 'notes.unknownext'), null)
})

test('reads a language off what a fence actually says', () => {
  for (const tag of ['go', 'GO', '{.go}', 'go title="x.go"', 'go ', 'golang', 'js', 'sh', 'yml'])
    assert.notEqual(highlight('var a = 1', tag), null, tag)
  assert.equal(highlight('var a = 1', '{not-a-language}'), null)
})

test('a block too big to color is left alone', () => {
  assert.equal(highlight('x'.repeat(200001), 'go'), null)
})

import { overlay } from './highlight.js'
import { position, offsetOf, alignLine, groupTokens } from './lsp.js'

test('overlay wraps text only, keeps entities whole and nests inside hljs spans', () => {
  assert.equal(overlay('foo(bar)', [{ start: 0, end: 3, cls: 'x' }]), '<span class="x">foo</span>(bar)')
  // &lt; is one character: "a<b" has b at offset 2.
  assert.equal(overlay('a&lt;b', [{ start: 2, end: 3, cls: 'x' }]), 'a&lt;<span class="x">b</span>')
  assert.equal(overlay('a&lt;b', [{ start: 1, end: 2, cls: 'x' }]), 'a<span class="x">&lt;</span>b')
  // A token inside an hljs span stays inside it; one across tags splits at them.
  assert.equal(overlay('<span class="k">func</span> main', [{ start: 5, end: 9, cls: 'x' }]), '<span class="k">func</span> <span class="x">main</span>')
  assert.equal(overlay('<span class="k">ab</span>cd', [{ start: 1, end: 3, cls: 'x' }]), '<span class="k">a<span class="x">b</span></span><span class="x">c</span>d')
  assert.equal(overlay('a', []), 'a')
})

test('lsp positions are UTF-16 offsets and clamp to the line', () => {
  const t = 'ab\n😀cd\nxyz'
  assert.deepEqual(position(t, 3), { line: 1, character: 0 })
  assert.deepEqual(position(t, 5), { line: 1, character: 2 }) // after the emoji's two units
  assert.equal(offsetOf(t, 1, 2), 5)
  assert.equal(offsetOf(t, 0, 99), 2)
  assert.equal(offsetOf(t, 9, 0), t.length)
})

test('semantic lines stay aligned across one edit', () => {
  const old = ['a', 'b', 'c', 'd'], now = ['a', 'new', 'b', 'c', 'd']
  assert.equal(alignLine(old, now, 0), 0)
  assert.equal(alignLine(old, now, 1), -1)
  assert.equal(alignLine(old, now, 2), 1)
  assert.equal(alignLine(old, now, 4), 3)
})

test('groupTokens keeps the classes highlight.js cannot tell apart', () => {
  const legend = ['keyword', 'function', 'variable'], mods = ['readonly']
  const by = groupTokens([0, 0, 4, 0, 0, 1, 2, 3, 1, 0, 1, 7, 2, 2, 1], legend, mods)
  assert.equal(by.get(0), undefined)
  assert.deepEqual(by.get(1), [{ start: 2, end: 5, cls: 'sem-fn' }, { start: 7, end: 9, cls: 'sem-const' }])
})
