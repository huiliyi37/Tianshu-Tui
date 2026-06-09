import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  evaluateGatedInfluenceHistory,
  renderGatedInfluenceEvaluationMarkdown,
  type GatedInfluenceEvaluationStore,
} from '../gated-influence-evaluation.js'

function store(rowsByPrefix: Record<string, Array<{ kind: string; json: string }>>): GatedInfluenceEvaluationStore {
  return {
    loadBanditStatesByPrefix: (prefix: string) => rowsByPrefix[prefix] ?? [],
  }
}

function audit(source: string, overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    schemaVersion: 1,
    source,
    sessionId: 's1',
    targetId: 'target-1',
    gateOpen: false,
    applied: false,
    reason: 'shadow',
    evidenceWindow: {},
    vetoSignals: [],
    timestamp: 1,
    ...overrides,
  })
}

function schedulerShadow(i: number, recommendedArm = 'parallelism:1', ruleParallelism = 2) {
  return JSON.stringify({
    schemaVersion: 1,
    sessionId: 's1',
    objectiveHash: 'obj',
    waveId: `W${i}`,
    ruleParallelism,
    recommendedArm,
    applied: false,
    gateOpen: false,
    reason: 'shadow',
    pendingRewardId: `r${i}`,
    timestamp: i,
  })
}

function schedulerReward(i: number, arm = 'parallelism:1', reward = 0.5, components: Record<string, unknown> = {}) {
  return JSON.stringify({
    schemaVersion: 1,
    sessionId: 's1',
    objectiveHash: 'obj',
    waveId: `W${i}`,
    arm,
    reward,
    components: { falseGreen: false, scopeLeakRate: 0, ...components },
    timestamp: i,
  })
}

function tierShadow(i: number, recommendedTier = 'balanced', actualTier = 'balanced') {
  return JSON.stringify({
    schemaVersion: 1,
    sessionId: 's1',
    workOrderId: `team:T${i}`,
    profile: 'reviewer',
    kind: 'review',
    recommendedTier,
    actualModel: `${actualTier}-model`,
    actualTier,
    matched: recommendedTier === actualTier,
    reason: 'history',
    timestamp: i,
  })
}

function rewardClosure(i: number, tier = 'cheap', reward = 0.8, components: Record<string, unknown> = {}) {
  return JSON.stringify({
    schemaVersion: 1,
    id: `r${i}`,
    sourceKind: 'team_wave',
    sourceKey: `team_wave:${i}`,
    sessionId: 's1',
    reward,
    components: { workerTier: tier, falseGreen: false, ...components },
    timestamp: i,
  })
}

describe('gated influence evaluation', () => {
  it('keeps insufficient samples shadow-only instead of suggesting enablement', () => {
    const report = evaluateGatedInfluenceHistory(store({
      'team_scheduler_shadow:': Array.from({ length: 3 }, (_, i) => ({ kind: `team_scheduler_shadow:${i}`, json: schedulerShadow(i) })),
      'gated_influence_audit:team_scheduler_bandit:': [{ kind: 'gated_influence_audit:team_scheduler_bandit:s1:W1:1', json: audit('team_scheduler_bandit', { gateOpen: true }) }],
    }))

    const scheduler = report.sources.team_scheduler_bandit
    assert.equal(scheduler.totalShadowSamples, 3)
    assert.equal(scheduler.gateOpenCount, 1)
    assert.equal(scheduler.appliedCount, 0)
    assert.equal(scheduler.recommendation, 'keep_shadow_only')
    assert.match(scheduler.recommendationReason, /insufficient samples/)
  })

  it('does not count gateOpen-only audit rows as real applied effect', () => {
    const report = evaluateGatedInfluenceHistory(store({
      'team_scheduler_shadow:': Array.from({ length: 35 }, (_, i) => ({ kind: `team_scheduler_shadow:${i}`, json: schedulerShadow(i) })),
      'team_scheduler_reward:': Array.from({ length: 35 }, (_, i) => ({ kind: `team_scheduler_reward:${i}`, json: schedulerReward(i, 'parallelism:1', 0.7) })),
      'team_scope_health:': [{ kind: 'team_scope_health:obj:s1:team_wave:1:x', json: JSON.stringify({ schemaVersion: 1, severity: 'healthy', scopeLeakRate: 0 }) }],
      'gated_influence_audit:team_scheduler_bandit:': [
        { kind: 'gated_influence_audit:team_scheduler_bandit:s1:W1:1', json: audit('team_scheduler_bandit', { gateOpen: true, applied: false, evidenceWindow: { rewardMargin: 0.9 } }) },
      ],
    }))

    const scheduler = report.sources.team_scheduler_bandit
    assert.equal(scheduler.gateOpenCount, 1)
    assert.equal(scheduler.appliedCount, 0)
    assert.equal(scheduler.regretEstimate, 0.9)
    assert.equal(scheduler.recommendation, 'allow_manual_opt_in')
    assert.match(scheduler.recommendationReason, /gateOpen evidence exists but applied evidence is absent/)
  })

  it('keeps per-source metrics isolated instead of mixing a total score', () => {
    const report = evaluateGatedInfluenceHistory(store({
      'team_scheduler_shadow:': Array.from({ length: 35 }, (_, i) => ({ kind: `team_scheduler_shadow:${i}`, json: schedulerShadow(i) })),
      'team_scheduler_reward:': Array.from({ length: 35 }, (_, i) => ({ kind: `team_scheduler_reward:${i}`, json: schedulerReward(i, 'parallelism:1', 0.7) })),
      'model_tier_shadow:': Array.from({ length: 5 }, (_, i) => ({ kind: `model_tier_shadow:${i}`, json: tierShadow(i) })),
      'reward_closure:team_wave:': Array.from({ length: 5 }, (_, i) => ({ kind: `reward_closure:team_wave:${i}`, json: rewardClosure(i, 'cheap', 0.9) })),
    }))

    assert.equal(report.sources.team_scheduler_bandit.totalShadowSamples, 35)
    assert.equal(report.sources.model_tier_bandit.totalShadowSamples, 5)
    assert.equal(report.sources.team_scheduler_bandit.averageRewardByCandidate['parallelism:1'], 0.7)
    assert.equal(report.sources.model_tier_bandit.averageRewardByCandidate.cheap, 0.9)
    assert.equal(report.sources.model_tier_bandit.recommendation, 'keep_shadow_only')
  })

  it('ignores malformed rows without inventing samples', () => {
    const report = evaluateGatedInfluenceHistory(store({
      'team_scheduler_shadow:': [{ kind: 'bad', json: '{not json' }],
      'gated_influence_audit:team_scheduler_bandit:': [{ kind: 'bad-audit', json: JSON.stringify({ schemaVersion: 1, source: 'team_scheduler_bandit' }) }],
    }))

    assert.equal(report.sources.team_scheduler_bandit.totalShadowSamples, 0)
    assert.equal(report.sources.team_scheduler_bandit.gateOpenCount, 0)
    assert.equal(report.malformedRows, 2)
  })

  it('lets false-green veto recommendation instead of being hidden by reward average', () => {
    const report = evaluateGatedInfluenceHistory(store({
      'model_tier_shadow:': Array.from({ length: 35 }, (_, i) => ({ kind: `model_tier_shadow:${i}`, json: tierShadow(i, 'cheap', 'cheap') })),
      'reward_closure:team_wave:': Array.from({ length: 35 }, (_, i) => ({
        kind: `reward_closure:team_wave:${i}`,
        json: rewardClosure(i, 'cheap', 0.95, i === 0 ? { falseGreen: true } : {}),
      })),
      'gated_influence_audit:model_tier_bandit:': [{ kind: 'audit', json: audit('model_tier_bandit', { gateOpen: true, applied: true }) }],
    }))

    const tier = report.sources.model_tier_bandit
    assert.equal(tier.falseGreenRate, 1 / 35)
    assert.equal(tier.recommendation, 'disable_and_investigate')
    assert.match(tier.recommendationReason, /false-green/)
  })

  it('does not use audit rows as training samples or reward rows', () => {
    const report = evaluateGatedInfluenceHistory(store({
      'gated_influence_audit:model_tier_bandit:': [
        { kind: 'audit', json: audit('model_tier_bandit', { gateOpen: true, applied: true, evidenceWindow: { candidateScore: 1, rewardMargin: 1 } }) },
      ],
    }))

    const tier = report.sources.model_tier_bandit
    assert.equal(tier.totalShadowSamples, 0)
    assert.deepEqual(tier.averageRewardByCandidate, {})
    assert.equal(tier.regretEstimate, 1)
    assert.equal(tier.recommendation, 'keep_shadow_only')
  })

  it('leaves unknown scope as unknown instead of guessing healthy', () => {
    const report = evaluateGatedInfluenceHistory(store({
      'model_tier_shadow:': Array.from({ length: 35 }, (_, i) => ({ kind: `model_tier_shadow:${i}`, json: tierShadow(i) })),
      'reward_closure:team_wave:': Array.from({ length: 35 }, (_, i) => ({ kind: `reward_closure:team_wave:${i}`, json: rewardClosure(i, 'balanced', 0.6) })),
    }))

    const tier = report.sources.model_tier_bandit
    assert.equal(tier.scopeLeakRate, undefined)
    assert.equal(tier.worstScopeSeverity, undefined)
    assert.equal(tier.recommendation, 'keep_shadow_only')
    assert.match(tier.recommendationReason, /scope health unknown/)
  })

  it('renders a factual markdown report with recommendations', () => {
    const report = evaluateGatedInfluenceHistory(store({}))
    const markdown = renderGatedInfluenceEvaluationMarkdown(report)
    assert.match(markdown, /T5 收官偏差验收报告/)
    assert.match(markdown, /team_scheduler_bandit/)
    assert.match(markdown, /keep_shadow_only/)
    assert.doesNotMatch(markdown, /智能提升已证明/)
  })
})
