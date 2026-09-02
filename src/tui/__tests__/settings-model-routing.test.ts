import { test, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildCategories,
  findRecommendedRoutingTarget,
  applyRoutingRecommendation,
  type SettingsDraft,
  type SettingsEnv,
} from '../settings-model.js'

function draft(): SettingsDraft {
  return {
    workers: { profiles: {}, routing: {}, patcherTier: 'cheap', escalationCap: 'off' },
    review: { profiles: {}, skipAuto: false, skipAutoSpark: false, mechanicalFastPath: true },
    vision: null,
    visionAutoBridge: false,
    modelVision: {},
    basics: {
      toolPreset: 'minimal', runtimeLean: false, approval: 'auto-safe',
      checkpointEveryTurns: 0, defaultDomain: 'qiming', defaultModel: '',
    },
    net: { mirrorsEnabled: false, mirrorsPreset: 'default', proxy: '', noProxy: '', searchBackends: '', jinaBaseUrl: '' },
  }
}

const env: SettingsEnv = {
  models: [
    { provider: 'glm', id: 'glm-5.3', supportsVision: false },
    { provider: 'deepseek', id: 'deepseek-v4-flash', supportsVision: false },
    { provider: 'deepseek', id: 'deepseek-v4-pro', supportsVision: false },
  ],
  domains: [],
}

describe('findRecommendedRoutingTarget（desktop 同逻辑：flash > deepseek > 第一个）', () => {
  it('模型名含 flash 优先', () => {
    const t = findRecommendedRoutingTarget(env)
    assert.deepEqual(t, { provider: 'deepseek', model: 'deepseek-v4-flash' })
  })

  it('无 flash 时 deepseek 系次之', () => {
    const t = findRecommendedRoutingTarget({ models: env.models.filter(m => m.provider !== 'deepseek' || m.id.includes('pro')), domains: [] })
    assert.deepEqual(t, { provider: 'deepseek', model: 'deepseek-v4-pro' })
  })

  it('都没有时第一个兜底', () => {
    const t = findRecommendedRoutingTarget({ models: [{ provider: 'glm', id: 'glm-5.3', supportsVision: false }], domains: [] })
    assert.deepEqual(t, { provider: 'glm', model: 'glm-5.3' })
  })

  it('空模型列表返回 null（转空态引导）', () => {
    assert.equal(findRecommendedRoutingTarget({ models: [], domains: [] }), null)
  })
})

describe('applyRoutingRecommendation（一键填 cheap-flash 档 + 非会诊审查席）', () => {
  it('patches cheap-flash profile and all non-council review seats', () => {
    const target = { provider: 'deepseek', model: 'deepseek-v4-flash' }
    const next = applyRoutingRecommendation(draft(), target)
    assert.deepEqual(next.workers.profiles['cheap-flash'], target)
    for (const name of ['reviewer', 'adversarial_verifier', 'verifier', 'patcher', 'code_scout', 'doc_scout']) {
      assert.deepEqual(next.review.profiles[name], target, `${name} should be patched`)
    }
    assert.equal(next.review.profiles.council_expert, undefined, 'council_expert stays untouched')
  })

  it('preserves existing council_expert override', () => {
    const d = draft()
    d.review.profiles.council_expert = { provider: 'glm', model: 'glm-5.3' }
    const next = applyRoutingRecommendation(d, { provider: 'deepseek', model: 'deepseek-v4-flash' })
    assert.deepEqual(next.review.profiles.council_expert, { provider: 'glm', model: 'glm-5.3' })
  })
})

describe('buildCategories routing guidance', () => {
  it('workers 类目首位是一键推荐 action 字段', () => {
    const cats = buildCategories(draft(), env)
    const workers = cats.find(c => c.id === 'workers')!
    assert.equal(workers.fields[0]!.id, 'workers.applyRecommendation')
    assert.equal(workers.fields[0]!.kind, 'action')
    assert.match(workers.fields[0]!.label, /一键推荐/)
  })

  it('无候选模型时 action 字段转空态引导', () => {
    const cats = buildCategories(draft(), { models: [], domains: [] })
    const workers = cats.find(c => c.id === 'workers')!
    assert.equal(workers.fields[0]!.id, 'workers.recommendationEmpty')
    assert.match(workers.fields[0]!.hint ?? '', /\/connect/)
  })

  it('无效 review 路由条目 hint 带 ⚠ 静默回退警告', () => {
    const d = draft()
    d.review.profiles.reviewer = { provider: 'ghost', model: 'ghost-model' }
    const cats = buildCategories(d, env)
    const review = cats.find(c => c.id === 'review')!
    const field = review.fields.find(f => f.id === 'review.profiles.reviewer')!
    assert.match(field.hint ?? '', /⚠ ghost 未配置或无此模型/)
  })

  it('有效条目与未配置条目无警告', () => {
    const d = draft()
    d.review.profiles.reviewer = { provider: 'deepseek', model: 'deepseek-v4-flash' }
    const cats = buildCategories(d, env)
    const review = cats.find(c => c.id === 'review')!
    assert.doesNotMatch(review.fields.find(f => f.id === 'review.profiles.reviewer')!.hint ?? '', /⚠/)
    assert.doesNotMatch(review.fields.find(f => f.id === 'review.profiles.verifier')!.hint ?? '', /⚠/)
  })

  it('无效 workers 档位同样带 ⚠', () => {
    const d = draft()
    d.workers.profiles['cheap-flash'] = { provider: 'ghost', model: 'nope' }
    const cats = buildCategories(d, env)
    const workers = cats.find(c => c.id === 'workers')!
    const field = workers.fields.find(f => f.id === 'workers.profiles.cheap-flash')!
    assert.match(field.hint ?? '', /⚠ ghost 未配置或无此模型/)
  })
})
