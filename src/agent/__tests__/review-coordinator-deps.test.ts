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
    assert.match(captured?.objective ?? '', /Wiring & effectiveness review stance/)
    assert.match(captured?.objective ?? '', /零调用方传值即死参数/)
    assert.match(captured?.objective ?? '', /双渲染/)
    assert.match(captured?.objective ?? '', /过滤掉 ~100% 的门控等于静默关闭功能/)
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
    assert.equal(capturedRequests.length, 5)
    assert.ok(capturedRequests.every(request => request.profile === 'reviewer'))
    assert.ok(capturedRequests.every(request => request.kind === 'review'))
    assert.ok(capturedRequests.every(request => request.reviewDepth === 1))
    assert.deepEqual(capturedRequests[0]?.scope.files, ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts'])

    // Every inspector carries the core anti-rubber-stamp stance
    for (const req of capturedRequests) {
      assert.match(req.objective, /Objective review stance/)
      assert.match(req.objective, /提交存在、测试绿、作者声称已修/)
      assert.match(req.objective, /severity CRITICAL\/HIGH\/MEDIUM\/LOW/)
    }

    // Prompt economy: stances are assigned per axis, not stacked on all five.
    const security = capturedRequests[0]!.objective
    assert.match(security, /^Security Inspector:/m)
    assert.match(security, /Path boundary \/ attention-gate review stance/)
    assert.match(security, /repo-relative.*absolute inside cwd.*absolute outside cwd.*\.\.\/ traversal/)
    assert.doesNotMatch(security, /Dataflow verifier stance/)
    assert.doesNotMatch(security, /Wiring & effectiveness review stance/)

    const lifecycle = capturedRequests[1]!.objective
    assert.match(lifecycle, /^Lifecycle Inspector:/m)
    assert.match(lifecycle, /Dataflow verifier stance/)
    assert.match(lifecycle, /outer timeouts strictly dominate inner budgets/i)
    assert.doesNotMatch(lifecycle, /Path boundary \/ attention-gate review stance/)

    const dataFlow = capturedRequests[2]!.objective
    assert.match(dataFlow, /^Data Flow Inspector:/m)
    assert.match(dataFlow, /Dataflow verifier stance/)
    assert.match(dataFlow, /fact-flow graph/)
    assert.match(dataFlow, /Path boundary \/ attention-gate review stance/)

    const silence = capturedRequests[3]!.objective
    assert.match(silence, /^Silence Inspector:/m)
    assert.doesNotMatch(silence, /Dataflow verifier stance/)
    assert.doesNotMatch(silence, /Path boundary \/ attention-gate review stance/)

    const wiring = capturedRequests[4]!.objective
    assert.match(wiring, /^Wiring Inspector:/m)
    assert.match(wiring, /Wiring & effectiveness review stance/)
    assert.match(wiring, /zero callers/)
    assert.match(wiring, /silent feature kill/)
    assert.match(wiring, /Method \(run these checks/)
    assert.doesNotMatch(wiring, /Dataflow verifier stance/)

    assert.equal(result.findings[0]?.severity, 'HIGH')
    assert.match(result.findings[0]?.claim ?? '', /race/)
    assert.deepEqual(result.infraFailures, [])
  })

  it('spawns the auto wiring reviewer as two parallel short-budget inspectors (Wiring + Silence)', async () => {
    const requests: DelegationRequest[] = []
    const coordinator: ReviewCoordinator = {
      delegate: async request => {
        requests.push(request)
        return run([worker({
          summary: 'Wiring HIGH: budget field never enforced',
          findings: [{ claim: 'HIGH dead wiring: maxTokens never enforced', evidence: 'src/agent/worker-session.ts:210', confidence: 'high' }],
          evidenceStatus: 'skipped',
        })])
      },
      delegateBatch: async (reqs) => {
        for (const r of reqs) requests.push(r)
        return run([worker({
          summary: 'Wiring HIGH: budget field never enforced',
          findings: [{ claim: 'HIGH dead wiring: maxTokens never enforced', evidence: 'src/agent/worker-session.ts:210', confidence: 'high' }],
          evidenceStatus: 'skipped',
        })])
      },
    }

    const deps = createCoordinatorReviewDeps(coordinator)
    const result = await deps.spawnWiringReviewer!({ files: ['src/a.ts'], crossModule: false, isFix: false })

    assert.equal(requests.length, 2, 'auto review spawns 2 inspectors (Wiring + Silence)')
    assert.equal(requests[0]?.profile, 'reviewer')
    assert.equal(requests[0]?.kind, 'review')
    assert.equal(requests[0]?.budget?.timeoutMs, 150_000)
    assert.equal(requests[0]?.budget?.maxTurns, 6)
    assert.match(requests[0]?.objective ?? '', /^Wiring Inspector:/m)
    assert.match(requests[0]?.objective ?? '', /Time budget is tight/)
    assert.match(requests[0]?.objective ?? '', /review the DIFF/)
    assert.match(requests[1]?.objective ?? '', /^Silence Inspector:/m)
    assert.ok(result.findings.length >= 0)
  })

  it('keeps squadron worker contract failures separate from real findings', async () => {
    const coordinator: ReviewCoordinator = {
      delegate: async () => run([]),
      delegateBatch: async () => run([worker({
        status: 'failed',
        summary: 'Worker failed: Worker result did not contain a JSON object',
        findings: [],
        risks: ['all_required: work order wo-test was blocked (unparseable or connectivity issue)'],
        evidenceStatus: 'blocked',
      })]),
    }

    const deps = createCoordinatorReviewDeps(coordinator)
    const result = await deps.spawnSquadron({ files: ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts'], crossModule: false, isFix: false })

    assert.deepEqual(result.findings, [])
    assert.equal(result.infraFailures?.[0]?.kind, 'json')
    assert.match(result.infraFailures?.[0]?.claim ?? '', /JSON object/)
  })
})
