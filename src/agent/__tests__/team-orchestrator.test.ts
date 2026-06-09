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
      'T3: overlapping patcher file scope with T1; serialize later',
    ])
  })

  it('blocks patchers with PARTIAL file overlap, not just identical sets', () => {
    const { selected, blocked } = selectDispatchableTeamTasks([
      task('T1', ['src/a.ts', 'src/b.ts']),
      task('T2', ['src/b.ts', 'src/c.ts']),
      task('T3', ['src/d.ts']),
    ], 3)

    assert.deepEqual(selected.map(t => t.id), ['T1', 'T3'])
    assert.deepEqual(blocked, [
      'T2: overlapping patcher file scope with T1; serialize later',
    ])
  })

  it('does not treat read-only workers as file-conflicting even on shared files', () => {
    const { selected, blocked } = selectDispatchableTeamTasks([
      task('T1', ['src/a.ts']),
      task('T2', ['src/a.ts'], 'reviewer'),
    ], 3)

    assert.deepEqual(selected.map(t => t.id), ['T1', 'T2'])
    assert.deepEqual(blocked, [])
  })

  it('maps patcher tasks to 天梁 execution objectives', () => {
    const [request] = teamTasksToDelegationRequests([task('T1', ['src/a.ts'])], 'parent')

    assert.equal(request!.parentTurnId, 'parent:team:T1')
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
    assert.match(summary.packet, /delegated/)
    assert.deepEqual(captured.map(r => r.scope.files), [
      ['src/agent/team-plan.ts'],
      ['src/agent/team-orchestrator.ts'],
    ])
  })

  it('max mode fans out 3 perspective planners then dispatches merged waves', async () => {
    const calls: DelegationRequest[][] = []
    const summary = await runTeamSkeleton({ mode: 'max', objective: 'design the subsystem from scratch' }, {
      delegateBatch: async (requests) => {
        calls.push(requests)
        const isPlannerBatch = requests.some(r => r.parentTurnId.includes('planner-'))
        if (isPlannerBatch) {
          const plan = {
            perspective: 'tianquan',
            tasks: [{
              id: 'T1',
              title: 'impl',
              objective: 'impl',
              files: ['src/x.ts'],
              profile: 'patcher',
              kind: 'patch_proposal',
              verification: [],
              dependsOn: [],
              riskTier: 'low',
              touchSet: ['src/x.ts'],
            }],
          }
          return {
            status: 'completed',
            packet: 'planned',
            results: requests.map(r => ({
              workOrderId: r.parentTurnId.includes('tianquan') ? 'team:planner-tianquan'
                : r.parentTurnId.includes('tianfu') ? 'team:planner-tianfu' : 'team:planner-tianxuan',
              status: 'passed' as const,
              summary: 'p',
              findings: [],
              artifacts: r.parentTurnId.includes('tianquan') ? [{ kind: 'note' as const, title: 'perspective-plan', content: JSON.stringify(plan) }] : [],
              changedFiles: [],
              risks: [],
              nextActions: [],
              evidenceStatus: 'verified' as const,
            })),
          }
        }
        return { status: 'completed', results: [], packet: 'executed' }
      },
    })

    assert.equal(calls.length, 2)
    assert.ok(calls[0]!.some(r => r.parentTurnId.includes('planner-tianquan')))
    assert.ok(summary.dispatched >= 1)
    assert.equal(summary.tasks.length, 1)
  })

  it('max mode routes planners via kind=plan and executors via kind=patch_proposal', async () => {
    const kinds: string[] = []
    await runTeamSkeleton({ mode: 'max', objective: 'design a coherent subsystem now' }, {
      delegateBatch: async (requests) => {
        for (const r of requests) {
          const role = r.parentTurnId.includes('planner-') ? 'planner' : 'exec'
          kinds.push(`${role}:${r.kind}`)
        }
        const isPlanner = requests.some(r => r.parentTurnId.includes('planner-'))
        if (isPlanner) {
          const plan = {
            perspective: 'tianquan', summary: 's',
            tasks: [{ id: 'T1', title: 'x', objective: 'x', files: ['src/x.ts'], profile: 'patcher', kind: 'patch_proposal', verification: [], dependsOn: [], riskTier: 'low', touchSet: ['src/x.ts'] }],
          }
          return {
            status: 'completed', packet: 'p',
            results: requests.map(r => ({
              workOrderId: r.parentTurnId.includes('tianquan') ? 'team:planner-tianquan'
                : r.parentTurnId.includes('tianfu') ? 'team:planner-tianfu' : 'team:planner-tianxuan',
              status: 'passed' as const, summary: 'p', findings: [],
              artifacts: r.parentTurnId.includes('tianquan')
                ? [{ kind: 'note' as const, title: 'perspective-plan', content: JSON.stringify(plan) }] : [],
              changedFiles: [], risks: [], nextActions: [], evidenceStatus: 'verified' as const,
            })),
          }
        }
        return { status: 'completed', results: [], packet: 'e' }
      },
    })

    assert.ok(kinds.some(k => k === 'planner:plan'), `expected planner:plan in ${kinds}`)
    assert.ok(kinds.some(k => k === 'exec:patch_proposal'), `expected exec:patch_proposal in ${kinds}`)
  })
})

describe('team orchestrator wave dispatch', () => {
  it('produces waves for tasks with dependencies', async () => {
    let captured: DelegationRequest[] = []
    const summary = await runTeamSkeleton({
      mode: 'standard',
      objective: 'wave test',
      planMarkdown: `
### T1: Base
修改 src/a.ts

### T2: Depends on T1
修改 src/b.ts
depends: T1
`,
    }, {
      delegateBatch: async (requests, policy) => {
        captured = requests
        return run('wave-done')
      },
    })

    // Should have waves (T1 first, then T2)
    assert.ok(summary.waves.length >= 1, `Expected ≥1 wave, got ${summary.waves.length}`)
    // First wave should contain T1
    assert.ok(summary.waves[0]!.taskIds.includes('T1'), 'First wave should include T1')
    // T2 should be in a later wave or blocked
    const t2WaveIdx = summary.waves.findIndex(w => w.taskIds.includes('T2'))
    if (t2WaveIdx >= 0) {
      const t1WaveIdx = summary.waves.findIndex(w => w.taskIds.includes('T1'))
      assert.ok(t1WaveIdx < t2WaveIdx, 'T1 wave must be before T2 wave')
    }
    // First wave dispatched
    assert.ok(summary.dispatched >= 1)
    assert.match(summary.packet, /wave-done/)
  })

  it('serializes same-file tasks across waves', async () => {
    const summary = await runTeamSkeleton({
      mode: 'standard',
      objective: 'serialize test',
      planMarkdown: `
### T1: First edit
修改 src/a.ts

### T2: Second edit
修改 src/a.ts
`,
    }, {
      delegateBatch: async (requests) => run(`dispatched ${requests.length}`),
    })

    // Same file → should serialize into different waves
    assert.ok(summary.waves.length >= 2, `Expected ≥2 waves for same-file tasks, got ${summary.waves.length}`)
  })

  it('returns empty waves for plan with no tasks', async () => {
    const summary = await runTeamSkeleton({
      mode: 'standard',
      objective: 'empty',
      planMarkdown: '# Just a design\nNo tasks here.',
    }, {
      delegateBatch: async () => run(),
    })

    assert.equal(summary.waves.length, 0)
    assert.equal(summary.dispatched, 0)
    assert.equal(summary.tasks.length, 0)
  })

  it('enriched tasks carry risk and dependency info', async () => {
    const summary = await runTeamSkeleton({
      mode: 'standard',
      objective: 'enrichment test',
      planMarkdown: `
### T1: Security fix
修改 src/auth.ts

### T2: Depends on T1
修改 src/other.ts
depends: T1
`,
    }, {
      delegateBatch: async () => run(),
    })

    assert.equal(summary.tasks.length, 2)
    const t1 = summary.tasks.find(t => t.id === 'T1')
    const t2 = summary.tasks.find(t => t.id === 'T2')
    assert.ok(t1)
    assert.ok(t2)
    assert.equal(t1!.riskTier, 'high')
    assert.deepEqual(t2!.dependsOn, ['T1'])
  })

  it('dispatches a later wave when fromWave is set', async () => {
    let captured: DelegationRequest[] = []
    const md = `
### T1: First edit
修改 src/a.ts

### T2: Second edit
修改 src/a.ts
`
    const summary = await runTeamSkeleton({
      mode: 'standard',
      objective: 'serialize',
      planMarkdown: md,
      fromWave: 1,
    }, {
      delegateBatch: async (requests) => { captured = requests; return run('wave2') },
    })

    assert.ok(summary.waves.length >= 2)
    assert.ok(captured.some(r => r.parentTurnId.includes('T2')))
    assert.ok(!captured.some(r => r.parentTurnId.includes('T1')))
  })

  it('records telemetry, scheduler shadow, and gated influence audit without changing dispatch result', async () => {
    const events: unknown[] = []
    const schedulerEvents: unknown[] = []
    const auditEvents: unknown[] = []
    const summary = await runTeamSkeleton({
      mode: 'standard',
      objective: 'telemetry wave',
      planMarkdown: `
### T1: First edit
修改 src/a.ts

### T2: Second edit
修改 src/a.ts
`,
      fromWave: 1,
    }, {
      sessionId: 'session-1',
      recordTeamWaveTelemetry: event => { events.push(event) },
      recordTeamSchedulerShadow: event => { schedulerEvents.push(event) },
      recordGatedInfluenceAudit: event => { auditEvents.push(event) },
      delegateBatch: async () => run('wave2'),
    })

    assert.equal(summary.dispatched, 1)
    assert.equal(events.length, 1)
    assert.equal(schedulerEvents.length, 1)
    assert.equal((events[0] as any).sessionId, 'session-1')
    assert.equal((events[0] as any).fromWave, 1)
    assert.equal((events[0] as any).waveId, 'W2')
    assert.equal((schedulerEvents[0] as any).applied, false)
    assert.equal(auditEvents.length, 1)
    assert.equal((auditEvents[0] as any).source, 'team_scheduler_bandit')
    assert.equal((auditEvents[0] as any).applied, false)
    assert.ok(Array.isArray((auditEvents[0] as any).vetoSignals))
  })

  it('allows scheduler influence only to reduce dispatch within a safe wave', async () => {
    let captured: DelegationRequest[] = []
    const summary = await runTeamSkeleton({
      mode: 'standard',
      objective: 'scheduler reduce',
      teamSchedulerBanditEnabled: true,
      planMarkdown: `
### T1: one
修改 src/a.ts

### T2: two
修改 src/b.ts

### T3: three
修改 src/c.ts
`,
    }, {
      teamSchedulerState: {
        totalSamples: 35,
        arms: {
          'parallelism:1': { samples: 6, totalReward: 4.8, averageReward: 0.8 },
          'parallelism:2': { samples: 6, totalReward: 2.4, averageReward: 0.4 },
          'parallelism:3': { samples: 6, totalReward: 2.4, averageReward: 0.4 },
          'parallelism:4': { samples: 6, totalReward: 2.4, averageReward: 0.4 },
          'parallelism:5': { samples: 11, totalReward: 4.4, averageReward: 0.4 },
        },
      },
      delegateBatch: async (requests) => { captured = requests; return run('reduced') },
    })

    assert.equal(summary.waves[0]!.taskIds.length, 2, 'grouping hard cap remains unchanged')
    assert.equal(summary.dispatched, 1)
    assert.equal(captured.length, 1)
    assert.ok(summary.blocked.some(item => item.includes('deferred by scheduler')))
  })

  it('reports completion when fromWave is past the last wave', async () => {
    const summary = await runTeamSkeleton({
      mode: 'standard',
      objective: 'done',
      fromWave: 9,
      planMarkdown: '### T1: only\n修改 src/a.ts',
    }, { delegateBatch: async () => run() })

    assert.equal(summary.dispatched, 0)
    assert.match(summary.packet, /all .* waves dispatched/)
  })
})
