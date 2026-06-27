# 桌面端空轮次过滤 实现计划

> **面向 AI 代理：** 使用 subagent-driven-development（推荐）或 executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 消除桌面端对话界面中出现的空「第 N 轮」分隔符——这些轮次由 agent 的内部重试路径（TTSR / thinking-retry / veto）产生，有 `turn_complete` 事件但无任何 text_delta / tool_use 内容。

**架构：** 在前端 `event-reducer.ts` 的 `turn_complete` 处理中，检查上一个 block 是否为内容 block（assistant / tool / result / thinking / user）。如果上一个 block 已经是另一个 turn 分隔符或 blocks 数组为空，则跳过插入新的 turn block。这是纯前端过滤，不改 agent runtime 行为。

**技术栈：** React + TypeScript，`desktop/src/state/event-reducer.ts`

---

## Scope Check

单一文件变更（`event-reducer.ts`），不涉及 agent runtime 或 SSE 传输层。空轮次的根因在 agent 内部重试路径（TTSR 规则触发、thinking-only retry、buildTurnRequest veto），这些路径合法地发出 `onTurnComplete(isFinal=false)` 来 flush TUI 缓冲区——改变 runtime 行为有更广的副作用风险。前端过滤是最小爆炸半径。

## 文件结构

| 文件 | 责任 | 操作 |
|------|------|------|
| `desktop/src/state/event-reducer.ts:155-180` | `turn_complete` case 处理 | 修改：添加空轮次过滤 |
| `desktop/src/state/__tests__/event-reducer.test.ts` | event-reducer 单元测试 | 修改：添加反证测试 |

## 调研背书

### 空轮次的产生路径（agent runtime 侧，不改）

1. **TTSR 规则触发**（`turn-orchestrator.ts:535`）：stream rule 匹配 → `onTurnComplete(usage, turn, false)` → `continue`。此轮可能只有部分 streamed text 被 TUI flush，但桌面端 SSE 只看到 `turn_complete` 事件，前面可能没有任何 text_delta。
2. **Thinking-only retry**（`turn-orchestrator.ts:697`）：模型输出只有 reasoning_content 无 content → `onTurnComplete(false)` → `continue`。桌面端收到 thinking_delta 但无 text_delta。
3. **buildTurnRequest veto**（`turn-orchestrator.ts:~420`）：`turnRequest.action === 'veto'` → `continue`，无任何 stream 调用，自然无 text_delta。

这三条路径的 `onTurnComplete` 调用服务于 TUI 的流式缓冲 flush，**不应在 runtime 侧移除**。问题在于桌面端把每个 `turn_complete` 都渲染为可见的分隔符。

### event-reducer 当前行为

`turn_complete` case（L155-180）无条件 append 一个 `{ kind: 'turn', text: '' }` block。如果前一个 block 也是 `turn`（连续空轮次），或 blocks 为空（第一轮就 veto），用户会看到无意义的分隔符堆叠。

### ThreadView 渲染

`ThreadView.tsx:170-177` 渲染 `kind === 'turn'` 为 `<div className="turn-divider">第 N 轮</div>`。空 text 不影响渲染——分隔符照样显示。

## Tasks

### Task 1：event-reducer 空轮次过滤 + 反证测试

- [ ] 修改 `desktop/src/state/event-reducer.ts`，在 `turn_complete` case 中添加前置检查：如果 `next.blocks` 为空，或最后一个 block 的 `kind === 'turn'`，则跳过插入（直接 `return next`，仍更新 `lastSeq`）

**精确改动**（`event-reducer.ts:155` 附近，`case 'turn_complete':` 内）：

在现有的 `next.blocks = [...next.blocks, ...]` 之前插入：
```typescript
// Filter empty turns: skip the divider if no content block precedes it.
// Agent internal retries (TTSR, thinking-retry, veto) emit turn_complete
// without any text_delta/tool_use — rendering these as visible "第 N 轮"
// dividers creates visual noise with empty gaps.
const lastBlock = next.blocks[next.blocks.length - 1]
if (!lastBlock || lastBlock.kind === 'turn') {
  return next
}
```

- [ ] 修改 `desktop/src/state/__tests__/event-reducer.test.ts`，添加两个测试：

**测试 1 — 连续 turn_complete 不产生空分隔符**：
```typescript
it('skips turn divider when previous block is also a turn', () => {
  let state = initialEventState
  // Simulate: user message → assistant text → turn_complete → (empty turn) → turn_complete
  state = applyEvent(state, { seq: 1, ts: 0, type: 'user', data: { text: 'hi' } })
  state = applyEvent(state, { seq: 2, ts: 0, type: 'text_delta', data: { text: 'hello' } })
  state = applyEvent(state, { seq: 3, ts: 0, type: 'turn_complete', data: { turnNumber: 0, isFinal: false } })
  const beforeCount = state.blocks.length
  // Empty turn (e.g. TTSR retry): no content between two turn_completes
  state = applyEvent(state, { seq: 4, ts: 0, type: 'turn_complete', data: { turnNumber: 1, isFinal: false } })
  assert.equal(state.blocks.length, beforeCount, 'second turn_complete without content should be skipped')
})
```

**测试 2 — 首轮 veto 不产生空分隔符**：
```typescript
it('skips turn divider when blocks array is empty', () => {
  let state = initialEventState
  // First turn is vetoed — no content at all
  state = applyEvent(state, { seq: 1, ts: 0, type: 'turn_complete', data: { turnNumber: 0, isFinal: false } })
  assert.equal(state.blocks.length, 0, 'turn_complete with no preceding content should not create a block')
})
```

- [ ] 运行测试，确认通过

```bash
TMPDIR=/tmp node --import tsx --test desktop/src/state/__tests__/event-reducer.test.ts
```

预期：所有测试 pass（包括新增 2 个 + 已有测试不受影响）。

- [ ] 提交

```bash
git add desktop/src/state/event-reducer.ts desktop/src/state/__tests__/event-reducer.test.ts
git commit -m "fix(desktop): 过滤空轮次分隔符 — TTSR/veto/thinking-retry 产生的无内容 turn_complete 不再渲染"
```

## Verification

```bash
# 1. TypeScript 编译检查
cd desktop && npx tsc --noEmit

# 2. event-reducer 单元测试
TMPDIR=/tmp node --import tsx --test desktop/src/state/__tests__/event-reducer.test.ts

# 3. 手动验证（如果有桌面端运行环境）
# 启动 tauri:dev，触发一个会产生空轮次的场景（如连续 veto 或 TTSR），
# 确认界面不再出现空的「第 N 轮」分隔符
```

## Self-check

### Spec coverage

| 需求 | 覆盖 task |
|------|-----------|
| 空轮次（无内容 block）不显示分隔符 | Task 1 — `!lastBlock` 检查 |
| 连续空轮次不堆叠分隔符 | Task 1 — `lastBlock.kind === 'turn'` 检查 |
| 有内容的轮次正常显示分隔符 | Task 1 不影响——有内容时 lastBlock.kind !== 'turn'，正常 append |

### Placeholder scan

无 TODO / TBD / 待定 / 后续实现。

### Type consistency

- `next.blocks[next.blocks.length - 1]` — `noUncheckedIndexedAccess` 下类型为 `ConvoBlock | undefined`，已用 `!lastBlock` 处理 undefined 分支。
- `lastBlock.kind` — `ConvoKind` 联合类型，`=== 'turn'` 比较合法。

## Execution handoff

计划已完成并保存到 `docs/superpowers/plans/2026-06-15-desktop-empty-turn-filter.md`。两种执行方式：
1. 子代理驱动（推荐）— 每个任务调度一个新的子代理，任务间进行审查，快速迭代。
2. 内联执行 — 在当前会话中使用 executing-plans 执行任务，批量执行并设有检查点。
选哪种方式？
