import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { buildPlannerObjective, foldVerificationIntoTasks, normalizePerspective, mergePerspectives, mergePerspectivesByRole, parsePerspectiveResult } from '../team-perspectives.js'
import type { TeamPerspectivePlan } from '../team-perspectives.js'
import type { TeamTask } from '../team-plan.js'
import type { WorkerResult } from '../work-order.js'

function makeTask(id: string, riskTier: TeamTask['riskTier'] = 'low'): TeamTask {
  return {
    id,
    title: id,
    objective: `Do ${id}`,
    files: [`src/${id}.ts`],
    profile: 'patcher',
    kind: 'patch_proposal',
    verification: [],
    dependsOn: [],
    riskTier,
    touchSet: [`src/${id}.ts`],
  }
}

function basePerspective(overrides?: Partial<TeamPerspectivePlan>): TeamPerspectivePlan {
  return {
    perspective: 'tianquan',
    summary: 'Base plan',
    tasks: [makeTask('T1'), makeTask('T2')],
    dependencyNotes: [{ from: 'T1', to: 'T2', reason: 'T2 needs T1 output' }],
    risks: [],
    verification: [{ taskId: 'T1', command: 'npx tsc --noEmit', expected: 'exit 0' }],
    blockers: [],
    alternatives: [],
    ...overrides,
  }
}

describe('planner fanout helpers', () => {
  it('buildPlannerObjective carries perspective + schema instruction', () => {
    const objective = buildPlannerObjective('tianquan', 'refactor the loop')

    assert.match(objective, /天权/)
    assert.match(objective, /perspective-plan/)
    assert.match(objective, /refactor the loop/)
  })

  it('buildPlannerObjective derives the brief from the domain capsule (wenqu)', () => {
    const objective = buildPlannerObjective('wenqu', 'redesign the settings panel')
    assert.match(objective, /文曲/)
    assert.match(objective, /认知场/)
    assert.match(objective, /redesign the settings panel/)
  })

  it('parsePerspectiveResult extracts embedded plan from artifact', () => {
    const plan = {
      perspective: 'tianquan',
      summary: 's',
      tasks: [makeTask('T1')],
    }
    const result: WorkerResult = {
      workOrderId: 'team:planner-tianquan',
      status: 'passed',
      summary: 'done',
      findings: [],
      artifacts: [{ kind: 'note', title: 'perspective-plan', content: JSON.stringify(plan) }],
      changedFiles: [],
      risks: [],
      nextActions: [],
      evidenceStatus: 'verified',
    }

    const parsed = parsePerspectiveResult('tianquan', result)

    assert.equal(parsed.tasks.length, 1)
    assert.equal(parsed.tasks[0]!.id, 'T1')
  })

  it('parsePerspectiveResult extracts fenced JSON perspective plan from artifact', () => {
    const result: WorkerResult = {
      workOrderId: 'team:planner-tianquan',
      status: 'passed',
      summary: 'done',
      findings: [],
      artifacts: [{
        kind: 'note',
        title: 'perspective-plan',
        content: `Plan:\n\n\`\`\`json\n${JSON.stringify({ perspective: 'tianquan', tasks: [makeTask('T1')] })}\n\`\`\``,
      }],
      changedFiles: [],
      risks: [],
      nextActions: [],
      evidenceStatus: 'verified',
    }

    const parsed = parsePerspectiveResult('tianquan', result)

    assert.equal(parsed.tasks[0]!.id, 'T1')
  })

  it('parsePerspectiveResult degrades gracefully without artifact', () => {
    const result: WorkerResult = {
      workOrderId: 'x',
      status: 'passed',
      summary: 'sum',
      findings: [],
      artifacts: [],
      changedFiles: [],
      risks: ['r1'],
      nextActions: [],
      evidenceStatus: 'verified',
    }

    const parsed = parsePerspectiveResult('tianfu', result)

    assert.equal(parsed.perspective, 'tianfu')
    assert.deepEqual(parsed.blockers, ['r1'])
  })
})

describe('normalizePerspective', () => {
  it('fills missing fields with defaults', () => {
    const plan = normalizePerspective('tianfu', { summary: 'Risk review' })

    assert.equal(plan.perspective, 'tianfu')
    assert.equal(plan.summary, 'Risk review')
    assert.deepEqual(plan.tasks, [])
    assert.deepEqual(plan.risks, [])
    assert.deepEqual(plan.blockers, [])
  })
})

describe('mergePerspectives', () => {
  it('uses 天权 tasks as base graph', () => {
    const tianquan = basePerspective()
    const tianfu = normalizePerspective('tianfu', {})
    const merged = mergePerspectives(tianquan, tianfu)

    assert.equal(merged.tasks.length, 2)
    assert.equal(merged.tasks[0]!.id, 'T1')
    assert.equal(merged.tasks[1]!.id, 'T2')
  })

  it('upgrades risk tier from 天府 when higher', () => {
    const tianquan = basePerspective({
      tasks: [makeTask('T1', 'low')],
    })
    const tianfu = normalizePerspective('tianfu', {
      risks: [{ taskId: 'T1', severity: 'high', claim: 'Auth module', mitigation: 'Serial execution' }],
    })

    const merged = mergePerspectives(tianquan, tianfu)

    assert.equal(merged.tasks[0]!.riskTier, 'high')
    assert.ok(merged.accepted.some(a => a.title.includes('Risk upgrade')))
  })

  it('does not downgrade risk from 天府', () => {
    const tianquan = basePerspective({
      tasks: [makeTask('T1', 'high')],
    })
    const tianfu = normalizePerspective('tianfu', {
      risks: [{ taskId: 'T1', severity: 'low', claim: 'Safe', mitigation: 'None' }],
    })

    const merged = mergePerspectives(tianquan, tianfu)

    assert.equal(merged.tasks[0]!.riskTier, 'high')
  })

  it('adds 天府 verification gates not in 天权', () => {
    const tianquan = basePerspective({
      verification: [{ taskId: 'T1', command: 'npx tsc --noEmit', expected: 'exit 0' }],
    })
    const tianfu = normalizePerspective('tianfu', {
      verification: [{ taskId: 'T2', command: 'npm test', expected: 'all pass' }],
    })

    const merged = mergePerspectives(tianquan, tianfu)

    assert.equal(merged.verification.length, 2)
    assert.ok(merged.verification.some(v => v.command === 'npm test'))
  })

  it('does not duplicate verification from 天权', () => {
    const tianquan = basePerspective({
      verification: [{ taskId: 'T1', command: 'npx tsc --noEmit', expected: 'exit 0' }],
    })
    const tianfu = normalizePerspective('tianfu', {
      verification: [{ taskId: 'T1', command: 'npx tsc --noEmit', expected: 'exit 0' }],
    })

    const merged = mergePerspectives(tianquan, tianfu)

    assert.equal(merged.verification.length, 1)
  })

  it('classifies 天璇 alternatives by recommendation', () => {
    const tianquan = basePerspective()
    const tianfu = normalizePerspective('tianfu', {})
    const tianxuan = normalizePerspective('tianxuan', {
      alternatives: [
        { title: 'Shortcut A', tradeoff: 'Faster but less safe', recommendation: 'accept' },
        { title: 'Plan B', tradeoff: 'More thorough', recommendation: 'defer' },
        { title: 'Bad idea', tradeoff: 'Risky', recommendation: 'reject' },
      ],
    })

    const merged = mergePerspectives(tianquan, tianfu, tianxuan)

    assert.ok(merged.accepted.some(a => a.title === 'Shortcut A'))
    assert.ok(merged.deferred.some(d => d.title === 'Plan B'))
    assert.ok(merged.rejected.some(r => r.title === 'Bad idea'))
  })

  it('gap-fills an orthogonal (disjoint) extra task from 天璇 into the execution graph', () => {
    const tianquan = basePerspective() // T1 (src/T1.ts), T2 (src/T2.ts)
    const tianfu = normalizePerspective('tianfu', {})
    const tianxuan = normalizePerspective('tianxuan', {
      tasks: [makeTask('T3')], // src/T3.ts — disjoint from base
    })

    const merged = mergePerspectives(tianquan, tianfu, tianxuan)

    assert.equal(merged.tasks.length, 3, 'disjoint extra is folded into the graph')
    assert.ok(merged.tasks.some(t => t.id === 'T3'))
    assert.ok(merged.augmented.some(a => a.title.includes('Gap-fill shard: T3')))
    assert.ok(!merged.deferred.some(d => d.title.includes('T3')), 'adopted shard is not also deferred')
  })

  it('defers an extra task that overlaps base files (no clean split)', () => {
    const tianquan = basePerspective() // T1 (src/T1.ts), T2 (src/T2.ts)
    const tianfu = normalizePerspective('tianfu', {})
    const overlapping: TeamTask = {
      ...makeTask('T3'),
      files: ['src/T1.ts', 'src/new.ts'], // touches base T1's file
      touchSet: ['src/T1.ts', 'src/new.ts'],
    }
    const tianxuan = normalizePerspective('tianxuan', { tasks: [overlapping] })

    const merged = mergePerspectives(tianquan, tianfu, tianxuan)

    assert.equal(merged.tasks.length, 2, 'overlapping extra is NOT folded in')
    assert.ok(merged.deferred.some(d => d.title.includes('T3')))
    assert.ok(!merged.augmented.some(a => a.title.includes('T3')))
  })

  it('monolith-splits a coarse base block when a challenger cleanly partitions it', () => {
    const coarse: TeamTask = {
      ...makeTask('BIG'),
      files: ['src/a.ts', 'src/b.ts'],
      touchSet: ['src/a.ts', 'src/b.ts'],
    }
    const dependent: TeamTask = { ...makeTask('AFTER'), dependsOn: ['BIG'] }
    const tianquan = basePerspective({ tasks: [coarse, dependent] })
    const tianfu = normalizePerspective('tianfu', {})
    const partA: TeamTask = { ...makeTask('BIG_A'), files: ['src/a.ts'], touchSet: ['src/a.ts'] }
    const partB: TeamTask = { ...makeTask('BIG_B'), files: ['src/b.ts'], touchSet: ['src/b.ts'] }
    const tianxuan = normalizePerspective('tianxuan', { tasks: [partA, partB] })

    const merged = mergePerspectives(tianquan, tianfu, tianxuan)

    assert.ok(!merged.tasks.some(t => t.id === 'BIG'), 'coarse base block is replaced')
    assert.ok(merged.tasks.some(t => t.id === 'BIG_A'))
    assert.ok(merged.tasks.some(t => t.id === 'BIG_B'))
    assert.ok(merged.augmented.some(a => a.title.includes('Monolith-split: BIG')))
    // dependents reconnect to ALL replacement shards
    const after = merged.tasks.find(t => t.id === 'AFTER')!
    assert.ok(after.dependsOn.includes('BIG_A') && after.dependsOn.includes('BIG_B'))
    assert.ok(!after.dependsOn.includes('BIG'))
  })

  it('records 天璇 blind spots as accepted', () => {
    const tianquan = basePerspective()
    const tianfu = normalizePerspective('tianfu', {})
    const tianxuan = normalizePerspective('tianxuan', {
      blockers: ['Missing error handling in auth flow'],
    })

    const merged = mergePerspectives(tianquan, tianfu, tianxuan)

    assert.ok(merged.accepted.some(a => a.title.includes('Blind spot')))
  })

  it('does not pollute original 天权 task objects', () => {
    const originalTask = makeTask('T1', 'low')
    const tianquan = basePerspective({ tasks: [originalTask] })
    const tianfu = normalizePerspective('tianfu', {
      risks: [{ taskId: 'T1', severity: 'high', claim: 'Auth', mitigation: 'Serial' }],
    })

    mergePerspectives(tianquan, tianfu)

    // Original task must NOT be mutated
    assert.equal(originalTask.riskTier, 'low')
  })

  it('detects conflicts when 天府 and 天璇 disagree', () => {
    const tianquan = basePerspective({
      tasks: [makeTask('T1', 'low'), makeTask('T2', 'low')],
    })
    const tianfu = normalizePerspective('tianfu', {
      risks: [{ taskId: 'T1', severity: 'high', claim: 'Auth risk', mitigation: 'Serial' }],
    })
    const tianxuan = normalizePerspective('tianxuan', {
      alternatives: [
        { title: 'T1 shortcut', tradeoff: 'Faster but risky', recommendation: 'accept' },
      ],
    })

    const merged = mergePerspectives(tianquan, tianfu, tianxuan)

    assert.ok(merged.conflicts.length > 0, 'Should detect risk vs alternative conflict')
    assert.ok(merged.conflicts.some(c => c.description.includes('Risk vs alternative')))
  })

  it('detects dependency ordering conflicts between 天权 and 天璇', () => {
    const tianquan = basePerspective({
      tasks: [{ ...makeTask('T1'), dependsOn: ['T0'] }, makeTask('T2')],
    })
    const tianfu = normalizePerspective('tianfu', {})
    const tianxuan = normalizePerspective('tianxuan', {
      tasks: [{ ...makeTask('T1'), dependsOn: ['T2'] }],
    })

    const merged = mergePerspectives(tianquan, tianfu, tianxuan)

    assert.ok(merged.conflicts.some(c => c.description.includes('Dependency conflict')), 'Should detect dep ordering conflict')
  })

  it('does NOT fabricate a conflict when a 天府 risk has no taskId', () => {
    // Regression: `''.includes` is always true, so an undefined taskId used to
    // match the first 天璇 alternative and invent a spurious "conflict on unknown".
    const tianquan = basePerspective({ tasks: [] })
    const tianfu = normalizePerspective('tianfu', {
      risks: [{ severity: 'high', claim: 'global concurrency hazard', mitigation: 'serialize' }],
    })
    const tianxuan = normalizePerspective('tianxuan', {
      alternatives: [{ title: 'Unrelated caching layer', tradeoff: 'memory', recommendation: 'accept' }],
    })

    const merged = mergePerspectives(tianquan, tianfu, tianxuan)

    assert.equal(
      merged.conflicts.filter(c => c.description.includes('Risk vs alternative')).length,
      0,
      'A taskId-less risk must not correlate to an unrelated alternative',
    )
  })

  it('treats identical dependency SETS in different order as no conflict', () => {
    // Regression: dependsOn was compared via join(','), so [a,b] vs [b,a] —
    // the same dependency set — was flagged as a false ordering conflict.
    const tianquan = basePerspective({
      tasks: [{ ...makeTask('T1'), dependsOn: ['A', 'B'] }],
    })
    const tianfu = normalizePerspective('tianfu', {})
    const tianxuan = normalizePerspective('tianxuan', {
      tasks: [{ ...makeTask('T1'), dependsOn: ['B', 'A'] }],
    })

    const merged = mergePerspectives(tianquan, tianfu, tianxuan)

    assert.equal(
      merged.conflicts.filter(c => c.description.includes('Dependency conflict')).length,
      0,
      'Same dependency set in different order is not a conflict',
    )
  })

  it('works without 天璇 (two-perspective merge)', () => {
    const tianquan = basePerspective()
    const tianfu = normalizePerspective('tianfu', {})

    const merged = mergePerspectives(tianquan, tianfu)

    assert.equal(merged.tasks.length, 2)
    assert.deepEqual(merged.accepted, [])
    assert.deepEqual(merged.rejected, [])
    assert.deepEqual(merged.deferred, [])
  })

  it('merges dependency notes from both perspectives', () => {
    const tianquan = basePerspective({
      dependencyNotes: [{ from: 'T1', to: 'T2', reason: 'sequential' }],
    })
    const tianfu = normalizePerspective('tianfu', {
      dependencyNotes: [{ from: 'T1', to: 'T2', reason: 'sequential' }, { from: 'T2', to: 'T3', reason: 'needs review' }],
    })

    const merged = mergePerspectives(tianquan, tianfu)

    assert.equal(merged.dependencyNotes.length, 2) // Deduped
  })
})

describe('mergePerspectivesByRole', () => {
  it('selects the base by role regardless of array order', () => {
    const tianfu = normalizePerspective('tianfu', {})
    const tianquan = basePerspective() // role: base
    // base is last in the array — must still be chosen as skeleton
    const merged = mergePerspectivesByRole([tianfu, tianquan])
    assert.equal(merged.tasks.length, 2)
    assert.equal(merged.tasks[0]!.id, 'T1')
  })

  it('defers specialist (wenqu) alternatives as advisory regardless of recommendation', () => {
    const tianquan = basePerspective()
    const tianfu = normalizePerspective('tianfu', {})
    const wenqu = normalizePerspective('wenqu', {
      alternatives: [{ title: 'Use a bento layout', tradeoff: 'denser', recommendation: 'accept' }],
      blockers: ['No design tokens for spacing scale'],
    })

    const merged = mergePerspectivesByRole([tianquan, tianfu, wenqu])

    // specialist accept is NOT promoted to accepted — it defers as advisory
    assert.ok(merged.deferred.some(d => d.title === 'Use a bento layout' && d.source === 'wenqu'))
    assert.ok(!merged.accepted.some(a => a.title === 'Use a bento layout'))
    assert.ok(merged.deferred.some(d => d.title.includes('Advisory') && d.source === 'wenqu'))
  })

  it('reproduces the trio merge (backward compat via mergePerspectives wrapper)', () => {
    const tianquan = basePerspective()
    const tianfu = normalizePerspective('tianfu', {
      verification: [{ taskId: 'T2', command: 'npm test', expected: 'pass' }],
    })
    const tianxuan = normalizePerspective('tianxuan', {
      alternatives: [{ title: 'Alt', tradeoff: 't', recommendation: 'reject' }],
    })

    const viaWrapper = mergePerspectives(tianquan, tianfu, tianxuan)
    const viaRole = mergePerspectivesByRole([tianquan, tianfu, tianxuan])

    assert.deepEqual(viaWrapper, viaRole)
  })
})

describe('foldVerificationIntoTasks', () => {
  it('folds taskId-tagged gates into the matching task verification', () => {
    const tasks = [makeTask('T1'), makeTask('T2')]
    const folded = foldVerificationIntoTasks(tasks, [
      { taskId: 'T1', command: 'npm run lint', expected: 'exit 0' },
      { taskId: 'T2', command: 'npm test', expected: 'pass' },
    ])

    assert.deepEqual(folded[0]!.verification, ['npm run lint'])
    assert.deepEqual(folded[1]!.verification, ['npm test'])
  })

  it('dedupes gates already present on the task', () => {
    const tasks = [{ ...makeTask('T1'), verification: ['npm run lint'] }]
    const folded = foldVerificationIntoTasks(tasks, [
      { taskId: 'T1', command: 'npm run lint', expected: 'exit 0' },
      { taskId: 'T1', command: 'npm test', expected: 'pass' },
    ])

    assert.deepEqual(folded[0]!.verification, ['npm run lint', 'npm test'])
  })

  it('ignores untagged (plan-level) gates and never folds them into every task', () => {
    const tasks = [makeTask('T1'), makeTask('T2')]
    const folded = foldVerificationIntoTasks(tasks, [
      { command: 'npm run e2e', expected: 'green' },
    ])

    assert.deepEqual(folded[0]!.verification, [])
    assert.deepEqual(folded[1]!.verification, [])
  })

  it('does not mutate input tasks; returns same array when there are no gates', () => {
    const tasks = [makeTask('T1')]
    const same = foldVerificationIntoTasks(tasks, [])
    assert.equal(same, tasks)

    // A gate for an unknown taskId folds into nothing — task content unchanged.
    const noMatch = foldVerificationIntoTasks(tasks, [{ taskId: 'TX', command: 'x', expected: 'y' }])
    assert.deepEqual(tasks[0]!.verification, [])
    assert.deepEqual(noMatch[0]!.verification, [])
  })
})
