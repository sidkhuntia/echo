// Review notes and the prompt that hands them to a coding agent.

// A stable key for a hunk: its path and its changed lines, not the context, so it survives edits
// above it, a different amount of context and a re-stage.
export function hunkKey(path, h) {
  let x = 5381
  for (const l of h.lines) {
    if (l.t !== 'add' && l.t !== 'del') continue
    const s = (l.t === 'add' ? '+' : '-') + l.text + '\n'
    for (let i = 0; i < s.length; i++) x = ((x << 5) + x + s.charCodeAt(i)) | 0
  }
  return path + '#' + (x >>> 0).toString(36)
}

export const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6)

// noteRef names where a note points: "src/a.go:42", or "src/a.go:42 (removed line)" for a deleted line.
export const noteRef = n => `${n.path}:${n.line}${n.side === 'old' ? ' (removed line)' : n.end && n.end !== n.line ? `-${n.end}` : ''}${n.ref ? ` @ ${n.ref}` : ''}`

const fence = s => (s.includes('```') ? '~~~' : '```')

// notesText lists notes plainly: where, the code, and the note.
export function notesText(notes) {
  return notes.map((n, i) => {
    const quote = n.code ? `\n${n.code.split('\n').map(l => '   > ' + l).join('\n')}` : ''
    return `${i + 1}. ${noteRef(n)}${quote}\n   ${n.text.trim().replace(/\n/g, '\n   ')}`
  }).join('\n\n')
}

// reviewPrompt is the text copied for an agent: what happened, the rules of engagement, the notes in
// file order, and which hunks were accepted or rejected.
export function reviewPrompt({ repo = '', branch = '', notes, rejected = [], accepted = [] }) {
  const open = notes.filter(n => !n.done)
  const sorted = [...open].sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line)
  const lines = []
  lines.push(`I reviewed your uncommitted changes${repo ? ` in ${repo}` : ''}${branch ? ` (branch ${branch})` : ''} and left ${sorted.length} comment${sorted.length === 1 ? '' : 's'}${rejected.length ? ` and rejected ${rejected.length} change${rejected.length === 1 ? '' : 's'}` : ''}. Please address them.`)
  lines.push('')
  lines.push('How to work:')
  lines.push('- Go through the comments in the order listed. Each one gives a file and a line number in the CURRENT working tree (the new side of the diff), and quotes the code I was looking at. If the file has changed since, find the quoted code rather than trusting the number.')
  lines.push('- Change only what a comment asks for. Do not refactor, reformat or touch unrelated code.')
  lines.push('- If a comment is a question, answer it in your reply and change code only if the answer requires it.')
  lines.push('- If you disagree with a comment, or it is ambiguous, say so and ask instead of guessing.')
  lines.push('- Do not commit, stage, unstage or discard anything. Leave the changes in the working tree; I will review the new diff myself.')
  lines.push('- Afterwards, list each comment with what you changed (file:line) or why you did not.')
  if (sorted.length) {
    lines.push('', 'Comments:', '', notesText(sorted))
  }
  if (rejected.length) {
    lines.push('', 'Rejected changes: I do not want these as written. Redo them, or remove them if they are not needed:', '')
    rejected.forEach(r => lines.push(`- ${r}`))
  }
  if (accepted.length) {
    lines.push('', 'Accepted changes: leave these exactly as they are:', '')
    accepted.forEach(r => lines.push(`- ${r}`))
  }
  return lines.join('\n') + '\n'
}

export const quoteFor = (text, max = 160) => {
  const t = text.trim()
  return t.length > max ? t.slice(0, max) + '…' : t
}
