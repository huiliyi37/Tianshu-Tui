/**
 * browser-debug/driver — Playwright-backed CDP driver (lazy, optional dep).
 *
 * Two connection modes (mirroring Codex CLI / chrome-devtools-mcp --browser-url):
 *  - **launch** — launchPersistentContext with a user-data-dir (login persists);
 *  - **connect** — connectOverCDP to an existing Chrome (--remote-debugging-port).
 *    close() only disconnects; it does NOT quit the user's browser.
 */

export interface DriverEvents {
  onConsole(level: string, text: string): void
  onRequestStart(requestId: string, method: string, url: string): void
  onResponse(requestId: string, status: number): void
  onRequestFailed(requestId: string, method: string, url: string, errorText?: string): void
}

export interface BrowserDebugDriver {
  goto(url: string): Promise<void>
  evaluate(expression: string): Promise<string>
  screenshot(): Promise<Buffer>
  snapshot(selector?: string): Promise<string>
  click(selector: string): Promise<void>
  type(selector: string, text: string): Promise<void>
  waitForSelector(selector: string, timeoutMs?: number): Promise<void>
  currentUrl(): string
  bringToFront(): Promise<void>
  close(): Promise<void>
}

export interface DriverLaunchOptions {
  headless: boolean
  userDataDir: string
  events: DriverEvents
  /** When set, connect to an existing Chrome via CDP instead of launching. */
  connectUrl?: string
}

export type BrowserDebugDriverFactory = (opts: DriverLaunchOptions) => Promise<BrowserDebugDriver>

// Minimal structural typings for the slice of Playwright we touch. Kept local
// so tsc never needs the optional 'playwright' types at build time.
interface PwRequest {
  method(): string
  url(): string
  failure(): { errorText: string } | null
}
interface PwResponse {
  status(): number
  request(): PwRequest
}
interface PwConsoleMessage {
  type(): string
  text(): string
}
interface PwPage {
  goto(url: string, opts: Record<string, unknown>): Promise<unknown>
  evaluate(expr: string): Promise<unknown>
  screenshot(opts: Record<string, unknown>): Promise<Buffer>
  click(selector: string, opts: Record<string, unknown>): Promise<void>
  fill(selector: string, text: string, opts: Record<string, unknown>): Promise<void>
  textContent(selector: string, opts?: Record<string, unknown>): Promise<string | null>
  waitForSelector(selector: string, opts: Record<string, unknown>): Promise<unknown>
  url(): string
  bringToFront(): Promise<void>
  on(event: string, handler: (arg: never) => void): void
}
interface PwContext {
  pages(): PwPage[]
  newPage(): Promise<PwPage>
  close(): Promise<void>
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

/** Wire Playwright page events into our DriverEvents sink. */
function wireEvents(page: PwPage, events: DriverEvents): void {
  let seq = 0
  const ids = new WeakMap<PwRequest, string>()
  const idFor = (req: PwRequest): string => {
    let id = ids.get(req)
    if (!id) {
      id = `r${++seq}`
      ids.set(req, id)
    }
    return id
  }

  page.on('console', ((msg: PwConsoleMessage) => {
    try {
      events.onConsole(msg.type(), msg.text())
    } catch {
      /* ignore malformed console events */
    }
  }) as never)

  page.on('pageerror', ((err: Error) => {
    events.onConsole('error', err?.message ?? String(err))
  }) as never)

  page.on('request', ((req: PwRequest) => {
    events.onRequestStart(idFor(req), req.method(), req.url())
  }) as never)

  page.on('response', ((res: PwResponse) => {
    try {
      events.onResponse(idFor(res.request()), res.status())
    } catch {
      /* ignore */
    }
  }) as never)

  page.on('requestfailed', ((req: PwRequest) => {
    events.onRequestFailed(idFor(req), req.method(), req.url(), req.failure()?.errorText)
  }) as never)
}

function buildDriver(page: PwPage, closeFn: () => Promise<void>): BrowserDebugDriver {
  return {
    goto: async (url) => {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 })
    },
    evaluate: async (expression) => stringifyEvalResult(await page.evaluate(expression)),
    screenshot: () => page.screenshot({ fullPage: true }),
    snapshot: async (selector) => {
      if (selector) return (await page.textContent(selector, { timeout: 10_000 })) ?? ''
      return String(await page.evaluate('document.body?.innerText ?? ""'))
    },
    click: (selector) => page.click(selector, { timeout: 10_000 }),
    type: (selector, text) => page.fill(selector, text, { timeout: 10_000 }),
    waitForSelector: (selector, timeoutMs = 10_000) =>
      page.waitForSelector(selector, { state: 'visible', timeout: timeoutMs }).then(() => undefined),
    currentUrl: () => page.url(),
    bringToFront: () => page.bringToFront(),
    close: closeFn,
  }
}

/** Default driver: launch a persistent context (headed by default). */
export const playwrightDriverFactory: BrowserDebugDriverFactory = async (opts) => {
  const mod = await loadPlaywright()
  const context = await mod.chromium.launchPersistentContext(opts.userDataDir, {
    headless: opts.headless,
    viewport: { width: 1280, height: 800 },
  })

  const existing = context.pages()
  const page = existing.length > 0 ? existing[0]! : await context.newPage()
  wireEvents(page, opts.events)
  return buildDriver(page, () => context.close())
}

/** Connect to an existing Chrome started with --remote-debugging-port. */
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
  wireEvents(page, opts.events)
  // disconnect only — do not quit the user's Chrome
  return buildDriver(page, () => browser.close())
}

/** Route to launch or connect based on opts.connectUrl. */
export const defaultDriverFactory: BrowserDebugDriverFactory = async (opts) =>
  opts.connectUrl ? playwrightConnectFactory(opts) : playwrightDriverFactory(opts)
