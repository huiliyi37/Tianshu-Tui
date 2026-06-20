import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { ModelCapabilityCard } from '../../model/capability.js'
import { DelegationCoordinator } from '../coordinator.js'
import { ToolRegistry } from '../../tools/registry.js'

/**
 * Focused unit tests for the reviewOverrideCards fast path inside
 * DelegationCoordinator.selectModelForTask. Calls the private method via
 * type-erase access — no need to set up the full delegate() pipeline
 * (work order → profile → allowedTools → filterToolRegistry).
 */

const primaryCards: ModelCapabilityCard[] = [
  { model: 'glm-5.2', toolUseReliability: 0.8, jsonStability: 0.8, editSuccessRate: 0.7, testRepairRate: 0.6, contextWindow: 1_000_000, cacheEconomics: 'strong', recommendedTasks: ['code_search', 'code_edit'] },
  { model: 'glm-5-flash', toolUseReliability: 0.6, jsonStability: 0.65, editSuccessRate: 0.5, testRepairRate: 0.45, contextWindow: 1_000_000, cacheEconomics: 'strong', recommendedTasks: ['repo_summarization'] },
]

const deepseekOverride: ModelCapabilityCard = {
  model: 'deepseek-v4-flash',
  toolUseReliability: 0.6,
  jsonStability: 0.65,
  editSuccessRate: 0.5,
  testRepairRate: 0.45,
  contextWindow: 1_000_000,
  cacheEconomics: 'strong',
  recommendedTasks: ['code_search'],
}

const kimiOverride: ModelCapabilityCard = {
  model: 'kimi-v2-flash',
  toolUseReliability: 0.6,
  jsonStability: 0.65,
  editSuccessRate: 0.5,
  testRepairRate: 0.45,
  contextWindow: 128_000,
  cacheEconomics: 'strong',
  recommendedTasks: ['code_search'],
}

function buildCoordinator(reviewOverrideCards?: Map<string, ModelCapabilityCard>): DelegationCoordinator {
  // runtimeFactory unused in these tests — the override check happens in
  // selectModelForTask before any worker is spawned. We still need a valid
  // factory for DelegationCoordinator construction.
  const coordinator = new DelegationCoordinator({
    baseToolRegistry: new ToolRegistry(),
    modelCards: primaryCards,
    maxWorkers: 1,
    runtimeFactory: () => { throw new Error('runtimeFactory should not be called in these tests') },
    reviewOverrideCards,
  })
  return coordinator
}

describe('DelegationCoordinator review override', () => {
  it('returns override card when profile matches', () => {
    const overrides = new Map<string, ModelCapabilityCard>([['adversarial_verifier', deepseekOverride]])
    const coordinator = buildCoordinator(overrides)
    const selected = (coordinator as unknown as {
      selectModelForTask(task: string, preferredTier?: string, profile?: string): ModelCapabilityCard
    }).selectModelForTask('code_search', undefined, 'adversarial_verifier')
    assert.equal(selected.model, 'deepseek-v4-flash')
  })

  it('falls back to primary modelCards when profile has no override entry', () => {
    const overrides = new Map<string, ModelCapabilityCard>([['adversarial_verifier', deepseekOverride]])
    const coordinator = buildCoordinator(overrides)
    const selected = (coordinator as unknown as {
      selectModelForTask(task: string, preferredTier?: string, profile?: string): ModelCapabilityCard
    }).selectModelForTask('code_search', undefined, 'code_scout')
    assert.notEqual(selected.model, 'deepseek-v4-flash')
    assert.ok(primaryCards.some(c => c.model === selected.model))
  })

  it('falls back to primary modelCards when no override map is configured', () => {
    const coordinator = buildCoordinator(undefined)
    const selected = (coordinator as unknown as {
      selectModelForTask(task: string, preferredTier?: string, profile?: string): ModelCapabilityCard
    }).selectModelForTask('code_search', undefined, 'adversarial_verifier')
    assert.notEqual(selected.model, 'deepseek-v4-flash')
    assert.ok(primaryCards.some(c => c.model === selected.model))
  })

  it('routes different profiles to different override cards', () => {
    const overrides = new Map<string, ModelCapabilityCard>([
      ['adversarial_verifier', deepseekOverride],
      ['reviewer', kimiOverride],
    ])
    const coordinator = buildCoordinator(overrides)
    const select = (profile: string) => (coordinator as unknown as {
      selectModelForTask(task: string, preferredTier?: string, profile?: string): ModelCapabilityCard
    }).selectModelForTask('code_search', undefined, profile)
    assert.equal(select('adversarial_verifier').model, 'deepseek-v4-flash')
    assert.equal(select('reviewer').model, 'kimi-v2-flash')
  })

  it('override wins over preferredTier — always returns override card', () => {
    const overrides = new Map<string, ModelCapabilityCard>([['adversarial_verifier', deepseekOverride]])
    const coordinator = buildCoordinator(overrides)
    // preferredTier='strong' would normally select glm-5.2; override bypasses that.
    const selected = (coordinator as unknown as {
      selectModelForTask(task: string, preferredTier?: string, profile?: string): ModelCapabilityCard
    }).selectModelForTask('code_search', 'strong', 'adversarial_verifier')
    assert.equal(selected.model, 'deepseek-v4-flash')
  })
})
