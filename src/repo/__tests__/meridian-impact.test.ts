import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { MeridianDb } from '../meridian-db.js'
import { analyzeImpact, inferTestedByTargets } from '../meridian-impact.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

describe('meridian impact', () => {
  let db: MeridianDb
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'meridian-impact-'))
    db = new MeridianDb(tmpDir)
  })

  afterEach(() => {
    db.close()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  function setupGraph() {
    // Graph: app.ts imports auth.ts imports db.ts
    //        ui.ts imports auth.ts
    //        auth.test.ts tested_by auth.ts
    db.upsertEdge('app.ts:main:1', 'auth.ts:login:1', 'imports', 1.0)
    db.upsertEdge('auth.ts:login:1', 'db.ts:query:1', 'imports', 1.0)
    db.upsertEdge('ui.ts:render:1', 'auth.ts:login:1', 'imports', 1.0)
    db.upsertEdge('auth.test.ts:*:0', 'auth.ts:*:0', 'tested_by', 0.7)
  }

  it('finds direct dependents via reverse BFS', () => {
    setupGraph()
    const result = analyzeImpact(db, ['auth.ts'])
    assert.ok(result.direct.includes('app.ts'))
    assert.ok(result.direct.includes('ui.ts'))
    // auth.test.ts also shows up as direct dependent via tested_by edge
    assert.ok(result.direct.length >= 2)
  })

  it('finds transitive dependents at hop 2+', () => {
    setupGraph()
    // Change db.ts → auth.ts is direct, app.ts/ui.ts are transitive
    const result = analyzeImpact(db, ['db.ts'])
    assert.ok(result.direct.includes('auth.ts'))
    assert.ok(result.transitive.includes('app.ts') || result.transitive.includes('ui.ts'))
  })

  it('finds tests for changed files', () => {
    setupGraph()
    const result = analyzeImpact(db, ['auth.ts'])
    assert.ok(result.tests.includes('auth.test.ts'))
  })

  it('returns empty for leaf files with no dependents', () => {
    setupGraph()
    const result = analyzeImpact(db, ['app.ts'])
    assert.equal(result.totalImpact, 0)
  })

  it('respects maxHops limit', () => {
    setupGraph()
    const result = analyzeImpact(db, ['db.ts'], { maxHops: 1 })
    // Only 1 hop: auth.ts is direct, app.ts/ui.ts not reached
    assert.ok(result.direct.includes('auth.ts'))
    assert.equal(result.transitive.length, 0)
  })

  it('finds tests via co-edit neighbors', () => {
    setupGraph()
    // auth.ts was co-edited with auth.test.ts
    db.recordCoEdit('auth.ts', 'auth.test.ts', 1)
    const result = analyzeImpact(db, ['auth.ts'])
    assert.ok(result.tests.includes('auth.test.ts'))
  })

  it('handles multiple changed files', () => {
    setupGraph()
    const result = analyzeImpact(db, ['auth.ts', 'db.ts'])
    // auth.ts dependents + db.ts dependents (auth.ts already in changed set)
    assert.ok(result.direct.includes('app.ts'))
    assert.ok(result.direct.includes('ui.ts'))
  })
})

describe('inferTestedByTargets', () => {
  const allFiles = [
    'src/auth/login.ts',
    'src/auth/__tests__/login.test.ts',
    'src/utils.ts',
    'src/utils.spec.ts',
    'test/utils.test.ts',
  ]

  it('matches test file to source by name', () => {
    const targets = inferTestedByTargets('src/auth/__tests__/login.test.ts', allFiles)
    assert.ok(targets.includes('src/auth/login.ts'))
  })

  it('does not match non-test files', () => {
    const targets = inferTestedByTargets('src/auth/login.ts', allFiles)
    assert.equal(targets.length, 0)
  })

  it('matches spec files', () => {
    const targets = inferTestedByTargets('src/utils.spec.ts', allFiles)
    assert.ok(targets.includes('src/utils.ts'))
  })

  it('does not match test to test', () => {
    const targets = inferTestedByTargets('test/utils.test.ts', allFiles)
    // Should match src/utils.ts but not src/utils.spec.ts
    assert.ok(targets.includes('src/utils.ts'))
    assert.ok(!targets.includes('src/utils.spec.ts'))
  })
})
