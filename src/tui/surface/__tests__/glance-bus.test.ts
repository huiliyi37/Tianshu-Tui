import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createGlanceBus } from '../glance-bus.js'

describe('GlanceBus', () => {
  it('initial state: all 6 domains quiet', () => {
    const bus = createGlanceBus()
    const snap = bus.snapshot()
    assert.equal(snap.length, 6)
    assert.ok(snap.every(p => p.level === 'quiet'))
  })

  it('pushAlert sets domain to alert with hint', () => {
    const bus = createGlanceBus()
    bus.pushAlert('pojun', '3 consecutive failures')
    const p = bus.snapshot().find(x => x.domain === 'pojun')
    assert.equal(p?.level, 'alert')
    assert.equal(p?.hint, '3 consecutive failures')
  })

  it('setActive sets domain to active', () => {
    const bus = createGlanceBus()
    bus.setActive('tianfu')
    const p = bus.snapshot().find(x => x.domain === 'tianfu')
    assert.equal(p?.level, 'active')
  })

  it('reset returns domain to quiet', () => {
    const bus = createGlanceBus()
    bus.pushAlert('pojun', 'test')
    bus.reset('pojun')
    const p = bus.snapshot().find(x => x.domain === 'pojun')
    assert.equal(p?.level, 'quiet')
    assert.equal(p?.hint, undefined)
  })

  it('subscribe notifies on changes', () => {
    const bus = createGlanceBus()
    let count = 0
    bus.subscribe(() => count++)
    bus.setActive('tianji')
    bus.pushAlert('pojun', 'x')
    bus.reset('pojun')
    assert.equal(count, 3)
  })

  it('unsubscribe stops notifications', () => {
    const bus = createGlanceBus()
    let count = 0
    const unsub = bus.subscribe(() => count++)
    bus.setActive('tianfu')
    unsub()
    bus.setActive('tianji')
    assert.equal(count, 1)
  })

  it('listener errors do not crash bus', () => {
    const bus = createGlanceBus()
    bus.subscribe(() => { throw new Error('boom') })
    bus.setActive('pojun')
    assert.equal(bus.snapshot().find(p => p.domain === 'pojun')?.level, 'active')
  })
})
