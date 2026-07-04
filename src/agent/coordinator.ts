import type { ModelCapabilityCard, CapabilityTask } from '../model/capability.js'
import { recommendModelForTask } from '../model/capability.js'
import type { ProviderConfig } from '../config/schema.js'
import { filterToolRegistry, ToolRegistry } from '../tools/registry.js'
import { ProviderHealthTracker } from './provider-health.js'
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { subagentsDir } from '../config/paths.js'
import { debugLog } from '../utils/debug.js'
import { CircuitBreakerManager } from './worker-circuit-breaker.js'
import { InMemoryMailbox, type WorkerMailbox } from './worker-mailbox.js'
import { profileRegistry } from './profile-registry.js'
import {
  createReadOnlyWorkOrder,
  createWriteWorkOrder,
  mapWorkOrderKindToCapabilityTask,
  parseWorkerResult,
  READ_ONLY_WORKER_TOOLS,
  WRITE_WORKER_TOOLS,
  type AggregationPolicy,
  type WorkOrder,
  type WorkOrderKind,
  type WorkerProfile,
  type WorkerResult,
  type WorkerBudget,
  type WorkOrderScope,
  type WorkerFailureReason,
  clampWorkerMaxTurns,
} from './work-order.js'
import { buildPrimaryWorkerPacket } from './worker-prompts.js'
import { runWorkerSession, type WorkerSessionConfig, type WorkerSessionRun } from './worker-session.js'
import { saveWorkerSession, loadWorkerSession } from './worker-session-persist.js'
import { WorkerLiveness, EXPLORE_STALL_MS, WRITE_STALL_MS } from './worker-liveness.js'
import { runHandsSession, type HandsSessionConfig, type HandsSessionRun } from './hands-session.js'
import { WorktreeCoordinator } from './worktree-coordinator.js'
import { classifyProfile } from './coordination-policy.js'
import { aggregateResults } from './aggregation.js'
import { CoordinatorState } from './coordinator-state.js'
import { WorkOrderQueue } from './work-queue.js'
import { CollaborationProtocol, type CollaborationConfig } from './collaboration-protocol.js'
import type { LockIntent } from './semantic-lock.js'
import type { DomainKnowledgeStore } from './domain-knowledge-store.js'
import { precipitateDomainLessons } from './domain-lesson-precipitate.js'
import { inferModelTierFromCard, recommendModelTier, type ModelRiskTier, type ModelTier, type ModelTierRecommendation } from './model-tier-policy.js'
import { buildHistoricalModelTierState, recommendModelTierArm, type ModelTierBanditRecommendation } from './model-tier-bandit.js'
import { evaluateModelTierGate, type ModelTierGateDecision } from './model-tier-gate.js'
import {
  buildModelTierGatedDecisionEvent,
  buildModelTierShadowEvent,
  persistModelTierGatedDecision,
  persistModelTierShadow,
  type ModelTierGatedDecisionEvent,
  type ModelTierShadowEvent,
} from './model-tier-shadow.js'
import {
  buildGatedInfluenceAuditEvent,
  persistGatedInfluenceAudit,
  type GatedInfluenceAuditEvent,
} from './gated-influence-audit.js'
import { buildModelPolicyCandidates, selectModelPolicy } from './model-policy-selection.js'
import { buildHistoricalModelRewards } from './model-reward-summary.js'
import type { EFEComponents } from './prediction-error.js'
import type { Sensorium } from './sensorium.js'
import type { OaiMessage } from '../api/oai-types.js'
import type { Usage } from '../api/types.js'

/** Per-turn free-energy signals pulled from the primary loop at delegation time. */
export interface EFERoutingSignals {
  efe: EFEComponents
  sensorium: Pick<Sensorium, 'complexity' | 'pressure' | 'confidence' | 'stability'>
}

export interface EFERoutingConfig {
  /** Gated apply. When false, EFE ranking runs shadow-only (audit events, no dispatch effect). */
  enabled: boolean
  /** Pull latest EFE + sensorium from the primary loop. Undefined → skip EFE routing this call. */
  getSignals: () => EFERoutingSignals | undefined
}

/** Real-time activity event from an in-flight worker (T9 P3 实时上行). */
export interface WorkerActivityEvent {
  workOrderId: string
  profile: string
  /** 星域 id（星名来源），由 coordinator 从 order.authority 透传。 */
  authority?: string
  kind: 'text' | 'thinking' | 'tool_use' | 'tool_result'
  /** Tool name for tool events; text delta for text/thinking. */
  detail?: string
}

/**
 * Derive a stable WorkOrder id from a parentTurnId that carries a known
 * scheduling prefix:
 *  - `team:` — planner/task ids, so WorkOrderQueue can resolve dependency refs;
 *  - `council:` —议事会席位 id，让 runCouncil 能用 result.workOrderId 把每席
 *    结果绑回对应席位（=== `council:seat-${seat}`）。
 *  - `batch:` — delegate_batch task index, so the model can declare cross-task
 *    `dependsOn` and WorkOrderQueue can enforce ordering within one batch.
 * Returns undefined for ad-hoc turns — caller falls back to `wo_<uuid>`.
 * 取末两段（slice(-2)）以容忍 `prefix:team:T1` / `prefix:council:seat-x` 形态。
 */
export function deriveStableWorkOrderId(parentTurnId: string): string | undefined {
  return /\b(team|council|batch):/.test(parentTurnId)
    ? parentTurnId.split(':').slice(-2).join(':')
    : undefined
}

export interface DelegationRequest {
  parentTurnId: string
  objective: string
  kind: WorkOrderKind
  profile: WorkerProfile
  scope: WorkOrderScope
  /** Review-router re-entrancy depth to pass into worker tool contexts. */
  reviewDepth?: number
  /** B3: delegation nesting depth (0 = primary → worker). Requests at
   *  MAX_DELEGATION_DEPTH or deeper are rejected as blocked. */
  delegationDepth?: number
  /** Real-time worker activity upstream (T9 P3). Fired for every worker
   *  text/thinking/tool event so the calling tool can stream live progress
   *  into the UI tool card. NOT serialized into the WorkOrder. */
  onActivity?: (event: WorkerActivityEvent) => void
  /** Work order IDs this task depends on — propagated to WorkOrder.dependencies. */
  dependencies?: string[]
  /** Logical group identifier for related tasks (e.g. team wave). */
  groupId?: string
  /** Star domain authority for cognitive injection (V3 Component A).
   *  When set, the domain's systemPromptSuffix and volatileBlock are injected
   *  into the worker prompt (see buildWorkerPrompt). Tool access is governed
   *  solely by the profile's allowedTools — authority does NOT restrict tools.
   *  Custom domains are loaded at startup, so this must remain an open string. */
  authority?: string
  /** Team planner risk tier for shadow-only model tier recommendation. */
  riskTier?: ModelRiskTier
  /** B2: current session turn for progressive timeout alignment. */
  sessionTurn?: number
  /** Per-request budget overrides (timeout/turns/tokens/retries). Takes
   *  precedence over profile defaults — used e.g. by the auto wiring review
   *  to run a reviewer-profile worker on a short, non-blocking budget. */
  budget?: Partial<WorkerBudget>
  /** Resume a previous worker session by work order id. When provided, the
   *  coordinator loads the prior session's messages and the worker continues
   *  from that context instead of starting fresh. The objective should
   *  describe the continuation task. */
  resumeWorkOrderId?: string
  /** Per-request provider/model override (highest routing precedence). Threaded
   *  onto the WorkOrder; the runtime factory builds a dedicated client for it.
   *  Used by heterogeneous council seats. Silently falls back to the session
   *  model when the provider is unknown or lacks credentials. */
  modelOverride?: { provider: string; model: string }
}

export interface CoordinatorRun {
  status: 'completed' | 'skipped'
  order?: WorkOrder
  selectedModel?: string
  /** True when consecutive failures exceed threshold — primary agent should switch to inline execution. */
  escalated?: boolean
  /** Batch-only metadata: selected worker model per work order. Telemetry only; never affects dispatch. */
  workerModels?: Array<{ workOrderId: string; model: string }>
  /** Append-only tier recommendation telemetry; shadow-only and never affects dispatch. */
  modelTierShadows?: ModelTierShadowEvent[]
  /** Append-only gated tier decisions; applied only behind explicit feature flag and hard gates. */
  modelTierGatedDecisions?: ModelTierGatedDecisionEvent[]
  /** Unified append-only Shadow→Gated audit events; never used as a decision source. */
  gatedInfluenceAudits?: GatedInfluenceAuditEvent[]
  results: WorkerResult[]
  packet: string
  aggregationPolicy?: AggregationPolicy
}

export type WorkerRuntimeFactory = (
  order: WorkOrder,
  card: ModelCapabilityCard,
  workerRegistry: ToolRegistry,
) => WorkerSessionConfig

export interface WorkerRouteConfig {
  profiles: Record<string, { provider: string; model: string }>
  routing: Record<string, string>
  providers?: Record<string, ProviderConfig>
}

export interface DelegationCoordinatorConfig {
  baseToolRegistry: ToolRegistry
  modelCards: ModelCapabilityCard[]
  /** Global max concurrent workers (cap for both explore and write pools). */
  maxWorkers: number
  /** Max concurrent explore (read-only) workers. Default: maxWorkers. */
  maxExploreWorkers?: number
  /** Max concurrent hands (write) workers. Default: maxWorkers. */
  maxWriteWorkers?: number
  runtimeFactory: WorkerRuntimeFactory
  routing?: WorkerRouteConfig
  runWorker?: (config: WorkerSessionConfig) => Promise<WorkerSessionRun>
  runHands?: (config: HandsSessionConfig) => Promise<HandsSessionRun>
  cwd?: string
  activeClaims?: () => import('../context/claims.js').ContextClaim[]
  /** Optional provider health tracker for Physarum-style routing.
   *  When set, cold-tier providers are excluded from model selection. */
  providerHealth?: ProviderHealthTracker
  /** Optional session registry for cross-process file claim coordination. */
  sessionRegistry?: import('./session-registry.js').SessionRegistry
  /** Current session ID for claim management. */
  sessionId?: string
  /** Primary session artifact store. When set, worker artifacts are made resolvable
   *  by registering their session directories as fallbacks, and large worker
   *  packets can be offloaded into the primary store. */
  artifactStore?: import('../artifact/store.js').ArtifactStore
  /** Optional collaboration protocol for semantic locking and merge coordination. */
  collaboration?: CollaborationConfig
  /** AbortSignal to propagate to workers — fires when the tool-level timeout
   *  rejects the outer promise, so zombie workers are cleaned up immediately
   *  instead of waiting for their internal 180s timeout. */
  abortSignal?: AbortSignal
  /** Review-specific model cards keyed by WorkerProfile name (e.g. 'adversarial_verifier',
   *  'reviewer', 'verifier', 'patcher'). When a delegated work order's profile matches
   *  a key, the override card is used directly (bypasses tier filtering and worker
   *  routing). Lets review workers use a different provider/model from the session's
   *  primary — key motivation: prevent server-side-cache providers (GLM/Kimi
   *  implicit caches, Codex) review workers from evicting the main session's cache. */
  reviewOverrideCards?: Map<string, ModelCapabilityCard>
  /** V3 Component B: domain knowledge store for precipitate/recall lifecycle.
   *  When provided, coordinator auto-precipitates lessons from worker results. */
  domainKnowledgeStore?: DomainKnowledgeStore
  /** Optional append-only store for P3/P4-d model tier shadow telemetry and reward history. */
  modelTierShadowStore?: import('./model-tier-shadow.js').ModelTierShadowStore | null
  /** P4-d gated worker tier influence flag. Defaults to shadow-only. */
  modelTierBanditEnabled?: boolean
  /** Append-only unified gated influence audit store. Defaults to modelTierShadowStore when omitted. */
  gatedInfluenceAuditStore?: import('./gated-influence-audit.js').GatedInfluenceAuditStore | null
  /** Track 1: EFE × provider-health worker model routing.
   *  Always audited; applied to dispatch only when enabled (explicit user routing
   *  config still takes precedence over EFE). */
  efeRouting?: EFERoutingConfig
  /** A4: silence tolerance before an in-flight worker is considered stalled
   *  and aborted by the sweep. Defaults to EXPLORE_STALL_MS (write workers
   *  get WRITE_STALL_MS). Workers die for silence, never for duration. */
  workerStallMs?: number
  /** Injectable clock for liveness tests. */
  livenessClock?: () => number
  /** T5: enable fingerprint-based result resume. Default false (opt-in); set true in bootstrap. */
  resumeEnabled?: boolean
  /** Per-profile circuit breaker — fast-fails delegation to profiles that are
   *  repeatedly failing, preventing cascade waste. When omitted a default
   *  instance is created internally. */
  circuitBreaker?: CircuitBreakerManager
  /** Max nesting depth for delegation. Falls back to MAX_DELEGATION_DEPTH when unset. */
  maxDelegationDepth?: number
  /** Injectable sleep function for backoff retry testing. Defaults to real setTimeout. */
  retrySleepFn?: (ms: number, signal?: AbortSignal) => Promise<void>
  /** Shared-worktree mode: when true, write (hands) workers run directly in the
   *  shared cwd (the controller's single worktree/branch) instead of each
   *  spawning its own git worktree. Orthogonal shards touch disjoint files; the
   *  file-claim registry + groupTeamTasks same-file serialization prevent
   *  stomping. Trades the per-worker isolated diff for a simpler "all changes
   *  land in one workspace, controller reads aggregate git diff" model. */
  sharedWorktree?: boolean
  /** 天梁 patcher 子代理的默认 tier（config.workers.patcherTier）。
   *  传入 recommendModelTier 的 workerTierOverride——用户可自定义执行者用哪档模型。 */
  patcherTier?: ModelTier
}

export function shouldDelegateObjective(objective: string, scope: WorkOrderScope): boolean {
  const trimmed = objective.trim()
  const words = trimmed.split(/\s+/).filter(Boolean).length
  // CJK text carries no whitespace, so whitespace word-count drastically
  // undercounts Chinese/Japanese objectives — a fully-detailed Chinese task (and
  // even the patcher's Chinese instruction prefix) reads as ~1 "word" and would
  // be wrongly skipped, silently dispatching zero workers. Count CJK characters
  // as tokens so substantive non-Latin objectives clear the gate. Additive: pure
  // OR branch, so existing Latin behavior is unchanged.
  const cjkChars = (trimmed.match(/[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g) ?? []).length
  return words >= 6 || cjkChars >= 8 || (scope.files?.length ?? 0) >= 2 || (scope.symbols?.length ?? 0) >= 2
}

/**
 * Sleep with abort support. Resolves after `ms` or rejects immediately when
 * the signal fires. Listener is cleaned up on resolve to prevent accumulation.
 * In test environments (RIVET_TEST=1), delay is clamped to 0 for speed.
 */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  const actualMs = process.env.RIVET_TEST ? 0 : ms
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('Aborted during backoff: signal already fired'))
    const onAbort = () => {
      clearTimeout(timer)
      reject(new Error('Aborted during backoff'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, actualMs)
  })
}

function classifyWorkerError(error: unknown): WorkerFailureReason {
  const msg = error instanceof Error ? error.message : String(error)
  if (/timed out|timeout|exceeded.*time/i.test(msg)) return 'timeout'
  if (/JSON|parse.*fail|malformed|unexpected token|Unterminated string/i.test(msg)) return 'json_parse'
  if (/schema|validation.*fail|does not match/i.test(msg)) return 'schema_mismatch'
  if (/circuit.*open|breaker/i.test(msg)) return 'circuit_open'
  if (/aborted|cancelled|signal/i.test(msg)) return 'caller_aborted'
  if (/claim.*conflict|claimed by/i.test(msg)) return 'claim_conflict'
  if (/crash|killed|signal|ECONNRESET/i.test(msg)) return 'worker_crash'
  return 'unknown'
}

function workerFailureResult(order: WorkOrder, error: unknown, opts?: { nextActions?: string[]; failureReason?: WorkerFailureReason }): WorkerResult {
  const reason = error instanceof Error ? error.message : String(error)
  const nextActions = opts?.nextActions ?? ['Primary should continue without trusting this worker result']
  const failureReason = opts?.failureReason ?? 'unknown'
  return {
    workOrderId: order.id,
    status: 'blocked',
    summary: `Worker ${failureReason === 'timeout' ? 'timed out' : 'failed'}: ${reason}`,
    findings: [],
    artifacts: [{ kind: 'risk', title: `Worker execution ${failureReason === 'timeout' ? 'timed out' : 'failed'}`, content: reason }],
    changedFiles: [],
    risks: [`worker ${failureReason === 'timeout' ? 'timed out' : 'failed'}: ${reason}`],
    nextActions,
    evidenceStatus: 'blocked',
    failureReason,
  }
}

/**
 * A3: a task whose dependency failed (or never completed) must be reported as
 * `blocked`, not silently dropped. Without this, `delegateBatch` returns
 * "completed" while dependents of a failed worker vanish from `run.results` —
 * the primary never learns the sub-tree was abandoned.
 */
function blockedDependencyResult(order: WorkOrder, unmetDeps: string[], failedDeps: string[]): WorkerResult {
  const detail = failedDeps.length > 0
    ? `dependency failed: ${failedDeps.join(', ')}`
    : `dependency never completed: ${unmetDeps.join(', ')}`
  return {
    workOrderId: order.id,
    status: 'blocked',
    summary: `Task blocked — ${detail}`,
    findings: [],
    artifacts: [{ kind: 'risk', title: 'Dependency unmet', content: detail }],
    changedFiles: [],
    risks: [`blocked by unmet dependency: ${detail}`],
    nextActions: ['Re-dispatch this task after its dependency succeeds, or drop the dependency'],
    evidenceStatus: 'blocked',
  }
}

/** Cap on persisted worker-result files under ~/.rivet/subagents/. Without a
 *  TTL/cap this write-mostly sink grew unbounded (one+ file per worker, forever). */
export const MAX_SUBAGENT_RESULTS = 500

/** Minimum acceptable summary length. When a worker's summary is shorter, the
 *  coordinator auto-triggers a follow-up expansion turn so the parent agent
 *  receives a technically complete handoff. */
export const SUMMARY_MIN_LENGTH = 200
/** Max follow-up attempts for brief summaries. 1 = single retry, then accept. */
export const SUMMARY_CONTINUATION_ATTEMPTS = 1

/** LRU-evict ~/.rivet/subagents/ down to `limit` files (oldest mtime first).
 *  Best-effort and exported for testing. Returns the basenames evicted. */
export function evictOldSubagentResults(dir: string, limit = MAX_SUBAGENT_RESULTS): string[] {
  let files: string[]
  try {
    files = readdirSync(dir).filter(f => f.endsWith('.json'))
  } catch {
    return []
  }
  if (files.length <= limit) return []
  const withMtime = files.map(f => {
    let mtime = 0
    try { mtime = statSync(join(dir, f)).mtimeMs } catch { /* ignore */ }
    return { f, mtime }
  })
  withMtime.sort((a, b) => a.mtime - b.mtime)
  const toEvict = withMtime.slice(0, files.length - limit).map(({ f }) => f)
  for (const f of toEvict) {
    try { unlinkSync(join(dir, f)) } catch { /* ignore */ }
  }
  return toEvict
}

/** Persist worker result to ~/.rivet/subagents/<orderId>.json for future resume/inspection. */
function persistWorkerResult(result: WorkerResult, fingerprint?: string): void {
  try {
    const dir = subagentsDir()
    mkdirSync(dir, { recursive: true })
    const json = JSON.stringify(result, null, 2)
    writeFileSync(join(dir, `${result.workOrderId}.json`), json, 'utf-8')
    // T5: also write a fingerprint-indexed copy for resume lookup
    if (fingerprint) {
      writeFileSync(join(dir, `${fingerprint}.json`), json, 'utf-8')
    }
    // Keep the sink bounded — LRU-evict once it exceeds the cap.
    evictOldSubagentResults(dir)
  } catch {
    // Best-effort: never block primary session on persistence failure
  }
}

/** B1: read back a previously persisted worker result for resume/inspection.
 *  The persistWorkerResult sink used to have no reader (write-only grave).
 *  Returns null on cold miss or unparseable content — callers must handle it. */
function coordinatorSubagentsDir(homeDir?: string): string {
  // `homeDir` is the legacy "user home" parameter used by tests.
  // In production, default to the unified subagentsDir() under RIVET_HOME.
  if (homeDir) return join(homeDir, '.rivet', 'subagents')
  return subagentsDir()
}

export function loadPersistedResult(orderId: string, homeDir?: string): WorkerResult | null {
  try {
    const path = join(coordinatorSubagentsDir(homeDir), `${orderId}.json`)
    if (!existsSync(path)) return null
    return parseWorkerResult(readFileSync(path, 'utf-8'), orderId)
  } catch {
    return null
  }
}

/** T5: fingerprint a delegation request for result reuse. */
function fingerprintRequest(objective: string, files: string[] | undefined, profile: string): string {
  const key = `${objective}|${(files ?? []).sort().join(',')}|${profile}`
  return createHash('sha256').update(key).digest('hex').slice(0, 16)
}

/** T5: scan ~/.rivet/subagents/ for a matching completed result within the last hour. */
function tryResumeWorkerResult(
  objective: string,
  files: string[] | undefined,
  profile: string,
  nowMs: number,
  homeDir?: string,
): WorkerResult | null {
  const fp = fingerprintRequest(objective, files, profile)
  const path = join(coordinatorSubagentsDir(homeDir), `${fp}.json`)
  if (!existsSync(path)) return null
  try {
    const stat = statSync(path)
    if (nowMs - stat.mtimeMs > 3_600_000) return null
    const result = parseWorkerResult(readFileSync(path, 'utf-8'), fp)
    if (result && result.status === 'passed') {
      return { ...result, summary: `[resumed] ${result.summary}` }
    }
  } catch {
    // Corrupt file — skip
  }
  return null
}

/** B3: max delegation nesting depth — primary(0) → worker(1) → grand-worker(2 ✗).
 *  Aligned with Cursor's "nested but gated" stance rather than Claude's full ban:
 *  planner profiles legitimately think-then-delegate, but unbounded recursion
 *  must be impossible. */
export const MAX_DELEGATION_DEPTH = 2

/** B2: background (async) work order handle — Cursor `is_background` analog.
 *  The parent is NOT blocked; results are collected later by id (and are also
 *  persisted to ~/.rivet/subagents/ by the normal dispatch path). */
export interface BackgroundRunHandle {
  id: string
  objective: string
  startedAt: number
  status: 'running' | 'completed' | 'failed'
  run?: CoordinatorRun
  error?: string
}

export class DelegationCoordinator {
  private runWorker: (config: WorkerSessionConfig) => Promise<WorkerSessionRun>
  private runHands: (config: HandsSessionConfig) => Promise<HandsSessionRun>
  private state: CoordinatorState
  private collaboration: CollaborationProtocol | null
  /** A4: per-worker silence clocks — the runtime primary gate. */
  private readonly liveness: WorkerLiveness
  /** A4: per-order controllers so a stall sweep aborts only the wedged worker. */
  private readonly orderControllers = new Map<string, AbortController>()
  /** T9 P3: per-order real-time activity upstream (request callback survives
   *  the zod request→order conversion via this side table). */
  private readonly activityUpstream = new Map<string, (event: WorkerActivityEvent) => void>()
  /** Per-order prior messages for session resume. Set by delegate() when
   *  resumeWorkOrderId is provided; consumed by delegateOrder() when building
   *  the worker config. Side-table pattern (same as activityUpstream). */
  private readonly resumeMessages = new Map<string, readonly OaiMessage[]>()
  private stallSweep: ReturnType<typeof setInterval> | null = null
  /** T3: Flash→Pro escalation counter per session. Max 3 Pro upgrades. */
  private proUpgradeCount = 0
  private static readonly MAX_PRO_UPGRADES = 3
  /** Per-profile circuit breaker for fast-failing repeatedly broken profiles. */
  readonly circuitBreaker: CircuitBreakerManager
  /** Structured mailbox for inter-agent communication within a delegation wave. */
  readonly mailbox: WorkerMailbox

  constructor(private config: DelegationCoordinatorConfig) {
    this.runWorker = config.runWorker ?? runWorkerSession
    this.runHands = config.runHands ?? runHandsSession
    this.state = new CoordinatorState(config.maxWorkers)
    this.collaboration = config.collaboration ? new CollaborationProtocol(config.collaboration) : null
    this.liveness = new WorkerLiveness({
      stallMs: config.workerStallMs ?? EXPLORE_STALL_MS,
      now: config.livenessClock,
    })
    this.circuitBreaker = config.circuitBreaker ?? new CircuitBreakerManager()
    this.mailbox = new InMemoryMailbox()
  }

  /** Artifact session id used by a worker for its own ArtifactStore. */
  private workerArtifactSessionId(orderId: string): string {
    return `worker-${orderId.replace(/:/g, '-')}`
  }

  /** Make worker-produced artifacts resolvable from the primary session store. */
  private registerWorkerArtifacts(orderId: string): void {
    this.config.artifactStore?.addFallbackSession(this.workerArtifactSessionId(orderId))
  }

  /** Lazily start the stall sweep; stop it when no workers are in flight. */
  private ensureStallSweep(): void {
    if (this.stallSweep) return
    const stallMs = this.config.workerStallMs ?? EXPLORE_STALL_MS
    const intervalMs = Math.min(Math.max(Math.floor(stallMs / 2), 50), 15_000)
    const sweep = setInterval(() => {
      for (const id of this.liveness.stalled()) {
        // Abort ONLY the wedged worker — its processNext falls to catch →
        // workerFailureResult; Promise.all(inflight) is unaffected.
        this.orderControllers.get(id)?.abort()
        this.liveness.unregister(id)
      }
      if (this.liveness.size() === 0) this.stopStallSweep()
    }, intervalMs)
    sweep.unref() // never keep the process alive
    this.stallSweep = sweep
  }

  private stopStallSweep(): void {
    if (this.stallSweep) {
      clearInterval(this.stallSweep)
      this.stallSweep = null
    }
  }

  /**
   * 释放进程级资源：用于丢弃 coordinator 时（典型场景是 sidecar
   * switchModel 重建装配栈）。调用后实例不得复用。
   *
   * 副作用：
   * - clearInterval(stallSweep)——`.unref()` 已防止其阻塞进程退出，但
   *   sidecar 长驻进程频繁 switchModel 会累积泄漏的 timer。
   * - abort 所有在途 orderControllers——worker 的 processNext 走 catch
   *   → workerFailureResult 路径，消费者收到 degraded run。
   * - 清空 orderControllers / activityUpstream / backgroundRuns / backgroundPromises
   *   引用，便于 GC 立刻回收（不主动 reject promise，让 worker 自然结算）。
   *
   * 不清理 mailbox / circuitBreaker / collaboration——它们不持有 timer/进程级资源。
   */
  shutdown(): void {
    this.stopStallSweep()
    for (const controller of this.orderControllers.values()) {
      try { controller.abort() } catch { /* ignore */ }
    }
    this.orderControllers.clear()
    this.activityUpstream.clear()
    this.resumeMessages.clear()
    this.backgroundRuns.clear()
    this.backgroundPromises.clear()
  }

  // ── B2: background (async) work orders ──

  private readonly backgroundRuns = new Map<string, BackgroundRunHandle>()
  private readonly backgroundPromises = new Map<string, Promise<CoordinatorRun>>()

  /** Dispatch a worker WITHOUT blocking the caller. Returns a handle id —
   *  poll with getBackgroundRun() or await with waitBackgroundRun(). */
  delegateBackground(request: DelegationRequest, abortSignal?: AbortSignal): string {
    const id = `bg_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
    const handle: BackgroundRunHandle = {
      id,
      objective: request.objective,
      startedAt: Date.now(),
      status: 'running',
    }
    this.backgroundRuns.set(id, handle)
    const promise = this.delegate(request, abortSignal).then(
      (run) => {
        // T3 alignment: delegate() now converts worker exceptions into degraded
        // completed results (Flash→Pro escalation). Detect degraded runs so the
        // background handle still reflects failure for waitBackgroundRun() callers.
        const resultStatus = run.results[0]?.status
        if (run.status === 'completed' && resultStatus && resultStatus !== 'passed') {
          const reason = run.results[0]?.summary ?? `Worker returned ${resultStatus}`
          handle.status = 'failed'
          handle.error = reason
          handle.run = run
          throw new Error(reason)
        }
        handle.status = 'completed'
        handle.run = run
        return run
      },
      (error: unknown) => {
        handle.status = 'failed'
        handle.error = error instanceof Error ? error.message : String(error)
        throw error
      },
    )
    // Swallow unhandled rejection — the error is captured on the handle and
    // re-surfaces when the caller awaits waitBackgroundRun().
    promise.catch(() => {})
    this.backgroundPromises.set(id, promise)
    return id
  }

  /** Non-blocking status check for a background run. */
  getBackgroundRun(id: string): BackgroundRunHandle | undefined {
    return this.backgroundRuns.get(id)
  }

  /** Await a background run's completion (rethrows its failure). */
  async waitBackgroundRun(id: string): Promise<CoordinatorRun> {
    const p = this.backgroundPromises.get(id)
    if (!p) throw new Error(`Unknown background run: ${id}`)
    return p
  }

  /** All background handles, newest first. */
  listBackgroundRuns(): BackgroundRunHandle[] {
    return [...this.backgroundRuns.values()].sort((a, b) => b.startedAt - a.startedAt)
  }

  getState(): CoordinatorState {
    return this.state
  }

  /** Resolve a capability card for an explicit model override. Prefers an
   *  existing card (same model in the primary provider) so tier/telemetry stay
   *  accurate; otherwise clones a base card's quality numbers and swaps the
   *  model name — the override model may live in a different provider not present
   *  in modelCards. The real provider/client is resolved by runtimeFactory. */
  private cardForModelOverride(model: string): ModelCapabilityCard {
    const existing = this.config.modelCards.find(c => c.model === model)
    if (existing) return existing
    const base = this.config.modelCards[0]
    if (base) return { ...base, model }
    return {
      model,
      toolUseReliability: 0.8,
      jsonStability: 0.8,
      editSuccessRate: 0.7,
      testRepairRate: 0.6,
      contextWindow: 128_000,
      cacheEconomics: 'strong',
      recommendedTasks: ['code_edit', 'risky_refactor', 'test_failure_diagnosis'],
    }
  }

  private selectModelForTask(task: CapabilityTask, preferredTier?: ModelTier, profile?: string): ModelCapabilityCard {
    // Review override fast path: when a profile-targeted override card is configured,
    // use it directly. Bypasses tier filtering + worker routing — review workers
    // get exactly the user-configured provider/model. Set up by bootstrap.ts from
    // config.agent.review.profiles. Skip when absent → fall through to normal flow.
    if (profile && this.config.reviewOverrideCards?.has(profile)) {
      const overrideCard = this.config.reviewOverrideCards.get(profile)!
      debugLog(`[worker-model] review-override: profile=${profile} → ${overrideCard.model} ✓`)
      return overrideCard
    }

    const eligibleCards = preferredTier
      ? this.config.modelCards.filter(card => inferModelTierFromCard(card) === preferredTier)
      : this.config.modelCards
    const cards = eligibleCards.length > 0 ? eligibleCards : this.config.modelCards

    if (this.config.routing) {
      const routeName = this.config.routing.routing[task]
      if (routeName && this.config.routing.profiles[routeName]) {
        const routeProfile = this.config.routing.profiles[routeName]

        // Physarum routing: skip cold-tier providers
        const skipCold = this.config.providerHealth?.getWeights()
          .find(h => h.providerId === routeProfile.provider && h.tier === 'cold')
        if (!skipCold) {
          const provider = this.config.routing.providers?.[routeProfile.provider]
          const routeModelExists = !provider || provider.models.some(m => m.id === routeProfile.model || m.alias === routeProfile.model)
          const routeHasCredentials = !provider || provider.auth?.type === 'oauth' || Boolean(provider.apiKey || (provider.apiKeyEnv && process.env[provider.apiKeyEnv]))
          if (routeModelExists && routeHasCredentials) {
            const routed = cards.find(c => c.model === routeProfile.model)
            if (routed) {
              debugLog(`[worker-model] routing: task=${task} → ${routeName} → ${routeProfile.provider}/${routeProfile.model} ✓`)
              return routed
            }
            debugLog(`[worker-model] routing: task=${task} → ${routeName} → ${routeProfile.model} NOT in cards=[${cards.map(c => c.model).join(',')}]`)
          } else {
            debugLog(`[worker-model] routing: task=${task} → ${routeName} skipped (modelExists=${routeModelExists} creds=${routeHasCredentials})`)
          }
        } else {
          debugLog(`[worker-model] routing: task=${task} → ${routeName} skipped (provider ${routeProfile.provider} is cold)`)
        }
      }
    }
    // Track 1: EFE × provider-health routing — consulted after explicit user
    // routing (user intent wins) but before the static capability heuristic.
    const efeChoice = this.selectModelByEFE(task, cards)
    if (efeChoice) {
      debugLog(`[worker-model] efe-routing: task=${task} → ${efeChoice.model}`)
      return efeChoice
    }

    const fallback = recommendModelForTask(task, cards)
    debugLog(`[worker-model] fallback: task=${task} → ${fallback.model} (routing=${this.config.routing ? 'configured' : 'none'})`)
    return fallback
  }

  /**
   * EFE model selection over the candidate cards, re-ranked by Physarum
   * provider health: cold-tier providers are excluded, degraded providers pay
   * an EFE penalty proportional to lost weight. Every evaluation emits a
   * gated-influence audit event; dispatch is only affected when
   * `efeRouting.enabled` is true (shadow→gated pattern).
   */
  private selectModelByEFE(task: CapabilityTask, cards: ModelCapabilityCard[]): ModelCapabilityCard | undefined {
    const cfg = this.config.efeRouting
    if (!cfg) return undefined

    let signals: EFERoutingSignals | undefined
    try {
      signals = cfg.getSignals()
    } catch {
      return undefined
    }
    if (!signals) return undefined

    const weights = this.config.providerHealth?.getWeights() ?? []
    const healthFor = (model: string) => {
      const providerId = this.providerIdForModel(model)
      if (!providerId) return undefined
      return weights.find(h => h.providerId === providerId)
    }

    const warmOrHot = cards.filter(card => healthFor(card.model)?.tier !== 'cold')
    const pool = warmOrHot.length > 0 ? warmOrHot : cards

    let best: { model: string; expectedFreeEnergy: number; adjustedG: number } | undefined
    try {
      const historicalRewards = buildHistoricalModelRewards(this.config.modelTierShadowStore)
      const ranked = selectModelPolicy({
        candidates: buildModelPolicyCandidates(pool, { historicalRewards }),
        efe: signals.efe,
        sensorium: signals.sensorium,
      })
      if (ranked.length === 0) return undefined

      const adjusted = ranked
        .map(sel => {
          const h = healthFor(sel.model)
          const penalty = h ? 0.25 * (1 - h.weight) : 0
          return { model: sel.model, expectedFreeEnergy: sel.expectedFreeEnergy, adjustedG: sel.expectedFreeEnergy + penalty }
        })
        .sort((a, b) => a.adjustedG - b.adjustedG || a.model.localeCompare(b.model))
      best = adjusted[0]!
    } catch {
      return undefined
    }

    const applied = cfg.enabled
    persistGatedInfluenceAudit(
      this.config.gatedInfluenceAuditStore ?? this.config.modelTierShadowStore,
      buildGatedInfluenceAuditEvent({
        source: 'model_routing',
        sessionId: this.config.sessionId ?? 'unknown',
        targetId: `efe_routing:${task}`,
        gateOpen: cfg.enabled,
        applied,
        reason: applied
          ? `EFE routing selected ${best.model} (G=${best.expectedFreeEnergy}, health-adjusted=${best.adjustedG})`
          : 'shadow only — efeRouting.enabled=false',
        evidenceWindow: {
          task,
          selectedModel: best.model,
          expectedFreeEnergy: best.expectedFreeEnergy,
          healthAdjustedG: best.adjustedG,
          candidateCount: pool.length,
          coldExcluded: cards.length - pool.length,
        },
      }),
    )

    if (!applied) return undefined
    return cards.find(c => c.model === best.model)
  }

  /** Resolve which routing provider serves a given model id (or alias). */
  private providerIdForModel(modelId: string): string | undefined {
    const providers = this.config.routing?.providers
    if (!providers) return undefined
    for (const [id, prov] of Object.entries(providers)) {
      if (prov.models.some(m => m.id === modelId || m.alias === modelId)) return id
    }
    return undefined
  }

  /** Feed worker run outcomes into the Physarum provider health tracker.
   *  Only API/runtime-level outcomes count — a worker that completes with a
   *  failed task verdict still proves the provider is healthy. */
  private recordProviderOutcome(modelId: string, ok: boolean): void {
    const health = this.config.providerHealth
    if (!health) return
    const providerId = this.providerIdForModel(modelId)
    if (!providerId) return
    health.registerProvider(providerId)
    if (ok) health.recordSuccess(providerId)
    else health.recordFailure(providerId)
  }

  /** Attach runtime model/provider/usage metadata to a worker result so that
   *  downstream insights panels can render per-delegation costs and routing. */
  private enrichResult(
    result: WorkerResult,
    model: string,
    provider: string | undefined,
    usage?: Usage | Partial<Usage>,
  ): WorkerResult {
    return {
      ...result,
      model: result.model ?? model,
      provider: result.provider ?? provider,
      usage: result.usage ?? (usage ? {
        input_tokens: usage.input_tokens,
        output_tokens: usage.output_tokens,
        cache_read_input_tokens: usage.cache_read_input_tokens,
        cache_creation_input_tokens: usage.cache_creation_input_tokens,
        reasoning_tokens: usage.reasoning_tokens,
        total_tokens: (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0),
      } : undefined),
    }
  }

  private buildTierRecommendation(order: WorkOrder): ModelTierRecommendation {
    return recommendModelTier({
      authority: order.authority,
      profile: order.profile,
      kind: order.kind,
      riskTier: order.riskTier,
      objective: order.objective,
      consecutiveFailures: this.state.getSummary().failed,
      ...(this.config.patcherTier ? { workerTierOverride: this.config.patcherTier } : {}),
    })
  }

  private buildTierShadow(order: WorkOrder, selected: ModelCapabilityCard, recommendation: ModelTierRecommendation): ModelTierShadowEvent {
    return buildModelTierShadowEvent({
      sessionId: this.config.sessionId ?? 'unknown',
      workOrderId: order.id,
      authority: order.authority,
      profile: order.profile,
      kind: order.kind,
      recommendedTier: recommendation.tier,
      actualModel: selected.model,
      actualTier: inferModelTierFromCard(selected),
      reason: recommendation.reason,
    })
  }

  /** Record a Flash→Pro escalation event: increment quota, persist shadow, return event for caller's array. */
  private recordEscalation(order: WorkOrder, strongCard: ModelCapabilityCard, errorMsg: string): ModelTierShadowEvent {
    this.proUpgradeCount++
    const shadow = buildModelTierShadowEvent({
      sessionId: this.config.sessionId ?? 'unknown',
      workOrderId: order.id,
      authority: order.authority,
      profile: order.profile,
      kind: order.kind,
      recommendedTier: 'strong',
      actualModel: strongCard.model,
      actualTier: 'strong',
      reason: `Flash→Pro 升级重试 #${this.proUpgradeCount}: 上次尝试失败 "${errorMsg.slice(0, 200)}"`,
    })
    persistModelTierShadow(this.config.modelTierShadowStore, shadow)
    return shadow
  }

  private evaluateTierInfluence(recommendation: ModelTierRecommendation): { candidate: ModelTierBanditRecommendation; gate: ModelTierGateDecision } {
    const state = buildHistoricalModelTierState(this.config.modelTierShadowStore)
    const candidate = recommendModelTierArm(state)
    const gate = evaluateModelTierGate({
      state,
      candidateArm: candidate.arm,
      ruleRecommendation: recommendation,
      recentFalseGreenRate: state.recentFalseGreenRate,
      scopeHealthSeverity: state.worstScopeHealthSeverity,
      featureFlagEnabled: this.config.modelTierBanditEnabled === true,
    })
    return { candidate, gate }
  }

  /** Drain mailbox into run packet and clear. Called after every wave (batch or single). */
  private async drainMailboxIntoRun(run: CoordinatorRun): Promise<CoordinatorRun> {
    const findings = this.mailbox.byType('finding')
    const escalations = this.mailbox.byType('escalation')
    const notes: string[] = []
    for (const f of findings) notes.push(`📬 ${f.from}: ${f.payload.summary}`)
    for (const e of escalations) notes.push(`🚨 ${e.from}: ${e.payload.summary}`)
    this.mailbox.clear()
    if (notes.length === 0) return run
    return { ...run, packet: `${run.packet}\n\nMailbox:\n${notes.join('\n')}` }
  }

  async delegate(request: DelegationRequest, abortSignal?: AbortSignal): Promise<CoordinatorRun> {
    // Per-call abort signal override — allows the tool pipeline to propagate
    // its timeout signal to the coordinator without mutating config.
    const savedSignal = this.config.abortSignal
    if (abortSignal) this.config.abortSignal = abortSignal
    try {
      // B3: hard depth cap — nesting allowed (planner workers think-then-
      // delegate) but bounded. Reject, don't throw: the requesting worker
      // gets a structured blocked result it can act on.
      const depth = request.delegationDepth ?? 0
      const depthCap = this.config.maxDelegationDepth ?? MAX_DELEGATION_DEPTH
      if (depth >= depthCap) {
        return {
          status: 'completed',
          results: [{
            workOrderId: `depth-capped-${request.parentTurnId}`,
            status: 'blocked',
            summary: `Delegation rejected: max delegation depth (${depthCap}) reached — do the work inline instead of delegating further`,
            findings: [],
            artifacts: [],
            changedFiles: [],
            risks: ['unbounded delegation recursion prevented'],
            nextActions: ['Perform the objective directly in this worker session'],
            evidenceStatus: 'blocked',
          }],
          packet: await buildPrimaryWorkerPacket([], this.config.artifactStore),
        }
      }

      if (!shouldDelegateObjective(request.objective, request.scope)) {
        return {
          status: 'skipped',
          results: [],
          packet: await buildPrimaryWorkerPacket([], this.config.artifactStore),
        }
      }

      // Circuit breaker: fast-fail tier-locked profiles (Flash army) that are tripped.
      // Non-locked profiles use Flash→Pro escalation as their resilience mechanism.
      const profileDef = profileRegistry.get(request.profile)
      if (profileDef?.tierLock) {
        const circuitCheck = this.circuitBreaker.canDelegate(request.profile)
        if (!circuitCheck.allowed) {
          return {
            status: 'completed',
            results: [{
              workOrderId: `circuit-open-${request.parentTurnId}`,
              status: 'blocked',
              summary: `Circuit breaker open: ${circuitCheck.reason}`,
              findings: [],
              artifacts: [{ kind: 'risk', title: 'Circuit breaker tripped', content: circuitCheck.reason ?? 'Profile circuit is open' }],
              changedFiles: [],
              risks: [`circuit breaker: ${request.profile} is open`],
              nextActions: ['Wait for cooldown or use a different profile'],
              evidenceStatus: 'blocked',
            }],
            packet: await buildPrimaryWorkerPacket([], this.config.artifactStore),
          }
        }
      }

      // T5: fingerprint-based resume — only read-only profiles can resume; write results are never safe to replay
      const _isWrite = classifyProfile(request.profile) === 'hands'
      const resumeHit = !_isWrite && this.config.resumeEnabled === true
        ? tryResumeWorkerResult(request.objective, request.scope.files, request.profile, Date.now())
        : null
      if (resumeHit) {
        return {
          status: 'completed',
          selectedModel: '[resumed]',
          modelTierShadows: [],
          modelTierGatedDecisions: [],
          gatedInfluenceAudits: [],
          results: [resumeHit],
          packet: await buildPrimaryWorkerPacket([resumeHit], this.config.artifactStore),
        }
      }

      const isWrite = classifyProfile(request.profile) === 'hands'
      const stableId = deriveStableWorkOrderId(request.parentTurnId)
      const order = isWrite
        ? createWriteWorkOrder({
            id: stableId,
            parentTurnId: request.parentTurnId,
            kind: request.kind,
            profile: request.profile,
            objective: request.objective,
            scope: request.scope,
            reviewDepth: request.reviewDepth,
            delegationDepth: (request.delegationDepth ?? 0) + 1,
            dependencies: request.dependencies,
            authority: request.authority,
            riskTier: request.riskTier,
            sessionTurn: request.sessionTurn,
            budget: request.budget,
            modelOverride: request.modelOverride,
          })
        : createReadOnlyWorkOrder({
            id: stableId,
            parentTurnId: request.parentTurnId,
            kind: request.kind,
            profile: request.profile,
            objective: request.objective,
            scope: request.scope,
            reviewDepth: request.reviewDepth,
            delegationDepth: (request.delegationDepth ?? 0) + 1,
            dependencies: request.dependencies,
            authority: request.authority,
            riskTier: request.riskTier,
            sessionTurn: request.sessionTurn,
            modelOverride: request.modelOverride,
            budget: request.budget,
          })

      // T9 P3: callbacks don't survive zod parsing — stash by order id.
      if (request.onActivity) this.activityUpstream.set(order.id, request.onActivity)
      // Session resume: load prior messages from disk so the worker continues
      // from its previous context. Degrades to a fresh worker if no history.
      if (request.resumeWorkOrderId) {
        const record = loadWorkerSession(request.resumeWorkOrderId)
        if (record) {
          this.resumeMessages.set(order.id, record.messages)
          debugLog(`[worker-resume] loaded ${record.messages.length} messages from ${request.resumeWorkOrderId} for ${order.id}`)
        } else {
          debugLog(`[worker-resume] no prior session for ${request.resumeWorkOrderId} — starting fresh`)
        }
      }
      const run = await this.delegateOrder(order)
      return this.drainMailboxIntoRun(run)
    } finally {
      this.config.abortSignal = savedSignal
    }
  }

  /**
   * Summary quality gate: when the worker returns a brief summary, trigger a
   * follow-up expansion turn so the parent agent receives a technically complete
   * handoff. The expansion reuses the worker's session messages as priorMessages
   * so it continues from the same context. Returns the (possibly expanded) result
   * and updated sessionMessages.
   */
  private async maybeExpandSummary(
    order: WorkOrder,
    workerConfig: WorkerSessionConfig,
    mergedSignal: AbortSignal,
    currentResult: WorkerResult,
    sessionMessages: readonly OaiMessage[],
  ): Promise<{ result: WorkerResult; sessionMessages: readonly OaiMessage[] }> {
    let result = currentResult
    let messages = sessionMessages

    for (let attempt = 0; attempt < SUMMARY_CONTINUATION_ATTEMPTS; attempt++) {
      if (result.summary.length >= SUMMARY_MIN_LENGTH) break
      // Only expand passed results — blocked/failed results are inherently terse
      if (result.status !== 'passed') break

      const expansionOrder: WorkOrder = {
        ...order,
        objective: `Your previous summary was too brief (${result.summary.length} chars). Expand it to at least ${SUMMARY_MIN_LENGTH} characters. Include: what you found, what you changed, what remains open. Previous summary: "${result.summary}"`,
      }
      const expansionConfig: WorkerSessionConfig = {
        ...workerConfig,
        order: expansionOrder,
        priorMessages: messages,
      }
      try {
        const expansionRun = await this.runWorker(expansionConfig)
        const expandedResult = expansionRun.result
        // Only accept the expansion if it's actually longer
        if (expandedResult.summary.length > result.summary.length) {
          result = expandedResult
          messages = expansionRun.session.getMessages()
        }
      } catch {
        // Expansion failure is not critical — keep the original result
        break
      }
    }

    return { result, sessionMessages: messages }
  }

  private async delegateOrder(order: WorkOrder): Promise<CoordinatorRun> {
    // Abort guard: if the caller's abort signal fires (e.g. tool-level timeout),
    // reject immediately instead of waiting for the worker's internal 180s timeout.
    // This prevents zombie workers from blocking the main agent loop.
    if (this.config.abortSignal?.aborted) {
      return {
        status: 'completed',
        order,
        results: [workerFailureResult(order, new Error('Delegation aborted: caller signal fired'), { failureReason: 'caller_aborted' })],
        packet: await buildPrimaryWorkerPacket([], this.config.artifactStore),
      }
    }

    const role = classifyProfile(order.profile)
    const isWrite = role === 'hands'
    this.state.recordEvent({ type: 'queued', workOrderId: order.id, timestamp: Date.now() })

    const task = mapWorkOrderKindToCapabilityTask(order.kind)

    // Scope budget check for exploration workers (code_search, doc_research, plan)
    if (order.kind === 'code_search' || order.kind === 'doc_research' || order.kind === 'plan') {
      if (order.scope.maxFiles !== undefined && (order.scope.files?.length ?? 0) > order.scope.maxFiles) {
        return {
          status: 'completed',
          order,
          results: [{
            workOrderId: order.id,
            status: 'blocked',
            summary: `Scope budget exceeded: ${order.scope.files!.length} files exceeds maxFiles=${order.scope.maxFiles}`,
            findings: [],
            artifacts: [{ kind: 'risk', title: 'Scope budget exceeded', content: `Requested ${order.scope.files!.length} files but maxFiles=${order.scope.maxFiles}` }],
            changedFiles: [],
            risks: [`scope budget: ${order.scope.files!.length} > ${order.scope.maxFiles} maxFiles`],
            nextActions: ['Reduce file scope or increase maxFiles budget'],
            evidenceStatus: 'blocked',
          }],
          packet: await buildPrimaryWorkerPacket([], this.config.artifactStore),
        }
      }
    }

    const tierRecommendation = this.buildTierRecommendation(order)
    const tierInfluence = this.evaluateTierInfluence(tierRecommendation)
    const preferredTier = tierInfluence.gate.applied
      ? tierInfluence.gate.effectiveTier
      : tierRecommendation.tier
    // Per-order modelOverride wins over all routing (review override, workers
    // routing, EFE, tier). The card is mostly telemetry/reporting (the real
    // client is built by runtimeFactory from order.modelOverride); synthesize
    // one when the override model isn't in the primary provider's cards.
    let selected = order.modelOverride
      ? this.cardForModelOverride(order.modelOverride.model)
      : this.selectModelForTask(task, preferredTier, order.profile)
    const selectedTier = inferModelTierFromCard(selected)
    const tierShadow = this.buildTierShadow(order, selected, tierRecommendation)
    const tierGatedDecision = buildModelTierGatedDecisionEvent({
      sessionId: this.config.sessionId ?? 'unknown',
      workOrderId: order.id,
      authority: order.authority,
      profile: order.profile,
      kind: order.kind,
      ruleTier: tierRecommendation.tier,
      candidateTier: tierInfluence.candidate.tier,
      applied: tierInfluence.gate.applied,
      gateOpen: tierInfluence.gate.gateOpen,
      reason: `${tierInfluence.gate.reason}; ${tierInfluence.candidate.reason}`,
      selectedModel: selected.model,
      selectedTier,
    })
    const gatedInfluenceAudit = buildGatedInfluenceAuditEvent({
      source: 'model_tier_bandit',
      sessionId: this.config.sessionId ?? 'unknown',
      targetId: order.id,
      gateOpen: tierInfluence.gate.gateOpen,
      applied: tierInfluence.gate.applied,
      reason: tierInfluence.gate.reason,
      evidenceWindow: {
        ...tierInfluence.gate.evidenceWindow,
        candidateConfidence: tierInfluence.candidate.confidence,
        candidateScore: tierInfluence.candidate.score,
        selectedTier,
      },
      vetoSignals: tierInfluence.gate.vetoSignals,
    })
    persistModelTierShadow(this.config.modelTierShadowStore, tierShadow)
    persistModelTierGatedDecision(this.config.modelTierShadowStore, tierGatedDecision)
    persistGatedInfluenceAudit(this.config.gatedInfluenceAuditStore ?? this.config.modelTierShadowStore, gatedInfluenceAudit)
    // Use the work order's allowedTools (from ProfileRegistry) instead of hardcoded sets.
    // A profile may allowlist a tool that isn't registered in THIS session — gated
    // tools (web_search), MCP tools, or a host-trimmed registry. filterToolRegistry
    // is fail-closed and throws on any unknown name, which would kill the whole
    // worker over one missing tool. Degrade gracefully instead: keep the tools that
    // exist, drop the absent ones (with a warning), so the worker still runs.
    const presentTools = order.allowedTools.filter(name => this.config.baseToolRegistry.has(name))
    const missingTools = order.allowedTools.filter(name => !this.config.baseToolRegistry.has(name))
    if (missingTools.length > 0) {
      debugLog(`[worker-tools] order ${order.id} (${order.profile}): dropping ${missingTools.length} unregistered tool(s) [${missingTools.join(', ')}] — not in base registry this session`)
    }
    const workerRegistry = filterToolRegistry(this.config.baseToolRegistry, presentTools)
    const workerConfig = this.config.runtimeFactory(order, selected, workerRegistry)
    // R3.1: the runtime factory returns a generic default maxTurns; clamp it to
    // the work order's per-profile budget so caps like reviewer=6 actually bite.
    // Covers both read (runWorker) and write (runHands → runWorker) paths.
    workerConfig.maxTurns = clampWorkerMaxTurns(workerConfig.maxTurns, order.budget.maxTurns)
    workerConfig.reviewDepth = order.reviewDepth
    workerConfig.domainKnowledgeStore = this.config.domainKnowledgeStore
    workerConfig.mailbox = this.mailbox
    // Session resume: inject prior messages so the worker continues from its
    // previous context. Side-table pattern (same as activityUpstream).
    const priorMessages = this.resumeMessages.get(order.id)
    if (priorMessages && priorMessages.length > 0) {
      workerConfig.priorMessages = priorMessages
    }

    // A4: per-order AbortController merged with the parent signal — the stall
    // sweep can abort ONLY this worker without touching its batch siblings,
    // while a parent abort still kills everything.
    const parentSignal = this.config.abortSignal
    const orderController = new AbortController()
    const mergedSignal = parentSignal
      ? AbortSignal.any([parentSignal, orderController.signal])
      : orderController.signal
    // Propagate merged signal so worker stops immediately on abort
    // instead of waiting for its internal budget timeout (中间层 #1).
    workerConfig.abortSignal = mergedSignal
    // A2: worker liveness signal feeds the stall clock.
    // T9 P3: …and fans out to the per-request real-time upstream, so the
    // calling tool can stream live worker progress into the UI.
    const upstreamActivity = workerConfig.onActivity
    const requestUpstream = this.activityUpstream.get(order.id)
    workerConfig.onActivity = (kind, detail) => {
      this.liveness.tick(order.id)
      upstreamActivity?.(kind, detail)
      try {
        requestUpstream?.({ workOrderId: order.id, profile: order.profile, authority: order.authority, kind, detail })
      } catch { /* UI upstream must never break dispatch */ }
    }

    this.state.recordEvent({ type: 'running', workOrderId: order.id, timestamp: Date.now() })

    let run: { result: WorkerResult; transcript?: WorkerSessionRun['transcript']; sessionMessages?: readonly OaiMessage[]; usage?: Usage | Partial<Usage>; providerName?: string } | undefined

    // T3: escalation shadow events collected during retry
    const escalationShadows: ModelTierShadowEvent[] = []

    // Wrap worker execution with abort signal so the caller unblocks immediately
    // when the tool-level timeout fires, instead of waiting for the worker's
    // internal 180s timeout. The worker's own agent.abort() will fire from its
    // internal timer, but we don't block on it.
    //
    // IMPORTANT: wrapAbort guarantees listener cleanup. If the worker resolves
    // before the signal fires, the 'abort' listener is removed to prevent
    // accumulation across repeated delegate calls in a long session.
    const abortSignal = mergedSignal

    const wrapAbort = <T>(p: Promise<T>): Promise<T> => {
      if (!abortSignal) return p
      if (abortSignal.aborted) return Promise.reject(new Error('Delegation aborted: caller signal already fired'))

      return new Promise<T>((resolve, reject) => {
        const onAbort = () => {
          // Distinguish a stall-sweep abort (per-order controller fired, parent
          // did not) from a caller abort — stalls ARE provider-relevant faults.
          const stallAbort = orderController.signal.aborted && !parentSignal?.aborted
          reject(new Error(stallAbort
            ? `Worker ${order.id} stalled: silent past liveness tolerance — aborted by stall sweep`
            : 'Delegation aborted: caller signal fired'))
        }
        abortSignal.addEventListener('abort', onAbort, { once: true })

        p.then(
          (result) => {
            abortSignal.removeEventListener('abort', onAbort)
            resolve(result)
          },
          (err) => {
            abortSignal.removeEventListener('abort', onAbort)
            reject(err)
          },
        )
      })
    }

    let semanticLockAcquired = false
    // Acquire semantic lock via CollaborationProtocol only after all pre-dispatch
    // validation has passed. Otherwise early blocked returns (e.g. scope budget)
    // would need cleanup too and could leak fail-closed locks.
    if (this.collaboration && this.config.sessionId && order.scope.files?.length) {
      const intent: LockIntent = {
        operation: isWrite ? 'edit' : 'refactor',
        files: order.scope.files,
        description: order.objective,
      }
      const lockResult = this.collaboration.acquireLock(this.config.sessionId, intent)
      if (!lockResult.acquired) {
        return {
          status: 'completed',
          order,
          results: [{
            workOrderId: order.id,
            status: 'blocked',
            summary: `Semantic lock conflict: ${lockResult.conflictingFiles.join(', ')} held by another session`,
            findings: [],
            artifacts: [{ kind: 'risk', title: 'Lock conflict', content: `Files locked by another session: ${lockResult.conflictingFiles.join(', ')}` }],
            changedFiles: [],
            risks: [`semantic lock conflict: ${lockResult.conflictingFiles.join(', ')}`],
            nextActions: ['Wait for other session to release locks, or use non-overlapping file scope'],
            evidenceStatus: 'blocked',
          }],
          packet: await buildPrimaryWorkerPacket([], this.config.artifactStore),
        }
      }
      semanticLockAcquired = true
    }

    // A4: arm the stall clock only once dispatch is committed (all early
    // blocked returns above never register, so they can't leak entries).
    this.orderControllers.set(order.id, orderController)
    this.liveness.register(order.id, this.config.workerStallMs ?? (isWrite ? WRITE_STALL_MS : EXPLORE_STALL_MS))
    this.ensureStallSweep()

    try {
      if (role === 'hands') {
        const acquiredClaimFiles: string[] = []
        try {
          // Check file claims before dispatching write worker
          if (this.config.sessionRegistry && this.config.sessionId && order.scope.files?.length) {
            const registry = this.config.sessionRegistry
            const sid = this.config.sessionId
            const conflictedFiles: string[] = []
            for (const f of order.scope.files) {
              if (registry.acquireClaim(sid, f, 'exclusive')) {
                acquiredClaimFiles.push(f)
              } else {
                conflictedFiles.push(f)
              }
            }
            if (conflictedFiles.length > 0) {
              // P1-1: first claim conflict — preserve actionable nextActions for the primary model
              const degraded: WorkerResult = {
                workOrderId: order.id,
                status: 'blocked',
                summary: `文件声明冲突: ${conflictedFiles.join('、')} 被另一会话持有`,
                findings: [],
                artifacts: [{ kind: 'risk', title: '声明冲突', content: `以下文件被另一会话锁定: ${conflictedFiles.join('、')}` }],
                changedFiles: [],
                risks: [`声明冲突: ${conflictedFiles.join('、')}`],
                nextActions: ['等待其他会话释放声明后再重试', '或改用只读 profile 避免写冲突'],
                evidenceStatus: 'blocked',
              }
              return {
                status: 'completed',
                order,
                selectedModel: selected.model,
                modelTierShadows: [tierShadow],
                modelTierGatedDecisions: [tierGatedDecision],
                gatedInfluenceAudits: [gatedInfluenceAudit],
                results: [degraded],
                packet: await buildPrimaryWorkerPacket([degraded], this.config.artifactStore),
              }
            }
          }

          const activeClaims = this.config.activeClaims?.() ?? workerConfig.activeClaims ?? []
          const cwd = this.config.cwd ?? workerConfig.cwd
          // Capture session messages from the hands worker for resume persistence.
          let handsSessionMessages: readonly OaiMessage[] | undefined
          // Write workers (patcher/verifier) execute in an isolated git worktree.
          // Worktree lifecycle is managed by runHands → runHandsSession: create
          // before agent runs, collect diff after, cleanup on exit.
          // NOTE: The host agent framework (Claude Code etc.) may still sandbox
          // subagent write operations (edit_file/write_file/bash) even when Rivet
          // correctly provisions write tools and worktree isolation. This is a
          // host-layer constraint, not a Rivet work-order or worktree bug.
          // Register the worker's fallback session BEFORE runHands so any diff
          // persisted during the run is resolvable by the primary store, and hand
          // a worker-scoped store to runHands for persistence.
          this.registerWorkerArtifacts(order.id)
          const workerStore = this.config.artifactStore?.forSession(this.workerArtifactSessionId(order.id))
          const handsRun = await wrapAbort(this.runHands({
            order,
            wtCoordinator: new WorktreeCoordinator(cwd),
            cwd,
            sharedWorkspace: this.config.sharedWorktree,
            maxTurns: workerConfig.maxTurns,
            contextWindow: workerConfig.contextWindow,
            compact: workerConfig.compact,
            activeClaims,
            domainKnowledgeStore: this.config.domainKnowledgeStore,
            artifactStore: workerStore,
            runAgent: async (prompt, callbacks, workerCwd) => {
              const sessionRun = await this.runWorker({
                ...workerConfig,
                order,
                cwd: workerCwd,
                activeClaims,
                domainKnowledgeStore: this.config.domainKnowledgeStore,
              })
              if (typeof sessionRun.session?.getMessages === 'function') {
                handsSessionMessages = sessionRun.session.getMessages()
              }
              callbacks.onTurnComplete(sessionRun.usage, 1, true)
              return JSON.stringify(sessionRun.result)
            },
          }))
          run = { result: handsRun.result, sessionMessages: handsSessionMessages, usage: handsRun.usage, providerName: workerConfig.providerName }
        } finally {
          if (this.config.sessionRegistry && this.config.sessionId) {
            for (const file of acquiredClaimFiles) {
              this.config.sessionRegistry.releaseClaim(this.config.sessionId, file)
            }
          }
        }
      } else {
        const workerRun = await wrapAbort(this.runWorker(workerConfig))
        const sessionMessages = typeof workerRun.session?.getMessages === 'function'
          ? workerRun.session.getMessages()
          : undefined
        run = { result: workerRun.result, transcript: workerRun.transcript, sessionMessages, usage: workerRun.usage, providerName: workerConfig.providerName }
        this.registerWorkerArtifacts(order.id)
      }
    } catch (error) {
      // Physarum health: worker run threw (API/runtime fault, not task outcome).
      // Caller-initiated aborts are not the provider's fault — skip those.
      const msg = error instanceof Error ? error.message : String(error)
      const isAbort = (error instanceof Error && error.name === 'AbortError') || msg.includes('Delegation aborted')
      if (!isAbort) this.recordProviderOutcome(selected.model, false)

      // ── Exponential backoff retry (same-model) ──────────────────────
      // Transient errors (429, network blips) are not model-capability issues.
      // Retry with the same model before attempting Flash→Pro escalation.
      if (!isAbort && order.budget.maxRetries > 0 && !run) {
        const retrySleep = this.config.retrySleepFn ?? sleep
        for (let attempt = 1; attempt <= order.budget.maxRetries; attempt++) {
          const delay = Math.min(
            order.budget.retryBackoffMs * Math.pow(2, attempt - 1),
            order.budget.maxRetryBackoffMs,
          )
          try {
            await retrySleep(delay, mergedSignal)
          } catch {
            // sleep aborted — stop retrying, fall through to degraded return
            break
          }
          // Re-register liveness for the retry attempt
          this.liveness.register(order.id, this.config.workerStallMs ?? (isWrite ? WRITE_STALL_MS : EXPLORE_STALL_MS))
          this.orderControllers.set(order.id, orderController)
          try {
            if (role === 'hands') {
              const retryClaimFiles: string[] = []
              try {
                if (this.config.sessionRegistry && this.config.sessionId && order.scope.files?.length) {
                  const registry = this.config.sessionRegistry
                  const sid = this.config.sessionId
                  const conflicted: string[] = []
                  for (const f of order.scope.files) {
                    if (registry.acquireClaim(sid, f, 'exclusive')) retryClaimFiles.push(f)
                    else conflicted.push(f)
                  }
                  if (conflicted.length > 0) {
                    for (const f of retryClaimFiles) registry.releaseClaim(sid, f)
                    break // can't retry — claims blocked
                  }
                }
                const retryCwd = this.config.cwd ?? workerConfig.cwd
                let retryHandsMessages: readonly OaiMessage[] | undefined
                // Retry reuses the same order.id, so the fallback session is
                // already registered by the primary branch above. Re-derive the
                // worker-scoped store so retry diffs also persist (otherwise the
                // delegation diff review would silently miss retry/escalation paths).
                const retryWorkerStore = this.config.artifactStore?.forSession(this.workerArtifactSessionId(order.id))
                const retryHandsRun = await wrapAbort(this.runHands({
                  order,
                  wtCoordinator: new WorktreeCoordinator(retryCwd),
                  cwd: retryCwd,
                  sharedWorkspace: this.config.sharedWorktree,
                  maxTurns: workerConfig.maxTurns,
                  contextWindow: workerConfig.contextWindow,
                  compact: workerConfig.compact,
                  activeClaims: this.config.activeClaims?.() ?? workerConfig.activeClaims ?? [],
                  domainKnowledgeStore: this.config.domainKnowledgeStore,
                  artifactStore: retryWorkerStore,
                  runAgent: async (prompt, callbacks, workerCwd) => {
                    const sessionRun = await this.runWorker({
                      ...workerConfig,
                      order,
                      cwd: workerCwd,
                      activeClaims: workerConfig.activeClaims ?? [],
                      domainKnowledgeStore: this.config.domainKnowledgeStore,
                    })
                    if (typeof sessionRun.session?.getMessages === 'function') {
                      retryHandsMessages = sessionRun.session.getMessages()
                    }
                    callbacks.onTurnComplete(sessionRun.usage, 1, true)
                    return JSON.stringify(sessionRun.result)
                  },
                }))
                run = { result: retryHandsRun.result, sessionMessages: retryHandsMessages, usage: retryHandsRun.usage, providerName: workerConfig.providerName }
              } finally {
                if (this.config.sessionRegistry && this.config.sessionId) {
                  for (const f of retryClaimFiles) this.config.sessionRegistry.releaseClaim(this.config.sessionId, f)
                }
              }
            } else {
              const workerRun = await wrapAbort(this.runWorker(workerConfig))
              const sessionMessages = typeof workerRun.session?.getMessages === 'function'
                ? workerRun.session.getMessages()
                : undefined
              run = { result: workerRun.result, transcript: workerRun.transcript, sessionMessages, usage: workerRun.usage, providerName: workerConfig.providerName }
            }
            // Retry succeeded — record provider health and exit loop
            this.recordProviderOutcome(selected.model, true)
            if (profileRegistry.get(order.profile)?.tierLock) this.circuitBreaker.recordSuccess(order.profile)
            break
          } catch (retryError) {
            // This retry attempt failed — continue to next attempt (or fall through)
            const retryMsg = retryError instanceof Error ? retryError.message : String(retryError)
            const retryIsAbort = (retryError instanceof Error && retryError.name === 'AbortError') || retryMsg.includes('Delegation aborted')
            if (retryIsAbort) break // abort stops all retries
            if (attempt === order.budget.maxRetries) {
              // All same-model retries exhausted — fall through to Flash→Pro
            }
          } finally {
            this.liveness.unregister(order.id)
            this.orderControllers.delete(order.id)
          }
        }
      }

      // T3: Flash→Pro escalation — retry with strong-tier model if budget allows.
      // tierLock:'cheap' profiles (reviewer / adversarial_verifier) must NOT be
      // escalated: review workers are deliberately pinned to a cheap/isolated
      // model so they don't evict the main session's prefix cache (see
      // .rivet/knowledge/debug-glm-cache-break-deliver-task.md). Honor the lock.
      const flashTier = inferModelTierFromCard(selected)
      const tierLocked = profileRegistry.get(order.profile)?.tierLock === 'cheap'
      const canUpgrade = !isAbort
        && !tierLocked
        && (order.budget.maxRetries > 0)
        && this.proUpgradeCount < DelegationCoordinator.MAX_PRO_UPGRADES
        && flashTier !== 'strong'
      if (canUpgrade) {
        const strongCards = this.config.modelCards.filter(c => inferModelTierFromCard(c) === 'strong')
        const strongCard = strongCards[0]
        if (strongCard) {
          // Re-create worker config with Pro model
          const upgradedConfig = this.config.runtimeFactory(order, strongCard, workerRegistry)
          upgradedConfig.maxTurns = clampWorkerMaxTurns(upgradedConfig.maxTurns, order.budget.maxTurns)
          upgradedConfig.reviewDepth = order.reviewDepth
          upgradedConfig.domainKnowledgeStore = this.config.domainKnowledgeStore
          upgradedConfig.abortSignal = mergedSignal
          upgradedConfig.onActivity = (kind, detail) => {
            this.liveness.tick(order.id)
            upstreamActivity?.(kind, detail)
          }
          upgradedConfig.mailbox = this.mailbox

          // Re-register liveness for retry
          this.liveness.register(order.id, this.config.workerStallMs ?? (isWrite ? WRITE_STALL_MS : EXPLORE_STALL_MS))

          try {
            if (role === 'hands') {
              // P1-1: re-acquire claims before Pro retry (original claims released in inner finally)
              const retryClaimFiles: string[] = []
              try {
                if (this.config.sessionRegistry && this.config.sessionId && order.scope.files?.length) {
                  const registry = this.config.sessionRegistry
                  const sid = this.config.sessionId
                  const conflictedFiles: string[] = []
                  for (const f of order.scope.files) {
                    if (registry.acquireClaim(sid, f, 'exclusive')) {
                      retryClaimFiles.push(f)
                    } else {
                      conflictedFiles.push(f)
                    }
                  }
                  if (conflictedFiles.length > 0) {
                    for (const f of retryClaimFiles) registry.releaseClaim(sid, f)
                    const degraded = this.enrichResult(
                      workerFailureResult(order, new Error(`Retry blocked: ${conflictedFiles.join(', ')} claimed by another session`), { failureReason: 'claim_conflict' }),
                      strongCard.model,
                      upgradedConfig.providerName,
                    )
                    return { status: 'completed' as const, order, selectedModel: strongCard.model, modelTierShadows: [tierShadow, ...escalationShadows], modelTierGatedDecisions: [tierGatedDecision], gatedInfluenceAudits: [gatedInfluenceAudit], results: [degraded], packet: await buildPrimaryWorkerPacket([degraded], this.config.artifactStore) }
                  }
                }

                // P1-1: increment quota and write escalation shadow only after claim check passes
                escalationShadows.push(this.recordEscalation(order, strongCard, msg))
                const cwd = this.config.cwd ?? upgradedConfig.cwd
                let retryHandsMessages: readonly OaiMessage[] | undefined
                // Escalation retries with the same order.id → fallback session already
                // registered. Re-derive worker store so the escalated run's diff persists
                // (parity with primary + retry branches).
                const escalateWorkerStore = this.config.artifactStore?.forSession(this.workerArtifactSessionId(order.id))
                const handsRun = await wrapAbort(this.runHands({
                  order, wtCoordinator: new WorktreeCoordinator(cwd), cwd,
                  sharedWorkspace: this.config.sharedWorktree,
                  maxTurns: upgradedConfig.maxTurns,
                  contextWindow: upgradedConfig.contextWindow,
                  compact: upgradedConfig.compact,
                  activeClaims: upgradedConfig.activeClaims ?? [],
                  domainKnowledgeStore: this.config.domainKnowledgeStore,
                  artifactStore: escalateWorkerStore,
                  runAgent: async (prompt, callbacks, workerCwd) => {
                    const sessionRun = await this.runWorker({ ...upgradedConfig, order, cwd: workerCwd, activeClaims: upgradedConfig.activeClaims ?? [], domainKnowledgeStore: this.config.domainKnowledgeStore })
                    if (typeof sessionRun.session?.getMessages === 'function') {
                      retryHandsMessages = sessionRun.session.getMessages()
                    }
                    callbacks.onTurnComplete(sessionRun.usage, 1, true)
                    return JSON.stringify(sessionRun.result)
                  },
                }))
                run = { result: handsRun.result, sessionMessages: retryHandsMessages, usage: handsRun.usage, providerName: upgradedConfig.providerName }
              } finally {
                if (this.config.sessionRegistry && this.config.sessionId)
                  for (const f of retryClaimFiles)
                    this.config.sessionRegistry.releaseClaim(this.config.sessionId, f)
              }
            } else {
              // P1-1: increment quota and write escalation shadow for read-only retry
              escalationShadows.push(this.recordEscalation(order, strongCard, msg))
              const workerRun = await wrapAbort(this.runWorker(upgradedConfig))
              const sessionMessages = typeof workerRun.session?.getMessages === 'function'
                ? workerRun.session.getMessages()
                : undefined
              run = { result: workerRun.result, transcript: workerRun.transcript, sessionMessages, usage: workerRun.usage, providerName: upgradedConfig.providerName }
            }
            // Upgrade succeeded — record provider outcome; circuit recovery for tier-locked profiles
            this.recordProviderOutcome(strongCard.model, true)
            if (profileRegistry.get(order.profile)?.tierLock) this.circuitBreaker.recordSuccess(order.profile)
            selected = strongCard
            // Rebuild tierShadow for the Pro model so telemetry is coherent
            const freshTierShadow = this.buildTierShadow(order, selected, tierRecommendation)
            persistModelTierShadow(this.config.modelTierShadowStore, freshTierShadow)
            // Replace the stale flash-tier tierShadow; escalation shadow records the retry event
            escalationShadows.push(freshTierShadow)
          } catch (_retryError) {
            // Pro upgrade also failed — record provider outcome; circuit failure for tier-locked profiles
            this.recordProviderOutcome(strongCard.model, false)
            if (profileRegistry.get(order.profile)?.tierLock) this.circuitBreaker.recordFailure(order.profile)
            const degraded = this.enrichResult(workerFailureResult(order, error, { failureReason: classifyWorkerError(error) }), strongCard.model, upgradedConfig.providerName)
            return {
              status: 'completed' as const,
              order,
              selectedModel: strongCard.model,
              modelTierShadows: [tierShadow, ...escalationShadows],
              modelTierGatedDecisions: [tierGatedDecision],
              gatedInfluenceAudits: [gatedInfluenceAudit],
              results: [degraded],
              packet: await buildPrimaryWorkerPacket([degraded], this.config.artifactStore),
            }
          }
        }
      }

      // If retry didn't happen, return degraded — circuit records failure for tier-locked profiles
      if (!run) {
        if (!isAbort && profileRegistry.get(order.profile)?.tierLock) this.circuitBreaker.recordFailure(order.profile)
        const degraded = this.enrichResult(workerFailureResult(order, error, { failureReason: classifyWorkerError(error) }), selected.model, workerConfig.providerName)
        return {
          status: 'completed' as const,
          order,
          selectedModel: selected.model,
          modelTierShadows: [tierShadow],
          modelTierGatedDecisions: [tierGatedDecision],
          gatedInfluenceAudits: [gatedInfluenceAudit],
          results: [degraded],
          packet: await buildPrimaryWorkerPacket([degraded], this.config.artifactStore),
        }
      }
    } finally {
      // A4: stop tracking — no false stall after completion/failure.
      this.liveness.unregister(order.id)
      this.orderControllers.delete(order.id)
      this.activityUpstream.delete(order.id)
      this.resumeMessages.delete(order.id)
      if (this.liveness.size() === 0) this.stopStallSweep()
      if (semanticLockAcquired && this.collaboration && this.config.sessionId) {
        this.collaboration.releaseLocks(this.config.sessionId)
      }
    }

    // Run completed — regardless of task verdict, the provider's API delivered.
    run.result = this.enrichResult(run.result, selected.model, run.providerName ?? workerConfig.providerName, run.usage)
    this.recordProviderOutcome(selected.model, true)

    // Circuit breaker: record outcome for tier-locked profiles (Flash army)
    if (profileRegistry.get(order.profile)?.tierLock) {
      if (run.result.status === 'passed') {
        this.circuitBreaker.recordSuccess(order.profile)
      } else {
        this.circuitBreaker.recordFailure(order.profile)
      }
    }

    this.state.recordEvent({ type: run.result.status === 'passed' ? 'passed' : run.result.status === 'blocked' ? 'blocked' : 'failed', workOrderId: order.id, timestamp: Date.now() })

    if (this.state.shouldEscalate()) {
      this.state.recordEvent({ type: 'escalated', workOrderId: order.id, timestamp: Date.now() })
      return {
        status: 'completed' as const,
        escalated: true,
        order,
        selectedModel: selected.model,
        modelTierShadows: escalationShadows.length > 0 ? escalationShadows : [tierShadow],
        modelTierGatedDecisions: [tierGatedDecision],
        gatedInfluenceAudits: [gatedInfluenceAudit],
        results: [{ ...run.result, status: 'blocked' as const, summary: `Escalated: ${this.state.getSummary().failed} consecutive failures` }],
        packet: await buildPrimaryWorkerPacket([run.result], this.config.artifactStore),
      }
    }

    const profileMap = new Map([[order.id, order.profile]])
    const transcriptMap = run.transcript ? new Map([[order.id, run.transcript]]) : undefined

    // Summary quality gate: expand brief summaries before persisting/returning.
    if (run.sessionMessages && run.sessionMessages.length > 0 && run.result.status === 'passed' && run.result.summary.length < SUMMARY_MIN_LENGTH) {
      const expanded = await this.maybeExpandSummary(order, workerConfig, mergedSignal, run.result, run.sessionMessages)
      run = { ...run, result: expanded.result, sessionMessages: expanded.sessionMessages }
    }

    const results = aggregateResults([run.result], 'primary_decides', profileMap, transcriptMap)

    // V3 Component B-loop: precipitate domain lessons from results
    if (order.authority && this.config.domainKnowledgeStore) {
      precipitateDomainLessons(this.config.domainKnowledgeStore, {
        domainId: order.authority,
        results,
        objective: order.objective,
      })
    }

    // D1: persist worker result to ~/.rivet/subagents/ for future resume/inspection
    const fp = fingerprintRequest(order.objective, order.scope.files, order.profile)
    for (const r of results) {
      persistWorkerResult(r, fp)
    }

    // Save worker session history for resume support. Best-effort: never blocks.
    if (run.sessionMessages && run.sessionMessages.length > 0) {
      saveWorkerSession(order.id, order.profile, order.objective, run.sessionMessages)
    }

    return {
      status: 'completed' as const,
      order,
      selectedModel: selected.model,
      modelTierShadows: escalationShadows.length > 0 ? escalationShadows : [tierShadow],
      modelTierGatedDecisions: [tierGatedDecision],
      gatedInfluenceAudits: [gatedInfluenceAudit],
      results,
      packet: await buildPrimaryWorkerPacket(results, this.config.artifactStore),
    }
  }

  async delegateBatch(
    requests: DelegationRequest[],
    policy: AggregationPolicy = 'primary_decides',
    abortSignal?: AbortSignal,
    onProgress?: (completed: number, total: number) => void,
  ): Promise<CoordinatorRun> {
    // Per-call abort signal override
    const savedSignal = this.config.abortSignal
    if (abortSignal) this.config.abortSignal = abortSignal
    try {
      // B3: depth-capped requests are rejected as blocked, not silently dropped.
      const depthCap = this.config.maxDelegationDepth ?? MAX_DELEGATION_DEPTH
      const depthCapped: WorkerResult[] = requests
        .filter(r => (r.delegationDepth ?? 0) >= depthCap)
        .map(r => ({
          workOrderId: `depth-capped-${r.parentTurnId}`,
          status: 'blocked' as const,
          summary: `Delegation rejected: max delegation depth (${depthCap}) reached — do the work inline instead of delegating further`,
          findings: [],
          artifacts: [],
          changedFiles: [],
          risks: ['unbounded delegation recursion prevented'],
          nextActions: ['Perform the objective directly in this worker session'],
          evidenceStatus: 'blocked' as const,
        }))
      const runnables = requests.filter(r =>
        (r.delegationDepth ?? 0) < depthCap && shouldDelegateObjective(r.objective, r.scope))
      if (runnables.length === 0 && depthCapped.length === 0) {
        return { status: 'skipped', results: [], packet: await buildPrimaryWorkerPacket([], this.config.artifactStore) }
      }
      if (runnables.length === 0) {
        return { status: 'completed', results: depthCapped, packet: await buildPrimaryWorkerPacket(depthCapped, this.config.artifactStore) }
      }

    const queue = new WorkOrderQueue(this.config.maxWorkers, {
      explore: this.config.maxExploreWorkers,
      write: this.config.maxWriteWorkers,
    })

    // Pre-create work orders for deduplication and dependency ordering
    const orders: WorkOrder[] = []
    for (const r of runnables) {
      const isWrite = classifyProfile(r.profile) === 'hands'
      const stableId = deriveStableWorkOrderId(r.parentTurnId)
      const order = isWrite
        ? createWriteWorkOrder({
            id: stableId,
            parentTurnId: r.parentTurnId,
            kind: r.kind,
            profile: r.profile,
            objective: r.objective,
            scope: r.scope,
            reviewDepth: r.reviewDepth,
            delegationDepth: (r.delegationDepth ?? 0) + 1,
            dependencies: r.dependencies,
            authority: r.authority,
            riskTier: r.riskTier,
            sessionTurn: r.sessionTurn,
            budget: r.budget,
            modelOverride: r.modelOverride,
          })
        : createReadOnlyWorkOrder({
            id: stableId,
            parentTurnId: r.parentTurnId,
            kind: r.kind,
            profile: r.profile,
            objective: r.objective,
            scope: r.scope,
            reviewDepth: r.reviewDepth,
            delegationDepth: (r.delegationDepth ?? 0) + 1,
            dependencies: r.dependencies,
            authority: r.authority,
            riskTier: r.riskTier,
            sessionTurn: r.sessionTurn,
            budget: r.budget,
            modelOverride: r.modelOverride,
          })
      if (queue.enqueue(order)) {
        orders.push(order)
        // T9 P3: callbacks don't survive zod parsing — stash by order id.
        if (r.onActivity) this.activityUpstream.set(order.id, r.onActivity)
        // Session resume: load prior messages (same side-table pattern as delegate()).
        if (r.resumeWorkOrderId) {
          const record = loadWorkerSession(r.resumeWorkOrderId)
          if (record) {
            this.resumeMessages.set(order.id, record.messages)
            debugLog(`[worker-resume] batch: loaded ${record.messages.length} messages from ${r.resumeWorkOrderId} for ${order.id}`)
          }
        }
      }
    }

    // Process queue with concurrency control
    const allResults: WorkerResult[] = []
    const workerModels: NonNullable<CoordinatorRun['workerModels']> = []
    const modelTierShadows: ModelTierShadowEvent[] = []
    const modelTierGatedDecisions: ModelTierGatedDecisionEvent[] = []
    const gatedInfluenceAudits: GatedInfluenceAuditEvent[] = []
    const inflight: Promise<void>[] = []
    let completedCount = 0

    const processNext = async (): Promise<void> => {
      const order = queue.dequeue()
      if (!order) return
      queue.markInFlight(order)
      try {
        const run = await this.delegateOrder(order)
        allResults.push(...run.results)
        if (run.modelTierShadows) modelTierShadows.push(...run.modelTierShadows)
        if (run.modelTierGatedDecisions) modelTierGatedDecisions.push(...run.modelTierGatedDecisions)
        if (run.gatedInfluenceAudits) gatedInfluenceAudits.push(...run.gatedInfluenceAudits)
        if (run.selectedModel) {
          workerModels.push({ workOrderId: order.id, model: run.selectedModel })
        }
        queue.markCompleted(order)
      } catch (error) {
        allResults.push(workerFailureResult(order, error, { failureReason: classifyWorkerError(error) }))
        queue.markFailed(order)
      }
      completedCount++
      onProgress?.(completedCount, orders.length)
      // Recurse: try to process next pending order (respecting concurrency limit)
      await processNext()
    }

    // Start initial batch of workers
    for (let i = 0; i < this.config.maxWorkers; i++) {
      inflight.push(processNext())
    }
    await Promise.all(inflight)

    // A3: drain any orders that could never be scheduled because a dependency
    // failed (or itself ended up blocked). processNext stops dequeuing these, so
    // without an explicit sweep they would be silently lost from the result set.
    for (const order of queue.pending()) {
      const unmet = order.dependencies.filter(d => !queue.isCompleted(d))
      const failedDeps = unmet.filter(d => queue.hasFailed(d))
      allResults.push(blockedDependencyResult(order, unmet, failedDeps))
      queue.markFailed(order)
    }

    const profileMap = new Map(orders.map(o => [o.id, o.profile] as const))
    const aggregated = [...aggregateResults(allResults, policy, profileMap), ...depthCapped]
    // D1: persist worker results to ~/.rivet/subagents/
    for (const r of aggregated) {
      persistWorkerResult(r)
    }

    const baseRun: CoordinatorRun = {
      status: 'completed',
      results: aggregated,
      packet: await buildPrimaryWorkerPacket(aggregated, this.config.artifactStore),
      aggregationPolicy: policy,
      ...(workerModels.length > 0 ? { workerModels } : {}),
      ...(modelTierShadows.length > 0 ? { modelTierShadows } : {}),
      ...(modelTierGatedDecisions.length > 0 ? { modelTierGatedDecisions } : {}),
      ...(gatedInfluenceAudits.length > 0 ? { gatedInfluenceAudits } : {}),
    }
    return this.drainMailboxIntoRun(baseRun)
    // NOTE: If delegateBatch is ever changed from serial (processNext recursion)
    // to true concurrent execution, the finally-based signal restoration below
    // will race with in-flight orders — they'll lose access to the signal
    // mid-flight. In that case, pass abortSignal per-call to delegateOrder
    // instead of mutating config.abortSignal.
    } finally {
      this.config.abortSignal = savedSignal
    }
  }
}
