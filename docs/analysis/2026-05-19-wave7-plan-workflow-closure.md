# Wave7 /plan 工作流闭环执行记录

> 日期：2026-05-19  
> 关联计划：`docs/superpowers/plans/2026-05-19-wave7-已在分支完成闭环-然后给出计划任务和实施安排-plan命令应该集成了.md`  
> 状态：✅ 已闭环；存在非本任务未跟踪测试文件导致全量 typecheck 阻塞。

## 范围

本次执行用户选择的“子代理驱动（推荐）”路径，但实际落地范围为文档和验证闭环：

- 确认 Wave7 已在分支完成闭环，不重写 runtime。
- 确认 `/plan` / `/write-plan` 已集成 writing-plans workflow。
- 更新 Wave7 closure 与核心能力台账，补上 workflow alias 状态。
- 查看 Wave8 方案并给出风险观察。

## 已完成事项

| 项目 | 状态 | 证据 |
|---|---|---|
| Wave7 基线读取 | ✅ | 已读 `2026-05-16-rivet-wave7-subagent-wiring.md`、`2026-05-19-wave7-closure.md`、Wave7 design |
| `/plan` helper 验证 | ✅ | `src/workflows/__tests__/ecosystem-workflows.test.ts`：7 passed |
| `/plan` slash 验证 | ✅ | `src/tui/__tests__/slash-commands.test.ts`：13 passed |
| Wave7 closure 补充 | ✅ | 新增“相关工作流闭环”段落 |
| 核心能力台账补充 | ✅ | 新增 `Workflow Aliases (/plan)` Verified 行，Verified 计数 44 → 45 |
| 计划文档状态补充 | ✅ | 新增“执行状态”段落 |
| Wave8 方案阅读 | ✅ | 已读 `2026-05-19-wave8-hands-worktree-knowledge.md` 前 180 行 |

## 验证结果

```bash
./node_modules/.bin/tsx --test src/workflows/__tests__/ecosystem-workflows.test.ts
# 7 passed, 0 failed, 0 skipped

./node_modules/.bin/tsx --test src/tui/__tests__/slash-commands.test.ts
# 13 passed, 0 failed, 0 skipped
```

禁用占位符扫描：无命中。

## 阻塞说明

`npx tsc --noEmit` 当前失败，但失败来自工作区已有的未跟踪文件：

- `src/agent/__tests__/subagent-integration.test.ts`
- `src/agent/__tests__/mocks.ts`
- `src/agent/__tests__/diff-collector.test.ts`

错误集中在 `subagent-integration.test.ts`：

- `VolatileContext` 不存在 `osInfo` 字段。
- 多处 callback mock 缺少 `onToolUse`、`onToolResult`、`onError`、`onUsage`、`onCheckpoint`、`onEvidence`、`onToolStarted`、`onToolCompleted` 等字段。

这些文件不属于本次 `/plan` 文档闭环改动，按并发会话规则未修改。

## Wave8 方案观察

已读 `docs/superpowers/plans/2026-05-19-wave8-hands-worktree-knowledge.md`。方案方向与 Wave7 闭环顺序一致：

1. 先定义 Brain/Hands/readonly 的职责边界。
2. 再做 worktree 生命周期和 diff artifact。
3. 最后把 write profile 路由到 HandsSession，并增加只读知识投影。

建议执行时重点守住三条边界：

- Brain 不应拥有 concrete file/code tools，避免 delegation recursion 和主控权混乱。
- Hands 不应拥有 `delegate_task` / `delegate_batch`，避免 worker 嵌套调度。
- write worker 的变更必须以 diff artifact 回流，不直接污染 primary worktree。

## 待办列表

| 优先级 | 待办 | 状态 |
|---|---|---|
| P0 | 由 Wave8 执行方修复未跟踪 `src/agent/__tests__/subagent-integration.test.ts` 类型错误 | 外部进行中 |
| P0 | Wave8 任务 1：`coordination-policy.ts` + tests | 已安排 |
| P0 | Wave8 任务 2：`diff-collector.ts` + tests | 已安排 |
| P1 | Wave8 worktree coordinator 和 HandsSession 分阶段接入 | 已安排 |
| P1 | 本任务相关文档提交前排除 `.rivet/*` 运行态文件和他人未跟踪测试文件 | 待提交时确认 |

## 结论

Wave7 `/plan` 工作流闭环任务已完成：计划已保存，状态文档已补齐，targeted tests 已通过。全量 typecheck 的当前失败由并发 Wave8 未跟踪测试文件引起，不归因于本任务。
