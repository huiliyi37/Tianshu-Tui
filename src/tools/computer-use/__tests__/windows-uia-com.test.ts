import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  UIA_COM_PRELUDE,
  buildComProbeScript,
  buildComListAppsScript,
  buildComSnapshotScript,
  buildComClickByPathScript,
  buildComLocateScript,
  buildComScrollScript,
  buildComTypeScript,
  buildComSetValueScript,
  buildComKeyScript,
  buildComFocusAppScript,
  buildComLaunchAppScript,
  buildComMenuSelectScript,
  buildComPasteTextScript,
  comEnabled,
  comReady,
  resetComStateForTests,
} from '../windows-uia-com.js'
import {
  createWindowsDriver,
  buildPsReplBootstrap,
  parseCombo,
} from '../windows-driver.js'

const savedEnv = process.env.RIVET_CU_COM

beforeEach(() => {
  delete process.env.RIVET_CU_COM
  resetComStateForTests()
})

afterEach(() => {
  if (savedEnv === undefined) delete process.env.RIVET_CU_COM
  else process.env.RIVET_CU_COM = savedEnv
  resetComStateForTests()
})

// ── prelude lockdown: ComImport declarations ──────────────────────
// The vtable transcription can only be fully verified on a real Windows
// machine — these tests lock the parts that MUST NOT drift: interface GUIDs
// (from the Win7 SDK UIAutomationClient.h), the CLSID 8→7 fallback, the
// Add-Type re-entry guard and the ControlType→role mapping.

test('COM prelude declares the SDK interface GUIDs verbatim', () => {
  // MIDL_INTERFACE(...) values from UIAutomationClient.h.
  const guids: Array<[string, string]> = [
    ['IUIAutomation', '30cbe57d-d9d0-452a-ab13-7ac5ac4825ee'],
    ['IUIAutomationElement', 'd22108aa-8ac5-49a5-837b-37bbb3d7591e'],
    ['IUIAutomationElementArray', '14314595-b4bc-4055-95f2-58f2e42c9855'],
    ['IUIAutomationCondition', '352ffba8-0973-437c-a61f-f64cafd81df9'],
    ['IUIAutomationCacheRequest', 'b32a92b5-bc25-4078-9c08-d7ee95c48e03'],
    ['IUIAutomationInvokePattern', 'fb377fbe-8ea6-46d5-9c73-6499642d3059'],
    ['IUIAutomationValuePattern', 'a94cd8b1-0844-4cd6-9d2d-640537ab39e9'],
    ['IUIAutomationExpandCollapsePattern', '619be086-1f4e-4ee4-bafa-210128738730'],
  ]
  for (const [name, guid] of guids) {
    assert.match(
      UIA_COM_PRELUDE,
      new RegExp(`Guid\\("${guid}"\\)[^\\]]*\\]\\npublic interface ${name}\\b`),
      `${name} must carry GUID ${guid}`,
    )
  }
})

test('COM prelude: CUIAutomation8 CLSID with CUIAutomation (Win7) fallback', () => {
  assert.ok(UIA_COM_PRELUDE.includes('e22ad333-b25f-460c-83d0-0581107395c9'), 'CUIAutomation8 CLSID')
  assert.ok(UIA_COM_PRELUDE.includes('ff48dba4-60ef-4201-aa87-54103eef594e'), 'CUIAutomation CLSID')
  // The 8 CLSID must be the try branch, the 7 CLSID the catch branch.
  const idx8 = UIA_COM_PRELUDE.indexOf('e22ad333')
  const idx7 = UIA_COM_PRELUDE.indexOf('ff48dba4')
  assert.ok(idx8 < idx7, 'CUIAutomation8 attempted before the Win7 fallback')
})

test('COM prelude is guarded against Add-Type re-entry', () => {
  assert.ok(UIA_COM_PRELUDE.includes(`if (-not ('RivetUia' -as [type]))`))
})

test('COM prelude: ControlType ids map to managed ProgrammaticName suffixes', () => {
  // Spot-check both ends and the middle of the 50000..50040 table.
  for (const [id, role] of [
    [50000, 'Button'],
    [50004, 'Edit'],
    [50011, 'MenuItem'],
    [50020, 'Text'],
    [50030, 'Document'],
    [50032, 'Window'],
    [50033, 'Pane'],
    [50040, 'AppBar'],
  ] as Array<[number, string]>) {
    assert.ok(UIA_COM_PRELUDE.includes(`case ${id}: return "${role}";`), `${id} → ${role}`)
  }
})

test('COM prelude: manual JSON escaping helper, no ConvertTo-Json in C# output paths', () => {
  // The J() helper handles quotes, backslashes and control chars.
  assert.ok(UIA_COM_PRELUDE.includes('static string J(string s)'))
  assert.ok(UIA_COM_PRELUDE.includes(`sb.Append("\\\\u").Append(((int)c).ToString("x4"))`))
  // The snapshot path must batch per parent via FindAllBuildCache.
  assert.ok(UIA_COM_PRELUDE.includes('FindAllBuildCache(TS_Children, _ctrlView, st.cr)'))
})

test('COM prelude keeps the SKIP_VALUE / NO_DESCEND pruning lists', () => {
  for (const role of ['Window', 'Pane', 'Group', 'ToolBar', 'MenuBar']) {
    assert.ok(UIA_COM_PRELUDE.includes(`{ "${role}", true }`), `SKIP_VALUE has ${role}`)
  }
  assert.match(UIA_COM_PRELUDE, /NoDescend = new Dictionary<string, bool> \{\s*\{ "ScrollBar", true \}, \{ "TitleBar", true \}/)
})

// ── stale/error message parity with the managed path ──────────────
// tool.ts self-healing keys off "stale snapshot" and the fuzzy app hint off
// "no running app named" — the COM layer must render them identically.

test('COM stale messages are byte-identical to the managed resolveByPath', () => {
  for (const msg of [
    'stale snapshot - window index out of range, re-snapshot first',
    'stale snapshot - element path no longer valid, re-snapshot first',
    'stale snapshot - element title changed, re-snapshot first',
  ]) {
    assert.ok(UIA_COM_PRELUDE.includes(`"${msg}"`), msg)
  }
  // The role-changed message interpolates identically: "(actual != expected)".
  assert.ok(
    UIA_COM_PRELUDE.includes(
      `"stale snapshot - element role changed (" + role + " != " + expectRole + "), re-snapshot first"`,
    ),
  )
})

test('COM set_value / app-not-found guidance matches the managed wording', () => {
  assert.ok(
    UIA_COM_PRELUDE.includes('element does not accept direct value writes - click it and use type/paste_text instead'),
  )
  assert.ok(
    UIA_COM_PRELUDE.includes(`"no running app named '" + Norm(app) + "' with a window (use list_apps for exact names)"`),
  )
})

test('COM builders rethrow the base exception so PS wrapping never leaks', () => {
  // MethodInvocationException would prefix 'Exception calling "X" ...' onto
  // stale messages and break tool.ts matching — every RivetUia call is
  // wrapped to rethrow the inner exception.
  for (const script of [
    buildComLocateScript('notepad', { path: [0, 1], role: 'Edit' }),
    buildComSetValueScript('notepad', { path: [0, 1] }, 'x'),
    buildComSnapshotScript('notepad', 'f.png', 'v.png'),
    buildComMenuSelectScript('notepad', ['File']),
  ]) {
    assert.ok(script.includes('throw $_.Exception.GetBaseException()'), 'comTry wrapper present')
  }
})

// ── builder content ───────────────────────────────────────────────

test('probe script compiles the prelude and touches the UIA root', () => {
  const s = buildComProbeScript()
  assert.ok(s.includes(UIA_COM_PRELUDE))
  assert.ok(s.includes('[RivetUia]::Probe()'))
})

test('COM snapshot script routes tree work to C# and keeps the managed screenshot section', () => {
  const s = buildComSnapshotScript('notepad', 'C:\\t\\full.png', 'C:\\t\\vision.png', true, 400, 20_000)
  assert.ok(s.includes(`[RivetUia]::SnapshotJson('notepad', 400, 20000)`))
  assert.ok(s.includes('CopyFromScreen'), 'screenshot stays in PS (System.Drawing)')
  assert.ok(s.includes(`'C:\\t\\full.png'`))
  assert.ok(s.includes('"snap":'), 'envelope JSON assembled by string concat')
  assert.ok(!s.includes('ConvertTo-Json'), 'no ConvertTo-Json in the COM snapshot path')
  const noShot = buildComSnapshotScript('notepad', 'f.png', 'v.png', false)
  assert.ok(!noShot.includes('CopyFromScreen'))
})

test('COM walk carries an in-script deadline and returns truncated in the snap envelope', () => {
  // The C# walk must self-terminate at its budget (partial rows beat an
  // outer-timeout kill that returns nothing) and report that it did.
  assert.ok(UIA_COM_PRELUDE.includes('DateTime.UtcNow > st.deadline'), 'Visit checks the deadline')
  assert.ok(UIA_COM_PRELUDE.includes('st.deadline = DateTime.UtcNow.AddMilliseconds(budgetMs)'))
  assert.ok(UIA_COM_PRELUDE.includes(`,\\"truncated\\":`), 'truncated flag serialized with the rows')
})

test('COM click: left single passes invoke flag, right/double disable it', () => {
  const left = buildComClickByPathScript('notepad', { path: [0, 2], role: 'Button', title: 'OK' }, 'left', 1)
  assert.ok(left.includes(`[RivetUia]::ClickTargetJson('notepad', '0,2', 'Button', 'OK', $true)`))
  assert.ok(left.includes('[RivetInput]::Click([int]$info.x, [int]$info.y, $false, 1)'))
  const right = buildComClickByPathScript('notepad', { path: [0, 2] }, 'right', 1)
  assert.ok(right.includes(`$false)`) && right.includes(`'0,2'`))
  assert.ok(right.includes('[RivetInput]::Click([int]$info.x, [int]$info.y, $true, 1)'))
  const dbl = buildComClickByPathScript('notepad', { path: [0, 2] }, 'left', 2)
  assert.ok(dbl.includes(`, $false)`), 'double click skips InvokePattern')
})

test('COM set_value ships text as base64', () => {
  const s = buildComSetValueScript('notepad', { path: [0, 1], role: 'Edit' }, '你好 "world"')
  const b64 = Buffer.from('你好 "world"', 'utf8').toString('base64')
  assert.ok(s.includes(b64))
  assert.ok(s.includes(`[RivetUia]::SetValue('notepad', '0,1', 'Edit', '', $text)`))
})

test('COM menu_select ships segments base64-newline-joined and clicks non-invokable finals', () => {
  const s = buildComMenuSelectScript('notepad', ['File', 'Save As…'])
  const b64 = Buffer.from('File\nSave As…', 'utf8').toString('base64')
  assert.ok(s.includes(b64))
  assert.ok(s.includes('[RivetUia]::MenuSelectJson($app, $segs)'))
  assert.ok(s.includes('if (-not $res.done)'))
})

test('COM input builders resolve the app HWND through C# and reuse the shared input bodies', () => {
  const type = buildComTypeScript('notepad', 'hi')
  assert.ok(type.includes('[RivetUia]::ResolveHwnd($app)'))
  assert.ok(type.includes('[RivetInput]::TypeChar($ch)'))
  const key = buildComKeyScript('notepad', parseCombo('cmd+s'))
  assert.ok(key.includes('[RivetUia]::ResolveHwnd($app)'))
  assert.ok(key.includes('[RivetInput]::KeyDown([uint16]17)'))
  const paste = buildComPasteTextScript('notepad', 'clip')
  assert.ok(paste.includes('Set-Clipboard'))
  const focus = buildComFocusAppScript('notepad')
  assert.ok(focus.includes('SetForegroundWindow') || focus.includes('$fh'))
  const launch = buildComLaunchAppScript('notepad')
  assert.ok(launch.includes('Start-Process -FilePath $app'))
  assert.ok(launch.includes('did not show a window within 10s'))
})

test('COM scroll: explicit point skips UIA, window-center goes through ResolveHwnd', () => {
  const at = buildComScrollScript('notepad', { direction: 'down', amount: 3, at: { x: 10, y: 20 } })
  assert.ok(!at.includes('RivetUia'), 'point scroll needs no UIA at all')
  assert.ok(at.includes('[RivetInput]::Wheel($ax, $ay, -360, $false)'))
  const center = buildComScrollScript('notepad', { direction: 'up', amount: 2 })
  assert.ok(center.includes('[RivetUia]::ResolveHwnd($app)'))
  assert.ok(center.includes('GetWindowRect'))
})

test('COM list_apps emits C#-serialized JSON', () => {
  const s = buildComListAppsScript()
  assert.ok(s.includes('[RivetUia]::ListAppsJson()'))
  assert.ok(!s.includes('ConvertTo-Json'))
})

// ── probe + routing ───────────────────────────────────────────────

test('RIVET_CU_COM=0 short-circuits: no probe script ever runs', async () => {
  process.env.RIVET_CU_COM = '0'
  assert.equal(comEnabled(), false)
  let calls = 0
  const ready = await comReady(async () => { calls++; return 'com-ok:' })
  assert.equal(ready, false)
  assert.equal(calls, 0)
})

test('comReady probes once per session and caches the verdict', async () => {
  let calls = 0
  const run = async () => { calls++; return 'com-ok:Desktop' }
  assert.equal(await comReady(run), true)
  assert.equal(await comReady(run), true)
  assert.equal(calls, 1, 'probe cached after first success')
})

test('probe failure marks COM broken for the whole session', async () => {
  let calls = 0
  const run = async () => { calls++; throw new Error('Add-Type : compile error') }
  assert.equal(await comReady(run), false)
  assert.equal(await comReady(run), false)
  assert.equal(calls, 1, 'no re-probe after failure')
})

/** Instant sleep so sparse-tree warmup retries don't slow the suite. */
const noSleep = async () => {}

/** Enough rows to stay above the sparse-tree warmup threshold (single walk). */
function denseRows(): string {
  const rows = Array.from({ length: 30 }, (_, i) => (
    { ref: i + 1, depth: i === 0 ? 0 : 1, role: i === 0 ? 'Window' : 'Button', title: `el${i}`, value: '', pos: null, path: i === 0 ? [0] : [0, i - 1] }
  ))
  return JSON.stringify(rows)
}

test('driver routes through COM builders when the probe passes', async () => {
  const scripts: string[] = []
  const run = async (script: string) => {
    scripts.push(script)
    if (script.includes('[RivetUia]::Probe()')) return 'com-ok:Desktop'
    return '{"rows":[],"shot":false}'
  }
  const driver = createWindowsDriver(run, noSleep)
  await driver.snapshot('notepad', { screenshot: false })
  const action = scripts[scripts.length - 1]!
  assert.ok(action.includes('[RivetUia]::SnapshotJson'), 'COM snapshot builder used')
  assert.ok(!action.includes('System.Windows.Automation.CacheRequest'), 'managed walker not used')
})

test('driver falls back to managed builders when the probe fails', async () => {
  const scripts: string[] = []
  const run = async (script: string) => {
    scripts.push(script)
    if (script.includes('[RivetUia]::Probe()')) throw new Error('CLSID not registered')
    return JSON.stringify({ rows: [], shot: false })
  }
  const driver = createWindowsDriver(run, noSleep)
  await driver.snapshot('notepad', { screenshot: false })
  const action = scripts[scripts.length - 1]!
  assert.ok(action.includes('System.Windows.Automation'), 'managed snapshot builder used')
  assert.ok(!action.includes('[RivetUia]::SnapshotJson'))
})

test('driver with RIVET_CU_COM=0 never emits a probe or COM script', async () => {
  process.env.RIVET_CU_COM = '0'
  const scripts: string[] = []
  const run = async (script: string) => {
    scripts.push(script)
    // Dense tree: no warmup re-walk, so exactly one script proves no probe ran.
    return `{"rows":${denseRows()},"shot":false}`
  }
  const driver = createWindowsDriver(run, noSleep)
  await driver.snapshot('notepad', { screenshot: false })
  assert.equal(scripts.length, 1)
  assert.ok(!scripts[0]!.includes('RivetUia'))
})

test('COM snapshot rows parse through the same driver pipeline (no unwrap quirk)', async () => {
  const rows = [
    { ref: 1, depth: 0, role: 'Window', title: 'readme - Notepad', value: '', pos: { x: 0, y: 0 }, path: [0] },
  ]
  const run = async (script: string) => {
    if (script.includes('[RivetUia]::Probe()')) return 'com-ok:'
    return `{"snap":{"rows":${JSON.stringify(rows)},"truncated":false},"shot":false}`
  }
  const driver = createWindowsDriver(run, noSleep)
  const snap = await driver.snapshot('notepad', { screenshot: false })
  assert.ok(snap.tree.includes('[1] Window "readme - Notepad"'))
  assert.equal(snap.refs.length, 1)
  assert.deepEqual(snap.refs[0]!.path, [0])
})

// ── host preload ──────────────────────────────────────────────────

test('resident PS host bootstrap preloads the COM prelude (isolated try)', () => {
  const bootstrap = buildPsReplBootstrap()
  assert.ok(bootstrap.includes(UIA_COM_PRELUDE), 'COM Add-Type JIT paid once at host start')
  // A COM prelude failure must not take down the managed preludes: they are
  // wrapped in SEPARATE try/catch blocks.
  const comIdx = bootstrap.indexOf(`'RivetUia' -as [type]`)
  const managedIdx = bootstrap.indexOf(`'RivetInput' -as [type]`)
  assert.ok(managedIdx >= 0 && comIdx > managedIdx)
  const between = bootstrap.slice(managedIdx, comIdx)
  assert.ok(between.includes('} catch {}'), 'managed and COM preludes fail independently')
})
