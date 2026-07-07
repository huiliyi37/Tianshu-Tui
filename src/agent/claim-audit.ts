/**
 * 宣称-证据对账（主会话侧，2026-07-07）——复现即证明的交付级审计。
 *
 * worker 侧靠 transcript 取证（worker-evidence.ts）；主会话没有 transcript，
 * 但有 TaskLedger。deliver_task 的交付文本（commit message / checklist）里出现
 * "全绿 / N/N 通过 / 已修复 / typecheck 干净"类宣称时，对账 ledger 里的真实
 * 验证记录：
 *
 * - 硬拦一档：宣称测试绿 + 零条新鲜验证记录 → RED（改完代码没重跑测试的
 *   "全绿"是旧绿，宣称不是证据）。
 * - 软警一档：宣称的通过数 N 与 ledger 最新验证记录对不上 → 警告行不阻断。
 *
 * 新鲜度定义：验证事件时间戳 ≥ 最后一次**代码文件** file_write 时间戳。
 * 只有源码/测试文件的写入会作废旧验证——README/locale/docs 类写入不影响
 * 测试结论，计入会把真验证误判成旧绿（审查 2026-07-07 #2 误杀）。
 * 纯函数，无 I/O。逃生阀：RIVET_CLAIM_AUDIT=0。
 */

import type { TaskLedgerEvent } from './task-ledger.js'
import { isSourceFilePath, isTestFilePath } from './test-presence.js'

/** 测试绿宣称（触发硬拦档）：声称测试/检查已通过。 */
const GREEN_CLAIM_RE = /全绿|所有测试通过|(?:typecheck|类型检查)\s*(?:干净|clean|passed|通过)|\btests?\s+(?:pass(?:ed|ing)?|green)\b|\d+\s*\/\s*\d+\s*(?:通过|passed|pass)/i

/** 宣称里的 "N/N 通过" 数字形状，用于计数对账。 */
const COUNT_CLAIM_RE = /(\d+)\s*\/\s*(\d+)\s*(?:通过|passed|pass|全绿)/i

export interface ClaimAuditInput {
  /** 交付宣称文本（commit message + checklist 条目拼接）。 */
  claimText: string
  /** TaskLedger 全量事件（含 file_write 与 verification）。 */
  events: readonly TaskLedgerEvent[]
}

export interface ClaimAuditResult {
  /** ok = 无宣称或宣称有据；warn = 计数对不上；block = 宣称绿但零新鲜验证。 */
  status: 'ok' | 'warn' | 'block'
  lines: string[]
}

export function claimAuditEnabled(): boolean {
  return process.env.RIVET_CLAIM_AUDIT !== '0'
}

/**
 * 代码变更判定：源码或测试文件的写入。测试文件也算——测完再改测试，旧绿
 * 同样失效。docs/locale/config 写入不作废验证（它们改不了测试结果）。
 * 无 path 的 file_write（不应出现）保守计入，宁可要求重跑。
 */
function isCodeWrite(e: TaskLedgerEvent): boolean {
  if (e.type !== 'file_write') return false
  if (typeof e.path !== 'string' || e.path.length === 0) return true
  return isSourceFilePath(e.path) || isTestFilePath(e.path)
}

/** 新鲜验证记录：状态 passed 且时间戳不早于最后一次代码文件变更。 */
export function countFreshVerifications(events: readonly TaskLedgerEvent[]): number {
  let lastWriteAt = 0
  for (const e of events) {
    if (isCodeWrite(e) && e.timestamp > lastWriteAt) lastWriteAt = e.timestamp
  }
  return events.filter(e =>
    e.type === 'verification' && e.status === 'passed' && e.timestamp >= lastWriteAt,
  ).length
}

export function auditDeliveryClaims(input: ClaimAuditInput): ClaimAuditResult {
  if (!GREEN_CLAIM_RE.test(input.claimText)) {
    return { status: 'ok', lines: [] }
  }

  const hasWrites = input.events.some(isCodeWrite)
  const fresh = countFreshVerifications(input.events)

  // 硬拦：改了代码、宣称测试绿、但改动之后没有任何 passed 验证记录。
  // 没改代码的交付（纯报告 / 纯文档）不拦——改动影响不到测试结果，无"旧绿"可言。
  if (hasWrites && fresh === 0) {
    return {
      status: 'block',
      lines: [
        '❌ 宣称对账失败：交付文本宣称测试/检查已通过，但最后一次文件变更之后没有任何 passed 验证记录。',
        '   改完代码没重跑的"全绿"是旧绿。先 run_tests（或验证形状的 bash）复现结论，再交付。',
      ],
    }
  }

  // 软警：宣称 "N/N 通过" 的 N 与 ledger 最新验证记录的 passed 数对不上。
  const countMatch = COUNT_CLAIM_RE.exec(input.claimText)
  if (countMatch) {
    const claimedPassed = Number(countMatch[1])
    const latestWithTotals = [...input.events].reverse().find(e =>
      e.type === 'verification' && typeof e.meta?.passed === 'number',
    )
    const actualPassed = latestWithTotals?.meta?.passed as number | undefined
    if (actualPassed !== undefined && actualPassed !== claimedPassed) {
      return {
        status: 'warn',
        lines: [
          `⚠️ 宣称计数对不上：交付文本写 ${claimedPassed} 通过，ledger 最新验证记录是 ${actualPassed} 通过。`,
          '   报告里的每个数字要能指到一条真实验证记录——请核对后修正宣称。',
        ],
      }
    }
  }

  return { status: 'ok', lines: [] }
}
