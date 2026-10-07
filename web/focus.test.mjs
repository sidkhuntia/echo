import test from 'node:test'
import assert from 'node:assert/strict'
import { nextInDialog } from './focus.js'

test('Tab cycles through a dialog and wraps at both ends', () => {
  const [a, b, c] = ['a', 'b', 'c']
  assert.equal(nextInDialog([a, b, c], a, false), b)
  assert.equal(nextInDialog([a, b, c], c, false), a)
  assert.equal(nextInDialog([a, b, c], a, true), c)
  assert.equal(nextInDialog([a, b, c], b, true), a)
})

test('focus outside the dialog is pulled back in', () => {
  assert.equal(nextInDialog(['a', 'b'], 'elsewhere', false), 'a')
  assert.equal(nextInDialog(['a', 'b'], 'elsewhere', true), 'b')
})

test('a dialog with nothing focusable has no target', () => {
  assert.equal(nextInDialog([], undefined, false), null)
})
