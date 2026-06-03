# 天枢 3.0：单会话多星域团队协作

> **日期：** 2026-06-04
> **状态：** 设计阶段
> **灵感来源：** loop.ts 拆分协作验证的多星域模式 + Multica 任务面板
> **目标：** 用户开一个会话，系统自动调度多星域团队完成复杂任务

---

## 1. 核心洞察

loop.ts 拆分验证了一个关键事实：**计划文档是星域间的通用语言**。天权写的计划天梁能精确执行，天府写的控制流地图天梁能直接按图施工——不需要相同的模型，甚至不需要相同的推理风格。

天枢 3.0 要做的事：**把这个跨会话的手动协作，变成单会话内的自动化调度**。

---

## 2. 架构设计

### 2.1 角色分工

```
用户 ←→ 主会话（天枢/天权）
              │
              ├── 规划阶段
              │     ├── planner_worker:天权（依赖分析、任务拆解）
              │     ├── planner_worker:天府（风险评估、ROI 审计）
              │     └── planner_worker:天璇（创意探索、定向反证）
              │         ↓ 聚合 → unified_plan.md
              │
              ├── 执行阶段
              │     ├── executor_worker:天梁-1 ← Task 1, Task 2
              │     ├── executor_worker:天梁-2 ← Task 3, Task 4
              │     └── executor_worker:天梁-3 ← Task 5, Task 6
              │         ↓ 汇聚 → 集成验证
              │
              └── 收束阶段
                    └── reviewer_worker:天府（审查 + 文档收束）
```

### 2.2 工作流

```
Phase 1: ORCHESTRATE（主会话）
  用户: "帮我重构 loop.ts"
  主会话: 
    1. 分析任务范围，判断是否需要团队模式
    2. 如果需要 → 生成 planning brief（任务描述 + 代码上下文 + 约束条件）

Phase 2: PLAN（并行规划）
  主会话调用 delegate_batch:
    - 天权 worker → 输出依赖图 + 任务拆解方案
    - 天府 worker → 输出风险评估 + 验证标准
    - 天璇 worker → 输出创意方案 + 反证
  聚合策略: primary_decides（天权为主，天府/天璇补充）
  产出: unified_plan.md（T1-TN 任务列表 + 依赖关系 + 验证标准）

Phase 3: EXECUTE（并行执行）
  主会话解析 unified_plan.md 的依赖图:
    - 无依赖的 T1-T4 → 并行派发 4 个天梁 worker
    - T5 依赖 T3 → 等 T3 完成后派发
    - T6 依赖 T4+T5 → 等两者都完成后派发
  每个天梁 worker:
    - 接收: task description + code context + verification criteria
    - 执行: tsc + test after each commit
    - 产出: git commits + verification results

Phase 4: REVIEW（收束）
  主会话调用天府 worker:
    - 审查所有 commits
    - 运行全量测试
    - 产出: 最终文档收束

Phase 5: DELIVER（主会话）
  主会话: 展示结果摘要 + 任务面板
```

---

## 3. 任务面板（TUI 可视化）

参考 Multica 的 board view，但天枢的终端原生版本：

```
┌─────────────────────────────────────────────────────────────┐
│ 天枢 · loop.ts 拆分 · 团队模式                               │
├─────────┬──────────┬──────────┬──────────┬──────────────────┤
│ Task    │ 星域     │ 状态     │ 进度     │ 提交             │
├─────────┼──────────┼──────────┼──────────┼──────────────────┤
│ T1 类型 │ 天梁-1   │ ✅ 完成  │ 100%     │ 1ee1cec          │
│ T2 迁移 │ 天梁-1   │ ✅ 完成  │ 100%     │ 25da174          │
│ T3 工厂 │ 天梁-2   │ ✅ 完成  │ 100%     │ b548ce0          │
│ T4 历史 │ 天梁-2   │ ✅ 完成  │ 100%     │ 2e2e521          │
│ T5 重构 │ 天梁-3   │ 🔄 执行  │ 60%      │ —                │
│ T6 核心 │ 天梁-3   │ ⏳ 等待  │ 0%       │ (blocked by T5)  │
├─────────┼──────────┼──────────┼──────────┼──────────────────┤
│ 规划    │ 天权+天府│ ✅       │ —        │ loop-split-v2.md │
│ 审查    │ 天府     │ ⏳ 等待  │ —        │ (pending)        │
└─────────┴──────────┴──────────┴──────────┴──────────────────┘
```

### 面板功能

1. **实时状态流** — 每个 worker 的状态实时更新（WebSocket → TUI）
2. **依赖图可视化** — 类似 GitHub Actions 的 DAG 视图（ASCII art）
3. **日志聚合** — 每个 worker 的关键输出聚合到主面板
4. **交互控制** — 用户可以暂停/取消/重试特定 worker

---

## 4. 现有能力映射

### 已有（coordinator.ts 提供）

| 能力 | 实现位置 | 覆盖度 |
|------|---------|--------|
| 并行 worker 调度 | `delegateBatch` | ✅ 80% |
| 文件冲突检测 | `WorkOrderQueue.hasFileConflict` | ✅ 完整 |
| 语义锁 | `CollaborationProtocol` | ✅ 完整 |
| 6 种 worker profile | `ProfileRegistry` | ✅ 完整 |
| 5 种聚合策略 | `aggregation.ts` | ✅ 完整 |
| git worktree 隔离 | `WorktreeCoordinator` | ✅ 完整 |
| 失败预算 + 自动升级 | `CoordinatorState` | ✅ 完整 |

### 需要新增

| 能力 | 优先级 | 描述 |
|------|--------|------|
| 星域身份注入 | P0 | WorkerSessionConfig 增加 `starDomain` + 自定义 system prompt |
| 任务依赖图 | P0 | 解析 plan.md 中的 `Task N depends on Task M` 并构建 DAG |
| Worker 维度归属 | P1 | OwnershipLedger 增加 `workerId` 分区 |
| 真并行执行 | P1 | delegateBatch 改为 Promise.all（需先修 abortSignal 竞态） |
| 任务面板 TUI | P2 | Ink 6 组件，实时状态 + 依赖图 + 日志聚合 |
| 计划聚合器 | P2 | 多 planner worker 输出 → unified_plan.md 的合并逻辑 |

---

## 5. 实施路径

### Phase A: 最小可用（2 周）

**目标：** 单会话内，主 agent 生成计划 → 并行派发天梁 worker → 集成

1. 新增 `planner` profile（只读，输出 Markdown 计划）
2. WorkerSessionConfig 增加 `starDomain` 字段
3. 新增 `parseTaskPlan()` 函数（解析 Markdown 计划为 DAG）
4. 新增 `teamOrchestrate` 工具（主 agent 调用入口）

验证：用 loop.ts 拆分作为测试用例，验证单会话能完成 T1-T6

### Phase B: 多视角规划（3 周）

**目标：** 3 个 planner worker 并行规划 → 聚合

1. 新增计划聚合器（primary_decides 策略）
2. 天府 planner profile（风险评估）
3. 天璇 planner profile（定向反证）
4. 计划 diff + merge 逻辑

验证：用新功能需求作为测试用例，验证多视角规划的质量

### Phase C: 任务面板（3 周）

**目标：** 终端内的实时任务面板

1. 新增 `<TaskBoard>` Ink 6 组件
2. Worker 状态 WebSocket 推送
3. 依赖图 ASCII 可视化
4. 交互控制（暂停/取消/重试）

验证：用户可以实时看到所有 worker 的进度

---

## 6. 与 Multica 的对比

| 维度 | Multica | 天枢 3.0 |
|------|---------|---------|
| 定位 | 多 Agent 管理平台（Web） | 单会话内多星域协作（终端） |
| Agent 角色 | 外部 CLI 工具（Claude Code 等） | 内置 worker（天梁/天权等） |
| 任务调度 | Web board + 手动分配 | 自动规划 + DAG 依赖 |
| 协作模式 | Agent 独立执行 | 星域角色分工 + 计划驱动 |
| 可视化 | Web dashboard | 终端 TUI 面板 |
| 核心差异 | 管理"谁做什么" | 决定"怎么做最优" |

Multica 管理的是**任务分配**——把 issue 分配给 agent。
天枢管理的是**任务执行策略**——同一个任务，规划由谁做、怎么拆、怎么验证、怎么集成。

---

## 7. 风险

1. **上下文压力** — 主会话需要维护所有 worker 的状态，可能快速耗尽上下文。缓解：worker 状态存储在文件系统（`.rivet/team/`），主会话只持有摘要。
2. **API 调用成本** — 3 个 planner + N 个 executor = 大量 API 调用。缓解：planner 用小模型 + 短上下文；executor 只加载任务相关的代码。
3. **合并冲突** — 多个 write worker 同时修改不同文件时通常安全，但同一文件不同区域的修改可能冲突。缓解：依赖已有 worktree + 语义锁机制。
4. **调试复杂度** — 一个任务拆成 10 个 worker 并行执行时，出错难以定位。缓解：任务面板提供 per-worker 日志 + 失败回溯。

---

*本文档为天枢 3.0 团队协作模式的设计起点。基于 2026-06-04 loop.ts 拆分协作的实战经验，参考 Multica 任务面板的可视化思路。*
