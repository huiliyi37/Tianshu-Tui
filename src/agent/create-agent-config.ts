import { createProviderClient } from '../api/factory.js'
import { resolveCapabilities } from '../api/provider.js'
import { PromptEngine } from '../prompt/engine.js'
import { createVolatileSnapshot } from '../prompt/volatile-snapshot.js'
import type { AgentConfig } from './loop.js'
import type { CompactionConfig } from '../compact/constants.js'
import type { ToolDefinition } from '../api/types.js'
import type { ProviderConfig } from '../config/schema.js'
import type { AuthProvider } from '../auth/types.js'
import { getProviderProfile } from '../api/provider-profile.js'

export interface ModelSpec {
  id: string
  maxTokens: number
  contextWindow: number
  reasoningEffort?: 'off' | 'low' | 'medium' | 'high' | 'max'
}

export interface AgentConfigInput {
  apiKey: string
  model: ModelSpec
  cwd: string
  compact: CompactionConfig
  sessionId: string
  toolDefinitions: ToolDefinition[]
  provider: ProviderConfig
  compactModel?: ModelSpec
  sessionMemoryBlock?: string
  approvalMode?: 'auto-accept' | 'auto-safe' | 'manual'
  auth?: AuthProvider
  habituationThreshold?: number
}

export function createAgentConfig(input: AgentConfigInput): Pick<
  AgentConfig,
  'client' | 'promptEngine' | 'contextWindow' | 'compact' | 'providerProfile' | 'compactClient' | 'compactModel' | 'sessionId' | 'approvalMode' | 'autoReasoning' | 'reasoningFloor'
> {
  const { model, apiKey, cwd, provider } = input
  const capabilities = resolveCapabilities(provider.name, provider.capabilities)
  const thinkingBudget = model.reasoningEffort === 'max'
    ? 64000
    : Math.min(16000, Math.floor(model.contextWindow * 0.02))

  const client = createProviderClient(provider, capabilities, {
    apiKey,
    model: model.id,
    reasoningEffort: model.reasoningEffort,
    maxTokens: model.maxTokens,
    thinkingBudget,
    auth: input.auth,
    sessionId: input.sessionId,
  })

  const promptEngine = new PromptEngine({
    model: model.id,
    maxTokens: model.maxTokens,
    staticCtx: { tools: input.toolDefinitions },
    volatileCtx: createVolatileSnapshot({
      cwd,
      sessionMemoryBlock: input.sessionMemoryBlock,
    }),
    habituationThreshold: input.habituationThreshold ?? 5,
  })

  let compactClient: AgentConfig['compactClient']
  let compactModelId: string | undefined
  if (input.compactModel) {
    compactClient = createProviderClient(provider, capabilities, {
      apiKey,
      model: input.compactModel.id,
      reasoningEffort: input.compactModel.reasoningEffort,
      maxTokens: Math.min(2048, input.compactModel.maxTokens),
      thinkingBudget: 1024,
    })
    compactModelId = input.compactModel.id
  }

  return {
    client,
    promptEngine,
    contextWindow: model.contextWindow,
    compact: input.compact,
    providerProfile: getProviderProfile(provider.name, model.contextWindow),
    compactClient,
    compactModel: compactModelId,
    sessionId: input.sessionId,
    approvalMode: input.approvalMode,
    autoReasoning: true,
    reasoningFloor: model.reasoningEffort,
  }
}
