import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { levenshtein, didYouMean, didYouMeanHint } from '../did-you-mean.js'

describe('levenshtein', () => {
  it('returns 0 for identical strings', () => {
    assert.equal(levenshtein('task', 'task'), 0)
    assert.equal(levenshtein('', ''), 0)
  })

  it('returns length of non-empty string against empty', () => {
    assert.equal(levenshtein('abc', ''), 3)
    assert.equal(levenshtein('', 'abc'), 3)
  })

  it('counts single edits correctly', () => {
    assert.equal(levenshtein('task', 'takk'), 1) // substitute
    assert.equal(levenshtein('task', 'tasks'), 1) // insert
    assert.equal(levenshtein('task', 'tas'), 1) // delete
    assert.equal(levenshtein('task', 'desk'), 2) // substitute x2
  })

  it('handles the classic case', () => {
    assert.equal(levenshtein('kitten', 'sitting'), 3)
  })

  it('is case-sensitive (caller decides normalization)', () => {
    assert.equal(levenshtein('TASK', 'task'), 4)
  })
})

describe('didYouMean', () => {
  const TOOLS = ['read_file', 'write_file', 'edit_file', 'grep', 'glob', 'delegate_task', 'delegate_batch']

  it('finds the obvious near-match for a Cursor-style hallucination', () => {
    // The session 6176a17f trigger: model called "task" wanting delegate_task.
    const out = didYouMean('task', TOOLS)
    assert.deepEqual(out.slice(0, 1), ['delegate_task'])
  })

  it('finds near-matches for a typo (single character drop)', () => {
    const out = didYouMean('delegte_task', TOOLS)
    assert.ok(out.includes('delegate_task'), `expected delegate_task in ${JSON.stringify(out)}`)
  })

  it('finds near-matches for a transposed name', () => {
    const out = didYouMean('delegate_taks', TOOLS)
    assert.ok(out.includes('delegate_task'))
  })

  it('finds near-matches for a sibling-tool name', () => {
    const out = didYouMean('grep_file', TOOLS)
    assert.ok(out.includes('grep'))
  })

  it('returns empty when nothing is close enough', () => {
    const out = didYouMean('xyzpdq', TOOLS)
    assert.deepEqual(out, [])
  })

  it('caps at topK', () => {
    // Use a typo that hits multiple candidates — `read_fiel` is 1 edit from
    // `read_file` and 2 edits from `read_section`. topK=1 picks the closest.
    const out = didYouMean('read_fiel', TOOLS, { topK: 1 })
    assert.equal(out.length, 1)
    assert.equal(out[0], 'read_file')
  })

  it('respects custom maxDistance', () => {
    // Use an input that has no substring relationship with any candidate,
    // so maxDistance=0 zeroes out the Levenshtein pass cleanly. (Substring
    // fallback is a separate concern and tested below.)
    const out = didYouMean('xyzpdq_lmno_rst', TOOLS, { maxDistance: 0 })
    assert.deepEqual(out, [])
  })

  it('substring fallback hits when Levenshtein misses', () => {
    // 'task' is too far from 'delegate_task' for Levenshtein, but it's a
    // suffix of it — substring fallback catches this.
    const out = didYouMean('task', TOOLS)
    assert.ok(out.includes('delegate_task'), `expected delegate_task in ${JSON.stringify(out)}`)
  })

  it('returns at most topK in ascending distance order', () => {
    const out = didYouMean('read_file', ['read_file', 'read_fiel', 'reed_file'], { topK: 2 })
    assert.equal(out.length, 2)
    // read_fiel and reed_file both have distance 2; stable sort by name
    assert.equal(out[0], 'read_file')
  })
})

describe('didYouMeanHint', () => {
  const TOOLS = ['read_file', 'delegate_task', 'grep']

  it('includes "Did you mean" when near-matches exist', () => {
    const hint = didYouMeanHint('task', TOOLS)
    assert.match(hint, /Did you mean: delegate_task/)
  })

  it('always includes "Available tools"', () => {
    const hint = didYouMeanHint('xyzpdq', TOOLS)
    assert.match(hint, /Available tools:/)
    assert.match(hint, /delegate_task/)
    assert.match(hint, /read_file/)
  })

  it('omits "Did you mean" when no near-matches', () => {
    const hint = didYouMeanHint('xyzpdq', TOOLS)
    assert.doesNotMatch(hint, /Did you mean/)
  })

  it('handles empty candidate list gracefully', () => {
    const hint = didYouMeanHint('task', [])
    // No crash, no Did-you-mean, but still surfaces a message.
    assert.doesNotMatch(hint, /Did you mean/)
  })
})