import { ApiClient, type ClientConfig } from './client.js'
import { OpenAIClient } from './openai-client.js'
import { CodexClient } from './codex-client.js'
import type { StreamClient } from './stream-client.js'
import type { ProviderCapabilities } from './provider.js'
import type { ProviderConfig } from '../config/schema.js'
import type { AuthProvider } from '../auth/types.js'

/** Runtime parameters that vary per-model or per-call, not stored in config */
export interface RuntimeParams {
  apiKey: string
  model: string
  maxTokens: number
  reasoningEffort?: string
  thinkingBudget?: number
  auth?: AuthProvider
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
): StreamClient {
  // Codex OAuth uses the Responses API, not chat/completions
  if (provider.name === 'codex' && provider.auth?.type === 'oauth') {
    return new CodexClient({
      baseUrl: provider.baseUrl,
      model: params.model,
      maxTokens: params.maxTokens,
      auth: params.auth,
    })
  }

  if (provider.protocol === 'openai') {
    return new OpenAIClient({
      baseUrl: provider.baseUrl,
      apiKey: params.apiKey,
      model: params.model,
      maxTokens: params.maxTokens,
      auth: params.auth,
    })
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
