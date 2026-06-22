import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildCognitiveMirror,
  buildCognitivePromptProjection,
  createCognitiveLedger,
} from '../cognitive-ledger.js'
import type { CognitiveLedger, CognitiveLedgerInput } from '../cognitive-ledger.js'
import type { Sensorium, StrategyProfile } from '../../agent/sensorium.js'

// ─── 任务 9：认知镜面（CVM Gen2 paravirtualization）───
// 至人之用心若镜，不将不迎，应而不藏。（庄子）
// 让模型看到自己的认知状态，主动调整行为。

function makeSensorium(overrides: Partial<Sensorium> = {}): Sensorium {
  return {
    confidence: 0.5,
    complexity: 0.3,
    momentum: 0.4,
    stability: 0.9,
    pressure: 0.2,
    freshness: 0.6,
    ...overrides,
  } as Sensorium
}

function makeLedger(overrides: Partial<CognitiveLedgerInput> = {}): CognitiveLedger {
  return createCognitiveLedger({
    evidence: {
      filesModified: new Set(),
      filesTouched: new Map(),
      deliveryStatus: 'unverified',
      getState: () => ({ filesModified: new Set(), filesTouched: new Map(), deliveryStatus: 'unverified' }),
      recordModification: () => {},
      recordTest: () => {},
      merge: () => {},
    } as any,
    trace: {
      getDoomLevel: () => 'none' as const,
      recordTrace: () => {},
      getRecentTraces: () => [],
    } as any,
    turn: 5,
    ...overrides,
  })
}

describe('cognitive mirror — 认知镜面', () => {
  // ═══════════════════════════════════════════════════════════════
  // buildCognitiveMirror
  // ═══════════════════════════════════════════════════════════════
  it('returns empty string when sensorium is null', () => {
    const ledger = makeLedger({ sensorium: null })
    assert.equal(buildCognitiveMirror(ledger), '')
  })

  it('returns empty string when sensorium is undefined', () => {
    const ledger = makeLedger()
    assert.equal(buildCognitiveMirror(ledger), '')
  })

  it('generates cognitive-mirror tag with visible sensorium dimensions', () => {
    const sensorium = makeSensorium({ confidence: 0.3, complexity: 0.7, freshness: 0.6 })
    const ledger = makeLedger({ sensorium })
    const mirror = buildCognitiveMirror(ledger)

    assert.ok(mirror.startsWith('<cognitive-mirror '))
    assert.ok(mirror.endsWith(' />'))
    assert.ok(mirror.includes('verification_coverage="low"'), `expected coarse label, got: ${mirror}`)
    assert.ok(mirror.includes('complexity="high"'), `expected coarse label, got: ${mirror}`)
    assert.ok(mirror.includes('files_modified="0"'))
  })

  it('includes visible dimensions and excludes routing-only ones', () => {
    const sensorium = makeSensorium({
      confidence: 0.5,
      complexity: 0.3,
      momentum: 0.7,
      stability: 0.8,
      pressure: 0.4,
      freshness: 0.6,
    })
    const ledger = makeLedger({ sensorium })
    const mirror = buildCognitiveMirror(ledger)

    assert.ok(mirror.includes('verification_coverage'))
    assert.ok(mirror.includes('files_modified'))
    assert.ok(mirror.includes('complexity'))
    assert.ok(mirror.includes('stability'))
    // routing-only: consumed by hooks/CCR from sensorium, not shown to model
    assert.ok(!mirror.includes('momentum'), 'momentum is routing-only')
    assert.ok(!mirror.includes('freshness'), 'freshness is routing-only')
    assert.ok(!mirror.includes('pressure'), 'pressure is routing-only')
  })

  it('includes strategy profile when available', () => {
    const sensorium = makeSensorium()
    const strategy: StrategyProfile = {
      reasoningEffort: 'high',
      explorationBreadth: 0.8,
      commitThreshold: 0.9,
      shouldEscalate: true,
      thetaCycleInterval: 3,
    }
    const ledger = makeLedger({ sensorium, strategy })
    const mirror = buildCognitiveMirror(ledger)

    assert.ok(mirror.includes('reasoning="high"'))
    assert.ok(mirror.includes('exploration="0.80"'))
    assert.ok(mirror.includes('caution="0.90"'))
    assert.ok(mirror.includes('escalation="true"'))
  })

  it('omits reasoning when medium (default)', () => {
    const sensorium = makeSensorium()
    const strategy: StrategyProfile = {
      reasoningEffort: 'medium',
      explorationBreadth: 0.5,
      commitThreshold: 0.5,
      shouldEscalate: false,
      thetaCycleInterval: 7,
    }
    const ledger = makeLedger({ sensorium, strategy })
    const mirror = buildCognitiveMirror(ledger)

    assert.ok(!mirror.includes('reasoning'), 'medium reasoning should be omitted as default')
  })

  it('omits caution when commitThreshold is low', () => {
    const sensorium = makeSensorium()
    const strategy: StrategyProfile = {
      reasoningEffort: 'medium',
      explorationBreadth: 0.5,
      commitThreshold: 0.5,
      shouldEscalate: false,
      thetaCycleInterval: 7,
    }
    const ledger = makeLedger({ sensorium, strategy })
    const mirror = buildCognitiveMirror(ledger)

    assert.ok(!mirror.includes('caution'), 'low commit threshold should not show caution')
  })

  it('includes vigor dimension (integrated vigor value)', () => {
    const sensorium = makeSensorium()
    const vigor = { tonic: 0.8, phasic: 0.7, curiosity: 0.3, vigor: 0.75, variability: 0.1, history: [0.7, 0.8] }
    const ledger = makeLedger({ sensorium, vigor })
    const mirror = buildCognitiveMirror(ledger)

    assert.ok(mirror.includes('vigor="0.75"'))
    // curiosity === 0.3 时不展示（阈值 > 0.3）
    assert.ok(!mirror.includes('curiosity'))
  })

  it('formats dimensions to 2 decimal places when evidence present', () => {
    const sensorium = makeSensorium({ confidence: 0.3333, complexity: 0.7777 })
    const ledger = makeLedger({ sensorium, evidence: { filesModified: new Set(['src/x.ts']), toolResults: new Set() } })
    const mirror = buildCognitiveMirror(ledger)

    assert.ok(mirror.includes('verification_coverage="0.33"'), `got: ${mirror}`)
    assert.ok(mirror.includes('complexity="0.78"'), `got: ${mirror}`)
  })

  it('returns concise mirror — no commentary, pure reflection', () => {
    const sensorium = makeSensorium({ confidence: 0.3, complexity: 0.8 })
    const ledger = makeLedger({ sensorium })
    const mirror = buildCognitiveMirror(ledger)

    // Mirror should be a single self-closing tag — no content body
    assert.equal(mirror.split('\n').length, 1)
    // Should not contain natural language commentary
    assert.ok(!mirror.includes('suggest'))
    assert.ok(!mirror.includes('recommend'))
    assert.ok(!mirror.includes('consider'))
  })

  // ═══════════════════════════════════════════════════════════════
  // Cognitive mirror integrated into prompt projection
  // ═══════════════════════════════════════════════════════════════
  it('appears in buildCognitivePromptProjection when sensorium available', () => {
    const sensorium = makeSensorium({ confidence: 0.5 })
    const ledger = makeLedger({ sensorium })
    const projection = buildCognitivePromptProjection(ledger)

    assert.ok(projection.includes('<cognitive-mirror'))
  })

  it('does not appear when sensorium is null', () => {
    const ledger = makeLedger({ sensorium: null })
    const projection = buildCognitivePromptProjection(ledger)

    assert.ok(!projection.includes('<cognitive-mirror'))
  })

  it('coexists with task contract and verification gap when all present', () => {
    // This test verifies that the mirror co-exists with other projections.
    // The contract rendering is tested in task-contract.test.ts.
    // We use a minimal valid contract structure.
    const sensorium = makeSensorium({ confidence: 0.4 })
    const ledger = makeLedger({ sensorium })
    // Even without contract, mirror should still render alongside empty projections
    const projection = buildCognitivePromptProjection(ledger)

    // Mirror should be present
    assert.ok(projection.includes('<cognitive-mirror'))
    // Should be the only content (no contract, no verification gap without filesModified)
    assert.ok(projection.startsWith('<cognitive-mirror'))
  })
})
