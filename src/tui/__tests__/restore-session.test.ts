import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { selectRestorableSessions } from '../restore-session.js'

describe('selectRestorableSessions (S11)', () => {
  it('excludes the current session id', () => {
    assert.deepEqual(selectRestorableSessions(['a', 'b', 'cur'], 'cur'), ['a', 'b'])
  })
  it('returns empty when only current session exists', () => {
    assert.deepEqual(selectRestorableSessions(['cur'], 'cur'), [])
  })
  it('returns empty for empty input', () => {
    assert.deepEqual(selectRestorableSessions([], 'cur'), [])
  })
  it('returns all when current id is not in list', () => {
    assert.deepEqual(selectRestorableSessions(['a', 'b'], 'cur'), ['a', 'b'])
  })
})
