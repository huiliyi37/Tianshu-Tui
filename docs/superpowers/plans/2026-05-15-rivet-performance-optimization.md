# Rivet 性能优化与 Claude Code 对标实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 将 Rivet 的交互性能、长会话成本、工具流式输出和缓存稳定性优化到更接近 Claude Code 的工程体验。

**架构：** 保持现有 `PromptEngine → ApiClient → AgentLoop → Ink App` 主链路不大改，优先消除热路径同步阻塞和无界重渲染。把动态上下文改成 stale-cache 非阻塞读取，把 streaming/thinking/tool 输出统一批处理，把 token 估算从每轮全量扫描改成 session 增量统计，并把已存在的 smart compact 与 provider capability 真正接入。

**技术栈：** TypeScript 5.7、Node.js 22、Ink 6、React 19、node:test、tsup、DeepSeek Anthropic-compatible SSE API。

---

## 背景

本计划来自 2026-05-15 对 `opencode-tui` 的全目录审查和代码图谱扫描。图谱结果：55 个文件、409 个节点、31 条执行流；高风险路径集中在 `src/tui/app.tsx`、`src/agent/loop.ts`、`src/api/client.ts`、`src/prompt/volatile.ts`、`src/compact/micro.ts`。

当前项目已经具备 Claude Code 类产品的关键骨架：冻结 system prompt、volatile context 独立注入、DeepSeek streaming、tool_use/tool_result loop、approval UI、session JSONL、CJK token estimation、TUI render batching。剩余问题主要不是架构方向错误，而是热路径上还有同步 I/O、状态更新过频、长会话 O(n) 扫描、配置能力未完全接通。

已验证事实：

- `npm run typecheck` 通过。
- `npm test` 当前失败，错误是 `sh: tsx: command not found`，因为 `package.json` 使用 `tsx` 但 devDependencies 未声明。
- 文档中曾暴露真实 DeepSeek API key，已替换为 `sk-xxx`，执行本计划前仍必须轮换该 key。
- `src/prompt/volatile.ts` 的 git status 读取仍用 `execSync`，cache miss 时会阻塞 TUI。
- `src/tui/app.tsx` 对 text delta 有 50ms batching，但 thinking delta 和 tool output 仍会高频触发 React render。
- `src/compact/auto.ts` 每轮重新估算全部 message token，长会话成本随历史线性增长。
- `src/compact/auto.ts` 已有 `smartCompact()`，`src/agent/loop.ts` 也支持 `compactClient`，但 `src/main.tsx` 没有传入 compact client。

## 我的开发安排

按小步 TDD + 频繁 commit 执行，建议使用新分支：

```bash
git checkout -b feat/rivet-performance-optimization
```

开发节奏：

1. **第 1 段：恢复测试基线** — 修 `tsx` 依赖，确认测试可以运行。
2. **第 2 段：交互热路径** — 改 volatile git status 为非阻塞 stale cache，给 thinking/tool output 做批处理。
3. **第 3 段：长会话成本** — 增量 token accounting，agent loop 读取缓存 token 数。
4. **第 4 段：缓存与 compact** — 接通 smart compact client，修 fingerprint/tool capability 漂移检测。
5. **第 5 段：验证** — 单测、typecheck、build、手动 TUI 体验验证。

每个任务一个 commit。不要把未跟本任务相关的重构混进 commit。不要提交 `.DS_Store`、`.wolf/hooks/_session.json`、真实 API key 或本地运行产物。

## 文件结构

### 将创建的文件

- `docs/superpowers/plans/2026-05-15-rivet-performance-optimization.md` — 本实施计划。
- `src/prompt/volatile-git.ts` — 非阻塞 git status stale-cache；只负责缓存、刷新和格式化 git status。
- `src/prompt/__tests__/volatile-git.test.ts` — 验证 stale cache 不阻塞、refresh 成功更新、并发 refresh 合并。
- `src/tui/log-state.ts` — TUI log 的纯函数：append、update tool log、裁剪可见日志、工具输出摘要。
- `src/tui/__tests__/log-state.test.ts` — 验证工具输出不重复追加、长输出摘要稳定、只保留可见窗口。
- `src/agent/__tests__/context.test.ts` — 验证 `SessionContext` 增量 token 统计。
- `src/api/__tests__/client.test.ts` — 验证 provider capability 控制 tool-json fallback，验证 abort-aware retry sleep。

### 将修改的文件

- `package.json` — 增加 `tsx` devDependency，使 `npm test` 可运行。
- `package-lock.json` — 随 `npm install -D tsx` 更新锁文件。
- `src/prompt/volatile.ts` — 移除 `execSync`，改用 `volatile-git.ts` 的 cached getter。
- `src/prompt/engine.ts` — 保持同步 `buildRequest()` 接口，只读取 stale cached volatile context。
- `src/tui/app.tsx` — 使用 `log-state.ts`，给 thinking/tool output 做 50ms batching，避免最终 tool result 重复新增日志。
- `src/tui/input.tsx` — 历史记录从 `useMemo` 改为 state，提交后立即更新内存历史。
- `src/compact/micro.ts` — 导出 `estimateMessageTokens()`，供 `SessionContext` 增量统计复用。
- `src/compact/auto.ts` — 增加 tokenCount 参数入口，避免 agent loop 每轮全量估算。
- `src/agent/context.ts` — 增加 `estimatedTokens` 状态和 getter。
- `src/agent/loop.ts` — 使用 `session.getEstimatedTokens()` 判断 auto compact；补 smart compact 测试支撑。
- `src/main.tsx` — 创建 compact client，并传入 `AgentLoop`。
- `src/api/provider.ts` — 将 `hasToolJsonInContentBug` 传入 client config。
- `src/api/deepseek.ts` — `createClient()` 传递 provider capability 到 `ApiClient`。
- `src/api/client.ts` — fallback tool JSON 提取只在 provider 开关开启时运行；retry sleep 支持 abort。
- `src/prompt/fingerprint.ts` — tool fingerprint 改为 hash canonical tool definition，而不是只 hash tool name。
- `src/prompt/__tests__/fingerprint.test.ts` — 增加 description/schema 漂移测试。

### 需要查阅的本仓库文档

- `README.md` — 当前架构说明和命令说明。
- `docs/optimization-design-v2.md` — 前一轮优化设计和 DeepSeek cache 背景。
- `docs/superpowers/specs/2026-05-15-system-prompt-expansion-design.md` — Claude Code prompt 对标背景。
- `.wolf/cerebrum.md` — Do-Not-Repeat 中的凭据处理约束。
- `.wolf/buglog.json` — 已记录测试依赖缺失和凭据泄露问题。

---

## 任务 1：恢复测试基线

**文件：**
- 修改：`package.json:21-26`
- 修改：`package-lock.json`
- 验证：`src/**/__tests__/*.test.ts`

- [ ] **步骤 1：编写失败验证**

运行：

```bash
npm test
```

预期：失败，输出包含：

```text
sh: tsx: command not found
```

- [ ] **步骤 2：添加测试运行器依赖**

运行：

```bash
npm install -D tsx
```

预期：`package.json` 的 `devDependencies` 包含：

```json
{
  "devDependencies": {
    "@types/node": "^22.0.0",
    "@types/react": "^19.2.14",
    "tsx": "^4.0.0",
    "tsup": "^8.4.0",
    "typescript": "^5.7.0"
  }
}
```

- [ ] **步骤 3：运行测试验证通过**

运行：

```bash
npm test
```

预期：所有 `node:test` 单元测试通过，进程退出码为 0。

- [ ] **步骤 4：运行类型检查**

运行：

```bash
npm run typecheck
```

预期：无 TypeScript 错误。

- [ ] **步骤 5：Commit**

```bash
git add package.json package-lock.json
git commit -m "test: add tsx test runner"
```

---

## 任务 2：实现非阻塞 volatile git status cache

**文件：**
- 创建：`src/prompt/volatile-git.ts`
- 创建：`src/prompt/__tests__/volatile-git.test.ts`
- 修改：`src/prompt/volatile.ts:1-76`

- [ ] **步骤 1：编写失败测试**

创建 `src/prompt/__tests__/volatile-git.test.ts`：

```typescript
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createGitStatusCache, formatGitStatus } from '../volatile-git.js'

describe('volatile git status cache', () => {
  it('formats branch and clean status', () => {
    assert.equal(
      formatGitStatus('main', ''),
      'Current branch: main\nStatus:\n(clean)',
    )
  })

  it('returns stale value immediately while refresh is running', async () => {
    let resolveRefresh!: (value: string | undefined) => void
    const cache = createGitStatusCache({
      ttlMs: 1,
      now: () => Date.now(),
      load: () => new Promise(resolve => { resolveRefresh = resolve }),
    })

    cache.prime('old status')
    const refresh = cache.refresh('/repo')

    assert.equal(cache.get('/repo'), 'old status')
    resolveRefresh('new status')
    await refresh
    assert.equal(cache.get('/repo'), 'new status')
  })

  it('coalesces concurrent refresh calls', async () => {
    let calls = 0
    const cache = createGitStatusCache({
      ttlMs: 30_000,
      now: () => Date.now(),
      load: async () => {
        calls++
        return 'status'
      },
    })

    await Promise.all([cache.refresh('/repo'), cache.refresh('/repo')])
    assert.equal(calls, 1)
    assert.equal(cache.get('/repo'), 'status')
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：

```bash
npx tsx --test src/prompt/__tests__/volatile-git.test.ts
```

预期：FAIL，报错包含：

```text
Cannot find module '../volatile-git.js'
```

- [ ] **步骤 3：编写最少实现代码**

创建 `src/prompt/volatile-git.ts`：

```typescript
import { execFile } from 'child_process/promises'

interface GitStatusCacheOptions {
  ttlMs: number
  now: () => number
  load: (cwd: string) => Promise<string | undefined>
}

export function formatGitStatus(branch: string, status: string): string | undefined {
  if (!branch && !status) return undefined
  return `Current branch: ${branch}\nStatus:\n${status || '(clean)'}`
}

async function loadGitStatus(cwd: string): Promise<string | undefined> {
  try {
    const [branchResult, statusResult] = await Promise.all([
      execFile('git', ['branch', '--show-current'], { cwd, timeout: 5000 }),
      execFile('git', ['status', '--short'], { cwd, timeout: 5000 }),
    ])
    return formatGitStatus(branchResult.stdout.trim(), statusResult.stdout.trim())
  } catch {
    return undefined
  }
}

export function createGitStatusCache(options: GitStatusCacheOptions) {
  let value: string | undefined
  let timestamp = 0
  let refreshing: Promise<void> | null = null

  const isFresh = () => options.now() - timestamp < options.ttlMs

  return {
    get(cwd: string): string | undefined {
      if (!isFresh() && !refreshing) {
        void this.refresh(cwd)
      }
      return value
    },

    prime(nextValue: string | undefined): void {
      value = nextValue
      timestamp = options.now()
    },

    async refresh(cwd: string): Promise<void> {
      if (refreshing) return refreshing
      refreshing = options.load(cwd).then(nextValue => {
        value = nextValue
        timestamp = options.now()
      }).finally(() => {
        refreshing = null
      })
      return refreshing
    },
  }
}

export const gitStatusCache = createGitStatusCache({
  ttlMs: 30_000,
  now: () => Date.now(),
  load: loadGitStatus,
})
```

- [ ] **步骤 4：接入 volatile.ts**

修改 `src/prompt/volatile.ts`，删除 `execSync` import 和 `getGitStatus()` 函数，改为：

```typescript
import { readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { gitStatusCache } from './volatile-git.js'

export interface VolatileContext {
  cwd: string
  rivetMd?: string
  gitStatus?: string
  workingSet?: string[]
}

let rivetMdCache: { value: string | undefined; timestamp: number } | null = null
const RIVET_MD_CACHE_TTL_MS = 30_000

function readRivetMd(cwd: string): string | undefined {
  if (rivetMdCache && Date.now() - rivetMdCache.timestamp < RIVET_MD_CACHE_TTL_MS) {
    return rivetMdCache.value
  }

  const path = join(cwd, '.rivet.md')
  try {
    if (existsSync(path)) {
      const value = readFileSync(path, 'utf-8')
      rivetMdCache = { value, timestamp: Date.now() }
      return value
    }
  } catch {}

  rivetMdCache = { value: undefined, timestamp: Date.now() }
  return undefined
}

export function buildVolatileBlock(ctx: VolatileContext): string {
  const parts: string[] = []

  const md = ctx.rivetMd ?? readRivetMd(ctx.cwd)
  if (md) {
    parts.push(`## Project Instructions\n\n${md}`)
  }

  const git = ctx.gitStatus ?? gitStatusCache.get(ctx.cwd)
  if (git) {
    parts.push(`## Git Status\n\n${git}`)
  }

  if (ctx.workingSet && ctx.workingSet.length > 0) {
    parts.push(`## Working Set\n\n${ctx.workingSet.join('\n')}`)
  }

  return parts.length > 0 ? `<context>\n${parts.join('\n\n')}\n</context>` : ''
}
```

- [ ] **步骤 5：运行测试验证通过**

运行：

```bash
npx tsx --test src/prompt/__tests__/volatile-git.test.ts src/prompt/__tests__/fingerprint.test.ts
```

预期：PASS。

- [ ] **步骤 6：确认同步 git 调用已移除**

运行：

```bash
git grep -n "execSync" -- src/prompt
```

预期：退出码 1，没有匹配项。

- [ ] **步骤 7：Commit**

```bash
git add src/prompt/volatile-git.ts src/prompt/volatile.ts src/prompt/__tests__/volatile-git.test.ts
git commit -m "perf(prompt): make volatile git status non-blocking"
```

---

## 任务 3：稳定 TUI log 更新和工具输出摘要

**文件：**
- 创建：`src/tui/log-state.ts`
- 创建：`src/tui/__tests__/log-state.test.ts`
- 修改：`src/tui/app.tsx:32-118,250-261,323-329`

- [ ] **步骤 1：编写失败测试**

创建 `src/tui/__tests__/log-state.test.ts`：

```typescript
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { appendLog, summarizeToolOutput, updateToolLog, visibleLogs, type LogEntry } from '../log-state.js'

describe('TUI log state helpers', () => {
  it('updates an existing tool log instead of appending a duplicate', () => {
    const logs: LogEntry[] = [
      { type: 'text', content: '> npm test' },
      { type: 'tool', id: 'tool-1', toolName: 'bash', content: 'running' },
    ]

    const updated = updateToolLog(logs, 'tool-1', 'bash', 'done', false)

    assert.equal(updated.length, 2)
    assert.deepEqual(updated[1], {
      type: 'tool',
      id: 'tool-1',
      toolName: 'bash',
      content: 'done',
      isError: false,
    })
  })

  it('appends when no matching tool log exists', () => {
    const updated = updateToolLog([], 'tool-1', 'bash', 'done', false)

    assert.deepEqual(updated, [{
      type: 'tool',
      id: 'tool-1',
      toolName: 'bash',
      content: 'done',
      isError: false,
    }])
  })

  it('keeps only the visible tail of logs', () => {
    const logs = Array.from({ length: 60 }, (_, i): LogEntry => ({ type: 'text', content: String(i) }))

    assert.equal(visibleLogs(logs, 50).length, 50)
    assert.equal(visibleLogs(logs, 50)[0]!.content, '10')
  })

  it('summarizes long tool output with head and tail', () => {
    const output = Array.from({ length: 80 }, (_, i) => `line-${i}`).join('\n')
    const summary = summarizeToolOutput(output, 20)

    assert.ok(summary.includes('line-0'))
    assert.ok(summary.includes('line-79'))
    assert.ok(summary.includes('60 lines omitted'))
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：

```bash
npx tsx --test src/tui/__tests__/log-state.test.ts
```

预期：FAIL，报错包含：

```text
Cannot find module '../log-state.js'
```

- [ ] **步骤 3：编写 log-state 实现**

创建 `src/tui/log-state.ts`：

```typescript
export interface LogEntry {
  type: 'text' | 'tool'
  id?: string
  content: string
  toolName?: string
  isError?: boolean
}

export function appendLog(logs: LogEntry[], entry: LogEntry): LogEntry[] {
  return [...logs, entry]
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
): LogEntry[] {
  const idx = logs.findLastIndex(entry => entry.type === 'tool' && entry.id === id)
  if (idx === -1) {
    return [...logs, { type: 'tool', id, toolName, content, isError }]
  }

  return logs.map((entry, index) => {
    if (index !== idx) return entry
    return { type: 'tool', id, toolName: entry.toolName ?? toolName, content, isError: isError ?? entry.isError }
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

- [ ] **步骤 4：接入 App log 更新**

在 `src/tui/app.tsx` 中：

1. 从 `log-state.ts` 导入类型和函数。
2. 删除本文件内的 `LogEntry` interface。
3. 修改 `addLog` 和 `updateLogEntry`：

```typescript
import { appendLog, summarizeToolOutput, updateToolLog, visibleLogs, type LogEntry } from './log-state.js'

const addLog = useCallback((entry: LogEntry) => {
  logRef.current = appendLog(logRef.current, entry)
  setLogs(visibleLogs(logRef.current, MAX_VISIBLE_LOGS))
}, [])

const updateLogEntry = useCallback((id: string, toolName: string, content: string, isError?: boolean) => {
  logRef.current = updateToolLog(logRef.current, id, toolName, content, isError)
  setLogs(visibleLogs(logRef.current, MAX_VISIBLE_LOGS))
}, [])
```

4. 修改 tool result callback，最终结果使用 update，不再追加重复 tool log：

```typescript
onToolResult: (id, name, result, isError) => {
  if (isError === undefined) {
    const prev = toolOutputAccumRef.current.get(id) || ''
    const accumulated = prev + result
    toolOutputAccumRef.current.set(id, accumulated)
    updateLogEntry(id, name, summarizeToolOutput(accumulated, 24))
  } else {
    toolOutputAccumRef.current.delete(id)
    updateLogEntry(id, name, summarizeToolOutput(result, 24), isError)
  }
},
```

- [ ] **步骤 5：运行测试验证通过**

运行：

```bash
npx tsx --test src/tui/__tests__/log-state.test.ts
```

预期：PASS。

- [ ] **步骤 6：运行类型检查**

运行：

```bash
npm run typecheck
```

预期：无 TypeScript 错误。

- [ ] **步骤 7：Commit**

```bash
git add src/tui/log-state.ts src/tui/__tests__/log-state.test.ts src/tui/app.tsx
git commit -m "perf(tui): stabilize tool log updates"
```

---

## 任务 4：批处理 thinking 和 tool output 渲染

**文件：**
- 修改：`src/tui/app.tsx:52-56,120-131,234-297`
- 测试：`src/tui/__tests__/log-state.test.ts`

- [ ] **步骤 1：扩展失败测试：工具输出摘要不会无限增长展示文本**

追加到 `src/tui/__tests__/log-state.test.ts`：

```typescript
it('summarizes appended tool chunks before rendering', () => {
  const first = 'a\n'.repeat(40)
  const second = 'b\n'.repeat(40)
  const summary = summarizeToolOutput(first + second, 24)

  assert.ok(summary.split('\n').length <= 25)
  assert.ok(summary.includes('lines omitted'))
})
```

- [ ] **步骤 2：运行测试验证通过**

运行：

```bash
npx tsx --test src/tui/__tests__/log-state.test.ts
```

预期：PASS。这个测试验证已有 helper 满足批处理展示所需约束。

- [ ] **步骤 3：在 App 中增加 thinking 和 tool flush refs**

在 `src/tui/app.tsx` 的 refs 附近加入：

```typescript
const thinkingBufferRef = useRef('')
const thinkingFlushRef = useRef<ReturnType<typeof setTimeout> | null>(null)
const toolFlushRef = useRef<ReturnType<typeof setTimeout> | null>(null)
const dirtyToolIdsRef = useRef<Set<string>>(new Set())
```

- [ ] **步骤 4：提交前清理所有 flush timer**

在 `handleSubmit()` 开头重置 buffer 的位置改成：

```typescript
streamBufferRef.current = ''
thinkingBufferRef.current = ''
toolOutputAccumRef.current.clear()
dirtyToolIdsRef.current.clear()

for (const ref of [streamFlushRef, thinkingFlushRef, toolFlushRef]) {
  if (ref.current) {
    clearTimeout(ref.current)
    ref.current = null
  }
}
```

- [ ] **步骤 5：批处理 thinking delta**

替换 `onThinkingDelta`：

```typescript
onThinkingDelta: (thinking) => {
  thinkingBufferRef.current += thinking
  if (!thinkingFlushRef.current) {
    thinkingFlushRef.current = setTimeout(() => {
      setStreamingThinking(thinkingBufferRef.current)
      thinkingFlushRef.current = null
    }, 50)
  }
},
```

- [ ] **步骤 6：批处理 tool output 中间态**

在 callback 内增加 local helper：

```typescript
const scheduleToolFlush = (id: string, name: string) => {
  dirtyToolIdsRef.current.add(id)
  if (!toolFlushRef.current) {
    toolFlushRef.current = setTimeout(() => {
      for (const dirtyId of dirtyToolIdsRef.current) {
        const accumulated = toolOutputAccumRef.current.get(dirtyId)
        if (accumulated !== undefined) {
          updateLogEntry(dirtyId, name, summarizeToolOutput(accumulated, 24))
        }
      }
      dirtyToolIdsRef.current.clear()
      toolFlushRef.current = null
    }, 50)
  }
}
```

把中间 chunk 分支改成：

```typescript
const prev = toolOutputAccumRef.current.get(id) || ''
toolOutputAccumRef.current.set(id, prev + result)
scheduleToolFlush(id, name)
```

- [ ] **步骤 7：turn complete 时 flush thinking 和 tool timer**

在 `onTurnComplete` 中清理 text buffer 的位置追加：

```typescript
if (thinkingFlushRef.current) {
  clearTimeout(thinkingFlushRef.current)
  thinkingFlushRef.current = null
}
setStreamingThinking(thinkingBufferRef.current)
thinkingBufferRef.current = ''

if (toolFlushRef.current) {
  clearTimeout(toolFlushRef.current)
  toolFlushRef.current = null
}
dirtyToolIdsRef.current.clear()
```

- [ ] **步骤 8：运行类型检查和测试**

运行：

```bash
npm run typecheck && npx tsx --test src/tui/__tests__/log-state.test.ts
```

预期：全部通过。

- [ ] **步骤 9：Commit**

```bash
git add src/tui/app.tsx src/tui/__tests__/log-state.test.ts
git commit -m "perf(tui): batch thinking and tool output renders"
```

---

## 任务 5：修复输入历史的内存状态

**文件：**
- 修改：`src/tui/input.tsx:1-34`
- 测试：`src/tui/__tests__/history.test.ts`

- [ ] **步骤 1：编写失败测试**

创建 `src/tui/__tests__/history.test.ts`：

```typescript
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { nextHistoryAfterSubmit } from '../history.js'

describe('prompt history helpers', () => {
  it('adds newest entry to the front', () => {
    assert.deepEqual(nextHistoryAfterSubmit(['old'], 'new'), ['new', 'old'])
  })

  it('does not duplicate the current newest entry', () => {
    assert.deepEqual(nextHistoryAfterSubmit(['same', 'old'], 'same'), ['same', 'old'])
  })

  it('ignores blank input', () => {
    assert.deepEqual(nextHistoryAfterSubmit(['old'], '   '), ['old'])
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：

```bash
npx tsx --test src/tui/__tests__/history.test.ts
```

预期：FAIL，报错包含：

```text
The requested module '../history.js' does not provide an export named 'nextHistoryAfterSubmit'
```

- [ ] **步骤 3：添加纯函数**

修改 `src/tui/history.ts`：

```typescript
export function nextHistoryAfterSubmit(history: string[], entry: string): string[] {
  const trimmed = entry.trim()
  if (!trimmed) return history
  if (history[0] === trimmed) return history
  return [trimmed, ...history].slice(0, MAX_HISTORY)
}

export function appendHistory(entry: string): void {
  const history = nextHistoryAfterSubmit(loadHistory(), entry)
  const dir = join(homedir(), '.rivet')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileSync(HISTORY_PATH, JSON.stringify(history, null, 2))
}
```

- [ ] **步骤 4：InputBar 使用 state 保存 history**

修改 `src/tui/input.tsx`：

```typescript
import { useState } from 'react'
import { Box, Text } from 'ink'
import { BaseTextInput } from './base-text-input.js'
import { appendHistory, loadHistory, nextHistoryAfterSubmit } from './history.js'

export function InputBar({ onSubmit, disabled }: InputBarProps) {
  const [value, setValue] = useState('')
  const [history, setHistory] = useState(() => loadHistory())

  return (
    <Box flexDirection="row" paddingX={1} paddingY={0}>
      <Text bold color="green">❯ </Text>
      <BaseTextInput
        value={value}
        onChange={setValue}
        onSubmit={(v) => {
          const trimmed = v.trim()
          if (trimmed) {
            appendHistory(trimmed)
            setHistory(current => nextHistoryAfterSubmit(current, trimmed))
            onSubmit(trimmed)
            setValue('')
          }
        }}
        disabled={disabled}
        placeholder="Type a message... (↑↓ history)"
        history={history}
      />
    </Box>
  )
}
```

- [ ] **步骤 5：运行测试和类型检查**

运行：

```bash
npm run typecheck && npx tsx --test src/tui/__tests__/history.test.ts
```

预期：全部通过。

- [ ] **步骤 6：Commit**

```bash
git add src/tui/history.ts src/tui/input.tsx src/tui/__tests__/history.test.ts
git commit -m "fix(tui): refresh prompt history after submit"
```

---

## 任务 6：SessionContext 增量 token accounting

**文件：**
- 修改：`src/compact/micro.ts:36-76`
- 修改：`src/agent/context.ts:1-83`
- 创建：`src/agent/__tests__/context.test.ts`
- 修改：`src/compact/__tests__/compact.test.ts`

- [ ] **步骤 1：编写失败测试**

创建 `src/agent/__tests__/context.test.ts`：

```typescript
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { SessionContext } from '../context.js'
import type { Message } from '../../api/types.js'

describe('SessionContext token accounting', () => {
  it('increments estimated tokens when messages are added', () => {
    const session = new SessionContext()

    session.addUserMessage('hello world')
    session.addAssistantBlocks([{ type: 'text', text: 'hi there' }])

    assert.equal(session.getEstimatedTokens(), 10)
  })

  it('recomputes estimated tokens when messages are replaced', () => {
    const session = new SessionContext()
    const messages: Message[] = [
      { role: 'user', content: 'abcd' },
      { role: 'assistant', content: [{ type: 'text', text: 'abcdefgh' }] },
    ]

    session.replaceMessages(messages)

    assert.equal(session.getEstimatedTokens(), 8)
  })

  it('loads persisted messages and updates turn count plus token count', () => {
    const session = new SessionContext()

    session.loadMessages([
      { role: 'user', content: 'abcd' },
      { role: 'assistant', content: 'abcd' },
    ])

    assert.equal(session.getTurnCount(), 1)
    assert.equal(session.getEstimatedTokens(), 2)
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：

```bash
npx tsx --test src/agent/__tests__/context.test.ts
```

预期：FAIL，报错包含：

```text
session.getEstimatedTokens is not a function
```

- [ ] **步骤 3：导出 estimateMessageTokens**

修改 `src/compact/micro.ts`：

```typescript
export function estimateMessageTokens(msg: Message): number {
  const content = typeof msg.content === 'string'
    ? msg.content
    : JSON.stringify(msg.content)

  let asciiChars = 0
  let cjkChars = 0
  for (const ch of content) {
    const code = ch.codePointAt(0) ?? 0
    if (
      (code >= 0x4E00 && code <= 0x9FFF) ||
      (code >= 0x3400 && code <= 0x4DBF) ||
      (code >= 0x20000 && code <= 0x2A6DF) ||
      (code >= 0x3040 && code <= 0x309F) ||
      (code >= 0x30A0 && code <= 0x30FF) ||
      (code >= 0xAC00 && code <= 0xD7AF)
    ) {
      cjkChars++
    } else {
      asciiChars++
    }
  }
  return Math.ceil(asciiChars / 4) + Math.ceil(cjkChars / 1.5)
}
```

- [ ] **步骤 4：SessionContext 增量维护 token**

修改 `src/agent/context.ts`：

```typescript
import type { Message, ContentBlock, Usage } from '../api/types.js'
import { estimateMessageTokens, estimateTokens } from '../compact/micro.js'

export interface SessionState {
  messages: Message[]
  totalUsage: Usage
  turnCount: number
  startTime: number
  estimatedTokens: number
}
```

构造函数加入：

```typescript
estimatedTokens: 0,
```

修改 message 写入方法：

```typescript
addUserMessage(content: string): void {
  const message: Message = { role: 'user', content }
  this.state.messages.push(message)
  this.state.estimatedTokens += estimateMessageTokens(message)
  this.state.turnCount++
}

replaceMessages(messages: Message[]): void {
  this.state.messages = messages
  this.state.estimatedTokens = estimateTokens(messages)
}

loadMessages(messages: Message[]): void {
  this.state.messages = messages
  this.state.turnCount = messages.filter(m => m.role === 'user' && typeof m.content === 'string').length
  this.state.estimatedTokens = estimateTokens(messages)
}

addAssistantBlocks(blocks: ContentBlock[]): void {
  const message: Message = { role: 'assistant', content: blocks }
  this.state.messages.push(message)
  this.state.estimatedTokens += estimateMessageTokens(message)
}

addToolResults(results: ContentBlock[]): void {
  const message: Message = { role: 'user', content: results }
  this.state.messages.push(message)
  this.state.estimatedTokens += estimateMessageTokens(message)
}

getEstimatedTokens(): number {
  return this.state.estimatedTokens
}
```

- [ ] **步骤 5：运行测试验证通过**

运行：

```bash
npx tsx --test src/agent/__tests__/context.test.ts src/compact/__tests__/compact.test.ts
```

预期：PASS。

- [ ] **步骤 6：Commit**

```bash
git add src/compact/micro.ts src/agent/context.ts src/agent/__tests__/context.test.ts
git commit -m "perf(agent): track estimated tokens incrementally"
```

---

## 任务 7：AgentLoop 使用缓存 token count 并接通 smart compact

**文件：**
- 修改：`src/compact/auto.ts:30-53`
- 修改：`src/agent/loop.ts:81-87`
- 修改：`src/agent/__tests__/loop.test.ts`
- 修改：`src/main.tsx:111-136`

- [ ] **步骤 1：编写失败测试：AgentLoop 使用 compactClient**

在 `src/agent/__tests__/loop.test.ts` 增加：

```typescript
describe('AgentLoop — smart compaction', () => {
  it('uses compactClient when auto compaction triggers', async () => {
    const session = new SessionContext()
    const registry = new ToolRegistry()
    registry.register(READ_FILE_TOOL)

    const big = 'x'.repeat(200_000 * 4)
    for (let i = 0; i < 6; i++) {
      session.addUserMessage(big)
    }

    let compactCalled = false
    const compactClient: ApiClient = {
      stream: mock.fn(async (_req: unknown, cb: StreamCallbacks) => {
        compactCalled = true
        cb.onTextDelta('summary')
        cb.onStopReason('end_turn', { input_tokens: 1, output_tokens: 1 })
      }),
    } as unknown as ApiClient

    const client = mockClient([makeTextBlock('done')], 'end_turn')
    const agent = new AgentLoop({
      client,
      promptEngine: makeEngine(),
      toolRegistry: registry,
      maxTurns: 2,
      contextWindow: 1_000_000,
      compact: { enabled: true, autoThreshold: 800_000, autoFloor: 500_000, model: 'deepseek-v4-flash' },
      compactClient,
      compactModel: 'deepseek-v4-flash',
    }, session, '/test')

    await agent.run('hello', {
      onTextDelta: () => {},
      onThinkingDelta: () => {},
      onToolUse: () => {},
      onToolResult: () => {},
      onTurnComplete: () => {},
      onError: () => {},
      onAbort: () => {},
      onApprovalRequired: async () => false,
    })

    assert.equal(compactCalled, true)
    assert.ok(session.getMessages()[0]!.content.toString().includes('compact-summary'))
  })
})
```

- [ ] **步骤 2：运行测试验证当前行为**

运行：

```bash
npx tsx --test src/agent/__tests__/loop.test.ts
```

预期：新增测试在主入口未接 compact client 前不覆盖 `main.tsx`，但 AgentLoop 分支应能通过。如果失败，错误会指向 token count 或 compact summary 逻辑。

- [ ] **步骤 3：让 shouldAutoCompact 接受已计算 tokenCount**

修改 `src/compact/auto.ts` 函数签名和 tokenCount 行：

```typescript
export function shouldAutoCompact(
  messages: Message[],
  config: CompactionConfig,
  estimatedTokenCount?: number,
): CompactionDecision {
  if (!config.enabled) {
    return { shouldCompact: false, reason: 'disabled', tokenCount: 0 }
  }

  const tokenCount = estimatedTokenCount ?? estimateTokens(messages)
```

- [ ] **步骤 4：AgentLoop 使用 session token cache**

修改 `src/agent/loop.ts`：

```typescript
const messages = this.session.getMessages()
const decision = shouldAutoCompact(messages, this.config.compact, this.session.getEstimatedTokens())
if (decision.shouldCompact) {
  const { messages: compacted } = await this.compactMessages(messages, decision.tokenCount)
  this.session.replaceMessages(compacted)
}
```

- [ ] **步骤 5：main.tsx 创建 compact client**

在 `src/main.tsx` 的 `useMemo` 内创建 compact client：

```typescript
const compactModel = provider.models.find(m => m.id === config.compact.model || m.alias === config.compact.model)
const compactClient = compactModel ? createDeepSeekClient({
  apiKey,
  model: compactModel.id,
  reasoningEffort: compactModel.reasoningEffort,
  maxTokens: Math.min(2048, compactModel.maxTokens),
  thinkingBudget: 1024,
}) : undefined
```

传入 `AgentLoop` config：

```typescript
compactClient,
compactModel: compactModel?.id,
```

- [ ] **步骤 6：运行测试和类型检查**

运行：

```bash
npm run typecheck && npx tsx --test src/agent/__tests__/loop.test.ts src/compact/__tests__/compact.test.ts
```

预期：全部通过。

- [ ] **步骤 7：Commit**

```bash
git add src/compact/auto.ts src/agent/loop.ts src/agent/__tests__/loop.test.ts src/main.tsx
git commit -m "perf(agent): use cached token counts for compaction"
```

---

## 任务 8：Provider capability 控制 tool JSON fallback

**文件：**
- 修改：`src/api/provider.ts:8-23`
- 修改：`src/api/deepseek.ts:28-45`
- 修改：`src/api/client.ts:15-35,222-235`
- 创建：`src/api/__tests__/client.test.ts`

- [ ] **步骤 1：编写失败测试**

创建 `src/api/__tests__/client.test.ts`：

```typescript
import { describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'
import { ReadableStream } from 'node:stream/web'
import { ApiClient } from '../client.js'
import type { ContentBlock } from '../types.js'

function sseResponse(events: string[]): Response {
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(events.join('')))
      controller.close()
    },
  })
  return new Response(body as unknown as BodyInit, { status: 200 })
}

function textToolJsonEvents(): string[] {
  return [
    'event: content_block_start\n',
    'data: {"content_block":{"type":"text"}}\n\n',
    'event: content_block_delta\n',
    'data: {"delta":{"type":"text_delta","text":"{\\"name\\":\\"read_file\\",\\"input\\":{\\"file_path\\":\\"/tmp/a\\"}}"}}\n\n',
    'event: content_block_stop\n',
    'data: {}\n\n',
    'event: message_delta\n',
    'data: {"delta_stop_reason":"end_turn","usage":{}}\n\n',
  ]
}

describe('ApiClient provider capabilities', () => {
  it('extracts tool JSON from text only when provider enables the fallback', async () => {
    const originalFetch = globalThis.fetch
    const fetchMock = mock.fn(async () => sseResponse(textToolJsonEvents()))
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const blocks: ContentBlock[] = []
    const client = new ApiClient({
      baseUrl: 'https://example.test',
      apiKey: 'test-key',
      model: 'test-model',
      maxTokens: 100,
      thinking: 'disabled',
      unsupported: [],
      hasToolJsonInContentBug: true,
    })

    await client.stream(
      { model: 'test-model', messages: [{ role: 'user', content: 'x' }], max_tokens: 100, stream: true },
      {
        onTextDelta: () => {},
        onThinkingDelta: () => {},
        onContentBlock: block => blocks.push(block),
        onStopReason: () => {},
        onError: error => { throw error },
      },
    )

    globalThis.fetch = originalFetch
    assert.equal(blocks.some(block => block.type === 'tool_use'), true)
  })

  it('does not extract tool JSON when provider disables the fallback', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = mock.fn(async () => sseResponse(textToolJsonEvents())) as unknown as typeof fetch

    const blocks: ContentBlock[] = []
    const client = new ApiClient({
      baseUrl: 'https://example.test',
      apiKey: 'test-key',
      model: 'test-model',
      maxTokens: 100,
      thinking: 'disabled',
      unsupported: [],
      hasToolJsonInContentBug: false,
    })

    await client.stream(
      { model: 'test-model', messages: [{ role: 'user', content: 'x' }], max_tokens: 100, stream: true },
      {
        onTextDelta: () => {},
        onThinkingDelta: () => {},
        onContentBlock: block => blocks.push(block),
        onStopReason: () => {},
        onError: error => { throw error },
      },
    )

    globalThis.fetch = originalFetch
    assert.equal(blocks.some(block => block.type === 'tool_use'), false)
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：

```bash
npx tsx --test src/api/__tests__/client.test.ts
```

预期：FAIL，TypeScript 或运行时报错包含：

```text
hasToolJsonInContentBug
```

- [ ] **步骤 3：扩展 ClientConfig**

修改 `src/api/client.ts`：

```typescript
export interface ClientConfig {
  baseUrl: string
  apiKey: string
  model: string
  maxTokens: number
  thinking: 'enabled' | 'disabled'
  thinkingBudget?: number
  reasoningEffort?: string
  unsupported: string[]
  hasToolJsonInContentBug: boolean
  mapUsage?: (raw: Record<string, unknown>) => Partial<Usage>
}
```

- [ ] **步骤 4：按 capability gate fallback**

修改 `flushTextBlock()`：

```typescript
if (this.config.hasToolJsonInContentBug) {
  const extracted = extractToolJsonFromText(textContent)
  if (extracted) {
    callbacks.onContentBlock({
      type: 'tool_use',
      id: `fallback_${Date.now()}`,
      name: extracted.name,
      input: extracted.input,
    })
  }
}
```

- [ ] **步骤 5：factory 传递 capability**

修改 `src/api/deepseek.ts` 的 `clientConfig`：

```typescript
hasToolJsonInContentBug: capabilities.hasToolJsonInContentBug,
```

- [ ] **步骤 6：运行测试和类型检查**

运行：

```bash
npm run typecheck && npx tsx --test src/api/__tests__/client.test.ts
```

预期：全部通过。

- [ ] **步骤 7：Commit**

```bash
git add src/api/client.ts src/api/deepseek.ts src/api/__tests__/client.test.ts
git commit -m "fix(api): gate DeepSeek tool-json fallback by provider capability"
```

---

## 任务 9：retry backoff 支持 abort

**文件：**
- 修改：`src/api/client.ts:124-157`
- 修改：`src/api/__tests__/client.test.ts`

- [ ] **步骤 1：编写失败测试**

追加到 `src/api/__tests__/client.test.ts`：

```typescript
it('aborts retry sleep immediately', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = mock.fn(async () => new Response('rate limited', { status: 429 })) as unknown as typeof fetch

  const client = new ApiClient({
    baseUrl: 'https://example.test',
    apiKey: 'test-key',
    model: 'test-model',
    maxTokens: 100,
    thinking: 'disabled',
    unsupported: [],
    hasToolJsonInContentBug: false,
  })
  const controller = new AbortController()
  const started = Date.now()

  const promise = client.stream(
    { model: 'test-model', messages: [{ role: 'user', content: 'x' }], max_tokens: 100, stream: true },
    {
      onTextDelta: () => {},
      onThinkingDelta: () => {},
      onContentBlock: () => {},
      onStopReason: () => {},
      onError: () => {},
    },
    controller.signal,
  )

  controller.abort()
  await assert.rejects(promise)
  globalThis.fetch = originalFetch
  assert.ok(Date.now() - started < 500)
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：

```bash
npx tsx --test src/api/__tests__/client.test.ts
```

预期：FAIL，耗时接近当前 retry delay 或断言 `< 500` 失败。

- [ ] **步骤 3：实现 abort-aware sleep**

修改 `src/api/client.ts`：

```typescript
function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(new DOMException('Aborted', 'AbortError'))
  }

  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(new DOMException('Aborted', 'AbortError'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}
```

替换 retry sleep：

```typescript
const delay = apiErr?.retryAfterMs ?? BASE_DELAY_MS * Math.pow(2, attempt - 1)
await abortableDelay(delay, signal)
```

- [ ] **步骤 4：运行测试和类型检查**

运行：

```bash
npm run typecheck && npx tsx --test src/api/__tests__/client.test.ts
```

预期：全部通过。

- [ ] **步骤 5：Commit**

```bash
git add src/api/client.ts src/api/__tests__/client.test.ts
git commit -m "fix(api): abort retry backoff promptly"
```

---

## 任务 10：fingerprint 检测完整 tool definition 漂移

**文件：**
- 修改：`src/prompt/fingerprint.ts:20-33`
- 修改：`src/prompt/__tests__/fingerprint.test.ts:44-50`

- [ ] **步骤 1：编写失败测试**

在 `src/prompt/__tests__/fingerprint.test.ts` 的 `computeFingerprint` describe 内增加：

```typescript
it('detects tool description changes', () => {
  const fp1 = computeFingerprint('system', SAMPLE_TOOLS)
  const modified = SAMPLE_TOOLS.map(tool => tool.name === 'bash'
    ? { ...tool, description: 'Run shell commands with approval rules' }
    : tool)
  const fp2 = computeFingerprint('system', modified)

  assert.notEqual(fp1.toolsSha256, fp2.toolsSha256)
  assert.notEqual(fp1.combinedSha256, fp2.combinedSha256)
})

it('detects tool schema changes', () => {
  const fp1 = computeFingerprint('system', SAMPLE_TOOLS)
  const modified = SAMPLE_TOOLS.map(tool => tool.name === 'read_file'
    ? {
        ...tool,
        input_schema: {
          ...tool.input_schema,
          required: ['file_path'],
        },
      }
    : tool)
  const fp2 = computeFingerprint('system', modified)

  assert.notEqual(fp1.toolsSha256, fp2.toolsSha256)
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：

```bash
npx tsx --test src/prompt/__tests__/fingerprint.test.ts
```

预期：FAIL，新增两个断言失败，因为当前只 hash tool name。

- [ ] **步骤 3：实现 stable JSON hash**

修改 `src/prompt/fingerprint.ts`：

```typescript
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`
  }
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>
    return `{${Object.keys(obj).sort().map(key => `${JSON.stringify(key)}:${stableStringify(obj[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}
```

替换 tools hash：

```typescript
const toolsSha256 = tools && tools.length > 0
  ? sha256(stableStringify([...tools].sort((a, b) => a.name.localeCompare(b.name))))
  : sha256('')
```

- [ ] **步骤 4：运行测试和类型检查**

运行：

```bash
npm run typecheck && npx tsx --test src/prompt/__tests__/fingerprint.test.ts
```

预期：全部通过。

- [ ] **步骤 5：Commit**

```bash
git add src/prompt/fingerprint.ts src/prompt/__tests__/fingerprint.test.ts
git commit -m "fix(prompt): fingerprint full tool definitions"
```

---

## 任务 11：全量验证和手动 TUI 验证

**文件：**
- 验证：`package.json`
- 验证：`src/**/__tests__/*.test.ts`
- 验证：`dist/main.js`

- [ ] **步骤 1：运行完整单测**

运行：

```bash
npm test
```

预期：所有 `src/**/__tests__/*.test.ts` 通过，退出码 0。

- [ ] **步骤 2：运行 TypeScript 检查**

运行：

```bash
npm run typecheck
```

预期：无错误。

- [ ] **步骤 3：运行构建**

运行：

```bash
npm run build
```

预期：`dist/main.js` 生成，tsup 退出码 0。

- [ ] **步骤 4：手动验证 TUI golden path**

运行：

```bash
DEEPSEEK_API_KEY=sk-xxx node dist/main.js
```

手动输入：

```text
你好，请简短介绍这个项目
```

预期：

- 中文可输入。
- thinking 区域不会每 token 闪烁。
- status bar 保持可见。
- 回答流式输出稳定。

- [ ] **步骤 5：手动验证 bash 大输出不会刷屏卡顿**

在 TUI 输入：

```text
运行一个命令列出 src 目录并告诉我结果
```

预期：

- bash tool card 只显示摘要。
- 最终 tool card 不重复出现两张相同卡片。
- TUI 在工具输出期间仍可响应 Ctrl+C。

- [ ] **步骤 6：验证无密钥残留**

运行：

```bash
git grep -nE 'sk-[A-Za-z0-9]{20,}' -- . ':!package-lock.json'
```

预期：退出码 1，没有匹配项。

- [ ] **步骤 7：最终 Commit**

如果步骤 1-6 发现只需测试/文档修正，单独提交：

```bash
git add docs/superpowers/plans/2026-05-15-rivet-performance-optimization.md
git commit -m "docs: add Rivet performance optimization plan"
```

如果步骤 1-6 发现代码修正，先提交代码修正，再提交文档。

---

## 自检结果

**规格覆盖度：**

- 背景说明：已在“背景”中记录审查来源、图谱结果、已验证事实和现有问题。
- 开发安排：已在“我的开发安排”中拆成 5 个开发段，要求每任务一个 commit。
- 性能优化：任务 2、3、4、6、7 覆盖 volatile、TUI render、tool output、token accounting、compact。
- Claude Code 对标：计划采用非阻塞动态上下文、稳定 prefix、明确 tool capability、频繁验证和小步 commit。
- 安全约束：任务 11 验证无 API key 残留，背景提醒轮换已泄露 key。
- 测试基线：任务 1 修复 test runner，后续任务都包含具体测试命令。

**占位符扫描：**

- 没有使用“待定”、“补充细节”、“为上述代码编写测试”这类不可执行描述。
- 每个代码任务都有明确文件、测试代码、实现代码、命令和预期输出。

**类型一致性：**

- `LogEntry` 在任务 3 中定义，任务 4 复用同一类型。
- `getEstimatedTokens()` 在任务 6 中定义，任务 7 使用同名方法。
- `hasToolJsonInContentBug` 在任务 8 中加入 `ClientConfig`，测试和 `deepseek.ts` 使用同一字段名。
- `stableStringify()` 只在 `fingerprint.ts` 内部使用，不暴露给其他模块。
