import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { buildImportEdgesFromText } from '../import-graph.js'

describe('import graph', () => {
  it('extracts relative import edges', () => {
    const edges = buildImportEdgesFromText('src/a.ts', [
      "import { b } from './b.js'",
      "import type { C } from '../c.js'",
      "import 'zod'",
    ].join('\n'))

    assert.deepEqual(edges, [
      { from: 'src/a.ts', to: './b.js' },
      { from: 'src/a.ts', to: '../c.js' },
    ])
  })
})
