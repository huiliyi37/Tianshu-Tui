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
  lines.push(`> 席位: ${plan.seats.join(' · ')} · ${plan.meta.round} 轮会诊 · convenedAt=${plan.meta.convenedAt}`, '')

  lines.push('## 席位贡献', '')
  // 仅渲染首轮全稿；第二轮席位只表态反驳，单列于「第二轮反驳」段，不在此重复出现。
  for (const c of contributions.filter(c => (c.round ?? 1) === 1)) {
    const modelSuffix = c.modelUsed ? ` _(模型: ${c.modelUsed})_` : ''
    lines.push(`### ${c.authority}${modelSuffix}`, c.summary || '_（无摘要）_', '')
  }

  // 第二轮反驳过程 —— 展示各席对首轮冲突的让步/坚持/折中立场，落地「辩论」灵魂。
  const rebuttalContribs = contributions.filter(c => c.round === 2 && (c.rebuttals?.length ?? 0) > 0)
  if (rebuttalContribs.length > 0) {
    const keyToDesc = new Map(aggregate.conflicts.map(cf => [cf.key, cf.description]))
    lines.push('## 第二轮反驳', '')
    for (const c of rebuttalContribs) {
      for (const r of c.rebuttals ?? []) {
        const stanceZh = r.stance === 'concede' ? '让步' : r.stance === 'hold' ? '坚持' : '折中'
        const desc = keyToDesc.get(r.conflictKey) ?? r.conflictKey
        lines.push(`- **${esc(c.authority)}** 对「${esc(desc)}」: ${stanceZh} — ${esc(r.argument)}`)
      }
    }
    lines.push('')
  }

  lines.push('## 裁决记录', '')
  lines.push('### 接受', renderDecisionRows(aggregate.decisions, 'accepted'), '')
  lines.push('### 拒绝', renderDecisionRows(aggregate.decisions, 'rejected'), '')
  lines.push('### 暂缓', renderDecisionRows(aggregate.decisions, 'deferred'), '')

  lines.push('## 冲突', '')
  if (aggregate.conflicts.length === 0) {
    lines.push('_（无席位间冲突）_', '')
  } else {
    lines.push('| 描述 | 一方 | 另一方 | 状态 | 化解 |', '|------|------|--------|------|------|')
    for (const cf of aggregate.conflicts) {
      const statusZh = cf.status === 'resolved' ? '已化解' : cf.status === 'persisted' ? '仍分歧' : '待议'
      lines.push(`| ${esc(cf.description)} | ${esc(cf.left)} | ${esc(cf.right)} | ${statusZh} | ${esc(cf.resolution ?? '')} |`)
    }
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

/**
 * 紧凑议事摘要 —— 给 TUI 工具卡 uiContent 用（卡片默认仅展示前 4 行，全文
 * markdown 仍走 content 供 model 原样 echo）。纯函数、确定性。
 */
export function summarizeCouncilPlan(plan: CouncilPlan): string {
  const d = plan.aggregate.decisions
  const accepted = d.filter(x => x.verdict === 'accepted').length
  const rejected = d.filter(x => x.verdict === 'rejected').length
  const deferred = d.filter(x => x.verdict === 'deferred').length
  return [
    `议事会 · ${plan.seats.length} 席 ${plan.meta.round} 轮 · ${plan.objective}`,
    `裁决: 接受 ${accepted} · 拒绝 ${rejected} · 暂缓 ${deferred} · 冲突 ${plan.aggregate.conflicts.length}`,
    `最终任务 ${plan.aggregate.mergedItems.length} 项`,
  ].join('\n')
}
