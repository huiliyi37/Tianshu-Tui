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
import { createScriptHost, hostEnabled, HostUnavailableError, SENTINEL, type ScriptHost } from './script-host.js'

export interface AppInfo {
  name: string
  frontmost: boolean
  /** Main window title, when it adds signal beyond the name (Windows only). */
  title?: string
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
  /** True when the walk stopped at its budget/node cap — the tree is a
   *  partial view (refs remain valid). Callers should avoid diffing a
   *  partial tree against a full baseline. */
  truncated?: boolean
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
  /** Write a value directly into a text-like control (AXValue / ValuePattern).
   *  Throws when the control doesn't accept value writes. */
  setValue(app: string, target: { path: number[]; role?: string; title?: string }, text: string): Promise<void>
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
/**
 * Snapshot walks get a longer leash: once AX enablement unlocks Chromium web
 * content the tree easily has hundreds of nodes at ~4 Apple Events each.
 */
const SNAPSHOT_TIMEOUT_MS = 45_000
/** Bound the accessibility walk so a deep app tree can't blow up the result. */
const MAX_TREE_NODES = 400
/**
 * In-script wall-clock budget for the tree walk. Non-browser Electron apps
 * (QQ NT, WeChat…) have deep single-child group chains where per-parent
 * batching barely helps — a full QQ walk measured ~54s, past every timeout.
 * The script self-terminates at the deadline and returns the PARTIAL tree
 * with `truncated: true` instead of dying at the osascript kill with nothing.
 */
const WALK_BUDGET_MS = 25_000
/**
 * A first walk returning fewer rows than this right after AX enablement is
 * treated as an Electron skeleton tree (verified on QQ: 17 nodes at t=0,
 * 526 nodes ~6s after AXManualAccessibility is set — the renderer populates
 * the AX tree asynchronously). snapshot() waits and re-walks once.
 */
const SPARSE_TREE_RETRY_THRESHOLD = 25
/** Settle delay before the sparse-tree re-walk (ms). */
const SPARSE_TREE_RETRY_DELAY_MS = 2_500
/** Max dimension for the vision-model screenshot copy (px). */
const VISION_MAX_DIMENSION = 1440

/**
 * Whether `type` must route through clipboard paste to be reliable: any
 * character outside printable ASCII (CJK, emoji, accents…) goes through the
 * IME on `System Events keystroke`, where an active Chinese input method
 * intercepts the keystrokes into a composition buffer instead of the field.
 * Clipboard paste (Cmd+V) bypasses the IME entirely. Exported for tests.
 */
export function needsClipboardInput(text: string): boolean {
  // eslint-disable-next-line no-control-regex
  return /[^\x20-\x7E\t\n\r]/.test(text)
}

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

/** Injectable JXA executor — tests swap in a fake to lock script contents. */
export type JxaRunner = (script: string, timeoutMs?: number) => Promise<string>

/**
 * Resident JXA REPL: reads the script-host line protocol from stdin, evals
 * each request in a fresh function scope (scripts are self-contained, their
 * `const`/`function` declarations must not collide across requests) and
 * replies with the last-expression value — same semantics as one-shot
 * `osascript -e`. Keeping the process alive reuses the System Events
 * connection, which is ~0.6s of handshake per one-shot invocation.
 */
const JXA_REPL_BOOTSTRAP = `
ObjC.import('Foundation');
const __stdin = $.NSFileHandle.fileHandleWithStandardInput;
const __stdout = $.NSFileHandle.fileHandleWithStandardOutput;
function __reply(obj) {
  const line = ${JSON.stringify(SENTINEL)} + JSON.stringify(obj) + '\\n';
  __stdout.writeData($(line).dataUsingEncoding($.NSUTF8StringEncoding));
}
let __buf = '';
while (true) {
  const data = __stdin.availableData;
  if (ObjC.unwrap(data.length) === 0) break;
  __buf += ObjC.unwrap($.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding)) || '';
  let nl;
  while ((nl = __buf.indexOf('\\n')) !== -1) {
    const line = __buf.slice(0, nl).trim();
    __buf = __buf.slice(nl + 1);
    if (!line) continue;
    let req = null;
    try { req = JSON.parse(line); } catch (e) { continue; }
    try {
      const codeData = $.NSData.alloc.initWithBase64EncodedStringOptions(req.b64, 0);
      const code = ObjC.unwrap($.NSString.alloc.initWithDataEncoding(codeData, $.NSUTF8StringEncoding));
      const out = (function () { return eval(code); })();
      __reply({ id: req.id, ok: true, out: (out === undefined || out === null) ? '' : String(out) });
    } catch (e) {
      __reply({ id: req.id, ok: false, err: String((e && e.message) ? e.message : e) });
    }
  }
}
`

let sharedJxaHost: ScriptHost | null = null

function getJxaHost(): ScriptHost | null {
  if (!hostEnabled()) return null
  if (!sharedJxaHost) {
    sharedJxaHost = createScriptHost({
      command: 'osascript',
      args: ['-l', 'JavaScript', '-e', JXA_REPL_BOOTSTRAP],
    })
  }
  return sharedJxaHost
}

/** Test hook: drop the shared host so the next call respawns it. */
export function resetJxaHostForTests(): void {
  sharedJxaHost?.dispose()
  sharedJxaHost = null
}

async function runJxa(script: string, timeoutMs = OSASCRIPT_TIMEOUT_MS): Promise<string> {
  const host = getJxaHost()
  if (host && host.available()) {
    try {
      return await host.run(script, timeoutMs)
    } catch (err) {
      // Only fall back when the host never ran the script. A timeout/crash
      // mid-run may have partially executed a mutating action — re-running
      // it via execFile would double-fire clicks/keystrokes.
      if (!(err instanceof HostUnavailableError)) throw err
    }
  }
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

/**
 * Best-effort accessibility enablement before walking a tree. Chromium only
 * exposes its render tree to clients it believes are assistive tech
 * (AXEnhancedUserInterface), Electron gates it behind AXManualAccessibility.
 * Without this, a Chrome snapshot shows the toolbar but zero web content
 * (verified on this machine: 77 nodes, no AXWebArea). Setting the attributes
 * is idempotent, silently ignored by apps that don't care, and is the same
 * mechanism VoiceOver / yabai use. Expects `proc` in scope.
 */
const AX_ENABLE = `
  try { proc.attributes.byName('AXEnhancedUserInterface').value = true; } catch (e) {}
  try { proc.attributes.byName('AXManualAccessibility').value = true; } catch (e) {}
`

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

async function windowCenter(app: string, jxa: JxaRunner): Promise<{ x: number; y: number } | null> {
  const script = `
    const se = Application('System Events');
    const proc = se.processes.byName(${jxaString(app)});
    const win = proc.windows[0];
    const pos = win.position(); const size = win.size();
    JSON.stringify({ x: pos[0] + size[0] / 2, y: pos[1] + size[1] / 2 });
  `
  try {
    return JSON.parse((await jxa(script)).trim())
  } catch {
    return null
  }
}

/**
 * Clipboard-paste input path, shared by pasteText and non-ASCII type().
 * Overwrites the clipboard (documented tool behavior for paste_text).
 */
async function pasteViaClipboard(app: string, text: string, jxa: JxaRunner): Promise<void> {
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
  await jxa(script)
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

async function captureWindow(app: string, jxa: JxaRunner): Promise<{ png: Buffer | null; visionPng: Buffer | null }> {
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
    const out = (await jxa(boundsScript)).trim()
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

/** Real macOS driver. Pass a runner to bypass the resident host (tests). */
export function createMacosDriver(runner?: JxaRunner): ComputerUseDriver {
  const jxa: JxaRunner = runner ?? runJxa
  return {
    async listApps(): Promise<AppInfo[]> {
      const script = `
        const se = Application('System Events');
        const procs = se.applicationProcesses.whose({ visible: true })();
        const out = procs.map(p => ({ name: p.name(), frontmost: p.frontmost() }));
        JSON.stringify(out);
      `
      const raw = (await jxa(script)).trim()
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
      //
      // Apple Events dominate the walk cost, so properties are read in BATCH
      // per parent: el.uiElements.role() fetches every child's role in ONE
      // event (measured 51ms for a 4-child batch vs ~25ms per single read).
      // Per-node reads made Chrome trees time out (>45s); batching brings the
      // same tree to seconds. Two pruning cuts on top: NO_DESCEND roles keep
      // the node but skip the subtree (ruler ticks / scrollbar internals are
      // noise), and container roles discard the value (uninformative).
      //
      // The walk also carries an IN-SCRIPT deadline (WALK_BUDGET_MS): deep
      // Electron trees (QQ NT ≈ 526 nodes of single-child group chains) blow
      // past any external timeout, and an osascript kill returns NOTHING.
      // Self-terminating returns the partial tree with truncated=true — a
      // partial view with valid refs beats total blindness.
      const walkScript = `
        const se = Application('System Events');
        const proc = se.processes.byName(${jxaString(app)});
        ${AX_ENABLE}
        const MAX = ${MAX_TREE_NODES};
        const DEADLINE = Date.now() + ${WALK_BUDGET_MS};
        const NO_DESCEND = { AXRuler: 1, AXScrollBar: 1, AXValueIndicator: 1, AXMenuBar: 1 };
        const SKIP_VALUE = { AXWindow: 1, AXGroup: 1, AXScrollArea: 1, AXSplitGroup: 1, AXToolbar: 1, AXList: 1, AXOutline: 1, AXTable: 1, AXSheet: 1, AXDrawer: 1, AXWebArea: 1 };
        const rows = [];
        let ref = 0;
        let truncated = false;
        function budgetLeft() {
          if (rows.length >= MAX || Date.now() > DEADLINE) { truncated = true; return false; }
          return true;
        }
        function batch(fn) { try { const v = fn(); return Array.isArray(v) ? v : null; } catch (e) { return null; } }
        function push(role, title, value, pos, depth, path) {
          if (!(role || title || value)) return;
          ref++;
          rows.push({ ref, depth, role, title, value, pos, path });
        }
        function visitChildren(el, depth, basePath) {
          if (!budgetLeft()) return;
          let kids = [];
          try { kids = el.uiElements(); } catch (e) {}
          if (kids.length === 0) return;
          const roles = batch(() => el.uiElements.role());
          const titles = batch(() => el.uiElements.title());
          const descs = batch(() => el.uiElements.description());
          const values = batch(() => el.uiElements.value());
          const positions = batch(() => el.uiElements.position());
          for (let i = 0; i < kids.length; i++) {
            if (!budgetLeft()) break;
            const role = (roles && roles[i]) || '';
            const title = (titles && titles[i]) || (descs && descs[i]) || '';
            let value = '';
            if (!(role in SKIP_VALUE) && values && values[i] !== null && values[i] !== undefined) {
              value = String(values[i]);
            }
            let pos = null;
            const p = positions && positions[i];
            if (p && p.length === 2) pos = { x: p[0], y: p[1] };
            const path = basePath.concat(i);
            push(role, title, value, pos, depth, path);
            if (!(role in NO_DESCEND)) visitChildren(kids[i], depth + 1, path);
          }
        }
        let windows = [];
        try { windows = proc.windows(); } catch (e) {}
        for (let i = 0; i < windows.length; i++) {
          if (!budgetLeft()) break;
          const el = windows[i];
          let role = '', title = '', pos = null;
          try { role = el.role(); } catch (e) {}
          try { title = el.title() || el.description() || ''; } catch (e) {}
          try { const p = el.position(); pos = { x: p[0], y: p[1] }; } catch (e) {}
          push(role, title, '', pos, 0, [i]);
          visitChildren(el, 1, [i]);
        }
        let menus = [];
        try { menus = proc.menuBars[0].menuBarItems.name(); } catch (e) {}
        JSON.stringify({ rows, menus, truncated });
      `
      type WalkRow = { ref: number; depth: number; role: string; title: string; value: string; pos: { x: number; y: number } | null; path: number[] }
      const walkTree = async (): Promise<{ rows: WalkRow[]; menus: string[]; truncated: boolean }> => {
        const raw = (await jxa(walkScript, SNAPSHOT_TIMEOUT_MS)).trim()
        try {
          const parsed = JSON.parse(raw) as { rows?: WalkRow[]; menus?: string[]; truncated?: boolean }
          return {
            rows: Array.isArray(parsed.rows) ? parsed.rows : [],
            menus: Array.isArray(parsed.menus) ? parsed.menus : [],
            truncated: parsed.truncated === true,
          }
        } catch {
          return { rows: [], menus: [], truncated: false }
        }
      }

      let walk = await walkTree()
      // Electron skeleton-tree warmup: renderers populate the AX tree
      // ASYNCHRONOUSLY after AXManualAccessibility is first set (QQ: 17 nodes
      // at t=0 → 526 nodes a few seconds later). A tiny non-truncated first
      // walk right after enablement is indistinguishable from a genuinely
      // tiny UI, so wait once and re-walk — keep whichever saw more. Real
      // small UIs pay one ~2.5s delay + a cheap re-walk; blind-by-default
      // Electron apps become visible.
      if (!walk.truncated && walk.rows.length < SPARSE_TREE_RETRY_THRESHOLD) {
        await new Promise((r) => setTimeout(r, SPARSE_TREE_RETRY_DELAY_MS))
        const second = await walkTree()
        if (second.rows.length > walk.rows.length) walk = second
      }
      const { rows, menus, truncated } = walk
      // Localized menu names up front so menu_select works first try — Chinese
      // systems have 文件, not File. Stable per app: doesn't churn the
      // feedback diff or the snapshot dedup.
      const menuLine = menus.length > 0 ? `Menu bar: ${menus.join(' | ')}\n` : ''
      const body = rows
        .map((r) => {
          const indent = '  '.repeat(Math.min(r.depth, 8))
          const label = r.title ? ` "${r.title}"` : ''
          const val = r.value ? ` = ${r.value}` : ''
          const at = r.pos ? ` @(${Math.round(r.pos.x)},${Math.round(r.pos.y)})` : ''
          return `${indent}[${r.ref}] ${r.role || 'element'}${label}${val}${at}`
        })
        .join('\n')
      const truncNote = truncated
        ? '\n(partial tree: walk budget exhausted — refs above are valid; use find(query)/wait_for for content deeper in the UI)'
        : ''
      const tree = body ? `${menuLine}${body}${truncNote}` : menuLine.trimEnd()
      const refs: SnapshotRef[] = rows.map((r) => ({
        ref: r.ref,
        path: r.path,
        role: r.role,
        title: r.title,
        pos: r.pos,
      }))
      const shot = opts?.screenshot === false
        ? { png: null, visionPng: null }
        : await captureWindow(app, jxa)
      return {
        tree: tree || '(no accessible elements found)',
        refs,
        screenshotPng: shot.png,
        visionPng: shot.visionPng,
        truncated,
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
          await jxa(script)
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
        await jxa(script)
        return
      }
      // Raw coordinate click via CGEvent (System Events' `click at` is flaky).
      const script = `
        ${CG_PRELUDE}
        cgClick(${Math.round(target.x)}, ${Math.round(target.y)}, ${button === 'right'}, ${count});
        'ok';
      `
      await jxa(script)
    },

    async locate(app: string, target: { path: number[]; role?: string; title?: string }): Promise<{ x: number; y: number }> {
      const script = `
        const se = Application('System Events');
        const proc = se.processes.byName(${jxaString(app)});
        ${AX_ENABLE}
        ${pathConsts(target)}
        ${RESOLVE_BY_PATH}
        ${ELEMENT_CENTER}
        JSON.stringify({ x: Math.round(cx), y: Math.round(cy) });
      `
      const raw = (await jxa(script)).trim()
      return JSON.parse(raw) as { x: number; y: number }
    },

    async scroll(app: string, opts: ScrollOptions): Promise<void> {
      const amount = Math.max(1, Math.min(50, Math.round(opts.amount ?? 5)))
      // CGEvent scroll: wheel1 = vertical (positive scrolls up), wheel2 = horizontal
      // (positive scrolls left). Position the cursor over the target first —
      // scroll events are delivered to the view under the cursor.
      const at = opts.at ?? (await windowCenter(app, jxa))
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
      await jxa(script)
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
      await jxa(script)
    },

    async type(app: string, text: string): Promise<void> {
      // Non-ASCII text (CJK/emoji/accents) auto-routes through clipboard
      // paste: `keystroke` feeds an active IME's composition buffer instead
      // of the field (Chinese IME turns "你好" into pinyin candidates), while
      // Cmd+V bypasses the IME entirely. ASCII keeps the keystroke path
      // (no clipboard side effect).
      if (needsClipboardInput(text)) {
        await pasteViaClipboard(app, text, jxa)
        return
      }
      const script = `
        const se = Application('System Events');
        se.processes.byName(${jxaString(app)}).frontmost = true;
        se.keystroke(${jxaString(text)});
        'ok';
      `
      await jxa(script)
    },

    async setValue(app: string, target: { path: number[]; role?: string; title?: string }, text: string): Promise<void> {
      // Direct AXValue write — no focus juggling, no keystroke simulation.
      // Read-back verifies the write took: controls that silently ignore
      // AXValue writes must fail loudly so the tool can suggest type/paste.
      const script = `
        const se = Application('System Events');
        const proc = se.processes.byName(${jxaString(app)});
        ${AX_ENABLE}
        ${pathConsts(target)}
        ${RESOLVE_BY_PATH}
        const TEXT = ${jxaString(text)};
        try {
          found.value = TEXT;
        } catch (e) {
          throw new Error('element does not accept direct value writes — click it and use type/paste_text instead');
        }
        let v = '';
        try { v = String(found.value() || ''); } catch (e) {}
        if (v !== TEXT) {
          throw new Error('value write did not stick (control may be read-only) — click it and use type/paste_text instead');
        }
        'ok';
      `
      await jxa(script)
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
      await jxa(`const se = Application('System Events'); ${focus} ${action} 'ok';`)
    },

    async focusApp(app: string): Promise<void> {
      const script = `
        const app = Application(${jxaString(app)});
        app.activate();
        'ok';
      `
      await jxa(script)
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
      await jxa(script, 20_000)
    },

    async menuSelect(app: string, path: string[]): Promise<void> {
      if (path.length === 0) throw new Error('menu_select requires a non-empty menu path')
      // Walk the menu bar: menuBarItems.byName(top) → nested menus[0].menuItems
      // per segment, click the final item. On a missing segment, throw with the
      // names available at that level so the model can self-correct.
      const script = `
        const se = Application('System Events');
        const proc = se.processes.byName(${jxaString(app)});
        ${AX_ENABLE}
        proc.frontmost = true;
        delay(0.1);
        const PATH = ${JSON.stringify(path)};
        let container = proc.menuBars[0].menuBarItems;
        let el = null;
        for (let i = 0; i < PATH.length; i++) {
          let names = [];
          try { names = container.name(); } catch (e) {}
          if (names.length === 0) {
            throw new Error('cannot read the menu bar — likely missing the Accessibility permission (System Settings > Privacy & Security > Accessibility)');
          }
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
      await jxa(script)
    },

    async pasteText(app: string, text: string): Promise<void> {
      await pasteViaClipboard(app, text, jxa)
    },

    async checkPermissions(): Promise<PermissionStatus> {
      // Accessibility: must probe an actual AX attribute read. Merely listing
      // processes (se.processes.length) succeeds with only the Automation
      // permission and false-positives when Accessibility is missing — reading
      // a process's windows is the real discriminator (throws "not allowed
      // assistive access" without the Accessibility grant).
      let accessibility = false
      try {
        await jxa(`const se = Application('System Events'); se.processes.byName('Finder').windows(); 'ok';`, 5_000)
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
