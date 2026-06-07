import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRuntimeHookContext } from '../runtime-hooks.js'
import { createPhysarumFileAccessHook, canonicalizePhysarumFileTarget } from '../hooks/physarum-file-access-hook.js'
import { PhysarumEngine } from '../../repo/physarum-engine.js'

function makeWorkspace(): string {
  const cwd = mkdtempSync(join(tmpdir(), 'physarum-file-access-'))
  mkdirSync(join(cwd, 'src'), { recursive: true })
  writeFileSync(join(cwd, 'src', 'a.ts'), 'export const a = 1\n')
  writeFileSync(join(cwd, 'src', 'b.ts'), 'export const b = 1\n')
  writeFileSync(join(cwd, 'src', 'notes.md'), '# notes\n')
  return cwd
}

function makeCtx(cwd: string, turn: number) {
  return createRuntimeHookContext({
    cwd,
    turn,
    recentToolHistory: [],
    sensorium: null,
    strategy: null,
    vigor: null,
    gitChangeRate: 0,
    season: null,
  })
}

describe('physarum file access hook', () => {
  it('canonicalizes only existing in-project indexable files', () => {
    const cwd = makeWorkspace()
    try {
      assert.equal(canonicalizePhysarumFileTarget(cwd, 'src/a.ts'), 'src/a.ts')
      assert.equal(canonicalizePhysarumFileTarget(cwd, join(cwd, 'src', 'b.ts')), 'src/b.ts')
      assert.equal(canonicalizePhysarumFileTarget(cwd, 'src'), null)
      assert.equal(canonicalizePhysarumFileTarget(cwd, 'src/notes.md'), null)
      assert.equal(canonicalizePhysarumFileTarget(cwd, '../outside.ts'), null)
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('learns successful file-to-file sequences without tool-name nodes', () => {
    const cwd = makeWorkspace()
    try {
      const engine = new PhysarumEngine(undefined)
      const hook = createPhysarumFileAccessHook({ getPhysarum: () => engine })

      hook.run(makeCtx(cwd, 1), { name: 'read_file', success: true, target: 'src/b.ts' })
      hook.run(makeCtx(cwd, 1), { name: 'edit_file', success: true, target: join(cwd, 'src', 'a.ts') })

      const edge = engine.getEdge('src/a.ts', 'src/b.ts')
      assert.ok(edge)
      assert.ok(edge.direction < 0, 'b.ts→a.ts should be encoded as a negative lexicographic edge direction')
      assert.equal(engine.getEdge('read_file', 'src/b.ts'), undefined)
      assert.equal(engine.predictNext('src/b.ts')[0]?.file, 'src/a.ts')
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('ignores grep paths, failed tools, directories, and non-indexable targets', () => {
    const cwd = makeWorkspace()
    try {
      const engine = new PhysarumEngine(undefined)
      const hook = createPhysarumFileAccessHook({ getPhysarum: () => engine })

      hook.run(makeCtx(cwd, 1), { name: 'read_file', success: true, target: 'src/a.ts' })
      hook.run(makeCtx(cwd, 2), { name: 'grep', success: true, target: 'src' })
      hook.run(makeCtx(cwd, 3), { name: 'edit_file', success: false, target: 'src/b.ts' })
      hook.run(makeCtx(cwd, 4), { name: 'read_file', success: true, target: 'src/notes.md' })

      assert.equal(engine.edgeCount(), 0)

      hook.run(makeCtx(cwd, 5), { name: 'hash_edit', success: true, target: 'src/b.ts' })
      assert.ok(engine.getEdge('src/a.ts', 'src/b.ts'))
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })
})
