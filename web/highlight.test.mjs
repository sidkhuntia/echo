// Tests for the preview's code highlighter: node --test web/highlight.test.mjs
//
// The property that matters is that highlighting never changes the text. A block is shown as it
// was written, only colored, so stripping the spans back out has to give the original back byte
// for byte; a dropped quote or a lost space is a wrong preview, not a cosmetic one.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, extname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { highlight } from './highlight.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const deHighlight = html => html.replace(/<span class="[^"]*">|<\/span>/g, '')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')

const roundTrip = (code, lang) => assert.equal(deHighlight(highlight(code, lang)), code)
const has = (html, cls) => assert.ok(html.includes(`class="${cls}"`), `${cls} missing in ${html.slice(0, 60)}`)

test('leaves the text alone', () => {
  const blocks = {
    go: 'package main\n\nimport "fmt"\n\n// f runs it.\nfunc f(s string) error {\n\treturn fmt.Errorf("%s", s)\n}',
    javascript: 'const re = /a+b/gi\nexport default class A extends B { #p = `x ${this.y}` }\n',
    json: '{"a": [1, true, null], "b": {"c": "d"}}',
    yaml: "name: echo\nrun: echo \"hi\"  # now\n",
    sh: 'set -eu\nDIR="$(cd "$(dirname "$0")" && pwd)" # where\n',
    html: '<!doctype html>\n<html lang="en">\n  <!-- c -->\n  <body class=\'a\' data-x="1">&amp;</body>\n</html>',
    css: '@media (min-width: 40em) { .a > b { color: #fff; margin: 0 auto } }',
    sql: "SELECT id FROM users WHERE name LIKE '%a%';",
    diff: '--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new\n',
    md: '# Title\n\n- **bold** `code` [x](y)\n\n```go\nvar a = 1\n```\n',
    rust: 'fn f<T: Into<String>>(x: T) -> Result<(), Error> { Ok(()) }',
    python: 'def f(x: int = 3) -> str:\n    return f"{x!r}"  # done\n',
  }
  for (const [lang, code] of Object.entries(blocks)) roundTrip(code, lang)
})

test('leaves the text alone in the repository itself', () => {
  const langs = { '.go': 'go', '.js': 'javascript', '.css': 'css', '.html': 'markup', '.md': 'md' }
  for (const name of ['main.go', 'lsp.go', 'web/app.js', 'web/highlight.js', 'web/style.css', 'web/index.html', 'README.md']) {
    roundTrip(readFileSync(join(root, name), 'utf8'), langs[extname(name)])
  }
})

test('an unfinished quote stops at the end of its line', () => {
  roundTrip('x = "unterminated\ny = 1', 'javascript')
  const html = highlight('x = "unterminated\ny = 1', 'javascript')
  assert.match(html, /tk-string">"unterminated</)
})

test('marks what each language calls the same thing', () => {
  has(highlight('func f() { return nil }', 'go'), 'tk-keyword')
  has(highlight('import "fmt"', 'go'), 'tk-string')
  has(highlight('// note', 'go'), 'tk-comment')
  has(highlight('{"key": 1}', 'json'), 'tk-property')
  has(highlight('true', 'json'), 'tk-boolean')
  has(highlight('name: echo', 'yaml'), 'tk-property')
  has(highlight('echo $HOME', 'sh'), 'tk-parameter')
  has(highlight('<a href="x">y</a>', 'html'), 'tk-property')
  has(highlight('#111', 'css'), 'tk-number')
  has(highlight('@media', 'css'), 'tk-macro')
  has(highlight('SELECT 1', 'sql'), 'tk-keyword')
  has(highlight('+added', 'diff'), 'add')
  has(highlight('-removed', 'diff'), 'del')
  has(highlight('## h', 'md'), 'tk-keyword')
  has(highlight('"a\\nb"', 'javascript'), 'tk-escapeSequence')
})

test('a slash is a regexp only where a value can start', () => {
  has(highlight('const r = /ab+/gi', 'javascript'), 'tk-regexp')
  assert.ok(!highlight('a / b / c', 'javascript').includes('tk-regexp'))
})

test('an unknown or absent language comes back untouched', () => {
  assert.equal(highlight('anything', 'brainfuck'), null)
  assert.equal(highlight('anything', ''), null)
  assert.equal(highlight('anything', undefined), null)
})

test('reads a language off what a fence actually says', () => {
  for (const tag of ['go', 'GO', 'Go', '{.go}', 'go title="x.go"', 'go ', 'golang'])
    assert.notEqual(highlight('var a = 1', tag), null, tag)
  assert.equal(highlight('var a = 1', '{not-a-language}'), null)
})

test('a block too big to color is left alone', () => {
  assert.equal(highlight('x'.repeat(200001), 'go'), null)
})
