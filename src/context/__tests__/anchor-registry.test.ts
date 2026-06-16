import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { AnchorRegistry } from '../anchor-registry.js'

describe('AnchorRegistry', () => {
  it('extracts constraint from user message with imperative language', () => {
    const registry = new AnchorRegistry(10_000)
    registry.processUserMessage('不要动缓存代码，只改 loop.ts', 5)
    const anchors = registry.getAnchors()

    assert.equal(anchors.length, 1)
    assert.equal(anchors[0]?.kind, 'user_constraint')
    assert.match(anchors[0]?.text ?? '', /不要动缓存代码/)
  })

  it('respects budget limit', () => {
    const registry = new AnchorRegistry(100)
    for (let index = 0; index < 20; index++) {
      registry.processUserMessage(`constraint ${index}: do not touch file${index}.ts`, index)
    }

    assert.ok(registry.estimateTokens() <= 100)
  })

  it('evicts lowest salience when over budget', () => {
    const registry = new AnchorRegistry(50)
    registry.processUserMessage('CRITICAL: never delete the database', 1)
    registry.processUserMessage('maybe use tabs instead of spaces', 2)
    registry.processUserMessage('IMPORTANT: always run tests before commit', 3)
    const texts = registry.getAnchors().map(anchor => anchor.text)

    assert.equal(texts.some(text => text.includes('never delete')), true)
    assert.equal(texts.some(text => text.includes('always run tests')), true)
  })
})
