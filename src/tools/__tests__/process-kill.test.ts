import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { killProcessTree } from '../process-kill.js'

describe('killProcessTree', () => {
  it('kills the process group by negative pid', () => {
    const calls: Array<[number, NodeJS.Signals]> = []
    const child = { pid: 1234, kill: () => assert.fail('single process fallback should not be used') }

    killProcessTree(child, 'SIGTERM', (pid, signal) => { calls.push([pid, signal]) })

    assert.deepEqual(calls, [[-1234, 'SIGTERM']])
  })

  it('falls back to single process kill when process group kill fails', () => {
    const signals: NodeJS.Signals[] = []
    const child = { pid: 1234, kill: (signal: NodeJS.Signals) => { signals.push(signal); return true } }

    killProcessTree(child, 'SIGKILL', () => { throw new Error('missing process group') })

    assert.deepEqual(signals, ['SIGKILL'])
  })
})
