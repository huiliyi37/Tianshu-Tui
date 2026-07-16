/**
 * CVM-vector 集成闭环（v3.1 计划 Wave 3）— 真实 AdvisoryBus + AdvisoryReadback。
 *
 * 覆盖：
 *   1. active 全链路：候选 → submit → render 送达 → track → recall_capsule
 *      行为观察 → expect 核销 adopted（outcome 事件带可回溯 key = ruleId 载体）。
 *   2. shadow 纪律：候选产出但不 submit → bus 渲染与无 evaluator 时逐字节一致
 *      （"名义 shadow、实际影响模型"的反证）。
 *   3. 熔断复用：连续 ignored 后 bus 习惯化静默接管我们的 key（不新建熔断器）。
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { AdvisoryBus, HABITUATION_SILENCE_STREAK } from '../advisory-bus.js'
import { AdvisoryReadback } from '../advisory-readback.js'
import { createCvmVectorEvaluator, type CvmVectorInput } from '../hooks/cognitive-capsule-router.js'
import { emptyObligationStore } from '../evidence-obligation.js'

function stuckInput(turn: number): CvmVectorInput {
  return {
    turn,
    phaseClass: 'execute',
    convergence: { score: 0.4, level: 1, textRepetitionPenalty: 0.2, oscillationPenalty: 1.0 },
    pressure: { ratio: 0.3, cvmOverheadRatio: 0.01, thrashing: false, shouldThrottleCvm: false, hardCeiling: false },
    obligations: emptyObligationStore(),
    evidence: { filesModified: 0, deliveryStatus: 'unverified' },
    pendingAdvisoryKeys: [],
    convergenceEmittedRecently: false,
    scoutOwned: false,
    hasDecisionGates: false,
  }
}

describe('CVM-vector 集成闭环', () => {
  it('active：候选 → render 送达 → recall_capsule 采纳核销 adopted', () => {
    const bus = new AdvisoryBus()
    const readback = new AdvisoryReadback()
    const evaluator = createCvmVectorEvaluator()
    const turn = 10

    // render 前评估（与 turn-step-producer 接线点同构）
    const decision = evaluator.evaluate({ ...stuckInput(turn), pendingAdvisoryKeys: bus.peekPendingKeys() })
    assert.equal(decision.candidate?.ruleId, 'CV2')
    bus.submit(decision.candidate!.entry)

    const block = bus.render(undefined, turn)
    assert.match(block, /cvm-vector-天璇-CV2/, '候选应赢得渲染位')
    readback.track(bus.drainDelivered(), turn)

    // 模型下一轮采纳：调用 recall_capsule("天璇")
    readback.observeTool({ turn: turn + 1, name: 'recall_capsule', target: '天璇', isError: false })
    assert.equal(readback.evaluate(turn + 1), 1)

    const outcomes = readback.drainOutcomes()
    assert.equal(outcomes.length, 1)
    assert.equal(outcomes[0]!.key, 'cvm-vector-天璇-CV2', 'outcome 经 key 关联回 ruleId')
    assert.equal(outcomes[0]!.outcome, 'adopted')
    assert.equal(outcomes[0]!.expectKind, 'tool_appears')
  })

  it('shadow：候选不 submit → bus 渲染与无 evaluator 逐字节一致', () => {
    const mkBus = () => {
      const bus = new AdvisoryBus()
      bus.submit({ key: 'self-verify', priority: 0.6, category: 'discipline', content: '先验证再继续' })
      return bus
    }
    const withEvaluator = mkBus()
    const control = mkBus()

    // shadow 纪律：评估（含 peek）但不 submit
    const decision = createCvmVectorEvaluator().evaluate({
      ...stuckInput(10),
      pendingAdvisoryKeys: withEvaluator.peekPendingKeys(),
    })
    assert.ok(decision.candidate, 'shadow 模式下候选照常产出（telemetry 用）')

    assert.equal(withEvaluator.render(undefined, 10), control.render(undefined, 10), 'shadow 不得改变送达字节')
    assert.deepEqual(withEvaluator.drainDelivered(), control.drainDelivered())
  })

  it('熔断复用：连续 ignored 后 bus 习惯化静默接管 cvm-vector key', () => {
    const bus = new AdvisoryBus()
    const readback = new AdvisoryReadback()
    bus.setHabituationPolicy(readback)
    const evaluator = createCvmVectorEvaluator()

    // 反复送达并忽略（窗口 3 轮无 recall_capsule），直到 streak 达静默阈值
    let turn = 10
    for (let round = 0; round < HABITUATION_SILENCE_STREAK; round++) {
      const decision = evaluator.evaluate({ ...stuckInput(turn), pendingAdvisoryKeys: bus.peekPendingKeys() })
      assert.equal(decision.candidate?.ruleId, 'CV2', `第 ${round + 1} 次冷却期满应再触发`)
      bus.submit(decision.candidate!.entry)
      assert.match(bus.render(undefined, turn), /cvm-vector-天璇-CV2/)
      readback.track(bus.drainDelivered(), turn)
      // 窗口（3 轮）内不出现 recall_capsule → ignored
      readback.evaluate(turn + 3)
      turn += 6 // 越过 evaluator 冷却
    }
    assert.equal(readback.getIgnoredStreak('cvm-vector-天璇-CV2'), HABITUATION_SILENCE_STREAK)

    // 下一次 evaluator 再触发时，bus 侧习惯化静默拒绝渲染（熔断，不新建机制）
    const decision = evaluator.evaluate({ ...stuckInput(turn), pendingAdvisoryKeys: bus.peekPendingKeys() })
    assert.equal(decision.candidate?.ruleId, 'CV2')
    bus.submit(decision.candidate!.entry)
    const block = bus.render(undefined, turn)
    assert.ok(!block.includes('cvm-vector-天璇-CV2'), '连续忽略后应被习惯化静默')
    const ledger = bus.drainLedger()
    assert.ok(ledger.droppedKeys.includes('cvm-vector-天璇-CV2'), '静默进账本可回放，不是静默消失')
  })

  it('同轮已有老 CCR 同星声音时 evaluator 让位（peek 接线闭环）', () => {
    const bus = new AdvisoryBus()
    bus.submit({ key: 'ccr-天璇-P6', priority: 0.55, category: 'star_domain', content: '【天璇】排查停滞' })
    const decision = createCvmVectorEvaluator().evaluate({
      ...stuckInput(10),
      pendingAdvisoryKeys: bus.peekPendingKeys(),
    })
    assert.equal(decision.candidate, null)
    assert.deepEqual(decision.yielded, { ruleId: 'CV2', to: 'ccr-天璇-P6' })
  })
})
