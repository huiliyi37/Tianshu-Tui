import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { decomposeObjective, renderTaskGraphSummary, validateTaskGraph } from '../task-planner.js'

const ROLE_PIPELINE_PROFILES = ['lint_fixer', 'type_fixer', 'import_organizer', 'test_scaffolder']

describe('task-planner — horizontal orthogonal shards', () => {
  it('decomposes a simple single-module objective into ONE self-contained patcher shard', () => {
    const graph = decomposeObjective({ objective: 'Add feature X', files: ['src/foo/x.ts'] })
    const patchers = graph.nodes.filter(n => n.profile === 'patcher')
    assert.equal(patchers.length, 1)
    // self-contained: no vertical role-pipeline nodes, no standalone verify
    assert.ok(!graph.nodes.some(n => ROLE_PIPELINE_PROFILES.includes(n.profile)))
    assert.ok(!graph.nodes.some(n => n.kind === 'verify'))
    // the shard objective tells the worker to self-verify
    assert.match(patchers[0]!.objective, /tsc/)
    assert.equal(validateTaskGraph(graph).valid, true)
  })

  it('drops the vertical role pipeline for a refactor objective (explore + one shard only)', () => {
    const graph = decomposeObjective({ objective: 'Refactor authentication module', files: ['src/auth/login.ts'] })
    // refactor warrants an upfront explore shard
    assert.ok(graph.nodes.some(n => n.profile === 'code_scout'))
    assert.equal(graph.nodes.filter(n => n.profile === 'patcher').length, 1)
    assert.ok(!graph.nodes.some(n => n.kind === 'verify'))
    assert.ok(!graph.nodes.some(n => ROLE_PIPELINE_PROFILES.includes(n.profile)))
    assert.equal(validateTaskGraph(graph).valid, true)
  })

  it('splits a multi-module scope into orthogonal shards touching disjoint files', () => {
    const graph = decomposeObjective({
      objective: 'Wire telemetry across modules',
      files: ['src/tui/app.tsx', 'src/tui/stream.ts', 'src/api/client.ts', 'src/agent/loop.ts'],
    })
    const patchers = graph.nodes.filter(n => n.profile === 'patcher')
    // one shard per module: src/tui, src/api, src/agent
    assert.equal(patchers.length, 3)
    // shards are orthogonal — no file appears in two shards
    const allFiles = patchers.flatMap(p => p.files)
    assert.equal(new Set(allFiles).size, allFiles.length)
    // same-module files stay together in one shard
    const tuiShard = patchers.find(p => p.files.includes('src/tui/app.tsx'))
    assert.ok(tuiShard?.files.includes('src/tui/stream.ts'))
    assert.equal(validateTaskGraph(graph).valid, true)
  })

  it('no longer produces a standalone lint_fixer for a lint objective', () => {
    const graph = decomposeObjective({ objective: 'Fix eslint errors in src/' })
    assert.ok(!graph.nodes.some(n => n.profile === 'lint_fixer'))
    assert.ok(graph.nodes.some(n => n.profile === 'patcher'))
  })

  it('renders summary with waves', () => {
    const graph = decomposeObjective({ objective: 'Add feature X' })
    const summary = renderTaskGraphSummary(graph)
    assert.match(summary, /Mission: Add feature X/)
    assert.match(summary, /Wave 1/)
  })
})
