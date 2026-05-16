import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { buildImportGraph, getReverseDeps, invalidateFile } from '../import-graph.js'

describe('ImportGraph', () => {
  let testDir: string

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'rivet-ig-'))
  })

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true })
  })

  it('builds graph from simple imports', () => {
    writeFileSync(join(testDir, 'a.ts'), `import { b } from './b'\n`)
    writeFileSync(join(testDir, 'b.ts'), `export const b = 1\n`)

    const graph = buildImportGraph(testDir)!
    assert.ok(graph !== null)
    const reverse = getReverseDeps(graph, join(testDir, 'b.ts'))
    assert.equal(reverse.size, 1)
    assert.ok([...reverse][0]!.endsWith('a.ts'))
  })

  it('returns null when too many files', () => {
    for (let i = 0; i < 3; i++) {
      writeFileSync(join(testDir, `file${i}.ts`), `export const x${i} = ${i}\n`)
    }
    const graph = buildImportGraph(testDir, 2)
    assert.equal(graph, null)
  })

  it('handles empty directory', () => {
    const graph = buildImportGraph(testDir)
    assert.ok(graph !== null)
    assert.equal(graph.forward.size, 0)
    assert.equal(graph.reverse.size, 0)
  })

  it('skips node_modules and dot dirs', () => {
    mkdirSync(join(testDir, 'node_modules'))
    mkdirSync(join(testDir, '.hidden'))
    writeFileSync(join(testDir, 'node_modules', 'pkg.ts'), `export const x = 1\n`)
    writeFileSync(join(testDir, '.hidden', 'secret.ts'), `export const y = 2\n`)
    writeFileSync(join(testDir, 'main.ts'), `export const m = 0\n`)

    const graph = buildImportGraph(testDir)!
    assert.equal(graph.forward.size, 1)
  })

  it('updates after invalidateFile', () => {
    writeFileSync(join(testDir, 'a.ts'), `import { b } from './b'\n`)
    writeFileSync(join(testDir, 'b.ts'), `export const b = 1\n`)
    writeFileSync(join(testDir, 'c.ts'), `export const c = 2\n`)

    const graph = buildImportGraph(testDir)!
    let reverse = getReverseDeps(graph, join(testDir, 'b.ts'))
    assert.equal(reverse.size, 1)

    // Change a.ts to import c instead of b
    writeFileSync(join(testDir, 'a.ts'), `import { c } from './c'\n`)
    invalidateFile(graph, testDir, 'a.ts')

    reverse = getReverseDeps(graph, join(testDir, 'b.ts'))
    assert.equal(reverse.size, 0)

    const reverseC = getReverseDeps(graph, join(testDir, 'c.ts'))
    assert.equal(reverseC.size, 1)
  })

  it('resolves index imports', () => {
    mkdirSync(join(testDir, 'mod'))
    writeFileSync(join(testDir, 'mod', 'index.ts'), `export const mod = 1\n`)
    writeFileSync(join(testDir, 'main.ts'), `import { mod } from './mod'\n`)

    const graph = buildImportGraph(testDir)!
    const reverse = getReverseDeps(graph, join(testDir, 'mod', 'index.ts'))
    assert.equal(reverse.size, 1)
  })
})
