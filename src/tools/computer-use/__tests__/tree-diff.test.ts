import { test } from 'node:test'
import assert from 'node:assert/strict'
import { diffTreeSummary } from '../tree-diff.js'

test('identical trees → unchanged', () => {
  const tree = '[1] Window "App"\n  [2] Button "OK"'
  const d = diffTreeSummary(tree, tree)
  assert.equal(d.changed, false)
  assert.equal(d.summary, 'UI unchanged after action.')
})

test('added and removed lines are reported with +/- prefixes and counts', () => {
  const before = '[1] Window "App"\n  [2] Button "OK"'
  const after = '[1] Window "App"\n  [2] Dialog "Save?"\n    [3] Button "Yes"'
  const d = diffTreeSummary(before, after)
  assert.equal(d.changed, true)
  assert.match(d.summary, /\+2\/-1 elements/)
  assert.match(d.summary, /\+ \[2\] Dialog "Save\?"/)
  assert.match(d.summary, /\+ \[3\] Button "Yes"/)
  assert.match(d.summary, /- \[2\] Button "OK"/)
})

test('duplicate lines are multiset-counted (one of two duplicates removed shows up)', () => {
  const before = '[1] Button "Tab"\n[2] Button "Tab"'
  const after = '[1] Button "Tab"'
  const d = diffTreeSummary(before, after)
  assert.equal(d.changed, true)
  assert.match(d.summary, /\+0\/-1 elements/)
})

test('long diffs truncate to 8 lines plus a count', () => {
  const before = ''
  const after = Array.from({ length: 12 }, (_, i) => `[${i + 1}] Button "B${i + 1}"`).join('\n')
  const d = diffTreeSummary(before, after)
  const plusLines = d.summary.split('\n').filter((l) => l.startsWith('+ '))
  assert.equal(plusLines.length, 9, '8 shown + 1 truncation note')
  assert.match(plusLines[8] ?? '', /… 4 more/, '12 added, 8 shown, 4 counted')
})

test('reorder-only change (same multiset) reports a reshuffle', () => {
  const before = '[1] Button "A"\n[2] Button "B"'
  const after = '[2] Button "B"\n[1] Button "A"'
  const d = diffTreeSummary(before, after)
  assert.equal(d.changed, true)
  assert.match(d.summary, /reordered/)
})

test('diff lines are trimmed of tree indentation', () => {
  const before = '[1] Window "App"'
  const after = '[1] Window "App"\n        [2] Button "Deep"'
  const d = diffTreeSummary(before, after)
  assert.match(d.summary, /^\+ \[2\] Button "Deep"$/m)
})
