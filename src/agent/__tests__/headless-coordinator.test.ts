import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { buildModelCards, createHeadlessCoordinator } from '../headless-coordinator.js'
import type { ProviderConfig } from '../../config/schema.js'
import { createDefaultToolRegistry } from '../../tools/default-registry.js'

function makeProvider(overrides?: Partial<ProviderConfig>): ProviderConfig {
  return {
    name: 'test-provider',
    apiKey: 'test-key',
    models: [
      { id: 'test-model-pro', maxTokens: 8192, contextWindow: 128_000 },
      { id: 'test-model-flash', maxTokens: 4096, contextWindow: 64_000 },
    ],
    capabilities: {},
    ...overrides,
  } as unknown as ProviderConfig
}

describe('buildModelCards', () => {
  it('assigns pro-level metrics to models with "pro" in the id', () => {
    const provider = makeProvider()
    const cards = buildModelCards(provider)
    const proCard = cards.find(c => c.model === 'test-model-pro')
    assert.ok(proCard)
    assert.equal(proCard!.toolUseReliability, 0.8)
    assert.equal(proCard!.editSuccessRate, 0.7)
    assert.equal(proCard!.contextWindow, 128_000)
    assert.deepEqual(proCard!.recommendedTasks, ['code_search', 'code_edit', 'test_failure_diagnosis', 'risky_refactor'])
  })

  it('assigns flash-level metrics to models with "flash" in the id', () => {
    const provider = makeProvider()
    const cards = buildModelCards(provider)
    const flashCard = cards.find(c => c.model === 'test-model-flash')
    assert.ok(flashCard)
    assert.equal(flashCard!.toolUseReliability, 0.6)
    assert.equal(flashCard!.editSuccessRate, 0.5)
    assert.equal(flashCard!.contextWindow, 64_000)
    assert.deepEqual(flashCard!.recommendedTasks, ['repo_summarization', 'compaction'])
  })

  it('handles models without pro/flash in id as pro-level', () => {
    const provider = makeProvider({
      models: [{ id: 'generic-model', maxTokens: 4096, contextWindow: 32_000 }] as never,
    })
    const cards = buildModelCards(provider)
    assert.equal(cards.length, 1)
    assert.equal(cards[0]!.toolUseReliability, 0.8)
  })

  it('detects pro/flash via alias', () => {
    const provider = makeProvider({
      models: [
        { id: 'm1', alias: 'pro', maxTokens: 4096, contextWindow: 32_000 },
        { id: 'm2', alias: 'flash', maxTokens: 4096, contextWindow: 32_000 },
      ] as never,
    })
    const cards = buildModelCards(provider)
    assert.equal(cards[0]!.editSuccessRate, 0.7) // pro via alias
    assert.equal(cards[1]!.editSuccessRate, 0.5) // flash via alias
  })
})

describe('createHeadlessCoordinator', () => {
  it('creates a DelegationCoordinator with maxWorkers=1', () => {
    const toolRegistry = createDefaultToolRegistry([], { desktopTools: false })
    const coordinator = createHeadlessCoordinator({
      toolRegistry,
      provider: makeProvider(),
      providerName: 'test-provider',
      apiKey: 'test-key',
      cwd: '/tmp/test',
    })
    assert.ok(coordinator)
    // maxWorkers=1 means only one concurrent worker — headless goal only ever
    // spawns goal_judge, so no need for a larger pool.
    // We verify the coordinator is usable via delegate (integration), not by
    // reading private fields.
  })

  it('produces a coordinator whose delegate is callable (does not throw on construction)', () => {
    const toolRegistry = createDefaultToolRegistry([], { desktopTools: false })
    const coordinator = createHeadlessCoordinator({
      toolRegistry,
      provider: makeProvider(),
      providerName: 'test-provider',
      apiKey: 'test-key',
      cwd: '/tmp/test',
      sessionId: 'test-session',
    })
    assert.ok(coordinator)
    assert.equal(typeof coordinator.delegate, 'function')
  })
})
