# Gap Closing 加固实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 安全加固 + 功能补全 5 个已实现的 tool（Hooks、Git、Todo、WebFetch、Undo），每个改动独立可测。

**架构：** Hooks 加 try/catch 隔离 + 2 个新生命周期事件；Git 加输出截断 + git_log/git_stash；WebFetch 用 turndown 替换 regex；Todo 加 worker-scoped state；Undo 加孤儿备份清理。5 个子系统独立，互不依赖。

**技术栈：** TypeScript, Zod, node:test, turndown (新增 npm 依赖), @types/turndown (新增 devDep)

---

## 文件结构

### 修改文件

| 文件 | 变更 |
|------|------|
| `src/hooks/types.ts` | 新增 `UserPromptSubmitInput`、`PreCompactInput` 类型 + 联合类型扩展 |
| `src/hooks/registry.ts` | 所有 `fire*` 方法加 try/catch 隔离 + 500ms 超时；新增 `fireUserPromptSubmit`、`firePreCompact` |
| `src/hooks/__tests__/registry.test.ts` | 新增 try/catch 隔离测试 + 超时测试 + 2 个新事件测试 |
| `src/tools/git.ts` | `runGit` 加输出截断 50KB；新增 `git_log`、`git_stash` action |
| `src/tools/__tests__/git.test.ts` | 新增 git_log、git_stash、输出截断测试 |
| `src/tools/todo.ts` | 模块级 `currentTodos` 改为 `TodoStore` class，支持 worker-scoped state |
| `src/tools/__tests__/todo.test.ts` | 新增并发 worker 测试 |
| `src/tools/web-fetch.ts` | 删除 `htmlToMarkdown()`，用 `turndown` 替换 |
| `src/tools/__tests__/web-fetch.test.ts` | 更新 htmlToMarkdown 测试（测 turndown 输出） |
| `src/agent/file-history.ts` | 新增 `cleanupOrphans()` 方法 |
| `src/agent/__tests__/file-history.test.ts` | 新增孤儿清理测试 |

### 新建文件

| 文件 | 职责 |
|------|------|
| `src/tools/todo-store.ts` | TodoStore class — 支持多 worker 的 todo state 容器 |

---

## 任务 1：Hooks try/catch 隔离 + 超时保护

**文件：**
- 修改：`src/hooks/registry.ts`
- 修改：`src/hooks/__tests__/registry.test.ts`

当前问题：`registry.ts` 所有 `fire*` 方法直接调用 handler，handler 抛异常会崩主循环。Claude Code 的 hooks 规范要求 hooks 不能崩溃 agent。

- [ ] **步骤 1：编写失败的测试**

在 `src/hooks/__tests__/registry.test.ts` 末尾追加：

```ts
describe('HookRegistry error isolation', () => {
  it('catches handler throw in firePreToolUse and returns safe default', () => {
    const registry = new HookRegistry()
    registry.register('PreToolUse', () => { throw new Error('handler boom') })
    const result = registry.firePreToolUse({ toolName: 'bash', input: { command: 'ls' } })
    assert.equal(result.block, undefined)
    assert.deepEqual(result.input, { command: 'ls' })
  })

  it('catches handler throw in firePostToolUse', () => {
    const registry = new HookRegistry()
    registry.register('PostToolUse', () => { throw new Error('post boom') })
    const result = registry.firePostToolUse({ toolName: 'bash', input: {}, result: 'ok', isError: false })
    assert.equal(result.result, 'ok')
  })

  it('catches handler throw in fireNotification', () => {
    const registry = new HookRegistry()
    registry.register('Notification', () => { throw new Error('notif boom') })
    assert.doesNotThrow(() => registry.fireNotification({ message: 'hi', level: 'info' }))
  })

  it('catches handler throw in fireSubagentStop', () => {
    const registry = new HookRegistry()
    registry.register('SubagentStop', () => { throw new Error('stop boom') })
    assert.doesNotThrow(() => registry.fireSubagentStop({ workOrderId: 'w1', status: 'done' }))
  })

  it('continues to next handler after one throws', () => {
    const registry = new HookRegistry()
    const seen: string[] = []
    registry.register('PreToolUse', () => { throw new Error('fail') })
    registry.register('PreToolUse', ((_: any) => {
      seen.push('second')
      return { input: { command: 'ok' } }
    }) as HookHandler<'PreToolUse'>)
    const result = registry.firePreToolUse({ toolName: 'bash', input: { command: 'ls' } })
    assert.deepEqual(seen, ['second'])
    assert.deepEqual(result.input, { command: 'ok' })
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npx tsx --test src/hooks/__tests__/registry.test.ts`
预期：FAIL — throw 未被 catch，测试崩溃

- [ ] **步骤 3：修改 registry.ts 加 try/catch 隔离**

修改 `src/hooks/registry.ts`，将每个 `fire*` 方法中的 handler 调用包在 try/catch 中：

```ts
import type {
  HookEvent, HookHandler, PreToolUseInput, PostToolUseInput,
  NotificationInput, SubagentStopInput, PreToolUseResult, PostToolUseResult,
} from './types.js'

type AnyHandler = HookHandler<HookEvent>

export class HookRegistry {
  private handlers = new Map<HookEvent, Set<AnyHandler>>()

  register<E extends HookEvent>(event: E, handler: HookHandler<E>): void {
    if (!this.handlers.has(event)) {
      this.handlers.set(event, new Set())
    }
    this.handlers.get(event)!.add(handler as unknown as AnyHandler)
  }

  unregister<E extends HookEvent>(event: E, handler: HookHandler<E>): void {
    this.handlers.get(event)?.delete(handler as unknown as AnyHandler)
  }

  firePreToolUse(input: PreToolUseInput): PreToolUseResult {
    const handlers = this.handlers.get('PreToolUse')
    if (!handlers || handlers.size === 0) return { input: input.input }

    let current = input
    for (const handler of handlers) {
      try {
        const result = (handler as HookHandler<'PreToolUse'>)(current)
        if (result.block) {
          return { block: true, reason: result.reason }
        }
        if (result.input) {
          current = { ...current, input: result.input }
        }
      } catch {
        // Handler error is non-fatal — skip and continue
      }
    }
    return { input: current.input }
  }

  firePostToolUse(input: PostToolUseInput): PostToolUseResult {
    const handlers = this.handlers.get('PostToolUse')
    if (!handlers || handlers.size === 0) return {}

    let current = input
    for (const handler of handlers) {
      try {
        const result = (handler as HookHandler<'PostToolUse'>)(current)
        if (result.result) {
          current = { ...current, result: result.result }
        }
      } catch {
        // Handler error is non-fatal — skip and continue
      }
    }
    return { result: current.result }
  }

  fireNotification(input: NotificationInput): void {
    const handlers = this.handlers.get('Notification')
    if (!handlers) return
    for (const handler of handlers) {
      try {
        (handler as HookHandler<'Notification'>)(input)
      } catch {
        // Handler error is non-fatal — skip and continue
      }
    }
  }

  fireSubagentStop(input: SubagentStopInput): void {
    const handlers = this.handlers.get('SubagentStop')
    if (!handlers) return
    for (const handler of handlers) {
      try {
        (handler as HookHandler<'SubagentStop'>)(input)
      } catch {
        // Handler error is non-fatal — skip and continue
      }
    }
  }

  clear(): void {
    this.handlers.clear()
  }
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`npx tsx --test src/hooks/__tests__/registry.test.ts`
预期：所有测试 PASS（原 7 个 + 新 5 个 = 12 个）

- [ ] **步骤 5：Commit**

```bash
git add src/hooks/registry.ts src/hooks/__tests__/registry.test.ts
git commit -m "fix(hooks): wrap all fire* methods in try/catch — handler errors no longer crash agent loop"
```

---

## 任务 2：Hooks 新增 UserPromptSubmit + PreCompact 事件

**文件：**
- 修改：`src/hooks/types.ts`
- 修改：`src/hooks/registry.ts`
- 修改：`src/hooks/__tests__/registry.test.ts`

新增 2 个生命周期事件，对齐 Claude Code 的 hook 生命周期。`UserPromptSubmit` 允许 hook 过滤/改写用户输入；`PreCompact` 允许 hook 在上下文压缩前保存关键信息。

- [ ] **步骤 1：修改 types.ts 新增事件类型**

修改 `src/hooks/types.ts`，在 `HookEvent` 联合类型中新增 2 个事件，并添加对应的 input/result 类型：

```ts
export type HookEvent = 'PreToolUse' | 'PostToolUse' | 'Notification' | 'SubagentStop' | 'UserPromptSubmit' | 'PreCompact'

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

export interface UserPromptSubmitInput {
  prompt: string
}

export interface PreCompactInput {
  turnCount: number
  messageCount: number
}

export type HookInput<E extends HookEvent> =
  E extends 'PreToolUse' ? PreToolUseInput :
  E extends 'PostToolUse' ? PostToolUseInput :
  E extends 'Notification' ? NotificationInput :
  E extends 'SubagentStop' ? SubagentStopInput :
  E extends 'UserPromptSubmit' ? UserPromptSubmitInput :
  E extends 'PreCompact' ? PreCompactInput :
  never

export interface PreToolUseResult {
  input?: Record<string, unknown>
  block?: boolean
  reason?: string
}

export interface PostToolUseResult {
  result?: string
}

export interface UserPromptSubmitResult {
  prompt?: string
  block?: boolean
  reason?: string
}

export type HookResult<E extends HookEvent> =
  E extends 'PreToolUse' ? PreToolUseResult :
  E extends 'PostToolUse' ? PostToolUseResult :
  E extends 'UserPromptSubmit' ? UserPromptSubmitResult :
  Record<string, never>
```

- [ ] **步骤 2：修改 registry.ts 新增 fire 方法**

在 `src/hooks/registry.ts` 的 `HookRegistry` 类中新增两个方法（在 `clear()` 之前）：

```ts
  fireUserPromptSubmit(input: UserPromptSubmitInput): UserPromptSubmitResult {
    const handlers = this.handlers.get('UserPromptSubmit')
    if (!handlers || handlers.size === 0) return {}

    let currentPrompt = input.prompt
    for (const handler of handlers) {
      try {
        const result = (handler as HookHandler<'UserPromptSubmit'>)({ prompt: currentPrompt })
        if (result.block) {
          return { block: true, reason: result.reason }
        }
        if (result.prompt) {
          currentPrompt = result.prompt
        }
      } catch {
        // Handler error is non-fatal
      }
    }
    return { prompt: currentPrompt }
  }

  firePreCompact(input: PreCompactInput): void {
    const handlers = this.handlers.get('PreCompact')
    if (!handlers) return
    for (const handler of handlers) {
      try {
        (handler as HookHandler<'PreCompact'>)(input)
      } catch {
        // Handler error is non-fatal
      }
    }
  }
```

同时在文件顶部 import 中新增 `UserPromptSubmitInput`、`PreCompactInput`、`UserPromptSubmitResult`。

- [ ] **步骤 3：编写新事件的测试**

在 `src/hooks/__tests__/registry.test.ts` 末尾追加：

```ts
import type { UserPromptSubmitInput, PreCompactInput } from '../types.js'

describe('UserPromptSubmit hook', () => {
  it('allows hook to modify prompt', () => {
    const registry = new HookRegistry()
    registry.register('UserPromptSubmit', ((input: UserPromptSubmitInput) => ({
      prompt: input.prompt.replace(/badword/gi, '***'),
    })) as any)
    const result = registry.fireUserPromptSubmit({ prompt: 'fix the badword issue' })
    assert.equal(result.prompt, 'fix the *** issue')
  })

  it('allows hook to block prompt', () => {
    const registry = new HookRegistry()
    registry.register('UserPromptSubmit', () => ({
      block: true,
      reason: 'Prompt contains disallowed content',
    }))
    const result = registry.fireUserPromptSubmit({ prompt: 'rm -rf /' })
    assert.equal(result.block, true)
    assert.equal(result.reason, 'Prompt contains disallowed content')
  })

  it('returns empty when no hooks registered', () => {
    const registry = new HookRegistry()
    const result = registry.fireUserPromptSubmit({ prompt: 'hello' })
    assert.equal(result.block, undefined)
    assert.equal(result.prompt, undefined)
  })
})

describe('PreCompact hook', () => {
  it('fires without error', () => {
    const registry = new HookRegistry()
    const seen: PreCompactInput[] = []
    registry.register('PreCompact', ((input: PreCompactInput) => {
      seen.push(input)
    }) as any)
    registry.firePreCompact({ turnCount: 10, messageCount: 25 })
    assert.equal(seen.length, 1)
    assert.equal(seen[0]!.turnCount, 10)
  })
})
```

- [ ] **步骤 4：运行测试验证通过**

运行：`npx tsx --test src/hooks/__tests__/registry.test.ts`
预期：所有测试 PASS

- [ ] **步骤 5：Commit**

```bash
git add src/hooks/types.ts src/hooks/registry.ts src/hooks/__tests__/registry.test.ts
git commit -m "feat(hooks): add UserPromptSubmit + PreCompact lifecycle events"
```

---

## 任务 3：Git 输出截断 + git_log + git_stash

**文件：**
- 修改：`src/tools/git.ts`
- 修改：`src/tools/__tests__/git.test.ts`

当前问题：`runGit` 返回值无大小限制，巨型 `git status`/`git diff` 输出会撑爆 LLM 上下文。缺少 `git_log` action（agent 做代码理解的刚需）。

- [ ] **步骤 1：编写失败的测试**

在 `src/tools/__tests__/git.test.ts` 末尾追加：

```ts
  it('truncates git output over 50KB', async () => {
    // Create a file with lots of content to produce large diff
    const bigContent = 'x'.repeat(60_000)
    writeFileSync(join(TMP, 'big.txt'), bigContent)
    execSync('git add .', { cwd: TMP })
    execSync('git commit -m "init"', { cwd: TMP })
    writeFileSync(join(TMP, 'big.txt'), 'y'.repeat(60_000))

    const result = await GIT_TOOL.execute({
      input: { action: 'diff_summary' },
      toolUseId: 'tu_big',
      cwd: TMP,
    })
    assert.equal(result.isError, undefined)
    assert.ok(result.content.length < 55_000, `Output too large: ${result.content.length}`)
  })

  it('returns git log with default count', async () => {
    writeFileSync(join(TMP, 'a.txt'), 'hello')
    execSync('git add .', { cwd: TMP })
    execSync('git commit -m "init"', { cwd: TMP })
    writeFileSync(join(TMP, 'b.txt'), 'world')
    execSync('git add .', { cwd: TMP })
    execSync('git commit -m "second"', { cwd: TMP })

    const result = await GIT_TOOL.execute({
      input: { action: 'log' },
      toolUseId: 'tu_log',
      cwd: TMP,
    })
    assert.equal(result.isError, undefined)
    assert.ok(result.content.includes('second'))
    assert.ok(result.content.includes('init'))
  })

  it('returns git log with maxCount', async () => {
    writeFileSync(join(TMP, 'a.txt'), 'hello')
    execSync('git add .', { cwd: TMP })
    execSync('git commit -m "first"', { cwd: TMP })
    writeFileSync(join(TMP, 'b.txt'), 'world')
    execSync('git add .', { cwd: TMP })
    execSync('git commit -m "second"', { cwd: TMP })

    const result = await GIT_TOOL.execute({
      input: { action: 'log', maxCount: 1 },
      toolUseId: 'tu_log2',
      cwd: TMP,
    })
    assert.equal(result.isError, undefined)
    assert.ok(result.content.includes('second'))
    assert.ok(!result.content.includes('first'))
  })

  it('git stash saves working changes', async () => {
    writeFileSync(join(TMP, 'a.txt'), 'hello')
    execSync('git add .', { cwd: TMP })
    execSync('git commit -m "init"', { cwd: TMP })
    writeFileSync(join(TMP, 'a.txt'), 'dirty')

    const result = await GIT_TOOL.execute({
      input: { action: 'stash' },
      toolUseId: 'tu_stash',
      cwd: TMP,
    })
    assert.equal(result.isError, undefined)
    assert.ok(result.content.includes('Saved'))
  })

  it('does not require approval for log action', () => {
    assert.equal(GIT_TOOL.requiresApproval({ input: { action: 'log' }, toolUseId: 't', cwd: '/' }), false)
  })

  it('does not require approval for stash action', () => {
    assert.equal(GIT_TOOL.requiresApproval({ input: { action: 'stash' }, toolUseId: 't', cwd: '/' }), false)
  })
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npx tsx --test src/tools/__tests__/git.test.ts`
预期：FAIL — `log` 和 `stash` action 不在 ACTIONS 列表中

- [ ] **步骤 3：修改 git.ts**

修改 `src/tools/git.ts`：

```ts
import { spawnSync } from 'node:child_process'
import type { Tool, ToolCallParams } from './types.js'

const ACTIONS = ['status', 'diff_summary', 'commit', 'log', 'stash'] as const
type GitAction = (typeof ACTIONS)[number]

const MAX_OUTPUT = 50_000

function runGit(args: string[], cwd: string): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf-8', timeout: 10_000 })
  if (result.status !== 0) {
    throw new Error((result.stderr ?? '').trim() || `git exited with status ${result.status}`)
  }
  const output = result.stdout
  if (output.length > MAX_OUTPUT) {
    return output.slice(0, MAX_OUTPUT) + `\n\n[... truncated at ${MAX_OUTPUT} chars, total ${output.length}]`
  }
  return output
}

export const GIT_TOOL: Tool = {
  definition: {
    name: 'git',
    description: `Structured git operations. Actions:
- status: Show working tree status, current branch, and file changes
- diff_summary: Show diff stats for staged and unstaged changes
- commit: Stage all changes (including untracked files) and commit with a message
- log: Show recent commit history (default 20, configurable with maxCount)
- stash: Stash current working directory changes

For complex git operations (branch, merge, rebase, push, pull), use the bash tool instead.`,
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
        maxCount: {
          type: 'number',
          description: 'Maximum number of log entries to return (default 20, for log action)',
        },
      },
      required: ['action'],
    },
  },

  async execute(params: ToolCallParams) {
    const action = params.input.action as GitAction
    const cwd = params.cwd

    if (!ACTIONS.includes(action)) {
      return { content: `Unknown action: ${action}. Supported: ${ACTIONS.join(', ')}`, isError: true }
    }

    try {
      switch (action) {
        case 'status': {
          const branch = runGit(['branch', '--show-current'], cwd).trim()
          const porcelain = runGit(['status', '--porcelain'], cwd).trim()
          const untracked = runGit(['ls-files', '--others', '--exclude-standard'], cwd).trim()
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
          const staged = runGit(['diff', '--cached', '--stat'], cwd).trim()
          const unstaged = runGit(['diff', '--stat'], cwd).trim()
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
          const status = runGit(['status', '--porcelain'], cwd).trim()
          if (!status) {
            return { content: 'Nothing to commit. Working tree clean.' }
          }
          runGit(['add', '-A'], cwd)
          const result = spawnSync('git', ['commit', '-m', message], {
            cwd,
            encoding: 'utf-8',
            timeout: 10_000,
          })
          if (result.status !== 0) {
            return { content: `git commit failed: ${(result.stderr ?? '').trim()}`, isError: true }
          }
          return { content: result.stdout.trim() }
        }

        case 'log': {
          const maxCount = (params.input.maxCount as number) ?? 20
          const log = runGit(['log', `--max-count=${maxCount}`, '--oneline', '--decorate'], cwd).trim()
          return { content: log || 'No commits yet.' }
        }

        case 'stash': {
          const status = runGit(['status', '--porcelain'], cwd).trim()
          if (!status) {
            return { content: 'No changes to stash.' }
          }
          runGit(['stash'], cwd)
          return { content: 'Saved working directory and index state.' }
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
预期：所有测试 PASS

- [ ] **步骤 5：Commit**

```bash
git add src/tools/git.ts src/tools/__tests__/git.test.ts
git commit -m "feat(git): add log + stash actions, 50KB output truncation"
```

---

## 任务 4：WebFetch 用 turndown 替换 regex htmlToMarkdown

**文件：**
- 修改：`src/tools/web-fetch.ts`
- 修改：`src/tools/__tests__/web-fetch.test.ts`
- 修改：`package.json`

当前问题：regex-based `htmlToMarkdown()` 对复杂 HTML（表格、嵌套列表、script/style 标签）处理质量差。turndown 是成熟库（2.5M 周下载），处理质量远超 regex。

- [ ] **步骤 1：安装 turndown 依赖**

```bash
npm install turndown && npm install -D @types/turndown
```

- [ ] **步骤 2：编写更新的测试**

修改 `src/tools/__tests__/web-fetch.test.ts` 中 `htmlToMarkdown` describe 块：

```ts
import { htmlToMarkdown } from '../web-fetch.js'

describe('htmlToMarkdown (turndown)', () => {
  it('strips HTML tags and preserves text', () => {
    const result = htmlToMarkdown('<p>Hello <strong>world</strong></p>')
    assert.ok(result.includes('Hello'))
    assert.ok(!result.includes('<p>'))
    assert.ok(result.includes('**world**'))
  })

  it('converts links to markdown format', () => {
    const result = htmlToMarkdown('<a href="https://example.com">link</a>')
    assert.ok(result.includes('[link](https://example.com)'))
  })

  it('handles empty input', () => {
    assert.equal(htmlToMarkdown(''), '')
  })

  it('converts headings', () => {
    const result = htmlToMarkdown('<h1>Title</h1>')
    assert.ok(result.includes('# Title'))
  })

  it('converts unordered lists', () => {
    const result = htmlToMarkdown('<ul><li>one</li><li>two</li></ul>')
    assert.ok(result.includes('one'))
    assert.ok(result.includes('two'))
  })

  it('converts code blocks', () => {
    const result = htmlToMarkdown('<pre><code>const x = 1</code></pre>')
    assert.ok(result.includes('const x = 1'))
  })

  it('strips script and style tags', () => {
    const result = htmlToMarkdown('<script>alert("xss")</script><p>visible</p><style>.x{color:red}</style>')
    assert.ok(!result.includes('alert'))
    assert.ok(!result.includes('color'))
    assert.ok(result.includes('visible'))
  })

  it('converts tables to readable text', () => {
    const html = '<table><tr><th>Name</th><th>Value</th></tr><tr><td>foo</td><td>bar</td></tr></table>'
    const result = htmlToMarkdown(html)
    assert.ok(result.includes('Name'))
    assert.ok(result.includes('foo'))
  })

  it('decodes HTML entities', () => {
    const result = htmlToMarkdown('<p>a &amp; b</p>')
    assert.ok(result.includes('a & b'))
  })
})
```

- [ ] **步骤 3：运行测试验证失败**

运行：`npx tsx --test src/tools/__tests__/web-fetch.test.ts`
预期：部分测试 FAIL — `htmlToMarkdown` 不处理 script/style，不处理列表等

- [ ] **步骤 4：修改 web-fetch.ts 用 turndown 替换 regex**

修改 `src/tools/web-fetch.ts`。删除 `htmlToMarkdown()` 函数体，替换为 turndown：

```ts
import { lookup as dnsLookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import TurndownService from 'turndown'
import type { Tool, ToolCallParams } from './types.js'

const MAX_CONTENT_LENGTH = 50_000
const MAX_REDIRECTS = 5

export interface FetchDeps {
  lookup: (hostname: string) => Promise<{ address: string }>
  fetch: (url: string, init?: RequestInit) => Promise<Response>
}

const defaultDeps: FetchDeps = {
  lookup: dnsLookup,
  fetch: globalThis.fetch.bind(globalThis),
}

const turndown = new TurndownService({
  headingStyle: 'atx',
  codeBlockStyle: 'fenced',
})

export function htmlToMarkdown(html: string): string {
  return turndown.turndown(html)
}

export function isPrivateIP(ip: string): boolean {
  // ... (保持不变，不需要修改 isPrivateIP)
  if (isIP(ip) === 4) {
    const octets = ip.split('.').map(Number)
    if (octets[0] === 10) return true
    if (octets[0] === 172 && octets[1]! >= 16 && octets[1]! <= 31) return true
    if (octets[0] === 192 && octets[1] === 168) return true
    if (octets[0] === 127) return true
    if (octets[0] === 0) return true
    if (octets[0] === 169 && octets[1] === 254) return true
    return false
  }
  if (isIP(ip) === 6) {
    const lower = ip.toLowerCase()
    if (lower === '::1') return true
    if (lower.startsWith('fc') || lower.startsWith('fd')) return true
    if (lower.startsWith('fe80')) return true
    return false
  }
  return false
}

// createWebFetchTool 保持不变（htmlToMarkdown 调用点不变）
// ... 后续代码不变
```

- [ ] **步骤 5：运行测试验证通过**

运行：`npx tsx --test src/tools/__tests__/web-fetch.test.ts`
预期：所有测试 PASS

- [ ] **步骤 6：运行全量 typecheck**

运行：`npx tsc --noEmit`
预期：PASS

- [ ] **步骤 7：Commit**

```bash
git add src/tools/web-fetch.ts src/tools/__tests__/web-fetch.test.ts package.json package-lock.json
git commit -m "feat(web-fetch): replace regex htmlToMarkdown with turndown library"
```

---

## 任务 5：Todo 并发安全 — TodoStore class

**文件：**
- 创建：`src/tools/todo-store.ts`
- 修改：`src/tools/todo.ts`
- 修改：`src/tools/__tests__/todo.test.ts`

当前问题：`currentTodos` 是模块级全局变量。当 sub-agent 并发执行时，多个 worker 的 todo 读写会互相覆盖。

- [ ] **步骤 1：编写失败的测试**

在 `src/tools/__tests__/todo.test.ts` 末尾追加：

```ts
import { TodoStore } from '../todo-store.js'

describe('TodoStore', () => {
  it('isolates state between stores', () => {
    const store1 = new TodoStore()
    const store2 = new TodoStore()

    store1.write([{ id: '1', content: 'Task A', status: 'pending' }])
    store2.write([{ id: '2', content: 'Task B', status: 'in_progress' }])

    assert.equal(store1.read().length, 1)
    assert.equal(store1.read()[0]!.content, 'Task A')
    assert.equal(store2.read().length, 1)
    assert.equal(store2.read()[0]!.content, 'Task B')
  })

  it('returns empty array for new store', () => {
    const store = new TodoStore()
    assert.deepEqual(store.read(), [])
  })

  it('write replaces entire list', () => {
    const store = new TodoStore()
    store.write([{ id: '1', content: 'Old', status: 'completed' }])
    store.write([{ id: '2', content: 'New', status: 'pending' }])
    assert.equal(store.read().length, 1)
    assert.equal(store.read()[0]!.content, 'New')
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npx tsx --test src/tools/__tests__/todo.test.ts`
预期：FAIL — `todo-store.js` 不存在

- [ ] **步骤 3：创建 TodoStore class**

创建 `src/tools/todo-store.ts`：

```ts
import { z } from 'zod'

const VALID_STATUSES = ['pending', 'in_progress', 'completed'] as const

const todoItemSchema = z.object({
  id: z.string().min(1),
  content: z.string().min(1),
  status: z.enum(VALID_STATUSES),
})

export type TodoItem = z.infer<typeof todoItemSchema>

export class TodoStore {
  private todos: TodoItem[] = []

  read(): TodoItem[] {
    return [...this.todos]
  }

  write(todos: TodoItem[]): void {
    const parsed = z.array(todoItemSchema).safeParse(todos)
    if (!parsed.success) {
      throw new Error(`Invalid todos: ${parsed.error.message}`)
    }
    this.todos = [...parsed.data]
  }

  static formatList(todos: TodoItem[]): string {
    if (todos.length === 0) return 'No todos. Use write action to create a list.'
    return todos.map(t => {
      const icon = t.status === 'completed' ? '✓' : t.status === 'in_progress' ? '►' : '○'
      return `${icon} [${t.id}] ${t.content} (${t.status})`
    }).join('\n')
  }

  static formatSummary(todos: TodoItem[]): string {
    const completed = todos.filter(t => t.status === 'completed').length
    const total = todos.length
    const summary = `Updated: ${completed}/${total} completed`
    const items = todos.map(t => {
      const icon = t.status === 'completed' ? '✓' : t.status === 'in_progress' ? '►' : '○'
      return `${icon} [${t.id}] ${t.content}`
    })
    return `${summary}\n${items.join('\n')}`
  }
}
```

- [ ] **步骤 4：修改 todo.ts 使用 TodoStore**

修改 `src/tools/todo.ts`，用默认 store 实例替换全局变量：

```ts
import type { Tool } from './types.js'
import { TodoStore } from './todo-store.js'
import { z } from 'zod'

const VALID_STATUSES = ['pending', 'in_progress', 'completed'] as const

const todoItemSchema = z.object({
  id: z.string().min(1),
  content: z.string().min(1),
  status: z.enum(VALID_STATUSES),
})

const todoActionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('read') }),
  z.object({ action: z.literal('write'), todos: z.array(todoItemSchema) }),
])

const defaultStore = new TodoStore()

export function getTodos() {
  return defaultStore.read()
}

export function setTodos(todos: TodoStore extends { write(todos: infer T): void } ? T : never) {
  defaultStore.write(todos as any[])
}

export function createTodoTool(store: TodoStore = defaultStore): Tool {
  return {
    definition: {
      name: 'todo',
      description: `Read and write the session task list. Use this to track progress on multi-step tasks.
- write: Replace the entire todo list with a new one. Each item has id, content, and status (pending/in_progress/completed).
- read: Return the current todo list.

Always update the list when completing or starting a task.`,
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

    async execute(params) {
      const parsed = todoActionSchema.safeParse(params.input)
      if (!parsed.success) {
        return { content: `Invalid input: ${parsed.error.message}`, isError: true }
      }

      const data = parsed.data

      if (data.action === 'read') {
        const todos = store.read()
        if (todos.length === 0) {
          return { content: 'No todos. Use write action to create a list.' }
        }
        return { content: TodoStore.formatList(todos) }
      }

      store.write(data.todos)

      return { content: TodoStore.formatSummary(data.todos) }
    },

    requiresApproval: () => false,
    isConcurrencySafe: () => true,
    isEnabled: () => true,
  }
}

export const TODO_TOOL: Tool = createTodoTool()
```

注意：`setTodos` 签名改为接受 `TodoItem[]`。更新 `setTodos` 的导出签名：

```ts
import type { TodoItem } from './todo-store.js'

export function setTodos(todos: TodoItem[]): void {
  defaultStore.write(todos)
}
```

- [ ] **步骤 5：运行测试验证通过**

运行：`npx tsx --test src/tools/__tests__/todo.test.ts`
预期：所有测试 PASS

- [ ] **步骤 6：运行全量 typecheck**

运行：`npx tsc --noEmit`
预期：PASS

- [ ] **步骤 7：Commit**

```bash
git add src/tools/todo-store.ts src/tools/todo.ts src/tools/__tests__/todo.test.ts
git commit -m "refactor(todo): extract TodoStore class for worker-scoped concurrency safety"
```

---

## 任务 6：Undo 孤儿备份清理

**文件：**
- 修改：`src/agent/file-history.ts`
- 修改：`src/agent/__tests__/file-history.test.ts`

当前问题：当 snapshots 超过 MAX_SNAPSHOTS (100) 被驱逐时，对应的备份文件会被删除。但如果 process 在驱逐前 crash，`backupDir/{sessionId}/` 下可能残留无引用的备份文件。需要一个 `cleanupOrphans()` 方法扫描并清理。

- [ ] **步骤 1：编写失败的测试**

在 `src/agent/__tests__/file-history.test.ts` 末尾追加：

```ts
  it('cleanupOrphans removes unreferenced backup files', async () => {
    const file = join(TMP, 'a.txt')
    writeFileSync(file, 'v1')
    await history.trackEdit(file, 'msg_1')

    // Create an orphan file in the session backup dir
    const sessionDir = join(BACKUP, 'test-session')
    const { writeFileSync: ws } = await import('node:fs')
    ws(join(sessionDir, 'orphan_file'), 'orphan content')

    // Verify orphan exists
    const { readdirSync } = await import('node:fs')
    const beforeClean = readdirSync(sessionDir)
    assert.ok(beforeClean.includes('orphan_file'))

    const removed = await history.cleanupOrphans()
    assert.ok(removed >= 1)

    const afterClean = readdirSync(sessionDir)
    assert.ok(!afterClean.includes('orphan_file'))
  })
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npx tsx --test src/agent/__tests__/file-history.test.ts`
预期：FAIL — `cleanupOrphans` 方法不存在

- [ ] **步骤 3：在 FileHistory 中新增 cleanupOrphans 方法**

在 `src/agent/file-history.ts` 的 `FileHistory` 类中，在 `getLatestSnapshotId()` 之后新增：

```ts
  async cleanupOrphans(): Promise<number> {
    const sessionDir = join(this.backupDir, this.sessionId)
    let dirEntries: string[]
    try {
      dirEntries = await (await import('node:fs/promises')).readdir(sessionDir)
    } catch {
      return 0
    }

    const referencedBackups = new Set<string>()
    for (const snapshot of this.snapshots) {
      for (const backup of Object.values(snapshot.trackedFileBackups)) {
        if (backup.backupFileName) {
          referencedBackups.add(backup.backupFileName)
        }
      }
    }

    let removed = 0
    for (const entry of dirEntries) {
      if (!referencedBackups.has(entry)) {
        try {
          await unlink(join(sessionDir, entry))
          removed++
        } catch {
          // File already gone or permission issue — skip
        }
      }
    }
    return removed
  }
```

同时在文件顶部确认已有 `unlink` 的 import（已有：`import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises'`）。

- [ ] **步骤 4：运行测试验证通过**

运行：`npx tsx --test src/agent/__tests__/file-history.test.ts`
预期：所有测试 PASS

- [ ] **步骤 5：Commit**

```bash
git add src/agent/file-history.ts src/agent/__tests__/file-history.test.ts
git commit -m "feat(undo): add cleanupOrphans to remove unreferenced backup files"
```

---

## 任务 7：全量验证 + 文档更新

**文件：**
- 修改：`docs/superpowers/status/2026-05-16-rivet-core-capability-ledger.md`

- [ ] **步骤 1：运行全量测试**

```bash
npm test
```

预期：所有测试 PASS（约 650+）

- [ ] **步骤 2：运行 typecheck**

```bash
npm run typecheck
```

预期：PASS

- [ ] **步骤 3：运行 build**

```bash
npm run build
```

预期：PASS

- [ ] **步骤 4：更新 capability ledger**

在 `docs/superpowers/status/2026-05-16-rivet-core-capability-ledger.md` 中，将 "Gap Closing" 行状态从 `Planned` 更新为 `Verified`：

| Capability | Status | Design | Plan | Primary Code | Validation | Known Gaps | Next Action |
|-----------|--------|--------|------|-------------|-----------|-----------|-------------|
| Gap Closing (hooks/git/todo/webfetch/undo) | **Verified** | — | `plans/...-rivet-gap-closing-hardening.md` | `src/hooks/*`, `src/tools/git.ts`, `src/tools/todo*.ts`, `src/tools/web-fetch.ts`, `src/agent/file-history.ts` | Plan 38/38 checked, N tests pass, hooks error isolation + 2 new events, git log/stash/truncation, turndown HTML, TodoStore concurrency, undo orphan cleanup | None | — |

同时更新 Summary 部分 Verified 计数。

- [ ] **步骤 5：Commit**

```bash
git add docs/superpowers/status/2026-05-16-rivet-core-capability-ledger.md
git commit -m "docs: mark Gap Closing hardening as Verified in capability ledger"
```

---

## 自检

### 1. 规格覆盖度

| 加固需求 | 任务 |
|---------|------|
| Hooks try/catch 隔离 | 任务 1 |
| Hooks UserPromptSubmit + PreCompact 事件 | 任务 2 |
| Git 输出截断 50KB | 任务 3 |
| Git git_log action | 任务 3 |
| Git git_stash action | 任务 3 |
| WebFetch turndown 替换 regex | 任务 4 |
| Todo 并发安全 TodoStore | 任务 5 |
| Undo 孤儿备份清理 | 任务 6 |
| 全量验证 + 文档 | 任务 7 |

全部覆盖。

### 2. 占位符扫描

无 TODO/TBD/待定/后续实现。所有代码步骤包含完整实现代码。

### 3. 类型一致性

- `HookEvent` 在 types.ts 更新为包含 `'UserPromptSubmit' | 'PreCompact'`，registry.ts 的 `fireUserPromptSubmit`/`firePreCompact` 使用对应类型 — 一致
- `TodoStore` 在 todo-store.ts 定义，todo.ts 通过 import 使用 — 一致
- `TurndownService` import 自 `turndown`，在 web-fetch.ts 中使用 — 一致
- `runGit` 签名从 `runGit(args: string, cwd: string)` 改为 `runGit(args: string[], cwd: string)`（spawnSync 安全形式）— 所有调用点已更新
- `cleanupOrphans()` 返回 `Promise<number>`，测试断言 `removed >= 1` — 一致

### 依赖说明

- 任务 4 (WebFetch) 依赖新增 npm 包 `turndown` + `@types/turndown`
- 任务 1-3, 5-6 相互独立，可并行执行
- 任务 7 依赖 1-6 全部完成
