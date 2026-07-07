import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { ReasoningEffortController, type ReasoningEffortDeps } from '../reasoning-effort-controller.js'
import { createPredictionAccumulator } from '../prediction-error.js'
import { evaluateGatedInfluenceHistory } from '../gated-influence-evaluation.js'
import { resolveBanditPromotion } from '../bandit-promotion.js'
import { buildGatedInfluenceAuditEvent, gatedInfluenceAuditKind } from '../gated-influence-audit.js'
import type { P3Integration } from '../p3-integration.js'

/**
 * Effort bandit shadow→auto promotion chain. Previously broken in two places:
 * no gated_influence_audit:effort_bandit rows were ever written, and
 * evaluateGatedInfluenceHistory never counted effort shadow samples — so
 * `banditPromotion.effort: auto` could never satisfy its evidence gate.
 */

type AuditInput = { gateOpen: boolean; applied: boolean; reason: string; evidenceWindow: Record<string, number | boolean | string> }

function makeDeps(overrides: {
  enabled: boolean
  gateOpen: boolean
  rewardMargin?: number | null
  delta?: number | null
  persistAudit: (input: AuditInput) => void
}): ReasoningEffortDeps {
  const p3 = {
    isEffortGateOpen: () => overrides.gateOpen,
    effortGateEvidence: () => ({
      totalPulls: 42,
      rewardMargin: overrides.rewardMargin === undefined ? 0.12 : overrides.rewardMargin,
      gateOpen: overrides.gateOpen,
    }),
    recommendEffortDelta: () => (overrides.delta == null ? null : { delta: overrides.delta, armId: `delta:${overrides.delta > 0 ? '+' : ''}${overrides.delta}` }),
    shadowRecommendEffort: () => null,
  } as unknown as P3Integration
  let configured: string | undefined
  return {
    getReasoningFloor: () => undefined,
    getConfigReasoningEffort: () => configured as never,
    setConfigReasoningEffort: effort => { configured = effort },
    setClientReasoningEffort: () => {},
    isEffortBanditEnabled: () => overrides.enabled,
    p3,
    hasTaskContract: () => false,
    getPredictionAccumulator: () => createPredictionAccumulator(),
    getTurnCount: () => 3,
    getMaxTurns: () => 50,
    getFilesModifiedCount: () => 1,
    setCurrentEffortShadow: () => {},
    persistAudit: overrides.persistAudit,
  }
}

describe('effort bandit gated-influence audit', () => {
  it('writes an audit row even in shadow mode (chicken-and-egg breaker)', () => {
    const audits: AuditInput[] = []
    const controller = new ReasoningEffortController(makeDeps({
      enabled: false, gateOpen: false, rewardMargin: null, persistAudit: a => audits.push(a),
    }))
    controller.set('medium')

    assert.equal(audits.length, 1)
    const audit = audits[0]!
    assert.equal(audit.gateOpen, false)
    assert.equal(audit.applied, false)
    assert.match(audit.reason, /shadow/)
    assert.equal(audit.evidenceWindow.totalPulls, 42)
    assert.equal(audit.evidenceWindow.rewardMargin, undefined)
  })

  it('records applied=true with rewardMargin when the gate is open and the delta lands', () => {
    const audits: AuditInput[] = []
    const controller = new ReasoningEffortController(makeDeps({
      enabled: true, gateOpen: true, rewardMargin: 0.12, delta: -1, persistAudit: a => audits.push(a),
    }))
    controller.set('medium')

    assert.equal(audits.length, 1)
    const audit = audits[0]!
    assert.equal(audit.gateOpen, true)
    assert.equal(audit.applied, true)
    assert.equal(audit.evidenceWindow.rewardMargin, 0.12)
    assert.equal(audit.evidenceWindow.baseEffort, 'medium')
    assert.equal(audit.evidenceWindow.finalEffort, 'low')
  })

  it('audit failure never affects the effort decision', () => {
    let configured: string | undefined
    const deps = makeDeps({ enabled: false, gateOpen: false, persistAudit: () => { throw new Error('disk full') } })
    deps.setConfigReasoningEffort = effort => { configured = effort }
    new ReasoningEffortController(deps).set('high')
    assert.equal(configured, 'high')
  })
})

describe('effort bandit auto promotion chain', () => {
  function buildStore(sampleCount: number, rewardMargin: number) {
    const rows = new Map<string, Array<{ kind: string; json: string }>>()
    rows.set('effort_shadow:', Array.from({ length: sampleCount }, (_, i) => ({
      kind: `effort_shadow:effort_${i}`,
      json: JSON.stringify({ schemaVersion: 1, recommendedArm: i % 2 ? 'delta:-1' : 'delta:0', ruleBaseline: 'medium', reward: 0.5, timestamp: i }),
    })))
    const audit = buildGatedInfluenceAuditEvent({
      source: 'effort_bandit', sessionId: 's1', targetId: 'turn_3',
      gateOpen: true, applied: true, reason: 'bandit delta applied',
      evidenceWindow: { rewardMargin, totalPulls: sampleCount },
    })
    rows.set('gated_influence_audit:effort_bandit:', [{ kind: gatedInfluenceAuditKind(audit), json: JSON.stringify(audit) }])
    return {
      loadBanditStatesByPrefix: (prefix: string) => rows.get(prefix) ?? [],
    }
  }

  it('counts effort_shadow rows as shadow samples', () => {
    const report = evaluateGatedInfluenceHistory(buildStore(12, 0.1))
    assert.equal(report.sources.effort_bandit.totalShadowSamples, 12)
    assert.equal(report.sources.effort_bandit.averageRewardByCandidate['delta:-1'], 0.5)
  })

  it('auto mode promotes once samples and reward margin clear the thresholds', () => {
    const decision = resolveBanditPromotion({ source: 'effort_bandit', mode: 'auto', store: buildStore(35, 0.12) })
    assert.equal(decision.enabled, true)
    assert.match(decision.reason, /promoted/)
  })

  it('auto mode stays closed when samples are insufficient', () => {
    const decision = resolveBanditPromotion({ source: 'effort_bandit', mode: 'auto', store: buildStore(10, 0.12) })
    assert.equal(decision.enabled, false)
    assert.match(decision.reason, /samples 10\/30/)
  })

  it('auto mode stays closed when the reward margin is below threshold', () => {
    const decision = resolveBanditPromotion({ source: 'effort_bandit', mode: 'auto', store: buildStore(35, 0.01) })
    assert.equal(decision.enabled, false)
    assert.match(decision.reason, /reward margin/)
  })
})
