/**
 * 重构行为等价契约 — 回归清单核验（事故链缺口 3）。
 *
 * 重构前锚定「改动后必须仍存在」的功能锚点（路由、导航项、导出符号、命令入口
 * 等 grep 可验证的文本断言），交付前逐项核验。用文本锚点而非 E2E 快照：零基础
 * 设施依赖，对任意用户项目通用（天枢已打包分发，不能假设用户有测试体系）。
 *
 * 三个入口：
 * - extractRegressionInventory(markdown)：从计划的「回归清单」章节解析条目
 * - findApprovedPlanInventory(cwd)：从最近 APPROVED 计划提取清单（零接线回退）
 * - verifyRegressionInventory(cwd, items)：逐项 git grep 核验存在性
 */

import { spawnSync } from 'node:child_process'
import { listPlansSync } from '../plan/plan-store.js'

export type InventoryItemStatus = 'present' | 'missing' | 'unknown'

export interface InventoryCheckResult {
  item: string
  /** 实际用于 grep 的锚点（条目里第一个反引号片段，无则整条文本）。 */
  needle: string
  status: InventoryItemStatus
}

/** 「回归清单」章节头（中英双语，2-6 级标题均可）。
 *  注意：\b 只能跟在英文变体后——CJK 字符非 \w，`清单\b` 在行尾永远不匹配。 */
const INVENTORY_HEADING_RE = /^#{2,6}\s*(?:回归清单|回归契约|regression\s+inventory\b).*$/im

/**
 * 从计划 markdown 提取「回归清单」章节的列表条目。
 * 支持 `- item` / `* item` / `- [ ] item` / `1. item` 形态；
 * 章节以下一个同级或更高级标题结束。无章节返回空数组。
 */
export function extractRegressionInventory(markdown: string): string[] {
  const headingMatch = markdown.match(INVENTORY_HEADING_RE)
  if (!headingMatch || headingMatch.index === undefined) return []
  const headingLevel = (headingMatch[0].match(/^#+/) ?? ['##'])[0].length
  const rest = markdown.slice(headingMatch.index + headingMatch[0].length)

  const items: string[] = []
  for (const line of rest.split(/\r?\n/)) {
    const nextHeading = line.match(/^(#{1,6})\s/)
    if (nextHeading && nextHeading[1]!.length <= headingLevel) break
    const m = line.match(/^\s*(?:[-*]\s*(?:\[[ xX]\]\s*)?|\d+\.\s+)(.+)$/)
    if (m && m[1]!.trim()) items.push(m[1]!.trim())
  }
  return items
}

/**
 * 从最近的 APPROVED 计划提取回归清单（executed/rejected 不算——已交付或已弃）。
 * deliver_task 的零接线回退路径：task contract 未带 regressionInventory 时用它。
 * 任何异常返回 undefined（advisory，绝不阻断交付）。
 */
export function findApprovedPlanInventory(cwd: string): string[] | undefined {
  try {
    const approved = listPlansSync(cwd).filter(p => p.status === 'approved')
    if (approved.length === 0) return undefined
    // listPlansSync 已按 createdAt 降序 — 取最新的 approved。
    const inventory = extractRegressionInventory(approved[0]!.content)
    return inventory.length > 0 ? inventory : undefined
  } catch {
    return undefined
  }
}

/** 条目 → grep 锚点：优先第一个反引号片段（`src/x.ts` / `exportName`），无则整条。 */
export function needleForItem(item: string): string {
  const backtick = item.match(/`([^`]+)`/)
  return (backtick?.[1] ?? item).trim()
}

export type InventorySearcher = (cwd: string, needle: string) => InventoryItemStatus

/** 默认搜索器：git grep -F（追踪文件全文搜索）。0=命中 1=未命中 其他=unknown。 */
function gitGrepSearcher(cwd: string, needle: string): InventoryItemStatus {
  try {
    const res = spawnSync('git', ['grep', '-l', '-F', '--', needle], { cwd, encoding: 'utf-8', timeout: 10_000 })
    if (res.status === 0) return 'present'
    if (res.status === 1) return 'missing'
    return 'unknown'
  } catch {
    return 'unknown'
  }
}

/** 逐项核验清单条目在当前工作区仍然存在。searcher 可注入（测试）。 */
export function verifyRegressionInventory(
  cwd: string,
  items: readonly string[],
  searcher: InventorySearcher = gitGrepSearcher,
): InventoryCheckResult[] {
  return items.map(item => {
    const needle = needleForItem(item)
    return { item, needle, status: needle ? searcher(cwd, needle) : 'unknown' }
  })
}

/** 渲染核验报告行（deliver_task 交付报告用）。 */
export function formatInventoryReport(results: readonly InventoryCheckResult[]): string[] {
  if (results.length === 0) return []
  const missing = results.filter(r => r.status === 'missing')
  const unknown = results.filter(r => r.status === 'unknown')
  const lines: string[] = ['', `--- 回归清单核验 (${results.length - missing.length - unknown.length}/${results.length} 仍存在) ---`]
  for (const r of results) {
    const icon = r.status === 'present' ? '✅' : r.status === 'missing' ? '❌' : '❓'
    lines.push(`  ${icon} ${r.item}${r.status === 'missing' ? `（锚点 \`${r.needle}\` 已消失）` : ''}`)
  }
  if (missing.length > 0) {
    lines.push('', `  ⚠️ ${missing.length} 个功能锚点在改动后消失——这正是重构丢功能的形态。逐项确认是有意移除还是回归，回归的必须修复后再交付。`)
  }
  if (unknown.length > 0) {
    lines.push(`  ❓ ${unknown.length} 项无法自动核验（非 git 仓库或 grep 失败）——请人工确认。`)
  }
  return lines
}
