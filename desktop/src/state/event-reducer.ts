import type {
  ApprovalRequest,
  DelegationNode,
  IntentRequest,
  PlanModeState,
  SessionEvent,
  TodoStateItem,
} from '../runtime/types'

const FILE_TOOLS = new Set([
  'edit_file', 'write_file', 'hash_edit', 'apply_patch', 'read_file', 'create_file',
])

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
  /** Vision — number of images attached to a user message. */
  imageCount?: number
  /** Vision — reference ids for server-persisted images (fetched on demand). */
  imageIds?: string[]
  /** Vision — legacy inline image data URLs (pre-imageIds events). */
  images?: string[]
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
  /** Plan mode — current read-only planning vs execution state for this session. */
  planMode: PlanModeState
  /** Bumped on plan_mode/plan_submitted so the plan list query can re-fetch. */
  planRev: number
  /** Slug of the most recently submitted plan (drives auto-select + Build hint). */
  latestPlanSlug?: string
  /**
   * PlusMenu — bumped on model_switched / domain_changed / skills_changed so an
   * open Models/Skills/星域 panel re-fetches its list (current flags stay live).
   */
  menuRev: number
  /** Whether the last block is an open assistant run that text deltas append to. */
  private_textOpen: boolean
  /** T1 — whether the last block is an open reasoning run that thinking deltas append to. */
  private_thinkingOpen: boolean
  /** Cumulative cache read tokens (latest turn_complete). */
  cacheReadTokens: number
  /** Cumulative cache creation tokens. */
  cacheCreationTokens: number
  /** Latest turn's total tokens (for increment display). */
  lastTotalTokens: number
  /** Previous turn's total tokens. */
  prevTotalTokens: number
  /** Deduplicated file paths touched by file-editing tools (for Task Sidebar sources). */
  sources: string[]
  /** I4 — latest user hook results surfaced as raw hook_result events. */
  hookResults: SessionEvent[]
}

export const initialEventState: EventViewState = {
  lastSeq: 0,
  blocks: [],
  pendingApproval: null,
  pendingIntent: null,
  artifactRev: 0,
  delegation: {},
  todos: [],
  planMode: 'off',
  planRev: 0,
  menuRev: 0,
  private_textOpen: false,
  private_thinkingOpen: false,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  lastTotalTokens: 0,
  prevTotalTokens: 0,
  sources: [],
  hookResults: [],
}

export type EventAction =
  | { type: 'reset' }
  | { type: 'event'; event: SessionEvent }
  | { type: 'events'; events: SessionEvent[] }

export function eventReducer(state: EventViewState, action: EventAction): EventViewState {
  switch (action.type) {
    case 'reset':
      return initialEventState
    case 'events': {
      // Drop already-folded seqs first (preserves idempotent replay), then merge
      // consecutive deltas so a 60fps batch does one string concat + one blocks
      // copy per run instead of one per delta (cuts the O(n^2) streaming cost).
      const fresh = action.events.filter((e) => e.seq > state.lastSeq)
      return coalesceDeltas(fresh).reduce((s, e) => applyEvent(s, e), state)
    }
    case 'event':
      return applyEvent(state, action.event)
    default:
      return state
  }
}

// Merge runs of consecutive same-type streaming deltas into a single event with
// concatenated text and the run's max seq. Caller must pre-filter folded seqs.
function coalesceDeltas(events: SessionEvent[]): SessionEvent[] {
  const out: SessionEvent[] = []
  for (const ev of events) {
    const prev = out[out.length - 1]
    if (
      prev && (ev.type === 'text_delta' || ev.type === 'thinking_delta') &&
      prev.type === ev.type
    ) {
      out[out.length - 1] = {
        ...prev,
        seq: ev.seq,
        ts: ev.ts,
        data: { ...prev.data, text: String(prev.data.text ?? '') + String(ev.data.text ?? '') },
      }
    } else {
      out.push(ev)
    }
  }
  return out
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
        ...(typeof ev.data.imageCount === 'number' && ev.data.imageCount > 0 ? { imageCount: ev.data.imageCount } : {}),
        ...(Array.isArray(ev.data.imageIds) && ev.data.imageIds.length > 0 ? { imageIds: ev.data.imageIds as string[] } : {}),
        ...(Array.isArray(ev.data.images) && ev.data.images.length > 0 ? { images: ev.data.images as string[] } : {}),
      }]
      return next
    case 'text_delta': {
      const text = String(ev.data.text ?? '')
      if (next.private_textOpen && next.blocks.length > 0) {
        const lastIdx = next.blocks.length - 1
        const last = next.blocks[lastIdx]!
        next.blocks = [...next.blocks]
        next.blocks[lastIdx] = { ...last, text: last.text + text }
      } else if (text) {
        next.private_thinkingOpen = false
        next.blocks = [...next.blocks, { key: `t-${ev.seq}`, kind: 'assistant', text }]
        next.private_textOpen = true
      }
      return next
    }
    case 'thinking_delta': {
      const text = String(ev.data.text ?? '')
      if (next.private_thinkingOpen && next.blocks.length > 0) {
        const lastIdx = next.blocks.length - 1
        const last = next.blocks[lastIdx]!
        next.blocks = [...next.blocks]
        next.blocks[lastIdx] = { ...last, text: last.text + text }
      } else if (text) {
        next.private_textOpen = false
        next.blocks = [...next.blocks, { key: `th-${ev.seq}`, kind: 'thinking', text }]
        next.private_thinkingOpen = true
      }
      return next
    }
    case 'tool_use': {
      next.private_textOpen = false
      next.private_thinkingOpen = false
      const toolInput = ev.data.input as Record<string, unknown> | undefined
      next.blocks = [...next.blocks, {
        key: `tu-${ev.seq}`,
        kind: 'tool',
        role: `tool · ${String(ev.data.name ?? '')}`,
        text: humanizeToolInput(String(ev.data.name ?? ''), toolInput),
      }]
      const toolName = String(ev.data.name ?? '')
      if (FILE_TOOLS.has(toolName)) {
        const input = (ev.data.input ?? {}) as Record<string, unknown>
        const filePath = String(input.path ?? input.file_path ?? input.target ?? '')
        if (filePath && !next.sources.includes(filePath)) {
          next.sources = [...next.sources, filePath]
        }
      }
      return next
    }
    case 'tool_result':
      next.private_textOpen = false
      next.private_thinkingOpen = false
      next.blocks = [...next.blocks, {
        key: `tr-${ev.seq}`,
        kind: 'result',
        role: `result · ${String(ev.data.name ?? '')}`,
        // Prefer uiContent (display override) over the model-facing result, matching
        // TUI semantics — e.g. ask_user_question shows the question + options here.
        text: String(ev.data.uiContent ?? ev.data.result ?? ''),
        isError: !!ev.data.isError,
      }]
      return next
    case 'phase':
      next.private_textOpen = false
      next.private_thinkingOpen = false
      next.phase = String(ev.data.phase ?? '')
      return next
    case 'turn_complete': {
      next.private_textOpen = false
      next.private_thinkingOpen = false
      if (!ev.data.isFinal) return next
      const lastBlock = next.blocks[next.blocks.length - 1]
      if (!lastBlock || lastBlock.kind === 'turn') {
        return next
      }
      const usage = (ev.data.usage as Record<string, unknown> | undefined) ?? {}
      const totalTokens = Number(
        usage.totalTokens ?? usage.total_tokens ?? usage.total ?? 0,
      ) || undefined
      // Extract cumulative cache tokens for hit rate display.
      const cacheRead = Number(usage.cache_read_input_tokens ?? 0)
      const cacheCreation = Number(usage.cache_creation_input_tokens ?? 0)
      if (cacheRead > 0 || cacheCreation > 0) {
        next.cacheReadTokens = cacheRead
        next.cacheCreationTokens = cacheCreation
      }
      // Track context increment: shift on final completion.
      if (totalTokens && totalTokens > 0) {
        next.prevTotalTokens = next.lastTotalTokens
        next.lastTotalTokens = totalTokens
      }
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
      const prev = next.delegation[workerId]
      const node: DelegationNode = {
        workerId,
        parentId: ev.data.parentId ? String(ev.data.parentId) : prev?.parentId,
        objective: ev.data.objective != null ? String(ev.data.objective) : (prev?.objective ?? ''),
        status: ev.data.status != null ? String(ev.data.status) : (prev?.status ?? ''),
        phase: ev.data.phase != null ? String(ev.data.phase) : prev?.phase,
        profile: ev.data.profile != null ? String(ev.data.profile) : prev?.profile,
        progressLine: ev.data.progressLine != null ? String(ev.data.progressLine) : prev?.progressLine,
        elapsedMs: ev.data.elapsedMs != null ? Number(ev.data.elapsedMs) : prev?.elapsedMs,
        model: ev.data.model != null ? String(ev.data.model) : prev?.model,
        provider: ev.data.provider != null ? String(ev.data.provider) : prev?.provider,
        usage: ev.data.usage != null && typeof ev.data.usage === 'object' ? (ev.data.usage as DelegationNode['usage']) : prev?.usage,
        updatedAt: ev.ts,
      }
      next.delegation = { ...next.delegation, [workerId]: node }
      return next
    }
    case 'artifact':
      next.artifactRev = next.artifactRev + 1
      return next
    case 'plan_mode':
      next.planMode = ev.data.state === 'planning' ? 'planning' : 'off'
      next.planRev = next.planRev + 1
      return next
    case 'plan_submitted': {
      next.planRev = next.planRev + 1
      const slug = typeof ev.data.slug === 'string' ? ev.data.slug : ''
      if (slug) next.latestPlanSlug = slug
      return next
    }
    case 'steer_queued':
      next.private_textOpen = false
      next.private_thinkingOpen = false
      next.blocks = [...next.blocks, {
        key: `sg-${ev.seq}`,
        kind: 'steer',
        text: String(ev.data.text ?? ''),
      }]
      return next
    case 'model_switched':
    case 'domain_changed':
    case 'skills_changed':
      next.menuRev = next.menuRev + 1
      return next
    case 'todo_state': {
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
    case 'hook_result': {
      next.hookResults = [...next.hookResults, ev].slice(-50)
      return next
    }
    default:
      return next
  }
}

export function humanizeToolInput(toolName: string, input: Record<string, unknown> | undefined): string {
  if (!input) return '{}'
  const path = String(input.path ?? input.file_path ?? input.target ?? '')
  switch (toolName) {
    case 'write_file':
    case 'create_file': {
      const content = String(input.content ?? '')
      const lines = content.split('\n').length
      return `${path}\n${lines} 行 · ${content.length} 字符`
    }
    case 'edit_file':
    case 'hash_edit': {
      const old = String(input.old_string ?? input.old ?? '')
      const nw = String(input.new_string ?? input.new ?? '')
      return `${path}\n-${old.split('\n').length} 行 → +${nw.split('\n').length} 行`
    }
    case 'apply_patch':
      return `${path}\n${String(input.patch ?? input.diff ?? '').split('\n').length} 行 diff`
    case 'bash':
    case 'shell': {
      const cmd = String(input.command ?? input.cmd ?? '')
      return cmd.length > 300 ? `${cmd.slice(0, 300)}…` : cmd
    }
    case 'read_file':
    case 'read':
      return path || safeJson(input)
    case 'delegate_batch': {
      const tasks = Array.isArray(input.tasks) ? input.tasks : []
      if (tasks.length === 0) return '等待任务列表…'
      const cap = Math.min(tasks.length, 8)
      const lines: string[] = []
      for (let i = 0; i < cap; i++) {
        const task = tasks[i] as Record<string, unknown> | undefined
        const id = typeof task?.id === 'string' && task.id.trim() ? task.id.trim() : `#${i + 1}`
        const desc = typeof task?.description === 'string' ? task.description.trim() : ''
        lines.push(desc ? `${id}: ${desc}` : id)
      }
      if (cap < tasks.length) lines.push(`… +${tasks.length - cap} more`)
      return lines.join('\n')
    }
    case 'delegate_task': {
      const objective = typeof input.objective === 'string' ? input.objective.trim() : ''
      const agent = typeof input.agent === 'string' ? input.agent : ''
      if (objective) return objective
      if (agent) return `派发 ${agent}`
      return '派发中…'
    }
    default:
      return safeJson(input)
  }
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value ?? {}, null, 2)
  } catch {
    return String(value)
  }
}
