import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import type { CdpTransportFactory, FetchLike } from '../cdp/client.js'
import { resetEndpointForTests } from '../cdp/chrome.js'
import { createCdpDriver, normalizeNavigationUrl, type CdpBrowserDriver } from '../cdp/driver.js'

beforeEach(() => resetEndpointForTests())

// ── fake CDP world ──────────────────────────────────────────────────

interface Call {
  method: string
  params: Record<string, unknown>
  sessionId?: string
}

type Handler = (params: Record<string, unknown>, sessionId: string | undefined) => unknown

/** Default page AX tree: RootWebArea → heading + link → StaticText. */
const DEFAULT_AX_NODES = [
  { nodeId: '1', role: { value: 'RootWebArea' }, name: { value: 'Example Domain' }, backendDOMNodeId: 1, childIds: ['2', '3'] },
  { nodeId: '2', role: { value: 'heading' }, name: { value: 'Example Domain' }, backendDOMNodeId: 5, childIds: [], parentId: '1' },
  { nodeId: '3', role: { value: 'link' }, name: { value: 'More information...' }, backendDOMNodeId: 9, childIds: ['4'], parentId: '1' },
  { nodeId: '4', role: { value: 'StaticText' }, name: { value: 'More information...' }, backendDOMNodeId: 10, childIds: [], parentId: '3' },
]

function defaultHandlers(): Record<string, Handler> {
  return {
    'Target.getTargets': () => ({
      targetInfos: [
        { targetId: 'PAGE-1', type: 'page', title: 'Example Domain', url: 'https://example.com/' },
        { targetId: 'DEVTOOLS', type: 'page', title: 'DevTools', url: 'devtools://devtools/x' },
      ],
    }),
    'Target.attachToTarget': () => ({ sessionId: 'sess-main' }),
    'Target.setAutoAttach': () => ({}),
    'Target.activateTarget': () => ({}),
    'Page.enable': () => ({}),
    'DOM.enable': () => ({}),
    'Accessibility.enable': () => ({}),
    'Browser.setDownloadBehavior': () => ({}),
    'Accessibility.getFullAXTree': () => ({ nodes: DEFAULT_AX_NODES }),
    'DOMSnapshot.enable': () => ({}),
    'DOMSnapshot.captureSnapshot': () => ({
      documents: [{
        scrollOffsetX: 0,
        scrollOffsetY: 0,
        nodes: { backendNodeId: [1, 5, 9, 10] },
        layout: { nodeIndex: [1, 2], bounds: [[10, 20, 100, 30], [10, 60, 80, 20]] },
      }],
    }),
    'Page.getNavigationHistory': () => ({
      currentIndex: 0,
      entries: [{ id: 1, url: 'https://example.com/', title: 'Example Domain' }],
    }),
    'Page.getLayoutMetrics': () => ({ cssVisualViewport: { clientWidth: 800, clientHeight: 600 } }),
    'Page.captureScreenshot': () => ({ data: Buffer.from('FAKEPNG').toString('base64') }),
    'Page.bringToFront': () => ({}),
    'Accessibility.getPartialAXTree': () => ({ nodes: [{ nodeId: '3', role: { value: 'link' }, name: { value: 'More information...' } }] }),
    'DOM.scrollIntoViewIfNeeded': () => ({}),
    'DOM.getContentQuads': () => ({ quads: [[100, 200, 140, 200, 140, 220, 100, 220]] }),
    'Input.dispatchMouseEvent': () => ({}),
    'Input.dispatchKeyEvent': () => ({}),
    'Input.insertText': () => ({}),
    'DOM.resolveNode': () => ({ object: { objectId: 'obj-1' } }),
    'Runtime.callFunctionOn': () => ({ result: { value: 'ok' } }),
    'Runtime.evaluate': () => ({ result: { value: JSON.stringify({ title: 'Example Domain', url: 'https://example.com/' }) } }),
  }
}

function makeWorld(overrides: Record<string, Handler> = {}): { driver: CdpBrowserDriver; calls: Call[] } {
  const handlers = { ...defaultHandlers(), ...overrides }
  const calls: Call[] = []
  const transportFactory: CdpTransportFactory = async (_url, transportHandlers) => ({
    send: (data: string) => {
      const msg = JSON.parse(data) as { id: number; method: string; params: Record<string, unknown>; sessionId?: string }
      calls.push({ method: msg.method, params: msg.params, sessionId: msg.sessionId })
      const handler = handlers[msg.method]
      queueMicrotask(() => {
        if (!handler) {
          transportHandlers.onMessage(JSON.stringify({ id: msg.id, error: { message: `unhandled method ${msg.method}` } }))
          return
        }
        try {
          const result = handler(msg.params, msg.sessionId)
          transportHandlers.onMessage(JSON.stringify({ id: msg.id, result: result ?? {} }))
          // Navigations fire a load event shortly after — emulate so
          // waitForLoad() resolves instead of running out its timeout.
          if (msg.method === 'Page.navigate' || msg.method === 'Page.reload' || msg.method === 'Page.navigateToHistoryEntry') {
            queueMicrotask(() => transportHandlers.onMessage(JSON.stringify({
              method: 'Page.loadEventFired', params: { timestamp: 1 }, sessionId: 'sess-main',
            })))
          }
        } catch (err) {
          transportHandlers.onMessage(JSON.stringify({ id: msg.id, error: { message: (err as Error).message } }))
        }
      })
    },
    close: () => { /* noop */ },
  })
  const fetchImpl: FetchLike = async (url) => {
    if (url.includes('/json/version')) {
      return { ok: true, status: 200, json: async () => ({ webSocketDebuggerUrl: 'ws://fake/browser', Browser: 'FakeChrome/1' }), text: async () => '' }
    }
    if (url.includes('/json/list')) {
      return { ok: true, status: 200, json: async () => ([{ id: 'PAGE-1', type: 'page', title: 'Example Domain', url: 'https://example.com/' }]), text: async () => '' }
    }
    return { ok: false, status: 404, json: async () => ({}), text: async () => '' }
  }
  const driver = createCdpDriver({
    transportFactory,
    fetchImpl,
    chromeDeps: {
      platform: 'darwin',
      env: { RIVET_CU_CDP_URL: 'http://fake-endpoint:9999' },
      fetchImpl,
      existsSyncImpl: () => false,
    },
  })
  return { driver, calls }
}

const APP = 'Google Chrome'

// ── snapshot ────────────────────────────────────────────────────────

test('cdp snapshot: tree format is line-identical to the native drivers ([ref] role "title" @(x,y))', async () => {
  const { driver } = makeWorld()
  const snap = await driver.snapshot(APP, { screenshot: false })
  assert.equal(snap.tree, [
    'Page: "Example Domain" — https://example.com/',
    '[1] RootWebArea "Example Domain"',
    '  [2] heading "Example Domain" @(10,20)',
    '  [3] link "More information..." @(10,60)',
    '    [4] StaticText "More information..."',
  ].join('\n'))
  // Refs encode [frameOrdinal, backendNodeId] — the tool caches them as-is.
  assert.deepEqual(snap.refs.map((r) => ({ ref: r.ref, path: r.path, role: r.role, title: r.title })), [
    { ref: 1, path: [0, 1], role: 'RootWebArea', title: 'Example Domain' },
    { ref: 2, path: [0, 5], role: 'heading', title: 'Example Domain' },
    { ref: 3, path: [0, 9], role: 'link', title: 'More information...' },
    { ref: 4, path: [0, 10], role: 'StaticText', title: 'More information...' },
  ])
  assert.equal(snap.screenshotPng, null)
  assert.equal(snap.visionPng, null)
})

test('cdp snapshot: ignored/unnamed structural nodes are suppressed, children promoted', async () => {
  const { driver } = makeWorld({
    'Accessibility.getFullAXTree': () => ({
      nodes: [
        { nodeId: '1', role: { value: 'RootWebArea' }, name: { value: 'T' }, backendDOMNodeId: 1, childIds: ['2'] },
        { nodeId: '2', role: { value: 'generic' }, backendDOMNodeId: 2, childIds: ['3'], parentId: '1' },
        { nodeId: '3', ignored: true, role: { value: 'button' }, name: { value: 'Hidden' }, backendDOMNodeId: 3, childIds: ['4'], parentId: '2' },
        { nodeId: '4', role: { value: 'button' }, name: { value: 'Visible' }, backendDOMNodeId: 4, childIds: ['5'], parentId: '3' },
        // Layout fragment: duplicates its parent's text — must NEVER emit,
        // even though it carries a name (real-machine finding).
        { nodeId: '5', role: { value: 'InlineTextBox' }, name: { value: 'Visible' }, backendDOMNodeId: 5, childIds: [], parentId: '4' },
      ],
    }),
  })
  const snap = await driver.snapshot(APP, { screenshot: false })
  const lines = snap.tree.split('\n')
  assert.ok(!lines.some((l) => l.includes('generic')), 'unnamed generic suppressed')
  assert.ok(!lines.some((l) => l.includes('Hidden')), 'ignored node suppressed')
  assert.ok(!lines.some((l) => l.includes('InlineTextBox')), 'named InlineTextBox suppressed')
  // Visible button survives at the depth of its nearest emitted ancestor + 1.
  assert.ok(lines.some((l) => l.trim().startsWith('[2] button "Visible"')))
})

test('cdp snapshot: screenshot rides Page.captureScreenshot (no OS capture)', async () => {
  const { driver, calls } = makeWorld()
  const snap = await driver.snapshot(APP)
  assert.deepEqual(snap.screenshotPng, Buffer.from('FAKEPNG'))
  assert.ok(snap.visionPng, 'vision copy present')
  assert.ok(calls.some((c) => c.method === 'Page.captureScreenshot'))
  assert.ok(!calls.some((c) => c.method === 'Page.captureScreenshot' && c.params.clip), 'small viewport → no scaled clip capture')
})

// ── click + stale wording (byte-locked to macos-driver.ts) ──────────

test('cdp click by ref: identity check → scrollIntoView → quads center → mouse events', async () => {
  const { driver, calls } = makeWorld()
  await driver.click(APP, { path: [0, 9], role: 'link', title: 'More information...' })
  const mouse = calls.filter((c) => c.method === 'Input.dispatchMouseEvent')
  assert.deepEqual(mouse.map((m) => m.params.type), ['mouseMoved', 'mousePressed', 'mouseReleased'])
  // Quad (100,200)-(140,220) → center (120,210).
  assert.equal(mouse[1]!.params.x, 120)
  assert.equal(mouse[1]!.params.y, 210)
  assert.equal(mouse[1]!.params.button, 'left')
  assert.ok(calls.some((c) => c.method === 'DOM.scrollIntoViewIfNeeded'))
})

test('cdp stale wording: role change / title change / dead node — byte-identical to macOS driver', async () => {
  const roleChanged = makeWorld({
    'Accessibility.getPartialAXTree': () => ({ nodes: [{ nodeId: '3', role: { value: 'button' }, name: { value: 'More information...' } }] }),
  })
  await assert.rejects(
    roleChanged.driver.click(APP, { path: [0, 9], role: 'link', title: 'More information...' }),
    (err: Error) => err.message === 'stale snapshot — element role changed (button != link), re-snapshot first',
  )

  const titleChanged = makeWorld({
    'Accessibility.getPartialAXTree': () => ({ nodes: [{ nodeId: '3', role: { value: 'link' }, name: { value: 'Other' } }] }),
  })
  await assert.rejects(
    titleChanged.driver.click(APP, { path: [0, 9], role: 'link', title: 'More information...' }),
    (err: Error) => err.message === 'stale snapshot — element title changed, re-snapshot first',
  )

  const deadNode = makeWorld({
    'Accessibility.getPartialAXTree': () => { throw new Error('No node with given id found') },
  })
  await assert.rejects(
    deadNode.driver.click(APP, { path: [0, 9], role: 'link' }),
    (err: Error) => err.message === 'stale snapshot — element path no longer valid, re-snapshot first',
  )
})

test('cdp stale wording: frame ordinal out of range matches the window-index message', async () => {
  const { driver } = makeWorld()
  await driver.snapshot(APP, { screenshot: false }) // frameSessions = [main]
  await assert.rejects(
    driver.click(APP, { path: [7, 9], role: 'link' }),
    (err: Error) => err.message === 'stale snapshot — window index out of range, re-snapshot first',
  )
})

test('cdp click by coordinates: dispatches at the given viewport point', async () => {
  const { driver, calls } = makeWorld()
  await driver.click(APP, { x: 33, y: 44 }, { button: 'right' })
  const pressed = calls.find((c) => c.method === 'Input.dispatchMouseEvent' && c.params.type === 'mousePressed')!
  assert.equal(pressed.params.x, 33)
  assert.equal(pressed.params.y, 44)
  assert.equal(pressed.params.button, 'right')
})

test('cdp locate: returns quads center (validated like click)', async () => {
  const { driver } = makeWorld()
  const point = await driver.locate(APP, { path: [0, 9], role: 'link', title: 'More information...' })
  assert.deepEqual(point, { x: 120, y: 210 })
})

// ── set_value ───────────────────────────────────────────────────────

test('cdp setValue: native setter + input/change events; unwritable → exact guidance error', async () => {
  const ok = makeWorld()
  await ok.driver.setValue(APP, { path: [0, 9], role: 'link' }, 'hello')
  const call = ok.calls.find((c) => c.method === 'Runtime.callFunctionOn')!
  assert.ok(String(call.params.functionDeclaration).includes("dispatchEvent(new Event('input'"), 'fires input event for framework bindings')
  assert.deepEqual(call.params.arguments, [{ value: 'hello' }])

  const unwritable = makeWorld({ 'Runtime.callFunctionOn': () => ({ result: { value: 'unwritable' } }) })
  await assert.rejects(
    unwritable.driver.setValue(APP, { path: [0, 9], role: 'link' }, 'x'),
    (err: Error) => err.message === 'element does not accept direct value writes — click it and use type/paste_text instead',
  )
})

// ── type / key / scroll / paste ─────────────────────────────────────

test('cdp type: insertText segments with real Enter keystrokes between lines', async () => {
  const { driver, calls } = makeWorld()
  await driver.type(APP, 'ab\ncd')
  const inserts = calls.filter((c) => c.method === 'Input.insertText').map((c) => c.params.text)
  assert.deepEqual(inserts, ['ab', 'cd'])
  const keys = calls.filter((c) => c.method === 'Input.dispatchKeyEvent')
  assert.equal(keys.length, 2) // Enter down + up
  assert.equal(keys[0]!.params.key, 'Enter')
})

test('cdp key: cmd+s maps to Meta on darwin; unknown modifier throws', async () => {
  const { driver, calls } = makeWorld()
  await driver.key(APP, 'cmd+s')
  const down = calls.find((c) => c.method === 'Input.dispatchKeyEvent')!
  assert.equal(down.params.modifiers, 4) // Meta
  assert.equal(down.params.key, 's')
  assert.equal(down.params.text, undefined, 'meta chords produce no text input')
  await assert.rejects(driver.key(APP, 'hyper+s'), /unknown modifier "hyper" in combo "hyper\+s"/)
})

test('cdp scroll: mouseWheel at viewport center with line-scaled deltas', async () => {
  const { driver, calls } = makeWorld()
  await driver.scroll(APP, { direction: 'down', amount: 3 })
  const wheel = calls.find((c) => c.method === 'Input.dispatchMouseEvent' && c.params.type === 'mouseWheel')!
  assert.equal(wheel.params.deltaY, 300)
  assert.equal(wheel.params.deltaX, 0)
  assert.equal(wheel.params.x, 400) // 800×600 viewport center
  assert.equal(wheel.params.y, 300)
})

test('cdp pasteText: direct insertText, no OS clipboard involved', async () => {
  const { driver, calls } = makeWorld()
  await driver.pasteText(APP, 'long text')
  assert.ok(calls.some((c) => c.method === 'Input.insertText' && c.params.text === 'long text'))
})

// ── browser-specific verbs ──────────────────────────────────────────

test('cdp navigate: url gets https:// default and Page.navigate; errorText throws', async () => {
  const { driver, calls } = makeWorld({ 'Page.navigate': () => ({}) })
  const note = await driver.navigate('example.com')
  const nav = calls.find((c) => c.method === 'Page.navigate')!
  assert.equal(nav.params.url, 'https://example.com')
  assert.match(note, /^Navigated to "Example Domain" — https:\/\/example\.com\//)

  const failing = makeWorld({ 'Page.navigate': () => ({ errorText: 'net::ERR_NAME_NOT_RESOLVED' }) })
  await assert.rejects(failing.driver.navigate('https://nope.invalid'), /navigation to https:\/\/nope\.invalid failed: net::ERR_NAME_NOT_RESOLVED/)
})

test('cdp navigate: back with no history entry reports instead of throwing', async () => {
  const { driver } = makeWorld()
  const note = await driver.navigate('back')
  assert.equal(note, 'Cannot go back — no history entry in that direction.')
})

test('cdp navigate: non-http(s) schemes are refused before any CDP call', async () => {
  // file: (local exfiltration via read_page), javascript:/data: (script
  // injection), chrome: (browser internals) — all blocked, no Page.navigate.
  for (const target of [
    'file:///etc/passwd',
    'javascript:alert(1)',
    'data:text/html,<script>1</script>',
    'chrome://settings',
    'view-source:https://example.com',
  ]) {
    const { driver, calls } = makeWorld({ 'Page.navigate': () => ({}) })
    await assert.rejects(driver.navigate(target), /navigation blocked: protocol/)
    assert.ok(!calls.some((c) => c.method === 'Page.navigate'), `${target} must not reach Page.navigate`)
  }
})

test('cdp tabs new: url goes through the same protocol gate', async () => {
  const { driver, calls } = makeWorld()
  await assert.rejects(driver.tabs('new', { url: 'file:///etc/hosts' }), /navigation blocked: protocol/)
  assert.ok(!calls.some((c) => c.method === 'Target.createTarget'), 'blocked url must not create a target')
})

test('normalizeNavigationUrl: http/https pass, bare host coerced, garbage rejected', () => {
  assert.equal(normalizeNavigationUrl('example.com'), 'https://example.com')
  assert.equal(normalizeNavigationUrl('http://localhost:3000/app'), 'http://localhost:3000/app')
  assert.equal(normalizeNavigationUrl(' https://a.dev/x '), 'https://a.dev/x')
  assert.throws(() => normalizeNavigationUrl('http://'), /invalid URL/)
})

test('cdp readPage: full innerText with page identity header', async () => {
  const { driver } = makeWorld({
    'Runtime.evaluate': () => ({ result: { value: JSON.stringify({ title: 'T', url: 'https://t/', text: 'Full body text far beyond the tree cap.' }) } }),
  })
  const out = await driver.readPage()
  assert.equal(out, 'Page: "T" — https://t/\n\nFull body text far beyond the tree cap.')
})

test('cdp evalJs: returns values, throws on page exceptions', async () => {
  const ok = makeWorld({ 'Runtime.evaluate': () => ({ result: { value: { answer: 42 } } }) })
  assert.equal(await ok.driver.evalJs('({answer: 42})'), JSON.stringify({ answer: 42 }, null, 2))

  const throwing = makeWorld({
    'Runtime.evaluate': () => ({ exceptionDetails: { text: 'Uncaught', exception: { description: 'ReferenceError: nope is not defined' } } }),
  })
  await assert.rejects(throwing.driver.evalJs('nope'), /js_eval threw: ReferenceError: nope is not defined/)
})

test('cdp tabs: list marks the active tab; activate re-attaches; close clears active session', async () => {
  const { driver, calls } = makeWorld({
    'Target.getTargets': () => ({
      targetInfos: [
        { targetId: 'PAGE-1', type: 'page', title: 'One', url: 'https://one/' },
        { targetId: 'PAGE-2', type: 'page', title: 'Two', url: 'https://two/' },
      ],
    }),
  })
  const list = await driver.tabs('list')
  assert.match(list, /1\. \* "One" — https:\/\/one\//)
  assert.match(list, /2\. "Two" — https:\/\/two\//)

  const note = await driver.tabs('activate', { index: 2 })
  assert.match(note, /Activated tab 2: "Two"/)
  assert.ok(calls.some((c) => c.method === 'Target.activateTarget' && c.params.targetId === 'PAGE-2'))

  const bad = await driver.tabs('close', { index: 9 })
  assert.match(bad, /requires "tab" between 1 and 2/)
})

test('cdp menuSelect: browsers have no CDP menu bar — guidance error', async () => {
  const { driver } = makeWorld()
  await assert.rejects(
    driver.menuSelect(APP, ['File', 'Print']),
    /browser menus are not exposed over CDP \(asked for "File > Print"\)/,
  )
})

test('cdp checkPermissions: no OS permissions needed', async () => {
  const { driver } = makeWorld()
  const perm = await driver.checkPermissions()
  assert.equal(perm.accessibility, true)
  assert.equal(perm.screenRecording, true)
  assert.match(perm.detail, /DevTools protocol/)
})

test('cdp available: true with fake endpoint, false when nothing answers', async () => {
  const { driver } = makeWorld()
  assert.equal(await driver.available(false), true)

  resetEndpointForTests()
  const deadFetch: FetchLike = async () => { throw new Error('ECONNREFUSED') }
  const dead = createCdpDriver({
    fetchImpl: deadFetch,
    chromeDeps: { platform: 'darwin', env: {}, fetchImpl: deadFetch, existsSyncImpl: () => false },
  })
  assert.equal(await dead.available(false), false)
})
