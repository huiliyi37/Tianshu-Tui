import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { applyCommandFilter } from '../command-filters.js'

describe('filterBashOutput (tsc --noEmit)', () => {
  // Condition 1: tsc --noEmit, exit 0, zero errors → concise success message
  it('returns success marker when tsc finds zero errors', () => {
    const result = applyCommandFilter('npx tsc --noEmit', 'TypeScript compilation completed', 0)
    assert.ok(result)
    // When tsc output contains no "Found 0 errors" line, synthesize a clean marker
    assert.match(result!, /typecheck passed/i)
  })

  it('preserves tsc "Found 0 errors" summary when present', () => {
    const result = applyCommandFilter('tsc --noEmit', 'Found 0 errors.', 0)
    assert.equal(result, 'Found 0 errors.')
  })

  // Condition 2: tsc --noEmit, exit non-zero, errors → only error lines, path stripped
  it('keeps only error TS lines and strips path prefix on failure', () => {
    const input = [
      'src/tools/bash.ts(123,45): error TS2345: string is not number',
      'src/tools/foo.ts(10,5): error TS2322: Type mismatch.',
      '  Compiling project...',
      'Found 2 errors.',
    ].join('\n')
    const result = applyCommandFilter('npx tsc --noEmit', input, 1)
    assert.ok(result)
    // Error TS lines are present without path prefix
    assert.match(result!, /error TS2345: string is not number/)
    assert.match(result!, /error TS2322: Type mismatch/)
    assert.match(result!, /Found 2 errors/)
    // Non-error lines are stripped
    assert.ok(!result!.includes('Compiling'))
    // No path prefix (src/tools/bash.ts(123,45): ) remains
    assert.ok(!result!.includes('src/tools/bash.ts'))
    assert.ok(!result!.includes('src/tools/foo.ts'))
  })

  it('strips path prefix but preserves error message body', () => {
    const input = 'deep/path/to/module.ts(99,1): error TS2551: Property x does not exist.'
    const result = applyCommandFilter('tsc --noEmit', input, 2)
    assert.equal(result, 'error TS2551: Property x does not exist.')
  })

  // Condition 3: non-tsc command → original stdout returned as-is
  it('returns null for non-tsc commands (caller falls back to raw)', () => {
    assert.equal(applyCommandFilter('npm install express', 'added 1 package', 0), null)
    assert.equal(applyCommandFilter('ls -la', 'file1\nfile2', 0), null)
    assert.equal(applyCommandFilter('git diff', 'some diff output', 1), null)
  })

  // Condition 4: tsc variants still match
  it('matches tsc with various invocation forms', () => {
    const variants = [
      'tsc --noEmit',
      'npx tsc --noEmit',
      './node_modules/.bin/tsc --noEmit',
      'tsc --noEmit --strict',
    ]
    for (const cmd of variants) {
      const result = applyCommandFilter(cmd, 'Found 0 errors.', 0)
      assert.equal(result, 'Found 0 errors.', `failed for: ${cmd}`)
    }
  })
})
