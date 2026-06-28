import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildTeamPanelLines } from '../format/team-panel.js'
import type { TeamPanelModel } from '../team-panel-model.js'

function mkModel(overrides: Partial<TeamPanelModel> = {}): TeamPanelModel {
  return {
    mode: 'parallel',
    totalWaves: 2,
    currentWave: 0,
    dispatched: 0,
    tasks: [
      { id: 'T1', title: 'task 1', status: 'done', dependsOn: [], risk: 'low', wave: 0 },
      { id: 'T2', title: 'task 2', status: 'running', dependsOn: [], risk: 'low', wave: 0 },
      { id: 'T3', title: 'task 3', status: 'waiting', dependsOn: ['T2'], risk: 'medium', wave: 1 },
    ],
    waves: [
      { id: 'wave 1', taskIds: ['T1', 'T2'], risk: 'low', reason: 'independent' },
      { id: 'wave 2', taskIds: ['T3'], risk: 'medium', reason: 'depends on T2' },
    ],
    blocked: [],
    ...overrides,
  } as TeamPanelModel
}

// ── Wave-level progress bars ───────────────────────────────────

test('buildTeamPanelLines: each wave has its own progress bar', () => {
  const lines = buildTeamPanelLines(mkModel(), 80)
  const plain = lines.join('\n')
  // Wave 1 has T1 (done) + T2 (running) → 1/2 → 50% → 6/12 filled
  assert.ok(plain.includes('1/2'), 'wave 1 shows 1/2 done')
  // Wave 2 has T3 (waiting) → 0/1 → 0% → all empty
  assert.ok(plain.includes('0/1'), 'wave 2 shows 0/1 done')
})

test('buildTeamPanelLines: completed wave shows full progress bar', () => {
  const model = mkModel({
    tasks: [
      { id: 'T1', title: 't1', status: 'done', dependsOn: [] } as any,
      { id: 'T2', title: 't2', status: 'done', dependsOn: [] } as any,
    ],
    waves: [{ id: 'wave 1', taskIds: ['T1', 'T2'], risk: 'low' as const, reason: 'test' }],
    currentWave: 0,
  })
  const lines = buildTeamPanelLines(model, 80)
  const plain = lines.join('\n')
  assert.ok(plain.includes('2/2'), 'completed wave shows 2/2')
})

test('buildTeamPanelLines: wave progress bar uses block characters', () => {
  const lines = buildTeamPanelLines(mkModel(), 80)
  // Find the line with both block chars AND 1/2 (the wave progress bar)
  const waveBar = lines.find(l => (l.includes('█') || l.includes('░')) && l.includes('1/2'))
  assert.ok(waveBar, 'wave 1 progress bar line exists')
})

test('buildTeamPanelLines: total progress bar still present at bottom', () => {
  const lines = buildTeamPanelLines(mkModel(), 80)
  const plain = lines.join('\n')
  // Overall: 1 done / 3 total
  assert.ok(plain.includes('1/3'), 'overall progress shows 1/3')
})

test('buildTeamPanelLines: wave label includes wave number indicator', () => {
  const lines = buildTeamPanelLines(mkModel(), 80)
  const plain = lines.join('\n')
  assert.ok(plain.includes('wave 1'), 'wave 1 label present')
  assert.ok(plain.includes('wave 2'), 'wave 2 label present')
})
