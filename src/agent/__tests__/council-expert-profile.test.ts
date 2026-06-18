import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { recommendModelTier } from '../model-tier-policy.js'
import { profileRegistry } from '../profile-registry.js'

// 瑶光门：council_expert 必须 NOT 带 tierLock，否则席位 tier 被 short-circuit
// 压成 cheap，天权/天府高风险席永远升不到 strong。反证用 reviewer 对照证明
// 「tierLock 是差异根因」——若 council_expert 误设 tierLock，本组会变红。
describe('council_expert profile — 无 tierLock 让 authority→tier 升级生效', () => {
  it('已注册为内置 profile，role=readonly，无 tierLock', () => {
    const def = profileRegistry.get('council_expert')
    assert.ok(def, 'council_expert 应已注册')
    assert.equal(def!.role, 'readonly')
    assert.equal(def!.tierLock, undefined, 'council_expert 不得设 tierLock')
    assert.equal(def!.builtIn, true)
  })

  it('天府高风险席 → strong（authority 升级路径生效）', () => {
    const rec = recommendModelTier({
      authority: 'tianfu',
      profile: 'council_expert',
      kind: 'plan',
      riskTier: 'high',
      objective: 'guardrail review of persistence change',
    })
    assert.equal(rec.tier, 'strong')
    assert.equal(rec.hardFloor, 'strong')
  })

  it('天璇规划席 → balanced（不被压成 cheap）', () => {
    const rec = recommendModelTier({
      authority: 'tianxuan',
      profile: 'council_expert',
      kind: 'plan',
      objective: 'exploration planning',
    })
    assert.equal(rec.tier, 'balanced')
    assert.equal(rec.hardFloor, 'balanced')
  })

  it('反证：同输入换 reviewer（带 tierLock:cheap）→ 被压成 cheap', () => {
    const rec = recommendModelTier({
      authority: 'tianfu',
      profile: 'reviewer',
      kind: 'plan',
      riskTier: 'high',
      objective: 'guardrail review of persistence change',
    })
    assert.equal(rec.tier, 'cheap', 'reviewer 的 tierLock 应把同样的天府高风险席压成 cheap')
  })
})
