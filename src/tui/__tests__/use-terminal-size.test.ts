import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { getTerminalSizeSnapshot } from '../use-terminal-size.js'

describe('useTerminalSize', () => {
  it('returns the same snapshot object when terminal size is unchanged', () => {
    const first = getTerminalSizeSnapshot()
    const second = getTerminalSizeSnapshot()

    assert.equal(first, second)
  })
})
