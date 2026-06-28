import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderFleetDetail } from '../format/overlay.js'
import { getTheme } from '../theme.js'
import type { FleetWorkerView } from '../fleet-registry.js'

const theme = getTheme()
const stripAnsi = (s: string) => s.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '')

function mkWorker(overrides: Partial<FleetWorkerView> = {}): FleetWorkerView {
  return {
    workerId: 'wo_team:T1',
    shortLabel: 'T1',
    parentToolId: 'tool_abc',
    profile: 'code_scout',
    status: 'running',
    panelStatus: 'running',
    terminal: false,
    activity: '⚙ grep -r auth src/',
    activityLog: [],
    elapsedMs: 4200,
    ...overrides,
  }
}

// ── renderFleetDetail: worker detail overlay ───────────────────

test('renderFleetDetail: renders worker id and status', () => {
  const lines = renderFleetDetail(mkWorker(), 60, 20, theme)
  const plain = lines.map(stripAnsi).join('\n')
  assert.ok(plain.includes('T1'), 'worker short label present')
})

test('renderFleetDetail: shows profile', () => {
  const lines = renderFleetDetail(mkWorker({ profile: 'adversarial_verifier' }), 60, 20, theme)
  const plain = lines.map(stripAnsi).join('\n')
  assert.ok(plain.includes('adversarial_verifier'), 'profile visible')
})

test('renderFleetDetail: shows current activity line', () => {
  const lines = renderFleetDetail(mkWorker({ activityLog: ['⚙ reading auth.ts'] }), 60, 20, theme)
  const plain = lines.map(stripAnsi).join('\n')
  assert.ok(plain.includes('reading auth.ts'), 'activity line visible')
})

test('renderFleetDetail: shows elapsed time', () => {
  const lines = renderFleetDetail(mkWorker({ elapsedMs: 6500 }), 60, 20, theme)
  const plain = lines.map(stripAnsi).join('\n')
  assert.ok(plain.includes('6.5s') || plain.includes('7s') || plain.includes('6'), 'elapsed time visible')
})

test('renderFleetDetail: shows parent tool id for context', () => {
  const lines = renderFleetDetail(mkWorker({ parentToolId: 'tool_xyz123' }), 60, 20, theme)
  const plain = lines.map(stripAnsi).join('\n')
  assert.ok(plain.includes('tool_xyz123') || plain.includes('xyz'), 'parent context visible')
})

test('renderFleetDetail: shows status-specific glyph for terminal workers', () => {
  const lines = renderFleetDetail(mkWorker({ status: 'passed', terminal: true }), 60, 20, theme)
  const plain = lines.map(stripAnsi).join('\n')
  assert.ok(plain.includes('✓') || plain.includes('passed') || plain.includes('done'), 'terminal status shown')
})

test('renderFleetDetail: shows authority/star domain if present', () => {
  const lines = renderFleetDetail(mkWorker({ authority: 'tianquan' }), 60, 20, theme)
  const plain = lines.map(stripAnsi).join('\n')
  assert.ok(plain.includes('tianquan') || plain.includes('天权'), 'authority visible')
})

test('renderFleetDetail: shows Esc hint to close', () => {
  const lines = renderFleetDetail(mkWorker(), 60, 20, theme)
  const plain = lines.map(stripAnsi).join('\n')
  assert.ok(plain.includes('Esc'), 'close hint present')
})

test('renderFleetDetail: handles worker with no activity', () => {
  const lines = renderFleetDetail(mkWorker({ activity: undefined }), 60, 20, theme)
  assert.ok(lines.length > 0, 'renders without crash')
})
