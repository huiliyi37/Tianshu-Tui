import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  getOrCreateSession,
  getSession,
  closeSession,
  __resetSessionForTest,
  __sessionCountForTest,
  DEFAULT_SESSION_KEY,
} from '../session.js'
import type { BrowserDebugDriver, DriverEvents, DriverLaunchOptions } from '../driver.js'

class FakeDriver implements BrowserDebugDriver {
  static instances: FakeDriver[] = []
  readonly key: string
  closed = false
  constructor(key: string, _events: DriverEvents) {
    this.key = key
    FakeDriver.instances.push(this)
  }
  async goto() {}
  async evaluate() { return '' }
  async screenshot() { return Buffer.from('') }
  async snapshot() { return '' }
  async click() {}
  async type() {}
  async press() {}
  async selectOption() { return [] as string[] }
  async hover() {}
  async scroll() {}
  async waitForSelector() {}
  async waitForLoadState() {}
  async reload() {}
  async goBack() { return true }
  async goForward() { return true }
  async cookies() { return [] }
  async storage() { return {} }
  async addCookie() {}
  async clearCookies() {}
  async setStorage() {}
  async clearStorage() {}
  currentUrl() { return 'about:blank' }
  pageUrls() { return ['about:blank'] }
  async bringToFront() {}
  async close() { this.closed = true }
}

test('sessions are isolated by sessionKey', async () => {
  __resetSessionForTest()
  FakeDriver.instances = []
  const factory = async (o: DriverLaunchOptions) => new FakeDriver(o.userDataDir, o.events)

  await getOrCreateSession({
    sessionKey: 'sess-a',
    headless: true,
    userDataDir: 'profile-a',
    driverFactory: factory,
  })
  await getOrCreateSession({
    sessionKey: 'sess-b',
    headless: true,
    userDataDir: 'profile-b',
    driverFactory: factory,
  })

  assert.equal(__sessionCountForTest(), 2)
  assert.ok(getSession('sess-a'))
  assert.ok(getSession('sess-b'))
  assert.equal(getSession(DEFAULT_SESSION_KEY), null)

  await closeSession('sess-a')
  assert.equal(__sessionCountForTest(), 1)
  assert.equal(FakeDriver.instances[0]!.closed, true)
  assert.equal(FakeDriver.instances[1]!.closed, false)

  await closeSession('sess-b')
  assert.equal(__sessionCountForTest(), 0)
})

test('closeSession is idempotent for missing key', async () => {
  __resetSessionForTest()
  await closeSession('missing')
  assert.equal(__sessionCountForTest(), 0)
})
