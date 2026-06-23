import { OpenAIClient } from './openai-client.js'
import { CodexClient } from './codex-client.js'
import { AnthropicClient } from './anthropic-client.js'
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

/** SLOW_THINKING providers 的 thinking-stall 默认值（ms）。
 *  仅对已知易在纯 thinking 阶段卡死的 provider 启用；
 *  其余 provider 默认 undefined（沿用既有行为：取 readMs，等于禁用）。
 *  取值依据：基于「chunk 空闲窗」而非「总时长」的语义——120s 远小于 300s read 兜底、
 *  远大于合法 reasoning delta 间隙，仅命中 reasoning 完全停流的真卡死。 */
const SLOW_THINKING_STALL_DEFAULT_MS: Record<string, number> = {
  glm: 210_000,
}

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

  // Anthropic native protocol — uses explicit cache_control breakpoints.
  // Protocol is determined by provider config, NOT by model name.
  // Example: Qwen via OpenCode Go uses Anthropic /v1/messages, but direct
  // Qwen API (dashscope) is OpenAI-compatible. The provider config knows which.
  if (provider.name === 'anthropic' || capabilities.prefixCacheStrategy === 'anthropic-cache-control') {
    const budgetMap: Record<string, number> = {
      max: params.maxTokens,
      high: Math.floor(params.maxTokens * 0.6),
      medium: Math.floor(params.maxTokens * 0.3),
      low: 8192,
    }
    const thinkingBudget = params.reasoningEffort
      ? (budgetMap[params.reasoningEffort] ?? Math.floor(params.maxTokens * 0.6))
      : undefined

    return new AnthropicClient({
      baseUrl: provider.baseUrl,
      apiKey: params.apiKey,
      model: params.model,
      maxTokens: params.maxTokens,
      thinkingBudget,
    })
  }

  return new OpenAIClient({
    baseUrl: provider.baseUrl,
    apiKey: params.apiKey,
    model: params.model,
    maxTokens: params.maxTokens,
    auth: params.auth,
    thinking: provider.thinking as 'enabled' | 'disabled' | undefined,
    thinkingStallTimeoutMs: provider.thinkingStallTimeoutMs ?? SLOW_THINKING_STALL_DEFAULT_MS[provider.name],
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
    useMaxCompletionTokens: provider.name === 'mimo' || provider.name === 'mimo-api' || provider.name === 'minimax',
    userAgent: provider.name === 'kimi' ? 'KimiCLI/1.0' : undefined,
    usageCalibrationFactor: provider.usageCalibrationFactor,
    capabilities: { hasToolJsonInContentBug: capabilities.hasToolJsonInContentBug },
  })
}

function modelContextWindow(provider: ProviderConfig, modelId: string): number {
  // Fall back to the provider's first configured model rather than a fixed
  // small constant: schema requires contextWindow on every model, so the
  // 128K terminal fallback only applies to a provider with zero models.
  return (
    provider.models.find(model => model.id === modelId || model.alias === modelId)?.contextWindow
    ?? provider.models[0]?.contextWindow
    ?? 128_000
  )
}
