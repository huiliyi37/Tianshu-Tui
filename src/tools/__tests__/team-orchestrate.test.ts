import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  createTeamOrchestrateTool,
  formatTeamSummary,
  teamReviewChangedFiles,
  teamReviewForceLevel,
  teamReviewFocusHint,
} from '../team-orchestrate.js'
import type { CoordinatorRun, DelegationRequest } from '../../agent/coordinator.js'
import type { ChangeSet } from '../../agent/review-discipline.js'
import type { TeamTask } from '../../agent/team-plan.js'
import type { TeamRunSummary } from '../../agent/team-orchestrator.js'
import { decodeTeamPanelModel } from '../../tui/team-panel-model.js'

function stubRun(packet = 'stub'): CoordinatorRun {
  return { status: 'completed', results: [], packet }
}

function mkTask(over: Partial<TeamTask> = {}): TeamTask {
  return {
    id: 'T1',
    title: 'task',
    objective: 'objective',
    files: [],
    profile: 'patcher',
    kind: 'patch_proposal',
    verification: [],
    dependsOn: [],
    riskTier: 'low',
    touchSet: [],
    ...over,
  }
}

type RunResult = CoordinatorRun['results'][number]

function mkResult(over: Partial<RunResult> = {}): RunResult {
  return {
    workOrderId: 'w',
    status: 'passed',
    summary: 's',
    findings: [],
    artifacts: [],
    changedFiles: [],
    risks: [],
    nextActions: [],
    evidenceStatus: 'verified',
    ...over,
  }
}

const singleFileChange: ChangeSet = { files: ['src/agent/x.ts'], crossModule: false, isFix: false }

test('team_orchestrate dispatches a standard plan first wave', async () => {
  let captured: DelegationRequest[] = []
  const tool = createTeamOrchestrateTool({
    delegateBatch: async (requests) => { captured = requests; return stubRun('dispatched') },
  })
  const md = [
    '### Task 1: edit foo',
    'Modify `src/agent/foo.ts`',
    '### Task 2: edit bar',
    'Modify `src/agent/bar.ts`',
  ].join('\n')
  const result = await tool.execute({
    input: { mode: 'standard', objective: 'execute the plan deliberately', planMarkdown: md },
    cwd: process.cwd(),
    toolUseId: 'tu-1',
  })
  assert.equal(result.isError, false)
  assert.equal(captured.length, 2)
  assert.match(result.content, /2 dispatched/)
  const panel = decodeTeamPanelModel(result.uiContent ?? '')
  assert.ok(panel)
  assert.equal(panel.dispatched, 2)
  assert.equal(panel.tasks.length, 2)
})

test('team_orchestrate forwards telemetry sink, reward closure sink, and session id', async () => {
  const telemetry: unknown[] = []
  const rewardClosures: unknown[] = []
  const tool = createTeamOrchestrateTool({
    delegateBatch: async () => stubRun('telemetry-dispatched'),
    recordTeamWaveTelemetry: event => { telemetry.push(event) },
    recordTeamWaveRewardClosure: event => { rewardClosures.push(event) },
    getSessionId: () => 'session-tool',
  })
  const md = [
    '### T1: edit foo',
    'Modify `src/agent/foo.ts`',
  ].join('\n')

  const result = await tool.execute({
    input: { mode: 'standard', objective: 'execute with telemetry', planMarkdown: md },
    cwd: process.cwd(),
    toolUseId: 'tu-telemetry',
  })

  assert.equal(result.isError, false)
  assert.equal(telemetry.length, 1)
  assert.equal(rewardClosures.length, 1)
  assert.equal((telemetry[0] as any).sessionId, 'session-tool')
  assert.equal((rewardClosures[0] as any).sessionId, 'session-tool')
  assert.equal((telemetry[0] as any).mode, 'standard')
  assert.equal((telemetry[0] as any).fromWave, 0)
})

test('team_orchestrate streams worker progress through onOutput', async () => {
  const progress: string[] = []
  const tool = createTeamOrchestrateTool({
    delegateBatch: async (_requests, _policy, _abortSignal, onProgress) => {
      onProgress?.(1, 2)
      onProgress?.(2, 2)
      return stubRun('progress')
    },
  })
  const md = [
    '### T1: edit foo',
    'Modify `src/agent/foo.ts`',
    '### T2: edit bar',
    'Modify `src/agent/bar.ts`',
  ].join('\n')

  const result = await tool.execute({
    input: { mode: 'standard', objective: 'execute with progress', planMarkdown: md },
    cwd: process.cwd(),
    toolUseId: 'tu-progress',
    onOutput: chunk => { progress.push(chunk) },
  })

  assert.equal(result.isError, false)
  // onOutput 现会先流式推一帧 rivet:team-panel:v1 舰队面板（TUI 解码渲染），
  // 再推进度行；进度契约只校验进度帧本身。
  const progressLines = progress.filter(c => c.includes('team progress'))
  assert.deepEqual(progressLines, [
    '✦ team progress: 1/2 workers done\n',
    '✦ team progress: 2/2 workers done\n',
  ])
  assert.ok(
    progress.some(c => c.includes('rivet:team-panel:v1')),
    '应先流式推送一帧舰队面板',
  )
})

test('team_orchestrate blocks a planPath outside the project', async () => {
  const tool = createTeamOrchestrateTool({
    delegateBatch: async () => stubRun(),
  })
  const result = await tool.execute({
    input: { mode: 'standard', objective: 'x', planPath: '/etc/passwd' },
    cwd: process.cwd(),
    toolUseId: 'tu-2',
  })
  assert.equal(result.isError, true)
  assert.match(result.content, /outside project|blocked/i)
})

test('team_orchestrate passes fromWave through and reports the next wave value', async () => {
  let captured: DelegationRequest[] = []
  const tool = createTeamOrchestrateTool({
    delegateBatch: async (requests) => { captured = requests; return stubRun('wave2') },
  })
  const md = [
    '### T1: edit first',
    'Modify `src/agent/foo.ts`',
    '### T2: edit second',
    'Modify `src/agent/foo.ts`',
    '### T3: edit third',
    'Modify `src/agent/foo.ts`',
  ].join('\n')

  const result = await tool.execute({
    input: { mode: 'standard', objective: 'continue', planMarkdown: md, fromWave: 1 },
    cwd: process.cwd(),
    toolUseId: 'tu-3',
  })

  assert.equal(result.isError, false)
  assert.ok(captured.some(r => r.parentTurnId.includes('T2')))
  assert.ok(!captured.some(r => r.parentTurnId.includes('T1')))
  assert.match(result.content, /fromWave: 2/)
})

test('team_orchestrate runs the review gate on a cross-module final wave', async () => {
  let squadronInvoked = false
  const rewardClosures: unknown[] = []
  const tool = createTeamOrchestrateTool({
    delegate: async () => ({
      status: 'completed',
      packet: 'verified',
      results: [{
        workOrderId: 'verifier',
        status: 'passed',
        summary: 'verified',
        findings: [],
        artifacts: [],
        changedFiles: [],
        risks: [],
        nextActions: [],
        evidenceStatus: 'verified',
      }],
    }),
    recordTeamWaveRewardClosure: event => { rewardClosures.push(event) },
    delegateBatch: async (requests) => {
      if (requests.every(r => r.kind === 'review')) {
        squadronInvoked = true
        return { status: 'completed', results: [], packet: 'reviewed' }
      }
      return {
        status: 'completed',
        packet: 'executed',
        results: [{
          workOrderId: 'w',
          status: 'passed',
          summary: 's',
          findings: [],
          artifacts: [],
          changedFiles: ['src/agent/a.ts', 'src/tui/b.ts', 'src/tools/c.ts', 'src/api/d.ts'],
          risks: [],
          nextActions: [],
          evidenceStatus: 'verified',
        }],
      }
    },
  })
  const md = '### T1: change\n修改 `src/agent/a.ts`'
  const result = await tool.execute({
    input: { mode: 'standard', objective: 'feature work', planMarkdown: md, fromWave: 0 },
    cwd: process.cwd(),
    toolUseId: 'tu-rev',
  })

  assert.equal(result.isError, false)
  assert.match(result.content, /Review gate/)
  assert.equal(squadronInvoked, true)
  assert.equal(rewardClosures.length, 1)
  assert.equal((rewardClosures[0] as any).outcome.reviewVerdict, 'verified')
})

// ── Perspective-density review gate helpers (unit) ──────────────────────────

test('teamReviewForceLevel: max mode always forces L3 squadron', () => {
  assert.equal(teamReviewForceLevel('max', singleFileChange, []), 'L3')
  assert.equal(teamReviewForceLevel('max', singleFileChange, [mkTask()]), 'L3')
})

test('teamReviewForceLevel: standard single-module change raises floor to L2 (no silent L1)', () => {
  assert.equal(teamReviewForceLevel('standard', singleFileChange, [mkTask()]), 'L2')
})

test('teamReviewForceLevel: standard upgrades to L3 on structural signals', () => {
  // cross-module
  assert.equal(
    teamReviewForceLevel('standard', { files: ['src/a/x.ts', 'src/b/y.ts'], crossModule: true, isFix: false }, [mkTask()]),
    'L3',
  )
  // >=3 tasks in the wave
  assert.equal(
    teamReviewForceLevel('standard', singleFileChange, [mkTask({ id: 'a' }), mkTask({ id: 'b' }), mkTask({ id: 'c' })]),
    'L3',
  )
  // any high-risk task
  assert.equal(
    teamReviewForceLevel('standard', singleFileChange, [mkTask({ riskTier: 'high' })]),
    'L3',
  )
})

test('teamReviewChangedFiles: derives authoritative files from diff artifact, union with self-report', () => {
  // self-report empty but diff artifact carries the real file → still detected
  const fromDiffOnly = teamReviewChangedFiles({
    status: 'completed',
    packet: 'p',
    results: [mkResult({
      changedFiles: [],
      artifacts: [{ kind: 'diff', title: 'Patch', content: '--- a/src/agent/x.ts\n+++ b/src/agent/x.ts\n@@\n+x' }],
    })],
  })
  assert.deepEqual(fromDiffOnly, ['src/agent/x.ts'])

  // union of self-report + diff
  const union = teamReviewChangedFiles({
    status: 'completed',
    packet: 'p',
    results: [mkResult({
      changedFiles: ['src/agent/y.ts'],
      artifacts: [{ kind: 'diff', title: 'Patch', content: '+++ b/src/agent/x.ts' }],
    })],
  })
  assert.deepEqual([...union].sort(), ['src/agent/x.ts', 'src/agent/y.ts'])

  assert.deepEqual(teamReviewChangedFiles(undefined), [])
})

test('teamReviewFocusHint: builds a hint from planned verification, undefined when none', () => {
  const hint = teamReviewFocusHint([mkTask({ verification: ['npm test', 'tsc --noEmit'] })])
  assert.ok(hint)
  assert.match(hint!, /Planned acceptance gates/)
  assert.match(hint!, /npm test/)
  assert.equal(teamReviewFocusHint([mkTask()]), undefined)
})

// ── Perspective-density review gate (integration, standard mode) ────────────

test('team_orchestrate review gate fires on honest diff even when worker self-reports no changedFiles', async () => {
  let verifierObjective = ''
  let verifyKind = ''
  const tool = createTeamOrchestrateTool({
    delegate: async (request) => {
      verifierObjective = request.objective
      verifyKind = request.kind
      return {
        status: 'completed',
        packet: 'verified',
        results: [mkResult({ workOrderId: 'verifier', summary: 'ran: npm test → pass', evidenceStatus: 'verified' })],
      }
    },
    delegateBatch: async () => ({
      status: 'completed',
      packet: 'executed',
      results: [mkResult({
        // self-report empty, but the diff artifact carries the real edit
        changedFiles: [],
        artifacts: [{ kind: 'diff', title: 'Patch', content: 'diff --git a/src/agent/x.ts b/src/agent/x.ts\n--- a/src/agent/x.ts\n+++ b/src/agent/x.ts\n@@\n+x' }],
        evidenceStatus: 'verified',
      })],
    }),
  })
  const md = '### T1: tweak helper\n修改 `src/agent/x.ts`，运行 `npm test` 验证'
  const result = await tool.execute({
    input: { mode: 'standard', objective: 'small single-module tweak', planMarkdown: md, fromWave: 0 },
    cwd: process.cwd(),
    toolUseId: 'tu-honest',
  })

  assert.equal(result.isError, false)
  // L2 floor (single-module, non-structural) — review still runs, not skipped.
  assert.match(result.content, /Review gate \[L2\]/)
  assert.equal(verifyKind, 'verify')
  // Planned verification reaches the reviewer as a focus hint.
  assert.match(verifierObjective, /Planned acceptance gates/)
  assert.match(verifierObjective, /npm test/)
})

// ── formatTeamSummary: council merge ledger + whole-wave failure guard ──────

function mkSummary(over: Partial<TeamRunSummary> = {}): TeamRunSummary {
  return {
    mode: 'max',
    planned: [],
    tasks: [],
    waves: [
      { id: 'w0', risk: 'low', taskIds: ['T1'], reason: 'first', parallelLimit: 1 },
      { id: 'w1', risk: 'low', taskIds: ['T2'], reason: 'second', parallelLimit: 1 },
    ],
    dispatched: 1,
    blocked: [],
    packet: 'pkt',
    ...over,
  }
}

test('formatTeamSummary renders the council merge ledger when present', () => {
  const out = formatTeamSummary(mkSummary({
    planMerge: {
      conflicts: [{ description: 'Dependency conflict on T1', tianquan: 'a', tianfu: 'b' }],
      risks: [{ taskId: 'T1', severity: 'high', claim: 'race', mitigation: 'lock' }],
      deferred: [{ source: 'tianxuan', title: 'Alt approach', reason: 'simpler' }],
      rejected: [],
    },
  }), 0)

  assert.match(out, /Plan conflicts/)
  assert.match(out, /Dependency conflict on T1/)
  assert.match(out, /Risk ledger/)
  assert.match(out, /\[high\] T1: race/)
  assert.match(out, /Deferred alternatives/)
  assert.match(out, /Alt approach — simpler/)
})

test('formatTeamSummary omits the merge ledger on cache-hit waves (planMerge absent)', () => {
  const out = formatTeamSummary(mkSummary({ planCacheHit: true }), 0)
  assert.doesNotMatch(out, /Plan conflicts/)
  assert.doesNotMatch(out, /Risk ledger/)
})

test('formatTeamSummary warns instead of advancing when the whole wave failed', () => {
  const run: CoordinatorRun = {
    status: 'completed',
    packet: 'p',
    results: [mkResult({ status: 'failed' }), mkResult({ status: 'blocked' })],
  }
  const out = formatTeamSummary(mkSummary({ run }), 0)

  assert.match(out, /all 2 workers failed/)
  assert.match(out, /do NOT dispatch fromWave 1/)
  assert.doesNotMatch(out, /call team_orchestrate again with fromWave/)
})

test('formatTeamSummary keeps the normal next-wave hint when a worker passed', () => {
  const run: CoordinatorRun = {
    status: 'completed',
    packet: 'p',
    results: [mkResult({ status: 'failed' }), mkResult({ status: 'passed' })],
  }
  const out = formatTeamSummary(mkSummary({ run }), 0)

  assert.match(out, /call team_orchestrate again with fromWave: 1/)
  assert.doesNotMatch(out, /workers failed/)
})

test('formatTeamSummary does not warn on the onPlanReady pre-render (run absent)', () => {
  const out = formatTeamSummary(mkSummary(), 0)
  assert.match(out, /call team_orchestrate again with fromWave: 1/)
  assert.doesNotMatch(out, /workers failed/)
})

// ── Scope-health wiring (advisory) ─────────────────────────────────────────

test('team_orchestrate surfaces scope leak and folds leaked files into review focus', async () => {
  let verifierObjective = ''
  const persisted: Array<{ kind: string; json: string }> = []
  const tool = createTeamOrchestrateTool({
    delegate: async request => {
      verifierObjective = request.objective
      return {
        status: 'completed',
        packet: 'verified',
        results: [mkResult({ workOrderId: 'verifier', evidenceStatus: 'verified' })],
      }
    },
    delegateBatch: async () => ({
      status: 'completed',
      packet: 'executed',
      results: [mkResult({
        // worker touched a file OUTSIDE the planned scope (src/agent/x.ts)
        changedFiles: [],
        artifacts: [{ kind: 'diff', title: 'Patch', content: 'diff --git a/src/agent/leak.ts b/src/agent/leak.ts\n--- a/src/agent/leak.ts\n+++ b/src/agent/leak.ts\n@@\n+x' }],
        evidenceStatus: 'verified',
      })],
    }),
    getTeamSchedulerRewardStore: () => ({
      saveBanditState: (kind, json) => { persisted.push({ kind, json }) },
    }),
  })
  const md = '### T1: tweak helper\n修改 `src/agent/x.ts`'
  const result = await tool.execute({
    input: { mode: 'standard', objective: 'small single-module tweak', planMarkdown: md, fromWave: 0 },
    cwd: process.cwd(),
    toolUseId: 'tu-leak',
  })

  assert.equal(result.isError, false)
  assert.match(result.content, /Scope health \[(medium|high)\]/)
  assert.match(result.content, /src\/agent\/leak\.ts/)
  // leaked file reaches the reviewer focus.
  assert.match(verifierObjective, /Scope leak/)
  assert.match(verifierObjective, /src\/agent\/leak\.ts/)
  // scope-health is persisted to the reward store.
  assert.ok(persisted.some(p => p.kind.startsWith('team_scope_health:')))
})

test('team_orchestrate emits no scope-health noise when changes stay in plan; survives missing store', async () => {
  const tool = createTeamOrchestrateTool({
    delegate: async () => ({
      status: 'completed',
      packet: 'verified',
      results: [mkResult({ workOrderId: 'verifier', evidenceStatus: 'verified' })],
    }),
    delegateBatch: async () => ({
      status: 'completed',
      packet: 'executed',
      results: [mkResult({
        changedFiles: [],
        artifacts: [{ kind: 'diff', title: 'Patch', content: 'diff --git a/src/agent/x.ts b/src/agent/x.ts\n--- a/src/agent/x.ts\n+++ b/src/agent/x.ts\n@@\n+x' }],
        evidenceStatus: 'verified',
      })],
    }),
    // no getTeamSchedulerRewardStore → persist must no-op without throwing
  })
  const md = '### T1: tweak helper\n修改 `src/agent/x.ts`'
  const result = await tool.execute({
    input: { mode: 'standard', objective: 'small single-module tweak', planMarkdown: md, fromWave: 0 },
    cwd: process.cwd(),
    toolUseId: 'tu-clean',
  })

  assert.equal(result.isError, false)
  assert.doesNotMatch(result.content, /Scope health/)
})

// ── Meridian blast-radius wiring (advisory) ────────────────────────────────

const NON_EMPTY_IMPACT = {
  direct: ['src/consumer.ts'],
  transitive: ['src/api/h.ts'],
  tests: ['src/__tests__/consumer.test.ts'],
  totalImpact: 2,
}

function impactTool(over: {
  impact?: () => typeof NON_EMPTY_IMPACT
  getMeridianIndexer?: () => { impact: () => typeof NON_EMPTY_IMPACT } | null
  getTypecheckRunner?: () => import('../../agent/typecheck-gate.js').TypecheckRunner | undefined
  capture?: (objective: string) => void
} = {}) {
  return createTeamOrchestrateTool({
    delegate: async request => {
      over.capture?.(request.objective)
      return {
        status: 'completed',
        packet: 'verified',
        results: [mkResult({ workOrderId: 'verifier', evidenceStatus: 'verified' })],
      }
    },
    delegateBatch: async () => ({
      status: 'completed',
      packet: 'executed',
      results: [mkResult({
        // diff targets the planned file → no scope leak; drives observedChangedFiles
        changedFiles: [],
        artifacts: [{ kind: 'diff', title: 'Patch', content: 'diff --git a/src/agent/x.ts b/src/agent/x.ts\n--- a/src/agent/x.ts\n+++ b/src/agent/x.ts\n@@\n+x' }],
        evidenceStatus: 'verified',
      })],
    }),
    ...(over.getMeridianIndexer !== undefined
      ? { getMeridianIndexer: over.getMeridianIndexer }
      : { getMeridianIndexer: () => ({ impact: over.impact ?? (() => NON_EMPTY_IMPACT) }) }),
    ...(over.getTypecheckRunner ? { getTypecheckRunner: over.getTypecheckRunner } : {}),
  })
}

const impactPlan = '### T1: tweak helper\n修改 `src/agent/x.ts`'

test('team_orchestrate injects meridian blast radius into review focus and content', async () => {
  let verifierObjective = ''
  const tool = impactTool({ capture: o => { verifierObjective = o } })
  const result = await tool.execute({
    input: { mode: 'standard', objective: 'small single-module tweak', planMarkdown: impactPlan, fromWave: 0 },
    cwd: process.cwd(),
    toolUseId: 'tu-impact',
  })

  assert.equal(result.isError, false)
  // Reaches the reviewer focus.
  assert.match(verifierObjective, /Blast radius/)
  assert.match(verifierObjective, /src\/consumer\.ts/)
  assert.match(verifierObjective, /src\/__tests__\/consumer\.test\.ts/)
  // And the returned content.
  assert.match(result.content, /Blast radius \[meridian\]/)
})

test('team_orchestrate emits no blast-radius noise when impact is empty', async () => {
  let verifierObjective = ''
  const tool = impactTool({
    capture: o => { verifierObjective = o },
    impact: () => ({ direct: [], transitive: [], tests: [], totalImpact: 0 }),
  })
  const result = await tool.execute({
    input: { mode: 'standard', objective: 'small single-module tweak', planMarkdown: impactPlan, fromWave: 0 },
    cwd: process.cwd(),
    toolUseId: 'tu-impact-empty',
  })

  assert.equal(result.isError, false)
  assert.doesNotMatch(verifierObjective, /Blast radius/)
  assert.doesNotMatch(result.content, /Blast radius/)
})

test('team_orchestrate review survives a null/missing meridian indexer', async () => {
  const tool = impactTool({ getMeridianIndexer: () => null })
  const result = await tool.execute({
    input: { mode: 'standard', objective: 'small single-module tweak', planMarkdown: impactPlan, fromWave: 0 },
    cwd: process.cwd(),
    toolUseId: 'tu-impact-none',
  })

  assert.equal(result.isError, false)
  assert.match(result.content, /Review gate \[L2\]/)
  assert.doesNotMatch(result.content, /Blast radius/)
})

test('team_orchestrate injects typecheck breakage into review content, ahead of blast radius', async () => {
  const brokenRunner: import('../../agent/typecheck-gate.js').TypecheckRunner = () => ({
    diagnostics: [{ file: 'src/agent/x.ts', line: 7, col: 1, severity: 'error', message: 'TS2300: duplicate identifier' }],
    formatted: '',
    ranOk: true,
  })
  const tool = impactTool({ getTypecheckRunner: () => brokenRunner })
  const result = await tool.execute({
    input: { mode: 'standard', objective: 'small single-module tweak', planMarkdown: impactPlan, fromWave: 0 },
    cwd: process.cwd(),
    toolUseId: 'tu-tc-broken',
  })

  assert.equal(result.isError, false)
  assert.match(result.content, /Typecheck broken \[tsc\]/)
  assert.match(result.content, /src\/agent\/x\.ts/)
  // Typecheck note precedes the meridian blast-radius note in the content.
  assert.ok(
    result.content.indexOf('Typecheck broken [tsc]') < result.content.indexOf('Blast radius [meridian]'),
    result.content,
  )
})

test('team_orchestrate emits no typecheck noise when the runner is clean', async () => {
  const cleanRunner: import('../../agent/typecheck-gate.js').TypecheckRunner = () => ({ diagnostics: [], formatted: '', ranOk: true })
  const tool = impactTool({ getTypecheckRunner: () => cleanRunner })
  const result = await tool.execute({
    input: { mode: 'standard', objective: 'small single-module tweak', planMarkdown: impactPlan, fromWave: 0 },
    cwd: process.cwd(),
    toolUseId: 'tu-tc-clean',
  })
  assert.equal(result.isError, false)
  assert.doesNotMatch(result.content, /Typecheck broken/)
})

test('team_orchestrate review survives a throwing typecheck runner', async () => {
  const throwingRunner: import('../../agent/typecheck-gate.js').TypecheckRunner = () => { throw new Error('tsc boom') }
  const tool = impactTool({ getTypecheckRunner: () => throwingRunner })
  const result = await tool.execute({
    input: { mode: 'standard', objective: 'small single-module tweak', planMarkdown: impactPlan, fromWave: 0 },
    cwd: process.cwd(),
    toolUseId: 'tu-tc-throw',
  })
  assert.equal(result.isError, false)
  assert.doesNotMatch(result.content, /Typecheck broken/)
})

test('team_orchestrate review survives a throwing impact analyzer', async () => {
  const tool = createTeamOrchestrateTool({
    delegate: async () => ({
      status: 'completed',
      packet: 'verified',
      results: [mkResult({ workOrderId: 'verifier', evidenceStatus: 'verified' })],
    }),
    delegateBatch: async () => ({
      status: 'completed',
      packet: 'executed',
      results: [mkResult({
        changedFiles: [],
        artifacts: [{ kind: 'diff', title: 'Patch', content: 'diff --git a/src/agent/x.ts b/src/agent/x.ts\n--- a/src/agent/x.ts\n+++ b/src/agent/x.ts\n@@\n+x' }],
        evidenceStatus: 'verified',
      })],
    }),
    getMeridianIndexer: () => ({ impact: () => { throw new Error('boom') } }),
  })
  const result = await tool.execute({
    input: { mode: 'standard', objective: 'small single-module tweak', planMarkdown: impactPlan, fromWave: 0 },
    cwd: process.cwd(),
    toolUseId: 'tu-impact-throw',
  })

  assert.equal(result.isError, false)
  assert.match(result.content, /Review gate \[L2\]/)
  assert.doesNotMatch(result.content, /Blast radius/)
})
