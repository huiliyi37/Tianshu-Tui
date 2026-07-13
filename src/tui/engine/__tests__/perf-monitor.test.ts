import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  TuiPerfMonitor,
  isTuiPerfEnabled,
  type EventLoopHistogram,
} from '../perf-monitor.js'

function fakeHistogram(): EventLoopHistogram & {
  enabled: number
  disabled: number
  resets: number
} {
  return {
    enabled: 0,
    disabled: 0,
    resets: 0,
    max: 8_000_000,
    enable() { this.enabled++ },
    disable() { this.disabled++ },
    reset() { this.resets++ },
    percentile(p) {
      return p === 99 ? 5_000_000 : 0
    },
  }
}

test('perf monitor is enabled only by explicit debug gates', () => {
  assert.equal(isTuiPerfEnabled([], {}), false)
  assert.equal(isTuiPerfEnabled(['--debug-perf'], {}), true)
  assert.equal(isTuiPerfEnabled([], { RIVET_DEBUG_TELEMETRY: '1' }), true)
  assert.equal(isTuiPerfEnabled([], { RIVET_DEBUG_TELEMETRY: 'true' }), false)
})

test('disabled monitor never instantiates histogram and stays no-op', () => {
  let histogramFactories = 0
  const monitor = new TuiPerfMonitor({
    enabled: false,
    createHistogram: () => {
      histogramFactories++
      return fakeHistogram()
    },
  })

  monitor.record('delta', 12)
  monitor.recordCache(true)
  const result = monitor.measure('renderLive', () => 42)

  assert.equal(result, 42)
  assert.equal(histogramFactories, 0)
  assert.equal(monitor.enabled, false)
  assert.equal(monitor.summary(), undefined)
})

test('enabled monitor reports sample percentiles, counts, cache, and loop lag', () => {
  const histogram = fakeHistogram()
  const monitor = new TuiPerfMonitor({
    enabled: true,
    createHistogram: () => histogram,
  })

  for (const value of [1, 2, 3, 4, 100]) monitor.record('renderLive', value)
  monitor.record('delta', 7)
  monitor.record('formatMarkdown', 9)
  monitor.record('flush', 11)
  monitor.recordCache(true)
  monitor.recordCache(false)

  const summary = monitor.summary()
  assert.ok(summary)
  assert.equal(summary.kind, 'perf-summary')
  assert.deepEqual(summary.samples.renderLive, { count: 5, p50Ms: 3, p99Ms: 100, maxMs: 100 })
  assert.deepEqual(summary.samples.delta, { count: 1, p50Ms: 7, p99Ms: 7, maxMs: 7 })
  assert.deepEqual(summary.cache, { hits: 1, misses: 1 })
  assert.deepEqual(summary.loopLag, { p99Ms: 5, maxMs: 8 })
  assert.equal(histogram.enabled, 1)

  monitor.stop()
  assert.equal(histogram.disabled, 1)
})

test('loop lag snapshot is windowed and resets without a timer', () => {
  const histogram = fakeHistogram()
  let now = 0
  const monitor = new TuiPerfMonitor({
    enabled: true,
    now: () => now,
    createHistogram: () => histogram,
  })

  assert.deepEqual(monitor.getLoopLagWindow(1000), { p99Ms: 5, maxMs: 8 })
  assert.equal(histogram.resets, 1)
  now = 500
  assert.deepEqual(monitor.getLoopLagWindow(1000), { p99Ms: 5, maxMs: 8 })
  assert.equal(histogram.resets, 1, 'cached window should not reset early')
  now = 1000
  monitor.getLoopLagWindow(1000)
  assert.equal(histogram.resets, 2)
})
