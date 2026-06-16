import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildRetrospectFingerprint,
  fingerprintSimilarity,
  serializeFingerprint,
  deserializeFingerprint,
  type RetrospectFingerprint,
} from '../retrospect-fingerprint.js'

const SAMPLE_REPORT = `# Session Retrospective

## 3. 根因判定

- **Probable Cause**: 验证反馈不足 + 策略振荡组合
- **Contributing Factors**: 上下文压力、任务拆解粒度、工具输出截断策略

## 4. 寻址建议

- **致系统设计**: 检查 doom loop 检测阈值是否过于敏感
- **致用户**: 考虑在关键修改后手动运行测试验证
`

describe('buildRetrospectFingerprint', () => {
  it('extracts keywords from root cause and recommendation sections', () => {
    const fp = buildRetrospectFingerprint('sess-1', SAMPLE_REPORT, [], { now: 1000 })

    assert.equal(fp.sessionId, 'sess-1')
    assert.equal(fp.createdAt, 1000)
    assert.ok(fp.rootCauseKeywords.length > 0)
    assert.ok(fp.recommendationKeywords.length > 0)
    assert.ok(fp.rootCauseKeywords.some(k => k.includes('验证') || k.includes('振荡')))
    assert.ok(fp.recommendationKeywords.some(k => k.includes('doom') || k.includes('loop')))
    assert.deepEqual(fp.bulletIds, [])
  })

  it('collects bullet IDs from provided bullets', () => {
    const bullets = [
      { id: 'pb_abc', createdAt: 0, keywords: [], lesson: '', context: '', useCount: 0, lastUsedAt: null, importance: 0.5 },
      { id: 'pb_def', createdAt: 0, keywords: [], lesson: '', context: '', useCount: 0, lastUsedAt: null, importance: 0.5 },
    ]
    const fp = buildRetrospectFingerprint('sess-2', SAMPLE_REPORT, bullets)

    assert.deepEqual(fp.bulletIds, ['pb_abc', 'pb_def'])
  })

  it('uses trend overrides when provided', () => {
    const fp = buildRetrospectFingerprint('sess-3', SAMPLE_REPORT, [], {
      stabilityTrend: 'falling',
      confidenceTrend: 'rising',
      maxPressure: 0.9,
      toolFailureRate: 0.3,
    })

    assert.equal(fp.stabilityTrend, 'falling')
    assert.equal(fp.confidenceTrend, 'rising')
    assert.equal(fp.maxPressure, 0.9)
    assert.equal(fp.toolFailureRate, 0.3)
  })

  it('returns empty keywords for empty report', () => {
    const fp = buildRetrospectFingerprint('sess-4', '', [])

    assert.deepEqual(fp.rootCauseKeywords, [])
    assert.deepEqual(fp.recommendationKeywords, [])
  })
})

describe('fingerprintSimilarity', () => {
  it('returns 1 for identical keywords', () => {
    const a: RetrospectFingerprint = {
      sessionId: 'a', createdAt: 0,
      rootCauseKeywords: ['验证', '振荡'],
      recommendationKeywords: ['doom'],
      stabilityTrend: 'stable', confidenceTrend: 'stable',
      maxPressure: 0.5, toolFailureRate: 0, bulletIds: [],
    }
    const b: RetrospectFingerprint = { ...a, sessionId: 'b' }

    assert.equal(fingerprintSimilarity(a, b), 1)
  })

  it('returns 0 for disjoint keywords', () => {
    const a: RetrospectFingerprint = {
      sessionId: 'a', createdAt: 0,
      rootCauseKeywords: ['验证'],
      recommendationKeywords: ['doom'],
      stabilityTrend: 'stable', confidenceTrend: 'stable',
      maxPressure: 0.5, toolFailureRate: 0, bulletIds: [],
    }
    const b: RetrospectFingerprint = {
      sessionId: 'b', createdAt: 0,
      rootCauseKeywords: ['缓存'],
      recommendationKeywords: ['重构'],
      stabilityTrend: 'stable', confidenceTrend: 'stable',
      maxPressure: 0.5, toolFailureRate: 0, bulletIds: [],
    }

    assert.equal(fingerprintSimilarity(a, b), 0)
  })

  it('applies trend mismatch penalty', () => {
    const base: RetrospectFingerprint = {
      sessionId: 'a', createdAt: 0,
      rootCauseKeywords: ['验证', '振荡'],
      recommendationKeywords: ['doom'],
      stabilityTrend: 'stable', confidenceTrend: 'stable',
      maxPressure: 0.5, toolFailureRate: 0, bulletIds: [],
    }
    const sameTrend = { ...base, sessionId: 'b' }
    const diffTrend = { ...base, sessionId: 'c', stabilityTrend: 'falling' as const }

    const similar = fingerprintSimilarity(base, sameTrend)
    const penalized = fingerprintSimilarity(base, diffTrend)

    assert.ok(penalized < similar)
    assert.ok(penalized > 0)
  })

  it('handles empty keyword sets', () => {
    const a: RetrospectFingerprint = {
      sessionId: 'a', createdAt: 0,
      rootCauseKeywords: [],
      recommendationKeywords: [],
      stabilityTrend: 'stable', confidenceTrend: 'stable',
      maxPressure: 0.5, toolFailureRate: 0, bulletIds: [],
    }
    const b: RetrospectFingerprint = { ...a, sessionId: 'b' }

    // Two empty sets have overlap 0 (no signal, not similar)
    assert.equal(fingerprintSimilarity(a, b), 0)
  })
})

describe('serializeFingerprint / deserializeFingerprint', () => {
  it('round-trips correctly', () => {
    const original: RetrospectFingerprint = {
      sessionId: 'sess-5',
      createdAt: 12345,
      rootCauseKeywords: ['验证', '振荡'],
      recommendationKeywords: ['doom', 'loop'],
      stabilityTrend: 'falling',
      confidenceTrend: 'rising',
      maxPressure: 0.8,
      toolFailureRate: 0.25,
      bulletIds: ['pb_abc', 'pb_def'],
    }

    const serialized = serializeFingerprint(original)
    const deserialized = deserializeFingerprint(serialized)

    assert.deepEqual(deserialized, original)
  })

  it('handles empty arrays', () => {
    const original: RetrospectFingerprint = {
      sessionId: 'sess-6',
      createdAt: 0,
      rootCauseKeywords: [],
      recommendationKeywords: [],
      stabilityTrend: 'stable',
      confidenceTrend: 'stable',
      maxPressure: 0,
      toolFailureRate: 0,
      bulletIds: [],
    }

    const serialized = serializeFingerprint(original)
    assert.equal(serialized.root_cause_keywords, '[]')
    assert.equal(serialized.bullet_ids, '[]')
  })
})
