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
