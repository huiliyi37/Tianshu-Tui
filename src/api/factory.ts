import { ApiClient, type ClientConfig } from './client.js'
import type { ProviderCapabilities } from './provider.js'
import type { ProviderConfig } from '../config/schema.js'

/** Runtime parameters that vary per-model or per-call, not stored in config */
export interface RuntimeParams {
  apiKey: string
  model: string
  maxTokens: number
  reasoningEffort?: string
  thinkingBudget?: number
}

/**
 * Resolve the API key from config, falling back to environment variable.
 */
export function resolveApiKey(provider: ProviderConfig): string {
  if (provider.apiKey) return provider.apiKey
  if (provider.apiKeyEnv) {
    const env = process.env[provider.apiKeyEnv]
    if (env) return env
  }
  throw new Error(
    `No API key configured for provider "${provider.name}". ` +
    `Set apiKey in config or the ${provider.apiKeyEnv ?? 'API key'} environment variable.`
  )
}

/**
 * Create a streaming API client for the given provider.
 *
 * Delegates to the canonical StreamClient interface — all consumers
 * (TUI, agent loop, tool pipeline) are unaffected.
 */
export function createProviderClient(
  provider: ProviderConfig,
  capabilities: ProviderCapabilities,
  params: RuntimeParams,
): ApiClient {
  // Phase 2: OpenAI protocol will use OpenAIClient
  if (provider.protocol === 'openai') {
    throw new Error(
      `Provider "${provider.name}" uses OpenAI protocol which is not yet supported. ` +
      `OpenAI client is planned for Phase 2. Use protocol: 'anthropic'.`
    )
  }

  const clientConfig: ClientConfig = {
    baseUrl: provider.baseUrl,
    apiKey: params.apiKey,
    model: params.model,
    maxTokens: params.maxTokens,
    thinking: provider.thinking,
    thinkingBudget: params.thinkingBudget,
    reasoningEffort: capabilities.effortFormat === 'none'
      ? undefined
      : (params.reasoningEffort ?? 'high'),
    // Empty default [] is truthy, so ?? would never fallback.  Use explicit
    // length check: only trust provider.unsupported when the user actually
    // set it; otherwise defer to the well-known defaults.
    unsupported: provider.unsupported.length > 0
      ? provider.unsupported
      : capabilities.stripParams,
    hasToolJsonInContentBug: capabilities.hasToolJsonInContentBug,
    mapUsage: capabilities.mapUsage,
  }

  return new ApiClient(clientConfig)
}
