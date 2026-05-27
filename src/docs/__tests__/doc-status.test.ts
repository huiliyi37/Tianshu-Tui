import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { parseDocStatus, validateDocStatus, type DocStatus } from '../doc-status.js'

describe('doc-status', () => {
  it('parses a standard status line from the document header', () => {
    const markdown = '# Example\n\n> **Status**: implemented / verified\n\nBody'
    assert.deepEqual(parseDocStatus(markdown), ['implemented', 'verified'])
  })

  it('accepts the canonical lifecycle statuses', () => {
    const statuses: DocStatus[] = ['proposed', 'accepted', 'implemented', 'verified', 'blocked', 'superseded']
    assert.deepEqual(validateDocStatus(statuses), [])
  })

  it('reports missing status for plan and analysis documents', () => {
    const errors = validateDocStatus([])
    assert.deepEqual(errors, ['missing-status'])
  })

  it('reports invalid status tokens with the offending value', () => {
    const errors = validateDocStatus(['done' as DocStatus])
    assert.deepEqual(errors, ['invalid-status:done'])
  })
})
