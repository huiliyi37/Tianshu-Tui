import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { selectReasoningEffort } from '../agent/auto-reasoning.js'

describe('selectReasoningEffort', () => {
  it('returns max for architecture/design tasks', () => {
    assert.equal(selectReasoningEffort('Design a new authentication system with OAuth2'), 'max')
    assert.equal(selectReasoningEffort('Architect the database migration strategy'), 'max')
    assert.equal(selectReasoningEffort('Refactor the entire auth module across 5 files'), 'max')
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
