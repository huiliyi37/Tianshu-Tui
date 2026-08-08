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

describe('GET /config/vision-model', () => {
  const prevHome = process.env.RIVET_HOME
  let home: string

  before(() => {
    home = mkdtempSync(join(tmpdir(), 'rivet-vision-routes-'))
    process.env.RIVET_HOME = home
  })

  after(() => {
    if (prevHome === undefined) delete process.env.RIVET_HOME
    else process.env.RIVET_HOME = prevHome
    rmSync(home, { recursive: true, force: true })
  })

  it('returns null when the bridge is unset', async () => {
    writeConfig(home, { enabled: false })
    const router = createRouter(buildConfigRoutes(TOKEN))
    const res = await router('GET', '/config/vision-model', {}, AUTH)
    assert.equal(res.status, 200)
    const body = res.body as { config: unknown }
    assert.equal(body.config, null)
  })

  it('rejects unauthorized requests', async () => {
    const router = createRouter(buildConfigRoutes(TOKEN))
    const res = await router('GET', '/config/vision-model', {}, {})
    assert.equal(res.status, 401)
  })
})

describe('PUT /config/vision-model', () => {
  const prevHome = process.env.RIVET_HOME
  let home: string

  before(() => {
    home = mkdtempSync(join(tmpdir(), 'rivet-vision-routes-'))
    process.env.RIVET_HOME = home
  })

  after(() => {
    if (prevHome === undefined) delete process.env.RIVET_HOME
    else process.env.RIVET_HOME = prevHome
    rmSync(home, { recursive: true, force: true })
  })

  it('persists a vision model config and returns it', async () => {
    writeConfig(home, { enabled: false })
    const router = createRouter(buildConfigRoutes(TOKEN))
    const res = await router(
      'PUT',
      '/config/vision-model',
      { config: { provider: 'minimax', model: 'MiniMax-M3', maxTokens: 512 } },
      AUTH,
    )
    assert.equal(res.status, 200)
    const body = res.body as { ok: boolean; config: { provider: string; model: string; maxTokens: number } }
    assert.equal(body.ok, true)
    assert.deepEqual(body.config, { provider: 'minimax', model: 'MiniMax-M3', maxTokens: 512 })
  })

  it('clears the bridge when config is null', async () => {
    writeConfig(home, { enabled: false })
    const router = createRouter(buildConfigRoutes(TOKEN))
    await router('PUT', '/config/vision-model', { config: { provider: 'minimax', model: 'MiniMax-M3' } }, AUTH)
    const res = await router('PUT', '/config/vision-model', { config: null }, AUTH)
    assert.equal(res.status, 200)
    const body = res.body as { ok: boolean; config: unknown }
    assert.equal(body.config, null)
  })

  it('rejects an invalid payload', async () => {
    writeConfig(home, { enabled: false })
    const router = createRouter(buildConfigRoutes(TOKEN))
    const res = await router(
      'PUT',
      '/config/vision-model',
      { config: { provider: 'minimax', maxTokens: 512 } },
      AUTH,
    )
    assert.equal(res.status, 400)
  })

  it('rejects unauthorized requests', async () => {
    const router = createRouter(buildConfigRoutes(TOKEN))
    const res = await router('PUT', '/config/vision-model', { config: null }, {})
    assert.equal(res.status, 401)
  })
})

describe('GET /config/mirrors', () => {
  const prevHome = process.env.RIVET_HOME
  let home: string
  before(() => {
    home = mkdtempSync(join(tmpdir(), 'rivet-mirror-routes-'))
    process.env.RIVET_HOME = home
  })
  after(() => {
    if (prevHome === undefined) delete process.env.RIVET_HOME
    else process.env.RIVET_HOME = prevHome
    rmSync(home, { recursive: true, force: true })
  })

  it('returns the default mirror config (disabled, default preset) on a fresh install', async () => {
    writeConfig(home, {})
    const router = createRouter(buildConfigRoutes(TOKEN))
    const res = await router('GET', '/config/mirrors', {}, AUTH)
    assert.equal(res.status, 200)
    const body = res.body as { enabled: boolean; preset: string; github: string }
    assert.equal(body.enabled, false)
    assert.equal(body.preset, 'default')
    assert.equal(body.github, 'default')
  })

  it('rejects unauthorized requests', async () => {
    const router = createRouter(buildConfigRoutes(TOKEN))
    const res = await router('GET', '/config/mirrors', {}, {})
    assert.equal(res.status, 401)
  })
})

describe('PUT /config/mirrors', () => {
  const prevHome = process.env.RIVET_HOME
  let home: string
  before(() => {
    home = mkdtempSync(join(tmpdir(), 'rivet-mirror-put-'))
    process.env.RIVET_HOME = home
  })
  after(() => {
    if (prevHome === undefined) delete process.env.RIVET_HOME
    else process.env.RIVET_HOME = prevHome
    rmSync(home, { recursive: true, force: true })
  })

  it('enables the china preset and returns the updated config', async () => {
    writeConfig(home, {})
    const router = createRouter(buildConfigRoutes(TOKEN))
    const res = await router('PUT', '/config/mirrors', { enabled: true, preset: 'china' }, AUTH)
    assert.equal(res.status, 200)
    const body = res.body as { ok: boolean; mirrors: { enabled: boolean; preset: string } }
    assert.equal(body.ok, true)
    assert.equal(body.mirrors.enabled, true)
    assert.equal(body.mirrors.preset, 'china')
  })

  it('persists across requests (a follow-up GET sees the change)', async () => {
    writeConfig(home, {})
    const router = createRouter(buildConfigRoutes(TOKEN))
    await router('PUT', '/config/mirrors', { enabled: true, github: 'gitcode', npm: 'taobao' }, AUTH)
    const res = await router('GET', '/config/mirrors', {}, AUTH)
    const body = res.body as { enabled: boolean; github: string; npm: string }
    assert.equal(body.enabled, true)
    assert.equal(body.github, 'gitcode')
    assert.equal(body.npm, 'taobao')
  })

  it('rejects an invalid preset value (schema validation)', async () => {
    writeConfig(home, {})
    const router = createRouter(buildConfigRoutes(TOKEN))
    const res = await router('PUT', '/config/mirrors', { preset: 'bogus' }, AUTH)
    assert.equal(res.status, 400)
  })

  it('rejects an invalid github mirror enum', async () => {
    writeConfig(home, {})
    const router = createRouter(buildConfigRoutes(TOKEN))
    const res = await router('PUT', '/config/mirrors', { github: 'not-a-real-mirror' }, AUTH)
    assert.equal(res.status, 400)
  })

  it('rejects unauthorized requests', async () => {
    const router = createRouter(buildConfigRoutes(TOKEN))
    const res = await router('PUT', '/config/mirrors', { enabled: true }, {})
    assert.equal(res.status, 401)
  })
})

describe('GET /config/pr-defaults', () => {
  const prevHome = process.env.RIVET_HOME
  let home: string
  before(() => {
    home = mkdtempSync(join(tmpdir(), 'rivet-pr-defaults-routes-'))
    process.env.RIVET_HOME = home
  })
  after(() => {
    if (prevHome === undefined) delete process.env.RIVET_HOME
    else process.env.RIVET_HOME = prevHome
    rmSync(home, { recursive: true, force: true })
  })

  it('returns the default PR defaults on a fresh install', async () => {
    writeConfig(home, {})
    const router = createRouter(buildConfigRoutes(TOKEN))
    const res = await router('GET', '/config/pr-defaults', {}, AUTH)
    assert.equal(res.status, 200)
    const body = res.body as { mergeMethod: string; autoFix: boolean; autoMerge: boolean; ciPollSeconds: number }
    assert.equal(body.mergeMethod, 'squash')
    assert.equal(body.autoFix, false)
    assert.equal(body.autoMerge, false)
    assert.equal(body.ciPollSeconds, 10)
  })

  it('rejects unauthorized requests', async () => {
    const router = createRouter(buildConfigRoutes(TOKEN))
    const res = await router('GET', '/config/pr-defaults', {}, {})
    assert.equal(res.status, 401)
  })
})

describe('PUT /config/pr-defaults', () => {
  const prevHome = process.env.RIVET_HOME
  let home: string
  before(() => {
    home = mkdtempSync(join(tmpdir(), 'rivet-pr-defaults-put-'))
    process.env.RIVET_HOME = home
  })
  after(() => {
    if (prevHome === undefined) delete process.env.RIVET_HOME
    else process.env.RIVET_HOME = prevHome
    rmSync(home, { recursive: true, force: true })
  })

  it('updates mergeMethod + toggles and returns the updated config', async () => {
    writeConfig(home, {})
    const router = createRouter(buildConfigRoutes(TOKEN))
    const res = await router('PUT', '/config/pr-defaults', { mergeMethod: 'rebase', autoFix: true }, AUTH)
    assert.equal(res.status, 200)
    const body = res.body as { ok: boolean; prDefaults: { mergeMethod: string; autoFix: boolean; autoMerge: boolean } }
    assert.equal(body.ok, true)
    assert.equal(body.prDefaults.mergeMethod, 'rebase')
    assert.equal(body.prDefaults.autoFix, true)
    assert.equal(body.prDefaults.autoMerge, false)
  })

  it('persists across requests (a follow-up GET sees the change)', async () => {
    writeConfig(home, {})
    const router = createRouter(buildConfigRoutes(TOKEN))
    await router('PUT', '/config/pr-defaults', { mergeMethod: 'merge', ciPollSeconds: 30 }, AUTH)
    const res = await router('GET', '/config/pr-defaults', {}, AUTH)
    const body = res.body as { mergeMethod: string; ciPollSeconds: number }
    assert.equal(body.mergeMethod, 'merge')
    assert.equal(body.ciPollSeconds, 30)
  })

  it('rejects an invalid mergeMethod value (schema validation)', async () => {
    writeConfig(home, {})
    const router = createRouter(buildConfigRoutes(TOKEN))
    const res = await router('PUT', '/config/pr-defaults', { mergeMethod: 'fast-forward' }, AUTH)
    assert.equal(res.status, 400)
  })

  it('rejects an out-of-range ciPollSeconds', async () => {
    writeConfig(home, {})
    const router = createRouter(buildConfigRoutes(TOKEN))
    const res = await router('PUT', '/config/pr-defaults', { ciPollSeconds: 1 }, AUTH)
    assert.equal(res.status, 400)
  })

  it('rejects unauthorized requests', async () => {
    const router = createRouter(buildConfigRoutes(TOKEN))
    const res = await router('PUT', '/config/pr-defaults', { autoFix: true }, {})
    assert.equal(res.status, 401)
  })
})

describe('/config/default-domain', () => {
  const prevHome = process.env.RIVET_HOME
  let home: string
  before(() => {
    home = mkdtempSync(join(tmpdir(), 'rivet-domain-routes-'))
    process.env.RIVET_HOME = home
  })
  after(() => {
    if (prevHome === undefined) delete process.env.RIVET_HOME
    else process.env.RIVET_HOME = prevHome
    rmSync(home, { recursive: true, force: true })
  })

  it('GET returns the defaults (qiming pinned + keyword routing on) with the domain list', async () => {
    writeConfig(home, {})
    const router = createRouter(buildConfigRoutes(TOKEN))
    const res = await router('GET', '/config/default-domain', {}, AUTH)
    assert.equal(res.status, 200)
    const body = res.body as { defaultDomain: string; domainKeywordRouting: boolean; domains: { id: string; name: string }[] }
    assert.equal(body.defaultDomain, 'qiming')
    assert.equal(body.domainKeywordRouting, true)
    assert.ok(body.domains.some(d => d.id === 'tianshu'), 'domain list includes tianshu')
    assert.ok(body.domains.some(d => d.id === 'kaiyang'), 'domain list includes kaiyang')
  })

  it('PUT pins a domain and a follow-up GET sees it', async () => {
    writeConfig(home, {})
    const router = createRouter(buildConfigRoutes(TOKEN))
    const put = await router('PUT', '/config/default-domain', { defaultDomain: 'tianshu' }, AUTH)
    assert.equal(put.status, 200)
    const res = await router('GET', '/config/default-domain', {}, AUTH)
    const body = res.body as { defaultDomain: string }
    assert.equal(body.defaultDomain, 'tianshu')
  })

  it('PUT accepts auto + keyword routing toggle', async () => {
    writeConfig(home, {})
    const router = createRouter(buildConfigRoutes(TOKEN))
    const put = await router('PUT', '/config/default-domain', { defaultDomain: 'auto', domainKeywordRouting: false }, AUTH)
    assert.equal(put.status, 200)
    const body = put.body as { ok: boolean; defaultDomain: string; domainKeywordRouting: boolean }
    assert.equal(body.ok, true)
    assert.equal(body.defaultDomain, 'auto')
    assert.equal(body.domainKeywordRouting, false)
  })

  it('PUT rejects an unknown domain id', async () => {
    writeConfig(home, {})
    const router = createRouter(buildConfigRoutes(TOKEN))
    const res = await router('PUT', '/config/default-domain', { defaultDomain: 'not-a-domain' }, AUTH)
    assert.equal(res.status, 400)
  })

  it('PUT rejects an empty payload', async () => {
    writeConfig(home, {})
    const router = createRouter(buildConfigRoutes(TOKEN))
    const res = await router('PUT', '/config/default-domain', {}, AUTH)
    assert.equal(res.status, 400)
  })

  it('rejects unauthorized requests', async () => {
    const router = createRouter(buildConfigRoutes(TOKEN))
    const res = await router('GET', '/config/default-domain', {}, {})
    assert.equal(res.status, 401)
  })
})

// 桌面端要能自己开关自动选桥：只装桌面端的用户没有 TUI 面板可用，缺这两条路由
// 他们就只能手改 config.json。
describe('/config/vision-auto-bridge', () => {
  const prevHome = process.env.RIVET_HOME
  let home: string

  before(() => {
    home = mkdtempSync(join(tmpdir(), 'rivet-vision-auto-'))
    process.env.RIVET_HOME = home
  })

  after(() => {
    if (prevHome === undefined) delete process.env.RIVET_HOME
    else process.env.RIVET_HOME = prevHome
    rmSync(home, { recursive: true, force: true })
  })

  it('defaults to off — 不替用户决定把图片发给未选中的 provider', async () => {
    const router = createRouter(buildConfigRoutes(TOKEN))
    const res = await router('GET', '/config/vision-auto-bridge', {}, AUTH)
    assert.equal(res.status, 200)
    assert.deepEqual(res.body, { enabled: false })
  })

  it('round-trips the opt-in through PUT + GET', async () => {
    const router = createRouter(buildConfigRoutes(TOKEN))
    const put = await router('PUT', '/config/vision-auto-bridge', { enabled: true }, AUTH)
    assert.equal(put.status, 200)
    assert.deepEqual(put.body, { ok: true, enabled: true })
    const get = await router('GET', '/config/vision-auto-bridge', {}, AUTH)
    assert.deepEqual(get.body, { enabled: true })

    const off = await router('PUT', '/config/vision-auto-bridge', { enabled: false }, AUTH)
    assert.deepEqual(off.body, { ok: true, enabled: false })
  })

  it('rejects a non-boolean payload instead of coercing it', async () => {
    const router = createRouter(buildConfigRoutes(TOKEN))
    const res = await router('PUT', '/config/vision-auto-bridge', { enabled: 'yes' }, AUTH)
    assert.equal(res.status, 400)
  })

  it('rejects unauthorized requests', async () => {
    const router = createRouter(buildConfigRoutes(TOKEN))
    assert.equal((await router('GET', '/config/vision-auto-bridge', {}, {})).status, 401)
    assert.equal((await router('PUT', '/config/vision-auto-bridge', { enabled: true }, {})).status, 401)
  })
})

describe('POST /config/providers model vision round-trip', () => {
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

  it('persists supportsVision=true on an added model and returns it in the list', async () => {
    writeConfig(home, {})
    const router = createRouter(buildConfigRoutes(TOKEN))
    const setup = await router('POST', '/config/providers', {
      providerName: 'deepseek',
      model: { id: 'vis-roundtrip', contextWindow: 128000, maxTokens: 32000, supportsVision: true },
    }, AUTH)
    assert.equal(setup.status, 200)

    const list = await router('GET', '/config/providers', {}, AUTH)
    assert.equal(list.status, 200)
    const body = list.body as { providers: { name: string; models: { id: string; supportsVision?: boolean }[] }[] }
    const ds = body.providers.find(p => p.name === 'deepseek')!
    assert.equal(ds.models.find(m => m.id === 'vis-roundtrip')?.supportsVision, true)
  })

  it('explicit supportsVision=false on a preset vision model survives (no backfill re-fill)', async () => {
    writeConfig(home, {})
    const router = createRouter(buildConfigRoutes(TOKEN))
    // glm-5.2 是 preset 视觉模型：显式 false 必须写盘，且 GET 返回 false
    const setup = await router('POST', '/config/providers', {
      providerName: 'glm',
      model: { id: 'glm-5.2', contextWindow: 1000000, maxTokens: 131072, supportsVision: false },
    }, AUTH)
    assert.equal(setup.status, 200)

    const list = await router('GET', '/config/providers', {}, AUTH)
    assert.equal(list.status, 200)
    const body = list.body as { providers: { name: string; models: { id: string; supportsVision?: boolean }[] }[] }
    const glm = body.providers.find(p => p.name === 'glm')!
    assert.equal(glm.models.find(m => m.id === 'glm-5.2')?.supportsVision, false)
  })

  it('rejects a malformed model payload', async () => {
    writeConfig(home, {})
    const router = createRouter(buildConfigRoutes(TOKEN))
    const res = await router('POST', '/config/providers', {
      providerName: 'deepseek',
      model: { id: 'bad', contextWindow: -1, maxTokens: 32000 },
    }, AUTH)
    assert.equal(res.status, 400)
  })
})

describe('provider delete: preset-name deadlock', () => {
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

  it('POST /config/providers/custom rejects built-in preset names', async () => {
    writeConfig(home, {})
    const router = createRouter(buildConfigRoutes(TOKEN))
    const res = await router('POST', '/config/providers/custom', {
      providerName: 'zhipu-vision',
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'sk',
      model: { id: 'm', contextWindow: 128000, maxTokens: 32000 },
    }, AUTH)
    assert.equal(res.status, 400)
    assert.match((res.body as { error: string }).error, /built-in preset name/i)
  })

  it('DELETE /config/providers/:name removes a legacy custom entry whose name collides with a preset', async () => {
    // 历史死锁存量：setupCustomProvider 曾允许用预设名创建条目，删除被按名字拦截。
    // 直接写盘构造存量条目（zhipu-vision 不在 DEFAULT_CONFIG，删除后不回填）。
    const configPath = join(home, 'config.json')
    writeFileSync(configPath, JSON.stringify({
      provider: {
        default: 'deepseek',
        providers: {
          'zhipu-vision': {
            name: 'zhipu-vision',
            baseUrl: 'https://custom.example.com/v1',
            apiKey: 'sk-legacy',
            protocol: 'openai',
            capabilities: { cacheControl: false, stripParams: [], toolJsonBug: false, prefixCache: 'none', prefixCompletion: false },
            thinking: 'enabled',
            maxTokens: 8000,
            allowProFallback: false,
            models: [{ id: 'custom-model', contextWindow: 128000, maxTokens: 8000 }],
            unsupported: [],
          },
        },
      },
      pro: {},
    }, null, 2) + '\n')

    const router = createRouter(buildConfigRoutes(TOKEN))
    const del = await router('DELETE', '/config/providers/zhipu-vision', {}, AUTH)
    assert.equal(del.status, 200)
    assert.deepEqual(del.body, { ok: true, removed: 'zhipu-vision' })

    const list = await router('GET', '/config/providers', {}, AUTH)
    assert.equal(list.status, 200)
    const body = list.body as { providers: { name: string }[] }
    assert.equal(body.providers.find(p => p.name === 'zhipu-vision'), undefined)
  })

  it('GET /config/providers returns presetKeys for frontend name-collision validation', async () => {
    writeConfig(home, {})
    const router = createRouter(buildConfigRoutes(TOKEN))
    const list = await router('GET', '/config/providers', {}, AUTH)
    assert.equal(list.status, 200)
    const body = list.body as { presetKeys: string[] }
    assert.ok(Array.isArray(body.presetKeys))
    assert.ok(body.presetKeys.includes('deepseek'))
    assert.ok(body.presetKeys.includes('zhipu-vision'))
  })

  it('GET /config/providers sorts configured providers by recommended preset order (deepseek first)', async () => {
    // 故意用非推荐序写盘：glm → minimax → deepseek，断言响应重排为 deepseek 第一。
    const stub = {
      name: 'x',
      baseUrl: 'https://api.example.com/v1',
      protocol: 'openai',
      capabilities: { cacheControl: false, stripParams: [], toolJsonBug: false, prefixCache: 'none', prefixCompletion: false },
      thinking: 'enabled',
      maxTokens: 8000,
      models: [{ id: 'm', contextWindow: 128000, maxTokens: 8000 }],
      unsupported: [],
    }
    writeFileSync(join(home, 'config.json'), JSON.stringify({
      provider: {
        default: 'deepseek',
        providers: {
          glm: { ...stub, name: 'glm' },
          minimax: { ...stub, name: 'minimax' },
          deepseek: { ...stub, name: 'deepseek' },
        },
      },
      pro: {},
    }, null, 2) + '\n')

    const router = createRouter(buildConfigRoutes(TOKEN))
    const list = await router('GET', '/config/providers', {}, AUTH)
    assert.equal(list.status, 200)
    const names = (list.body as { providers: { name: string }[] }).providers.map(p => p.name)
    assert.equal(names[0], 'deepseek', `deepseek 必须排第一（got ${names.join(',')}）`)
    assert.ok(names.indexOf('glm') < names.indexOf('minimax'), 'glm 应排在 minimax 前（preset 原序）')
  })

  it('DELETE /config/providers/:name still refuses the default provider', async () => {
    writeConfig(home, {})
    const router = createRouter(buildConfigRoutes(TOKEN))
    // deepseek 是默认 provider（writeConfig 的 default 字段）——default 保护仍在
    const res = await router('DELETE', '/config/providers/deepseek', {}, AUTH)
    assert.equal(res.status, 400)
    assert.match((res.body as { error: string }).error, /default provider/i)
  })
})
