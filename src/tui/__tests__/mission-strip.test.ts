import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { formatMissionStrip } from '../mission.js'
import type { CognitivePhaseSnapshot } from '../../context/cognitive-ledger.js'

function makeSnapshot(overrides: Partial<CognitivePhaseSnapshot> = {}): CognitivePhaseSnapshot {
  return {
    contractStatus: 'executing',
    objective: 'fix auth bug in src/auth.ts',
    scopeFileCount: 1,
    isActionableTask: true,
    hasVerificationGap: true,
    deliveryStatus: 'unverified',
    ...overrides,
  }
}

describe('formatMissionStrip', () => {
  it('returns null without snapshot', () => {
    assert.equal(formatMissionStrip(undefined), null)
  })

  it('returns null for non-actionable task', () => {
    assert.equal(formatMissionStrip(makeSnapshot({ isActionableTask: false })), null)
  })

  it('returns null without objective', () => {
    assert.equal(formatMissionStrip(makeSnapshot({ objective: undefined })), null)
  })

  it('formats mission status, objective, scope count, and verification gap', () => {
    const text = formatMissionStrip(makeSnapshot())
    assert.equal(text, '天契 行 · fix auth bug in src/auth.ts · 1 file · 未验')
  })

  it('pluralizes file count', () => {
    const text = formatMissionStrip(makeSnapshot({ scopeFileCount: 3, hasVerificationGap: false, deliveryStatus: 'verified' }))
    assert.match(text!, /3 files/)
    assert.match(text!, /已验$/)
  })

  it('truncates long objective', () => {
    const text = formatMissionStrip(makeSnapshot({ objective: 'x'.repeat(80) }))
    assert.ok(text!.includes('…'))
    assert.ok(text!.length < 90)
  })

  it('maps blocked status and delivery state', () => {
    const text = formatMissionStrip(makeSnapshot({ contractStatus: 'blocked', hasVerificationGap: false, deliveryStatus: 'blocked' }))
    assert.match(text!, /^天契 阻/)
    assert.match(text!, /受阻$/)
  })
})
