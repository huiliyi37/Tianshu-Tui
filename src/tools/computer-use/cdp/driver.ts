/**
 * CdpDriver — ComputerUseDriver over the Chrome DevTools Protocol.
 *
 * Implements the exact same driver interface the native macOS AX / Windows
 * UIA drivers implement, so tool.ts's ref cache, stale-heal chain, feedback
 * loop, find/wait_for all work unchanged — just ~50× faster on browsers
 * (one `Accessibility.getFullAXTree` call replaces thousands of Apple
 * Events; measured 17–36s AX snapshots become sub-second).
 *
 * Ref encoding: `path = [frameOrdinal, backendNodeId]`. Ordinal 0 is the
 * main frame; OOPIF (out-of-process iframe) sessions get 1..N in snapshot
 * order. Identity (role/name) is re-verified before every click — mismatch
 * throws messages starting with "stale snapshot —" BYTE-IDENTICAL to the
 * macOS driver so `isStaleError` + `healStaleRef` route correctly.
 *
 * Coordinates are CSS pixels in the target frame's viewport (snapshot pos,
 * click x/y, locate all agree). Input goes through `Input.dispatchMouseEvent`
 * / `dispatchKeyEvent` — trusted events that work even when the window is
 * occluded or backgrounded (a capability the AX driver cannot offer).
 *
 * Beyond the driver interface, browser-specific verbs (navigate/readPage/
 * evalJs/tabs/adopt) power the tool's new browser actions.
 */

import { join } from 'node:path'
import { mkdir } from 'node:fs/promises'
import { rivetHome } from '../../../config/paths.js'
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
} from '../macos-driver.js'
import {
  CdpConnection,
  defaultTransportFactory,
  discoverBrowser,
  listTargets,
  type CdpTransportFactory,
  type FetchLike,
} from './client.js'
import {
  adoptEndpoint,
  ensureEndpoint,
  type ChromeDeps,
  type ChromeEndpoint,
} from './chrome.js'

/** Bound the model-facing tree (matches the native drivers' cap). */
const MAX_TREE_NODES = 400

/** Max OOPIF child frames merged into one snapshot. */
const MAX_OOPIF_FRAMES = 3

/** Vision screenshot max dimension (CSS px) — Chrome scales at capture time. */
const VISION_MAX_DIMENSION = 1440

/** read_page output cap (chars) — full-text extraction, but bounded. */
const READ_PAGE_MAX_CHARS = 60_000

const SNAPSHOT_TIMEOUT_MS = 15_000
const NAVIGATE_WAIT_MS = 12_000

/**
 * Normalize a navigation target to a safe URL. http/https ONLY — `file:`
 * (local file exfiltration via read_page), `javascript:`/`data:` (script
 * injection), `chrome:`/`devtools:` (browser internals) are attack surface;
 * mirrors browser.ts's fail-closed protocol posture. Bare hosts get https://.
 */
export function normalizeNavigationUrl(raw: string): string {
  const trimmed = raw.trim()
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`
  let parsed: URL
  try {
    parsed = new URL(withScheme)
  } catch {
    throw new Error(`invalid URL: "${raw}"`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`navigation blocked: protocol "${parsed.protocol}" is not allowed — only http/https URLs can be opened (file:, javascript:, data: and browser-internal schemes are refused).`)
  }
  return withScheme
}

/** AX roles that are pure structure — row suppressed when unnamed. */
const SILENT_ROLES = new Set([
  'none', 'generic', 'GenericContainer', 'genericContainer', 'IgnoredObject', 'RootWebArea',
])

/** Raw layout fragments — ALWAYS suppressed, named or not (real-machine
 *  finding: InlineTextBox duplicates its StaticText parent line for line,
 *  burning refs and tokens with zero signal). */
const HIDDEN_ROLES = new Set(['InlineTextBox', 'LineBreak'])

// --- CDP payload shapes (subset we consume) ---

interface AxNode {
  nodeId: string
  ignored?: boolean
  role?: { value?: unknown }
  name?: { value?: unknown }
  value?: { value?: unknown }
  backendDOMNodeId?: number
  childIds?: string[]
  parentId?: string
}

interface TargetInfo {
  targetId: string
  type: string
  title: string
  url: string
  attached?: boolean
}

export interface CdpDriverDeps {
  chromeDeps?: ChromeDeps
  transportFactory?: CdpTransportFactory
  fetchImpl?: FetchLike
}

/** ComputerUseDriver + the browser-specific verbs behind the new actions. */
export interface CdpBrowserDriver extends ComputerUseDriver {
  /** Can this backend serve right now? Attaches (and optionally launches). */
  available(allowLaunch: boolean): Promise<boolean>
  /** Navigate: URL, or "back" / "forward" / "reload". Returns a result note. */
  navigate(target: string): Promise<string>
  /** Full-page text extraction (innerText), bounded but far beyond the tree cap. */
  readPage(): Promise<string>
  /** Runtime.evaluate — the tool must gate this behind unconditional approval. */
  evalJs(expression: string): Promise<string>
  /** Tab management: list / activate / new / close. */
  tabs(op: 'list' | 'activate' | 'new' | 'close', arg?: { index?: number; url?: string }): Promise<string>
  /** Explicit takeover of a user-provided DevTools endpoint. */
  adopt(endpoint: string): Promise<string>
  /** Current endpoint (for user messaging), if any. */
  endpointInfo(): ChromeEndpoint | null
}

export function createCdpDriver(deps: CdpDriverDeps = {}): CdpBrowserDriver {
  const chromeDeps: ChromeDeps = { ...deps.chromeDeps, fetchImpl: deps.chromeDeps?.fetchImpl ?? deps.fetchImpl }
  const fetchImpl: FetchLike = deps.fetchImpl ?? fetch
  const transportFactory = deps.transportFactory ?? defaultTransportFactory

  let endpoint: ChromeEndpoint | null = null
  let conn: CdpConnection | null = null
  let mainSessionId: string | null = null
  let activeTargetId: string | null = null
  /** sessionId → target info for auto-attached children (OOPIFs). */
  const childSessions = new Map<string, TargetInfo>()
  /** Frame ordinal → sessionId, frozen per snapshot ([0] = main frame). */
  let frameSessions: string[] = []
  /** One-shot note when a JS dialog was auto-handled since the last snapshot. */
  let dialogNote: string | null = null

  function connected(): boolean {
    return conn !== null && !conn.isClosed && mainSessionId !== null
  }

  async function connectBrowser(): Promise<void> {
    if (!endpoint) throw new Error('no CDP endpoint resolved')
    const version = await discoverBrowser(endpoint.httpBase, fetchImpl)
    conn = await CdpConnection.connect(version.webSocketDebuggerUrl, transportFactory)
    mainSessionId = null
    activeTargetId = null
    childSessions.clear()
    frameSessions = []

    conn.on('Target.attachedToTarget', (params) => {
      const info = params.targetInfo as TargetInfo | undefined
      const sessionId = params.sessionId
      if (!info || typeof sessionId !== 'string') return
      if (info.type === 'iframe') childSessions.set(sessionId, info)
    })
    conn.on('Target.detachedFromTarget', (params) => {
      const sessionId = params.sessionId
      if (typeof sessionId !== 'string') return
      childSessions.delete(sessionId)
      if (sessionId === mainSessionId) mainSessionId = null
    })
    // Auto-handle JS dialogs so a surprise alert can't wedge every later
    // action: accept alert/beforeunload (single-outcome), dismiss
    // confirm/prompt (fail-closed — the model can js_eval if it truly wants
    // to accept). The note surfaces on the next snapshot.
    conn.on('Page.javascriptDialogOpening', (params, sessionId) => {
      const type = String(params.type ?? 'dialog')
      const message = String(params.message ?? '')
      const accept = type === 'alert' || type === 'beforeunload'
      dialogNote = `JS ${type} dialog auto-${accept ? 'accepted' : 'dismissed'}: "${message.slice(0, 120)}"`
      void conn?.send('Page.handleJavaScriptDialog', { accept }, { sessionId }).catch(() => { /* dialog already gone */ })
    })

    // Downloads land in a predictable place instead of prompting.
    try {
      const downloadPath = join(rivetHome(), 'downloads')
      await mkdir(downloadPath, { recursive: true })
      await conn.send('Browser.setDownloadBehavior', { behavior: 'allowAndName', downloadPath })
    } catch { /* optional nicety — older Chromium builds lack it */ }
  }

  async function pickPageTarget(): Promise<string> {
    if (!endpoint || !conn) throw new Error('no CDP endpoint resolved')
    const raw = await conn.send<{ targetInfos?: TargetInfo[] }>('Target.getTargets')
    const pages = (raw.targetInfos ?? []).filter(
      (t) => t.type === 'page' && !t.url.startsWith('devtools://') && !t.url.startsWith('chrome-extension://'),
    )
    const first = pages[0]
    if (first) return first.targetId
    const created = await conn.send<{ targetId: string }>('Target.createTarget', { url: 'about:blank' })
    return created.targetId
  }

  async function attachToPage(targetId: string): Promise<void> {
    if (!conn) throw new Error('no CDP connection')
    const attached = await conn.send<{ sessionId: string }>('Target.attachToTarget', { targetId, flatten: true })
    mainSessionId = attached.sessionId
    activeTargetId = targetId
    const sessionId = mainSessionId
    await conn.send('Page.enable', {}, { sessionId })
    await conn.send('DOM.enable', {}, { sessionId }).catch(() => { /* some embedders reject */ })
    await conn.send('Accessibility.enable', {}, { sessionId }).catch(() => { /* enabled implicitly by getFullAXTree */ })
    // OOPIF auto-attach: cross-process iframes become flat child sessions we
    // can snapshot and dispatch input into.
    await conn
      .send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, { sessionId })
      .catch(() => { /* not fatal — OOPIF merging degrades gracefully */ })
  }

  /**
   * Make sure we have endpoint + browser connection + attached page session.
   * `allowLaunch` gates spawning the dedicated-profile instance.
   */
  async function ensurePage(allowLaunch: boolean): Promise<void> {
    if (connected()) return
    endpoint = await ensureEndpoint({ allowLaunch }, chromeDeps)
    if (!endpoint) {
      throw new Error('no CDP endpoint available — use launch_app to start the automation browser, or browser_adopt for a Chrome started with --remote-debugging-port')
    }
    if (!conn || conn.isClosed) await connectBrowser()
    if (!mainSessionId) await attachToPage(activeTargetId ?? (await pickPageTarget()))
  }

  function send<T = Record<string, unknown>>(method: string, params?: Record<string, unknown>, opts?: { sessionId?: string | null; timeoutMs?: number }): Promise<T> {
    if (!conn) return Promise.reject(new Error('no CDP connection'))
    return conn.send<T>(method, params, {
      sessionId: opts?.sessionId ?? mainSessionId ?? undefined,
      timeoutMs: opts?.timeoutMs,
    })
  }

  // --- snapshot ---

  interface Row {
    ref: number
    depth: number
    role: string
    title: string
    value: string
    pos: { x: number; y: number } | null
    path: number[]
  }

  /** backendNodeId → viewport top-left, from one DOMSnapshot pass. */
  async function layoutPositions(sessionId: string): Promise<Map<number, { x: number; y: number }>> {
    const pos = new Map<number, { x: number; y: number }>()
    try {
      await send('DOMSnapshot.enable', {}, { sessionId }).catch(() => { /* implicit on capture in newer builds */ })
      const snap = await send<{
        documents?: Array<{
          scrollOffsetX?: number
          scrollOffsetY?: number
          nodes?: { backendNodeId?: number[] }
          layout?: { nodeIndex?: number[]; bounds?: number[][] }
        }>
      }>('DOMSnapshot.captureSnapshot', { computedStyles: [] }, { sessionId, timeoutMs: SNAPSHOT_TIMEOUT_MS })
      const doc = snap.documents?.[0]
      if (!doc?.layout?.nodeIndex || !doc.layout.bounds || !doc.nodes?.backendNodeId) return pos
      const scrollX = doc.scrollOffsetX ?? 0
      const scrollY = doc.scrollOffsetY ?? 0
      const backendIds = doc.nodes.backendNodeId
      const { nodeIndex, bounds } = doc.layout
      for (let i = 0; i < nodeIndex.length; i++) {
        const nodeIdx = nodeIndex[i]
        const rect = bounds[i]
        if (nodeIdx === undefined || !rect || rect.length < 2) continue
        const backendId = backendIds[nodeIdx]
        if (backendId === undefined) continue
        pos.set(backendId, { x: (rect[0] ?? 0) - scrollX, y: (rect[1] ?? 0) - scrollY })
      }
    } catch { /* positions are best-effort decoration */ }
    return pos
  }

  /** Walk one frame's AX tree into rows. Returns rows appended count. */
  function walkAxTree(
    nodes: AxNode[],
    frameOrdinal: number,
    baseDepth: number,
    positions: Map<number, { x: number; y: number }>,
    rows: Row[],
    nextRef: () => number,
  ): void {
    const byId = new Map<string, AxNode>()
    for (const n of nodes) byId.set(n.nodeId, n)
    const referenced = new Set<string>()
    for (const n of nodes) for (const c of n.childIds ?? []) referenced.add(c)
    const roots = nodes.filter((n) => !n.parentId && !referenced.has(n.nodeId))
    const start = roots.length > 0 ? roots : nodes.slice(0, 1)

    const visit = (node: AxNode, depth: number): void => {
      if (rows.length >= MAX_TREE_NODES) return
      const role = String(node.role?.value ?? '')
      const title = String(node.name?.value ?? '')
      const rawValue = node.value?.value
      const value = rawValue === undefined || rawValue === null ? '' : String(rawValue)
      const silent = node.ignored === true || HIDDEN_ROLES.has(role) || (SILENT_ROLES.has(role) && !title && !value)
      let childDepth = depth
      if (!silent && (role || title || value)) {
        const backendId = node.backendDOMNodeId
        const pos = backendId !== undefined ? positions.get(backendId) ?? null : null
        rows.push({
          ref: nextRef(),
          depth,
          role,
          title,
          value,
          pos: pos ? { x: Math.round(pos.x), y: Math.round(pos.y) } : null,
          path: backendId !== undefined ? [frameOrdinal, backendId] : [frameOrdinal, -1],
        })
        childDepth = depth + 1
      }
      for (const childId of node.childIds ?? []) {
        if (rows.length >= MAX_TREE_NODES) return
        const child = byId.get(childId)
        if (child) visit(child, childDepth)
      }
    }
    for (const root of start) visit(root, baseDepth)
  }

  async function captureShots(wantShot: boolean): Promise<{ png: Buffer | null; visionPng: Buffer | null }> {
    if (!wantShot) return { png: null, visionPng: null }
    try {
      const full = await send<{ data: string }>('Page.captureScreenshot', { format: 'png' }, { timeoutMs: SNAPSHOT_TIMEOUT_MS })
      const png = Buffer.from(full.data, 'base64')
      let visionPng: Buffer | null = png
      try {
        const metrics = await send<{ cssVisualViewport?: { clientWidth?: number; clientHeight?: number } }>('Page.getLayoutMetrics')
        const w = metrics.cssVisualViewport?.clientWidth ?? 0
        const h = metrics.cssVisualViewport?.clientHeight ?? 0
        const maxDim = Math.max(w, h)
        if (maxDim > VISION_MAX_DIMENSION && w > 0 && h > 0) {
          // Chrome scales at capture time — no sips/external downsampler needed.
          const scaled = await send<{ data: string }>('Page.captureScreenshot', {
            format: 'png',
            clip: { x: 0, y: 0, width: w, height: h, scale: VISION_MAX_DIMENSION / maxDim },
          }, { timeoutMs: SNAPSHOT_TIMEOUT_MS })
          const scaledBuf = Buffer.from(scaled.data, 'base64')
          if (scaledBuf.length < png.length) visionPng = scaledBuf
        }
      } catch { /* vision copy falls back to the full shot */ }
      return { png, visionPng }
    } catch {
      return { png: null, visionPng: null }
    }
  }

  async function doSnapshot(opts?: SnapshotOptions): Promise<SnapshotResult> {
    await ensurePage(false)
    const sessionId = mainSessionId!
    const rows: Row[] = []
    let refCounter = 0
    const nextRef = () => ++refCounter

    const [axRaw, positions] = await Promise.all([
      send<{ nodes?: AxNode[] }>('Accessibility.getFullAXTree', {}, { sessionId, timeoutMs: SNAPSHOT_TIMEOUT_MS }),
      layoutPositions(sessionId),
    ])
    frameSessions = [sessionId]
    walkAxTree(axRaw.nodes ?? [], 0, 0, positions, rows, nextRef)

    // OOPIF merge: each cross-process iframe contributes its subtree.
    const children = [...childSessions.entries()].slice(0, MAX_OOPIF_FRAMES)
    for (const [childSessionId, info] of children) {
      if (rows.length >= MAX_TREE_NODES) break
      try {
        const childAx = await send<{ nodes?: AxNode[] }>('Accessibility.getFullAXTree', {}, { sessionId: childSessionId, timeoutMs: SNAPSHOT_TIMEOUT_MS })
        const ordinal = frameSessions.length
        frameSessions.push(childSessionId)
        rows.push({
          ref: nextRef(),
          depth: 0,
          role: 'Iframe',
          title: info.url,
          value: '',
          pos: null,
          path: [ordinal, -1],
        })
        walkAxTree(childAx.nodes ?? [], ordinal, 1, new Map(), rows, nextRef)
      } catch { /* detached mid-snapshot — skip the frame */ }
    }

    // Header line mirrors the macOS "Menu bar:" orientation line: stable per
    // page, changes only when title/URL actually change.
    let header = ''
    try {
      const nav = await send<{ entries?: Array<{ url?: string; title?: string }>; currentIndex?: number }>('Page.getNavigationHistory')
      const current = nav.entries?.[nav.currentIndex ?? -1]
      if (current) header = `Page: "${current.title ?? ''}" — ${current.url ?? ''}\n`
    } catch { /* header is optional */ }
    if (dialogNote) {
      header += `${dialogNote}\n`
      dialogNote = null
    }

    const body = rows
      .map((r) => {
        const indent = '  '.repeat(Math.min(r.depth, 8))
        const label = r.title ? ` "${r.title}"` : ''
        const val = r.value ? ` = ${r.value}` : ''
        const at = r.pos ? ` @(${r.pos.x},${r.pos.y})` : ''
        return `${indent}[${r.ref}] ${r.role || 'element'}${label}${val}${at}`
      })
      .join('\n')
    const tree = body ? `${header}${body}` : header.trimEnd()
    const refs: SnapshotRef[] = rows.map((r) => ({
      ref: r.ref,
      path: r.path,
      role: r.role,
      title: r.title,
      pos: r.pos,
    }))
    const shots = await captureShots(opts?.screenshot !== false)
    return {
      tree: tree || '(no accessible elements found)',
      refs,
      screenshotPng: shots.png,
      visionPng: shots.visionPng,
    }
  }

  // --- path resolution + identity check (stale wording locked to macOS driver) ---

  interface ResolvedNode {
    sessionId: string
    backendNodeId: number
  }

  async function resolvePathTarget(target: { path: number[]; role?: string; title?: string }): Promise<ResolvedNode> {
    await ensurePage(false)
    const ordinal = target.path[0]
    const backendNodeId = target.path[1]
    // Ordinal 0 is ALWAYS the current main frame (valid even right after a
    // reconnect); child-frame ordinals only exist relative to a snapshot.
    if (ordinal === undefined || ordinal < 0 || (ordinal > 0 && ordinal >= frameSessions.length)) {
      throw new Error('stale snapshot — window index out of range, re-snapshot first')
    }
    if (backendNodeId === undefined || backendNodeId < 0) {
      throw new Error('stale snapshot — element path no longer valid, re-snapshot first')
    }
    const sessionId = ordinal === 0 ? mainSessionId! : frameSessions[ordinal]!
    let role = ''
    let title = ''
    try {
      const partial = await send<{ nodes?: AxNode[] }>('Accessibility.getPartialAXTree', {
        backendNodeId,
        fetchRelatives: false,
      }, { sessionId })
      const node = partial.nodes?.[0]
      if (!node) throw new Error('gone')
      role = String(node.role?.value ?? '')
      title = String(node.name?.value ?? '')
    } catch {
      throw new Error('stale snapshot — element path no longer valid, re-snapshot first')
    }
    if (target.role && role !== target.role) {
      throw new Error('stale snapshot — element role changed (' + role + ' != ' + target.role + '), re-snapshot first')
    }
    if (target.title && title !== target.title) {
      throw new Error('stale snapshot — element title changed, re-snapshot first')
    }
    return { sessionId, backendNodeId }
  }

  /** Viewport center point of a resolved node (scrolled into view first). */
  async function nodeCenter(node: ResolvedNode): Promise<{ x: number; y: number }> {
    await send('DOM.scrollIntoViewIfNeeded', { backendNodeId: node.backendNodeId }, { sessionId: node.sessionId })
      .catch(() => { /* already in view / not scrollable */ })
    const quadsRes = await send<{ quads?: number[][] }>('DOM.getContentQuads', { backendNodeId: node.backendNodeId }, { sessionId: node.sessionId })
    const quad = quadsRes.quads?.[0]
    if (!quad || quad.length < 8) throw new Error('element has no on-screen position')
    // Quad = 4 corner points (x1,y1,…,x4,y4) — average for the center.
    const x = ((quad[0] ?? 0) + (quad[2] ?? 0) + (quad[4] ?? 0) + (quad[6] ?? 0)) / 4
    const y = ((quad[1] ?? 0) + (quad[3] ?? 0) + (quad[5] ?? 0) + (quad[7] ?? 0)) / 4
    return { x, y }
  }

  async function mouseClick(sessionId: string, x: number, y: number, button: 'left' | 'right', count: number): Promise<void> {
    const buttonName = button === 'right' ? 'right' : 'left'
    const buttons = button === 'right' ? 2 : 1
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0 }, { sessionId })
    for (let i = 1; i <= count; i++) {
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: buttonName, buttons, clickCount: i }, { sessionId })
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: buttonName, buttons: 0, clickCount: i }, { sessionId })
    }
  }

  async function viewportCenter(): Promise<{ x: number; y: number }> {
    const metrics = await send<{ cssVisualViewport?: { clientWidth?: number; clientHeight?: number } }>('Page.getLayoutMetrics')
    const w = metrics.cssVisualViewport?.clientWidth ?? 800
    const h = metrics.cssVisualViewport?.clientHeight ?? 600
    return { x: Math.round(w / 2), y: Math.round(h / 2) }
  }

  // --- key combo parsing (CDP flavor) ---

  interface CdpKeySpec {
    key: string
    code: string
    keyCode: number
    text?: string
  }

  const NAMED_KEYS: Record<string, CdpKeySpec> = {
    enter: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
    return: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
    tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
    escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
    esc: { key: 'Escape', code: 'Escape', keyCode: 27 },
    space: { key: ' ', code: 'Space', keyCode: 32, text: ' ' },
    backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
    delete: { key: 'Delete', code: 'Delete', keyCode: 46 },
    up: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
    down: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
    left: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
    right: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
    home: { key: 'Home', code: 'Home', keyCode: 36 },
    end: { key: 'End', code: 'End', keyCode: 35 },
    pageup: { key: 'PageUp', code: 'PageUp', keyCode: 33 },
    pagedown: { key: 'PageDown', code: 'PageDown', keyCode: 34 },
  }
  for (let i = 1; i <= 12; i++) {
    NAMED_KEYS[`f${i}`] = { key: `F${i}`, code: `F${i}`, keyCode: 111 + i }
  }

  function parseCdpCombo(combo: string): { spec: CdpKeySpec; modifiers: number } {
    const platform = chromeDeps.platform ?? process.platform
    const parts = combo.toLowerCase().split('+').map((s) => s.trim()).filter(Boolean)
    if (parts.length === 0) throw new Error(`empty key combo "${combo}"`)
    let modifiers = 0
    for (const part of parts.slice(0, -1)) {
      switch (part) {
        case 'cmd': case 'command': case 'meta':
          // cmd is Meta on macOS, Ctrl elsewhere (matches the tool contract).
          modifiers |= platform === 'darwin' ? 4 : 2
          break
        case 'ctrl': case 'control': modifiers |= 2; break
        case 'alt': case 'option': case 'opt': modifiers |= 1; break
        case 'shift': modifiers |= 8; break
        default: throw new Error(`unknown modifier "${part}" in combo "${combo}"`)
      }
    }
    const last = parts[parts.length - 1]!
    const named = NAMED_KEYS[last]
    if (named) return { spec: named, modifiers }
    if (last.length === 1) {
      const upper = last.toUpperCase()
      const isLetter = upper >= 'A' && upper <= 'Z'
      const spec: CdpKeySpec = {
        key: modifiers & 8 ? upper : last,
        code: isLetter ? `Key${upper}` : /[0-9]/.test(last) ? `Digit${last}` : '',
        keyCode: upper.charCodeAt(0),
        // Ctrl/Meta chords don't produce text input.
        text: modifiers & (2 | 4) ? undefined : (modifiers & 8 ? upper : last),
      }
      return { spec, modifiers }
    }
    throw new Error(`unknown key "${last}" in combo "${combo}"`)
  }

  async function dispatchKey(spec: CdpKeySpec, modifiers: number): Promise<void> {
    const base = {
      modifiers,
      key: spec.key,
      code: spec.code,
      windowsVirtualKeyCode: spec.keyCode,
      nativeVirtualKeyCode: spec.keyCode,
    }
    await send('Input.dispatchKeyEvent', { ...base, type: spec.text ? 'keyDown' : 'rawKeyDown', text: spec.text }, {})
    await send('Input.dispatchKeyEvent', { ...base, type: 'keyUp' }, {})
  }

  // --- browser-specific verbs ---

  async function pageState(): Promise<{ title: string; url: string }> {
    const res = await send<{ result?: { value?: unknown } }>('Runtime.evaluate', {
      expression: 'JSON.stringify({ title: document.title, url: location.href })',
      returnByValue: true,
    })
    try {
      const parsed = JSON.parse(String(res.result?.value ?? '{}')) as { title?: string; url?: string }
      return { title: parsed.title ?? '', url: parsed.url ?? '' }
    } catch {
      return { title: '', url: '' }
    }
  }

  async function waitForLoad(timeoutMs: number): Promise<void> {
    if (!conn) return
    try {
      await conn.waitForEvent('Page.loadEventFired', (_p, sessionId) => sessionId === mainSessionId, timeoutMs)
    } catch { /* SPA or slow page — proceed with whatever rendered */ }
  }

  const driver: CdpBrowserDriver = {
    async available(allowLaunch: boolean): Promise<boolean> {
      try {
        await ensurePage(allowLaunch)
        return true
      } catch {
        return false
      }
    },

    endpointInfo(): ChromeEndpoint | null {
      return endpoint
    },

    async listApps(): Promise<AppInfo[]> {
      // Not used by routing (list_apps always goes native) — kept meaningful
      // for direct driver consumers: one entry per open tab.
      await ensurePage(false)
      const targets = await listTargets(endpoint!.httpBase, fetchImpl)
      return targets
        .filter((t) => t.type === 'page')
        .map((t, i) => ({ name: t.title || t.url, frontmost: i === 0 }))
    },

    async snapshot(_app: string, opts?: SnapshotOptions): Promise<SnapshotResult> {
      return doSnapshot(opts)
    },

    async click(_app: string, target: ClickTarget, opts?: ClickOptions): Promise<void> {
      await ensurePage(false)
      const button = opts?.button ?? 'left'
      const count = opts?.count ?? 1
      if ('path' in target) {
        const node = await resolvePathTarget(target)
        const center = await nodeCenter(node)
        await mouseClick(node.sessionId, center.x, center.y, button, count)
        return
      }
      await mouseClick(mainSessionId!, target.x, target.y, button, count)
    },

    async locate(_app: string, target: { path: number[]; role?: string; title?: string }): Promise<{ x: number; y: number }> {
      const node = await resolvePathTarget(target)
      return nodeCenter(node)
    },

    async scroll(_app: string, opts: ScrollOptions): Promise<void> {
      await ensurePage(false)
      const amount = Math.max(1, Math.min(50, opts.amount ?? 5))
      const px = amount * 100
      const at = opts.at ?? (await viewportCenter())
      const deltaX = opts.direction === 'left' ? -px : opts.direction === 'right' ? px : 0
      const deltaY = opts.direction === 'up' ? -px : opts.direction === 'down' ? px : 0
      await send('Input.dispatchMouseEvent', {
        type: 'mouseWheel', x: at.x, y: at.y, deltaX, deltaY, button: 'none', buttons: 0,
      })
    },

    async drag(_app: string, from: { x: number; y: number }, to: { x: number; y: number }): Promise<void> {
      await ensurePage(false)
      const sessionId = mainSessionId!
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x, y: from.y, button: 'none', buttons: 0 }, { sessionId })
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: from.x, y: from.y, button: 'left', buttons: 1, clickCount: 1 }, { sessionId })
      const steps = 8
      for (let i = 1; i <= steps; i++) {
        const x = from.x + ((to.x - from.x) * i) / steps
        const y = from.y + ((to.y - from.y) * i) / steps
        await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'left', buttons: 1 }, { sessionId })
      }
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: to.x, y: to.y, button: 'left', buttons: 0, clickCount: 1 }, { sessionId })
    },

    async type(_app: string, text: string): Promise<void> {
      await ensurePage(false)
      // insertText is the fast, IME-safe path; real Enter keystrokes between
      // segments so forms/editors see submission semantics.
      const segments = text.split('\n')
      for (let i = 0; i < segments.length; i++) {
        const segment = segments[i]!
        if (segment.length > 0) await send('Input.insertText', { text: segment })
        if (i < segments.length - 1) await dispatchKey(NAMED_KEYS.enter!, 0)
      }
    },

    async setValue(_app: string, target: { path: number[]; role?: string; title?: string }, text: string): Promise<void> {
      const node = await resolvePathTarget(target)
      const resolved = await send<{ object?: { objectId?: string } }>('DOM.resolveNode', { backendNodeId: node.backendNodeId }, { sessionId: node.sessionId })
      const objectId = resolved.object?.objectId
      if (!objectId) throw new Error('stale snapshot — element path no longer valid, re-snapshot first')
      const call = await send<{ result?: { value?: unknown } }>('Runtime.callFunctionOn', {
        objectId,
        // Native value setter (framework-controlled inputs ignore plain
        // .value writes) + input/change events so React/Vue models update.
        functionDeclaration: `function(v) {
          const el = this;
          const proto = el instanceof HTMLInputElement ? HTMLInputElement.prototype
            : el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : null;
          if (proto) {
            const desc = Object.getOwnPropertyDescriptor(proto, 'value');
            if (desc && desc.set) desc.set.call(el, v); else el.value = v;
          } else if (el.isContentEditable) {
            el.textContent = v;
          } else {
            return 'unwritable';
          }
          try { el.focus(); } catch (e) {}
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          return 'ok';
        }`,
        arguments: [{ value: text }],
        returnByValue: true,
      }, { sessionId: node.sessionId })
      if (call.result?.value !== 'ok') {
        throw new Error('element does not accept direct value writes — click it and use type/paste_text instead')
      }
    },

    async key(_app: string, combo: string): Promise<void> {
      await ensurePage(false)
      const { spec, modifiers } = parseCdpCombo(combo)
      await dispatchKey(spec, modifiers)
    },

    async focusApp(_app: string): Promise<void> {
      await ensurePage(false)
      await send('Page.bringToFront')
    },

    async launchApp(_app: string): Promise<void> {
      await ensurePage(true)
      await send('Page.bringToFront').catch(() => { /* window may still be materializing */ })
    },

    async menuSelect(_app: string, path: string[]): Promise<void> {
      throw new Error(`browser menus are not exposed over CDP (asked for "${path.join(' > ')}") — use navigate/tabs/js_eval or a key combo instead`)
    },

    async pasteText(_app: string, text: string): Promise<void> {
      await ensurePage(false)
      // Direct insertText — no OS clipboard mutation, works backgrounded.
      await send('Input.insertText', { text })
    },

    async checkPermissions(): Promise<PermissionStatus> {
      return {
        accessibility: true,
        screenRecording: true,
        detail: 'CDP backend — no OS accessibility/screen-recording permissions required (input + screenshots go through the DevTools protocol).',
      }
    },

    // --- browser-specific verbs ---

    async navigate(target: string): Promise<string> {
      await ensurePage(true)
      const trimmed = target.trim()
      if (trimmed === 'back' || trimmed === 'forward') {
        const nav = await send<{ currentIndex?: number; entries?: Array<{ id: number; url?: string }> }>('Page.getNavigationHistory')
        const idx = (nav.currentIndex ?? 0) + (trimmed === 'back' ? -1 : 1)
        const entry = nav.entries?.[idx]
        if (!entry) return `Cannot go ${trimmed} — no history entry in that direction.`
        await send('Page.navigateToHistoryEntry', { entryId: entry.id })
        await waitForLoad(NAVIGATE_WAIT_MS)
        const state = await pageState()
        return `Went ${trimmed} to "${state.title}" — ${state.url}`
      }
      if (trimmed === 'reload') {
        await send('Page.reload')
        await waitForLoad(NAVIGATE_WAIT_MS)
        const state = await pageState()
        return `Reloaded "${state.title}" — ${state.url}`
      }
      const url = normalizeNavigationUrl(trimmed)
      const res = await send<{ errorText?: string }>('Page.navigate', { url }, { timeoutMs: NAVIGATE_WAIT_MS })
      if (res.errorText) throw new Error(`navigation to ${url} failed: ${res.errorText}`)
      await waitForLoad(NAVIGATE_WAIT_MS)
      const state = await pageState()
      return `Navigated to "${state.title}" — ${state.url}`
    },

    async readPage(): Promise<string> {
      await ensurePage(false)
      const res = await send<{ result?: { value?: unknown }; exceptionDetails?: unknown }>('Runtime.evaluate', {
        expression: `JSON.stringify({
          title: document.title,
          url: location.href,
          text: document.body ? document.body.innerText : '',
        })`,
        returnByValue: true,
      }, { timeoutMs: SNAPSHOT_TIMEOUT_MS })
      let parsed: { title?: string; url?: string; text?: string } = {}
      try {
        parsed = JSON.parse(String(res.result?.value ?? '{}')) as typeof parsed
      } catch { /* fall through to empty */ }
      const text = parsed.text ?? ''
      const truncated = text.length > READ_PAGE_MAX_CHARS
      const bodyText = truncated ? `${text.slice(0, READ_PAGE_MAX_CHARS)}\n…(truncated at ${READ_PAGE_MAX_CHARS} chars)` : text
      return `Page: "${parsed.title ?? ''}" — ${parsed.url ?? ''}\n\n${bodyText || '(page has no visible text)'}`
    },

    async evalJs(expression: string): Promise<string> {
      await ensurePage(false)
      const res = await send<{
        result?: { value?: unknown; description?: string; type?: string }
        exceptionDetails?: { text?: string; exception?: { description?: string } }
      }>('Runtime.evaluate', {
        expression,
        returnByValue: true,
        awaitPromise: true,
        userGesture: true,
        timeout: 10_000,
      }, { timeoutMs: SNAPSHOT_TIMEOUT_MS })
      if (res.exceptionDetails) {
        const detail = res.exceptionDetails.exception?.description ?? res.exceptionDetails.text ?? 'unknown error'
        throw new Error(`js_eval threw: ${detail}`)
      }
      const value = res.result?.value
      if (value === undefined) return res.result?.description ?? String(res.result?.type ?? 'undefined')
      const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
      return text.length > READ_PAGE_MAX_CHARS ? `${text.slice(0, READ_PAGE_MAX_CHARS)}\n…(truncated)` : text
    },

    async tabs(op: 'list' | 'activate' | 'new' | 'close', arg?: { index?: number; url?: string }): Promise<string> {
      await ensurePage(op === 'new')
      const raw = await send<{ targetInfos?: TargetInfo[] }>('Target.getTargets')
      const pages = (raw.targetInfos ?? []).filter(
        (t) => t.type === 'page' && !t.url.startsWith('devtools://') && !t.url.startsWith('chrome-extension://'),
      )
      const listText = () => pages
        .map((t, i) => `${i + 1}. ${t.targetId === activeTargetId ? '* ' : ''}"${t.title}" — ${t.url}`)
        .join('\n')
      if (op === 'list') {
        return pages.length > 0 ? `Open tabs (* = active):\n${listText()}` : 'No open tabs.'
      }
      if (op === 'new') {
        const url = arg?.url && arg.url.trim() ? normalizeNavigationUrl(arg.url) : 'about:blank'
        const created = await send<{ targetId: string }>('Target.createTarget', { url })
        await attachToPage(created.targetId)
        await waitForLoad(NAVIGATE_WAIT_MS)
        const state = await pageState()
        return `Opened new tab: "${state.title}" — ${state.url}`
      }
      const index = arg?.index
      if (typeof index !== 'number' || index < 1 || index > pages.length) {
        return `tabs ${op} requires "tab" between 1 and ${pages.length}. Current tabs:\n${listText()}`
      }
      const targetTab = pages[index - 1]!
      if (op === 'activate') {
        await send('Target.activateTarget', { targetId: targetTab.targetId })
        await attachToPage(targetTab.targetId)
        return `Activated tab ${index}: "${targetTab.title}" — ${targetTab.url}`
      }
      // close
      await send('Target.closeTarget', { targetId: targetTab.targetId })
      if (targetTab.targetId === activeTargetId) {
        mainSessionId = null
        activeTargetId = null
      }
      return `Closed tab ${index}: "${targetTab.title}"`
    },

    async adopt(rawEndpoint: string): Promise<string> {
      const adopted = await adoptEndpoint(rawEndpoint, chromeDeps)
      endpoint = adopted
      // Drop the old connection — next action reconnects to the adopted browser.
      conn?.close()
      conn = null
      mainSessionId = null
      activeTargetId = null
      childSessions.clear()
      frameSessions = []
      await ensurePage(false)
      const version = await discoverBrowser(adopted.httpBase, fetchImpl)
      return `Adopted browser at ${adopted.httpBase} (${version.browser}) — subsequent browser actions use this instance.`
    },
  }

  return driver
}
