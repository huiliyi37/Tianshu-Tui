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

// 导航/截图结果前缀已抽至 output-markers.ts（零依赖叶子，桌面端共享）；
// 此处 re-export 保持内核调用方不变。
export { BROWSER_NAVIGATED_PREFIX, BROWSER_SCREENSHOT_OF_PREFIX } from './output-markers.js'
import { BROWSER_NAVIGATED_PREFIX, BROWSER_SCREENSHOT_OF_PREFIX } from './output-markers.js'
import { PLAYWRIGHT_INSTALL_HINT, PLAYWRIGHT_CORE_INSTALL_HINT } from './net/playwright-driver.js'

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
  // 'playwright-core' types at build time.
  const specifier = 'playwright-core'
  let mod: { chromium: { launch: (o: { headless: boolean }) => Promise<unknown> } }
  try {
    mod = (await import(specifier)) as never
  } catch {
    throw new Error(`未安装 playwright-core。${PLAYWRIGHT_CORE_INSTALL_HINT}`)
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
      description: `驱动无头浏览器验证 Web UI。导航到许可名单中的 URL 并截图、提取文本或点击元素。
始终需要显式人工审批，且目标主机必须在配置的许可名单中（fail-closed）。截图保存为可查看的 artifact。`,
      input_schema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['screenshot', 'text', 'click'], description: '导航后执行的操作。' },
          url: { type: 'string', description: '要导航到的 URL（主机必须在许可名单中）。' },
          selector: { type: 'string', description: 'text/click 操作的 CSS 选择器。' },
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
        return { content: `无效 URL：${rawUrl}`, isError: true }
      }
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        return { content: `不支持的协议：${url.protocol}。仅允许 http/https。`, isError: true }
      }

      const list = allowlist()
      if (!isHostAllowed(url.hostname, list)) {
        return {
          content:
            `browser 已拦截：主机 "${url.hostname}" 不在许可名单中（fail-closed）。` +
            (list.length === 0
              ? '当前未配置任何许可主机——请设置 RIVET_BROWSER_ALLOWLIST。'
              : `已允许：${list.join(', ')}。`),
          isError: true,
        }
      }

      let driver: BrowserDriver | null = null
      try {
        driver = await driverFactory()
        await driver.goto(rawUrl)

        if (action === 'click') {
          if (!selector) return { content: 'click 需要 "selector"。', isError: true }
          await driver.click(selector)
          return { content: `已在 ${rawUrl} 点击 ${selector}` }
        }

        if (action === 'text') {
          const text = await driver.textContent(selector)
          const trimmed = text.slice(0, 20_000)
          return { content: `来自 ${rawUrl}${selector ? `（${selector}）` : ''} 的文本：\n\n${trimmed}` }
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
          content: `${BROWSER_SCREENSHOT_OF_PREFIX} ${rawUrl}` + (artifactId ? ` → artifact ${artifactId}` : ''),
          rawPath: undefined,
        }
      } catch (err) {
        return { content: `browser 失败：${(err as Error).message}`, isError: true }
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
