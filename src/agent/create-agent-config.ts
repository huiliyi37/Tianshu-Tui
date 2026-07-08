import { createProviderClient, resolveApiKey } from '../api/factory.js'
import { resolveCapabilities } from '../api/provider.js'
import { createAuthProvider } from '../auth/registry.js'
import { PromptEngine } from '../prompt/engine.js'
import { detectModelFamily } from '../prompt/static.js'
import { createVolatileSnapshot } from '../prompt/volatile-snapshot.js'
import { FallbackStreamClient } from '../api/fallback-client.js'
import type { AgentConfig } from './loop-types.js'
import type { CompactionConfig } from '../compact/constants.js'
import type { ToolDefinition } from '../api/types.js'
import type { ProviderConfig, Config } from '../config/schema.js'
import type { AntiAnchoringConfig } from './anti-anchoring-config.js'
import type { IntentRetrievalRouterConfigInput } from './intent-retrieval-router.js'
import type { LlmSpeculationConfigInput } from './llm-speculation.js'
import type { AuthProvider } from '../auth/types.js'
import type { PermissionConfig } from './permissions.js'
import { getProviderProfile } from '../api/provider-profile.js'
import { gateToolDefinitions } from './tool-tiers.js'

export interface ModelSpec {
  id: string
  maxTokens: number
  contextWindow: number
  reasoningEffort?: 'off' | 'low' | 'medium' | 'high' | 'max'
  /** Model accepts image inputs (multimodal user messages). Gates the
   *  tool-boundary vision channel (computer_use screenshots). */
  supportsVision?: boolean
}

export interface AgentConfigInput {
  apiKey: string
  model: ModelSpec
  cwd: string
  compact: CompactionConfig
  sessionId: string
  toolDefinitions: ToolDefinition[]
  provider: ProviderConfig
  /** All configured providers — needed for resolving fallback chain. */
  allProviders?: Record<string, ProviderConfig>
  sessionMemoryBlock?: string
  approvalMode?: 'auto-accept' | 'auto-safe' | 'manual' | 'dangerously-skip-permissions'
  songlineEnabled?: boolean
  hearthObserveEnabled?: boolean
  antiAnchoring?: AntiAnchoringConfig
  intentRetrievalRouter?: IntentRetrievalRouterConfigInput
  llmSpeculation?: LlmSpeculationConfigInput
  autoDelegateEnabled?: boolean
  autoReasoning?: boolean
  crossSessionEnabled?: boolean
  goalJudge?: { enabled?: boolean; maxRuns?: number; browser?: boolean }
  auth?: AuthProvider
  habituationThreshold?: number
  /** Optional permission config — allowlists, bash command prefixes, etc. */
  permissions?: PermissionConfig
  /** 主控工具门控。缺省 undefined → 全量（不门控）。 */
  toolGating?: {
    enabled: boolean
    coreOverride?: readonly string[]
    extraCore?: readonly string[]
    domainTier?: readonly string[]
  }
}

export interface MainAgentConfigInputParams {
  apiKey: string
  model: ModelSpec
  cwd: string
  config: Pick<Config, 'agent' | 'compact'>
  sessionId: string
  toolDefinitions: ToolDefinition[]
  provider: ProviderConfig
  allProviders?: Record<string, ProviderConfig>
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
    allProviders: params.allProviders,
    sessionMemoryBlock: params.sessionMemoryBlock,
    approvalMode: params.config.agent.approval as 'auto-accept' | 'auto-safe' | 'manual' | 'dangerously-skip-permissions',
    songlineEnabled: params.config.agent.songlineEnabled,
    hearthObserveEnabled: params.config.agent.hearthObserveEnabled,
    crossSessionEnabled: params.config.agent.crossSessionEnabled,
    antiAnchoring: params.config.agent.antiAnchoring,
    intentRetrievalRouter: params.config.agent.intentRetrievalRouter,
    llmSpeculation: params.config.agent.llmSpeculation,
    autoDelegateEnabled: params.config.agent.autoDelegateEnabled,
    autoReasoning: params.config.agent.autoReasoning,
    goalJudge: params.config.agent.goal?.judge,
    auth: params.auth,
    habituationThreshold: params.habituationThreshold,
    permissions: params.config.agent.permissions as PermissionConfig,
    toolGating: params.config.agent.toolGating
      ? {
          enabled: params.config.agent.toolGating.enabled,
          coreOverride: params.config.agent.toolGating.coreTools,
          extraCore: params.config.agent.toolGating.extraCore,
        }
      : undefined,
 }
}

export function createAgentConfig(input: AgentConfigInput): Pick<
  AgentConfig,
  'client' | 'promptEngine' | 'contextWindow' | 'compact' | 'providerProfile' | 'providerName' | 'primaryClient' | 'compactClient' | 'sessionId' | 'approvalMode' | 'autoReasoning' | 'reasoningFloor' | 'turnLevelThinking' | 'songlineEnabled' | 'hearthObserveEnabled' | 'crossSessionEnabled' | 'antiAnchoring' | 'intentRetrievalRouter' | 'llmSpeculation' | 'autoDelegateEnabled' | 'goalJudge' | 'allProviders' | 'permissions' | 'toolGating' | 'prefixCacheStrategy' | 'supportsVision'
> {
  const { model, apiKey, cwd, provider } = input
  const capabilities = resolveCapabilities(provider.name, provider.capabilities)
  const thinkingBudget = model.reasoningEffort === 'max'
    ? 64000
    : Math.min(16000, Math.floor(model.contextWindow * 0.02))

  const primaryClient = createProviderClient(provider, capabilities, {
    apiKey,
    model: model.id,
    reasoningEffort: model.reasoningEffort,
    maxTokens: model.maxTokens,
    thinkingBudget,
    auth: input.auth,
    sessionId: input.sessionId,
  })

  const client = buildFallbackChain(primaryClient, provider, model, input)

  // Optional dedicated compaction client (compact.provider + compact.model).
  // Routes summarization to a cheap model on its own server-side cache so it
  // neither spends the main model's tokens nor evicts its hot prefix. Silent
  // fallback to primaryClient when unconfigured/invalid (mirrors review/council).
  const compactClient = buildCompactClient(input)

  // 工具门控：构造期与 updateTools() 共用同一过滤（gateToolDefinitions），
  // 确保 MCP/LSP 异步注册后调用 updateTools 不会把 EXTENDED 工具整个还原。
  const gatedTools = input.toolGating
    ? gateToolDefinitions(input.toolDefinitions, {
        enabled: input.toolGating.enabled,
        coreOverride: input.toolGating.coreOverride,
        extraCore: input.toolGating.extraCore,
        domainTier: input.toolGating.domainTier,
      })
    : input.toolDefinitions

  const promptEngine = new PromptEngine({
    model: model.id,
    maxTokens: model.maxTokens,
    staticCtx: { tools: gatedTools, modelFamily: detectModelFamily(model.id) },
    volatileCtx: createVolatileSnapshot({
      cwd,
      sessionMemoryBlock: input.sessionMemoryBlock,
   }),
    habituationThreshold: input.habituationThreshold ?? 5,
    prefixCache: capabilities.prefixCacheStrategy,
    appendixDelta: process.env['RIVET_APPENDIX_DELTA'] !== '0',
 })

  return {
    client,
    promptEngine,
    contextWindow: model.contextWindow,
    compact: input.compact,
    providerProfile: getProviderProfile(provider.name, model.contextWindow),
    providerName: provider.name,
    primaryClient: primaryClient,
    compactClient,
    sessionId: input.sessionId,
    approvalMode: input.approvalMode,
    songlineEnabled: input.songlineEnabled,
    hearthObserveEnabled: input.hearthObserveEnabled,
    crossSessionEnabled: input.crossSessionEnabled,
    antiAnchoring: input.antiAnchoring,
    intentRetrievalRouter: input.intentRetrievalRouter,
    llmSpeculation: input.llmSpeculation,
    autoDelegateEnabled: input.autoDelegateEnabled,
    goalJudge: input.goalJudge,
    allProviders: input.allProviders,
    autoReasoning: input.autoReasoning ?? true,
    reasoningFloor: model.reasoningEffort,
    // GLM turn-level thinking: disable thinking on tool execution turns
    // to prevent reasoning_content accumulation and context window stalls.
    turnLevelThinking: provider.name === 'glm',
    permissions: input.permissions,
    toolGating: input.toolGating,
    prefixCacheStrategy: capabilities.prefixCacheStrategy,
    // Per-model vision capability — switchModel rebuilds the agent, so this
    // value always tracks the active model (no live getter needed).
    supportsVision: model.supportsVision ?? false,
 }
}

function buildFallbackChain(
  primary: import('../api/stream-client.js').StreamClient,
  provider: ProviderConfig,
  model: ModelSpec,
  input: AgentConfigInput,
): import('../api/stream-client.js').StreamClient {
  const fallbackNames = provider.fallback
  if (!fallbackNames?.length || !input.allProviders) return primary

  const entries = fallbackNames
    .filter(name => name !== provider.name && input.allProviders![name])
    .map(name => ({
      name,
      create: () => {
        const fp = input.allProviders![name]!
        const fCaps = resolveCapabilities(fp.name, fp.capabilities)
        // Resolve fallback API key — fail loudly instead of silently returning
        // primary so the user knows their fallback provider is misconfigured.
        let fApiKey: string
        try {
          fApiKey = resolveApiKey(fp)
        } catch {
          throw new Error(
            `Fallback provider "${name}" has no API key configured. ` +
            `Set ${fp.apiKeyEnv ?? `<PROVIDER>_API_KEY`} env var or inline apiKey in config.`
          )
        }
        // Use the fallback provider's fallbackModel if set; default to Flash
        // ('deepseek-v4-flash') to avoid cold-start cache miss cost on Pro models.
        const fallbackModelId = fp.fallbackModel ?? 'deepseek-v4-flash'
        const fModel = fp.models.find(m => m.id === fallbackModelId) ?? fp.models[0]!
        return createProviderClient(fp, fCaps, {
          apiKey: fApiKey,
          model: fModel.id,
          maxTokens: fModel.maxTokens,
          reasoningEffort: model.reasoningEffort,
          sessionId: input.sessionId,
        })
      },
    }))

  if (entries.length === 0) return primary
  return new FallbackStreamClient(primary, provider.name, entries)
}

/**
 * Build the dedicated compaction StreamClient from compact.provider+model.
 * Returns undefined (→ caller falls back to primaryClient) when:
 *  - provider/model not both set
 *  - provider unknown, or model not in its model list
 *  - credentials missing (apiKey empty / oauth not authenticated)
 * This matches the silent-fallback contract of review/council routing: a
 * misconfigured compact route degrades to the primary model, never errors.
 */
function buildCompactClient(
  input: AgentConfigInput,
): import('../api/stream-client.js').StreamClient | undefined {
  const compactProvider = input.compact.provider
  const compactModel = input.compact.model
  if (!compactProvider || !compactModel) return undefined
  const prov = input.allProviders?.[compactProvider]
  if (!prov) return undefined
  const spec = prov.models.find(m => m.id === compactModel || m.alias === compactModel)
  if (!spec) return undefined

  let apiKey = ''
  let auth: AuthProvider | undefined
  try {
    if (prov.auth?.type === 'oauth') {
      auth = prov.name === input.provider.name ? input.auth : createAuthProvider(prov.auth, process.env)
      if (!auth?.isAuthenticated()) return undefined
    } else {
      apiKey = resolveApiKey(prov)
      if (!apiKey) return undefined
    }
  } catch {
    return undefined
  }

  const caps = resolveCapabilities(prov.name, prov.capabilities)
  // A dedicated compact client always runs the generous char budget (up to ~16K
  // chars at 1M). maxTokens only caps output (billed per generated token), so a
  // high ceiling is cost-neutral but prevents truncating a generous CJK summary
  // mid-sentence — 16K chars is ~10K tokens for Chinese, far above a 4K cap.
  const maxTokens = Math.min(16_384, spec.maxTokens)
  return createProviderClient(prov, caps, {
    apiKey,
    model: spec.id,
    reasoningEffort: spec.reasoningEffort,
    maxTokens,
    auth,
    sessionId: input.sessionId,
  })
}
