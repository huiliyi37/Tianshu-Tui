import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { classifyMcpError } from '../failure-classifier.js'

describe('classifyMcpError', () => {
  it('classifies ENOENT as config error', () => {
    const result = classifyMcpError(new Error('spawn server ENOENT'))
    assert.equal(result.class, 'config')
    assert.equal(result.retryable, false)
  })

  it('classifies 401 as auth error', () => {
    const result = classifyMcpError(new Error('401 Unauthorized'))
    assert.equal(result.class, 'auth')
    assert.equal(result.retryable, false)
  })

  it('classifies ECONNREFUSED as network error', () => {
    const result = classifyMcpError(new Error('connect ECONNREFUSED 127.0.0.1:3000'))
    assert.equal(result.class, 'network')
    assert.equal(result.retryable, true)
  })

  it('classifies socket hang up as network error', () => {
    const result = classifyMcpError(new Error('socket hang up'))
    assert.equal(result.class, 'network')
    assert.equal(result.retryable, true)
  })

  it('classifies InvalidParams as protocol error', () => {
    const result = classifyMcpError(new Error('InvalidParams: missing required field'))
    assert.equal(result.class, 'protocol')
    assert.equal(result.retryable, false)
  })

  it('classifies unknown error as tool_error', () => {
    const result = classifyMcpError(new Error('Something went wrong in the tool'))
    assert.equal(result.class, 'tool_error')
    assert.equal(result.retryable, false)
  })

  it('handles non-Error input', () => {
    const result = classifyMcpError('string error')
    assert.equal(result.class, 'tool_error')
  })

  it('handles null/undefined input', () => {
    const result = classifyMcpError(null)
    assert.equal(result.class, 'tool_error')
  })
})
