# Team Mode V2 — Status & Next Steps

> 生成时间：2026-06-07
> 上一文档：`2026-06-07-team-mode-phased-implementation.md`（Phase 1-8 + 天权 P0 补充）
> 本文档：V1 实施完成后的事实记录，V2 规划的起点

---

## 1. V1 实施交付物（13 commits，d53b621..5b73bc6）

### 代码模块

| 文件 | 行数 | 职责 |
|------|------|------|
| `src/agent/team-plan.ts` | 276L | `TeamTaskDraft` → `TeamTask` 解析，`UnifiedTeamPlan` schema，依赖/风险提取 |
| `src/agent/team-grouping.ts` | 261L | `groupTeamTasks()` 拓扑排序 + 同文件串行 + source/test 绑定 |
| `src/agent/team-perspectives.ts` | 280L | `TeamPerspectivePlan` schema，`mergePerspectives()` 三视角裁决合并 |
| `src/agent/team-orchestrator.ts` | 213L | `runTeamSkeleton()` wave 调度，standard/max 两条路径 |
| `src/tui/slash-commands.ts` | +11L | `/team` 入口 + 弱 parser |
| `src/workflows/ecosystem-workflows.ts` | +57L | workflow 接入层 |
| `src/agent/coordinator.ts` | 修改 | `DelegationRequest` 加 dependencies/groupId，稳定 ID 透传 |
| `src/tools/delegate-batch.ts` | 未改 | 透传 DelegationRequest.dependencies 已自动生效 |

### 测试覆盖

| 测试文件 | 用例数 |
|----------|--------|
| `team-plan.test.ts` | 10 |
| `team-grouping.test.ts` | 11 |
| `team-perspectives.test.ts` | 14 |
| `team-orchestrator.test.ts` | 10 |
| **总计** | **45 pass, 0 fail** |

### 修复的缺陷（天府审查后修复）

| ID | 问题 | 修法 |
|----|------|------|
| H1 | `classifyTask` 读全文 → 实现任务被误判为 verifier | 分类只看 title，verification 行进 `verification[]` |
| H2 | `dependencies` 传 team task ID，WorkOrderQueue 等不到完成 | `team:T1` 稳定 ID 模式，coordinator 两条路径都透传 |
| M2 | `mergePerspectives` 浅拷贝污染天权原始对象 | deep clone tasks 数组 |
| M3 | `conflicts[]` 永远为空 | 实现风险冲突 + 依赖冲突检测 |

---

## 2. 当前状态：能做什么、不能做什么

### ✅ 已能工作

1. **`/team standard`**：输入 markdown 计划 → 解析 tasks → 拓扑排序分组 → 派第一波 workers
2. **`/team max`**：解析计划 + 生成 waves + 风险分类 → 但**不派** execution workers（skeleton stop）
3. **视角合并**：天权/天府/天璇三视角输出可以 deterministic merge
4. **文件冲突安全**：同文件 write 串行、部分 overlap 检测、source+test 绑定

### ❌ 尚未接线

| 缺失 | 影响 | 难度 |
|------|------|------|
| `/team max` 不派 planning workers | max 模式空转，需要接 `delegateBatch` 派 3 个 planner | 中 |
| profile routing 未实现 | 所有 worker 走同一模型，无强弱模型分离 | 中 |
| team review gate 独立于 `fix:` commit gate | feature/refactor 没有验收路径 | 小 |
| 多波次执行 | orchestrator 只派第一波，后续波需要 loop 或 re-entry | 中 |
| TUI 面板 | `/team` 输出是纯文本，无进度可视化 | 大（延后） |
| 自动 merge | 多 worker 写同一文件后需要合并策略 | 大（延后） |

---

## 3. V2 规划建议（天权视角）

### 优先级排序

```
P0: max 模式接 planning workers        ← 天权 P0-1 的核心
P0: 多波次执行 loop                     ← 没有这个 /team 只能做第一波
P1: team review gate                    ← 验收闭环
P1: profile routing                     ← 强弱模型分离
P2: TUI 面板                            ← 体验优化，非功能缺失
P3: 自动 merge                          ← 最难，最后做
```

### 关键设计决策待定

1. **多波次执行**：是 orchestrator 内部 loop（async generator？），还是需要用户手动 `/team continue`？
2. **max 模式 planning workers**：是 3 个 `delegate_batch` 并行调用，还是 3 个独立的 `delegate_task`？
3. **profile routing**：走 config schema 扩展，还是走 `TeamTask.routeHint` 运行时映射？

---

## 4. 数据流总结（V1 当前）

```
/team <objective>
  → slash-commands.ts: parseTeamCommand()
  → ecosystem-workflows.ts: route to runTeamSkeleton()
    → parseTeamTasks(markdown)        // team-plan.ts
    → groupTeamTasks(tasks)           // team-grouping.ts → TeamWave[]
    → waveToRequests(wave[0])         // → DelegationRequest[]
    → coordinator.delegateBatch()     // → WorkOrder[] → WorkOrderQueue
    → return TeamRunSummary
```

max 模式在 `groupTeamTasks` 之后直接返回，不进入 `delegateBatch`。

---

## 5. 已知技术债

- `TeamTaskDraft` 和 `TeamTask` 的继承关系用了 `extends`，但 `teamTasksToDelegationRequests` 里用 `(task as any).dependsOn` 逃逸检查——应该统一为 `TeamTask` 入口
- `groupId` 在 `DelegationRequest` 上定义了但未传到 `WorkOrder`——目前是 annotation only
- `buildUnifiedTeamPlan` 里 `nonGoals` 需要调用方显式传，没有从 markdown 解析
- `normalizePerspective` 的 graceful degradation 还没在真实 worker 输出上验证过

---

## 6. 后置方向：V3 强化（不插队 V2 基线）

V1/V2 是编排层基线（天权规划、天机/天府落地），目标是 team 模式**可用**，不触及 worker 星域化。

team 可用之后的最大化强化方向，见 **`2026-06-07-team-mode-v3-worker-stardomain.md`**：worker 星域化（马超/关羽等可派发专精认知）+ 星域知识库 + 经验沉淀升级。核心结论——剥洋葱后真缺口只剩**认知层两根线**（星域认知注入 worker + 星域知识库），harness/循环/上下文/记忆全套要么已共享要么不需要。**严格后置**，不得插队 V2 的 P0/P1。
