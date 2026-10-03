import test from 'node:test'
import assert from 'node:assert/strict'
import { baseOf, withBase, storeKey } from './base.js'

test('baseOf finds the repository prefix of a workspace page', () => {
  assert.equal(baseOf('/r/provider-backend/'), '/r/provider-backend')
  assert.equal(baseOf('/r/group~inner/'), '/r/group~inner')
  assert.equal(baseOf('/r/a%20b/'), '/r/a%20b')
  assert.equal(baseOf('/'), '')
  assert.equal(baseOf('/api/git/status'), '')
})

test('withBase prefixes only API paths', () => {
  assert.equal(withBase('/api/git/status', '/r/x'), '/r/x/api/git/status')
  assert.equal(withBase('/ws/repos', '/r/x'), '/ws/repos')
  assert.equal(withBase('/api/raw?path=a', ''), '/api/raw?path=a')
})

test('storeKey separates repositories in one origin, and leaves a single repository alone', () => {
  assert.equal(storeKey('echo:session', '', ''), 'echo:session')
  assert.equal(storeKey('echo:session', '/r/api', 'api'), 'echo:session:api')
  assert.notEqual(storeKey('echo:session', '/r/api', 'api'), storeKey('echo:session', '/r/web', 'web'))
})
