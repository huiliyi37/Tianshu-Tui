/**
 * Track 3: 交付门禁 v1/v2 合一。
 *
 * 契约：
 * - evidence.buildSummary(gateV2) 注入权威门禁 → summary.gate 呈现 GREEN/YELLOW/RED，
 *   不再用 v1 的 EvidenceState 推导
 * - buildGateConvergenceHint: GREEN→结束指引 / RED→阻断+最短下一步 / YELLOW→带条件交付
 * - processTurnEnd: deliveryGateV2 评估异常 → gateV2 缺席，summary 回退 v1 推导
 *
 * 注：门禁结论不再渲染成 transcript 文本（任务完成总结 badge 已移除——
 * 每个无工具 final turn 都弹一次"交付"，session 4df36bcd）。
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { EvidenceTracker } from '../evidence.js'
import { buildGateConvergenceHint } from '../delivery-gate-v2.js'
import { processTurnEnd } from '../turn-end.js'
import { TrajectoryRecorder } from '../trajectory.js'
import { RoutingMetricsCollector } from '../../model/routing-metrics.js'
import { SessionContext } from '../context.js'
import { PromptEngine } from '../../prompt/engine.js'
import type { AgentConfig } from '../loop-types.js'

describe('buildSummary with authoritative v2 gate (Track 3)', () => {
  function trackerWithModified(): EvidenceTracker {
    const t = new EvidenceTracker()
    t.trackFileModified('src/a.ts')
    return t
  }

  it('GREEN reflects the v2 state instead of v1 unverified derivation', () => {
    const summary = trackerWithModified().buildSummary({ state: 'GREEN', reason: '1 owned file(s) verified.' })
    assert.equal(summary.gate.state, 'GREEN')
    assert.equal(summary.gate.label, 'GREEN')
    assert.equal(summary.gate.reason, '1 owned file(s) verified.')
  })

  it('RED carries blocking reason and next action', () => {
    const summary = trackerWithModified().buildSummary({
      state: 'RED',
      reason: '1 owned file(s) modified but unverified.',
      blockingReason: 'Run verification before delivery.',
      shortestNextStep: 'npm test -- src/__tests__/a.test.ts',
    })
    assert.equal(summary.gate.label, 'RED')
    assert.equal(summary.gate.blockingReason, 'Run verification before delivery.')
    assert.equal(summary.gate.nextAction, 'npm test -- src/__tests__/a.test.ts')
  })

  it('YELLOW carries the caveat state', () => {
    const summary = trackerWithModified().buildSummary({ state: 'YELLOW', reason: 'external verification blocked' })
    assert.equal(summary.gate.label, 'YELLOW')
  })

  it('no gate injected → v1 fallback derivation unchanged', () => {
    const summary = trackerWithModified().buildSummary()
    assert.equal(summary.verificationStatus, 'unverified')
    assert.notEqual(summary.gate.label, 'GREEN')
  })
})

describe('buildGateConvergenceHint (Track 3)', () => {
  it('GREEN instructs to summarize and stop', () => {
    const hint = buildGateConvergenceHint({ state: 'GREEN' })
    assert.match(hint, /GREEN/)
    assert.match(hint, /结束回合/)
  })

  it('RED surfaces the blocker and the shortest next step', () => {
    const hint = buildGateConvergenceHint({
      state: 'RED',
      blockingReason: 'Owned verification failed.',
      shortestNextStep: 'npm run typecheck',
    })
    assert.match(hint, /RED/)
    assert.match(hint, /Owned verification failed/)
    assert.match(hint, /npm run typecheck/)
  })

  it('YELLOW allows conditional delivery with caveat', () => {
    const hint = buildGateConvergenceHint({ state: 'YELLOW', reason: 'external blocked' })
    assert.match(hint, /YELLOW/)
    assert.match(hint, /caveat/)
  })
})

describe('processTurnEnd gate integration (Track 3)', () => {
  function makeDeps(deliveryGateV2: AgentConfig['deliveryGateV2']): Parameters<typeof processTurnEnd>[0] {
    const evidence = new EvidenceTracker()
    evidence.trackFileModified('src/a.ts')
    const config = {
      promptEngine: new PromptEngine({ model: 'm', maxTokens: 256, staticCtx: { tools: [] }, volatileCtx: { cwd: '/repo' } }),
      deliveryGateV2,
    } as unknown as AgentConfig
    return {
      config,
      session: new SessionContext(),
      trajectory: new TrajectoryRecorder(),
      streamedText: 'done',
      routingMetrics: new RoutingMetricsCollector(),
      decisions: [],
      evidence,
    }
  }

  it('passes current modified files to the gate and returns its verdict', () => {
    let received: string[] | undefined
    const { gateV2 } = processTurnEnd(makeDeps((dirty) => {
      received = dirty
      return {
        state: 'GREEN', canDeliver: true, isBlocked: false,
        reason: 'verified', ownedFileCount: 1, externalFileCount: 0,
        verificationCount: 1, supersededFailures: 0, staleSnapshotDropped: 0,
        staleFailureCandidates: 0, toolInvocationFailureCandidates: [],
      }
    }))
    assert.deepEqual(received, ['src/a.ts'])
    assert.equal(gateV2?.state, 'GREEN')
  })

  it('a throwing gate falls back to v1 — gateV2 absent, summary derivation survives', () => {
    const deps = makeDeps(() => { throw new Error('gate exploded') })
    const { gateV2 } = processTurnEnd(deps)
    assert.equal(gateV2, undefined, 'gate failure yields no v2 verdict')
    const summary = deps.evidence.buildSummary(gateV2)
    assert.equal(summary.verificationStatus, 'unverified', 'v1 fallback derivation')
  })
})
