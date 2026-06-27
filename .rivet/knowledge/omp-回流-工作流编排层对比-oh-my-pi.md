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

### 优化点 3：认知层接入方式——经核实，已完成 ~70%，Pi 方案不适用 ⚠️ 不建议做

> **更新（两轮深挖核实后）**：本节原建议"在已有钩子基础设施上扩展认知层解耦"。经三个探索 agent 完整测绘 + 代码核实，**结论推翻**——认知解耦已完成约 70%，Pi 方案不适用，无高性价比可做项。详见下方核实记录。

**核实结论**：

1. **天枢认知解耦已完成 ~70%**——loop.ts 对认知模块的 import 大多是 **type-only**（`import type { Sensorium }`）或 **LIFECYCLE 构造**（`new EvidenceTracker()`），不是 turn-step 耦合。真正的 turn-step 调用（traceStore/convergence/perception/getDoomLoopLevel/latestConvergenceResult）**都已经走 deps**（loop-factory 注入）。

2. **Pi 的 CognitiveController 方案不适用天枢——三个结构性阻断**：
   - **trace-store 是函数式不可变**（`recordToolFingerprint(store, fp): TraceStore` 返回新 store），不是 Pi 的 `traceStore.record()` OOP 可变类。照搬 Pi 要重写 trace-store + 6 个 pipeline 重赋值点。
   - **perception 已有独立 controller**（`TurnPerceptionController` + 18 字段 deps bag），再套一层 aggregator 是冗余。
   - **convergence 需要 split/abort 控制流**，advisoryBus 是 fire-and-forget 文本，承载不了控制流。

3. **73cd8713 迁移模板有效但范围窄**——它适用于"advisory 类信号"（文本提示），不适用于需控制流的 convergence 反应。而且 convergence 的 kick **已经走 advisoryBus 了**（loop.ts:1210/1227），通道是对的。

4. **已知债务：5 个僵尸状态字段**（`vigorState`/`currentSeason`/`currentSeasonIntensity`/`sensoriumSnapshots`/`thetaState`）——loop.ts 声明但内部零读写，真正读写者是 turn-step-producer.ts（通过 `this.self.X`）。但单独迁移无收益，应等 producer 整体 deps 化时一起做。

5. **不值得做的大重构：TurnStepProducer deps 化**——producer 通过 `this.self.X` 访问 60+ 个不同字段，是所有 controller 里唯一持有 god-object 引用的离群点。改成 deps bag 是数千行改动、高风险、无运行时收益。agent 报告："这不是缺陷，是权衡——它需要 60+ 字段，deps bag 会比 this.self 更冗长。"

**为什么不做**：为了凑"完成清单"而硬做 producer deps 化或僵尸字段归位都是负优化。Pi 的 CognitiveController 对 Pi 有效是因为 Pi 的架构不同，天枢走了 deps 注入的路且已走 70%。**剩余耦合要么合理（convergence 反应需 loop 服务），要么规模过大不值得（producer 60 字段 deps 化）。**

**未来触发条件**：当 producer deps 化有独立驱动力（多 producer 实例、producer 独立测试）时，连同僵尸字段一起做，才是对的时机。

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

**结论（核实后修订）**：天枢的分层方向没错，层与层之间的边界已基本切干净（优化点 1/2 已完成）。认知层耦合经核实**已通过 deps 注入解决 ~70%**，Pi 方案不适用——见优化点 3 的核实记录。优化不是"变扁"，是"把层切干净"，而天枢已经走了大部分这条路。

## 实施优先级（核实后修订）

| 优化点 | 价值 | 改动 | 风险 | 建议 | 状态 |
|--------|------|------|------|------|------|
| 1 tool-execution 去重 | 中（去 50 行重复）| 小 | 低 | 做 | ✅ 完成（cb240549）|
| 2 loop/orchestrator 边界 | 高（消除怪圈）| 中 | 中 | 做阶段 1+2 | ✅ 阶段 1+2 完成，阶段 3 待评估 |
| 3 认知层 hook 解耦 | ~~高~~→**经核实无高性价比项** | ~~大~~ | ~~中~~ | **不做**（已解耦 70%，Pi 方案不适用）| ⚠️ 标记完成（核实结论）|
| 4 loop-factory DI | 低 | 小 | 低 | 配合 1/2 顺手 | ✅ 随阶段 1+2 完成 |

**修订总结**：优化点 1 已完成；优化点 2 阶段 1+2 完成（断 goalTracker 循环 + 删 trivial forwarder），阶段 3（runConvergenceCheck 迁移）待评估；优化点 3 经两轮深挖核实，认知解耦已通过 deps 注入完成 70%，剩余耦合合理或规模过大不值得，**不做**；优化点 4 随 1/2 顺手完成。

工作流层的可优化项已基本落地。剩余的 runConvergenceCheck 迁移（优化点 2 阶段 3）和 TurnStepProducer deps 化是已知债务，等有独立驱动力时再做。

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
