import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  shouldAutoCollapseReview,
  REVIEW_AUTO_COLLAPSE_WIDTH,
  REVIEW_MIN_WIDTH_PX,
  clampReview,
  clampSidebar,
} from '../panel-layout.js'

describe('shouldAutoCollapseReview', () => {
  it('collapses when workspace is narrower than threshold', () => {
    assert.equal(shouldAutoCollapseReview(REVIEW_AUTO_COLLAPSE_WIDTH - 1, 300), true)
  })

  it('collapses when review panel is squeezed below minimum width', () => {
    assert.equal(shouldAutoCollapseReview(1200, REVIEW_MIN_WIDTH_PX - 1), true)
  })

  it('stays open when workspace and review panel are wide enough', () => {
    assert.equal(shouldAutoCollapseReview(REVIEW_AUTO_COLLAPSE_WIDTH, REVIEW_MIN_WIDTH_PX), false)
    assert.equal(shouldAutoCollapseReview(1200, 300), false)
  })
})

describe('panel clamp helpers', () => {
  it('clamps review width within bounds', () => {
    assert.equal(clampReview(10), 15)
    assert.equal(clampReview(50), 45)
    assert.equal(clampReview(26), 26)
  })

  it('clamps sidebar width within bounds', () => {
    assert.equal(clampSidebar(5), 12)
    assert.equal(clampSidebar(40), 35)
    assert.equal(clampSidebar(16), 16)
  })
})
