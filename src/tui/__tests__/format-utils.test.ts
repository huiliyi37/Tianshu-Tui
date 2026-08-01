import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { truncate } from '../format-utils.js'

const ELL = String.fromCharCode(8230) // …

describe('truncate', () => {
  it('returns the string unchanged when within max', () => {
    assert.equal(truncate('hello', 10), 'hello')
  })

  it('appends an ellipsis and stays within max when longer', () => {
    const out = truncate('hello world', 5)
    assert.equal(out, 'hell' + ELL)
    assert.equal(out.length, 5)
  })

  it('handles max === 1 without a negative slice index', () => {
    assert.equal(truncate('ab', 1), ELL)
    assert.equal(truncate('a', 1), 'a')
  })

  it('returns empty string for max <= 0', () => {
    assert.equal(truncate('hello', 0), '')
    assert.equal(truncate('hello', -1), '')
  })

  it('handles empty input', () => {
    assert.equal(truncate('', 5), '')
  })
})
