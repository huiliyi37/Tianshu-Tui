import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildCognitivePromptProjection,
  buildCognitiveProjectionParts,
  buildVerificationGapProjection,
  createCognitiveLedger,
  getCognitivePhaseSnapshot,
} from '../cognitive-ledger.js'
import { advanceContractStatus, extractTaskContract, type TaskContract } from '../task-contract.js'
import type { EvidenceState } from '../../agent/evidence.js'
import type { TraceStore } from '../../agent/trace-store.js'
import type { Sensorium } from '../../agent/sensorium.js'

function makeEvidence(overrides: Partial<EvidenceState> = {}): EvidenceState {
  return {
    filesRead: overrides.filesRead ?? new Set(['src/auth.ts', 'src/types.ts']),
    filesModified: overrides.filesModified ?? new Set(['src/auth.ts']),
    verifications: overrides.verifications ?? [],
    deliveryStatus: overrides.deliveryStatus ?? 'unverified',
    impactedFiles: overrides.impactedFiles ?? new Set(),
    impactedTests: overrides.impactedTests ?? new Set(),
  }
}

function makeTrace(fingerprints: string[] = []): TraceStore {
  return { maxEvents: 50, events: [], toolFingerprints: fingerprints }
}

function makeContract(): TaskContract {
  return advanceContractStatus(extractTaskContract('fix auth bug in src/auth.ts. Don\'t break API'), 'executing', 5)
}

describe('CognitiveLedger read model', () => {
  it('buildCognitivePromptProjection includes contract objective', () => {
    const ledger = createCognitiveLedger({ contract: makeContract(), evidence: makeEvidence(), trace: makeTrace(), turn: 5 })
    const projection = buildCognitivePromptProjection(ledger)
    assert.ok(projection.includes('fix auth bug'))
    assert.ok(projection.includes('task-contract'))
  })

  it('buildCognitivePromptProjection is short for simple contract with verification gap', () => {
    const ledger = createCognitiveLedger({ contract: makeContract(), evidence: makeEvidence(), trace: makeTrace(), turn: 5 })
    const projection = buildCognitivePromptProjection(ledger)
    assert.ok(projection.length < 800, `Projection too long: ${projection.length}`)
    assert.match(projection, /<verification-gap/)
  })

  it('buildCognitiveProjectionParts separates one-shot hints from the stable projection (C1)', () => {
    const ledger = createCognitiveLedger({ contract: makeContract(), evidence: makeEvidence(), trace: makeTrace(), turn: 5 })
    const hint = '【瑶光·复现即证】绿非证明,复现即证。'
    const { stable, ephemeral } = buildCognitiveProjectionParts(ledger, { yaoguangHint: hint })

    // stable carries the contract/objective and verification gap; never the hint.
    assert.match(stable, /<task-contract/)
    assert.match(stable, /<objective>/)
    assert.doesNotMatch(stable, /复现即证/)
    // ephemeral carries only the one-shot hint.
    assert.equal(ephemeral, hint)
  })

  it('buildCognitiveProjectionParts yields empty ephemeral when no hints are present', () => {
    const ledger = createCognitiveLedger({ contract: makeContract(), evidence: makeEvidence(), trace: makeTrace(), turn: 5 })
    const { stable, ephemeral } = buildCognitiveProjectionParts(ledger)
    assert.equal(ephemeral, '')
    assert.ok(stable.length > 0)
  })

  it('buildCognitivePromptProjection equals stable + ephemeral joined (backward compat)', () => {
    const ledger = createCognitiveLedger({ contract: makeContract(), evidence: makeEvidence(), trace: makeTrace(), turn: 5 })
    const hint = 'one-shot hint text'
    const combined = buildCognitivePromptProjection(ledger, { sycophancyHint: hint })
    const { stable, ephemeral } = buildCognitiveProjectionParts(ledger, { sycophancyHint: hint })
    assert.equal(combined, [stable, ephemeral].filter(Boolean).join('\n'))
    assert.match(combined, /one-shot hint text/)
  })

  it('omits non-actionable contract while preserving other cognitive projections', () => {
    const contract = extractTaskContract('hello')
    const ledger = createCognitiveLedger({ contract, evidence: makeEvidence(), trace: makeTrace(), turn: 1 })
    const projection = buildCognitivePromptProjection(ledger)
    assert.doesNotMatch(projection, /<task-contract/)
    assert.match(projection, /<verification-gap/)
  })

  it('keeps actionable exploring contracts as anti-drift anchors', () => {
    const contract = extractTaskContract('fix src/api/client.ts retry bug')
    const ledger = createCognitiveLedger({ contract, evidence: makeEvidence(), trace: makeTrace(), turn: 1 })
    assert.match(buildCognitivePromptProjection(ledger), /status="exploring"/)
  })

  it('getCognitivePhaseSnapshot returns structured state', () => {
    const ledger = createCognitiveLedger({ contract: makeContract(), evidence: makeEvidence(), trace: makeTrace(), turn: 5 })
    const snapshot = getCognitivePhaseSnapshot(ledger)
    assert.equal(snapshot.contractStatus, 'executing')
    assert.equal(snapshot.scopeFileCount, 1)
    assert.equal(snapshot.isActionableTask, true)
    assert.equal(snapshot.hasVerificationGap, true)
    assert.equal(snapshot.deliveryStatus, 'unverified')
  })

  it('getCognitivePhaseSnapshot omits doom-level and turn (pruned fields)', () => {
    const ledger = createCognitiveLedger({ contract: makeContract(), evidence: makeEvidence(), trace: makeTrace(['same', 'same', 'same']), turn: 5 })
    const snapshot = getCognitivePhaseSnapshot(ledger)
    // doomLevel and turn are no longer in snapshot — they were pruned as unread
    const keys = Object.keys(snapshot)
    assert.ok(!keys.includes('doomLevel'))
    assert.ok(!keys.includes('turn'))
    assert.ok(!keys.includes('filesRead'))
    assert.ok(!keys.includes('filesModified'))
  })

  it('works without contract while still projecting verification gap when needed', () => {
    const ledger = createCognitiveLedger({ evidence: makeEvidence(), trace: makeTrace(), turn: 0 })
    const snapshot = getCognitivePhaseSnapshot(ledger)
    assert.equal(snapshot.contractStatus, undefined)
    assert.equal(snapshot.scopeFileCount, 0)
    assert.equal(snapshot.isActionableTask, false)
    assert.equal(snapshot.hasVerificationGap, true)
    assert.match(buildCognitivePromptProjection(ledger), /<verification-gap/)
  })
})

describe('verification gap projection', () => {
  it('omits gap when no files were modified', () => {
    const ledger = createCognitiveLedger({
      evidence: makeEvidence({ filesModified: new Set() }),
      trace: makeTrace(),
      turn: 1,
    })
    assert.equal(buildVerificationGapProjection(ledger), '')
  })

  it('projects compact gap when files are modified but unverified', () => {
    const ledger = createCognitiveLedger({ evidence: makeEvidence(), trace: makeTrace(), turn: 1 })
    const gap = buildVerificationGapProjection(ledger)
    assert.match(gap, /<verification-gap status="unverified" modified="1">/)
    assert.match(gap, /Run relevant verification before claiming done/)
    assert.ok(gap.length < 160, `Gap projection too long: ${gap.length}`)
  })

  it('omits gap when modified files are verified', () => {
    const ledger = createCognitiveLedger({
      evidence: makeEvidence({ deliveryStatus: 'verified' }),
      trace: makeTrace(),
      turn: 1,
    })
    assert.equal(buildVerificationGapProjection(ledger), '')
  })

  it('omits gap when verification failed because repairHint handles that path', () => {
    const ledger = createCognitiveLedger({
      evidence: makeEvidence({ deliveryStatus: 'failed' }),
      trace: makeTrace(),
      turn: 1,
    })
    assert.equal(buildVerificationGapProjection(ledger), '')
  })

  it('omits gap when verification is blocked', () => {
    const ledger = createCognitiveLedger({
      evidence: makeEvidence({ deliveryStatus: 'blocked' }),
      trace: makeTrace(),
      turn: 1,
    })
    assert.equal(buildVerificationGapProjection(ledger), '')
  })
})

describe('uncertainty framing projection — 万物为一原则④', () => {
  function makeSensorium(confidence: number): Sensorium {
    return {
      momentum: 0.5,
      pressure: 0.3,
      confidence,
      complexity: 0.4,
      freshness: 0.5,
      stability: 0.8,
    }
  }

  it('injects uncertainty hint when confidence < 0.4 + risk high', () => {
    const ledger = createCognitiveLedger({
      evidence: makeEvidence(),
      trace: makeTrace(),
      turn: 3,
      sensorium: makeSensorium(0.25),
      riskLevel: 'high',
    })
    const projection = buildCognitivePromptProjection(ledger)
    assert.match(projection, /\[Uncertainty Framing\]/)
    assert.match(projection, /0\.25/)
  })

  it('injects uncertainty hint when confidence < 0.4 + risk medium', () => {
    const ledger = createCognitiveLedger({
      evidence: makeEvidence(),
      trace: makeTrace(),
      turn: 3,
      sensorium: makeSensorium(0.3),
      riskLevel: 'medium',
    })
    const projection = buildCognitivePromptProjection(ledger)
    assert.match(projection, /\[Uncertainty Framing\]/)
  })

  it('omits uncertainty when confidence >= 0.4', () => {
    const ledger = createCognitiveLedger({
      evidence: makeEvidence(),
      trace: makeTrace(),
      turn: 3,
      sensorium: makeSensorium(0.5),
      riskLevel: 'high',
    })
    const projection = buildCognitivePromptProjection(ledger)
    assert.doesNotMatch(projection, /\[Uncertainty Framing\]/)
  })

  it('omits uncertainty when risk is low', () => {
    const ledger = createCognitiveLedger({
      evidence: makeEvidence(),
      trace: makeTrace(),
      turn: 3,
      sensorium: makeSensorium(0.2),
      riskLevel: 'low',
    })
    const projection = buildCognitivePromptProjection(ledger)
    assert.doesNotMatch(projection, /\[Uncertainty Framing\]/)
  })

  it('omits uncertainty when no sensorium present', () => {
    const ledger = createCognitiveLedger({
      evidence: makeEvidence(),
      trace: makeTrace(),
      turn: 3,
      riskLevel: 'high',
    })
    const projection = buildCognitivePromptProjection(ledger)
    assert.doesNotMatch(projection, /\[Uncertainty Framing\]/)
  })

  it('omits uncertainty when no risk level present', () => {
    const ledger = createCognitiveLedger({
      evidence: makeEvidence(),
      trace: makeTrace(),
      turn: 3,
      sensorium: makeSensorium(0.2),
    })
    const projection = buildCognitivePromptProjection(ledger)
    assert.doesNotMatch(projection, /\[Uncertainty Framing\]/)
  })

  it('coexists with cognitive mirror and verification gap', () => {
    const ledger = createCognitiveLedger({
      contract: makeContract(),
      evidence: makeEvidence(),
      trace: makeTrace(),
      turn: 5,
      sensorium: makeSensorium(0.15),
      riskLevel: 'high',
    })
    const projection = buildCognitivePromptProjection(ledger)
    assert.match(projection, /<cognitive-mirror/)
    assert.match(projection, /<verification-gap/)
    assert.match(projection, /\[Uncertainty Framing\]/)
  })
})
