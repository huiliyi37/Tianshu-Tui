import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  validateUnifiedPlan,
  taskGraphToUnifiedPlan,
  unifiedPlanToTaskGraph,
  unifiedPlanToTeamTasks,
  serializeUnifiedPlan,
  deserializeUnifiedPlan,
  type UnifiedPlan,
  type UnifiedTaskNode,
} from '../unified-plan.js'
import { validateTaskGraph } from '../task-graph.js'

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

// ── 条件依赖边（收编 #6）— RED：UnifiedPlan 通道目前丢失 onFailure/alternateOrderId ──

/** 条件依赖边对象（dependsOn 当前类型为 string[]，运行时可由 JSON 携带对象，
 *  测试用 cast 注入以模拟 plan_task 产出含边 JSON 的现实）。 */
const EDGE_SKIP = { dependsOn: 'T1', onFailure: 'skip' } as const
const EDGE_ALT = { dependsOn: 'T2', onFailure: 'alternate', alternateOrderId: 'T1' } as const

describe('conditional dependency edges — UnifiedPlan round-trip fidelity', () => {
  it('validateUnifiedPlan treats conditional edges by primary id (valid, not "unknown task")', () => {
    const v = validateUnifiedPlan(plan([
      node({ id: 'T1' }),
      node({ id: 'T2', dependsOn: [EDGE_SKIP] as unknown as string[] }),
      node({ id: 'T3', dependsOn: [EDGE_ALT] as unknown as string[] }),
    ]))
    assert.equal(v.valid, true, `expected valid, got: ${JSON.stringify(v)}`)
    assert.equal(v.nodeErrors.length, 0)
    assert.equal(v.errors.length, 0)
  })

  it('unifiedPlanToTaskGraph maps conditional edges to primary ids (TaskGraph stays string-only)', () => {
    const graph = unifiedPlanToTaskGraph(plan([
      node({ id: 'T1' }),
      node({ id: 'T2', dependsOn: [EDGE_SKIP] as unknown as string[] }),
    ]))
    assert.deepEqual(graph.nodes[1]!.dependsOn, ['T1'])
    assert.ok(graph.nodes[1]!.dependsOn.every(d => typeof d === 'string'))
    assert.equal(validateTaskGraph(graph).valid, true)
  })

  it('taskGraphToUnifiedPlan round-trip keeps primary dependency ids when edges are dropped', () => {
    const back = taskGraphToUnifiedPlan(unifiedPlanToTaskGraph(plan([
      node({ id: 'T1' }),
      node({ id: 'T2', dependsOn: [EDGE_SKIP] as unknown as string[] }),
    ])))
    // TaskGraph is string-only: edge metadata cannot survive, but the primary
    // dependency must — never a mangled object or phantom dangling dep.
    assert.deepEqual(back.tasks[1]!.dependsOn, ['T1'])
  })

  it('unifiedPlanToTeamTasks round-trips full edge objects (full-fidelity path)', () => {
    const tasks = unifiedPlanToTeamTasks(plan([
      node({ id: 'T1' }),
      node({ id: 'T2', dependsOn: [EDGE_SKIP] as unknown as string[] }),
      node({ id: 'T3', dependsOn: [EDGE_ALT] as unknown as string[] }),
    ]))
    assert.deepEqual(tasks[1]!.dependsOn, [{ dependsOn: 'T1', onFailure: 'skip' }])
    assert.deepEqual(tasks[2]!.dependsOn, [{ dependsOn: 'T2', onFailure: 'alternate', alternateOrderId: 'T1' }])
  })

  it('deserializeUnifiedPlan round-trips edge objects and rejects malformed dep entries', () => {
    const good = plan([
      node({ id: 'T1' }),
      node({ id: 'T2', dependsOn: [EDGE_ALT] as unknown as string[] }),
    ])
    const back = deserializeUnifiedPlan(serializeUnifiedPlan(good))
    assert.ok(back, 'edge objects must survive serialize → deserialize')
    assert.deepEqual(back!.tasks[1]!.dependsOn, [{ dependsOn: 'T2', onFailure: 'alternate', alternateOrderId: 'T1' }])

    // Malformed entries (missing/非字符串 dependsOn) must be rejected at the
    // boundary instead of crashing downstream consumers.
    const badNum = plan([node({ id: 'T1' }), node({ id: 'T2', dependsOn: [{ dependsOn: 42 }] as unknown as string[] })])
    assert.equal(deserializeUnifiedPlan(serializeUnifiedPlan(badNum)), null, 'numeric dependsOn must be rejected')
    const badShape = plan([node({ id: 'T1' }), node({ id: 'T2', dependsOn: [{ nope: 'x' }] as unknown as string[] })])
    assert.equal(deserializeUnifiedPlan(serializeUnifiedPlan(badShape)), null, 'object without string dependsOn must be rejected')
  })
})
