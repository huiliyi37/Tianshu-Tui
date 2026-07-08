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

  it('pathological repetitive content stays bounded (same class as ea413390)', () => {
    // Repetitive lines defeat the inner-loop early exit: every window matches
    // the needle's first 80 lines and fails on the last one. Before the
    // deadline bound + pre-normalization this scanned for ~6s of synchronous
    // CPU on 120K lines (event loop frozen: Esc dead, tool timeout can't fire).
    const content = Array.from({ length: 120_000 }, () => '  foo(bar, baz); // repeated').join('\n')
    const needle = Array.from({ length: 80 }, () => '  foo(bar, baz); // repeated').join('\n')
      + '\n  UNIQUE_LAST_LINE();'
    const t = Date.now()
    const m = findFuzzyMatch(content, needle)
    const elapsed = Date.now() - t
    assert.ok(elapsed < 5000, `findFuzzyMatch took ${elapsed}ms — deadline bound not effective`)
    assert.equal(m, null, 'degrades to null (caller falls back to the diagnostic error)')
  })

  it('still finds a unique match in a large file within the budget', () => {
    // Large but non-pathological: unique needle content, early exit works.
    const lines = Array.from({ length: 100_000 }, (_, i) => `const v${i} = compute(${i})`)
    lines[50_000] = '    const target = specialValue()'
    lines[50_001] = '    return target'
    const content = lines.join('\n')
    // 2-space indent vs the file's 4-space — exact match would fail.
    const m = findFuzzyMatch(content, '  const target = specialValue()\n  return target')
    assert.ok(m, 'fuzzy match still recovers unique blocks in large files')
    assert.equal(m!.matchedText, '    const target = specialValue()\n    return target')
  })
})
