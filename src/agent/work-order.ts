import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { CapabilityTask } from '../model/capability.js'
import type { Usage } from '../api/types.js'
import type { VerificationMetadata } from '../tools/types.js'
import { profileRegistry } from './profile-registry.js'
import { starDomainRegistry } from './star-domain-registry.js'
import { progressiveTimeout } from './timeout-ladder.js'

export const READ_ONLY_WORKER_TOOLS = ['read_file', 'read_section', 'glob', 'grep', 'diff', 'inspect_project', 'repo_map', 'repo_graph', 'related_tests'] as const

/**
 * Write-capable worker tools. Patcher/verifier profiles are classified as
 * 'hands' role (see coordination-policy.ts:classifyProfile) and dispatched
 * through runHands → runHandsSession, which creates an isolated git worktree
 * before the worker executes. The worktree isolation ensures writes are
 * scoped and mergeable, but write operations may still be blocked by the
 * host agent framework's subagent sandbox — that is a host-layer constraint,
 * not a Rivet permission issue.
 */
export const WRITE_WORKER_TOOLS = ['read_file', 'read_section', 'glob', 'grep', 'diff', 'inspect_project', 'repo_map', 'repo_graph', 'related_tests', 'edit_file', 'write_file', 'bash', 'run_tests'] as const
export const PHASE1_DISALLOWED_WORKER_TOOLS = ['bash', 'write_file', 'edit_file', 'run_tests', 'delegate_task', 'delegate_batch'] as const

/** 领域轴 — 代码区域，团队协同的天然边界 */
export const domainAreaSchema = z.enum([
  'frontend',   // src/tui/
  'backend',    // src/agent/, src/api/, src/compact/, src/context/
  'prompt',     // src/prompt/
  'tools',      // src/tools/
  'config',     // src/config/
  'docs',       // docs/
  'tests',      // *.test.ts, *.spec.ts
])
export type DomainArea = z.infer<typeof domainAreaSchema>

export const workOrderKindSchema = z.enum([
  'code_search',
  'doc_research',
  'plan',
  'review',
  'verify',
  'patch_proposal',
])

export type WorkOrderKind = z.infer<typeof workOrderKindSchema>

/** Dynamic profile validation — accepts built-in + user-loaded profiles. */
export const workerProfileSchema = z.string().refine(
  (val) => profileRegistry.getProfileNames().includes(val),
  (val) => ({ message: `Unknown worker profile "${val}". Available: ${profileRegistry.getProfileNames().join(', ')}` }),
)

export type WorkerProfile = z.infer<typeof workerProfileSchema>

export const aggregationPolicySchema = z.enum([
  'all_required',
  'first_success',
  'majority',
  'primary_decides',
  'weighted_confidence',
])

export type AggregationPolicy = z.infer<typeof aggregationPolicySchema>

export const workOrderScopeSchema = z.object({
  files: z.array(z.string()).optional(),
  symbols: z.array(z.string()).optional(),
  commands: z.array(z.string()).optional(),
  externalUrls: z.array(z.string()).optional(),
  maxFiles: z.number().int().positive().optional(),
  maxTokens: z.number().int().min(1000).optional(),
})

export type WorkOrderScope = z.infer<typeof workOrderScopeSchema>

const workerBudgetSchema = z.object({
  maxTurns: z.number().int().positive(),
  maxTokens: z.number().int().positive(),
  timeoutMs: z.number().int().positive(),
  maxRetries: z.number().int().min(0),
  retryBackoffMs: z.number().int().positive(),
  maxRetryBackoffMs: z.number().int().positive(),
})

export type WorkerBudget = z.infer<typeof workerBudgetSchema>

/**
 * Enforce a work order's per-profile turn budget against a runtime's generic
 * default. The runtime factory hands back a broad default `maxTurns`; the work
 * order's `budget.maxTurns` (e.g. a reviewer's 6) must win whenever it's
 * tighter, otherwise the budget is decorative and workers run to the global cap.
 */
export function clampWorkerMaxTurns(runtimeDefault: number, budgetMaxTurns: number): number {
  return Math.min(runtimeDefault, budgetMaxTurns)
}

/**
 * Single derivation point for a worker's runtime session id (conversation
 * JSONL under ~/.rivet/sessions/<slug>/ AND artifact dir under
 * .rivet/artifacts/). Batch order ids (`batch:0`) are intentionally stable
 * across delegation runs (dependencies/resume/claims key off them), so
 * without a per-dispatch nonce every run of the session appends to the SAME
 * worker-batch-0.jsonl — cumulative context, stale artifacts (session
 * 2c1186f5). The coordinator mints a nonce per dispatch; both the worker's
 * AgentLoop session and the coordinator's artifact fallback registration
 * must derive through here so they stay in sync.
 */
export function deriveWorkerSessionId(orderId: string, dispatchNonce?: string): string {
  const base = `worker-${orderId.replace(/:/g, '-')}`
  return dispatchNonce ? `${base}-${dispatchNonce}` : base
}

export const workOrderSchema = z.object({
  id: z.string().min(1),
  parentTurnId: z.string().min(1),
  kind: workOrderKindSchema,
  profile: workerProfileSchema,
  objective: z.string().min(1),
  scope: workOrderScopeSchema,
  constraints: z.array(z.string()),
  allowedTools: z.array(z.string()),
  disallowedTools: z.array(z.string()),
  dedupeKey: z.string().min(1),
  dependencies: z.array(z.string()),
  aggregationPolicy: aggregationPolicySchema,
  budget: workerBudgetSchema,
  domain: domainAreaSchema.optional(),
  workerCwd: z.string().optional(),
  reviewDepth: z.number().int().min(0).optional(),
  /** B3: delegation nesting depth (0 = spawned by primary). Capped by the
   *  coordinator at MAX_DELEGATION_DEPTH — nesting allowed but gated. */
  delegationDepth: z.number().int().min(0).default(0),
  /** Star domain authority for cognitive injection (V3 Component A). */
  authority: z.string().optional(),
  /** Team planner risk tier for shadow-only model tier recommendation. */
  riskTier: z.enum(['low', 'medium', 'high']).optional(),
  /** Per-order provider/model override (highest routing precedence). When set,
   *  the worker runs on this exact provider/model with its own client/cache —
   *  used by heterogeneous council seats. Silently ignored if the provider is
   *  unknown or lacks credentials (runtimeFactory falls back to the session model). */
  modelOverride: z.object({ provider: z.string().min(1), model: z.string().min(1) }).optional(),
  /** 瑶光门 tier 下限：路由结果不得低于此档（council 席位 tierHint+noDowngrade
   *  等场景）。只抬升不降级；modelOverride 仍然最高优先。 */
  tierFloor: z.enum(['cheap', 'balanced', 'strong']).optional(),
})

export type WorkOrder = z.infer<typeof workOrderSchema>

const verificationMetadataSchema = z.object({
  command: z.string(),
  status: z.enum(['passed', 'failed', 'blocked']),
  scope: z.enum(['full', 'targeted']),
  exitCode: z.number(),
  passed: z.number(),
  failed: z.number(),
  skipped: z.number(),
  durationMs: z.number(),
}) satisfies z.ZodType<VerificationMetadata>

const workerFindingSchema = z.object({
  claim: z.string().min(1),
  evidence: z.string().min(1),
  confidence: z.enum(['low', 'medium', 'high']),
})

const workerArtifactSchema = z.object({
  kind: z.enum(['note', 'patch', 'test_command', 'risk', 'question', 'diff']),
  title: z.string().min(1),
  content: z.string().min(1),
})

export type WorkerArtifact = z.infer<typeof workerArtifactSchema>

/** Root cause when a worker fails (status = 'blocked' or 'failed').
 *  Enables the primary agent to choose the right recovery strategy:
 *  - json_parse / schema_mismatch → retry with clearer format instructions
 *  - timeout / circuit_open → do NOT retry immediately, wait or skip
 *  - worker_crash → retry may help (infra flake)
 *  - claim_conflict → resolve the conflict first
 *  - caller_aborted → the primary cancelled this, don't retry same request
 */
export type WorkerFailureReason =
  | 'caller_aborted'
  | 'circuit_open'
  | 'claim_conflict'
  | 'timeout'
  | 'json_parse'
  | 'schema_mismatch'
  | 'worker_crash'
  | 'worker_blocked'
  | 'unknown'

export const workerResultSchema = z.object({
  workOrderId: z.string().min(1),
  status: z.enum(['passed', 'failed', 'blocked', 'escalated']),
  summary: z.string().min(1),
  findings: z.array(workerFindingSchema),
  artifacts: z.array(workerArtifactSchema),
  patchSummary: z.string().optional(),
  verification: verificationMetadataSchema.optional(),
  changedFiles: z.array(z.string()),
  /** Persisted diff artifact id (set by runHandsSession after落盘). Absent if the
   *  worker produced no diff or persistence failed. Carried through to
   *  DelegationActivity.artifactId so the UI can fetch this worker's diff. */
  diffArtifactId: z.string().optional(),
  examinedFiles: z.array(z.string()).optional(),
  risks: z.array(z.string()),
  nextActions: z.array(z.string()),
  evidenceStatus: z.enum(['verified', 'failed', 'blocked', 'unverified', 'skipped']).default('unverified'),
  /** Why the worker failed — enables recovery-strategy differentiation. */
  failureReason: z.enum(['caller_aborted', 'circuit_open', 'claim_conflict', 'timeout', 'json_parse', 'schema_mismatch', 'worker_crash', 'worker_blocked', 'unknown']).optional(),
  /** Runtime metadata: actual model used by the worker. */
  model: z.string().optional(),
  /** Runtime metadata: provider used by the worker. */
  provider: z.string().optional(),
  /** Runtime metadata: cumulative token usage for this worker run. */
  usage: z.object({
    input_tokens: z.number().optional(),
    output_tokens: z.number().optional(),
    cache_read_input_tokens: z.number().optional(),
    cache_creation_input_tokens: z.number().optional(),
    reasoning_tokens: z.number().optional(),
    total_tokens: z.number().optional(),
  }).optional(),
})

const workerResultIngestSchema = z.object({
  workOrderId: z.string().min(1),
  status: z.enum(['passed', 'failed', 'blocked', 'escalated']),
  summary: z.string().min(1).default('(no summary provided by worker)'),
  findings: z.union([
    z.array(z.union([workerFindingSchema, z.string().min(1)])),
    // Accept missing findings key entirely
    z.undefined().transform(() => [] as (z.infer<typeof workerFindingSchema> | string)[]),
  ]).default([]),
  artifacts: z.union([
    z.array(z.union([workerArtifactSchema, z.string().min(1)])),
    z.undefined().transform(() => [] as (z.infer<typeof workerArtifactSchema> | string)[]),
  ]).default([]),
  patchSummary: z.string().optional(),
  verification: verificationMetadataSchema.optional(),
  changedFiles: z.union([
    z.array(z.string()),
    z.undefined().transform(() => [] as string[]),
  ]).default([]),
  examinedFiles: z.array(z.string()).optional(),
  risks: z.union([
    // Accept structured risk objects (model infers shape from findings),
    // plain strings, or missing/empty. Coerced to strings in normalizeWorkerResult.
    z.array(z.union([z.record(z.string(), z.unknown()), z.string().min(1)])),
    z.undefined().transform(() => [] as (Record<string, unknown> | string)[]),
  ]).default([]),
  nextActions: z.union([
    z.array(z.union([z.record(z.string(), z.unknown()), z.string().min(1)])),
    z.undefined().transform(() => [] as (Record<string, unknown> | string)[]),
  ]).default([]),
  evidenceStatus: z.enum(['verified', 'failed', 'blocked', 'unverified', 'skipped']).default('unverified'),
})

export type WorkerResult = z.infer<typeof workerResultSchema>

export interface CreateReadOnlyWorkOrderInput {
  id?: string
  parentTurnId: string
  kind: WorkOrderKind
  profile: WorkerProfile
  objective: string
  scope: WorkOrderScope
  constraints?: string[]
  dependencies?: string[]
  aggregationPolicy?: AggregationPolicy
  budget?: Partial<WorkerBudget>
  domain?: DomainArea
  /** Review-router re-entrancy depth propagated across delegation boundaries. */
  reviewDepth?: number
  /** B3: delegation nesting depth (0 = spawned by primary). */
  delegationDepth?: number
  /** Star domain authority for cognitive injection (V3 Component A). */
  authority?: string
  /** Team planner risk tier for shadow-only model tier recommendation. */
  riskTier?: 'low' | 'medium' | 'high'
  /** B2: current session turn for progressive timeout calculation. */
  sessionTurn?: number
  /** Per-order provider/model override (highest routing precedence). */
  modelOverride?: { provider: string; model: string }
  /** 瑶光门 tier 下限：路由结果不得低于此档。只抬升不降级。 */
  tierFloor?: 'cheap' | 'balanced' | 'strong'
}

function toolsForAuthority(tools: string[], authority?: string): string[] {
  if (!authority) return tools

  const domainDef = starDomainRegistry.get(authority)
  if (!domainDef) {
    // Fail closed: an authority layer is an extra restriction. If the domain
    // id is misspelled or not loaded, do not silently fall back to the profile
    // tool set — that makes the restriction disappear without a signal.
    console.warn(
      `[work-order] Unknown authority "${authority}" — worker gets zero tools (fail-closed). ` +
      `Known domains: ${starDomainRegistry.getDomainIds().join(', ')}.`,
    )
    return []
  }

  const whitelist = new Set(domainDef.toolWhitelist)
  return tools.filter(t => whitelist.has(t))
}

export function createReadOnlyWorkOrder(input: CreateReadOnlyWorkOrderInput): WorkOrder {
  const id = input.id ?? `wo_${randomUUID()}`
  return workOrderSchema.parse({
    id,
    parentTurnId: input.parentTurnId,
    kind: input.kind,
    profile: input.profile,
    objective: input.objective,
    scope: input.scope,
    constraints: input.constraints ?? (input.profile === 'adversarial_verifier'
      ? [
          'Return only evidence-backed claims.',
          'Do not suggest edits as completed changes.',
          'Do not request write, edit, or bash tools.',
          'Run tests whenever possible — your verdict requires command+evidence output.',
        ]
      : [
          'Return only evidence-backed claims.',
          'Do not suggest edits as completed changes.',
          'Do not request write, edit, bash, or test execution tools.',
        ]),
    allowedTools: (() => {
      const profileDef = profileRegistry.get(input.profile)
      const tools = profileDef?.allowedTools ? [...profileDef.allowedTools] : [...READ_ONLY_WORKER_TOOLS]
      return toolsForAuthority(tools, input.authority)
    })(),
    disallowedTools: input.profile === 'adversarial_verifier'
      ? ['bash', 'write_file', 'edit_file', 'delegate_task', 'delegate_batch'] // run_tests NOT disallowed — it's the verifier's primary weapon
      : [...PHASE1_DISALLOWED_WORKER_TOOLS],
    dedupeKey: `${input.kind}:${input.scope.files?.join(',') || input.objective}`,
    dependencies: input.dependencies ?? [],
    aggregationPolicy: input.aggregationPolicy ?? 'primary_decides',
    budget: {
      maxTurns: input.budget?.maxTurns ?? 24,
      maxTokens: input.budget?.maxTokens ?? profileRegistry.get(input.profile)?.defaultMaxTokens ?? 4096,
      timeoutMs: input.budget?.timeoutMs ?? profileRegistry.get(input.profile)?.defaultTimeoutMs ?? progressiveTimeout(input.sessionTurn),
      maxRetries: input.budget?.maxRetries ?? 2,
      retryBackoffMs: input.budget?.retryBackoffMs ?? 10000,
      maxRetryBackoffMs: input.budget?.maxRetryBackoffMs ?? 300000,
    },
    domain: input.domain,
    reviewDepth: input.reviewDepth,
    delegationDepth: input.delegationDepth ?? 0,
    authority: input.authority,
    riskTier: input.riskTier,
    modelOverride: input.modelOverride,
    tierFloor: input.tierFloor,
  })
}

export interface CreateWriteWorkOrderInput extends Omit<CreateReadOnlyWorkOrderInput, 'profile'> {
  profile?: WorkerProfile
}

export function createWriteWorkOrder(input: CreateWriteWorkOrderInput): WorkOrder {
  const id = input.id ?? `wo_${randomUUID()}`
  return workOrderSchema.parse({
    id,
    parentTurnId: input.parentTurnId,
    kind: input.kind,
    profile: input.profile ?? 'patcher',
    objective: input.objective,
    scope: input.scope,
    constraints: input.constraints ?? [
      'Return a patchSummary describing all changes made.',
      'List every changed file in changedFiles.',
      'Include verification results if tests were run.',
    ],
    allowedTools: (() => {
      const writeProfile = input.profile ?? 'patcher'
      const profileDef = profileRegistry.get(writeProfile)
      const tools = profileDef?.allowedTools ? [...profileDef.allowedTools] : [...WRITE_WORKER_TOOLS]
      return toolsForAuthority(tools, input.authority)
    })(),
    disallowedTools: ['delegate_task', 'delegate_batch'],
    dedupeKey: `write:${input.scope.files?.join(',') || input.objective}`,
    dependencies: input.dependencies ?? [],
    aggregationPolicy: input.aggregationPolicy ?? 'primary_decides',
    budget: {
      // Self-contained shards run a full loop (implement + tsc/lint/tests) in one
      // context, so write workers need a generous turn budget to finish a
      // long-program shard without being cut off mid-task. Flash has a 1M window;
      // 8–14 turns was far too tight for real implement+verify work.
      maxTurns: input.budget?.maxTurns ?? 32,
      maxTokens: input.budget?.maxTokens ?? profileRegistry.get(input.profile ?? 'patcher')?.defaultMaxTokens ?? 16384,
      timeoutMs: input.budget?.timeoutMs ?? profileRegistry.get(input.profile ?? 'patcher')?.defaultTimeoutMs ?? progressiveTimeout(input.sessionTurn),
      maxRetries: input.budget?.maxRetries ?? 1,
      retryBackoffMs: input.budget?.retryBackoffMs ?? 10000,
      maxRetryBackoffMs: input.budget?.maxRetryBackoffMs ?? 300000,
    },
    domain: input.domain,
    reviewDepth: input.reviewDepth,
    delegationDepth: input.delegationDepth ?? 0,
    authority: input.authority,
    riskTier: input.riskTier,
    modelOverride: input.modelOverride,
    tierFloor: input.tierFloor,
  })
}

export function mapWorkOrderKindToCapabilityTask(kind: WorkOrderKind): CapabilityTask {
  switch (kind) {
    case 'code_search':
    case 'doc_research':
      return 'repo_summarization'
    case 'plan':
      return 'planning'
    case 'verify':
      return 'test_failure_diagnosis'
    case 'review':
    case 'patch_proposal':
      return 'risky_refactor'
  }
}

function extractFencedJsonCandidates(text: string): string[] {
  return [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)]
    .map(match => match[1]?.trim())
    .filter((candidate): candidate is string => Boolean(candidate?.startsWith('{') && candidate.endsWith('}')))
}

function extractBalancedJsonCandidates(text: string): string[] {
  const candidates: string[] = []
  for (let start = text.indexOf('{'); start !== -1; start = text.indexOf('{', start + 1)) {
    let depth = 0
    let inString = false
    let escaped = false
    for (let i = start; i < text.length; i++) {
      const ch = text[i]!
      if (escaped) { escaped = false; continue }
      if (ch === '\\') { escaped = true; continue }
      if (ch === '"') { inString = !inString; continue }
      if (inString) continue
      if (ch === '{') depth++
      if (ch === '}') {
        depth--
        if (depth === 0) {
          candidates.push(text.slice(start, i + 1))
          break
        }
      }
    }
  }
  return candidates
}

export function extractJsonCandidates(text: string): string[] {
  // Strategy 1: fenced JSON (```json ... ``` or ``` ... ```) — Codex-style multi-tag.
  const fenced = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)]
    .map(m => m[1]?.trim())
    .filter((c): c is string => Boolean(c?.includes('{') && c.includes('}')))

  // Strategy 2: balanced { ... } pairs anywhere in the response.
  const balanced = extractBalancedJsonCandidates(text)

  // Strategy 3: YAML/TOML fences — some models wrap JSON in ```yaml or ```toml.
  const altFenced = [...text.matchAll(/```(?:yaml|toml)?\s*([\s\S]*?)```/g)]
    .map(m => m[1]?.trim())
    .filter((c): c is string => Boolean(c?.startsWith('{') && c.endsWith('}')))

  const all = [...fenced, ...altFenced, ...balanced]

  // Strategy 4: tail extraction — models most often place JSON at the END of
  // the response after prose. Try the last N characters as a candidate.
  const TAIL_SIZE = 8000
  const tail = text.length > TAIL_SIZE ? text.slice(-TAIL_SIZE) : text
  const tailFirst = tail.indexOf('{')
  const tailLast = tail.lastIndexOf('}')
  if (tailFirst !== -1 && tailLast > tailFirst) {
    const tailCandidate = tail.slice(tailFirst, tailLast + 1)
    // Avoid duplicate of an already-captured balanced candidate
    if (!all.includes(tailCandidate)) {
      all.push(tailCandidate)
    }
  }

  if (all.length > 0) return all

  // Strategy 5: raw text — treat the entire trimmed message as a candidate.
  const trimmed = text.trim()
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    return [trimmed]
  }

  // Strategy 6: truncated JSON repair — find the first { and append } to balance.
  const firstBrace = text.indexOf('{')
  if (firstBrace !== -1) {
    const truncated = text.slice(firstBrace)
    // Count open vs close braces and append enough } to balance.
    let depth = 0
    let inStr = false
    let esc = false
    for (const ch of truncated) {
      if (esc) { esc = false; continue }
      if (ch === '\\') { esc = true; continue }
      if (ch === '"') { inStr = !inStr; continue }
      if (inStr) continue
      if (ch === '{') depth++
      else if (ch === '}') depth--
    }
    if (depth > 0) {
      all.push(truncated + '}'.repeat(depth))
    }
  }

  if (all.length > 0) return all

  throw new Error('Worker result did not contain a JSON object')
}

function extractJsonParseError(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

function parseJsonCandidate(candidate: string): unknown {
  return JSON.parse(candidate) as unknown
}

function normalizeWorkerResult(raw: z.infer<typeof workerResultIngestSchema>): WorkerResult {
  return workerResultSchema.parse({
    ...raw,
    findings: raw.findings.map((finding, index) => typeof finding === 'string'
      ? { claim: finding, evidence: `worker finding ${index + 1}`, confidence: 'medium' as const }
      : finding),
    artifacts: raw.artifacts.map((artifact, index) => typeof artifact === 'string'
      ? { kind: 'note' as const, title: `Artifact ${index + 1}`, content: artifact }
      : artifact),
    risks: raw.risks.map(r => typeof r === 'string' ? r : JSON.stringify(r)),
    nextActions: raw.nextActions.map(a => typeof a === 'string' ? a : JSON.stringify(a)),
  })
}

function parseWorkerResultObject(parsed: unknown, expectedWorkOrderId: string): WorkerResult {
  // Fault tolerance for cheap models:
  // - Force workOrderId to expected value (models may omit or hallucinate it).
  // - Default missing status to 'blocked' (flash models frequently omit it).
  // Only apply when the JSON has at least workOrderId (real worker packet),
  // NOT for incidental JSON objects (e.g. {"note":"not the result"}).
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const obj = parsed as Record<string, unknown>
    const hasWorkOrderId = typeof obj.workOrderId === 'string' && obj.workOrderId.length > 0
    if (hasWorkOrderId || typeof obj.summary === 'string') {
      obj.workOrderId = expectedWorkOrderId
      if (obj.status === undefined || obj.status === null || obj.status === '') {
        obj.status = 'blocked'
      }
    }
  }

  const ingested = workerResultIngestSchema.parse(parsed)
  return normalizeWorkerResult(ingested)
}

/** Thrown when JSON candidates exist in the worker output but none parses into
 *  a schema-valid WorkerResult. MUST be thrown (not swallowed into a blocked
 *  result) so the caller's catch-driven repair loop fires — a single malformed
 *  character in an otherwise complete report is recoverable with one cheap
 *  in-session repair re-ask (worker context is prefix-cached). See session
 *  2c1186f5: a 10.9k-char scout report was discarded because the terminal
 *  blocked-return bypassed the repair loop entirely. */
export class WorkerResultParseError extends Error {
  constructor(
    readonly candidateCount: number,
    readonly parseErrors: readonly string[],
  ) {
    super(`JSON candidates found (${candidateCount}) but none parseable. Errors: ${parseErrors.join(' | ')}`.slice(0, 500))
    this.name = 'WorkerResultParseError'
  }
}

export function parseWorkerResult(text: string, expectedWorkOrderId: string): WorkerResult {
  // extractJsonCandidates throws when truly no JSON is found — let it propagate
  // so the caller's repair loop can trigger a retry with the repair prompt.
  const candidates = extractJsonCandidates(text)
  const errors: string[] = []

  for (const candidate of candidates) {
    let parsed: unknown
    try {
      parsed = parseJsonCandidate(candidate)
    } catch (error) {
      errors.push(extractJsonParseError(error))
      continue
    }

    try {
      return parseWorkerResultObject(parsed, expectedWorkOrderId)
    } catch (error) {
      errors.push(extractJsonParseError(error))
      continue
    }
  }

  // All JSON candidates failed to parse or validate. Throw so the caller's
  // repair loop fires (repair prompt / json-mode re-ask). Terminal handling
  // (salvage → blocked) is the caller's responsibility after retries exhaust.
  throw new WorkerResultParseError(candidates.length, errors)
}

/** Field-level salvage — the terminal tier between "repair retries exhausted"
 *  and an empty blocked result. Scans all JSON candidates for independently
 *  parseable finding objects and a summary string, and rebuilds a degraded but
 *  usable WorkerResult (status stays 'blocked', evidenceStatus 'unverified')
 *  so the primary keeps the scout's recoverable findings instead of losing the
 *  entire report to one syntax error. Returns null when nothing is salvageable. */
export function salvageWorkerResult(text: string, expectedWorkOrderId: string): WorkerResult | null {
  let candidates: string[]
  try {
    candidates = extractJsonCandidates(text)
  } catch {
    return null
  }

  const findings: z.infer<typeof workerFindingSchema>[] = []
  const seenClaims = new Set<string>()
  for (const candidate of candidates) {
    let parsed: unknown
    try {
      parsed = parseJsonCandidate(candidate)
    } catch {
      continue
    }
    const finding = workerFindingSchema.safeParse(parsed)
    if (finding.success && !seenClaims.has(finding.data.claim)) {
      seenClaims.add(finding.data.claim)
      findings.push(finding.data)
    }
  }
  if (findings.length === 0) return null

  const summaryMatch = text.match(/"summary"\s*:\s*"((?:\\.|[^"\\])*)"/)
  let extractedSummary = ''
  if (summaryMatch?.[1]) {
    try {
      extractedSummary = JSON.parse(`"${summaryMatch[1]}"`) as string
    } catch {
      extractedSummary = summaryMatch[1]
    }
  }

  return {
    workOrderId: expectedWorkOrderId,
    status: 'blocked',
    summary: `Worker report JSON was malformed; salvaged ${findings.length}/${candidates.length} candidate(s) as findings.${extractedSummary ? ` Worker's own summary: ${extractedSummary.slice(0, 300)}` : ''}`,
    findings,
    artifacts: [{
      kind: 'note',
      title: 'Parse-salvaged worker report',
      content: `Result contract failed but individual findings were recovered. Treat findings as unverified leads — the full report did not pass schema validation.`,
    }],
    changedFiles: [],
    risks: [`parse-salvaged: ${findings.length} finding(s) recovered from a malformed report — verify before trusting`],
    nextActions: ['Weigh salvaged findings as unverified leads; re-dispatch with resume if full fidelity is needed'],
    evidenceStatus: 'unverified',
    failureReason: 'json_parse',
  }
}

export function buildBlockedWorkerResult(order: WorkOrder, reason: string, failureReason?: WorkerFailureReason): WorkerResult {
  return {
    workOrderId: order.id,
    status: 'blocked',
    summary: `Worker blocked: ${reason}`,
    findings: [],
    artifacts: [{
      kind: 'risk',
      title: 'Worker result contract failed',
      content: reason,
    }],
    changedFiles: [],
    risks: ['Worker did not return schema-valid JSON'],
    nextActions: ['Primary should continue without trusting this worker result'],
    evidenceStatus: 'blocked',
    ...(failureReason ? { failureReason } : {}),
  }
}
