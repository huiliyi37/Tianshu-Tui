import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { generateImpactHint } from '../impact-hint.js'
import { buildImportGraph } from '../import-graph.js'

describe('generateImpactHint', () => {
  let testDir: string

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'rivet-ih-'))
  })

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true })
  })

  it('returns null when graph is null', () => {
    const result = generateImpactHint(null, 'a.ts', testDir)
    assert.equal(result, null)
  })

  it('returns null when no impacted files', () => {
    writeFileSync(join(testDir, 'a.ts'), `export const a = 1\n`)
    writeFileSync(join(testDir, 'b.ts'), `export const b = 2\n`)
    const graph = buildImportGraph(testDir)!
    const result = generateImpactHint(graph, join(testDir, 'a.ts'), testDir)
    assert.equal(result, null)
  })

  it('finds impacted files and tests', () => {
    writeFileSync(join(testDir, 'mod.ts'), `export const mod = 1\n`)
    writeFileSync(join(testDir, 'consumer.ts'), `import { mod } from './mod'\n`)
    mkdirSync(join(testDir, '__tests__'))
    writeFileSync(join(testDir, '__tests__', 'consumer.test.ts'), `import { mod } from '../mod'\n`)

    const graph = buildImportGraph(testDir)!
    const result = generateImpactHint(graph, join(testDir, 'mod.ts'), testDir)

    assert.ok(result !== null)
    assert.equal(result!.impactedFiles.length, 1)
    assert.ok(result!.impactedFiles[0]!.endsWith('consumer.ts'))
    assert.ok(result!.relatedTests.length >= 1)
    assert.ok(result!.summary.includes('mod.ts'))
    assert.ok(result!.summary.includes('consumer'))
  })
})
