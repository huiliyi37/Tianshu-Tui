import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { appendStreamWindow } from '../stream-window.js'

describe('appendStreamWindow', () => {
  it('keeps full text when under the limit', () => {
    assert.equal(appendStreamWindow('hello', ' world', 20), 'hello world')
  })

  it('keeps only the tail with a truncation marker when over the limit', () => {
    const result = appendStreamWindow('abcdefghij', 'klmnop', 8)

    assert.match(result, /^… truncated live stream output …\n/)
    assert.equal(result.endsWith('ijklmnop'), true)
    assert.equal(result.length <= '… truncated live stream output …\n'.length + 8, true)
  })
})
