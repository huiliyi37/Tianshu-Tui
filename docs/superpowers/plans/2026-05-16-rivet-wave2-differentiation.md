# Wave 2：差异化超越 实施计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 让 Rivet 在关键维度超越 Claude Code 和 DeepSeek-TUI：HTTP Runtime API（外部控制）、LSP 诊断集成（编辑后自动报错）、Session forking（探索分支）、审批编辑（修改后执行）、自动推理等级。

**架构：** HTTP/SSE 服务复用 headless AgentLoop；LSP 通过 PostToolUse hook 触发诊断；Session fork 基于现有 SessionPersist 的 JSONL 复制；审批编辑扩展 onApprovalRequired 回调返回修改后的 input；推理等级基于 task-state 关键词自动选择。

**技术栈：** TypeScript, Node.js (http module), existing AgentLoop/SessionPersist/hooks

---

## 文件结构

### 新建文件

| 文件 | 职责 |
|------|------|
| `src/server/index.ts` | HTTP/SSE 服务入口：路由 + 中间件 |
| `src/server/routes.ts` | REST 端点：/sessions, /prompt, /status, /abort |
| `src/server/sse-stream.ts` | SSE 事件流：tool_use, text_delta, turn_complete |
| `src/lsp/diagnostics.ts` | PostToolUse hook：编辑后触发 LSP 诊断 |
| `src/lsp/client.ts` | LSP 客户端：spawn + initialize + textDocument/diagnostic |
| `src/agent/session-fork.ts` | Session forking：复制 JSONL + 生成新 sessionId |
| `src/agent/approval-edit.ts` | 审批编辑：修改 tool input 后继续执行 |
| `src/agent/auto-reasoning.ts` | 自动推理等级：基于任务复杂度选择 effort |
| `src/__tests__/server.test.ts` | HTTP 服务测试 |
| `src/__tests__/session-fork.test.ts` | Session fork 测试 |
| `src/__tests__/approval-edit.test.ts` | 审批编辑测试 |
| `src/__tests__/auto-reasoning.test.ts` | 推理等级测试 |
| `src/__tests__/lsp-diagnostics.test.ts` | LSP 诊断测试 |

### 修改文件

| 文件 | 变更 |
|------|------|
| `src/main.tsx` | 增加 `rivet serve` 子命令分支 |
| `src/agent/loop.ts:399-400` | onApprovalRequired 返回值扩展为 `{approved, editedInput?}` |
| `src/tui/app.tsx` | /fork 命令 + 审批时显示编辑选项 |
| `src/hooks/registry.ts` | 注册 LSP PostToolUse hook |
| `src/config/schema.ts` | 增加 server + lsp 配置 |

---

## 任务 1：Session Forking

### 任务 1.1：fork 核心逻辑

**文件：**
- 创建：`src/agent/session-fork.ts`
- 测试：`src/__tests__/session-fork.test.ts`

- [ ] **步骤 1：编写失败的测试**

```typescript
// src/__tests__/session-fork.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { forkSession } from '../agent/session-fork.js'

describe('forkSession', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rivet-fork-'))
  })

  it('creates a new JSONL file with copied messages', () => {
    const original = join(dir, 'orig.jsonl')
    const lines = [
      JSON.stringify({ role: 'user', content: 'hello' }),
      JSON.stringify({ role: 'assistant', content: 'hi' }),
    ]
    require('node:fs').writeFileSync(original, lines.join('\n') + '\n')

    const result = forkSession({ sourceJsonlPath: original, targetDir: dir })

    expect(result.newSessionId).toBeTruthy()
    expect(existsSync(result.newJsonlPath)).toBe(true)
    const forkedContent = readFileSync(result.newJsonlPath, 'utf-8')
    expect(forkedContent.trim().split('\n')).toHaveLength(2)
  })

  it('generates a unique session ID different from source', () => {
    const original = join(dir, 'orig.jsonl')
    require('node:fs').writeFileSync(original, JSON.stringify({ role: 'user', content: 'x' }) + '\n')

    const r1 = forkSession({ sourceJsonlPath: original, targetDir: dir })
    const r2 = forkSession({ sourceJsonlPath: original, targetDir: dir })
    expect(r1.newSessionId).not.toBe(r2.newSessionId)
  })

  it('forks up to a specific message index', () => {
    const original = join(dir, 'orig.jsonl')
    const lines = Array.from({ length: 10 }, (_, i) =>
      JSON.stringify({ role: i % 2 === 0 ? 'user' : 'assistant', content: `msg-${i}` })
    )
    require('node:fs').writeFileSync(original, lines.join('\n') + '\n')

    const result = forkSession({ sourceJsonlPath: original, targetDir: dir, upToLine: 5 })
    const forked = readFileSync(result.newJsonlPath, 'utf-8').trim().split('\n')
    expect(forked).toHaveLength(5)
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npm test -- src/__tests__/session-fork.test.ts`
预期：FAIL — module not found

- [ ] **步骤 3：实现 session-fork.ts**

```typescript
// src/agent/session-fork.ts
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

export interface ForkOptions {
  sourceJsonlPath: string
  targetDir: string
  upToLine?: number
}

export interface ForkResult {
  newSessionId: string
  newJsonlPath: string
}

export function forkSession(options: ForkOptions): ForkResult {
  const newSessionId = randomUUID()
  const newJsonlPath = join(options.targetDir, `${newSessionId}.jsonl`)

  if (options.upToLine === undefined) {
    copyFileSync(options.sourceJsonlPath, newJsonlPath)
  } else {
    const lines = readFileSync(options.sourceJsonlPath, 'utf-8').trim().split('\n')
    writeFileSync(newJsonlPath, lines.slice(0, options.upToLine).join('\n') + '\n')
  }

  return { newSessionId, newJsonlPath }
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`npm test -- src/__tests__/session-fork.test.ts`
预期：PASS

- [ ] **步骤 5：Commit**

```bash
git add src/agent/session-fork.ts src/__tests__/session-fork.test.ts
git commit -m "feat(agent): session forking — copy JSONL to new session ID"
```

---

### 任务 1.2：/fork 命令集成

**文件：**
- 修改：`src/tui/app.tsx`

- [ ] **步骤 1：在 app.tsx 的 slash command switch 中增加 /fork**

```typescript
// src/tui/app.tsx — 在 command switch 中增加
case '/fork': {
  const { forkSession } = await import('../agent/session-fork.js')
  const result = forkSession({
    sourceJsonlPath: persist.getFilePath(),
    targetDir: join(homedir(), '.rivet', 'sessions'),
  })
  addSystemMessage(`Session forked. New session: ${result.newSessionId}\nResume with: rivet --resume ${result.newSessionId}`)
  break
}
```

- [ ] **步骤 2：运行全量测试**

运行：`npm test`
预期：PASS

- [ ] **步骤 3：Commit**

```bash
git add src/tui/app.tsx
git commit -m "feat(tui): /fork command — fork current session to explore alternatives"
```

---

## 任务 2：审批编辑（Edit Before Approve）

### 任务 2.1：ApprovalResult 类型扩展

**文件：**
- 创建：`src/agent/approval-edit.ts`
- 测试：`src/__tests__/approval-edit.test.ts`

- [ ] **步骤 1：编写测试**

```typescript
// src/__tests__/approval-edit.test.ts
import { describe, it, expect } from 'vitest'
import { type ApprovalResult, applyApprovalEdit } from '../agent/approval-edit.js'

describe('applyApprovalEdit', () => {
  it('returns original input when approved without edit', () => {
    const result: ApprovalResult = { approved: true }
    const input = { command: 'npm test' }
    expect(applyApprovalEdit(input, result)).toEqual({ command: 'npm test' })
  })

  it('returns edited input when approved with edit', () => {
    const result: ApprovalResult = { approved: true, editedInput: { command: 'npm test -- --watch' } }
    const input = { command: 'npm test' }
    expect(applyApprovalEdit(input, result)).toEqual({ command: 'npm test -- --watch' })
  })

  it('returns null when denied', () => {
    const result: ApprovalResult = { approved: false }
    const input = { command: 'rm -rf /' }
    expect(applyApprovalEdit(input, result)).toBeNull()
  })
})
```

- [ ] **步骤 2：实现 approval-edit.ts**

```typescript
// src/agent/approval-edit.ts
export interface ApprovalResult {
  approved: boolean
  editedInput?: Record<string, unknown>
}

export function applyApprovalEdit(
  originalInput: Record<string, unknown>,
  result: ApprovalResult,
): Record<string, unknown> | null {
  if (!result.approved) return null
  return result.editedInput ?? originalInput
}
```

- [ ] **步骤 3：运行测试**

运行：`npm test -- src/__tests__/approval-edit.test.ts`
预期：PASS

- [ ] **步骤 4：Commit**

```bash
git add src/agent/approval-edit.ts src/__tests__/approval-edit.test.ts
git commit -m "feat(agent): ApprovalResult type with editedInput support"
```

---

### 任务 2.2：Loop + TUI 集成

**文件：**
- 修改：`src/agent/loop.ts:399-410`
- 修改：`src/tui/app.tsx` (approval UI)

- [ ] **步骤 1：修改 AgentCallbacks 类型**

在 `src/agent/loop.ts` 中，将 `onApprovalRequired` 的返回类型从 `Promise<boolean>` 改为 `Promise<ApprovalResult | boolean>`：

```typescript
import { type ApprovalResult, applyApprovalEdit } from './approval-edit.js'

// In AgentCallbacks interface:
onApprovalRequired: (id: string, name: string, input: Record<string, unknown>) => Promise<ApprovalResult | boolean>
```

- [ ] **步骤 2：修改审批处理逻辑**

```typescript
// src/agent/loop.ts — 替换 line 399-410 的审批逻辑
if (shouldAsk) {
  const approvalResult = await callbacks.onApprovalRequired(tu.id, tu.name, tu.input)
  const resolved: ApprovalResult = typeof approvalResult === 'boolean'
    ? { approved: approvalResult }
    : approvalResult
  const finalInput = applyApprovalEdit(tu.input, resolved)
  if (!finalInput) {
    const denyMsg = 'Tool execution denied: requires user approval'
    callbacks.onToolResult(tu.id, tu.name, denyMsg, true)
    toolResults.push({ type: 'tool_result', tool_use_id: tu.id, content: denyMsg, is_error: true })
    continue
  }
  tu.input = finalInput
}
```

- [ ] **步骤 3：运行全量测试**

运行：`npm test`
预期：PASS（向后兼容 — 旧的 `boolean` 返回仍然工作）

- [ ] **步骤 4：Commit**

```bash
git add src/agent/loop.ts
git commit -m "feat(agent): approval flow supports edited input before execution"
```

---

## 任务 3：自动推理等级

### 任务 3.1：推理等级选择器

**文件：**
- 创建：`src/agent/auto-reasoning.ts`
- 测试：`src/__tests__/auto-reasoning.test.ts`

- [ ] **步骤 1：编写测试**

```typescript
// src/__tests__/auto-reasoning.test.ts
import { describe, it, expect } from 'vitest'
import { selectReasoningEffort } from '../agent/auto-reasoning.js'

describe('selectReasoningEffort', () => {
  it('returns high for complex multi-file tasks', () => {
    expect(selectReasoningEffort('Refactor the auth module across 5 files')).toBe('high')
  })

  it('returns low for simple queries', () => {
    expect(selectReasoningEffort('What does this function do?')).toBe('low')
  })

  it('returns max for architecture/design tasks', () => {
    expect(selectReasoningEffort('Design a new authentication system with OAuth2')).toBe('max')
  })

  it('returns medium for standard coding tasks', () => {
    expect(selectReasoningEffort('Add a test for the login function')).toBe('medium')
  })

  it('returns off for trivial operations', () => {
    expect(selectReasoningEffort('/compact')).toBe('off')
  })
})
```

- [ ] **步骤 2：实现 auto-reasoning.ts**

```typescript
// src/agent/auto-reasoning.ts
export type ReasoningEffort = 'off' | 'low' | 'medium' | 'high' | 'max'

const ARCHITECTURE_PATTERNS = /\b(design|architect|system|refactor.*across|migration|strategy)\b/i
const COMPLEX_PATTERNS = /\b(refactor|debug.*multiple|fix.*across|implement.*feature|rewrite)\b/i
const SIMPLE_PATTERNS = /\b(what|explain|show|list|print|read|cat)\b/i
const TRIVIAL_PATTERNS = /^\/(compact|clear|help|exit|model|theme|debug|verbose)/

export function selectReasoningEffort(input: string): ReasoningEffort {
  if (TRIVIAL_PATTERNS.test(input)) return 'off'
  if (ARCHITECTURE_PATTERNS.test(input)) return 'max'
  if (COMPLEX_PATTERNS.test(input)) return 'high'
  if (SIMPLE_PATTERNS.test(input)) return 'low'
  return 'medium'
}
```

- [ ] **步骤 3：运行测试**

运行：`npm test -- src/__tests__/auto-reasoning.test.ts`
预期：PASS

- [ ] **步骤 4：Commit**

```bash
git add src/agent/auto-reasoning.ts src/__tests__/auto-reasoning.test.ts
git commit -m "feat(agent): auto-reasoning effort selection based on task complexity"
```

---

### 任务 3.2：集成到 AgentLoop

**文件：**
- 修改：`src/agent/loop.ts`
- 修改：`src/config/schema.ts`

- [ ] **步骤 1：在 config schema 增加 auto reasoning 开关**

```typescript
// src/config/schema.ts — 在 agentSchema 中增加
export const agentSchema = z.object({
  approval: z.enum(['auto-accept', 'auto-safe', 'suggest', 'manual']).default('auto-safe'),
  maxTurns: z.number().int().positive().default(50),
  mode: z.enum(['code', 'ask', 'plan']).default('code'),
  autoReasoning: z.boolean().default(false),
})
```

- [ ] **步骤 2：在 loop.ts 的 run() 方法开头调用**

```typescript
import { selectReasoningEffort } from './auto-reasoning.js'

// In run() method, before the turn loop:
if (this.config.autoReasoning) {
  const effort = selectReasoningEffort(userInput)
  this.config.reasoningEffort = effort
}
```

- [ ] **步骤 3：运行全量测试**

运行：`npm test`
预期：PASS

- [ ] **步骤 4：Commit**

```bash
git add src/agent/loop.ts src/config/schema.ts
git commit -m "feat(agent): wire auto-reasoning into agent loop (opt-in via config)"
```

---

## 任务 4：LSP 诊断集成

### 任务 4.1：LSP 客户端

**文件：**
- 创建：`src/lsp/client.ts`
- 测试：`src/__tests__/lsp-diagnostics.test.ts`

- [ ] **步骤 1：编写测试**

```typescript
// src/__tests__/lsp-diagnostics.test.ts
import { describe, it, expect } from 'vitest'
import { parseDiagnosticOutput, formatDiagnostics } from '../lsp/diagnostics.js'

describe('parseDiagnosticOutput', () => {
  it('parses tsc output into diagnostics', () => {
    const output = `src/main.ts(10,5): error TS2304: Cannot find name 'foo'.
src/main.ts(15,3): error TS2322: Type 'string' is not assignable to type 'number'.`
    const diags = parseDiagnosticOutput(output, 'typescript')
    expect(diags).toHaveLength(2)
    expect(diags[0].file).toBe('src/main.ts')
    expect(diags[0].line).toBe(10)
    expect(diags[0].message).toContain('Cannot find name')
  })

  it('parses empty output as no diagnostics', () => {
    expect(parseDiagnosticOutput('', 'typescript')).toHaveLength(0)
  })
})

describe('formatDiagnostics', () => {
  it('formats diagnostics for tool result injection', () => {
    const diags = [{ file: 'src/a.ts', line: 5, col: 3, severity: 'error' as const, message: 'oops' }]
    const formatted = formatDiagnostics(diags)
    expect(formatted).toContain('src/a.ts:5:3')
    expect(formatted).toContain('error')
    expect(formatted).toContain('oops')
  })
})
```

- [ ] **步骤 2：实现 diagnostics.ts**

```typescript
// src/lsp/diagnostics.ts
export interface Diagnostic {
  file: string
  line: number
  col: number
  severity: 'error' | 'warning' | 'info'
  message: string
}

const TSC_PATTERN = /^(.+?)\((\d+),(\d+)\): (error|warning) TS\d+: (.+)$/

export function parseDiagnosticOutput(output: string, _lang: string): Diagnostic[] {
  return output.trim().split('\n').filter(Boolean).map(line => {
    const m = TSC_PATTERN.exec(line)
    if (!m) return null
    return {
      file: m[1],
      line: parseInt(m[2], 10),
      col: parseInt(m[3], 10),
      severity: m[4] as 'error' | 'warning',
      message: m[5],
    }
  }).filter((d): d is Diagnostic => d !== null)
}

export function formatDiagnostics(diags: Diagnostic[]): string {
  if (diags.length === 0) return ''
  return diags.map(d => `${d.file}:${d.line}:${d.col} ${d.severity}: ${d.message}`).join('\n')
}
```

- [ ] **步骤 3：运行测试**

运行：`npm test -- src/__tests__/lsp-diagnostics.test.ts`
预期：PASS

- [ ] **步骤 4：Commit**

```bash
git add src/lsp/diagnostics.ts src/__tests__/lsp-diagnostics.test.ts
git commit -m "feat(lsp): diagnostic output parser and formatter"
```

---

### 任务 4.2：PostToolUse hook 集成

**文件：**
- 创建：`src/lsp/client.ts`
- 修改：`src/hooks/registry.ts`

- [ ] **步骤 1：实现 LSP client (lightweight — spawn tsc/pyright)**

```typescript
// src/lsp/client.ts
import { execSync } from 'node:child_process'
import { parseDiagnosticOutput, formatDiagnostics, type Diagnostic } from './diagnostics.js'

export interface LspCheckResult {
  diagnostics: Diagnostic[]
  formatted: string
}

export function runTypeCheck(cwd: string, filePath: string): LspCheckResult {
  try {
    execSync(`npx tsc --noEmit --pretty false 2>&1`, { cwd, encoding: 'utf-8', timeout: 30_000 })
    return { diagnostics: [], formatted: '' }
  } catch (err: any) {
    const output = err.stdout ?? err.message ?? ''
    const diagnostics = parseDiagnosticOutput(output, 'typescript')
      .filter(d => d.file.includes(filePath) || filePath === '*')
    return { diagnostics, formatted: formatDiagnostics(diagnostics) }
  }
}

export function shouldRunDiagnostics(toolName: string, filePath?: string): boolean {
  if (toolName !== 'write_file' && toolName !== 'edit_file') return false
  if (!filePath) return false
  return /\.(ts|tsx|js|jsx)$/.test(filePath)
}
```

- [ ] **步骤 2：在 hooks 中注册 PostToolUse**

```typescript
// 在 agent loop 的 tool execution 后，增加：
import { shouldRunDiagnostics, runTypeCheck } from '../lsp/client.js'

// After successful tool execution of write_file/edit_file:
if (this.config.lspEnabled && shouldRunDiagnostics(tu.name, tu.input.path as string)) {
  const check = runTypeCheck(process.cwd(), tu.input.path as string)
  if (check.formatted) {
    // Append diagnostics to the tool result
    toolResultContent += `\n\n[LSP Diagnostics]\n${check.formatted}`
  }
}
```

- [ ] **步骤 3：运行全量测试**

运行：`npm test`
预期：PASS

- [ ] **步骤 4：Commit**

```bash
git add src/lsp/client.ts src/agent/loop.ts
git commit -m "feat(lsp): PostToolUse diagnostic check for TS/JS file edits"
```

---

## 任务 5：HTTP/SSE Runtime API

### 任务 5.1：HTTP 服务框架

**文件：**
- 创建：`src/server/index.ts`
- 测试：`src/__tests__/server.test.ts`

- [ ] **步骤 1：编写测试**

```typescript
// src/__tests__/server.test.ts
import { describe, it, expect } from 'vitest'
import { createRouter, type RouteHandler } from '../server/index.js'

describe('createRouter', () => {
  it('routes GET /status to handler', () => {
    const handler: RouteHandler = (_req) => ({ status: 200, body: { ok: true } })
    const router = createRouter({ 'GET /status': handler })
    const result = router('GET', '/status', {})
    expect(result.status).toBe(200)
    expect(result.body).toEqual({ ok: true })
  })

  it('returns 404 for unknown routes', () => {
    const router = createRouter({})
    const result = router('GET', '/nope', {})
    expect(result.status).toBe(404)
  })
})
```

- [ ] **步骤 2：实现 server/index.ts**

```typescript
// src/server/index.ts
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'

export interface RouteResponse {
  status: number
  body?: unknown
  headers?: Record<string, string>
}

export type RouteHandler = (body: unknown) => RouteResponse | Promise<RouteResponse>

export function createRouter(routes: Record<string, RouteHandler>) {
  return (method: string, path: string, body: unknown): RouteResponse => {
    const key = `${method} ${path}`
    const handler = routes[key]
    if (!handler) return { status: 404, body: { error: 'Not found' } }
    return handler(body) as RouteResponse
  }
}

export function startServer(port: number, routes: Record<string, RouteHandler>): { close: () => void } {
  const router = createRouter(routes)

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const body = await readBody(req)
    const result = await router(req.method ?? 'GET', req.url ?? '/', body)
    res.writeHead(result.status, { 'Content-Type': 'application/json', ...result.headers })
    res.end(result.body ? JSON.stringify(result.body) : '')
  })

  server.listen(port)
  return { close: () => server.close() }
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  const raw = Buffer.concat(chunks).toString()
  if (!raw) return {}
  try { return JSON.parse(raw) } catch { return {} }
}
```

- [ ] **步骤 3：运行测试**

运行：`npm test -- src/__tests__/server.test.ts`
预期：PASS

- [ ] **步骤 4：Commit**

```bash
git add src/server/index.ts src/__tests__/server.test.ts
git commit -m "feat(server): minimal HTTP router for Runtime API"
```

---

### 任务 5.2：SSE 事件流

**文件：**
- 创建：`src/server/sse-stream.ts`

- [ ] **步骤 1：实现 SSE stream helper**

```typescript
// src/server/sse-stream.ts
import type { ServerResponse } from 'node:http'

export class SseStream {
  private res: ServerResponse

  constructor(res: ServerResponse) {
    this.res = res
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    })
  }

  send(event: string, data: unknown): void {
    this.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
  }

  close(): void {
    this.send('done', {})
    this.res.end()
  }
}
```

- [ ] **步骤 2：Commit**

```bash
git add src/server/sse-stream.ts
git commit -m "feat(server): SSE stream helper for event-based output"
```

---

### 任务 5.3：路由 + AgentLoop 集成

**文件：**
- 创建：`src/server/routes.ts`
- 修改：`src/main.tsx`

- [ ] **步骤 1：实现 routes.ts**

```typescript
// src/server/routes.ts
import type { RouteHandler } from './index.js'
import { runHeadless } from '../headless.js'

export interface ServerState {
  running: boolean
  sessionId?: string
  abort?: () => void
}

export function createRoutes(state: ServerState, createAgent: () => any): Record<string, RouteHandler> {
  return {
    'GET /status': () => ({
      status: 200,
      body: { running: state.running, sessionId: state.sessionId },
    }),

    'POST /prompt': async (body: any) => {
      if (state.running) return { status: 409, body: { error: 'Session already running' } }
      state.running = true
      const result = await runHeadless({
        prompt: body.prompt,
        json: true,
        createAgent,
      })
      state.running = false
      return { status: 200, body: result.json }
    },

    'POST /abort': () => {
      state.abort?.()
      return { status: 200, body: { aborted: true } }
    },
  }
}
```

- [ ] **步骤 2：在 main.tsx 增加 serve 子命令**

```typescript
// src/main.tsx — 在 CLI 参数解析后
if (args.includes('serve') || args.includes('--serve')) {
  const port = parseInt(args[args.indexOf('--port') + 1] || '3100', 10)
  const { startServer } = await import('./server/index.js')
  const { createRoutes } = await import('./server/routes.js')
  const state = { running: false }
  const routes = createRoutes(state, () => { /* create agent */ })
  startServer(port, routes)
  console.log(`Rivet Runtime API listening on http://localhost:${port}`)
  return
}
```

- [ ] **步骤 3：运行全量测试**

运行：`npm test`
预期：PASS

- [ ] **步骤 4：Commit**

```bash
git add src/server/routes.ts src/main.tsx
git commit -m "feat(server): REST routes + 'rivet serve' command for Runtime API"
```

---

## 验收标准

| 标准 | 验证方法 |
|------|---------|
| Session fork 创建独立可 resume 的新会话 | `rivet --resume <forked-id>` 成功加载 |
| 审批编辑后工具用修改后的 input 执行 | 单元测试 + TUI 手动验证 |
| 自动推理正确分级 | 5 种输入类型各返回正确 effort |
| LSP 诊断在 TS 文件编辑后出现 | 写入有语法错误的 TS 文件，验证诊断输出 |
| HTTP API 接受 prompt 返回 JSON | `curl -X POST localhost:3100/prompt -d '{"prompt":"hello"}'` |
| 全量测试通过 | `npm test` 零失败 |
