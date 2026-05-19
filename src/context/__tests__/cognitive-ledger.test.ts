import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildCognitivePromptProjection,
  createCognitiveLedger,
  getCognitivePhaseSnapshot,
} from '../cognitive-ledger.js'
import { advanceContractStatus, extractTaskContract, type TaskContract } from '../task-contract.js'
import type { EvidenceState } from '../../agent/evidence.js'
import type { TraceStore } from '../../agent/trace-store.js'

function makeEvidence(): EvidenceState {
  return {
    filesRead: new Set(['src/auth.ts', 'src/types.ts']),
    filesModified: new Set(['src/auth.ts']),
    verifications: [],
    deliveryStatus: 'unverified',
    impactedFiles: new Set(),
    impactedTests: new Set(),
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

  it('buildCognitivePromptProjection is short for simple contract', () => {
    const ledger = createCognitiveLedger({ contract: makeContract(), evidence: makeEvidence(), trace: makeTrace(), turn: 5 })
    const projection = buildCognitivePromptProjection(ledger)
    assert.ok(projection.length < 600, `Projection too long: ${projection.length}`)
  })

  it('omits non-actionable contracts', () => {
    const contract = extractTaskContract('hello')
    const ledger = createCognitiveLedger({ contract, evidence: makeEvidence(), trace: makeTrace(), turn: 1 })
    assert.equal(buildCognitivePromptProjection(ledger), '')
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

  it('works without contract', () => {
    const ledger = createCognitiveLedger({ evidence: makeEvidence(), trace: makeTrace(), turn: 0 })
    const snapshot = getCognitivePhaseSnapshot(ledger)
    assert.equal(snapshot.contractStatus, undefined)
    assert.equal(buildCognitivePromptProjection(ledger), '')
  })
})
