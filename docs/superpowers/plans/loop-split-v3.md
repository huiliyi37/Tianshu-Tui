# loop.ts 拆分 v3 — 下一阶段计划

> **基线:** loop.ts 1856 → 1571 行（-285 行），拆出 4 个新文件（365 行）
> **审查日期:** 2026-06-03
> **审查人:** 同伴审查

---

## 审查发现与修复

### ✅ C1: THETA_MAX 常量重复（已修复）

`loop.ts` L203-205 保留了 `THETA_MAX_SESSION=40` / `THETA_MAX_PER_TURN=2`，与 `theta-controller.ts` 重复。`requestThetaCheck` 已提取为委托方法，不再引用 AgentLoop 的静态常量。已删除。

---

## 待处理问题

### P1: private 移除范围过大（b548ce0）

**现状:** 37 个 `private` 修饰符被移除，以下字段现为默认 `public`:
```
evidence, recentToolHistory, prewarm, turnBudget, sensorium, strategy,
vigorState, runtimeHooks, contextInjection, repairHintTracker, harness,
routingMetrics, predictionAccumulator, decisions, trajectory, repairPipeline,
session, cacheAdvisor, p3, artifactStore, sessionStateManager,
streamedText, abortController, config, cwd, thetaTelemetry, ...
```

**风险:** 任何 import `AgentLoop` 的代码可直接读写这些字段。

**下阶段目标:** `_runInner` 拆分完成后，将仅用于类内部逻辑的字段恢复为 `private`。只保留 factory/helper 模块确实需要的字段为非 private。

**建议方案:** 引入 `AgentLoopInternals` 接口，只暴露 factory 函数需要的字段子集：
```ts
interface AgentLoopInternals {
  config: AgentConfig; session: SessionContext; cwd: string;
  streamedText: string; prewarm: PrewarmCache;
  // ... 仅 factory/helper 确实需要的字段
}
```
Factory 函数接受 `AgentLoopInternals` 而非 `AgentLoop`，实现真正的接口隔离。

### P2: loop-factory.ts 伪提取

**现状:** 4 个工厂函数接受 `self: AgentLoop`，直接访问其字段。代码物理移出 loop.ts 但耦合度未降低。AgentLoop 字段变更会影响所有 4 个文件。

**下阶段目标:** 引入接口层（如 P1 中的 `AgentLoopInternals`），让 factory 函数依赖接口而非具体类。

### P3: ts-morph 去留

**现状:** `ts-morph` 作为 devDependency（+504 行 package-lock.json）。

**决策:** 如果 Task 6（`_runInner` 拆分）计划继续使用 AST 重构，保留。如果 Task 6 采用手动重构，移除。建议保留——`_runInner` 的复杂性远超之前的提取，AST 工具在后续轮次中仍有价值。

### P4: 遗留 `private` 声明

**现状:** loop.ts 仍有 ~65 个 `private` 声明和约 317 个无修饰符的 public 字段/方法。其中许多 private 字段仅用于类内部逻辑，从未被外部模块访问。

**下阶段:** 配合 P1 的接口隔离，系统性地审查并缩小 public 暴露面。

---

## 下一阶段任务

### Task 6: `_runInner` 拆分（核心任务）

**目标:** 将 `_runInner` 中的 per-turn preflight 提取为独立方法，进一步降低 loop.ts 行数。

**挑战:** `_runInner` 的 for 循环中含有 `return`（abort）和 `continue`（retry/skip），无法直接提取为纯函数。

**方案:**
```ts
// 方案 A: 状态机模式
type TurnAction = 
  | { kind: 'abort'; userMessageConsumed: boolean }
  | { kind: 'continue' }
  | { kind: 'proceed'; state: TurnState };

private async runTurnPreflight(turn: number, ...): Promise<TurnAction> { ... }

// 方案 B: 提取为独立方法（保留控制流在调用方）
private async runTurnCompaction(turn: number, ...): Promise<CompactionResult> { ... }
private async runTurnPerception(turn: number, ...): Promise<PerceptionResult> { ... }
private runTurnCognitivePrep(turn: number, ...): CognitivePrepResult { ... }
```

**推荐:** 方案 B（分块提取），更安全且不改变循环结构。预计减少 `_runInner` ~120 行。

### Task 7: 接口隔离

**目标:** 引入 `AgentLoopInternals` 接口，限制 factory/helper 模块的访问面。

**内容:**
1. 定义 `AgentLoopInternals` 接口（仅包含 factory/helper 确实需要的字段）
2. 修改 `loop-factory.ts`、`tool-history-recorder.ts`、`theta-controller.ts` 接受接口而非 `AgentLoop`
3. 将不需要暴露的字段恢复为 `private`

### Task 8: 收尾清理

1. 移除未使用的 import（ts-morph 重构后可能残留）
2. 审查并移除 ts-morph（如决定不使用）
3. 全量测试 + typecheck 验证

---

## 验证基线

```bash
npx tsc --noEmit                           # 零错误
npm exec -- tsx --test src/agent/__tests__/loop.test.ts  # 34/34 通过
```
