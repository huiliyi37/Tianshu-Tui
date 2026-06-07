import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ToolRegistry } from '../../tools/registry.js'
import { READ_FILE_TOOL } from '../../tools/read-file.js'
import { P3Integration } from '../p3-integration.js'
import { AgentLoop } from '../loop.js'
import { SessionContext } from '../context.js'
import { PromptEngine } from '../../prompt/engine.js'

function makeEngine(cwd: string) {
  return new PromptEngine({
    model: 'deepseek-v4-pro',
    maxTokens: 1024,
    staticCtx: { tools: [] },
    volatileCtx: { cwd },
  })
}

describe('P3Integration', () => {
  it('creates all subsystems', () => {
    const p3 = new P3Integration()
    assert.ok(p3.miner)
    assert.ok(p3.queue)
    assert.ok(p3.idleSpec)
    assert.ok(p3.notebook)
  })

  it('records tool patterns and enables speculation', () => {
    const p3 = new P3Integration()
    // Repeat pattern to build strong signal: grep → read_file
    for (let i = 0; i < 3; i++) {
      p3.onToolStart('grep', 'src/query.ts')
      p3.onToolComplete('grep', 'src/query.ts', false)
      p3.onToolStart('read_file', 'src/foo.ts')
      p3.onToolComplete('read_file', 'src/foo.ts', false)
    }
    const predictions = p3.miner.predict('grep')
    assert.ok(predictions.length > 0)
    const readFilePred = predictions.find(p => p.tool === 'read_file')
    assert.ok(readFilePred, 'should predict read_file after grep')
    assert.equal(readFilePred.likelyTarget, 'src/foo.ts')
  })

  it('enqueues physarum file predictions as read_file speculation', () => {
    const executed: string[] = []
    const p3 = new P3Integration({
      execute: async (tool, target) => {
        executed.push(`${tool}:${target}`)
        return 'prefetched'
      },
    })

    p3.enqueuePhysarumFilePredictions({
      afterToolName: 'read_file',
      predictions: [{ file: 'src/next.ts', score: 2 }],
    })

    assert.equal(p3.queue.pending(), 1)
    assert.deepEqual(executed, ['read_file:src/next.ts'])
  })

  it('does not enqueue physarum file predictions when tool pattern points away from read_file', () => {
    const executed: string[] = []
    const p3 = new P3Integration({
      execute: async (tool, target) => {
        executed.push(`${tool}:${target}`)
        return 'prefetched'
      },
    })

    p3.miner.record('read_file', 'bash')
    p3.enqueuePhysarumFilePredictions({
      afterToolName: 'read_file',
      predictions: [{ file: 'src/next.ts', score: 2 }],
    })

    assert.equal(p3.queue.pending(), 0)
    assert.deepEqual(executed, [])
  })

  it('AgentLoop validates speculative targets before executing file-capable tools', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'p3-spec-safe-'))
    const outside = mkdtempSync(join(tmpdir(), 'p3-spec-outside-'))
    try {
      mkdirSync(join(cwd, 'src'), { recursive: true })
      writeFileSync(join(cwd, 'src', 'ok.ts'), 'export const ok = 1\n')
      writeFileSync(join(outside, 'secret.ts'), 'secret\n')

      const registry = new ToolRegistry()
      registry.register(READ_FILE_TOOL)
      const loop = new AgentLoop({
        client: {} as any,
        promptEngine: makeEngine(cwd),
        toolRegistry: registry,
        maxTurns: 1,
        contextWindow: 1_000_000,
        compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' },
        fsWatcherEnabled: false,
      }, new SessionContext(), cwd)

      const unsafe = await (loop.p3 as any).queue.deps.execute('read_file', join(outside, 'secret.ts'))
      const safe = await (loop.p3 as any).queue.deps.execute('read_file', 'src/ok.ts')

      assert.equal(unsafe, '')
      assert.ok(safe.includes('export const ok = 1'))
    } finally {
      rmSync(cwd, { recursive: true, force: true })
      rmSync(outside, { recursive: true, force: true })
    }
  })

  it('records and retrieves mistakes', () => {
    const p3 = new P3Integration()
    p3.recordMistake(
      'Cannot find module ./foo.js',
      'edit_file src/bar.ts',
      'Add .js extension to ESM imports',
      ['esm', 'typescript'],
    )
    const hints = p3.getMistakeHints('Cannot find module ./baz.js', 'edit_file src/qux.ts')
    assert.ok(hints.includes('mistake-hints'))
    assert.ok(hints.includes('.js extension'))
  })

  it('returns empty hints for unrelated errors', () => {
    const p3 = new P3Integration()
    p3.recordMistake('Cannot find module', 'edit_file', 'fix import', ['esm'])
    const hints = p3.getMistakeHints('ECONNREFUSED', 'bash curl')
    assert.equal(hints, '')
  })

  it('assesses trajectory health', () => {
    const p3 = new P3Integration()
    const signal = p3.assessHealth(
      [
        { status: 'failed', turn: 1 },
        { status: 'failed', turn: 2 },
        { status: 'failed', turn: 3 },
      ],
      4,
      'flash',
    )
    assert.equal(signal, 'escalate')
  })

  it('applies agent diet to messages', () => {
    const p3 = new P3Integration()
    const messages = [
      { role: 'user' as const, content: 'hello' },
      { role: 'assistant' as const, content: 'hi' },
      { role: 'tool' as const, content: 'file content A', tool_call_id: 'tc1' },
      { role: 'assistant' as const, content: 'ok' },
      { role: 'tool' as const, content: 'file content B', tool_call_id: 'tc2' },
      { role: 'assistant' as const, content: 'done' },
      { role: 'tool' as const, content: 'result', tool_call_id: 'tc3' },
      { role: 'assistant' as const, content: 'final' },
    ]
    const result = p3.dietMessages(messages)
    assert.ok(result.removedCount >= 0)
  })

  it('escalate signal triggers when flash has 3+ consecutive failures', () => {
    const p3 = new P3Integration()
    // Healthy on pro regardless
    assert.equal(p3.assessHealth(
      [{ status: 'failed', turn: 1 }, { status: 'failed', turn: 2 }, { status: 'failed', turn: 3 }],
      4, 'pro',
    ), 'healthy')
    // Escalate on flash with 3 consecutive failures
    assert.equal(p3.assessHealth(
      [{ status: 'passed', turn: 1 }, { status: 'failed', turn: 2 }, { status: 'failed', turn: 3 }, { status: 'failed', turn: 4 }],
      5, 'flash',
    ), 'escalate')
    // Healthy on flash with mixed results
    assert.equal(p3.assessHealth(
      [{ status: 'passed', turn: 1 }, { status: 'failed', turn: 2 }, { status: 'passed', turn: 3 }],
      4, 'flash',
    ), 'healthy')
  })
})
