import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { findChromeBinary, chromeNotFoundMessage } from './chrome.js'

export const VIEWPORTS = {
  mobile: { width: 375, height: 812, label: 'mobile' },
  tablet: { width: 768, height: 1024, label: 'tablet' },
  desktop: { width: 1440, height: 900, label: 'desktop' },
}

/** Lazy-load puppeteer-core so the plugin can register (and give actionable
 *  per-tool errors) even when node_modules is missing or install failed. */
async function loadPuppeteer() {
  try {
    return (await import('puppeteer-core')).default
  } catch {
    const err = new Error(
      'puppeteer-core is not installed. Run "npm install --ignore-scripts --omit=dev" inside the tianshu-design plugin directory, then retry.',
    )
    err.code = 'DEPS_NOT_INSTALLED'
    throw err
  }
}

/** @param {(browser: import('puppeteer-core').Browser) => Promise<unknown>} fn */
export async function withBrowser(fn) {
  const exe = findChromeBinary()
  if (!exe) {
    const err = new Error(chromeNotFoundMessage())
    err.code = 'CHROME_NOT_FOUND'
    throw err
  }
  const puppeteer = await loadPuppeteer()
  const browser = await puppeteer.launch({
    executablePath: exe,
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  })
  try {
    return await fn(browser)
  } finally {
    await browser.close()
  }
}

/**
 * Open a page at the given viewport, THEN navigate — setting the viewport
 * after goto renders at the default size first and re-flows on resize,
 * making media-query/lazy-load content screenshot-unreliable.
 *
 * @param {import('puppeteer-core').Browser} browser
 * @param {{ filePath?: string, url?: string }} target
 * @param {{ width: number, height: number }} [viewport]
 */
export async function openTargetPage(browser, target, viewport) {
  const page = await browser.newPage()
  if (viewport) {
    await page.setViewport({ width: viewport.width, height: viewport.height, deviceScaleFactor: 1 })
  }
  if (target.filePath) {
    const abs = resolve(target.filePath)
    await page.goto(pathToFileURL(abs).href, { waitUntil: 'networkidle0', timeout: 45_000 })
  } else if (target.url) {
    await page.goto(target.url, { waitUntil: 'networkidle0', timeout: 45_000 })
  } else {
    throw new Error('Provide file_path or url')
  }
  return page
}

/** @param {string[]} names */
export function resolveViewportList(names) {
  const list = names?.length ? names : ['mobile', 'tablet', 'desktop']
  /** @type {Array<{ width: number, height: number, label: string }>} */
  const out = []
  for (const name of list) {
    const vp = VIEWPORTS[/** @type {keyof typeof VIEWPORTS} */ (name)]
    if (vp) out.push(vp)
  }
  if (out.length === 0) throw new Error(`Invalid viewports. Use: ${Object.keys(VIEWPORTS).join(', ')}`)
  return out
}
