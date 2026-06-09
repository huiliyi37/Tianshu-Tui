# T5×T2-03 P4 任务 · Gated Influence 与 Team Scheduler Bandit

> 日期：2026-06-08  
> 性质：P4 核心任务包  
> 前置：P0 双影子层、P1 Reward Loop、P2 ModelG、P3 Authority→Model Tier Shadow。  
> 目标：让学习器第一次“有条件地影响行为”，但所有影响必须经过 hard gate、feature flag、样本阈值与 reward 证据。

---

## 0. 一句话

**P4 不是把 bandit 接上就让它调度；P4 是建立“规则硬门 → shadow 建议 → reward 闭环 → gated influence”的统一行为闸。**

P4 完成后，系统可以在极小、可回滚、可审计的范围内调整 team 并行度 / model tier 建议，但不能绕过确定性安全规则。

---

## 1. 前置闸

P4 开始前必须具备：

1. P1 reward closure 可读、可聚合。
2. P2 `computeModelG()` 已实际消费 reward summary。
3. P3 已记录 per-worker `model_tier_shadow`，并能判断 recommended vs actual mismatch。
4. `groupTeamTasks()` 的确定性安全规则保持原样。

缺任一项时，P4 只能做 shadow，不允许 influence。

---

## 2. 范围

### 做

1. 新建 `team-scheduler-bandit.ts`
   - 独立 action space，不复用 effort bandit 的 `delta:-1/0/+1`。
   - 第一版只学 `parallelism:1|2|3|4|5`。

2. 新建 `team-scheduler-gate.ts`
   - 判断样本数、reward margin、一致性、false-green 事故。
   - gate 关闭时只能记录建议，不影响行为。

3. 在 team orchestrator 中加入 gated influence 点
   - 只能在 `groupTeamTasks()` 已给出的安全 wave 内调整 `parallelLimit/maxParallel`。
   - 不能打破依赖、同文件串行、source+test 绑定、高风险串行。

4. 落 MeridianDb
   - `team_scheduler_shadow:*`
   - `team_scheduler_reward:*`
   - 可复用 `p3_state` KV，append-only。

5. 补测试
   - gate closed / open 都要有合法数据构造。
   - hard gate 不能被 bandit 覆盖。
   - false-green 会关闭或压低 influence。

### 不做

- 不让 bandit 直接替换 `groupTeamTasks()`。
- 不做 profile bandit / split-policy / physarum 消费；这些是 P5+。
- 不让 model tier bandit 真切模型；P4 最多给 gated recommendation。
- 不自动执行 PlanCache。
- 不把失败/未集成 wave 写成正 reward。

---

## 3. Action space

第一版只做一个动作空间，避免一次接太多：

```ts
export type TeamSchedulerArm =
  | 'parallelism:1'
  | 'parallelism:2'
  | 'parallelism:3'
  | 'parallelism:4'
  | 'parallelism:5'
```

后续可加，但 P4 不做：

```ts
// P5+
'executor_profile:patcher|verifier|reviewer'
'split:none|module|risk_serial'
'model_tier:cheap|balanced|strong'
```

---

## 4. Context vector

```ts
export interface TeamSchedulerContext {
  taskCount: number              // normalized
  writeTaskCount: number         // normalized
  readTaskCount: number          // normalized
  dependencyDepth: number        // normalized
  crossModuleScore: number       // 0..1
  highRiskRatio: number          // 0..1
  historicalReward: number       // -1..1
  scopeLeakRate: number          // 0..1
}
```

注意：context 只能来自计划结构 + P0/P1/P3 事实，不从 LLM 自由文本猜。

---

## 5. Reward closure

P4 不重写 P1 reward；只把 team wave reward 映射到 scheduler bandit：

```ts
schedulerReward =
  teamWaveReward
  - 0.30 * conflictRate
  - 0.30 * scopeLeakRate
  - 0.60 * falseGreen
```

硬约束仍然是：

```text
falseGreenPenalty > any cost/latency/parallelism advantage
```

---

## 6. Gate 规则

建议第一版：

```ts
MIN_TOTAL_SAMPLES = 30
MIN_ARM_SAMPLES = 5
REWARD_MARGIN = 0.05
MAX_FALSE_GREEN_RATE = 0
MIN_RULE_AGREEMENT = 0.80
```

Gate open 条件：

1. 总样本数达标。
2. 候选 arm 样本数达标。
3. 候选 arm 平均 reward 高于 rule baseline 至少 `REWARD_MARGIN`。
4. 最近窗口 false-green rate 为 0。
5. 建议不违反 rule hard gate。

任何一条不满足，P4 只记录 shadow。

---

## 7. Hard gate：不可被学习器覆盖

这些规则永远在 bandit 之前：

| 硬规则 | 原因 |
|---|---|
| 依赖拓扑顺序 | 避免后继在前置未完成时执行 |
| 同文件写串行 | 避免并行写冲突 |
| source+test 绑定 | 避免实现与测试分裂 |
| high-risk task 串行或强收敛 | 避免迁移/配置/schema 同时改坏 |
| maxWorkers 上限 5 | 资源与协作可控 |
| scope leak 事故后降并行 | false-green / 跑偏优先级高于吞吐 |

P4 influence 只能在 hard gate 输出的安全集合内调 `parallelLimit`。

---

## 8. 实施步骤

### P4a — 纯 bandit + gate

文件：

- `src/agent/team-scheduler-bandit.ts`
- `src/agent/team-scheduler-gate.ts`
- `src/agent/__tests__/team-scheduler-bandit.test.ts`
- `src/agent/__tests__/team-scheduler-gate.test.ts`

验收：

- cold start 只 shadow。
- 合法数据能构造 gate closed。
- 合法数据能构造 gate open。
- false-green 一票否决。

### P4b — shadow telemetry

文件：

- `src/agent/team-scheduler-shadow.ts`
- `src/agent/team-orchestrator.ts`

事件：

```ts
export interface TeamSchedulerShadowEvent {
  schemaVersion: 1
  sessionId: string
  objectiveHash: string
  waveId: string
  ruleParallelism: number
  recommendedArm: TeamSchedulerArm
  applied: boolean
  gateOpen: boolean
  reason: string
  pendingRewardId: string
  timestamp: number
}
```

P4b 默认 `applied=false`。

### P4c — gated influence

文件：

- `src/agent/team-orchestrator.ts`
- `src/config/schema.ts` 或现有 agent config：新增 feature flag。

建议 flag：

```ts
teamSchedulerBanditEnabled?: boolean // default false
```

只有 flag 开 + gate open，才允许：

```text
safeParallelism = min(ruleParallelism, banditRecommendedParallelism, maxWorkers)
```

注意：第一版建议只允许“降并行”或“不超过 ruleParallelism”；不要让 bandit 扩大并行。扩大并行留 P4b/P5。

---

## 9. 验证命令

```bash
npm exec -- tsx --test src/agent/__tests__/team-scheduler-bandit.test.ts
npm exec -- tsx --test src/agent/__tests__/team-scheduler-gate.test.ts
npm exec -- tsx --test src/agent/__tests__/team-scheduler-shadow.test.ts
npm exec -- tsx --test src/agent/__tests__/team-orchestrator.test.ts src/agent/__tests__/team-grouping.test.ts
npx tsc --noEmit
```

若文件名不同，以实际新增测试为准；最少覆盖 gate、shadow、hard gate 不可覆盖三类。

---

## 10. 天权称量

P4 是第一步真正靠近行为影响的阶段，因此要比 P0-P3 更保守：

- P0/P1/P2/P3 可以只 shadow；P4 一旦开 flag 就会影响行为。
- 第一版 influence 只允许在安全规则内“降并行”，不允许扩并行。
- false-green / scope leak / conflict 的惩罚必须压过吞吐收益。
- 每个 applied decision 必须有 pendingRewardId，能追到 reward closure。

P4 完成后，系统才具备 P5 的基础：profile bandit、model tier gated switch、physarum 监督边、split-policy 接入。
