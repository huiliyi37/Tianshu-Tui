import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { shapeSurgicalContext, LOW_CONFIDENCE_MARKER } from '../surgical-shaper.js'
import type { SurgicalBlock } from '../surgical-shaper.js'

function block(overrides: Partial<SurgicalBlock> & { id: string; filePath: string; name: string; kind: string }): SurgicalBlock {
  return { content: 'function body() {}\n', isRoot: false, score: 0, ...overrides }
}

const OPTIONS = {
  maxNodes: 30,
  maxCodeBlocks: 5,
  maxCodeBlockSize: 200,
  maxTotalChars: 50_000,
}

describe('surgical-shaper', () => {
  it('caps injected blocks at maxCodeBlocks — 30 in, only 5 kept', () => {
    const blocks: SurgicalBlock[] = Array.from({ length: 30 }, (_, i) =>
      block({ id: `b${i}`, filePath: `src/mod${i % 5}/f${i}.ts`, name: `fn${i}`, kind: 'function' }),
    )

    const result = shapeSurgicalContext(blocks, OPTIONS)

    assert.equal(result.blocks.length, 5)
    assert.equal(result.evicted.length, 25)
  })

  it('dilutes single-file monopoly — per-file cap at 20% of maxNodes', () => {
    // 12 blocks from ONE file, 18 spread across others. maxNodes=30 → per-file cap = max(5, ceil(30*0.2)) = 6.
    const monopoly: SurgicalBlock[] = Array.from({ length: 12 }, (_, i) =>
      block({ id: `m${i}`, filePath: 'src/monster.ts', name: `method${i}`, kind: 'method' }),
    )
    const spread: SurgicalBlock[] = Array.from({ length: 18 }, (_, i) =>
      block({ id: `s${i}`, filePath: `src/other${i}.ts`, name: `fn${i}`, kind: 'function' }),
    )

    const result = shapeSurgicalContext([...monopoly, ...spread], { ...OPTIONS, maxNodes: 30, maxCodeBlocks: 30 })

    const fromMonster = result.blocks.filter(b => b.filePath === 'src/monster.ts')
    assert.ok(fromMonster.length <= 6, `monster file should be diluted to ≤6, got ${fromMonster.length}`)
    assert.ok(fromMonster.length > 0, 'monster file should still keep its best roots')
  })

  it('down-weights test/sample files to 15% of budget', () => {
    // 8 test-file blocks vs 22 prod blocks. maxNodes=30 → test cap = max(3, ceil(30*0.15)) = 5.
    const tests: SurgicalBlock[] = Array.from({ length: 8 }, (_, i) =>
      block({ id: `t${i}`, filePath: `src/__tests__/spec${i}.test.ts`, name: `testSpec${i}`, kind: 'function' }),
    )
    const prods: SurgicalBlock[] = Array.from({ length: 22 }, (_, i) =>
      block({ id: `p${i}`, filePath: `src/lib/mod${i}.ts`, name: `run${i}`, kind: 'function' }),
    )

    const result = shapeSurgicalContext([...tests, ...prods], { ...OPTIONS, maxNodes: 30, maxCodeBlocks: 30 })

    const keptTests = result.blocks.filter(b => b.filePath.includes('__tests__'))
    assert.ok(keptTests.length <= 5, `test files should be capped to ≤5, got ${keptTests.length}`)
    assert.ok(keptTests.length > 0, 'test roots still kept within cap')
  })

  it('preserves roots before lower-priority kinds when budget is tight', () => {
    // Same file, 10 blocks: one root class + 9 plain methods. Per-file cap 6 → root must survive.
    const rootClass = block({ id: 'root', filePath: 'src/core.ts', name: 'CoreService', kind: 'class', isRoot: true, score: 1 })
    const methods: SurgicalBlock[] = Array.from({ length: 9 }, (_, i) =>
      block({ id: `m${i}`, filePath: 'src/core.ts', name: `helper${i}`, kind: 'method' }),
    )

    const result = shapeSurgicalContext([rootClass, ...methods], { ...OPTIONS, maxNodes: 30, maxCodeBlocks: 30 })

    const ids = result.blocks.map(b => b.id)
    assert.ok(ids.includes('root'), 'root entry point must be preserved')
    assert.equal(result.blocks.length, 6, 'per-file cap still applies')
  })

  it('emits LOW_CONFIDENCE_MARKER when query matched only weak common-word hits', () => {
    const blocks: SurgicalBlock[] = [
      block({ id: 'a', filePath: 'src/feature/thing.ts', name: 'processThing', kind: 'function' }),
      block({ id: 'b', filePath: 'src/feature/handler.ts', name: 'handleStuff', kind: 'function' }),
    ]

    const result = shapeSurgicalContext(blocks, {
      ...OPTIONS,
      maxNodes: 30,
      query: 'make the system handle data',
    })

    assert.equal(result.confidence, 'low')
    assert.ok(result.lowConfidenceNote, 'low-confidence note should be present')
    assert.ok(result.lowConfidenceNote.includes(LOW_CONFIDENCE_MARKER), 'note must carry the stable marker')
    assert.ok(result.lowConfidenceNote.includes('exact symbol'), 'note should steer toward precise symbol queries')
  })

  it('stays high-confidence when query names a distinctive identifier', () => {
    const blocks: SurgicalBlock[] = [
      block({ id: 'a', filePath: 'src/feature/ShardSearch.ts', name: 'ShardSearchRequest', kind: 'class', isRoot: true }),
      block({ id: 'b', filePath: 'src/feature/helper.ts', name: 'assembleRequest', kind: 'function' }),
    ]

    const result = shapeSurgicalContext(blocks, {
      ...OPTIONS,
      maxNodes: 30,
      query: 'ShardSearchRequest timeout handling',
    })

    assert.equal(result.confidence, 'high')
    assert.equal(result.lowConfidenceNote, null)
  })

  it('applies character budget AFTER structural shaping — truncates code blocks, not node counts', () => {
    const blocks: SurgicalBlock[] = [
      block({ id: 'a', filePath: 'src/a.ts', name: 'alpha', kind: 'function', content: 'x'.repeat(10_000) }),
      block({ id: 'b', filePath: 'src/b.ts', name: 'beta', kind: 'function', content: 'y'.repeat(10_000) }),
    ]

    const result = shapeSurgicalContext(blocks, {
      ...OPTIONS,
      maxNodes: 30,
      maxCodeBlocks: 5,
      maxCodeBlockSize: 1500,
    })

    // Both blocks survive structurally (2 ≤ 5, distinct files), but content is clipped to 1500.
    assert.equal(result.blocks.length, 2)
    for (const b of result.blocks) {
      assert.ok(b.content.length <= 1500 + 25, 'content clipped to maxCodeBlockSize (+truncation suffix)')
    }
  })

  it('skips test-file down-weighting when the query itself is test-related', () => {
    // Same shapes as the down-weight test, but isTestQuery=true → test cap is disabled.
    const tests: SurgicalBlock[] = Array.from({ length: 8 }, (_, i) =>
      block({ id: `t${i}`, filePath: `src/__tests__/spec${i}.test.ts`, name: `testSpec${i}`, kind: 'function' }),
    )
    const prods: SurgicalBlock[] = Array.from({ length: 22 }, (_, i) =>
      block({ id: `p${i}`, filePath: `src/lib/mod${i}.ts`, name: `run${i}`, kind: 'function' }),
    )

    const result = shapeSurgicalContext([...tests, ...prods], {
      ...OPTIONS, maxNodes: 30, maxCodeBlocks: 30, isTestQuery: true,
    })

    const keptTests = result.blocks.filter(b => b.filePath.includes('__tests__'))
    assert.equal(keptTests.length, 8, 'all test blocks survive when query is test-related')
  })

  it('drops tail blocks when total chars exceed maxTotalChars — char budget outranks block count', () => {
    // 3 equal-priority blocks, each 100 chars. maxTotalChars=250 → first two fit, third is evicted.
    const blocks: SurgicalBlock[] = ['a', 'b', 'c'].map((id, i) =>
      block({ id, filePath: `src/char${i}.ts`, name: `fn${id}`, kind: 'function', content: 'x'.repeat(100) }),
    )

    const result = shapeSurgicalContext(blocks, {
      ...OPTIONS, maxNodes: 30, maxCodeBlocks: 30, maxCodeBlockSize: 200, maxTotalChars: 250,
    })

    assert.equal(result.blocks.length, 2, 'only blocks that fit under the total char budget survive')
    assert.deepEqual(result.blocks.map(b => b.id), ['a', 'b'], 'kept in priority order, tail evicted')
    assert.deepEqual(result.evicted, ['c'])
  })
})
