import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { withBrowser, openTargetPage, resolveViewportList, VIEWPORTS } from './browser.js'

// IIFE string: puppeteer evaluates strings as EXPRESSIONS — a bare arrow
// function expression would evaluate to the function itself (serializes to
// undefined) instead of running the audit. The trailing () is load-bearing.
const AUDIT_SCRIPT = `(() => {
  const issues = []
  const root = document.documentElement
  if (root.scrollWidth > root.clientWidth + 1) {
    const samples = [...document.querySelectorAll('*')]
      .filter(el => el.getBoundingClientRect().right > window.innerWidth + 1)
      .slice(0, 20)
      .map(el => ({
        tag: el.tagName.toLowerCase(),
        class: (el.className && el.className.toString ? el.className.toString() : '').slice(0, 80),
        overflowPx: Math.round(el.getBoundingClientRect().right - window.innerWidth),
      }))
    issues.push({ type: 'horizontal_overflow', severity: 'high', count: samples.length, samples })
  }
  const smallTargets = [...document.querySelectorAll('a, button, input, select, textarea, [role="button"]')]
    .filter(el => {
      const r = el.getBoundingClientRect()
      return r.width > 0 && r.height > 0 && (r.width < 44 || r.height < 44)
    })
    .slice(0, 15)
    .map(el => {
      const r = el.getBoundingClientRect()
      return { tag: el.tagName.toLowerCase(), width: Math.round(r.width), height: Math.round(r.height) }
    })
  if (smallTargets.length) {
    issues.push({ type: 'small_touch_target', severity: 'medium', count: smallTargets.length, samples: smallTargets })
  }
  const smallText = [...document.querySelectorAll('body *')]
    .filter(el => el.childElementCount === 0 && (el.textContent || '').trim().length > 0)
    .map(el => ({ el, fs: parseFloat(getComputedStyle(el).fontSize) }))
    .filter(x => x.fs > 0 && x.fs < 12)
    .slice(0, 15)
    .map(x => ({ tag: x.el.tagName.toLowerCase(), fontSizePx: x.fs, text: (x.el.textContent || '').trim().slice(0, 40) }))
  if (smallText.length) {
    issues.push({ type: 'small_font', severity: 'low', count: smallText.length, samples: smallText })
  }
  return issues
})()`

/**
 * @param {{ filePath?: string, url?: string, outputDir: string }} opts
 */
export async function runResponsiveAudit(opts) {
  mkdirSync(opts.outputDir, { recursive: true })
  const viewports = resolveViewportList(['mobile', 'tablet', 'desktop'])
  /** @type {Array<{ viewport: string, issues: Array<{ type: string, severity: string, count: number, samples?: unknown[] }>, screenshot: string }>} */
  const reports = []

  await withBrowser(async (browser) => {
    for (const vp of viewports) {
      const page = await openTargetPage(browser, { filePath: opts.filePath, url: opts.url }, vp)
      const issues = await page.evaluate(AUDIT_SCRIPT)
      const screenshot = join(opts.outputDir, `audit-${vp.label}.png`)
      await page.screenshot({ path: screenshot, fullPage: false, type: 'png' })
      await page.close()
      reports.push({ viewport: vp.label, issues: Array.isArray(issues) ? issues : [], screenshot })
    }
  })

  const totalIssues = reports.reduce((n, r) => n + r.issues.length, 0)
  return { reports, totalIssues, viewports: Object.keys(VIEWPORTS) }
}
