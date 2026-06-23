# 子代理（Subagent）架构设计文档

> 基于代码级验证。最后更新：2026-06-23（新增 §16 Team 模式）。

## 1. 概览

子代理系统允许主智能体（AgentLoop）将独立任务分派给隔离的 worker 会话执行，实现并行探索、跨模型路由和写隔离。系统由三层组成：

```
┌─────────────────────────────────────────────────────────┐
│  Tool Layer        delegate_task / delegate_batch        │
├─────────────────────────────────────────────────────────┤
│  Coordination      DelegationCoordinator                │
│  Layer             ├─ WorkOrder 创建 & 预算             │
│                    ├─ Profile → Role 分类                │
│                    ├─ Model 选择（Capability Cards）     │
│                    ├─ CollaborationProtocol（锁 + 合并） │
│                    └─ AggregationPolicy 聚合             │
├─────────────────────────────────────────────────────────┤
│  Execution         ┌─ readonly → runWorkerSession        │
│  Layer             └─ hands    → runHandsSession         │
│                    (git worktree 隔离)                    │
└─────────────────────────────────────────────────────────┘
```

**核心文件清单**：

| 文件 | 职责 |
|------|------|
| `src/tools/delegate-task.ts` | 单任务委派工具定义与执行 |
| `src/tools/delegate-batch.ts` | 并行批量委派工具定义与执行 |
| `src/agent/coordinator.ts` | 委派协调器：调度、锁、冲突检测、升级 |
| `src/agent/work-order.ts` | WorkOrder zod schema 与工厂函数 |
| `src/agent/profile-registry.ts` | Worker profile 注册表（内置 + 用户自定义） |
| `src/agent/worker-session.ts` | 只读 worker 会话执行 |
| `src/agent/hands-session.ts` | 写 worker 会话执行（含 worktree） |
| `src/agent/worktree-coordinator.ts` | Git worktree 生命周期管理 |
| `src/agent/worker-prompts.ts` | Worker prompt 构建 & 结果打包 |
| `src/agent/aggregation.ts` | 结果聚合策略（5 种 policy） |
| `src/agent/work-queue.ts` | 批量任务队列（并发、去重、依赖） |
| `src/agent/semantic-lock.ts` | 语义锁管理器（意图级锁定） |
| `src/agent/deadlock-detector.ts` | 死锁检测（Wait-For Graph DFS） |
| `src/agent/merge-protocol.ts` | 三级合并策略（cherry-pick → rebase → escalate） |
| `src/agent/collaboration-protocol.ts` | 协作门面：锁 + 死锁 + 合并 |
| `src/agent/coordination-policy.ts` | Profile → Role 分类策略 |
| `src/agent/coordinator-state.ts` | 协调器状态（事件追踪、失败预算） |
| `src/agent/worker-evidence.ts` | Worker 结果证据验证 |

---

## 2. Worker Profile 与 Role

### 2.1 Profile（6 种）

| Profile | Role | 允许的工具 | 典型用途 |
|---------|------|-----------|---------|
| `code_scout` | readonly | READ_ONLY_TOOLS（9 个） | 代码搜索、结构探索 |
| `doc_scout` | readonly | READ_ONLY_TOOLS | 文档研究、规格查阅 |
| `planner` | readonly | READ_ONLY_TOOLS | 制定计划、方案设计 |
| `reviewer` | readonly | READ_ONLY_TOOLS | 代码审查、质量评估 |
| `verifier` | hands | WRITE_TOOLS（13 个） | 测试验证、运行检查 |
| `patcher` | hands | WRITE_TOOLS | 编写补丁、编辑文件 |

**工具集定义**：

- **READ_ONLY_TOOLS**（9 个）：`read_file`, `read_section`, `glob`, `grep`, `diff`, `inspect_project`, `repo_map`, `repo_graph`, `related_tests`
- **WRITE_TOOLS**（13 个）：READ_ONLY_TOOLS + `edit_file`, `write_file`, `bash`, `run_tests`
- **Delegation Tools**（仅 brain role）：`delegate_task`, `delegate_batch`（当前未分配给任何内置 profile）

### 2.2 Role 决定隔离级别

| Role | 隔离 | Session Runner | 说明 |
|------|------|---------------|------|
| `readonly` | 无隔离 | `runWorkerSession` | 只读操作，无需 git worktree |
| `hands` | git worktree | `runHandsSession` | 写操作，在独立 worktree 中执行 |
| `brain` | 无隔离 | — | 仅分配 delegation 工具（当前预留） |

### 2.3 ProfileRegistry

支持用户自定义 profile，通过 `.rivet/agents/*.md` YAML frontmatter 加载：

```yaml
# .rivet/agents/custom-reviewer.md
name: security-reviewer
expertisePrompt: "Focus on security vulnerabilities..."
role: readonly
allowedTools: [read_file, grep, glob]
```

内置 profile 不可被覆盖。`ProfileRegistry` 为每个 profile 提供 `expertisePrompt` 和 `allowedTools`。

---

## 3. WorkOrder（工单）

### 3.1 Schema

WorkOrder 是一个 zod-validated 的 14 字段 schema：

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | string | 自动生成 `wo_{UUID}` |
| `parentTurnId` | string | 父 turn ID |
| `kind` | WorkOrderKind (6) | 任务类型 |
| `profile` | WorkerProfile (6) | Worker 角色配置 |
| `objective` | string | 任务目标描述 |
| `scope` | WorkOrderScope | 作用域（files, symbols, maxFiles, maxTokens） |
| `constraints` | string[] | 约束条件 |
| `allowedTools` | string[] | 由 ProfileRegistry 解析 |
| `disallowedTools` | string[] | PHASE1 列表（只读）或仅 delegation（写） |
| `dedupeKey` | string | 去重键：`kind:files` 或 `write:files` |
| `dependencies` | string[] | 依赖的工单 ID |
| `aggregationPolicy` | AggregationPolicy (5) | 结果聚合策略 |
| `budget` | WorkerBudget | maxTurns, maxTokens, timeoutMs, maxRetries |
| `domain` | DomainArea (7) | 可选领域分类 |
| `workerCwd` | string | 可选工作目录 |

### 3.2 WorkOrderKind（6 种）

| Kind | 说明 | CapabilityTask 映射 |
|------|------|-------------------|
| `code_search` | 代码搜索 | `repo_summarization` |
| `doc_research` | 文档研究 | `repo_summarization` |
| `plan` | 方案规划 | `code_edit` |
| `review` | 代码审查 | `risky_refactor` |
| `verify` | 测试验证 | `test_failure_diagnosis` |
| `patch_proposal` | 补丁提案 | `risky_refactor` |

### 3.3 Budget 默认值

| 维度 | 只读 | 写 |
|------|------|-----|
| `maxTurns` | 8 | 8 |
| `maxTokens` | 4,096 | 16,384 |
| `timeoutMs` | 180,000 (3min) | 180,000 (3min) |
| `maxRetries` | 2 | 1 |

### 3.4 去重

每个 WorkOrder 基于 `dedupeKey` 去重，格式为 `${kind}:${files.join(',')}` 或 `${kind}:${objective}`。同一 dedupeKey 不会被重复执行。

---

## 4. 委派流程

### 4.1 入口门禁

`shouldDelegateObjective(objective, scope)` 判断是否值得委派：
- objective 长度 ≥ 6 个词，**或**
- scope.files ≥ 2，**或**
- scope.symbols ≥ 2

不满足条件则跳过委派，返回 `{ status: 'skipped' }`。

### 4.2 单任务流程（delegate_task）

```
用户调用 delegate_task(objective, kind?, profile?, files?, symbols?)
    │
    ▼
1. validatePathSafe — 校验文件路径在项目内
2. coordinator.delegate(DelegationRequest)
    │
    ▼
3. shouldDelegateObjective — 入口门禁
4. createReadOnlyWorkOrder / createWriteWorkOrder
5. delegateOrder(order)
    │
    ├─ classifyProfile → role
    ├─ acquireLock (CollaborationProtocol)
    ├─ scope budget check (maxFiles gate)
    ├─ selectModel (routing → capability cards)
    ├─ filterToolRegistry → order.allowedTools
    ├─ dispatch: runWorker / runHands
    ├─ releaseLock
    ├─ checkEscalation (≥3 连续失败)
    └─ aggregateResults
    │
    ▼
6. extractClaims → 写入 ContextClaimStore
7. 返回 CoordinatorRun.packet
```

### 4.3 批量流程（delegate_batch）

```
用户调用 delegate_batch(tasks[], policy?)
    │
    ▼
1. validatePathSafe — 校验所有任务文件路径
2. progressiveTaskCap — 渐进式任务上限
   - turn 0-1: 最多 1 个任务
   - turn 2-4: 最多 3 个任务
   - turn 5+:  最多 5 个任务
3. coordinator.delegateBatch(requests[], policy)
    │
    ▼
4. WorkOrderQueue 管理：
   - enqueue (去重 + 优先级排序)
   - dequeue (依赖检查 + 文件冲突检查)
   - markInFlight / markCompleted / markFailed
5. Promise.all 并行执行
6. aggregateResults(results, policy)
7. 返回 packet + 可选 trim 通知
```

### 4.4 渐进式超时

| Turn 范围 | delegate_task | delegate_batch |
|-----------|--------------|----------------|
| 0-1（冷启动） | 30s | 45s |
| 2-4（预热） | 75s | 90s |
| 5+（成熟） | 180s | 180s |

设计意图：早期 turn 的委派通常是探索性的（简单、快速），不需要长超时；后续 turn 的任务更复杂，需要更多时间。

---

## 5. Worker Prompt 与结果打包

### 5.1 Prompt 构成

`buildWorkerPrompt(order)` 组装以下部分：

1. **Identity Header** — 能力检测标识
2. **Profile Expertise** — 从 ProfileRegistry 获取（fallback 到硬编码 PROFILE_PROMPTS）
3. **Project Discovery Preamble**（仅只读 worker）— 项目发现引导
4. **Task Section** — objective / scope / constraints / allowedTools
5. **Worktree CWD Guidance**（仅写 worker）— worktree 工作目录指引
6. **Result Shape JSON Template** — 期望输出的 JSON 结构模板
7. **Authority Suffix**（可选）— 授权说明

### 5.2 结果模板

两种模板，根据 worker 是否有写工具自动选择：

**只读模板**：`findings`, `examinedFiles`, `risks`, `nextActions`（无 verification / patchSummary）

**写模板**：额外包含 `verification`（command / status / exitCode / passed / failed / skipped / durationMs）和 `patchSummary`。

### 5.3 Packet 大小控制

`buildPrimaryWorkerPacket(results[])` 将 WorkerResult[] 打包为 `<worker_results>` XML 包裹的 JSON 字符串，三级大小控制：

| 层级 | 策略 | 阈值 |
|------|------|------|
| L1 | 单 artifact 内容截断 | 2,000 chars |
| L2 | 包文总大小上限 | 32,000 chars |
| L3 | 渐进裁剪字段 | examinedFiles → risks → nextActions → verification |

空数组、空字符串、undefined 在打包前被 stripEmpty 清除。

### 5.4 Repair Prompt

当 worker 返回的 JSON 解析失败时，`buildWorkerRepairPrompt` 取最后 4,000 chars 的输出尾部构建修复 prompt，让模型重试生成合法 JSON。

---

## 6. 结果聚合

### 6.1 五种 AggregationPolicy

| Policy | 行为 | 适用场景 |
|--------|------|---------|
| `primary_decides` | 默认，仅做证据验证门禁 | 单任务 / 信任主 worker |
| `all_required` | 所有 worker 都必须通过，任一失败则全部标记失败 | 关键路径任务 |
| `first_success` | 返回第一个通过的 worker 结果 | 快速探索 |
| `majority` | 按状态多数表决，过滤到多数派 | 冗余验证 |
| `weighted_confidence` | 在通过的结果中选 confidence 最高的 | 质量优先 |

> **注意**：`weighted_confidence` 是合法的 AggregationPolicy 类型，但当前工具 schema 中未暴露（delegate_batch 的 policy 参数只有 4 个选项）。

### 6.2 证据验证

所有聚合路径都先经过 `verifyWorkerEvidence(result, profile)` 门禁——验证 worker 的发现是否有充分证据支撑。

---

## 7. 协作层（Collaboration Layer）

### 7.1 语义锁（Semantic Lock）

**文件**：`src/agent/semantic-lock.ts`

**机制**：基于操作意图的咨询锁（advisory lock），使用 5×5 兼容矩阵：

| | edit | create | delete | rename | refactor |
|---|---|---|---|---|---|
| edit | **exclusive** | conditional | exclusive | exclusive | conditional |
| create | conditional | compatible | exclusive | conditional | conditional |
| delete | exclusive | exclusive | exclusive | exclusive | exclusive |
| rename | exclusive | conditional | exclusive | compatible | conditional |
| refactor | conditional | conditional | exclusive | conditional | compatible |

- **compatible** → 允许并发
- **conditional** → 允许获取锁，但后续检查冲突梯度
- **exclusive** → 阻塞

**特性**：
- TTL 过期（默认 1h），后台 sweep 每 30s 清理僵尸锁
- Heartbeat 续期机制
- `acquireAll()` 原子性：任一冲突则全部回滚

### 7.2 死锁检测（Deadlock Detector）

**文件**：`src/agent/deadlock-detector.ts`

**机制**：
1. 构建 Wait-For Graph（sessionId → 被阻塞的锁）
2. DFS 三色标记（WHITE / GRAY / BLACK）检测环
3. 发现环时选择 victim（当前用字典序最大 sessionId）并释放其锁

**已知局限**：victim 选择用字典序而非时间戳，UUID 场景下接近随机。

### 7.3 合并协议（Merge Protocol）

**文件**：`src/agent/merge-protocol.ts`

三级瀑布合并策略，用于 hands worker 的 worktree 合并：

| 级别 | 策略 | 条件 | 失败处理 |
|------|------|------|---------|
| L1 | autoCherryPick | 无文件重叠 | → L2 |
| L2 | smartRebase | `git apply --3way`（整体然后逐文件） | → L3 |
| L3 | escalate | 生成 markdown 冲突报告 | 人工介入 |

所有 git 操作使用 async spawn（非 execSync），临时 `.patch` 文件在 try/catch 中清理。

### 7.4 CollaborationProtocol（门面）

**文件**：`src/agent/collaboration-protocol.ts`

统一入口，协调以上三个模块：
- `acquireLock()` → SemanticLockManager + emit 事件
- `onWorkerComplete()` → 冲突评估 → MergeQueue → 合并协议 → 释放锁
- 后台：heartbeat 续期 + TTL sweep

---

## 8. WorkOrderQueue（批量任务队列）

**文件**：`src/agent/work-queue.ts`

| 能力 | 说明 |
|------|------|
| 并发控制 | `maxConcurrency` 上限（默认 Infinity） |
| 去重 | `dedupeKey` 防止重复入队 |
| 依赖排序 | dequeue 时检查 dependencies 是否全部 completed |
| 文件冲突检测 | in-flight 任务的 scope.files 不能与新任务重叠 |
| 优先级 | 入队时指定 priority，dequeue 优先出队高优先级 |
| 事件系统 | enqueue / dequeue / completed / failed 四种事件 |

---

## 9. 模型选择

Coordinator 使用两级策略为 worker 选择模型：

1. **显式路由**：检查 `WorkerRouteConfig.routing` 配置
2. **Capability Cards 回退**：通过 `recommendModelForTask(task, modelCards)` 选择

Physarum 风格路由：ProviderHealthTracker 追踪 provider 健康，冷启动 tier 的 provider 会被排除。

---

## 10. 升级与熔断

### 10.1 连续失败升级

CoordinatorState 追踪连续失败次数：
- 达到 `maxFailures`（默认 3）时触发 `shouldEscalate()`
- 结果被覆盖为 `{ status: 'blocked' }`，附带升级消息

### 10.2 Scope Budget Gate

对 `code_search` / `doc_research` / `plan` 类型的工单：
- 如果 `scope.files.length > scope.maxFiles`，立即返回 blocked，不运行 worker

---

## 11. Claim 提取

Worker 完成后，结果中的 findings 会被提取为 `worker_finding` 类型的 ContextClaim：

| finding.confidence | claim.confidence | claim.fitness |
|--------------------|-----------------|---------------|
| high | 0.85 | 5 |
| medium | 0.7 | 3 |
| low | 0.55 | 2 |

这些 claims 写入 ContextClaimStore，供后续 turn 的 recall 查询使用。

---

## 12. 完整数据流图

```
                        主智能体 (AgentLoop)
                              │
                  ┌───────────┼───────────┐
                  │           │           │
            delegate_task  delegate_batch  (其他工具)
                  │           │
                  ▼           ▼
         DelegationCoordinator
                  │
    ┌─────────────┼─────────────┐
    │             │             │
    ▼             ▼             ▼
WorkOrder    Collaboration   Model
创建          Protocol       选择
    │         (锁+合并)      │
    │             │          │
    ▼             ▼          ▼
    ├─ readonly ──► runWorkerSession ──► API 调用
    │                                     │
    └─ hands ────► runHandsSession        │
                    │ (worktree)          │
                    └────────────────────►│
                                          │
                                          ▼
                                     WorkerResult[]
                                          │
                              ┌───────────┼───────────┐
                              │           │           │
                          aggregateResults  │       extractClaims
                              │           │           │
                              ▼           ▼           ▼
                        buildPrimaryWorkerPacket  ContextClaimStore
                              │
                              ▼
                        返回给主智能体
                        (作为工具结果)
```

---

## 13. 已知局限与改进方向

### 13.1 已知局限

1. **weighted_confidence 未暴露**：AggregationPolicy 类型支持 5 种策略，但 delegate_batch 工具 schema 只暴露了 4 种。
2. **Deadlock victim 选择**：用字典序选 victim，UUID 场景接近随机，应改为基于时间戳或工作量估算。
3. **PROFILE_PROMPTS 死代码**：`worker-prompts.ts` 中的硬编码 PROFILE_PROMPTS 被 ProfileRegistry 的 expertisePrompt 遮蔽，内置 profile 永远不会使用硬编码版本。
4. **brain role 预留**：planner 被分类为 readonly 而非 brain，delegation 工具未分配给任何内置 profile。

### 13.2 改进方向

1. **Profile 增强描述**：将硬编码 PROFILE_PROMPTS 中的详细方法论合并到 ProfileRegistry，让 worker 获得更丰富的指导。
2. **weighted_confidence 开放**：在工具 schema 中暴露第 5 种聚合策略。
3. **Victim 选择策略**：改为基于 lock 获取时间或 worker 进度估算。
4. **Worktree 清理**：确保 hands worker 异常退出时 worktree 被正确清理。

---

## 14. 测试覆盖

| 模块 | 测试文件 | 测试数量（约） |
|------|---------|-------------|
| CollaborationProtocol | `collaboration-protocol.test.ts` | 20 |
| Semantic Lock | `semantic-lock.test.ts` | 19 |
| Deadlock Detector | `deadlock-detector.test.ts` | ~10 |
| Merge Protocol | `merge-protocol.test.ts` | ~8 |
| Coordinator | `coordinator.test.ts` | ~15 |
| WorkOrder | `work-order.test.ts` | ~12 |
| Worker Prompts | `worker-prompts.test.ts` | ~10 |
| Delegate Batch | `delegate-batch.test.ts` | ~5 |
| Subagent Integration | `subagent-integration.test.ts` | ~20 |
| Worker Knowledge | `worker-knowledge.test.ts` | ~3 |

---

## 15. 相关提交历史（按时间倒序）

| Commit | 说明 |
|--------|------|
| `33efa68` | 加固 plan-mode 安全，修复 YAML 解析 bug，接入 loadFromDirectory |
| `28f7215` | 增大 delegate_task 超时到 180s |
| `86372d9` | 渐进式超时：冷启动 30-45s → 成熟 180s |
| `c72d9fd` | 将 delegate_task + delegate_batch 加入所有 star domain |
| `6e5cf4e` | 新增天枢（tianshu）中心协调域 |
| `fe8a322` | maxWorkers 从 3 增大到 8 |
| `485cfe1` | 跨目录路径预检 + 失败诊断提示 |
| `7000f06` | artifact intercept e2e + delegate_batch worker 隔离测试 |
| `392dece` | CollaborationProtocol 集成到 DelegationCoordinator（20 测试） |
| `f9ab380` | 修复 zod 导入导致 tsx 挂起 + TS narrowing 修复 |
| `edd3e9a` | Worker packet 大小限制 8K chars → 防止上下文膨胀 |
| `a724b4c` | 子代理集成类型漂移测试 |
| `08742d7` | 修复 R1/R2 delegate_batch 缺口 |
| `db67ec7` | P2 创新批：prefix completion, adaptive routing, shadow queue, split policy |
| `f84f390` | 子代理能力参考文档 |

---

## 16. Team 模式（team_orchestrate）

> §1–§15 描述的是 `delegate_task` / `delegate_batch` 这一层「主控直接派 worker」。Team 模式是其**上层编排器**：把一份计划拆成多波（wave）、按文件冲突与依赖排程、逐波派发并在末波做交付综合。它复用下层 `delegateBatch`，不替代。

### 16.1 逐波重入模型

`team_orchestrate` 是**逐波重入**的：每次调用只派一波，返回后由主控集成该波的 diff，再以 `fromWave++` 调下一波。

```
team_orchestrate(plan, fromWave=0)
    │  parse plan → tasks → groupTeamTasks → waves[]
    ▼
dispatchWaveAt(fromWave) ── delegateBatch(wave.tasks, 'all_required')
    │
    ▼  返回 [wave X/Y] packet；主控集成 diff
fromWave++ 再调 ──► … ──► 末波：review gate + episode 闭环 + 交付综合
```

**核心文件**：

| 文件 | 职责 |
|------|------|
| `src/tools/team-orchestrate.ts` | 工具入口：解析计划、逐波派发、末波 review/episode/交付综合 |
| `src/agent/team-orchestrator.ts` | `runTeamSkeleton` / `dispatchWaveAt`：骨架与单波派发 |
| `src/agent/team-grouping.ts` | `groupTeamTasks`：文件冲突 + 依赖感知的波分组 |
| `src/agent/team-plan.ts` | 计划解析（Markdown / UnifiedPlan → TeamTask[]） |
| `src/agent/team-episode.ts` | 跨波 episode 聚合 + **`formatTeamDelivery` 交付综合** |
| `src/agent/reward-loop.ts` | `buildTeamEpisodeFromStore` / episode reward 闭环 |
| `src/tui/team-panel-model.ts` | TeamPanel 读模型 + **`overlayFleetStatus` 实时叠加** |
| `src/tui/fleet-registry.ts` | 事件流驱动的 per-worker 实时读模型 |
| `src/tui/format/team-panel.ts` | TeamPanel ANSI 渲染（含进度条 / live 行） |

### 16.2 波分组（grouping）

`groupTeamTasks` 把 task 列表分成有序的 wave，规则：

- **依赖**：`dependsOn` 未满足的 task 推迟到后续波。
- **文件冲突**：同一波内 task 的 `files` 不重叠；触碰相同文件的 task 被串行化到不同波。
- 同波内的 task 并行派发（`delegateBatch('all_required')` —— 任一失败则该波失败）。

### 16.3 并发与深度（可配置 · P4）

| 配置项（`agent` 段） | 默认 | 范围 | 作用 |
|----------------------|------|------|------|
| `maxTeamParallel` | 3 | 1..5 | 单波默认并发 worker 数（`input.maxParallel` 未传时回退到它） |
| `maxDelegationDepth` | 2 | ≥1 | 委派嵌套深度上限（worker 再派 sub-worker）；超限 fail-closed 返回 blocked |

`maxTeamParallel` 经 `createTeamOrchestrateTool(coordinator, { defaultMaxParallel })` 注入；`maxDelegationDepth` 经 `DelegationCoordinatorConfig.maxDelegationDepth` 注入，`coordinator.ts` 内用 `this.config.maxDelegationDepth ?? MAX_DELEGATION_DEPTH`（常量保留为默认，未配置时行为不变）。两者均在 `bootstrap.ts` 装配处从 `config.agent.*` 透传。

### 16.4 末波闭环

仅**最后一波**触发以下三步（非末波行为不变）：

1. **Review gate**：对跨模块 / 修复类的累计 changedFiles 跑 `routeReviewWorkflow`，产出 `reviewVerdict` 追加到返回。
2. **Episode 闭环**：`recordTeamEpisodeClosureFromStore` 以末波遥测为锚，从 reward store 捞回本 objective 的全部波片段，按 `byWave` 聚合成 `TeamEpisode` 并落 episode 级 reward closure（晋升闸的生产者）。
3. **交付综合（P2）**：`buildTeamEpisodeFromStore` 复用同一聚合得到 episode，`formatTeamDelivery(episode)` 渲染单一交付报告追加到返回 `content` —— 确定性、零模型成本、prefix-cache 安全。

`formatTeamDelivery` 报告含：各波任务与通过数、累计 changedFiles、**被多波触碰的文件（冲突面）**、整体 review/verification 裁决。

### 16.5 实时舰队任务板（TeamPanel · P5）

TUI 内纯读投影，不改调度：

- 派发前 `team_orchestrate` 先流式吐一个全 `waiting` 的 wave/task DAG（`onPlanReady`）。
- 运行中 `engine/app.ts` 用 `overlayFleetStatus(model, fleet.getWorkers())` 把 `FleetRegistry` 的 per-worker 实时态叠加回面板：经 `taskIdFromActivity` 映射 worker→task，升级 status（`waiting→running→done/failed`，rank 保护不降级），附 `elapsedMs` / 最新 activity 行。
- **依赖解锁可视化**：deps 全部 `done` 的 `waiting` task 标 `ready · deps met`。
- **组进度条**：渲染层按 task done 计数派生 `[████░░] n/total done`。

### 16.6 测试覆盖（team 专属）

| 模块 | 测试文件 |
|------|---------|
| Team 编排骨架 / 波派发 | `team-orchestrator.test.ts` |
| Team 工具入口 | `team-orchestrate.test.ts` |
| Episode 聚合 + 交付综合 | `team-episode.test.ts`（含 `formatTeamDelivery`） |
| Episode 闭环 | `team-episode-closure.test.ts` / `reward-loop.test.ts` |
| TeamPanel 叠加 + 进度条 | `team-panel-overlay.test.ts` |
| FleetRegistry 读模型 | `fleet-registry.test.ts` |

### 16.7 已知边界

- **交付综合仅末波触发**；中途波只返回 `[wave X/Y] packet`。
- **LLM 级解冲突未做**（可选升级）：当前冲突面只是「被多波触碰的文件」清单，不派 reviewer worker 读全 diff 做语义解冲突——成本更高，暂不在默认范围。
- Team 不自行 commit；worker diff 由主控集成。
