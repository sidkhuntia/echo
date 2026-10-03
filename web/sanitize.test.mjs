// sanitize() parses HTML with the browser's DOMParser, so these checks need a browser. Under Node they
// are skipped; to run them, open echo in a browser and run in its console:
//   const t = await import('/sanitize.test.mjs'); t.check(await import('/markdown.js'))
import test from 'node:test'
import assert from 'node:assert/strict'

export const payloads = [
  '<img src=x onerror=alert(1)>', '<script>alert(1)</script>', '[x](javascript:alert(1))', '<a href="javascript:alert(1)">x</a>',
  '<svg><use href="data:image/svg+xml,<svg onload=alert(1)>"/></svg>', '<iframe src="https://evil"></iframe>',
  '<form action="https://evil"><input></form>', '<style>body{background:url(javascript:alert(1))}</style>',
  '![x](data:text/html,<script>alert(1)</script>)', '<details open ontoggle=alert(1)>x</details>',
  '<math><mtext><table><mglyph><style><img src=x onerror=alert(1)>', '<a href="  JaVaScRiPt:alert(1)">x</a>',
  '<object data="x"></object><embed src="x">', '<meta http-equiv="refresh" content="0;url=https://evil">', '<base href="https://evil/">',
]

const DANGEROUS = /<script|<iframe|<form|<style|<object|<embed|<meta|<base|\son\w+=|javascript:/i

// check returns the payloads whose sanitized output still contains something dangerous.
export function check({ sanitize, renderMarkdown }) {
  const bad = []
  for (const p of payloads) {
    const div = document.createElement('div')
    div.append(...sanitize(renderMarkdown(p), v => (/^https?:/i.test(v) ? v : null)).childNodes)
    if (DANGEROUS.test(div.innerHTML)) bad.push(p)
  }
  return bad
}

test('sanitize removes script, handlers, javascript: links and friends', { skip: typeof DOMParser === 'undefined' && 'needs a browser DOM' }, async () => {
  assert.deepEqual(check(await import('./markdown.js')), [])
})
