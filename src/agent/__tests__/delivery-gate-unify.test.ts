/**
 * Track 3: 交付门禁 v1/v2 合一。
 *
 * 契约：
 * - evidence.buildBadge(gateV2) 注入权威门禁 → badge 呈现 GREEN/YELLOW/RED，
 *   不再用 v1 的 EvidenceState 推导行
 * - 未注入 → v1 回退原样（badge 行为不变）
 * - buildGateConvergenceHint: GREEN→结束指引 / RED→阻断+最短下一步 / YELLOW→带条件交付
 * - processTurnEnd: deliveryGateV2 评估异常 → 回退 v1，badge 不缺席
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

describe('buildBadge with authoritative v2 gate (Track 3)', () => {
  function trackerWithModified(): EvidenceTracker {
    const t = new EvidenceTracker()
    t.trackFileModified('src/a.ts')
    return t
  }

  it('GREEN renders the v2 state instead of v1 unverified-warning', () => {
    const badge = trackerWithModified().buildBadge({ state: 'GREEN', reason: '1 owned file(s) verified.' })
    assert.ok(badge)
    assert.match(badge, /Delivery gate.*GREEN/)
    assert.match(badge, /1 owned file\(s\) verified/)
    assert.ok(!badge.includes('Unverified changes'), 'v1 unverified line suppressed when v2 is authoritative')
  })

  it('RED renders blocking reason and next action', () => {
    const badge = trackerWithModified().buildBadge({
      state: 'RED',
      reason: '1 owned file(s) modified but unverified.',
      blockingReason: 'Run verification before delivery.',
      shortestNextStep: 'npm test -- src/__tests__/a.test.ts',
    })
    assert.ok(badge)
    assert.match(badge, /Delivery gate.*RED/)
    assert.match(badge, /Blocking.*Run verification/)
    assert.match(badge, /Next action.*npm test/)
  })

  it('YELLOW renders the caveat state', () => {
    const badge = trackerWithModified().buildBadge({ state: 'YELLOW', reason: 'external verification blocked' })
    assert.ok(badge)
    assert.match(badge, /Delivery gate.*YELLOW/)
  })

  it('no gate injected → v1 fallback unchanged', () => {
    const badge = trackerWithModified().buildBadge()
    assert.ok(badge)
    assert.match(badge, /Unverified changes/, 'v1 derivation still active without v2')
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

  it('passes current modified files to the gate and renders its verdict', () => {
    let received: string[] | undefined
    const { badge } = processTurnEnd(makeDeps((dirty) => {
      received = dirty
      return {
        state: 'GREEN', canDeliver: true, isBlocked: false,
        reason: 'verified', ownedFileCount: 1, externalFileCount: 0,
        verificationCount: 1, supersededFailures: 0,
        staleFailureCandidates: 0, toolInvocationFailureCandidates: [],
      }
    }))
    assert.deepEqual(received, ['src/a.ts'])
    assert.ok(badge)
    assert.match(badge, /Delivery gate.*GREEN/)
  })

  it('a throwing gate falls back to v1 — badge still present', () => {
    const { badge } = processTurnEnd(makeDeps(() => { throw new Error('gate exploded') }))
    assert.ok(badge, 'badge survives gate failure')
    assert.match(badge, /Unverified changes/, 'v1 fallback rendering')
  })
})
