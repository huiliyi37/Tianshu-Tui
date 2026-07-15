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

// W2-B3 threshold-crossing semantics: a reminder fires only on the FIRST
// crossing of a pressure threshold — staying above it must not re-emit
// (per-turn fill% churn flips advisory appendix bytes every turn). The
// threshold re-arms only after the ratio drops below (threshold - hysteresis).

describe('createContextPressureHook', () => {
  function hookWithRatio(ratios: number[]) {
    const bus = new AdvisoryBus()
    let call = 0
    const hook = createContextPressureHook({
      advisoryBus: bus,
      getEstimatedTokens: () => Math.round((ratios[Math.min(call++, ratios.length - 1)] ?? 0) * 100_000),
      getContextWindow: () => 100_000,
    })
    return { bus, hook }
  }

  it('fires once when crossing the 70% threshold, with the crossing ratio in the text', () => {
    const { bus, hook } = hookWithRatio([0.8])
    hook.run(makeCtx(1))
    const out = bus.render()
    assert.match(out, /跨越 70% 阈值/)
    assert.match(out, /当前 80%/)
  })

  it('does NOT submit when ratio is below 70%', () => {
    const { bus, hook } = hookWithRatio([0.5])
    hook.run(makeCtx(1))
    assert.equal(bus.render(), '')
  })

  it('does NOT submit when estimatedTokens is 0', () => {
    const { bus, hook } = hookWithRatio([0])
    hook.run(makeCtx(1))
    assert.equal(bus.render(), '')
  })

  it('staying above the threshold does NOT re-fire on later turns (no per-turn fill% churn)', () => {
    const { bus, hook } = hookWithRatio([0.75, 0.78, 0.81])
    hook.run(makeCtx(1))
    hook.run(makeCtx(2))
    hook.run(makeCtx(3))
    const submissions = bus.render() + bus.render(undefined, 2) + bus.render(undefined, 3)
    const count = (submissions.match(/key="context-pressure"/g) || []).length
    assert.equal(count, 1, 'same threshold must fire exactly once while continuously above it')
  })

  it('escalates once more when crossing the 86% split line', () => {
    const bus = new AdvisoryBus()
    const ratios = [0.75, 0.9]
    let call = 0
    const hook = createContextPressureHook({
      advisoryBus: bus,
      getEstimatedTokens: () => Math.round(ratios[Math.min(call++, ratios.length - 1)]! * 100_000),
      getContextWindow: () => 100_000,
    })
    hook.run(makeCtx(1))
    const first = bus.render(undefined, 1)
    assert.match(first, /跨越 70% 阈值/)
    hook.run(makeCtx(2))
    const second = bus.render(undefined, 2)
    assert.match(second, /跨越 86% 阈值/)
    assert.match(second, /立即收束/)
  })

  it('re-arms after the ratio drops below threshold - hysteresis (compact happened)', () => {
    const bus = new AdvisoryBus()
    const ratios = [0.75, 0.5, 0.75]
    let call = 0
    const hook = createContextPressureHook({
      advisoryBus: bus,
      getEstimatedTokens: () => Math.round(ratios[Math.min(call++, ratios.length - 1)]! * 100_000),
      getContextWindow: () => 100_000,
    })
    hook.run(makeCtx(1))
    assert.match(bus.render(undefined, 1), /跨越 70% 阈值/)
    hook.run(makeCtx(2)) // dropped to 50% — re-arms, no emission
    assert.equal(bus.render(undefined, 2), '')
    hook.run(makeCtx(3)) // crossed again after compact
    assert.match(bus.render(undefined, 3), /跨越 70% 阈值/)
  })
})
