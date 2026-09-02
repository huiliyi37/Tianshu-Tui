import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  STRONG_EXPERT_CANDIDATES,
  STRONG_EXPERT_ROUTING_PREFIX,
  evaluateStrongExpertGate,
  loadStrongExpertRecords,
  MIN_STRONG_EXPERT_ARM_SAMPLES,
  MIN_STRONG_EXPERT_TOTAL_SAMPLES,
  recordStrongExpertRouting,
  recommendStrongExpertForMoment,
  summarizeStrongExpertLearning,
  type StrongExpertRoutingRecord,
  type StrongExpertRoutingStore,
} from '../strong-expert-learning.js'
import { detectCriticalMoments } from '../strong-expert.js'

function memStore(): StrongExpertRoutingStore & { rows: Map<string, string> } {
  const rows = new Map<string, string>()
  return {
    rows,
    saveBanditState: (kind, json) => { rows.set(kind, json) },
    loadBanditStatesByPrefix: (prefix) =>
      [...rows.entries()]
        .filter(([kind]) => kind.startsWith(prefix))
        .map(([kind, json]) => ({ kind, json })),
  }
}

function record(over: Partial<Omit<StrongExpertRoutingRecord, 'schemaVersion'>> = {}): Omit<StrongExpertRoutingRecord, 'schemaVersion'> {
  return {
    sessionId: 's1',
    expert: 'root_cause',
    momentKind: 'repeated-failure',
    status: 'passed',
    timestamp: Date.now(),
    ...over,
  }
}

describe('strong expert routing ledger（P2e）', () => {
  it('record → load 往返，前缀正确', () => {
    const store = memStore()
    recordStrongExpertRouting(store, record({ timestamp: 123 }))
    const loaded = loadStrongExpertRecords(store)
    assert.equal(loaded.length, 1)
    assert.equal(loaded[0]!.expert, 'root_cause')
    assert.ok([...store.rows.keys()][0]!.startsWith(STRONG_EXPERT_ROUTING_PREFIX))
  })

  it('summarize：基础设施失败剔除，通过率与成本入账', () => {
    const state = summarizeStrongExpertLearning([
      record({ status: 'passed', costTokens: 100 }),
      record({ status: 'failed', failureReason: 'timeout' }),
      record({ status: 'failed' }),
    ] as StrongExpertRoutingRecord[])

    assert.equal(state.totalSamples, 2, 'infra failure 不计能力样本')
    const arm = state.arms['root_cause::repeated-failure']!
    assert.equal(arm.samples, 2)
    assert.equal(arm.passed, 1)
    assert.equal(arm.averageReward, 0.5)
    assert.equal(arm.costTokens, 100)
  })

  it('样本不足 → shadow（静态规则专家）', () => {
    const store = memStore()
    for (let i = 0; i < MIN_STRONG_EXPERT_TOTAL_SAMPLES - 1; i++) {
      recordStrongExpertRouting(store, record({ timestamp: 1000 + i }))
    }
    const state = summarizeStrongExpertLearning(loadStrongExpertRecords(store))
    const decision = evaluateStrongExpertGate({
      state,
      momentKind: 'repeated-failure',
      ruleExpert: 'root_cause',
      candidates: STRONG_EXPERT_CANDIDATES['repeated-failure']!,
      featureFlagEnabled: true,
    })
    assert.equal(decision.gateOpen, false)
    assert.equal(decision.applied, false)
    assert.equal(decision.expert, 'root_cause')
    assert.ok(decision.vetoSignals.includes('insufficient_samples'))
  })

  it('跨 momentKind 攒样本不解锁闸门（口径按 kind 计数）', () => {
    const store = memStore()
    // repeated-failure 下只有 3 个样本；其余 30 个全是 review-rejected——
    // 全局计数 ≥20 但本 kind 不达标，闸门必须保持 shadow。
    for (let i = 0; i < 3; i++) {
      recordStrongExpertRouting(store, record({ timestamp: 1000 + i }))
    }
    for (let i = 0; i < 30; i++) {
      recordStrongExpertRouting(store, record({ timestamp: 5000 + i, momentKind: 'review-rejected', expert: 'adversarial', status: 'passed' }))
    }
    const state = summarizeStrongExpertLearning(loadStrongExpertRecords(store))
    assert.ok(state.totalSamples >= MIN_STRONG_EXPERT_TOTAL_SAMPLES, '前置：全局样本已达标')
    const decision = evaluateStrongExpertGate({
      state,
      momentKind: 'repeated-failure',
      ruleExpert: 'root_cause',
      candidates: STRONG_EXPERT_CANDIDATES['repeated-failure']!,
      featureFlagEnabled: true,
    })
    assert.equal(decision.applied, false, 'B 类样本不能给 A 类时刻解锁')
    assert.ok(decision.vetoSignals.includes('insufficient_samples'))
  })

  it('规则 arm 零观测时候选不得凭 ruleAvg=0 缺省「胜出」', () => {
    const store = memStore()
    // 同一 momentKind 下：规则席 root_cause 零样本，候选 adversarial 5/5 通过。
    // 旧口径 ruleAvg 缺省 0 → margin=1 直接开门；修正后必须 shadow。
    for (let i = 0; i < 25; i++) {
      recordStrongExpertRouting(store, record({ timestamp: 1000 + i, expert: 'adversarial', status: 'passed' }))
    }
    const state = summarizeStrongExpertLearning(loadStrongExpertRecords(store))
    const decision = evaluateStrongExpertGate({
      state,
      momentKind: 'repeated-failure',
      ruleExpert: 'root_cause',
      candidates: STRONG_EXPERT_CANDIDATES['repeated-failure']!,
      featureFlagEnabled: true,
    })
    assert.equal(decision.gateOpen, false, '零观测基线不可被判定为被击败')
    assert.ok(decision.vetoSignals.includes('rule_arm_under_observed'))
  })

  it('样本与边际达标 + 特性旗标开启 → gate applied 候选专家', () => {
    const store = memStore()
    // rule：20 个样本、50% 通过
    for (let i = 0; i < 20; i++) {
      recordStrongExpertRouting(store, record({ timestamp: 1000 + i, status: i % 2 === 0 ? 'passed' : 'failed' }))
    }
    // candidate adversarial：5 个样本、100% 通过
    for (let i = 0; i < MIN_STRONG_EXPERT_ARM_SAMPLES; i++) {
      recordStrongExpertRouting(store, record({ timestamp: 2000 + i, expert: 'adversarial', status: 'passed' }))
    }
    const state = summarizeStrongExpertLearning(loadStrongExpertRecords(store))

    const shadow = evaluateStrongExpertGate({
      state,
      momentKind: 'repeated-failure',
      ruleExpert: 'root_cause',
      candidates: STRONG_EXPERT_CANDIDATES['repeated-failure']!,
      featureFlagEnabled: false,
    })
    assert.equal(shadow.gateOpen, true, '账本已具备转正条件')
    assert.equal(shadow.applied, false, '旗标关闭保持 shadow')
    assert.equal(shadow.expert, 'root_cause')

    const applied = evaluateStrongExpertGate({
      state,
      momentKind: 'repeated-failure',
      ruleExpert: 'root_cause',
      candidates: STRONG_EXPERT_CANDIDATES['repeated-failure']!,
      featureFlagEnabled: true,
    })
    assert.equal(applied.applied, true)
    assert.equal(applied.expert, 'adversarial')
    assert.ok(Number(applied.evidenceWindow.rewardMargin) >= 0.05)
  })

  it('recommendStrongExpertForMoment：无 state / shadow 均回静态规则', () => {
    assert.equal(recommendStrongExpertForMoment(undefined, 'repeated-failure', 'root_cause', true), 'root_cause')
    const empty = summarizeStrongExpertLearning([])
    assert.equal(recommendStrongExpertForMoment(empty, 'review-rejected', 'adversarial', true), 'adversarial')
  })

  it('detectCriticalMoments 经 learning router 覆盖静态建议', () => {
    const learned = summarizeStrongExpertLearning([
      ...Array.from({ length: 20 }, (_, i) => record({ timestamp: 1000 + i, status: i % 2 === 0 ? 'passed' : 'failed' })),
      ...Array.from({ length: 5 }, (_, i) => record({ timestamp: 2000 + i, expert: 'adversarial', status: 'passed' })),
    ] as StrongExpertRoutingRecord[])
    const router = {
      recommend: (kind: 'repeated-failure', rule: 'root_cause') =>
        recommendStrongExpertForMoment(learned, kind, rule, true),
    }
    const moments = detectCriticalMoments({ doomLoopLevel: 'blocked', contextPressureRatio: 0 }, router)
    assert.equal(moments[0]!.suggestedExpert, 'adversarial', 'learned candidate overrides static rule')
  })
})
