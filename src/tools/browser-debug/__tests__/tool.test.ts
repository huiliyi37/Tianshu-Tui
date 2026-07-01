import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  createBrowserDebugTool,
  isLoopbackHost,
  isDebugHostAllowed,
  isLoopbackCdpUrl,
  isCdpUrlAllowed,
} from '../tool.js'
import { __resetSessionForTest } from '../session.js'
import type { BrowserDebugDriver, DriverEvents, DriverLaunchOptions } from '../driver.js'
import type { ToolCallParams } from '../../types.js'
import type { SaveArtifactInput } from '../../../artifact/store.js'

class FakeDriver implements BrowserDebugDriver {
  static last?: FakeDriver
  static lastLaunchOpts?: DriverLaunchOptions
  url = 'about:blank'
  closed = false
  private readonly events: DriverEvents
  constructor(events: DriverEvents) {
    this.events = events
    FakeDriver.last = this
  }
  async goto(url: string) {
    this.url = url
    this.events.onRequestStart('r1', 'GET', url)
    this.events.onResponse('r1', 200)
    this.events.onRequestStart('r2', 'POST', `${url}api/data`)
    this.events.onResponse('r2', 500)
    this.events.onConsole('error', 'Uncaught boom')
    this.events.onConsole('log', 'hello world')
  }
  async evaluate(expr: string) {
    return `eval:${expr}`
  }
  async screenshot() {
    return Buffer.from('PNGDATA')
  }
  async snapshot(selector?: string) {
    return selector ? `snap:${selector}` : 'page body text'
  }
  async click() {}
  async type() {}
  async waitForSelector() {}
  currentUrl() {
    return this.url
  }
  async bringToFront() {}
  async close() {
    this.closed = true
  }
}

class FakeArtifactStore {
  saved: SaveArtifactInput[] = []
  async save(input: SaveArtifactInput): Promise<string> {
    this.saved.push(input)
    return `browser_screenshot:${this.saved.length}`
  }
}

function params(
  input: Record<string, unknown>,
  extra: { store?: FakeArtifactStore; onOutput?: (c: string) => void } = {},
): ToolCallParams {
  return {
    input,
    toolUseId: 't1',
    cwd: '/work',
    artifactStore: extra.store as never,
    onOutput: extra.onOutput,
  }
}

function makeTool(opts: { built?: { value: boolean }; allowlist?: string[]; userDataDir?: string } = {}) {
  return createBrowserDebugTool({
    enabled: true,
    allowlist: () => opts.allowlist ?? [],
    userDataDir: () => opts.userDataDir ?? '/tmp/test-browser-profile',
    driverFactory: async (o: DriverLaunchOptions) => {
      if (opts.built) opts.built.value = true
      FakeDriver.lastLaunchOpts = o
      return new FakeDriver(o.events)
    },
  })
}

test('isLoopbackHost recognises loopback names', () => {
  assert.equal(isLoopbackHost('localhost'), true)
  assert.equal(isLoopbackHost('127.0.0.1'), true)
  assert.equal(isLoopbackHost('::1'), true)
  assert.equal(isLoopbackHost('app.localhost'), true)
  assert.equal(isLoopbackHost('example.com'), false)
})

test('isLoopbackCdpUrl accepts loopback http CDP endpoints', () => {
  assert.equal(isLoopbackCdpUrl('http://127.0.0.1:9222'), true)
  assert.equal(isLoopbackCdpUrl('http://localhost:9222'), true)
  assert.equal(isLoopbackCdpUrl('https://127.0.0.1:9222'), false)
  assert.equal(isLoopbackCdpUrl('http://evil.com:9222'), false)
})

test('isCdpUrlAllowed respects allowlist for non-loopback', () => {
  assert.equal(isCdpUrlAllowed('http://127.0.0.1:9222', []), true)
  assert.equal(isCdpUrlAllowed('http://dev.example.com:9222', []), false)
  assert.equal(isCdpUrlAllowed('http://dev.example.com:9222', ['example.com']), true)
})

test('isDebugHostAllowed: loopback always, others need allowlist', () => {
  assert.equal(isDebugHostAllowed('localhost', []), true)
  assert.equal(isDebugHostAllowed('example.com', []), false)
  assert.equal(isDebugHostAllowed('example.com', ['example.com']), true)
})

test('localhost navigation is allowed and needs no approval', async () => {
  __resetSessionForTest()
  const tool = makeTool()
  assert.equal(tool.requiresApproval(params({ action: 'navigate', url: 'http://localhost:3000' })), false)
  const res = await tool.execute(params({ action: 'open', url: 'http://localhost:3000/' }))
  assert.equal(res.isError, undefined)
  assert.match(res.content, /Navigated to http:\/\/localhost:3000/)
  await tool.execute(params({ action: 'close' }))
})

test('open with connect_url passes connectUrl to driver factory', async () => {
  __resetSessionForTest()
  const tool = makeTool()
  await tool.execute(params({
    action: 'open',
    url: 'http://localhost:3000/',
    connect_url: 'http://127.0.0.1:9222',
  }))
  assert.equal(FakeDriver.lastLaunchOpts?.connectUrl, 'http://127.0.0.1:9222')
  const status = await tool.execute(params({ action: 'status' }))
  assert.match(status.content, /mode: connect/)
  assert.match(status.content, /127\.0\.0\.1:9222/)
  await tool.execute(params({ action: 'close' }))
})

test('non-loopback CDP endpoint is blocked fail-closed', async () => {
  __resetSessionForTest()
  const built = { value: false }
  const tool = makeTool({ built })
  const res = await tool.execute(params({
    action: 'open',
    url: 'http://localhost:3000/',
    connect_url: 'http://evil.com:9222',
  }))
  assert.equal(res.isError, true)
  assert.match(res.content, /CDP endpoint/)
  assert.equal(built.value, false)
})

test('non-loopback host is blocked fail-closed and driver is never built', async () => {
  __resetSessionForTest()
  const built = { value: false }
  const tool = makeTool({ built })
  const res = await tool.execute(params({ action: 'navigate', url: 'https://evil.com/x' }))
  assert.equal(res.isError, true)
  assert.match(res.content, /not on the allowlist/)
  assert.equal(built.value, false)
})

test('navigation streams console + network lines to onOutput', async () => {
  __resetSessionForTest()
  const chunks: string[] = []
  const tool = makeTool()
  await tool.execute(params({ action: 'open', url: 'http://localhost:5173/' }, { onOutput: (c) => chunks.push(c) }))
  const joined = chunks.join('')
  assert.match(joined, /← 500 POST/)
  assert.match(joined, /\[error\] Uncaught boom/)
  await tool.execute(params({ action: 'close' }))
})

test('status reports session summary', async () => {
  __resetSessionForTest()
  const tool = makeTool({ userDataDir: '/tmp/rivet-browser-debug-profile' })
  await tool.execute(params({ action: 'open', url: 'http://localhost:3000/' }))
  const status = await tool.execute(params({ action: 'status' }))
  assert.match(status.content, /mode: launch/)
  assert.match(status.content, /profile: \/tmp\/rivet-browser-debug-profile/)
  assert.match(status.content, /console: 2 message/)
  await tool.execute(params({ action: 'close' }))
})

test('clear_logs wipes captured buffers', async () => {
  __resetSessionForTest()
  const tool = makeTool()
  await tool.execute(params({ action: 'open', url: 'http://localhost:3000/' }))
  const cleared = await tool.execute(params({ action: 'clear_logs' }))
  assert.match(cleared.content, /cleared/)
  const consoleRes = await tool.execute(params({ action: 'console' }))
  assert.equal(consoleRes.content, '(no console output)')
  await tool.execute(params({ action: 'close' }))
})

test('snapshot returns page text or selector subtree', async () => {
  __resetSessionForTest()
  const tool = makeTool()
  await tool.execute(params({ action: 'open', url: 'http://localhost:3000/' }))
  const body = await tool.execute(params({ action: 'snapshot' }))
  assert.equal(body.content, 'page body text')
  const sub = await tool.execute(params({ action: 'snapshot', selector: '#app' }))
  assert.equal(sub.content, 'snap:#app')
  await tool.execute(params({ action: 'close' }))
})

test('wait requires selector and succeeds when session is open', async () => {
  __resetSessionForTest()
  const tool = makeTool()
  await tool.execute(params({ action: 'open', url: 'http://localhost:3000/' }))
  const res = await tool.execute(params({ action: 'wait', selector: '#login-btn', timeout_ms: 5000 }))
  assert.match(res.content, /#login-btn.*visible/)
  await tool.execute(params({ action: 'close' }))
})

test('await_login ends the turn', async () => {
  __resetSessionForTest()
  const tool = makeTool()
  const res = await tool.execute(params({ action: 'await_login' }))
  assert.equal(res.endTurn, true)
  await tool.execute(params({ action: 'close' }))
})

test('close on connect mode says disconnected not closed', async () => {
  __resetSessionForTest()
  const tool = makeTool()
  await tool.execute(params({
    action: 'open',
    url: 'http://localhost:3000/',
    connect_url: 'http://127.0.0.1:9222',
  }))
  const res = await tool.execute(params({ action: 'close' }))
  assert.match(res.content, /Disconnected/)
  assert.doesNotMatch(res.content, /Browser session closed/)
})

test('tool is disabled by default, enabled via option', () => {
  assert.equal(createBrowserDebugTool().isEnabled(), false)
  assert.equal(createBrowserDebugTool({ enabled: true }).isEnabled(), true)
})
