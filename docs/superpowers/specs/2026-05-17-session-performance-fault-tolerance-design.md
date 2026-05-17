# 会话性能、容错与流畅性加固 — 设计文档

> **状态：已实现** — 2026-05-18 全部 7 个任务完成，1416 测试通过

## 背景

Rivet 当前的会话基础设施在正常路径上工作良好，但在以下场景缺乏韧性：

1. **API 错误处理分散** — `client.ts` 和 `codex-client.ts` 各自硬编码 retry 逻辑，没有统一的错误分类
2. **流中断后丢失上下文** — SSE stream 崩溃后整轮失败，用户必须重新输入
3. **终端渲染低效** — 逐文本推送，没有批处理和原子帧
4. **Output token 限制无恢复** — 命中 maxTokens 后直接结束，静默截断用户回复
5. **用户中途输入只能打断** — 没有引导注入机制，用户想在任务执行中补充指导只能中断

## 调研来源

对三个终端 coding agent 的代码进行了深入分析：

| 项目 | 核心发现 |
|------|---------|
| **Claude Code** (claude-code-haha) | 60fps 双缓冲 diff 渲染 + 单次 stdout.write 批处理 + withRetry 10次分层重试 + output token 静默升级 + 命令队列三层优先级 + 流式回退 (StreamingToolExecutor.discard) |
| **OpenCode** | Effect 框架全链路 + Runner 状态机 (Idle/Running/Shell) + 语义感知重试 + TokenBudget 收益递减检测 + Agent 池并发调度 |
| **Hermes** | 结构化错误分类管线 (ClassifiedError) + 双重重试循环 + jitter 去相关 + 流停滞检测 (180s) + 心跳保持 + flood control 3-strike 降级 + steer 引导注入 |

### 关键技术决策对比

#### 错误分类

- **Hermes** 用 `ClassifiedError` 数据类：`retryable`/`shouldCompress`/`shouldRotateCredential`/`shouldFallback`。分类管线是优先级排序的：提供商特有模式 → HTTP 状态码 → 错误码 → 消息模式匹配 → SSL/TLS → 传输超时 → 兜底
- **Claude Code** 按来源分层：`isTransientCapacityError`(529/429) / `isStaleConnectionError`(ECONNRESET/EPIPE) / 401→OAuth 刷新 / 403→token 撤销
- **OpenCode** 语义判断：ContextOverflowError 不重试、`isRetryable` 标记、`FreeUsageLimitError` 不重试
- **Rivet 实现**：`classifyApiError()` 纯函数管线，9 种 ErrorCategory，30 个测试覆盖

#### 重试策略

- **Hermes** 双重循环：外层处理凭证轮换和提供商回退，内层处理流/网络错误。内层感知"部分交付"
- **Claude Code** withRetry 异步生成器：最多 10 次，529 单独计数（3 次），401 触发 OAuth 刷新后重试
- **Rivet 实现**：`withStructuredRetry()` + jittered backoff，分类感知，per-category maxRetries + 全局 maxTotalRetries

#### 用户引导

- **Hermes** steer 机制：用户中途消息排入 steer buffer，在下一个 API 调用前注入到最近 tool result
- **Rivet 实现**：`SteerBuffer` + `onSteerDrain` 回调，注入到最后一个 tool_result content 中

## 已实现模块

### 模块 1：结构化错误分类器 (`src/api/error-classifier.ts`)

纯函数错误分类管线，借鉴 Hermes 的 `ClassifiedError` 模式。

```
API Error → classifyApiError() → ClassifiedError
                                        ├── retryable: boolean
                                        ├── retryDelayMs: number
                                        ├── shouldReconnect: boolean
                                        ├── category: ErrorCategory (9 种)
                                        ├── userMessage: string
                                        └── maxRetries: number
```

优先级链：HTTP status → error name → message pattern → fallback。

### 模块 2：重试引擎 (`src/api/retry-engine.ts`)

替换了 `client.ts` 和 `codex-client.ts` 中分散的 retry 逻辑。

```
withStructuredRetry(fn, signal, options) → Promise<T>

  循环:
    1. classifyApiError(error) → classified
    2. if !classified.retryable → throw
    3. if over effective max → throw
    4. await classified.retryDelayMs or jitteredBackoff(attempt)
    5. retry
```

Jittered backoff：`min(baseDelay * 2^(attempt-1), maxDelay) + random(0, jitterRatio * delay)`。

### 模块 3：Output Token 静默升级 (`src/agent/loop.ts`)

在 agent loop 中检测 `max_output_tokens` stop reason 并自动恢复：

1. 捕获 stop reason（之前被忽略）
2. 检测到 `max_output_tokens` 且无 tool call → 注入续接消息 "Continue your response from where you left off."
3. 最多 3 次升级循环（`MAX_OUTPUT_ESCALATION = 3`）
4. 利用现有的 `continue` 循环机制，无需重构

### 模块 4：终端写入批处理 (`src/tui/render-batch.ts`)

`RenderBatcher<T>` 泛型批处理层：

- `queueMicrotask` 对齐：同一微任务周期内的多个 delta 合并成单次 flush
- `flushNow()`：turn 边界时同步刷新，确保无文本丢失
- 接入点：`BlockStreamWriter` 的 push 回调 → `textBatcher.push(text)` → 批量更新 `streamBuf` + `setStreamingText`

### 模块 5：引导注入 (`src/tui/steer-buffer.ts`)

借鉴 Hermes 的 steer 机制，用户在任务执行期间可以发送引导消息：

- **不打断当前任务** — InputBar 在 streaming 时保持可用
- **排队等待** — 消息进入 `SteerBuffer`
- **适时注入** — 在下一个 tool result 后通过 `onSteerDrain` 回调注入到最后一个 `tool_result.content`
- **TUI 提示** — "📋 Guidance queued" + "📋 Injecting user guidance..."

## 不做的事

- **不引入 Effect 框架** — Rivet 用原生 TypeScript async/await
- **不做背压控制** — SSE 流量在终端场景下不会超过渲染能力
- **不做凭证池/提供商回退** — 单 provider，后续需求
- **不做双缓冲 diff 渲染** — Ink 6 内部管理渲染
- **不做流停滞检测** — 已有 120s/180s 超时，当前足够
- **不用优先级队列抢占** — 用户明确要求不打断，改用引导注入

## 已实现文件清单

| 文件 | 变更 | Commit |
|------|------|--------|
| `src/api/error-classifier.ts` | 新建，30 测试 | `f37d755` |
| `src/api/retry-engine.ts` | 新建，14 测试 | `e9da213` |
| `src/api/client.ts` | 修改：删除硬编码 retry，-42 行 | `a87b928` |
| `src/api/codex-client.ts` | 修改：删除硬编码 retry，-40 行 | `a87b928` |
| `src/agent/loop.ts` | 修改：output token 升级 + steer 注入 | `16aded9`, `9e66795` |
| `src/tui/render-batch.ts` | 新建 | `47b424a` |
| `src/tui/steer-buffer.ts` | 新建，6 测试 | `9e66795` |
| `src/tui/app.tsx` | 修改：接入批处理 + 引导注入 | `47b424a`, `9e66795` |
