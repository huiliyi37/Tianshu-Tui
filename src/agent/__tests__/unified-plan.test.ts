import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { validateUnifiedPlan, type UnifiedPlan, type UnifiedTaskNode } from '../unified-plan.js'

function node(over: Partial<UnifiedTaskNode> & { id: string }): UnifiedTaskNode {
  return {
    id: over.id,
    title: over.title ?? over.id,
    objective: over.objective ?? `do ${over.id}`,
    profile: over.profile ?? 'patcher',
    kind: over.kind ?? 'patch_proposal',
    files: over.files ?? [],
    dependsOn: over.dependsOn ?? [],
    riskTier: over.riskTier ?? 'medium',
    touchSet: over.touchSet,
  }
}

function plan(tasks: UnifiedTaskNode[]): UnifiedPlan {
  return { version: 1, objective: 'test mission', tasks, source: 'manual', createdAt: Date.now() }
}

describe('validateUnifiedPlan — orthogonal-shard advisories', () => {
  it('warns when two shards touch the same file without a dependency order', () => {
    const v = validateUnifiedPlan(plan([
      node({ id: 'S1', files: ['src/a.ts'] }),
      node({ id: 'S2', files: ['src/a.ts'] }),
    ]))
    assert.equal(v.valid, true, 'overlap is advisory, not blocking')
    assert.equal(v.warnings.length, 1)
    assert.match(v.warnings[0]!, /S1/)
    assert.match(v.warnings[0]!, /S2/)
    assert.match(v.warnings[0]!, /src\/a\.ts/)
  })

  it('does NOT warn when the overlapping shards are ordered via dependsOn', () => {
    const v = validateUnifiedPlan(plan([
      node({ id: 'S1', files: ['src/a.ts'] }),
      node({ id: 'S2', files: ['src/a.ts'], dependsOn: ['S1'] }),
    ]))
    assert.equal(v.valid, true)
    assert.equal(v.warnings.length, 0, 'explicit ordering suppresses the advisory')
  })

  it('treats transitive ordering as ordered (no warning)', () => {
    const v = validateUnifiedPlan(plan([
      node({ id: 'S1', files: ['src/a.ts'] }),
      node({ id: 'S2', files: ['src/b.ts'], dependsOn: ['S1'] }),
      node({ id: 'S3', files: ['src/a.ts'], dependsOn: ['S2'] }),
    ]))
    assert.equal(v.warnings.length, 0)
  })

  it('does NOT warn for orthogonal shards touching disjoint files', () => {
    const v = validateUnifiedPlan(plan([
      node({ id: 'S1', files: ['src/a.ts'] }),
      node({ id: 'S2', files: ['src/b.ts'] }),
      node({ id: 'S3', files: ['src/c.ts'] }),
    ]))
    assert.equal(v.valid, true)
    assert.equal(v.warnings.length, 0)
  })

  it('uses touchSet over files when present for overlap detection', () => {
    const v = validateUnifiedPlan(plan([
      node({ id: 'S1', files: ['src/a.ts'], touchSet: ['src/shared.ts'] }),
      node({ id: 'S2', files: ['src/b.ts'], touchSet: ['src/shared.ts'] }),
    ]))
    assert.equal(v.warnings.length, 1)
    assert.match(v.warnings[0]!, /src\/shared\.ts/)
  })
})
