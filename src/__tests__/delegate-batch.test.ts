import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createDelegateBatchTool } from '../tools/delegate-batch.js'
import type { CoordinatorRun, DelegationRequest } from '../agent/coordinator.js'
import type { ClaimProposal } from '../context/claims.js'

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

  it('uses unique claim and evidence ids for batch findings', async () => {
    const proposals: ClaimProposal[] = []
    const tool = createDelegateBatchTool(
      {
        delegateBatch: async () => ({
          status: 'completed' as const,
          results: [0, 1].map(i => ({
            workOrderId: `wo-${i}`,
            status: 'passed' as const,
            summary: `Task ${i} done`,
            findings: [
              { claim: `finding-${i}-a`, evidence: 'test output a', confidence: 'high' as const },
              { claim: `finding-${i}-b`, evidence: 'test output b', confidence: 'medium' as const },
            ],
            artifacts: [],
            changedFiles: [],
            risks: [],
            nextActions: [],
            evidenceStatus: 'verified' as const,
          })),
          packet: '<worker_results>batch done</worker_results>',
        } as CoordinatorRun),
      },
      () => ({ propose: (proposal: ClaimProposal) => { proposals.push(proposal); return {} as never } }) as never,
      () => 'session-test',
    )

    await tool.execute({
      toolUseId: 'tu-batch-claims',
      cwd: '/tmp',
      input: {
        tasks: [
          { objective: 'search for auth patterns in src/agent', kind: 'code_search' },
          { objective: 'review error handling in src/tools', kind: 'review', profile: 'reviewer' },
        ],
      },
    })

    assert.equal(proposals.length, 4)
    assert.equal(new Set(proposals.map(p => p.source.eventId)).size, 4)
    assert.equal(new Set(proposals.map(p => p.evidence[0]!.id)).size, 4)
  })

  describe('progressive timeout', () => {
    const base = { input: {}, toolUseId: 'tu', cwd: '/tmp' }

    it('returns 45s for turn 0-1 (cold open)', () => {
      const tool = createDelegateBatchTool({ delegateBatch: async () => ({ status: 'completed', results: [], packet: '' }) as CoordinatorRun })
      assert.equal(tool.timeoutMs?.({ ...base, sessionTurnCount: 0 }), 45_000)
      assert.equal(tool.timeoutMs?.({ ...base, sessionTurnCount: 1 }), 45_000)
    })

    it('returns 90s for turn 2-4 (warming)', () => {
      const tool = createDelegateBatchTool({ delegateBatch: async () => ({ status: 'completed', results: [], packet: '' }) as CoordinatorRun })
      assert.equal(tool.timeoutMs?.({ ...base, sessionTurnCount: 2 }), 90_000)
      assert.equal(tool.timeoutMs?.({ ...base, sessionTurnCount: 4 }), 90_000)
    })

    it('returns 180s for turn 5+ (mature)', () => {
      const tool = createDelegateBatchTool({ delegateBatch: async () => ({ status: 'completed', results: [], packet: '' }) as CoordinatorRun })
      assert.equal(tool.timeoutMs?.({ ...base, sessionTurnCount: 5 }), 180_000)
      assert.equal(tool.timeoutMs?.({ ...base, sessionTurnCount: 20 }), 180_000)
    })

    it('defaults to mature (180s) when sessionTurnCount is undefined', () => {
      const tool = createDelegateBatchTool({ delegateBatch: async () => ({ status: 'completed', results: [], packet: '' }) as CoordinatorRun })
      assert.equal(tool.timeoutMs?.(base), 180_000)
      assert.equal(tool.timeoutMs?.(), 180_000)
    })
  })
})
