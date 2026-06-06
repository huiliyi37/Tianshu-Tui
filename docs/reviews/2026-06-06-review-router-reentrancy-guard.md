# ReviewRouter 重入护栏复核记录

> 日期：2026-06-06  
> 对象：`8381c8b`（任务4）+ `b62d533`（任务5）  
> 结论：审查意见成立；原实现的重入护栏只在 `deliver_task` 本地 ctx 生效，未跨 delegate 边界结构化传播。

## 问题

`deliver_task` 已有 `reviewDepth > 0` 时跳过 ReviewRouter 的判断，但 `review-coordinator-deps` 只把子级 depth 写进 worker objective 文本：

```text
Review depth: N. Do not call deliver_task from review workers; report verdict/evidence only.
```

这属于软约束。worker 如果仍调用 `deliver_task(commit=true, message='fix: ...')`，它的工具上下文里没有结构化 depth，`deliver_task` 会按默认 `0` 再次触发 ReviewRouter，存在递归派生 verifier/patcher 的风险。`maxRounds` 只能限制单次 router 的修补循环，不能限制跨 `deliver_task` 调用的嵌套递归。

## 修复

本次补齐结构化传播链：

1. `DelegationRequest.reviewDepth`：review deps 创建 worker 请求时写入 `parentDepth + 1`。
2. `WorkOrder.reviewDepth`：coordinator 创建 work order 时保留该 metadata。
3. `WorkerSessionConfig.reviewDepth`：coordinator 调 `runtimeFactory` 后把 order depth 写入 worker runtime config。
4. `AgentConfig.reviewDepth`：worker `AgentLoop` 持有 depth。
5. `ToolCallParams.reviewDepth`：tool-pipeline 执行任意 worker 工具时带上 depth。
6. `deliver_task`：优先读取 `params.reviewDepth`，再回退到 B1 ctx 的 `reviewDepth`。

objective 中的文字保留为防御纵深，但不再是唯一防线。

## 测试补强

新增/扩展以下断言：

- `review-coordinator-deps.test.ts`：`spawnVerifier` / `spawnPatcher` / `spawnSquadron` 生成的 `DelegationRequest.reviewDepth` 为 `parent + 1`。
- `coordinator.test.ts`：`DelegationRequest.reviewDepth` 能进入 `WorkOrder` 与 `WorkerSessionConfig`。
- `deliver-task.test.ts`：当 `ToolCallParams.reviewDepth > 0` 时，即使消息是 `fix:`，也结构性跳过 ReviewRouter。

## 不变量

ReviewRouter spawn 出来的 review/verifier/patcher worker 不允许通过再次调用 `deliver_task` 触发新的 ReviewRouter。该约束必须由 runtime metadata 执行，不能依赖 prompt 服从。

## 独立复核确认（2026-06-06）

- 追了工作区 diff 全部 `reviewDepth` 落点，确认数值经 `request → work-order → worker config → ToolCallParams → deliver_task(params.reviewDepth ?? ctx ?? 0)` 结构性穿到子代理上下文，护栏由软（prompt）升级为结构。
- `deliver_task` 的 RED `return isError` 位于真正 commit（`commitOwnedFiles`/`commitScopedFiles`）之前，rejected/escalated 确实拦住提交，非装饰。
- 验证报告称「4 个无关失败」成立：干净 HEAD（暂存工作区 plan-close.ts）上 `plan-close.test.ts` 仍红 3，`file-info.ts` 未被本次改动碰过 → 既有失败，非 reviewDepth 回归。

## 交付状态

- M2 修复**当前在工作区未提交**（17 文件）。提交时须**显式列文件**，排除游离改动 `plan-close.ts` / `bash.ts` / `gitignore.ts`（不属本次），避免 `git add .` 搭车。
- 对应计划任务：见 [`../superpowers/plans/2026-06-06-review-discipline-internalization.md`](../superpowers/plans/2026-06-06-review-discipline-internalization.md) 任务 4 / 任务 5。
