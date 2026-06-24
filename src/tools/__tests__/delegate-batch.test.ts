import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createDelegateBatchTool, type DelegateBatchCoordinator } from '../delegate-batch.js'
import type { CoordinatorRun, DelegationRequest } from '../../agent/coordinator.js'
import { aggregationPolicySchema, workOrderKindSchema, type AggregationPolicy } from '../../agent/work-order.js'

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
    assert.deepEqual(schema.properties.policy.enum, [...aggregationPolicySchema.options])
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

  it('exposes dependsOn in the task schema', () => {
    const tool = createDelegateBatchTool({ delegateBatch: async () => makeRun() })
    const schema = tool.definition.input_schema as any
    assert.equal(schema.properties.tasks.items.properties.dependsOn.type, 'array')
    assert.equal(schema.properties.tasks.items.properties.dependsOn.items.type, 'integer')
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

  it('rejects out-of-range dependsOn indices', async () => {
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
    assert.match(String(result.content), /out-of-range/)
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
          { objective: 'Second task incorrectly depends on itself here.', dependsOn: [1] },
        ],
      },
    })
    assert.equal(result.isError, true)
    assert.match(String(result.content), /depends on itself/)
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
})
