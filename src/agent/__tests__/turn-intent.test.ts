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

function makeController(events: string[] = []): TurnIntentController {
  return new TurnIntentController({
    depositDeadEnd: async deposit => { events.push(`deposit:${deposit.signal}:${deposit.context}:${deposit.path}`) },
    addUserMessage: message => { events.push(`message:${message}`) },
  })
}

function makeInput(onIntentPreview?: (intent: IntentPreview) => Promise<'continue' | 'veto' | 'alternative'>) {
  return {
    strategy,
    vigor: createVigorState(),
    sensorium,
    pheromones: [],
    pressureResult,
    recentToolHistory: [{ tool: 'read_file', target: 'src/agent/loop.ts', status: 'success' as const }],
    onIntentPreview,
  }
}

describe('TurnIntentController', () => {
  it('returns continue when no preview callback is available', async () => {
    const controller = makeController()

    const result = await controller.evaluate(makeInput())

    assert.equal(result, 'continue')
    assert.equal(controller.getShownCount(), 0)
  })

  it('returns continue after user accepts preview and increments cap counter', async () => {
    const seen: IntentPreview[] = []
    const controller = makeController()

    const result = await controller.evaluate(makeInput(async intent => {
      seen.push(intent)
      return 'continue'
    }))

    assert.equal(result, 'continue')
    assert.equal(controller.getShownCount(), 1)
    assert.equal(seen[0]!.summary, '处理 src/agent/loop.ts')
  })

  it('deposits a dead-end and injects re-plan message on veto', async () => {
    const events: string[] = []
    const controller = makeController(events)

    const result = await controller.evaluate(makeInput(async () => 'veto'))

    assert.equal(result, 'veto')
    // path 存原始 target（非 preview.summary 摘要），绕开「处理 」前缀耦合
    assert.equal(events[0], 'deposit:dead-end:intent veto:src/agent/loop.ts')
    assert.match(events[1]!, /^message:<intent-veto>/)
    assert.equal(events.length, 2)
  })

  it('does NOT deposit dead-end when veto has no concrete target', async () => {
    // 无具体目标（全为 <... 伪目标或空）时不沉积——避免产生永不匹配的永久噪声 dead-end
    const events: string[] = []
    const controller = makeController(events)
    const input = makeInput(async () => 'veto')
    input.recentToolHistory = [{ tool: 'bash', target: '<ephemeral>', status: 'success' }]

    const result = await controller.evaluate(input)

    assert.equal(result, 'veto')
    assert.ok(!events.some(e => e.startsWith('deposit:')), '无具体目标不应沉积 dead-end')
    assert.match(events[0]!, /^message:<intent-veto>/)
  })

  it('injects alternative guidance on alternative action', async () => {
    const events: string[] = []
    const controller = makeController(events)

    const result = await controller.evaluate(makeInput(async () => 'alternative'))

    assert.equal(result, 'alternative')
    assert.deepEqual(events, [
      'message:<intent-alternative>User requested an alternative path. Prefer a lower-risk option and explain the tradeoff before using tools.</intent-alternative>',
    ])
  })

  it('caps previews at three until reset', async () => {
    let calls = 0
    const controller = makeController()
    const input = makeInput(async () => {
      calls++
      return 'continue'
    })

    await controller.evaluate(input)
    await controller.evaluate(input)
    await controller.evaluate(input)
    const capped = await controller.evaluate(input)

    assert.equal(capped, 'continue')
    assert.equal(calls, 3)
    assert.equal(controller.getShownCount(), 3)

    controller.reset()
    await controller.evaluate(input)
    assert.equal(calls, 4)
    assert.equal(controller.getShownCount(), 1)
  })
})
