// Previews for files the editor shows as something other than text: tables, images.
import { withBase } from './base.js'
import { ctx } from './ctx.js'
import { parseCSV } from './editing.js'

export const IMAGE = /\.(png|jpe?g|gif|webp|svg|bmp|ico|avif)$/i
export const isTable = p => /\.(csv|tsv)$/i.test(p)

// csvDoc builds the rendered table with text nodes only, so a cell can never become markup.
export function csvDoc(tab) {
  const doc = document.createElement('article')
  doc.className = 'md-doc csv-doc'
  const sep = /\.tsv$/i.test(tab.path) ? '\t' : ','
  const rows = parseCSV(tab.content, sep, 5001)
  const table = document.createElement('table')
  rows.slice(0, 5000).forEach((r, i) => {
    const tr = document.createElement('tr')
    for (const cell of r) {
      const td = document.createElement(i === 0 ? 'th' : 'td')
      td.textContent = cell
      tr.append(td)
    }
    table.append(tr)
  })
  doc.append(table)
  if (rows.length > 5000) {
    const p = document.createElement('p')
    p.className = 'faint'
    p.textContent = 'Showing the first 5,000 rows. Switch to Edit for the whole file.'
    doc.append(p)
  }
  if (!rows.length) doc.textContent = 'Empty file.'
  return doc
}

export function imageViewHTML(tab) {
  const src = `${withBase('/api/raw')}?path=${encodeURIComponent(tab.path)}&v=${encodeURIComponent(tab.hash || '')}`
  return `<div class="img-view"><div class="img-frame"><img src="${ctx.esc(src)}" alt="${ctx.esc(tab.path)}"></div><div class="img-meta"><span id="img-dim"></span><button class="btn sm" data-open-ext>Open in default app</button></div></div>`
}

export function initPreview() {
  ctx.$('#highlight').addEventListener('load', e => {
    if (e.target.tagName === 'IMG') { const d = ctx.$('#img-dim'); if (d) d.textContent = `${e.target.naturalWidth} × ${e.target.naturalHeight}` }
  }, true)
}
