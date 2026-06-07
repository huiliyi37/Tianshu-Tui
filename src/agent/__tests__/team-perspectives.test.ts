import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { normalizePerspective, mergePerspectives } from '../team-perspectives.js'
import type { TeamPerspectivePlan } from '../team-perspectives.js'
import type { TeamTask } from '../team-plan.js'

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

  it('defers extra tasks from 天璇 not in 天权', () => {
    const tianquan = basePerspective()
    const tianfu = normalizePerspective('tianfu', {})
    const tianxuan = normalizePerspective('tianxuan', {
      tasks: [makeTask('T3')],
    })

    const merged = mergePerspectives(tianquan, tianfu, tianxuan)

    assert.equal(merged.tasks.length, 2) // Only 天权 tasks
    assert.ok(merged.deferred.some(d => d.title.includes('T3')))
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
