/**
 * RuntimeSessionManager — desktop-facing multi-session layer (M0.5).
 *
 * Owns N independent agent runs and turns their AgentCallbacks into a single
 * monotonic, replayable event log per session. Deliberately separate from
 * src/agent/session-registry.ts (that is the cross-session claims/events
 * registry) — these bridge, they do not merge.
 *
 * Invariants:
 *  - Every event carries a monotonic `seq`; `getEvents(since)` replays the tail,
 *    so a dropped viewer never loses history (B3).
 *  - A viewer unsubscribing NEVER aborts the run; only abort() does.
 *  - Approvals are requestId-keyed two-way interventions resolved out of
 *    band by answerIntervention() (B2). Intent direction notes are one-way,
 *    non-blocking timeline events (intent_note) — no pending state.
 *  - Artifacts are surfaced from each session's own ArtifactStore, never shared
 *    across sessions (B4).
 */
import type { AgentCallbacks, ApprovalMode } from '../agent/loop-types.js'
import { collectPostBoundaryEditIds } from '../agent/file-history.js'
import type { DelegationActivity } from '../tools/types.js'
import type { ApprovalResult } from '../agent/approval-edit.js'
import type { HookEvent, HookResult } from '../hooks/user-hooks-runner.js'
import type { IntentPreview } from '../agent/intent-preview.js'
import { describeIntentNote } from '../agent/intent-preview.js'
import type { Artifact } from '../artifact/types.js'
import { ArtifactStore } from '../artifact/store.js'
import type { OaiMessage } from '../api/oai-types.js'
import type { SessionRegistry } from '../agent/session-registry.js'
import type { DecisionShift } from '../agent/loop-types.js'
import type { PlanModeState } from '../agent/plan-mode.js'
import {
  listPlans as storeListPlans,
  readPlan as storeReadPlan,
  rejectPlan as storeRejectPlan,
  writePlan as storeWritePlan,
  resolvePlanOptionLabel,
  parsePlanOptions,
  type PlanDocument,
} from '../plan/plan-store.js'
import { approvePlanWithGuards, type PlanApprovalResult } from '../plan/plan-approval.js'
import { SteerBuffer } from '../tui/steer-buffer.js'
import { WatchdogRecoveryPolicy } from '../agent/watchdog-recovery-policy.js'
import { buildDomainPickerEntries, type DomainPickerEntry } from '../agent/domain-picker-entries.js'
import { starDomainRegistry } from '../agent/star-domain-registry.js'
import type { ActiveStarDomain } from '../agent/star-domain.js'
import type { StarDomainId } from '../agent/star-domain.js'
import { skillRegistry, loadProjectSkills, listInstallableSkills, importSkillsIntoRivet, countInstalledSkills, type InstallableSkill } from '../skills/skill-loader.js'
import { join, resolve } from 'node:path'
import { readFile } from 'node:fs/promises'
import { createWorktree, removeWorktree, listWorktrees, hasUnlandedWork, commitAll, revParseHead, squashMergeBranch, pushBranch, type WorktreeEntry } from '../agent/worktree.js'
import { createPr } from './gh-cli.js'
import { getGitGraph, getWorkingTreeFiles, getFileDiff } from '../tools/git.js'
import type { WorkingTreeFile } from '../tools/git.js'
import { SessionJobs, type JobEvent } from '../tools/job-store.js'
import { parseAskUserQuestions } from '../tools/ask-user-question.js'
import { grantApp as grantComputerUseApp } from '../tools/computer-use/app-grants.js'
import type {
  ApprovalMode as WireApprovalMode,
  PlanModeState as WirePlanModeState,
  SessionStatus,
  SessionEvent,
  SessionEventType,
  SessionRecord,
  PlanDraft,
} from './protocol.js'

// The session wire contract (event types, records, statuses) lives in
// protocol.ts so the desktop can share it type-only. Re-export so existing
// server-side importers keep working unchanged.
export type { SessionStatus, SessionEvent, SessionEventType, SessionRecord, PlanDraft } from './protocol.js'

// Compile-time drift guards: the wire copies of ApprovalMode / PlanModeState in
// protocol.ts must stay identical to the runtime definitions. If either side
// changes, these aliases stop typechecking.
type Equals<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false
type Assert<T extends true> = T
export type _ApprovalModeInSync = Assert<Equals<ApprovalMode, WireApprovalMode>>
export type _PlanModeStateInSync = Assert<Equals<PlanModeState, WirePlanModeState>>

/** Structured approval outcome — routes surface `reason` instead of a blind 409. */
export type PlanApprovalOutcome =
  | { ok: true }
  | {
      ok: false
      code: 'session-missing' | 'session-running' | 'plan-not-found' | 'invalid-content' | 'bad-approach'
      reason: string
    }

/** Structured plan-edit outcome (PUT /plans/:slug). */
export type PlanUpdateOutcome =
  | { ok: true }
  | {
      ok: false
      code: 'session-missing' | 'plan-not-found' | 'not-editable' | 'empty-content'
      reason: string
    }

/** PlusMenu — a selectable model across all configured providers. */
export interface ModelOption {
  id: string
  alias: string
  provider: string
  contextWindow?: number
}

/** PlusMenu — a model option annotated with whether it's the session's current. */
export interface ModelEntry extends ModelOption {
  current: boolean
}

/** PlusMenu — a skill's per-session enablement status. */
export interface SkillStatus {
  name: string
  description: string
  source: string
  enabled: boolean
}

/** Minimal agent surface the manager needs — decoupled from AgentLoop for tests. */
/** User-dispatched background worker request (from POST /sessions/:id/delegate). */
export interface DelegateWorkerInput {
  objective: string
  /** Worker role profile (code_scout / reviewer / patcher …). Defaults applied downstream. */
  profile?: string
  /** Optional star-domain authority injected into the worker. */
  authority?: string
  /** Optional files to scope the worker to. */
  files?: string[]
}

/** Structured progress/terminal update emitted by a user-dispatched worker. */
export interface DelegateActivityUpdate {
  workOrderId: string
  parentToolId?: string
  profile?: string
  authority?: string
  objective?: string
  status: string
  progressLine?: string
  model?: string
  provider?: string
  usage?: DelegationActivity['usage']
  artifactId?: string
  changedFiles?: string[]
  /** Terminal digest text for the desktop "汇入主会话" adopt button. */
  summary?: string
}

export interface ManagedAgent {
  run(prompt: string, callbacks: AgentCallbacks, images?: string[]): Promise<void>
  abort(): void
  listArtifacts(): Artifact[]
  readArtifact(id: string): Promise<string | null>
  /**
   * S — live-switch the autonomy level. Mutates the agent's approval mode in
   * place (read per-tool by the pipeline), so a mid-session toggle takes effect
   * on the next tool without rebuilding the agent / losing conversation state.
   * Optional so lightweight test doubles need not implement it.
   */
  setApprovalMode?(mode: ApprovalMode): void
  /**
   * Plan mode — restrict the agent to read-only tools (planning) or release it
   * (off). Mirrors AgentLoop.enterPlanMode/exitPlanMode. Optional so lightweight
   * test doubles need not implement it.
   */
  enterPlanMode?(opts?: { planFilePath?: string }): void
  exitPlanMode?(): void
  /**
   * Plan mode change notification — assigned by the session layer so agent-side
   * transitions (e.g. the model calling plan action=enter_mode) surface as
   * plan_mode SSE events. Mirrors AgentLoop.onPlanModeChange. Optional so
   * lightweight test doubles need not implement it.
   */
  onPlanModeChange?: (state: PlanModeState) => void
  /**
   * Relative path of the working draft the agent writes while in plan mode
   * (null when not planning). Mirrors AgentLoop.getActivePlanFilePath.
   * Optional so lightweight test doubles need not implement it.
   */
  getActivePlanFilePath?(): string | null
  /**
   * Set (or clear) the approved-plan pointer. Injects a tiny slug/title/path
   * reminder into the agent's dynamic appendix (NOT the plan body, which stays
   * on disk). Mirrors AgentLoop.setActivePlan. Optional for lightweight doubles.
   */
  setActivePlan?(plan: { slug: string; title: string; selectedApproach?: string } | null): void
  /** Inject the session-owned background job registry so bash(run_in_background)
   *  and the `job` tool operate on an instance the server subscribes to. Optional
   *  so lightweight test doubles need not implement it. */
  setJobs?(jobs: import('../tools/job-store.js').SessionJobs): void
  /**
   * Mount an EXTENDED-layer tool onto the main agent (mirrors AgentLoop.enableTool).
   * Used by workflow slash-command resolution to ensure prompt-declared tools are
   * visible before run. Optional so lightweight test doubles need not implement it.
   */
  enableTool?(name: string): {
    status: 'mounted' | 'already-active' | 'not-extended' | 'unknown' | 'gating-off'
    cacheImpact: 'prefix-invalidated' | 'none'
  }
  /** Current reasoning effort level (off/low/medium/high/max). */
  getReasoningEffort?(): string | undefined
  /** Rewind: return the current message list (for listing rewind points). */
  getMessages(): OaiMessage[]
  /**
   * Outcome of the boot-time LLM history restore (sidecar restart recovery).
   * Lets the session layer warn when the event log shows a prior conversation
   * but the model context came back empty (corrupt/unreadable session file) —
   * otherwise the user silently talks to a model that remembers nothing.
   * Optional so lightweight test doubles need not implement it.
   */
  getHistoryRestore?(): { restored: number; error?: string }
  /** Rewind: replace the message list (truncate to a prior point). */
  replaceMessages(msgs: OaiMessage[]): void
  /** Rewind: like replaceMessages but also resets turnCount/filesRead/filesModified etc. */
  rewindToMessages(msgs: OaiMessage[]): void
  /** Precise rewind: the session's per-edit FileHistory (write_file/edit_file
   *  backups keyed by tool_use id). Absent on lightweight doubles / when no
   *  history is wired. */
  getFileHistory?(): import('../agent/file-history.js').FileHistory | undefined
  /**
   * Reset the prompt engine's delta appendix baseline after any history rewrite
   * (compaction, rewind, /compact). Optional so lightweight test doubles need
   * not implement it; production agents (AgentLoop) delegate to promptEngine.
   */
  resetAppendixBaseline?(): void
  /**
   * PlusMenu (domain) — pin a star domain (or null to disable). Mirrors
   * AgentLoop.setSessionDomain. Optional for lightweight test doubles.
   */
  setSessionDomain?(domain: ActiveStarDomain | null): void
  /** PlusMenu (domain) — reset to Auto (next run auto-detects from input). */
  resetSessionDomain?(): void
  /** PlusMenu (domain) — read the current selection (Auto when undefined). */
  getSessionDomain?(): ActiveStarDomain | null | undefined
  /**
   * PlusMenu (model) — rebuild this session's agent on a new model, preserving
   * the conversation (same SessionContext) and shared stores. Returns the
   * resolved model id, or null when the model id is unknown / unauthorized.
   * Optional for lightweight test doubles.
   */
  switchModel?(modelId: string): string | null
  /**
   * PlusMenu (skills) — set the per-session disabled skill set. Filters the
   * discovery block so disabled skills are hidden from the model. Optional for
   * lightweight test doubles.
   */
  setDisabledSkills?(names: Set<string>): void
  /** Estimated token count for the current conversation (including prefix overhead). */
  getEstimatedTokens?(): number
  /** Model context window size (max tokens). */
  getContextWindow?(): number
  /**
   * Wave L: 进程退出时释放 session 级资源（典型场景：sidecar runServe.close
   * → shutdownAll）。具体实现负责调 coordinator.shutdown 等清 timer/in-flight
   * worker。与 abort() 严格分离——abort 中止当前 turn 但保留 agent 可继续运行，
   * shutdown 是终结性操作。Optional 以兼容 lightweight test doubles。
   */
  shutdown?(): void
  /**
   * I1: 直接召集议事会评审一个 artifact 中的 council-plan-json 草案。
   * 由桌面 CouncilSurface 调用；实际实现持有 coordinator 与 artifactStore。
   * Optional 以兼容 lightweight test doubles。
   */
  conveneCouncil?(input: {
    artifactId: string
    objective?: string
    seats?: { authority: string; charter?: string }[]
    rounds?: number
  }): Promise<{ planMarkdown: string; artifactId: string }>
  /**
   * User-dispatched background subagent. Runs a worker in its own isolated
   * sub-session via the coordinator with an INDEPENDENT abort signal (so the
   * main turn's abort / model switch does not kill it), streaming progress via
   * the supplied onActivity callback. Does NOT touch the main SessionContext /
   * prefix cache. Optional so lightweight test doubles need not implement it.
   */
  delegateWorker?(
    input: DelegateWorkerInput,
    opts: { workerId: string; signal: AbortSignal; onActivity: (a: DelegateActivityUpdate) => void },
  ): Promise<void>
}

/**
 * Builds the agent for a session. Receives the manager's own session id so the
 * agent's stores (artifacts/session-persist) align with the session — enabling
 * future artifact recovery across restarts. The optional approvalMode overrides
 * the global config autonomy level for this session (S).
 */
export type AgentFactory = (
  cwd?: string,
  sessionId?: string,
  approvalMode?: ApprovalMode,
) => ManagedAgent

export interface CreateSessionInput {
  cwd?: string
  title?: string
  prompt?: string
  approvalMode?: ApprovalMode
  /** Create an isolated git worktree for this session (parallel work without conflict). */
  isolatedWorktree?: boolean
}

/** Persisted snapshot of a session: a record + its full event log. */
export interface PersistedSession {
  record: SessionRecord
  events: SessionEvent[]
}

/** One archived session's on-disk footprint, for the storage cleanup UI. */
export interface SessionStorageEntry {
  id: string
  title?: string
  status: SessionStatus
  updatedAt: number
  bytes: number
}

/** Aggregate disk-usage report for the desktop session store. */
export interface StorageReport {
  totalBytes: number
  sessionCount: number
  archivedCount: number
  /** Bytes reclaimable by purging all archived sessions. */
  archivedBytes: number
  /** Archived sessions, oldest first (the natural cleanup order). */
  archived: SessionStorageEntry[]
}

/**
 * Durable backing store for sessions (N1). Records are snapshotted; events are
 * append-only. Implementations must tolerate a corrupt trailing event line
 * (partial write) on load — never throw, just drop it.
 */
export interface SessionPersistenceAdapter {
  saveRecord(record: SessionRecord): void
  appendEvent(sessionId: string, event: SessionEvent): void
  /** Flush buffered writes to disk (batched adapters). Optional — no-op if absent. */
  flushSync?(): void
  loadAll(): PersistedSession[]
  /**
   * Lazy-boot support (optional). `loadRecords` reads ONLY the lightweight
   * index.json snapshot per session — never the (potentially huge) event log —
   * so rehydrate is O(sessions) instead of O(total events ever). `loadEvents`
   * reads a single session's full log on demand (first open). Adapters that omit
   * both fall back to the eager `loadAll()` path (fine for tiny in-memory test
   * stores). The file-backed store implements both.
   */
  loadRecords?(): SessionRecord[]
  loadEvents?(sessionId: string): SessionEvent[]
  /**
   * Storage-management support (optional). `sizeReport`/`sizeOf` report on-disk
   * byte usage via stat() only (never reading contents); `deleteSession`
   * irreversibly removes a session's files. Used by the manual cleanup UI.
   */
  sizeReport?(): Map<string, number>
  sizeOf?(sessionId: string): number
  deleteSession?(sessionId: string): void
  /**
   * Persist a user-attached image as a standalone file so the event log only
   * carries a small reference id (not the base64). Optional — adapters that
   * predate vision attachments may omit it. `base64` is the raw payload (no
   * data: prefix). Returns nothing; the caller already owns `imgId`.
   */
  saveImage?(sessionId: string, imgId: string, base64: string, mime: string): void
  /** Read back a persisted image by id. Returns undefined if missing. */
  readImage?(sessionId: string, imgId: string): { bytes: Buffer; mime: string } | undefined
}

export interface RuntimeSessionManagerOptions {
  createAgent: AgentFactory
  defaultCwd?: string
  now?: () => number
  idGenerator?: () => string
  /** Cap on retained events per session (ring buffer). Default 5000. */
  maxEvents?: number
  /**
   * Cap on how many sessions keep their event log resident at once. Lazy-loaded
   * sessions beyond this (LRU, and only ones with no live agent / not running /
   * unwatched) have their logs dropped back to disk, bounding memory regardless
   * of how much history accumulates. Default 16.
   */
  maxLoadedSessions?: number
  /** Auto-resolve a pending intervention after this many ms. 0 = never. Default 0. */
  approvalTimeoutMs?: number
  /** C2 刹车 — watchdog 停滞续跑前的可取消倒计时窗口（ms）。Default 5000. */
  watchdogContinueDelayMs?: number
  /** Optional durable store. When set, sessions survive sidecar restarts. */
  persistence?: SessionPersistenceAdapter
  /**
   * R1 — late-bound accessor for the shared cross-session registry. A getter
   * (not a value) because the registry's SQLite backend resolves async after the
   * server starts. Returns undefined when concurrency features are disabled.
   */
  getSessionRegistry?: () => SessionRegistry | undefined
  /**
   * PlusMenu (model) — enumerate selectable models across all configured
   * providers. Injected by serve.ts (which owns the provider config). Absent in
   * tests → the model picker returns an empty list.
   */
  listModels?: () => ModelOption[]
  /**
   * PlusMenu (model) — the default model id new sessions start on. Used for the
   * initial record.model and the picker's `current` flag.
   */
  defaultModelId?: string
  /** PlusMenu (domain) — the default domain key new sessions start on. */
  defaultDomain?: string
}

type InterventionKind = 'approval'

interface PendingIntervention {
  requestId: string
  kind: InterventionKind
  resolve: (value: ApprovalResult | boolean) => void
  timer?: ReturnType<typeof setTimeout>
  /** Tool identity of the gated call — lets answerIntervention apply
   *  tool-specific "remember" semantics (e.g. computer_use per-app grants). */
  toolName?: string
  /** Original (unredacted) tool input for remember handling. */
  toolInput?: Record<string, unknown>
}

interface InternalSession {
  record: SessionRecord
  /** Lazily built on first run; null for rehydrated/idle sessions. */
  agent: ManagedAgent | null
  /** S — per-session autonomy override threaded into the agent on build. */
  approvalMode?: ApprovalMode
  events: SessionEvent[]
  /**
   * Whether `events` holds the full on-disk log. False for a rehydrated session
   * whose log hasn't been read yet (lazy boot) or one whose log was evicted to
   * bound memory — ensureEvents() (re)loads from disk on first access.
   */
  eventsLoaded: boolean
  seq: number
  running: boolean
  pending: Map<string, PendingIntervention>
  listeners: Set<(e: SessionEvent) => void>
  knownArtifacts: Set<string>
  /** T3 — mid-run user guidance, drained into the agent at the next tool boundary. */
  steer: SteerBuffer
  /**
   * Background job registry (bash run_in_background + `job` tool). Server-owned so
   * it survives agent rebuilds (switchModel) and its lifecycle events can be
   * forwarded to SSE. Lazily created on first ensureAgent, injected into the agent
   * via setJobs, terminated on session close. */
  jobs?: import('../tools/job-store.js').SessionJobs
  /**
   * Lazily built read-only view over the on-disk artifact log for sessions
   * without a live agent (rehydrated/idle). Lets the desktop still read artifact
   * bodies after a sidecar restart, since the agent's ArtifactStore persists
   * both the index and raw files keyed by sessionId.
   */
  rehydratedArtifacts?: ArtifactStore
  /**
   * PlusMenu (domain) — live star-domain selection. Tri-state mirrors
   * AgentLoop.getSessionDomain: undefined=Auto, null=no-persona (env kill switch
   * only), object=pinned. Applied
   * to the agent on ensureAgent (so lazy build is consistent) and after a model
   * rebuild (so the selection survives switchModel).
   */
  domainState: ActiveStarDomain | null | undefined
  /** PlusMenu (skills) — per-session disabled skill names (in-memory). */
  disabledSkills: Set<string>
  /**
   * Skills that failed to load from .rivet/skills at session create (e.g. a
   * malformed Claude SKILL.md with no/broken frontmatter). Surfaced to the UI so
   * an installed-but-unparseable skill is visible instead of silently dropped.
   */
  skillLoadErrors: string[]
  /**
   * User-dispatched background worker abort controllers, keyed by workerId.
   * Independent from the main turn's signal so a user-launched subagent is NOT
   * killed by aborting the main conversation. Lazily created on first dispatch.
   */
  backgroundAborts?: Map<string, AbortController>
  /**
   * First-seen timestamps per workOrderId, for delegation elapsed reporting.
   * Shared by the run-time callback path and the idle user-dispatch path so both
   * report consistent elapsed. Lazily created.
   */
  delegationStartedAt?: Map<string, number>
  /** Watchdog stall 恢复状态机（与 TUI 共享实现），随 session 生命周期。 */
  watchdogPolicy?: WatchdogRecoveryPolicy
  /** 最近一次 onAbort 携带的 reason（watchdog 家族判定用）。每次 run 起跑清空。 */
  lastAbortReason?: string
  /** onAbort 时刻是否有审批挂起——必须在此捕获，run().finally 的 rejectAllPending 会清掉 pending map。 */
  abortWhileApprovalPending?: boolean
  /** 最近一次审批被拒的时刻（this.now() 读数），驱动 grace 窗口抑制。 */
  lastApprovalDeniedAt?: number
  /** 标记下一次 run 是 watchdog 自动续跑（跳过 recordUserSubmit，与 TUI 的
   *  onSubmitCallback 直呼路径对齐——自动续跑不得重置 consecutive）。 */
  watchdogAutoResubmit?: boolean
  /** 用户在 watchdog stall→setImmediate 续跑窗口内 abort → 置 true 抑制续跑。
   *  abort() 对已停会话是空操作（status 已 aborted），不加此标记则窄窗口内
   *  自动续跑会盖掉用户刚表达的「停」。run() 起跑时清。 */
  watchdogRecoveryCancelled?: boolean
  /** C2 刹车 — watchdog 续跑倒计时定时器。窗口内用户 abort / 新 prompt 取消。 */
  watchdogContinueTimer?: NodeJS.Timeout
  /** plan_draft 节流 — 最近一次发射时刻（this.now() 读数）。 */
  planDraftLastEmit?: number
  /** plan_draft 节流 — 尾沿定时器，保证窗口内最后一次写盘总能落一发事件。 */
  planDraftTimer?: NodeJS.Timeout
}

const REDACTED = '[REDACTED]'
const SENSITIVE_KEY = /(?:api[_-]?key|token|secret|password|authorization)/i

/** Tools that spawn worker agents — surfaced as delegation-tree nodes (N3). */
const DELEGATION_TOOLS = new Set(['delegate_task', 'delegate_batch', 'team_orchestrate'])

/** 审批拒绝后的 watchdog 续跑抑制窗口——与 TuiApp.APPROVAL_STALL_GRACE_MS 对齐：
 *  拒绝后立刻 stall 的自动 continue 只会重发同一个被拒调用（deny→continue→deny 环）。 */
const WATCHDOG_APPROVAL_GRACE_MS = 5_000

/** Cap on concurrent user-dispatched background workers per session (guards the
 *  shared coordinator from being swamped). */
const MAX_USER_BACKGROUND_WORKERS = 4

/** plan_draft 事件节流窗口——agent 增量写草稿可能一轮多次落盘，事件只是
 *  失效信号（桌面收到后重拉正文），1s 粒度足够「直播感」。 */
const PLAN_DRAFT_THROTTLE_MS = 1_000

/** Result of a user-dispatch request — lets the route map a precise status code. */
export type DelegateResult =
  | { ok: true; workerId: string }
  | { ok: false; reason: 'not_found' | 'invalid' | 'unsupported' | 'limit' }

function extractObjective(input: Record<string, unknown>): string {
  for (const key of ['objective', 'prompt', 'description', 'goal']) {
    const v = input[key]
    if (typeof v === 'string' && v.trim()) return v.slice(0, 200)
  }
  return ''
}

/**
 * Scan an event log for approvals that were requested but never resolved —
 * i.e. the run was interrupted (sidecar restart) while blocked on them.
 * Used by rehydrate() to close them out honestly instead of leaving a
 * dangling approval card in the replayed timeline.
 */
function findOrphanedApprovals(events: SessionEvent[]): Array<{ requestId: string; toolName: string }> {
  const open = new Map<string, string>()
  for (const e of events) {
    const id = typeof e.data.requestId === 'string' ? e.data.requestId : ''
    if (!id) continue
    if (e.type === 'approval_required') {
      open.set(id, typeof e.data.toolName === 'string' ? e.data.toolName : '')
    } else if (e.type === 'approval_resolved') {
      open.delete(id)
    }
  }
  return [...open.entries()].map(([requestId, toolName]) => ({ requestId, toolName }))
}

/** T2 — todo item as surfaced to the desktop (subset of the tool's schema). */
interface TodoStateItem {
  id: string
  content: string
  status: 'pending' | 'in_progress' | 'completed'
}

/**
 * T2 — parse a `todo` write tool input into structured items.
 *
 * We read the per-call input rather than the global TodoStore singleton on
 * purpose: the store is shared across all sidecar sessions, so its snapshot is
 * not session-correct, whereas the tool input belongs to this session's call.
 * Returns null for non-write actions or malformed payloads.
 */
function extractTodoState(input: Record<string, unknown>): TodoStateItem[] | null {
  if (input.action !== 'write') return null
  const raw = input.todos
  if (!Array.isArray(raw)) return null
  const items: TodoStateItem[] = []
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue
    const e = entry as Record<string, unknown>
    const id = typeof e.id === 'string' ? e.id : ''
    const content = typeof e.content === 'string' ? e.content : ''
    const status = e.status === 'in_progress' || e.status === 'completed' ? e.status : 'pending'
    if (!id || !content) continue
    items.push({ id, content, status })
  }
  return items
}

export class RuntimeSessionManager {
  private readonly sessions = new Map<string, InternalSession>()
  private readonly createAgent: AgentFactory
  private readonly defaultCwd: string
  private readonly now: () => number
  private readonly idGenerator: () => string
  private readonly maxEvents: number
  private readonly maxLoadedSessions: number
  /** LRU of session ids whose event log is currently resident (oldest first). */
  private readonly loadedOrder: string[] = []
  private readonly approvalTimeoutMs: number
  private readonly watchdogContinueDelayMs: number
  private readonly persistence?: SessionPersistenceAdapter
  private readonly getRegistry?: () => SessionRegistry | undefined
  private readonly listModelsFn?: () => ModelOption[]
  private readonly defaultModelId?: string
  private readonly defaultDomain?: string

  constructor(opts: RuntimeSessionManagerOptions) {
    this.createAgent = opts.createAgent
    this.defaultCwd = opts.defaultCwd ?? process.cwd()
    this.now = opts.now ?? Date.now
    this.idGenerator = opts.idGenerator ?? (() => randomId())
    this.maxEvents = opts.maxEvents ?? 5000
    this.maxLoadedSessions = opts.maxLoadedSessions ?? 16
    this.approvalTimeoutMs = opts.approvalTimeoutMs ?? 0
    this.watchdogContinueDelayMs = opts.watchdogContinueDelayMs ?? 5_000
    this.persistence = opts.persistence
    this.getRegistry = opts.getSessionRegistry
    this.listModelsFn = opts.listModels
    this.defaultModelId = opts.defaultModelId
    if (this.persistence) this.rehydrate()
  }

  /**
   * Restore sessions from the persistence store on boot. Honest semantics: the
   * old agent run is gone, so any session that was 'running' is restored as
   * 'aborted' (interrupted by restart) and is view-only until a fresh run is
   * started in the same cwd. events.jsonl is the source of truth for seq.
   */
  private rehydrate(): void {
    const p = this.persistence!
    // Lazy boot: read only the lightweight index.json records — NOT the event
    // logs — so a sidecar restart is O(sessions) instead of O(total events ever).
    // With dozens of long sessions the eager path read+parsed tens of MB of
    // events.jsonl synchronously on every launch (slow start + unbounded RAM);
    // here each session starts with an empty log that ensureEvents() fills on
    // first open. Falls back to eager loadAll() for adapters without lazy support.
    if (typeof p.loadRecords === 'function' && typeof p.loadEvents === 'function') {
      let records: SessionRecord[]
      try { records = p.loadRecords() } catch { return }
      for (const rec of records) {
        const wasRunning = rec.status === 'running'
        const session: InternalSession = {
          record: {
            ...rec,
            status: wasRunning ? 'aborted' : rec.status,
            lastSeq: rec.lastSeq,
            pendingApprovals: 0,
          },
          agent: null,
          events: [],
          eventsLoaded: false,
          seq: rec.lastSeq,
          running: false,
          pending: new Map(),
          listeners: new Set(),
          knownArtifacts: new Set(),
          steer: new SteerBuffer(),
          domainState: resolveDomainState(rec.domain ?? 'auto')?.state,
          disabledSkills: new Set(),
          skillLoadErrors: [],
        }
        this.sessions.set(session.record.id, session)
        if (wasRunning) {
          // If the run died while blocked on approvals, close them out honestly:
          // read this ONE session's log (bounded: only crashed-with-pending
          // sessions pay it — the pendingApprovals>0 gate keeps lazy boot lazy),
          // find approval_required events with no matching approval_resolved,
          // and append 'sidecar-restart' resolutions so the replayed timeline
          // shows WHAT was pending instead of a dangling, unanswerable card.
          let orphans: Array<{ requestId: string; toolName: string }> = []
          if (rec.pendingApprovals > 0) {
            try { orphans = findOrphanedApprovals(p.loadEvents!(rec.id)) } catch { /* best-effort */ }
          }
          // Persist the markers straight to disk WITHOUT keeping the log
          // resident. They re-appear when ensureEvents() reads it on first open.
          const appendMarker = (type: SessionEventType, data: Record<string, unknown>) => {
            const marker: SessionEvent = { seq: ++session.seq, ts: this.now(), type, data }
            session.record.lastSeq = session.seq
            session.record.updatedAt = marker.ts
            try { p.appendEvent(session.record.id, marker) } catch { /* best-effort */ }
          }
          for (const o of orphans) {
            appendMarker('approval_resolved', { requestId: o.requestId, decision: 'sidecar-restart', toolName: o.toolName })
          }
          appendMarker('status', {
            status: 'aborted',
            reason: 'sidecar-restart',
            ...(orphans.length ? { interruptedApprovals: orphans } : {}),
          })
          this.persistRecord(session)
        }
      }
      return
    }

    // Eager fallback (in-memory / legacy adapters with only loadAll()).
    let restored: PersistedSession[]
    try {
      restored = p.loadAll()
    } catch {
      return
    }
    for (const ps of restored) {
      const events = ps.events.slice().sort((a, b) => a.seq - b.seq)
      const maxSeq = events.length ? events[events.length - 1]!.seq : ps.record.lastSeq
      const wasRunning = ps.record.status === 'running'
      const session: InternalSession = {
        record: {
          ...ps.record,
          status: wasRunning ? 'aborted' : ps.record.status,
          lastSeq: maxSeq,
          pendingApprovals: 0,
        },
        agent: null,
        // 内存环上限与懒加载路径一致：只保留尾部 maxEvents 进内存。
        events: events.length > this.maxEvents ? events.slice(events.length - this.maxEvents) : events,
        eventsLoaded: true,
        seq: maxSeq,
        running: false,
        pending: new Map(),
        listeners: new Set(),
        knownArtifacts: new Set(
          events.filter((e) => e.type === 'artifact').map((e) => String(e.data.id)),
        ),
        steer: new SteerBuffer(),
        // Restore the live domain selection from the persisted key so a rebuilt
        // agent re-applies it. Skills are in-memory only → start clean.
        domainState: resolveDomainState(ps.record.domain ?? 'auto')?.state,
        disabledSkills: new Set(),
        skillLoadErrors: [],
      }
      this.sessions.set(session.record.id, session)
      if (wasRunning) {
        // Close out approvals the crash left dangling (see lazy path above) —
        // here the full log is already in memory, so scan it directly.
        const orphans = findOrphanedApprovals(events)
        for (const o of orphans) {
          this.append(session, 'approval_resolved', { requestId: o.requestId, decision: 'sidecar-restart', toolName: o.toolName })
        }
        // Record an honest marker so the viewer sees the interruption.
        this.append(session, 'status', {
          status: 'aborted',
          reason: 'sidecar-restart',
          ...(orphans.length ? { interruptedApprovals: orphans } : {}),
        })
        this.persistRecord(session)
      }
    }
  }

  /**
   * Lazy-load a rehydrated/evicted session's event log on first access, then keep
   * at most `maxLoadedSessions` logs resident (LRU). Idempotent. All code paths
   * that read or append to `session.events` must funnel through here first so the
   * in-memory log is the complete on-disk log (not an empty lazy placeholder).
   */
  private ensureEvents(session: InternalSession): void {
    if (!session.eventsLoaded) {
      const loader = this.persistence?.loadEvents
      if (loader) {
        let evs: SessionEvent[]
        try { evs = loader.call(this.persistence, session.record.id) } catch { evs = [] }
        evs.sort((a, b) => a.seq - b.seq)
        // knownArtifacts 在截断前从全量构建——即使 artifact 事件落在被截掉的
        // 头部，去重集仍然完整（防止重放时重新公告旧 artifact）。
        session.knownArtifacts = new Set(
          evs.filter((e) => e.type === 'artifact').map((e) => String(e.data.id)),
        )
        const maxSeq = evs.length ? evs[evs.length - 1]!.seq : session.record.lastSeq
        session.seq = Math.max(session.seq, maxSeq)
        // 内存环上限对懒加载路径同样生效：极长会话（磁盘日志 ≫ maxEvents）只
        // 保留尾部进内存——与活跃会话超过环容量后的行为一致（append 已截尾），
        // 客户端 since=0 重放本来就只拿得到环内尾部。磁盘 events.jsonl 不动，
        // 仍是完整历史的 source of truth。
        session.events = evs.length > this.maxEvents ? evs.slice(evs.length - this.maxEvents) : evs
      }
      session.eventsLoaded = true
    }
    this.touchLoaded(session)
    this.evictLoadedBeyondCap()
  }

  /** Mark a session's log as most-recently-used in the LRU. */
  private touchLoaded(session: InternalSession): void {
    if (!session.eventsLoaded) return
    const id = session.record.id
    const i = this.loadedOrder.indexOf(id)
    if (i !== -1) this.loadedOrder.splice(i, 1)
    this.loadedOrder.push(id)
  }

  /**
   * Drop event logs of idle LRU sessions to bound resident memory. Never unloads
   * a session that's live (agent built or running) or being watched (SSE
   * listeners) — its in-memory log is the source of truth for in-flight appends
   * and replay; those reload cleanly from disk once idle.
   */
  private evictLoadedBeyondCap(): void {
    let i = 0
    while (i < this.loadedOrder.length && this.loadedOrder.length > this.maxLoadedSessions) {
      const id = this.loadedOrder[i]!
      const s = this.sessions.get(id)
      if (!s || s.agent || s.running || s.listeners.size > 0) { i++; continue }
      s.events = []
      s.knownArtifacts = new Set()
      s.eventsLoaded = false
      this.loadedOrder.splice(i, 1)
    }
  }

  /** Lightweight counts for GET /health. */
  stats(): { sessionCount: number; runningCount: number } {
    let runningCount = 0
    for (const s of this.sessions.values()) if (s.running) runningCount++
    return { sessionCount: this.sessions.size, runningCount }
  }

  /**
   * Disk-usage report for the storage cleanup UI. Sizes come from the
   * persistence adapter's stat()-only scan (no event-log reads), so this is
   * cheap to call even with a large history. Archived sessions are the
   * reclaimable set and are returned oldest-first.
   */
  storageReport(): StorageReport {
    const sizes = this.persistence?.sizeReport?.() ?? new Map<string, number>()
    let totalBytes = 0
    let archivedBytes = 0
    const archived: SessionStorageEntry[] = []
    for (const s of this.sessions.values()) {
      const bytes = sizes.get(s.record.id) ?? 0
      totalBytes += bytes
      if (s.record.archived === true) {
        archivedBytes += bytes
        archived.push({
          id: s.record.id,
          title: s.record.title,
          status: s.record.status,
          updatedAt: s.record.updatedAt,
          bytes,
        })
      }
    }
    archived.sort((a, b) => a.updatedAt - b.updatedAt)
    return {
      totalBytes,
      sessionCount: this.sessions.size,
      archivedCount: archived.length,
      archivedBytes,
      archived,
    }
  }

  /**
   * Irreversibly delete ONE archived session's files. Guarded: refuses unless
   * the session is archived and idle, so an active conversation can never be
   * nuked by the cleanup UI. Returns the freed byte count (0 on no-op).
   */
  deleteSession(id: string): { ok: boolean; freedBytes: number } {
    const s = this.sessions.get(id)
    if (!s || s.record.archived !== true || s.running) return { ok: false, freedBytes: 0 }
    const freedBytes = this.persistence?.sizeOf?.(id) ?? 0
    return { ok: this.hardDelete(id), freedBytes }
  }

  /**
   * Bulk-purge archived sessions. `ids` restricts to a specific set; otherwise
   * all archived qualify. `olderThanMs` further keeps only sessions untouched
   * for at least that long (relative to updatedAt). Never touches active or
   * running sessions. Returns the count and total bytes reclaimed.
   */
  purgeArchived(opts: { ids?: string[]; olderThanMs?: number } = {}): {
    deleted: number
    freedBytes: number
    ids: string[]
  } {
    const now = this.now()
    const idFilter = opts.ids ? new Set(opts.ids) : null
    const sizes = this.persistence?.sizeReport?.() ?? new Map<string, number>()
    const targets: string[] = []
    for (const s of this.sessions.values()) {
      if (s.record.archived !== true || s.running) continue
      if (idFilter && !idFilter.has(s.record.id)) continue
      if (opts.olderThanMs != null && now - s.record.updatedAt < opts.olderThanMs) continue
      targets.push(s.record.id)
    }
    let freedBytes = 0
    const deleted: string[] = []
    for (const id of targets) {
      if (this.hardDelete(id)) {
        freedBytes += sizes.get(id) ?? 0
        deleted.push(id)
      }
    }
    return { deleted: deleted.length, freedBytes, ids: deleted }
  }

  /**
   * Remove a session from memory + disk + registry. Internal: callers enforce
   * the archived/idle policy. Idempotent (missing id → false).
   */
  private hardDelete(id: string): boolean {
    const s = this.sessions.get(id)
    if (!s) return false
    try { s.agent?.shutdown?.() } catch { /* best-effort */ }
    try { s.jobs?.killAll() } catch { /* best-effort */ }
    if (s.planDraftTimer) clearTimeout(s.planDraftTimer)
    try { this.getRegistry?.()?.releaseAllClaims(id) } catch { /* best-effort */ }
    this.sessions.delete(id)
    const i = this.loadedOrder.indexOf(id)
    if (i !== -1) this.loadedOrder.splice(i, 1)
    try { this.persistence?.deleteSession?.(id) } catch { /* best-effort */ }
    return true
  }

  /**
   * Count running sessions sharing a working directory (VSW §6 adaptive policy).
   * `runningCount` alone is global and would misjudge sessions in different
   * projects as concurrent (反证表). Paths are resolved before comparison so
   * relative/absolute forms of the same cwd match. `excludeSessionId` drops the
   * caller's own session, yielding "other concurrent sessions on this cwd".
   */
  sameCwdRunningCount(cwd: string, excludeSessionId?: string): number {
    const target = resolve(cwd)
    let count = 0
    for (const s of this.sessions.values()) {
      if (!s.running) continue
      if (excludeSessionId && s.record.id === excludeSessionId) continue
      if (resolve(s.record.cwd) === target) count++
    }
    return count
  }

  createSession(input: CreateSessionInput = {}): SessionRecord {
    const id = this.idGenerator()
    let cwd = input.cwd ?? this.defaultCwd
    let worktreeBranch: string | undefined
    let worktreePath: string | undefined
    let baselineHead: string | undefined

    if (input.isolatedWorktree) {
      try {
        const wt = createWorktree(cwd, id)
        worktreeBranch = wt.branch
        worktreePath = wt.path
        cwd = wt.path
        // Diff baseline for the Changes tab: task delta stays visible even
        // after the agent commits mid-task.
        baselineHead = revParseHead(wt.path)
      } catch {
        // Worktree creation failed — fall back to shared cwd silently.
      }
    }

    const ts = this.now()
    const session: InternalSession = {
      record: {
        id,
        status: 'idle',
        createdAt: ts,
        updatedAt: ts,
        cwd,
        title: input.title,
        lastSeq: 0,
        pendingApprovals: 0,
        approvalMode: input.approvalMode,
        model: this.defaultModelId,
        domain: this.defaultDomain ?? 'auto',
        worktreeBranch,
        worktreePath,
        baselineHead,
      },
      agent: null,
      approvalMode: input.approvalMode,
      events: [],
      eventsLoaded: true,
      seq: 0,
      running: false,
      pending: new Map(),
      listeners: new Set(),
      knownArtifacts: new Set(),
      steer: new SteerBuffer(),
      domainState: this.defaultDomain && this.defaultDomain !== 'auto'
        ? resolveDomainState(this.defaultDomain)?.state
        : undefined,
      disabledSkills: new Set(),
      skillLoadErrors: [],
    }
    this.sessions.set(id, session)
    this.touchLoaded(session)
    this.persistRecord(session)
    // 立即加载技能到共享 registry：技能列表查询（/skills）发生在用户发首条消息之前，
    // 而 agent 是懒创建的（ensureAgent 在 run() 时才建）——若把 loadProjectSkills 只留
    // 在 agent 创建路径（buildSessionStores），新会话的技能面板会显示空（0/0）直到首次
    // 对话。这里在创建会话时即加载，幂等（registry 用 Map.set 覆盖）。
    // importFromClaude 的文件复制由后续 agent 创建时的 buildSessionStores 补全（幂等）。
    // 捕获 loadErrors：坏 frontmatter 的技能不再静默消失，UI 会显示原因。
    try { session.skillLoadErrors = loadProjectSkills(cwd).errors } catch { /* non-fatal: 技能加载失败不阻断会话 */ }
    // R1 — announce the session to the shared registry so its file claims are
    // attributed and reaped on crash. Best-effort: registry may be disabled.
    try { this.getRegistry?.()?.register(id, cwd, 'standalone') } catch { /* non-fatal */ }
    if (input.prompt && input.prompt.trim()) {
      this.run(id, input.prompt)
    }
    return { ...session.record }
  }

  /** Start an agent run on an idle session. Returns false if missing or busy. */
  run(id: string, prompt: string, images?: string[]): boolean {
    const session = this.sessions.get(id)
    if (!session || session.running) return false
    const wasAutoResubmit = session.watchdogAutoResubmit === true
    session.watchdogAutoResubmit = false
    session.watchdogRecoveryCancelled = false
    // C2 — 任何新 run（用户 prompt 或倒计时自身触发的 continue）都终结待续跑窗口。
    if (session.watchdogContinueTimer) {
      clearTimeout(session.watchdogContinueTimer)
      session.watchdogContinueTimer = undefined
    }
    session.lastAbortReason = undefined
    session.abortWhileApprovalPending = false
    session.watchdogPolicy ??= new WatchdogRecoveryPolicy()
    // 用户主动提交恢复续跑预算；自动续跑注入的 'continue' 不算（与 TUI 的
    // onSubmitCallback 直呼路径一致，否则 consecutive cap 形同虚设）。
    if (!wasAutoResubmit) session.watchdogPolicy.recordUserSubmit()
    // Materialize the on-disk log before appending — otherwise a reconnecting
    // viewer (since=0) would replay only this run's events, not the history.
    this.ensureEvents(session)
    const agent = this.ensureAgent(session)
    session.running = true
    // T3 — drop any guidance left from a previous run so it can't leak forward.
    session.steer.clear()
    session.record.status = 'running'
    session.record.error = undefined
    // R1 — keep the registry heartbeat fresh while this session is active.
    try { this.getRegistry?.()?.heartbeat(id) } catch { /* non-fatal */ }
    this.touch(session)
    // Persist each attached image as a standalone file and echo only small
    // reference ids into the event log — NOT the base64. This keeps events.jsonl
    // (and its full replay/restore) tiny while the model still receives the data
    // URLs inline via agent.run below.
    const imageIds = this.persistImages(id, images)
    this.append(session, 'user', {
      text: prompt,
      ...(images?.length
        ? { imageCount: images.length, ...(imageIds.length ? { imageIds } : {}) }
        : {}),
    })
    this.append(session, 'status', { status: 'running' })
    this.persistRecord(session)

    const callbacks = this.buildCallbacks(session)
    void agent
      .run(prompt, callbacks, images)
      .then(() => {
        if (session.record.status === 'running') {
          session.record.status = 'completed'
        }
      })
      .catch((err: unknown) => {
        if (session.record.status === 'running') {
          session.record.status = 'failed'
          session.record.error = redactText((err as Error)?.message ?? String(err))
          this.append(session, 'error', { error: session.record.error })
        }
      })
      .finally(() => {
        session.running = false
        this.rejectAllPending(session, 'aborted')
        // R1 — turn finished: release this session's exclusive file claims so a
        // peer session can edit those files next. Idempotent / best-effort.
        try { this.getRegistry?.()?.releaseAllClaims(id) } catch { /* non-fatal */ }
        this.touch(session)
        this.append(session, 'done', { status: session.record.status })
        this.persistRecord(session)
        this.maybeWatchdogAutoContinue(session)
      })
    return true
  }

  /**
   * User-dispatched background subagent. Unlike run(), this does NOT set
   * session.running — the worker runs in its own isolated sub-session with an
   * independent abort signal, so it coexists with the main turn and is not
   * killed by aborting the main conversation. Progress streams through the same
   * 'delegation' SSE channel (origin:'user') the viewer panel already consumes.
   */
  delegate(id: string, input: DelegateWorkerInput): DelegateResult {
    const session = this.sessions.get(id)
    if (!session) return { ok: false, reason: 'not_found' }
    const objective = input.objective?.trim()
    if (!objective) return { ok: false, reason: 'invalid' }
    const agent = this.ensureAgent(session)
    if (typeof agent.delegateWorker !== 'function') return { ok: false, reason: 'unsupported' }
    const aborts = session.backgroundAborts ?? (session.backgroundAborts = new Map())
    if (aborts.size >= MAX_USER_BACKGROUND_WORKERS) return { ok: false, reason: 'limit' }
    // Materialize the on-disk log so a reconnecting viewer replays this node.
    this.ensureEvents(session)
    const workerId = `user:${Math.random().toString(36).slice(2, 8)}`
    const controller = new AbortController()
    aborts.set(workerId, controller)
    this.touch(session)
    // Seed the panel with a running node immediately (before the worker spins up).
    this.emitDelegationActivity(session, {
      workOrderId: workerId,
      objective,
      profile: input.profile,
      authority: input.authority,
      status: 'running',
      origin: 'user',
    })
    void agent
      .delegateWorker(
        { ...input, objective },
        {
          workerId,
          signal: controller.signal,
          onActivity: (a) => this.emitDelegationActivity(session, { ...a, origin: 'user' }),
        },
      )
      .catch((err: unknown) => {
        this.emitDelegationActivity(session, {
          workOrderId: workerId,
          status: 'failed',
          summary: redactText((err as Error)?.message ?? String(err)),
          origin: 'user',
        })
      })
      .finally(() => {
        aborts.delete(workerId)
        this.touch(session)
      })
    return { ok: true, workerId }
  }

  /** Cancel a user-dispatched background worker. Returns false if unknown. */
  cancelDelegate(id: string, workerId: string): boolean {
    const controller = this.sessions.get(id)?.backgroundAborts?.get(workerId)
    if (!controller) return false
    controller.abort()
    return true
  }

  private ensureAgent(session: InternalSession): ManagedAgent {
    if (!session.agent) {
      this.ensureJobs(session)
      session.agent = this.createAgent(session.record.cwd, session.record.id, session.approvalMode)
      this.applySelections(session)
      this.warnIfHistoryLost(session)
    }
    return session.agent
  }

  /**
   * Surface the "UI has history, model has none" divergence. A rehydrated
   * session replays its full event log to the viewer, but the model context is
   * restored separately from the session .jsonl — if that read failed or came
   * back empty while the event log clearly holds a prior conversation, warn in
   * the timeline instead of letting the user talk to an amnesiac model.
   * Best-effort: only fires when prior events are resident (run() calls
   * ensureEvents first, so the main prompt path always has them).
   */
  private warnIfHistoryLost(session: InternalSession): void {
    const info = session.agent?.getHistoryRestore?.()
    if (!info) return
    if (!info.error && info.restored > 0) return
    const hadConversation = session.events.some((e) => e.type === 'user')
    if (!hadConversation) return
    this.append(session, 'phase', {
      phase: info.error
        ? `⚠️ 历史上下文恢复失败（${redactText(info.error)}）——模型不记得此前的对话，界面历史仅供查看`
        : '⚠️ 历史上下文为空——会话记录文件缺失或已损坏，模型不记得此前的对话，界面历史仅供查看',
      historyRestore: { restored: info.restored, ...(info.error ? { error: redactText(info.error) } : {}) },
    })
  }

  /** Lazily create the server-owned background job registry for a session and
   *  wire its lifecycle events into the SSE stream. Idempotent. */
  private ensureJobs(session: InternalSession): SessionJobs {
    if (!session.jobs) {
      const jobs = new SessionJobs(join(session.record.cwd, '.rivet', 'artifacts', 'jobs'))
      jobs.on('event', (ev: JobEvent) => {
        this.append(session, 'job', {
          id: ev.job.id,
          command: ev.job.command,
          status: ev.job.status,
          exitCode: ev.job.exitCode,
          startedAt: ev.job.startedAt,
          endedAt: ev.job.endedAt,
          lastLine: ev.job.lastLine,
          pid: ev.job.pid,
          kind: ev.kind,
          ...(ev.chunk ? { chunk: ev.chunk } : {}),
        })
      })
      session.jobs = jobs
    }
    return session.jobs
  }

  /**
   * Re-apply the session's PlusMenu selections (star domain, disabled skills) to
   * its live agent. Idempotent — called both after a lazy build (ensureAgent)
   * and after a model rebuild (switchModel) so the selections survive a fresh
   * AgentLoop. A domainState of undefined means Auto → leave the agent's own
   * auto-detection untouched.
   */
  private applySelections(session: InternalSession): void {
    const agent = session.agent
    if (!agent) return
    // Bind the server-owned job registry so background jobs + their SSE events
    // survive agent rebuilds (switchModel builds a fresh AgentLoop).
    try {
      if (session.jobs) agent.setJobs?.(session.jobs)
    } catch { /* non-fatal */ }
    try {
      if (session.domainState === null) agent.setSessionDomain?.(null)
      else if (session.domainState !== undefined) agent.setSessionDomain?.(session.domainState)
    } catch { /* non-fatal */ }
    try {
      if (session.disabledSkills.size > 0) agent.setDisabledSkills?.(new Set(session.disabledSkills))
    } catch { /* non-fatal */ }
    // 主动 plan mode：模型经 plan action=enter_mode 自主切换时，把状态镜像到
    // session record 并发 plan_mode SSE（桌面切 Plan tab）。server 自己触发的
    // 切换（setPlanMode/approve/reject）已直接 append —— 状态相同时跳过防重复。
    agent.onPlanModeChange = (state: PlanModeState) => {
      if (session.record.planMode === state) return
      session.record.planMode = state
      this.touch(session)
      this.append(session, 'plan_mode', { state })
      this.persistRecord(session)
    }
    // Plan mode 是 AgentLoop 的内存态，record.planMode 是持久态。agent 重建
    // （懒构建恢复会话 / switchModel）会丢内存态：工具门禁失效、
    // getActivePlanFilePath 变 null → 桌面「起草中」实时视图断流。record 说
    // planning 时补一次 enterPlanMode（新开草稿文件），恢复两条通道。
    // onPlanModeChange 的同态守卫保证不会重复发 plan_mode SSE。
    if (session.record.planMode === 'planning') {
      try { agent.enterPlanMode?.() } catch { /* non-fatal */ }
    }
  }

  // ── PlusMenu: star domain ─────────────────────────────────────

  /**
   * PlusMenu — list the domain picker entries for this session (Auto /
   * built-in + custom domains) with the session's current selection flagged.
   * Returns undefined when the session is missing.
   */
  listDomains(id: string): DomainPickerEntry[] | undefined {
    const session = this.sessions.get(id)
    if (!session) return undefined
    return buildDomainPickerEntries(session.domainState)
  }

  /**
   * PlusMenu — set the session's star domain by selection key (auto | off |
   * <domainId>). Updates the stored selection (applied on lazy build), live-
   * mutates an already-built agent, persists the key, and emits domain_changed.
   * Returns false when the session is missing or the key is unknown.
   */
  setDomain(id: string, key: string): boolean {
    const session = this.sessions.get(id)
    if (!session) return false
    const resolved = resolveDomainState(key)
    if (!resolved) return false
    session.domainState = resolved.state
    session.record.domain = resolved.key
    try {
      if (resolved.state === undefined) session.agent?.resetSessionDomain?.()
      else session.agent?.setSessionDomain?.(resolved.state)
    } catch { /* non-fatal */ }
    this.touch(session)
    this.append(session, 'domain_changed', { key: resolved.key, name: resolved.label })
    this.persistRecord(session)
    return true
  }

  // ── PlusMenu: model ───────────────────────────────────────────

  /**
   * PlusMenu — list selectable models for this session, flagging the current
   * one. Returns undefined when the session is missing. Empty when no provider
   * model source was injected (tests).
   */
  listModels(id: string): ModelEntry[] | undefined {
    const session = this.sessions.get(id)
    if (!session) return undefined
    const current = session.record.model
    const all = this.listModelsFn?.() ?? []
    return all.map((m) => ({ ...m, current: m.id === current || m.alias === current }))
  }

  /**
   * PlusMenu — hot-switch the session's model, preserving conversation history.
   * Refuses while the session is running (caller must abort first), rebuilds the
   * agent on the new model (same SessionContext), re-applies domain/skill
   * selections, persists record.model, and emits model_switched. Returns false
   * when the session is missing/running or the model id is unknown.
   */
  switchModel(id: string, modelId: string): boolean {
    const session = this.sessions.get(id)
    if (!session || session.running) return false
    const agent = this.ensureAgent(session)
    let resolved: string | null
    try {
      resolved = agent.switchModel?.(modelId) ?? null
    } catch {
      return false
    }
    if (!resolved) return false
    // The rebuild produced a fresh AgentLoop — re-bind per-session selections.
    this.applySelections(session)
    session.record.model = resolved
    this.touch(session)
    this.append(session, 'model_switched', { modelId: resolved })
    this.persistRecord(session)
    return true
  }

  // ── PlusMenu: skills ──────────────────────────────────────────

  /**
   * PlusMenu — list every loaded skill with its per-session enablement status.
   * Returns undefined when the session is missing.
   */
  listSkills(id: string): SkillStatus[] | undefined {
    const session = this.sessions.get(id)
    if (!session) return undefined
    return skillRegistry.list().map((s) => ({
      name: s.name,
      description: s.description,
      source: s.source ?? (s.builtIn ? 'builtin' : 'rivet'),
      enabled: !session.disabledSkills.has(s.name),
    }))
  }

  /**
   * Skills that failed to load from .rivet/skills for this session (malformed
   * frontmatter, etc.). Surfaced by GET /skills so an installed-but-unparseable
   * skill is visible rather than silently missing. Returns undefined when the
   * session is missing.
   */
  getSkillLoadErrors(id: string): string[] | undefined {
    const session = this.sessions.get(id)
    if (!session) return undefined
    return [...session.skillLoadErrors]
  }

  /**
   * PlusMenu — enable/disable a skill for this session. Updates the disabled
   * set, live-applies it to an already-built agent's discovery filter, and emits
   * skills_changed. Returns false when the session is missing.
   */
  setSkillEnabled(id: string, name: string, enabled: boolean): boolean {
    const session = this.sessions.get(id)
    if (!session) return false
    if (enabled) session.disabledSkills.delete(name)
    else session.disabledSkills.add(name)
    try { session.agent?.setDisabledSkills?.(new Set(session.disabledSkills)) } catch { /* non-fatal */ }
    this.touch(session)
    this.append(session, 'skills_changed', { name, enabled })
    return true
  }

  /**
   * Skills install — list skills discoverable under .claude/skills that can be
   * copied into this session's project .rivet/skills. Read-only; returns
   * undefined when the session is missing.
   */
  listInstallableSkills(id: string): InstallableSkill[] | undefined {
    const session = this.sessions.get(id)
    if (!session) return undefined
    return listInstallableSkills(session.record.cwd)
  }

  /**
   * Skills install — count skills already installed under .rivet/skills. Drives
   * the soft install cap in UIs. Returns undefined when the session is missing.
   */
  installedSkillCount(id: string): number | undefined {
    const session = this.sessions.get(id)
    if (!session) return undefined
    return countInstalledSkills(session.record.cwd)
  }

  /**
   * Skills install — copy the named skills from .claude/skills into the project
   * .rivet/skills (idempotent; already-present ones are skipped). Intentionally
   * does NOT hot-load into the live registry or emit skills_changed: changing
   * the available-skill set mid-session shatters the prefix cache. The copied
   * skills take effect on the next session. Returns undefined when missing.
   */
  installSkills(id: string, names: string[]): { copied: string[]; skipped: string[]; errors: string[] } | undefined {
    const session = this.sessions.get(id)
    if (!session) return undefined
    return importSkillsIntoRivet(session.record.cwd, names)
  }

  /**
   * S — set the per-session autonomy level. Updates the stored override (so it
   * applies when the agent is first built) AND live-mutates an already-built
   * agent (so a mid-session toggle takes effect on the next tool, no rebuild).
   * Returns false when the session is missing. Persists the new mode onto the
   * record so reconnecting viewers see the current level.
   */
  setApprovalMode(id: string, mode: ApprovalMode): boolean {
    const session = this.sessions.get(id)
    if (!session) return false
    session.approvalMode = mode
    session.record.approvalMode = mode
    try { session.agent?.setApprovalMode?.(mode) } catch { /* non-fatal */ }
    this.touch(session)
    this.persistRecord(session)
    return true
  }

  /**
   * Plan mode — toggle the session between read-only planning and normal
   * execution. Building the agent eagerly here (ensureAgent) so the toggle binds
   * to the same instance a later run() reuses. Emits a `plan_mode` event so the
   * desktop can flip its mode chip / open the plan column. Returns false when the
   * session is missing.
   */
  setPlanMode(id: string, state: PlanModeState): boolean {
    const session = this.sessions.get(id)
    if (!session) return false
    const agent = this.ensureAgent(session)
    session.record.planMode = state
    try {
      if (state === 'planning') agent.enterPlanMode?.()
      else agent.exitPlanMode?.()
    } catch { /* non-fatal */ }
    this.touch(session)
    this.append(session, 'plan_mode', { state })
    this.persistRecord(session)
    return true
  }

  /** List this session's plans (newest first). null when the session is gone. */
  async listPlans(id: string): Promise<PlanDocument[] | null> {
    const session = this.sessions.get(id)
    if (!session) return null
    try {
      return await storeListPlans(session.record.cwd)
    } catch {
      return []
    }
  }

  /**
   * Active plan-mode draft — the working document the agent writes while
   * planning. Drafts are NOT submitted plans (listPlans filters them); the
   * desktop renders this as a live "起草中" view instead. Returns `undefined`
   * when the session is missing, `null` when it exists but is not planning
   * or has no readable draft. Title is the draft's H1, null while empty.
   */
  async readPlanDraft(id: string): Promise<PlanDraft | null | undefined> {
    const session = this.sessions.get(id)
    if (!session) return undefined
    if (session.record.planMode !== 'planning') return null
    const path = session.agent?.getActivePlanFilePath?.() ?? null
    if (!path) return null
    try {
      const content = await readFile(join(session.record.cwd, path), 'utf-8')
      const h1 = content.match(/^#\s+(.+)$/m)
      return { path, title: h1 ? h1[1]!.trim() : null, content }
    } catch {
      return null
    }
  }

  /**
   * Read a single plan's full content. Returns `undefined` when the session is
   * missing and `null` when the session exists but the plan does not — letting
   * the route distinguish 404 reasons.
   */
  async readPlan(id: string, slug: string): Promise<PlanDocument | null | undefined> {
    const session = this.sessions.get(id)
    if (!session) return undefined
    try {
      return await storeReadPlan(session.record.cwd, slug)
    } catch {
      return null
    }
  }

  /**
   * Edit a submitted plan's markdown before approval (desktop plan editing —
   * Cursor 3.0 parity: review → tweak the document → Build). Only `submitted`
   * plans are editable; approved/executed are historical records and rejected
   * are archived. Emits `plan_submitted` so viewers re-fetch the body.
   */
  async updatePlan(id: string, slug: string, content: string): Promise<PlanUpdateOutcome> {
    const session = this.sessions.get(id)
    if (!session) return { ok: false, code: 'session-missing', reason: 'Session not found' }
    const trimmed = content.trim()
    if (!trimmed) return { ok: false, code: 'empty-content', reason: 'Plan content must not be empty' }
    const existing = await storeReadPlan(session.record.cwd, slug)
    if (!existing) return { ok: false, code: 'plan-not-found', reason: `Plan not found: "${slug}"` }
    if (existing.status !== 'submitted') {
      return { ok: false, code: 'not-editable', reason: `Only submitted plans can be edited (status: ${existing.status})` }
    }
    // Options: honour a frontmatter block the editor kept/changed; fall back to
    // the recorded ones so a body-only edit never silently drops the choices.
    const options = parsePlanOptions(content) ?? existing.options
    try {
      await storeWritePlan(session.record.cwd, slug, content, options)
    } catch {
      return { ok: false, code: 'plan-not-found', reason: `Failed to write plan "${slug}"` }
    }
    const updated = await storeReadPlan(session.record.cwd, slug)
    this.touch(session)
    this.append(session, 'plan_submitted', {
      slug,
      title: updated?.title ?? existing.title,
      status: 'submitted',
    })
    this.persistRecord(session)
    return { ok: true }
  }

  /**
   * Build (approve) a plan: run the shared approval guards (content validation +
   * anchor-drift recheck), mark it approved on disk, release plan mode, then
   * inject the wave-execution kickoff as the next turn. Returns a structured
   * failure so the route can surface WHY approval was refused (the old boolean
   * collapsed "session running" / "empty plan" / "bad option" into one 409).
   */
  async approvePlan(id: string, slug: string, selectedApproach?: string): Promise<PlanApprovalOutcome> {
    const session = this.sessions.get(id)
    if (!session) return { ok: false, code: 'session-missing', reason: 'Session not found' }
    if (session.running) {
      return { ok: false, code: 'session-running', reason: 'Session is running — wait for the current turn to finish before Build' }
    }
    // Validate the selected approach BEFORE mutating the plan file — approving
    // first would leave the file marked APPROVED even when the option is bogus.
    let resolvedApproach: string | undefined
    if (selectedApproach?.trim()) {
      const pending = await storeReadPlan(session.record.cwd, slug)
      if (!pending) return { ok: false, code: 'plan-not-found', reason: `Plan not found: "${slug}"` }
      if (pending.options && pending.options.length > 0) {
        resolvedApproach = resolvePlanOptionLabel(pending.options, selectedApproach)
        if (!resolvedApproach) {
          return { ok: false, code: 'bad-approach', reason: `Unknown selectedApproach "${selectedApproach}"` }
        }
      } else {
        // No recorded options — pass the user's text through as-is.
        resolvedApproach = selectedApproach.trim()
      }
    }
    // Shared approval kernel (same closed loop as TUI /plan-approve): empty/
    // placeholder plans hard-fail, anchor drift is rechecked and injected into
    // the kickoff, and the kickoff drives wave-by-wave execution through the
    // review gates (plan_task/team_orchestrate + plan_close).
    let result: PlanApprovalResult
    try {
      result = await approvePlanWithGuards(session.record.cwd, slug, resolvedApproach)
    } catch {
      return { ok: false, code: 'plan-not-found', reason: `Plan not found: "${slug}"` }
    }
    if (!result.ok) {
      return {
        ok: false,
        code: result.code === 'invalid-content' ? 'invalid-content' : 'plan-not-found',
        reason: result.reason,
      }
    }
    const { approved, kickoff } = result
    const agent = this.ensureAgent(session)
    try {
      agent.setActivePlan?.({
        slug,
        title: approved.title,
        selectedApproach: resolvedApproach,
      })
    } catch { /* non-fatal */ }
    try { agent.exitPlanMode?.() } catch { /* non-fatal */ }
    // agent.onPlanModeChange 可能已镜像 record 并发过 plan_mode —— 条件补发防重复，
    // 同时兜底不支持回调的轻量 double。
    if (session.record.planMode !== 'off') {
      session.record.planMode = 'off'
      this.append(session, 'plan_mode', { state: 'off' })
    }
    this.touch(session)
    this.persistRecord(session)
    this.run(id, kickoff)
    return { ok: true }
  }

  /**
   * Reject a plan with optional feedback. Keeps the plan on disk (marked
   * rejected) and re-enters plan mode. Revision feedback routing depends on
   * session state: idle → kick a revision turn immediately; running → queue
   * through the steer buffer (injected at the next tool boundary), so mid-run
   * feedback is never silently dropped. Emits `plan_submitted` to refresh
   * viewers.
   */
  async rejectPlan(id: string, slug: string, comment?: string): Promise<boolean> {
    const session = this.sessions.get(id)
    if (!session) return false
    let rejected: PlanDocument | null
    try {
      rejected = await storeRejectPlan(session.record.cwd, slug)
    } catch {
      return false
    }
    if (!rejected) return false
    const agent = this.ensureAgent(session)
    try {
      agent.enterPlanMode?.({ planFilePath: `.rivet/plans/${slug}.md` })
    } catch { /* non-fatal */ }
    // 同 approvePlan：enterPlanMode 的 onPlanModeChange 回调可能已发过 plan_mode。
    if (session.record.planMode !== 'planning') {
      session.record.planMode = 'planning'
      this.append(session, 'plan_mode', { state: 'planning' })
    }
    this.append(session, 'plan_submitted', { slug, title: rejected.title, status: 'rejected' })
    this.touch(session)
    this.persistRecord(session)
    const note = comment?.trim()
    if (note) {
      const revisionPrompt = `User rejected the plan. Feedback:\n\n${note}\n\nRevise the plan in \`.rivet/plans/${slug}.md\`, then call plan action=submit again.`
      if (session.running) {
        // Mid-run rejection: the feedback rides the steer buffer (next tool
        // boundary) instead of being dropped — the old code only handled idle.
        session.steer.push(revisionPrompt)
        this.append(session, 'steer_queued', { text: redactText(revisionPrompt) })
      } else {
        this.run(id, revisionPrompt)
      }
    }
    return true
  }

  /**
   * T3 — queue mid-run user guidance. Unlike run(), this does NOT start a turn:
   * the text is buffered and injected at the next tool boundary (onSteerDrain).
   * Only meaningful while running — an idle session has no turn to steer.
   *
   * Returns:
   *  - 'queued'    guidance accepted into the running session's buffer
   *  - 'idle'      session exists but is not running (caller should use /prompt)
   *  - 'not_found' no such session
   */
  steer(id: string, text: string): 'queued' | 'idle' | 'not_found' {
    const session = this.sessions.get(id)
    if (!session) return 'not_found'
    if (!session.running) return 'idle'
    session.steer.push(text)
    // Echo into the event log so the thread reflects the queued guidance and
    // reconnecting viewers see it (append-only, like the user turn echo).
    this.append(session, 'steer_queued', { text: redactText(text) })
    this.touch(session)
    return 'queued'
  }

  /**
   * N2 — artifact feedback re-injection. Turns a human comment on an artifact
   * into a structured next-turn prompt so the agent revises in-context. Only
   * valid on an idle session (a finished turn); returns false while running.
   *
   * `lines` carries diff line-level review comments (file + old/new line +
   * comment), surfaced as a `[LINE-LEVEL REVIEW]` block so the agent can locate
   * each remark at an exact file:line anchor. Artifacts-level `comment` and
   * `lines` are both optional but at least one must be non-empty.
   */
  feedback(
    id: string,
    artifactId: string,
    comment: string,
    lines?: ReadonlyArray<{ file: string; oldLine?: number; newLine?: number; comment: string }>,
  ): boolean {
    const s = this.sessions.get(id)
    if (!s || s.running) return false
    this.ensureEvents(s)
    const meta = [...s.events].reverse().find(
      (e) => e.type === 'artifact' && e.data.id === artifactId,
    )
    const target = meta ? String(meta.data.target ?? '') : ''
    const parts: string[] = [`[ARTIFACT FEEDBACK]`]
    parts.push(`Artifact: ${artifactId}${target ? ` (${target})` : ''}`)
    if (comment.trim()) {
      parts.push(`Comment: ${comment}`)
    }
    // 行级评论：每条带 <file>:<line> 锚点，让 agent 精确定位
    const lineRemarks = lines?.filter((l) => l.comment.trim()) ?? []
    if (lineRemarks.length > 0) {
      const rendered = lineRemarks
        .map((l) => {
          const lineRef = l.newLine ?? l.oldLine
          const loc = lineRef != null ? `${l.file}:${lineRef}` : l.file
          return `${loc} — ${l.comment.trim()}`
        })
        .join('\n')
      parts.push(`[LINE-LEVEL REVIEW]\n${rendered}`)
    }
    const prompt = `${parts.join('\n')}\n\nPlease revise your work to address this feedback.`
    return this.run(id, prompt)
  }

  /**
   * Start a run and resolve when it reaches a terminal state (N3 — used by the
   * runtime pool so scheduled tasks can report a summary). Returns immediately
   * with a failed result if the session is missing or already busy.
   */
  runAndWait(
    id: string,
    prompt: string,
  ): Promise<{ status: SessionStatus; summary: string; changedFiles: string[] }> {
    return new Promise((resolve) => {
      const s = this.sessions.get(id)
      if (!s || s.running) {
        resolve({ status: 'failed', summary: 'session missing or busy', changedFiles: [] })
        return
      }
      const unsub = this.subscribe(id, (e) => {
        if (e.type === 'done') {
          unsub?.()
          resolve({
            status: s.record.status,
            summary: this.buildRunSummary(s),
            changedFiles: this.collectChangedFiles(s),
          })
        }
      })
      if (!this.run(id, prompt)) {
        unsub?.()
        resolve({ status: 'failed', summary: 'failed to start', changedFiles: [] })
      }
    })
  }

  private buildRunSummary(session: InternalSession): string {
    // Last assistant text run is the closest thing to a result summary.
    for (let i = session.events.length - 1; i >= 0; i--) {
      const e = session.events[i]!
      if (e.type === 'text_delta') {
        const text = String(e.data.text ?? '').trim()
        if (text) return text.slice(0, 500)
      }
    }
    return `status=${session.record.status}`
  }

  private collectChangedFiles(session: InternalSession): string[] {
    const files = new Set<string>()
    for (const e of session.events) {
      if (e.type !== 'tool_use') continue
      const name = String(e.data.name ?? '')
      if (name !== 'edit_file' && name !== 'write_file' && name !== 'apply_patch') continue
      const input = e.data.input as Record<string, unknown> | undefined
      const path = input && typeof input.path === 'string' ? input.path : null
      if (path) files.add(path)
    }
    return [...files]
  }

  listSessions(): SessionRecord[] {
    return [...this.sessions.values()]
      .filter((s) => !s.record.archived)
      .map((s) => this.enrichRecord(s))
  }

  listAllSessions(): SessionRecord[] {
    return [...this.sessions.values()].map((s) => this.enrichRecord(s))
  }

  /** Enrich a session record with live context usage when the agent is awake. */
  private enrichRecord(s: InternalSession): SessionRecord {
    const record = { ...s.record }
    if (s.agent) {
      try { record.contextTokens = s.agent.getEstimatedTokens?.() } catch { /* non-fatal */ }
      try { record.contextWindow = s.agent.getContextWindow?.() } catch { /* non-fatal */ }
      try { record.reasoningEffort = s.agent.getReasoningEffort?.() } catch { /* non-fatal */ }
    }
    const persona = resolveDomainPersona(record.domain)
    record.domainGlyph = persona.glyph
    record.domainAccent = persona.accent
    return record
  }

  getSession(id: string): SessionRecord | undefined {
    const s = this.sessions.get(id)
    if (!s) return undefined
    return this.enrichRecord(s)
  }

  /**
   * I1: expose the live ManagedAgent for a session so surfaces like
   * CouncilSurface can call agent-specific methods (conveneCouncil). Returns
   * undefined when the session is missing or has no built agent yet.
   */
  getAgentForSession(id: string): ManagedAgent | undefined {
    const s = this.sessions.get(id)
    if (!s) return undefined
    return s.agent ?? undefined
  }

  /**
   * I4: append a `hook_result` event for user-defined .rivet/hooks.json scripts.
   * Retains only the latest 50 hook_result events so diagnostic noise does not
   * evict user messages from the main ring buffer.
   */
  emitHookResult(
    id: string,
    results: HookResult[],
    meta: { event: HookEvent; turn?: number; toolName?: string; error?: string },
  ): void {
    const s = this.sessions.get(id)
    if (!s) return
    this.append(s, 'hook_result', {
      event: meta.event,
      turn: meta.turn,
      toolName: meta.toolName,
      error: meta.error,
      results,
    })
    this.trimHookResults(s)
  }

  private trimHookResults(session: InternalSession): void {
    const hookEvents = session.events.filter((e) => e.type === 'hook_result')
    if (hookEvents.length <= 50) return
    const toDrop = hookEvents.length - 50
    const dropped = new Set(hookEvents.slice(0, toDrop))
    session.events = session.events.filter((e) => !dropped.has(e))
  }

  getEvents(id: string, since = 0): { events: SessionEvent[]; lastSeq: number } | undefined {
    const s = this.sessions.get(id)
    if (!s) return undefined
    // Reconnect/replay entry point — lazy-load the log from disk on first open.
    this.ensureEvents(s)
    const events = s.events.filter((e) => e.seq > since)
    return { events, lastSeq: s.seq }
  }

  /** Live event subscription for SSE. Unsubscribing never aborts the run. */
  subscribe(id: string, listener: (e: SessionEvent) => void): (() => void) | undefined {
    const s = this.sessions.get(id)
    if (!s) return undefined
    s.listeners.add(listener)
    return () => { s.listeners.delete(listener) }
  }

  abort(id: string): boolean {
    const s = this.sessions.get(id)
    if (!s) return false
    if (s.record.status === 'running') {
      s.record.status = 'aborted'
    }
    // 窄窗口竞态修复：watchdog stall 后 finally → setImmediate 续跑之间，用户
    // abort 对已停会话是空操作。设此标记让 setImmediate 守卫放弃续跑。
    s.watchdogRecoveryCancelled = true
    // C2 — 取消进行中的续跑倒计时（用户点了「取消」或 Esc）。
    if (s.watchdogContinueTimer) {
      clearTimeout(s.watchdogContinueTimer)
      s.watchdogContinueTimer = undefined
      this.append(s, 'watchdog_recovery', { cancelled: true })
    }
    s.agent?.abort()
    this.rejectAllPending(s, 'aborted')
    this.touch(s)
    this.append(s, 'status', { status: 'aborted' })
    this.persistRecord(s)
    return true
  }

  abortAll(): void {
    for (const id of this.sessions.keys()) this.abort(id)
  }

  /**
   * Wave L: 进程退出路径（runServe.close）触发——为每个 session 调
   * agent.shutdown() 释放 coordinator/timer/in-flight worker 句柄。与
   * abortAll() 分离：abortAll 仅中止当前 turn，shutdownAll 是终结性操作。
   * best-effort：任一 session shutdown 抛错不影响其他。
   */
  shutdownAll(): void {
    for (const s of this.sessions.values()) {
      try { s.agent?.shutdown?.() } catch { /* best-effort */ }
      try { s.jobs?.killAll() } catch { /* best-effort */ }
    }
    // Flush any buffered events to disk before exit.
    this.persistence?.flushSync?.()
  }

  /**
   * Archive (soft-close) a session: abort if running, mark `archived=true`, and
   * persist. The session is excluded from listSessions() but its data survives on
   * disk (events.jsonl / artifacts) — rehydrate still restores it as archived.
   * Returns false when the session is missing or already archived.
   */
  archiveSession(id: string): boolean {
    const s = this.sessions.get(id)
    if (!s || s.record.archived) return false
    // Stop any in-flight run first (mirrors abort's cleanup).
    if (s.running) {
      s.record.status = 'aborted'
      s.agent?.abort()
      this.rejectAllPending(s, 'aborted')
    }
    s.record.archived = true
    s.running = false
    // Clean up isolated worktree on archive. Guard against data loss: if the
    // worktree has uncommitted changes, checkpoint-commit them first; if the
    // branch carries commits not merged into the main workspace, keep the
    // branch (only the worktree directory is removed) so work stays landable.
    let branchKept = false
    if (s.record.worktreePath) {
      try {
        const work = hasUnlandedWork(this.defaultCwd, s.record.worktreePath, s.record.worktreeBranch)
        if (work.dirty) {
          // worktree remove --force discards uncommitted changes — snapshot them.
          commitAll(s.record.worktreePath, 'rivet: archive checkpoint', { noVerify: true })
        }
        const after = work.dirty || work.unmergedCommits > 0
          ? hasUnlandedWork(this.defaultCwd, s.record.worktreePath, s.record.worktreeBranch)
          : work
        // Squash merge-back leaves branch commits unreachable from main —
        // the landedHead marker proves they were landed. A branch head that
        // hasn't moved past the last merge-back is safe to delete.
        const landed = Boolean(s.record.landedHead)
          && revParseHead(s.record.worktreePath) === s.record.landedHead
        branchKept = Boolean(s.record.worktreeBranch) && after.unmergedCommits > 0 && !landed
        removeWorktree(this.defaultCwd, s.record.worktreePath, s.record.worktreeBranch, { keepBranch: branchKept })
      } catch { /* non-fatal */ }
    }
    this.touch(s)
    this.append(s, 'status', branchKept
      ? { status: 'archived', branchKept: true, worktreeBranch: s.record.worktreeBranch }
      : { status: 'archived' })
    this.persistRecord(s)
    try { this.getRegistry?.()?.releaseAllClaims(id) } catch (e) { console.warn('releaseAllClaims failed during archive:', e) }
    return true
  }

  /**
   * Unarchive (restore) a previously archived session. Returns it to the active
   * list and resets status to idle. Returns false when missing or not archived.
   */
  unarchiveSession(id: string): boolean {
    const s = this.sessions.get(id)
    if (!s || !s.record.archived) return false
    s.record.archived = false
    s.record.status = 'idle'
    this.touch(s)
    this.persistRecord(s)
    return true
  }

  /**
   * Rename a session. Updates the record title and persists it.
   * Returns false when the session is missing.
   */
  setTitle(id: string, title: string): boolean {
    const s = this.sessions.get(id)
    if (!s) return false
    s.record.title = title.trim()
    this.touch(s)
    this.persistRecord(s)
    return true
  }

  /** List git worktrees for a given cwd (defaults to the manager's default cwd). */
  getWorktrees(cwd?: string): WorktreeEntry[] {
    return listWorktrees(cwd ?? this.defaultCwd)
  }

  /** ASCII branch/merge graph for a given cwd (defaults to the manager's default cwd). */
  async getGitGraph(cwd?: string, maxCount?: number): Promise<string> {
    return getGitGraph(cwd ?? this.defaultCwd, maxCount)
  }

  /** Working-tree changes relative to HEAD for the desktop "changes" tab. */
  async getWorkingTreeFiles(cwd?: string): Promise<{ files: WorkingTreeFile[]; isRepo: boolean }> {
    return getWorkingTreeFiles(cwd ?? this.defaultCwd)
  }

  /** Unified diff of a single file relative to HEAD (on-demand). */
  async getFileDiff(path: string, cwd?: string): Promise<string> {
    return getFileDiff(cwd ?? this.defaultCwd, path)
  }

  /**
   * Resolve the git context of a session: worktree cwd (falls back to the
   * shared default cwd) and the diff baseline (recorded creation HEAD for
   * worktree sessions, plain HEAD otherwise).
   */
  private sessionGitContext(id: string): { cwd: string; baseRef: string } | null {
    const s = this.sessions.get(id)
    if (!s) return null
    const cwd = s.record.worktreePath ?? this.defaultCwd
    const baseRef = s.record.baselineHead ?? 'HEAD'
    return { cwd, baseRef }
  }

  /** Session-scoped working-tree changes (worktree cwd + task baseline). */
  async getSessionWorkingTree(id: string): Promise<{ files: WorkingTreeFile[]; isRepo: boolean } | null> {
    const ctx = this.sessionGitContext(id)
    if (!ctx) return null
    const result = await getWorkingTreeFiles(ctx.cwd, ctx.baseRef)
    // The worktree owner marker is infrastructure, not user work — hide it.
    return { ...result, files: result.files.filter(f => f.path !== '.vsw-owner.json') }
  }

  /** Session-scoped single-file diff (worktree cwd + task baseline). */
  async getSessionFileDiff(id: string, path: string): Promise<string | null> {
    const ctx = this.sessionGitContext(id)
    if (!ctx) return null
    return getFileDiff(ctx.cwd, path, ctx.baseRef)
  }

  // ── Change landing (desktop Changes tab: Commit / Merge back / Create PR) ──

  /**
   * Stage and commit everything in the session's cwd (worktree for isolated
   * sessions, shared cwd otherwise). Server-direct path of the dual-channel
   * design — the "let the agent commit" path goes through a normal prompt.
   */
  commitSessionChanges(id: string, message?: string): { ok: boolean; sha?: string; nothingToCommit?: boolean; error?: string } | null {
    const s = this.sessions.get(id)
    if (!s) return null
    const cwd = s.record.worktreePath ?? this.defaultCwd
    const fallback = `rivet: ${s.record.title?.trim() || `session ${id.slice(0, 8)}`} changes`
    const result = commitAll(cwd, message?.trim() || fallback)
    if (result.ok && result.sha) {
      this.append(s, 'landing', { action: 'commit', sha: result.sha })
      this.touch(s)
    }
    return result
  }

  /**
   * Squash-merge the session's worktree branch into the main workspace's
   * current branch. Uncommitted worktree changes are committed first so the
   * squash captures the full task delta. Fail-closed on dirty main workspace
   * or conflicts (rolled back, conflict files reported).
   */
  mergeSessionBack(id: string): { ok: boolean; sha?: string; nothingToMerge?: boolean; conflictFiles?: string[]; error?: string } | null {
    const s = this.sessions.get(id)
    if (!s) return null
    if (!s.record.worktreeBranch || !s.record.worktreePath) {
      return { ok: false, error: 'not a worktree session — nothing to merge back' }
    }
    // Sweep uncommitted work into the branch first (squash flattens it anyway).
    const checkpoint = commitAll(s.record.worktreePath, 'rivet: pre-merge checkpoint', { noVerify: true })
    if (!checkpoint.ok) return { ok: false, error: `failed to checkpoint worktree: ${checkpoint.error}` }
    const title = s.record.title?.trim() || 'session changes'
    const result = squashMergeBranch(this.defaultCwd, s.record.worktreeBranch, `${title} (rivet session ${id.slice(0, 8)})`)
    if (result.ok) {
      // Squash merges leave the branch commits unreachable from main, so
      // rev-list alone can't prove "landed". Record the branch head at merge
      // time — archive deletes the branch when it hasn't moved past this.
      s.record.landedHead = revParseHead(s.record.worktreePath)
      if (result.sha) this.append(s, 'landing', { action: 'merge_back', sha: result.sha, branch: s.record.worktreeBranch })
      this.touch(s)
      this.persistRecord(s)
    }
    return result
  }

  /**
   * Push the session's worktree branch and open a PR via `gh pr create`.
   * Uncommitted changes are checkpoint-committed first.
   */
  async createSessionPr(id: string, title?: string, body?: string): Promise<{ ok: boolean; url?: string; error?: string } | null> {
    const s = this.sessions.get(id)
    if (!s) return null
    if (!s.record.worktreeBranch || !s.record.worktreePath) {
      return { ok: false, error: 'not a worktree session — create PRs from an isolated worktree session' }
    }
    const checkpoint = commitAll(s.record.worktreePath, 'rivet: pre-PR checkpoint', { noVerify: true })
    if (!checkpoint.ok) return { ok: false, error: `failed to checkpoint worktree: ${checkpoint.error}` }
    const pushed = pushBranch(s.record.worktreePath, s.record.worktreeBranch)
    if (!pushed.ok) return { ok: false, error: `git push failed: ${pushed.error}` }
    const result = await createPr(s.record.worktreePath, {
      title: title?.trim() || s.record.title?.trim(),
      body: body?.trim() || `Created from Rivet session ${id.slice(0, 8)}.`,
    })
    if (result.ok && result.url) {
      this.append(s, 'landing', { action: 'pr_created', url: result.url, branch: s.record.worktreeBranch })
      this.touch(s)
    }
    return result
  }

  /** Expose defaultCwd for routes that need the repo root (e.g. gh CLI). */
  getDefaultCwd(): string {
    return this.defaultCwd
  }

  /**
   * Mount an EXTENDED-layer tool onto the session's agent (workflow auto-mount).
   * Returns the mount status, or undefined if the session/agent lacks enableTool
   * (lightweight doubles). No-op if gating is off (tool already visible).
   */
  enableTool(id: string, name: string): { status: string; cacheImpact: string } | undefined {
    const session = this.sessions.get(id)
    if (!session) return undefined
    const agent = this.ensureAgent(session)
    return agent.enableTool?.(name)
  }

  /**
   * Resolve a pending approval. Returns false if the request is gone.
   * An optional `editedInput` lets the human tweak the tool input
   * (e.g. per-hunk edit picks) before it runs — flows through ApprovalResult.
   * (Intent is now a non-blocking timeline note and has no pending state.)
   */
  answerIntervention(
    id: string,
    requestId: string,
    decision: string,
    editedInput?: Record<string, unknown>,
    remember?: boolean,
  ): boolean {
    const s = this.sessions.get(id)
    if (!s) return false
    const pend = s.pending.get(requestId)
    if (!pend) return false
    s.pending.delete(requestId)
    if (pend.timer) clearTimeout(pend.timer)

    const approved = decision === 'approve' || decision === 'approved'
    const result: ApprovalResult = { approved }
    if (approved && editedInput && typeof editedInput === 'object') {
      result.editedInput = editedInput
    }
    pend.resolve(result)
    if (!approved) s.lastApprovalDeniedAt = this.now()
    // Computer Use "always allow": approve + remember records a machine-level
    // per-app grant so future actions on this app skip the prompt entirely
    // (the tool's requiresApproval consults the same grant store).
    let rememberedApp: string | undefined
    if (approved && remember === true && pend.toolName === 'computer_use') {
      const app = pend.toolInput?.app
      if (typeof app === 'string' && app.trim()) {
        try {
          grantComputerUseApp(app.trim())
          rememberedApp = app.trim()
        } catch { /* grant persistence is best-effort — approval still resolves */ }
      }
    }
    this.recountApprovals(s)
    this.append(s, 'approval_resolved', {
      requestId,
      decision: approved ? 'approve' : 'reject',
      edited: !!result.editedInput,
      ...(rememberedApp ? { rememberedApp } : {}),
    })
    this.touch(s)
    this.persistRecord(s)
    return true
  }

  /** List background jobs for a session. undefined = session missing. */
  listJobs(id: string): import('../tools/job-store.js').JobSnapshot[] | undefined {
    const s = this.sessions.get(id)
    if (!s) return undefined
    return s.jobs?.list() ?? []
  }

  /** Full captured output of a background job. undefined = session/job missing. */
  getJobLogs(id: string, jobId: string): string | undefined {
    const s = this.sessions.get(id)
    if (!s) return undefined
    return s.jobs?.logs(jobId) ?? undefined
  }

  /** Terminate a background job. Returns false when session/job is missing. */
  killJob(id: string, jobId: string): boolean {
    const s = this.sessions.get(id)
    if (!s || !s.jobs) return false
    return s.jobs.kill(jobId)
  }

  listArtifacts(id: string): Artifact[] | undefined {
    const s = this.sessions.get(id)
    if (!s) return undefined
    // Rehydrated/idle sessions have no live agent — read the artifact log
    // straight off disk (index + raw files survive a sidecar restart).
    if (!s.agent) return this.rehydratedArtifactStore(s).list()
    return s.agent.listArtifacts()
  }

  readArtifact(id: string, artifactId: string): Promise<string | null> | undefined {
    const s = this.sessions.get(id)
    if (!s) return undefined
    if (!s.agent) return this.rehydratedArtifactStore(s).readRaw(artifactId)
    return s.agent.readArtifact(artifactId)
  }

  /**
   * Build (once) a read-only ArtifactStore over the session's persisted
   * artifact directory. Mirrors the layout the live AgentLoop writes:
   * `<cwd>/.rivet/artifacts/<sessionId>`. Construction is cheap and never
   * throws on a missing directory (loadIndex no-ops), so an idle session with
   * no artifacts simply yields an empty list.
   */
  private rehydratedArtifactStore(s: InternalSession): ArtifactStore {
    if (!s.rehydratedArtifacts) {
      const artifactDir = join(s.record.cwd, '.rivet', 'artifacts')
      s.rehydratedArtifacts = new ArtifactStore(artifactDir, s.record.id)
    }
    return s.rehydratedArtifacts
  }

  /**
   * List user messages that can be rewound to. Each entry has the message
   * index (for use with rewind()), the text content, and the event timestamp
   * (derived from the session event log, since OaiMessage has no ts field).
   * Returns empty for sessions without a live agent (rehydrated/idle).
   */
  listRewindPoints(id: string): { index: number; content: string; timestamp: number; seq?: number }[] | undefined {
    const s = this.sessions.get(id)
    if (!s) return undefined
    if (!s.agent) return []
    this.ensureEvents(s)
    const msgs = s.agent.getMessages()
    // Collect user events (seq + ts + text) so we can map each user message to
    // both its submission time AND the seq of its originating `user` event. The
    // seq lets the UI anchor previews/forks on the exact `u-${seq}` block the
    // rewind reducer will cut at — same anchor rewind() emits as anchorSeq.
    const userEvents: { seq: number; ts: number; text: string }[] = []
    for (const e of s.events) {
      if (e.type === 'user') {
        userEvents.push({ seq: e.seq, ts: e.ts, text: String((e.data as { text?: unknown }).text ?? '') })
      }
    }
    const entries: { index: number; content: string; timestamp: number; seq?: number }[] = []
    let userIdx = 0
    for (let i = 0; i < msgs.length; i++) {
      const m = msgs[i]!
      if (m.role === 'user' && typeof m.content === 'string') {
        const ue = userEvents[userIdx]
        // Emit seq only when the ordinal lines up AND the text matches, so a
        // trimmed/diverged event log degrades to the client's text heuristic
        // instead of anchoring on the wrong block.
        const seq = ue && ue.text === m.content ? ue.seq : undefined
        entries.push({
          index: i,
          content: m.content,
          timestamp: ue?.ts ?? 0,
          ...(seq !== undefined ? { seq } : {}),
        })
        userIdx++
      }
    }
    return entries
  }

  /**
   * Rewind a session to a prior message index. Truncates the agent's message
   * list, appends a `rewind` event to the event log (append-only — old events
   * are NOT deleted, so reconnecting clients can see the rewind marker), and
   * optionally rolls back files via the existing checkpoint system.
   *
   * Safety: rejects if session is `running` (caller must abort first).
   */
  rewind(id: string, messageIndex: number, options?: { rollbackFiles?: boolean }): boolean {
    const s = this.sessions.get(id)
    if (!s) return false
    if (s.running) return false
    if (!s.agent) return false
    this.ensureEvents(s)

    const msgs = s.agent.getMessages()
    if (messageIndex < 0 || messageIndex >= msgs.length) return false

    const target = msgs[messageIndex]!
    const prompt = typeof target.content === 'string' ? target.content : ''

    // Resolve a duplicate-proof UI anchor: the seq of the `user` event that
    // produced this rewound message. The rewound message is the N-th user-role
    // string message; the N-th `user` event in the log carries the same text.
    // Emit anchorSeq only when the ordinal lines up AND the text matches, so a
    // trimmed/diverged log silently falls back to the client's text heuristic.
    let userOrdinal = 0
    for (let i = 0; i < messageIndex; i++) {
      const m = msgs[i]!
      if (m.role === 'user' && typeof m.content === 'string') userOrdinal++
    }
    const userEvents = s.events.filter(e => e.type === 'user')
    const anchorEvent = userEvents[userOrdinal]
    const anchorSeq = anchorEvent && anchorEvent.data.text === prompt ? anchorEvent.seq : undefined

    // Truncate messages to the selected point (full derived-state reset).
    s.agent.rewindToMessages(msgs.slice(0, messageIndex))
    s.agent.resetAppendixBaseline?.()

    // Update session status: rewind returns the session to idle so the user
    // can send a new prompt. Previous status (completed/failed) is stale.
    s.record.status = 'idle'
    s.record.error = undefined

    // Append rewind event (append-only — viewers see the marker).
    this.append(s, 'rewind', {
      messageIndex,
      prompt,
      ...(anchorSeq !== undefined ? { anchorSeq } : {}),
      timestamp: this.now(),
    })

    // Optional file rollback via existing checkpoint system.
    if (options?.rollbackFiles) {
      void this.rollbackFiles(s)
    }

    return true
  }

  /** Best-effort file rollback for rewind. Surfaces result via event log. */
  private async rollbackFiles(session: InternalSession): Promise<void> {
    try {
      const { getRollbackPreview, rollbackToCheckpoint, makeOwnershipGuard } = await import('../agent/checkpoint.js')
      const registry = this.getRegistry?.()
      const guard = registry
        ? makeOwnershipGuard(registry, session.record.id, session.record.cwd)
        : undefined
      const preview = await getRollbackPreview(session.record.cwd, session.record.id, guard)
      if (preview) {
        await rollbackToCheckpoint(session.record.cwd, preview.confirmationToken, session.record.id, guard)
      }
    } catch {
      // checkpoint rollback is best-effort; rewind still succeeds on messages
    }
  }

  /**
   * Preview the files a precise (per-message) code rewind would touch. Returns
   * `available: false` when the session has no live agent / FileHistory or no
   * tracked edits after the boundary — the caller can then fall back to the
   * coarse checkpoint rollback (which also covers bash-driven changes).
   */
  previewFilesPrecise(
    id: string,
    messageIndex: number,
  ): { available: boolean; files: { path: string; action: 'restore' | 'delete' }[] } | undefined {
    const s = this.sessions.get(id)
    if (!s) return undefined
    const fh = s.agent?.getFileHistory?.()
    if (!s.agent || !fh) return { available: false, files: [] }
    const msgs = s.agent.getMessages()
    if (messageIndex < 0 || messageIndex >= msgs.length) return { available: false, files: [] }
    const ids = collectPostBoundaryEditIds(msgs, messageIndex)
    const files = fh.getBoundaryFiles(ids)
    return { available: files.length > 0, files }
  }

  /**
   * Precise (per-message) code rewind: restore every agent-edited file to its
   * content as of the selected message; delete files created after it. Does NOT
   * truncate the conversation (that's the separate rewind() path). Rejects while
   * running (unsafe to restore files under an active writer).
   */
  async rewindFilesPrecise(
    id: string,
    messageIndex: number,
  ): Promise<{ success: boolean; filesChanged: string[] } | undefined> {
    const s = this.sessions.get(id)
    if (!s) return undefined
    if (s.running) return { success: false, filesChanged: [] }
    const fh = s.agent?.getFileHistory?.()
    if (!s.agent || !fh) return { success: false, filesChanged: [] }
    const msgs = s.agent.getMessages()
    if (messageIndex < 0 || messageIndex >= msgs.length) return { success: false, filesChanged: [] }
    const ids = collectPostBoundaryEditIds(msgs, messageIndex)
    const filesChanged = await fh.rewindToBoundary(ids)
    return { success: true, filesChanged }
  }

  // ── internals ─────────────────────────────────────────────────

  /**
   * T4 — emit a structured per-worker delegation update to the subagent panel.
   * Extracted from buildCallbacks so the idle user-dispatch path (delegate())
   * can reuse the exact same mapping/elapsed logic. Carries two extra fields:
   * `summary` (terminal digest for the "汇入主会话" adopt button) and `origin`
   * ('user' marks a user-dispatched worker vs an agent auto-delegation).
   */
  private emitDelegationActivity(
    session: InternalSession,
    a: {
      workOrderId: string
      parentToolId?: string
      profile?: string
      authority?: string
      objective?: string
      status: string
      progressLine?: string
      model?: string
      provider?: string
      usage?: DelegationActivity['usage']
      artifactId?: string
      changedFiles?: string[]
      summary?: string
      origin?: 'user' | 'agent'
    },
  ): void {
    const startedMap = session.delegationStartedAt ?? (session.delegationStartedAt = new Map())
    let started = startedMap.get(a.workOrderId)
    if (started === undefined) {
      started = this.now()
      startedMap.set(a.workOrderId, started)
    }
    this.append(session, 'delegation', {
      workerId: a.workOrderId,
      parentId: a.parentToolId,
      profile: a.profile,
      objective: a.objective,
      status: a.status,
      phase: a.status === 'running' ? 'running' : a.status,
      progressLine: a.progressLine ? redactText(a.progressLine) : undefined,
      elapsedMs: this.now() - started,
      model: a.model,
      provider: a.provider,
      usage: a.usage,
      artifactId: a.artifactId,
      changedFiles: a.changedFiles,
      summary: a.summary ? redactText(a.summary) : undefined,
      origin: a.origin,
    })
  }

  private buildCallbacks(session: InternalSession): AgentCallbacks {
    return {
      onTextDelta: (text) => this.append(session, 'text_delta', { text }),
      onThinkingDelta: (thinking) => this.append(session, 'thinking_delta', { text: thinking }),
      onToolUse: (toolId, name, input) => {
        this.append(session, 'tool_use', { id: toolId, name, input: redactValue(input) })
        // N3: surface delegation as a tree node, derived from the tool stream
        // (no core-loop rewrite — stays inside the server layer).
        if (DELEGATION_TOOLS.has(name)) {
          this.append(session, 'delegation', {
            workerId: toolId,
            objective: extractObjective(input),
            profile: typeof input.profile === 'string' ? input.profile : undefined,
            status: 'running',
          })
        }
        // T2: surface the active task list as structured state for the desktop
        // checklist (Codex-style active todo / Antigravity Task Plan).
        if (name === 'todo') {
          const items = extractTodoState(input)
          if (items) this.append(session, 'todo_state', { items })
        }
        // 结构化提问卡片：ask_user_question 的 input 直接携带全部问题/选项，
        // 在 tool_use 时机发 user_question SSE（工具本身只回占位符 + endTurn）。
        // 答案不走新 API —— 桌面卡片把选择组装成普通用户消息回传。
        if (name === 'ask_user_question') {
          const questions = parseAskUserQuestions(input)
          if (questions.length > 0) {
            this.append(session, 'user_question', {
              toolUseId: toolId,
              questions: questions.map(q => ({
                id: q.id,
                prompt: redactText(q.prompt),
                options: q.options.map(o => redactText(o)),
                allowMultiple: q.allowMultiple,
              })),
            })
          }
        }
      },
      onToolResult: (toolId, name, result, isError, _rawPath, uiContent) => {
        // 终态才计进度单元；isError === undefined 是流式 chunk（TUI 侧同款过滤，
        // 否则单次长输出工具就能伪装稀疏 stall）。
        if (isError !== undefined) session.watchdogPolicy?.recordToolResult()
        this.append(session, 'tool_result', {
          id: toolId,
          name,
          isError: !!isError,
          result: redactText(result).slice(0, 2000),
          // uiContent is the display override (e.g. ask_user_question renders the
          // question + numbered options here, not the model-facing placeholder).
          ...(uiContent ? { uiContent: redactText(uiContent).slice(0, 2000) } : {}),
        })
        if (DELEGATION_TOOLS.has(name)) {
          this.append(session, 'delegation', {
            workerId: toolId,
            status: isError ? 'failed' : 'completed',
          })
        }
        // Plan mode — a successful plan_submit wrote a new .rivet/plans/*.md.
        // Surface it as an event so the desktop's plan column refreshes live.
        if (name === 'plan_submit' && !isError) {
          void this.emitPlanSubmitted(session)
        }
        // Plan mode — while planning, write_file/edit_file can only touch the
        // active draft (checkPlanMode gates every other path), so a successful
        // final write means the draft grew. Emit a throttled invalidation
        // signal — this replaces the desktop's 2s draft polling as the primary
        // liveness channel (polling stays as a degraded fallback).
        if (
          isError === false
          && session.record.planMode === 'planning'
          && (name === 'write_file' || name === 'edit_file')
        ) {
          this.schedulePlanDraftEvent(session)
        }
        this.scanArtifacts(session)
      },
      onTurnComplete: (usage, turnNumber, isFinal, evidenceSummary) => {
        session.watchdogPolicy?.recordTurnComplete()
        this.append(session, 'turn_complete', { usage, turnNumber, isFinal: !!isFinal, ...(isFinal && evidenceSummary ? { evidence: evidenceSummary } : {}) })
      },
      onError: (err) => this.append(session, 'error', { error: redactText(err.message) }),
      onAbort: (reason) => {
        session.lastAbortReason = reason
        // 在 finally 的 rejectAllPending 清场之前捕获审批挂起态。
        session.abortWhileApprovalPending =
          [...session.pending.values()].some((p) => p.kind === 'approval')
        if (session.record.status === 'running') session.record.status = 'aborted'
      },
      onCheckpoint: (hash) => this.append(session, 'checkpoint', { hash }),
      onPhaseChange: (phase, detail) => {
        session.record.currentPhase = phase
        this.append(session, 'phase', { phase, ...(detail ?? {}) })
      },
      // R5 — structured course-correction → its own event so the desktop can
      // render a "改道" card inline (selective externalization of star-domain).
      onDecisionShift: (shift: DecisionShift) => {
        this.append(session, 'decision_shift', {
          source: shift.source,
          domain: shift.domain,
          reason: redactText(shift.reason),
          methods: (shift.methods ?? []).map((m) => redactText(m)),
          severity: shift.severity ?? 'info',
        })
      },
      onApprovalRequired: (toolId, name, input) =>
        this.requestApproval(session, toolId, name, input),
      onIntentNote: (intent) => this.emitIntentNote(session, intent),
      // T3 — drain mid-run user guidance at the tool boundary (the agent appends
      // it to the last tool_result; see tool-execution.ts). The buffer is fed by
      // POST /sessions/:id/steer while the session is running.
      onSteerDrain: () => session.steer.drain(),
      // C3 — 自治档检查点：cruise 暂停（paused=true，桌面渲染确认卡片）；
      // unleashed 无此回调（无刹车无播报）。digest 为进度摘要。
      onAutonomyCheckpoint: (info) => {
        this.append(session, 'autonomy_checkpoint', {
          turns: info.turns,
          digest: info.digest,
          paused: info.paused,
        })
      },
      // T4 — structured per-worker delegation status/progress → subagent panel.
      // Keyed by workOrderId (distinct from the spawning tool id, which is the
      // delegation-tree parent). Emitted alongside the existing text stream.
      onDelegationActivity: (a) => this.emitDelegationActivity(session, a),
    }
  }

  private requestApproval(
    session: InternalSession,
    toolId: string,
    name: string,
    input: Record<string, unknown>,
  ): Promise<ApprovalResult> {
    return new Promise<ApprovalResult>((resolve) => {
      const requestId = toolId || randomId()
      const pend: PendingIntervention = {
        requestId,
        kind: 'approval',
        resolve: resolve as (v: ApprovalResult | boolean) => void,
        toolName: name,
        toolInput: input,
      }
      if (this.approvalTimeoutMs > 0) {
        pend.timer = setTimeout(() => {
          if (session.pending.delete(requestId)) {
            resolve({ approved: false })
            session.lastApprovalDeniedAt = this.now()
            this.recountApprovals(session)
            this.append(session, 'approval_resolved', { requestId, decision: 'timeout' })
            this.persistRecord(session)
          }
        }, this.approvalTimeoutMs)
      }
      session.pending.set(requestId, pend)
      this.recountApprovals(session)
      this.append(session, 'approval_required', { requestId, toolName: name, input: redactValue(input) })
      // Persist the pendingApprovals count NOW — if the sidecar dies while
      // blocked on this approval, rehydrate() uses the on-disk count as the
      // gate for scanning the log and closing the approval out honestly.
      this.persistRecord(session)
    })
  }

  /**
   * Watchdog stall 自动恢复（桌面端对齐 TUI v3）：run settle 后判定是否注入
   * 'continue'。必须经 setImmediate 延迟——给排队中的用户 HTTP 动作（run/archive）
   * 让路，执行前复核会话仍处 aborted 且无人抢跑（TUI「让位守卫」的桌面对应物）。
   *
   * C2 刹车：决定续跑后不再立即重发——先追加带 pendingAutoContinue+delayMs 的
   * watchdog_recovery 事件（桌面渲染倒计时卡片），倒计时结束复核守卫再续跑。
   * 窗口内用户 abort（置 watchdogRecoveryCancelled）或发新 prompt（run() 清
   * 定时器）都能取消——「Loop 续跑刹不住」的修复点。
   */
  private maybeWatchdogAutoContinue(session: InternalSession): void {
    const reason = session.lastAbortReason
    if (!reason?.startsWith('watchdog')) return
    const policy = session.watchdogPolicy
    if (!policy) return
    const suppressed = session.abortWhileApprovalPending === true
      || (session.lastApprovalDeniedAt != null
          && this.now() - session.lastApprovalDeniedAt < WATCHDOG_APPROVAL_GRACE_MS)
    setImmediate(() => {
      // 让位守卫：用户已重新驱动（running）、状态被改（非 aborted）、已归档，
      // 或用户在窄窗口内 abort 过 → 放弃续跑。
      if (session.running || session.record.status !== 'aborted' || session.record.archived) return
      if (session.watchdogRecoveryCancelled) return
      const decision = policy.onStall({ suppressed })
      const delayMs = this.watchdogContinueDelayMs
      this.append(session, 'watchdog_recovery', {
        reason,
        autoContinue: decision.autoContinue,
        ...(decision.stopReason ? { stopReason: decision.stopReason } : {}),
        ...(decision.autoContinue ? { dense: decision.dense === true, pendingAutoContinue: true, delayMs } : {}),
        ...policy.snapshot(),
      })
      if (!decision.autoContinue) return
      const timer = setTimeout(() => {
        session.watchdogContinueTimer = undefined
        // 倒计时后复核同一组守卫——期间用户可能已 abort / 提交新 prompt / 归档。
        if (session.running || session.record.status !== 'aborted' || session.record.archived) return
        if (session.watchdogRecoveryCancelled) return
        session.watchdogAutoResubmit = true
        if (!this.run(session.record.id, 'continue')) session.watchdogAutoResubmit = false
      }, delayMs)
      timer.unref?.()
      session.watchdogContinueTimer = timer
    })
  }

  /**
   * Non-blocking direction note: append a passive timeline event and return.
   * The agent never waits — there is no pending Promise/timer. The user steers
   * by typing (POST /sessions/:id/steer) if they want to change direction.
   */
  private emitIntentNote(session: InternalSession, intent: IntentPreview): void {
    const copy = describeIntentNote(intent)
    this.append(session, 'intent_note', {
      summary: intent.summary,
      confidence: intent.confidence,
      warnings: intent.warnings ?? [],
      title: copy.title,
      reasons: copy.reasons,
      action: copy.action,
      steerHint: copy.steerHint,
    })
  }

  private rejectAllPending(session: InternalSession, reason: string): void {
    if (session.pending.size > 0) session.lastApprovalDeniedAt = this.now()
    for (const [requestId, pend] of session.pending) {
      if (pend.timer) clearTimeout(pend.timer)
      pend.resolve({ approved: false })
      this.append(session, 'approval_resolved', { requestId, decision: reason })
    }
    session.pending.clear()
    this.recountApprovals(session)
  }

  private recountApprovals(session: InternalSession): void {
    let count = 0
    for (const p of session.pending.values()) if (p.kind === 'approval') count++
    session.record.pendingApprovals = count
  }

  /**
   * After a plan_submit tool result, read the newest plan off disk and emit a
   * `plan_submitted` event. Async/best-effort: the tool already persisted the
   * file, so a read failure here only delays the live refresh, not the data.
   */
  private async emitPlanSubmitted(session: InternalSession): Promise<void> {
    try {
      const plans = await storeListPlans(session.record.cwd)
      const latest = plans[0]
      if (latest) {
        this.append(session, 'plan_submitted', {
          slug: latest.slug,
          title: latest.title,
          status: latest.status,
        })
      }
    } catch {
      // non-fatal — the desktop can still poll GET /plans
    }
  }

  /**
   * Throttled `plan_draft` scheduler. Leading edge fires immediately; writes
   * inside the window arm ONE trailing timer so the final write of a burst
   * always lands an event (a plain leading-edge throttle would leave the
   * desktop stale until its fallback poll).
   */
  private schedulePlanDraftEvent(session: InternalSession): void {
    const now = this.now()
    const elapsed = now - (session.planDraftLastEmit ?? 0)
    if (elapsed >= PLAN_DRAFT_THROTTLE_MS) {
      session.planDraftLastEmit = now
      void this.emitPlanDraft(session)
      return
    }
    if (session.planDraftTimer) return
    session.planDraftTimer = setTimeout(() => {
      session.planDraftTimer = undefined
      session.planDraftLastEmit = this.now()
      void this.emitPlanDraft(session)
    }, PLAN_DRAFT_THROTTLE_MS - elapsed)
    session.planDraftTimer.unref?.()
  }

  /**
   * Emit the `plan_draft` invalidation signal. Metadata only (title/size/path)
   * — never the body — so events.jsonl stays small; viewers re-fetch the
   * content via GET /sessions/:id/plans. Best-effort: a read failure only
   * delays the live refresh (the poll fallback still covers it).
   */
  private async emitPlanDraft(session: InternalSession): Promise<void> {
    if (session.record.planMode !== 'planning') return
    try {
      const draft = await this.readPlanDraft(session.record.id)
      if (!draft) return
      this.append(session, 'plan_draft', {
        path: draft.path,
        title: draft.title,
        size: draft.content.length,
      })
    } catch {
      // non-fatal — the desktop's fallback poll still refreshes the draft
    }
  }

  private scanArtifacts(session: InternalSession): void {
    if (!session.agent) return
    let list: Artifact[]
    try {
      list = session.agent.listArtifacts()
    } catch {
      return
    }
    for (const art of list) {
      if (session.knownArtifacts.has(art.id)) continue
      session.knownArtifacts.add(art.id)
      this.append(session, 'artifact', {
        id: art.id,
        tool: art.tool,
        target: art.target,
        summary: art.summary,
        charCount: art.charCount,
        lineCount: art.lineCount,
      })
    }
  }

  private append(session: InternalSession, type: SessionEventType, data: Record<string, unknown>): void {
    const event: SessionEvent = { seq: ++session.seq, ts: this.now(), type, data }
    session.events.push(event)
    if (session.events.length > this.maxEvents) {
      session.events.splice(0, session.events.length - this.maxEvents)
    }
    session.record.lastSeq = session.seq
    session.record.updatedAt = event.ts
    if (this.persistence) {
      try {
        this.persistence.appendEvent(session.record.id, event)
      } catch {
        // persistence failure must not break the live event log
      }
    }
    for (const listener of session.listeners) {
      try {
        listener(event)
      } catch {
        // a misbehaving viewer must not break the event log
      }
    }
  }

  private persistRecord(session: InternalSession): void {
    if (!this.persistence) return
    try {
      this.persistence.saveRecord({ ...session.record })
    } catch {
      // non-fatal — events.jsonl is the source of truth for replay
    }
  }

  /**
   * Decode user-attached image data URLs and persist each as a file, returning
   * the generated ids. Best-effort: a malformed URL or persistence gap is
   * skipped (the model still gets the inline image; only its thumbnail is lost).
   */
  private persistImages(sessionId: string, images?: string[]): string[] {
    if (!images?.length || !this.persistence?.saveImage) return []
    const ids: string[] = []
    for (const url of images) {
      const parsed = parseImageDataUrl(url)
      if (!parsed) continue
      const imgId = randomId()
      try {
        this.persistence.saveImage(sessionId, imgId, parsed.base64, parsed.mime)
        ids.push(imgId)
      } catch {
        // non-fatal — skip this thumbnail, keep the rest
      }
    }
    return ids
  }

  /** Read a persisted user image (for the GET image route). */
  readImage(sessionId: string, imgId: string): { bytes: Buffer; mime: string } | undefined {
    return this.persistence?.readImage?.(sessionId, imgId)
  }

  private touch(session: InternalSession): void {
    session.record.updatedAt = this.now()
  }
}

function randomId(): string {
  return (
    Date.now().toString(36) + Math.random().toString(36).slice(2, 10)
  )
}

/** Parse a `data:image/<mime>;base64,<payload>` URL. Returns null if malformed. */
function parseImageDataUrl(url: string): { mime: string; base64: string } | null {
  const m = /^data:(image\/[a-z0-9.+-]+);base64,(.+)$/i.exec(url)
  if (!m) return null
  return { mime: m[1]!.toLowerCase(), base64: m[2]! }
}

/**
 * Resolve a star-domain selection KEY into the live tri-state + canonical key +
 * display label. Mirrors AgentLoop.getSessionDomain semantics:
 *  - 'auto' → state undefined (per-message auto-detect)
 *  - 'off'  → legacy alias, resolves to auto (state undefined)
 *  - <id>   → the ActiveStarDomain, when the id is a known domain
 * Returns null for an unknown key so callers can 400/return false.
 */
function resolveDomainState(
  key: string,
): { state: ActiveStarDomain | null | undefined; key: string; label: string } | null {
  if (key === 'auto') return { state: undefined, key: 'auto', label: 'Auto' }
  // Legacy: the 'off' selection was removed. Old persisted sessions with
  // domain:'off' resolve to Auto instead of breaking (state undefined, not null).
  if (key === 'off') return { state: undefined, key: 'auto', label: 'Auto' }
  const d = starDomainRegistry.get(key)
  if (!d) return null
  return {
    state: { id: d.id as StarDomainId, name: d.name, volatileBlock: d.volatileBlock, motto: d.motto },
    key: d.id,
    label: d.name,
  }
}

function resolveDomainPersona(key: string | undefined): { glyph: string; accent: 'primary' | 'secondary' | 'success' | 'warning' | 'error' | 'dim' } {
  // 'off' removed; treat legacy value as Auto for persona rendering.
  if (key === 'auto' || key === 'off' || key === undefined) return { glyph: '⚙', accent: 'primary' }
  const d = starDomainRegistry.get(key)
  if (!d) return { glyph: '⚙', accent: 'primary' }
  return { glyph: d.uiPersona.glyph, accent: d.uiPersona.accent }
}

function redactValue(value: unknown): unknown {
  if (typeof value === 'string') return redactText(value)
  if (Array.isArray(value)) return value.map(redactValue)
  if (!value || typeof value !== 'object') return value
  if (value instanceof Date) return value.toISOString()
  const redacted: Record<string, unknown> = {}
  for (const [key, child] of Object.entries(value)) {
    redacted[key] = SENSITIVE_KEY.test(key) ? REDACTED : redactValue(child)
  }
  return redacted
}

function redactText(text: string): string {
  return String(text)
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, `$1${REDACTED}`)
    .replace(/((?:api[_-]?key|token|secret|password)\s*[:=]\s*)[^\s,'"]+/gi, `$1${REDACTED}`)
}
