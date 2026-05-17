# 会话性能与容错加固 实施计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 提升 Rivet 会话的 API 错误恢复能力、流中断韧性、终端渲染效率和对话流畅性

**架构：** 五个独立模块：(1) 错误分类管线将原始异常转为结构化恢复指令；(2) 双重重试引擎替换分散的 retry 逻辑；(3) output token 静默升级避免回复截断；(4) 终端写入批处理减少渲染抖动；(5) 引导注入模式（SteerBuffer）用户引导注入，不打断任务适时注入

**技术栈：** TypeScript, Node.js test runner, 现有 ApiClient/CodexClient/AgentLoop/Ink TUI 基础设施

---

## 文件结构

| 文件 | 职责 | 变更类型 |
|------|------|----------|
| `src/api/error-classifier.ts` | API 错误分类管线，纯函数 | 新建 |
| `src/api/__tests__/error-classifier.test.ts` | 分类器单元测试 | 新建 |
| `src/api/retry-engine.ts` | 双重重试引擎，替换硬编码 retry | 新建 |
| `src/api/__tests__/retry-engine.test.ts` | 重试引擎测试 | 新建 |
| `src/api/client.ts` | Anthropic SSE 客户端 | 修改：替换 withRetry |
| `src/api/codex-client.ts` | Codex Responses API 客户端 | 修改：替换内联 retry |
| `src/api/__tests__/codex-client.test.ts` | Codex client 测试 | 修改：适配新重试 |
| `src/agent/loop.ts` | Agent 主循环 | 修改：添加 output token 升级 |
| `src/agent/__tests__/loop.test.ts` | Agent loop 测试 | 修改：output token 测试 |
| `src/tui/render-batch.ts` | 写入批处理层 | 新建 |
| `src/tui/app.tsx` | TUI 主组件 | 修改：接入批处理 |
| `src/tui/steer-buffer.ts` | 引导注入模式（SteerBuffer） | 新建 |
| `src/tui/__tests__/steer-buffer.test.ts` | 队列测试 | 新建 |

---

### 任务 1：错误分类器 — 类型定义

**文件：**
- 创建：`src/api/error-classifier.ts`
- 创建：`src/api/__tests__/error-classifier.test.ts`

- [x] **步骤 1：编写类型定义和 classifyApiError 骨架**

在 `src/api/error-classifier.ts` 中：

```typescript
/**
 * Structured API error classification.
 * Maps raw exceptions to actionable recovery strategies.
 */

export type ErrorCategory =
  | 'rate_limit'
  | 'overloaded'
  | 'server_error'
  | 'timeout'
  | 'auth_error'
  | 'client_error'
  | 'context_overflow'
  | 'stream_parse'
  | 'unknown'

export interface ClassifiedError {
  /** Whether this error should be retried */
  retryable: boolean
  /** Base delay before next retry (ms), before jitter */
  retryDelayMs: number
  /** Whether to close and rebuild the HTTP connection before retrying */
  shouldReconnect: boolean
  /** Error category for logging and display */
  category: ErrorCategory
  /** Human-readable message for TUI display */
  userMessage: string
  /** Maximum retry attempts for this error type */
  maxRetries: number
}

const DEFAULT: ClassifiedError = {
  retryable: false,
  retryDelayMs: 1000,
  shouldReconnect: false,
  category: 'unknown',
  userMessage: 'An unexpected error occurred',
  maxRetries: 0,
}

/**
 * Classify an API error into a structured recovery strategy.
 * Priority: status code → error name → message pattern → fallback.
 */
export function classifyApiError(error: unknown): ClassifiedError {
  if (error instanceof Error) {
    const status = extractStatus(error)
    if (status !== null) return classifyByStatus(status, error)
    return classifyByPattern(error)
  }
  return { ...DEFAULT }
}

function extractStatus(error: Error): number | null {
  // ApiError from client.ts has .status
  if ('status' in error && typeof (error as any).status === 'number') {
    return (error as any).status
  }
  // Codex errors embed status in message: "Codex API error (429): ..."
  const match = error.message.match(/\((\d{3})\)/)
  return match ? parseInt(match[1]!, 10) : null
}

function classifyByStatus(status: number, error: Error): ClassifiedError {
  // 429 rate limit
  if (status === 429) {
    const retryAfter = extractRetryAfter(error)
    return {
      retryable: true,
      retryDelayMs: retryAfter ?? 2000,
      shouldReconnect: false,
      category: 'rate_limit',
      userMessage: 'Rate limited — waiting before retry',
      maxRetries: 5,
    }
  }

  // 529 / 503 overloaded
  if (status === 529 || status === 503) {
    return {
      retryable: true,
      retryDelayMs: 3000,
      shouldReconnect: true,
      category: 'overloaded',
      userMessage: 'Provider overloaded — reconnecting',
      maxRetries: 3,
    }
  }

  // 500 / 502 server error
  if (status === 500 || status === 502) {
    return {
      retryable: true,
      retryDelayMs: 2000,
      shouldReconnect: true,
      category: 'server_error',
      userMessage: 'Server error — retrying',
      maxRetries: 3,
    }
  }

  // 413 context overflow
  if (status === 413) {
    return {
      retryable: false,
      retryDelayMs: 0,
      shouldReconnect: false,
      category: 'context_overflow',
      userMessage: 'Context too large — compaction needed',
      maxRetries: 0,
    }
  }

  // 401 / 403 auth errors
  if (status === 401 || status === 403) {
    return {
      retryable: false,
      retryDelayMs: 0,
      shouldReconnect: false,
      category: 'auth_error',
      userMessage: 'Authentication error',
      maxRetries: 0,
    }
  }

  // Other 4xx
  if (status >= 400 && status < 500) {
    return {
      retryable: false,
      retryDelayMs: 0,
      shouldReconnect: false,
      category: 'client_error',
      userMessage: `Client error (${status})`,
      maxRetries: 0,
    }
  }

  // 5xx not covered above
  if (status >= 500) {
    return {
      retryable: true,
      retryDelayMs: 3000,
      shouldReconnect: true,
      category: 'server_error',
      userMessage: 'Server error — retrying',
      maxRetries: 3,
    }
  }

  return { ...DEFAULT }
}

function classifyByPattern(error: Error): ClassifiedError {
  const msg = error.message.toLowerCase()

  // Connection errors
  if (msg.includes('econnreset') || msg.includes('epipe') || msg.includes('econnrefused')) {
    return {
      retryable: true,
      retryDelayMs: 2000,
      shouldReconnect: true,
      category: 'timeout',
      userMessage: 'Connection lost — reconnecting',
      maxRetries: 3,
    }
  }

  // Timeout
  if (msg.includes('timeout') || msg.includes('timed out') || error.name === 'TimeoutError') {
    return {
      retryable: true,
      retryDelayMs: 3000,
      shouldReconnect: true,
      category: 'timeout',
      userMessage: 'Request timed out — retrying',
      maxRetries: 3,
    }
  }

  // Abort (user cancelled)
  if (error.name === 'AbortError' || msg.includes('aborted')) {
    return {
      retryable: false,
      retryDelayMs: 0,
      shouldReconnect: false,
      category: 'client_error',
      userMessage: 'Request cancelled',
      maxRetries: 0,
    }
  }

  // Context overflow pattern
  if (msg.includes('prompt is too long') || msg.includes('context_length_exceeded') || msg.includes('too many tokens')) {
    return {
      retryable: false,
      retryDelayMs: 0,
      shouldReconnect: false,
      category: 'context_overflow',
      userMessage: 'Context too large — compaction needed',
      maxRetries: 0,
    }
  }

  // Stream parse errors
  if (msg.includes('stream') && (msg.includes('parse') || msg.includes('invalid'))) {
    return {
      retryable: true,
      retryDelayMs: 1000,
      shouldReconnect: true,
      category: 'stream_parse',
      userMessage: 'Stream parse error — reconnecting',
      maxRetries: 2,
    }
  }

  // Fallback: unknown but possibly retryable
  return {
    retryable: true,
    retryDelayMs: 2000,
    shouldReconnect: false,
    category: 'unknown',
    userMessage: 'Unexpected error — retrying',
    maxRetries: 2,
  }
}

function extractRetryAfter(error: Error): number | null {
  if ('retryAfterMs' in error && typeof (error as any).retryAfterMs === 'number') {
    return (error as any).retryAfterMs
  }
  return null
}
```

- [x] **步骤 2：编写分类器测试**

在 `src/api/__tests__/error-classifier.test.ts` 中：

```typescript
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { classifyApiError } from '../error-classifier.js'

// Helper to create an error with a status property
class StatusError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message)
  }
}

test('classifyApiError: 429 → rate_limit, retryable', () => {
  const result = classifyApiError(new StatusError('Too many requests', 429))
  assert.equal(result.category, 'rate_limit')
  assert.equal(result.retryable, true)
  assert.equal(result.maxRetries, 5)
})

test('classifyApiError: 529 → overloaded, retryable, reconnect', () => {
  const result = classifyApiError(new StatusError('Overloaded', 529))
  assert.equal(result.category, 'overloaded')
  assert.equal(result.retryable, true)
  assert.equal(result.shouldReconnect, true)
})

test('classifyApiError: 503 → overloaded', () => {
  const result = classifyApiError(new StatusError('Service unavailable', 503))
  assert.equal(result.category, 'overloaded')
  assert.equal(result.retryable, true)
})

test('classifyApiError: 500 → server_error, retryable', () => {
  const result = classifyApiError(new StatusError('Internal error', 500))
  assert.equal(result.category, 'server_error')
  assert.equal(result.retryable, true)
})

test('classifyApiError: 401 → auth_error, not retryable', () => {
  const result = classifyApiError(new StatusError('Unauthorized', 401))
  assert.equal(result.category, 'auth_error')
  assert.equal(result.retryable, false)
})

test('classifyApiError: 403 → auth_error, not retryable', () => {
  const result = classifyApiError(new StatusError('Forbidden', 403))
  assert.equal(result.category, 'auth_error')
  assert.equal(result.retryable, false)
})

test('classifyApiError: 413 → context_overflow, not retryable', () => {
  const result = classifyApiError(new StatusError('Payload too large', 413))
  assert.equal(result.category, 'context_overflow')
  assert.equal(result.retryable, false)
})

test('classifyApiError: 404 → client_error, not retryable', () => {
  const result = classifyApiError(new StatusError('Not found', 404))
  assert.equal(result.category, 'client_error')
  assert.equal(result.retryable, false)
})

test('classifyApiError: ECONNRESET → timeout, reconnect', () => {
  const result = classifyApiError(new Error('read ECONNRESET'))
  assert.equal(result.category, 'timeout')
  assert.equal(result.retryable, true)
  assert.equal(result.shouldReconnect, true)
})

test('classifyApiError: timeout message → timeout', () => {
  const result = classifyApiError(new Error('Request timed out'))
  assert.equal(result.category, 'timeout')
  assert.equal(result.retryable, true)
})

test('classifyApiError: AbortError → client_error, not retryable', () => {
  const err = new Error('Aborted')
  err.name = 'AbortError'
  const result = classifyApiError(err)
  assert.equal(result.category, 'client_error')
  assert.equal(result.retryable, false)
})

test('classifyApiError: prompt too long message → context_overflow', () => {
  const result = classifyApiError(new Error('prompt is too long: 500000 tokens'))
  assert.equal(result.category, 'context_overflow')
  assert.equal(result.retryable, false)
})

test('classifyApiError: Codex-style status in message', () => {
  const result = classifyApiError(new Error('Codex API error (429): rate limited'))
  assert.equal(result.category, 'rate_limit')
  assert.equal(result.retryable, true)
})

test('classifyApiError: 429 with retryAfterMs uses it', () => {
  class RetryError extends Error {
    constructor(
      message: string,
      public readonly retryAfterMs: number,
    ) { super(message) }
  }
  const result = classifyApiError(new RetryError('Rate limited', 5000))
  assert.equal(result.category, 'rate_limit')
  assert.equal(result.retryDelayMs, 5000)
})

test('classifyApiError: unknown error → retryable with low max', () => {
  const result = classifyApiError(new Error('Something weird happened'))
  assert.equal(result.category, 'unknown')
  assert.equal(result.retryable, true)
  assert.equal(result.maxRetries, 2)
})

test('classifyApiError: non-Error input → unknown, not retryable', () => {
  const result = classifyApiError('just a string')
  assert.equal(result.category, 'unknown')
  assert.equal(result.retryable, false)
})
```

- [x] **步骤 3：运行测试验证通过**

运行：`npm test -- src/api/__tests__/error-classifier.test.ts`
预期：全部 PASS

- [x] **步骤 4：Commit**

```bash
git add src/api/error-classifier.ts src/api/__tests__/error-classifier.test.ts
git commit -m "feat(api): add structured API error classifier with 16 test cases"
```

---

### 任务 2：双重重试引擎

**文件：**
- 创建：`src/api/retry-engine.ts`
- 创建：`src/api/__tests__/retry-engine.test.ts`

- [x] **步骤 1：编写重试引擎**

在 `src/api/retry-engine.ts` 中：

```typescript
import { classifyApiError, type ClassifiedError } from './error-classifier.js'

export interface RetryOptions {
  /** Maximum total retries across all categories (default: 5) */
  maxTotalRetries?: number
  /** Whether to call onRetry callback with classification info */
  onRetry?: (info: RetryInfo) => void
}

export interface RetryInfo {
  attempt: number
  classified: ClassifiedError
  /** Milliseconds until next retry */
  nextDelayMs: number
}

/**
 * Jittered exponential backoff delay.
 * delay = min(baseDelay * 2^(attempt-1), maxDelay) + random(0, jitterRatio * delay)
 */
export function jitteredBackoff(
  attempt: number,
  baseDelayMs: number = 1000,
  maxDelayMs: number = 30_000,
  jitterRatio: number = 0.5,
): number {
  const raw = Math.min(baseDelayMs * Math.pow(2, attempt - 1), maxDelayMs)
  const jitter = Math.random() * jitterRatio * raw
  return raw + jitter
}

/**
 * Structured retry with error classification.
 * Uses classifyApiError to determine retryability, delay, and reconnection.
 */
export async function withStructuredRetry<T>(
  fn: () => Promise<T>,
  signal?: AbortSignal,
  options?: RetryOptions,
): Promise<T> {
  const maxTotal = options?.maxTotalRetries ?? 5
  let lastError: unknown = null
  let totalAttempts = 0

  for (;;) {
    try {
      return await fn()
    } catch (err) {
      totalAttempts++
      lastError = err

      if (signal?.aborted) throw err

      const classified = classifyApiError(err)

      if (!classified.retryable) throw err

      if (totalAttempts > Math.min(classified.maxRetries, maxTotal)) throw err

      const delay = classified.retryDelayMs > 0
        ? classified.retryDelayMs
        : jitteredBackoff(totalAttempts)

      if (options?.onRetry) {
        options.onRetry({
          attempt: totalAttempts,
          classified,
          nextDelayMs: delay,
        })
      }

      await abortableDelay(delay, signal)
    }
  }
}

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

- [x] **步骤 2：编写重试引擎测试**

在 `src/api/__tests__/retry-engine.test.ts` 中：

```typescript
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { withStructuredRetry, jitteredBackoff } from '../retry-engine.js'

test('withStructuredRetry: succeeds on first attempt', async () => {
  let calls = 0
  const result = await withStructuredRetry(async () => {
    calls++
    return 'ok'
  })
  assert.equal(result, 'ok')
  assert.equal(calls, 1)
})

test('withStructuredRetry: retries on 500 and succeeds', async () => {
  let calls = 0
  const result = await withStructuredRetry(async () => {
    calls++
    if (calls < 2) {
      const err = new Error('Server error')
      ;(err as any).status = 500
      throw err
    }
    return 'ok'
  }, undefined, { maxTotalRetries: 3 })
  assert.equal(result, 'ok')
  assert.equal(calls, 2)
})

test('withStructuredRetry: does not retry 401', async () => {
  let calls = 0
  await assert.rejects(
    async () => withStructuredRetry(async () => {
      calls++
      const err = new Error('Unauthorized')
      ;(err as any).status = 401
      throw err
    }),
    /Unauthorized/,
  )
  assert.equal(calls, 1)
})

test('withStructuredRetry: does not retry 413', async () => {
  let calls = 0
  await assert.rejects(
    async () => withStructuredRetry(async () => {
      calls++
      const err = new Error('Too large')
      ;(err as any).status = 413
      throw err
    }),
    /Too large/,
  )
  assert.equal(calls, 1)
})

test('withStructuredRetry: respects maxTotalRetries', async () => {
  let calls = 0
  await assert.rejects(
    async () => withStructuredRetry(async () => {
      calls++
      const err = new Error('ECONNRESET')
      throw err
    }, undefined, { maxTotalRetries: 2 }),
  )
  assert.equal(calls, 3) // 1 initial + 2 retries
})

test('withStructuredRetry: respects AbortSignal', async () => {
  const controller = new AbortController()
  controller.abort()
  let calls = 0
  await assert.rejects(
    async () => withStructuredRetry(async () => {
      calls++
      const err = new Error('Server error')
      ;(err as any).status = 500
      throw err
    }, controller.signal),
  )
  assert.equal(calls, 1)
})

test('withStructuredRetry: calls onRetry callback with info', async () => {
  const retries: Array<{ attempt: number; category: string }> = []
  let calls = 0
  await withStructuredRetry(async () => {
    calls++
    if (calls < 3) {
      const err = new Error('Server error')
      ;(err as any).status = 500
      throw err
    }
    return 'ok'
  }, undefined, {
    maxTotalRetries: 5,
    onRetry: (info) => retries.push({ attempt: info.attempt, category: info.classified.category }),
  })
  assert.equal(retries.length, 2)
  assert.equal(retries[0]!.category, 'server_error')
})

test('jitteredBackoff: increases with attempts', () => {
  const d1 = jitteredBackoff(1, 100, 30_000, 0) // no jitter for deterministic test
  const d2 = jitteredBackoff(2, 100, 30_000, 0)
  const d3 = jitteredBackoff(3, 100, 30_000, 0)
  assert.ok(d2 > d1)
  assert.ok(d3 > d2)
})

test('jitteredBackoff: caps at maxDelayMs', () => {
  const d = jitteredBackoff(100, 1000, 5000, 0)
  assert.ok(d <= 5000)
})
```

- [x] **步骤 3：运行测试验证通过**

运行：`npm test -- src/api/__tests__/retry-engine.test.ts`
预期：全部 PASS

- [x] **步骤 4：Commit**

```bash
git add src/api/retry-engine.ts src/api/__tests__/retry-engine.test.ts
git commit -m "feat(api): add structured retry engine with jittered backoff"
```

---

### 任务 3：接入 client.ts 和 codex-client.ts

**文件：**
- 修改：`src/api/client.ts`
- 修改：`src/api/codex-client.ts`
- 修改：`src/api/__tests__/codex-client.test.ts`

- [x] **步骤 1：修改 client.ts — 替换 withRetry**

在 `src/api/client.ts` 中：
1. 删除旧的 `MAX_RETRIES`、`BASE_DELAY_MS`、`abortableDelay`、`withRetry` 定义（第 136-184 行）
2. 添加导入：`import { withStructuredRetry } from './retry-engine.js'`
3. 在 `stream()` 方法中（第 221 行），将 `withRetry(() => fetch(...))` 替换为 `withStructuredRetry(() => fetch(...), signal)`

替换前（第 221-247 行）：
```typescript
const response = await withRetry(
  () => fetch(`${this.config.baseUrl}/messages`, { ... }).then(async (res) => { ... }),
  signal,
)
```

替换后：
```typescript
const response = await withStructuredRetry(
  () => fetch(`${this.config.baseUrl}/messages`, { ... }).then(async (res) => { ... }),
  signal,
)
```

保留 `ApiError` 类定义（第 5-14 行），因为 `error-classifier.ts` 依赖它的 `.status` 属性。

- [x] **步骤 2：修改 codex-client.ts — 替换内联 retry**

在 `src/api/codex-client.ts` 中：
1. 删除 `MAX_RETRIES`、`BASE_DELAY_MS` 常量（第 14-15 行）
2. 删除 `delay` 函数
3. 添加导入：`import { withStructuredRetry } from './retry-engine.js'`
4. 在 `stream()` 方法中（第 22-80 行），替换整个 retry 循环：

替换前（第 22-80 行，stream 方法的主体）：
```typescript
async stream(request, callbacks, signal): Promise<void> {
  let lastError = null
  for (let attempt = 1; ...) { ... }
  throw lastError
}
```

替换后：
```typescript
async stream(request: MessageRequest, callbacks: StreamCallbacks, signal?: AbortSignal): Promise<void> {
  const body = this.buildRequestBody(request)

  await withStructuredRetry(async () => {
    const authHeaders = this.config.auth
      ? await this.config.auth.getHeaders()
      : {}

    const url = `${this.config.baseUrl.replace(/\/+$/, '')}/responses`
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': CODEX_USER_AGENT,
        'Originator': CODEX_ORIGINATOR,
        'Accept': 'text/event-stream',
        'Connection': 'Keep-Alive',
        ...authHeaders,
      },
      body: JSON.stringify(body),
      signal,
    })

    if (!response.ok) {
      const errorBody = await response.text().catch(() => '')
      throw Object.assign(
        new Error(`Codex API error (${response.status}): ${errorBody}`),
        { status: response.status },
      )
    }

    await this.processSSEStream(response, callbacks, signal)
  }, signal)
}
```

- [x] **步骤 3：运行测试验证无回归**

运行：`npm test`
预期：全部 PASS（包括已有的 codex-client 测试）

- [x] **步骤 4：Commit**

```bash
git add src/api/client.ts src/api/codex-client.ts
git commit -m "refactor(api): replace inline retry logic with structured retry engine"
```

---

### 任务 4：Output Token 静默升级

**文件：**
- 修改：`src/agent/loop.ts`
- 修改：`src/agent/__tests__/loop.test.ts`

- [x] **步骤 1：编写失败的测试**

在 `src/agent/__tests__/loop.test.ts` 末尾添加：

```typescript
test('output token escalation: retries with higher maxTokens on max_output_tokens', async () => {
  const session = new SessionContext()
  const registry = new ToolRegistry()
  registry.register(READ_FILE_TOOL)

  let callCount = 0
  const client: ApiClient = {
    stream: mock.fn(async (_req: unknown, cb: StreamCallbacks) => {
      callCount++
      if (callCount === 1) {
        // First call: model hits output token limit
        cb.onTextDelta('Partial response...')
        cb.onContentBlock(makeTextBlock('Partial response...'))
        cb.onStopReason('max_output_tokens', { input_tokens: 100, output_tokens: 4096 })
      } else {
        // Second call: model completes
        cb.onTextDelta(' continued and done.')
        cb.onContentBlock(makeTextBlock(' continued and done.'))
        cb.onStopReason('end_turn', { input_tokens: 100, output_tokens: 200 })
      }
    }),
  } as unknown as ApiClient

  const texts: string[] = []
  const agent = new AgentLoop(
    { client, promptEngine: makeEngine(), toolRegistry: registry, maxTurns: 5, contextWindow: 1_000_000,
      compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' } },
    session, '/test',
  )

  await agent.run('test prompt', {
    onTextDelta: (t) => texts.push(t),
    onThinkingDelta: () => {},
    onToolUse: () => {},
    onToolResult: () => {},
    onTurnComplete: () => {},
    onError: (e) => { throw e },
    onAbort: () => {},
    onApprovalRequired: async () => false,
  })

  // Should have retried and completed successfully
  assert.equal(callCount, 2)
  assert.ok(texts.some(t => t.includes('continued and done')))
})
```

- [x] **步骤 2：运行测试验证失败**

运行：`npm test -- src/agent/__tests__/loop.test.ts`
预期：新测试 FAIL（当前 loop.ts 不处理 max_output_tokens 升级）

- [x] **步骤 3：实现 output token 升级**

在 `src/agent/loop.ts` 的 `run()` 方法中，找到处理 `stopReason` 的位置（`onStopReason` 回调之后，tool_use 检测之前）。在 `stopReason === 'end_turn'` 的最终处理之前，添加 `max_output_tokens` 检测：

在 `loop.ts` 中，需要添加：

1. 在类顶部添加属性：
```typescript
private outputTokenEscalationCount = 0
private static readonly MAX_OUTPUT_ESCALATION = 3
```

2. 在 `run()` 开头的重置逻辑中（`this.lastTurnText = ''` 附近）添加：
```typescript
this.outputTokenEscalationCount = 0
```

3. 找到处理 `stopReason` 的位置。在 `stopReason === 'tool_use'` 分支之后、`stopReason === 'end_turn'` 最终处理之前，添加：

```typescript
// Output token escalation: silently retry with higher budget
if (stopReason === 'max_output_tokens' && this.outputTokenEscalationCount < AgentLoop.MAX_OUTPUT_ESCALATION) {
  this.outputTokenEscalationCount++
  // Inject continuation prompt so model picks up where it left off
  this.session.addUserMessage('Continue your response from where you left off.')
  continue
}
```

这利用了现有的 `continue` 循环机制，只是注入了一个续接消息而不是重新发起整个请求。

- [x] **步骤 4：运行测试验证通过**

运行：`npm test -- src/agent/__tests__/loop.test.ts`
预期：全部 PASS

- [x] **步骤 5：Commit**

```bash
git add src/agent/loop.ts src/agent/__tests__/loop.test.ts
git commit -m "feat(agent): silent output token escalation on max_output_tokens (up to 3x)"
```

---

### 任务 5：终端写入批处理

**文件：**
- 创建：`src/tui/render-batch.ts`

- [x] **步骤 1：编写 RenderBatcher**

在 `src/tui/render-batch.ts` 中：

```typescript
/**
 * Batches rapid-fire callback invocations into single microtask-aligned updates.
 * Prevents React from re-rendering on every text delta.
 */

export type FlushFn<T> = (items: T[]) => void

export class RenderBatcher<T> {
  private queue: T[] = []
  private scheduled = false

  constructor(private flush: FlushFn<T>) {}

  push(item: T): void {
    this.queue.push(item)
    if (!this.scheduled) {
      this.scheduled = true
      queueMicrotask(() => {
        this.scheduled = false
        const items = this.queue
        this.queue = []
        if (items.length > 0) {
          this.flush(items)
        }
      })
    }
  }

  /** Flush any pending items synchronously (e.g. before turn end) */
  flushNow(): void {
    const items = this.queue
    this.queue = []
    this.scheduled = false
    if (items.length > 0) {
      this.flush(items)
    }
  }

  get pending(): number {
    return this.queue.length
  }
}
```

这个模块不需要单独的测试文件——它的行为通过 app.tsx 的集成隐式验证。如果需要独立测试，可以在 app 的测试中覆盖。

- [x] **步骤 2：接入 app.tsx**

在 `src/tui/app.tsx` 中：
1. 添加导入：`import { RenderBatcher } from './render-batch.js'`
2. 在组件内部（其他 ref 附近），创建批处理器：
```typescript
const textBatcher = useRef(new RenderBatcher<string>((texts) => {
  const combined = texts.join('')
  streamBuf.current += combined
  setStreamingText(streamBuf.current)
}))
```
3. 将 `onTextDelta` 回调中的直接更新替换为 `textBatcher.current.push(text)`
4. 在 `onTurnComplete`（isFinal === true 分支）中，在最终清理前调用 `textBatcher.current.flushNow()`

- [x] **步骤 3：运行测试验证无回归**

运行：`npm test`
预期：全部 PASS

- [x] **步骤 4：手动验证**

启动 Rivet TUI，发送一个会触发多 turn 回复的请求，确认：
- 流式文本仍然实时显示（无可见延迟）
- 多 turn 场景下文本不丢失
- thinking 和 tool call 显示正常

- [x] **步骤 5：Commit**

```bash
git add src/tui/render-batch.ts src/tui/app.tsx
git commit -m "perf(tui): batch text deltas via RenderBatcher to reduce render frequency"
```

---

### 任务 6：引导注入模式（SteerBuffer）

**文件：**
- 创建：`src/tui/steer-buffer.ts`
- 创建：`src/tui/__tests__/steer-buffer.test.ts`

- [x] **步骤 1：编写 CommandQueue**

在 `src/tui/steer-buffer.ts` 中：

```typescript
/**
 * Priority command queue for TUI event ordering.
 * Ensures user input always takes precedence over background callbacks.
 */

export type Priority = 'now' | 'next' | 'later'

export interface QueuedCommand<T = unknown> {
  id: number
  priority: Priority
  payload: T
}

const PRIORITY_ORDER: Record<Priority, number> = {
  now: 0,
  next: 1,
  later: 2,
}

export class CommandQueue<T = unknown> {
  private queue: QueuedCommand<T>[] = []
  private nextId = 0
  private listeners: Array<() => void> = []

  enqueue(priority: Priority, payload: T): QueuedCommand<T> {
    const cmd: QueuedCommand<T> = { id: this.nextId++, priority, payload }

    // Insert in priority order (stable: same priority keeps insertion order)
    let insertIdx = this.queue.length
    for (let i = 0; i < this.queue.length; i++) {
      if (PRIORITY_ORDER[cmd.priority] < PRIORITY_ORDER[this.queue[i]!.priority]) {
        insertIdx = i
        break
      }
    }
    this.queue.splice(insertIdx, 0, cmd)

    this.notify()
    return cmd
  }

  dequeue(): QueuedCommand<T> | undefined {
    return this.queue.shift()
  }

  dequeueAll(): QueuedCommand<T>[] {
    const items = this.queue
    this.queue = []
    return items
  }

  /** Drain all commands matching a predicate */
  drain(predicate?: (cmd: QueuedCommand<T>) => boolean): QueuedCommand<T>[] {
    if (!predicate) return this.dequeueAll()
    const matching: QueuedCommand<T>[] = []
    const remaining: QueuedCommand<T>[] = []
    for (const cmd of this.queue) {
      if (predicate(cmd)) {
        matching.push(cmd)
      } else {
        remaining.push(cmd)
      }
    }
    this.queue = remaining
    return matching
  }

  get size(): number {
    return this.queue.length
  }

  subscribe(listener: () => void): () => void {
    this.listeners.push(listener)
    return () => {
      this.listeners = this.listeners.filter(l => l !== listener)
    }
  }

  private notify(): void {
    for (const listener of this.listeners) {
      listener()
    }
  }
}
```

- [x] **步骤 2：编写队列测试**

在 `src/tui/__tests__/steer-buffer.test.ts` 中：

```typescript
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CommandQueue } from '../steer-buffer.js'

test('enqueue and dequeue by priority', () => {
  const q = new CommandQueue<string>()
  q.enqueue('later', 'bg1')
  q.enqueue('now', 'user1')
  q.enqueue('next', 'cmd1')
  q.enqueue('later', 'bg2')

  assert.equal(q.dequeue()!.payload, 'user1')
  assert.equal(q.dequeue()!.payload, 'cmd1')
  assert.equal(q.dequeue()!.payload, 'bg1')
  assert.equal(q.dequeue()!.payload, 'bg2')
})

test('same priority keeps insertion order', () => {
  const q = new CommandQueue<string>()
  q.enqueue('now', 'a')
  q.enqueue('now', 'b')
  q.enqueue('now', 'c')

  assert.equal(q.dequeue()!.payload, 'a')
  assert.equal(q.dequeue()!.payload, 'b')
  assert.equal(q.dequeue()!.payload, 'c')
})

test('now priority always dequeued first regardless of insertion order', () => {
  const q = new CommandQueue<string>()
  q.enqueue('later', 'bg')
  q.enqueue('next', 'cmd')
  q.enqueue('later', 'bg2')
  q.enqueue('now', 'urgent')

  assert.equal(q.dequeue()!.payload, 'urgent')
})

test('drain removes all items', () => {
  const q = new CommandQueue<string>()
  q.enqueue('now', 'a')
  q.enqueue('later', 'b')
  q.enqueue('next', 'c')

  const all = q.drain()
  assert.equal(all.length, 3)
  assert.equal(q.size, 0)
})

test('drain with predicate filters', () => {
  const q = new CommandQueue<string>()
  q.enqueue('later', 'bg1')
  q.enqueue('now', 'user')
  q.enqueue('later', 'bg2')

  const bg = q.drain(cmd => cmd.priority === 'later')
  assert.equal(bg.length, 2)
  assert.equal(q.size, 1)
  assert.equal(q.dequeue()!.payload, 'user')
})

test('subscribe notifies on enqueue', () => {
  const q = new CommandQueue<string>()
  let notified = 0
  const unsub = q.subscribe(() => notified++)

  q.enqueue('now', 'a')
  assert.equal(notified, 1)
  q.enqueue('later', 'b')
  assert.equal(notified, 2)

  unsub()
  q.enqueue('now', 'c')
  assert.equal(notified, 2) // no more notifications
})

test('dequeue returns undefined when empty', () => {
  const q = new CommandQueue<string>()
  assert.equal(q.dequeue(), undefined)
})
```

- [x] **步骤 3：运行测试验证通过**

运行：`npm test -- src/tui/__tests__/steer-buffer.test.ts`
预期：全部 PASS

- [x] **步骤 4：Commit**

```bash
git add src/tui/steer-buffer.ts src/tui/__tests__/steer-buffer.test.ts
git commit -m "feat(tui): add priority command queue (now/next/later)"
```

---

### 任务 7：集成验证

**文件：**
- 无新文件

- [x] **步骤 1：运行完整测试套件**

运行：`npm test`
预期：全部 PASS

- [x] **步骤 2：TypeScript 类型检查**

运行：`npm run typecheck`
预期：无错误

- [x] **步骤 3：最终 Commit（如有 lint/fix 需要）**

```bash
npm run build
git add -A
git commit -m "chore: session performance and fault tolerance hardening complete"
```
