import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { detectVirtue, computeVirtueCredit, virtueToPheromoneDeposit, computeVirtueWeights } from '../virtue-signals.js'
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

// ─── T3：互抑权重 + 季节调制矩阵 ────────────────────────────────
// computeVirtueWeights() 合并 10.1 季节调制矩阵与 2.4 互抑关系。

describe('computeVirtueWeights — T3 互抑 + 季节调制', () => {
  // ═══════════════════════════════════════════════════════════════
  // 基线：genesis 季 + 证活跃
  // ═══════════════════════════════════════════════════════════════
  it('基线：genesis 季证活跃时信 weight=1.2（互抑无涉）', () => {
    const r = computeVirtueWeights('cache-loyalty', 'genesis', 1.0, true)
    assert.equal(r.weight, 1.2) // baseWeight=1.2, 无季节调制, 无互抑
    assert.equal(r.encouragementAllowed, true)
    assert.equal(r.creditApplicable, true)
  })

  // ═══════════════════════════════════════════════════════════════
  // 互抑：证活跃 → 仁降权
  // ═══════════════════════════════════════════════════════════════
  it('互抑：证活跃时仁降权（验证已替代质疑）', () => {
    const active = computeVirtueWeights('independent-judgment', 'genesis', 1.0, true)
    const inactive = computeVirtueWeights('independent-judgment', 'genesis', 1.0, false)
    assert.ok(inactive.weight > active.weight, '证缺失时仁应升权（质疑是唯一防御）')
    // baseWeight=1.0; active → 1.0 × 0.6 = 0.6; inactive → 1.0 × 1.3 = 1.3
    assert.equal(active.weight, 0.6)
    assert.equal(inactive.weight, 1.3)
  })

  it('互抑：证活跃时义升权（证活跃时的义更可信）', () => {
    const active = computeVirtueWeights('proactive-verification', 'genesis', 1.0, true)
    const inactive = computeVirtueWeights('proactive-verification', 'genesis', 1.0, false)
    assert.ok(active.weight > inactive.weight, '证活跃时义应升权')
    // baseWeight=0.9; active → 0.9 × 1.3 = 1.17; inactive → 0.9 × 0.6 = 0.54
    assert.equal(active.weight, 1.17)
    assert.equal(inactive.weight, 0.54)
  })

  it('互抑：礼不参与互抑（效用独立于证）', () => {
    const active = computeVirtueWeights('boundary-respect', 'genesis', 1.0, true)
    const inactive = computeVirtueWeights('boundary-respect', 'genesis', 1.0, false)
    assert.equal(active.weight, inactive.weight)
    assert.equal(active.weight, 0.6) // baseWeight=0.6
  })

  // ═══════════════════════════════════════════════════════════════
  // 季节调制：reversal 压力态
  // ═══════════════════════════════════════════════════════════════
  it('reversal 季：智 ×1.5——觉察是压力态第一美德', () => {
    const r = computeVirtueWeights('strategic-awareness', 'reversal', 1.0, true)
    // baseWeight=0.8 × 1.5 = 1.2（智无互抑）
    assert.equal(r.weight, 1.2)
  })

  it('reversal 季：仁 ×1.2——质疑成本低于蛮干', () => {
    const r = computeVirtueWeights('independent-judgment', 'reversal', 1.0, false)
    // baseWeight=1.0 × 1.2 × 1.3(inactive) = 1.56
    assert.equal(r.weight, 1.56)
  })

  it('reversal 季：鼓励静默 + credit 冻结', () => {
    const r = computeVirtueWeights('cache-loyalty', 'reversal', 1.0, true)
    assert.equal(r.encouragementAllowed, false, 'reversal 季不应发鼓励')
    assert.equal(r.creditApplicable, false, 'reversal 季 credit 应冻结')
  })

  // ═══════════════════════════════════════════════════════════════
  // wuwei / return 季
  // ═══════════════════════════════════════════════════════════════
  it('wuwei 季：基线权重 + 全静默（上德不德）', () => {
    const r = computeVirtueWeights('cache-loyalty', 'wuwei', 1.0, true)
    assert.equal(r.weight, 1.2)
    assert.equal(r.encouragementAllowed, false, 'wuwei 季不应发鼓励')
    assert.equal(r.creditApplicable, true, 'wuwei 季 credit 正常')
  })

  it('return 季：基线权重 + 静默', () => {
    const r = computeVirtueWeights('proactive-verification', 'return', 1.0, true)
    assert.equal(r.weight, 1.17) // 0.9 × 1.3(active)
    assert.equal(r.encouragementAllowed, false)
    assert.equal(r.creditApplicable, true)
  })

  // ═══════════════════════════════════════════════════════════════
  // intensity 渐变
  // ═══════════════════════════════════════════════════════════════
  it('reversal intensity=0.5 时智权重线性插值', () => {
    const r = computeVirtueWeights('strategic-awareness', 'reversal', 0.5, true)
    // seasonFactor=1.5, blend = 1 + (1.5-1)*0.5 = 1.25
    // baseWeight=0.8 × 1.25 = 1.0
    assert.equal(r.weight, 1.0)
  })
})
