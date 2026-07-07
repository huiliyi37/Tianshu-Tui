import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { installPlugin, isPluginInstalled, getInstalledPlugins, removePlugin } from '../plugin-installer.js'

/** Create a minimal valid plugin source directory for testing. */
function createPluginSource(name: string, opts: {
  entryContent?: string
  manifest?: Record<string, unknown>
} = {}): string {
  const dir = join(process.cwd(), '.rivet', `plugin-src-${randomUUID()}`)
  mkdirSync(dir, { recursive: true })

  const pkg = {
    name,
    version: '1.0.0',
    tianshu: opts.manifest ?? {
      name,
      version: '1.0.0',
      description: 'Test plugin',
      entry: 'index.js',
      tools: [{ name: `${name}_tool`, description: 'A test tool' }],
      permissions: { fs: true },
    },
  }
  writeFileSync(join(dir, 'package.json'), JSON.stringify(pkg, null, 2))

  const entry = opts.entryContent ?? `
export const tools = [{
  definition: { name: '${name}_tool', description: 'Test', input_schema: { type: 'object', properties: {} } },
  execute: async () => ({ content: 'ok' }),
  requiresApproval: () => false,
  isConcurrencySafe: () => false,
  isEnabled: () => true,
}];
`
  writeFileSync(join(dir, 'index.js'), entry)

  return dir
}

describe('installPlugin', () => {
  const origHome = process.env.RIVET_HOME
  const testHome = join(process.cwd(), '.rivet', `plugin-home-${randomUUID()}`)
  const activeSrcDirs: string[] = []

  after(() => {
    process.env.RIVET_HOME = origHome ?? ''
    if (origHome === undefined) delete process.env.RIVET_HOME
    if (existsSync(testHome)) rmSync(testHome, { recursive: true, force: true })
    for (const dir of activeSrcDirs) {
      if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
    }
  })

  before(() => {
    process.env.RIVET_HOME = testHome
    mkdirSync(join(testHome, 'plugins'), { recursive: true })
  })

  it('installs a valid plugin from local path', async () => {
    const src = createPluginSource('test-plugin')
    activeSrcDirs.push(src)

    const result = await installPlugin(src)
    assert.equal(result.ok, true)
    if (result.ok) {
      assert.equal(result.manifest.name, 'test-plugin')
      assert.ok(existsSync(join(testHome, 'plugins', 'test-plugin', 'package.json')))
      assert.ok(isPluginInstalled('test-plugin'))
    }
  })

  it('rejects a path without package.json', async () => {
    const emptyDir = join(process.cwd(), '.rivet', `plugin-empty-${randomUUID()}`)
    mkdirSync(emptyDir, { recursive: true })
    activeSrcDirs.push(emptyDir)

    const result = await installPlugin(emptyDir)
    assert.equal(result.ok, false)
    if (!result.ok) {
      assert.ok(result.error.includes('package.json') || result.error.includes('manifest'))
    }
  })

  it('rejects a path with invalid manifest', async () => {
    const src = createPluginSource('bad-plugin', {
      manifest: { name: 'bad-plugin' }, // missing required fields
    })
    activeSrcDirs.push(src)

    const result = await installPlugin(src)
    assert.equal(result.ok, false)
    if (!result.ok) {
      assert.ok(result.error.includes('manifest') || result.error.includes('Invalid'))
    }
  })

  it('rejects duplicate install', async () => {
    const src = createPluginSource('dup-plugin')
    activeSrcDirs.push(src)

    const first = await installPlugin(src)
    assert.equal(first.ok, true)

    const second = await installPlugin(src)
    assert.equal(second.ok, false)
    if (!second.ok) {
      assert.ok(second.error.includes('already installed'))
    }
  })
})

describe('getInstalledPlugins', () => {
  const origHome = process.env.RIVET_HOME
  const testHome = join(process.cwd(), '.rivet', `plugin-home2-${randomUUID()}`)

  after(() => {
    process.env.RIVET_HOME = origHome ?? ''
    if (origHome === undefined) delete process.env.RIVET_HOME
    if (existsSync(testHome)) rmSync(testHome, { recursive: true, force: true })
  })

  before(() => {
    process.env.RIVET_HOME = testHome
    mkdirSync(join(testHome, 'plugins'), { recursive: true })
  })

  it('returns empty when no plugins installed', () => {
    const plugins = getInstalledPlugins()
    assert.equal(plugins.length, 0)
  })
})

describe('removePlugin', () => {
  const origHome = process.env.RIVET_HOME
  const testHome = join(process.cwd(), '.rivet', `plugin-home3-${randomUUID()}`)
  const activeSrcDirs: string[] = []

  after(() => {
    process.env.RIVET_HOME = origHome ?? ''
    if (origHome === undefined) delete process.env.RIVET_HOME
    if (existsSync(testHome)) rmSync(testHome, { recursive: true, force: true })
    for (const dir of activeSrcDirs) {
      if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
    }
  })

  before(() => {
    process.env.RIVET_HOME = testHome
    mkdirSync(join(testHome, 'plugins'), { recursive: true })
  })

  it('removes an installed plugin', async () => {
    const src = createPluginSource('rm-plugin')
    activeSrcDirs.push(src)

    await installPlugin(src)
    assert.ok(isPluginInstalled('rm-plugin'))

    const result = removePlugin('rm-plugin')
    assert.equal(result.ok, true)
    assert.equal(isPluginInstalled('rm-plugin'), false)
  })

  it('rejects removing non-existent plugin', () => {
    const result = removePlugin('nonexistent')
    assert.equal(result.ok, false)
    assert.ok(result.error?.includes('not installed'))
  })
})
