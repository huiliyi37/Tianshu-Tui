# W-C6 议事会多轮辩论(round ≥ 2)实现计划

> 面向 AI 代理：使用 `executing-plans` 逐任务实现(计划阶段不派子代理)。
> 步骤用复选框(`- [ ]`)跟踪进度。

**目标：** 把当前"单轮扇出 + 确定性裁决"的议事会升级为"出稿 → 看彼此冲突 → 反驳/让步 → 收敛"的多轮辩论,给议事会装上区别于"并行多评审"的灵魂。

**架构：**
- **条件触发省成本**：第二轮仅在 round1 产生 `conflicts` 且 `maxRounds ≥ 2` 时扇出。无冲突=无需辩论=零额外 worker 成本(等于现状)。`maxRounds` 默认 2,显式 `1` 退化为纯单轮。这平衡"灵魂"与"worker 成本翻倍"。
- **确定性内核纯净**：`aggregateCouncil` 仍是纯函数;新增 `resolveConflictsWithRebuttals` 也是纯函数(零 I/O 零 Date)。多轮的非确定性(worker 调用)只存在于 `runCouncil` 编排层。
- **冲突稳定 key**：`CouncilConflict` 加确定性 `key`(无序对派生),round2 席位针对 key 表态,避免用数组下标的顺序脆性。
- **防虚假绿灯**(呼应本会话刚加的数据流防线)：round2 接线测试必须用真实 `buildSeatRebuttalObjective` + 真实 `resolveConflictsWithRebuttals`,断言"round1 的冲突 key/description 真的出现在 round2 的 objective 文本里"且"rebuttal 真的把 conflict.status 从 open 改成 resolved"——绝不在 fixture 里预塞 resolved 状态。

**技术栈：** TypeScript strict / node:test + node:assert/strict / ESM(`.js` 后缀 import)。

**收敛规则(确定性)：** 对每条 `open` 冲突,按席位顺序遍历 round2 所有 rebuttals,找第一条 `conflictKey === cf.key && stance ∈ {concede, revise}` 的表态。找到 → `status='resolved'`、`resolution=该 argument`;否则(全 hold / 无表态) → `status='persisted'`。

---

## 文件结构

| 文件 | 操作 | 职责 |
|------|------|------|
| `src/agent/council/council-plan.ts` | 修改 | round 放开、SeatRebuttal 类型、CouncilConflict.key/status、收敛纯函数 |
| `src/agent/council/__tests__/council-plan.test.ts` | 修改 | 收敛纯函数 + key 确定性测试 |
| `src/agent/council/council-orchestrator.ts` | 修改 | maxRounds、buildSeatRebuttalObjective、round2 条件扇出、rebuttals 解析 |
| `src/agent/council/__tests__/council-orchestrator.test.ts` | 修改 | 多轮编排 + 防虚假绿灯接线测试 |
| `src/agent/council/council-render.ts` | 修改 | 轮数动态、冲突 status 列、摘要轮数 |
| `src/agent/council/__tests__/council-render.test.ts` | 修改 | 多轮渲染断言 |
| `src/agent/council/council-telemetry.ts` | 修改 | CouncilSessionEvent 加 roundsRun |
| `src/agent/council/__tests__/council-gate-telemetry.test.ts` | 修改 | roundsRun 记录测试 |
| `src/tools/council-convene.ts` | 修改 | rounds 入参 + 透传 maxRounds |
| `src/tools/__tests__/council-convene.test.ts` | 修改 | rounds 透传测试 |
| `src/workflows/ecosystem-workflows.ts` | 修改 | --rounds 解析 + prompt 注入 + usage |
| `src/workflows/__tests__/ecosystem-workflows.test.ts` | 修改 | --rounds 解析/注入测试 |
| `src/tui/slash-commands.ts` | 修改 | /council help 加 --rounds |
| `src/tui/command-palette.tsx` | 修改 | /council 描述加 --rounds |
| `src/tui/__tests__/slash-commands.test.ts` | 修改 | help 文案断言 |

**调研背书：** 本计划全部为新增/扩展,无删除操作。
- `aggregateCouncil`(`council-plan.ts:99`)：存在原因=确定性裁决留痕。现有测试(`council-plan.test.ts`)只断言 `conflicts.length` 与"同输入两次 deepEqual",不硬断言 conflict 对象结构 → 给 `CouncilConflict` 加 `key`/`status` 字段安全。
- `runCouncil`(`council-orchestrator.ts:96`)：单轮扇出,workOrderId 用 `council:seat-${authority}` 原串匹配(line 128),coordinator 对 `council:` 前缀原样稳定化(测试 `council-orchestrator.test.ts:13` 用 `deriveStableWorkOrderId` 包装印证)→ round2 用 `council:seat-${authority}-r2`,同前缀同样稳定。
- `parseSeatContribution`(`council-orchestrator.ts:62`)：降级兜底解析,需扩展解析 `rebuttals`。

---

## 任务

### 任务 1：裁决内核 schema 扩展 + 收敛纯函数

- [ ] 修改 `src/agent/council/council-plan.ts`
- [ ] 测试 `src/agent/council/__tests__/council-plan.test.ts`

**目标：** 内核支持 round 字段、席位反驳、冲突稳定 key 与多轮收敛,全部为纯函数。

**实现：**

在 `council-plan.ts` 顶部 `RiskSeverity` 之后新增类型：

```typescript
export type RebuttalStance = 'concede' | 'hold' | 'revise'

/** 第二轮席位针对某条冲突的表态。conflictKey 引用 CouncilConflict.key。 */
export interface SeatRebuttal {
  conflictKey: string
  stance: RebuttalStance
  argument: string
}
```

`SeatContribution` 接口追加两个可选字段：

```typescript
export interface SeatContribution {
  authority: string
  summary: string
  additions: PlanItem[]
  risks: SeatRisk[]
  challenges: string[]
  alternatives: SeatAlternative[]
  /** 实际生效模型（遥测/shadow 用，本轮可缺）。 */
  modelUsed?: string
  /** 产出该贡献的轮次（缺省视为 1）。 */
  round?: number
  /** 第二轮反驳表态（仅 round2 贡献填充）。 */
  rebuttals?: SeatRebuttal[]
}
```

`CouncilConflict` 接口扩展为带 key 与收敛状态：

```typescript
export interface CouncilConflict {
  description: string
  left: string
  right: string
  /** 无序对稳定 key —— round2 席位针对它表态。round1 即填充。 */
  key: string
  /** 多轮收敛状态。round1 恒 'open'；round2 收敛后 resolved/persisted。 */
  status: 'open' | 'resolved' | 'persisted'
  /** resolved 时的化解依据（来自让步/折中席位的 argument）。 */
  resolution?: string
}
```

`CouncilPlan.meta.round` 由字面量放开：

```typescript
export interface CouncilPlan {
  objective: string
  seats: string[]
  contributions: SeatContribution[]
  aggregate: CouncilAggregate
  finalPlanMarkdown: string
  meta: { round: number; convenedAt: number; objectiveHash: string }
}
```

在 `isBlank` 之后新增内核 hash 与 key 派生(内核自洽,不依赖 orchestrator 的 objectiveHash)：

```typescript
function hashStr(s: string): string {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0
  return (h >>> 0).toString(16)
}

/** 无序对稳定 key：(left,right) 与 (right,left) 同 key。 */
export function stableConflictKey(left: string, right: string): string {
  const [a, b] = [left, right].slice().sort()
  return hashStr(`${a}\u0000${b}`)
}
```

`aggregateCouncil` 内的 `addConflict` 改为生成 key + status='open'。把两处 `addConflict({ description, left, right })` 调用改为带 key/status。最简做法：改 `addConflict` 签名只收 description/left/right，内部补 key/status：

```typescript
const addConflict = (c: { description: string; left: string; right: string }): void => {
  const full: CouncilConflict = { ...c, key: stableConflictKey(c.left, c.right), status: 'open' }
  if (!conflicts.some(ex => sameConflict(ex, full))) conflicts.push(full)
}
```

`sameConflict` 保持现有 left/right 无序比较不变(与 key 等价)。

文件末尾新增收敛纯函数：

```typescript
/**
 * 第二轮收敛：依据各席 rebuttals 把 open 冲突判为 resolved / persisted。纯函数。
 * 规则：按传入顺序找第一条 conflictKey 匹配且 stance∈{concede,revise} 的表态 →
 * resolved(附 resolution)；否则 persisted。已非 open 的冲突原样返回。
 */
export function resolveConflictsWithRebuttals(
  conflicts: CouncilConflict[],
  rebuttals: SeatRebuttal[],
): CouncilConflict[] {
  return conflicts.map(cf => {
    if (cf.status !== 'open') return cf
    const softening = rebuttals.find(
      r => r.conflictKey === cf.key && (r.stance === 'concede' || r.stance === 'revise'),
    )
    if (softening) return { ...cf, status: 'resolved' as const, resolution: softening.argument }
    return { ...cf, status: 'persisted' as const }
  })
}
```

**测试(TDD：先写下列用例,运行确认红,再实现到绿)：** 在 `council-plan.test.ts` 末尾追加：

```typescript
describe('stableConflictKey — 无序对一致', () => {
  it('(A,B) 与 (B,A) 同 key', () => {
    assert.equal(stableConflictKey('A', 'B'), stableConflictKey('B', 'A'))
  })
  it('不同对不同 key', () => {
    assert.notEqual(stableConflictKey('A', 'B'), stableConflictKey('A', 'C'))
  })
})

describe('aggregateCouncil — 冲突带 key 与 open 状态', () => {
  it('冲突填充确定性 key 且初始 status=open', () => {
    const a = seat({ authority: 's1', additions: [{ id: 'NEW', title: 'a', detail: 'X' }] })
    const b = seat({ authority: 's2', additions: [{ id: 'NEW', title: 'b', detail: 'Y' }] })
    const agg = aggregateCouncil(draft, [a, b])
    assert.equal(agg.conflicts.length, 1)
    assert.equal(agg.conflicts[0]!.status, 'open')
    assert.ok(agg.conflicts[0]!.key.length > 0)
  })
})

describe('resolveConflictsWithRebuttals — 多轮收敛', () => {
  const base = { description: 'd', left: 'L', right: 'R' }
  const k = stableConflictKey('L', 'R')
  it('concede → resolved 带 resolution', () => {
    const conflicts = [{ ...base, key: k, status: 'open' as const }]
    const out = resolveConflictsWithRebuttals(conflicts, [{ conflictKey: k, stance: 'concede', argument: '让步给护栏' }])
    assert.equal(out[0]!.status, 'resolved')
    assert.equal(out[0]!.resolution, '让步给护栏')
  })
  it('revise 也算化解', () => {
    const out = resolveConflictsWithRebuttals([{ ...base, key: k, status: 'open' }], [{ conflictKey: k, stance: 'revise', argument: '折中' }])
    assert.equal(out[0]!.status, 'resolved')
  })
  it('全 hold → persisted 无 resolution', () => {
    const out = resolveConflictsWithRebuttals([{ ...base, key: k, status: 'open' }], [{ conflictKey: k, stance: 'hold', argument: '坚持' }])
    assert.equal(out[0]!.status, 'persisted')
    assert.equal(out[0]!.resolution, undefined)
  })
  it('无匹配表态 → persisted', () => {
    const out = resolveConflictsWithRebuttals([{ ...base, key: k, status: 'open' }], [{ conflictKey: 'other', stance: 'concede', argument: 'x' }])
    assert.equal(out[0]!.status, 'persisted')
  })
  it('已 resolved 的冲突原样返回(幂等)', () => {
    const out = resolveConflictsWithRebuttals([{ ...base, key: k, status: 'resolved', resolution: 'prev' }], [{ conflictKey: k, stance: 'hold', argument: 'x' }])
    assert.equal(out[0]!.status, 'resolved')
    assert.equal(out[0]!.resolution, 'prev')
  })
})
```

在 `council-plan.test.ts` 顶部 import 补 `stableConflictKey, resolveConflictsWithRebuttals`。

**验证：**
```bash
npx tsc --noEmit
npm exec -- tsx --test src/agent/council/__tests__/council-plan.test.ts  # 期望全部通过
```

**提交：**
```bash
git add src/agent/council/council-plan.ts src/agent/council/__tests__/council-plan.test.ts
git commit -m "feat(council): 内核支持多轮 schema + 冲突收敛纯函数（任务 1/6）"
```

---

### 任务 2：多轮层 runCouncilDebate（单轮 runCouncil 零侵入）

- [ ] 修改 `src/agent/council/council-orchestrator.ts`
- [ ] 测试 `src/agent/council/__tests__/council-orchestrator.test.ts`

**目标：** `runCouncil` 保持纯单轮、实现完全不动；新增第二层 `runCouncilDebate`，先调 `runCouncil` 出 round1，再按 `maxRounds` 叠加 round2 反驳收敛。分两层，多轮逻辑绝不回灌进单轮函数。

**实现：**

`council-orchestrator.ts` 顶部 import 补 `resolveConflictsWithRebuttals`：

```typescript
import { aggregateCouncil, resolveConflictsWithRebuttals, type CouncilDraft, type CouncilPlan, type SeatContribution } from './council-plan.js'
```

`CouncilInput` 加 `maxRounds`：

```typescript
export interface CouncilInput {
  draft: CouncilDraft
  seats: CouncilSeat[]
  abortSignal?: AbortSignal
  /** 多轮层最大轮数。默认 1（纯单轮，行为同今天）；≥2 时 runCouncilDebate 才叠加 round2，且仅在 round1 有冲突时扇出。 */
  maxRounds?: number
}
```

> 注：`runCouncil` 本身忽略 `maxRounds`（它永远单轮）；该参数只被第二层 `runCouncilDebate` 读取。

`parseSeatContribution` 的返回对象补解析 rebuttals(在 `...(raw.modelUsed ...)` 之后)：

```typescript
          ...(raw.modelUsed ? { modelUsed: raw.modelUsed } : {}),
          ...(Array.isArray(raw.rebuttals) ? { rebuttals: raw.rebuttals } : {}),
```

`buildSeatObjective` 之后新增第二轮 objective 构造：

```typescript
/** 第二轮反驳 objective —— 席位只就 round1 冲突表态，不重出全稿。 */
export function buildSeatRebuttalObjective(
  seat: CouncilSeat,
  draft: CouncilDraft,
  conflicts: { key: string; description: string; left: string; right: string }[],
  ownRound1Summary?: string,
): string {
  return [
    `你是 ${seat.authority} 席位专家。议事会第二轮：首轮各席已出稿，现就以下分歧表态收敛，只出立场不执行。`,
    ...(seat.charter ? [`席位章程：${seat.charter}`] : []),
    '',
    `Objective: ${draft.objective}`,
    ...(ownRound1Summary ? [`你的首轮摘要：${ownRound1Summary}`] : []),
    '',
    '待裁分歧（针对每条给出立场）：',
    ...conflicts.map(c => `- [${c.key}] ${c.description} | 一方: ${c.left} | 另一方: ${c.right}`),
    '',
    'Return a JSON WorkerResult whose `artifacts` contains ONE entry:',
    '{ "kind": "note", "title": "seat-contribution", "content": "<a JSON string of your SeatContribution>" }',
    'SeatContribution = { authority, summary, rebuttals }, rebuttals = [{ conflictKey, stance, argument }].',
    'stance ∈ "concede"(让步) | "hold"(坚持) | "revise"(折中修订)；conflictKey 用上面方括号内的 key。',
    `Set authority to "${seat.authority}".`,
  ].join('\n')
}
```

`runCouncil` **实现完全不动**（仍 `meta: { round: 1, ... }`，仍只一次 `delegateBatch`）——它是第一层，本任务不碰它的函数体。

文件末尾新增第二层多轮函数（复用第一层）：

```typescript
/**
 * 多轮层：复用单轮 runCouncil 出 round1，按 maxRounds 叠加 round2 反驳收敛。
 * maxRounds<2 或 round1 无冲突 → 直接返回 round1（等价单轮，零额外扇出）。
 * round1 的 convenedAt 被复用，保证多轮产物时钟一致、确定。
 */
export async function runCouncilDebate(input: CouncilInput, deps: CouncilDeps): Promise<CouncilPlan> {
  const round1 = await runCouncil(input, deps)
  const maxRounds = input.maxRounds ?? 1
  if (maxRounds < 2 || round1.aggregate.conflicts.length === 0) return round1

  const r2requests: CouncilFanoutRequest[] = input.seats.map(seat => ({
    parentTurnId: `council:seat-${seat.authority}-r2`,
    objective: buildSeatRebuttalObjective(
      seat,
      input.draft,
      round1.aggregate.conflicts,
      round1.contributions.find(c => c.authority === seat.authority)?.summary,
    ),
    kind: 'plan',
    profile: 'council_expert',
    scope: {},
    authority: seat.authority,
  }))
  const run2 = await deps.delegateBatch(r2requests, 'all_required', input.abortSignal,
    deps.onSeatProgress
      ? (completed, total) => { deps.onSeatProgress?.(`${completed}/${total}`, 'done') }
      : undefined)
  const r2Contributions: SeatContribution[] = input.seats.map(seat => {
    const result = run2.results.find(r => r.workOrderId === `council:seat-${seat.authority}-r2`)
    if (!result) return { authority: seat.authority, summary: '', additions: [], risks: [], challenges: [], alternatives: [], round: 2 }
    return { ...parseSeatContribution(seat.authority, result), round: 2 }
  })
  const allRebuttals = r2Contributions.flatMap(c => c.rebuttals ?? [])
  const aggregate = { ...round1.aggregate, conflicts: resolveConflictsWithRebuttals(round1.aggregate.conflicts, allRebuttals) }
  const contributions = [...round1.contributions, ...r2Contributions]
  const meta = { ...round1.meta, round: 2 }
  const finalPlanMarkdown = renderCouncilPlan({ objective: input.draft.objective, seats: round1.seats, contributions, aggregate, finalPlanMarkdown: '', meta })
  return { objective: input.draft.objective, seats: round1.seats, contributions, aggregate, finalPlanMarkdown, meta }
}
```

`renderCouncilPlan` 已在文件顶部 import；无需新增。

**测试：** 现有 `runCouncil — 单轮 + 解耦` 套件**保持不动**（证明第一层零侵入）。新增 `runCouncilDebate` 套件。先加会制造冲突的 input 与带 rebuttal 的 round2 workerResult 工厂：

```typescript
// round2 结果用 -r2 后缀的稳定 id（与 orchestrator 绑定一致 — 防虚假绿灯）
function r2Result(seat: string, contribJson: string): WorkerResult {
  return { ...workerResult(seat, contribJson), workOrderId: deriveStableWorkOrderId(`council:seat-${seat}-r2`) ?? 'wo_unstable' }
}
// 两席同 id 不同 detail → round1 必产 1 冲突
const conflictInput: CouncilInput = {
  draft: { objective: 'split loop.ts', items: [] },
  seats: [{ authority: 'tianquan' }, { authority: 'tianfu' }],
}
function addJson(seat: string, detail: string): string {
  return JSON.stringify({ authority: seat, summary: `${seat}-s`, additions: [{ id: 'NEW', title: 't', detail }], risks: [], challenges: [], alternatives: [] })
}
```

```typescript
describe('runCouncilDebate — 多轮层（默认 1=单轮 opt-in）', () => {
  it('默认 maxRounds（=1）即使有冲突也不触发 round2（delegateBatch 1 次, meta.round=1, 冲突仍 open）', async () => {
    let calls = 0
    const deps: CouncilDeps = {
      delegateBatch: async (reqs) => { calls++; return { results: [r1c('tianquan', 'X'), r1c('tianfu', 'Y')] } },
      now: () => 1,
    }
    const plan = await runCouncilDebate(conflictInput, deps)  // 不传 maxRounds → 默认 1
    assert.equal(calls, 1)
    assert.equal(plan.meta.round, 1)
    assert.equal(plan.aggregate.conflicts[0]!.status, 'open')
  })

  it('maxRounds=2 无冲突 → 不触发 round2（1 次, meta.round=1）', async () => {
    let calls = 0
    const deps: CouncilDeps = {
      delegateBatch: async (reqs) => { calls++; return { results: reqs.map(r => workerResult(r.authority, '{}')) } },
      now: () => 1,
    }
    const plan = await runCouncilDebate({ ...conflictInput, maxRounds: 2 }, deps)
    assert.equal(calls, 1)
    assert.equal(plan.meta.round, 1)
  })

  it('maxRounds=2 有冲突 → 触发 round2（2 次, meta.round=2）', async () => {
    let calls = 0
    const deps: CouncilDeps = {
      delegateBatch: async (reqs) => {
        calls++
        if (calls === 1) return { results: [r1c('tianquan', 'X'), r1c('tianfu', 'Y')] }
        return { results: reqs.map(r => r2Result(r.authority, JSON.stringify({ authority: r.authority, summary: 's', rebuttals: [] }))) }
      },
      now: () => 1,
    }
    const plan = await runCouncilDebate({ ...conflictInput, maxRounds: 2 }, deps)
    assert.equal(calls, 2)
    assert.equal(plan.meta.round, 2)
  })

  it('防虚假绿灯：round2 objective 真含 round1 冲突 key', async () => {
    let round2Objectives: string[] = []
    const deps: CouncilDeps = {
      delegateBatch: async (reqs) => {
        if (reqs[0]!.parentTurnId.endsWith('-r2')) {
          round2Objectives = reqs.map(r => r.objective)
          return { results: reqs.map(r => r2Result(r.authority, JSON.stringify({ authority: r.authority, summary: 's', rebuttals: [] }))) }
        }
        return { results: [r1c('tianquan', 'X'), r1c('tianfu', 'Y')] }
      },
      now: () => 1,
    }
    const plan = await runCouncilDebate({ ...conflictInput, maxRounds: 2 }, deps)
    const key = plan.aggregate.conflicts[0]!.key
    assert.ok(round2Objectives.length > 0, 'round2 必须真的扇出')
    assert.ok(round2Objectives.some(o => o.includes(key)), 'round1 冲突 key 必须进 round2 objective')
  })

  it('round2 concede → 冲突收敛为 resolved', async () => {
    const deps: CouncilDeps = {
      delegateBatch: async (reqs) => {
        if (reqs[0]!.parentTurnId.endsWith('-r2')) {
          return { results: reqs.map(r => {
            const key = stableConflictKey('X', 'Y')
            const rebuttals = r.authority === 'tianfu' ? [{ conflictKey: key, stance: 'concede', argument: '认同方向' }] : []
            return r2Result(r.authority, JSON.stringify({ authority: r.authority, summary: 's', rebuttals }))
          }) }
        }
        return { results: [r1c('tianquan', 'X'), r1c('tianfu', 'Y')] }
      },
      now: () => 1,
    }
    const plan = await runCouncilDebate({ ...conflictInput, maxRounds: 2 }, deps)
    assert.equal(plan.aggregate.conflicts[0]!.status, 'resolved')
    assert.equal(plan.aggregate.conflicts[0]!.resolution, '认同方向')
  })
})
```

在测试文件顶部补 import：从 `'../council-orchestrator.js'` 补 `runCouncilDebate, buildSeatRebuttalObjective`；从 `'../council-plan.js'` 补 `stableConflictKey`。新增 helper `r1c`(round1 冲突贡献)：

```typescript
function r1c(seat: string, detail: string): WorkerResult { return workerResult(seat, addJson(seat, detail)) }
```

**验证：**
```bash
npx tsc --noEmit
npm exec -- tsx --test src/agent/council/__tests__/council-orchestrator.test.ts  # 期望全部通过
```

**提交：**
```bash
git add src/agent/council/council-orchestrator.ts src/agent/council/__tests__/council-orchestrator.test.ts
git commit -m "feat(council): 多轮层 runCouncilDebate（单轮 runCouncil 零侵入）（任务 2/6）"
```

---

### 任务 3：多轮渲染

- [ ] 修改 `src/agent/council/council-render.ts`
- [ ] 测试 `src/agent/council/__tests__/council-render.test.ts`

**目标：** markdown 反映真实轮数,冲突表展示收敛状态。

**实现：**

`renderCouncilPlan` 内 line 20 的固定"单轮会诊"改为动态轮数：

```typescript
  lines.push(`> 席位: ${plan.seats.join(' · ')} · ${plan.meta.round} 轮会诊 · convenedAt=${plan.meta.convenedAt}`, '')
```

冲突表(line 37-38)加状态/化解列：

```typescript
    lines.push('| 描述 | 一方 | 另一方 | 状态 | 化解 |', '|------|------|--------|------|------|')
    for (const cf of aggregate.conflicts) {
      const statusZh = cf.status === 'resolved' ? '已化解' : cf.status === 'persisted' ? '仍分歧' : '待议'
      lines.push(`| ${esc(cf.description)} | ${esc(cf.left)} | ${esc(cf.right)} | ${statusZh} | ${esc(cf.resolution ?? '')} |`)
    }
```

`summarizeCouncilPlan`(line 64)的"单轮"改动态：

```typescript
    `议事会 · ${plan.seats.length} 席 ${plan.meta.round} 轮 · ${plan.objective}`,
```

**测试：** 在 `council-render.test.ts` 追加：

```typescript
describe('renderCouncilPlan — 多轮', () => {
  it('meta.round=2 渲染「2 轮会诊」且冲突含化解状态', () => {
    const plan = {
      objective: 'o', seats: ['s1', 's2'], contributions: [],
      aggregate: { decisions: [], mergedItems: [], conflicts: [
        { description: 'd', left: 'L', right: 'R', key: 'k', status: 'resolved' as const, resolution: '让步' },
      ] },
      finalPlanMarkdown: '', meta: { round: 2, convenedAt: 1, objectiveHash: 'h' },
    }
    const md = renderCouncilPlan(plan)
    assert.match(md, /2 轮会诊/)
    assert.match(md, /已化解/)
    assert.match(md, /让步/)
  })
})
```

(注意：现有 render 测试若构造 conflicts，需补 `key`/`status` 字段以过 strict 类型——检查并修正。)

**验证：**
```bash
npx tsc --noEmit
npm exec -- tsx --test src/agent/council/__tests__/council-render.test.ts  # 期望全部通过
```

**提交：**
```bash
git add src/agent/council/council-render.ts src/agent/council/__tests__/council-render.test.ts
git commit -m "feat(council): 渲染动态轮数 + 冲突收敛状态列（任务 3/6）"
```

---

### 任务 4：工具入参 rounds + 遥测轮数

- [ ] 修改 `src/tools/council-convene.ts`、`src/agent/council/council-telemetry.ts`
- [ ] 测试 `src/tools/__tests__/council-convene.test.ts`、`src/agent/council/__tests__/council-gate-telemetry.test.ts`

**目标：** `council_convene` 接收 `rounds`，按值选择走单轮 `runCouncil` 还是多轮 `runCouncilDebate`（分两层入口）；遥测记录实际轮数。

**实现：**

`council-convene.ts` 顶部 import 补 `runCouncilDebate`：

```typescript
import { runCouncil, runCouncilDebate, type CouncilDeps } from '../agent/council/council-orchestrator.js'
```

`council-convene.ts` 的 `inputSchema` 加：

```typescript
const inputSchema = z.object({
  objective: z.string().min(1),
  draftItems: z.array(planItemSchema).optional(),
  seats: z.array(seatSchema).optional(),
  rounds: z.number().int().min(1).max(2).optional(),
})
```

`definition.input_schema.properties` 加：

```typescript
          rounds: { type: 'number', description: 'Max debate rounds (1-2, default 1 = single round). Pass 2 to enable a rebuttal round; round 2 only fires when round 1 surfaces conflicts.' },
```

`execute` 解构与调用：

```typescript
      const { objective, draftItems, seats, rounds } = parsed.data
```
```typescript
        // 分两层入口：默认走单轮 runCouncil；显式 rounds≥2 才走多轮层 runCouncilDebate。
        const runner = (rounds && rounds >= 2) ? runCouncilDebate : runCouncil
        plan = await runner({ draft: { objective, items }, seats: councilSeats, ...(rounds ? { maxRounds: rounds } : {}), ...(params.abortSignal ? { abortSignal: params.abortSignal } : {}) }, deps)
```

`definition.description` 调整为说明默认单轮、可选多轮：

```typescript
        'Convene a star-domain council to review a plan draft. Default is a single advisory round; pass rounds:2+ to enable a rebuttal/debate round (round 2 only fires when round 1 surfaces conflicts). Fans out to seat experts (advisory only, no execution), deterministically adjudicates, and returns an auditable Markdown plan. Decoupled from team_orchestrate — NEVER dispatches execution work. Disabled when COUNCIL=0.',
```

`council-telemetry.ts` 的 `CouncilSessionEvent` 加 `roundsRun`,`buildCouncilSessionEvent` 从 `plan.meta.round` 读取：

```typescript
export interface CouncilSessionEvent {
  schemaVersion: 1
  sessionId: string
  objective: string
  objectiveHash: string
  seats: string[]
  roundsRun: number
  decisionCount: number
  // ...其余不变
}
```
在 `buildCouncilSessionEvent` 返回对象加 `roundsRun: plan.meta.round,`(置于 seats 之后)。

**测试：** `council-convene.test.ts` 加一例断言 rounds 透传(mock coordinator 捕获是否产生 2 次 delegateBatch，或断言 runCouncil 收到 maxRounds —— 用现有 mock 风格构造 round1 冲突 + 验证第二次扇出)。`council-gate-telemetry.test.ts` 加一例断言 `buildCouncilSessionEvent` 产出的 `roundsRun` 等于 `plan.meta.round`。

**验证：**
```bash
npx tsc --noEmit
npm exec -- tsx --test src/tools/__tests__/council-convene.test.ts src/agent/council/__tests__/council-gate-telemetry.test.ts  # 期望全部通过
```

**提交：**
```bash
git add src/tools/council-convene.ts src/agent/council/council-telemetry.ts src/tools/__tests__/council-convene.test.ts src/agent/council/__tests__/council-gate-telemetry.test.ts
git commit -m "feat(council): council_convene rounds 入参 + 遥测记录轮数（任务 4/6）"
```

---

### 任务 5：/council slash 入口 --rounds

- [ ] 修改 `src/workflows/ecosystem-workflows.ts`
- [ ] 测试 `src/workflows/__tests__/ecosystem-workflows.test.ts`

**目标：** `/council <task> --rounds N` 解析并把 rounds 注入给 model 的 council_convene 调用 prompt。

**实现：**

`CouncilWorkflowPromptOptions`(line 32)加 `rounds`：

```typescript
export interface CouncilWorkflowPromptOptions {
  objective: string
  seats?: string[]
  rounds?: number
}
```

`COUNCIL_USAGE`(line 325)：

```typescript
export const COUNCIL_USAGE = 'Council usage: /council <要会诊的计划/问题> [--seats id1,id2,...] [--rounds 1-2]'
```

`parseCouncilWorkflowArgs`：在 `--seats` 解析后、return 前,加 `--rounds` 解析(从 objective 剥离)：

```typescript
  // Parse --rounds flag.
  let rounds: number | undefined
  const roundsIdx = objective.search(/\s+--rounds\b/)
  if (roundsIdx >= 0) {
    const afterRounds = objective.slice(roundsIdx).replace(/^\s+--rounds\s*/, '')
    const tok = afterRounds.split(/[\s,]+/).find(s => s.length > 0)
    const n = tok ? Number.parseInt(tok, 10) : NaN
    objective = objective.slice(0, roundsIdx).trim()
    if (Number.isInteger(n) && n >= 1 && n <= 3) rounds = n
  }

  return objective ? { objective, ...(seats?.length ? { seats } : {}), ...(rounds ? { rounds } : {}) } : null
```

注意：`--rounds` 解析须在 `--seats` 之后(seats 用 `objective.slice(0, seatsIdx)` 截断,若 rounds 在 seats 之前会被一起截掉)。实际两 flag 顺序不定 —— 改为各自独立 search+剥离即可(上面写法对每个 flag 独立 search 当前 objective,先 seats 后 rounds,两者都从当前 objective 剥离,顺序无关)。

`buildCouncilWorkflowPrompt`：注入 rounds 参数到 council_convene 调用描述。在 `seatsParam` 之后加：

```typescript
  const roundsParam = options.rounds ? `, rounds: ${options.rounds}` : ''
```
把 line 367 的工具参数串改为：
```typescript
- 调用 council_convene 工具,参数 { objective: "${objective}"${seatsParam}${roundsParam} };${seatsNote}。
```
line 368 的会诊描述按是否多轮动态生成（默认不给 `--rounds` 时仍宣告单轮，与默认行为一致）。在 `roundsParam` 之后加：

```typescript
  const roundDesc = options.rounds && options.rounds >= 2
    ? `这是多轮辩论(至多 ${options.rounds} 轮,仅在首轮出现冲突时才进第二轮反驳收敛)`
    : '这是单轮会诊'
```
把 line 368 句首 "这是单轮会诊" 替换为 `${roundDesc}`（其余"扇出席位 → 确定性裁决 ..."不变）。

**测试：** `ecosystem-workflows.test.ts` 加：
- `/council review --rounds 2` → `parseCouncilWorkflowArgs` 返回 `{ objective: 'review', rounds: 2 }`。
- `--rounds` 越界(0 / 5 / abc)→ 不注入 rounds(降级默认单轮)。
- `--seats a,b --rounds 3` 与 `--rounds 3 --seats a,b` 都正确解析出 seats 与 rounds,objective 干净。
- `buildCouncilWorkflowPrompt({ objective:'x', rounds:2 })` 输出含 `rounds: 2` 且含"多轮"；`buildCouncilWorkflowPrompt({ objective:'x' })`（无 rounds）输出含"单轮"且不含 `rounds:`。

**验证：**
```bash
npx tsc --noEmit
npm exec -- tsx --test src/workflows/__tests__/ecosystem-workflows.test.ts  # 期望全部通过
```

**提交：**
```bash
git add src/workflows/ecosystem-workflows.ts src/workflows/__tests__/ecosystem-workflows.test.ts
git commit -m "feat(council): /council --rounds 解析与 prompt 注入（任务 5/6）"
```

---

### 任务 6：TUI 提示更新

- [ ] 修改 `src/tui/slash-commands.ts`、`src/tui/command-palette.tsx`
- [ ] 测试 `src/tui/__tests__/slash-commands.test.ts`

**目标：** help 与命令面板反映 `--rounds`。

**实现：**

`slash-commands.ts` 的 `HELP_TEXT` 中 `/council` 行改为：

```
/council <task> [--seats id1,id2,...] [--rounds 1-2]
```

`command-palette.tsx` 的 `/council` 描述改为：

```typescript
{ name: '/council', description: 'Convene a star-domain council (single round; --rounds 2+ enables debate)' },
```

**测试：** `slash-commands.test.ts` 现有 `/council` 用例补断言 help 文案含 `--rounds`。

**验证：**
```bash
npx tsc --noEmit
npm exec -- tsx --test src/tui/__tests__/slash-commands.test.ts  # 期望全部通过
```

**提交：**
```bash
git add src/tui/slash-commands.ts src/tui/command-palette.tsx src/tui/__tests__/slash-commands.test.ts
git commit -m "feat(council): TUI /council help 与面板补 --rounds（任务 6/6）"
```

---

## 收尾验证(全任务完成后)

```bash
npx tsc --noEmit
npm exec -- tsx --test src/agent/council/__tests__/*.test.ts src/tools/__tests__/council-convene.test.ts src/workflows/__tests__/ecosystem-workflows.test.ts src/tui/__tests__/slash-commands.test.ts
npm test   # 全量 2340+ 测试,确认无回归
```

交付报告须覆盖：做了什么 / 遗留什么(W-C7~C9 仍在后续路线图) / 设计偏差(如有,例如收敛规则若因 worker 实际输出调整)。

## 自检结果

- **分两层(本次纠偏核心)**：`runCouncil` 单轮零侵入(任务2 不碰其函数体，现有单轮测试套件保持不动作为零侵入证据)；多轮全部在新函数 `runCouncilDebate`(任务2)；`council_convene` 按 `rounds` 选层(任务4)；`maxRounds` 默认 1 → 不给 `--rounds` 时行为同今天，多轮为 opt-in。
- **规格覆盖**：round 放开(任务1)、席位反驳 schema(任务1)、收敛纯函数(任务1)、多轮层 runCouncilDebate + round2 条件扇出(任务2)、防虚假绿灯接线测试(任务2)、渲染轮数与状态(任务3)、工具按层入参+遥测(任务4)、slash --rounds(任务5)、TUI 提示(任务6)—— 全覆盖。
- **占位符扫描**：无 TODO/TBD/"后续实现";所有类型(SeatRebuttal/RebuttalStance/CouncilConflict 扩展)在使用前于任务1 定义。
- **类型一致性**：`maxRounds`(CouncilInput，仅 runCouncilDebate 读取)、`rounds`(工具/workflow 入参，默认 1)、`meta.round`(实际轮数)、`roundsRun`(遥测)命名分层一致;`runCouncilDebate`/`stableConflictKey`/`resolveConflictsWithRebuttals` 签名跨任务一致。
- **调研背书**：本计划无删除操作;`runCouncil` 实现不动(仅被 `runCouncilDebate` 复用)；`aggregateCouncil`/`parseSeatContribution` 的扩展均附存在原因与现有测试边界(见文件结构段)。
</parameter>
</invoke>
