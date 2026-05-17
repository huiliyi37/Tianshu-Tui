# Rivet Activity Status Layer 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 为 Rivet TUI 增加轻量 Activity Status Layer，让长思考、大文件分析、工具/MCP 等待、预检和压缩过程在终端里可感知，同时不引入高频渲染或重型 trace 面板。

**架构：** 新增 `src/tui/activity-status.ts` 作为纯状态和格式化模块；`App` 用 ref 接收高频 activity 事件，并以不快于 1Hz 的节奏投影为 React state；`AgentStatus` 和 `ThinkingCollapser` 复用现有显示面，不新增 cockpit/timeline。第一版只跟踪一个当前 activity，不持久化、不改变 API 协议、不改变 AgentLoop 语义。

**技术栈：** TypeScript、React 19、Ink 6、Node.js `node:test`、tsx test runner。

---

## 文件结构

- 创建：`src/tui/activity-status.ts`
  - 纯 Activity 状态机、时长/停滞计算、显示格式化、工具标签辅助函数。
  - 不依赖 React，不读文件，不保存事件历史。
- 创建：`src/tui/__tests__/activity-status.test.ts`
  - 覆盖 activity 生命周期、stale 阈值、size hint、MCP 标签、large-result 分析启发式。
- 修改：`src/tui/agent-status.tsx`
  - 增加 `activitySummary?: string` prop；存在时主状态行优先显示 activity 文案，保留 spinner、token、tool list。
  - 导出必要的纯 helper 供测试验证，不把 activity 逻辑塞进组件。
- 修改：`src/tui/__tests__/agent-status.test.ts`
  - 扩展现有 `toolLabel` 测试，增加 activity summary 优先级 helper 测试。
- 修改：`src/tui/thinking.tsx`
  - 支持 `completedDurationMs?: number`，完成态展示最终耗时和 size。
  - 保留展开/折叠和 size helper；避免重复维护完成耗时语义。
- 修改：`src/tui/__tests__/thinking.test.tsx`
  - 增加 completed duration 文案 helper 测试。
- 修改：`src/tui/app.tsx`
  - 用 refs 保存 activity state、上次投影文本、投影 interval/timer。
  - 将现有 `onThinkingDelta`、`onTextDelta`、`onToolUse`、`onToolResult`、`onTurnComplete`、error/abort 清理映射为 activity 事件。
  - 保持现有 `THINKING_FLUSH_MS` / `TOOL_FLUSH_MS` 批处理，不在每个 delta 上 `setState`。
- 修改：`README.md`
  - 在 Session HA 后补充“长任务状态层”能力说明和非目标。
- 修改：`CHANGELOG.md`
  - 记录 Activity Status Layer 第一版。
- 修改：`.wolf/anatomy.md`
  - 记录新增模块、测试、TUI 接线。
- 修改：`.wolf/memory.md`
  - 追加本轮实施计划和执行范围。

---

## 任务 1：创建纯 Activity 状态模块

**文件：**
- 创建：`src/tui/activity-status.ts`
- 创建：`src/tui/__tests__/activity-status.test.ts`

- [ ] **步骤 1：编写失败的生命周期测试**

在 `src/tui/__tests__/activity-status.test.ts` 创建测试文件：

```ts
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  beginActivity,
  heartbeatActivity,
  completeActivity,
  clearActivity,
  failActivity,
  createIdleActivity,
} from '../activity-status.js'

describe('activity status lifecycle', () => {
  it('starts idle', () => {
    assert.deepEqual(createIdleActivity(1000), {
      phase: 'idle',
      startedAt: 1000,
      lastEventAt: 1000,
      status: 'idle',
    })
  })

  it('begins an activity with phase, label, size hint, and timestamps', () => {
    const activity = beginActivity(createIdleActivity(1000), 'thinking', 'Thinking', 2000, '12 chars')

    assert.equal(activity.phase, 'thinking')
    assert.equal(activity.label, 'Thinking')
    assert.equal(activity.startedAt, 2000)
    assert.equal(activity.lastEventAt, 2000)
    assert.equal(activity.sizeHint, '12 chars')
    assert.equal(activity.status, 'active')
  })

  it('heartbeats without resetting start time', () => {
    const activity = beginActivity(createIdleActivity(1000), 'tool', 'Running npm test', 2000)
    const next = heartbeatActivity(activity, 5000, { label: 'Running npm test', sizeHint: '3 lines' })

    assert.equal(next.startedAt, 2000)
    assert.equal(next.lastEventAt, 5000)
    assert.equal(next.label, 'Running npm test')
    assert.equal(next.sizeHint, '3 lines')
    assert.equal(next.status, 'active')
  })

  it('completion and failure freeze timestamps', () => {
    const activity = beginActivity(createIdleActivity(1000), 'mcp', 'Waiting for MCP context7', 2000)

    assert.deepEqual(completeActivity(activity, 8000), {
      ...activity,
      completedAt: 8000,
      lastEventAt: 8000,
      status: 'completed',
    })

    assert.deepEqual(failActivity(activity, 9000), {
      ...activity,
      completedAt: 9000,
      lastEventAt: 9000,
      status: 'failed',
    })
  })

  it('clears to idle at the provided time', () => {
    const activity = beginActivity(createIdleActivity(1000), 'streaming', 'Streaming answer', 2000)

    assert.deepEqual(clearActivity(activity, 7000), {
      phase: 'idle',
      startedAt: 7000,
      lastEventAt: 7000,
      status: 'idle',
    })
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：

```bash
npm test -- src/tui/__tests__/activity-status.test.ts
```

预期：FAIL，报错包含 `Cannot find module '../activity-status.js'` 或导出函数不存在。

- [ ] **步骤 3：实现最小 ActivityState 和生命周期函数**

创建 `src/tui/activity-status.ts`：

```ts
export type ActivityPhase =
  | 'idle'
  | 'thinking'
  | 'streaming'
  | 'analyzing'
  | 'tool'
  | 'mcp'
  | 'compacting'
  | 'preflight'

export type ActivityLifecycleStatus = 'active' | 'stale' | 'completed' | 'failed' | 'idle'

export interface ActivityState {
  phase: ActivityPhase
  label?: string
  startedAt: number
  lastEventAt: number
  completedAt?: number
  sizeHint?: string
  status: ActivityLifecycleStatus
}

interface HeartbeatOptions {
  label?: string
  sizeHint?: string
}

export function createIdleActivity(now: number): ActivityState {
  return {
    phase: 'idle',
    startedAt: now,
    lastEventAt: now,
    status: 'idle',
  }
}

export function beginActivity(
  _state: ActivityState,
  phase: Exclude<ActivityPhase, 'idle'>,
  label: string,
  now: number,
  sizeHint?: string,
): ActivityState {
  return {
    phase,
    label,
    startedAt: now,
    lastEventAt: now,
    sizeHint,
    status: 'active',
  }
}

export function heartbeatActivity(state: ActivityState, now: number, options: HeartbeatOptions = {}): ActivityState {
  if (state.phase === 'idle') return state

  return {
    ...state,
    label: options.label ?? state.label,
    sizeHint: options.sizeHint ?? state.sizeHint,
    lastEventAt: now,
    status: 'active',
  }
}

export function completeActivity(state: ActivityState, now: number, options: HeartbeatOptions = {}): ActivityState {
  if (state.phase === 'idle') return state

  return {
    ...state,
    label: options.label ?? state.label,
    sizeHint: options.sizeHint ?? state.sizeHint,
    lastEventAt: now,
    completedAt: now,
    status: 'completed',
  }
}

export function failActivity(state: ActivityState, now: number, options: HeartbeatOptions = {}): ActivityState {
  if (state.phase === 'idle') return state

  return {
    ...state,
    label: options.label ?? state.label,
    sizeHint: options.sizeHint ?? state.sizeHint,
    lastEventAt: now,
    completedAt: now,
    status: 'failed',
  }
}

export function clearActivity(_state: ActivityState, now: number): ActivityState {
  return createIdleActivity(now)
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：

```bash
npm test -- src/tui/__tests__/activity-status.test.ts
```

预期：PASS。

- [ ] **步骤 5：Commit**

```bash
git add src/tui/activity-status.ts src/tui/__tests__/activity-status.test.ts
git commit -m "feat(tui): add activity status lifecycle"
```

---

## 任务 2：实现 Activity 显示格式化和标签工具

**文件：**
- 修改：`src/tui/activity-status.ts`
- 修改：`src/tui/__tests__/activity-status.test.ts`

- [ ] **步骤 1：编写失败的格式化测试**

追加到 `src/tui/__tests__/activity-status.test.ts`：

```ts
import {
  formatActivityDuration,
  formatActivitySummary,
  formatThinkingSize,
  activityPhaseLabel,
  classifyToolActivity,
  shouldBeginAnalyzing,
} from '../activity-status.js'

describe('activity status formatting', () => {
  it('formats elapsed duration without fake progress', () => {
    assert.equal(formatActivityDuration(0), '0s')
    assert.equal(formatActivityDuration(59_000), '59s')
    assert.equal(formatActivityDuration(61_000), '1m 1s')
  })

  it('formats thinking size', () => {
    assert.equal(formatThinkingSize(999), '999 chars')
    assert.equal(formatThinkingSize(1500), '1.5k')
  })

  it('formats active activity with elapsed and size hint', () => {
    const activity = beginActivity(createIdleActivity(0), 'thinking', 'Thinking', 1000, '655 chars')

    assert.equal(formatActivitySummary(activity, 43_000), 'Thinking… 42s · 655 chars')
  })

  it('adds no-update text after the stale threshold', () => {
    const activity = heartbeatActivity(
      beginActivity(createIdleActivity(0), 'tool', 'Reading src/tui/app.tsx', 1000),
      10_000,
    )

    assert.equal(
      formatActivitySummary(activity, 25_000),
      'Reading src/tui/app.tsx… 24s · no update 15s',
    )
  })

  it('formats completed and failed activity using frozen completion time', () => {
    const completed = completeActivity(
      beginActivity(createIdleActivity(0), 'thinking', 'Thinking', 1000, '655 chars'),
      129_000,
    )
    const failed = failActivity(beginActivity(createIdleActivity(0), 'tool', 'Running npm test', 1000), 11_000)

    assert.equal(formatActivitySummary(completed, 300_000), 'Thinking completed in 2m 8s (655 chars)')
    assert.equal(formatActivitySummary(failed, 300_000), 'Running npm test failed after 10s')
  })

  it('maps phases to concise labels', () => {
    assert.equal(activityPhaseLabel('streaming'), 'Streaming answer')
    assert.equal(activityPhaseLabel('compacting'), 'Compacting context')
    assert.equal(activityPhaseLabel('preflight'), 'Restoring session')
  })

  it('classifies MCP tools separately from generic tools', () => {
    assert.deepEqual(classifyToolActivity('mcp__context7__query-docs'), {
      phase: 'mcp',
      label: 'Waiting for MCP context7',
    })
  })

  it('keeps large-result analysis heuristic conservative', () => {
    assert.equal(shouldBeginAnalyzing({ toolName: 'read_file', resultLength: 20_000 }), true)
    assert.equal(shouldBeginAnalyzing({ toolName: 'read_file', resultLength: 500 }), false)
    assert.equal(shouldBeginAnalyzing({ toolName: 'bash', resultLength: 25_000 }), true)
  })
})
```

如果 TypeScript 报重复 import，把新增 symbols 合并到文件顶部现有 import 中，不保留两个来自同一模块的 import 块。

- [ ] **步骤 2：运行测试验证失败**

运行：

```bash
npm test -- src/tui/__tests__/activity-status.test.ts
```

预期：FAIL，报错包含 `formatActivitySummary is not a function` 或相关导出缺失。

- [ ] **步骤 3：实现显示格式化与 conservative 分析启发式**

追加/修改 `src/tui/activity-status.ts`：

```ts
const STALE_SUMMARY_THRESHOLD_MS = 10_000
const LARGE_TOOL_RESULT_CHARS = 12_000

interface ToolActivityClassification {
  phase: Exclude<ActivityPhase, 'idle'>
  label: string
}

interface AnalysisCandidate {
  toolName: string
  resultLength: number
}

export function formatActivityDuration(ms: number): string {
  const totalSec = Math.max(0, Math.round(ms / 1000))
  if (totalSec < 60) return `${totalSec}s`
  const minutes = Math.floor(totalSec / 60)
  const seconds = totalSec % 60
  return `${minutes}m ${seconds}s`
}

export function formatThinkingSize(chars: number): string {
  if (chars < 1000) return `${chars} chars`
  return `${(chars / 1000).toFixed(1).replace(/\.0$/, '')}k`
}

export function activityPhaseLabel(phase: ActivityPhase): string {
  switch (phase) {
    case 'thinking': return 'Thinking'
    case 'streaming': return 'Streaming answer'
    case 'analyzing': return 'Analyzing tool results'
    case 'tool': return 'Running tool'
    case 'mcp': return 'Waiting for MCP'
    case 'compacting': return 'Compacting context'
    case 'preflight': return 'Restoring session'
    case 'idle': return 'Idle'
  }
}

export function formatActivitySummary(activity: ActivityState, now: number): string | undefined {
  if (activity.phase === 'idle' || activity.status === 'idle') return undefined

  const label = activity.label ?? activityPhaseLabel(activity.phase)
  const finishedAt = activity.completedAt ?? now
  const elapsed = formatActivityDuration(finishedAt - activity.startedAt)

  if (activity.status === 'completed') {
    return `${label} completed in ${elapsed}${activity.sizeHint ? ` (${activity.sizeHint})` : ''}`
  }

  if (activity.status === 'failed') {
    return `${label} failed after ${elapsed}${activity.sizeHint ? ` (${activity.sizeHint})` : ''}`
  }

  const parts = [`${label}… ${elapsed}`]
  const staleMs = now - activity.lastEventAt
  if (staleMs >= STALE_SUMMARY_THRESHOLD_MS) {
    parts.push(`no update ${formatActivityDuration(staleMs)}`)
  }
  if (activity.sizeHint) parts.push(activity.sizeHint)

  return parts.join(' · ')
}

export function classifyToolActivity(name: string, label?: string): ToolActivityClassification {
  if (name.startsWith('mcp__')) {
    const server = name.split('__')[1] || 'server'
    return { phase: 'mcp', label: `Waiting for MCP ${server}` }
  }

  return { phase: 'tool', label: label ?? 'Running tool' }
}

export function shouldBeginAnalyzing(candidate: AnalysisCandidate): boolean {
  if (candidate.resultLength < LARGE_TOOL_RESULT_CHARS) return false
  return candidate.toolName === 'read_file' || candidate.toolName === 'bash'
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：

```bash
npm test -- src/tui/__tests__/activity-status.test.ts
```

预期：PASS。

- [ ] **步骤 5：Commit**

```bash
git add src/tui/activity-status.ts src/tui/__tests__/activity-status.test.ts
git commit -m "feat(tui): format activity status summaries"
```

---

## 任务 3：让 AgentStatus 接收 Activity Summary

**文件：**
- 修改：`src/tui/agent-status.tsx`
- 修改：`src/tui/__tests__/agent-status.test.ts`

- [ ] **步骤 1：编写失败的纯 helper 测试**

追加到 `src/tui/__tests__/agent-status.test.ts`：

```ts
import { statusPhaseText } from '../agent-status.js'

describe('statusPhaseText', () => {
  it('prefers activity summary over derived phase labels', () => {
    assert.equal(
      statusPhaseText('Thinking… 42s · 655 chars', [], false),
      'Thinking… 42s · 655 chars',
    )
  })

  it('falls back to existing phase labels when activity summary is absent', () => {
    assert.equal(statusPhaseText(undefined, [], true), 'Thinking…')
    assert.equal(
      statusPhaseText(undefined, [{ id: '1', name: 'bash', label: 'npm test', done: false, error: false }], false),
      'Running…',
    )
  })
})
```

如果文件顶部已有 import，把 `statusPhaseText` 合并到现有 `../agent-status.js` import：

```ts
import { statusPhaseText, toolLabel } from '../agent-status.js'
```

- [ ] **步骤 2：运行测试验证失败**

运行：

```bash
npm test -- src/tui/__tests__/agent-status.test.ts
```

预期：FAIL，报错包含 `statusPhaseText` 未导出。

- [ ] **步骤 3：实现 prop 和 helper**

修改 `src/tui/agent-status.tsx`：

```ts
interface AgentStatusProps {
  isStreaming: boolean
  startMs: number
  tokenEstimate: number
  thinkingTime: number
  hasActiveThinking: boolean
  tools: ToolCallItem[]
  activitySummary?: string
}
```

在 `phaseLabel` 后添加并导出：

```ts
function statusPhaseText(activitySummary: string | undefined, tools: ToolCallItem[], isThinking: boolean): string {
  return activitySummary ?? phaseLabel(tools, isThinking)
}
```

更新 export：

```ts
export { statusPhaseText, toolLabel }
```

更新组件签名和 phase 计算：

```tsx
export const AgentStatus = memo(function AgentStatus({
  isStreaming,
  startMs,
  tokenEstimate,
  thinkingTime,
  hasActiveThinking,
  tools,
  activitySummary,
}: AgentStatusProps) {
  // existing body
  const phase = statusPhaseText(activitySummary, tools, isThinking)
```

- [ ] **步骤 4：运行测试验证通过**

运行：

```bash
npm test -- src/tui/__tests__/agent-status.test.ts
```

预期：PASS。

- [ ] **步骤 5：运行 TUI helper 相关测试**

运行：

```bash
npm test -- src/tui/__tests__/agent-status.test.ts src/tui/__tests__/activity-status.test.ts
```

预期：PASS。

- [ ] **步骤 6：Commit**

```bash
git add src/tui/agent-status.tsx src/tui/__tests__/agent-status.test.ts
git commit -m "feat(tui): show activity summaries in agent status"
```

---

## 任务 4：ThinkingCollapser 展示完成耗时

**文件：**
- 修改：`src/tui/thinking.tsx`
- 修改：`src/tui/__tests__/thinking.test.tsx`

- [ ] **步骤 1：编写失败的完成态文案测试**

追加到 `src/tui/__tests__/thinking.test.tsx`：

```ts
import { thinkingStatusLabel } from '../thinking.js'

describe('thinking status label', () => {
  it('keeps active thinking duration concise', () => {
    assert.equal(thinkingStatusLabel({ isStreaming: true, elapsedMs: 42_000 }), '42s')
  })

  it('shows final thinking duration after completion', () => {
    assert.equal(
      thinkingStatusLabel({ isStreaming: false, elapsedMs: 0, completedDurationMs: 128_000 }),
      'completed in 2m 8s',
    )
  })

  it('falls back to completed when no final duration is available', () => {
    assert.equal(thinkingStatusLabel({ isStreaming: false, elapsedMs: 0 }), 'completed')
  })
})
```

合并 import 后，文件顶部应类似：

```ts
import { formatDuration, formatThinkingSize, thinkingStatusLabel } from '../thinking.js'
```

- [ ] **步骤 2：运行测试验证失败**

运行：

```bash
npm test -- src/tui/__tests__/thinking.test.tsx
```

预期：FAIL，报错包含 `thinkingStatusLabel` 未导出。

- [ ] **步骤 3：实现 helper 和 prop**

修改 `src/tui/thinking.tsx`：

```ts
interface ThinkingStatusOptions {
  isStreaming: boolean
  elapsedMs: number
  completedDurationMs?: number
  stale?: boolean
}

export function thinkingStatusLabel(options: ThinkingStatusOptions): string {
  if (options.stale && options.isStreaming) return 'waiting for response…'
  if (options.isStreaming) return formatDuration(options.elapsedMs)
  if (options.completedDurationMs !== undefined) return `completed in ${formatDuration(options.completedDurationMs)}`
  return 'completed'
}
```

扩展 props：

```ts
interface ThinkingCollapserProps {
  thinking: string
  isStreaming: boolean
  focused?: boolean
  completedDurationMs?: number
}
```

更新组件参数和 statusLabel：

```tsx
export function ThinkingCollapser({ thinking, isStreaming, focused = false, completedDurationMs }: ThinkingCollapserProps) {
  // existing state/effect
  const statusLabel = thinkingStatusLabel({ isStreaming, elapsedMs: elapsed, completedDurationMs, stale })
```

保留现有本地 elapsed/stale timer；本任务只让完成态接收 Activity 层的最终耗时，避免一次性重写组件行为。

- [ ] **步骤 4：运行测试验证通过**

运行：

```bash
npm test -- src/tui/__tests__/thinking.test.tsx
```

预期：PASS。

- [ ] **步骤 5：Commit**

```bash
git add src/tui/thinking.tsx src/tui/__tests__/thinking.test.tsx
git commit -m "feat(tui): show completed thinking duration"
```

---

## 任务 5：在 App 中接入低频 Activity 投影

**文件：**
- 修改：`src/tui/app.tsx`
- 修改：`src/tui/activity-status.ts`
- 修改：`src/tui/__tests__/activity-status.test.ts`

- [ ] **步骤 1：编写失败的投影节流 helper 测试**

追加到 `src/tui/__tests__/activity-status.test.ts`：

```ts
import { shouldProjectActivity } from '../activity-status.js'

describe('activity projection cadence', () => {
  it('projects immediately when the text changes', () => {
    assert.equal(shouldProjectActivity({ previousText: 'Thinking… 1s', nextText: 'Thinking… 2s', previousAt: 1000, now: 1200 }), true)
  })

  it('skips unchanged text within the projection interval', () => {
    assert.equal(shouldProjectActivity({ previousText: 'Thinking… 1s', nextText: 'Thinking… 1s', previousAt: 1000, now: 1500 }), false)
  })

  it('allows unchanged text after one second for timer-driven stale updates', () => {
    assert.equal(shouldProjectActivity({ previousText: 'Thinking… 1s', nextText: 'Thinking… 1s', previousAt: 1000, now: 2200 }), true)
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：

```bash
npm test -- src/tui/__tests__/activity-status.test.ts
```

预期：FAIL，报错包含 `shouldProjectActivity` 未导出。

- [ ] **步骤 3：实现投影节流 helper**

追加到 `src/tui/activity-status.ts`：

```ts
const ACTIVITY_PROJECTION_INTERVAL_MS = 1000

interface ProjectionDecisionInput {
  previousText?: string
  nextText?: string
  previousAt: number
  now: number
}

export function shouldProjectActivity(input: ProjectionDecisionInput): boolean {
  if (input.previousText !== input.nextText) return true
  return input.now - input.previousAt >= ACTIVITY_PROJECTION_INTERVAL_MS
}
```

- [ ] **步骤 4：在 App 中增加 state/ref/import**

修改 `src/tui/app.tsx` imports，从 `activity-status.ts` 引入：

```ts
import {
  beginActivity,
  heartbeatActivity,
  completeActivity,
  clearActivity,
  failActivity,
  createIdleActivity,
  formatActivitySummary,
  formatThinkingSize,
  shouldProjectActivity,
  type ActivityState,
} from './activity-status.js'
```

在现有 TUI refs 附近增加：

```tsx
const activityRef = useRef<ActivityState>(createIdleActivity(Date.now()))
const activityTextRef = useRef<string | undefined>(undefined)
const activityProjectedAtRef = useRef(0)
const activityIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
const [activitySummary, setActivitySummary] = useState<string | undefined>(undefined)
const [completedThinkingDurationMs, setCompletedThinkingDurationMs] = useState<number | undefined>(undefined)
```

在组件内添加投影函数：

```tsx
const projectActivity = useCallback((now = Date.now()) => {
  const nextText = formatActivitySummary(activityRef.current, now)
  if (!shouldProjectActivity({
    previousText: activityTextRef.current,
    nextText,
    previousAt: activityProjectedAtRef.current,
    now,
  })) return

  activityTextRef.current = nextText
  activityProjectedAtRef.current = now
  setActivitySummary(nextText)
}, [])
```

添加 interval effect，确保最多 1Hz：

```tsx
useEffect(() => {
  if (!isStreaming) return
  activityIntervalRef.current = setInterval(() => projectActivity(), 1000)

  return () => {
    if (activityIntervalRef.current) {
      clearInterval(activityIntervalRef.current)
      activityIntervalRef.current = null
    }
  }
}, [isStreaming, projectActivity])
```

- [ ] **步骤 5：接入 thinking/text lifecycle**

在 `onThinkingDelta` 内，首次或后续 thinking delta 后更新 ref，但不要直接高频 `setState`：

```tsx
const now = Date.now()
const sizeHint = formatThinkingSize(thinkBuf.current.length)
if (activityRef.current.phase !== 'thinking') {
  activityRef.current = beginActivity(activityRef.current, 'thinking', 'Thinking', now, sizeHint)
} else {
  activityRef.current = heartbeatActivity(activityRef.current, now, { sizeHint })
}
projectActivity(now)
```

在 `onTextDelta` 的答案开始处接入 streaming：

```tsx
const now = Date.now()
if (activityRef.current.phase === 'thinking') {
  activityRef.current = completeActivity(activityRef.current, now, {
    sizeHint: formatThinkingSize(thinkBuf.current.length),
  })
  setCompletedThinkingDurationMs(activityRef.current.completedAt! - activityRef.current.startedAt)
} else if (activityRef.current.phase !== 'streaming') {
  activityRef.current = beginActivity(activityRef.current, 'streaming', 'Streaming answer', now)
} else {
  activityRef.current = heartbeatActivity(activityRef.current, now)
}
projectActivity(now)
```

如果 `onTextDelta` 当前逻辑的位置不同，放在已有 stream buffer 更新附近，确保不改变 `streamBuf.current` 的最终内容。

- [ ] **步骤 6：接入完成、错误、abort 清理**

在 turn completion 中：

```tsx
const now = Date.now()
if (activityRef.current.phase !== 'idle' && activityRef.current.status === 'active') {
  activityRef.current = completeActivity(activityRef.current, now)
  if (activityRef.current.phase === 'thinking') {
    setCompletedThinkingDurationMs(now - activityRef.current.startedAt)
  }
  projectActivity(now)
}
```

在新 turn 开始或明确清理路径中重置：

```tsx
activityRef.current = clearActivity(activityRef.current, Date.now())
activityTextRef.current = undefined
activityProjectedAtRef.current = 0
setActivitySummary(undefined)
setCompletedThinkingDurationMs(undefined)
```

在 error/abort callback 中：

```tsx
const now = Date.now()
activityRef.current = failActivity(activityRef.current, now)
projectActivity(now)
```

随后复用现有 turn cleanup；不要新增持久化。

- [ ] **步骤 7：传入显示组件**

修改 render：

```tsx
<ThinkingCollapser
  thinking={streamingThinking}
  isStreaming={isStreaming && !!streamingThinking}
  focused={!!streamingThinking}
  completedDurationMs={completedThinkingDurationMs}
/>
<AgentStatus
  isStreaming={isStreaming}
  startMs={streamStartRef.current || Date.now()}
  tokenEstimate={tokenEstimate}
  thinkingTime={thinkTimeRef.current}
  hasActiveThinking={isThinkingActive}
  tools={toolCallsDisplay}
  activitySummary={activitySummary}
/>
```

- [ ] **步骤 8：运行局部测试和类型检查**

运行：

```bash
npm test -- src/tui/__tests__/activity-status.test.ts src/tui/__tests__/thinking.test.tsx src/tui/__tests__/agent-status.test.ts
npm run typecheck
```

预期：全部 PASS。

- [ ] **步骤 9：Commit**

```bash
git add src/tui/app.tsx src/tui/activity-status.ts src/tui/__tests__/activity-status.test.ts
git commit -m "feat(tui): project activity status at low frequency"
```

---

## 任务 6：接入工具、MCP 和大结果分析 Activity

**文件：**
- 修改：`src/tui/app.tsx`
- 修改：`src/tui/activity-status.ts`
- 修改：`src/tui/__tests__/activity-status.test.ts`

- [ ] **步骤 1：编写失败的工具标签测试**

追加到 `src/tui/__tests__/activity-status.test.ts`：

```ts
import { analysisLabelForTool, toolActivityLabel } from '../activity-status.js'

describe('tool activity labels', () => {
  it('keeps file reads readable', () => {
    assert.equal(toolActivityLabel('read_file', 'read app.ts'), 'Reading app.ts')
  })

  it('keeps bash commands readable', () => {
    assert.equal(toolActivityLabel('bash', 'npm test -- src/tui'), 'Running npm test -- src/tui')
  })

  it('creates large-result analysis labels', () => {
    assert.equal(analysisLabelForTool('read_file', 'read app.ts'), 'Analyzing app.ts')
    assert.equal(analysisLabelForTool('bash', 'npm test'), 'Analyzing tool results')
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：

```bash
npm test -- src/tui/__tests__/activity-status.test.ts
```

预期：FAIL，报错包含 `toolActivityLabel` 或 `analysisLabelForTool` 未导出。

- [ ] **步骤 3：实现工具标签 helper**

追加到 `src/tui/activity-status.ts`：

```ts
export function toolActivityLabel(name: string, fallbackLabel: string): string {
  switch (name) {
    case 'read_file': return `Reading ${fallbackLabel.replace(/^read\s+/, '')}`
    case 'write_file': return `Writing ${fallbackLabel.replace(/^write\s+/, '')}`
    case 'edit_file': return `Editing ${fallbackLabel.replace(/^edit\s+/, '')}`
    case 'bash': return `Running ${fallbackLabel}`
    case 'grep':
    case 'glob':
    case 'diff': return `Searching ${fallbackLabel}`
    case 'run_tests': return 'Running tests'
    case 'delegate_task': return `Delegating ${fallbackLabel}`
    default: return `Running ${fallbackLabel || name}`
  }
}

export function analysisLabelForTool(name: string, label: string): string {
  if (name === 'read_file') return `Analyzing ${label.replace(/^read\s+/, '')}`
  return 'Analyzing tool results'
}
```

- [ ] **步骤 4：在 App 的 tool use/result 回调中接入 activity**

修改 `src/tui/app.tsx` import：

```ts
import {
  analysisLabelForTool,
  beginActivity,
  heartbeatActivity,
  completeActivity,
  clearActivity,
  failActivity,
  classifyToolActivity,
  createIdleActivity,
  formatActivitySummary,
  formatThinkingSize,
  shouldBeginAnalyzing,
  shouldProjectActivity,
  toolActivityLabel,
  type ActivityState,
} from './activity-status.js'
```

在 tool 相关 refs 附近新增：

```tsx
const lastCompletedToolRef = useRef<{ name: string; label: string; resultLength: number } | null>(null)
```

在 `onToolUse` 中，创建 `ToolCallItem` 后接入：

```tsx
const now = Date.now()
const label = toolLabel(name, input)
const classified = classifyToolActivity(name, toolActivityLabel(name, label))
activityRef.current = beginActivity(activityRef.current, classified.phase, classified.label, now)
projectActivity(now)
```

在 `onToolResult` 的 streaming chunk 分支中 heartbeat：

```tsx
if (isError === undefined) {
  // existing accumulation
  if (activityRef.current.phase === 'tool' || activityRef.current.phase === 'mcp') {
    activityRef.current = heartbeatActivity(activityRef.current, Date.now())
    projectActivity()
  }
  return
}
```

在最终 result 分支中完成/失败 activity 并记录大结果候选：

```tsx
const toolName = toolNames.current.get(id) ?? 'tool'
const label = toolCallTracker.current.get(id)?.label ?? toolName
const resultLength = result.length
const now = Date.now()
activityRef.current = isError
  ? failActivity(activityRef.current, now)
  : completeActivity(activityRef.current, now)
projectActivity(now)
lastCompletedToolRef.current = { name: toolName, label, resultLength }
```

- [ ] **步骤 5：在静默模型阶段触发 analyzing**

在 `onToolResult` 最终 result 后，如果不是错误且结果足够大，开始 analyzing；这个 activity 会在后续 `onTextDelta` 或新 `onToolUse` 中被 streaming/tool activity 替换：

```tsx
if (!isError && shouldBeginAnalyzing({ toolName, resultLength })) {
  activityRef.current = beginActivity(
    activityRef.current,
    'analyzing',
    analysisLabelForTool(toolName, label),
    Date.now(),
  )
  projectActivity()
}
```

该启发式只覆盖 `read_file` 和 `bash` 大输出，不为普通小工具结果制造噪音。

- [ ] **步骤 6：运行局部验证**

运行：

```bash
npm test -- src/tui/__tests__/activity-status.test.ts src/tui/__tests__/agent-status.test.ts
npm run typecheck
```

预期：全部 PASS。

- [ ] **步骤 7：Commit**

```bash
git add src/tui/app.tsx src/tui/activity-status.ts src/tui/__tests__/activity-status.test.ts
git commit -m "feat(tui): surface tool and analysis activity"
```

---

## 任务 7：补充文档、OpenWolf 记录和最终验证

**文件：**
- 修改：`README.md`
- 修改：`CHANGELOG.md`
- 修改：`.wolf/anatomy.md`
- 修改：`.wolf/memory.md`

- [ ] **步骤 1：更新 README**

在 `README.md` 的 Session HA / long-session 相关章节补充：

```md
### Activity Status Layer

Rivet now surfaces the current long-running activity instead of leaving the terminal looking idle. The TUI can show elapsed and stale time for thinking, streaming answers, tool execution, MCP waits, large-result analysis, compaction, and restore/preflight work without adding a trace timeline or high-frequency render loop.

Examples:

- `Thinking… 42s · 655 chars`
- `Reading src/tui/app.tsx… 52s · no update 14s`
- `Waiting for MCP context7… 24s`
- `Analyzing tool results… 46s`
```

若 README 已有更适合的功能列表位置，把以上内容压缩成同等信息量的 bullet，不新增重复章节。

- [ ] **步骤 2：更新 CHANGELOG**

在 `CHANGELOG.md` 的 `2026-05-17` 下添加：

```md
### Added

- Activity Status Layer for long Rivet turns: thinking duration, stale/no-update display, tool/MCP wait labels, and conservative large-result analysis status.

### Validation

- `npm run typecheck`
- `npm test`
- `npm run build`
- `git diff --check`
```

如果同日期已有 `Added` 或 `Validation` 小节，把条目合并进去，不创建重复标题。

- [ ] **步骤 3：更新 OpenWolf anatomy**

在 `.wolf/anatomy.md` 顶部 manual updates 区追加：

```md
> Manual update 2026-05-17: Activity Status Layer implementation added `src/tui/activity-status.ts`, tests in `src/tui/__tests__/activity-status.test.ts`, activity summary rendering in `src/tui/agent-status.tsx`, completed thinking duration in `src/tui/thinking.tsx`, and low-frequency App projection for thinking/tool/MCP/analyzing activity.
```

- [ ] **步骤 4：追加 OpenWolf memory**

在 `.wolf/memory.md` 末尾追加：

```md

## 2026-05-17 — Activity Status Layer implementation

Implemented the approved lightweight Activity Status Layer for long-task observability. The TUI now projects one current activity at low frequency, covering thinking, streaming, tool/MCP waits, and conservative large-output analysis without adding persistence, fake percentages, or a trace timeline.
```

- [ ] **步骤 5：运行最终验证**

运行：

```bash
npm run typecheck
npm test
npm run build
git diff --check
```

预期：

- TypeScript typecheck PASS。
- Node test suite PASS。
- Build PASS。
- `git diff --check` 无输出。

- [ ] **步骤 6：Commit**

```bash
git add README.md CHANGELOG.md .wolf/anatomy.md .wolf/memory.md
git commit -m "docs: document activity status layer"
```

---

## 自检清单

- 规格覆盖度：
  - Thinking elapsed/size/stale：任务 1、2、4、5 覆盖。
  - Completed thinking final duration：任务 4、5 覆盖。
  - Tool execution status：任务 3、5、6 覆盖。
  - MCP wait status：任务 2、6 覆盖。
  - Large-file/large-result analysis：任务 2、6 覆盖。
  - Compaction/preflight phase：任务 2 的 phase labels 覆盖；第一版只提供可用 phase 和格式化入口，不强行接入还未暴露的 callback。
  - Low-frequency projection：任务 5 覆盖。
  - Existing surfaces only：任务 3、4、5 覆盖。
  - No timeline/API/persistence/AgentLoop semantic change：所有任务限定在 TUI 和文档。
- 占位符扫描：本文没有未完成标记、空章节或未定义步骤。
- 类型一致性：`ActivityPhase`、`ActivityState`、`formatActivitySummary`、`activitySummary`、`completedThinkingDurationMs` 在计划中命名一致。
- 性能边界：所有高频事件只写 ref；React state 通过 `projectActivity` 和 `shouldProjectActivity` 节流，不在每个 delta 上无条件 `setState`。
- 安全边界：无外部输入执行、无 credential 示例、无 prompt/raw transcript 持久化。

---

## 执行选项

计划已完成并保存到 `docs/superpowers/plans/2026-05-17-rivet-activity-status-layer.md`。两种执行方式：

1. 子代理驱动（推荐）— 每个任务调度一个新的子代理，任务间进行规格符合性审查和代码质量审查。
2. 内联执行 — 在当前会话中按任务执行，并在关键检查点做验证。
