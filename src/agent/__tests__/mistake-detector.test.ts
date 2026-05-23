import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { detectMistakeResolution } from '../mistake-detector.js'
import { createTraceStore, recordTraceEvent } from '../trace-store.js'
import type { TraceStore } from '../trace-store.js'

function addEvent(store: TraceStore, id: string, name: string, status: 'passed' | 'failed', summary: string, turn = 0): TraceStore {
  return recordTraceEvent(store, {
    id, turn, kind: 'tool', name, status,
    startedAt: Date.now(), endedAt: Date.now(), summary,
  })
}

describe('detectMistakeResolution', () => {
  it('returns null when no prior failed event for same tool', () => {
    let store = createTraceStore()
    store = addEvent(store, 'a', 'bash', 'passed', 'ok', 1)
    const result = detectMistakeResolution(store, 'a', 'bash')
    assert.equal(result, null)
  })

  it('returns null when current event is failed (not a resolution)', () => {
    let store = createTraceStore()
    store = addEvent(store, 'a', 'bash', 'failed', 'err1', 1)
    store = addEvent(store, 'b', 'bash', 'failed', 'err2', 2)
    const result = detectMistakeResolution(store, 'b', 'bash')
    assert.equal(result, null)
  })

  it('returns mistake when current passed follows a failed of same tool', () => {
    let store = createTraceStore()
    store = addEvent(store, 'a', 'bash', 'failed', 'tsc TS2322 type mismatch', 1)
    store = addEvent(store, 'b', 'bash', 'passed', 'ok', 2)
    const result = detectMistakeResolution(store, 'b', 'bash')
    assert.ok(result)
    assert.match(result.error, /TS2322/)
  })

  it('ignores failed events of other tools', () => {
    let store = createTraceStore()
    store = addEvent(store, 'a', 'edit_file', 'failed', 'edit failed', 1)
    store = addEvent(store, 'b', 'bash', 'passed', 'ok', 2)
    const result = detectMistakeResolution(store, 'b', 'bash')
    assert.equal(result, null)
  })

  it('skips when an intervening passed already resolved the failure', () => {
    let store = createTraceStore()
    store = addEvent(store, 'a', 'bash', 'failed', 'old err', 1)
    store = addEvent(store, 'b', 'bash', 'passed', 'ok', 2) // already resolved
    store = addEvent(store, 'c', 'bash', 'passed', 'ok again', 3)
    const result = detectMistakeResolution(store, 'c', 'bash')
    assert.equal(result, null, 'no new mistake to learn — already resolved at b')
  })

  it('finds the most recent failed when multiple exist', () => {
    let store = createTraceStore()
    store = addEvent(store, 'a', 'bash', 'failed', 'old err A', 1)
    store = addEvent(store, 'b', 'bash', 'failed', 'recent err B', 2)
    store = addEvent(store, 'c', 'bash', 'passed', 'ok', 3)
    const result = detectMistakeResolution(store, 'c', 'bash')
    assert.ok(result)
    assert.match(result.error, /recent err B/)
  })

  it('returns null when traceId not found in store', () => {
    const store = createTraceStore()
    const result = detectMistakeResolution(store, 'missing', 'bash')
    assert.equal(result, null)
  })
})
