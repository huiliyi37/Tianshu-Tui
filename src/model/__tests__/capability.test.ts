import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { recommendModelForTask, capabilityCardForModel, buildModelCards } from '../capability.js'

describe('model capability routing', () => {
  const cards = [
    { model: 'cheap-long', toolUseReliability: 0.6, jsonStability: 0.7, editSuccessRate: 0.5, testRepairRate: 0.4, contextWindow: 1000000, cacheEconomics: 'strong' as const, recommendedTasks: ['summarize'] },
    { model: 'tool-strong', toolUseReliability: 0.95, jsonStability: 0.9, editSuccessRate: 0.85, testRepairRate: 0.7, contextWindow: 128000, cacheEconomics: 'medium' as const, recommendedTasks: ['edit'] },
  ]

  it('prefers tool reliable model for edits', () => {
    assert.equal(recommendModelForTask('code_edit', cards).model, 'tool-strong')
  })

  it('prefers long context model for summarization', () => {
    assert.equal(recommendModelForTask('repo_summarization', cards).model, 'cheap-long')
  })
})

describe('capabilityCardForModel（v4-flash 去廉价化）', () => {
  it('deepseek-v4-flash 拿到略高于 pro 的强卡，推荐任务全覆盖', () => {
    const card = capabilityCardForModel({ id: 'deepseek-v4-flash', alias: 'v4-flash', contextWindow: 1_000_000 })
    assert.equal(card.toolUseReliability, 0.85)
    assert.equal(card.jsonStability, 0.85)
    assert.equal(card.editSuccessRate, 0.75)
    assert.equal(card.testRepairRate, 0.65)
    assert.ok(card.recommendedTasks.includes('planning'))
    assert.ok(card.recommendedTasks.includes('code_edit'))
  })

  it('alias 匹配同样命中特例', () => {
    const card = capabilityCardForModel({ id: 'some-id', alias: 'v4-flash', contextWindow: 1_000_000 })
    assert.equal(card.toolUseReliability, 0.85)
  })

  it('推荐排序里 v4-flash 赢 v4-pro（含 planning）', () => {
    const pro = capabilityCardForModel({ id: 'deepseek-v4-pro', alias: 'v4-pro', contextWindow: 1_000_000 })
    const flash = capabilityCardForModel({ id: 'deepseek-v4-flash', alias: 'v4-flash', contextWindow: 1_000_000 })
    assert.equal(recommendModelForTask('planning', [pro, flash]).model, 'deepseek-v4-flash')
    assert.equal(recommendModelForTask('code_edit', [pro, flash]).model, 'deepseek-v4-flash')
  })

  it('其他 flash 模型仍走弱卡启发式', () => {
    const card = capabilityCardForModel({ id: 'glm-4v-flash', contextWindow: 128_000 })
    assert.equal(card.toolUseReliability, 0.6)
    assert.deepEqual(card.recommendedTasks, ['repo_summarization', 'compaction'])
  })

  it('buildModelCards 与逐模型构造一致', () => {
    const cards = buildModelCards({ models: [{ id: 'deepseek-v4-flash', contextWindow: 1_000_000 }, { id: 'deepseek-v4-pro', contextWindow: 1_000_000 }] })
    assert.equal(cards[0]!.toolUseReliability, 0.85)
    assert.equal(cards[1]!.toolUseReliability, 0.8)
  })
})
