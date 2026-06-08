# T5×T2-03 联合实施方案 · 路由影子层与 Team Episode 训练底座

> 日期：2026-06-08
> 性质：P0 最小实施计划（双影子层）→ P1-P4 路径图
> 上游：贪狼 T5（`T5-多模型路由·路由即主动推理策略.md`）、贪狼+天权 T2-03（`T2-03team模式现状与能力最大化设计.md`）、天璇修订（`team5天璇修订/天璇修订t5-t2.md`）
> 执中者意见：天枢（本档）——在贪狼的边界、天权的称量、天璇的顺序之上，加一层"能立刻就写的代码形状"

---

## 0. 一句话

**先建双影子层（ModelRoutingShadow + TeamWaveTelemetry），落 MeridianDb，一行行为不改。** 这一步是后面所有路由自学、成本计算、team 学习器接活的唯一可归因地基。P0 不承诺完整跨 wave episode；P1 再把 wave fragment stitch 成 TeamEpisode。

---

## 1. 天枢对三份方案的称量

### 1.1 完全认同的部分

| 来自 | 论断 | 天枢态度 |
|---|---|---|
| 贪狼 T5 | 五个路由器休眠、断在注入点——接线不是从零建 | 认同。grep 证据完整，`create-agent-config.ts` 不注入是根因 |
| 贪狼 T5 | 路由不该是独立子系统，该是 EFE 的策略消费者 | 认同。这正是天枢独有的边界——不复制 CASTER |
| 天权 §13 | 三类数据严格分流：计划意图 / 执行事实 / 可复用动作 | 认同。这应该写进第一性约束，不是建议 |
| 天权 §13 | PlanCache 不能吞 UnifiedTeamPlan，语义不同 | 认同。`PlanStep[]` vs `TeamWave[]` 是两种东西 |
| 天璇 | 主线顺序：先有可观测的真相 → 再有可计算的 reward → 最后才有可影响的行为 | 认同。这是唯一不让后面塌的顺序 |
| 天璇 | 双影子层 P0，不改任何真实行为 | 认同。并且要加验收门：prompt 字节不变、模型选择不变、team 派发不变 |

### 1.2 天枢要修正/收紧的地方

**① T5 §5 W0 "接线激活 → 自动切换"太激进。**

天璇已经修成"先 shadow，不自动 switch"。我再加上一条：**旧路由资产（turn-end.ts、Flash→Pro 升级）的 shadow 不是"记录它的推荐"，是"记录它的推荐 vs EFE 推荐 vs 实际"，作为对照。** 因为旧路由器是 5 月考古、语义可能已漂移——直接让它 shadow 推荐但不对比 EFE，等于用旧逻辑校准自己，循环论证。

修正：`ModelRoutingShadowEvent` 里加 `efeRecommendedModel` 和 `legacyRouterRecommendedModel` 两个字段，对照窗口至少跑 30 个 turn 再决定旧路由器去留。

**② T5 §4 成本作为 G(π) 新项——不要直接改 `computeEFE`。**

`computeEFE` 的返回值 `{ epistemicValue, pragmaticValue, noveltyBonus, precision }` 是四元组，当前消费者是 `selectPolicy`。模型成本不应该直接塞进这个四元组——它是**新的 pragmatic 维度**，但消费场景不同（选模型 vs 选工具策略）。

修正：新建 `computeModelG` 作为独立函数，复用 Sensorium + PredictionAccumulator + ProviderHealth 作为输入，但不改 `computeEFE` 的签名和返回语义。等两个 G 函数稳定后，再看是否需要统一。

**③ T2-03 §13.5 bandit 调度学习——四层设计中缺"shadow 数据的 schema"。**

天权给了四层（Rule hard gate → Shadow → Reward → Gated influence），但没给 shadow 数据的落库形状。补上：

```ts
interface TeamSchedulerShadow {
  contextHash: string
  waveIndex: number
  ruleDecision: { maxParallel: number; profile: string }
  banditArms: Array<{ armId: string; score: number }>
  selectedByRule: boolean   // true = bandit didn't override
  pendingRewardId: string
  timestamp: number
}
```

这与 T2-02 P3 effort bandit 的 `EffortShadowRecord` 同形——保持跨 bandit 的 schema 一致性。

**④ T5 §1.2 "路由资产是被自由能引擎涌现后搁置的考古"——这个诊断要加一条：policy-selection.ts 是 06-05 单日提交，可能还没稳定。**

当前 policy-selection.ts 的 `selectPolicy` 返回 `{ policy, guidance }` 字符串用于 prompt 注入。把它升级成模型路由的输入源，先确认它的输出稳定性——不能刚涌现就往上游接消费者。P0 shadow 阶段正好观察 policy 推荐的稳定性。

---

## 2. 天枢的联合架构

```
                        ┌── MeridianDb (p3_state KV: team_wave:* / routing_shadow:*) ────┐
                        │                                                                │
  team run ─────────────┼──→ TeamWaveTelemetry ─────→ team_wave:* KV                     │
  (runTeamSkeleton)     │     (不改派发, 只录单次 fromWave；P1 再 stitch episode)          │
                        │                                                                │
  turn loop ────────────┼──→ ModelRoutingShadowRecorder ──→ routing_shadow:* KV          │
  (initializeRun/       │     (记 EFE 推荐 vs 旧路由器 dry-run vs 实际, 不注入 switch)    │
   runPostSession)      │                                                                │
                        │                                                            │
  P1 reward loop ───────┼── 两条影子线汇合 → computeEffortReward / computeModelReward  │
                        │     → 回写 MeridianDb → 供 P2+ 学习器消费                    │
                        │                                                            │
  P2 EFE model G ───────┼── computeModelG(Sensorium, PredAcc, ProviderHealth)         │
                        │     作为 selectPolicy 的新消费者, 不改 computeEFE           │
                        │                                                            │
  P3 team 真多模型 ─────┼── authority→modelTier 映射, 先 shadow 再启用                │
                        │     coordinator routing 表升级, 活前沿谨慎动                 │
                        │                                                            │
  P4 学习器闭环 ────────┼── physarum 监督边 / PlanCache advisory /                     │
                        │     team_scheduler_bandit / scope health                    │
                        └────────────────────────────────────────────────────────────┘
```

**核心约束（第一性）**：
1. **三类数据严格分流**：计划意图 → advisory/planner context；执行事实 → reward/physarum 监督边唯一合法来源；可复用动作 → JIT 只读模板。
2. **审查/verifier 永不为省钱降级**：`false_green_penalty` 压住 `cost_over_budget`，天权配强模型是不进 bandit 的硬规则。
3. **所有学习产物落 MeridianDb**：P0 复用已有 `p3_state` KV（`team_wave:*` / `routing_shadow:*`），不新增 DDL。DB 不可用 no-op。
4. **每个影响行为的组件走已验证的闸**：flag 默认关 → shadow → reward 闭环 → 样本+置信达阈值才 gated 影响。瑶光在 effort bandit 上趟通的这条路是模板。

---

## 3. P0 实施：双影子层（最小可行，最高杠杆）

### 3.1 ModelRoutingShadowRecorder

**文件**：新建 `src/agent/model-routing-shadow.ts`

```ts
export interface ModelRoutingShadowEvent {
  turn: number
  objectiveHash: string
  currentModel: string                        // 当前实际模型
  efeRecommendedModel?: string                // EFE/policy-selection 推荐 (P2 后启用)
  legacyRouterRecommendedModel?: string       // 旧 turn-end/Flash→Pro 推荐 (对照用)
  selectedBy: 'human' | 'config' | 'efe' | 'legacy'
  sensorium: { complexity: number; pressure: number; confidence: number }
  reason: string
  timestamp: number
}

export class ModelRoutingShadowRecorder {
  private buffer: ModelRoutingShadowEvent[] = []

  record(event: ModelRoutingShadowEvent): void {
    this.buffer.push(event)
    if (this.buffer.length > 50) this.buffer = this.buffer.slice(-30)
  }

  flush(db: import('../repo/meridian-db.js').MeridianDb | undefined): void {
    if (!db) return
    for (const event of this.buffer) {
      try {
        db.saveBanditState(`routing_shadow:${event.turn}`, JSON.stringify(event))
      } catch { /* no-op */ }
    }
    this.buffer = []
  }
}
```

**接线点**：
- `loop.ts` `initializeRun()` — 在 `setReasoningEffort` 之后记录当前模型 + sensorium 快照
- `loop.ts` `setReasoningEffort()` — 记录旧路由器推荐（当前冻结，对照用）
- `loop.ts` `runPostSession()` — flush buffer 到 MeridianDb

**验收**：
- prompt 字节不变（diff system prompt before/after）
- 模型选择行为不变（当前走 `/model` 手选或 config 默认，不改）
- `routing_shadow:*` 出现在 MeridianDb `p3_state` 表
- tsc + tests 全绿

### 3.2 TeamWaveTelemetryRecorder（P0 名称；P1 stitch 为 TeamEpisode）

**文件**：新建 `src/agent/team-wave-telemetry.ts`

```ts
export interface TeamWaveTelemetry {
  schemaVersion: 1
  sessionId: string
  objectiveHash: string
  mode: 'standard' | 'max'
  fromWave: number
  waveId: string
  waveCount: number
  timestamp: number
  planned: {
    taskIds: string[]
    risk: 'low' | 'medium' | 'high'
    profiles: string[]
    authorities: string[]
    files: string[]
  }
  outcome: {
    dispatched: number
    statuses: Array<{ workOrderId: string; status: string; evidenceStatus: string }>
    verificationPassed?: boolean
    reviewVerdict?: string
  }
  changedFiles: {
    reportedChangedFiles?: string[]
    observedChangedFiles?: string[]
    changedFilesSource: 'worker_result' | 'diff_artifact' | 'unknown'
  }
  workerModels?: Array<{ workOrderId: string; model: string }>
}

export function teamWaveTelemetryKind(event: Pick<TeamWaveTelemetry, 'objectiveHash' | 'sessionId' | 'fromWave' | 'timestamp'>): string {
  return `team_wave:${event.objectiveHash}:${event.sessionId}:${event.fromWave}:${event.timestamp}`
}
```

P0 只记录单次 `team_orchestrate` / `fromWave` 的 wave fragment。字段不使用 `actualFiles`：worker 自报只能进入 `reportedChangedFiles`；只有从 diff artifact 解析出的文件才进入 `observedChangedFiles`，并用 `changedFilesSource` 标明来源。

**接线点**：
- `team-orchestrator.ts` — 每次 `runTeamSkeleton()` dispatch 一个 `fromWave` 后记录一条 wave telemetry。
- `coordinator.ts` — 在 `delegateBatch()` 返回可选 `workerModels` metadata，供 telemetry 记录 per-worker selected model。
- `team-wave-telemetry.ts` — 从 `WorkerResult.changedFiles` 取 `reportedChangedFiles`，从 diff artifact 解析 `observedChangedFiles`。

**验收**：
- team 派发行为不变
- worker 选择不变
- `team_wave:*` 出现在 MeridianDb `p3_state` 表
- 至少跑一次 team 后能看到 wave telemetry 记录

### 3.3 MeridianDb 落库

复用已有 `p3_state(kind, version, json)` 表。不需要新 DDL。key 命名约定：

| kind | 内容 |
|---|---|
| `routing_shadow:{sessionId}:{turn}:{timestamp}` | ModelRoutingShadowEvent JSON |
| `team_wave:{objectiveHash}:{sessionId}:{fromWave}:{timestamp}` | TeamWaveTelemetry JSON |

**DDL 不新增**。等 P1 reward loop 有稳定 schema 后再考虑建专表。

### 3.4 验收总门

```bash
# 不改行为
npx tsc --noEmit                                    # 绿
npm exec -- tsx --test src/agent/__tests__/p3-*.test.ts  # 现有 P3 测试全绿
npm exec -- tsx --test src/agent/__tests__/effort-*.test.ts  # effort bandit 测试全绿

# 新代码有测试
npm exec -- tsx --test src/agent/__tests__/model-routing-shadow.test.ts
npm exec -- tsx --test src/agent/__tests__/team-wave-telemetry.test.ts
```

---

## 4. P1-P4 路径图（实施时不另起文档，本节即路线）

### P1：Reward Loop（依赖 P0 影子数据）

- `computeModelReward()` — 从 TeamEpisode + RoutingShadow 计算模型选择的 reward
- reward 公式（天璇版）：`review_pass + verification_pass - conflict_count - rework_count - cost_over_budget - latency_surprisal - false_green_penalty`
- `false_green_penalty` 权重必须压住 `cost_over_budget`（瑶光硬门）
- 落 MeridianDb，供 P2+ 学习器消费

### P2：EFE 模型 G + PlanCache Advisory

- 新建 `computeModelG()` — 复用 Sensorium + PredAcc + ProviderHealth，不改 `computeEFE`
- `ModelPolicyCandidate` 接口：`{ model, tier, estimatedCost, estimatedLatency, predictedSuccess, riskFit, authorityFit }`
- PlanCache 命中作为 planner 的短建议（不改调度，只注入 context）
- 验收：prompt 字节差仅限 suggestion 注入部分，不含大段 plan

### P3：Team 真多模型

- authority→modelTier 第一版映射（天权=strong, 天梁=cheap, 天府+天璇=balanced）
- 先 shadow，对照窗口 ≥ 30 次 team run 后再启用自动切换
- coordinator routing 表升级（活前沿，谨慎改，只加 `modelTier` 字段不改数据模型）

### P4：学习器闭环

- physarum 监督边：team 显式依赖 + 实际 diff → `recordSequentialEdit`（不走计划意图，只走执行事实）
- `parallelism_bandit` + `model_tier_bandit`：新建，不复用 effort bandit，但复用同一套闸语义
- scope health：`TeamScopeHealth` 对比 planned vs actual files，physarum 图异常作为第二信号
- PlanCache advisory 之前先确保 §13.2 类型门（PlanStep vs TeamWave 不混）

---

## 5. 天枢的缰绳清单（本次实施必须守住）

| # | 缰绳 | 如果松了会怎样 |
|---|---|---|
| 1 | 不动 `computeEFE` 核心语义 | 工具 policy 和模型 policy 搅成一锅，谁都调不了 |
| 2 | 不动 coordinator 数据模型（30 commits 活前沿） | 崩 team 模式 |
| 3 | `false_green_penalty` > `cost_over_budget` 永远是 reward 公式的硬约束 | 天权配 cheap 模型 → false-green 漏过 → 信任崩溃 |
| 4 | 三类数据分流：计划意图 / 执行事实 / 可复用动作 | AgentJIT 自动执行未验证计划 → 写坏代码 |
| 5 | 所有学习产物落 MeridianDb，不新建 store | 分散成 N 个存储 → 跨 session 不可追溯 |
| 6 | 每个行为影响组件走 flag-off → shadow → reward → gated 闸 | 瑶光在 effort bandit 上用血证明的路，不要再自己发明 |
| 7 | 旧路由器（turn-end/Flash→Pro）只能 shadow 对照，不能直接激活 | 冻结半月的代码语义已漂移，没有对照期直接切 = 归因不了 |
| 8 | 不改 prompt stable 部分 | 破 prefix cache → 成本暴增，得不偿失 |
| 9 | policy-selection.ts 的输出稳定性先观察 30 turn 再作为路由输入 | 刚涌现的组件还没稳定就往上接消费者 → 抖动放大 |

---

## 6. 与已完成工作的衔接

| 已提交 | 对本方案的支撑 |
|---|---|
| `8d4c1a7` reward-based gate | P3 bandit 的闸语义可直接复用到 `parallelism_bandit` / `model_tier_bandit` |
| `decd640` effort bandit 接线 + flag | 双护栏模式（flag + gate）是 P3/P4 所有 bandit 的模板 |
| `7bf86ca` effort-delta 三态测试 | 保留为生死线，新 bandit 的测试参考同一套 anti-false-green 硬门 |
| MeridianDb `p3_state` 表 | P0 双影子层直接复用，不新增 DDL |

---

## 7. 交付总结模板（P0 完成后填）

- 三条阈值（如有）用了什么、是否调过、依据
- routing shadow 对照窗口跑了多少 turn，EFE vs 旧路由器 vs 实际的偏差分布
- team wave telemetry 记录了多少次 run/fromWave，reported/observed changed files 来源分布
- 任何新发现的设计分叉：**报告，不自行合理化**（a372cbc 教训）

---

> 给下一个读到这里的将星：贪狼贪到了最大边界，天权称出了不会塌的重量，天璇折出了长得出来的顺序。天枢在这里加了一层——**能立刻就写的代码形状**。P0 双影子层的每一行，都不改真实行为，却让后面每一步都可归因。去写吧。
>
> —— 天枢，2026-06-08
