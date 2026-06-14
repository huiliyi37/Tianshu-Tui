import type {
  ApprovalRequest,
  DelegationNode,
  IntentRequest,
  SessionEvent,
} from '../runtime/types'

export type ConvoKind = 'assistant' | 'tool' | 'result' | 'phase' | 'error'

export interface ConvoBlock {
  key: string
  kind: ConvoKind
  role?: string
  text: string
  isError?: boolean
}

export interface EventViewState {
  lastSeq: number
  blocks: ConvoBlock[]
  pendingApproval: ApprovalRequest | null
  pendingIntent: IntentRequest | null
  /** Bumped on every artifact event so consumers can invalidate the artifact query. */
  artifactRev: number
  delegation: Record<string, DelegationNode>
  status?: string
  phase?: string
  /** Whether the last block is an open assistant run that text deltas append to. */
  private_textOpen: boolean
}

export const initialEventState: EventViewState = {
  lastSeq: 0,
  blocks: [],
  pendingApproval: null,
  pendingIntent: null,
  artifactRev: 0,
  delegation: {},
  private_textOpen: false,
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
    case 'text_delta': {
      const text = String(ev.data.text ?? '')
      if (next.private_textOpen && next.blocks.length > 0) {
        const blocks = next.blocks.slice()
        const last = blocks[blocks.length - 1]!
        blocks[blocks.length - 1] = { ...last, text: last.text + text }
        next.blocks = blocks
      } else {
        next.blocks = [...next.blocks, { key: `t-${ev.seq}`, kind: 'assistant', text }]
        next.private_textOpen = true
      }
      return next
    }
    case 'tool_use':
      next.private_textOpen = false
      next.blocks = [...next.blocks, {
        key: `tu-${ev.seq}`,
        kind: 'tool',
        role: `tool · ${String(ev.data.name ?? '')}`,
        text: safeJson(ev.data.input),
      }]
      return next
    case 'tool_result':
      next.private_textOpen = false
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
      next.phase = String(ev.data.phase ?? '')
      return next
    case 'error':
      next.private_textOpen = false
      next.blocks = [...next.blocks, {
        key: `e-${ev.seq}`,
        kind: 'error',
        text: `Error: ${String(ev.data.error ?? '')}`,
        isError: true,
      }]
      return next
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
      const node: DelegationNode = {
        workerId,
        parentId: ev.data.parentId ? String(ev.data.parentId) : undefined,
        objective: String(ev.data.objective ?? ''),
        status: String(ev.data.status ?? ''),
        phase: ev.data.phase ? String(ev.data.phase) : undefined,
        updatedAt: ev.ts,
      }
      next.delegation = { ...next.delegation, [workerId]: node }
      return next
    }
    case 'artifact':
      next.artifactRev = next.artifactRev + 1
      return next
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
