import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { extractDecisions } from '../decision-anchor.js'

describe('extractDecisions', () => {
  it('extracts "I will" decisions', () => {
    const text = "I'll use the middleware pattern for authentication instead of decorators."
    const decisions = extractDecisions(text)
    assert.equal(decisions.length, 1)
    assert.ok(decisions[0]!.includes('middleware pattern'))
  })

  it('extracts "方案是" decisions', () => {
    const text = "方案是把 monolith 拆分为 context/ 模块结构。"
    const decisions = extractDecisions(text)
    assert.equal(decisions.length, 1)
    assert.ok(decisions[0]!.includes('monolith'))
  })

  it('extracts "approach:" decisions', () => {
    const text = "approach: split the agent loop into turn-harness + orchestrator"
    const decisions = extractDecisions(text)
    assert.equal(decisions.length, 1)
  })

  it('returns empty for no decisions', () => {
    const text = "Let me read the file first to understand the current implementation."
    assert.equal(extractDecisions(text).length, 0)
  })

  it('limits to 3 decisions max', () => {
    const text =
      "I'll use the middleware approach for this. " +
      "I'll split the monolith into microservices. " +
      "I'll add a caching layer before the database. " +
      "I'll refactor the controller into handlers. " +
      "I'll migrate the config to TypeScript."
    assert.equal(extractDecisions(text).length, 3)
  })

  it('ignores short matches', () => {
    const text = "I'll fix it."
    assert.equal(extractDecisions(text).length, 0)
  })
})
