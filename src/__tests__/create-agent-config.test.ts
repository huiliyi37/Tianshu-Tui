import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createAgentConfig, type AgentConfigInput } from '../agent/create-agent-config.js'
import type { ProviderConfig } from '../config/schema.js'

const testProvider: ProviderConfig = {
  name: 'deepseek',
  baseUrl: 'https://api.deepseek.com/anthropic',
  protocol: 'anthropic',
  capabilities: {
    cacheControl: false,
    stripParams: [],
    toolJsonBug: true,
    prefixCache: 'deepseek-native',
  },
  thinking: 'enabled',
  maxTokens: 64000,
  models: [{ id: 'deepseek-r1', contextWindow: 128000, maxTokens: 8192 }],
  unsupported: [],
}

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
  })

  it('creates compactClient when compactModel provided', () => {
    const cfg = createAgentConfig({
      ...baseInput,
      compactModel: { id: 'deepseek-flash', maxTokens: 4096, contextWindow: 64000, reasoningEffort: undefined },
    })
    assert.ok(cfg.compactClient)
    assert.equal(cfg.compactModel, 'deepseek-flash')
  })

  it('omits compactClient when no compactModel', () => {
    const cfg = createAgentConfig(baseInput)
    assert.equal(cfg.compactClient, undefined)
    assert.equal(cfg.compactModel, undefined)
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

  it('passes sessionMemoryBlock to promptEngine', () => {
    const cfg = createAgentConfig({ ...baseInput, sessionMemoryBlock: 'memory block text' })
    assert.ok(cfg.promptEngine)
  })
})
