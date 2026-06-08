import type { AgentLoop } from './loop.js'
import { TurnStreamController } from './turn-stream.js'
import { TurnCompletionController } from './turn-completion.js'
import { ToolExecutionController } from './tool-execution.js'
import type { RuntimeHookSnapshot } from './runtime-hooks.js'
import { createRuntimeHookContext } from './runtime-hooks.js'
import { buildPrewarmValue } from './prewarm-file.js'
import { join } from 'node:path'
import type { AgentCallbacks } from './loop-types.js'

export function createTurnStreamController(self: AgentLoop): TurnStreamController {
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
        const hitRate = usage.input_tokens > 0
          ? ((usage.cache_read_input_tokens ?? 0) / usage.input_tokens * 100).toFixed(1)
          : '0.0'
        const sid = self.config.sessionId ?? 'anon'
        const line = JSON.stringify({ t: Date.now(), turn, input: usage.input_tokens, cacheRead: usage.cache_read_input_tokens, cacheCreate: usage.cache_creation_input_tokens, hitRate: `${hitRate}%` })
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
      getEstimatedTokens: () => self.session.getEstimatedTokens(),
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
