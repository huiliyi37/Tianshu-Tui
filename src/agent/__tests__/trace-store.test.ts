import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  createTraceStore,
  startTraceEvent,
  finishTraceEvent,
  recordTraceEvent,
  getDoomLoopLevel,
  fingerprintToolCall,
  type TraceEvent,
  type TraceEventStartInput,
} from '../trace-store.js'

describe('trace-store', () => {
  it('records a running event and finishes it with duration', () => {
    let store = createTraceStore(10)
    store = startTraceEvent(store, {
      id: 'tool-1',
      turn: 3,
      kind: 'tool',
      name: 'run_tests',
      startedAt: 1000,
      summary: 'npm test',
    })

    assert.equal(store.events.length, 1)
    assert.equal(store.events[0]!.status, 'running')

    store = finishTraceEvent(store, 'tool-1', {
      status: 'failed',
      endedAt: 1250,
      rawPath: '/tmp/rivet-raw/x.raw',
    })

    assert.equal(store.events[0]!.status, 'failed')
    assert.equal(store.events[0]!.durationMs, 250)
    assert.equal(store.events[0]!.rawPath, '/tmp/rivet-raw/x.raw')
  })

  it('does not allow completion fields when starting an event', () => {
    const input = {
      id: 'tool-1',
      turn: 3,
      kind: 'tool',
      name: 'run_tests',
      startedAt: 1000,
    } satisfies TraceEventStartInput

    assert.equal(input.startedAt, 1000)
  })

  it('caps events to the configured maximum', () => {
    let store = createTraceStore(2)
    const event = (id: string): TraceEvent => ({
      id,
      turn: 1,
      kind: 'tool',
      name: id,
      status: 'passed',
      startedAt: 1,
      endedAt: 2,
      durationMs: 1,
    })

    store = recordTraceEvent(store, event('a'))
    store = recordTraceEvent(store, event('b'))
    store = recordTraceEvent(store, event('c'))

    assert.deepEqual(store.events.map(e => e.id), ['b', 'c'])
  })

  it('detects repeated tool call fingerprints', () => {
    const fp = fingerprintToolCall('read_file', { file_path: 'src/a.ts' }, 'passed')
    const fingerprints = [fp, fp, fp]

    assert.equal(getDoomLoopLevel(fingerprints), 'warn')
    assert.equal(getDoomLoopLevel([...fingerprints, fp, fp]), 'blocked')
  })
})
