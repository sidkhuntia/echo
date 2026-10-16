// Syntax highlighting, shared by the editor, both diff layouts and Markdown fences. The colors come
// from highlight.js (vendored in vendor/hljs.js, BSD-3, the "common" build), so echo owns no grammars.
// Colors are the .hljs-* rules in style.css. An unknown language returns null for the caller to leave alone.
import hljs from './vendor/hljs.js'

// A block bigger than this stays plain text: the scan is linear, but the DOM is not.
const MAX = 200000

// Names the library has no alias for. Everything else it resolves itself (js, ts, py, rs, sh, yml, html, toml...).
const ALIAS = { markdown: 'markdown', mdx: 'markdown', mjs: 'javascript', cjs: 'javascript', jsonc: 'json', json5: 'json', mk: 'makefile', zsh: 'bash', env: 'ini', conf: 'ini', properties: 'ini', gradle: 'java', groovy: 'java', vue: 'xml', patch: 'diff' }

// Reads a language off what a fence says, so ```js title="app.js" and ```{.go} still find their grammar.
function langOf(lang) {
  const clean = s => { const cut = s.search(/[^a-z0-9+#._-]/); return (cut < 0 ? s : s.slice(0, cut)).replace(/^\./, '') }
  const s = String(lang || '').toLowerCase().trim()
  const name = clean(s) || clean(s.replace(/[{}[\]]/g, ''))
  const id = ALIAS[name] || name
  return id && id !== 'plaintext' && hljs.getLanguage(id) ? id : null
}

// highlight returns highlighted HTML for a block, or null when the language is unknown or the block
// is too big to be worth it.
export function highlight(code, lang) {
  const language = langOf(lang)
  if (!language || !code || code.length > MAX) return null
  try { return hljs.highlight(code, { language, ignoreIllegals: true }).value } catch { return null }
}

// highlightLines colors a whole file or hunk and returns one HTML string per line, or null. A token
// that spans lines (block comment, template string) is closed at each line's end and reopened on the
// next, so every row stands alone.
export function highlightLines(code, path) {
  const base = path.slice(path.lastIndexOf('/') + 1)
  const html = highlight(code, base.includes('.') ? base.slice(base.lastIndexOf('.')) : base)
  if (html == null) return null
  const open = []
  return html.split('\n').map(line => {
    const out = open.join('') + line
    for (const t of line.matchAll(/<span [^>]*>|<\/span>/g)) t[0] === '</span>' ? open.pop() : open.push(t[0])
    return out + '</span>'.repeat(open.length)
  })
}

// overlay wraps ranges of one highlighted row in extra spans, for semantic tokens. A range is
// {start, end, cls} in characters of the row's plain text (what a language server counts in), sorted
// and not overlapping. Only text is wrapped, never a tag, so the nesting stays valid; an entity such
// as &lt; is one character, as it is in the text.
export function overlay(html, ranges) {
  if (!ranges || !ranges.length) return html
  let out = '', pos = 0, ri = 0
  for (const m of html.matchAll(/<[^>]*>|&(?:#x?[0-9a-fA-F]+|[a-zA-Z]+);|[^<&]+|&/g)) {
    const s = m[0]
    if (s[0] === '<') { out += s; continue }
    const end = pos + (s[0] === '&' && s.length > 1 ? 1 : s.length), whole = end - pos === 1 && s.length > 1
    let a = pos
    while (a < end) {
      while (ri < ranges.length && ranges[ri].end <= a) ri++
      const r = ranges[ri]
      if (!r || r.start >= end) { out += whole ? s : s.slice(a - pos); a = end }
      else if (r.start > a) { const b = r.start; out += s.slice(a - pos, b - pos); a = b }
      else { const b = Math.min(end, r.end); out += `<span class="${r.cls}">${whole ? s : s.slice(a - pos, b - pos)}</span>`; a = b }
    }
    pos = end
  }
  return out
}
