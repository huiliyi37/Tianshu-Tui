import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { ToolRegistry } from '../../tools/registry.js'
import { initializePlugins } from '../plugin-loader.js'
import { skillRegistry } from '../../skills/skill-loader.js'
import { existsSync, mkdirSync, rmSync, writeFileSync, cpSync } from 'node:fs'
import { join, sep } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'

const designRoot = join(process.cwd(), 'plugins/design')
const requireFromDesign = createRequire(join(designRoot, 'package.json'))

// palette + diff + chrome loaded via require (plugin-local deps, no root TS declarations)
const palette = requireFromDesign('./lib/palette.js')
const diff = requireFromDesign('./lib/diff.js')
const chrome = requireFromDesign('./lib/chrome.js')

async function makeSolidPngBuffer(r: number, g: number, b: number, w = 4, h = 4) {
  const { PNG } = requireFromDesign('pngjs') as { PNG: { new (o: { width: number, height: number }): { data: Buffer }, sync: { write: (p: unknown) => Buffer } } }
  const png = new PNG({ width: w, height: h })
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i] = r
    png.data[i + 1] = g
    png.data[i + 2] = b
    png.data[i + 3] = 255
  }
  return PNG.sync.write(png)
}

describe('design plugin lib', () => {
  it('extractPaletteFromPng returns dominant colors with percentages', async () => {
    const red = await makeSolidPngBuffer(200, 40, 40)
    const { colors, cssVariables } = palette.extractPaletteFromPng(red, 4)
    assert.ok(colors.length >= 1)
    assert.ok(colors[0]!.hex.startsWith('#'))
    assert.ok(colors[0]!.percent > 0)
    assert.ok(cssVariables.includes(':root'))
  })

  it('comparePngBuffers reports zero mismatch for identical images', async () => {
    const buf = await makeSolidPngBuffer(10, 20, 30)
    const result = diff.comparePngBuffers(buf, buf)
    assert.ok(result.ok)
    if (result.ok) {
      assert.equal(result.mismatchPercent, 0)
    }
  })

  it('comparePngBuffers rejects size mismatch', async () => {
    const a = await makeSolidPngBuffer(10, 20, 30, 4, 4)
    const b = await makeSolidPngBuffer(10, 20, 30, 8, 4)
    const result = diff.comparePngBuffers(a, b)
    assert.equal(result.ok, false)
    assert.ok(result.error?.includes('size mismatch'))
  })

  it('comparePngBuffers detects pixel differences', async () => {
    const a = await makeSolidPngBuffer(255, 0, 0)
    const b = await makeSolidPngBuffer(0, 0, 255)
    const result = diff.comparePngBuffers(a, b)
    assert.ok(result.ok)
    if (result.ok) {
      assert.ok(result.mismatchPercent > 90)
      assert.ok(result.diffPng.length > 0)
    }
  })
})

describe('design plugin chrome guard', () => {
  it('chromeNotFoundMessage is actionable', () => {
    assert.ok(chrome.chromeNotFoundMessage().includes('CHROME_PATH'))
  })

  it('findChromeBinary ignores invalid CHROME_PATH override', () => {
    const result = chrome.findChromeBinary({ CHROME_PATH: '/nonexistent/chrome-for-test' })
    assert.notEqual(result, '/nonexistent/chrome-for-test')
  })

  it('ui_palette works without Chrome', async () => {
    const tmp = join(process.cwd(), '.rivet', `design-palette-${randomUUID()}`)
    mkdirSync(tmp, { recursive: true })
    const pngPath = join(tmp, 'red.png')
    writeFileSync(pngPath, await makeSolidPngBuffer(180, 20, 20))

    const designMod = requireFromDesign('./index.js') as { tools: Array<{ definition: { name: string }, execute: (p: Record<string, unknown>) => Promise<{ isError?: boolean, content: string }> }> }
    const paletteTool = designMod.tools.find(t => t.definition.name === 'ui_palette')
    assert.ok(paletteTool)
    const result = await paletteTool!.execute({ file_path: pngPath })
    assert.ok(!result.isError)
    assert.ok(result.content.includes('#'))

    rmSync(tmp, { recursive: true, force: true })
  })
})

describe('design plugin loader integration', () => {
  const origHome = process.env.RIVET_HOME
  const testHome = join(process.cwd(), '.rivet', `design-load-${randomUUID()}`)

  it('loads tianshu-design tools and design-prototype skill from repo plugin', async () => {
    process.env.RIVET_HOME = testHome
    mkdirSync(join(testHome, 'plugins', 'tianshu-design'), { recursive: true })

    cpSync(designRoot, join(testHome, 'plugins', 'tianshu-design'), { recursive: true })

    const registry = new ToolRegistry()
    const result = await initializePlugins(undefined, registry, process.cwd())
    const item = result.results.find(r => r.pluginName === 'tianshu-design')
    assert.ok(item, `expected tianshu-design in ${result.results.map(r => r.pluginName).join(', ')}`)
    assert.equal(item!.status, 'loaded')
    assert.equal(item!.toolCount, 4)
    assert.equal(item!.skillCount, 1)
    assert.ok(registry.has('ui_preview'))
    assert.ok(skillRegistry.get('design-prototype'))

    process.env.RIVET_HOME = origHome ?? ''
    if (origHome === undefined) delete process.env.RIVET_HOME
    if (existsSync(testHome)) rmSync(testHome, { recursive: true, force: true })
  })
})
