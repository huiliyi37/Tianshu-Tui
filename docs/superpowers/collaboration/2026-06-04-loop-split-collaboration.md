# 天枢团队协作实录：loop.ts 拆分

> **日期：** 2026-06-04
> **项目：** 天枢 (Tiānshū) Terminal Coding Agent
> **任务：** loop.ts 1856 行巨文件拆分
> **参与星域：** 天权（规划 + Phase 1）、天府（审查 + 上下文压力）、天梁（Phase 2 执行）

---

## 背景

`src/agent/loop.ts` 是天枢的核心文件——智能体循环、工具流水线、上下文压缩、收敛检测、CVM 认知系统全部集中在一个 1856 行的 class 中。`_runInner` 方法单独就有 733 行，含 9× `return` + 4× `continue` 的控制流，是公认的"不敢碰的文件"。

**挑战：** 任何单次会话都无法在上下文压力下安全完成整个拆分。需要多星域协作。

---

## 协作时间线

### Phase 0: 天府 — 上下文压力优化（前置工作）

**会话：** 天府域（DeepSeek V4-PRO）
**时间：** 2026-06-04 上午

天府在执行计划 Tasks 4-6 时发现了 `tool-execution.ts` 中 `addToolResults` 被调用了两次的 bug（93b5b15b session 工具结果重复写入），一并修复。

| 提交 | 内容 |
|------|------|
| `1ffd5ad` | Task 4: model-read-cap.ts 分级 TOKEN_FRACTION_PER_CALL（5%/3%/2%） |
| `a9955a5` | Task 5: per-message-budget.ts 每轮总读取预算（15% window） |
| `a8f5e7d` | Task 6: context-pressure preflight — usage >70% 时截断 read_file |
| `90fe311` | feat(agent): pass getEstimatedTokens 给 ToolExecutionController |
| `aabb40d` | **fix:** 移除重复 addToolResults 调用（根因：93b5b15b 会话数据重复） |

**天府贡献的独特价值：** 在执行计划过程中发现并修复了一个独立 bug，体现了天府"守藏者"的特质——不只做被要求的事，还保护系统免受已有缺陷的影响。

---

### Phase 1: 天权 — 规划 + 基础拆分

**会话：** 天权域（Opus 4.6）
**时间：** 2026-06-04 下午

#### 规划阶段（loop-split-v2.md，216 行）

天权花了大量时间在动手之前建立全貌认知：
1. 逐行阅读 loop.ts 的每个代码块
2. 追踪 12 个外部 import 方
3. 理解 TypeScript private 属性的编译语义
4. 绘制依赖图：Task 1→2→3→4+5→6→7
5. 识别 Task 6（_runInner 拆分）为高风险项，建议延后

#### 执行阶段

| 提交 | 任务 | 内容 | 行数 |
|------|------|------|------|
| `1ee1cec` | Task 1+2 | 类型层 `loop-types.ts` + 8 文件 import 迁移 | 94 |
| `25da174` | 测试 | 测试文件 import 路径迁移 | — |
| `50c223b` | 文档 | 设计文档创建 | 216 |
| `b548ce0` | Task 3 | `loop-factory.ts` — ts-morph AST 重构，37 个 private 移除 | 119 |
| `2e2e521` | Task 4+5 | `tool-history-recorder.ts` + `theta-controller.ts` | 84+68 |
| `76c0c63` | 工具 | ts-morph devDependency | — |

**关键决策：**
- regex 重构失败后**没有强行修补**，而是引入 ts-morph 做正规 AST 重构
- Task 6 遇到循环控制流障碍时**选择收束而非硬推**
- 交付了可复现的重构脚本（`scripts/refactor-loop.ts`，211 行）

**结果：** loop.ts 1856 → 1574 行（-282，-15%），4 个新文件（365 行）

---

### Phase 1.5: 天府 — 审查 + 控制流地图

**会话：** 天府域（DeepSeek V4-PRO）
**时间：** 2026-06-04 下午

天府对天权的产出进行独立审查：

1. **逐 commit 审查** 7 个提交的 diff
2. **控制流地图** — 逐行分析 `_runInner` 的 9× `return` + 4× `continue`，映射到行号范围
3. **Step 6a→6f 提取计划** — 按安全度排序，每个 step 独立可验证
4. **风险评估** — 识别 Step 6d（convergence）为最高风险块

**审查评分：** 天权规划 8/10，执行 7/10

**输出：** `loop-split-v3.md` — 完整的下一阶段执行指南

---

### Phase 2: 天梁 — 精准执行

**会话：** 天梁域（DeepSeek V4-PRO）
**时间：** 2026-06-04 晚

天梁严格按天府留下的 v3 计划执行，**没有偏离任何一步**：

| 提交 | Step | 方法 | 行数 | 控制流处理 |
|------|------|------|------|-----------|
| `f757058` | 6a | `initializeRun()` | ~95 | 返回 `{ heartbeat, wrappedCallbacks, actionable }` |
| `7aecf42` | 6b | `runCompaction()` | ~110 | 返回 `{ compacted, shouldAbort, userMessageConsumed }` |
| `6dfd209` | 6c | `runPerception()` | ~90 | 返回 `{ sensorium, strategy, phaseClass, pressureResult }` |
| `100df0a` | 6d | `runConvergenceCheck()` | ~60 | 返回 `{ action: 'proceed' \| 'abort' }` |
| `4d63bee` | 6e | `runCognitivePrep()` | ~70 | 无控制流（纯数据变换） |
| `836c44e` | 6f | `buildTurnRequest()` | ~85 | 返回 `{ action: 'proceed' \| 'veto' \| 'abort', request? }` |

**天梁的独特能力：** 将天权的规划（"这个块有 2× return + 1× continue"）精确地转化为 action 枚举模式。每个 commit 一个 step，零偏差，零回归。

**结果：** _runInner 733 → 308 行（-58%），loop.ts for-loop 体 630 → 332 行（-47%）

---

### Phase 3: 天府 — 收束

**会话：** 天府域（DeepSeek V4-PRO）
**时间：** 2026-06-04 晚

天府执行最终审查和文档收束：
- 验证全部 Step 6a-6f 的 tsc + 34/34 tests
- 更新 loop-split-v2.md 为最终收束文档
- 明确记录"不做的事项"（stream+tool 提取、private 恢复、factory 解耦）

---

## 最终指标

| 指标 | 原始 | 完成后 | 变化 |
|------|------|--------|------|
| loop.ts 行数 | 1856 | 1690 | -166 (-9%) |
| _runInner 行数 | 733 | 308 | -425 (-58%) |
| for-loop 体行数 | ~630 | ~332 | -298 (-47%) |
| 拆出文件 | 0 | 4 (365 行) | +4 |
| 提取方法 | 0 | 8 | +8 |
| 控制流 return/continue | 13 | 9 | -4 |
| 总提交数 | — | 13 | — |
| 回归 | — | 0 | ✅ |

---

## 协作模式总结

```
天权（规划）──→ loop-split-v2.md（216 行计划）
     │                │
     │                ↓
     │          天府（审查）──→ loop-split-v3.md（控制流地图 + Step 6a→6f）
     │                │
     ↓                ↓
天权（执行 Task 1-5）  天梁（执行 Step 6a-6f）
     │                │
     └──────┬─────────┘
            ↓
      天府（收束 + 文档）
```

**关键发现：**

1. **天权的规划能力是天枢团队最强的。** 依赖图、blast radius、风险评估都精确。唯一的盲区是 field-level 访问需求审计（37 个 private 移除的范围评估不够充分）。

2. **天梁的执行力是精准的。** 6 个 step、6 个 commit、零偏差。天梁不会"创造性地偏离计划"——这在高风险重构中是优点。

3. **天府的审查提供了安全感。** 控制流地图让天梁不需要自己去数 return/continue，直接按图施工即可。

4. **最优协作模式：** 天权 + 天府 + 天璇 在规划阶段联合出力 → 天梁精准执行 → 天府审查收束。这次 loop 拆分验证了这个模式的有效性。

---

## 各星域角色定位

| 星域 | 规划 | 执行 | 审查 | 特质 |
|------|------|------|------|------|
| 天权 | ★★★★★ | ★★★★☆ | ★★★★☆ | 权衡取舍，择善而从。最强的规划能力。 |
| 天府 | ★★★★☆ | ★★★★★ | ★★★★★ | 守藏者。最可靠的执行力和审查力。 |
| 天梁 | ★★★☆☆ | ★★★★★ | ★★★☆☆ | 精准执行。严格按计划，零偏差。 |
| 天璇 | ★★★★★ | ★★☆☆☆ | ★★★★☆ | 跨域探索，创意发想。 |

---

## 教训

1. **规划文档是星域间的契约。** 天权的 v2 计划和天府的 v3 补充让天梁可以无障碍接手——这是跨会话协作的核心。
2. **审查不是挑毛病，是为下一个执行者铺路。** 天府的控制流地图直接减少了天梁的探索成本。
3. **"不做"比"做"更难。** 天权在 Task 6 主动延后、天府在收束时明确搁置三项——这些"不做"的决定保护了系统稳定性。
4. **每个星域做自己最擅长的事，不要跨界。** 天权不强行执行 Task 6，天梁不修改计划，天府不在执行中途干预——各司其职。

---

*本文档为天枢团队首次完整的可复现多星域协作实录。2026-06-04。*
