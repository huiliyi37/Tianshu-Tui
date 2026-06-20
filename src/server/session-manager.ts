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
 *  - Approvals/intents are requestId-keyed two-way interventions resolved out of
 *    band by answerIntervention() (B2).
 *  - Artifacts are surfaced from each session's own ArtifactStore, never shared
 *    across sessions (B4).
 */
import type { AgentCallbacks, ApprovalMode } from '../agent/loop-types.js'
import type { ApprovalResult } from '../agent/approval-edit.js'
import type { IntentPreview, IntentPreviewAction } from '../agent/intent-preview.js'
import type { Artifact } from '../artifact/types.js'
import { ArtifactStore } from '../artifact/store.js'
import type { OaiMessage } from '../api/oai-types.js'
import type { SessionRegistry } from '../agent/session-registry.js'
import type { DecisionShift } from '../agent/loop-types.js'
import type { PlanModeState } from '../agent/plan-mode.js'
import {
  listPlans as storeListPlans,
  readPlan as storeReadPlan,
  approvePlan as storeApprovePlan,
  rejectPlan as storeRejectPlan,
  type PlanDocument,
} from '../plan/plan-store.js'
import { SteerBuffer } from '../tui/steer-buffer.js'
import { buildDomainPickerEntries, type DomainPickerEntry } from '../agent/domain-picker-entries.js'
import { starDomainRegistry } from '../agent/star-domain-registry.js'
import type { ActiveStarDomain } from '../agent/star-domain.js'
import type { StarDomainId } from '../agent/star-domain.js'
import { skillRegistry } from '../skills/skill-loader.js'
import { join, resolve } from 'node:path'
import { createWorktree, removeWorktree, listWorktrees, type WorktreeEntry } from '../agent/worktree.js'

export type SessionStatus = 'idle' | 'running' | 'completed' | 'failed' | 'aborted'

export type SessionEventType =
  | 'user'
  | 'text_delta'
  | 'thinking_delta'
  | 'tool_use'
  | 'tool_result'
  | 'turn_complete'
  | 'phase'
  | 'checkpoint'
  | 'approval_required'
  | 'approval_resolved'
  | 'intent_required'
  | 'intent_resolved'
  | 'delegation'
  | 'artifact'
  | 'status'
  | 'error'
  | 'decision_shift'
  | 'rewind'
  // T2 — structured active task list (mirrors the `todo` tool's write payload).
  | 'todo_state'
  // T3 — mid-run user guidance accepted into the steer buffer.
  | 'steer_queued'
  // Plan mode — state toggle (off|planning) + a plan was submitted to disk.
  | 'plan_mode'
  | 'plan_submitted'
  // PlusMenu — per-session model / star-domain / skill selection changes.
  | 'model_switched'
  | 'domain_changed'
  | 'skills_changed'
  | 'done'

export interface SessionEvent {
  seq: number
  ts: number
  type: SessionEventType
  data: Record<string, unknown>
}

export interface SessionRecord {
  id: string
  status: SessionStatus
  createdAt: number
  updatedAt: number
  cwd: string
  title?: string
  currentPhase?: string
  lastSeq: number
  error?: string
  pendingApprovals: number
  /**
   * S — per-session autonomy level. Overrides the global config approval mode
   * so one session can run unattended (dangerously-skip-permissions) while
   * another stays supervised. Absent → the agent uses the global config default.
   */
  approvalMode?: ApprovalMode
  /**
   * Plan mode — when 'planning', the agent is restricted to read-only tools and
   * is expected to call plan_submit to produce a reviewable plan. Absent/'off' →
   * normal execution. Mirrors AgentLoop.planModeState.
   */
  planMode?: PlanModeState
  /**
   * PlusMenu — current provider model id for this session (the resolved model
   * id, not an alias). Absent → the global default. Surfaced in the model picker
   * and persisted so a reconnecting viewer sees the live model.
   */
  model?: string
  /**
   * PlusMenu — star-domain selection KEY ('auto' | 'off' | <domainId>). Stored
   * as the round-trippable key (not a display name) so rehydrate can restore the
   * live ActiveStarDomain. Absent → 'auto'.
   */
  domain?: string
  /** Estimated token count for the current conversation. Absent → session is idle/rehydrated. */
  contextTokens?: number
  /** Model context window size (max tokens). Absent → session is idle/rehydrated. */
  contextWindow?: number
  /** Archived (closed) sessions are excluded from listSessions() and hidden in the desktop sidebar. */
  archived?: boolean
  /** Git worktree branch name — set when the session was created with isolated worktree. */
  worktreeBranch?: string
  /** Worktree path on disk (for cleanup on archive/close). */
  worktreePath?: string
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
  enterPlanMode?(): void
  exitPlanMode?(): void
  /**
   * Set (or clear) the approved-plan pointer. Injects a tiny slug/title/path
   * reminder into the agent's dynamic appendix (NOT the plan body, which stays
   * on disk). Mirrors AgentLoop.setActivePlan. Optional for lightweight doubles.
   */
  setActivePlan?(plan: { slug: string; title: string } | null): void
  /** Rewind: return the current message list (for listing rewind points). */
  getMessages(): OaiMessage[]
  /** Rewind: replace the message list (truncate to a prior point). */
  replaceMessages(msgs: OaiMessage[]): void
  /** Rewind: like replaceMessages but also resets turnCount/filesRead/filesModified etc. */
  rewindToMessages(msgs: OaiMessage[]): void
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

/**
 * Durable backing store for sessions (N1). Records are snapshotted; events are
 * append-only. Implementations must tolerate a corrupt trailing event line
 * (partial write) on load — never throw, just drop it.
 */
export interface SessionPersistenceAdapter {
  saveRecord(record: SessionRecord): void
  appendEvent(sessionId: string, event: SessionEvent): void
  loadAll(): PersistedSession[]
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
  /** Auto-resolve a pending intervention after this many ms. 0 = never. Default 0. */
  approvalTimeoutMs?: number
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
}

type InterventionKind = 'approval' | 'intent'

interface PendingIntervention {
  requestId: string
  kind: InterventionKind
  resolve: (value: ApprovalResult | IntentPreviewAction) => void
  timer?: ReturnType<typeof setTimeout>
}

interface InternalSession {
  record: SessionRecord
  /** Lazily built on first run; null for rehydrated/idle sessions. */
  agent: ManagedAgent | null
  /** S — per-session autonomy override threaded into the agent on build. */
  approvalMode?: ApprovalMode
  events: SessionEvent[]
  seq: number
  running: boolean
  pending: Map<string, PendingIntervention>
  listeners: Set<(e: SessionEvent) => void>
  knownArtifacts: Set<string>
  /** T3 — mid-run user guidance, drained into the agent at the next tool boundary. */
  steer: SteerBuffer
  /**
   * Lazily built read-only view over the on-disk artifact log for sessions
   * without a live agent (rehydrated/idle). Lets the desktop still read artifact
   * bodies after a sidecar restart, since the agent's ArtifactStore persists
   * both the index and raw files keyed by sessionId.
   */
  rehydratedArtifacts?: ArtifactStore
  /**
   * PlusMenu (domain) — live star-domain selection. Tri-state mirrors
   * AgentLoop.getSessionDomain: undefined=Auto, null=Off, object=pinned. Applied
   * to the agent on ensureAgent (so lazy build is consistent) and after a model
   * rebuild (so the selection survives switchModel).
   */
  domainState: ActiveStarDomain | null | undefined
  /** PlusMenu (skills) — per-session disabled skill names (in-memory). */
  disabledSkills: Set<string>
}

const REDACTED = '[REDACTED]'
const SENSITIVE_KEY = /(?:api[_-]?key|token|secret|password|authorization)/i

/** Tools that spawn worker agents — surfaced as delegation-tree nodes (N3). */
const DELEGATION_TOOLS = new Set(['delegate_task', 'delegate_batch', 'team_orchestrate'])

function extractObjective(input: Record<string, unknown>): string {
  for (const key of ['objective', 'prompt', 'description', 'goal']) {
    const v = input[key]
    if (typeof v === 'string' && v.trim()) return v.slice(0, 200)
  }
  return ''
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
  private readonly approvalTimeoutMs: number
  private readonly persistence?: SessionPersistenceAdapter
  private readonly getRegistry?: () => SessionRegistry | undefined
  private readonly listModelsFn?: () => ModelOption[]
  private readonly defaultModelId?: string

  constructor(opts: RuntimeSessionManagerOptions) {
    this.createAgent = opts.createAgent
    this.defaultCwd = opts.defaultCwd ?? process.cwd()
    this.now = opts.now ?? Date.now
    this.idGenerator = opts.idGenerator ?? (() => randomId())
    this.maxEvents = opts.maxEvents ?? 5000
    this.approvalTimeoutMs = opts.approvalTimeoutMs ?? 0
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
    let restored: PersistedSession[]
    try {
      restored = this.persistence!.loadAll()
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
        events,
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
      }
      this.sessions.set(session.record.id, session)
      if (wasRunning) {
        // Record an honest marker so the viewer sees the interruption.
        this.append(session, 'status', { status: 'aborted', reason: 'sidecar-restart' })
        this.persistRecord(session)
      }
    }
  }

  /** Lightweight counts for GET /health. */
  stats(): { sessionCount: number; runningCount: number } {
    let runningCount = 0
    for (const s of this.sessions.values()) if (s.running) runningCount++
    return { sessionCount: this.sessions.size, runningCount }
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

    if (input.isolatedWorktree) {
      try {
        const wt = createWorktree(cwd, id)
        worktreeBranch = wt.branch
        worktreePath = wt.path
        cwd = wt.path
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
        domain: 'auto',
        worktreeBranch,
        worktreePath,
      },
      agent: null,
      approvalMode: input.approvalMode,
      events: [],
      seq: 0,
      running: false,
      pending: new Map(),
      listeners: new Set(),
      knownArtifacts: new Set(),
      steer: new SteerBuffer(),
      domainState: undefined,
      disabledSkills: new Set(),
    }
    this.sessions.set(id, session)
    this.persistRecord(session)
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
      })
    return true
  }

  private ensureAgent(session: InternalSession): ManagedAgent {
    if (!session.agent) {
      session.agent = this.createAgent(session.record.cwd, session.record.id, session.approvalMode)
      this.applySelections(session)
    }
    return session.agent
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
    try {
      if (session.domainState === null) agent.setSessionDomain?.(null)
      else if (session.domainState !== undefined) agent.setSessionDomain?.(session.domainState)
    } catch { /* non-fatal */ }
    try {
      if (session.disabledSkills.size > 0) agent.setDisabledSkills?.(new Set(session.disabledSkills))
    } catch { /* non-fatal */ }
  }

  // ── PlusMenu: star domain ─────────────────────────────────────

  /**
   * PlusMenu — list the domain picker entries for this session (Auto / Off /
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
   * Build (approve) a plan: mark it approved on disk, release plan mode, then
   * inject the approved plan as the next turn so the agent executes it. Refuses
   * when the session is missing/running or the plan can't be approved.
   */
  async approvePlan(id: string, slug: string): Promise<boolean> {
    const session = this.sessions.get(id)
    if (!session || session.running) return false
    let approved: PlanDocument | null
    try {
      approved = await storeApprovePlan(session.record.cwd, slug)
    } catch {
      return false
    }
    if (!approved) return false
    const agent = this.ensureAgent(session)
    // Inject a tiny pointer (slug/title/path) instead of the full plan body —
    // the body stays the single source of truth on disk, keeping the prefix
    // cache intact and the user turn short. setActivePlan also releases plan mode.
    try { agent.setActivePlan?.({ slug, title: approved.title }) } catch { /* non-fatal */ }
    try { agent.exitPlanMode?.() } catch { /* non-fatal */ }
    session.record.planMode = 'off'
    this.append(session, 'plan_mode', { state: 'off' })
    this.touch(session)
    this.persistRecord(session)
    this.run(id, `开始执行已批准的方案「${approved.title}」(.rivet/plans/${slug}.md)。`)
    return true
  }

  /**
   * Reject a plan with optional feedback. Keeps the plan on disk (marked
   * rejected) and, when a comment is given on an idle session, kicks a revision
   * turn so the agent can re-plan. Emits `plan_submitted` to refresh viewers.
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
    this.append(session, 'plan_submitted', { slug, title: rejected.title, status: 'rejected' })
    this.touch(session)
    const note = comment?.trim()
    if (note && !session.running) {
      const prompt =
        `[PLAN REJECTED] ${rejected.title} (slug: ${slug})\n` +
        `Feedback: ${note}\n\n` +
        `Revise the plan to address this feedback, then call plan_submit again.`
      this.run(id, prompt)
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
   */
  feedback(id: string, artifactId: string, comment: string): boolean {
    const s = this.sessions.get(id)
    if (!s || s.running) return false
    const meta = [...s.events].reverse().find(
      (e) => e.type === 'artifact' && e.data.id === artifactId,
    )
    const target = meta ? String(meta.data.target ?? '') : ''
    const prompt =
      `[ARTIFACT FEEDBACK]\n` +
      `Artifact: ${artifactId}${target ? ` (${target})` : ''}\n` +
      `Comment: ${comment}\n\n` +
      `Please revise your work to address this feedback.`
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
    }
    return record
  }

  getSession(id: string): SessionRecord | undefined {
    const s = this.sessions.get(id)
    if (!s) return undefined
    return this.enrichRecord(s)
  }

  getEvents(id: string, since = 0): { events: SessionEvent[]; lastSeq: number } | undefined {
    const s = this.sessions.get(id)
    if (!s) return undefined
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
      // agent 在 rehydrated/idle session 上为 null（懒构造）；只对已建过 agent
      // 的 session 调 shutdown，节省 best-effort try 的无谓 catch。
      try { s.agent?.shutdown?.() } catch { /* best-effort */ }
    }
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
    // Clean up isolated worktree on archive (best-effort).
    if (s.record.worktreePath) {
      try { removeWorktree(this.defaultCwd, s.record.worktreePath, s.record.worktreeBranch) } catch { /* non-fatal */ }
    }
    this.touch(s)
    this.append(s, 'status', { status: 'archived' })
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

  /** List git worktrees for a given cwd (defaults to the manager's default cwd). */
  getWorktrees(cwd?: string): WorktreeEntry[] {
    return listWorktrees(cwd ?? this.defaultCwd)
  }

  /** Expose defaultCwd for routes that need the repo root (e.g. gh CLI). */
  getDefaultCwd(): string {
    return this.defaultCwd
  }

  /**
   * Resolve a pending approval/intent. Returns false if the request is gone.
   * For approvals, an optional `editedInput` lets the human tweak the tool input
   * (e.g. per-hunk edit picks) before it runs — flows through ApprovalResult.
   */
  answerIntervention(
    id: string,
    requestId: string,
    decision: string,
    editedInput?: Record<string, unknown>,
  ): boolean {
    const s = this.sessions.get(id)
    if (!s) return false
    const pend = s.pending.get(requestId)
    if (!pend) return false
    s.pending.delete(requestId)
    if (pend.timer) clearTimeout(pend.timer)

    if (pend.kind === 'approval') {
      const approved = decision === 'approve' || decision === 'approved'
      const result: ApprovalResult = { approved }
      if (approved && editedInput && typeof editedInput === 'object') {
        result.editedInput = editedInput
      }
      pend.resolve(result)
      this.recountApprovals(s)
      this.append(s, 'approval_resolved', {
        requestId,
        decision: approved ? 'approve' : 'reject',
        edited: !!result.editedInput,
      })
    } else {
      const action: IntentPreviewAction =
        decision === 'veto' ? 'veto' : decision === 'alternative' ? 'alternative' : 'continue'
      pend.resolve(action)
      this.append(s, 'intent_resolved', { requestId, decision: action })
    }
    this.touch(s)
    this.persistRecord(s)
    return true
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
  listRewindPoints(id: string): { index: number; content: string; timestamp: number }[] | undefined {
    const s = this.sessions.get(id)
    if (!s) return undefined
    if (!s.agent) return []
    const msgs = s.agent.getMessages()
    // Collect user-event timestamps from the event log so we can map each
    // user message to its original submission time.
    const userTimestamps: number[] = []
    for (const e of s.events) {
      if (e.type === 'user') { userTimestamps.push(e.ts) }
    }
    const entries: { index: number; content: string; timestamp: number }[] = []
    let userIdx = 0
    for (let i = 0; i < msgs.length; i++) {
      const m = msgs[i]!
      if (m.role === 'user' && typeof m.content === 'string') {
        entries.push({ index: i, content: m.content, timestamp: userTimestamps[userIdx] ?? 0 })
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

  // ── internals ─────────────────────────────────────────────────

  private buildCallbacks(session: InternalSession): AgentCallbacks {
    // T4 — per-worker start times for elapsed reporting (one map per run).
    const workerStartedAt = new Map<string, number>()
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
      },
      onToolResult: (toolId, name, result, isError, _rawPath, uiContent) => {
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
        this.scanArtifacts(session)
      },
      onTurnComplete: (usage, turnNumber, isFinal) =>
        this.append(session, 'turn_complete', { usage, turnNumber, isFinal: !!isFinal }),
      onError: (err) => this.append(session, 'error', { error: redactText(err.message) }),
      onAbort: () => {
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
      onIntentPreview: (intent) => this.requestIntent(session, intent),
      // T3 — drain mid-run user guidance at the tool boundary (the agent appends
      // it to the last tool_result; see tool-execution.ts). The buffer is fed by
      // POST /sessions/:id/steer while the session is running.
      onSteerDrain: () => session.steer.drain(),
      // T4 — structured per-worker delegation status/progress → subagent panel.
      // Keyed by workOrderId (distinct from the spawning tool id, which is the
      // delegation-tree parent). Emitted alongside the existing text stream.
      onDelegationActivity: (a) => {
        let started = workerStartedAt.get(a.workOrderId)
        if (started === undefined) {
          started = this.now()
          workerStartedAt.set(a.workOrderId, started)
        }
        this.append(session, 'delegation', {
          workerId: a.workOrderId,
          parentId: a.parentToolId,
          profile: a.profile,
          status: a.status,
          phase: a.status === 'running' ? 'running' : a.status,
          progressLine: a.progressLine ? redactText(a.progressLine) : undefined,
          elapsedMs: this.now() - started,
        })
      },
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
        resolve: resolve as (v: ApprovalResult | IntentPreviewAction) => void,
      }
      if (this.approvalTimeoutMs > 0) {
        pend.timer = setTimeout(() => {
          if (session.pending.delete(requestId)) {
            resolve({ approved: false })
            this.recountApprovals(session)
            this.append(session, 'approval_resolved', { requestId, decision: 'timeout' })
          }
        }, this.approvalTimeoutMs)
      }
      session.pending.set(requestId, pend)
      this.recountApprovals(session)
      this.append(session, 'approval_required', { requestId, toolName: name, input: redactValue(input) })
    })
  }

  private requestIntent(session: InternalSession, intent: IntentPreview): Promise<IntentPreviewAction> {
    return new Promise<IntentPreviewAction>((resolve) => {
      const requestId = randomId()
      const pend: PendingIntervention = {
        requestId,
        kind: 'intent',
        resolve: resolve as (v: ApprovalResult | IntentPreviewAction) => void,
      }
      if (this.approvalTimeoutMs > 0) {
        pend.timer = setTimeout(() => {
          if (session.pending.delete(requestId)) {
            resolve('continue')
            this.append(session, 'intent_resolved', { requestId, decision: 'continue' })
          }
        }, this.approvalTimeoutMs)
      }
      session.pending.set(requestId, pend)
      this.append(session, 'intent_required', {
        requestId,
        summary: intent.summary,
        confidence: intent.confidence,
        alternatives: intent.alternatives ?? [],
        warnings: intent.warnings ?? [],
      })
    })
  }

  private rejectAllPending(session: InternalSession, reason: string): void {
    for (const [requestId, pend] of session.pending) {
      if (pend.timer) clearTimeout(pend.timer)
      if (pend.kind === 'approval') {
        pend.resolve({ approved: false })
        this.append(session, 'approval_resolved', { requestId, decision: reason })
      } else {
        pend.resolve('veto')
        this.append(session, 'intent_resolved', { requestId, decision: reason })
      }
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
 *  - 'off'  → state null (no persona)
 *  - <id>   → the ActiveStarDomain, when the id is a known domain
 * Returns null for an unknown key so callers can 400/return false.
 */
function resolveDomainState(
  key: string,
): { state: ActiveStarDomain | null | undefined; key: string; label: string } | null {
  if (key === 'auto') return { state: undefined, key: 'auto', label: 'Auto' }
  if (key === 'off') return { state: null, key: 'off', label: 'Off' }
  const d = starDomainRegistry.get(key)
  if (!d) return null
  return {
    state: { id: d.id as StarDomainId, name: d.name, volatileBlock: d.volatileBlock, motto: d.motto },
    key: d.id,
    label: d.name,
  }
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
