# T5×T2-03 P3 任务 · Authority → Model Tier Shadow

> 日期：2026-06-08  
> 性质：P3 核心任务包  
> 前置：P0 双影子层、P1 Reward Loop、P2 ModelG + PlanCache Advisory。  
> 目标：把“星域 / profile / 任务风险”转成模型 tier 推荐，先 shadow 对照 actual model，不默认改变真实 worker 选模。

---

## 0. 一句话

**P3 做 authority→model tier 的影子决策层：记录“这个任务按星域应使用 cheap / balanced / strong”，并与 coordinator 实际选到的模型对照；默认不切模型、不改 team 派发。**

P3 的价值是让“天权该不该 strong、天梁能不能 cheap、失败重试要不要升档”第一次变成可观测事实。

---

## 1. 前置闸

P3 开始前，P2 的修复应已完成：

1. `computeModelG()` 在运行时能消费 P1 reward summary，而不是只在测试里传 `historicalRewards`。
2. PlanCache advisory 保持 dynamic-only、短建议、非自动执行。
3. P2 仍不自动切模型。

如果第 1 条还没修完，P3 仍可做 tier shadow，但不能声称“reward-informed”。

---

## 2. 范围

### 做

1. 新建 `model-tier-policy.ts`
   - 输入：`authority`、`profile`、`kind`、`riskTier`、`objective`、可选失败计数。
   - 输出：推荐 tier、原因、是否 hard floor。

2. 在 coordinator / team 侧记录 tier shadow
   - 每个 worker order 记录：recommendedTier、actualModel、actualTier、matched、reason。
   - append-only 落 MeridianDb：`model_tier_shadow:{sessionId}:{workOrderId}:{timestamp}`。

3. 把 tier shadow 汇入 team telemetry / reward closure 的后续可消费字段
   - P3 只记录，不让 reward 反向影响行为。

4. 补测试
   - tier policy 表。
   - shadow-only 不改变 selectedModel。
   - reviewer / verifier 不会被推荐 cheap。
   - append-only key。

### 不做

- 不默认切换 worker 模型。
- 不改 `groupTeamTasks()`。
- 不改 team wave 依赖 / 并行规则。
- 不让 bandit 影响 tier；这是 P4。
- 不让成本覆盖 false-green 风险。
- 不把 authority prompt 和 model tier 绑死成不可配置常量；P3 只给第一版 policy。

---

## 3. 第一版 tier policy

| 输入 | 推荐 tier | 说明 |
|---|---|---|
| `authority=tianquan` + `reviewer` / `adversarial_verifier` | `strong` | 审查 false-green 成本最高，不能为省钱降级 |
| `kind=verify` / `profile=verifier` | `strong` | 验证失败解释和修复判断需要强模型 |
| `authority=tianfu` | `balanced`；高风险时 `strong` | 风险守门默认不 cheap |
| `authority=tianxuan` + planning/exploration | `balanced`；复杂任务 `strong` | 挑战者需要足够推理能力 |
| `authority=tianliang` + low-risk patcher | `cheap` 或 `balanced` | 执行星域可省，但高风险不 cheap |
| `code_scout` / `doc_scout` | `cheap` | 只读探索可省 |
| repeated failure / escalation | `strong` | 连续失败后升档 |

建议接口：

```ts
export interface ModelTierPolicyInput {
  authority?: string
  profile: WorkerProfile
  kind: WorkOrderKind
  riskTier?: 'low' | 'medium' | 'high'
  objective: string
  consecutiveFailures?: number
}

export interface ModelTierRecommendation {
  tier: 'cheap' | 'balanced' | 'strong'
  reason: string
  hardFloor?: 'balanced' | 'strong'
}
```

---

## 4. Shadow event

```ts
export interface ModelTierShadowEvent {
  schemaVersion: 1
  sessionId: string
  workOrderId: string
  authority?: string
  profile: string
  kind: string
  recommendedTier: 'cheap' | 'balanced' | 'strong'
  actualModel: string
  actualTier: 'cheap' | 'balanced' | 'strong'
  matched: boolean
  reason: string
  timestamp: number
}
```

KV key：

```text
model_tier_shadow:{sessionId}:{workOrderId}:{timestamp}
```

若 workOrderId 可能重复，timestamp 必须保留，保持 append-only。

---

## 5. 实施步骤

### P3a — 纯 tier policy

文件：

- `src/agent/model-tier-policy.ts`
- `src/agent/__tests__/model-tier-policy.test.ts`

验收：

- 天权 reviewer → strong。
- verifier → strong。
- 天梁 low-risk patcher → cheap/balanced。
- high-risk patcher 不推荐 cheap。
- repeated failure → strong。

### P3b — coordinator shadow 接线

文件：

- `src/agent/coordinator.ts`
- `src/agent/model-tier-shadow.ts`
- `src/agent/__tests__/coordinator*.test.ts` 或新建 `model-tier-shadow.test.ts`

做法：

- `selectModelForTask()` 仍按现有路由选 actual model。
- 在 actual model 选出后，计算 tier recommendation。
- 记录 shadow，不改变返回的 `selectedModel`。

验收：

- 构造推荐 strong、actual cheap 的场景，断言 actual 仍是原模型。
- shadow event 记录 mismatch。
- store 缺失 / 抛错不影响 worker dispatch。

### P3c — team telemetry 汇总

文件：

- `src/agent/team-wave-telemetry.ts`
- `src/agent/reward-loop.ts`（只加字段透传，不改 reward 公式）

做法：

- `TeamWaveTelemetry.workerModels` 可补充 `recommendedTier/actualTier/matched`，或新增 `workerModelTierShadows`。
- P3 不直接惩罚 mismatch；只给 P4 reward/gate 使用。

验收：

- team wave telemetry 能看到 per-worker tier shadow。
- 不影响 existing `workerModels` 消费者。

---

## 6. 验证命令

```bash
npm exec -- tsx --test src/agent/__tests__/model-tier-policy.test.ts
npm exec -- tsx --test src/agent/__tests__/model-tier-shadow.test.ts
npm exec -- tsx --test src/agent/__tests__/coordinator.test.ts src/agent/__tests__/team-wave-telemetry.test.ts
npx tsc --noEmit
```

如果实际测试拆分不同，以新增文件为准；最少覆盖 policy、shadow-only、telemetry 三类。

---

## 7. 天权称量

P3 的主梁是：**把“谁该用什么 tier”变成事实表，而不是立刻变成路由权力。**

P3 完成后应能回答：

- 天权审查是否仍在实际使用 cheap？
- 天梁 patcher 在哪些任务上 cheap 足够，哪些任务需要 balanced？
- high-risk / repeated failure 是否被 tier policy 正确标成 strong？
- actual model 与 recommended tier 的 mismatch 分布如何？

这些答案出来后，P4 才能做 gated influence / bandit / model tier 自动化。P3 不急着赢成本，先赢归因。
