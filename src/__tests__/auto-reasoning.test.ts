import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { selectReasoningEffort } from '../agent/auto-reasoning.js'

describe('selectReasoningEffort', () => {
  it('returns max for architecture/design tasks', () => {
    assert.equal(selectReasoningEffort('Design a new authentication system with OAuth2'), 'max')
    assert.equal(selectReasoningEffort('Architect the database migration strategy'), 'max')
    assert.equal(selectReasoningEffort('Refactor the entire auth module across 5 files'), 'max')
  })

  it('returns max for security/vulnerability analysis', () => {
    assert.equal(selectReasoningEffort('Security audit of the API endpoints'), 'max')
    assert.equal(selectReasoningEffort('Check this code for vulnerabilities'), 'max')
    assert.equal(selectReasoningEffort('Pen-test the auth flow'), 'max')
  })

  it('returns max for performance optimization / root cause', () => {
    assert.equal(selectReasoningEffort('Optimize performance of the rendering pipeline'), 'max')
    assert.equal(selectReasoningEffort('Find the root cause of the memory bloat'), 'max')
    assert.equal(selectReasoningEffort('Diagnose why the cache hit rate dropped'), 'max')
    assert.equal(selectReasoningEffort('Profile the bottleneck in the build step'), 'max')
  })

  it('returns max for algorithm / complexity / impact analysis', () => {
    assert.equal(selectReasoningEffort('Choose the right algorithm for deduplication'), 'max')
    assert.equal(selectReasoningEffort('Analyze the time complexity of this function'), 'max')
    assert.equal(selectReasoningEffort('Impact analysis of changing the config schema'), 'max')
    assert.equal(selectReasoningEffort('Review the architecture of the agent loop'), 'max')
  })

  it('returns max for Chinese deep-reasoning scenarios', () => {
    assert.equal(selectReasoningEffort('设计这个模块的整体架构方案'), 'max')
    assert.equal(selectReasoningEffort('重构整个认证模块'), 'max')
    assert.equal(selectReasoningEffort('深度分析前缀缓存命中率下降的根因'), 'max')
    assert.equal(selectReasoningEffort('全面审查这个 PR 的安全性'), 'max')
    assert.equal(selectReasoningEffort('排查内存泄漏的根因'), 'max')
    assert.equal(selectReasoningEffort('评审这个重构方案的架构'), 'max')
  })

  it('returns high for complex refactor/debug tasks', () => {
    assert.equal(selectReasoningEffort('Debug the race condition in the connection pool'), 'high')
    assert.equal(selectReasoningEffort('Fix the memory leak across the rendering pipeline'), 'high')
    assert.equal(selectReasoningEffort('Implement the caching layer feature'), 'high')
  })

  it('returns low for simple descriptive queries', () => {
    assert.equal(selectReasoningEffort('What does this function do?'), 'low')
    assert.equal(selectReasoningEffort('Explain the auth flow'), 'low')
    assert.equal(selectReasoningEffort('Show me the config schema'), 'low')
  })

  it('returns medium for standard coding tasks', () => {
    assert.equal(selectReasoningEffort('Add a test for the login function'), 'medium')
    assert.equal(selectReasoningEffort('Rename this variable'), 'medium')
  })

  it('returns off for trivial slash commands', () => {
    assert.equal(selectReasoningEffort('/compact'), 'off')
    assert.equal(selectReasoningEffort('/help'), 'off')
    assert.equal(selectReasoningEffort('/model list'), 'off')
  })

  it('respects a configured reasoning floor', () => {
    assert.equal(selectReasoningEffort('/help', 'medium'), 'medium')
    assert.equal(selectReasoningEffort('What does this function do?', 'high'), 'high')
    assert.equal(selectReasoningEffort('Design a new authentication system', 'medium'), 'max')
  })
})
