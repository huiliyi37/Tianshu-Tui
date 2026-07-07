import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { PheromoneRef, Sensorium, StrategyProfile } from '../sensorium.js'
import { createVigorState } from '../vigor.js'
import { buildIntentPreview, shouldShowIntent } from '../intent-preview.js'

function strategy(overrides: Partial<StrategyProfile> = {}): StrategyProfile {
  return {
    reasoningEffort: 'medium',
    explorationBreadth: 0.3,
    commitThreshold: 0.6,
    shouldEscalate: false,
    thetaCycleInterval: 7,
    ...overrides,
  }
}

function sensorium(overrides: Partial<Sensorium> = {}): Sensorium {
  return {
    momentum: 0.8,
    pressure: 0.2,
    confidence: 0.8,
    complexity: 0.2,
    freshness: 0.5,
    stability: 0.9,
    ...overrides,
  }
}

function deadEnd(path: string): PheromoneRef {
  return { path, signal: 'dead-end', strength: 0.8, depositedAt: 1, halfLife: 1000 }
}

describe('intent preview core', () => {
  it('does not show intent for normal low-risk state', () => {
    assert.equal(shouldShowIntent({
      strategy: strategy(),
      vigor: createVigorState(),
      sensorium: sensorium(),
      pheromones: [],
      thrashingSuggestion: null,
    }), false)
  })

  it('shows intent for high commit threshold, dead-end, or thrashing', () => {
    assert.equal(shouldShowIntent({ strategy: strategy({ commitThreshold: 0.9 }), vigor: null, sensorium: null, pheromones: [] }), true)
    // dead-end 必须与 recentTargets 关联才触发（修复：旧实现任意 dead-end 即触发）
    assert.equal(shouldShowIntent({ strategy: null, vigor: null, sensorium: null, pheromones: [deadEnd('src/a.ts')], recentTargets: ['src/a.ts'] }), true)
    assert.equal(shouldShowIntent({ strategy: null, vigor: null, sensorium: null, pheromones: [], thrashingSuggestion: 'task_decomposition' }), true)
  })

  it('does NOT trigger on dead-end unrelated to current targets (关联匹配修复)', () => {
    // 历史无关任务 veto 残留的 dead-end（如旧会话沉积）不应触发当前任务意图闸
    assert.equal(shouldShowIntent({
      strategy: strategy(), vigor: createVigorState(), sensorium: sensorium(),
      pheromones: [deadEnd('/old/unrelated/path.ts')],
      recentTargets: ['src/current-task.ts'],
      thrashingSuggestion: null,
    }), false)
    // 无 recentTargets 时也不触发（无目标可关联）
    assert.equal(shouldShowIntent({
      strategy: strategy(), vigor: createVigorState(), sensorium: sensorium(),
      pheromones: [deadEnd('src/a.ts')],
      recentTargets: [],
      thrashingSuggestion: null,
    }), false)
  })

  it('handles legacy dead-end summary format (处理 前缀 + ... 截断)', () => {
    // 旧数据存的是 summarizeTarget 生成的 `处理 xxx...` 摘要；新匹配层应剥离前缀后比对
    assert.equal(shouldShowIntent({
      strategy: null, vigor: null, sensorium: null,
      pheromones: [deadEnd('处理 src/legacy/mod...')],
      recentTargets: ['src/legacy/module.ts'],
      thrashingSuggestion: null,
    }), true)
    // fallback 摘要「继续执行当前计划」永不关联
    assert.equal(shouldShowIntent({
      strategy: null, vigor: null, sensorium: null,
      pheromones: [deadEnd('继续执行当前计划')],
      recentTargets: ['src/anything.ts'],
      thrashingSuggestion: null,
    }), false)
  })

  it('does NOT show intent for low vigor — auto-adapted by vigor-hook', () => {
    assert.equal(shouldShowIntent({ strategy: null, vigor: createVigorState({ phasic: -0.7, vigor: 0.2 }), sensorium: null, pheromones: [] }), false)
  })

  it('builds a concise preview with warnings and alternatives', () => {
    const intent = buildIntentPreview({
      strategy: strategy({ commitThreshold: 0.9, explorationBreadth: 0.9 }),
      vigor: createVigorState({ phasic: -0.8 }),
      sensorium: sensorium({ confidence: 0.7 }),
      // dead-end path 与 recentTargets 关联才进 warning（关联匹配修复）
      pheromones: [deadEnd('src/api/client.ts')],
      thrashingSuggestion: 'task_decomposition',
      recentTargets: ['src/api/client.ts'],
    })

    assert.ok(intent)
    assert.equal(intent.summary, '处理 src/api/client.ts')
    assert.ok(intent.confidence < 0.7)
    assert.ok(intent.warnings!.some(w => w.includes('dead-end')))
    // phasic 警告已移除——vigor-hook 自动适应
    assert.ok(!intent.warnings!.some(w => w.includes('警觉模式')))
    assert.ok(intent.alternatives!.length > 0)
  })
})
