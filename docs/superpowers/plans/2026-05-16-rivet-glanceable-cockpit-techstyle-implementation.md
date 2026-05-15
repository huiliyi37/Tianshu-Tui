# Rivet Glanceable Cockpit + 科技风视觉层 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 为 Rivet TUI 实现 "2 秒回神" Glanceable Cockpit（3 行摘要区 + 阶段感知）和科技风视觉层（配色系统 + 工具着色 + gradient banner），提升长任务开发能力和视觉体验。

**架构：** AgentLoop emit PhaseEvent → PhaseTracker 状态机 → SummaryState → `<SummaryBar>` 组件（live area 顶部 3 行）。科技风视觉层通过 theme 模块统一管理配色，支持 truecolor + 256-color 降级。

**技术栈：** TypeScript, Ink 6, React 19, gradient-string, chalk (已有)

**设计文档：** `docs/superpowers/specs/2026-05-16-rivet-glanceable-cockpit-techstyle-design.md`

---

## 文件结构

### 新建文件

| 文件 | 职责 |
|------|------|
| `src/tui/theme.ts` | 配色系统：truecolor/256-color 检测 + 语义色值导出 |
| `src/tui/summary-bar.tsx` | SummaryBar 组件：3 行摘要区渲染 |
| `src/tui/phase-tracker.ts` | PhaseTracker：工具事件 → 阶段状态机 |
| `src/tui/__tests__/theme.test.ts` | theme 单元测试 |
| `src/tui/__tests__/summary-bar.test.ts` | SummaryBar 渲染测试 |
| `src/tui/__tests__/phase-tracker.test.ts` | PhaseTracker 状态机测试 |

### 修改文件

| 文件 | 变更 |
|------|------|
| `src/tui/app.tsx` | 集成 SummaryBar + PhaseTracker，传递状态 |
| `src/tui/tool-card.tsx` | 工具卡片左边框按类型着色 |
| `src/tui/status-bar.tsx` | 使用 theme 配色替换硬编码颜色 |
| `package.json` | 添加 `gradient-string` 依赖 |

---

## Phase 1：科技风配色系统 + Theme 模块

### 任务 1：Theme 模块

**文件：**
- 创建：`src/tui/theme.ts`
- 测试：`src/tui/__tests__/theme.test.ts`

- [x] **步骤 1：编写 theme 测试**

```typescript
// src/tui/__tests__/theme.test.ts
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { getTheme, type RivetTheme } from '../theme.js'

describe('getTheme', () => {
  it('returns truecolor theme when colorLevel >= 3', () => {
    const theme = getTheme(3)
    assert.equal(theme.primary, '#00ffcc')
    assert.equal(theme.error, '#ff3333')
  })

  it('returns 256-color fallback when colorLevel < 3', () => {
    const theme = getTheme(1)
    assert.equal(theme.primary, 'cyan')
    assert.equal(theme.error, 'red')
  })

  it('maps tool names to border colors', () => {
    const theme = getTheme(3)
    assert.equal(theme.toolColor('bash'), theme.primary)
    assert.equal(theme.toolColor('edit_file'), theme.secondary)
    assert.equal(theme.toolColor('run_tests'), theme.success)
    assert.equal(theme.toolColor('read_file'), theme.dim)
    assert.equal(theme.toolColor('unknown_tool'), theme.dim)
  })

  it('returns context bar color by percentage', () => {
    const theme = getTheme(3)
    assert.equal(theme.contextColor(0.3), theme.primary)
    assert.equal(theme.contextColor(0.7), theme.warning)
    assert.equal(theme.contextColor(0.85), theme.error)
  })
})
```

- [x] **步骤 2：运行测试验证失败**

运行：`npx tsx --test src/tui/__tests__/theme.test.ts`
预期：FAIL，"Cannot find module '../theme.js'"

- [x] **步骤 3：实现 theme 模块**

```typescript
// src/tui/theme.ts
import chalk from 'chalk'

export interface RivetTheme {
  primary: string
  secondary: string
  success: string
  warning: string
  error: string
  dim: string
  toolColor: (toolName: string) => string
  contextColor: (pct: number) => string
}

const TRUECOLOR: RivetTheme = {
  primary: '#00ffcc',
  secondary: '#7b2fff',
  success: '#00ff88',
  warning: '#ffaa00',
  error: '#ff3333',
  dim: '#4a4a6a',
  toolColor(name: string) {
    switch (name) {
      case 'bash': case 'grep': case 'glob': return this.primary
      case 'edit_file': case 'write_file': return this.secondary
      case 'run_tests': return this.success
      case 'delegate_task': return this.warning
      default: return this.dim
    }
  },
  contextColor(pct: number) {
    if (pct >= 0.8) return this.error
    if (pct >= 0.6) return this.warning
    return this.primary
  },
}

const FALLBACK: RivetTheme = {
  primary: 'cyan',
  secondary: 'magenta',
  success: 'green',
  warning: 'yellow',
  error: 'red',
  dim: 'gray',
  toolColor(name: string) {
    switch (name) {
      case 'bash': case 'grep': case 'glob': return this.primary
      case 'edit_file': case 'write_file': return this.secondary
      case 'run_tests': return this.success
      case 'delegate_task': return this.warning
      default: return this.dim
    }
  },
  contextColor(pct: number) {
    if (pct >= 0.8) return this.error
    if (pct >= 0.6) return this.warning
    return this.primary
  },
}

export function getTheme(colorLevel?: number): RivetTheme {
  const level = colorLevel ?? chalk.level
  return level >= 3 ? TRUECOLOR : FALLBACK
}
```

- [x] **步骤 4：运行测试验证通过**

运行：`npx tsx --test src/tui/__tests__/theme.test.ts`
预期：PASS

- [x] **步骤 5：Commit**

```bash
git add src/tui/theme.ts src/tui/__tests__/theme.test.ts
git commit -m "feat(tui): add theme module with truecolor/256 fallback"
```

---

### 任务 2：PhaseTracker 状态机

**文件：**
- 创建：`src/tui/phase-tracker.ts`
- 测试：`src/tui/__tests__/phase-tracker.test.ts`

- [x] **步骤 1：编写 PhaseTracker 测试**

```typescript
// src/tui/__tests__/phase-tracker.test.ts
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { PhaseTracker, type Phase } from '../phase-tracker.js'

describe('PhaseTracker', () => {
  it('starts in idle phase', () => {
    const pt = new PhaseTracker()
    assert.equal(pt.current(), 'idle')
  })

  it('transitions to coding on edit_file', () => {
    const pt = new PhaseTracker()
    pt.onToolUse('edit_file')
    assert.equal(pt.current(), 'coding')
  })

  it('transitions to testing on run_tests', () => {
    const pt = new PhaseTracker()
    pt.onToolUse('run_tests')
    assert.equal(pt.current(), 'testing')
  })

  it('transitions to searching on read_file/grep/glob', () => {
    const pt = new PhaseTracker()
    pt.onToolUse('grep')
    assert.equal(pt.current(), 'searching')
  })

  it('transitions to running on bash', () => {
    const pt = new PhaseTracker()
    pt.onToolUse('bash')
    assert.equal(pt.current(), 'running')
  })

  it('transitions to delegating on delegate_task', () => {
    const pt = new PhaseTracker()
    pt.onToolUse('delegate_task')
    assert.equal(pt.current(), 'delegating')
  })

  it('resets to idle on turn complete', () => {
    const pt = new PhaseTracker()
    pt.onToolUse('edit_file')
    pt.onTurnComplete()
    assert.equal(pt.current(), 'idle')
  })

  it('tracks step count within a turn', () => {
    const pt = new PhaseTracker()
    pt.onToolUse('read_file')
    pt.onToolUse('edit_file')
    pt.onToolUse('run_tests')
    assert.equal(pt.stepCount(), 3)
  })

  it('records last action', () => {
    const pt = new PhaseTracker()
    pt.onToolResult('edit_file', 'src/auth.ts', false)
    assert.deepEqual(pt.lastAction(), { tool: 'edit_file', target: 'src/auth.ts', success: true })
  })

  it('records last action failure', () => {
    const pt = new PhaseTracker()
    pt.onToolResult('run_tests', 'auth.test.ts', true)
    assert.deepEqual(pt.lastAction(), { tool: 'run_tests', target: 'auth.test.ts', success: false })
  })
})
```

- [x] **步骤 2：运行测试验证失败**

运行：`npx tsx --test src/tui/__tests__/phase-tracker.test.ts`
预期：FAIL，"Cannot find module '../phase-tracker.js'"

- [x] **步骤 3：实现 PhaseTracker**

```typescript
// src/tui/phase-tracker.ts
export type Phase = 'idle' | 'searching' | 'coding' | 'testing' | 'running' | 'delegating'

export interface LastAction {
  tool: string
  target: string
  success: boolean
}

export class PhaseTracker {
  private phase: Phase = 'idle'
  private steps = 0
  private last: LastAction | null = null

  current(): Phase { return this.phase }
  stepCount(): number { return this.steps }
  lastAction(): LastAction | null { return this.last }

  onToolUse(toolName: string): void {
    this.steps++
    switch (toolName) {
      case 'edit_file': case 'write_file':
        this.phase = 'coding'; break
      case 'run_tests':
        this.phase = 'testing'; break
      case 'read_file': case 'grep': case 'glob': case 'diff':
        this.phase = 'searching'; break
      case 'bash':
        this.phase = 'running'; break
      case 'delegate_task':
        this.phase = 'delegating'; break
    }
  }

  onToolResult(toolName: string, target: string, isError: boolean): void {
    this.last = { tool: toolName, target, success: !isError }
  }

  onTurnComplete(): void {
    this.phase = 'idle'
    this.steps = 0
  }
}
```

- [x] **步骤 4：运行测试验证通过**

运行：`npx tsx --test src/tui/__tests__/phase-tracker.test.ts`
预期：PASS

- [x] **步骤 5：Commit**

```bash
git add src/tui/phase-tracker.ts src/tui/__tests__/phase-tracker.test.ts
git commit -m "feat(tui): add PhaseTracker state machine for agent phase detection"
```

---

## Phase 2：SummaryBar 组件

### 任务 3：SummaryBar 组件

**文件：**
- 创建：`src/tui/summary-bar.tsx`
- 测试：`src/tui/__tests__/summary-bar.test.ts`

- [x] **步骤 1：编写 SummaryBar 测试**

```typescript
// src/tui/__tests__/summary-bar.test.ts
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { formatSummaryLine1, formatSummaryLine2, formatSummaryLine3 } from '../summary-bar.js'
import type { SummaryState } from '../summary-bar.js'

describe('SummaryBar formatting', () => {
  const state: SummaryState = {
    task: 'refactor auth middleware',
    phase: 'testing',
    stepCount: 3,
    totalSteps: 5,
    contextPct: 0.65,
    elapsedMs: 252000,
    lastAction: { tool: 'edit_file', target: 'src/auth/middleware.ts', success: true },
    risk: 'none',
  }

  it('formats line 1 with task, phase, context, elapsed', () => {
    const line = formatSummaryLine1(state)
    assert.ok(line.includes('refactor auth middleware'))
    assert.ok(line.includes('testing'))
    assert.ok(line.includes('3/5'))
    assert.ok(line.includes('65%'))
    assert.ok(line.includes('4m'))
  })

  it('formats line 2 with last action', () => {
    const line = formatSummaryLine2(state)
    assert.ok(line.includes('edit_file'))
    assert.ok(line.includes('middleware.ts'))
    assert.ok(line.includes('✓'))
  })

  it('formats line 2 with failure indicator', () => {
    const failState = { ...state, lastAction: { tool: 'run_tests', target: 'auth.test.ts', success: false } }
    const line = formatSummaryLine2(failState)
    assert.ok(line.includes('✗'))
  })

  it('formats line 3 with risk none as dim', () => {
    const line = formatSummaryLine3(state)
    assert.ok(line.includes('risk: none'))
  })

  it('formats line 3 with high risk', () => {
    const highRisk = { ...state, risk: 'high' as const }
    const line = formatSummaryLine3(highRisk)
    assert.ok(line.includes('risk: high'))
  })

  it('truncates long task names', () => {
    const longTask = { ...state, task: 'a very long task description that exceeds thirty characters limit' }
    const line = formatSummaryLine1(longTask)
    assert.ok(line.length < 120)
  })

  it('handles idle phase with no last action', () => {
    const idle: SummaryState = { task: '', phase: 'idle', stepCount: 0, totalSteps: 0, contextPct: 0.1, elapsedMs: 0, lastAction: null, risk: 'none' }
    const line2 = formatSummaryLine2(idle)
    assert.ok(line2.includes('waiting'))
  })
})
```

- [x] **步骤 2：运行测试验证失败**

运行：`npx tsx --test src/tui/__tests__/summary-bar.test.ts`
预期：FAIL，"Cannot find module '../summary-bar.js'"

- [x] **步骤 3：实现 SummaryBar**

```tsx
// src/tui/summary-bar.tsx
import { Box, Text } from 'ink'
import { memo } from 'react'
import type { Phase } from './phase-tracker.js'
import type { LastAction } from './phase-tracker.js'
import { getTheme } from './theme.js'

export interface SummaryState {
  task: string
  phase: Phase
  stepCount: number
  totalSteps: number
  contextPct: number
  elapsedMs: number
  lastAction: LastAction | null
  risk: 'none' | 'medium' | 'high'
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + '…' : s
}

function formatElapsed(ms: number): string {
  const sec = Math.round(ms / 1000)
  if (sec < 60) return `${sec}s`
  const m = Math.floor(sec / 60)
  const s = sec % 60
  return `${m}m${s > 0 ? `${s}s` : ''}`
}

function contextBar(pct: number, width = 5): string {
  const filled = Math.round(pct * width)
  return '▓'.repeat(filled) + '░'.repeat(width - filled)
}

export function formatSummaryLine1(state: SummaryState): string {
  const task = truncate(state.task || 'working', 30)
  const phase = state.phase
  const steps = state.totalSteps > 0 ? ` (${state.stepCount}/${state.totalSteps})` : ''
  const pct = Math.round(state.contextPct * 100)
  const elapsed = formatElapsed(state.elapsedMs)
  return `◆ ${task} → ${phase}${steps} │ ${contextBar(state.contextPct)} ${pct}% │ ${elapsed}`
}

export function formatSummaryLine2(state: SummaryState): string {
  if (!state.lastAction) return '├ waiting for first action...'
  const icon = state.lastAction.success ? '✓' : '✗'
  const target = truncate(state.lastAction.target.split('/').pop() ?? state.lastAction.target, 30)
  return `├ last: ${state.lastAction.tool} ${target} → ${icon}`
}

export function formatSummaryLine3(state: SummaryState): string {
  return `└ step ${state.stepCount} │ risk: ${state.risk}`
}

export const SummaryBar = memo(function SummaryBar({ state }: { state: SummaryState }) {
  const theme = getTheme()
  const ctxColor = theme.contextColor(state.contextPct)
  const riskColor = state.risk === 'high' ? theme.error : state.risk === 'medium' ? theme.warning : theme.dim

  return (
    <Box flexDirection="column" paddingX={1}>
      <Text color={theme.primary}>
        ◆ <Text bold>{truncate(state.task || 'working', 30)}</Text> → {state.phase}
        {state.totalSteps > 0 && ` (${state.stepCount}/${state.totalSteps})`}
        <Text color={theme.dim}> │ </Text>
        <Text color={ctxColor}>{contextBar(state.contextPct)} {Math.round(state.contextPct * 100)}%</Text>
        <Text color={theme.dim}> │ </Text>
        <Text dimColor>{formatElapsed(state.elapsedMs)}</Text>
      </Text>
      <Text>
        <Text color={theme.dim}>├ </Text>
        {state.lastAction ? (
          <>
            <Text dimColor>last: </Text>
            <Text>{state.lastAction.tool} {truncate(state.lastAction.target.split('/').pop() ?? '', 30)}</Text>
            <Text color={state.lastAction.success ? theme.success : theme.error}> → {state.lastAction.success ? '✓' : '✗'}</Text>
          </>
        ) : (
          <Text dimColor>waiting for first action...</Text>
        )}
      </Text>
      <Text>
        <Text color={theme.dim}>└ </Text>
        <Text dimColor>step {state.stepCount}</Text>
        <Text color={theme.dim}> │ </Text>
        <Text color={riskColor}>risk: {state.risk}</Text>
      </Text>
    </Box>
  )
})
```

- [x] **步骤 4：运行测试验证通过**

运行：`npx tsx --test src/tui/__tests__/summary-bar.test.ts`
预期：PASS

- [x] **步骤 5：Commit**

```bash
git add src/tui/summary-bar.tsx src/tui/__tests__/summary-bar.test.ts
git commit -m "feat(tui): add SummaryBar component with 3-line glanceable display"
```

---

## Phase 3：App 集成 + 工具卡片着色

### 任务 4：集成 SummaryBar 到 App

**文件：**
- 修改：`src/tui/app.tsx`

- [x] **步骤 1：添加 imports 和 state**

在 `src/tui/app.tsx` 顶部添加 imports：

```typescript
import { SummaryBar, type SummaryState } from './summary-bar.js'
import { PhaseTracker } from './phase-tracker.js'
import { getTheme } from './theme.js'
```

在 `App` 函数内添加 state 和 ref：

```typescript
const phaseTracker = useRef(new PhaseTracker())
const [summaryState, setSummaryState] = useState<SummaryState>({
  task: '', phase: 'idle', stepCount: 0, totalSteps: 0,
  contextPct: 0, elapsedMs: 0, lastAction: null, risk: 'none',
})
```

- [x] **步骤 2：在 agent callbacks 中更新 PhaseTracker**

在 `handleSubmit` 中，当用户提交输入时记录 task：

```typescript
// Inside handleSubmit, after slash command routing, before agent.run():
const taskDesc = userInput.length > 30 ? userInput.slice(0, 29) + '…' : userInput
setSummaryState(prev => ({ ...prev, task: taskDesc, phase: 'idle', stepCount: 0, lastAction: null }))
phaseTracker.current = new PhaseTracker()
```

在 agent `onToolUse` callback 中：

```typescript
phaseTracker.current.onToolUse(name)
setSummaryState(prev => ({
  ...prev,
  phase: phaseTracker.current.current(),
  stepCount: phaseTracker.current.stepCount(),
  contextPct: session.getEstimatedTokens() / maxTokens,
  elapsedMs: Date.now() - streamStartRef.current,
}))
```

在 agent `onToolResult` callback 中：

```typescript
const target = typeof input?.path === 'string' ? input.path : typeof input?.command === 'string' ? input.command.slice(0, 30) : name
phaseTracker.current.onToolResult(name, target, !!isError)
const risk = (name === 'bash' && !autoSafeRef.current) ? 'medium' as const : 'none' as const
setSummaryState(prev => ({
  ...prev,
  lastAction: phaseTracker.current.lastAction(),
  risk,
  elapsedMs: Date.now() - streamStartRef.current,
}))
```

在 `onTurnComplete` callback 中：

```typescript
phaseTracker.current.onTurnComplete()
setSummaryState(prev => ({ ...prev, phase: 'idle', elapsedMs: Date.now() - streamStartRef.current }))
```

- [x] **步骤 3：在 JSX 中渲染 SummaryBar**

在 App 的 return JSX 中，在 live area 顶部（`<Static>` 之后，streaming output 之前）添加：

```tsx
{isStreaming && <SummaryBar state={summaryState} />}
```

- [x] **步骤 4：运行 typecheck 验证**

运行：`npx tsc --noEmit`
预期：无错误

- [x] **步骤 5：手动测试**

运行：`npm run build && node dist/main.js`
输入一个多步骤任务（如 "read src/tui/app.tsx and suggest improvements"），验证：
- SummaryBar 在 streaming 时出现在顶部
- 阶段随工具调用变化
- context bar 显示正确百分比
- 最近动作正确更新

- [x] **步骤 6：Commit**

```bash
git add src/tui/app.tsx
git commit -m "feat(tui): integrate SummaryBar and PhaseTracker into App"
```

---

### 任务 5：工具卡片科技风着色

**文件：**
- 修改：`src/tui/tool-card.tsx`

- [x] **步骤 1：添加 theme import 和 border color**

```typescript
// 在 tool-card.tsx 顶部添加
import { getTheme } from './theme.js'
```

修改 `ToolCard` 组件，将 `titleColor` 替换为 theme-based 颜色：

```tsx
export const ToolCard = memo(function ToolCard({ name, result, isError, isStreaming, verbose, rawPath }: ToolCardProps) {
  const theme = getTheme()
  const limit = verbose ? 200 : MAX_COLLAPSED_LINES
  const { displayText, truncated } = useMemo(() => {
    const lines = result.split('\n')
    const isLong = lines.length > limit
    const displayLines = isLong ? lines.slice(0, limit) : lines
    return { displayText: displayLines.join('\n'), truncated: isLong ? lines.length - limit : 0 }
  }, [result, limit])

  const borderColor = isError ? theme.error : theme.toolColor(name)

  return (
    <Box flexDirection="column" paddingX={1} marginBottom={0}>
      <Text bold color={borderColor}>
        ── {name} ──{isStreaming ? ' …' : ''}
        {truncated > 0 && <Text dimColor> {truncated} lines hidden</Text>}
      </Text>
      <Text>{displayText}</Text>
      {truncated > 0 && (
        <Text dimColor>  use /verbose to expand{rawPath ? ` · raw: ${compactPath(rawPath)}` : ''}</Text>
      )}
      {truncated === 0 && rawPath && (
        <Text dimColor>  raw: {compactPath(rawPath)}</Text>
      )}
    </Box>
  )
})
```

- [x] **步骤 2：运行 typecheck**

运行：`npx tsc --noEmit`
预期：无错误

- [x] **步骤 3：Commit**

```bash
git add src/tui/tool-card.tsx
git commit -m "feat(tui): apply theme-based tool card coloring by tool type"
```

---

### 任务 6：StatusBar 使用 theme + gradient banner

**文件：**
- 修改：`src/tui/status-bar.tsx`
- 修改：`src/tui/app.tsx`
- 修改：`package.json`

- [x] **步骤 1：安装 gradient-string**

运行：`npm install gradient-string@2.0.2`

- [x] **步骤 2：添加 gradient-string 类型声明**

在 `src/tui/` 中不需要额外类型文件，gradient-string 有内置类型。如果没有，在 `tsconfig.json` 中确认 `"moduleResolution": "bundler"` 已设置。

- [x] **步骤 3：修改 StatusBar 使用 theme**

```typescript
// src/tui/status-bar.tsx
import { Box, Text } from 'ink'
import { memo } from 'react'
import { getTheme } from './theme.js'

interface StatusBarProps {
  model: string
  cacheHitRate: number
  totalCost: string
  currentTokens: number
  maxTokens: number
}

function tokenBar(current: number, max: number, width = 10): string {
  const filled = Math.min(Math.round((current / max) * width), width)
  return '▓'.repeat(filled) + '░'.repeat(width - filled)
}

export const StatusBar = memo(function StatusBar({ model, cacheHitRate, totalCost, currentTokens, maxTokens }: StatusBarProps) {
  const theme = getTheme()
  const hitPct = (cacheHitRate * 100).toFixed(1)
  const usagePct = ((currentTokens / maxTokens) * 100).toFixed(0)
  const bar = tokenBar(currentTokens, maxTokens)
  const usageColor = theme.contextColor(currentTokens / maxTokens)
  const cacheColor = cacheHitRate === 0 ? theme.dim : cacheHitRate >= 0.8 ? theme.success : cacheHitRate >= 0.4 ? theme.warning : theme.error

  return (
    <Box flexDirection="row" justifyContent="space-between" paddingX={1} borderStyle="round" borderColor={theme.dim}>
      <Box gap={1}>
        <Text bold color={theme.primary}>{model}</Text>
        <Text color={cacheColor}>cache:{hitPct}%</Text>
        <Text dimColor>¥{totalCost}</Text>
      </Box>
      <Box gap={1}>
        <Text color={usageColor}>{bar}</Text>
        <Text dimColor>{currentTokens.toLocaleString()}/{maxTokens.toLocaleString()} ({usagePct}%)</Text>
      </Box>
    </Box>
  )
})
```

- [x] **步骤 4：添加 gradient startup banner**

在 `src/tui/app.tsx` 中，在 App 组件的初始 `staticItems` 中添加启动 banner：

```typescript
import gradient from 'gradient-string'

// 在 App 组件内，staticItems 初始化后添加 startup banner
useEffect(() => {
  const rivetGradient = gradient(['#00ffcc', '#7b2fff'])
  const banner = rivetGradient('◆ R I V E T')
  pushStatic(createLogEntry({ type: 'text', content: banner }))
}, []) // eslint-disable-line react-hooks/exhaustive-deps
```

- [x] **步骤 5：运行 typecheck + build**

运行：`npx tsc --noEmit && npm run build`
预期：无错误

- [x] **步骤 6：手动测试**

运行：`node dist/main.js`
验证：
- 启动时显示渐变色 "◆ R I V E T" banner
- StatusBar 使用圆角边框 (`borderStyle="round"`)
- StatusBar 颜色使用 theme 配色
- 在 tmux 中测试：`tmux new-session -d 'node dist/main.js' && tmux attach`，验证 256-color 降级正常

- [x] **步骤 7：Commit**

```bash
git add package.json package-lock.json src/tui/status-bar.tsx src/tui/app.tsx
git commit -m "feat(tui): sci-fi visual layer with gradient banner, round borders, theme colors"
```

---

## Phase 4：阈值警告 + Context 事件通知

### 任务 7：Context 阈值警告

**文件：**
- 修改：`src/tui/summary-bar.tsx`
- 修改：`src/tui/app.tsx`

- [x] **步骤 1：扩展 SummaryState 支持 compact 事件**

在 `summary-bar.tsx` 的 `SummaryState` 接口中添加：

```typescript
export interface SummaryState {
  task: string
  phase: Phase
  stepCount: number
  totalSteps: number
  contextPct: number
  elapsedMs: number
  lastAction: LastAction | null
  risk: 'none' | 'medium' | 'high'
  compactEvent?: { beforeTokens: number; afterTokens: number } | null
  approvalNeeded?: { tool: string; target: string } | null
}
```

- [x] **步骤 2：修改 SummaryBar 第 3 行显示阈值事件**

在 `SummaryBar` 组件中，第 3 行优先显示 compact 事件或 approval 需求：

```tsx
<Text>
  <Text color={theme.dim}>└ </Text>
  {state.approvalNeeded ? (
    <Text bold color={theme.error}>⚠ APPROVAL: {state.approvalNeeded.tool} {truncate(state.approvalNeeded.target, 25)}</Text>
  ) : state.compactEvent ? (
    <Text color={theme.warning}>⚡ compact: {Math.round(state.compactEvent.beforeTokens / 1000)}k→{Math.round(state.compactEvent.afterTokens / 1000)}k</Text>
  ) : (
    <>
      <Text dimColor>step {state.stepCount}</Text>
      <Text color={theme.dim}> │ </Text>
      <Text color={riskColor}>risk: {state.risk}</Text>
    </>
  )}
</Text>
```

- [x] **步骤 3：在 App 中连接 compact 和 approval 事件**

在 `onApprovalRequired` callback 中：

```typescript
setSummaryState(prev => ({ ...prev, approvalNeeded: { tool: name, target: String(input?.path ?? input?.command ?? name) } }))
```

在 approval 解决后清除：

```typescript
setSummaryState(prev => ({ ...prev, approvalNeeded: null }))
```

在 compact 发生后（`/compact` 命令或 auto-compact）：

```typescript
setSummaryState(prev => ({ ...prev, compactEvent: { beforeTokens: estimateTokens(msgs), afterTokens: estimateTokens(compacted) } }))
setTimeout(() => setSummaryState(prev => ({ ...prev, compactEvent: null })), 5000)
```

- [x] **步骤 4：运行 typecheck**

运行：`npx tsc --noEmit`
预期：无错误

- [x] **步骤 5：Commit**

```bash
git add src/tui/summary-bar.tsx src/tui/app.tsx
git commit -m "feat(tui): add context threshold warnings and compact event display"
```

---

## Phase 5：`/cockpit` 展开面板

### 任务 8：Cockpit 展开命令

**文件：**
- 修改：`src/tui/app.tsx`

- [x] **步骤 1：添加 cockpit 状态**

```typescript
const [cockpitExpanded, setCockpitExpanded] = useState(false)
```

- [x] **步骤 2：添加 `/cockpit` 命令路由**

在 slash command switch 中添加：

```typescript
case '/cockpit': {
  setCockpitExpanded(prev => !prev)
  if (!cockpitExpanded) {
    pushStatic(createLogEntry({ type: 'text', content: 'Cockpit panel expanded. Type /cockpit again to collapse.' }))
  }
  setIsStreaming(false)
  return
}
```

- [x] **步骤 3：渲染展开面板**

在 JSX 中，当 `cockpitExpanded` 为 true 时替换 SummaryBar 为详细面板：

```tsx
{isStreaming && !cockpitExpanded && <SummaryBar state={summaryState} />}
{cockpitExpanded && (
  <Box flexDirection="column" paddingX={1} borderStyle="round" borderColor={getTheme().primary}>
    <Text color={getTheme().primary} bold>─── COCKPIT ───</Text>
    <Text>Phase: <Text bold>{summaryState.phase}</Text> ({summaryState.stepCount} steps) │ Context: <Text color={getTheme().contextColor(summaryState.contextPct)}>{contextBar(summaryState.contextPct)} {Math.round(summaryState.contextPct * 100)}%</Text> │ {formatElapsed(summaryState.elapsedMs)}</Text>
    <Text>Cache: <Text color={getTheme().success}>{(cacheHitRate * 100).toFixed(1)}%</Text> │ Cost: <Text dimColor>¥{cost.toFixed(4)}</Text> │ Turns: {session.getTurnCount()}</Text>
    <Text>Last: {summaryState.lastAction ? `${summaryState.lastAction.tool} ${summaryState.lastAction.target} → ${summaryState.lastAction.success ? '✓' : '✗'}` : 'none'}</Text>
    <Text>Risk: <Text color={summaryState.risk === 'high' ? getTheme().error : getTheme().dim}>{summaryState.risk}</Text></Text>
  </Box>
)}
```

- [x] **步骤 4：更新 /help 命令**

在 `/help` 输出中添加：

```
/cockpit — Toggle expanded cockpit panel
```

- [x] **步骤 5：运行 typecheck + build**

运行：`npx tsc --noEmit && npm run build`
预期：无错误

- [x] **步骤 6：Commit**

```bash
git add src/tui/app.tsx
git commit -m "feat(tui): add /cockpit command for expanded status panel"
```

---

## 自检

### 规格覆盖度

| 设计规格需求 | 对应任务 |
|-------------|---------|
| Theme 配色系统 (truecolor + 256 fallback) | 任务 1 |
| PhaseTracker 状态机 | 任务 2 |
| SummaryBar 3 行摘要区 | 任务 3 |
| App 集成 (数据流连接) | 任务 4 |
| 工具卡片按类型着色 | 任务 5 |
| StatusBar theme 化 + gradient banner | 任务 6 |
| 阈值警告 (context/compact/approval) | 任务 7 |
| `/cockpit` 展开面板 | 任务 8 |

### 占位符扫描

无 TODO、待定、"后续实现"。所有步骤包含完整代码。

### 类型一致性

- `SummaryState` 在任务 3 定义，任务 4/7 使用同一接口
- `PhaseTracker` 在任务 2 定义，任务 4 通过 ref 使用
- `getTheme()` 在任务 1 定义，任务 3/5/6/8 使用
- `Phase` 类型在任务 2 导出，任务 3 import
- `LastAction` 类型在任务 2 导出，任务 3 import

---

## 实施记录

**状态：已完成** (2026-05-16)

**Commits:**
- `e7594bd` — feat(tui): theme module, PhaseTracker, SummaryBar 组件 + 25 tests
- `ee5fe17` — feat(tui): 集成 SummaryBar + PhaseTracker 到 App, tool-card 着色, gradient banner, /cockpit
- `7859377` — fix(tui): code review 修复 — 10 issues (2 HIGH, 5 MEDIUM, 3 LOW)

**偏离设计的地方：**
- PhaseTracker 增加了 `delegating` 和 `running` 阶段（设计文档只有 planning/coding/testing/verifying）
- `onToolResult` 不再接收 target 参数，改为从 `onToolUse` 的 input 提取并存入 PhaseTracker 内部
- `/cockpit` 使用 ref + state 双模式避免 handleSubmit 的 stale closure 问题
- gradient-string 需要手写类型声明（`src/types/gradient-string.d.ts`）

**Code Review 修复：**
- H1: /cockpit stale closure → cockpitExpandedRef
- H2: getTheme() 重复调用 → 渲染时单次调用存变量
- M1-M5: handleSubmit deps, contextPct clamp, theme dedup, tool target extraction, module verification
- L1-L3: gradient types, PhaseTracker default:break, slash command extraction
