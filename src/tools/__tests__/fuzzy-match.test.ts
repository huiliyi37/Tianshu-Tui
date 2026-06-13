import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { findFuzzyMatch, applyFuzzyReplacement } from '../fuzzy-match.js'

describe('fuzzy-match', () => {
  it('matches a block that differs only in indentation', () => {
    const content = [
      'function f() {',
      '    const x = 1',
      '    return x',
      '}',
    ].join('\n')
    // needle uses 2-space indent vs file's 4-space
    const needle = '  const x = 1\n  return x'
    const m = findFuzzyMatch(content, needle)
    assert.ok(m)
    assert.equal(m!.matchedText, '    const x = 1\n    return x')
  })

  it('matches across tab-vs-space and trailing whitespace drift', () => {
    const content = 'a\n\tlet v = 2   \nb'
    const needle = '    let v = 2'
    const m = findFuzzyMatch(content, needle)
    assert.ok(m)
    assert.equal(m!.matchedText, '\tlet v = 2   ')
  })

  it('returns null when block is absent', () => {
    assert.equal(findFuzzyMatch('hello\nworld', 'nope here'), null)
  })

  it('returns null when block is ambiguous (multiple normalized matches)', () => {
    const content = 'x = 1\n\nx  =  1\n'
    // both lines normalize to "x = 1"
    assert.equal(findFuzzyMatch(content, 'x = 1'), null)
  })

  it('refuses an all-blank needle', () => {
    assert.equal(findFuzzyMatch('a\nb\nc', '   \n  '), null)
  })

  it('applyFuzzyReplacement splices onto real text preserving surroundings', () => {
    const content = 'head\n    body line\ntail'
    const m = findFuzzyMatch(content, 'body line')
    assert.ok(m)
    const out = applyFuzzyReplacement(content, m!, '    NEW body')
    assert.equal(out, 'head\n    NEW body\ntail')
  })
})
