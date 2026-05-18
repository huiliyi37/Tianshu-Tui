import type { Config } from './schema.js'

export const DEFAULT_CONFIG: Config = {
  editor: {
    vim: false,
  },
  provider: {
    default: 'deepseek',
    providers: {
      deepseek: {
        name: 'deepseek',
        apiKeyEnv: 'DEEPSEEK_API_KEY',
        baseUrl: 'https://api.deepseek.com/v1',
        protocol: 'openai' as const,
        capabilities: {
          cacheControl: false,
          stripParams: [],
          toolJsonBug: true,
          prefixCache: 'deepseek-native' as const,
        },
        thinking: 'enabled',
        maxTokens: 64000,
        models: [
          {
            id: 'deepseek-v4-pro',
            alias: 'v4-pro',
            contextWindow: 1_000_000,
            maxTokens: 163_000,
            reasoningEffort: 'max',
          },
          {
            id: 'deepseek-v4-flash',
            alias: 'v4-flash',
            contextWindow: 1_000_000,
            maxTokens: 163_000,
            reasoningEffort: 'high',
          },
        ],
        unsupported: [],
      },
      kimi: {
        name: 'kimi',
        apiKeyEnv: 'KIMI_API_KEY',
        baseUrl: 'https://api.kimi.com/coding/v1',
        protocol: 'anthropic' as const,
        capabilities: {
          cacheControl: false,
          stripParams: [],
          toolJsonBug: false,
          prefixCache: 'none' as const,
        },
        thinking: 'enabled',
        maxTokens: 64000,
        models: [
          {
            id: 'kimi-for-coding',
            alias: 'kimi',
            contextWindow: 200_000,
            maxTokens: 64000,
            reasoningEffort: 'high',
          },
        ],
        unsupported: [],
      },
      glm: {
        name: 'glm',
        apiKeyEnv: 'ZHIPU_API_KEY',
        baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4',
        protocol: 'openai' as const,
        capabilities: {
          cacheControl: false,
          stripParams: [],
          toolJsonBug: false,
          prefixCache: 'none' as const,
        },
        thinking: 'enabled',
        maxTokens: 128000,
        models: [
          {
            id: 'glm-5.1',
            alias: 'glm',
            contextWindow: 200_000,
            maxTokens: 128000,
            reasoningEffort: 'high',
          },
        ],
        unsupported: ['stream_options'],
      },
    },
  },
  agent: {
    approval: 'suggest',
    maxTurns: 50,
    mode: 'code',
    autoReasoning: false,
    permissions: {
      allow: [],
    },
  },
  compact: {
    enabled: true,
    autoThreshold: 800_000,
    autoFloor: 500_000,
    model: 'deepseek-v4-flash',
  },
  cache: {
    enabled: true,
    minSystemTokens: 256,
    showHitRate: true,
  },
  mcp: {
    enabled: true,
    servers: {},
  },
  workers: {
    profiles: {
      cheap: { provider: 'deepseek', model: 'deepseek-v4-flash' },
      capable: { provider: 'deepseek', model: 'deepseek-v4-pro' },
    },
    routing: {
      repo_summarization: 'cheap',
      code_edit: 'capable',
      test_failure_diagnosis: 'capable',
      risky_refactor: 'capable',
    },
  },
}
