import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { buildContextBundle } from '../context-bundle.js'

describe('context bundle', () => {
  it('combines symbols, tests and risks into a task bundle', () => {
    const bundle = buildContextBundle({
      task: 'fix run tests filter',
      likelyFiles: ['src/tools/run-tests.ts'],
      relatedTests: ['src/tools/__tests__/run-tests.test.ts'],
      symbols: [{ name: 'buildTestCommand', kind: 'function', file: 'src/tools/run-tests.ts', line: 1, exported: false }],
      risks: ['test command must not use shell interpolation'],
    })

    assert.match(bundle, /fix run tests filter/)
    assert.match(bundle, /src\/tools\/run-tests\.ts/)
    assert.match(bundle, /buildTestCommand/)
  })
})
