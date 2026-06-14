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
import type { AgentCallbacks } from '../agent/loop-types.js'
import type { ApprovalResult } from '../agent/approval-edit.js'
import type { IntentPreview, IntentPreviewAction } from '../agent/intent-preview.js'
import type { Artifact } from '../artifact/types.js'

export type SessionStatus = 'idle' | 'running' | 'completed' | 'failed' | 'aborted'

export type SessionEventType =
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
}

/** Minimal agent surface the manager needs — decoupled from AgentLoop for tests. */
export interface ManagedAgent {
  run(prompt: string, callbacks: AgentCallbacks): Promise<void>
  abort(): void
  listArtifacts(): Artifact[]
  readArtifact(id: string): Promise<string | null>
}

/**
 * Builds the agent for a session. Receives the manager's own session id so the
 * agent's stores (artifacts/session-persist) align with the session — enabling
 * future artifact recovery across restarts.
 */
export type AgentFactory = (cwd?: string, sessionId?: string) => ManagedAgent

export interface CreateSessionInput {
  cwd?: string
  title?: string
  prompt?: string
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
  events: SessionEvent[]
  seq: number
  running: boolean
  pending: Map<string, PendingIntervention>
  listeners: Set<(e: SessionEvent) => void>
  knownArtifacts: Set<string>
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

export class RuntimeSessionManager {
  private readonly sessions = new Map<string, InternalSession>()
  private readonly createAgent: AgentFactory
  private readonly defaultCwd: string
  private readonly now: () => number
  private readonly idGenerator: () => string
  private readonly maxEvents: number
  private readonly approvalTimeoutMs: number
  private readonly persistence?: SessionPersistenceAdapter

  constructor(opts: RuntimeSessionManagerOptions) {
    this.createAgent = opts.createAgent
    this.defaultCwd = opts.defaultCwd ?? process.cwd()
    this.now = opts.now ?? Date.now
    this.idGenerator = opts.idGenerator ?? (() => randomId())
    this.maxEvents = opts.maxEvents ?? 5000
    this.approvalTimeoutMs = opts.approvalTimeoutMs ?? 0
    this.persistence = opts.persistence
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

  createSession(input: CreateSessionInput = {}): SessionRecord {
    const id = this.idGenerator()
    const cwd = input.cwd ?? this.defaultCwd
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
      },
      agent: null,
      events: [],
      seq: 0,
      running: false,
      pending: new Map(),
      listeners: new Set(),
      knownArtifacts: new Set(),
    }
    this.sessions.set(id, session)
    this.persistRecord(session)
    if (input.prompt && input.prompt.trim()) {
      this.run(id, input.prompt)
    }
    return { ...session.record }
  }

  /** Start an agent run on an idle session. Returns false if missing or busy. */
  run(id: string, prompt: string): boolean {
    const session = this.sessions.get(id)
    if (!session || session.running) return false
    const agent = this.ensureAgent(session)
    session.running = true
    session.record.status = 'running'
    session.record.error = undefined
    this.touch(session)
    this.append(session, 'status', { status: 'running' })
    this.persistRecord(session)

    const callbacks = this.buildCallbacks(session)
    void agent
      .run(prompt, callbacks)
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
        this.touch(session)
        this.append(session, 'done', { status: session.record.status })
        this.persistRecord(session)
      })
    return true
  }

  private ensureAgent(session: InternalSession): ManagedAgent {
    if (!session.agent) {
      session.agent = this.createAgent(session.record.cwd, session.record.id)
    }
    return session.agent
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
    return [...this.sessions.values()].map((s) => ({ ...s.record }))
  }

  getSession(id: string): SessionRecord | undefined {
    const s = this.sessions.get(id)
    return s ? { ...s.record } : undefined
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
    // Rehydrated/idle sessions have no live agent; artifact bodies aren't
    // recoverable yet (the metadata still lives in the replayed event log).
    if (!s.agent) return []
    return s.agent.listArtifacts()
  }

  readArtifact(id: string, artifactId: string): Promise<string | null> | undefined {
    const s = this.sessions.get(id)
    if (!s) return undefined
    if (!s.agent) return Promise.resolve(null)
    return s.agent.readArtifact(artifactId)
  }

  // ── internals ─────────────────────────────────────────────────

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
      },
      onToolResult: (toolId, name, result, isError) => {
        this.append(session, 'tool_result', {
          id: toolId,
          name,
          isError: !!isError,
          result: redactText(result).slice(0, 2000),
        })
        if (DELEGATION_TOOLS.has(name)) {
          this.append(session, 'delegation', {
            workerId: toolId,
            status: isError ? 'failed' : 'completed',
          })
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
      onApprovalRequired: (toolId, name, input) =>
        this.requestApproval(session, toolId, name, input),
      onIntentPreview: (intent) => this.requestIntent(session, intent),
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

  private touch(session: InternalSession): void {
    session.record.updatedAt = this.now()
  }
}

function randomId(): string {
  return (
    Date.now().toString(36) + Math.random().toString(36).slice(2, 10)
  )
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
