import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { buildReviewPayload } from '../gh-cli.js'

describe('buildReviewPayload', () => {
  it('passes the verdict event through', () => {
    for (const event of ['APPROVE', 'REQUEST_CHANGES', 'COMMENT'] as const) {
      const p = buildReviewPayload({ event, body: '', comments: [] })
      assert.equal(p.event, event)
    }
  })

  it('includes a trimmed summary body only when non-empty', () => {
    assert.equal(buildReviewPayload({ event: 'COMMENT', body: '   ', comments: [] }).body, undefined)
    assert.equal(buildReviewPayload({ event: 'COMMENT', body: '  hi  ', comments: [] }).body, 'hi')
  })

  it('maps a new-side (addition/context) comment to RIGHT + newLine', () => {
    const p = buildReviewPayload({
      event: 'COMMENT',
      body: '',
      comments: [{ path: 'src/foo.ts', newLine: 42, body: 'nit' }],
    })
    assert.deepEqual(p.comments, [{ path: 'src/foo.ts', line: 42, side: 'RIGHT', body: 'nit' }])
  })

  it('maps an old-side (deletion) comment to LEFT + oldLine', () => {
    const p = buildReviewPayload({
      event: 'REQUEST_CHANGES',
      body: '',
      comments: [{ path: 'src/foo.ts', oldLine: 7, body: 'why remove?' }],
    })
    assert.deepEqual(p.comments, [{ path: 'src/foo.ts', line: 7, side: 'LEFT', body: 'why remove?' }])
  })

  it('prefers newLine (RIGHT) when both old and new are present (context line)', () => {
    const p = buildReviewPayload({
      event: 'COMMENT',
      body: '',
      comments: [{ path: 'a.ts', oldLine: 3, newLine: 5, body: 'ctx' }],
    })
    assert.deepEqual(p.comments, [{ path: 'a.ts', line: 5, side: 'RIGHT', body: 'ctx' }])
  })

  it('drops comments missing a path, a line anchor, or a body', () => {
    const p = buildReviewPayload({
      event: 'COMMENT',
      body: 'summary',
      comments: [
        { path: '', newLine: 1, body: 'no path' },
        { path: 'a.ts', body: 'no line' },
        { path: 'a.ts', newLine: 2, body: '   ' },
        { path: 'a.ts', newLine: 9, body: 'keep me' },
      ],
    })
    assert.deepEqual(p.comments, [{ path: 'a.ts', line: 9, side: 'RIGHT', body: 'keep me' }])
  })

  it('omits the comments field entirely when none survive filtering', () => {
    const p = buildReviewPayload({ event: 'APPROVE', body: 'LGTM', comments: [] })
    assert.equal(p.comments, undefined)
    assert.equal(p.body, 'LGTM')
    assert.equal(p.event, 'APPROVE')
  })
})
