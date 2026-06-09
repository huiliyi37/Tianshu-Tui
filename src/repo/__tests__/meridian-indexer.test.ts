import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { MeridianIndexer } from '../meridian-indexer.js'

function isIndexable(indexer: MeridianIndexer, filePath: string): boolean {
  return (indexer as unknown as { isIndexable(filePath: string): boolean }).isIndexable(filePath)
}

describe('MeridianIndexer attention indexing scope', () => {
  it('indexes content source files but rejects runtime, build, and foreign attention noise', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'meridian-indexer-attention-'))
    const stateDir = mkdtempSync(join(tmpdir(), 'meridian-indexer-state-'))
    const indexer = new MeridianIndexer(cwd, stateDir)
    try {
      assert.equal(isIndexable(indexer, 'src/app.ts'), true)
      assert.equal(isIndexable(indexer, 'docs/teamtask/plan.md'), false, 'non-code content remains outside parser scope')
      assert.equal(isIndexable(indexer, 'node_modules/pkg/index.ts'), false)
      assert.equal(isIndexable(indexer, '.codex/hooks.ts'), false)
      assert.equal(isIndexable(indexer, '.test-tmp/generated.ts'), false)
      assert.equal(isIndexable(indexer, 'src/app.ts.map'), false)
      assert.equal(isIndexable(indexer, '.vscode/settings.ts'), true, '.vscode stays content-side unless explicitly proven noisy')
    } finally {
      indexer.close()
      rmSync(cwd, { recursive: true, force: true })
      rmSync(stateDir, { recursive: true, force: true })
    }
  })
})
