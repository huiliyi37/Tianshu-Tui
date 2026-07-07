import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { isReviewDisciplineEnabled } from '../review-discipline-config.js'

const KEY = 'RIVET_REVIEW_DISCIPLINE'

describe('isReviewDisciplineEnabled', () => {
  let saved: string | undefined

  beforeEach(() => { saved = process.env[KEY]; delete process.env[KEY] })
  afterEach(() => { if (saved !== undefined) process.env[KEY] = saved; else delete process.env[KEY] })

  it('defaults to enabled when env is unset (auto review is fail-open)', () => {
    assert.equal(isReviewDisciplineEnabled(), true)
  })

  const enabledValues = ['1', 'true', 'on', 'yes', 'TRUE', 'ON', 'YES', ' 1 ', ' true ']
  for (const val of enabledValues) {
    it(`returns true for RIVET_REVIEW_DISCIPLINE="${val}"`, () => {
      process.env[KEY] = val
      assert.equal(isReviewDisciplineEnabled(), true)
    })
  }

  const disabledValues = ['0', 'false', 'off', 'no', 'FALSE', 'OFF', ' 0 ']
  for (const val of disabledValues) {
    it(`returns false for RIVET_REVIEW_DISCIPLINE="${val}"`, () => {
      process.env[KEY] = val
      assert.equal(isReviewDisciplineEnabled(), false)
    })
  }

  it('treats unrecognized values as enabled (only explicit off disables)', () => {
    process.env[KEY] = 'whatever'
    assert.equal(isReviewDisciplineEnabled(), true)
  })
})
