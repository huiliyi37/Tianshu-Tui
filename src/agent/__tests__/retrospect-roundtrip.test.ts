import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { parseSensoriumLog, generateRetrospect } from '../retrospect.js'
import { buildTelemetrySnapshot } from '../perception.js'
import type { PerceptionTelemetrySnapshot } from '../perception.js'

function makeSnapshot(turn: number, phase: string, overrides: Partial<{
  momentum: number; pressure: number; confidence: number
  complexity: number; freshness: number; stability: number
}> = {}): PerceptionTelemetrySnapshot {
  return buildTelemetrySnapshot({
    ts: 1000 + turn,
    turn,
    phase,
    sensorium: {
      momentum: overrides.momentum ?? 0.5,
      pressure: overrides.pressure ?? 0.1,
      confidence: overrides.confidence ?? 0.8,
      complexity: overrides.complexity ?? 0.3,
      freshness: overrides.freshness ?? 0.6,
      stability: overrides.stability ?? 1.0,
    },
    strategy: {
      reasoningEffort: 'medium',
      shouldEscalate: false,
      thetaCycleInterval: 7,
      explorationBreadth: 0.5,
      commitThreshold: 0.5,
    },
    vigor: {
      tonic: 0.5, phasic: 0.3, curiosity: 0.4, vigor: 0.6, variability: 0.2, history: [],
    },
    theta: {
      inFlight: false, lastReason: null, lastDurationMs: null,
      lastErrorCount: 0, lastTimedOut: false, requestedCount: 0,
    },
    gitChangeRate: 0,
    prefixDrift: false,
  })
}

describe('retrospect round-trip (telemetry → parse → generate)', () => {
  it('round-trips: PerceptionTelemetrySnapshot → JSONL → parseSensoriumLog → generateRetrospect', () => {
    const snapshots = [
      makeSnapshot(1, 'tianxuan-locating'),
      makeSnapshot(2, 'yuheng-implementing', { momentum: 0.7, pressure: 0.2 }),
      makeSnapshot(3, 'yaoguang-verifying', { confidence: 0.9, freshness: 0.3 }),
    ]

    const jsonl = snapshots.map(s => JSON.stringify(s)).join('\n')
    const parsed = parseSensoriumLog(jsonl)

    assert.equal(parsed.length, 3, 'should parse all 3 snapshots')
    assert.equal(parsed[0]!.turn, 1)
    assert.equal(parsed[0]!.phase, 'tianxuan-locating')
    assert.equal(parsed[1]!.momentum, 0.7)
    assert.equal(parsed[2]!.confidence, 0.9)

    const report = generateRetrospect({
      sensoriumEntries: parsed,
      gitLog: ['abc feat: init'],
      toolEvents: [
        { turn: 1, name: 'read_file', status: 'passed' },
        { turn: 2, name: 'edit_file', status: 'passed' },
        { turn: 3, name: 'run_tests', status: 'passed' },
      ],
      evidenceSummary: { filesModified: 2, verifiedCount: 1 },
    })

    // Verify all four analysis layers are present
    assert.ok(report.includes('# Session Retrospective'), 'title')
    assert.ok(report.includes('## 1. 事实时间线'), 'L0: timeline')
    assert.ok(report.includes('## 2. 四层分析'), 'L1-L4: four-layer analysis')
    assert.ok(report.includes('### L4 系统层'), 'L4: system layer')
    assert.ok(report.includes('### L3 编排层'), 'L3: orchestration')
    assert.ok(report.includes('### L2 上下文层'), 'L2: context')
    assert.ok(report.includes('### L1 执行层'), 'L1: execution')
    assert.ok(report.includes('## 3. 根因判定'), 'root cause')
    assert.ok(report.includes('## 4. 寻址建议'), 'recommendations')
    assert.ok(report.includes('read_file'), 'tool names in report')
    assert.ok(report.includes('tianxuan-locating'), 'phase names in report')
  })

  it('handles partial telemetry: only essential fields parsed, extras ignored', () => {
    // PerceptionTelemetrySnapshot has many extra fields (vigor, theta, health, prefixDrift...)
    // parseSensoriumLog should ignore those and only extract SensoriumEntry fields
    const snapshot = makeSnapshot(1, 'tianshu-planning')
    const jsonl = JSON.stringify(snapshot)
    const parsed = parseSensoriumLog(jsonl)
    assert.equal(parsed.length, 1)
    assert.equal(parsed[0]!.turn, 1)
    assert.equal(parsed[0]!.phase, 'tianshu-planning')
    // Extra fields like health, theta should be silently ignored
  })
})
