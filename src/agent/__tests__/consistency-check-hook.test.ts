import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createConsistencyCheckHook } from '../hooks/consistency-check-hook.js'
import type { RuntimeHookContext, RuntimeToolEvent } from '../runtime-hooks.js'

function makeCtx(overrides: { markClaimStale?: (id: string) => void } = {}): RuntimeHookContext {
  return {
    snapshot: {
      cwd: '/tmp',
      turn: 1,
      recentToolHistory: [],
      sensorium: null,
      strategy: null,
      vigor: null,
      gitChangeRate: 0,
    season: null,
    },
    effects: {
      setSensorium: () => {},
      setStrategy: () => {},
      setVigor: () => {},
      setGitChangeRate: () => {},
      injectUserMessage: () => {},
      requestThetaCheck: () => {},
      emitPhaseChange: () => {},
      emitDecisionShift: () => {},
      markClaimStale: overrides.markClaimStale ?? (() => {}),
    },
  }
}

describe('consistency-check-hook — 原则⑤ cross-store coupling', () => {
  it('marks file_observation claims stale when their file is overwritten', () => {
    const staleIds: string[] = []
    const ctx = makeCtx({ markClaimStale: id => staleIds.push(id) })

    const hook = createConsistencyCheckHook({
      getFileObservations: () => [
        {
          id: 'obs-1',
          text: 'src/foo.ts uses CommonJS',
          evidence: [{ path: 'src/foo.ts' }],
        },
        {
          id: 'obs-2',
          text: 'src/bar.ts has no tests',
          evidence: [{ path: 'src/bar.ts' }],
        },
      ],
    })

    const tool: RuntimeToolEvent = { name: 'edit_file', success: true, target: 'src/foo.ts' }
    hook.run(ctx, tool)

    assert.deepEqual(staleIds, ['obs-1'])
  })

  it('does not trigger on read_file', () => {
    const staleIds: string[] = []
    const ctx = makeCtx({ markClaimStale: id => staleIds.push(id) })

    const hook = createConsistencyCheckHook({
      getFileObservations: () => [
        { id: 'obs-1', text: 'x', evidence: [{ path: 'src/foo.ts' }] },
      ],
    })

    hook.run(ctx, { name: 'read_file', success: true, target: 'src/foo.ts' })
    assert.equal(staleIds.length, 0)
  })

  it('does not trigger when tool has no target', () => {
    const staleIds: string[] = []
    const ctx = makeCtx({ markClaimStale: id => staleIds.push(id) })

    const hook = createConsistencyCheckHook({
      getFileObservations: () => [
        { id: 'obs-1', text: 'x', evidence: [{ path: 'src/foo.ts' }] },
      ],
    })

    hook.run(ctx, { name: 'write_file', success: true })
    assert.equal(staleIds.length, 0)
  })

  it('handles empty observations gracefully', () => {
    const ctx = makeCtx()
    const hook = createConsistencyCheckHook({
      getFileObservations: () => [],
    })
    // Should not throw
    hook.run(ctx, { name: 'edit_file', success: true, target: 'src/foo.ts' })
  })

  it('matches suffix paths (tool target ends with evidence path)', () => {
    const staleIds: string[] = []
    const ctx = makeCtx({ markClaimStale: id => staleIds.push(id) })

    const hook = createConsistencyCheckHook({
      getFileObservations: () => [
        { id: 'obs-1', text: 'x', evidence: [{ path: 'foo.ts' }] },
      ],
    })

    hook.run(ctx, { name: 'write_file', success: true, target: 'src/deep/foo.ts' })
    assert.deepEqual(staleIds, ['obs-1'])
  })
})
