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

function textBlock(text: string): ContentBlock {
  return { type: 'text', text }
}

function clientFromTexts(texts: string[]): StreamClient {
  let index = 0
  return {
    stream: mock.fn(async (_req: unknown, cb: StreamCallbacks) => {
      const text = texts[Math.min(index, texts.length - 1)]!
      index++
      cb.onTextDelta(text)
      cb.onContentBlock(textBlock(text))
      cb.onStopReason('end_turn', { input_tokens: 10, output_tokens: 5 })
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
    summary: 'Worker found one seam.',
    findings: [{ claim: 'AgentLoop is injectable', evidence: 'src/agent/loop.ts constructor', confidence: 'high' }],
    artifacts: [],
    changedFiles: [],
    risks: [],
    nextActions: ['Use an independent SessionContext'],
  })
}

describe('runWorkerSession', () => {
  it('runs a headless worker and returns a schema-valid result', async () => {
    const order = createReadOnlyWorkOrder({
      id: 'wo_1',
      parentTurnId: 'turn_1',
      kind: 'code_search',
      profile: 'code_scout',
      objective: 'Find AgentLoop constructor seams.',
      scope: { files: ['src/agent/loop.ts'] },
    })

    const run = await runWorkerSession({
      order,
      client: clientFromTexts([validPacket('wo_1')]),
      promptEngine: makePromptEngine(),
      toolRegistry: new ToolRegistry(),
      cwd: '/repo',
      maxTurns: 2,
      contextWindow: 1_000_000,
      compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' },
    })

    assert.equal(run.result.status, 'passed')
    assert.equal(run.session.getTurnCount(), 1)
    assert.deepEqual(run.transcript.toolUses, [])
  })

  it('uses an independent SessionContext instead of mutating the primary session', async () => {
    const primary = new SessionContext()
    primary.addUserMessage('primary user message')
    const before = primary.getMessages().length

    const order = createReadOnlyWorkOrder({
      id: 'wo_2',
      parentTurnId: 'turn_1',
      kind: 'review',
      profile: 'reviewer',
      objective: 'Review isolation.',
      scope: {},
    })

    const run = await runWorkerSession({
      order,
      client: clientFromTexts([validPacket('wo_2')]),
      promptEngine: makePromptEngine(),
      toolRegistry: new ToolRegistry(),
      cwd: '/repo',
      maxTurns: 2,
      contextWindow: 1_000_000,
      compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' },
    })

    assert.equal(primary.getMessages().length, before)
    assert.ok(run.session.getMessages().length > 0)
  })

  it('recovers without repair when prose contains incidental JSON before the result packet', async () => {
    const order = createReadOnlyWorkOrder({
      id: 'wo_incidental',
      parentTurnId: 'turn_1',
      kind: 'code_search',
      profile: 'code_scout',
      objective: 'Find worker result parser seams across coordinator and worker session modules.',
      scope: {},
      budget: { maxRetries: 1 },
    })

    const text = `Observed tool input {"pattern":"WorkerResult"}. Final packet:\n${validPacket('wo_incidental')}`
    const run = await runWorkerSession({
      order,
      client: clientFromTexts([text]),
      promptEngine: makePromptEngine(),
      toolRegistry: new ToolRegistry(),
      cwd: '/repo',
      maxTurns: 2,
      contextWindow: 1_000_000,
      compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' },
    })

    assert.equal(run.result.status, 'passed')
    assert.equal(run.transcript.repairAttempts, 0)
  })

  it('runs one repair prompt after invalid worker JSON', async () => {
    const order = createReadOnlyWorkOrder({
      id: 'wo_3',
      parentTurnId: 'turn_1',
      kind: 'plan',
      profile: 'planner',
      objective: 'Plan coordinator tests.',
      scope: {},
      budget: { maxRetries: 1 },
    })

    const client = clientFromTexts(['not valid json', validPacket('wo_3')])
    const run = await runWorkerSession({
      order,
      client,
      promptEngine: makePromptEngine(),
      toolRegistry: new ToolRegistry(),
      cwd: '/repo',
      maxTurns: 2,
      contextWindow: 1_000_000,
      compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' },
    })

    assert.equal(run.result.status, 'passed')
    assert.equal(run.transcript.repairAttempts, 1)
  })

  it('returns blocked after retry budget is exhausted', async () => {
    const order = createReadOnlyWorkOrder({
      id: 'wo_4',
      parentTurnId: 'turn_1',
      kind: 'review',
      profile: 'reviewer',
      objective: 'Review invalid result handling.',
      scope: {},
      budget: { maxRetries: 0 },
    })

    const run = await runWorkerSession({
      order,
      client: clientFromTexts(['not valid json']),
      promptEngine: makePromptEngine(),
      toolRegistry: new ToolRegistry(),
      cwd: '/repo',
      maxTurns: 2,
      contextWindow: 1_000_000,
      compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' },
    })

    assert.equal(run.result.status, 'blocked')
    assert.ok(run.result.risks.includes('Worker did not return schema-valid JSON'))
  })

  it('forceJsonRepair sends response_format on the repair request and recovers', async () => {
    const order = createReadOnlyWorkOrder({
      id: 'wo_json',
      parentTurnId: 'turn_1',
      kind: 'plan',
      profile: 'planner',
      objective: 'Plan json repair.',
      scope: {},
      budget: { maxRetries: 1 },
    })

    // Capture whether the repair request carried response_format.
    let sawResponseFormat = false
    let repairCallCount = 0
    const client = {
      stream: mock.fn(async (req: { response_format?: unknown }, cb: StreamCallbacks) => {
        // First call: invalid output (no response_format — normal turn via AgentLoop).
        // Second call: json-mode repair (response_format set).
        if (req.response_format) {
          sawResponseFormat = true
          repairCallCount++
          cb.onTextDelta(validPacket('wo_json'))
          cb.onContentBlock(textBlock(validPacket('wo_json')))
          cb.onStopReason('end_turn', { input_tokens: 10, output_tokens: 5 })
          return
        }
        // The AgentLoop also issues calls without response_format; only emit
        // invalid text the first time so repair triggers.
        cb.onTextDelta('definitely not json at all')
        cb.onContentBlock(textBlock('definitely not json at all'))
        cb.onStopReason('end_turn', { input_tokens: 10, output_tokens: 5 })
      }),
    } as unknown as StreamClient

    const run = await runWorkerSession({
      order,
      client,
      promptEngine: makePromptEngine(),
      toolRegistry: new ToolRegistry(),
      cwd: '/repo',
      maxTurns: 2,
      contextWindow: 1_000_000,
      compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' },
      forceJsonRepair: true,
    })

    assert.equal(run.result.status, 'passed', 'json-mode repair should recover to passed')
    assert.ok(sawResponseFormat, 'repair request must carry response_format: json_object')
    assert.equal(repairCallCount, 1, 'exactly one json-mode repair call')
  })
})
