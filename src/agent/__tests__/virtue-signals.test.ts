import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { detectVirtue, computeVirtueCredit, virtueToPheromoneDeposit } from '../virtue-signals.js'
import type { VirtueType } from '../virtue-signals.js'

// ─── 任务 10：美德指令（阳面）───
// 万物负阴而抱阳。CVM 只有阴面（trap 坏行为）会导致纯阴则死。
// 五常 → AI agent 美德：仁=质疑, 义=验证, 礼=边界, 智=觉察, 信=忠cache

describe('virtue signals — CVM 阳面', () => {
  // ═══════════════════════════════════════════════════════════════
  // 仁：independent-judgment — 敢质疑而非附和
  // ═══════════════════════════════════════════════════════════════
  it('detects independent-judgment when model disagrees with user', () => {
    const signal = detectVirtue({
      toolName: 'ask_user_question',
      agreedWithUser: false,
      confidence: 0.6,
    })
    assert.ok(signal)
    assert.equal(signal.type, 'independent-judgment')
    assert.equal(signal.wuchang, '仁')
    assert.ok(signal.evidence.length > 0, 'should include evidence description')
  })

  it('returns null when disagreement but confidence too low', () => {
    const signal = detectVirtue({
      toolName: 'ask_user_question',
      agreedWithUser: false,
      confidence: 0.3,
    })
    assert.equal(signal, null)
  })

  it('returns null when ask_user_question agrees with user', () => {
    const signal = detectVirtue({
      toolName: 'ask_user_question',
      agreedWithUser: true,
      confidence: 0.8,
    })
    assert.equal(signal, null)
  })

  // ═══════════════════════════════════════════════════════════════
  // 义：proactive-verification — 无人要求也验证
  // ═══════════════════════════════════════════════════════════════
  it('detects proactive-verification when model runs tests unprompted', () => {
    const signal = detectVirtue({
      toolName: 'run_tests',
      userRequested: false,
      confidence: 0.7,
    })
    assert.ok(signal)
    assert.equal(signal.type, 'proactive-verification')
    assert.equal(signal.wuchang, '义')
  })

  it('returns null when tests are user-requested', () => {
    const signal = detectVirtue({
      toolName: 'run_tests',
      userRequested: true,
      confidence: 0.9,
    })
    assert.equal(signal, null)
  })

  it('returns null when confidence below threshold for proactive test', () => {
    const signal = detectVirtue({
      toolName: 'run_tests',
      userRequested: false,
      confidence: 0.5,
    })
    assert.equal(signal, null)
  })

  // ═══════════════════════════════════════════════════════════════
  // 礼：boundary-respect — 写前确认，非礼勿动
  // ═══════════════════════════════════════════════════════════════
  it('detects boundary-respect for write with approval', () => {
    const signal = detectVirtue({
      toolName: 'edit_file',
      toolTarget: 'src/app.ts',
      approvalRequired: true,
      confidence: 0.5,
    })
    assert.ok(signal)
    assert.equal(signal.type, 'boundary-respect')
    assert.equal(signal.wuchang, '礼')
  })

  it('detects boundary-respect for write_file with approval', () => {
    const signal = detectVirtue({
      toolName: 'write_file',
      approvalRequired: true,
      confidence: 0.6,
    })
    assert.ok(signal)
    assert.equal(signal.type, 'boundary-respect')
  })

  it('returns null for write without approval gate', () => {
    const signal = detectVirtue({
      toolName: 'write_file',
      approvalRequired: false,
      confidence: 0.9,
    })
    assert.equal(signal, null)
  })

  // ═══════════════════════════════════════════════════════════════
  // 智：strategic-awareness — 重复后觉察，知止不殆
  // ═══════════════════════════════════════════════════════════════
  it('detects strategic-awareness when same tool+target repeated 3+ times', () => {
    const signal = detectVirtue({
      toolName: 'edit_file',
      toolTarget: 'src/fragile.ts',
      confidence: 0.6,
      recentToolCalls: [
        { tool: 'edit_file', target: 'src/fragile.ts' },
        { tool: 'edit_file', target: 'src/fragile.ts' },
        { tool: 'read_file', target: 'src/other.ts' },
      ],
    })
    assert.ok(signal)
    assert.equal(signal.type, 'strategic-awareness')
    assert.equal(signal.wuchang, '智')
  })

  it('returns null when only 1 repeat of same tool+target', () => {
    const signal = detectVirtue({
      toolName: 'edit_file',
      toolTarget: 'src/new.ts',
      confidence: 0.7,
      recentToolCalls: [
        { tool: 'edit_file', target: 'src/new.ts' },
        { tool: 'read_file', target: 'src/other.ts' },
      ],
    })
    assert.equal(signal, null)
  })

  it('returns null when confidence below threshold for strategic awareness', () => {
    const signal = detectVirtue({
      toolName: 'edit_file',
      toolTarget: 'src/repeat.ts',
      confidence: 0.4,
      recentToolCalls: [
        { tool: 'edit_file', target: 'src/repeat.ts' },
        { tool: 'edit_file', target: 'src/repeat.ts' },
        { tool: 'edit_file', target: 'src/repeat.ts' },
      ],
    })
    assert.equal(signal, null)
  })

  // ═══════════════════════════════════════════════════════════════
  // Null for routine operations — 上德不德，是以有德
  // ═══════════════════════════════════════════════════════════════
  it('returns null for routine read_file', () => {
    assert.equal(detectVirtue({ toolName: 'read_file', confidence: 0.8 }), null)
  })

  it('returns null for routine grep', () => {
    assert.equal(detectVirtue({ toolName: 'grep', confidence: 0.7 }), null)
  })

  it('returns null for routine glob', () => {
    assert.equal(detectVirtue({ toolName: 'glob', confidence: 0.6 }), null)
  })

  // ═══════════════════════════════════════════════════════════════
  // Pheromone deposit conversion
  // ═══════════════════════════════════════════════════════════════
  it('converts virtue to pheromone deposit with evidence', () => {
    const deposit = virtueToPheromoneDeposit(
      { type: 'independent-judgment', confidence: 0.7, wuchang: '仁', evidence: 'test evidence' },
      'src/auth.ts',
    )
    assert.equal(deposit.signal, 'independent-judgment')
    assert.equal(deposit.strength, 0.7)
    assert.ok(deposit.context.includes('test evidence'))
    // Virtues have extended half-life (14 days vs default 7)
    assert.ok(deposit.halfLifeMs && deposit.halfLifeMs > 604_800_000)
  })

  it('uses default half-life when not specified', () => {
    const deposit = virtueToPheromoneDeposit(
      { type: 'proactive-verification', confidence: 0.8, wuchang: '义', evidence: '' },
      'src/lib.ts',
    )
    // Default virtue half-life: 14 days = 2 * DEFAULT_HALF_LIFE_MS
    assert.equal(deposit.halfLifeMs, 604_800_000 * 2)
  })

  // ═══════════════════════════════════════════════════════════════
  // Virtue credit accumulation — 积善成德，而神明自得
  // ═══════════════════════════════════════════════════════════════
  it('returns neutral baseline for empty signals', () => {
    assert.equal(computeVirtueCredit([]), 0.5)
  })

  it('accumulates virtue credit from multiple signals', () => {
    const signals = [
      { type: 'independent-judgment' as VirtueType, confidence: 0.8, wuchang: '仁' as const, evidence: '' },
      { type: 'proactive-verification' as VirtueType, confidence: 0.9, wuchang: '义' as const, evidence: '' },
      { type: 'cache-loyalty' as VirtueType, confidence: 1.0, wuchang: '信' as const, evidence: '' },
    ]
    const credit = computeVirtueCredit(signals)
    assert.ok(credit > 0.5, 'should be above baseline with virtues present')
    assert.ok(credit <= 1.0, 'should not exceed maximum')
  })

  it('cache-loyalty (信) carries highest weight', () => {
    const signalsWithXin = [
      { type: 'cache-loyalty' as VirtueType, confidence: 0.5, wuchang: '信' as const, evidence: '' },
    ]
    const xinCredit = computeVirtueCredit(signalsWithXin)

    const signalsWithLi = [
      { type: 'boundary-respect' as VirtueType, confidence: 0.5, wuchang: '礼' as const, evidence: '' },
    ]
    const liCredit = computeVirtueCredit(signalsWithLi)

    assert.ok(xinCredit > liCredit, '信 (cache loyalty) should be valued higher than 礼 (boundary respect)')
  })

  it('respects window turn limit', () => {
    const signals = [
      { type: 'independent-judgment' as VirtueType, confidence: 0.6, wuchang: '仁' as const, evidence: '' },
      { type: 'proactive-verification' as VirtueType, confidence: 0.7, wuchang: '义' as const, evidence: '' },
      { type: 'boundary-respect' as VirtueType, confidence: 0.5, wuchang: '礼' as const, evidence: '' },
      { type: 'strategic-awareness' as VirtueType, confidence: 0.6, wuchang: '智' as const, evidence: '' },
      { type: 'cache-loyalty' as VirtueType, confidence: 0.8, wuchang: '信' as const, evidence: '' },
    ]
    const full = computeVirtueCredit(signals)
    const windowed = computeVirtueCredit(signals, 2)
    assert.notEqual(full, windowed, 'window-limited should differ from full accumulation')
  })

  it('clamps to minimum 0.1 and maximum 1.0', () => {
    // All very low confidence
    const low = [
      { type: 'boundary-respect' as VirtueType, confidence: 0.01, wuchang: '礼' as const, evidence: '' },
    ]
    assert.equal(computeVirtueCredit(low), 0.1)

    // All very high confidence, 信-weighted
    const high = [
      { type: 'cache-loyalty' as VirtueType, confidence: 1.0, wuchang: '信' as const, evidence: '' },
      { type: 'cache-loyalty' as VirtueType, confidence: 1.0, wuchang: '信' as const, evidence: '' },
      { type: 'cache-loyalty' as VirtueType, confidence: 1.0, wuchang: '信' as const, evidence: '' },
    ]
    assert.ok(computeVirtueCredit(high) <= 1.0)
  })
})
