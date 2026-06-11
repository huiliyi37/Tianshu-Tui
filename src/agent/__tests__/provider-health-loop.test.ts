/**
 * T1 provider health: AgentLoop feeds stream outcomes into ProviderHealthTracker.
 *
 * 契约：
 * - stream 正常完成 → recordSuccess(providerName)
 * - stream 抛错（非 AbortError）→ recordFailure(providerName)
 * - 未注入 providerHealth/providerName → 静默 no-op
 */

import { describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentLoop } from '../loop.js'
import { SessionContext } from '../context.js'
import { PromptEngine } from '../../prompt/engine.js'
import { ToolRegistry } from '../../tools/registry.js'
import { READ_FILE_TOOL } from '../../tools/read-file.js'
import { ProviderHealthTracker } from '../provider-health.js'
import type { StreamCallbacks, StreamClient } from '../../api/stream-client.js'

const TEST_CWD = mkdtempSync(join(tmpdir(), 'rivet-provider-health-'))

function makeEngine() {
  return new PromptEngine({
    model: 'deepseek-v4-pro',
    maxTokens: 1024,
    staticCtx: { tools: [READ_FILE_TOOL.definition] },
    volatileCtx: { cwd: TEST_CWD },
  })
}

function okClient(): StreamClient {
  return {
    stream: mock.fn(async (_req: unknown, cb: StreamCallbacks) => {
      cb.onTextDelta('done')
      cb.onContentBlock({ type: 'text', text: 'done' })
      cb.onStopReason('end_turn', { input_tokens: 10, output_tokens: 5 })
    }),
  } as unknown as StreamClient
}

function failingClient(): StreamClient {
  return {
    stream: mock.fn(async () => {
      throw Object.assign(new Error('Server overloaded (503)'), { status: 503 })
    }),
  } as unknown as StreamClient
}

function baseConfig(client: StreamClient, health: ProviderHealthTracker) {
  const registry = new ToolRegistry()
  registry.register(READ_FILE_TOOL)
  return {
    client,
    promptEngine: makeEngine(),
    toolRegistry: registry,
    maxTurns: 1,
    contextWindow: 1_000_000,
    compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' },
    providerHealth: health,
    providerName: 'deepseek',
  }
}

const noopCallbacks = {
  onTextDelta: () => {},
  onThinkingDelta: () => {},
  onToolUse: () => {},
  onToolResult: () => {},
  onTurnComplete: () => {},
  onAbort: () => {},
  onApprovalRequired: async () => false,
}

describe('AgentLoop provider health recording', () => {
  it('records success when the stream completes cleanly', async () => {
    const health = new ProviderHealthTracker()
    const agent = new AgentLoop(baseConfig(okClient(), health), new SessionContext(), TEST_CWD)

    await agent.run('hi', { ...noopCallbacks, onError: () => {} })

    const deepseek = health.getWeights().find(h => h.providerId === 'deepseek')
    assert.ok(deepseek, 'deepseek should be registered')
    assert.equal(deepseek.consecutiveSuccesses, 1)
    assert.equal(deepseek.consecutiveFailures, 0)
    assert.equal(deepseek.tier, 'hot')
  })

  it('records failure when the stream errors', async () => {
    const health = new ProviderHealthTracker()
    const agent = new AgentLoop(baseConfig(failingClient(), health), new SessionContext(), TEST_CWD)

    let errored: Error | null = null
    await agent.run('hi', { ...noopCallbacks, onError: (e) => { errored = e } })

    assert.ok(errored, 'stream error should reach onError')
    const deepseek = health.getWeights().find(h => h.providerId === 'deepseek')
    assert.ok(deepseek, 'deepseek should be registered')
    assert.equal(deepseek.consecutiveFailures, 1)
    assert.ok(deepseek.weight < 1, 'failure should reduce weight')
  })
})
