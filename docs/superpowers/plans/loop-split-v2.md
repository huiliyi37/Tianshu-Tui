# loop.ts 拆分 v2 — 复盘总结

> **完成日期:** 2026-06-03

**最终结果：** loop.ts 从 1856 → 1574 行（-282 行，-15%），拆出 4 个新文件（365 行）。

## 已完成

| 任务 | 新文件 | 行数 | 内容 |
|------|--------|------|------|
| Task 1+2 | `loop-types.ts` | 94 | AgentConfig, AgentCallbacks, ApprovalMode 类型 |
| Task 3 | `loop-factory.ts` | 119 | 4 个控制器工厂函数 (createTurnStreamController 等) |
| Task 4 | `tool-history-recorder.ts` | 84 | recordToolHistory + deferred immune/physarum/P3 处理 |
| Task 5 | `theta-controller.ts` | 68 | requestThetaCheck 状态机 + THETA_MAX 常量 |

## 关键技术决策

1. **ts-morph AST 重构** — 最初尝试 regex 直接修改失败；引入 ts-morph 做正规 AST 操作后，37 个 private 关键字被安全移除，`config`/`session` 从 constructor 参数属性转换为独立属性声明
2. **两阶段 refactoring 脚本** — `scripts/refactor-loop.ts` 和 `scripts/refactor-loop-task45.ts` 实现了可复现的 AST 级重构
3. **Task 6 (turn-preflight) 暂停** — `_runInner` 中 compaction/perception/CVM 块含有 `return`/`continue` 等循环控制流语句，提取为独立函数需引入状态机模式，延后到独立会话处理

## 未完成

| 任务 | 原因 |
|------|------|
| Task 6 (turn-preflight) | 核心循环控制流 (`return`/`continue`) 无法直接提取为函数，需要状态机/异常模式重构 |
| Task 7 (收尾) | 依赖 Task 6 |

## 验证

- `npx tsc --noEmit` — 零错误
- `npm exec -- tsx --test src/agent/__tests__/loop.test.ts` — 34/34 通过
