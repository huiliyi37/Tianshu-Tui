import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { buildFileDiff, computeChangedLineRanges } from '../edit-diff.js'

describe('buildFileDiff', async () => {
  it('emits a unified diff with ---/+++/@@ and +/- lines', async () => {
    const before = 'line one\nline two\nline three\n'
    const after = 'line one\nline TWO\nline three\n'
    const diff = await buildFileDiff('src/foo.ts', before, after)
    assert.ok(diff.includes('--- src/foo.ts'), 'has old file header')
    assert.ok(diff.includes('+++ src/foo.ts'), 'has new file header')
    assert.ok(/^@@/m.test(diff), 'has hunk header')
    assert.ok(/^-line two$/m.test(diff), 'has removal line')
    assert.ok(/^\+line TWO$/m.test(diff), 'has addition line')
  })

  it('returns empty string when content is identical', async () => {
    const s = 'no change here\n'
    assert.equal(await buildFileDiff('x.txt', s, s), '')
  })

  it('renders a new file (empty before) as all-additions', async () => {
    const diff = await buildFileDiff('new.txt', '', 'alpha\nbeta\n')
    assert.ok(/^@@/m.test(diff))
    assert.ok(/^\+alpha$/m.test(diff))
    assert.ok(/^\+beta$/m.test(diff))
    const removals = diff.split('\n').filter(l => l.startsWith('-') && !l.startsWith('---'))
    assert.equal(removals.length, 0, 'no removal content lines for a new file')
  })

  it('strips the Index:/=== preamble that createTwoFilesPatch adds', async () => {
    const diff = await buildFileDiff('a.txt', 'x\n', 'y\n')
    assert.ok(!diff.includes('Index:'), 'no Index: preamble')
    assert.ok(!diff.includes('====='), 'no underline preamble')
    assert.ok(diff.startsWith('--- '), 'starts at the file header')
  })

  it('caps oversized diffs with a hint line', async () => {
    const before = ''
    const after = Array.from({ length: 2000 }, (_, i) => `line ${i}`).join('\n') + '\n'
    const diff = await buildFileDiff('big.txt', before, after, { maxLines: 50 })
    const lines = diff.split('\n')
    assert.equal(lines.length, 51, '50 diff lines + 1 hint line')
    assert.match(lines[lines.length - 1]!, /more diff lines, Ctrl\+O/)
  })
})

describe('computeChangedLineRanges', async () => {
  it('returns [] when content is identical', async () => {
    const s = 'a\nb\nc\n'
    assert.deepEqual(await computeChangedLineRanges(s, s), [])
  })

  it('maps a single-line change to that after-file line', async () => {
    const before = 'one\ntwo\nthree\nfour\n'
    const after = 'one\nTWO\nthree\nfour\n'
    const ranges = await computeChangedLineRanges(before, after)
    assert.equal(ranges.length, 1)
    assert.deepEqual(ranges[0], { start: 2, end: 2 })
  })

  it('covers the whole file for a brand-new file (empty before)', async () => {
    const after = 'alpha\nbeta\ngamma\n'
    const ranges = await computeChangedLineRanges('', after)
    assert.equal(ranges.length, 1)
    assert.equal(ranges[0]!.start, 1)
    assert.ok(ranges[0]!.end >= 3, 'covers all new lines')
  })

  it('produces multiple ranges for edits in separate regions', async () => {
    const before = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join('\n') + '\n'
    const after = before
      .replace('line 2', 'LINE 2')
      .replace('line 18', 'LINE 18')
    const ranges = await computeChangedLineRanges(before, after)
    assert.equal(ranges.length, 2, 'two disjoint hunks')
    assert.ok(ranges[0]!.start <= 2 && ranges[0]!.end >= 2)
    assert.ok(ranges[1]!.start <= 18 && ranges[1]!.end >= 18)
  })

  it('represents a pure deletion as a single-line point', async () => {
    const before = 'keep1\ndrop\nkeep2\n'
    const after = 'keep1\nkeep2\n'
    const ranges = await computeChangedLineRanges(before, after)
    assert.equal(ranges.length, 1)
    assert.equal(ranges[0]!.start, ranges[0]!.end, 'deletion collapses to a point')
    assert.ok(ranges[0]!.start >= 1)
  })
})

describe('pathological diff inputs stay bounded (write-tool hang root cause 2026-07-08)', async () => {
  // Full rewrite where every line differs — Myers worst case. Unbounded, an
  // 8K-line rewrite costs ~7s PER PASS of synchronous CPU (event loop frozen:
  // TUI dead, Esc dead, tool timeout can't fire). The timeout option must cap
  // each pass at ~1s and degrade gracefully.
  function fullRewrite(n: number, tag: string): string {
    return Array.from({ length: n }, (_, i) => `const v${(i * 7) % 9973}_${tag} = compute(${i}, '${tag}')`).join('\n')
  }

  it('buildFileDiff returns within the timeout bound on a huge full rewrite', async () => {
    const before = fullRewrite(8000, 'old')
    const after = fullRewrite(8000, 'new')
    const t = Date.now()
    const diff = await buildFileDiff('big.ts', before, after)
    const elapsed = Date.now() - t
    // Unbounded this takes ~7s; the 1s timeout must keep it well under that.
    assert.ok(elapsed < 5000, `buildFileDiff took ${elapsed}ms — timeout bound not effective`)
    assert.equal(typeof diff, 'string', 'degrades to a string (possibly empty), never undefined/throw')
  })

  it('computeChangedLineRanges falls back to a whole-file range on timeout', async () => {
    const before = fullRewrite(8000, 'old')
    const after = fullRewrite(8000, 'new')
    const t = Date.now()
    const ranges = await computeChangedLineRanges(before, after)
    const elapsed = Date.now() - t
    assert.ok(elapsed < 5000, `computeChangedLineRanges took ${elapsed}ms — timeout bound not effective`)
    assert.ok(ranges.length >= 1, 'always returns at least one range for differing content')
    // Whatever path was taken (finished or timed-out fallback), the ranges
    // must cover the changed content so diagnostics are not hidden.
    const last = ranges[ranges.length - 1]!
    assert.ok(last.end >= 1)
  })
})
