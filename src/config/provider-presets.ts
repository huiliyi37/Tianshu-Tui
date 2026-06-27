import type { ModelConfig, ProviderConfig } from './schema.js'

export type ProviderPresetKey = 'deepseek' | 'glm' | 'mimo' | 'mimo-api' | 'minimax' | 'codex'

export interface ProviderPreset {
  key: ProviderPresetKey
  label: string
  provider: ProviderConfig
  defaultModelId: string
}

export const PROVIDER_PRESETS: Record<ProviderPresetKey, ProviderPreset> = {
  deepseek: {
    key: 'deepseek',
    label: 'DeepSeek',
    defaultModelId: 'deepseek-v4-pro',
    provider: {
      name: 'deepseek',
      apiKeyEnv: 'DEEPSEEK_API_KEY',
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
      maxTokens: 384_000,
      models: [
        {
          id: 'deepseek-v4-pro',
          alias: 'v4-pro',
          contextWindow: 1_000_000,
          maxTokens: 384_000,
          reasoningEffort: 'max',
          pricing: { input: 0.5, output: 2.0, cacheRead: 0.05, cacheWrite: 0.5 },
        },
        {
          id: 'deepseek-v4-flash',
          alias: 'v4-flash',
          contextWindow: 1_000_000,
          maxTokens: 384_000,
          reasoningEffort: 'high',
          pricing: { input: 0.1, output: 0.4, cacheRead: 0.01, cacheWrite: 0.1 },
        },
      ],
      unsupported: [],
    },
  },
  glm: {
    key: 'glm',
    label: 'GLM',
    defaultModelId: 'glm-5.2',
    provider: {
      name: 'glm',
      apiKeyEnv: 'ZHIPU_API_KEY',
      baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4',
      protocol: 'openai',
      capabilities: {
        cacheControl: false,
        stripParams: [],
        toolJsonBug: false,
        // GLM-5.2 implicit exact-prefix cache (隐式缓存) — keeps the stable prefix
        // cache-warm so compaction stops re-prefilling the full 1M-window prompt.
        prefixCache: 'deepseek-native',
        prefixCompletion: false,
      },
      thinking: 'enabled',
      maxTokens: 131072,
      // Keep 0: GLM coding API inflates prompt_tokens; calibrateUsage scales
      // cache_read proportionally so the cache hit-ratio is preserved.
      usageCalibrationFactor: 0,
      models: [
        {
          id: 'glm-5.2',
          alias: 'glm',
          contextWindow: 1_000_000,
          maxTokens: 131072,
          reasoningEffort: 'max',
          pricing: { input: 0.5, output: 4.0, cacheRead: 0.05, cacheWrite: 0.5 },
        },
      ],
      unsupported: ['stream_options'],
    },
  },
  mimo: {
    key: 'mimo',
    label: 'MiMo',
    defaultModelId: 'mimo-v2.5-pro',
    provider: {
      name: 'mimo',
      apiKeyEnv: 'MIMO_API_KEY',
      baseUrl: 'https://token-plan-cn.xiaomimimo.com/v1',
      protocol: 'openai',
      capabilities: {
        cacheControl: false,
        stripParams: [],
        toolJsonBug: false,
        prefixCache: 'deepseek-native',
        prefixCompletion: false,
      },
      thinking: 'enabled',
      maxTokens: 128000,
      models: [
        {
          id: 'mimo-v2.5-pro',
          alias: 'mimo-pro',
          contextWindow: 1_000_000,
          maxTokens: 128000,
          pricing: { input: 0.8, output: 3.2, cacheRead: 0.08, cacheWrite: 0.8 },
        },
        {
          id: 'mimo-v2.5',
          alias: 'mimo',
          contextWindow: 1_000_000,
          maxTokens: 128000,
          pricing: { input: 0.2, output: 0.8, cacheRead: 0.02, cacheWrite: 0.2 },
        },
      ],
      unsupported: ['stream_options'],
    },
  },
  'mimo-api': {
    key: 'mimo-api',
    label: 'MiMo API (新)',
    defaultModelId: 'mimo-v2.5-pro-ultraspeed',
    provider: {
      name: 'mimo-api',
      apiKeyEnv: 'MIMO_PAY_API_KEY',
      baseUrl: 'https://api.xiaomimimo.com/v1',
      protocol: 'openai',
      capabilities: {
        cacheControl: false,
        stripParams: [],
        toolJsonBug: false,
        prefixCache: 'deepseek-native',
        prefixCompletion: false,
      },
      thinking: 'enabled',
      maxTokens: 128000,
      models: [
        {
          id: 'mimo-v2.5-pro-ultraspeed',
          alias: 'mimo-ultra',
          contextWindow: 1_000_000,
          maxTokens: 128000,
          pricing: { input: 0.8, output: 3.2, cacheRead: 0.08, cacheWrite: 0.8 },
        },
      ],
      unsupported: ['stream_options'],
    },
  },
  minimax: {
    key: 'minimax',
    label: 'MiniMax',
    defaultModelId: 'MiniMax-M2.7',
    provider: {
      name: 'minimax',
      apiKeyEnv: 'MINIMAX_API_KEY',
      baseUrl: 'https://api.minimaxi.com/v1',
      protocol: 'openai',
      capabilities: {
        cacheControl: false,
        stripParams: ['top_k', 'metadata', 'service_tier', 'cache_control'],
        toolJsonBug: false,
        prefixCache: 'deepseek-native',
        prefixCompletion: false,
      },
      thinking: 'enabled',
      maxTokens: 64000,
      models: [
        {
          id: 'MiniMax-M2.7',
          alias: 'minimax',
          contextWindow: 204_800,
          maxTokens: 64000,
          pricing: { input: 0.3, output: 1.2, cacheRead: 0.03, cacheWrite: 0.3 },
        },
      ],
      unsupported: [],
    },
  },
  codex: {
    key: 'codex',
    label: 'Codex',
    defaultModelId: 'gpt-5.5',
    provider: {
      name: 'codex',
      baseUrl: 'https://chatgpt.com/backend-api/codex',
      protocol: 'openai',
      auth: { type: 'oauth', provider: 'codex' },
      capabilities: {
        cacheControl: true,
        stripParams: [],
        toolJsonBug: false,
        prefixCache: 'none',
        prefixCompletion: false,
      },
      thinking: 'enabled',
      maxTokens: 128000,
      models: [
        {
          id: 'gpt-5.5',
          alias: 'codex',
          contextWindow: 1_000_000,
          maxTokens: 128000,
          reasoningEffort: 'max',
          pricing: { input: 1.0, output: 4.0, cacheRead: 0.5, cacheWrite: 1.0 },
        },
      ],
      unsupported: [],
    },
  },
}

export const providerPresetKeys = Object.keys(PROVIDER_PRESETS) as ProviderPresetKey[]

export function cloneProviderPreset(key: ProviderPresetKey): ProviderConfig {
  return structuredClone(PROVIDER_PRESETS[key].provider)
}

export function isProviderPresetKey(value: string): value is ProviderPresetKey {
  return Object.prototype.hasOwnProperty.call(PROVIDER_PRESETS, value)
}

/**
 * Look up a preset model's defaults by provider name and model id/alias.
 *
 * Used by CLI setup paths so that known models (e.g. deepseek-v4-pro)
 * inherit their real context window instead of a silent 128K default —
 * a wrong small window causes premature compaction tiers on 1M models.
 */
export function findPresetModel(providerName: string, modelId: string): ModelConfig | undefined {
  if (!isProviderPresetKey(providerName)) return undefined
  return PROVIDER_PRESETS[providerName].provider.models.find(
    m => m.id === modelId || m.alias === modelId,
  )
}
