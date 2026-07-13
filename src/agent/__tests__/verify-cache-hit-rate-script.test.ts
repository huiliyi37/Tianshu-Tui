import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  cacheRegressionAdvisory,
  formatOfflineCacheSummary,
  parseCacheLogJsonl,
  parsePercentStrict,
  summarizeCacheLog,
} from '../../cache/cache-log-summary.js'

describe('verify-cache-hit-rate offline summary', () => {
  it('excludes missing counters from averages and displays them as unknown', () => {
    const summary = summarizeCacheLog([
      { turn: 0, hitRate: '0.0%' },
      {
        turn: 1,
        hitRate: '95.0%',
        cacheRead: 950,
        cacheCreate: 100,
        ttftMs: 100,
        outputRawBytes: 1_000,
        outputTrimmedBytes: 200,
        outputFilterIds: ['node-test'],
        toolUiEvents: 4,
      },
      { turn: 2, ttftMs: 300 },
    ])

    assert.equal(summary.turn1Plus.hitRate.average, 90.47619047619048)
    assert.equal(summary.turn1Plus.hitRate.known, 1)
    assert.equal(summary.turn1Plus.hitRate.unknown, 1)
    assert.equal(summary.turn1Plus.ttftMs.average, 200)
    assert.equal(summary.turn1Plus.cacheCreate.average, 100)
    assert.equal(summary.turn1Plus.toolUiEvents.average, 4)
    assert.match(formatOfflineCacheSummary(summary), /unknown/)
  })

  it('weights hit rate by cache tokens and uses it for advisory', () => {
    const low = summarizeCacheLog([
      { turn: 1, hitRate: '99.9%', cacheRead: 90, cacheCreate: 10 },
      { turn: 2, hitRate: '99.9%', cacheRead: 1, cacheCreate: 9 },
    ])
    const healthy = summarizeCacheLog([{ turn: 1, hitRate: '1.0%', cacheRead: 90, cacheCreate: 10 }])
    const unknown = summarizeCacheLog([{ turn: 1 }])

    assert.equal(low.turn1Plus.hitRate.average, 82.72727272727273)
    assert.match(cacheRegressionAdvisory(low) ?? '', /advisory/i)
    assert.equal(cacheRegressionAdvisory(healthy), null)
    assert.equal(cacheRegressionAdvisory(unknown), null)
  })

  it('skips malformed JSONL rows and rejects junk percentages', () => {
    const records = parseCacheLogJsonl([
      '{"turn":0,"hitRate":"0.0%"}',
      '{"turn":',
      '{"turn":1,"hitRate":"90.0%"}',
      '{"turn":2',
    ].join('\n'))

    assert.deepEqual(records.map(record => record.turn), [0, 1])
    assert.equal(parsePercentStrict('89.0%'), 89)
    assert.equal(parsePercentStrict('89.0%junk'), undefined)
    assert.equal(parsePercentStrict(' 89.0% '), undefined)
  })

  it('distinguishes all-none, all-unknown, and mixed filter coverage', () => {
    const allNone = formatOfflineCacheSummary(summarizeCacheLog([
      { turn: 1, cacheRead: 9, cacheCreate: 1, outputFilterIds: [] },
      { turn: 2, cacheRead: 9, cacheCreate: 1, outputFilterIds: [] },
    ]))
    const allUnknown = formatOfflineCacheSummary(summarizeCacheLog([
      { turn: 1, cacheRead: 9, cacheCreate: 1 },
      { turn: 2, cacheRead: 9, cacheCreate: 1 },
    ]))
    const mixedNone = formatOfflineCacheSummary(summarizeCacheLog([
      { turn: 1, cacheRead: 9, cacheCreate: 1, outputFilterIds: [] },
      { turn: 2, cacheRead: 9, cacheCreate: 1 },
    ]))
    const mixedIds = formatOfflineCacheSummary(summarizeCacheLog([
      { turn: 1, cacheRead: 9, cacheCreate: 1, outputFilterIds: ['node-test'] },
      { turn: 2, cacheRead: 9, cacheCreate: 1 },
      { turn: 3, cacheRead: 9, cacheCreate: 1, outputFilterIds: ['npm', 'node-test'] },
    ]))

    assert.match(allNone, /output filters: none(?:\n|$)/)
    assert.doesNotMatch(allNone, /partial/)
    assert.match(allUnknown, /output filters: unknown/)
    assert.match(mixedNone, /output filters: none \(partial; 1 unknown\)/)
    assert.match(mixedIds, /output filters: node-test, npm \(partial; 1 unknown\)/)
  })
})
