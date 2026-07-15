/**
 * Gate Ledger — essence-gate 裁决账本（闭环 1，知识管线反馈）。
 *
 * 每次 essence-gate 运行后落一行到 `~/.rivet/memory/<hash>/gate-ledger.jsonl`
 * （机器本地诊断数据，不入项目共享库）。与 recall-efficacy 联动做：
 *
 * - **admit 零召回率**：admitted ids 从未出现在后续会话召回记录中的比例
 *   （> 阈值 ⇒ 闸门偏宽信号——准入的条目没人用）
 * - **reject 复现**：同一 textHash 在 ≥2 次 gate 运行中被 reject
 *   （⇒ 闸门偏严信号——素材反复出现说明有真实需求）
 *
 * `analyzeGateFeedback()` 是纯 join 分析函数，不写存储；由诊断 CLI 或
 * KnowledgeIndex 重建时按需调用，结果可注入 recall 工具的返回（"闸门健康度"提示行）。
 */

import { existsSync, readFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { memoryDir } from '../config/paths.js'
import { writeFileAtomicSync } from '../fs-atomic.js'
import { readEfficacyLedger } from './recall-efficacy.js'

// ── Types ──────────────────────────────────────────────────────────────────

export interface GateLedgerRow {
  sessionId: string
  ts: number
  admitted: Array<{ id: string; textHash: string }>
  rejected: Array<{ textHash: string; snippet: string }>
  superseded: Array<{ oldId: string; newId: string }>
  failedClosed: boolean
}

export interface GateFeedbackSummary {
  /** 最近 N 次 gate 运行中被 admit 的条目数。 */
  totalAdmitted: number
  /** admitted 条目中从未出现在后续会话召回 record 中的数量。 */
  neverRecalled: number
  /** admit 零召回率（0-1）。> 0.5 意味着闸门偏宽。 */
  admitZeroRecallRate: number
  /** ≥2 次被 reject 的 textHash 数量（同一素材反复出现 → 闸门偏严）。 */
  recurringRejectCount: number
  /** 最近 N 次中 failedClosed 次数。 */
  failedClosedCount: number
  /** 分析窗口的行数。 */
  windowSize: number
}

const MAX_LEDGER_ROWS = 50

// ── Path ───────────────────────────────────────────────────────────────────

function ledgerPath(cwd: string): string {
  const hash = createHash('sha256').update(cwd).digest('hex').slice(0, 12)
  return join(memoryDir(hash), 'gate-ledger.jsonl')
}

// ── Write ───────────────────────────────────────────────────────────────────

/** 每次 gate 运行落一行。FIFO cap = MAX_LEDGER_ROWS。
 *  读-改-写用原子替换（temp+rename）——并发会话 postSession 同时落账时
 *  最坏丢一行诊断数据，但绝不产生半截/交错的账本文件。 */
export function writeGateLedgerRow(cwd: string, row: GateLedgerRow): void {
  try {
    const path = ledgerPath(cwd)
    mkdirSync(join(path, '..'), { recursive: true })
    const lines: string[] = []
    if (existsSync(path)) {
      try {
        lines.push(...readFileSync(path, 'utf-8').split('\n').filter(Boolean))
      } catch { /* treat as empty */ }
    }
    lines.push(JSON.stringify(row))
    if (lines.length > MAX_LEDGER_ROWS) {
      lines.splice(0, lines.length - MAX_LEDGER_ROWS)
    }
    writeFileAtomicSync(path, lines.join('\n') + '\n')
  } catch { /* ledger write is best-effort */ }
}

// ── Read ───────────────────────────────────────────────────────────────────

export function readGateLedger(cwd: string, lastN = 20): GateLedgerRow[] {
  const path = ledgerPath(cwd)
  if (!existsSync(path)) return []
  try {
    return readFileSync(path, 'utf-8')
      .split('\n')
      .filter(Boolean)
      .slice(-lastN)
      .map(line => JSON.parse(line) as GateLedgerRow)
  } catch {
    return []
  }
}

// ── Analyze ────────────────────────────────────────────────────────────────

const ZERO_RECALL_WARN_THRESHOLD = 0.5
const RECURRING_REJECT_WARN = 2

/**
 * Join gate-ledger 与 recall-efficacy，产出闸门反馈摘要。
 *
 * - admitZeroRecallRate：admitted ids 中从未被任何后续会话召回的占比
 * - recurringRejectCount：≥2 次被不同 gate 运行 reject 的素材数
 *
 * 只做度量，不做自动阈值调节（积累数据一迭代再决定）。
 */
export function analyzeGateFeedback(cwd: string, lastN = 20): GateFeedbackSummary {
  const gateRows = readGateLedger(cwd, lastN)
  const efficacyRows = readEfficacyLedger(cwd, lastN * 10) // 时间窗口覆盖更大

  // 收集所有 efficacy 行中被召回的条目 id 集合
  const recalledIds = new Set<string>()
  for (const row of efficacyRows) {
    if (row.recalledEntryIds) {
      for (const id of row.recalledEntryIds) {
        recalledIds.add(id)
      }
    }
  }

  // admit 零召回率
  const allAdmittedIds: string[] = []
  for (const row of gateRows) {
    for (const a of row.admitted) {
      allAdmittedIds.push(a.id)
    }
  }
  const uniqueAdmitted = new Set(allAdmittedIds)
  let neverRecalled = 0
  for (const id of uniqueAdmitted) {
    if (!recalledIds.has(id)) neverRecalled++
  }
  const totalAdmitted = uniqueAdmitted.size
  const admitZeroRecallRate = totalAdmitted > 0 ? neverRecalled / totalAdmitted : 0

  // reject 复现检测：同一 textHash 在不同 gate 行中出现 ≥ RECURRING_REJECT_WARN 次
  const rejectCounts = new Map<string, number>()
  for (const row of gateRows) {
    // 每行内同 hash 只计一次（同次 gate 内 dedup 已在 runEssenceGate 完成）
    const seenInRow = new Set<string>()
    for (const r of row.rejected) {
      if (!seenInRow.has(r.textHash)) {
        seenInRow.add(r.textHash)
        rejectCounts.set(r.textHash, (rejectCounts.get(r.textHash) ?? 0) + 1)
      }
    }
  }
  let recurringRejectCount = 0
  for (const count of rejectCounts.values()) {
    if (count >= RECURRING_REJECT_WARN) recurringRejectCount++
  }

  const failedClosedCount = gateRows.filter(r => r.failedClosed).length

  return {
    totalAdmitted,
    neverRecalled,
    admitZeroRecallRate: Math.round(admitZeroRecallRate * 100) / 100,
    recurringRejectCount,
    failedClosedCount,
    windowSize: gateRows.length,
  }
}

/**
 * 渲染闸门反馈为 recall 工具返回的头部警告行。
 * 只在指标越过阈值时产出文本；正常时返回空串。
 */
export function renderGateFeedbackHint(cwd: string, lastN = 20): string {
  const fb = analyzeGateFeedback(cwd, lastN)
  if (fb.windowSize === 0) return ''
  const warnings: string[] = []
  if (fb.admitZeroRecallRate > ZERO_RECALL_WARN_THRESHOLD && fb.totalAdmitted > 3) {
    warnings.push(`🔶 Gate health: ${fb.neverRecalled}/${fb.totalAdmitted} admitted entries were never recalled (${(fb.admitZeroRecallRate * 100).toFixed(0)}% zero-recall rate). Gate may be too permissive.`)
  }
  if (fb.recurringRejectCount > 0) {
    warnings.push(`🔶 Gate health: ${fb.recurringRejectCount} recurring reject patterns — same material rejected ≥${RECURRING_REJECT_WARN} times. Gate may be too strict.`)
  }
  if (fb.failedClosedCount > 0) {
    warnings.push(`⚠ Gate health: ${fb.failedClosedCount}/${fb.windowSize} runs failed-closed (LLM unavailable). Check side-path LLM health.`)
  }
  return warnings.join('\n')
}
