import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { buildProactiveContext } from '../proactive-inject.js'
import type { ContextAnchor } from '../types.js'

describe('buildProactiveContext', () => {
  const anchors: ContextAnchor[] = [
    { kind: 'user_preference', text: 'Use TDD for all new features', sourceRoundIndex: 2, salience: 0.9 },
    { kind: 'decision', text: 'Chose Zod for validation', sourceRoundIndex: 5, salience: 0.7 },
  ]

  it('builds XML block from anchors', () => {
    const block = buildProactiveContext(anchors, [])
    assert.match(block, /<active-constraints>/)
    assert.match(block, /Use TDD/)
    assert.match(block, /Chose Zod/)
  })

  it('respects token budget', () => {
    const block = buildProactiveContext(anchors, [], { maxTokens: 10 })
    assert.match(block, /Use TDD/)
  })

  it('returns empty string when no anchors', () => {
    const block = buildProactiveContext([], [])
    assert.equal(block, '')
  })
})
