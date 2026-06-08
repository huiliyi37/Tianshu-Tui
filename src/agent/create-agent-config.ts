import { createProviderClient } from '../api/factory.js'
import { resolveCapabilities } from '../api/provider.js'
import { PromptEngine } from '../prompt/engine.js'
import { createVolatileSnapshot } from '../prompt/volatile-snapshot.js'
import type { AgentConfig } from './loop-types.js'
import type { CompactionConfig } from '../compact/constants.js'
import type { ToolDefinition } from '../api/types.js'
import type { ProviderConfig, Config } from '../config/schema.js'
import type { AntiAnchoringConfig } from './anti-anchoring-config.js'
import type { IntentRetrievalRouterConfigInput } from './intent-retrieval-router.js'
import type { AuthProvider } from '../auth/types.js'
import type { PermissionConfig } from './permissions.js'
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
  sessionMemoryBlock?: string
  approvalMode?: 'auto-accept' | 'auto-safe' | 'manual' | 'dangerously-skip-permissions'
  songlineEnabled?: boolean
  hearthObserveEnabled?: boolean
  antiAnchoring?: AntiAnchoringConfig
  intentRetrievalRouter?: IntentRetrievalRouterConfigInput
  auth?: AuthProvider
  habituationThreshold?: number
  /** Optional permission config — allowlists, bash command prefixes, etc. */
  permissions?: PermissionConfig
}

export interface MainAgentConfigInputParams {
  apiKey: string
  model: ModelSpec
  cwd: string
  config: Pick<Config, 'agent' | 'compact'>
  sessionId: string
  toolDefinitions: ToolDefinition[]
  provider: ProviderConfig
  sessionMemoryBlock?: string
  auth?: AuthProvider
  habituationThreshold?: number
  permissions?: PermissionConfig
}

export function createMainAgentConfigInput(params: MainAgentConfigInputParams): AgentConfigInput {
  return {
    apiKey: params.apiKey,
    model: params.model,
    cwd: params.cwd,
    compact: params.config.compact,
    sessionId: params.sessionId,
    toolDefinitions: params.toolDefinitions,
    provider: params.provider,
    sessionMemoryBlock: params.sessionMemoryBlock,
    approvalMode: params.config.agent.approval as 'auto-accept' | 'auto-safe' | 'manual' | 'dangerously-skip-permissions',
    songlineEnabled: params.config.agent.songlineEnabled,
    hearthObserveEnabled: params.config.agent.hearthObserveEnabled,
    antiAnchoring: params.config.agent.antiAnchoring,
    intentRetrievalRouter: params.config.agent.intentRetrievalRouter,
    auth: params.auth,
    habituationThreshold: params.habituationThreshold,
    permissions: params.config.agent.permissions as PermissionConfig,
 }
}

export function createAgentConfig(input: AgentConfigInput): Pick<
  AgentConfig,
  'client' | 'promptEngine' | 'contextWindow' | 'compact' | 'providerProfile' | 'primaryClient' | 'sessionId' | 'approvalMode' | 'autoReasoning' | 'reasoningFloor' | 'turnLevelThinking' | 'songlineEnabled' | 'hearthObserveEnabled' | 'antiAnchoring' | 'intentRetrievalRouter' | 'permissions'
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

  return {
    client,
    promptEngine,
    contextWindow: model.contextWindow,
    compact: input.compact,
    providerProfile: getProviderProfile(provider.name, model.contextWindow),
    primaryClient: client,
    sessionId: input.sessionId,
    approvalMode: input.approvalMode,
    songlineEnabled: input.songlineEnabled,
    hearthObserveEnabled: input.hearthObserveEnabled,
    antiAnchoring: input.antiAnchoring,
    intentRetrievalRouter: input.intentRetrievalRouter,
    autoReasoning: true,
    reasoningFloor: model.reasoningEffort,
    // GLM turn-level thinking: disable thinking on tool execution turns
    // to prevent reasoning_content accumulation and context window stalls.
    turnLevelThinking: provider.name === 'glm',
    permissions: input.permissions,
 }
}
