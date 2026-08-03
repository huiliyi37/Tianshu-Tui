import type { ModelConfig, ProviderConfig } from './schema.js'

export type ProviderPresetKey = 'deepseek' | 'glm' | 'mimo' | 'mimo-api' | 'minimax' | 'codex' | 'siliconflow' | 'longcat' | 'ccswitch' | 'zhipu-vision'

export interface ProviderPreset {
  key: ProviderPresetKey
  label: string
  description: string
  provider: ProviderConfig
  defaultModelId: string
}

export const PROVIDER_PRESETS: Record<ProviderPresetKey, ProviderPreset> = {
  deepseek: {
    key: 'deepseek',
    label: 'DeepSeek',
    description: '官方旗舰：1M 上下文 + 深度推理，适合重活主控',
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
          description: '旗舰推理档，1M 上下文',
          alias: 'v4-pro',
          contextWindow: 1_000_000,
          maxTokens: 384_000,
          // Cost default: high (not max). Routine turns can step down further via
          // effort routing; users who need max can set it in config / Settings.
          reasoningEffort: 'high',
          tier: 'strong',
          pricing: { input: 3, output: 6, cacheRead: 0.025, cacheWrite: 3 },
        },
        {
          id: 'deepseek-v4-flash',
          description: '快速档：能力对标旗舰，成本更低',
          alias: 'v4-flash',
          contextWindow: 1_000_000,
          maxTokens: 384_000,
          reasoningEffort: 'medium',
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
    description: '智谱 Coding 订阅：1M 上下文 + 视觉支持',
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
          description: '1M 上下文，视觉支持',
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
    description: '小米 MiMo：1M 上下文，性价比推理',
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
          description: 'MiMo 旗舰推理档',
          alias: 'mimo-pro',
          contextWindow: 1_000_000,
          maxTokens: 128000,
          tier: 'strong',
          pricing: { input: 0.8, output: 3.2, cacheRead: 0.08, cacheWrite: 0.8 },
        },
        {
          id: 'mimo-v2.5',
          description: 'MiMo 轻量廉价档',
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
    description: '小米 MiMo 按量 API，超速档',
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
          description: 'MiMo 超速档',
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
    description: 'MiniMax：多档模型，旗舰带视觉',
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
          description: 'MiniMax 均衡档',
          alias: 'minimax',
          contextWindow: 204_800,
          maxTokens: 64000,
          tier: 'balanced',
          pricing: { input: 0.3, output: 1.2, cacheRead: 0.03, cacheWrite: 0.3 },
        },
        {
          id: 'MiniMax-M3',
          description: 'MiniMax 旗舰，视觉支持',
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
    description: '聚合站：多模型可选，含 DeepSeek/GLM/Kimi/Qwen',
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
          description: 'DeepSeek 旗舰推理（聚合）',
          alias: 'sf-v4-pro',
          contextWindow: 1_000_000,
          maxTokens: 384_000,
          reasoningEffort: 'high',
          tier: 'strong',
          pricing: { input: 1.6, output: 3.135, cacheRead: 0.135 },
        },
        {
          id: 'deepseek-ai/DeepSeek-V4-Flash',
          description: 'DeepSeek 快档（聚合）',
          alias: 'sf-v4-flash',
          contextWindow: 1_000_000,
          maxTokens: 384_000,
          reasoningEffort: 'medium',
          tier: 'cheap',
          pricing: { input: 0.13, output: 0.28 },
        },
        {
          id: 'zai-org/GLM-5.2',
          description: 'GLM 旗舰，视觉支持（聚合）',
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
          description: 'Kimi 编码模型（聚合）',
          alias: 'sf-kimi',
          contextWindow: 262_144,
          maxTokens: 131_072,
          tier: 'strong',
          pricing: { input: 0.94, output: 4.0 },
        },
        {
          id: 'Qwen/Qwen3.6-27B',
          description: '通义 Qwen 均衡档（聚合）',
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
    description: 'OpenAI Codex：OAuth 登录，旗舰推理',
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
          description: 'OpenAI 旗舰，视觉支持',
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
    description: '美团龙猫：1M 上下文，缓存读取免费',
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
          description: '龙猫旗舰，缓存读取免费',
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
  ccswitch: {
    key: 'ccswitch',
    label: 'CC Switch',
    description: 'cc-switch 本地代理：Claude/GPT/DeepSeek 等',
    defaultModelId: 'claude-opus-4-8',
    provider: {
      name: 'ccswitch',
      apiKeyEnv: 'CC_SWITCH_PROXY_API_KEY',
      baseUrl: process.env.CC_SWITCH_PROXY_URL ?? 'http://127.0.0.1:8891/v1',
      protocol: 'openai',
      capabilities: {
        cacheControl: false,
        stripParams: ['top_k', 'metadata', 'service_tier', 'cache_control'],
        toolJsonBug: false,
        prefixCache: 'none',
        prefixCompletion: false,
      },
      // cc-switch 入口层透传 reasoning_effort，Rectifier 翻译为上游原生格式
      thinking: 'enabled',
      maxTokens: 128000,
      models: [
        {
          id: 'claude-opus-4-8',
          description: 'Claude 最强推理',
          alias: 'cc-opus',
          contextWindow: 1_000_000,
          maxTokens: 128000,
          reasoningEffort: 'max',
          tier: 'strong',
        },
        {
          id: 'claude-sonnet-4-5',
          description: 'Claude 均衡档',
          alias: 'cc-sonnet',
          contextWindow: 1_000_000,
          maxTokens: 128000,
          reasoningEffort: 'high',
          tier: 'strong',
        },
        {
          id: 'deepseek-v4-pro',
          description: 'DeepSeek 旗舰（代理）',
          alias: 'cc-dsv4',
          contextWindow: 1_000_000,
          maxTokens: 384_000,
          reasoningEffort: 'high',
          tier: 'strong',
        },
        {
          id: 'glm-5.2',
          description: 'GLM 旗舰，视觉支持（代理）',
          alias: 'cc-glm',
          contextWindow: 1_000_000,
          maxTokens: 131_072,
          reasoningEffort: 'max',
          tier: 'strong',
          supportsVision: true,
        },
        {
          id: 'gpt-5.6',
          description: 'GPT 最新旗舰',
          alias: 'cc-gpt56',
          contextWindow: 200_000,
          maxTokens: 128_000,
          reasoningEffort: 'max',
          tier: 'strong',
        },
        {
          id: 'gpt-5.5',
          description: 'GPT 旗舰',
          alias: 'cc-gpt55',
          contextWindow: 200_000,
          maxTokens: 128_000,
          reasoningEffort: 'high',
          tier: 'strong',
        },
      ],
      unsupported: [],
    },
  },
  // 智谱免费视觉模型 — 走通用 PaaS 端点（非 coding 套餐端点）。
  // glm-4v-flash 是智谱首个完全免费的图像理解模型，API 调用免费、不限期。
  // 与 glm provider 复用同一个 ZHIPU_API_KEY，但端点不同：
  //   coding 套餐 → api/coding/paas/v4（glm provider 用，按订阅计费）
  //   通用 PaaS  → api/paas/v4（本 provider 用，glm-4v-flash 在此免费）
  // 上下文 8K / 最大输出 1K —— 只适合做识图桥（描述图片），不适合当主控。
  'zhipu-vision': {
    key: 'zhipu-vision',
    label: '智谱视觉 (GLM-4V-Flash 免费)',
    description: '智谱免费视觉桥：只适合识图，不适合主控',
    defaultModelId: 'glm-4v-flash',
    provider: {
      name: 'zhipu-vision',
      apiKeyEnv: 'ZHIPU_API_KEY',
      baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
      protocol: 'openai',
      capabilities: {
        cacheControl: false,
        stripParams: [],
        toolJsonBug: false,
        prefixCache: 'none',
        prefixCompletion: false,
      },
      thinking: 'disabled',
      maxTokens: 1024,
      models: [
        {
          id: 'glm-4v-flash',
          description: '免费识图桥（8K 上下文）',
          alias: 'glm-4v-flash',
          contextWindow: 8192,
          maxTokens: 1024,
          tier: 'cheap',
          supportsVision: true,
          pricing: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, free: true },
        },
      ],
      unsupported: ['stream_options'],
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
