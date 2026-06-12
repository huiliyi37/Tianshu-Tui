import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { WorkerCheckpoint } from '../worker-session.js'
import {
  buildWorkerPanelModel,
  formatElapsed,
  progressBar,
  type WorkerStatusEntry,
  type CircuitSummary,
} from '../../tui/worker-panel-model.js'
import { renderWorkerPanelLines } from '../../tui/worker-panel.js'

describe('WorkerCheckpoint', () => {
  it('checkpoint structure captures turn state', () => {
    const cp: WorkerCheckpoint = {
      turnIndex: 2,
      partialResult: 'Completed lint fixes for a.ts and b.ts',
      completedTools: ['read_file', 'edit_file', 'bash'],
    }
    assert.equal(cp.turnIndex, 2)
    assert.equal(cp.completedTools.length, 3)
    assert.ok(cp.partialResult.includes('lint fixes'))
  })

  it('checkpoint with empty state is valid', () => {
    const cp: WorkerCheckpoint = {
      turnIndex: 0,
      partialResult: '',
      completedTools: [],
    }
    assert.equal(cp.turnIndex, 0)
    assert.equal(cp.completedTools.length, 0)
  })
})

describe('WorkerPanelModel', () => {
  it('buildWorkerPanelModel detects active workers', () => {
    const workers: WorkerStatusEntry[] = [
      { workerId: 'w1', profile: 'lint_fixer', status: 'running', progress: { current: 3, total: 4, label: '3/4 files' } },
      { workerId: 'w2', profile: 'type_fixer', status: 'done', resultSummary: '0 errors' },
    ]
    const circuits: CircuitSummary[] = []
    const model = buildWorkerPanelModel(workers, circuits)
    assert.equal(model.hasActive, true)
    assert.equal(model.workers.length, 2)
  })

  it('buildWorkerPanelModel reports no active when all done', () => {
    const workers: WorkerStatusEntry[] = [
      { workerId: 'w1', profile: 'lint_fixer', status: 'done' },
      { workerId: 'w2', profile: 'type_fixer', status: 'failed', error: 'tsc crashed' },
    ]
    const model = buildWorkerPanelModel(workers, [])
    assert.equal(model.hasActive, false)
  })
})

describe('formatElapsed', () => {
  it('formats milliseconds', () => {
    assert.equal(formatElapsed(500), '500ms')
  })

  it('formats seconds', () => {
    assert.equal(formatElapsed(5000), '5s')
  })

  it('formats minutes and seconds', () => {
    assert.equal(formatElapsed(125000), '2m5s')
  })

  it('handles undefined', () => {
    assert.equal(formatElapsed(undefined), '')
  })
})

describe('progressBar', () => {
  it('renders full bar', () => {
    assert.equal(progressBar(4, 4, 8), '████████')
  })

  it('renders empty bar', () => {
    assert.equal(progressBar(0, 4, 8), '░░░░░░░░')
  })

  it('renders partial bar', () => {
    const bar = progressBar(2, 4, 8)
    assert.equal(bar.length, 8)
    assert.ok(bar.includes('█'))
    assert.ok(bar.includes('░'))
  })

  it('handles zero total', () => {
    assert.equal(progressBar(0, 0, 8), '░░░░░░░░')
  })
})

describe('renderWorkerPanelLines', () => {
  it('renders panel with workers and circuit state', () => {
    const model = buildWorkerPanelModel(
      [
        { workerId: 'w1', profile: 'lint_fixer', status: 'running', progress: { current: 3, total: 4, label: '3/4 files' } },
        { workerId: 'w2', profile: 'test_scaffolder', status: 'done', resultSummary: '12 tests' },
        { workerId: 'w3', profile: 'type_fixer', status: 'queued' },
      ],
      [{ profile: 'doc_syncer', state: 'open', failureCount: 3, cooldownRemainingS: 15 }],
    )

    const lines = renderWorkerPanelLines(model, 80)
    assert.ok(lines.length >= 5)
    assert.ok(lines[0]!.includes('Workers'))
    assert.ok(lines.some(l => l.includes('lint_fixer')))
    assert.ok(lines.some(l => l.includes('test_scaffolder')))
    assert.ok(lines.some(l => l.includes('type_fixer')))
    assert.ok(lines.some(l => l.includes('doc_syncer') && l.includes('open')))
  })

  it('renders empty panel', () => {
    const model = buildWorkerPanelModel([], [])
    const lines = renderWorkerPanelLines(model, 80)
    assert.ok(lines.some(l => l.includes('No workers active')))
  })

  it('shows all closed when no circuits are tripped', () => {
    const model = buildWorkerPanelModel(
      [{ workerId: 'w1', profile: 'lint_fixer', status: 'done' }],
      [{ profile: 'lint_fixer', state: 'closed', failureCount: 0, cooldownRemainingS: 0 }],
    )
    const lines = renderWorkerPanelLines(model, 80)
    assert.ok(lines.some(l => l.includes('all closed')))
  })
})
