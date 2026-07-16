/**
 * Wave 2 — control-plane adapters against the REAL AdvisoryBus.
 *
 * Locks the drain tee contract: single drain → immutable snapshot →
 * multi-dispatch. Two consumers must see the same snapshot and a second
 * drain must be empty (one-shot consumption boundary).
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { AdvisoryBus } from '../advisory-bus.js'
import {
  ControlPlaneController,
  controlPlaneMode,
  signalFromLedgerDelta,
  signalsFromDelivered,
} from '../control-plane-adapters.js'
import { routeFor } from '../control-plane.js'

describe('control-plane drain tee (real AdvisoryBus)', () => {
  it('single drain → same snapshot for both consumers; second drain is empty', () => {
    const bus = new AdvisoryBus()
    bus.submit({ key: 'self-verify', priority: 0.8, category: 'discipline', content: '先验证再断言', immediate: true })
    bus.submit({ key: 'dedup-guard', priority: 0.7, category: 'dedup', content: '重复输出', immediate: true })
    const rendered = bus.render(undefined, 3)
    assert.ok(rendered && rendered.length > 0)

    const snapshot = bus.drainDelivered()
    assert.equal(snapshot.length, 2)

    // consumer 1: readback-style — reads keys from the snapshot
    const readbackKeys = snapshot.map(d => d.key).sort()
    // consumer 2: control adapter — maps the SAME snapshot
    const signals = signalsFromDelivered(snapshot)
    assert.deepEqual(signals.map(s => s.key).sort(), readbackKeys.map(k => `advisory:delivered:${k}`).sort())

    // one-shot boundary: adapter never drains on its own; a second drain is empty
    assert.deepEqual(bus.drainDelivered(), [])
  })

  it('ledger delta maps to a single silent signal; drainLedger resets counters', () => {
    const bus = new AdvisoryBus()
    bus.submit({ key: 'a', priority: 0.5, category: 'discipline', content: 'x', immediate: true })
    bus.render(undefined, 1)
    const delta = bus.drainLedger()
    assert.ok(delta.submitted >= 1)

    const signal = signalFromLedgerDelta(delta)
    assert.ok(signal)
    assert.equal(routeFor(signal), 'silent')
    assert.match(signal.summary, /submitted=\d+ rendered=\d+ dropped=\d+/)

    const second = bus.drainLedger()
    assert.equal(second.submitted, 0)
    assert.equal(signalFromLedgerDelta(second), null)
  })

  it('delivered advisories route silent — lifecycle facts never re-enter the prompt', () => {
    const signals = signalsFromDelivered([
      { key: 'kick', category: 'discipline' },
      { key: 'courage', category: 'constitutional', shadow: true },
    ])
    for (const s of signals) {
      assert.equal(routeFor(s), 'silent')
      assert.equal(s.cacheImpact, 'none')
      assert.equal(s.ttlTurns, 1)
    }
    assert.match(signals[1]?.summary ?? '', /holdout-shadow/)
  })
})

describe('ControlPlaneController modes', () => {
  it('off mode ignores submissions and keeps an empty frame', () => {
    const controller = new ControlPlaneController('off')
    controller.submit({
      key: 'x', kind: 'advisory', severity: 'blocking', summary: 's',
      requiresDecision: true, ttlTurns: 3, cacheImpact: 'none',
    })
    const frame = controller.reduceTurn()
    assert.equal(frame.signals.length, 0)
    assert.equal(frame.revision, 0)
  })

  it('shadow mode reduces once per turn and ticks TTL at the merge step', () => {
    const controller = new ControlPlaneController('shadow')
    controller.submit({
      key: 'w', kind: 'worker', severity: 'attention', summary: 'worker needs review',
      requiresDecision: false, ttlTurns: 2, cacheImpact: 'none',
    })
    const t1 = controller.reduceTurn()
    assert.equal(t1.signals.length, 1)
    const t2 = controller.reduceTurn() // tick 2→1, still alive
    assert.equal(t2.signals.length, 1)
    const t3 = controller.reduceTurn() // tick 1→0, dropped
    assert.equal(t3.signals.length, 0)
  })

  it('controlPlaneMode: default shadow; off/0 → off; active → active', () => {
    assert.equal(controlPlaneMode({}), 'shadow')
    assert.equal(controlPlaneMode({ RIVET_CONTROL_PLANE: 'off' }), 'off')
    assert.equal(controlPlaneMode({ RIVET_CONTROL_PLANE: '0' }), 'off')
    assert.equal(controlPlaneMode({ RIVET_CONTROL_PLANE: 'active' }), 'active')
    assert.equal(controlPlaneMode({ RIVET_CONTROL_PLANE: 'garbage' }), 'shadow')
  })
})
