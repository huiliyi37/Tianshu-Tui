import type { CoordinatorRun, DelegationRequest } from './coordinator.js'
import { formatObjectiveReviewStance, formatPathBoundaryReviewStance, formatWeighingReviewStance, formatWiringEffectivenessReviewStance, formatMethodologyVerificationStance, type ChangeSet } from './review-discipline.js'
import type { PatcherResult, ReviewFinding, ReviewInfraFailure, ReviewRouterDeps, SquadronResult, VerifierResult } from './review-router.js'
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
    '5. False-green / fixture-contract audit (虚假绿灯 — council modelUsed class): for every field a TEST mock/fixture assigns on a dependency\'s OUTPUT, verify real production code of that dependency actually produces that shape (grep the write site, not just the type decl). For every field production code renders/consumes, trace its production write site AND whether that write\'s runtime condition can ever fire (a write line guarded by `raw.x ?` where the source never carries x is still dead). A fixture fabricating a shape the real system never produces — or two sides each mocking the boundary without one contract test asserting the real producer\'s output — is a false green. Report HIGH.',
  ].join('\n')
}

function pathBoundaryReviewBlock(): string {
  return [
    'Path boundary / attention-gate review stance (T7/MeridianIndexer lesson; always apply for path, classifier, discovery, indexer, watcher, git-status, ownership-adjacent changes):',
    formatPathBoundaryReviewStance(),
  ].join('\n')
}

function weighingReviewBlock(): string {
  return [
    'Weighing review stance (天权 称量者 lesson; apply to refactors, extractions, encapsulation/scope changes — verify truth AND weigh cost):',
    formatWeighingReviewStance(),
  ].join('\n')
}

function wiringEffectivenessBlock(): string {
  return [
    'Wiring & effectiveness review stance (2026-06-12 噪音治理复审教训; "built ≠ wired ≠ effective" — apply to every feature/config/param/bus/gate addition):',
    formatWiringEffectivenessReviewStance(),
  ].join('\n')
}

function methodologyVerificationBlock(): string {
  return [
    'Methodology verification stance (2026-06-14 PlanDesignIntentRouter 对抗审查反推; "methodology docs are code — executable instructions require empirical verification" — apply when reviewing knowledge files, plan templates, rules, checklists):',
    formatMethodologyVerificationStance(),
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
  const findings: ReviewFinding[] = []
  for (const result of run.results) {
    if (result.status !== 'passed') continue
    for (const finding of result.findings) {
      findings.push(mapWorkerFinding(result, finding))
    }
  }
  return findings
}

function classifyInfraFailure(result: WorkerResult): ReviewInfraFailure['kind'] {
  const text = `${result.summary}\n${result.risks.join('\n')}\n${result.artifacts.map(a => a.content).join('\n')}`
  if (/did not contain a JSON object|schema-valid JSON|parse/i.test(text)) return 'json'
  if (/timeout|timed out/i.test(text)) return 'timeout'
  if (/skipped/i.test(text)) return 'skip'
  return 'worker'
}

function mapSquadronInfraFailures(run: CoordinatorRun): ReviewInfraFailure[] {
  if (run.status === 'skipped') {
    return [{ kind: 'skip', claim: 'Review Squadron skipped before producing findings' }]
  }

  const failures: ReviewInfraFailure[] = []
  for (const result of run.results) {
    if (result.status === 'passed') continue
    failures.push({ kind: classifyInfraFailure(result), claim: result.summary })
  }
  return failures
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
    weighingReviewBlock(),
    wiringEffectivenessBlock(),
    methodologyVerificationBlock(),
    `Files: ${files(change).join(', ') || '(none)'}`,
    ...(change.focusHint ? [`**Reviewer focus**: ${change.focusHint}`] : []),
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

// ─── Inspector definitions ──────────────────────────────────────────
// Prompt economy: every inspector carries the core objective stance
// (anti-rubber-stamp), plus ONLY the stances relevant to its own axis.
// Stacking all stances on all five inspectors quintupled prompt size and
// diluted each inspector's focus — the axis IS the specialization.

type InspectorStance = 'dataflow' | 'pathBoundary' | 'wiring' | 'methodology'

const WIRING_INSPECTOR_METHOD = [
  'Method (run these checks, cite file:line evidence for each):',
  '1. Entry-anchor closure: FIRST identify the target project\'s real production entrypoint(s) — package.json bin/main/start scripts, server boot file, CLI entry, or framework entry convention (next/vite/django app root). THEN trace FORWARD from that entry through the composition root (bootstrap / DI container / route registration / constructor & param chain) to each changed symbol, hop by hop. A hookup found only in a legacy or parallel entrypoint, example/script code, or tests is NOT closure evidence; in multi-entry projects (CLI+server, old+new UI) confirm the hookup sits on the entry chain this change actually affects. No forward path from a live entry to the change = dead wiring, report HIGH.',
  '2. For every new param/field/setter/config flag in the diff: grep ALL call sites — zero callers passing/reading it means dead wiring, report it.',
  '3. For every gate/filter condition: enumerate the real runtime input shapes (relative vs absolute paths, missing optional fields, empty collections) and estimate the pass rate — ~0% = silently disabled feature, ~100% = no-op gate.',
  '4. For every stated goal (less noise / fewer calls / faster): construct the before/after scenario and verify the metric actually moves in the stated direction.',
  '5. For removed call sites: check the producer/setter/field left behind is also removed or still has a live consumer.',
].join('\n')

const INSPECTORS: Array<{ name: string; objective: string; stances: InspectorStance[]; method?: string }> = [
  {
    name: 'Security',
    objective: 'Review authentication, authorization, path validation, secret exposure, and fail-open/fail-closed behavior.',
    stances: ['pathBoundary'],
  },
  {
    name: 'Lifecycle',
    objective: 'Review state transitions, async races, cancellation, timeout propagation, and load-check-save atomicity. Verify outer timeouts strictly dominate inner budgets (inner must fire first to preserve partial results).',
    stances: ['dataflow'],
  },
  {
    name: 'Data Flow',
    objective: 'Review parameter propagation, allowlist/tool scope propagation, persistence paths, and data loss risks.',
    stances: ['dataflow', 'pathBoundary'],
  },
  {
    name: 'Silence',
    objective: 'Review swallowed errors, empty catch blocks, missing diagnostics, and false green verification claims. Treat "tests pass / already fixed" assertions as the highest-priority review target: demand the command + observed output. Also flag fixture-fabricated false greens (虚假绿灯): a test asserting a field/shape that NO production code ever writes a real value to — only the fixture does — so the feature is green-but-dead.',
    stances: [],
  },
  {
    name: 'Wiring',
    objective: 'Review end-to-end wiring and effectiveness — "built ≠ wired ≠ effective". Hunt: plan items half-done (field added but never enforced), new optional params with zero callers, setters/buses/config flags never read or flushed, gates whose real-world data shapes filter ~everything (silent feature kill), and changes that backfire against their stated goal (e.g. old channel kept alongside new one — duplicate rendering in a noise-reduction change).',
    stances: ['wiring'],
    method: WIRING_INSPECTOR_METHOD,
  },
]

function stanceBlocks(stances: InspectorStance[]): string[] {
  const blocks: string[] = []
  if (stances.includes('dataflow')) blocks.push(dataflowVerifierBlock())
  if (stances.includes('pathBoundary')) blocks.push(pathBoundaryReviewBlock())
  if (stances.includes('wiring')) blocks.push(wiringEffectivenessBlock())
  if (stances.includes('methodology')) blocks.push(methodologyVerificationBlock())
  return blocks
}

const FINDING_CONTRACT = 'Report each finding with severity CRITICAL/HIGH/MEDIUM/LOW, claim, evidence (file:line), and minimal fix suggestion. Report "no findings" explicitly if the axis is clean — silence is not a verdict.'

function inspectorObjective(inspector: typeof INSPECTORS[number], change: ChangeSet): string {
  return [
    `${inspector.name} Inspector: ${inspector.objective}`,
    objectiveReviewStanceBlock(),
    ...stanceBlocks(inspector.stances),
    ...(inspector.method ? [inspector.method] : []),
    `Files: ${files(change).join(', ') || '(none)'}`,
    ...(change.focusHint ? [`**Reviewer focus**: ${change.focusHint}`] : []),
    ...(inspector.stances.includes('dataflow')
      ? ['For spec/integration changes, review the fact-flow graph, condition matrix, and counterexample tests before accepting checklist-style coverage.']
      : []),
    FINDING_CONTRACT,
  ].join('\n')
}

function squadronRequests(change: ChangeSet, options: CoordinatorReviewDepsOptions): DelegationRequest[] {
  return INSPECTORS.map(inspector => request({
    change,
    options,
    kind: 'review',
    profile: 'reviewer',
    objective: inspectorObjective(inspector, change),
  }))
}

// ─── Auto in-task review: single wiring inspector, short budget ─────
// Auto review must never stall the main loop: 150s internal worker budget
// (< AUTO_REVIEW_BUDGET_MS 180s outer cap, so the worker's own timer fires
// first and preserves partial output), bounded turns, read-only profile.
const AUTO_WIRING_WORKER_TIMEOUT_MS = 150_000
const AUTO_WIRING_WORKER_MAX_TURNS = 6

function wiringReviewerRequest(change: ChangeSet, options: CoordinatorReviewDepsOptions): DelegationRequest {
  const wiring = INSPECTORS.find(i => i.name === 'Wiring')!
  return {
    ...request({
      change,
      options,
      kind: 'review',
      profile: 'reviewer',
      objective: [
        inspectorObjective(wiring, change),
        `Time budget is tight (~${Math.round(AUTO_WIRING_WORKER_TIMEOUT_MS / 1000)}s): review the DIFF of the listed files first (git diff/read targeted ranges), do not read whole files or explore beyond scope. Prioritize check 1 and 2 of the method; report what you covered.`,
      ].join('\n'),
    }),
    budget: { timeoutMs: AUTO_WIRING_WORKER_TIMEOUT_MS, maxTurns: AUTO_WIRING_WORKER_MAX_TURNS },
  }
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
      return { findings: mapSquadronFindings(run), infraFailures: mapSquadronInfraFailures(run) }
    },

    spawnWiringReviewer: async (change): Promise<SquadronResult> => {
      // Auto review: 2 inspectors in parallel (Wiring + Silence).
      // Wiring catches "built ≠ wired ≠ effective", Silence catches
      // swallowed errors, false green claims, and counterexample gaps.
      // Flash models are reliable enough at these focused axes.
      const wiring = INSPECTORS.find(i => i.name === 'Wiring')!
      const silence = INSPECTORS.find(i => i.name === 'Silence')!
      const requests = [wiring, silence].map(inspector => ({
        ...request({
          change,
          options,
          kind: 'review' as const,
          profile: 'reviewer' as const,
          objective: [
            inspectorObjective(inspector, change),
            `Time budget is tight (~${Math.round(AUTO_WIRING_WORKER_TIMEOUT_MS / 1000)}s): review the DIFF of the listed files first (git diff/read targeted ranges), do not read whole files or explore beyond scope. Report what you covered.`,
          ].join('\n'),
        }),
        budget: { timeoutMs: AUTO_WIRING_WORKER_TIMEOUT_MS, maxTurns: AUTO_WIRING_WORKER_MAX_TURNS },
      }))
      const run = coordinator.delegateBatch
        ? await coordinator.delegateBatch(requests, 'all_required', options.abortSignal)
        : await runSquadronSerially(coordinator, requests, options.abortSignal)
      return { findings: mapSquadronFindings(run), infraFailures: mapSquadronInfraFailures(run) }
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
