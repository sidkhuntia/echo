// A small GitHub-flavored Markdown renderer: headings, paragraphs, emphasis, code, fenced blocks,
// lists with tasks, quotes and alerts, tables, links, images, and raw HTML. Its output always
// goes through sanitize(), so HTML in a README can lay things out but never run script.

const esc = s => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))

// slug makes GitHub-style heading anchors; ids get an "md-" prefix so they never collide with echo's own.
export function slug(text) {
  return 'md-' + text.toLowerCase().trim().replace(/<[^>]+>/g, '').replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s/g, '-')
}

export function renderMarkdown(src) {
  const refs = new Map()
  const lines = src.replace(/\r\n?/g, '\n').replace(/\t/g, '    ').split('\n')
  // Link reference definitions can appear anywhere; collect them first.
  const body = lines.filter(l => {
    const m = l.match(/^ {0,3}\[([^\]]+)\]:\s*<?(\S+?)>?(?:\s+["'(](.*)["')])?\s*$/)
    if (m && !/^\^/.test(m[1])) { refs.set(m[1].toLowerCase(), { href: m[2], title: m[3] || '' }); return false }
    return true
  })
  const seen = new Map()
  const ctx = { refs, seen }
  let start = 0
  let front = ''
  if (body[0] === '---') {
    const end = body.indexOf('---', 1)
    if (end > 0) { front = `<pre class="md-front"><code>${esc(body.slice(1, end).join('\n'))}</code></pre>`; start = end + 1 }
  }
  return front + blocks(body.slice(start), ctx)
}

const fence = /^ {0,3}(`{3,}|~{3,})\s*([^`\s]*)/
const hr = /^ {0,3}([-*_])(\s*\1){2,}\s*$/
const listItem = /^( *)([-*+]|\d{1,9}[.)])( +|$)(.*)$/
const htmlBlock = /^ {0,3}<\/?([a-zA-Z][\w-]*)(\s|\/?>|$)|^ {0,3}<!--/
const tableDelim = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/

function blocks(lines, ctx) {
  let out = '', i = 0
  const para = []
  const flush = () => { if (para.length) { out += `<p>${inline(para.join('\n').trim(), ctx)}</p>`; para.length = 0 } }
  while (i < lines.length) {
    const line = lines[i]
    let m
    if (!line.trim()) { flush(); i++; continue }
    if ((m = line.match(fence))) {
      flush()
      const close = new RegExp(`^ {0,3}${m[1][0]}{${m[1].length},}\\s*$`)
      const code = []
      for (i++; i < lines.length && !close.test(lines[i]); i++) code.push(lines[i])
      i++
      out += `<pre><code${m[2] ? ` class="md-lang-${esc(m[2])}"` : ''}>${esc(code.join('\n'))}</code></pre>`
      continue
    }
    if ((m = line.match(/^ {0,3}(#{1,6})\s+(.*?)(\s+#+)?\s*$/)) || (m = line.match(/^ {0,3}(#{1,6})$/))) {
      flush(); out += heading(m[1].length, m[2] || '', ctx); i++; continue
    }
    // Setext headings: a paragraph line underlined with === or ---.
    if (para.length && /^ {0,3}(=+|-+)\s*$/.test(line)) {
      const text = para.join(' ').trim()
      para.length = 0
      out += heading(line.trim()[0] === '=' ? 1 : 2, text, ctx); i++; continue
    }
    if (hr.test(line)) { flush(); out += '<hr>'; i++; continue }
    if (/^ {0,3}>/.test(line)) {
      flush()
      const inner = []
      for (; i < lines.length && lines[i].trim() && (/^ {0,3}>/.test(lines[i]) || inner.length); i++) {
        if (!/^ {0,3}>/.test(lines[i]) && (fence.test(lines[i]) || hr.test(lines[i]) || listItem.test(lines[i]))) break
        inner.push(lines[i].replace(/^ {0,3}> ?/, ''))
      }
      const alert = inner[0]?.match(/^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*$/i)
      if (alert) {
        const kind = alert[1].toLowerCase()
        out += `<div class="md-alert md-alert-${kind}"><p class="md-alert-title">${kind[0].toUpperCase() + kind.slice(1)}</p>${blocks(inner.slice(1), ctx)}</div>`
      } else out += `<blockquote>${blocks(inner, ctx)}</blockquote>`
      continue
    }
    if ((m = line.match(listItem)) && (!para.length || m[4].trim()) && m[1].length < 4) {
      flush()
      const r = list(lines, i, ctx)
      out += r.html; i = r.next; continue
    }
    if (line.includes('|') && i + 1 < lines.length && tableDelim.test(lines[i + 1]) && lines[i + 1].includes('-')) {
      flush()
      const r = table(lines, i, ctx)
      out += r.html; i = r.next; continue
    }
    if (!para.length && htmlBlock.test(line)) {
      const html = []
      for (; i < lines.length && lines[i].trim(); i++) html.push(lines[i])
      out += html.join('\n')
      continue
    }
    if (!para.length && /^ {4}/.test(line)) {
      const code = []
      for (; i < lines.length && (/^ {4}/.test(lines[i]) || !lines[i].trim()); i++) code.push(lines[i].slice(4))
      while (code.length && !code.at(-1).trim()) code.pop()
      out += `<pre><code>${esc(code.join('\n'))}</code></pre>`
      continue
    }
    para.push(line)
    i++
  }
  flush()
  return out
}

function heading(level, text, ctx) {
  let id = slug(text)
  const n = ctx.seen.get(id) || 0
  ctx.seen.set(id, n + 1)
  if (n) id += '-' + n
  return `<h${level} id="${id}">${inline(text, ctx)}</h${level}>`
}

// list reads one list starting at lines[i]: items continue while lines are indented past the marker.
function list(lines, i, ctx) {
  const first = lines[i].match(listItem)
  const ordered = /\d/.test(first[2])
  const base = first[1].length
  let html = ordered ? `<ol${parseInt(first[2]) !== 1 ? ` start="${parseInt(first[2])}"` : ''}>` : '<ul>'
  let loose = false
  const items = []
  while (i < lines.length) {
    const m = lines[i].match(listItem)
    if (!m || m[1].length !== base || /\d/.test(m[2]) !== ordered) break
    const indent = m[1].length + m[2].length + Math.min(m[3].length || 1, 4)
    const item = [m[4]]
    let blank = false
    for (i++; i < lines.length; i++) {
      const l = lines[i]
      if (!l.trim()) { blank = true; item.push(''); continue }
      const lead = l.match(/^ */)[0].length
      if (lead >= indent) { if (blank) loose = true; blank = false; item.push(l.slice(indent)); continue }
      // A lazy continuation line joins the paragraph; a new marker or block ends the item.
      if (!blank && !listItem.test(l) && !fence.test(l) && !hr.test(l) && !/^ {0,3}[>#]/.test(l)) { item.push(l.trim()); continue }
      break
    }
    while (item.length && !item.at(-1).trim()) item.pop()
    const next = i < lines.length && lines[i].match(listItem)
    if (blank && next && next[1].length === base && /\d/.test(next[2]) === ordered) loose = true
    items.push(item)
  }
  for (const item of items) {
    let task = ''
    const t = item[0].match(/^\[([ xX])\]\s+(.*)$/)
    if (t) { task = `<input type="checkbox" disabled${t[1] !== ' ' ? ' checked' : ''}> `; item[0] = t[2] }
    let inner = blocks(item, ctx)
    if (!loose) inner = inner.replace(/^<p>([\s\S]*?)<\/p>/, '$1')
    html += `<li${task ? ' class="md-task"' : ''}>${task}${inner}</li>`
  }
  return { html: html + (ordered ? '</ol>' : '</ul>'), next: i }
}

function cells(row) {
  let s = row.trim()
  if (s.startsWith('|')) s = s.slice(1)
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1)
  return s.split(/(?<!\\)\|/).map(c => c.trim().replace(/\\\|/g, '|'))
}

function table(lines, i, ctx) {
  const head = cells(lines[i])
  const align = cells(lines[i + 1]).map(c => c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : c.startsWith(':') ? 'left' : '')
  const td = (tag, c, k) => `<${tag}${align[k] ? ` align="${align[k]}"` : ''}>${inline(c, ctx)}</${tag}>`
  let html = `<table><thead><tr>${head.map((c, k) => td('th', c, k)).join('')}</tr></thead><tbody>`
  for (i += 2; i < lines.length && lines[i].trim() && lines[i].includes('|'); i++) {
    const row = cells(lines[i])
    html += `<tr>${head.map((_, k) => td('td', row[k] ?? '', k)).join('')}</tr>`
  }
  return { html: html + '</tbody></table>', next: i }
}

// inline renders spans. Code, raw HTML tags, and escapes are set aside as placeholders first,
// so emphasis and link patterns never reach inside them.
function inline(text, ctx) {
  const held = []
  const hold = html => `\u0000${held.push(html) - 1}\u0000`
  let s = text
    .replace(/(`+)([\s\S]*?[^`])\1(?!`)/g, (_, __, code) => hold(`<code>${esc(code.replace(/\n/g, ' ').replace(/^ (.*) $/, '$1'))}</code>`))
    .replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~])/g, (_, c) => hold(esc(c)))
    .replace(/<(https?:\/\/[^\s>]+|mailto:[^\s>]+)>/g, (_, u) => hold(`<a href="${esc(u)}">${esc(u)}</a>`))
    .replace(/<\/?[a-zA-Z][\w-]*(?:\s+[\w:-]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*\s*\/?>|<!--[\s\S]*?-->/g, tag => hold(tag))
  s = esc(s)
  const link = (label, href, title, image) => {
    href = href.replace(/^&lt;(.*)&gt;$/, '$1')
    const t = title ? ` title="${title}"` : ''
    return image ? hold(`<img src="${href}" alt="${label.replace(/<[^>]+>/g, '')}"${t}>`) : hold(`<a href="${href}"${t}>${emphasis(label)}</a>`)
  }
  const ref = (label, key, image, whole) => {
    const r = ctx.refs.get((key || label).replace(/\u0000\d+\u0000/g, '').toLowerCase())
    return r ? link(label, esc(r.href), esc(r.title), image) : whole
  }
  // Images before links, and innermost brackets first, so [![badge](img)](url) works.
  for (let k = 0; k < 3; k++) {
    s = s.replace(/(!?)\[([^\[\]]*)\]\(\s*(&lt;[^>]*?&gt;|(?:[^\s()]|\([^\s()]*\))*)(?:\s+(?:&quot;(.*?)&quot;|'(.*?)'))?\s*\)/g, (_, bang, label, href, t1, t2) => link(label, href, t1 || t2 || '', !!bang))
    s = s.replace(/(!?)\[([^\[\]]+)\](?:\[([^\[\]]*)\])?/g, (whole, bang, label, key) => ref(label, key, !!bang, whole))
  }
  s = s
    .replace(/(^|[\s(])((?:https?:\/\/|www\.)[^\s<]*[^\s<.,:;"')\]!?*_~])/g, (_, pre, u) => pre + hold(`<a href="${u.startsWith('www.') ? 'https://' + u : u}">${u}</a>`))
  s = emphasis(s).replace(/( {2,}|\\)\n/g, '<br>')
  // Placeholders can hold placeholders (a link label with code), so restore until none are left.
  for (let k = 0; k < 4 && s.includes('\u0000'); k++) s = s.replace(/\u0000(\d+)\u0000/g, (_, n) => held[n])
  return s
}

function emphasis(s) {
  return s
    .replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, '<strong>$2</strong>')
    .replace(/(^|[^\w*])\*(?=\S)([\s\S]*?\S)\*(?!\*)/g, '$1<em>$2</em>')
    .replace(/(^|[^\w])_(?=\S)([\s\S]*?\S)_(?!\w)/g, '$1<em>$2</em>')
    .replace(/~~(?=\S)([\s\S]*?\S)~~/g, '<del>$1</del>')
}

const TAGS = new Set('a abbr b blockquote br caption center code dd del details div dl dt em figcaption figure h1 h2 h3 h4 h5 h6 hr i img input ins kbd li mark ol p picture pre q s samp small span strong sub summary sup table tbody td tfoot th thead tr tt u ul var'.split(' '))
// Elements removed with their content, rather than unwrapped to their text.
const DROP = new Set('script style iframe object embed form textarea select button noscript template svg math link meta base frame frameset'.split(' '))
const ATTRS = new Set(['href', 'src', 'alt', 'title', 'width', 'height', 'align', 'colspan', 'rowspan', 'start', 'open', 'type', 'checked', 'disabled', 'id', 'class'])

// sanitize parses the HTML inertly (nothing loads or runs) and keeps only known-safe tags and
// attributes. `url(href, kind)` rewrites or rejects each link and image address.
export function sanitize(html, url) {
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html')
  const walk = node => {
    for (const el of [...node.children]) {
      const tag = el.tagName.toLowerCase()
      if (DROP.has(tag)) { el.remove(); continue }
      walk(el)
      if (!TAGS.has(tag)) { el.replaceWith(...el.childNodes); continue }
      for (const a of [...el.attributes]) {
        const name = a.name.toLowerCase()
        // Only echo's own ids and classes survive, so a document cannot clobber the page's elements.
        if (!ATTRS.has(name) || ((name === 'id' || name === 'class') && !/^md-/.test(a.value))) el.removeAttribute(a.name)
      }
      if (tag === 'input' && el.getAttribute('type') !== 'checkbox') { el.remove(); continue }
      if (tag === 'input') el.setAttribute('disabled', '')
      for (const name of ['href', 'src']) {
        if (!el.hasAttribute(name)) continue
        const v = url(el.getAttribute(name), tag === 'img' ? 'img' : 'link')
        if (v == null) el.removeAttribute(name)
        else el.setAttribute(name, v)
      }
    }
  }
  walk(doc.body)
  return doc.body
}
