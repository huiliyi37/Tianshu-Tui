import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createCoordinatorReviewDeps, type ReviewCoordinator } from '../review-coordinator-deps.js'
import type { CoordinatorRun, DelegationRequest } from '../coordinator.js'
import type { WorkerResult } from '../work-order.js'

function worker(overrides: Partial<WorkerResult> = {}): WorkerResult {
  return {
    workOrderId: 'wo-test',
    status: 'passed',
    summary: 'verified with tests',
    findings: [],
    artifacts: [],
    changedFiles: [],
    risks: [],
    nextActions: [],
    evidenceStatus: 'verified',
    ...overrides,
  }
}

function run(results: WorkerResult[], status: CoordinatorRun['status'] = 'completed'): CoordinatorRun {
  return {
    status,
    results,
    packet: results.map(result => result.summary).join('\n'),
  }
}

describe('createCoordinatorReviewDeps', () => {
  it('spawns adversarial verifier with review-depth guard and maps verified evidence', async () => {
    let captured: DelegationRequest | undefined
    const coordinator: ReviewCoordinator = {
      delegate: async request => {
        captured = request
        return run([worker({
          verification: {
            command: 'npm exec -- tsx --test src/agent/__tests__/deliver-task.test.ts',
            status: 'passed',
            scope: 'targeted',
            exitCode: 0,
            passed: 61,
            failed: 0,
            skipped: 0,
            durationMs: 537,
          },
        })])
      },
    }

    const deps = createCoordinatorReviewDeps(coordinator, { parentTurnId: 'turn-1', reviewDepth: 2 })
    const result = await deps.spawnVerifier({ files: ['src/agent/deliver-task.ts'], crossModule: false, isFix: true })

    assert.equal(captured?.parentTurnId, 'turn-1')
    assert.equal(captured?.profile, 'adversarial_verifier')
    assert.equal(captured?.kind, 'verify')
    assert.equal(captured?.reviewDepth, 3)
    assert.deepEqual(captured?.scope.files, ['src/agent/deliver-task.ts'])
    assert.match(captured?.objective ?? '', /Review depth: 3/)
    assert.match(captured?.objective ?? '', /Do not call deliver_task/)
    assert.match(captured?.objective ?? '', /Objective review stance/)
    assert.match(captured?.objective ?? '', /主动构造反例/)
    assert.match(captured?.objective ?? '', /Dataflow verifier stance/)
    assert.match(captured?.objective ?? '', /fact-flow graph/)
    assert.match(captured?.objective ?? '', /condition-matrix coverage/)
    assert.match(captured?.objective ?? '', /checklist-only implementation/)
    assert.match(captured?.objective ?? '', /Path boundary \/ attention-gate review stance/)
    assert.match(captured?.objective ?? '', /repo-relative.*absolute inside cwd.*absolute outside cwd.*\.\.\/ traversal/)
    assert.match(captured?.objective ?? '', /producer.*normalizer.*classifier.*consumer.*DB key.*assertion/)
    assert.match(captured?.objective ?? '', /显式目标.*默认发现/)
    assert.match(captured?.objective ?? '', /Do not stop at green tests/)
    assert.equal(result.verdict, 'verified')
    assert.match(result.evidence, /ran: npm exec -- tsx --test/)
    assert.match(result.evidence, /61 passed/)
  })

  it('maps unverified verifier result to rejected', async () => {
    const coordinator: ReviewCoordinator = {
      delegate: async () => run([worker({ evidenceStatus: 'unverified', summary: 'read code only' })]),
    }

    const deps = createCoordinatorReviewDeps(coordinator)
    const result = await deps.spawnVerifier({ files: ['src/a.ts'], crossModule: false, isFix: true })

    assert.equal(result.verdict, 'rejected')
    assert.match(result.evidence, /read code only/)
  })

  it('spawns patcher and reports patched only when a patch was produced', async () => {
    const requests: DelegationRequest[] = []
    const coordinator: ReviewCoordinator = {
      delegate: async request => {
        requests.push(request)
        return run([worker({
          summary: 'patched deliver-task',
          patchSummary: 'added router gate',
          changedFiles: ['src/agent/deliver-task.ts'],
          evidenceStatus: 'skipped',
        })])
      },
    }

    const deps = createCoordinatorReviewDeps(coordinator)
    const result = await deps.spawnPatcher(
      { files: ['src/agent/deliver-task.ts'], crossModule: false, isFix: true },
      { verdict: 'rejected', evidence: 'missing review gate' },
    )

    assert.equal(requests[0]?.profile, 'patcher')
    assert.equal(requests[0]?.kind, 'patch_proposal')
    assert.equal(requests[0]?.reviewDepth, 1)
    assert.match(requests[0]?.objective ?? '', /missing review gate/)
    assert.equal(result.patched, true)
  })

  it('spawns squadron through delegateBatch and maps high-severity findings', async () => {
    let capturedPolicy: string | undefined
    let capturedRequests: DelegationRequest[] = []
    const coordinator: ReviewCoordinator = {
      delegate: async () => run([]),
      delegateBatch: async (requests, policy) => {
        capturedRequests = requests
        capturedPolicy = policy
        return run([worker({
          summary: 'Lifecycle HIGH: race in transition',
          findings: [{ claim: 'HIGH race in transition', evidence: 'src/a.ts:10', confidence: 'high' }],
          evidenceStatus: 'skipped',
        })])
      },
    }

    const deps = createCoordinatorReviewDeps(coordinator)
    const result = await deps.spawnSquadron({ files: ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts'], crossModule: false, isFix: false })

    assert.equal(capturedPolicy, 'all_required')
    assert.equal(capturedRequests.length, 4)
    assert.ok(capturedRequests.every(request => request.profile === 'reviewer'))
    assert.ok(capturedRequests.every(request => request.kind === 'review'))
    assert.ok(capturedRequests.every(request => request.reviewDepth === 1))
    assert.deepEqual(capturedRequests[0]?.scope.files, ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts'])
    assert.match(capturedRequests[0]?.objective ?? '', /Objective review stance/)
    assert.match(capturedRequests[0]?.objective ?? '', /提交存在、测试绿、作者声称已修/)
    assert.match(capturedRequests[0]?.objective ?? '', /Dataflow verifier stance/)
    assert.match(capturedRequests[0]?.objective ?? '', /fact-flow graph/)
    assert.match(capturedRequests[0]?.objective ?? '', /condition matrix/)
    assert.match(capturedRequests[0]?.objective ?? '', /counterexample tests/)
    assert.match(capturedRequests[0]?.objective ?? '', /Path boundary \/ attention-gate review stance/)
    assert.match(capturedRequests[0]?.objective ?? '', /repo-relative.*absolute inside cwd.*absolute outside cwd.*\.\.\/ traversal/)
    assert.match(capturedRequests[0]?.objective ?? '', /producer.*normalizer.*classifier.*consumer.*DB key.*assertion/)
    assert.match(capturedRequests[0]?.objective ?? '', /fail-closed.*fail-toward-content/)
    assert.equal(result.findings[0]?.severity, 'HIGH')
    assert.match(result.findings[0]?.claim ?? '', /race/)
  })
})
