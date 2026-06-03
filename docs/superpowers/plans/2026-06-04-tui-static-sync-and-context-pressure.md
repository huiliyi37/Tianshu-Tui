# TUI Static 同步 & 上下文压力优化

> **面向 AI 代理：** 逐任务实现此计划。步骤使用复选框（`- [x]`）语法来跟踪进度。

**目标：** 修复 Ink `<Static>` 组件与环形缓冲区之间的索引不同步导致消息"吞掉"的 bug，以及 200K 窗口下大型文件读取导致上下文瞬间爆满卡死的问题。

**根因分析：** 两个独立问题：
1. `totalItemsPushedRef` 在 rewind 后未重置 → `staticItemsForInk` 的 `start` 偏移越界 → `<Static>` 渲染空切片
2. `totalItemsPushedRef` 在 pushStatic 中逐个递增但 `setHistoryVersion` 在微任务中批量触发 → useMemo 在两个更新之间读到不一致的快照
3. 200K 窗口下 `computeModelReadCap` 返回 40K chars/次调用，无每轮总量预算，多文件读取瞬间吃满上下文

**技术栈：** TypeScript strict, Ink 6 (React TUI), node:test + assert/strict

---

## 1. Scope Check

| 子系统 | 是否涉及 | 原因 |
|--------|---------|------|
| `src/tui/app.tsx` | ✅ 是 | pushStatic 批处理、totalItemsPushedRef 重置 |
| `src/tui/hooks/use-rewind.ts` | ✅ 是 | rewind 后同步 totalItemsPushedRef |
| `src/tools/model-read-cap.ts` | ✅ 是 | 降低 200K 窗口下的单次读取上限 |
| `src/agent/per-message-budget.ts` | ✅ 是 | 添加每轮总读取预算 |
| `src/agent/loop.ts` | ❌ 否 | 心跳和 abort 机制已正常 |
| `src/api/` | ❌ 否 | API 层不涉及 |

---

## 2. Tasks

### Task 1: 修复 rewind 后 totalItemsPushedRef 不同步 ✅

**状态：已完成** — commit c460852

- `use-rewind.ts` 接收 `totalItemsPushedRef`，在 `handleRewind` 清空 buffer 后重置为 `cutIdx`
- `app.tsx` 传入 `totalItemsPushedRef` 给 `useRewind`

**验证：** tsc --noEmit 通过，无回归。

### Task 2: 修复 pushStatic 批处理中 totalItemsPushedRef 与 setHistoryVersion 的竞态 ✅

**状态：已完成** — commit b723930

- `pushStatic` 不再逐个递增 `totalItemsPushedRef`
- 改为在微任务回调中一次性 `totalItemsPushedRef += batch.length`
- 与 `setHistoryVersion(v + 1)` 原子执行，确保 `staticItemsForInk` 的 useMemo 读取一致的快照
- 同时修复 `flushStreamingState` 中流式缓冲区清理顺序：先清 streamBuf/streamLiveBuf，再归档到 Static

### Task 3: 恢复 flushStreamingState 中的 streaming 状态重置 ✅

**状态：已完成** — commit (latest)

- 在 buffer 清理后、归档前恢复 `setStreamingText('')` / `setStreamingThinking('')` / `setIsStreaming(false)`
- 防止 turn 完成后 UI 卡在 streaming 模式

### Task 4: 降低 200K 窗口下的单次读取上限 🔲

**问题：** 200K 窗口下 `computeModelReadCap` 返回 40K chars（~10K tokens）。模型一次可以读 4 个 40K 文件 = 40K tokens，加上 system prompt + 对话历史，轻松超过 100K tokens。API 推理变慢甚至超时。

**方案：** 在 `model-read-cap.ts` 中为 <300K 窗口使用更保守的 TOKEN_FRACTION_PER_CALL：
- ≥500K: 5%（当前行为，不变）
- 200K–500K: 3%（单次上限 ~24K chars = ~6K tokens）
- <200K: 2%（单次上限 ~16K chars = ~4K tokens）

**文件：** `src/tools/model-read-cap.ts`

**验证：** 修改后 `computeModelReadCap` 的返回值符合预期，`read-file.test.ts` 通过。

### Task 5: 添加每轮总读取预算 🔲

**问题：** 即使单次读取限制合理，一轮 turn 中可以读很多文件。当前没有总预算限制。

**方案：** 在 `tool-execution.ts` 的 `executeBatch` 中追踪本轮已读取的字符总量。当累计超过 `contextWindow * 0.15 * CHARS_PER_TOKEN` 时，后续 read_file 调用自动截断为摘要模式（只返回结构概要 + 行号范围）。

**文件：** `src/agent/tool-execution.ts`, `src/agent/per-message-budget.ts`

**验证：** 单元测试覆盖预算耗尽场景。

### Task 6: 大文件预检 — 在 read_file 返回前估算 token 成本 🔲

**问题：** 用户报告"一瞬间就卡死了"。原因是 200K 窗口下读大文件（如 loop.ts 62KB）后上下文接近满载，API 响应极慢。

**方案：** 在 `read-file.ts` 的 `execute` 中，在 `readFilePayload` 之后、返回之前，估算当前上下文使用率（`session.getEstimatedTokens()`）。如果使用率 >70%，对非关键文件（非当前编辑目标）自动截断为前 200 行 + 结构概要。

**文件：** `src/tools/read-file.ts`

**验证：** 模拟高上下文压力下 read_file 的截断行为。

---

## 3. Dependency Graph

```
Task 1 ✅ ──┐
Task 2 ✅ ──┼── 基础：Static 渲染同步
Task 3 ✅ ──┘
Task 4 🔲 ──── 独立：读取上限调整
Task 5 🔲 ──── 依赖 Task 4
Task 6 🔲 ──── 依赖 Task 4，可与 Task 5 并行
```

## 4. Risk Assessment

| 风险 | 等级 | 缓解 |
|------|------|------|
| 降低 read cap 影响模型代码理解 | 中 | 只在 <300K 窗口生效，大窗口不变 |
| 每轮预算限制导致模型无法读到关键文件 | 低 | 预算设为 15% 窗口，足够 3-5 个文件 |
| 预检截断丢失关键上下文 | 低 | 当前编辑目标文件豁免 |

---

## 5. Context Window Budget Map

| 窗口大小 | 单次 read cap | 每轮预算 (15%) | 当前 minChars | prune 触发 |
|----------|-------------|---------------|-------------|-----------|
| 1M | 200K chars (50K tok) | 150K tok | 150K chars | ~30 turns |
| 500K | 100K chars (25K tok) | 75K tok | 150K chars | ~30 turns |
| 200K | 24K chars (6K tok) ← Task 4 | 30K tok | 40K chars | ~12 turns |
| 128K | 16K chars (4K tok) ← Task 4 | 19K tok | 30K chars | ~4 turns |
