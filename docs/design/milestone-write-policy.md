# 里程碑写入策略 — plan_close 闭环触发

## 背景

天枢每日 ~80 次 session，constellation-hook 在每个 postSession 自动写入匿名里程碑（symbol `·`），导致低价值记录堆积。

## 当前策略（v2）

里程碑**只在以下 3 个互斥入口被触发时写入**：

| 入口 | 触发时机 | 写入内容 |
|------|----------|----------|
| `plan_close` (apply=true) | plan spec 执行闭环 | 里程碑 (type=milestone, summary=plan file + tasks + deliveryState) |
| `leave_mark` 工具 | agent 主动离开时 | 里程碑 (type=自选, summary=自选) |
| `/leave` 用户命令 | 用户手动 | 里程碑 (同上) |

子代理 / worker / 无 plan 的短会话 → **不写入里程碑**。

## 数据流

```
plan_close (apply=true 成功)
  → params.onPlanClosed({ planFile, tasks, deliveryState, totalChangedCheckboxes })
    → tool-pipeline → tool-execution → loop-factory
      → AgentLoop.handlePlanClosed()
        → buildAgentMark(VOID_SYMBOL, domain, numericId)
        → buildDepartureMilestone(sessionId, agentMark, domain, summary)
        → appendMilestone(cwd, milestone)
```

## constellation-hook 变更

- **删除**: safety-net 路径（匿名 `·` milestone 自动写入）
- **保留**: `getPendingMark` 路径（agent 主动 `leave_mark` 时仍生效）
- **保留**: P3 skeleton 增量更新（`surveyAndUpdateSkeleton` 在 postSession 无条件触发）

## 涉及文件

- `src/tools/types.ts` — `PlanClosedInput` 接口 + `onPlanClosed?` 回调
- `src/tools/plan-close.ts` — apply=true 成功路径调用回调
- `src/agent/tool-pipeline.ts` — 透传 `onPlanClosed`
- `src/agent/tool-execution.ts` — 透传 `onPlanClosed`
- `src/agent/loop-factory.ts` — 绑定 `self.handlePlanClosed`
- `src/agent/loop.ts` — 实现 `handlePlanClosed()` 构造 + 写入里程碑
- `src/agent/hooks/constellation-hook.ts` — 移除 safety-net，保留 mark + skeleton

## 预期效果

- 每天 80 次提交 → ~3-5 条里程碑（对应 3-5 个 plan 闭环）
- 里程碑质量高：每条对应一个完整的 plan spec 交付
- agent 仍可通过 `leave_mark` 主动留印记（自愿行为，不是噪声）
- skeleton 增量更新不受影响
