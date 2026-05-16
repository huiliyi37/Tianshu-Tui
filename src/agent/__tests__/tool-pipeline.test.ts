import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { executeToolUse, type ToolPipelineDeps } from '../tool-pipeline.js'

describe('executeToolUse', () => {
  function makeDeps(overrides?: Partial<ToolPipelineDeps>): ToolPipelineDeps {
    return {
      config: {
        toolRegistry: {
          execute: async () => ({ content: 'ok', isError: false }),
          get: () => ({ definition: { input_schema: {} }, isConcurrencySafe: () => false }),
          needsApproval: () => false,
        },
        hooks: null,
        lspEnabled: false,
        fileHistory: undefined,
        contextClaimStore: undefined,
        sessionId: 'test-session',
        promptEngine: { setStrategyShift: () => {}, setImpactHint: () => {} },
      } as any,
      cwd: '/tmp/test',
      harness: {
        executeTool: async ({ execute }: any) => {
          const r = await execute()
          return { content: r.content, isError: r.isError ?? false, retried: false }
        },
      } as any,
      prewarm: { get: () => null, invalidate: () => {} } as any,
      evidence: { trackFileRead: () => {}, trackFileModified: () => {}, trackImpact: () => {}, trackVerification: () => {} } as any,
      traceStore: { events: [], toolFingerprints: [] } as any,
      repairHintTracker: { recordSuccess: () => {}, recordFailure: () => {} } as any,
      repairPipeline: { run: (input: any) => ({ output: input, telemetry: [] }) } as any,
      importGraph: null,
      lastConflictCheckCount: 0,
      trajectory: { getEntries: () => [] } as any,
      getDoomLoopLevel: () => 'none' as const,
      latestRisk: { level: 'none' as const, reasons: [], suggestedAction: '' },
      sessionTurnCount: 1,
      sessionId: 'test-session',
      recordToolHistory: () => {},
      ...overrides,
    }
  }

  const noopCallbacks = {
    onTextDelta: () => {},
    onThinkingDelta: () => {},
    onToolUse: () => {},
    onToolResult: () => {},
    onTurnComplete: () => {},
    onError: () => {},
    onAbort: () => {},
    onApprovalRequired: async () => false,
    onCheckpoint: () => {},
  }

  it('executes a tool and returns result', async () => {
    const deps = makeDeps()
    const result = await executeToolUse(
      { id: 'tu-1', name: 'read_file', input: { file_path: '/tmp/test.ts' } },
      deps, noopCallbacks as any, 1, false,
    )
    assert.equal(result.toolResult.tool_use_id, 'tu-1')
    assert.equal(result.toolResult.content, 'ok')
    assert.equal(result.toolResult.is_error, false)
    assert.equal(result.checkpointCreated, false)
  })

  it('calls onToolResult callback', async () => {
    const deps = makeDeps()
    let called = false
    const cb = { ...noopCallbacks, onToolResult: () => { called = true } }
    await executeToolUse(
      { id: 'tu-2', name: 'read_file', input: { file_path: '/tmp/x.ts' } },
      deps, cb as any, 1, false,
    )
    assert.ok(called)
  })

  it('records success in repairHintTracker on success', async () => {
    let successCalled = false
    const deps = makeDeps({
      repairHintTracker: { recordSuccess: () => { successCalled = true }, recordFailure: () => {} } as any,
    })
    await executeToolUse(
      { id: 'tu-3', name: 'read_file', input: { file_path: '/tmp/y.ts' } },
      deps, noopCallbacks as any, 1, false,
    )
    assert.ok(successCalled)
  })

  it('handles tool execution error gracefully', async () => {
    const deps = makeDeps({
      harness: {
        executeTool: async ({ execute }: any) => {
          const r = await execute()
          return { content: r.content, isError: true, retried: false }
        },
      } as any,
    })
    const result = await executeToolUse(
      { id: 'tu-4', name: 'bash', input: { command: 'false' } },
      deps, noopCallbacks as any, 1, false,
    )
    assert.equal(result.toolResult.is_error, true)
  })
})
