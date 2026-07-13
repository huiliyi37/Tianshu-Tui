import type {
  ApprovalRequest,
  DelegationNode,
  JobState,
  PendingQuestion,
  PendingQuestionItem,
  PlanModeState,
  SessionEvent,
  TodoStateItem,
} from '../runtime/types'
import type { EvidenceSummary } from '../../../src/agent/evidence.js'
import { normalizePath } from '../lib/projects'
import i18n from '../i18n'

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
  // Non-blocking 方向提示 (intent gate) — passive direction note.
  | 'intent_note'
  // T1 — process observability blocks.
  | 'thinking'
  | 'turn'
  | 'checkpoint'
  // T3 — mid-run user guidance echo.
  | 'steer'
  // Watchdog stall auto-recovery — 续跑决策可观测（对齐 TUI v3）。
  | 'watchdog_recovery'
  // C3 自治档检查点 — run 暂停等待用户确认。
  | 'autonomy_checkpoint'
  // Change landing — commit / merge_back / pr_created from the Changes tab.
  | 'landing'

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
  /** Non-blocking 方向提示 (intent_note) — plain-language direction note. */
  note?: {
    title: string
    reasons: string[]
    action: string
    steerHint: string
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
  /** Watchdog stall auto-recovery payload (对齐 TUI v3)。 */
  watchdog?: {
    reason: string
    autoContinue: boolean
    stopReason?: string
    dense?: boolean
    consecutive: number
    sessionTotal: number
    progressUnits: number
    /** C2 刹车 — 续跑处于可取消倒计时窗口（服务端 delayMs 后才真正 continue）。 */
    pendingAutoContinue?: boolean
    /** C2 — 倒计时时长（ms），驱动卡片倒计时展示。 */
    delayMs?: number
    /** C2 — 事件到达时刻（本地时钟），用于计算剩余秒数。 */
    receivedAt?: number
    /** C2 — 用户在窗口内取消了续跑。 */
    cancelled?: boolean
  }
  /** C3 自治档检查点 — 已连续执行的轮数。 */
  checkpointTurns?: number
  /** C3 — 进度摘要（修改文件 / 最近工具 / token 用量）。 */
  checkpointDigest?: string
  /** C3 — true=巡航档暂停等确认；false=完全自治档非阻塞播报（run 继续）。 */
  checkpointPaused?: boolean
  /** Change landing card payload (commit / merge_back / pr_created). */
  landing?: {
    action: 'commit' | 'merge_back' | 'pr_created'
    sha?: string
    url?: string
    branch?: string
  }
}

export interface EventViewState {
  lastSeq: number
  blocks: ConvoBlock[]
  /** U8: monotonic revision for blocks; bumped on every blocks mutation so
   *  consumers can memoize without paying for a full array copy each delta. */
  blocksRev: number
  pendingApproval: ApprovalRequest | null
  /** 结构化提问卡片 — 最新未回答的 ask_user_question（下一条用户消息即回答并清除）。 */
  pendingQuestion: PendingQuestion | null
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
  /**
   * Live draft body from SSE `plan_draft` (content attached when under size cap).
   * Prefer this for the PlanPanel "起草中" view to avoid waiting on GET /plans.
   */
  draftLive: { path: string; title: string | null; content: string; size: number } | null
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
  /** Background jobs (bash run_in_background), keyed by job id. */
  jobs: Record<string, JobState>
  /** Bumped on every job event so the JobsDock can re-render without deep compare. */
  jobsRev: number
  /** Completion evidence summary surfaced from the final turn_complete event. */
  completionSummary?: EvidenceSummary
  /** Timestamp (ms) when the current run started (status→running). Undefined when idle.
   *  Drives the elapsed-time indicator so users can tell if the agent is stuck. */
  runStartedAt?: number
  /** Phase 3 可靠性 — sidecar 重启打断在途 run 后的一键续跑入口（resume_offer）。
   *  携带原模型/星域（续跑缓存亲和约束）；任何新用户消息/新 run 即失效清除。 */
  resumeOffer: { seq: number; model: string | null; domain: string } | null
}

export const initialEventState: EventViewState = {
  lastSeq: 0,
  blocks: [],
  blocksRev: 0,
  pendingApproval: null,
  pendingQuestion: null,
  artifactRev: 0,
  delegation: {},
  todos: [],
  planMode: 'off',
  planRev: 0,
  draftLive: null,
  menuRev: 0,
  private_textOpen: false,
  private_thinkingOpen: false,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  lastTotalTokens: 0,
  prevTotalTokens: 0,
  sources: [],
  hookResults: [],
  jobs: {},
  jobsRev: 0,
  completionSummary: undefined,
  runStartedAt: undefined,
  resumeOffer: null,
}

/** Strip the inline Evidence markdown section from assistant text so the desktop
 *  can render it as a CompletionCurtain card instead of duplicate inline Markdown. */
function stripEvidenceMarkdown(text: string): string {
  const idx = Math.max(
    text.lastIndexOf('\n---\n## 任务完成总结'),
    text.lastIndexOf('\n---\n## Evidence'),
  )
  if (idx <= 0) return text
  return text.slice(0, idx)
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
      const streamStartSeq = typeof prev.data.streamStartSeq === 'number'
        ? prev.data.streamStartSeq
        : prev.seq
      out[out.length - 1] = {
        ...prev,
        seq: ev.seq,
        ts: ev.ts,
        data: {
          ...prev.data,
          streamStartSeq,
          text: String(prev.data.text ?? '') + String(ev.data.text ?? ''),
        },
      }
    } else {
      out.push(ev)
    }
  }
  return out
}

/** Maximum allowed block text length — prevents unbounded string growth in
 *  streaming runs. 500KB is well above any reasonable single assistant reply
 *  (~125K tokens) while capping worst-case memory use. */
const MAX_BLOCK_TEXT_LEN = 500_000

function applyEvent(state: EventViewState, ev: SessionEvent): EventViewState {
  // Idempotent replay: ignore events at or below what we've folded.
  if (ev.seq <= state.lastSeq) return state
  const next: EventViewState = { ...state, lastSeq: ev.seq }

  switch (ev.type) {
    case 'user':
      next.private_textOpen = false
      next.private_thinkingOpen = false
      // 提问卡片的回答走用户消息通道 —— 任何新用户消息都视为已回答/已跳过。
      next.pendingQuestion = null
      // 对话继续了（含续跑本身注入的提示）——续跑入口随之失效。
      next.resumeOffer = null
      next.blocks = [...next.blocks, {
        key: `u-${ev.seq}`,
        kind: 'user',
        text: String(ev.data.text ?? ''),
        ...(typeof ev.data.imageCount === 'number' && ev.data.imageCount > 0 ? { imageCount: ev.data.imageCount } : {}),
        ...(Array.isArray(ev.data.imageIds) && ev.data.imageIds.length > 0 ? { imageIds: ev.data.imageIds as string[] } : {}),
        ...(Array.isArray(ev.data.images) && ev.data.images.length > 0 ? { images: ev.data.images as string[] } : {}),
      }]
      next.blocksRev = next.blocksRev + 1
      return next
    case 'text_delta': {
      const text = String(ev.data.text ?? '')
      if (next.private_textOpen && next.blocks.length > 0) {
        const lastIdx = next.blocks.length - 1
        const last = next.blocks[lastIdx]!
        // Clone before mutating: prevents corruption of any previous snapshot
        // that shares this array reference. The shallow copy cost is negligible
        // (~4KB for 500 blocks) and only fires once per rAF frame after
        // coalesceDeltas merging.
        const blocks = next.blocks.slice()
        const appended = last.text + text
        const clamped = appended.length > MAX_BLOCK_TEXT_LEN ? appended.slice(0, MAX_BLOCK_TEXT_LEN) : appended
        blocks[lastIdx] = { ...last, text: clamped }
        next.blocks = blocks
        next.blocksRev = next.blocksRev + 1
      } else if (text) {
        next.private_thinkingOpen = false
        const streamStartSeq = typeof ev.data.streamStartSeq === 'number' ? ev.data.streamStartSeq : ev.seq
        next.blocks = [...next.blocks, { key: `t-${streamStartSeq}`, kind: 'assistant', text }]
        next.private_textOpen = true
        next.blocksRev = next.blocksRev + 1
      }
      return next
    }
    case 'thinking_delta': {
      const text = String(ev.data.text ?? '')
      if (next.private_thinkingOpen && next.blocks.length > 0) {
        const lastIdx = next.blocks.length - 1
        const last = next.blocks[lastIdx]!
        const blocks = next.blocks.slice()
        const appended = last.text + text
        const clamped = appended.length > MAX_BLOCK_TEXT_LEN ? appended.slice(0, MAX_BLOCK_TEXT_LEN) : appended
        blocks[lastIdx] = { ...last, text: clamped }
        next.blocks = blocks
        next.blocksRev = next.blocksRev + 1
      } else if (text) {
        next.private_textOpen = false
        const streamStartSeq = typeof ev.data.streamStartSeq === 'number' ? ev.data.streamStartSeq : ev.seq
        next.blocks = [...next.blocks, { key: `th-${streamStartSeq}`, kind: 'thinking', text }]
        next.private_thinkingOpen = true
        next.blocksRev = next.blocksRev + 1
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
      next.blocksRev = next.blocksRev + 1
      const toolName = String(ev.data.name ?? '')
      if (FILE_TOOLS.has(toolName)) {
        const input = (ev.data.input ?? {}) as Record<string, unknown>
        const filePath = String(input.path ?? input.file_path ?? input.target ?? '')
        // Dedup on a normalized key so the same file referenced via different
        // separators or casing (Windows) is not listed twice; display the
        // original path as first seen.
        if (filePath && !next.sources.some((s) => normalizePath(s) === normalizePath(filePath))) {
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
      next.blocksRev = next.blocksRev + 1
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
      // Capture structured completion evidence for the desktop curtain card.
      if (ev.data.evidence && typeof ev.data.evidence === 'object') {
        next.completionSummary = ev.data.evidence as EvidenceSummary
      }
      // Avoid duplicating the evidence markdown inline when a curtain card will render it.
      if (lastBlock.kind === 'assistant') {
        const stripped = stripEvidenceMarkdown(lastBlock.text)
        if (stripped !== lastBlock.text) {
          next.blocks = next.blocks.slice(0, -1)
          next.blocks.push({ ...lastBlock, text: stripped })
          next.blocksRev = next.blocksRev + 1
        }
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
      next.blocksRev = next.blocksRev + 1
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
      next.blocksRev = next.blocksRev + 1
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
      next.blocksRev = next.blocksRev + 1
      return next
    }
    case 'watchdog_recovery': {
      // Suppressed stalls (approval modal in flight) — the modal already owns
      // the user's attention; a second card would be noise.
      if (ev.data.stopReason === 'suppressed') return next
      // C2 — cancellation marker: the user aborted during the countdown window.
      // Mark the pending card cancelled in place instead of appending a new one.
      if (ev.data.cancelled === true) {
        let marked = false
        next.blocks = next.blocks.map((b) => {
          if (!marked && b.kind === 'watchdog_recovery' && b.watchdog?.pendingAutoContinue && !b.watchdog.cancelled) {
            marked = true
            return { ...b, text: i18n.t('thread:reducer.watchdogCancelled'), watchdog: { ...b.watchdog, cancelled: true } }
          }
          return b
        })
        if (marked) next.blocksRev = next.blocksRev + 1
        return next
      }
      next.private_textOpen = false
      next.private_thinkingOpen = false
      const autoContinue = ev.data.autoContinue === true
      const pendingAutoContinue = ev.data.pendingAutoContinue === true
      next.blocks = [...next.blocks, {
        key: `wr-${ev.seq}`,
        kind: 'watchdog_recovery',
        text: autoContinue
          ? (pendingAutoContinue ? i18n.t('thread:reducer.watchdogPending') : i18n.t('thread:reducer.watchdogAutoRecovering'))
          : i18n.t('thread:reducer.watchdogStopped'),
        watchdog: {
          reason: String(ev.data.reason ?? ''),
          autoContinue,
          stopReason: ev.data.stopReason ? String(ev.data.stopReason) : undefined,
          dense: ev.data.dense === true,
          consecutive: Number(ev.data.consecutive ?? 0),
          sessionTotal: Number(ev.data.sessionTotal ?? 0),
          progressUnits: Number(ev.data.progressUnits ?? 0),
          ...(pendingAutoContinue ? {
            pendingAutoContinue: true,
            delayMs: Number(ev.data.delayMs ?? 5000),
            receivedAt: Date.now(),
          } : {}),
        },
      }]
      next.blocksRev = next.blocksRev + 1
      return next
    }
    case 'autonomy_checkpoint': {
      // C3 — cruise pause (paused=true, awaits confirmation) or unleashed
      // non-blocking progress ping (paused=false, the run keeps going).
      const paused = ev.data.paused !== false
      if (paused) {
        next.private_textOpen = false
        next.private_thinkingOpen = false
      }
      next.blocks = [...next.blocks, {
        key: `acp-${ev.seq}`,
        kind: 'autonomy_checkpoint',
        text: paused ? i18n.t('thread:reducer.autonomyCheckpoint') : i18n.t('thread:reducer.autonomyProgress'),
        checkpointTurns: Number(ev.data.turns ?? 0),
        checkpointDigest: typeof ev.data.digest === 'string' ? ev.data.digest : undefined,
        checkpointPaused: paused,
      }]
      next.blocksRev = next.blocksRev + 1
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
      next.blocksRev = next.blocksRev + 1
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
      next.blocksRev = next.blocksRev + 1
      return next
    }
    case 'status':
      next.status = String(ev.data.status ?? next.status ?? '')
      // Track run start timestamp for the elapsed-time indicator.
      if (next.status === 'running') {
        next.runStartedAt = ev.ts
        next.resumeOffer = null // 新 run 开始 → 续跑入口失效
      } else next.runStartedAt = undefined
      return next
    case 'done':
      // Run settled — reflect the final status immediately instead of waiting
      // for the next sessions poll, and close any streaming affordances.
      next.status = String(ev.data.status ?? next.status ?? '')
      next.private_textOpen = false
      next.private_thinkingOpen = false
      next.runStartedAt = undefined
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
      // Sidecar restart closed out an approval the crash left dangling — the
      // user never answered it, so surface WHAT was pending as a timeline
      // marker instead of silently dropping the card.
      if (ev.data.decision === 'sidecar-restart') {
        const tool = String(ev.data.toolName ?? '')
        next.blocks = [...next.blocks, {
          key: `ar-${ev.seq}`,
          kind: 'phase',
          text: tool
            ? i18n.t('thread:reducer.approvalInterruptedTool', { tool })
            : i18n.t('thread:reducer.approvalInterrupted'),
        }]
        next.blocksRev = next.blocksRev + 1
      }
      return next
    case 'intent_note': {
      next.private_textOpen = false
      next.private_thinkingOpen = false
      const reasons = Array.isArray(ev.data.reasons) ? (ev.data.reasons as unknown[]).map((r) => String(r)) : []
      next.blocks = [...next.blocks, {
        key: `in-${ev.seq}`,
        kind: 'intent_note',
        text: String(ev.data.summary ?? ''),
        note: {
          title: String(ev.data.title ?? i18n.t('thread:reducer.intentNoteTitle')),
          reasons,
          action: String(ev.data.action ?? ''),
          steerHint: String(ev.data.steerHint ?? ''),
        },
      }]
      next.blocksRev = next.blocksRev + 1
      return next
    }
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
        artifactId: ev.data.artifactId != null ? String(ev.data.artifactId) : prev?.artifactId,
        changedFiles: Array.isArray(ev.data.changedFiles) ? (ev.data.changedFiles as string[]) : prev?.changedFiles,
        summary: ev.data.summary != null ? String(ev.data.summary) : prev?.summary,
        origin: ev.data.origin === 'user' || ev.data.origin === 'agent' ? ev.data.origin : prev?.origin,
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
      if (next.planMode !== 'planning') next.draftLive = null
      return next
    case 'user_question': {
      const raw = Array.isArray(ev.data.questions) ? (ev.data.questions as unknown[]) : []
      const questions: PendingQuestionItem[] = []
      for (const entry of raw) {
        if (!entry || typeof entry !== 'object') continue
        const q = entry as Record<string, unknown>
        const prompt = typeof q.prompt === 'string' ? q.prompt : ''
        if (!prompt) continue
        questions.push({
          id: typeof q.id === 'string' && q.id ? q.id : `q${questions.length + 1}`,
          prompt,
          options: Array.isArray(q.options) ? (q.options as unknown[]).filter((o): o is string => typeof o === 'string') : [],
          allowMultiple: q.allowMultiple === true,
        })
      }
      next.pendingQuestion = questions.length > 0
        ? { toolUseId: String(ev.data.toolUseId ?? ''), questions }
        : null
      return next
    }
    case 'plan_submitted': {
      next.planRev = next.planRev + 1
      const slug = typeof ev.data.slug === 'string' ? ev.data.slug : ''
      if (slug) next.latestPlanSlug = slug
      return next
    }
    // Plan-mode draft grew — bump planRev for list/metadata refresh; when SSE
    // carries `content`, stash it as draftLive so PlanPanel paints without GET.
    case 'plan_draft': {
      next.planRev = next.planRev + 1
      const path = typeof ev.data.path === 'string' ? ev.data.path : ''
      const content = typeof ev.data.content === 'string' ? ev.data.content : null
      if (path && content !== null) {
        next.draftLive = {
          path,
          title: typeof ev.data.title === 'string' ? ev.data.title : null,
          content,
          size: typeof ev.data.size === 'number' ? ev.data.size : content.length,
        }
      }
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
      next.blocksRev = next.blocksRev + 1
      return next
    case 'landing': {
      const action = ev.data.action === 'commit' || ev.data.action === 'merge_back' || ev.data.action === 'pr_created'
        ? ev.data.action
        : null
      if (!action) return next
      next.blocks = [...next.blocks, {
        key: `ld-${ev.seq}`,
        kind: 'landing',
        text: '',
        landing: {
          action,
          sha: typeof ev.data.sha === 'string' ? ev.data.sha : undefined,
          url: typeof ev.data.url === 'string' ? ev.data.url : undefined,
          branch: typeof ev.data.branch === 'string' ? ev.data.branch : undefined,
        },
      }]
      next.blocksRev = next.blocksRev + 1
      return next
    }
    case 'resume_offer':
      // 重启打断在途 run —— 提供一键续跑入口（严格沿用原模型/星域；服务端
      // resumeRun fail-closed 保证不静默换默认模型）。
      next.resumeOffer = {
        seq: ev.seq,
        model: typeof ev.data.model === 'string' && ev.data.model ? ev.data.model : null,
        domain: String(ev.data.domain ?? 'auto'),
      }
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
    case 'job': {
      const id = String(ev.data.id ?? '')
      if (!id) return next
      const status = ev.data.status === 'exited' || ev.data.status === 'killed' ? ev.data.status : 'running'
      const prev = next.jobs[id]
      const job: JobState = {
        id,
        command: ev.data.command != null ? String(ev.data.command) : (prev?.command ?? ''),
        status,
        exitCode: ev.data.exitCode != null ? Number(ev.data.exitCode) : prev?.exitCode,
        startedAt: ev.data.startedAt != null ? Number(ev.data.startedAt) : (prev?.startedAt ?? ev.ts),
        endedAt: ev.data.endedAt != null ? Number(ev.data.endedAt) : prev?.endedAt,
        lastLine: ev.data.lastLine != null ? String(ev.data.lastLine) : (prev?.lastLine ?? ''),
        pid: ev.data.pid != null ? Number(ev.data.pid) : prev?.pid,
      }
      next.jobs = { ...next.jobs, [id]: job }
      next.jobsRev = next.jobsRev + 1
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
      return `${path}\n${i18n.t('thread:reducer.writeStat', { lines, chars: content.length })}`
    }
    case 'edit_file':
    case 'hash_edit': {
      const old = String(input.old_string ?? input.old ?? '')
      const nw = String(input.new_string ?? input.new ?? '')
      return `${path}\n${i18n.t('thread:reducer.editStat', { oldLines: old.split('\n').length, newLines: nw.split('\n').length })}`
    }
    case 'apply_patch':
      return `${path}\n${i18n.t('thread:reducer.patchStat', { lines: String(input.patch ?? input.diff ?? '').split('\n').length })}`
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
      if (tasks.length === 0) return i18n.t('thread:reducer.delegateWaiting')
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
      if (agent) return i18n.t('thread:reducer.delegateAgent', { agent })
      return i18n.t('thread:reducer.delegating')
    }
    case 'browser_debug': {
      const act = String(input.action ?? '')
      const detail = input.url ?? input.selector ?? input.request_id ?? input.url_filter ?? ''
      return detail ? `${act} ${detail}` : act
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
