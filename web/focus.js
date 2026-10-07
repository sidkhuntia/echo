// Where Tab goes inside an open dialog: focus cycles through the dialog's controls and never leaves it.
// items are the dialog's focusable elements in order. Returns the element to focus, or null when there are none.
// Focus outside the dialog (or nowhere) goes to the first control, or the last one for Shift-Tab.
export function nextInDialog(items, active, shift) {
  if (!items.length) return null
  const i = items.indexOf(active)
  if (i < 0) return shift ? items[items.length - 1] : items[0]
  return shift ? items[(i - 1 + items.length) % items.length] : items[(i + 1) % items.length]
}
