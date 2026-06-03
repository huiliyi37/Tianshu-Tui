import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { Sensorium } from '../sensorium.js'
import { createVigorState } from '../vigor.js'
import {
  decayImportance,
  deduplicateBullets,
  enforceCapacity,
  extractBullets,
  matchBullets,
  shouldReflect,
  detectCrossSessionPatterns,
  suppressStalePatterns,
  shouldRunREM,
  type PlaybookBullet,
} from '../playbook.js'
import type { RetrospectFingerprint } from '../retrospect-fingerprint.js'

function makeSensorium(overrides: Partial<Sensorium> = {}): Sensorium {
  return {
    momentum: 0.8,
    pressure: 0.2,
    confidence: 0.9,
    complexity: 0.2,
    freshness: 0.5,
    stability: 0.9,
    ...overrides,
  }
}

function bullet(id: string, overrides: Partial<PlaybookBullet> = {}): PlaybookBullet {
  return {
    id,
    createdAt: 1_000,
    keywords: ['agent', id],
    lesson: `lesson ${id}`,
    context: `context ${id}`,
    useCount: 0,
    lastUsedAt: null,
    importance: 0.5,
    ...overrides,
  }
}

describe('playbook core', () => {
  it('does not reflect on smooth successful sessions', () => {
    const result = shouldReflect(
      createVigorState({ variability: 0.1 }),
      makeSensorium({ stability: 0.4 }),
      'blocked',
    )

    assert.equal(result, false)
  })

  it('reflects on high vigor variability', () => {
    const result = shouldReflect(
      createVigorState({ variability: 0.35 }),
      makeSensorium(),
      'none',
    )

    assert.equal(result, true)
  })

  it('reflects on low stability or doom loop when not smooth', () => {
    assert.equal(shouldReflect(createVigorState({ variability: 0.2 }), makeSensorium({ stability: 0.3 }), 'none'), true)
    assert.equal(shouldReflect(createVigorState({ variability: 0.2 }), makeSensorium(), 'blocked'), true)
  })

  it('extracts delta bullets from root cause and recommendation sections', () => {
    const bullets = extractBullets(`# Session Retrospective

## 3. 根因判定

- **Probable Cause**: 验证反馈不足 + 策略振荡组合
- **Contributing Factors**: 上下文压力、任务拆解粒度、工具输出截断策略

## 4. 寻址建议

- **致系统设计**: 检查 doom loop 检测阈值是否过于敏感
- **致用户**: 考虑在关键修改后手动运行测试验证
`, { now: 10_000 })

    assert.ok(bullets.length >= 2)
    assert.ok(bullets.length <= 3)
    assert.ok(bullets.some(b => b.lesson.includes('验证反馈不足')))
    assert.ok(bullets.some(b => b.lesson.includes('检查 doom loop')))
    assert.ok(bullets.every(b => b.createdAt === 10_000))
    assert.ok(bullets.every(b => b.keywords.length > 0))
  })

  it('deduplicates similar bullets by keyword overlap and boosts importance', () => {
    const existing = [bullet('a', {
      keywords: ['verification', 'tests', 'agent'],
      lesson: 'Run targeted tests after key edits',
      importance: 0.4,
      useCount: 1,
    })]
    const incoming = [bullet('b', {
      keywords: ['verification', 'tests', 'coverage'],
      lesson: 'Run targeted tests after key edits',
      importance: 0.7,
    })]

    const merged = deduplicateBullets(existing, incoming)

    assert.equal(merged.length, 1)
    assert.equal(merged[0]!.id, 'a')
    assert.ok(merged[0]!.importance > 0.4)
    assert.equal(merged[0]!.useCount, 1)
  })

  it('matches bullets by keywords and updates usage metadata', () => {
    const playbook = [
      bullet('low', { keywords: ['api'], importance: 0.9 }),
      bullet('hit', { keywords: ['agent', 'tests'], importance: 0.3 }),
      bullet('best', { keywords: ['agent', 'tests', 'verification'], importance: 0.8 }),
    ]

    const matched = matchBullets(playbook, ['tests', 'agent'], 2, { now: 20_000 })

    assert.deepEqual(matched.map(b => b.id), ['best', 'hit'])
    assert.equal(matched[0]!.useCount, 1)
    assert.equal(matched[0]!.lastUsedAt, 20_000)
  })

  it('decays importance over age while preserving used bullets advantage', () => {
    const now = 31 * 24 * 60 * 60 * 1000
    const decayed = decayImportance([
      bullet('old', { createdAt: 0, useCount: 0, importance: 1 }),
      bullet('used', { createdAt: 0, useCount: 3, importance: 0.5 }),
    ], now)

    assert.ok(decayed[0]!.importance < 1)
    assert.ok(decayed[1]!.importance > decayed[0]!.importance)
  })

  it('enforces capacity but preserves dead-end bullets', () => {
    const playbook = [
      bullet('dead', { keywords: ['dead-end'], importance: 0.01 }),
      bullet('a', { importance: 0.2 }),
      bullet('b', { importance: 0.9 }),
      bullet('c', { importance: 0.8 }),
    ]

    const capped = enforceCapacity(playbook, 2)

    assert.ok(capped.some(b => b.id === 'dead'))
    assert.ok(capped.some(b => b.id === 'b'))
    assert.equal(capped.length, 2)
  })
})

describe('detectCrossSessionPatterns', () => {
  it('returns empty when fewer than 2 similar historical sessions', () => {
    const current: RetrospectFingerprint = {
      sessionId: 'current',
      createdAt: Date.now(),
      rootCauseKeywords: ['验证', '振荡'],
      recommendationKeywords: ['doom'],
      stabilityTrend: 'stable',
      confidenceTrend: 'stable',
      maxPressure: 0.5,
      toolFailureRate: 0,
      bulletIds: [],
    }
    const historical: RetrospectFingerprint[] = [
      {
        sessionId: 'sess-1',
        createdAt: Date.now() - 10000,
        rootCauseKeywords: ['缓存', '失效'],
        recommendationKeywords: ['重构'],
        stabilityTrend: 'stable',
        confidenceTrend: 'stable',
        maxPressure: 0.5,
        toolFailureRate: 0,
        bulletIds: [],
      },
    ]

    const patterns = detectCrossSessionPatterns(current, historical, [])
    assert.equal(patterns.length, 0)
  })

  it('creates pattern bullet when 2+ similar sessions match', () => {
    const current: RetrospectFingerprint = {
      sessionId: 'current',
      createdAt: Date.now(),
      rootCauseKeywords: ['验证', '振荡', '策略'],
      recommendationKeywords: ['doom'],
      stabilityTrend: 'stable',
      confidenceTrend: 'stable',
      maxPressure: 0.5,
      toolFailureRate: 0,
      bulletIds: [],
    }
    const historical: RetrospectFingerprint[] = [
      {
        sessionId: 'sess-1',
        createdAt: Date.now() - 10000,
        rootCauseKeywords: ['验证', '振荡', '反馈'],
        recommendationKeywords: ['doom', 'loop'],
        stabilityTrend: 'stable',
        confidenceTrend: 'stable',
        maxPressure: 0.5,
        toolFailureRate: 0,
        bulletIds: ['pb_1'],
      },
      {
        sessionId: 'sess-2',
        createdAt: Date.now() - 5000,
        rootCauseKeywords: ['验证', '振荡', '工具'],
        recommendationKeywords: ['doom', '阈值'],
        stabilityTrend: 'stable',
        confidenceTrend: 'stable',
        maxPressure: 0.5,
        toolFailureRate: 0,
        bulletIds: ['pb_2'],
      },
    ]

    const patterns = detectCrossSessionPatterns(current, historical, [])
    assert.ok(patterns.length > 0)
    assert.equal(patterns[0]!.context, 'pattern:recurring')
    assert.ok(patterns[0]!.keywords.some(k => k.includes('验证') || k.includes('振荡')))
  })

  it('boosts existing pattern bullet importance', () => {
    const current: RetrospectFingerprint = {
      sessionId: 'current',
      createdAt: Date.now(),
      rootCauseKeywords: ['验证', '振荡'],
      recommendationKeywords: ['doom'],
      stabilityTrend: 'stable',
      confidenceTrend: 'stable',
      maxPressure: 0.5,
      toolFailureRate: 0,
      bulletIds: [],
    }
    const historical: RetrospectFingerprint[] = [
      {
        sessionId: 'sess-1',
        createdAt: Date.now() - 10000,
        rootCauseKeywords: ['验证', '振荡'],
        recommendationKeywords: ['doom'],
        stabilityTrend: 'stable',
        confidenceTrend: 'stable',
        maxPressure: 0.5,
        toolFailureRate: 0,
        bulletIds: ['pb_1'],
      },
      {
        sessionId: 'sess-2',
        createdAt: Date.now() - 5000,
        rootCauseKeywords: ['验证', '振荡'],
        recommendationKeywords: ['doom'],
        stabilityTrend: 'stable',
        confidenceTrend: 'stable',
        maxPressure: 0.5,
        toolFailureRate: 0,
        bulletIds: ['pb_1'],
      },
    ]
    const existing = [bullet('existing', {
      context: 'pattern:recurring',
      keywords: ['验证', '振荡'],
      importance: 0.6,
      bulletIds: ['pb_1'],
    })]

    const patterns = detectCrossSessionPatterns(current, historical, existing)
    assert.ok(patterns.length > 0)
    assert.ok(patterns[0]!.importance > 0.6)
  })
})

describe('suppressStalePatterns', () => {
  it('suppresses patterns not seen in recent sessions', () => {
    const bullets = [bullet('pattern-1', {
      context: 'pattern:recurring',
      keywords: ['验证', '振荡'],
      importance: 0.7,
    })]
    const recentFingerprints: RetrospectFingerprint[] = [
      {
        sessionId: 'sess-1',
        createdAt: Date.now() - 10000,
        rootCauseKeywords: ['缓存', '失效'],
        recommendationKeywords: ['重构'],
        stabilityTrend: 'stable',
        confidenceTrend: 'stable',
        maxPressure: 0.5,
        toolFailureRate: 0,
        bulletIds: [],
      },
      {
        sessionId: 'sess-2',
        createdAt: Date.now() - 5000,
        rootCauseKeywords: ['工具', '超时'],
        recommendationKeywords: ['重试'],
        stabilityTrend: 'stable',
        confidenceTrend: 'stable',
        maxPressure: 0.5,
        toolFailureRate: 0,
        bulletIds: [],
      },
      {
        sessionId: 'sess-3',
        createdAt: Date.now() - 2000,
        rootCauseKeywords: ['测试', '失败'],
        recommendationKeywords: ['修复'],
        stabilityTrend: 'stable',
        confidenceTrend: 'stable',
        maxPressure: 0.5,
        toolFailureRate: 0,
        bulletIds: [],
      },
    ]

    const result = suppressStalePatterns(bullets, recentFingerprints)
    assert.equal(result[0]!.context, 'pattern:suppressed')
    assert.ok(result[0]!.importance < 0.7)
  })

  it('keeps patterns that appeared recently', () => {
    const bullets = [bullet('pattern-1', {
      context: 'pattern:recurring',
      keywords: ['验证', '振荡'],
      importance: 0.7,
    })]
    const recentFingerprints: RetrospectFingerprint[] = [
      {
        sessionId: 'sess-1',
        createdAt: Date.now() - 10000,
        rootCauseKeywords: ['验证', '振荡'],
        recommendationKeywords: ['doom'],
        stabilityTrend: 'stable',
        confidenceTrend: 'stable',
        maxPressure: 0.5,
        toolFailureRate: 0,
        bulletIds: ['pattern-1'],
      },
      {
        sessionId: 'sess-2',
        createdAt: Date.now() - 5000,
        rootCauseKeywords: ['工具', '超时'],
        recommendationKeywords: ['重试'],
        stabilityTrend: 'stable',
        confidenceTrend: 'stable',
        maxPressure: 0.5,
        toolFailureRate: 0,
        bulletIds: [],
      },
      {
        sessionId: 'sess-3',
        createdAt: Date.now() - 2000,
        rootCauseKeywords: ['测试', '失败'],
        recommendationKeywords: ['修复'],
        stabilityTrend: 'stable',
        confidenceTrend: 'stable',
        maxPressure: 0.5,
        toolFailureRate: 0,
        bulletIds: [],
      },
    ]

    const result = suppressStalePatterns(bullets, recentFingerprints)
    assert.equal(result[0]!.context, 'pattern:recurring')
    assert.equal(result[0]!.importance, 0.7)
  })

  it('does not suppress when fewer than threshold fingerprints', () => {
    const bullets = [bullet('pattern-1', {
      context: 'pattern:recurring',
      keywords: ['验证'],
      importance: 0.7,
    })]
    const recentFingerprints: RetrospectFingerprint[] = [
      {
        sessionId: 'sess-1',
        createdAt: Date.now() - 10000,
        rootCauseKeywords: ['缓存'],
        recommendationKeywords: ['重构'],
        stabilityTrend: 'stable',
        confidenceTrend: 'stable',
        maxPressure: 0.5,
        toolFailureRate: 0,
        bulletIds: [],
      },
    ]

    const result = suppressStalePatterns(bullets, recentFingerprints, 3)
    assert.equal(result[0]!.context, 'pattern:recurring')
    assert.equal(result[0]!.importance, 0.7)
  })
})

describe('shouldRunREM', () => {
  it('returns full when shouldReflect passes', () => {
    const result = shouldRunREM(
      createVigorState({ variability: 0.35 }),
      makeSensorium(),
      'none',
      0,
    )
    assert.equal(result, 'full')
  })

  it('returns light when shouldReflect fails but sessionCount >= 2', () => {
    const result = shouldRunREM(
      createVigorState({ variability: 0.1 }),
      makeSensorium({ stability: 0.9 }),
      'none',
      3,
    )
    assert.equal(result, 'light')
  })

  it('returns skip when shouldReflect fails and sessionCount < 2', () => {
    const result = shouldRunREM(
      createVigorState({ variability: 0.1 }),
      makeSensorium({ stability: 0.9 }),
      'none',
      1,
    )
    assert.equal(result, 'skip')
  })
})
