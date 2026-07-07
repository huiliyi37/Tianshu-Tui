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
 * 新鲜度定义：验证事件时间戳 ≥ 最后一次**代码变异**时间戳。代码变异 =
 * 源码/测试文件的 file_write，或改动工作树的 git 操作（checkout/restore/
 * stash/reset --hard/merge…）。README/locale/docs 类写入不影响测试结论，
 * 计入会把真验证误判成旧绿（审查 2026-07-07 #2 误杀）。
 *
 * 宣称分型（审查 2026-07-07 #6）：测试宣称需要测试形状的验证背书，
 * typecheck 宣称需要 typecheck 形状的——typecheck 干净证明不了测试通过。
 * 无法分类的验证命令（make check 等）两边都认，宁可放过不误拦。
 *
 * 纯函数，无 I/O。逃生阀：RIVET_CLAIM_AUDIT=0。
 */

import type { TaskLedgerEvent } from './task-ledger.js'
import { isSourceFilePath, isTestFilePath } from './test-presence.js'

/** 测试绿宣称：声称测试套件已通过。 */
const TEST_CLAIM_RE = /全绿|所有测试通过|\btests?\s+(?:pass(?:ed|ing)?|green)\b|\d+\s*\/\s*\d+\s*(?:通过|passed|pass)/i

/** typecheck 干净宣称：只声称类型检查通过（可与测试宣称并存）。 */
const TYPECHECK_CLAIM_RE = /(?:typecheck|类型检查)\s*(?:干净|clean|passed|通过)/i

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

/** 改动工作树内容的 git 命令形状：checkout（切分支/还原文件，排除 -b 开新分支）、
 *  switch（排除 -c）、restore、stash / stash pop / stash_pop（结构化工具动作名）、
 *  reset --hard、clean、merge、rebase、cherry-pick、revert、apply、pull。
 *  status/log/diff/add/commit/push 不改工作树，不作废旧绿。 */
const GIT_WORKTREE_MUTATION_RE = /\bgit\s+(?:stash(?:_pop)?(?!\s+(?:list|show))|reset\s+--hard|checkout(?!\s+-b\b)|switch(?!\s+-c\b)|restore|clean|merge|rebase|cherry-pick|revert|apply|pull)\b/i

/**
 * 代码变异判定：作废旧验证的事件。
 * - file_write：源码或测试文件（测完再改测试，旧绿同样失效）。docs/locale/
 *   config 写入不算——改不了测试结果。无 path 的异常事件保守计入。
 * - git_action：改动工作树的命令（审查 2026-07-07 #7——checkout/restore
 *   还原代码后旧验证对应的代码已经不存在了）。
 */
function isCodeMutation(e: TaskLedgerEvent): boolean {
  if (e.type === 'file_write') {
    if (typeof e.path !== 'string' || e.path.length === 0) return true
    return isSourceFilePath(e.path) || isTestFilePath(e.path)
  }
  if (e.type === 'git_action') {
    const cmd = typeof e.meta?.command === 'string' ? e.meta.command : ''
    return GIT_WORKTREE_MUTATION_RE.test(cmd)
  }
  return false
}

/** 验证记录分型。优先信 declared kind（verify-config 分类）；命令形状兜底；
 *  无法分类（make check 等）为 unknown——两类宣称都认，宁可放过不误拦。
 *  lint/build 是已知的"既非测试也非类型检查"，谁的宣称都不背书。 */
const TEST_CMD_RE = /run_tests|\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test|node\s+--test|vitest|jest|mocha|pytest|cargo\s+test|go\s+test/i
const TYPECHECK_CMD_RE = /\btsc\b|typecheck/i
const LINT_BUILD_CMD_RE = /eslint|biome\s+(?:check|lint)|\blint\b|\bbuild\b/i

type VerificationClass = 'test' | 'typecheck' | 'lint-build' | 'unknown'

function verificationKind(e: TaskLedgerEvent): VerificationClass {
  const declared = e.meta?.kind
  if (declared === 'test' || declared === 'typecheck') return declared
  if (declared === 'lint' || declared === 'build') return 'lint-build'
  const cmd = e.command ?? ''
  if (TEST_CMD_RE.test(cmd)) return 'test'
  if (TYPECHECK_CMD_RE.test(cmd)) return 'typecheck'
  if (LINT_BUILD_CMD_RE.test(cmd)) return 'lint-build'
  return 'unknown'
}

function backsTestClaim(e: TaskLedgerEvent): boolean {
  const kind = verificationKind(e)
  return kind === 'test' || kind === 'unknown'
}

function backsTypecheckClaim(e: TaskLedgerEvent): boolean {
  const kind = verificationKind(e)
  return kind === 'typecheck' || kind === 'unknown'
}

/** 新鲜的 passed 验证记录：时间戳不早于最后一次代码变异。 */
function freshPassedVerifications(events: readonly TaskLedgerEvent[]): TaskLedgerEvent[] {
  let lastMutationAt = 0
  for (const e of events) {
    if (isCodeMutation(e) && e.timestamp > lastMutationAt) lastMutationAt = e.timestamp
  }
  return events.filter(e =>
    e.type === 'verification' && e.status === 'passed' && e.timestamp >= lastMutationAt,
  )
}

/** 新鲜验证记录数（不分型）。保留导出供外部消费。 */
export function countFreshVerifications(events: readonly TaskLedgerEvent[]): number {
  return freshPassedVerifications(events).length
}

export function auditDeliveryClaims(input: ClaimAuditInput): ClaimAuditResult {
  const claimsTests = TEST_CLAIM_RE.test(input.claimText)
  const claimsTypecheck = TYPECHECK_CLAIM_RE.test(input.claimText)
  if (!claimsTests && !claimsTypecheck) {
    return { status: 'ok', lines: [] }
  }

  const hasWrites = input.events.some(isCodeMutation)
  const fresh = freshPassedVerifications(input.events)

  // 硬拦：改了代码、宣称绿、但改动之后没有对应形状的 passed 验证记录。
  // 没改代码的交付（纯报告 / 纯文档）不拦——改动影响不到测试结果，无"旧绿"可言。
  // typecheck 形状的验证不背书测试宣称（反之亦然）；unknown 形状两边都认。
  if (hasWrites) {
    if (claimsTests && !fresh.some(backsTestClaim)) {
      return {
        status: 'block',
        lines: [
          '❌ 宣称对账失败：交付文本宣称测试已通过，但最后一次代码变更之后没有任何测试形状的 passed 验证记录。',
          fresh.length > 0
            ? '   现有新鲜记录只有 typecheck/lint 形状——typecheck 干净证明不了测试通过。先 run_tests（或测试形状的 bash）复现结论，再交付。'
            : '   改完代码没重跑的"全绿"是旧绿。先 run_tests（或验证形状的 bash）复现结论，再交付。',
        ],
      }
    }
    if (claimsTypecheck && !fresh.some(backsTypecheckClaim)) {
      return {
        status: 'block',
        lines: [
          '❌ 宣称对账失败：交付文本宣称 typecheck 干净，但最后一次代码变更之后没有任何 typecheck 形状的 passed 验证记录。',
          '   测试通过证明不了类型干净。先跑 tsc --noEmit（或声明的 typecheck 命令）复现结论，再交付。',
        ],
      }
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
