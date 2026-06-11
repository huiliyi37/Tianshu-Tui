/**
 * Track 2 episode 闭环：recordTeamEpisodeClosureFromStore 把存储里的 wave
 * 片段聚合为 episode 并落 reward_closure:team_episode: 记录 —— 晋升闸
 * (gated-influence-evaluation) 等待的生产者。
 *
 * 契约：
 * - 多波片段齐全 → episode complete → 产出 episode reward closure
 * - 同 fromWave 重复片段（重跑）→ 保留最新，不误判 incomplete
 * - 缺波 → episode 持久化但无 reward（deriveTeamEpisodeRewardInput=null）
 * - 单波（waveCount=1）无需读存储也能闭环
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { recordTeamEpisodeClosureFromStore, type TeamEpisodeClosureStore } from '../reward-loop.js'
import type { TeamWaveTelemetry } from '../team-wave-telemetry.js'
import { teamWaveTelemetryKind } from '../team-wave-telemetry.js'

function memStore(): TeamEpisodeClosureStore & { rows: Map<string, string> } {
  const rows = new Map<string, string>()
  return {
    rows,
    saveBanditState: (kind, json) => { rows.set(kind, json) },
    loadBanditStatesByPrefix: (prefix, limit = 100) =>
      [...rows.entries()]
        .filter(([kind]) => kind.startsWith(prefix))
        .slice(0, limit)
        .map(([kind, json]) => ({ kind, json })),
  }
}

function fragment(over: Partial<TeamWaveTelemetry> & { fromWave: number; timestamp: number }): TeamWaveTelemetry {
  return {
    schemaVersion: 1,
    sessionId: 's1',
    objectiveHash: 'obj1',
    mode: 'max',
    waveId: `W${over.fromWave + 1}`,
    waveCount: 2,
    planned: { taskIds: [`t${over.fromWave}`], risk: 'low', profiles: ['patcher'], authorities: ['tianliang'], files: ['src/a.ts'] },
    outcome: {
      dispatched: 1,
      statuses: [{ workOrderId: `team:t${over.fromWave}`, status: 'passed', evidenceStatus: 'verified' }],
      verificationPassed: true,
    },
    changedFiles: { changedFilesSource: 'worker_result' },
    ...over,
  }
}

function seed(store: ReturnType<typeof memStore>, f: TeamWaveTelemetry): void {
  store.rows.set(teamWaveTelemetryKind(f), JSON.stringify(f))
}

describe('recordTeamEpisodeClosureFromStore (Track 2)', () => {
  it('aggregates all waves and records an episode reward closure', () => {
    const store = memStore()
    seed(store, fragment({ fromWave: 0, timestamp: 1_000 }))
    const last = fragment({ fromWave: 1, timestamp: 2_000, outcome: {
      dispatched: 1,
      statuses: [{ workOrderId: 'team:t1', status: 'passed', evidenceStatus: 'verified' }],
      verificationPassed: true,
      reviewVerdict: 'pass',
    } })
    seed(store, last)

    const record = recordTeamEpisodeClosureFromStore(store, last)
    assert.ok(record, 'complete episode produces a reward closure')
    assert.equal(record.sourceKind, 'team_episode')
    assert.ok(record.reward > 0, 'all-passed episode rewards positively')

    const closures = [...store.rows.keys()].filter(k => k.startsWith('reward_closure:team_episode:'))
    assert.equal(closures.length, 1, 'closure persisted under the promotion-gate prefix')
    const episodes = [...store.rows.keys()].filter(k => k.startsWith('team_episode:'))
    assert.equal(episodes.length, 1, 'episode body persisted')
  })

  it('keeps only the latest fragment per wave on objective re-runs', () => {
    const store = memStore()
    seed(store, fragment({ fromWave: 0, timestamp: 1_000 }))
    seed(store, fragment({ fromWave: 0, timestamp: 5_000 })) // re-run of wave 0
    const last = fragment({ fromWave: 1, timestamp: 6_000 })
    seed(store, last)

    const record = recordTeamEpisodeClosureFromStore(store, last)
    assert.ok(record, 'duplicates deduped by latest timestamp — episode still complete')
  })

  it('missing waves: persists the episode but produces no reward', () => {
    const store = memStore()
    const last = fragment({ fromWave: 1, timestamp: 2_000 }) // wave 0 never recorded
    const record = recordTeamEpisodeClosureFromStore(store, last)
    assert.equal(record, null, 'incomplete episode yields no reward closure')
    const episodes = [...store.rows.keys()].filter(k => k.startsWith('team_episode:'))
    assert.equal(episodes.length, 1, 'episode body still persisted for diagnosis')
  })

  it('single-wave episode closes without loading the store', () => {
    const last = fragment({ fromWave: 0, timestamp: 1_000, waveCount: 1 })
    const store = memStore()
    const record = recordTeamEpisodeClosureFromStore(store, last)
    assert.ok(record, 'waveCount=1 closes from the anchor fragment alone')
  })

  it('tolerates a store without load capability', () => {
    const last = fragment({ fromWave: 0, timestamp: 1_000, waveCount: 1 })
    const saved: string[] = []
    const record = recordTeamEpisodeClosureFromStore(
      { saveBanditState: (kind) => { saved.push(kind) } },
      last,
    )
    assert.ok(record)
    assert.ok(saved.some(k => k.startsWith('reward_closure:team_episode:')))
  })
})
