import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { buildFileDiff } from '../edit-diff.js'

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
