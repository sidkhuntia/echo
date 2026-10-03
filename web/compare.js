// Compare two refs the way a pull request does: how far apart they are, the commits, and the files.
import { ctx } from './ctx.js'
import { openModal } from './ui.js'

export async function compareUI(from, to) {
  const c = ctx, st = c.state.status || {}
  const names = [...new Set([...(st.branches || []), ...(st.tags || [])])]
  const body = document.createElement('div')
  body.innerHTML = `<datalist id="cmp-refs">${names.map(n => `<option value="${c.esc(n)}">`).join('')}</datalist>
    <div class="tool-form"><input id="cmp-from" class="field" list="cmp-refs" placeholder="base (from)" value="${c.esc(from || st.branch || '')}" spellcheck="false">
    <span class="faint">…</span><input id="cmp-to" class="field" list="cmp-refs" placeholder="compare (to)" value="${c.esc(to || '')}" spellcheck="false">
    <label class="check" title="Compare from the merge base, like a pull request"><input id="cmp-pr" type="checkbox" checked> from merge base</label>
    <button id="cmp-go" class="btn primary sm">Compare</button></div><div id="cmp-out"></div>`
  const out = body.querySelector('#cmp-out')
  const run = async () => {
    const f = body.querySelector('#cmp-from').value.trim(), t = body.querySelector('#cmp-to').value.trim()
    if (!f || !t) return void (out.innerHTML = '<p class="faint">Choose two refs.</p>')
    out.innerHTML = '<p class="faint">Comparing…</p>'
    try {
      const d = await c.api(`/api/compare?from=${encodeURIComponent(f)}&to=${encodeURIComponent(t)}&dots=${body.querySelector('#cmp-pr').checked ? 3 : 2}`)
      const add = d.files.reduce((s, x) => s + x.added, 0), del = d.files.reduce((s, x) => s + x.deleted, 0)
      out.innerHTML = `<div class="cmp-sum"><span><b>${c.esc(t)}</b> is <b class="add">${d.ahead} ahead</b>, <b class="del">${d.behind} behind</b> ${c.esc(f)}</span><span>${d.files.length} files <span class="add">+${add}</span> <span class="del">−${del}</span></span></div>
        <div class="cmp-grid"><div><h5 class="faint">Commits (${d.commits.length})</h5>${d.commits.map(x => `<div class="tool-row"><span class="sub">${c.esc(x.short)}</span><span class="nm" title="${c.esc(x.subject)}">${c.esc(x.subject)}</span></div>`).join('') || '<div class="faint">None</div>'}</div>
        <div><h5 class="faint">Files (${d.files.length})</h5>${d.files.map(x => `<div class="tool-row"><span class="st ${c.esc(x.code[0])}">${c.esc(x.code[0])}</span><span class="nm" title="${c.esc(x.path)}">${c.esc(x.path)}</span><span class="sub"><span class="add">+${x.added}</span> <span class="del">−${x.deleted}</span></span></div>`).join('') || '<div class="faint">None</div>'}</div></div>`
      m.buttons['Open diff in Review'].disabled = !d.files.length
    } catch (e) { out.innerHTML = `<p class="err">${c.esc(e.message)}</p>` }
  }
  body.querySelector('#cmp-go').onclick = run
  body.addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.matches('input')) run() })
  const m = openModal({
    title: 'Compare', kicker: 'branches, tags or commits', wide: true, body,
    actions: [{ label: 'Close' },
      { label: 'Show commits in Log', run: async () => { await c.startCompare(body.querySelector('#cmp-from').value.trim(), body.querySelector('#cmp-to').value.trim()) } },
      { label: 'Open diff in Review', primary: true, run: async () => {
        const f = body.querySelector('#cmp-from').value.trim(), t = body.querySelector('#cmp-to').value.trim()
        c.$('#diff-scope').value = 'range'; c.$('#diff-from').value = f; c.$('#diff-to').value = t
        c.state.rangeDots = body.querySelector('#cmp-pr').checked ? '...' : '..'; c.$('#range-dots').textContent = c.state.rangeDots
        await c.setMode('diff')
        c.$('#diff-scope').dispatchEvent(new Event('change'))
      } }],
  })
  m.buttons['Open diff in Review'].disabled = true
  if (from && to) run()
}
