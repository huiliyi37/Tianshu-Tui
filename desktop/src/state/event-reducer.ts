import type {
  ApprovalRequest,
  DelegationNode,
  IntentRequest,
  SessionEvent,
  TodoStateItem,
} from '../runtime/types'

export type ConvoKind =
  | 'user'
  | 'assistant'
  | 'tool'
  | 'result'
  | 'phase'
  | 'error'
  | 'decision_shift'
  // T1 — process observability blocks.
  | 'thinking'
  | 'turn'
  | 'checkpoint'
  // T3 — mid-run user guidance echo.
  | 'steer'

export interface ConvoBlock {
  key: string
  kind: ConvoKind
  role?: string
  text: string
  isError?: boolean
  /** R5 — decision_shift card payload (star-domain course-correction). */
  shift?: {
    source: string
    domain?: string
    reason: string
    methods: string[]
    severity: 'info' | 'warn'
  }
  /** T1 — turn boundary metadata (turn_complete). */
  turn?: {
    turnNumber?: number
    totalTokens?: number
    isFinal?: boolean
  }
  /** T1 — checkpoint anchor (checkpoint). */
  hash?: string
}

export interface EventViewState {
  lastSeq: number
  blocks: ConvoBlock[]
  pendingApproval: ApprovalRequest | null
  pendingIntent: IntentRequest | null
  /** Bumped on every artifact event so consumers can invalidate the artifact query. */
  artifactRev: number
  delegation: Record<string, DelegationNode>
  /** T2 — active task list (latest `todo` write); empty until the agent plans. */
  todos: TodoStateItem[]
  status?: string
  phase?: string
  /** Whether the last block is an open assistant run that text deltas append to. */
  private_textOpen: boolean
  /** T1 — whether the last block is an open reasoning run that thinking deltas append to. */
  private_thinkingOpen: boolean
}

export const initialEventState: EventViewState = {
  lastSeq: 0,
  blocks: [],
  pendingApproval: null,
  pendingIntent: null,
  artifactRev: 0,
  delegation: {},
  todos: [],
  private_textOpen: false,
  private_thinkingOpen: false,
}

export type EventAction =
  | { type: 'reset' }
  | { type: 'event'; event: SessionEvent }
  | { type: 'events'; events: SessionEvent[] }

export function eventReducer(state: EventViewState, action: EventAction): EventViewState {
  switch (action.type) {
    case 'reset':
      return initialEventState
    case 'events':
      return action.events.reduce((s, e) => applyEvent(s, e), state)
    case 'event':
      return applyEvent(state, action.event)
    default:
      return state
  }
}

function applyEvent(state: EventViewState, ev: SessionEvent): EventViewState {
  // Idempotent replay: ignore events at or below what we've folded.
  if (ev.seq <= state.lastSeq) return state
  const next: EventViewState = { ...state, lastSeq: ev.seq }

  switch (ev.type) {
    case 'user':
      next.private_textOpen = false
      next.private_thinkingOpen = false
      next.blocks = [...next.blocks, {
        key: `u-${ev.seq}`,
        kind: 'user',
        text: String(ev.data.text ?? ''),
      }]
      return next
    case 'text_delta': {
      const text = String(ev.data.text ?? '')
      next.private_thinkingOpen = false
      if (next.private_textOpen && next.blocks.length > 0) {
        next.blocks[next.blocks.length - 1]!.text += text
      } else if (text) {
        next.blocks = [...next.blocks, { key: `t-${ev.seq}`, kind: 'assistant', text }]
        next.private_textOpen = true
      }
      return next
    }
    case 'thinking_delta': {
      const text = String(ev.data.text ?? '')
      next.private_textOpen = false
      if (next.private_thinkingOpen && next.blocks.length > 0) {
        next.blocks[next.blocks.length - 1]!.text += text
      } else if (text) {
        next.blocks = [...next.blocks, { key: `th-${ev.seq}`, kind: 'thinking', text }]
        next.private_thinkingOpen = true
      }
      return next
    }
    case 'tool_use':
      next.private_textOpen = false
      next.private_thinkingOpen = false
      next.blocks = [...next.blocks, {
        key: `tu-${ev.seq}`,
        kind: 'tool',
        role: `tool · ${String(ev.data.name ?? '')}`,
        text: safeJson(ev.data.input),
      }]
      return next
    case 'tool_result':
      next.private_textOpen = false
      next.private_thinkingOpen = false
      next.blocks = [...next.blocks, {
        key: `tr-${ev.seq}`,
        kind: 'result',
        role: `result · ${String(ev.data.name ?? '')}`,
        text: String(ev.data.result ?? ''),
        isError: !!ev.data.isError,
      }]
      return next
    case 'phase':
      next.private_textOpen = false
      next.private_thinkingOpen = false
      next.phase = String(ev.data.phase ?? '')
      return next
    case 'turn_complete': {
      // T1 — turn boundary marker. Carries usage so the UI can show a subtle
      // "turn N · ~T tokens" divider between turns.
      next.private_textOpen = false
      next.private_thinkingOpen = false
      const usage = (ev.data.usage as Record<string, unknown> | undefined) ?? {}
      const totalTokens = Number(
        usage.totalTokens ?? usage.total_tokens ?? usage.total ?? 0,
      ) || undefined
      next.blocks = [...next.blocks, {
        key: `turn-${ev.seq}`,
        kind: 'turn',
        text: '',
        turn: {
          turnNumber: ev.data.turnNumber != null ? Number(ev.data.turnNumber) : undefined,
          totalTokens,
          isFinal: !!ev.data.isFinal,
        },
      }]
      return next
    }
    case 'checkpoint': {
      // T1 — inline rollback anchor created before the first mutating tool of a turn.
      next.private_textOpen = false
      next.private_thinkingOpen = false
      const hash = String(ev.data.hash ?? '')
      if (!hash) return next
      next.blocks = [...next.blocks, {
        key: `cp-${ev.seq}`,
        kind: 'checkpoint',
        text: '',
        hash,
      }]
      return next
    }
    case 'decision_shift': {
      next.private_textOpen = false
      next.private_thinkingOpen = false
      const methods = Array.isArray(ev.data.methods) ? (ev.data.methods as unknown[]).map((m) => String(m)) : []
      const severity = ev.data.severity === 'warn' ? 'warn' : 'info'
      next.blocks = [...next.blocks, {
        key: `ds-${ev.seq}`,
        kind: 'decision_shift',
        text: String(ev.data.reason ?? ''),
        shift: {
          source: String(ev.data.source ?? ''),
          domain: ev.data.domain ? String(ev.data.domain) : undefined,
          reason: String(ev.data.reason ?? ''),
          methods,
          severity,
        },
      }]
      return next
    }
    case 'error':
      next.private_textOpen = false
      next.private_thinkingOpen = false
      next.blocks = [...next.blocks, {
        key: `e-${ev.seq}`,
        kind: 'error',
        text: `Error: ${String(ev.data.error ?? '')}`,
        isError: true,
      }]
      return next
    case 'rewind': {
      const prompt = String(ev.data.prompt ?? '')
      // Anchor the truncation to the exact user block.
      //  1. anchorSeq (preferred): the seq of the rewound `user` event. User
      //     blocks are keyed `u-${seq}`, so this is an exact, duplicate-proof
      //     match — no more prompt-prefix collisions matching the wrong turn.
      //  2. prompt full-text (fallback, older servers): most-recent exact match.
      // The backend truncated messages with `slice(0, messageIndex)` (the
      // rewound user message is REMOVED and restored to the input box), so we
      // mirror that: drop the matched user block and everything after it.
      const anchorSeq = typeof ev.data.anchorSeq === 'number' ? ev.data.anchorSeq : undefined
      let cutIdx = -1
      if (anchorSeq !== undefined) {
        cutIdx = next.blocks.findIndex(b => b.kind === 'user' && b.key === `u-${anchorSeq}`)
      }
      if (cutIdx < 0 && prompt) {
        const fromEnd = [...next.blocks].reverse().findIndex(b => b.kind === 'user' && b.text === prompt)
        if (fromEnd >= 0) cutIdx = next.blocks.length - 1 - fromEnd
      }
      if (cutIdx >= 0) {
        next.blocks = next.blocks.slice(0, cutIdx)
      }
      next.blocks = [...next.blocks, {
        key: `rewind-${ev.seq}`,
        kind: 'turn',
        text: `⏪ Rewound — message restored to input.`,
      }]
      return next
    }
    case 'status':
      next.status = String(ev.data.status ?? next.status ?? '')
      return next
    case 'approval_required':
      next.pendingApproval = {
        requestId: String(ev.data.requestId ?? ''),
        toolName: String(ev.data.toolName ?? ''),
        input: (ev.data.input as Record<string, unknown>) ?? {},
      }
      return next
    case 'approval_resolved':
      if (next.pendingApproval && next.pendingApproval.requestId === ev.data.requestId) {
        next.pendingApproval = null
      }
      return next
    case 'intent_required':
      next.pendingIntent = {
        requestId: String(ev.data.requestId ?? ''),
        summary: String(ev.data.summary ?? ''),
        confidence: Number(ev.data.confidence ?? 0),
        alternatives: (ev.data.alternatives as string[]) ?? [],
        warnings: (ev.data.warnings as string[]) ?? [],
      }
      return next
    case 'intent_resolved':
      if (next.pendingIntent && next.pendingIntent.requestId === ev.data.requestId) {
        next.pendingIntent = null
      }
      return next
    case 'delegation': {
      const workerId = String(ev.data.workerId ?? '')
      if (!workerId) return next
      // T4 — merge with the prior node so terminal updates (which omit profile /
      // objective) don't wipe fields set by earlier running updates.
      const prev = next.delegation[workerId]
      const node: DelegationNode = {
        workerId,
        parentId: ev.data.parentId ? String(ev.data.parentId) : prev?.parentId,
        objective: ev.data.objective != null ? String(ev.data.objective) : (prev?.objective ?? ''),
        status: ev.data.status != null ? String(ev.data.status) : (prev?.status ?? ''),
        phase: ev.data.phase != null ? String(ev.data.phase) : prev?.phase,
        progressLine: ev.data.progressLine != null ? String(ev.data.progressLine) : prev?.progressLine,
        elapsedMs: ev.data.elapsedMs != null ? Number(ev.data.elapsedMs) : prev?.elapsedMs,
        updatedAt: ev.ts,
      }
      next.delegation = { ...next.delegation, [workerId]: node }
      return next
    }
    case 'artifact':
      next.artifactRev = next.artifactRev + 1
      return next
    case 'steer_queued':
      next.private_textOpen = false
      next.private_thinkingOpen = false
      next.blocks = [...next.blocks, {
        key: `sg-${ev.seq}`,
        kind: 'steer',
        text: String(ev.data.text ?? ''),
      }]
      return next
    case 'todo_state': {
      // T2 — full-replace active task list (the tool is replace-only).
      const raw = Array.isArray(ev.data.items) ? (ev.data.items as unknown[]) : []
      const todos: TodoStateItem[] = []
      for (const entry of raw) {
        if (!entry || typeof entry !== 'object') continue
        const e = entry as Record<string, unknown>
        const id = typeof e.id === 'string' ? e.id : ''
        const content = typeof e.content === 'string' ? e.content : ''
        const status = e.status === 'in_progress' || e.status === 'completed' ? e.status : 'pending'
        if (!id || !content) continue
        todos.push({ id, content, status })
      }
      next.todos = todos
      return next
    }
    default:
      return next
  }
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value ?? {}, null, 2)
  } catch {
    return String(value)
  }
}
