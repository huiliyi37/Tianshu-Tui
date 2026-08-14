// Norns 义务账 —— 织命议事会 Phase 3（命运三女神：量线者记下的未偿之份）。
//
// 机制：议事过程产生但未被契约立即消化的义务——暂缓裁决（deferred）、
// 高危风险的缓解承诺、advisory 质疑的验收 gate——作为结构化账本随契约
// （SealedUnifiedPlan JSON 透传）流到交付端；deliver_task 交付前逐项核验：
// 白名单 gate 命令真实执行，其余义务列账要求交付报告逐项披露。
//
// 铁律：账本是 advisory（列账+核验留痕，不硬拦交付）——与 regressionInventory
// 同款语义；纯函数 + 受注入执行器，可测。

import type { CouncilPlan } from './council-plan.js'
import type { UnifiedPlan } from '../unified-plan.js'
import { isRunnableVerifyCommand } from '../wave-gate.js'

export interface ObligationEntry {
  /** 稳定 id：`${kind}:${n}`。 */
  id: string
  kind: 'deferred_decision' | 'high_risk_mitigation' | 'advisory_gate'
  /** 义务内容（人读）。 */
  text: string
  /** 欠账席位 authority。 */
  source: string
  /** 可执行验收命令（仅 advisory_gate；白名单形状则交付时真实执行）。 */
  gate?: string
}

/** 携带义务账的契约——与 seal 同款：字段随 UnifiedPlan JSON 序列化透传。 */
export type PlanWithObligations = UnifiedPlan & { obligations?: ObligationEntry[] }

/**
 * 从议事裁决提取未偿义务：
 *  - deferred 裁决：暂缓 ≠ 消失——交付前必须有着落（采纳/明确放弃）。
 *  - high 级风险的缓解承诺：席位声明了 mitigation，交付时核验是否兑现。
 *  - advisory challenge 的 gate 命令：不拦编译（非 blocking），但交付前必须过。
 */
export function extractObligations(plan: CouncilPlan): ObligationEntry[] {
  const entries: ObligationEntry[] = []
  let n = 0

  for (const d of plan.aggregate.decisions) {
    if (d.verdict === 'deferred') {
      entries.push({
        id: `deferred_decision:${n++}`,
        kind: 'deferred_decision',
        text: `暂缓项「${d.title}」（${d.rationale}）——交付前需有着落：采纳或明确放弃`,
        source: d.source,
      })
    }
  }

  for (const c of plan.contributions.filter(c => (c.round ?? 1) === 1)) {
    for (const r of c.risks) {
      if (r.severity === 'high' && r.mitigation?.trim()) {
        entries.push({
          id: `high_risk_mitigation:${n++}`,
          kind: 'high_risk_mitigation',
          text: `高危风险「${r.claim}」的缓解承诺：${r.mitigation}`,
          source: c.authority,
        })
      }
    }
    for (const ch of c.challenges) {
      if ((ch.severity ?? 'advisory') === 'advisory' && ch.gate?.trim()) {
        entries.push({
          id: `advisory_gate:${n++}`,
          kind: 'advisory_gate',
          text: ch.text,
          source: c.authority,
          gate: ch.gate.trim(),
        })
      }
    }
  }

  return entries
}

/** 把义务账挂上契约（零义务时不挂字段，字节稳定）。 */
export function attachObligations(plan: UnifiedPlan, obligations: ObligationEntry[]): PlanWithObligations {
  return obligations.length > 0 ? { ...plan, obligations } : plan
}

export type ObligationStatus = 'settled' | 'unsettled' | 'manual'

export interface ObligationCheckResult {
  entry: ObligationEntry
  status: ObligationStatus
  detail?: string
}

// 允许 Promise：deliver 路径的默认 runner 是异步 spawn（spawnSync 曾最长阻塞
// 事件循环 60s——2026-08-09 桌面端「sidecar 无响应」横幅的楔子之一）。同步注入
// （测试桩）经 await 兼容。
export type GateRunner = (command: string) => { ok: boolean; detail?: string } | Promise<{ ok: boolean; detail?: string }>

/**
 * 交付前逐项核验：advisory_gate 且白名单形状 → 真实执行判 settled/unsettled；
 * 其余义务（暂缓项/缓解承诺/非白名单 gate）无法机器裁定 → manual，
 * 交付报告必须逐项披露着落。
 */
export async function verifyObligations(
  obligations: readonly ObligationEntry[],
  runGate: GateRunner,
): Promise<ObligationCheckResult[]> {
  const out: ObligationCheckResult[] = []
  for (const entry of obligations) {
    if (entry.kind === 'advisory_gate' && entry.gate && isRunnableVerifyCommand(entry.gate)) {
      const res = await runGate(entry.gate)
      out.push({ entry, status: res.ok ? 'settled' as const : 'unsettled' as const, detail: res.detail })
      continue
    }
    out.push({ entry, status: 'manual' as const })
  }
  return out
}

/** 渲染义务账核验报告（deliver_task 交付报告用；空账返回空数组）。 */
export function formatObligationReport(results: readonly ObligationCheckResult[]): string[] {
  if (results.length === 0) return []
  const unsettled = results.filter(r => r.status === 'unsettled')
  const manual = results.filter(r => r.status === 'manual')
  const lines: string[] = ['', `--- 议事会义务账核验 (${results.length - unsettled.length - manual.length}/${results.length} 已清偿) ---`]
  for (const r of results) {
    const icon = r.status === 'settled' ? '✅' : r.status === 'unsettled' ? '❌' : '📒'
    const gateSuffix = r.entry.gate ? ` [gate: ${r.entry.gate}]` : ''
    lines.push(`  ${icon} [${r.entry.source}] ${r.entry.text}${gateSuffix}${r.detail ? ` — ${r.detail}` : ''}`)
  }
  if (unsettled.length > 0) {
    lines.push('', `  ⚠️ ${unsettled.length} 项验收 gate 未通过——议事会立的验收界在交付时必须过，先修复再交付。`)
  }
  if (manual.length > 0) {
    lines.push(`  📒 ${manual.length} 项需人工裁定着落（暂缓项/缓解承诺）——交付报告必须逐项披露：已兑现 / 有意放弃（附理由）。`)
  }
  return lines
}
