# 天枢 × oh-my-pi — 工作流编排层对比与优化建议

> 分析时间: 2026-07-01
> 目标: 对标 oh-my-pi 的扁平工作流设计，识别天枢 turn/工具执行编排层可优化的地方
> 方法: 两个探索 agent 分别完整测绘天枢的分层结构和 Pi 的扁平结构，证据基于 file:line 核实，非主观印象

## 架构哲学对比

| 维度 | 天枢 (opencode-tui) | oh-my-pi |
|------|---------------------|----------|
| turn 流程深度 | **7 层**（run→orchestrator→executeBatch→executeToolUse→harness→registry→tool）| **3 层**（agentLoop→runLoopBody→runTool→tool.execute）|
| 组织方式 | 深度分层 + DI 适配器（loop-factory）| 单个 430 行 `runLoopBody` 函数 + EventStream 总线 + config 注入 |
| 认知层接入 | loop.ts **直接 import** sensorium/convergence/traceStore | **零 import** —— CognitiveController 通过 `AgentLoopConfig` hooks 注入 |
| 输出通道 | 多层 streaming 回调链（client→turn-stream→orchestrator heartbeat→callbacks）| 单一 EventStream 总线（loop 写，caller 读）|
| turn 完整性 | orchestrator 提取是**半截子**（convergence/compaction 仍在 loop.ts）| runLoopBody 是 turn 的**唯一权威**（所有步骤内联）|

**核心差异**：天枢用分层换可测试性（每个 controller 有 DI 缝），Pi 用扁平换可读性（一个函数读完整个 turn）。两者各有代价——天枢付额外跳转和半截边界，Pi 付 god-function 和散落的 abort 逻辑。

## 天枢 turn/tool 执行的完整调用栈（7 层）

```
1. loop.ts:1112              AgentLoop.run()
2. loop.ts:1267              _runInner() → turnOrchestrator.execute()
3. turn-orchestrator.ts:386  TurnOrchestrator.execute() — 真正的 for 循环
4. turn-orchestrator.ts:786  deps.executeBatch() ──┐ (loop-factory.ts:501 转发)
5. tool-execution.ts:162     ToolExecutionController.executeBatch() — 薄转发
6. tool-pipeline.ts:510      executeToolUse() — 真正的 per-tool 编排（1350 行）
7. tool-pipeline.ts:870      deps.harness.executeTool()
8. turn-harness.ts:35        TurnHarness.executeTool() → exec.execute()
9. toolRegistry.execute()    ← 实际工具
```

对比 Pi（3 层）：
```
1. agent-loop.ts:301   agentLoop()
2. agent-loop.ts:717   runLoopBody() — 唯一的循环（含两个嵌套 while）
3. agent-loop.ts:1824  runTool() 闭包 → tool.execute()
```

## 可优化点（按性价比排序）

### 优化点 1：tool-execution.ts 的 makeDeps 重复 + 薄转发 ⭐ 性价比最高

**证据**：`tool-execution.ts:executeBatch`（line 162-310）做两件事：
1. 按 `isConcurrencySafe()`（line 175，调 `toolRegistry.get(name).isConcurrencySafe()`）分区并发/串行
2. 构建 `ToolPipelineDeps` bag 调 `executeToolUse`

`makeDeps()` 块（line 187-238）在串行分支（line 257-310）**逐字重复一遍**，两份 ~50 行只差 `abortSignal` 接线。

**目的地判断（校正）**：分区用的是 `isConcurrencySafe()`——这是**工具级能力查询**，不是 turn 级决策。因此**不该放进 turn-orchestrator**（orchestrator 不应知道哪些工具能并行）。合理的目的地有两个：

- **方案 A（推荐）**：保留 `tool-execution.ts`，但**只消除 makeDeps 重复**——提取一个 `buildDeps(abortSignal)` 函数，两处调用。最小改动，消除 50 行重复，不破坏分层语义。
- **方案 B**：把 executeBatch 并入 `tool-pipeline.ts`（它已掌管 per-tool 编排，且 tool-pipeline.ts:905 已在用 `isConcurrencySafe()`）。tool-pipeline 是工具级编排的天然归属。

loop-factory 的 `executeBatch` 1 行转发（line 501）若并入 tool-pipeline 则一并消除；若走方案 A 则保留。

**收益**：消除 50 行重复（方案 A 必做）；可能砍掉一层转发（方案 B）
**风险**：低（方案 A 几乎零风险；方案 B 需调整 loop-factory 接线）

### 优化点 2：loop.ts ↔ turn-orchestrator.ts 边界不干净

**证据**：turn-orchestrator 的 doc-comment（line 380）承认是从 loop.ts "extracted verbatim"。但提取是**半截子**：
- orchestrator 拿走了 stream/execute/complete
- loop.ts **仍保留** `runConvergenceCheck`（line 1166）、`runCompaction`（line 1255）
- orchestrator 又通过 deps（loop-factory.ts:488-491）调回 loop.ts

这是个怪圈：orchestrator 调用 loop，loop 又是 orchestrator 的创建者。convergence/compaction/replan 是 turn 流程的一部分，却留在 loop.ts。

Pi 的做法：这些是 config hook（`onTurnEnd` 触发 convergence），loop 完全不管 turn 步骤。

**建议**（二选一）：
- 把 convergence/compaction/replan 移进 turn-orchestrator，让它成为 turn 流程唯一权威
- 或学 Pi 做成 hook 注入，loop.ts 只管状态

**当前"提取一半"是最差状态**——改 turn 流程要动两个文件、两处都改不全。
**风险**：中（动了状态归属，需仔细测）

### 优化点 3：认知层接入方式——在已有钩子基础设施上扩展 ⭐ 架构级

**证据**：天枢 loop.ts **直接 import** sensorium/convergence/traceStore 等认知模块，耦合在 loop 层。Pi 的 agent-loop.ts **零 import 认知模块**——全部通过 `CognitiveController.hooks` 注入到 `AgentLoopConfig`。

**校正——天枢已有钩子基础设施，无需从头建**：

天枢已经有一套 partial 的注入通道，认知层解耦应在这之上扩展：

| 已有通道 | 位置 | 性质 | 当前用途 |
|---|---|---|---|
| `advisoryBus` | loop.ts:300（`AdvisoryBus`）| **ephemeral**——provider 可见、不持久、每 user-boundary 重建 | 73cd8713 刚把 signal-consumer 的 search-breadth/task-decomposition 迁移到这里 |
| `appendSystemReminder` | context.ts:166 | **持久**——写入 oaiMessages 尾部 | discipline-reanchor、thinking retry 等 |
| `volatileSwap` / `harnessAdvisoryBlock` | engine.ts:300、VolatileContext | **每 user-boundary 重建**，缓存友好 | advisoryBus 渲染成 `<星域-advisory>` 块落在这里 |

73cd8713 的迁移已经证明这条路走得通：把"直接 injectUserMessage"的认知信号改成"advisoryBus.submit() → harnessAdvisoryBlock"，既 provider 可见又不污染持久消息、不破坏前缀缓存。

**建议**：认知层解耦 = 把 loop.ts 对 sensorium/convergence/traceStore 的直接 import，逐步迁移到通过这三条通道注入：
- convergence 的干预建议（kick/abort）→ 已适配 advisoryBus，扩展更多信号进同一条
- sensorium 的 reasoningEffort → 已有 `getReasoning` 类的钩子模式（create-runtime-hooks 里），抽成认知层注入
- traceStore 的工具指纹记录 → 已有 `recordToolHistory`（tool-pipeline.ts:1086），可抽成 traceStore hook

**这不是另起炉灶，是把已有的迁移模式（73cd8713）推广到更多认知模块**。

**收益**：架构级，让认知层修复更安全、loop.ts 瘦下来、认知模块可独立测试
**风险**：中（接口设计要稳）；**改动大但路径已验证（73cd8713 是模板），建议单独立项**

### 优化点 4：loop-factory.ts 的 DI 适配器成本

**证据**：loop-factory.ts:500-502 三个 delegate 是纯 1 行转发：
```ts
streamTurn: (p) => self.turnStream!.streamTurn(p),
executeBatch: (p) => self.toolExecution.executeBatch(p),
completeTurn: (p) => self.turnCompletion.complete(p),
```
为可测试性留的 DI 缝。代价是每次 turn 步骤过一次适配器跳转。Pi 不用这种适配器——直接持有引用，靠 config 注入做 mock。

**建议**：保留分层的话，至少让 orchestrator 直接持有 controller 引用而非通过 deps-bag 转发。deps-bag 模式在 controller 数量少时是净负担。
**风险**：低；**配合优化点 1/2 顺手做**

## 不建议动的部分

以下分层是**有价值的**，不要为了扁平化丢掉：

- **tool-pipeline.ts（1350 行）**：dense 但都是真活（cerebellar gate/repair/approval/checkpoint/budget/evidence）。不是转发层。
- **turn-harness.ts**：小但做实事（retry + trajectory），cohesive。
- **turn-stream.ts**：dedup/TTSR rules/prewarm 是真逻辑。
- **turn-boundary-abort.ts / turn-budget.ts**：小而纯的工具函数，正确地独立了。
- **abort 集中在 turn-orchestrator**：天枢的 abort 单一权威是优点。Pi 自己承认 abort/budget 散落各处（5 个 `isDeadlineExceeded` 站点、4 个 abort 合并点）是扁平化的代价。**别学 Pi 这个**。

## Pi 设计的得与失（不盲从）

Pi 的扁平化有值得学的，也有不该学的：

**值得学**：
- 认知层 config hook 解耦（优化点 3）
- EventStream 单总线输出（消除多层 streaming 回调链）
- 单函数读完整个 turn 的可读性

**不该学**：
- 430 行 god-function（`runLoopBody`，两个嵌套 while + 8 个内联 phase + 跨 phase 共享可变 locals）
- abort/budget 散落各处（Pi 的 `softEscalations`/`harmonyRetryAttempt`/`pausedTurnContinuations` 等共享状态让边缘 case 难追踪）
- 认知层对 loop 不可见（改认知行为要跨文件追 hook，发现性差）

**结论**：天枢的分层方向没错，但**层与层之间的边界没切干净**（优化点 1/2），且**认知层耦合在 loop**（优化点 3）。优化不是"变扁"，是"把层切干净 + 把耦合解开"。

## 实施优先级

| 优化点 | 价值 | 改动 | 风险 | 建议 |
|--------|------|------|------|------|
| 1 tool-execution 折叠 | 中（去冗余层+50行重复）| 小 | 低 | **先做** |
| 2 loop/orchestrator 边界 | 高（消除怪圈）| 中 | 中 | 第二做 |
| 3 认知层 hook 解耦 | 高（架构级，认知层修复受益）| 大 | 中 | **单独立项** |
| 4 loop-factory DI | 低 | 小 | 低 | 配合 1/2 顺手 |

**总计**：优化点 1 是确定性收益、改动可控，建议立即做。优化点 3 是架构级，但和前面认知层修复（defect 1-5）强相关，值得排期。优化点 2 介于两者之间。优化点 4 顺手。

## 关键文件索引

| 文件 | 角色 | 层数位置 |
|------|------|----------|
| `loop.ts:1112` | run 入口 + 状态持有者（God object）| 第 1 层 |
| `turn-orchestrator.ts:386` | 真正的 turn 循环 | 第 3 层 |
| `tool-execution.ts:162` | **薄转发层**（优化点 1）| 第 5 层 |
| `tool-pipeline.ts:510` | per-tool 重编排（1350 行，真活）| 第 6 层 |
| `turn-harness.ts:35` | retry + trajectory | 第 8 层 |
| `loop-factory.ts:500-502` | **DI 适配器**（优化点 4）| 转发缝 |
| `loop.ts:1166,1255` | convergence/compaction 残留（优化点 2）| 怪圈源 |

Pi 对照：
| 文件 | 角色 |
|------|------|
| `agent-loop.ts:717` | runLoopBody — 唯一循环（430 行 god function）|
| `agent-loop.ts:1706` | executeToolCalls — 内联闭包批处理 |
| `cognitive-controller.ts` | 认知层桥接（hooks 注入，loop 零 import）|
