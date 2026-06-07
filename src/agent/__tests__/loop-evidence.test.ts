import { describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
// Writable cwd: AgentLoop turn-cache telemetry fire-and-forgets a mkdir under
// cwd; an unwritable TEST_CWD sentinel makes that async write reject after the
// test ends, leaking an unhandledRejection onto later tests in the same run.
const TEST_CWD = mkdtempSync(join(tmpdir(), 'rivet-loop-cwd-'))
import { AgentLoop } from '../loop.js'
import { SessionContext } from '../context.js'
import { PromptEngine } from '../../prompt/engine.js'
import { ToolRegistry } from '../../tools/registry.js'
import { READ_FILE_TOOL } from '../../tools/read-file.js'
import type { StreamCallbacks } from '../../api/stream-client.js'
import type { StreamClient } from '../../api/stream-client.js'
import type { ContentBlock } from '../../api/types.js'
import type { Tool, ToolResult } from '../../tools/types.js'
import type { EvidenceState } from '../evidence.js'

function makeTextBlock(text: string): ContentBlock {
  return { type: 'text', text }
}

function makeToolUseBlock(id: string, name: string, input: Record<string, unknown>): ContentBlock {
  return { type: 'tool_use', id, name, input }
}

function makeEngine() {
  return new PromptEngine({
    model: 'deepseek-v4-pro',
    maxTokens: 1024,
    staticCtx: { tools: [READ_FILE_TOOL.definition] },
    volatileCtx: { cwd: TEST_CWD },
  })
}

function createMockRunTestsTool(result: ToolResult): Tool {
  return {
    definition: {
      name: 'run_tests',
      description: 'Run tests',
      input_schema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
    },
    execute: async () => result,
    requiresApproval: () => false,
    isConcurrencySafe: () => true,
    isEnabled: () => true,
  }
}

function createMockWriteFileTool(): Tool {
  return {
    definition: {
      name: 'write_file',
      description: 'Write file',
      input_schema: { type: 'object', properties: { file_path: { type: 'string' }, content: { type: 'string' } }, required: ['file_path', 'content'] },
    },
    execute: async () => ({ content: 'File written' }),
    requiresApproval: () => true,
    isConcurrencySafe: () => false,
    isEnabled: () => true,
  }
}

/** Captures a snapshot of evidence state during onTurnComplete, before the loop resets the same object in-place */
function evidenceCapture(): { snapshot: EvidenceState | null } {
  return { snapshot: null }
}
function snapshotEvidence(state: EvidenceState): EvidenceState {
  return {
    filesRead: new Set(state.filesRead),
    filesModified: new Set(state.filesModified),
    verifications: [...state.verifications],
    deliveryStatus: state.deliveryStatus,
    impactedFiles: new Set(state.impactedFiles),
    impactedTests: new Set(state.impactedTests),
  }
}

describe('AgentLoop — evidence integration', () => {
  it('records run_tests verification into evidence tracker', async () => {
    const session = new SessionContext()
    const registry = new ToolRegistry()
    registry.register(createMockRunTestsTool({
      content: '2 passed, 0 failed',
      verification: {
        command: 'npm test',
        status: 'passed',
        scope: 'full',
        exitCode: 0,
        passed: 2,
        failed: 0,
        skipped: 0,
        durationMs: 500,
      },
    }))

    let callCount = 0
    const client: StreamClient = {
      stream: mock.fn(async (_req: unknown, cb: StreamCallbacks, _sig?: AbortSignal) => {
        callCount++
        if (callCount === 1) {
          cb.onContentBlock(makeToolUseBlock('tu_v1', 'run_tests', { command: 'npm test' }))
          cb.onStopReason('tool_use', { input_tokens: 100, output_tokens: 50 })
        } else {
          cb.onContentBlock(makeTextBlock('Tests passed.'))
          cb.onStopReason('end_turn', { input_tokens: 150, output_tokens: 30 })
        }
      }),
    } as unknown as StreamClient

    const agent = new AgentLoop(
      { client, promptEngine: makeEngine(), toolRegistry: registry, maxTurns: 5, contextWindow: 1_000_000, compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' } },
      session,
      TEST_CWD,
    )

    const captured = evidenceCapture()
    await agent.run('run tests', {
      onTextDelta: () => {},
      onThinkingDelta: () => {},
      onToolUse: () => {},
      onToolResult: () => {},
      onTurnComplete: () => { captured.snapshot = snapshotEvidence(agent.getEvidenceState()) },
      onError: () => {},
      onAbort: () => {},
      onApprovalRequired: async () => false,
    })

    assert.ok(captured.snapshot, 'evidence should have been captured before reset')
    assert.equal(captured.snapshot.verifications.length, 1)
    assert.equal(captured.snapshot.verifications[0]!.status, 'passed')
    assert.equal(captured.snapshot.deliveryStatus, 'verified')
  })

  it('records failed run_tests as failed delivery status', async () => {
    const session = new SessionContext()
    const registry = new ToolRegistry()
    registry.register(createMockWriteFileTool())
    registry.register(createMockRunTestsTool({
      content: '1 failed',
      verification: {
        command: 'npm test -- src/a.test.ts',
        status: 'failed',
        scope: 'targeted',
        exitCode: 1,
        passed: 0,
        failed: 1,
        skipped: 0,
        durationMs: 300,
      },
    }))

    let callCount = 0
    const client: StreamClient = {
      stream: mock.fn(async (_req: unknown, cb: StreamCallbacks, _sig?: AbortSignal) => {
        callCount++
        if (callCount === 1) {
          cb.onContentBlock(makeToolUseBlock('tu_w1', 'write_file', { file_path: 'src/a.ts', content: 'x' }))
          cb.onStopReason('tool_use', { input_tokens: 100, output_tokens: 50 })
        } else if (callCount === 2) {
          cb.onContentBlock(makeToolUseBlock('tu_r1', 'run_tests', { command: 'npm test' }))
          cb.onStopReason('tool_use', { input_tokens: 150, output_tokens: 80 })
        } else {
          cb.onContentBlock(makeTextBlock('Done.'))
          cb.onStopReason('end_turn', { input_tokens: 100, output_tokens: 30 })
        }
      }),
    } as unknown as StreamClient

    const agent = new AgentLoop(
      { client, promptEngine: makeEngine(), toolRegistry: registry, maxTurns: 5, contextWindow: 1_000_000, compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' } },
      session,
      TEST_CWD,
    )

    const captured = evidenceCapture()
    await agent.run('write then test', {
      onTextDelta: () => {},
      onThinkingDelta: () => {},
      onToolUse: () => {},
      onToolResult: () => {},
      onTurnComplete: () => { captured.snapshot = snapshotEvidence(agent.getEvidenceState()) },
      onError: () => {},
      onAbort: () => {},
      onApprovalRequired: async () => true,
    })

    assert.ok(captured.snapshot, 'evidence should have been captured before reset')
    assert.equal(captured.snapshot.filesModified.size, 1)
    assert.ok(captured.snapshot.filesModified.has('src/a.ts'))
    assert.equal(captured.snapshot.verifications.length, 1)
    assert.equal(captured.snapshot.verifications[0]!.status, 'failed')
    assert.equal(captured.snapshot.deliveryStatus, 'failed')
  })

  it('reports unverified when files modified without running tests', async () => {
    const session = new SessionContext()
    const registry = new ToolRegistry()
    registry.register(createMockWriteFileTool())

    let callCount = 0
    const client: StreamClient = {
      stream: mock.fn(async (_req: unknown, cb: StreamCallbacks, _sig?: AbortSignal) => {
        callCount++
        if (callCount === 1) {
          cb.onContentBlock(makeToolUseBlock('tu_w2', 'write_file', { file_path: 'src/b.ts', content: 'y' }))
          cb.onStopReason('tool_use', { input_tokens: 100, output_tokens: 50 })
        } else {
          cb.onContentBlock(makeTextBlock('Done.'))
          cb.onStopReason('end_turn', { input_tokens: 100, output_tokens: 30 })
        }
      }),
    } as unknown as StreamClient

    const agent = new AgentLoop(
      { client, promptEngine: makeEngine(), toolRegistry: registry, maxTurns: 5, contextWindow: 1_000_000, compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' } },
      session,
      TEST_CWD,
    )

    const captured = evidenceCapture()
    await agent.run('write file', {
      onTextDelta: () => {},
      onThinkingDelta: () => {},
      onToolUse: () => {},
      onToolResult: () => {},
      onTurnComplete: () => { captured.snapshot = snapshotEvidence(agent.getEvidenceState()) },
      onError: () => {},
      onAbort: () => {},
      onApprovalRequired: async () => true,
    })

    assert.ok(captured.snapshot, 'evidence should have been captured before reset')
    assert.equal(captured.snapshot.filesModified.size, 1)
    assert.equal(captured.snapshot.verifications.length, 0)
    assert.equal(captured.snapshot.deliveryStatus, 'unverified')
  })

  it('auto-safe mode asks approval for high-risk tools', async () => {
    const session = new SessionContext()
    const registry = new ToolRegistry()

    const dangerousTool: Tool = {
      definition: {
        name: 'bash',
        description: 'Shell',
        input_schema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
      },
      execute: async () => ({ content: 'destroyed' }),
      requiresApproval: () => true,
      isConcurrencySafe: () => false,
      isEnabled: () => true,
    }
    registry.register(dangerousTool)

    let callCount = 0
    const client: StreamClient = {
      stream: mock.fn(async (_req: unknown, cb: StreamCallbacks, _sig?: AbortSignal) => {
        callCount++
        if (callCount === 1) {
          cb.onContentBlock(makeToolUseBlock('tu_b1', 'bash', { command: 'rm -rf /tmp/test' }))
          cb.onStopReason('tool_use', { input_tokens: 100, output_tokens: 50 })
        } else {
          cb.onContentBlock(makeTextBlock('Done.'))
          cb.onStopReason('end_turn', { input_tokens: 100, output_tokens: 30 })
        }
      }),
    } as unknown as StreamClient

    const agent = new AgentLoop(
      { client, promptEngine: makeEngine(), toolRegistry: registry, maxTurns: 5, contextWindow: 1_000_000, compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' }, approvalMode: 'auto-safe' },
      session,
      TEST_CWD,
    )

    let approvalAsked = false
    await agent.run('delete temp', {
      onTextDelta: () => {},
      onThinkingDelta: () => {},
      onToolUse: () => {},
      onToolResult: () => {},
      onTurnComplete: () => {},
      onError: () => {},
      onAbort: () => {},
      onApprovalRequired: async () => { approvalAsked = true; return true },
    })

    assert.equal(approvalAsked, true)
  })

  it('updates latestRisk after tool execution', async () => {
    const session = new SessionContext()
    const registry = new ToolRegistry()
    registry.register(createMockWriteFileTool())

    let callCount = 0
    const client: StreamClient = {
      stream: mock.fn(async (_req: unknown, cb: StreamCallbacks, _sig?: AbortSignal) => {
        callCount++
        if (callCount === 1) {
          cb.onContentBlock(makeToolUseBlock('tu_risk1', 'write_file', { file_path: '/absolute/path.ts', content: 'z' }))
          cb.onStopReason('tool_use', { input_tokens: 100, output_tokens: 50 })
        } else {
          cb.onContentBlock(makeTextBlock('Done.'))
          cb.onStopReason('end_turn', { input_tokens: 100, output_tokens: 30 })
        }
      }),
    } as unknown as StreamClient

    const agent = new AgentLoop(
      { client, promptEngine: makeEngine(), toolRegistry: registry, maxTurns: 5, contextWindow: 1_000_000, compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' } },
      session,
      TEST_CWD,
    )

    assert.equal(agent.getLatestRisk().level, 'none')

    await agent.run('write file', {
      onTextDelta: () => {},
      onThinkingDelta: () => {},
      onToolUse: () => {},
      onToolResult: () => {},
      onTurnComplete: () => {},
      onError: () => {},
      onAbort: () => {},
      onApprovalRequired: async () => true,
    })

    const risk = agent.getLatestRisk()
    assert.ok(risk.level === 'low' || risk.level === 'medium', `Expected low/medium risk, got ${risk.level}`)
    assert.ok(risk.reasons.some(r => r.includes('absolute path')))
  })
})
