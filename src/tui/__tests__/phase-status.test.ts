import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { phaseStatusLabel } from '../phase-status.js'

describe('S3: phaseStatusLabel', () => {
  // --- 已有 phase（必须覆盖，否则被吞）---
  it('maps heartbeat with reason', () => {
    assert.equal(phaseStatusLabel('heartbeat', { reason: 'still working — last activity: read_file (20s ago)' }),
      'still working — last activity: read_file (20s ago)')
  })
  it('maps heartbeat without reason', () => {
    assert.equal(phaseStatusLabel('heartbeat'), 'still working')
  })
  it('maps intent-veto with reason', () => {
    assert.equal(phaseStatusLabel('intent-veto', { reason: 'user vetoed intent' }), 'user vetoed intent')
  })
  it('maps intent-veto without reason', () => {
    assert.equal(phaseStatusLabel('intent-veto'), 'intent vetoed')
  })

  // --- 新增 phase ---
  it('maps preparing', () => {
    assert.equal(phaseStatusLabel('preparing'), 'preparing…')
  })
  it('maps working with reason', () => {
    assert.equal(phaseStatusLabel('working', { reason: 'waiting for first token' }), 'waiting for first token')
  })
  it('maps working without reason', () => {
    assert.equal(phaseStatusLabel('working'), 'working…')
  })
  it('maps tool-hint with tool name', () => {
    assert.equal(phaseStatusLabel('tool-hint', { tool: 'read_file' }), 'preparing read_file…')
  })
  it('maps tool-hint without tool name', () => {
    assert.equal(phaseStatusLabel('tool-hint'), 'preparing…')
  })

  // --- 未知 phase → null（不覆盖 heartbeatStatus）---
  it('returns null for unmapped phases', () => {
    assert.equal(phaseStatusLabel('tianshu-planning'), null)
    assert.equal(phaseStatusLabel('random'), null)
  })
})
