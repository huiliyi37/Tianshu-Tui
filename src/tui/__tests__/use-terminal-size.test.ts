import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  getTerminalSizeSnapshot,
  createThrottledResizeHandler,
  isResizeSettling,
  registerResizeClear,
  __subscribeTerminalSize,
} from '../use-terminal-size.js'

describe('useTerminalSize', () => {
  it('returns the same snapshot object when terminal size is unchanged', () => {
    const first = getTerminalSizeSnapshot()
    const second = getTerminalSizeSnapshot()

    assert.equal(first, second)
  })
})

describe('createThrottledResizeHandler (S14)', () => {
  it('coalesces a burst of calls into far fewer invocations', async () => {
    let calls = 0
    const h = createThrottledResizeHandler(() => { calls++ }, 32)
    for (let i = 0; i < 20; i++) h()
    await new Promise(r => setTimeout(r, 60))
    h.cancel()
    assert.ok(calls <= 3, `20 rapid calls should coalesce to <=3, got ${calls}`)
    assert.ok(calls >= 1, 'should fire at least once')
  })

  // resize-ghost fix: must NOT fire on the leading edge. A mid-drag synchronous
  // commit takes Ink's normal render path with a stale erase height → stacked
  // footer ghosts on shrink. Trailing-edge only = one clean commit after settle.
  it('does not fire synchronously (trailing edge only)', async () => {
    let calls = 0
    const h = createThrottledResizeHandler(() => { calls++ }, 32)
    h()
    assert.equal(calls, 0, 'should not fire on the leading edge')
    await new Promise(r => setTimeout(r, 50))
    h.cancel()
    assert.equal(calls, 1, 'should fire exactly once on the trailing edge')
  })

  // A drag is a continuous burst; the trailing commit must land after it stops.
  it('fires once after a sustained burst settles', async () => {
    let calls = 0
    const h = createThrottledResizeHandler(() => { calls++ }, 32)
    // simulate a ~100ms drag: an event every 10ms keeps resetting the timer
    for (let i = 0; i < 10; i++) { h(); await new Promise(r => setTimeout(r, 10)) }
    assert.equal(calls, 0, 'no commit while the drag is still in progress')
    await new Promise(r => setTimeout(r, 50))
    h.cancel()
    assert.equal(calls, 1, 'exactly one commit after the drag settles')
  })
})

// resize-ghost: two layered defenses.
//  (1) isResizeSettling() — streaming timers (1s tick, 600ms moon, 2Hz fluency)
//      poll it and skip their mid-drag commit at an intermediate width.
//  (2) registerResizeClear() — Ink only clears on width-DECREASE; on grow it
//      diffs against narrow-width output and leaves orphaned rows. We force a
//      clear on the trailing edge for either direction.
describe('isResizeSettling (resize-ghost timer gate)', () => {
  it('is false at rest', () => {
    assert.equal(isResizeSettling(), false, 'no resize in flight → not settling')
  })

  it('is true between the first drag event and the trailing commit, then clears', async () => {
    // Subscribe so the coordinator attaches its resize listener.
    const unsubscribe = __subscribeTerminalSize(() => {})
    try {
      assert.equal(isResizeSettling(), false, 'starts at rest')

      // First drag tick: emit a resize on the same channel the coordinator listens to.
      process.stdout.emit('resize')
      assert.equal(isResizeSettling(), true, 'a drag in progress must mark settling=true')

      // Keep dragging — still settling, no commit yet.
      process.stdout.emit('resize')
      await new Promise(r => setTimeout(r, 40))
      assert.equal(isResizeSettling(), true, 'still settling mid-drag')

      // Let the trailing edge land (SETTLE_MS=120).
      await new Promise(r => setTimeout(r, 160))
      assert.equal(isResizeSettling(), false, 'settling clears once the drag settles')
    } finally {
      unsubscribe()
    }
  })
})

describe('registerResizeClear (width-increase ghost fix)', () => {
  it('fires the registered clear on the resize trailing edge, before notify', async () => {
    const order: string[] = []
    const unregister = registerResizeClear(() => order.push('clear'))
    const unsubscribe = __subscribeTerminalSize(() => order.push('notify'))
    try {
      process.stdout.emit('resize')
      await new Promise(r => setTimeout(r, 160))
      assert.deepEqual(order, ['clear', 'notify'], 'clear must run before subscribers redraw')
    } finally {
      unsubscribe()
      unregister()
    }
  })

  it('does not fire the clear after it is unregistered', async () => {
    let clears = 0
    const unregister = registerResizeClear(() => { clears++ })
    const unsubscribe = __subscribeTerminalSize(() => {})
    unregister()
    try {
      process.stdout.emit('resize')
      await new Promise(r => setTimeout(r, 160))
      assert.equal(clears, 0, 'unregistered clear must not run')
    } finally {
      unsubscribe()
    }
  })
})

// Regression: a prior version gave each subscriber its own settle timer sharing
// one module-level variable, so concurrent subscribers stomped each other and
// only the last one's callback fired. The coordinator must fan out to ALL.
describe('shared resize coordinator fan-out', () => {
  it('notifies every subscriber on a single drag, not just the last', async () => {
    let a = 0, b = 0
    const ua = __subscribeTerminalSize(() => { a++ })
    const ub = __subscribeTerminalSize(() => { b++ })
    try {
      process.stdout.emit('resize')
      await new Promise(r => setTimeout(r, 160))
      assert.equal(a, 1, 'first subscriber must be notified')
      assert.equal(b, 1, 'second subscriber must be notified')
    } finally {
      ua()
      ub()
    }
  })
})
