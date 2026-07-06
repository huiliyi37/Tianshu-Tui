/**
 * macOS Computer Use driver — GUI automation via osascript + screencapture.
 *
 * Zero new dependencies: the accessibility tree goes through `osascript`
 * (JXA / System Events), input synthesis through JXA's ObjC bridge to
 * CoreGraphics (CGEvent — reliable synthetic mouse events, unlike System
 * Events' `click at`), and window screenshots through the bundled
 * `screencapture` binary. The driver interface is injectable so the tool's
 * security logic is unit-testable with a fake driver (mirrors browser.ts).
 *
 * Perception is dual-channel by design: the accessibility TREE (text) is the
 * universal model-facing channel, while the SCREENSHOT is persisted as a
 * viewable artifact — and, for vision-capable models, a downsampled copy
 * (`visionPng`) can be attached to the conversation by the tool pipeline.
 *
 * Element targeting: each snapshot ref carries its AX child-index PATH
 * (e.g. [0,3,1] = window 0 → child 3 → child 1). Click resolution walks the
 * path directly and verifies role/title — far more stable than re-walking
 * the whole tree and counting to the Nth labeled element.
 */

import { execFile } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFile, unlink } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'

export interface AppInfo {
  name: string
  frontmost: boolean
}

/** Structured snapshot element: ref number + AX path + identity for validation. */
export interface SnapshotRef {
  ref: number
  /** Child-index chain from the app's windows: [windowIdx, childIdx, ...]. */
  path: number[]
  role: string
  title: string
  pos: { x: number; y: number } | null
}

/** A click target: an AX path (preferred, validated) or raw screen coords. */
export type ClickTarget =
  | { path: number[]; role?: string; title?: string }
  | { x: number; y: number }

export interface ClickOptions {
  button?: 'left' | 'right'
  count?: 1 | 2
}

export interface ScrollOptions {
  direction: 'up' | 'down' | 'left' | 'right'
  /** Scroll magnitude in wheel lines (default 5). */
  amount?: number
  /** Position the cursor here first; defaults to the app window center. */
  at?: { x: number; y: number }
}

export interface SnapshotResult {
  /** Compact numbered accessibility tree (model-facing). */
  tree: string
  /** Structured refs backing the tree — cached by the tool for click targeting. */
  refs: SnapshotRef[]
  /** Window screenshot PNG (user-facing artifact); null if capture failed. */
  screenshotPng: Buffer | null
  /** Downsampled screenshot (max 1440px, sips) for vision-model attachment;
   *  null when capture failed or downsampling did not help. */
  visionPng: Buffer | null
}

export interface PermissionStatus {
  /** Accessibility (System Events control) — required for click/type/key. */
  accessibility: boolean
  /** Screen Recording — required for screencapture of window content. */
  screenRecording: boolean
  /** Human-readable guidance when a permission is missing. */
  detail: string
}

export interface SnapshotOptions {
  /** Capture window screenshot + vision copy (default true). Tree-only
   *  snapshots (false) are much faster — used for post-action feedback. */
  screenshot?: boolean
}

export interface ComputerUseDriver {
  listApps(): Promise<AppInfo[]>
  snapshot(app: string, opts?: SnapshotOptions): Promise<SnapshotResult>
  click(app: string, target: ClickTarget, opts?: ClickOptions): Promise<void>
  /** Resolve an AX-path target to its on-screen center point (validated). */
  locate(app: string, target: { path: number[]; role?: string; title?: string }): Promise<{ x: number; y: number }>
  scroll(app: string, opts: ScrollOptions): Promise<void>
  drag(app: string, from: { x: number; y: number }, to: { x: number; y: number }): Promise<void>
  type(app: string, text: string): Promise<void>
  key(app: string, combo: string): Promise<void>
  focusApp(app: string): Promise<void>
  /** Launch the app if not running (activates either way), waiting for it to appear. */
  launchApp(app: string): Promise<void>
  /** Click through the menu bar along a path like ["File", "Export", "PNG"]. */
  menuSelect(app: string, path: string[]): Promise<void>
  /** Put text on the clipboard and paste it into the app (clipboard is overwritten). */
  pasteText(app: string, text: string): Promise<void>
  checkPermissions(): Promise<PermissionStatus>
}

export type ComputerUseDriverFactory = () => ComputerUseDriver

const OSASCRIPT_TIMEOUT_MS = 15_000
/** Bound the accessibility walk so a deep app tree can't blow up the result. */
const MAX_TREE_NODES = 400
/** Max dimension for the vision-model screenshot copy (px). */
const VISION_MAX_DIMENSION = 1440

function runOsascript(args: string[], timeoutMs = OSASCRIPT_TIMEOUT_MS): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('osascript', args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(stderr?.toString().trim() || err.message))
        return
      }
      resolve(stdout.toString())
    })
  })
}

function runJxa(script: string, timeoutMs = OSASCRIPT_TIMEOUT_MS): Promise<string> {
  return runOsascript(['-l', 'JavaScript', '-e', script], timeoutMs)
}

/** Escape a string for safe embedding inside a JXA script (double-quoted literal). */
function jxaString(value: string): string {
  return JSON.stringify(value)
}

/**
 * JXA prelude: CGEvent synthesis helpers via the ObjC bridge. Synthetic mouse
 * events posted at the HID tap are what real input devices produce — System
 * Events' `click at {x,y}` is unreliable (ignored by many apps) and has no
 * right-click/double-click/scroll/drag story at all.
 */
const CG_PRELUDE = `
  ObjC.import('CoreGraphics');
  function cgPost(ev) { $.CGEventPost($.kCGHIDEventTap, ev); }
  function cgMouse(type, x, y, btn, clickState) {
    const ev = $.CGEventCreateMouseEvent($(), type, { x: x, y: y }, btn);
    if (clickState) $.CGEventSetIntegerValueField(ev, $.kCGMouseEventClickState, clickState);
    cgPost(ev);
  }
  function cgMove(x, y) { cgMouse($.kCGEventMouseMoved, x, y, $.kCGMouseButtonLeft, 0); }
  function cgClick(x, y, right, count) {
    const down = right ? $.kCGEventRightMouseDown : $.kCGEventLeftMouseDown;
    const up = right ? $.kCGEventRightMouseUp : $.kCGEventLeftMouseUp;
    const btn = right ? $.kCGMouseButtonRight : $.kCGMouseButtonLeft;
    cgMove(x, y);
    for (let i = 1; i <= count; i++) {
      cgMouse(down, x, y, btn, i);
      cgMouse(up, x, y, btn, i);
    }
  }
  function sleepS(s) { $.NSThread.sleepForTimeInterval(s); }
`

/**
 * JXA helper: resolve an element by AX child-index path with identity check.
 * Emits `found` (the element) or throws a stale-snapshot error. Expects
 * `PATH`, `EXPECT_ROLE`, `EXPECT_TITLE` consts to be defined by the caller.
 */
const RESOLVE_BY_PATH = `
  let windows = [];
  try { windows = proc.windows(); } catch (e) {}
  if (PATH.length === 0 || PATH[0] >= windows.length) {
    throw new Error('stale snapshot — window index out of range, re-snapshot first');
  }
  let el = windows[PATH[0]];
  for (let i = 1; i < PATH.length; i++) {
    let kids = [];
    try { kids = el.uiElements(); } catch (e) {}
    if (PATH[i] >= kids.length) {
      throw new Error('stale snapshot — element path no longer valid, re-snapshot first');
    }
    el = kids[PATH[i]];
  }
  let role = '', title = '';
  try { role = el.role(); } catch (e) {}
  try { title = el.title() || el.description() || ''; } catch (e) {}
  if (EXPECT_ROLE && role !== EXPECT_ROLE) {
    throw new Error('stale snapshot — element role changed (' + role + ' != ' + EXPECT_ROLE + '), re-snapshot first');
  }
  if (EXPECT_TITLE && title !== EXPECT_TITLE) {
    throw new Error('stale snapshot — element title changed, re-snapshot first');
  }
  const found = el;
`

/** Build the const declarations for a path-target resolution. */
function pathConsts(target: { path: number[]; role?: string; title?: string }): string {
  return `
    const PATH = ${JSON.stringify(target.path)};
    const EXPECT_ROLE = ${jxaString(target.role ?? '')};
    const EXPECT_TITLE = ${jxaString(target.title ?? '')};
  `
}

/** Center point of an AX element (position + size / 2), with fallbacks. */
const ELEMENT_CENTER = `
  let cx = null, cy = null;
  try {
    const p = found.position(); const s = found.size();
    cx = p[0] + s[0] / 2; cy = p[1] + s[1] / 2;
  } catch (e) {
    try { const p = found.position(); cx = p[0]; cy = p[1]; } catch (e2) {}
  }
  if (cx === null) throw new Error('element has no on-screen position');
`

async function windowCenter(app: string): Promise<{ x: number; y: number } | null> {
  const script = `
    const se = Application('System Events');
    const proc = se.processes.byName(${jxaString(app)});
    const win = proc.windows[0];
    const pos = win.position(); const size = win.size();
    JSON.stringify({ x: pos[0] + size[0] / 2, y: pos[1] + size[1] / 2 });
  `
  try {
    return JSON.parse((await runJxa(script)).trim())
  } catch {
    return null
  }
}

/** Downsample a PNG to VISION_MAX_DIMENSION via macOS-bundled sips. */
async function downsampleForVision(srcFile: string): Promise<Buffer | null> {
  const dest = join(tmpdir(), `rivet-cu-vision-${randomUUID()}.png`)
  try {
    await new Promise<void>((resolve, reject) => {
      execFile(
        'sips',
        ['-Z', String(VISION_MAX_DIMENSION), srcFile, '--out', dest],
        { timeout: OSASCRIPT_TIMEOUT_MS },
        (err) => (err ? reject(err) : resolve()),
      )
    })
    return await readFile(dest)
  } catch {
    return null
  } finally {
    try { await unlink(dest) } catch { /* best-effort temp cleanup */ }
  }
}

async function captureWindow(app: string): Promise<{ png: Buffer | null; visionPng: Buffer | null }> {
  // Get the frontmost window bounds of the target app, then screencapture that
  // rectangle. Falls back to null (tree-only) if bounds can't be resolved.
  const boundsScript = `
    const se = Application('System Events');
    const proc = se.processes.byName(${jxaString(app)});
    const win = proc.windows[0];
    const pos = win.position();
    const size = win.size();
    JSON.stringify({ x: pos[0], y: pos[1], w: size[0], h: size[1] });
  `
  let rect: { x: number; y: number; w: number; h: number }
  try {
    const out = (await runJxa(boundsScript)).trim()
    rect = JSON.parse(out)
  } catch {
    return { png: null, visionPng: null }
  }
  if (!rect.w || !rect.h) return { png: null, visionPng: null }

  const file = join(tmpdir(), `rivet-cu-${randomUUID()}.png`)
  const region = `${Math.round(rect.x)},${Math.round(rect.y)},${Math.round(rect.w)},${Math.round(rect.h)}`
  try {
    await new Promise<void>((resolve, reject) => {
      execFile('screencapture', ['-x', '-o', '-R', region, file], { timeout: OSASCRIPT_TIMEOUT_MS }, (err) => {
        if (err) reject(err)
        else resolve()
      })
    })
    const buf = await readFile(file)
    // Vision copy: capped at 1440px so a Retina-scale window PNG doesn't dump
    // megabytes of base64 into the context. If sips somehow produces a LARGER
    // file (tiny window upsampled), keep the original.
    const scaled = await downsampleForVision(file)
    const visionPng = scaled && scaled.length < buf.length ? scaled : buf
    return { png: buf, visionPng }
  } catch {
    return { png: null, visionPng: null }
  } finally {
    try { await unlink(file) } catch { /* best-effort temp cleanup */ }
  }
}

/** Real macOS driver. */
export function createMacosDriver(): ComputerUseDriver {
  return {
    async listApps(): Promise<AppInfo[]> {
      const script = `
        const se = Application('System Events');
        const procs = se.applicationProcesses.whose({ visible: true })();
        const out = procs.map(p => ({ name: p.name(), frontmost: p.frontmost() }));
        JSON.stringify(out);
      `
      const raw = (await runJxa(script)).trim()
      try {
        const parsed = JSON.parse(raw) as AppInfo[]
        return Array.isArray(parsed) ? parsed : []
      } catch {
        return []
      }
    },

    async snapshot(app: string, opts?: SnapshotOptions): Promise<SnapshotResult> {
      // Walk the accessibility tree breadth-limited, emitting a numbered ref
      // AND its child-index path per actionable/labeled element so clicks can
      // later resolve the exact element without re-counting the whole tree.
      const script = `
        const se = Application('System Events');
        const proc = se.processes.byName(${jxaString(app)});
        const MAX = ${MAX_TREE_NODES};
        const rows = [];
        let ref = 0;
        function visit(el, depth, path) {
          if (rows.length >= MAX) return;
          let role = '', title = '', value = '';
          try { role = el.role(); } catch (e) {}
          try { title = el.title() || el.description() || ''; } catch (e) {}
          try { value = String(el.value() || ''); } catch (e) {}
          if (role || title || value) {
            ref++;
            let pos = null;
            try { const p = el.position(); pos = { x: p[0], y: p[1] }; } catch (e) {}
            rows.push({ ref, depth, role, title, value, pos, path });
          }
          let kids = [];
          try { kids = el.uiElements(); } catch (e) {}
          for (let i = 0; i < kids.length; i++) {
            if (rows.length >= MAX) break;
            visit(kids[i], depth + 1, path.concat(i));
          }
        }
        let windows = [];
        try { windows = proc.windows(); } catch (e) {}
        for (let i = 0; i < windows.length; i++) visit(windows[i], 0, [i]);
        JSON.stringify(rows);
      `
      const raw = (await runJxa(script)).trim()
      let rows: Array<{ ref: number; depth: number; role: string; title: string; value: string; pos: { x: number; y: number } | null; path: number[] }> = []
      try {
        rows = JSON.parse(raw)
      } catch {
        rows = []
      }
      const tree = rows
        .map((r) => {
          const indent = '  '.repeat(Math.min(r.depth, 8))
          const label = r.title ? ` "${r.title}"` : ''
          const val = r.value ? ` = ${r.value}` : ''
          const at = r.pos ? ` @(${Math.round(r.pos.x)},${Math.round(r.pos.y)})` : ''
          return `${indent}[${r.ref}] ${r.role || 'element'}${label}${val}${at}`
        })
        .join('\n')
      const refs: SnapshotRef[] = rows.map((r) => ({
        ref: r.ref,
        path: r.path,
        role: r.role,
        title: r.title,
        pos: r.pos,
      }))
      const shot = opts?.screenshot === false
        ? { png: null, visionPng: null }
        : await captureWindow(app)
      return {
        tree: tree || '(no accessible elements found)',
        refs,
        screenshotPng: shot.png,
        visionPng: shot.visionPng,
      }
    },

    async click(app: string, target: ClickTarget, opts?: ClickOptions): Promise<void> {
      const button = opts?.button ?? 'left'
      const count = opts?.count ?? 1
      if ('path' in target) {
        // Resolve by AX path + identity check. Plain left single click uses
        // AXPress (works even for obscured elements); right/double click needs
        // real synthetic events at the element's center.
        if (button === 'left' && count === 1) {
          const script = `
            const se = Application('System Events');
            const proc = se.processes.byName(${jxaString(app)});
            ${pathConsts(target)}
            ${RESOLVE_BY_PATH}
            found.click();
            'ok';
          `
          await runJxa(script)
          return
        }
        const script = `
          ${CG_PRELUDE}
          const se = Application('System Events');
          const proc = se.processes.byName(${jxaString(app)});
          ${pathConsts(target)}
          ${RESOLVE_BY_PATH}
          ${ELEMENT_CENTER}
          cgClick(cx, cy, ${button === 'right'}, ${count});
          'ok';
        `
        await runJxa(script)
        return
      }
      // Raw coordinate click via CGEvent (System Events' `click at` is flaky).
      const script = `
        ${CG_PRELUDE}
        cgClick(${Math.round(target.x)}, ${Math.round(target.y)}, ${button === 'right'}, ${count});
        'ok';
      `
      await runJxa(script)
    },

    async locate(app: string, target: { path: number[]; role?: string; title?: string }): Promise<{ x: number; y: number }> {
      const script = `
        const se = Application('System Events');
        const proc = se.processes.byName(${jxaString(app)});
        ${pathConsts(target)}
        ${RESOLVE_BY_PATH}
        ${ELEMENT_CENTER}
        JSON.stringify({ x: Math.round(cx), y: Math.round(cy) });
      `
      const raw = (await runJxa(script)).trim()
      return JSON.parse(raw) as { x: number; y: number }
    },

    async scroll(app: string, opts: ScrollOptions): Promise<void> {
      const amount = Math.max(1, Math.min(50, Math.round(opts.amount ?? 5)))
      // CGEvent scroll: wheel1 = vertical (positive scrolls up), wheel2 = horizontal
      // (positive scrolls left). Position the cursor over the target first —
      // scroll events are delivered to the view under the cursor.
      const at = opts.at ?? (await windowCenter(app))
      if (!at) throw new Error(`cannot resolve a scroll position for ${app} (no window)`)
      const v = opts.direction === 'up' ? amount : opts.direction === 'down' ? -amount : 0
      const h = opts.direction === 'left' ? amount : opts.direction === 'right' ? -amount : 0
      const script = `
        ${CG_PRELUDE}
        cgMove(${Math.round(at.x)}, ${Math.round(at.y)});
        const ev = $.CGEventCreateScrollWheelEvent2($(), $.kCGScrollEventUnitLine, 2, ${v}, ${h}, 0);
        cgPost(ev);
        'ok';
      `
      await runJxa(script)
    },

    async drag(app: string, from: { x: number; y: number }, to: { x: number; y: number }): Promise<void> {
      // mouseDown → stepped mouseDragged → mouseUp. Steps + inter-step sleeps
      // matter: many drop targets ignore a teleporting drag.
      const steps = 8
      const script = `
        ${CG_PRELUDE}
        const fx = ${Math.round(from.x)}, fy = ${Math.round(from.y)};
        const tx = ${Math.round(to.x)}, ty = ${Math.round(to.y)};
        cgMove(fx, fy);
        sleepS(0.05);
        cgMouse($.kCGEventLeftMouseDown, fx, fy, $.kCGMouseButtonLeft, 1);
        for (let i = 1; i <= ${steps}; i++) {
          const x = fx + (tx - fx) * i / ${steps};
          const y = fy + (ty - fy) * i / ${steps};
          cgMouse($.kCGEventLeftMouseDragged, x, y, $.kCGMouseButtonLeft, 1);
          sleepS(0.02);
        }
        sleepS(0.05);
        cgMouse($.kCGEventLeftMouseUp, tx, ty, $.kCGMouseButtonLeft, 1);
        'ok';
      `
      await runJxa(script)
    },

    async type(app: string, text: string): Promise<void> {
      const script = `
        const se = Application('System Events');
        se.processes.byName(${jxaString(app)}).frontmost = true;
        se.keystroke(${jxaString(text)});
        'ok';
      `
      await runJxa(script)
    },

    async key(app: string, combo: string): Promise<void> {
      // combo like "cmd+s", "shift+cmd+4", "return". Map modifiers to System
      // Events "using" and the final token to a keystroke or key code.
      const parts = combo.toLowerCase().split('+').map((s) => s.trim()).filter(Boolean)
      const key = parts.pop() ?? ''
      const modMap: Record<string, string> = {
        cmd: 'command down', command: 'command down',
        opt: 'option down', option: 'option down', alt: 'option down',
        ctrl: 'control down', control: 'control down',
        shift: 'shift down',
      }
      const usingList = parts.map((m) => modMap[m]).filter(Boolean)
      const using = usingList.length > 0 ? `, { using: [${usingList.map((u) => `'${u}'`).join(', ')}] }` : ''
      // Named keys go through key code; single chars go through keystroke.
      const namedKeyCodes: Record<string, number> = {
        return: 36, enter: 76, tab: 48, space: 49, delete: 51, escape: 53, esc: 53,
        left: 123, right: 124, down: 125, up: 126,
      }
      const focus = `se.processes.byName(${jxaString(app)}).frontmost = true;`
      let action: string
      if (key in namedKeyCodes) {
        action = `se.keyCode(${namedKeyCodes[key]}${using});`
      } else {
        action = `se.keystroke(${jxaString(key)}${using});`
      }
      await runJxa(`const se = Application('System Events'); ${focus} ${action} 'ok';`)
    },

    async focusApp(app: string): Promise<void> {
      const script = `
        const app = Application(${jxaString(app)});
        app.activate();
        'ok';
      `
      await runJxa(script)
    },

    async launchApp(app: string): Promise<void> {
      // activate() launches the app when it isn't running. Poll System Events
      // until the process shows up so callers can snapshot right after.
      const script = `
        Application(${jxaString(app)}).activate();
        const se = Application('System Events');
        let up = false;
        for (let i = 0; i < 40; i++) {
          try { se.processes.byName(${jxaString(app)}).id(); up = true; break; } catch (e) {}
          delay(0.25);
        }
        if (!up) throw new Error(${jxaString(app)} + ' did not appear within 10s');
        'ok';
      `
      await runJxa(script, 20_000)
    },

    async menuSelect(app: string, path: string[]): Promise<void> {
      if (path.length === 0) throw new Error('menu_select requires a non-empty menu path')
      // Walk the menu bar: menuBarItems.byName(top) → nested menus[0].menuItems
      // per segment, click the final item. On a missing segment, throw with the
      // names available at that level so the model can self-correct.
      const script = `
        const se = Application('System Events');
        const proc = se.processes.byName(${jxaString(app)});
        proc.frontmost = true;
        delay(0.1);
        const PATH = ${JSON.stringify(path)};
        let container = proc.menuBars[0].menuBarItems;
        let el = null;
        for (let i = 0; i < PATH.length; i++) {
          let names = [];
          try { names = container.name(); } catch (e) {}
          const idx = names.indexOf(PATH[i]);
          if (idx === -1) {
            throw new Error('menu item "' + PATH[i] + '" not found; available: ' + names.join(', '));
          }
          el = container[idx];
          if (i < PATH.length - 1) {
            el.click();
            delay(0.15);
            container = el.menus[0].menuItems;
          }
        }
        el.click();
        'ok';
      `
      await runJxa(script)
    },

    async pasteText(app: string, text: string): Promise<void> {
      await new Promise<void>((resolve, reject) => {
        const child = execFile('pbcopy', [], { timeout: 5_000 }, (err) => (err ? reject(err) : resolve()))
        child.stdin?.end(text)
      })
      const script = `
        const se = Application('System Events');
        se.processes.byName(${jxaString(app)}).frontmost = true;
        delay(0.1);
        se.keystroke('v', { using: ['command down'] });
        'ok';
      `
      await runJxa(script)
    },

    async checkPermissions(): Promise<PermissionStatus> {
      // Accessibility: try a benign System Events read. If it throws with a
      // permission error (-1719 / not allowed), accessibility is off.
      let accessibility = false
      try {
        await runJxa(`const se = Application('System Events'); se.processes.length; 'ok';`, 5_000)
        accessibility = true
      } catch {
        accessibility = false
      }
      // Screen Recording can't be probed without side effects reliably; infer
      // from a tiny screencapture to a temp file (fails/blank when denied).
      let screenRecording = false
      const probe = join(tmpdir(), `rivet-cu-probe-${randomUUID()}.png`)
      try {
        await new Promise<void>((resolve, reject) => {
          execFile('screencapture', ['-x', '-R', '0,0,1,1', probe], { timeout: 5_000 }, (err) => {
            if (err) reject(err)
            else resolve()
          })
        })
        const buf = await readFile(probe)
        screenRecording = buf.length > 0
      } catch {
        screenRecording = false
      } finally {
        try { await unlink(probe) } catch { /* best-effort */ }
      }
      const missing: string[] = []
      if (!accessibility) missing.push('Accessibility (System Settings → Privacy & Security → Accessibility)')
      if (!screenRecording) missing.push('Screen Recording (System Settings → Privacy & Security → Screen Recording)')
      const detail = missing.length === 0
        ? 'All required permissions granted.'
        : `Grant these permissions to Rivet/Tianshu, then retry: ${missing.join('; ')}.`
      return { accessibility, screenRecording, detail }
    },
  }
}
