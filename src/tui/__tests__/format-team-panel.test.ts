import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { formatTeamPanel, buildTeamPanelLines } from '../format/team-panel.js'
import { encodeTeamPanelModel, decodeTeamPanelModel, type TeamPanelModel } from '../team-panel-model.js'
import { getTheme } from '../theme.js'

const theme = getTheme()
const stripAnsi = (s: string) => s.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '')

const model: TeamPanelModel = {
  mode: 'standard',
  currentWave: 0,
  totalWaves: 2,
  dispatched: 3,
  blocked: [],
  waves: [
    { id: 'wave-1', taskIds: ['t1', 't2'], risk: 'low', reason: 'parallel-safe' },
    { id: 'wave-2', taskIds: ['t3'], risk: 'high', reason: 'shared files' },
  ],
  tasks: [
    { id: 't1', title: 'explore api', authority: 'pojun', profile: 'explorer', kind: 'explore', dependsOn: [], riskTier: 'low', files: [], status: 'done', summary: 'found 3 endpoints' },
    { id: 't2', title: 'map imports', authority: 'tianxuan', profile: 'explorer', kind: 'explore', dependsOn: [], riskTier: 'low', status: 'running', files: [] },
    { id: 't3', title: 'patch retry', authority: 'tianliang', profile: 'patcher', kind: 'patch', dependsOn: ['t1'], riskTier: 'high', files: [], status: 'waiting' },
  ],
}

describe('formatTeamPanel', () => {
  it('renders waves, star identities, and task status glyphs', () => {
    const plain = buildTeamPanelLines(model, 80).join('\n')
    assert.ok(plain.includes('Team · /team standard'), 'title')
    assert.ok(plain.includes('wave 1/2'), 'wave label')
    assert.ok(plain.includes('wave-1'), 'wave id')
    assert.ok(plain.includes('✓ done'), 'done glyph')
    assert.ok(plain.includes('◐ running'), 'running glyph')
    assert.ok(plain.includes('◌ waiting'), 'waiting glyph')
    assert.ok(plain.includes('depends: t1'), 'dependency line')
    assert.ok(plain.includes('found 3 endpoints'), 'task summary')
  })

  it('applies ANSI color (error on high-risk line, muted title)', () => {
    const lines = formatTeamPanel(model, theme, 80)
    assert.ok(/\x1B\[/.test(lines[0]!), 'title line has color')
    const highLine = lines.find(l => l.includes('high ⚠'))
    assert.ok(highLine && /\x1B\[/.test(highLine), 'high-risk line has color')
  })

  it('round-trips through encode/decode', () => {
    const decoded = decodeTeamPanelModel(encodeTeamPanelModel(model))
    assert.ok(decoded)
    const plain = stripAnsi(formatTeamPanel(decoded!, theme, 80).join('\n'))
    assert.ok(plain.includes('explore api'))
  })
})
