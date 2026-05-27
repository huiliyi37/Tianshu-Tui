import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createRuntimeHookContext } from '../runtime-hooks.js'
import { createSonglineRuntimeHook } from '../hooks/songline-hook.js'
import type { PheromoneDeposit } from '../../context/stigmergy.js'
import type { TaskLedgerSummary } from '../task-ledger.js'

function makeContext() {
  return createRuntimeHookContext({
    cwd: '/tmp/project',
    turn: 7,
    recentToolHistory: [],
    sensorium: null,
    strategy: null,
    vigor: null,
    gitChangeRate: 0,
    season: null,
  })
}

function makeSummary(overrides: Partial<TaskLedgerSummary> = {}): TaskLedgerSummary {
  return {
    taskId: 'task-123',
    eventCount: 3,
    readFileCount: 1,
    writeFileCount: 1,
    ownedFileCount: 1,
    verificationCount: 1,
    verificationStatus: 'verified',
    firstEventAt: 1000,
    lastEventAt: 2000,
    ...overrides,
  }
}

describe('songline-runtime hook', () => {
  it('does not deposit when disabled', async () => {
    const deposits: PheromoneDeposit[] = []
    const hook = createSonglineRuntimeHook({
      enabled: false,
      getTaskSummary: () => makeSummary(),
      deposit: async deposit => { deposits.push(deposit) },
    })

    await hook.run(makeContext())

    assert.deepEqual(deposits, [])
  })

  it('deposits obligation signal on postSession when explicitly enabled', async () => {
    const deposits: PheromoneDeposit[] = []
    const hook = createSonglineRuntimeHook({
      enabled: true,
      getTaskSummary: () => makeSummary(),
      deposit: async deposit => { deposits.push(deposit) },
    })

    await hook.run(makeContext())

    assert.equal(deposits.length, 1)
    assert.equal(deposits[0]!.path, 'task://task-123')
    assert.equal(deposits[0]!.signal, 'obligation-fulfilled')
    assert.equal(deposits[0]!.strength, 1)
  })

  it('skips empty summaries to avoid background noise', async () => {
    const deposits: PheromoneDeposit[] = []
    const hook = createSonglineRuntimeHook({
      enabled: true,
      getTaskSummary: () => makeSummary({
        eventCount: 0,
        readFileCount: 0,
        writeFileCount: 0,
        ownedFileCount: 0,
        verificationCount: 0,
      }),
      deposit: async deposit => { deposits.push(deposit) },
    })

    await hook.run(makeContext())

    assert.deepEqual(deposits, [])
  })

  it('can persist cycle close when a registry bridge is provided', async () => {
    const closes: Array<{ sessionId: string; close: string }> = []
    const hook = createSonglineRuntimeHook({
      enabled: true,
      sessionId: 'session-1',
      getTaskSummary: () => makeSummary(),
      deposit: async () => {},
      setCycleClose: (sessionId, close) => { closes.push({ sessionId, close }) },
    })

    await hook.run(makeContext())

    assert.equal(closes.length, 1)
    assert.equal(closes[0]!.sessionId, 'session-1')
    assert.match(closes[0]!.close, /^[0-9a-f]{64}$/)
  })
})
