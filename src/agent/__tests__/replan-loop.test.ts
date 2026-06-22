import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
  correctPlan,
  injectReplanContext,
} from '../replan-loop.js'
import {
  createTrace,
  type PlanStep,
  type DeviationResult,
} from '../plan-execution-trace.js'

function makeStep(id: string, expectedTools: string[] = ['read_file']): PlanStep {
  return { id, description: `Step ${id}`, expectedTools, status: 'pending' }
}

function makeDeviation(type: DeviationResult['type'], overrides: Partial<DeviationResult> = {}): DeviationResult {
  return { type, reason: `test ${type}`, ...overrides }
}

describe('correctPlan', () => {
  it('returns unchanged trace for none deviation', () => {
    const trace = createTrace('c1', 'unit', [makeStep('step-1')])
    const { trace: updated, addedSteps } = correctPlan(trace, makeDeviation('none'))
    assert.equal(addedSteps.length, 0)
    assert.equal(updated.steps.length, 1)
  })

  it('marks original step as replanned after correction (deviated)', () => {
    const trace = createTrace('c1', 'unit', [makeStep('step-1')])
    const { trace: updated, addedSteps } = correctPlan(trace, makeDeviation('deviated', { affectedStepId: 'step-1' }))
    assert.equal(updated.steps[0]!.status, 'replanned')
    assert.ok(addedSteps.length > 0)
  })

  it('appends diagnostic step for blocked deviation', () => {
    const trace = createTrace('c1', 'unit', [makeStep('step-1')])
    const { trace: updated, addedSteps } = correctPlan(trace, makeDeviation('blocked', { affectedStepId: 'step-1' }))
    assert.ok(addedSteps[0]!.description.includes('诊断'))
    assert.equal(updated.status, 'replanned')
  })

  it('marks remaining steps as skip and sets completed for replanned', () => {
    const trace = createTrace('c1', 'unit', [makeStep('step-1'), makeStep('step-2'), { ...makeStep('step-3'), status: 'done' }])
    const { trace: updated } = correctPlan(trace, makeDeviation('replanned'))
    assert.equal(updated.steps[0]!.status, 'skip')
    assert.equal(updated.steps[1]!.status, 'skip')
    assert.equal(updated.steps[2]!.status, 'done')
    assert.equal(updated.status, 'completed')
  })

  it('appends verification step for stray deviation', () => {
    const trace = createTrace('c1', 'unit', [makeStep('step-1')])
    const { addedSteps } = correctPlan(trace, makeDeviation('stray', { reason: 'found new-file.ts' }))
    assert.ok(addedSteps[0]!.description.includes('验证'))
  })

  it('appends unstuck step for stalled deviation', () => {
    const trace = createTrace('c1', 'unit', [makeStep('step-1')])
    const { addedSteps } = correctPlan(trace, makeDeviation('stalled'))
    assert.ok(addedSteps[0]!.description.includes('停滞'))
  })

  it('does not mutate original trace', () => {
    const trace = createTrace('c1', 'unit', [makeStep('step-1')])
    correctPlan(trace, makeDeviation('blocked', { affectedStepId: 'step-1' }))
    assert.equal(trace.steps.length, 1)
    assert.equal(trace.steps[0]!.status, 'pending')
  })

  // U6/D1: replan ids are trace-local — concurrent traces must not interleave
  // or reset each other (the old module-level stepCounter broke this).
  it('produces trace-local, non-interleaving replan ids across concurrent traces', () => {
    const a0 = createTrace('A', 'system', [makeStep('step-1')])
    const b0 = createTrace('B', 'system', [makeStep('step-1')])
    const a1 = correctPlan(a0, makeDeviation('stalled')).trace
    const b1 = correctPlan(b0, makeDeviation('stalled')).trace
    const a2 = correctPlan(a1, makeDeviation('stalled')).trace
    const aReplanIds = a2.steps.filter(s => s.id.startsWith('replan-')).map(s => s.id)
    const bReplanIds = b1.steps.filter(s => s.id.startsWith('replan-')).map(s => s.id)
    // each trace numbers its own replans from 1 — independent of the other
    assert.deepEqual(aReplanIds, ['replan-1', 'replan-2'])
    assert.deepEqual(bReplanIds, ['replan-1'])
  })
})

describe('injectReplanContext', () => {
  it('returns empty text for none deviation', () => {
    const ctx = injectReplanContext(makeDeviation('none'), [])
    assert.equal(ctx.text, '')
    assert.equal(ctx.deviationType, 'none')
  })

  it('includes deviation type label and reason', () => {
    const ctx = injectReplanContext(makeDeviation('blocked', { reason: '3 failures' }), [])
    assert.ok(ctx.text.includes('<replan-context'))
    assert.ok(ctx.text.includes('阻塞'))
    assert.ok(ctx.text.includes('3 failures'))
  })

  it('lists added steps in context', () => {
    const step: PlanStep = { id: 'replan-1', description: '修正偏差 — test', expectedTools: ['read_file'], status: 'pending' }
    const ctx = injectReplanContext(makeDeviation('deviated'), [step])
    assert.ok(ctx.text.includes('修正偏差'))
  })

  it('handles all deviation types without crash', () => {
    for (const type of ['blocked', 'deviated', 'stray', 'stalled'] as const) {
      const ctx = injectReplanContext(makeDeviation(type), [])
      assert.ok(ctx.text.length > 0, `${type} should produce text`)
      assert.equal(ctx.deviationType, type)
    }
  })

  // replanned 不注入 system-reminder —— trace appendix 已反映 completed 状态，
  // 注入"已完成"文字会误导 agent 提前收尾（step done ≠ 目标达成）。
  it('returns empty text for replanned deviation (no injection)', () => {
    const ctx = injectReplanContext(makeDeviation('replanned'), [])
    assert.equal(ctx.text, '')
    assert.equal(ctx.deviationType, 'replanned')
  })
})
