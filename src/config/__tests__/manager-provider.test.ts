import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  loadConfig,
  setupProvider,
  setupCustomProvider,
  updateProviderBaseUrl,
  upsertProviderModel,
  setApiKey,
  setApiKeyEnv,
} from '../manager.js'

describe('provider config mutations', () => {
  let dir = ''

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rivet-provider-config-'))
    process.env.RIVET_CONFIG_PATH = join(dir, 'config.json')
  })

  afterEach(() => {
    delete process.env.RIVET_CONFIG_PATH
    rmSync(dir, { recursive: true, force: true })
  })

  it('sets baseUrl without changing models', () => {
    updateProviderBaseUrl('deepseek', 'https://gateway.example.com/v1')
    const provider = loadConfig().provider.providers.deepseek!
    assert.equal(provider.baseUrl, 'https://gateway.example.com/v1')
    assert.equal(provider.models[0]?.id, 'deepseek-v4-pro')
  })

  it('upserts a model and makes it preferred', () => {
    upsertProviderModel('deepseek', { id: 'deepseek-custom', alias: 'custom', contextWindow: 200000, maxTokens: 32000 }, { preferred: true })
    const provider = loadConfig().provider.providers.deepseek!
    assert.equal(provider.models[0]?.id, 'deepseek-custom')
    upsertProviderModel('deepseek', { id: 'deepseek-custom', alias: 'custom2', contextWindow: 300000, maxTokens: 64000 }, { preferred: true })
    assert.equal(loadConfig().provider.providers.deepseek!.models.filter(m => m.id === 'deepseek-custom').length, 1)
    assert.equal(loadConfig().provider.providers.deepseek!.models[0]?.alias, 'custom2')
  })

  it('clamps maxTokens to the context window on upsert (mis-config backstop)', () => {
    upsertProviderModel('deepseek', { id: 'over-cfg', alias: 'over', contextWindow: 128000, maxTokens: 1000000 })
    const model = loadConfig().provider.providers.deepseek!.models.find(m => m.id === 'over-cfg')!
    assert.equal(model.contextWindow, 128000)
    assert.equal(model.maxTokens, 128000)
  })

  it('clamps maxTokens via setupProvider model option too', () => {
    setupProvider({ providerName: 'deepseek', model: { id: 'over-setup', alias: 'over2', contextWindow: 64000, maxTokens: 500000 } })
    const model = loadConfig().provider.providers.deepseek!.models.find(m => m.id === 'over-setup')!
    assert.equal(model.maxTokens, 64000)
  })

  it('sets apiKey and apiKeyEnv as mutually exclusive sources', () => {
    setApiKey('minimax', 'sk-inline')
    const inlineProvider = loadConfig().provider.providers.minimax!
    assert.equal(inlineProvider.apiKey, 'sk-inline')
    assert.equal(inlineProvider.apiKeyEnv, undefined)
    setApiKeyEnv('minimax', 'MINIMAX_API_KEY')
    const provider = loadConfig().provider.providers.minimax!
    assert.equal(provider.apiKey, undefined)
    assert.equal(provider.apiKeyEnv, 'MINIMAX_API_KEY')
  })

  it('setupProvider creates codex from preset and makes it default', () => {
    setupProvider({ providerName: 'codex', preset: 'codex', makeDefault: true })
    const config = loadConfig()
    assert.equal(config.provider.default, 'codex')
    assert.deepEqual(config.provider.providers.codex!.auth, { type: 'oauth', provider: 'codex' })
  })

  it('setupCustomProvider materializes a full OpenAI-wire provider and makes it default', () => {
    setupCustomProvider({
      providerName: 'custom-my-model',
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'sk-custom',
      model: { id: 'my-model', alias: 'mine', contextWindow: 1_000_000, maxTokens: 2_000_000 },
      makeDefault: true,
    })
    const config = loadConfig()
    const provider = config.provider.providers['custom-my-model']!
    assert.equal(config.provider.default, 'custom-my-model')
    assert.equal(provider.baseUrl, 'https://api.example.com/v1')
    assert.equal(provider.apiKey, 'sk-custom')
    assert.equal(provider.protocol, 'openai')
    assert.equal(provider.models[0]?.id, 'my-model')
    assert.equal(provider.models[0]?.contextWindow, 1_000_000)
    // Output tokens are capped to the context window.
    assert.equal(provider.models[0]?.maxTokens, 1_000_000)
    assert.equal(provider.capabilities.prefixCache, 'none')
  })

  it('setupCustomProvider rejects an invalid base URL', () => {
    assert.throws(() => setupCustomProvider({
      providerName: 'custom-bad',
      baseUrl: 'not-a-url',
      apiKey: 'sk',
      model: { id: 'm', contextWindow: 1000, maxTokens: 500 },
    }))
  })
})
