# 调试模式：超时分层倒挂 (Timeout Inversion)

> 蒸馏自 session 2699d26f 的 bug 查找过程。可复用于任何「agent/worker 卡死、无响应」的 root-cause 定位。

## 现象特征

- TUI 显示 `No response — Ctrl+C to interrupt (3m)` 或类似长时间无响应
- delegate_task / worker 卡住不返回
- 多个 timeout 值恰好相等（如 180s = 180s = 180s）

## 调查步骤

### 1. 读 session 日志重建时间线

```bash
f=~/.rivet/sessions/<project-slug>/<session-id>.jsonl
# 找关键事件: delegate_task failed, user "继续", todo 状态变化
```

按 entry 编号排列事件，确定因果链。

### 2. 对比超时常量（三层对照）

```bash
# 第一层：provider SSE 超时
grep -n "FIRST_BYTE_TIMEOUT\|READ_TIMEOUT\|SLOW_FIRST\|SLOW_READ" src/api/openai-client.ts

# 第二层：worker budget 超时
grep -n "timeoutMs" src/agent/work-order.ts src/agent/worker-session.ts

# 第三层：tool pipeline 超时
grep -n "progressiveTaskTimeout\|progressiveBatchTimeout" src/tools/delegate-task.ts src/tools/delegate-batch.ts
```

**关键检查**：worker 整体超时是否 ≤ provider 首字节超时？
- worker timeout ≤ provider_first_byte → **倒挂**：worker 在 provider 合法等待期内误触发 abort
- 应满足：worker timeout > provider_first_byte + provider_read（至少 2x 首字节）

### 3. 追踪 abort 能否中断阻塞 IO

搜索所有 SSE 客户端中的 `signal?.aborted` 检查：

```bash
grep -A2 "signal?.aborted" src/api/*-client.ts
```

**关键检查**：`signal.aborted` 检查是否在 `await reader.read()` **之前**？
- 在 `reader.read()` 之前 → **不可中断**：abort 设了标志但 reader 阻塞在 read()，循环回不到检查
- 修复：用 `signal.addEventListener('abort', () => reader.cancel())` 连接 abort 信号到 reader

### 4. 确认竞争窗口

当 worker timeout == provider first_byte timeout 时：
- worker timer 和 provider idle timer 几乎同时触发
- 两者都尝试中断 reader（abort vs cancel）
- 若 abort 未连接到 reader.cancel() → abort 设标志但无法中断 read → 死锁

## 已修复的根因

| 修复 | 文件 | 说明 |
|------|------|------|
| `wireAbortToReaderCancel()` | openai-client.ts, anthropic-client.ts, codex-client.ts | 连接 abort signal 到 reader.cancel()，使外部 abort 能中断阻塞的 reader.read() |
| worker budget 120s→180s | work-order.ts | 给 GLM/DeepSeek 等慢模型足够的思考时间 |
| progressiveTaskTimeout 150s→180s | delegate-task.ts | 对齐 worker budget |

## 通用超时分层原则

```
tool_pipeline_timeout > worker_budget_timeout > provider_first_byte_timeout + provider_read_timeout
```

- tool pipeline 必须 > worker budget（否则工具先超时，worker 没机会完成）
- worker budget 必须 > provider 总超时（否则 worker 在 provider 合法等待期内误杀）
- provider first_byte 和 read 分开设置：首字节慢 ≠ 传输慢，不要用同一常数

## 案例：2699d26f 的倒挂

```
worker timeout (180s) = GLM first-byte timeout (180s) < GLM read timeout (300s)
```

GLM 思考 170s → worker 180s timer 触发 abort → 但 reader.read() 阻塞中（GLM 还没发数据，没到 180s idle timer 点）→ abort 标志设了但读不到 → 死锁 3 分钟。
