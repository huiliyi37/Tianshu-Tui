/**
 * computer_use — macOS GUI automation tool (Codex Computer Use parity).
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
 *  - macOS only (darwin gated); disabled elsewhere.
 *
 * Element targeting: snapshot refs are backed by AX child-index paths cached
 * per `sessionId:app` (small LRU). Clicks resolve the exact path with a
 * role/title identity check — a changed UI produces a "stale snapshot" error
 * instead of a mis-click on whatever now sits at the old ordinal position.
 */

import type { Tool, ToolCallParams, ToolResult } from '../types.js'
import {
  createMacosDriver,
  type ComputerUseDriver,
  type ComputerUseDriverFactory,
  type ClickTarget,
  type SnapshotRef,
} from './macos-driver.js'
import { isAppGranted } from './app-grants.js'

export type ComputerUseAction =
  | 'list_apps'
  | 'snapshot'
  | 'click'
  | 'double_click'
  | 'right_click'
  | 'scroll'
  | 'drag'
  | 'type'
  | 'key'
  | 'wait'
  | 'focus_app'
  | 'check_permissions'

export interface ComputerUseToolOptions {
  /** Builds the platform driver. Defaults to the macOS osascript driver. */
  driverFactory?: ComputerUseDriverFactory
  /** Whether the tool is registered/visible. Defaults to darwin only. */
  enabled?: boolean
  /** App grant lookup (injectable for tests). Defaults to persisted grants. */
  isAppGranted?: (app: string) => boolean
  /** Platform override (tests). Defaults to process.platform. */
  platform?: NodeJS.Platform
  /** Sleep implementation for the wait action (injectable for tests). */
  sleep?: (ms: number) => Promise<void>
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

/** Max duration for the wait action (ms). */
const WAIT_CAP_MS = 5_000

interface SnapshotCacheEntry {
  refs: Map<number, SnapshotRef>
  /** Redacted tree text of the last snapshot — dedup baseline. */
  lastTree: string
}

/** Per `sessionId:app` snapshot cache capacity. */
const SNAPSHOT_CACHE_CAP = 20

export function createComputerUseTool(options: ComputerUseToolOptions = {}): Tool {
  const platform = options.platform ?? process.platform
  const isDarwin = platform === 'darwin'
  const enabled = options.enabled ?? isDarwin
  const driverFactory = options.driverFactory ?? createMacosDriver
  const grantLookup = options.isAppGranted ?? ((app: string) => isAppGranted(app))
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))

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
        return { ok: false, error: `Cannot locate ref ${ref}: ${(err as Error).message}` }
      }
    }
    if (typeof x === 'number' && typeof y === 'number') {
      return { ok: true, point: { x, y } }
    }
    return { ok: false, error: `Provide either "${refKey}" (snapshot ref) or both "${xKey}" and "${yKey}".` }
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
    if (typeof ref === 'number') {
      const resolved = resolveRef(params, app, ref)
      if (!resolved.ok) return { content: resolved.error, isError: true }
      target = resolved.target
      const label = resolved.sr.title ? ` "${resolved.sr.title}"` : ''
      where = `ref ${ref}${label}`
    } else if (typeof x === 'number' && typeof y === 'number') {
      target = { x, y }
      where = `(${x}, ${y})`
    } else {
      return { content: 'click requires "ref" (from a snapshot) or both "x" and "y".', isError: true }
    }
    await driver.click(app, target, { button, count })
    const verb = count === 2 ? 'Double-clicked' : button === 'right' ? 'Right-clicked' : 'Clicked'
    return { content: `${verb} ${where} in ${app}.` }
  }

  return {
    definition: {
      name: 'computer_use',
      description: `Operate macOS graphical apps: inspect an app's accessibility tree, click/scroll/drag elements, type text, send key combos, focus apps. Use ONLY when CLI tools, MCP servers, or structured integrations can't do the job (e.g. a native app with no API, a GUI-only setting, or reproducing a UI-only bug) — prefer structured tools whenever available.

Every action on an app requires human approval unless that app is already granted "always allow". Screenshots are saved as viewable artifacts; the accessibility tree (text) is what you reason over. When the active model supports vision, the snapshot screenshot is also attached to the conversation as an image.

Actions:
- check_permissions: report Accessibility / Screen Recording status (no approval).
- list_apps: list visible apps.
- snapshot(app): return the app's numbered accessibility tree + save a screenshot artifact. If the UI has not changed since the last snapshot, returns a short "unchanged" note instead of repeating the tree.
- click(app, ref|x,y): left-click a snapshot element ref (preferred) or coordinates.
- double_click(app, ref|x,y) / right_click(app, ref|x,y): double / context click.
- scroll(app, direction, amount?, ref|x,y?): scroll the view under the target (default: window center).
- drag(app, from_ref|from_x+from_y, to_ref|to_x+to_y): press-drag-release.
- type(app, text): type text into the focused field.
- key(app, combo): send a key combo like "cmd+s" or "return".
- wait(duration_ms): pause up to 5000ms for animations/loads (no approval).
- focus_app(app): bring an app to the foreground.

Refs come from the LATEST snapshot of that app; after the UI changes, re-snapshot before clicking (stale refs are rejected, never guessed).`,
      input_schema: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['check_permissions', 'list_apps', 'snapshot', 'click', 'double_click', 'right_click', 'scroll', 'drag', 'type', 'key', 'wait', 'focus_app'],
            description: 'What to do.',
          },
          app: { type: 'string', description: 'Target app name (required for all actions except list_apps/check_permissions/wait).' },
          ref: { type: 'number', description: 'Snapshot element ref to target (click/scroll; from the latest snapshot).' },
          x: { type: 'number', description: 'X coordinate (screen pixels) when no ref is given.' },
          y: { type: 'number', description: 'Y coordinate (screen pixels) when no ref is given.' },
          text: { type: 'string', description: 'Text to type (type action).' },
          combo: { type: 'string', description: 'Key combo like "cmd+s", "shift+cmd+4", "return" (key action).' },
          direction: { type: 'string', enum: ['up', 'down', 'left', 'right'], description: 'Scroll direction (scroll action).' },
          amount: { type: 'number', description: 'Scroll magnitude in wheel lines, 1-50 (default 5).' },
          from_ref: { type: 'number', description: 'Drag start: snapshot ref.' },
          from_x: { type: 'number', description: 'Drag start X (when no from_ref).' },
          from_y: { type: 'number', description: 'Drag start Y (when no from_ref).' },
          to_ref: { type: 'number', description: 'Drag end: snapshot ref.' },
          to_x: { type: 'number', description: 'Drag end X (when no to_ref).' },
          to_y: { type: 'number', description: 'Drag end Y (when no to_ref).' },
          duration_ms: { type: 'number', description: 'Wait duration in ms, capped at 5000 (wait action).' },
        },
        required: ['action'],
      },
    },

    async execute(params: ToolCallParams): Promise<ToolResult> {
      if (platform !== 'darwin') {
        return {
          content: 'computer_use is only available on macOS. This host is not darwin.',
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
            const lines = apps.map((a) => `- ${a.name}${a.frontmost ? ' (frontmost)' : ''}`)
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
          case 'click':
            if (!app) return { content: 'click requires "app".', isError: true }
            return await executeClick(driver, params, app, 'left', 1)
          case 'double_click':
            if (!app) return { content: 'double_click requires "app".', isError: true }
            return await executeClick(driver, params, app, 'left', 2)
          case 'right_click':
            if (!app) return { content: 'right_click requires "app".', isError: true }
            return await executeClick(driver, params, app, 'right', 1)
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
            return { content: `Scrolled ${direction}${amount ? ` by ${amount}` : ''} in ${app}${at ? ` at (${Math.round(at.x)}, ${Math.round(at.y)})` : ''}.` }
          }
          case 'drag': {
            if (!app) return { content: 'drag requires "app".', isError: true }
            const from = await resolvePoint(driver, params, app, 'from_ref', 'from_x', 'from_y')
            if (!from.ok) return { content: from.error, isError: true }
            const to = await resolvePoint(driver, params, app, 'to_ref', 'to_x', 'to_y')
            if (!to.ok) return { content: to.error, isError: true }
            await driver.drag(app, from.point, to.point)
            return { content: `Dragged from (${Math.round(from.point.x)}, ${Math.round(from.point.y)}) to (${Math.round(to.point.x)}, ${Math.round(to.point.y)}) in ${app}.` }
          }
          case 'type': {
            if (!app) return { content: 'type requires "app".', isError: true }
            const text = params.input.text
            if (typeof text !== 'string' || text.length === 0) {
              return { content: 'type requires non-empty "text".', isError: true }
            }
            await driver.type(app, text)
            return { content: `Typed ${text.length} character(s) into ${app}.` }
          }
          case 'key': {
            if (!app) return { content: 'key requires "app".', isError: true }
            const combo = params.input.combo
            if (typeof combo !== 'string' || !combo.trim()) {
              return { content: 'key requires a "combo" like "cmd+s".', isError: true }
            }
            await driver.key(app, combo.trim())
            return { content: `Sent ${combo} to ${app}.` }
          }
          case 'focus_app': {
            if (!app) return { content: 'focus_app requires "app".', isError: true }
            await driver.focusApp(app)
            return { content: `Focused ${app}.` }
          }
          default:
            return { content: `Unknown computer_use action: ${action}`, isError: true }
        }
      } catch (err) {
        return { content: `computer_use failed: ${(err as Error).message}`, isError: true }
      }
    },

    requiresApproval(params: ToolCallParams): boolean {
      const action = params.input.action as ComputerUseAction
      if (!actionRequiresApproval(action)) return false
      // list_apps has no single app target — always gate (reveals running apps).
      const app = targetApp(params.input)
      if (!app) return true
      // Per-app "always allow" grant skips the prompt (fail-closed default).
      return !grantLookup(app)
    },

    isConcurrencySafe: () => false,
    isEnabled: () => enabled,
    timeoutMs: () => 30_000,
  }
}

export const COMPUTER_USE_TOOL: Tool = createComputerUseTool()
