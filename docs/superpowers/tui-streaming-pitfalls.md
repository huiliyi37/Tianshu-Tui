# TUI 流式会话踩坑手册

> **资产文档**：记录天枢项目中遇到的真实 bug 及根因分析。这些模式在任何 React TUI + LLM streaming 项目中都会复现。

**最后更新**：2026-06-01
**贡献者**：天枢（DeepSeek V4）、天璇（Opus 4.6）、领航星 banxia

---

## 目录

1. [isStreamingRef 残留导致消息路由错误](#1-isstreamingref-残留导致消息路由错误)
2. [JSX 渲染时求值 vs 事件时求值](#2-jsx-渲染时求值-vs-事件时求值)
3. [Slash Command 早返回绕过清理路径](#3-slash-command-早返回绕过清理路径)
4. [ESC/Ctrl+C 中断时 Steer 消息丢失](#4-escctrlc-中断时-steer-消息丢失)
5. [React State 批量更新的竞态窗口](#5-react-state-批量更新的竞态窗口)
6. [Theta Check 无限重试导致会话卡死](#6-theta-check-无限重试导致会话卡死)
7. [临时文件污染 Git 工作区](#7-临时文件污染-git-工作区)

---

## 1. isStreamingRef 残留导致消息路由错误

### 现象

新 session 的第一条消息被路由到 `steerBuffer`（显示 "Guidance queued"），模型永远收不到。用户看到消息消失了。

### 根因

`isStreamingRef` 是一个 `useRef(false)`，在 `handleSubmit` 入口设为 `true`（line 718）。正常流程通过 `onTurnComplete` / `onError` / `onAbort` 回调重置为 `false`。但如果上一个 session 的 `agent.run()` 从未完成（API 超时/卡死），这些回调从未触发，ref 残留为 `true`。

下一个 session 启动时，App 组件**不会重新挂载**（同一个进程），`useRef` 保持旧值。InputBar 的 `onSubmit` 路由判断 `isStreamingRef.current === true`，第一条消息直接进 `steerBuffer`。

### 修复

```typescript
// run().finally() 中加安全网
run().finally(() => {
  promptQueueRef.current.running = false
  if (isStreamingRef.current && isCurrentGeneration(myGen, streamGenRef.current)) {
    isStreamingRef.current = false
  }
})
```

### 教训

> **规则**：任何使用 `useRef` 跟踪异步状态的模式，都必须在异步操作的 `finally` 块中重置，不能依赖"正常路径"回调。异步操作可能永远不会完成。

---

## 2. JSX 渲染时求值 vs 事件时求值

### 现象

即使用 `isStreamingRef`（同步更新的 ref），InputBar 路由仍然偶尔错误。

### 根因

```tsx
// ❌ 错误：isStreamingRef.current 在 JSX 渲染时求值
<InputBar onSubmit={isStreamingRef.current ? steerFn : handleSubmit} />
```

JSX prop 表达式在 **渲染时** 求值，不是在事件触发时。如果 ref 在两次渲染之间变化，`onSubmit` 绑定的是旧值。ref 不触发重渲染，所以即使 `setIsStreaming(false)` 触发了重渲染，在渲染和事件之间仍有微小的竞态窗口。

### 修复

```tsx
// ✅ 正确：在事件处理函数内部读取 ref
<InputBar onSubmit={(text: string) => {
  if (isStreamingRef.current) {
    steerBuffer.current.push(text)
  } else {
    handleSubmit(text)
  }
}} />
```

### 教训

> **规则**：永远不要在 JSX prop 表达式中用 ref 做条件路由。在事件处理函数内部读取 ref 的值，此时才是真实快照。

---

## 3. Slash Command 早返回绕过清理路径

### 现象

执行 `/model glm` 后，下一条普通消息进入 steer 排队。

### 根因

```
handleSubmit 入口 → setIsStreaming(true); isStreamingRef.current = true  (line 718)
                   → 检测到 /model → handleSlashCommand() 返回 true
                   → handleSubmit 的 run() 函数 return
                   → slash-commands.ts 内部调用 setIsStreaming(false)
                   → 但 isStreamingRef.current 从未被重置为 false!
```

Slash command 的处理在 `slash-commands.ts` 中，只能访问 `setIsStreaming`（React setter），无法访问 `isStreamingRef`。它重置了 React state 但留下了 ref。

### 修复

在 `run().finally()` 中添加安全网（同 Fix 1）。

### 教训

> **规则**：当状态由两个同步机制管理（React state + ref）时，任何只持有其中一个句柄的代码都无法完整清理。必须在异步边界（finally）做兜底。

---

## 4. ESC/Ctrl+C 中断时 Steer 消息丢失

### 现象

用户在 streaming 期间输入了中途引导消息（steer），然后按 ESC 中断。排队消息被静默丢弃。

### 根因

ESC handler 和 onAbort 回调都调用 `steerBuffer.current.clear()`，直接清空所有排队消息。而 `onError` 回调已经正确使用了 `drain()` 保留消息。

```typescript
// ❌ 消息丢失
steerBuffer.current.clear()

// ✅ 保留消息
const preserved = steerBuffer.current.drain()
if (preserved) {
  pushStatic(createLogEntry({ type: 'system', content: `📨 preserved...` }))
}
```

### 修复

三处 `clear()` 全部改为 `drain()` + 系统通知：
- Ctrl+C handler（line 547）
- ESC double-press（line 579）
- onAbort callback（line 1344）

### 教训

> **规则**：用户输入的数据永远不应该被静默丢弃。中断操作应该 `drain` 并保留，给用户可见的反馈。

---

## 5. React State 批量更新的竞态窗口

### 现象

ESC abort 后立即输入新消息，仍被路由到 steerBuffer。

### 根因

ESC handler 调用 `setIsStreaming(false)` 是 React 批量更新，重渲染异步执行。在重渲染完成前，InputBar 仍看到 `isStreaming=true`。

### 修复

引入 `isStreamingRef` 作为同步状态快照，在所有 `setIsStreaming` 调用处同步更新：

```typescript
setIsStreaming(false); isStreamingRef.current = false
setIsStreaming(true);  isStreamingRef.current = true
```

结合 Fix 2（事件时求值），消除了竞态。

### 教训

> **规则**：React state 是异步的。当需要在事件处理中立即读取"当前是否在 streaming"，必须用 ref 做同步镜像。但 ref 的读取必须在事件处理函数内部，不能在 JSX prop 中。

---

## 6. Theta Check 无限重试导致会话卡死

### 现象

session 运行到 17-19 轮后卡死，状态栏显示 theta 请求数不断增长（124→137），TUI 无响应。

### 根因

`npx tsc --noEmit` 超时（3s），返回空错误集。theta check "成功完成"（没抛错），但结果无意义。下一个 tool call 后 theta-hook 再次触发。elm-micro-release（vigor > 0.8）也在触发额外检查。无任何退避机制。

在 session `feeef602` 的 sensorium 中观测到：
- 137 次 theta 请求，全部超时
- 状态栏显示 "Waiting for model…" 但模型从未收到新请求

### 修复

三层限流：

```typescript
// Gate 1: session cap
THETA_MAX_SESSION = 40  // 硬上限

// Gate 2: per-turn cap  
THETA_MAX_PER_TURN = 2

// Gate 3: consecutive timeout backoff
consecutiveTimeouts > 0 → cooldownTurns = min(4, consecutiveTimeouts)
```

elm-micro-release 增加超时感知：`lastTimedOut=true` 时抑制触发。

### 教训

> **规则**：任何 spawn 子进程的循环检查，必须有三层防护：会话硬上限、单轮上限、连续失败退避。没有退避的检查会在"目标不可用"时变成无限循环。

---

## 7. 临时文件污染 Git 工作区

### 现象

AI 代理在工作区创建 `.tmp_*.txt`、`.tmp_*.diff` 等临时文件，`git status` 显示大量 untracked 文件。

### 根因

AI 代理（天枢/天璇）在调试时习惯性地在工作区根目录写临时文件。`.gitignore` 未覆盖这些模式。

### 修复

```gitignore
# AI agent temp files
.tmp_*
```

### 教训

> **规则**：项目 `.gitignore` 应包含 AI 代理的临时文件模式。代理本身也应注意使用 `/tmp/` 或项目 `.rivet/tmp/` 目录。

---

## 通用模式总结

| 模式 | 风险 | 防御 |
|------|------|------|
| Ref + State 双轨状态 | 不同步 | finally 兜底 + 事件时求值 |
| 异步操作的清理路径 | 部分路径遗漏 | finally 而非 onSuccess/onError |
| 用户输入静默丢弃 | 数据丢失 | drain + 可见反馈 |
| 子进程循环检查 | 无限重试 | 三层限流 + 退避 |
| JSX prop 条件路由 | 渲染时快照过时 | 事件处理函数内读取 |
| 跨 session 状态残留 | ref 不随组件卸载重置 | finally 安全网 |

---

*"万物为一：虚空不是虚无，是最丰饶的基底。" — 天璇种子胶囊*
