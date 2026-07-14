/**
 * computer_use — desktop GUI automation tool (Codex Computer Use parity).
 *
 * Lets the agent see and operate graphical apps when CLI / structured
 * integrations aren't enough: inspect a desktop app's accessibility tree,
 * click/scroll/drag elements, type, send key combos, focus apps.
 *
 * Security model (mirrors the browser tool's fail-closed posture):
 *  - Per-app approval: any action targeting an app WITHOUT an "always allow"
 *    grant requires explicit human approval (requiresApproval → true).
 *  - Dual-channel perception: the accessibility TREE is returned to the model
 *    (text); the SCREENSHOT is persisted as a viewable artifact for the user.
 *    When the active model supports vision, the pipeline may also attach a
 *    downsampled screenshot from `ToolResult.images` (the tool itself is
 *    model-agnostic — it always fills the channel and lets the pipeline decide).
 *  - Secret hygiene: secure text fields and secret-looking values are masked
 *    in the model-facing tree.
 *  - macOS (osascript/AX) and Windows (PowerShell/UIA) only; disabled elsewhere.
 *
 * Element targeting: snapshot refs are backed by AX child-index paths cached
 * per `sessionId:app` (small LRU). Clicks resolve the exact path with a
 * role/title identity check — a changed UI produces a "stale snapshot" error
 * instead of a mis-click on whatever now sits at the old ordinal position.
 */

import { writeFile } from 'node:fs/promises'
import type { Tool, ToolCallParams, ToolResult } from '../types.js'
import {
  type ComputerUseDriver,
  type ComputerUseDriverFactory,
  type ClickTarget,
  type SnapshotRef,
} from './macos-driver.js'
import { createPlatformDriver, isComputerUsePlatform } from './platform-driver.js'
import { diffTreeSummary } from './tree-diff.js'
import { isAppGranted } from './app-grants.js'
import { createCdpDriver, type CdpBrowserDriver } from './cdp/driver.js'

export type ComputerUseAction =
  | 'list_apps'
  | 'snapshot'
  | 'find'
  | 'wait_for'
  | 'click'
  | 'double_click'
  | 'right_click'
  | 'scroll'
  | 'drag'
  | 'type'
  | 'set_value'
  | 'key'
  | 'wait'
  | 'focus_app'
  | 'launch_app'
  | 'menu_select'
  | 'paste_text'
  | 'check_permissions'
  | 'navigate'
  | 'read_page'
  | 'js_eval'
  | 'tabs'
  | 'browser_adopt'

export interface ComputerUseToolOptions {
  /** Builds the platform driver. Defaults to the native driver for the host
   *  platform (macOS osascript / Windows PowerShell+UIA). */
  driverFactory?: ComputerUseDriverFactory
  /** Whether the tool is registered/visible. Defaults to darwin/win32 only. */
  enabled?: boolean
  /** Pro feature gate: when false, the tool is disabled regardless of platform.
   *  Defaults to false; bootstrap sets it from config.pro.features.computerUse. */
  proEnabled?: boolean
  /** App grant lookup (injectable for tests). Defaults to persisted grants. */
  isAppGranted?: (app: string) => boolean
  /** Platform override (tests). Defaults to process.platform. */
  platform?: NodeJS.Platform
  /** Sleep implementation for the wait action (injectable for tests). */
  sleep?: (ms: number) => Promise<void>
  /** Post-action feedback loop (tree re-snapshot + diff). Defaults to
   *  RIVET_CU_FEEDBACK !== '0'. */
  feedback?: boolean
  /** CDP browser backend toggle. Defaults to RIVET_CU_CDP !== '0'. */
  cdpEnabled?: boolean
  /** Builds the CDP browser driver (injectable for tests). */
  cdpDriverFactory?: () => CdpBrowserDriver
}

/** Mask secret-looking values in accessibility text (tokens/keys/passwords). */
const SECRET_RE = /\b([A-Za-z0-9_-]{24,}|sk-[A-Za-z0-9]+|ghp_[A-Za-z0-9]+|xox[baprs]-[A-Za-z0-9-]+)\b/g

function redactTree(tree: string): string {
  return tree
    // Secure text fields expose masked bullets already, but AXValue can leak —
    // blank any value attached to a secure field role.
    .replace(/(AXSecureTextField[^\n]*=)\s*\S.*/g, '$1 ***')
    .replace(SECRET_RE, '***')
}

function actionRequiresApproval(action: ComputerUseAction): boolean {
  // check_permissions is a pure local capability probe; wait is a plain sleep.
  return action !== 'check_permissions' && action !== 'wait'
}

/** Chrome-family app names are eligible for the CDP backend. */
function isBrowserApp(app: string): boolean {
  return /(chrome|chromium|edge|brave)/i.test(app)
}

/** Actions that only exist on the CDP browser backend. */
const BROWSER_ONLY_ACTIONS: ReadonlySet<ComputerUseAction> = new Set([
  'navigate', 'read_page', 'js_eval', 'tabs', 'browser_adopt',
] as ComputerUseAction[])

/** Arbitrary-code / endpoint-takeover surface — approval can NEVER be skipped
 *  by a per-app grant (mirrors browser.ts's fail-closed posture). */
const ALWAYS_APPROVE_ACTIONS: ReadonlySet<ComputerUseAction> = new Set([
  'js_eval', 'browser_adopt',
] as ComputerUseAction[])

/** Max duration for the wait action (ms). */
const WAIT_CAP_MS = 5_000

/** UI settle delay before the post-action feedback snapshot (ms). */
const FEEDBACK_SETTLE_MS = 400

/** wait_for polling cadence / default deadline / hard cap (ms). */
const WAIT_FOR_POLL_MS = 700
const WAIT_FOR_DEFAULT_MS = 5_000
const WAIT_FOR_CAP_MS = 15_000

/** Max matched lines a find/wait_for result will carry. */
const FIND_MAX_LINES = 40

interface SnapshotCacheEntry {
  refs: Map<number, SnapshotRef>
  /** Redacted tree text of the last snapshot — dedup baseline. */
  lastTree: string
}

/** Per `sessionId:app` snapshot cache capacity. */
const SNAPSHOT_CACHE_CAP = 20

export function createComputerUseTool(options: ComputerUseToolOptions = {}): Tool {
  const platform = options.platform ?? process.platform
  const isSupported = isComputerUsePlatform(platform)
  const proEnabled = options.proEnabled ?? false
  const enabled = (options.enabled ?? isSupported) && proEnabled
  const driverFactory = options.driverFactory ?? (() => createPlatformDriver(platform))
  const grantLookup = options.isAppGranted ?? ((app: string) => isAppGranted(app))
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const feedbackEnabled = options.feedback ?? process.env.RIVET_CU_FEEDBACK !== '0'
  const cdpEnabled = options.cdpEnabled ?? process.env.RIVET_CU_CDP !== '0'

  // CDP browser driver — one instance per tool (holds the browser connection).
  let cdpDriver: CdpBrowserDriver | null = null
  function getCdpDriver(): CdpBrowserDriver {
    if (!cdpDriver) cdpDriver = (options.cdpDriverFactory ?? createCdpDriver)()
    return cdpDriver
  }

  /**
   * Hybrid routing: browser-family targets ride the CDP backend when a
   * DevTools session is available (sub-second snapshots, occlusion-proof
   * input); anything else — and CDP-connection failures — takes the native
   * AX/UIA driver. menu_select always goes native (the browser's menu BAR
   * is an OS object CDP can't see). launch_app may spawn the dedicated
   * automation-profile browser; other actions never launch.
   */
  async function routeDriver(nativeDriver: ComputerUseDriver, app: string, action: ComputerUseAction): Promise<ComputerUseDriver> {
    if (!cdpEnabled || !app || !isBrowserApp(app) || action === 'menu_select') return nativeDriver
    const cdp = getCdpDriver()
    if (await cdp.available(action === 'launch_app')) return cdp
    return nativeDriver
  }

  // Snapshot ref cache — closure-scoped (per tool instance) LRU. Map iteration
  // order is insertion order; delete+set refreshes recency.
  const snapshotCache = new Map<string, SnapshotCacheEntry>()

  function cacheKey(params: ToolCallParams, app: string): string {
    return `${params.sessionId ?? 'default'}:${app.toLowerCase()}`
  }

  function cacheGet(key: string): SnapshotCacheEntry | undefined {
    const entry = snapshotCache.get(key)
    if (entry) {
      snapshotCache.delete(key)
      snapshotCache.set(key, entry)
    }
    return entry
  }

  function cacheSet(key: string, entry: SnapshotCacheEntry): void {
    snapshotCache.delete(key)
    snapshotCache.set(key, entry)
    while (snapshotCache.size > SNAPSHOT_CACHE_CAP) {
      const oldest = snapshotCache.keys().next().value
      if (oldest === undefined) break
      snapshotCache.delete(oldest)
    }
  }

  function targetApp(input: Record<string, unknown>): string {
    const app = input.app
    return typeof app === 'string' ? app.trim() : ''
  }

  /** Resolve a ref number to its cached AX-path target, or a model-facing error. */
  function resolveRef(params: ToolCallParams, app: string, ref: number):
    | { ok: true; target: { path: number[]; role?: string; title?: string }; sr: SnapshotRef }
    | { ok: false; error: string } {
    const entry = cacheGet(cacheKey(params, app))
    if (!entry) {
      return { ok: false, error: `No snapshot cached for ${app} in this session — take a snapshot first, then click by ref.` }
    }
    const sr = entry.refs.get(ref)
    if (!sr) {
      return { ok: false, error: `ref ${ref} is not in the latest ${app} snapshot — re-snapshot and use a current ref.` }
    }
    return { ok: true, target: { path: sr.path, role: sr.role || undefined, title: sr.title || undefined }, sr }
  }

  /** Resolve a drag/scroll endpoint: ref (via cache + live locate) or raw coords. */
  async function resolvePoint(
    driver: ComputerUseDriver,
    params: ToolCallParams,
    app: string,
    refKey: string,
    xKey: string,
    yKey: string,
  ): Promise<{ ok: true; point: { x: number; y: number } } | { ok: false; error: string }> {
    const ref = params.input[refKey]
    const x = params.input[xKey]
    const y = params.input[yKey]
    if (typeof ref === 'number') {
      const resolved = resolveRef(params, app, ref)
      if (!resolved.ok) return resolved
      try {
        const point = await driver.locate(app, resolved.target)
        return { ok: true, point }
      } catch (err) {
        if (isStaleError(err)) {
          // locate is read-only — safe to heal and retry once.
          const healed = await healStaleRef(driver, params, app, resolved.sr)
          if (healed.ok) {
            try {
              const point = await driver.locate(app, healed.target)
              return { ok: true, point }
            } catch (retryErr) {
              return { ok: false, error: `Cannot locate ref ${ref}: ${(retryErr as Error).message}` }
            }
          }
          return { ok: false, error: `Cannot locate ref ${ref}: ${healed.error}` }
        }
        return { ok: false, error: `Cannot locate ref ${ref}: ${(err as Error).message}` }
      }
    }
    if (typeof x === 'number' && typeof y === 'number') {
      return { ok: true, point: { x, y } }
    }
    return { ok: false, error: `Provide either "${refKey}" (snapshot ref) or both "${xKey}" and "${yKey}".` }
  }

  /**
   * Post-action feedback loop: after a mutating action succeeds, wait for the
   * UI to settle, take a tree-only snapshot, report how the UI changed, and
   * refresh the ref cache so diff lines carry immediately-usable refs.
   * Best-effort by design — a feedback failure never taints the action result.
   */
  async function withFeedback(
    driver: ComputerUseDriver,
    params: ToolCallParams,
    app: string,
    result: ToolResult,
  ): Promise<ToolResult> {
    if (!feedbackEnabled || result.isError) return result
    try {
      await sleep(FEEDBACK_SETTLE_MS)
      const snap = await driver.snapshot(app, { screenshot: false })
      const tree = redactTree(snap.tree)
      const key = cacheKey(params, app)
      const previous = cacheGet(key)
      cacheSet(key, {
        refs: new Map(snap.refs.map((r) => [r.ref, r])),
        lastTree: tree,
      })
      if (!previous) {
        // No baseline to diff against (e.g. coordinate click without a prior
        // snapshot) — cache the state and say so without dumping the tree.
        return { ...result, content: `${result.content}\nPost-action UI state cached (${snap.refs.length} elements) — snapshot to see the tree.` }
      }
      const diff = diffTreeSummary(previous.lastTree, tree)
      const note = diff.changed
        ? `${diff.summary}\n(refs refreshed — refs from before this action are stale; use refs from the diff or re-snapshot.)`
        : diff.summary
      return { ...result, content: `${result.content}\n${note}` }
    } catch {
      return result
    }
  }

  /**
   * Filter tree lines to those matching `query` (case-insensitive, matches
   * the rendered line: role, title and value), each with its ancestor chain
   * for orientation. Line order and indentation are preserved.
   */
  function filterTreeLines(tree: string, query: string): { matched: number; text: string } {
    const lines = tree.split('\n')
    const needle = query.toLowerCase()
    const keep = new Set<number>()
    let matched = 0
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? ''
      if (!line.toLowerCase().includes(needle)) continue
      matched++
      if (matched > FIND_MAX_LINES) break
      keep.add(i)
      // Walk the ancestor chain: nearest previous lines with strictly
      // shallower indentation.
      let indent = line.length - line.trimStart().length
      for (let j = i - 1; j >= 0 && indent > 0; j--) {
        const prev = lines[j] ?? ''
        const prevIndent = prev.length - prev.trimStart().length
        if (prev.trim() && prevIndent < indent) {
          keep.add(j)
          indent = prevIndent
        }
      }
    }
    const text = lines.filter((_, i) => keep.has(i)).join('\n')
    return { matched, text }
  }

  /** Fallback orientation when a query matches nothing: menu bar + windows. */
  function treeOutline(tree: string): string {
    const lines = tree.split('\n')
    const outline = lines.filter((l) => l.startsWith('Menu bar:') || (l.trim() !== '' && !l.startsWith(' ')))
    return outline.slice(0, 12).join('\n')
  }

  /** Tree-only snapshot + cache refresh; shared by find / wait_for / healing. */
  async function snapshotIntoCache(
    driver: ComputerUseDriver,
    params: ToolCallParams,
    app: string,
  ): Promise<{ tree: string; refs: SnapshotRef[] }> {
    const snap = await driver.snapshot(app, { screenshot: false })
    const tree = redactTree(snap.tree)
    cacheSet(cacheKey(params, app), {
      refs: new Map(snap.refs.map((r) => [r.ref, r])),
      lastTree: tree,
    })
    return { tree, refs: snap.refs }
  }

  function describeElement(sr: SnapshotRef): string {
    return `${sr.role || 'element'}${sr.title ? ` "${sr.title}"` : ''}`
  }

  /**
   * When an action fails and the app name doesn't exactly match a visible
   * app, suggest the closest one ("chrome" → "Google Chrome"). Suggestion
   * only — approval grants are keyed by app name, so we never silently
   * retarget. Best-effort: listApps failure just skips the hint.
   */
  async function appNameHint(driver: ComputerUseDriver, app: string): Promise<string> {
    const canon = (s: string) => s.toLowerCase().replace(/\.(exe|app)$/i, '').replace(/\s+/g, '')
    try {
      const apps = await driver.listApps()
      if (apps.length === 0) return ''
      const target = canon(app)
      if (apps.some((a) => canon(a.name) === target)) return ''
      const fuzzy = apps.filter((a) => canon(a.name).includes(target) || target.includes(canon(a.name)))
      const names = apps.map((a) => a.name).join(', ')
      const first = fuzzy[0]
      if (fuzzy.length > 0 && first) {
        return `\nDid you mean "${first.name}"? Visible apps: ${names}`
      }
      return `\nNo visible app matches "${app}". Visible apps: ${names}`
    } catch {
      return ''
    }
  }

  /**
   * Stale-ref self-heal: the click/locate never executed (path identity check
   * rejected it), so retrying is safe. Re-snapshot tree-only, refresh the ref
   * cache, and — when exactly ONE element matches the stale target's
   * role+title — hand back its fresh path so the caller can retry once.
   * Ambiguity fails closed: with 0 or 2+ candidates we won't guess.
   */
  async function healStaleRef(
    driver: ComputerUseDriver,
    params: ToolCallParams,
    app: string,
    sr: SnapshotRef,
  ): Promise<
    | { ok: true; target: { path: number[]; role?: string; title?: string }; note: string }
    | { ok: false; error: string }
  > {
    const { refs } = await snapshotIntoCache(driver, params, app)
    const matches = refs.filter((r) => r.role === sr.role && r.title === sr.title)
    const match = matches[0]
    if (matches.length === 1 && match) {
      return {
        ok: true,
        target: { path: match.path, role: match.role || undefined, title: match.title || undefined },
        note: ` (ref was stale — auto-matched the same ${describeElement(sr)} as ref ${match.ref} in a fresh snapshot and retried)`,
      }
    }
    const why = matches.length === 0 ? 'no element matches' : `${matches.length} elements match`
    return {
      ok: false,
      error: `stale ref could not be auto-healed: ${why} ${describeElement(sr)} now. Ref cache refreshed from a fresh snapshot — use find/snapshot and target a current ref.`,
    }
  }

  function isStaleError(err: unknown): boolean {
    return err instanceof Error && /stale snapshot/i.test(err.message)
  }

  /** Browser-only actions — served exclusively by the CDP backend. */
  async function executeBrowserAction(
    cdp: CdpBrowserDriver,
    params: ToolCallParams,
    action: ComputerUseAction,
    app: string,
  ): Promise<ToolResult> {
    if (action === 'browser_adopt') {
      const endpoint = params.input.endpoint
      if (typeof endpoint !== 'string' || !endpoint.trim()) {
        return { content: 'browser_adopt requires "endpoint" (e.g. "localhost:9222" — a Chrome started with --remote-debugging-port).', isError: true }
      }
      return { content: await cdp.adopt(endpoint.trim()) }
    }
    if (!app) {
      return { content: `${action} requires "app" (the browser to operate, e.g. "Google Chrome").`, isError: true }
    }
    switch (action) {
      case 'navigate': {
        const url = params.input.url
        if (typeof url !== 'string' || !url.trim()) {
          return { content: 'navigate requires "url" (a URL, or "back" / "forward" / "reload").', isError: true }
        }
        const note = await cdp.navigate(url.trim())
        return await withFeedback(cdp, params, app, { content: note })
      }
      case 'read_page':
        return { content: await cdp.readPage() }
      case 'js_eval': {
        const expression = params.input.expression
        if (typeof expression !== 'string' || !expression.trim()) {
          return { content: 'js_eval requires "expression" (JavaScript to evaluate in the page).', isError: true }
        }
        const result = await cdp.evalJs(expression)
        return await withFeedback(cdp, params, app, { content: `js_eval result:\n${result}` })
      }
      case 'tabs': {
        const rawOp = params.input.tab_op ?? 'list'
        if (rawOp !== 'list' && rawOp !== 'activate' && rawOp !== 'new' && rawOp !== 'close') {
          return { content: 'tabs "tab_op" must be one of: list, activate, new, close.', isError: true }
        }
        const index = typeof params.input.tab === 'number' ? params.input.tab : undefined
        const url = typeof params.input.url === 'string' ? params.input.url : undefined
        const note = await cdp.tabs(rawOp, { index, url })
        // list is read-only; mutations get the standard feedback loop.
        return rawOp === 'list' ? { content: note } : await withFeedback(cdp, params, app, { content: note })
      }
      default:
        return { content: `Unknown browser action: ${action}`, isError: true }
    }
  }

  async function executeClick(
    driver: ComputerUseDriver,
    params: ToolCallParams,
    app: string,
    button: 'left' | 'right',
    count: 1 | 2,
  ): Promise<ToolResult> {
    const ref = params.input.ref
    const x = params.input.x
    const y = params.input.y
    let target: ClickTarget
    let where: string
    let sr: SnapshotRef | null = null
    if (typeof ref === 'number') {
      const resolved = resolveRef(params, app, ref)
      if (!resolved.ok) return { content: resolved.error, isError: true }
      target = resolved.target
      sr = resolved.sr
      const label = resolved.sr.title ? ` "${resolved.sr.title}"` : ''
      where = `ref ${ref}${label}`
    } else if (typeof x === 'number' && typeof y === 'number') {
      target = { x, y }
      where = `(${x}, ${y})`
    } else {
      return { content: 'click requires "ref" (from a snapshot) or both "x" and "y".', isError: true }
    }
    let healedNote = ''
    try {
      await driver.click(app, target, { button, count })
    } catch (err) {
      if (!sr || !isStaleError(err)) throw err
      const healed = await healStaleRef(driver, params, app, sr)
      if (!healed.ok) return { content: healed.error, isError: true }
      await driver.click(app, healed.target, { button, count })
      healedNote = healed.note
    }
    const verb = count === 2 ? 'Double-clicked' : button === 'right' ? 'Right-clicked' : 'Clicked'
    return { content: `${verb} ${where} in ${app}.${healedNote}` }
  }

  return {
    definition: {
      name: 'computer_use',
      description: `Operate desktop graphical apps (macOS and Windows): inspect an app's accessibility tree, click/scroll/drag elements, type text, send key combos, focus apps. Use ONLY when CLI tools, MCP servers, or structured integrations can't do the job (e.g. a native app with no API, a GUI-only setting, or reproducing a UI-only bug) — prefer structured tools whenever available.

Every action on an app requires human approval unless that app is already granted "always allow". Screenshots are saved as viewable artifacts; the accessibility tree (text) is what you reason over. When the active model supports vision, the snapshot screenshot is also attached to the conversation as an image.

Actions:
- check_permissions: report system capability/permission status (no approval).
- list_apps: list visible apps.
- snapshot(app): return the app's numbered accessibility tree + save a screenshot artifact. If the UI has not changed since the last snapshot, returns a short "unchanged" note instead of repeating the tree. Electron apps (QQ, WeChat, VS Code…) populate their tree a few seconds after the first snapshot — the tool warms up and retries automatically; a huge tree may come back marked "partial" (refs are still valid; use find/wait_for for deeper content). NEVER conclude an app is invisible from one sparse snapshot — snapshot again or use find first.
- find(app, query): snapshot but return ONLY tree lines matching the query (role/title/value, case-insensitive) with their ancestor chain. Preferred over snapshot for large UIs (browsers) — same refs, far less output.
- wait_for(app, text, gone?, timeout_ms?): poll the UI until a tree line containing "text" appears (or disappears with gone:true). Returns the matching lines with clickable refs. Use after actions that trigger loads/animations instead of blind wait+snapshot loops.
- click(app, ref|x,y): left-click a snapshot element ref (preferred) or coordinates.
- double_click(app, ref|x,y) / right_click(app, ref|x,y): double / context click.
- scroll(app, direction, amount?, ref|x,y?): scroll the view under the target (default: window center).
- drag(app, from_ref|from_x+from_y, to_ref|to_x+to_y): press-drag-release.
- type(app, text): type text into the focused field (short ASCII text; use paste_text for long text, set_value to write a specific field). Non-ASCII text (Chinese/emoji) automatically routes through clipboard paste — immune to the active input method (IME), but overwrites the clipboard.
- set_value(app, ref, text): write a value directly into a text-like control (text field, search box) — no focus juggling. Errors if the control doesn't accept value writes; fall back to click + type/paste_text.
- key(app, combo): send a key combo like "cmd+s" or "return" (on Windows, cmd maps to Ctrl).
- wait(duration_ms): pause up to 5000ms for animations/loads (no approval). Prefer wait_for when you know what you're waiting for.
- focus_app(app): bring an app to the foreground.
- launch_app(app): start an app that is not running (focuses it if already running).
- menu_select(app, menu_path): pick a menu-bar item by path, e.g. "File > Export > PNG".
- paste_text(app, text): put text on the clipboard and paste it (fast + reliable for long/multiline text; overwrites the clipboard).

Browser fast path: Chrome-family targets (Chrome/Chromium/Edge/Brave) automatically use a DevTools (CDP) backend when available — snapshots are sub-second and clicks/typing work even when the window is occluded. launch_app on a browser starts a dedicated automation profile (sign-ins persist across sessions). Browser-only actions:
- navigate(app, url): go to a URL, or "back" / "forward" / "reload".
- read_page(app): full page text (innerText) — no tree-node cap; use for reading articles/long content.
- js_eval(app, expression): run JavaScript in the page and return the result (always needs approval).
- tabs(app, tab_op, tab?, url?): list/activate/new/close browser tabs (tab is the 1-based index from list).
- browser_adopt(endpoint): attach to a Chrome you started with --remote-debugging-port (always needs approval).

Feedback loop: after each mutating action the tool re-reads the UI and appends how it changed (added/removed elements). When the UI changed, the ref cache is refreshed — refs shown in that diff are immediately clickable, refs from before the action are stale. If a targeted ref went stale, the tool re-snapshots and retries automatically when exactly one element still matches the same role+title; otherwise it refreshes the cache and asks you to re-target.`,
      input_schema: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['check_permissions', 'list_apps', 'snapshot', 'find', 'wait_for', 'click', 'double_click', 'right_click', 'scroll', 'drag', 'type', 'set_value', 'key', 'wait', 'focus_app', 'launch_app', 'menu_select', 'paste_text', 'navigate', 'read_page', 'js_eval', 'tabs', 'browser_adopt'],
            description: 'What to do.',
          },
          app: { type: 'string', description: 'Target app name (required for all actions except list_apps/check_permissions/wait).' },
          ref: { type: 'number', description: 'Snapshot element ref to target (click/scroll/set_value; from the latest snapshot).' },
          x: { type: 'number', description: 'X coordinate (screen pixels) when no ref is given.' },
          y: { type: 'number', description: 'Y coordinate (screen pixels) when no ref is given.' },
          text: { type: 'string', description: 'Text to type (type), paste (paste_text), write (set_value), or wait for in the tree (wait_for).' },
          query: { type: 'string', description: 'Filter string matched against tree lines (find action).' },
          gone: { type: 'boolean', description: 'wait_for: wait for the text to DISAPPEAR instead of appear.' },
          timeout_ms: { type: 'number', description: 'wait_for deadline in ms (default 5000, capped at 15000).' },
          menu_path: { type: 'string', description: 'Menu path separated by ">", e.g. "File > Export > PNG" (menu_select action).' },
          combo: { type: 'string', description: 'Key combo like "cmd+s", "shift+cmd+4", "return" (key action; cmd maps to Ctrl on Windows).' },
          direction: { type: 'string', enum: ['up', 'down', 'left', 'right'], description: 'Scroll direction (scroll action).' },
          amount: { type: 'number', description: 'Scroll magnitude in wheel lines, 1-50 (default 5).' },
          from_ref: { type: 'number', description: 'Drag start: snapshot ref.' },
          from_x: { type: 'number', description: 'Drag start X (when no from_ref).' },
          from_y: { type: 'number', description: 'Drag start Y (when no from_ref).' },
          to_ref: { type: 'number', description: 'Drag end: snapshot ref.' },
          to_x: { type: 'number', description: 'Drag end X (when no to_ref).' },
          to_y: { type: 'number', description: 'Drag end Y (when no to_ref).' },
          duration_ms: { type: 'number', description: 'Wait duration in ms, capped at 5000 (wait action).' },
          url: { type: 'string', description: 'URL to open (navigate / tabs new). navigate also accepts "back", "forward", "reload".' },
          expression: { type: 'string', description: 'JavaScript to evaluate in the page (js_eval action).' },
          tab_op: { type: 'string', enum: ['list', 'activate', 'new', 'close'], description: 'Tab operation (tabs action; default list).' },
          tab: { type: 'number', description: '1-based tab index from tabs list (tabs activate/close).' },
          endpoint: { type: 'string', description: 'DevTools endpoint like "localhost:9222" or an http/ws URL (browser_adopt action).' },
        },
        required: ['action'],
      },
    },

    async execute(params: ToolCallParams): Promise<ToolResult> {
      if (!isSupported) {
        return {
          content: `computer_use is only available on macOS and Windows. This host is ${platform}.`,
          isError: true,
        }
      }
      const action = params.input.action as ComputerUseAction
      const app = targetApp(params.input)

      // wait needs no driver and no app — resolve before driver init.
      if (action === 'wait') {
        const raw = params.input.duration_ms
        const ms = Math.max(0, Math.min(WAIT_CAP_MS, typeof raw === 'number' ? Math.round(raw) : 1_000))
        await sleep(ms)
        return { content: `Waited ${ms}ms.` }
      }

      let driver: ComputerUseDriver
      try {
        driver = driverFactory()
      } catch (err) {
        return { content: `computer_use driver init failed: ${(err as Error).message}`, isError: true }
      }

      try {
        // Browser-only actions require the CDP backend outright — no native
        // fallback exists for navigate/read_page/js_eval/tabs/browser_adopt.
        if (BROWSER_ONLY_ACTIONS.has(action)) {
          if (!cdpEnabled) {
            return { content: `${action} requires the CDP browser backend, which is disabled (RIVET_CU_CDP=0).`, isError: true }
          }
          return await executeBrowserAction(getCdpDriver(), params, action, app)
        }
        // Hybrid routing: browser targets ride CDP when a session is available.
        driver = await routeDriver(driver, app, action)
        switch (action) {
          case 'check_permissions': {
            const perm = await driver.checkPermissions()
            return {
              content:
                `Accessibility: ${perm.accessibility ? 'granted' : 'MISSING'}\n` +
                `Screen Recording: ${perm.screenRecording ? 'granted' : 'MISSING'}\n${perm.detail}`,
            }
          }
          case 'list_apps': {
            const apps = await driver.listApps()
            if (apps.length === 0) return { content: 'No visible apps found.' }
            const lines = apps.map((a) => {
              const title = a.title && a.title !== a.name ? ` — "${a.title}"` : ''
              return `- ${a.name}${title}${a.frontmost ? ' (frontmost)' : ''}`
            })
            return { content: `Visible apps:\n${lines.join('\n')}` }
          }
          case 'snapshot': {
            if (!app) return { content: 'snapshot requires "app".', isError: true }
            const snap = await driver.snapshot(app)
            let artifactId: string | undefined
            if (snap.screenshotPng && params.artifactStore) {
              artifactId = await params.artifactStore.save({
                tool: 'computer_use_screenshot',
                target: `${app}-screenshot.png`,
                rawContent: snap.screenshotPng.toString('base64'),
                summary: `Screenshot of ${app}`,
                sections: [],
              })
              // CLI 可见性：把 PNG 落成真实文件，纯 ANSI 终端用户可直接打开
              //（桌面端仍走 artifact id 内联渲染）。落盘失败不影响 snapshot 结果。
              const rawPath = params.artifactStore.get?.(artifactId)?.rawPath
              if (rawPath) {
                try { await writeFile(rawPath.replace(/\.raw$/, '.png'), snap.screenshotPng) } catch { /* best-effort */ }
              }
            }
            const tree = redactTree(snap.tree)
            const key = cacheKey(params, app)
            const previous = cacheGet(key)
            const unchanged = previous !== undefined && previous.lastTree === tree
            cacheSet(key, {
              refs: new Map(snap.refs.map((r) => [r.ref, r])),
              lastTree: tree,
            })
            const artifactNote = artifactId ? ` (screenshot → artifact ${artifactId})` : ' (screenshot unavailable)'
            if (unchanged) {
              // Dedup: identical tree → short note, no image re-attachment.
              // Existing refs stay valid (same tree ⇒ same paths).
              return { content: `Snapshot of ${app}${artifactNote}: UI unchanged since the last snapshot — previous refs remain valid.` }
            }
            const images = snap.visionPng
              ? [`data:image/png;base64,${snap.visionPng.toString('base64')}`]
              : undefined
            return {
              content: `Accessibility tree for ${app}${artifactNote}:\n\n${tree}`,
              images,
            }
          }
          case 'find': {
            if (!app) return { content: 'find requires "app".', isError: true }
            const query = params.input.query
            if (typeof query !== 'string' || !query.trim()) {
              return { content: 'find requires a non-empty "query" to match against roles/titles/values.', isError: true }
            }
            const { tree, refs } = await snapshotIntoCache(driver, params, app)
            const { matched, text } = filterTreeLines(tree, query.trim())
            if (matched === 0) {
              return {
                content: `No elements matching "${query.trim()}" in ${app} (${refs.length} elements scanned). Top-level structure for orientation:\n${treeOutline(tree)}`,
              }
            }
            const capNote = matched > FIND_MAX_LINES ? `\n(first ${FIND_MAX_LINES} matches shown — narrow the query)` : ''
            return { content: `Elements matching "${query.trim()}" in ${app} (refs are clickable):\n${text}${capNote}` }
          }
          case 'wait_for': {
            if (!app) return { content: 'wait_for requires "app".', isError: true }
            const text = params.input.text
            if (typeof text !== 'string' || !text.trim()) {
              return { content: 'wait_for requires non-empty "text" to wait for in the UI tree.', isError: true }
            }
            const gone = params.input.gone === true
            const rawTimeout = params.input.timeout_ms
            const deadline = Math.max(0, Math.min(WAIT_FOR_CAP_MS, typeof rawTimeout === 'number' ? Math.round(rawTimeout) : WAIT_FOR_DEFAULT_MS))
            const needle = text.trim()
            const startedAt = Date.now()
            let lastTree = ''
            for (;;) {
              const { tree } = await snapshotIntoCache(driver, params, app)
              lastTree = tree
              const { matched, text: matchText } = filterTreeLines(tree, needle)
              if (!gone && matched > 0) {
                return { content: `"${needle}" appeared in ${app} after ${Date.now() - startedAt}ms (refs are clickable):\n${matchText}` }
              }
              if (gone && matched === 0) {
                return { content: `"${needle}" is gone from ${app} (after ${Date.now() - startedAt}ms).` }
              }
              if (Date.now() - startedAt + WAIT_FOR_POLL_MS > deadline) break
              await sleep(WAIT_FOR_POLL_MS)
            }
            if (gone) {
              const { text: stillThere } = filterTreeLines(lastTree, needle)
              return { content: `wait_for timed out after ${deadline}ms — "${needle}" is still present in ${app}:\n${stillThere}`, isError: true }
            }
            return {
              content: `wait_for timed out after ${deadline}ms — "${needle}" did not appear in ${app}. Current top-level structure:\n${treeOutline(lastTree)}\n(ref cache refreshed — find/snapshot for details.)`,
              isError: true,
            }
          }
          case 'click':
            if (!app) return { content: 'click requires "app".', isError: true }
            return await withFeedback(driver, params, app, await executeClick(driver, params, app, 'left', 1))
          case 'double_click':
            if (!app) return { content: 'double_click requires "app".', isError: true }
            return await withFeedback(driver, params, app, await executeClick(driver, params, app, 'left', 2))
          case 'right_click':
            if (!app) return { content: 'right_click requires "app".', isError: true }
            return await withFeedback(driver, params, app, await executeClick(driver, params, app, 'right', 1))
          case 'scroll': {
            if (!app) return { content: 'scroll requires "app".', isError: true }
            const direction = params.input.direction
            if (direction !== 'up' && direction !== 'down' && direction !== 'left' && direction !== 'right') {
              return { content: 'scroll requires "direction" (up|down|left|right).', isError: true }
            }
            const amount = typeof params.input.amount === 'number' ? params.input.amount : undefined
            let at: { x: number; y: number } | undefined
            if (typeof params.input.ref === 'number' || (typeof params.input.x === 'number' && typeof params.input.y === 'number')) {
              const point = await resolvePoint(driver, params, app, 'ref', 'x', 'y')
              if (!point.ok) return { content: point.error, isError: true }
              at = point.point
            }
            await driver.scroll(app, { direction, amount, at })
            return await withFeedback(driver, params, app, { content: `Scrolled ${direction}${amount ? ` by ${amount}` : ''} in ${app}${at ? ` at (${Math.round(at.x)}, ${Math.round(at.y)})` : ''}.` })
          }
          case 'drag': {
            if (!app) return { content: 'drag requires "app".', isError: true }
            const from = await resolvePoint(driver, params, app, 'from_ref', 'from_x', 'from_y')
            if (!from.ok) return { content: from.error, isError: true }
            const to = await resolvePoint(driver, params, app, 'to_ref', 'to_x', 'to_y')
            if (!to.ok) return { content: to.error, isError: true }
            await driver.drag(app, from.point, to.point)
            return await withFeedback(driver, params, app, { content: `Dragged from (${Math.round(from.point.x)}, ${Math.round(from.point.y)}) to (${Math.round(to.point.x)}, ${Math.round(to.point.y)}) in ${app}.` })
          }
          case 'type': {
            if (!app) return { content: 'type requires "app".', isError: true }
            const text = params.input.text
            if (typeof text !== 'string' || text.length === 0) {
              return { content: 'type requires non-empty "text".', isError: true }
            }
            await driver.type(app, text)
            return await withFeedback(driver, params, app, { content: `Typed ${text.length} character(s) into ${app}.` })
          }
          case 'set_value': {
            if (!app) return { content: 'set_value requires "app".', isError: true }
            const ref = params.input.ref
            const text = params.input.text
            if (typeof ref !== 'number') {
              return { content: 'set_value requires "ref" (a snapshot element ref).', isError: true }
            }
            if (typeof text !== 'string') {
              return { content: 'set_value requires "text" (the value to write; may be empty to clear).', isError: true }
            }
            const resolved = resolveRef(params, app, ref)
            if (!resolved.ok) return { content: resolved.error, isError: true }
            let healedNote = ''
            try {
              await driver.setValue(app, resolved.target, text)
            } catch (err) {
              if (!isStaleError(err)) throw err
              const healed = await healStaleRef(driver, params, app, resolved.sr)
              if (!healed.ok) return { content: healed.error, isError: true }
              await driver.setValue(app, healed.target, text)
              healedNote = healed.note
            }
            return await withFeedback(driver, params, app, {
              content: `Set value of ref ${ref} (${describeElement(resolved.sr)}) to ${text.length} character(s) in ${app}.${healedNote}`,
            })
          }
          case 'key': {
            if (!app) return { content: 'key requires "app".', isError: true }
            const combo = params.input.combo
            if (typeof combo !== 'string' || !combo.trim()) {
              return { content: 'key requires a "combo" like "cmd+s".', isError: true }
            }
            await driver.key(app, combo.trim())
            return await withFeedback(driver, params, app, { content: `Sent ${combo} to ${app}.` })
          }
          case 'focus_app': {
            if (!app) return { content: 'focus_app requires "app".', isError: true }
            await driver.focusApp(app)
            return { content: `Focused ${app}.` }
          }
          case 'launch_app': {
            if (!app) return { content: 'launch_app requires "app".', isError: true }
            await driver.launchApp(app)
            return await withFeedback(driver, params, app, { content: `Launched ${app} (focused if it was already running).` })
          }
          case 'menu_select': {
            if (!app) return { content: 'menu_select requires "app".', isError: true }
            const menuPath = params.input.menu_path
            if (typeof menuPath !== 'string' || !menuPath.trim()) {
              return { content: 'menu_select requires "menu_path" like "File > Export > PNG".', isError: true }
            }
            const segments = menuPath.split('>').map((s) => s.trim()).filter(Boolean)
            if (segments.length === 0) {
              return { content: 'menu_select requires "menu_path" like "File > Export > PNG".', isError: true }
            }
            await driver.menuSelect(app, segments)
            return await withFeedback(driver, params, app, { content: `Selected menu ${segments.join(' > ')} in ${app}.` })
          }
          case 'paste_text': {
            if (!app) return { content: 'paste_text requires "app".', isError: true }
            const text = params.input.text
            if (typeof text !== 'string' || text.length === 0) {
              return { content: 'paste_text requires non-empty "text".', isError: true }
            }
            await driver.pasteText(app, text)
            return await withFeedback(driver, params, app, { content: `Pasted ${text.length} character(s) into ${app} via clipboard (the system clipboard now contains this text).` })
          }
          default:
            return { content: `Unknown computer_use action: ${action}`, isError: true }
        }
      } catch (err) {
        const hint = app ? await appNameHint(driver, app) : ''
        return { content: `computer_use failed: ${(err as Error).message}${hint}`, isError: true }
      }
    },

    requiresApproval(params: ToolCallParams): boolean {
      const action = params.input.action as ComputerUseAction
      if (!actionRequiresApproval(action)) return false
      // Arbitrary JS / endpoint takeover: a per-app grant can NEVER waive these.
      if (ALWAYS_APPROVE_ACTIONS.has(action)) return true
      // list_apps has no single app target — always gate (reveals running apps).
      const app = targetApp(params.input)
      if (!app) return true
      // Per-app "always allow" grant skips the prompt (fail-closed default).
      return !grantLookup(app)
    },

    isConcurrencySafe: () => false,
    isEnabled: () => enabled,
    // 感知类动作放宽超时：Electron 树预热重试 + 脚本内 25s 走树预算意味着
    // 一次 snapshot 最坏 ~2s(首拍)+2.5s(等待)+25s(重走)+2s(截图)；find/wait_for
    // 复用同一走树路径。变更类动作的后置反馈同样要走一次 25s 预算的树采集
    // （动作 ~1s + 反馈 ~25s 会贴死旧的 30s），给 60s 余量。
    timeoutMs: (params?: ToolCallParams) => {
      const action = params?.input?.action as ComputerUseAction | undefined
      return action === 'snapshot' || action === 'find' || action === 'wait_for' ? 90_000 : 60_000
    },
  }
}

export const COMPUTER_USE_TOOL: Tool = createComputerUseTool()
