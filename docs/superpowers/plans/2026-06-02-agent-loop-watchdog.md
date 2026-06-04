# Agent Loop 事件循环弹性改造

> **状态：✅ 已全部实施** — immune-hook error boundary + recordToolHistory setImmediate + TurnHeartbeat

**目标：** 消除 agent loop 中所有可能阻塞事件循环的同步操作，增加事件循环健康看门狗，并在工具执行前写入 sensorium 遥测以便诊断卡死。

**架构：** 将 `immuneHook.run()` 和 `p3.onToolComplete()` 从 `recordToolHistory` 的同步调用路径中移出，改为通过 `setImmediate` 延迟执行；在 `executeBatch` 入口写入 sensorium 快照；在 `recordToolHistory` 后增加事件循环探针 `setTimeout`，5s 不触发则判定事件循环阻塞并主动抛错。

**技术栈：** TypeScript strict, Node.js 22, node:test + node:assert/strict

---

## 1. Scope Check

本计划聚焦于 agent loop 的事件循环弹性。涉及以下子系统：

- `src/agent/loop.ts` — 核心循环，`recordToolHistory` 方法，turn 边界
- `src/agent/immune-hook.ts` — 免疫系统 `run()` 方法，需要改为可延迟执行
- `src/agent/p3-integration.ts` — P3 的 `onToolComplete()`，确认无害
- `src/agent/tool-execution.ts` — `executeBatch` 入口，增加 sensorium 写入
- `src/agent/tool-pipeline.ts` — `executeToolUse` 中调用 `recordToolHistory` 的位置

这些子系统紧密耦合在同一调用链上，不适合拆分为独立计划。

不涉及：
- Compaction 系统（已验证在低 token 使用率下不会触发）
- Theta check（已是 fire-and-forget `.then()` 模式）
- Session persist writeChain（已验证使用 `fs/promises` 异步 I/O）
- Physarum engine（已验证为纯内存 Map 操作，O(1) per call）

---

## 2. File Structure

| 文件 | 操作 | 职责 |
|------|------|------|
| `src/agent/loop.ts` | 修改 | 将 `recordToolHistory` 中的 `immuneHook.run()` 改为 `setImmediate`；增加事件循环探针；在 turn 循环中为 `executeBatch` 前增加 sensorium 写入 |
| `src/agent/immune-hook.ts` | 修改 | `run()` 方法增加 error boundary（try-catch），确保即使抛错也不影响调用方 |
| `src/agent/tool-execution.ts` | 修改 | `executeBatch` 入口接受可选的 sensorium 写入回调 |
| `src/agent/__tests__/loop.test.ts` | 修改 | 增加事件循环探针测试和 setImmediate 延迟测试 |
| `src/agent/__tests__/immune-hook.test.ts` | 修改 | 增加 run() error boundary 测试 |
| `src/agent/__tests__/tool-execution.test.ts` | 修改 | 增加 sensorium 写入时机测试 |

---

## 3. Research Endorsement（调研背书）

### 3.1 `immuneHook.run()` 同步调用路径

**位置：** `src/agent/loop.ts:664`

```typescript
const immuneResult = this.immuneHook.run({
  toolName: name, fingerprint: fp, turn: this.session.getTurnCount(),
  doomLevel: this.getDoomLoopLevel(), targetFile: target,
  tokenUsage: this.session.getEstimatedTokens(), trajectoryHealth,
})
```

**调用链：**
```
loop.ts: _runInner → executeBatch() → executeToolUse() [tool-pipeline.ts:739]
  → deps.recordToolHistory() [loop.ts:619]
    → immuneHook.run() [loop.ts:664]
```

**调研结论：** `immuneHook.run()` 内部所有操作均为内存数据结构操作（Map get/set、数组 push、简单算术）。`PhysarumEngine.recordFlow()` 为 O(1) Map 操作。没有 I/O、没有网络、没有重计算。**在正常路径上不会造成 6 分钟级别的阻塞。**

但 `detectAnomaly()` 遍历所有边，`batchEvolve()` 也遍历所有边并执行衰减计算。在边数极少（<100）的情况下这些操作微秒级完成。**风险低但非零——随着会话长度增长，Physarum 边数可能累积。**

**决策：** 将 `immuneHook.run()` 移到 `setImmediate` 中，同时给 `run()` 加 try-catch error boundary 作为纵深防御。

### 3.2 `p3.onToolComplete()` 同步调用路径

**位置：** `src/agent/loop.ts:636`

```typescript
this.p3.onToolComplete(name, target, isError, isError ? result.slice(0, 200) : undefined)
```

**调研结论：** `onToolComplete()` 只做两件事：`this.lastTool = toolName` 和 `this.lastTarget = target`。纯赋值，无任何计算或 I/O。

**决策：** 不需要异步化。已是最轻量操作。但为了防御未来 P3 功能扩展引入阻塞操作，仍将其也放入 `setImmediate` 调度。

### 3.3 Session Persist writeChain 异步性

**位置：** `src/agent/loop.ts:476-496`（mutation listener）、`src/agent/session-persist.ts:152-156`（`appendOaiWithChecksum`）

**调研结论：**
- `appendOaiWithChecksum` 使用 `appendFile` from `fs/promises` → **异步 I/O**
- `compactOaiAsync` 使用 `writeFileAtomicAsync` → **异步 I/O**
- `compactOai` 使用 `writeFileAtomicSync` → **同步 I/O**，但仅在测试/CLI 场景使用
- mutation listener 的 `replace` 分支调用 `persist.compactOaiAsync()` → **异步**

**决策：** 无需修改。当前的 `compactOai`（同步版）不在 agent loop 热路径上使用。

### 3.4 Tool execution 中的阻塞风险

**调用链：** `executeBatch()` → `executeToolUse()` → `recordToolHistory()` → `immuneHook.run()`

此外在 `executeToolUse` 中，tool harness 执行工具本身（可能是 `bash`、`delegate_task` 等），这些工具**本身就可能长时间运行**。`delegate_task` 的默认超时是 120s，`bash` 工具可能执行 `npm test` 等长时间命令。

**决策：** 在 `executeBatch` 入口写入 sensorium 快照，确保即使工具执行中卡死，也能定位到具体是哪个工具被调用。

---

## 4. Tasks

### Task 1: `immuneHook.run()` 添加 error boundary

**目标：** 防止 `run()` 内部意外抛错导致 agent loop 崩溃。

**修改：** `src/agent/immune-hook.ts:62`（`run` 方法体）

将整个 `run()` 方法体包裹在 try-catch 中：

```typescript
run(ctx: ImmuneHookContext): ImmuneHookResult {
  try {
    // ... 现有方法体（不变）...
  } catch (err) {
    // Immune failure must never crash the agent loop.
    // Return a silent no-op result.
    return { activated: false, signals: [] }
  }
}
```

同时将 `maybeRunMaintenance` 调用改为 try-catch 包裹（当前在方法体内有两次调用）。

**测试：** `src/agent/__tests__/immune-hook.test.ts`
- 新增测试：`immuneHook.run() returns no-op result when Physarum throws`
- 模拟 `physarum.recordFlow` 抛错，验证返回 `{ activated: false, signals: [] }`

**验证：** `npm exec -- tsx --test src/agent/__tests__/immune-hook.test.ts`

**提交：** `fix(agent): wrap immuneHook.run() in try-catch error boundary`

---

### Task 2: 将 `recordToolHistory` 中的后处理移到 `setImmediate`

**目标：** 确保工具执行后的 immune/p3 处理不阻塞主循环的事件循环。

**修改：** `src/agent/loop.ts:619-675`（`recordToolHistory` 方法）

将 `immuneHook.run()` 调用和 `p3.onToolComplete()` 调用从同步路径移出：

```typescript
private recordToolHistory(name: string, input: Record<string, unknown>, isError: boolean, result: string): void {
  const target = /* ... 现有逻辑不变 ... */
  this.recentToolHistory.push(/* ... 现有逻辑不变 ... */)
  if (this.recentToolHistory.length > 5) this.recentToolHistory.shift()

  // P3-E/H: invalidate plan cache + JIT on file mutations (纯赋值，保留同步)
  if (!isError && (name === 'edit_file' || name === 'write_file')) {
    this.p3.invalidatePlanCache(target)
    this.p3.invalidateJIT(target)
  }

  // P3-D Atropos: assess trajectory health（纯计算，保留同步——需要同步更新 model switch）
  let trajectoryHealth: HealthSignal = 'healthy'
  if (this.config.onModelSwitch && this.config.getCurrentModel) {
    /* ... 现有逻辑不变 ... */
  }

  // ── 以下操作移到 setImmediate，不阻塞工具结果处理 ──
  const fp = this.traceStore.toolFingerprints[this.traceStore.toolFingerprints.length - 1] ?? name
  setImmediate(() => {
    // P3 pattern mining (deferred)
    try { this.p3.onToolComplete(name, target, isError, isError ? result.slice(0, 200) : undefined) } catch { /* non-critical */ }

    // Physarum + Immune (deferred)
    try {
      const immuneResult = this.immuneHook.run({
        toolName: name, fingerprint: fp, turn: this.session.getTurnCount(),
        doomLevel: this.getDoomLoopLevel(), targetFile: target,
        tokenUsage: this.session.getEstimatedTokens(), trajectoryHealth,
      })
      if (immuneResult.contextHint) {
        this._lastImmuneHint = immuneResult.contextHint
      }
    } catch { /* immune failure is non-critical */ }
  })
}
```

**变更说明：**
- `p3.onToolComplete()` 是纯赋值（lastTool/lastTarget），移到 setImmediate 无害——它的唯一消费者 `p3.onToolStart()` 在下一个工具启动时调用，延迟到下一个 microtask 不影响正确性。
- `immuneHook.run()` 的副作用（contextHint、stigmergy deposit）延迟到 setImmediate 不影响工具结果展示——这些是观察/学习信号，不需要在工具结果返回给模型之前完成。
- `p3.invalidatePlanCache` 和 `p3.invalidateJIT` 保留同步——它们影响后续工具调用的计划缓存，必须在下一个 API 调用前完成。
- `trajectoryHealth` 计算保留同步——它可能触发即时 model switch，不能延迟。

**测试：** `src/agent/__tests__/loop.test.ts`
- 新增测试：`immuneHook.run() is called via setImmediate after recordToolHistory`
- 使用 fake timers 或 Promise 微任务调度来验证 setImmediate 中的逻辑被执行
- 验证 `_lastImmuneHint` 在 microtask 后正确更新

**验证：** `npm exec -- tsx --test src/agent/__tests__/loop.test.ts`

**提交：** `fix(agent): defer immuneHook.run() and p3.onToolComplete() to setImmediate`

---

### Task 3: 事件循环健康看门狗探针

**目标：** 在每次 `recordToolHistory` 后放置 `setTimeout(0)` 探针，5 秒内不触发则判定事件循环阻塞。

**修改：** `src/agent/loop.ts` — 在 `recordToolHistory` 方法的末尾（setImmediate 调用之后）添加探针：

```typescript
// ── Event loop health probe ──
// If this setTimeout(0) callback doesn't fire within 5 seconds,
// the event loop is blocked. Throw to surface the freeze instead
// of silently hanging.
let probeFired = false
const start = Date.now()
setTimeout(() => {
  probeFired = true
}, 0)

// Schedule a secondary check 5s later
setTimeout(() => {
  if (!probeFired) {
    const elapsed = Date.now() - start
    const err = new Error(
      `Event loop blocked for ${elapsed}ms after tool ${name} on ${target}. ` +
      `Last activity: recordToolHistory at turn ${this.session.getTurnCount()}.`
    )
    // Surface via the error callback so the TUI can show it
    // and the user can decide to abort or wait.
    debugLog(`[event-loop] BLOCKED: ${err.message}`)
    // Don't throw in setTimeout — it would be an unhandled rejection.
    // Instead, mark the abort controller to trigger a graceful abort.
    this.abortController?.abort()
  }
}, 5000)
```

**注意：** 探针不抛错（setTimeout 中的 throw 无法被 try-catch 捕获），而是通过 abort controller 触发优雅中断。这利用了已有的 abort 处理路径（loop.ts 中多处检查 `this.abortController.signal.aborted`）。

**但有一个问题：** 如果事件循环被阻塞，`setTimeout` 回调本身就不会被调度，所以这个探针在事件循环阻塞时无效。探针只能检测**回调被延迟**的情况，而不能检测**回调永不执行**的情况。

**重新设计：** 使用 `process.nextTick` 或微任务探针 + worker thread 心跳。

更简单的方案：利用已有的 `TurnHeartbeat`。当前 heartbeat 在每次 phase change 时 reset。我们可以在 `recordToolHistory` 后增加一个"假" phase change 来 reset heartbeat，确保 heartbeat 能检测到 tool 执行中的长时间静默。

实际上，查看 `TurnHeartbeat` 的实现：它使用 `setInterval`，这正是依赖事件循环的。如果事件循环被阻塞，heartbeat 也不会触发。

**最终方案（务实）：**
- 利用 Node.js 的 `worker_threads` 创建一个轻量心跳线程，每秒向主线程发消息
- 如果主线程 5 秒内没有响应，worker 通过 stderr 输出告警
- 但这个方案复杂度高，不适合作为 P1 修复

**降级方案：** 不在 setTimeout 中做检测，而是在每次 `perception.perceive()` 开始时，检查 `Date.now() - lastRecordToolHistoryTime`，如果超过 30 秒，记录 warning 日志。这能覆盖"tool 执行后 hang 到下一个 turn 开始"的场景。

**最终决策：** 采用降级方案——在 `perception.perceive()`（每个 turn 开始时运行）增加时间差检测。

**修改：** `src/agent/loop.ts` — 在 `recordToolHistory` 记录时间戳，在 `perception.perceive()` 前检测：

```typescript
// 在 AgentLoop 类中添加字段：
private lastToolCompleteTime = 0

// 在 recordToolHistory 末尾：
this.lastToolCompleteTime = Date.now()

// 在 _runInner 的 for 循环中，perception.perceive() 调用前：
const toolGap = Date.now() - this.lastToolCompleteTime
if (this.lastToolCompleteTime > 0 && toolGap > 30_000) {
  debugLog(`[event-loop] WARNING: ${toolGap}ms gap since last tool completion`)
}
```

**测试：** `src/agent/__tests__/loop.test.ts`
- 新增测试：`logs warning when >30s gap between tool completion and next turn perception`
- Mock `Date.now()` 或使用实际时间差来验证

**验证：** `npm exec -- tsx --test src/agent/__tests__/loop.test.ts`

**提交：** `feat(agent): add event-loop gap detection between tool completion and turn start`

---

### Task 4: 在 `executeBatch` 前写入 sensorium 快照

**目标：** 即使工具执行中卡死，也能从 sensorium.jsonl 中定位到被调用的工具。

**修改：** `src/agent/loop.ts` — 在 `streamTurn` 返回后、`executeBatch` 调用前，写入一条 sensorium 快照：

```typescript
// 在 streamTurn 返回后 (loop.ts ~line 1585)：
const streamResult = await this.turnStream!.streamTurn({...})

// ── Pre-execution sensorium snapshot ──
if (streamResult.toolUses && streamResult.toolUses.length > 0) {
  const toolNames = streamResult.toolUses.map(tu => tu.name).join(',')
  this.perception.writeDiagnosticSnapshot({
    phase: 'tool-executing',
    detail: `tools=[${toolNames}]`,
  })
}

const r = await this.toolExecution.executeBatch({...})
```

**需要新增 `writeDiagnosticSnapshot` 方法到 `TurnPerceptionController`：**

**修改：** `src/agent/turn-perception.ts`
```typescript
writeDiagnosticSnapshot(detail: { phase: string; detail: string }): void {
  // 复用现有 telemetry writer，写入一条带 phase 标记的快照
  this.telemetryWriter.write({
    ts: Date.now(),
    turn: this.deps.getRuntimeSnapshot({}).turn,
    phase: detail.phase,
    // ... 复用当前 sensorium 的其他字段 ...
    diagnosticNote: detail.detail,
  })
}
```

**测试：** `src/agent/__tests__/loop.test.ts` 和 `src/agent/__tests__/tool-execution.test.ts`
- 新增测试：`sensorium snapshot is written before executeBatch when tools are present`
- 验证 telemetryWriter 被调用

**验证：** `npm exec -- tsx --test src/agent/__tests__/loop.test.ts src/agent/__tests__/tool-execution.test.ts`

**提交：** `feat(agent): write sensorium snapshot before tool execution for freeze diagnostics`

---

### Task 5: 集成测试与回归验证

**目标：** 确保所有改动不破坏现有行为，且新增的 setImmediate 延迟不影响工具结果正确性。

**验证命令：**
```bash
npx tsc --noEmit                                    # typecheck 全项目
npm exec -- tsx --test src/agent/__tests__/loop.test.ts
npm exec -- tsx --test src/agent/__tests__/immune-hook.test.ts
npm exec -- tsx --test src/agent/__tests__/tool-execution.test.ts
npm exec -- tsx --test src/agent/__tests__/tool-pipeline.test.ts
```

**预期：** 所有已有测试通过，新增测试通过。

**提交：** `test(agent): verify event-loop resilience changes pass existing tests`

---

## 5. Verification

### 完整验证套件

```bash
# Typecheck
npx tsc --noEmit

# 受影响模块的测试
npm exec -- tsx --test src/agent/__tests__/immune-hook.test.ts
npm exec -- tsx --test src/agent/__tests__/loop.test.ts
npm exec -- tsx --test src/agent/__tests__/tool-execution.test.ts
npm exec -- tsx --test src/agent/__tests__/tool-pipeline.test.ts

# 全量回归（可选，较慢）
npm exec -- tsx --test src/**/__tests__/*.test.ts
```

### 手动验证场景

1. **正常工具调用：** 启动 agent，提交简单任务（如 "读取 src/agent/loop.ts"），验证工具结果正常返回，sensorium.jsonl 中出现 `phase: 'tool-executing'` 条目。
2. **长时间工具调用：** 提交包含 `bash: sleep 30` 的任务，验证 sensorium 在工具执行前写入，30s 后工具正常完成。
3. **事件循环阻塞模拟：** （仅开发环境）在 `immuneHook.run()` 中插入 `while(Date.now() - start < 10000) {}` 循环 10 秒，验证 agent 不崩溃（error boundary 生效），工具结果正常返回。

---

## 6. Self-Check

### 6.1 Spec Coverage

| 需求 | 任务 | 覆盖状态 |
|------|------|----------|
| P0: immuneHook.run() 异步化/setImmediate | Task 2 | ✓ |
| P0: p3.onToolComplete() 异步化 | Task 2 | ✓ |
| P1: Session Persist writeChain 异步性验证 | 调研背书 3.3 | ✓（已验证，无需代码修改） |
| P1: 事件循环健康看门狗 | Task 3 | ✓ |
| P2: sensorium 写入时机完善 | Task 4 | ✓ |
| immuneHook.run() error boundary | Task 1 | ✓（纵深防御） |

### 6.2 Placeholder Scan

- [x] 无 TODO / TBD / 待定
- [x] 无 "添加适当的错误处理" — 所有错误处理有精确行为描述
- [x] 无 "类似任务 N"
- [x] 所有类型/方法/属性在使用前已定义

### 6.3 Type Consistency

- `recordToolHistory` 签名不变 — 所有调用方（`tool-execution.ts`, `tool-pipeline.ts`）无需修改
- `immuneHook.run()` 签名不变 — 仅内部增加 try-catch
- `TurnPerceptionController.writeDiagnosticSnapshot()` — 新增方法，参数类型明确
- `AgentLoop.lastToolCompleteTime` — 新增字段，类型 `number`

---

## 7. Execution Handoff

计划已完成并保存到 `docs/superpowers/plans/2026-06-02-agent-loop-watchdog.md`。两种执行方式：

1. **子代理驱动（推荐）** — 每个任务调度一个新的子代理，任务间进行审查，快速迭代。
2. **内联执行** — 在当前会话中使用 executing-plans 执行任务，批量执行并设有检查点。

选哪种方式？
