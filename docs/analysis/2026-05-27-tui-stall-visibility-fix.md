# TUI 会话卡住感排查与可见性修复记录

> 日期：2026-05-27  
> 范围：TUI 静默阶段可见性、Agent heartbeat 投影、stream text delta 缓冲行为表征。  
> 状态：已做低风险可见性修复；真实 token-by-token 实时输出仍保留为后续独立任务。

## 1. 背景

用户反馈：会话界面在等待过程中“卡住”。本轮目标不是重构流式系统，而是先判断卡顿链路，并做最小低风险修复，让 TUI 在 agent 仍工作但暂无可见文本时有明确状态。

当时工作区已有其他外部改动（例如 `.gitignore`、`.rivet/knowledge/project-memory.md` 等），本记录只描述本轮与 TUI 卡顿可见性相关的分析和修复。

## 2. 排查结论

### 2.1 更像“可见性缺失”，不是 runtime 文件写入阻塞

排查过以下 runtime 写入路径：

- cache-log：`AgentLoop.recordTurnCache()` 中异步 `appendFile`，不 await。
- sensorium：`createTelemetryWriter()` 异步 append，普通 write 不阻塞 TUI render。
- session persist：mutation listener 通过 promise chain 保序写入，但没有在 UI callback 中 await。

因此，本次没有把 `.rivet/sessions/*`、`~/.rivet/sessions/*` 写入作为首要卡顿根因。

### 2.2 TUI 存在空 streaming 窗口

修复前：

```tsx
// src/tui/stream.tsx
if (!text) return null
```

而 App 中会在 `isStreaming === true` 时渲染 StreamOutput：

```tsx
{(streamingText || isStreaming) && (
  <StreamOutput text={streamingText} isStreaming={isStreaming} />
)}
```

组合结果是：

```tsx
<StreamOutput text="" isStreaming={true} />
```

会直接返回 `null`，用户看不到任何“仍在工作”的提示。

### 2.3 AgentLoop heartbeat 已存在，但 App 未显示

AgentLoop 中已有静默 watchdog：

```ts
callbacks.onPhaseChange?.('heartbeat', {
  reason: `still working — last activity: ${lastActivity} (${seconds}s ago)`,
})
```

但 App 的 `onPhaseChange` 此前只处理星相 phase / radio 等逻辑，没有把 `phase === 'heartbeat'` 投影到界面。结果是：会话层已经知道“仍在工作”，但 TUI 没显示。

### 2.4 Provider text delta 当前被 turn-stream 缓冲

`TurnStreamController` 中 provider text delta 当前先进入 `turnDisplayBuffer`：

```ts
turnDisplayBuffer += text
```

直到 stream 结束后才：

```ts
input.callbacks.onTextDelta(dedupedBuffer)
```

因此真实 token-by-token UI 并未发生。这个行为被新增测试表征保留，避免后续误判。

## 3. 本轮修复

### 3.1 StreamOutput 增加 waiting fallback

文件：`src/tui/stream.tsx`

修复后行为：

- `isStreaming === true && text === ''`：显示轻量状态

  ```text
  ◌ Waiting for model…
  ```

- `isStreaming === false && text === ''`：仍返回 `null`，避免 turn 完成后残留空状态。

目的：解决 provider/tool/post-turn 静默窗口看起来像冻结的问题。

### 3.2 App 接入 heartbeatStatus

文件：`src/tui/app.tsx`

新增状态：

```ts
const [heartbeatStatus, setHeartbeatStatus] = useState<string | null>(null)
```

新增处理：

```ts
if (phase === 'heartbeat') {
  setHeartbeatStatus(detail?.reason ?? 'still working')
  return
}
```

显示条件：

```tsx
{heartbeatStatus && !streamingText && liveTools.length === 0 && !streamingThinking && (
  <Box paddingX={2}>
    <Text dimColor>◌ {heartbeatStatus}</Text>
  </Box>
)}
```

并在以下事件发生时清除 heartbeat，防止旧状态残留：

- 新 turn 开始
- `onTextDelta`
- `onThinkingDelta`
- `onToolUse`
- `onToolResult`
- `onTurnComplete`

### 3.3 新增/更新测试

文件：`src/tui/__tests__/stream.test.tsx`

覆盖：

1. streaming 但无 text 时显示 waiting indicator。
2. 非 streaming 且无 text 时仍不渲染。
3. 有 visible text 时仍显示 streaming cursor。

文件：`src/agent/__tests__/turn-stream.test.ts`

新增表征测试：

- provider 连续 `cb.onTextDelta('first ')` / `cb.onTextDelta('second')` 时，TUI callback 在 stream 未结束前不会收到 text；stream 结束后收到合并文本 `first second`。

这不是修复目标，而是把当前行为固定为事实，方便后续决定是否做更大改造。

## 4. 已执行验证

```bash
npx tsc --noEmit --pretty false --noErrorTruncation
```

结果：通过。

```bash
run_tests src/tui/__tests__/stream.test.tsx
```

结果：3 passed。

```bash
run_tests src/agent/__tests__/turn-stream.test.ts
```

结果：4 passed。

```bash
npm exec -- tsx --test src/tui/__tests__/stream.test.tsx src/agent/__tests__/turn-stream.test.ts
```

结果：7 passed, 0 failed。

## 5. 未解决 / 后续任务

### 5.1 真正实时 token-by-token 输出仍未实现

当前 `TurnStreamController` 仍然缓冲 provider text delta，直到 stream 结束后再交给 TUI。后续若要实现真正实时输出，需要单独设计，至少考虑：

- `lastTurnTextFingerprint` / dedup 逻辑如何保留；
- `stripIntraTurnRepetition()` 是否仍在 turn end 执行；
- already streamed text 如何避免 turn end 再重复 push；
- thinking-only retry 与 partial visible text 的关系；
- prewarm 逻辑是否仍基于完整 accumulated text 或 incremental text；
- error/abort 时 partial text 如何持久化。

建议不要在小修复中顺手改这个链路。

### 5.2 heartbeat 可见性仍是 transient UI，不是历史日志

本轮 heartbeat 只显示在 live 区域，不写入 Static history。这样避免历史污染，但也意味着事后只能通过测试/日志追踪，不会在 transcript 中看到每次 heartbeat。

如果后续需要审计长静默阶段，可考虑把 heartbeat 写入 debug telemetry 或单独 runtime event，而不是写入用户可见历史。

### 5.3 真 TUI smoke 仍建议单独做

可以用伪 TTY / pipe smoke，但不应作为主要验证：

```bash
npm run build
printf '请简单回复 ok\n' | node dist/main.js
```

或 macOS：

```bash
script -q /tmp/rivet-tui.log node dist/main.js
```

限制：非 TTY / 伪 TTY 行为与真实交互不同，且真实 API 会引入网络和模型变量。建议优先用 fake agent / targeted tests 验证 UI 状态机。

## 6. 后续接手建议

若用户再次反馈“界面卡住”：

1. 先确认是否能看到 `◌ Waiting for model…` 或 `◌ still working — last activity: ...`。
2. 如果能看到，说明 agent/TUI 没冻结，只是仍在静默阶段。
3. 如果完全无状态，优先查：
   - `onPhaseChange('heartbeat')` 是否触发；
   - `isStreaming` 是否正确置为 true；
   - `StreamOutput` 是否被 unmount；
   - App render 是否因异常被 ErrorBoundary 吃掉。
4. 如果用户诉求变成“希望文字实时出现”，再进入 `TurnStreamController` 实时 delta 转发设计，不要在 heartbeat 可见性修复里混做。
