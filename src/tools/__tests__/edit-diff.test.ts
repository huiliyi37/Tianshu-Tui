import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { buildFileDiff, computeChangedLineRanges } from '../edit-diff.js'

describe('buildFileDiff', () => {
  it('emits a unified diff with ---/+++/@@ and +/- lines', () => {
    const before = 'line one\nline two\nline three\n'
    const after = 'line one\nline TWO\nline three\n'
    const diff = buildFileDiff('src/foo.ts', before, after)
    assert.ok(diff.includes('--- src/foo.ts'), 'has old file header')
    assert.ok(diff.includes('+++ src/foo.ts'), 'has new file header')
    assert.ok(/^@@/m.test(diff), 'has hunk header')
    assert.ok(/^-line two$/m.test(diff), 'has removal line')
    assert.ok(/^\+line TWO$/m.test(diff), 'has addition line')
  })

  it('returns empty string when content is identical', () => {
    const s = 'no change here\n'
    assert.equal(buildFileDiff('x.txt', s, s), '')
  })

  it('renders a new file (empty before) as all-additions', () => {
    const diff = buildFileDiff('new.txt', '', 'alpha\nbeta\n')
    assert.ok(/^@@/m.test(diff))
    assert.ok(/^\+alpha$/m.test(diff))
    assert.ok(/^\+beta$/m.test(diff))
    const removals = diff.split('\n').filter(l => l.startsWith('-') && !l.startsWith('---'))
    assert.equal(removals.length, 0, 'no removal content lines for a new file')
  })

  it('strips the Index:/=== preamble that createTwoFilesPatch adds', () => {
    const diff = buildFileDiff('a.txt', 'x\n', 'y\n')
    assert.ok(!diff.includes('Index:'), 'no Index: preamble')
    assert.ok(!diff.includes('====='), 'no underline preamble')
    assert.ok(diff.startsWith('--- '), 'starts at the file header')
  })

  it('caps oversized diffs with a hint line', () => {
    const before = ''
    const after = Array.from({ length: 2000 }, (_, i) => `line ${i}`).join('\n') + '\n'
    const diff = buildFileDiff('big.txt', before, after, { maxLines: 50 })
    const lines = diff.split('\n')
    assert.equal(lines.length, 51, '50 diff lines + 1 hint line')
    assert.match(lines[lines.length - 1]!, /more diff lines, Ctrl\+O/)
  })
})

describe('computeChangedLineRanges', () => {
  it('returns [] when content is identical', () => {
    const s = 'a\nb\nc\n'
    assert.deepEqual(computeChangedLineRanges(s, s), [])
  })

  it('maps a single-line change to that after-file line', () => {
    const before = 'one\ntwo\nthree\nfour\n'
    const after = 'one\nTWO\nthree\nfour\n'
    const ranges = computeChangedLineRanges(before, after)
    assert.equal(ranges.length, 1)
    assert.deepEqual(ranges[0], { start: 2, end: 2 })
  })

  it('covers the whole file for a brand-new file (empty before)', () => {
    const after = 'alpha\nbeta\ngamma\n'
    const ranges = computeChangedLineRanges('', after)
    assert.equal(ranges.length, 1)
    assert.equal(ranges[0]!.start, 1)
    assert.ok(ranges[0]!.end >= 3, 'covers all new lines')
  })

  it('produces multiple ranges for edits in separate regions', () => {
    const before = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join('\n') + '\n'
    const after = before
      .replace('line 2', 'LINE 2')
      .replace('line 18', 'LINE 18')
    const ranges = computeChangedLineRanges(before, after)
    assert.equal(ranges.length, 2, 'two disjoint hunks')
    assert.ok(ranges[0]!.start <= 2 && ranges[0]!.end >= 2)
    assert.ok(ranges[1]!.start <= 18 && ranges[1]!.end >= 18)
  })

  it('represents a pure deletion as a single-line point', () => {
    const before = 'keep1\ndrop\nkeep2\n'
    const after = 'keep1\nkeep2\n'
    const ranges = computeChangedLineRanges(before, after)
    assert.equal(ranges.length, 1)
    assert.equal(ranges[0]!.start, ranges[0]!.end, 'deletion collapses to a point')
    assert.ok(ranges[0]!.start >= 1)
  })
})
