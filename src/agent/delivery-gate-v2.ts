/**
 * DeliveryGate v2 — 归因感知交付门 (B1-7)
 *
 * 基于 TaskLedger + OwnershipLedger + VerificationAttribution，
 * 生成结构化的交付门状态。使用 GREEN/YELLOW/RED 三态，对齐
 * Stable-State Regression Protocol 的状态机。
 *
 * GREEN  → 稳定态：owned files verified，可交付
 * YELLOW → 不确定态：external blockers，但 owned files verified，可带条件交付
 * RED    → 阻断态：owned failures 或 unverified owned files，禁止交付
 *
 * HEARTH 兼容：交付报告可作为 cycle_close 的证据沉积。
 * Songline 兼容：交付状态是 obligation fulfillment 的生态信号。
 *
 * @module delivery-gate-v2
 * @task B1-7
 */

import type { TaskLedger } from './task-ledger.js'
import type { OwnershipLedger } from './ownership-ledger.js'
import type { VerificationAttribution } from './verification-attribution.js'
import { getEffectiveVerifications } from './verification-attribution.js'
import { summarizeOwnershipHealth } from './ownership-health.js'
import type { VerificationMetadata } from '../tools/types.js'

export type GateState = 'GREEN' | 'YELLOW' | 'RED'

export interface DeliveryGateResult {
  state: GateState
  canDeliver: boolean
  isBlocked: boolean
  reason?: string
  blockingReason?: string
  ownedFileCount: number
  externalFileCount: number
  verificationCount: number
  /** Count of earlier failures superseded by later successes */
  supersededFailures: number
  staleFailureCandidates: number
  toolInvocationFailureCandidates: string[]
  currentBlockingFailure?: string
  shortestNextStep?: string
}

export interface DeliveryReport {
  taskId: string
  state: GateState
  canDeliver: boolean
  ownedFiles: string[]
  ownedFileCount: number
  coOwnedFiles: string[]
  coOwnedFileCount: number
  historicalOwnedFiles: string[]
  historicalOwnedFileCount: number
  externalFiles: string[]
  externalFileCount: number
  verificationCount: number
  /** Count of earlier failures superseded by later successes */
  supersededFailures: number
  staleFailureCandidates: number
  toolInvocationFailureCandidates: string[]
  currentBlockingFailure?: string
  shortestNextStep?: string
  blockingReason?: string
  /** Full attribution result for diagnostics */
  attributionSummary: string
}

export interface DeliveryGateV2 {
  /** Assess delivery readiness, optionally with external verification metadata and current dirty files */
  assess(externalVerifications: VerificationMetadata[], currentDirtyFiles?: string[]): DeliveryGateResult
  /** Full structured report suitable for cycle_close deposit */
  getReport(externalVerifications: VerificationMetadata[], currentDirtyFiles?: string[]): DeliveryReport
}

export function createDeliveryGateV2(opts: {
  taskLedger: TaskLedger
  ownership: OwnershipLedger
  attribution: VerificationAttribution
}): DeliveryGateV2 {
  const { taskLedger, ownership, attribution } = opts

  const emptyDiagnostics = {
    staleFailureCandidates: 0,
    toolInvocationFailureCandidates: [] as string[],
  }

  function isToolInvocationFailure(v: VerificationMetadata): boolean {
    return v.failureKind === 'tool_invocation_failure'
      || (v.status === 'failed' && v.exitCode !== 0 && v.passed === 0 && v.failed === 0 && v.skipped === 0)
  }

  function verificationDiagnostics(verifications: VerificationMetadata[], supersededFailures: number): Pick<DeliveryGateResult, 'staleFailureCandidates' | 'toolInvocationFailureCandidates' | 'shortestNextStep'> {
    const invocationFailures = verifications.filter(isToolInvocationFailure)
    const shortestNextStep = invocationFailures
      .map(v => v.recommendedCommand ?? v.resolvedCommand)
      .find((cmd): cmd is string => typeof cmd === 'string' && cmd.length > 0)
    return {
      staleFailureCandidates: supersededFailures,
      toolInvocationFailureCandidates: invocationFailures.map(v => v.command),
      ...(shortestNextStep ? { shortestNextStep } : {}),
    }
  }

  function getGateFiles(currentDirtyFiles?: string[]): {
    ownedFilesForGate: string[]
    coOwnedFiles: string[]
    historicalOwnedFiles: string[]
    externalFiles: string[]
  } {
    const allOwnedFiles = ownership.getOwnedFiles()
    const allCoOwnedFiles = ownership.getCoOwnedFiles()
    const allExternalFiles = ownership.getExternalFiles(currentDirtyFiles)
    if (!currentDirtyFiles) {
      return {
        ownedFilesForGate: allOwnedFiles,
        coOwnedFiles: allCoOwnedFiles,
        historicalOwnedFiles: [],
        externalFiles: allExternalFiles,
      }
    }

    const currentDirty = new Set(currentDirtyFiles)
    const ownedFilesForGate = allOwnedFiles.filter(f => currentDirty.has(f)).sort()
    const coOwnedFiles = allCoOwnedFiles.filter(f => currentDirty.has(f)).sort()
    const historicalOwnedFiles = allOwnedFiles.filter(f => !currentDirty.has(f)).sort()
    const externalFiles = allExternalFiles.filter(f => currentDirty.has(f)).sort()
    return { ownedFilesForGate, coOwnedFiles, historicalOwnedFiles, externalFiles }
  }

  function assess(externalVerifications: VerificationMetadata[], currentDirtyFiles?: string[]): DeliveryGateResult {
    const { ownedFilesForGate: ownedFiles, coOwnedFiles, externalFiles } = getGateFiles(currentDirtyFiles)

    // Check ownership health for unclassified dirty files
    if (currentDirtyFiles) {
      const health = summarizeOwnershipHealth({
        ownedFiles,
        coOwnedFiles,
        externalFiles,
        dirtyFiles: currentDirtyFiles,
      })
      if (health.warningLines.length > 0) {
        // Unclassified dirty files → YELLOW with caveat
        return {
          state: 'YELLOW',
          canDeliver: true,
          isBlocked: false,
          reason: `${health.warningLines.length} dirty file(s) have no ownership classification. Deliverable with caveat.`,
          ownedFileCount: ownedFiles.length,
          externalFileCount: externalFiles.length,
          verificationCount: externalVerifications.length,
          supersededFailures: 0,
          ...emptyDiagnostics,
        }
      }
    }

    // Use effective verifications (deduplicated by supersession)
    const rawVerifications = taskLedger.getVerifications()
    const { effective: ownedVerifications, supersededFailures } = getEffectiveVerifications(rawVerifications)

    // Combine owned + external verifications for full picture
    const allVerifications = [
      ...ownedVerifications,
      ...externalVerifications,
    ]
    const diagnostics = verificationDiagnostics(allVerifications, supersededFailures)

    // Nothing to deliver
    if (ownedFiles.length === 0) {
      const hasExternals = externalFiles.length > 0
      return {
        state: 'GREEN',
        canDeliver: true,
        isBlocked: false,
        reason: hasExternals
          ? `No owned files modified. ${externalFiles.length} external dirty file(s) present but excluded from delivery scope.`
          : 'No file modifications.',
        ownedFileCount: 0,
        externalFileCount: externalFiles.length,
        verificationCount: allVerifications.length,
        supersededFailures,
        ...diagnostics,
      }
    }

    // Check attribution
    const aggregate = attribution.getAggregateAttribution(allVerifications)

    switch (aggregate.attribution) {
      case 'verified':
        return {
          state: 'GREEN',
          canDeliver: true,
          isBlocked: false,
          reason: `${ownedFiles.length} owned file(s) verified. Ready to deliver.`,
          ownedFileCount: ownedFiles.length,
          externalFileCount: externalFiles.length,
          verificationCount: allVerifications.length,
          supersededFailures,
          ...diagnostics,
        }

      case 'external_blocked':
        return {
          state: 'YELLOW',
          canDeliver: true,
          isBlocked: false,
          reason: `${ownedFiles.length} owned file(s) verified, but external verification blocked: ${aggregate.reason}. Deliverable with caveat.`,
          ownedFileCount: ownedFiles.length,
          externalFileCount: externalFiles.length,
          verificationCount: allVerifications.length,
          supersededFailures,
          ...diagnostics,
        }

      case 'owned_failure':
        return {
          state: 'RED',
          canDeliver: false,
          isBlocked: true,
          reason: aggregate.reason,
          blockingReason: `Owned verification failed. Fix failures before delivery.`,
          ownedFileCount: ownedFiles.length,
          externalFileCount: externalFiles.length,
          verificationCount: allVerifications.length,
          supersededFailures,
          ...diagnostics,
          currentBlockingFailure: aggregate.reason,
        }

      case 'tool_invocation_failure':
        return {
          state: 'YELLOW',
          canDeliver: true,
          isBlocked: false,
          reason: `${aggregate.reason}\n\nThis is a tool invocation issue (timeout, crash) — not a code failure. Re-run with the recommended command. You may still deliver if you have independently verified correctness.`,
          ownedFileCount: ownedFiles.length,
          externalFileCount: externalFiles.length,
          verificationCount: allVerifications.length,
          supersededFailures,
          ...diagnostics,
        }

      case 'unattributed_failure':
        return {
          state: 'YELLOW',
          canDeliver: true,
          isBlocked: false,
          reason: `${ownedFiles.length} owned file(s) are not directly implicated, but verification has unresolved full-suite failure: ${aggregate.reason}. Deliverable with caveat.`,
          ownedFileCount: ownedFiles.length,
          externalFileCount: externalFiles.length,
          verificationCount: allVerifications.length,
          supersededFailures,
          ...diagnostics,
        }

      case 'unverified':
        return {
          state: 'RED',
          canDeliver: false,
          isBlocked: true,
          reason: `${ownedFiles.length} owned file(s) modified but unverified.`,
          blockingReason: `Run verification before delivery.`,
          ownedFileCount: ownedFiles.length,
          externalFileCount: externalFiles.length,
          verificationCount: allVerifications.length,
          supersededFailures,
          ...diagnostics,
          currentBlockingFailure: `${ownedFiles.length} owned file(s) modified but unverified.`,
        }

      default:
        return {
          state: 'RED',
          canDeliver: false,
          isBlocked: true,
          reason: 'Unknown verification state.',
          ownedFileCount: ownedFiles.length,
          externalFileCount: externalFiles.length,
          verificationCount: allVerifications.length,
          supersededFailures,
          ...diagnostics,
          currentBlockingFailure: 'Unknown verification state.',
        }
    }
  }

  function getReport(externalVerifications: VerificationMetadata[], currentDirtyFiles?: string[]): DeliveryReport {
    const result = assess(externalVerifications, currentDirtyFiles)
    const { ownedFilesForGate, coOwnedFiles, historicalOwnedFiles, externalFiles } = getGateFiles(currentDirtyFiles)
    return {
      taskId: taskLedger.getTaskId(),
      state: result.state,
      canDeliver: result.canDeliver,
      ownedFiles: ownedFilesForGate,
      ownedFileCount: result.ownedFileCount,
      coOwnedFiles,
      coOwnedFileCount: coOwnedFiles.length,
      historicalOwnedFiles,
      historicalOwnedFileCount: historicalOwnedFiles.length,
      externalFiles,
      externalFileCount: result.externalFileCount,
      verificationCount: result.verificationCount,
      supersededFailures: result.supersededFailures,
      staleFailureCandidates: result.staleFailureCandidates,
      toolInvocationFailureCandidates: result.toolInvocationFailureCandidates,
      currentBlockingFailure: result.currentBlockingFailure,
      shortestNextStep: result.shortestNextStep,
      blockingReason: result.blockingReason,
      attributionSummary: result.reason ?? 'No attribution available.',
    }
  }

  return { assess, getReport }
}
