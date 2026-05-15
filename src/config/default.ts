import type { Config } from './schema.js'

export const DEFAULT_CONFIG: Config = {
  provider: {
    default: 'deepseek',
    providers: {
      deepseek: {
        name: 'deepseek',
        apiKeyEnv: 'DEEPSEEK_API_KEY',
        baseUrl: 'https://api.deepseek.com/anthropic',
        thinking: 'enabled',
        maxTokens: 64000,
        models: [
          {
            id: 'deepseek-v4-pro',
            alias: 'v4-pro',
            contextWindow: 1_000_000,
            maxTokens: 64000,
            reasoningEffort: 'max',
          },
          {
            id: 'deepseek-v4-flash',
            alias: 'v4-flash',
            contextWindow: 1_000_000,
            maxTokens: 64000,
            reasoningEffort: 'high',
          },
        ],
        unsupported: [],
      },
    },
  },
  agent: {
    approval: 'suggest',
    maxTurns: 50,
    mode: 'code',
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
}
