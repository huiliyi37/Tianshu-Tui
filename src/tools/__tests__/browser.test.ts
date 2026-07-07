import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createBrowserTool, isHostAllowed, type BrowserDriver } from '../browser.js'
import type { ToolCallParams } from '../types.js'
import type { SaveArtifactInput } from '../../artifact/store.js'

class FakeDriver implements BrowserDriver {
  static last?: FakeDriver
  gotoUrl?: string
  closed = false
  constructor() { FakeDriver.last = this }
  async goto(url: string) { this.gotoUrl = url }
  async screenshot() { return Buffer.from('PNGDATA') }
  async textContent(sel?: string) { return sel ? `text:${sel}` : 'body text' }
  async click() {}
  async close() { this.closed = true }
}

class FakeArtifactStore {
  saved: SaveArtifactInput[] = []
  async save(input: SaveArtifactInput): Promise<string> {
    this.saved.push(input)
    return `browser_screenshot:${this.saved.length}`
  }
}

function params(input: Record<string, unknown>, store?: FakeArtifactStore): ToolCallParams {
  return { input, toolUseId: 't1', cwd: '/work', artifactStore: store as never }
}

test('isHostAllowed is fail-closed and supports subdomain suffix', () => {
  assert.equal(isHostAllowed('example.com', []), false)
  assert.equal(isHostAllowed('example.com', ['example.com']), true)
  assert.equal(isHostAllowed('app.example.com', ['example.com']), true)
  assert.equal(isHostAllowed('evil.com', ['example.com']), false)
  assert.equal(isHostAllowed('notexample.com', ['example.com']), false)
})

test('browser action ALWAYS requires approval', () => {
  const tool = createBrowserTool({ enabled: true, allowlist: () => ['example.com'] })
  assert.equal(tool.requiresApproval(params({ action: 'screenshot', url: 'https://example.com' })), true)
})

test('navigation to a non-allowlisted host is rejected (fail-closed), driver never built', async () => {
  let built = false
  const tool = createBrowserTool({
    enabled: true,
    allowlist: () => ['example.com'],
    driverFactory: async () => { built = true; return new FakeDriver() },
  })
  const res = await tool.execute(params({ action: 'screenshot', url: 'https://evil.com/x' }))
  assert.equal(res.isError, true)
  assert.match(res.content, /not on the allowlist/)
  assert.equal(built, false, 'must not launch a browser for a blocked host')
})

test('empty allowlist denies everything', async () => {
  const tool = createBrowserTool({ enabled: true, allowlist: () => [] })
  const res = await tool.execute(params({ action: 'screenshot', url: 'https://example.com' }))
  assert.equal(res.isError, true)
  assert.match(res.content, /No hosts are allowlisted/)
})

test('screenshot of an allowlisted host saves a screenshot artifact', async () => {
  const store = new FakeArtifactStore()
  const tool = createBrowserTool({
    enabled: true,
    allowlist: () => ['example.com'],
    driverFactory: async () => new FakeDriver(),
  })
  const res = await tool.execute(params({ action: 'screenshot', url: 'https://example.com/page' }, store))
  assert.equal(res.isError, undefined)
  assert.equal(store.saved.length, 1)
  assert.equal(store.saved[0]!.tool, 'browser_screenshot')
  assert.match(store.saved[0]!.target, /\.png$/)
  assert.equal(store.saved[0]!.rawContent, Buffer.from('PNGDATA').toString('base64'))
  assert.equal(FakeDriver.last!.closed, true, 'driver is always closed')
})

test('text action returns extracted content and closes the driver', async () => {
  const tool = createBrowserTool({
    enabled: true,
    allowlist: () => ['example.com'],
    driverFactory: async () => new FakeDriver(),
  })
  const res = await tool.execute(params({ action: 'text', url: 'https://example.com', selector: '#main' }))
  assert.match(res.content, /text:#main/)
  assert.equal(FakeDriver.last!.closed, true)
})

test('invalid protocol is rejected', async () => {
  const tool = createBrowserTool({ enabled: true, allowlist: () => ['example.com'] })
  const res = await tool.execute(params({ action: 'screenshot', url: 'file:///etc/passwd' }))
  assert.equal(res.isError, true)
  assert.match(res.content, /Unsupported protocol/)
})

test('tool is disabled by default', () => {
  assert.equal(createBrowserTool().isEnabled(), false)
  assert.equal(createBrowserTool({ enabled: true }).isEnabled(), true)
})
