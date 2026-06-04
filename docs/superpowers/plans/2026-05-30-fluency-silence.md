# 流畅度优化 · 簇一：静默窗口（S1-S4）实现计划

> **状态：✅ 已全部实施** — Fluency silence 策略 (fluency-policy.ts)

**目标：** 消除"UI 在工作但看起来像卡死"的静默窗口——让"即将调工具 / 正在等首字节 / 正在准备下一轮 / 工具执行中"随时可见。

**架构：** 复用已有的 `onPhaseChange` + `heartbeatStatus` 渲染通道（app.tsx:1231），不新增 UI 组件。在 `TurnStreamCallbacks` 增加轻量信号回调（`onToolHint`、`onStreamStart`），在 loop 进入流式前/准备链时 emit phase，UI 把 phase 映射成状态文案。

**技术栈：** TypeScript、Ink、node:test + tsx。测试命令 `npx tsx --test <file>`，类型检查 `npm run typecheck`。

**顺序依赖（重要）：** S1→S2→S3 有依赖且都改 `src/agent/turn-stream.ts` 的 `TurnStreamCallbacks` 接口与 `src/tui/app.tsx` 的 `onPhaseChange`。S3 抽出纯函数 `phaseStatusLabel` 集中文案，会**吸收 S1/S2 在 app.tsx 里的内联分支**。必须按 S1→S2→S3 顺序实现。S4 独立。

**已核实的现状关键点：**
- `openai-client.ts:432-439` 的 `onToolCallHint` 已在 finish_reason 之前触发，只是仅用于 prewarm（`turn-stream.ts:111-115`）——S1 是"把已有 hint 接到 UI"，非"补发 hint"。
- `loop.ts:980` heartbeat `silentMs: 20_000`；`app.tsx:739` 仅首个 `onThinkingDelta` 才 `setIsThinkingActive(true)`，首字节前无指示。

---

### 任务 S1：工具指示器在 finish_reason 之前显示（hint→UI 信号）

**文件：**
- 修改：`src/agent/turn-stream.ts`（`TurnStreamCallbacks` 接口 7-12，`onToolCallHint` 回调 111-115）
- 修改：`src/agent/loop.ts`（streamTurn callbacks，1419-1421 附近）
- 修改：`src/tui/app.tsx`（onPhaseChange，1028 区块）
- 测试：`src/agent/__tests__/turn-stream.test.ts`（追加用例）

- [ ] **步骤 1：写失败测试**

追加到 `src/agent/__tests__/turn-stream.test.ts`（复用文件内既有的 `makeController`/`request` 辅助；若无同名辅助，参照文件现有用例的构造方式）：

```ts
  it('S1: forwards tool hint to onToolHint before finish_reason flush', async () => {
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
        onTextDelta: () => {}, onThinkingDelta: () => {},
        onToolUse: () => { events.push('tool_use') },
        onToolHint: (name) => { events.push(`hint:${name}`) },
        onError: () => {},
      },
    })
    assert.deepEqual(events, ['hint:read_file', 'tool_use'])
  })
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npx tsx --test src/agent/__tests__/turn-stream.test.ts`
预期：FAIL。`TurnStreamCallbacks` 无 `onToolHint`，TS 报 `Object literal may only specify known properties`；运行时 `events` 为 `['tool_use']`，断言 `AssertionError [deepEqual]`。

- [ ] **步骤 3：写最小实现**

`src/agent/turn-stream.ts` 接口加 `onToolHint`（在 `onToolUse` 之后）：

```ts
export interface TurnStreamCallbacks {
  onTextDelta: (text: string) => void
  onThinkingDelta: (thinking: string) => void
  onToolUse: (id: string, name: string, input: Record<string, unknown>) => void
  onToolHint?: (name: string) => void
  onError: (error: Error) => void
}
```

`src/agent/turn-stream.ts` 第111-115行 `onToolCallHint` 回调改为转发：

```ts
      onToolCallHint: (toolName, partialArgs) => {
        input.callbacks.onToolHint?.(toolName)
        if (toolName === 'read_file' && typeof partialArgs.file_path === 'string') {
          this.deps.prewarmFile?.(partialArgs.file_path)
        }
      },
```

`src/agent/loop.ts` streamTurn 的 callbacks 对象（1419-1421 附近）加：

```ts
            onToolHint: (name) => { callbacks.onPhaseChange?.('tool-hint', { tool: name }) },
```

`src/tui/app.tsx` onPhaseChange（1028 之后、heartbeat 分支旁）加：

```ts
        if (phase === 'tool-hint' && detail?.tool) {
          setHeartbeatStatus(`preparing ${detail.tool}…`)
          return
        }
```

- [ ] **步骤 4：运行测试验证通过**

运行：`npx tsx --test src/agent/__tests__/turn-stream.test.ts && npm run typecheck`
预期：PASS。

- [ ] **步骤 5：Commit**

```bash
git add src/agent/turn-stream.ts src/agent/loop.ts src/tui/app.tsx src/agent/__tests__/turn-stream.test.ts
git commit -m "feat(stream): surface tool hint as UI signal before finish_reason (S1)"
```

### 任务 S2：首字节前立即显示 working 指示（不靠 20s 心跳兜底）

现状：`loop.ts:980` heartbeat `silentMs: 20_000`，首次"still working"要 20 秒后才出。`app.tsx:739` 仅首个 `onThinkingDelta` 才置 thinking。修法（最小、cache 安全——纯 UI 信号，不碰 request）：给 `TurnStreamCallbacks` 加 `onStreamStart?()`，在 `streamTurn` 调 `client.stream` **之前**同步调用；loop 把它接到 `onPhaseChange('working', ...)`；app.tsx 映射成 heartbeatStatus。从发请求那一刻就有可见反馈，无需改心跳阈值或动 thinking 状态机。

**文件：**
- 修改：`src/agent/turn-stream.ts`（接口加 `onStreamStart`；`streamTurn` 调 `client.stream` 前一行）
- 修改：`src/agent/loop.ts`（streamTurn callbacks，1419 区块）
- 修改：`src/tui/app.tsx`（onPhaseChange，1028 区块）
- 测试：`src/agent/__tests__/loop-working-phase.test.ts`（新建）

- [ ] **步骤 1：写失败测试**

新建 `src/agent/__tests__/loop-working-phase.test.ts`：

```ts
import { describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'
import { TurnStreamController } from '../turn-stream.js'
import type { StreamCallbacks, StreamClient } from '../../api/stream-client.js'
import type { OaiChatRequest } from '../../api/oai-types.js'

const request: OaiChatRequest = { model: 'm', messages: [], max_tokens: 16 }

describe('S2: working indicator before first byte', () => {
  it('fires onStreamStart before any text/thinking delta', async () => {
    const order: string[] = []
    const client: StreamClient = {
      stream: mock.fn(async (_r: OaiChatRequest, cb: StreamCallbacks) => {
        order.push('stream-called')
        cb.onThinkingDelta('t'); cb.onTextDelta('hi'); cb.onStopReason('end_turn', {})
      }),
    }
    const controller = new TurnStreamController({
      client, abortSignal: new AbortController().signal,
      getStreamedTextLength: () => 0, appendStreamedText: () => {},
      getLastPrewarmAt: () => 0, setLastPrewarmAt: () => {}, maybePrewarm: () => {},
      addUsage: () => {}, recordTurnCache: () => {},
    })
    await controller.streamTurn({
      request, turn: 0, lastTurnTextFingerprint: '',
      callbacks: {
        onTextDelta: () => { order.push('text') },
        onThinkingDelta: () => { order.push('thinking') },
        onToolUse: () => {},
        onStreamStart: () => { order.push('working') },
        onError: () => {},
      },
    })
    assert.equal(order[0], 'working', `working must be first, got ${order.join(',')}`)
    assert.ok(order.indexOf('working') < order.indexOf('thinking'))
  })
})
```

> 注：`TurnStreamController` 构造参数以该文件中现有用例为准（上面的依赖对象是草稿推断；执行前对照 `turn-stream.ts` 的 `TurnStreamDeps` 补齐字段）。核心断言是 `onStreamStart` 早于任何 delta。

- [ ] **步骤 2：运行测试验证失败**

运行：`npx tsx --test src/agent/__tests__/loop-working-phase.test.ts`
预期：FAIL。`TurnStreamCallbacks` 无 `onStreamStart`（TS `known properties`）；运行时 `order.indexOf('working')` 为 `-1`，`AssertionError: working must be first, got stream-called,thinking,text`。

- [ ] **步骤 3：写最小实现**

`src/agent/turn-stream.ts` 接口加 `onStreamStart`：

```ts
export interface TurnStreamCallbacks {
  onTextDelta: (text: string) => void
  onThinkingDelta: (thinking: string) => void
  onToolUse: (id: string, name: string, input: Record<string, unknown>) => void
  onToolHint?: (name: string) => void
  onStreamStart?: () => void
  onError: (error: Error) => void
}
```

在 `streamTurn` 调 `this.deps.client.stream(...)` 之前一行插入：

```ts
      input.callbacks.onStreamStart?.()
      await this.deps.client.stream(input.request, streamCallbacks, this.deps.abortSignal)
```

`src/agent/loop.ts` streamTurn callbacks（1419 区块）加：

```ts
            onStreamStart: () => { callbacks.onPhaseChange?.('working', { reason: 'waiting for first token' }) },
```

`src/tui/app.tsx` onPhaseChange（heartbeat 分支后）加：

```ts
        if (phase === 'working') {
          setHeartbeatStatus(detail?.reason ?? 'working…')
          return
        }
```

- [ ] **步骤 4：运行测试验证通过**

运行：`npx tsx --test src/agent/__tests__/loop-working-phase.test.ts && npm run typecheck`
预期：PASS。

- [ ] **步骤 5：Commit**

```bash
git add src/agent/turn-stream.ts src/agent/loop.ts src/tui/app.tsx src/agent/__tests__/loop-working-phase.test.ts
git commit -m "feat(stream): emit working phase at stream start, before first token (S2)"
```

---

### 任务 S3：前置链（perceive/intent/ceiling）阻塞期显示"准备中" + 集中 phase 文案

现状：`loop.ts:1220` `perception.perceive(...)` 与 `loop.ts:1278` `intent.evaluate(...)` 是串行 `await`，执行于上一轮 tool 结果之后、`streamTurn`（1391）之前，期间无 UI 信号。修法（最小）：进入 perceive 之前 emit `preparing` phase；同时把 phase→文案抽成纯函数 `phaseStatusLabel`，让 S1/S2/S3 文案集中可测，onPhaseChange 改为统一调用它（吸收 S1/S2 的内联分支）。`preparing`（发请求前本地准备）与 `working`（已发请求等首字节）语义不同，分开。

**文件：**
- 创建：`src/tui/phase-status.ts`
- 修改：`src/agent/loop.ts`（perceive 调用前，1220 之前）
- 修改：`src/tui/app.tsx`（onPhaseChange，1028 区块 — 用纯函数替换 S1/S2 内联分支）
- 测试：`src/tui/__tests__/phase-status.test.ts`（新建）

- [ ] **步骤 1：写失败测试**

新建 `src/tui/__tests__/phase-status.test.ts`：

```ts
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { phaseStatusLabel } from '../phase-status.js'

describe('S3: phase status labels', () => {
  it('maps preparing phase to a preparing status', () => {
    assert.equal(phaseStatusLabel('preparing'), 'preparing…')
  })
  it('maps working phase using detail.reason', () => {
    assert.equal(phaseStatusLabel('working', { reason: 'waiting for first token' }), 'waiting for first token')
  })
  it('maps tool-hint phase using detail.tool', () => {
    assert.equal(phaseStatusLabel('tool-hint', { tool: 'read_file' }), 'preparing read_file…')
  })
  it('returns null for unmapped phases', () => {
    assert.equal(phaseStatusLabel('tianshu-planning'), null)
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npx tsx --test src/tui/__tests__/phase-status.test.ts`
预期：FAIL。`Cannot find module '../phase-status.js'`，导入即抛 `ERR_MODULE_NOT_FOUND`。

- [ ] **步骤 3：写最小实现**

新建 `src/tui/phase-status.ts`：

```ts
/** Map a lightweight agent phase to a status-line label, or null if not a status phase. */
export function phaseStatusLabel(
  phase: string,
  detail?: { tool?: string; reason?: string },
): string | null {
  switch (phase) {
    case 'preparing': return 'preparing…'
    case 'working': return detail?.reason ?? 'working…'
    case 'tool-hint': return detail?.tool ? `preparing ${detail.tool}…` : 'preparing…'
    default: return null
  }
}
```

`src/agent/loop.ts` 在 `perception.perceive` 调用（1220）之前一行加：

```ts
        callbacks.onPhaseChange?.('preparing', { reason: 'preparing next turn' })
```

`src/tui/app.tsx` 顶部 import：

```ts
import { phaseStatusLabel } from './phase-status.js'
```

onPhaseChange（1028 区块）— 删除 S1/S2 加的内联 `if (phase === 'tool-hint')` / `if (phase === 'working')` 分支，统一替换为：

```ts
        const statusLabel = phaseStatusLabel(phase, detail)
        if (statusLabel !== null) {
          setHeartbeatStatus(statusLabel)
          return
        }
```

- [ ] **步骤 4：运行测试验证通过**

运行：`npx tsx --test src/tui/__tests__/phase-status.test.ts && npm run typecheck`
预期：PASS。

- [ ] **步骤 5：Commit**

```bash
git add src/tui/phase-status.ts src/agent/loop.ts src/tui/app.tsx src/tui/__tests__/phase-status.test.ts
git commit -m "feat(ui): emit preparing phase during pre-stream chain, centralize phase labels (S3)"
```

### 任务 S4：非流式工具（read/grep/glob）执行期显示 elapsed 进度

现状：`tool-pipeline.ts:332-334` 的 `onOutput` 只被 `bash`/`run_tests` 调用，其余工具执行期零信号，`ToolCard`（tool-card.tsx:55）流式时只显示静态 `verb …`。修法（最小，纯 UI，不造假进度）：在 `ToolCard` 显示真实 elapsed 秒数让"Running"动起来。为符合项目"测纯函数"约定（无 `ink-testing-library`），把"毫秒→人类可读 elapsed"抽成纯函数 `formatToolElapsed(ms)` 单测，ToolCard 渲染时调用它。app.tsx 的既有 liveTools 1s tick（line 338-343）驱动重渲染，工具 start 时间记在 `toolStartMap`。

**文件：**
- 创建：`src/tui/tool-elapsed.ts`（纯函数 `formatToolElapsed`）
- 修改：`src/tui/tool-card.tsx`（props 加 `elapsedMs?`，标题区 52-58 显示）
- 修改：`src/tui/app.tsx`（onToolUse 记 start，liveTools 渲染传 `elapsedMs`）
- 测试：`src/tui/__tests__/tool-elapsed.test.ts`（新建）

- [ ] **步骤 1：写失败测试**

新建 `src/tui/__tests__/tool-elapsed.test.ts`：

```ts
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { formatToolElapsed } from '../tool-elapsed.js'

describe('S4: formatToolElapsed', () => {
  it('returns empty for under 1 second (no noise on fast tools)', () => {
    assert.equal(formatToolElapsed(0), '')
    assert.equal(formatToolElapsed(800), '')
  })
  it('shows whole seconds from 1s', () => {
    assert.equal(formatToolElapsed(1000), '1s')
    assert.equal(formatToolElapsed(4200), '4s')
  })
  it('shows m:ss past a minute', () => {
    assert.equal(formatToolElapsed(65000), '1m05s')
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npx tsx --test src/tui/__tests__/tool-elapsed.test.ts`
预期：FAIL。`Cannot find module '../tool-elapsed.js'`，`ERR_MODULE_NOT_FOUND`。

- [ ] **步骤 3：写最小实现**

新建 `src/tui/tool-elapsed.ts`：

```ts
/** Format tool runtime for the streaming tool card; empty under 1s to avoid noise. */
export function formatToolElapsed(ms: number): string {
  if (ms < 1000) return ''
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`
}
```

`src/tui/tool-card.tsx` — props 接口加 `elapsedMs?: number`，标题区（52-58）在 streaming 时显示：

```tsx
      {isStreaming && formatToolElapsed(elapsedMs ?? 0) && (
        <Text color={theme.muted}> {formatToolElapsed(elapsedMs ?? 0)}</Text>
      )}
```

并在 tool-card.tsx 顶部 import：`import { formatToolElapsed } from './tool-elapsed.js'`。

`src/tui/app.tsx`：
- onToolUse（752）记录 start：在 push liveTools 条目处加 `toolStartMap.current.set(id, Date.now())`（`toolStartMap` 为新增 `useRef(new Map<string, number>())`）。
- onToolResult（798 区块）清理：`toolStartMap.current.delete(id)`。
- liveTools 渲染（1217-1221）给 `ToolCard` 传：`elapsedMs={Date.now() - (toolStartMap.current.get(log.id) ?? Date.now())}`（复用 line 338-343 的 1s tick 触发重渲染）。

- [ ] **步骤 4：运行测试验证通过**

运行：`npx tsx --test src/tui/__tests__/tool-elapsed.test.ts && npm run typecheck`
预期：PASS。

- [ ] **步骤 5：Commit**

```bash
git add src/tui/tool-elapsed.ts src/tui/tool-card.tsx src/tui/app.tsx src/tui/__tests__/tool-elapsed.test.ts
git commit -m "feat(ui): show live elapsed time on streaming tool cards (S4)"
```

---

## 自检结果

- **覆盖度：** S1（hint→UI）、S2（working phase）、S3（preparing phase + 集中文案）、S4（工具 elapsed）四任务齐全。
- **类型一致性：** `TurnStreamCallbacks` 跨 S1（`onToolHint`）/S2（`onStreamStart`）累加一致；`phaseStatusLabel(phase, detail)` 签名与 S1/S2/S3 emit 的 phase 名（`tool-hint`/`working`/`preparing`）+ detail 字段（`tool`/`reason`）一致；`formatToolElapsed(ms)` 独立。
- **顺序依赖：** S1→S2 累加 `TurnStreamCallbacks`；S3 抽 `phaseStatusLabel` 并**删除 S1/S2 在 app.tsx 的内联分支**，必须 S1→S2→S3 顺序执行。S4 独立。
- **执行前需核实（不影响结构）：** `turn-stream.test.ts` 是否已有 `makeController`/`request` 辅助；`TurnStreamController` 的 `TurnStreamDeps` 完整字段；app.tsx onPhaseChange 的 `detail` 参数名。
- **已知约束：** S4 因无 `ink-testing-library` 改测纯函数 `formatToolElapsed`（项目既有约定）。

