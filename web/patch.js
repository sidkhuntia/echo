// Builds the patches the server's "apply" action takes: a whole hunk, or only some of its lines.
// Which side a line lands on depends on the direction. Applying forward (staging), a change line that
// was not picked is left out if it adds, and kept as context if it deletes. Applying in reverse
// (unstaging or discarding), the picked change is undone and the rest stays: an unpicked add is
// context, an unpicked delete is left out.

// C-style quoting, the way Git writes a name with unusual bytes in a diff header.
export function quotePath(p) {
  if (!/[\x00-\x1f"\\\u0080-￿]/.test(p)) return p
  let out = '"'
  for (const b of new TextEncoder().encode(p)) {
    const ch = String.fromCharCode(b)
    if (b === 0x22 || b === 0x5c) out += '\\' + ch
    else if (b === 10) out += '\\n'
    else if (b === 9) out += '\\t'
    else if (b < 0x20 || b >= 0x80) out += '\\' + b.toString(8).padStart(3, '0')
    else out += ch
  }
  return out + '"'
}

export function fileHeader(f) {
  const a = quotePath('a/' + f.path), b = quotePath('b/' + f.path)
  const mode = f.fileMode || '100644'
  if (f.isNew) return `diff --git ${a} ${b}\nnew file mode ${mode}\n--- /dev/null\n+++ ${b}\n`
  if (f.isDeleted) return `diff --git ${a} ${b}\ndeleted file mode ${mode}\n--- ${a}\n+++ /dev/null\n`
  return `diff --git ${a} ${b}\n--- ${a}\n+++ ${b}\n`
}

// hunkBody returns the lines of one hunk as a patch body, or null when nothing in it would change.
export function hunkBody(h, { lines = null, reverse = false } = {}) {
  const out = []
  let oc = 0, nc = 0, kept = false, changes = 0
  for (const l of h.lines) {
    if (l.t === 'meta') { if (kept) out.push('\\ ' + l.text); continue }
    const chosen = !lines || lines.has(l.i)
    let kind = l.t
    if (l.t === 'add' && !chosen) kind = reverse ? 'ctx' : null
    else if (l.t === 'del' && !chosen) kind = reverse ? null : 'ctx'
    if (!kind) { kept = false; continue }
    kept = true
    if (kind === 'add') { out.push('+' + l.text); nc++; changes++ }
    else if (kind === 'del') { out.push('-' + l.text); oc++; changes++ }
    else { out.push(' ' + l.text); oc++; nc++ }
  }
  if (!changes) return null
  return `@@ -${h.oStart},${oc} +${h.nStart},${nc} @@\n` + out.join('\n') + '\n'
}

// hunkPatch is a complete patch for one hunk of a file, or null.
export function hunkPatch(f, hi, opts = {}) {
  const body = hunkBody(f.hunks[hi], opts)
  return body && fileHeader(f) + body
}

// filePatch covers every hunk of a file (for the actions that take a whole file's worth at once).
export function filePatch(f, opts = {}) {
  const bodies = f.hunks.map(h => hunkBody(h, opts)).filter(Boolean)
  return bodies.length ? fileHeader(f) + bodies.join('') : null
}
