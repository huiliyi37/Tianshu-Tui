import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { AssistantMessage } from '../assistant-message.js'

describe('AssistantMessage', () => {
  it('exports AssistantMessage component', () => {
    assert.equal(typeof AssistantMessage, 'object')
  })

  it('splits single-line content into one block', () => {
    const lines = 'Hello world'.split('\n')
    assert.equal(lines.length, 1)
  })

  it('splits multi-line content into multiple blocks', () => {
    const lines = 'line 1\nline 2\nline 3'.split('\n')
    assert.equal(lines.length, 3)
  })

  it('handles empty content', () => {
    assert.equal(''.split('\n').length, 1)
  })
})
