import { ApiClient, type ClientConfig } from './client.js'
import type { Usage } from './types.js'

export function mapDeepSeekUsage(raw: Record<string, unknown>): Usage {
  return {
    // Support both DeepSeek native format and Anthropic compatibility format
    input_tokens: (raw.prompt_tokens ?? raw.input_tokens ?? 0) as number,
    output_tokens: (raw.completion_tokens ?? raw.output_tokens ?? 0) as number,
    cache_read_input_tokens: (raw.prompt_cache_hit_tokens ?? raw.cache_read_input_tokens ?? 0) as number,
    cache_creation_input_tokens: (raw.prompt_cache_miss_tokens ?? raw.cache_creation_input_tokens ?? 0) as number,
  }
}

const DEEPSEEK_UNSUPPORTED = [
  'computer_use',
  'prompt_caching_budget_tokens',
]

export interface DeepSeekClientConfig {
  apiKey: string
  model: string
  reasoningEffort?: string
  maxTokens?: number
}

export function createDeepSeekClient(config: DeepSeekClientConfig): ApiClient {
  const clientConfig: ClientConfig = {
    baseUrl: 'https://api.deepseek.com/anthropic',
    apiKey: config.apiKey,
    model: config.model,
    maxTokens: config.maxTokens ?? 64000,
    thinking: 'enabled',
    reasoningEffort: config.reasoningEffort ?? 'high',
    unsupported: DEEPSEEK_UNSUPPORTED,
    mapUsage: mapDeepSeekUsage,
  }

  return new ApiClient(clientConfig)
}
