import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { ToolExecutionController, type ToolExecutionDeps, type ToolExecBatchInput } from '../tool-execution.js'
import { createPredictionAccumulator } from '../prediction-error.js'
import { createTurnBudget } from '../turn-budget.js'

/**
 * Regression guard for the dropped-abortSignal bug (root-cause analysis
 * 2026-06-05, Thread 2). executeBatch builds per-tool ToolPipelineDeps in two
 * branches (parallel `makeDeps` for concurrency-safe tools, sequential
 * `pipelineDeps` for non-safe tools). Both MUST copy input.abortSignal into
 * deps.abortSignal — otherwise delegate_task passes undefined to the coordinator
 * and the entire abort path becomes dead code, causing worker hangs ("No
 * response 3m") and orphaned detached children.
 *
 * The tool receives the signal as params.abortSignal (tool-pipeline.ts:399), so
 * a mock registry capturing params.abortSignal proves the whole chain.
 */
describe('ToolExecutionController abort-signal threading', () => {
  function makeController(captured: { signal?: AbortSignal | undefined }, concurrencySafe: boolean) {
    const deps = {
      config: {
        toolRegistry: {
          execute: async (_name: string, params: any) => {
            captured.signal = params.abortSignal
            return { content: 'ok', isError: false }
          },
          get: () => ({
            definition: { input_schema: {} },
            isConcurrencySafe: () => concurrencySafe,
            timeoutMs: () => 5000,
          }),
          needsApproval: () => false,
        },
        hooks: null,
        lspEnabled: false,
        contextClaimStore: undefined,
        sessionId: 'test-session',
        contextWindow: 200_000,
        promptEngine: { setStrategyShift: () => {}, setImpactHint: () => {} },
      },
      cwd: '/tmp/test',
      harness: {
        executeTool: async ({ execute }: any) => {
          const r = await execute()
          return { content: r.content, isError: r.isError ?? false, retried: false }
        },
      },
      prewarm: { get: () => null, invalidate: () => {} },
      evidence: {
        getState: () => ({ filesModified: new Set<string>() }),
        trackFileRead: () => {}, trackFileModified: () => {},
      },
      repairHintTracker: { recordSuccess: () => {}, recordFailure: () => {} },
      repairPipeline: { run: (input: any) => ({ output: input, telemetry: [] }) },
      runtimeHooks: { runPostTool: async () => {} },
      contextInjection: { setCerebellarHint: () => {}, clearCerebellarHint: () => {} },
      trajectory: { getEntries: () => [] },
      getPredictionAccumulator: () => createPredictionAccumulator(),
      setPredictionAccumulator: () => {},
      getVigorState: () => ({}),
      setVigorState: () => {},
      getDoomLoopLevel: () => 'none' as const,
      getSessionTurnCount: () => 1,
      getSessionId: () => 'test-session',
      addToolResults: () => {},
      recordToolHistory: () => {},
      buildRuntimeSnapshot: () => ({}),
      requestThetaCheck: () => {},
      getAutoReasoning: () => false,
      getReasoningEffort: () => undefined,
      setClientReasoningEffort: () => {},
      getSensorium: () => null,
      getReliabilityDecision: () => null,
      getTurnBudget: () => createTurnBudget(0),
    } as unknown as ToolExecutionDeps
    return new ToolExecutionController(deps)
  }

  function makeInput(signal: AbortSignal): ToolExecBatchInput {
    return {
      toolUses: [{ id: 't1', name: 'demo_tool', input: {} }],
      callbacks: { onToolResult: () => {} } as any,
      turn: 1,
      checkpointCreatedThisTurn: false,
      abortSignal: signal,
      traceStore: { events: [], toolFingerprints: [] } as any,
      importGraph: null,
      lastConflictCheckCount: 0,
      latestRisk: { level: 'none', reasons: [], suggestedAction: '' } as any,
    }
  }

  it('threads input.abortSignal into the parallel (concurrency-safe) tool path', async () => {
    const captured: { signal?: AbortSignal | undefined } = {}
    const controller = makeController(captured, true)
    const ac = new AbortController()
    await controller.executeBatch(makeInput(ac.signal))
    assert.equal(captured.signal, ac.signal, 'safe-tool path must forward the batch abortSignal, not undefined')
  })

  it('threads input.abortSignal into the sequential (non-safe) tool path', async () => {
    const captured: { signal?: AbortSignal | undefined } = {}
    const controller = makeController(captured, false)
    const ac = new AbortController()
    await controller.executeBatch(makeInput(ac.signal))
    assert.equal(captured.signal, ac.signal, 'non-safe-tool path must forward the batch abortSignal, not undefined')
  })
})
