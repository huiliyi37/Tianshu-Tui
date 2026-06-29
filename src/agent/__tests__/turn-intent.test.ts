import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { TurnIntentController } from '../turn-intent.js'
import { createVigorState } from '../vigor.js'
import type { IntentPreview } from '../intent-preview.js'
import type { PressureResult } from '../../context/pressure-monitor.js'

const sensorium = {
  momentum: 0.2,
  pressure: 0.1,
  confidence: 0.9,
  complexity: 0.2,
  freshness: 0.5,
  stability: 1,
}

const strategy = {
  reasoningEffort: 'medium' as const,
  explorationBreadth: 0.3,
  commitThreshold: 0.9,
  shouldEscalate: false,
  thetaCycleInterval: 7,
}

const pressureResult: PressureResult = {
  tier: 0,
  shouldCompact: false,
  thrashing: false, fastGrowth: false, growthRate: 0, cvmOverheadRatio: 0, shouldThrottleCvm: false,
  ratio: 0.1,
}

function makeInput(onIntentNote?: (intent: IntentPreview) => void) {
  return {
    strategy,
    vigor: createVigorState(),
    sensorium,
    pheromones: [],
    pressureResult,
    recentToolHistory: [{ tool: 'read_file', target: 'src/agent/loop.ts', status: 'success' as const }],
    onIntentNote,
  }
}

describe('TurnIntentController', () => {
  it('does nothing when no note sink is available', () => {
    const controller = new TurnIntentController()

    controller.evaluate(makeInput())

    assert.equal(controller.getShownCount(), 0)
  })

  it('fires the note (fire-and-forget) when the gate trips, never blocks/vetoes', () => {
    const seen: IntentPreview[] = []
    const controller = new TurnIntentController()

    controller.evaluate(makeInput(intent => { seen.push(intent) }))

    assert.equal(controller.getShownCount(), 1)
    assert.equal(seen.length, 1)
    assert.equal(seen[0]!.summary, '处理 src/agent/loop.ts')
  })

  it('surfaces the note regardless of approval tier (no interactive gate)', () => {
    // 非阻塞后不再按档位屏蔽：自治/默认/监督一律可见。
    let calls = 0
    const controller = new TurnIntentController()

    controller.evaluate(makeInput(() => { calls++ }))

    assert.equal(calls, 1)
    assert.equal(controller.getShownCount(), 1)
  })

  it('does not fire when the gate does not trip', () => {
    let calls = 0
    const controller = new TurnIntentController()
    // commitThreshold 低 + 无 dead-end + 无抖动 → shouldShowIntent=false
    const input = {
      ...makeInput(() => { calls++ }),
      strategy: { ...strategy, commitThreshold: 0.5 },
    }

    controller.evaluate(input)

    assert.equal(calls, 0)
    assert.equal(controller.getShownCount(), 0)
  })

  it('caps notes at three until reset', () => {
    let calls = 0
    const controller = new TurnIntentController()
    const input = makeInput(() => { calls++ })

    controller.evaluate(input)
    controller.evaluate(input)
    controller.evaluate(input)
    controller.evaluate(input)

    assert.equal(calls, 3)
    assert.equal(controller.getShownCount(), 3)

    controller.reset()
    controller.evaluate(input)
    assert.equal(calls, 4)
    assert.equal(controller.getShownCount(), 1)
  })
})
