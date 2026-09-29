// Syntax highlighting for the fenced code blocks in Markdown preview. This is a tokenizer, not a
// parser: one linear scan per language family with keyword tables instead of grammars, so it stays
// fast, never throws, and an unknown language returns null for the caller to leave alone. Colors
// come from the editor's own .tk-* rules, so a block here reads like the same code in the editor.

// A block bigger than this stays plain text: the scan is linear, but the DOM is not.
const MAX = 200000

const esc = s => s.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))
const words = s => new Set(s.split(' ').filter(Boolean))
const isWord = c => !!c && /[\p{L}\p{N}_$]/u.test(c)
const isDigit = c => c >= '0' && c <= '9'
const isUpper = c => /\p{Lu}/u.test(c)
const span = (cls, text) => `<span class="${cls}">${esc(text)}</span>`

// sink collects escaped output. Plain text is held in one buffer and only escaped when a token
// needs to go in front of it, which keeps most blocks to a handful of spans.
function sink() {
  const out = []
  let buf = ''
  return {
    plain(s) { buf += s },
    html(h) {
      if (buf) { out.push(esc(buf)); buf = '' }
      out.push(h)
    },
    tok(cls, s) { this.html(`<span class="${cls}">${esc(s)}</span>`) },
    done() {
      if (buf) { out.push(esc(buf)); buf = '' }
      return out.join('')
    },
  }
}

// ---------- language tables ----------
// A family is the scanner's shape (what a comment, a string or a directive looks like); a language
// is a family plus its keywords. Anything not listed here is left as plain text.
const FAM = {
  clike: { line: ['//'], block: [['/*', '*/']], quote: `"'\``, escape: true, regex: true },
  go: { line: ['//'], block: [['/*', '*/']], quote: `"'\``, raw: '`', escape: true, regex: true, directive: true },
  hash: { line: ['#'], quote: `"'`, escape: true, interp: true, decorator: true },
  sql: { line: ['--'], block: [['/*', '*/']], quote: `"'`, fold: true },
  data: { quote: '"', escape: true, props: true },
  keys: { line: ['#'], quote: `"'`, escape: true, props: true },
  css: { block: [['/*', '*/']], quote: `"'`, escape: true, props: true, at: true, hex: true, units: true },
}

const L = (fam, o = {}) => {
  const { kw = '', lit = '', type = '', ...rest } = o
  return { fam, kw: words(kw), lit: words(lit), type: words(type), ...FAM[fam], ...rest }
}

const LANGS = {
  javascript: L('clike', {
    kw: 'arguments as async await break case catch class const continue debugger default delete do else export extends finally for from function get if import in instanceof let new of return set static super switch this throw try typeof var void while with yield',
    lit: 'false null undefined Infinity NaN true',
    type: 'Array BigInt Boolean Date Error Function JSON Map Math Number Object Promise Proxy RegExp Set String Symbol WeakMap WeakSet',
    decorator: true, nested: true,
  }),
  typescript: L('clike', {
    kw: 'abstract arguments as async await break case catch class const continue declare default delete do else enum export extends finally for from function get if implements import in infer instanceof interface is keyof let namespace new of override private protected public readonly return satisfies set static super switch this throw try type typeof var void while yield',
    lit: 'false null undefined Infinity NaN true',
    type: 'any Array BigInt Boolean Date Error Function JSON Map Math Never Number Object Promise Proxy RegExp Set String Symbol Unknown WeakMap WeakSet boolean never number object string unknown',
    decorator: true, nested: true,
  }),
  go: L('go', {
    kw: 'break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var',
    lit: 'false iota nil true',
    type: 'any bool byte complex64 complex128 error float32 float64 int int8 int16 int32 int64 rune string uint uint8 uint16 uint32 uint64 uintptr',
  }),
  rust: L('clike', {
    kw: 'as async await break const continue crate dyn else enum extern fn for if impl in let loop match mod move mut pub ref return self static struct super trait type unsafe use where while',
    lit: 'Err false None Ok Some true',
    type: 'Arc Box HashMap HashSet Option Rc Result String Vec bool char f32 f64 i8 i16 i32 i64 i128 isize str u8 u16 u32 u64 u128 usize',
    directive: true, decorator: true, nested: true,
  }),
  python: L('hash', {
    kw: 'and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield',
    lit: 'Ellipsis False None NotImplemented True',
    type: 'bool bytes complex dict float frozenset int list object set str tuple',
  }),
  java: L('clike', {
    kw: 'abstract assert break case catch class continue default do else enum extends final finally for goto if implements import instanceof interface native new package permits private protected public record return sealed static strictfp super switch synchronized this throw throws transient try var volatile while yield',
    lit: 'false null true',
    type: 'Boolean Byte Double Integer Long Object Short String boolean byte char double float int long short void',
    decorator: true,
  }),
  kotlin: L('clike', {
    kw: 'as break by catch class companion const constructor continue crossinline data do dynamic else enum external final finally for fun get if import in infix init inline inner interface internal is lateinit noinline object open operator out override package private protected public reified return sealed set super suspend tailrec this throw try typealias val var vararg when where while',
    lit: 'false null true',
    type: 'Any Array Boolean Byte Char Double Float Int Long Nothing Short String Unit',
    decorator: true, nested: true,
  }),
  swift: L('clike', {
    kw: 'associatedtype async await break case catch class continue default defer deinit do else enum extension fallthrough fileprivate final for func guard if import in init inout internal is lazy let mutating nonmutating open operator private protocol public repeat rethrows return self static struct subscript super switch throw throws try typealias var weak where while',
    lit: 'false nil true',
    type: 'Any Array Bool Character Dictionary Double Float Int Set String UInt Void',
    decorator: true,
  }),
  c: L('clike', {
    kw: 'auto break case const continue default do else enum extern for goto if inline register restrict return sizeof static struct switch typedef union volatile while',
    lit: 'false NULL true',
    type: 'bool char double float int int16_t int32_t int64_t int8_t long short signed size_t ssize_t uint16_t uint32_t uint64_t uint8_t unsigned void',
    directive: true,
  }),
  cpp: L('clike', {
    kw: 'alignas alignof auto break case catch class concept const consteval constexpr constinit const_cast continue co_await co_return co_yield decltype default delete do dynamic_cast else enum explicit export extern final friend for goto if inline mutable namespace new noexcept operator private protected public reinterpret_cast requires return sizeof static static_assert static_cast struct switch template this thread_local throw try typedef typeid typename union using virtual volatile while',
    lit: 'false nullptr true',
    type: 'bool char char8_t char16_t char32_t double float int long pair set short size_t string unique_ptr unsigned vector void wchar_t',
    directive: true,
  }),
  objc: L('clike', {
    kw: 'auto break by bycopy byref case const continue default do else enum extern for goto if in inline inout oneway register restrict return self sizeof static struct super switch typedef union volatile while',
    lit: 'false nil true NO YES',
    type: 'BOOL CGFloat Class IMP NSInteger NSUInteger SEL char double float id int long void',
    directive: true,
  }),
  csharp: L('clike', {
    kw: 'abstract args as async await base break case catch checked class const continue default delegate do else enum event explicit extern file finally fixed for foreach get global goto if implicit in interface internal is lock namespace new not null operator out override params private protected public readonly record ref required return scoped sealed set sizeof stackalloc static struct switch this throw try typeof unchecked unsafe using virtual volatile when where while with yield',
    lit: 'false null true',
    type: 'bool byte char decimal double dynamic float int long object sbyte short string uint ulong ushort void',
    directive: true, decorator: true,
  }),
  ruby: L('hash', {
    kw: 'alias and attr_accessor attr_reader attr_writer begin break case class def defined? do else elsif end ensure extend for if in include module next not or private protected public redo rescue retry return self super then undef unless until when while yield',
    lit: 'false nil true',
    type: 'Array Float Hash Integer Object Proc String Struct Symbol',
    decorator: true,
  }),
  php: L('clike', {
    kw: 'abstract and array as break callable case catch class clone const continue declare default do echo else elseif empty enddeclare endfor endforeach endif endswitch endwhile enum extends final finally fn for foreach function global goto if implements include include_once instanceof insteadof interface isset list match namespace new or print private protected public readonly require require_once return static switch throw trait try unset use var while xor yield',
    lit: 'false null true',
    type: 'array bool float int mixed object string void',
    decorator: true,
  }),
  lua: L('hash', {
    kw: 'and break do else elseif end for function goto if in local not or repeat return then until while',
    lit: 'false nil true',
    type: 'coroutine io math os string table thread userdata',
  }),
  shell: L('hash', {
    kw: 'alias case do done elif else esac eval exec exit export fi for function if in local printf read return select set shift source then time trap type typeset unset until while',
    lit: 'false true',
    type: 'cd echo pwd test',
  }),
  sql: L('sql', {
    kw: 'add all alter and any as asc between by case check column constraint create cross database default delete desc distinct drop else end exists foreign from full group having if in index inner insert into is join key left like limit not offset on or order outer primary procedure references replace right rollback schema select set table top truncate union unique update values view when where with',
    lit: 'false null true',
    type: 'bigint blob boolean char date datetime decimal double float int integer json nvarchar numeric real serial smallint text time timestamp uniqueidentifier uuid varchar',
  }),
  json: L('data', { lit: 'false null true' }),
  yaml: L('keys', { lit: 'false null off on true yes ~' }),
  markup: {},
  css: L('css', { kw: 'charset from important import keyframes layer media supports to' }),
  md: {},
  diff: {},
  make: L('keys', { kw: 'define else endef endif ifeq ifndef ifndef ifneq include override unexport export vpath' }),
  docker: L('keys', { kw: 'ADD ARG AS CMD COPY ENTRYPOINT ENV EXPOSE FROM HEALTHCHECK LABEL MAINTAINER ONBUILD RUN SHELL STOPSIGNAL USER VOLUME WORKDIR' }),
}

// Aliases fold to lower case and are cut at the first character a language name cannot hold, so
// ```js title="app.js" and ```{.go} still find their scanner.
const ALIAS = { markup: 'markup', md: 'md', diff: 'diff' }
for (const id of Object.keys(LANGS)) ALIAS[id] = id
Object.assign(ALIAS, {
  'c++': 'cpp', 'c++17': 'cpp', 'c#': 'csharp', 'obj-c': 'objc',
  bash: 'shell', cc: 'cpp', cfg: 'yaml', conf: 'yaml', console: 'shell', containerfile: 'docker',
  cs: 'csharp', cjs: 'javascript', csx: 'csharp', cxx: 'cpp',
  dockerfile: 'docker', dotnet: 'csharp', env: 'yaml',
  golang: 'go', h: 'c', hh: 'cpp', hpp: 'cpp', html: 'markup', ini: 'yaml',
  js: 'javascript', json5: 'json', jsonc: 'json', jsx: 'javascript',
  kt: 'kotlin', kts: 'kotlin', less: 'css', m: 'objc', markdown: 'md', mdx: 'md', mjs: 'javascript',
  mm: 'objc', mysql: 'sql', node: 'javascript', objectivec: 'objc', patch: 'diff',
  postcss: 'css', properties: 'yaml', psql: 'sql', py: 'python', py3: 'python',
  rb: 'ruby', rs: 'rust', sass: 'css', scss: 'css', sh: 'shell', shellsession: 'shell',
  sqlite: 'sql', sv: 'markup', svg: 'markup', toml: 'yaml',
  ts: 'typescript', tsx: 'typescript', vue: 'markup', xhtml: 'markup', xml: 'markup',
  yml: 'yaml', zsh: 'shell',
})

// highlight returns highlighted HTML for a block, or null when the language is unknown or the block
// is too big to be worth it.
export function highlight(code, lang) {
  const id = ALIAS[normalize(lang)]
  if (!id || !code || code.length > MAX) return null
  if (id === 'markup') return markup(code)
  if (id === 'md') return md(code)
  if (id === 'diff') return diff(code)
  const C = LANGS[id]
  return C.fam === 'keys' ? keys(code, C) : walk(code, C)
}

function normalize(lang) {
  const clean = s => { const cut = s.search(/[^a-z0-9+#._-]/); return (cut < 0 ? s : s.slice(0, cut)).replace(/^\./, '') }
  const s = String(lang || '').toLowerCase().trim()
  return clean(s) || clean(s.replace(/[{}[\]]/g, ''))
}

// ---------- the generic scanner ----------
const PUNCT = '()[]{},;.:'
const OP = /[+\-*/%!<>=&|^~?]/
const NUM = /0[xX][0-9a-fA-F_]+n?|0[bB][01_]+n?|0[oO][0-7_]+n?|(?:\d[\d_]*(?:\.[\d_]*)?|\.\d[\d_]*)(?:[eE][+-]?\d+)?n?|\d[\d_]*[a-zA-Z_%]*/y
const VAR = /^\$(?:\{[^}]*\}|[A-Za-z_]\w*|[0-9@*#?$!-])/
// A slash opens a regexp only where a value may start; after a word or a closing bracket it divides.
const RE_OK = new Set(['', '(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '^', '~', '<', '>', '\n'])
const RE_WORD = new Set(['await', 'case', 'delete', 'do', 'else', 'in', 'instanceof', 'new', 'of', 'return', 'throw', 'typeof', 'void', 'yield'])

function walk(code, C) {
  const s = sink()
  const n = code.length
  let i = 0, prev = '', last = ''
  const after = k => { while (k < n && (code[k] === ' ' || code[k] === '\t')) k++; return k < n ? code[k] : '' }
  while (i < n) {
    const c = code[i]
    // Whitespace never starts a token, and it must not hide the character before it: a slash
    // after a space still opens a regexp.
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { s.plain(c); i++; continue }
    let open
    if (C.block) for (const b of C.block) if (code.startsWith(b[0], i)) open = b
    if (open) {
      let depth = 1, j = i + open[0].length
      while (j < n) {
        if (C.nested && code.startsWith(open[0], j)) { depth++; j += open[0].length; continue }
        const k = code.indexOf(open[1], j)
        if (k < 0) { j = n; break }
        if (--depth === 0) { j = k + open[1].length; break }
        j = k + open[1].length
      }
      s.tok('tk-comment', code.slice(i, j))
      i = j; prev = last = ''; continue
    }
    if (C.line && C.line.some(m => code.startsWith(m, i))) {
      const k = code.indexOf('\n', i)
      const stop = k < 0 ? n : k
      s.tok('tk-comment', code.slice(i, stop))
      i = stop; prev = last = ''; continue
    }
    if (C.regex && c === '/' && (RE_OK.has(prev) || RE_WORD.has(last))) {
      let j = i + 1, depth = 0
      while (j < n) {
        if (code[j] === '\\') { j += 2; continue }
        if (code[j] === '[') depth++
        if (code[j] === ']') depth--
        if (code[j] === '/' && !depth) break
        j++
      }
      if (j < n) {
        j++
        while (j < n && isWord(code[j])) j++
        s.tok('tk-regexp', code.slice(i, j))
        i = j; prev = last = ''; continue
      }
    }
    if (C.quote.includes(c)) {
      const str = string(code, i, C)
      if (!str.html) s.plain(code.slice(i, str.end))
      // In a language where a colon follows a value (json, toml), that value is a property.
      else s.html(C.props && after(str.end) === ':' ? `<span class="tk-property">${str.html}</span>` : str.html)
      i = str.end; prev = last = ''; continue
    }
    if (isDigit(c) || (c === '.' && isDigit(code[i + 1]))) {
      NUM.lastIndex = i
      const m = NUM.exec(code)
      let stop = m ? i + m[0].length : i + 1
      // A css length keeps its unit with it, so 40em reads as one number.
      if (C.units) while (stop < n && isWord(code[stop])) stop++
      s.tok('tk-number', code.slice(i, stop))
      i = stop; prev = last = ''; continue
    }
    if (c === '#' && C.hex && /[\da-fA-F]/.test(code[i + 1] || '')) {
      let j = i + 1
      while (j < n && /[\da-fA-F]/.test(code[j])) j++
      s.tok('tk-number', code.slice(i, j))
      i = j; prev = last = ''; continue
    }
    // A sigil introduces a name: @media, @Cacheable, #[derive], $ref, ~HEAD.
    if (c === '@' && (C.at || C.decorator)) {
      let j = i + 1
      while (j < n && isWord(code[j])) j++
      if (j > i + 1) {
        s.tok(C.at ? 'tk-macro' : 'tk-decorator', code.slice(i, j))
        i = j; prev = last = ''; continue
      }
    }
    if (c === '#' && C.directive && (isWord(code[i + 1]) || code[i + 1] === '[')) {
      let j = i + 1
      while (j < n && (isWord(code[j]) || code[j] === '[' || code[j] === ']')) j++
      s.tok('tk-macro', code.slice(i, j))
      i = j; prev = last = ''; continue
    }
    if (c === '$' && C.interp) {
      const m = VAR.exec(code.slice(i, i + 80))
      if (m) {
        s.tok('tk-parameter', m[0])
        i += m[0].length; prev = 'v'; continue
      }
    }
    if (isWord(c)) {
      let j = i
      while (j < n && isWord(code[j])) j++
      const w = code.slice(i, j)
      const key = C.fold ? w.toLowerCase() : w
      const nx = after(j)
      let cls = ''
      if (C.kw.has(key)) cls = 'tk-keyword'
      else if (C.lit.has(key)) cls = 'tk-boolean'
      else if (C.type.has(key)) cls = 'tk-type'
      else if (nx === '(') cls = 'tk-function'
      else if (C.props && nx === ':') cls = 'tk-property'
      else if (prev === '.') cls = 'tk-property'
      else if (isUpper(c)) cls = 'tk-type'
      if (cls) s.tok(cls, w)
      else s.plain(w)
      i = j; prev = 'v'; last = w; continue
    }
    if (PUNCT.includes(c)) {
      s.tok('tk-punctuation', c)
      i++; prev = c; continue
    }
    if (OP.test(c)) {
      let j = i
      while (j < n && OP.test(code[j])) j++
      s.tok('tk-operator', code.slice(i, j))
      i = j; prev = last = ''; continue
    }
    s.plain(c)
    i++
    prev = c
  }
  return s.done()
}

// string reads a quoted run and marks its escape sequences and, where the language has them, its
// interpolations, so a shell string still shows $VAR in its own color.
function string(code, i, C) {
  const q = code[i]
  const raw = C.raw?.includes(q)
  const chunks = []
  // The quotes are part of the string's text, so they travel with it.
  let j = i + 1, part = i, stop = code.length
  while (j < code.length) {
    const c = code[j]
    if (c === '\\' && C.escape && !raw && j + 1 < code.length) {
      if (part < j) chunks.push([0, code.slice(part, j)])
      chunks.push([1, code.slice(j, j + 2)])
      j += 2; part = j
      continue
    }
    if (c === q) { stop = j + 1; j++; break }
    // An unterminated quote ends at the line end instead of swallowing the rest of the file,
    // unless the language's raw quotes are allowed to run over lines (a Go raw string).
    if (c === '\n' && !raw) { stop = j; break }
    if (c === '$' && C.interp) {
      const m = VAR.exec(code.slice(j, j + 80))
      if (m) {
        if (part < j) chunks.push([0, code.slice(part, j)])
        chunks.push([2, m[0]])
        j += m[0].length; part = j
        continue
      }
    }
    j++
  }
  if (part < stop) chunks.push([0, code.slice(part, stop)])
  if (!chunks.length) return { html: '', end: j }
  const body = chunks.map(([k, s]) => k ? span(k === 1 ? 'tk-escapeSequence' : 'tk-parameter', s) : esc(s)).join('')
  return { html: `<span class="tk-string">${body}</span>`, end: j }
}

// ---------- markup ----------
// Tags, attributes and attribute values are read directly; everything between them stays text.
function markup(code) {
  const s = sink()
  let i = 0
  while (i < code.length) {
    const lt = code.indexOf('<', i)
    if (lt < 0) { s.plain(code.slice(i)); break }
    if (lt > i) s.plain(code.slice(i, lt))
    if (code.startsWith('<!--', lt)) {
      const k = code.indexOf('-->', lt + 4)
      const stop = k < 0 ? code.length : k + 3
      s.tok('tk-comment', code.slice(lt, stop))
      i = stop; continue
    }
    // A doctype or processing instruction has no attributes worth showing.
    if (code.startsWith('<!', lt) || code.startsWith('<?', lt)) {
      const k = code.indexOf('>', lt)
      const stop = k < 0 ? code.length : k + 1
      s.tok('tk-macro', code.slice(lt, stop))
      i = stop; continue
    }
    const closing = code[lt + 1] === '/'
    s.tok('tk-punctuation', '<')
    let j = lt + 1
    if (closing) { s.tok('tk-punctuation', '/'); j++ }
    const name = /^[\w:.-]+/.exec(code.slice(j))
    if (!name) { s.plain('<'); i = lt + 1; continue }
    s.tok('tk-type', name[0])
    j += name[0].length
    for (;;) {
      const from = j
      while (j < code.length && /\s/.test(code[j])) j++
      if (j > from) s.plain(code.slice(from, j))
      if (j >= code.length) break
      if (code[j] === '>') { s.tok('tk-punctuation', '>'); j++; break }
      if (code.startsWith('/>', j)) { s.tok('tk-punctuation', '/>'); j += 2; break }
      const attr = /^[^\s=/>"']+/.exec(code.slice(j))
      if (!attr) { s.plain(code[j]); j++; continue }
      s.tok('tk-property', attr[0])
      j += attr[0].length
      if (code[j] !== '=') continue
      s.tok('tk-operator', '=')
      j++
      const q = code[j]
      if (q === '"' || q === "'") {
        const k = code.indexOf(q, j + 1)
        const stop = k < 0 ? code.length : k + 1
        s.tok('tk-string', code.slice(j, stop))
        j = stop
      } else {
        const bare = /^[^\s>]*/.exec(code.slice(j))[0]
        if (bare) { s.tok('tk-string', bare); j += bare.length }
      }
    }
    i = j
  }
  return s.done()
}

// ---------- markdown in a fence ----------
const MD_INL = /(`+)(?:[\s\S]*?\S)\1|(!?)\[([^\]\n]*)\]\(([^)\n]*)\)|(\*\*|__)(?:[\s\S]*?\S)\5|(\*|_)([^*\n]*?\S)\6|\|/g

function md(code) {
  return code.split('\n').map(line => {
    let m = /^(\s*)(```+|~~~+)(.*)$/.exec(line)
    if (m) return esc(m[1]) + span('tk-macro', m[2]) + inline(m[3])
    m = /^(\s*)(#{1,6})(\s+.*)$/.exec(line)
    if (m) return esc(m[1]) + span('tk-keyword', m[2]) + inline(m[3])
    m = /^(\s*)>/.exec(line)
    if (m) return esc(m[1]) + span('tk-namespace', m[2]) + inline(line.slice(m[0].length))
    m = /^(\s*)((?:[-*+]|\d{1,9}[.)]))(\s)/.exec(line)
    if (m) return esc(m[1]) + span('tk-namespace', m[2]) + esc(m[3]) + inline(line.slice(m[0].length))
    if (/^\s*(?:-{3,}|_{3,}|\*{3,})\s*$/.test(line)) return span('tk-macro', line)
    return inline(line)
  }).join('\n')
}

function inline(line) {
  let out = '', at = 0
  MD_INL.lastIndex = 0
  for (let m; (m = MD_INL.exec(line));) {
    if (m.index > at) out += esc(line.slice(at, m.index))
    const [full, , bang, label, target, bold, , italic] = m
    if (full[0] === '`') out += span('tk-string', full)
    else if (label !== undefined) out += esc(bang + '[') + span('tk-property', label) + esc('](') + span('tk-string', target) + esc(')')
    else if (bold) out += span('tk-keyword', full)
    else if (italic) out += span('tk-type', full)
    else out += span('tk-punctuation', '|')
    at = m.index + full.length
  }
  return out + esc(line.slice(at))
}

// ---------- diff ----------
function diff(code) {
  return code.split('\n').map(line => {
    if (/^\+(?!\+\+)/.test(line)) return span('add', line)
    if (/^-(?!--)/.test(line)) return span('del', line)
    if (/^@@/.test(line)) return span('faint', line)
    if (/^(diff |index |--- |\+\+\+ |new file|deleted file|similarity|rename )/.test(line)) return span('faint', line)
    return esc(line)
  }).join('\n')
}

// ---------- keys: yaml, toml, ini, make, dockerfile ----------
// The key before a colon is a property; the rest of the line goes through the normal scanner.
function keys(code, C) {
  return code.split('\n').map(line => {
    const m = /^(\s*(?:-\s+)?)("[^"]*"|'[^']*'|[^#\s:][^:]*?)(\s*:(?=\s|$))/.exec(line)
    if (!m) return walk(line, C)
    return esc(m[1]) + span('tk-property', m[2]) + esc(m[3]) + walk(line.slice(m[0].length), C)
  }).join('\n')
}
