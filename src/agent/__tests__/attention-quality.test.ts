import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { computeAttentionQuality, extractAttentionMetrics, type AttentionQualityMetrics } from '../sensorium.js'

describe('computeAttentionQuality', () => {
  it('returns high quality for balanced context', () => {
    const metrics: AttentionQualityMetrics = {
      toolDensity: 0.3,
      uniqueToolRatio: 0.8,
      avgToolResultSize: 500,
      userMessageRatio: 0.3,
    }
    const aqs = computeAttentionQuality(metrics)
    assert.ok(aqs > 0.6, `expected high quality, got ${aqs}`)
  })

  it('returns low quality for grep storm pattern', () => {
    const metrics: AttentionQualityMetrics = {
      toolDensity: 0.9,
      uniqueToolRatio: 0.1,
      avgToolResultSize: 2000,
      userMessageRatio: 0.05,
      toolStormLevel: 'storm',
    }
    const aqs = computeAttentionQuality(metrics)
    assert.ok(aqs < 0.3, `expected low quality, got ${aqs}`)
  })

  it('penalizes high tool density', () => {
    const low = computeAttentionQuality({
      toolDensity: 0.2, uniqueToolRatio: 0.5, avgToolResultSize: 500, userMessageRatio: 0.3,
    })
    const high = computeAttentionQuality({
      toolDensity: 0.9, uniqueToolRatio: 0.5, avgToolResultSize: 500, userMessageRatio: 0.3,
    })
    assert.ok(low > high, 'low density should have higher quality')
  })

  it('penalizes tool storm', () => {
    const base: AttentionQualityMetrics = {
      toolDensity: 0.5, uniqueToolRatio: 0.5, avgToolResultSize: 1000, userMessageRatio: 0.2,
    }
    const noStorm = computeAttentionQuality({ ...base, toolStormLevel: 'none' })
    const warn = computeAttentionQuality({ ...base, toolStormLevel: 'warn' })
    const storm = computeAttentionQuality({ ...base, toolStormLevel: 'storm' })
    assert.ok(noStorm > warn, 'no storm should be higher quality than warn')
    assert.ok(warn > storm, 'warn should be higher quality than storm')
  })

  it('clamps result to [0, 1]', () => {
    const extreme: AttentionQualityMetrics = {
      toolDensity: 1, uniqueToolRatio: 0, avgToolResultSize: 100_000, userMessageRatio: 0, toolStormLevel: 'storm',
    }
    const aqs = computeAttentionQuality(extreme)
    assert.ok(aqs >= 0 && aqs <= 1, `expected clamped value, got ${aqs}`)
  })
})

describe('extractAttentionMetrics', () => {
  it('handles empty messages', () => {
    const metrics = extractAttentionMetrics([])
    assert.equal(metrics.toolDensity, 0)
    assert.equal(metrics.userMessageRatio, 1)
  })

  it('computes tool density correctly', () => {
    const messages = [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi' },
      { role: 'tool', content: 'result1' },
      { role: 'tool', content: 'result2' },
    ]
    const metrics = extractAttentionMetrics(messages)
    assert.equal(metrics.toolDensity, 0.5)
    assert.equal(metrics.userMessageRatio, 0.25)
  })

  it('computes average tool result size', () => {
    const messages = [
      { role: 'tool', content: 'x'.repeat(1000) },
      { role: 'tool', content: 'y'.repeat(3000) },
    ]
    const metrics = extractAttentionMetrics(messages)
    assert.equal(metrics.avgToolResultSize, 2000)
  })

  it('respects recentWindow parameter', () => {
    const messages = [
      ...Array.from({ length: 10 }, () => ({ role: 'tool', content: 'old' })),
      { role: 'user', content: 'recent' },
      { role: 'assistant', content: 'reply' },
    ]
    const metrics = extractAttentionMetrics(messages, 3)
    assert.ok(metrics.toolDensity < 0.5, 'recent window should have low tool density')
  })
})
