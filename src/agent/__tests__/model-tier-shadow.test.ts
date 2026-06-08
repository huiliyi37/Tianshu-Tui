import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildModelTierShadowEvent,
  modelTierShadowKind,
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
})
