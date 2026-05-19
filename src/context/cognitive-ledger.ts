import type { EvidenceState } from '../agent/evidence.js'
import type { TraceStore } from '../agent/trace-store.js'
import { getDoomLoopLevel, type DoomLoopLevel } from '../agent/trace-store.js'
import { renderContractProjection, type TaskContract } from './task-contract.js'

export interface CognitiveLedgerInput {
  contract?: TaskContract
  evidence: EvidenceState
  trace: TraceStore
  turn: number
}

export interface CognitiveLedger {
  contract?: TaskContract
  evidence: EvidenceState
  trace: TraceStore
  turn: number
}

export interface CognitivePhaseSnapshot {
  contractStatus?: string
  objective?: string
  filesRead: number
  filesModified: number
  deliveryStatus: string
  doomLevel: DoomLoopLevel
  turn: number
}

export function createCognitiveLedger(input: CognitiveLedgerInput): CognitiveLedger {
  return { ...input }
}

export function buildCognitivePromptProjection(ledger: CognitiveLedger): string {
  return ledger.contract ? renderContractProjection(ledger.contract) : ''
}

export function getCognitivePhaseSnapshot(ledger: CognitiveLedger): CognitivePhaseSnapshot {
  return {
    contractStatus: ledger.contract?.status,
    objective: ledger.contract?.objective,
    filesRead: ledger.evidence.filesRead.size,
    filesModified: ledger.evidence.filesModified.size,
    deliveryStatus: ledger.evidence.deliveryStatus,
    doomLevel: getDoomLoopLevel(ledger.trace.toolFingerprints),
    turn: ledger.turn,
  }
}
