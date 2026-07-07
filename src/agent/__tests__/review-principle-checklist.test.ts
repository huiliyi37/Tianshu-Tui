import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { buildReviewPrincipleChecklist, extractReviewPrinciples } from '../review-principle-checklist.js'

const MEMORY = `### 2026-05-27 — Real-Time Systems Need Boundary Clarity Before Speed

**Kind**: architectural_invariant / review_principle

**Claim**: 实时系统的敌人不是慢，而是边界模糊；审查的价值不是否定实现，而是让每个边界在出错前被看见。

**Applies when**:
- designing real-time token/delta streaming
- reviewing deduplication or suppression logic

**Review rule**:
Do not declare a streamed response duplicate in the middle of the stream.

**Evidence**:
- \`src/agent/turn-stream.ts\`
- \`src/agent/loop.ts\`
`

describe('review-principle-checklist', () => {
  it('extracts review principles from curated memory entries', () => {
    const principles = extractReviewPrinciples(MEMORY)
    assert.equal(principles.length, 1)
    assert.equal(principles[0]?.title, 'Real-Time Systems Need Boundary Clarity Before Speed')
    assert.match(principles[0]?.claim ?? '', /边界模糊/)
    assert.match(principles[0]?.reviewRule ?? '', /middle of the stream/)
  })

  it('builds checklist items when changed files match evidence paths', () => {
    const items = buildReviewPrincipleChecklist({
      knowledgeMarkdown: MEMORY,
      changedFiles: ['src/agent/loop.ts'],
    })
    assert.equal(items.length, 1)
    assert.match(items[0]?.question ?? '', /streamed response duplicate/)
    assert.equal(items[0]?.source, 'Real-Time Systems Need Boundary Clarity Before Speed')
  })

  it('does not emit checklist items for unrelated changed files', () => {
    const items = buildReviewPrincipleChecklist({
      knowledgeMarkdown: MEMORY,
      changedFiles: ['src/config/schema.ts'],
    })
    assert.deepEqual(items, [])
  })

  it('respects maxItems limit', () => {
    const bigMemory = Array.from({ length: 10 }, (_, i) =>
      `### 2026-05-27 — Principle ${i}\n\n**Kind**: review_principle\n\n**Claim**: Claim ${i}\n\n**Evidence**:\n- \`src/a.ts\`\n`
    ).join('\n')

    const items = buildReviewPrincipleChecklist({
      knowledgeMarkdown: bigMemory,
      changedFiles: ['src/a.ts'],
      maxItems: 3,
    })
    assert.equal(items.length, 3)
  })

  it('ignores entries without review_principle kind', () => {
    const memory = `### 2026-05-27 — Some Insight

**Kind**: convergence_insight

**Claim**: This is not a review principle.

**Evidence**:
- \`src/a.ts\`
`
    const items = buildReviewPrincipleChecklist({
      knowledgeMarkdown: memory,
      changedFiles: ['src/a.ts'],
    })
    assert.deepEqual(items, [])
  })
})
