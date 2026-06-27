# P0 v2: Eval Harness + Continuous Learning（聚焦已有能力版）

## 设计原则：聚焦已有能力，不新建系统

代码深查发现天枢已有 6 个验证相关组件，辅说"放大不是添光，是聚焦"——P0 只加 1 个新文件 + 1 个增强，不新建子系统。

## 已有基础设施（只读引用）

| 已有 | 位置 | 暴露的数据/接口 |
|------|------|----------------|
| **EvidenceTracker** | `src/agent/evidence.ts` | `getVerificationSummary()` → per-file VerificationLevel，`getState()` → filesModified/verifications/deliveryStatus |
| **TrajectoryRecorder** | `src/agent/trajectory.ts` | `getEntries()` → 完整工具调用轨迹（tool/status/target/isError） |
| **processTurnEnd** | `src/agent/turn-end.ts` | turn 结束时调用，已注入 task state + mirror + gate |
| **RuntimeHooks** | `src/agent/runtime-hooks.ts` | postTurn hook 注册系统（5 阶段生命周期） |
| **memory-learning-hook** | `src/agent/hooks/memory-learning-hook.ts` | postTurn: 流式文本 → observation-extractor → 持久化 |
| **observation-extractor** | `src/memory/observation-extractor.ts` | 三层噪声门提取 fact/decision/constraint/preference |
| **session-memory-extract** | `src/agent/session-memory-extract.ts` | 提取 failure_pattern / decision / file_observation |
| **claim-store** | `src/context/claim-store.ts` | failure_pattern (antibody) 持久化 + 审批风险增强 |
| **deliveryGateV2** | `src/agent/delivery-gate-v2.ts` | 权威门禁 GREEN/YELLOW/RED |

## 改动清单

### ① Eval Harness postTurn hook（新建）

**文件**：`src/agent/hooks/eval-harness-hook.ts`

**做什么**：每个 turn 完成后，从 `RuntimeHookSnapshot` + 回调注入的 EvidenceTracker/TrajectoryRecorder 读取数据，计算本轮质量指标。

**不做什么**：不新建分级系统（用 EvidenceTracker 已有的 VerificationLevel），不阻塞 turn（只记录）。

```typescript
// 纯函数：从已有数据计算指标
export function computeTurnMetrics(
  evidence: EvidenceState,
  trajectory: ToolHistoryEntry[],
  turn: number,
): TurnMetrics {
  const modifiedFiles = [...evidence.filesModified]
  const verifications = evidence.verifications
  const deliveryStatus = evidence.deliveryStatus

  // 从轨迹统计工具使用模式
  const editTools = trajectory.filter(e => isEditTool(e.tool))
  const readTools = trajectory.filter(e => isReadTool(e.tool))
  const errorRate = trajectory.length > 0
    ? trajectory.filter(e => e.isError).length / trajectory.length
    : 0

  return {
    turn,
    filesChanged: modifiedFiles.length,
    verificationLevel: aggregateLevel(evidence),
    deliveryStatus,
    errorRate,
    editToReadRatio: readTools.length > 0 ? editTools.length / readTools.length : editTools.length,
    timestamp: Date.now(),
  }
}
```

**指标产出**：
- `pass@k`：最近 k 个 turn 的 deliveryStatus 为 verified 的比例
- `errorRate`：turn 内工具错误率
- `editToReadRatio`：编辑/读取比——高比值意味着"动手前没充分调研"

**注册点**：`create-runtime-hooks.ts` 中注册为 postTurn hook（与 memory-learning 同级）

### ② Continuous Learning 增强（改现有 hook）

**文件**：`src/agent/hooks/memory-learning-hook.ts`（改）

**当前行为**：只从 `getStreamedText()` 提取文本观察（fact/decision/preference）

**增强**：加 2 个缺失信号——从 TrajectoryRecorder 补充

| 新信号 | 提取规则 | 产出 |
|--------|---------|------|
| 同一文件反复修改 | trajectory 中同一 target 被 edit ≥ 5 次 | 持久化为 constraint: "考虑先规划再动手" |
| 高错误率 turn | turn 内 errorRate > 0.3 | 持久化为 failure_pattern → claim-store antibody |

**改动量**：memory-learning-hook 加 ~15 行（从 deps 传入 trajectory，加 2 个 if 判断）

### ③ 指标聚合纯函数（新建）

**文件**：`src/agent/eval-metrics.ts`

**纯函数，无副作用**——从 TurnMetrics[] 聚合出 session 级指标。

```typescript
export function aggregateSessionMetrics(turns: TurnMetrics[]): SessionMetrics {
  const recentK = turns.slice(-10)
  return {
    passAtK: recentK.filter(t => t.deliveryStatus === 'verified').length / Math.max(recentK.length, 1),
    avgErrorRate: avg(recentK.map(t => t.errorRate)),
    highRiskTurns: recentK.filter(t => t.filesChanged >= 3 && t.editToReadRatio > 2).length,
    totalFilesChanged: new Set(turns.flatMap(t => t.changedFiles ?? [])).size,
  }
}
```

## Scope Check

| 文件 | 改动 | 类型 |
|------|------|------|
| `src/agent/hooks/eval-harness-hook.ts` | **新建** | postTurn hook + TurnMetrics 接口 |
| `src/agent/eval-metrics.ts` | **新建** | 纯函数聚合 |
| `src/agent/hooks/memory-learning-hook.ts` | **改** ~15 行 | 加 trajectory 信号提取 |
| `src/agent/create-runtime-hooks.ts` | **改** ~5 行 | 注册 eval-harness hook |
| `src/agent/__tests__/eval-metrics.test.ts` | **新建** | 纯函数测试 |

**不碰**：loop.ts、evidence.ts、turn-end.ts、runtime-hooks.ts、observation-extractor.ts、delivery-gate-v2.ts

## 反证测试

| # | 偷懒实现 | 会红的测试 |
|---|---------|-----------|
| 1 | pass@k 始终返回 1 | 空 turns 数组 → passAtK 应为 0（除零保护） |
| 2 | errorRate 不算 read-only turn | 纯 read turn → errorRate 应为 0（没有编辑操作） |
| 3 | 同一文件反复修改未被检测 | 5 次 edit 同一 target → 应产出 constraint |
| 4 | 高错误率未生成 antibody | errorRate > 0.3 → 应 proposeClaim failure_pattern |

## 验证计划
- tsc 绿
- `eval-metrics.test.ts`：pass@k / errorRate / aggregateSessionMetrics 纯函数
- `eval-harness-hook.test.ts`：hook 注册 + 指标计算
- 全量 agent 测试不回归

## 风险与缓解

| 风险 | 缓解 |
|------|------|
| postTurn hook 增加 turn 延迟 | eval-harness 是纯计算（<1ms），无 I/O |
| 指标写入 .rivet/ 累积垃圾 | 只在 session 级聚合时写，频率低 |
| memory-learning-hook 改动影响现有提取 | 只加新 if 分支，不改现有逻辑路径 |
