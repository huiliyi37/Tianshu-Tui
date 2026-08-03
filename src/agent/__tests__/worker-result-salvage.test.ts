/**
 * Session 2c1186f5 regression — scout report protocol failure ladder.
 *
 * A LongCat scout produced a complete 10.9k-char report with ONE malformed
 * finding (the `"claim":` key name was dropped, promoting the value into the
 * property-name position → whole-object JSON.parse fails). The old
 * parseWorkerResult swallowed this into a blocked return, which bypassed the
 * caller's catch-driven repair loop — the entire report was discarded.
 *
 * The fixed ladder: repair re-ask (full fidelity) → field-level salvage
 * (degraded but usable) → empty blocked (terminal, failureReason='json_parse').
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildBlockedWorkerResult,
  createReadOnlyWorkOrder,
  parseWorkerResult,
  salvageWorkerResult,
  WorkerResultParseError,
} from '../work-order.js'
import { createSoftLandingDrain, runWorkerSession, salvageAbortedReport } from '../worker-session.js'
import { makeFaultClient } from './helpers/fault-client.js'
import { makeWorkerConfig } from './helpers/worker-fixture.js'

/** Faithful reproduction of the 天权 failure shape: a full WorkerResult with
 *  valid findings plus one finding whose `"claim":` key name is missing —
 *  `JSON.parse` of the whole object fails ("Expected ':' after property name"),
 *  while the individual finding objects still parse on their own. */
const TIANQUAN_MALFORMED_REPORT = `{
  "workOrderId": "batch:0",
  "status": "passed",
  "summary": "主控 Agent 端到端 turn 链的完整结构证据报告。",
  "findings": [
    {
      "claim": "入口链路：run() → AgentLoop 构造 → createTurnOrchestrator() → execute()",
      "evidence": "src/agent/loop.ts:89, src/agent/loop-factory.ts:637-718",
      "confidence": "high"
    },
    {
      "claim": "核心 turn 循环受 maxTurns 硬约束",
      "evidence": "src/agent/turn-orchestrator.ts:228-232",
      "confidence": "high"
    },
    {
      "action-intent 闸门是纯 deterministic 检测，不依赖模型推理} → 正则匹配",
      "evidence": "src/agent/action-intent-detector.ts:15-89",
      "confidence": "high"
    },
    {
      "claim": "工具批执行入口在 ToolExecutionController",
      "evidence": "src/agent/tool-execution.ts:120",
      "confidence": "medium"
    }
  ],
  "artifacts": [],
  "changedFiles": [],
  "risks": [],
  "nextActions": ["审查 looksDelivered 条件的完备性"],
  "evidenceStatus": "verified"
}`

const VALID_REPORT = JSON.stringify({
  workOrderId: 'wo1',
  status: 'passed',
  summary: 'repaired report',
  findings: [{ claim: 'repaired finding', evidence: 'src/a.ts:1', confidence: 'high' }],
  artifacts: [],
  changedFiles: [],
  risks: [],
  nextActions: [],
  evidenceStatus: 'verified',
})

describe('parseWorkerResult throw semantics (repair loop revival)', () => {
  it('throws WorkerResultParseError on the 天权 fixture instead of returning blocked', () => {
    assert.throws(
      () => parseWorkerResult(TIANQUAN_MALFORMED_REPORT, 'batch:0'),
      (error: unknown) => {
        assert.ok(error instanceof WorkerResultParseError, 'must be the typed parse error')
        assert.ok(error.candidateCount > 0, 'candidates were found')
        assert.ok(error.message.includes('none parseable'), 'diagnostic preserved')
        return true
      },
    )
  })

  it('still throws the generic no-JSON error when the output has no JSON at all', () => {
    assert.throws(
      () => parseWorkerResult('pure prose, no braces here', 'wo1'),
      /did not contain a JSON object/,
    )
  })

  it('still parses a valid report without throwing', () => {
    const result = parseWorkerResult(VALID_REPORT, 'wo1')
    assert.equal(result.status, 'passed')
  })
})

describe('salvageWorkerResult (field-level terminal tier)', () => {
  it('recovers the valid finding objects and the summary from the 天权 fixture', () => {
    const salvaged = salvageWorkerResult(TIANQUAN_MALFORMED_REPORT, 'batch:0')
    assert.ok(salvaged, 'salvage must succeed — 3 findings are independently parseable')
    assert.equal(salvaged.workOrderId, 'batch:0')
    // The malformed finding is NOT recoverable; the three valid ones are.
    assert.equal(salvaged.findings.length, 3)
    assert.ok(salvaged.findings.some(f => f.claim.startsWith('入口链路')))
    assert.ok(salvaged.findings.some(f => f.claim.startsWith('核心 turn 循环')))
    assert.ok(salvaged.findings.some(f => f.claim.startsWith('工具批执行入口')))
    // Degradation contract: never 'passed', evidence unverified, reason tagged.
    assert.equal(salvaged.status, 'blocked')
    assert.equal(salvaged.evidenceStatus, 'unverified')
    assert.equal(salvaged.failureReason, 'json_parse')
    assert.ok(salvaged.summary.includes('主控 Agent'), 'worker\'s own summary is carried')
    assert.ok(salvaged.risks.some(r => r.includes('parse-salvaged')))
  })

  it('deduplicates identical claims across candidates', () => {
    const text = `{
  "findings": broken [
    {"claim": "same", "evidence": "a.ts:1", "confidence": "high"},
    {"claim": "same", "evidence": "a.ts:1", "confidence": "high"}
  ]
}`
    const salvaged = salvageWorkerResult(text, 'wo1')
    assert.ok(salvaged)
    assert.equal(salvaged.findings.length, 1)
  })

  it('recovers findings from a wrapper candidate that parses but fails schema (f98bb237 regression)', () => {
    // Reproduces the tier-2 recovery path added for the f98bb237 incident.
    // A fenced ```json``` block holds a COMPLETE WorkerResult whose JSON is
    // syntactically valid, but one finding has a bad `confidence` value (not in
    // the low/medium/high enum). workerResultIngestSchema rejects the whole
    // wrapper → parseWorkerResult throws → salvageWorkerResult fires.
    //
    // Tier 1 (candidate-is-a-finding) cannot use the wrapper candidate (its top
    // level is {workOrderId,...}, not {claim,...}). Tier 2 must walk
    // parsed.findings[] and safeParse each element: the good one recovers, the
    // bad-confidence one is dropped. This is the exact salvage path that
    // upgrades a 4/6 recovery to 5/6 when a single malformed field would
    // otherwise sink the whole wrapper candidate.
    const text = '```json\n' + JSON.stringify({
      workOrderId: 'batch:0',
      status: 'passed',
      summary: 'CV3-open 调研：原计划引用失准',
      findings: [
        { claim: 'CvmVectorInput 接口定义于 L562', evidence: 'cognitive-capsule-router.ts:562-598', confidence: 'high' },
        { claim: 'bad confidence value', evidence: 'cognitive-capsule-router.ts:696', confidence: 'very-high' },
      ],
      artifacts: [],
      changedFiles: [],
      risks: [],
      nextActions: [],
      evidenceStatus: 'verified',
    }) + '\n```'

    const salvaged = salvageWorkerResult(text, 'batch:0')
    assert.ok(salvaged, 'wrapper-level recovery must fire when the wrapper parses but fails schema')
    if (!salvaged) return // narrow for TS — assert.ok above guarantees non-null
    assert.equal(salvaged.findings.length, 1, 'only the schema-valid finding survives; the bad-confidence one is dropped')
    assert.equal(salvaged.findings[0]?.claim, 'CvmVectorInput 接口定义于 L562')
    assert.equal(salvaged.failureReason, 'json_parse')
    assert.ok(salvaged.summary.includes('malformed wrapper'),
      'summary must flag that wrapper-level recovery fired (auditable in mailbox)')
  })

  it('shares seenClaims across tier 1 and tier 2 (no double counting)', () => {
    // A wrapper candidate AND a balanced candidate both surface the same finding.
    // Tier 1 picks it up from the balanced candidate; tier 2 must not re-add it.
    const sharedFinding = { claim: 'shared claim', evidence: 'a.ts:1', confidence: 'high' }
    const text = JSON.stringify({
      findings: [sharedFinding, { claim: 'extra', evidence: 'b.ts:2', confidence: 'medium' }],
    }) + '\n' + JSON.stringify(sharedFinding)
    const salvaged = salvageWorkerResult(text, 'wo1')
    assert.ok(salvaged)
    // shared claim counted once + extra = 2 distinct findings, not 3.
    assert.equal(salvaged.findings.length, 2)
    assert.equal(salvaged.findings.filter(f => f.claim === 'shared claim').length, 1)
  })

  it('returns null when nothing is salvageable', () => {
    assert.equal(salvageWorkerResult('{"broken json', 'wo1'), null)
    assert.equal(salvageWorkerResult('no json at all', 'wo1'), null)
  })
})

describe('buildBlockedWorkerResult failureReason', () => {
  const order = createReadOnlyWorkOrder({
    parentTurnId: 't1',
    kind: 'code_search',
    profile: 'code_scout',
    objective: 'trace something across the codebase for testing',
    scope: { files: ['a.ts'] },
  })

  it('carries the failureReason when provided', () => {
    assert.equal(buildBlockedWorkerResult(order, 'x', 'json_parse').failureReason, 'json_parse')
    assert.equal(buildBlockedWorkerResult(order, 'x', 'timeout').failureReason, 'timeout')
  })

  it('omits failureReason when not provided (back-compat)', () => {
    assert.equal(buildBlockedWorkerResult(order, 'x').failureReason, undefined)
  })
})

describe('createSoftLandingDrain (W2 budget soft landing)', () => {
  it('delivers the wrap-up steer exactly once after requestWrapUp', () => {
    const { drain, requestWrapUp } = createSoftLandingDrain()
    assert.equal(drain(), null, 'nothing before the soft timer fires')
    requestWrapUp()
    const first = drain()
    assert.ok(first?.includes('budget warning'), 'wrap-up delivered on first drain')
    assert.ok(first?.includes('JSON'), 'wrap-up demands the final JSON report')
    assert.equal(drain(), null, 'delivered once — subsequent drains pass through')
  })

  it('passes through to the inner (coordinator) steer queue', () => {
    const queue = ['user says hi']
    const { drain, requestWrapUp } = createSoftLandingDrain(() => queue.shift() ?? null)
    assert.equal(drain(), 'user says hi', 'inner queue drains normally')
    requestWrapUp()
    assert.ok(drain()?.includes('budget warning'), 'wrap-up takes priority when armed')
    assert.equal(drain(), null, 'back to inner queue (now empty)')
  })
})

describe('salvageAbortedReport (W2 abort salvage ladder)', () => {
  it('full report parses → degraded to unverified with abort risk note', () => {
    const salvaged = salvageAbortedReport(VALID_REPORT, 'wo1', 'timeout')
    assert.ok(salvaged)
    assert.equal(salvaged.status, 'passed', 'complete report survives the abort race')
    assert.equal(salvaged.evidenceStatus, 'unverified', 'verified must be downgraded')
    assert.equal(salvaged.failureReason, 'timeout')
    assert.ok(salvaged.risks.some(r => r.includes('budget timeout')))
  })

  it('malformed report → field-level salvage with the abort failureReason', () => {
    const salvaged = salvageAbortedReport(TIANQUAN_MALFORMED_REPORT, 'batch:0', 'caller_aborted')
    assert.ok(salvaged)
    assert.equal(salvaged.findings.length, 3)
    assert.equal(salvaged.failureReason, 'caller_aborted', 'abort source wins over json_parse tag')
  })

  it('returns null for empty or hopeless partial output', () => {
    assert.equal(salvageAbortedReport('', 'wo1', 'timeout'), null)
    assert.equal(salvageAbortedReport('   ', 'wo1', 'timeout'), null)
    assert.equal(salvageAbortedReport('exploring src/agent …', 'wo1', 'timeout'), null)
  })
})

describe('runWorkerSession repair ladder (full path)', () => {
  it('malformed report → repair re-ask fires → repaired report parses (full fidelity)', async () => {
    const client = makeFaultClient([
      { kind: 'ok', text: TIANQUAN_MALFORMED_REPORT },
      { kind: 'ok', text: VALID_REPORT },
    ])
    // 修复梯专用用例——钉旧契约（无收尾轮），否则终型轮先把报告救回、
    // repairAttempts 恒为 0。
    const run = await runWorkerSession(makeWorkerConfig({ client, finalizeReport: false }))
    assert.equal(run.result.status, 'passed', 'repair round must recover the report')
    assert.equal(run.result.summary, 'repaired report')
    assert.ok(run.transcript.repairAttempts >= 1, 'repair loop must have fired')
  })

  it('repair exhausted → salvage tier returns degraded findings instead of empty blocked', async () => {
    // Every attempt (initial + retries) returns the same malformed report.
    const client = makeFaultClient([{ kind: 'ok', text: TIANQUAN_MALFORMED_REPORT }])
    const run = await runWorkerSession(makeWorkerConfig({ client }))
    assert.equal(run.result.status, 'blocked')
    assert.equal(run.result.failureReason, 'json_parse')
    assert.equal(run.result.findings.length, 3, 'salvaged findings must survive to the caller')
    assert.equal(run.result.evidenceStatus, 'unverified')
  })

  it('budget timeout abort carries failureReason=timeout', async () => {
    const client = makeFaultClient([{ kind: 'idle_stall' }])
    const config = makeWorkerConfig({ client })
    config.order.budget.timeoutMs = 200
    const run = await runWorkerSession(config)
    assert.equal(run.result.status, 'blocked')
    assert.equal(run.result.failureReason, 'timeout')
  })

  it('parent-signal abort carries failureReason=caller_aborted', async () => {
    const controller = new AbortController()
    const client = makeFaultClient([{ kind: 'idle_stall' }])
    const p = runWorkerSession(makeWorkerConfig({ client, abortSignal: controller.signal }))
    setTimeout(() => controller.abort(), 50)
    const run = await p
    assert.equal(run.result.status, 'blocked')
    assert.equal(run.result.failureReason, 'caller_aborted')
  })
})
