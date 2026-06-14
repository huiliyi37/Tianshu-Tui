/**
 * browser — headless browser verification tool (N4).
 *
 * New attack surface, so it is locked down hard:
 *  - requiresApproval() ALWAYS true — every action goes through the N2 approval
 *    gate (a human confirms each navigation).
 *  - URL host must be on a fail-closed allowlist (empty allowlist = deny all).
 *  - screenshots are persisted as `screenshot`-kind Artifacts (base64 PNG) so the
 *    desktop browser panel can render them.
 *
 * The Playwright dependency is loaded lazily through an injectable driver factory
 * so the tool ships without forcing the browser binaries on every install, and so
 * the security logic is unit-testable with a fake driver.
 */
import type { Tool, ToolCallParams, ToolResult } from './types.js'

export interface BrowserDriver {
  goto(url: string): Promise<void>
  screenshot(): Promise<Buffer>
  textContent(selector?: string): Promise<string>
  click(selector: string): Promise<void>
  close(): Promise<void>
}

export type BrowserDriverFactory = () => Promise<BrowserDriver>

export interface BrowserToolOptions {
  /** Builds a live browser session. Defaults to headless Playwright (lazy). */
  driverFactory?: BrowserDriverFactory
  /** Returns the allowed host list. Empty ⇒ deny all (fail-closed). */
  allowlist?: () => string[]
  enabled?: boolean
}

/** Default allowlist: comma-separated hosts in RIVET_BROWSER_ALLOWLIST. */
function envAllowlist(): string[] {
  return (process.env.RIVET_BROWSER_ALLOWLIST ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
}

export function isHostAllowed(host: string, allowlist: string[]): boolean {
  if (allowlist.length === 0) return false // fail-closed
  const h = host.toLowerCase()
  return allowlist.some((entry) => h === entry || h.endsWith('.' + entry))
}

async function playwrightDriver(): Promise<BrowserDriver> {
  // Dynamic specifier via a variable so tsc doesn't try to resolve the optional
  // 'playwright' types at build time.
  const specifier = 'playwright'
  let mod: { chromium: { launch: (o: { headless: boolean }) => Promise<unknown> } }
  try {
    mod = (await import(specifier)) as never
  } catch {
    throw new Error('Playwright is not installed. Run `npm i -D playwright && npx playwright install chromium`.')
  }
  const browser = (await mod.chromium.launch({ headless: true })) as {
    newPage: () => Promise<never>
    close: () => Promise<void>
  }
  const page = (await browser.newPage()) as {
    goto: (u: string, o: Record<string, unknown>) => Promise<unknown>
    screenshot: (o: Record<string, unknown>) => Promise<Buffer>
    textContent: (s: string) => Promise<string | null>
    evaluate: (fn: string) => Promise<string>
    click: (s: string) => Promise<void>
  }
  return {
    goto: async (url) => { await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 }) },
    screenshot: () => page.screenshot({ fullPage: true }),
    textContent: async (selector) =>
      selector
        ? (await page.textContent(selector)) ?? ''
        : await page.evaluate('document.body.innerText'),
    click: (selector) => page.click(selector),
    close: () => browser.close(),
  }
}

type BrowserAction = 'screenshot' | 'text' | 'click'

export function createBrowserTool(options: BrowserToolOptions = {}): Tool {
  const driverFactory = options.driverFactory ?? playwrightDriver
  const allowlist = options.allowlist ?? envAllowlist
  const enabled = options.enabled ?? false

  return {
    definition: {
      name: 'browser',
      description: `Drive a headless browser to verify web UIs. Navigate to an allowlisted URL and screenshot it, extract text, or click an element.
ALWAYS requires explicit human approval and the target host must be on the configured allowlist (fail-closed). Screenshots are saved as viewable artifacts.`,
      input_schema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['screenshot', 'text', 'click'], description: 'What to do after navigating.' },
          url: { type: 'string', description: 'URL to navigate to (host must be allowlisted).' },
          selector: { type: 'string', description: 'CSS selector for text/click actions.' },
        },
        required: ['action', 'url'],
      },
    },

    async execute(params: ToolCallParams): Promise<ToolResult> {
      const action = params.input.action as BrowserAction
      const rawUrl = params.input.url as string
      const selector = params.input.selector as string | undefined

      let url: URL
      try {
        url = new URL(rawUrl)
      } catch {
        return { content: `Invalid URL: ${rawUrl}`, isError: true }
      }
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        return { content: `Unsupported protocol: ${url.protocol}. Only http/https allowed.`, isError: true }
      }

      const list = allowlist()
      if (!isHostAllowed(url.hostname, list)) {
        return {
          content:
            `browser blocked: host "${url.hostname}" is not on the allowlist (fail-closed). ` +
            (list.length === 0
              ? 'No hosts are allowlisted — set RIVET_BROWSER_ALLOWLIST.'
              : `Allowed: ${list.join(', ')}.`),
          isError: true,
        }
      }

      let driver: BrowserDriver | null = null
      try {
        driver = await driverFactory()
        await driver.goto(rawUrl)

        if (action === 'click') {
          if (!selector) return { content: 'click requires a "selector".', isError: true }
          await driver.click(selector)
          return { content: `Clicked ${selector} on ${rawUrl}` }
        }

        if (action === 'text') {
          const text = await driver.textContent(selector)
          const trimmed = text.slice(0, 20_000)
          return { content: `Text from ${rawUrl}${selector ? ` (${selector})` : ''}:\n\n${trimmed}` }
        }

        // screenshot
        const png = await driver.screenshot()
        const base64 = png.toString('base64')
        let artifactId: string | undefined
        if (params.artifactStore) {
          artifactId = await params.artifactStore.save({
            tool: 'browser_screenshot',
            target: `${url.hostname}-screenshot.png`,
            rawContent: base64,
            summary: `Screenshot of ${rawUrl}`,
            sections: [],
          })
        }
        return {
          content: `Captured screenshot of ${rawUrl}` + (artifactId ? ` → artifact ${artifactId}` : ''),
          rawPath: undefined,
        }
      } catch (err) {
        return { content: `browser failed: ${(err as Error).message}`, isError: true }
      } finally {
        try { await driver?.close() } catch { /* ignore */ }
      }
    },

    requiresApproval: () => true, // forced — every browser action needs a human
    isConcurrencySafe: () => false,
    isEnabled: () => enabled,
    timeoutMs: () => 60_000,
  }
}

export const BROWSER_TOOL: Tool = createBrowserTool({ enabled: true })
