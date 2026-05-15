import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
  CockpitRail,
  TracePanel,
  VerificationPanel,
  ContextPanel,
  SafetyPanel,
  ModelPanel,
  ApprovalRiskCard,
  PANELS,
  PANEL_LABELS,
} from '../index.js'
import type { Panel } from '../types.js'

describe('Cockpit barrel exports', () => {
  it('exports all panel components as functions', () => {
    assert.equal(typeof CockpitRail, 'function')
    assert.equal(typeof TracePanel, 'function')
    assert.equal(typeof VerificationPanel, 'function')
    assert.equal(typeof ContextPanel, 'function')
    assert.equal(typeof SafetyPanel, 'function')
    assert.equal(typeof ModelPanel, 'function')
    assert.equal(typeof ApprovalRiskCard, 'function')
  })
})

describe('Cockpit types', () => {
  it('PANELS contains all six panel names', () => {
    assert.deepStrictEqual(PANELS, ['summary', 'trace', 'verify', 'context', 'safety', 'model'])
  })

  it('PANEL_LABELS maps every panel to a non-empty label', () => {
    for (const panel of PANELS) {
      const label = PANEL_LABELS[panel]
      assert.ok(label.length > 0, `Panel ${panel} has empty label`)
    }
  })
})

describe('CockpitRail renders', () => {
  it('renders without error for each panel', () => {
    for (const panel of PANELS) {
      const el = CockpitRail({ activePanel: panel, onSelect: () => {} })
      assert.ok(el != null, `CockpitRail returned null for panel ${panel}`)
    }
  })
})

describe('TracePanel renders', () => {
  it('renders with empty events', () => {
    const el = TracePanel({ events: [] })
    assert.ok(el != null)
  })

  it('renders with events', () => {
    const el = TracePanel({
      events: [
        { id: '1', turn: 1, kind: 'tool', name: 'read_file', status: 'passed', durationMs: 120 },
        { id: '2', turn: 1, kind: 'tool', name: 'edit_file', status: 'running' },
      ],
    })
    assert.ok(el != null)
  })
})

describe('VerificationPanel renders', () => {
  it('renders with empty verifications', () => {
    const el = VerificationPanel({ filesRead: 0, filesModified: 0, verifications: [] })
    assert.ok(el != null)
  })

  it('renders with data', () => {
    const el = VerificationPanel({
      filesRead: 5,
      filesModified: 2,
      verifications: [
        { tool: 'tsc', status: 'passed', summary: 'no errors' },
        { tool: 'jest', status: 'failed', summary: '2 tests failed' },
      ],
    })
    assert.ok(el != null)
  })
})

describe('ContextPanel renders', () => {
  it('renders with basic props', () => {
    const el = ContextPanel({
      estimatedTokens: 50000,
      maxTokens: 200000,
      rounds: 5,
      compactionState: 'healthy',
      brokenRounds: 0,
      compactEvents: [],
    })
    assert.ok(el != null)
  })

  it('renders with compact events', () => {
    const el = ContextPanel({
      estimatedTokens: 180000,
      maxTokens: 200000,
      rounds: 12,
      compactionState: 'critical',
      brokenRounds: 2,
      compactEvents: [
        { turn: 8, tier: 1, beforeTokens: 170000, afterTokens: 40000 },
        { turn: 10, tier: 2, beforeTokens: 150000, afterTokens: 30000 },
      ],
    })
    assert.ok(el != null)
  })
})

describe('SafetyPanel renders', () => {
  it('renders with no risk', () => {
    const el = SafetyPanel({
      doomLoopLevel: 'none',
      riskLevel: 'none',
      riskReasons: [],
      recentFingerprints: 15,
    })
    assert.ok(el != null)
  })

  it('renders with high risk and reasons', () => {
    const el = SafetyPanel({
      doomLoopLevel: 'warn',
      riskLevel: 'high',
      riskReasons: ['repeated edit pattern', 'no verification'],
      recentFingerprints: 2,
    })
    assert.ok(el != null)
  })
})

describe('ModelPanel renders', () => {
  it('renders with model data', () => {
    const el = ModelPanel({
      model: 'deepseek-v4',
      cacheHitRate: 0.85,
      inputTokens: 120000,
      outputTokens: 35000,
      cacheReadTokens: 100000,
      cacheWriteTokens: 20000,
      cost: 0.0423,
    })
    assert.ok(el != null)
  })
})

describe('ApprovalRiskCard renders', () => {
  it('returns null when level is none', () => {
    const el = ApprovalRiskCard({ level: 'none', reasons: [] })
    assert.equal(el, null)
  })

  it('renders with risk level', () => {
    const el = ApprovalRiskCard({ level: 'high', reasons: ['destructive command'] })
    assert.ok(el != null)
  })
})
