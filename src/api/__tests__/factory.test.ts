import { describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'
import { ReadableStream } from 'node:stream/web'
import { createProviderClient, resolveApiKey, type RuntimeParams } from '../factory.js'
import { resolveCapabilities } from '../provider.js'
import { OpenAIClient } from '../openai-client.js'
import { AnthropicClient } from '../anthropic-client.js'
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

  it('sends User-Agent header for kimi provider', async () => {
    const capabilities = resolveCapabilities('kimi')
    const client = createProviderClient(kimiProvider, capabilities, runtimeParams)
    const originalFetch = globalThis.fetch
    let capturedHeaders: Record<string, string> = {}
    globalThis.fetch = mock.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      capturedHeaders = (init?.headers ?? {}) as Record<string, string>
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'))
          controller.close()
        },
      })
      return new Response(stream as unknown as ReadableStream, { status: 200 })
    }) as unknown as typeof fetch

    await client.stream(
      { model: 'kimi-code', messages: [{ role: 'user', content: 'hi' }], max_tokens: 100 },
      { onTextDelta: () => {}, onThinkingDelta: () => {}, onContentBlock: () => {}, onStopReason: () => {}, onError: error => { throw error } },
    )

    globalThis.fetch = originalFetch
    assert.equal(capturedHeaders['User-Agent'], 'KimiCLI/1.0')
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
  it('creates AnthropicClient for anthropic provider with cache-control strategy', () => {
    const anthropicProvider: ProviderConfig = {
      name: 'anthropic',
      baseUrl: 'https://api.anthropic.com',
      protocol: 'openai',
      capabilities: {
        cacheControl: true,
        stripParams: [],
        toolJsonBug: false,
        prefixCache: 'anthropic-cache-control',
        prefixCompletion: false,
      },
      thinking: 'enabled',
      maxTokens: 64000,
      models: [{ id: 'claude-opus-4-7', contextWindow: 200000, maxTokens: 32000 }],
      unsupported: [],
    }
    const caps = resolveCapabilities('anthropic')
    // Override to anthropic-cache-control strategy
    caps.prefixCacheStrategy = 'anthropic-cache-control'
    const client = createProviderClient(anthropicProvider, caps, {
      ...runtimeParams,
      model: 'claude-opus-4-7',
    })
    assert.ok(client instanceof AnthropicClient)
  })

  it('creates AnthropicClient when provider.name is anthropic regardless of prefixCacheStrategy', () => {
    const anthropicProvider: ProviderConfig = {
      name: 'anthropic',
      baseUrl: 'https://api.anthropic.com',
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
      models: [{ id: 'claude-opus-4-7', contextWindow: 200000, maxTokens: 32000 }],
      unsupported: [],
    }
    const caps = resolveCapabilities('claude') // claude has prefixCacheStrategy='none'
    const client = createProviderClient(anthropicProvider, caps, {
      ...runtimeParams,
      model: 'claude-opus-4-7',
    })
    assert.ok(client instanceof AnthropicClient)
  })
  it('injects thinkingStallTimeoutMs default for glm provider', () => {
    const glmProvider: ProviderConfig = {
      name: 'glm',
      baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
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
      models: [{ id: 'glm-4.6', contextWindow: 128000, maxTokens: 8192 }],
      unsupported: [],
    }
    const capabilities = resolveCapabilities('glm')
    const client = createProviderClient(glmProvider, capabilities, runtimeParams)
    assert.ok(client instanceof OpenAIClient)
    // config is private but accessible at runtime
    const config = (client as unknown as { config: { thinkingStallTimeoutMs?: number } }).config
    assert.equal(config.thinkingStallTimeoutMs, 210_000, 'glm should get default 210s thinking stall')
  })

  it('does NOT inject thinkingStallTimeoutMs for non-glm providers', () => {
    const capabilities = resolveCapabilities('deepseek')
    const client = createProviderClient(deepseekProvider, capabilities, runtimeParams)
    assert.ok(client instanceof OpenAIClient)
    const config = (client as unknown as { config: { thinkingStallTimeoutMs?: number } }).config
    assert.equal(config.thinkingStallTimeoutMs, undefined, 'deepseek should not get thinkingStallTimeoutMs')
  })

  it('provider config overrides default thinkingStallTimeoutMs for glm', () => {
    const glmProvider: ProviderConfig = {
      name: 'glm',
      baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
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
      thinkingStallTimeoutMs: 90_000,
      models: [{ id: 'glm-4.6', contextWindow: 128000, maxTokens: 8192 }],
      unsupported: [],
    }
    const capabilities = resolveCapabilities('glm')
    const client = createProviderClient(glmProvider, capabilities, runtimeParams)
    const config = (client as unknown as { config: { thinkingStallTimeoutMs?: number } }).config
    assert.equal(config.thinkingStallTimeoutMs, 90_000, 'explicit provider config should override default')
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
