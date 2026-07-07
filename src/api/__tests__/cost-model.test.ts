import { test } from 'node:test'
import assert from 'node:assert/strict'
import { classifyCostModel, isCostInsensitiveProvider } from '../cost-model.js'

test('subscription providers classify as subscription', () => {
  for (const name of ['glm', 'mimo', 'codex', 'claude']) {
    assert.equal(classifyCostModel(name), 'subscription', name)
    assert.equal(isCostInsensitiveProvider(name), true, name)
  }
})

test('per-token providers classify as per-token', () => {
  for (const name of ['deepseek', 'mimo-api', 'minimax', 'openai', 'anthropic', 'qwen', 'kimi', 'vllm']) {
    assert.equal(classifyCostModel(name), 'per-token', name)
    assert.equal(isCostInsensitiveProvider(name), false, name)
  }
})

test('classification is case-insensitive and trims', () => {
  assert.equal(classifyCostModel('  GLM  '), 'subscription')
  assert.equal(classifyCostModel('DeepSeek'), 'per-token')
})

test('unknown provider defaults to per-token (conservative)', () => {
  assert.equal(classifyCostModel('some-custom-llm'), 'per-token')
  assert.equal(classifyCostModel(undefined), 'per-token')
  assert.equal(classifyCostModel(''), 'per-token')
})

test('oauth auth hint promotes unknown provider to subscription', () => {
  assert.equal(classifyCostModel('some-custom-llm', { authType: 'oauth' }), 'subscription')
  assert.equal(isCostInsensitiveProvider('some-custom-llm', { authType: 'oauth' }), true)
})

test('coding-plan / token-plan baseUrl hint promotes to subscription', () => {
  assert.equal(classifyCostModel('custom', { baseUrl: 'https://x.example.com/api/coding/v1' }), 'subscription')
  assert.equal(classifyCostModel('custom', { baseUrl: 'https://token-plan-cn.example.com/v1' }), 'subscription')
  assert.equal(classifyCostModel('custom', { baseUrl: 'https://api.example.com/v1' }), 'per-token')
})

test('known provider name wins over hints', () => {
  // deepseek is per-token even if someone passes an oauth hint
  assert.equal(classifyCostModel('deepseek', { authType: 'oauth' }), 'per-token')
})
