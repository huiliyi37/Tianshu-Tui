import type { ProviderConfig } from './schema.js'

export type ProviderPresetKey = 'deepseek' | 'glm' | 'mimo' | 'minimax' | 'codex'

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
        },
        {
          id: 'deepseek-v4-flash',
          alias: 'v4-flash',
          contextWindow: 1_000_000,
          maxTokens: 384_000,
          reasoningEffort: 'high',
        },
      ],
      unsupported: [],
    },
  },
  glm: {
    key: 'glm',
    label: 'GLM',
    defaultModelId: 'glm-5.1',
    provider: {
      name: 'glm',
      apiKeyEnv: 'ZHIPU_API_KEY',
      baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4',
      protocol: 'openai',
      capabilities: {
        cacheControl: false,
        stripParams: [],
        toolJsonBug: false,
        prefixCache: 'none',
        prefixCompletion: false,
      },
      thinking: 'enabled',
      maxTokens: 131072,
      models: [
        {
          id: 'glm-5.1',
          alias: 'glm',
          contextWindow: 200_000,
          maxTokens: 131072,
          reasoningEffort: 'high',
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
      baseUrl: 'https://token-plan-sgp.xiaomimimo.com/v1',
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
        },
        {
          id: 'mimo-v2.5',
          alias: 'mimo',
          contextWindow: 1_000_000,
          maxTokens: 128000,
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
