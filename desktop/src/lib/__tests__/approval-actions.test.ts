import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { getApprovalActionProps } from '../approval-preview.js'

describe('getApprovalActionProps', () => {
  it('renders approve as primary action', () => {
    const props = getApprovalActionProps('approve')
    assert.ok(props.variant.includes('primary'), 'approve is primary')
    assert.equal(props.label, '批准')
  })

  it('renders reject as danger ghost action', () => {
    const props = getApprovalActionProps('reject')
    assert.ok(props.variant.includes('danger'), 'reject is danger')
    assert.ok(props.variant.includes('ghost'), 'reject is ghost')
    assert.equal(props.label, '拒绝')
  })

  it('renders edit as neutral ghost action', () => {
    const props = getApprovalActionProps('edit')
    assert.ok(props.variant.includes('ghost'), 'edit is ghost')
    assert.ok(!props.variant.includes('danger'), 'edit is not danger')
    assert.ok(!props.variant.includes('primary'), 'edit is not primary')
    assert.equal(props.label, '编辑')
  })

  it('switches approve and edit labels when editing', () => {
    assert.equal(getApprovalActionProps('approve', true).label, '应用并批准')
    assert.equal(getApprovalActionProps('edit', true).label, '取消编辑')
  })
})
