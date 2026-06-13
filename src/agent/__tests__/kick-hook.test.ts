import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createRuntimeHookContext } from '../runtime-hooks.js'
import { createKickRuntimeHook } from '../hooks/kick-hook.js'
import type { PheromoneDeposit } from '../../context/stigmergy.js'
import type { Sensorium } from '../sensorium.js'

function makeSensorium(overrides: Partial<Sensorium> = {}): Sensorium {
  return {
    momentum: 0.1,
    pressure: 0.3,
    confidence: 0.5,
    complexity: 0.4,
    freshness: 0.5,
    stability: 0.2,
    ...overrides,
  }
}

function makeContext(options: {
  sensorium?: Sensorium | null
  history?: Array<{ tool: string; status: 'success' | 'failed' | 'running'; target: string }>
  messages?: string[]
  phases?: Array<{ phase: string; detail?: { reason?: string; suggestion?: string } }>
  turn?: number
} = {}) {
  return createRuntimeHookContext({
    cwd: '/tmp/project',
    turn: options.turn ?? 5,
    recentToolHistory: options.history ?? [],
    sensorium: options.sensorium === undefined ? makeSensorium() : options.sensorium,
    strategy: null,
    vigor: null,
    gitChangeRate: 0,
    season: null,
  }, {
    injectUserMessage: message => { options.messages?.push(message) },
    emitPhaseChange: (phase, detail) => { options.phases?.push({ phase, detail }) },
  })
}

describe('createKickRuntimeHook', () => {
  it('does nothing when sensorium is unavailable', async () => {
    const deposits: PheromoneDeposit[] = []
    const messages: string[] = []
    const hook = createKickRuntimeHook({ deposit: async d => { deposits.push(d) } })

    await hook.run(makeContext({ sensorium: null, messages }))

    assert.deepEqual(deposits, [])
    assert.deepEqual(messages, [])
  })

  it('does nothing when kick threshold is not reached', async () => {
    const deposits: PheromoneDeposit[] = []
    const messages: string[] = []
    const hook = createKickRuntimeHook({ deposit: async d => { deposits.push(d) } })

    await hook.run(makeContext({ sensorium: makeSensorium({ momentum: 0.8, stability: 0.9 }), messages }))

    assert.deepEqual(deposits, [])
    assert.deepEqual(messages, [])
  })

  it('injects a reframe message when kick is triggered', async () => {
    const deposits: PheromoneDeposit[] = []
    const messages: string[] = []
    const hook = createKickRuntimeHook({ deposit: async d => { deposits.push(d) } })

    await hook.run(makeContext({ messages }))

    assert.equal(deposits.length, 0)
    assert.equal(messages.length, 1)
    assert.match(messages[0]!, /天璇-感知/)
    assert.match(messages[0]!, /天璇胶囊/)
  })

  it('deposits recent failed targets as dead-end pheromones', async () => {
    const deposits: PheromoneDeposit[] = []
    const hook = createKickRuntimeHook({ deposit: async d => { deposits.push(d) } })

    await hook.run(makeContext({
      history: [
        { tool: 'bash', status: 'failed', target: 'npm test' },
        { tool: 'edit_file', status: 'failed', target: 'src/a.ts' },
      ],
    }))

    assert.deepEqual(deposits, [
      { path: 'npm test', signal: 'dead-end', strength: 0.9 },
      { path: 'src/a.ts', signal: 'dead-end', strength: 0.9 },
    ])
  })

  it('emits tianshu-encore when kick escalation threshold is reached', async () => {
    const deposits: PheromoneDeposit[] = []
    const phases: Array<{ phase: string; detail?: { reason?: string; suggestion?: string } }> = []
    const hook = createKickRuntimeHook({ deposit: async d => { deposits.push(d) } })

    await hook.run(makeContext({
      sensorium: makeSensorium({ confidence: 0.1, complexity: 0.8 }),
      phases,
    }))

    assert.equal(phases.length, 1)
    assert.equal(phases[0]!.phase, 'tianshu-encore')
    assert.match(phases[0]!.detail?.reason ?? '', /Dissipative kick/)
  })

  it('enforces cooldown: skips kick within cooldown window, resumes after', async () => {
    const deposits: PheromoneDeposit[] = []
    const messages: string[] = []
    const cooldown = 3
    const hook = createKickRuntimeHook({ deposit: async d => { deposits.push(d) }, cooldownTurns: cooldown })

    // Turn 1: should fire (first kick)
    await hook.run(makeContext({ messages, turn: 1 }))
    assert.equal(messages.length, 1, 'turn 1: first kick should fire')

    // Turn 2: within cooldown, should NOT fire
    await hook.run(makeContext({ messages, turn: 2 }))
    assert.equal(messages.length, 1, 'turn 2: should be blocked by cooldown')

    // Turn 3: within cooldown, should NOT fire
    await hook.run(makeContext({ messages, turn: 3 }))
    assert.equal(messages.length, 1, 'turn 3: should be blocked by cooldown')

    // Turn 4: cooldown expired, should fire again
    await hook.run(makeContext({ messages, turn: 4 }))
    assert.equal(messages.length, 2, 'turn 4: kick should fire after cooldown expires')

    // Turn 5: within cooldown again
    await hook.run(makeContext({ messages, turn: 5 }))
    assert.equal(messages.length, 2, 'turn 5: should be blocked again')

    // Turn 7: cooldown expired again
    await hook.run(makeContext({ messages, turn: 7 }))
    assert.equal(messages.length, 3, 'turn 7: third kick should fire')
  })
})
