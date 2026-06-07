import { describe, it } from 'node:test'
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
import { ToolRegistry } from '../../tools/registry.js'
import { PromptEngine } from '../../prompt/engine.js'

function makeEngine() {
  return new PromptEngine({
    model: 'deepseek-v4-pro',
    maxTokens: 1024,
    staticCtx: { tools: [] },
    volatileCtx: { cwd: TEST_CWD },
  })
}

function makeConfig(overrides: Record<string, unknown> = {}) {
  return {
    client: {} as any,
    promptEngine: makeEngine(),
    toolRegistry: new ToolRegistry(),
    maxTurns: 5,
    contextWindow: 1_000_000,
    compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' },
    fsWatcherEnabled: false,
    ...overrides,
  }
}

describe('AgentLoop memory warmup (S9)', () => {
  it('does not read DB during construction when meridianIndexer is provided', () => {
    const dbReads: string[] = []
    const fakeDb = {
      loadFromDb: () => { dbReads.push('physarum') },
      loadImmuneMemories: () => { dbReads.push('immune'); return [] },
      loadMistakeEntries: () => { dbReads.push('mistake'); return [] },
      loadToolPatternMinerSnapshot: () => { dbReads.push('p3'); return null },
    } as any

    const session = new SessionContext()
    new AgentLoop(
      makeConfig({ meridianIndexer: { getDb: () => fakeDb } }),
      session,
      TEST_CWD,
    )
    // After construction, no DB reads should have occurred
    assert.deepEqual(dbReads, [], 'constructor should not trigger DB reads')
  })

  it('warmupMemories() is callable and idempotent', async () => {
    const callCount = { physarum: 0, immune: 0, mistake: 0, p3: 0 }
    const fakeDb = {
      loadFromDb: () => { callCount.physarum++ },
      loadImmuneMemories: () => { callCount.immune++; return [] },
      loadMistakeEntries: () => { callCount.mistake++; return [] },
      loadToolPatternMinerSnapshot: () => { callCount.p3++; return null },
    } as any

    const session = new SessionContext()
    const loop = new AgentLoop(
      makeConfig({ meridianIndexer: { getDb: () => fakeDb } }),
      session,
      TEST_CWD,
    )
    await loop.warmupMemories()
    const after = { ...callCount }
    await loop.warmupMemories()
    assert.deepEqual(callCount, after, 'second warmup should be no-op')
  })
})
