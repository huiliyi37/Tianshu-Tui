import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { nextHistoryAfterSubmit } from '../history.js'

describe('prompt history helpers', () => {
  it('adds newest entry to the front', () => {
    assert.deepEqual(nextHistoryAfterSubmit(['old'], 'new'), ['new', 'old'])
  })

  it('does not duplicate the current newest entry', () => {
    assert.deepEqual(nextHistoryAfterSubmit(['same', 'old'], 'same'), ['same', 'old'])
  })

  it('ignores blank input', () => {
    assert.deepEqual(nextHistoryAfterSubmit(['old'], '   '), ['old'])
  })
})
