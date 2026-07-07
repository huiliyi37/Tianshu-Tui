import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { getHeapStatistics } from 'node:v8'
import { DEFAULT_SESSION_BYTE_LIMIT, ResourceSensor } from '../resource-sensor.js'

describe('ResourceSensor', () => {
  it('samples memory with configured limit', () => {
    const sensor = new ResourceSensor({
      memoryLimitBytes: 1_000,
      memoryUsage: () => ({ rss: 700, heapUsed: 300 }),
      now: () => 123,
    })

    const sample = sensor.sampleMemory()

    assert.deepEqual(sample, {
      timestamp: 123,
      rssBytes: 700,
      heapUsedBytes: 300,
      memoryLimitBytes: 1_000,
    })
  })

  it('computes positive memory trend', () => {
    let rss = 100
    const sensor = new ResourceSensor({
      memoryLimitBytes: 1_000,
      memoryUsage: () => ({ rss: rss += 100, heapUsed: rss / 2 }),
    })

    sensor.sampleMemory()
    sensor.sampleMemory()
    sensor.sampleMemory()

    assert.ok(sensor.memoryTrendBytesPerSample() > 0)
  })

  it('samples session file size for disk sensor', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rivet-resource-sensor-'))
    try {
      const path = join(dir, 'session.jsonl')
      writeFileSync(path, 'x'.repeat(42))
      const sensor = new ResourceSensor({ sessionByteLimit: 100, now: () => 456 })

      const disk = sensor.sampleDisk(path)

      assert.deepEqual(disk, {
        timestamp: 456,
        sessionBytes: 42,
        sessionByteLimit: 100,
        path,
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('uses 50MB as default session byte limit', () => {
    assert.equal(DEFAULT_SESSION_BYTE_LIMIT, 50 * 1024 * 1024)
  })

  it('defaults memoryLimitBytes to the real V8 heap ceiling (not a hardcoded 1GB)', () => {
    const prev = process.env.RIVET_MEMORY_LIMIT_BYTES
    delete process.env.RIVET_MEMORY_LIMIT_BYTES
    try {
      const sensor = new ResourceSensor({ memoryUsage: () => ({ rss: 1, heapUsed: 1 }) })
      const sample = sensor.sampleMemory()
      const v8Limit = getHeapStatistics().heap_size_limit
      // Must track the real ceiling so heapRatio/rssRatio reflect the actual
      // crash point — otherwise every memory-pressure signal is decoupled.
      assert.equal(sample.memoryLimitBytes, v8Limit)
      assert.ok(sample.memoryLimitBytes > 0)
    } finally {
      if (prev === undefined) delete process.env.RIVET_MEMORY_LIMIT_BYTES
      else process.env.RIVET_MEMORY_LIMIT_BYTES = prev
    }
  })

  it('honours RIVET_MEMORY_LIMIT_BYTES override over the V8 ceiling', () => {
    const prev = process.env.RIVET_MEMORY_LIMIT_BYTES
    process.env.RIVET_MEMORY_LIMIT_BYTES = '777'
    try {
      const sensor = new ResourceSensor({ memoryUsage: () => ({ rss: 1, heapUsed: 1 }) })
      assert.equal(sensor.sampleMemory().memoryLimitBytes, 777)
    } finally {
      if (prev === undefined) delete process.env.RIVET_MEMORY_LIMIT_BYTES
      else process.env.RIVET_MEMORY_LIMIT_BYTES = prev
    }
  })
})
