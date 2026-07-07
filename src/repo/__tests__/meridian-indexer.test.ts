import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { MeridianIndexer } from '../meridian-indexer.js'

function isIndexable(indexer: MeridianIndexer, filePath: string): boolean {
  return (indexer as unknown as { isIndexable(filePath: string): boolean }).isIndexable(filePath)
}

function callToRepoRelative(indexer: MeridianIndexer, filePath: string): string | null {
  return (indexer as unknown as { toRepoRelative(filePath: string): string | null }).toRepoRelative(filePath)
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

  it('toRepoRelative normalizes absolute to repo-relative, blocks traversal and outside paths', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'meridian-indexer-rel-'))
    const stateDir = mkdtempSync(join(tmpdir(), 'meridian-indexer-rel-state-'))
    const indexer = new MeridianIndexer(cwd, stateDir)
    try {
      assert.equal(callToRepoRelative(indexer, resolve(cwd, 'src/app.ts')), 'src/app.ts')
      assert.equal(callToRepoRelative(indexer, resolve(cwd, '.codex/hooks.ts')), '.codex/hooks.ts')
      // relative passes through unchanged
      assert.equal(callToRepoRelative(indexer, 'src/app.ts'), 'src/app.ts')
      // relative traversal outside cwd returns null — fail-closed
      assert.equal(callToRepoRelative(indexer, '../outside.ts'), null)
      // absolute outside cwd returns null — fail-closed
      const outside = resolve('/tmp/outside/file.ts')
      assert.equal(callToRepoRelative(indexer, outside), null)
    } finally {
      indexer.close()
      rmSync(cwd, { recursive: true, force: true })
      rmSync(stateDir, { recursive: true, force: true })
    }
  })

  it('rejects absolute paths outside the project — fail-closed', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'meridian-indexer-outside-'))
    const stateDir = mkdtempSync(join(tmpdir(), 'meridian-indexer-outside-state-'))
    const indexer = new MeridianIndexer(cwd, stateDir)
    try {
      assert.equal(
        isIndexable(indexer, '/tmp/outside/file.ts'),
        false,
        'absolute path outside project must not be indexable',
      )
      assert.equal(
        isIndexable(indexer, '/Users/stranger/project/src/app.ts'),
        false,
        'absolute path to another project must not be indexable',
      )
      // relative traversal also blocked
      assert.equal(
        isIndexable(indexer, '../outside.ts'),
        false,
        'relative traversal outside project must not be indexable',
      )
      assert.equal(
        isIndexable(indexer, '../../etc/passwd.ts'),
        false,
        'deep traversal must not be indexable',
      )
    } finally {
      indexer.close()
      rmSync(cwd, { recursive: true, force: true })
      rmSync(stateDir, { recursive: true, force: true })
    }
  })

  it('indexFile rejects outside-project paths even when file exists on disk', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'meridian-indexer-outside-idx-'))
    const stateDir = mkdtempSync(join(tmpdir(), 'meridian-indexer-outside-idx-state-'))
    const outsideDir = mkdtempSync(join(tmpdir(), 'meridian-outside-'))
    const outsideFile = join(outsideDir, 'secret.ts')
    writeFileSync(outsideFile, 'export const secret = 42\n')
    const indexer = new MeridianIndexer(cwd, stateDir)
    try {
      // absolute outside-project path
      await indexer.indexFile(outsideFile)
      let stats = indexer.getStats()
      assert.equal(stats.files, 0, 'absolute outside-project file must not enter the DB')

      // relative traversal: create a real file one dir up
      const parentDir = join(cwd, '..', 'meridian-parent-sibling.ts')
      writeFileSync(parentDir, 'export const sibling = 1\n')
      await indexer.indexFile('../meridian-parent-sibling.ts')
      stats = indexer.getStats()
      assert.equal(stats.files, 0, 'relative traversal outside project must not enter the DB')
      rmSync(parentDir, { force: true })
    } finally {
      indexer.close()
      rmSync(cwd, { recursive: true, force: true })
      rmSync(stateDir, { recursive: true, force: true })
      rmSync(outsideDir, { recursive: true, force: true })
    }
  })

  it('stores resolved import edges so reverse-dependency lookup works end-to-end', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'meridian-indexer-revdep-'))
    const stateDir = mkdtempSync(join(tmpdir(), 'meridian-indexer-revdep-state-'))
    mkdirSync(join(cwd, 'src'), { recursive: true })
    writeFileSync(join(cwd, 'src', 'b.ts'), 'export const b = 1\n')
    writeFileSync(
      join(cwd, 'src', 'a.ts'),
      "import { b } from './b.js'\nimport { z } from 'zod'\nexport const a = b\nexport const zz = z\n",
    )
    const indexer = new MeridianIndexer(cwd, stateDir)
    try {
      await indexer.indexFile('src/a.ts')
      const db = indexer.getDb()

      // a.ts imports b.ts → b.ts's reverse dependents include a.ts
      const dependents = db.getReverseDependents('src/b.ts').map(d => d.file)
      assert.ok(dependents.includes('src/a.ts'), `expected src/a.ts in reverse dependents, got ${JSON.stringify(dependents)}`)
      assert.ok(indexer.impact(['src/b.ts']).direct.includes('src/a.ts'))

      // External package import (zod) resolves to nothing → no edge created
      assert.equal(db.getReverseDependents('zod').length, 0)

      // invalidateFile re-parses and must keep import edges resolved (not raw)
      await indexer.invalidateFile('src/a.ts')
      const afterInvalidate = db.getReverseDependents('src/b.ts').map(d => d.file)
      assert.ok(afterInvalidate.includes('src/a.ts'), `expected resolved edge after invalidate, got ${JSON.stringify(afterInvalidate)}`)
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
