import { test } from 'node:test'
import assert from 'node:assert/strict'
import { attachPageTracker } from '../driver.js'
import type { DriverEvents } from '../driver.js'

type Handler = (arg: unknown) => void

class FakePage {
  readonly handlers = new Map<string, Handler>()
  constructor(private theUrl: string) {}
  url() { return this.theUrl }
  on(event: string, h: Handler) { this.handlers.set(event, h) }
  emit(event: string, arg?: unknown) { this.handlers.get(event)?.(arg) }
}

class FakeContext {
  readonly pages_: FakePage[]
  private pageHandler?: Handler
  constructor(pages: FakePage[]) { this.pages_ = pages }
  pages() { return this.pages_ }
  on(event: string, h: Handler) { if (event === 'page') this.pageHandler = h }
  openPage(p: FakePage) { this.pages_.push(p); this.pageHandler?.(p) }
  closePage(p: FakePage) {
    const i = this.pages_.indexOf(p)
    if (i >= 0) this.pages_.splice(i, 1)
    p.emit('close')
  }
}

function fakeReq(url: string) {
  return { method: () => 'GET', url: () => url, resourceType: () => 'fetch', headers: () => ({}), postData: () => null }
}

function noopEvents(overrides: Partial<DriverEvents> = {}): DriverEvents {
  return {
    onConsole: () => {},
    onRequestStart: () => {},
    onResponse: () => {},
    onResponseBody: () => {},
    onRequestFailed: () => {},
    ...overrides,
  } as DriverEvents
}

test('attachPageTracker: newest page becomes the active target', () => {
  const page0 = new FakePage('http://localhost/')
  const ctx = new FakeContext([page0])
  const tracker = attachPageTracker(ctx as never, noopEvents(), page0 as never)
  assert.equal(tracker.getActivePage() as unknown, page0)

  const popup = new FakePage('https://accounts.example/login')
  ctx.openPage(popup)
  assert.equal(tracker.getActivePage() as unknown, popup)
  assert.deepEqual(tracker.pageUrls(), ['http://localhost/', 'https://accounts.example/login'])
})

test('attachPageTracker: closing the active page falls back to a remaining page', () => {
  const page0 = new FakePage('http://localhost/')
  const ctx = new FakeContext([page0])
  const tracker = attachPageTracker(ctx as never, noopEvents(), page0 as never)

  const popup = new FakePage('https://accounts.example/login')
  ctx.openPage(popup)
  assert.equal(tracker.getActivePage() as unknown, popup)

  ctx.closePage(popup)
  assert.equal(tracker.getActivePage() as unknown, page0)
})

test('attachPageTracker: closing a background page keeps the active pointer', () => {
  const page0 = new FakePage('http://localhost/')
  const ctx = new FakeContext([page0])
  const tracker = attachPageTracker(ctx as never, noopEvents(), page0 as never)
  const popup = new FakePage('https://accounts.example/login')
  ctx.openPage(popup)
  // popup is active; closing the background page0 should not move active off popup
  ctx.closePage(page0)
  assert.equal(tracker.getActivePage() as unknown, popup)
})

test('attachPageTracker: request ids are unique across pages (shared counter)', () => {
  const ids: string[] = []
  const page0 = new FakePage('http://localhost/')
  const ctx = new FakeContext([page0])
  attachPageTracker(ctx as never, noopEvents({ onRequestStart: (id) => { ids.push(id) } }), page0 as never)

  page0.emit('request', fakeReq('/a'))
  const popup = new FakePage('https://accounts.example/login')
  ctx.openPage(popup)
  popup.emit('request', fakeReq('/b'))

  assert.deepEqual(ids, ['r1', 'r2'])
})
