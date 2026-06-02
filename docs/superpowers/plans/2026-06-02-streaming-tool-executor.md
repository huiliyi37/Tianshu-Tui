# 边流边执行（Streaming Tool Executor）实现计划

> **面向 AI 代理：** 使用 subagent-driven-development（推荐）或 executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 在模型流式生成时，一旦某个 `tool_use` 块的参数 JSON 解析完整，立即并发执行该工具，将长耗时工具（bash 编译、网络请求等）的延迟与模型后续生成重叠。

**架构：** 在 `TurnStreamController` 与 `ToolExecutionController` 之间插入 `StreamingToolExecutor`，接管 `onContentBlock` 中 tool_use 的即时执行。流结束后，`loop.ts` 只需等待已启动的执行完成。现有 `executeBatch` 的分区逻辑（concurrency-safe 并行组）保留，改为流式触发。

**技术栈：** TypeScript strict, node:test + node:assert/strict

**关键风险：** 审批中断流、并发冲突、顺序依赖、缓存前缀破坏 — 详见 §3。

---

## 1. 范围检查

此功能修改三个子系统，但改动集中在同一数据流路径上，建议单计划执行：

| 子系统 | 改动类型 |
|--------|---------|
| `turn-stream.ts` | 添加流中工具执行回调 |
| `tool-execution.ts` | 新增 `executeStreaming()` 方法，复用现有并发分区逻辑 |
| `loop.ts` | 流结束后等待 + 结果收集 |

---

## 2. 文件结构

| 文件 | 操作 | 职责 |
|------|------|------|
| `src/agent/streaming-executor.ts` | 创建 | 流式工具执行器：接收 tool_use → 审批判断 → 排队或立即执行 |
| `src/agent/__tests__/streaming-executor.test.ts` | 创建 | 单元测试：自动审批、手动审批、并发分区、错误处理 |
| `src/agent/turn-stream.ts` | 修改 | `streamTurn()` 接收 `StreamingExecutor`；`onContentBlock` 中触发执行 |
| `src/agent/tool-execution.ts` | 修改 | 将并发分区逻辑提取为 `partitionTools()`，`StreamingExecutor` 复用 |
| `src/agent/loop.ts` | 修改 | 流结束后 `await executor.drain()` 收集结果；不再调用 `executeBatch` |

---

## 3. 风险分析与缓解

### 3.1 审批阻断流（Critical）

**场景：** 模型正在流式生成，突然弹出一个需要用户确认的审批弹窗。如果用户在忙其他事，整个流的进度被阻塞。

**影响：** `manual` 模式下每个 tool_use 都需要审批 → 流式执行完全无法并行；`auto-safe` 模式下的高风险工具同理。

**缓解：** `StreamingExecutor` 分级处理：
- **Level 0 (auto-accept)**：立即执行，不等待任何审批
- **Level 1 (auto-safe, low risk)**：立即执行
- **Level 2 (auto-safe, high risk)**：加入等待队列，流结束后统一弹出审批
- **Level 3 (manual)**：同上，加入等待队列

```
审批分级决策树：
  if approvalMode === 'auto-accept' → 立即执行
  if approvalMode === 'auto-safe' && risk.level <= 'low' → 立即执行
  if approvalMode === 'auto-safe' && risk.level >= 'medium' → 排队（流结束后审批）
  if approvalMode === 'manual' → 排队（流结束后审批）
```

**残留风险：** `auto-safe` low-risk 工具的审批判断依赖 `sensorium.confidence` 阈值，此阈值在流中可能尚未计算完成 → 安全兜底：降级到排队。

### 3.2 并发写冲突（High）

**场景：** 模型在同一流中生成 `write_file a.ts` 和 `edit_file a.ts`，两者同时并发执行 → 文件内容竞争。

**影响：** 后完成的工具覆盖先完成的，或产生合并冲突。

**缓解：** 复用现有 `isConcurrencySafe()` 分区逻辑。`StreamingExecutor` 维护一个 `activeTargets: Set<string>`，当新 tool_use 的 target（file_path）与进行中的工具冲突时，排队等待前一个完成。

```typescript
// 流式执行器的并发控制
class StreamingExecutor {
  private pending = new Map<string, Promise<void>>()  // target → pending execution
  
  async submit(toolUse: ToolUse, deps: ToolPipelineDeps): Promise<void> {
    const target = toolTargetFromInput(toolUse.name, toolUse.input)
    
    // 非并发安全工具：等待所有 pending 完成
    if (!isConcurrencySafe(toolUse.name)) {
      await Promise.all([...this.pending.values()])
    }
    
    // 同 target 冲突：等待前一个完成
    if (target && this.pending.has(target)) {
      await this.pending.get(target)
    }
    
    const promise = executeToolUse(toolUse, deps, ...)
    if (target) this.pending.set(target, promise)
    promise.finally(() => { if (target) this.pending.delete(target) })
  }
}
```

### 3.3 顺序依赖（Medium）

**场景：** 模型生成 `grep "pattern"` → `read_file a.ts`。如果 `grep` 在流中执行的比 `read_file` 慢，`read_file` 先返回。不影响正确性（两者无数据依赖），但 `grep` 的结果在对话历史中排在后面。

**影响：** 对话历史中 tool_result 的顺序可能与模型预期不一致。模型在多轮对话中通常不依赖 tool_result 的精确顺序（它通过 tool_use_id 匹配），但极端情况下可能混淆。

**缓解：** 收集结果时按 tool_use 在流中的出现顺序排列，而非按完成顺序。

```typescript
// 结果排序
private results = new Map<string, ToolResult>()  // toolUseId → result
private order: string[] = []  // tool_use 出现顺序

getOrderedResults(): ToolResult[] {
  return this.order.map(id => this.results.get(id)!).filter(Boolean)
}
```

### 3.4 缓存前缀破坏（Medium）

**场景：** 当前实现中，`assistant` 块包含所有 tool_use，然后统一追加 tool_result 块。流式执行不会改变此结构。

**影响：** 无。`collectedBlocks` 的顺序不变 — `onContentBlock` 仍然按流顺序收集 content blocks。工具结果在流结束后统一追加到 session。

**验证：** `addAssistantBlocks` 接收的 `collectedBlocks` 与流式执行前完全一致。

### 3.5 审批弹窗 UI 并发（Low）

**场景：** 多个 tool_use 在同一流中都需要审批 → 多个审批弹窗同时弹出 → UI 混乱。

**影响：** 用户体验差，可能误点审批。

**缓解：** 排队审批（Level 2/3 的处理方式）。流结束后，逐个弹出审批弹窗，串行处理。

---

## 4. 渐进式多部分集成

此功能分 4 个独立可交付的部分，每部分独立测试、独立提交、独立回滚。

### 第 1 部分：提取并发分区逻辑

**目标：** 将 `ToolExecutionController.executeBatch()` 中的 concurrency-safe 分组逻辑提取为独立函数，使 StreamingExecutor 可以复用。

**文件：**
- 修改：`src/agent/tool-execution.ts`
- 测试：`src/agent/__tests__/tool-execution.test.ts`

**改动：**
```typescript
// tool-execution.ts 新增导出
export interface ToolUseEntry {
  id: string
  name: string
  input: Record<string, unknown>
}

export function isToolConcurrencySafe(name: string, registry: ToolRegistry): boolean {
  return registry.get(name)?.isConcurrencySafe() ?? false
}

export function partitionConcurrencySafe(tools: ToolUseEntry[], registry: ToolRegistry): Array<{ tools: ToolUseEntry[]; parallel: boolean }> {
  // 返回分组：parallel=true 的组内可并发执行，parallel=false 的需要串行
}
```

**验证：** `npx tsx --test src/agent/__tests__/tool-execution.test.ts` — 新增分区函数测试通过。

**提交：** `refactor(agent): extract concurrency-safe partition from executeBatch`

---

### 第 2 部分：实现 StreamingExecutor

**目标：** 创建 `StreamingExecutor` 类，负责接收流中的 tool_use、分级审批判断、并发执行。

**文件：**
- 创建：`src/agent/streaming-executor.ts`
- 测试：`src/agent/__tests__/streaming-executor.test.ts`

**接口：**
```typescript
export interface StreamingExecutorDeps {
  toolRegistry: ToolRegistry
  approvalMode: ApprovalMode
  cwd: string
  // ... 复用 ToolPipelineDeps 的核心字段
}

export interface StreamingToolResult {
  toolUseId: string
  content: string
  isError: boolean
  rawPath?: string
  uiContent?: string
}

export class StreamingExecutor {
  // 流中每收到一个 tool_use 就调用
  submit(toolUse: ToolUseEntry): void
  
  // 流结束后等待所有执行完成，按流顺序返回结果
  async drain(): Promise<StreamingToolResult[]>
  
  // 是否还有需要用户审批的排队工具
  getPendingApprovals(): ToolUseEntry[]
}
```

**审批分级实现：**
```typescript
private decideExecutionMode(tool: ToolUseEntry): 'immediate' | 'queued' {
  if (this.approvalMode === 'auto-accept') return 'immediate'
  if (this.approvalMode === 'auto-safe') {
    const risk = assessToolRisk(tool.name, tool.input, ...)
    return risk.level === 'none' || risk.level === 'low' ? 'immediate' : 'queued'
  }
  return 'queued' // manual mode
}
```

**测试用例：**
1. `auto-accept` 模式下 tool_use 立即执行
2. `auto-safe` + low risk → 立即执行
3. `auto-safe` + high risk → 排队
4. `manual` → 排队
5. 非并发安全工具串行执行（同一 target 等待）
6. 并发安全工具并行执行
7. `drain()` 返回结果按流顺序排列
8. 执行失败的 tool 不阻塞后续 tool

**验证：** `npx tsx --test src/agent/__tests__/streaming-executor.test.ts` — 全部通过。

**提交：** `feat(agent): add StreamingExecutor for in-stream tool execution`

---

### 第 3 部分：TurnStream 集成

**目标：** 修改 `TurnStreamController.streamTurn()`，在 `onContentBlock` 中收到 tool_use 时立即提交给 `StreamingExecutor`。

**文件：**
- 修改：`src/agent/turn-stream.ts` — 新增可选 `executor` 参数
- 测试：`src/agent/__tests__/turn-stream.test.ts` — 新增流中执行测试

**改动：**
```typescript
// TurnStreamInput 新增
export interface TurnStreamInput {
  // ... 现有字段
  streamingExecutor?: StreamingExecutor  // optional — 向后兼容
}

// onContentBlock 中
onContentBlock: (block) => {
  collectedBlocks.push(block)
  if (isToolUse(block)) {
    toolUses.push({ id: block.id, name: block.name, input: block.input })
    input.callbacks.onToolUse(block.id, block.name, block.input)
    // 边流边执行：提交给 StreamingExecutor
    input.streamingExecutor?.submit({ id: block.id, name: block.name, input: block.input })
  }
}
```

**测试用例：**
1. 无 executor 时行为不变（向后兼容）
2. 有 executor 时 tool_use 被提交
3. executor 拒绝审批的工具不阻止流继续
4. streaming executor 执行与流收集并发

**验证：** `npx tsx --test src/agent/__tests__/turn-stream.test.ts` — 全部通过。

**提交：** `feat(agent): integrate StreamingExecutor into TurnStreamController`

---

### 第 4 部分：AgentLoop 集成

**目标：** 修改 `AgentLoop._runInner()`，创建 `StreamingExecutor`，流结束后 `await executor.drain()` 收集结果，替换 `executeBatch()`。

**文件：**
- 修改：`src/agent/loop.ts` — 初始化 executor、集成到主循环
- 测试：`src/agent/__tests__/loop.test.ts` — 端到端集成测试

**改动（约 loop.ts:1680-1710）：**
```typescript
// 流之前：创建 StreamingExecutor
const executor = new StreamingExecutor({
  toolRegistry: this.config.toolRegistry,
  approvalMode: this.config.approvalMode ?? 'manual',
  cwd: this.cwd,
  // ... 传递 ToolPipelineDeps 中需要的其他字段
})

// 传给 streamTurn
const streamResult = await this.turnStream!.streamTurn({
  request,
  turn,
  lastTurnTextFingerprint: this.lastTurnTextFingerprint,
  streamingExecutor: executor,
  callbacks: { ... }
})

// 流之后：
// 1. 处理待审批工具（如果有排队工具）
const pendingApprovals = executor.getPendingApprovals()
for (const tool of pendingApprovals) {
  const approved = await callbacks.onApprovalRequired(tool.id, tool.name, tool.input)
  if (approved) executor.approve(tool.id)
  else executor.deny(tool.id)
}

// 2. 等待所有已启动执行完成
const streamingResults = await executor.drain()

// 3. 将结果添加到 session（复用现有 logTemplate/addToolResults 逻辑）
for (const r of streamingResults) {
  callbacks.onToolResult(r.toolUseId, r.toolName, r.content, r.isError, r.rawPath, r.uiContent)
}
this.session.addAssistantBlocks(collectedBlocks)
this.session.addToolResults(streamingResults.map(r => ({ ... })))
```

**测试用例：**
1. `auto-accept` 模式下，流式工具执行结果在流结束后立即可用
2. `auto-safe` + bash → 高风险工具排队，流结束后审批执行
3. 两个并发安全工具同时在流中执行
4. 编辑同一文件的工具串行执行
5. 流中断（abort）时 executor 正确清理

**验证：** 
```bash
npx tsc --noEmit
npx tsx --test src/agent/__tests__/loop.test.ts
npx tsx --test src/agent/__tests__/streaming-executor.test.ts
npx tsx --test src/agent/__tests__/turn-stream.test.ts
```

**提交：** `feat(agent): integrate StreamingExecutor into AgentLoop main turn`

---

## 5. 验证

```bash
# 类型检查
npx tsc --noEmit
# 预期: 退出码 0

# 单元测试
npx tsx --test src/agent/__tests__/streaming-executor.test.ts
# 预期: 全部通过

# TurnStream 测试（向后兼容）
npx tsx --test src/agent/__tests__/turn-stream.test.ts
# 预期: 原有测试 + 新测试全部通过

# AgentLoop 集成测试
npx tsx --test src/agent/__tests__/loop.test.ts
# 预期: 原有测试 + 新测试全部通过

# 全量回归
npx tsx --test src/**/__tests__/*.test.ts
# 预期: 无退化
```

## 6. 自检

### 6.1 规格覆盖

| 需求 | 部分 |
|------|------|
| tool_use 在流中立即执行 | 第 2 部分（StreamingExecutor.submit） |
| 审批分级（auto-accept/immediate/queued） | 第 2 部分（decideExecutionMode） |
| 并发安全分组复用 | 第 1 部分（partitionConcurrencySafe） |
| 同一 target 串行执行 | 第 2 部分（pending Map 冲突检测） |
| 结果按流顺序排列 | 第 2 部分（getOrderedResults） |
| TurnStream 向后兼容 | 第 3 部分（optional executor） |
| AgentLoop 端到端集成 | 第 4 部分 |
| 流中断清理 | 第 4 部分 |

### 6.2 占位符扫描

无 TODO / TBD / 待定 / 后续实现 实例。

### 6.3 类型一致性

- `StreamingExecutorDeps.approvalMode` ↔ 已有 `ApprovalMode`（`'auto-accept' | 'auto-safe' | 'manual'`）
- `ToolUseEntry` ↔ `ToolExecBatchInput.toolUses` 的元素类型一致
- `StreamingToolResult` 与 `ToolResult` 语义对齐
- `turn-stream.ts` 的 `streamingExecutor?: StreamingExecutor` 可选，不影响现有调用方

---

## 7. 执行交接

计划已完成并保存到 `docs/superpowers/plans/2026-06-02-streaming-tool-executor.md`。两种执行方式：

1. 子代理驱动（推荐）— 每个部分调度一个新的子代理，部分间进行审查，快速迭代。
2. 内联执行 — 在当前会话中使用 executing-plans 执行任务，批量执行并设有检查点。

选哪种方式？
