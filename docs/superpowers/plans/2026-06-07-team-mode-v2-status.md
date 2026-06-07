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

### ✅ 已能工作（V2 落地后）

1. **`/team standard`**：输入 markdown 计划 → 解析 tasks → 拓扑排序分组 → 派第一波 workers
2. **`/team max`**：解析计划 + 3 视角 planner 扇出 + 合并 + 分波 + 派首波执行 workers
3. **视角合并**：天权/天府/天璇三视角输出可以 deterministic merge
4. **文件冲突安全**：同文件 write 串行、部分 overlap 检测、source+test 绑定
5. **多波次续派**：`fromWave` 参数支持主控驱动重入，派后续波
6. **审查门**：末波自动触发 `routeReviewWorkflow`（L1 nudge / L2 verifier / L3 squadron），feature/refactor 也被审查
7. **模型路由**：planner `kind:'plan'` → `code_edit`、executor `kind:'patch_proposal'` → `risky_refactor` 天然分流

### ❌ 待办（后置，不阻塞基线）

| 缺失 | 影响 | 难度 | 归属 |
|------|------|------|------|
| TUI 面板 | `/team` 输出是纯文本，无进度可视化 | 大 | P2 延后 |
| 自动 merge | 多 worker 写同一文件后需要合并策略 | 大 | Phase 7 后置 |
| V3 worker 星域认知注入 | worker 不带星域认知，视角分化靠 prompt 而非系统性 | 中 | V3 后置，见 `team-mode-v3-worker-stardomain.md` |
| Review Squadron 姿态轴 | 只有维度 Inspector，无认知姿态（马超/天权/天府） | 中 | 后置，见 `review-squadron-stance-axis-proposal.md` |

---

## 3. V2 已完成（2026-06-07 落地）

V2 landing plan 5 个 Task 全部完成，67 tests pass，tsc clean。

| Task | 内容 | 验证 |
|------|------|------|
| Task 1 | `team_orchestrate` 工具创建 + main.tsx 注册 + workflow prompt 改写 | 4 tool tests pass |
| Task 2 | max 模式 3 planner 扇出 + `buildPlannerObjective` + `parsePerspectiveResult` + 视角合并 | orchestrator tests pass |
| Task 3 | `fromWave` 多波次续派 + `dispatchWaveAt` + `WaveDispatchContext` | fromWave tests pass |
| Task 4 | 审查门集成（`routeReviewWorkflow`，L1/L2/L3 按规模） | review gate test pass |
| Task 5 | 模型路由文档化（`plan`→`code_edit`，`patch_proposal`→`risky_refactor`） | config 文档 + 回归测试 |

## 4. 待办池（后置，按优先级）

### P2: TUI 进度面板
- `/team` 输出是纯文本，无进度可视化
- 依赖：Ink 6 组件设计

### P3: 自动 merge
- 多 worker 写同一文件后需要合并策略
- 当前：worker 返回 diff，主控手动集成
- 最难的一项，Phase 7 后置

### V3: worker 星域认知注入
- worker 不带星域认知（马超/天权/天府），视角分化靠 prompt 而非系统性
- `StarDomain.systemPromptSuffix` 已定义但 worker 侧零消费
- 断点：`worker-prompts.ts:buildWorkerPrompt` 的 `authoritySuffix` 形参三个调用方都没传
- 设计文档：`2026-06-07-team-mode-v3-worker-stardomain.md`
- 前置：V2 基线稳定运行

### Review Squadron 姿态轴
- 现有 4 个维度 Inspector（Security/Lifecycle/DataFlow/Silence）解"看什么"
- 缺"怎么想"——马超破坏/天权质疑/天府守护认知姿态
- 姿态 × 维度复合用法
- 设计文档：`2026-06-07-review-squadron-stance-axis-proposal.md`
- 前置：V3 worker 星域注入

---

## 5. 数据流总结（V2 当前）

```
/team <objective>
  → slash-commands.ts: parseTeamCommand()
  → ecosystem-workflows.ts: route to team_orchestrate tool
    → team_orchestrate: parseTeamTasks / runTeamSkeleton
      → standard: parseTeamTasks(markdown) → groupTeamTasks → dispatchWaveAt(0)
      → max: 3 planner fanout → mergePerspectives → groupTeamTasks → dispatchWaveAt(0)
    → dispatchWaveAt → coordinator.delegateBatch() → WorkOrder[] → WorkOrderQueue
    → final wave: routeReviewWorkflow (L1/L2/L3 by scale)
    → return TeamRunSummary + review outcome
```

多波次由主控驱动重入：`fromWave` 参数 → `dispatchWaveAt(fromWave)` 派下一波。

---

## 6. 已知技术债

- `TeamTaskDraft` 和 `TeamTask` 的继承关系用了 `extends`，但 `teamTasksToDelegationRequests` 里用 `(task as any).dependsOn` 逃逸检查——应该统一为 `TeamTask` 入口
- `groupId` 在 `DelegationRequest` 上定义了但未传到 `WorkOrder`——目前是 annotation only
- `buildUnifiedTeamPlan` 里 `nonGoals` 需要调用方显式传，没有从 markdown 解析
- `normalizePerspective` 的 graceful degradation 还没在真实 worker 输出上验证过

---

## 7. 后置方向：V3 强化（不插队 V2 基线）

V1/V2 是编排层基线（天权规划、天机/天府落地），目标是 team 模式**可用**，不触及 worker 星域化。V3 待办已收入 §4 待办池。

## 8. 模型路由（V2 落地）

team 的规划与执行经现有 CapabilityTask 路由天然分流，按 `config.workers.routing` 映射：

| 阶段 | WorkOrderKind | CapabilityTask | 建议路由 |
|------|--------------|----------------|---------|
| max 规划 (天权/天府/天璇) | plan | code_edit | 强模型 (primary) |
| 执行 (天梁/patcher) | patch_proposal | risky_refactor | 可配 flash/cheap |
| 审查 (squadron/verifier) | review/verify | risky_refactor/test_failure_diagnosis | 强模型 |

**路由机制**：`runTeamSkeleton` max 分支派 planner 时用 `kind: 'plan'`，执行波用 `kind: 'patch_proposal'`。`mapWorkOrderKindToCapabilityTask` 把 `plan` 映射到 `code_edit`、`patch_proposal` 映射到 `risky_refactor`。现有 `recommendModelForTask` 已把 `code_edit`/`risky_refactor` 路由到 capable 模型，flash 仅接 `summarization`。

示例 `config.workers`：

```yaml
workers:
  profiles:
    strong: { provider: deepseek, model: deepseek-v4-pro }
    cheap:  { provider: deepseek, model: deepseek-chat-flash }
  routing:
    code_edit: strong          # max 规划用强模型
    risky_refactor: strong     # 执行/审查默认强；如需省成本可改 cheap
    test_failure_diagnosis: strong
```

缺省（无 routing）时规划/执行默认都用强模型，要省成本须显式配 cheap。不改此默认以免影响非 team 委派。

**回归测试**：`team-orchestrator.test.ts` 的 `max mode routes planners via kind=plan and executors via kind=patch_proposal` 锁定此分流行为。
