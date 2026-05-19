import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { shouldTriggerCourage } from '../hooks/courage-hook.js'

describe('CourageHook', () => {
  it('triggers on failed tool signals', () => {
    assert.equal(shouldTriggerCourage([
      { tool: 'bash', target: 'tsc', status: 'failed' },
    ], 0.3), true)
  })

  it('triggers on risky target text', () => {
    assert.equal(shouldTriggerCourage([
      { tool: 'bash', target: 'Type error in foo.ts', status: 'success' },
    ], 0.3), true)
  })

  it('does not trigger on success', () => {
    assert.equal(shouldTriggerCourage([
      { tool: 'bash', target: 'npm test', status: 'success' },
    ], 0.3), false)
  })

  it('does not trigger on empty history', () => {
    assert.equal(shouldTriggerCourage([], 0.5), false)
  })
})
