import { test } from 'node:test'
import assert from 'node:assert/strict'
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
  assert.ok(s.includes(`'C:\\tmp\\full.png'`))
  assert.ok(s.includes(`'C:\\tmp\\vision.png'`))
  assert.match(s, /ControlViewWalker/)
  assert.match(s, /CopyFromScreen/)
  assert.match(s, /1440/)
})

test('buildClickByPathScript: left single click has InvokePattern fast path, right/double do not', () => {
  const target = { path: [0, 2], role: 'Button', title: 'OK' }
  const left = buildClickByPathScript('notepad', target, 'left', 1)
  assert.match(left, /InvokePattern/)
  assert.match(left, /\$idxPath = @\(0, 2\)/)
  assert.match(left, /\$expectRole = 'Button'/)
  assert.match(left, /\[RivetInput\]::Click\(\$cx, \$cy, \$false, 1\)/)

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
  const good = createWindowsDriver(async () => JSON.stringify([{ name: 'notepad', frontmost: true }]))
  assert.deepEqual(await good.listApps(), [{ name: 'notepad', frontmost: true }])
  const bad = createWindowsDriver(async () => 'not json')
  assert.deepEqual(await bad.listApps(), [])
})

test('snapshot parses rows into tree + refs; no screenshot when shot=false', async () => {
  const rows: WindowsSnapshotRow[] = [
    { ref: 1, depth: 0, role: 'Window', title: 'Notepad', value: '', pos: { x: 1, y: 2 }, path: [0] },
  ]
  const driver = createWindowsDriver(async () => JSON.stringify({ rows, shot: false }))
  const snap = await driver.snapshot('notepad')
  assert.match(snap.tree, /\[1\] Window "Notepad" @\(1,2\)/)
  assert.equal(snap.refs.length, 1)
  assert.deepEqual(snap.refs[0]?.path, [0])
  assert.equal(snap.screenshotPng, null)
  assert.equal(snap.visionPng, null)
})

test('snapshot degrades to empty tree on unparseable output', async () => {
  const driver = createWindowsDriver(async () => 'PS burped')
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
