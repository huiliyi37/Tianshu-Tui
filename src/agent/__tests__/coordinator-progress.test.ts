import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { DelegationCoordinator } from '../coordinator.js'
import type { WorkerSessionRun } from '../worker-session.js'
import type { ModelCapabilityCard } from '../../model/capability.js'

function createMinimalCoordinator(): DelegationCoordinator {
  const config = {
    baseToolRegistry: {
      get: () => undefined,
      list: () => [],
      filter: () => ({ get: () => undefined, list: () => [] }),
    } as any,
    modelCards: [] as ModelCapabilityCard[],
    maxWorkers: 2,
    runtimeFactory: () => ({}) as any,
    runWorker: async () => ({
      result: {
        workOrderId: 'test',
        status: 'passed' as const,
        summary: 'done',
        findings: [],
        artifacts: [],
        changedFiles: [],
        risks: [],
        nextActions: [],
        evidenceStatus: 'verified' as const,
      },
    }) as unknown as WorkerSessionRun,
  }
  return new DelegationCoordinator(config)
}

describe('DelegationCoordinator: onProgress callback', () => {
  it('calls onProgress after each worker completes', async () => {
    const coordinator = createMinimalCoordinator()
    const progressCalls: Array<{ completed: number; total: number }> = []
    const requests = [
      {
        parentTurnId: 'p1',
        objective: 'search for authentication middleware implementation details in the auth module',
        kind: 'code_search' as const,
        profile: 'code_scout' as const,
        scope: { files: ['src/auth.ts', 'src/middleware.ts'] },
      },
    ]
    const run = await coordinator.delegateBatch(
      requests,
      'primary_decides',
      undefined,
      (completed, total) => { progressCalls.push({ completed, total }) },
    )
    assert.strictEqual(run.status, 'completed')
    assert.ok(progressCalls.length >= 1, `expected >= 1 progress calls, got ${progressCalls.length}`)
  })

  it('onProgress is optional and does not break when omitted', async () => {
    const coordinator = createMinimalCoordinator()
    const requests = [
      {
        parentTurnId: 'p2',
        objective: 'search for database migration scripts and schema definitions across the project',
        kind: 'code_search' as const,
        profile: 'code_scout' as const,
        scope: { files: ['src/db/migrate.ts', 'src/db/schema.ts'] },
      },
    ]
    const run = await coordinator.delegateBatch(requests, 'primary_decides')
    assert.strictEqual(run.status, 'completed')
  })
})
