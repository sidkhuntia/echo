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
