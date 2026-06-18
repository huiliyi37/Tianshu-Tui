import type { CouncilPlan, CouncilDecision } from './council-plan.js'

/** 转义 markdown 表格元字符：管道符和换行。 */
function esc(cell: string): string {
  return cell.replace(/\|/g, '\\|').replace(/\n/g, ' ')
}

function renderDecisionRows(decisions: CouncilDecision[], verdict: CouncilDecision['verdict']): string {
  const rows = decisions.filter(d => d.verdict === verdict)
  if (rows.length === 0) return '_（无）_'
  return rows.map(d => `- **${d.source}** · ${d.title} — ${d.rationale}${d.conflictWith ? ` _(冲突: ${d.conflictWith})_` : ''}`).join('\n')
}

/** 把议事会裁决渲染为可审计的实施计划 markdown（含议事记录段）。纯函数。 */
export function renderCouncilPlan(plan: CouncilPlan): string {
  const { objective, contributions, aggregate } = plan
  const lines: string[] = []

  lines.push(`# 议事会计划 — ${objective}`, '')
  lines.push(`> 席位: ${plan.seats.join(' · ')} · 单轮会诊 · convenedAt=${plan.meta.convenedAt}`, '')

  lines.push('## 席位贡献', '')
  for (const c of contributions) {
    lines.push(`### ${c.authority}`, c.summary || '_（无摘要）_', '')
  }

  lines.push('## 裁决记录', '')
  lines.push('### 接受', renderDecisionRows(aggregate.decisions, 'accepted'), '')
  lines.push('### 拒绝', renderDecisionRows(aggregate.decisions, 'rejected'), '')
  lines.push('### 暂缓', renderDecisionRows(aggregate.decisions, 'deferred'), '')

  lines.push('## 冲突', '')
  if (aggregate.conflicts.length === 0) {
    lines.push('_（无席位间冲突）_', '')
  } else {
    lines.push('| 描述 | 一方 | 另一方 |', '|------|------|--------|')
    for (const cf of aggregate.conflicts) lines.push(`| ${esc(cf.description)} | ${esc(cf.left)} | ${esc(cf.right)} |`)
    lines.push('')
  }

  lines.push('## 最终任务表', '')
  if (aggregate.mergedItems.length === 0) {
    lines.push('_（无任务）_', '')
  } else {
    lines.push('| id | 标题 | 说明 |', '|----|------|------|')
    for (const it of aggregate.mergedItems) lines.push(`| ${esc(it.id)} | ${esc(it.title)} | ${esc(it.detail)} |`)
    lines.push('')
  }

  return lines.join('\n')
}
