import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRouter } from '../index.js'
import { buildConfigRoutes } from '../config-routes.js'

const TOKEN = 'secret-token'
const AUTH = { authorization: `Bearer ${TOKEN}` }

function writeConfig(home: string, pro: Record<string, unknown>) {
  const configPath = join(home, 'config.json')
  const cfg = {
    provider: { default: 'deepseek', providers: {} },
    pro,
  }
  writeFileSync(configPath, JSON.stringify(cfg, null, 2) + '\n')
}

describe('GET /config/computer-use', () => {
  const prevHome = process.env.RIVET_HOME
  let home: string

  before(() => {
    home = mkdtempSync(join(tmpdir(), 'rivet-config-routes-'))
    process.env.RIVET_HOME = home
  })

  after(() => {
    if (prevHome === undefined) delete process.env.RIVET_HOME
    else process.env.RIVET_HOME = prevHome
    rmSync(home, { recursive: true, force: true })
  })

  it('reports proRequired=true when platform supports but Pro is disabled', async () => {
    writeConfig(home, { enabled: false, features: { computerUse: false, chatGateway: false } })
    const router = createRouter(buildConfigRoutes(TOKEN))
    const res = await router('GET', '/config/computer-use', {}, AUTH)
    assert.equal(res.status, 200)
    const body = res.body as { available: boolean; proRequired: boolean; platform: string; permissions: unknown; grants: unknown[] }
    assert.equal(body.available, false)
    assert.equal(body.proRequired, true)
    assert.equal(body.platform, process.platform)
    assert.equal(body.permissions, null)
  })

  it('reports available=true when platform supports and Pro is enabled', async () => {
    writeConfig(home, { enabled: true, features: { computerUse: true, chatGateway: true } })
    const router = createRouter(buildConfigRoutes(TOKEN))
    const res = await router('GET', '/config/computer-use', {}, AUTH)
    assert.equal(res.status, 200)
    const body = res.body as { available: boolean; proRequired: boolean; permissions: unknown; grants: unknown[] }
    // available follows platform + Pro; on unsupported platforms it stays false.
    if (process.platform === 'darwin' || process.platform === 'win32') {
      assert.equal(body.available, true)
      assert.equal(body.proRequired, false)
    } else {
      assert.equal(body.available, false)
      assert.equal(body.proRequired, false)
    }
  })

  it('rejects unauthorized requests', async () => {
    const router = createRouter(buildConfigRoutes(TOKEN))
    const res = await router('GET', '/config/computer-use', {}, {})
    assert.equal(res.status, 401)
  })
})
