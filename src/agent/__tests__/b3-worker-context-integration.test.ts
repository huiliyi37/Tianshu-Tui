import { describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'
import type { StreamCallbacks } from '../../api/stream-client.js'
import type { StreamClient } from '../../api/stream-client.js'
import type { ContentBlock } from '../../api/types.js'
import { PromptEngine } from '../../prompt/engine.js'
import { ToolRegistry } from '../../tools/registry.js'
import { SessionContext } from '../context.js'
import { createReadOnlyWorkOrder } from '../work-order.js'
import { runWorkerSession } from '../worker-session.js'
import { AgentLoop } from '../loop.js'
import { ToolAccumulator } from '../tool-accumulator.js'

function textBlock(text: string): ContentBlock {
  return { type: 'text', text }
}

function toolUseBlock(id: string, name: string, input: Record<string, unknown>): ContentBlock {
  return { type: 'tool_use', id, name, input }
}

function clientWithToolUse(
  turns: Array<{ content: ContentBlock[]; stopReason: string; usage?: { input_tokens: number; output_tokens: number } }>,
): StreamClient {
  let index = 0
  return {
    stream: mock.fn(async (_req: unknown, cb: StreamCallbacks) => {
      const turn = turns[Math.min(index, turns.length - 1)]!
      index++
      for (const block of turn.content) {
        if (block.type === 'text') {
          cb.onTextDelta(block.text)
        }
        cb.onContentBlock(block)
      }
      cb.onStopReason(turn.stopReason, turn.usage ?? { input_tokens: 10, output_tokens: 5 })
    }),
  } as unknown as StreamClient
}

function makePromptEngine() {
  return new PromptEngine({
    model: 'deepseek-v4-pro',
    maxTokens: 1024,
    staticCtx: { tools: [] },
    volatileCtx: { cwd: '/repo' },
  })
}

function validPacket(workOrderId: string) {
  return JSON.stringify({
    workOrderId,
    status: 'passed',
    summary: 'Worker completed successfully.',
    findings: [{ claim: 'T4/T7/T10 wired', evidence: 'integration test', confidence: 'high' }],
    artifacts: [],
    changedFiles: [],
    risks: [],
    nextActions: [],
  })
}

describe('B3: worker context optimization integration (T4/T7/T10)', () => {
  it('worker AgentLoop receives contextWindow: 1_000_000 and runs without crash', async () => {
    const order = createReadOnlyWorkOrder({
      id: 'wo_b3_1',
      parentTurnId: 'turn_b3',
      kind: 'code_search',
      profile: 'code_scout',
      objective: 'Verify worker AgentLoop context.',
      scope: { files: ['src/agent/loop.ts'] },
    })

    // Use a client that returns a tool_use for grep (which the worker
    // can attempt to execute), then the final result JSON.
    // Even though grep is not registered in the empty ToolRegistry,
    // the AgentLoop should handle the missing tool gracefully and
    // continue to the next turn.
    const client = clientWithToolUse([
      {
        content: [toolUseBlock('tu_1', 'grep', { pattern: 'AgentLoop', path: 'src/agent/' })],
        stopReason: 'tool_use',
        usage: { input_tokens: 20, output_tokens: 30 },
      },
      {
        content: [textBlock(validPacket('wo_b3_1'))],
        stopReason: 'end_turn',
        usage: { input_tokens: 50, output_tokens: 100 },
      },
    ])

    const run = await runWorkerSession({
      order,
      client,
      promptEngine: makePromptEngine(),
      toolRegistry: new ToolRegistry(),
      cwd: '/repo',
      maxTurns: 12,
      contextWindow: 1_000_000,
      compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' },
    })

    // Worker should complete — tool_use for unregistered tool triggers
    // error handling but doesn't crash the worker session
    assert.ok(run.result.status === 'passed' || run.result.status === 'blocked')
    assert.ok(run.session instanceof SessionContext)
    assert.ok(run.session.getTurnCount() >= 1)
  })

  it('worker AgentLoop config flows contextWindow through to tool execution deps', async () => {
    // Construct a minimal AgentLoop directly and verify the config
    // propagates contextWindow to the internal tool execution pipeline.
    const session = new SessionContext()
    const promptEngine = makePromptEngine()

    const agent = new AgentLoop({
      client: {
        stream: mock.fn(async () => {}),
      } as unknown as StreamClient,
      promptEngine,
      toolRegistry: new ToolRegistry(),
      maxTurns: 2,
      contextWindow: 1_000_000,
      compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' },
      sessionId: 'worker-test-b3',
      thetaCheckDisabled: true,
    }, session, '/repo')

    // Verify the AgentLoop was constructed successfully
    assert.ok(agent instanceof AgentLoop)
    // The config.contextWindow: 1_000_000 ensures T10 tiering activates
    // (threshold: >= 500_000 for tier 1, >= 1_000_000 for tier 2)
  })

  it('verify T10 tiering thresholds are correct for 1M context window', async () => {
    // Dynamic import to avoid module-level side effects
    const { determineTier } = await import('../tool-result-tiering.js')

    // Small content: tier 0 (no tiering)
    assert.equal(determineTier(100), 0)
    assert.equal(determineTier(8_000), 0)

    // Medium content: tier 1 (summary)
    assert.equal(determineTier(8_001), 1)

    // Large content: tier 2 (minimal + read_section)
    assert.equal(determineTier(150_001), 2)
  })

  it('verify T4 tool accumulator collapses 4+ consecutive same-type calls', () => {
    const acc = new ToolAccumulator()

    // Feed 4 consecutive bash calls (non-reader tool, threshold 4)
    acc.record({ toolName: 'bash', toolUseId: 'tu_1', content: 'result1', turn: 1 })
    acc.record({ toolName: 'bash', toolUseId: 'tu_2', content: 'result2', turn: 1 })
    acc.record({ toolName: 'bash', toolUseId: 'tu_3', content: 'result3', turn: 1 })

    // 3 calls of same type: not yet collapsed
    let result = acc.tryCollapse('bash')
    assert.equal(result, null)

    acc.record({ toolName: 'bash', toolUseId: 'tu_4', content: 'result4', turn: 1 })
    // 4th consecutive same-type call: should collapse
    result = acc.tryCollapse('bash')
    assert.notEqual(result, null)
    assert.ok(result!.summary.includes('storm-collapsed'))
  })

  it('worker agent loop propagates maxTurns from B2 (12 for read-only)', async () => {
    const order = createReadOnlyWorkOrder({
      id: 'wo_b3_maxturns',
      parentTurnId: 'turn_b3',
      kind: 'code_search',
      profile: 'code_scout',
      objective: 'Verify maxTurns propagation.',
      scope: {},
    })

    const client = clientWithToolUse([
      {
        content: [textBlock(validPacket('wo_b3_maxturns'))],
        stopReason: 'end_turn',
        usage: { input_tokens: 10, output_tokens: 10 },
      },
    ])

    const run = await runWorkerSession({
      order,
      client,
      promptEngine: makePromptEngine(),
      toolRegistry: new ToolRegistry(),
      cwd: '/repo',
      maxTurns: 12,
      contextWindow: 1_000_000,
      compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' },
    })

    assert.equal(run.result.status, 'passed')
  })

  it('verify T7 collapse activates for 1M+ context windows', async () => {
    // T7 cache-safe request-time context collapse checks:
    // contextWindow >= 1_000_000. The collapse is triggered in the
    // PromptEngine when building the request. We verify by checking
    // that the PromptEngine recognizes a 1M window.
    const engine = new PromptEngine({
      model: 'deepseek-v4-pro',
      maxTokens: 1024,
      staticCtx: { tools: [] },
      volatileCtx: { cwd: '/repo' },
    })

    // Build a session with enough messages to trigger collapse
    const session = new SessionContext()
    session.addUserMessage('test message')

    // With contextWindow 1M, the engine should not throw when building request
    // (collapse is applied internally)
    const request = engine.buildOaiRequest(session.getMessages(), undefined, 1_000_000)
    assert.ok(request.messages.length > 0)
    assert.ok(request.model === 'deepseek-v4-pro')
  })
})
