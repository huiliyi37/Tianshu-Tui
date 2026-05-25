import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createSurfaceRouter } from '../router.js'
import type { SurfaceDefinition, SurfaceEvent } from '../types.js'

function stub(id: string, layer: 'base' | 'overlay' | 'popup', opts?: Partial<SurfaceDefinition>): SurfaceDefinition {
  return { id, layer, discoverable: false, render: () => null, ...opts }
}

describe('SurfaceRouter', () => {
  describe('base layer', () => {
    it('registers base surface as always active', () => {
      const r = createSurfaceRouter()
      r.register(stub('chat', 'base'))
      assert.equal(r.activeOf('base'), 'chat')
    })

    it('cannot pop base', () => {
      const r = createSurfaceRouter()
      r.register(stub('chat', 'base'))
      r.pop()
      assert.equal(r.activeOf('base'), 'chat')
    })

    it('rejects second base registration', () => {
      const r = createSurfaceRouter()
      r.register(stub('chat', 'base'))
      assert.throws(() => r.register(stub('chat2', 'base')))
    })

    it('base is always visible', () => {
      const r = createSurfaceRouter()
      r.register(stub('chat', 'base'))
      assert.equal(r.isVisible('chat'), true)
    })
  })

  describe('overlay layer', () => {
    it('starts with no active overlay', () => {
      const r = createSurfaceRouter()
      assert.equal(r.activeOf('overlay'), null)
    })

    it('push activates overlay', () => {
      const r = createSurfaceRouter()
      r.register(stub('cockpit', 'overlay'))
      r.push('cockpit')
      assert.equal(r.activeOf('overlay'), 'cockpit')
    })

    it('push replaces previous overlay (exclusive)', () => {
      const r = createSurfaceRouter()
      r.register(stub('cockpit', 'overlay'))
      r.register(stub('starmap', 'overlay'))
      r.push('cockpit')
      r.push('starmap')
      assert.equal(r.activeOf('overlay'), 'starmap')
      assert.equal(r.isVisible('cockpit'), false)
    })

    it('pop returns to no overlay', () => {
      const r = createSurfaceRouter()
      r.register(stub('cockpit', 'overlay'))
      r.push('cockpit')
      r.pop()
      assert.equal(r.activeOf('overlay'), null)
    })

    it('push same overlay is no-op', () => {
      const r = createSurfaceRouter()
      const events: SurfaceEvent[] = []
      r.register(stub('cockpit', 'overlay'))
      r.push('cockpit')
      r.subscribe(e => events.push(e))
      r.push('cockpit')
      assert.equal(events.length, 0)
    })
  })

  describe('popup layer', () => {
    it('popup stacks', () => {
      const r = createSurfaceRouter()
      r.register(stub('palette', 'popup'))
      r.register(stub('approval', 'popup'))
      r.push('palette')
      r.push('approval')
      assert.equal(r.activeOf('popup'), 'approval')
      assert.equal(r.isVisible('palette'), true)
    })

    it('pop removes top popup first', () => {
      const r = createSurfaceRouter()
      r.register(stub('palette', 'popup'))
      r.register(stub('approval', 'popup'))
      r.push('palette')
      r.push('approval')
      r.pop()
      assert.equal(r.activeOf('popup'), 'palette')
    })

    it('popup pops before overlay', () => {
      const r = createSurfaceRouter()
      r.register(stub('cockpit', 'overlay'))
      r.register(stub('palette', 'popup'))
      r.push('cockpit')
      r.push('palette')
      r.pop()
      assert.equal(r.activeOf('popup'), null)
      assert.equal(r.activeOf('overlay'), 'cockpit')
    })

    it('push same popup at top is no-op', () => {
      const r = createSurfaceRouter()
      const events: SurfaceEvent[] = []
      r.register(stub('palette', 'popup'))
      r.push('palette')
      r.subscribe(e => events.push(e))
      r.push('palette')
      assert.equal(events.length, 0)
    })
  })

  describe('closeLayer', () => {
    it('closes all popups', () => {
      const r = createSurfaceRouter()
      r.register(stub('a', 'popup'))
      r.register(stub('b', 'popup'))
      r.push('a')
      r.push('b')
      r.closeLayer('popup')
      assert.equal(r.activeOf('popup'), null)
    })

    it('closes overlay', () => {
      const r = createSurfaceRouter()
      r.register(stub('cockpit', 'overlay'))
      r.push('cockpit')
      r.closeLayer('overlay')
      assert.equal(r.activeOf('overlay'), null)
    })
  })

  describe('lifecycle callbacks', () => {
    it('calls onEnter/onExit on push/pop', () => {
      const log: string[] = []
      const r = createSurfaceRouter()
      r.register(stub('cockpit', 'overlay', {
        onEnter: () => log.push('enter'),
        onExit: () => log.push('exit'),
      }))
      r.push('cockpit')
      r.pop()
      assert.deepEqual(log, ['enter', 'exit'])
    })

    it('onExit called on replace', () => {
      const log: string[] = []
      const r = createSurfaceRouter()
      r.register(stub('a', 'overlay', { onExit: () => log.push('exit-a') }))
      r.register(stub('b', 'overlay', { onEnter: () => log.push('enter-b') }))
      r.push('a')
      r.push('b')
      assert.deepEqual(log, ['exit-a', 'enter-b'])
    })

    it('lifecycle errors do not crash router', () => {
      const r = createSurfaceRouter()
      r.register(stub('bad', 'overlay', {
        onEnter: () => { throw new Error('boom') },
        onExit: () => { throw new Error('boom') },
      }))
      r.push('bad')
      r.pop()
      assert.equal(r.activeOf('overlay'), null)
    })
  })

  describe('events', () => {
    it('emits pushed event', () => {
      const r = createSurfaceRouter()
      const events: SurfaceEvent[] = []
      r.register(stub('cockpit', 'overlay'))
      r.subscribe(e => events.push(e))
      r.push('cockpit')
      assert.equal(events.length, 1)
      assert.deepEqual(events[0], { type: 'pushed', id: 'cockpit', layer: 'overlay' })
    })

    it('emits popped event', () => {
      const r = createSurfaceRouter()
      const events: SurfaceEvent[] = []
      r.register(stub('cockpit', 'overlay'))
      r.push('cockpit')
      r.subscribe(e => events.push(e))
      r.pop()
      assert.deepEqual(events[0], { type: 'popped', id: 'cockpit', layer: 'overlay' })
    })

    it('listener errors do not crash router', () => {
      const r = createSurfaceRouter()
      r.register(stub('x', 'overlay'))
      r.subscribe(() => { throw new Error('bad listener') })
      r.push('x')
      assert.equal(r.activeOf('overlay'), 'x')
    })

    it('unsubscribe stops events', () => {
      const r = createSurfaceRouter()
      const events: SurfaceEvent[] = []
      r.register(stub('x', 'overlay'))
      const unsub = r.subscribe(e => events.push(e))
      r.push('x')
      unsub()
      r.pop()
      assert.equal(events.length, 1)
    })
  })

  describe('unregister', () => {
    it('unregister cleans up active overlay', () => {
      const r = createSurfaceRouter()
      const unsub = r.register(stub('cockpit', 'overlay'))
      r.push('cockpit')
      unsub()
      assert.equal(r.activeOf('overlay'), null)
    })

    it('unregister cleans up popup stack', () => {
      const r = createSurfaceRouter()
      const unsub = r.register(stub('p', 'popup'))
      r.push('p')
      unsub()
      assert.equal(r.activeOf('popup'), null)
    })
  })

  describe('push unregistered id', () => {
    it('push unknown id is no-op', () => {
      const r = createSurfaceRouter()
      r.push('nonexistent')
      assert.equal(r.activeOf('overlay'), null)
    })
  })

  describe('getDiscoverable', () => {
    it('returns only discoverable surfaces', () => {
      const r = createSurfaceRouter()
      r.register(stub('chat', 'base'))
      r.register(stub('cockpit', 'overlay', { discoverable: true, paletteEntry: { label: 'Cockpit', hotkey: 'c' } }))
      r.register(stub('palette', 'popup'))
      const disc = r.getDiscoverable()
      assert.equal(disc.length, 1)
      assert.equal(disc[0]!.id, 'cockpit')
    })
  })
})
