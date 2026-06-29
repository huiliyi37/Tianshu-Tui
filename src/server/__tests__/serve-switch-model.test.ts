import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveModelSpecWithReload, type ServeContext } from '../serve.js'
import type { ProviderConfig } from '../../config/schema.js'

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
