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

---

## 审查人补充：`_runInner` 控制流地图（方案 B 执行指南）

> 审查人：天府（DeepSeek V4-PRO）· 2026-06-04
> 基于对 `src/agent/loop.ts` L798–1530 的逐行审查

### `_runInner` 结构概览

| 段落 | 行号（近似） | 行数 | 可提取 | 控制流 |
|------|-------------|------|--------|--------|
| Setup（pre-loop） | L798–901 | ~103 | ✅ 独立函数 | 无 |
| Turn init + abort gate | L902–920 | ~18 | ✅ 返回 action | 1× `return` |
| Compaction block | L920–1000 | ~80 | ⚠️ 返回 result | 3× `return`（abort） |
| Prewarm + freshness | L1000–1015 | ~15 | ✅ 独立函数 | 无 |
| Perception | L1015–1078 | ~63 | ✅ 独立函数 | 无 |
| Season + Convergence | L1078–1192 | ~114 | ⚠️ 返回 action | 2× `return`, 1× `continue` |
| Intent evaluation | L1192–1200 | ~8 | ⚠️ 返回 action | 1× `continue` |
| CVM cognitive prep | L1200–1278 | ~78 | ✅ 独立函数 | 无 |
| Cross-session + prompt | L1278–1380 | ~102 | ✅ 独立函数 | 1× `continue` |
| Stream + tool execution | L1380–1530 | ~150 | ❌ 保留 | 2× `return`, 2× `continue` |

### 控制流约束（9× `return`, 4× `continue` in for loop）

**Abort returns（必须返回给 `run()`）:**
1. L910: `abortController.signal.aborted` → `return`
2. L932: `trySessionSplit` 后 abort → `return`
3. L946: `maybeCompact` 后 abort → `return`
4. L1160: convergence abort → `return`
5. L1192: convergence abort → `return`（无 `userMessageConsumed` 清理变体）
6. L1320/L1325: `enforceContextCeiling` 后 abort → `return`
7. L1412/L1419: stream 循环内 abort → `return`

**Continue（跳到下一 turn）:**
1. L1177: intent veto → `continue`
2. L1381: `convergence kick` 后 continue（实际上不是，是 stream 后 dedup）
3. L1477: tool-result 循环中 skip → `continue`
4. L1501: tool-result 循环中 skip → `continue`

### 推荐的提取顺序（方案 B，每步独立可验证）

**Step 6a: `initializeRun()`（~103 行）**
- L798–901 全部代码，无控制流问题
- 输入：`userInput: string, callbacks: AgentCallbacks`
- 输出：无（修改 `this` 状态，初始化各控制器）
- 验证：单次 `run()` 行为不变

**Step 6b: `runCompaction(turn, compactFailures)`（~80 行）**
- 提取 L920–1000 的 compaction 块
- 返回：`{ compacted: boolean, failures: ..., shouldAbort: boolean, userMessageConsumed: boolean }`
- 调用方根据 `shouldAbort` 决定是否 `return`
- 验证：compaction 行为 + abort 处理不变

**Step 6c: `runPerception(turn, estTokens, ...)`（~63 行）**
- L1015–1078，纯数据变换
- 返回：`{ sensorium, strategy, vigor, thetaState }`
- 无控制流问题
- 验证：perception 输出不变

**Step 6d: `runConvergenceCheck(turn, phaseClass, ...)`（~114 行）**
- L1078–1192，最复杂的块
- 返回：`{ action: 'abort' | 'continue' | 'kick' | 'force-split' | 'proceed', ... }`
- 调用方根据 `action` 执行对应控制流
- 验证：收敛检测行为不变

**Step 6e: `runCognitivePrep(turn, ...)`（~78 行）**
- L1200–1278，CVM 认知投影构建
- 无控制流问题
- 验证：CVM 输出不变

**Step 6f: `buildTurnRequest(turn, ...)`（~102 行）**
- L1278–1380，cross-session + prompt build
- 1× `continue` 需要转为返回值
- 验证：prompt 构建不变

**保留在 `_runInner`：** for 循环骨架 + abort/continue 分发 + stream + tool execution（~150 行）

### 预期效果

| 指标 | 当前 | Step 6a-f 后 |
|------|------|-------------|
| `_runInner` 行数 | ~733 | ~200（循环骨架） |
| loop.ts 总行数 | ~1571 | ~1050 |
| 提取方法数 | 0 | 6 |
| 每个新方法行数 | — | 15–114 |

### 关键风险

1. **Step 6d（convergence）** 是最高风险块——114 行中含 2× `return` + 1× `continue`，需要仔细映射 action 枚举
2. **Step 6f** 有 1× `continue` 藏在 cross-session event 处理中，容易被遗漏
3. **每个 step 必须独立提交**——不要一次提交多个 step，方便 bisect

---

## 审查人评价

### 规划能力（8/10）

**优点：**
- 依赖图分析准确（Task 1→2→3→4+5→6→7 的顺序完全正确）
- blast radius 分析完整（10 个外部文件逐一列出）
- Task 6 正确识别为"需要状态机"并主动延后——这是正确的工程判断
- 验证标准明确（tsc + 34 tests）
- ts-morph 引入是正确决策（regex 重构在 AST 级操作中不可靠）

**不足：**
- 37 个 private 移除的范围评估不够充分——v2 plan 中只提到"37 个 private 移除"但未分析哪些字段被哪些模块实际需要。应在 Task 3 提交前做 field-level 的访问需求审计。
- loop-factory.ts 的"伪提取"问题在规划阶段就应该预见到——工厂函数接受 `self: AgentLoop` 本质上没有降低耦合，只是物理移动了代码。
- Task 7 的目标（loop.ts ≤ 600 行）不现实——`_runInner` 733 行中有 ~150 行的 stream+tool execution 无法提取（含 4 个 continue/2 个 return），加上 for 循环骨架 ~50 行，加上类声明和公共方法 ~200 行，最小也在 ~400 行以上。600 行的目标需要更多的接口重构。

### 执行质量（7/10）

**优点：**
- 7 个 commit 结构清晰，每个 task 对应 1-2 个 commit
- ts-morph AST 重构比 regex 更安全
- 所有测试通过，无回归
- 复盘文档诚实记录了未完成项和风险

**不足：**
- loop-factory.ts 缩进不一致——`return new TurnStreamController({` 直接跟在函数签名后，没有增加缩进层级。这是 ts-morph 提取的副作用（保留原始代码格式），但应该在提取后手动修正。
- `tool-history-recorder.ts` 和 `theta-controller.ts` 同样直接访问 `self.xxx`，没有通过参数接口。这意味着任何 AgentLoop 字段重命名都需要改 4 个文件。
- 两个 refactor 脚本（refactor-loop.ts + refactor-loop-task45.ts）各 211 行，功能相似但未合并。应提取共享的 AST 工具函数。

### 总评

天权域的规划和执行**达到了可接受的水平**。规划能力（8/10）是亮点——任务拆解、依赖分析、风险评估都很专业。执行的主要问题在于"物理移动 > 逻辑解耦"——代码被移出了 loop.ts，但耦合关系没有真正降低。这是 v3 阶段 Task 7（接口隔离）需要解决的核心问题。

Task 6 的延后决策是**正确的**——_runInner 的控制流复杂度（9× return, 4× continue）确实不适合在同一会话中处理，尤其是在已经完成了 5 个 task 的上下文压力下。

**建议给天权域的下一个任务：** 按 Step 6a→6b→6c 的顺序执行，每步独立提交。Step 6d（convergence）留给有经验的会话处理。
