import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { MistakeNotebook } from '../mistake-notebook.js'

describe('MistakeNotebook', () => {
  let notebook: MistakeNotebook

  beforeEach(() => {
    notebook = new MistakeNotebook()
  })

  it('records a mistake and retrieves it', () => {
    notebook.record({
      timestamp: '2026-05-23',
      error: 'Cannot find module ./foo.js',
      context: 'edit_file src/bar.ts',
      resolution: 'Add .js extension to import path',
      tags: ['typescript', 'esm', 'import'],
    })
    const results = notebook.query('Cannot find module ./baz.js', 'edit_file src/qux.ts')
    assert.equal(results.length, 1)
    assert.equal(results[0]!.resolution, 'Add .js extension to import path')
  })

  it('deduplicates by id', () => {
    const entry = {
      timestamp: '2026-05-23',
      error: 'Cannot find module ./foo.js',
      context: 'edit_file src/bar.ts',
      resolution: 'Add .js extension',
      tags: ['esm'],
    }
    notebook.record(entry)
    notebook.record(entry)
    assert.equal(notebook.size(), 1)
  })

  it('returns empty for unrelated errors', () => {
    notebook.record({
      timestamp: '2026-05-23',
      error: 'Cannot find module ./foo.js',
      context: 'edit_file src/bar.ts',
      resolution: 'Add .js extension',
      tags: ['esm'],
    })
    const results = notebook.query('ENOENT: no such file or directory', 'bash rm /tmp/x')
    assert.equal(results.length, 0)
  })

  it('formats hints for prompt injection', () => {
    notebook.record({
      timestamp: '2026-05-23',
      error: 'Type error: property x does not exist',
      context: 'edit_file src/foo.ts',
      resolution: 'Check interface definition, field was renamed to y',
      tags: ['typescript'],
    })
    const results = notebook.query('Type error: property z does not exist', 'edit_file')
    const formatted = MistakeNotebook.formatHints(results)
    assert.ok(formatted.includes('<mistake-hints>'))
    assert.ok(formatted.includes('Resolution:'))
  })

  it('limits results to maxResults', () => {
    for (let i = 0; i < 10; i++) {
      notebook.record({
        timestamp: '2026-05-23',
        error: `error variant ${i} module not found`,
        context: 'edit_file src/x.ts',
        resolution: `fix ${i}`,
        tags: ['esm'],
      })
    }
    const results = notebook.query('module not found', 'edit_file', 3)
    assert.equal(results.length, 3)
  })
})
