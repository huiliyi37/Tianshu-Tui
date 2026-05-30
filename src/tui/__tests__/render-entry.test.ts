import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { renderMemoKey } from '../render-entry.js'
import { createLogEntry } from '../log-state.js'

describe('renderMemoKey', () => {
  it('returns different keys for different types', () => {
    const a = createLogEntry({ type: 'user_message', content: 'hi' })
    const b = createLogEntry({ type: 'assistant_message', content: 'hi' })
    assert.notEqual(renderMemoKey(a), renderMemoKey(b))
  })

  it('returns same key for same id and content', () => {
    const a = createLogEntry({ type: 'user_message', content: 'hello' })
    const b = { ...a, content: 'hello' }
    assert.equal(renderMemoKey(a), renderMemoKey(b))
  })

  it('returns different keys when content changes', () => {
    const a = createLogEntry({ type: 'user_message', content: 'hello' })
    const b = createLogEntry({ type: 'user_message', content: 'world' })
    assert.notEqual(renderMemoKey(a), renderMemoKey(b))
  })

  it('handles undefined content', () => {
    const a = createLogEntry({ type: 'system', content: '' })
    assert.ok(typeof renderMemoKey(a) === 'string')
  })

  it('supports turn_summary entries', () => {
    const a = createLogEntry({ type: 'turn_summary', content: '⭐ → 🔨 · 读5 改3 · 2m14s' })
    assert.ok(typeof renderMemoKey(a) === 'string')
    assert.match(renderMemoKey(a), /^turn_summary:/)
  })
})
