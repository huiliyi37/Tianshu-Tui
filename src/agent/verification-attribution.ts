/**
 * VerificationAttribution — 验证结果归因 (B1-4)
 *
 * 将验证结果（typecheck、test run 等）归因到：
 * - owned_failure   → 当前任务拥有的文件失败（我的责任）
 * - external_blocked → 外部因素阻塞（非我的责任）
 * - ambiguous       → 无法明确归因（需要进一步诊断）
 * - verified        → 全部通过
 *
 * 核心原则：不是所有失败都属于我。区分 owned / external / ambiguous
 * 是共享 worktree 下负责任协作的基础。
 *
 * HEARTH 兼容：归因结果可被 invariant verifier 消费（INV-5 drift 检测）。
 * Songline 兼容：归因状态是 obligation fulfillment 的信号。
 *
 * @module verification-attribution
 * @task B1-4
 */

import type { VerificationMetadata } from '../tools/types.js'
import type { OwnershipLedger } from './ownership-ledger.js'
import type { TaskLedgerEvent } from './task-ledger.js'

/**
 * Result of getEffectiveVerifications — deduplicates verification events
 * by (command, scope) key, keeping only the latest event per key.
 */
export interface EffectiveVerifications {
  /** Deduplicated verification metadata (only latest per key) */
  effective: VerificationMetadata[]
  /** Count of earlier failures that were superseded by later successes */
  supersededFailures: number
  /** Total raw event count before deduplication */
  totalRawCount: number
  /** Count of verifications dropped because their snapshotRef is stale
   *  (owned diff changed since the verification ran). */
  staleSnapshotDropped: number
}

/**
 * Normalize a verification command for key generation.
 * Strips common noise (extra whitespace, quotes) to group equivalent commands.
 */
function normalizeCommand(command: string): string {
  return command.trim().replace(/["']/g, '').replace(/\s+/g, ' ').toLowerCase()
}

function asNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function extractTestFiles(command: string): string[] {
  const files = new Set<string>()
  const matches = command.matchAll(/[^\s'"]+\.(?:test|spec)\.(?:ts|tsx|js|jsx|mjs|cjs)/g)
  for (const match of matches) {
    const file = match[0]?.trim().replace(/^['"]|['"]$/g, '')
    if (file) files.add(file)
  }
  return [...files].sort()
}

function getMetaTargetFiles(meta: Record<string, unknown> | undefined): string[] {
  const raw = meta?.targetFiles
  if (!Array.isArray(raw)) return []
  return raw.filter((f): f is string => typeof f === 'string' && f.length > 0).sort()
}

function runnerFamily(command: string): string {
  const normalized = normalizeCommand(command)
  if (
    normalized.startsWith('run_tests')
    || normalized.includes('tsx --test')
    || normalized.includes('node --test')
  ) {
    return 'node-test'
  }
  return normalized.split(' ')[0] ?? normalized
}

function isInvocationFailureMeta(status: TaskLedgerEvent['status'], meta: Record<string, unknown> | undefined): boolean {
  if (status !== 'failed') return false
  return asNumber(meta?.exitCode, 1) !== 0
    && asNumber(meta?.passed, 0) === 0
    && asNumber(meta?.failed, 1) === 0
    && asNumber(meta?.skipped, 0) === 0
}

function eventToVerificationMetadata(event: TaskLedgerEvent): VerificationMetadata {
  const scope = event.meta?.scope === 'full' ? 'full' as const : 'targeted' as const
  const status = (event.status ?? 'passed') as 'passed' | 'failed' | 'blocked'
  const command = event.command ?? 'unknown'
  const targetFiles = getMetaTargetFiles(event.meta)
  const resolvedCommand = asString(event.meta?.resolvedCommand)
  const recommendedCommand = asString(event.meta?.recommendedCommand)
  const snapshotRef = asString(event.meta?.snapshotRef)
  const phaseRaw = asString(event.meta?.verificationPhase)
  const verificationPhase = phaseRaw === 'isolated' || phaseRaw === 'integration' ? phaseRaw : undefined
  const failureKind = asString(event.meta?.failureKind) === 'tool_invocation_failure' || isInvocationFailureMeta(status, event.meta)
    ? 'tool_invocation_failure' as const
    : asString(event.meta?.failureKind) === 'test_failure'
      ? 'test_failure' as const
      : undefined

  return {
    command,
    status,
    scope,
    exitCode: asNumber(event.meta?.exitCode, status === 'failed' ? 1 : 0),
    passed: asNumber(event.meta?.passed, status === 'passed' ? 1 : 0),
    failed: asNumber(event.meta?.failed, status === 'failed' ? 1 : 0),
    skipped: asNumber(event.meta?.skipped, 0),
    durationMs: asNumber(event.meta?.durationMs, 0),
    ...(failureKind ? { failureKind } : {}),
    ...(targetFiles.length > 0 ? { targetFiles } : {}),
    ...(resolvedCommand ? { resolvedCommand } : {}),
    ...(recommendedCommand ? { recommendedCommand } : {}),
    ...(snapshotRef ? { snapshotRef } : {}),
    ...(verificationPhase ? { verificationPhase } : {}),
  }
}

/**
 * Generate a stable deduplication key for a verification event.
 * Events with the same key are considered "same verification" for supersession.
 */
function verificationKey(event: TaskLedgerEvent): string {
  const command = event.command ?? 'unknown'
  const scope = event.meta?.scope === 'full' ? 'full' : 'targeted'
  const resolvedCommand = asString(event.meta?.resolvedCommand) ?? ''

  // meta.targetFiles (populated by tools like run_tests) is authoritative:
  // it contains the actual resolved test file paths, not the raw filter string.
  // Using it prevents key mismatch when the same tests are run with
  // different filter syntax (e.g. "volatile-snapshot.test" vs
  // "src/prompt/__tests__/volatile-snapshot.test.ts").
  const metaTargetFiles = getMetaTargetFiles(event.meta)
  const cmdTargetFiles = extractTestFiles(command)
  const resolvedTargetFiles = extractTestFiles(resolvedCommand)
  const targetFiles = metaTargetFiles.length > 0
    ? metaTargetFiles
    : [...cmdTargetFiles, ...resolvedTargetFiles]
  const uniqueTargetFiles = [...new Set(targetFiles)].sort()

  if (uniqueTargetFiles.length > 0) {
    return `tests::${scope}::${runnerFamily(`${command} ${resolvedCommand}`)}::${uniqueTargetFiles.join('|')}`
  }

  return `${normalizeCommand(command)}::${scope}`
}

/**
 * Deduplicate verification events by (command, scope) key.
 * Later events supersede earlier events with the same key.
 * Old failures that are superseded by later successes are counted
 * but excluded from the effective set.
 */
export function getEffectiveVerifications(
  events: ReadonlyArray<TaskLedgerEvent>,
  currentSnapshotRef?: string,
): EffectiveVerifications {
  const allVerificationEvents = events.filter(e => e.type === 'verification')

  // VSW supersession: a verification recorded under a snapshotRef that differs
  // from the current owned diff is provably stale — the tree it ran on no longer
  // matches reality. Drop it. Verifications without a snapshotRef (in-place /
  // legacy runs) are never dropped, preserving existing behavior.
  let staleSnapshotDropped = 0
  const verificationEvents = currentSnapshotRef
    ? allVerificationEvents.filter(e => {
        const ref = asString(e.meta?.snapshotRef)
        if (ref && ref !== currentSnapshotRef) {
          staleSnapshotDropped++
          return false
        }
        return true
      })
    : allVerificationEvents

  // Process in chronological order (events are already sorted by timestamp)
  const keyMap = new Map<string, { event: TaskLedgerEvent; index: number }>()
  let supersededFailures = 0

  for (let i = 0; i < verificationEvents.length; i++) {
    const event = verificationEvents[i]!
    const key = verificationKey(event)

    const existing = keyMap.get(key)
    if (existing) {
      // Later event supersedes earlier — if earlier was failed and later is passed, count it
      if (existing.event.status === 'failed' && event.status === 'passed') {
        supersededFailures++
      }
    }
    keyMap.set(key, { event, index: i })
  }

  // Convert to VerificationMetadata
  const effective: VerificationMetadata[] = []
  for (const { event } of keyMap.values()) {
    effective.push(eventToVerificationMetadata(event))
  }

  return { effective, supersededFailures, totalRawCount: allVerificationEvents.length, staleSnapshotDropped }
}

export type AttributionClass =
  | 'verified'
  | 'owned_failure'
  | 'external_blocked'
  | 'tool_invocation_failure'
  | 'unattributed_failure'
  | 'unverified'
  /** Phase B (integration) failure: owned diff is correct in isolation but
   *  conflicts with concurrent changes on current HEAD. Not this session's
   *  fault → advisory (rebase/coordinate), never blocking. */
  | 'integration_conflict'

export interface AttributionResult {
  attribution: AttributionClass
  /** Is this failure blocking delivery? */
  isBlocking: boolean
  /** Human-readable explanation */
  reason: string
  /** The source verification metadata */
  source: VerificationMetadata
}

export interface VerificationAttribution {
  attribute(result: VerificationMetadata): AttributionResult
  getAggregateAttribution(results: VerificationMetadata[]): AttributionResult
}

function isInvocationFailure(result: VerificationMetadata): boolean {
  return result.status === 'failed'
    && result.exitCode !== 0
    && result.passed === 0
    && result.failed === 0
    && result.skipped === 0
}

export function createVerificationAttribution(opts: {
  ownership: OwnershipLedger
}): VerificationAttribution {
  function attribute(result: VerificationMetadata): AttributionResult {
    // Passed → verified
    if (result.status === 'passed') {
      return {
        attribution: 'verified',
        isBlocking: false,
        reason: `Verification passed: ${result.command}`,
        source: result,
      }
    }

    // Blocked → external (can't run, not our fault)
    if (result.status === 'blocked') {
      return {
        attribution: 'external_blocked',
        isBlocking: false,
        reason: `Verification blocked by external factors: ${result.command} (exit ${result.exitCode})`,
        source: result,
      }
    }

    // Failed — determine attribution
    if (result.status === 'failed') {
      // Phase B (integration) failure on current HEAD: the owned diff already
      // passed in isolation (Phase A), so this is a concurrent-change conflict,
      // not an owned defect. Advisory only — never blocks delivery.
      if (result.verificationPhase === 'integration') {
        return {
          attribution: 'integration_conflict',
          isBlocking: false,
          reason: `Integration verification failed on current HEAD: ${result.command} — ${result.failed} test(s) failed. The owned diff passed in isolation; this is a concurrent-change conflict. Rebase/coordinate before merging; delivery is not blocked.`,
          source: result,
        }
      }

      if (result.failureKind === 'tool_invocation_failure' || isInvocationFailure(result)) {
        return {
          attribution: 'tool_invocation_failure',
          isBlocking: true,
          reason: `Verification invocation failed: ${result.command}. No tests were executed; rerun with the repo recommended command.`,
          source: result,
        }
      }

      // Targeted test: scope is narrow, likely owned
      if (result.scope === 'targeted') {
        return {
          attribution: 'owned_failure',
          isBlocking: true,
          reason: `Targeted verification failed: ${result.command} — ${result.failed} test(s) failed`,
          source: result,
        }
      }

      // Full test without failure-file attribution is a caveat, not an owned blocker.
      return {
        attribution: 'unattributed_failure',
        isBlocking: false,
        reason: `Full-scope verification failed: ${result.command} — ${result.failed} test(s) failed. Attribution to owned vs external files is unresolved.`,
        source: result,
      }
    }

    // Fallback
    return {
      attribution: 'unverified',
      isBlocking: true,
      reason: `Unknown verification status for: ${result.command}`,
      source: result,
    }
  }

  function getAggregateAttribution(results: VerificationMetadata[]): AttributionResult {
    if (results.length === 0) {
      return {
        attribution: 'unverified',
        isBlocking: true,
        reason: 'No verifications have been run.',
        source: {
          command: '(none)',
          status: 'blocked',
          scope: 'full',
          exitCode: -1,
          passed: 0,
          failed: 0,
          skipped: 0,
          durationMs: 0,
        },
      }
    }

    const attributions = results.map(r => attribute(r))

    // Priority: owned_failure > tool_invocation_failure > unattributed_failure > external_blocked > verified
    const hasOwnedFailure = attributions.some(a => a.attribution === 'owned_failure')
    if (hasOwnedFailure) {
      const first = attributions.find(a => a.attribution === 'owned_failure')!
      return {
        attribution: 'owned_failure',
        isBlocking: true,
        reason: `Owned verification failure: ${first.source.command}`,
        source: first.source,
      }
    }

    const hasToolInvocationFailure = attributions.some(a => a.attribution === 'tool_invocation_failure')
    if (hasToolInvocationFailure) {
      const first = attributions.find(a => a.attribution === 'tool_invocation_failure')!
      return {
        attribution: 'tool_invocation_failure',
        isBlocking: true,
        reason: `Verification invocation failure: ${first.source.command}`,
        source: first.source,
      }
    }

    const hasUnattributedFailure = attributions.some(a => a.attribution === 'unattributed_failure')
    if (hasUnattributedFailure) {
      const first = attributions.find(a => a.attribution === 'unattributed_failure')!
      return {
        attribution: 'unattributed_failure',
        isBlocking: false,
        reason: `Full-suite verification failed without owned-file attribution: ${first.source.command}. Treat as delivery caveat until diagnosed.`,
        source: first.source,
      }
    }

    const hasExternalBlocked = attributions.some(a => a.attribution === 'external_blocked')
    if (hasExternalBlocked) {
      const first = attributions.find(a => a.attribution === 'external_blocked')!
      return {
        attribution: 'external_blocked',
        isBlocking: false,
        reason: `Verification blocked by external factors: ${first.source.command}`,
        source: first.source,
      }
    }

    // Phase B integration conflict: owned diff verified in isolation but clashes
    // with concurrent HEAD. Advisory — surfaced but non-blocking.
    const hasIntegrationConflict = attributions.some(a => a.attribution === 'integration_conflict')
    if (hasIntegrationConflict) {
      const first = attributions.find(a => a.attribution === 'integration_conflict')!
      return {
        attribution: 'integration_conflict',
        isBlocking: false,
        reason: `Integration conflict on current HEAD: ${first.source.command}. Owned changes passed in isolation; rebase/coordinate before merging. Delivery not blocked.`,
        source: first.source,
      }
    }

    // All passed
    return {
      attribution: 'verified',
      isBlocking: false,
      reason: `${results.length} verification(s) passed.`,
      source: results[0]!,
    }
  }

  return { attribute, getAggregateAttribution }
}
