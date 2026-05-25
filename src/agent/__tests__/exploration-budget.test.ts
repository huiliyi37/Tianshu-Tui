import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { workOrderScopeSchema } from '../work-order.js'

describe('exploration scope budget', () => {
  it('accepts maxFiles and maxTokens in scope', () => {
    const scope = {
      files: ['src/agent/coordinator.ts'],
      maxFiles: 20,
      maxTokens: 200_000,
    }
    const parsed = workOrderScopeSchema.parse(scope)
    assert.equal(parsed.maxFiles, 20)
    assert.equal(parsed.maxTokens, 200_000)
  })

  it('rejects negative maxFiles', () => {
    assert.throws(() => {
      workOrderScopeSchema.parse({ maxFiles: -1 })
    })
  })

  it('rejects maxTokens below 1000', () => {
    assert.throws(() => {
      workOrderScopeSchema.parse({ maxTokens: 500 })
    })
  })

  it('omits budget fields when not provided (defaults)', () => {
    const parsed = workOrderScopeSchema.parse({ files: ['a.ts'] })
    assert.equal(parsed.maxFiles, undefined)
    assert.equal(parsed.maxTokens, undefined)
  })
})
