import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { getTheme } from '../theme.js'
import {
  buildPlanReviewActions,
  clampPlanReviewScroll,
  formatPlanReview,
  formatPlanReviewDate,
  planReviewBodyRows,
  recommendedPlanReviewAction,
} from '../format/plan-review.js'

const theme = getTheme()
const stripAnsi = (s: string): string => s.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '')
const plain = (lines: string[]): string => lines.map(stripAnsi).join('\n')

const actions = buildPlanReviewActions({ slug: 'fix-cache', title: '修缓存' })

describe('formatPlanReviewDate', () => {
  it('uses local calendar day', () => {
    assert.equal(formatPlanReviewDate(new Date(2026, 7, 26, 23, 30)), '2026-08-26')
  })
})

describe('planReviewBodyRows / clampPlanReviewScroll', () => {
  it('clamps body window between 4 and 10', () => {
    assert.equal(planReviewBodyRows(16), 4)
    assert.equal(planReviewBodyRows(24), 10)
    assert.equal(planReviewBodyRows(40), 10)
  })

  it('clamps scroll to remaining lines', () => {
    assert.equal(clampPlanReviewScroll(-3, 20, 6), 0)
    assert.equal(clampPlanReviewScroll(99, 20, 6), 14)
    assert.equal(clampPlanReviewScroll(2, 5, 6), 0)
  })
})

describe('buildPlanReviewActions', () => {
  it('single-option plan has approve + two rejects', () => {
    assert.deepEqual(actions.map(a => a.id), ['approve', 'reject', 'reject-exit'])
    assert.equal(recommendedPlanReviewAction(actions)?.id, 'approve')
  })

  it('multi-option plan lists each approach as approve', () => {
    const multi = buildPlanReviewActions({
      slug: 'x',
      title: 't',
      options: [
        { label: 'Manual', description: 'a' },
        { label: 'Auto (Recommended)', description: 'b' },
      ],
    })
    assert.equal(multi[0]!.id, 'approve:0')
    assert.equal(multi[1]!.id, 'approve:1')
    assert.equal(recommendedPlanReviewAction(multi)?.id, 'approve:1')
  })
})

describe('formatPlanReview', () => {
  const body = ['# 修缓存', '', '第一步', '第二步', '第三步', '第四步', '第五步', '第六步'].join('\n')

  it('shows title, date, body, and decision marks', () => {
    const text = plain(formatPlanReview({
      title: '修缓存',
      date: '2026-08-26',
      body,
      width: 80,
      bodyRows: 8,
      actions,
    }, theme))
    assert.match(text, /计划审批/)
    assert.match(text, /「修缓存」/)
    assert.match(text, /2026-08-26/)
    assert.match(text, /修缓存/)
    assert.match(text, /✓ 1 批准并执行/)
    assert.match(text, /✗ 2 驳回修订/)
    assert.match(text, /✗ 3 驳回并退出/)
    assert.doesNotMatch(text, /低阶/)
    assert.doesNotMatch(text, /cheap/i)
    assert.doesNotMatch(text, /Model:/)
  })

  it('scroll advances the window and shows overflow', () => {
    const lines = Array.from({ length: 20 }, (_, i) => `行${i}`).join('\n')
    const a = plain(formatPlanReview({
      title: 't', date: '2026-08-26', body: lines, width: 80, bodyRows: 6, scroll: 0, actions,
    }, theme))
    const b = plain(formatPlanReview({
      title: 't', date: '2026-08-26', body: lines, width: 80, bodyRows: 6, scroll: 5, actions,
    }, theme))
    assert.match(a, /行0/)
    assert.doesNotMatch(a, /行19/)
    assert.match(a, /…\(\+/)
    assert.match(b, /行5/)
    assert.doesNotMatch(b, /行0/)
  })

  it('feedback mode hides numbered actions', () => {
    const text = plain(formatPlanReview({
      title: 't', body: 'hello', width: 80, actions, feedbackMode: true,
    }, theme))
    assert.match(text, /反馈输入中/)
    assert.doesNotMatch(text, /批准并执行/)
  })

  it('narrow width still keeps header and first action', () => {
    const text = plain(formatPlanReview({
      title: '很窄', date: '2026-08-26', body: '一行', width: 24, bodyRows: 4, actions,
    }, theme))
    assert.match(text, /计划审批/)
    assert.match(text, /批准/)
  })
})
