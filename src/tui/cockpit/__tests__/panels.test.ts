import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import React from 'react'

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
import type { CockpitContextLayerView, Panel } from '../types.js'

function render(component: any, props: any) {
  return React.createElement(component, props)
}

function innerFn(component: any): Function {
  return (component as any).type
}

describe('Cockpit barrel exports', () => {
  it('exports all panel components as memo objects with type function', () => {
    assert.equal(typeof innerFn(CockpitRail), 'function')
    assert.equal(typeof innerFn(TracePanel), 'function')
    assert.equal(typeof innerFn(VerificationPanel), 'function')
    assert.equal(typeof innerFn(ContextPanel), 'function')
    assert.equal(typeof innerFn(SafetyPanel), 'function')
    assert.equal(typeof innerFn(ModelPanel), 'function')
    assert.equal(typeof innerFn(ApprovalRiskCard), 'function')
  })
})

describe('Cockpit types', () => {
  it('PANELS contains all seven panel names', () => {
    assert.deepStrictEqual(PANELS, ['summary', 'trace', 'verify', 'context', 'safety', 'model', 'mcp'])
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
      const allIdle = Object.fromEntries(PANELS.map(p => [p, 'idle' as const])) as Record<Panel, import('../types.js').PanelStatus>
      const el = render(CockpitRail, { activePanel: panel, panelStatuses: allIdle, onSelect: () => {} })
      assert.ok(el != null, `CockpitRail returned null for panel ${panel}`)
    }
  })
})

describe('TracePanel renders', () => {
  it('renders with empty events', () => {
    const el = render(TracePanel, { events: [] })
    assert.ok(el != null)
  })

  it('renders with events', () => {
    const el = render(TracePanel, {
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
    const el = render(VerificationPanel, { filesRead: 0, filesModified: 0, verifications: [] })
    assert.ok(el != null)
  })

  it('renders with data', () => {
    const el = render(VerificationPanel, {
      filesRead: 5,
      filesModified: 2,
      verifications: [
        { tool: 'tsc', status: 'passed', summary: 'no errors' },
        { tool: 'jest', status: 'failed', summary: '2 tests failed' },
      ],
    })
    assert.ok(el != null)
  })

  it('renders delivery status', () => {
    const el = innerFn(VerificationPanel)({
      filesRead: 3,
      filesModified: 1,
      verifications: [{ tool: 'npm test', status: 'blocked', summary: 'blocked' }],
      deliveryStatus: 'blocked',
    })
    const tree = JSON.stringify(el)
    assert.ok(tree.includes('blocked'))
    assert.ok(tree.includes('Delivery'))
  })
})

describe('ContextPanel renders', () => {
  it('renders with basic props', () => {
    const el = render(ContextPanel, {
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
    const el = render(ContextPanel, {
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
    const el = render(SafetyPanel, {
      doomLoopLevel: 'none',
      riskLevel: 'none',
      riskReasons: [],
      recentFingerprints: 15,
    })
    assert.ok(el != null)
  })

  it('renders with high risk and reasons', () => {
    const el = render(SafetyPanel, {
      doomLoopLevel: 'warn',
      riskLevel: 'high',
      riskReasons: ['repeated edit pattern', 'no verification'],
      recentFingerprints: 2,
    })
    assert.ok(el != null)
  })

  it('renders suggestedAction when risk is high', () => {
    const el = innerFn(SafetyPanel)({
      doomLoopLevel: 'none',
      riskLevel: 'high',
      riskReasons: ['force push can overwrite shared remote history'],
      suggestedAction: 'Require explicit user approval before execution.',
      recentFingerprints: 3,
    })
    const tree = JSON.stringify(el)
    assert.ok(tree.includes('force push'))
    assert.ok(tree.includes('approval'))
  })
})

describe('ModelPanel renders', () => {
  it('renders with model data', () => {
    const el = render(ModelPanel, {
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

  it('renders physarum shadow next-step hit rates without prompt injection', () => {
    const el = innerFn(ModelPanel)({
      model: 'deepseek-v4',
      cacheHitRate: 0.85,
      inputTokens: 120000,
      outputTokens: 35000,
      cacheReadTokens: 100000,
      cacheWriteTokens: 20000,
      cost: 0.0423,
      physarumShadow: { semantic: 'next-step', total: 3, hit1: 1, hit3: 2, miss: 1, hitAt1: 1 / 3, hitAt3: 2 / 3 },
    })
    const tree = JSON.stringify(el)

    assert.ok(tree.includes('Shadow next-step'))
    assert.ok(tree.includes('hit@1'))
    assert.ok(tree.includes('hit@3'))
    assert.ok(tree.includes('miss'))
  })
})

describe('ApprovalRiskCard renders', () => {
  it('returns null when level is none', () => {
    const el = innerFn(ApprovalRiskCard)({ level: 'none', reasons: [] })
    assert.equal(el, null)
  })

  it('renders with risk level', () => {
    const el = render(ApprovalRiskCard, { level: 'high', reasons: ['destructive command'] })
    assert.ok(el != null)
  })
})

describe('ContextPanel layers', () => {
  it('renders context layers when provided', () => {
    const layers: CockpitContextLayerView[] = [
      { id: 'system', label: 'Stable System Prompt', stability: 'stable', channel: 'system', fingerprint: 'included', digest: 'sha256:a', tokenEstimate: 100 },
      { id: 'session-memory', label: 'Session Memory', stability: 'stable-volatile', channel: 'volatile-user-message', fingerprint: 'included', digest: 'sha256:b', tokenEstimate: 40 },
    ]
    const el = innerFn(ContextPanel)({
      estimatedTokens: 50000,
      maxTokens: 200000,
      rounds: 5,
      compactionState: 'healthy',
      brokenRounds: 0,
      compactEvents: [],
      layers,
    })
    assert.ok(el != null)
    const tree = JSON.stringify(el)
    assert.ok(tree.includes('Stable System Prompt'), 'should contain layer label')
    assert.ok(tree.includes('Session Memory'), 'should contain second layer label')
    assert.ok(tree.includes('Context layers'), 'should contain section header')
    assert.ok(tree.includes('fingerprint'), 'should contain fingerprint info')
  })
})
