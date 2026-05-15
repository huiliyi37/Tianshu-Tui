import { ApiClient, type ClientConfig } from './client.js'
import type { Usage } from './types.js'
import { DEEPSEEK_CAPABILITIES, type ProviderCapabilities } from './provider.js'

export function mapDeepSeekUsage(raw: Record<string, unknown>): Usage {
  return {
    // Support both DeepSeek native format and Anthropic compatibility format
    input_tokens: (raw.prompt_tokens ?? raw.input_tokens ?? 0) as number,
    output_tokens: (raw.completion_tokens ?? raw.output_tokens ?? 0) as number,
    cache_read_input_tokens: (raw.prompt_cache_hit_tokens ?? raw.cache_read_input_tokens ?? 0) as number,
    cache_creation_input_tokens: (raw.prompt_cache_miss_tokens ?? raw.cache_creation_input_tokens ?? 0) as number,
  }
}

export interface DeepSeekClientConfig {
  apiKey: string
  model: string
  reasoningEffort?: string
  maxTokens?: number
}

/**
 * Generic factory: create an ApiClient for any provider described by a
 * ProviderCapabilities object.  This is the preferred entry-point when
 * adding new providers.
 */
export function createClient(
  config: DeepSeekClientConfig,
  capabilities: ProviderCapabilities,
): ApiClient {
  const clientConfig: ClientConfig = {
    baseUrl: 'https://api.deepseek.com/anthropic',
    apiKey: config.apiKey,
    model: config.model,
    maxTokens: config.maxTokens ?? 64000,
    thinking: capabilities.supportsThinking ? 'enabled' : 'disabled',
    reasoningEffort: capabilities.effortFormat === 'none' ? undefined : (config.reasoningEffort ?? 'high'),
    unsupported: capabilities.stripParams,
    mapUsage: capabilities.mapUsage,
  }

  return new ApiClient(clientConfig)
}

/**
 * Backward-compatible convenience wrapper that creates a client with
 * DeepSeek-specific capabilities.  Existing callers (e.g. main.tsx) can
 * continue using this without changes.
 */
export function createDeepSeekClient(config: DeepSeekClientConfig): ApiClient {
  return createClient(config, {
    ...DEEPSEEK_CAPABILITIES,
    mapUsage: mapDeepSeekUsage,
  })
}
