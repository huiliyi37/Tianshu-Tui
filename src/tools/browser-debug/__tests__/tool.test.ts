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
  waitAborted = false
  private readonly events: DriverEvents
  constructor(events: DriverEvents) {
    this.events = events
    FakeDriver.last = this
  }
  async goto(url: string) {
    this.url = url
    this.events.onRequestStart('r1', 'GET', url, 'document')
    this.events.onResponse('r1', 200, 'document')
    this.events.onRequestStart('r2', 'POST', `${url.replace(/\/$/, '')}/api/data`, 'fetch')
    this.events.onResponse('r2', 500, 'fetch')
    this.events.onResponseBody('r2', '{"error":"server"}', 'application/json')
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
  async waitForSelector(_selector: string, _timeoutMs?: number, signal?: AbortSignal) {
    if (signal) {
      await new Promise<void>((resolve, reject) => {
        if (signal.aborted) {
          this.waitAborted = true
          reject(signal.reason ?? new Error('aborted'))
          return
        }
        signal.addEventListener('abort', () => {
          this.waitAborted = true
          reject(signal.reason ?? new Error('aborted'))
        })
        setTimeout(resolve, 50)
      })
    }
  }
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
  extra: { store?: FakeArtifactStore; onOutput?: (c: string) => void; sessionId?: string; abortSignal?: AbortSignal } = {},
): ToolCallParams {
  return {
    input,
    toolUseId: 't1',
    cwd: '/work',
    sessionId: extra.sessionId,
    abortSignal: extra.abortSignal,
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
  assert.equal(isLoopbackHost('example.com'), false)
})

test('localhost navigation uses sessionId bucket', async () => {
  __resetSessionForTest()
  const tool = makeTool()
  const res = await tool.execute(params({ action: 'open', url: 'http://localhost:3000/' }, { sessionId: 'worker-1' }))
  assert.equal(res.isError, undefined)
  const status = await tool.execute(params({ action: 'status' }, { sessionId: 'worker-1' }))
  assert.match(status.content, /session: worker-1/)
  await tool.execute(params({ action: 'close' }, { sessionId: 'worker-1' }))
})

test('network url_filter and include_body', async () => {
  __resetSessionForTest()
  const tool = makeTool()
  await tool.execute(params({ action: 'open', url: 'http://localhost:3000/' }))
  const res = await tool.execute(params({
    action: 'network',
    url_filter: '/api/',
    failed_only: true,
    include_body: true,
  }))
  assert.match(res.content, /← 500 POST/)
  assert.match(res.content, /body: \{"error":"server"\}/)
  assert.doesNotMatch(res.content, /← 200 GET/)
  await tool.execute(params({ action: 'close' }))
})

test('network_detail returns full entry', async () => {
  __resetSessionForTest()
  const tool = makeTool()
  await tool.execute(params({ action: 'open', url: 'http://localhost:3000/' }))
  const res = await tool.execute(params({ action: 'network_detail', request_id: 'r2' }))
  assert.match(res.content, /id: r2/)
  assert.match(res.content, /status: 500/)
  assert.match(res.content, /"error":"server"/)
  await tool.execute(params({ action: 'close' }))
})

test('network api_only filters xhr/fetch', async () => {
  __resetSessionForTest()
  const tool = makeTool()
  await tool.execute(params({ action: 'open', url: 'http://localhost:3000/' }))
  const res = await tool.execute(params({ action: 'network', api_only: true }))
  assert.match(res.content, /\[fetch\]/)
  assert.doesNotMatch(res.content, /\[document\]/)
  await tool.execute(params({ action: 'close' }))
})

test('wait respects abortSignal without closing session', async () => {
  __resetSessionForTest()
  const tool = makeTool()
  await tool.execute(params({ action: 'open', url: 'http://localhost:3000/' }))
  const controller = new AbortController()
  const promise = tool.execute(params({
    action: 'wait',
    selector: '#slow',
    timeout_ms: 60_000,
  }, { abortSignal: controller.signal }))
  controller.abort(new Error('user abort'))
  const res = await promise
  assert.equal(res.isError, true)
  assert.match(res.content, /wait failed/)
  const status = await tool.execute(params({ action: 'status' }))
  assert.match(status.content, /session: __default__/)
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

test('clear_logs wipes captured buffers', async () => {
  __resetSessionForTest()
  const tool = makeTool()
  await tool.execute(params({ action: 'open', url: 'http://localhost:3000/' }))
  await tool.execute(params({ action: 'clear_logs' }))
  const consoleRes = await tool.execute(params({ action: 'console' }))
  assert.equal(consoleRes.content, '(no console output)')
  await tool.execute(params({ action: 'close' }))
})

test('await_login ends the turn', async () => {
  __resetSessionForTest()
  const tool = makeTool()
  const res = await tool.execute(params({ action: 'await_login' }))
  assert.equal(res.endTurn, true)
  await tool.execute(params({ action: 'close' }))
})

test('tool is disabled by default, enabled via option', () => {
  assert.equal(createBrowserDebugTool().isEnabled(), false)
  assert.equal(createBrowserDebugTool({ enabled: true }).isEnabled(), true)
})
