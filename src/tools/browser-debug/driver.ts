/**
 * browser-debug/driver — Playwright-backed CDP driver (lazy, optional dep).
 */

import { shouldCaptureResponseBody, truncateResponseBody } from './log-capture.js'

export interface DriverEvents {
  onConsole(level: string, text: string): void
  onRequestStart(
    requestId: string,
    method: string,
    url: string,
    resourceType?: string,
    headers?: Record<string, string>,
    postData?: string,
  ): void
  onResponse(requestId: string, status: number, resourceType?: string, headers?: Record<string, string>): void
  onRequestFailed(requestId: string, method: string, url: string, errorText?: string, resourceType?: string): void
  onResponseBody(requestId: string, body: string, contentType?: string): void
}

export type LoadState = 'load' | 'domcontentloaded' | 'networkidle'
export type ScrollTarget = 'top' | 'bottom'
export type StorageKind = 'local' | 'session'

export interface BrowserCookie {
  name: string
  value: string
  domain?: string
  path?: string
  expires?: number
  httpOnly?: boolean
  secure?: boolean
  sameSite?: string
}

export interface BrowserDebugDriver {
  goto(url: string, signal?: AbortSignal): Promise<void>
  evaluate(expression: string): Promise<string>
  screenshot(): Promise<Buffer>
  snapshot(selector?: string): Promise<string>
  click(selector: string): Promise<void>
  type(selector: string, text: string): Promise<void>
  press(selector: string | undefined, key: string): Promise<void>
  selectOption(selector: string, value: string): Promise<string[]>
  hover(selector: string): Promise<void>
  scroll(selector: string | undefined, to: ScrollTarget): Promise<void>
  waitForSelector(selector: string, timeoutMs?: number, signal?: AbortSignal): Promise<void>
  waitForLoadState(state: LoadState, timeoutMs?: number, signal?: AbortSignal): Promise<void>
  reload(signal?: AbortSignal): Promise<void>
  goBack(signal?: AbortSignal): Promise<boolean>
  goForward(signal?: AbortSignal): Promise<boolean>
  cookies(urlFilter?: string): Promise<BrowserCookie[]>
  storage(kind: StorageKind): Promise<Record<string, string>>
  addCookie(cookie: { name: string; value: string; url?: string; domain?: string; path?: string }): Promise<void>
  clearCookies(): Promise<void>
  setStorage(kind: StorageKind, key: string, value: string): Promise<void>
  clearStorage(kind: StorageKind): Promise<void>
  currentUrl(): string
  /** URLs of all open pages/tabs in the context (active page last). */
  pageUrls(): string[]
  bringToFront(): Promise<void>
  close(): Promise<void>
}

export interface DriverLaunchOptions {
  headless: boolean
  userDataDir: string
  events: DriverEvents
  connectUrl?: string
}

export type BrowserDebugDriverFactory = (opts: DriverLaunchOptions) => Promise<BrowserDebugDriver>

interface PwRequest {
  method(): string
  url(): string
  resourceType(): string
  failure(): { errorText: string } | null
  headers(): Record<string, string>
  postData(): string | null
}
interface PwResponse {
  status(): number
  request(): PwRequest
  headers(): Record<string, string>
  text(): Promise<string>
}
interface PwConsoleMessage {
  type(): string
  text(): string
}
interface PwKeyboard {
  press(key: string): Promise<void>
}
interface PwPage {
  goto(url: string, opts: Record<string, unknown>): Promise<unknown>
  evaluate(expr: string): Promise<unknown>
  screenshot(opts: Record<string, unknown>): Promise<Buffer>
  click(selector: string, opts: Record<string, unknown>): Promise<void>
  fill(selector: string, text: string, opts: Record<string, unknown>): Promise<void>
  press(selector: string, key: string, opts: Record<string, unknown>): Promise<void>
  selectOption(selector: string, value: string, opts: Record<string, unknown>): Promise<string[]>
  hover(selector: string, opts: Record<string, unknown>): Promise<void>
  textContent(selector: string, opts?: Record<string, unknown>): Promise<string | null>
  waitForSelector(selector: string, opts: Record<string, unknown>): Promise<unknown>
  waitForLoadState(state: string, opts: Record<string, unknown>): Promise<void>
  reload(opts: Record<string, unknown>): Promise<unknown>
  goBack(opts: Record<string, unknown>): Promise<unknown>
  goForward(opts: Record<string, unknown>): Promise<unknown>
  keyboard: PwKeyboard
  url(): string
  bringToFront(): Promise<void>
  on(event: string, handler: (arg: never) => void): void
}
interface PwContext {
  pages(): PwPage[]
  newPage(): Promise<PwPage>
  close(): Promise<void>
  cookies(urls?: string | string[]): Promise<BrowserCookie[]>
  addCookies(cookies: unknown[]): Promise<void>
  clearCookies(): Promise<void>
  on(event: string, handler: (arg: never) => void): void
}
interface PwBrowser {
  contexts(): PwContext[]
  close(): Promise<void>
}
interface PwChromium {
  launchPersistentContext(userDataDir: string, opts: Record<string, unknown>): Promise<PwContext>
  connectOverCDP(endpointUrl: string): Promise<PwBrowser>
}

async function loadPlaywright(): Promise<{ chromium: PwChromium }> {
  const specifier = 'playwright'
  try {
    return (await import(specifier)) as never
  } catch {
    throw new Error(
      'Playwright is not installed. Run `npm i -D playwright && npx playwright install chromium`.',
    )
  }
}

function stringifyEvalResult(result: unknown): string {
  if (result === undefined) return 'undefined'
  if (typeof result === 'string') return result
  try {
    return JSON.stringify(result, null, 2)
  } catch {
    return String(result)
  }
}

function mergeAbortSignal(timeoutMs: number, signal?: AbortSignal): { signal?: AbortSignal; cleanup?: () => void } {
  if (!signal) return {}
  if (signal.aborted) return { signal }
  const controller = new AbortController()
  const onAbort = () => controller.abort(signal.reason)
  signal.addEventListener('abort', onAbort)
  const timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs)
  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
    },
  }
}

async function captureResponseBody(res: PwResponse, requestId: string, events: DriverEvents): Promise<void> {
  try {
    const headers = res.headers()
    const contentType = headers['content-type'] ?? headers['Content-Type']
    const text = await res.text()
    const { body } = truncateResponseBody(text)
    events.onResponseBody(requestId, body, contentType)
  } catch {
    /* binary or unreadable body — skip */
  }
}

/** Wire Playwright page events into our DriverEvents sink. The id counter is
 *  shared across all pages of a session so popup/tab requests don't collide
 *  with the main page's request ids (r1, r2, …). */
function wireEvents(page: PwPage, events: DriverEvents, counter: { seq: number }): void {
  const ids = new WeakMap<PwRequest, string>()
  const idFor = (req: PwRequest): string => {
    let id = ids.get(req)
    if (!id) {
      id = `r${++counter.seq}`
      ids.set(req, id)
    }
    return id
  }

  page.on('console', ((msg: PwConsoleMessage) => {
    try {
      events.onConsole(msg.type(), msg.text())
    } catch {
      /* ignore */
    }
  }) as never)

  page.on('pageerror', ((err: Error) => {
    events.onConsole('error', err?.message ?? String(err))
  }) as never)

  page.on('request', ((req: PwRequest) => {
    try {
      let headers: Record<string, string> | undefined
      let postData: string | undefined
      try { headers = req.headers() } catch { /* ignore */ }
      try { postData = req.postData() ?? undefined } catch { /* ignore */ }
      events.onRequestStart(idFor(req), req.method(), req.url(), req.resourceType(), headers, postData)
    } catch {
      /* ignore */
    }
  }) as never)

  page.on('response', ((res: PwResponse) => {
    try {
      const req = res.request()
      const id = idFor(req)
      const resourceType = req.resourceType()
      const status = res.status()
      let headers: Record<string, string> | undefined
      try { headers = res.headers() } catch { /* ignore */ }
      events.onResponse(id, status, resourceType, headers)
      if (shouldCaptureResponseBody(resourceType, status)) {
        void captureResponseBody(res, id, events)
      }
    } catch {
      /* ignore */
    }
  }) as never)

  page.on('requestfailed', ((req: PwRequest) => {
    try {
      events.onRequestFailed(idFor(req), req.method(), req.url(), req.failure()?.errorText, req.resourceType())
    } catch {
      /* ignore */
    }
  }) as never)
}

export interface PageTracker {
  getActivePage(): PwPage
  pageUrls(): string[]
}

/**
 * Track every page/tab in a context. The active page is the most recently
 * opened one (so OAuth popups become the action target); when the active page
 * closes we fall back to the last remaining open page (back to the app after
 * the login popup closes). Every page's console/network is wired to the sink.
 */
export function attachPageTracker(
  context: PwContext,
  events: DriverEvents,
  initial: PwPage,
): PageTracker {
  const counter = { seq: 0 }
  let active = initial
  const known = new WeakSet<PwPage>()
  const track = (page: PwPage): void => {
    if (known.has(page)) return
    known.add(page)
    wireEvents(page, events, counter)
    active = page
    page.on('close', (() => {
      if (active !== page) return
      const open = context.pages().filter((p) => p !== page)
      if (open.length > 0) active = open[open.length - 1]!
    }) as never)
  }
  track(initial)
  context.on('page', ((page: PwPage) => {
    try { track(page) } catch { /* ignore */ }
  }) as never)
  return {
    getActivePage: () => active,
    pageUrls: () => context.pages().map((p) => p.url()),
  }
}

function buildDriver(
  getPage: () => PwPage,
  context: PwContext,
  pageUrls: () => string[],
  closeFn: () => Promise<void>,
): BrowserDebugDriver {
  return {
    goto: async (url, signal) => {
      const page = getPage()
      const merged = mergeAbortSignal(30_000, signal)
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000, signal: merged.signal })
      } finally {
        merged.cleanup?.()
      }
    },
    evaluate: async (expression) => stringifyEvalResult(await getPage().evaluate(expression)),
    screenshot: () => getPage().screenshot({ fullPage: true }),
    snapshot: async (selector) => {
      const page = getPage()
      if (selector) return (await page.textContent(selector, { timeout: 10_000 })) ?? ''
      return String(await page.evaluate('document.body?.innerText ?? ""'))
    },
    click: (selector) => getPage().click(selector, { timeout: 10_000 }),
    type: (selector, text) => getPage().fill(selector, text, { timeout: 10_000 }),
    press: async (selector, key) => {
      const page = getPage()
      if (selector) await page.press(selector, key, { timeout: 10_000 })
      else await page.keyboard.press(key)
    },
    selectOption: (selector, value) => getPage().selectOption(selector, value, { timeout: 10_000 }),
    hover: (selector) => getPage().hover(selector, { timeout: 10_000 }),
    scroll: async (selector, to) => {
      const page = getPage()
      if (selector) {
        const sel = JSON.stringify(selector)
        await page.evaluate(
          `document.querySelector(${sel})?.scrollIntoView({ block: 'center', inline: 'nearest' })`,
        )
      } else if (to === 'top') {
        await page.evaluate('window.scrollTo(0, 0)')
      } else {
        await page.evaluate('window.scrollTo(0, document.body.scrollHeight)')
      }
    },
    waitForSelector: async (selector, timeoutMs = 10_000, signal) => {
      const merged = mergeAbortSignal(timeoutMs, signal)
      try {
        await getPage().waitForSelector(selector, { state: 'visible', timeout: timeoutMs, signal: merged.signal })
      } finally {
        merged.cleanup?.()
      }
    },
    waitForLoadState: async (state, timeoutMs = 10_000, signal) => {
      const merged = mergeAbortSignal(timeoutMs, signal)
      try {
        await getPage().waitForLoadState(state, { timeout: timeoutMs, signal: merged.signal })
      } finally {
        merged.cleanup?.()
      }
    },
    reload: async (signal) => {
      const merged = mergeAbortSignal(30_000, signal)
      try {
        await getPage().reload({ waitUntil: 'domcontentloaded', timeout: 30_000, signal: merged.signal })
      } finally {
        merged.cleanup?.()
      }
    },
    goBack: async (signal) => {
      const merged = mergeAbortSignal(30_000, signal)
      try {
        const res = await getPage().goBack({ waitUntil: 'domcontentloaded', timeout: 30_000, signal: merged.signal })
        return res !== null
      } finally {
        merged.cleanup?.()
      }
    },
    goForward: async (signal) => {
      const merged = mergeAbortSignal(30_000, signal)
      try {
        const res = await getPage().goForward({ waitUntil: 'domcontentloaded', timeout: 30_000, signal: merged.signal })
        return res !== null
      } finally {
        merged.cleanup?.()
      }
    },
    cookies: async (urlFilter) => {
      const all = await context.cookies()
      if (!urlFilter) return all
      return all.filter((c) => `${c.domain ?? ''}${c.path ?? ''} ${c.name}`.includes(urlFilter))
    },
    storage: async (kind) => {
      const varName = kind === 'session' ? 'sessionStorage' : 'localStorage'
      const expr = `(() => { const s = ${varName}; const o = {}; for (let i = 0; i < s.length; i++) { const k = s.key(i); if (k != null) o[k] = s.getItem(k); } return o; })()`
      const result = await getPage().evaluate(expr)
      return result && typeof result === 'object' ? (result as Record<string, string>) : {}
    },
    addCookie: async (cookie) => {
      const c: Record<string, unknown> = { name: cookie.name, value: cookie.value }
      if (cookie.url) c.url = cookie.url
      if (cookie.domain) c.domain = cookie.domain
      if (cookie.path) c.path = cookie.path
      await context.addCookies([c])
    },
    clearCookies: () => context.clearCookies(),
    setStorage: async (kind, key, value) => {
      const varName = kind === 'session' ? 'sessionStorage' : 'localStorage'
      await getPage().evaluate(`${varName}.setItem(${JSON.stringify(key)}, ${JSON.stringify(value)})`)
    },
    clearStorage: async (kind) => {
      const varName = kind === 'session' ? 'sessionStorage' : 'localStorage'
      await getPage().evaluate(`${varName}.clear()`)
    },
    currentUrl: () => getPage().url(),
    pageUrls,
    bringToFront: () => getPage().bringToFront(),
    close: closeFn,
  }
}

export const playwrightDriverFactory: BrowserDebugDriverFactory = async (opts) => {
  const mod = await loadPlaywright()
  const context = await mod.chromium.launchPersistentContext(opts.userDataDir, {
    headless: opts.headless,
    viewport: { width: 1280, height: 800 },
  })
  const existing = context.pages()
  const page = existing.length > 0 ? existing[0]! : await context.newPage()
  const tracker = attachPageTracker(context, opts.events, page)
  return buildDriver(tracker.getActivePage, context, tracker.pageUrls, () => context.close())
}

export const playwrightConnectFactory: BrowserDebugDriverFactory = async (opts) => {
  if (!opts.connectUrl) {
    throw new Error('connectUrl is required for CDP connect mode')
  }
  const mod = await loadPlaywright()
  const browser = await mod.chromium.connectOverCDP(opts.connectUrl)
  const context = browser.contexts()[0]
  if (!context) {
    await browser.close()
    throw new Error(`No browser context found at ${opts.connectUrl}. Is Chrome running with --remote-debugging-port?`)
  }
  const existing = context.pages()
  const page = existing.length > 0 ? existing[0]! : await context.newPage()
  const tracker = attachPageTracker(context, opts.events, page)
  return buildDriver(tracker.getActivePage, context, tracker.pageUrls, () => browser.close())
}

export const defaultDriverFactory: BrowserDebugDriverFactory = async (opts) =>
  opts.connectUrl ? playwrightConnectFactory(opts) : playwrightDriverFactory(opts)
