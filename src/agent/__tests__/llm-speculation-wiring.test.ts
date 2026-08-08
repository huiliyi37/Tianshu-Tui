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

  it('does not inject speculateDuringBatch even when config opts in (SEALED without observe env)', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'llm-spec-wiring-'))
    try {
      const client = mockClient('[{"tool":"read_file","target":"src/next.ts","probability":0.9}]')
      const loop = makeLoop(cwd, { client, llmSpeculation: { enabled: true } })
      const deps = (loop as unknown as { turnOrchestrator: { deps: Record<string, unknown> } }).turnOrchestrator['deps']

      // 双重 opt-in 缺一不可：config 开但 RIVET_SPEC_OBSERVE 未设 → 维持封存。
      assert.equal(deps.speculateDuringBatch, undefined, 'sealed chain must not inject the dep')
      assert.equal(loop.llmSpeculationEngine, null, 'engine must not be constructed')
      assert.equal(client.calls.length, 0, 'no speculative LLM call may fire')
      assert.equal(loop.p3.queue.statsBySource().llm.enqueued, 0)
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('RIVET_SPEC_OBSERVE=1 + config enabled → engine constructed, enqueue-only, serving stays sealed (T5b)', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'llm-spec-wiring-'))
    const prevEnv = process.env['RIVET_SPEC_OBSERVE']
    process.env['RIVET_SPEC_OBSERVE'] = '1'
    try {
      const client = mockClient('[{"tool":"read_file","target":"src/next.ts","probability":0.9}]')
      const loop = makeLoop(cwd, { client, llmSpeculation: { enabled: true } })
      const deps = (loop as unknown as { turnOrchestrator: { deps: Record<string, unknown> } }).turnOrchestrator['deps'] as {
        speculateDuringBatch?: (params: { request: OaiChatRequest; toolUses: Array<{ id: string; name: string; input: Record<string, unknown> }>; turn: number }) => void
      }

      assert.ok(deps.speculateDuringBatch, 'observe mode must inject the dep')
      assert.ok(loop.llmSpeculationEngine, 'observe mode must construct the engine')

      // 发一次投机调用：预测应入队（llm 臂统计），但 serving 恒封存。
      deps.speculateDuringBatch!({
        request: { model: 'deepseek-v4-flash', messages: [{ role: 'user', content: 'hi' }] } as OaiChatRequest,
        toolUses: [{ id: 't1', name: 'bash', input: { command: 'sleep 1' } }],
        turn: 1,
      })
      const deadline = Date.now() + 2_000
      while (loop.p3.queue.statsBySource().llm.enqueued === 0 && Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 10))
      }
      assert.equal(client.calls.length, 1, 'speculative LLM call fires in observe mode')
      assert.equal(loop.p3.queue.statsBySource().llm.enqueued, 1, 'prediction enqueued for stats')
      assert.equal(loop.p3.checkSpeculativeCache('read_file', 'src/next.ts'), undefined,
        'serving stays sealed — observe mode never returns cached content')
    } finally {
      if (prevEnv === undefined) delete process.env['RIVET_SPEC_OBSERVE']
      else process.env['RIVET_SPEC_OBSERVE'] = prevEnv
      rmSync(cwd, { recursive: true, force: true })
    }
  })
})
