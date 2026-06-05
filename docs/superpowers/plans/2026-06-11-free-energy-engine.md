# 自由能引擎 (Free Energy Engine) — 实施计划

> Phase B of `cross-system-synergy-ideas.md` 联动 #1
> 前置依赖：Phase A 具身认知闭环 ✅ 已完成
> 状态：✅ 已完成 (2026-06-11)
> 预估：~7.5h，4 个文件，可拆成 4 个独立提交

## 目标

将现有子系统（PredictionAccumulator、Vigor、Theta、CognitiveSeason）重新诠释为 Karl Friston 自由能框架的组件，用 Expected Free Energy (EFE) 统一"下一步做什么"的决策——不再只是被动反应，而是主动推理最优行动。

## 前置依赖

| 子系统 | 当前状态 | 说明 |
|--------|---------|------|
| PredictionAccumulator | ✅ `src/agent/prediction-error.ts` | 需扩展 EFE 计算 |
| VigorState | ✅ `src/agent/vigor.ts` | gamma/precision 角色 |
| ThetaState (相位) | ✅ `src/agent/star-event.ts` | 层级推断时钟 |
| CognitiveSeason | ✅ `src/agent/cognitive-season.ts` | pragmatic vs epistemic 权重 |
| Sensorium | ✅ `src/agent/sensorium.ts` | 环境感知输入 |
| Meridian Graph | ✅ `src/repo/meridian-db.ts` | generative model (A/B 矩阵) |
| Affordance Engine | ✅ Phase A 交付 | 工具基础 affordance |

## 理论映射

| Active Inference 概念 | 天枢子系统 | 映射方式 |
|----------------------|-----------|---------|
| Variational Free Energy (F) | PredictionAccumulator | prediction error 加权累积 ≈ F |
| Generative Model (A,B,C,D) | Meridian Graph + context | 知识图谱=A/B矩阵；task goals=C |
| Expected Free Energy G(π) | **新建 policy-selection.ts** | 下一步 tool call 选择 = argmin G |
| Precision (γ) | Vigor.energy | 高 vigor = 高 precision = exploitation |
| Epistemic Value | Theta phase ENCODING | theta-gamma 耦合驱动信息搜索 |
| Pragmatic Value | CognitiveSeason | harvest=高 pragmatic; explore=高 epistemic |

## 实现步骤

### Step B1：EFE 计算核心（~2h）

**文件**：`src/agent/prediction-error.ts`（扩展）

在现有 `PredictionAccumulator` 基础上增加 EFE 计算：

```typescript
// 新增导出
export interface EFEComponents {
  /** 信息增益预期：减少不确定性的价值 */
  epistemicValue: number
  /** 目标推进预期：向目标前进的价值 */
  pragmaticValue: number
  /** 探索奖励：缓解 stagnation 的新颖性 bonus */
  noveltyBonus: number
  /** 置信度加权：precision = f(vigor) */
  precision: number
}

export function computeEFE(
  acc: PredictionAccumulator,
  season: CognitiveSeason,
  vigor: VigorState,
  sensorium?: Sensorium,
): EFEComponents
```

**计算逻辑**：

```
epistemicValue = (1 - confidence) × encodingBonus
  - 低 confidence → 高 epistemic value（需要探索）
  - theta=ENCODING → encodingBonus=1.0，RETRIEVAL → 0.3

pragmaticValue = confidence × vigorEnergy × seasonFactor
  - 高 confidence + 高 vigor → 高 pragmatic value（可以执行）
  - wuwei 季节 → seasonFactor=0.3（无为）
  - genesis 季节 → seasonFactor=0.5（探索为主）

noveltyBonus = freshnessInv × curiosity
  - 新鲜感低 → 鼓励尝试新工具/路径
  - curiosity 来自 Vigor.curiosity

precision = clamp(vigor.vigor, 0.3, 1.0)
  - 高 precision → 行为确定性高（exploitation）
  - 低 precision → 行为随机性高（exploration）
```

**测试**：`src/agent/__tests__/prediction-error.test.ts`（扩展，+5 测试用例）

---

### Step B2：Softmax 动作选择（~2h）

**文件**：`src/agent/policy-selection.ts`（新建）

基于 EFE 计算每个候选动作的期望自由能，通过 softmax 产生概率分布。

```typescript
export interface PolicyOption {
  toolName: string
  /** Expected Free Energy G(π) — 越低越好 */
  expectedFreeEnergy: number
  /** softmax 概率 */
  probability: number
}

export function selectPolicy(
  efe: EFEComponents,
  affordances: Record<string, AffordanceScore>,
  options?: { temperature?: number; topK?: number },
): PolicyOption[]
```

**核心公式**：

```
G(π_i) = -(epistemicValue × affordance_i.epistemic 
          + pragmaticValue × affordance_i.instrumental)

p(π_i) = softmax(-G(π_i) / temperature)
temperature = 1 / precision
```

**关键设计决策**：
- 不替代 LLM 决策——policy 结果作为 `<policy-guidance>` 块注入 context
- temperature 由 precision（vigor）驱动：高 vigor → 低温 → 确定性选择
- topK=5 默认，避免信息过载

**测试**：`src/agent/__tests__/policy-selection.test.ts`（新建，~8 测试用例）

---

### Step B3：感知-行动闭环（~2h）

**文件**：`src/agent/turn-perception.ts`（修改）

在现有 perception pipeline 中接入 EFE 计算，形成"感知→推理→行动→反馈"闭环。

```typescript
// 在 turn-perception.ts 的 PerceptionResult 中新增字段
export interface PerceptionResult {
  // ... existing fields ...
  
  /** EFE 计算结果（可选，仅当 accumulator 就绪时） */
  efe?: EFEComponents
  
  /** 策略排序结果（可选） */
  policyRanking?: PolicyOption[]
}
```

**数据流**：

```
工具执行结果
  → PredictionAccumulator.recordPrediction(correct)
  → computeEFE(acc, season, vigor, sensorium)
  → selectPolicy(efe, affordances)
  → 注入 <policy-guidance> XML 块到 volatile context
  → 下一轮 LLM 看到认知状态 + 策略建议
```

**注入点**：与 Phase A 的 `affordanceHint` 并列，新增 `policyGuidance` 字段。

**修改范围**：
- `src/agent/turn-perception.ts`：PerceptionResult 扩展 + EFE 计算调用
- `src/prompt/volatile.ts`：`VolatileContext` 新增 `policyGuidance` 字段（+3 行）
- `src/prompt/engine.ts`：`setPolicyGuidance()` setter + dynamicCtx 展开（+4 行）
- `src/agent/loop.ts`：感知后调用 `setPolicyGuidance()`（+6 行）

---

### Step B4：Sensorimotor 学习（~1.5h）

**文件**：`src/repo/meridian-db.ts`（扩展）

记录 `(context_signature, tool_name, outcome)` 三元组，驱动 affordance 自适应更新。

```typescript
// 新增表
CREATE TABLE IF NOT EXISTS sensorimotor_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  context_hash TEXT NOT NULL,    -- SHA256(sensorium + season + vigor)
  tool_name TEXT NOT NULL,
  success INTEGER NOT NULL,      -- 0 or 1
  duration_ms INTEGER,
  turn INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_sm_context ON sensorimotor_log(context_hash, tool_name);

// 新增方法
export function recordSensorimotorExperience(
  db: any,
  contextSignature: string,
  toolName: string,
  success: boolean,
  durationMs: number,
  turn: number,
): void

export function getToolSuccessRate(
  db: any,
  toolName: string,
  recentWindow?: number,
): number | null
```

**集成点**：在 `tool-execution.ts` 的工具执行完成后调用 `recordSensorimotorExperience()`。

**自适应更新**：定期（每 N 轮）根据 sensorimotor 历史微调 toolAffordanceRegistry 的基础值，使 affordance 随经验进化。

---

## 执行顺序

```
B1 (EFE 计算) → B2 (动作选择) → B3 (闭环注入) → B4 (学习)
```

每个步骤独立可验证、独立可提交。

## 文件清单

| 文件 | 改动类型 | Step |
|------|---------|------|
| `src/agent/prediction-error.ts` | 扩展 | B1 |
| `src/agent/__tests__/prediction-error.test.ts` | 扩展 | B1 |
| `src/agent/policy-selection.ts` | **新建** | B2 |
| `src/agent/__tests__/policy-selection.test.ts` | **新建** | B2 |
| `src/agent/turn-perception.ts` | 修改 | B3 |
| `src/prompt/volatile.ts` | 修改 (+3 lines) | B3 |
| `src/prompt/engine.ts` | 修改 (+4 lines) | B3 |
| `src/agent/loop.ts` | 修改 (+6 lines) | B3 |
| `src/repo/meridian-db.ts` | 扩展 | B4 |

## 风险与注意

1. **Prefix cache 安全**：policy guidance 和 affordance hint 一样，必须只在 dynamic appendix 中渲染，绝不能进入 stable volatile block
2. **不替代 LLM 决策**：EFE 输出是 guidance hint，不是强制 policy——LLM 始终保留自主选择权
3. **空状态处理**：首次运行时 sensorium/vigor/season 可能为 null，EFE 计算需优雅降级
4. **Meridian 依赖**：B4 依赖 better-sqlite3，需确认可选化方案（已完成）在 sensorimotor 写入时正常降级

---

## 执行记录

> 2026-06-11 全部完成，5 个提交

| Commit | Step | 内容 |
|--------|------|------|
| `e701756` | B1 | EFE 计算核心 — `computeEFE()` + 扩展 `prediction-error.ts` |
| `7f38363` | B2 | Softmax 动作选择 — `selectPolicy()` + `renderPolicyGuidance()` |
| `e55aa07` | B3 | 感知-行动闭环 — volatile/engine 注入 policy guidance |
| `ca57501` | B3 fix | loop.ts 策略引导注入点修正 |
| `576cbe6` | B4 | Sensorimotor 学习 — `meridian-db.ts` 扩展 sensorimotor_log 表 |

**数据流**：工具执行 → `recordPrediction()` → `computeEFE()` → `selectPolicy()` → `<policy-guidance>` 注入 context → 下一轮 LLM 参考。

**Phase A+B 合计**：6 个新文件，4 个修改文件，63 个测试全部通过。~11.5h 计划 → 实际 5 个提交组。
