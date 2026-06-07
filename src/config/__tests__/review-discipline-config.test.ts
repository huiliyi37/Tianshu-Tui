import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { isReviewDisciplineEnabled } from '../review-discipline-config.js'

const KEY = 'RIVET_REVIEW_DISCIPLINE'

describe('isReviewDisciplineEnabled', () => {
  let saved: string | undefined

  beforeEach(() => { saved = process.env[KEY]; delete process.env[KEY] })
  afterEach(() => { if (saved !== undefined) process.env[KEY] = saved; else delete process.env[KEY] })

  it('defaults to enabled when env is unset', () => {
    assert.equal(isReviewDisciplineEnabled(), true)
  })

  const disabledValues = ['0', 'false', 'off', 'no', 'FALSE', 'OFF', 'NO', ' 0 ', ' false ']
  for (const val of disabledValues) {
    it(`returns false for RIVET_REVIEW_DISCIPLINE="${val}"`, () => {
      process.env[KEY] = val
      assert.equal(isReviewDisciplineEnabled(), false)
    })
  }

  it('returns true for RIVET_REVIEW_DISCIPLINE=1', () => {
    process.env[KEY] = '1'
    assert.equal(isReviewDisciplineEnabled(), true)
  })

  it('returns true for RIVET_REVIEW_DISCIPLINE=true', () => {
    process.env[KEY] = 'true'
    assert.equal(isReviewDisciplineEnabled(), true)
  })

  it('returns true for any unrecognized value', () => {
    process.env[KEY] = 'whatever'
    assert.equal(isReviewDisciplineEnabled(), true)
  })
})
