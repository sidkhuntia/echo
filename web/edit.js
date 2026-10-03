// Edits to the editor's textarea that keep the browser's own undo history.
// execCommand is deprecated but is still the one way to change a textarea's text so that undo works.

// replaceRange swaps [start, end) for text, then optionally selects [selStart, selEnd).
export function replaceRange(ed, start, end, text, selStart, selEnd) {
  ed.focus({ preventScroll: true })
  ed.setSelectionRange(start, end)
  let ok = false
  try { ok = text === '' ? document.execCommand('delete') : document.execCommand('insertText', false, text) } catch { ok = false }
  if (!ok) {
    ed.setRangeText(text, start, end, 'end')
    ed.dispatchEvent(new Event('input', { bubbles: true }))
  }
  if (selStart != null) ed.setSelectionRange(selStart, selEnd ?? selStart)
}

// lineBounds returns the start of the line containing offset and the offset just past its newline.
export function lineBounds(text, offset) {
  const start = text.lastIndexOf('\n', offset - 1) + 1
  const nl = text.indexOf('\n', offset)
  return [start, nl < 0 ? text.length : nl + 1]
}

// lineIndex is the zero-based line number of an offset.
export function lineIndex(text, offset) {
  let n = 0
  for (let k = text.indexOf('\n'); k >= 0 && k < offset; k = text.indexOf('\n', k + 1)) n++
  return n
}

// applyText makes the textarea hold newText by replacing only the part that differs, so undo history
// and the caret survive (used to trim whitespace on save, format JSON and similar whole-text edits).
export function applyText(ed, newText) {
  const old = ed.value
  if (old === newText) return
  let a = 0
  while (a < old.length && a < newText.length && old[a] === newText[a]) a++
  let bo = old.length, bn = newText.length
  while (bo > a && bn > a && old[bo - 1] === newText[bn - 1]) { bo--; bn-- }
  const caret = ed.selectionStart, delta = newText.length - old.length
  const next = caret <= a ? caret : caret >= bo ? caret + delta : a + (bn - a)
  replaceRange(ed, a, bo, newText.slice(a, bn), next)
}
