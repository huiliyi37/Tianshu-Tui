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
import { isSystemReminder } from '../prompt/system-reminder.js'

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
