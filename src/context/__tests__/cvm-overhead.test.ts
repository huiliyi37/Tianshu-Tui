import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { PressureMonitor, computeCvmOverhead } from '../../context/pressure-monitor.js'

// ─── 任务 12：CVM overhead 量化 + 自动节流 ───
// CVM 运行在 context window 上 — 它保护的资源就是它消耗的资源。
// 当 cvmOverhead / totalTokens > 5% 时自动节流。
// 当 > 8% 时硬停止所有非必要注入。

describe('CVM overhead — computeCvmOverhead', () => {
  it('calculates overhead ratio at exactly 5%', () => {
    const result = computeCvmOverhead({
      cvmInjectedTokens: 500,
      totalEstimatedTokens: 10000,
    })
    assert.equal(result.ratio, 0.05)
    assert.equal(result.shouldThrottle, true) // exactly 5% = borderline, throttle starts
  })

  it('triggers throttle above 5%', () => {
    const result = computeCvmOverhead({
      cvmInjectedTokens: 600,
      totalEstimatedTokens: 10000,
    })
    assert.equal(result.ratio, 0.06)
    assert.equal(result.shouldThrottle, true)
  })

  it('does not throttle below 5%', () => {
    const result = computeCvmOverhead({
      cvmInjectedTokens: 400,
      totalEstimatedTokens: 10000,
    })
    assert.equal(result.ratio, 0.04)
    assert.equal(result.shouldThrottle, false)
  })

  it('triggers hard ceiling above 8%', () => {
    const result = computeCvmOverhead({
      cvmInjectedTokens: 900,
      totalEstimatedTokens: 10000,
    })
    assert.equal(result.shouldHardStop, true)
  })

  it('does not hard-stop below 8%', () => {
    const result = computeCvmOverhead({
      cvmInjectedTokens: 700,
      totalEstimatedTokens: 10000,
    })
    assert.equal(result.shouldHardStop, false)
  })

  it('returns zero overhead when no CVM tokens', () => {
    const result = computeCvmOverhead({
      cvmInjectedTokens: 0,
      totalEstimatedTokens: 10000,
    })
    assert.equal(result.ratio, 0)
    assert.equal(result.shouldThrottle, false)
    assert.equal(result.shouldHardStop, false)
  })

  it('handles zero context window gracefully', () => {
    const result = computeCvmOverhead({
      cvmInjectedTokens: 100,
      totalEstimatedTokens: 0,
    })
    assert.equal(result.ratio, 0)
    assert.equal(result.shouldThrottle, false)
  })
})

describe('PressureMonitor — CVM overhead tracking', () => {
  function makeMonitor(contextWindow = 128_000) {
    return new PressureMonitor(contextWindow)
  }

  it('returns cvmOverheadRatio=0 with no injections', () => {
    const monitor = makeMonitor()
    const result = monitor.check(5000, 1)
    assert.equal(result.cvmOverheadRatio, 0)
    assert.equal(result.shouldThrottleCvm, false)
  })

  it('accumulates CVM injections across turns', () => {
    const monitor = makeMonitor(100_000)
    // Inject 3000 tokens of CVM overhead across multiple turns
    monitor.recordCvmInjection(1000)
    monitor.recordCvmInjection(1000)
    monitor.recordCvmInjection(1000)

    const result = monitor.check(20000, 5)
    assert.equal(result.cvmOverheadRatio, 0.03) // 3000 / 100000
    assert.equal(result.shouldThrottleCvm, false) // below 5%
  })

  it('triggers CVM throttle when overhead exceeds 5%', () => {
    const monitor = makeMonitor(100_000)
    // Inject 6000 tokens — 6% of context window
    monitor.recordCvmInjection(6000)

    const result = monitor.check(20000, 5)
    assert.equal(result.cvmOverheadRatio, 0.06)
    assert.equal(result.shouldThrottleCvm, true)
  })

  it('resets CVM overhead counter', () => {
    const monitor = makeMonitor(100_000)
    monitor.recordCvmInjection(10000)
    monitor.resetCvmOverhead()

    const result = monitor.check(20000, 5)
    assert.equal(result.cvmOverheadRatio, 0)
  })

  it('detects CVM throttling ceiling at 8%', () => {
    const monitor = makeMonitor(100_000)
    monitor.recordCvmInjection(9000)

    assert.equal(monitor.isCvmThrottlingCeiling(), true)
  })

  it('getCvmOverheadRatio returns current ratio', () => {
    const monitor = makeMonitor(50_000)
    monitor.recordCvmInjection(2500)

    assert.equal(monitor.getCvmOverheadRatio(), 0.05)
  })

  it('coexists with existing pressure metrics', () => {
    const monitor = makeMonitor(128_000)
    monitor.recordCvmInjection(2000)

    const result = monitor.check(64_000, 10)
    // Existing metrics still work
    assert.equal(result.ratio, 0.5)
    assert.ok(typeof result.shouldCompact === 'boolean')
    assert.ok(typeof result.thrashing === 'boolean')
    assert.ok(typeof result.fastGrowth === 'boolean')
    // CVM metrics added
    assert.equal(result.cvmOverheadRatio, 2000 / 128_000)
  })
})
