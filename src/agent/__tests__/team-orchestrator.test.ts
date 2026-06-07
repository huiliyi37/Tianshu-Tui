import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { CoordinatorRun, DelegationRequest } from '../coordinator.js'
import {
  runTeamSkeleton,
  selectDispatchableTeamTasks,
  teamTasksToDelegationRequests,
} from '../team-orchestrator.js'
import type { TeamTaskDraft } from '../team-plan.js'

function task(id: string, files: string[], profile: TeamTaskDraft['profile'] = 'patcher'): TeamTaskDraft {
  return {
    id,
    title: id,
    objective: `Implement ${id}`,
    files,
    profile,
    kind: profile === 'patcher' ? 'patch_proposal' : 'review',
    verification: [],
  }
}

function run(packet = 'packet'): CoordinatorRun {
  return { status: 'completed', results: [], packet }
}

describe('team orchestrator skeleton', () => {
  it('selects scoped patcher tasks and blocks ambiguous or overlapping ones', () => {
    const { selected, blocked } = selectDispatchableTeamTasks([
      task('T1', ['src/a.ts']),
      task('T2', []),
      task('T3', ['src/a.ts']),
      task('T4', ['src/b.ts']),
    ], 3)

    assert.deepEqual(selected.map(t => t.id), ['T1', 'T4'])
    assert.deepEqual(blocked, [
      'T2: patcher task has no file scope',
      'T3: overlapping patcher file scope; serialize later',
    ])
  })

  it('maps patcher tasks to 天梁 execution objectives', () => {
    const [request] = teamTasksToDelegationRequests([task('T1', ['src/a.ts'])], 'parent')

    assert.equal(request!.parentTurnId, 'parent:T1')
    assert.equal(request!.kind, 'patch_proposal')
    assert.equal(request!.profile, 'patcher')
    assert.deepEqual(request!.scope.files, ['src/a.ts'])
    assert.ok(request!.objective.includes('你是天梁执行者'))
    assert.ok(request!.objective.includes('只执行本 task'))
  })

  it('dispatches parsed standard plan tasks through delegateBatch', async () => {
    let captured: DelegationRequest[] = []
    const summary = await runTeamSkeleton({
      mode: 'standard',
      objective: 'execute plan',
      parentTurnId: 'turn-1',
      planMarkdown: `
### Task 1: Parser
修改 src/agent/team-plan.ts

### Task 2: Orchestrator
修改 src/agent/team-orchestrator.ts
`,
    }, {
      delegateBatch: async (requests, policy) => {
        captured = requests
        assert.equal(policy, 'all_required')
        return run('delegated')
      },
    })

    assert.equal(summary.dispatched, 2)
    assert.equal(summary.packet, 'delegated')
    assert.deepEqual(captured.map(r => r.scope.files), [
      ['src/agent/team-plan.ts'],
      ['src/agent/team-orchestrator.ts'],
    ])
  })

  it('does not auto-dispatch execution workers in max skeleton mode', async () => {
    let called = false
    const summary = await runTeamSkeleton({ mode: 'max', objective: 'design from scratch' }, {
      delegateBatch: async () => {
        called = true
        return run()
      },
    })

    assert.equal(called, false)
    assert.equal(summary.dispatched, 0)
    assert.ok(summary.blocked[0]!.includes('planning brief'))
  })
})
