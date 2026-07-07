/**
 * Headless DelegationCoordinator — minimal coordinator for `--goal` mode.
 *
 * The full bootstrap coordinator (bootstrap.ts) captures 10+ closure variables
 * (reviewOverrides, workerRouting, providerHealth, banditPromotion, efeRouting,
 * domainKnowledgeStore, …). Rather than extract a shared factory with a God-sized
 * param type, we build a dedicated lightweight coordinator here that only needs
 * to spawn `goal_judge` (read-only + test) workers with the same provider/apiKey
 * as the main session.
 *
 * Not wired: review overrides, worker routing, bandit, session registry.
 */

import { DelegationCoordinator } from './coordinator.js'
import type { WorkerRuntimeFactory } from './coordinator.js'
import type { ModelCapabilityCard } from '../model/capability.js'
import type { ProviderConfig } from '../config/schema.js'
import type { ToolRegistry } from '../tools/registry.js'
import type { AuthProvider } from '../auth/types.js'
import { createProviderClient } from '../api/factory.js'
import { resolveCapabilities } from '../api/provider.js'
import { PromptEngine } from '../prompt/engine.js'
import { profileRegistry } from './profile-registry.js'
import type { CompactionConfig } from '../compact/constants.js'

export interface HeadlessCoordinatorInput {
  toolRegistry: ToolRegistry
  provider: ProviderConfig
  providerName: string
  apiKey: string
  auth?: AuthProvider
  cwd: string
  sessionId?: string
}

/** Build modelCards from a provider's models (mirrors bootstrap.ts:584-609). */
export function buildModelCards(provider: ProviderConfig): ModelCapabilityCard[] {
  return provider.models.map(m => {
    const isPro = m.id.includes('pro') || m.alias?.includes('pro')
    const isFlash = m.id.includes('flash') || m.alias?.includes('flash')
    if (isPro || (!isFlash && !isPro)) {
      return {
        model: m.id,
        toolUseReliability: 0.8,
        jsonStability: 0.8,
        editSuccessRate: 0.7,
        testRepairRate: 0.6,
        contextWindow: m.contextWindow,
        cacheEconomics: 'strong' as const,
        recommendedTasks: ['code_search', 'code_edit', 'test_failure_diagnosis', 'risky_refactor'],
      }
    }
    return {
      model: m.id,
      toolUseReliability: 0.6,
      jsonStability: 0.65,
      editSuccessRate: 0.5,
      testRepairRate: 0.45,
      contextWindow: m.contextWindow,
      cacheEconomics: 'strong' as const,
      recommendedTasks: ['repo_summarization', 'compaction'],
    }
  })
}

const HEADLESS_COMPACT: CompactionConfig = {
  enabled: false,
  autoThreshold: 800_000,
  autoFloor: 500_000,
  model: 'flash',
}

/**
 * Build a minimal DelegationCoordinator for headless goal mode.
 * Only supports spawning read-only workers (goal_judge) — no review
 * overrides, no worker routing, no bandit, no session registry.
 */
export function createHeadlessCoordinator(input: HeadlessCoordinatorInput): DelegationCoordinator {
  const modelCards = buildModelCards(input.provider)
  const runtimeFactory: WorkerRuntimeFactory = (order, card, workerRegistry) => {
    const isWrite = profileRegistry.listWriteProfiles().includes(order.profile)
    const modelSpec = input.provider.models.find(
      m => m.id === card.model || m.alias === card.model,
    )
    const ctxWindow = modelSpec?.contextWindow ?? card.contextWindow
    const maxTokens = isWrite
      ? Math.min(8192, modelSpec?.maxTokens ?? ctxWindow)
      : Math.min(4096, modelSpec?.maxTokens ?? ctxWindow)
    return {
      order,
      client: createProviderClient(
        input.provider,
        resolveCapabilities(input.providerName, input.provider.capabilities),
        {
          apiKey: input.apiKey,
          model: card.model,
          reasoningEffort: undefined,
          maxTokens,
          thinkingBudget: isWrite ? 8192 : 4096,
          auth: input.auth,
        },
      ),
      promptEngine: new PromptEngine({
        model: card.model,
        maxTokens,
        staticCtx: { tools: workerRegistry.getDefinitions() },
        volatileCtx: { cwd: input.cwd },
      }),
      toolRegistry: workerRegistry,
      cwd: input.cwd,
      // Far backstop only — the work order budget (clamped via clampWorkerMaxTurns)
      // is the real turn controller.
      maxTurns: 40,
      contextWindow: ctxWindow,
      compact: HEADLESS_COMPACT,
      activeClaims: [],
    }
  }
  return new DelegationCoordinator({
    baseToolRegistry: input.toolRegistry,
    modelCards,
    maxWorkers: 1, // headless goal only ever spawns goal_judge
    runtimeFactory,
    maxDelegationDepth: 1,
    sessionId: input.sessionId,
  })
}
