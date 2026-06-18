// 议事会确定性内核 schema + 裁决纯函数。
// 铁律：零 I/O、零 Date、给定输入输出唯一（meta.convenedAt 由调用方注入）。

export type SeatVerdict = 'accepted' | 'rejected' | 'deferred'
export type RiskSeverity = 'low' | 'medium' | 'high'

/** 计划项 —— 议事会在草案条目层面运作，不耦合 team 的 TeamTask。 */
export interface PlanItem {
  id: string
  title: string
  detail: string
}

export interface CouncilDraft {
  objective: string
  items: PlanItem[]
}

export interface SeatRisk {
  claim: string
  severity: RiskSeverity
  mitigation: string
  /** 关联的草案/新增条目 id；缺省表示泛化风险（不得参与 id 相关性匹配）。 */
  itemId?: string
}

export interface SeatAlternative {
  proposal: string
  recommend: boolean
  rationale: string
  /** 该备选针对哪个条目 id；缺省表示泛化备选。 */
  targetItemId?: string
}

export interface SeatContribution {
  authority: string
  summary: string
  additions: PlanItem[]
  risks: SeatRisk[]
  challenges: string[]
  alternatives: SeatAlternative[]
  /** 实际生效模型（遥测/shadow 用，本轮可缺）。 */
  modelUsed?: string
}

export interface CouncilDecision {
  /** 稳定 id：`${source}:${kind}:${n}`，n 为该席该类内 0 基序号。 */
  id: string
  source: string
  kind: 'addition' | 'risk' | 'challenge' | 'alternative'
  title: string
  rationale: string
  verdict: SeatVerdict
  /** 与哪条 decision/草案条目冲突（席位间分歧时填）。 */
  conflictWith?: string
}

export interface CouncilConflict {
  description: string
  left: string
  right: string
}

export interface CouncilAggregate {
  decisions: CouncilDecision[]
  mergedItems: PlanItem[]
  conflicts: CouncilConflict[]
}

export interface CouncilPlan {
  objective: string
  seats: string[]
  contributions: SeatContribution[]
  aggregate: CouncilAggregate
  finalPlanMarkdown: string
  meta: { round: 1; convenedAt: number; objectiveHash: string }
}

/** 空白/缺字段 id —— 用它做包含匹配会退化为永真，必须显式拦截。 */
function isBlank(id: string | undefined): boolean {
  return !id || id.trim().length === 0
}

/** 无序集合相等：[a,b] 与 [b,a] 视为同一冲突，避免重复登记。 */
function sameConflict(a: CouncilConflict, b: CouncilConflict): boolean {
  return (a.left === b.left && a.right === b.right) ||
    (a.left === b.right && a.right === b.left)
}

/**
 * 确定性裁决：保留每条贡献的留痕（decisions），产出合并条目与席位间冲突。
 *
 * 不变量：
 *  - 每条 addition/risk/challenge/alternative 恰好产生 1 条 decision（无静默丢弃）。
 *  - 比较一律用精确相等，绝不用 includes（空 id 会让 includes 永真）。
 *  - conflicts 按无序对去重（(A,B) 与 (B,A) 只留一条）。
 *  - deferred ≠ 删除：deferred 条目仍在 decisions 留痕。
 */
export function aggregateCouncil(
  draft: CouncilDraft,
  contributions: SeatContribution[],
): CouncilAggregate {
  const decisions: CouncilDecision[] = []
  const conflicts: CouncilConflict[] = []
  const mergedItems: PlanItem[] = draft.items.map(i => ({ ...i }))

  const addConflict = (c: CouncilConflict): void => {
    if (!conflicts.some(ex => sameConflict(ex, c))) conflicts.push(c)
  }

  // 收集所有席位的备选，用于 risk×alternative 相关性检测（仅限具体 itemId）。
  const allAlternatives: Array<{ source: string; alt: SeatAlternative }> = []
  for (const c of contributions) {
    for (const alt of c.alternatives) allAlternatives.push({ source: c.authority, alt })
  }

  for (const c of contributions) {
    // ── additions ──
    c.additions.forEach((add, n) => {
      const id = `${c.authority}:addition:${n}`
      if (isBlank(add.id)) {
        decisions.push({ id, source: c.authority, kind: 'addition', title: add.title || '(untitled)', rationale: 'empty item id — rejected (blank id would match-all downstream)', verdict: 'rejected' })
        return
      }
      const existing = mergedItems.find(i => i.id === add.id)
      if (existing) {
        if (existing.detail === add.detail) {
          decisions.push({ id, source: c.authority, kind: 'addition', title: add.title, rationale: `duplicate of existing item ${add.id}`, verdict: 'deferred', conflictWith: add.id })
        } else {
          decisions.push({ id, source: c.authority, kind: 'addition', title: add.title, rationale: `id ${add.id} collides with differing detail`, verdict: 'deferred', conflictWith: add.id })
          addConflict({ description: `Addition conflict on ${add.id}`, left: existing.detail, right: add.detail })
        }
        return
      }
      mergedItems.push({ ...add })
      decisions.push({ id, source: c.authority, kind: 'addition', title: add.title, rationale: add.detail, verdict: 'accepted' })
    })

    // ── risks ── 始终 accepted（已记录），但与具体 itemId 的 accept 备选冲突时标注。
    c.risks.forEach((risk, n) => {
      const id = `${c.authority}:risk:${n}`
      let conflictWith: string | undefined
      if (!isBlank(risk.itemId) && risk.severity === 'high') {
        const rival = allAlternatives.find(x => x.alt.recommend && !isBlank(x.alt.targetItemId) && x.alt.targetItemId === risk.itemId)
        if (rival) {
          conflictWith = `${rival.source}:alt:${risk.itemId}`
          addConflict({ description: `Risk vs alternative on ${risk.itemId}`, left: risk.claim, right: rival.alt.proposal })
        }
      }
      decisions.push({ id, source: c.authority, kind: 'risk', title: `Risk: ${risk.claim.slice(0, 80)}`, rationale: risk.mitigation, verdict: 'accepted', ...(conflictWith ? { conflictWith } : {}) })
    })

    // ── challenges ── 主控待裁的开放问题。
    c.challenges.forEach((ch, n) => {
      decisions.push({ id: `${c.authority}:challenge:${n}`, source: c.authority, kind: 'challenge', title: `Challenge: ${ch.slice(0, 80)}`, rationale: ch, verdict: 'deferred' })
    })

    // ── alternatives ── recommend → accepted，否则 rejected（必须带理由）。
    c.alternatives.forEach((alt, n) => {
      decisions.push({ id: `${c.authority}:alternative:${n}`, source: c.authority, kind: 'alternative', title: alt.proposal.slice(0, 80), rationale: alt.rationale, verdict: alt.recommend ? 'accepted' : 'rejected' })
    })
  }

  return { decisions, mergedItems, conflicts }
}
