import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { TurnCacheObservability } from '../cache-log-observability.js'

describe('TurnCacheObservability', () => {
  it('aggregates sanitized output and UI events for one request then resets', () => {
    const observability = new TurnCacheObservability()
    observability.recordToolBatch({
      outputRawBytes: 1_000,
      outputTrimmedBytes: 300,
      outputFilterIds: ['node-test'],
      toolUiEvents: 4,
    })
    observability.recordToolBatch({
      outputRawBytes: 500,
      outputTrimmedBytes: 0,
      outputFilterIds: [],
      toolUiEvents: 2,
    })

    assert.deepEqual(observability.consumeForRequest(), {
      outputRawBytes: 1_500,
      outputTrimmedBytes: 300,
      outputFilterIds: ['node-test'],
      toolUiEvents: 6,
    })
    assert.deepEqual(observability.consumeForRequest(), {})
  })

  it('keeps measured zeroes but omits fields that were never measured', () => {
    const observability = new TurnCacheObservability()
    assert.deepEqual(observability.consumeForRequest(), {})
    assert.deepEqual(observability.consumeForRequest({ ttftMs: 0 }), { ttftMs: 0 })

    observability.recordToolBatch({
      outputRawBytes: 42,
      outputTrimmedBytes: 0,
      outputFilterIds: [],
      toolUiEvents: 0,
    })
    assert.deepEqual(observability.consumeForRequest({ ttftMs: 24 }), {
      ttftMs: 24,
      outputRawBytes: 42,
      outputTrimmedBytes: 0,
      outputFilterIds: [],
      toolUiEvents: 0,
    })
  })

  it('deduplicates filter IDs while preserving first-seen order', () => {
    const observability = new TurnCacheObservability()
    observability.recordToolBatch({
      outputRawBytes: 10,
      outputTrimmedBytes: 5,
      outputFilterIds: ['npm', 'node-test', 'npm'],
      toolUiEvents: 1,
    })

    assert.deepEqual(observability.consumeForRequest().outputFilterIds, ['npm', 'node-test'])
  })

  it('aggregates UTF-8 raw and removed bytes from already-sanitized results', () => {
    const observability = new TurnCacheObservability()
    observability.beginToolBatch()
    observability.recordSanitizedOutput('中文', '中', 'unicode-filter')
    observability.recordSanitizedOutput('plain', 'plain')
    observability.recordToolUiEvent()
    observability.recordToolUiEvent()
    observability.endToolBatch()

    assert.deepEqual(observability.consumeForRequest(), {
      outputRawBytes: 11,
      outputTrimmedBytes: 3,
      outputFilterIds: ['unicode-filter'],
      toolUiEvents: 2,
    })
  })
})
