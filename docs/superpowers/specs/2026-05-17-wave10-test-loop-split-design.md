# Wave 10: 测试补强 + loop.ts 拆分 设计规格

## 目标

1. 补齐 compact 子系统和 session-persist 的测试覆盖
2. 将 loop.ts (815行) 拆分为 3 个模块，降低认知负载

## 架构

### Part 1: 测试补强

| 文件 | 测试目标 |
|------|---------|
| `src/compact/auto.ts` | shouldAutoCompact 4 种 decision、buildSummaryPrompt head/tail 截断、smartCompact LLM 成功/失败 fallback |
| `src/compact/micro.ts` | microCompact 保留 anchor+recent、estimateTokens 精度 |
| `src/agent/session-persist.ts` | persist/load 往返、buildMemoryBlock、getSessionMemoryState |

### Part 2: loop.ts 拆分

#### 新模块 1: `src/agent/tool-pipeline.ts`

**职责：** 单个 tool use 的完整执行流程

```typescript
export interface ToolPipelineContext {
  config: AgentConfig
  cwd: string
  harness: TurnHarness
  prewarm: PrewarmCache
  evidence: EvidenceTracker
  traceStore: TraceStore
  repairHintTracker: RepairHintTracker
  importGraph: ImportGraph | null
  lastConflictCheckCount: number
}

export interface ToolExecutionResult {
  toolResult: { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean }
  importGraph: ImportGraph | null
  lastConflictCheckCount: number
  checkpointHash?: string
}

export async function executeToolUse(
  tu: { id: string; name: string; input: Record<string, unknown> },
  ctx: ToolPipelineContext,
  callbacks: AgentCallbacks,
  turn: number,
  checkpointCreatedThisTurn: boolean,
): Promise<ToolExecutionResult>
```

**包含逻辑（从 loop.ts 提取）：**
- Pre-execution: checkpoint creation, file history tracking, agent-touched-file recording
- Execution: prewarm fast-path, harness.executeTool, post-hook
- Post-execution: LSP diagnostics, trace recording, claim extraction, conflict detection, antibody, evidence tracking, import graph invalidation, prewarm invalidation

#### 新模块 2: `src/agent/turn-end.ts`

**职责：** Tool loop 结束后的 turn-level 处理

```typescript
export interface TurnEndContext {
  config: AgentConfig
  session: SessionContext
  trajectory: TrajectoryRecorder
  streamedText: string
  routingMetrics: RoutingMetricsCollector
  decisions: string[]
  evidence: EvidenceTracker
}

export interface TurnEndResult {
  decisions: string[]
  badge: string | null
}

export function processTurnEnd(ctx: TurnEndContext): TurnEndResult
```

**包含逻辑：**
- Task state extraction + volatile context injection
- Behavior mirror detection
- Model routing (inferTaskType → recommendModelForTask → onModelSwitch)
- Decision extraction
- Evidence badge generation
- Ledger refresh

#### loop.ts 保留

- AgentLoop class definition + constructor + abort/setApprovalMode
- `run()` 核心循环: message assembly → API stream → content block collection → approval flow
- 调用 `executeToolUse()` 和 `processTurnEnd()`
- refreshActiveClaims, recordUserInputClaims, enforceContextCeiling, maybePrewarm
- 预计从 815 行降到 ~480 行

### 拆分原则

1. **组合非继承：** loop.ts 持有 pipeline context，传给函数调用
2. **无 API 变更：** AgentLoop.run() 签名不变，外部无感知
3. **状态回传：** executeToolUse 返回 importGraph/lastConflictCheckCount 等可变状态，loop 更新自身字段
4. **可测试性：** 新模块可独立 mock 测试，不需要完整 AgentLoop 实例

## 验收标准

| 标准 | 验证 |
|------|------|
| compact/auto.ts 测试覆盖 shouldAutoCompact 全部 4 种 reason | npm test |
| compact/micro.ts 测试覆盖 microCompact + estimateTokens | npm test |
| session-persist.ts 测试覆盖 persist/load/memory | npm test |
| tool-pipeline.ts 独立测试 | npm test |
| turn-end.ts 独立测试 | npm test |
| loop.ts ≤ 500 行 | wc -l |
| 全量测试通过 | npm test: 0 fail |
| Typecheck 通过 | npx tsc --noEmit: 0 errors |
| AgentLoop 外部 API 不变 | 无 import 变更 in main.tsx/goal-loop.ts |
