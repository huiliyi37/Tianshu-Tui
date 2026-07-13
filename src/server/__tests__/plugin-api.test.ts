import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { buildPluginRoutes } from '../plugin-api.js'
import { loadConfig } from '../../config/manager.js'

const ROUTES = buildPluginRoutes('test-token')
function authHeaders() { return { authorization: 'Bearer test-token' } }

const origHome = process.env.RIVET_HOME
const testHome = join(process.cwd(), '.rivet', `plugin-api-test-${randomUUID()}`)
const cleanupDirs: string[] = []

before(() => {
  process.env.RIVET_HOME = testHome
  mkdirSync(join(testHome, 'plugins'), { recursive: true })
})

after(() => {
  process.env.RIVET_HOME = origHome ?? ''
  if (origHome === undefined) delete process.env.RIVET_HOME
  if (existsSync(testHome)) rmSync(testHome, { recursive: true, force: true })
  for (const d of cleanupDirs) { if (existsSync(d)) rmSync(d, { recursive: true, force: true }) }
})

// ── Auth gate ─────────────────────────────────────────────────

test('GET /plugins/presets returns 401 without token', async () => {
  const res = await ROUTES['GET /plugins/presets']!({}, undefined, {}, undefined)
  assert.equal(res.status, 401)
})

test('POST /plugins/install returns 401 without token', async () => {
  const res = await ROUTES['POST /plugins/install']!({}, undefined, {}, undefined)
  assert.equal(res.status, 401)
})

test('POST /plugins/enable returns 401 without token', async () => {
  const res = await ROUTES['POST /plugins/enable']!({}, undefined, {}, undefined)
  assert.equal(res.status, 401)
})

test('DELETE /plugins/:name returns 401 without token', async () => {
  const res = await ROUTES['DELETE /plugins/:name']!({}, undefined, {}, undefined)
  assert.equal(res.status, 401)
})

// ── Presets ───────────────────────────────────────────────────

test('GET /plugins/presets returns presets list with installed/enabled flags', async () => {
  const res = await ROUTES['GET /plugins/presets']!({}, undefined, authHeaders(), undefined)
  assert.equal(res.status, 200)
  const body = res.body as { presets: Record<string, unknown>[] }
  assert.ok(Array.isArray(body.presets))
  assert.ok(body.presets.length > 0)
  for (const p of body.presets) {
    assert.ok(p.id)
    assert.ok(p.name)
    assert.equal(typeof p.installed, 'boolean')
    assert.equal(typeof p.enabled, 'boolean')
  }
})

test('GET /plugins/presets: uninstalled plugins are never reported enabled', async () => {
  const res = await ROUTES['GET /plugins/presets']!({}, undefined, authHeaders(), undefined)
  const body = res.body as { presets: Array<{ installed: boolean; enabled: boolean }> }
  for (const p of body.presets) {
    if (!p.installed) {
      assert.equal(p.enabled, false, 'the config "absent means enabled" default must not leak to uninstalled plugins')
    }
  }
})

// ── Installed ─────────────────────────────────────────────────

test('GET /plugins/installed returns empty when none installed', async () => {
  const res = await ROUTES['GET /plugins/installed']!({}, undefined, authHeaders(), undefined)
  assert.equal(res.status, 200)
  const body = res.body as { plugins: unknown[] }
  assert.equal(body.plugins.length, 0)
})

// ── Install validation ────────────────────────────────────────

test('POST /plugins/install rejects missing path (400)', async () => {
  const res = await ROUTES['POST /plugins/install']!({}, undefined, authHeaders(), undefined)
  assert.equal(res.status, 400)
})

test('POST /plugins/install rejects non-existent path (400)', async () => {
  const res = await ROUTES['POST /plugins/install']!({ path: '/nonexistent/path', confirm: true }, undefined, authHeaders(), undefined)
  assert.equal(res.status, 400)
  const body = res.body as { ok: boolean; error: string }
  assert.equal(body.ok, false)
})

test('POST /plugins/install requires confirm:true — returns manifest for review', async () => {
  // Create a minimal valid plugin source
  const srcDir = join(testHome, 'src-plugin')
  mkdirSync(srcDir, { recursive: true })
  writeFileSync(join(srcDir, 'package.json'), JSON.stringify({
    name: 'src-plugin', version: '1.0.0',
    tianshu: { name: 'src-plugin', version: '1.0.0', description: 'Needs confirm', entry: 'index.js', tools: [{ name: 'src_tool', description: 'x' }], permissions: { fs: true } },
  }))
  writeFileSync(join(srcDir, 'index.js'), 'export const tools = []')
  cleanupDirs.push(srcDir)

  // Without confirm — should return manifest for review
  const res = await ROUTES['POST /plugins/install']!({ path: srcDir }, undefined, authHeaders(), undefined)
  assert.equal(res.status, 400)
  const body = res.body as { ok: boolean; error: string; manifest: unknown; hint: string }
  assert.equal(body.ok, false)
  assert.ok(body.error.includes('Confirmation required'))
  assert.ok(body.manifest)
  assert.ok(body.hint)

  // With confirm — should succeed
  const res2 = await ROUTES['POST /plugins/install']!({ path: srcDir, confirm: true }, undefined, authHeaders(), undefined)
  assert.equal(res2.status, 200)
  const body2 = res2.body as { ok: boolean; manifest: Record<string,unknown>; message: string }
  assert.equal(body2.ok, true)
  assert.equal(body2.manifest.name, 'src-plugin')
})

test('POST /plugins/install rejects a non-plugin directory up front (no misleading confirm prompt)', async () => {
  const srcDir = join(testHome, 'not-a-plugin')
  mkdirSync(srcDir, { recursive: true })
  writeFileSync(join(srcDir, 'package.json'), JSON.stringify({ name: 'plain-package', version: '1.0.0' }))
  cleanupDirs.push(srcDir)

  const res = await ROUTES['POST /plugins/install']!({ path: srcDir }, undefined, authHeaders(), undefined)
  assert.equal(res.status, 400)
  const body = res.body as { ok: boolean; error: string }
  assert.equal(body.ok, false)
  assert.ok(body.error.includes('not a Tianshu plugin'), `expected explicit non-plugin rejection, got: ${body.error}`)
  assert.ok(!body.error.includes('Confirmation required'))
})

test('POST /plugins/install rejects an invalid manifest with the validation errors', async () => {
  const srcDir = join(testHome, 'bad-manifest-plugin')
  mkdirSync(srcDir, { recursive: true })
  writeFileSync(join(srcDir, 'package.json'), JSON.stringify({
    name: 'bad-manifest-plugin', version: '1.0.0',
    tianshu: { name: 'bad-manifest-plugin' }, // missing version/entry/tools
  }))
  cleanupDirs.push(srcDir)

  const res = await ROUTES['POST /plugins/install']!({ path: srcDir }, undefined, authHeaders(), undefined)
  assert.equal(res.status, 400)
  const body = res.body as { ok: boolean; error: string }
  assert.equal(body.ok, false)
  assert.ok(body.error.includes('Invalid plugin manifest'), `expected manifest validation failure, got: ${body.error}`)
})

// ── Enable/disable validation ─────────────────────────────────

test('POST /plugins/enable rejects missing name (400)', async () => {
  const res = await ROUTES['POST /plugins/enable']!({}, undefined, authHeaders(), undefined)
  assert.equal(res.status, 400)
})

test('POST /plugins/enable rejects missing enabled flag (400)', async () => {
  const res = await ROUTES['POST /plugins/enable']!({ name: 'test' }, undefined, authHeaders(), undefined)
  assert.equal(res.status, 400)
})

test('POST /plugins/enable returns 404 for uninstalled plugin', async () => {
  const res = await ROUTES['POST /plugins/enable']!({ name: 'nonexistent', enabled: true }, undefined, authHeaders(), undefined)
  assert.equal(res.status, 404)
})

// ── Enable write-back ─────────────────────────────────────────

test('POST /plugins/enable writes enabled state to config and persists', async () => {
  const pluginDir = join(testHome, 'plugins', 'wb-plugin')
  mkdirSync(pluginDir, { recursive: true })
  writeFileSync(join(pluginDir, 'package.json'), JSON.stringify({
    name: 'wb-plugin', version: '1.0.0',
    tianshu: { name: 'wb-plugin', version: '1.0.0', description: 'Test', entry: 'index.js', tools: [{ name: 'wb_tool', description: 'x' }], permissions: {} },
  }))
  cleanupDirs.push(pluginDir)

  const handler = ROUTES['POST /plugins/enable']!

  // Enable
  const r1 = await handler({ name: 'wb-plugin', enabled: true }, undefined, authHeaders(), undefined)
  assert.equal(r1.status, 200)
  assert.equal((r1.body as Record<string,unknown>).ok, true)
  assert.equal((r1.body as Record<string,unknown>).enabled, true)
  assert.equal(loadConfig().plugins.enabled['wb-plugin'], true)

  // Disable
  const r2 = await handler({ name: 'wb-plugin', enabled: false }, undefined, authHeaders(), undefined)
  assert.equal(r2.status, 200)
  assert.equal((r2.body as Record<string,unknown>).enabled, false)
  assert.equal(loadConfig().plugins.enabled['wb-plugin'], false)
})

// ── Remove ────────────────────────────────────────────────────

test('DELETE /plugins/:name returns 404 for non-existent', async () => {
  const res = await ROUTES['DELETE /plugins/:name']!({}, { name: 'nonexistent' }, authHeaders(), undefined)
  assert.equal(res.status, 404)
})

test('DELETE /plugins/:name rejects missing name (400)', async () => {
  const res = await ROUTES['DELETE /plugins/:name']!({}, undefined, authHeaders(), undefined)
  assert.equal(res.status, 400)
})

test('resolveSourcePath falls back to RIVET_BUNDLED_PLUGINS_DIR for plugins/* presets', async () => {
  const { resolveSourcePath } = await import('../plugin-api.js')
  // Use an id that is NOT present under the repo's plugins/ so projectRoot
  // miss forces the bundled fallback (repo has real office-pdf etc.).
  const bundled = join(testHome, 'bundled-plugins')
  const pluginDir = join(bundled, 'packaged-only-plugin')
  mkdirSync(pluginDir, { recursive: true })
  writeFileSync(join(pluginDir, 'package.json'), JSON.stringify({
    name: 'packaged-only-plugin', version: '1.0.0',
    tianshu: {
      name: 'packaged-only-plugin', version: '1.0.0', description: 'Packaged', entry: 'index.js',
      tools: [{ name: 'packaged_tool', description: 'x' }], permissions: {},
    },
  }))
  cleanupDirs.push(bundled)

  const prev = process.env.RIVET_BUNDLED_PLUGINS_DIR
  process.env.RIVET_BUNDLED_PLUGINS_DIR = bundled
  try {
    const resolved = resolveSourcePath('plugins/packaged-only-plugin')
    assert.equal(resolved, pluginDir)

    // Install via relative preset path should find package.json through the fallback.
    const res = await ROUTES['POST /plugins/install']!(
      { path: 'plugins/packaged-only-plugin' },
      undefined,
      authHeaders(),
      undefined,
    )
    assert.equal(res.status, 400)
    const body = res.body as { ok: boolean; error: string; manifest?: { name: string } }
    assert.equal(body.ok, false)
    assert.ok(body.error.includes('Confirmation required'), `got: ${body.error}`)
    assert.equal(body.manifest?.name, 'packaged-only-plugin')
  } finally {
    if (prev === undefined) delete process.env.RIVET_BUNDLED_PLUGINS_DIR
    else process.env.RIVET_BUNDLED_PLUGINS_DIR = prev
  }
})
