# Thinking 实时显示调试埋点(存档)

排查 provider 实时 thinking 不显示问题时用的临时埋点。需要时手动贴回 `src/tui/app.tsx`,跑完会话后看 `/tmp/think-debug.log`,排查完务必移除。

## 用途
定位 reasoning_content → 实时 thinking 链路的卡点:
- 只有 `[onTextDelta]` 没有 `[onThinkingDelta]` → reasoning 没到 TUI(provider 解析/回调链问题)
- 有 `[onThinkingDelta]` 没有 `[setStreamingThinking ... PUSHED]` → flush 节流吞了它
- 有 `[setStreamingThinking ... PUSHED]` 但屏幕没显示 → 渲染条件问题

## 4 处埋点

### 1. import(顶部 node:fs 那行)
```ts
import { readFileSync, existsSync, appendFileSync } from 'node:fs'
```

### 2. flushThink 入口(useCallback 内)
```ts
  const flushThink = useCallback(() => {
    thinkTimer.current = null
    appendFileSync('/tmp/think-debug.log', `[flushThink] buf=${thinkBuf.current.length} lastFlushed=${lastFlushedThink.current.length}\n`)
    if (thinkBuf.current !== lastFlushedThink.current) {
      lastFlushedThink.current = thinkBuf.current
      appendFileSync('/tmp/think-debug.log', `[setStreamingThinking] -> ${thinkBuf.current.length} chars PUSHED TO UI\n`)
      setStreamingThinking(thinkBuf.current)
    }
  }, [])
```

### 3. onThinkingDelta 入口
```ts
      onThinkingDelta: (thinking) => {
        appendFileSync('/tmp/think-debug.log', `[onThinkingDelta] +${thinking.length} (buf will be ${thinkBuf.current.length + thinking.length}) thinkStart=${thinkStartRef.current}\n`)
        setHeartbeatStatus(null)
```

### 4. onTextDelta 入口
```ts
      onTextDelta: (text) => {
        appendFileSync('/tmp/think-debug.log', `[onTextDelta] +${text.length} (thinkBuf=${thinkBuf.current.length})\n`)
        setHeartbeatStatus(null)
```

## 跑前清空日志
```sh
rm -f /tmp/think-debug.log && npm run build
```

## 历史结论(2026-05-30)
glm/mimo/deepseek 的 reasoning_content 全部正常到达 TUI(146 次 delta),
但 flushThink 的 500 字符二次刷新阈值导致末段 thinking 永久不刷
(卡在 buf=817/lastFlushed=483,delta=334<500)。修复:移除 500 阈值,
仅靠 1000ms 定时器节流。见 commit "fix(tui): show full live thinking for glm/mimo"。
