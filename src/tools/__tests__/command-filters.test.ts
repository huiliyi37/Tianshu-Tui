import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { applyCommandFilter } from '../command-filters.js'

describe('applyCommandFilter', () => {
  describe('tsc filter', () => {
    it('returns summary for tsc success', () => {
      const result = applyCommandFilter('npx tsc --noEmit', 'Found 0 errors.', 0)
      assert.ok(result)
      assert.match(result, /Found 0 errors/)
    })

    it('keeps error lines for tsc failure', () => {
      const input = [
        'src/tools/foo.ts(10,5): error TS2322: Type string is not assignable to type number.',
        'src/tools/bar.ts(20,1): error TS2551: Property does not exist.',
        'Found 2 errors.',
      ].join('\n')
      const result = applyCommandFilter('npx tsc --noEmit', input, 1)
      assert.ok(result)
      assert.match(result, /error TS2322/)
      assert.match(result, /error TS2551/)
      assert.match(result, /Found 2 errors/)
    })

    it('strips non-error lines from tsc', () => {
      const input = [
        'Compiling...',
        'src/tools/foo.ts(10,5): error TS2322: Type mismatch.',
        'Found 1 error.',
      ].join('\n')
      const result = applyCommandFilter('npx tsc --noEmit', input, 1)
      assert.ok(result)
      assert.ok(!result.includes('Compiling'))
    })
  })

  describe('node:test filter', () => {
    it('returns summary for passing tests', () => {
      const input = '✓ test 1\n✓ test 2\n2 passed, 0 failed'
      const result = applyCommandFilter('npx tsx --test src/foo.test.ts', input, 0)
      assert.ok(result)
      assert.match(result, /passed/)
    })

    it('keeps failed test lines', () => {
      const input = [
        '✓ passing test',
        'not ok 2 - failing test',
        '  AssertionError: expected 1 to equal 2',
        '  at Object.<anonymous> (/test.ts:10:10)',
        '1 passed, 1 failed',
      ].join('\n')
      const result = applyCommandFilter('npx tsx --test src/foo.test.ts', input, 1)
      assert.ok(result)
      assert.match(result, /not ok 2/)
      assert.match(result, /AssertionError/)
      assert.ok(!result.includes('✓ passing test'))
    })
  })

  describe('git status filter', () => {
    it('removes hint lines', () => {
      const input = [
        'On branch main',
        'Changes not staged for commit:',
        '  (use "git add <file>..." to update what will be committed)',
        '  modified: src/foo.ts',
      ].join('\n')
      const result = applyCommandFilter('git status', input, 0)
      assert.ok(result)
      assert.match(result, /modified: src\/foo\.ts/)
      assert.ok(!result.includes('use "git add'))
    })
  })

  describe('no matching filter', () => {
    it('returns null for unknown commands', () => {
      const result = applyCommandFilter('npm install express', 'added 1 package', 0)
      assert.equal(result, null)
    })
  })
})
