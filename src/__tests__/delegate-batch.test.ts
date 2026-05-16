import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createDelegateBatchTool } from '../tools/delegate-batch.js'
import type { CoordinatorRun, DelegationRequest } from '../agent/coordinator.js'

describe('delegate_batch tool', () => {
  it('delegates multiple tasks and returns combined packet', async () => {
    let batchCaptured: DelegationRequest[] = []
    const tool = createDelegateBatchTool({
      delegateBatch: async (requests) => {
        batchCaptured = requests
        return {
          status: 'completed' as const,
          results: requests.map((_, i) => ({
            workOrderId: `wo-${i}`,
            status: 'passed' as const,
            summary: `Task ${i} done`,
            findings: [{ claim: `finding-${i}`, evidence: 'test output', confidence: 'high' as const }],
            artifacts: [],
            changedFiles: [],
            risks: [],
            nextActions: [],
            evidenceStatus: 'verified' as const,
          })),
          packet: '<worker_results>batch done</worker_results>',
        } as CoordinatorRun
      },
    })

    const result = await tool.execute({
      toolUseId: 'tu-batch-1',
      cwd: '/tmp',
      input: {
        tasks: [
          { objective: 'search for auth patterns in src/agent', kind: 'code_search' },
          { objective: 'review error handling in src/tools', kind: 'review', profile: 'reviewer' },
        ],
      },
    })

    assert.equal(batchCaptured.length, 2)
    assert.equal(batchCaptured[0]!.kind, 'code_search')
    assert.equal(batchCaptured[1]!.kind, 'review')
    assert.equal(result.isError, false)
  })
})
