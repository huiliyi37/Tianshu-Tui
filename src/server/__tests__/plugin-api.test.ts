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
  const res = await ROUTES['POST /plugins/install']!({ path: '/nonexistent/path' }, undefined, authHeaders(), undefined)
  assert.equal(res.status, 400)
  const body = res.body as { ok: boolean; error: string }
  assert.equal(body.ok, false)
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
