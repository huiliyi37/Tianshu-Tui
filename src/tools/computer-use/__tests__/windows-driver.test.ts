import { test } from 'node:test'
import assert from 'node:assert/strict'

// This file locks the MANAGED (System.Windows.Automation) builders — disable
// the COM path so createWindowsDriver never injects a probe call into the
// fake runners. COM routing has its own suite (windows-uia-com.test.ts).
process.env.RIVET_CU_COM = '0'

import {
  createWindowsDriver,
  parseCombo,
  psString,
  normalizeAppName,
  rowsToSnapshot,
  buildListAppsScript,
  buildSnapshotScript,
  buildClickByPathScript,
  buildClickAtScript,
  buildLocateScript,
  buildScrollScript,
  buildDragScript,
  buildTypeScript,
  buildKeyScript,
  buildFocusAppScript,
  buildLaunchAppScript,
  buildMenuSelectScript,
  buildPasteTextScript,
  buildSetValueScript,
  type WindowsSnapshotRow,
} from '../windows-driver.js'

// ── pure helpers ──────────────────────────────────────────────────

test('psString escapes single quotes for PowerShell literals', () => {
  assert.equal(psString('notepad'), `'notepad'`)
  assert.equal(psString("it's a 'test'"), `'it''s a ''test'''`)
})

test('normalizeAppName strips .exe suffix case-insensitively', () => {
  assert.equal(normalizeAppName('notepad.exe'), 'notepad')
  assert.equal(normalizeAppName('Notepad.EXE'), 'Notepad')
  assert.equal(normalizeAppName(' notepad '), 'notepad')
  assert.equal(normalizeAppName('explorer'), 'explorer')
})

// ── combo parsing (cmd→Ctrl ergonomics) ───────────────────────────

test('parseCombo: cmd maps to Ctrl (VK 0x11)', () => {
  const spec = parseCombo('cmd+s')
  assert.deepEqual(spec.modifiers, [0x11])
  assert.deepEqual(spec.key, { char: 's' })
})

test('parseCombo: multi-modifier combos, dedup, alt/opt/win aliases', () => {
  const spec = parseCombo('shift+cmd+ctrl+4')
  // cmd and ctrl both map to VK_CONTROL — deduped.
  assert.deepEqual(spec.modifiers, [0x10, 0x11])
  assert.deepEqual(spec.key, { char: '4' })
  assert.deepEqual(parseCombo('opt+tab').modifiers, [0x12])
  assert.deepEqual(parseCombo('alt+tab').modifiers, [0x12])
  assert.deepEqual(parseCombo('win+d').modifiers, [0x5b])
})

test('parseCombo: named keys map to virtual-key codes', () => {
  assert.deepEqual(parseCombo('return').key, { vk: 0x0d })
  assert.deepEqual(parseCombo('enter').key, { vk: 0x0d })
  assert.deepEqual(parseCombo('escape').key, { vk: 0x1b })
  assert.deepEqual(parseCombo('left').key, { vk: 0x25 })
  assert.deepEqual(parseCombo('cmd+delete').key, { vk: 0x08 })
})

test('parseCombo: unknown modifier or multi-char key throws', () => {
  assert.throws(() => parseCombo('hyper+s'), /unknown modifier "hyper"/)
  assert.throws(() => parseCombo('cmd+banana'), /unknown key "banana"/)
})

// ── snapshot formatting (byte-parity with the macOS tree) ─────────

test('rowsToSnapshot formats the numbered tree exactly like the macOS driver', () => {
  const rows: WindowsSnapshotRow[] = [
    { ref: 1, depth: 0, role: 'Window', title: 'Untitled - Notepad', value: '', pos: { x: 100, y: 50 }, path: [0] },
    { ref: 2, depth: 1, role: 'Edit', title: '', value: 'hello', pos: { x: 110, y: 90 }, path: [0, 0] },
    { ref: 3, depth: 1, role: 'Button', title: 'Save', value: '', pos: null, path: [0, 1] },
  ]
  const { tree, refs } = rowsToSnapshot(rows)
  assert.equal(
    tree,
    '[1] Window "Untitled - Notepad" @(100,50)\n' +
    '  [2] Edit = hello @(110,90)\n' +
    '  [3] Button "Save"',
  )
  assert.equal(refs.length, 3)
  assert.deepEqual(refs[1], { ref: 2, path: [0, 0], role: 'Edit', title: '', pos: { x: 110, y: 90 } })
})

test('rowsToSnapshot surfaces the first MenuBar children as a macOS-parity header', () => {
  const rows: WindowsSnapshotRow[] = [
    { ref: 1, depth: 0, role: 'Window', title: 'Doc', value: '', pos: null, path: [0] },
    { ref: 2, depth: 1, role: 'MenuBar', title: '', value: '', pos: null, path: [0, 0] },
    { ref: 3, depth: 2, role: 'MenuItem', title: '文件', value: '', pos: null, path: [0, 0, 0] },
    { ref: 4, depth: 3, role: 'MenuItem', title: '新建', value: '', pos: null, path: [0, 0, 0, 0] },
    { ref: 5, depth: 2, role: 'MenuItem', title: '编辑', value: '', pos: null, path: [0, 0, 1] },
    { ref: 6, depth: 1, role: 'Edit', title: '', value: '', pos: null, path: [0, 1] },
  ]
  const { tree } = rowsToSnapshot(rows)
  assert.ok(tree.startsWith('Menu bar: 文件 | 编辑\n'), `header line first, got: ${tree.split('\n')[0]}`)
  assert.match(tree, /\[2\] MenuBar/, 'MenuBar rows still present in the body')
})

test('rowsToSnapshot omits the menu header when there is no MenuBar or it is empty', () => {
  const plain = rowsToSnapshot([
    { ref: 1, depth: 0, role: 'Window', title: 'Doc', value: '', pos: null, path: [0] },
  ])
  assert.equal(plain.tree.includes('Menu bar:'), false)
  const emptyBar = rowsToSnapshot([
    { ref: 1, depth: 0, role: 'MenuBar', title: '', value: '', pos: null, path: [0] },
  ])
  assert.equal(emptyBar.tree.includes('Menu bar:'), false)
})

test('rowsToSnapshot caps indent depth at 8 and defaults missing role to "element"', () => {
  const rows: WindowsSnapshotRow[] = [
    { ref: 1, depth: 12, role: '', title: 'deep', value: '', pos: null, path: [0, 1, 2] },
  ]
  const { tree } = rowsToSnapshot(rows)
  assert.equal(tree, `${'  '.repeat(8)}[1] element "deep"`)
})

// ── script builders ───────────────────────────────────────────────

test('buildSnapshotScript embeds app, node cap, and escaped output paths', () => {
  const s = buildSnapshotScript("my'app", 'C:\\tmp\\full.png', 'C:\\tmp\\vision.png')
  assert.match(s, /\$app = 'my''app'/)
  assert.match(s, /\$MAX = 400/)
  // Add-Type is guarded so re-running the prelude inside the resident PS
  // host (types already compiled at bootstrap) is a no-op instead of a throw.
  assert.match(s, /if \(-not \('RivetInput' -as \[type\]\)\)/)
  assert.ok(s.includes(`'C:\\tmp\\full.png'`))
  assert.ok(s.includes(`'C:\\tmp\\vision.png'`))
  assert.match(s, /CopyFromScreen/)
  assert.match(s, /1440/)
})

test('buildSnapshotScript walk is CacheRequest-batched with Cached reads only', () => {
  const s = buildSnapshotScript('notepad', 'C:\\tmp\\full.png', 'C:\\tmp\\vision.png')
  assert.match(s, /New-Object System\.Windows\.Automation\.CacheRequest/)
  for (const prop of ['NameProperty', 'ControlTypeProperty', 'BoundingRectangleProperty']) {
    assert.ok(s.includes(`$cr.Add([System.Windows.Automation.AutomationElement]::${prop})`), `${prop} cached`)
  }
  assert.ok(s.includes('$cr.Add([System.Windows.Automation.ValuePattern]::Pattern)'), 'ValuePattern cached')
  assert.ok(s.includes('$cr.Add([System.Windows.Automation.ValuePattern]::ValueProperty)'), 'Value cached')
  assert.match(s, /GetUpdatedCache\(\$cr\)/, 'window roots refreshed into the cache')
  assert.match(s, /TryGetCachedPattern/, 'value read from the cache, not live')
  assert.match(s, /\$el\.Cached\.ControlType/, 'props read from Cached')
  assert.equal(s.includes('$el.Current.ControlType'), false, 'no per-node live reads in the walk')
  assert.equal(s.includes('TryGetCurrentPattern'), false, 'no per-node live pattern probes')
  // Children come one-batch-per-parent in ControlViewWalker-compatible order.
  assert.match(s, /FindAll\(\[System\.Windows\.Automation\.TreeScope\]::Children, \$ctrlCond\)/)
  assert.match(s, /ControlViewCondition/)
  // macOS-parity walk pruning.
  assert.match(s, /\$NO_DESCEND = @\{ ScrollBar = \$true; TitleBar = \$true \}/)
  assert.match(s, /\$SKIP_VALUE = @\{ Window = \$true;/)
})

test('buildSnapshotScript tree-only variant omits the screenshot section entirely', () => {
  const s = buildSnapshotScript('notepad', 'C:\\tmp\\full.png', 'C:\\tmp\\vision.png', false)
  assert.equal(s.includes('CopyFromScreen'), false)
  assert.equal(s.includes('System.Drawing'), false)
  assert.equal(s.includes('C:\\tmp\\full.png'), false)
  assert.match(s, /\$shotOk = \$false/, 'shot flag still emitted for the JSON envelope')
  assert.match(s, /CacheRequest/, 'tree walk intact')
})

test('buildLaunchAppScript starts the process only when not running and polls for a window', () => {
  const s = buildLaunchAppScript('notepad.exe')
  assert.match(s, /\$app = 'notepad'/, 'exe suffix normalized')
  assert.match(s, /Start-Process -FilePath \$app/)
  assert.match(s, /did not show a window within 10s/)
  assert.match(s, /SetForegroundWindow/)
  // The poll goes through findApp, which also matches UIA window titles —
  // frame-hosted UWP apps get waited on, not just classic processes.
  assert.match(s, /NativeWindowHandle/)
  assert.ok(s.split('Start-Sleep -Milliseconds 250').length >= 2, 'poll loop present')
})

// ── app resolution (UWP / title fallback) ─────────────────────────

test('app resolution falls back from process match to UIA window-title match', () => {
  const s = buildFocusAppScript('Calculator')
  // Pass 1: classic process-name / main-window-title match.
  assert.match(s, /\$_.ProcessName -eq \$app -or \$_.MainWindowTitle -eq \$app/)
  // Pass 2: top-level UIA window Name — exact (case-insensitive) then substring.
  assert.match(s, /\$n\.ToLower\(\) -eq \$needle/)
  assert.match(s, /\$n\.ToLower\(\)\.Contains\(\$needle\)/)
  assert.match(s, /NativeWindowHandle/, 'UWP path resolves the focus HWND from UIA')
  assert.match(s, /use list_apps for exact names/, 'error guides discovery')
  assert.equal(s.includes('ApplicationFrameHost and have no usable window handle'), false, 'stale UWP disclaimer gone')
})

test('every app-targeted script resolves windows via the unified findApp snippet', () => {
  const target = { path: [0, 1], role: 'Button', title: 'OK' }
  const scripts = [
    buildSnapshotScript('app', 'C:\\f.png', 'C:\\v.png', false),
    buildClickByPathScript('app', target, 'left', 1),
    buildLocateScript('app', target),
    buildSetValueScript('app', target, 'x'),
    buildMenuSelectScript('app', ['File']),
    buildTypeScript('app', 'hi'),
    buildKeyScript('app', parseCombo('cmd+s')),
    buildFocusAppScript('app'),
    buildPasteTextScript('app', 'hi'),
    buildScrollScript('app', { direction: 'down' }),
  ]
  for (const s of scripts) {
    assert.match(s, /\$n\.ToLower\(\) -eq \$needle/, 'UWP title fallback present')
  }
})

test('buildMenuSelectScript embeds the path as JSON and lists alternatives on a miss', () => {
  const s = buildMenuSelectScript('notepad', ['File', "Save 'As'"])
  assert.ok(s.includes(`'["File","Save ''As''"]'`), 'segments JSON survives PS single-quote escaping')
  assert.ok(s.includes('@(ConvertFrom-Json'), 'single-segment paths must not unwrap to a scalar in PS 5.1')
  assert.match(s, /Start-Sleep -Milliseconds 250\s+\$item = \$scope\.FindFirst/, 'popup search retries after a delay')
  assert.match(s, /ExpandCollapsePattern/)
  assert.match(s, /InvokePattern/)
  assert.match(s, /not found; available:/)
})

test('buildPasteTextScript sets clipboard from base64 and sends Ctrl+V', () => {
  const text = "clip 'text' 中文\nline2"
  const s = buildPasteTextScript('notepad', text)
  assert.ok(s.includes(`'${Buffer.from(text, 'utf8').toString('base64')}'`))
  assert.match(s, /Set-Clipboard -Value \$text/)
  assert.match(s, /KeyDown\(\[uint16\]17\)/)
  assert.match(s, /KeyTap\(\[uint16\]86\)/)
  assert.match(s, /KeyUp\(\[uint16\]17\)/)
})

test('buildSetValueScript resolves the path and writes via ValuePattern with fallback guidance', () => {
  const text = "new 'value' 中文"
  const s = buildSetValueScript('notepad', { path: [0, 2], role: 'Edit', title: 'Name' }, text)
  assert.ok(s.includes(`'${Buffer.from(text, 'utf8').toString('base64')}'`), 'text travels as base64')
  assert.match(s, /\$idxPath = @\(0, 2\)/)
  assert.match(s, /\$expectRole = 'Edit'/)
  assert.match(s, /ValuePattern/)
  assert.match(s, /\$vp\.SetValue\(\$text\)/)
  assert.match(s, /type\/paste_text instead/, 'unsupported controls guide the fallback')
  assert.doesNotMatch(s, /\bexit\b/, 'must not kill the resident PS host')
})

test('buildClickByPathScript: left single click has InvokePattern fast path, right/double do not', () => {
  const target = { path: [0, 2], role: 'Button', title: 'OK' }
  const left = buildClickByPathScript('notepad', target, 'left', 1)
  assert.match(left, /InvokePattern/)
  assert.match(left, /\$idxPath = @\(0, 2\)/)
  assert.match(left, /\$expectRole = 'Button'/)
  assert.match(left, /\[RivetInput\]::Click\(\$cx, \$cy, \$false, 1\)/)
  // `exit` would kill the resident PS host — the fast path must use a flag.
  assert.doesNotMatch(left, /\bexit\b/)

  const right = buildClickByPathScript('notepad', target, 'right', 1)
  assert.equal(right.includes('InvokePattern'), false)
  assert.match(right, /\[RivetInput\]::Click\(\$cx, \$cy, \$true, 1\)/)

  const dbl = buildClickByPathScript('notepad', target, 'left', 2)
  assert.equal(dbl.includes('InvokePattern'), false)
  assert.match(dbl, /\[RivetInput\]::Click\(\$cx, \$cy, \$false, 2\)/)
})

test('buildClickAtScript rounds coordinates', () => {
  const s = buildClickAtScript(10.6, 20.4, 'right', 2)
  assert.match(s, /\[RivetInput\]::Click\(11, 20, \$true, 2\)/)
})

test('buildScrollScript: wheel deltas and axis per direction, amount clamped', () => {
  const down = buildScrollScript('notepad', { direction: 'down', amount: 3, at: { x: 5, y: 6 } })
  assert.match(down, /Wheel\(\$ax, \$ay, -360, \$false\)/)
  const up = buildScrollScript('notepad', { direction: 'up', at: { x: 5, y: 6 } })
  assert.match(up, /Wheel\(\$ax, \$ay, 600, \$false\)/, 'default amount 5 lines')
  const rightScroll = buildScrollScript('notepad', { direction: 'right', amount: 999, at: { x: 5, y: 6 } })
  assert.match(rightScroll, /Wheel\(\$ax, \$ay, 6000, \$true\)/, 'clamped to 50 lines, horizontal')
  const noAt = buildScrollScript('notepad', { direction: 'down' })
  assert.match(noAt, /GetWindowRect/, 'falls back to window center')
})

test('buildDragScript uses stepped SendInput drag', () => {
  const s = buildDragScript({ x: 1.4, y: 2.6 }, { x: 100, y: 200 })
  assert.match(s, /Drag\(1, 3, 100, 200, 8\)/)
})

test('buildTypeScript carries text as base64 (quoting/CJK-safe) and maps newline to Enter', () => {
  const text = "line1\nwith 'quotes' 中文"
  const s = buildTypeScript('notepad', text)
  const b64 = Buffer.from(text, 'utf8').toString('base64')
  assert.ok(s.includes(`'${b64}'`))
  assert.match(s, /FromBase64String/)
  assert.match(s, /KeyTap\(\[uint16\]13\)/)
  assert.match(s, /TypeChar/)
})

test('buildKeyScript: modifiers press in order and release in reverse', () => {
  const s = buildKeyScript('notepad', parseCombo('shift+cmd+s'))
  const downShift = s.indexOf('KeyDown([uint16]16)')
  const downCtrl = s.indexOf('KeyDown([uint16]17)')
  const upCtrl = s.indexOf('KeyUp([uint16]17)')
  const upShift = s.lastIndexOf('KeyUp([uint16]16)')
  assert.ok(downShift >= 0 && downCtrl > downShift, 'shift down before ctrl down')
  assert.ok(upCtrl > downCtrl && upShift > upCtrl, 'release order reversed')
  assert.match(s, /\$scan = \[RivetInput\]::VkKeyScan/, 'char key resolves through VkKeyScan')
})

test('buildKeyScript: named key taps the VK directly', () => {
  const s = buildKeyScript('notepad', parseCombo('cmd+return'))
  assert.match(s, /KeyTap\(\[uint16\]13\)/)
  assert.equal(s.includes('$scan = [RivetInput]::VkKeyScan'), false)
})

test('list/focus scripts embed expected shape', () => {
  assert.match(buildListAppsScript(), /GetForegroundWindow/)
  assert.match(buildFocusAppScript('notepad'), /SetForegroundWindow/)
  assert.match(buildLocateScript('notepad', { path: [0] }), /ConvertTo-Json -InputObject @\{ x = \$cx; y = \$cy \}/)
})

test('buildListAppsScript carries window titles and enumerates UWP frame windows', () => {
  const s = buildListAppsScript()
  assert.match(s, /MainWindowTitle/, 'classic apps carry their window title')
  assert.match(s, /\$_.ProcessName -ne 'ApplicationFrameHost'/, 'host process not listed as an app')
  assert.match(s, /Get-Process -Name ApplicationFrameHost/, 'UWP frame windows enumerated')
  assert.match(s, /NativeWindowHandle/, 'UWP frontmost check via frame HWND')
})

// ── driver behavior with an injected runner ───────────────────────

function fakeRunner(outputs: Record<string, string>) {
  const calls: string[] = []
  const run = async (script: string): Promise<string> => {
    calls.push(script)
    for (const [needle, out] of Object.entries(outputs)) {
      if (script.includes(needle)) return out
    }
    return "'ok'"
  }
  return { run, calls }
}

test('listApps parses JSON rows; garbage output degrades to []', async () => {
  const good = createWindowsDriver(async () => JSON.stringify([{ name: 'notepad', title: 'readme - Notepad', frontmost: true }]))
  assert.deepEqual(await good.listApps(), [{ name: 'notepad', title: 'readme - Notepad', frontmost: true }])
  const bad = createWindowsDriver(async () => 'not json')
  assert.deepEqual(await bad.listApps(), [])
})

test('listApps re-wraps a single unwrapped entry (ConvertTo-Json quirk)', async () => {
  const one = createWindowsDriver(async () => JSON.stringify({ name: 'Calculator', title: '', frontmost: false }))
  assert.deepEqual(await one.listApps(), [{ name: 'Calculator', title: '', frontmost: false }])
})

/** Instant sleep so sparse-tree warmup retries don't slow the suite. */
const noSleep = async () => {}

test('snapshot parses rows into tree + refs; no screenshot when shot=false', async () => {
  const rows: WindowsSnapshotRow[] = [
    { ref: 1, depth: 0, role: 'Window', title: 'Notepad', value: '', pos: { x: 1, y: 2 }, path: [0] },
  ]
  const driver = createWindowsDriver(async () => JSON.stringify({ rows, shot: false }), noSleep)
  const snap = await driver.snapshot('notepad')
  assert.match(snap.tree, /\[1\] Window "Notepad" @\(1,2\)/)
  assert.equal(snap.refs.length, 1)
  assert.deepEqual(snap.refs[0]?.path, [0])
  assert.equal(snap.screenshotPng, null)
  assert.equal(snap.visionPng, null)
})

test('snapshot with screenshot:false sends the tree-only script', async () => {
  const scripts: string[] = []
  const driver = createWindowsDriver(async (script) => { scripts.push(script); return JSON.stringify({ rows: [], shot: false }) }, noSleep)
  const snap = await driver.snapshot('notepad', { screenshot: false })
  assert.equal(scripts[0]?.includes('CopyFromScreen'), false)
  assert.equal(snap.screenshotPng, null)
  assert.equal(snap.visionPng, null)
})

test('snapshot warmup: sparse first walk re-walks once and keeps the bigger tree', async () => {
  // Electron UIA trees populate asynchronously after the first walk switches
  // accessibility on — the retry must pick up the grown tree.
  const sparse = [{ ref: 1, depth: 0, role: 'Window', title: 'QQ', value: '', pos: null, path: [0] }]
  const grown = Array.from({ length: 30 }, (_, i) => (
    { ref: i + 1, depth: i === 0 ? 0 : 1, role: i === 0 ? 'Window' : 'Button', title: `el${i}`, value: '', pos: null, path: i === 0 ? [0] : [0, i - 1] }
  ))
  let calls = 0
  const slept: number[] = []
  const driver = createWindowsDriver(
    async () => JSON.stringify({ rows: calls++ === 0 ? sparse : grown, shot: false }),
    async (ms) => { slept.push(ms) },
  )
  const snap = await driver.snapshot('QQ', { screenshot: false })
  assert.equal(calls, 2, 'exactly one re-walk')
  assert.deepEqual(slept, [2500], 'one settle delay before the re-walk')
  assert.equal(snap.refs.length, 30, 'the grown tree wins')
})

test('snapshot warmup: truncated sparse walk does NOT retry (budget already spent)', async () => {
  const rows = [{ ref: 1, depth: 0, role: 'Window', title: 'App', value: '', pos: null, path: [0] }]
  let calls = 0
  const driver = createWindowsDriver(
    async () => { calls++; return JSON.stringify({ rows, shot: false, truncated: true }) },
    noSleep,
  )
  const snap = await driver.snapshot('App', { screenshot: false })
  assert.equal(calls, 1)
  assert.equal(snap.truncated, true)
})

test('snapshot truncated: partial-tree note appended (byte-parity with macOS) and flag set', async () => {
  const rows = [{ ref: 1, depth: 0, role: 'Window', title: 'App', value: '', pos: null, path: [0] }]
  const driver = createWindowsDriver(async () => JSON.stringify({ rows, shot: false, truncated: true }), noSleep)
  const snap = await driver.snapshot('App', { screenshot: false })
  assert.equal(snap.truncated, true)
  assert.match(snap.tree, /\(partial tree: walk budget exhausted — refs above are valid; use find\(query\)\/wait_for for content deeper in the UI\)$/)
})

test('snapshot parses the COM "snap" envelope (rows + truncated nested)', async () => {
  const rows = [{ ref: 1, depth: 0, role: 'Window', title: 'App', value: '', pos: null, path: [0] }]
  const driver = createWindowsDriver(async () => JSON.stringify({ snap: { rows, truncated: true }, shot: false }), noSleep)
  const snap = await driver.snapshot('App', { screenshot: false })
  assert.equal(snap.refs.length, 1)
  assert.equal(snap.truncated, true)
  assert.match(snap.tree, /\[1\] Window "App"/)
})

test('launchApp / menuSelect / pasteText route to their scripts; empty menu path rejected locally', async () => {
  const scripts: string[] = []
  const driver = createWindowsDriver(async (script) => { scripts.push(script); return "'ok'" })
  await driver.launchApp('notepad')
  assert.match(scripts.at(-1) ?? '', /Start-Process/)
  await driver.menuSelect('notepad', ['File', 'Save'])
  assert.match(scripts.at(-1) ?? '', /\["File","Save"\]/)
  await driver.pasteText('notepad', 'hello')
  assert.match(scripts.at(-1) ?? '', /Set-Clipboard/)
  const before = scripts.length
  await assert.rejects(() => driver.menuSelect('notepad', []), /non-empty menu path/)
  assert.equal(scripts.length, before, 'no PowerShell spawn for invalid input')
})

test('snapshot re-wraps a single-object rows field (ConvertTo-Json unwrap quirk)', async () => {
  const row: WindowsSnapshotRow = { ref: 1, depth: 0, role: 'Window', title: 'Notepad', value: '', pos: null, path: [0] }
  const driver = createWindowsDriver(async () => JSON.stringify({ rows: row, shot: false }), noSleep)
  const snap = await driver.snapshot('notepad')
  assert.match(snap.tree, /\[1\] Window "Notepad"/)
  assert.equal(snap.refs.length, 1)
})

test('snapshot degrades to empty tree on unparseable output', async () => {
  const driver = createWindowsDriver(async () => 'PS burped', noSleep)
  const snap = await driver.snapshot('notepad')
  assert.equal(snap.tree, '(no accessible elements found)')
  assert.deepEqual(snap.refs, [])
})

test('locate parses the JSON point; click routes path vs coords to different scripts', async () => {
  const { run, calls } = fakeRunner({ 'ConvertTo-Json -InputObject @{ x = $cx; y = $cy }': '{"x":15,"y":25}' })
  const driver = createWindowsDriver(run)
  const point = await driver.locate('notepad', { path: [0, 1], role: 'Button' })
  assert.deepEqual(point, { x: 15, y: 25 })

  await driver.click('notepad', { path: [0, 1], role: 'Button', title: 'OK' })
  assert.match(calls.at(-1) ?? '', /\$idxPath = @\(0, 1\)/)

  await driver.click('notepad', { x: 3, y: 4 }, { button: 'right', count: 2 })
  const lastCall = calls.at(-1) ?? ''
  assert.match(lastCall, /Click\(3, 4, \$true, 2\)/)
  assert.equal(lastCall.includes('$idxPath'), false)
})

test('key rejects malformed combos before spawning PowerShell', async () => {
  let spawned = 0
  const driver = createWindowsDriver(async () => { spawned++; return "'ok'" })
  await assert.rejects(() => driver.key('notepad', 'hyper+x'), /unknown modifier/)
  assert.equal(spawned, 0)
})

test('checkPermissions: UIA probe result maps to accessibility, screenRecording always true', async () => {
  const ok = createWindowsDriver(async () => '{"accessibility":true}')
  const granted = await ok.checkPermissions()
  assert.equal(granted.accessibility, true)
  assert.equal(granted.screenRecording, true)
  assert.match(granted.detail, /elevated/)

  const broken = createWindowsDriver(async () => { throw new Error('powershell missing') })
  const denied = await broken.checkPermissions()
  assert.equal(denied.accessibility, false)
  assert.equal(denied.screenRecording, true)
  assert.match(denied.detail, /unavailable/)
})
