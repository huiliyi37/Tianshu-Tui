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

import { spawnSync } from 'node:child_process'
import type { TaskLedger } from './task-ledger.js'
import type { OwnershipLedger } from './ownership-ledger.js'
import type { VerificationAttribution, AttributionClass } from './verification-attribution.js'
import { getEffectiveVerifications } from './verification-attribution.js'
import { summarizeOwnershipHealth } from './ownership-health.js'
import type { VerificationMetadata } from '../tools/types.js'

// ─── External-file noise filtering (C-fix, session 803d897d) ───────────────
// 67 untracked .test-tmp files drowned the GREEN/YELLOW signal in every
// delivery report. External files from junk directories are noise, not
// blockers — filter them from display and summarize the count.

const JUNK_PATH_PREFIXES = [
  '.test-tmp/',
  '.rivet/',
  'node_modules/',
  '.git/',
  'dist/',
  'build/',
  'coverage/',
  'tmp/',
]

export function isJunkExternalPath(file: string): boolean {
  return JUNK_PATH_PREFIXES.some(prefix => file.startsWith(prefix))
}

/** Files matched by .gitignore (batched `git check-ignore`). Fails open to []. */
function gitIgnoredSubset(files: string[], cwd: string): Set<string> {
  if (files.length === 0) return new Set()
  try {
    const r = spawnSync('git', ['check-ignore', '--stdin'], {
      cwd,
      input: files.join('\n'),
      encoding: 'utf-8',
      timeout: 5000,
    })
    // exit 0: some ignored; exit 1: none ignored; other: error → fail open
    if (r.status !== 0 && r.status !== 1) return new Set()
    return new Set(r.stdout.split('\n').filter(Boolean))
  } catch {
    return new Set()
  }
}

export interface ExternalNoiseSplit {
  /** Signal-bearing external files, in original order. */
  files: string[]
  /** Count of filtered junk/gitignored paths. */
  noiseCount: number
}

/**
 * Split external files into signal vs noise (junk dirs + gitignored paths).
 * cwd is used for the gitignore check; omit to use prefix rules only.
 */
export function filterExternalNoise(files: string[], cwd?: string): ExternalNoiseSplit {
  const prefixKept = files.filter(f => !isJunkExternalPath(f))
  const ignored = cwd ? gitIgnoredSubset(prefixKept, cwd) : new Set<string>()
  const kept = prefixKept.filter(f => !ignored.has(f))
  return { files: kept, noiseCount: files.length - kept.length }
}

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
  latestVerificationTotals?: { passed: number; failed: number; skipped: number; command: string }
  staleFailureCandidates: number
  toolInvocationFailureCandidates: string[]
  currentBlockingFailure?: string
  shortestNextStep?: string
  /** The verification attribution class that caused this gate state.
   *  Used by deliver_task to decide mechanical-change bypass. */
  attributionClass?: AttributionClass
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
  /** Latest verification pass/fail/skipped totals — for "声明即实测" echo in deliver_task output.
   *  Agents copy these numbers into delivery reports instead of guessing from memory. */
  latestVerificationTotals?: { passed: number; failed: number; skipped: number; command: string }
  staleFailureCandidates: number
  toolInvocationFailureCandidates: string[]
  currentBlockingFailure?: string
  shortestNextStep?: string
  blockingReason?: string
  /** The verification attribution class causing this gate state.
   *  Used by deliver_task to decide mechanical-change bypass. */
  attributionClass?: AttributionClass
  /** Full attribution result for diagnostics */
  attributionSummary: string
}

export interface DeliveryGateV2 {
  /** Assess delivery readiness, optionally with external verification metadata,
   *  current dirty files, and the current VSW snapshotRef (drops stale snapshot
   *  verifications when provided). */
  assess(externalVerifications: VerificationMetadata[], currentDirtyFiles?: string[], currentSnapshotRef?: string): DeliveryGateResult
  /** Full structured report suitable for cycle_close deposit */
  getReport(externalVerifications: VerificationMetadata[], currentDirtyFiles?: string[], currentSnapshotRef?: string): DeliveryReport
}

/**
 * Track 3 门禁合一：收敛检测 L2+ 时基于权威门禁状态生成结束/修复指引。
 * GREEN → 指示输出最终摘要结束回合；RED → 指示阻断项与最短下一步；
 * YELLOW → 可带条件交付。返回的字符串作为 system-reminder 注入。
 */
export function buildGateConvergenceHint(
  gate: Pick<DeliveryGateResult, 'state' | 'reason' | 'blockingReason' | 'shortestNextStep'>,
  depthLayer?: import('../context/task-contract.js').TaskDepthLayer,
): string {
  const depthSuffix = depthLayer && depthLayer !== 'unit'
    ? `\n[depth=${depthLayer}] 验证必须覆盖跨模块边界，不仅仅是单函数行为。`
    : ''
  if (gate.state === 'GREEN') {
    return '交付门禁 GREEN：所有 owned 文件已验证。请输出最终摘要并结束回合，不再调用工具。' + depthSuffix
  }
  if (gate.state === 'RED') {
    const lines = [`交付门禁 RED：${gate.blockingReason ?? gate.reason ?? 'owned 文件存在未验证或失败项。'}`]
    if (gate.shortestNextStep) lines.push(`最短下一步：${gate.shortestNextStep}`)
    lines.push('请先解决阻断项再继续；若无法解决，明确报告阻断原因后结束回合。')
    return lines.join('\n') + depthSuffix
  }
  return `交付门禁 YELLOW：${gate.reason ?? '存在外部阻塞，owned 文件已验证。'}\n可带条件交付：输出最终摘要并明确标注 caveat，然后结束回合。${depthSuffix}`
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

  function assess(externalVerifications: VerificationMetadata[], currentDirtyFiles?: string[], currentSnapshotRef?: string): DeliveryGateResult {
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

    // Use effective verifications (deduplicated by supersession + VSW staleness)
    const rawVerifications = taskLedger.getVerifications()
    const { effective: ownedVerifications, supersededFailures } = getEffectiveVerifications(rawVerifications, currentSnapshotRef)

    // Combine owned + external verifications for full picture
    const allVerifications = [
      ...ownedVerifications,
      ...externalVerifications,
    ]
    const diagnostics = verificationDiagnostics(allVerifications, supersededFailures)

    // 层 1a: latest verification totals for "声明即实测" echo
    const _lv = allVerifications.length > 0 ? allVerifications[allVerifications.length - 1] : undefined
    const latestVerificationTotals = _lv
      ? { passed: _lv.passed, failed: _lv.failed, skipped: _lv.skipped, command: _lv.command }
      : undefined

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
      latestVerificationTotals,
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
      latestVerificationTotals,
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
      latestVerificationTotals,
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
      latestVerificationTotals,
          currentBlockingFailure: aggregate.reason,
          attributionClass: 'owned_failure',
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
      latestVerificationTotals,
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
      latestVerificationTotals,
        }

      case 'integration_conflict':
        // Phase B failed on current HEAD but the owned diff passed in isolation
        // (Phase A). Concurrent-change conflict — advisory, not this session's
        // fault. Deliverable with a rebase/coordinate caveat.
        return {
          state: 'YELLOW',
          canDeliver: true,
          isBlocked: false,
          reason: `${ownedFiles.length} owned file(s) verified in isolation, but integration on current HEAD conflicts: ${aggregate.reason}`,
          ownedFileCount: ownedFiles.length,
          externalFileCount: externalFiles.length,
          verificationCount: allVerifications.length,
          supersededFailures,
          ...diagnostics,
      latestVerificationTotals,
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
      latestVerificationTotals,
          currentBlockingFailure: `${ownedFiles.length} owned file(s) modified but unverified.`,
          attributionClass: 'unverified',
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
      latestVerificationTotals,
          currentBlockingFailure: 'Unknown verification state.',
          attributionClass: 'unverified',
        }
    }
  }

  function getReport(externalVerifications: VerificationMetadata[], currentDirtyFiles?: string[], currentSnapshotRef?: string): DeliveryReport {
    const result = assess(externalVerifications, currentDirtyFiles, currentSnapshotRef)
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
      latestVerificationTotals: result.latestVerificationTotals,
      staleFailureCandidates: result.staleFailureCandidates,
      toolInvocationFailureCandidates: result.toolInvocationFailureCandidates,
      currentBlockingFailure: result.currentBlockingFailure,
      shortestNextStep: result.shortestNextStep,
      blockingReason: result.blockingReason,
      attributionClass: result.attributionClass,
      attributionSummary: result.reason ?? 'No attribution available.',
    }
  }

  return { assess, getReport }
}
