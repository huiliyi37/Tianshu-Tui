# 星图议事会·确定性内核 (W-C1~W-C3) 实现计划

> **面向 AI 代理：** 用 `executing-plans` 逐任务实现。步骤用 `- [ ]` 跟踪。
> **执行星域：DeepSeek V4 · 瑶光域。** 本计划是给 V4 在瑶光域跑的一轮长任务，专为「绿非证明、复现即证、缺陷归族」设计——每个纯函数任务都先写 RED（含畸形输入），跑到红，再实现到绿。听到自己说「已修/已验证」前，先确认能复现原缺陷。

**目标：** 新建一条独立于 team 执行编排的「议事会确定性内核」：把一份计划草案交给 N 个绑定星域的席位子代理，单轮各自产出结构化意见，主控用**纯函数确定性裁决**汇总成可审计的 `CouncilPlan`，再渲染成实施计划 markdown（议事记录入档）。本轮只做内核三层（schema+汇总、编排、渲染），**不做**多模型路由 / 工具注册 / 遥测。

**架构：** 议事会 = 规划期会诊（出计划）；team = 执行期波次编排（跑计划）。两者**互不调用**，计划文档是唯一接口。内核完全独立于 `team-orchestrator.ts` / `team-perspectives.ts`，放在新目录 `src/agent/council/`。裁决是确定性纯函数（零 I/O、零 `Date`），主控 LLM 只在编排层调度子代理、不改裁决事实。

**技术栈：** TypeScript strict · ESM（`.js` import 后缀）· `node:test` + `node:assert/strict` · 不可变 spread。

---

## 调研背书（本计划不删除/修改任何现有行为，全部新建）

- **`src/agent/council/` 不存在**：`glob src/agent/council/**` 与 `glob src/tools/council-convene*` 均 0 命中。只有设计文档 [`.rivet/plans/星图议事会-多星域单轮会诊出计划.md`](.rivet/plans/星图议事会-多星域单轮会诊出计划.md) 与 [`docs/superpowers/plans/2026-06-16-star-roster-council-i1.md`](docs/superpowers/plans/2026-06-16-star-roster-council-i1.md)。
- **复用锚点（只读，不改）**：
  - `delegateBatch(requests, 'all_required', signal): Promise<CoordinatorRun>`，`CoordinatorRun.results: WorkerResult[]`，`DelegationRequest{ parentTurnId, objective, kind, profile, scope, authority, onActivity }` — 见 [`src/agent/coordinator.ts:86-132`](src/agent/coordinator.ts) 与调用范式 [`src/agent/team-orchestrator.ts:386-399`](src/agent/team-orchestrator.ts)。
  - artifact-JSON 解析降级范式 `parsePerspectiveResult` / `extractJsonCandidates` — [`src/agent/team-perspectives.ts:320-340`](src/agent/team-perspectives.ts)。
  - `starDomainRegistry.get(id) / .has(id) / .list()` — [`src/agent/star-domain-registry.ts:85-106`](src/agent/star-domain-registry.ts)。
  - `mergeRoleFor(domainId): ExpertRole` — [`src/agent/expert-router.ts:46-48`](src/agent/expert-router.ts)。
  - 测试范式（`describe`/`it` + `makeTask` 工厂）— [`src/agent/__tests__/team-perspectives.test.ts:1-35`](src/agent/__tests__/team-perspectives.test.ts)。
- **不碰**：`team-orchestrator.ts` / `team-perspectives.ts` / `expert-router.ts`（解耦硬约束）。本计划新建文件，对它们零改动；每波须断言其测试零改动且全绿。

## 文件结构

| 文件 | 操作 | 职责 |
|------|------|------|
| `src/agent/council/council-plan.ts` | 创建 | schema + 纯函数 `aggregateCouncil`（确定性裁决，零 I/O） |
| `src/agent/council/__tests__/council-plan.test.ts` | 创建 | 反证测试表（含畸形输入 RED→GREEN） |
| `src/agent/council/council-render.ts` | 创建 | `renderCouncilPlan(CouncilPlan): string` 议事记录 markdown |
| `src/agent/council/__tests__/council-render.test.ts` | 创建 | 渲染含全席位+全裁决+冲突表+rejected 理由 |
| `src/agent/council/council-orchestrator.ts` | 创建 | `runCouncil` 单轮扇出 + `buildSeatObjective` + `parseSeatContribution` |
| `src/agent/council/__tests__/council-orchestrator.test.ts` | 创建 | 解耦 / 恰一轮 / 席位失败降级断言 |

---

## 任务

### 任务 1：议事会 schema + 确定性裁决纯函数（瑶光主场）

- [ ] 创建 `src/agent/council/__tests__/council-plan.test.ts`（先写 RED 反证套件）
- [ ] 运行确认全红
- [ ] 创建 `src/agent/council/council-plan.ts`（实现到绿）
- [ ] 运行确认全绿

**目标：** 定义议事会数据模型，并实现 `aggregateCouncil(draft, contributions)` —— 把各席贡献确定性地裁决为 `decisions`（全留痕）、`mergedItems`（草案 + 已接受新增）、`conflicts`（席位间分歧），**零 I/O、零 `Date`、给定输入输出唯一**。

**调研背书：** 纯新建，无调用者需迁移。裁决规则刻意复刻 `team-perspectives.ts` 已修过的两族缺陷防线（`''.includes` 永真、`join(',')` 集合误判），让 V4 必须主动复现这两族才能写对。

**实现（`council-plan.ts` 完整代码）：**

```typescript
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
```

**测试（`council-plan.test.ts` 反证套件，先写到红）：**

```typescript
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { aggregateCouncil } from '../council-plan.js'
import type { CouncilDraft, SeatContribution } from '../council-plan.js'

const draft: CouncilDraft = {
  objective: 'refactor the loop',
  items: [{ id: 'T1', title: 'Task 1', detail: 'do T1' }],
}
function seat(over: Partial<SeatContribution> & { authority: string }): SeatContribution {
  return { summary: '', additions: [], risks: [], challenges: [], alternatives: [], ...over }
}

describe('aggregateCouncil — 留痕不丢', () => {
  it('每条贡献恰好产生一条 decision', () => {
    const c = seat({ authority: 'tianquan',
      additions: [{ id: 'A1', title: 'a', detail: 'd' }],
      risks: [{ claim: 'r', severity: 'low', mitigation: 'm' }],
      challenges: ['why?'],
      alternatives: [{ proposal: 'alt', recommend: false, rationale: 'because' }] })
    const agg = aggregateCouncil(draft, [c])
    assert.equal(agg.decisions.length, 4)
  })
})

describe('aggregateCouncil — 空 id 不得 match-all（瑶光族①）', () => {
  it('空白 id 的 addition 被 rejected，不进 mergedItems', () => {
    const c = seat({ authority: 'tianfu', additions: [{ id: '   ', title: 'ghost', detail: 'x' }] })
    const agg = aggregateCouncil(draft, [c])
    const d = agg.decisions.find(x => x.kind === 'addition')!
    assert.equal(d.verdict, 'rejected')
    assert.equal(agg.mergedItems.length, 1) // 仅原 T1，幽灵未混入
  })
})

describe('aggregateCouncil — 去重 vs 冲突', () => {
  it('同 id 同 detail = duplicate(deferred)，不计冲突、不重复加入', () => {
    const c = seat({ authority: 'tianji', additions: [{ id: 'T1', title: 'dup', detail: 'do T1' }] })
    const agg = aggregateCouncil(draft, [c])
    assert.equal(agg.mergedItems.length, 1)
    assert.equal(agg.conflicts.length, 0)
    assert.equal(agg.decisions.find(d => d.kind === 'addition')!.verdict, 'deferred')
  })
  it('同 id 不同 detail = 冲突 + deferred', () => {
    const c = seat({ authority: 'tianji', additions: [{ id: 'T1', title: 'x', detail: 'DIFFERENT' }] })
    const agg = aggregateCouncil(draft, [c])
    assert.equal(agg.conflicts.length, 1)
    assert.equal(agg.decisions.find(d => d.kind === 'addition')!.conflictWith, 'T1')
  })
})

describe('aggregateCouncil — 冲突无序去重（瑶光族②）', () => {
  it('(A,B) 与 (B,A) 只登记一次', () => {
    // 两席对同一新 id 给出互不相同且彼此对称的 detail。
    const a = seat({ authority: 's1', additions: [{ id: 'NEW', title: 'a', detail: 'X' }] })
    const b = seat({ authority: 's2', additions: [{ id: 'NEW', title: 'b', detail: 'Y' }] })
    const c = seat({ authority: 's3', additions: [{ id: 'NEW', title: 'c', detail: 'X' }] })
    const agg = aggregateCouncil(draft, [a, b, c])
    // s2 与 s1 接受的 NEW(X) 冲突 (X,Y)；s3 与之 (X,X) 不冲突。只一条冲突。
    assert.equal(agg.conflicts.length, 1)
  })
})

describe('aggregateCouncil — risk×alternative 仅具体 itemId', () => {
  it('泛化风险(无 itemId)不与备选 match-all', () => {
    const a = seat({ authority: 'tianfu', risks: [{ claim: 'broad', severity: 'high', mitigation: 'm' }] })
    const b = seat({ authority: 'tianxuan', alternatives: [{ proposal: 'p', recommend: true, rationale: 'r', targetItemId: 'T1' }] })
    const agg = aggregateCouncil(draft, [a, b])
    assert.equal(agg.conflicts.length, 0)
  })
  it('具体 itemId 的 high risk 撞 accept 备选 → 冲突', () => {
    const a = seat({ authority: 'tianfu', risks: [{ claim: 'risky', severity: 'high', mitigation: 'm', itemId: 'T1' }] })
    const b = seat({ authority: 'tianxuan', alternatives: [{ proposal: 'p', recommend: true, rationale: 'r', targetItemId: 'T1' }] })
    const agg = aggregateCouncil(draft, [a, b])
    assert.equal(agg.conflicts.length, 1)
    assert.equal(agg.decisions.find(d => d.kind === 'risk')!.conflictWith, 'tianxuan:alt:T1')
  })
})

describe('aggregateCouncil — rejected 必带理由 / deferred≠删除', () => {
  it('rejected 备选保留非空 rationale', () => {
    const c = seat({ authority: 's', alternatives: [{ proposal: 'p', recommend: false, rationale: 'too costly' }] })
    const d = aggregateCouncil(draft, [c]).decisions.find(x => x.kind === 'alternative')!
    assert.equal(d.verdict, 'rejected')
    assert.ok(d.rationale.length > 0)
  })
  it('challenge 以 deferred 留在 ledger', () => {
    const c = seat({ authority: 's', challenges: ['edge case?'] })
    const d = aggregateCouncil(draft, [c]).decisions.find(x => x.kind === 'challenge')!
    assert.equal(d.verdict, 'deferred')
  })
})

describe('aggregateCouncil — 确定性', () => {
  it('同输入两次调用结果深相等（无 Date/随机）', () => {
    const c = seat({ authority: 's', additions: [{ id: 'A', title: 't', detail: 'd' }], risks: [{ claim: 'r', severity: 'low', mitigation: 'm' }] })
    assert.deepEqual(aggregateCouncil(draft, [c]), aggregateCouncil(draft, [c]))
  })
})
```

**验证：**
```bash
npx tsc --noEmit
npm exec -- tsx --test src/agent/council/__tests__/council-plan.test.ts   # 期望全部通过
```

**提交：**
```bash
git add src/agent/council/council-plan.ts src/agent/council/__tests__/council-plan.test.ts
git commit -m "feat(council): 议事会 schema + 确定性裁决纯函数 (任务 1/3)"
```

---

### 任务 2：议事记录渲染（确定性 markdown）

- [ ] 创建 `src/agent/council/__tests__/council-render.test.ts`（先写 RED）
- [ ] 运行确认全红
- [ ] 创建 `src/agent/council/council-render.ts`（实现到绿）
- [ ] 运行确认全绿

**目标：** `renderCouncilPlan(plan: CouncilPlan): string` 把裁决渲染为含「议事记录」的实施计划 markdown：目标、各席贡献摘要、裁决记录（accepted/rejected/deferred 分组、每条带理由）、冲突表、最终任务表（mergedItems）。纯函数，给定输入输出唯一。

**调研背书：** 纯新建。渲染只读 `CouncilPlan`，不回改裁决事实（守「主控汇总不改裁决」缰绳）。

**实现（`council-render.ts` 完整代码）：**

```typescript
import type { CouncilPlan, CouncilDecision } from './council-plan.js'

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
    for (const cf of aggregate.conflicts) lines.push(`| ${cf.description} | ${cf.left} | ${cf.right} |`)
    lines.push('')
  }

  lines.push('## 最终任务表', '')
  if (aggregate.mergedItems.length === 0) {
    lines.push('_（无任务）_', '')
  } else {
    lines.push('| id | 标题 | 说明 |', '|----|------|------|')
    for (const it of aggregate.mergedItems) lines.push(`| ${it.id} | ${it.title} | ${it.detail} |`)
    lines.push('')
  }

  return lines.join('\n')
}
```

**测试（`council-render.test.ts`，先写到红）：**

```typescript
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { renderCouncilPlan } from '../council-render.js'
import { aggregateCouncil } from '../council-plan.js'
import type { CouncilPlan, CouncilDraft, SeatContribution } from '../council-plan.js'

const draft: CouncilDraft = { objective: 'mission X', items: [{ id: 'T1', title: 'Task1', detail: 'd1' }] }
const contributions: SeatContribution[] = [
  { authority: 'tianquan', summary: '权衡完成', additions: [{ id: 'A1', title: 'addA', detail: 'detailA' }], risks: [], challenges: ['前提成立吗?'], alternatives: [{ proposal: '事件溯源', recommend: false, rationale: '成本过高' }] },
  { authority: 'tianfu', summary: '风险审完', additions: [], risks: [{ claim: '缺回滚', severity: 'high', mitigation: '加 rollback', itemId: 'T1' }], challenges: [], alternatives: [] },
]
function makePlan(): CouncilPlan {
  const aggregate = aggregateCouncil(draft, contributions)
  return { objective: draft.objective, seats: ['tianquan', 'tianfu'], contributions, aggregate, finalPlanMarkdown: '', meta: { round: 1, convenedAt: 1234, objectiveHash: 'h' } }
}

describe('renderCouncilPlan', () => {
  it('含全部席位', () => {
    const md = renderCouncilPlan(makePlan())
    assert.match(md, /### tianquan/)
    assert.match(md, /### tianfu/)
  })
  it('含三类裁决分组', () => {
    const md = renderCouncilPlan(makePlan())
    assert.match(md, /### 接受/); assert.match(md, /### 拒绝/); assert.match(md, /### 暂缓/)
  })
  it('rejected 项带理由', () => {
    const md = renderCouncilPlan(makePlan())
    assert.match(md, /成本过高/)
  })
  it('最终任务表含合并条目', () => {
    const md = renderCouncilPlan(makePlan())
    assert.match(md, /\| A1 \| addA \| detailA \|/)
    assert.match(md, /\| T1 \| Task1 \| d1 \|/)
  })
  it('确定性：两次渲染字节相等', () => {
    assert.equal(renderCouncilPlan(makePlan()), renderCouncilPlan(makePlan()))
  })
})
```

**验证：**
```bash
npx tsc --noEmit
npm exec -- tsx --test src/agent/council/__tests__/council-render.test.ts   # 期望全部通过
```

**提交：**
```bash
git add src/agent/council/council-render.ts src/agent/council/__tests__/council-render.test.ts
git commit -m "feat(council): 议事记录确定性 markdown 渲染 (任务 2/3)"
```

---

### 任务 3：单轮扇出编排器（解耦断言先行）

- [ ] 创建 `src/agent/council/__tests__/council-orchestrator.test.ts`（先写解耦/恰一轮/降级 RED）
- [ ] 运行确认全红
- [ ] 创建 `src/agent/council/council-orchestrator.ts`（实现到绿）
- [ ] 运行确认全绿

**目标：** `runCouncil(input, deps)` 用注入的 `delegateBatch` **恰一次**扇出 N 个席位子代理（`kind:'plan'`, `profile:'reviewer'`, `authority: seat`），收齐后 `parseSeatContribution` 解析为 `SeatContribution[]`（仿 `parsePerspectiveResult` 的 artifact-JSON + 降级兜底），调 `aggregateCouncil` + `renderCouncilPlan` 组装 `CouncilPlan`。**绝不**调用 team 执行函数。

**调研背书：**
- `delegateBatch` 签名与批量返回结构：`(requests, 'all_required', signal) => Promise<{ results: WorkerResult[] }>`，`results.find(r => r.workOrderId.includes(...))` —— [`team-orchestrator.ts:386-399`](src/agent/team-orchestrator.ts)。结构型注入，不直接耦合 coordinator 内部。
- 解析降级范式：artifact `find(a => a.title === 'seat-contribution')` → `extractJsonCandidates` 逐候选 `JSON.parse`，失败回退降级贡献 —— 复刻 [`team-perspectives.ts:320-340`](src/agent/team-perspectives.ts)。
- `profile:'reviewer'` 是本轮临时缝：W-C4（多模型路由，**本计划不做**）才会换成 `council_expert`（无 tierLock）。此处沿用 reviewer 仅为内核打通，不引入路由。

**实现（`council-orchestrator.ts` 关键结构 + 完整签名）：**

```typescript
import { extractJsonCandidates, type WorkerResult } from '../work-order.js'
import { aggregateCouncil, type CouncilDraft, type CouncilPlan, type SeatContribution } from './council-plan.js'
import { renderCouncilPlan } from './council-render.js'

/** 结构型扇出依赖 —— 仅声明 runCouncil 用到的批量委派能力，保持与 coordinator 解耦。 */
export interface CouncilFanoutRequest {
  parentTurnId: string
  objective: string
  kind: 'plan'
  profile: 'reviewer'
  scope: Record<string, never>
  authority: string
}
export interface CouncilDeps {
  delegateBatch: (
    requests: CouncilFanoutRequest[],
    policy: 'all_required',
    signal?: AbortSignal,
  ) => Promise<{ results: WorkerResult[] }>
  /** 注入时钟，保持 aggregate 纯净、编排可测。 */
  now: () => number
}

export interface CouncilInput {
  draft: CouncilDraft
  seats: string[]
  abortSignal?: AbortSignal
}

/** 席位 objective —— 领域职责简述 + schema 指令（仿 buildPlannerObjective）。 */
export function buildSeatObjective(seat: string, draft: CouncilDraft): string {
  return [
    `你是 ${seat} 席位专家。从你的领域视角单轮会诊以下计划草案，只出意见，不执行。`,
    '',
    `Objective: ${draft.objective}`,
    `Draft items: ${JSON.stringify(draft.items)}`,
    '',
    'Return a JSON WorkerResult whose `artifacts` contains ONE entry:',
    '{ "kind": "note", "title": "seat-contribution", "content": "<a JSON string of your SeatContribution>" }',
    'SeatContribution = { authority, summary, additions, risks, challenges, alternatives }.',
    `Set authority to "${seat}".`,
  ].join('\n')
}

/** 解析席位 WorkerResult → SeatContribution；artifact 缺失或畸形时降级为空贡献（不阻塞会诊）。 */
export function parseSeatContribution(seat: string, result: WorkerResult): SeatContribution {
  const empty: SeatContribution = { authority: seat, summary: result.summary ?? '', additions: [], risks: [], challenges: [], alternatives: [] }
  const artifact = result.artifacts.find(a => a.title === 'seat-contribution')
  if (!artifact) return empty
  // extractJsonCandidates 在无 JSON 时会 throw（不是返回 []），必须整段兜住。
  try {
    for (const candidate of extractJsonCandidates(artifact.content)) {
      try {
        const raw = JSON.parse(candidate) as Partial<SeatContribution>
        return {
          authority: seat,
          summary: raw.summary ?? empty.summary,
          additions: Array.isArray(raw.additions) ? raw.additions : [],
          risks: Array.isArray(raw.risks) ? raw.risks : [],
          challenges: Array.isArray(raw.challenges) ? raw.challenges : [],
          alternatives: Array.isArray(raw.alternatives) ? raw.alternatives : [],
          ...(raw.modelUsed ? { modelUsed: raw.modelUsed } : {}),
        }
      } catch {
        // 下一个候选 —— 模型输出可能夹杂散文/畸形示例
      }
    }
  } catch {
    // 无 JSON 候选 → 降级空贡献
  }
  return empty
}

function objectiveHash(s: string): string {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0
  return (h >>> 0).toString(16)
}

/** 单轮会诊：恰一次 delegateBatch 扇出席位 → 裁决 → 渲染。绝不派 worker 执行 / 分波。 */
export async function runCouncil(input: CouncilInput, deps: CouncilDeps): Promise<CouncilPlan> {
  const requests: CouncilFanoutRequest[] = input.seats.map(seat => ({
    parentTurnId: `council:seat-${seat}`,
    objective: buildSeatObjective(seat, input.draft),
    kind: 'plan',
    profile: 'reviewer',
    scope: {},
    authority: seat,
  }))
  const run = await deps.delegateBatch(requests, 'all_required', input.abortSignal)
  const contributions = input.seats.map(seat => {
    const result = run.results.find(r => r.workOrderId.includes(`seat-${seat}`))
    return result ? parseSeatContribution(seat, result) : { authority: seat, summary: '', additions: [], risks: [], challenges: [], alternatives: [] }
  })
  const aggregate = aggregateCouncil(input.draft, contributions)
  const finalPlanMarkdown = renderCouncilPlan({ objective: input.draft.objective, seats: input.seats, contributions, aggregate, finalPlanMarkdown: '', meta: { round: 1, convenedAt: deps.now(), objectiveHash: objectiveHash(input.draft.objective) } })
  return { objective: input.draft.objective, seats: input.seats, contributions, aggregate, finalPlanMarkdown, meta: { round: 1, convenedAt: deps.now(), objectiveHash: objectiveHash(input.draft.objective) } }
}
```

> 注意：`meta.convenedAt` 调了两次 `deps.now()`。**这是有意保留的实现细节**——测试须用单调/固定 `now` 验证；若 V4 用真实时钟会导致两次值不同、`finalPlanMarkdown` 里的 convenedAt 与返回 meta 不一致。任务 3 测试含一条断言钉死「md 内 convenedAt == meta.convenedAt」，逼出此坑并修为「先取一次 now 存局部变量」。

**测试（`council-orchestrator.test.ts`，先写到红）：**

```typescript
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { runCouncil, buildSeatObjective, parseSeatContribution } from '../council-orchestrator.js'
import type { CouncilDeps, CouncilInput } from '../council-orchestrator.js'
import type { WorkerResult } from '../../work-order.js'

function workerResult(seat: string, contribJson: string): WorkerResult {
  return {
    workOrderId: `council:seat-${seat}`,
    summary: `${seat} done`,
    artifacts: [{ kind: 'note', title: 'seat-contribution', content: contribJson }],
    risks: [],
  } as WorkerResult
}

const input: CouncilInput = {
  draft: { objective: 'split loop.ts', items: [{ id: 'T1', title: 't', detail: 'd' }] },
  seats: ['tianquan', 'tianfu'],
}

describe('runCouncil — 单轮 + 解耦', () => {
  it('delegateBatch 恰调用一次', async () => {
    let calls = 0
    const deps: CouncilDeps = {
      delegateBatch: async (reqs) => { calls++; return { results: reqs.map(r => workerResult(r.authority, JSON.stringify({ authority: r.authority, summary: 's', additions: [], risks: [], challenges: [], alternatives: [] }))) } },
      now: () => 1000,
    }
    await runCouncil(input, deps)
    assert.equal(calls, 1)
  })

  it('扇出请求均为 plan/reviewer/对应 authority（不携带执行语义）', async () => {
    const seen: string[] = []
    const deps: CouncilDeps = {
      delegateBatch: async (reqs) => { for (const r of reqs) { assert.equal(r.kind, 'plan'); assert.equal(r.profile, 'reviewer'); seen.push(r.authority) } ; return { results: reqs.map(r => workerResult(r.authority, '{}')) } },
      now: () => 1,
    }
    await runCouncil(input, deps)
    assert.deepEqual(seen, ['tianquan', 'tianfu'])
  })

  it('某席无结果 → 降级空贡献，不抛错', async () => {
    const deps: CouncilDeps = {
      delegateBatch: async () => ({ results: [workerResult('tianquan', JSON.stringify({ authority: 'tianquan', summary: 'ok', additions: [], risks: [], challenges: [], alternatives: [] }))] }), // 缺 tianfu
      now: () => 1,
    }
    const plan = await runCouncil(input, deps)
    assert.equal(plan.contributions.length, 2)
    assert.equal(plan.contributions[1]!.authority, 'tianfu')
  })

  it('md 内 convenedAt 与返回 meta.convenedAt 一致（钉死双取时钟坑）', async () => {
    let t = 100
    const deps: CouncilDeps = { delegateBatch: async (reqs) => ({ results: reqs.map(r => workerResult(r.authority, '{}')) }), now: () => t++ }
    const plan = await runCouncil(input, deps)
    assert.match(plan.finalPlanMarkdown, new RegExp(`convenedAt=${plan.meta.convenedAt}`))
  })
})

describe('parseSeatContribution — 降级兜底', () => {
  it('artifact 缺失 → 空贡献带 summary', () => {
    const c = parseSeatContribution('tianji', { workOrderId: 'x', summary: 'fallback', artifacts: [], risks: [] } as WorkerResult)
    assert.equal(c.summary, 'fallback')
    assert.deepEqual(c.additions, [])
  })
  it('artifact 畸形 JSON → 空贡献不抛', () => {
    const c = parseSeatContribution('tianji', workerResult('tianji', '{not json'))
    assert.equal(c.authority, 'tianji')
  })
})

describe('buildSeatObjective', () => {
  it('含席位名 + schema 指令 + objective', () => {
    const o = buildSeatObjective('tianquan', input.draft)
    assert.match(o, /tianquan/); assert.match(o, /seat-contribution/); assert.match(o, /split loop.ts/)
  })
})
```

> WorkerResult 字段以实际类型为准：实现任务前先 `read_file src/agent/work-order.ts` 确认 `WorkerResult` 的 `artifacts`/`summary`/`risks`/`workOrderId` 字段名与 artifact 的 `kind`/`title`/`content`，按真实签名调整测试构造（上面用 `as WorkerResult` 容错，但应改为精确构造）。

**验证：**
```bash
npx tsc --noEmit
npm exec -- tsx --test src/agent/council/__tests__/council-orchestrator.test.ts   # 期望全部通过
```

**提交：**
```bash
git add src/agent/council/council-orchestrator.ts src/agent/council/__tests__/council-orchestrator.test.ts
git commit -m "feat(council): 单轮扇出编排器 + 席位解析降级 (任务 3/3)"
```

---

## 收尾验证（每波统一过门）

```bash
npx tsc --noEmit
npm exec -- tsx --test src/agent/council/__tests__/*.test.ts                 # 全绿
npm exec -- tsx --test src/agent/__tests__/team-perspectives.test.ts        # 零改动且全绿（解耦证明）
```
- 确认 `team-orchestrator.ts` / `team-perspectives.ts` / `expert-router.ts` 的 `git diff` 为空。
- 对照 clean HEAD 预存失败集零新增（环境性预存失败不计入）。

## 反证测试表（哪些偷懒会红 —— 瑶光复现锚点）

| 偷懒实现 | 会红的测试 |
|----------|-----------|
| 用 `id.includes(add.id)` 判重 | 任务 1「空 id 不得 match-all」 |
| 同 id 同 detail 当冲突/重复加入 | 任务 1「duplicate(deferred) 不重复加入」 |
| `(A,B)`/`(B,A)` 冲突各记一条 | 任务 1「冲突无序去重」 |
| 泛化 risk(无 itemId) 与备选 match-all | 任务 1「risk×alternative 仅具体 itemId」 |
| 汇总丢弃某类贡献 / rejected 不记理由 | 任务 1「留痕不丢」「rejected 带理由」 |
| 编排顺手调 team 执行/分波 | 任务 3「扇出语义」+ 收尾 team 测试零改动 |
| 偷加多轮循环 | 任务 3「delegateBatch 恰一次」 |
| 用真实时钟双取导致 md/meta 不一致 | 任务 3「convenedAt 一致」 |

## 边界（本轮不做，留后续）

- **W-C4 多模型席位路由**（`council_expert` profile 无 tierLock、`authority→tier`、shadow）—— 碰 `model-tier-policy`/`ModelRoutingShadow`，独立成轮。本轮席位统一 `reviewer`。
- **W-C5 工具注册 + 遥测 + kill switch**（`council_convene` 工具、`council_session:` append-only 落 MeridianDb、`COUNCIL=0`）—— 碰工具注册与 DB，独立成轮。
- **桌面端议事会 UI**（CouncilSurface、`/stars` API）—— 见 i1 设计文档 Phase 1/3。
- 将星 ledger / `recall_general`、多轮 debate —— 明确不做。

## 自检结果

- **规格覆盖**：内核三层（schema+汇总 / 渲染 / 编排）→ 任务 1/2/3，一一对应；W-C4/W-C5/UI 显式列入边界。
- **占位符扫描**：无 TODO/TBD；纯函数给出完整代码；编排器给出完整签名+实现，仅 `WorkerResult` 精确字段要求实现前 read_file 核对（已标注）。
- **类型一致**：`PlanItem`/`SeatContribution`/`CouncilPlan`/`CouncilDeps` 在三任务间名称签名一致；`council-render` 与 `council-orchestrator` 均消费 `council-plan` 的导出类型。
- **调研背书**：本计划零删除/零修改现有行为，全部新建；复用锚点均标注文件:行。
