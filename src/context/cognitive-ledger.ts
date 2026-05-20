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
  scopeFileCount: number
  isActionableTask: boolean
  hasVerificationGap: boolean
  filesRead: number
  filesModified: number
  deliveryStatus: string
  doomLevel: DoomLoopLevel
  turn: number
}

export function createCognitiveLedger(input: CognitiveLedgerInput): CognitiveLedger {
  return { ...input }
}

export function buildVerificationGapProjection(ledger: CognitiveLedger): string {
  const modifiedCount = ledger.evidence.filesModified.size
  if (modifiedCount === 0) return ''
  if (ledger.evidence.deliveryStatus !== 'unverified') return ''
  return `<verification-gap status="unverified" modified="${modifiedCount}">Run relevant verification before claiming done.</verification-gap>`
}

export function buildCognitivePromptProjection(ledger: CognitiveLedger): string {
  return [
    ledger.contract ? renderContractProjection(ledger.contract) : '',
    buildVerificationGapProjection(ledger),
  ].filter(Boolean).join('\n')
}

export function getCognitivePhaseSnapshot(ledger: CognitiveLedger): CognitivePhaseSnapshot {
  return {
    contractStatus: ledger.contract?.status,
    objective: ledger.contract?.objective,
    scopeFileCount: ledger.contract?.scope.mentionedFiles.length ?? 0,
    isActionableTask: ledger.contract?.isActionable ?? false,
    hasVerificationGap: buildVerificationGapProjection(ledger).length > 0,
    filesRead: ledger.evidence.filesRead.size,
    filesModified: ledger.evidence.filesModified.size,
    deliveryStatus: ledger.evidence.deliveryStatus,
    doomLevel: getDoomLoopLevel(ledger.trace.toolFingerprints),
    turn: ledger.turn,
  }
}
