# loop.ts 拆分 — 最终收束

> **完成日期:** 2026-06-04
> **参与者:** 天权（v2 规划 + Task 1-5）、天梁（Step 6a-6f）、天府（审查）

**最终结果：** loop.ts 从 1856 → 1690 行（-166 行，-9%），拆出 4 个新文件 + 6 个提取方法。

## 全部完成

### Phase 1: 类型 + 工厂 + 独立函数（天权）

| 任务 | Commit | 新文件 | 行数 | 内容 |
|------|--------|--------|------|------|
| Task 1+2 | `1ee1cec` `25da174` | `loop-types.ts` | 94 | AgentConfig, AgentCallbacks, ApprovalMode 类型 + 10 文件 import 迁移 |
| Task 3 | `b548ce0` | `loop-factory.ts` | 119 | 4 个控制器工厂函数 (createTurnStreamController 等) |
| Task 4 | `2e2e521` | `tool-history-recorder.ts` | 84 | recordToolHistory + deferred immune/physarum/P3 |
| Task 5 | `2e2e521` | `theta-controller.ts` | 68 | requestThetaCheck 状态机 + THETA_MAX 常量 |

### Phase 2: _runInner 方法提取（天梁）

| Step | Commit | 方法 | 行数 | 控制流处理 |
|------|--------|------|------|-----------|
| 6a | `f757058` | `initializeRun()` | ~95 | 返回 `{ heartbeat, wrappedCallbacks, actionable }` |
| 6b | `7aecf42` | `runCompaction()` | ~110 | 返回 `{ compacted, shouldAbort, userMessageConsumed }` |
| 6c | `6dfd209` | `runPerception()` | ~90 | 返回 `{ sensorium, strategy, phaseClass, pressureResult }` |
| 6d | `100df0a` | `runConvergenceCheck()` | ~60 | 返回 `{ action: 'proceed' \| 'abort' }` |
| 6e | `4d63bee` | `runCognitivePrep()` | ~70 | 无控制流（纯数据变换） |
| 6f | `836c44e` | `buildTurnRequest()` | ~85 | 返回 `{ action: 'proceed' \| 'veto' \| 'abort', request? }` |

## 量化指标

| 指标 | 原始 (v2 前) | v2 后 | v3 后 | 总变化 |
|------|-------------|-------|-------|--------|
| loop.ts 行数 | 1856 | 1574 | 1690 | -166 (-9%) |
| _runInner 行数 | ~733 | ~733 | ~308 | -425 (-58%) |
| for-loop 体行数 | ~630 | ~630 | ~332 | -298 (-47%) |
| 拆出文件 | 0 | 4 (365 行) | 4 (365 行) | +4 |
| 提取方法 (private) | 0 | 2 | 8 | +8 |
| 控制流 return/continue in for | 9+4=13 | 9+4=13 | 6+3=9 | -4 |

**注意：** loop.ts 行数从 v2 的 1574 回升到 1690，是因为 Step 6 提取方法增加了返回类型声明和接口定义的开销。但 _runInner 从 733 降到 308（-58%），可读性显著提升。

## 关键技术决策

1. **ts-morph AST 重构** — regex 失败后引入 ts-morph，37 个 private 安全移除
2. **Action 枚举模式** — 用 `{ action: 'proceed' | 'veto' | 'abort' }` 替代 `return`/`continue`，让 for-loop 骨架处理所有控制流
3. **Step 6d 正确处理了最复杂的块** — convergence check 含 2× return + 1× continue，通过 action 枚举干净地映射
4. **不引入新文件** — 6 个提取方法留在 loop.ts 内作为 private 方法，避免过度拆分

## 不做的事项（明确搁置）

| 项目 | 原因 |
|------|------|
| Stream + tool execution 提取 | for-loop 内最后的 ~150 行含 6× return + 3× continue，与 turn 状态（assistantResponded, userMessageConsumed）深度耦合。提取 ROI 不高。 |
| private 恢复 | v2 移除的 37 个 private 中，当前无外部代码访问这些字段。等 stream 块提取后再评估。 |
| loop-factory.ts 解耦 | 工厂函数接受 `self: AgentLoop` 是伪提取。真正的解耦需要接口隔离（定义 `LoopInternals` interface），但工程量大且收益不明显。 |

## 验证

- `npx tsc --noEmit` — 零错误 ✅
- `npm exec -- tsx --test src/agent/__tests__/loop.test.ts` — 34/34 通过 ✅

## 审查评分

| 维度 | 天权 (Phase 1) | 天梁 (Phase 2) |
|------|---------------|---------------|
| 规划 | 8/10 | — (继承 v3 计划) |
| 执行 | 7/10 | 9/10 |
| 控制流处理 | — | 9/10 |
| commit 质量 | 8/10 | 10/10 |

天梁的 Step 6 系列是本次拆分中质量最高的交付：每步一个 commit，commit message 精确描述，action 枚举干净地解决了控制流问题，零回归。
