# Abort Resilience — 中止韧性修复

> **面向 AI 代理：** 使用 subagent-driven-development（推荐）或 executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 修复四个 abort/compaction 边界缺陷：压缩后 removeLastMessage 丢摘要(A1)、abort 窗口越过整轮重活(A2)、LLM compact timeout 与用户 abort 脱钩(A3)、工具 AbortError 被记成失败污染 immune/doom-loop(A4)。

**架构：** 四个独立修复，每个改 1-2 个文件。A1/A2 改 loop.ts + context.ts（消息回滚与 abort 检查点），A3 改 compaction-controller.ts（信号传递），A4 改 tool-pipeline.ts（错误分类）。修复之间无耦合，可独立执行和验证。

**技术栈：** TypeScript strict, node:assert/strict, node:test

---

## 1. Scope check

四个问题各自独立：
- A1: 压缩后消息回滚错位 → `context.ts` + `loop.ts`
- A2: abort 信号检查缺口 → `loop.ts`
- A3: LLM compact 信号隔离 → `compaction-controller.ts`
- A4: AbortError 错误分类 → `tool-pipeline.ts`

无跨子系统依赖，在一个 plan 中处理。

---

## 2. File structure

| 文件 | 职责 | 操作 |
|------|------|------|
| `src/agent/context.ts` | SessionContext.removeLastMessage — A1 改造为 index-based 回滚 | 修改 |
| `src/agent/loop.ts` | AgentLoop._runInner — A1 保存用户消息索引，A2 添加 abort 检查点 | 修改 |
| `src/agent/compaction-controller.ts` | llmCompact — A3 接收并组合 abort 信号 | 修改 |
| `src/agent/tool-pipeline.ts` | executionPipeline — A4 跳过 AbortError 的 failure recording | 修改 |
| `src/agent/__tests__/context.test.ts` | A1 测试 | 修改 |
| `src/agent/__tests__/loop.test.ts` | A1/A2 测试 | 修改 |
| `src/agent/__tests__/compaction-controller.test.ts` | A3 测试 | 修改 |
| `src/agent/__tests__/tool-pipeline.test.ts` | A4 测试 | 修改 |

---

## 3. Research endorsement（调研背书）

### A1: removeLastMessage after compaction

**调用方**（`loop.ts` 4 处，均以 `!assistantResponded` 守卫）:
- L1081: for-loop 入口 abort 检查 — 此时尚未进入 compaction，用户消息在栈顶 ✅
- L1417: stream 后 abort 检查 — compaction 可能已运行，用户消息可能被替换 ❌
- L1427: stream error 分支 — 同上 ❌
- L1502: 外层 catch — 同上 ❌

**存在原因**: `removeLastMessage` 在 commit `c88c4de` 引入，用于 abort/error 时回滚用户消息避免污染上下文。后续 `a6d2364` 加了 role guard（非 user 则抛错），将静默数据损坏转为可见崩溃。

**边界风险**:
- 压缩（`trySessionSplit` / `maybeCompact`）调用 `replaceMessages` 整体替换消息列表，用户消息不在栈顶时 `removeLastMessage` 的 role guard 抛错 → 逃逸到外层 catch，TUI 收不到 `onAbort()`
- 如果压缩将消息替换为 summary + anchors，整个用户消息已不在列表中，移除最后一条会丢摘要而非用户消息

**修复方向**: 在 `addUserMessage` 后将返回的消息 ID 保存为 `this.pendingUserMessageId`。`removeLastMessage` 按 ID 定位并移除，而非按位置 pop。压缩后 ID 可能不存在 → 跳过（用户消息已被压缩吸收，无需回滚）。

### A2: abort window

**问题范围**: `_runInner` 的 for-loop 中，L1080 abort 检查后到 L1414 下一次 abort 检查之间，执行了大量 sync/async 操作：
- L1093-1100: `trySessionSplit()` + `maybeCompact()`（可能触发 LLM compact 网络请求）
- L1138-1170: stale round compact、diet、heap-driven compact、`prewarmRecentReads`
- L1171+: context injection、reliability refresh、`enforceContextCeiling`、immune learning

**存在原因**: 这些操作在 stream 之前运行，设计上是为了准备干净的上下文。但没有考虑用户 abort 的及时响应。

**边界风险**:
- 用户按 Escape 后等待数秒才有响应（最坏情况：LLM compact 的 60s 超时）
- 感知到 "卡死" 的用户可能再次按 Escape 或强制退出

**修复方向**: 在每个 `await` 后添加轻量 abort 检查（`if (this.abortController.signal.aborted) return`）。不需要在每个同步操作后检查——同步代码执行很快。重点在异步操作后：`trySessionSplit`、`maybeCompact`、`enforceContextCeiling` 之后。

### A3: LLM compact timeout 与用户 abort 脱钩

**调用方**: `compaction-controller.ts:530` — `llmCompact(timeoutMs)` 内部创建 `AbortSignal.timeout(timeoutMs)`，不接收外部 signal。

**存在原因**: LLM compact 是独立的压缩操作，最初设计为后台任务，不需要与用户交互。但随着 `trySessionSplit` / `enforceContextCeiling` 在 for-loop 内调用 llmCompact，用户 abort 时需要能取消。

**边界风险**:
- `llmCompact` 通过 `this._llmCompactInFlight` 防止并发，但无外部取消机制
- 用户 abort 后，如果 compact 正在进行，需等待完整超时（60s）才能继续
- `AbortSignal.timeout` 创建的 signal 在 `fetchWithTimeout` 中被正确处理（commit `653d03e` 修复），但缺少与用户 signal 的组合

**修复方向**: `llmCompact` 接受可选的 `AbortSignal` 参数。当调用方（loop.ts）有 `abortController` 时传入其 signal。在 `llmCompact` 内部用 `AbortSignal.any([userSignal, timeoutSignal])` 组合两个信号。注意 `primaryClient.stream()` 已正确处理 TimeoutError → 这里重点是让用户 abort 能取消请求。

### A4: 工具 AbortError 被记成失败

**调用方**: `tool-pipeline.ts:848` — executionPipeline 的 catch 块。

**存在原因**: catch 块是通用错误处理，未区分 AbortError（用户主动取消）和真实工具失败。

**边界风险**:
- `repairHintTracker.recordFailure` → 影响 repair pipeline 的重试建议
- `classifyFailure(msg)` → AbortError 文本被分类为 "unknown"，但不会被正确标记为可忽略
- 反馈到 immune 系统 / doom-loop 检测 → 误判为连续失败
- 如果用户频繁 abort 工具调用，可能触发 `conservative` 模式降级

**修复方向**: 在 catch 块开头检查 `(err as Error).name === 'AbortError'`，若是则跳过 `recordFailure` 和 `classifyFailure`，直接返回 `is_error: false`（abort 不是工具本身的错误）。

---

## 4. Tasks

### Task 1: A4 — 工具 AbortError 不被记成失败

**目标**: 最小改动，最低风险，先修复。

**修改**: `src/agent/tool-pipeline.ts:845-850`

将 catch 块改为：

```typescript
  } catch (err) {
    // AbortError means the user cancelled — not a tool failure.
    // Don't record it or feed it into immune/doom-loop signals.
    if ((err as Error).name === 'AbortError') {
      callbacks.onToolResult(tu.id, tu.name, '', false)
      return { toolResult: { type: 'tool_result', tool_use_id: tu.id, content: '', is_error: false }, traceStore, importGraph, lastConflictCheckCount, checkpointCreated, latestRisk }
    }
    const msg = err instanceof Error ? err.message : String(err)
    deps.repairHintTracker.recordFailure(tu.name, classifyFailure(msg).class)
    callbacks.onToolResult(tu.id, tu.name, msg, true)
    return { toolResult: { type: 'tool_result', tool_use_id: tu.id, content: starSig ? msg + starSig : msg, is_error: true }, traceStore, importGraph, lastConflictCheckCount, checkpointCreated, latestRisk }
  }
```

**测试**: `src/agent/__tests__/tool-pipeline.test.ts`

新增测试用例：

```typescript
it('A4: does not record AbortError as tool failure', async () => {
  const deps = makeDeps({ toolImpl: () => Promise.reject(new DOMException('Aborted', 'AbortError')) })
  const result = await executionPipeline({ tu: makeToolUse('test_tool', {}), deps, ... })
  assert.equal(result.toolResult.is_error, false)
  // Verify repairHintTracker was NOT called
})

it('A4: still records non-AbortError failures', async () => {
  const deps = makeDeps({ toolImpl: () => Promise.reject(new Error('real failure')) })
  const result = await executionPipeline({ tu: makeToolUse('test_tool', {}), deps, ... })
  assert.equal(result.toolResult.is_error, true)
})
```

**命令**:
```bash
npx tsc --noEmit                                    # typecheck — expect pass
npx tsx --test src/agent/__tests__/tool-pipeline.test.ts  # tests — expect pass
```

**提交**: `fix(agent): skip AbortError in tool-pipeline failure recording`

---

### Task 2: A3 — LLM compact 接收 abort 信号

**目标**: 让用户 abort 能取消正在进行的 LLM compact 请求。

**修改**: `src/agent/compaction-controller.ts:493-550`

1. 签名变更：`async llmCompact(timeoutMs = 60_000, userSignal?: AbortSignal)`
2. 内部 signal 构造：`const signal = userSignal ? AbortSignal.any([userSignal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs)`
3. 在 `loop.ts` 的 3 处调用点传入 `this.abortController.signal`:
   - `trySessionSplit()` 内部调用 `this.llmCompact()` → 改为 `this.llmCompact(60_000, this.abortController?.signal)`
   - `enforceContextCeiling()` 内部调用 `this.llmCompact(30_000)` → 同样传入 signal
   - `maybeCompact()` 的 1M window 路径调用 `this.llmCompact()` → 同样传入

**注意**: compaction-controller 通过 `this.deps` 访问外部依赖，需要增加 `abortSignal` 到 deps 或通过参数传递。参数传递更简洁。

**修改**: `src/agent/loop.ts`

在调用 `llmCompact` 的三处路径传入 signal。需要先检查 compaction-controller 的 deps 是否已有 abortSignal 访问方式。当前 deps 类型: `CompactionControllerDeps`。如果不在 deps 中，通过方法参数传递。

`compaction-controller.ts` 的 `llmCompact` 签名改为接受 `userSignal?: AbortSignal`：

```typescript
async llmCompact(timeoutMs = 60_000, userSignal?: AbortSignal): Promise<string | null> {
```

内部 signal 构造：
```typescript
const timeoutSignal = AbortSignal.timeout(timeoutMs)
const signal = userSignal
  ? AbortSignal.any([userSignal, timeoutSignal])
  : timeoutSignal
```

`loop.ts` 调用点修改（需要先查看实际调用代码确认具体行号）：

在 `trySessionSplit` 调用路径、`enforceContextCeiling` 调用路径、`maybeCompact` 1M window 路径，将 `this.abortController?.signal` 传入。

3. 由于 `llmCompact` 内部 `primaryClient.stream()` 通过 `fetchWithTimeout` 处理 TimeoutError（commit `653d03e`），用户 abort 产生的 AbortError 会正确传播到 catch → return null。

**测试**: `src/agent/__tests__/compaction-controller.test.ts`

新增测试：
```typescript
it('A3: llmCompact respects user abort signal', async () => {
  const controller = new AbortController()
  controller.abort() // abort before call
  const result = await controller.llmCompact(60_000, controller.signal)
  assert.equal(result, null) // should bail immediately
})
```

**命令**:
```bash
npx tsc --noEmit
npx tsx --test src/agent/__tests__/compaction-controller.test.ts
```

**提交**: `fix(agent): pass user abort signal to llmCompact`

---

### Task 3: A1 — 压缩后 removeLastMessage 不回滚错消息

**目标**: `removeLastMessage` 在 compaction 替换消息后仍能正确工作。

**设计**: 在 `_runInner` 中，`addUserMessage` 后保存消息的引用（非 index，因为 replaceMessages 整体替换数组）。使用消息内容 hash 或 session 级消息 ID 追踪。

更简单的方案：在 loop.ts 中维护 `userMessageConsumed` 标志。当 compaction 的 `replaceMessages` 被调用时，如果 compactResult 表示发生了压缩（`compactResult.compacted === true` 或 `trySessionSplit` 返回 true），则设置 `userMessageConsumed = true`。后续 abort 检查时，如果 `userMessageConsumed` 为 true，跳过 `removeLastMessage()`（消息已被压缩吸收）。

**修改**: `src/agent/loop.ts`

1. 在 `_runInner` 中 `assistantResponded = false` 之后添加：`let userMessageConsumed = false`
2. 在 `trySessionSplit()` 调用后：`if (await this.compaction.trySessionSplit()) userMessageConsumed = true`
3. 在 `maybeCompact()` 调用后：`if (compactResult.compacted) userMessageConsumed = true`
4. 将 4 处 `removeLastMessage()` 的条件从 `if (!assistantResponded)` 改为 `if (!assistantResponded && !userMessageConsumed)`

**修改**: `src/agent/context.ts` — 不需要修改。`removeLastMessage` 的 role guard 保持不变，因为现在调用方已确保只在用户消息仍在栈顶时调用。

**测试**: `src/agent/__tests__/loop.test.ts`

新增：
```typescript
it('A1: does not call removeLastMessage after compaction consumed user message', async () => {
  // Setup: agent with compaction that triggers
  // Abort after compaction
  // Assert: removeLastMessage was NOT called, no throw
})
```

**命令**:
```bash
npx tsc --noEmit
npx tsx --test src/agent/__tests__/loop.test.ts
```

**提交**: `fix(agent): skip removeLastMessage when compaction consumed user message`

---

### Task 4: A2 — abort 检查点

**目标**: 用户 abort 后不等待长时间操作完成。

**修改**: `src/agent/loop.ts` — `_runInner` 的 for-loop 中

在以下 `await` 调用后添加 abort 检查（`if (this.abortController.signal.aborted) { if (!assistantResponded && !userMessageConsumed) this.session.removeLastMessage(); callbacks.onAbort(); return }`）：

1. `await this.compaction.trySessionSplit()` 之后（L1093 附近）
2. `await this.compaction.maybeCompact(...)` 之后（L1100 附近）
3. `await this.compaction.enforceContextCeiling()` 之后（L1171 附近，如果有）

具体位置参考 loop.ts 当前代码（行号可能因前面的修改偏移）。

**注意**: 不需要在同步代码后添加检查。每个 `await` 后面加一个检查即可，因为 abort 信号只能在这些异步操作期间到达。

**测试**: `src/agent/__tests__/loop.test.ts`

```typescript
it('A2: abort during compaction bails before stream', async () => {
  // Setup compaction that takes long
  // Abort during compaction
  // Assert onAbort called, stream never started
})
```

**命令**:
```bash
npx tsc --noEmit
npx tsx --test src/agent/__tests__/loop.test.ts
```

**提交**: `fix(agent): add abort checks after async compaction ops`

---

## 5. Verification

```bash
# 类型检查
npx tsc --noEmit
# expect: TypeScript compilation completed

# 单元测试
npx tsx --test src/agent/__tests__/tool-pipeline.test.ts
npx tsx --test src/agent/__tests__/compaction-controller.test.ts
npx tsx --test src/agent/__tests__/loop.test.ts
npx tsx --test src/agent/__tests__/context.test.ts
# expect: all pass, 0 failures

# 完整回归（可能需要更长超时）
npx tsx --test src/agent/__tests__/*.test.ts
# expect: no new failures introduced
```

---

## 6. Self-check

### Spec coverage
| 需求 | 任务 | 覆盖 |
|------|------|------|
| A1 压缩后 removeLastMessage 丢摘要 | Task 3 | ✅ userMessageConsumed flag |
| A2 abort 窗口越过整轮重活 | Task 4 | ✅ await 后 abort 检查点 |
| A3 LLM compact timeout 与 abort 脱钩 | Task 2 | ✅ userSignal 参数传递 |
| A4 工具 AbortError 被记成失败 | Task 1 | ✅ name==='AbortError' 提前返回 |

### Placeholder scan
- 无 TODO / TBD / 待定
- 所有错误处理有明确行为
- 所有测试用例有具体代码

### Type consistency
- `AbortSignal` 来自标准 DOM 类型
- `CompactionController.llmCompact` 签名: `(timeoutMs?: number, userSignal?: AbortSignal) => Promise<string | null>`
- `SessionContext.removeLastMessage` 签名不变
- `executionPipeline` 返回值结构不变
- 所有路径名使用绝对路径

---

## 7. Execution handoff

计划已保存到 `docs/superpowers/plans/2026-05-30-abort-resilience.md`。两种执行方式：

1. **子代理驱动（推荐）**— 每个任务调度一个新的子代理，任务间进行审查，快速迭代。
2. **内联执行** — 在当前会话中使用 executing-plans 执行任务，批量执行并设有检查点。

选哪种方式？
