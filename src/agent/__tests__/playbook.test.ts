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
  distillFromFailures,
  type PlaybookBullet,
} from '../playbook.js'
import type { RetrospectFingerprint } from '../retrospect-fingerprint.js'
import type { FailureEntry, FailurePattern } from '../failure-journal.js'

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

- **Probable Cause**: hash_edit 在 cron-scheduler.ts 误删紧随的 if 块
- **Contributing Factors**: anchor 替换跨越了相邻语句边界

## 4. 寻址建议

- **致系统设计**: hash_edit 替换前校验 anchor 不跨越语句块
- **致用户**: 改用 edit_file 做多行结构替换
`, { now: 10_000 })

    assert.ok(bullets.length >= 2)
    assert.ok(bullets.length <= 3)
    assert.ok(bullets.some(b => b.lesson.includes('hash_edit')))
    assert.ok(bullets.every(b => b.createdAt === 10_000))
    assert.ok(bullets.every(b => b.keywords.length > 0))
  })

  it('filters out retrospect template boilerplate (zero-signal canned lines)', () => {
    // These are the fixed strings retrospect.ts emits by metric threshold; they
    // carry no session-specific signal and must not enter the playbook.
    const bullets = extractBullets(`# Session Retrospective

## 3. 根因判定

- **Probable Cause**: 验证反馈不足 + 策略振荡组合
- **Contributing Factors**: 上下文压力、任务拆解粒度、工具输出截断策略

## 4. 寻址建议

- **致系统设计**: 检查 doom loop 检测阈值是否过于敏感
- **致用户**: 考虑在关键修改后手动运行测试验证
`, { now: 10_000 })

    assert.equal(bullets.length, 0, 'template boilerplate must be blocked at the gate')
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
    assert.equal(matched[0]!.useCount, 0, 'matchBullets should not bump useCount')
    assert.equal(matched[0]!.lastUsedAt, null, 'matchBullets should not set lastUsedAt')
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
    assert.ok(patterns[0]!.lesson.includes('建议关注'), 'lesson should include actionable recommendations')
    assert.ok(patterns[0]!.lesson.includes('doom') || patterns[0]!.lesson.includes('阈值'),
      'lesson should surface recommendation keywords from fingerprints')
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

describe('distillFromFailures', () => {
  const NOW = 1700000000000

  function makeEntry(overrides: Partial<FailureEntry> = {}): FailureEntry {
    return {
      turn: 1,
      tool: 'edit_file',
      error: 'TS2322 type mismatch',
      context: 'fix type issue',
      timestamp: NOW - 5000,
      ...overrides,
    }
  }

  function makePattern(overrides: Partial<FailurePattern> = {}): FailurePattern {
    return {
      type: 'anchoring',
      count: 3,
      evidence: [makeEntry({ target: 'src/foo.ts', hypothesis: 'wrong type cast' })],
      suggestion: '尝试换一种类型转换方式',
      ...overrides,
    }
  }

  it('returns empty for no entries', () => {
    assert.deepEqual(distillFromFailures([], [], { now: NOW }), [])
  })

  it('distills from detected patterns', () => {
    const entries = [makeEntry()]
    const patterns = [makePattern()]
    const bullets = distillFromFailures(entries, patterns, { now: NOW })
    assert.equal(bullets.length, 1)
    assert.ok(bullets[0]!.lesson.includes('TS2322'))
    assert.ok(bullets[0]!.lesson.includes('src/foo.ts'))
    assert.equal(bullets[0]!.importance, 0.6)
    assert.equal(bullets[0]!.source, 'typecheck')
    assert.equal(bullets[0]!.errorSignal, 'TS2322 type mismatch')
    assert.equal(bullets[0]!.fixApproach, 'wrong type cast')
  })

  it('distills from repeated error classes (2+ occurrences)', () => {
    const entries = [
      makeEntry({ error: 'test failed: expected true got false', target: 'src/auth.ts', hypothesis: 'missing mock', context: 'unit test' }),
      makeEntry({ error: 'test failed: expected true got false', target: 'src/auth.ts', hypothesis: 'missing mock', context: 'unit test', turn: 2 }),
    ]
    const bullets = distillFromFailures(entries, [], { now: NOW })
    assert.equal(bullets.length, 1)
    assert.ok(bullets[0]!.lesson.includes('出现 2 次'))
    assert.equal(bullets[0]!.source, 'test-failure')
  })

  it('filters defensive lessons', () => {
    const entries = [makeEntry()]
    const patterns: FailurePattern[] = [{
      type: 'rework',
      count: 2,
      evidence: [makeEntry({ target: 'src/foo.ts', hypothesis: '小心处理边界' })],
      suggestion: '注意检查边界条件',
    }]
    const bullets = distillFromFailures(entries, patterns, { now: NOW })
    assert.equal(bullets.length, 0)
  })

  it('skips single-occurrence errors without patterns', () => {
    const entries = [
      makeEntry({ error: 'unique error A', target: 'a.ts' }),
      makeEntry({ error: 'unique error B', target: 'b.ts' }),
    ]
    const bullets = distillFromFailures(entries, [], { now: NOW })
    assert.equal(bullets.length, 0)
  })

  it('deduplicates by id', () => {
    const entries = [makeEntry()]
    const patterns = [makePattern(), makePattern()]
    const bullets = distillFromFailures(entries, patterns, { now: NOW })
    assert.equal(bullets.length, 1)
  })

  it('classifies source correctly', () => {
    const tcEntry = makeEntry({ error: 'TS2345 argument type' })
    const testEntry = makeEntry({ error: 'test assertion failed' })
    const reviewEntry = makeEntry({ error: 'review finding: unused var' })
    const deliveryEntry = makeEntry({ error: 'delivery gate rejected' })
    const otherEntry = makeEntry({ error: 'unknown problem' })

    const p = (e: FailureEntry): FailurePattern => ({
      type: 'anchoring', count: 3, evidence: [e], suggestion: 'fix it',
    })

    const [tc] = distillFromFailures([tcEntry], [p(tcEntry)], { now: NOW })
    assert.equal(tc!.source, 'typecheck')

    const [test] = distillFromFailures([testEntry], [p(testEntry)], { now: NOW })
    assert.equal(test!.source, 'test-failure')

    const [review] = distillFromFailures([reviewEntry], [p(reviewEntry)], { now: NOW })
    assert.equal(review!.source, 'review-gate')

    const [delivery] = distillFromFailures([deliveryEntry], [p(deliveryEntry)], { now: NOW })
    assert.equal(delivery!.source, 'delivery-gate')

    const [other] = distillFromFailures([otherEntry], [p(otherEntry)], { now: NOW })
    assert.equal(other!.source, 'self-correction')
  })
})

describe('importance upgrade on merge', () => {
  function makeBullet(overrides: Partial<PlaybookBullet> = {}): PlaybookBullet {
    return {
      id: 'b1',
      createdAt: Date.now(),
      keywords: ['typescript', 'error', 'type'],
      lesson: 'When type mismatch, check cast',
      context: 'typecheck',
      useCount: 0,
      lastUsedAt: null,
      importance: 0.3,
      ...overrides,
    }
  }

  it('merges similar bullets and boosts importance by 0.15', () => {
    const existing = [makeBullet({ importance: 0.3 })]
    const incoming = [makeBullet({ id: 'b2', importance: 0.3 })]
    const result = deduplicateBullets(existing, incoming)
    assert.equal(result.length, 1)
    assert.ok(result[0]!.importance > 0.44, `expected ~0.45, got ${result[0]!.importance}`)
  })

  it('two merges bring importance above 0.6 injection threshold', () => {
    const b = makeBullet({ importance: 0.3 })
    const first = deduplicateBullets([b], [makeBullet({ id: 'b2', importance: 0.3 })])
    const second = deduplicateBullets(first, [makeBullet({ id: 'b3', importance: 0.3 })])
    assert.ok(second[0]!.importance > 0.59, `expected ~0.6, got ${second[0]!.importance}`)
  })

  it('preserves source and errorSignal on merge', () => {
    const existing = [makeBullet({ source: undefined, errorSignal: undefined })]
    const incoming = [makeBullet({ id: 'b2', source: 'typecheck', errorSignal: 'TS2322' })]
    const result = deduplicateBullets(existing, incoming)
    assert.equal(result[0]!.source, 'typecheck')
    assert.equal(result[0]!.errorSignal, 'TS2322')
  })

  it('matchBullets respects minImportance filter', () => {
    const bullets: PlaybookBullet[] = [
      makeBullet({ importance: 0.3, keywords: ['typescript'] }),
      makeBullet({ id: 'b2', importance: 0.7, keywords: ['typescript'], lesson: 'high importance' }),
    ]
    const highOnly = matchBullets(bullets, ['typescript'], 10, { minImportance: 0.6 })
    assert.equal(highOnly.length, 1)
    assert.ok(highOnly[0]!.lesson.includes('high importance'))

    const all = matchBullets(bullets, ['typescript'], 10, { minImportance: 0 })
    assert.equal(all.length, 2)
  })
})
