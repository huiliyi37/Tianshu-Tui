import type { ModelConfig, ProviderConfig } from './schema.js'

export type ProviderPresetKey = 'deepseek' | 'glm' | 'mimo' | 'mimo-api' | 'minimax' | 'codex' | 'siliconflow' | 'longcat'

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
      // 官方 API(api.deepseek.com/zh-cn/quick_start/pricing):
      // 上下文 100 万,单次输出上限 38.4 万。2026-07-01 误改为 6.4 万(V3 旧值),
      // 导致 reasoning_effort=max 时推理未完即被 length 截断、loop 收到空响应判死停止。
      maxTokens: 384_000,
      models: [
        {
          id: 'deepseek-v4-pro',
          alias: 'v4-pro',
          contextWindow: 1_000_000,
          maxTokens: 384_000,
          reasoningEffort: 'max',
          tier: 'strong',
          pricing: { input: 3, output: 6, cacheRead: 0.025, cacheWrite: 3 },
        },
        {
          id: 'deepseek-v4-flash',
          alias: 'v4-flash',
          contextWindow: 1_000_000,
          maxTokens: 384_000,
          reasoningEffort: 'high',
          tier: 'cheap',
          pricing: { input: 1, output: 2, cacheRead: 0.02, cacheWrite: 1 },
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
          tier: 'strong',
          // GLM 视觉系模型：接受 image_url 多模态输入（computer_use 截图回灌）。
          supportsVision: true,
          // GLM Coding Plan 是月度定额订阅,不按 token 计费 —— 单价清零,
          // 避免界面显示误导性的"花费金额"(用量/缓存命中率等真实指标不受影响)。
          pricing: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
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
          tier: 'strong',
          pricing: { input: 0.8, output: 3.2, cacheRead: 0.08, cacheWrite: 0.8 },
        },
        {
          id: 'mimo-v2.5',
          alias: 'mimo',
          contextWindow: 1_000_000,
          maxTokens: 128000,
          tier: 'cheap',
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
          tier: 'strong',
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
          tier: 'balanced',
          pricing: { input: 0.3, output: 1.2, cacheRead: 0.03, cacheWrite: 0.3 },
        },
        {
          id: 'MiniMax-M3',
          alias: 'minimax-m3',
          contextWindow: 1_000_000,
          maxTokens: 64000,
          tier: 'strong',
          supportsVision: true,
          pricing: { input: 0.3, output: 1.2, cacheRead: 0.03, cacheWrite: 0.3 },
        },
      ],
      unsupported: [],
    },
  },
  siliconflow: {
    key: 'siliconflow',
    label: '硅基流动 (SiliconFlow)',
    defaultModelId: 'deepseek-ai/DeepSeek-V4-Pro',
    provider: {
      name: 'siliconflow',
      apiKeyEnv: 'SILICONFLOW_API_KEY',
      baseUrl: 'https://api.siliconflow.cn/v1',
      protocol: 'openai',
      capabilities: {
        cacheControl: false,
        stripParams: [],
        // 默认模型是 SiliconFlow 代理的 DeepSeek —— 沿用其"工具 JSON 混进正文"的
        // 模型固有 bug 处理;换到聚合站里的其他模型时该开关无害(仅在检测到正文
        // 内 tool JSON 时才生效)。
        toolJsonBug: true,
        // SiliconFlow 对 DeepSeek-V4 / GLM-5.2 计"Cached Input"价 → 存在服务端隐式
        // 前缀缓存,按 deepseek-native 记账以保住前缀缓存优化;但前缀补全(beta 续写
        // 端点)是 deepseek.com 专属,聚合网关没有 → 关。
        prefixCache: 'deepseek-native',
        prefixCompletion: false,
      },
      thinking: 'enabled',
      maxTokens: 384_000,
      models: [
        {
          id: 'deepseek-ai/DeepSeek-V4-Pro',
          alias: 'sf-v4-pro',
          contextWindow: 1_000_000,
          maxTokens: 384_000,
          reasoningEffort: 'max',
          tier: 'strong',
          pricing: { input: 1.6, output: 3.135, cacheRead: 0.135 },
        },
        {
          id: 'deepseek-ai/DeepSeek-V4-Flash',
          alias: 'sf-v4-flash',
          contextWindow: 1_000_000,
          maxTokens: 384_000,
          reasoningEffort: 'high',
          tier: 'cheap',
          pricing: { input: 0.13, output: 0.28 },
        },
        {
          id: 'zai-org/GLM-5.2',
          alias: 'sf-glm',
          contextWindow: 1_000_000,
          maxTokens: 131_072,
          reasoningEffort: 'max',
          tier: 'strong',
          supportsVision: true,
          pricing: { input: 1.4, output: 4.4 },
        },
        {
          id: 'moonshotai/Kimi-K2.7-Code',
          alias: 'sf-kimi',
          contextWindow: 262_144,
          maxTokens: 131_072,
          tier: 'strong',
          pricing: { input: 0.94, output: 4.0 },
        },
        {
          id: 'Qwen/Qwen3.6-27B',
          alias: 'sf-qwen',
          contextWindow: 262_144,
          maxTokens: 131_072,
          tier: 'balanced',
          pricing: { input: 0.3, output: 3.2 },
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
          tier: 'strong',
          supportsVision: true,
          pricing: { input: 1.0, output: 4.0, cacheRead: 0.5, cacheWrite: 1.0 },
        },
      ],
      unsupported: [],
    },
  },
  longcat: {
    key: 'longcat',
    label: 'LongCat (美团龙猫)',
    defaultModelId: 'LongCat-2.0',
    provider: {
      name: 'longcat',
      apiKeyEnv: 'LONGCAT_API_KEY',
      baseUrl: 'https://api.longcat.chat/openai/v1',
      protocol: 'openai',
      capabilities: {
        cacheControl: false,
        stripParams: [],
        toolJsonBug: false,
        // LongCat cache 命中免费（官方政策），存在服务端隐式前缀缓存
        prefixCache: 'deepseek-native',
        prefixCompletion: false,
      },
      thinking: 'enabled',
      maxTokens: 131072,
      models: [
        {
          id: 'LongCat-2.0',
          alias: 'longcat',
          contextWindow: 1_000_000,
          maxTokens: 131072,
          tier: 'strong',
          // 官方定价 $0.75/$2.95 per M tokens (≈ ¥5/¥20)，cache read 免费
          pricing: { input: 0.75, output: 2.95, cacheRead: 0, cacheWrite: 0.75 },
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
