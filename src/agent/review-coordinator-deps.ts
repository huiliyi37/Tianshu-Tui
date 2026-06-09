import type { CoordinatorRun, DelegationRequest } from './coordinator.js'
import { formatObjectiveReviewStance, formatPathBoundaryReviewStance, type ChangeSet } from './review-discipline.js'
import type { PatcherResult, ReviewFinding, ReviewRouterDeps, SquadronResult, VerifierResult } from './review-router.js'
import type { AggregationPolicy, WorkerProfile, WorkerResult, WorkOrderKind } from './work-order.js'

type WorkerFinding = WorkerResult['findings'][number]

export interface ReviewCoordinator {
  delegate(request: DelegationRequest, abortSignal?: AbortSignal): Promise<CoordinatorRun>
  delegateBatch?(
    requests: DelegationRequest[],
    policy?: AggregationPolicy,
    abortSignal?: AbortSignal,
    onProgress?: (completed: number, total: number) => void,
  ): Promise<CoordinatorRun>
}

export interface CoordinatorReviewDepsOptions {
  /** Stable parent id for generated work orders; defaults to deliver_task. */
  parentTurnId?: string
  /** Parent review depth. Child review workers receive parent+1 as request metadata and in their objective. */
  reviewDepth?: number
  /** Optional parent abort signal propagated to coordinator calls. */
  abortSignal?: AbortSignal
}

const REVIEW_PARENT_TURN_ID = 'deliver_task:review-router'

function files(change: ChangeSet): string[] {
  return [...change.files]
}

function objectiveReviewStanceBlock(): string {
  return [
    'Objective review stance (internalized from external Claude Code Opus audits; do not depend on external assistance being present):',
    formatObjectiveReviewStance(),
  ].join('\n')
}

function dataflowVerifierBlock(): string {
  return [
    'Dataflow verifier stance for complex specs (P4-c lesson):',
    '1. Do not treat spec clauses as a flat checklist; reconstruct the fact-flow graph from spec fields/constraints to producers, intermediate structures, consumers/write targets, and assertions.',
    '2. Check condition matrices for combined gates such as source × severity × apply; nested constraints must not be flattened into independent ifs.',
    '3. Demand counterexample coverage: which existing or new test would fail if the implementation only handled the happy path, forgot a call contract, declared a type without consuming it, or used truthy/falsy sentinels such as !waveId.',
    '4. A green test suite is not enough unless it can make the wrong/first-pass implementation red on the relevant spec path.',
  ].join('\n')
}

function pathBoundaryReviewBlock(): string {
  return [
    'Path boundary / attention-gate review stance (T7/MeridianIndexer lesson; always apply for path, classifier, discovery, indexer, watcher, git-status, ownership-adjacent changes):',
    formatPathBoundaryReviewStance(),
  ].join('\n')
}

function childReviewDepth(options: CoordinatorReviewDepsOptions): number {
  return (options.reviewDepth ?? 0) + 1
}

function scope(change: ChangeSet): DelegationRequest['scope'] {
  return { files: files(change) }
}

function request(input: {
  change: ChangeSet
  options: CoordinatorReviewDepsOptions
  objective: string
  kind: WorkOrderKind
  profile: WorkerProfile
}): DelegationRequest {
  const reviewDepth = childReviewDepth(input.options)
  return {
    parentTurnId: input.options.parentTurnId ?? REVIEW_PARENT_TURN_ID,
    objective: [
      input.objective,
      '',
      `Review depth: ${reviewDepth}. Do not call deliver_task from review workers; report verdict/evidence only.`,
    ].join('\n'),
    kind: input.kind,
    profile: input.profile,
    scope: scope(input.change),
    reviewDepth,
  }
}

function verificationEvidence(result: WorkerResult): string | undefined {
  if (!result.verification) return undefined
  const v = result.verification
  return `ran: ${v.command} → ${v.status} (${v.passed} passed, ${v.failed} failed, ${v.skipped} skipped)`
}

function formatFinding(finding: WorkerFinding): string {
  return `${finding.claim} — ${finding.evidence}`
}

function summarizeResult(result: WorkerResult): string {
  const parts = [
    verificationEvidence(result),
    result.summary,
    ...result.findings.slice(0, 3).map(formatFinding),
    ...result.risks.slice(0, 3).map(risk => `risk: ${risk}`),
  ].filter((part): part is string => Boolean(part && part.trim().length > 0))
  return parts.join('\n')
}

function summarizeRun(run: CoordinatorRun): string {
  if (run.status === 'skipped') return 'review worker skipped: objective did not pass delegation budget gate'
  const summaries = run.results.map(summarizeResult).filter(Boolean)
  return summaries.length > 0 ? summaries.join('\n---\n') : 'review worker returned no evidence'
}

function extractSeverity(text: string): ReviewFinding['severity'] {
  if (/\bCRITICAL\b|\bC\d+\b/i.test(text)) return 'CRITICAL'
  if (/\bHIGH\b|\bH\d+\b/i.test(text)) return 'HIGH'
  if (/\bMEDIUM\b|\bM\d+\b/i.test(text)) return 'MEDIUM'
  if (/\bLOW\b|\bL\d+\b/i.test(text)) return 'LOW'
  return undefined
}

function mapWorkerFinding(result: WorkerResult, finding: WorkerFinding): ReviewFinding {
  const text = `${finding.claim}\n${finding.evidence}\n${result.summary}`
  return {
    severity: extractSeverity(text),
    claim: finding.claim,
  }
}

function mapSquadronFindings(run: CoordinatorRun): ReviewFinding[] {
  if (run.status === 'skipped') {
    return [{ severity: 'HIGH', claim: 'Review Squadron skipped before producing findings' }]
  }

  const findings: ReviewFinding[] = []
  for (const result of run.results) {
    for (const finding of result.findings) {
      findings.push(mapWorkerFinding(result, finding))
    }
    if (result.status !== 'passed') {
      findings.push({ severity: 'HIGH', claim: result.summary })
    }
  }
  return findings
}

function verifierResult(run: CoordinatorRun): VerifierResult {
  const verified = run.status === 'completed'
    && run.results.some(result => result.status === 'passed' && result.evidenceStatus === 'verified')
  return {
    verdict: verified ? 'verified' : 'rejected',
    evidence: summarizeRun(run),
  }
}

function patcherResult(run: CoordinatorRun): PatcherResult {
  const patched = run.status === 'completed'
    && run.results.some(result => result.status === 'passed' && (result.changedFiles.length > 0 || Boolean(result.patchSummary)))
  return { patched }
}

function verifierObjective(change: ChangeSet): string {
  return [
    'Independently adversarially verify this change before delivery.',
    objectiveReviewStanceBlock(),
    dataflowVerifierBlock(),
    pathBoundaryReviewBlock(),
    `Files: ${files(change).join(', ') || '(none)'}`,
    'Run targeted existing tests when possible and return command + observed output evidence.',
    'Do not stop at green tests: try at least one counterexample or boundary/error-path probe relevant to the changed files.',
    'For spec/integration changes, explicitly report fact-flow closure, condition-matrix coverage, and the counterexample that would fail a checklist-only implementation.',
    'Return JSON WorkerResult with evidenceStatus="verified" only when the verification actually ran, passed, and no counterexample was found.',
  ].join('\n')
}

function patcherObjective(change: ChangeSet, verifier: VerifierResult): string {
  return [
    'Patch the change rejected by the adversarial verifier, in an isolated worker worktree.',
    'Fix the root cause shown by the verifier; do not weaken tests or merely silence the symptom.',
    `Files: ${files(change).join(', ') || '(none)'}`,
    `Verifier verdict: ${verifier.verdict}`,
    `Verifier evidence: ${verifier.evidence}`,
    'Return JSON WorkerResult with changedFiles and patchSummary if a patch was applied.',
  ].join('\n')
}

const INSPECTORS: Array<{ name: string; objective: string }> = [
  { name: 'Security', objective: 'Review authentication, authorization, path validation, secret exposure, and fail-open/fail-closed behavior.' },
  { name: 'Lifecycle', objective: 'Review state transitions, async races, cancellation, timeout propagation, and load-check-save atomicity.' },
  { name: 'Data Flow', objective: 'Review parameter propagation, allowlist/tool scope propagation, persistence paths, and data loss risks.' },
  { name: 'Silence', objective: 'Review swallowed errors, empty catch blocks, missing diagnostics, and false green verification claims.' },
]

function squadronRequests(change: ChangeSet, options: CoordinatorReviewDepsOptions): DelegationRequest[] {
  return INSPECTORS.map(inspector => request({
    change,
    options,
    kind: 'review',
    profile: 'reviewer',
    objective: [
      `${inspector.name} Inspector: ${inspector.objective}`,
      objectiveReviewStanceBlock(),
      dataflowVerifierBlock(),
      pathBoundaryReviewBlock(),
      `Files: ${files(change).join(', ') || '(none)'}`,
      'For spec/integration changes, review the fact-flow graph, condition matrix, and counterexample tests before accepting checklist-style coverage.',
      'Report each finding with severity CRITICAL/HIGH/MEDIUM/LOW, claim, evidence, and minimal fix suggestion.',
    ].join('\n'),
  }))
}

export function createCoordinatorReviewDeps(
  coordinator: ReviewCoordinator,
  options: CoordinatorReviewDepsOptions = {},
): ReviewRouterDeps {
  return {
    spawnVerifier: async (change) => {
      const run = await coordinator.delegate(request({
        change,
        options,
        kind: 'verify',
        profile: 'adversarial_verifier',
        objective: verifierObjective(change),
      }), options.abortSignal)
      return verifierResult(run)
    },

    spawnPatcher: async (change, verifier) => {
      const run = await coordinator.delegate(request({
        change,
        options,
        kind: 'patch_proposal',
        profile: 'patcher',
        objective: patcherObjective(change, verifier),
      }), options.abortSignal)
      return patcherResult(run)
    },

    spawnSquadron: async (change): Promise<SquadronResult> => {
      const requests = squadronRequests(change, options)
      const run = coordinator.delegateBatch
        ? await coordinator.delegateBatch(requests, 'all_required', options.abortSignal)
        : await runSquadronSerially(coordinator, requests, options.abortSignal)
      return { findings: mapSquadronFindings(run) }
    },
  }
}

async function runSquadronSerially(
  coordinator: ReviewCoordinator,
  requests: DelegationRequest[],
  abortSignal?: AbortSignal,
): Promise<CoordinatorRun> {
  const results: CoordinatorRun['results'] = []
  for (const req of requests) {
    const run = await coordinator.delegate(req, abortSignal)
    results.push(...run.results)
  }
  return {
    status: 'completed',
    results,
    packet: results.map(result => result.summary).join('\n'),
    aggregationPolicy: 'all_required',
  }
}
