import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { parseSensoriumLog, generateRetrospect } from '../retrospect.js'
import type { SensoriumEntry } from '../retrospect.js'

describe('parseSensoriumLog', () => {
  it('parses valid JSONL sensorium log', () => {
    const raw = [
      JSON.stringify({
        ts: 1000, turn: 1, phase: 'tianxuan-locating',
        momentum: 0.2, pressure: 0.02, confidence: 1.0,
        complexity: 0.4, freshness: 0.6, stability: 1.0,
        strategy: { reasoningEffort: 'medium', shouldEscalate: false, thetaInterval: 7 },
      }),
      JSON.stringify({
        ts: 2000, turn: 2, phase: 'yuheng-implementing',
        momentum: 0.6, pressure: 0.15, confidence: 0.8,
        complexity: 0.3, freshness: 0.65, stability: 1.0,
        strategy: { reasoningEffort: 'low', shouldEscalate: false, thetaInterval: 7 },
        gitChangeRate: 0.2,
    season: null,
      }),
    ].join('\n')

    const entries = parseSensoriumLog(raw)
    assert.equal(entries.length, 2)
    assert.equal(entries[0]?.turn, 1)
    assert.equal(entries[0]?.phase, 'tianxuan-locating')
    assert.equal(entries[1]?.turn, 2)
    assert.equal(entries[1]?.gitChangeRate, 0.2)
  })

  it('skips invalid lines', () => {
    const raw = [
      'not json',
      JSON.stringify({ ts: 1000, turn: 1, phase: 'test', momentum: 0, pressure: 0, confidence: 1, complexity: 0, freshness: 0.5, stability: 1, strategy: { reasoningEffort: 'medium', shouldEscalate: false, thetaInterval: 7 } }),
      '',
    ].join('\n')

    const entries = parseSensoriumLog(raw)
    assert.equal(entries.length, 1)
    assert.equal(entries[0]?.turn, 1)
  })

  it('returns empty array for empty input', () => {
    assert.deepEqual(parseSensoriumLog(''), [])
    assert.deepEqual(parseSensoriumLog('\n\n'), [])
  })
})

function makeEntry(overrides: Partial<SensoriumEntry> = {}): SensoriumEntry {
  return {
    ts: Date.now(), turn: 1, phase: 'tianxuan-locating',
    momentum: 0.5, pressure: 0.1, confidence: 0.8,
    complexity: 0.3, freshness: 0.6, stability: 1.0,
    strategy: { reasoningEffort: 'medium', shouldEscalate: false, thetaInterval: 7 },
    ...overrides,
  }
}

describe('generateRetrospect', () => {
  it('generates a structured markdown report', () => {
    const report = generateRetrospect({
      sensoriumEntries: [makeEntry(), makeEntry({ turn: 2, phase: 'yuheng-implementing' })],
      gitLog: ['abc123 feat: add feature', 'def456 fix: bug'],
      toolEvents: [
        { turn: 1, name: 'read_file', status: 'passed' },
        { turn: 2, name: 'edit_file', status: 'passed' },
      ],
      evidenceSummary: { filesModified: 2, verifiedCount: 1 },
    })

    assert.ok(report.includes('# Session Retrospective'), 'missing title')
    assert.ok(report.includes('## 1. 事实时间线'), 'missing timeline section')
    assert.ok(report.includes('## 2. 四层分析'), 'missing analysis section')
    assert.ok(report.includes('## 4. 寻址建议'), 'missing recommendations section')
    assert.ok(report.includes('tianxuan-locating'), 'missing phase info')
    assert.ok(report.includes('2'), 'missing turn count')
  })

  it('handles empty data gracefully', () => {
    const report = generateRetrospect({
      sensoriumEntries: [],
      gitLog: [],
      toolEvents: [],
      evidenceSummary: { filesModified: 0, verifiedCount: 0 },
    })

    assert.ok(report.includes('数据不足'), 'should indicate insufficient data')
    assert.ok(report.length > 0)
  })

  it('detects confidence drops', () => {
    const report = generateRetrospect({
      sensoriumEntries: [
        makeEntry({ turn: 1, confidence: 0.9 }),
        makeEntry({ turn: 2, confidence: 0.2 }),
      ],
      gitLog: [],
      toolEvents: [],
      evidenceSummary: { filesModified: 1, verifiedCount: 0 },
    })

    assert.ok(report.includes('置信度'), 'should mention confidence')
  })

  it('detects stability drops', () => {
    const report = generateRetrospect({
      sensoriumEntries: [
        makeEntry({ turn: 1, stability: 1.0 }),
        makeEntry({ turn: 2, stability: 0.2 }),
      ],
      gitLog: [],
      toolEvents: [],
      evidenceSummary: { filesModified: 1, verifiedCount: 0 },
    })

    assert.ok(report.includes('稳定'), 'should mention stability')
  })

  it('detects high pressure', () => {
    const report = generateRetrospect({
      sensoriumEntries: [makeEntry({ pressure: 0.85 })],
      gitLog: [],
      toolEvents: [],
      evidenceSummary: { filesModified: 2, verifiedCount: 0 },
    })

    assert.ok(report.includes('压缩') || report.includes('compact') || report.includes('上下文'), 'should mention context pressure')
  })

  it('includes pheromone signals when provided (enhancement)', () => {
    const report = generateRetrospect({
      sensoriumEntries: [makeEntry()],
      gitLog: [],
      toolEvents: [],
      evidenceSummary: { filesModified: 1, verifiedCount: 1 },
      pheromoneSignals: [
        { signal: 'fragile', path: 'src/loop.ts', strength: 0.7 },
        { signal: 'well-tested', path: 'src/sensorium.ts', strength: 0.5 },
      ],
    })

    assert.ok(report.includes('信息素'), 'should include pheromone section')
    assert.ok(report.includes('fragile'), 'should list fragile signals')
  })
})
