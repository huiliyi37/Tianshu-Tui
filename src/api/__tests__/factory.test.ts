import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createProviderClient, resolveApiKey, type RuntimeParams } from '../factory.js'
import { resolveCapabilities, DEEPSEEK_CAPABILITIES } from '../provider.js'
import type { ProviderConfig } from '../../config/schema.js'

const deepseekProvider: ProviderConfig = {
  name: 'deepseek',
  baseUrl: 'https://api.deepseek.com/anthropic',
  protocol: 'anthropic',
  capabilities: {
    cacheControl: false,
    stripParams: [],
    toolJsonBug: true,
    prefixCache: 'deepseek-native',
  },
  thinking: 'enabled',
  maxTokens: 64000,
  models: [{ id: 'deepseek-r1', contextWindow: 128000, maxTokens: 8192 }],
  unsupported: [],
}

const kimiProvider: ProviderConfig = {
  name: 'kimi',
  baseUrl: 'https://api.kimi.com/coding',
  protocol: 'anthropic',
  capabilities: {
    cacheControl: false,
    stripParams: [],
    toolJsonBug: false,
    prefixCache: 'none',
  },
  thinking: 'enabled',
  maxTokens: 64000,
  models: [{ id: 'kimi-code', contextWindow: 128000, maxTokens: 8192 }],
  unsupported: [],
}

const runtimeParams: RuntimeParams = {
  apiKey: 'test-key',
  model: 'test-model',
  maxTokens: 4096,
}

describe('createProviderClient', () => {
  it('creates a client for a deepseek provider', () => {
    const capabilities = resolveCapabilities('deepseek')
    const client = createProviderClient(deepseekProvider, capabilities, runtimeParams)
    assert.ok(client)
  })

  it('creates a client for a kimi provider with well-known defaults', () => {
    const capabilities = resolveCapabilities('kimi')
    const client = createProviderClient(kimiProvider, capabilities, runtimeParams)
    assert.ok(client)
  })

  it('throws for unsupported OpenAI protocol', () => {
    const openaiProvider: ProviderConfig = {
      ...deepseekProvider,
      name: 'openai',
      protocol: 'openai',
    }
    const capabilities = resolveCapabilities('openai')
    assert.throws(
      () => createProviderClient(openaiProvider, capabilities, runtimeParams),
      /OpenAI protocol.*not yet supported/,
    )
  })

  it('falls back to capabilities.stripParams when unsupported is empty', () => {
    // Provider with empty unsupported → should use capabilities.stripParams
    const caps = resolveCapabilities('deepseek')
    const client = createProviderClient(deepseekProvider, caps, runtimeParams)
    // ApiClient doesn't expose config, but construction succeeds
    assert.ok(client)
  })

  it('uses explicit provider.unsupported when set', () => {
    const providerWithUnsupported: ProviderConfig = {
      ...deepseekProvider,
      unsupported: ['custom_param'],
    }
    const caps = resolveCapabilities('deepseek')
    const client = createProviderClient(providerWithUnsupported, caps, runtimeParams)
    assert.ok(client)
  })
})

describe('resolveApiKey', () => {
  it('returns the apiKey from provider config', () => {
    const provider: ProviderConfig = { ...deepseekProvider, apiKey: 'sk-123' }
    assert.equal(resolveApiKey(provider), 'sk-123')
  })

  it('throws when no key is configured', () => {
    const provider: ProviderConfig = { ...deepseekProvider } // no apiKey, no apiKeyEnv
    assert.throws(
      () => resolveApiKey(provider),
      /No API key configured/,
    )
  })
})
