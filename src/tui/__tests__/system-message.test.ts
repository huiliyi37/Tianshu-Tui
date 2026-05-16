import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { SystemMessage } from '../system-message.js'

describe('SystemMessage', () => {
  it('exports SystemMessage component', () => {
    assert.ok(SystemMessage, 'SystemMessage should be defined')
    assert.equal(typeof SystemMessage, 'object')
  })
})
