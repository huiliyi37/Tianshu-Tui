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
import { debugLog } from '../utils/debug.js'

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
}

export interface CompleteTurnParams {
  turn: number
  isFinal: boolean
  emitBadge?: boolean
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
  autoContinueCount: number
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
    action: 'proceed' | 'veto' | 'abort'
    request?: import('../api/oai-types.js').OaiChatRequest
  }>
  prewarmRecentReads: () => Promise<void>
  runPostSession: (callbacks: AgentCallbacks) => Promise<void>
  recordProviderOutcome: (ok: boolean) => void

  // === Sub-controllers ===
  streamTurn: (params: StreamTurnParams) => Promise<StreamTurnResult>
  executeBatch: (params: ExecuteBatchParams) => Promise<ExecuteBatchResult>
  completeTurn: (params: CompleteTurnParams) => Promise<void>
  appendTurnResult: (turn: number) => void
  onCacheAdvisorTurnEnd: (params: CacheTurnEndParams) => void

  // === Telemetry ===
  writeTelemetry: (entry: TelemetryRecord) => void
  resetEvidence: () => void

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
  getMaxAutoContinue: () => number
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
    onTurnComplete: (usage, turnNumber, isFinal) => {
      hb.tick(`turn ${turnNumber} complete`)
      cb.onTurnComplete(usage, turnNumber, isFinal)
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

export class TurnOrchestrator {
  constructor(private deps: TurnOrchestratorDeps) {}

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

    try {
      for (let turn = 0; turn < this.deps.getMaxTurns(); turn++) {
        this.deps.state.thetaRequestsThisTurn = 0
        // Sync plan-mode state into config so tool-pipeline gate reads it
        this.deps.syncPlanModeToConfig()
        const signal = this.deps.getAbortSignal()
        if (signal?.aborted) {
          if (!assistantResponded && !userMessageConsumed) this.deps.removeLastMessage()
          callbacks.onAbort(this.deps.getAbortReason())
          return
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
          const { action } = await rejectOnAbort(
            this.deps.runConvergenceCheck(turn, phaseClass, assistantResponded, userMessageConsumed, callbacks),
            signal!,
            'convergence',
          )
          if (action === 'abort') return
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
        if (turnRequest.action === 'veto') continue
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
          const r = await rejectOnAbort(
            this.deps.executeBatch({
              toolUses, callbacks, turn, checkpointCreatedThisTurn,
              abortSignal: signal!,
              traceStore: this.deps.state.traceStore, importGraph: this.deps.state.importGraph,
              lastConflictCheckCount: this.deps.state.lastConflictCheckCount, latestRisk: this.deps.state.latestRisk,
            }),
            signal!,
            'tools',
          )
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
            await rejectOnAbort(
              this.deps.completeTurn({ turn, isFinal: true, emitBadge: true, callbacks }),
              signal!,
              'post-turn-endTurn',
            )
            finalTurnCompleted = true
            break
          }

          await rejectOnAbort(
            this.deps.completeTurn({ turn, isFinal: false, callbacks }),
            signal!,
            'post-turn',
          )
          continue
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
        const thinkingResult = await this.deps.postTurnDecision.evaluateThinkingRetry({
          collectedBlockCount: collectedBlocks.length,
          thinkingAccum,
          turn,
          callbacks,
          signal: signal!,
        })
        if (thinkingResult.shouldRetry) continue

        // No tool calls this turn — increment the counter for convergence detection
        this.deps.state.consecutiveNoToolTurns = this.deps.state.consecutiveNoToolTurns + 1

        // ── Goal continuation check ──
        // Delegated to GoalContinuationController — it handles tracker.check,
        // judge gating, saveGoalState, flushMeridianTurn, completeTurn, and
        // continuation reminder injection internally.
        const goalCheckResult = await this.deps.goalContinuation.handleGoalCheck({
          streamedText: this.deps.state.streamedText,
          estimatedTokens: this.deps.getEstimatedTokens(),
          isAborted: signal?.aborted === true,
          turn,
          callbacks,
          signal: signal!,
        })
        if (goalCheckResult.kind === 'continue') continue

        // ── Phantom continuation check ──
        // Only reached when goal check returned accept/finalize (goal not continuing).
        const phantomResult = await this.deps.postTurnDecision.evaluatePhantomContinuation({
          turn,
          callbacks,
          signal: signal!,
        })
        if (phantomResult.shouldContinue) continue

        // Final completion: goal inactive / achieved / budget exhausted / context limit.
        await rejectOnAbort(
          this.deps.completeTurn({
            turn,
            isFinal: true,
            emitBadge: true,
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
        debugLog(`[agent] maxTurns=${this.deps.getMaxTurns()} exhausted without a final turn — emitting final onTurnComplete`)
        callbacks.onTurnComplete(this.deps.getTotalUsage(), this.deps.getTurnCount(), true)
      }
    } catch (err) {
      this.deps.resetEvidence()
      if (!assistantResponded && !userMessageConsumed) this.deps.removeLastMessage()
      if ((err as Error).name === 'AbortError') {
        await this.deps.runPostSession(callbacks)
        callbacks.onAbort(this.deps.getAbortReason())
      } else {
        callbacks.onError(err as Error)
      }
    } finally {
      heartbeat.stop()
      this.deps.stopFsWatcher()
    }
  }
}
