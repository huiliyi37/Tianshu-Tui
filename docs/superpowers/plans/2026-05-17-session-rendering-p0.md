# 会话渲染 P0 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 将 Rivet 会话 UI 从扁平 4 类型渲染升级为角色分离 + 工具折叠的分层渲染体系

**架构：** 扩展 LogEntry 类型系统（新增 user_message/assistant_message/system/tool_group），建立 ToolFamily 分类体系，在渲染时对连续工具调用做分组折叠。纯函数分组逻辑 + 独立 UI 组件，不修改 agent 核心循环。

**技术栈：** TypeScript, React (Ink 6), node:test + node:assert/strict

---

## 文件结构

### 新建文件（职责锁定）

| 文件 | 职责 |
|------|------|
| `src/tui/tool-family.ts` | 工具分类定义：5 种 ToolFamily + glyph/verb 映射 + getToolFamily() |
| `src/tui/user-message.tsx` | 用户消息渲染组件：`❯` 前缀 + mint 色 |
| `src/tui/system-message.tsx` | 系统消息渲染组件：`⌁` 前缀 + dim 色 + error/warning/info 分级 |
| `src/tui/tool-group.tsx` | 工具折叠组组件：折叠摘要行 + 展开后带 `╭│╰` rail 的 ToolCard 列表 |
| `src/tui/group-logs.ts` | 渲染时分组逻辑：将连续 >= 3 个 tool 条目合并为 tool_group |
| `src/tui/__tests__/tool-family.test.ts` | getToolFamily、getGroupSummary 测试 |
| `src/tui/__tests__/group-logs.test.ts` | groupLogs 分组逻辑测试 |
| `src/tui/__tests__/user-message.test.ts` | UserMessage 组件测试 |
| `src/tui/__tests__/system-message.test.ts` | SystemMessage 组件测试 |
| `src/tui/__tests__/tool-group.test.ts` | ToolGroup 组件测试 |

### 修改文件

| 文件 | 变更范围 |
|------|---------|
| `src/tui/log-state.ts` | LogEntry.type 联合类型扩展 + turnNumber/children 字段 |
| `src/tui/theme.ts` | 新增 userColor / assistantColor / systemColor |
| `src/tui/app.tsx` | handleSubmit 用 user_message、onTurnComplete 用 assistant_message、renderStaticEntry 新分支、Static 区域加 groupLogs |
| `src/tui/tool-card.tsx` | 头部用 ToolFamily glyph 替代纯文本 name |
| `src/tui/history-replay.ts` | 消息类型映射更新 |
| `src/tui/__tests__/log-state.test.ts` | 新类型 + turnNumber 测试 |
| `src/tui/__tests__/history-replay.test.ts` | 更新 replay 测试 |

---

### 任务 1：LogEntry 类型扩展

**文件：**
- 修改：`src/tui/log-state.ts`（全文）
- 测试：`src/tui/__tests__/log-state.test.ts`

- [ ] **步骤 1：编写失败的测试**

在 `src/tui/__tests__/log-state.test.ts` 追加：

```typescript
describe('LogEntry extended types', () => {
  it('creates user_message entry', () => {
    const entry = createLogEntry({ type: 'user_message', content: 'hello', turnNumber: 1 })
    assert.equal(entry.type, 'user_message')
    assert.equal(entry.content, 'hello')
    assert.equal(entry.turnNumber, 1)
    assert.ok(entry.id.startsWith('l'))
  })

  it('creates assistant_message entry', () => {
    const entry = createLogEntry({ type: 'assistant_message', content: 'response', turnNumber: 1 })
    assert.equal(entry.type, 'assistant_message')
    assert.equal(entry.turnNumber, 1)
  })

  it('creates system entry with isError flag', () => {
    const entry = createLogEntry({ type: 'system', content: 'Error: timeout', isError: true })
    assert.equal(entry.type, 'system')
    assert.equal(entry.isError, true)
  })

  it('creates tool_group entry with children', () => {
    const children = [
      createLogEntry({ type: 'tool', content: 'ok', toolName: 'read_file' }),
      createLogEntry({ type: 'tool', content: 'ok', toolName: 'grep' }),
    ]
    const group = createLogEntry({ type: 'tool_group', content: '', children, turnNumber: 2 })
    assert.equal(group.type, 'tool_group')
    assert.equal(group.children!.length, 2)
    assert.equal(group.turnNumber, 2)
  })

  it('createLogEntry accepts turnNumber and children', () => {
    const entry = createLogEntry({
      type: 'tool',
      content: 'test',
      turnNumber: 5,
      children: [],
    })
    assert.equal(entry.turnNumber, 5)
    assert.deepEqual(entry.children, [])
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npx tsx --test src/tui/__tests__/log-state.test.ts`
预期：FAIL — TypeScript 报错 `'user_message'` 不是有效的 `LogEntry['type']`

- [ ] **步骤 3：实现 LogEntry 类型扩展**

修改 `src/tui/log-state.ts` 全文：

```typescript
export type LogEntryType =
  | 'user_message'
  | 'assistant_message'
  | 'tool'
  | 'tool_group'
  | 'checkpoint'
  | 'evidence'
  | 'system'

export interface LogEntry {
  type: LogEntryType
  id: string
  content: string
  toolName?: string
  isError?: boolean
  rawPath?: string
  turnNumber?: number
  children?: LogEntry[]
}

let _nextLogId = 0

const MAX_LOG_STORE = 200

export function createLogEntry(entry: {
  id?: string
  type: LogEntryType
  content: string
  toolName?: string
  isError?: boolean
  rawPath?: string
  turnNumber?: number
  children?: LogEntry[]
}): LogEntry {
  return { ...entry, id: entry.id ?? `l${_nextLogId++}` }
}

export function appendLogInPlace(logs: LogEntry[], entry: LogEntry): void {
  logs.push(entry)
  if (logs.length > MAX_LOG_STORE) {
    logs.splice(0, logs.length - MAX_LOG_STORE + 50)
  }
}

export function visibleLogs(logs: LogEntry[], maxVisible: number): LogEntry[] {
  return logs.slice(-maxVisible)
}

export function updateToolLog(
  logs: LogEntry[],
  id: string,
  toolName: string,
  content: string,
  isError?: boolean,
  rawPath?: string,
): LogEntry[] {
  let idx = -1
  for (let i = logs.length - 1; i >= 0; i--) {
    const entry = logs[i]
    if (entry?.type === 'tool' && entry?.id === id) {
      idx = i
      break
    }
  }
  if (idx === -1) {
    return [...logs, { type: 'tool' as const, id, toolName, content, isError, rawPath }]
  }

  const existing = logs[idx]!
  if (existing.content === content && existing.isError === isError && existing.rawPath === rawPath) {
    return logs
  }

  return logs.map((entry, index) => {
    if (index !== idx) return entry
    return { type: 'tool' as const, id, toolName: entry.toolName ?? toolName, content, isError: isError ?? entry.isError, rawPath: rawPath ?? entry.rawPath }
  })
}

export function summarizeToolOutput(output: string, maxLines: number): string {
  const lines = output.split('\n')
  if (lines.length <= maxLines) return output

  const headCount = Math.ceil(maxLines / 2)
  const tailCount = Math.floor(maxLines / 2)
  const head = lines.slice(0, headCount)
  const tail = lines.slice(-tailCount)
  const omitted = lines.length - head.length - tail.length
  return [...head, `... ${omitted} lines omitted ...`, ...tail].join('\n')
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`npx tsx --test src/tui/__tests__/log-state.test.ts`
预期：PASS — 所有 describe 块通过

- [ ] **步骤 5：Commit**

```bash
git add src/tui/log-state.ts src/tui/__tests__/log-state.test.ts
git commit -m "feat(tui): extend LogEntry types — user_message, assistant_message, system, tool_group"
```

---

### 任务 2：ToolFamily 分类体系

**文件：**
- 创建：`src/tui/tool-family.ts`
- 测试：`src/tui/__tests__/tool-family.test.ts`

- [ ] **步骤 1：编写失败的测试**

`src/tui/__tests__/tool-family.test.ts`：

```typescript
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { getToolFamily, getGroupSummary } from '../tool-family.js'

describe('ToolFamily', () => {
  it('classifies read_file as read family', () => {
    const f = getToolFamily('read_file')
    assert.equal(f.family, 'read')
    assert.equal(f.glyph, '▷')
    assert.equal(f.verb, 'read')
  })

  it('classifies grep as find family', () => {
    const f = getToolFamily('grep')
    assert.equal(f.family, 'find')
    assert.equal(f.glyph, '⌕')
  })

  it('classifies bash as run family', () => {
    const f = getToolFamily('bash')
    assert.equal(f.family, 'run')
    assert.equal(f.glyph, '▶')
  })

  it('classifies edit_file as write family', () => {
    const f = getToolFamily('edit_file')
    assert.equal(f.family, 'write')
    assert.equal(f.glyph, '◆')
  })

  it('classifies unknown tool as other', () => {
    const f = getToolFamily('custom_mcp_tool')
    assert.equal(f.family, 'other')
    assert.equal(f.glyph, '•')
    assert.equal(f.verb, 'tool')
  })

  it('getGroupSummary summarizes multiple tools', () => {
    const summary = getGroupSummary([
      { type: 'tool', id: 'a', content: '', toolName: 'read_file' },
      { type: 'tool', id: 'b', content: '', toolName: 'read_file' },
      { type: 'tool', id: 'c', content: '', toolName: 'grep' },
      { type: 'tool', id: 'd', content: '', toolName: 'bash' },
    ] as any)
    assert.equal(summary, '4 tool calls: read_file x2, grep x1, bash x1')
  })

  it('getGroupSummary with single tool', () => {
    const summary = getGroupSummary([
      { type: 'tool', id: 'a', content: '', toolName: 'edit_file' },
    ] as any)
    assert.equal(summary, '1 tool call: edit_file x1')
  })

  it('getGroupSummary with tools without name', () => {
    const summary = getGroupSummary([
      { type: 'tool', id: 'a', content: '' },
      { type: 'tool', id: 'b', content: '' },
    ] as any)
    assert.equal(summary, '2 tool calls: unknown x2')
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npx tsx --test src/tui/__tests__/tool-family.test.ts`
预期：FAIL — Cannot resolve `../tool-family.js`

- [ ] **步骤 3：实现 ToolFamily**

`src/tui/tool-family.ts`：

```typescript
export type ToolFamily = 'read' | 'write' | 'run' | 'find' | 'other'

export interface ToolFamilyInfo {
  family: ToolFamily
  glyph: string
  verb: string
}

const TOOL_MAP: Record<string, ToolFamilyInfo> = {
  read_file:       { family: 'read',  glyph: '▷', verb: 'read'     },
  glob:            { family: 'find',  glyph: '⌕', verb: 'find'     },
  grep:            { family: 'find',  glyph: '⌕', verb: 'search'   },
  bash:            { family: 'run',   glyph: '▶', verb: 'run'      },
  edit_file:       { family: 'write', glyph: '◆', verb: 'patch'    },
  write_file:      { family: 'write', glyph: '◆', verb: 'write'    },
  run_tests:       { family: 'run',   glyph: '▶', verb: 'test'     },
  delegate_task:   { family: 'run',   glyph: '▶', verb: 'delegate' },
  delegate_batch:  { family: 'run',   glyph: '▶', verb: 'batch'    },
  git:             { family: 'run',   glyph: '▶', verb: 'git'      },
  undo:            { family: 'write', glyph: '◆', verb: 'undo'     },
  web_fetch:       { family: 'read',  glyph: '▷', verb: 'fetch'    },
  inspect_project: { family: 'find',  glyph: '⌕', verb: 'inspect'  },
  repo_map:        { family: 'find',  glyph: '⌕', verb: 'map'      },
  todo:            { family: 'other', glyph: '•', verb: 'todo'     },
  recall:          { family: 'find',  glyph: '⌕', verb: 'recall'   },
}

const DEFAULT: ToolFamilyInfo = { family: 'other', glyph: '•', verb: 'tool' }

export function getToolFamily(toolName: string): ToolFamilyInfo {
  return TOOL_MAP[toolName] ?? DEFAULT
}

export function getGroupSummary(tools: ReadonlyArray<{ toolName?: string }>): string {
  const counts = new Map<string, number>()
  for (const t of tools) {
    const name = t.toolName ?? 'unknown'
    counts.set(name, (counts.get(name) ?? 0) + 1)
  }
  const parts = [...counts.entries()].map(([name, count]) => `${name} x${count}`)
  const total = tools.length
  const label = total === 1 ? 'tool call' : 'tool calls'
  return `${total} ${label}: ${parts.join(', ')}`
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`npx tsx --test src/tui/__tests__/tool-family.test.ts`
预期：PASS

- [ ] **步骤 5：Commit**

```bash
git add src/tui/tool-family.ts src/tui/__tests__/tool-family.test.ts
git commit -m "feat(tui): add ToolFamily classification with glyph/verb mapping"
```

---

### 任务 3：渲染时分组逻辑

**文件：**
- 创建：`src/tui/group-logs.ts`
- 测试：`src/tui/__tests__/group-logs.test.ts`

- [ ] **步骤 1：编写失败的测试**

`src/tui/__tests__/group-logs.test.ts`：

```typescript
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { groupLogs } from '../group-logs.js'
import { createLogEntry, type LogEntry } from '../log-state.js'

describe('groupLogs', () => {
  it('returns items unchanged when fewer than 3 consecutive tools', () => {
    const items = [
      createLogEntry({ type: 'user_message', content: 'hi', turnNumber: 1 }),
      createLogEntry({ type: 'tool', content: 'ok', toolName: 'read_file', turnNumber: 1 }),
      createLogEntry({ type: 'tool', content: 'ok', toolName: 'grep', turnNumber: 1 }),
      createLogEntry({ type: 'assistant_message', content: 'done', turnNumber: 1 }),
    ]
    const result = groupLogs(items)
    assert.equal(result.length, 4)
  })

  it('groups 3+ consecutive tool entries into tool_group', () => {
    const items = [
      createLogEntry({ type: 'user_message', content: 'hi', turnNumber: 1 }),
      createLogEntry({ type: 'tool', content: 'a', toolName: 'read_file', turnNumber: 1 }),
      createLogEntry({ type: 'tool', content: 'b', toolName: 'read_file', turnNumber: 1 }),
      createLogEntry({ type: 'tool', content: 'c', toolName: 'grep', turnNumber: 1 }),
      createLogEntry({ type: 'assistant_message', content: 'done', turnNumber: 1 }),
    ]
    const result = groupLogs(items)
    assert.equal(result.length, 3) // user_message + tool_group + assistant_message
    assert.equal(result[1]!.type, 'tool_group')
    assert.equal(result[1]!.children!.length, 3)
  })

  it('does not group tools from different turns', () => {
    const items = [
      createLogEntry({ type: 'tool', content: 'a', toolName: 'read_file', turnNumber: 1 }),
      createLogEntry({ type: 'tool', content: 'b', toolName: 'read_file', turnNumber: 1 }),
      createLogEntry({ type: 'assistant_message', content: 'done', turnNumber: 1 }),
      createLogEntry({ type: 'tool', content: 'c', toolName: 'grep', turnNumber: 2 }),
      createLogEntry({ type: 'tool', content: 'd', toolName: 'grep', turnNumber: 2 }),
      createLogEntry({ type: 'tool', content: 'e', toolName: 'read_file', turnNumber: 2 }),
    ]
    const result = groupLogs(items)
    // turn 1: 2 tools (no group) + 1 msg = 3 items
    // turn 2: 3 tools (grouped) = 1 item
    assert.equal(result.length, 4)
    assert.equal(result[3]!.type, 'tool_group')
  })

  it('handles empty input', () => {
    assert.deepEqual(groupLogs([]), [])
  })

  it('handles all non-tool items', () => {
    const items = [
      createLogEntry({ type: 'user_message', content: 'a' }),
      createLogEntry({ type: 'assistant_message', content: 'b' }),
      createLogEntry({ type: 'system', content: 'c' }),
    ]
    assert.deepEqual(groupLogs(items), items)
  })

  it('groups tools at end of list', () => {
    const items = [
      createLogEntry({ type: 'user_message', content: 'hi', turnNumber: 1 }),
      createLogEntry({ type: 'tool', content: 'a', toolName: 'read_file', turnNumber: 1 }),
      createLogEntry({ type: 'tool', content: 'b', toolName: 'read_file', turnNumber: 1 }),
      createLogEntry({ type: 'tool', content: 'c', toolName: 'read_file', turnNumber: 1 }),
    ]
    const result = groupLogs(items)
    assert.equal(result.length, 2)
    assert.equal(result[1]!.type, 'tool_group')
  })

  it('does not group tools without turnNumber mixed with same-turn tools', () => {
    const items = [
      createLogEntry({ type: 'tool', content: 'a', toolName: 'read_file' }),
      createLogEntry({ type: 'tool', content: 'b', toolName: 'read_file' }),
      createLogEntry({ type: 'tool', content: 'c', toolName: 'read_file' }),
    ]
    const result = groupLogs(items)
    // No turnNumber — still consecutive, still >= 3, still group
    assert.equal(result.length, 1)
    assert.equal(result[0]!.type, 'tool_group')
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npx tsx --test src/tui/__tests__/group-logs.test.ts`
预期：FAIL — Cannot resolve `../group-logs.js`

- [ ] **步骤 3：实现 groupLogs**

`src/tui/group-logs.ts`：

```typescript
import { createLogEntry, type LogEntry } from './log-state.js'
import { getGroupSummary } from './tool-family.js'

const GROUP_THRESHOLD = 3

export function groupLogs(items: readonly LogEntry[]): LogEntry[] {
  const result: LogEntry[] = []
  let toolRun: LogEntry[] = []

  const flushToolRun = () => {
    if (toolRun.length >= GROUP_THRESHOLD) {
      result.push(createLogEntry({
        type: 'tool_group',
        content: getGroupSummary(toolRun),
        children: [...toolRun],
        turnNumber: toolRun[0]!.turnNumber,
      }))
    } else {
      result.push(...toolRun)
    }
    toolRun = []
  }

  for (const item of items) {
    if (item.type === 'tool') {
      toolRun.push(item)
    } else {
      flushToolRun()
      result.push(item)
    }
  }
  flushToolRun()

  return result
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`npx tsx --test src/tui/__tests__/group-logs.test.ts`
预期：PASS

- [ ] **步骤 5：Commit**

```bash
git add src/tui/group-logs.ts src/tui/__tests__/group-logs.test.ts
git commit -m "feat(tui): add render-time tool grouping logic (>= 3 consecutive tools)"
```

---

### 任务 4：Theme 扩展 + UserMessage / SystemMessage 组件

**文件：**
- 修改：`src/tui/theme.ts`
- 创建：`src/tui/user-message.tsx`
- 创建：`src/tui/system-message.tsx`
- 测试：`src/tui/__tests__/user-message.test.ts`
- 测试：`src/tui/__tests__/system-message.test.ts`

- [ ] **步骤 1：扩展 theme.ts 颜色**

在 `src/tui/theme.ts` 的 `RivetTheme` 接口新增：

```typescript
export interface RivetTheme {
  primary: string
  secondary: string
  success: string
  warning: string
  error: string
  dim: string
  userColor: string      // NEW
  assistantColor: string // NEW
  systemColor: string    // NEW
  toolColor: (toolName: string) => string
  contextColor: (pct: number) => string
}
```

在 `buildTheme` 函数中新增映射：

```typescript
function buildTheme(colors: ColorSet): RivetTheme {
  return {
    ...colors,
    userColor: colors.primary,       // mint green for user
    assistantColor: colors.secondary, // lavender for assistant
    systemColor: colors.dim,          // dim gray for system
    toolColor: makeToolColor(colors),
    contextColor: makeContextColor(colors),
  }
}
```

- [ ] **步骤 2：编写 UserMessage 组件**

`src/tui/user-message.tsx`：

```typescript
import { Box, Text } from 'ink'
import { memo } from 'react'
import { getTheme } from './theme.js'

interface UserMessageProps {
  content: string
}

export const UserMessage = memo(function UserMessage({ content }: UserMessageProps) {
  const theme = getTheme()
  return (
    <Box flexDirection="column" paddingX={1}>
      <Box flexDirection="row" gap={1}>
        <Text color={theme.userColor} bold>{'❯'}</Text>
        <Text>{content}</Text>
      </Box>
    </Box>
  )
})
```

- [ ] **步骤 3：编写 SystemMessage 组件**

`src/tui/system-message.tsx`：

```typescript
import { Box, Text } from 'ink'
import { memo } from 'react'
import { getTheme } from './theme.js'

interface SystemMessageProps {
  content: string
  isError?: boolean
}

export const SystemMessage = memo(function SystemMessage({ content, isError }: SystemMessageProps) {
  const theme = getTheme()
  const color = isError ? theme.error : theme.systemColor
  return (
    <Box paddingX={2}>
      <Text color={color} dimColor={!isError}>{isError ? '⌁' : '⌁'} {content}</Text>
    </Box>
  )
})
```

- [ ] **步骤 4：编写 UserMessage 测试**

`src/tui/__tests__/user-message.test.ts`：

```typescript
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { renderToString } from 'ink-testing-library'
import { UserMessage } from '../user-message.js'

describe('UserMessage', () => {
  it('renders content with arrow prefix', () => {
    const output = renderToString(<UserMessage content="hello world" />)
    assert.ok(output.includes('hello world'))
  })

  it('renders empty content without crash', () => {
    const output = renderToString(<UserMessage content="" />)
    assert.ok(typeof output === 'string')
  })
})
```

- [ ] **步骤 5：编写 SystemMessage 测试**

`src/tui/__tests__/system-message.test.ts`：

```typescript
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { renderToString } from 'ink-testing-library'
import { SystemMessage } from '../system-message.js'

describe('SystemMessage', () => {
  it('renders content with prefix', () => {
    const output = renderToString(<SystemMessage content="saved" />)
    assert.ok(output.includes('saved'))
  })

  it('renders error message', () => {
    const output = renderToString(<SystemMessage content="timeout" isError />)
    assert.ok(output.includes('timeout'))
  })
})
```

- [ ] **步骤 6：运行测试验证通过**

运行：`npx tsx --test src/tui/__tests__/user-message.test.ts src/tui/__tests__/system-message.test.ts`
预期：PASS

- [ ] **步骤 7：运行全量 typecheck**

运行：`npm run typecheck`
预期：PASS — 无新增类型错误

- [ ] **步骤 8：Commit**

```bash
git add src/tui/theme.ts src/tui/user-message.tsx src/tui/system-message.tsx src/tui/__tests__/user-message.test.ts src/tui/__tests__/system-message.test.ts
git commit -m "feat(tui): add UserMessage and SystemMessage components + theme colors"
```

---

### 任务 5：ToolGroup 折叠组件

**文件：**
- 创建：`src/tui/tool-group.tsx`
- 测试：`src/tui/__tests__/tool-group.test.ts`

- [ ] **步骤 1：编写失败的测试**

`src/tui/__tests__/tool-group.test.ts`：

```typescript
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { renderToString } from 'ink-testing-library'
import { ToolGroup } from '../tool-group.js'
import { createLogEntry } from '../log-state.js'
import type { LogEntry } from '../log-state.js'

describe('ToolGroup', () => {
  const makeTools = (names: string[]): LogEntry[] =>
    names.map((n, i) => createLogEntry({ type: 'tool', id: `t${i}`, content: `${n} output`, toolName: n }))

  it('renders collapsed summary by default', () => {
    const tools = makeTools(['read_file', 'read_file', 'grep'])
    const output = renderToString(<ToolGroup tools={tools} verbose={false} />)
    assert.ok(output.includes('3 tool calls'))
  })

  it('renders expanded tools in verbose mode', () => {
    const tools = makeTools(['read_file', 'bash'])
    const output = renderToString(<ToolGroup tools={tools} verbose={true} />)
    assert.ok(output.includes('read_file'))
    assert.ok(output.includes('bash'))
  })

  it('renders empty group without crash', () => {
    const output = renderToString(<ToolGroup tools={[]} verbose={false} />)
    assert.ok(typeof output === 'string')
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npx tsx --test src/tui/__tests__/tool-group.test.ts`
预期：FAIL — Cannot resolve `../tool-group.js`

- [ ] **步骤 3：实现 ToolGroup 组件**

`src/tui/tool-group.tsx`：

```typescript
import { Box, Text } from 'ink'
import { memo, useState, useInput } from 'react'
import { ToolCard } from './tool-card.js'
import { getGroupSummary } from './tool-family.js'
import { getTheme } from './theme.js'
import type { LogEntry } from './log-state.js'

interface ToolGroupProps {
  tools: LogEntry[]
  verbose: boolean
}

export const ToolGroup = memo(function ToolGroup({ tools, verbose: initialVerbose }: ToolGroupProps) {
  const theme = getTheme()
  const [expanded, setExpanded] = useState(initialVerbose)
  const summary = getGroupSummary(tools)

  useInput((_input, key) => {
    if (key.return) {
      setExpanded(v => !v)
    }
  })

  if (tools.length === 0) return null

  if (!expanded) {
    return (
      <Box paddingX={1} flexDirection="column">
        <Text color={theme.dim}>{'▸'} {summary} <Text italic>— Enter to expand</Text></Text>
      </Box>
    )
  }

  return (
    <Box flexDirection="column">
      <Box paddingX={1}>
        <Text color={theme.dim}>{'▾'} {summary} <Text italic>— Enter to collapse</Text></Text>
      </Box>
      {tools.map(tool => (
        <ToolCard
          key={tool.id}
          name={tool.toolName ?? ''}
          result={tool.content}
          isError={tool.isError}
          verbose={initialVerbose}
          rawPath={tool.rawPath}
        />
      ))}
    </Box>
  )
})
```

- [ ] **步骤 4：运行测试验证通过**

运行：`npx tsx --test src/tui/__tests__/tool-group.test.ts`
预期：PASS

- [ ] **步骤 5：Commit**

```bash
git add src/tui/tool-group.tsx src/tui/__tests__/tool-group.test.ts
git commit -m "feat(tui): add ToolGroup collapsible component with summary line"
```

---

### 任务 6：ToolCard 集成 ToolFamily glyph

**文件：**
- 修改：`src/tui/tool-card.tsx`

- [ ] **步骤 1：修改 ToolCard 头部**

在 `src/tui/tool-card.tsx` 中：

1. 添加 import：
```typescript
import { getToolFamily } from './tool-family.js'
```

2. 在组件内部，修改头部渲染部分。将：
```
── {name} ──
```
改为：
```typescript
const family = getToolFamily(name)
// 头部渲染使用：
<Text bold color={borderColor}>
  {family.glyph} {family.verb} {name !== family.verb && name !== family.glyph ? `· ${name}` : ''}
</Text>
```

完整修改后的 `ToolCard`：

```typescript
import { Box, Text } from 'ink'
import { memo, useMemo } from 'react'
import { getTheme } from './theme.js'
import { getToolFamily } from './tool-family.js'

const MAX_COLLAPSED_LINES = 8

interface ToolCardProps {
  name: string
  result: string
  isError?: boolean
  isStreaming?: boolean
  verbose?: boolean
  rawPath?: string
}

function compactPath(rawPath: string | undefined): string {
  if (!rawPath) return ''
  const filename = rawPath.split('/').pop() ?? rawPath
  return filename
}

export const ToolCard = memo(function ToolCard({ name, result, isError, isStreaming, verbose, rawPath }: ToolCardProps) {
  const theme = getTheme()
  const limit = verbose ? 200 : MAX_COLLAPSED_LINES
  const { displayText, truncated } = useMemo(() => {
    const lines = result.split('\n')
    const isLong = lines.length > limit
    const displayLines = isLong ? lines.slice(0, limit) : lines
    return {
      displayText: displayLines.join('\n'),
      truncated: isLong ? lines.length - limit : 0,
    }
  }, [result, limit])

  const borderColor = isError ? theme.error : theme.toolColor(name)
  const family = getToolFamily(name)

  return (
    <Box flexDirection="column" paddingX={1} marginBottom={0}>
      <Text bold color={borderColor}>
        {family.glyph} {family.verb}{isStreaming ? ' …' : ''}
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

- [ ] **步骤 2：运行现有测试验证无回归**

运行：`npx tsx --test src/tui/__tests__/diff-render.test.ts`
预期：PASS — 现有测试无回归

- [ ] **步骤 3：运行 typecheck**

运行：`npm run typecheck`
预期：PASS

- [ ] **步骤 4：Commit**

```bash
git add src/tui/tool-card.tsx
git commit -m "feat(tui): integrate ToolFamily glyph/verb into ToolCard header"
```

---

### 任务 7：App 集成 — renderStaticEntry 分发 + 消息类型升级

**文件：**
- 修改：`src/tui/app.tsx`

- [ ] **步骤 1：更新 import 和 renderStaticEntry**

在 `src/tui/app.tsx` 中：

1. 新增 import（在现有 import 区域）：
```typescript
import { UserMessage } from './user-message.js'
import { SystemMessage } from './system-message.js'
import { ToolGroup } from './tool-group.js'
import { groupLogs } from './group-logs.js'
```

2. 替换 `renderStaticEntry` 函数：

```typescript
function renderStaticEntry(entry: LogEntry, verbose: boolean) {
  switch (entry.type) {
    case 'user_message':
      return <UserMessage key={entry.id} content={entry.content} />
    case 'assistant_message':
      return <StreamOutput key={entry.id} text={entry.content} isStreaming={false} />
    case 'tool':
      return <ToolCard key={entry.id} name={entry.toolName ?? ''} result={entry.content} isError={entry.isError} verbose={verbose} rawPath={entry.rawPath} />
    case 'tool_group':
      return <ToolGroup key={entry.id} tools={entry.children ?? []} verbose={verbose} />
    case 'checkpoint':
      return <Box key={entry.id} paddingX={2}><Text dimColor color="yellow">⚑ {entry.content}</Text></Box>
    case 'evidence':
      return <Box key={entry.id} paddingX={2} marginBottom={1} borderStyle="single" borderColor="green"><Text color="green">{entry.content}</Text></Box>
    case 'system':
      return <SystemMessage key={entry.id} content={entry.content} isError={entry.isError} />
    default:
      return <StreamOutput key={entry.id} text={entry.content} isStreaming={false} />
  }
}
```

- [ ] **步骤 2：升级 handleSubmit 中的用户消息类型**

将 `src/tui/app.tsx` 第 368 行：
```typescript
pushStatic(createLogEntry({ type: 'text', content: `> ${userInput}` }))
```
改为：
```typescript
pushStatic(createLogEntry({ type: 'user_message', content: userInput, turnNumber: session.getTurnCount() + 1 }))
```

- [ ] **步骤 3：升级 onTurnComplete 中的助手消息类型**

将 `src/tui/app.tsx` 第 471-472 行：
```typescript
if (finalText) {
  pushStatic(createLogEntry({ type: 'text', content: finalText }))
}
```
改为：
```typescript
if (finalText) {
  pushStatic(createLogEntry({ type: 'assistant_message', content: finalText, turnNumber: session.getTurnCount() }))
}
```

- [ ] **步骤 4：升级 onError / onAbort 消息类型**

将第 505 行：
```typescript
pushStatic(createLogEntry({ type: 'text', content: `Error: ${error.message}` }))
```
改为：
```typescript
pushStatic(createLogEntry({ type: 'system', content: `Error: ${error.message}`, isError: true }))
```

将第 509 行：
```typescript
pushStatic(createLogEntry({ type: 'text', content: '⏹ Interrupted.' }))
```
改为：
```typescript
pushStatic(createLogEntry({ type: 'system', content: '⏹ Interrupted.' }))
```

- [ ] **步骤 5：在 onToolResult 中添加 turnNumber**

将第 431 行：
```typescript
pushStatic(createLogEntry({ type: 'tool', id, toolName: name, content: finalContent, isError, rawPath }))
```
改为：
```typescript
pushStatic(createLogEntry({ type: 'tool', id, toolName: name, content: finalContent, isError, rawPath, turnNumber: session.getTurnCount() }))
```

- [ ] **步骤 6：在 Static 区域加入 groupLogs**

将第 535-537 行：
```typescript
<Static items={staticItems}>
  {(item) => renderStaticEntry(item, verbose)}
</Static>
```
改为：
```typescript
<Static items={groupLogs(staticItems)}>
  {(item) => renderStaticEntry(item, verbose)}
</Static>
```

- [ ] **步骤 7：修复剩余的 `type: 'text'` 创建点**

搜索 app.tsx 中所有 `createLogEntry({ type: 'text'` 并逐一判断：
- banner（第 222 行）保持 `'text'`（品牌 banner，会走 default 分支）
- Ctrl+C 提示（第 247 行）改为 `'system'`
- rollback 相关提示改为 `'system'`
- 恢复会话提示（第 268 行）改为 `'system'`
- slash 命令中的 `type: 'text'` 保持 `'text'`（多数是命令输出的纯文本）
- queue error（第 525 行）改为 `'system'`

- [ ] **步骤 8：运行 typecheck**

运行：`npm run typecheck`
预期：PASS

- [ ] **步骤 9：运行全量测试**

运行：`npm test`
预期：全部 PASS

- [ ] **步骤 10：Commit**

```bash
git add src/tui/app.tsx
git commit -m "feat(tui): integrate message type separation + tool grouping into App"
```

---

### 任务 8：history-replay 类型映射更新

**文件：**
- 修改：`src/tui/history-replay.ts`
- 修改：`src/tui/__tests__/history-replay.test.ts`

- [ ] **步骤 1：更新 replay 消息类型映射**

在 `src/tui/history-replay.ts` 中，修改 `replayMessagesToLogEntries` 函数：

1. 添加 turnNumber 追踪：
```typescript
let turnNumber = 0
```

2. 将用户消息从 `type: 'text'` 改为 `type: 'user_message'`：
```typescript
if (msg.role === 'user') {
  const textBlock = msg.content.find((b: any) => b.type === 'text')
  if (textBlock) {
    entries.push(createLogEntry({ type: 'user_message', content: textBlock.text, turnNumber }))
  }
}
```

3. 将助手文本从 `type: 'text'` 改为 `type: 'assistant_message'`，并在 turn 结束时递增：
```typescript
if (msg.role === 'assistant') {
  for (const block of msg.content) {
    if (block.type === 'text') {
      entries.push(createLogEntry({ type: 'assistant_message', content: block.text, turnNumber }))
    } else if (block.type === 'tool_use') {
      toolNameMap.set(block.id, block.name)
    }
  }
  turnNumber++
}
```

4. tool_result 条目添加 `turnNumber`：
```typescript
entries.push(createLogEntry({ type: 'tool', content: ..., toolName: ..., turnNumber }))
```

- [ ] **步骤 2：更新 history-replay 测试**

修改 `src/tui/__tests__/history-replay.test.ts` 中断言：
- 用户消息断言从 `type: 'text'` 改为 `type: 'user_message'`
- 助手文本断言从 `type: 'text'` 改为 `type: 'assistant_message'`
- 验证 `turnNumber` 字段正确递增

- [ ] **步骤 3：运行测试**

运行：`npx tsx --test src/tui/__tests__/history-replay.test.ts`
预期：PASS

- [ ] **步骤 4：运行全量测试**

运行：`npm test`
预期：全部 PASS

- [ ] **步骤 5：Commit**

```bash
git add src/tui/history-replay.ts src/tui/__tests__/history-replay.test.ts
git commit -m "feat(tui): update history-replay to use new message types with turnNumber"
```

---

## 自检

### 1. 规格覆盖度

| 规格需求 | 实现任务 |
|---------|---------|
| LogEntry 类型扩展（user_message/assistant_message/system/tool_group） | 任务 1 |
| turnNumber / children 字段 | 任务 1 |
| ToolFamily 分类体系 + glyph | 任务 2 |
| 渲染时分组逻辑（>= 3 连续工具） | 任务 3 |
| UserMessage 组件（`❯` 前缀 + mint 色） | 任务 4 |
| SystemMessage 组件（`⌁` 前缀 + error 分级） | 任务 4 |
| ToolGroup 折叠组件 | 任务 5 |
| ToolCard 集成 glyph | 任务 6 |
| App renderStaticEntry 分发 | 任务 7 |
| handleSubmit user_message 类型 | 任务 7 |
| onTurnComplete assistant_message 类型 | 任务 7 |
| onError/onAbort system 类型 | 任务 7 |
| onToolResult turnNumber | 任务 7 |
| Static 区域 groupLogs | 任务 7 |
| history-replay 类型映射 | 任务 8 |
| theme 颜色扩展 | 任务 4 |

无遗漏。

### 2. 占位符扫描

无 TODO/TBD/后续实现/类似任务 N 的模式。每个步骤包含完整代码。

### 3. 类型一致性

- `LogEntryType` 在任务 1 定义，任务 2-8 引用 — 一致
- `ToolFamilyInfo` 在任务 2 定义，任务 3/5/6 引用 — 一致
- `getGroupSummary` 在任务 2 定义，任务 3/5 引用 — 一致
- `groupLogs` 在任务 3 定义，任务 7 引用 — 一致
- `UserMessage`/`SystemMessage`/`ToolGroup` 在任务 4/5 定义，任务 7 引用 — 一致
- `session.getTurnCount()` 在任务 7 使用，已在 SessionContext 中存在 — 一致
