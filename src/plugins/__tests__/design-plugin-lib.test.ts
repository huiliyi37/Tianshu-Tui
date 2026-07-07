import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { ToolRegistry } from '../../tools/registry.js'
import { initializePlugins } from '../plugin-loader.js'
import { skillRegistry } from '../../skills/skill-loader.js'
import { existsSync, mkdirSync, rmSync, writeFileSync, cpSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'

const designRoot = join(process.cwd(), 'plugins/design')
const requireFromDesign = createRequire(join(designRoot, 'package.json'))

// Plugin-local deps (pngjs/pixelmatch) live in plugins/design/node_modules and
// are NOT installed by root npm install — skip dep-dependent tests when absent
// instead of blowing up the whole test file at import time.
const depsInstalled = existsSync(join(designRoot, 'node_modules', 'pngjs'))

// chrome.js only uses node builtins — safe to load without plugin deps.
const chrome = requireFromDesign('./lib/chrome.js')

function makeSolidPngBuffer(r: number, g: number, b: number, w = 4, h = 4) {
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

describe('design plugin lib', { skip: !depsInstalled }, () => {
  it('extractPaletteFromPng merges duplicate buckets into distinct colors', () => {
    const palette = requireFromDesign('./lib/palette.js')
    const red = makeSolidPngBuffer(200, 40, 40)
    const { colors, cssVariables } = palette.extractPaletteFromPng(red, 4)
    // Solid image: median-cut yields 4 identical buckets — must merge to 1 color at 100%.
    assert.equal(colors.length, 1)
    assert.ok(colors[0]!.hex.startsWith('#'))
    assert.equal(colors[0]!.percent, 100)
    assert.ok(cssVariables.includes(':root'))
  })

  it('comparePngBuffers reports zero mismatch for identical images', () => {
    const diff = requireFromDesign('./lib/diff.js')
    const buf = makeSolidPngBuffer(10, 20, 30)
    const result = diff.comparePngBuffers(buf, buf)
    assert.ok(result.ok)
    if (result.ok) {
      assert.equal(result.mismatchPercent, 0)
    }
  })

  it('comparePngBuffers rejects size mismatch', () => {
    const diff = requireFromDesign('./lib/diff.js')
    const a = makeSolidPngBuffer(10, 20, 30, 4, 4)
    const b = makeSolidPngBuffer(10, 20, 30, 8, 4)
    const result = diff.comparePngBuffers(a, b)
    assert.equal(result.ok, false)
    assert.ok(result.error?.includes('size mismatch'))
  })

  it('comparePngBuffers detects pixel differences', () => {
    const diff = requireFromDesign('./lib/diff.js')
    const a = makeSolidPngBuffer(255, 0, 0)
    const b = makeSolidPngBuffer(0, 0, 255)
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
})

describe('design plugin tool entry', () => {
  type DesignTool = { definition: { name: string }, execute: (p: Record<string, unknown>) => Promise<{ isError?: boolean, content: string }> }
  const designMod = requireFromDesign('./index.js') as { tools: DesignTool[] }

  it('exposes all four tools without importing heavy deps', () => {
    const names = designMod.tools.map(t => t.definition.name).sort()
    assert.deepEqual(names, ['ui_diff', 'ui_palette', 'ui_preview', 'ui_responsive_audit'])
  })

  it('ui_preview reports missing params before Chrome availability', async () => {
    const previewTool = designMod.tools.find(t => t.definition.name === 'ui_preview')!
    const result = await previewTool.execute({})
    assert.equal(result.isError, true)
    assert.ok(result.content.includes('file_path'))
  })

  it('ui_palette works without Chrome', { skip: !depsInstalled }, async () => {
    const tmp = join(process.cwd(), '.rivet', `design-palette-${randomUUID()}`)
    mkdirSync(tmp, { recursive: true })
    const pngPath = join(tmp, 'red.png')
    writeFileSync(pngPath, makeSolidPngBuffer(180, 20, 20))

    const paletteTool = designMod.tools.find(t => t.definition.name === 'ui_palette')!
    const result = await paletteTool.execute({ file_path: pngPath })
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

    // Exclude node_modules: index.js lazy-imports heavy deps, so the loader
    // can register tools/skills without them — and copying puppeteer-core
    // costs ~3 minutes.
    cpSync(designRoot, join(testHome, 'plugins', 'tianshu-design'), {
      recursive: true,
      filter: (src) => !src.includes('node_modules'),
    })

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
