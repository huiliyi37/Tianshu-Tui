# Rivet Execution Resilience Layer 设计

## 背景

用户目标：已完成 Glanceable Cockpit + XML Protocol + Speculative Pre-warming + Sub-agent Orchestration 四个方案的实施，需要继续补强终端的任务开发能力，借鉴 openclaw agent 项目的优点进行能力改造。

当前 Rivet agent loop 状态：
- `loop.ts` 411 行，`run()` 方法 240 行，已承载 8+ 正交关注点（compaction、approval、prewarm、checkpoint、evidence、failure-classification、tool-history、context-ledger）
- Tool 执行串行（`for...of` 遍历 tool_use blocks）
- Tool 失败直接返回 `is_error`，无重试层（浪费整个 turn）
- 无执行轨迹记录（debug 困难）
- 无显式/隐式规划（模型在长任务中容易迷失）

OpenClaw 可借鉴的设计模式：
1. **Harness 抽象** — 将"执行一次 turn"封装为独立单元，支持 retry、fallback、trace
2. **Trajectory Recording** — 全量执行轨迹独立于 context window，用于事后分析
3. **Tool availability expressions** — 声明式条件控制 tool 可见性
4. **Model fallback with cooldown probe** — 失败后冷却+探测恢复

关键约束：
- 不破坏 97% DeepSeek prefix cache hit rate
- loop.ts 不能更胖（必须减负）
- 355 tests 继续 pass
- 不依赖 DeepSeek 返回多 tool_use（频率未验证）

---

## 设计哲学："执行韧性 = 状态感知 + 智能重试 + 轨迹可追溯"

核心洞察：agent 长任务失败的根因不是"缺少某个 tool"，而是：
1. **Turn 浪费** — transient error 消耗整个 turn（API roundtrip + token 计费）
2. **状态迷失** — 模型不知道"我已经做了什么、还剩什么"
3. **Debug 黑箱** — 失败后无法追溯决策链

解决路径：不做全面 middleware 重构（成本高、风险大），而是引入 **TurnHarness** 作为 loop.ts 的执行代理——loop 负责编排，harness 负责执行韧性。

---

## 推荐方案

### 总体架构变化

```text
Before:
  AgentLoop.run()
    └── for each turn:
        ├── compaction check
        ├── API stream → collect tool_use blocks
        ├── for each tool_use: execute serially
        │   ├── approval check
        │   ├── execute tool
        │   ├── record history
        │   └── checkpoint
        └── next turn

After:
  AgentLoop.run()
    └── for each turn:
        ├── compaction check
        ├── TurnHarness.execute(messages)
        │   ├── API stream → collect tool_use blocks
        │   ├── for each tool_use:
        │   │   ├── approval check
        │   │   ├── execute tool (with retry for transient errors)
        │   │   ├── record trajectory entry
        │   │   └── checkpoint
        │   └── return TurnResult
        ├── update task-state from trajectory
        └── inject <task-progress> into volatile context
```

### 组件 1：TurnHarness

```typescript
// src/agent/turn-harness.ts
export interface TurnResult {
  toolResults: ToolResultEntry[]
  trajectory: TrajectoryEntry[]
  retriedCount: number
  turnDurationMs: number
}

export interface TurnHarnessConfig {
  maxRetries: number          // default 1
  retryableClasses: string[]  // from failure-classifier
  onBeforeTool?: (name: string, input: Record<string, unknown>) => void
  onAfterTool?: (name: string, result: string, isError: boolean) => void
  onToolError?: (name: string, error: Error, retryCount: number) => 'retry' | 'skip' | 'abort'
}
```

职责：
- 封装"执行一组 tool calls"的逻辑
- 对 transient error（timeout、ECONNRESET、bash exit 非 0 且 stderr 含 "timed out"）自动重试 1 次
- 记录每个 tool call 的 trajectory entry
- 暴露 hooks（onBeforeTool/onAfterTool/onToolError）供外部扩展

### 组件 2：Trajectory Recorder

```typescript
// src/agent/trajectory.ts
export interface TrajectoryEntry {
  turn: number
  tool: string
  target: string
  durationMs: number
  status: 'success' | 'failed' | 'retried-success' | 'retried-failed'
  errorClass?: string  // from failure-classifier
  inputSummary: string // first 100 chars
  resultSummary: string // first 200 chars
}

export class TrajectoryRecorder {
  record(entry: TrajectoryEntry): void
  getEntries(): TrajectoryEntry[]
  summarize(): { totalTools: number; failures: number; retries: number; avgDurationMs: number }
  exportJson(): string
}
```

职责：
- 记录每个 tool 执行的结构化轨迹
- 不进入 context window（独立存储）
- 支持导出为 JSON（用于事后分析）
- 提供 summarize() 供 SummaryBar 展示

### 组件 3：Task State Extractor

```typescript
// src/agent/task-state.ts
export interface TaskState {
  completed: string[]   // "read src/auth.ts", "edited middleware"
  current: string       // "running tests"
  remaining: string[]   // inferred from model's text
  confidence: number    // 0-1, how sure we are about remaining
}

export function extractTaskState(
  trajectory: TrajectoryEntry[],
  lastModelText: string
): TaskState
```

职责：
- 从 trajectory 中提取已完成步骤（tool 执行成功 = 一步完成）
- 从模型最近的 text output 中 regex 提取"接下来我要..."的意图
- 输出结构化 TaskState

### 组件 4：Volatile Context 增强

在现有 volatile context 中新增 `<task-progress>` section：

```xml
<context>
  <!-- existing sections unchanged -->

  <!-- NEW: task progress from trajectory -->
  <task-progress steps="7" completed="5" current="running tests">
    <done>read src/auth.ts</done>
    <done>edited middleware.ts</done>
    <done>wrote test file</done>
    <done>ran typecheck (pass)</done>
    <done>ran tests (2 failed)</done>
    <current>fixing test failures</current>
  </task-progress>
</context>
```

关键设计决策：
- 只展示最近 5 条 completed（避免 token 膨胀）
- 在 volatile block 中（不影响 frozen prefix）
- 只在 turn > 3 时注入（简单任务不需要）

### 组件 5：Enhanced Failure Reflexion

扩展现有 `failure-classifier.ts`：

```typescript
// 现有：返回 string 建议
// 增强：返回结构化 reflexion
export interface FailureReflexion {
  class: FailureClass
  retried: boolean
  suggestion: string
  preventionHint: string  // 注入到下一 turn 的 tool result 中
}
```

当 harness retry 后仍然失败时，将 reflexion 注入 tool result：
```
[Tool execution failed after retry. Error class: timeout.
 Suggestion: The file may be too large. Try reading with offset/limit.
 Prevention: Avoid reading files > 50KB without offset.]
```

---

## 与已有设计的关系

| 已有设计 | 本方案关系 |
|---------|-----------|
| Glanceable Cockpit | Trajectory.summarize() 驱动 SummaryBar 的 step count 和 risk 指标 |
| XML Protocol | `<task-progress>` 是 volatile context 的新 XML section |
| Speculative Pre-warming | Harness 的 onBeforeTool hook 可触发 prewarm |
| Sub-agent Orchestration | Coordinator 可以为每个 worker 创建独立的 TurnHarness |
| Progressive Context Engine | Trajectory 数据可用于 compaction 决策（保留失败 turn 的 reflexion） |

---

## 风险与应对

### 风险 1：Harness 提取导致 loop.ts 行为变化

应对：
- 纯提取重构，不改变行为
- 所有 355 tests 必须 pass without modification
- 先提取，再加新功能（两个独立 commit）

### 风险 2：Task-state 注入增加 token 消耗

应对：
- 最多 6 行 XML（~50 tokens）
- 只在 turn > 3 时注入
- 在 volatile block 中，不影响 prefix cache

### 风险 3：Tool retry 重复执行有副作用的命令

应对：
- 只对 `isConcurrencySafe()` 为 true 的 tool retry（read_file, grep, glob）
- bash 命令默认不 retry，除非 failure-classifier 标记为 transient
- write/edit 操作永不 retry

### 风险 4：Trajectory 内存占用

应对：
- 每个 entry ~200 bytes，100 turns = 20KB
- Session 结束时可选导出到文件
- 不进入 context window

---

## 规格自检

- **占位符检查**：无 TODO、待定
- **内部一致性**：TurnHarness 封装执行 → Trajectory 记录轨迹 → TaskState 从轨迹提取进度 → Volatile 注入进度 → 模型看到进度。链路完整。
- **范围检查**：聚焦执行韧性层，不涉及 TUI 重构、新 tool 添加、模型切换
- **模糊性检查**：retry 条件明确（transient + concurrency-safe）；task-state 注入条件明确（turn > 3）；trajectory 格式有精确 interface

---

## 下一步

创建实施计划，3 个 Phase：
1. Phase 1：TurnHarness 提取 + Tool Retry（1 周）
2. Phase 2：Trajectory Recording + Task State Injection（1 周）
3. Phase 3：Enhanced Failure Reflexion + A/B Validation（1 周）
