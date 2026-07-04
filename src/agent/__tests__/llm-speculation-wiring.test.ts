import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ToolRegistry } from '../../tools/registry.js'
import { AgentLoop } from '../loop.js'
import { SessionContext } from '../context.js'
import { PromptEngine } from '../../prompt/engine.js'
import type { OaiChatRequest } from '../../api/oai-types.js'
import type { StreamClient, StreamCallbacks } from '../../api/stream-client.js'

function makeEngine(cwd: string) {
  return new PromptEngine({
    model: 'deepseek-v4-pro',
    maxTokens: 1024,
    staticCtx: { tools: [] },
    volatileCtx: { cwd },
  })
}

function mockClient(text: string): StreamClient & { calls: OaiChatRequest[] } {
  const calls: OaiChatRequest[] = []
  return {
    calls,
    async stream(request: OaiChatRequest, callbacks: StreamCallbacks): Promise<void> {
      calls.push(request)
      callbacks.onTextDelta(text)
    },
  }
}

function makeLoop(cwd: string, opts: { client: StreamClient; llmSpeculation?: unknown }): AgentLoop {
  return new AgentLoop({
    client: opts.client,
    promptEngine: makeEngine(cwd),
    toolRegistry: new ToolRegistry(),
    maxTurns: 1,
    contextWindow: 1_000_000,
    compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' },
    fsWatcherEnabled: false,
    llmSpeculation: opts.llmSpeculation as never,
  }, new SessionContext(), cwd)
}

const SLOW_BATCH = [{ id: 't1', name: 'bash', input: { command: 'npm test' } }]

function makeRequest(): OaiChatRequest {
  return {
    model: 'deepseek-v4',
    messages: [{ role: 'user', content: 'task' }],
    max_tokens: 4096,
  }
}

describe('LLM speculation wiring (loop-factory → turn-orchestrator → p3)', () => {
  it('does not inject speculateDuringBatch when config is off (default)', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'llm-spec-wiring-'))
    try {
      const loop = makeLoop(cwd, { client: mockClient('[]') })
      const deps = (loop as unknown as { turnOrchestrator: { deps: Record<string, unknown> } }).turnOrchestrator['deps']
      assert.equal(deps.speculateDuringBatch, undefined, 'disabled config must not inject the dep')
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('injects speculateDuringBatch when enabled and routes predictions into p3 ShadowQueue', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'llm-spec-wiring-'))
    try {
      const client = mockClient('[{"tool":"read_file","target":"src/next.ts","probability":0.9}]')
      const loop = makeLoop(cwd, { client, llmSpeculation: { enabled: true } })
      const deps = (loop as unknown as { turnOrchestrator: { deps: Record<string, unknown> } }).turnOrchestrator['deps']
      const speculate = deps.speculateDuringBatch as (params: unknown) => void
      assert.equal(typeof speculate, 'function', 'enabled config must inject the dep')

      speculate({ request: makeRequest(), toolUses: SLOW_BATCH, turn: 1 })
      // fire-and-forget: wait for the speculative call + enqueue to settle
      const deadline = Date.now() + 2_000
      while (loop.p3.queue.statsBySource().llm.enqueued === 0) {
        if (Date.now() > deadline) break
        await new Promise(r => setTimeout(r, 5))
      }

      assert.equal(client.calls.length, 1, 'speculative LLM call fired')
      assert.equal(loop.p3.queue.statsBySource().llm.enqueued, 1, 'prediction reached ShadowQueue tagged as llm')
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })
})
