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
}

export interface DeliveryReport {
  taskId: string
  state: GateState
  canDeliver: boolean
  ownedFiles: string[]
  ownedFileCount: number
  historicalOwnedFiles: string[]
  historicalOwnedFileCount: number
  externalFiles: string[]
  externalFileCount: number
  verificationCount: number
  /** Count of earlier failures superseded by later successes */
  supersededFailures: number
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

  function getGateFiles(currentDirtyFiles?: string[]): {
    ownedFilesForGate: string[]
    historicalOwnedFiles: string[]
    externalFiles: string[]
  } {
    const allOwnedFiles = ownership.getOwnedFiles()
    const allExternalFiles = ownership.getExternalFiles()
    if (!currentDirtyFiles) {
      return { ownedFilesForGate: allOwnedFiles, historicalOwnedFiles: [], externalFiles: allExternalFiles }
    }

    const currentDirty = new Set(currentDirtyFiles)
    const ownedFilesForGate = allOwnedFiles.filter(f => currentDirty.has(f)).sort()
    const historicalOwnedFiles = allOwnedFiles.filter(f => !currentDirty.has(f)).sort()
    const externalFiles = allExternalFiles.filter(f => currentDirty.has(f)).sort()
    return { ownedFilesForGate, historicalOwnedFiles, externalFiles }
  }

  function assess(externalVerifications: VerificationMetadata[], currentDirtyFiles?: string[]): DeliveryGateResult {
    const { ownedFilesForGate: ownedFiles, externalFiles } = getGateFiles(currentDirtyFiles)

    // Use effective verifications (deduplicated by supersession)
    const rawVerifications = taskLedger.getVerifications()
    const { effective: ownedVerifications, supersededFailures } = getEffectiveVerifications(rawVerifications)

    // Combine owned + external verifications for full picture
    const allVerifications = [
      ...ownedVerifications,
      ...externalVerifications,
    ]

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
        }

      case 'ambiguous':
        return {
          state: 'RED',
          canDeliver: false,
          isBlocked: true,
          reason: aggregate.reason,
          blockingReason: `Verification failure cannot be attributed to owned vs external files. Diagnose before delivery.`,
          ownedFileCount: ownedFiles.length,
          externalFileCount: externalFiles.length,
          verificationCount: allVerifications.length,
          supersededFailures,
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
        }
    }
  }

  function getReport(externalVerifications: VerificationMetadata[], currentDirtyFiles?: string[]): DeliveryReport {
    const result = assess(externalVerifications, currentDirtyFiles)
    const { ownedFilesForGate, historicalOwnedFiles, externalFiles } = getGateFiles(currentDirtyFiles)
    return {
      taskId: taskLedger.getTaskId(),
      state: result.state,
      canDeliver: result.canDeliver,
      ownedFiles: ownedFilesForGate,
      ownedFileCount: result.ownedFileCount,
      historicalOwnedFiles,
      historicalOwnedFileCount: historicalOwnedFiles.length,
      externalFiles,
      externalFileCount: result.externalFileCount,
      verificationCount: result.verificationCount,
      supersededFailures: result.supersededFailures,
      blockingReason: result.blockingReason,
      attributionSummary: result.reason ?? 'No attribution available.',
    }
  }

  return { assess, getReport }
}
