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

  it('warns when no owned files are registered but dirty files exist', () => {
    const report = summarizeOwnershipHealth({ ownedFiles: [], externalFiles: ['src/external.ts'], dirtyFiles: ['src/external.ts'] })
    assert.ok(report.warningLines.includes('No owned files registered, but dirty files exist. Check task-ledger write events.'))
  })
})
