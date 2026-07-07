import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildModelTierGatedDecisionEvent,
  buildModelTierShadowEvent,
  modelTierGatedDecisionKind,
  modelTierShadowKind,
  persistModelTierGatedDecision,
  persistModelTierShadow,
} from '../model-tier-shadow.js'

describe('model tier shadow', () => {
  it('builds mismatch events without mutating model selection', () => {
    const event = buildModelTierShadowEvent({
      sessionId: 's1',
      workOrderId: 'team:T1',
      authority: 'tianquan',
      profile: 'reviewer',
      kind: 'review',
      recommendedTier: 'strong',
      actualModel: 'cheap-flash',
      actualTier: 'cheap',
      reason: 'review hard floor',
      timestamp: 123,
    })

    assert.equal(event.matched, false)
    assert.equal(event.actualModel, 'cheap-flash')
    assert.equal(modelTierShadowKind(event), 'model_tier_shadow:s1:team:T1:123')
  })

  it('persists append-only keys and remains no-op safe', () => {
    const calls: Array<{ kind: string; json: string }> = []
    const event = buildModelTierShadowEvent({
      sessionId: 's1',
      workOrderId: 'team:T1',
      profile: 'patcher',
      kind: 'patch_proposal',
      recommendedTier: 'cheap',
      actualModel: 'cheap-flash',
      actualTier: 'cheap',
      reason: 'low-risk patch',
      timestamp: 200,
    })
    const replay = { ...event, timestamp: 201 }

    persistModelTierShadow({ saveBanditState: (kind, json) => { calls.push({ kind, json }) } }, event)
    persistModelTierShadow({ saveBanditState: (kind, json) => { calls.push({ kind, json }) } }, replay)

    assert.equal(calls.length, 2)
    assert.notEqual(calls[0]!.kind, calls[1]!.kind)
    assert.doesNotThrow(() => persistModelTierShadow(undefined, event))
    assert.doesNotThrow(() => persistModelTierShadow({ saveBanditState: () => { throw new Error('db unavailable') } }, event))
  })

  it('persists gated decisions with append-only keys without replacing P3 shadows', () => {
    const calls: Array<{ kind: string; json: string }> = []
    const shadow = buildModelTierShadowEvent({
      sessionId: 's1',
      workOrderId: 'team:T1',
      profile: 'patcher',
      kind: 'patch_proposal',
      recommendedTier: 'balanced',
      actualModel: 'balanced-worker',
      actualTier: 'balanced',
      reason: 'rule',
      timestamp: 300,
    })
    const decision = buildModelTierGatedDecisionEvent({
      sessionId: 's1',
      workOrderId: 'team:T1',
      profile: 'patcher',
      kind: 'patch_proposal',
      ruleTier: 'balanced',
      candidateTier: 'cheap',
      applied: true,
      gateOpen: true,
      reason: 'applied: tier:cheap within hardFloor balanced',
      selectedModel: 'cheap-flash',
      selectedTier: 'cheap',
      timestamp: 300,
    })

    persistModelTierShadow({ saveBanditState: (kind, json) => { calls.push({ kind, json }) } }, shadow)
    persistModelTierGatedDecision({ saveBanditState: (kind, json) => { calls.push({ kind, json }) } }, decision)

    assert.equal(calls.length, 2)
    assert.equal(calls[0]!.kind, modelTierShadowKind(shadow))
    assert.equal(calls[1]!.kind, modelTierGatedDecisionKind(decision))
    assert.notEqual(calls[0]!.kind, calls[1]!.kind)
    const savedDecision = JSON.parse(calls[1]!.json)
    assert.equal(savedDecision.ruleTier, 'balanced')
    assert.equal(savedDecision.candidateTier, 'cheap')
    assert.equal(savedDecision.selectedModel, 'cheap-flash')
    assert.equal(savedDecision.selectedTier, 'cheap')
    assert.doesNotThrow(() => persistModelTierGatedDecision(undefined, decision))
    assert.doesNotThrow(() => persistModelTierGatedDecision({ saveBanditState: () => { throw new Error('db unavailable') } }, decision))
  })
})
