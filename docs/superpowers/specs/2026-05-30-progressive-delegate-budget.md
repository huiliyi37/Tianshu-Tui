# Progressive Delegate Budget

> **状态**: ✅ 已交付 (2026-05-30)
> **分支**: `feat/knowledge-manifest-minimal`
> **提交**: `86372d9` (timeout), `2652d97` (task cap)

---

## 1. 问题

会话刚开始（turn 0-1）时，`delegate_batch` 会并行启动最多 5 个 worker，每个 worker 默认超时 120 秒。
用户的第一条消息就要等 **2 分钟** 才能看到结果 — 体验很差。

根本原因：delegate 工具的预算（超时 + 并发数）是**静态常量**，不感知会话阶段。

## 2. 设计思路

**渐进式预算 (Progressive Budget)**：根据 `sessionTurnCount` 把会话分成三个阶段，
每个阶段给予不同的时间预算和并发配额。

```
turn 0-1   cold open   → 用户刚发话，需要最快响应
turn 2-4   warming     → 对话建立，可以适度并行
turn 5+    mature      → 深度协作，全量预算
```

### 2.1 为什么不按时间戳而按 turn？

- Turn 是离散的、确定性的，不受系统时钟漂移影响
- 与已有 `ToolPipelineDeps.sessionTurnCount` 对齐，无需新增状态
- Turn 数天然反映"对话深度"：turn 5 意味着主模型已经用了 5 轮工具，上下文丰富

### 2.2 三层预算表

| 阶段 | Turn | delegate_task 超时 | delegate_batch 超时 | batch 任务上限 |
|------|------|--------------------|---------------------|---------------|
| cold | 0-1  | 30 s               | 45 s                | 1             |
| warm | 2-4  | 75 s               | 90 s                | 3             |
| full | 5+   | 150 s              | 180 s               | 5             |

**设计意图**：
- cold 阶段只派 1 个 scout 做 quick grep，30-45 秒内返回
- warm 阶段允许 2-3 个 focused task，够做 code_search + review
- full 阶段放全量预算，适合深度验证/patch 工作流

## 3. 实现细节

### 3.1 Tool 接口扩展 (`src/tools/types.ts`)

```typescript
interface Tool {
  // ...existing methods...
  /** Maximum execution time in ms before tool-pipeline aborts.
   *  Override for long-running orchestrator tools.
   *  Default: 120 000 (2 minutes). */
  timeoutMs?(params?: ToolCallParams): number
}
```

`ToolCallParams` 新增 `sessionTurnCount?: number`，由 `tool-pipeline.ts` 在构建 params 时从 `deps.sessionTurnCount` 传入。

### 3.2 Tool Pipeline 修改 (`src/agent/tool-pipeline.ts`)

```typescript
// 旧: 硬编码
const TOOL_TIMEOUT_MS = 120_000
withToolTimeout(promise, toolName, signal)

// 新: per-tool 动态超时
const DEFAULT_TOOL_TIMEOUT_MS = 120_000
const toolTimeout = toolDef?.timeoutMs?.(params) ?? DEFAULT_TOOL_TIMEOUT_MS
withToolTimeout(promise, toolName, toolTimeout, signal)
```

`withToolTimeout` 签名新增 `timeoutMs: number` 参数。

### 3.3 delegate-task 渐进超时 (`src/tools/delegate-task.ts`)

```typescript
function progressiveTaskTimeout(sessionTurnCount?: number): number {
  const turn = sessionTurnCount ?? 10  // unknown → mature
  if (turn <= 1) return 30_000
  if (turn <= 4) return 75_000
  return 150_000
}
```

### 3.4 delegate-batch 渐进超时 + 任务上限 (`src/tools/delegate-batch.ts`)

两个维度：

1. **超时** (`progressiveBatchTimeout`): 45 → 90 → 180 秒
2. **任务上限** (`progressiveTaskCap`): 1 → 3 → 5 个 worker

超出上限时截断 tasks 数组，并在返回 content 中追加 `[batch trimmed]` 提示：

```
[batch trimmed] Session is early (turn 0). Dispatched 1/5 tasks.
Deferred: "review error handling in src/tools", "find test coverage gaps", ...
Re-dispatch later tasks in a subsequent turn if needed.
```

主模型看到这条提示后，可以在下一轮 turn 自然地重新提交被裁掉的任务。

### 3.5 数据流

```
AgentLoop (sessionTurnCount)
  └→ executeToolUse (deps.sessionTurnCount)
       └→ ToolCallParams.sessionTurnCount
            └→ tool.timeoutMs?(params)
            └→ progressiveBatchTimeout / progressiveTaskTimeout
```

## 4. 测试覆盖

### 4.1 delegate-batch (`src/__tests__/delegate-batch.test.ts`)

- **Progressive timeout** (4 cases): 验证 turn 0/2/5/undefined 返回正确超时
- **Progressive task cap** (4 cases):
  - turn 0: 5 tasks → 只 dispatch 1, content 含 `[batch trimmed]`
  - turn 3: 5 tasks → dispatch 3
  - turn 6: 5 tasks → dispatch 5, 无 trimmed
  - `progressiveTaskCap()` unit: 1→3→5 三档

### 4.2 delegate-task (`src/tools/__tests__/delegate-task.test.ts`)

- **Progressive timeout** (4 cases): 验证 turn 0/2/5/undefined 返回正确超时

**总计**: 8 新测试 + 4 task cap 测试 = 12 assertions, 全部通过。

## 5. 改动文件清单

| 文件 | 改动 |
|------|------|
| `src/tools/types.ts` | `Tool.timeoutMs?()`, `ToolCallParams.sessionTurnCount` |
| `src/agent/tool-pipeline.ts` | `DEFAULT_TOOL_TIMEOUT_MS`, per-tool timeout 查询, params 传入 turn |
| `src/tools/delegate-task.ts` | `progressiveTaskTimeout`, `timeoutMs` 声明 |
| `src/tools/delegate-batch.ts` | `progressiveBatchTimeout`, `progressiveTaskCap`, 截断 + 提示 |
| `src/tools/__tests__/delegate-task.test.ts` | 4 progressive timeout tests |
| `src/__tests__/delegate-batch.test.ts` | 4 timeout + 4 task cap tests |

## 6. 未来迭代方向

### 6.1 可调阈值 (Config-backed tiers)
当前阈值是编译时常量。可以让用户通过 `.rivet` 配置覆盖：

```json
{
  "delegate": {
    "tiers": {
      "cold": { "timeoutMs": 30_000, "maxTasks": 1 },
      "warm": { "timeoutMs": 75_000, "maxTasks": 3 },
      "full": { "timeoutMs": 150_000, "maxTasks": 5 }
    }
  }
}
```

### 6.2 Worker-level timeout 传导
目前 `progressiveBatchTimeout` 控制 tool-pipeline 层面的超时。
但 worker 内部的 `WorkOrder.budget.timeoutMs` 仍然是 120s 常量。
未来可以让 coordinator 根据 session turn 调整 worker budget：

```typescript
// coordinator.ts: delegateBatch()
const sessionTurn = getSessionTurn() // 新增
for (const order of orders) {
  order.budget.timeoutMs = scaleWorkerBudget(order.budget.timeoutMs, sessionTurn)
}
```

### 6.3 自适应 tier 切换
当前用硬编码 turn 边界 (0-1, 2-4, 5+)。
可以根据实际 worker 成功率/耗时动态升级：

- cold → warm: 连续 2 次 worker 在 20s 内 passed
- warm → full: 连续 3 次 passed，平均 < 60s

### 6.4 UI 可见性
TUI 底部状态栏可以显示当前 delegate tier，让用户知道为什么某些任务被裁掉。

## 7. 风险与限制

| 风险 | 缓解 |
|------|------|
| cold 阶段 30s 不够做 code_search | 快速 grep 通常 <10s；超时返回 blocked 不影响主循环 |
| 任务被截断后主模型忘记重发 | `[batch trimmed]` 提示明确列出 deferred objectives |
| `sessionTurnCount` 为 undefined 时默认 mature | 有意为之：worker 内部调用、测试等场景不应被限流 |
| 只影响 tool-pipeline 层，不传导到 worker 内部 | 见 6.2 — 需要 coordinator 配合 |
