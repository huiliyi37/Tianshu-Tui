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

/** Arbitrary-code / endpoint-takeover surface — approval can never be skipped
 *  by a per-app grant (mirrors browser.ts's fail-closed posture). YOLO mode
 *  waives approvals wholesale in the pipeline, not here. */
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

// 可访问性树前缀已抽至 ../output-markers.ts（零依赖叶子，桌面端共享）；
// 此处 re-export 保持内核调用方不变。
export { COMPUTER_USE_A11Y_TREE_PREFIX } from '../output-markers.js'
import { COMPUTER_USE_A11Y_TREE_PREFIX } from '../output-markers.js'

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
      return { ok: false, error: `本会话尚未缓存 ${app} 的快照——请先 snapshot，再用 ref 点击。` }
    }
    const sr = entry.refs.get(ref)
    if (!sr) {
      return { ok: false, error: `ref ${ref} 不在 ${app} 的最新快照中——请重新 snapshot 并使用当前 ref。` }
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
              return { ok: false, error: `无法定位 ref ${ref}：${(retryErr as Error).message}` }
            }
          }
          return { ok: false, error: `无法定位 ref ${ref}：${healed.error}` }
        }
        return { ok: false, error: `无法定位 ref ${ref}：${(err as Error).message}` }
      }
    }
    if (typeof x === 'number' && typeof y === 'number') {
      return { ok: true, point: { x, y } }
    }
    return { ok: false, error: `请提供 "${refKey}"（快照 ref），或同时提供 "${xKey}" 与 "${yKey}"。` }
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
        return { ...result, content: `${result.content}\n操作后 UI 状态已缓存（${snap.refs.length} 个元素）——请 snapshot 查看树。` }
      }
      const diff = diffTreeSummary(previous.lastTree, tree)
      const note = diff.changed
        ? `${diff.summary}\n（refs 已刷新——此操作之前的 ref 已失效；请使用 diff 中的 ref 或重新 snapshot。）`
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
  function filterTreeLines(tree: string, query: string): { matched: number; total: number; text: string } {
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
    return { matched, total: lines.length, text }
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
        return `\n你是指 "${first.name}" 吗？可见应用：${names}`
      }
      return `\n没有与 "${app}" 匹配的可见应用。可见应用：${names}`
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
        note: `（ref 已过期——在新快照中自动匹配到相同的 ${describeElement(sr)} 为 ref ${match.ref} 并已重试）`,
      }
    }
    const why = matches.length === 0 ? '没有元素匹配' : `${matches.length} 个元素匹配`
    return {
      ok: false,
      error: `过期 ref 无法自动修复：当前 ${why} ${describeElement(sr)}。已从新快照刷新 ref 缓存——请用 find/snapshot 并选择当前 ref。`,
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
        return { content: 'browser_adopt 需要 "endpoint"（如 "localhost:9222"——用 --remote-debugging-port 启动的 Chrome）。', isError: true }
      }
      return { content: await cdp.adopt(endpoint.trim()) }
    }
    if (!app) {
      return { content: `${action} 需要 "app"（要操作的浏览器，如 "Google Chrome"）。`, isError: true }
    }
    switch (action) {
      case 'navigate': {
        const url = params.input.url
        if (typeof url !== 'string' || !url.trim()) {
          return { content: 'navigate 需要 "url"（URL，或 "back" / "forward" / "reload"）。', isError: true }
        }
        const note = await cdp.navigate(url.trim())
        return await withFeedback(cdp, params, app, { content: note })
      }
      case 'read_page':
        return { content: await cdp.readPage() }
      case 'js_eval': {
        const expression = params.input.expression
        if (typeof expression !== 'string' || !expression.trim()) {
          return { content: 'js_eval 需要 "expression"（要在页面中执行的 JavaScript）。', isError: true }
        }
        const result = await cdp.evalJs(expression)
        return await withFeedback(cdp, params, app, { content: `js_eval 结果：\n${result}` })
      }
      case 'tabs': {
        const rawOp = params.input.tab_op ?? 'list'
        if (rawOp !== 'list' && rawOp !== 'activate' && rawOp !== 'new' && rawOp !== 'close') {
          return { content: 'tabs 的 "tab_op" 必须是：list、activate、new、close。', isError: true }
        }
        const index = typeof params.input.tab === 'number' ? params.input.tab : undefined
        const url = typeof params.input.url === 'string' ? params.input.url : undefined
        const note = await cdp.tabs(rawOp, { index, url })
        // list is read-only; mutations get the standard feedback loop.
        return rawOp === 'list' ? { content: note } : await withFeedback(cdp, params, app, { content: note })
      }
      default:
        return { content: `未知浏览器操作：${action}`, isError: true }
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
      return { content: 'click 需要 "ref"（来自快照）或同时提供 "x" 与 "y"。', isError: true }
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
    const verb = count === 2 ? '已双击' : button === 'right' ? '已右键点击' : '已点击'
    return { content: `${verb} ${where}（于 ${app}）。${healedNote}` }
  }

  return {
    definition: {
      name: 'computer_use',
      description: `操作桌面图形应用（macOS 和 Windows）：检查应用的可访问性树、点击/滚动/拖拽元素、输入文本、发送组合键、聚焦应用。仅当 CLI 工具、MCP 服务或结构化集成无法完成任务时使用（如无 API 的原生应用、纯 GUI 设置、或复现 UI-only bug）——有结构化工具时优先用结构化工具。

对应用的每个操作都需要人工审批，除非该应用已被授予"始终允许"。截图保存为可查看的 artifact；可访问性树（文本）是你的推理依据。当活跃模型支持视觉时，快照截图也会作为图片附加到对话中。

操作：
- check_permissions：报告系统能力/权限状态（无需审批）。
- list_apps：列出可见应用。
- snapshot(app)：返回应用的编号可访问性树 + 保存截图 artifact。如果 UI 自上次快照以来没有变化，返回简短"未变化"提示而非重复整棵树。Electron 应用（QQ、微信、VS Code…）在首次快照后几秒才会填充树——工具会自动预热并重试；超大树可能标记为"部分"（ref 仍然有效；用 find/wait_for 获取更深内容）。绝不要因为一次稀疏快照就断定应用不可见——再拍一次快照或先用 find。
- find(app, query)：快照但仅返回匹配查询的树行（角色/标题/值，不区分大小写）及其祖先链。对大型 UI（浏览器）优于 snapshot——同样的 ref，少得多的输出。
- wait_for(app, text, gone?, timeout_ms?)：轮询 UI 直到含"text"的树行出现（或 gone:true 时消失）。返回匹配行及可点击的 ref。在触发加载/动画的操作后使用，而不是盲 wait+snapshot 循环。
- click(app, ref|x,y)：左键点击快照元素 ref（推荐）或坐标。
- double_click(app, ref|x,y) / right_click(app, ref|x,y)：双击/右键点击。
- scroll(app, direction, amount?, ref|x,y?)：在目标下滚动视图（默认：窗口中心）。
- drag(app, from_ref|from_x+from_y, to_ref|to_x+to_y)：按住拖拽释放。
- type(app, text)：向聚焦字段输入文本（短 ASCII 文本；长文本用 paste_text，写特定字段用 set_value）。非 ASCII 文本（中文/emoji）自动走剪贴板粘贴——不受当前输入法（IME）影响，但会覆盖剪贴板。
- set_value(app, ref, text)：直接向文本控件（文本框、搜索框）写入值——无需焦点切换。如果控件不支持值写入则报错；回退到 click + type/paste_text。
- key(app, combo)：发送组合键如 "cmd+s" 或 "return"（Windows 上 cmd 映射为 Ctrl）。
- wait(duration_ms)：暂停最多 5000ms 等待动画/加载（无需审批）。知道等什么时优先用 wait_for。
- focus_app(app)：将应用带到前台。
- launch_app(app)：启动未运行的应用（已在运行时则聚焦它）。
- menu_select(app, menu_path)：按路径选择菜单栏项，如 "File > Export > PNG"。
- paste_text(app, text)：将文本放入剪贴板并粘贴（长/多行文本快速可靠；覆盖剪贴板）。

浏览器快速路径：Chrome 系目标（Chrome/Chromium/Edge/Brave）在有 DevTools（CDP）后端可用时自动使用——快照秒级完成，窗口被遮挡时点击/输入仍有效。对浏览器 launch_app 会启动专用自动化 profile（登录态跨会话保留）。浏览器专属操作：
- navigate(app, url)：导航到 URL，或 "back" / "forward" / "reload"。
- read_page(app)：完整页面文本（innerText）——无树节点上限；用于阅读文章/长内容。
- js_eval(app, expression)：在页面中运行 JavaScript 并返回结果（需要审批；自治/YOLO 档免审批）。
- tabs(app, tab_op, tab?, url?)：列出/激活/新建/关闭浏览器标签页（tab 是 list 中的 1-based 索引）。
- browser_adopt(endpoint)：附加到你用 --remote-debugging-port 启动的 Chrome（需要审批；自治/YOLO 档免审批）。

反馈循环：每次变更操作后工具会重新读取 UI 并附加变化摘要（新增/移除的元素）。UI 变化时 ref 缓存会刷新——diff 中显示的 ref 立即可点击，操作之前的 ref 已失效。如果目标 ref 失效，工具会在恰好一个元素仍匹配相同 role+title 时自动重拍快照并重试；否则刷新缓存并请你重新选择目标。`,
      input_schema: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['check_permissions', 'list_apps', 'snapshot', 'find', 'wait_for', 'click', 'double_click', 'right_click', 'scroll', 'drag', 'type', 'set_value', 'key', 'wait', 'focus_app', 'launch_app', 'menu_select', 'paste_text', 'navigate', 'read_page', 'js_eval', 'tabs', 'browser_adopt'],
            description: '要执行的操作。',
          },
          app: { type: 'string', description: '目标应用名称（除 list_apps/check_permissions/wait 外所有操作必需）。' },
          ref: { type: 'number', description: '目标快照元素 ref（click/scroll/set_value；来自最新快照）。' },
          x: { type: 'number', description: 'X 坐标（屏幕像素），无 ref 时使用。' },
          y: { type: 'number', description: 'Y 坐标（屏幕像素），无 ref 时使用。' },
          text: { type: 'string', description: '要输入（type）、粘贴（paste_text）、写入（set_value）的文本，或在树中等待（wait_for）。' },
          query: { type: 'string', description: '匹配树行的过滤字符串（find 操作）。' },
          gone: { type: 'boolean', description: 'wait_for：等待文本消失而非出现。' },
          timeout_ms: { type: 'number', description: 'wait_for 截止毫秒数（默认 5000，上限 15000）。' },
          menu_path: { type: 'string', description: '菜单路径，用 ">" 分隔，如 "File > Export > PNG"（menu_select 操作）。' },
          combo: { type: 'string', description: '组合键如 "cmd+s"、"shift+cmd+4"、"return"（key 操作；Windows 上 cmd 映射为 Ctrl）。' },
          direction: { type: 'string', enum: ['up', 'down', 'left', 'right'], description: '滚动方向（scroll 操作）。' },
          amount: { type: 'number', description: '滚动幅度，滚轮行数 1-50（默认 5）。' },
          from_ref: { type: 'number', description: '拖拽起点：快照 ref。' },
          from_x: { type: 'number', description: '拖拽起点 X（无 from_ref 时）。' },
          from_y: { type: 'number', description: '拖拽起点 Y（无 from_ref 时）。' },
          to_ref: { type: 'number', description: '拖拽终点：快照 ref。' },
          to_x: { type: 'number', description: '拖拽终点 X（无 to_ref 时）。' },
          to_y: { type: 'number', description: '拖拽终点 Y（无 to_ref 时）。' },
          duration_ms: { type: 'number', description: '等待时长毫秒数，上限 5000（wait 操作）。' },
          url: { type: 'string', description: '要打开的 URL（navigate / tabs new）。navigate 也接受 "back"、"forward"、"reload"。' },
          expression: { type: 'string', description: '要在页面中执行的 JavaScript（js_eval 操作）。' },
          tab_op: { type: 'string', enum: ['list', 'activate', 'new', 'close'], description: '标签页操作（tabs 操作；默认 list）。' },
          tab: { type: 'number', description: '来自 tabs list 的 1-based 标签索引（tabs activate/close）。' },
          endpoint: { type: 'string', description: 'DevTools 端点，如 "localhost:9222" 或 http/ws URL（browser_adopt 操作）。' },
        },
        required: ['action'],
      },
    },

    async execute(params: ToolCallParams): Promise<ToolResult> {
      if (!isSupported) {
        return {
          content: `computer_use 仅在 macOS 与 Windows 上可用。当前主机为 ${platform}。`,
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
        return { content: `已等待 ${ms}ms。` }
      }

      let driver: ComputerUseDriver
      try {
        driver = driverFactory()
      } catch (err) {
        return { content: `computer_use 驱动初始化失败：${(err as Error).message}`, isError: true }
      }

      try {
        // Browser-only actions require the CDP backend outright — no native
        // fallback exists for navigate/read_page/js_eval/tabs/browser_adopt.
        if (BROWSER_ONLY_ACTIONS.has(action)) {
          if (!cdpEnabled) {
            return { content: `${action} 需要 CDP 浏览器后端，但该后端已禁用（RIVET_CU_CDP=0）。`, isError: true }
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
                `Accessibility：${perm.accessibility ? '已授予' : '缺失'}\n` +
                `Screen Recording：${perm.screenRecording ? '已授予' : '缺失'}\n${perm.detail}`,
            }
          }
          case 'list_apps': {
            const apps = await driver.listApps()
            if (apps.length === 0) return { content: '未找到可见应用。' }
            const lines = apps.map((a) => {
              const title = a.title && a.title !== a.name ? ` — "${a.title}"` : ''
              return `- ${a.name}${title}${a.frontmost ? '（前台）' : ''}`
            })
            return { content: `可见应用：\n${lines.join('\n')}` }
          }
          case 'snapshot': {
            if (!app) return { content: 'snapshot 需要 "app"。', isError: true }
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
            const artifactNote = artifactId ? ` (screenshot → artifact ${artifactId})` : '（截图不可用）'
            if (unchanged) {
              // Dedup: identical tree → short note, no image re-attachment.
              // Existing refs stay valid (same tree ⇒ same paths).
              return { content: `${app} 的快照${artifactNote}：自上次快照以来 UI 未变化——先前的 refs 仍然有效。` }
            }
            const images = snap.visionPng
              ? [`data:image/png;base64,${snap.visionPng.toString('base64')}`]
              : undefined
            return {
              content: `${COMPUTER_USE_A11Y_TREE_PREFIX}（${app}${artifactNote}）：\n\n${tree}`,
              images,
            }
          }
          case 'find': {
            if (!app) return { content: 'find 需要 "app"。', isError: true }
            const query = params.input.query
            if (typeof query !== 'string' || !query.trim()) {
              return { content: 'find 需要非空 "query"，用于匹配角色/标题/值。', isError: true }
            }
            const { tree } = await snapshotIntoCache(driver, params, app)
            const { matched, total, text } = filterTreeLines(tree, query.trim())
            if (matched === 0) {
              return {
                content:
                  `在 ${app} 中未找到匹配 "${query.trim()}" 的元素（匹配 0 行，共扫描 ${total} 行）。` +
                  `find 仅匹配可访问性树行（角色/标题/值）——文档正文等文本值可能不在树行中，可 snapshot 查看全文。` +
                  `顶层结构供定位：\n${treeOutline(tree)}`,
              }
            }
            const capNote = matched > FIND_MAX_LINES ? `\n（仅显示前 ${FIND_MAX_LINES} 条匹配——请缩小查询）` : ''
            return { content: `在 ${app} 中匹配 "${query.trim()}" 的元素（refs 可点击）：\n${text}${capNote}` }
          }
          case 'wait_for': {
            if (!app) return { content: 'wait_for 需要 "app"。', isError: true }
            const text = params.input.text
            if (typeof text !== 'string' || !text.trim()) {
              return { content: 'wait_for 需要非空 "text"，用于在 UI 树中等待。', isError: true }
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
                return { content: `"${needle}" 在 ${app} 中于 ${Date.now() - startedAt}ms 后出现（refs 可点击）：\n${matchText}` }
              }
              if (gone && matched === 0) {
                return { content: `"${needle}" 已从 ${app} 消失（经过 ${Date.now() - startedAt}ms）。` }
              }
              if (Date.now() - startedAt + WAIT_FOR_POLL_MS > deadline) break
              await sleep(WAIT_FOR_POLL_MS)
            }
            if (gone) {
              const { text: stillThere } = filterTreeLines(lastTree, needle)
              return {
                content: `wait_for 在 ${deadline}ms 后超时——"${needle}" 仍存在于 ${app}：\n${stillThere}`,
                isError: true,
                errorKind: 'timeout',
              }
            }
            const { total: lastTotal } = filterTreeLines(lastTree, needle)
            return {
              content:
                `wait_for 在 ${deadline}ms 后超时——"${needle}" 未出现在 ${app}（匹配 0 行，共扫描 ${lastTotal} 行；` +
                `仅匹配树行文本，文档正文等文本值可能不在树中）。当前顶层结构：\n${treeOutline(lastTree)}\n（ref 缓存已刷新——详情请 find/snapshot。）`,
              isError: true,
              errorKind: 'timeout',
            }
          }
          case 'click':
            if (!app) return { content: 'click 需要 "app"。', isError: true }
            return await withFeedback(driver, params, app, await executeClick(driver, params, app, 'left', 1))
          case 'double_click':
            if (!app) return { content: 'double_click 需要 "app"。', isError: true }
            return await withFeedback(driver, params, app, await executeClick(driver, params, app, 'left', 2))
          case 'right_click':
            if (!app) return { content: 'right_click 需要 "app"。', isError: true }
            return await withFeedback(driver, params, app, await executeClick(driver, params, app, 'right', 1))
          case 'scroll': {
            if (!app) return { content: 'scroll 需要 "app"。', isError: true }
            const direction = params.input.direction
            if (direction !== 'up' && direction !== 'down' && direction !== 'left' && direction !== 'right') {
              return { content: 'scroll 需要 "direction"（up|down|left|right）。', isError: true }
            }
            const amount = typeof params.input.amount === 'number' ? params.input.amount : undefined
            let at: { x: number; y: number } | undefined
            if (typeof params.input.ref === 'number' || (typeof params.input.x === 'number' && typeof params.input.y === 'number')) {
              const point = await resolvePoint(driver, params, app, 'ref', 'x', 'y')
              if (!point.ok) return { content: point.error, isError: true }
              at = point.point
            }
            await driver.scroll(app, { direction, amount, at })
            return await withFeedback(driver, params, app, { content: `已在 ${app} 中向 ${direction} 滚动${amount ? ` ${amount}` : ''}${at ? `，位置 (${Math.round(at.x)}, ${Math.round(at.y)})` : ''}。` })
          }
          case 'drag': {
            if (!app) return { content: 'drag 需要 "app"。', isError: true }
            const from = await resolvePoint(driver, params, app, 'from_ref', 'from_x', 'from_y')
            if (!from.ok) return { content: from.error, isError: true }
            const to = await resolvePoint(driver, params, app, 'to_ref', 'to_x', 'to_y')
            if (!to.ok) return { content: to.error, isError: true }
            await driver.drag(app, from.point, to.point)
            return await withFeedback(driver, params, app, { content: `已在 ${app} 中从 (${Math.round(from.point.x)}, ${Math.round(from.point.y)}) 拖拽到 (${Math.round(to.point.x)}, ${Math.round(to.point.y)})。` })
          }
          case 'type': {
            if (!app) return { content: 'type 需要 "app"。', isError: true }
            const text = params.input.text
            if (typeof text !== 'string' || text.length === 0) {
              return { content: 'type 需要非空 "text"。', isError: true }
            }
            await driver.type(app, text)
            return await withFeedback(driver, params, app, { content: `已向 ${app} 输入 ${text.length} 个字符。` })
          }
          case 'set_value': {
            if (!app) return { content: 'set_value 需要 "app"。', isError: true }
            const ref = params.input.ref
            const text = params.input.text
            if (typeof ref !== 'number') {
              return { content: 'set_value 需要 "ref"（快照元素 ref）。', isError: true }
            }
            if (typeof text !== 'string') {
              return { content: 'set_value 需要 "text"（要写入的值；可为空以清空）。', isError: true }
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
              content: `已将 ${app} 中 ref ${ref}（${describeElement(resolved.sr)}）的值设为 ${text.length} 个字符。${healedNote}`,
            })
          }
          case 'key': {
            if (!app) return { content: 'key 需要 "app"。', isError: true }
            const combo = params.input.combo
            if (typeof combo !== 'string' || !combo.trim()) {
              return { content: 'key 需要类似 "cmd+s" 的 "combo"。', isError: true }
            }
            await driver.key(app, combo.trim())
            return await withFeedback(driver, params, app, { content: `已向 ${app} 发送 ${combo}。` })
          }
          case 'focus_app': {
            if (!app) return { content: 'focus_app 需要 "app"。', isError: true }
            await driver.focusApp(app)
            return { content: `已聚焦 ${app}。` }
          }
          case 'launch_app': {
            if (!app) return { content: 'launch_app 需要 "app"。', isError: true }
            await driver.launchApp(app)
            return await withFeedback(driver, params, app, { content: `已启动 ${app}（若已在运行则聚焦）。` })
          }
          case 'menu_select': {
            if (!app) return { content: 'menu_select 需要 "app"。', isError: true }
            const menuPath = params.input.menu_path
            if (typeof menuPath !== 'string' || !menuPath.trim()) {
              return { content: 'menu_select 需要类似 "File > Export > PNG" 的 "menu_path"。', isError: true }
            }
            const segments = menuPath.split('>').map((s) => s.trim()).filter(Boolean)
            if (segments.length === 0) {
              return { content: 'menu_select 需要类似 "File > Export > PNG" 的 "menu_path"。', isError: true }
            }
            await driver.menuSelect(app, segments)
            return await withFeedback(driver, params, app, { content: `已在 ${app} 中选择菜单 ${segments.join(' > ')}。` })
          }
          case 'paste_text': {
            if (!app) return { content: 'paste_text 需要 "app"。', isError: true }
            const text = params.input.text
            if (typeof text !== 'string' || text.length === 0) {
              return { content: 'paste_text 需要非空 "text"。', isError: true }
            }
            await driver.pasteText(app, text)
            return await withFeedback(driver, params, app, { content: `已通过剪贴板向 ${app} 粘贴 ${text.length} 个字符（系统剪贴板现为此文本）。` })
          }
          default:
            return { content: `未知 computer_use 操作：${action}`, isError: true }
        }
      } catch (err) {
        const hint = app ? await appNameHint(driver, app) : ''
        return { content: `computer_use 失败：${(err as Error).message}${hint}`, isError: true }
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
