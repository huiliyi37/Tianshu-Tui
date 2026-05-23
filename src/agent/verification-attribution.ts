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

export type AttributionClass =
  | 'verified'
  | 'owned_failure'
  | 'external_blocked'
  | 'ambiguous'
  | 'unverified'

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
      // Targeted test: scope is narrow, likely owned
      if (result.scope === 'targeted') {
        return {
          attribution: 'owned_failure',
          isBlocking: true,
          reason: `Targeted verification failed: ${result.command} — ${result.failed} test(s) failed`,
          source: result,
        }
      }

      // Full test: can't determine ownership from scope alone → ambiguous
      return {
        attribution: 'ambiguous',
        isBlocking: true,
        reason: `Full-scope verification failed: ${result.command} — ${result.failed} test(s) failed. Attribution to owned vs external files requires further diagnosis.`,
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

    // Priority: owned_failure > ambiguous > external_blocked > verified
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

    const hasAmbiguous = attributions.some(a => a.attribution === 'ambiguous')
    if (hasAmbiguous) {
      const first = attributions.find(a => a.attribution === 'ambiguous')!
      return {
        attribution: 'ambiguous',
        isBlocking: true,
        reason: `Ambiguous verification failure: ${first.source.command}. Investigate whether failures are in owned or external files.`,
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
