import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { recordToolHistory } from '../tool-history-recorder.js'
import type { AgentLoop } from '../loop.js'

/**
 * PlanCache record key must be the task's user input — the same distribution
 * planCacheSuggest(userInput) uses on the lookup side. The old key was the
 * tool-chain string, whose keywords structurally never overlap a natural
 * language task description → near-zero hit rate.
 */

function makeSelf(initialUserMessage: string | null) {
  const recorded: Array<{ taskDesc: string }> = []
  const self = {
    recentToolHistory: [
      { tool: 'read_file', target: 'src/a.ts', status: 'success', argsHash: 'h1' },
      { tool: 'edit_file', target: 'src/a.ts', status: 'success', argsHash: 'h2' },
    ],
    initialUserMessage,
    touchedTsFiles: false,
    sawTypecheckThisTask: false,
    lastToolCompleteTime: 0,
    _lastImmuneHint: null,
    sensorium: null,
    currentSeason: null,
    vigorState: null,
    config: {},
    traceStore: { toolFingerprints: [], events: [] },
    session: { getTurnCount: () => 1, getEstimatedTokens: () => 100 },
    getDoomLoopLevel: () => 'none',
    immuneHook: { run: () => ({}) },
    p3: {
      invalidatePlanCache: () => {},
      invalidateJIT: () => {},
      extractPlanSteps: () => [
        { tool: 'read_file', target: 'src/a.ts' },
        { tool: 'edit_file', target: 'src/a.ts' },
      ],
      recordPlan: (taskDesc: string) => { recorded.push({ taskDesc }) },
      assessHealth: () => 'healthy',
      onToolComplete: () => {},
    },
  } as unknown as AgentLoop
  return { self, recorded }
}

describe('PlanCache record key (lookup-key alignment)', () => {
  it('keys the recorded plan by the task user input', () => {
    const { self, recorded } = makeSelf('给用户接口加分页功能')
    recordToolHistory(self, 'deliver_task', {}, false, 'delivered')
    assert.equal(recorded.length, 1)
    assert.equal(recorded[0]!.taskDesc, '给用户接口加分页功能')
  })

  it('falls back to the tool-chain string when no user message exists', () => {
    const { self, recorded } = makeSelf(null)
    recordToolHistory(self, 'deliver_task', {}, false, 'delivered')
    assert.equal(recorded.length, 1)
    assert.equal(recorded[0]!.taskDesc, 'read_file:src/a.ts → edit_file:src/a.ts → deliver_task:deliver_task')
  })
})
