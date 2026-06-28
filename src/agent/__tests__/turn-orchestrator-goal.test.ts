import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { TurnOrchestrator, type TurnOrchestratorDeps } from '../turn-orchestrator.js'
import { GoalContinuationController } from '../goal-continuation.js'
import { GoalTracker } from '../goal-tracker.js'
import type { GoalJudgeDeps } from '../goal-judge.js'
import type { CoordinatorRun } from '../coordinator.js'
import type { WorkerResult } from '../work-order.js'

/**
 * Focused unit tests for the goal-completion judge decision logic that the
 * orchestrator applies when the model self-declares "GOAL ACHIEVED". We invoke
 * the (now extracted) judgeGoalCompletion directly on GoalContinuationController
 * with minimal stub deps — exercising the full run loop would require mocking
 * the entire turn pipeline.
 */

function verdictRun(overall: string, summary = '', criteria: unknown[] = []): CoordinatorRun {
  const result: WorkerResult = {
    workOrderId: 'wo',
    status: 'passed',
    summary: 'ran',
    findings: [],
    artifacts: [{
      kind: 'note',
      title: 'goal-judge-verdict',
      content: JSON.stringify({ overall, criteria, summary }),
    }],
    changedFiles: [],
    risks: [],
    nextActions: [],
    evidenceStatus: 'verified',
  }
  return { status: 'completed', results: [result], packet: '' }
}

function makeController(opts: {
  judgeDeps?: GoalJudgeDeps | undefined
  streamedText?: string
  telemetrySink?: Array<Record<string, unknown>>
}): GoalContinuationController {
  return new GoalContinuationController({
    getGoalTracker: () => null,
    getGoalJudgeDeps: () => opts.judgeDeps,
    getGoalJudgeEvidence: () => ({ text: 'modified: a.ts', modifiedFiles: ['a.ts'] }),
    getStreamedText: () => opts.streamedText ?? 'GOAL ACHIEVED',
    getEstimatedTokens: () => 0,
    getSessionId: () => undefined,
    getCwd: () => '/tmp',
    appendSystemReminder: () => {},
    completeTurn: async () => {},
    writeTelemetry: (entry: Record<string, unknown>) => { opts.telemetrySink?.push(entry) },
    flushMeridianTurn: () => {},
  })
}

function makeTracker(maxJudgeRuns = 3): GoalTracker {
  return new GoalTracker({ goal: 'add tests', maxIterations: 20, contextWindow: 128000, successCriteria: ['c1', 'c2'], maxJudgeRuns })
}

type Decision = { action: 'accept' | 'continue'; reminder: string }
function judge(ctrl: GoalContinuationController, tracker: GoalTracker, signal?: AbortSignal): Promise<Decision> {
  return ctrl.judgeGoalCompletion(tracker, signal)
}

describe('TurnOrchestrator.judgeGoalCompletion', () => {
  it('accepts (legacy) without recording a judge run when judge is disabled', async () => {
    const ctrl = makeController({ judgeDeps: undefined })
    const tracker = makeTracker()
    const decision = await judge(ctrl, tracker, undefined)
    assert.equal(decision.action, 'accept')
    assert.equal(tracker.getJudgeRuns(), 0)
    assert.match(decision.reminder, /目标已达成/)
  })

  it('accepts when the judge verifies', async () => {
    const ctrl = makeController({ judgeDeps: { spawnJudge: async () => verdictRun('verified', 'all good') } })
    const tracker = makeTracker()
    const decision = await judge(ctrl, tracker, undefined)
    assert.equal(decision.action, 'accept')
    assert.equal(tracker.getJudgeRuns(), 1)
    assert.match(decision.reminder, /独立核验/)
  })

  it('continues with unmet criteria when rejected under the cap', async () => {
    const ctrl = makeController({
      judgeDeps: {
        spawnJudge: async () => verdictRun('rejected', 'c1 missing', [
          { criterion: 'c1', met: false, evidence: 'no test file' },
          { criterion: 'c2', met: true },
        ]),
      },
    })
    const tracker = makeTracker(3)
    const decision = await judge(ctrl, tracker, undefined)
    assert.equal(decision.action, 'continue')
    assert.match(decision.reminder, /JUDGE 驳回 1\/3/)
    assert.match(decision.reminder, /c1/)
    assert.match(decision.reminder, /no test file/)
    // c2 was met → must not be listed as unmet
    assert.doesNotMatch(decision.reminder.split('未达成的验收项')[1] ?? '', /c2/)
  })

  it('accepts with a warning once the judge run cap is reached', async () => {
    const ctrl = makeController({
      judgeDeps: { spawnJudge: async () => verdictRun('rejected', 'still broken', [{ criterion: 'c1', met: false }]) },
    })
    const tracker = makeTracker(1) // cap of 1: first run already hits the cap
    const decision = await judge(ctrl, tracker, undefined)
    assert.equal(decision.action, 'accept')
    assert.equal(tracker.getJudgeRuns(), 1)
    assert.match(decision.reminder, /上限/)
  })

  it('accepts with an unverified warning on inconclusive (fail-open)', async () => {
    const ctrl = makeController({ judgeDeps: {} }) // no spawnJudge → inconclusive
    const tracker = makeTracker()
    const decision = await judge(ctrl, tracker, undefined)
    assert.equal(decision.action, 'accept')
    assert.match(decision.reminder, /未能独立验证|未验证/)
  })

  it('reaches accept after exhausting the cap across repeated rejections', async () => {
    const ctrl = makeController({
      judgeDeps: { spawnJudge: async () => verdictRun('rejected', 'nope', [{ criterion: 'c1', met: false }]) },
    })
    const tracker = makeTracker(3)
    assert.equal((await judge(ctrl, tracker)).action, 'continue') // run 1
    assert.equal((await judge(ctrl, tracker)).action, 'continue') // run 2
    assert.equal((await judge(ctrl, tracker)).action, 'accept')   // run 3 = cap
    assert.equal(tracker.getJudgeRuns(), 3)
  })

  it('propagates abort', async () => {
    const ac = new AbortController()
    ac.abort()
    const ctrl = makeController({
      judgeDeps: { spawnJudge: async () => { await new Promise(r => setTimeout(r, 50)); return verdictRun('verified') } },
    })
    const tracker = makeTracker()
    await assert.rejects(() => judge(ctrl, tracker, ac.signal))
  })

  it('emits goal_judge_verdict telemetry on accept (verified)', async () => {
    const telemetry: Record<string, unknown>[] = []
    const ctrl = makeController({
      judgeDeps: { spawnJudge: async () => verdictRun('verified', 'all good', [
        { criterion: 'c1', met: true },
        { criterion: 'c2', met: true },
      ]) },
      telemetrySink: telemetry,
    })
    const tracker = makeTracker()
    const decision = await judge(ctrl, tracker, undefined)
    assert.equal(decision.action, 'accept')
    assert.equal(telemetry.length, 1)
    const entry = telemetry[0]!
    assert.equal(entry.kind, 'goal_judge_verdict')
    assert.equal(entry.overall, 'verified')
    assert.equal(entry.acceptedUnverified, false)
    assert.equal(entry.criteriaTotal, 2)
    assert.equal(entry.criteriaMet, 2)
    assert.equal(entry.criteriaUnmet, 0)
  })

  it('emits goal_judge_verdict telemetry with acceptedUnverified=true on inconclusive', async () => {
    const telemetry: Record<string, unknown>[] = []
    const ctrl = makeController({
      judgeDeps: {}, // no spawnJudge → inconclusive
      telemetrySink: telemetry,
    })
    const tracker = makeTracker()
    await judge(ctrl, tracker, undefined)
    assert.equal(telemetry.length, 1)
    assert.equal(telemetry[0]!.kind, 'goal_judge_verdict')
    assert.equal(telemetry[0]!.acceptedUnverified, true)
  })

  it('does NOT emit telemetry on continue (rejected under cap)', async () => {
    const telemetry: Record<string, unknown>[] = []
    const ctrl = makeController({
      judgeDeps: { spawnJudge: async () => verdictRun('rejected', 'c1 missing', [
        { criterion: 'c1', met: false },
      ]) },
      telemetrySink: telemetry,
    })
    const tracker = makeTracker(3)
    const decision = await judge(ctrl, tracker, undefined)
    assert.equal(decision.action, 'continue')
    assert.equal(telemetry.length, 0)
  })

  it('emits telemetry with acceptedUnverified=true when judge cap reached on rejected', async () => {
    const telemetry: Record<string, unknown>[] = []
    const ctrl = makeController({
      judgeDeps: { spawnJudge: async () => verdictRun('rejected', 'still broken', [
        { criterion: 'c1', met: false },
      ]) },
      telemetrySink: telemetry,
    })
    const tracker = makeTracker(1)
    const decision = await judge(ctrl, tracker, undefined)
    assert.equal(decision.action, 'accept')
    assert.equal(telemetry.length, 1)
    assert.equal(telemetry[0]!.acceptedUnverified, true)
    assert.equal(telemetry[0]!.overall, 'rejected')
  })
})
