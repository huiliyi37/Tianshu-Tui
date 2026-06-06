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
})
