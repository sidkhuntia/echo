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
