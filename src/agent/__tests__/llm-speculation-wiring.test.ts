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

  it('does not inject speculateDuringBatch even when config opts in (chain SEALED 2026-07-07)', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'llm-spec-wiring-'))
    try {
      const client = mockClient('[{"tool":"read_file","target":"src/next.ts","probability":0.9}]')
      const loop = makeLoop(cwd, { client, llmSpeculation: { enabled: true } })
      const deps = (loop as unknown as { turnOrchestrator: { deps: Record<string, unknown> } }).turnOrchestrator['deps']

      // The engine's only consumer was ShadowQueue pre-execution; with serving
      // cut (stale-read incident) an opted-in engine would burn side-path LLM
      // calls for nothing — so the factory never constructs it anymore.
      assert.equal(deps.speculateDuringBatch, undefined, 'sealed chain must not inject the dep')
      assert.equal(loop.llmSpeculationEngine, null, 'engine must not be constructed')
      assert.equal(client.calls.length, 0, 'no speculative LLM call may fire')
      assert.equal(loop.p3.queue.statsBySource().llm.enqueued, 0)
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })
})
