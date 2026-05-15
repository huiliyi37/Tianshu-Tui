# Rivet Progressive Context Engine 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 为 Rivet 增加 Progressive Context Engine，使会话在工具调用、恢复、压缩和长上下文下保持 API 安全、缓存友好、可观测且可渐进降级。

**架构：** 新增 `src/context/` 作为上下文工程层，负责 Context Ledger、API round grouping、会话记忆、压缩决策和 resume preflight；保留 `src/compact/` 作为具体压缩实现并升级 microcompact/reactive compact。TUI 通过 `/context`、`/memory`、StatusBar context health 展示上下文状态，PromptEngine 继续作为最后 API 安全防线。

**技术栈：** TypeScript 5.7、Node.js 22、node:test、Zod、Ink 6 / React 19、Rivet Message/ContentBlock 类型、现有 `SessionContext` / `SessionPersist` / `PromptEngine`。

---

## 文件结构

### 新增文件

- `src/context/types.ts` — 定义 Context Ledger、API round、compact event、context health、session memory 的共享类型。
- `src/context/token-estimate.ts` — 集中估算 message/block token 与内容摘要长度，避免多个模块重复估算。
- `src/context/rounds.ts` — 将 `Message[]` 分组为 API-safe rounds，验证 assistant `tool_use` 与 user `tool_result` 的相邻不变量。
- `src/context/ledger.ts` — 从 `SessionContext` 状态和 `Message[]` 构建 Context Ledger，计算 token 区段、working set、compact 历史和健康等级。
- `src/context/resume-preflight.ts` — resume 前检查历史是否 API-safe、是否需要插入 synthetic tool result、是否需要提示 compact。
- `src/context/session-memory.ts` — 管理 session memory sidecar 文件，支持加载、追加、合并最近事实和生成 prompt 注入块。
- `src/context/compact-policy.ts` — 实现 Progressive Compaction Ladder 的纯决策逻辑和 compact circuit breaker。
- `src/context/reactive-compact.ts` — 选择可安全总结的 API rounds，并把总结结果转为 compact boundary message。
- `src/context/__tests__/rounds.test.ts` — API round grouping 与 invariant validator 单元测试。
- `src/context/__tests__/ledger.test.ts` — Context Ledger 构建与健康等级测试。
- `src/context/__tests__/resume-preflight.test.ts` — resume 修复/警告策略测试。
- `src/context/__tests__/session-memory.test.ts` — session memory 文件读写与 prompt 块测试。
- `src/context/__tests__/compact-policy.test.ts` — compaction ladder 与 circuit breaker 测试。
- `src/context/__tests__/reactive-compact.test.ts` — reactive compact round 选择与 boundary message 测试。

### 修改文件

- `src/compact/micro.ts` — 从“删除中间消息”升级为优先缩短 tool_result 文本，并且只按完整 API round 删除。
- `src/compact/auto.ts` — 接入 `compact-policy` 和 `reactive-compact`，保留现有 `smartCompact()` API 兼容调用方。
- `src/compact/__tests__/compact.test.ts` — 增加 API round 不变量、tool_result microcompact、compact boundary 测试。
- `src/agent/context.ts` — 增加 context ledger 快照、compact event、session memory summary、working set digest 的状态方法。
- `src/agent/session-persist.ts` — 增加 session metadata sidecar 的持久化方法，不改变现有 JSONL message 文件格式。
- `src/agent/loop.ts` — 在自动压缩和工具执行后更新 ledger/working set，并记录 compact event。
- `src/prompt/volatile.ts` — 将 volatile block 拆成 stable XML context layers，注入 ledger、working set、session memory digest。
- `src/prompt/engine.ts` — 调用 round validator 生成 diagnostics，但仍保留现有 synthetic tool_result normalize 作为最终防线。
- `src/prompt/__tests__/engine.test.ts` — 增加 validator 与 normalizer 的组合回归测试。
- `src/tui/status-bar.tsx` — 展示 context health、token tier、compact 状态和 round safety 指示。
- `src/tui/app.tsx` — 实现 `/context`、`/memory`、resume preflight、manual compact 结果展示。
- `src/tui/__tests__/log-state.test.ts` — 若 `/context` 输出使用 log helper，补充稳定日志测试。
- `README.md` — 补充 Progressive Context Engine 用户命令和状态栏说明。

### 不修改的边界

- 不改变 provider API 响应解析协议。
- 不改变 `Message` / `ContentBlock` 基础类型的外部形状。
- 不引入数据库；session memory 和 metadata 使用本地 sidecar 文件。
- 不把真实 API key、token 或 credential fragment 写入测试 fixture、文档或日志。

---

## 任务 1：建立 API Round Grouping 与不变量验证

**文件：**
- 创建：`src/context/types.ts`
- 创建：`src/context/rounds.ts`
- 创建：`src/context/__tests__/rounds.test.ts`
- 修改：`src/prompt/engine.ts`
- 测试：`src/context/__tests__/rounds.test.ts`、`src/prompt/__tests__/engine.test.ts`

- [x] **步骤 1：编写失败测试：把普通 user/assistant 对话分成 round**

在 `src/context/__tests__/rounds.test.ts` 写入：

```ts
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { Message } from '../../api/types.js'
import { groupApiRounds, validateApiRounds } from '../rounds.js'

function text(role: 'user' | 'assistant', content: string): Message {
  return { role, content }
}

describe('API round grouping', () => {
  it('groups plain user and assistant messages into independent safe rounds', () => {
    const messages: Message[] = [
      text('user', 'hello'),
      text('assistant', 'hi'),
      text('user', 'continue'),
      text('assistant', 'done'),
    ]

    const rounds = groupApiRounds(messages)

    assert.equal(rounds.length, 2)
    assert.deepEqual(rounds.map(round => [round.startIndex, round.endIndex]), [[0, 1], [2, 3]])
    assert.deepEqual(validateApiRounds(rounds), [])
  })
})
```

- [x] **步骤 2：运行测试验证失败**

运行：

```bash
npx tsx --test src/context/__tests__/rounds.test.ts
```

预期：FAIL，报错包含：

```text
Cannot find module '../rounds.js'
```

- [x] **步骤 3：创建共享类型和最小 grouping 实现**

创建 `src/context/types.ts`：

```ts
import type { Message } from '../api/types.js'

export type ContextHealthLevel = 'healthy' | 'watch' | 'compact' | 'critical'

export interface ApiRound {
  index: number
  startIndex: number
  endIndex: number
  messages: Message[]
  toolUseIds: string[]
  toolResultIds: string[]
  safe: boolean
}

export interface ApiRoundDiagnostic {
  roundIndex: number
  messageIndex: number
  level: 'error' | 'warning'
  code: 'missing_tool_result' | 'orphan_tool_result' | 'misordered_tool_result'
  detail: string
}
```

创建 `src/context/rounds.ts`：

```ts
import type { ContentBlock, Message } from '../api/types.js'
import type { ApiRound, ApiRoundDiagnostic } from './types.js'

function isToolUseBlock(block: ContentBlock): block is ContentBlock & { type: 'tool_use'; id: string } {
  return block.type === 'tool_use'
}

function isToolResultBlock(block: ContentBlock): block is ContentBlock & { type: 'tool_result'; tool_use_id: string } {
  return block.type === 'tool_result'
}

function collectToolUseIds(message: Message): string[] {
  if (message.role !== 'assistant' || !Array.isArray(message.content)) return []
  return message.content.filter(isToolUseBlock).map(block => block.id)
}

function collectToolResultIds(message: Message): string[] {
  if (message.role !== 'user' || !Array.isArray(message.content)) return []
  return message.content.filter(isToolResultBlock).map(block => block.tool_use_id)
}

function makeRound(index: number, startIndex: number, endIndex: number, messages: Message[]): ApiRound {
  const toolUseIds = messages.flatMap(collectToolUseIds)
  const toolResultIds = messages.flatMap(collectToolResultIds)
  return {
    index,
    startIndex,
    endIndex,
    messages,
    toolUseIds,
    toolResultIds,
    safe: toolUseIds.every(id => toolResultIds.includes(id)),
  }
}

export function groupApiRounds(messages: Message[]): ApiRound[] {
  const rounds: ApiRound[] = []
  let startIndex = 0
  let current: Message[] = []

  for (let i = 0; i < messages.length; i++) {
    const message = messages[i]!
    if (message.role === 'user' && current.length > 0 && collectToolResultIds(message).length === 0) {
      rounds.push(makeRound(rounds.length, startIndex, i - 1, current))
      startIndex = i
      current = []
    }
    current.push(message)
  }

  if (current.length > 0) {
    rounds.push(makeRound(rounds.length, startIndex, messages.length - 1, current))
  }

  return rounds
}

export function validateApiRounds(rounds: ApiRound[]): ApiRoundDiagnostic[] {
  const diagnostics: ApiRoundDiagnostic[] = []

  for (const round of rounds) {
    for (const id of round.toolUseIds) {
      if (!round.toolResultIds.includes(id)) {
        diagnostics.push({
          roundIndex: round.index,
          messageIndex: round.endIndex,
          level: 'error',
          code: 'missing_tool_result',
          detail: `tool_use ${id} has no matching tool_result in the same API round`,
        })
      }
    }

    for (const id of round.toolResultIds) {
      if (!round.toolUseIds.includes(id)) {
        diagnostics.push({
          roundIndex: round.index,
          messageIndex: round.startIndex,
          level: 'error',
          code: 'orphan_tool_result',
          detail: `tool_result ${id} has no matching tool_use in the same API round`,
        })
      }
    }
  }

  return diagnostics
}
```

- [x] **步骤 4：运行测试验证通过**

运行：

```bash
npx tsx --test src/context/__tests__/rounds.test.ts
```

预期：PASS，输出包含：

```text
# pass 1
# fail 0
```

- [x] **步骤 5：增加 tool_use/tool_result 相邻不变量失败测试**

追加到 `rounds.test.ts`：

```ts
it('keeps assistant tool_use and matching user tool_result in the same round', () => {
  const messages: Message[] = [
    text('user', 'inspect file'),
    {
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'call_1', name: 'read_file', input: { file_path: '/repo/a.ts' } }],
    },
    {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'file content' }],
    },
    text('assistant', 'the file exports A'),
    text('user', 'continue'),
  ]

  const rounds = groupApiRounds(messages)

  assert.equal(rounds.length, 2)
  assert.deepEqual(rounds[0]!.toolUseIds, ['call_1'])
  assert.deepEqual(rounds[0]!.toolResultIds, ['call_1'])
  assert.deepEqual(validateApiRounds(rounds), [])
})

it('reports missing tool_result inside a round', () => {
  const messages: Message[] = [
    text('user', 'edit'),
    {
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'call_2', name: 'edit_file', input: { file_path: '/repo/a.ts' } }],
    },
    text('user', 'next request'),
  ]

  const diagnostics = validateApiRounds(groupApiRounds(messages))

  assert.equal(diagnostics.length, 1)
  assert.equal(diagnostics[0]!.code, 'missing_tool_result')
  assert.equal(diagnostics[0]!.level, 'error')
})

it('reports orphan tool_result blocks', () => {
  const messages: Message[] = [
    {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'call_missing', content: 'orphan' }],
    },
  ]

  const diagnostics = validateApiRounds(groupApiRounds(messages))

  assert.equal(diagnostics.length, 1)
  assert.equal(diagnostics[0]!.code, 'orphan_tool_result')
})
```

- [x] **步骤 6：运行测试验证失败并修正 grouping 边界**

运行：

```bash
npx tsx --test src/context/__tests__/rounds.test.ts
```

预期第一次可能 FAIL：如果 `tool_result` 被拆成独立 round，失败断言是 `rounds.length` 或 diagnostic 数量不匹配。

把 `groupApiRounds()` 的循环替换为以下实现，确保普通 user 开启新 round，但 tool_result user 留在上一个 assistant tool_use round：

```ts
export function groupApiRounds(messages: Message[]): ApiRound[] {
  const rounds: ApiRound[] = []
  let startIndex = 0
  let current: Message[] = []

  for (let i = 0; i < messages.length; i++) {
    const message = messages[i]!
    const isPlainUser = message.role === 'user' && collectToolResultIds(message).length === 0
    const previousHasToolUse = current.some(item => collectToolUseIds(item).length > 0)

    if (isPlainUser && current.length > 0 && !previousHasToolUse) {
      rounds.push(makeRound(rounds.length, startIndex, i - 1, current))
      startIndex = i
      current = []
    }

    if (isPlainUser && current.length > 0 && previousHasToolUse) {
      rounds.push(makeRound(rounds.length, startIndex, i - 1, current))
      startIndex = i
      current = []
    }

    current.push(message)
  }

  if (current.length > 0) {
    rounds.push(makeRound(rounds.length, startIndex, messages.length - 1, current))
  }

  return rounds
}
```

- [x] **步骤 7：加入 PromptEngine 回归测试，确认 normalizer 后 request 无 error diagnostic**

在 `src/prompt/__tests__/engine.test.ts` 追加：

```ts
import { groupApiRounds, validateApiRounds } from '../../context/rounds.js'
```

并追加测试：

```ts
it('builds requests that validate as API-safe rounds after history repair', () => {
  const messages: Message[] = [
    { role: 'user', content: 'fix it' },
    {
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'call_safe', name: 'edit_file', input: { file_path: '/repo/a.ts' } }],
    },
    { role: 'user', content: 'continue' },
  ]

  const request = makeEngine().buildRequest(messages)
  const diagnostics = validateApiRounds(groupApiRounds(request.messages))

  assert.deepEqual(diagnostics, [])
})
```

- [x] **步骤 8：运行相关测试和类型检查**

运行：

```bash
npx tsx --test src/context/__tests__/rounds.test.ts src/prompt/__tests__/engine.test.ts
npm run typecheck
```

预期：全部 PASS，typecheck 无错误。

- [x] **步骤 9：Commit**

```bash
git add src/context/types.ts src/context/rounds.ts src/context/__tests__/rounds.test.ts src/prompt/engine.ts src/prompt/__tests__/engine.test.ts
git commit -m "feat(context): validate API-safe message rounds"
```

---

## 任务 2：实现 Context Ledger 与上下文健康等级

**文件：**
- 创建：`src/context/token-estimate.ts`
- 创建：`src/context/ledger.ts`
- 创建：`src/context/__tests__/ledger.test.ts`
- 修改：`src/context/types.ts`
- 修改：`src/agent/context.ts`
- 测试：`src/context/__tests__/ledger.test.ts`

- [x] **步骤 1：扩展类型并编写 ledger 失败测试**

在 `src/context/types.ts` 追加：

```ts
export interface ContextLedgerSection {
  name: 'system' | 'tools' | 'volatile' | 'history' | 'working_set' | 'memory'
  estimatedTokens: number
  digest: string
}

export interface CompactEvent {
  turn: number
  tier: 1 | 2 | 3 | 4
  reason: string
  beforeTokens: number
  afterTokens: number
  createdAt: number
}

export interface ContextLedger {
  estimatedTokens: number
  maxTokens: number
  usageRatio: number
  health: ContextHealthLevel
  apiSafe: boolean
  roundCount: number
  diagnostics: ApiRoundDiagnostic[]
  sections: ContextLedgerSection[]
  workingSet: string[]
  compactEvents: CompactEvent[]
}
```

创建 `src/context/__tests__/ledger.test.ts`：

```ts
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { Message } from '../../api/types.js'
import { buildContextLedger, chooseContextHealth } from '../ledger.js'

describe('Context Ledger', () => {
  it('classifies token usage into healthy, watch, compact, and critical levels', () => {
    assert.equal(chooseContextHealth(100, 1000), 'healthy')
    assert.equal(chooseContextHealth(650, 1000), 'watch')
    assert.equal(chooseContextHealth(820, 1000), 'compact')
    assert.equal(chooseContextHealth(950, 1000), 'critical')
  })

  it('builds a ledger with round safety and section digests', () => {
    const messages: Message[] = [
      { role: 'user', content: 'read src/main.tsx' },
      { role: 'assistant', content: 'The entry point routes CLI and TUI modes.' },
    ]

    const ledger = buildContextLedger({
      messages,
      maxTokens: 10_000,
      workingSet: ['src/main.tsx'],
      compactEvents: [],
      staticTokens: 500,
      toolsTokens: 300,
      volatileTokens: 120,
      memoryTokens: 0,
    })

    assert.equal(ledger.health, 'healthy')
    assert.equal(ledger.apiSafe, true)
    assert.equal(ledger.roundCount, 1)
    assert.deepEqual(ledger.workingSet, ['src/main.tsx'])
    assert.ok(ledger.sections.some(section => section.name === 'history'))
    assert.ok(ledger.sections.every(section => section.digest.length === 16))
  })
})
```

- [x] **步骤 2：运行测试验证失败**

运行：

```bash
npx tsx --test src/context/__tests__/ledger.test.ts
```

预期：FAIL，报错包含：

```text
Cannot find module '../ledger.js'
```

- [x] **步骤 3：实现 token 估算工具**

创建 `src/context/token-estimate.ts`：

```ts
import { createHash } from 'node:crypto'
import type { ContentBlock, Message } from '../api/types.js'

export function digestText(input: string): string {
  return createHash('sha256').update(input).digest('hex').slice(0, 16)
}

export function estimateTextTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

export function estimateBlockTokens(block: ContentBlock): number {
  if (block.type === 'text') return estimateTextTokens(block.text)
  if (block.type === 'thinking') return estimateTextTokens(block.thinking)
  if (block.type === 'tool_use') return estimateTextTokens(JSON.stringify(block.input)) + estimateTextTokens(block.name) + 8
  if (block.type === 'tool_result') return estimateTextTokens(block.content) + 8
  return estimateTextTokens(JSON.stringify(block))
}

export function estimateMessageTokens(message: Message): number {
  if (typeof message.content === 'string') return estimateTextTokens(message.content) + 4
  return message.content.reduce((sum, block) => sum + estimateBlockTokens(block), 4)
}

export function estimateMessagesTokens(messages: Message[]): number {
  return messages.reduce((sum, message) => sum + estimateMessageTokens(message), 0)
}
```

- [x] **步骤 4：实现 Context Ledger**

创建 `src/context/ledger.ts`：

```ts
import type { Message } from '../api/types.js'
import { groupApiRounds, validateApiRounds } from './rounds.js'
import { digestText, estimateMessagesTokens } from './token-estimate.js'
import type { CompactEvent, ContextHealthLevel, ContextLedger, ContextLedgerSection } from './types.js'

export interface BuildContextLedgerInput {
  messages: Message[]
  maxTokens: number
  workingSet: string[]
  compactEvents: CompactEvent[]
  staticTokens: number
  toolsTokens: number
  volatileTokens: number
  memoryTokens: number
}

export function chooseContextHealth(estimatedTokens: number, maxTokens: number): ContextHealthLevel {
  const ratio = maxTokens > 0 ? estimatedTokens / maxTokens : 1
  if (ratio >= 0.9) return 'critical'
  if (ratio >= 0.78) return 'compact'
  if (ratio >= 0.6) return 'watch'
  return 'healthy'
}

function section(name: ContextLedgerSection['name'], estimatedTokens: number, source: string): ContextLedgerSection {
  return { name, estimatedTokens, digest: digestText(`${name}:${source}:${estimatedTokens}`) }
}

export function buildContextLedger(input: BuildContextLedgerInput): ContextLedger {
  const historyTokens = estimateMessagesTokens(input.messages)
  const workingSetTokens = input.workingSet.reduce((sum, item) => sum + Math.ceil(item.length / 4), 0)
  const estimatedTokens = input.staticTokens
    + input.toolsTokens
    + input.volatileTokens
    + input.memoryTokens
    + historyTokens
    + workingSetTokens
  const rounds = groupApiRounds(input.messages)
  const diagnostics = validateApiRounds(rounds)
  const sections = [
    section('system', input.staticTokens, 'system'),
    section('tools', input.toolsTokens, 'tools'),
    section('volatile', input.volatileTokens, 'volatile'),
    section('history', historyTokens, JSON.stringify(input.messages)),
    section('working_set', workingSetTokens, input.workingSet.join('\n')),
    section('memory', input.memoryTokens, 'session-memory'),
  ]

  return {
    estimatedTokens,
    maxTokens: input.maxTokens,
    usageRatio: input.maxTokens > 0 ? estimatedTokens / input.maxTokens : 1,
    health: chooseContextHealth(estimatedTokens, input.maxTokens),
    apiSafe: diagnostics.length === 0,
    roundCount: rounds.length,
    diagnostics,
    sections,
    workingSet: [...input.workingSet],
    compactEvents: [...input.compactEvents],
  }
}
```

- [x] **步骤 5：运行 ledger 测试验证通过**

运行：

```bash
npx tsx --test src/context/__tests__/ledger.test.ts
```

预期：PASS。

- [x] **步骤 6：在 SessionContext 中保存 ledger 相关状态**

在 `src/agent/context.ts` 中导入类型：

```ts
import type { CompactEvent, ContextLedger } from '../context/types.js'
```

扩展 `SessionState`：

```ts
contextLedger?: ContextLedger
compactEvents: CompactEvent[]
workingSetDigest?: string
sessionMemorySummary?: string
```

在构造初始状态中加入：

```ts
compactEvents: [],
```

为 `SessionContext` 增加方法：

```ts
setContextLedger(ledger: ContextLedger): void {
  this.state.contextLedger = ledger
}

getContextLedger(): ContextLedger | undefined {
  return this.state.contextLedger
}

recordCompactEvent(event: CompactEvent): void {
  this.state.compactEvents = [...this.state.compactEvents, event]
}

getCompactEvents(): CompactEvent[] {
  return [...this.state.compactEvents]
}

setSessionMemorySummary(summary: string): void {
  this.state.sessionMemorySummary = summary
}

getSessionMemorySummary(): string | undefined {
  return this.state.sessionMemorySummary
}
```

如果 `SessionContext` 当前没有 `getWorkingSet()`，增加：

```ts
getWorkingSet(): string[] {
  return [...new Set([...this.state.filesRead, ...this.state.filesModified])]
}
```

- [x] **步骤 7：补充 SessionContext ledger 状态测试**

如果已有 `src/agent/__tests__/context.test.ts`，追加测试；如果没有，创建该文件：

```ts
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { SessionContext } from '../context.js'
import type { ContextLedger } from '../../context/types.js'

function ledger(): ContextLedger {
  return {
    estimatedTokens: 100,
    maxTokens: 1000,
    usageRatio: 0.1,
    health: 'healthy',
    apiSafe: true,
    roundCount: 1,
    diagnostics: [],
    sections: [],
    workingSet: ['src/main.tsx'],
    compactEvents: [],
  }
}

describe('SessionContext context ledger state', () => {
  it('stores context ledger and compact events immutably', () => {
    const session = new SessionContext()
    session.setContextLedger(ledger())
    session.recordCompactEvent({
      turn: 2,
      tier: 1,
      reason: 'tool results exceeded budget',
      beforeTokens: 900,
      afterTokens: 700,
      createdAt: 1000,
    })

    assert.equal(session.getContextLedger()?.health, 'healthy')
    assert.equal(session.getCompactEvents().length, 1)
  })
})
```

- [x] **步骤 8：运行相关测试和类型检查**

运行：

```bash
npx tsx --test src/context/__tests__/ledger.test.ts src/agent/__tests__/context.test.ts
npm run typecheck
```

预期：全部 PASS，typecheck 无错误。

- [x] **步骤 9：Commit**

```bash
git add src/context/types.ts src/context/token-estimate.ts src/context/ledger.ts src/context/__tests__/ledger.test.ts src/agent/context.ts src/agent/__tests__/context.test.ts
git commit -m "feat(context): add context ledger health tracking"
```

---

## 任务 3：实现 Resume Preflight 和 session metadata sidecar

**文件：**
- 创建：`src/context/resume-preflight.ts`
- 创建：`src/context/__tests__/resume-preflight.test.ts`
- 修改：`src/context/types.ts`
- 修改：`src/agent/session-persist.ts`
- 测试：`src/context/__tests__/resume-preflight.test.ts`

- [x] **步骤 1：扩展 preflight 类型并编写失败测试**

在 `src/context/types.ts` 追加：

```ts
export interface ResumePreflightResult {
  safe: boolean
  repaired: boolean
  diagnostics: ApiRoundDiagnostic[]
  messagesChanged: number
  messages: import('../api/types.js').Message[]
  warnings: string[]
}

export interface SessionMetadata {
  sessionId: string
  updatedAt: number
  compactEvents: CompactEvent[]
  memoryDigest?: string
  lastLedger?: ContextLedger
}
```

创建 `src/context/__tests__/resume-preflight.test.ts`：

```ts
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { Message } from '../../api/types.js'
import { runResumePreflight } from '../resume-preflight.js'

describe('resume preflight', () => {
  it('passes through API-safe histories unchanged', () => {
    const messages: Message[] = [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi' },
    ]

    const result = runResumePreflight(messages)

    assert.equal(result.safe, true)
    assert.equal(result.repaired, false)
    assert.equal(result.messagesChanged, 0)
    assert.deepEqual(result.messages, messages)
  })

  it('repairs missing tool_result with an error result immediately after tool_use', () => {
    const messages: Message[] = [
      { role: 'user', content: 'read file' },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'call_resume', name: 'read_file', input: { file_path: '/repo/a.ts' } }],
      },
      { role: 'user', content: 'continue' },
    ]

    const result = runResumePreflight(messages)

    assert.equal(result.safe, true)
    assert.equal(result.repaired, true)
    assert.equal(result.messagesChanged, 1)
    assert.equal(result.messages[2]!.role, 'user')
    assert.deepEqual(result.messages[2]!.content, [{
      type: 'tool_result',
      tool_use_id: 'call_resume',
      content: 'Tool result unavailable: recovered during session resume preflight.',
      is_error: true,
    }])
  })
})
```

- [x] **步骤 2：运行测试验证失败**

运行：

```bash
npx tsx --test src/context/__tests__/resume-preflight.test.ts
```

预期：FAIL，报错包含：

```text
Cannot find module '../resume-preflight.js'
```

- [x] **步骤 3：实现 resume preflight**

创建 `src/context/resume-preflight.ts`：

```ts
import type { ContentBlock, Message } from '../api/types.js'
import { groupApiRounds, validateApiRounds } from './rounds.js'
import type { ResumePreflightResult } from './types.js'

function isToolUseBlock(block: ContentBlock): block is ContentBlock & { type: 'tool_use'; id: string } {
  return block.type === 'tool_use'
}

function isToolResultBlock(block: ContentBlock): block is ContentBlock & { type: 'tool_result'; tool_use_id: string } {
  return block.type === 'tool_result'
}

function toolUseIds(message: Message): string[] {
  if (message.role !== 'assistant' || !Array.isArray(message.content)) return []
  return message.content.filter(isToolUseBlock).map(block => block.id)
}

function toolResultIds(message: Message | undefined): string[] {
  if (!message || message.role !== 'user' || !Array.isArray(message.content)) return []
  return message.content.filter(isToolResultBlock).map(block => block.tool_use_id)
}

function syntheticToolResult(id: string): ContentBlock {
  return {
    type: 'tool_result',
    tool_use_id: id,
    content: 'Tool result unavailable: recovered during session resume preflight.',
    is_error: true,
  }
}

export function runResumePreflight(messages: Message[]): ResumePreflightResult {
  const beforeDiagnostics = validateApiRounds(groupApiRounds(messages))
  const repairedMessages: Message[] = []
  let inserted = 0

  for (let i = 0; i < messages.length; i++) {
    const message = messages[i]!

    if (message.role === 'user' && Array.isArray(message.content) && message.content.some(isToolResultBlock)) {
      const previous = repairedMessages[repairedMessages.length - 1]
      if (!previous || toolUseIds(previous).length === 0) {
        continue
      }
    }

    repairedMessages.push(message)

    const ids = toolUseIds(message)
    if (ids.length === 0) continue

    const next = messages[i + 1]
    const results = toolResultIds(next)
    const missing = ids.filter(id => !results.includes(id))
    if (missing.length > 0) {
      repairedMessages.push({ role: 'user', content: missing.map(syntheticToolResult) })
      inserted++
    }
  }

  const diagnostics = validateApiRounds(groupApiRounds(repairedMessages))
  return {
    safe: diagnostics.length === 0,
    repaired: inserted > 0 || repairedMessages.length !== messages.length,
    diagnostics,
    messagesChanged: Math.abs(repairedMessages.length - messages.length) + inserted,
    messages: repairedMessages,
    warnings: beforeDiagnostics.map(diagnostic => diagnostic.detail),
  }
}
```

- [x] **步骤 4：运行 preflight 测试验证通过**

运行：

```bash
npx tsx --test src/context/__tests__/resume-preflight.test.ts
```

预期：PASS。

- [x] **步骤 5：为 SessionPersist 增加 metadata sidecar 测试**

在 `src/agent/__tests__/session-persist.test.ts` 中追加；如果没有该文件，则创建：

```ts
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { SessionPersist } from '../session-persist.js'
import type { SessionMetadata } from '../../context/types.js'

describe('SessionPersist metadata', () => {
  it('writes and reads session metadata sidecar', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rivet-session-meta-'))
    try {
      const persist = new SessionPersist('session-meta-test', dir)
      const metadata: SessionMetadata = {
        sessionId: 'session-meta-test',
        updatedAt: 1000,
        compactEvents: [{
          turn: 3,
          tier: 1,
          reason: 'manual compact',
          beforeTokens: 900,
          afterTokens: 500,
          createdAt: 1000,
        }],
      }

      persist.writeMetadata(metadata)

      assert.deepEqual(persist.loadMetadata(), metadata)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
```

- [x] **步骤 6：修改 SessionPersist 支持可注入目录和 metadata**

在 `src/agent/session-persist.ts` 中导入：

```ts
import type { SessionMetadata } from '../context/types.js'
```

把 constructor 改成：

```ts
private metadataPath: string

constructor(sessionId: string, sessionDir = SESSION_DIR) {
  ensureDir(sessionDir)
  this.filePath = join(sessionDir, `${sessionId}.jsonl`)
  this.metadataPath = join(sessionDir, `${sessionId}.meta.json`)
}
```

追加方法：

```ts
writeMetadata(metadata: SessionMetadata): void {
  writeFileSync(this.metadataPath, JSON.stringify(metadata, null, 2) + '\n')
}

loadMetadata(): SessionMetadata | undefined {
  if (!existsSync(this.metadataPath)) return undefined
  try {
    return JSON.parse(readFileSync(this.metadataPath, 'utf-8')) as SessionMetadata
  } catch {
    return undefined
  }
}
```

保持现有 JSONL `append/load/compact/delete/listSessions` 行为不变。

- [x] **步骤 7：在 `/resume` 分支接入 preflight**

在 `src/tui/app.tsx` 导入：

```ts
import { runResumePreflight } from '../context/resume-preflight.js'
```

将 `/resume` 中的：

```ts
const msgs = p.load()
session.replaceMessages(msgs)
addLog(createLogEntry({ type: 'text', content: `Restored session ${targetId.slice(0, 8)}... (${msgs.length} messages)` }))
```

替换为：

```ts
const msgs = p.load()
const preflight = runResumePreflight(msgs)
session.replaceMessages(preflight.messages)
if (preflight.repaired) {
  p.compact(preflight.messages)
}
addLog(createLogEntry({
  type: 'text',
  content: `Restored session ${targetId.slice(0, 8)}... (${preflight.messages.length} messages, apiSafe=${preflight.safe})`,
}))
if (preflight.warnings.length > 0) {
  addLog(createLogEntry({
    type: 'text',
    content: `Resume preflight repaired ${preflight.messagesChanged} message issue(s).`,
  }))
}
```

- [x] **步骤 8：运行相关测试和类型检查**

运行：

```bash
npx tsx --test src/context/__tests__/resume-preflight.test.ts src/agent/__tests__/session-persist.test.ts
npm run typecheck
```

预期：全部 PASS，typecheck 无错误。

- [x] **步骤 9：Commit**

```bash
git add src/context/types.ts src/context/resume-preflight.ts src/context/__tests__/resume-preflight.test.ts src/agent/session-persist.ts src/agent/__tests__/session-persist.test.ts src/tui/app.tsx
git commit -m "feat(context): preflight restored sessions"
```

---

## 任务 4：升级 microcompact，按 API round 保持工具调用安全

**文件：**
- 修改：`src/compact/micro.ts`
- 修改：`src/compact/__tests__/compact.test.ts`
- 修改：`src/context/types.ts`
- 测试：`src/compact/__tests__/compact.test.ts`、`src/context/__tests__/rounds.test.ts`

- [x] **步骤 1：编写失败测试：tool_result 内容被缩短但 pair 不被破坏**

在 `src/compact/__tests__/compact.test.ts` 追加：

```ts
import { groupApiRounds, validateApiRounds } from '../../context/rounds.js'
```

追加测试：

```ts
it('micro compacts large tool results without breaking tool_use/tool_result pairs', () => {
  const messages: Message[] = [
    { role: 'user', content: 'inspect large output' },
    {
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'call_large', name: 'bash', input: { command: 'npm test' } }],
    },
    {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'call_large', content: 'x'.repeat(8000) }],
    },
    { role: 'assistant', content: 'Tests are failing.' },
  ]

  const result = microCompact(messages, 1000, 3000)
  const diagnostics = validateApiRounds(groupApiRounds(result.messages))
  const toolResultMessage = result.messages.find(message => (
    message.role === 'user'
    && Array.isArray(message.content)
    && message.content.some(block => block.type === 'tool_result')
  ))!

  assert.deepEqual(diagnostics, [])
  assert.equal(result.truncated > 0, true)
  assert.equal(Array.isArray(toolResultMessage.content), true)
  assert.match(JSON.stringify(toolResultMessage.content), /microcompacted tool_result/)
})
```

- [x] **步骤 2：运行测试验证失败**

运行：

```bash
npx tsx --test src/compact/__tests__/compact.test.ts
```

预期：FAIL，断言表现为 large tool result 未被缩短，或 round validator 报 missing/orphan tool result。

- [x] **步骤 3：在 micro.ts 中增加 tool_result 缩短函数**

在 `src/compact/micro.ts` 导入类型和估算：

```ts
import type { ContentBlock, Message } from '../api/types.js'
import { groupApiRounds, validateApiRounds } from '../context/rounds.js'
import { estimateMessageTokens, estimateMessagesTokens } from '../context/token-estimate.js'
```

增加 helper：

```ts
const TOOL_RESULT_PREVIEW_CHARS = 1200

function compactToolResultBlock(block: ContentBlock): { block: ContentBlock; changed: boolean } {
  if (block.type !== 'tool_result') return { block, changed: false }
  if (block.content.length <= TOOL_RESULT_PREVIEW_CHARS) return { block, changed: false }

  return {
    block: {
      ...block,
      content: `<microcompacted tool_result original_chars="${block.content.length}">\n${block.content.slice(0, TOOL_RESULT_PREVIEW_CHARS)}\n</microcompacted tool_result>`,
    },
    changed: true,
  }
}

function compactToolResults(messages: Message[]): { messages: Message[]; changed: number } {
  let changed = 0
  const compacted = messages.map(message => {
    if (!Array.isArray(message.content)) return message
    const blocks = message.content.map(block => {
      const result = compactToolResultBlock(block)
      if (result.changed) changed++
      return result.block
    })
    return changed > 0 ? { ...message, content: blocks } : message
  })
  return { messages: compacted, changed }
}
```

- [x] **步骤 4：把 microCompact 改为先缩短 tool_result，再按 round 删除**

将 `microCompact()` 替换为：

```ts
export function microCompact(
  messages: Message[],
  contextWindow: number,
  estimatedTokens: number,
): { messages: Message[]; truncated: number } {
  if (estimatedTokens <= contextWindow || messages.length <= KEEP_RECENT_MESSAGES + CACHE_ANCHOR_MESSAGES) {
    return { messages, truncated: 0 }
  }

  const toolCompacted = compactToolResults(messages)
  let currentMessages = toolCompacted.messages
  let currentTokens = estimateMessagesTokens(currentMessages)
  let truncated = toolCompacted.changed

  if (currentTokens <= contextWindow) {
    return { messages: currentMessages, truncated }
  }

  const rounds = groupApiRounds(currentMessages)
  const anchorEnd = Math.min(CACHE_ANCHOR_MESSAGES - 1, currentMessages.length - 1)
  const recentStart = Math.max(0, currentMessages.length - KEEP_RECENT_MESSAGES)
  const removableRounds = rounds.filter(round => round.endIndex > anchorEnd && round.startIndex < recentStart)
  const removeIndexes = new Set<number>()

  for (const round of removableRounds) {
    for (let index = round.startIndex; index <= round.endIndex; index++) {
      removeIndexes.add(index)
    }
    currentTokens -= round.messages.reduce((sum, message) => sum + estimateMessageTokens(message), 0)
    truncated += round.messages.length
    if (currentTokens <= contextWindow) break
  }

  if (removeIndexes.size > 0) {
    currentMessages = currentMessages.filter((_, index) => !removeIndexes.has(index))
  }

  const diagnostics = validateApiRounds(groupApiRounds(currentMessages))
  if (diagnostics.length > 0) {
    return { messages: toolCompacted.messages, truncated: toolCompacted.changed }
  }

  return { messages: currentMessages, truncated }
}
```

- [x] **步骤 5：运行 compact 测试验证通过**

运行：

```bash
npx tsx --test src/compact/__tests__/compact.test.ts src/context/__tests__/rounds.test.ts
```

预期：全部 PASS。

- [x] **步骤 6：增加“不能安全删除时回退到 tool-result-only compact”的测试**

追加测试：

```ts
it('falls back to safe tool-result compaction when round deletion would break invariants', () => {
  const messages: Message[] = [
    { role: 'user', content: 'run command' },
    {
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'call_keep', name: 'bash', input: { command: 'pwd' } }],
    },
    {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'call_keep', content: 'y'.repeat(5000) }],
    },
  ]

  const result = microCompact(messages, 10, 2000)

  assert.deepEqual(validateApiRounds(groupApiRounds(result.messages)), [])
  assert.ok(result.messages.some(message => message.role === 'assistant'))
  assert.ok(result.messages.some(message => message.role === 'user'))
})
```

- [x] **步骤 7：运行完整 compact 相关测试和 typecheck**

运行：

```bash
npx tsx --test src/compact/__tests__/compact.test.ts src/context/__tests__/rounds.test.ts
npm run typecheck
```

预期：全部 PASS。

- [x] **步骤 8：Commit**

```bash
git add src/compact/micro.ts src/compact/__tests__/compact.test.ts
git commit -m "feat(compact): preserve tool rounds during microcompact"
```

---

## 任务 5：实现 Progressive Compaction Ladder 和 reactive compact

**文件：**
- 创建：`src/context/compact-policy.ts`
- 创建：`src/context/reactive-compact.ts`
- 创建：`src/context/__tests__/compact-policy.test.ts`
- 创建：`src/context/__tests__/reactive-compact.test.ts`
- 修改：`src/compact/auto.ts`
- 修改：`src/compact/__tests__/compact.test.ts`
- 测试：compact-policy、reactive-compact、compact.test

- [x] **步骤 1：定义 compaction ladder 类型并写失败测试**

在 `src/context/types.ts` 追加：

```ts
export type CompactTier = 0 | 1 | 2 | 3 | 4

export interface CompactDecision {
  tier: CompactTier
  reason: string
  shouldCompact: boolean
}

export interface CompactCircuitBreakerState {
  consecutiveFailures: number
  disabledUntilTurn?: number
}
```

创建 `src/context/__tests__/compact-policy.test.ts`：

```ts
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { decideCompactTier, recordCompactFailure, recordCompactSuccess } from '../compact-policy.js'

describe('compact policy', () => {
  it('chooses progressive tiers from token ratio', () => {
    assert.deepEqual(decideCompactTier({ estimatedTokens: 100, maxTokens: 1000, turn: 1, failures: { consecutiveFailures: 0 } }), {
      tier: 0,
      reason: 'context usage below watch threshold',
      shouldCompact: false,
    })
    assert.equal(decideCompactTier({ estimatedTokens: 650, maxTokens: 1000, turn: 1, failures: { consecutiveFailures: 0 } }).tier, 1)
    assert.equal(decideCompactTier({ estimatedTokens: 820, maxTokens: 1000, turn: 1, failures: { consecutiveFailures: 0 } }).tier, 2)
    assert.equal(decideCompactTier({ estimatedTokens: 900, maxTokens: 1000, turn: 1, failures: { consecutiveFailures: 0 } }).tier, 3)
    assert.equal(decideCompactTier({ estimatedTokens: 980, maxTokens: 1000, turn: 1, failures: { consecutiveFailures: 0 } }).tier, 4)
  })

  it('disables automatic compact temporarily after repeated failures', () => {
    const first = recordCompactFailure({ consecutiveFailures: 0 }, 10)
    const second = recordCompactFailure(first, 11)
    const third = recordCompactFailure(second, 12)

    assert.equal(third.consecutiveFailures, 3)
    assert.equal(third.disabledUntilTurn, 15)
    assert.equal(decideCompactTier({ estimatedTokens: 900, maxTokens: 1000, turn: 13, failures: third }).shouldCompact, false)
    assert.deepEqual(recordCompactSuccess(third), { consecutiveFailures: 0 })
  })
})
```

- [x] **步骤 2：运行 policy 测试验证失败**

运行：

```bash
npx tsx --test src/context/__tests__/compact-policy.test.ts
```

预期：FAIL，报错包含：

```text
Cannot find module '../compact-policy.js'
```

- [x] **步骤 3：实现 compaction ladder policy**

创建 `src/context/compact-policy.ts`：

```ts
import type { CompactCircuitBreakerState, CompactDecision, CompactTier } from './types.js'

export interface CompactPolicyInput {
  estimatedTokens: number
  maxTokens: number
  turn: number
  failures: CompactCircuitBreakerState
}

function tierForRatio(ratio: number): CompactTier {
  if (ratio >= 0.95) return 4
  if (ratio >= 0.88) return 3
  if (ratio >= 0.78) return 2
  if (ratio >= 0.6) return 1
  return 0
}

function reasonForTier(tier: CompactTier): string {
  if (tier === 0) return 'context usage below watch threshold'
  if (tier === 1) return 'tool results exceeded watch threshold'
  if (tier === 2) return 'session memory compact recommended'
  if (tier === 3) return 'reactive round summarization required'
  return 'emergency truncation required'
}

export function decideCompactTier(input: CompactPolicyInput): CompactDecision {
  if (input.failures.disabledUntilTurn !== undefined && input.turn < input.failures.disabledUntilTurn) {
    return { tier: 0, reason: 'automatic compact circuit breaker is open', shouldCompact: false }
  }

  const ratio = input.maxTokens > 0 ? input.estimatedTokens / input.maxTokens : 1
  const tier = tierForRatio(ratio)
  return { tier, reason: reasonForTier(tier), shouldCompact: tier > 0 }
}

export function recordCompactFailure(state: CompactCircuitBreakerState, turn: number): CompactCircuitBreakerState {
  const consecutiveFailures = state.consecutiveFailures + 1
  return {
    consecutiveFailures,
    disabledUntilTurn: consecutiveFailures >= 3 ? turn + 3 : state.disabledUntilTurn,
  }
}

export function recordCompactSuccess(_state: CompactCircuitBreakerState): CompactCircuitBreakerState {
  return { consecutiveFailures: 0 }
}
```

- [x] **步骤 4：运行 policy 测试验证通过**

运行：

```bash
npx tsx --test src/context/__tests__/compact-policy.test.ts
```

预期：PASS。

- [x] **步骤 5：编写 reactive compact 失败测试**

创建 `src/context/__tests__/reactive-compact.test.ts`：

```ts
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { Message } from '../../api/types.js'
import { createCompactBoundaryMessage, selectReactiveCompactRounds } from '../reactive-compact.js'

describe('reactive compact', () => {
  it('selects middle safe rounds while preserving anchor and recent messages', () => {
    const messages: Message[] = [
      { role: 'user', content: 'anchor' },
      { role: 'assistant', content: 'anchor answer' },
      { role: 'user', content: 'old work' },
      { role: 'assistant', content: 'old answer' },
      { role: 'user', content: 'recent' },
      { role: 'assistant', content: 'recent answer' },
    ]

    const selected = selectReactiveCompactRounds(messages, { anchorMessages: 2, recentMessages: 2 })

    assert.deepEqual(selected.map(round => [round.startIndex, round.endIndex]), [[2, 3]])
  })

  it('creates a compact boundary message with source range metadata', () => {
    const message = createCompactBoundaryMessage({
      startIndex: 2,
      endIndex: 5,
      summary: 'User inspected test failures and fixed the parser.',
      tokenBefore: 4000,
      tokenAfter: 200,
    })

    assert.equal(message.role, 'user')
    assert.match(String(message.content), /<compact-summary/)
    assert.match(String(message.content), /source_start="2"/)
    assert.match(String(message.content), /token_before="4000"/)
  })
})
```

- [x] **步骤 6：实现 reactive compact helpers**

创建 `src/context/reactive-compact.ts`：

```ts
import type { Message } from '../api/types.js'
import { groupApiRounds } from './rounds.js'
import type { ApiRound } from './types.js'

export interface ReactiveRoundSelectionOptions {
  anchorMessages: number
  recentMessages: number
}

export interface CompactBoundaryInput {
  startIndex: number
  endIndex: number
  summary: string
  tokenBefore: number
  tokenAfter: number
}

export function selectReactiveCompactRounds(messages: Message[], options: ReactiveRoundSelectionOptions): ApiRound[] {
  const rounds = groupApiRounds(messages)
  const anchorEnd = Math.min(options.anchorMessages - 1, messages.length - 1)
  const recentStart = Math.max(0, messages.length - options.recentMessages)
  return rounds.filter(round => round.startIndex > anchorEnd && round.endIndex < recentStart && round.safe)
}

export function createCompactBoundaryMessage(input: CompactBoundaryInput): Message {
  return {
    role: 'user',
    content: `<compact-summary source_start="${input.startIndex}" source_end="${input.endIndex}" token_before="${input.tokenBefore}" token_after="${input.tokenAfter}">\n${input.summary}\n</compact-summary>`,
  }
}
```

- [x] **步骤 7：运行 reactive compact 测试验证通过**

运行：

```bash
npx tsx --test src/context/__tests__/reactive-compact.test.ts
```

预期：PASS。

- [x] **步骤 8：在 smartCompact 中使用 boundary message**

在 `src/compact/auto.ts` 导入：

```ts
import { createCompactBoundaryMessage, selectReactiveCompactRounds } from '../context/reactive-compact.js'
```

在 `smartCompact()` 中生成 compact message 的地方，把直接对象：

```ts
const compactMessage: Message = {
  role: 'user',
  content: `<compact-summary turns-removed="${oldMessages.length}">\n${summary}\n</compact-summary>`,
}
```

替换为：

```ts
const selectedRounds = selectReactiveCompactRounds(messages, {
  anchorMessages: CACHE_ANCHOR_MESSAGES,
  recentMessages: KEEP_RECENT_MESSAGES,
})
const firstRound = selectedRounds[0]
const lastRound = selectedRounds[selectedRounds.length - 1]
const compactMessage = createCompactBoundaryMessage({
  startIndex: firstRound?.startIndex ?? CACHE_ANCHOR_MESSAGES,
  endIndex: lastRound?.endIndex ?? Math.max(CACHE_ANCHOR_MESSAGES, messages.length - KEEP_RECENT_MESSAGES - 1),
  summary,
  tokenBefore: tokenCount,
  tokenAfter: Math.ceil(summary.length / 4),
})
```

保持现有返回形状不变：

```ts
return [...anchor, compactMessage, ...recent]
```

- [x] **步骤 9：运行 compact 相关测试和 typecheck**

运行：

```bash
npx tsx --test src/context/__tests__/compact-policy.test.ts src/context/__tests__/reactive-compact.test.ts src/compact/__tests__/compact.test.ts
npm run typecheck
```

预期：全部 PASS。

- [x] **步骤 10：Commit**

```bash
git add src/context/types.ts src/context/compact-policy.ts src/context/reactive-compact.ts src/context/__tests__/compact-policy.test.ts src/context/__tests__/reactive-compact.test.ts src/compact/auto.ts src/compact/__tests__/compact.test.ts
git commit -m "feat(compact): add progressive compact policy"
```

---

## 任务 6：实现 Session Memory 与 `/memory` 命令

**文件：**
- 创建：`src/context/session-memory.ts`
- 创建：`src/context/__tests__/session-memory.test.ts`
- 修改：`src/context/types.ts`
- 修改：`src/agent/session-persist.ts`
- 修改：`src/tui/app.tsx`
- 测试：`src/context/__tests__/session-memory.test.ts`、`src/agent/__tests__/session-persist.test.ts`

- [x] **步骤 1：扩展 memory 类型并写失败测试**

在 `src/context/types.ts` 追加：

```ts
export interface SessionMemoryEntry {
  id: string
  createdAt: number
  text: string
  source: 'manual' | 'compact' | 'resume'
}

export interface SessionMemoryState {
  sessionId: string
  entries: SessionMemoryEntry[]
}
```

创建 `src/context/__tests__/session-memory.test.ts`：

```ts
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { appendSessionMemory, buildSessionMemoryBlock, loadSessionMemory } from '../session-memory.js'

describe('session memory', () => {
  it('appends and loads memory entries for a session', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rivet-memory-'))
    try {
      const first = appendSessionMemory(dir, 's1', { text: 'User prefers design docs before implementation.', source: 'manual', createdAt: 1000 })
      const second = appendSessionMemory(dir, 's1', { text: 'Context engine design is saved.', source: 'compact', createdAt: 2000 })
      const loaded = loadSessionMemory(dir, 's1')

      assert.equal(first.entries.length, 1)
      assert.equal(second.entries.length, 2)
      assert.deepEqual(loaded.entries.map(entry => entry.text), [
        'User prefers design docs before implementation.',
        'Context engine design is saved.',
      ])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('builds a stable XML memory block', () => {
    const block = buildSessionMemoryBlock({
      sessionId: 's2',
      entries: [{ id: 'm1', createdAt: 1000, text: 'Keep API rounds safe.', source: 'manual' }],
    })

    assert.match(block, /<session-memory/)
    assert.match(block, /source="manual"/)
    assert.match(block, /Keep API rounds safe\./)
  })
})
```

- [x] **步骤 2：运行测试验证失败**

运行：

```bash
npx tsx --test src/context/__tests__/session-memory.test.ts
```

预期：FAIL，报错包含：

```text
Cannot find module '../session-memory.js'
```

- [x] **步骤 3：实现 session memory 文件读写**

创建 `src/context/session-memory.ts`：

```ts
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import type { SessionMemoryEntry, SessionMemoryState } from './types.js'

function memoryPath(dir: string, sessionId: string): string {
  return join(dir, `${sessionId}.memory.json`)
}

function idFor(input: { text: string; createdAt: number; source: SessionMemoryEntry['source'] }): string {
  return createHash('sha256').update(`${input.createdAt}:${input.source}:${input.text}`).digest('hex').slice(0, 12)
}

export function loadSessionMemory(dir: string, sessionId: string): SessionMemoryState {
  const filePath = memoryPath(dir, sessionId)
  if (!existsSync(filePath)) return { sessionId, entries: [] }
  try {
    return JSON.parse(readFileSync(filePath, 'utf-8')) as SessionMemoryState
  } catch {
    return { sessionId, entries: [] }
  }
}

export function appendSessionMemory(
  dir: string,
  sessionId: string,
  input: { text: string; source: SessionMemoryEntry['source']; createdAt: number },
): SessionMemoryState {
  const state = loadSessionMemory(dir, sessionId)
  const entry: SessionMemoryEntry = { id: idFor(input), ...input }
  const next: SessionMemoryState = { sessionId, entries: [...state.entries, entry].slice(-50) }
  writeFileSync(memoryPath(dir, sessionId), JSON.stringify(next, null, 2) + '\n')
  return next
}

function escapeXml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

export function buildSessionMemoryBlock(state: SessionMemoryState): string {
  if (state.entries.length === 0) return ''
  const entries = state.entries.map(entry => (
    `<entry id="${entry.id}" created_at="${entry.createdAt}" source="${entry.source}">${escapeXml(entry.text)}</entry>`
  ))
  return `<session-memory session_id="${state.sessionId}">\n${entries.join('\n')}\n</session-memory>`
}
```

- [x] **步骤 4：运行 memory 测试验证通过**

运行：

```bash
npx tsx --test src/context/__tests__/session-memory.test.ts
```

预期：PASS。

- [x] **步骤 5：把 memory 代理方法接入 SessionPersist**

在 `src/agent/session-persist.ts` 导入：

```ts
import { appendSessionMemory, buildSessionMemoryBlock, loadSessionMemory } from '../context/session-memory.js'
import type { SessionMemoryEntry, SessionMemoryState } from '../context/types.js'
```

为 class 增加 session id 与目录字段：

```ts
private sessionId: string
private sessionDir: string
```

在 constructor 中设置：

```ts
this.sessionId = sessionId
this.sessionDir = sessionDir
```

追加方法：

```ts
loadMemory(): SessionMemoryState {
  return loadSessionMemory(this.sessionDir, this.sessionId)
}

appendMemory(input: { text: string; source: SessionMemoryEntry['source']; createdAt: number }): SessionMemoryState {
  return appendSessionMemory(this.sessionDir, this.sessionId, input)
}

buildMemoryBlock(): string {
  return buildSessionMemoryBlock(this.loadMemory())
}
```

- [x] **步骤 6：在 TUI 中实现 `/memory` 命令**

在 `src/tui/app.tsx` 的命令 switch 中增加：

```ts
case '/memory': {
  const text = parts.slice(1).join(' ').trim()
  if (!text) {
    const memory = persist.loadMemory()
    const content = memory.entries.length === 0
      ? 'Session memory is empty.'
      : memory.entries.map(entry => `- [${entry.source}] ${entry.text}`).join('\n')
    addLog(createLogEntry({ type: 'text', content }))
    flushLogs()
    setIsStreaming(false)
    return
  }

  persist.appendMemory({ text, source: 'manual', createdAt: Date.now() })
  session.setSessionMemorySummary(text)
  addLog(createLogEntry({ type: 'text', content: 'Saved to session memory.' }))
  flushLogs()
  setIsStreaming(false)
  return
}
```

该命令行为：
- `/memory` 展示当前 session memory。
- `/memory <text>` 追加一条 manual memory。
- 不写入全局 Claude memory，不影响其他项目。

- [x] **步骤 7：运行相关测试和 typecheck**

运行：

```bash
npx tsx --test src/context/__tests__/session-memory.test.ts src/agent/__tests__/session-persist.test.ts
npm run typecheck
```

预期：全部 PASS。

- [x] **步骤 8：Commit**

```bash
git add src/context/types.ts src/context/session-memory.ts src/context/__tests__/session-memory.test.ts src/agent/session-persist.ts src/agent/__tests__/session-persist.test.ts src/tui/app.tsx
git commit -m "feat(context): add session memory sidecar"
```

---

## 任务 7：升级 Prompt Volatile Context Layers

**文件：**
- 修改：`src/prompt/volatile.ts`
- 修改：`src/prompt/__tests__/engine.test.ts`
- 创建：`src/prompt/__tests__/volatile.test.ts`
- 修改：`src/agent/loop.ts`
- 测试：`src/prompt/__tests__/volatile.test.ts`、`src/prompt/__tests__/engine.test.ts`

- [x] **步骤 1：编写 volatile layers 失败测试**

创建 `src/prompt/__tests__/volatile.test.ts`：

```ts
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { ContextLedger } from '../../context/types.js'
import { buildVolatileBlock } from '../volatile.js'

function ledger(): ContextLedger {
  return {
    estimatedTokens: 1200,
    maxTokens: 10000,
    usageRatio: 0.12,
    health: 'healthy',
    apiSafe: true,
    roundCount: 3,
    diagnostics: [],
    sections: [{ name: 'history', estimatedTokens: 400, digest: 'abcdef1234567890' }],
    workingSet: ['src/main.tsx'],
    compactEvents: [],
  }
}

describe('volatile context layers', () => {
  it('renders environment, ledger, working set, and memory as stable XML sections', () => {
    const block = buildVolatileBlock({
      cwd: '/repo',
      rivetMd: 'Use TDD.',
      gitStatus: 'M src/main.tsx',
      workingSet: ['src/main.tsx'],
      contextLedger: ledger(),
      sessionMemoryBlock: '<session-memory session_id="s1"><entry id="m1" created_at="1" source="manual">Keep rounds safe.</entry></session-memory>',
    })

    assert.match(block, /<context>/)
    assert.match(block, /<environment>/)
    assert.match(block, /<context-ledger health="healthy" api_safe="true"/)
    assert.match(block, /<working-set>/)
    assert.match(block, /<session-memory/)
    assert.match(block, /<git-status>/)
  })
})
```

- [x] **步骤 2：运行测试验证失败**

运行：

```bash
npx tsx --test src/prompt/__tests__/volatile.test.ts
```

预期：FAIL，原因是 `VolatileContext` 不支持 `contextLedger` 和 `sessionMemoryBlock`，输出仍是 markdown headings。

- [x] **步骤 3：修改 volatile context 类型和 XML escaping**

在 `src/prompt/volatile.ts` 导入：

```ts
import type { ContextLedger } from '../context/types.js'
```

扩展 `VolatileContext`：

```ts
contextLedger?: ContextLedger
sessionMemoryBlock?: string
```

增加 escape helper：

```ts
function escapeXml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}
```

- [x] **步骤 4：把 buildVolatileBlock 改为 stable XML layers**

把 `buildVolatileBlock()` 替换为：

```ts
export function buildVolatileBlock(ctx: VolatileContext): string {
  const parts: string[] = []

  parts.push(`<environment platform="${process.platform}" cwd="${escapeXml(ctx.cwd)}" os="${escapeXml(`${os.type()} ${os.release()}`)}" />`)

  const md = ctx.rivetMd ?? readRivetMd(ctx.cwd)
  if (md) {
    parts.push(`<project-instructions>\n${escapeXml(md)}\n</project-instructions>`)
  }

  const git = ctx.gitStatus ?? gitStatusCache.get(ctx.cwd)
  if (git) {
    parts.push(`<git-status>\n${escapeXml(git)}\n</git-status>`)
  }

  if (ctx.workingSet && ctx.workingSet.length > 0) {
    const files = ctx.workingSet.map(file => `<file>${escapeXml(file)}</file>`).join('\n')
    parts.push(`<working-set>\n${files}\n</working-set>`)
  }

  if (ctx.contextLedger) {
    const sections = ctx.contextLedger.sections.map(section => (
      `<section name="${section.name}" tokens="${section.estimatedTokens}" digest="${section.digest}" />`
    )).join('\n')
    parts.push(`<context-ledger health="${ctx.contextLedger.health}" api_safe="${ctx.contextLedger.apiSafe}" tokens="${ctx.contextLedger.estimatedTokens}" max_tokens="${ctx.contextLedger.maxTokens}" rounds="${ctx.contextLedger.roundCount}">\n${sections}\n</context-ledger>`)
  }

  if (ctx.sessionMemoryBlock) {
    parts.push(ctx.sessionMemoryBlock)
  }

  return parts.length > 0 ? `<context>\n${parts.join('\n\n')}\n</context>` : ''
}
```

- [x] **步骤 5：运行 volatile 测试验证通过**

运行：

```bash
npx tsx --test src/prompt/__tests__/volatile.test.ts
```

预期：PASS。

- [x] **步骤 6：在 agent loop 构建请求前传入 ledger 和 memory block**

在 `src/agent/loop.ts` 中找到构造 `PromptEngine` request 或 volatile context 的位置，将已有参数扩展为：

```ts
volatileContext: {
  cwd: this.config.cwd,
  gitStatus,
  workingSet: this.session.getWorkingSet(),
  contextLedger: this.session.getContextLedger(),
  sessionMemoryBlock: this.persist.buildMemoryBlock(),
}
```

如果当前 loop 没有直接持有 `persist`，在 TUI 创建 `AgentLoop` 时传入一个回调：

```ts
getSessionMemoryBlock: () => persist.buildMemoryBlock(),
```

并在 `AgentConfig` 类型中增加：

```ts
getSessionMemoryBlock?: () => string
```

然后构建 volatile context 时使用：

```ts
sessionMemoryBlock: this.config.getSessionMemoryBlock?.(),
```

- [x] **步骤 7：增加 prompt engine 回归测试**

在 `src/prompt/__tests__/engine.test.ts` 追加测试，确认 context XML 仍作为独立 user message 插入在用户输入之前：

```ts
it('injects volatile XML context before the user message', () => {
  const engine = makeEngine({
    volatileContext: {
      cwd: '/repo',
      rivetMd: 'Use TDD.',
      gitStatus: 'M src/main.tsx',
      workingSet: ['src/main.tsx'],
    },
  })

  const request = engine.buildRequest([{ role: 'user', content: 'continue' }])

  assert.equal(request.messages[0]!.role, 'user')
  assert.match(String(request.messages[0]!.content), /<context>/)
  assert.match(String(request.messages[0]!.content), /<environment/)
  assert.equal(request.messages[1]!.content, 'continue')
})
```

- [x] **步骤 8：运行 prompt tests 和 typecheck**

运行：

```bash
npx tsx --test src/prompt/__tests__/volatile.test.ts src/prompt/__tests__/engine.test.ts
npm run typecheck
```

预期：全部 PASS。

- [x] **步骤 9：Commit**

```bash
git add src/prompt/volatile.ts src/prompt/__tests__/volatile.test.ts src/prompt/__tests__/engine.test.ts src/agent/loop.ts
git commit -m "feat(prompt): layer volatile context metadata"
```

---

## 任务 8：实现 TUI Context Cockpit、`/context` 和 StatusBar 健康显示

**文件：**
- 修改：`src/tui/status-bar.tsx`
- 修改：`src/tui/app.tsx`
- 修改：`src/tui/__tests__/log-state.test.ts`
- 创建：`src/tui/__tests__/status-bar.test.tsx`
- 修改：`README.md`
- 测试：TUI tests、typecheck

- [x] **步骤 1：编写 StatusBar context health 失败测试**

创建 `src/tui/__tests__/status-bar.test.tsx`：

```tsx
import { render } from 'ink-testing-library'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { StatusBar } from '../status-bar.js'

describe('StatusBar context health', () => {
  it('renders context health and API safety state', () => {
    const { lastFrame } = render(
      <StatusBar
        model="deepseek-chat"
        cacheHitRate={0.91}
        totalCost="0.10"
        currentTokens={1200}
        maxTokens={10000}
        contextHealth="healthy"
        apiSafe={true}
        compactTier={0}
      />,
    )

    const frame = lastFrame() ?? ''
    assert.match(frame, /ctx:healthy/)
    assert.match(frame, /rounds:safe/)
    assert.match(frame, /tier:0/)
  })
})
```

- [x] **步骤 2：运行测试验证失败**

运行：

```bash
npx tsx --test src/tui/__tests__/status-bar.test.tsx
```

预期：FAIL，TypeScript 报 `contextHealth`、`apiSafe`、`compactTier` props 不存在。

- [x] **步骤 3：扩展 StatusBar props 和渲染**

在 `src/tui/status-bar.tsx` 导入：

```ts
import type { CompactTier, ContextHealthLevel } from '../context/types.js'
```

扩展 props：

```ts
contextHealth?: ContextHealthLevel
apiSafe?: boolean
compactTier?: CompactTier
```

在组件参数中加入默认值：

```ts
contextHealth = 'healthy',
apiSafe = true,
compactTier = 0,
```

在左侧 Box 中追加：

```tsx
<Text color={contextHealth === 'critical' ? 'red' : contextHealth === 'compact' ? 'yellow' : contextHealth === 'watch' ? 'yellow' : 'green'}>
  ctx:{contextHealth}
</Text>
<Text color={apiSafe ? 'green' : 'red'}>
  rounds:{apiSafe ? 'safe' : 'check'}
</Text>
<Text dimColor>
  tier:{compactTier}
</Text>
```

- [x] **步骤 4：运行 StatusBar 测试验证通过**

运行：

```bash
npx tsx --test src/tui/__tests__/status-bar.test.tsx
```

预期：PASS。

- [x] **步骤 5：在 app.tsx 中向 StatusBar 传入 ledger 状态**

在 `src/tui/app.tsx` 渲染 `StatusBar` 前增加：

```ts
const contextLedger = session.getContextLedger()
```

把 `StatusBar` props 扩展为：

```tsx
<StatusBar
  model={model}
  cacheHitRate={cacheHitRate}
  totalCost={cost.toFixed(2)}
  currentTokens={currentTokens}
  maxTokens={maxTokens}
  contextHealth={contextLedger?.health ?? 'healthy'}
  apiSafe={contextLedger?.apiSafe ?? true}
  compactTier={contextLedger?.health === 'critical' ? 4 : contextLedger?.health === 'compact' ? 2 : contextLedger?.health === 'watch' ? 1 : 0}
/>
```

- [x] **步骤 6：实现 `/context` 命令**

在 `src/tui/app.tsx` 命令 switch 中增加：

```ts
case '/context': {
  const ledger = session.getContextLedger()
  if (!ledger) {
    addLog(createLogEntry({ type: 'text', content: 'Context ledger is not available yet. Send a message to build the first ledger snapshot.' }))
    flushLogs()
    setIsStreaming(false)
    return
  }

  const sections = ledger.sections
    .map(section => `- ${section.name}: ${section.estimatedTokens.toLocaleString()} tokens (${section.digest})`)
    .join('\n')
  const diagnostics = ledger.diagnostics.length === 0
    ? 'API rounds: safe'
    : ledger.diagnostics.map(item => `- ${item.code}: ${item.detail}`).join('\n')
  const compacts = ledger.compactEvents.length === 0
    ? 'No compact events recorded.'
    : ledger.compactEvents.map(event => `- turn ${event.turn}: tier ${event.tier}, ${event.beforeTokens} -> ${event.afterTokens}, ${event.reason}`).join('\n')

  addLog(createLogEntry({
    type: 'text',
    content: `Context health: ${ledger.health}\nTokens: ${ledger.estimatedTokens.toLocaleString()}/${ledger.maxTokens.toLocaleString()} (${Math.round(ledger.usageRatio * 100)}%)\nRounds: ${ledger.roundCount}\n${diagnostics}\n\nSections:\n${sections}\n\nCompaction:\n${compacts}`,
  }))
  flushLogs()
  setIsStreaming(false)
  return
}
```

- [x] **步骤 7：在 agent loop 每 turn 后刷新 ledger**

在 `src/agent/loop.ts` 中导入：

```ts
import { buildContextLedger } from '../context/ledger.js'
```

在每次 request 前或 turn 完成后设置 ledger：

```ts
const messages = this.session.getMessages()
const ledger = buildContextLedger({
  messages,
  maxTokens: this.config.maxTokens,
  workingSet: this.session.getWorkingSet(),
  compactEvents: this.session.getCompactEvents(),
  staticTokens: 0,
  toolsTokens: 0,
  volatileTokens: 0,
  memoryTokens: 0,
})
this.session.setContextLedger(ledger)
```

如果 `AgentConfig` 里实际字段名不是 `maxTokens`，使用当前 loop 已用于 `currentTokens/maxTokens` 的同一个 context window 值，保证 StatusBar 与 auto compact 使用同一预算。

- [x] **步骤 8：README 增加用户命令说明**

在 `README.md` 的 CLI/TUI 命令区追加：

```md
### Context cockpit

- `/context` — show Context Ledger health, token sections, API round diagnostics, and compact events.
- `/memory` — list session memory entries.
- `/memory <text>` — save a manual session memory entry for the current Rivet session.

The status bar shows `ctx:<level>`, `rounds:safe|check`, and `tier:<n>` so long sessions can be inspected before they hit provider limits.
```

- [x] **步骤 9：运行 TUI tests、typecheck、build**

运行：

```bash
npx tsx --test src/tui/__tests__/status-bar.test.tsx src/tui/__tests__/log-state.test.ts
npm run typecheck
npm run build
```

预期：全部 PASS，build 成功。

- [x] **步骤 10：Commit**

```bash
git add src/tui/status-bar.tsx src/tui/app.tsx src/tui/__tests__/status-bar.test.tsx src/tui/__tests__/log-state.test.ts README.md src/agent/loop.ts
git commit -m "feat(tui): add context cockpit status"
```

---

## 任务 9：集成自动压缩、manual compact 和 compact event 记录

**文件：**
- 修改：`src/agent/loop.ts`
- 修改：`src/tui/app.tsx`
- 修改：`src/compact/auto.ts`
- 修改：`src/context/compact-policy.ts`
- 创建或修改：`src/agent/__tests__/loop.test.ts`
- 测试：loop、compact、typecheck、build

- [x] **步骤 1：编写 loop 自动 compact policy 失败测试**

在 `src/agent/__tests__/loop.test.ts` 追加适合当前 mock client 的测试。如果现有 test harness 使用 `createMockClient()`，添加：

```ts
it('records compact event when auto compact changes message history', async () => {
  const loop = createLoopWithMessages([
    { role: 'user', content: 'x'.repeat(9000) },
    { role: 'assistant', content: 'old answer' },
    { role: 'user', content: 'continue' },
  ], { maxTokens: 1000 })

  await loop.runTurn('summarize')

  assert.equal(loop.session.getCompactEvents().length > 0, true)
  assert.equal(loop.session.getContextLedger()?.apiSafe, true)
})
```

如果 `loop.test.ts` 没有 `createLoopWithMessages()`，先在测试文件内添加本地 helper，使用当前测试已有 mock client/config 构造方式，确保只服务这个测试。

- [x] **步骤 2：运行 loop 测试验证失败**

运行：

```bash
npx tsx --test src/agent/__tests__/loop.test.ts
```

预期：FAIL，原因是 auto compact 未记录 compact event 或 ledger 未刷新。

- [x] **步骤 3：在 loop 中应用 compact policy**

在 `src/agent/loop.ts` 导入：

```ts
import { decideCompactTier, recordCompactFailure, recordCompactSuccess } from '../context/compact-policy.js'
import type { CompactCircuitBreakerState } from '../context/types.js'
```

在 `AgentLoop` class 中增加字段：

```ts
private compactFailures: CompactCircuitBreakerState = { consecutiveFailures: 0 }
```

在自动 compact 判断处替换为：

```ts
const ledger = this.session.getContextLedger()
const decision = decideCompactTier({
  estimatedTokens: ledger?.estimatedTokens ?? this.session.getEstimatedTokens(),
  maxTokens: ledger?.maxTokens ?? this.config.maxTokens,
  turn: this.session.getTurnCount(),
  failures: this.compactFailures,
})

if (decision.shouldCompact) {
  const beforeTokens = ledger?.estimatedTokens ?? this.session.getEstimatedTokens()
  try {
    const beforeMessages = this.session.getMessages()
    const compacted = await this.compactMessages(beforeMessages, decision.tier)
    this.session.replaceMessages(compacted)
    const afterTokens = this.session.getEstimatedTokens()
    this.session.recordCompactEvent({
      turn: this.session.getTurnCount(),
      tier: decision.tier === 0 ? 1 : decision.tier,
      reason: decision.reason,
      beforeTokens,
      afterTokens,
      createdAt: Date.now(),
    })
    this.compactFailures = recordCompactSuccess(this.compactFailures)
  } catch (error) {
    this.compactFailures = recordCompactFailure(this.compactFailures, this.session.getTurnCount())
    throw error
  }
}
```

如果当前 loop 没有 `compactMessages()`, 添加 private 方法：

```ts
private async compactMessages(messages: Message[], tier: number): Promise<Message[]> {
  if (tier <= 1) {
    return microCompact(messages, this.config.maxTokens, this.session.getEstimatedTokens()).messages
  }
  return smartCompact(this.client, messages, this.session.getEstimatedTokens(), this.config.maxTokens, this.config.compactModel)
}
```

使用当前实际 config 字段名替换 `maxTokens` 与 `compactModel`，不要新增重复配置。

- [x] **步骤 4：manual `/compact` 记录 compact event**

在 `src/tui/app.tsx` 的 `/compact` 分支中，在 `session.replaceMessages(compacted)` 后追加：

```ts
session.recordCompactEvent({
  turn: session.getTurnCount(),
  tier: 1,
  reason: 'manual /compact command',
  beforeTokens: estimateTokens(msgs),
  afterTokens: estimateTokens(compacted),
  createdAt: Date.now(),
})
```

如果 `estimateTokens(compacted)` 当前函数只接受 message array，直接使用；如果变量名不同，使用当前 `/compact` 分支中已用于计算 token 的同一函数。

- [x] **步骤 5：metadata sidecar 保存 compact events**

在每次记录 compact event 后，如果当前上下文能访问 `SessionPersist`，调用：

```ts
persist.writeMetadata({
  sessionId,
  updatedAt: Date.now(),
  compactEvents: session.getCompactEvents(),
  lastLedger: session.getContextLedger(),
})
```

在 TUI `/compact` 分支中使用当前 session id 变量；如果该变量当前只存在于创建 `SessionPersist` 的闭包中，提升为稳定常量：

```ts
const sessionIdRef = useRef(sessionId)
```

然后使用：

```ts
sessionId: sessionIdRef.current,
```

- [x] **步骤 6：运行 loop 和 compact 测试**

运行：

```bash
npx tsx --test src/agent/__tests__/loop.test.ts src/compact/__tests__/compact.test.ts src/context/__tests__/compact-policy.test.ts
npm run typecheck
```

预期：全部 PASS。

- [x] **步骤 7：运行完整验证**

运行：

```bash
npm test
npm run build
```

预期：测试全通过，build 成功。

- [x] **步骤 8：Commit**

```bash
git add src/agent/loop.ts src/agent/__tests__/loop.test.ts src/tui/app.tsx src/compact/auto.ts src/context/compact-policy.ts
git commit -m "feat(context): record progressive compaction events"
```

---

## 任务 10：最终集成验证与文档收口

**文件：**
- 修改：`README.md`
- 修改：`docs/analysis/2026-05-15-handoff.md`（只追加无密钥的进度说明）
- 修改：`.wolf/anatomy.md`
- 修改：`.wolf/memory.md`
- 测试：完整 test/typecheck/build

- [x] **步骤 1：运行完整验证**

运行：

```bash
npm run typecheck
npm test
npm run build
```

预期：

```text
npm run typecheck exits 0
npm test exits 0
npm run build exits 0
```

- [x] **步骤 2：做 secret pattern 检查**

运行：

```bash
git diff -- . ':!package-lock.json' | grep -E "sk-[A-Za-z0-9_-]{8,}|api[_-]?key|secret|token" || true
```

预期：不出现真实 key、token 或 credential fragment。允许出现文档中的普通词 `token`、`apiSafe`、`maxTokens`，但不允许出现真实密钥值。

- [x] **步骤 3：更新 README 的实现状态**

在 `README.md` 的 Context Cockpit 小节下追加：

```md
Implementation notes:

- Context Ledger validates API-safe rounds before long histories are sent to providers.
- Microcompact shortens large tool results before dropping complete safe rounds.
- Resume preflight repairs interrupted tool calls with synthetic error tool results.
- Session memory is stored as a local sidecar file and injected through the volatile context layer.
```

- [x] **步骤 4：更新 handoff 文档，不写入密钥**

在 `docs/analysis/2026-05-15-handoff.md` 的当前进度区域追加：

```md
### 2026-05-16 Progressive Context Engine

- Added API round validation, resume preflight, context ledger health, session memory, and progressive compaction policy.
- Validation: `npm run typecheck`, `npm test`, and `npm run build` pass locally.
- Security note: no API keys or credential fragments were added to docs, tests, logs, or memory files.
```

- [x] **步骤 5：更新 OpenWolf anatomy 和 memory**

在 `.wolf/anatomy.md` 的相关目录中加入新增文件条目，保持简短摘要。

在 `.wolf/memory.md` 追加一条无密钥工作记录：

```md
- 2026-05-16: Implemented Progressive Context Engine core: API round validation, Context Ledger, resume preflight, session memory, context cockpit, and progressive compaction policy. Verified with typecheck, tests, and build.
```

- [x] **步骤 6：查看 git 状态和差异**

运行：

```bash
git status --short
git diff --stat
```

预期：只出现本计划范围内的文件变更；没有 `.env`、credential、临时日志、大型二进制文件。

- [x] **步骤 7：最终 commit**

```bash
git add README.md docs/analysis/2026-05-15-handoff.md .wolf/anatomy.md .wolf/memory.md
git commit -m "docs: document progressive context engine"
```

---

## 执行顺序与验收标准

按任务 1 → 10 顺序执行。每个任务的 commit 都应在本任务测试通过后创建；不要把多个任务挤到一个 commit，除非用户明确要求压缩提交。

最终验收必须满足：

```bash
npm run typecheck
npm test
npm run build
```

全部通过，并且：

- `PromptEngine.buildRequest()` 输出的历史通过 `validateApiRounds(groupApiRounds(request.messages))`。
- `/resume` 对中断后的工具调用历史执行 preflight 修复。
- `/context` 能展示 Context Ledger、token sections、API diagnostics、compact events。
- StatusBar 展示 `ctx:<level>`、`rounds:safe|check`、`tier:<n>`。
- `microCompact()` 不破坏 assistant `tool_use` / user `tool_result` 相邻关系。
- session memory 只写入本地 sidecar，不写入全局记忆系统。
- 文档、测试、日志中没有真实 API key、token 或 credential fragment。

## 风险与控制

- **API round 分组错误会造成 provider 400。** 控制：每次 compaction 和 resume 后都运行 `validateApiRounds()`；PromptEngine normalizer 保留为最后防线。
- **压缩过度会丢失近期工作上下文。** 控制：保留 cache anchor 和 recent window；Tier 1 先缩短 tool results，Tier 3 才总结中间 rounds。
- **自动压缩失败可能形成循环。** 控制：compact circuit breaker 连续 3 次失败后暂停 3 个 turn。
- **session memory 可能污染 prompt。** 控制：仅手动 `/memory <text>` 和 compact summary 写入，XML escape，最多保留 50 条。
- **StatusBar 过载影响 TUI 可读性。** 控制：只显示 health、round safety、tier 三个短字段，详情放在 `/context`。

## 交接选项

计划已保存后有两种执行方式：

1. **子代理驱动（推荐）** — 每个任务调度一个新子代理，任务间进行 review，适合并行实现与隔离验证。
2. **内联执行** — 在当前会话中按任务顺序执行，每个任务完成后运行测试并 commit。

用户已说明”我来安排开发”，因此本文件到此为开发交接产物；如果后续需要我执行，建议从任务 1 开始按 commit 边界推进。

---

## 实施记录

**状态：已完成** (2026-05-16)

**Commits:**
- `68b892e` — docs: user manual, prompt layering docs, cache optimization guide
- `2b6bad1` — docs: P3 design specs + fix remaining test and TUI files
- `e2446ce` — fix(security): P3 code review — 11 issues across 7 files
- `ef260f1` — refactor(prompt): move environment vars from L1 system prompt to L4 volatile block
- `f0296b9` — feat(compact): preserve cache anchor messages after compaction
- `2c7c70f` — feat(context): wire progressive context engine into runtime
- `c217d3a` — fix(context): code review fixes — 3 HIGH + 3 MEDIUM + 1 LOW

**关键变更：**
- PromptEngine 冻结 volatile block 在构造时，防止 prefix cache 被打穿
- Token 显示从 `getTotalUsage().input_tokens`（累计）改为 `getEstimatedTokens()`（实际估算）
- Session ID 验证提取到 `src/validation.ts` 的 `assertValidSessionId`
- Resume preflight 修复为在 orphan tool_use 之后插入 synthetic results
- Microcompact 加 negative savings guard（stub >= original 时跳过）
- Compact tier 从硬编码 `1` 改为按实际策略决定（micro=1, smart=2）
- Loop.ts 接入 `decideCompactTier` + `createContextLedger` 双决策链
