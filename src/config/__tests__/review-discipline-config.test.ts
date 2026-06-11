import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { isReviewDisciplineEnabled } from '../review-discipline-config.js'

const KEY = 'RIVET_REVIEW_DISCIPLINE'

describe('isReviewDisciplineEnabled', () => {
  let saved: string | undefined

  beforeEach(() => { saved = process.env[KEY]; delete process.env[KEY] })
  afterEach(() => { if (saved !== undefined) process.env[KEY] = saved; else delete process.env[KEY] })

  it('defaults to disabled when env is unset', () => {
    assert.equal(isReviewDisciplineEnabled(), false)
  })

  const enabledValues = ['1', 'true', 'on', 'yes', 'TRUE', 'ON', 'YES', ' 1 ', ' true ']
  for (const val of enabledValues) {
    it(`returns true for RIVET_REVIEW_DISCIPLINE="${val}"`, () => {
      process.env[KEY] = val
      assert.equal(isReviewDisciplineEnabled(), true)
    })
  }

  it('returns false for RIVET_REVIEW_DISCIPLINE=0', () => {
    process.env[KEY] = '0'
    assert.equal(isReviewDisciplineEnabled(), false)
  })

  it('returns false for RIVET_REVIEW_DISCIPLINE=false', () => {
    process.env[KEY] = 'false'
    assert.equal(isReviewDisciplineEnabled(), false)
  })

  it('returns false for any unrecognized value', () => {
    process.env[KEY] = 'whatever'
    assert.equal(isReviewDisciplineEnabled(), false)
  })
})
