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
import { setGeneralLedgerTelemetrySink } from './general-ledger.js'
import { buildPrewarmValue, batchPrewarm } from './prewarm-file.js'
import { recordToolNamedFingerprint } from './trace-store.js'
import { classifyActivityMode } from './convergence-detector.js'
import { join, isAbsolute } from 'node:path'
import { analyzeImpact } from '../repo/meridian-impact.js'
import { getSessionDir } from './session-persist.js'
import type { AgentCallbacks } from './loop-types.js'
import { diagnoseCacheMiss } from '../prompt/cache-diagnostic.js'
import { computeCompactAttribution } from './compact-attribution.js'
import { isCostInsensitiveProvider } from '../api/cost-model.js'
import { isSystemReminder } from '../prompt/system-reminder.js'
import { getReadRefStats, invalidateSessionReadDedup } from '../tools/read-file.js'
import { PlanTraceCoordinator } from './plan-trace-coordinator.js'
import { CompactBoundaryCoordinator, DEFAULT_QUALITY_COMPACT_THRESHOLDS } from './compact-boundary-coordinator.js'
import { TurnOrchestrator, type TurnStateBag } from './turn-orchestrator.js'
import { GoalContinuationController } from './goal-continuation.js'
import { PostTurnDecisionController } from './post-turn-decision.js'
import { ReasoningEffortController } from './reasoning-effort-controller.js'
import { buildGatedInfluenceAuditEvent, persistGatedInfluenceAudit } from './gated-influence-audit.js'
import { loadProjectRules } from '../context/rules-loader.js'
import { IntentRetrievalRouteController } from './intent-retrieval-route-controller.js'
import { AntiAnchoringController } from './anti-anchoring-controller.js'
import { ModelRoutingShadowController } from './model-routing-shadow-controller.js'
import { PrewarmController } from './prewarm-controller.js'
import { TurnStepProducer } from './turn-step-producer.js'
import { skillRegistry } from '../skills/skill-loader.js'
import type { Usage } from '../api/types.js'

/**
 * Side-path usage accounting (2026-07-06 cost blind spot fix): side-path
 * requests (llm-speculation, compaction summaries) are billed like any other
 * call but used to discard their usage in `onStopReason: () => {}` — invisible
 * in session totals, meta tokenUsage, and the cache-log. This recorder gives
 * them a shared sink:
 *   - accumulates into session totals via addSidePathUsage (no occupancy-
 *     anchor pollution — see SessionContext.addSidePathUsage)
 *   - appends an `event: 'side_path'` line to the cache-log, distinct from
 *     main-turn entries so turn-sequence analysis stays clean
 * Never consumes the engine/wire divergence probes — those belong to main turns.
 */
export function createSidePathUsageRecorder(self: AgentLoop): (kind: string, usage: Partial<Usage>, model?: string) => void {
  return (kind, usage, model) => {
    try {
      if (!usage.input_tokens && !usage.output_tokens) return
      self.session.addSidePathUsage(usage)
      const input = usage.input_tokens ?? 0
      const hitRate = input > 0
        ? ((usage.cache_read_input_tokens ?? 0) / input * 100).toFixed(1)
        : '0.0'
      const line = JSON.stringify({
        event: 'side_path',
        kind,
        t: Date.now(),
        model: model ?? self.config.promptEngine.getModel(),
        input,
        cacheRead: usage.cache_read_input_tokens ?? 0,
        cacheCreate: usage.cache_creation_input_tokens ?? 0,
        output: usage.output_tokens ?? 0,
        hitRate: `${hitRate}%`,
      })
      const sid = self.config.sessionId ?? 'anon'
      import('node:fs/promises').then(fs => {
        const dir = join(getSessionDir(self.cwd), sid)
        return fs.mkdir(dir, { recursive: true })
          .then(() => fs.appendFile(join(dir, 'cache-log.jsonl'), line + '\n'))
      }).catch(() => {})
    } catch { /* accounting is best-effort — never break the side path */ }
  }
}

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
      // 4e1aaa21 post-mortem: aborted attempts silently discarded minutes of
      // streamed reasoning. Record each failure in the cache-log so the loss
      // is attributable without reverse-engineering timestamp gaps.
      recordStreamAttemptAborted: info => {
        const sid = self.config.sessionId ?? 'anon'
        const line = JSON.stringify({
          event: 'stream_attempt_aborted',
          t: Date.now(),
          model: self.config.promptEngine.getModel(),
          provider: info.provider,
          receivedChars: info.receivedChars,
          elapsedMs: info.elapsedMs,
          errorName: info.errorName,
          errorMessage: info.errorMessage.slice(0, 300),
        })
        import('node:fs/promises').then(fs => {
          const dir = join(getSessionDir(self.cwd), sid)
          return fs.mkdir(dir, { recursive: true })
            .then(() => fs.appendFile(join(dir, 'cache-log.jsonl'), line + '\n'))
        }).catch(() => {})
      },
      recordTurnCache: (turn, usage, streamObservability) => {
        self.session.recordTurnCache(turn, usage)
        const hitRateNum = usage.input_tokens > 0
          ? (usage.cache_read_input_tokens ?? 0) / usage.input_tokens * 100
          : 0
        const hitRate = hitRateNum.toFixed(1)
        const sid = self.config.sessionId ?? 'anon'

        // ── P2-6 breadcrumbs: make every break attributable in one read ──
        const observability = self.turnCacheObservability.consumeForRequest(streamObservability)
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
          ...observability,
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

          // Prefix-divergence probe (2026-07-05 cache investigation): when the
          // request was NOT a pure append over the previous one, record which
          // message diverged. Joined with cacheRead regressions this separates
          // client-side byte changes from provider-side落盘 failures.
          const divergence = self.config.promptEngine.consumePrefixDivergence?.()
          if (divergence) entry.prefixDiverged = divergence

          // Wire-level probe (2026-07-06): same idea, but hashed on the FINAL
          // send bytes (post reasoning-strip / sanitize / system-suffix). A
          // cacheRead regression with a clean engine probe but a wireDiverged
          // record = send-layer byte churn; clean on both = provider-side.
          const wireDivergence = self.config.client.consumeWireDivergence?.()
          if (wireDivergence) entry.wireDiverged = wireDivergence

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
      completeEffortShadow: (id, input) => self.p3?.completeEffortShadow(id, input),
      saveEffortShadowRow: (kind, json) => {
        try { self.config.meridianIndexer?.getDb()?.saveBanditState(kind, json) } catch { /* append-only evidence — never disrupt turn */ }
      },
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
      // Vision channel (computer_use screenshots → model). Capability comes from
      // the per-model config flag; switchModel rebuilds the loop so it tracks
      // the active model. Injection is tail-append via addUserMessage (multimodal
      // parts) — the same append-only boundary the steer path uses.
      getSupportsVision: () => self.config.supportsVision ?? false,
      addUserMessageWithImages: (text, images) => { self.session.addUserMessage(text, images) },
      recordToolHistory: (name, input, isError, content, errorClass) => self.recordToolHistory(name, input, isError, content, errorClass),
      onLeaveMark: mark => self.captureLeaveMark(mark),
      onPlanSteps: steps => self.capturePlanSteps(steps),
      onPlanClosed: input => self.handlePlanClosed(input),
      onPlanSubmitted: info => self.onPlanApprovalRequested?.(info),
      onAskUserQuestion: info => self.onAskUserQuestionRequested?.(info),
      assessDelivery: self.config.deliveryGateV2
        ? files => self.config.deliveryGateV2!(files)
        : undefined,
      enterPlanMode: () => {
        const alreadyPlanning = self.getPlanModeState() === 'planning'
        if (!alreadyPlanning) self.enterPlanMode()
        return { activePlanFilePath: self.getActivePlanFilePath(), alreadyPlanning }
      },
      getVerificationEvidence: () => self.evidence.getVerificationSummary(),
      onSkillInvoked: name => self.config.promptEngine.markSkillInvoked(name),
      onSkillCompleted: name => self.config.promptEngine.markSkillCompleted(name),
      buildRuntimeSnapshot: extra => self.buildRuntimeSnapshot(extra),
      requestThetaCheck: reason => { self.requestThetaCheck(reason) },
      getAutoReasoning: () => self.config.autoReasoning ?? false,
      getReasoningEffort: () => self.config.reasoningEffort,
      setClientReasoningEffort: effort => { self.setReasoningEffort(effort) },
      getSensorium: () => self.sensorium,
      getReliabilityDecision: () => self.latestReliabilityDecision,
      getTurnBudget: () => self.turnBudget,
      artifactStore: self.artifactStore,
      getJobs: () => self.jobs,
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
      destructiveGate: self.destructiveGate,
      onGateBlocked: kind => { self.gateBlockedKinds.push(kind) },
      onTddBlocked: (target?: string) => {
        if (!target) return
        const count = (self.tddBlockedTargets.get(target) ?? 0) + 1
        self.tddBlockedTargets.set(target, count)
        if (count >= 3) {
          self.advisoryBus.submit({
            key: `tdd-same-target:${target}`,
            priority: 0.45,
            category: 'discipline',
            content: `同一文件 ${target} 已被 TDD gate 拦截 ${count} 次——确认你是否在反复尝试同一修改而没先跑测试。先运行相关测试定位问题，再回来改。`,
            ttl: 1,
          })
        }
      },
      writeTelemetry: (record) => { self.telemetryWriter.write(record) },
      beginToolBatchObservability: measured => { self.turnCacheObservability.beginToolBatch(measured) },
      recordSanitizedOutput: (raw, sanitized, filterId) => {
        self.turnCacheObservability.recordSanitizedOutput(raw, sanitized, filterId)
      },
      recordToolUiEvent: () => { self.turnCacheObservability.recordToolUiEvent() },
      endToolBatchObservability: () => { self.turnCacheObservability.endToolBatch() },
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
      touchedUiFiles: self.touchedUiFiles,
      sawVisualVerify: self.sawVisualVerify,
      lastThinkingLength: self.lastThinkingContent.length || undefined,
      lastTurnHadTools: self.recentToolHistory.some(h => h.status === 'success') || undefined,
      ...extra,
    }
}

/**
 * Phase 3 副驾的 cheap completion（懒初始化,进程内缓存）。
 * 优先 workers.profiles.cheap 的独立 StreamClient（不与主会话争 socket）;
 * 无 cheap profile 或构建失败 → resolve null（副驾休眠,绝不回退主模型——
 * 副驾建议不值得花主模型的钱和延迟）。
 */
function buildLazyCopilotCompletion(self: AgentLoop): (system: string, user: string) => Promise<string | null> {
  let completionPromise: Promise<((system: string, user: string, signal?: AbortSignal) => Promise<string>) | null> | undefined
  return async (system, user) => {
    completionPromise ??= (async () => {
      try {
        const { buildCheapClient, completionFromClient } = await import('./goal-criteria.js')
        const { loadConfig } = await import('../config/manager.js')
        const cfg = await loadConfig()
        const cheapProfile = cfg.workers?.profiles?.cheap
        const allProviders = self.config.allProviders ?? {}
        if (!cheapProfile || !allProviders[cheapProfile.provider]) return null
        const cheap = buildCheapClient(cheapProfile, allProviders)
        return cheap ? completionFromClient(cheap.client, cheap.model) : null
      } catch {
        return null
      }
    })()
    const completion = await completionPromise
    if (!completion) return null // 基础设施缺失 → hook 永久休眠
    // 单次调用失败向上抛（hook catch 后静默跳过本次,不算基础设施不可用）
    return completion(system, user)
  }
}

export function createRuntimeHooksPipeline(self: AgentLoop): RuntimeHookPipeline {
  // 将星账本遥测（Y8）：读/写事件落 sensorium.jsonl 同通道，让「账本是否在被
  // 使用、哪个星在生长」可观测。模块级 sink——worker prompt 合并与工具读写共用。
  setGeneralLedgerTelemetrySink(event => self.telemetryWriter.write({ ...event }))
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
    virtuePendingLedger: self.virtuePendingLedger,
    getCurrentSeason: () => self.currentSeason ?? 'genesis',
    getCurrentSeasonIntensity: () => self.currentSeasonIntensity ?? 1.0,
    getRecentCacheHitRate: () => self.session.getRecentTurnHitRate(3),
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
    // 让位判据解耦：shouldKick 在卡住期间恒 true 但发射被冷却节流——只有
    // convergence 真实发射过（相邻轮）才压制 CCR/kick，避免冷却静默期陪葬。
    wasConvergenceTriggered: () =>
      (self.latestConvergenceResult?.shouldKick ?? false) && self.wasConvergenceEmittedRecently(),
    telemetryWriter: self.telemetryWriter,
    // Phase 0 观测：CCR 触发落遥测（sensorium.jsonl 同通道）+ guardian 计数。
    // 此前 onCcrTrigger 无生产接线 — 触发频次不可观测，静音只能靠体感发现。
    onCcrTrigger: event => {
      self.guardianActivity.ccr += 1
      self.telemetryWriter.write({
        kind: 'ccr-trigger',
        rule: event.rule,
        star: event.star,
        turn: event.turn,
        principleKey: event.principleKey,
        dynamicPool: event.dynamicPool,
        dimValues: event.dimValues,
      })
    },
    // P1a 核销闭环：advisory 采纳核销器 + 会话累计采纳/忽略同步到 guardian meta。
    advisoryReadback: self.advisoryReadback,
    onAdvisoryOutcomes: totals => self.recordAdvisoryOutcomes(totals),
    // Phase 3 异步副驾：cheap client 懒初始化（首次触发才 loadConfig/建连接）。
    // 构建失败 resolve null → hook 永久休眠,不影响主链路。
    asyncCopilot: {
      getContext: () => ({
        objective: self.taskContract?.objective ?? null,
        starDomain: self.sessionDomain?.name ?? null,
      }),
      complete: buildLazyCopilotCompletion(self),
    },
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
    // 缺口 C/D:run 轮数 / 用户输入轮 / 意图复合源 / maxTurns 预算
    getRunTurn: () => self.runLoopTurn,
    getLastUserInputRunTurn: () => self.lastUserInputRunTurn,
    getIntentObjective: () => self.taskContract?.objective ?? self.initialUserMessage?.slice(0, 500) ?? null,
    getMaxTurns: () => self.config.maxTurns,
    addSystemReminder: content => { self.session.appendSystemReminder(content) },
    // W5 (render-verify): check if browser/computer_use are registered for capability degradation.
    // browser_debug 是渲染验证主工具（CORE since 2026-07-15），必须计入——否则它可用时
    // 仍会走「缺少视觉验证工具」降级文案。
    getVisualToolsAvailable: () =>
      self.config.toolRegistry.has('browser_debug') ||
      self.config.toolRegistry.has('browser') ||
      self.config.toolRegistry.has('computer_use'),
    // computer_use 任务感知自动挂载（2026-07-15）：会话早期检测桌面 GUI 意图。
    computerUseMount: {
      getUserIntent: () => self.taskContract?.objective ?? self.initialUserMessage?.slice(0, 500) ?? null,
      enableTool: (name: string) => self.enableTool(name),
    },
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
      // Predictions feed ONLY the prewarm cache (mtime+size validated at
      // consume time). The ShadowQueue enqueue was removed with the 2026-07-07
      // speculative-chain seal — see P3Config.speculativeEnabled.
      onPredictions: batch => {
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
      // Mid-session rules reload: newly generated .rivet/rules/*.md enter the
      // claim store immediately (propose is idempotent by claim id) instead of
      // waiting for the next bootstrap. Claims flow into the prompt via the
      // refreshActiveClaims → updateActiveClaims channel, not frozenBase.
      onRuleGenerated: () => {
        const store = self.config.contextClaimStore
        if (!store) return
        try {
          for (const rule of loadProjectRules(self.cwd)) store.propose(rule)
        } catch { /* rules reload is best-effort */ }
      },
    },
    userHooksBridge: userBridgeDeps,
    advisoryBus: self.advisoryBus,
    getJobs: () => self.jobs,
    sycophancyTrap: self.sycophancyTrap,
    getEstimatedTokens: () => self.session.getEstimatedTokens(),
    getContextWindow: () => self.config.contextWindow ?? 128_000,
    // W2 被拦不弃守护：drain 语义（读取即清零 turn 级计数）。
    drainGateBlockedKinds: () => self.gateBlockedKinds.splice(0),
    // 多会话隔离：todo-reminder 经此读本会话 TodoStore（缺省回退全局 getTodos）。
    getTodos: self.config.getTodos,
    // 运行走查工件（付费版 v1 · T1）：computer_use 步骤时间线 → walkthrough 工件。
    walkthrough: {
      getArtifactStore: () => self.artifactStore,
      sessionId: self.config.sessionId,
    },
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
      // Stale-round / diet / heap micro-compact rewrite history WITHOUT going
      // through CompactionController.safeReplaceMessages — invalidate read-dedup
      // here too, or read-ref keeps claiming "回看上文" at deleted tool_results.
      invalidateSessionReadDedup(self.config.sessionId)
    },
    dietMessages: msgs => self.p3.dietMessages(msgs),
    trySessionSplit: () => self.compaction.trySessionSplit(),
    maybeCompact: opts => self.compaction.maybeCompact(opts),
    tryPartialCompact: target => self.compaction.tryPartialCompact(target),
    shouldDelayCompact: (threshold, ctx) => self.cacheAdvisor.shouldDelayCompact(threshold, ctx?.estimatedTokens !== undefined && ctx?.contextWindow !== undefined ? { estimatedTokens: ctx.estimatedTokens, contextWindow: ctx.contextWindow } : undefined),
    getStalePreviewChars: () => self.cacheAdvisor.getStalePreviewChars(),
    shouldOpportunisticCompact: () => self.cacheAdvisor.shouldOpportunisticCompact(),
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

/** Input snapshot for the autonomy progress digest (C3). */
export interface ProgressDigestInput {
  turns: number
  filesModified: string[]
  recentTools: Array<{ tool: string; target: string; status: 'success' | 'failed' | 'running' }>
  usage: { input_tokens: number; output_tokens: number }
  todos?: Array<{ content: string; status: string }>
}

function formatTokenCount(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)
}

/**
 * C3 — human-readable progress digest shown at autonomy checkpoints (cruise
 * pause card) and progress pings (unleashed broadcast). Pure function: all
 * data comes from the snapshot so it is unit-testable without an AgentLoop.
 */
export function buildProgressDigest(input: ProgressDigestInput): string {
  const lines: string[] = [`已执行 ${input.turns} 轮。`]

  if (input.filesModified.length > 0) {
    const shown = input.filesModified.slice(0, 8)
    const more = input.filesModified.length - shown.length
    lines.push(`修改文件 (${input.filesModified.length})：${shown.join(', ')}${more > 0 ? ` (+${more} more)` : ''}`)
  } else {
    lines.push('修改文件：无')
  }

  if (input.recentTools.length > 0) {
    const items = input.recentTools.slice(-5).map(t => {
      const icon = t.status === 'failed' ? '✗' : t.status === 'running' ? '…' : '✓'
      return `${t.tool} ${t.target} ${icon}`.trim()
    })
    lines.push(`最近工具：${items.join(' · ')}`)
  }

  if (input.todos && input.todos.length > 0) {
    const done = input.todos.filter(t => t.status === 'completed').length
    const inProgress = input.todos.find(t => t.status === 'in_progress')
    let todoLine = `任务进度：${done}/${input.todos.length} 完成`
    if (inProgress) todoLine += `，进行中：${inProgress.content}`
    lines.push(todoLine)
  }

  lines.push(`Token：输入 ${formatTokenCount(input.usage.input_tokens)} / 输出 ${formatTokenCount(input.usage.output_tokens)}`)
  return lines.join('\n')
}

export function createTurnOrchestrator(self: AgentLoop): TurnOrchestrator {
  // Tier 2 LLM speculation: SEALED with the speculative chain (2026-07-07).
  // The engine's only consumer was the ShadowQueue pre-execution path; with
  // serving cut (2026-07-06 stale-read incident) and enqueue gated off, an
  // opted-in engine would burn side-path LLM calls for nothing. The engine
  // module + unit tests stay; `speculateDuringBatch` is simply never injected
  // (orchestrator's optional call stays a no-op). Do NOT reconstruct it until
  // the re-enable contract in P3Config.speculativeEnabled is met.
  return new TurnOrchestrator({
    // === Lifecycle ===
    initializeRun: (userInput, callbacks, images) => self.turnStepProducer.initializeRun(userInput, callbacks, images),
    stopFsWatcher: () => { self.stopFsWatcher() },

    // === Config ===
    getMaxTurns: () => self.config.maxTurns,
    // C3 — checkpoint brake applies only to auto-safe mode (high-risk tools
    // still need human approval). YOLO and manual modes get 0 (no brake).
    // Read live so a mid-session approval-mode switch takes effect.
    getCheckpointEveryTurns: () => self.config.approvalMode === 'auto-safe'
      ? (self.config.checkpointEveryTurns ?? 0)
      : 0,
    buildProgressDigest: (turns) => buildProgressDigest({
      turns,
      filesModified: [...self.evidence.getState().filesModified],
      recentTools: self.recentToolHistory.slice(-5),
      usage: self.session.getTotalUsage(),
      todos: self.config.getTodos?.(),
    }),
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

    // === Stop-reason 落盘（2026-07-07 观测缺口修复）===
    recordStopReason: (r) => { self.recordStopReason(r) },

    // === Advisory 总线（action-intent 闸门核销接入）===
    submitAdvisory: (entry) => { self.advisoryBus.submit(entry) },

    // === W3 诊断态识别 ===
    getActivityMode: () => classifyActivityMode(
      self.recentToolHistory,
      self.evidence.getState().filesModified.size,
    ),

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
      get wedgeToolFingerprint() { return self.wedgeToolFingerprint },
      set wedgeToolFingerprint(v) { self.wedgeToolFingerprint = v },
      get wedgeRepeatCount() { return self.wedgeRepeatCount },
      set wedgeRepeatCount(v) { self.wedgeRepeatCount = v },
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
      get runLoopTurn() { return self.runLoopTurn },
      set runLoopTurn(v) { self.runLoopTurn = v },
    } as TurnStateBag,
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
      },
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
    persistAudit: input => {
      const db = self.config.meridianIndexer?.getDb()
      if (!db) return
      persistGatedInfluenceAudit(db, buildGatedInfluenceAuditEvent({
        source: 'effort_bandit',
        sessionId: self.config.sessionId ?? 'unknown',
        targetId: `turn_${self.session.getTurnCount()}`,
        gateOpen: input.gateOpen,
        applied: input.applied,
        reason: input.reason,
        evidenceWindow: input.evidenceWindow,
      }))
    },
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
