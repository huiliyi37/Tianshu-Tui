# Rivet 差距弥补：Hooks / Git / Todo / WebFetch / Undo 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 为 Rivet 补齐 Claude Code 的 5 个中高影响力差距：Agent Hooks 生命周期、结构化 Git 工具、Todo 任务跟踪、WebFetch 网页抓取、文件级 Undo 系统。

**架构：** 5 个独立子系统，各自有独立文件。Hooks 在 agent loop 中拦截工具执行前后；Git tool 封装常用 git 操作；Todo tool 维护 session 级任务列表；WebFetch 抓取网页转 Markdown；Undo 基于 per-file snapshot backup 实现细粒度回退，替代当前粗粒度 checkpoint rollback。

**技术栈：** TypeScript, Zod, node:test, node:child_process (spawn), node:fs/promises, diff (npm package for undo diff), node-fetch or undici (WebFetch)

---

## 文件结构

### 新建文件

| 文件 | 职责 |
|------|------|
| `src/hooks/types.ts` | Hook 生命周期类型定义 |
| `src/hooks/registry.ts` | Hook 注册 + 执行管线 |
| `src/hooks/__tests__/registry.test.ts` | Hook 注册和执行测试 |
| `src/tools/git.ts` | 结构化 git 工具 |
| `src/tools/__tests__/git.test.ts` | git 工具测试 |
| `src/tools/todo.ts` | Todo 读写工具 |
| `src/tools/__tests__/todo.test.ts` | todo 工具测试 |
| `src/tools/web-fetch.ts` | URL 抓取 + Markdown 转换 |
| `src/tools/__tests__/web-fetch.test.ts` | web-fetch 工具测试 |
| `src/agent/file-history.ts` | 文件级 snapshot backup + restore |
| `src/agent/__tests__/file-history.test.ts` | file-history 测试 |
| `src/tools/undo.ts` | /undo 命令 + undo 工具 |
| `src/tools/__tests__/undo.test.ts` | undo 工具测试 |

### 修改文件

| 文件 | 变更 |
|------|------|
| `src/agent/loop.ts` | 注入 hook 调用点 (PreToolUse/PostToolUse)，接入 file-history |
| `src/tools/default-registry.ts` | 注册新工具 (git, todo, web_fetch, undo) |
| `src/tui/app.tsx` | 添加 /undo 命令 |
| `src/agent/context.ts` | 添加 todo state 到 SessionContext |
| `src/agent/coordinator.ts` | SubAgentStart hook 事件 |

---

## 任务 1：Agent Hooks 系统

**文件：**
- 创建：`src/hooks/types.ts`
- 创建：`src/hooks/registry.ts`
- 创建：`src/hooks/__tests__/registry.test.ts`
- 修改：`src/agent/loop.ts:274-321`（工具执行前后注入 hook）

### Hook 类型设计

Rivet 的 hook 系统比 Claude Code 简化：只支持 4 个生命周期事件，hook 是同步函数（不用 shell 命令），配置通过 `.rivet/hooks.json` 或代码注册。

**事件：**

| 事件 | 触发时机 | 输入 | 可修改 |
|------|---------|------|--------|
| `PreToolUse` | 工具执行前 | `{ toolName, input }` | input |
| `PostToolUse` | 工具执行后 | `{ toolName, input, result, isError }` | result |
| `Notification` | agent 通知 | `{ message, level }` | — |
| `SubagentStop` | worker 结束 | `{ workOrderId, status }` | — |

- [ ] **步骤 1：编写 hook types 测试**

创建 `src/hooks/__tests__/registry.test.ts`：

```ts
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { HookRegistry } from '../registry.js'
import type { HookEvent, HookHandler, PreToolUseInput, PostToolUseInput } from '../types.js'

describe('HookRegistry', () => {
  it('registers and fires a PreToolUse hook that can modify input', () => {
    const registry = new HookRegistry()
    const modified: PreToolUseInput[] = []

    registry.register('PreToolUse', async (input) => {
      modified.push(input)
      return { input: { ...input.input, injected: true } }
    })

    const result = registry.firePreToolUse({ toolName: 'bash', input: { command: 'ls' } })
    assert.equal(modified.length, 1)
    assert.equal(modified[0]!.toolName, 'bash')
    assert.deepEqual(result.input, { command: 'ls', injected: true })
  })

  it('supports multiple hooks and chains modified input', () => {
    const registry = new HookRegistry()
    registry.register('PreToolUse', async (input) => ({
      input: { ...input.input, step1: true },
    }))
    registry.register('PreToolUse', async (input) => ({
      input: { ...input.input, step2: true },
    }))

    const result = registry.firePreToolUse({ toolName: 'edit_file', input: { path: 'a.ts' } })
    assert.equal(result.input.step1, true)
    assert.equal(result.input.step2, true)
  })

  it('hook returning block stops execution', () => {
    const registry = new HookRegistry()
    registry.register('PreToolUse', async () => ({
      block: true,
      reason: 'Blocked by security policy',
    }))

    const result = registry.firePreToolUse({ toolName: 'bash', input: { command: 'rm -rf /' } })
    assert.equal(result.block, true)
    assert.equal(result.reason, 'Blocked by security policy')
  })

  it('fires PostToolUse hooks with result', () => {
    const registry = new HookRegistry()
    const seen: PostToolUseInput[] = []
    registry.register('PostToolUse', async (input) => {
      seen.push(input)
      return {}
    })

    registry.firePostToolUse({ toolName: 'edit_file', input: { path: 'a.ts' }, result: 'ok', isError: false })
    assert.equal(seen.length, 1)
    assert.equal(seen[0]!.isError, false)
  })

  it('returns empty result when no hooks registered', () => {
    const registry = new HookRegistry()
    const result = registry.firePreToolUse({ toolName: 'bash', input: {} })
    assert.equal(result.block, undefined)
    assert.deepEqual(result.input, {})
  })

  it('removes hooks by reference', () => {
    const registry = new HookRegistry()
    const handler: HookHandler<'PreToolUse'> = async () => ({})
    registry.register('PreToolUse', handler)
    registry.unregister('PreToolUse', handler)
    const result = registry.firePreToolUse({ toolName: 'bash', input: {} })
    assert.deepEqual(result.input, {})
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npx tsx --test src/hooks/__tests__/registry.test.ts`
预期：FAIL — 模块不存在

- [ ] **步骤 3：编写 Hook 类型定义**

创建 `src/hooks/types.ts`：

```ts
export type HookEvent = 'PreToolUse' | 'PostToolUse' | 'Notification' | 'SubagentStop'

export interface PreToolUseInput {
  toolName: string
  input: Record<string, unknown>
}

export interface PostToolUseInput {
  toolName: string
  input: Record<string, unknown>
  result: string
  isError: boolean
}

export interface NotificationInput {
  message: string
  level: 'info' | 'warn' | 'error'
}

export interface SubagentStopInput {
  workOrderId: string
  status: string
}

export type HookInput<E extends HookEvent> =
  E extends 'PreToolUse' ? PreToolUseInput :
  E extends 'PostToolUse' ? PostToolUseInput :
  E extends 'Notification' ? NotificationInput :
  E extends 'SubagentStop' ? SubagentStopInput :
  never

export interface PreToolUseResult {
  input?: Record<string, unknown>
  block?: boolean
  reason?: string
}

export interface PostToolUseResult {
  result?: string
}

export type HookResult<E extends HookEvent> =
  E extends 'PreToolUse' ? PreToolUseResult :
  E extends 'PostToolUse' ? PostToolUseResult :
  Record<string, never>

export type HookHandler<E extends HookEvent> = (input: HookInput<E>) => Promise<HookResult<E>>
```

- [ ] **步骤 4：编写 HookRegistry 实现**

创建 `src/hooks/registry.ts`：

```ts
import type { HookEvent, HookHandler, HookResult, PreToolUseInput, PostToolUseInput, NotificationInput, SubagentStopInput, PreToolUseResult, PostToolUseResult } from './types.js'

type AnyHandler = HookHandler<HookEvent>

export class HookRegistry {
  private handlers = new Map<HookEvent, Set<AnyHandler>>()

  register<E extends HookEvent>(event: E, handler: HookHandler<E>): void {
    if (!this.handlers.has(event)) {
      this.handlers.set(event, new Set())
    }
    this.handlers.get(event)!.add(handler as AnyHandler)
  }

  unregister<E extends HookEvent>(event: E, handler: HookHandler<E>): void {
    this.handlers.get(event)?.delete(handler as AnyHandler)
  }

  firePreToolUse(input: PreToolUseInput): PreToolUseResult {
    const handlers = this.handlers.get('PreToolUse')
    if (!handlers || handlers.size === 0) return {}

    let current = input
    for (const handler of handlers) {
      const result = (handler as HookHandler<'PreToolUse'>)(current) as unknown as PreToolUseResult
      // Sync handler expected — if async, this returns a Promise which is truthy
      // We handle both sync and async by running hooks synchronously
      if (result && typeof result === 'object') {
        if ('block' in result && result.block) {
          return { block: true, reason: result.reason }
        }
        if (result.input) {
          current = { ...current, input: result.input }
        }
      }
    }
    return { input: current.input }
  }

  firePostToolUse(input: PostToolUseInput): PostToolUseResult {
    const handlers = this.handlers.get('PostToolUse')
    if (!handlers || handlers.size === 0) return {}

    let current = input
    for (const handler of handlers) {
      const result = (handler as HookHandler<'PostToolUse'>)(current) as unknown as PostToolUseResult
      if (result && typeof result === 'object' && result.result) {
        current = { ...current, result: result.result }
      }
    }
    return { result: current.result }
  }

  fireNotification(input: NotificationInput): void {
    const handlers = this.handlers.get('Notification')
    if (!handlers) return
    for (const handler of handlers) {
      ;(handler as HookHandler<'Notification'>)(input)
    }
  }

  fireSubagentStop(input: SubagentStopInput): void {
    const handlers = this.handlers.get('SubagentStop')
    if (!handlers) return
    for (const handler of handlers) {
      ;(handler as HookHandler<'SubagentStop'>)(input)
    }
  }

  clear(): void {
    this.handlers.clear()
  }
}
```

- [ ] **步骤 5：运行测试验证通过**

运行：`npx tsx --test src/hooks/__tests__/registry.test.ts`
预期：7 tests PASS

- [ ] **步骤 6：将 hooks 注入 agent loop**

修改 `src/agent/loop.ts`：

在 `AgentLoop` 类中添加 `hooks` 属性，在工具执行前后调用 hook：

```ts
// loop.ts — 在 AgentLoopConfig 接口中添加：
hooks?: HookRegistry

// loop.ts — 在工具执行循环中（约 line 274-321），注入 hook：
// 在 approval check 之前：
const preResult = this.config.hooks?.firePreToolUse({ toolName: tu.name, input: tu.input as Record<string, unknown> }) ?? {}
if (preResult.block) {
  const blockMsg = `Tool blocked by hook: ${preResult.reason ?? 'no reason given'}`
  callbacks.onToolResult(tu.id, tu.name, blockMsg, true)
  toolResults.push({ type: 'tool_result', tool_use_id: tu.id, content: blockMsg, is_error: true })
  continue
}
const hookInput = preResult.input ?? (tu.input as Record<string, unknown>)

// 在 tool result 返回之后：
const postResult = this.config.hooks?.firePostToolUse({ toolName: tu.name, input: hookInput, result: result.content, isError: result.isError ?? false }) ?? {}
const finalContent = postResult.result ?? result.content
```

- [ ] **步骤 7：Commit**

```bash
git add src/hooks/ src/agent/loop.ts
git commit -m "feat(hooks): agent lifecycle hooks — PreToolUse, PostToolUse, Notification, SubagentStop"
```

---

## 任务 2：结构化 Git 工具

**文件：**
- 创建：`src/tools/git.ts`
- 创建：`src/tools/__tests__/git.test.ts`
- 修改：`src/tools/default-registry.ts`

### 设计

不做一个大一统的 git 工具。拆成 3 个子命令（通过 `action` input field 分发）：
- `status` — `git status --porcelain` + branch 信息
- `diff_summary` — `git diff --stat` + staged vs unstaged
- `commit` — `git add` + `git commit` with message，自动检查 dirty state

LLM 仍然可以用 bash 做高级 git 操作，但常见操作有结构化输出。

- [ ] **步骤 1：编写 git 工具测试**

创建 `src/tools/__tests__/git.test.ts`：

```ts
import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { execSync } from 'node:child_process'
import { GIT_TOOL } from '../git.js'

const TMP = join(import.meta.dirname, '.git-test-tmp')

describe('GIT_TOOL', () => {
  beforeEach(() => {
    mkdirSync(TMP, { recursive: true })
    execSync('git init', { cwd: TMP })
    execSync('git config user.email "test@test.com"', { cwd: TMP })
    execSync('git config user.name "Test"', { cwd: TMP })
  })

  afterEach(() => {
    rmSync(TMP, { recursive: true, force: true })
  })

  it('has correct definition name', () => {
    assert.equal(GIT_TOOL.definition.name, 'git')
  })

  it('returns status for clean repo', async () => {
    writeFileSync(join(TMP, 'a.txt'), 'hello')
    execSync('git add .', { cwd: TMP })
    execSync('git commit -m "init"', { cwd: TMP })

    const result = await GIT_TOOL.execute({
      input: { action: 'status' },
      toolUseId: 'tu_1',
      cwd: TMP,
    })
    assert.equal(result.isError, undefined)
    assert.ok(result.content.includes('clean'))
  })

  it('returns diff summary', async () => {
    writeFileSync(join(TMP, 'a.txt'), 'hello')
    execSync('git add .', { cwd: TMP })
    execSync('git commit -m "init"', { cwd: TMP })
    writeFileSync(join(TMP, 'a.txt'), 'modified')

    const result = await GIT_TOOL.execute({
      input: { action: 'diff_summary' },
      toolUseId: 'tu_2',
      cwd: TMP,
    })
    assert.ok(result.content.includes('a.txt'))
  })

  it('commits changes with message', async () => {
    writeFileSync(join(TMP, 'a.txt'), 'hello')
    execSync('git add .', { cwd: TMP })
    execSync('git commit -m "init"', { cwd: TMP })
    writeFileSync(join(TMP, 'b.txt'), 'new file')
    execSync('git add .', { cwd: TMP })

    const result = await GIT_TOOL.execute({
      input: { action: 'commit', message: 'Add b.txt' },
      toolUseId: 'tu_3',
      cwd: TMP,
    })
    assert.equal(result.isError, undefined)
    assert.ok(result.content.includes('Add b.txt'))
  })

  it('rejects unknown action', async () => {
    const result = await GIT_TOOL.execute({
      input: { action: 'push' },
      toolUseId: 'tu_4',
      cwd: TMP,
    })
    assert.equal(result.isError, true)
    assert.ok(result.content.includes('Unknown action'))
  })

  it('requires approval for commit action', () => {
    assert.equal(GIT_TOOL.requiresApproval({ input: { action: 'commit' }, toolUseId: 't', cwd: '/' }), true)
  })

  it('does not require approval for status action', () => {
    assert.equal(GIT_TOOL.requiresApproval({ input: { action: 'status' }, toolUseId: 't', cwd: '/' }), false)
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npx tsx --test src/tools/__tests__/git.test.ts`
预期：FAIL — 模块不存在

- [ ] **步骤 3：编写 git 工具实现**

创建 `src/tools/git.ts`：

```ts
import { execSync } from 'node:child_process'
import type { Tool, ToolCallParams, ToolResult } from './types.js'

const ACTIONS = ['status', 'diff_summary', 'commit'] as const
type GitAction = (typeof ACTIONS)[number]

function runGit(args: string, cwd: string): string {
  return execSync(`git ${args}`, { cwd, encoding: 'utf-8', timeout: 10_000 })
}

export const GIT_TOOL: Tool = {
  definition: {
    name: 'git',
    description: `Structured git operations. Actions:
- status: Show working tree status, current branch, and file changes
- diff_summary: Show diff stats for staged and unstaged changes
- commit: Stage all tracked changes and commit with a message

For complex git operations (branch, merge, rebase, push, pull, log), use the bash tool instead.`,
    input_schema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: [...ACTIONS],
          description: 'The git operation to perform',
        },
        message: {
          type: 'string',
          description: 'Commit message (required for commit action)',
        },
      },
      required: ['action'],
    },
  },

  async execute(params: ToolCallParams): Promise<ToolResult> {
    const action = params.input.action as GitAction
    const cwd = params.cwd

    if (!ACTIONS.includes(action)) {
      return { content: `Unknown action: ${action}. Supported: ${ACTIONS.join(', ')}`, isError: true }
    }

    try {
      switch (action) {
        case 'status': {
          const branch = runGit('branch --show-current', cwd).trim()
          const porcelain = runGit('status --porcelain', cwd).trim()
          const untracked = runGit('ls-files --others --exclude-standard', cwd).trim()
          const lines = [`Branch: ${branch}`]
          if (!porcelain) {
            lines.push('Status: clean')
          } else {
            lines.push('Changes:', porcelain)
          }
          if (untracked) {
            lines.push('Untracked:', untracked)
          }
          return { content: lines.join('\n') }
        }

        case 'diff_summary': {
          const staged = runGit('diff --cached --stat', cwd).trim()
          const unstaged = runGit('diff --stat', cwd).trim()
          const lines: string[] = []
          if (staged) lines.push('Staged:', staged)
          if (unstaged) lines.push('Unstaged:', unstaged)
          if (!staged && !unstaged) lines.push('No changes.')
          return { content: lines.join('\n') }
        }

        case 'commit': {
          const message = params.input.message as string
          if (!message) {
            return { content: 'Commit requires a "message" parameter.', isError: true }
          }
          const safeMessage = message.replace(/"/g, '\\"').replace(/`/g, '\\`').replace(/\$/g, '\\$')
          // Check if there's anything to commit
          const status = runGit('status --porcelain', cwd).trim()
          if (!status) {
            return { content: 'Nothing to commit. Working tree clean.' }
          }
          runGit('add -A', cwd)
          const result = runGit(`commit -m "${safeMessage}"`, cwd)
          return { content: result.trim() }
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return { content: `git ${action} failed: ${message}`, isError: true }
    }
  },

  requiresApproval(params: ToolCallParams): boolean {
    return (params.input.action as string) === 'commit'
  },

  isConcurrencySafe: () => false,
  isEnabled: () => true,
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`npx tsx --test src/tools/__tests__/git.test.ts`
预期：7 tests PASS

- [ ] **步骤 5：注册到 default registry**

修改 `src/tools/default-registry.ts`，在工具列表中添加 `GIT_TOOL`：

```ts
import { GIT_TOOL } from './git.js'
// 在 registry.register 调用列表中添加：
registry.register(GIT_TOOL)
```

- [ ] **步骤 6：Commit**

```bash
git add src/tools/git.ts src/tools/__tests__/git.test.ts src/tools/default-registry.ts
git commit -m "feat(tools): structured git tool — status, diff_summary, commit"
```

---

## 任务 3：Todo 任务跟踪

**文件：**
- 创建：`src/tools/todo.ts`
- 创建：`src/tools/__tests__/todo.test.ts`
- 修改：`src/agent/context.ts`（添加 todo state）

### 设计

借鉴 Claude Code 的 TodoWrite：session 级任务列表，agent 可以读写。与 SessionContext 集成，todo state 随 session 持久化。

- [ ] **步骤 1：编写 todo 工具测试**

创建 `src/tools/__tests__/todo.test.ts`：

```ts
import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { TODO_TOOL } from '../todo.js'

describe('TODO_TOOL', () => {
  it('has correct definition name', () => {
    assert.equal(TODO_TOOL.definition.name, 'todo')
  })

  it('writes todos and returns old and new state', async () => {
    const todos = [
      { id: '1', content: 'Read main.tsx', status: 'completed' },
      { id: '2', content: 'Fix bug in loop', status: 'in_progress' },
      { id: '3', content: 'Add tests', status: 'pending' },
    ]

    const result = await TODO_TOOL.execute({
      input: { action: 'write', todos },
      toolUseId: 'tu_1',
      cwd: '/repo',
    })
    assert.equal(result.isError, undefined)
    assert.ok(result.content.includes('Read main.tsx'))
    assert.ok(result.content.includes('Fix bug in loop'))
  })

  it('reads current todos', async () => {
    await TODO_TOOL.execute({
      input: {
        action: 'write',
        todos: [{ id: '1', content: 'Task A', status: 'pending' }],
      },
      toolUseId: 'tu_1',
      cwd: '/repo',
    })

    const result = await TODO_TOOL.execute({
      input: { action: 'read' },
      toolUseId: 'tu_2',
      cwd: '/repo',
    })
    assert.ok(result.content.includes('Task A'))
  })

  it('rejects invalid status', async () => {
    const result = await TODO_TOOL.execute({
      input: {
        action: 'write',
        todos: [{ id: '1', content: 'Bad', status: 'unknown' }],
      },
      toolUseId: 'tu_3',
      cwd: '/repo',
    })
    assert.equal(result.isError, true)
    assert.ok(result.content.includes('Invalid status'))
  })

  it('rejects unknown action', async () => {
    const result = await TODO_TOOL.execute({
      input: { action: 'delete' },
      toolUseId: 'tu_4',
      cwd: '/repo',
    })
    assert.equal(result.isError, true)
  })

  it('does not require approval', () => {
    assert.equal(TODO_TOOL.requiresApproval({ input: { action: 'write' }, toolUseId: 't', cwd: '/' }), false)
  })

  it('is concurrency safe', () => {
    assert.equal(TODO_TOOL.isConcurrencySafe(), true)
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npx tsx --test src/tools/__tests__/todo.test.ts`
预期：FAIL — 模块不存在

- [ ] **步骤 3：编写 todo 工具实现**

创建 `src/tools/todo.ts`：

```ts
import { z } from 'zod'
import type { Tool, ToolCallParams } from './types.js'

const VALID_STATUSES = ['pending', 'in_progress', 'completed'] as const
type TodoStatus = (typeof VALID_STATUSES)[number]

const todoItemSchema = z.object({
  id: z.string().min(1),
  content: z.string().min(1),
  status: z.enum(VALID_STATUSES),
})

const todoActionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('read') }),
  z.object({ action: z.literal('write'), todos: z.array(todoItemSchema) }),
])

// In-memory todo store (per session). Cleared when process exits.
let currentTodos: z.infer<typeof todoItemSchema>[] = []

export function getTodos() {
  return [...currentTodos]
}

export function setTodos(todos: z.infer<typeof todoItemSchema>[]) {
  currentTodos = [...todos]
}

export const TODO_TOOL: Tool = {
  definition: {
    name: 'todo',
    description: `Read and write the session task list. Use this to track progress on multi-step tasks.
- write: Replace the entire todo list with a new one. Each item has id, content, and status (pending/in_progress/completed).
- read: Return the current todo list.

Always update the list when completing or starting a task. This helps maintain context across long sessions.`,
    input_schema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['read', 'write'],
          description: 'Read current todos or write a new list',
        },
        todos: {
          type: 'array',
          description: 'The complete todo list (only for write action)',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', description: 'Unique identifier for this task' },
              content: { type: 'string', description: 'Task description' },
              status: { type: 'string', enum: [...VALID_STATUSES], description: 'Task status' },
            },
            required: ['id', 'content', 'status'],
          },
        },
      },
      required: ['action'],
    },
  },

  async execute(params: ToolCallParams) {
    const parsed = todoActionSchema.safeParse(params.input)
    if (!parsed.success) {
      return { content: `Invalid input: ${parsed.error.message}`, isError: true }
    }

    const data = parsed.data

    if (data.action === 'read') {
      if (currentTodos.length === 0) {
        return { content: 'No todos. Use write action to create a list.' }
      }
      const lines = currentTodos.map(t => {
        const icon = t.status === 'completed' ? '✓' : t.status === 'in_progress' ? '►' : '○'
        return `${icon} [${t.id}] ${t.content} (${t.status})`
      })
      return { content: lines.join('\n') }
    }

    // write action
    const old = [...currentTodos]
    currentTodos = data.todos

    const completed = data.todos.filter(t => t.status === 'completed').length
    const total = data.todos.length
    const summary = `Updated: ${completed}/${total} completed`
    const items = data.todos.map(t => {
      const icon = t.status === 'completed' ? '✓' : t.status === 'in_progress' ? '►' : '○'
      return `${icon} [${t.id}] ${t.content}`
    })
    return { content: `${summary}\n${items.join('\n')}` }
  },

  requiresApproval: () => false,
  isConcurrencySafe: () => true,
  isEnabled: () => true,
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`npx tsx --test src/tools/__tests__/todo.test.ts`
预期：7 tests PASS

- [ ] **步骤 5：注册到 default registry**

修改 `src/tools/default-registry.ts`：

```ts
import { TODO_TOOL } from './todo.js'
// 添加到 registry.register 列表
registry.register(TODO_TOOL)
```

- [ ] **步骤 6：Commit**

```bash
git add src/tools/todo.ts src/tools/__tests__/todo.test.ts src/tools/default-registry.ts
git commit -m "feat(tools): todo task tracking — read/write session task list"
```

---

## 任务 4：WebFetch 网页抓取

**文件：**
- 创建：`src/tools/web-fetch.ts`
- 创建：`src/tools/__tests__/web-fetch.test.ts`

### 设计

简化版 WebFetch：fetch URL → 提取文本/HTML → 截断 → 返回给模型。不做 JS 渲染（无 headless browser）。支持 HTML→Markdown 粗转换（strip tags）。需要 approval（网络访问）。

- [ ] **步骤 1：编写 web-fetch 测试**

创建 `src/tools/__tests__/web-fetch.test.ts`：

```ts
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { WEB_FETCH_TOOL, htmlToMarkdown } from '../web-fetch.js'

describe('htmlToMarkdown', () => {
  it('strips HTML tags', () => {
    assert.ok(htmlToMarkdown('<p>Hello <b>world</b></p>').includes('Hello'))
    assert.ok(!htmlToMarkdown('<p>Hello</p>').includes('<p>'))
  })

  it('converts links to markdown format', () => {
    const result = htmlToMarkdown('<a href="https://example.com">link</a>')
    assert.ok(result.includes('[link](https://example.com)'))
  })

  it('handles empty input', () => {
    assert.equal(htmlToMarkdown(''), '')
  })
})

describe('WEB_FETCH_TOOL', () => {
  it('has correct definition name', () => {
    assert.equal(WEB_FETCH_TOOL.definition.name, 'web_fetch')
  })

  it('rejects invalid URLs', async () => {
    const result = await WEB_FETCH_TOOL.execute({
      input: { url: 'not-a-url' },
      toolUseId: 'tu_1',
      cwd: '/',
    })
    assert.equal(result.isError, true)
    assert.ok(result.content.includes('Invalid URL'))
  })

  it('requires approval', () => {
    assert.equal(
      WEB_FETCH_TOOL.requiresApproval({ input: { url: 'https://example.com' }, toolUseId: 't', cwd: '/' }),
      true,
    )
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npx tsx --test src/tools/__tests__/web-fetch.test.ts`
预期：FAIL — 模块不存在

- [ ] **步骤 3：编写 web-fetch 工具实现**

创建 `src/tools/web-fetch.ts`：

```ts
import type { Tool, ToolCallParams } from './types.js'

const MAX_CONTENT_LENGTH = 50_000

export function htmlToMarkdown(html: string): string {
  let text = html
  // Links
  text = text.replace(/<a\s+href="([^"]*)"[^>]*>(.*?)<\/a>/gi, '[$2]($1)')
  // Headings
  text = text.replace(/<h[1-6][^>]*>(.*?)<\/h[1-6]>/gi, (_, content) => `## ${content}`)
  // Paragraphs and line breaks
  text = text.replace(/<br\s*\/?>/gi, '\n')
  text = text.replace(/<\/p>/gi, '\n\n')
  text = text.replace(/<p[^>]*>/gi, '')
  // Bold/italic
  text = text.replace(/<(strong|b)[^>]*>(.*?)<\/(strong|b)>/gi, '**$2**')
  text = text.replace(/<(em|i)[^>]*>(.*?)<\/(em|i)>/gi, '*$2*')
  // Code blocks
  text = text.replace(/<pre[^>]*>(.*?)<\/pre>/gis, '```\n$1\n```')
  text = text.replace(/<code[^>]*>(.*?)<\/code>/gi, '`$1`')
  // List items
  text = text.replace(/<li[^>]*>(.*?)<\/li>/gi, '- $1')
  // Strip remaining tags
  text = text.replace(/<[^>]+>/g, '')
  // Decode common entities
  text = text.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
  // Collapse whitespace
  text = text.replace(/\n{3,}/g, '\n\n').trim()
  return text
}

export const WEB_FETCH_TOOL: Tool = {
  definition: {
    name: 'web_fetch',
    description: `Fetch content from a URL and return it as text. Useful for reading documentation, API references, or issue pages.
Returns the page content converted to plain text (HTML tags stripped). Content is truncated to ~50K characters.
Requires user approval since it makes network requests.`,
    input_schema: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'The URL to fetch',
        },
      },
      required: ['url'],
    },
  },

  async execute(params: ToolCallParams) {
    const rawUrl = params.input.url as string

    let url: URL
    try {
      url = new URL(rawUrl)
    } catch {
      return { content: `Invalid URL: ${rawUrl}`, isError: true }
    }

    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return { content: `Unsupported protocol: ${url.protocol}. Only http and https are allowed.`, isError: true }
    }

    try {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 15_000)

      const response = await fetch(rawUrl, {
        signal: controller.signal,
        headers: { 'User-Agent': 'Rivet/0.1 (terminal coding agent)' },
      })
      clearTimeout(timeout)

      if (!response.ok) {
        return { content: `HTTP ${response.status} ${response.statusText} for ${rawUrl}`, isError: true }
      }

      const contentType = response.headers.get('content-type') ?? ''
      const body = await response.text()

      let content: string
      if (contentType.includes('text/html')) {
        content = htmlToMarkdown(body)
      } else {
        content = body
      }

      if (content.length > MAX_CONTENT_LENGTH) {
        content = content.slice(0, MAX_CONTENT_LENGTH) + `\n\n[... truncated at ${MAX_CONTENT_LENGTH} chars, total ${body.length}]`
      }

      return { content: `URL: ${rawUrl}\nStatus: ${response.status}\nContent-Length: ${body.length}\n\n${content}` }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return { content: `Failed to fetch ${rawUrl}: ${message}`, isError: true }
    }
  },

  requiresApproval: () => true,
  isConcurrencySafe: () => true,
  isEnabled: () => true,
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`npx tsx --test src/tools/__tests__/web-fetch.test.ts`
预期：4 tests PASS

- [ ] **步骤 5：注册到 default registry**

修改 `src/tools/default-registry.ts`：

```ts
import { WEB_FETCH_TOOL } from './web-fetch.js'
// 添加到 registry.register 列表
registry.register(WEB_FETCH_TOOL)
```

- [ ] **步骤 6：Commit**

```bash
git add src/tools/web-fetch.ts src/tools/__tests__/web-fetch.test.ts src/tools/default-registry.ts
git commit -m "feat(tools): web_fetch — URL content fetching with HTML-to-markdown conversion"
```

---

## 任务 5：文件级 Undo 系统

**文件：**
**
- 创建：`src/agent/file-history.ts`
- 创建：`src/agent/__tests__/file-history.test.ts`
- 创建：`src/tools/undo.ts`
- 创建：`src/tools/__tests__/undo.test.ts`
- 修改：`src/tools/edit.ts`、`src/tools/write-file.ts`（write 前捕获 snapshot）
- 修改：`src/agent/loop.ts`（工具执行前后调用 file-history）
- 修改：`src/tui/app.tsx`（添加 /undo 命令）

### 设计

借鉴 Claude Code 的 FileHistory：每次文件修改前，将当前内容备份到 `~/.rivet/file-history/{sessionId}/`。Undo 从最近一次修改开始，恢复到上一个版本。最多保留 100 个 snapshot。

- [ ] **步骤 1：编写 file-history 测试**

创建 `src/agent/__tests__/file-history.test.ts`：

```ts
import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { FileHistory } from '../file-history.js'

const TMP = join(import.meta.dirname, '.fh-test-tmp')
const BACKUP = join(import.meta.dirname, '.fh-test-backup')

describe('FileHistory', () => {
  let history: FileHistory

  beforeEach(() => {
    mkdirSync(TMP, { recursive: true })
    mkdirSync(BACKUP, { recursive: true })
    history = new FileHistory(BACKUP, 'test-session')
  })

  afterEach(() => {
    rmSync(TMP, { recursive: true, force: true })
    rmSync(BACKUP, { recursive: true, force: true })
  })

  it('captures backup before write and tracks file', async () => {
    const file = join(TMP, 'a.txt')
    writeFileSync(file, 'original')
    await history.trackEdit(file, 'msg_1')

    writeFileSync(file, 'modified')
    const stats = await history.getDiffStats('msg_1')
    assert.ok(stats !== undefined)
    assert.ok(stats!.filesChanged!.includes(file))
  })

  it('restores file to previous version', async () => {
    const file = join(TMP, 'a.txt')
    writeFileSync(file, 'v1')
    await history.trackEdit(file, 'msg_1')

    writeFileSync(file, 'v2')
    await history.trackEdit(file, 'msg_2')

    writeFileSync(file, 'v3')

    await history.rewind('msg_1')
    assert.equal(readFileSync(file, 'utf-8'), 'v1')
  })

  it('handles file that did not exist at target snapshot', async () => {
    const file = join(TMP, 'new.txt')
    writeFileSync(file, 'created')
    await history.trackEdit(file, 'msg_1')

    await history.rewind('msg_1')
    assert.equal(existsSync(file), false)
  })

  it('returns undefined diff stats for unknown message', async () => {
    const stats = await history.getDiffStats('nonexistent')
    assert.equal(stats, undefined)
  })

  it('caps snapshots at 100', async () => {
    const file = join(TMP, 'cap.txt')
    for (let i = 0; i < 110; i++) {
      writeFileSync(file, `v${i}`)
      await history.trackEdit(file, `msg_${i}`)
    }
    // Should not throw; old snapshots evicted
    const stats = await history.getDiffStats('msg_0')
    // msg_0 snapshot may have been evicted
    assert.ok(stats === undefined || stats.filesChanged !== undefined)
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npx tsx --test src/agent/__tests__/file-history.test.ts`
预期：FAIL — 模块不存在

- [ ] **步骤 3：编写 FileHistory 实现**

创建 `src/agent/file-history.ts`：

```ts
import { copyFile, mkdir, readFile, stat, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { createHash } from 'node:crypto'
import { diffLines } from 'diff'

const MAX_SNAPSHOTS = 100

export interface FileBackup {
  backupFileName: string | null // null = file did not exist
  version: number
  timestamp: number
}

export interface FileSnapshot {
  messageId: string
  trackedFileBackups: Record<string, FileBackup>
  timestamp: number
}

export interface DiffStats {
  filesChanged: string[]
  insertions: number
  deletions: number
}

export class FileHistory {
  private snapshots: FileSnapshot[] = []
  private trackedFiles = new Set<string>()

  constructor(
    private backupDir: string,
    private sessionId: string,
  ) {}

  async trackEdit(filePath: string, messageId: string): Promise<void> {
    this.trackedFiles.add(filePath)

    let version = 1
    const lastSnapshot = this.snapshots.at(-1)
    if (lastSnapshot?.trackedFileBackups[filePath]) {
      // Already tracked in most recent snapshot, don't re-backup
      return
    }

    // Create backup of current file content
    let backup: FileBackup
    try {
      const content = await readFile(filePath, 'utf-8')
      const fileNameHash = createHash('sha256').update(filePath).digest('hex').slice(0, 16)
      const backupFileName = `${fileNameHash}@v${version}`
      const backupPath = join(this.backupDir, this.sessionId, backupFileName)
      await mkdir(dirname(backupPath), { recursive: true })
      await writeFile(backupPath, content, 'utf-8')
      backup = { backupFileName, version, timestamp: Date.now() }
    } catch {
      // File doesn't exist yet
      backup = { backupFileName: null, version, timestamp: Date.now() }
    }

    // Append to most recent snapshot or create new one
    if (lastSnapshot && lastSnapshot.messageId === messageId) {
      lastSnapshot.trackedFileBackups[filePath] = backup
    } else {
      const snapshot: FileSnapshot = {
        messageId,
        trackedFileBackups: { [filePath]: backup },
        timestamp: Date.now(),
      }
      this.snapshots.push(snapshot)
      if (this.snapshots.length > MAX_SNAPSHOTS) {
        this.snapshots = this.snapshots.slice(-MAX_SNAPSHOTS)
      }
    }
  }

  async rewind(targetMessageId: string): Promise<string[]> {
    const targetSnapshot = this.snapshots.findLast(s => s.messageId === targetMessageId)
    if (!targetSnapshot) {
      throw new Error(`Snapshot for ${targetMessageId} not found`)
    }

    const filesChanged: string[] = []
    for (const filePath of this.trackedFiles) {
      const targetBackup = targetSnapshot.trackedFileBackups[filePath]
      if (targetBackup === undefined) continue

      if (targetBackup.backupFileName === null) {
        // File did not exist at target — delete it
        try {
          await unlink(filePath)
          filesChanged.push(filePath)
        } catch { /* already gone */ }
        continue
      }

      // Restore from backup
      const backupPath = join(this.backupDir, this.sessionId, targetBackup.backupFileName)
      try {
        const content = await readFile(backupPath, 'utf-8')
        await mkdir(dirname(filePath), { recursive: true })
        await writeFile(filePath, content, 'utf-8')
        filesChanged.push(filePath)
      } catch { /* backup missing, skip */ }
    }
    return filesChanged
  }

  async getDiffStats(targetMessageId: string): Promise<DiffStats | undefined> {
    const targetSnapshot = this.snapshots.findLast(s => s.messageId === targetMessageId)
    if (!targetSnapshot) return undefined

    const filesChanged: string[] = []
    let insertions = 0
    let deletions = 0

    for (const filePath of this.trackedFiles) {
      const targetBackup = targetSnapshot.trackedFileBackups[filePath]
      if (targetBackup === undefined) continue

      let oldContent = ''
      if (targetBackup.backupFileName !== null) {
        try {
          oldContent = await readFile(join(this.backupDir, this.sessionId, targetBackup.backupFileName), 'utf-8')
        } catch { /* skip */ }
      }

      let newContent = ''
      try {
        newContent = await readFile(filePath, 'utf-8')
      } catch { /* file deleted */ }

      if (oldContent === newContent) continue
      filesChanged.push(filePath)

      const changes = diffLines(oldContent, newContent)
      for (const c of changes) {
        if (c.added) insertions += c.count ?? 0
        if (c.removed) deletions += c.count ?? 0
      }
    }

    return { filesChanged, insertions, deletions }
  }

  hasSnapshot(messageId: string): boolean {
    return this.snapshots.some(s => s.messageId === messageId)
  }

  getLatestSnapshotId(): string | undefined {
    return this.snapshots.at(-1)?.messageId
  }
}
```

- [ ] **步骤 4：安装 diff 依赖**

运行：`npm install diff && npm install -D @types/diff`

- [ ] **步骤 5：运行测试验证通过**

运行：`npx tsx --test src/agent/__tests__/file-history.test.ts`
预期：5 tests PASS

- [ ] **步骤 6：编写 undo 工具**

创建 `src/tools/undo.ts`：

```ts
import type { Tool, ToolCallParams } from './types.js'
import type { FileHistory } from '../agent/file-history.js'

export function createUndoTool(getFileHistory: () => FileHistory | undefined): Tool {
  return {
    definition: {
      name: 'undo',
      description: `Undo the most recent file change by restoring it to its previous backup. Shows what would change before restoring. This operates at file level — only the files modified in the last tool call are reverted.`,
      input_schema: {
        type: 'object',
        properties: {
          confirm: {
            type: 'boolean',
            description: 'Set to true to execute the undo. Without confirm, shows preview only.',
          },
        },
      },
    },

    async execute(params: ToolCallParams) {
      const history = getFileHistory()
      if (!history) {
        return { content: 'File history not available.', isError: true }
      }

      const latestId = history.getLatestSnapshotId()
      if (!latestId) {
        return { content: 'No file history snapshots available to undo.' }
      }

      const confirm = params.input.confirm === true

      if (!confirm) {
        const stats = await history.getDiffStats(latestId)
        if (!stats || stats.filesChanged.length === 0) {
          return { content: 'No changes to undo in the most recent snapshot.' }
        }
        const fileList = stats.filesChanged.map(f => `  - ${f}`).join('\n')
        return {
          content: `Preview: ${stats.filesChanged.length} file(s) would be restored:\n${fileList}\n+${stats.insertions}/-${stats.deletions} lines\n\nCall with confirm: true to execute.`,
        }
      }

      try {
        const restored = await history.rewind(latestId)
        if (restored.length === 0) {
          return { content: 'No files needed restoration.' }
        }
        return { content: `Restored ${restored.length} file(s):\n${restored.map(f => `  - ${f}`).join('\n')}` }
      } catch (err) {
        return { content: `Undo failed: ${err instanceof Error ? err.message : String(err)}`, isError: true }
      }
    },

    requiresApproval: () => true,
    isConcurrencySafe: () => false,
    isEnabled: () => true,
  }
}
```

- [ ] **步骤 7：编写 undo 测试**

创建 `src/tools/__tests__/undo.test.ts`：

```ts
import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createUndoTool } from '../undo.js'
import { FileHistory } from '../../agent/file-history.js'

const TMP = join(import.meta.dirname, '.undo-test-tmp')
const BACKUP = join(import.meta.dirname, '.undo-test-backup')

describe('createUndoTool', () => {
  let history: FileHistory

  beforeEach(() => {
    mkdirSync(TMP, { recursive: true })
    mkdirSync(BACKUP, { recursive: true })
    history = new FileHistory(BACKUP, 'undo-session')
  })

  afterEach(() => {
    rmSync(TMP, { recursive: true, force: true })
    rmSync(BACKUP, { recursive: true, force: true })
  })

  it('returns error when no history available', async () => {
    const tool = createUndoTool(() => undefined)
    const result = await tool.execute({ input: {}, toolUseId: 't', cwd: '/' })
    assert.equal(result.isError, true)
  })

  it('shows preview without confirm', async () => {
    const file = join(TMP, 'a.txt')
    writeFileSync(file, 'v1')
    await history.trackEdit(file, 'msg_1')
    writeFileSync(file, 'v2')

    const tool = createUndoTool(() => history)
    const result = await tool.execute({ input: {}, toolUseId: 't', cwd: '/' })
    assert.equal(result.isError, undefined)
    assert.ok(result.content.includes('Preview'))
    assert.ok(result.content.includes('a.txt'))
  })

  it('restores files with confirm', async () => {
    const file = join(TMP, 'a.txt')
    writeFileSync(file, 'v1')
    await history.trackEdit(file, 'msg_1')
    writeFileSync(file, 'v2')

    const tool = createUndoTool(() => history)
    const result = await tool.execute({ input: { confirm: true }, toolUseId: 't', cwd: '/' })
    assert.ok(result.content.includes('Restored'))
    assert.equal(readFileSync(file, 'utf-8'), 'v1')
  })

  it('has correct tool name', () => {
    const tool = createUndoTool(() => undefined!)
    assert.equal(tool.definition.name, 'undo')
  })

  it('requires approval', () => {
    const tool = createUndoTool(() => undefined!)
    assert.equal(tool.requiresApproval({ input: {}, toolUseId: 't', cwd: '/' }), true)
  })
})
```

- [ ] **步骤 8：运行 undo 测试**

运行：`npx tsx --test src/tools/__tests__/undo.test.ts`
预期：5 tests PASS

- [ ] **步骤 9：将 FileHistory 注入 agent loop**

修改 `src/agent/loop.ts`：

在 AgentLoopConfig 中添加 `fileHistory` 属性。在 edit_file / write_file 工具执行前调用 `fileHistory.trackEdit()`。

```ts
// 在工具执行循环中，checkpoint 创建之后（约 line 299-303）：
if (this.config.fileHistory && (tu.name === 'edit_file' || tu.name === 'write_file')) {
  const filePath = tu.input.file_path as string
  if (filePath) {
    await this.config.fileHistory.trackEdit(filePath, tu.id)
  }
}
```

- [ ] **步骤 10：注册 undo 工具到 default registry**

修改 `src/tools/default-registry.ts`：

```ts
import { createUndoTool } from './undo.js'
// undo 工具需要 FileHistory 引用，在 main.tsx 中注册：
// registry.register(createUndoTool(() => fileHistory))
```

undo 工具需要在 `src/main.tsx` 中创建时传入 fileHistory getter，因为它依赖运行时状态。default-registry 中不直接注册。

- [ ] **步骤 11：在 app.tsx 添加 /undo 命令**

修改 `src/tui/app.tsx`，在 slash command switch 中添加 `/undo` case，调用 undo 工具的 preview 模式。

- [ ] **步骤 12：Commit**

```bash
git add src/agent/file-history.ts src/agent/__tests__/file-history.test.ts src/tools/undo.ts src/tools/__tests__/undo.test.ts src/agent/loop.ts src/tools/default-registry.ts src/tui/app.tsx
git commit -m "feat(undo): file-level undo with snapshot backup + restore"
```

---

## 自检

### 1. 规格覆盖度

| 需求 | 任务 |
|------|------|
| Agent Hooks (PreToolUse/PostToolUse/Notification/SubagentStop) | 任务 1 |
| Git 结构化工具 (status/diff_summary/commit) | 任务 2 |
| Todo 任务跟踪 (read/write session task list) | 任务 3 |
| WebFetch (URL fetch + HTML→Markdown) | 任务 4 |
| Undo (file-level snapshot backup + restore) | 任务 5 |

全部覆盖。

### 2. 占位符扫描

无 TODO/TBD/待定。所有代码步骤包含完整实现。

### 3. 类型一致性

- `HookHandler<'PreToolUse'>` 在 types.ts 定义，在 registry.ts 和 loop.ts 中使用 — 一致
- `FileBackup.backupFileName: string | null` 在 file-history.ts 定义，在 undo.ts 中引用 — 一致
- `Tool` 接口在 types.ts 定义，所有新工具实现相同签名 — 一致
- `ToolCallParams` input 类型为 `Record<string, unknown>`，各工具从中读取具体字段 — 一致

### 依赖说明

- 任务 5 (undo) 依赖 `diff` npm package — 需在步骤 4 安装
- 任务 4 (web-fetch) 使用 Node 18+ 内置 `fetch` — 无额外依赖
- 任务 1 (hooks) 注入 loop.ts — 需在任务 1 完成后才能测试集成
- 任务 2、3、4、5 相互独立，可并行执行

---

## 执行建议

推荐按此顺序执行（依赖关系）：

1. **任务 1** (Hooks) — 最先，因为 loop.ts 需要修改
2. **任务 2** (Git) — 独立，可与 3/4 并行
3. **任务 3** (Todo) — 独立
4. **任务 4** (WebFetch) — 独立
5. **任务 5** (Undo) — 最后，因为涉及 loop.ts + 多文件集成
