# Phase 3：Fetch 首字节超时 + SSE 超时顺序修复 实现计划

> **面向 AI 代理：** 使用 subagent-driven-development（推荐）或 executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 修复三个 API 客户端的 fetch() 永久挂起问题——当服务器接受连接但不回复 header 时，请求永不返回；同时修复 SSE idle timer 因 `reader.cancel()` 导致 `done=true` 在 `streamTimedOut` 检查之前触发的死代码问题。

**架构：** 新建 `fetchWithTimeout()` 工具函数，将用户 `AbortSignal` 与 `AbortSignal.timeout(45_000)` 合并为 `AbortSignal.any()`，使 fetch 在 45 秒内必须得到响应。超时与用户取消通过检查各自的原始 signal 区分——超时抛含 "timeout" 的 Error（可被 retry-engine 重试），用户取消抛 AbortError（不重试）。SSE 超时顺序修复：将 `streamTimedOut` 检查从 `reader.read()` 之前移到 `done` 检查之前，确保 `reader.cancel()` 导致的 `done=true` 不跳过超时 throw。

**技术栈：** Node.js 22 AbortSignal.timeout() + AbortSignal.any() / 现有 retry-engine / 现有 error-classifier

---

## 范围检查

本计划仅覆盖设计文档缺陷③（turn 永久挂起）。缺陷①（思考块撑屏）和缺陷②（取消后幽灵重发）在独立 Phase 中处理，与本计划互不依赖。

## 文件结构

| 文件 | 操作 | 职责 |
|------|------|------|
| `src/api/fetch-timeout.ts` | 创建 | `fetchWithTimeout()` 工具函数——合并用户 signal 与超时 signal，区分超时与用户取消 |
| `src/api/__tests__/fetch-timeout.test.ts` | 创建 | fetchWithTimeout 的单元测试 |
| `src/api/openai-client.ts:209-225` | 修改 | 将 `fetch()` 替换为 `fetchWithTimeout()` |
| `src/api/openai-client.ts:296-302` | 修改 | SSE `streamTimedOut` 检查从 read 前移到 done 检查前 |
| `src/api/anthropic-client.ts:62-68` | 修改 | 将 `fetch()` 替换为 `fetchWithTimeout()` |
| `src/api/anthropic-client.ts:298-304` | 修改 | SSE `streamTimedOut` 检查从 read 前移到 done 检查前 |
| `src/api/codex-client.ts:38-44` | 修改 | 将 `fetch()` 替换为 `fetchWithTimeout()` |
| `src/api/codex-client.ts:217-223` | 修改 | SSE `streamTimedOut` 检查从 read 前移到 done 检查前 |
| `src/api/__tests__/openai-client.test.ts` | 修改 | 新增：mock 不回 header 的 fetch，断言 45s 内 reject |
| `src/api/__tests__/anthropic-client.test.ts` | 修改 | 新增：fetch 超时 throw 测试 |
| `src/api/__tests__/codex-client.test.ts` | 修改 | 新增：fetch 超时 throw 测试 |

## 调研背书

### 1. fetch() 无超时——服务器不回 header 时永久挂起

**存在原因：** `fetch()` 的 `signal` 参数仅响应用户 `AbortController.abort()`。三个客户端都直接将用户的 `signal` 传给 `fetch()`，没有独立的超时机制。

**Callers（谁调 `client.stream()`）：**
- `src/agent/turn-stream.ts:120` — 传 `this.deps.abortSignal`，无超时包装
- `src/agent/compaction-controller.ts:530` — 自建 `AbortSignal.timeout(60_000)`（唯一有超时的 caller）
- `src/compact/heuristic-extractor.ts:40` — 不传 signal

**边缘情况：**
- SSE idle timer（`setTimeout → reader.cancel()`）仅在 `fetch()` resolve 后启动。fetch 永不 resolve 时 idle timer 也不启动。
- `withStructuredRetry` 的重试逻辑仅在 `fn()` throw 后触发——如果 `fetch()` 永不 resolve，retry 永不触发。
- 重试引擎的 `abortableDelay()` 可被用户 signal 中断，但对 fetch 级挂起无能为力。

### 2. SSE `streamTimedOut` 是死代码——`reader.cancel()` 导致 `done=true` 先于 throw

**存在原因：** idle timer 调用 `reader.cancel()` 会让挂起的 `reader.read()` 立即 resolve 为 `{ done: true, value: undefined }`。在当前代码中 `if (done) break` 在 `if (streamTimedOut) throw` 之后（下一次循环迭代），但 `done` 检查立即退出循环，`streamTimedOut` 永不被执行。

**代码证据（三个客户端相同模式）：**
```
openai-client.ts:296-302 — while 循环中 done break 在 streamTimedOut check 之前
anthropic-client.ts:298-304 — 同
codex-client.ts:217-223 — 同
```

**修复方向：** 将 `streamTimedOut` 检查移到 `reader.read()` 之后、`done` 检查之前。

### 3. 超时错误必须被 error-classifier 识别为可重试

**规则：** `error-classifier.ts:172` 匹配 `timeout|timed\s*out` 的消息。我们的错误消息必须包含 "timeout" 或 "timed out"。

**影响：** AnthropicClient 和 CodexClient 使用 `withStructuredRetry`，依赖 classifyApiError 决定重试策略。OpenAIClient 有自己的重试循环，错误消息需在 catch 中被正确传播。

---

## Tasks

### Task 1: 创建 `fetchWithTimeout` 工具函数 + 测试

**创建：** `src/api/fetch-timeout.ts`
**创建：** `src/api/__tests__/fetch-timeout.test.ts`

**`src/api/fetch-timeout.ts` 完整内容：**

```typescript
/**
 * Fetch with pre-first-byte timeout.
 *
 * When the server accepts the TCP connection but never sends response headers,
 * a plain `fetch()` hangs indefinitely. This wrapper combines the caller's
 * AbortSignal with `AbortSignal.timeout()` so fetch always resolves/rejects
 * within `timeoutMs`.
 *
 * Error routing:
 * - User abort (signal.aborted) → re-throws original AbortError (non-retryable)
 * - Timeout → throws Error with "timed out" in message (retryable via error-classifier)
 * - Other → re-throws original error
 */

const DEFAULT_PRE_FIRST_BYTE_TIMEOUT_MS = 45_000

export async function fetchWithTimeout(
  url: string | URL,
  init: RequestInit,
  timeoutMs: number = DEFAULT_PRE_FIRST_BYTE_TIMEOUT_MS,
): Promise<Response> {
  const userSignal = init.signal
  const timeoutSignal = AbortSignal.timeout(timeoutMs)
  const combinedSignal = userSignal
    ? AbortSignal.any([userSignal, timeoutSignal])
    : timeoutSignal

  try {
    return await fetch(url, { ...init, signal: combinedSignal })
  } catch (err) {
    // User abort — propagate as-is (retry engines treat AbortError as non-retryable)
    if (userSignal?.aborted) throw err
    // Timeout — throw with "timed out" in message so error-classifier detects it
    if (timeoutSignal.aborted) {
      throw new Error(
        `Request timed out: server did not respond within ${Math.round(timeoutMs / 1000)} seconds`,
      )
    }
    throw err
  }
}
```

**`src/api/__tests__/fetch-timeout.test.ts` 完整内容：**

```typescript
import { describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'
import { fetchWithTimeout } from '../fetch-timeout.js'

describe('fetchWithTimeout', () => {
  it('returns response when fetch resolves within timeout', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = mock.fn(async () => new Response('ok', { status: 200 }))

    try {
      const response = await fetchWithTimeout('https://example.com/api', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      })
      assert.equal(response.status, 200)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('throws "timed out" error when server never responds', async () => {
    const originalFetch = globalThis.fetch
    // Simulate fetch that never resolves
    globalThis.fetch = mock.fn(async () => new Promise(() => {}))

    try {
      await assert.rejects(
        () => fetchWithTimeout('https://example.com/api', {}, 500),
        /timed out/,
      )
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('propagates AbortError when user signal aborts', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = mock.fn(async () => new Promise(() => {}))

    const controller = new AbortController()
    setTimeout(() => controller.abort(), 50)

    try {
      await assert.rejects(
        () =>
          fetchWithTimeout(
            'https://example.com/api',
            { signal: controller.signal },
            10_000,
          ),
        (err: unknown) => {
          assert.ok(err instanceof DOMException)
          assert.equal(err.name, 'AbortError')
          return true
        },
      )
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('user abort takes priority over timeout in error', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = mock.fn(async () => new Promise(() => {}))

    const controller = new AbortController()
    controller.abort()

    try {
      await assert.rejects(
        () =>
          fetchWithTimeout(
            'https://example.com/api',
            { signal: controller.signal },
            500,
          ),
        (err: unknown) => {
          assert.ok(err instanceof DOMException)
          assert.equal(err.name, 'AbortError')
          return true
        },
      )
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
```

**验证命令：**
```bash
node --import tsx --test src/api/__tests__/fetch-timeout.test.ts
```
**预期：** 4 passed, 0 failed

**提交：** `feat(api): add fetchWithTimeout utility with pre-first-byte timeout`

- [ ] Task 1 完成

---

### Task 2: 修复 OpenAIClient——fetch 超时 + SSE 超时顺序

**修改：** `src/api/openai-client.ts:1`（import）
**修改：** `src/api/openai-client.ts:209-225`（fetch 调用）
**修改：** `src/api/openai-client.ts:296-302`（SSE streamTimedOut 顺序）
**修改：** `src/api/__tests__/openai-client.test.ts`（新增测试）

**步骤 2a：添加 import**

在 `openai-client.ts` 顶部 import 区域添加：
```typescript
import { fetchWithTimeout } from './fetch-timeout.js'
```

**步骤 2b：替换 fetch 为 fetchWithTimeout**

在 `sendStream()` 方法中，将：
```typescript
        const response = await fetch(`${this.config.baseUrl}/chat/completions`, {
```
替换为：
```typescript
        const response = await fetchWithTimeout(`${this.config.baseUrl}/chat/completions`, {
```

（保留后面的 headers、body、signal 等参数不变）

**步骤 2c：修复 SSE streamTimedOut 检查顺序**

在 `parseStreamFromReader()` 方法中，将当前代码：
```typescript
        if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
        if (streamTimedOut) throw new Error('OpenAI SSE stream idle timeout')

        const { done, value } = await reader.read()
        if (done) break
```
替换为：
```typescript
        if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')

        const { done, value } = await reader.read()
        if (streamTimedOut) throw new Error('OpenAI SSE stream idle timeout')
        if (done) break
```

**步骤 2d：新增 fetch 超时测试**

在 `src/api/__tests__/openai-client.test.ts` 末尾新增 describe 块：

```typescript
describe('fetch pre-first-byte timeout', () => {
  it('throws when server accepts connection but never sends headers', async () => {
    const originalFetch = globalThis.fetch
    // Simulate a server that never responds — fetch hangs forever
    globalThis.fetch = mock.fn(async () => new Promise<Response>(() => {}))

    const client = new OpenAIClient({
      baseUrl: 'https://api.test.com/v1',
      apiKey: 'test-key',
      model: 'test-model',
      maxTokens: 100,
      unsupported: ['stream_options'],
    })

    try {
      await assert.rejects(
        () =>
          client.stream(
            { model: 'test-model', messages: [{ role: 'user', content: 'hi' }], max_tokens: 100 },
            {
              onTextDelta: () => {},
              onThinkingDelta: () => {},
              onContentBlock: () => {},
              onStopReason: () => {},
              onError: (err) => { throw err },
            },
          ),
        /timed out/i,
      )
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
```

**验证命令：**
```bash
node --import tsx --test src/api/__tests__/openai-client.test.ts
```
**预期：** 原有 17 passed + 新增 1 passed = 18 passed, 0 failed

**提交：** `fix(api): add fetch pre-first-byte timeout and fix SSE timeout ordering in OpenAIClient`

- [ ] Task 2 完成

---

### Task 3: 修复 AnthropicClient——fetch 超时 + SSE 超时顺序

**修改：** `src/api/anthropic-client.ts:1`（import）
**修改：** `src/api/anthropic-client.ts:62-68`（fetch 调用）
**修改：** `src/api/anthropic-client.ts:298-304`（SSE streamTimedOut 顺序）
**修改：** `src/api/__tests__/anthropic-client.test.ts`（新增测试）

**步骤 3a：添加 import**

在 `anthropic-client.ts` 顶部 import 区域添加：
```typescript
import { fetchWithTimeout } from './fetch-timeout.js'
```

**步骤 3b：替换 fetch 为 fetchWithTimeout**

在 `stream()` 方法中 `withStructuredRetry` 的回调里，将：
```typescript
      const response = await fetch(`${this.config.baseUrl.replace(/\/+$/, '')}/v1/messages`, {
```
替换为：
```typescript
      const response = await fetchWithTimeout(`${this.config.baseUrl.replace(/\/+$/, '')}/v1/messages`, {
```

**步骤 3c：修复 SSE streamTimedOut 检查顺序**

在 `processSSEStream()` 方法中，将：
```typescript
        if (signal?.aborted) break
        if (streamTimedOut) throw new Error('Anthropic SSE stream idle timeout (180s)')

        const { done, value } = await reader.read()
        if (done) break
```
替换为：
```typescript
        if (signal?.aborted) break

        const { done, value } = await reader.read()
        if (streamTimedOut) throw new Error('Anthropic SSE stream idle timeout (180s)')
        if (done) break
```

**步骤 3d：新增 fetch 超时测试**

在 `src/api/__tests__/anthropic-client.test.ts` 末尾新增：

```typescript
describe('fetch pre-first-byte timeout', () => {
  it('throws when server never sends response headers', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = mock.fn(async () => new Promise<Response>(() => {}))

    const client = new AnthropicClient({
      baseUrl: 'https://api.anthropic.com',
      apiKey: 'test-key',
      model: 'claude-opus-4-7',
      maxTokens: 100,
    })

    try {
      await assert.rejects(
        () =>
          client.stream(
            { model: 'claude-opus-4-7', messages: [{ role: 'user', content: 'hi' }], max_tokens: 100 },
            {
              onTextDelta: () => {},
              onThinkingDelta: () => {},
              onContentBlock: () => {},
              onStopReason: () => {},
              onError: (err) => { throw err },
            },
          ),
        /timed out/i,
      )
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
```

**验证命令：**
```bash
node --import tsx --test src/api/__tests__/anthropic-client.test.ts
```
**预期：** 原有测试全部 passed + 新增 1 passed, 0 failed

**提交：** `fix(api): add fetch pre-first-byte timeout and fix SSE timeout ordering in AnthropicClient`

- [ ] Task 3 完成

---

### Task 4: 修复 CodexClient——fetch 超时 + SSE 超时顺序

**修改：** `src/api/codex-client.ts:1`（import）
**修改：** `src/api/codex-client.ts:38-44`（fetch 调用）
**修改：** `src/api/codex-client.ts:217-223`（SSE streamTimedOut 顺序）
**修改：** `src/api/__tests__/codex-client.test.ts`（新增测试）

**步骤 4a：添加 import**

在 `codex-client.ts` 顶部 import 区域添加：
```typescript
import { fetchWithTimeout } from './fetch-timeout.js'
```

**步骤 4b：替换 fetch 为 fetchWithTimeout**

在 `stream()` 方法中 `withStructuredRetry` 的回调里，将：
```typescript
      const response = await fetch(url, {
```
替换为：
```typescript
      const response = await fetchWithTimeout(url, {
```

**步骤 4c：修复 SSE streamTimedOut 检查顺序**

在 `processSSEStream()` 方法中，将：
```typescript
        if (signal?.aborted) break
        if (streamTimedOut) throw new Error('Codex SSE stream idle timeout (180s)')

        const { done, value } = await reader.read()
        if (done) break
```
替换为：
```typescript
        if (signal?.aborted) break

        const { done, value } = await reader.read()
        if (streamTimedOut) throw new Error('Codex SSE stream idle timeout (180s)')
        if (done) break
```

**步骤 4d：新增 fetch 超时测试**

在 `src/api/__tests__/codex-client.test.ts` 末尾新增：

```typescript
describe('fetch pre-first-byte timeout', () => {
  it('throws when server never sends response headers', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = mock.fn(async () => new Promise<Response>(() => {}))

    const client = new CodexClient({
      baseUrl: 'https://api.openai.com',
      model: 'codex-mini',
      maxTokens: 100,
      auth: new ApiKeyAuth('test-token'),
    })

    try {
      await assert.rejects(
        () =>
          client.stream(
            { model: 'codex-mini', messages: [{ role: 'user', content: 'hi' }], max_tokens: 100 },
            {
              onTextDelta: () => {},
              onThinkingDelta: () => {},
              onContentBlock: () => {},
              onStopReason: () => {},
              onError: (err) => { throw err },
            },
          ),
        /timed out/i,
      )
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
```

注意：需在测试文件顶部添加 `import { ApiKeyAuth } from '../../auth/api-key.js'` 和 `import { mock } from 'node:test'`（如果尚未导入）。

**验证命令：**
```bash
node --import tsx --test src/api/__tests__/codex-client.test.ts
```
**预期：** 原有测试全部 passed + 新增 1 passed, 0 failed

**提交：** `fix(api): add fetch pre-first-byte timeout and fix SSE timeout ordering in CodexClient`

- [ ] Task 4 完成

---

## Verification

### 全量类型检查
```bash
npx tsc --noEmit
```
**预期：** 零错误

### 受影响测试文件
```bash
node --import tsx --test src/api/__tests__/fetch-timeout.test.ts
node --import tsx --test src/api/__tests__/openai-client.test.ts
node --import tsx --test src/api/__tests__/anthropic-client.test.ts
node --import tsx --test src/api/__tests__/codex-client.test.ts
node --import tsx --test src/api/__tests__/factory.test.ts
node --import tsx --test src/api/__tests__/error-classifier.test.ts
node --import tsx --test src/api/__tests__/retry-engine.test.ts
```
**预期：** 全部 passed, 0 failed

### 集成验证（用户手动）
1. 启动 `node dist/main.js`，切换到 kimi 或其他 provider
2. 发送请求后切断网络（模拟服务器不回 header）
3. 预期：45 秒内收到 "Request timed out" 错误提示，agent loop 恢复可操作状态
4. 发送请求后让服务器卡住（不发送 SSE 数据）
5. 预期：120/180 秒内收到 "SSE stream idle timeout" 错误，agent loop 恢复

## Self-check

### 1. Spec 覆盖映射

| 设计文档要求 | 对应 Task |
|---|---|
| 三 client 的 fetch 加 AbortSignal.timeout | Task 1 (工具) + Task 2/3/4 (各 client) |
| 修 SSE done/throw 顺序 | Task 2/3/4 各 client |
| mock 不回 header 的 server，断言 N 秒内 reject | Task 2/3/4 的测试步骤 d |
| pre-byte(45s) 与 idle(120s) 分两个值 | fetchWithTimeout 默认 45s，SSE idle timer 保持原值 |
| 超时 throw 可被 error-classifier 识别为 retryable | 错误消息含 "timed out"，匹配 `error-classifier.ts:172` 的正则 |
| 用户 abort 不被超时误判 | `userSignal?.aborted` 优先检查，抛原始 AbortError |

### 2. 禁止占位符扫描

- 无 TODO / TBD / 待定 / 后续实现 / 补充细节
- 所有测试包含具体代码
- 所有步骤包含精确文件路径和行号

### 3. 类型/签名一致性

- `fetchWithTimeout(url: string | URL, init: RequestInit, timeoutMs?: number): Promise<Response>` — 与 `fetch()` 签名兼容
- `fetch()` 调用点替换为 `fetchWithTimeout()` 时，后续参数（headers, body, signal）不变
- `signal` 参数仍然从 `init.signal` 传入，由 `fetchWithTimeout` 内部处理合并

---

## Execution handoff

计划已完成并保存到 `docs/superpowers/plans/phase3-fetch-hang-timeout.md`。两种执行方式：
1. **子代理驱动（推荐）** — 每个 Task 调度一个新的子代理，任务间进行审查，快速迭代。
2. **内联执行** — 在当前会话中使用 executing-plans 执行任务，批量执行并设有检查点。

选哪种方式？
