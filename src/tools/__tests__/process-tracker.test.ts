import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { track, killAllSync, getActiveCount } from '../process-tracker.js'

function fakeChild(pid: number) {
  const signals: string[] = []
  return {
    proc: { pid, kill: (s: string) => { signals.push(s) }, on: () => {} } as any,
    signals,
  }
}

describe('killAllSync', () => {
  it('SIGKILLs tracked children inline and clears the set', () => {
    const a = fakeChild(2_000_000_001) // no such pgid → process.kill throws → falls back to child.kill
    const b = fakeChild(2_000_000_002)
    track(a.proc)
    track(b.proc)
    assert.equal(getActiveCount(), 2)
    killAllSync()
    assert.equal(getActiveCount(), 0)
    assert.ok(a.signals.includes('SIGKILL'))
    assert.ok(b.signals.includes('SIGKILL'))
  })
})
