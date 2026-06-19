> **Status: COMPLETED** — 2026-06-19

# W-L4 交接：TurnOrchestrator 抽取

> **接棒会话**：天梁。上一会话已完成前置 + W-L1~L3，loop.ts 从 2698 → ~2370 行。本会话负责最后一波：W-L4。

## 1. 整体进度

| 波次 | 内容 | 提交 | 状态 |
|------|------|------|------|
| 前置 | 删除 runCognitivePrep 死代码 | `49ab0c54` | ✅ |
| W-L1 | PlanTraceCoordinator | `4e373bd2` | ✅ |
| W-L2 | CompactBoundaryCoordinator | `598125f5` | ✅ |
| W-L3 | createRuntimeHooksPipeline 私有方法提取 | `64d65005` | ✅ |
| **W-L4** | **TurnOrchestrator** | — | 🔴 待执行 |

分支：`desktop/antigravity-base`，HEAD = `64d65005`。

## 2. 当前代码结构

### 新增文件
- `src/agent/plan-trace-coordinator.ts` — PlanTraceCoordinator 类 + deps 接口
- `src/agent/compact-boundary-coordinator.ts` — CompactBoundaryCoordinator 类 + deps 接口
- `src/agent/loop-factory.ts` — 含 5 个工厂函数：`createTurnStreamController` / `createTurnCompletionController` / `createToolExecutionController` / `createPlanTraceCoordinator` / `createCompactBoundaryCoordinator`

### 穿线模式（必须沿用）
```
loop-factory.ts:  export function createXxx(self: AgentLoop): Xxx { ... }
loop.ts:          this.xxx = createXxx(this)   // 构造函数 / initializeRun
```
- 工厂函数 import `AgentLoop` 类型 → 无循环依赖
- 子控制器文件 **不 import** AgentLoop，通过 deps 接口（getter/setter 闭包）访问字段
- 已去私有化的字段（W-L1/W-L2 累计）：`planTrace` / `lastReplanInjection` / `latestConvergenceResult` / `consecutiveNoToolTurns` / `compactFailures` / `lastCompactTurn` / `pendingStaleCompact` / `pendingHeapCompact` / `_prevPhaseHint` / `compaction`

### 已抽出的 7 个控制器
TurnPerception → TurnIntent → ContextInjection → Compaction → TurnStream → TurnCompletion → ToolExecution（全部在构造函数中创建，前 4 个在类内部 new，后 3 个经 loop-factory）

## 3. W-L4 执行要点（TurnOrchestrator）

### 3.1 目标
从 loop.ts 搬走 `_runInner`（约 L1788–L2180，~400 行）+ `wrapCallbacksWithHeartbeat`（约 L2183–L2203，~20 行）。AgentLoop.run() 退化为「创建 abortController + 委托 orchestrator」。

### 3.2 关键行号（会漂移，执行时 grep 重新定位）
- `_runInner`: `grep "_runInner" loop.ts` → 应约 L1788
- `wrapCallbacksWithHeartbeat`: `grep "wrapCallbacksWithHeartbeat" loop.ts`
- `run()` 方法：`grep "async run(" loop.ts`
- `initializeRun()`: `grep "initializeRun" loop.ts`

### 3.3 缰绳重点（逐字保留，禁止改写控制流）

这些是前缀缓存 + 多会话共享的硬约束，搬运后 diff 必须为空：

1. **stream reconnect 丢弃 partial**（约 L2341-2345 原行号，执行时 grep "reconnect"）：`removeLastMessage` 后不 `addAssistantBlocks`
2. **abort 时跳过 addAssistantBlocks**（约 L2440-2444）：守卫 `!assistantResponded && !userMessageConsumed`
3. **TTSR 手写 `<system-reminder>` 标签**（约 L2400-2402）：thinking-only retry 的 guardrail 注入
4. **`removeLastMessage` 守卫**：仅当 `!assistantResponded && !userMessageConsumed`
5. **`runCompaction` / `runPerception` / `runConvergenceCheck` / `runReplanCheck`**：前三波已抽出的子流程，搬运后在 orchestrator 中调对应的 coordinator/方法
6. **`callbacks` 全量透传**：onPhaseChange / onToolStart / onToolEnd / onTextDelta / onStop
7. **`config.maxTurns` / `runPostSession` / `cacheAdvisor.onTurnEnd` / `telemetryWriter`** 等回调链路

### 3.4 局部状态（随 _runInner 迁移）
- `assistantResponded` — 布尔
- `userMessageConsumed` — 布尔
- stream dedup 三态机（原约 L2254-2365）— 跟踪流式去重
- `finalTurnCompleted` — 布尔

这些状态字段应在 orchestrator 内部作为局部变量或通过 deps getter/setter 管理。

### 3.5 建议 deps 接口（骨架，执行时按需扩展）

```typescript
interface TurnOrchestratorDeps {
  // 从 AgentLoop 读取的配置/状态
  getMaxTurns: () => number
  getAbortSignal: () => AbortSignal | undefined
  getSessionTurnCount: () => number
  
  // 子流程（前三波抽出的 coordinator/方法）
  runCompaction: (turn: number, snap: ...) => Promise<RunCompactionResult>
  runPerception: (...) => Promise<PerceptionResult>
  runConvergenceCheck: (...) => Promise<...>
  runReplanCheck: () => void
  buildTurnRequest: (...) => Promise<...>
  
  // 回调
  callbacks: AgentCallbacks
  
  // session 操作（P2-5 缰绳！）
  removeLastMessage: () => void
  addAssistantBlocks: (blocks: ...) => void
  
  // 生命周期
  runPostSession: (cb: AgentCallbacks) => Promise<void>
  cacheAdvisorOnTurnEnd: (turn: number) => void
  telemetryWriter: TelemetryWriter
}
```

### 3.6 必需的测试（搬运前补）

计划 §6 标注了两个测试缺口，W-L4 前必须补：

1. **TTSR stream rule retry cap（原约 L2381-2408）** — 当前无独立测试。验证：thinking-only retry 不超过 cap，超 cap 后走标准 error 路径
2. **stream reconnect 丢弃 partial** — 验证 mid-stream abort → reconnect 后不残留 partial blocks

### 3.7 执行建议

1. 先 grep 定位 `_runInner` / `wrapCallbacksWithHeartbeat` / `run()` 当前行号
2. 读 `_runInner` 全量（~400 行），标注所有 `this.xxx` 访问 → 构建 deps 接口
3. 写 TTSR retry cap 测试（安全网）
4. 新建 `turn-orchestrator.ts` + deps 接口 + TurnOrchestrator 类
5. `loop-factory.ts` 加 `createTurnOrchestrator(self)`
6. loop.ts：`_runInner` 缩为薄委托，`run()` 退化为「abortController + 委托 orchestrator」
7. `wrapCallbacksWithHeartbeat` 搬入 orchestrator
8. typecheck + `loop.test.ts` / `text-persistence.test.ts` / `agent-reconnect.test.ts` / `abort-*.test.ts` 全绿
9. 单波单提交

## 4. 遗留项（非 W-L4 范围，后续处理）

| 遗留项 | 说明 |
|--------|------|
| P2-5 pending/stale-round 集成测试 | compaction-controller.test.ts 无覆盖，需补 loop 级测试 |
| `_lastImmuneHint` 只写不读 | 原在 runCognitivePrep（已删除）中 consume once |
| engine.ts `cognitiveProjection` 字段/setter | 保留但无生产写入路径（runCognitivePrep 已删除） |
| `.git/info/exclude` 中的排除条目 | plan-trace-coordinator.ts / compact-boundary-coordinator.ts 已移除；后续新建文件可能需同样处理 |
| `run_tests` 工具基础设施问题 | tsx EPERM 导致 compaction-controller / trace-integration 等测试返回 0 results，非代码问题 |

## 5. 硬缰绳速查

```
❌ 禁止改变 promptEngine setter 调用时机
❌ 禁止在 anchor 前重排消息
❌ 禁止 mid-round 调 replaceMessages（P2-5 — 仅 turn 0 触发）
❌ 禁止 coordinator import AgentLoop（避免循环）
❌ 禁止搬运 runCognitivePrep（已删为 no-op 存根）
❌ 禁止改写 _runInner 的控制流（只搬运，不改逻辑）
```

## 6. 验证命令

```bash
npx tsc --noEmit                                    # typecheck
npm exec -- tsx --test src/agent/__tests__/loop.test.ts  # 主测试（当前 33/34，1 预存失败）
```
