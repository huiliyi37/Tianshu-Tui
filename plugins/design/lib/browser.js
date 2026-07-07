import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import puppeteer from 'puppeteer-core'
import { findChromeBinary, chromeNotFoundMessage } from './chrome.js'

export const VIEWPORTS = {
  mobile: { width: 375, height: 812, label: 'mobile' },
  tablet: { width: 768, height: 1024, label: 'tablet' },
  desktop: { width: 1440, height: 900, label: 'desktop' },
}

/** @param {(browser: import('puppeteer-core').Browser) => Promise<unknown>} fn */
export async function withBrowser(fn) {
  const exe = findChromeBinary()
  if (!exe) {
    const err = new Error(chromeNotFoundMessage())
    err.code = 'CHROME_NOT_FOUND'
    throw err
  }
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
 * @param {import('puppeteer-core').Browser} browser
 * @param {{ filePath?: string, url?: string }} target
 */
export async function openTargetPage(browser, target) {
  const page = await browser.newPage()
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
