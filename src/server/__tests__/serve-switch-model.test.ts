import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { resolveModelSpecWithReload, listAllModelsWithReload, type ServeContext } from '../serve.js'
import type { ProviderConfig } from '../../config/schema.js'

// Regression shield: these tests assert behavior when a provider has no
// configured key. The standard DEEPSEEK_API_KEY env var must not leak into
// the test provider, otherwise resolveApiKey() finds a key and the snapshot
// is wrongly treated as resolvable, masking the reload path.
const ORIGINAL_DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY
delete process.env.DEEPSEEK_API_KEY
after(() => {
  if (ORIGINAL_DEEPSEEK_API_KEY !== undefined) {
    process.env.DEEPSEEK_API_KEY = ORIGINAL_DEEPSEEK_API_KEY
  }
})

/**
 * Regression: first-install model switch. The server starts in setup mode
 * (configured=false, no API key) and the user configures the key via /config
 * afterwards. switchModel must resolve the target model against the *live*
 * config (fresh on-disk read), not just the keyless startup snapshot —
 * otherwise pro→flash 409s until the app restarts.
 */

function deepseekProvider(apiKey: string | undefined): ProviderConfig {
  return {
    name: 'deepseek',
    apiKey,
    baseUrl: 'https://api.deepseek.com',
    protocol: 'openai',
    capabilities: { cacheControl: false, stripParams: [], toolJsonBug: false, prefixCache: 'none', prefixCompletion: false },
    models: [
      { id: 'deepseek-pro', alias: 'pro', contextWindow: 128_000, maxTokens: 8192 },
      { id: 'deepseek-flash', alias: 'flash', contextWindow: 128_000, maxTokens: 8192 },
    ],
    thinking: 'enabled',
    maxTokens: 64_000,
    unsupported: [],
  } as ProviderConfig
}

function makeCtx(apiKey: string, providerApiKey: string | undefined): ServeContext {
  const provider = deepseekProvider(providerApiKey)
  return {
    config: { provider: { default: 'deepseek', providers: { deepseek: provider } } } as unknown as ServeContext['config'],
    provider,
    model: provider.models[0]!,
    apiKey,
    configured: apiKey !== '',
  }
}

test('resolveModelSpecWithReload: keyless startup snapshot falls back to fresh config', () => {
  // Startup snapshot — setup mode, no key anywhere on the deepseek provider.
  const snapshot = makeCtx('', undefined)
  // Fresh on-disk read after the user configured the key.
  let reloadCalls = 0
  const reload = (): ServeContext => {
    reloadCalls++
    return makeCtx('sk-configured', 'sk-configured')
  }

  const spec = resolveModelSpecWithReload(snapshot, 'flash', reload)
  assert.ok(spec, 'expected the target model to resolve via the fresh reload')
  assert.equal(spec!.model.id, 'deepseek-flash')
  assert.equal(spec!.apiKey, 'sk-configured', 'must carry the freshly configured key, not the empty snapshot key')
  assert.equal(reloadCalls, 1, 'reload should be consulted exactly once on the snapshot miss')
})

test('resolveModelSpecWithReload: configured snapshot resolves without reloading', () => {
  const snapshot = makeCtx('sk-live', 'sk-live')
  let reloadCalls = 0
  const reload = (): ServeContext => { reloadCalls++; return snapshot }

  const spec = resolveModelSpecWithReload(snapshot, 'flash', reload)
  assert.ok(spec)
  assert.equal(spec!.model.id, 'deepseek-flash')
  assert.equal(reloadCalls, 0, 'no fresh read when the startup snapshot already resolves')
})

test('resolveModelSpecWithReload: unknown model returns null even after reload', () => {
  const snapshot = makeCtx('sk-live', 'sk-live')
  const spec = resolveModelSpecWithReload(snapshot, 'nonexistent-model', () => snapshot)
  assert.equal(spec, null)
})

test('resolveModelSpecWithReload: reload throwing degrades to null (no crash)', () => {
  const snapshot = makeCtx('', undefined)
  const spec = resolveModelSpecWithReload(snapshot, 'flash', () => {
    throw new Error('default provider not configured')
  })
  assert.equal(spec, null)
})

function extraProvider(name: string, modelId: string): ProviderConfig {
  return {
    name,
    apiKey: 'sk-extra',
    baseUrl: 'https://api.example.com',
    protocol: 'openai',
    capabilities: { cacheControl: false, stripParams: [], toolJsonBug: false, prefixCache: 'none', prefixCompletion: false },
    models: [{ id: modelId, alias: modelId, contextWindow: 128_000, maxTokens: 8192 }],
    thinking: 'enabled',
    maxTokens: 64_000,
    unsupported: [],
  } as ProviderConfig
}

function ctxWith(providers: Record<string, ProviderConfig>): ServeContext {
  const [firstName, firstProvider] = Object.entries(providers)[0]!
  return {
    config: { provider: { default: firstName, providers } } as unknown as ServeContext['config'],
    provider: firstProvider,
    model: firstProvider.models[0]!,
    apiKey: firstProvider.apiKey ?? '',
    configured: true,
  }
}

test('listAllModelsWithReload: surfaces a provider added after startup (no restart)', () => {
  // Startup snapshot only knew about deepseek...
  const snapshot = ctxWith({ deepseek: deepseekProvider('sk-live') })
  // ...the user later configured a brand-new provider via Settings.
  const fresh = ctxWith({
    deepseek: deepseekProvider('sk-live'),
    glm: extraProvider('glm', 'glm-4-plus'),
  })

  const models = listAllModelsWithReload(snapshot, () => fresh)
  const ids = models.map((m) => m.id)
  assert.ok(ids.includes('deepseek-flash'))
  assert.ok(ids.includes('glm-4-plus'), 'newly-configured provider must appear without a restart')
})

test('listAllModelsWithReload: falls back to the snapshot when the fresh read throws', () => {
  const snapshot = ctxWith({ deepseek: deepseekProvider('sk-live') })
  const models = listAllModelsWithReload(snapshot, () => { throw new Error('mid-edit config') })
  assert.deepEqual(models.map((m) => m.id).sort(), ['deepseek-flash', 'deepseek-pro'])
})

function twinProviders(): Record<string, ProviderConfig> {
  // deepseek + deepseek-spark 共享同一 wire model id（API 型号名不能改）
  const models = [
    { id: 'deepseek-v4-flash', alias: 'v4-flash', contextWindow: 1_000_000, maxTokens: 384_000 },
    { id: 'deepseek-v4-pro', alias: 'v4-pro', contextWindow: 1_000_000, maxTokens: 384_000 },
  ]
  const mk = (name: string, aliasFlash: string, aliasPro: string): ProviderConfig => ({
    name,
    apiKey: `sk-${name}`,
    baseUrl: 'https://api.deepseek.com/v1',
    protocol: 'openai',
    capabilities: { cacheControl: false, stripParams: [], toolJsonBug: true, prefixCache: 'deepseek-native', prefixCompletion: true },
    models: [
      { ...models[0]!, alias: aliasFlash },
      { ...models[1]!, alias: aliasPro },
    ],
    thinking: 'enabled',
    maxTokens: 384_000,
    unsupported: [],
  } as ProviderConfig)
  return {
    deepseek: mk('deepseek', 'v4-flash', 'v4-pro'),
    'deepseek-spark': mk('deepseek-spark', 'spark-flash', 'spark-pro'),
  }
}

test('resolveModelSpec: provider:modelId 消歧到 spark，不撞官方 deepseek', () => {
  const ctx = ctxWith(twinProviders())
  const stay = () => ctx // 禁止回落到本机真实 config
  const bare = resolveModelSpecWithReload(ctx, 'deepseek-v4-flash', stay)
  assert.ok(bare)
  assert.equal(bare!.provider.name, 'deepseek', '裸 id 仍优先官方节点（兼容旧会话）')

  const spark = resolveModelSpecWithReload(ctx, 'deepseek-spark:deepseek-v4-flash', stay)
  assert.ok(spark, 'provider 前缀必须能解析 spark')
  assert.equal(spark!.provider.name, 'deepseek-spark')
  assert.equal(spark!.model.id, 'deepseek-v4-flash', 'wire model id 不变')
  assert.equal(spark!.apiKey, 'sk-deepseek-spark')

  const byAlias = resolveModelSpecWithReload(ctx, 'deepseek-spark:spark-flash', stay)
  assert.ok(byAlias)
  assert.equal(byAlias!.provider.name, 'deepseek-spark')
  assert.equal(byAlias!.model.id, 'deepseek-v4-flash')
})

test('resolveModelSpec: 未知 provider 前缀或该节点无此模型 → null', () => {
  const ctx = ctxWith(twinProviders())
  const stay = () => ctx
  assert.equal(resolveModelSpecWithReload(ctx, 'nope:deepseek-v4-flash', stay), null)
  assert.equal(resolveModelSpecWithReload(ctx, 'deepseek-spark:ghost-model', stay), null)
})

test('listAllModels: 同 wire id 在两节点各出一条（欢迎页/选择器不丢 spark）', () => {
  const ctx = ctxWith(twinProviders())
  const models = listAllModelsWithReload(ctx, () => ctx)
  const flash = models.filter((m) => m.id === 'deepseek-v4-flash')
  assert.equal(flash.length, 2, '两节点同 id 必须都列出')
  assert.deepEqual(flash.map((m) => m.provider).sort(), ['deepseek', 'deepseek-spark'])
  assert.ok(models.some((m) => m.provider === 'deepseek-spark' && m.alias === 'spark-flash'))
})
