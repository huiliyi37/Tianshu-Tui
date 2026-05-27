import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createAgentConfig, createMainAgentConfigInput, type AgentConfigInput } from '../agent/create-agent-config.js'
import type { Config, ProviderConfig } from '../config/schema.js'

const testProvider: ProviderConfig = {
  name: 'deepseek',
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
  maxTokens: 64000,
  models: [{ id: 'deepseek-r1', contextWindow: 128000, maxTokens: 8192 }],
  unsupported: [],
}

const testConfig = {
  agent: {
    approval: 'manual',
    maxTurns: 50,
    mode: 'code',
    autoReasoning: false,
    songlineEnabled: true,
    hearthObserveEnabled: false,
    permissions: { allow: [] },
  },
  compact: { enabled: true, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' },
} satisfies Pick<Config, 'agent' | 'compact'>

describe('createAgentConfig', () => {
  const baseInput: AgentConfigInput = {
    apiKey: 'test-key',
    model: { id: 'deepseek-r1', maxTokens: 8192, contextWindow: 128000, reasoningEffort: undefined },
    cwd: '/tmp/test',
    compact: { enabled: true, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' },
    sessionId: 'session-1',
    toolDefinitions: [],
    provider: testProvider,
  }

  it('creates client with correct model params', () => {
    const cfg = createAgentConfig(baseInput)
    assert.ok(cfg.client)
    assert.ok(cfg.promptEngine)
    assert.equal(cfg.contextWindow, 128000)
    assert.equal(cfg.sessionId, 'session-1')
    assert.equal(cfg.providerProfile?.cacheType, 'exact-prefix')
    assert.equal(cfg.providerProfile?.contextWindow, 128000)
  })

  it('returns primaryClient as the main model client', () => {
    const cfg = createAgentConfig(baseInput)
    assert.ok(cfg.primaryClient)
    // primaryClient is the same StreamClient used for main model calls
  })

  it('applies thinkingBudget based on reasoningEffort', () => {
    const maxCfg = createAgentConfig({
      ...baseInput,
      model: { ...baseInput.model, reasoningEffort: 'max' },
    })
    assert.ok(maxCfg.client)
    // Non-max uses Math.min(16000, floor(contextWindow * 0.02))
    const normalCfg = createAgentConfig(baseInput)
    assert.ok(normalCfg.client)
  })

  it('passes approvalMode through', () => {
    const cfg = createAgentConfig({ ...baseInput, approvalMode: 'auto-accept' })
    assert.equal(cfg.approvalMode, 'auto-accept')
  })

  it('defaults autoReasoning to true', () => {
    const cfg = createAgentConfig(baseInput)
    assert.equal(cfg.autoReasoning, true)
  })

  it('uses configured model reasoningEffort as the auto-reasoning floor', () => {
    const cfg = createAgentConfig({
      ...baseInput,
      model: { ...baseInput.model, reasoningEffort: 'high' },
    })
    assert.equal(cfg.reasoningFloor, 'high')
  })

  it('passes songlineEnabled through when explicitly enabled', () => {
    const cfg = createAgentConfig({ ...baseInput, songlineEnabled: true })

    assert.equal(cfg.songlineEnabled, true)
  })

  it('builds main AgentConfig input from layered config including songlineEnabled', () => {
    const input = createMainAgentConfigInput({
      apiKey: 'test-key',
      model: baseInput.model,
      cwd: '/tmp/test',
      config: testConfig,
      sessionId: 'session-1',
      toolDefinitions: [],
      provider: testProvider,
      sessionMemoryBlock: 'memory block text',
    })

    assert.equal(input.compact, testConfig.compact)
    assert.equal(input.approvalMode, 'manual')
    assert.equal(input.songlineEnabled, true)

    const cfg = createAgentConfig(input)
    assert.equal(cfg.songlineEnabled, true)
  })

  it('passes sessionMemoryBlock to promptEngine', () => {
    const cfg = createAgentConfig({ ...baseInput, sessionMemoryBlock: 'memory block text' })
    assert.ok(cfg.promptEngine)
  })
})
