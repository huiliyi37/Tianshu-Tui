import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { PheromoneRef, Sensorium, StrategyProfile } from '../sensorium.js'
import { createVigorState } from '../vigor.js'
import { buildIntentPreview, formatIntentPreview, shouldShowIntent } from '../intent-preview.js'

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
    assert.equal(shouldShowIntent({ strategy: null, vigor: null, sensorium: null, pheromones: [deadEnd('src/a.ts')] }), true)
    assert.equal(shouldShowIntent({ strategy: null, vigor: null, sensorium: null, pheromones: [], thrashingSuggestion: 'task_decomposition' }), true)
  })

  it('does NOT show intent for low vigor — auto-adapted by vigor-hook', () => {
    assert.equal(shouldShowIntent({ strategy: null, vigor: createVigorState({ phasic: -0.7, vigor: 0.2 }), sensorium: null, pheromones: [] }), false)
  })

  it('builds a concise preview with warnings and alternatives', () => {
    const intent = buildIntentPreview({
      strategy: strategy({ commitThreshold: 0.9, explorationBreadth: 0.9 }),
      vigor: createVigorState({ phasic: -0.8 }),
      sensorium: sensorium({ confidence: 0.7 }),
      pheromones: [deadEnd('src/fragile.ts')],
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

  it('formats single-line TUI text without self-rating confidence', () => {
    const formatted = formatIntentPreview({ summary: '修改 src/a.ts', confidence: 0.62, warnings: ['hot path'] })

    assert.match(formatted, /^⟡ 修改 src\/a\.ts/)
    assert.doesNotMatch(formatted, /信心/)  // self-rating removed — face-2 bleed stop
    assert.match(formatted, /hot path/)
    assert.match(formatted, /Enter\/y 继续/)
  })
})
