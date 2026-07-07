import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { auditCommitTagScope, extractTaskTags } from '../commit-audit.js'

describe('extractTaskTags', () => {
  it('extracts single tag', () => {
    assert.deepEqual(extractTaskTags('perf(tui): throttle resize (S14)'), ['S14'])
  })
  it('extracts multiple tags', () => {
    assert.deepEqual(extractTaskTags('fix: replace flaky perf test (M1, L1, M2)'), ['M1', 'L1', 'M2'])
  })
  it('returns empty for no tag', () => {
    assert.deepEqual(extractTaskTags('fix: correct typo'), [])
  })
  it('extracts suffixed tags like C2a', () => {
    assert.deepEqual(extractTaskTags('perf: prebuild toolCallId index (C2a)'), ['C2a'])
  })
})

describe('auditCommitTagScope', () => {
  it('ok when tag present and files changed', () => {
    const r = auditCommitTagScope('perf(tui): resize (S14)', ['src/tui/use-terminal-size.ts'])
    assert.equal(r.ok, true)
    assert.deepEqual(r.tags, ['S14'])
  })
  it('warns when commit has tag but zero files (empty commit / mislabel)', () => {
    const r = auditCommitTagScope('perf(tui): resize (S14)', [])
    assert.equal(r.ok, false)
    assert.match(r.message, /S14/)
    assert.match(r.message, /no files|0 file/i)
  })
  it('warns when message claims many tags but only one file changed (scope creep signal)', () => {
    const r = auditCommitTagScope('mixed (S13, S2, S9)', ['src/agent/loop.ts'])
    assert.equal(r.ok, false)
    assert.match(r.message, /3 task tag/i)
  })
  it('ok when no tag (untagged commits not audited)', () => {
    const r = auditCommitTagScope('fix: typo', ['src/a.ts'])
    assert.equal(r.ok, true)
  })
  it('ok when tags and files are balanced', () => {
    const r = auditCommitTagScope('fix: two changes (S1, S2)', ['src/a.ts', 'src/b.ts'])
    assert.equal(r.ok, true)
  })
})
