import type { AgentLoop } from './loop.js'
import type { AgentCallbacks } from './loop-types.js'
import type { OaiChatRequest } from '../api/oai-types.js'
import type { Sensorium, StrategyProfile } from './sensorium.js'
import { TurnHeartbeat } from './turn-heartbeat.js'
import { wrapCallbacksWithHeartbeat } from './turn-orchestrator.js'
import { debugLog } from '../utils/debug.js'
import { createTraceStore } from './trace-store.js'
import { createPredictionAccumulator, computeEFE } from './prediction-error.js'
import { RepairHintTracker } from './repair-hint.js'
import { createThetaState, getThetaPhase } from './star-event.js'
import { mapQueriedPheromones } from './pheromone-map.js'
import { getGitInjectedContext } from '../prompt/volatile-git.js'
import { detectWorktreeReality, type InjectedWorktreeContext } from './worktree-reality.js'
import { advanceContractStatus, classifyPlanMethodology, classifyTaskDepth, classifyTurnMode, contractStatusFromPhaseClass, extractTaskContract, type TurnMode } from '../context/task-contract.js'
import { skillRegistry } from '../skills/skill-loader.js'
import { renderMemoryBlock } from '../memory/unified-memory.js'
import { parseMentions, renderMentionContext } from '../tui/mention-parser.js'
import { renderPlanCacheAdvisory } from './plan-cache-advisory.js'
import { selectReasoningEffort } from './auto-reasoning.js'
import { SessionPersist } from './session-persist.js'
import { formatEventsForAppendix, renderCrossSessionClaims } from './hooks/cross-session-hook.js'
import { loadPresence, formatPresenceForAppendix } from './companion-presence.js'
// staleness/vigor-low advisory entries migrated to CCR hook (cognitive-capsule-router.ts)
import { classifySeason } from './cognitive-season.js'
import { renderToolContext, type AffordanceState, adaptAffordanceFromHistory, computeAffordanceScores } from './affordance.js'
import { selectPolicy } from './policy-selection.js'
import { checkTddGate } from './tdd-gate.js'
import { buildCognitivePromptProjection, createCognitiveLedger, getCognitivePhaseSnapshot } from '../context/cognitive-ledger.js'
import { formatImmuneContext } from './immune-context.js'

/**
 * Cross-session loading check — prefers config over env var.
 *
 * - Env RIVET_NO_CROSS_SESSION=1/true → force-off (disabled=true)
 * - Env RIVET_NO_CROSS_SESSION=0/false → force-on (disabled=false)
 * - No env → uses config.crossSessionEnabled (default true = enabled = NOT disabled)
 * - No config and no env → disabled (backward compat for callers without config)
 */
export function crossSessionDisabled(configEnabled?: boolean): boolean {
  const v = process.env.RIVET_NO_CROSS_SESSION
  if (v === '1' || v === 'true') return true
  if (v === '0' || v === 'false') return false
  if (configEnabled !== undefined) return !configEnabled
  return true
}

/** Map StarPhase values to PromptEngine phaseClass strings. */
const PHASE_CLASS_MAP: Record<string, string> = {
  'tianshu-planning': 'plan',
  'tianxuan-locating': 'explore',
  'tianji-decomposing': 'plan',
  'tianquan-contracting': 'plan',
  'yuheng-implementing': 'execute',
  'kaiyang-testing': 'verify',
  'yaoguang-delivering': 'deliver',
  'tianshu-encore': 'plan',
}

/**
 * Turn-step producer (loop.ts terminal-wave extraction): the prompt-assembly
 * production path lifted verbatim from AgentLoop — per-run initialization,
 * per-turn perception + cognitive prep, and the OAI request build.
 *
 * Self-passing controller (import type only — no runtime cycle): every field
 * access stays `this.self.X` so the dense prefix-cache setter call sites move
 * byte-for-byte. The setter ordering relative to `buildOaiRequest` and the
 * user-message boundary is a hard constraint (DeepSeek exact-prefix cache):
 * do NOT reorder the setter / refreshGitContextIfNeeded / buildOaiRequest calls.
 */
export class TurnStepProducer {
  constructor(private readonly self: AgentLoop) {}

  /**
   * Step 6a: Per-run initialization — warmup, heartbeat, state resets,
   * worktree detection, session split, user message, task contract.
   *
   * Returns the heartbeat (for cleanup) and the wrapped callbacks (which
   * the caller must use for the rest of the run).
   */
  async initializeRun(userInput: string, callbacks: AgentCallbacks, images?: string[]): Promise<{ heartbeat: TurnHeartbeat, wrappedCallbacks: AgentCallbacks, actionable: boolean, turnMode: TurnMode }> {
    await this.self.warmupMemories()
    // The controller is created eagerly in run() before any await, so an abort
    // fired during warmup is honored (not discarded). Only create one here if a
    // caller invoked the loop outside run().
    this.self.abortController ??= new AbortController()
    if (this.self._pendingAbort) {
      // Interrupt arrived during the warmup window — keep the count and ensure
      // the (already-aborted) controller stays aborted so the turn loop bails.
      this.self.abortController.abort()
    } else {
      this.self._turnInterruptCount = 0
    }
    await this.self.startFsWatcher()
    // P7: heartbeat watchdog — surfaces "still working" signal during long
    // silent operations so the UI doesn't appear frozen and users don't
    // interrupt the agent mid-task. ALSO acts as a watchdog with teeth: if
    // silence exceeds hardStallMs (turn-boundary blind spot — postTurn hooks /
    // compaction / prewarm hang with no abort cooperation), it aborts the turn
    // so the loop's rejectOnAbort races break out instead of freezing forever.
    const heartbeat = new TurnHeartbeat({
      silentMs: 20_000,
      repeatMs: 15_000,
      hardStallMs: 240_000,
      onHeartbeat: (elapsed, lastActivity) => {
        const seconds = Math.round(elapsed / 1000)
        callbacks.onPhaseChange?.('heartbeat', {
          reason: `still working — last activity: ${lastActivity} (${seconds}s ago)`,
        })
      },
      onHardStall: (elapsed, lastActivity) => {
        const seconds = Math.round(elapsed / 1000)
        debugLog(`[watchdog] hard stall after ${seconds}s (last activity: ${lastActivity}) — aborting wedged turn`)
        callbacks.onPhaseChange?.('heartbeat', {
          reason: `recovering — turn stalled ${seconds}s at "${lastActivity}", aborting`,
        })
        this.self.abortStalledTurn()
      },
    })
    callbacks = wrapCallbacksWithHeartbeat(callbacks, heartbeat)
    heartbeat.start()
    this.self.turnStream = this.self.createTurnStreamController()
    this.self.turnCompletion = this.self.createTurnCompletionController(callbacks)
    this.self.trajectory.reset()
    this.self.decisions = []
    this.self.traceStore = createTraceStore()
    this.self.predictionAccumulator = createPredictionAccumulator()
    this.self.initialUserMessage = userInput
    // Reset accumulations from previous run
    this.self.thinkingOnlyRetries = 0
    this.self.lastThinkingContent = ''
    this.self.consecutiveNoToolTurns = 0
    this.self.lastTurnTextFingerprint = ''
    this.self.evidence.reset()
    this.self.repairHintTracker = new RepairHintTracker()
    this.self.contextInjection.reset()
    this.self.recentTextFingerprints = []
    this.self.sensorium = null
    this.self.strategy = null
    this.self.latestResourceSnapshot = null
    this.self.latestReliabilityDecision = null
    this.self.thetaState = createThetaState(7)
    this.self.loadedPheromones = []
    this.self.intent.reset()
    this.self.perception.reset()
    this.self.sensoriumSnapshots = this.self.perception.getSnapshots()
    this.self.latestCognitiveSnapshot = undefined
    // Capture baseline canonical prefix fingerprint for drift detection
    this.self.baselineFingerprint = this.self.config.promptEngine.getFingerprint()
    // Load cross-session pheromones for Sensorium.freshness computation.
    // Use query() so Sensorium sees decayed currentStrength, and prune stale entries opportunistically.
    this.self.stigmergyStore.prune().catch(() => {})
    this.self.stigmergyStore.query().then(p => { this.self.loadedPheromones = mapQueriedPheromones(p) }).catch(() => {})

    // Detect worktree reality: compare injected git context with actual worktree state
    try {
      const ctx = await getGitInjectedContext(this.self.cwd)
      const injected: InjectedWorktreeContext | undefined = ctx
        ? { branch: ctx.branch, head: ctx.head }
        : undefined
      const reality = await detectWorktreeReality(this.self.cwd, injected)
      this.self.config.promptEngine.setWorktreeReality(reality)
    } catch {
      // Detection failure must not crash AgentLoop — clear stale warning
      this.self.config.promptEngine.setWorktreeReality(null)
    }

    this.self.bindSessionDomain(userInput)
    this.self.contextInjection.recordUserInputClaims(userInput)
    this.self.contextInjection.refreshPlaybookLessons(userInput)
    this.self.config.promptEngine.setRecentQuery(userInput.slice(0, 300))

    // Phase 2.3: Proactive session split — MUST run BEFORE addUserMessage.
    await this.self.compactBoundaryCoordinator.preUserMessageSplit()

    // History invariant probe: a new run must start with the previous turn
    // answered. A trailing user message (or a thinking-only assistant with
    // empty content and no tool_calls) means the previous reply was never
    // persisted — the exact precondition for the "re-answers the previous
    // turn" bug. Log loudly so recurrences are diagnosable from debug logs.
    {
      const tailMsgs = this.self.session.getMessages()
      const tail = tailMsgs[tailMsgs.length - 1]
      if (tail && (
        tail.role === 'user' ||
        (tail.role === 'assistant' && !tail.content && !tail.tool_calls)
      )) {
        debugLog(`[history-invariant] run starts with unanswered tail: role=${tail.role} msgCount=${tailMsgs.length} — previous assistant reply was not persisted; model may re-answer the previous turn`)
      }
    }

    this.self.session.addUserMessage(userInput, images)
    const turnMode = classifyTurnMode(userInput, this.self.taskContract)
    const actionable = turnMode !== 'chat'
    this.self.config.promptEngine.setActionableTurn(actionable)

    if (turnMode === 'task') {
      this.self.taskContract = extractTaskContract(userInput, this.self.session.getTurnCount())
    } else if (turnMode === 'followUp') {
      // Inherit active contract — no new extraction
    } else if (!this.self.taskContract || this.self.taskContract.status === 'ready_to_deliver') {
      this.self.taskContract = undefined
    }

    await this.self.intentRoute.buildForTurn(userInput, actionable, turnMode)

    // Classify task dependency depth for TDD strategy / verifier selection
    if (this.self.taskContract && actionable) {
      const routeKinds = this.self._lastRetrievalRoute?.taskKinds
      this.self._taskDepthLayer = classifyTaskDepth(this.self.taskContract, undefined, routeKinds)
      this.self.config.promptEngine.setTaskDepthLayer(this.self._taskDepthLayer)
      this.self._planMethodology = classifyPlanMethodology(this.self.taskContract, this.self._taskDepthLayer)
      this.self.config.promptEngine.setPlanMethodology(this.self._planMethodology)
      // U6: open a fresh execution trace for a new task (or a changed contract).
      if (this.self._taskDepthLayer) {
        this.self.planTraceCoordinator.openTrace(this.self.taskContract.id, this.self._taskDepthLayer)
      }
    } else {
      this.self._taskDepthLayer = undefined
      this.self._planMethodology = undefined
      this.self.config.promptEngine.setTaskDepthLayer(undefined)
      this.self.config.promptEngine.setPlanMethodology(undefined)
      // U6: no active task — drop any prior trace + clear its prompt surfaces.
      this.self.planTraceCoordinator.closeTrace()
    }

    this.self.config.promptEngine.setSkillAdvisoryBlock(
      skillRegistry.renderDiscoveryBlock(userInput, { exclude: this.self.getDisabledSkills() }),
    )
    this.self.config.promptEngine.setCrossSessionMemoryBlock(
      crossSessionDisabled(this.self.config.crossSessionEnabled) ? null : renderMemoryBlock(this.self.cwd, userInput),
    )
    this.self.config.promptEngine.setMentionContextBlock(renderMentionContext(parseMentions(userInput)))

    this.self.config.promptEngine.setPlanCacheAdvisory(
      turnMode === 'task' ? renderPlanCacheAdvisory(this.self.p3.planCacheSuggest(userInput)) : null,
    )

    if (this.self.config.autoReasoning && turnMode === 'task') {
      const ruleEffort = selectReasoningEffort(userInput, this.self.config.reasoningFloor)
      const banditAdjusted = this.self.applyEffortDelta(ruleEffort) as import('./auto-reasoning.js').ReasoningEffort
      this.self.config.reasoningEffort = banditAdjusted
      this.self.config.client.setReasoningEffort?.(banditAdjusted)
      this.self.shadowEffortTelemetry(ruleEffort)
    }
    return { heartbeat, wrappedCallbacks: callbacks, actionable, turnMode }
  }

  /**
   * Step 6f: Build turn request — intent evaluation, repair hint injection,
   * reliability decision, context ceiling enforcement, cross-session event
   * sync, and OAI request building. Returns the action and request.
   */
  async buildTurnRequest(
    turn: number,
    currentStrategy: StrategyProfile,
    currentSensorium: Sensorium,
    pressureResult: import('../context/pressure-monitor.js').PressureResult,
    assistantResponded: boolean,
    userMessageConsumed: boolean,
    callbacks: AgentCallbacks,
  ): Promise<{
    action: 'proceed' | 'veto' | 'abort'
    request?: OaiChatRequest
  }> {
    let _tb = Date.now()
    const intentResult = await this.self.intent.evaluate({
      strategy: currentStrategy,
      vigor: this.self.vigorState,
      sensorium: currentSensorium,
      pheromones: this.self.loadedPheromones,
      pressureResult,
      recentToolHistory: this.self.recentToolHistory,
      onIntentPreview: callbacks.onIntentPreview,
    })
    debugLog(`[turn-boundary] turn=${turn} intent: ${Date.now() - _tb}ms`)
    if (intentResult === 'veto') {
      callbacks.onPhaseChange?.('intent-veto', { reason: 'user vetoed intent', suggestion: 're-plan before tool use' })
      callbacks.onTurnComplete(this.self.session.getTotalUsage(), this.self.session.getTurnCount(), false)
      return { action: 'veto' }
    }

    // Pass 5: adaptive repair hint injection
    this.self.contextInjection.refreshRepairHint()

    // Anti-habituation: staleness / vigor-low advisories are now routed by
    // CognitiveCapsuleRouter (preTurn hook) via advisory bus. Manual injection removed.

    // A1: flush advisory bus into prompt engine (unified corrective guidance)
    // Pass active star domain name for dedup — suppress entries whose 【星名】 tag
    // matches the domain already rendered in the frozen base.
    const activeStarName = this.self.sessionDomain?.name
    this.self.config.promptEngine.setHarnessAdvisoryBlock(this.self.advisoryBus.render(activeStarName))

    this.self.refreshReliabilityDecision()

    _tb = Date.now()
    await this.self.compaction.enforceContextCeiling()
    debugLog(`[turn-boundary] turn=${turn} enforceContextCeiling: ${Date.now() - _tb}ms`)
    // A2: enforceContextCeiling can trigger LLM compact (30s timeout).
    if (this.self.abortController!.signal.aborted) {
      if (!assistantResponded && !userMessageConsumed) this.self.session.removeLastMessage()
      callbacks.onAbort()
      return { action: 'abort' }
    }
    this.self.contextInjection.refreshActiveClaims()

    // Read events from other sessions (cache-safe: injected into dynamic appendix only)
    if (!crossSessionDisabled(this.self.config.crossSessionEnabled) && this.self.config.sessionRegistry && this.self.config.sessionId) {
      const events = this.self.config.sessionRegistry.consumeEvents(this.self.config.sessionId, this.self.lastSeenEventId)
      let appendix = ''
      if (events.length > 0) {
        this.self.lastSeenEventId = Math.max(...events.map(e => e.id))
        appendix = formatEventsForAppendix(events)
      }
      // P2b: inject active cross-session claims so the LLM can proactively avoid conflicts
      const claims = this.self.config.sessionRegistry.getActiveClaims(this.self.config.sessionId)
      const claimsBlock = renderCrossSessionClaims(claims)
      if (claimsBlock) {
        appendix = (appendix ? appendix + '\n' : '') + claimsBlock
      }
      if (this.self.persist) {
        const prevHandoff = SessionPersist.loadPrevHandoff(
          this.self.cwd,
          this.self.config.sessionId,
          this.self.sessionDomain?.id,
        )
        if (prevHandoff) {
          appendix = (appendix ? appendix + '\n' : '') +
            '<prev-session-handoff>\n' + prevHandoff + '\n</prev-session-handoff>'
        }
      }
      this.self.config.promptEngine.setCrossSessionEvents(appendix || null)
    }
    // Companion presence: load other live sessions for awareness
    {
      const companions = crossSessionDisabled(this.self.config.crossSessionEnabled) ? [] : loadPresence(this.self.cwd, this.self.config.sessionId)
      this.self.config.promptEngine.setCompanionPresence(
        companions.length > 0 ? formatPresenceForAppendix(companions) : null,
      )
    }
    // Inject session state snapshot into volatile block before building request
    if (this.self.sessionStateManager) {
      this.self.config.promptEngine.setSessionState(this.self.sessionStateManager.renderForVolatile())
    }
    // Pre-refresh git status so buildOaiRequest doesn't return stale cached data
    _tb = Date.now()
    await this.self.config.promptEngine.refreshGitContextIfNeeded(this.self.cwd)
    debugLog(`[turn-boundary] turn=${turn} refreshGitContext: ${Date.now() - _tb}ms`)
    const request = this.self.config.promptEngine.buildOaiRequest(
      this.self.session.getMessages(),
      this.self.recentToolHistory,
      this.self.config.contextWindow,
    )

    return { action: 'proceed', request }
  }

  /**
   * Build and inject the cognitive projection (cognitive-mirror + task-contract
   * + verification-gap + uncertainty + immune hint) into the prompt engine.
   * Reconnected after the loop-split refactor silently orphaned it.
   *
   */
  private runCognitivePrep(
    turn: number,
    actionable: boolean,
    pressureResult: import('../context/pressure-monitor.js').PressureResult,
  ): void {
    const cognitiveLedger = createCognitiveLedger({
      contract: this.self.taskContract,
      evidence: this.self.evidence.getState(),
      trace: this.self.traceStore,
      turn,
      sensorium: pressureResult.shouldThrottleCvm ? null : this.self.sensorium,
      strategy: pressureResult.shouldThrottleCvm ? null : this.self.strategy,
      vigor: pressureResult.shouldThrottleCvm ? null : this.self.vigorState,
      season: pressureResult.shouldThrottleCvm ? null : this.self.currentSeason,
      seasonIntensity: pressureResult.shouldThrottleCvm ? undefined : (this.self.currentSeasonIntensity ?? undefined),
      riskLevel: this.self.latestRisk.level,
    })
    this.self.latestCognitiveSnapshot = getCognitivePhaseSnapshot(cognitiveLedger)

    // Sycophancy trap: record previous turn's behavior
    let yaoguangHint: string | null = null
    if (turn > 1 && this.self.recentToolHistory.length > 0) {
      const EPISTEMIC_TOOLS = new Set(['read_file', 'grep', 'list_dir', 'glob', 'search', 'recall', 'read_image'])
      const hadEpistemic = this.self.recentToolHistory.some(t => EPISTEMIC_TOOLS.has(t.tool))
      const confidence = this.self.sensorium?.confidence ?? 0.5
      this.self.sycophancyTrap.recordTurn({ agreedWithUser: !hadEpistemic, confidence })

      // ── 瑶光 afterPerception 门禁：复现即证 ──
      // 蒸馏自瑶光胶囊 #1「绿非证明，复现即证」。
      // 模型引用了文件名但本轮未调用任何验证工具 → 断言大概率是猜测。
      const streamedText = this.self.streamedText
      const fileRefPattern = /\b[\w./-]+\.(?:ts|tsx|js|jsx|py|rs|go|java|rb|vue|svelte|css|scss|html|json|yaml|yml|md|sql)\b/
      if (!hadEpistemic && streamedText.length > 200 && fileRefPattern.test(streamedText)) {
        yaoguangHint = '【瑶光·复现即证】上轮回复引用了文件名但未读取其中任何文件。在下一轮开始前，你必须用实际 read_file 或 grep 输出证明你的断言——不可凭文件名推断内容。绿非证明，复现即证。'
      }
    }
    const sycophancyHint = this.self.sycophancyTrap.getHint()
    const immuneHint = this.self._lastImmuneHint ? formatImmuneContext(this.self._lastImmuneHint) : undefined
    this.self._lastImmuneHint = undefined // consume once
    const projection = actionable ? buildCognitivePromptProjection(cognitiveLedger, { sycophancyHint, immuneHint, yaoguangHint }) : ''
    this.self.config.promptEngine.setCognitiveProjection(projection)

    // ── CVM overhead tracking ──
    // 盘古呼吸：CVM 保护的资源（context）也是它消耗的资源。
    // 追踪每次注入的 token 估计，防止认知氧气被自身消耗殆尽。
    // chars / 4 ≈ tokens (crude but fast estimate for overhead ratio)
    if (actionable) {
      const toolCtxLen = this.self.config.promptEngine.getToolContextLength()
      const cvmTokenEstimate = Math.ceil((projection.length + toolCtxLen) / 4)
      this.self.pressureMonitor.recordCvmInjection(cvmTokenEstimate)
    }
  }

  async runPerception(
    turn: number,
    estTokens: number,
    actionable: boolean,
    callbacks: AgentCallbacks,
  ): Promise<{
    sensorium: Sensorium
    strategy: StrategyProfile
    phaseClass: string
    pressureResult: import('../context/pressure-monitor.js').PressureResult
  }> {
    // ── StarFlow v2: Sensorium computation ──
    const pressureResult = this.self.pressureMonitor.check(estTokens, this.self.session.getTurnCount())
    if (!actionable) {
      this.self.config.promptEngine.setCognitiveProjection(null)
      this.self.config.promptEngine.setTaskProgress({ completed: [], current: 'chat-mode', remaining: [], decisions: [] })
    }
    callbacks.onPhaseChange?.('preparing', { reason: 'preparing next turn' })

    // ── Event-loop gap detection ──
    // If >30s elapsed since last tool completion, the event loop may have
    // been blocked. Log a warning to help diagnose session freeze bugs.
    if (this.self.lastToolCompleteTime > 0) {
      const gapMs = Date.now() - this.self.lastToolCompleteTime
      if (gapMs > 30_000) {
        debugLog(`[event-loop] WARNING: ${(gapMs / 1000).toFixed(1)}s gap since last tool completion (turn ${this.self.session.getTurnCount()})`)
      }
    }

    const _tb = Date.now()
    const perceptionResult = await this.self.perception.perceive({
      turn,
      estimatedTokens: estTokens,
      pressureResult,
      evidenceState: this.self.evidence.getState(),
      predictionAccumulator: this.self.predictionAccumulator,
      recentToolHistory: this.self.recentToolHistory,
      loadedPheromones: this.self.loadedPheromones,
      traceStore: this.self.traceStore,
      gitChangeRate: this.self.gitChangeRate,
      fsEventRate: this.self.latestFsWatcherState.eventRate,
      sensorium: this.self.sensorium,
      strategy: this.self.strategy,
      vigor: this.self.vigorState,
      thetaState: this.self.thetaState,
      thetaTelemetry: this.self.thetaTelemetry,
      thetaCheckInFlight: this.self.thetaCheckInFlight,
      baselineFingerprint: this.self.baselineFingerprint,
    }, {
      emitPhaseChange: (phase, detail) => { callbacks.onPhaseChange?.(phase, detail) },
      emitDecisionShift: (shift) => { callbacks.onDecisionShift?.(shift) },
    })
    this.self.sensorium = perceptionResult.sensorium
    debugLog(`[turn-boundary] turn=${turn} perceive: ${Date.now() - _tb}ms`)
    this.self.strategy = perceptionResult.strategy
    this.self.vigorState = perceptionResult.vigor
    this.self.thetaState = perceptionResult.thetaState
    this.self.sensoriumSnapshots = this.self.perception.getSnapshots()
    const currentSensorium: Sensorium = perceptionResult.sensorium

    // ── 认知季节 — 道德经四章螺旋 ──
    const seasonResult = classifySeason({
      turn,
      doomLevel: this.self.getDoomLoopLevel(),
      recentCompactTurn: this.self.lastCompactTurn,
      sensoriumStability: currentSensorium.stability,
    })
    this.self.currentSeason = seasonResult.season
    this.self.currentSeasonIntensity = seasonResult.intensity

    // ── Embodied Cognition: affordance-gated tool selection hint ──
    const affordanceState: AffordanceState = {
      sensorium: currentSensorium,
      vigor: this.self.vigorState,
      thetaPhase: getThetaPhase(this.self.thetaState),
      season: this.self.currentSeason,
      workingSetSize: this.self.evidence.getState().filesModified.size,
      recentToolNames: this.self.recentToolHistory.map(t => t.tool),
      contractStatus: this.self.taskContract?.status,
    }
    // ── Free Energy Engine: EFE-driven policy guidance ──
    let structuralEpistemic: number | undefined
    try { structuralEpistemic = this.self.immuneHook.getPhysarum().structuralEpistemic() } catch { /* graph signal is optional */ }
    const efe = computeEFE(this.self.predictionAccumulator, this.self.currentSeason, this.self.vigorState, currentSensorium, structuralEpistemic)
    this.self.latestPolicySignals = { efe, sensorium: currentSensorium }
    const affordances = computeAffordanceScores(affordanceState, this.self.sessionAffordanceAdaptations)
    const policies = selectPolicy(efe, affordances, { topK: 5 })
    if (pressureResult.shouldThrottleCvm) {
      this.self.config.promptEngine.setToolContext(null)
    } else {
      this.self.config.promptEngine.setToolContext(renderToolContext(affordanceState, policies, efe) || null)
    }
    this.self.recordModelRoutingShadow(currentSensorium, efe)

    // ── Adaptive Affordance: periodically recalibrate base affordances from sensorimotor history ──
    if (this.self.session.getTurnCount() % 10 === 0) {
      try {
        const db = this.self.config.meridianIndexer?.getDb()
        if (db) {
          this.self.sessionAffordanceAdaptations = adaptAffordanceFromHistory(toolName => db.getToolSuccessRate(toolName, 20))
        }
      } catch { /* affordance adaptation is non-critical */ }
    }

    // Wire StarPhase → phaseClass for field habituation modulation
    const phaseClass = PHASE_CLASS_MAP[perceptionResult.event.phase] ?? 'plan'
    this.self.config.promptEngine.setPhaseHint(phaseClass)
    const contractStatus = contractStatusFromPhaseClass(phaseClass)
    if (this.self.taskContract && contractStatus) {
      const prevStatus = this.self.taskContract.status
      this.self.taskContract = advanceContractStatus(this.self.taskContract, contractStatus, this.self.session.getTurnCount())

      // TDD Gate: one-shot check on planning→executing transition
      if (prevStatus === 'planning' && this.self.taskContract.status === 'executing' && !this.self._lastImmuneHint) {
        const es = this.self.evidence.getState()
        const tddHint = checkTddGate({
          filesRead: es.filesRead,
          filesModified: es.filesModified,
          isActionable: this.self.taskContract.isActionable,
        })
        if (tddHint) this.self._lastImmuneHint = tddHint
      }
    }

    // ── Cognitive projection — build & inject cognitive-mirror + contract +
    // verification-gap + uncertainty + immune hint. Runs last so it sees the
    // freshly-advanced contract status and consumes the TDD-gate immune hint
    // produced above (reproduces the original _runInner step-6e ordering).
    this.runCognitivePrep(turn, actionable, pressureResult)

    return { sensorium: perceptionResult.sensorium, strategy: perceptionResult.strategy, phaseClass, pressureResult }
  }
}
