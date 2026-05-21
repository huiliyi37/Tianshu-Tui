import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { executeToolUse, type ToolPipelineDeps } from '../tool-pipeline.js'
import { createTurnBudget } from '../turn-budget.js'
import type { EvidenceTrackerPublic } from '../evidence.js'

const mockEvidence = {
  trackFileRead: () => {},
  trackFileModified: () => {},
  trackImpact: () => {},
  trackVerification: () => {},
  getState: () => ({
    filesRead: new Set<string>(),
    filesModified: new Set<string>(),
    verifications: [],
    deliveryStatus: 'unverified' as const,
    impactedFiles: new Set<string>(),
    impactedTests: new Set<string>(),
  }),
  getVerificationSummary: () => ({ total: 0, verified: 0, pending: 0, files: [] }),
  buildBadge: () => null,
  reset: () => {},
} satisfies EvidenceTrackerPublic

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
      evidence: mockEvidence,
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
      turnBudget: createTurnBudget(0),
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
    assert.equal((result.toolResult as any).tool_use_id, 'tu-1')
    assert.equal((result.toolResult as any).content, 'ok')
    assert.equal((result.toolResult as any).is_error, false)
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

  it('truncates oversized successful tool results', async () => {
    const hugeContent = 'HEAD_MARKER' + 'x'.repeat(500_000) + 'TAIL_MARKER'
    const deps = makeDeps({
      config: {
        ...makeDeps().config,
        contextWindow: 10_000,
        toolRegistry: {
          execute: async () => ({ content: hugeContent, isError: false }),
          get: () => ({ definition: { input_schema: {} }, isConcurrencySafe: () => false }),
          needsApproval: () => false,
        },
      } as any,
    })

    const result = await executeToolUse(
      { id: 'tu-5', name: 'read_file', input: { file_path: '/tmp/huge.txt' } },
      deps, noopCallbacks as any, 1, false,
    )

    const content = (result.toolResult as any).content as string
    assert.ok(content.length < hugeContent.length)
    assert.ok(content.startsWith('HEAD_MARKER'))
    assert.ok(content.endsWith('TAIL_MARKER'))
    assert.match(content, /\.\.\.\[truncated \d+ chars\]\.\.\./)
  })

  it('truncates oversized run_tests diagnosis results', async () => {
    const hugeContent = 'HEAD_MARKER' + 'x'.repeat(500_000) + 'TAIL_MARKER'
    const deps = makeDeps({
      config: {
        ...makeDeps().config,
        contextWindow: 10_000,
        toolRegistry: {
          execute: async () => ({ content: hugeContent, isError: false }),
          get: () => ({ definition: { input_schema: {} }, isConcurrencySafe: () => false }),
          needsApproval: () => false,
        },
      } as any,
      repairPipeline: {
        run: (input: any) => ({
          output: input,
          telemetry: [{ pass: 'failure-classifier', kind: 'test_failure', suggestion: 'Run the focused failing test.' }],
        }),
      } as any,
    })

    const result = await executeToolUse(
      { id: 'tu-6', name: 'run_tests', input: { command: 'npm test' } },
      deps, noopCallbacks as any, 1, false,
    )

    const content = (result.toolResult as any).content as string
    assert.ok(content.length < hugeContent.length)
    assert.ok(content.startsWith('HEAD_MARKER'))
    assert.match(content, /\.\.\.\[truncated \d+ chars\]\.\.\./)
    assert.match(content, /TAIL_MARKER|Diagnosis:/)
  })

  it('blocks write tools in degraded reliability mode before approval', async () => {
    let approvalCalls = 0
    let executed = false
    const deps = makeDeps({
      config: {
        ...makeDeps().config,
        approvalMode: 'auto-safe',
        permissions: { allow: [] },
        toolRegistry: {
          execute: async () => { executed = true; return { content: 'wrote', isError: false } },
          get: () => ({ definition: { input_schema: {} }, isConcurrencySafe: () => false }),
          needsApproval: () => false,
        },
      } as any,
      getReliabilityDecision: () => ({ mode: 'degraded', reason: 'resource pressure rising', blockedTools: ['bash_write'] }),
    })
    const callbacks = { ...noopCallbacks, onApprovalRequired: async () => { approvalCalls++; return true } }

    const result = await executeToolUse(
      { id: 'tu-degraded-write', name: 'bash', input: { command: 'echo hello > out.txt' } },
      deps, callbacks as any, 1, false,
    )

    assert.equal(approvalCalls, 0)
    assert.equal(executed, false)
    assert.equal((result.toolResult as any).is_error, true)
    assert.match((result.toolResult as any).content, /reliability mode: degraded/)
  })

  it('allows read-only tools in minimal reliability mode', async () => {
    let executed = false
    const deps = makeDeps({
      config: {
        ...makeDeps().config,
        toolRegistry: {
          execute: async () => { executed = true; return { content: 'read', isError: false } },
          get: () => ({ definition: { input_schema: {} }, isConcurrencySafe: () => false }),
          needsApproval: () => false,
        },
      } as any,
      getReliabilityDecision: () => ({ mode: 'minimal', reason: 'memory pressure critical', blockedTools: ['bash'] }),
    })

    const result = await executeToolUse(
      { id: 'tu-minimal-read', name: 'read_file', input: { file_path: 'README.md' } },
      deps, noopCallbacks as any, 1, false,
    )

    assert.equal(executed, true)
    assert.equal((result.toolResult as any).is_error, false)
  })

  it('requires approval for bash writes even with high confidence auto-safe mode', async () => {
    let approvalCalls = 0
    let executed = false
    const deps = makeDeps({
      config: {
        ...makeDeps().config,
        approvalMode: 'auto-safe',
        permissions: { allow: [] },
        toolRegistry: {
          execute: async () => { executed = true; return { content: 'wrote', isError: false } },
          get: () => ({ definition: { input_schema: {} }, isConcurrencySafe: () => false }),
          needsApproval: () => false,
        },
      } as any,
      getSensorium: () => ({ momentum: 0.8, pressure: 0.2, confidence: 0.95, complexity: 0.2, freshness: 0.9, stability: 0.9 }),
    })
    const callbacks = { ...noopCallbacks, onApprovalRequired: async () => { approvalCalls++; return false } }

    const result = await executeToolUse(
      { id: 'tu-bash-write', name: 'bash', input: { command: 'echo hello > out.txt' } },
      deps, callbacks as any, 1, false,
    )

    assert.equal(approvalCalls, 1)
    assert.equal(executed, false)
    assert.equal((result.toolResult as any).is_error, true)
    assert.match((result.toolResult as any).content, /requires user approval/)
  })

  it('lets explicit allowlist override bash write approval', async () => {
    let approvalCalls = 0
    let executed = false
    const deps = makeDeps({
      config: {
        ...makeDeps().config,
        approvalMode: 'auto-safe',
        permissions: { allow: [{ tool: 'bash', params: { command: 'echo hello > out.txt' } }] },
        toolRegistry: {
          execute: async () => { executed = true; return { content: 'wrote', isError: false } },
          get: () => ({ definition: { input_schema: {} }, isConcurrencySafe: () => false }),
          needsApproval: () => false,
        },
      } as any,
      getSensorium: () => ({ momentum: 0.8, pressure: 0.2, confidence: 0.95, complexity: 0.2, freshness: 0.9, stability: 0.9 }),
    })
    const callbacks = { ...noopCallbacks, onApprovalRequired: async () => { approvalCalls++; return false } }

    const result = await executeToolUse(
      { id: 'tu-bash-allow', name: 'bash', input: { command: 'echo hello > out.txt' } },
      deps, callbacks as any, 1, false,
    )

    assert.equal(approvalCalls, 0)
    assert.equal(executed, true)
    assert.equal((result.toolResult as any).is_error, false)
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
    assert.equal((result.toolResult as any).is_error, true)
  })
})
