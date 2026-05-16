import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { AssistantMessage } from '../assistant-message.js'

describe('AssistantMessage', () => {
  it('exports AssistantMessage component', () => {
    assert.ok(AssistantMessage, 'AssistantMessage should be defined')
    assert.equal(typeof AssistantMessage, 'object')
  })
})
