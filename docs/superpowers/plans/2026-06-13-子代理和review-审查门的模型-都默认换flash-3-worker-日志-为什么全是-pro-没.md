# Worker + Review 模型默认换 Flash

> **面向 AI 代理：** 使用 subagent-driven-development（推荐）或 executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 所有 worker（子代理）和 review 审查门默认使用 Flash 模型（`deepseek-v4-flash`），替代当前全部走 Pro 的行为。

**架构：** 根因在 `coordinator.ts:812` — 模型 tier 推荐已正确计算但被 bandit gate 拦截（shadow-only），从未真正约束模型选择。修复分两步：1）让 tier 推荐始终生效（穿通 coordinator 的 gate），2）将默认 tier 从 `balanced` 改为 `cheap`。

**技术栈：** TypeScript strict，node:test + assert/strict

---

## 1. Scope Check

单子系统，只涉及模型选择路径：

- **修改**：`src/agent/coordinator.ts`（选模型入口）、`src/agent/model-tier-policy.ts`（tier 规则 + 默认值）、`src/agent/profile-registry.ts`（reviewer tierLock）
- **测试**：`src/agent/__tests__/model-tier-policy.test.ts`
- **不变**：`src/model/capability.ts`（模型评分逻辑不动）、`src/bootstrap.ts`（modelCards 不动）、`src/agent/model-tier-bandit.ts` / `model-tier-gate.ts`（bandit 审计保持 shadow-only）、Flash→Pro 升级重试路径（`coordinator.ts:935-1020`）

## 2. 调研背书

### 2.1 现状：为什么 100% worker 走 Pro

```
delegate_task → coordinator.delegate() → delegateOrder()
  ├─ buildTierRecommendation() → recommendModelTier() → 返回 { tier: 'cheap'|'balanced'|'strong' }
  ├─ evaluateTierInfluence() → 包裹进 bandit gate
  └─ selectModelForTask(task, gate.applied ? effectiveTier : undefined)
       └─ gate.applied === false（modelTierBanditEnabled: false）
            → preferredTier = undefined
            → 所有 modelCards 参与评分
            → recommendModelForTask() 按能力分排序 → Pro 永远最高分 → 100% Pro
```

**调用方**：`coordinator.ts:810-812`（`delegateOrder` 方法，所有单个 worker 派发走这里）。`delegateBatch` 内部循环调 `delegateOrder`。

**commit 历史**：tier bandit 引入时设计为 shadow-only（`modelTierBanditEnabled` 默认 false），把 tier 推荐挡在 gate 后面。当时意图是收集数据后再开——但数据永远没开。

**边界风险**：穿通 tier 推荐后，`recommendModelTier()` 的返回值直接决定模型 tier。需确保：
- high-risk 工作仍走 `strong`（已由 `riskTier === 'high'` 规则覆盖，L78-82）
- 连续失败升级仍走 `strong`（`consecutiveFailures >= 2`，L44-46）
- 天权/天府/天璇域特殊规则保持（L45-70，各域有自己的 tier 规则）

### 2.2 `tianquan` false-green hard floor（model-tier-policy.ts:45-49）

```typescript
if ((authority === 'tianquan' || authority === '天权') &&
    (input.profile === 'reviewer' || input.profile === 'adversarial_verifier')) {
    return { tier: 'strong', hardFloor: 'strong', reason: 'tianquan reviewer/verifier has false-green hard floor' }
}
```

**调用方**：`team-orchestrator.ts:75` 的 `taskAuthority()` → `task.profile === 'reviewer' || 'adversarial_verifier' → 'tianquan'`。`review-coordinator-deps.ts:79-95` 的 `request()` 不设 authority——review gate 的 reviewer worker 走默认路径。

**存在理由**：历史上担心审查代理用 cheap 模型会漏掉 false-green 问题。但如今 Flash 模型在 review 场景的 cache 命中率与 Pro 相同（97.9%–99.6%），且 review 本身是 read-only 工作，不需要 Pro 级的 reasoning。

**边界风险**：移除后，reviewer 的 tier 由后续规则决定：
- `tierLock: 'cheap'`（新增）→ 直接返回 cheap，不再进入 authority 检查
- adversarial_verifier → L51-53 `kind === 'verify' || profile === 'adversarial_verifier'` → cheap

### 2.3 默认 tier 从 `balanced` 改为 `cheap`（model-tier-policy.ts:85）

```typescript
return { tier: 'balanced', reason: 'default worker tier is balanced' }
```

**影响面**：所有没有特殊规则匹配的 worker（当前占 100%，因为没有特殊规则命中）：
- `code_scout`（无 authority）→ 之前走 L67-68 的 isExploration → cheap（不变）
- `reviewer`（无 authority）→ 之前走默认 balanced → Pro，改为 cheap → Flash
- `patcher`（无 authority、无风险标签）→ 之前 balanced → Pro，改为 cheap → Flash
- `planner`（无 authority）→ 之前 isExploration → cheap（不变）

**安全性**：`recommendModelTier()` 中更高优先级的规则（高风险、连续失败、天权/天府/天璇域）在默认规则之前检查。只有真正"无特殊匹配"的 worker 受此变更影响——这正是我们想改的。

## 3. 变更清单

| 文件 | 变更 | 行号 |
|------|------|------|
| `src/agent/coordinator.ts` | `selectModelForTask` 始终传入 `tierRecommendation.tier`（不经过 gate） | L812 |
| `src/agent/model-tier-policy.ts` | 删除 tianquan false-green hard floor | L45-49 |
| `src/agent/model-tier-policy.ts` | 默认 tier `balanced` → `cheap` | L85 |
| `src/agent/profile-registry.ts` | reviewer 添加 `tierLock: 'cheap'` | L87 附近 |
| `src/agent/profile-registry.ts` | adversarial_verifier 添加 `tierLock: 'cheap'` | L118 附近 |
| `src/agent/__tests__/model-tier-policy.test.ts` | 更新 tianquan 测试 + 新增默认 cheap 测试 | — |

## 4. 任务分解

### Task 1: 穿通 tier 推荐 — coordinator.ts

**文件**：`src/agent/coordinator.ts:812`

**当前**：
```typescript
let selected = this.selectModelForTask(task, tierInfluence.gate.applied ? tierInfluence.gate.effectiveTier : undefined)
```

**改为**：
```typescript
let selected = this.selectModelForTask(task, tierRecommendation.tier)
```

**理由**：`tierRecommendation` 来自 `recommendModelTier()`，已经综合了 profile、authority、riskTier、consecutiveFailures 等所有因素。bandit gate 的 `effectiveTier` 是在此基础上的微调——但现在 gate 永远是 shadow。让 tier 推荐直接约束模型选择，bandit 继续以 shadow 模式运行审计。

**验证**：暂不单独验证，等 Task 3 的 tier 规则改完后一起跑测试。

**提交**：`fix(agent): always apply tier recommendation to model selection`

---

### Task 2: 添加 tierLock 到 reviewer + adversarial_verifier

**文件**：`src/agent/profile-registry.ts`

**reviewer profile（~L87）**：在 `builtIn: true,` 前插入 `tierLock: 'cheap',`

**adversarial_verifier profile（~L118）**：在 `builtIn: true,` 前插入 `tierLock: 'cheap',`

**理由**：`tierLock` 是 profile 级别的硬约束——在任何 authority/riskTier 检查之前返回。belt-and-suspenders：即使 authority 逻辑有变化，reviewer 也永远不会升级到 Pro。

**提交**：`feat(agent): add tierLock cheap to reviewer and adversarial_verifier profiles`

---

### Task 3: 改默认 tier + 删 tianquan hard floor

**文件**：`src/agent/model-tier-policy.ts`

**3a. 删除 tianquan false-green hard floor（L45-49）**：
删除以下代码块：
```typescript
if ((authority === 'tianquan' || authority === '天权') &&
    (input.profile === 'reviewer' || input.profile === 'adversarial_verifier')) {
    return { tier: 'strong', hardFloor: 'strong', reason: 'tianquan reviewer/verifier has false-green hard floor' }
}
```

**3b. 改默认 tier（L85）**：
```typescript
// 当前
return { tier: 'balanced', reason: 'default worker tier is balanced' }
// 改为
return { tier: 'cheap', reason: 'default worker tier is cheap (flash model)' }
```

**理由**：
- 3a：reviewer/adversarial_verifier 已有 `tierLock: 'cheap'`（Task 2），此规则成为死代码。且 adversarial_verifier 已由 L51-53 的 `kind === 'verify' || profile === 'adversarial_verifier' → cheap` 覆盖。
- 3b：所有无特殊规则的 worker 默认走 Flash。高风险/连续失败/天权天府天璇域仍然走 strong/balanced。

**验证**：更新测试后一起跑。

**提交**：`feat(agent): default worker tier to cheap, remove tianquan hard floor`

---

### Task 4: 更新测试

**文件**：`src/agent/__tests__/model-tier-policy.test.ts`

**4a. 删除 tianquan strong 测试（L6-27）**：
删除 `'forces tianquan reviewer and adversarial verifier to strong'` 整个测试。

**4b. 新增默认 cheap 测试**：
```typescript
it('defaults to cheap tier for unremarkable profiles', () => {
  assert.equal(recommendModelTier({
    profile: 'reviewer',
    kind: 'review',
    objective: 'review a simple change',
  }).tier, 'cheap')
})

it('default reviewer without tianquan authority gets cheap tier', () => {
  // reviewer has tierLock: 'cheap' — this should win regardless of authority
  assert.equal(recommendModelTier({
    authority: 'tianquan',
    profile: 'reviewer',
    kind: 'review',
    objective: 'review false-green risk',
  }).tier, 'cheap')
})

it('patcher without risk tier defaults to cheap', () => {
  assert.equal(recommendModelTier({
    profile: 'patcher',
    kind: 'patch_proposal',
    objective: 'small localized patch',
  }).tier, 'cheap')
})
```

**4c. 保留的测试**：
- `'routes verifier work to cheap'` — 不变（L51-53 规则仍有效）
- `'allows low-risk tianliang patcher to be cheap but not high-risk patcher'` — 不变
- `'escalates repeated failures to strong'` — 不变
- `'infers actual model tier from capability cards'` — 不变

**提交**：`test(agent): update tier policy tests for cheap default`

---

## 5. 验证

```bash
# typecheck
npx tsc --noEmit

# 运行 tier policy 测试
npm exec -- tsx --test src/agent/__tests__/model-tier-policy.test.ts

# 预期：5 passed（删除 1 个 + 新增 3 个 = 净增 2 个，共 5 个）

# 运行 profile registry 相关测试
npm exec -- tsx --test src/agent/__tests__/profile-registry.test.ts
```

**手动验证要点**：
1. `recommendModelTier({ profile: 'reviewer', kind: 'review', objective: 'test' })` → `{ tier: 'cheap' }`
2. `recommendModelTier({ profile: 'adversarial_verifier', kind: 'verify', objective: 'test' })` → `{ tier: 'cheap' }`
3. `recommendModelTier({ profile: 'patcher', kind: 'patch_proposal', objective: 'test' })` → `{ tier: 'cheap' }`
4. `recommendModelTier({ profile: 'code_scout', kind: 'code_search', objective: 'test', consecutiveFailures: 2 })` → `{ tier: 'strong', hardFloor: 'strong' }`（升级仍有效）
5. `recommendModelTier({ authority: 'tianquan', profile: 'reviewer', kind: 'review', objective: 'test' })` → `{ tier: 'cheap' }`（tierLock 覆盖 tianquan）

---

## 6. 自检

### 6.1 Spec 覆盖

| 需求 | 任务 | 验证 |
|------|------|------|
| Worker 默认 Flash | Task 3b（默认 tier cheap） | Task 4 测试 + 手动验证 |
| Review 审查门默认 Flash | Task 2（tierLock cheap） + Task 3a（删 tianquan hard floor） | Task 4 测试 |
| 高风险 worker 仍走 Pro | 不改（riskTier='high' → strong 规则保留） | 已有测试保留 |
| 连续失败升级仍有效 | 不改（consecutiveFailures>=2 → strong 保留） | 已有测试保留 |
| 天权/天府/天璇域不受影响 | 不改（各域检查在默认之前） | 已有规则保留 |

### 6.2 占位符扫描

无 TODO/TBD/待定/后续实现。

### 6.3 类型一致性

- `tierLock` 类型：`ModelTier`（`'cheap' | 'balanced' | 'strong'`）— `profile-registry.ts:44` 已定义
- `recommendModelTier()` 返回 `ModelTierRecommendation` — 不变
- `selectModelForTask()` 接受 `ModelTier | undefined` — 现在始终传入 `ModelTier`
- 所有签名/路径跨任务一致

---

## 7. 执行交接

计划已完成并保存到 `docs/superpowers/plans/2026-06-13-子代理和review-审查门的模型-都默认换flash-3-worker-日志-为什么全是-pro-没.md`。四种执行方式：

1. **子代理驱动（推荐）** — 每个任务调度一个新的子代理，任务间进行审查，快速迭代
2. **内联执行** — 在当前会话中使用 executing-plans 执行任务，批量执行并设有检查点
3. **团队编排** — `team_orchestrate` 多波次派发，适合跨模块改动
4. **手动逐任务** — 在当前会话中逐步执行，每步提交

选哪种方式？
