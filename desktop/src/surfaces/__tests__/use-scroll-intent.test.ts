import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { useUserScrollIntent } from '../use-scroll-intent.js'

type Api = ReturnType<typeof useUserScrollIntent>

function renderHook(): Api {
  let captured: Api | undefined
  function Capture() {
    captured = useUserScrollIntent()
    return null
  }
  renderToString(createElement(Capture))
  if (!captured) throw new Error('hook did not capture')
  return captured
}

describe('useUserScrollIntent', () => {
  it('wheel up sets intent when not at the very top', () => {
    const api = renderHook()
    api.onWheel({ deltaY: -10 }, 100)
    assert.equal(api.userIntentUpRef.current, true)
  })

  it('wheel up at scrollTop=0 does NOT set intent (top boundary)', () => {
    const api = renderHook()
    api.onWheel({ deltaY: -10 }, 0)
    assert.equal(api.userIntentUpRef.current, false)
  })

  it('wheel down does not set intent', () => {
    const api = renderHook()
    api.onWheel({ deltaY: 10 }, 100)
    assert.equal(api.userIntentUpRef.current, false)
  })

  it('PageUp, Home, ArrowUp set intent synchronously', () => {
    for (const key of ['PageUp', 'Home', 'ArrowUp']) {
      const api = renderHook()
      api.onKeyDown({ key, altKey: false })
      assert.equal(api.userIntentUpRef.current, true, `expected ${key} to set intent`)
    }
  })

  it('Alt+ArrowUp is reserved for block navigation and ignored', () => {
    const api = renderHook()
    api.onKeyDown({ key: 'ArrowUp', altKey: true })
    assert.equal(api.userIntentUpRef.current, false)
  })

  it('onScroll detects upward scrollbar drag', () => {
    const api = renderHook()
    // First establish a baseline scrollTop.
    api.onScroll(200, false)
    assert.equal(api.userIntentUpRef.current, false)
    // Drag scrollbar up: scrollTop decreases.
    api.onScroll(150, false)
    assert.equal(api.userIntentUpRef.current, true)
  })

  it('onScroll clears intent when returning near bottom by scrolling down', () => {
    const api = renderHook()
    // Establish baseline, then scroll up away from bottom.
    api.onScroll(200, false)
    api.onScroll(150, false)
    assert.equal(api.userIntentUpRef.current, true)
    // Scroll back down to near bottom: intent clears.
    api.onScroll(180, true)
    assert.equal(api.userIntentUpRef.current, false)
  })

  it('onScroll keeps intent when scrolling up while still near bottom', () => {
    const api = renderHook()
    // Near bottom, then scroll up a little but still near bottom.
    api.onScroll(80, true)
    api.onScroll(40, true)
    assert.equal(api.userIntentUpRef.current, true)
  })

  it('clearIntent resets the flag', () => {
    const api = renderHook()
    api.onKeyDown({ key: 'PageUp', altKey: false })
    assert.equal(api.userIntentUpRef.current, true)
    api.clearIntent()
    assert.equal(api.userIntentUpRef.current, false)
  })
})
