import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_MODE, parsePromptMode, shouldInjectCvm, shouldInjectDynamicAppendix } from '../mode.js'

describe('PromptMode', () => {
  it('defaults to task mode', () => {
    assert.equal(DEFAULT_MODE, 'task')
  })

  it('injects CVM and dynamic appendix only in task mode', () => {
    assert.equal(shouldInjectCvm('task'), true)
    assert.equal(shouldInjectDynamicAppendix('task'), true)
    assert.equal(shouldInjectCvm('chat'), false)
    assert.equal(shouldInjectDynamicAppendix('chat'), false)
  })

  it('parses supported modes', () => {
    assert.equal(parsePromptMode('chat'), 'chat')
    assert.equal(parsePromptMode('task'), 'task')
    assert.equal(parsePromptMode('other'), null)
    assert.equal(parsePromptMode(undefined), null)
  })
})
