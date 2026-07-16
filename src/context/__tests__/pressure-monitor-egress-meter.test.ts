import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { PressureMonitor } from '../pressure-monitor.js'
import { BlockChargeTracker } from '../../agent/injection-meter.js'

/**
 * W2-B1: egress metering — every injected request byte books under exactly
 * one source tag, and the per-source ledger sums to the existing accumulator
 * (identity check). Block sources follow appendixDelta semantics (charge on
 * change, zero at steady state); append sources charge once per commit.
 */

describe('PressureMonitor per-source injection ledger (W2-B1)', () => {
  it('books advisory/SR/runtime-payload separately and the sum equals the total', () => {
    const pm = new PressureMonitor(100_000)
    // Plan self-check: 100-char advisory + 80-char SR + 120-char payload in one turn.
    pm.recordCvmInjection(Math.ceil(100 / 4), 'advisory-appendix')
    pm.recordCvmInjection(Math.ceil(80 / 4), 'system-reminder')
    pm.recordCvmInjection(Math.ceil(120 / 4), 'runtime-payload')

    const bySource = pm.getCvmInjectionBySource()
    assert.equal(bySource['advisory-appendix'], 25)
    assert.equal(bySource['system-reminder'], 20)
    assert.equal(bySource['runtime-payload'], 30)

    const sum = Object.values(bySource).reduce((a, b) => a + (b ?? 0), 0)
    assert.equal(sum, 75, 'per-source ledger must sum to the charged total')
    // Identity with the legacy accumulator (overhead ratio path).
    assert.equal(pm.getCvmOverheadRatio(), 75 / 100_000)
  })

  it('untagged calls keep legacy behavior (default projection source)', () => {
    const pm = new PressureMonitor(100_000)
    pm.recordCvmInjection(40)
    assert.equal(pm.getCvmInjectionBySource()['projection'], 40)
    assert.equal(pm.getCvmOverheadRatio(), 40 / 100_000)
  })

  it('control-appendix (Wave 4) books as its own source — never merged into advisory-appendix', () => {
    const pm = new PressureMonitor(100_000)
    pm.recordCvmInjection(25, 'advisory-appendix')
    pm.recordCvmInjection(15, 'control-appendix')
    const bySource = pm.getCvmInjectionBySource()
    assert.equal(bySource['advisory-appendix'], 25)
    assert.equal(bySource['control-appendix'], 15)
    const sum = Object.values(bySource).reduce((a, b) => a + (b ?? 0), 0)
    assert.equal(sum, 40, 'identity holds with the new source in the union')
    assert.equal(pm.getCvmOverheadRatio(), 40 / 100_000)
  })

  it('resetCvmOverhead clears the total AND the per-source ledger together', () => {
    const pm = new PressureMonitor(100_000)
    pm.recordCvmInjection(25, 'advisory-appendix')
    pm.recordCvmInjection(10, 'system-reminder')
    pm.resetCvmOverhead()
    assert.equal(pm.getCvmOverheadRatio(), 0)
    assert.deepEqual(pm.getCvmInjectionBySource(), {}, 'stale per-source rows would break the sum identity')
  })
})

describe('BlockChargeTracker appendixDelta semantics (W2-B1)', () => {
  it('charges full bytes on entry, zero at steady state, full again on change', () => {
    const tracker = new BlockChargeTracker()
    const block = 'A'.repeat(100)

    assert.equal(tracker.charge(block), 100, 'entry pays once')
    assert.equal(tracker.charge(block), 0, 'second render with no change must charge 0')
    assert.equal(tracker.charge(block), 0, 'steady state stays free')

    const changed = 'B'.repeat(60)
    assert.equal(tracker.charge(changed), 60, 'changed block pays its new bytes')
    assert.equal(tracker.charge(changed), 0)
  })

  it('empty block charges nothing and does not disturb the baseline logic', () => {
    const tracker = new BlockChargeTracker()
    assert.equal(tracker.charge(''), 0)
    assert.equal(tracker.charge('X'), 1)
    assert.equal(tracker.charge(''), 0, 'clearing the block re-sends nothing chargeable')
    assert.equal(tracker.charge('X'), 1, 're-entry after clear pays again')
  })

  it('compact boundary reset makes the next render pay full entry cost again', () => {
    const tracker = new BlockChargeTracker()
    const block = 'C'.repeat(80)
    tracker.charge(block)
    assert.equal(tracker.charge(block), 0)
    // Compact resets the appendix baseline → bytes re-enter the request.
    tracker.reset()
    assert.equal(tracker.charge(block), 80, 'unmetered re-entry would under-report overhead')
  })
})
