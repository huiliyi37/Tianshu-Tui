import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { buildSeedPrompt } from '../seed-prompt-builder.js'
import type { SealedAnchor } from '../anchor-vault.js'

describe('buildSeedPrompt', () => {
  const sealed: SealedAnchor = {
    phrases: ['auth', 'OAuth2', 'module', 'refactor'],
    original: 'refactor auth module to support OAuth2',
    sealedAt: Date.now(),
  }

  it('includes forbidden keywords from anchor', () => {
    const prompt = buildSeedPrompt(sealed, 0)
    assert.ok(prompt.includes('auth'))
    assert.ok(prompt.includes('OAuth2'))
    assert.ok(prompt.includes('禁止使用'))
  })

  it('includes branch index', () => {
    const p0 = buildSeedPrompt(sealed, 0)
    const p2 = buildSeedPrompt(sealed, 2)
    assert.ok(p0.includes('Branch #1'))
    assert.ok(p2.includes('Branch #3'))
  })

  it('includes original task for context', () => {
    const prompt = buildSeedPrompt(sealed, 0)
    assert.ok(prompt.includes(sealed.original))
  })

  it('instructs straight-line thinking', () => {
    const prompt = buildSeedPrompt(sealed, 0)
    assert.ok(prompt.includes('直线推理') || prompt.includes('第一性原理'))
  })
})
