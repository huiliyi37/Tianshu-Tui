import type { AgentCallbacks } from './loop-types.js'
import type { TurnHeartbeat } from './turn-heartbeat.js'
import type { ResourceSensorSnapshot } from './resource-sensor.js'
import type { TurnBudget } from './turn-budget.js'
import type { FsWatcherState } from '../context/fs-watcher.js'
import type { TraceStore } from './trace-store.js'
import type { ImportGraph } from './import-graph.js'
import type { RiskAssessment } from './approval-risk.js'
import type { PlanModeState } from './plan-mode.js'
import type { StreamRule } from './turn-stream.js'
import type { TurnMode } from '../context/task-contract.js'
import type { Usage } from '../api/types.js'
import type { OaiMessage } from '../api/oai-types.js'
import type { PressureResult } from '../context/pressure-monitor.js'
import type { Sensorium, StrategyProfile } from './sensorium.js'
import { createTurnBudget } from './turn-budget.js'
import { getGitChangeRate, smoothChangeRate } from './git-freshness.js'
import { rejectOnAbort } from './turn-boundary-abort.js'
import { abortableDelay } from '../api/retry-engine.js'
import { classifyApiError } from '../api/error-classifier.js'
import type { GoalContinuationController } from './goal-continuation.js'
import type { PostTurnDecisionController } from './post-turn-decision.js'
import type { TelemetryRecord } from './telemetry-writer.js'
import { emitStopReason, type StopReason } from './stop-reason.js'
import type { AdvisoryEntry } from './advisory-bus.js'
import { debugLog } from '../utils/debug.js'
import { hasActionIntent, hasWriteActionIntent, turnUsedOnlyReadTools, DELIVERY_SIGNAL_RE } from './action-intent-detector.js'

// ── Types re-exported for deps interface ──

export interface StreamTurnParams {
  request: import('../api/oai-types.js').OaiChatRequest
  turn: number
  lastTurnTextFingerprint: string
  streamRules?: StreamRule[]
  disabledRulePatterns: ReadonlySet<string>
  callbacks: {
    onTextDelta: (text: string) => void
    onThinkingDelta: (thinking: string) => void
    onToolUse: AgentCallbacks['onToolUse']
    onToolHint: (name: string) => void
    onStreamStart: () => void
    onError: AgentCallbacks['onError']
    onRateLimit: (retryDelayMs?: number) => void
  }
}

export interface StreamTurnResult {
  collectedBlocks: import('../api/types.js').ContentBlock[]
  thinkingAccum: string
  toolUses: Array<{ id: string; name: string; input: Record<string, unknown> }>
  stopReason: string
  streamError: Error | null
  lastTurnTextFingerprint: string
  lastTurnThinkingFingerprint: string
  triggeredRule?: StreamRule
}

export interface ExecuteBatchParams {
  toolUses: Array<{ id: string; name: string; input: Record<string, unknown> }>
  callbacks: AgentCallbacks
  turn: number
  checkpointCreatedThisTurn: boolean
  abortSignal: AbortSignal
  traceStore: TraceStore
  importGraph: ImportGraph | null
  lastConflictCheckCount: number
  latestRisk: RiskAssessment
}

export interface ExecuteBatchResult {
  checkpointCreated: boolean
  traceStore: TraceStore
  importGraph: ImportGraph | null
  lastConflictCheckCount: number
  latestRisk: RiskAssessment
  artifactIdsEvicted: string[]
  artifactIdsAccessed: string[]
  /** True when any tool in the batch returned endTurn: true (e.g. ask_user_question).
   *  The orchestrator uses this to end the turn as final. */
  endTurn?: boolean
  /** Number of tool_use in this batch — for wedged-loop detection. */
  toolCount: number
  /** Number of tool_result marked is_error in this batch — for wedged-loop detection. */
  errorCount: number
}

export interface CompleteTurnParams {
  turn: number
  isFinal: boolean
  callbacks: AgentCallbacks
}

export interface CacheTurnEndParams {
  turn: number
  cacheRead: number
  cacheCreation: number
  prefixChanged: boolean
  artifactIdsEvicted: string[]
  artifactIdsAccessed: string[]
}

// ── TurnStateBag: getter/setter view into AgentLoop mutable fields ──

export interface TurnStateBag {
  streamedText: string
  lastPrewarmAt: number
  gitChangeRate: number
  turnBudget: TurnBudget
  latestFsWatcherState: FsWatcherState
  consecutiveNoToolTurns: number
  /** Consecutive turns where ALL tool calls were read-only (read_file/grep/glob etc). */
  consecutiveReadOnlyTurns: number
  /** Fingerprint of the last fully-errored tool batch — for wedged-loop detection. */
  wedgeToolFingerprint: string
  /** Consecutive identical fully-errored tool batches — for wedged-loop detection. */
  wedgeRepeatCount: number
  thinkingOnlyRetries: number
  lastThinkingContent: string
  lastTurnTextFingerprint: string
  lastTurnThinkingFingerprint: string
  recentTextFingerprints: string[]
  turnsSinceLastObjection: number
  traceStore: TraceStore
  importGraph: ImportGraph | null
  lastConflictCheckCount: number
  latestRisk: RiskAssessment
  thetaRequestsThisTurn: number
  taskContract: import('../context/task-contract.js').TaskContract | undefined
  /** 当前 run 的循环轮数(缺口 C/D:intent-anchor / turn-budget hook 消费) */
  runLoopTurn: number
}

// ── Deps interface ──

export interface TurnOrchestratorDeps {
  // === Lifecycle ===
  initializeRun: (userInput: string, callbacks: AgentCallbacks, images?: string[]) => Promise<{
    heartbeat: TurnHeartbeat
    wrappedCallbacks: AgentCallbacks
    actionable: boolean
    turnMode: TurnMode
  }>
  stopFsWatcher: () => void

  // === Config ===
  getMaxTurns: () => number
  /** C3 检查点间隔 — Auto 模式下每 N 轮暂停（0 = 关）。YOLO 和 Manual 模式不读此字段。 */
  getCheckpointEveryTurns: () => number
  /** C3 — build the progress digest attached to checkpoint pauses. */
  buildProgressDigest: (turns: number) => string
  getTurnLevelThinking: () => boolean | undefined
  getPlanModeState: () => PlanModeState
  getStreamRules: () => StreamRule[] | undefined
  getAgentReconnect: () => { enabled?: boolean; maxAttempts?: number; backoffMs?: number } | undefined
  getCwd: () => string
  getSessionId: () => string | undefined
  setClientThinking: (mode: 'enabled' | 'disabled') => void
  flushMeridianTurn: () => void
  syncPlanModeToConfig: () => void

  // === Session ===
  removeLastMessage: () => void
  addUserMessage: (content: string) => void
  appendSystemReminder: (content: string) => void
  addAssistantBlocks: (blocks: import('../api/types.js').ContentBlock[]) => void
  addUsage: (usage: { output_tokens: number }) => void
  getEstimatedTokens: () => number
  getMessages: () => OaiMessage[]
  getTotalUsage: () => Usage
  getTurnCount: () => number
  getCacheHistory: () => Array<{ turn: number; cacheRead: number; cacheCreation: number }>

  // === Sub-processes (thin wrappers, already extracted in AgentLoop) ===
  runCompaction: (turn: number, snap: ResourceSensorSnapshot | null) => Promise<{
    compacted: boolean
    shouldAbort: boolean
    userMessageConsumed: boolean
  }>
  runPerception: (turn: number, estTokens: number, actionable: boolean, callbacks: AgentCallbacks) => Promise<{
    sensorium: Sensorium
    strategy: StrategyProfile
    phaseClass: string
    pressureResult: PressureResult
  }>
  runConvergenceCheck: (turn: number, phaseClass: string, assistantResponded: boolean, userMessageConsumed: boolean, callbacks: AgentCallbacks) => Promise<{
    action: 'proceed' | 'abort'
  }>
  runReplanCheck: () => void
  buildTurnRequest: (turn: number, strategy: StrategyProfile, sensorium: Sensorium, pressureResult: PressureResult, assistantResponded: boolean, userMessageConsumed: boolean, callbacks: AgentCallbacks) => Promise<{
    action: 'proceed' | 'abort'
    request?: import('../api/oai-types.js').OaiChatRequest
  }>
  prewarmRecentReads: () => Promise<void>
  runPostSession: (callbacks: AgentCallbacks) => Promise<void>
  recordProviderOutcome: (ok: boolean) => void

  // === Sub-controllers ===
  streamTurn: (params: StreamTurnParams) => Promise<StreamTurnResult>
  executeBatch: (params: ExecuteBatchParams) => Promise<ExecuteBatchResult>
  /** Tier 2 LLM speculation — fire-and-forget shared-prefix prediction call
   *  launched alongside executeBatch (the tool await window). Optional: absent
   *  when llmSpeculation config is off, so the default path pays zero cost. */
  speculateDuringBatch?: (params: {
    request: import('../api/oai-types.js').OaiChatRequest
    toolUses: Array<{ id: string; name: string; input: Record<string, unknown> }>
    turn: number
    signal?: AbortSignal
  }) => void
  completeTurn: (params: CompleteTurnParams) => Promise<void>
  appendTurnResult: (turn: number) => void
  onCacheAdvisorTurnEnd: (params: CacheTurnEndParams) => void

  // === Telemetry ===
  writeTelemetry: (entry: TelemetryRecord) => void
  resetEvidence: () => void

  // === Stop-reason 落盘（2026-07-07 观测缺口修复）===
  /** 把结构化停止原因写进 AgentLoop.latestStopReason + session meta。
   *  可选：缺省时 emitStop 仍走 debug/遥测/phase，只是不落盘。 */
  recordStopReason?: (r: StopReason) => void

  // === Advisory 总线（action-intent 闸门核销接入）===
  /** 提交一条 advisory（走效能账本 + expect 核销）。缺省时闸门回退
   *  appendSystemReminder 直注（行为不变，只是不计账）。 */
  submitAdvisory?: (entry: AdvisoryEntry) => void

  // === W3 诊断态识别（incident 20b9714e）===
  /** 会话活动模式。diagnostic = 近窗口只读为主 + 零改动（排查/根因分析）。
   *  B2 催收敛文案据此分流为"先核实断言再收束"。缺省 = 恒 build（旧行为）。 */
  getActivityMode?: () => 'diagnostic' | 'build'

  // === Abort signal ===
  // === Abort signal ===
  getAbortSignal: () => AbortSignal | undefined

  // === Heartbeat (P7 watchdog) ===
  getHeartbeat: () => import('./turn-heartbeat.js').TurnHeartbeat | null

  // === Abort reason (watchdog vs user) ===
  getAbortReason: () => string | undefined

  // === Resource sensor ===
  getLatestResourceSnapshot: () => ResourceSensorSnapshot | null

  // === FsWatcher ===
  getFsWatcherState: () => FsWatcherState

  // === Per-run state (getter/setter view into AgentLoop mutable fields) ===
  state: TurnStateBag
  getDoomLoopLevel: () => 'none' | 'warn' | 'blocked'

  // === Sub-controllers ===
  goalContinuation: GoalContinuationController
  postTurnDecision: PostTurnDecisionController
}

// ── Standalone: wrapCallbacksWithHeartbeat ──

/**
 * P7: wrap AgentCallbacks so every UI-visible event resets the heartbeat
 * silence clock. Heartbeat fires only during true silent gaps (no text
 * delta, no tool result, no phase change for `silentMs`).
 *
 * Extracted as a standalone function so both AgentLoop.initializeRun and
 * TurnOrchestrator (if needed) can use it without a circular import.
 */
export function wrapCallbacksWithHeartbeat(cb: AgentCallbacks, hb: TurnHeartbeat): AgentCallbacks {
  return {
    ...cb,
    onTextDelta: (text) => { hb.tick('streaming text'); cb.onTextDelta(text) },
    onThinkingDelta: (thinking) => { hb.tick('thinking'); cb.onThinkingDelta(thinking) },
    onToolUse: (id, name, input) => { hb.tick(`calling ${name}`); cb.onToolUse(id, name, input) },
    onToolResult: (id, name, result, isError, rawPath, uiContent) => {
      hb.tick(`${name} returned`)
      cb.onToolResult(id, name, result, isError, rawPath, uiContent)
    },
    onTurnComplete: (usage, turnNumber, isFinal, evidenceSummary) => {
      hb.tick(`turn ${turnNumber} complete`)
      cb.onTurnComplete(usage, turnNumber, isFinal, evidenceSummary)
    },
    onPhaseChange: (phase, detail) => {
      // Heartbeat-emitted phases must NOT recursively reset the clock.
      if (phase !== 'heartbeat') hb.tick(`phase: ${phase}`)
      cb.onPhaseChange?.(phase, detail)
    },
  }
}

// ── TurnOrchestrator ──

const MAX_RULE_RETRIES = 2

/** Consecutive identical fully-errored tool batches before the run is ended as a
 *  wedged loop. Guards against the "requires user approval" denial loop (and any
 *  same-args-same-error retry) spinning to maxTurns and ballooning context → OOM. */
const MAX_WEDGE_REPEATS = 3

/** Grace period to let an aborted `executeBatch` finish committing its tool
 *  results in-order before the turn tears down. `rejectOnAbort` stops awaiting
 *  the batch to keep the UI responsive on Esc, but the batch keeps running and
 *  calls `addToolResults()` later — if that write lands after the NEXT turn has
 *  appended messages, the tool result is detached from its assistant tool_calls
 *  and the provider rejects the following request ("insufficient tool messages
 *  following tool_calls"). Draining here lands the commit in-order in the common
 *  (abort-cooperative) case; the bound preserves responsiveness when a tool is
 *  wedged, and runResumePreflightOai backstops any overrun at request-build time. */
const TOOL_ABORT_DRAIN_MS = 3000

/** Order-preserving fingerprint of a tool batch (name + input). Two batches with
 *  the same tools and args produce the same string, so a model re-emitting an
 *  identical failing call is detectable across turns. */
function toolBatchFingerprint(toolUses: { name: string; input: unknown }[]): string {
  try {
    return JSON.stringify(toolUses.map(tu => [tu.name, tu.input]))
  } catch {
    return toolUses.map(tu => tu.name).join('|')
  }
}

/** 两次 action-intent 提醒之间最小间隔（ms）。频繁对话场景下避免每轮注入重复提醒。 */
const ACTION_INTENT_COOLDOWN_MS = 30_000

export class TurnOrchestrator {
  /** 上次注入 action-intent system-reminder 的时间戳。跨 run 冷却，避免频繁对话下追着提醒。 */
  private lastActionIntentNudgeTime = 0

  constructor(private deps: TurnOrchestratorDeps) {}

  /**
   * Surface a structured stop-reason for a loop-terminating path (why the turn
   * loop ended). Routes through debugLog + telemetry + onPhaseChange so a
   * premature guard-forced stop is distinguishable from a voluntary finish. No
   * history rewrite — prefix-cache safe.
   */
  private emitStop(reason: StopReason, callbacks: AgentCallbacks): void {
    emitStopReason(reason, {
      record: this.deps.recordStopReason,
      debug: debugLog,
      telemetry: rec => this.deps.writeTelemetry(rec as TelemetryRecord),
      onPhaseChange: callbacks.onPhaseChange,
    })
  }

  /** 只落盘 + debug/遥测，不走 onPhaseChange —— 用于 onAbort/onError 已负责
   *  UI 呈现的路径（用户中断 / 流错误），避免同一次停止渲染两条系统行。 */
  private recordStop(reason: StopReason): void {
    emitStopReason(reason, {
      record: this.deps.recordStopReason,
      debug: debugLog,
      telemetry: rec => this.deps.writeTelemetry(rec as TelemetryRecord),
    })
  }

  /**
   * Execute the full turn loop for a single run() invocation.
   *
   * Previously AgentLoop._runInner — extracted verbatim with control flow
   * preserved. All AgentLoop field accesses routed through deps.
   */
  async execute(userInput: string, callbacks: AgentCallbacks, images?: string[]): Promise<void> {
    const { heartbeat, wrappedCallbacks, actionable, turnMode } = await this.deps.initializeRun(userInput, callbacks, images)
    callbacks = wrappedCallbacks

    let checkpointCreatedThisTurn = false

    // Track whether any assistant response was produced this turn.
    // If the turn is aborted before any assistant output, we roll back
    // the user message so it doesn't pollute context on retry.
    let assistantResponded = false
    // Track whether compaction consumed the user message (session split /
    // LLM compact replace the message list). When true, skip removeLastMessage
    // because the user message no longer exists at the top of the stack.
    let userMessageConsumed = false

    // TTSR retry governor: cap how many times each stream rule may abort+retry
    // within a single run(). Without a cap, a model that keeps emitting a
    // matched command loops until maxTurns, spamming injected reminders. After
    // the cap, the rule is disabled for the rest of the run so the turn can
    // proceed.
    const ruleTriggerCounts = new Map<string, number>()
    const disabledRulePatterns = new Set<string>()
    let lastInjectedReminder = ''

    // Whether a final (isFinal: true) turn completion was emitted. The turn
    // loop can exhaust maxTurns without ever reaching the text-only break
    // path — in that case the TUI never sees a final completion, its busy
    // latch stays set, and the next user message gets routed to the steer
    // buffer instead of starting a new run.
    let finalTurnCompleted = false
    let actionIntentFiredThisRun = false
    let turnCallLimitAdvisoryFired = false

    try {
      // maxTurns <= 0 means "no hard cap" (true YOLO / autonomous mode). The for
    // loop uses Number.MAX_SAFE_INTEGER as a practically-infinite upper bound so
    // wedged-loop / convergence / context-pressure guards still terminate a
    // runaway run — only the artificial turn-count ceiling is removed.
    const maxTurns = this.deps.getMaxTurns()
    const effectiveLimit = maxTurns > 0 ? maxTurns : Number.MAX_SAFE_INTEGER
    for (let turn = 0; turn < effectiveLimit; turn++) {
        this.deps.state.thetaRequestsThisTurn = 0
        this.deps.state.runLoopTurn = turn
        // Sync plan-mode state into config so tool-pipeline gate reads it
        this.deps.syncPlanModeToConfig()
        const signal = this.deps.getAbortSignal()
        if (signal?.aborted) {
          if (!assistantResponded && !userMessageConsumed) this.deps.removeLastMessage()
          const abortTag = this.deps.getAbortReason()
          this.recordStop({
            source: abortTag?.includes('watchdog') ? 'watchdog-stall' : 'user-interrupt',
            turn,
            voluntary: false,
            ...(abortTag !== undefined && { detail: abortTag }),
          })
          callbacks.onAbort(abortTag)
          return
        }

        // ── C3 Auto 模式检查点 ──
        // Auto mode has no approval brakes; checkpointEveryTurns gives
        // users a periodic pause point. 0 = off (default).
        // YOLO mode gets 0 from getCheckpointEveryTurns() and skips this.
        const checkpointEvery = this.deps.getCheckpointEveryTurns()
        if (checkpointEvery > 0 && turn > 0 && turn >= checkpointEvery) {
          const digest = this.deps.buildProgressDigest(turn)
          this.emitStop({
            source: 'checkpoint',
            turn,
            voluntary: false,
            detail: `autonomy checkpoint every ${checkpointEvery} turns`,
          }, callbacks)
          callbacks.onAutonomyCheckpoint?.({ turns: turn, digest, paused: true })
          callbacks.onTurnComplete(this.deps.getTotalUsage(), this.deps.getTurnCount(), true)
          finalTurnCompleted = true
          break
        }

        const estTokens = this.deps.getEstimatedTokens()
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- TS narrows to null but later turns reassign
        const snap = this.deps.getLatestResourceSnapshot() as ResourceSensorSnapshot | null
        const rssRatio = snap
          ? snap.memory.rssBytes / snap.memory.memoryLimitBytes
          : 0
        this.deps.state.turnBudget = createTurnBudget(rssRatio)

        // Step 6b: run compaction (session split, maybeCompact, stale rounds, heap)
        {
          this.deps.getHeartbeat()?.tick('compaction')
          const compactionResult = await rejectOnAbort(
            this.deps.runCompaction(turn, snap),
            signal!,
            'compaction',
          )
          if (compactionResult.shouldAbort) {
            if (!assistantResponded && !compactionResult.userMessageConsumed) this.deps.removeLastMessage()
            callbacks.onAbort(this.deps.getAbortReason())
            return
          }
          if (compactionResult.userMessageConsumed) userMessageConsumed = true
        }

        this.deps.state.streamedText = ''
        this.deps.state.lastPrewarmAt = 0
        let _tb = Date.now()
        this.deps.getHeartbeat()?.tick('prewarm')
        await rejectOnAbort(this.deps.prewarmRecentReads(), signal!, 'prewarm')
        debugLog(`[turn-boundary] turn=${turn} prewarmRecentReads: ${Date.now() - _tb}ms`)

        // ── Git freshness: file change rate (Zeitgeber signal) ──
        getGitChangeRate(this.deps.getCwd()).then(rate => {
          this.deps.state.gitChangeRate = smoothChangeRate(rate, this.deps.state.gitChangeRate)
        }).catch(() => {})

        // ── FS freshness: realtime external Zeitgeber signal ──
        this.deps.state.latestFsWatcherState = this.deps.getFsWatcherState() ?? { eventRate: 0, eventCount: 0, active: false }

        // Step 6c: run perception (sensorium, season, phase class, contract)
        this.deps.getHeartbeat()?.tick('perception')
        const { sensorium: currentSensorium, strategy: currentStrategy, phaseClass, pressureResult } = await rejectOnAbort(
          this.deps.runPerception(turn, estTokens, actionable, callbacks),
          signal!,
          'perception',
        )

        // Step 6d: run convergence check
        {
          // Wrapped for parity with the other boundary steps: convergence can
          // call trySessionSplit → llmCompact (a network call) whose internal
          // abort cooperation is exactly the unreliable mechanism this commit
          // backstops. Without the race, a watchdog abort can't free a wedge here.
          //
          // Also disarm the hard-stall watchdog during convergence: llmCompact
          // is a legitimate lengthy operation (30-60s on slow models), not a
          // wedge. Informational heartbeats stay alive so the UI doesn't freeze.
          const convHeartbeat = this.deps.getHeartbeat()
          convHeartbeat?.disarmWatchdog()
          let convAction: string
          try {
            const convResult = await rejectOnAbort(
              this.deps.runConvergenceCheck(turn, phaseClass, assistantResponded, userMessageConsumed, callbacks),
              signal!,
              'convergence',
            )
            convAction = convResult.action
          } finally {
            convHeartbeat?.rearmWatchdog()
          }
          if (convAction === 'abort') return
        }

        // Step 6e: U6 replan check — detect deviation from the plan trace and
        // inject a course-correction. Runs after convergence (latestConvergenceResult
        // is fresh) and before buildTurnRequest (so the appendix reflects this turn).
        this.deps.runReplanCheck()

        _tb = Date.now()
        // Step 6f: build turn request (intent, repair, context ceiling, cross-session, prompt)
        this.deps.getHeartbeat()?.tick('build-request')
        const turnRequest = await rejectOnAbort(
          this.deps.buildTurnRequest(turn, currentStrategy, currentSensorium, pressureResult, assistantResponded, userMessageConsumed, callbacks),
          signal!,
          'build-request',
        )
        if (turnRequest.action === 'abort') return
        const request = turnRequest.request!

        // Turn-level thinking (GLM): disable thinking on tool execution turns
        // to reduce reasoning_content accumulation. Plan Mode also disables
        // provider-side thinking: plan_submit already requires a large polished
        // document, and hidden reasoning streams can consume the whole timeout
        // before the model emits the tool call. Normal analysis turns keep the
        // previous behavior.
        if (this.deps.getTurnLevelThinking() && this.deps.setClientThinking) {
          const messages = this.deps.getMessages()
          const lastMsg = messages[messages.length - 1]
          const isToolExecTurn = lastMsg?.role === 'tool'
          const isPlanModeTurn = this.deps.getPlanModeState() === 'planning'
          this.deps.setClientThinking(isToolExecTurn || isPlanModeTurn ? 'disabled' : 'enabled')
        }

        let turnTextAccum = ''
        let turnThinkingAccum = ''
        let rateLimitOccurred = false
        let rateLimitRetryMs = 0
        const prevThinkingFingerprint = this.deps.state.lastTurnThinkingFingerprint
        let turnDedupState: 'tracking' | 'flushed' = 'tracking'
        let pendingFlush = ''
        const prevFingerprint = this.deps.state.lastTurnTextFingerprint

        // L0 streaming-executor telemetry: measure stream + tool execution latency.
        const turnStartMs = Date.now()

        const streamOnce = () => this.deps.streamTurn({
          request,
          turn,
          lastTurnTextFingerprint: this.deps.state.lastTurnTextFingerprint,
          streamRules: this.deps.getStreamRules(),
          disabledRulePatterns,
          callbacks: {
            onTextDelta: (text) => {
              turnTextAccum += text
              if (turnDedupState === 'flushed') {
                callbacks.onTextDelta(text)
                return
              }
              if (!prevFingerprint) {
                turnDedupState = 'flushed'
                callbacks.onTextDelta(text)
                return
              }
              pendingFlush += text
              const fp = turnTextAccum.replace(/\s+/g, ' ').trim()
              if (!prevFingerprint.startsWith(fp)) {
                // Diverged or extended beyond the previous fingerprint — flush all pending
                // and switch to pass-through. Do not suppress mid-stream: a full match so
                // far may still be followed by new content in a later delta.
                turnDedupState = 'flushed'
                callbacks.onTextDelta(pendingFlush)
                pendingFlush = ''
              }
              // else: still equal to or a prefix of prev fingerprint, keep buffering until stream end
            },
            onThinkingDelta: (thinking) => {
              // Cross-turn thinking fingerprint dedup: if the model repeats
              // thinking from the previous turn verbatim, suppress display.
              // Only suppress exact full-match (not prefixes — early reasoning
              // steps legitimately overlap across turns).
              turnThinkingAccum += thinking
              if (prevThinkingFingerprint && turnThinkingAccum === prevThinkingFingerprint) {
                return // suppress — identical to previous turn's thinking
              }
              callbacks.onThinkingDelta(thinking)
            },
            onToolUse: callbacks.onToolUse,
            onToolHint: (name) => {
              callbacks.onPhaseChange?.('tool-hint', { tool: name, reason: `preparing ${name}…` })
            },
            onStreamStart: () => {
              callbacks.onPhaseChange?.('working', { reason: 'waiting for first token' })
            },
            onError: callbacks.onError,
            onRateLimit: (retryDelayMs) => {
              rateLimitOccurred = true
              rateLimitRetryMs = retryDelayMs ?? 0
            },
          },
        })

        // Stream phase: disarm only the hard-stall abort, keep informational
        // heartbeats alive. A long pre-first-token gap (cold prefix re-encode on
        // a large context — the d53172f8 stall, where round 33's cache went to
        // 0% and the next request silently re-encoded) would otherwise run out
        // the 240s hard-stall clock and falsely abort a healthy in-flight
        // request. Disarm (not pause) survives the onStreamStart phase change —
        // which would re-arm a paused timer via tick() — and still lets the UI
        // show "still working — waiting for first token (Ns)". The provider/SSE
        // idle + thinking-stall timeouts are the authoritative guard for genuine
        // in-stream hangs; the finally re-arms the watchdog for the next
        // turn-boundary blind spot regardless of outcome.
        const streamHeartbeat = this.deps.getHeartbeat()
        streamHeartbeat?.disarmWatchdog()
        let streamResult: Awaited<ReturnType<typeof streamOnce>>
        try {
          streamResult = await streamOnce()

          // 2D（默认关）：客户端重试耗尽后，agent 层有界重连。仅当本轮 streamError 被
          // classifyApiError 判为 shouldReconnect、非 AbortError、且未 abort 时触发。
          // 守护 prefix cache：丢弃本轮 partial blocks（不入 session）与已累计 streamedText，
          // 用**相同 request**（消息历史不变）重发，prefix 命中不受污染。
          const reconnectCfg = this.deps.getAgentReconnect()
          const abortSignal = this.deps.getAbortSignal()
          if (reconnectCfg?.enabled && abortSignal) {
            const maxAttempts = Math.max(0, reconnectCfg.maxAttempts ?? 1)
            const backoffMs = reconnectCfg.backoffMs ?? 500
            let attempt = 0
            while (
              attempt < maxAttempts &&
              streamResult.streamError !== null &&
              (streamResult.streamError as Error).name !== 'AbortError' &&
              !abortSignal.aborted &&
              classifyApiError(streamResult.streamError).shouldReconnect
            ) {
              attempt++
              this.deps.state.streamedText = ''
              turnTextAccum = ''
              turnThinkingAccum = ''
              pendingFlush = ''
              turnDedupState = 'tracking'
              rateLimitOccurred = false
              rateLimitRetryMs = 0
              callbacks.onPhaseChange?.('working', { reason: `reconnecting (${attempt}/${maxAttempts})` })
              try {
                await abortableDelay(backoffMs, abortSignal)
              } catch {
                break // aborted during backoff
              }
              streamResult = await streamOnce()
            }
          }
        } finally {
          streamHeartbeat?.rearmWatchdog()

        // Tick after stream settles: the last text/tool delta may have been
        // tens of seconds ago (thinking phase, tool-call serialization). Reset
        // the silence clock now so the downstream tool-execution / no-tool
        // boundary steps start from a fresh baseline, not from mid-stream.
        this.deps.getHeartbeat()?.tick('stream-done')
        }

        // Only decide full-turn suppression at the stream boundary. A mid-stream exact
        // fingerprint match is not final; later deltas may add new content.
        if (turnDedupState === 'tracking' && pendingFlush) {
          const fp = turnTextAccum.replace(/\s+/g, ' ').trim()
          if (fp !== prevFingerprint) {
            callbacks.onTextDelta(pendingFlush)
          }
        }
        const { collectedBlocks, thinkingAccum, toolUses, stopReason, streamError } = streamResult
        this.deps.state.lastTurnTextFingerprint = streamResult.lastTurnTextFingerprint
        this.deps.state.lastTurnThinkingFingerprint = streamResult.lastTurnThinkingFingerprint
        // Track text fingerprints for cross-turn repetition detection
        if (streamResult.lastTurnTextFingerprint.length >= 50) {
          const fps = this.deps.state.recentTextFingerprints
          fps.push(streamResult.lastTurnTextFingerprint)
          if (fps.length > 8) fps.shift()
        }
        // Anti-habituation: detect model-initiated objections to reset staleness counter.
        if (turnTextAccum.includes('⚠') || turnTextAccum.includes('风险评估') || turnTextAccum.includes('遗留项')) {
          this.deps.state.turnsSinceLastObjection = 0
        }

        // TTSR: stream rule triggered — inject reminder and retry, governed
        // by a per-run retry cap so a self-matching task can't loop forever.
        if (streamResult.triggeredRule) {
          const rule = streamResult.triggeredRule
          const count = (ruleTriggerCounts.get(rule.pattern) ?? 0) + 1
          ruleTriggerCounts.set(rule.pattern, count)

          if (count > MAX_RULE_RETRIES) {
            // Cap exceeded: disable this rule for the rest of the run and let
            // the turn proceed normally (the bash tool's own exec-time guard
            // remains as defense-in-depth). Re-enter the loop without injecting.
            disabledRulePatterns.add(rule.pattern)
            debugLog(`[ttsr] rule disabled after ${count - 1} retries: ${rule.pattern}`)
            continue
          }

          // Wrap as a system reminder (not a bare user message) so it is not
          // rendered as a user bubble, and dedup identical consecutive injects.
          // Kept as a trailing user-role append: the expensive cache prefix
          // (tools/system/first-user-message) sits at the head and is never
          // touched, so prompt-cache reuse is preserved across the retry.
          const reminder = `<system-reminder>\n${rule.inject}\n</system-reminder>`
          if (reminder !== lastInjectedReminder) {
            this.deps.addUserMessage(reminder)
            lastInjectedReminder = reminder
          }
          // Flush streamed text so the next stream doesn't append on top of
          // existing TUI streamBuf content.
          callbacks.onTurnComplete(this.deps.getTotalUsage(), this.deps.getTurnCount(), false)
          continue
        }

        // Rate-aware backpressure: if the API layer signaled a 429 retry,
        // add an inter-turn delay to avoid hitting the rate limit again
        // before the provider's rate window resets.
        if (rateLimitOccurred) {
          // Use server-provided retry delay when available, otherwise fall back to 2s
          const delayMs = rateLimitRetryMs > 0 ? rateLimitRetryMs : 2000
          // abort-race：429 回退期间 Esc 须立即解锁（abortableDelay 会清定时器并抛 AbortError）
          await abortableDelay(delayMs, signal!)
        }

        // L0 telemetry: stream duration
        const streamEndMs = Date.now()
        if (toolUses.length > 0) {
          this.deps.writeTelemetry({
            kind: 'stream-complete',
            ts: streamEndMs,
            turn,
            phase: 'stream-complete',
            streamDurationMs: streamEndMs - turnStartMs,
            toolCount: toolUses.length,
            toolNames: toolUses.map(tu => tu.name).join(','),
          })
        }

        // Feed CacheAdvisor with turn metrics after API call completes
        // Cache read/creation metrics are captured here; artifact eviction/access
        // metrics are added after tool execution (see below).
        const cacheHistory = this.deps.getCacheHistory()
        const latestTurnCache = cacheHistory.length > 0 ? cacheHistory[cacheHistory.length - 1] : null

        if (signal?.aborted) {
          // P0: skip addAssistantBlocks — partial blocks from an aborted
          // stream must not pollute the message list and break prefix cache.
          if (this.deps.state.streamedText.length > 0) this.deps.addUsage({ output_tokens: Math.ceil(this.deps.state.streamedText.length / 4) })
          if (!assistantResponded && !userMessageConsumed) this.deps.removeLastMessage()
          // runPostSession is best-effort cleanup — its failure must not cause
          // the outer catch to double-delete an unrelated message.
          try { await this.deps.runPostSession(callbacks) } catch { /* best-effort */ }
          callbacks.onAbort(this.deps.getAbortReason())
          return
        }

        if (streamError) {
          // Abort is a user action, not a provider fault — don't cool the provider.
          if ((streamError as Error).name !== 'AbortError') this.deps.recordProviderOutcome(false)
          if (collectedBlocks.length > 0 && (streamError as Error).name !== 'AbortError') { this.deps.addAssistantBlocks(collectedBlocks); assistantResponded = true }
          if (!assistantResponded && !userMessageConsumed) this.deps.removeLastMessage()
          callbacks.onError(streamError)
          return
        }

        this.deps.recordProviderOutcome(true)

        // Contract repair: text shown to the user MUST be persisted. If the
        // client streamed text only via onTextDelta and never emitted a text
        // content block, synthesize one from the accumulated streamedText.
        // Otherwise the reply is visible in the TUI but absent from history,
        // and the model re-answers this turn's question on the next run.
        if (this.deps.state.streamedText && !collectedBlocks.some(b => b.type === 'text')) {
          collectedBlocks.push({ type: 'text', text: this.deps.state.streamedText })
        }

        if (collectedBlocks.length > 0) { this.deps.addAssistantBlocks(collectedBlocks); assistantResponded = true }

        // max_output_tokens on text-only turns: accept partial output instead of
        // escalating. The model rarely continues coherently — it usually restarts
        // from scratch, causing a confusing "cut off → restart" loop for users.
        // Previously we tried up to 3 escalations; now we just end the turn.

        if (toolUses.length > 0) {
          // Reset no-tool counter — model is taking action
          this.deps.state.consecutiveNoToolTurns = 0
          // ── B1 轮内只读调用计数（spec 三轮防御加固）──
          // 在本轮工具结果处理后刷新计数器：全只读则 +1，否则重置。
          if (turnUsedOnlyReadTools(toolUses)) {
            this.deps.state.consecutiveReadOnlyTurns = this.deps.state.consecutiveReadOnlyTurns + 1
          } else {
            this.deps.state.consecutiveReadOnlyTurns = 0
          }
          // ── Pre-execution diagnostic snapshot ──
          // Write sensorium before tool execution so freeze analysis can
          // identify which tools were about to run, even if executeBatch hangs.
          const toolNames = toolUses.map(tu => tu.name).join(',')
          this.deps.writeTelemetry({
            kind: 'tool-executing',
            ts: Date.now(),
            turn,
            phase: 'tool-executing',
            tools: toolNames,
            toolCount: toolUses.length,
          })

          // 工具批整体 abort-race：executeBatch 内部虽对单工具有 withToolTimeout，
          // 但审批/checkpoint 前置 await 与 postTool hooks 不在 timeout 覆盖内，
          // 一旦卡住，仅靠 240s 心跳看门狗才能解锁 → run() 长时间不 settle、会话假死。
          // 这里把整批与 abort 信号竞速，Esc 后立即抛 AbortError → 下方 catch 走 onAbort。
          //
          // 同时 disarm 看门狗的 hardStall abort：工具执行期间（bash 编译/测试
          // 可能超 120s），onToolUse→onToolResult 之间无 tick，看门狗会将正常耗时
          // 误判为楔死。保留 informational heartbeat（UI 仍显示"still working"），
          // 仅挂起 hardStall 熔断；工具完成后 rearm。工具级 timeout + rejectOnAbort
          // 提供真正的 hang 保护。
          const toolHeartbeat = this.deps.getHeartbeat()
          toolHeartbeat?.disarmWatchdog()
          let r: Awaited<ReturnType<typeof this.deps.executeBatch>>
          // Keep a handle on the batch itself: rejectOnAbort races it against the
          // abort signal and stops AWAITING on Esc, but the batch keeps running and
          // commits its tool results (addToolResults) later. We must drain that
          // commit in-order on abort — see TOOL_ABORT_DRAIN_MS.
          const batchPromise = this.deps.executeBatch({
            toolUses, callbacks, turn, checkpointCreatedThisTurn,
            abortSignal: signal!,
            traceStore: this.deps.state.traceStore, importGraph: this.deps.state.importGraph,
            lastConflictCheckCount: this.deps.state.lastConflictCheckCount, latestRisk: this.deps.state.latestRisk,
          })
          // Tier 2 LLM speculation: ride the batch await window with a
          // shared-prefix prediction call. Fire-and-forget; never awaited here.
          this.deps.speculateDuringBatch?.({ request, toolUses, turn, signal })
          try {
            r = await rejectOnAbort(batchPromise, signal!, 'tools')
          this.deps.state.traceStore = r.traceStore
          this.deps.state.importGraph = r.importGraph
          this.deps.state.lastConflictCheckCount = r.lastConflictCheckCount
          this.deps.state.latestRisk = r.latestRisk
          if (r.checkpointCreated) checkpointCreatedThisTurn = true

          // U6: record this tool-turn into the execution trace.
          this.deps.appendTurnResult(turn)

          // L0 telemetry: tools duration
          this.deps.writeTelemetry({
            kind: 'tools-complete',
            ts: Date.now(),
            turn,
            phase: "tools-complete",
            toolsDurationMs: Date.now() - streamEndMs,
            totalTurnMs: Date.now() - turnStartMs,
            toolCount: toolUses.length,
          })

          // Feed CacheAdvisor with cache metrics + artifact eviction/access data
          if (latestTurnCache && latestTurnCache.turn === turn) {
            this.deps.onCacheAdvisorTurnEnd({
              turn,
              cacheRead: latestTurnCache.cacheRead,
              cacheCreation: latestTurnCache.cacheCreation,
              prefixChanged: latestTurnCache.cacheRead === 0 && turn > 1,
              artifactIdsEvicted: r.artifactIdsEvicted,
              artifactIdsAccessed: r.artifactIdsAccessed,
            })
          }
          this.deps.flushMeridianTurn()

          // endTurn signal: a tool (e.g. ask_user_question) requested turn termination.
          // Complete as final and break instead of continuing the tool loop.
          if (r.endTurn) {
            this.emitStop({ source: 'end-turn', turn, voluntary: true }, callbacks)
            await rejectOnAbort(
              this.deps.completeTurn({ turn, isFinal: true, callbacks }),
              signal!,
              'post-turn-endTurn',
            )
            finalTurnCompleted = true
            break
          }

          // Wedged-loop guard: a model that re-emits the SAME tool batch and gets
          // an all-error result every time (the classic "requires user approval"
          // denial loop — see the boundary-stall screenshot) would otherwise spin
          // to maxTurns, ballooning context until the sidecar OOMs. Detect an
          // identical, fully-errored batch repeating and end the run instead.
          const allErrored = r.toolCount > 0 && r.errorCount === r.toolCount
          const batchFingerprint = allErrored ? toolBatchFingerprint(toolUses) : ''
          if (allErrored && batchFingerprint === this.deps.state.wedgeToolFingerprint) {
            this.deps.state.wedgeRepeatCount = this.deps.state.wedgeRepeatCount + 1
          } else {
            this.deps.state.wedgeRepeatCount = allErrored ? 1 : 0
            this.deps.state.wedgeToolFingerprint = batchFingerprint
          }
          if (this.deps.state.wedgeRepeatCount >= MAX_WEDGE_REPEATS) {
            this.emitStop({
              source: 'wedged-loop',
              turn,
              voluntary: false,
              detail: `${toolUses.map(tu => tu.name).join(',')} ×${this.deps.state.wedgeRepeatCount}`,
            }, callbacks)
            await rejectOnAbort(
              this.deps.completeTurn({ turn, isFinal: true, callbacks }),
              signal!,
              'post-turn-wedged',
            )
            finalTurnCompleted = true
            break
          }

          // ── Action-intent readonly gate（spec 2026-07-05）──
          // 模型一边用只读工具（grep/read_file）维持"在做事"的表象、一边在
          // 文本里承诺写操作（"更新计划""重写…"）时，no-tool 闸门因本轮
          // 有工具调用而够不着。只读轮 + 写侧承诺 → 注入一次性提醒
          //（与 no-tool 闸门共享 actionIntentFiredThisRun 配额，nudge 不阻断）。
          //
          // 2026-07-07 核销接入：改走 advisory bus 的 system-reminder 通道
          //（同一注入面，时序等价——下个请求构建时 drain 进消息流），换来
          // expect 谓词核销：送达后 2 轮内出现写类/验证类工具调用 = 采纳。
          // 会话 519216c0 复盘显示该提醒实际有效（模型下一轮就补了写入）但
          // 因直注不计账，效能账本记 0 采纳——低采纳数据会误导后续降频决策。
          if (!actionIntentFiredThisRun
              && hasWriteActionIntent(this.deps.state.streamedText)
              && turnUsedOnlyReadTools(toolUses)) {
            actionIntentFiredThisRun = true
            const content = '上一轮你在文本里宣布了写入/修改/测试类操作，但只调用了只读工具（grep/read_file 等），写操作并未发生。如果仍需执行，请在本轮直接发起对应的工具调用；如果已不需要，请明确说明。'
            if (this.deps.submitAdvisory) {
              this.deps.submitAdvisory({
                key: 'action-intent',
                priority: 0.62,
                category: 'discipline',
                content,
                channel: 'system-reminder',
                immediate: true,
                expect: {
                  kind: 'tool_appears',
                  tools: ['write_file', 'edit_file', 'hash_edit', 'apply_patch', 'run_tests', 'todo'],
                  withinTurns: 2,
                },
              })
            } else {
              this.deps.appendSystemReminder(`<system-reminder>${content}</system-reminder>`)
            }
          }

          // ── B1 连续只读螺旋提醒（spec 三轮防御加固）──
          // 连续 4+ 轮全只读工具且没有写侧承诺 → 模型陷入无声读取螺旋。
          // 此时 action-intent gate 不触发（未声明写入），但信息已足够——
          // 注入一次性提醒推动模型行动。
          if (this.deps.state.consecutiveReadOnlyTurns >= 4) {
            const n = this.deps.state.consecutiveReadOnlyTurns
            this.deps.state.consecutiveReadOnlyTurns = 0 // 一次性，不重复提醒
            const content = `本轮已连续 ${n} 次只读操作（read_file/grep/glob 等），信息可能已足够 — 请基于已有理解开始行动（编辑、测试、或输出结论），不需要继续读取更多文件。`
            if (this.deps.submitAdvisory) {
              this.deps.submitAdvisory({
                key: 'readonly-spiral',
                priority: 0.65,
                category: 'discipline',
                content,
                channel: 'system-reminder',
                immediate: true,
                expect: {
                  kind: 'tool_appears',
                  tools: ['write_file', 'edit_file', 'hash_edit', 'apply_patch', 'run_tests', 'bash', 'deliver_task'],
                  withinTurns: 2,
                },
              })
            } else {
              this.deps.appendSystemReminder(`<system-reminder>${content}</system-reminder>`)
            }
          }

          // ── B2 轮内调用上限提醒（spec 三轮防御加固）──
          // 轮内 API 调用超过 12 次 → 模型发散，注入一次性强提醒。
          // 不强制截断（避免打断合法大批量编辑），仅收敛建议。
          if (!turnCallLimitAdvisoryFired && turn >= 12) {
            turnCallLimitAdvisoryFired = true
            // W3 诊断态分流（incident 20b9714e）：对排查会话催"输出结论"会在
            // 证据不足时直接诱发脑补——改为要求先核实将写进结论的断言。
            const diagnostic = this.deps.getActivityMode?.() === 'diagnostic'
            const content = diagnostic
              ? '本轮已进行 12+ 次 API 调用。先用工具核实你将要写进结论的关键断言（ls/grep/read 实际文件），核实完再收束；没有工具证据的推断必须标注"未核实"。会话自身状态可用 session_vitals 取证。'
              : '本轮已进行 12+ 次 API 调用，请收敛当前动作并输出结论，不要继续发散。'
            if (this.deps.submitAdvisory) {
              this.deps.submitAdvisory({
                key: 'turn-call-limit',
                priority: 0.68,
                category: 'discipline',
                content,
                channel: 'system-reminder',
                immediate: true,
                // 诊断态可核销：采纳签名 = 后续轮出现认知型工具调用（去核实）。
                expect: diagnostic
                  ? { kind: 'tool_appears', tools: ['read_file', 'grep', 'glob', 'list_dir', 'bash'], withinTurns: 2 }
                  : undefined,
              })
            } else {
              this.deps.appendSystemReminder(`<system-reminder>${content}</system-reminder>`)
            }
          }

          // ── Post-tool delivery gate ──
          // After every tool turn the default was to unconditionally continue.
          // But for read-only tasks (reviews, research, code inspection) the
          // model may have gathered enough information and delivered results
          // — forcing another turn costs 7-8K cacheCreate for no reason.
          // Check: if the streamed text looks like a natural delivery AND
          // the tools this turn were all read-only, stop auto-continuing and
          // fall through to the no-tool path for natural finish.
          const looksDelivered =
            this.deps.state.streamedText.length > 0 &&
            DELIVERY_SIGNAL_RE.test(this.deps.state.streamedText) &&
            !hasActionIntent(this.deps.state.streamedText) &&
            turnUsedOnlyReadTools(toolUses)
          if (looksDelivered) {
            // Don't archive as isFinal yet — the no-tool path below will handle
            // natural finish. Just break out of the post-tool continue.
            callbacks.onTurnComplete(this.deps.getTotalUsage(), this.deps.getTurnCount(), false)
            continue
          }

          await rejectOnAbort(
            this.deps.completeTurn({ turn, isFinal: false, callbacks }),
            signal!,
            'post-turn',
          )
          continue
          } catch (err) {
            // Esc or unexpected error during tool execution: rejectOnAbort
            // abandoned the await to keep the UI responsive, but `batchPromise`
            // is still running and will call addToolResults() at an uncontrolled
            // later time. Drain it (bounded) so its result commit lands in-order
            // NOW — before this turn tears down and any new user message starts
            // a fresh run that would push the late tool result out of position.
            // Without this the next request breaks with "insufficient tool
            // messages following tool_calls" (only /rewind fixed it).
            // ALL error types must drain: non-AbortError exceptions (e.g.
            // TypeError from a tool bug) also leave orphan tool_use entries
            // if the batch completes after we throw.
            await Promise.race([
              batchPromise.then(() => {}, () => {}),
              new Promise<void>((resolve) => setTimeout(resolve, TOOL_ABORT_DRAIN_MS)),
            ])
            throw err
          } finally {
            toolHeartbeat?.rearmWatchdog()
          }
        }

        // Thinking-only turn detection: retry if model produced reasoning but no text/tools
        // Feed CacheAdvisor for non-tool turns (no evictions/accesses)
        if (latestTurnCache && latestTurnCache.turn === turn) {
          this.deps.onCacheAdvisorTurnEnd({
            turn,
            cacheRead: latestTurnCache.cacheRead,
            cacheCreation: latestTurnCache.cacheCreation,
            prefixChanged: latestTurnCache.cacheRead === 0 && turn > 1,
            artifactIdsEvicted: [],
            artifactIdsAccessed: [],
          })
        }
        // Count only actionable blocks (text/tool_use) — thinking-only blocks
        // don't count as "the model produced output". Without this filter, a
        // response with only reasoning_content (no content/tool_calls) sets
        // collectedBlockCount=1, evaluateThinkingRetry short-circuits to
        // shouldRetry=false, and the loop silently ends as natural-finish.
        const actionableBlockCount = collectedBlocks.filter(b => b.type !== 'thinking').length
        const thinkingResult = await this.deps.postTurnDecision.evaluateThinkingRetry({
          collectedBlockCount: actionableBlockCount,
          thinkingAccum,
          turn,
          callbacks,
          signal: signal!,
        })
        if (thinkingResult.shouldRetry) continue

        // No tool calls this turn — increment the counter for convergence detection
        this.deps.state.consecutiveNoToolTurns = this.deps.state.consecutiveNoToolTurns + 1

        // ── User steer takes precedence over any auto-continuation ──
        // Steer normally drains only at tool-result boundaries, so a no-tool
        // continuation chain (goal) starves queued user guidance while
        // injecting its own "keep going" reminder — the user feels unheard.
        // Drain here FIRST: if the user said something, hand the next turn to
        // their words alone and skip this round's continuation reminders.
        const steerText = callbacks.onSteerDrain?.()
        if (steerText) {
          debugLog(`[steer-preempt] turn=${turn} user guidance preempted auto-continuation`)
          await rejectOnAbort(
            this.deps.completeTurn({ turn, isFinal: false, callbacks }),
            signal!,
            'steer-preempt-complete',
          )
          this.deps.appendSystemReminder(steerText)
          continue
        }

        // ── Goal continuation check ──
        // Delegated to GoalContinuationController — it handles tracker.check,
        // judge gating, saveGoalState, flushMeridianTurn, completeTurn, and
        // continuation reminder injection internally. Wrapped in rejectOnAbort
        // so a watchdog abort during judgeGoalCompletion (LLM call) immediately
        // races instead of waiting for the next loop-iteration signal check.
        const goalCheckResult = await rejectOnAbort(
          this.deps.goalContinuation.handleGoalCheck({
            streamedText: this.deps.state.streamedText,
            estimatedTokens: this.deps.getEstimatedTokens(),
            isAborted: signal?.aborted === true,
            turn,
            callbacks,
            signal: signal!,
          }),
          signal!,
          'goal-check',
        )
        if (goalCheckResult.kind === 'continue') continue

        // ── Action-intent gate ──
        // Lightweight check: the model announced an action ("let me grep…",
        // "接下来修改…") but issued no tool call on this no-tool turn.
        // Inject a system-reminder so the NEXT turn can self-correct —
        // no auto-continue, just a one-shot nudge per run.
        // Cooldown: skip if last nudge was within ACTION_INTENT_COOLDOWN_MS
        // (frequent chat sessions shouldn't get the same reminder every run).
        const now = Date.now()
        if (
          !actionIntentFiredThisRun &&
          now - this.lastActionIntentNudgeTime >= ACTION_INTENT_COOLDOWN_MS &&
          hasActionIntent(this.deps.state.streamedText)
        ) {
          actionIntentFiredThisRun = true
          this.lastActionIntentNudgeTime = now
          this.deps.appendSystemReminder(
            '<system-reminder>上一轮你以"我将做…""接下来…"结尾但未发出对应的工具调用。如果还需要执行，请在本轮直接发起工具调用。</system-reminder>'
          )
          await rejectOnAbort(
            this.deps.completeTurn({ turn, isFinal: false, callbacks }),
            signal!,
            'action-intent-gate-complete',
          )
          continue
        }

        // Final completion: goal inactive / achieved / budget exhausted / context limit.
        // Voluntary finish — the model produced a final answer with no tool call
        // and goal continuation didn't ask to keep going.
        this.emitStop({ source: 'natural-finish', turn, voluntary: true }, callbacks)
        await rejectOnAbort(
          this.deps.completeTurn({
            turn,
            isFinal: true,
            callbacks,
          }),
          signal!,
          'final-complete',
        )
        finalTurnCompleted = true
        this.deps.resetEvidence()
        break
      }

      // maxTurns exhausted mid-task (every turn used tools / retried): still
      // emit a final completion so the TUI state machine resets (agentBusy /
      // isStreaming) and the next user message starts a fresh run instead of
      // silently landing in the steer buffer.
      if (!finalTurnCompleted) {
        // maxTurns is a GUARD-forced stop, not a voluntary finish — surface it
        // as such so a task cut off mid-work is distinguishable from a model
        // that wrapped up on its own. (The onTurnComplete below still resets the
        // TUI state machine.)
        this.emitStop({
          source: 'max-turns',
          turn: this.deps.getMaxTurns(),
          voluntary: false,
          detail: 'exhausted without a final turn',
        }, callbacks)
        callbacks.onTurnComplete(this.deps.getTotalUsage(), this.deps.getTurnCount(), true)
      }
    } catch (err) {
      this.deps.resetEvidence()
      if (!assistantResponded && !userMessageConsumed) this.deps.removeLastMessage()
      if ((err as Error).name === 'AbortError') {
        // 停止原因落盘（不走 onPhaseChange——onAbort 已负责 UI 渲染，避免双条）。
        // watchdog 触发的 abort 与用户 Esc 用 abortReason tag 区分。
        const abortTag = this.deps.getAbortReason()
        this.recordStop({
          source: abortTag?.includes('watchdog') ? 'watchdog-stall' : 'user-interrupt',
          turn: this.deps.state.runLoopTurn,
          voluntary: false,
          ...(abortTag !== undefined && { detail: abortTag }),
        })
        await this.deps.runPostSession(callbacks)
        callbacks.onAbort(abortTag)
      } else {
        this.recordStop({
          source: 'stream-error',
          turn: this.deps.state.runLoopTurn,
          voluntary: false,
          detail: String((err as Error).message ?? err).slice(0, 200),
        })
        callbacks.onError(err as Error)
      }
    } finally {
      heartbeat.stop()
      this.deps.stopFsWatcher()
    }
  }
}
