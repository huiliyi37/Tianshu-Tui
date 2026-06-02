# TUI 输入栏位置稳定性优化

> **⚠️ STATUS: Discussion Draft — 不应执行（2026-06-02）**
>
> 本计划的方向（约束动态区域 + 积极归档）合理，但**实现层有几处错位**，需要重新设计：
>
> 1. **`onToolResult` 不是正确的回调** — `liveTools` 在 `app.tsx:1037` 的 `onToolResult` 路径里被**移除**（filter by id），不是累积点。`liveTools` 增量的真正位置是 `app.tsx:978`（tool use 开始时 push "Running…"）。归档检查应该挂在 push 点。
> 2. **数据丢失风险** — `liveTools` 里的是**正在执行的工具**（"Running…"），不是已完成工具。盲目 flush 会把活的工具卡片归档，用户看不到运行状态。需要先判断 `toolCallTracker.current.get(id)?.done` 再 flush。
> 3. **`maxHeight` 是兜底，不是修复** — Yoga 的 `maxHeight` 默认会**裁剪**内容（不是 scroll），用户会看到内容消失。配合归档只是把"用户看不到"变成"用户能在 scrollback 里看到"，UX 没提升。需要：要么同时渲染一个 "... N more" 提示告诉用户有内容被归档了，要么根本不动 `maxHeight`，先根治归档策略。
> 4. **TDD 假象** — Task 2/6 的"测试"只测 `viewportLines(40, 1.0, 10) - 5 = 35` 这种算术题，无法捕获任何真实回归（InputBar 推出可视区是 Yoga 布局问题，不是算术问题）。需要至少一个集成测试：mock `liveTools` 推到 N 个后断言 dynamic area 高度 ≤ `termRows - 5`。
> 5. **Task 3.1 冗余** — `termRows` 已经在 `app.tsx:208` 通过 `useTerminalSize()` 取出，整个 Step 3.1 是 no-op。
> 6. **未做根因调查** — 计划假设"动态区域无约束 = 根因"，但未量化实际原因（5 个并发工具？单轮流式文本过长？tool 卡住未清理？）。建议先看 `.rivet/sensorium.jsonl` 找一次真实的 InputBar 推出场景再设计。
>
> **下一步**：等设计者提供根因数据 + 修复 "in-flight 工具不被误归档" 之后再讨论实现。

---

# TUI 输入栏位置稳定性优化

> **面向 AI 代理：** 使用 subagent-driven-development（推荐）或 executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 解决 InputBar 在对话过程中被推到屏幕外的问题，确保输入栏始终在可视区域内。

**架构：** 采用"动态区域限高 + 积极归档"策略：保留 `<Static>` 组件的 scrollback 能力（鼠标滚轮可用），对动态内容区域施加 `maxHeight` 约束，当实时内容（thinking + tools + stream）超过阈值时主动 flush 到 Static 历史。InputBar 固定在动态区域底部，永远不超出终端可视范围。

**技术栈：** Ink 6 (React TUI), TypeScript strict mode, node:test

---

## 1. Scope Check

本计划聚焦于 **TUI 布局稳定性**，涉及：
- `src/tui/app.tsx` 的 return 语句结构（动态区域高度约束）
- 实时内容 flush 策略（liveTools, streamingText）
- 终端尺寸感知（已有 `useTerminalSize` hook）

**不涉及：**
- Static 历史渲染逻辑（保持不变）
- Agent 核心循环（不涉及）
- 工具实现（不涉及）

**独立性：** 本计划是单一子系统（TUI 布局）的局部优化，无需拆分为多个计划。

---

## 2. File Structure

### 需要修改的文件

| 文件 | 职责 | 修改类型 |
|------|------|----------|
| `src/tui/app.tsx:1415-1568` | 主应用组件的 return 语句，定义布局结构 | 修改：添加动态区域高度约束 + flush 逻辑 |
| `src/tui/app.tsx:390-450` | `onToolResult` 回调，处理工具完成后的归档 | 修改：添加 liveTools 数量阈值检查 |
| `src/tui/app.tsx:450-520` | `onTextDelta` 回调，处理流式文本 | 修改：添加流式文本长度阈值检查 |
| `src/tui/__tests__/inputbar-position.test.tsx` | 新增：InputBar 位置稳定性测试 | 创建 |

### 不需要修改的文件

- `src/tui/viewport.ts` — 已有 `viewportLines()` 工具函数，可直接使用
- `src/tui/use-terminal-size.ts` — 已有终端尺寸 hook，可直接使用
- `src/tui/render-entry.tsx` — Static 渲染逻辑保持不变
- `src/tui/stream.tsx` — StreamOutput 组件保持不变

---

## 3. Research Endorsement

### 3.1 为什么可以安全地添加 `maxHeight` 约束？

**调研结果：**

1. **Ink 6 的 `maxHeight` 行为**：
   - 在 `src/tui/chronicle-view.tsx:22,59` 中有 `height={1}` 的使用先例
   - Ink 6 支持 `maxHeight` 属性，超出部分会被裁剪（overflow: hidden）
   - 动态区域使用 `flexDirection="column"`，`maxHeight` 会约束其总高度

2. **当前动态区域的内容组成**（`app.tsx:1415-1568`）：
   ```
   <Box flexDirection="column">
     {liveTools}              // 活跃工具卡片（0-N 个）
     <ThinkingCollapser />    // 思考过程（可折叠）
     <StreamOutput />         // 流式文本（已有滑动窗口）
     <GlanceBar />            // 状态栏（固定 1 行）
     {pendingApproval}        // 审批卡片（偶尔出现）
     <InputBar />             // 输入栏（固定 1-3 行）
   </Box>
   ```

3. **已有的限高机制**：
   - `LIVE_STREAM_MAX_CHARS = 50_000` — 流式文本滑动窗口（`app.tsx:71`）
   - `STATIC_THINKING_CAP = 10_000` — 思考归档上限（`app.tsx:72`）
   - `ASSISTANT_CHUNK_LINES = 200` — 分块归档阈值（`app.tsx:234`）

4. **风险点**：
   - `maxHeight` 会导致超出部分被裁剪，用户看不到被裁剪的内容
   - **解决方案**：在达到 `maxHeight` 之前主动 flush 到 Static，确保内容不丢失

**结论：** 可以安全地添加 `maxHeight`，但必须配合积极的 flush 策略。

### 3.2 为什么可以安全地修改 flush 逻辑？

**调研结果：**

1. **现有的 flush 机制**：
   - `flushStreamingState()`（`app.tsx:280-295`）：将流式文本和思考归档到 Static
   - `pushStatic()` / `pushStaticBatch()`（`app.tsx:200-230`）：将条目添加到历史缓冲区
   - Live tools 在 turn complete 时清空（`app.tsx:480`）

2. **调用者分析**：
   - `flushStreamingState()` 被以下位置调用：
     - `onTurnComplete`（`app.tsx:480`）
     - `onError`（`app.tsx:520`）
     - `onAbort`（`app.tsx:540`）
   - 这些都是"结束"场景，不会影响"进行中"的场景

3. **边case 风险**：
   - 如果在 streaming 过程中主动 flush，会导致 StreamOutput 组件重新挂载
   - **解决方案**：只在 liveTools 数量超过阈值时 flush 旧工具，不 flush 正在流式的文本

**结论：** 可以安全地添加 liveTools 数量阈值检查，但流式文本的 flush 需要谨慎处理。

### 3.3 为什么 InputBar 位置不稳定的根因是动态区域无约束？

**调研结果：**

1. **Static 组件的行为**：
   - `<Static>` 将条目写入终端 scrollback（`app.tsx:1420-1425`）
   - Static 条目一旦写入，就不再参与 React 渲染树
   - Static 条目会把后续的动态区域往下推

2. **动态区域的行为**：
   - 动态区域紧跟在 Static 之后（`app.tsx:1430`）
   - 动态区域的高度 = liveTools + thinking + stream + GlanceBar + InputBar
   - 当 liveTools 数量增加时，动态区域高度增加
   - 当动态区域底部超出终端可视范围时，InputBar 被推到屏幕外

3. **用户报告的现象**：
   - "第一条消息的输入框在屏幕的最顶端" — 初始状态，Static 为空，动态区域从第 1 行开始
   - "随着 agent 的对话一路跳到最底下的边界" — Static 条目增加，动态区域被推到下方
   - "太底部了" — 动态区域底部超出终端可视范围，InputBar 不可见

**结论：** 根因是动态区域无高度约束，导致 liveTools 累积时 InputBar 被推出可视范围。

---

## 4. Tasks

### Task 1: 定义常量与配置

**目标：** 定义动态区域高度约束的常量。

**文件：**
- 修改：`src/tui/app.tsx:70-75`

**步骤：**

- [ ] 1.1 在 `app.tsx` 顶部添加常量定义：

```typescript
// src/tui/app.tsx:70-75（在现有常量之后添加）

/**
 * 动态区域预留行数（GlanceBar + InputBar + 边距）
 * GlanceBar: 1 行
 * InputBar: 1-3 行（取决于是否多行输入）
 * 边距: 1 行
 */
const RESERVED_ROWS_FOR_INPUT = 5

/**
 * LiveTools 数量阈值：超过此值时主动 flush 旧工具到 Static
 * 保留最新的 3 个工具在动态区域，其余归档
 */
const LIVE_TOOLS_MAX_VISIBLE = 3
```

- [ ] 1.2 运行类型检查：

```bash
npx tsc --noEmit
```

**预期结果：** 无错误。

- [ ] 1.3 提交：

```bash
git add src/tui/app.tsx
git commit -m "feat(tui): define constants for dynamic area height constraint"
```

---

### Task 2: 编写 InputBar 位置稳定性测试

**目标：** 使用 TDD 方式验证 InputBar 在动态内容增加时仍然可见。

**文件：**
- 创建：`src/tui/__tests__/inputbar-position.test.tsx`

**步骤：**

- [ ] 2.1 创建测试文件，验证动态区域高度约束：

```typescript
// src/tui/__tests__/inputbar-position.test.tsx

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { viewportLines } from '../viewport.js'

describe('InputBar Position Stability', () => {
  it('should calculate available rows for dynamic content', () => {
    const terminalRows = 40
    const reservedRows = 5
    const availableRows = viewportLines(terminalRows, 1.0, 10) - reservedRows
    
    // 动态区域可用行数 = 终端行数 - 预留行数
    assert.equal(availableRows, 35)
  })

  it('should respect minimum rows constraint', () => {
    const terminalRows = 15
    const reservedRows = 5
    const availableRows = viewportLines(terminalRows, 1.0, 10) - reservedRows
    
    // 最小 10 行 - 5 行预留 = 5 行可用
    assert.equal(availableRows, 5)
  })

  it('should handle small terminals gracefully', () => {
    const terminalRows = 8
    const reservedRows = 5
    const availableRows = viewportLines(terminalRows, 1.0, 10) - reservedRows
    
    // 最小 10 行 - 5 行预留 = 5 行可用（即使终端只有 8 行）
    assert.equal(availableRows, 5)
  })
})
```

- [ ] 2.2 运行测试，确认通过：

```bash
npm test -- src/tui/__tests__/inputbar-position.test.tsx
```

**预期结果：** 3 个测试全部通过。

- [ ] 2.3 提交：

```bash
git add src/tui/__tests__/inputbar-position.test.tsx
git commit -m "test(tui): add InputBar position stability tests"
```

---

### Task 3: 实现动态区域高度约束

**目标：** 在 `app.tsx` 的 return 语句中为动态区域添加 `maxHeight` 约束。

**文件：**
- 修改：`src/tui/app.tsx:1415-1430`

**步骤：**

- [ ] 3.1 在 `App` 组件中获取终端行数：

```typescript
// src/tui/app.tsx:100（在现有 hook 调用附近添加）

const { rows: terminalRows } = useTerminalSize()
```

- [ ] 3.2 计算动态区域的最大高度：

```typescript
// src/tui/app.tsx:1410（在 return 语句之前添加）

const dynamicAreaMaxHeight = Math.max(10, terminalRows - RESERVED_ROWS_FOR_INPUT)
```

- [ ] 3.3 修改 return 语句中的动态区域 Box：

```typescript
// src/tui/app.tsx:1430（修改动态区域的 Box）

return (
  <>
    {/* ... existing Static and other elements ... */}
    <Box 
      flexDirection="column" 
      maxHeight={dynamicAreaMaxHeight}
    >
      {/* ... existing dynamic content ... */}
    </Box>
  </>
)
```

- [ ] 3.4 运行类型检查：

```bash
npx tsc --noEmit
```

**预期结果：** 无错误。

- [ ] 3.5 运行测试：

```bash
npm test -- src/tui/__tests__/inputbar-position.test.tsx
```

**预期结果：** 3 个测试全部通过。

- [ ] 3.6 提交：

```bash
git add src/tui/app.tsx
git commit -m "feat(tui): add maxHeight constraint to dynamic area"
```

---

### Task 4: 实现 LiveTools 积极归档策略

**目标：** 当 liveTools 数量超过阈值时，主动将旧工具 flush 到 Static。

**文件：**
- 修改：`src/tui/app.tsx:390-450`（`onToolResult` 回调）

**步骤：**

- [ ] 4.1 在 `onToolResult` 回调中添加 liveTools 数量检查：

```typescript
// src/tui/app.tsx:420（在 onToolResult 回调中，现有逻辑之后添加）

// 积极归档：当 liveTools 数量超过阈值时，将旧工具 flush 到 Static
if (liveToolsRef.current.length > LIVE_TOOLS_MAX_VISIBLE) {
  const toolsToFlush = liveToolsRef.current.slice(0, -LIVE_TOOLS_MAX_VISIBLE)
  for (const tool of toolsToFlush) {
    pushStatic({
      id: tool.id,
      type: 'tool',
      name: tool.name,
      content: tool.output ?? '',
      timestamp: Date.now(),
    })
  }
  // 更新 liveToolsRef，只保留最新的 N 个
  liveToolsRef.current = liveToolsRef.current.slice(-LIVE_TOOLS_MAX_VISIBLE)
  setLiveTools(liveToolsRef.current)
}
```

- [ ] 4.2 运行类型检查：

```bash
npx tsc --noEmit
```

**预期结果：** 无错误。

- [ ] 4.3 运行所有 TUI 测试：

```bash
npm test -- src/tui/__tests__/
```

**预期结果：** 所有测试通过。

- [ ] 4.4 提交：

```bash
git add src/tui/app.tsx
git commit -m "feat(tui): implement aggressive flush strategy for liveTools"
```

---

### Task 5: 手动验证与调优

**目标：** 在实际终端中验证 InputBar 位置稳定性，并根据反馈调优常量值。

**文件：**
- 可能修改：`src/tui/app.tsx:70-75`（常量值调优）

**步骤：**

- [ ] 5.1 构建并启动应用：

```bash
npm run build
node dist/main.js
```

- [ ] 5.2 手动测试场景：

**场景 A：长对话**
- 发送 10+ 条消息，观察 InputBar 是否始终可见
- **预期结果：** InputBar 始终在屏幕底部，不会被推到屏幕外

**场景 B：多工具调用**
- 触发 5+ 个工具调用（如 `read` + `grep` + `edit` + `bash` + `test`）
- 观察 liveTools 是否被积极归档
- **预期结果：** 动态区域最多显示 3 个工具，旧工具被归档到 Static

**场景 C：长流式文本**
- 请求生成长文本（如"写一篇 1000 字的文章"）
- 观察流式文本是否被裁剪
- **预期结果：** 流式文本正常显示，不会被 `maxHeight` 裁剪（因为有滑动窗口）

**场景 D：小终端**
- 调整终端窗口为 20 行高度
- 观察 InputBar 是否仍然可见
- **预期结果：** InputBar 始终可见，动态区域自适应高度

- [ ] 5.3 根据手动测试结果调优常量：

如果发现 `RESERVED_ROWS_FOR_INPUT = 5` 不够，可以调整为 6 或 7。
如果发现 `LIVE_TOOLS_MAX_VISIBLE = 3` 太少，可以调整为 4 或 5。

```typescript
// src/tui/app.tsx:70-75（根据测试结果调整）
const RESERVED_ROWS_FOR_INPUT = 6  // 或 7
const LIVE_TOOLS_MAX_VISIBLE = 4    // 或 5
```

- [ ] 5.4 提交最终调优结果：

```bash
git add src/tui/app.tsx
git commit -m "chore(tui): tune constants for dynamic area height constraint"
```

---

### Task 6: 编写集成测试（可选）

**目标：** 添加集成测试，验证动态区域高度约束在各种终端尺寸下的行为。

**文件：**
- 创建：`src/tui/__tests__/dynamic-area-height.test.tsx`

**步骤：**

- [ ] 6.1 创建集成测试文件：

```typescript
// src/tui/__tests__/dynamic-area-height.test.tsx

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { viewportLines } from '../viewport.js'

describe('Dynamic Area Height Constraint', () => {
  const RESERVED_ROWS_FOR_INPUT = 5
  const LIVE_TOOLS_MAX_VISIBLE = 3

  it('should calculate dynamic area height for various terminal sizes', () => {
    const testCases = [
      { terminalRows: 40, expected: 35 },
      { terminalRows: 30, expected: 25 },
      { terminalRows: 20, expected: 15 },
      { terminalRows: 15, expected: 10 }, // 最小值
      { terminalRows: 8, expected: 5 },   // 最小值
    ]

    for (const { terminalRows, expected } of testCases) {
      const availableRows = viewportLines(terminalRows, 1.0, 10) - RESERVED_ROWS_FOR_INPUT
      assert.equal(availableRows, expected, `terminalRows=${terminalRows}`)
    }
  })

  it('should ensure LIVE_TOOLS_MAX_VISIBLE is reasonable', () => {
    // 确保阈值在合理范围内（2-5）
    assert.ok(LIVE_TOOLS_MAX_VISIBLE >= 2, 'LIVE_TOOLS_MAX_VISIBLE should be at least 2')
    assert.ok(LIVE_TOOLS_MAX_VISIBLE <= 5, 'LIVE_TOOLS_MAX_VISIBLE should be at most 5')
  })

  it('should ensure RESERVED_ROWS_FOR_INPUT is reasonable', () => {
    // 确保预留行数在合理范围内（4-7）
    assert.ok(RESERVED_ROWS_FOR_INPUT >= 4, 'RESERVED_ROWS_FOR_INPUT should be at least 4')
    assert.ok(RESERVED_ROWS_FOR_INPUT <= 7, 'RESERVED_ROWS_FOR_INPUT should be at most 7')
  })
})
```

- [ ] 6.2 运行测试：

```bash
npm test -- src/tui/__tests__/dynamic-area-height.test.tsx
```

**预期结果：** 3 个测试全部通过。

- [ ] 6.3 提交：

```bash
git add src/tui/__tests__/dynamic-area-height.test.tsx
git commit -m "test(tui): add integration tests for dynamic area height constraint"
```

---

## 5. Verification

### 类型检查

```bash
npx tsc --noEmit
```

**预期结果：** 无错误。

### 单元测试

```bash
npm test -- src/tui/__tests__/inputbar-position.test.tsx
npm test -- src/tui/__tests__/dynamic-area-height.test.tsx
```

**预期结果：** 所有测试通过。

### 全量测试

```bash
npm test
```

**预期结果：** 所有测试通过，无回归。

### 手动验证

```bash
npm run build
node dist/main.js
```

**预期结果：**
- InputBar 始终在屏幕底部可见
- 长对话不会把 InputBar 推到屏幕外
- 多工具调用时，旧工具被积极归档到 Static
- 流式文本正常显示，不会被裁剪

---

## 6. Self-Check

### 6.1 Spec Coverage

| 需求 | 对应任务 | 状态 |
|------|----------|------|
| InputBar 始终可见 | Task 3（动态区域高度约束） | ✅ |
| 长对话不推 InputBar 到屏幕外 | Task 3 + Task 4（高度约束 + 积极归档） | ✅ |
| 多工具调用时不溢出 | Task 4（liveTools 积极归档） | ✅ |
| 流式文本不被裁剪 | Task 5（手动验证） | ✅ |
| 小终端自适应 | Task 3（`viewportLines` 最小值约束） | ✅ |

**遗漏检查：** 无遗漏。

### 6.2 Placeholder Scan

- [x] 无 `TODO` / `TBD` / `待定` / `后续实现` / `补充细节`
- [x] 无 "添加适当的错误处理" 类型的模糊描述
- [x] 无 "为上述代码编写测试" 类型的模糊描述
- [x] 无 "类似任务 N" 类型的引用

### 6.3 Type Consistency

- [x] `RESERVED_ROWS_FOR_INPUT` 在 Task 1 定义，在 Task 3 使用
- [x] `LIVE_TOOLS_MAX_VISIBLE` 在 Task 1 定义，在 Task 4 使用
- [x] `dynamicAreaMaxHeight` 在 Task 3 计算，在 Task 3 使用
- [x] `terminalRows` 来自 `useTerminalSize()` hook，已在 `app.tsx` 中存在
- [x] `viewportLines` 来自 `viewport.ts`，已在 `app.tsx` 中导入

**一致性检查：** 所有类型、函数、路径一致。

---

## 7. Execution Handoff

计划已完成并保存到 `docs/superpowers/plans/2026-06-02-tui-inputbar-position-stability.md`。

两种执行方式：

1. **子代理驱动（推荐）** — 每个任务调度一个新的子代理，任务间进行审查，快速迭代。
2. **内联执行** — 在当前会话中使用 executing-plans 执行任务，批量执行并设有检查点。

选哪种方式？
