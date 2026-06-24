import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import type { CoordinatorRun } from '../coordinator.js'
import type { WorkerArtifact, WorkerResult } from '../work-order.js'
import {
  buildJudgeObjective,
  extractVerdictJson,
  runGoalJudge,
  type GoalJudgeDeps,
} from '../goal-judge.js'

function workerResult(artifacts: WorkerArtifact[], summary = 'judge ran'): WorkerResult {
  return {
    workOrderId: 'wo-1',
    status: 'passed',
    summary,
    findings: [],
    artifacts,
    changedFiles: [],
    risks: [],
    nextActions: [],
    evidenceStatus: 'verified',
  }
}

function runWith(results: WorkerResult[], status: CoordinatorRun['status'] = 'completed'): CoordinatorRun {
  return { status, results, packet: '' }
}

function verdictArtifact(json: string): WorkerArtifact {
  return { kind: 'note', title: 'goal-judge-verdict', content: json }
}

const CRITERIA = ['c1', 'c2']

describe('extractVerdictJson', () => {
  it('parses a clean verdict object', () => {
    const v = extractVerdictJson('{"overall":"verified","criteria":[],"summary":"ok"}')
    assert.equal(v?.overall, 'verified')
    assert.equal(v?.summary, 'ok')
  })

  it('extracts a verdict embedded in prose / fences', () => {
    const text = 'Here:\n```json\n{"overall":"rejected","criteria":[{"criterion":"c1","met":false,"evidence":"test failed"}],"summary":"c1 not met"}\n```'
    const v = extractVerdictJson(text)
    assert.equal(v?.overall, 'rejected')
    assert.equal(v?.criteria[0]?.met, false)
    assert.equal(v?.criteria[0]?.evidence, 'test failed')
  })

  it('coerces met into true/false/null', () => {
    const v = extractVerdictJson('{"overall":"verified","criteria":[{"criterion":"a","met":true},{"criterion":"b","met":"maybe"}],"summary":""}')
    assert.equal(v?.criteria[0]?.met, true)
    assert.equal(v?.criteria[1]?.met, null)
  })

  it('skips a leading non-verdict object and finds the real one', () => {
    const text = '{"unrelated":1} then {"overall":"inconclusive","criteria":[],"summary":"hm"}'
    assert.equal(extractVerdictJson(text)?.overall, 'inconclusive')
  })

  it('returns null when no valid verdict object exists', () => {
    assert.equal(extractVerdictJson('{"foo":"bar"}'), null)
    assert.equal(extractVerdictJson('no json'), null)
    assert.equal(extractVerdictJson(''), null)
  })
})

describe('buildJudgeObjective', () => {
  it('embeds goal, criteria, evidence, and claim', () => {
    const obj = buildJudgeObjective({
      objective: 'add feature',
      criteria: ['has tests', 'tests pass'],
      evidence: 'modified: a.ts',
      finalClaim: 'GOAL ACHIEVED',
    })
    assert.match(obj, /Goal: add feature/)
    assert.match(obj, /1\. has tests/)
    assert.match(obj, /2\. tests pass/)
    assert.match(obj, /modified: a\.ts/)
    assert.match(obj, /GOAL ACHIEVED/)
  })

  it('handles empty criteria with a wide-judgment hint', () => {
    const obj = buildJudgeObjective({ objective: 'x', criteria: [], evidence: '', finalClaim: '' })
    assert.match(obj, /none extracted/)
  })

  it('includes browser verification instructions when browserMode is true', () => {
    const obj = buildJudgeObjective({
      objective: 'page shows correct data',
      criteria: ['page renders table'],
      evidence: 'modified: App.tsx',
      finalClaim: 'GOAL ACHIEVED',
      browserMode: true,
    })
    assert.match(obj, /Browser\/API verification is ENABLED/)
    assert.match(obj, /web_fetch/)
  })

  it('does NOT include browser instructions when browserMode is absent', () => {
    const obj = buildJudgeObjective({
      objective: 'add unit tests',
      criteria: ['tests pass'],
      evidence: '',
      finalClaim: '',
    })
    assert.doesNotMatch(obj, /Browser\/API verification/)
  })
})

describe('runGoalJudge', () => {
  const input = { objective: 'goal', criteria: CRITERIA, evidence: 'ev', finalClaim: 'done' }

  it('returns verified when the worker says verified', async () => {
    const deps: GoalJudgeDeps = {
      spawnJudge: async () => runWith([workerResult([verdictArtifact('{"overall":"verified","criteria":[],"summary":"all good"}')])]),
    }
    const v = await runGoalJudge(deps, input)
    assert.equal(v.overall, 'verified')
  })

  it('returns rejected with the gap when the worker rejects', async () => {
    const deps: GoalJudgeDeps = {
      spawnJudge: async () => runWith([workerResult([verdictArtifact('{"overall":"rejected","criteria":[{"criterion":"c1","met":false}],"summary":"c1 missing"}')])]),
    }
    const v = await runGoalJudge(deps, input)
    assert.equal(v.overall, 'rejected')
    assert.equal(v.summary, 'c1 missing')
  })

  it('falls open to inconclusive when no coordinator is wired', async () => {
    const v = await runGoalJudge({}, input)
    assert.equal(v.overall, 'inconclusive')
    assert.equal(v.criteria.length, CRITERIA.length)
  })

  it('falls open to inconclusive when spawn throws (non-abort)', async () => {
    const deps: GoalJudgeDeps = { spawnJudge: async () => { throw new Error('boom') } }
    const v = await runGoalJudge(deps, input)
    assert.equal(v.overall, 'inconclusive')
    assert.match(v.summary, /boom/)
  })

  it('rethrows when aborted', async () => {
    const ac = new AbortController()
    ac.abort()
    const deps: GoalJudgeDeps = { spawnJudge: async () => { throw new Error('aborted') } }
    await assert.rejects(() => runGoalJudge(deps, { ...input, signal: ac.signal }))
  })

  it('falls open to inconclusive when the run is skipped', async () => {
    const deps: GoalJudgeDeps = { spawnJudge: async () => runWith([], 'skipped') }
    const v = await runGoalJudge(deps, input)
    assert.equal(v.overall, 'inconclusive')
  })

  it('falls open to inconclusive when the verdict is unparseable', async () => {
    const deps: GoalJudgeDeps = {
      spawnJudge: async () => runWith([workerResult([{ kind: 'note', title: 'x', content: 'no verdict here' }], 'just prose')]),
    }
    const v = await runGoalJudge(deps, input)
    assert.equal(v.overall, 'inconclusive')
  })

  it('reads the verdict from the summary when no artifact carries it', async () => {
    const deps: GoalJudgeDeps = {
      spawnJudge: async () => runWith([workerResult([], '{"overall":"verified","criteria":[],"summary":"ok"}')]),
    }
    const v = await runGoalJudge(deps, input)
    assert.equal(v.overall, 'verified')
  })

  it('passes deps.browserMode into the objective when input.browserMode is unset', async () => {
    let capturedObjective = ''
    const deps: GoalJudgeDeps = {
      spawnJudge: async (objective) => {
        capturedObjective = objective
        return runWith([workerResult([verdictArtifact('{"overall":"verified","criteria":[],"summary":"ok"}')])])
      },
      browserMode: true,
    }
    await runGoalJudge(deps, input)
    assert.match(capturedObjective, /Browser\/API verification is ENABLED/)
  })
})
