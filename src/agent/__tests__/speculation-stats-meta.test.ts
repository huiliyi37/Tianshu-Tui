import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ToolRegistry } from '../../tools/registry.js'
import { AgentLoop } from '../loop.js'
import { SessionContext } from '../context.js'
import { PromptEngine } from '../../prompt/engine.js'

/**
 * postSession must persist ShadowQueue per-source speculation stats into the
 * session .meta.json — this is the cross-session evidence channel for the
 * "should llmSpeculation default on" decision (bypasses RIVET_DEBUG_TELEMETRY).
 */
describe('speculation stats → session meta', () => {
  let cwd: string
  let sessionDir: string
  let prevSessionDir: string | undefined

  before(() => {
    cwd = mkdtempSync(join(tmpdir(), 'spec-meta-cwd-'))
    sessionDir = mkdtempSync(join(tmpdir(), 'spec-meta-sessions-'))
    prevSessionDir = process.env.RIVET_SESSION_DIR
    process.env.RIVET_SESSION_DIR = sessionDir
  })

  after(() => {
    if (prevSessionDir === undefined) delete process.env.RIVET_SESSION_DIR
    else process.env.RIVET_SESSION_DIR = prevSessionDir
    rmSync(cwd, { recursive: true, force: true })
    rmSync(sessionDir, { recursive: true, force: true })
  })

  function makeLoop(sessionId: string): AgentLoop {
    return new AgentLoop({
      client: {} as never,
      promptEngine: new PromptEngine({
        model: 'deepseek-v4-pro',
        maxTokens: 1024,
        staticCtx: { tools: [] },
        volatileCtx: { cwd },
      }),
      toolRegistry: new ToolRegistry(),
      maxTurns: 1,
      contextWindow: 1_000_000,
      compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' },
      fsWatcherEnabled: false,
      sessionId,
    }, new SessionContext(), cwd)
  }

  it('writes speculationStats into meta.json when sources saw activity', async () => {
    const loop = makeLoop('spec-meta-active')
    loop.p3.enqueueLlmPredictions([{ tool: 'read_file', likelyTarget: 'src/a.ts', probability: 0.9 }])
    await new Promise(r => setTimeout(r, 20))

    await loop.runPostSession({} as never)

    const meta = JSON.parse(readFileSync(join(sessionDir, 'spec-meta-active.meta.json'), 'utf-8'))
    assert.ok(meta.speculationStats, 'speculationStats must be persisted')
    assert.equal(meta.speculationStats.llm.enqueued, 1)
  })

  it('does not write speculationStats when there was no speculation activity', async () => {
    const loop = makeLoop('spec-meta-idle')
    await loop.runPostSession({} as never)

    const meta = JSON.parse(readFileSync(join(sessionDir, 'spec-meta-idle.meta.json'), 'utf-8'))
    assert.equal(meta.speculationStats, undefined, 'idle sessions must not grow meta')
  })
})
