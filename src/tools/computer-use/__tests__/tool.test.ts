import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createComputerUseTool } from '../tool.js'
import type { ComputerUseDriver, ClickTarget, PermissionStatus } from '../macos-driver.js'
import type { ToolCallParams } from '../../types.js'
import type { SaveArtifactInput } from '../../../artifact/store.js'

class FakeDriver implements ComputerUseDriver {
  calls: Array<{ method: string; args: unknown[] }> = []
  tree = '[1] AXButton "OK" @(10,20)'
  screenshot: Buffer | null = Buffer.from('PNGDATA')
  permissions: PermissionStatus = { accessibility: true, screenRecording: true, detail: 'All required permissions granted.' }

  async listApps() {
    this.calls.push({ method: 'listApps', args: [] })
    return [
      { name: 'Safari', frontmost: true },
      { name: 'Notes', frontmost: false },
    ]
  }
  async snapshot(app: string) {
    this.calls.push({ method: 'snapshot', args: [app] })
    return { tree: this.tree, screenshotPng: this.screenshot }
  }
  async click(app: string, target: ClickTarget) {
    this.calls.push({ method: 'click', args: [app, target] })
  }
  async type(app: string, text: string) {
    this.calls.push({ method: 'type', args: [app, text] })
  }
  async key(app: string, combo: string) {
    this.calls.push({ method: 'key', args: [app, combo] })
  }
  async focusApp(app: string) {
    this.calls.push({ method: 'focusApp', args: [app] })
  }
  async checkPermissions() {
    this.calls.push({ method: 'checkPermissions', args: [] })
    return this.permissions
  }
}

class FakeArtifactStore {
  saved: SaveArtifactInput[] = []
  async save(input: SaveArtifactInput): Promise<string> {
    this.saved.push(input)
    return `computer_use_screenshot:${this.saved.length}`
  }
}

function params(input: Record<string, unknown>, store?: FakeArtifactStore): ToolCallParams {
  return { input, toolUseId: 't1', cwd: '/work', artifactStore: store as never }
}

function darwinTool(driver: FakeDriver, granted: string[] = []) {
  const grantedSet = new Set(granted.map(a => a.toLowerCase()))
  return createComputerUseTool({
    platform: 'darwin',
    driverFactory: () => driver,
    isAppGranted: (app) => grantedSet.has(app.toLowerCase()),
  })
}

// ── Approval gating (fail-closed per app) ─────────────────────────

test('ungranted app → every action requires approval (fail-closed)', () => {
  const tool = darwinTool(new FakeDriver())
  for (const input of [
    { action: 'snapshot', app: 'Safari' },
    { action: 'click', app: 'Safari', ref: 1 },
    { action: 'type', app: 'Safari', text: 'hi' },
    { action: 'key', app: 'Safari', combo: 'cmd+s' },
    { action: 'focus_app', app: 'Safari' },
  ]) {
    assert.equal(tool.requiresApproval(params(input)), true, `${input.action} must gate`)
  }
})

test('granted app skips approval; other apps still gate', () => {
  const tool = darwinTool(new FakeDriver(), ['Safari'])
  assert.equal(tool.requiresApproval(params({ action: 'snapshot', app: 'Safari' })), false)
  assert.equal(tool.requiresApproval(params({ action: 'click', app: 'safari', ref: 1 })), false, 'case-insensitive')
  assert.equal(tool.requiresApproval(params({ action: 'snapshot', app: 'Notes' })), true)
})

test('list_apps always requires approval (no app target); check_permissions never does', () => {
  const tool = darwinTool(new FakeDriver(), ['Safari'])
  assert.equal(tool.requiresApproval(params({ action: 'list_apps' })), true)
  assert.equal(tool.requiresApproval(params({ action: 'check_permissions' })), false)
})

test('missing app on app-targeted action requires approval (fail-closed)', () => {
  const tool = darwinTool(new FakeDriver(), ['Safari'])
  assert.equal(tool.requiresApproval(params({ action: 'snapshot' })), true)
})

// ── Actions via fake driver ───────────────────────────────────────

test('list_apps returns the visible apps', async () => {
  const driver = new FakeDriver()
  const res = await darwinTool(driver).execute(params({ action: 'list_apps' }))
  assert.equal(res.isError, undefined)
  assert.match(res.content, /Safari \(frontmost\)/)
  assert.match(res.content, /Notes/)
})

test('snapshot returns the accessibility tree and saves a screenshot artifact', async () => {
  const driver = new FakeDriver()
  const store = new FakeArtifactStore()
  const res = await darwinTool(driver).execute(params({ action: 'snapshot', app: 'Safari' }, store))
  assert.equal(res.isError, undefined)
  assert.match(res.content, /AXButton "OK"/)
  assert.match(res.content, /artifact computer_use_screenshot:1/)
  assert.equal(store.saved.length, 1)
  assert.equal(store.saved[0]!.tool, 'computer_use_screenshot')
  assert.match(store.saved[0]!.target, /Safari-screenshot\.png$/)
  assert.equal(store.saved[0]!.rawContent, Buffer.from('PNGDATA').toString('base64'))
})

test('snapshot without screenshot still returns the tree (tree-only degrade)', async () => {
  const driver = new FakeDriver()
  driver.screenshot = null
  const store = new FakeArtifactStore()
  const res = await darwinTool(driver).execute(params({ action: 'snapshot', app: 'Safari' }, store))
  assert.equal(res.isError, undefined)
  assert.match(res.content, /screenshot unavailable/)
  assert.equal(store.saved.length, 0)
})

test('click by ref and by coordinates both dispatch to the driver', async () => {
  const driver = new FakeDriver()
  const tool = darwinTool(driver)
  const byRef = await tool.execute(params({ action: 'click', app: 'Safari', ref: 3 }))
  assert.match(byRef.content, /Clicked ref 3 in Safari/)
  const byCoord = await tool.execute(params({ action: 'click', app: 'Safari', x: 100, y: 200 }))
  assert.match(byCoord.content, /Clicked \(100, 200\) in Safari/)
  assert.deepEqual(driver.calls.map(c => c.method), ['click', 'click'])
  assert.deepEqual(driver.calls[0]!.args[1], { ref: 3 })
  assert.deepEqual(driver.calls[1]!.args[1], { x: 100, y: 200 })
})

test('click without ref or coordinates is an error', async () => {
  const res = await darwinTool(new FakeDriver()).execute(params({ action: 'click', app: 'Safari' }))
  assert.equal(res.isError, true)
  assert.match(res.content, /"ref".*or both "x" and "y"/)
})

test('type / key / focus_app dispatch and confirm', async () => {
  const driver = new FakeDriver()
  const tool = darwinTool(driver)
  const typed = await tool.execute(params({ action: 'type', app: 'Notes', text: 'hello' }))
  assert.match(typed.content, /Typed 5 character\(s\) into Notes/)
  const keyed = await tool.execute(params({ action: 'key', app: 'Notes', combo: 'cmd+s' }))
  assert.match(keyed.content, /Sent cmd\+s to Notes/)
  const focused = await tool.execute(params({ action: 'focus_app', app: 'Notes' }))
  assert.match(focused.content, /Focused Notes/)
  assert.deepEqual(driver.calls.map(c => c.method), ['type', 'key', 'focusApp'])
})

test('check_permissions reports missing permissions', async () => {
  const driver = new FakeDriver()
  driver.permissions = { accessibility: false, screenRecording: true, detail: 'Grant Accessibility.' }
  const res = await darwinTool(driver).execute(params({ action: 'check_permissions' }))
  assert.match(res.content, /Accessibility: MISSING/)
  assert.match(res.content, /Screen Recording: granted/)
})

test('missing required inputs produce errors, not driver calls', async () => {
  const driver = new FakeDriver()
  const tool = darwinTool(driver)
  for (const input of [
    { action: 'snapshot' },
    { action: 'type', app: 'Safari' },
    { action: 'type', app: 'Safari', text: '' },
    { action: 'key', app: 'Safari' },
    { action: 'focus_app' },
  ]) {
    const res = await tool.execute(params(input))
    assert.equal(res.isError, true, `${JSON.stringify(input)} should error`)
  }
  assert.equal(driver.calls.length, 0)
})

test('driver failure is surfaced as a tool error', async () => {
  const driver = new FakeDriver()
  driver.snapshot = async () => { throw new Error('ref 5 not found in snapshot') }
  const res = await darwinTool(driver).execute(params({ action: 'snapshot', app: 'Safari' }))
  assert.equal(res.isError, true)
  assert.match(res.content, /computer_use failed: ref 5 not found/)
})

// ── Redaction ─────────────────────────────────────────────────────

test('secure text field values and secret-looking tokens are masked', async () => {
  const driver = new FakeDriver()
  driver.tree = [
    '[1] AXSecureTextField "Password" = hunter2secret',
    '[2] AXTextField "API Key" = sk-abcdef1234567890',
    '[3] AXStaticText "token" = ghp_ABCdef1234567890abcdefABCDEF123456',
    '[4] AXButton "OK"',
  ].join('\n')
  const res = await darwinTool(driver).execute(params({ action: 'snapshot', app: 'Safari' }))
  assert.equal(res.content.includes('hunter2secret'), false)
  assert.equal(res.content.includes('sk-abcdef1234567890'), false)
  assert.equal(res.content.includes('ghp_ABCdef1234567890abcdefABCDEF123456'), false)
  assert.match(res.content, /AXButton "OK"/, 'benign rows survive')
})

// ── Platform gating ───────────────────────────────────────────────

test('non-darwin platform: tool disabled and execute refuses', async () => {
  const driver = new FakeDriver()
  const tool = createComputerUseTool({ platform: 'win32', driverFactory: () => driver })
  assert.equal(tool.isEnabled(), false)
  const res = await tool.execute(params({ action: 'list_apps' }))
  assert.equal(res.isError, true)
  assert.match(res.content, /only available on macOS/)
  assert.equal(driver.calls.length, 0)
})

test('darwin platform: tool enabled by default', () => {
  const tool = createComputerUseTool({ platform: 'darwin', driverFactory: () => new FakeDriver() })
  assert.equal(tool.isEnabled(), true)
})

test('enabled override wins over platform default', () => {
  const tool = createComputerUseTool({ platform: 'darwin', enabled: false, driverFactory: () => new FakeDriver() })
  assert.equal(tool.isEnabled(), false)
})
