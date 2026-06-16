import type { AgentLoop } from './loop.js'
import { TurnStreamController } from './turn-stream.js'
import { TurnCompletionController } from './turn-completion.js'
import { ToolExecutionController } from './tool-execution.js'
import type { RuntimeHookSnapshot } from './runtime-hooks.js'
import { createRuntimeHookContext } from './runtime-hooks.js'
import { buildPrewarmValue } from './prewarm-file.js'
import { recordToolNamedFingerprint } from './trace-store.js'
import { join } from 'node:path'
import type { AgentCallbacks } from './loop-types.js'
import { diagnoseCacheMiss } from '../prompt/cache-diagnostic.js'
import { isSystemReminder, wrapSystemReminder } from '../prompt/system-reminder.js'
import { PlanTraceCoordinator } from './plan-trace-coordinator.js'
import { CompactBoundaryCoordinator } from './compact-boundary-coordinator.js'
import { TurnOrchestrator } from './turn-orchestrator.js'
import { ReasoningEffortController } from './reasoning-effort-controller.js'
import { IntentRetrievalRouteController } from './intent-retrieval-route-controller.js'

export function createTurnStreamController(self: AgentLoop): TurnStreamController {
// P2-6 breadcrumb state: previous-turn snapshots for diffing cumulative
// engine counters and detecting history rewrites / hit-rate cliffs.
let prevEngineStats = { volatileSwaps: 0, frozenClamps: 0, frozenFallbackRebuilds: 0, toolsUpdates: 0 }
let prevMsgCount = 0
let prevHitRate: number | null = null
return new TurnStreamController({
      client: self.config.client,
      abortSignal: self.abortController?.signal ?? new AbortController().signal,
      getStreamedTextLength: () => self.streamedText.length,
      appendStreamedText: text => { self.streamedText += text },
      getLastPrewarmAt: () => self.lastPrewarmAt,
      setLastPrewarmAt: position => { self.lastPrewarmAt = position },
      maybePrewarm: text => { self.maybePrewarm(text) },
      prewarmFile: async filePath => {
        const value = await buildPrewarmValue(self.cwd, filePath)
        if (value && !self.prewarm.has(value.canonicalPath)) {
          self.prewarm.set(value.canonicalPath, value)
        }
      },
      addUsage: usage => { self.session.addUsage(usage) },
      recordTurnCache: (turn, usage) => {
        self.session.recordTurnCache(turn, usage)
        const hitRateNum = usage.input_tokens > 0
          ? (usage.cache_read_input_tokens ?? 0) / usage.input_tokens * 100
          : 0
        const hitRate = hitRateNum.toFixed(1)
        const sid = self.config.sessionId ?? 'anon'

        // ── P2-6 breadcrumbs: make every break attributable in one read ──
        const entry: Record<string, unknown> = {
          t: Date.now(), turn,
          // model 让每条记录可溯源到具体模型 — /model 运行时切换后，
          // 同一会话的 cache-log 会跨多个模型，无此字段无法归因。
          model: self.config.promptEngine.getModel(),
          input: usage.input_tokens,
          cacheRead: usage.cache_read_input_tokens,
          cacheCreate: usage.cache_creation_input_tokens,
          hitRate: `${hitRate}%`,
        }
        try {
          const messages = self.session.getMessages()
          let userMsgCount = 0
          let injectedCount = 0
          for (const m of messages) {
            if (m.role !== 'user') continue
            userMsgCount++
            if (isSystemReminder((m as { content?: unknown }).content)) injectedCount++
          }
          entry.userMsgs = userMsgCount
          if (injectedCount > 0) entry.injected = injectedCount

          // History rewrite detection: message count shrank since last turn
          // (compact / replace / session split) — the classic mid-round breaker.
          if (prevMsgCount > 0 && messages.length < prevMsgCount) entry.historyRewritten = true
          const wasRewritten = entry.historyRewritten === true
          prevMsgCount = messages.length

          // Engine event diffs (volatile swap / frozen clamp / fallback / tools)
          const stats = self.config.promptEngine.getCacheEventStats?.()
          if (stats) {
            if (stats.volatileSwaps > prevEngineStats.volatileSwaps) entry.volatileSwapped = true
            if (stats.frozenClamps > prevEngineStats.frozenClamps) entry.frozenClamped = true
            if (stats.frozenFallbackRebuilds > prevEngineStats.frozenFallbackRebuilds) entry.frozenEvicted = true
            if (stats.toolsUpdates > prevEngineStats.toolsUpdates) entry.toolsUpdated = true
            if (stats.collapseWatermark > 0) entry.collapseWatermark = stats.collapseWatermark
            prevEngineStats = { volatileSwaps: stats.volatileSwaps, frozenClamps: stats.frozenClamps, frozenFallbackRebuilds: stats.frozenFallbackRebuilds, toolsUpdates: stats.toolsUpdates }
          }

          // Auto-diagnose on a hit-rate cliff (> 15 percentage-point drop).
          if (prevHitRate !== null && prevHitRate - hitRateNum > 15) {
            const diag = diagnoseCacheMiss(self.session.getCacheHistory(), turn, null, wasRewritten)
            if (diag) entry.diagnose = `${diag.reason}: ${diag.message}`
          }
          prevHitRate = hitRateNum
        } catch { /* breadcrumbs are best-effort — never break cache logging */ }

        const line = JSON.stringify(entry)
        import('node:fs/promises').then(fs => {
          const dir = join(self.cwd, '.rivet', 'sessions', sid)
          return fs.mkdir(dir, { recursive: true })
            .then(() => fs.appendFile(join(dir, 'cache-log.jsonl'), line + '\n'))
        }).catch(() => {})
      },
    })
}
export function createTurnCompletionController(self: AgentLoop, callbacks?: AgentCallbacks): TurnCompletionController {
return new TurnCompletionController({
      config: self.config,
      session: self.session,
      trajectory: self.trajectory,
      routingMetrics: self.routingMetrics,
      evidence: self.evidence,
      getStreamedText: () => self.streamedText,
      getDecisions: () => self.decisions,
      setDecisions: decisions => { self.decisions = decisions },
      refreshLedger: () => { self.contextInjection.refreshLedger() },
      refreshCacheDiagnostic: turn => { self.refreshCacheDiagnostic(turn) },
      runPostTurn: async () => {
        await self.runtimeHooks.runPostTurn(createRuntimeHookContext(self.buildRuntimeSnapshot(), {
          emitPhaseChange: (phase, detail) => { callbacks?.onPhaseChange?.(phase, detail) },
        }))
      },
      runBeforeComplete: async () => {
        if (callbacks) await self.runPostSession(callbacks)
      },
    })
}
export function createToolExecutionController(self: AgentLoop): ToolExecutionController {
return new ToolExecutionController({
      config: self.config,
      cwd: self.cwd,
      harness: self.harness,
      prewarm: self.prewarm,
      evidence: self.evidence,
      repairHintTracker: self.repairHintTracker,
      repairPipeline: self.repairPipeline,
      immuneHook: self.immuneHook,
      runtimeHooks: self.runtimeHooks,
      contextInjection: self.contextInjection,
      trajectory: self.trajectory,
      getPredictionAccumulator: () => self.predictionAccumulator,
      setPredictionAccumulator: a => { self.predictionAccumulator = a },
      getVigorState: () => self.vigorState,
      setVigorState: v => { self.vigorState = v },
      getDoomLoopLevel: () => self.getDoomLoopLevel(),
      getPhaseHint: () => self.config.promptEngine.getPhaseHint(),
      getSessionTurnCount: () => self.session.getTurnCount(),
      getSessionId: () => self.config.sessionId,
      addToolResults: results => { self.session.addToolResults(results) },
      recordToolHistory: (name, input, isError, content) => self.recordToolHistory(name, input, isError, content),
      onLeaveMark: mark => self.captureLeaveMark(mark),
      onPlanSteps: descriptions => self.capturePlanSteps(descriptions),
      onPlanClosed: input => self.handlePlanClosed(input),
      buildRuntimeSnapshot: extra => self.buildRuntimeSnapshot(extra),
      requestThetaCheck: reason => { self.requestThetaCheck(reason) },
      getAutoReasoning: () => self.config.autoReasoning ?? false,
      getReasoningEffort: () => self.config.reasoningEffort,
      setClientReasoningEffort: effort => { self.setReasoningEffort(effort) },
      getSensorium: () => self.sensorium,
      getReliabilityDecision: () => self.latestReliabilityDecision,
      getTurnBudget: () => self.turnBudget,
      artifactStore: self.artifactStore,
      sessionStateManager: self.sessionStateManager,
      cacheAdvisor: self.cacheAdvisor,
      p3: self.p3,
      lspManager: self.config.lspManager,
      getLspManager: self.config.getLspManager,
      getEstimatedTokens: () => self.session.getEstimatedTokens(),
      getToolNameHistory: () => self.traceStore?.toolNameHistory ?? [],
      recordToolNamedFingerprint: (fingerprint: string, toolName: string) => {
        if (self.traceStore) {
          self.traceStore = recordToolNamedFingerprint(self.traceStore, fingerprint, toolName)
        }
      },
    })
}
export function buildRuntimeSnapshot(self: AgentLoop, extra?: Partial<RuntimeHookSnapshot>): RuntimeHookSnapshot {
return {
      cwd: self.cwd,
      turn: self.session.getTurnCount(),
      recentToolHistory: self.recentToolHistory.map(h => ({ tool: h.tool, status: h.status, target: h.target })),
      sensorium: self.sensorium,
      strategy: self.strategy,
      vigor: self.vigorState,
      gitChangeRate: self.gitChangeRate,
      season: self.currentSeason,
      thetaTelemetry: {
        lastTimedOut: self.thetaTelemetry.lastTimedOut,
        consecutiveTimeouts: self.thetaTelemetry.consecutiveTimeouts,
      },
      ...extra,
    }
}

export function createPlanTraceCoordinator(self: AgentLoop): PlanTraceCoordinator {
  return new PlanTraceCoordinator({
    getPlanTrace: () => self.planTrace,
    setPlanTrace: t => { self.planTrace = t },
    getLastReplanInjection: () => self.lastReplanInjection,
    setLastReplanInjection: s => { self.lastReplanInjection = s },
    getLatestConvergenceResult: () => self.latestConvergenceResult,
    getConsecutiveNoToolTurns: () => self.consecutiveNoToolTurns,
    getTraceStore: () => self.traceStore,
    addSystemReminder: content => { self.session.addUserMessage(wrapSystemReminder(content)) },
    setPlanTraceAppendix: appendix => { self.config.promptEngine.setPlanTraceAppendix(appendix) },
  })
}

export function createCompactBoundaryCoordinator(self: AgentLoop): CompactBoundaryCoordinator {
  return new CompactBoundaryCoordinator({
    getCompactFailures: () => self.compactFailures,
    setCompactFailures: f => { self.compactFailures = f },
    getLastCompactTurn: () => self.lastCompactTurn,
    setLastCompactTurn: t => { self.lastCompactTurn = t },
    getPendingStaleCompact: () => self.pendingStaleCompact,
    setPendingStaleCompact: v => { self.pendingStaleCompact = v },
    getPendingHeapCompact: () => self.pendingHeapCompact,
    setPendingHeapCompact: v => { self.pendingHeapCompact = v },
    getPrevPhaseHint: () => self._prevPhaseHint,
    setPrevPhaseHint: h => { self._prevPhaseHint = h },
    getAbortSignal: () => self.abortController?.signal,
    getContextWindow: () => self.config.contextWindow ?? 1_000_000,
    getPhaseHint: () => self.config.promptEngine.getPhaseHint(),
    getEstimatedTokens: () => self.session.getEstimatedTokens(),
    getMessages: () => self.session.getMessages(),
    replaceMessages: msgs => { self.session.replaceMessages(msgs) },
    dietMessages: msgs => self.p3.dietMessages(msgs as any) as any,
    trySessionSplit: () => self.compaction.trySessionSplit(),
    maybeCompact: opts => self.compaction.maybeCompact(opts),
    tryPartialCompact: target => self.compaction.tryPartialCompact(target),
    shouldDelayCompact: (threshold, ctx) => self.cacheAdvisor.shouldDelayCompact(threshold, ctx?.estimatedTokens !== undefined && ctx?.contextWindow !== undefined ? { estimatedTokens: ctx.estimatedTokens, contextWindow: ctx.contextWindow } : undefined),
    getStalePreviewChars: () => self.cacheAdvisor.getStalePreviewChars(),
    injectImmuneSignal: signal => { self.immuneHook.injectSignal(signal as any) },
  })
}

export function createTurnOrchestrator(self: AgentLoop): TurnOrchestrator {
  return new TurnOrchestrator({
    // === Lifecycle ===
    initializeRun: (userInput, callbacks) => self.initializeRun(userInput, callbacks),
    stopFsWatcher: () => { self.stopFsWatcher() },

    // === Config ===
    getMaxTurns: () => self.config.maxTurns,
    getTurnLevelThinking: () => self.config.turnLevelThinking,
    getPlanModeState: () => self.planModeState,
    getStreamRules: () => self.config.streamRules,
    getAgentReconnect: () => self.config.agentReconnect,
    getCwd: () => self.cwd,
    setClientThinking: (mode) => { self.config.client.setThinking?.(mode) },
    flushMeridianTurn: () => { self.config.meridianIndexer?.flushTurn() },
    syncPlanModeToConfig: () => { self.syncPlanModeToConfig() },

    // === Session ===
    removeLastMessage: () => { self.session.removeLastMessage() },
    addUserMessage: (content) => { self.session.addUserMessage(content) },
    addAssistantBlocks: (blocks) => { self.session.addAssistantBlocks(blocks) },
    addUsage: (usage) => { self.session.addUsage(usage) },
    getEstimatedTokens: () => self.session.getEstimatedTokens(),
    getMessages: () => self.session.getMessages(),
    getTotalUsage: () => self.session.getTotalUsage(),
    getTurnCount: () => self.session.getTurnCount(),
    getCacheHistory: () => self.session.getCacheHistory(),

    // === Sub-processes (thin wrappers) ===
    runCompaction: (turn, snap) => self.runCompaction(turn, snap),
    runPerception: (turn, estTokens, actionable, callbacks) => self.runPerception(turn, estTokens, actionable, callbacks),
    runConvergenceCheck: (turn, phaseClass, assistantResponded, userMessageConsumed, callbacks) =>
      self.runConvergenceCheck(turn, phaseClass, assistantResponded, userMessageConsumed, callbacks),
    runReplanCheck: () => { self.runReplanCheck() },
    buildTurnRequest: (turn, strategy, sensorium, pressureResult, assistantResponded, userMessageConsumed, callbacks) =>
      self.buildTurnRequest(turn, strategy, sensorium, pressureResult, assistantResponded, userMessageConsumed, callbacks),
    prewarmRecentReads: () => self.prewarmRecentReads(),
    runPostSession: (callbacks) => self.runPostSession(callbacks),
    recordProviderOutcome: (ok) => { self.recordProviderOutcome(ok) },

    // === Sub-controllers ===
    streamTurn: (params) => self.turnStream!.streamTurn(params),
    executeBatch: (params) => self.toolExecution.executeBatch(params),
    completeTurn: (params) => self.turnCompletion.complete(params),
    appendTurnResult: (turn) => { self.planTraceCoordinator.appendTurnResult(turn) },
    onCacheAdvisorTurnEnd: (params) => { self.cacheAdvisor.onTurnEnd(params) },

    // === Telemetry ===
    writeTelemetry: (entry) => { (self.telemetryWriter as any).write(entry) },
    resetEvidence: () => { self.evidence.reset() },

    // === Abort signal ===
    getAbortSignal: () => self.abortController?.signal,

    // === Resource sensor ===
    getLatestResourceSnapshot: () => self.latestResourceSnapshot,

    // === FsWatcher ===
    getFsWatcherState: () => self.fsWatcher?.getState() ?? { eventRate: 0, eventCount: 0, active: false },

    // === Per-run state ===
    getStreamedText: () => self.streamedText,
    setStreamedText: (v) => { self.streamedText = v },
    getLastPrewarmAt: () => self.lastPrewarmAt,
    setLastPrewarmAt: (v) => { self.lastPrewarmAt = v },
    getGitChangeRate: () => self.gitChangeRate,
    setGitChangeRate: (v) => { self.gitChangeRate = v },
    setTurnBudget: (v) => { self.turnBudget = v },
    getLatestFsWatcherState: () => self.latestFsWatcherState,
    setLatestFsWatcherState: (v) => { self.latestFsWatcherState = v },
    getConsecutiveNoToolTurns: () => self.consecutiveNoToolTurns,
    setConsecutiveNoToolTurns: (v) => { self.consecutiveNoToolTurns = v },
    getThinkingOnlyRetries: () => self.thinkingOnlyRetries,
    setThinkingOnlyRetries: (v) => { self.thinkingOnlyRetries = v },
    getLastThinkingContent: () => self.lastThinkingContent,
    setLastThinkingContent: (v) => { self.lastThinkingContent = v },
    getLastTurnTextFingerprint: () => self.lastTurnTextFingerprint,
    setLastTurnTextFingerprint: (v) => { self.lastTurnTextFingerprint = v },
    getLastTurnThinkingFingerprint: () => self.lastTurnThinkingFingerprint,
    setLastTurnThinkingFingerprint: (v) => { self.lastTurnThinkingFingerprint = v },
    getRecentTextFingerprints: () => self.recentTextFingerprints,
    setTurnsSinceLastObjection: (v) => { self.turnsSinceLastObjection = v },
    getTraceStore: () => self.traceStore,
    setTraceStore: (v) => { self.traceStore = v },
    getImportGraph: () => self.importGraph,
    setImportGraph: (v) => { self.importGraph = v },
    getLastConflictCheckCount: () => self.lastConflictCheckCount,
    setLastConflictCheckCount: (v) => { self.lastConflictCheckCount = v },
    getLatestRisk: () => self.latestRisk,
    setLatestRisk: (v) => { self.latestRisk = v },
    setThetaRequestsThisTurn: (v) => { self.thetaRequestsThisTurn = v },
  })
}

export function createReasoningEffortController(self: AgentLoop): ReasoningEffortController {
  return new ReasoningEffortController({
    getReasoningFloor: () => self.config.reasoningFloor,
    getConfigReasoningEffort: () => self.config.reasoningEffort,
    setConfigReasoningEffort: effort => { self.config.reasoningEffort = effort },
    setClientReasoningEffort: effort => { self.config.client.setReasoningEffort?.(effort) },
    isEffortBanditEnabled: () => self.config.effortBanditEnabled ?? false,
    p3: self.p3,
    hasTaskContract: () => !!self.taskContract,
    getPredictionAccumulator: () => self.predictionAccumulator,
    getTurnCount: () => self.session.getTurnCount(),
    getMaxTurns: () => self.config.maxTurns,
    getFilesModifiedCount: () => self.evidence.getState().filesModified.size,
    setCurrentEffortShadow: record => { self._currentEffortShadow = record },
  })
}

export function createIntentRetrievalRouteController(self: AgentLoop): IntentRetrievalRouteController {
  return new IntentRetrievalRouteController({
    setIntentRetrievalRoute: route => { self.config.promptEngine.setIntentRetrievalRoute(route) },
    getTaskContract: () => self.taskContract,
    getMessages: () => self.session.getMessages(),
    getSessionStateManager: () => self.sessionStateManager,
    getTurnCount: () => self.session.getTurnCount(),
    getLastRetrievalRoute: () => self._lastRetrievalRoute,
    setLastRetrievalRoute: route => { self._lastRetrievalRoute = route },
    getRouterConfig: () => self.config.intentRetrievalRouter,
    getClient: () => self.config.client,
    getModel: () => self.config.promptEngine.getModel(),
    getAbortSignal: () => self.abortController?.signal,
  })
}
