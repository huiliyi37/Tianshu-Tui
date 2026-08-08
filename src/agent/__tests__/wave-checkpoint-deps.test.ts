import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { buildResumeFromCheckpoint, type WaveCheckpoint } from '../wave-checkpoint.js'
import { deserializeUnifiedPlan } from '../unified-plan.js'
import type { DependencyEdge } from '../work-order.js'

function order(id: string, dependsOn?: Array<string | DependencyEdge>) {
  return {
    id,
    objective: `do ${id}`,
    profile: 'patcher' as const,
    kind: 'patch_proposal' as const,
    scope: { files: [`src/${id}.ts`] },
    authority: 'tianliang',
    ...(dependsOn ? { dependsOn } : {}),
  }
}

function checkpoint(remaining: ReturnType<typeof order>[]): WaveCheckpoint {
  return {
    groupId: 'team-abc',
    timestamp: 1,
    lastCompletedWave: 0,
    completedResults: [],
    remainingOrders: remaining,
    objective: 'multi-wave objective',
    totalWaves: 3,
  }
}

function tasksOf(cp: WaveCheckpoint) {
  const resumed = buildResumeFromCheckpoint(cp)
  assert.ok(resumed, 'resume should produce a plan')
  const plan = deserializeUnifiedPlan(resumed.planJson)
  assert.ok(plan, 'resumed plan must deserialize')
  return plan.tasks
}

describe('checkpoint 恢复保住剩余任务之间的依赖', () => {
  // 此前 buildResumeFromCheckpoint 恒写 dependsOn: []，剩余任务的显式顺序
  // 在 /team-resume 后全部丢失，只能靠同文件串行等启发式反推。
  test('剩余任务之间的普通依赖被保留', () => {
    const tasks = tasksOf(checkpoint([order('T2'), order('T3', ['T2'])]))
    const t3 = tasks.find(t => t.id === 'T3')
    assert.deepEqual(t3?.dependsOn, ['T2'])
  })

  test('条件边（onFailure=skip）保真', () => {
    const edge: DependencyEdge = { dependsOn: 'T2', onFailure: 'skip' }
    const tasks = tasksOf(checkpoint([order('T2'), order('T3', [edge])]))
    const t3 = tasks.find(t => t.id === 'T3')
    assert.deepEqual(t3?.dependsOn, [edge])
  })

  test('条件边（onFailure=alternate）连备选 id 一起保真', () => {
    const edge: DependencyEdge = { dependsOn: 'T2', onFailure: 'alternate', alternateOrderId: 'T4' }
    const tasks = tasksOf(checkpoint([order('T2'), order('T4'), order('T3', [edge])]))
    const t3 = tasks.find(t => t.id === 'T3')
    assert.deepEqual(t3?.dependsOn, [edge])
  })

  test('多条依赖全部保留', () => {
    const tasks = tasksOf(checkpoint([order('T1'), order('T2'), order('T3', ['T1', 'T2'])]))
    const t3 = tasks.find(t => t.id === 'T3')
    assert.deepEqual(t3?.dependsOn, ['T1', 'T2'])
  })
})

describe('checkpoint 恢复剥掉已完成的依赖', () => {
  // 被依赖方已在前面的波跑完 → 不在 remainingOrders 里。留着这条边会让
  // validateUnifiedPlan 判 dangling 而拒绝整份计划；剥掉等价于「依赖已满足」。
  test('指向已完成任务的依赖被剥掉，不产生 dangling', () => {
    const tasks = tasksOf(checkpoint([order('T3', ['T1'])])) // T1 已完成，不在 remaining
    const t3 = tasks.find(t => t.id === 'T3')
    assert.deepEqual(t3?.dependsOn, [])
  })

  test('混合场景：已完成的被剥、未完成的保留', () => {
    const tasks = tasksOf(checkpoint([order('T2'), order('T3', ['T1', 'T2'])]))
    const t3 = tasks.find(t => t.id === 'T3')
    assert.deepEqual(t3?.dependsOn, ['T2'], 'T1 已完成应被剥，T2 仍在剩余中应保留')
  })

  test('指向已完成任务的条件边同样被剥', () => {
    const edge: DependencyEdge = { dependsOn: 'T1', onFailure: 'skip' }
    const tasks = tasksOf(checkpoint([order('T3', [edge])]))
    assert.deepEqual(tasks.find(t => t.id === 'T3')?.dependsOn, [])
  })
})

describe('checkpoint 恢复的向后兼容', () => {
  test('旧 checkpoint 无 dependsOn 字段时按空依赖处理，不抛错', () => {
    const tasks = tasksOf(checkpoint([order('T2'), order('T3')]))
    for (const t of tasks) assert.deepEqual(t.dependsOn, [])
  })

  test('remainingOrders 为空时仍返回 null（无可续跑内容）', () => {
    assert.equal(buildResumeFromCheckpoint(checkpoint([])), null)
  })

  test('恢复出的计划仍可被 deserializeUnifiedPlan 正常解析', () => {
    const resumed = buildResumeFromCheckpoint(checkpoint([order('T2'), order('T3', ['T2'])]))
    assert.ok(resumed)
    const plan = deserializeUnifiedPlan(resumed.planJson)
    assert.ok(plan)
    assert.equal(plan.objective, 'multi-wave objective')
    assert.equal(plan.tasks.length, 2)
    assert.equal(plan.source, 'team_orchestrate')
  })
})
