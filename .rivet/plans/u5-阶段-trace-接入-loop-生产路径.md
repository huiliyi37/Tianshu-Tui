# U5 阶段 — PlanExecutionTrace 接入 loop.ts 生产路径

## 背景

U1-U4 产出了 `plan-execution-trace.ts`（数据模型 + 纯函数）和 `replan-loop.ts`（偏差检测 + 修正），62 测试全绿。但审查发现：**两个模块零生产消费方**——loop.ts 不 import 它们，agent 运行时完全不知道它们存在。

U3（LSP 升权）和 U4（contractStatus 接入）是活的——`affordance.ts:computeAffordanceScores()` 在 planning 阶段将 LSP 工具 epistemic +0.15，`loop.ts:1834` 将 `this.taskContract?.status` 流入 `AffordanceState`。

本阶段（U5）的唯一目标：**把 U1+U2 的纯函数接入 loop.ts 回合循环，让 agent 在运行时真正拥有"自主规划→偏差检测→修正路线"的能力**。

### 已就绪资产

| 文件 | 状态 | 内容 |
|------|------|------|
| `src/agent/plan-execution-trace.ts` | ✅ 31 测试绿 | `createTrace` / `appendResult` / `detectDeviation` / `serializeTrace` / `inferExpectedTools` |
| `src/agent/replan-loop.ts` | ✅ 11 测试绿 | `correctPlan` / `injectReplanContext` |
| `src/agent/affordance.ts` U3+U4 | ✅ 生产路径生效 | planning 阶段 LSP 升权（`contractStatus` 可选字段驱动） |

### 设计偏离记录（U1-U4 执行者标注，天权确认合理）

1. **detectDeviation replanned 检测位置** — 从末尾移到 `!lastResult` 之前，否则无 lastResult 时漏判"所有步骤已完成"
2. **文件路径** — 计划写 `src/agent/task-contract.ts`，实际在 `src/context/task-contract.ts`
3. **AffordanceState 升权方式** — 计划说加 `planningPhase` 参数，实际加 `contractStatus?` 可选字段（复用已有 6 态合同，不新建枚举）

### 已知小问题

- `replan-loop.ts:28` — `let stepCounter = 0` 是模块级可变状态，多会话并发时步 ID 会交叉。不影响正确性（trace 会话隔离），影响可调试性。U5 可顺手修。

## loop.ts 回合循环结构（挂载点定位）

```
_runInner() (L2038)
  └─ initializeRun() (L1317)
       └─ L1435: this.taskContract = extractTaskContract(...)
       └─ L1447: this._taskDepthLayer = classifyTaskDepth(...)
  └─ for (turn loop) (L2065+)
       ├─ Step 6b: runCompaction (L2091-2098)
       │    └─ maybeCompact → compactResult.compacted (L1905-1910)
       ├─ Step 6c: runPerception (L2120-2125)
       │    └─ L1862-1865: contractStatus = contractStatusFromPhaseClass(phaseClass)
       │    └─ L1834: contractStatus 流入 AffordanceState
       ├─ Step 6d: runConvergenceCheck (L2128-2139)
       ├─ >>> 挂载点 2: replan loop <<< (L2139-2142 之间)
       ├─ Step 6f: buildTurnRequest (L2143-2145)
       └─ turnStream.streamTurn() (L2180+)
            └─ 工具执行 → traceStore 事件追加
```

## 改动计划

### W5a — Trace 字段 + 创建 + StepResult 构建

**改 `src/agent/loop.ts`**：

1. **新字段**（~L194 附近，和其他私有字段一起）：
```typescript
/** U1: Plan execution trace — null 当无活跃 task 或 chat turn */
private planTrace: PlanExecutionTrace | null = null
```

2. **import**（~L23 附近）：
```typescript
import { createTrace, appendResult, serializeTrace, type PlanExecutionTrace, type StepResult } from './plan-execution-trace.js'
import { detectDeviation, correctPlan, injectReplanContext } from './replan-loop.js'
```

3. **initializeRun 中创建 trace**（L1449 之后，`classifyTaskDepth` 之后）：
```typescript
// U1: 创建执行轨迹 — 仅 task turn 创建，followUp/chat 不创建
if (this.taskContract && this._taskDepthLayer && turnMode === 'task') {
  this.planTrace = createTrace(this.taskContract.id, this._taskDepthLayer)
}
```

4. **新方法 `buildStepResultFromTurn`**（~L1140 附近，和其他 getter 一起）：
```typescript
/**
 * U1: 从当前 turn 的工具事件构建 StepResult。
 * 从 traceStore.events 提取本 turn 的工具调用，映射到当前活跃步骤。
 */
private buildStepResultFromTurn(turn: number): StepResult | null {
  if (!this.planTrace) return null
  
  const toolEvents = this.traceStore.events.filter(
    e => e.turn === turn && e.kind === 'tool'
  )
  if (toolEvents.length === 0) return null
  
  // 当前活跃步骤 = 第一个 pending/active
  const activeStep = this.planTrace.steps.find(
    s => s.status === 'active' || s.status === 'pending'
  )
  // 如果没有预定义步骤，用第一个 step 或 fallback
  const stepId = activeStep?.id ?? this.planTrace.steps[0]?.id ?? 'turn-' + turn
  
  return {
    stepId,
    turnNumber: turn,
    toolCalls: toolEvents.map(e => ({
      tool: e.name,
      result_summary: e.status === 'passed' ? 'ok' : 'failed',
    })),
    status: toolEvents.every(e => e.status === 'passed') ? 'done' : 'blocked',
  }
}
```

**验证**：tsc 绿。`this.planTrace` 在 task turn 后非 null，chat turn 后 null。

### W5b — Turn boundary 偏差检测 + 修正注入

**改 `src/agent/loop.ts`**，在 `runConvergenceCheck` 之后、`buildTurnRequest` 之前插入（L2139-2142 之间）：

```typescript
// ── U2: Replan loop — turn boundary 偏差检测 ──
if (this.planTrace && this.planTrace.status === 'active') {
  const lastResult = this.buildStepResultFromTurn(turn)
  if (lastResult) {
    const updatedTrace = appendResult(this.planTrace, lastResult)
    
    // 从 convergence-detector 获取 level 和 noToolTurnCount
    const convLevel = this.latestConvergenceResult?.level
    const noToolTurns = this.latestConvergenceResult?.signals?.noToolTurnCount
    
    const deviation = detectDeviation(updatedTrace, lastResult, convLevel, noToolTurns)
    if (deviation.type !== 'none') {
      const { trace: corrected, addedSteps } = correctPlan(updatedTrace, deviation)
      this.planTrace = corrected
      const ctx = injectReplanContext(deviation, addedSteps)
      if (ctx.text) this.config.promptEngine.setReplanContext(ctx.text)
    } else {
      this.planTrace = updatedTrace
    }
  } else {
    // 无工具调用的 turn — 检测 stalled
    const noToolTurns = this.latestConvergenceResult?.signals?.noToolTurnCount
    if (noToolTurns !== undefined && noToolTurns >= 3 && this.planTrace.status === 'active') {
      const deviation = detectDeviation(this.planTrace, undefined, undefined, noToolTurns)
      if (deviation.type !== 'none') {
        const { trace: corrected, addedSteps } = correctPlan(this.planTrace, deviation)
        this.planTrace = corrected
        const ctx = injectReplanContext(deviation, addedSteps)
        if (ctx.text) this.config.promptEngine.setReplanContext(ctx.text)
      }
    }
  }
}
```

**需要确认的前置条件**：
- `this.latestConvergenceResult` — loop.ts 是否在 `runConvergenceCheck` 中存储了结果？如果没有，需要加一个字段。
- `this.latestConvergenceResult?.signals?.noToolTurnCount` — convergence-detector 的 `ConvergenceResult` 是否暴露了这个字段？（确认：`convergence-detector.ts` 的 `ConvergenceInput` 有 `noToolTurnCount`，`ConvergenceResult` 有 `signals`）

**验证**：模拟 3 次工具失败 → `detectDeviation` 返回 blocked → `correctPlan` 追加诊断步骤 → `setReplanContext` 写入 promptEngine → 下一 turn 的 prompt 包含 replan context。

### W5c — serializeTrace 压缩注入

**改 `src/agent/loop.ts`**，在 `runCompaction` 的 `compactResult.compacted` 之后（L1910 附近）：

```typescript
if (compactResult.compacted && this.planTrace) {
  const traceXml = serializeTrace(this.planTrace)
  if (traceXml) {
    this.config.promptEngine.setPlanTraceAppendix(traceXml)
  }
}
```

**改 `src/prompt/engine.ts`**：加 `setPlanTraceAppendix(xml: string | null)` setter，在 `buildDynamicAppendix` 中拼接（同 `setPlanCacheAdvisory` 模式）。

**验证**：压缩后 `<plan-execution-trace>` 出现在动态附录中。

### W5d — 集成测试

**新建 `src/agent/__tests__/trace-integration.test.ts`**：

测试场景（纯函数模拟，不需要真实 AgentLoop）：
1. **完整生命周期**：createTrace → appendResult ×3 → detectDeviation(none) → serializeTrace → XML 包含 3 个 result
2. **偏差修正**：createTrace → appendResult(blocked) ×3 → detectDeviation(blocked) → correctPlan → trace 有追加步骤 → serializeTrace 包含修正步骤
3. **压缩保留**：serializeTrace 后的 XML 包含 `<plan-execution-trace status="..." depth="...">` 结构
4. **空 trace**：createTrace(0 steps) → serializeTrace → 空字符串
5. **stalled 检测**：createTrace + noToolTurnCount=4 → detectDeviation(stalled)

**反证测试**：
| 偷懒实现 | 会红的测试 |
|----------|-----------|
| `buildStepResultFromTurn` 不从 traceStore 读取，返回硬编码 | `stepResult toolCalls match traceStore events for given turn` |
| `appendResult` 不推进 step 状态 | `step status transitions to done after appendResult(done)` |
| `detectDeviation` 不检查 convergence level | `blocked detected when convergenceLevel >= 2` |
| `serializeTrace` 不包含 history | `serialized XML contains recent-history block` |
| 压缩后 setPlanTraceAppendix 不被调用 | `compactResult.compacted triggers setPlanTraceAppendix` |

## 执行波次

| Wave | 改动 | 文件 | 风险 | 过门 |
|------|------|------|------|------|
| W5a | planTrace 字段 + createTrace + buildStepResultFromTurn | loop.ts ~30 行 | 低 | tsc 绿；task turn 后 planTrace !== null |
| W5b | turn boundary 偏差检测 + correctPlan + setReplanContext | loop.ts ~30 行 | 中 | 模拟连续失败 → replan context 注入 |
| W5c | serializeTrace 压缩注入 + PromptEngine setter | loop.ts ~5 行 + engine.ts ~15 行 | 低 | 压缩后 XML 在附录 |
| W5d | 集成测试 | trace-integration.test.ts ~100 行 | — | 5 场景 + 5 反证全绿 |

## 缰绳

- **不改 loop.ts 的回合控制流**——只在已有 step 之间插入，不改 step 的顺序或条件
- **前缀缓存安全**——trace 走动态附录（同 task-anchor / planCacheAdvisory），不碰冻结前缀
- **零开销 for chat turn**——`this.planTrace` 为 null 时所有 trace 逻辑短路
- **多会话安全**——`planTrace` 是 AgentLoop 实例字段，每会话独立（同 `taskContract`）

## 顺手修

`replan-loop.ts:28` — `let stepCounter = 0` 改为 `correctPlan` 内部用 `trace.steps.length + 1` 生成步 ID，消除模块级可变状态。
