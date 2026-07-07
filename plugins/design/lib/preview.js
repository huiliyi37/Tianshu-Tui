import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { withBrowser, openTargetPage, resolveViewportList } from './browser.js'

/**
 * @param {{ filePath?: string, url?: string, viewports?: string[], fullPage?: boolean, outputDir: string }} opts
 */
export async function capturePreviews(opts) {
  const viewports = resolveViewportList(opts.viewports)
  mkdirSync(opts.outputDir, { recursive: true })

  /** @type {Array<{ viewport: string, path: string, width: number, height: number }>} */
  const shots = []

  await withBrowser(async (browser) => {
    for (const vp of viewports) {
      const page = await openTargetPage(browser, { filePath: opts.filePath, url: opts.url }, vp)
      const outPath = join(opts.outputDir, `preview-${vp.label}.png`)
      await page.screenshot({ path: outPath, fullPage: !!opts.fullPage, type: 'png' })
      await page.close()
      shots.push({ viewport: vp.label, path: outPath, width: vp.width, height: vp.height })
    }
  })

  return shots
}
