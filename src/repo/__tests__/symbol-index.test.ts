import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { buildSymbolIndexFromText } from '../symbol-index.js'

describe('symbol index', () => {
  it('extracts functions, classes, types and exports with line numbers', () => {
    const index = buildSymbolIndexFromText('src/example.ts', [
      'export function run() {}',
      'class Worker {}',
      'export interface Config { name: string }',
      'type Result = string',
    ].join('\n'))

    assert.deepEqual(index.map(s => [s.name, s.kind, s.line]), [
      ['run', 'function', 1],
      ['Worker', 'class', 2],
      ['Config', 'type', 3],
      ['Result', 'type', 4],
    ])
  })
})
