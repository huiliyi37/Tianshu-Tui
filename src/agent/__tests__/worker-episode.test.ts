import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildWorkerEpisode,
  deriveWorkerEpisodeRewardInput,
  type WorkerEpisode,
} from '../worker-episode.js'
import { recordWorkerEpisodeClosure, resetRewardClosureClock, type RewardClosureRecord } from '../reward-loop.js'
import { buildHistoricalModelRewards } from '../model-reward-summary.js'
import { createWriteWorkOrder, type WorkerResult } from '../work-order.js'

function order() {
  return createWriteWorkOrder({
    parentTurnId: 't1',
    kind: 'patch_proposal',
    profile: 'patcher',
    objective: 'fix the parser',
    scope: { files: ['src/a.ts', 'src/b.ts'] },
  })
}

function result(overrides: Partial<WorkerResult> = {}): WorkerResult {
  return {
    workOrderId: 'wo-1',
    status: 'passed',
    summary: 'done',
    findings: [],
    artifacts: [],
    changedFiles: ['src/a.ts'],
    risks: [],
    nextActions: [],
    evidenceStatus: 'verified',
    ...overrides,
  }
}

function episode(overrides: Partial<WorkerEpisode> = {}): WorkerEpisode {
  const base = buildWorkerEpisode({
    order: order(),
    result: result(),
    sessionId: 's1',
    model: 'deepseek-chat',
    role: 'hands',
    writeGate: {
      report: { outcome: 'passed', checks: [], evidence: [], falseGreen: false, declaredFalseGreen: false },
      repairCount: 0,
    },
    timestamp: 1_000,
  })
  return { ...base, ...overrides }
}

class MemoryStore {
  rows = new Map<string, string>()
  saveBanditState(kind: string, json: string): void {
    this.rows.set(kind, json)
  }
  loadBanditStatesByPrefix(prefix: string, limit = 100): Array<{ kind: string; json: string }> {
    return [...this.rows.entries()]
      .filter(([kind]) => kind.startsWith(prefix))
      .slice(0, limit)
      .map(([kind, json]) => ({ kind, json }))
  }
}

describe('worker-episode (W4-D2/D3)', () => {
  beforeEach(() => resetRewardClosureClock())

  it('buildWorkerEpisode captures order/result/gate dimensions', () => {
    const o = order()
    const ep = buildWorkerEpisode({
      order: o,
      result: result(),
      sessionId: 's1',
      model: 'deepseek-chat',
      role: 'hands',
      writeGate: {
        report: { outcome: 'failed', checks: [], evidence: ['❌'], falseGreen: true, declaredFalseGreen: false },
        repairCount: 1,
      },
    })
    assert.equal(ep.orderId, o.id)
    assert.equal(ep.scopeFileCount, 2)
    assert.equal(ep.changedFileCount, 1)
    assert.equal(ep.gateOutcome, 'failed')
    assert.equal(ep.falseGreen, true)
    assert.equal(ep.repairCount, 1)
    assert.equal(ep.profile, 'patcher')
  })

  it('gate not-run when no writeGate info (read-only / gate disabled)', () => {
    const ep = buildWorkerEpisode({
      order: order(), result: result(), sessionId: 's1', model: 'm', role: 'hands',
    })
    assert.equal(ep.gateOutcome, 'not-run')
    assert.equal(ep.repairCount, 0)
  })

  it('reward derivation: passed → verificationPass true; failed → false + falseGreen', () => {
    const passed = deriveWorkerEpisodeRewardInput(episode({ gateOutcome: 'passed' }))
    assert.equal(passed?.verificationPass, true)

    const failed = deriveWorkerEpisodeRewardInput(episode({ gateOutcome: 'failed', falseGreen: true }))
    assert.equal(failed?.verificationPass, false)
    assert.equal(failed?.falseGreen, true)
  })

  it('reward derivation: blocked is environment-neutral — NO reward row', () => {
    assert.equal(deriveWorkerEpisodeRewardInput(episode({ gateOutcome: 'blocked' })), null)
  })

  it('reward derivation: skipped/not-run leave verification unobserved (neutral)', () => {
    for (const gateOutcome of ['skipped', 'not-run'] as const) {
      const input = deriveWorkerEpisodeRewardInput(episode({ gateOutcome }))
      assert.ok(input, `${gateOutcome} still yields a reward input`)
      assert.equal(input.verificationPass, undefined, `${gateOutcome} must not fake a verification signal`)
    }
  })

  it('recordWorkerEpisodeClosure persists episode + reward and feeds future dispatch ranking', () => {
    const store = new MemoryStore()
    const closure = recordWorkerEpisodeClosure(store, episode({ gateOutcome: 'passed' }))
    assert.ok(closure, 'reward closure produced for a passed gate')

    const episodeRows = store.loadBanditStatesByPrefix('worker_episode:s1:')
    assert.equal(episodeRows.length, 1, 'episode row persisted for diagnosis')

    const closureRows = store.loadBanditStatesByPrefix('reward_closure:worker_episode:')
    assert.equal(closureRows.length, 1, 'reward closure row persisted')
    const parsed = JSON.parse(closureRows[0]!.json) as RewardClosureRecord
    assert.equal(parsed.sourceKind, 'worker_episode')
    assert.equal(parsed.components.workerModel, 'deepseek-chat')
    assert.ok(parsed.reward > 0, 'verified pass earns a positive reward')

    // Fact-flow terminus: the summary that ranks models for FUTURE dispatch
    // sees the worker-episode reward attributed to the worker model.
    const summary = buildHistoricalModelRewards(store)
    assert.ok(summary['deepseek-chat'] !== undefined, 'worker model appears in historical rewards')
    assert.ok(summary['deepseek-chat']! > 0)
  })

  it('blocked episode persists for diagnosis but contributes NO reward', () => {
    const store = new MemoryStore()
    const closure = recordWorkerEpisodeClosure(store, episode({ gateOutcome: 'blocked' }))
    assert.equal(closure, null)
    assert.equal(store.loadBanditStatesByPrefix('worker_episode:').length, 1, 'episode row still persisted')
    assert.equal(store.loadBanditStatesByPrefix('reward_closure:worker_episode:').length, 0)
    assert.deepEqual(buildHistoricalModelRewards(store), {}, 'no capability penalty for env failures')
  })

  it('current-task immutability: closure recording is a pure store write with no dispatch side channel', () => {
    // The RewardClosureStore interface is exactly one method — saveBanditState.
    // Locking this here means any future attempt to hand the recorder a
    // model-switch / re-dispatch callback must consciously break this test.
    const calls: string[] = []
    const store = new Proxy({} as Record<string, unknown>, {
      get(_t, prop: string) {
        calls.push(prop)
        if (prop === 'saveBanditState') return () => {}
        return undefined
      },
    })
    recordWorkerEpisodeClosure(store as never, episode({ gateOutcome: 'failed', falseGreen: true }))
    assert.ok(calls.every(c => c === 'saveBanditState'), `only store writes allowed, saw: ${[...new Set(calls)].join(', ')}`)
  })

  it('falseGreen episode ranks strictly below a clean failure (heaviest penalty)', () => {
    const cleanFail = deriveWorkerEpisodeRewardInput(episode({ gateOutcome: 'failed', falseGreen: false }))!
    const falseGreen = deriveWorkerEpisodeRewardInput(episode({ gateOutcome: 'failed', falseGreen: true }))!
    const store1 = new MemoryStore()
    const store2 = new MemoryStore()
    recordWorkerEpisodeClosure(store1, episode({ gateOutcome: 'failed', falseGreen: false }))
    recordWorkerEpisodeClosure(store2, episode({ gateOutcome: 'failed', falseGreen: true }))
    const clean = buildHistoricalModelRewards(store1)['deepseek-chat']!
    const lying = buildHistoricalModelRewards(store2)['deepseek-chat']!
    assert.ok(lying < clean, `falseGreen (${lying}) must rank below clean failure (${clean})`)
    assert.equal(cleanFail.falseGreen, undefined)
    assert.equal(falseGreen.falseGreen, true)
  })
})
