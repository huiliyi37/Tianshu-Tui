import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  loadConfig,
  setupProvider,
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
})
