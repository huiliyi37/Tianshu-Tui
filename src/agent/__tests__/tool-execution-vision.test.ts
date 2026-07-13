import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { ToolExecutionController, type ToolExecutionDeps, type ToolExecBatchInput } from '../tool-execution.js'
import { createPredictionAccumulator } from '../prediction-error.js'
import { createTurnBudget } from '../turn-budget.js'
import { TurnCacheObservability } from '../cache-log-observability.js'

/**
 * Vision channel contract (Computer Use Wave B): when a batch's ToolResults
 * carry `images` (data URLs), the batch layer forwards them as ONE trailing
 * multimodal user message AFTER addToolResults — and only when the active
 * model declares supportsVision. Text-only models must observe byte-identical
 * behavior to the pre-vision pipeline (images silently dropped).
 */
describe('ToolExecutionController vision-channel injection', () => {
  interface Captured {
    injected: Array<{ text: string; images: string[] }>
    events: string[]
    uiPayloads?: unknown[][]
    sanitized?: Array<{ raw: string; sanitized: string; filterId?: string }>
    observability?: TurnCacheObservability
  }

  function makeController(
    captured: Captured,
    opts: { supportsVision: boolean; images?: string[]; wireInjector?: boolean; throwRegistryGetOnce?: boolean },
  ) {
    let throwRegistryGet = opts.throwRegistryGetOnce ?? false
    const deps = {
      config: {
        toolRegistry: {
          execute: async () => ({ content: 'Accessibility tree for Safari', isError: false, images: opts.images }),
          get: () => {
            if (throwRegistryGet) {
              throwRegistryGet = false
              throw new Error('tool pipeline exploded')
            }
            return {
              definition: { input_schema: {} },
              isConcurrencySafe: () => false,
              timeoutMs: () => 5000,
            }
          },
          needsApproval: () => false,
          resolveName: (n: string) => n,
        },
        hooks: null,
        lspEnabled: false,
        contextClaimStore: undefined,
        sessionId: 'test-session',
        contextWindow: 200_000,
        promptEngine: { getModel: () => 'test-model' },
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
      addToolResults: () => { captured.events.push('addToolResults') },
      getSupportsVision: () => opts.supportsVision,
      addUserMessageWithImages: opts.wireInjector === false
        ? undefined
        : (text: string, images: string[]) => {
            captured.events.push('inject')
            captured.injected.push({ text, images })
          },
      recordToolHistory: () => {},
      buildRuntimeSnapshot: () => ({}),
      requestThetaCheck: () => {},
      getAutoReasoning: () => false,
      getReasoningEffort: () => undefined,
      setClientReasoningEffort: () => {},
      getSensorium: () => null,
      getReliabilityDecision: () => null,
      getTurnBudget: () => createTurnBudget(0),
      beginToolBatchObservability: (measured: boolean) => {
        captured.events.push('observe-begin')
        captured.observability?.beginToolBatch(measured)
      },
      recordSanitizedOutput: (raw: string, sanitized: string, filterId?: string) => {
        captured.sanitized?.push({ raw, sanitized, filterId })
        captured.observability?.recordSanitizedOutput(raw, sanitized, filterId)
      },
      recordToolUiEvent: () => {
        captured.events.push('observe-ui')
        captured.observability?.recordToolUiEvent()
      },
      endToolBatchObservability: () => {
        captured.events.push('observe-end')
        captured.observability?.endToolBatch()
      },
    } as unknown as ToolExecutionDeps
    return new ToolExecutionController(deps)
  }

  function makeInput(captured?: Captured): ToolExecBatchInput {
    return {
      toolUses: [{ id: 't1', name: 'computer_use', input: { action: 'snapshot', app: 'Safari' } }],
      callbacks: { onToolResult: (...args: unknown[]) => { captured?.uiPayloads?.push(args) } } as any,
      turn: 1,
      checkpointCreatedThisTurn: false,
      abortSignal: new AbortController().signal,
      traceStore: { events: [], toolFingerprints: [] } as any,
      importGraph: null,
      lastConflictCheckCount: 0,
      latestRisk: { level: 'none', reasons: [], suggestedAction: '' } as any,
    }
  }

  const IMG = 'data:image/png;base64,AAAA'

  it('supportsVision=true → images forwarded as one trailing user message after addToolResults', async () => {
    const captured: Captured = { injected: [], events: [] }
    const controller = makeController(captured, { supportsVision: true, images: [IMG] })
    await controller.executeBatch(makeInput())
    assert.equal(captured.injected.length, 1)
    assert.deepEqual(captured.injected[0]!.images, [IMG])
    assert.match(captured.injected[0]!.text, /<system-reminder>/)
    assert.match(captured.injected[0]!.text, /computer_use/)
    assert.deepEqual(captured.events, ['observe-begin', 'observe-ui', 'addToolResults', 'inject', 'observe-end'], 'append-only: injection strictly after tool results')
  })

  it('supportsVision=false → images silently dropped (legacy behavior)', async () => {
    const captured: Captured = { injected: [], events: [] }
    const controller = makeController(captured, { supportsVision: false, images: [IMG] })
    await controller.executeBatch(makeInput())
    assert.equal(captured.injected.length, 0)
    assert.deepEqual(captured.events, ['observe-begin', 'observe-ui', 'addToolResults', 'observe-end'])
  })

  it('no images in the batch → no injection even for vision models', async () => {
    const captured: Captured = { injected: [], events: [] }
    const controller = makeController(captured, { supportsVision: true, images: undefined })
    await controller.executeBatch(makeInput())
    assert.equal(captured.injected.length, 0)
  })

  it('caps forwarded images at the 2 most recent', async () => {
    const captured: Captured = { injected: [], events: [] }
    const imgs = ['data:image/png;base64,ONE', 'data:image/png;base64,TWO', 'data:image/png;base64,THREE']
    const controller = makeController(captured, { supportsVision: true, images: imgs })
    await controller.executeBatch(makeInput())
    assert.equal(captured.injected.length, 1)
    assert.deepEqual(captured.injected[0]!.images, ['data:image/png;base64,TWO', 'data:image/png;base64,THREE'])
  })

  it('missing injector hook → degrades to drop without throwing', async () => {
    const captured: Captured = { injected: [], events: [] }
    const controller = makeController(captured, { supportsVision: true, images: [IMG], wireInjector: false })
    await controller.executeBatch(makeInput())
    assert.equal(captured.injected.length, 0)
  })

  it('counts tool UI events and observes sanitizer results without changing callback payloads', async () => {
    const captured: Captured = { injected: [], events: [], uiPayloads: [], sanitized: [] }
    const controller = makeController(captured, { supportsVision: false })
    await controller.executeBatch(makeInput(captured))

    assert.equal(captured.uiPayloads?.length, 1)
    assert.deepEqual(captured.uiPayloads?.[0], [
      't1',
      'computer_use',
      'Accessibility tree for Safari',
      false,
      undefined,
      undefined,
    ])
    assert.deepEqual(captured.sanitized, [{
      raw: 'Accessibility tree for Safari',
      sanitized: 'Accessibility tree for Safari',
      filterId: undefined,
    }])
  })

  it('finalizes a failed batch before attributing the next batch', async () => {
    const observability = new TurnCacheObservability()
    const captured: Captured = { injected: [], events: [], observability }
    const controller = makeController(captured, {
      supportsVision: false,
      throwRegistryGetOnce: true,
    })

    await assert.rejects(controller.executeBatch(makeInput()), /tool pipeline exploded/)
    assert.deepEqual(observability.consumeForRequest(), {
      outputRawBytes: 0,
      outputTrimmedBytes: 0,
      outputFilterIds: [],
      toolUiEvents: 0,
    })

    await controller.executeBatch(makeInput())
    assert.deepEqual(observability.consumeForRequest(), {
      outputRawBytes: Buffer.byteLength('Accessibility tree for Safari'),
      outputTrimmedBytes: 0,
      outputFilterIds: [],
      toolUiEvents: 1,
    })
  })
})
