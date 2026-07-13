import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  runTestCommandIn,
  type RunTestCommandDeps,
  type RunnableTestCommand,
} from '../run-tests.js'

class FakeChild extends EventEmitter {
  stdout = new PassThrough()
  stderr = new PassThrough()
}

class ManualTimers {
  tasks: Array<{ ms: number; callback: () => void | Promise<void>; cleared: boolean }> = []

  setTimeout(callback: () => void | Promise<void>, ms: number): number {
    this.tasks.push({ ms, callback, cleared: false })
    return this.tasks.length - 1
  }

  clearTimeout(handle: unknown): void {
    const task = this.tasks[handle as number]
    if (task) task.cleared = true
  }

  fire(ms: number): void | Promise<void> {
    const task = this.tasks.find((entry) => entry.ms === ms && !entry.cleared)
    assert.ok(task, `missing active ${ms}ms timer`)
    return task.callback()
  }
}

test('run_tests timeout claims settlement before synchronous child close and finalizes once', async () => {
  const child = new FakeChild()
  const timers = new ManualTimers()
  let persistCalls = 0
  let decoderEnds = 0
  const command: RunnableTestCommand = {
    type: 'run',
    command: 'fake-tests',
    args: [],
    display: 'fake-tests',
    runner: 'declared',
    scope: 'full',
  }
  const deps: RunTestCommandDeps = {
    spawn: () => child,
    kill: () => {
      // Reproduce the race deterministically: process close fires inside the
      // timeout cleanup, before output persistence resolves.
      child.emit('close', 0, null)
    },
    persist: async () => {
      persistCalls++
      await Promise.resolve()
      return '/tmp/raw-output'
    },
    setTimeout: (callback, ms) => timers.setTimeout(callback, ms),
    clearTimeout: (handle) => timers.clearTimeout(handle),
    createDecoder: () => ({
      write: (data: Buffer) => data.toString('utf8'),
      end: () => {
        decoderEnds++
        return ''
      },
    }),
  }

  const pending = runTestCommandIn(
    '/tmp',
    command,
    { input: {}, toolUseId: 'timeout-race', cwd: '/tmp' },
    undefined,
    50,
    deps,
  )
  child.stdout.write('partial output')
  await timers.fire(50)
  const result = await pending

  assert.equal(result.isError, true)
  assert.match(result.content, /timed out after 50ms/)
  assert.equal(result.verification?.blockedReason, 'timeout')
  assert.equal(persistCalls, 1, 'raw output must be persisted exactly once')
  assert.equal(decoderEnds, 2, 'stdout and stderr decoders finalize exactly once each')
})
