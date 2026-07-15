import type { WorkOrder, WorkerResult } from './work-order.js'
import { evaluateWaveGate, type EvaluateWaveGateInput, type WaveGateCheck } from './wave-gate.js'

/**
 * W4-D1: main-side verification gate for worker WRITE output.
 *
 * Workers self-report `verification` metadata and the forensic audit
 * (worker-evidence.ts) checks the transcript for proof — but nothing on the
 * main side actually RE-RUNS verification against the worker's tree. This
 * module closes that gap by reusing the existing wave-gate machinery
 * (memoized scoped typecheck + whitelisted verify commands) — no parallel
 * runner is created.
 *
 * Condition matrix (from the plan):
 *   - read-only worker (no changedFiles)      → skipped, no code gate
 *   - gate passed                             → result flows to primary review
 *   - gate failed                             → ONE bounded repair by the SAME
 *                                               worker; second failure → 'failed'
 *                                               back to primary adjudication
 *   - gate blocked (env: tsc timeout etc.)    → back to primary, environment-
 *                                               neutral — no repair, no model
 *                                               capability penalty
 *   - declared `exit 0 + 0 passed`            → false-green: invalid
 *                                               verification, never 'passed'
 *   - worker claimed passed, main gate failed → falseGreen recorded
 *
 * Never switches models and never re-dispatches to a different worker —
 * repair reuses the same runAgent closure (same profile, same model).
 */

export type WorkerWriteGateOutcome = 'passed' | 'failed' | 'blocked' | 'skipped'

export interface WorkerWriteGateReport {
  outcome: WorkerWriteGateOutcome
  checks: WaveGateCheck[]
  /** Human-readable failure/blocked evidence lines (repair prompt + risks). */
  evidence: string[]
  /** Worker declared passed verification but the main gate failed. */
  falseGreen: boolean
  /** Worker declared verification was invalid (exit 0 with 0 tests run). */
  declaredFalseGreen: boolean
}

/** Kill switch: RIVET_WORKER_WRITE_GATE=0 disables the main-side worker gate. */
export function workerWriteGateEnabled(): boolean {
  return process.env.RIVET_WORKER_WRITE_GATE !== '0'
}

/**
 * `exit 0 + 0 passed` must not count as a passing verification — a test
 * command that matched zero tests proves nothing (false-green risk).
 */
export function isDeclaredVerificationFalseGreen(result: WorkerResult): boolean {
  const v = result.verification
  if (!v) return false
  return v.status === 'passed' && v.exitCode === 0 && v.passed === 0
}

export interface EvaluateWorkerWriteGateInput {
  /** The worker's tree (isolated worktree or shared cwd). */
  cwd: string
  result: WorkerResult
  /** Test hooks forwarded to evaluateWaveGate (typecheckRunner/runCommand/fileExists). */
  gateHooks?: Pick<EvaluateWaveGateInput, 'typecheckRunner' | 'runCommand' | 'fileExists'>
  /** Injectable evaluator (tests). Defaults to the real wave-gate. */
  evaluate?: (input: EvaluateWaveGateInput) => Promise<{ passed: boolean; checks: WaveGateCheck[] }>
}

export async function evaluateWorkerWriteGate(input: EvaluateWorkerWriteGateInput): Promise<WorkerWriteGateReport> {
  const { result } = input
  // Read-only workers never run the code gate.
  if (result.changedFiles.length === 0) {
    return { outcome: 'skipped', checks: [], evidence: [], falseGreen: false, declaredFalseGreen: false }
  }

  const declaredFalseGreen = isDeclaredVerificationFalseGreen(result)
  const declaredCommand = result.verification?.command?.trim()
  const evaluate = input.evaluate ?? evaluateWaveGate

  const record = await evaluate({
    cwd: input.cwd,
    wave: -1, // not a plan wave — worker write gate
    changedFiles: result.changedFiles,
    commands: declaredCommand ? [declaredCommand] : [],
    ...input.gateHooks,
  })

  const failedChecks = record.checks.filter(c => c.status === 'failed')
  const blockedChecks = record.checks.filter(c => c.status === 'unverifiable' && c.blocking === true)

  const evidence: string[] = []
  for (const c of [...failedChecks, ...blockedChecks]) {
    evidence.push(`${c.status === 'failed' ? '❌' : '❓'} ${c.command}${c.detail ? ` — ${c.detail}` : ''}`)
  }
  if (declaredFalseGreen) {
    evidence.push('⚠ declared verification is false-green: exit 0 with 0 tests executed proves nothing')
  }

  // Failed checks dominate blocked ones: a real failure is actionable by the
  // worker, while blocked alone (tsc timeout / env) is environment-neutral.
  let outcome: WorkerWriteGateOutcome
  if (failedChecks.length > 0) outcome = 'failed'
  else if (blockedChecks.length > 0) outcome = 'blocked'
  else if (declaredFalseGreen) outcome = 'failed' // invalid verification cannot pass the gate
  else outcome = 'passed'

  const workerClaimedPassed = result.verification?.status === 'passed' || result.evidenceStatus === 'verified'

  return {
    outcome,
    checks: record.checks,
    evidence,
    falseGreen: workerClaimedPassed && outcome === 'failed',
    declaredFalseGreen,
  }
}

/** Bounded-repair prompt: same worker, failure evidence attached, one round. */
export function buildWorkerVerifyRepairPrompt(order: WorkOrder, report: WorkerWriteGateReport): string {
  return [
    `Your previous write output for work order ${order.id} FAILED the primary verification gate.`,
    '',
    'Gate evidence:',
    ...report.evidence.map(line => `  ${line}`),
    '',
    'This is your ONE bounded repair round. Requirements:',
    '- Fix the failing checks in the SAME working tree (your changes are still present).',
    '- Re-run the verification command after fixing and include real counts in `verification`.',
    '- A verification that executes 0 tests with exit 0 is NOT a pass — do not report it as passed.',
    '- Output the complete WorkerResult JSON again (same schema as before), updating changedFiles.',
  ].join('\n')
}

/**
 * Fold the gate outcome back into the worker result (immutable).
 *
 * - failed  → status/evidenceStatus 'failed', evidence in risks (primary adjudicates)
 * - blocked → status/evidenceStatus 'blocked', environment-neutral risk note
 * - passed/skipped → unchanged (existing evidence audit still applies downstream)
 */
export function applyWriteGateToResult(result: WorkerResult, report: WorkerWriteGateReport, repairCount: number): WorkerResult {
  if (report.outcome === 'passed' || report.outcome === 'skipped') return result
  const evidenceLines = report.evidence.length > 0 ? report.evidence : ['(no check detail captured)']
  if (report.outcome === 'failed') {
    return {
      ...result,
      status: 'failed',
      evidenceStatus: 'failed',
      risks: [
        ...result.risks,
        `primary write gate failed after ${repairCount} bounded repair round(s): ${evidenceLines.join(' | ')}`,
        ...(report.falseGreen ? ['falseGreen: worker claimed passed but primary gate failed'] : []),
      ],
    }
  }
  return {
    ...result,
    status: 'blocked',
    evidenceStatus: 'blocked',
    risks: [
      ...result.risks,
      `primary write gate blocked (environment-neutral, no capability penalty): ${evidenceLines.join(' | ')}`,
    ],
  }
}
