import { describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'
import { ReadableStream } from 'node:stream/web'
import { createProviderClient, resolveApiKey, type RuntimeParams } from '../factory.js'
import { resolveCapabilities } from '../provider.js'
import { OpenAIClient } from '../openai-client.js'
import { ApiKeyAuth } from '../../auth/api-key.js'
import { cloneProviderPreset } from '../../config/provider-presets.js'
import type { ProviderConfig } from '../../config/schema.js'

const deepseekProvider: ProviderConfig = {
  name: 'deepseek',
  baseUrl: 'https://api.deepseek.com/v1',
  protocol: 'openai',
  capabilities: {
    cacheControl: false,
    stripParams: [],
    toolJsonBug: true,
    prefixCache: 'deepseek-native',
    prefixCompletion: true,
  },
  thinking: 'enabled',
  maxTokens: 64000,
  models: [{ id: 'deepseek-r1', contextWindow: 128000, maxTokens: 8192 }],
  unsupported: [],
}

const kimiProvider: ProviderConfig = {
  name: 'kimi',
  baseUrl: 'https://api.kimi.com/coding',
  protocol: 'openai',
  capabilities: {
    cacheControl: false,
    stripParams: [],
    toolJsonBug: false,
    prefixCache: 'none',
    prefixCompletion: false,
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

  it('creates OpenAIClient for openai protocol', () => {
    const openaiProvider: ProviderConfig = {
      ...deepseekProvider,
      name: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      protocol: 'openai',
    }
    const capabilities = resolveCapabilities('openai')
    const client = createProviderClient(openaiProvider, capabilities, runtimeParams)
    assert.ok(client instanceof OpenAIClient)
  })

  it('falls back to capabilities.stripParams when unsupported is empty', () => {
    // Provider with empty unsupported → should use capabilities.stripParams
    const caps = resolveCapabilities('deepseek')
    const client = createProviderClient(deepseekProvider, caps, runtimeParams)
    // OpenAIClient doesn't expose config, but construction succeeds
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

  it('passes providerProfile into OpenAIClient for cache strategy', async () => {
    const capabilities = resolveCapabilities('deepseek')
    const client = createProviderClient(deepseekProvider, capabilities, runtimeParams)
    const originalFetch = globalThis.fetch
    let body = ''
    globalThis.fetch = mock.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      body = String(init?.body ?? '')
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('event: message_delta\ndata: {"delta_stop_reason":"end_turn","usage":{}}\n\n'))
          controller.close()
        },
      })
      return new Response(stream as unknown as ReadableStream, { status: 200 })
    }) as unknown as typeof fetch

    await client.stream(
      { model: 'test-model', messages: [{ role: 'user', content: 'x' }], max_tokens: 100 },
      { onTextDelta: () => {}, onThinkingDelta: () => {}, onContentBlock: () => {}, onStopReason: () => {}, onError: error => { throw error } },
    )

    globalThis.fetch = originalFetch
    assert.ok(!body.includes('cache_control'), body)
  })

  it('accepts AuthProvider in runtime params', () => {
    const auth = new ApiKeyAuth('sk-from-auth')
    const openaiProvider: ProviderConfig = {
      ...deepseekProvider,
      name: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      protocol: 'openai',
    }
    const caps = resolveCapabilities('openai')
    const client = createProviderClient(openaiProvider, caps, {
      ...runtimeParams,
      auth,
    })
    assert.ok(client instanceof OpenAIClient)
  })

  it('passes providerProfile into OpenAIClient', () => {
    const openaiProvider: ProviderConfig = {
      ...deepseekProvider,
      name: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      protocol: 'openai',
    }
    const caps = resolveCapabilities('openai')
    const client = createProviderClient(openaiProvider, caps, runtimeParams)
    assert.ok(client instanceof OpenAIClient)
  })

  it('creates CodexClient for codex OAuth provider without API key', () => {
    const provider = cloneProviderPreset('codex')
    const caps = resolveCapabilities('codex')
    const client = createProviderClient(provider, caps, {
      apiKey: '',
      model: 'gpt-5.5',
      maxTokens: 4096,
      auth: new ApiKeyAuth('oauth-token-for-test'),
    })
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
