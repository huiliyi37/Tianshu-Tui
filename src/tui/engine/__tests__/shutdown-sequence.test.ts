import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runTuiShutdownSequence } from '../shutdown-sequence.js'

test('cleanup and process exit wait for telemetry flush', async () => {
  const events: string[] = []
  let resolveFlush!: () => void
  const flush = new Promise<void>(resolve => { resolveFlush = resolve })

  const shutdown = runTuiShutdownSequence({
    dispose: () => { events.push('dispose') },
    flushTelemetry: async () => {
      events.push('flush:start')
      await flush
      events.push('flush:end')
    },
    cleanup: [() => { events.push('cleanup') }],
    exit: code => { events.push(`exit:${code}`) },
  }, 7)

  await new Promise<void>(resolve => setImmediate(resolve))
  assert.deepEqual(events, ['dispose', 'flush:start'])

  resolveFlush()
  await shutdown
  assert.deepEqual(events, ['dispose', 'flush:start', 'flush:end', 'cleanup', 'exit:7'])
})

test('sync failures are aggregated while later cleanup and exit run exactly once', async () => {
  const events: string[] = []
  const reports: AggregateError[] = []
  await runTuiShutdownSequence({
    dispose: () => {
      events.push('dispose')
      throw new Error('dispose failed')
    },
    flushTelemetry: async () => { events.push('flush') },
    cleanup: [
      () => {
        events.push('cleanup:1')
        throw new Error('cleanup failed')
      },
      () => { events.push('cleanup:2') },
    ],
    exit: code => { events.push(`exit:${code}`) },
    reportErrors: error => { reports.push(error) },
  }, 1)

  assert.deepEqual(events, ['dispose', 'flush', 'cleanup:1', 'cleanup:2', 'exit:1'])
  assert.equal(events.filter(event => event === 'exit:1').length, 1)
  assert.equal(reports.length, 1)
  assert.equal(reports[0]!.errors.length, 2)
})

test('async failures do not skip later cleanup or termination', async () => {
  const events: string[] = []
  const reports: AggregateError[] = []
  await runTuiShutdownSequence({
    dispose: () => { events.push('dispose') },
    flushTelemetry: async () => {
      events.push('flush')
      throw new Error('flush failed')
    },
    cleanup: [
      async () => {
        events.push('cleanup:async')
        await Promise.resolve()
        throw new Error('async cleanup failed')
      },
      () => { events.push('cleanup:final') },
    ],
    exit: code => { events.push(`exit:${code}`) },
    reportErrors: error => { reports.push(error) },
  }, 2)

  assert.deepEqual(events, ['dispose', 'flush', 'cleanup:async', 'cleanup:final', 'exit:2'])
  assert.equal(reports.length, 1)
  assert.equal(reports[0]!.errors.length, 2)
})
