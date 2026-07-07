import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createComputerUseTool } from '../tool.js'
import type {
  AppInfo,
  ClickOptions,
  ClickTarget,
  ComputerUseDriver,
  PermissionStatus,
  ScrollOptions,
  SnapshotOptions,
  SnapshotRef,
} from '../macos-driver.js'
import type { CdpBrowserDriver } from '../cdp/driver.js'
import type { ToolCallParams } from '../../types.js'

// ── fakes ───────────────────────────────────────────────────────────

class FakeNativeDriver implements ComputerUseDriver {
  calls: string[] = []
  async listApps(): Promise<AppInfo[]> { this.calls.push('listApps'); return [{ name: 'Google Chrome', frontmost: true }] }
  async snapshot(_app: string, _opts?: SnapshotOptions) {
    this.calls.push('snapshot')
    const refs: SnapshotRef[] = [{ ref: 1, path: [0, 0], role: 'AXButton', title: 'OK', pos: { x: 1, y: 2 } }]
    return { tree: '[1] AXButton "OK"', refs, screenshotPng: null, visionPng: null }
  }
  async click(_app: string, _t: ClickTarget, _o?: ClickOptions) { this.calls.push('click') }
  async locate() { this.calls.push('locate'); return { x: 1, y: 2 } }
  async scroll(_app: string, _o: ScrollOptions) { this.calls.push('scroll') }
  async drag() { this.calls.push('drag') }
  async type() { this.calls.push('type') }
  async setValue() { this.calls.push('setValue') }
  async key() { this.calls.push('key') }
  async focusApp() { this.calls.push('focusApp') }
  async launchApp() { this.calls.push('launchApp') }
  async menuSelect() { this.calls.push('menuSelect') }
  async pasteText() { this.calls.push('pasteText') }
  async checkPermissions(): Promise<PermissionStatus> {
    this.calls.push('checkPermissions')
    return { accessibility: true, screenRecording: true, detail: 'ok' }
  }
}

class FakeCdpDriver implements CdpBrowserDriver {
  calls: Array<{ method: string; args: unknown[] }> = []
  availableResult = true
  availableCalls: boolean[] = []
  async available(allowLaunch: boolean) {
    this.availableCalls.push(allowLaunch)
    return this.availableResult
  }
  endpointInfo() { return { httpBase: 'http://127.0.0.1:9999', source: 'dedicated' as const } }
  async listApps(): Promise<AppInfo[]> { this.calls.push({ method: 'listApps', args: [] }); return [] }
  async snapshot(app: string, opts?: SnapshotOptions) {
    this.calls.push({ method: 'snapshot', args: [app, opts] })
    const refs: SnapshotRef[] = [{ ref: 1, path: [0, 9], role: 'link', title: 'More', pos: { x: 5, y: 6 } }]
    return { tree: 'Page: "T" — https://t/\n[1] link "More" @(5,6)', refs, screenshotPng: null, visionPng: null }
  }
  async click(app: string, target: ClickTarget, opts?: ClickOptions) { this.calls.push({ method: 'click', args: [app, target, opts] }) }
  async locate() { this.calls.push({ method: 'locate', args: [] }); return { x: 5, y: 6 } }
  async scroll() { this.calls.push({ method: 'scroll', args: [] }) }
  async drag() { this.calls.push({ method: 'drag', args: [] }) }
  async type() { this.calls.push({ method: 'type', args: [] }) }
  async setValue() { this.calls.push({ method: 'setValue', args: [] }) }
  async key() { this.calls.push({ method: 'key', args: [] }) }
  async focusApp() { this.calls.push({ method: 'focusApp', args: [] }) }
  async launchApp() { this.calls.push({ method: 'launchApp', args: [] }) }
  async menuSelect() { this.calls.push({ method: 'menuSelect', args: [] }) }
  async pasteText() { this.calls.push({ method: 'pasteText', args: [] }) }
  async checkPermissions(): Promise<PermissionStatus> {
    return { accessibility: true, screenRecording: true, detail: 'cdp' }
  }
  async navigate(target: string) { this.calls.push({ method: 'navigate', args: [target] }); return `Navigated to "T" — ${target}` }
  async readPage() { this.calls.push({ method: 'readPage', args: [] }); return 'Page: "T" — https://t/\n\nbody text' }
  async evalJs(expression: string) { this.calls.push({ method: 'evalJs', args: [expression] }); return '42' }
  async tabs(op: string, arg?: { index?: number; url?: string }) {
    this.calls.push({ method: 'tabs', args: [op, arg] })
    return op === 'list' ? 'Open tabs (* = active):\n1. * "T" — https://t/' : `did ${op}`
  }
  async adopt(endpoint: string) { this.calls.push({ method: 'adopt', args: [endpoint] }); return `Adopted browser at ${endpoint}` }
}

function params(input: Record<string, unknown>): ToolCallParams {
  return { input, toolUseId: 't1', cwd: '/work', sessionId: 's1' }
}

function makeTool(opts: { cdp?: FakeCdpDriver; native?: FakeNativeDriver; cdpEnabled?: boolean; granted?: boolean } = {}) {
  const native = opts.native ?? new FakeNativeDriver()
  const cdp = opts.cdp ?? new FakeCdpDriver()
  const tool = createComputerUseTool({
    platform: 'darwin',
    driverFactory: () => native,
    cdpDriverFactory: () => cdp,
    cdpEnabled: opts.cdpEnabled ?? true,
    isAppGranted: () => opts.granted ?? true,
    sleep: async () => {},
    feedback: false,
  })
  return { tool, native, cdp }
}

// ── hybrid routing ──────────────────────────────────────────────────

test('routing: browser app + CDP available → CDP driver serves snapshot', async () => {
  const { tool, native, cdp } = makeTool()
  const res = await tool.execute(params({ action: 'snapshot', app: 'Google Chrome' }))
  assert.match(res.content, /link "More"/)
  assert.equal(cdp.calls.filter((c) => c.method === 'snapshot').length, 1)
  assert.ok(!native.calls.includes('snapshot'), 'native driver must not be touched')
})

test('routing: non-browser app never touches CDP', async () => {
  const { tool, native, cdp } = makeTool()
  await tool.execute(params({ action: 'snapshot', app: 'TextEdit' }))
  assert.ok(native.calls.includes('snapshot'))
  assert.equal(cdp.availableCalls.length, 0, 'no CDP probe for non-browser apps')
})

test('routing: CDP unavailable → graceful native fallback (Chrome via AX)', async () => {
  const cdp = new FakeCdpDriver()
  cdp.availableResult = false
  const { tool, native } = makeTool({ cdp })
  await tool.execute(params({ action: 'snapshot', app: 'Google Chrome' }))
  assert.ok(native.calls.includes('snapshot'))
  assert.deepEqual(cdp.availableCalls, [false], 'probed once, without launch permission')
})

test('routing: RIVET_CU_CDP=0 (cdpEnabled:false) short-circuits to native, no probe', async () => {
  const { tool, native, cdp } = makeTool({ cdpEnabled: false })
  await tool.execute(params({ action: 'snapshot', app: 'Google Chrome' }))
  assert.ok(native.calls.includes('snapshot'))
  assert.equal(cdp.availableCalls.length, 0)
})

test('routing: launch_app on a browser passes allowLaunch=true (dedicated profile may spawn)', async () => {
  const { tool, cdp } = makeTool()
  await tool.execute(params({ action: 'launch_app', app: 'Google Chrome' }))
  assert.deepEqual(cdp.availableCalls, [true])
  assert.ok(cdp.calls.some((c) => c.method === 'launchApp'))
})

test('routing: menu_select on a browser stays native (menu bar is an OS object)', async () => {
  const { tool, native, cdp } = makeTool()
  await tool.execute(params({ action: 'menu_select', app: 'Google Chrome', menu_path: 'File > Print' }))
  assert.ok(native.calls.includes('menuSelect'))
  assert.equal(cdp.calls.filter((c) => c.method === 'menuSelect').length, 0)
})

test('routing: click by ref flows through the shared ref cache onto the CDP driver', async () => {
  const { tool, cdp } = makeTool()
  await tool.execute(params({ action: 'snapshot', app: 'Google Chrome' }))
  const res = await tool.execute(params({ action: 'click', app: 'Google Chrome', ref: 1 }))
  assert.match(res.content, /Clicked ref 1/)
  const click = cdp.calls.find((c) => c.method === 'click')!
  assert.deepEqual(click.args[1], { path: [0, 9], role: 'link', title: 'More' })
})

// ── browser-only actions ────────────────────────────────────────────

test('browser actions: navigate / read_page / js_eval / tabs / browser_adopt reach the CDP driver', async () => {
  const { tool, cdp } = makeTool()
  const nav = await tool.execute(params({ action: 'navigate', app: 'Google Chrome', url: 'https://example.com' }))
  assert.match(nav.content, /Navigated to "T"/)
  const read = await tool.execute(params({ action: 'read_page', app: 'Google Chrome' }))
  assert.match(read.content, /body text/)
  const evalRes = await tool.execute(params({ action: 'js_eval', app: 'Google Chrome', expression: '1+41' }))
  assert.match(evalRes.content, /js_eval result:\n42/)
  const tabs = await tool.execute(params({ action: 'tabs', app: 'Google Chrome' }))
  assert.match(tabs.content, /Open tabs/)
  const adopt = await tool.execute(params({ action: 'browser_adopt', endpoint: 'localhost:9222' }))
  assert.match(adopt.content, /Adopted browser at localhost:9222/)
  assert.deepEqual(cdp.calls.filter((c) => c.method === 'tabs')[0]!.args, ['list', { index: undefined, url: undefined }])
})

test('browser actions: disabled backend → clear error, missing inputs → validation errors', async () => {
  const { tool } = makeTool({ cdpEnabled: false })
  const res = await tool.execute(params({ action: 'navigate', app: 'Google Chrome', url: 'https://x' }))
  assert.equal(res.isError, true)
  assert.match(res.content, /navigate requires the CDP browser backend, which is disabled \(RIVET_CU_CDP=0\)/)

  const { tool: enabled } = makeTool()
  const noUrl = await enabled.execute(params({ action: 'navigate', app: 'Google Chrome' }))
  assert.equal(noUrl.isError, true)
  assert.match(noUrl.content, /navigate requires "url"/)
  const noExpr = await enabled.execute(params({ action: 'js_eval', app: 'Google Chrome' }))
  assert.equal(noExpr.isError, true)
  assert.match(noExpr.content, /js_eval requires "expression"/)
  const noEndpoint = await enabled.execute(params({ action: 'browser_adopt' }))
  assert.equal(noEndpoint.isError, true)
  assert.match(noEndpoint.content, /browser_adopt requires "endpoint"/)
  const badOp = await enabled.execute(params({ action: 'tabs', app: 'Google Chrome', tab_op: 'explode' }))
  assert.equal(badOp.isError, true)
  assert.match(badOp.content, /must be one of: list, activate, new, close/)
  const noApp = await enabled.execute(params({ action: 'read_page' }))
  assert.equal(noApp.isError, true)
  assert.match(noApp.content, /read_page requires "app"/)
})

// ── approval: js_eval / browser_adopt can NEVER ride a grant ────────

test('approval: js_eval and browser_adopt require approval even with an "always allow" grant', () => {
  const { tool } = makeTool({ granted: true })
  assert.equal(tool.requiresApproval(params({ action: 'js_eval', app: 'Google Chrome', expression: '1' })), true)
  assert.equal(tool.requiresApproval(params({ action: 'browser_adopt', endpoint: 'localhost:9222' })), true)
  // Sanity: the grant DOES waive ordinary actions…
  assert.equal(tool.requiresApproval(params({ action: 'navigate', app: 'Google Chrome', url: 'https://x' })), false)
  assert.equal(tool.requiresApproval(params({ action: 'snapshot', app: 'Google Chrome' })), false)
})

test('approval: without a grant every browser action still gates', () => {
  const { tool } = makeTool({ granted: false })
  for (const input of [
    { action: 'navigate', app: 'Google Chrome', url: 'https://x' },
    { action: 'read_page', app: 'Google Chrome' },
    { action: 'tabs', app: 'Google Chrome' },
    { action: 'js_eval', app: 'Google Chrome', expression: '1' },
    { action: 'browser_adopt', endpoint: 'localhost:9222' },
  ]) {
    assert.equal(tool.requiresApproval(params(input)), true, `${String(input.action)} must gate`)
  }
})
