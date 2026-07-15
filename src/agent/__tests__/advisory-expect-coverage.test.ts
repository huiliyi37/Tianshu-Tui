import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { AdvisoryBus, type AdvisoryEntry } from '../advisory-bus.js'
import { AdvisoryReadback } from '../advisory-readback.js'
import { createKickRuntimeHook } from '../hooks/kick-hook.js'
import { createCourageHook } from '../hooks/courage-hook.js'
import { createDedupGuardHook } from '../hooks/dedup-guard-hook.js'
import { createContextPressureHook } from '../hooks/context-pressure-hook.js'
import { createLossyObservationHook } from '../hooks/lossy-observation-hook.js'
import type { RuntimeHookContext } from '../runtime-hooks.js'
import type { Sensorium } from '../sensorium.js'

/**
 * W3-C2: expect coverage audit for the five priority advisory keys.
 *
 * Policy (from the plan):
 *   - MUST have expect: entries demanding observable tool/verify/file action.
 *   - MAY omit expect: informational/status entries or ones with no unique
 *     attribution (dedup-guard, context-pressure, lossy-observation).
 *   - FORBIDDEN: overly-wide pseudo-expects added just for coverage.
 *
 * Reuses the existing AdvisoryBus/AdvisoryReadback lifecycle — no second
 * ledger, no new cooldown constants.
 */

function captureBus(): { bus: AdvisoryBus; submitted: AdvisoryEntry[] } {
  const bus = new AdvisoryBus()
  const submitted: AdvisoryEntry[] = []
  const origSubmit = bus.submit.bind(bus)
  bus.submit = (entry: AdvisoryEntry) => { submitted.push(entry); origSubmit(entry) }
  return { bus, submitted }
}

function hookCtx(turn: number, overrides: Partial<RuntimeHookContext['snapshot']> = {}): RuntimeHookContext {
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
      ...overrides,
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
      markClaimStale: () => {},
    },
  } as RuntimeHookContext
}

const STALLED_SENSORIUM = { momentum: 0.1, stability: 0.1, pressure: 0.5 } as unknown as Sensorium

describe('W3-C2 expect eligibility inventory (five audited keys)', () => {
  it('dissipative-kick carries the documented tools:[] deadlock-broken expect', async () => {
    const { bus, submitted } = captureBus()
    const hook = createKickRuntimeHook({ deposit: async () => {}, advisoryBus: bus })
    await hook.run(hookCtx(5, { sensorium: STALLED_SENSORIUM }))
    const entry = submitted.find(e => e.key === 'dissipative-kick')
    assert.ok(entry, 'kick must submit under stagnation')
    assert.deepEqual(entry!.expect, { kind: 'tool_appears', tools: [], withinTurns: 2 })
  })

  it('courage constitutional arm carries a read-verification expect; risk arm has none', () => {
    const { bus, submitted } = captureBus()
    const constitutionalHook = createCourageHook({
      advisoryBus: bus,
      sycophancyTrap: { shouldInjectChallenge: () => true },
    })
    constitutionalHook.run(hookCtx(3))
    const constitutional = submitted.find(e => e.key === 'courage')
    assert.ok(constitutional)
    assert.equal(constitutional!.tier, 'constitutional')
    assert.equal(constitutional!.expect?.kind, 'tool_appears')
    assert.ok((constitutional!.expect as { tools: string[] }).tools.includes('read_file'))

    // Risk arm: text-only obligation → deliberately no expect.
    const { bus: bus2, submitted: submitted2 } = captureBus()
    const riskHook = createCourageHook({ advisoryBus: bus2 })
    riskHook.run(hookCtx(9, {
      recentToolHistory: [
        { tool: 'bash', status: 'failed', target: 'npm test failed' },
        { tool: 'bash', status: 'failed', target: 'type error' },
        { tool: 'read_file', status: 'success', target: 'src/a.ts' },
      ],
    }))
    const risk = submitted2.find(e => e.key === 'courage')
    assert.ok(risk, 'risk arm must fire on failure-heavy history')
    assert.equal(risk!.expect, undefined, 'text-only obligation must not carry a pseudo-expect')
  })

  it('dedup-guard / context-pressure / lossy-observation deliberately omit expect', () => {
    const { bus, submitted } = captureBus()

    // dedup-guard: text-level repetition, no unique tool signature.
    let prev: string | null = 'A'.repeat(600)
    const dedup = createDedupGuardHook({
      getStreamedText: () => 'A'.repeat(600),
      getPrevStreamedText: () => prev,
      setPrevStreamedText: t => { prev = t },
      advisoryBus: bus,
    })
    dedup.run(hookCtx(2))

    // context-pressure: status explanation → informational tier, no expect.
    const pressure = createContextPressureHook({
      getEstimatedTokens: () => 90_000,
      getContextWindow: () => 100_000,
      advisoryBus: bus,
    })
    pressure.run(hookCtx(2))

    // lossy-observation: suggested tools appear in normal flow anyway.
    const lossy = createLossyObservationHook({ advisoryBus: bus })
    lossy.run(hookCtx(2), {
      name: 'bash',
      success: true,
      resultContent: '[stdout truncated: output exceeded 32KB, showing last 24KB]\nbody',
    })

    const byKey = new Map(submitted.map(e => [e.key, e]))
    assert.ok(byKey.has('dedup-guard'))
    assert.ok(byKey.has('context-pressure'))
    assert.ok(byKey.has('lossy-observation'))
    for (const key of ['dedup-guard', 'context-pressure', 'lossy-observation']) {
      assert.equal(byKey.get(key)!.expect, undefined, `${key} must not carry a pseudo-expect`)
    }
    assert.equal(byKey.get('context-pressure')!.tier, 'informational')
  })
})

describe('W3-C2 kick expect lifecycle: adopted / ignored / holdout', () => {
  function deliverKick(readback: AdvisoryReadback, turn: number, shadow = false): void {
    readback.track([
      {
        key: 'dissipative-kick',
        category: 'discipline',
        tier: 'operational',
        expect: { kind: 'tool_appears', tools: [], withinTurns: 2 },
        ...(shadow ? { shadow: true } : {}),
      },
    ], turn)
  }

  it('adopted: any tool call within the window breaks the deadlock', () => {
    const readback = new AdvisoryReadback(() => null)
    deliverKick(readback, 5)
    readback.observeTool({ name: 'grep', target: 'src/', turn: 6, isError: false })
    readback.evaluate(6)
    const stats = readback.getStats().get('dissipative-kick')!
    assert.equal(stats.adopted, 1)
    assert.equal(stats.ignored, 0)
  })

  it('ignored: window expires with zero tool activity', () => {
    const readback = new AdvisoryReadback(() => null)
    deliverKick(readback, 5)
    readback.evaluate(6)
    readback.evaluate(7)
    const stats = readback.getStats().get('dissipative-kick')!
    assert.equal(stats.adopted, 0)
    assert.equal(stats.ignored, 1)
  })

  it('holdout: shadow delivery books into the counterfactual bucket only', () => {
    const readback = new AdvisoryReadback(() => null)
    deliverKick(readback, 5, true)
    readback.observeTool({ name: 'bash', target: 'npm test', turn: 5, isError: false })
    readback.evaluate(5)
    const stats = readback.getStats().get('dissipative-kick')!
    assert.equal(stats.shadowHeld, 1)
    assert.equal(stats.shadowSatisfied, 1)
    assert.equal(stats.adopted, 0, 'shadow outcomes never pollute the adopted bucket')
  })
})

describe('W3-C2 courage constitutional expect lifecycle: adopted / ignored / holdout', () => {
  const COURAGE_EXPECT = { kind: 'tool_appears' as const, tools: ['read_file', 'read_section', 'grep'], withinTurns: 2 }

  function deliverCourage(readback: AdvisoryReadback, turn: number, shadow = false): void {
    readback.track([
      { key: 'courage', category: 'constitutional', tier: 'constitutional', expect: COURAGE_EXPECT, ...(shadow ? { shadow: true } : {}) },
    ], turn)
  }

  it('adopted: a substantive read within the window fulfils the obligation', () => {
    const readback = new AdvisoryReadback(() => null)
    deliverCourage(readback, 3)
    readback.observeTool({ name: 'read_file', target: 'src/agent/loop.ts', turn: 4, isError: false })
    readback.evaluate(4)
    assert.equal(readback.getStats().get('courage')!.adopted, 1)
  })

  it('ignored: only non-read tools appear before the deadline', () => {
    const readback = new AdvisoryReadback(() => null)
    deliverCourage(readback, 3)
    readback.observeTool({ name: 'bash', target: 'echo done', turn: 3, isError: false })
    readback.observeTool({ name: 'write_file', target: 'src/x.ts', turn: 4, isError: false })
    readback.evaluate(3)
    readback.evaluate(4)
    const stats = readback.getStats().get('courage')!
    assert.equal(stats.adopted, 0)
    assert.equal(stats.ignored, 1)
  })

  it('holdout: shadow delivery with a spontaneous read books shadowSatisfied', () => {
    const readback = new AdvisoryReadback(() => null)
    deliverCourage(readback, 3, true)
    readback.observeTool({ name: 'grep', target: 'pattern src/', turn: 3, isError: false })
    readback.evaluate(3)
    const stats = readback.getStats().get('courage')!
    assert.equal(stats.shadowSatisfied, 1)
    assert.equal(stats.adopted, 0)
  })
})
