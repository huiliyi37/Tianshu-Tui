import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { buildHistoricalModelRewards, type ModelRewardSummaryStore } from '../model-reward-summary.js'

function store(rowsByPrefix: Record<string, Array<{ kind: string; json: string }>>): ModelRewardSummaryStore {
  return {
    loadBanditStatesByPrefix: (prefix: string) => rowsByPrefix[prefix] ?? [],
  }
}

function routingClosure(model: string, reward: number): string {
  return JSON.stringify({
    schemaVersion: 1,
    sourceKind: 'routing_shadow',
    sourceKey: 'routing_shadow:s1:1:100',
    sessionId: 's1',
    reward,
    components: { recommendedModel: model },
    timestamp: 200,
  })
}

function teamClosureWithWorkerModel(model: string, reward: number): string {
  return JSON.stringify({
    schemaVersion: 1,
    sourceKind: 'team_wave',
    sourceKey: 'team_wave:obj:s1:0:100',
    sessionId: 's1',
    reward,
    components: { workerModel: model },
    timestamp: 200,
  })
}

describe('model reward summary', () => {
  it('aggregates routing-shadow reward closures into per-model averages', () => {
    const summary = buildHistoricalModelRewards(store({
      'reward_closure:routing_shadow:': [
        { kind: 'reward_closure:routing_shadow:s1:1:a', json: routingClosure('pro', 0.6) },
        { kind: 'reward_closure:routing_shadow:s1:2:b', json: routingClosure('pro', -0.2) },
        { kind: 'reward_closure:routing_shadow:s1:3:c', json: routingClosure('flash', 0.4) },
      ],
    }))

    assert.deepEqual(summary, { pro: 0.2, flash: 0.4 })
  })

  it('keeps malformed and model-less closures neutral', () => {
    const summary = buildHistoricalModelRewards(store({
      'reward_closure:routing_shadow:': [
        { kind: 'reward_closure:routing_shadow:s1:1:a', json: '{bad json' },
        { kind: 'reward_closure:routing_shadow:s1:2:b', json: JSON.stringify({ schemaVersion: 1, sourceKind: 'routing_shadow', reward: 0.5, components: {} }) },
        { kind: 'reward_closure:routing_shadow:s1:3:c', json: routingClosure('pro', Number.NaN) },
      ],
    }))

    assert.deepEqual(summary, {})
  })

  it('can consume future team-wave closures when they carry explicit worker model identity', () => {
    const summary = buildHistoricalModelRewards(store({
      'reward_closure:team_wave:': [
        { kind: 'reward_closure:team_wave:s1:1:a', json: teamClosureWithWorkerModel('opus', 0.8) },
      ],
    }))

    assert.deepEqual(summary, { opus: 0.8 })
  })
})
