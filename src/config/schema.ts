import { z } from 'zod'
import { mcpConfigSchema, type McpConfig } from '../mcp/config.js'

export const modelConfigSchema = z.object({
  id: z.string(),
  alias: z.string().optional(),
  contextWindow: z.number().int().positive(),
  maxTokens: z.number().int().positive(),
  reasoningEffort: z.enum(['off', 'low', 'medium', 'high', 'max']).optional(),
})

export const providerSchema = z.object({
  name: z.string(),
  apiKey: z.string().optional(),
  apiKeyEnv: z.string().optional(),
  baseUrl: z.string().url(),
  models: z.array(modelConfigSchema).min(1),
  thinking: z.enum(['enabled', 'disabled']).default('enabled'),
  maxTokens: z.number().int().positive().default(64000),
  unsupported: z.array(z.string()).default([]),
})

export const permissionAllowRuleSchema = z.object({
  tool: z.string().min(1),
  params: z.record(z.string()).optional(),
})

export const permissionsSchema = z.object({
  allow: z.array(permissionAllowRuleSchema).default([]),
})

export const agentSchema = z.object({
  approval: z.enum(['auto-accept', 'auto-safe', 'suggest', 'manual']).default('auto-safe'),
  maxTurns: z.number().int().positive().default(50),
  mode: z.enum(['code', 'ask', 'plan']).default('code'),
  autoReasoning: z.boolean().default(false),
  permissions: permissionsSchema.default({}),
})

export const compactSchema = z.object({
  enabled: z.boolean().default(true),
  autoThreshold: z.number().int().positive().default(800_000),
  autoFloor: z.number().int().positive().default(500_000),
  model: z.string().default('deepseek-v4-flash'),
})

export const cacheSchema = z.object({
  enabled: z.boolean().default(true),
  minSystemTokens: z.number().int().positive().default(256),
  showHitRate: z.boolean().default(true),
})

export const configSchema = z.object({
  provider: z.object({
    default: z.string(),
    providers: z.record(z.string(), providerSchema),
  }),
  agent: agentSchema.default({}),
  compact: compactSchema.default({}),
  cache: cacheSchema.default({}),
  mcp: mcpConfigSchema.default({}),
})

export type Config = {
  provider: { default: string; providers: Record<string, ProviderConfig> }
  agent: AgentConfig
  compact: CompactConfig
  cache: CacheConfig
  mcp: McpConfig
}

export type ProviderConfig = z.infer<typeof providerSchema>
export type ModelConfig = z.infer<typeof modelConfigSchema>
export type AgentConfig = z.infer<typeof agentSchema>
export type CompactConfig = z.infer<typeof compactSchema>
export type CacheConfig = z.infer<typeof cacheSchema>
