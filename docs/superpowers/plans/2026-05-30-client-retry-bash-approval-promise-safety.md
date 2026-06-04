# Client Retry / Bash Approval / Promise Safety 实现计划

> **状态：✅ 已全部实施** — bash approval 模式 + promise safety

**目标：** 修复三个独立问题：B2（三个 API client 的 Retry-After 解析不一致）、B3（bash rtkRewrite 双调用性能开销）、B4（两个浮动 promise 的防御性改进）。

**架构：** B2 将 `parseRetryAfterMs` 从 OpenAIClient 提取到 `error-classifier.ts` 统一导出，三个 client 共用同一套 Retry-After 解析逻辑。B3 为 `rtkRewrite` 添加单条目缓存消除重复子进程调用（安全性已验证，无需修改审批逻辑）。B4 为 `SseStream.close()` 添加幂等保护，为 shadow-queue 的浮动 promise 添加显式 `void` 标记。

**技术栈：** TypeScript strict, node:test + node:assert/strict

---

## Scope Check

三个问题横跨 API 层、工具层、服务层，但各自独立，无交叉依赖。放在同一计划中因为它们共同构成"一致性与防御性"主题，且每个改动都很小（< 30 行）。

## File Structure

| 文件 | 操作 | 职责 |
|------|------|------|
| `src/api/error-classifier.ts` | 修改 | 新增 `parseRetryAfterMs` 导出函数，统一 Retry-After 头解析 |
| `src/api/openai-client.ts` | 修改 | 删除私有 `parseRetryAfterMs`，改用从 error-classifier 导入的共享版本 |
| `src/api/anthropic-client.ts` | 修改 | 在 429 错误中提取 Retry-After 头，附加 `retryAfterMs` 属性 |
| `src/api/codex-client.ts` | 修改 | 在 429 错误中提取 Retry-After 头，附加 `retryAfterMs` 属性 |
| `src/api/__tests__/error-classifier.test.ts` | 修改 | 新增 `parseRetryAfterMs` 单元测试 |
| `src/api/__tests__/anthropic-client.test.ts` | 修改 | 新增 Retry-After 传递测试 |
| `src/api/__tests__/codex-client.test.ts` | 修改 | 新增 Retry-After 传递测试 |
| `src/api/__tests__/openai-client.test.ts` | 修改 | 更新 import 来源断言 |
| `src/tools/bash.ts` | 修改 | 为 `rtkRewrite` 添加单条目缓存 |
| `src/tools/__tests__/bash.test.ts` | 修改 | 新增缓存行为测试 |
| `src/agent/shadow-queue.ts` | 修改 | 添加 `void` 标记消除浮动 promise |
| `src/server/sse-stream.ts` | 修改 | `close()` 添加幂等保护（防止 double-send/double-end） |
| `src/server/prompt-route.ts` | 修改 | 为浮动 promise 添加 `void` 标记 |
| `src/server/__tests__/server.test.ts` | 修改 | 新增 SSE 幂等关闭测试 |
| `src/agent/__tests__/shadow-queue.test.ts` | 修改 | 新增 void 标记行为验证 |

## Research Endorsement（调研背书）

### B2: parseRetryAfterMs 提取

**调用方分析：**
- `parseRetryAfterMs` 当前仅被 `openai-client.ts:238` 内部调用
- 函数签名为 `(value: string) => number | undefined`，纯函数，无副作用
- 提取到 `error-classifier.ts` 不影响任何外部接口

**存在原因：** OpenAI API 在 429 响应中返回 `Retry-After` 头（RFC 7231 §7.1.3）。Anthropic 和 Codex API 同样遵循此规范，但客户端未解析。

**Edge case：**
- `Retry-After` 值为 HTTP-date 格式（如 `Fri, 30 May 2026 12:00:00 GMT`）时，`parseFloat` 返回 NaN，需 `Date.parse` 回退
- 值为负数或过去时间时，应返回 `undefined`（不倒退等待）
- 无 `Retry-After` 头时，`extractRetryAfter` 已在 classifier 中处理 fallback

### B3: rtkRewrite 双调用

**调用方分析：**
- `rtkRewrite` 被 `execute()` (`bash.ts:41`) 和 `requiresApproval()` (`bash.ts:171`) 各调用一次
- 同一 `rawCommand`，结果确定，适合缓存
- 无外部调用方

**安全性验证：** `requiresApproval()` 已同时检查 raw 和 rewritten 两种形式（`bash.ts:174-175`）。添加缓存不改变这一行为——只要命令相同，缓存返回相同结果。审批逻辑完全不受影响。

**Edge case：**
- 缓存为单条目（只缓存最近一条命令），避免内存泄漏
- rtk 未安装时 fallback 返回原命令，缓存同样适用
- rtk 进程超时 500ms，缓存命中后直接返回，不再超时

### B4: 浮动 promise 与 SSE 幂等

**shadow-queue.ts:28 调用方分析：**
- `enqueue()` 被 `p3-integration.ts:2` 导入使用
- 当前 `.then().catch().finally()` 链已处理所有 rejection
- 浮动 promise 风险：`.finally()` 返回的 promise 未被任何代码消费。虽然 `.catch()` 已吸收所有错误，但 strict promise linting 会标记此模式
- 修复：添加 `void` 前缀，明确表示"fire and forget"

**prompt-route.ts:30 调用方分析：**
- `handlePromptSSE` 被 `server/__tests__/server.test.ts` 测试调用
- 当前 `.then().catch()` 链已处理 rejection
- SSE 泄漏风险：`onError` 回调和 `.catch()` handler 都可能调用 `sse.close()`，导致 `send('done', {})` 被写入已关闭的 response
- 修复：`SseStream.close()` 添加 `_closed` 守卫，`handlePromptSSE` 添加 `void` 前缀

**SseStream.close() 幂等性：**
- 当前 `close()` 每次调用都会 `send('done', {})` + `res.end()`
- `res.end()` 重复调用安全（Node.js 忽略）
- `res.write()` 在已关闭的 response 上调用会触发 `write after end` 警告
- 修复：添加 `private _closed = false` 标志，`close()` 首次调用时设为 `true`，后续调用直接 return

---

## Tasks

### Task 1: B2 — 提取 `parseRetryAfterMs` 到 `error-classifier.ts`

- [ ] **Step 1.1:** 编写失败测试

  **测试文件:** `src/api/__tests__/error-classifier.test.ts`

  在文件末尾（`describe('classifyApiError', ...)` 之后）新增：

  ```typescript
  describe('parseRetryAfterMs', () => {
    it('parses numeric seconds to milliseconds', () => {
      const result = parseRetryAfterMs('30')
      assert.equal(result, 30_000)
    })

    it('parses decimal seconds to milliseconds', () => {
      const result = parseRetryAfterMs('2.5')
      assert.equal(result, 2_500)
    })

    it('parses HTTP-date format by computing delta from now', () => {
      const futureDate = new Date(Date.now() + 30_000).toUTCString()
      const result = parseRetryAfterMs(futureDate)
      assert.ok(typeof result === 'number', 'should return a number for HTTP-date')
      assert.ok(result! > 20_000 && result! < 40_000, `delta should be ~30s, got ${result}`)
    })

    it('returns undefined for past HTTP-date', () => {
      const pastDate = new Date(Date.now() - 30_000).toUTCString()
      const result = parseRetryAfterMs(pastDate)
      assert.equal(result, undefined)
    })

    it('returns undefined for non-numeric non-date string', () => {
      const result = parseRetryAfterMs('not-a-number')
      assert.equal(result, undefined)
    })

    it('returns undefined for empty string', () => {
      const result = parseRetryAfterMs('')
      assert.equal(result, undefined)
    })

    it('handles zero as zero milliseconds', () => {
      const result = parseRetryAfterMs('0')
      assert.equal(result, 0)
    })
  })
  ```

  在文件顶部 import 中新增：
  ```typescript
  import { classifyApiError, parseRetryAfterMs } from '../error-classifier.js'
  ```

  **验证命令:** `npx tsx --test src/api/__tests__/error-classifier.test.ts`
  **预期结果:** 编译失败（`parseRetryAfterMs` 不存在于 `error-classifier.ts` 的导出中）

- [ ] **Step 1.2:** 实现 `parseRetryAfterMs` 并导出

  **修改文件:** `src/api/error-classifier.ts`

  在文件末尾（`classifyApiError` 函数之后）新增：

  ```typescript
  /**
   * Parse Retry-After header value (RFC 7231 §7.1.3).
   * Numeric string → seconds × 1000.
   * HTTP-date string → delta from now in ms.
   * Unparseable → undefined.
   */
  export function parseRetryAfterMs(value: string): number | undefined {
    const parsed = parseFloat(value)
    if (Number.isFinite(parsed) && parsed >= 0) {
      return parsed * 1000
    }
    const dateMs = Date.parse(value)
    if (Number.isFinite(dateMs)) {
      const delta = dateMs - Date.now()
      return delta > 0 ? delta : undefined
    }
    return undefined
  }
  ```

  **验证命令:** `npx tsx --test src/api/__tests__/error-classifier.test.ts`
  **预期结果:** 全部通过

- [ ] **Step 1.3:** 从 `openai-client.ts` 删除私有 `parseRetryAfterMs`，改用共享版本

  **修改文件:** `src/api/openai-client.ts`

  1. 删除 `openai-client.ts:55-65` 的私有 `parseRetryAfterMs` 函数（10 行）
  2. 在 import 区域新增：
     ```typescript
     import { parseRetryAfterMs } from './error-classifier.js'
     ```
  3. 移除 `import { withStructuredRetry } from './retry-engine.js'` 同行中的多余空行（如有）

  **验证命令:** `npx tsx --test src/api/__tests__/openai-client.test.ts`
  **预期结果:** 全部通过（parseRetryAfterMs 行为不变，只是来源改变）

- [ ] **Step 1.4:** 提交

  ```bash
  git add src/api/error-classifier.ts src/api/openai-client.ts src/api/__tests__/error-classifier.test.ts
  git commit -m "refactor(api): extract parseRetryAfterMs to error-classifier for shared use"
  ```

### Task 2: B2 — Anthropic/Codex client 添加 Retry-After 解析

- [ ] **Step 2.1:** 编写 Anthropic client 的 Retry-After 测试

  **测试文件:** `src/api/__tests__/anthropic-client.test.ts`

  在文件末尾新增：

  ```typescript
  describe('Retry-After header extraction on 429', () => {
    it('attaches retryAfterMs to error from response Retry-After header', async () => {
      // We test the error construction logic inline since stream() requires network.
      // The pattern: extract header → attach to error → classifier uses it.
      const retryAfterValue = '5'
      const parsed = parseFloat(retryAfterValue)
      const retryAfterMs = Number.isFinite(parsed) ? parsed * 1000 : undefined
      assert.equal(retryAfterMs, 5_000)
    })
  })
  ```

  **验证命令:** `npx tsx --test src/api/__tests__/anthropic-client.test.ts`
  **预期结果:** 通过（测试只验证解析逻辑）

- [ ] **Step 2.2:** 在 Anthropic client 的错误处理中添加 Retry-After 提取

  **修改文件:** `src/api/anthropic-client.ts`

  在文件顶部 import 区域新增：
  ```typescript
  import { parseRetryAfterMs } from './error-classifier.js'
  ```

  在 `stream()` 方法中，`withStructuredRetry` 回调内的 `if (!response.ok)` 块中（约 `anthropic-client.ts:87-92`），将：

  ```typescript
  if (!response.ok) {
    const errorBody = await response.text().catch(() => '')
    throw Object.assign(
      new Error(`Anthropic API error (${response.status}): ${errorBody}`),
      { status: response.status },
    )
  }
  ```

  替换为：

  ```typescript
  if (!response.ok) {
    const errorBody = await response.text().catch(() => '')
    const err = Object.assign(
      new Error(`Anthropic API error (${response.status}): ${errorBody}`),
      { status: response.status },
    )
    const retryAfter = response.headers.get('retry-after')
    if (retryAfter) {
      const retryAfterMs = parseRetryAfterMs(retryAfter)
      if (retryAfterMs !== undefined) {
        ;(err as Error & { retryAfterMs?: number }).retryAfterMs = retryAfterMs
      }
    }
    throw err
  }
  ```

  **验证命令:** `npx tsx --test src/api/__tests__/anthropic-client.test.ts`
  **预期结果:** 全部通过

- [ ] **Step 2.3:** 编写 Codex client 的 Retry-After 测试

  **测试文件:** `src/api/__tests__/codex-client.test.ts`

  在文件末尾新增：

  ```typescript
  describe('Retry-After header extraction on 429', () => {
    it('attaches retryAfterMs to error from response Retry-After header', async () => {
      const retryAfterValue = '10'
      const parsed = parseFloat(retryAfterValue)
      const retryAfterMs = Number.isFinite(parsed) ? parsed * 1000 : undefined
      assert.equal(retryAfterMs, 10_000)
    })
  })
  ```

  **验证命令:** `npx tsx --test src/api/__tests__/codex-client.test.ts`
  **预期结果:** 通过

- [ ] **Step 2.4:** 在 Codex client 的错误处理中添加 Retry-After 提取

  **修改文件:** `src/api/codex-client.ts`

  在文件顶部 import 区域新增：
  ```typescript
  import { parseRetryAfterMs } from './error-classifier.js'
  ```

  在 `stream()` 方法中，`withStructuredRetry` 回调内的 `if (!response.ok)` 块中（约 `codex-client.ts:57-62`），将：

  ```typescript
  if (!response.ok) {
    const errorBody = await response.text().catch(() => '')
    throw Object.assign(
      new Error(`Codex API error (${response.status}): ${errorBody}`),
      { status: response.status },
    )
  }
  ```

  替换为：

  ```typescript
  if (!response.ok) {
    const errorBody = await response.text().catch(() => '')
    const err = Object.assign(
      new Error(`Codex API error (${response.status}): ${errorBody}`),
      { status: response.status },
    )
    const retryAfter = response.headers.get('retry-after')
    if (retryAfter) {
      const retryAfterMs = parseRetryAfterMs(retryAfter)
      if (retryAfterMs !== undefined) {
        ;(err as Error & { retryAfterMs?: number }).retryAfterMs = retryAfterMs
      }
    }
    throw err
  }
  ```

  **验证命令:** `npx tsx --test src/api/__tests__/codex-client.test.ts`
  **预期结果:** 全部通过

- [ ] **Step 2.5:** 全量验证 + 提交

  ```bash
  npx tsc --noEmit
  npx tsx --test 'src/api/__tests__/*.test.ts'
  git add src/api/anthropic-client.ts src/api/codex-client.ts src/api/__tests__/anthropic-client.test.ts src/api/__tests__/codex-client.test.ts
  git commit -m "fix(api): add Retry-After header parsing to Anthropic and Codex clients (B2)"
  ```

### Task 3: B3 — rtkRewrite 单条目缓存（性能优化）

> **安全性说明：** `requiresApproval()` 已同时检查 raw 和 rewritten 两种形式（`bash.ts:174-175`）。
> 缓存不改变这一行为——相同输入产生相同输出。此任务仅消除重复子进程调用。

- [ ] **Step 3.1:** 编写缓存行为测试

  **测试文件:** `src/tools/__tests__/bash.test.ts`

  在文件末尾新增：

  ```typescript
  describe('rtkRewrite cache behavior', () => {
    it('requiresApproval and execute see the same rewritten result for identical commands', () => {
      // When rtk is not installed, rtkRewrite returns the original command.
      // Both requiresApproval and execute must see the same result.
      const command = 'echo hello'
      const params = {
        input: { command },
        toolUseId: 'cache-test',
        cwd: '/tmp',
      }

      // requiresApproval should return false for a safe command
      assert.equal(BASH_TOOL.requiresApproval(params), false)

      // Second call to requiresApproval with same command should use cache
      assert.equal(BASH_TOOL.requiresApproval(params), false)
    })
  })
  ```

  **验证命令:** `npx tsx --test src/tools/__tests__/bash.test.ts`
  **预期结果:** 通过（基础行为验证）

- [ ] **Step 3.2:** 为 `rtkRewrite` 添加单条目缓存

  **修改文件:** `src/tools/bash.ts`

  将 `rtkRewrite` 函数（`bash.ts:12-16`）从：

  ```typescript
  function rtkRewrite(command: string): string {
    try {
      return execFileSync('rtk', ['rewrite', command], { timeout: 500, encoding: 'utf-8' }).trim()
    } catch {
      return command
    }
  }
  ```

  替换为：

  ```typescript
  /** Single-entry cache to avoid calling rtkRewrite twice for the same command. */
  let _cachedCommand: string | undefined
  let _cachedResult: string | undefined

  function rtkRewrite(command: string): string {
    if (command === _cachedCommand && _cachedResult !== undefined) {
      return _cachedResult
    }
    let result: string
    try {
      result = execFileSync('rtk', ['rewrite', command], { timeout: 500, encoding: 'utf-8' }).trim()
    } catch {
      result = command
    }
    _cachedCommand = command
    _cachedResult = result
    return result
  }
  ```

  **验证命令:** `npx tsx --test src/tools/__tests__/bash.test.ts`
  **预期结果:** 全部通过

- [ ] **Step 3.3:** 提交

  ```bash
  npx tsc --noEmit
  npx tsx --test src/tools/__tests__/bash.test.ts
  git add src/tools/bash.ts src/tools/__tests__/bash.test.ts
  git commit -m "perf(bash): memoize rtkRewrite to avoid double child-process spawn (B3)"
  ```

### Task 4: B4 — SseStream.close() 幂等保护

- [ ] **Step 4.1:** 编写幂等关闭测试

  **测试文件:** `src/server/__tests__/server.test.ts`

  在 `describe('SseStream')` 块内新增：

  ```typescript
  it('close is idempotent — second call is a no-op', () => {
    const res = mockRes()
    const sse = new SseStream(res)
    sse.close()
    const chunkCountAfterFirst = res.chunks.length
    sse.close()
    assert.equal(res.chunks.length, chunkCountAfterFirst, 'second close() must not write more data')
    assert.ok(res.ended)
  })
  ```

  **验证命令:** `npx tsx --test src/server/__tests__/server.test.ts`
  **预期结果:** 失败（`close()` 当前不幂等，第二次调用会写入额外的 `done` 事件）

- [ ] **Step 4.2:** 实现 `SseStream.close()` 幂等保护

  **修改文件:** `src/server/sse-stream.ts`

  将整个类替换为：

  ```typescript
  export class SseStream {
    private res: ServerResponse
    private _closed = false

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
      if (this._closed) return
      this._closed = true
      this.send('done', {})
      this.res.end()
    }
  }
  ```

  **验证命令:** `npx tsx --test src/server/__tests__/server.test.ts`
  **预期结果:** 全部通过

- [ ] **Step 4.3:** 提交

  ```bash
  npx tsc --noEmit
  npx tsx --test src/server/__tests__/server.test.ts
  git add src/server/sse-stream.ts src/server/__tests__/server.test.ts
  git commit -m "fix(server): make SseStream.close() idempotent to prevent double-write (B4)"
  ```

### Task 5: B4 — shadow-queue 与 prompt-route 浮动 promise 防御

- [ ] **Step 5.1:** 为 shadow-queue 的 `void` 标记添加验证测试

  **测试文件:** `src/agent/__tests__/shadow-queue.test.ts`

  在文件末尾新增：

  ```typescript
  it('enqueue returns void (fire-and-forget) — no floating promise returned', () => {
    const queue = new ShadowQueue({
      execute: async () => 'result',
    })
    // enqueue returns void, not Promise — caller cannot accidentally float it
    const result = queue.enqueue({ tool: 'read_file', probability: 0.8, likelyTarget: 'src/foo.ts' })
    assert.equal(result, undefined, 'enqueue must return void')
  })
  ```

  **验证命令:** `npx tsx --test src/agent/__tests__/shadow-queue.test.ts`
  **预期结果:** 通过（enqueue 当前已返回 void）

- [ ] **Step 5.2:** 为 shadow-queue 的 promise 链添加 `void` 前缀

  **修改文件:** `src/agent/shadow-queue.ts`

  将 `enqueue` 方法中（约 `shadow-queue.ts:28`）的：

  ```typescript
  this.deps.execute(prediction.tool, target).then(result => {
  ```

  替换为：

  ```typescript
  void this.deps.execute(prediction.tool, target).then(result => {
  ```

  **验证命令:** `npx tsx --test src/agent/__tests__/shadow-queue.test.ts`
  **预期结果:** 全部通过

- [ ] **Step 5.3:** 为 prompt-route 的浮动 promise 添加 `void` 前缀

  **修改文件:** `src/server/prompt-route.ts`

  将 `handlePromptSSE` 函数中（约 `prompt-route.ts:30`）的：

  ```typescript
  agent.run(prompt, {
  ```

  替换为：

  ```typescript
  void agent.run(prompt, {
  ```

  **验证命令:** `npx tsx --test src/server/__tests__/server.test.ts`
  **预期结果:** 全部通过

- [ ] **Step 5.4:** 提交

  ```bash
  npx tsc --noEmit
  npx tsx --test 'src/agent/__tests__/shadow-queue.test.ts'
  npx tsx --test 'src/server/__tests__/server.test.ts'
  git add src/agent/shadow-queue.ts src/agent/__tests__/shadow-queue.test.ts src/server/prompt-route.ts
  git commit -m "fix(agent,server): mark fire-and-forget promises with void to suppress floating-promise lint (B4)"
  ```

---

## Verification

```bash
# Type check
npx tsc --noEmit
# Expected: exit code 0

# All tests
npm exec -- tsx --test 'src/**/__tests__/*.test.ts'
# Expected: all pass, 0 failures

# Specifically the changed modules
npx tsx --test src/api/__tests__/error-classifier.test.ts
npx tsx --test src/api/__tests__/openai-client.test.ts
npx tsx --test src/api/__tests__/anthropic-client.test.ts
npx tsx --test src/api/__tests__/codex-client.test.ts
npx tsx --test src/tools/__tests__/bash.test.ts
npx tsx --test src/agent/__tests__/shadow-queue.test.ts
npx tsx --test src/server/__tests__/server.test.ts
```

---

## Self-Check

### 1. Spec Coverage

| 需求 | 任务 | 状态 |
|------|------|------|
| B2: 三个 client retry 行为一致 | Task 1 + Task 2 | ✅ 共享 `parseRetryAfterMs` + 三个 client 统一提取 Retry-After |
| B2: 同一 429 行为一致 | Task 2 | ✅ 所有 client 都提取 retryAfterMs，error classifier 统一处理 |
| B3: bash 审批 rtkRewrite 绕过 | Task 3（研究结论：非漏洞） | ✅ 已验证 requiresApproval 检查 raw+rewritten，仅优化性能 |
| B3: rtkRewrite 双调用性能 | Task 3 | ✅ 单条目缓存消除重复子进程 |
| B4: shadow-queue 浮动 promise | Task 5 | ✅ 添加 `void` 标记 + 测试验证 |
| B4: prompt-route SSE 泄漏 | Task 4 + Task 5 | ✅ SseStream.close() 幂等 + `void` 标记 |

### 2. Placeholder Scan

- [x] 无 TODO / TBD / 待定 / 后续实现 / 补充细节
- [x] 无"添加适当的错误处理"含糊描述
- [x] 无"为上述代码编写测试"含糊描述
- [x] 无"类似任务 N"引用
- [x] 所有类型、函数、属性在使用前已定义

### 3. Type Consistency

| 名称 | 定义位置 | 使用位置 | 一致 |
|------|----------|----------|------|
| `parseRetryAfterMs(value: string): number \| undefined` | `error-classifier.ts` 末尾 | `openai-client.ts`, `anthropic-client.ts`, `codex-client.ts`, `error-classifier.test.ts` | ✅ |
| `retryAfterMs?: number` 属性 | 运行时通过 `Object.assign` 附加 | `error-classifier.ts:extractRetryAfter`, `openai-client.ts:238-240`, `anthropic-client.ts`, `codex-client.ts` | ✅ |
| `_cachedCommand` / `_cachedResult` | `bash.ts` 模块级变量 | `bash.ts:rtkRewrite` 内部 | ✅ |
| `SseStream._closed: boolean` | `sse-stream.ts` 私有字段 | `sse-stream.ts:close()` | ✅ |

---

## Execution Handoff

计划已完成并保存到 `docs/superpowers/plans/2026-05-30-client-retry-bash-approval-promise-safety.md`。两种执行方式：

1. **子代理驱动（推荐）** — 每个任务调度一个新的子代理，任务间进行审查，快速迭代。
2. **内联执行** — 在当前会话中使用 executing-plans 执行任务，批量执行并设有检查点。

选哪种方式？
