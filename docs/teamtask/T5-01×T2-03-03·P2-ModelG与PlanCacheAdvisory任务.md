# T5×T2-03 P2 任务 · ModelG 与 PlanCache Advisory

> 日期：2026-06-08  
> 性质：P2 核心任务包  
> 前置：P0 双影子层已交付；P1 Reward Loop 已交付并复盘。  
> 目标：把 P1 的 reward closure 变成模型路由的可消费信号，同时把 PlanCache 以短建议形式接入 planning context；仍不改变真实模型选择与 team 调度。

---

## 0. 一句话

**P2 做两个消费者：`computeModelG()` 产出 shadow-only 模型推荐；`PlanCache advisory` 产出短 planning 建议。两者都只提供上下文/遥测，不自动执行、不切模型、不改 team 派发。**

P2 不是“自动路由上线”，而是把 P0/P1 的数据第一次接到可推理的消费侧。

---

## 1. P2 边界

### 做

1. 新建 `model-policy-selection.ts`
   - 定义 `ModelPolicyCandidate`。
   - 实现 `computeModelG()` / `selectModelPolicy()`。
   - 复用 EFE / Sensorium / ModelCapabilityCard / P1 reward summary。
   - 输出 `efeRecommendedModel`，写入 routing shadow。

2. 接通 routing shadow 的 EFE 推荐字段
   - 当前 `ModelRoutingShadowEvent` 已有 `efeRecommendedModel?: string`。
   - P2 只把推荐写进去，不调用 `onModelSwitch`。

3. 接通 PlanCache advisory
   - 复用 `P3Integration.planCacheSuggest()`。
   - 只生成短建议给 planner / 主循环 context。
   - 不调用 `tryJIT()`，不自动执行任何工具序列。

4. 补测试
   - model G 排序测试。
   - shadow-only 不切模型测试。
   - PlanCache advisory 短建议测试。
   - 不改 `computeEFE()` 签名/语义的回归测试。

### 不做

- 不自动切模型。
- 不改 `computeEFE()`。
- 不改 `groupTeamTasks()`。
- 不接 bandit gate。
- 不做 authority→model tier 真路由；那是 P3。
- 不把 `UnifiedTeamPlan` / `TeamWave` 塞进 `PlanCache`。
- 不让 AgentJIT 执行 PlanCache 命中。

---

## 2. 任务拆分

## P2a — ModelG 纯函数与 shadow 推荐

### 文件

- 新建：`src/agent/model-policy-selection.ts`
- 新建测试：`src/agent/__tests__/model-policy-selection.test.ts`
- 修改：`src/agent/loop.ts`

### 核心接口

```ts
export interface ModelPolicyCandidate {
  model: string
  tier: 'cheap' | 'balanced' | 'strong'
  estimatedCost: number        // normalized 0..1, missing = neutral
  estimatedLatency: number     // normalized 0..1, missing = neutral
  predictedSuccess: number     // 0..1
  riskFit: number              // 0..1
  authorityFit?: number        // P3 才真正使用；P2 可保留字段
  historicalReward?: number    // -1..1, 来自 P1 reward summary，缺失为 0
}
```

```ts
export function computeModelG(input: {
  candidate: ModelPolicyCandidate
  efe: EFEComponents
  sensorium: Pick<Sensorium, 'complexity' | 'pressure' | 'confidence' | 'stability'>
}): number
```

### 评分原则

G 越低越好：

```text
G(model) =
  - epistemicNeed * predictedSuccess
  - pragmaticNeed * riskFit
  - rewardWeight * historicalReward
  + costWeight * estimatedCost
  + latencyWeight * estimatedLatency
  + riskPenalty * failureRisk
```

硬门：

```text
failureRisk / false-green 相关惩罚 > cost advantage
```

P2 可以先用固定权重，不训练。

### 验收

- 低复杂度、高 confidence、低 pressure 时 cheap 可以排前。
- 高复杂度、低 confidence、高 pressure 时 strong 应排前。
- 历史 reward 为负时，该 candidate 排名下降。
- cost 优势不能覆盖明显 failure risk。
- 所有分值 clamp，输出稳定排序。

---

## P2b — routing shadow 接入 `efeRecommendedModel`

### 文件

- 修改：`src/agent/loop.ts`
- 可能修改：`src/agent/model-routing-shadow.ts` 测试，不改 schema 主体。

### 当前事实

- `ModelRoutingShadowEvent` 已支持 `efeRecommendedModel?: string`。
- `recordModelRoutingShadow()` 当前只写 legacy 推荐和 current model。

### 改法

在 `recordModelRoutingShadow()` 附近计算：

```ts
const efeRecommendedModel = selectModelPolicy(...).model
```

然后传给：

```ts
buildModelRoutingShadowEvent({ ..., efeRecommendedModel })
```

### 验收

- 构造 `efeRecommendedModel !== currentModel`，断言 `onModelSwitch` 调用次数仍为 0。
- routing shadow JSON 中出现 `efeRecommendedModel`。
- `currentModel` 不变。
- prompt 不因模型推荐变化而变大段内容；这里只是 telemetry。

---

## P2c — PlanCache Advisory

### 文件

- 修改：`src/agent/loop.ts` 或现有主循环 context 注入点。
- 可能修改：`src/prompt/engine.ts`，按现有 `setPolicyGuidance()` 模式新增轻量 setter。
- 新建测试：`src/agent/__tests__/plan-cache-advisory.test.ts` 或扩展 `p3-integration.test.ts`。

### 当前事实

`P3Integration.planCacheSuggest()` 已存在，且输出明确标注：

```text
Informational only — not auto-executed.
```

但主循环尚未消费。

### 改法

- 每轮开始或 policy guidance 更新附近调用：

```ts
const suggestion = this.p3.planCacheSuggest(this.initialUserMessage ?? currentTask)
```

- 有命中时只注入短 advisory block：

```xml
<plan-cache-advisory>
曾有相似已成功任务。建议优先检查：...
Informational only — not auto-executed.
</plan-cache-advisory>
```

### 限制

- 建议长度上限：建议 800 字符以内。
- 只读提示，不生成工具调用。
- 不调用 `tryJIT()`。
- 不写入 stable prompt；只进 volatile / current-turn guidance。

### 验收

- PlanCache miss：不注入任何 advisory。
- PlanCache hit：注入短 advisory，包含 `Informational only`。
- 命中包含写工具步骤时，也只能展示，不执行。
- 不改变 tool selection / model selection 的代码路径。

---

## 3. 推荐执行顺序

1. **先做 P2a 纯函数**  
   不接运行时，先把 ModelG 排序逻辑测实。

2. **再做 P2b shadow 接线**  
   只把推荐写进 routing shadow，验证不切模型。

3. **最后做 P2c PlanCache advisory**  
   注入短建议，验证 miss/hit 和不自动执行。

每一步都可单独提交；如果执行中发现 prompt 注入点比预期重，P2c 可拆到 P2d，不阻塞 P2a/P2b。

---

## 4. 验证命令

```bash
npm exec -- tsx --test src/agent/__tests__/model-policy-selection.test.ts
npm exec -- tsx --test src/agent/__tests__/model-routing-shadow.test.ts src/agent/__tests__/reward-loop.test.ts
npm exec -- tsx --test src/agent/__tests__/plan-cache-advisory.test.ts
npx tsc --noEmit
```

若实际测试文件命名不同，以新增文件为准；P2 最少要覆盖：ModelG、shadow-only、PlanCache advisory 三类。

---

## 5. 天权称量

P2 的主梁是：**让系统“会建议”，不是“会行动”。**

- `computeModelG()` 是模型路由的推理器，但 P2 只产推荐。
- routing shadow 是推荐落点，但 P2 不切模型。
- PlanCache 是经验入口，但 P2 只给短建议。
- reward closure 是历史信号，但 P2 不训练 bandit。

P2 完成后，P3 才有资格讨论 authority→model tier 和 gated model switch。
