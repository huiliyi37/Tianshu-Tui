import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ResourceSensor } from '../resource-sensor.js'
import { classifyResourcePressure } from '../recovery-trigger.js'
import { modeForRecoveryTrigger } from '../reliability-mode.js'

describe('ResourceSensor session-boundary cooldown', () => {
  it('starts in cooldown and suppresses absolute heap pressure', () => {
    const sensor = new ResourceSensor({
      memoryLimitBytes: 1000,
      memoryUsage: () => ({ rss: 950, heapUsed: 950 }),
      initialMemoryCooldownSamples: 3,
    })

    const snap = sensor.sample()
    assert.equal(snap.memoryCooldownActive, true)
    assert.equal(snap.memory.heapUsedBytes, 950)

    const trigger = classifyResourcePressure({
      rssBytes: snap.memory.rssBytes,
      heapUsedBytes: snap.memory.heapUsedBytes,
      memoryLimitBytes: snap.memory.memoryLimitBytes,
      sessionBytes: 0,
      sessionByteLimit: Number.POSITIVE_INFINITY,
      suppressAbsoluteMemoryPressure: snap.memoryCooldownActive,
    })
    assert.equal(trigger, null, 'high heap during cooldown must not fire resource_pressure')
  })

  it('reset() re-arms cooldown so residual heap cannot lock a new session to minimal', () => {
    const sensor = new ResourceSensor({
      memoryLimitBytes: 1000,
      memoryUsage: () => ({ rss: 950, heapUsed: 950 }),
      initialMemoryCooldownSamples: 2,
    })

    // Exhaust initial cooldown
    sensor.sampleMemory()
    sensor.sampleMemory()
    assert.equal(sensor.isMemoryCooldownActive(), false)

    const hot = classifyResourcePressure({
      rssBytes: 950,
      heapUsedBytes: 950,
      memoryLimitBytes: 1000,
      sessionBytes: 0,
      sessionByteLimit: Number.POSITIVE_INFINITY,
      suppressAbsoluteMemoryPressure: false,
    })
    assert.equal(hot?.severity, 'error')
    assert.equal(modeForRecoveryTrigger(hot).mode, 'minimal')

    // New session boundary
    sensor.reset()
    assert.equal(sensor.isMemoryCooldownActive(), true)
    const cooled = classifyResourcePressure({
      rssBytes: 950,
      heapUsedBytes: 950,
      memoryLimitBytes: 1000,
      sessionBytes: 0,
      sessionByteLimit: Number.POSITIVE_INFINITY,
      suppressAbsoluteMemoryPressure: true,
    })
    assert.equal(cooled, null)
    assert.equal(modeForRecoveryTrigger(cooled).mode, 'full')
  })

  it('disk pressure still fires during memory cooldown', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rivet-sensor-disk-'))
    try {
      const path = join(dir, 'session.jsonl')
      writeFileSync(path, 'x'.repeat(200))
      const sensor = new ResourceSensor({
        sessionByteLimit: 100,
        memoryUsage: () => ({ rss: 950, heapUsed: 950 }),
        memoryLimitBytes: 1000,
        initialMemoryCooldownSamples: 5,
      })
      const snap = sensor.sample(path)
      assert.equal(snap.memoryCooldownActive, true)
      const trigger = classifyResourcePressure({
        rssBytes: snap.memory.rssBytes,
        heapUsedBytes: snap.memory.heapUsedBytes,
        memoryLimitBytes: snap.memory.memoryLimitBytes,
        sessionBytes: snap.disk!.sessionBytes,
        sessionByteLimit: snap.disk!.sessionByteLimit,
        suppressAbsoluteMemoryPressure: true,
      })
      assert.ok(trigger)
      assert.equal(trigger!.trigger, 'resource_pressure')
      assert.equal(trigger!.severity, 'error')
      assert.ok(trigger!.evidence.some(e => e.includes('Session JSONL')))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('sums sibling claims into disk sample', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rivet-sensor-sum-'))
    try {
      const path = join(dir, 's.jsonl')
      writeFileSync(path, 'a'.repeat(40))
      writeFileSync(join(dir, 's.claims.jsonl'), 'b'.repeat(10))
      const sensor = new ResourceSensor({ sessionByteLimit: 1000 })
      const disk = sensor.sampleDisk(path)
      assert.equal(disk.sessionBytes, 50)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
