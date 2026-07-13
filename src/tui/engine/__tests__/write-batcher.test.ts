import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { WriteBatcher } from '../write-batcher.js'

const nextMacrotask = () => new Promise(r => setTimeout(r, 0))

describe('WriteBatcher (microtask coalescing)', () => {
  it('coalesces many schedule() calls in one tick into a single flush', async () => {
    let flushes = 0
    const b = new WriteBatcher(() => { flushes++ })

    b.schedule()
    b.schedule()
    b.schedule()
    assert.equal(flushes, 0, 'flush is deferred to a microtask, not synchronous')

    await nextMacrotask()
    assert.equal(flushes, 1, 'three synchronous schedules collapse to one flush')
  })

  it('schedules again after a flush completes', async () => {
    let flushes = 0
    const b = new WriteBatcher(() => { flushes++ })

    b.schedule()
    await nextMacrotask()
    assert.equal(flushes, 1)

    b.schedule()
    await nextMacrotask()
    assert.equal(flushes, 2, 'a new tick can request a fresh flush')
  })

  it('a schedule() issued from within onFlush coalesces into the next tick', async () => {
    let flushes = 0
    let reentered = false
    const b = new WriteBatcher(() => {
      flushes++
      if (!reentered) {
        reentered = true
        b.schedule() // re-arm during flush; pending was already reset to false
      }
    })

    b.schedule()
    await nextMacrotask()
    await nextMacrotask()
    assert.equal(flushes, 2, 'the re-armed schedule flushes exactly once more')
  })

  it('flushNow invalidates an already queued microtask', async () => {
    let flushes = 0
    const b = new WriteBatcher(() => { flushes++ })

    b.schedule()
    b.flushNow()
    assert.equal(flushes, 1, 'critical flush runs synchronously')

    await nextMacrotask()
    assert.equal(flushes, 1, 'stale queued microtask must not flush again')
  })

  it('flushNow reports errors and remains reusable', async () => {
    const errors: unknown[] = []
    let shouldThrow = true
    let flushes = 0
    const b = new WriteBatcher(() => {
      flushes++
      if (shouldThrow) throw new Error('render failed')
    }, err => errors.push(err))

    assert.doesNotThrow(() => b.flushNow())
    assert.equal(errors.length, 1)
    assert.match(String(errors[0]), /render failed/)

    shouldThrow = false
    b.schedule()
    await nextMacrotask()
    assert.equal(flushes, 2)
  })
})
