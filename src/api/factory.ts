import { OpenAIClient } from './openai-client.js'
import { CodexClient } from './codex-client.js'
import type { StreamClient } from './stream-client.js'
import type { ProviderCapabilities } from './provider.js'
import { getProviderProfile } from './provider-profile.js'
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
  /** Stable session identifier for cache routing affinity */
  sessionId?: string
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
 * All providers use OpenAI Chat Completions format.
 * Codex OAuth is the sole exception (uses the Responses API).
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

  return new OpenAIClient({
    baseUrl: provider.baseUrl,
    apiKey: params.apiKey,
    model: params.model,
    maxTokens: params.maxTokens,
    auth: params.auth,
    thinking: provider.thinking as 'enabled' | 'disabled' | undefined,
    thinkingFormat: capabilities.thinkingFormat,
    effortFormat: capabilities.effortFormat,
    reasoningEffort: params.reasoningEffort,
    sessionId: params.sessionId,
    providerName: provider.name,
    providerProfile: getProviderProfile(provider.name, modelContextWindow(provider, params.model)),
    unsupported: provider.unsupported.length > 0
      ? provider.unsupported
      : capabilities.stripParams,
    prefixCompletion: provider.capabilities.prefixCompletion,
    useMaxCompletionTokens: provider.name === 'mimo',
  })
}

function modelContextWindow(provider: ProviderConfig, modelId: string): number | undefined {
  return provider.models.find(model => model.id === modelId || model.alias === modelId)?.contextWindow
}
