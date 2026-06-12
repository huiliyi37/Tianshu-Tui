import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { decomposeObjective, renderTaskGraphSummary, validateTaskGraph } from '../task-planner.js'

describe('task-planner', () => {
  it('decomposes refactor objective with scout + patch + verify', () => {
    const graph = decomposeObjective({
      objective: 'Refactor authentication module',
      files: ['src/auth/login.ts'],
    })
    assert.ok(graph.nodes.length >= 3)
    assert.ok(graph.nodes.some(n => n.profile === 'code_scout'))
    assert.ok(graph.nodes.some(n => n.profile === 'patcher' || n.profile === 'architect'))
    assert.ok(graph.nodes.some(n => n.kind === 'verify'))
    assert.equal(validateTaskGraph(graph).valid, true)
  })

  it('includes lint tasks when objective mentions lint', () => {
    const graph = decomposeObjective({ objective: 'Fix eslint errors in src/' })
    assert.ok(graph.nodes.some(n => n.profile === 'lint_fixer'))
  })

  it('renders summary with waves', () => {
    const graph = decomposeObjective({ objective: 'Add feature X' })
    const summary = renderTaskGraphSummary(graph)
    assert.match(summary, /Mission: Add feature X/)
    assert.match(summary, /Wave 1/)
  })
})
