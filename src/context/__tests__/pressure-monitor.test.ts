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

  it('suggests task decomposition when thrashing AND context is under pressure', () => {
    const pm = new PressureMonitor(100_000)
    pm.recordCompaction(1)
    pm.recordCompaction(2)
    pm.recordCompaction(3)
    const result = pm.check(70_000, 4)

    assert.equal(result.thrashing, true)
    assert.equal(result.suggestion, 'task_decomposition')
  })

  it('does NOT suggest task decomposition when thrashing but context is small', () => {
    const pm = new PressureMonitor(100_000)
    pm.recordCompaction(1)
    pm.recordCompaction(2)
    pm.recordCompaction(3)
    // After compaction context dropped to 30% — well below watch threshold
    const result = pm.check(30_000, 4)

    assert.equal(result.thrashing, true)
    assert.equal(result.suggestion, undefined)
  })

  // ── fastGrowth detection (原则⑥ 速率比阈值) ─────────────────

  it('reports fastGrowth when ratio jumps ≥0.15 in one turn', () => {
    const pm = new PressureMonitor(100_000)
    pm.check(50_000, 1)  // 0.50 — baseline
    const result = pm.check(70_000, 2)  // 0.70 — +0.20 jump
    assert.equal(result.fastGrowth, true)
    assert.ok(result.growthRate >= 0.15)
  })

  it('does not flag fastGrowth for gradual increase', () => {
    const pm = new PressureMonitor(100_000)
    pm.check(50_000, 1)  // 0.50
    const result = pm.check(55_000, 2)  // 0.55 — +0.05
    assert.equal(result.fastGrowth, false)
  })

  it('growthRate is zero on first check (no history)', () => {
    const pm = new PressureMonitor(100_000)
    const result = pm.check(50_000, 1)
    assert.equal(result.growthRate, 0)
    assert.equal(result.fastGrowth, false)
  })

  it('tokenHistory window is capped at 20 entries', () => {
    const pm = new PressureMonitor(100_000)
    for (let i = 1; i <= 25; i++) {
      pm.check(50_000 + i * 100, i)
    }
    // Should not throw; internal window is capped
    const result = pm.check(80_000, 26)
    assert.ok(typeof result.growthRate === 'number')
  })

  it('thrashing detection still works alongside fastGrowth', () => {
    const pm = new PressureMonitor(100_000)
    pm.recordCompaction(1)
    pm.recordCompaction(2)
    pm.recordCompaction(3)
    // Use 70k so tier > 0 → suggestion should fire
    const result = pm.check(70_000, 5)
    assert.equal(result.thrashing, true)
    assert.equal(result.suggestion, 'task_decomposition')
  })
})
