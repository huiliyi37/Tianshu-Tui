# 天枢审查纪律内化 — 能力边界补强（开源前）实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法跟踪进度。
>
> **⚠️ 本计划核心架构已裁决，B 注入面已裁决为 B3（不进提示词）；当前仅 C 开源默认姿态待团队裁决。** 分叉未定前，标记 `[依赖裁决-N]` 的任务不可启动。决策记录区在文末，团队拍板后回填，再解锁对应任务。

**目标：** 把这次三轮对抗审查血泪验证出的四条审查纪律，从"CLAUDE.md 里的死信念"变成"天枢运行时被强制触发的行为"，补上"机制存在但从不激活"的能力边界缺口。

**架构：** 缺口是两层的——(1) 提示词层：纪律没注入运行时 system prompt；(2) 门禁层：`delivery-gate-v2` 的 GREEN 可被自我断言满足，从不强制独立 adversarial 验证。方案在两层都补，但**强制力/注入面/开源默认**三个维度有真实权衡，留给团队裁决。

**技术栈：** TypeScript（strict, ESM, Node 22）；`src/prompt/{static,volatile,engine}.ts`；`src/agent/delivery-gate-v2.ts`；`src/agent/runtime-hooks.ts` + `src/agent/hooks/*`；`src/agent/profile-registry.ts`（`adversarial_verifier` 已存在）；`node:test`。

---

## 背景：缺口的实证根因（来自 2026-06-06 三轮审查）

| 轮次 | 现象 | 暴露的纪律缺口 |
|------|------|----------------|
| R1 | 首轮实现 18 缺陷，全在正向数据流的负空间 | 注意力单光束，安全/并发/失败模式被功能正确性挤占 |
| R2 | `51a26a3` H3 假修复，锁只包了 read | 修复未 spawn 独立 verifier；声称修复但无并发测试 |
| R3 | `411a51f` H4 删坏相邻行 → 调度器不触发任何任务 | 改 X 没跑覆盖 X 的既有测试；删除行未同等审视 |
| R3 | `411a51f` 声称"5 套件全过"但触发测试必红 | "测试全过"声明被自我断言满足，无命令+输出证据 |

**根因一句话：** profile（`adversarial_verifier`）、gate（`delivery-gate-v2`）、hook pipeline 都在代码里，但它们是 advisory，没有在"交付/修复"动作上被强制触发，也没进运行时提示词。CLAUDE.md 是历史机制，从未注入天枢提示词。

**四条要内化的纪律（本计划的实体）：**
1. **不可同上下文自我审批** —— 修复/交付前须一次独立验证 pass。
2. **修复提交前 spawn `adversarial_verifier`** —— 拿命令+输出证据，非自我断言。
3. **改 X 必跑覆盖 X 的既有测试 + 删除行同等审视** —— 防 H4 类相邻回归。
4. **"测试全过"声明 fail-closed** —— 无命令+输出证据的绿，按未验证处理。

---

## 决策点（团队商议用，未定前阻塞对应任务）

### 分叉 A：审查纪律的强制力级别

| 选项 | 做法 | 利 | 弊 | 牵动的实现 |
|------|------|----|----|-----------|
| **A1 硬门禁** | `delivery-gate` 对"修复类提交"强制：无独立 `adversarial_verifier` 的命令+输出证据 → RED 拦截 | 自我断言无法通行，最贴合 R2/R3 教训 | 改 gate 行为，可能挡快速迭代；误判修复类型会误伤 | 任务 4（gate 强制分支）+ 任务 5（修复类提交识别） |
| **A2 软推+可升级** | 默认 advisory nudge；检测到"修复提交+无独立验证"升级为 YELLOW 并要求确认 | 不硬拦，保留迭代速度，靠提示压力 | 高自信状态仍可能略过 YELLOW（R2/R3 正是略过 advisory） | 任务 4 改为 YELLOW 分支，不引入 RED |
| **A3 纯提示词** | 只把四条纪律注入 prompt，不动门禁 | 改动最小 | 这次已证明"prompt 里的 belief"会被高自信绕过——力度最弱 | 仅任务 1-3，跳过任务 4-5 |

### 核心架构（已裁决）：ReviewRouter 按规模路由 + 自动闭环

> 团队裁决（2026-06-06）：纪律强制不是「一刀切硬门禁」，而是**按任务规模路由到不同审查工作流**，且审查主体**尽量从主控下沉到子代理**——主控只做「派单 + 看结论 + 闭环失败兜底」，注意力不被审查吃光。

**裁决结果：**
- **规模分级 = 自动路由器**：`routeReviewWorkflow(changeSet)` 按规模自动选档，主控不自己决定审查多重。
- **小任务干预 = 自动 spawn 轻量 verifier**：修复/小改提交时自动派一个 `adversarial_verifier` 子代理，拿 diff+既有测试跑一遍、试着打破、回报结论。主控不下场追时序。
- **跨审触发 = 自动闭环重审**：子代理报缺陷 → 自动触发一轮修复→再审，主控仅在闭环失败（超过 maxRounds）时介入。

**三档路由表：**

| 档位 | 触发条件（自动判定） | 审查工作流 | 主控负担 |
|------|---------------------|-----------|----------|
| **L3 Squadron** | 新子系统 / ≥4 文件 / 跨模块 / 改架构 | 多 Inspector 并行（安全/生命周期/数据流/静默）+ 合议 | 派单 + 读合议结论 |
| **L2 单对抗子代理** | 单/双文件修复 / fix 类提交 / 改既有逻辑 | 1 个 `adversarial_verifier`：跑既有测试+对抗打破+回报 | 只看结论 |
| **L1 nudge** | 微改（常量/文档/格式） / 行数 < 阈值 | 仅提示词注入纪律，不派代理 | 无 |

**自动闭环（L2/L3 通用）：**
```
verifier 回报 → verdict=verified? ──是──→ 通过，回主控看结论
                      │否
                      ▼
              spawn patcher 修一轮 → 再 spawn verifier 复审
                      │
              round < maxRounds(默认3)? ──是──→ 回到复审
                      │否
                      ▼
              升级主控：附「N 轮未收敛 + 每轮 verdict+证据」
```

> 关键不变量：闭环**有界**（maxRounds 防无限循环）；每轮 verifier 须附**命令+输出证据**（纪律4 fail-closed）；patcher 与 verifier 是**不同子代理**（纪律1 不可同上下文自我审批）。

### 分叉 B（已裁决）：纪律注入到哪个面（涉及 prefix-cache 代价）

> 决策（2026-06-06）：选 **B3 不进提示词**。L1 nudge 由 router/tool 输出承载，避免 static prompt 与 runtime hook 注入带来的 prefix-cache 代价；L2/L3 靠子代理 objective 携带纪律，不依赖 B。

| 选项 | 做法 | 利 | 弊 | 牵动的实现 |
|------|------|----|----|-----------|
| **B1 运行时 hook 按需注入** | `delivery-discipline-hook`（`postTurn`），仅 L1 档（微改）时注入纪律文本 | 平时不占 prompt、不破 prefix cache | 需可靠识别上下文 | 任务 3（hook） |
| **B2 static 基础提示词常驻** | 四条纪律写进 `static.ts` BASE_PROMPT | 始终在场、最简单 | 动 static 区有 prefix-cache 代价 | 任务 3 改为直接改 static |
| **B3 不进提示词** | L1 也靠 router 输出文字，prompt 零改 | prompt 零代价 | 微改场景天枢"不知为何被提示" | 跳过任务 3 |

### 分叉 C（仍待裁决）：开源后面向团队的默认姿态

| 选项 | 做法 | 利 | 弊 | 牵动的实现 |
|------|------|----|----|-----------|
| **C1 内置默认开启，可关** | router 默认生效，`config`/`env` 可关闭或调阈值 | 新用户即享纪律，高级团队可定制 | 需做配置开关 + 文档 | 任务 6（config 开关） |
| **C2 可插拔 skill/profile** | 做成独立可启用模块，默认不开 | 核心精简 | 新用户默认享受不到，缺口仍在 | 任务 6 改为 skill 注册 |
| **C3 仅文档约定** | 写进开源文档作最佳实践，不进运行时 | 最自由 | 等于不补能力边界，只补说明书 | 仅文档任务 |

> **依赖关系：** 核心架构（任务 1/4/5）无条件执行；B 决定任务 3 形态；C 决定任务 6 形态。

## 文件结构

| 文件 | 职责 | 牵动 |
|------|------|------|
| 创建 `src/agent/review-discipline.ts` | 四条纪律常量 + `isFixContext()` + `classifyChangeScale()`（L1/L2/L3 判定） | 核心 |
| 创建 `src/agent/review-router.ts` | `routeReviewWorkflow(changeSet)` → 选档 + 自动 spawn verifier + 自动闭环 | 核心 |
| 修改 `src/agent/delivery-gate-v2.ts:219-275` | 修复类提交无 verifier 证据 → 调用 router 而非直接 RED | 核心 |
| 创建 `src/agent/hooks/delivery-discipline-hook.ts` | L1 档 postTurn 注入纪律文本 | B=B1 |
| 修改 `src/prompt/static.ts:3`（BASE_PROMPT） | 纪律写进 `<workflow>` 段 | B=B2 |
| 创建 `src/config/review-discipline-config.ts` | 默认开启 + env 开关 + maxRounds/规模阈值配置 | C=C1 |
| 测试 `src/agent/__tests__/review-discipline.test.ts` | 识别函数 + 规模分级 + 纪律常量 | 核心 |
| 测试 `src/agent/__tests__/review-router.test.ts` | 路由选档 + 闭环有界 + verifier 证据要求 | 核心 |
| 测试 `src/agent/__tests__/delivery-gate-v2.test.ts`（追加） | 修复提交触发 router | 核心 |

> 设计原则：纪律文本/识别/分级集中在 `review-discipline.ts`（单一职责），router/hook/gate/prompt 都引用它，DRY——避免四条纪律在多处漂移。

---

### 任务 1：审查纪律常量 + 修复上下文识别（所有分叉的基础）

**文件：**
- 创建：`src/agent/review-discipline.ts`
- 测试：`src/agent/__tests__/review-discipline.test.ts`

- [ ] **步骤 1：编写失败的测试**

```typescript
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { REVIEW_DISCIPLINES, isFixContext } from '../review-discipline.js'

test('REVIEW_DISCIPLINES contains all four disciplines', () => {
  assert.equal(REVIEW_DISCIPLINES.length, 4)
  const joined = REVIEW_DISCIPLINES.join('\n')
  assert.ok(joined.includes('自我审批'))      // 纪律1
  assert.ok(joined.includes('adversarial_verifier')) // 纪律2
  assert.ok(joined.includes('既有测试'))      // 纪律3
  assert.ok(joined.includes('fail-closed'))   // 纪律4
})

test('isFixContext detects fix-type commit messages', () => {
  assert.equal(isFixContext('fix(server): H4 回归修复'), true)
  assert.equal(isFixContext('修复 dedup TOCTOU'), true)
  assert.equal(isFixContext('feat: add new route'), false)
  assert.equal(isFixContext('docs: update handoff'), false)
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npx tsx --test src/agent/__tests__/review-discipline.test.ts`
预期：FAIL，报 `Cannot find module '../review-discipline.js'`

- [ ] **步骤 3：编写最少实现**

```typescript
// src/agent/review-discipline.ts
/** 三轮对抗审查（2026-06-06）验证出的四条审查纪律 */
export const REVIEW_DISCIPLINES: readonly string[] = [
  '不可在同一上下文自我审批：修复或交付前，须经一次独立验证 pass（换 agent/换上下文），作者的自信不能顶替验证者的命令行。',
  '修复类改动提交前，spawn adversarial_verifier 拿命令+观察输出证据——不是读懂代码就盖 PASS。',
  '改了 X 必须跑覆盖 X 的既有测试，不只跑你为 X 新写的测试；审 diff 时删除行（-）与新增行同等审视，回归常长在编辑点的相邻行。',
  '"测试全过/已修复"是最高优先级的自我审查对象，fail-closed：无"实际运行的命令+观察到的关键输出"的绿声明，一律按未验证处理。',
]

const FIX_PATTERNS = [/\bfix(\(|:|\b)/i, /修复/, /回归/, /regression/i, /patch\b/i]
export function isFixContext(message: string): boolean {
  return FIX_PATTERNS.some(p => p.test(message))
}

export type ReviewScale = 'L1' | 'L2' | 'L3'
export interface ChangeSet { files: string[]; crossModule: boolean; isFix: boolean }

const DOC_OR_TRIVIAL = /\.(md|txt|json)$|README|CHANGELOG/i
/** 按规模分级：L3 squadron / L2 单对抗子代理 / L1 nudge */
export function classifyChangeScale(c: ChangeSet): ReviewScale {
  if (c.files.length >= 4 || c.crossModule) return 'L3'
  if (c.files.every(f => DOC_OR_TRIVIAL.test(f)) && !c.isFix) return 'L1'
  return 'L2'
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`npx tsx --test src/agent/__tests__/review-discipline.test.ts`
预期：PASS（3 tests）。须含一条 `classifyChangeScale` 测试：L3（≥4文件/跨模块）、L2（单文件 fix）、L1（仅文档）。

- [ ] **步骤 5：typecheck + commit**

```bash
npm run typecheck
git add src/agent/review-discipline.ts src/agent/__tests__/review-discipline.test.ts
git commit -m "feat(agent): review disciplines + fix-context + change-scale classifier"
```

---

### 任务 2：ReviewRouter — 按规模路由 + 自动 spawn verifier + 有界闭环（计划中枢）

**文件：**
- 创建：`src/agent/review-router.ts`
- 测试：`src/agent/__tests__/review-router.test.ts`

> 计划核心。先读 `src/agent/coordinator.ts`（如何 delegate work order、回传 worker 结果、`evidenceStatus` 形态）与 `profile-registry.ts:83`（`adversarial_verifier`）。用依赖注入的 `spawnVerifier`/`spawnPatcher`/`spawnSquadron` 抽象，测试注桩、生产接 coordinator。

- [ ] **步骤 1：编写失败的测试（三条：L1 不 spawn / L2 verified 通过带证据 / 闭环有界升级）**

```typescript
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { routeReviewWorkflow } from '../review-router.js'

const okDeps = {
  spawnVerifier: async () => ({ verdict: 'verified' as const, evidence: 'ran: npx test → 27/27' }),
  spawnPatcher: async () => ({ patched: true }),
  spawnSquadron: async () => ({ findings: [] }),
}

test('L1 micro-change → nudge only, no agent spawned', async () => {
  let n = 0
  const r = await routeReviewWorkflow({ files: ['README.md'], crossModule: false, isFix: false },
    { ...okDeps, spawnVerifier: async () => { n++; return { verdict: 'verified', evidence: '' } } })
  assert.equal(r.tier, 'L1'); assert.equal(n, 0)
})

test('L2 fix → spawns verifier, passes on verified WITH evidence', async () => {
  const r = await routeReviewWorkflow({ files: ['x.ts'], crossModule: false, isFix: true }, okDeps)
  assert.equal(r.tier, 'L2'); assert.equal(r.verdict, 'verified')
  assert.ok(r.evidence!.includes('ran:')) // 纪律4：必须带命令+输出
})

test('closed loop bounded by maxRounds then escalates', async () => {
  let rounds = 0
  const r = await routeReviewWorkflow({ files: ['x.ts'], crossModule: false, isFix: true },
    { ...okDeps, spawnVerifier: async () => { rounds++; return { verdict: 'rejected', evidence: 'broken' } } },
    { maxRounds: 3 })
  assert.equal(r.escalated, true); assert.equal(rounds, 3) // 有界，不无限循环
})
```

- [ ] **步骤 2：运行验证失败** — `npx tsx --test src/agent/__tests__/review-router.test.ts` → 模块不存在。

- [ ] **步骤 3：编写最少实现**

```typescript
// src/agent/review-router.ts
import { classifyChangeScale, type ChangeSet, type ReviewScale } from './review-discipline.js'

export interface VerifierResult { verdict: 'verified' | 'rejected'; evidence: string }
export interface ReviewRouterDeps {
  spawnVerifier: (c: ChangeSet) => Promise<VerifierResult>
  spawnPatcher: (c: ChangeSet, v: VerifierResult) => Promise<{ patched: boolean }>
  spawnSquadron: (c: ChangeSet) => Promise<{ findings: unknown[] }>
}
export interface ReviewOutcome {
  tier: ReviewScale; verdict?: 'verified' | 'rejected'; evidence?: string
  escalated?: boolean; rounds?: number
}

export async function routeReviewWorkflow(
  change: ChangeSet, deps: ReviewRouterDeps, opts?: { maxRounds?: number },
): Promise<ReviewOutcome> {
  const tier = classifyChangeScale(change)
  if (tier === 'L1') return { tier }                  // nudge only，主控不下场
  if (tier === 'L3') await deps.spawnSquadron(change) // 多 Inspector 并行（合议细节后续）
  const maxRounds = opts?.maxRounds ?? 3              // 有界闭环
  let last: VerifierResult = { verdict: 'rejected', evidence: '' }
  for (let round = 1; round <= maxRounds; round++) {
    last = await deps.spawnVerifier(change)           // verifier 与 patcher 是不同子代理（纪律1）
    if (last.verdict === 'verified') return { tier, verdict: 'verified', evidence: last.evidence, rounds: round }
    await deps.spawnPatcher(change, last)             // rejected → 修一轮，再审
  }
  return { tier, verdict: 'rejected', evidence: last.evidence, escalated: true, rounds: maxRounds }
}
```

- [ ] **步骤 4：运行验证通过** — `npx tsx --test src/agent/__tests__/review-router.test.ts` → PASS（3 tests）。

- [ ] **步骤 5：commit**

```bash
npm run typecheck && npx tsx --test src/agent/__tests__/review-router.test.ts
git add src/agent/review-router.ts src/agent/__tests__/review-router.test.ts
git commit -m "feat(agent): ReviewRouter — scale-based routing + auto verifier + bounded loop"
```

---

### 任务 3 `[依赖裁决-B=B1]`：delivery-discipline-hook（L1 档运行时注入纪律文本）

> 仅当分叉 B=B1 时执行。B=B2 改为直接编辑 `static.ts`；B=B3 跳过。

**文件：**
- 创建：`src/agent/hooks/delivery-discipline-hook.ts`
- 测试：`src/agent/__tests__/delivery-discipline-hook.test.ts`

- [ ] **步骤 1：编写失败的测试**

```typescript
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createDeliveryDisciplineHook } from '../hooks/delivery-discipline-hook.js'

test('hook injects disciplines when context is a fix', () => {
  const injected: string[] = []
  const hook = createDeliveryDisciplineHook()
  assert.equal(hook.phase, 'postTurn')
  hook.run(
    { lastUserMessage: 'fix(server): H4 回归修复' } as never,
    { injectGuidance: (t: string) => injected.push(t) } as never,
    {} as never,
  )
  assert.equal(injected.length, 1)
  assert.ok(injected[0]!.includes('adversarial_verifier'))
})

test('hook stays silent for non-fix context', () => {
  const injected: string[] = []
  const hook = createDeliveryDisciplineHook()
  hook.run(
    { lastUserMessage: 'feat: add route' } as never,
    { injectGuidance: (t: string) => injected.push(t) } as never,
    {} as never,
  )
  assert.equal(injected.length, 0)
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npx tsx --test src/agent/__tests__/delivery-discipline-hook.test.ts`
预期：FAIL，模块不存在。

- [ ] **步骤 3：编写最少实现**

> ⚠️ 实现前先读 `src/agent/runtime-hooks.ts:77-83`（PostTurnRuntimeHook 接口）和 `src/agent/hooks/consistency-check-hook.ts`（结构样例），用真实的 `RuntimeHookSnapshot`/`RuntimeHookEffects` 字段名替换下面的占位类型——下面是结构骨架，字段须对齐真实接口。

```typescript
// src/agent/hooks/delivery-discipline-hook.ts
import type { PostTurnRuntimeHook } from '../runtime-hooks.js'
import { REVIEW_DISCIPLINES, isFixContext } from '../review-discipline.js'

export function createDeliveryDisciplineHook(): PostTurnRuntimeHook {
  return {
    phase: 'postTurn',
    name: 'delivery-discipline',
    run: (snapshot, effects) => {
      const msg = snapshot.lastUserMessage ?? ''
      if (!isFixContext(msg)) return
      effects.injectGuidance(
        '【交付纪律 · 修复上下文】提交前必做：\n- ' + REVIEW_DISCIPLINES.join('\n- '),
      )
    },
  }
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`npx tsx --test src/agent/__tests__/delivery-discipline-hook.test.ts`
预期：PASS（2 tests）。若字段名不符报错，按真实 `runtime-hooks.ts` 接口修正测试桩与实现，再跑。

- [ ] **步骤 5：注册 hook + commit**

> 读 `src/agent/loop.ts` 中 RuntimeHookPipeline 的注册处（grep `register` 或 `new RuntimeHookPipeline`），按现有 hook 注册模式加入 `createDeliveryDisciplineHook()`。

```bash
npm run typecheck && npx tsx --test src/agent/__tests__/delivery-discipline-hook.test.ts
git add src/agent/hooks/delivery-discipline-hook.ts src/agent/__tests__/delivery-discipline-hook.test.ts src/agent/loop.ts
git commit -m "feat(agent): delivery-discipline hook — inject review disciplines on fix context"
```

---

### 任务 1b `[依赖裁决-B=B2]`：纪律写进 static 基础提示词

> 仅当 B=B2 时执行，与任务 2 互斥。

**文件：**
- 修改：`src/prompt/static.ts`（`<workflow>` 段，约 44-48 行后追加）

- [ ] **步骤 1：先读现状**

运行：`npx tsx --test src/prompt/__tests__/static.test.ts`（若存在）确认基线绿；读 `static.ts:44-48` 的 `<workflow>` 段。

- [ ] **步骤 2：注入纪律（edit_file 精确追加）**

在 `<workflow>` 段末尾、`</workflow>` 前追加（从 `review-discipline.ts` 引用，避免文本漂移——若 static 是纯字符串常量无法 import，则在此内联四条文本并加注释指向 `review-discipline.ts` 为权威源）：

```
交付纪律（修复类改动尤其严格）：
- 不在同一上下文自我审批；修复/交付前经一次独立验证 pass。
- 修复提交前 spawn adversarial_verifier 拿命令+输出证据，不靠自我断言。
- 改 X 必跑覆盖 X 的既有测试；审 diff 时删除行与新增行同等审视。
- "测试全过"fail-closed：无命令+输出证据的绿，按未验证处理。
```

- [ ] **步骤 3：验证 prompt 快照测试 + prefix-cache 影响**

运行：`npm run typecheck` 及任何 prompt 快照测试。**确认改动在 `<workflow>` 段（非最早期 identity 段），减小 prefix-cache 失效范围。**

- [ ] **步骤 4：commit**

```bash
git add src/prompt/static.ts
git commit -m "feat(prompt): inject review disciplines into base workflow prompt"
```

### 任务 4：把 ReviewRouter 挂进 deliver_task 的 async execute（核心，无条件）

> **架构裁定（基于实读 2026-06-06）：不改 gate async。** `assess()`/`getReport()` 是同步的，改 async 会波及 `main.tsx` 与整个接口契约。但 `deliver-task.ts:142 async execute()` **本来就是 async**，`message`/`files`/`commit` 参数齐全（正好是 ChangeSet 来源），且**已在分层挂门禁**（commit-cohesion 是个 RED 门，见 `:287` 的拒绝模式）。所以 router 挂进 deliver_task，gate 不动——改动收敛在一个本就 async 的 handler。

**先读：** `src/agent/deliver-task.ts`（`:142 execute`、`:147 getReport`、`:287` RED 返回模式）、`src/agent/commit-cohesion.ts`（既有 RED 门怎么写）、`src/main.tsx:207`（gate/deliver_task 装配处）。

**文件：**
- 修改：`src/agent/deliver-task.ts`（`execute` 内 `commit===true` 分支，cohesion 检查前插 router 门）
- 修改：`src/agent/deliver-task.ts` deps 接口（注入 `reviewRouter` + `reviewDepth`）
- 测试：`src/agent/__tests__/deliver-task.test.ts`（追加）

- [ ] **步骤 1：编写失败的测试**

```typescript
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createDeliverTaskTool } from '../deliver-task.js'

// router 桩 + 最小 gate/ownership 桩（按 deliver-task.ts deps 接口补全）
function makeTool(routerStub: unknown, depth = 0) {
  return createDeliverTaskTool({
    gate: { assess: () => ({ state: 'GREEN' } as never), getReport: () => ({} as never) },
    routeReviewWorkflow: routerStub as never,
    reviewDepth: depth,
    /* commitOwnedFiles / dirtyFiles 等按需补桩 */
  } as never)
}

test('fix commit: router escalated → RED, commit not executed', async () => {
  let committed = false
  const tool = createDeliverTaskTool({
    gate: { assess: () => ({ state: 'GREEN' } as never), getReport: () => ({} as never) },
    routeReviewWorkflow: async () => ({ tier: 'L2', verdict: 'rejected', escalated: true, rounds: 3, evidence: 'still broken' }),
    reviewDepth: 0,
    commitOwnedFiles: () => { committed = true; return {} as never },
  } as never)
  const r = await tool.execute({ input: { commit: true, message: 'fix(server): H4 回归修复', files: ['x.ts'] } } as never)
  assert.match(JSON.stringify(r), /review|squadron|verifier/i)
  assert.equal(committed, false) // RED：不提交
})

test('fix commit: router verified → falls through to existing gate/commit', async () => {
  let routerCalled = false
  const tool = makeTool(async () => { routerCalled = true; return { tier: 'L2', verdict: 'verified', evidence: 'ran: npx test → ok', rounds: 1 } })
  await tool.execute({ input: { commit: true, message: 'fix: x', files: ['x.ts'] } } as never)
  assert.equal(routerCalled, true)
})

test('non-fix commit: router NOT invoked', async () => {
  let routerCalled = false
  const tool = makeTool(async () => { routerCalled = true; return { tier: 'L1', verdict: 'nudge' } })
  await tool.execute({ input: { commit: true, message: 'feat: add route', files: ['x.ts'] } } as never)
  assert.equal(routerCalled, false)
})

test('re-entrancy guard: reviewDepth>0 (子代理上下文) skips router', async () => {
  let routerCalled = false
  const tool = makeTool(async () => { routerCalled = true; return { tier: 'L2', verdict: 'verified', evidence: 'x' } }, 1)
  await tool.execute({ input: { commit: true, message: 'fix: x', files: ['x.ts'] } } as never)
  assert.equal(routerCalled, false) // 防审查自我递归
})
```

- [ ] **步骤 2：运行验证失败** — `npx tsx --test src/agent/__tests__/deliver-task.test.ts` → 新分支/deps 未实现。

- [ ] **步骤 3：编写最少实现**

```typescript
// deliver-task.ts —— deps 接口追加
import { routeReviewWorkflow, type ReviewRouterDeps } from './review-router.js'
import { isFixContext, type ChangeSet } from './review-discipline.js'

export interface DeliverTaskDeps {
  gate: DeliveryGateV2
  routeReviewWorkflow?: typeof routeReviewWorkflow  // 可注入（测试桩）
  reviewDeps?: ReviewRouterDeps                       // 真实 coordinator deps（任务5 提供）
  reviewDepth?: number                                // 重入护栏：子代理上下文 >0 时跳过
  // ...既有字段
}

// execute() 内，commit===true 分支，cohesion 检查之前：
if (params.input.commit && (ctx.reviewDepth ?? 0) === 0 && isFixContext(params.input.message ?? '')) {
  const change: ChangeSet = {
    files: params.input.files ?? ownedFiles,
    crossModule: isCrossModule(params.input.files ?? ownedFiles), // 见任务5 步骤0
    isFix: true,
  }
  const route = ctx.routeReviewWorkflow ?? routeReviewWorkflow
  const outcome = await route(change, ctx.reviewDeps!)
  if (outcome.escalated || outcome.verdict === 'rejected') {
    return redResult(  // 复用 deliver-task.ts:287 的 RED 返回模式
      `审查门 RED（${outcome.tier}）：${outcome.evidence ?? '未通过对抗审查'}\n` +
      `  → spawn adversarial_verifier 取命令+输出证据修复后，re-run deliver_task。`,
    )
  }
  // verified → 落入下方既有 cohesion/gate/commit 逻辑
}
```

> **重入护栏（任务4 最关键设计）：** router 会 spawn verifier/patcher 子代理；子代理若也调 deliver_task，会再触发 router → 审查自我递归。`reviewDepth` 由 spawn 子代理时 +1 注入（在任务5 的 `createCoordinatorReviewDeps` 里，spawn 时把 `reviewDepth: depth+1` 传进子代理 ctx）。`reviewDepth>0` → 跳过 router。参照 `immune-hook.ts` 的重入思路。

- [ ] **步骤 4：运行验证通过 + 回归既有 deliver-task 测试**

运行：`npx tsx --test src/agent/__tests__/deliver-task.test.ts`（**全量**——纪律3：改 X 跑覆盖 X 的既有测试，防相邻回归）
预期：新 4 测试 PASS，既有 deliver-task 测试不回归。

- [ ] **步骤 5：commit**

```bash
npm run typecheck && npx tsx --test src/agent/__tests__/deliver-task.test.ts
git add src/agent/deliver-task.ts src/agent/__tests__/deliver-task.test.ts
git commit -m "feat(agent): deliver_task routes fix commits through ReviewRouter (with re-entrancy guard)"
```

---

### 任务 5：ReviewRouter 的 spawn 依赖接到真实 coordinator + crossModule 判定（核心，无条件）

> 任务2 的 `spawnVerifier`/`spawnPatcher`/`spawnSquadron` 是注入抽象，本任务接真实 delegate 系统，并把任务5 的 deps + 任务4 的护栏 + crossModule 判定一次性接全。

**先读：** `src/agent/coordinator.ts`（`delegate`/work order 创建、worker 结果里 `evidenceStatus` 与命令+输出的形态）、`src/agent/profile-registry.ts:83`（`adversarial_verifier`）、确认有无 `patcher` profile（无则本任务先加，或复用通用 writer profile）。

- [ ] **步骤 0：crossModule 判定（待裁决规则，先给默认实现）**

```typescript
// review-discipline.ts 追加
/** 默认规则：owned files 落在 ≥2 个 src/<module>/ 顶层模块 → 跨模块 */
export function isCrossModule(files: readonly string[]): boolean {
  const modules = new Set(
    files.map(f => f.match(/(?:^|\/)src\/([^/]+)\//)?.[1]).filter(Boolean),
  )
  return modules.size >= 2
}
```
> ⚠️ 这是**待团队裁决**的默认规则（见决策表新增行）。若团队选别的口径（如按 import 图、按 owner），替换此函数即可，调用方不变。

- [ ] **步骤 1-2：测试** — 注入 fake coordinator，断言：`spawnVerifier` 产出 work order `profile==='adversarial_verifier'`；回报的 `verdict` 由 worker `evidenceStatus==='verified'` 映射；`evidence` 取自 worker 命令+输出；spawn 时 `reviewDepth` 递增传入子代理 ctx（护栏）。`isCrossModule(['src/a/x.ts','src/b/y.ts'])===true`、`(['src/a/x.ts','src/a/y.ts'])===false`。

- [ ] **步骤 3：实现** `createCoordinatorReviewDeps(coordinator, parentDepth)`：三个 spawn 映射到 `coordinator.delegate(...)`，profile 分别 `adversarial_verifier`/patcher/squadron；spawn 子代理时注入 `reviewDepth: parentDepth+1`；`evidence`/`verdict` 从 worker 结果的 `evidenceStatus` + 命令输出映射。

- [ ] **步骤 4：装配** — 在 `src/main.tsx:207`（deliver_task 装配处）用真实 coordinator 构造 `reviewDeps = createCoordinatorReviewDeps(coordinator, 0)`，注入 deliver_task ctx。

- [ ] **步骤 5：** 跑测试（含任务4 全量）+ typecheck + commit。

```bash
git commit -m "feat(agent): wire ReviewRouter to coordinator (adversarial_verifier/patcher/squadron) + crossModule"
```

---

### 任务 6 `[依赖裁决-C]`：开源默认姿态

> C=C1 → config 开关（默认开）；C=C2 → 注册为可选 skill；C=C3 → 仅文档，跳过代码。

- [ ] **C=C1 步骤：** 创建 `src/config/review-discipline-config.ts`，导出 `isReviewDisciplineEnabled()`（读 env `RIVET_REVIEW_DISCIPLINE`，默认 `true`）；deliver_task（任务4）在调 router 前查此开关，关闭时跳过审查门。测试覆盖开/关两态。commit。
- [ ] **C=C2 步骤：** 在 skill 注册表加 `review-discipline` skill，默认不启用，文档说明 opt-in 方式。
- [ ] **C=C3 步骤：** 仅在开源 README/CONTRIBUTING 写最佳实践，无代码任务。

---

### 任务 7（所有分叉）：开源文档

- [ ] 在 `docs/` 写一节「天枢审查纪律」，解释四条纪律的实证来源（引用 `2026-06-06-server-subsystem-go-live-gate.md` 与 `2026-06-06-review-squadron-design.md` §5），团队如何配置/扩展。commit。

---

## 决策记录

| 分叉 | 选项 | 决策 | 决策人/日期 | 理由 |
|------|------|------|-------------|------|
| 核心架构（原分叉 A 强制力） | 自动路由器 + 自动 spawn verifier + 自动闭环重审 | **已裁决** | 团队 / 2026-06-06 | 按规模分级、审查主体下沉子代理，主控只派单+看结论+闭环失败兜底 |
| B 注入面 | B1运行时hook / B2 static / B3不进提示词 | **B3 不进提示词** | 团队 / 2026-06-06 | 避免 static prompt 与 runtime hook 注入的 prefix-cache 代价；L1 nudge 由 router/tool 输出承载，L2/L3 靠子代理 objective 携带 |
| C 开源默认 | C1内置可关 / C2可插拔 / C3仅文档 | **待定** | | |
| crossModule 判定（任务5 步骤0） | 按 src/<module> 顶层目录跨度 / 按 import 图 / 按 owner | **待定（默认：≥2 个 src/<module>）** | | 已给默认实现 `isCrossModule`，团队可换口径，调用方不变 |

> 解锁规则：核心任务 1/2/4/5/7 无条件可执行（任务3 因 B=B3 跳过）；C 定后确定任务6形态；crossModule 用默认实现先行，团队裁决后替换 `isCrossModule` 即可。

---

## 自检结论

- **规格覆盖**：四条纪律 → 任务1（常量+识别+分级）；核心审查工作流 → 任务2（router+闭环）+任务4（gate 调 router）+任务5（接真实 coordinator）；L1 提示文本 → 任务3（B 决定形态）；开源默认 → 任务6（C 决定）；说明书 → 任务7。规模分级三档（L1/L2/L3）均有对应路由分支与测试。
- **占位符扫描**：任务2/4/5 的实现骨架明确标注「须对齐真实接口字段」「确认改 async 波及面」——因 `RuntimeHookSnapshot`/`DeliveryGateResult`/`coordinator.delegate` 真实签名需实现时读取，这是审慎的接口对齐提示，非 TODO 占位。
- **类型一致**：`ChangeSet`/`ReviewScale`/`classifyChangeScale` 任务1定义，任务2 一致引用；`VerifierResult`/`ReviewOutcome`/`routeReviewWorkflow` 任务2定义，任务4（gate 消费 outcome）、任务5（接 deps）一致引用；`isFixContext` 任务1定义，任务2/4 引用。
- **自洽性**：本计划自身遵守它要内化的纪律——任务4 步骤4 要求跑全量既有 gate 测试（纪律3）；推荐子代理驱动执行（纪律1 独立验证 pass）；闭环有界+每轮带证据（纪律2/4）。

---

## 执行交接

**计划已保存到 `docs/superpowers/plans/2026-06-06-review-discipline-internalization.md`。**

**⚠️ 核心架构已裁决（自动路由+自动 verifier+自动闭环），B 已裁决为 B3 不进提示词；仅 C 分叉待定。** 建议流程：
1. 核心任务 1/2/4/5/7 无条件可立即开始（按依赖顺序：1→2→4→5）。
2. 跳过任务3 / 任务1b（B3）；C 分叉团队商议后回填决策表，再定任务6（开源默认）形态。

两种执行方式：
1. **子代理驱动（推荐）** — 每任务一个新子代理 + 两阶段审查（恰好践行本计划要内化的纪律1：独立验证 pass，且任务2/4/5 涉及 coordinator 集成，子代理隔离更安全）。
2. **内联执行** — 当前会话用 executing-plans 批量执行并设检查点。

**当前执行入口：先完成核心任务 1+2；B3 已定，提示词/运行时 hook 注入暂不做。**

---

## 进度追踪（2026-06-06，对抗复核逐提交验证）

| 任务 | 状态 | 提交 / 落点 | 复核 |
|------|------|-------------|------|
| 任务1 纪律+识别+分级 | ✅ 已合 | `f9fc02b` | 实跑绿；`classifyChangeScale` L1/L2/L3 边界正确 |
| 任务2 ReviewRouter+有界闭环 | ✅ 已合 | `f9fc02b`→`e684b74` | `e684b74` 修了 M1（squadron findings 丢弃）+ L1（.json trivial）+ L2（patcher patched:false）；闭环 `Math.max(1,…)` 真有界；测试改为断言效果非调用 |
| 任务4 router 挂进 deliver_task | ✅ 已合 | `8381c8b` | RED `return isError` 在 commit 之前，真拦提交；未接 reviewDeps 时优雅 no-op |
| 任务5 接真实 coordinator + crossModule | ✅ 已合 | `b62d533` | deps 映射正确；**初版重入护栏只到 prompt 文本（M2 缺陷）** |
| 任务5 后续 · M2 重入护栏结构化 | 🔶 工作区未提交 | 17 文件 + `docs/reviews/2026-06-06-review-router-reentrancy-guard.md` | 数值 depth 结构性穿到子代理 deliver_task ctx；测试覆盖跨边界跳过；待 **scoped commit** |
| 任务3（L1 nudge 注入面） | ⏭️ 跳过 | — | B=B3 不进提示词 |
| 任务6（开源默认姿态） | ⏳ 待裁决 | — | C 分叉未定 |
| 任务7（开源文档） | ⏳ 未开始 | — | — |

**复核记录：** [`../../reviews/2026-06-06-review-router-reentrancy-guard.md`](../../reviews/2026-06-06-review-router-reentrancy-guard.md)（M2 修复 + 独立复核确认）。

**M2 提交注意：** 17 文件须显式列出，排除游离改动 `src/tools/plan-close.ts` / `src/tools/bash.ts` / `src/tools/gitignore.ts`（不属本次，勿 `git add .` 搭车）。

**已知既有失败（与本计划无关）：** `src/tools/__tests__/file-info.test.ts`（1）、`plan-close.test.ts`（3）——干净 HEAD 上即红，非 reviewDepth 回归。

