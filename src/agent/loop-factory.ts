import type { AgentLoop } from './loop.js'
import { TurnStreamController } from './turn-stream.js'
import { TurnCompletionController } from './turn-completion.js'
import { ToolExecutionController } from './tool-execution.js'
import type { RuntimeHookSnapshot } from './runtime-hooks.js'
import { createRuntimeHookContext, RuntimeHookPipeline } from './runtime-hooks.js'
import { createDefaultRuntimeHooks } from './create-runtime-hooks.js'
import { createUserHooksBridge, runOnErrorHooks } from './hooks/user-hooks-bridge.js'
import { normalizeAntiAnchoringConfig } from './anti-anchoring-config.js'
import { mapQueriedPheromones } from './pheromone-map.js'
import { buildPrewarmValue, batchPrewarm } from './prewarm-file.js'
import { recordToolNamedFingerprint } from './trace-store.js'
import { join, isAbsolute } from 'node:path'
import { analyzeImpact } from '../repo/meridian-impact.js'
import { getSessionDir } from './session-persist.js'
import type { AgentCallbacks } from './loop-types.js'
import { diagnoseCacheMiss } from '../prompt/cache-diagnostic.js'
import { computeCompactAttribution } from './compact-attribution.js'
import { isCostInsensitiveProvider } from '../api/cost-model.js'
import { isSystemReminder } from '../prompt/system-reminder.js'
import { getReadRefStats } from '../tools/read-file.js'
import { PlanTraceCoordinator } from './plan-trace-coordinator.js'
import { CompactBoundaryCoordinator, DEFAULT_QUALITY_COMPACT_THRESHOLDS } from './compact-boundary-coordinator.js'
import { TurnOrchestrator, type TurnStateBag } from './turn-orchestrator.js'
import { GoalContinuationController } from './goal-continuation.js'
import { PostTurnDecisionController } from './post-turn-decision.js'
import { ReasoningEffortController } from './reasoning-effort-controller.js'
import { IntentRetrievalRouteController } from './intent-retrieval-route-controller.js'
import { AntiAnchoringController } from './anti-anchoring-controller.js'
import { ModelRoutingShadowController } from './model-routing-shadow-controller.js'
import { PrewarmController } from './prewarm-controller.js'
import { TurnStepProducer } from './turn-step-producer.js'
import { skillRegistry } from '../skills/skill-loader.js'

export function createTurnStreamController(self: AgentLoop): TurnStreamController {
return new TurnStreamController({
      client: self.config.client,
      abortSignal: self.abortController?.signal ?? new AbortController().signal,
      getStreamedTextLength: () => self.streamedText.length,
      appendStreamedText: text => { self.streamedText += text },
      getLastPrewarmAt: () => self.lastPrewarmAt,
      setLastPrewarmAt: position => { self.lastPrewarmAt = position },
      maybePrewarm: text => { self.prewarmController.maybePrewarm(text) },
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
          // Output token breakdown: total vs reasoning vs text. Phase 0 of the
          // output-token optimization — lets us see whether the spend is in
          // thinking (reasoning) or final prose (text) before any intervention.
          output: usage.output_tokens,
        }
        // tokenEfficiency from convergence detector: cross-validate with cache hit rate
        const te = self.latestConvergenceResult?.signals.tokenEfficiency
        if (te !== undefined) entry.tokenEfficiency = te
        if (usage.reasoning_tokens !== undefined) {
          entry.reasoning = usage.reasoning_tokens
          entry.text = Math.max(0, usage.output_tokens - usage.reasoning_tokens)
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

          // Prompt anatomy: projection and appendix byte sizes for delta cost analysis.
          const projLen = self.config.promptEngine.getCognitiveProjectionLength?.()
          const appxLen = self.config.promptEngine.getCachedAppendixLength?.()
          if (projLen !== undefined && projLen > 0) entry.projChars = projLen
          if (appxLen !== undefined && appxLen > 0) entry.appendixChars = appxLen

          // Read-ref telemetry (Part B): bytes saved by [read-ref] shortcuts.
          const refStats = getReadRefStats()
          if (refStats.count > 0) {
            entry.readRefSavedBytes = refStats.savedBytes
            entry.readRefCount = refStats.count
          }

          // History rewrite detection: message count shrank since last turn
          // (compact / replace / session split) — the classic mid-round breaker.
          if (self.prevMsgCount > 0 && messages.length < self.prevMsgCount) entry.historyRewritten = true
          const wasRewritten = entry.historyRewritten === true
          self.prevMsgCount = messages.length

          // Compact attribution: when history shrank, record whether the window
          // was actually under pressure before the rewrite (compactPreRatio) and
          // how much it reclaimed. Combined with this turn's hitRate (the cache
          // cost), this makes "was the compact necessary?" answerable from the
          // cache-log alone — see scripts/analyze-compact-events.ts.
          const estTokensNow = self.session.getEstimatedTokens()
          if (wasRewritten) {
            Object.assign(entry, computeCompactAttribution(self.prevEstTokens, estTokensNow, self.config.contextWindow))
            // Attach the archive id (if this rewrite archived its dropped zone)
            // so the recall telemetry can be joined back to this turn. Consume
            // once: clear so a later non-archiving rewrite doesn't reuse it.
            if (self.lastArchive) entry.archiveId = self.lastArchive.id
          }
          self.lastArchive = null
          self.prevEstTokens = estTokensNow

          // Engine event diffs (volatile swap / frozen clamp / fallback / tools)
          const stats = self.config.promptEngine.getCacheEventStats?.()
          if (stats) {
            if (stats.volatileSwaps > self.prevEngineStats.volatileSwaps) entry.volatileSwapped = true
            if (stats.frozenClamps > self.prevEngineStats.frozenClamps) entry.frozenClamped = true
            if (stats.frozenFallbackRebuilds > self.prevEngineStats.frozenFallbackRebuilds) entry.frozenEvicted = true
            if (stats.toolsUpdates > self.prevEngineStats.toolsUpdates) entry.toolsUpdated = true
            if (stats.collapseWatermark > 0) entry.collapseWatermark = stats.collapseWatermark
            self.prevEngineStats = { volatileSwaps: stats.volatileSwaps, frozenClamps: stats.frozenClamps, frozenFallbackRebuilds: stats.frozenFallbackRebuilds, toolsUpdates: stats.toolsUpdates }
          }

          // Auto-diagnose on a hit-rate cliff (> 15 percentage-point drop).
          if (self.prevHitRate !== null && self.prevHitRate - hitRateNum > 15) {
            const diag = diagnoseCacheMiss(self.session.getCacheHistory(), turn, null, wasRewritten)
            if (diag) entry.diagnose = `${diag.reason}: ${diag.message}`
            // Cross-validate: tokenEfficiency also collapsing → cache-break compensation loop
            if (te !== undefined && self.prevTokenEfficiency !== undefined && self.prevTokenEfficiency > 0.5 && te < 0.2) {
              entry.diagnose = (entry.diagnose ? `${entry.diagnose}; ` : '') + 'possible cache-break compensation loop: tokenEfficiency collapsed alongside cache hit rate'
            }
          }
          self.prevHitRate = hitRateNum
          if (te !== undefined) self.prevTokenEfficiency = te
        } catch { /* breadcrumbs are best-effort — never break cache logging */ }

        const line = JSON.stringify(entry)
        import('node:fs/promises').then(fs => {
          const dir = join(getSessionDir(self.cwd), sid)
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
      getEffortShadow: () => self._currentEffortShadow,
      clearEffortShadow: () => { self._currentEffortShadow = null },
      completeEffortShadow: (id, input) => { self.p3?.completeEffortShadow(id, input) },
      getDoomLoopLevel: () => self.getDoomLoopLevel(),
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
      isGoalActive: () => self.isGoalActive(),
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
      recentToolHistory: self.recentToolHistory.map(h => ({ tool: h.tool, status: h.status, target: h.target, argsHash: h.argsHash })),
      sensorium: self.sensorium,
      strategy: self.strategy,
      vigor: self.vigorState,
      gitChangeRate: self.gitChangeRate,
      season: self.currentSeason,
      thetaTelemetry: {
        lastTimedOut: self.thetaTelemetry.lastTimedOut,
        consecutiveTimeouts: self.thetaTelemetry.consecutiveTimeouts,
      },
      touchedTsFiles: self.touchedTsFiles,
      sawTypecheckThisTask: self.sawTypecheckThisTask,
      ...extra,
    }
}

export function createRuntimeHooksPipeline(self: AgentLoop): RuntimeHookPipeline {
  const userBridgeDeps = {
    cwd: self.cwd,
    sessionId: self.config.sessionId,
    getTurn: () => self.session.getTurnCount(),
    emitHookResult: self.config.emitHookResult,
  }
  const hooks = createDefaultRuntimeHooks({
    stigmergyDeposit: deposit => self.stigmergyStore.deposit(deposit),
    stigmergyQuery: () => self.stigmergyStore.query(),
    getEvidenceState: () => self.evidence.getState(),
    setLoadedPheromones: pheromones => { self.loadedPheromones = mapQueriedPheromones(pheromones) },
    recordStance: signal => self.stanceTally.record(signal),
    publishEvent: self.config.sessionRegistry && self.config.sessionId
      ? (input) => self.config.sessionRegistry!.publishEvent(self.config.sessionId!, input)
      : undefined,
    sessionId: self.config.sessionId,
    getThetaState: () => self.thetaState,
    setThetaState: state => { self.thetaState = state },
    getPredictionAccumulator: () => self.predictionAccumulator,
    playbookStore: self.config.playbookStore,
    sessionRegistry: self.config.sessionRegistry,
    cwd: self.cwd,
    buildRetrospectInput: () => {
      const es = self.evidence.getState()
      return {
        sensoriumEntries: self.sensoriumSnapshots, gitLog: [],
        toolEvents: self.traceStore.events.filter(e => e.kind === 'tool').map(e => ({ turn: e.turn, name: e.name, status: e.status === 'passed' ? 'passed' : 'failed' })),
        evidenceSummary: { filesModified: es.filesModified.size, verifiedCount: es.verifications.filter(v => v.status === 'passed').length },
        pheromoneSignals: self.loadedPheromones.map(p => ({ signal: p.signal, path: p.path, strength: p.strength })),
      }
    },
    getDoomLoopLevel: () => self.getDoomLoopLevel(),
    wasConvergenceTriggered: () => self.latestConvergenceResult?.shouldKick ?? false,
    telemetryWriter: self.telemetryWriter,
    getPhysarumShadowStats: () => self.getPhysarumShadowStats(),
    getDomainId: () => self.sessionDomain?.id ?? null,
    getFileObservations: () => self.config.contextClaimStore?.listClaims({ kind: ['file_observation'] }) ?? [],
    antiAnchoring: normalizeAntiAnchoringConfig(self.config.antiAnchoring),
    getInitialUserMessage: () => self.initialUserMessage,
    callAntiAnchoringSeedModel: prompt => self.antiAnchoring.callSeedModel(prompt),
    songlineEnabled: self.config.songlineEnabled,
    getTaskSummary: self.config.taskLedger ? () => self.config.taskLedger!.getSummary() : undefined,
    setCycleClose: self.config.sessionRegistry
      ? (sessionId, closeHash) => self.config.sessionRegistry!.setCycleClose(sessionId, closeHash)
      : undefined,
    constellationEnabled: self.config.sessionId !== undefined,
    constellationCwd: self.cwd,
    getConstellationPendingMark: () => self.pendingLeaveMark,
    getConstellationNumericId: () => self._sessionNumericId,
    companionPresenceEnabled: self.config.sessionId !== undefined,
    companionPresenceCwd: self.cwd,
    getCognitiveSnapshot: () => {
      if (!self.vigorState || !self.sensorium) return null
      return {
        vigor: self.vigorState.tonic,
        stability: self.sensorium.stability,
        season: self.currentSeason ?? 'unknown',
        convergencePrecision: self.latestConvergenceResult?.score,
        outputEfficiency: self.latestConvergenceResult?.signals.tokenEfficiency,
      }
    },
    getObjective: () => self.taskContract?.objective ?? self.initialUserMessage?.slice(0, 120) ?? null,
    hearthObserveEnabled: self.config.hearthObserveEnabled,
    getAnchorGraph: () => self.antiAnchoring.buildAnchorGraph(),
    getPrevAnchorGraphHash: () => self.prevAnchorGraphHash,
    setPrevAnchorGraphHash: (hash: string) => { self.prevAnchorGraphHash = hash },
    getStreamedText: () => self.streamedText,
    getPrevStreamedText: () => self.prevStreamedText,
    setPrevStreamedText: (text: string) => { self.prevStreamedText = text },
    getPrevCycleOpen: self.config.sessionRegistry && self.config.sessionId
      ? () => self.config.sessionRegistry!.getLastCycleClose()
      : undefined,
    getPrevSessionCycleClose: self.config.sessionRegistry
      ? () => self.config.sessionRegistry!.getLastCycleClose()
      : undefined,
    ...(self.config.sessionId ? {
      dream: {
        cwd: self.cwd,
        sessionId: self.config.sessionId,
        getDecisions: () => self.decisions,
        getTrajectory: () => self.trajectory.getEntries(),
        getFailureJournal: () => self.failureJournal,
      },
      getRegisteredSkills: () => skillRegistry.list().map(s => ({ name: s.name, triggers: s.triggers })),
    } : {}),
    meridianIndexer: self.config.meridianIndexer,
    physarumFileAccess: {
      getPhysarum: () => self.immuneHook.getPhysarum(),
      onPredictions: batch => {
        self.p3.enqueuePhysarumFilePredictions({
          afterToolName: batch.afterToolName,
          predictions: batch.predictions,
        })
        void batchPrewarm(
          self.cwd,
          batch.predictions.map(prediction => prediction.file),
          self.prewarm,
        ).catch(() => {})
      },
    },
    autoDelegate: (self.config.coordinatorRef && self.config.autoDelegateEnabled) ? {
      getTaskContract: () => self.getTaskContract(),
      getSensorium: () => self.sensorium,
    } : undefined,
    anchorBreakScout: (() => {
      const aa = normalizeAntiAnchoringConfig(self.config.antiAnchoring)
      return aa.enabled && aa.anchorBreakScout.enabled && self.config.coordinatorRef
        ? {
            config: aa.anchorBreakScout,
            getCoordinator: () => self.config.coordinatorRef?.() ?? null,
            getAbortSignal: () => self.abortController?.signal,
          }
        : undefined
    })(),
    memoryLearning: {
      cwd: self.cwd,
      sessionId: self.config.sessionId,
      getUserMessage: () => self.initialUserMessage,
      getStreamedText: () => self.streamedText,
    },
    userHooksBridge: userBridgeDeps,
    advisoryBus: self.advisoryBus,
    sycophancyTrap: self.sycophancyTrap,
    getEstimatedTokens: () => self.session.getEstimatedTokens(),
    getContextWindow: () => self.config.contextWindow ?? 128_000,
  })

  // I4: when any runtime hook throws, run user `onError` hooks and emit the
  // result to the desktop event stream.
  return new RuntimeHookPipeline(hooks, {
    onError: (err) => {
      runOnErrorHooks(userBridgeDeps, err.message)
    },
  })
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
    addSystemReminder: content => { self.session.appendSystemReminder(content) },
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
    replaceMessages: msgs => {
      self.session.replaceMessages(msgs)
      self.config.promptEngine.resetAppendixBaseline()
    },
    dietMessages: msgs => self.p3.dietMessages(msgs),
    trySessionSplit: () => self.compaction.trySessionSplit(),
    maybeCompact: opts => self.compaction.maybeCompact(opts),
    tryPartialCompact: target => self.compaction.tryPartialCompact(target),
    shouldDelayCompact: (threshold, ctx) => self.cacheAdvisor.shouldDelayCompact(threshold, ctx?.estimatedTokens !== undefined && ctx?.contextWindow !== undefined ? { estimatedTokens: ctx.estimatedTokens, contextWindow: ctx.contextWindow } : undefined),
    getStalePreviewChars: () => self.cacheAdvisor.getStalePreviewChars(),
    isCachePreservingProvider: () => self.compaction.isCachePreservingProvider(),
    isCostInsensitiveProvider: () => isCostInsensitiveProvider(self.config.providerName),
    getProviderName: () => self.config.providerName,
    getQualityThresholds: () => self.config.compact.qualityCompact ?? DEFAULT_QUALITY_COMPACT_THRESHOLDS,
    injectImmuneSignal: signal => { self.immuneHook.injectSignal(signal) },
  })
}

export function createTurnStepProducer(self: AgentLoop): TurnStepProducer {
  return new TurnStepProducer(self)
}

/**
 * Append meridian blast-radius (downstream consumers + related tests) to goal
 * judge evidence text. Absolute paths are filtered — they silently return empty
 * on repo-relative LIKE queries. When db is null/undefined the text is returned
 * unchanged (headless / server / worker have no indexer).
 */
export function appendMeridianBlastRadius(
  text: string,
  modifiedFiles: string[],
  db: import('../repo/meridian-db.js').MeridianDb | null | undefined,
): string {
  if (!db) return text
  const relFiles = modifiedFiles.filter(f => !isAbsolute(f))
  if (relFiles.length === 0) return text
  const impact = analyzeImpact(db, relFiles)
  const cap = (xs: string[]) => xs.length <= 10 ? xs.join(', ') : `${xs.slice(0, 10).join(', ')} (+${xs.length - 10} more)`
  const parts: string[] = []
  if (impact.direct.length > 0) parts.push(`Direct consumers (verify not broken): ${cap(impact.direct)}`)
  if (impact.tests.length > 0)  parts.push(`Related tests: ${cap(impact.tests)}`)
  if (parts.length === 0) return text
  return text + '\n\nMeridian blast radius:\n' + parts.join('\n')
}

export function createTurnOrchestrator(self: AgentLoop): TurnOrchestrator {
  return new TurnOrchestrator({
    // === Lifecycle ===
    initializeRun: (userInput, callbacks, images) => self.turnStepProducer.initializeRun(userInput, callbacks, images),
    stopFsWatcher: () => { self.stopFsWatcher() },

    // === Config ===
    getMaxTurns: () => self.config.maxTurns,
    getTurnLevelThinking: () => self.config.turnLevelThinking,
    getPlanModeState: () => self.planModeState,
    getStreamRules: () => self.config.streamRules,
    getAgentReconnect: () => self.config.agentReconnect,
    getCwd: () => self.cwd,
    getSessionId: () => self.config.sessionId,
    setClientThinking: (mode) => { self.config.client.setThinking?.(mode) },
    flushMeridianTurn: () => { self.config.meridianIndexer?.flushTurn() },
    syncPlanModeToConfig: () => { self.syncPlanModeToConfig() },

    // === Session ===
    removeLastMessage: () => { self.session.removeLastMessage() },
    addUserMessage: (content) => { self.session.addUserMessage(content) },
    appendSystemReminder: (content) => { self.session.appendSystemReminder(content) },
    addAssistantBlocks: (blocks) => { self.session.addAssistantBlocks(blocks) },
    addUsage: (usage) => { self.session.addUsage(usage) },
    getEstimatedTokens: () => self.session.getEstimatedTokens(),
    getMessages: () => self.session.getMessages(),
    getTotalUsage: () => self.session.getTotalUsage(),
    getTurnCount: () => self.session.getTurnCount(),
    getCacheHistory: () => self.session.getCacheHistory(),

    // === Sub-processes (thin wrappers) ===
    runCompaction: (turn, snap) => self.compactBoundaryCoordinator.runCompaction(turn, snap),
    runPerception: (turn, estTokens, actionable, callbacks) => self.turnStepProducer.runPerception(turn, estTokens, actionable, callbacks),
    runConvergenceCheck: (turn, phaseClass, assistantResponded, userMessageConsumed, callbacks) =>
      self.runConvergenceCheck(turn, phaseClass, assistantResponded, userMessageConsumed, callbacks),
    runReplanCheck: () => { self.planTraceCoordinator.runReplanCheck() },
    buildTurnRequest: (turn, strategy, sensorium, pressureResult, assistantResponded, userMessageConsumed, callbacks) =>
      self.turnStepProducer.buildTurnRequest(turn, strategy, sensorium, pressureResult, assistantResponded, userMessageConsumed, callbacks),
    prewarmRecentReads: () => self.prewarmController.prewarmRecentReads(),
    runPostSession: (callbacks) => self.runPostSession(callbacks),
    recordProviderOutcome: (ok) => { self.recordProviderOutcome(ok) },

    // === Sub-controllers ===
    streamTurn: (params) => self.turnStream!.streamTurn(params),
    executeBatch: (params) => self.toolExecution.executeBatch(params),
    completeTurn: (params) => self.turnCompletion.complete(params),
    appendTurnResult: (turn) => { self.planTraceCoordinator.appendTurnResult(turn) },
    onCacheAdvisorTurnEnd: (params) => { self.cacheAdvisor.onTurnEnd(params) },

    // === Telemetry ===
    writeTelemetry: (entry) => { self.telemetryWriter.write(entry) },
    resetEvidence: () => { self.evidence.reset() },

    // === Abort signal ===
    getAbortSignal: () => self.abortController?.signal,

    // === Heartbeat (P7 watchdog) ===
    getHeartbeat: () => self._turnHeartbeat,

    // === Abort reason (watchdog vs user) ===
    getAbortReason: () => self.abortReason(),

    // === Resource sensor ===
    getLatestResourceSnapshot: () => self.latestResourceSnapshot,

    // === FsWatcher ===
    getFsWatcherState: () => self.fsWatcher?.getState() ?? { eventRate: 0, eventCount: 0, active: false },

    // === Per-run state (getter/setter view into AgentLoop fields) ===
    state: {
      get streamedText() { return self.streamedText },
      set streamedText(v) { self.streamedText = v },
      get lastPrewarmAt() { return self.lastPrewarmAt },
      set lastPrewarmAt(v) { self.lastPrewarmAt = v },
      get gitChangeRate() { return self.gitChangeRate },
      set gitChangeRate(v) { self.gitChangeRate = v },
      get turnBudget() { return self.turnBudget },
      set turnBudget(v) { self.turnBudget = v },
      get latestFsWatcherState() { return self.latestFsWatcherState },
      set latestFsWatcherState(v) { self.latestFsWatcherState = v },
      get consecutiveNoToolTurns() { return self.consecutiveNoToolTurns },
      set consecutiveNoToolTurns(v) { self.consecutiveNoToolTurns = v },
      get autoContinueCount() { return self.autoContinueCount },
      set autoContinueCount(v) { self.autoContinueCount = v },
      get thinkingOnlyRetries() { return self.thinkingOnlyRetries },
      set thinkingOnlyRetries(v) { self.thinkingOnlyRetries = v },
      get lastThinkingContent() { return self.lastThinkingContent },
      set lastThinkingContent(v) { self.lastThinkingContent = v },
      get lastTurnTextFingerprint() { return self.lastTurnTextFingerprint },
      set lastTurnTextFingerprint(v) { self.lastTurnTextFingerprint = v },
      get lastTurnThinkingFingerprint() { return self.lastTurnThinkingFingerprint },
      set lastTurnThinkingFingerprint(v) { self.lastTurnThinkingFingerprint = v },
      get recentTextFingerprints() { return self.recentTextFingerprints },
      set recentTextFingerprints(v) { self.recentTextFingerprints = v },
      get turnsSinceLastObjection() { return self.turnsSinceLastObjection },
      set turnsSinceLastObjection(v) { self.turnsSinceLastObjection = v },
      get traceStore() { return self.traceStore },
      set traceStore(v) { self.traceStore = v },
      get importGraph() { return self.importGraph },
      set importGraph(v) { self.importGraph = v },
      get lastConflictCheckCount() { return self.lastConflictCheckCount },
      set lastConflictCheckCount(v) { self.lastConflictCheckCount = v },
      get latestRisk() { return self.latestRisk },
      set latestRisk(v) { self.latestRisk = v },
      get thetaRequestsThisTurn() { return self.thetaRequestsThisTurn },
      set thetaRequestsThisTurn(v) { self.thetaRequestsThisTurn = v },
      get taskContract() { return self.taskContract },
      set taskContract(v) { self.taskContract = v },
    } as TurnStateBag,
    getMaxAutoContinue: () => self.config.maxAutoContinue ?? 0,
    getDoomLoopLevel: () => self.getDoomLoopLevel(),

    // === Sub-controllers ===
    goalContinuation: new GoalContinuationController({
      getGoalTracker: () => self.getGoalTracker(),
      getGoalJudgeDeps: () => {
        if (self.config.goalJudge?.enabled === false) return undefined
        const coordinator = self.config.coordinatorRef?.()
        if (!coordinator) return {}
        const browserMode = self.config.goalJudge?.browser === true
        return {
          spawnJudge: (objective, scope, signal) => coordinator.delegate({
            parentTurnId: 'goal:judge',
            objective,
            kind: 'verify',
            profile: 'goal_judge',
            scope,
          }, signal),
          browserMode,
        }
      },
      getGoalJudgeEvidence: () => {
        const state = self.evidence.getState()
        const modifiedFiles = [...state.filesModified]
        const readFiles = [...state.filesRead]
        const verifications = state.verifications.map(v =>
          `ran: ${v.command} → ${v.status} (${v.passed} passed, ${v.failed} failed, ${v.skipped} skipped)`)
        const text = [
          modifiedFiles.length > 0 ? `Modified files: ${modifiedFiles.join(', ')}` : '',
          readFiles.length > 0 ? `Read files (sample): ${readFiles.slice(0, 20).join(', ')}` : '',
          verifications.length > 0 ? `Verifications:\n${verifications.join('\n')}` : '',
        ].filter(Boolean).join('\n')

        const db = self.config.meridianIndexer?.getDb()
        const fullText = appendMeridianBlastRadius(text, modifiedFiles, db)
        return { text: fullText, modifiedFiles }
      },
      getStreamedText: () => self.streamedText,
      getEstimatedTokens: () => self.session.getEstimatedTokens(),
      getSessionId: () => self.config.sessionId,
      getCwd: () => self.cwd,
      appendSystemReminder: (content) => { self.session.appendSystemReminder(content) },
      completeTurn: (params) => self.turnCompletion.complete(params),
      writeTelemetry: (entry) => { self.telemetryWriter.write(entry) },
      flushMeridianTurn: () => { self.config.meridianIndexer?.flushTurn() },
    }),
    postTurnDecision: new PostTurnDecisionController({
      state: {
        get streamedText() { return self.streamedText },
        set streamedText(v) { self.streamedText = v },
        get thinkingOnlyRetries() { return self.thinkingOnlyRetries },
        set thinkingOnlyRetries(v) { self.thinkingOnlyRetries = v },
        get lastThinkingContent() { return self.lastThinkingContent },
        set lastThinkingContent(v) { self.lastThinkingContent = v },
        get autoContinueCount() { return self.autoContinueCount },
        set autoContinueCount(v) { self.autoContinueCount = v },
        get taskContract() { return self.taskContract },
        set taskContract(v) { self.taskContract = v },
      },
      getMaxAutoContinue: () => self.config.maxAutoContinue ?? 0,
      getDoomLoopLevel: () => self.getDoomLoopLevel(),
      appendSystemReminder: (content) => { self.session.appendSystemReminder(content) },
      completeTurn: (params) => self.turnCompletion.complete(params),
      getTotalUsage: () => self.session.getTotalUsage(),
      getTurnCount: () => self.session.getTurnCount(),
      // GLM independent reasoning: thinking-only turns are legitimate output,
      // not failed utterances. Skip retry to avoid wasting time on fresh reasoning.
      skipThinkingRetry: self.config.providerName === 'glm',
    }),
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

export function createPrewarmController(self: AgentLoop): PrewarmController {
  return new PrewarmController({
    getCwd: () => self.cwd,
    getPrewarmCache: () => self.prewarm,
    getRecentToolHistory: () => self.recentToolHistory,
  })
}

export function createModelRoutingShadowController(self: AgentLoop): ModelRoutingShadowController {
  return new ModelRoutingShadowController({
    getShadowEnabled: () => self.config.modelRoutingShadowEnabled,
    getDb: () => self.config.meridianIndexer?.getDb(),
    getTrajectoryEntries: () => self.trajectory.getEntries(),
    getModelCards: () => self.config.modelRoutingShadowModelCards ?? self.config.modelCards,
    getSessionId: () => self.config.sessionId,
    getTurnCount: () => self.session.getTurnCount(),
    getInitialUserMessage: () => self.initialUserMessage,
    getCurrentModel: () => self.config.getCurrentModel?.(),
    hasCurrentModelOverride: () => !!self.config.getCurrentModel,
    getFallbackModel: () => self.config.promptEngine.getModel(),
  })
}

export function createAntiAnchoringController(self: AgentLoop): AntiAnchoringController {
  return new AntiAnchoringController({
    getFingerprint: () => self.config.promptEngine.getFingerprint(),
    getModel: () => self.config.promptEngine.getModel(),
    getLastCycleClose: () => self.config.sessionRegistry?.getLastCycleClose(),
    getSessionId: () => self.config.sessionId,
    getAntiAnchoringConfig: () => self.config.antiAnchoring,
    streamClient: self.config.client,
    getAbortSignal: () => self.abortController?.signal,
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
