import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildCognitivePromptProjection,
  buildVerificationGapProjection,
  createCognitiveLedger,
  getCognitivePhaseSnapshot,
} from '../cognitive-ledger.js'
import { advanceContractStatus, extractTaskContract, type TaskContract } from '../task-contract.js'
import type { EvidenceState } from '../../agent/evidence.js'
import type { TraceStore } from '../../agent/trace-store.js'

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
    assert.equal(snapshot.filesRead, 2)
    assert.equal(snapshot.filesModified, 1)
    assert.equal(snapshot.deliveryStatus, 'unverified')
    assert.equal(snapshot.doomLevel, 'none')
    assert.equal(snapshot.turn, 5)
  })

  it('reuses TraceStore doom-loop detection', () => {
    const ledger = createCognitiveLedger({ contract: makeContract(), evidence: makeEvidence(), trace: makeTrace(['same', 'same', 'same']), turn: 5 })
    assert.equal(getCognitivePhaseSnapshot(ledger).doomLevel, 'blocked')
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
