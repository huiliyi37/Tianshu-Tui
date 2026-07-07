import { test } from 'node:test'
import assert from 'node:assert/strict'
// This suite exercises the NATIVE driver paths — disable CDP routing so a
// browser-named app ("chrome") can't trigger real endpoint probes.
// CDP routing has its own suite: cdp-tool-routing.test.ts.
process.env.RIVET_CU_CDP = '0'
import { createComputerUseTool } from '../tool.js'
import type { ComputerUseDriver, ClickTarget, ClickOptions, ScrollOptions, SnapshotOptions, PermissionStatus, SnapshotRef } from '../macos-driver.js'
import type { Tool, ToolCallParams } from '../../types.js'
import type { SaveArtifactInput } from '../../../artifact/store.js'

class FakeDriver implements ComputerUseDriver {
  calls: Array<{ method: string; args: unknown[] }> = []
  tree = '[1] AXButton "OK" @(10,20)'
  refs: SnapshotRef[] = [{ ref: 1, path: [0, 0], role: 'AXButton', title: 'OK', pos: { x: 10, y: 20 } }]
  screenshot: Buffer | null = Buffer.from('PNGDATA')
  vision: Buffer | null = Buffer.from('SMALLPNG')
  locateResult: { x: number; y: number } = { x: 15, y: 25 }

  async listApps() {
    this.calls.push({ method: 'listApps', args: [] })
    return [
      { name: 'Safari', frontmost: true },
      { name: 'Notes', frontmost: false },
    ]
  }
  /** Optional per-call overrides, consumed FIFO by snapshot(). */
  snapshotQueue: Array<{ tree: string; refs: SnapshotRef[] }> = []
  async snapshot(app: string, opts?: SnapshotOptions) {
    this.calls.push({ method: 'snapshot', args: [app, opts] })
    const next = this.snapshotQueue.shift()
    if (next) {
      this.tree = next.tree
      this.refs = next.refs
    }
    const withShot = opts?.screenshot !== false
    return {
      tree: this.tree,
      refs: this.refs,
      screenshotPng: withShot ? this.screenshot : null,
      visionPng: withShot ? this.vision : null,
    }
  }
  /** Errors thrown by successive click()/locate() calls, consumed FIFO. */
  clickErrorsOnce: string[] = []
  async click(app: string, target: ClickTarget, opts?: ClickOptions) {
    this.calls.push({ method: 'click', args: [app, target, opts] })
    const err = this.clickErrorsOnce.shift()
    if (err) throw new Error(err)
  }
  locateErrorsOnce: string[] = []
  async locate(app: string, target: { path: number[]; role?: string; title?: string }) {
    this.calls.push({ method: 'locate', args: [app, target] })
    const err = this.locateErrorsOnce.shift()
    if (err) throw new Error(err)
    return this.locateResult
  }
  async scroll(app: string, opts: ScrollOptions) {
    this.calls.push({ method: 'scroll', args: [app, opts] })
  }
  async drag(app: string, from: { x: number; y: number }, to: { x: number; y: number }) {
    this.calls.push({ method: 'drag', args: [app, from, to] })
  }
  async type(app: string, text: string) {
    this.calls.push({ method: 'type', args: [app, text] })
  }
  setValueError: string | null = null
  async setValue(app: string, target: { path: number[]; role?: string; title?: string }, text: string) {
    this.calls.push({ method: 'setValue', args: [app, target, text] })
    if (this.setValueError) throw new Error(this.setValueError)
  }
  async key(app: string, combo: string) {
    this.calls.push({ method: 'key', args: [app, combo] })
  }
  focusError: string | null = null
  async focusApp(app: string) {
    this.calls.push({ method: 'focusApp', args: [app] })
    if (this.focusError) throw new Error(this.focusError)
  }
  async launchApp(app: string) {
    this.calls.push({ method: 'launchApp', args: [app] })
  }
  async menuSelect(app: string, path: string[]) {
    this.calls.push({ method: 'menuSelect', args: [app, path] })
  }
  async pasteText(app: string, text: string) {
    this.calls.push({ method: 'pasteText', args: [app, text] })
  }
  permissions: PermissionStatus = { accessibility: true, screenRecording: true, detail: 'All required permissions granted.' }
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
  return { input, toolUseId: 't1', cwd: '/work', sessionId: 's1', artifactStore: store as never }
}

function darwinTool(driver: FakeDriver, granted: string[] = [], sleep?: (ms: number) => Promise<void>) {
  const grantedSet = new Set(granted.map(a => a.toLowerCase()))
  return createComputerUseTool({
    platform: 'darwin',
    driverFactory: () => driver,
    isAppGranted: (app) => grantedSet.has(app.toLowerCase()),
    sleep,
    // Feedback loop is exercised by its own dedicated tests below; keep the
    // rest of the suite focused on single-action semantics.
    feedback: false,
  })
}

function feedbackTool(driver: FakeDriver) {
  return createComputerUseTool({
    platform: 'darwin',
    driverFactory: () => driver,
    isAppGranted: () => true,
    sleep: async () => {},
    feedback: true,
  })
}

/** Prime the tool's ref cache: snapshot must precede any click-by-ref. */
async function snapshotFirst(tool: Tool, app = 'Safari') {
  await tool.execute(params({ action: 'snapshot', app }))
}

// ── Approval gating (fail-closed per app) ─────────────────────────

test('ungranted app → every interactive action requires approval (fail-closed)', () => {
  const tool = darwinTool(new FakeDriver())
  for (const input of [
    { action: 'snapshot', app: 'Safari' },
    { action: 'click', app: 'Safari', ref: 1 },
    { action: 'double_click', app: 'Safari', ref: 1 },
    { action: 'right_click', app: 'Safari', ref: 1 },
    { action: 'scroll', app: 'Safari', direction: 'down' },
    { action: 'drag', app: 'Safari', from_x: 1, from_y: 2, to_x: 3, to_y: 4 },
    { action: 'type', app: 'Safari', text: 'hi' },
    { action: 'key', app: 'Safari', combo: 'cmd+s' },
    { action: 'focus_app', app: 'Safari' },
    { action: 'launch_app', app: 'Safari' },
    { action: 'menu_select', app: 'Safari', menu_path: 'File > Save' },
    { action: 'paste_text', app: 'Safari', text: 'hi' },
    { action: 'find', app: 'Safari', query: 'OK' },
    { action: 'wait_for', app: 'Safari', text: 'OK' },
    { action: 'set_value', app: 'Safari', ref: 1, text: 'hi' },
  ]) {
    assert.equal(tool.requiresApproval!(params(input)), true, `${input.action} must gate`)
  }
})

test('granted app skips approval; other apps still gate', () => {
  const tool = darwinTool(new FakeDriver(), ['Safari'])
  assert.equal(tool.requiresApproval!(params({ action: 'snapshot', app: 'Safari' })), false)
  assert.equal(tool.requiresApproval!(params({ action: 'click', app: 'safari', ref: 1 })), false, 'case-insensitive')
  assert.equal(tool.requiresApproval!(params({ action: 'scroll', app: 'Safari', direction: 'up' })), false)
  assert.equal(tool.requiresApproval!(params({ action: 'snapshot', app: 'Notes' })), true)
})

test('list_apps always requires approval (no app target); check_permissions and wait never do', () => {
  const tool = darwinTool(new FakeDriver(), ['Safari'])
  assert.equal(tool.requiresApproval!(params({ action: 'list_apps' })), true)
  assert.equal(tool.requiresApproval!(params({ action: 'check_permissions' })), false)
  assert.equal(tool.requiresApproval!(params({ action: 'wait', duration_ms: 500 })), false)
})

test('missing app on app-targeted action requires approval (fail-closed)', () => {
  const tool = darwinTool(new FakeDriver(), ['Safari'])
  assert.equal(tool.requiresApproval!(params({ action: 'snapshot' })), true)
})

// ── Actions via fake driver ───────────────────────────────────────

test('list_apps returns the visible apps', async () => {
  const driver = new FakeDriver()
  const res = await darwinTool(driver).execute(params({ action: 'list_apps' }))
  assert.equal(res.isError, undefined)
  assert.match(res.content, /Safari \(frontmost\)/)
  assert.match(res.content, /Notes/)
  assert.equal(res.content.includes('—'), false, 'no title separator when titles absent')
})

test('list_apps shows window titles when the driver provides them (Windows)', async () => {
  const driver = new FakeDriver()
  driver.listApps = async () => [
    { name: 'chrome', title: 'GitHub - Google Chrome', frontmost: true },
    { name: 'Calculator', title: '', frontmost: false },
    { name: 'notepad', title: 'notepad', frontmost: false },
  ]
  const res = await darwinTool(driver).execute(params({ action: 'list_apps' }))
  assert.match(res.content, /- chrome — "GitHub - Google Chrome" \(frontmost\)/)
  assert.match(res.content, /- Calculator\n/, 'empty title → bare name')
  assert.match(res.content, /- notepad$/m, 'title identical to name → not repeated')
})

test('snapshot returns the accessibility tree, saves a screenshot artifact and fills images', async () => {
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
  // Vision channel: downsampled copy → data URL (pipeline decides whether to use it).
  assert.deepEqual(res.images, [`data:image/png;base64,${Buffer.from('SMALLPNG').toString('base64')}`])
})

test('snapshot without screenshot still returns the tree (tree-only degrade)', async () => {
  const driver = new FakeDriver()
  driver.screenshot = null
  driver.vision = null
  const store = new FakeArtifactStore()
  const res = await darwinTool(driver).execute(params({ action: 'snapshot', app: 'Safari' }, store))
  assert.equal(res.isError, undefined)
  assert.match(res.content, /screenshot unavailable/)
  assert.equal(store.saved.length, 0)
  assert.equal(res.images, undefined)
})

// ── Snapshot dedup ────────────────────────────────────────────────

test('identical consecutive snapshots dedupe to a short unchanged note (no images)', async () => {
  const driver = new FakeDriver()
  const tool = darwinTool(driver)
  const first = await tool.execute(params({ action: 'snapshot', app: 'Safari' }))
  assert.match(first.content, /AXButton "OK"/)
  const second = await tool.execute(params({ action: 'snapshot', app: 'Safari' }))
  assert.match(second.content, /UI unchanged since the last snapshot/)
  assert.equal(second.content.includes('AXButton'), false, 'tree not repeated')
  assert.equal(second.images, undefined, 'no image re-attachment on dedup hit')
})

test('changed tree returns the full snapshot again', async () => {
  const driver = new FakeDriver()
  const tool = darwinTool(driver)
  await tool.execute(params({ action: 'snapshot', app: 'Safari' }))
  driver.tree = '[1] AXButton "Cancel" @(10,20)'
  driver.refs = [{ ref: 1, path: [0, 0], role: 'AXButton', title: 'Cancel', pos: { x: 10, y: 20 } }]
  const res = await tool.execute(params({ action: 'snapshot', app: 'Safari' }))
  assert.match(res.content, /AXButton "Cancel"/)
})

test('dedup is scoped per app — different app is never "unchanged"', async () => {
  const driver = new FakeDriver()
  const tool = darwinTool(driver)
  await tool.execute(params({ action: 'snapshot', app: 'Safari' }))
  const other = await tool.execute(params({ action: 'snapshot', app: 'Notes' }))
  assert.match(other.content, /AXButton "OK"/)
})

// ── Click targeting via cached AX paths ───────────────────────────

test('click by ref resolves the cached AX path with identity check', async () => {
  const driver = new FakeDriver()
  const tool = darwinTool(driver)
  await snapshotFirst(tool)
  const res = await tool.execute(params({ action: 'click', app: 'Safari', ref: 1 }))
  assert.match(res.content, /Clicked ref 1 "OK" in Safari/)
  const click = driver.calls.find(c => c.method === 'click')!
  assert.deepEqual(click.args[1], { path: [0, 0], role: 'AXButton', title: 'OK' })
  assert.deepEqual(click.args[2], { button: 'left', count: 1 })
})

test('click by ref without a prior snapshot is rejected', async () => {
  const driver = new FakeDriver()
  const res = await darwinTool(driver).execute(params({ action: 'click', app: 'Safari', ref: 1 }))
  assert.equal(res.isError, true)
  assert.match(res.content, /take a snapshot first/)
  assert.equal(driver.calls.filter(c => c.method === 'click').length, 0)
})

test('unknown ref (not in latest snapshot) is rejected as stale', async () => {
  const driver = new FakeDriver()
  const tool = darwinTool(driver)
  await snapshotFirst(tool)
  const res = await tool.execute(params({ action: 'click', app: 'Safari', ref: 99 }))
  assert.equal(res.isError, true)
  assert.match(res.content, /ref 99 is not in the latest Safari snapshot/)
})

test('click by coordinates dispatches raw coords', async () => {
  const driver = new FakeDriver()
  const res = await darwinTool(driver).execute(params({ action: 'click', app: 'Safari', x: 100, y: 200 }))
  assert.match(res.content, /Clicked \(100, 200\) in Safari/)
  const click = driver.calls.find(c => c.method === 'click')!
  assert.deepEqual(click.args[1], { x: 100, y: 200 })
})

test('click without ref or coordinates is an error', async () => {
  const res = await darwinTool(new FakeDriver()).execute(params({ action: 'click', app: 'Safari' }))
  assert.equal(res.isError, true)
  assert.match(res.content, /"ref".*or both "x" and "y"/)
})

test('double_click and right_click carry button/count options', async () => {
  const driver = new FakeDriver()
  const tool = darwinTool(driver)
  await snapshotFirst(tool)
  const dbl = await tool.execute(params({ action: 'double_click', app: 'Safari', ref: 1 }))
  assert.match(dbl.content, /Double-clicked ref 1/)
  const right = await tool.execute(params({ action: 'right_click', app: 'Safari', x: 5, y: 6 }))
  assert.match(right.content, /Right-clicked \(5, 6\)/)
  const clicks = driver.calls.filter(c => c.method === 'click')
  assert.deepEqual(clicks[0]!.args[2], { button: 'left', count: 2 })
  assert.deepEqual(clicks[1]!.args[2], { button: 'right', count: 1 })
})

// ── Scroll / drag / wait ──────────────────────────────────────────

test('scroll validates direction and passes amount + resolved ref position', async () => {
  const driver = new FakeDriver()
  const tool = darwinTool(driver)
  const bad = await tool.execute(params({ action: 'scroll', app: 'Safari' }))
  assert.equal(bad.isError, true)
  assert.match(bad.content, /direction/)

  await snapshotFirst(tool)
  const res = await tool.execute(params({ action: 'scroll', app: 'Safari', direction: 'down', amount: 10, ref: 1 }))
  assert.match(res.content, /Scrolled down by 10 in Safari at \(15, 25\)/)
  const scroll = driver.calls.find(c => c.method === 'scroll')!
  assert.deepEqual(scroll.args[1], { direction: 'down', amount: 10, at: { x: 15, y: 25 } })
})

test('scroll without target scrolls the window center (driver default)', async () => {
  const driver = new FakeDriver()
  const res = await darwinTool(driver).execute(params({ action: 'scroll', app: 'Safari', direction: 'up' }))
  assert.match(res.content, /Scrolled up in Safari\./)
  const scroll = driver.calls.find(c => c.method === 'scroll')!
  assert.deepEqual(scroll.args[1], { direction: 'up', amount: undefined, at: undefined })
})

test('drag resolves ref endpoints via locate and coordinate endpoints directly', async () => {
  const driver = new FakeDriver()
  const tool = darwinTool(driver)
  await snapshotFirst(tool)
  const res = await tool.execute(params({ action: 'drag', app: 'Safari', from_ref: 1, to_x: 300, to_y: 400 }))
  assert.match(res.content, /Dragged from \(15, 25\) to \(300, 400\) in Safari/)
  const drag = driver.calls.find(c => c.method === 'drag')!
  assert.deepEqual(drag.args[1], { x: 15, y: 25 })
  assert.deepEqual(drag.args[2], { x: 300, y: 400 })
})

test('drag with a stale from_ref is rejected before any driver drag', async () => {
  const driver = new FakeDriver()
  const res = await darwinTool(driver).execute(params({ action: 'drag', app: 'Safari', from_ref: 7, to_x: 1, to_y: 2 }))
  assert.equal(res.isError, true)
  assert.match(res.content, /take a snapshot first/)
  assert.equal(driver.calls.filter(c => c.method === 'drag').length, 0)
})

test('wait sleeps (capped at 5000ms) without touching the driver', async () => {
  const driver = new FakeDriver()
  const slept: number[] = []
  const tool = darwinTool(driver, [], async (ms) => { slept.push(ms) })
  const res = await tool.execute(params({ action: 'wait', duration_ms: 99_999 }))
  assert.match(res.content, /Waited 5000ms/)
  assert.deepEqual(slept, [5000])
  const dflt = await tool.execute(params({ action: 'wait' }))
  assert.match(dflt.content, /Waited 1000ms/)
  assert.equal(driver.calls.length, 0)
})

// ── Other actions ─────────────────────────────────────────────────

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
    { action: 'scroll' },
    { action: 'drag', app: 'Safari' },
  ]) {
    const res = await tool.execute(params(input))
    assert.equal(res.isError, true, `${JSON.stringify(input)} should error`)
  }
  assert.equal(driver.calls.length, 0)
})

test('driver failure is surfaced as a tool error', async () => {
  const driver = new FakeDriver()
  driver.snapshot = async () => { throw new Error('window not found') }
  const res = await darwinTool(driver).execute(params({ action: 'snapshot', app: 'Safari' }))
  assert.equal(res.isError, true)
  assert.match(res.content, /computer_use failed: window not found/)
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

test('unsupported platform: tool disabled and execute refuses', async () => {
  const driver = new FakeDriver()
  const tool = createComputerUseTool({ platform: 'linux', driverFactory: () => driver })
  assert.equal(tool.isEnabled!(), false)
  const res = await tool.execute(params({ action: 'list_apps' }))
  assert.equal(res.isError, true)
  assert.match(res.content, /only available on macOS and Windows/)
  assert.equal(driver.calls.length, 0)
})

test('darwin platform: tool enabled by default', () => {
  const tool = createComputerUseTool({ platform: 'darwin', driverFactory: () => new FakeDriver() })
  assert.equal(tool.isEnabled!(), true)
})

test('win32 platform: tool enabled by default and actions execute', async () => {
  const driver = new FakeDriver()
  const tool = createComputerUseTool({ platform: 'win32', driverFactory: () => driver, feedback: false })
  assert.equal(tool.isEnabled!(), true)
  const list = await tool.execute(params({ action: 'list_apps' }))
  assert.equal(list.isError, undefined)
  assert.match(list.content, /Visible apps/)
  const snap = await tool.execute(params({ action: 'snapshot', app: 'notepad' }))
  assert.equal(snap.isError, undefined)
  const click = await tool.execute(params({ action: 'click', app: 'notepad', ref: 1 }))
  assert.equal(click.isError, undefined)
  assert.deepEqual(driver.calls.map((c) => c.method), ['listApps', 'snapshot', 'click'])
})

test('enabled override wins over platform default', () => {
  const tool = createComputerUseTool({ platform: 'darwin', enabled: false, driverFactory: () => new FakeDriver() })
  assert.equal(tool.isEnabled!(), false)
})

// ── New actions: launch_app / menu_select / paste_text ────────────

test('launch_app dispatches to the driver', async () => {
  const driver = new FakeDriver()
  const res = await darwinTool(driver).execute(params({ action: 'launch_app', app: 'Notes' }))
  assert.equal(res.isError, undefined)
  assert.match(res.content, /Launched Notes/)
  assert.deepEqual(driver.calls[0], { method: 'launchApp', args: ['Notes'] })
})

test('menu_select splits the "A > B > C" path and validates input', async () => {
  const driver = new FakeDriver()
  const tool = darwinTool(driver)
  const res = await tool.execute(params({ action: 'menu_select', app: 'Notes', menu_path: 'File >  Export> PNG ' }))
  assert.equal(res.isError, undefined)
  assert.match(res.content, /Selected menu File > Export > PNG in Notes/)
  assert.deepEqual(driver.calls[0], { method: 'menuSelect', args: ['Notes', ['File', 'Export', 'PNG']] })

  const missing = await tool.execute(params({ action: 'menu_select', app: 'Notes' }))
  assert.equal(missing.isError, true)
  const blank = await tool.execute(params({ action: 'menu_select', app: 'Notes', menu_path: ' > ' }))
  assert.equal(blank.isError, true)
})

test('paste_text dispatches to the driver and flags the clipboard overwrite', async () => {
  const driver = new FakeDriver()
  const tool = darwinTool(driver)
  const res = await tool.execute(params({ action: 'paste_text', app: 'Notes', text: 'long text\nwith lines' }))
  assert.equal(res.isError, undefined)
  assert.match(res.content, /Pasted 20 character\(s\)/)
  assert.match(res.content, /clipboard/)
  assert.deepEqual(driver.calls[0], { method: 'pasteText', args: ['Notes', 'long text\nwith lines'] })

  const empty = await tool.execute(params({ action: 'paste_text', app: 'Notes', text: '' }))
  assert.equal(empty.isError, true)
})

// ── Post-action feedback loop ─────────────────────────────────────

test('feedback: UI change appends a diff with new refs and refreshes the cache', async () => {
  const driver = new FakeDriver()
  const tool = feedbackTool(driver)
  await snapshotFirst(tool)

  // Simulate a click that opens a dialog: tree + refs change.
  driver.tree = '[1] AXButton "OK" @(10,20)\n[2] AXSheet "Save?" @(30,40)'
  driver.refs = [
    { ref: 1, path: [0, 0], role: 'AXButton', title: 'OK', pos: { x: 10, y: 20 } },
    { ref: 2, path: [0, 1], role: 'AXSheet', title: 'Save?', pos: { x: 30, y: 40 } },
  ]
  const res = await tool.execute(params({ action: 'click', app: 'Safari', ref: 1 }))
  assert.equal(res.isError, undefined)
  assert.match(res.content, /^Clicked ref 1/)
  assert.match(res.content, /UI changed after action \(\+1\/-0 elements\)/)
  assert.match(res.content, /\+ \[2\] AXSheet "Save\?"/)
  assert.match(res.content, /refs refreshed/)

  // Feedback snapshot must be tree-only and must refresh the ref cache:
  // ref 2 (which only exists in the post-action tree) is now clickable.
  const feedbackSnap = driver.calls.filter((c) => c.method === 'snapshot').at(-1)
  assert.deepEqual(feedbackSnap?.args, ['Safari', { screenshot: false }])
  const second = await tool.execute(params({ action: 'click', app: 'Safari', ref: 2 }))
  assert.equal(second.isError, undefined, 'ref from the feedback diff resolves against the refreshed cache')
})

test('feedback: unchanged UI appends the unchanged note', async () => {
  const driver = new FakeDriver()
  const tool = feedbackTool(driver)
  await snapshotFirst(tool)
  const res = await tool.execute(params({ action: 'key', app: 'Safari', combo: 'cmd+s' }))
  assert.match(res.content, /^Sent cmd\+s to Safari\./)
  assert.match(res.content, /UI unchanged after action\./)
})

test('feedback: no prior snapshot → caches state without dumping the tree', async () => {
  const driver = new FakeDriver()
  const tool = feedbackTool(driver)
  const res = await tool.execute(params({ action: 'click', app: 'Safari', x: 5, y: 6 }))
  assert.match(res.content, /Post-action UI state cached \(1 elements\)/)
  assert.equal(res.content.includes('AXButton'), false, 'tree not dumped')
  // Cache primed by feedback: ref 1 is clickable without an explicit snapshot.
  const byRef = await tool.execute(params({ action: 'click', app: 'Safari', ref: 1 }))
  assert.equal(byRef.isError, undefined)
})

test('feedback: snapshot failure never taints the action result', async () => {
  const driver = new FakeDriver()
  driver.snapshot = async () => { throw new Error('walk failed') }
  const tool = feedbackTool(driver)
  const res = await tool.execute(params({ action: 'type', app: 'Safari', text: 'hi' }))
  assert.equal(res.isError, undefined)
  assert.equal(res.content, 'Typed 2 character(s) into Safari.')
})

test('feedback: disabled via option → no extra snapshot, bare result', async () => {
  const driver = new FakeDriver()
  const tool = darwinTool(driver, ['Safari'])
  await snapshotFirst(tool)
  const res = await tool.execute(params({ action: 'key', app: 'Safari', combo: 'return' }))
  assert.equal(res.content, 'Sent return to Safari.')
  assert.equal(driver.calls.filter((c) => c.method === 'snapshot').length, 1, 'only the explicit snapshot ran')
})

test('feedback: secrets in the post-action tree are redacted in the diff', async () => {
  const driver = new FakeDriver()
  const tool = feedbackTool(driver)
  await snapshotFirst(tool)
  driver.tree = '[1] AXButton "OK" @(10,20)\n[2] AXStaticText "token" = sk-abcdef1234567890abcdef'
  const res = await tool.execute(params({ action: 'click', app: 'Safari', ref: 1 }))
  assert.equal(res.content.includes('sk-abcdef1234567890abcdef'), false)
  assert.match(res.content, /\*\*\*/)
})

// ── stale ref self-heal ───────────────────────────────────────────

test('stale click: unique role+title match → auto-heal, retry with fresh path, note in result', async () => {
  const driver = new FakeDriver()
  const tool = darwinTool(driver, ['Safari'])
  await snapshotFirst(tool)
  driver.clickErrorsOnce = ['stale snapshot — element role changed (AXGroup != AXButton), re-snapshot first']
  // The UI reshuffled: same button, new ref and path.
  driver.snapshotQueue = [{
    tree: '[5] AXButton "OK" @(30,40)',
    refs: [{ ref: 5, path: [0, 3], role: 'AXButton', title: 'OK', pos: { x: 30, y: 40 } }],
  }]
  const res = await tool.execute(params({ action: 'click', app: 'Safari', ref: 1 }))
  assert.equal(res.isError, undefined)
  assert.match(res.content, /auto-matched the same AXButton "OK" as ref 5/)
  const clicks = driver.calls.filter((c) => c.method === 'click')
  assert.equal(clicks.length, 2, 'failed click + healed retry')
  assert.deepEqual((clicks[1]?.args[1] as { path: number[] }).path, [0, 3], 'retry uses the fresh path')
})

test('stale click: ambiguous match → no retry, error says cache refreshed', async () => {
  const driver = new FakeDriver()
  const tool = darwinTool(driver, ['Safari'])
  await snapshotFirst(tool)
  driver.clickErrorsOnce = ['stale snapshot — element path no longer valid, re-snapshot first']
  driver.snapshotQueue = [{
    tree: '[1] AXButton "OK"\n[2] AXButton "OK"',
    refs: [
      { ref: 1, path: [0, 0], role: 'AXButton', title: 'OK', pos: null },
      { ref: 2, path: [0, 1], role: 'AXButton', title: 'OK', pos: null },
    ],
  }]
  const res = await tool.execute(params({ action: 'click', app: 'Safari', ref: 1 }))
  assert.equal(res.isError, true)
  assert.match(res.content, /2 elements match/)
  assert.match(res.content, /Ref cache refreshed/)
  assert.equal(driver.calls.filter((c) => c.method === 'click').length, 1, 'no blind retry')
  // The refreshed cache is immediately usable.
  const followUp = await tool.execute(params({ action: 'click', app: 'Safari', ref: 2 }))
  assert.equal(followUp.isError, undefined)
})

test('non-stale click error is not healed — propagates as a plain failure', async () => {
  const driver = new FakeDriver()
  const tool = darwinTool(driver, ['Safari'])
  await snapshotFirst(tool)
  driver.clickErrorsOnce = ['element has no on-screen position']
  const res = await tool.execute(params({ action: 'click', app: 'Safari', ref: 1 }))
  assert.equal(res.isError, true)
  assert.match(res.content, /no on-screen position/)
  assert.equal(driver.calls.filter((c) => c.method === 'snapshot').length, 1, 'no heal snapshot')
})

test('stale locate (scroll by ref): healed once, scroll proceeds', async () => {
  const driver = new FakeDriver()
  const tool = darwinTool(driver, ['Safari'])
  await snapshotFirst(tool)
  driver.locateErrorsOnce = ['stale snapshot — element title changed, re-snapshot first']
  driver.snapshotQueue = [{
    tree: '[7] AXButton "OK" @(50,60)',
    refs: [{ ref: 7, path: [0, 4], role: 'AXButton', title: 'OK', pos: { x: 50, y: 60 } }],
  }]
  const res = await tool.execute(params({ action: 'scroll', app: 'Safari', direction: 'down', ref: 1 }))
  assert.equal(res.isError, undefined)
  const locates = driver.calls.filter((c) => c.method === 'locate')
  assert.equal(locates.length, 2)
  assert.deepEqual((locates[1]?.args[1] as { path: number[] }).path, [0, 4])
})

// ── find ──────────────────────────────────────────────────────────

const BIG_TREE = [
  'Menu bar: File | Edit | View',
  '[1] AXWindow "Doc" @(0,0)',
  '  [2] AXGroup "toolbar" @(0,0)',
  '    [3] AXButton "Save" @(5,5)',
  '    [4] AXButton "Cancel" @(9,9)',
  '  [5] AXTextArea "body" = draft text @(0,30)',
].join('\n')

const BIG_REFS: SnapshotRef[] = [
  { ref: 1, path: [0], role: 'AXWindow', title: 'Doc', pos: { x: 0, y: 0 } },
  { ref: 2, path: [0, 0], role: 'AXGroup', title: 'toolbar', pos: { x: 0, y: 0 } },
  { ref: 3, path: [0, 0, 0], role: 'AXButton', title: 'Save', pos: { x: 5, y: 5 } },
  { ref: 4, path: [0, 0, 1], role: 'AXButton', title: 'Cancel', pos: { x: 9, y: 9 } },
  { ref: 5, path: [0, 1], role: 'AXTextArea', title: 'body', pos: { x: 0, y: 30 } },
]

test('find: returns matching lines with ancestor chain, caches ALL refs', async () => {
  const driver = new FakeDriver()
  driver.tree = BIG_TREE
  driver.refs = BIG_REFS
  const tool = darwinTool(driver, ['Safari'])
  const res = await tool.execute(params({ action: 'find', app: 'Safari', query: 'save' }))
  assert.equal(res.isError, undefined)
  assert.match(res.content, /\[3\] AXButton "Save"/)
  assert.match(res.content, /\[2\] AXGroup "toolbar"/, 'ancestor included')
  assert.match(res.content, /\[1\] AXWindow "Doc"/, 'root ancestor included')
  assert.equal(res.content.includes('Cancel'), false, 'non-matching sibling excluded')
  // Full refs cached: an unlisted ref is still clickable.
  const click = await tool.execute(params({ action: 'click', app: 'Safari', ref: 4 }))
  assert.equal(click.isError, undefined)
})

test('find: value text matches too; zero hits fall back to the outline', async () => {
  const driver = new FakeDriver()
  driver.tree = BIG_TREE
  driver.refs = BIG_REFS
  const tool = darwinTool(driver, ['Safari'])
  const byValue = await tool.execute(params({ action: 'find', app: 'Safari', query: 'draft text' }))
  assert.match(byValue.content, /\[5\] AXTextArea "body"/)

  const miss = await tool.execute(params({ action: 'find', app: 'Safari', query: 'nonexistent' }))
  assert.equal(miss.isError, undefined)
  assert.match(miss.content, /No elements matching "nonexistent"/)
  assert.match(miss.content, /Menu bar: File \| Edit \| View/)
  assert.match(miss.content, /\[1\] AXWindow "Doc"/)
  assert.equal(miss.content.includes('[3]'), false, 'outline stays top-level')

  const blank = await tool.execute(params({ action: 'find', app: 'Safari' }))
  assert.equal(blank.isError, true)
})

// ── wait_for ──────────────────────────────────────────────────────

test('wait_for: appears on a later poll → success with matching lines and timing', async () => {
  const driver = new FakeDriver()
  driver.tree = '[1] AXWindow "Doc"'
  driver.refs = [{ ref: 1, path: [0], role: 'AXWindow', title: 'Doc', pos: null }]
  driver.snapshotQueue = [
    { tree: '[1] AXWindow "Doc"', refs: driver.refs },
    { tree: '[1] AXWindow "Doc"\n  [2] AXSheet "存储" @(1,1)', refs: [...driver.refs, { ref: 2, path: [0, 0], role: 'AXSheet', title: '存储', pos: { x: 1, y: 1 } }] },
  ]
  const sleeps: number[] = []
  const tool = darwinTool(driver, ['Safari'], async (ms) => { sleeps.push(ms) })
  const res = await tool.execute(params({ action: 'wait_for', app: 'Safari', text: '存储', timeout_ms: 15_000 }))
  assert.equal(res.isError, undefined)
  assert.match(res.content, /"存储" appeared in Safari after \d+ms/)
  assert.match(res.content, /\[2\] AXSheet "存储"/)
  assert.equal(sleeps.length, 1, 'one poll gap before the hit')
  // Cache refreshed by the poll — new ref is clickable.
  const click = await tool.execute(params({ action: 'click', app: 'Safari', ref: 2 }))
  assert.equal(click.isError, undefined)
})

test('wait_for: timeout → isError with orientation outline; gone-mode waits for disappearance', async () => {
  const driver = new FakeDriver()
  driver.tree = '[1] AXWindow "Doc"'
  driver.refs = [{ ref: 1, path: [0], role: 'AXWindow', title: 'Doc', pos: null }]
  const tool = darwinTool(driver, ['Safari'], async () => {})
  const miss = await tool.execute(params({ action: 'wait_for', app: 'Safari', text: 'Ghost', timeout_ms: 1 }))
  assert.equal(miss.isError, true)
  assert.match(miss.content, /timed out after 1ms/)
  assert.match(miss.content, /\[1\] AXWindow "Doc"/)

  // gone: the text vanishes on the second poll.
  driver.tree = '[1] AXWindow "Doc"\n  [2] AXProgressIndicator "载入中"'
  driver.snapshotQueue = [
    { tree: driver.tree, refs: driver.refs },
    { tree: '[1] AXWindow "Doc"', refs: driver.refs },
  ]
  const gone = await tool.execute(params({ action: 'wait_for', app: 'Safari', text: '载入中', gone: true, timeout_ms: 15_000 }))
  assert.equal(gone.isError, undefined)
  assert.match(gone.content, /"载入中" is gone from Safari/)

  const blank = await tool.execute(params({ action: 'wait_for', app: 'Safari' }))
  assert.equal(blank.isError, true)
})

// ── set_value ─────────────────────────────────────────────────────

test('set_value: routes ref + text to driver.setValue with the cached path', async () => {
  const driver = new FakeDriver()
  const tool = darwinTool(driver, ['Safari'])
  await snapshotFirst(tool)
  const res = await tool.execute(params({ action: 'set_value', app: 'Safari', ref: 1, text: 'hello 世界' }))
  assert.equal(res.isError, undefined)
  assert.match(res.content, /Set value of ref 1 \(AXButton "OK"\) to 8 character\(s\)/)
  const call = driver.calls.find((c) => c.method === 'setValue')
  assert.deepEqual(call?.args, ['Safari', { path: [0, 0], role: 'AXButton', title: 'OK' }, 'hello 世界'])
})

test('set_value: driver rejection (unsupported control) surfaces the fallback guidance', async () => {
  const driver = new FakeDriver()
  driver.setValueError = 'element does not accept direct value writes — click it and use type/paste_text instead'
  const tool = darwinTool(driver, ['Safari'])
  await snapshotFirst(tool)
  const res = await tool.execute(params({ action: 'set_value', app: 'Safari', ref: 1, text: 'x' }))
  assert.equal(res.isError, true)
  assert.match(res.content, /type\/paste_text/)
})

test('set_value: missing ref or text rejected locally; empty text allowed (clear)', async () => {
  const driver = new FakeDriver()
  const tool = darwinTool(driver, ['Safari'])
  await snapshotFirst(tool)
  const noRef = await tool.execute(params({ action: 'set_value', app: 'Safari', text: 'x' }))
  assert.equal(noRef.isError, true)
  const noText = await tool.execute(params({ action: 'set_value', app: 'Safari', ref: 1 }))
  assert.equal(noText.isError, true)
  const clear = await tool.execute(params({ action: 'set_value', app: 'Safari', ref: 1, text: '' }))
  assert.equal(clear.isError, undefined)
})

// ── app name fuzzy hint ───────────────────────────────────────────

test('driver error + fuzzy app name → "did you mean" hint with visible apps', async () => {
  const driver = new FakeDriver()
  driver.focusError = `Can't get process "safar"`
  const tool = darwinTool(driver, ['safar'])
  const res = await tool.execute(params({ action: 'focus_app', app: 'safar' }))
  assert.equal(res.isError, true)
  assert.match(res.content, /Did you mean "Safari"\?/)
  assert.match(res.content, /Visible apps: Safari, Notes/)
})

test('driver error + no fuzzy match → visible apps listed without a guess', async () => {
  const driver = new FakeDriver()
  driver.focusError = `Can't get process "chrome"`
  const tool = darwinTool(driver, ['chrome'])
  const res = await tool.execute(params({ action: 'focus_app', app: 'chrome' }))
  assert.equal(res.isError, true)
  assert.match(res.content, /No visible app matches "chrome"/)
  assert.equal(res.content.includes('Did you mean'), false)
})

test('driver error on an app that IS visible → no name hint appended', async () => {
  const driver = new FakeDriver()
  driver.focusError = 'window server connection lost'
  const tool = darwinTool(driver, ['Safari'])
  const res = await tool.execute(params({ action: 'focus_app', app: 'Safari' }))
  assert.equal(res.isError, true)
  assert.match(res.content, /window server connection lost/)
  assert.equal(res.content.includes('Did you mean'), false)
  assert.equal(res.content.includes('Visible apps'), false)
})
