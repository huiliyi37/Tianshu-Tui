import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { parseTscOutput } from '../startup-health-check.js'

describe('startup-health-check', () => {
  test('parseTscOutput extracts errors from tsc output', () => {
    const output = [
      'src/foo.ts(42,5): error TS2345: Argument of type \'string\' is not assignable to parameter of type \'number\'.',
      'src/bar.ts(10,1): error TS2304: Cannot find name \'xyz\'.',
      'Found 2 errors.',
    ].join('\n')

    const errors = parseTscOutput(output)
    assert.equal(errors.length, 2)
    assert.equal(errors[0]!.file, 'src/foo.ts')
    assert.equal(errors[0]!.line, 42)
    assert.ok(errors[0]!.message.includes('Argument of type'))
    assert.equal(errors[1]!.file, 'src/bar.ts')
    assert.equal(errors[1]!.line, 10)
  })

  test('parseTscOutput returns empty array for clean output', () => {
    const errors = parseTscOutput('')
    assert.equal(errors.length, 0)
  })

  test('parseTscOutput handles Windows-style paths', () => {
    const output = 'src\\utils\\helper.ts(5,3): error TS2322: Type \'string\' is not assignable to type \'number\'.'
    const errors = parseTscOutput(output)
    assert.equal(errors.length, 1)
    assert.equal(errors[0]!.file, 'src\\utils\\helper.ts')
    assert.equal(errors[0]!.line, 5)
  })

  test('parseTscOutput ignores non-error lines', () => {
    const output = [
      'Version 5.4.2',
      'src/foo.ts(1,1): error TS2345: Bad type.',
      '',
      'Found 1 error.',
    ].join('\n')

    const errors = parseTscOutput(output)
    assert.equal(errors.length, 1)
  })
})
