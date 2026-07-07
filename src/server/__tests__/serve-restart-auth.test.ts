import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveServeContext, resolveModelSpec, isModelSpecUsable, unconfiguredSpecMessage } from '../serve.js'
import type { ResolvedModelSpec } from '../serve.js'
import type { Config, ProviderConfig } from '../../config/schema.js'

// Regression shield for the 2026-07-05 field report: after the sidecar is
// killed and respawned, an INLINE config key must recover (no 401), while an
// apiKeyEnv provider whose env var is missing in the new process must degrade
// to configured=false — which the ManagedAgent run guard turns into a legible
// error instead of an opaque upstream 401.

function provider(overrides: Partial<ProviderConfig> & { name: string }): ProviderConfig {
  return {
    baseUrl: 'https://api.deepseek.com',
    protocol: 'openai',
    capabilities: { cacheControl: false, stripParams: [], toolJsonBug: false, prefixCache: 'none', prefixCompletion: false },
    models: [{ id: 'deepseek-pro', maxTokens: 8192, contextWindow: 128_000 }],
    ...overrides,
  } as ProviderConfig
}

function config(p: ProviderConfig): Config {
  return {
    editor: { platform: 'darwin', eol: 'lf' },
    env: { gitBashPath: undefined },
    provider: { default: p.name, providers: { [p.name]: p } },
  } as unknown as Config
}

function spec(overrides: Partial<ResolvedModelSpec>): ResolvedModelSpec {
  return {
    provider: provider({ name: 'deepseek' }),
    apiKey: '',
    auth: undefined,
    model: { id: 'deepseek-pro', maxTokens: 8192, contextWindow: 128_000 },
    ...overrides,
  }
}

test('sidecar restart: inline config key recovers (configured, non-empty apiKey)', () => {
  const ctx = resolveServeContext(() => config(provider({ name: 'deepseek', apiKey: 'sk-inline-123' })))
  assert.equal(ctx.configured, true)
  assert.equal(ctx.apiKey, 'sk-inline-123')
})

test('sidecar restart: apiKeyEnv provider with missing env degrades to unconfigured', () => {
  const envVar = 'RIVET_TEST_MISSING_KEY_9182'
  const defaultVar = 'XNOAUTHTEST_API_KEY'
  delete process.env[envVar]
  delete process.env[defaultVar]
  const ctx = resolveServeContext(() =>
    config(provider({ name: 'xnoauthtest', apiKeyEnv: envVar })),
  )
  assert.equal(ctx.configured, false)
  assert.equal(ctx.apiKey, '')
})

test('resolveModelSpec adopts the freshly-resolved key for the snapshot provider (hot key pickup)', () => {
  // The server started unconfigured (empty ctx.apiKey), then the user saved an
  // inline key via Settings. Resolving the SAME provider's model must surface
  // the key from the provider config — not replay the stale empty snapshot key.
  const unconfigured = resolveServeContext(() =>
    config(provider({ name: 'xnokeyyet' })),
  )
  assert.equal(unconfigured.configured, false)
  const withKey = {
    ...unconfigured,
    config: config(provider({ name: 'xnokeyyet', apiKey: 'sk-added-later' })),
  }
  const resolved = resolveModelSpec(withKey, 'deepseek-pro')
  assert.ok(resolved)
  assert.equal(resolved.apiKey, 'sk-added-later')
  assert.equal(isModelSpecUsable(resolved), true)
})

test('isModelSpecUsable: inline key or auth is usable, empty+no-auth is not', () => {
  assert.equal(isModelSpecUsable(spec({ apiKey: 'sk-live' })), true)
  assert.equal(isModelSpecUsable(spec({ apiKey: '', auth: {} as ResolvedModelSpec['auth'] })), true)
  assert.equal(isModelSpecUsable(spec({ apiKey: '', auth: undefined })), false)
})

test('unconfiguredSpecMessage: names the provider and the missing env var', () => {
  const msg = unconfiguredSpecMessage(spec({ provider: provider({ name: 'deepseek', apiKeyEnv: 'DEEPSEEK_KEY' }) }))
  assert.match(msg, /deepseek/)
  assert.match(msg, /DEEPSEEK_KEY/)
  assert.match(msg, /was not sent/)
})

test('unconfiguredSpecMessage: falls back to Settings hint without apiKeyEnv', () => {
  const msg = unconfiguredSpecMessage(spec({ provider: provider({ name: 'deepseek' }) }))
  assert.match(msg, /Settings|config setup/)
})
