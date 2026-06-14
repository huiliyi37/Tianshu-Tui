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

export type AgentFactory = (cwd?: string) => ManagedAgent

export interface CreateSessionInput {
  cwd?: string
  title?: string
  prompt?: string
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
  agent: ManagedAgent
  events: SessionEvent[]
  seq: number
  running: boolean
  pending: Map<string, PendingIntervention>
  listeners: Set<(e: SessionEvent) => void>
  knownArtifacts: Set<string>
}

const REDACTED = '[REDACTED]'
const SENSITIVE_KEY = /(?:api[_-]?key|token|secret|password|authorization)/i

export class RuntimeSessionManager {
  private readonly sessions = new Map<string, InternalSession>()
  private readonly createAgent: AgentFactory
  private readonly defaultCwd: string
  private readonly now: () => number
  private readonly idGenerator: () => string
  private readonly maxEvents: number
  private readonly approvalTimeoutMs: number

  constructor(opts: RuntimeSessionManagerOptions) {
    this.createAgent = opts.createAgent
    this.defaultCwd = opts.defaultCwd ?? process.cwd()
    this.now = opts.now ?? Date.now
    this.idGenerator = opts.idGenerator ?? (() => randomId())
    this.maxEvents = opts.maxEvents ?? 5000
    this.approvalTimeoutMs = opts.approvalTimeoutMs ?? 0
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
      agent: this.createAgent(cwd),
      events: [],
      seq: 0,
      running: false,
      pending: new Map(),
      listeners: new Set(),
      knownArtifacts: new Set(),
    }
    this.sessions.set(id, session)
    if (input.prompt && input.prompt.trim()) {
      this.run(id, input.prompt)
    }
    return { ...session.record }
  }

  /** Start an agent run on an idle session. Returns false if missing or busy. */
  run(id: string, prompt: string): boolean {
    const session = this.sessions.get(id)
    if (!session || session.running) return false
    session.running = true
    session.record.status = 'running'
    session.record.error = undefined
    this.touch(session)
    this.append(session, 'status', { status: 'running' })

    const callbacks = this.buildCallbacks(session)
    void session.agent
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
      })
    return true
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
    s.agent.abort()
    this.rejectAllPending(s, 'aborted')
    this.touch(s)
    this.append(s, 'status', { status: 'aborted' })
    return true
  }

  abortAll(): void {
    for (const id of this.sessions.keys()) this.abort(id)
  }

  /** Resolve a pending approval/intent. Returns false if the request is gone. */
  answerIntervention(id: string, requestId: string, decision: string): boolean {
    const s = this.sessions.get(id)
    if (!s) return false
    const pend = s.pending.get(requestId)
    if (!pend) return false
    s.pending.delete(requestId)
    if (pend.timer) clearTimeout(pend.timer)

    if (pend.kind === 'approval') {
      const approved = decision === 'approve' || decision === 'approved'
      pend.resolve({ approved })
      this.recountApprovals(s)
      this.append(s, 'approval_resolved', { requestId, decision: approved ? 'approve' : 'reject' })
    } else {
      const action: IntentPreviewAction =
        decision === 'veto' ? 'veto' : decision === 'alternative' ? 'alternative' : 'continue'
      pend.resolve(action)
      this.append(s, 'intent_resolved', { requestId, decision: action })
    }
    this.touch(s)
    return true
  }

  listArtifacts(id: string): Artifact[] | undefined {
    const s = this.sessions.get(id)
    if (!s) return undefined
    return s.agent.listArtifacts()
  }

  readArtifact(id: string, artifactId: string): Promise<string | null> | undefined {
    const s = this.sessions.get(id)
    if (!s) return undefined
    return s.agent.readArtifact(artifactId)
  }

  // ── internals ─────────────────────────────────────────────────

  private buildCallbacks(session: InternalSession): AgentCallbacks {
    return {
      onTextDelta: (text) => this.append(session, 'text_delta', { text }),
      onThinkingDelta: (thinking) => this.append(session, 'thinking_delta', { text: thinking }),
      onToolUse: (toolId, name, input) =>
        this.append(session, 'tool_use', { id: toolId, name, input: redactValue(input) }),
      onToolResult: (toolId, name, result, isError) => {
        this.append(session, 'tool_result', {
          id: toolId,
          name,
          isError: !!isError,
          result: redactText(result).slice(0, 2000),
        })
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
    for (const listener of session.listeners) {
      try {
        listener(event)
      } catch {
        // a misbehaving viewer must not break the event log
      }
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
