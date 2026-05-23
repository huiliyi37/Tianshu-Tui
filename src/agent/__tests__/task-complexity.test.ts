import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { classifyComplexity } from '../task-complexity.js'

describe('task-complexity', () => {
  it('classifies simple read operations as low', () => {
    const result = classifyComplexity({
      userMessage: 'read the file src/foo.ts',
      recentTools: ['read_file', 'read_file'],
      turnCount: 2,
    })
    assert.equal(result, 'low')
  })

  it('classifies debugging with multiple failures as high', () => {
    const result = classifyComplexity({
      userMessage: 'fix this test that keeps failing',
      recentTools: ['bash', 'edit_file', 'bash', 'edit_file', 'bash'],
      turnCount: 8,
    })
    assert.equal(result, 'high')
  })

  it('classifies architecture questions as high', () => {
    const result = classifyComplexity({
      userMessage: 'refactor the entire module to use dependency injection',
      recentTools: [],
      turnCount: 1,
    })
    assert.equal(result, 'high')
  })

  it('classifies single file edits as low', () => {
    const result = classifyComplexity({
      userMessage: 'rename this variable from foo to bar',
      recentTools: ['read_file'],
      turnCount: 1,
    })
    assert.equal(result, 'low')
  })
})
