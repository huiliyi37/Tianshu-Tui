/**
 * T2-02 Tests: P3 reward function, effort bandit shadow telemetry,
 * JIT write gate, PlanCache source gate.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  computeEffortReward,
  buildEffortContext,
  type RewardInput,
} from '../p3-reward.js'
import { P3Integration } from '../p3-integration.js'
import type { PlanStep } from '../plan-cache.js'

// ─── Reward Function Tests (§9.3 洞 1) ────────────────────────────────

describe('computeEffortReward', () => {
  it('returns 1.0 for perfect outcome', () => {
    const input: RewardInput = {
      toolSuccessRate: 1.0,
      repairRate: 0,
      doomDetected: false,
      tokenEfficiency: 1.0,
      userCorrected: false,
    }
    const reward = computeEffortReward(input)
    assert.ok(reward > 0.9, `expected high reward, got ${reward}`)
    assert.ok(reward <= 1.0)
  })

  it('returns negative for worst outcome', () => {
    const input: RewardInput = {
      toolSuccessRate: 0,
      repairRate: 1.0,
      doomDetected: true,
      tokenEfficiency: -1.0,
      userCorrected: true,
    }
    const reward = computeEffortReward(input)
    assert.ok(reward < -0.5, `expected low reward, got ${reward}`)
    assert.ok(reward >= -1.0)
  })

  it('瑶光 gate: different inputs produce different rewards (not single boolean)', () => {
    const sameCtxDifferentOutcome1: RewardInput = {
      toolSuccessRate: 0.8,
      repairRate: 0.2,
      doomDetected: false,
      tokenEfficiency: 0.5,
      userCorrected: false,
    }
    const sameCtxDifferentOutcome2: RewardInput = {
      toolSuccessRate: 0.2,
      repairRate: 0.8,
      doomDetected: true,
      tokenEfficiency: -0.5,
      userCorrected: true,
    }
    const r1 = computeEffortReward(sameCtxDifferentOutcome1)
    const r2 = computeEffortReward(sameCtxDifferentOutcome2)
    assert.notEqual(r1, r2, `rewards must differ: ${r1} vs ${r2}`)
  })

  it('clamps to [-1, 1]', () => {
    // Construct an input that would overflow without clamping
    const input: RewardInput = {
      toolSuccessRate: 2.0,  // > 1
      repairRate: -0.5,      // < 0
      doomDetected: false,
      tokenEfficiency: 2.0,  // > 1
      userCorrected: false,
    }
    const reward = computeEffortReward(input)
    assert.ok(reward >= -1.0 && reward <= 1.0, `reward ${reward} out of range`)
  })
})

// ─── Context Vector Tests ─────────────────────────────────────────────

describe('buildEffortContext', () => {
  it('produces 6-dim vector with values in [0,1]', () => {
    const ctx = buildEffortContext({
      taskComplexity: 0.7,
      errorRate: 0.3,
      turnDepth: 0.5,
      fileCount: 5,
      isRepeat: true,
      timeOfDay: 0.6,
    })
    assert.equal(ctx.length, 6)
    for (const v of ctx) {
      assert.ok(v >= 0 && v <= 1, `value ${v} out of [0,1]`)
    }
  })

  it('clamps values outside [0,1]', () => {
    const ctx = buildEffortContext({
      taskComplexity: 1.5,
      errorRate: -0.1,
      turnDepth: 2.0,
      fileCount: 1000,
      isRepeat: false,
      timeOfDay: -0.5,
    })
    for (const v of ctx) {
      assert.ok(v >= 0 && v <= 1, `value ${v} out of [0,1]`)
    }
  })

  it('isRepeat maps to 1', () => {
    const ctx = buildEffortContext({
      taskComplexity: 0.5, errorRate: 0, turnDepth: 0,
      fileCount: 0, isRepeat: true, timeOfDay: 0.5,
    })
    assert.equal(ctx[4], 1)
  })

  it('isRepeat false maps to 0', () => {
    const ctx = buildEffortContext({
      taskComplexity: 0.5, errorRate: 0, turnDepth: 0,
      fileCount: 0, isRepeat: false, timeOfDay: 0.5,
    })
    assert.equal(ctx[4], 0)
  })
})

// ─── Effort Bandit Tests (§9.3 洞 2) ───────────────────────────────────

describe('EffortBandit (delta arms)', () => {
  it('has three delta arms', () => {
    const p3 = new P3Integration()
    const stats = p3.effortBandit.getStats()
    const armIds = stats.map(s => s.id).sort()
    assert.equal(armIds.length, 3)
    assert.ok(armIds.includes('delta:-1'))
    assert.ok(armIds.includes('delta:0'))
    assert.ok(armIds.includes('delta:+1'))
  })

  it('shadowRecommendEffort returns record with required fields (§9.4 RED gate)', () => {
    const p3 = new P3Integration()
    // During cold start (< 10 pulls), shouldSuggest always returns a rec
    const ctx = [0.5, 0.3, 0.2, 0.1, 0, 0.4]
    const record = p3.shadowRecommendEffort(ctx, 'medium')
    assert.ok(record, 'should return a record during cold start')
    assert.equal(typeof record.pendingRewardId, 'string')
    assert.ok(record.pendingRewardId.length > 0, 'pendingRewardId must not be empty')
    assert.equal(record.ruleBaseline, 'medium')
    assert.equal(record.context.length, 6)
    assert.ok(['delta:-1', 'delta:0', 'delta:+1'].includes(record.recommendedArm))
    assert.equal(typeof record.timestamp, 'number')
  })

  it('completeEffortShadow resolves pending record', () => {
    const p3 = new P3Integration()
    const ctx = [0.5, 0.3, 0.2, 0.1, 0, 0.4]
    const record = p3.shadowRecommendEffort(ctx, 'medium')
    assert.ok(record)
    assert.equal(p3.pendingEffortShadows(), 1)

    p3.completeEffortShadow(record.pendingRewardId, {
      toolSuccessRate: 0.8,
      repairRate: 0.2,
      doomDetected: false,
      tokenEfficiency: 0.5,
      userCorrected: false,
    })
    assert.equal(p3.pendingEffortShadows(), 0)
  })

  it('completeEffortShadow with unknown id is no-op', () => {
    const p3 = new P3Integration()
    // Should not throw
    p3.completeEffortShadow('nonexistent', {
      toolSuccessRate: 0.5,
      repairRate: 0.5,
      doomDetected: false,
      tokenEfficiency: 0,
      userCorrected: false,
    })
  })

  it('recommendEffortDelta returns delta for arm', () => {
    const p3 = new P3Integration()
    const ctx = [0.5, 0.3, 0.2, 0.1, 0, 0.4]

    // Force a specific arm by manually training
    // Train delta:+1 with many positive rewards
    for (let i = 0; i < 20; i++) {
      p3.effortBandit.accept('delta:+1', ctx)
    }
    // Train delta:-1 with negative rewards
    for (let i = 0; i < 20; i++) {
      p3.effortBandit.reject('delta:-1', ctx)
    }

    const rec = p3.recommendEffortDelta(ctx)
    assert.ok(rec, 'should return a recommendation')
    assert.equal(rec.delta, 1)
    assert.equal(rec.armId, 'delta:+1')
  })

  it('serialization round-trips', () => {
    const p3 = new P3Integration()
    const ctx = [0.5, 0.3, 0.2, 0.1, 0, 0.4]
    // Train some data
    for (let i = 0; i < 5; i++) {
      p3.effortBandit.accept('delta:0', ctx)
    }

    const serialized = p3.serializeEffortBandit()
    const restored = P3Integration.deserializeEffortBandit(serialized)
    assert.ok(restored)
    // Restored bandit should have arms
    const stats = restored.getStats()
    assert.equal(stats.length, 3)
  })
})

// ─── PlanStep Extraction Tests ────────────────────────────────────────

describe('extractPlanSteps', () => {
  it('extracts successful tools, excludes deliver_task and ask_user_question', () => {
    const p3 = new P3Integration()
    const history = [
      { tool: 'read_file', target: 'src/a.ts', status: 'success' },
      { tool: 'grep', target: 'src/', status: 'success' },
      { tool: 'edit_file', target: 'src/b.ts', status: 'failed' },
      { tool: 'deliver_task', target: 'done', status: 'success' },
      { tool: 'ask_user_question', target: 'q', status: 'success' },
    ]
    const steps = p3.extractPlanSteps(history)
    assert.equal(steps.length, 2)
    assert.deepEqual(steps[0], { tool: 'read_file', target: 'src/a.ts' })
    assert.deepEqual(steps[1], { tool: 'grep', target: 'src/' })
  })

  it('returns empty array for all-failed history', () => {
    const p3 = new P3Integration()
    const history = [
      { tool: 'read_file', target: 'x.ts', status: 'failed' },
    ]
    const steps = p3.extractPlanSteps(history)
    assert.equal(steps.length, 0)
  })
})

// ─── JIT Write Gate Tests (§9.4 RED gate) ─────────────────────────────

describe('JIT write gate', () => {
  it('tryJIT rejects templates containing edit_file', async () => {
    const p3 = new P3Integration()
    // Manually populate plan cache with a template containing edit_file
    const steps: PlanStep[] = [
      { tool: 'read_file', target: 'src/a.ts' },
      { tool: 'edit_file', target: 'src/a.ts' },
    ]
    p3.planCache.record('edit src/a.ts', steps)

    // Force hit count >= 3 to trigger compilation
    const template = p3.planCache.lookup('edit src/a.ts')
    assert.ok(template)
    // Manually bump hitCount
    for (let i = 0; i < 3; i++) {
      p3.planCache.lookup('edit src/a.ts')
    }

    const result = await p3.tryJIT('edit src/a.ts')
    assert.equal(result, null, 'JIT must reject templates with write tools (§9.4 RED gate)')
  })

  it('tryJIT rejects templates containing write_file', async () => {
    const p3 = new P3Integration()
    const steps: PlanStep[] = [
      { tool: 'read_file', target: 'src/a.ts' },
      { tool: 'write_file', target: 'src/b.ts' },
    ]
    p3.planCache.record('write src/b.ts', steps)
    for (let i = 0; i < 3; i++) {
      p3.planCache.lookup('write src/b.ts')
    }

    const result = await p3.tryJIT('write src/b.ts')
    assert.equal(result, null)
  })

  it('tryJIT rejects templates containing delver_task', async () => {
    const p3 = new P3Integration()
    const steps: PlanStep[] = [
      { tool: 'read_file', target: 'src/a.ts' },
      { tool: 'deliver_task', target: 'done' },
    ]
    p3.planCache.record('deliver', steps)
    for (let i = 0; i < 3; i++) {
      p3.planCache.lookup('deliver')
    }

    const result = await p3.tryJIT('deliver')
    assert.equal(result, null)
  })

  it('tryJIT rejects templates containing bash', async () => {
    const p3 = new P3Integration()
    const steps: PlanStep[] = [
      { tool: 'read_file', target: 'src/a.ts' },
      { tool: 'bash', target: 'rm -rf' },
    ]
    p3.planCache.record('bash task', steps)
    for (let i = 0; i < 3; i++) {
      p3.planCache.lookup('bash task')
    }

    const result = await p3.tryJIT('bash task')
    assert.equal(result, null)
  })

  it('tryJIT allows readonly-only templates', async () => {
    const executed: Array<{ tool: string; args: Record<string, unknown> }> = []
    const p3 = new P3Integration({
      jitExecute: async (tool, args) => {
        executed.push({ tool, args })
        return { result: 'ok', isError: false }
      },
    })
    const steps: PlanStep[] = [
      { tool: 'read_file', target: 'src/a.ts' },
      { tool: 'grep', target: 'pattern' },
    ]
    p3.planCache.record('search src/a.ts', steps)
    // Bump hit count to trigger compilation
    for (let i = 0; i < 3; i++) {
      p3.planCache.lookup('search src/a.ts')
    }

    const result = await p3.tryJIT('search src/a.ts')
    assert.ok(result, 'should allow readonly tool sequences')
    assert.equal(result.success, true)
    assert.equal(executed.length, 2)
  })

  it('tryJIT rejects empty templates', async () => {
    const p3 = new P3Integration()
    // Empty steps (not enough for PlanCache, but test the gate anyway)
    const result = await p3.tryJIT('nonexistent task')
    assert.equal(result, null)
  })
})

// ─── PlanCache Source Gate Tests (§9.4 RED gate) ──────────────────────

describe('PlanCache source gate', () => {
  it('recordPlan stores structured PlanStep[]', () => {
    const p3 = new P3Integration()
    const steps: PlanStep[] = [
      { tool: 'read_file', target: 'src/a.ts' },
      { tool: 'edit_file', target: 'src/a.ts' },
      { tool: 'run_tests', target: 'src/__tests__/a.test.ts' },
    ]
    const template = p3.recordPlan('fix bug in a.ts', steps)
    assert.ok(template)
    assert.equal(template.steps.length, 3)
  })

  it('recordPlan rejects too-short step sequences', () => {
    const p3 = new P3Integration()
    const template = p3.recordPlan('simple task', [
      { tool: 'read_file', target: 'x.ts' },
    ])
    assert.equal(template, null)
  })
})
