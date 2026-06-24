import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { AdvisoryBus } from '../advisory-bus.js'
import { createLossyObservationHook } from '../hooks/lossy-observation-hook.js'
import type { RuntimeHookContext, RuntimeToolEvent } from '../runtime-hooks.js'

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

function makeTool(overrides: Partial<RuntimeToolEvent> = {}): RuntimeToolEvent {
  return { name: 'bash', success: true, resultContent: undefined, ...overrides }
}

describe('createLossyObservationHook', () => {
  it('submits advisory when resultContent contains storm-collapsed marker', () => {
    const bus = new AdvisoryBus()
    const hook = createLossyObservationHook({ advisoryBus: bus })
    hook.run(makeCtx(), makeTool({ resultContent: '[storm-collapsed: 5 bash calls]' }))
    assert.match(bus.render(), /有损观测/)
  })

  it('submits advisory for tiered-summary marker', () => {
    const bus = new AdvisoryBus()
    const hook = createLossyObservationHook({ advisoryBus: bus })
    hook.run(makeCtx(), makeTool({ resultContent: '[tiered-summary: repo_map, 200 lines]' }))
    assert.match(bus.render(), /有损观测/)
  })

  it('submits advisory for output truncated marker', () => {
    const bus = new AdvisoryBus()
    const hook = createLossyObservationHook({ advisoryBus: bus })
    hook.run(makeCtx(), makeTool({ resultContent: 'out\n[output truncated: last 50 lines]' }))
    assert.match(bus.render(), /有损观测/)
  })

  it('does NOT submit for non-lossy content', () => {
    const bus = new AdvisoryBus()
    const hook = createLossyObservationHook({ advisoryBus: bus })
    hook.run(makeCtx(), makeTool({ resultContent: 'normal tool output' }))
    assert.equal(bus.render(), '')
  })

  it('does NOT submit when resultContent is undefined', () => {
    const bus = new AdvisoryBus()
    const hook = createLossyObservationHook({ advisoryBus: bus })
    hook.run(makeCtx(), makeTool({ resultContent: undefined }))
    assert.equal(bus.render(), '')
  })

  it('submits at most once per turn (cooldown)', () => {
    const bus = new AdvisoryBus()
    const hook = createLossyObservationHook({ advisoryBus: bus })
    hook.run(makeCtx(5), makeTool({ resultContent: '[storm-collapsed: a]' }))
    hook.run(makeCtx(5), makeTool({ resultContent: '[storm-collapsed: b]' }))
    const count = (bus.render().match(/<entry /g) || []).length
    assert.equal(count, 1)
  })

  it('resets cooldown on new turn', () => {
    const bus = new AdvisoryBus()
    const hook = createLossyObservationHook({ advisoryBus: bus })

    // Turn 1: should fire
    hook.run(makeCtx(1), makeTool({ resultContent: '[storm-collapsed: t1]' }))
    assert.match(bus.render(), /有损观测/)

    // Turn 2: should fire again (different turn, cooldown reset)
    hook.run(makeCtx(2), makeTool({ resultContent: '[storm-collapsed: t2]' }))
    assert.match(bus.render(), /有损观测/)
  })
})
