import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { buildUncertaintyFraming } from '../uncertainty-framing.js'

describe('uncertainty framing — 万物为一原则④', () => {
  it('generates hint when confidence < 0.4 and risk is high', () => {
    const result = buildUncertaintyFraming({ confidence: 0.3, riskLevel: 'high' })
    assert.equal(result.shouldFrame, true)
    assert.ok(result.hint !== null)
    assert.ok(result.hint!.length > 0)
  })

  it('generates hint when confidence < 0.4 and risk is medium', () => {
    const result = buildUncertaintyFraming({ confidence: 0.2, riskLevel: 'medium' })
    assert.equal(result.shouldFrame, true)
    assert.ok(result.hint !== null)
  })

  it('does not trigger when confidence >= 0.4', () => {
    const result = buildUncertaintyFraming({ confidence: 0.5, riskLevel: 'high' })
    assert.equal(result.shouldFrame, false)
    assert.equal(result.hint, null)
  })

  it('does not trigger when risk is low', () => {
    const result = buildUncertaintyFraming({ confidence: 0.3, riskLevel: 'low' })
    assert.equal(result.shouldFrame, false)
    assert.equal(result.hint, null)
  })

  it('does not trigger when risk is none', () => {
    const result = buildUncertaintyFraming({ confidence: 0.1, riskLevel: 'none' })
    assert.equal(result.shouldFrame, false)
  })

  it('includes tool name in hint when provided', () => {
    const result = buildUncertaintyFraming({
      confidence: 0.3,
      riskLevel: 'high',
      toolName: 'bash',
    })
    assert.ok(result.hint!.includes('bash'))
  })

  it('hint includes confidence value', () => {
    const result = buildUncertaintyFraming({ confidence: 0.25, riskLevel: 'high' })
    assert.ok(result.hint!.includes('0.25'))
  })

  it('boundary: exactly 0.4 does not trigger', () => {
    const result = buildUncertaintyFraming({ confidence: 0.4, riskLevel: 'high' })
    assert.equal(result.shouldFrame, false)
  })

  it('boundary: just below 0.4 triggers', () => {
    const result = buildUncertaintyFraming({ confidence: 0.39, riskLevel: 'high' })
    assert.equal(result.shouldFrame, true)
  })
})
