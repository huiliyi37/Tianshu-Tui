# 流畅度优化 · 静默窗口（S1-S4）实现计划（优化版）

> **状态：✅ 已全部实施** — Fluency silence 优化 (fluency-policy.ts)

**目标：** 消除"UI 在工作但看起来像卡死"的静默窗口——让"即将调工具 / 正在等首字节 / 正在准备下一轮 / 工具执行中"随时可见。

**架构：** 复用已有的 `onPhaseChange` 通道（loop.ts:180 签名 → app.tsx:1035 渲染），不新增 UI 组件。在 `TurnStreamCallbacks` 增加两个可选回调（`onToolHint`、`onStreamStart`），loop.ts 在适当时机 emit phase 并携带 `detail.reason`，利用现有 handler 的 `detail?.reason ?? 'still working'` 机制直接显示（S1/S2 不碰 app.tsx）。S3 抽出纯函数 `phaseStatusLabel` 集中所有 phase 文案并升级 app.tsx handler（吸收 heartbeat/intent-veto 等已有 phase），同时 S1/S2 的 loop.ts 排放可去掉临时 reason（由纯函数生成）。S4 独立，给 ToolCard 加实时 elapsed 显示。

**技术栈：** TypeScript strict、Ink 6、node:test + node:assert/strict、tsx 运行器。

**顺序依赖：** S1→S2→S3 有依赖（S1/S2 累加 `TurnStreamCallbacks` 接口；S3 重构 app.tsx handler 并清理 S1/S2 的临时 reason）。S4 完全独立，可与 S1-S3 并行。

---

## Scope Check

本计划覆盖 4 个独立信号 gap，不跨子系统边界：
- S1（API→stream 层）：`onToolCallHint` 已有信号，只需转发到 callbacks
- S2（stream 层）：请求发出前无信号
- S3（loop 层 + UI 层）：perceive/intent 阻塞期无信号 + 文案散落
- S4（UI 层）：工具执行期无进度

不涉及：心跳阈值调整、thinking 状态机、工具输入 schema 变更。

---

## File Structure

| 文件 | 操作 | 职责 |
|------|------|------|
| `src/agent/turn-stream.ts` | 修改 | `TurnStreamCallbacks` 加 `onToolHint?` + `onStreamStart?`；`streamTurn` 转发/调用 |
| `src/agent/loop.ts` | 修改 | streamTurn callbacks 加 `onToolHint`/`onStreamStart` 接线；perceive 前 emit `preparing` |
| `src/agent/__tests__/turn-stream.test.ts` | 修改 | 追加 S1 + S2 测试用例（复用 `makeController`） |
| `src/tui/phase-status.ts` | 创建 | 纯函数 `phaseStatusLabel(phase, detail)` 集中所有 phase→文案映射 |
| `src/tui/__tests__/phase-status.test.ts` | 创建 | `phaseStatusLabel` 的全覆盖测试 |
| `src/tui/app.tsx` | 修改 | S3 替换 `onPhaseChange` handler 用 `phaseStatusLabel`；S4 加 `toolStartMap` + 传 `elapsedMs` |
| `src/tui/tool-elapsed.ts` | 创建 | 纯函数 `formatToolElapsed(ms)` |
| `src/tui/__tests__/tool-elapsed.test.ts` | 创建 | `formatToolElapsed` 测试 |
| `src/tui/tool-card.tsx` | 修改 | props 加 `elapsedMs?`，streaming 时显示 elapsed |

---

## Research Endorsement（调研背书）

### `TurnStreamCallbacks`（turn-stream.ts:7-12）— 加可选字段

**存在原因：** 定义 `streamTurn` 的回调协议。4 个必选 + 0 个可选。
**调用方：** `loop.ts:1418` 的 streamTurn callbacks 对象。
**边界风险：** 新增可选字段（`onToolHint?`、`onStreamStart?`）不破坏现有调用方（TypeScript excess property check 仅对字面量类型报错，已有调用方不含这些字段）。已验证 `makeController` 测试中所有 callback 对象都不含新字段。

### `onToolCallHint` handler（turn-stream.ts:111-115）— 修改行为

**存在原因：** API 层在 `finish_reason` 到达前发出工具名称+部分参数 hint，用于 `read_file` 文件预热。
**当前行为：** 仅调用 `this.deps.prewarmFile?.(filePath)`。
**修改：** 在 prewarm 之前新增 `input.callbacks.onToolHint?.(toolName)` 转发。
**边界风险：** `onToolHint` 为可选，未提供时跳过；不影响 prewarm 逻辑。

### `onPhaseChange` handler（app.tsx:1035）— 修改行为

**存在原因：** 接收 loop 层的 phase 信号，目前仅设置 `heartbeatStatus = detail?.reason ?? 'still working'`。
**调用方（emit 侧）：**
- `loop.ts:989` — heartbeat: `{ reason: 'still working — last activity: ...' }`
- `loop.ts:1290` — intent-veto: `{ reason: 'user vetoed intent', suggestion: '...' }`
- `loop.ts:1241` — perception emitPhaseChange: 透传给 perception 系统
**修改：** S3 用 `phaseStatusLabel` 替换内联逻辑，需覆盖上述所有已有 phase。
**边界风险：** `phaseStatusLabel` 必须处理 `heartbeat` 和 `intent-veto`，否则这些信号被吞。

### `onAbort` handler（app.tsx:1129）— 需同步清理

**存在原因：** 用户中断时清理所有运行时状态。
**当前清理：** `toolTargetMap.current.clear()`、`toolNames.current.clear()` 等。
**需新增：** S4 的 `toolStartMap.current.clear()`（否则下次会话泄漏 ID→timestamp 映射）。

### `ToolCard`（tool-card.tsx）— 加可选 prop

**存在原因：** 渲染单个工具调用卡片。当前 props：`name, result, isError?, isStreaming?, verbose?, rawPath?, focused?`。
**调用方：** app.tsx:1224 `liveTools.map` 渲染。
**边界风险：** 新增 `elapsedMs?` 可选，不影响现有渲染。

### `liveTools.map` 渲染（app.tsx:1224）— 需传新 prop

**当前代码：**
```tsx
<ToolCard key={log.id} name={log.toolName ?? ''} result={log.content} isStreaming verbose={verbose} />
```
**需改为：** 传入 `elapsedMs`。此处在 `liveTools.map` 回调内，每次渲染重新计算 `Date.now() - toolStartMap.current.get(log.id)`。1s tick（app.tsx:396 的 `activityIntervalRef`）触发 `setSummaryState` 重渲染，保证 elapsed 每秒更新。

---

## 任务 S1：工具指示器在 finish_reason 之前显示

**原理：** API 层的 `onToolCallHint`（stream-client.ts:15）在 `finish_reason` 之前发出工具名+部分参数。当前仅用于 `prewarmFile`（turn-stream.ts:111-115）。S1 将已有 hint 信号转发到 `TurnStreamCallbacks.onToolHint`，loop.ts 接收后 emit `onPhaseChange('tool-hint', { tool: name, reason: 'preparing ${name}…' })`，利用现有 app.tsx handler 的 `detail?.reason` 机制直接显示——不碰 app.tsx。

**文件：**
- 修改：`src/agent/turn-stream.ts`（接口 7-12，handler 111-115）
- 修改：`src/agent/loop.ts`（streamTurn callbacks，约 1430 行 `onError` 之后）
- 修改：`src/agent/__tests__/turn-stream.test.ts`（追加用例）

- [ ] **步骤 1：写失败测试**

追加到 `src/agent/__tests__/turn-stream.test.ts`（复用文件内已有的 `makeController` + `request`）：

```ts
  it('S1: forwards tool hint via onToolHint before onToolUse', async () => {
    const client: StreamClient = {
      stream: mock.fn(async (_request: OaiChatRequest, cb: StreamCallbacks) => {
        cb.onToolCallHint?.('read_file', { file_path: '/tmp/x.ts' })
        cb.onContentBlock({ type: 'tool_use', id: 'tu_1', name: 'read_file', input: { file_path: '/tmp/x.ts' } })
        cb.onStopReason('tool_use', {})
      }),
    }
    const { controller } = makeController(client)
    const events: string[] = []
    await controller.streamTurn({
      request, turn: 1, lastTurnTextFingerprint: '',
      callbacks: {
        onTextDelta: () => {},
        onThinkingDelta: () => {},
        onToolUse: () => { events.push('tool_use') },
        onToolHint: (name) => { events.push(`hint:${name}`) },
        onError: () => {},
      },
    })
    assert.deepEqual(events, ['hint:read_file', 'tool_use'])
  })
```

- [ ] **步骤 2：运行测试验证失败**

```bash
npx tsx --test src/agent/__tests__/turn-stream.test.ts
```

预期：FAIL。`TurnStreamCallbacks` 无 `onToolHint` 字段，TypeScript 报 `Object literal may only specify known properties`；运行时 `events` 为 `['tool_use']`，断言 `AssertionError`。

- [ ] **步骤 3：写最小实现**

`src/agent/turn-stream.ts` — 接口 `TurnStreamCallbacks` 加可选字段（在 `onToolUse` 之后、`onError` 之前）：

```ts
export interface TurnStreamCallbacks {
  onTextDelta: (text: string) => void
  onThinkingDelta: (thinking: string) => void
  onToolUse: (id: string, name: string, input: Record<string, unknown>) => void
  onToolHint?: (name: string) => void
  onError: (error: Error) => void
}
```

`src/agent/turn-stream.ts` — `onToolCallHint` handler（111-115 行）改为先转发再 prewarm：

```ts
      onToolCallHint: (toolName, partialArgs) => {
        input.callbacks.onToolHint?.(toolName)
        if (toolName === 'read_file' && typeof partialArgs.file_path === 'string') {
          this.deps.prewarmFile?.(partialArgs.file_path)
        }
      },
```

`src/agent/loop.ts` — streamTurn callbacks 对象（约 1430 行 `onError` 之后）加：

```ts
            onToolHint: (name) => {
              callbacks.onPhaseChange?.('tool-hint', { tool: name, reason: `preparing ${name}…` })
            },
```

> 注：此处用 `reason` 字段是为了让现有 app.tsx handler（`setHeartbeatStatus(detail?.reason ?? 'still working')`）直接显示。S3 实现后此 reason 将被移除，由 `phaseStatusLabel` 统一生成。

- [ ] **步骤 4：运行测试验证通过**

```bash
npx tsx --test src/agent/__tests__/turn-stream.test.ts && npx tsc --noEmit
```

预期：全部 PASS，无类型错误。

- [ ] **步骤 5：Commit**

```bash
git add src/agent/turn-stream.ts src/agent/loop.ts src/agent/__tests__/turn-stream.test.ts
git commit -m "feat(stream): forward tool hint to onToolHint callback before finish_reason (S1)"
```

---

## 任务 S2：首字节前立即显示 working 指示

**原理：** loop.ts:986 heartbeat 的 `silentMs: 20_000`，首次 "still working" 要 20 秒后才出。app.tsx:738 仅首个 `onThinkingDelta` 才 `setIsThinkingActive(true)`。修法：给 `TurnStreamCallbacks` 加 `onStreamStart?()`，在 `streamTurn` 调 `client.stream` **之前**同步调用；loop 把它接到 `onPhaseChange('working', { reason: 'waiting for first token' })`。利用现有 app.tsx handler 显示。

**文件：**
- 修改：`src/agent/turn-stream.ts`（接口加 `onStreamStart`；`streamTurn` 方法 `await client.stream` 前一行）
- 修改：`src/agent/loop.ts`（streamTurn callbacks 加 `onStreamStart`）
- 修改：`src/agent/__tests__/turn-stream.test.ts`（追加用例）

- [ ] **步骤 1：写失败测试**

追加到 `src/agent/__tests__/turn-stream.test.ts`（复用 `makeController` + `request`）：

```ts
  it('S2: calls onStreamStart before any text/thinking delta', async () => {
    const order: string[] = []
    const client: StreamClient = {
      stream: mock.fn(async (_request: OaiChatRequest, cb: StreamCallbacks) => {
        order.push('stream-called')
        cb.onThinkingDelta('t')
        cb.onTextDelta('hi')
        cb.onStopReason('end_turn', {})
      }),
    }
    const { controller } = makeController(client)
    await controller.streamTurn({
      request, turn: 0, lastTurnTextFingerprint: '',
      callbacks: {
        onTextDelta: () => { order.push('text') },
        onThinkingDelta: () => { order.push('thinking') },
        onToolUse: () => {},
        onStreamStart: () => { order.push('stream-start') },
        onError: () => {},
      },
    })
    assert.equal(order[0], 'stream-start', `stream-start must be first, got: ${order.join(',')}`)
    assert.ok(order.indexOf('stream-start') < order.indexOf('thinking'), 'stream-start before thinking')
    assert.ok(order.indexOf('stream-start') < order.indexOf('text'), 'stream-start before text')
  })
```

- [ ] **步骤 2：运行测试验证失败**

```bash
npx tsx --test src/agent/__tests__/turn-stream.test.ts
```

预期：FAIL。`TurnStreamCallbacks` 无 `onStreamStart`（TS `known properties`）；运行时 `order.indexOf('stream-start')` 为 `-1`。

- [ ] **步骤 3：写最小实现**

`src/agent/turn-stream.ts` — 接口加可选字段（在 `onToolHint` 之后、`onError` 之前）：

```ts
  onStreamStart?: () => void
```

`src/agent/turn-stream.ts` — `streamTurn` 方法中，在 `await this.deps.client.stream(...)` 调用之前加一行（当前该行在 try 块内首行，约 127 行）：

```ts
    let streamError: Error | null = null
    try {
      input.callbacks.onStreamStart?.()
      await this.deps.client.stream(input.request, streamCallbacks, this.deps.abortSignal)
```

`src/agent/loop.ts` — streamTurn callbacks 对象（`onToolHint` 之后）加：

```ts
            onStreamStart: () => {
              callbacks.onPhaseChange?.('working', { reason: 'waiting for first token' })
            },
```

- [ ] **步骤 4：运行测试验证通过**

```bash
npx tsx --test src/agent/__tests__/turn-stream.test.ts && npx tsc --noEmit
```

预期：全部 PASS，无类型错误。

- [ ] **步骤 5：Commit**

```bash
git add src/agent/turn-stream.ts src/agent/loop.ts src/agent/__tests__/turn-stream.test.ts
git commit -m "feat(stream): emit working phase at stream start before first token (S2)"
```

---

## 任务 S3：前置链阻塞期显示"准备中" + 集中 phase 文案

**原理：** loop.ts `perception.perceive()`（约 1241 行）与 `intent.evaluate()`（约 1283 行）是串行 `await`，执行于 tool 结果之后、`streamTurn` 之前，期间无 UI 信号。修法：
1. 创建纯函数 `phaseStatusLabel` 集中所有 phase→文案映射（含已有的 `heartbeat`、`intent-veto`，以及新增的 `preparing`、`working`、`tool-hint`）。
2. app.tsx 的 `onPhaseChange` handler 替换为调用此纯函数。
3. loop.ts 在 perceive 前 emit `preparing` phase。
4. 清理 S1/S2 loop.ts 排放中的临时 `reason` 字段（由 `phaseStatusLabel` 统一生成）。

**关键设计决策：** `phaseStatusLabel` 必须覆盖 `heartbeat`（loop.ts:989）和 `intent-veto`（loop.ts:1290），否则 S3 实现后这些信号被吞。

**文件：**
- 创建：`src/tui/phase-status.ts`
- 创建：`src/tui/__tests__/phase-status.test.ts`
- 修改：`src/agent/loop.ts`（perceive 前 emit；S1/S2 reason 清理）
- 修改：`src/tui/app.tsx`（`onPhaseChange` handler 替换 + import）

- [ ] **步骤 1：写失败测试**

新建 `src/tui/__tests__/phase-status.test.ts`：

```ts
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { phaseStatusLabel } from '../phase-status.js'

describe('S3: phaseStatusLabel', () => {
  // --- 已有 phase（必须覆盖，否则被吞）---
  it('maps heartbeat with reason', () => {
    assert.equal(phaseStatusLabel('heartbeat', { reason: 'still working — last activity: read_file (20s ago)' }),
      'still working — last activity: read_file (20s ago)')
  })
  it('maps heartbeat without reason', () => {
    assert.equal(phaseStatusLabel('heartbeat'), 'still working')
  })
  it('maps intent-veto with reason', () => {
    assert.equal(phaseStatusLabel('intent-veto', { reason: 'user vetoed intent' }), 'user vetoed intent')
  })
  it('maps intent-veto without reason', () => {
    assert.equal(phaseStatusLabel('intent-veto'), 'intent vetoed')
  })

  // --- 新增 phase ---
  it('maps preparing', () => {
    assert.equal(phaseStatusLabel('preparing'), 'preparing…')
  })
  it('maps working with reason', () => {
    assert.equal(phaseStatusLabel('working', { reason: 'waiting for first token' }), 'waiting for first token')
  })
  it('maps working without reason', () => {
    assert.equal(phaseStatusLabel('working'), 'working…')
  })
  it('maps tool-hint with tool name', () => {
    assert.equal(phaseStatusLabel('tool-hint', { tool: 'read_file' }), 'preparing read_file…')
  })
  it('maps tool-hint without tool name', () => {
    assert.equal(phaseStatusLabel('tool-hint'), 'preparing…')
  })

  // --- 未知 phase → null（不覆盖 heartbeatStatus）---
  it('returns null for unmapped phases', () => {
    assert.equal(phaseStatusLabel('tianshu-planning'), null)
    assert.equal(phaseStatusLabel('random'), null)
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

```bash
npx tsx --test src/tui/__tests__/phase-status.test.ts
```

预期：FAIL。`Cannot find module '../phase-status.js'`，`ERR_MODULE_NOT_FOUND`。

- [ ] **步骤 3：写最小实现**

新建 `src/tui/phase-status.ts`：

```ts
/**
 * Map an agent phase to a human-readable status label for the heartbeat line.
 * Returns null for phases that should not override the current status.
 *
 * IMPORTANT: every phase emitted by loop.ts via onPhaseChange must be handled
 * here or explicitly documented as intentionally ignored. Currently handled:
 * - heartbeat (loop.ts heartbeat timer)
 * - intent-veto (loop.ts intent evaluation)
 * - preparing (loop.ts pre-stream chain)
 * - working (loop.ts stream start)
 * - tool-hint (loop.ts tool call hint)
 */
export function phaseStatusLabel(
  phase: string,
  detail?: { tool?: string; reason?: string; suggestion?: string },
): string | null {
  switch (phase) {
    case 'heartbeat': return detail?.reason ?? 'still working'
    case 'intent-veto': return detail?.reason ?? 'intent vetoed'
    case 'preparing': return 'preparing…'
    case 'working': return detail?.reason ?? 'working…'
    case 'tool-hint': return detail?.tool ? `preparing ${detail.tool}…` : 'preparing…'
    default: return null
  }
}
```

- [ ] **步骤 4：运行测试验证通过**

```bash
npx tsx --test src/tui/__tests__/phase-status.test.ts
```

预期：PASS。

- [ ] **步骤 5：替换 app.tsx `onPhaseChange` handler**

`src/tui/app.tsx` — 顶部 import 区域（约 34 行附近）加：

```ts
import { phaseStatusLabel } from './phase-status.js'
```

`src/tui/app.tsx` — 替换 `onPhaseChange` handler（约 1035 行）。将：

```ts
      onPhaseChange: (phase, detail) => {
        setHeartbeatStatus(detail?.reason ?? 'still working')
      },
```

改为：

```ts
      onPhaseChange: (phase, detail) => {
        const label = phaseStatusLabel(phase, detail)
        if (label !== null) {
          setHeartbeatStatus(label)
        }
      },
```

> 这同时处理了已有的 `heartbeat`（原行为不变）、`intent-veto`（新增显示）以及 S1/S2 的 `tool-hint`/`working`。

- [ ] **步骤 6：loop.ts 加 preparing phase + 清理 S1/S2 临时 reason**

`src/agent/loop.ts` — 在 `perception.perceive(...)` 调用之前（约 1241 行之前）加一行：

```ts
        callbacks.onPhaseChange?.('preparing', { reason: 'preparing next turn' })
```

`src/agent/loop.ts` — 清理 S1 的 onToolHint 排放（去掉 reason，由 `phaseStatusLabel` 生成）：

```ts
            onToolHint: (name) => {
              callbacks.onPhaseChange?.('tool-hint', { tool: name })
            },
```

`src/agent/loop.ts` — 清理 S2 的 onStreamStart 排放（去掉 reason）：

```ts
            onStreamStart: () => {
              callbacks.onPhaseChange?.('working', {})
            },
```

> `phaseStatusLabel('tool-hint', { tool: name })` → `preparing ${name}…`
> `phaseStatusLabel('working', {})` → `working…`

- [ ] **步骤 7：运行 typecheck + 全部测试**

```bash
npx tsc --noEmit && npx tsx --test src/tui/__tests__/phase-status.test.ts && npx tsx --test src/agent/__tests__/turn-stream.test.ts
```

预期：全部 PASS。

- [ ] **步骤 8：Commit**

```bash
git add src/tui/phase-status.ts src/tui/__tests__/phase-status.test.ts src/tui/app.tsx src/agent/loop.ts
git commit -m "feat(ui): centralize phase labels, emit preparing phase before perceive (S3)"
```

---

## 任务 S4：非流式工具执行期显示 elapsed 进度

**原理：** `tool-pipeline.ts` 的 `onOutput` 仅被 `bash`/`run_tests` 调用，其余工具执行期零信号。`ToolCard` streaming 时只显示静态 `verb …`。修法：纯函数 `formatToolElapsed(ms)` 抽离格式化逻辑，`ToolCard` 加 `elapsedMs?` prop 显示；app.tsx 用 `toolStartMap` ref 记录每个工具开始时间，在 liveTools 渲染时传入 `elapsedMs`。1s tick（app.tsx:396 的 `activityIntervalRef`）触发 `setSummaryState` 重渲染，保证 elapsed 每秒更新。

**文件：**
- 创建：`src/tui/tool-elapsed.ts`
- 创建：`src/tui/__tests__/tool-elapsed.test.ts`
- 修改：`src/tui/tool-card.tsx`（props + 渲染）
- 修改：`src/tui/app.tsx`（`toolStartMap` ref + `onToolUse` 记录 + `liveTools.map` 传入 + `onAbort` 清理）

- [ ] **步骤 1：写失败测试**

新建 `src/tui/__tests__/tool-elapsed.test.ts`：

```ts
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { formatToolElapsed } from '../tool-elapsed.js'

describe('S4: formatToolElapsed', () => {
  it('returns empty for under 1 second (no noise on fast tools)', () => {
    assert.equal(formatToolElapsed(0), '')
    assert.equal(formatToolElapsed(500), '')
    assert.equal(formatToolElapsed(999), '')
  })
  it('shows whole seconds from 1s', () => {
    assert.equal(formatToolElapsed(1000), '1s')
    assert.equal(formatToolElapsed(1500), '1s')
    assert.equal(formatToolElapsed(4200), '4s')
  })
  it('shows m:ss past a minute', () => {
    assert.equal(formatToolElapsed(60_000), '1m00s')
    assert.equal(formatToolElapsed(65_000), '1m05s')
    assert.equal(formatToolElapsed(125_000), '2m05s')
  })
  it('handles negative input gracefully', () => {
    assert.equal(formatToolElapsed(-100), '')
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

```bash
npx tsx --test src/tui/__tests__/tool-elapsed.test.ts
```

预期：FAIL。`Cannot find module '../tool-elapsed.js'`，`ERR_MODULE_NOT_FOUND`。

- [ ] **步骤 3：写最小实现**

新建 `src/tui/tool-elapsed.ts`：

```ts
/**
 * Format tool runtime for the streaming tool card.
 * Returns empty string under 1 second to avoid noise on fast tools.
 */
export function formatToolElapsed(ms: number): string {
  if (ms < 1000) return ''
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`
}
```

- [ ] **步骤 4：运行测试验证通过**

```bash
npx tsx --test src/tui/__tests__/tool-elapsed.test.ts
```

预期：PASS。

- [ ] **步骤 5：Commit（纯函数独立可交付）**

```bash
git add src/tui/tool-elapsed.ts src/tui/__tests__/tool-elapsed.test.ts
git commit -m "feat(ui): add formatToolElapsed pure function (S4 step 1)"
```

- [ ] **步骤 6：ToolCard 加 `elapsedMs` prop + 渲染**

`src/tui/tool-card.tsx` — 顶部 import：

```ts
import { formatToolElapsed } from './tool-elapsed.js'
```

`src/tui/tool-card.tsx` — `ToolCardProps` 接口加 `elapsedMs?`：

```ts
interface ToolCardProps {
  name: string
  result: string
  isError?: boolean
  isStreaming?: boolean
  verbose?: boolean
  rawPath?: string
  focused?: boolean
  elapsedMs?: number
}
```

`src/tui/tool-card.tsx` — 组件函数签名解构加 `elapsedMs`：

```ts
export const ToolCard = memo(function ToolCard({ name, result, isError, isStreaming, verbose, rawPath, focused, elapsedMs }: ToolCardProps) {
```

`src/tui/tool-card.tsx` — 标题行（约 55 行 `family.verb{isStreaming ? ' …' : ''}` 之后）追加 elapsed 显示：

```tsx
      <Text bold color={borderColor}>
        {family.glyph} {family.verb}{isStreaming ? ' …' : ''}
        {isStreaming && formatToolElapsed(elapsedMs ?? 0) && (
          <Text color={theme.muted}> {formatToolElapsed(elapsedMs ?? 0)}</Text>
        )}
        {totalLines > MAX_COLLAPSED_LINES && !expanded && <Text color={theme.muted}> {totalLines} lines</Text>}
```

- [ ] **步骤 7：app.tsx 加 `toolStartMap` + 接线**

`src/tui/app.tsx` — 在 `toolTargetMap` 声明（约 306 行）附近加：

```ts
  const toolStartMap = useRef<Map<string, number>>(new Map())
```

`src/tui/app.tsx` — `onToolUse` handler（约 759 行）内，在 `toolNames.current.set(id, name)` 之后加：

```ts
        toolStartMap.current.set(id, Date.now())
```

`src/tui/app.tsx` — `onToolResult` handler（约 805 行）内，在清理 `toolNames` 的地方加：

```ts
        toolStartMap.current.delete(id)
```

`src/tui/app.tsx` — `onAbort` handler（约 1129 行）内，在 `toolTargetMap.current.clear()` 附近加：

```ts
        toolStartMap.current.clear()
```

`src/tui/app.tsx` — `liveTools.map` 渲染（约 1224 行）给 ToolCard 传 `elapsedMs`。将：

```tsx
            : <ToolCard key={log.id} name={log.toolName ?? ''} result={log.content} isStreaming verbose={verbose} />
```

改为：

```tsx
            : <ToolCard key={log.id} name={log.toolName ?? ''} result={log.content} isStreaming verbose={verbose} elapsedMs={Date.now() - (toolStartMap.current.get(log.id) ?? Date.now())} />
```

- [ ] **步骤 8：运行 typecheck + 全部测试**

```bash
npx tsc --noEmit && npx tsx --test src/tui/__tests__/tool-elapsed.test.ts && npx tsx --test src/tui/__tests__/phase-status.test.ts && npx tsx --test src/agent/__tests__/turn-stream.test.ts
```

预期：全部 PASS。

- [ ] **步骤 9：Commit**

```bash
git add src/tui/tool-card.tsx src/tui/app.tsx
git commit -m "feat(ui): show live elapsed time on streaming tool cards (S4)"
```

---

## Verification（验证命令）

### 类型检查
```bash
npx tsc --noEmit
```
预期：0 errors。

### 单元测试
```bash
npx tsx --test src/agent/__tests__/turn-stream.test.ts
npx tsx --test src/tui/__tests__/phase-status.test.ts
npx tsx --test src/tui/__tests__/tool-elapsed.test.ts
```
预期：全部 PASS。

### 全量回归
```bash
npm exec -- tsx --test 'src/**/__tests__/*.test.ts'
```
预期：无回归（S1/S2/S3/S4 只新增可选字段和可选 prop，不改变现有行为）。

### 构建验证
```bash
npm run build
```
预期：成功。

---

## Self-check（自检）

### 1. 规格覆盖度

| 需求 | 任务 | 状态 |
|------|------|------|
| 工具 hint 在 finish_reason 前显示 | S1 | ✅ |
| 首字节前立即显示 working | S2 | ✅ |
| perceive/intent 阻塞期显示 preparing | S3 | ✅ |
| phase 文案集中管理 | S3 | ✅ |
| 已有 heartbeat 信号不被吞 | S3（heartbeat case） | ✅ |
| 已有 intent-veto 信号不被吞 | S3（intent-veto case） | ✅ |
| 工具执行期 elapsed 显示 | S4 | ✅ |
| 工具中断时清理 start map | S4（onAbort clear） | ✅ |

### 2. 占位符扫描

- ✅ 无 TODO / TBD / 待定 / 后续实现
- ✅ 无"添加适当的错误处理"
- ✅ 无"类似任务 N"
- ✅ 所有类型/函数/属性在使用前已定义

### 3. 类型/签名一致性

| 符号 | 定义位置 | 引用位置 | 一致 |
|------|----------|----------|------|
| `onToolHint?: (name: string) => void` | turn-stream.ts `TurnStreamCallbacks` | loop.ts streamTurn callbacks, turn-stream.ts `onToolCallHint` handler | ✅ |
| `onStreamStart?: () => void` | turn-stream.ts `TurnStreamCallbacks` | loop.ts streamTurn callbacks, turn-stream.ts `streamTurn` method | ✅ |
| `phaseStatusLabel(phase, detail)` → `string \| null` | phase-status.ts | app.tsx `onPhaseChange` handler, phase-status.test.ts | ✅ |
| `phaseStatusLabel` detail 类型 `{ tool?; reason?; suggestion? }` | phase-status.ts | 匹配 loop.ts:180 `onPhaseChange` 的 detail 类型 `{ tool?; reason?; suggestion? }` | ✅ |
| `formatToolElapsed(ms: number)` → `string` | tool-elapsed.ts | tool-card.tsx, tool-elapsed.test.ts | ✅ |
| `elapsedMs?: number` | tool-card.tsx `ToolCardProps` | app.tsx `liveTools.map` 渲染 | ✅ |
| `toolStartMap: useRef<Map<string, number>>` | app.tsx | set (onToolUse), get (liveTools.map), delete (onToolResult), clear (onAbort) | ✅ |

---

## Execution Handoff

计划已完成并保存到 `docs/superpowers/plans/2026-05-30-fluency-silence-opt.md`。两种执行方式：
1. **子代理驱动（推荐）** — 每个任务调度一个新的子代理，任务间进行审查，快速迭代。S4 可与 S1-S3 并行。
2. **内联执行** — 在当前会话中使用 executing-plans 执行任务，批量执行并设有检查点。

选哪种方式？
