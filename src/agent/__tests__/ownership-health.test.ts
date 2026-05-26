import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { summarizeOwnershipHealth } from '../ownership-health.js'

describe('summarizeOwnershipHealth', () => {
  it('classifies dirty owned and dirty external files', () => {
    const report = summarizeOwnershipHealth({
      ownedFiles: ['src/a.ts', 'src/b.ts'],
      externalFiles: ['.rivet/prefix-diag.jsonl'],
      dirtyFiles: ['src/a.ts', '.rivet/prefix-diag.jsonl'],
    })
    assert.deepEqual(report.untrackedDirtyOwned, ['src/a.ts'])
    assert.deepEqual(report.dirtyExternal, ['.rivet/prefix-diag.jsonl'])
    assert.deepEqual(report.cleanOwned, ['src/b.ts'])
  })

  it('warns for dirty files without ownership classification', () => {
    const report = summarizeOwnershipHealth({ ownedFiles: [], externalFiles: [], dirtyFiles: ['src/unknown.ts'] })
    assert.ok(report.warningLines.includes('Dirty file has no ownership classification: src/unknown.ts'))
  })

  it('reports external-only dirty files as informational caveats, not warnings', () => {
    const report = summarizeOwnershipHealth({ ownedFiles: [], externalFiles: ['src/external.ts'], dirtyFiles: ['src/external.ts'] })
    assert.deepEqual(report.warningLines, [])
    assert.ok(report.infoLines.includes('No current owned dirty files. External dirty files are present and excluded from delivery scope.'))
  })
})
