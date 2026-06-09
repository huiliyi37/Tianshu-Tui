import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { MeridianIndexer } from '../meridian-indexer.js'

function isIndexable(indexer: MeridianIndexer, filePath: string): boolean {
  return (indexer as unknown as { isIndexable(filePath: string): boolean }).isIndexable(filePath)
}

function callToRepoRelative(indexer: MeridianIndexer, filePath: string): string {
  return (indexer as unknown as { toRepoRelative(filePath: string): string }).toRepoRelative(filePath)
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

  it('rejects absolute paths inside silent layers — counterexample for real read_file chain', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'meridian-indexer-abs-'))
    const stateDir = mkdtempSync(join(tmpdir(), 'meridian-indexer-abs-state-'))
    const indexer = new MeridianIndexer(cwd, stateDir)
    try {
      // Simulate real read_file target: absolute path to .codex foreign file
      assert.equal(
        isIndexable(indexer, join(cwd, '.codex', 'hooks.ts')),
        false,
        'absolute path inside foreign silent layer must stay silent',
      )
      // Same for .agents
      assert.equal(
        isIndexable(indexer, resolve(cwd, '.agents/plugin.ts')),
        false,
        'absolute .agents path must stay silent',
      )
      // node_modules absolute
      assert.equal(
        isIndexable(indexer, resolve(cwd, 'node_modules/pkg/index.ts')),
        false,
        'absolute node_modules must stay silent',
      )
      // Legitimate absolute path to real source stays indexable
      assert.equal(
        isIndexable(indexer, resolve(cwd, 'src/app.ts')),
        true,
        'absolute path to real content stays indexable',
      )
    } finally {
      indexer.close()
      rmSync(cwd, { recursive: true, force: true })
      rmSync(stateDir, { recursive: true, force: true })
    }
  })

  it('toRepoRelative normalizes absolute to repo-relative, passes through relative', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'meridian-indexer-rel-'))
    const stateDir = mkdtempSync(join(tmpdir(), 'meridian-indexer-rel-state-'))
    const indexer = new MeridianIndexer(cwd, stateDir)
    try {
      assert.equal(callToRepoRelative(indexer, resolve(cwd, 'src/app.ts')), 'src/app.ts')
      assert.equal(callToRepoRelative(indexer, resolve(cwd, '.codex/hooks.ts')), '.codex/hooks.ts')
      // relative passes through unchanged
      assert.equal(callToRepoRelative(indexer, 'src/app.ts'), 'src/app.ts')
      // absolute outside cwd passes through as-is (unusual but safe)
      const outside = resolve('/tmp/outside/file.ts')
      assert.equal(callToRepoRelative(indexer, outside), outside)
    } finally {
      indexer.close()
      rmSync(cwd, { recursive: true, force: true })
      rmSync(stateDir, { recursive: true, force: true })
    }
  })

  it('indexFile rejects absolute silent paths without creating DB entries', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'meridian-indexer-idx-'))
    const stateDir = mkdtempSync(join(tmpdir(), 'meridian-indexer-idx-state-'))
    // Create the file on disk so existsSync would pass if isIndexable didn't block it
    mkdirSync(join(cwd, '.codex'), { recursive: true })
    writeFileSync(join(cwd, '.codex', 'hooks.ts'), 'export const x = 1\n')
    const indexer = new MeridianIndexer(cwd, stateDir)
    try {
      await indexer.indexFile(resolve(cwd, '.codex', 'hooks.ts'))
      const stats = indexer.getStats()
      assert.equal(stats.files, 0, 'absolute silent path must not enter the DB')
    } finally {
      indexer.close()
      rmSync(cwd, { recursive: true, force: true })
      rmSync(stateDir, { recursive: true, force: true })
    }
  })
})
