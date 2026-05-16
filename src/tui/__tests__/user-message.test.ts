import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { UserMessage } from '../user-message.js'

describe('UserMessage', () => {
  it('exports UserMessage component', () => {
    assert.ok(UserMessage, 'UserMessage should be defined')
    assert.equal(typeof UserMessage, 'object')
  })
})
