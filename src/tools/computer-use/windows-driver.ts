/**
 * Windows Computer Use driver — GUI automation via PowerShell + UI Automation.
 *
 * Zero new dependencies: everything goes through the OS-bundled
 * `powershell.exe` (5.1). The accessibility tree comes from the .NET
 * `System.Windows.Automation` (UIA) assemblies, input synthesis from
 * `SendInput` via an `Add-Type` P/Invoke shim (SendKeys is deliberately
 * avoided — its `{}^%+~` metacharacters corrupt arbitrary text and CJK is
 * unreliable), and screenshots from `System.Drawing.Graphics.CopyFromScreen`
 * (including the 1440px vision downsample — Windows has no `sips`, so the
 * resize happens inside the same script).
 *
 * Scripts are passed as `-EncodedCommand` (base64 UTF-16LE) which sidesteps
 * every quoting/escaping pitfall, and each script is wrapped to emit UTF-8
 * stdout (redirected PS 5.1 otherwise uses the OEM codepage and mangles CJK
 * window titles) and surface errors on stderr with exit 1.
 *
 * Element targeting mirrors the macOS driver exactly: each snapshot ref
 * carries its child-index PATH from the app's top-level UIA windows
 * ([windowIdx, childIdx, ...], control view). Click/locate re-walk the
 * path and verify role/title — stale snapshots are rejected, never guessed.
 * The snapshot walk itself is CacheRequest-batched (one FindAll per parent
 * with all properties prefetched); app resolution falls back from process
 * matching to UIA window-title matching so frame-hosted UWP apps work.
 *
 * Actions run inside a resident PowerShell REPL (script-host.ts) so the
 * Add-Type JIT (~1-3s) is paid once per session; one-shot powershell.exe
 * spawns remain as the fallback when the host cannot start.
 *
 * UIA path selection: when the native IUIAutomation COM layer probes healthy
 * (windows-uia-com.ts — unlocks the full Chromium accessibility tree and
 * moves the tree walk into C#), every UIA-touching action routes through the
 * COM builders. Probe failure or RIVET_CU_COM=0 keeps the managed
 * System.Windows.Automation builders below as the drop-in safety net.
 */

import { execFile } from 'node:child_process'
import { createScriptHost, hostEnabled, HostUnavailableError, SENTINEL, type ScriptHost } from './script-host.js'
import {
  UIA_COM_PRELUDE,
  comReady,
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
} from './windows-uia-com.js'
import { readFile, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type {
  AppInfo,
  ClickOptions,
  ClickTarget,
  ComputerUseDriver,
  PermissionStatus,
  ScrollOptions,
  SnapshotOptions,
  SnapshotRef,
  SnapshotResult,
} from './macos-driver.js'

const POWERSHELL_TIMEOUT_MS = 20_000
/** Bound the UIA walk so a deep app tree can't blow up the result. */
const MAX_TREE_NODES = 400
/**
 * In-script wall-clock budget for the tree walk (mirrors the macOS driver).
 * The UIA walk is CacheRequest-batched and normally finishes in seconds, but
 * a pathological Chromium/Electron tree can still outrun the outer 30s
 * PowerShell timeout — which returns NOTHING. The walk self-terminates at
 * the deadline and returns the partial rows with truncated=true instead.
 */
const WALK_BUDGET_MS = 20_000
/**
 * Chromium/Electron apps build their UIA tree lazily: the first WM_GETOBJECT
 * (triggered by our first walk) switches accessibility on, and the renderer
 * populates the tree ASYNCHRONOUSLY afterwards — so the first snapshot can
 * see a skeleton. A tiny non-truncated first walk triggers one delayed
 * re-walk (same policy and thresholds as the macOS driver).
 */
const SPARSE_TREE_RETRY_THRESHOLD = 25
/** Settle delay before the sparse-tree re-walk (ms). */
const SPARSE_TREE_RETRY_DELAY_MS = 2_500
/** Model-facing note appended to a truncated tree — byte-identical to the
 *  macOS driver so the prompt experience matches across platforms. */
const PARTIAL_TREE_NOTE = '\n(partial tree: walk budget exhausted — refs above are valid; use find(query)/wait_for for content deeper in the UI)'
/** Max dimension for the vision-model screenshot copy (px). */
const VISION_MAX_DIMENSION = 1440

/** Injectable script executor — tests swap in a fake to lock script contents. */
export type PowerShellRunner = (script: string, timeoutMs?: number) => Promise<string>

function runPowerShellOneShot(script: string, timeoutMs = POWERSHELL_TIMEOUT_MS): Promise<string> {
  const wrapped = [
    `$ErrorActionPreference = 'Stop'`,
    `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8`,
    `try {`,
    script,
    `} catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }`,
  ].join('\n')
  const encoded = Buffer.from(wrapped, 'utf16le').toString('base64')
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
      { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        if (err) {
          reject(new Error(stderr?.toString().trim() || err.message))
          return
        }
        resolve(stdout.toString())
      },
    )
  })
}

/**
 * Resident PowerShell REPL: reads the script-host line protocol from stdin,
 * decodes each base64 request, Invoke-Expressions it and replies with the
 * captured pipeline output. The preludes (Add-Type C# JIT ~1-3s, UIA
 * assemblies) are paid ONCE at bootstrap instead of per action — that JIT is
 * the dominant per-call cost of the one-shot path. Per-request scripts still
 * embed the preludes for the one-shot fallback; the `if (-not ('RivetInput'
 * -as [type]))` guard makes them no-ops here.
 */
export function buildPsReplBootstrap(): string {
  return `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
try {
${INPUT_PRELUDE}
${UIA_PRELUDE}
} catch {}
try {
${UIA_COM_PRELUDE}
} catch {}
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  if ($line.Trim() -eq '') { continue }
  $req = $null
  try { $req = ConvertFrom-Json $line } catch { continue }
  $reply = $null
  try {
    $code = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($req.b64))
    $out = Invoke-Expression $code | Out-String -Width 1000000
    $reply = @{ id = $req.id; ok = $true; out = $out.TrimEnd() }
  } catch {
    $reply = @{ id = $req.id; ok = $false; err = $_.Exception.Message }
  }
  [Console]::Out.WriteLine('${SENTINEL}' + (ConvertTo-Json -InputObject $reply -Compress))
}
`
}

let sharedPsHost: ScriptHost | null = null

function getPsHost(): ScriptHost | null {
  if (!hostEnabled()) return null
  if (!sharedPsHost) {
    const encoded = Buffer.from(buildPsReplBootstrap(), 'utf16le').toString('base64')
    sharedPsHost = createScriptHost({
      command: 'powershell.exe',
      args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
    })
  }
  return sharedPsHost
}

/** Test hook: drop the shared host so the next call respawns it. */
export function resetPsHostForTests(): void {
  sharedPsHost?.dispose()
  sharedPsHost = null
}

async function runPowerShellDefault(script: string, timeoutMs = POWERSHELL_TIMEOUT_MS): Promise<string> {
  const host = getPsHost()
  if (host && host.available()) {
    try {
      return await host.run(script, timeoutMs)
    } catch (err) {
      // Fall back only when the host never ran the script (spawn failure /
      // disabled). A timeout or mid-run crash may have partially executed a
      // mutating action — re-running via execFile would double-fire input.
      if (!(err instanceof HostUnavailableError)) throw err
    }
  }
  return runPowerShellOneShot(script, timeoutMs)
}

/** Escape a string for safe embedding as a single-quoted PowerShell literal. */
export function psString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

/** Model-facing app names may carry an .exe suffix; process names don't. */
export function normalizeAppName(app: string): string {
  return app.replace(/\.exe$/i, '').trim()
}

/**
 * P/Invoke shim: SendInput mouse/keyboard synthesis, cursor positioning,
 * foreground-window control and window rects. Also flips the (non-DPI-aware
 * by default) PowerShell process to DPI-aware so every coordinate that flows
 * through here — UIA rects, SetCursorPos, CopyFromScreen — is in the same
 * physical-pixel space.
 */
export const INPUT_PRELUDE = `
if (-not ('RivetInput' -as [type])) {
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class RivetInput {
  [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx, dy; public uint mouseData, dwFlags, time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort wVk, wScan; public uint dwFlags, time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Explicit)] public struct INPUTUNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
  [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public INPUTUNION u; }
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll", SetLastError = true)] static extern uint SendInput(uint n, INPUT[] inputs, int size);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern short VkKeyScan(char c);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  const uint TYPE_MOUSE = 0, TYPE_KEYBOARD = 1;
  const uint LEFTDOWN = 0x2, LEFTUP = 0x4, RIGHTDOWN = 0x8, RIGHTUP = 0x10, WHEEL = 0x800, HWHEEL = 0x1000;
  const uint KEYUP = 0x2, UNICODE = 0x4;
  static void Send(INPUT i) { SendInput(1, new INPUT[] { i }, Marshal.SizeOf(typeof(INPUT))); }
  static INPUT Mouse(uint flags, uint data) { var i = new INPUT { type = TYPE_MOUSE }; i.u.mi = new MOUSEINPUT { dwFlags = flags, mouseData = data }; return i; }
  static INPUT Key(ushort vk, ushort scan, uint flags) { var i = new INPUT { type = TYPE_KEYBOARD }; i.u.ki = new KEYBDINPUT { wVk = vk, wScan = scan, dwFlags = flags }; return i; }
  public static void Click(int x, int y, bool right, int count) {
    SetCursorPos(x, y);
    System.Threading.Thread.Sleep(30);
    for (int k = 0; k < count; k++) {
      Send(Mouse(right ? RIGHTDOWN : LEFTDOWN, 0));
      Send(Mouse(right ? RIGHTUP : LEFTUP, 0));
      if (count > 1) System.Threading.Thread.Sleep(40);
    }
  }
  public static void Wheel(int x, int y, int delta, bool horizontal) {
    SetCursorPos(x, y);
    System.Threading.Thread.Sleep(20);
    Send(Mouse(horizontal ? HWHEEL : WHEEL, unchecked((uint)delta)));
  }
  public static void Drag(int fx, int fy, int tx, int ty, int steps) {
    SetCursorPos(fx, fy);
    System.Threading.Thread.Sleep(50);
    Send(Mouse(LEFTDOWN, 0));
    for (int i = 1; i <= steps; i++) {
      SetCursorPos(fx + (tx - fx) * i / steps, fy + (ty - fy) * i / steps);
      System.Threading.Thread.Sleep(20);
    }
    System.Threading.Thread.Sleep(50);
    Send(Mouse(LEFTUP, 0));
  }
  public static void KeyDown(ushort vk) { Send(Key(vk, 0, 0)); }
  public static void KeyUp(ushort vk) { Send(Key(vk, 0, KEYUP)); }
  public static void KeyTap(ushort vk) { KeyDown(vk); KeyUp(vk); }
  public static void TypeChar(char c) { Send(Key(0, c, UNICODE)); Send(Key(0, c, UNICODE | KEYUP)); }
}
'@
}
[void][RivetInput]::SetProcessDPIAware()
`

const UIA_PRELUDE = `
Add-Type -AssemblyName UIAutomationClient | Out-Null
Add-Type -AssemblyName UIAutomationTypes | Out-Null
`

/**
 * Non-throwing app matcher. Sets `$wins` (top-level UIA windows, stable
 * enumeration order) and `$fh` (HWND for focus). Two passes:
 * 1. classic Win32: process name / exact main-window-title match → windows
 *    filtered by PID (the pre-existing path)
 * 2. UWP fallback: top-level UIA window Name match, case-insensitive exact
 *    first then substring — covers apps hosted by ApplicationFrameHost
 *    (Calculator, Settings, ...) whose own process has no window handle.
 */
function findApp(app: string): string {
  return `
$app = ${psString(normalizeAppName(app))}
$uiaRoot = [System.Windows.Automation.AutomationElement]::RootElement
$uiaAll = $uiaRoot.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)
$wins = @()
$fh = [IntPtr]::Zero
$procs = @(Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and ($_.ProcessName -eq $app -or $_.MainWindowTitle -eq $app) })
if ($procs.Count -gt 0) {
  $procIds = @($procs | ForEach-Object { $_.Id })
  foreach ($w in $uiaAll) { if ($procIds -contains $w.Current.ProcessId) { $wins += $w } }
  $fh = [IntPtr]$procs[0].MainWindowHandle
}
if ($wins.Count -eq 0) {
  $needle = $app.ToLower()
  $exact = @(); $sub = @()
  foreach ($w in $uiaAll) {
    $n = [string]$w.Current.Name
    if (-not $n) { continue }
    if ($n.ToLower() -eq $needle) { $exact += $w } elseif ($n.ToLower().Contains($needle)) { $sub += $w }
  }
  $wins = @(if ($exact.Count -gt 0) { $exact } else { $sub })
  if ($wins.Count -gt 0) { try { $fh = [IntPtr]$wins[0].Current.NativeWindowHandle } catch {} }
}
`
}

/** Throwing variant — every action script that needs a target app uses this. */
function resolveApp(app: string): string {
  return `
${findApp(app)}
if ($wins.Count -eq 0) { throw "no running app named '$app' with a window (use list_apps for exact names)" }
`
}

/**
 * Resolve an element by child-index path with identity check — semantics
 * identical to the macOS RESOLVE_BY_PATH snippet: out-of-range or changed
 * role/title throws a stale-snapshot error.
 */
function resolveByPath(target: { path: number[]; role?: string; title?: string }): string {
  return `
$idxPath = @(${target.path.join(', ')})
$expectRole = ${psString(target.role ?? '')}
$expectTitle = ${psString(target.title ?? '')}
if ($idxPath.Count -eq 0 -or $idxPath[0] -ge $wins.Count) { throw 'stale snapshot - window index out of range, re-snapshot first' }
$el = $wins[$idxPath[0]]
$walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
for ($i = 1; $i -lt $idxPath.Count; $i++) {
  $child = $walker.GetFirstChild($el)
  $j = 0
  while ($child -ne $null -and $j -lt $idxPath[$i]) { $child = $walker.GetNextSibling($child); $j++ }
  if ($child -eq $null) { throw 'stale snapshot - element path no longer valid, re-snapshot first' }
  $el = $child
}
$role = ''; $title = ''
try { $role = $el.Current.ControlType.ProgrammaticName -replace '^ControlType\\.', '' } catch {}
try { $title = $el.Current.Name } catch {}
if ($expectRole -and $role -ne $expectRole) { throw "stale snapshot - element role changed ($role != $expectRole), re-snapshot first" }
if ($expectTitle -and $title -ne $expectTitle) { throw 'stale snapshot - element title changed, re-snapshot first' }
$found = $el
`
}

/** Center point of the resolved element's bounding rectangle. */
const ELEMENT_CENTER = `
$rect = $found.Current.BoundingRectangle
if ($rect.IsEmpty -or $rect.Width -le 0 -or $rect.Height -le 0) { throw 'element has no on-screen position' }
$cx = [int][math]::Round($rect.X + $rect.Width / 2)
$cy = [int][math]::Round($rect.Y + $rect.Height / 2)
`

/** Bring the resolved app's window (findApp's $fh) to the foreground. */
export const FOCUS_WINDOW = `
if ($fh -ne [IntPtr]::Zero) {
  if ([RivetInput]::IsIconic($fh)) { [void][RivetInput]::ShowWindow($fh, 9) }
  [void][RivetInput]::SetForegroundWindow($fh)
}
`

/** One row of the UIA snapshot walk, as emitted (JSON) by the PS script. */
export interface WindowsSnapshotRow {
  ref: number
  depth: number
  role: string
  title: string
  value: string
  pos: { x: number; y: number } | null
  path: number[]
}

/**
 * Format snapshot rows into the numbered tree + structured refs. Output format
 * is byte-identical to the macOS driver ([ref] role "title" = value @(x,y))
 * so the model-facing prompt experience is the same on both platforms.
 */
export function rowsToSnapshot(rows: WindowsSnapshotRow[]): { tree: string; refs: SnapshotRef[] } {
  const body = rows
    .map((r) => {
      const indent = '  '.repeat(Math.min(r.depth, 8))
      const label = r.title ? ` "${r.title}"` : ''
      const val = r.value ? ` = ${r.value}` : ''
      const at = r.pos ? ` @(${Math.round(r.pos.x)},${Math.round(r.pos.y)})` : ''
      return `${indent}[${r.ref}] ${r.role || 'element'}${label}${val}${at}`
    })
    .join('\n')
  // Menu bar parity with macOS: surface the first MenuBar's direct children
  // as a "Menu bar: A | B | ..." header so menu_select paths are discoverable.
  let menuLine = ''
  const barIdx = rows.findIndex((r) => r.role === 'MenuBar')
  const bar = barIdx >= 0 ? rows[barIdx] : undefined
  if (bar) {
    const items: string[] = []
    for (let j = barIdx + 1; j < rows.length; j++) {
      const r = rows[j]
      if (!r || r.depth <= bar.depth) break
      if (r.depth === bar.depth + 1 && r.title) items.push(r.title)
    }
    if (items.length > 0) menuLine = `Menu bar: ${items.join(' | ')}\n`
  }
  const tree = `${menuLine}${body}`
  const refs: SnapshotRef[] = rows.map((r) => ({
    ref: r.ref,
    path: Array.isArray(r.path) ? r.path : [r.path as unknown as number],
    role: r.role,
    title: r.title,
    pos: r.pos,
  }))
  return { tree, refs }
}

// --- key combo parsing (pure, unit-tested) ---

/** Virtual-key codes for named keys. `delete` maps to Backspace (VK 0x08) to
 *  preserve macOS semantics, where key code 51 is the delete/backspace key. */
const NAMED_VK: Record<string, number> = {
  return: 0x0d, enter: 0x0d, tab: 0x09, space: 0x20,
  delete: 0x08, backspace: 0x08, escape: 0x1b, esc: 0x1b,
  left: 0x25, up: 0x26, right: 0x27, down: 0x28,
  home: 0x24, end: 0x23, pageup: 0x21, pagedown: 0x22,
  f1: 0x70, f2: 0x71, f3: 0x72, f4: 0x73, f5: 0x74, f6: 0x75,
  f7: 0x76, f8: 0x77, f9: 0x78, f10: 0x79, f11: 0x7a, f12: 0x7b,
}

/** Modifier VKs. `cmd` maps to Ctrl — models write "cmd+s" from macOS habit
 *  and Ctrl is the Windows equivalent for virtually every such shortcut. */
const MODIFIER_VK: Record<string, number> = {
  cmd: 0x11, command: 0x11, ctrl: 0x11, control: 0x11,
  alt: 0x12, opt: 0x12, option: 0x12,
  shift: 0x10,
  win: 0x5b, meta: 0x5b,
}

export type ComboKeySpec = {
  modifiers: number[]
  key: { vk: number } | { char: string }
}

/** Parse a "cmd+shift+s"-style combo into modifier VKs + final key. Throws on
 *  unknown multi-character key names (single chars go through VkKeyScan). */
export function parseCombo(combo: string): ComboKeySpec {
  const parts = combo.toLowerCase().split('+').map((s) => s.trim()).filter(Boolean)
  const key = parts.pop() ?? ''
  const modifiers: number[] = []
  for (const part of parts) {
    const vk = MODIFIER_VK[part]
    if (vk === undefined) throw new Error(`unknown modifier "${part}" in combo "${combo}"`)
    if (!modifiers.includes(vk)) modifiers.push(vk)
  }
  const namedVk = NAMED_VK[key]
  if (namedVk !== undefined) return { modifiers, key: { vk: namedVk } }
  if (key.length !== 1) throw new Error(`unknown key "${key}" in combo "${combo}"`)
  return { modifiers, key: { char: key } }
}

// --- script builders (exported for unit tests) ---

export function buildListAppsScript(): string {
  // Classic apps: process name + main-window title (the title is what lets
  // the model tell chrome/WINWORD-style names apart). UWP apps: their own
  // process has no window — list ApplicationFrameHost's top-level UIA frame
  // windows by title as standalone entries so they're targetable by name.
  return `
${INPUT_PRELUDE}
${UIA_PRELUDE}
$fgHwnd = [RivetInput]::GetForegroundWindow()
$fgPid = [uint32]0
[void][RivetInput]::GetWindowThreadProcessId($fgHwnd, [ref]$fgPid)
$byName = @{}
foreach ($p in @(Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -and $_.ProcessName -ne 'ApplicationFrameHost' })) {
  $n = $p.ProcessName
  if (-not $byName.ContainsKey($n)) { $byName[$n] = @{ name = $n; title = [string]$p.MainWindowTitle; frontmost = $false } }
  if ($p.Id -eq $fgPid) { $byName[$n].frontmost = $true; $byName[$n].title = [string]$p.MainWindowTitle }
}
$entries = New-Object System.Collections.ArrayList
foreach ($k in @($byName.Keys | Sort-Object)) { [void]$entries.Add($byName[$k]) }
$afh = @(Get-Process -Name ApplicationFrameHost -ErrorAction SilentlyContinue | ForEach-Object { $_.Id })
if ($afh.Count -gt 0) {
  $uiaRoot = [System.Windows.Automation.AutomationElement]::RootElement
  foreach ($w in $uiaRoot.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)) {
    if ($afh -notcontains $w.Current.ProcessId) { continue }
    $n = [string]$w.Current.Name
    if (-not $n) { continue }
    $isFg = $false
    try { $isFg = ([int64]$w.Current.NativeWindowHandle) -eq ([int64]$fgHwnd) } catch {}
    [void]$entries.Add(@{ name = $n; title = ''; frontmost = $isFg })
  }
}
ConvertTo-Json -InputObject @($entries.ToArray()) -Compress
`
}

export function buildSnapshotScript(app: string, outFull: string, outVision: string, screenshot = true): string {
  const shotSection = screenshot
    ? `
$shotOk = $false
try {
  Add-Type -AssemblyName System.Drawing | Out-Null
  $wr = $wins[0].Current.BoundingRectangle
  if (-not $wr.IsEmpty -and $wr.Width -gt 0 -and $wr.Height -gt 0) {
    $sx = [int]$wr.X; $sy = [int]$wr.Y; $sw = [int]$wr.Width; $sh = [int]$wr.Height
    $bmp = New-Object System.Drawing.Bitmap($sw, $sh)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.CopyFromScreen($sx, $sy, 0, 0, (New-Object System.Drawing.Size($sw, $sh)))
    $g.Dispose()
    $bmp.Save(${psString(outFull)}, [System.Drawing.Imaging.ImageFormat]::Png)
    $maxDim = ${VISION_MAX_DIMENSION}
    if ($sw -gt $maxDim -or $sh -gt $maxDim) {
      $scale = [math]::Min($maxDim / $sw, $maxDim / $sh)
      $nw = [math]::Max(1, [int]($sw * $scale)); $nh = [math]::Max(1, [int]($sh * $scale))
      $small = New-Object System.Drawing.Bitmap($bmp, $nw, $nh)
      $small.Save(${psString(outVision)}, [System.Drawing.Imaging.ImageFormat]::Png)
      $small.Dispose()
    }
    $bmp.Dispose()
    $shotOk = $true
  }
} catch { $shotOk = $false }`
    : `
$shotOk = $false`
  // The walk is CacheRequest-batched: one FindAll(Children) per PARENT pulls
  // every child with all four properties (+ ValuePattern) prefetched, so the
  // per-node cost drops from 4-5 cross-process UIA calls to ~1 per parent.
  // FindAll with ControlViewCondition returns children in ControlViewWalker
  // order, so the child-index paths stay compatible with resolveByPath.
  return `
${INPUT_PRELUDE}
${UIA_PRELUDE}
${resolveApp(app)}
$MAX = ${MAX_TREE_NODES}
$DEADLINE = [DateTime]::UtcNow.AddMilliseconds(${WALK_BUDGET_MS})
$script:rows = New-Object System.Collections.ArrayList
$script:refN = 0
$script:truncated = $false
$NO_DESCEND = @{ ScrollBar = $true; TitleBar = $true }
$SKIP_VALUE = @{ Window = $true; Pane = $true; Group = $true; Tree = $true; List = $true; Table = $true; DataGrid = $true; DataItem = $true; ToolBar = $true; TitleBar = $true; MenuBar = $true; Menu = $true; Tab = $true; ScrollBar = $true; Header = $true }
$ctrlCond = [System.Windows.Automation.Automation]::ControlViewCondition
$cr = New-Object System.Windows.Automation.CacheRequest
$cr.Add([System.Windows.Automation.AutomationElement]::NameProperty)
$cr.Add([System.Windows.Automation.AutomationElement]::ControlTypeProperty)
$cr.Add([System.Windows.Automation.AutomationElement]::BoundingRectangleProperty)
$cr.Add([System.Windows.Automation.ValuePattern]::Pattern)
$cr.Add([System.Windows.Automation.ValuePattern]::ValueProperty)
$cr.TreeFilter = $ctrlCond
function Visit($el, $depth, $path) {
  if ($script:rows.Count -ge $MAX -or [DateTime]::UtcNow -gt $DEADLINE) { $script:truncated = $true; return }
  $role = ''; $title = ''; $value = ''
  try { $role = $el.Cached.ControlType.ProgrammaticName -replace '^ControlType\\.', '' } catch {}
  try { $title = [string]$el.Cached.Name } catch {}
  if (-not $SKIP_VALUE.ContainsKey($role)) {
    try {
      $vp = $null
      if ($el.TryGetCachedPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$vp) -and $vp) { $value = [string]$vp.Cached.Value }
    } catch {}
  }
  if ($role -or $title -or $value) {
    $script:refN++
    $pos = $null
    try {
      $r = $el.Cached.BoundingRectangle
      if (-not $r.IsEmpty) { $pos = @{ x = [int][math]::Round($r.X); y = [int][math]::Round($r.Y) } }
    } catch {}
    [void]$script:rows.Add(@{ ref = $script:refN; depth = $depth; role = $role; title = $title; value = $value; pos = $pos; path = $path })
  }
  if ($NO_DESCEND.ContainsKey($role)) { return }
  $kids = $null
  try { $kids = $el.FindAll([System.Windows.Automation.TreeScope]::Children, $ctrlCond) } catch { return }
  for ($k = 0; $k -lt $kids.Count; $k++) {
    if ($script:rows.Count -ge $MAX -or [DateTime]::UtcNow -gt $DEADLINE) { $script:truncated = $true; break }
    Visit $kids[$k] ($depth + 1) ($path + @($k))
  }
}
$act = $cr.Activate()
try {
  for ($i = 0; $i -lt $wins.Count; $i++) { Visit ($wins[$i].GetUpdatedCache($cr)) 0 @($i) }
} finally { $act.Dispose() }
${shotSection}
ConvertTo-Json -InputObject @{ rows = $script:rows.ToArray(); shot = $shotOk; truncated = $script:truncated } -Depth 8 -Compress
`
}

export function buildClickByPathScript(
  app: string,
  target: { path: number[]; role?: string; title?: string },
  button: 'left' | 'right',
  count: 1 | 2,
): string {
  // Plain left single click prefers InvokePattern (the UIA analog of AXPress —
  // works even for obscured elements); everything else needs real synthetic
  // events at the element's center. No `exit` — these scripts also run inside
  // the resident PS host, which an exit would kill.
  const invokeFastPath = button === 'left' && count === 1
    ? `
$invoke = $null
if ($found.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$invoke) -and $invoke) {
  $invoke.Invoke()
  $clicked = $true
}`
    : ''
  return `
${INPUT_PRELUDE}
${UIA_PRELUDE}
${resolveApp(app)}
${resolveByPath(target)}
$clicked = $false
${invokeFastPath}
if (-not $clicked) {
${ELEMENT_CENTER}
[RivetInput]::Click($cx, $cy, $${button === 'right'}, ${count})
}
'ok'
`
}

export function buildClickAtScript(x: number, y: number, button: 'left' | 'right', count: 1 | 2): string {
  return `
${INPUT_PRELUDE}
[RivetInput]::Click(${Math.round(x)}, ${Math.round(y)}, $${button === 'right'}, ${count})
'ok'
`
}

export function buildLocateScript(app: string, target: { path: number[]; role?: string; title?: string }): string {
  return `
${INPUT_PRELUDE}
${UIA_PRELUDE}
${resolveApp(app)}
${resolveByPath(target)}
${ELEMENT_CENTER}
ConvertTo-Json -InputObject @{ x = $cx; y = $cy } -Compress
`
}

/** Window-center scroll anchor — expects $app and $fh (set by app resolution). */
export const SCROLL_WINDOW_CENTER = `
$wrct = New-Object 'RivetInput+RECT'
if ($fh -eq [IntPtr]::Zero -or -not [RivetInput]::GetWindowRect($fh, [ref]$wrct)) { throw "cannot resolve a scroll position for '$app' (no window)" }
$ax = [int](($wrct.Left + $wrct.Right) / 2); $ay = [int](($wrct.Top + $wrct.Bottom) / 2)`

export function buildScrollScript(app: string, opts: ScrollOptions): string {
  const amount = Math.max(1, Math.min(50, Math.round(opts.amount ?? 5)))
  // Windows wheel: positive vertical = up (away from user), positive
  // horizontal (HWHEEL) = right. One "line" = WHEEL_DELTA (120).
  const delta = (opts.direction === 'up' || opts.direction === 'right' ? 1 : -1) * amount * 120
  const horizontal = opts.direction === 'left' || opts.direction === 'right'
  const atSnippet = opts.at
    ? `$ax = ${Math.round(opts.at.x)}; $ay = ${Math.round(opts.at.y)}`
    : `
${UIA_PRELUDE}
${resolveApp(app)}
${SCROLL_WINDOW_CENTER}`
  return `
${INPUT_PRELUDE}
${atSnippet}
[RivetInput]::Wheel($ax, $ay, ${delta}, $${horizontal})
'ok'
`
}

export function buildDragScript(from: { x: number; y: number }, to: { x: number; y: number }): string {
  // Stepped moves matter: many drop targets ignore a teleporting drag.
  return `
${INPUT_PRELUDE}
[RivetInput]::Drag(${Math.round(from.x)}, ${Math.round(from.y)}, ${Math.round(to.x)}, ${Math.round(to.y)}, 8)
'ok'
`
}

/** Focus-then-type body — expects $fh (set by app resolution). Text travels
 *  as base64 so newlines/quotes/CJK never touch PS quoting. */
export function typeBodySnippet(text: string): string {
  const b64 = Buffer.from(text, 'utf8').toString('base64')
  return `
${FOCUS_WINDOW}
Start-Sleep -Milliseconds 100
$text = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String(${psString(b64)}))
foreach ($ch in $text.ToCharArray()) {
  if ($ch -eq [char]10) { [RivetInput]::KeyTap([uint16]13) }
  elseif ($ch -eq [char]13) { }
  else { [RivetInput]::TypeChar($ch) }
  Start-Sleep -Milliseconds 5
}`
}

export function buildTypeScript(app: string, text: string): string {
  return `
${INPUT_PRELUDE}
${UIA_PRELUDE}
${resolveApp(app)}
${typeBodySnippet(text)}
'ok'
`
}

/** Focus-then-key-combo body — expects $fh (set by app resolution). */
export function keyBodySnippet(spec: ComboKeySpec): string {
  const modsDown = spec.modifiers.map((vk) => `[RivetInput]::KeyDown([uint16]${vk})`).join('\n')
  const modsUp = [...spec.modifiers].reverse().map((vk) => `[RivetInput]::KeyUp([uint16]${vk})`).join('\n')
  const hasShift = spec.modifiers.includes(0x10)
  const keyAction = 'vk' in spec.key
    ? `[RivetInput]::KeyTap([uint16]${spec.key.vk})`
    : `
$scan = [RivetInput]::VkKeyScan([char]${psString(spec.key.char)})
if ($scan -eq -1) { throw 'no virtual key for the requested character' }
$vk = $scan -band 0xFF
$needShift = (($scan -band 0x100) -ne 0) -and (-not $${hasShift})
if ($needShift) { [RivetInput]::KeyDown([uint16]16) }
[RivetInput]::KeyTap([uint16]$vk)
if ($needShift) { [RivetInput]::KeyUp([uint16]16) }`
  return `
${FOCUS_WINDOW}
Start-Sleep -Milliseconds 100
${modsDown}
try {
${keyAction}
} finally {
${modsUp}
}`
}

export function buildKeyScript(app: string, spec: ComboKeySpec): string {
  return `
${INPUT_PRELUDE}
${UIA_PRELUDE}
${resolveApp(app)}
${keyBodySnippet(spec)}
'ok'
`
}

export function buildFocusAppScript(app: string): string {
  return `
${INPUT_PRELUDE}
${UIA_PRELUDE}
${resolveApp(app)}
${FOCUS_WINDOW}
'ok'
`
}

export function buildLaunchAppScript(app: string): string {
  // Already running → just focus. Otherwise Start-Process (resolves via App
  // Paths/PATH) and poll until a window is resolvable — the findApp poll also
  // matches UIA window titles, so UWP apps (frame-hosted) are waited on too.
  return `
${INPUT_PRELUDE}
${UIA_PRELUDE}
${findApp(app)}
if ($wins.Count -eq 0) {
  Start-Process -FilePath $app | Out-Null
  for ($try = 0; $try -lt 40; $try++) {
    Start-Sleep -Milliseconds 250
    ${findApp(app)}
    if ($wins.Count -gt 0) { break }
  }
  if ($wins.Count -eq 0) { throw "$app did not show a window within 10s" }
}
${FOCUS_WINDOW}
'ok'
`
}

export function buildMenuSelectScript(app: string, path: string[]): string {
  // Walk MenuItems by Name level by level. Windows popup menus often parent to
  // the desktop, not the app window — after the first expand, search from the
  // UIA root as a fallback. On a missing segment, list what IS available at
  // that level so the model can self-correct.
  return `
${INPUT_PRELUDE}
${UIA_PRELUDE}
${resolveApp(app)}
${FOCUS_WINDOW}
Start-Sleep -Milliseconds 150
$segments = @(ConvertFrom-Json ${psString(JSON.stringify(path))})
$uiaRootEl = [System.Windows.Automation.AutomationElement]::RootElement
$menuItemCond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::MenuItem)
$scope = $wins[0]
for ($i = 0; $i -lt $segments.Count; $i++) {
  $seg = [string]$segments[$i]
  $nameCond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty, $seg)
  $cond = New-Object System.Windows.Automation.AndCondition($menuItemCond, $nameCond)
  $item = $scope.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $cond)
  if ($item -eq $null -and $i -gt 0) { $item = $uiaRootEl.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $cond) }
  if ($item -eq $null -and $i -gt 0) {
    Start-Sleep -Milliseconds 250
    $item = $scope.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $cond)
    if ($item -eq $null) { $item = $uiaRootEl.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $cond) }
  }
  if ($item -eq $null) {
    $names = @()
    foreach ($m in $scope.FindAll([System.Windows.Automation.TreeScope]::Descendants, $menuItemCond)) { $names += $m.Current.Name }
    throw "menu item '$seg' not found; available: $($names -join ', ')"
  }
  $expand = $null; $invoke = $null
  if ($i -lt $segments.Count - 1) {
    if ($item.TryGetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern, [ref]$expand) -and $expand) { $expand.Expand() }
    elseif ($item.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$invoke) -and $invoke) { $invoke.Invoke() }
    Start-Sleep -Milliseconds 250
    $scope = $item
  } else {
    if ($item.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$invoke) -and $invoke) { $invoke.Invoke() }
    elseif ($item.TryGetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern, [ref]$expand) -and $expand) { $expand.Expand() }
    else {
      $r = $item.Current.BoundingRectangle
      if ($r.IsEmpty) { throw "menu item '$seg' is not invokable and has no position" }
      [RivetInput]::Click([int]($r.X + $r.Width / 2), [int]($r.Y + $r.Height / 2), $false, 1)
    }
  }
}
'ok'
`
}

export function buildSetValueScript(
  app: string,
  target: { path: number[]; role?: string; title?: string },
  text: string,
): string {
  // ValuePattern.SetValue — the UIA analog of the macOS AXValue write. Text
  // travels as base64 (quoting/CJK-safe). Controls without ValuePattern (or
  // read-only ones, which SetValue throws on) get a fallback-guiding error.
  const b64 = Buffer.from(text, 'utf8').toString('base64')
  return `
${INPUT_PRELUDE}
${UIA_PRELUDE}
${resolveApp(app)}
${resolveByPath(target)}
$text = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String(${psString(b64)}))
$vp = $null
if (-not $found.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$vp) -or -not $vp) {
  throw 'element does not accept direct value writes - click it and use type/paste_text instead'
}
$vp.SetValue($text)
'ok'
`
}

/** Clipboard-then-Ctrl+V body — expects $fh (set by app resolution). Text
 *  travels as base64 (quoting/CJK-safe). */
export function pasteBodySnippet(text: string): string {
  const b64 = Buffer.from(text, 'utf8').toString('base64')
  return `
$text = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String(${psString(b64)}))
Set-Clipboard -Value $text
${FOCUS_WINDOW}
Start-Sleep -Milliseconds 150
[RivetInput]::KeyDown([uint16]17)
try { [RivetInput]::KeyTap([uint16]86) } finally { [RivetInput]::KeyUp([uint16]17) }`
}

export function buildPasteTextScript(app: string, text: string): string {
  return `
${INPUT_PRELUDE}
${UIA_PRELUDE}
${resolveApp(app)}
${pasteBodySnippet(text)}
'ok'
`
}

export function buildCheckPermissionsScript(): string {
  return `
${UIA_PRELUDE}
$ok = $false
try { $null = [System.Windows.Automation.AutomationElement]::RootElement.Current.Name; $ok = $true } catch {}
ConvertTo-Json -InputObject @{ accessibility = $ok } -Compress
`
}

/** Real Windows driver. Runner injectable for tests. */
export function createWindowsDriver(
  run: PowerShellRunner = runPowerShellDefault,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): ComputerUseDriver {
  // Session-level UIA path choice: COM when the probe passes, managed
  // otherwise. Checked per action because the probe is lazy (first UIA call).
  const useCom = () => comReady(run)
  return {
    async listApps(): Promise<AppInfo[]> {
      const script = (await useCom()) ? buildComListAppsScript() : buildListAppsScript()
      const raw = (await run(script)).trim()
      try {
        const parsed = JSON.parse(raw) as AppInfo[] | AppInfo
        if (Array.isArray(parsed)) return parsed
        // ConvertTo-Json unwraps single-element arrays (PS 5.1 quirk).
        if (parsed && typeof parsed === 'object') return [parsed]
        return []
      } catch {
        return []
      }
    },

    async snapshot(app: string, opts?: SnapshotOptions): Promise<SnapshotResult> {
      const stamp = randomUUID()
      const outFull = join(tmpdir(), `rivet-cu-${stamp}.png`)
      const outVision = join(tmpdir(), `rivet-cu-vision-${stamp}.png`)
      try {
        const wantShot = opts?.screenshot !== false
        const script = (await useCom())
          ? buildComSnapshotScript(app, outFull, outVision, wantShot, MAX_TREE_NODES, WALK_BUDGET_MS)
          : buildSnapshotScript(app, outFull, outVision, wantShot)
        const runWalk = async (): Promise<{ rows: WindowsSnapshotRow[]; shot: boolean; truncated: boolean }> => {
          const raw = (await run(script, 30_000)).trim()
          try {
            const parsed = JSON.parse(raw) as {
              rows?: WindowsSnapshotRow[] | WindowsSnapshotRow
              shot?: boolean
              truncated?: boolean
              // COM path nests the C#-assembled walk result under "snap".
              snap?: { rows?: WindowsSnapshotRow[] | WindowsSnapshotRow; truncated?: boolean }
            }
            const core = parsed.snap ?? parsed
            // ConvertTo-Json unwraps single-element arrays into a bare object
            // (PS 5.1 quirk) — re-wrap instead of dropping to an empty tree.
            let rows: WindowsSnapshotRow[] = []
            if (Array.isArray(core.rows)) rows = core.rows
            else if (core.rows && typeof core.rows === 'object') rows = [core.rows]
            return { rows, shot: parsed.shot === true, truncated: core.truncated === true }
          } catch {
            return { rows: [], shot: false, truncated: false }
          }
        }
        let walk = await runWalk()
        // Electron skeleton-tree warmup (same policy as the macOS driver): a
        // tiny non-truncated first walk right after accessibility switches on
        // is indistinguishable from a genuinely tiny UI — wait once, re-walk,
        // keep whichever saw more.
        if (!walk.truncated && walk.rows.length < SPARSE_TREE_RETRY_THRESHOLD) {
          await sleep(SPARSE_TREE_RETRY_DELAY_MS)
          const second = await runWalk()
          if (second.rows.length > walk.rows.length) walk = second
        }
        const { rows, shot, truncated } = walk
        const { tree: baseTree, refs } = rowsToSnapshot(rows)
        const tree = baseTree && truncated ? `${baseTree}${PARTIAL_TREE_NOTE}` : baseTree
        let png: Buffer | null = null
        let visionPng: Buffer | null = null
        if (shot) {
          try {
            png = await readFile(outFull)
          } catch {
            png = null
          }
          if (png) {
            // Vision copy: capped at 1440px. If the resize somehow produced a
            // LARGER file (tiny window upscaled by PNG overhead), keep the
            // original — same rule as the macOS sips path.
            try {
              const scaled = await readFile(outVision)
              visionPng = scaled.length < png.length ? scaled : png
            } catch {
              visionPng = png
            }
          }
        }
        return {
          tree: tree || '(no accessible elements found)',
          refs,
          screenshotPng: png,
          visionPng,
          truncated,
        }
      } finally {
        try { await unlink(outFull) } catch { /* best-effort temp cleanup */ }
        try { await unlink(outVision) } catch { /* best-effort temp cleanup */ }
      }
    },

    async click(app: string, target: ClickTarget, opts?: ClickOptions): Promise<void> {
      const button = opts?.button ?? 'left'
      const count = opts?.count ?? 1
      if ('path' in target) {
        const script = (await useCom())
          ? buildComClickByPathScript(app, target, button, count)
          : buildClickByPathScript(app, target, button, count)
        await run(script)
        return
      }
      await run(buildClickAtScript(target.x, target.y, button, count))
    },

    async locate(app: string, target: { path: number[]; role?: string; title?: string }): Promise<{ x: number; y: number }> {
      const script = (await useCom()) ? buildComLocateScript(app, target) : buildLocateScript(app, target)
      const raw = (await run(script)).trim()
      return JSON.parse(raw) as { x: number; y: number }
    },

    async scroll(app: string, opts: ScrollOptions): Promise<void> {
      const script = (await useCom()) ? buildComScrollScript(app, opts) : buildScrollScript(app, opts)
      await run(script)
    },

    async drag(_app: string, from: { x: number; y: number }, to: { x: number; y: number }): Promise<void> {
      await run(buildDragScript(from, to))
    },

    async type(app: string, text: string): Promise<void> {
      const script = (await useCom()) ? buildComTypeScript(app, text) : buildTypeScript(app, text)
      await run(script)
    },

    async setValue(app: string, target: { path: number[]; role?: string; title?: string }, text: string): Promise<void> {
      const script = (await useCom()) ? buildComSetValueScript(app, target, text) : buildSetValueScript(app, target, text)
      await run(script)
    },

    async key(app: string, combo: string): Promise<void> {
      const spec = parseCombo(combo)
      const script = (await useCom()) ? buildComKeyScript(app, spec) : buildKeyScript(app, spec)
      await run(script)
    },

    async focusApp(app: string): Promise<void> {
      const script = (await useCom()) ? buildComFocusAppScript(app) : buildFocusAppScript(app)
      await run(script)
    },

    async launchApp(app: string): Promise<void> {
      const script = (await useCom()) ? buildComLaunchAppScript(app) : buildLaunchAppScript(app)
      await run(script, 25_000)
    },

    async menuSelect(app: string, path: string[]): Promise<void> {
      if (path.length === 0) throw new Error('menu_select requires a non-empty menu path')
      const script = (await useCom()) ? buildComMenuSelectScript(app, path) : buildMenuSelectScript(app, path)
      await run(script)
    },

    async pasteText(app: string, text: string): Promise<void> {
      const script = (await useCom()) ? buildComPasteTextScript(app, text) : buildPasteTextScript(app, text)
      await run(script)
    },

    async checkPermissions(): Promise<PermissionStatus> {
      // Windows has no TCC-style permission gates: UIA availability stands in
      // for "accessibility" and GDI screen capture is never permission-gated.
      let accessibility = false
      try {
        const raw = (await run(buildCheckPermissionsScript())).trim()
        const parsed = JSON.parse(raw) as { accessibility?: boolean }
        accessibility = parsed.accessibility === true
      } catch {
        accessibility = false
      }
      const detail = accessibility
        ? 'All required capabilities available. Note: windows of elevated (administrator) processes cannot be automated unless this process is also elevated.'
        : 'UI Automation is unavailable on this host — GUI inspection and interaction will not work.'
      return { accessibility, screenRecording: true, detail }
    },
  }
}
