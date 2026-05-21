import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createTelemetryWriter } from '../telemetry-writer.js'
import type { PerceptionTelemetrySnapshot } from '../perception.js'
import { buildTelemetrySnapshot } from '../perception.js'

function makeSnapshot(turn = 1): PerceptionTelemetrySnapshot {
  return buildTelemetrySnapshot({
    ts: 1000,
    turn,
    phase: 'tianxuan-locating',
    sensorium: {
      momentum: 0.5,
      pressure: 0.1,
      confidence: 0.8,
      complexity: 0.3,
      freshness: 0.6,
      stability: 1.0,
    },
    strategy: {
      reasoningEffort: 'medium',
      shouldEscalate: false,
      thetaCycleInterval: 7,
      explorationBreadth: 0.5,
      commitThreshold: 0.5,
    },
    vigor: {
      tonic: 0.5,
      phasic: 0.3,
      curiosity: 0.4,
      vigor: 0.6,
      variability: 0.2,
      history: [],
    },
    theta: {
      inFlight: false,
      lastReason: null,
      lastDurationMs: null,
      lastErrorCount: 0,
      lastTimedOut: false,
      requestedCount: 0,
    },
    gitChangeRate: 0,
    prefixDrift: false,
  })
}

describe('createTelemetryWriter', () => {
  let cwd: string

  before(() => {
    cwd = mkdtempSync(join(tmpdir(), 'rivet-telemetry-writer-'))
  })

  after(() => {
    rmSync(cwd, { recursive: true, force: true })
  })

  it('writes sensorium snapshot as JSONL line', async () => {
    const writer = createTelemetryWriter(cwd)
    const snapshot = makeSnapshot()

    writer.write(snapshot)
    await writer.flush()

    const raw = readFileSync(join(cwd, '.rivet', 'sensorium.jsonl'), 'utf-8')
    const lines = raw.trim().split('\n')
    assert.equal(lines.length, 1)
    const parsed = JSON.parse(lines[0]!)
    assert.equal(parsed.turn, 1)
    assert.equal(parsed.phase, 'tianxuan-locating')
  })

  it('appends multiple snapshots', async () => {
    const writer = createTelemetryWriter(cwd)
    writer.write(makeSnapshot(1))
    writer.write(makeSnapshot(2))
    await writer.flush()

    const raw = readFileSync(join(cwd, '.rivet', 'sensorium.jsonl'), 'utf-8')
    const lines = raw.trim().split('\n')
    assert.ok(lines.length >= 2, `expected >=2 lines, got ${lines.length}`)
  })

  it('does not throw on write failure (graceful degradation)', () => {
    // Write to an invalid path under /dev/null-like location
    const writer = createTelemetryWriter('/dev/null')
    assert.doesNotThrow(() => writer.write(makeSnapshot()))
  })
})
