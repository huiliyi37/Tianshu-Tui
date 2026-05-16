import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { type ApprovalResult, applyApprovalEdit } from '../agent/approval-edit.js'

describe('applyApprovalEdit', () => {
  it('returns original input when approved without edit', () => {
    const result: ApprovalResult = { approved: true }
    const input = { command: 'npm test' }
    assert.deepEqual(applyApprovalEdit(input, result), { command: 'npm test' })
  })

  it('returns edited input when approved with edit', () => {
    const result: ApprovalResult = { approved: true, editedInput: { command: 'npm test -- --watch' } }
    const input = { command: 'npm test' }
    assert.deepEqual(applyApprovalEdit(input, result), { command: 'npm test -- --watch' })
  })

  it('returns null when denied', () => {
    const result: ApprovalResult = { approved: false }
    const input = { command: 'rm -rf /' }
    assert.equal(applyApprovalEdit(input, result), null)
  })
})
