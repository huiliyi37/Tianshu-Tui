import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createDelegateBatchTool, type DelegateBatchCoordinator } from '../delegate-batch.js'
import type { CoordinatorRun, DelegationRequest } from '../../agent/coordinator.js'
import { aggregationPolicyKinds, workOrderKindSchema, type AggregationPolicy } from '../../agent/work-order.js'

function makeRun(): CoordinatorRun {
  return {
    status: 'completed',
    results: [{
      workOrderId: 'wo_1',
      status: 'passed',
      summary: 'Worker completed.',
      findings: [],
      artifacts: [],
      changedFiles: [],
      risks: [],
      nextActions: [],
      evidenceStatus: 'verified',
    }],
    packet: '<worker_results>packet</worker_results>',
  }
}

describe('DELEGATE_BATCH_TOOL', () => {
  it('exposes work-order kind and aggregation policy enums from the work-order schema', () => {
    const tool = createDelegateBatchTool({ delegateBatch: async () => makeRun() })
    const schema = tool.definition.input_schema as any
    const taskProperties = schema.properties.tasks.items.properties

    assert.deepEqual(taskProperties.kind.enum, [...workOrderKindSchema.options])
    assert.deepEqual(schema.properties.policy.enum, [...aggregationPolicyKinds])
    assert.ok(schema.properties.policy.enum.includes('weighted_confidence'))
  })

  it('accepts schema-backed batch policy and forwards task kind', async () => {
    const calls: Array<{ requests: DelegationRequest[]; policy?: AggregationPolicy }> = []
    const coordinator: DelegateBatchCoordinator = {
      delegateBatch: async (requests, policy) => {
        calls.push({ requests, policy })
        return makeRun()
      },
    }
    const tool = createDelegateBatchTool(coordinator)

    const result = await tool.execute({
      toolUseId: 'tu_batch',
      cwd: '/repo',
      sessionTurnCount: 5,
      reviewDepth: 2,
      input: {
        tasks: [{ objective: 'Verify the unit test seam thoroughly.', kind: 'verify', profile: 'verifier' }],
        policy: 'weighted_confidence',
      },
    })

    assert.equal(result.isError, false)
    assert.equal(calls[0]?.policy, 'weighted_confidence')
    assert.equal(calls[0]?.requests[0]?.kind, 'verify')
    assert.equal(calls[0]?.requests[0]?.reviewDepth, 2)
  })

  it('终态事件透传派发侧身份（authority/profile）——完成后面板星域不断流', async () => {
    const terminalEvents: Array<{ status?: string; authority?: string; profile?: string }> = []
    const coordinator: DelegateBatchCoordinator = {
      delegateBatch: async (requests, _policy, _signal, _onProgress, onWorkerSettled) => {
        const run: CoordinatorRun = {
          status: 'completed',
          results: requests.map((r, i) => ({
            workOrderId: `batch:${i}`,
            status: 'passed' as const,
            summary: 'Worker completed.',
            findings: [],
            artifacts: [],
            changedFiles: [],
            risks: [],
            nextActions: [],
            evidenceStatus: 'verified' as const,
            // coordinator 盖章的派发侧身份（workerResultSchema.profile/authority）
            profile: r.profile,
            authority: r.authority,
          })),
          packet: '<worker_results>packet</worker_results>',
        }
        for (const r of run.results) onWorkerSettled?.(r)
        return run
      },
    }
    const tool = createDelegateBatchTool(coordinator)

    const result = await tool.execute({
      toolUseId: 'tu_terminal',
      cwd: '/repo',
      sessionTurnCount: 5,
      input: {
        tasks: [{ objective: 'Verify the seam.', kind: 'verify', profile: 'verifier', authority: 'yaoguang' }],
      },
      onWorkerActivity: (ev: any) => { if (ev.status && ev.status !== 'running') terminalEvents.push(ev) },
    } as any)

    assert.equal(result.isError, false)
    // dual-emission contract：settle 即发 + 批末兜底重放（fleet 层去重），条数 ≥1；
    // 这里钉的是身份透传——每条终态都必须带派发侧 authority/profile。
    assert.ok(terminalEvents.length >= 1, '必须发出终态事件')
    assert.ok(terminalEvents.every(e => e.authority === 'yaoguang'), '终态事件必须透传 authority')
    assert.ok(terminalEvents.every(e => e.profile === 'verifier'), '终态事件必须透传 profile')
  })

  it('exposes dependsOn in the task schema', () => {
    const tool = createDelegateBatchTool({ delegateBatch: async () => makeRun() })
    const schema = tool.definition.input_schema as any
    assert.equal(schema.properties.tasks.items.properties.dependsOn.type, 'array')
    // 收编 #6：dependsOn 支持数字索引或条件边对象
    const items = schema.properties.tasks.items.properties.dependsOn.items
    assert.ok(items.anyOf, 'dependsOn items 应为 anyOf（整数索引 | 条件边对象）')
    assert.equal(items.anyOf[0].type, 'integer')
    assert.equal(items.anyOf[1].properties.onFailure.enum.join(','), 'skip,alternate')
  })

  it('maps dependsOn indices to stable batch:N dependency ids and stable parentTurnId', async () => {
    const calls: Array<{ requests: DelegationRequest[] }> = []
    const coordinator: DelegateBatchCoordinator = {
      delegateBatch: async (requests) => { calls.push({ requests }); return makeRun() },
    }
    const tool = createDelegateBatchTool(coordinator)

    const result = await tool.execute({
      toolUseId: 'tu_dep',
      cwd: '/repo',
      sessionTurnCount: 5,
      input: {
        tasks: [
          { objective: 'Refactor the source module under review.' },
          { objective: 'Write tests for the refactored source module.', dependsOn: [0] },
        ],
      },
    })

    assert.equal(result.isError, false)
    const reqs = calls[0]!.requests
    assert.equal(reqs[0]?.parentTurnId, 'tu_dep:batch:0')
    assert.equal(reqs[1]?.parentTurnId, 'tu_dep:batch:1')
    assert.equal(reqs[0]?.dependencies, undefined)
    assert.deepEqual(reqs[1]?.dependencies, ['batch:0'])
  })

  it('maps conditional dependsOn edges to DependencyEdge objects（收编 #6 入口）', async () => {
    const calls: Array<{ requests: DelegationRequest[] }> = []
    const coordinator: DelegateBatchCoordinator = {
      delegateBatch: async (requests) => { calls.push({ requests }); return makeRun() },
    }
    const tool = createDelegateBatchTool(coordinator)

    const result = await tool.execute({
      toolUseId: 'tu_edge',
      cwd: '/repo',
      sessionTurnCount: 5,
      input: {
        tasks: [
          { objective: 'Refactor the source module under review.' },
          { objective: 'Fallback exploration task for alternate routing.' },
          { objective: 'Write tests for the refactored source module.', dependsOn: [{ index: 0, onFailure: 'alternate', alternateOrderId: 1 }] },
          { objective: 'Lint the module after upstream completes.', dependsOn: [{ index: 0, onFailure: 'skip' }] },
        ],
      },
    })

    assert.equal(result.isError, false)
    const reqs = calls[0]!.requests
    assert.deepEqual(reqs[3]?.dependencies, [{ dependsOn: 'batch:0', onFailure: 'skip' }])
    assert.deepEqual(reqs[2]?.dependencies, [{ dependsOn: 'batch:0', onFailure: 'alternate', alternateOrderId: 'batch:1' }])
  })

  it('rejects conditional edges with out-of-range index / self-reference / bad alternateOrderId', async () => {
    const tool = createDelegateBatchTool({ delegateBatch: async () => makeRun() })

    const badIndex = await tool.execute({
      toolUseId: 'tu_edge_bad',
      cwd: '/repo',
      sessionTurnCount: 5,
      input: {
        tasks: [
          { objective: 'Only task in this batch.' },
          { objective: 'Depends on nonexistent task.', dependsOn: [{ index: 5, onFailure: 'skip' }] },
        ],
      },
    })
    assert.equal(badIndex.isError, true)
    assert.match(String(badIndex.content), /越界/)

    const selfRef = await tool.execute({
      toolUseId: 'tu_edge_self',
      cwd: '/repo',
      sessionTurnCount: 5,
      input: {
        tasks: [
          { objective: 'First task does standalone work here.' },
          { objective: 'Second task depends on itself.', dependsOn: [{ index: 1, onFailure: 'skip' }] },
        ],
      },
    })
    assert.equal(selfRef.isError, true)
    assert.match(String(selfRef.content), /依赖了自身/)

    const badAlt = await tool.execute({
      toolUseId: 'tu_edge_alt',
      cwd: '/repo',
      sessionTurnCount: 5,
      input: {
        tasks: [
          { objective: 'Upstream task that will fail.' },
          { objective: 'Alternate fallback task.' },
          { objective: 'Dependent with out-of-range alternate.', dependsOn: [{ index: 0, onFailure: 'alternate', alternateOrderId: 9 }] },
        ],
      },
    })
    assert.equal(badAlt.isError, true)
    assert.match(String(badAlt.content), /越界/)
  })

  it('rejects 越界索引 dependsOn indices', async () => {
    const tool = createDelegateBatchTool({ delegateBatch: async () => makeRun() })
    const result = await tool.execute({
      toolUseId: 'tu_bad',
      cwd: '/repo',
      sessionTurnCount: 5,
      input: {
        tasks: [
          { objective: 'Only task in this batch, no upstream exists.', dependsOn: [3] },
        ],
      },
    })
    assert.equal(result.isError, true)
    assert.match(String(result.content), /越界索引/)
  })

  it('rejects self-referential dependsOn', async () => {
    const tool = createDelegateBatchTool({ delegateBatch: async () => makeRun() })
    const result = await tool.execute({
      toolUseId: 'tu_self',
      cwd: '/repo',
      sessionTurnCount: 5,
      input: {
        tasks: [
          { objective: 'First task does standalone work here.' },
          { objective: 'Second task incorrectly 依赖了自身 here.', dependsOn: [1] },
        ],
      },
    })
    assert.equal(result.isError, true)
    assert.match(String(result.content), /依赖了自身/)
  })

  it('passes resume param through to the coordinator for each task', async () => {
    const calls: Array<{ requests: DelegationRequest[] }> = []
    const coordinator: DelegateBatchCoordinator = {
      delegateBatch: async (requests) => { calls.push({ requests }); return makeRun() },
    }
    const tool = createDelegateBatchTool(coordinator)

    await tool.execute({
      toolUseId: 'tu_resume',
      cwd: '/repo',
      sessionTurnCount: 5,
      input: {
        tasks: [
          { objective: 'Continue the previous search task.', resume: 'wo_abc' },
          { objective: 'Fresh task without resume.' },
        ],
      },
    })

    const reqs = calls[0]!.requests
    assert.equal(reqs[0]?.resumeWorkOrderId, 'wo_abc', 'first task should have resume id')
    assert.equal(reqs[1]?.resumeWorkOrderId, undefined, 'second task should not have resume')
  })

  it('bypasses the progressive task cap when dependencies are declared', async () => {
    const calls: Array<{ requests: DelegationRequest[] }> = []
    const coordinator: DelegateBatchCoordinator = {
      delegateBatch: async (requests) => { calls.push({ requests }); return makeRun() },
    }
    const tool = createDelegateBatchTool(coordinator)

    // sessionTurnCount 0 → progressiveTaskCap = 1; without deps this would trim
    // to a single task. With a declared dependency the full chain must dispatch.
    const result = await tool.execute({
      toolUseId: 'tu_cap',
      cwd: '/repo',
      sessionTurnCount: 0,
      input: {
        tasks: [
          { objective: 'Upstream task that produces the artifact for others.' },
          { objective: 'Midstream task consuming the upstream artifact now.', dependsOn: [0] },
          { objective: 'Downstream task consuming the midstream result now.', dependsOn: [1] },
        ],
      },
    })

    assert.equal(result.isError, false)
    assert.equal(calls[0]?.requests.length, 3)
  })

  it('still applies the progressive task cap when no dependencies are declared', async () => {
    const calls: Array<{ requests: DelegationRequest[] }> = []
    const coordinator: DelegateBatchCoordinator = {
      delegateBatch: async (requests) => { calls.push({ requests }); return makeRun() },
    }
    const tool = createDelegateBatchTool(coordinator)

    const result = await tool.execute({
      toolUseId: 'tu_nocap',
      cwd: '/repo',
      sessionTurnCount: 0,
      input: {
        tasks: [
          { objective: 'First independent scouting task to run now.' },
          { objective: 'Second independent scouting task to run now.' },
          { objective: 'Third independent scouting task to run now.' },
        ],
      },
    })

    assert.equal(result.isError, false)
    assert.equal(calls[0]?.requests.length, 1)
  })

  describe('按次预算（Wave 9）', () => {
    it('逐任务的 maxTurns / timeoutMs 透传成各自的 budget 覆盖', async () => {
      const calls: Array<{ requests: DelegationRequest[] }> = []
      const tool = createDelegateBatchTool({
        delegateBatch: async requests => { calls.push({ requests }); return makeRun() },
      })

      await tool.execute({
        toolUseId: 'tu_budget',
        cwd: '/repo',
        sessionTurnCount: 10,
        input: {
          tasks: [
            { objective: '只查一个入口在哪，给点预算就够。', maxTurns: 6 },
            { objective: '扫一遍整个模块的调用关系，慢慢来。', timeoutMs: 900_000 },
            { objective: '按 profile 默认预算跑就行，不做覆盖。' },
          ],
        },
      })

      assert.deepEqual(calls[0]?.requests[0]?.budget, { maxTurns: 6 })
      assert.deepEqual(calls[0]?.requests[1]?.budget, { timeoutMs: 900_000 })
      assert.equal(calls[0]?.requests[2]?.budget, undefined)
    })

    it('外层工具超时覆盖批内最大的按次 timeoutMs', () => {
      const tool = createDelegateBatchTool({ delegateBatch: async () => makeRun() })
      const withOverride = tool.timeoutMs?.({
        toolUseId: 'tu', cwd: '/repo', sessionTurnCount: 0,
        input: { tasks: [{ objective: 'a' }, { objective: 'b', timeoutMs: 900_000 }] },
      })!
      const withoutOverride = tool.timeoutMs?.({
        toolUseId: 'tu', cwd: '/repo', sessionTurnCount: 0,
        input: { tasks: [{ objective: 'a' }, { objective: 'b' }] },
      })!
      assert.ok(withOverride > withoutOverride, '调大的内层预算必须先抬高外层天花板')
      assert.ok(withOverride >= 900_000, '外层至少覆盖单个任务的按次预算')
    })
  })
})
