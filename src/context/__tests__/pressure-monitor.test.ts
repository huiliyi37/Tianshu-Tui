import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { PressureMonitor } from '../pressure-monitor.js'

describe('PressureMonitor', () => {
  it('returns tier 0 when under 60%', () => {
    const pm = new PressureMonitor(100_000)
    const result = pm.check(50_000, 5)

    assert.equal(result.tier, 0)
    assert.equal(result.shouldCompact, false)
  })

  it('returns tier 2 at 80% utilization', () => {
    const pm = new PressureMonitor(100_000)
    const result = pm.check(80_000, 5)

    assert.equal(result.tier, 2)
    assert.equal(result.shouldCompact, true)
  })

  it('detects thrashing when compact frequency is high', () => {
    const pm = new PressureMonitor(100_000)
    pm.recordCompaction(1)
    pm.recordCompaction(2)
    pm.recordCompaction(3)
    const result = pm.check(70_000, 4)

    assert.equal(result.thrashing, true)
  })

  it('suggests task decomposition when thrashing', () => {
    const pm = new PressureMonitor(100_000)
    pm.recordCompaction(1)
    pm.recordCompaction(2)
    pm.recordCompaction(3)
    const result = pm.check(70_000, 4)

    assert.equal(result.suggestion, 'task_decomposition')
  })
})
