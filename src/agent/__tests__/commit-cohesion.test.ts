import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { checkCommitCohesion } from '../commit-cohesion.js'

describe('checkCommitCohesion', () => {
  it('returns no warning for 1-2 files in same area', () => {
    const report = checkCommitCohesion(['src/agent/a.ts', 'src/agent/b.ts'])
    assert.equal(report.needsWarning, false)
    assert.equal(report.topDirCount, 1)
    assert.equal(report.fileCount, 2)
  })

  it('returns no warning for files within threshold (≤5 files, ≤2 top dirs)', () => {
    const report = checkCommitCohesion([
      'src/agent/a.ts',
      'src/agent/b.ts',
      'src/agent/c.ts',
      'src/tools/x.ts',
      'src/tools/y.ts',
    ])
    assert.equal(report.needsWarning, false)
    assert.equal(report.topDirCount, 2)
  })

  it('flags as gate when files span more than 2 top-level directories', () => {
    const report = checkCommitCohesion([
      'src/agent/a.ts',
      'src/tools/b.ts',
      'src/tui/c.ts',
    ])
    assert.equal(report.needsWarning, true)
    assert.equal(report.topDirCount, 3)
    assert.ok(report.warningLines.length > 0)
    assert.match(report.warningLines[0]!, /3 owned files across 3 areas/)
  })

  it('flags as gate when more than 5 files even in same directory', () => {
    const files = Array.from({ length: 6 }, (_, i) => `src/agent/file${i}.ts`)
    const report = checkCommitCohesion(files)
    assert.equal(report.needsWarning, true)
    assert.equal(report.topDirCount, 1)
    assert.ok(report.warningLines.some(l => /force=true/.test(l)))
    assert.ok(report.splitSuggestion.length > 0)
  })

  it('extracts top-level directory as first two segments', () => {
    const report = checkCommitCohesion([
      'src/agent/deep/nested/a.ts',
      'src/tools/b.ts',
    ])
    assert.deepEqual(report.topDirs, ['src/agent', 'src/tools'])
  })

  it('handles root-level files as top-level dir', () => {
    const report = checkCommitCohesion(['package.json', 'src/a.ts'])
    assert.deepEqual(report.topDirs, ['.', 'src/a.ts'])
  })

  it('returns no warning for empty file list', () => {
    const report = checkCommitCohesion([])
    assert.equal(report.needsWarning, false)
    assert.equal(report.fileCount, 0)
  })

  it('accepts custom thresholds', () => {
    const report = checkCommitCohesion(
      ['src/agent/a.ts', 'src/agent/b.ts', 'src/agent/c.ts'],
      { maxFiles: 2 },
    )
    assert.equal(report.needsWarning, true)
  })
})
