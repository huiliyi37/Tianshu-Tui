# 工作记录：Execution Resilience + Sub-agent Evidence

**日期**: 2026-05-16
**分支**: main

## 背景

实施 `docs/superpowers/plans/2026-05-16-rivet-execution-resilience-subagent-evidence.md` 完整计划（7 任务），将 Rivet 的点状 retry、failure classifier、trajectory、delegate_task 能力升级为可恢复、可审查、可验证的长任务执行系统。

## 提交记录

| Commit | 任务 | 内容 |
|--------|------|------|
| `1ec6449` | 1 | TurnHarness retry semantics tests (maxRetries + non-retryable) |
| `8d3b0d9` | 2 | FailureClassification.retryable boolean field |
| `b0d9198` | 3 | Doom-loop thresholds 2/3 + direct execution blocking |
| `12bbc48` | 4 | Worker result evidenceStatus field |
| `339d6df` | 5 | Aggregation evidence gate (block unverified implementations) |
| `4a68b82` | 6 | Worker prompt evidence contract (RESULT_SHAPE + guidance) |
| `080fc3a` | 7 | README + final validation |

## 架构变更

### 任务 1: TurnHarness retry policy
- 现有实现已有正确 retry 循环语义
- 补充 2 个测试覆盖：maxRetries=2 产生 3 次调用、非 retryable class 不重试

### 任务 2: Failure classifier retryable field
- `ClassifiedFailure` 接口新增 `retryable: boolean`
- timeout/flaky → true，其余 → false
- 下游可直接使用 `retryable` 而不需要再调用 `isTransient()`

### 任务 3: Doom-loop blocking
- 阈值从 3/5 降至 2/3（更早干预）
- 新增直接执行阻断：doom-loop blocked 时，工具不执行，直接返回错误
- 位置：loop.ts 中 preHook 之后、approval 之前

### 任务 4: Worker result evidenceStatus
- `workerResultSchema` 新增 `evidenceStatus: z.enum(['verified', 'failed', 'blocked', 'unverified']).default('unverified')`
- `buildBlockedWorkerResult` 默认设置 `evidenceStatus: 'blocked'`

### 任务 5: Aggregation evidence gate
- `aggregateResults` 在应用 policy 前先检查 evidence gate
- 规则：changedFiles.length > 0 && evidenceStatus !== 'verified' → 标记为 blocked
- 只影响有实际文件修改的结果，只读结果不受影响

### 任务 6: Worker prompt evidence contract
- RESULT_SHAPE 新增 `patchSummary` 和 `evidenceStatus`
- buildWorkerPrompt 新增 evidenceStatus 指导文案
- buildPrimaryWorkerPacket compact 输出包含 evidenceStatus

### 任务 7: README + 验证
- 更新 Execution Resilience 段落（doom-loop 阈值、retryable、直接阻断）
- 新增 Sub-agent Evidence Contract 段落

## 与计划的偏差

| 计划假设 | 实际情况 | 处理 |
|----------|----------|------|
| toolFingerprints 为 `{tool,target,outcome}` 对象 | SHA-256 哈希字符串 | 保持哈希，调整阈值 |
| failure classifier 无 `retryable` 字段 | 已有 `suggestion`，缺 `retryable` | 新增 `retryable` |
| worker result schema 简单 | 已有 findings/artifacts/patchSummary | 在现有 schema 上扩展 evidenceStatus |
| buildPrimaryWorkerPacket 接受 work order | 接受 WorkerResult[] | 只更新 compact 输出包含 evidenceStatus |

## 测试覆盖

最终: 569/570 pass (1 个外部 API 集成测试)

新增测试:
- `turn-harness.test.ts`: +2 (maxRetries 语义 + non-retryable)
- `failure-classifier.test.ts`: +3 (retryable 字段)
- `trace-store.test.ts`: +1 (doom-loop blocked)
- `work-order.test.ts`: +3 (evidenceStatus 字段)
- `aggregation.test.ts`: +2 (evidence gate)
- `worker-prompts.test.ts`: +1 (evidence fields in prompt)

## 关键决策

1. **保持哈希指纹**：不改为结构化对象，因为哈希已捕获 name+input+outputClass 组合，降低阈值更实用
2. **直接阻断而非仅风险提升**：doom-loop blocked 时直接阻止工具执行，不走 approval 流程
3. **evidence gate 在 policy 前**：所有 aggregation policy 都受益于 evidence gate，不与特定 policy 耦合
4. **changedFiles 作为代理**：没有 `kind === 'implement'` 字段，用 `changedFiles.length > 0` 作为实现型 worker 的代理
