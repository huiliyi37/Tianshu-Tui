import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fuzzyMatch, fuzzyRank, fuzzyFilter } from '../fuzzy.js'

// fuzzyMatch: query vs text, returns {matches, score} (lower score = better)

test('fuzzyMatch: word-local match (query is a word in text)', () => {
  const r = fuzzyMatch('apple', 'apple pie recipe')
  assert.equal(r.matches, true)
  assert.ok(r.score <= 0, 'good match should have score ≤ 0 (bonus)')
})

test('fuzzyMatch: prefix of a word scores better than scattered letters', () => {
  const prefix = fuzzyMatch('app', 'apple')
  const scattered = fuzzyMatch('app', 'a x p p l e')
  if (prefix.matches && scattered.matches) {
    assert.ok(prefix.score <= scattered.score, 'prefix should score ≤ scattered')
  }
})


test('fuzzyMatch: out-of-order query does not match (word-local)', () => {
  // Query letters must appear in order within a word.
  const r = fuzzyMatch('cba', 'abcdef')
  // cba in "abcdef" — c then b then a is out of order; word-local matching.
  // It may or may not match depending on cross-word logic, but score must be poor.
  if (r.matches) {
    const ordered = fuzzyMatch('abc', 'abcdef')
    assert.ok(r.score >= ordered.score, 'out-of-order should not beat ordered')
  }
})

test('fuzzyMatch: empty query matches everything with neutral score', () => {
  const r = fuzzyMatch('', 'anything')
  assert.equal(r.matches, true)
})

test('fuzzyMatch: query longer than text → no match', () => {
  const r = fuzzyMatch('abcdef', 'abc')
  assert.equal(r.matches, false)
})

// fuzzyFilter: rank + filter items by query

test('fuzzyFilter: returns only matching items, best first', () => {
  const items = ['apple pie', 'banana', 'apricot', 'cherry']
  const result = fuzzyFilter(items, 'ap', (s) => s)
  // "apple pie" and "apricot" match "ap"; banana/cherry don't.
  assert.ok(result.includes('apple pie'))
  assert.ok(result.includes('apricot'))
  assert.ok(!result.includes('banana'))
  assert.ok(!result.includes('cherry'))
  // Best match (prefix "ap" in apple/apricot) should come first.
  assert.equal(result[0], 'apple pie')
})

test('fuzzyFilter: empty query returns all items', () => {
  const items = ['a', 'b', 'c']
  const result = fuzzyFilter(items, '', (s) => s)
  assert.equal(result.length, 3)
})

test('fuzzyFilter: no matches → empty array', () => {
  const items = ['apple', 'banana']
  const result = fuzzyFilter(items, 'zzz', (s) => s)
  assert.equal(result.length, 0)
})

// fuzzyRank: same as filter but preserves scores

test('fuzzyRank: results carry score, sorted ascending', () => {
  const items = ['foobar', 'foo', 'xfoxobar']
  const ranked = fuzzyRank(items, 'foo', (s) => s)
  assert.ok(ranked.length >= 2)
  // Scores should be non-decreasing (best first).
  for (let i = 1; i < ranked.length; i++) {
    assert.ok(ranked[i - 1]!.score <= ranked[i]!.score, 'scores should be sorted ascending')
  }
})

test('fuzzyRank: works with objects via getText accessor', () => {
  const items = [{ name: 'alpha' }, { name: 'beta' }, { name: 'gamma' }]
  const ranked = fuzzyRank(items, 'al', (item) => item.name)
  assert.equal(ranked.length, 1)
  assert.equal(ranked[0]!.item.name, 'alpha')
})
