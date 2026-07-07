import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { AdvisoryBus } from '../advisory-bus.js'
import { createContextPressureHook } from '../hooks/context-pressure-hook.js'
import type { RuntimeHookContext } from '../runtime-hooks.js'

function makeCtx(turn = 1): RuntimeHookContext {
  return {
    snapshot: {
      cwd: '/test',
      turn,
      recentToolHistory: [],
      sensorium: null,
      strategy: null,
      vigor: null,
      gitChangeRate: 0,
      season: null,
    },
    effects: {} as any,
  }
}

describe('createContextPressureHook', () => {
  it('submits advisory when ratio exceeds 70%', () => {
    const bus = new AdvisoryBus()
    const hook = createContextPressureHook({
      advisoryBus: bus,
      getEstimatedTokens: () => 80_000,
      getContextWindow: () => 100_000,
    })
    hook.run(makeCtx(1))
    assert.match(bus.render(), /上下文窗口使用率 80%/)
  })

  it('does NOT submit when ratio is below 70%', () => {
    const bus = new AdvisoryBus()
    const hook = createContextPressureHook({
      advisoryBus: bus,
      getEstimatedTokens: () => 50_000,
      getContextWindow: () => 100_000,
    })
    hook.run(makeCtx(1))
    assert.equal(bus.render(), '')
  })

  it('does NOT submit when estimatedTokens is 0', () => {
    const bus = new AdvisoryBus()
    const hook = createContextPressureHook({
      advisoryBus: bus,
      getEstimatedTokens: () => 0,
      getContextWindow: () => 100_000,
    })
    hook.run(makeCtx(1))
    assert.equal(bus.render(), '')
  })

  it('submits at most once per turn', () => {
    const bus = new AdvisoryBus()
    const hook = createContextPressureHook({
      advisoryBus: bus,
      getEstimatedTokens: () => 80_000,
      getContextWindow: () => 100_000,
    })
    hook.run(makeCtx(3))
    hook.run(makeCtx(3))
    const count = (bus.render().match(/<entry /g) || []).length
    assert.equal(count, 1)
  })
})
