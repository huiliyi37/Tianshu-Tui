import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { buildTeamPanelModel, decodeTeamPanelModel, encodeTeamPanelModel } from '../team-panel-model.js'
import { renderTeamPanelLines } from '../team-panel.js'
import type { TeamRunSummary } from '../../agent/team-orchestrator.js'

function summary(): TeamRunSummary {
  return {
    mode: 'standard',
    planned: [],
    dispatched: 2,
    blocked: ['T3: waiting for wave W2 to complete'],
    packet: 'packet',
    waves: [
      { id: 'W1', taskIds: ['T1', 'T2'], risk: 'medium', reason: '2 write tasks', parallelLimit: 2 },
      { id: 'W2', taskIds: ['T3'], risk: 'high', reason: '1 review task', parallelLimit: 1 },
    ],
    tasks: [
      {
        id: 'T1',
        title: '实现面板',
        objective: '实现面板\nModify `src/tui/team-panel.tsx`',
        files: ['src/tui/team-panel.tsx'],
        profile: 'patcher',
        kind: 'patch_proposal',
        verification: [],
        dependsOn: [],
        riskTier: 'medium',
        touchSet: ['src/tui/team-panel.tsx'],
      },
      {
        id: 'T2',
        title: '审查门',
        objective: '审查门',
        files: [],
        profile: 'adversarial_verifier',
        kind: 'verify',
        verification: [],
        dependsOn: ['T1'],
        riskTier: 'high',
        touchSet: [],
      },
      {
        id: 'T3',
        title: '贪狼勘探',
        objective: '贪狼勘探 capability prospecting',
        files: [],
        profile: 'code_scout',
        kind: 'code_search',
        verification: [],
        dependsOn: ['T2'],
        riskTier: 'low',
        touchSet: [],
      },
    ],
    run: {
      status: 'completed',
      packet: 'done',
      results: [{
        workOrderId: 'team:T1',
        status: 'passed',
        summary: 'panel complete',
        findings: [],
        artifacts: [],
        changedFiles: ['src/tui/team-panel.tsx'],
        risks: [],
        nextActions: [],
        evidenceStatus: 'verified',
      }],
    },
  }
}

describe('TeamPanel model', () => {
  it('builds a single structured model from TeamRunSummary', () => {
    const model = buildTeamPanelModel(summary(), 0, 'verified')
    assert.equal(model.tasks.length, 3)
    assert.equal(model.tasks[0]?.authority, 'tianliang')
    assert.equal(model.tasks[1]?.authority, 'tianquan')
    assert.deepEqual(model.tasks[1]?.identity, { name: '瑶光', glyph: '↻' })
    assert.deepEqual(model.tasks[2]?.identity, { name: '贪狼', glyph: '⊕' })
    assert.equal(model.tasks[0]?.status, 'done')
    assert.equal(model.tasks[1]?.status, 'running')
    assert.equal(model.tasks[2]?.status, 'waiting')
    assert.equal(model.reviewVerdict, 'verified')
  })

  it('round-trips through the uiContent prefix', () => {
    const model = buildTeamPanelModel(summary(), 0)
    const encoded = encodeTeamPanelModel(model)
    assert.equal(decodeTeamPanelModel(encoded)?.waves.length, 2)
    assert.equal(decodeTeamPanelModel('team standard: 2 dispatched'), null)
  })
})

describe('renderTeamPanelLines', () => {
  it('renders waves, stars, dependencies, risk, and gate', () => {
    const model = buildTeamPanelModel(summary(), 0, 'verified')
    const text = renderTeamPanelLines(model, 90).join('\n')
    assert.match(text, /团队协作/)
    assert.match(text, /W1/)
    assert.match(text, /✧ 天梁 T1/)
    assert.match(text, /↻ 瑶光 T2/)
    assert.match(text, /⊕ 贪狼 T3/)
    assert.match(text, /depends ─ T1/)
    assert.match(text, /high ⚠/)
    assert.match(text, /gate: verified/)
  })
})
