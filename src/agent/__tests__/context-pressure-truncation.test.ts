import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { enforceContextPressureTruncation } from '../per-message-budget.js'

describe('enforceContextPressureTruncation', () => {
  it('does not truncate when usage ratio is below 70%', () => {
    const results = [
      { toolUseId: '1', content: Array.from({ length: 100 }, (_, i) => `line ${i}`).join('\n'), toolName: 'read_file' },
    ]
    // 60% usage — below threshold
    const enforced = enforceContextPressureTruncation(results, 0.6)
    assert.equal(enforced[0]!.content, results[0]!.content)
  })

  it('truncates large read_file results when usage ratio > 70%', () => {
    const lines = Array.from({ length: 100 }, (_, i) => `line ${i}: ${'x'.repeat(50)}`)
    const bigContent = lines.join('\n')
    const results = [
      { toolUseId: '1', content: bigContent, toolName: 'read_file' },
    ]
    const enforced = enforceContextPressureTruncation(results, 0.8)
    assert.ok(enforced[0]!.content.length < bigContent.length)
    assert.match(enforced[0]!.content, /context pressure/)
    // Should keep first 30 lines
    assert.ok(enforced[0]!.content.includes('line 29'))
    // Should NOT include line 35
    assert.ok(!enforced[0]!.content.includes('line 35'))
  })

  it('does not truncate short read_file results even at high pressure', () => {
    const shortContent = Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n')
    const results = [
      { toolUseId: '1', content: shortContent, toolName: 'read_file' },
    ]
    const enforced = enforceContextPressureTruncation(results, 0.9)
    assert.equal(enforced[0]!.content, shortContent)
  })

  it('does not truncate non-read_file tools', () => {
    const bigContent = Array.from({ length: 100 }, (_, i) => `line ${i}`).join('\n')
    const results = [
      { toolUseId: '1', content: bigContent, toolName: 'bash' },
    ]
    const enforced = enforceContextPressureTruncation(results, 0.9)
    assert.equal(enforced[0]!.content, bigContent)
  })

  it('does not truncate content under 2000 chars even at high pressure', () => {
    const smallContent = Array.from({ length: 40 }, (_, i) => `x`).join('\n') // ~80 chars
    const results = [
      { toolUseId: '1', content: smallContent, toolName: 'read_file' },
    ]
    const enforced = enforceContextPressureTruncation(results, 0.9)
    assert.equal(enforced[0]!.content, smallContent)
  })
})
