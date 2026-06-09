import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildGatedInfluenceAuditEvent,
  gatedInfluenceAuditKind,
  persistGatedInfluenceAudit,
} from '../gated-influence-audit.js'

describe('gated influence audit', () => {
  it('records append-only gate evidence without becoming a decision source', () => {
    const event = buildGatedInfluenceAuditEvent({
      source: 'team_scheduler_bandit',
      sessionId: 's1',
      targetId: 'wave W1/unsafe chars',
      gateOpen: true,
      applied: false,
      reason: 'shadow: feature flag disabled',
      evidenceWindow: {
        totalSamples: 35,
        candidateSamples: 6,
        rewardMargin: 0.2,
        featureFlagEnabled: false,
        omitted: undefined,
        badNumber: Number.NaN,
      },
      vetoSignals: ['explicit_flag_closed', 'explicit_flag_closed'],
      timestamp: 123,
    })

    assert.equal(event.schemaVersion, 1)
    assert.equal(event.source, 'team_scheduler_bandit')
    assert.equal(event.gateOpen, true)
    assert.equal(event.applied, false)
    assert.deepEqual(event.evidenceWindow, {
      totalSamples: 35,
      candidateSamples: 6,
      rewardMargin: 0.2,
      featureFlagEnabled: false,
    })
    assert.deepEqual(event.vetoSignals, ['explicit_flag_closed'])
    assert.equal(gatedInfluenceAuditKind(event), 'gated_influence_audit:team_scheduler_bandit:s1:wave_W1_unsafe_chars:123')
  })

  it('persists safely and append-only', () => {
    const calls: Array<{ kind: string; json: string }> = []
    const event1 = buildGatedInfluenceAuditEvent({
      source: 'model_tier_bandit',
      sessionId: 's1',
      targetId: 'team:T1',
      gateOpen: false,
      applied: false,
      reason: 'shadow: hardFloor strong blocks cheap',
      vetoSignals: ['hard_safety_floor'],
      timestamp: 1,
    })
    const event2 = { ...event1, timestamp: 2 }

    persistGatedInfluenceAudit({ saveBanditState: (kind, json) => { calls.push({ kind, json }) } }, event1)
    persistGatedInfluenceAudit({ saveBanditState: (kind, json) => { calls.push({ kind, json }) } }, event2)

    assert.equal(calls.length, 2)
    assert.notEqual(calls[0]!.kind, calls[1]!.kind)
    assert.equal(JSON.parse(calls[0]!.json).source, 'model_tier_bandit')
    assert.doesNotThrow(() => persistGatedInfluenceAudit(undefined, event1))
    assert.doesNotThrow(() => persistGatedInfluenceAudit({ saveBanditState: () => { throw new Error('db unavailable') } }, event1))
  })
})
