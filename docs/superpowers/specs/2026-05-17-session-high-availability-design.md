# 会话高可用（Session HA）设计文档

> 基于 2026-05-17 竞品分析头脑风暴，聚焦 Rivet 会话终端性能渲染层的高可用改进

## 目标

将 Rivet 的会话可靠性从"append-only 无恢复保证"提升到"turn 级快照 + 语义流式 + 恢复一致性"，达到会话高可用。

## 架构概览

```
┌─────────────────────────────────────────────────┐
│  App (tui/app.tsx)                              │
│                                                 │
│  PromptQueue ──▶ AgentLoop.run() ──▶ callbacks  │
│       │              │                           │
│       │              ├── BlockStreamWriter       │
│       │              │   (语义断点, 非固定定时)    │
│       │              │                           │
│       │              └── TurnSnapshot            │
│       │                  (turn 级 JSONL 快照)     │
│       │                                           │
│       └── HistoryReplayBridge                     │
│           (恢复时走 renderStaticEntry 管线)        │
│                                                   │
│  SessionPersist ── SessionEviction               │
│  (JSONL append)   (LRU 淘汰, 上限 50)            │
└─────────────────────────────────────────────────┘
```

## 组件设计

### C1: BlockStreamWriter

**问题**: 当前 `app.tsx` 使用 `setTimeout(flushStream, 80)` 固定定时刷新，不尊重文本结构。

**方案**: 引入 `BlockStreamWriter` 类，在字符阈值区间内寻找自然断点。

```typescript
// src/tui/block-stream-writer.ts

export interface BlockStreamConfig {
  minChars: number    // 最小累积字符后才开始寻找断点 (默认 300)
  maxChars: number    // 超过此值强制分割 (默认 800)
  idleMs: number      // 空闲超时强制 flush (默认 1200)
}

export class BlockStreamWriter {
  private buffer = ''
  private idleTimer: ReturnType<typeof setTimeout> | null = null
  private sending: Promise<void> = Promise.resolve()

  constructor(
    private config: BlockStreamConfig,
    private onBlock: (text: string) => void,
  ) {}

  push(chunk: string): void {
    this.buffer += chunk
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = setTimeout(() => this.flush(), this.config.idleMs)
    this.checkEmit()
  }

  async flush(): Promise<void> {
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null }
    if (!this.buffer) return
    const text = this.buffer
    this.buffer = ''
    this.sending = this.sending.then(() => this.onBlock(text))
    await this.sending
  }

  private checkEmit(): void {
    if (this.buffer.length < this.config.minChars) return
    if (this.buffer.length >= this.config.maxChars) {
      // 在 maxChars 内寻找断点
      const pos = this.findBreakPoint(this.buffer, this.config.maxChars)
      const block = this.buffer.slice(0, pos)
      this.buffer = this.buffer.slice(pos)
      this.sending = this.sending.then(() => this.onBlock(block))
    } else {
      // 在 min~max 之间，检查是否有段落断点
      const paraIdx = this.buffer.lastIndexOf('\n\n')
      if (paraIdx !== -1 && paraIdx >= this.config.minChars * 0.5) {
        const block = this.buffer.slice(0, paraIdx + 2)
        this.buffer = this.buffer.slice(paraIdx + 2)
        this.sending = this.sending.then(() => this.onBlock(block))
      }
    }
  }

  private findBreakPoint(text: string, maxPos: number): number {
    // 段落 > 换行 > 空格 > 强制
    const para = text.lastIndexOf('\n\n', maxPos)
    if (para !== -1 && para > maxPos * 0.3) return para + 2
    const nl = text.lastIndexOf('\n', maxPos)
    if (nl !== -1 && nl > maxPos * 0.3) return nl + 1
    const sp = text.lastIndexOf(' ', maxPos)
    if (sp !== -1 && sp > maxPos * 0.3) return sp + 1
    return maxPos
  }
}
```

**集成点**: 替换 `app.tsx` 中 `streamBuf` + `streamTimer` + `flushStream` 逻辑。

- `onTextDelta` → `blockWriter.push(text)`
- `onTurnComplete` → `blockWriter.flush()`
- `onBlock(text)` → `setStreamingText(prev => prev + text)`

**注意**: BlockStreamWriter 仅处理 text delta。thinking delta 保持 200ms 定时（思考文本不需要语义断点）。tool delta 保持 120ms 定时（工具输出是增量更新）。

### C2: TurnSnapshot

**问题**: 当前 `SessionPersist.append()` 是逐条 append JSONL，进程崩溃时最后一条可能不完整。无 turn 级恢复点。

**方案**: 在 `SessionPersist` 中增加 turn 级快照。

```typescript
// 扩展 src/agent/session-persist.ts

interface TurnSnapshot {
  turn: number
  timestamp: number
  messageCount: number
  estimatedTokens: number
}

export class SessionPersist {
  // ... 现有代码 ...

  private snapshotPath: string  // <sessionId>.snapshots.jsonl

  /** Record a turn snapshot for recovery */
  appendTurnSnapshot(snapshot: TurnSnapshot): void {
    const line = JSON.stringify(snapshot) + '\n'
    appendFileSync(this.snapshotPath, line)
  }

  /** Load the last valid turn snapshot */
  loadLastSnapshot(): TurnSnapshot | null {
    if (!existsSync(this.snapshotPath)) return null
    const lines = readFileSync(this.snapshotPath, 'utf-8').trim().split('\n')
    for (let i = lines.length - 1; i >= 0; i--) {
      try { return JSON.parse(lines[i]!) as TurnSnapshot } catch { continue }
    }
    return null
  }

  /** Get the message index for a given turn */
  getMessageIndexForTurn(turn: number): number {
    const messages = this.load()
    let currentTurn = 0
    for (let i = 0; i < messages.length; i++) {
      if (messages[i]!.role === 'user' && typeof messages[i]!.content === 'string') {
        currentTurn++
        if (currentTurn === turn) return i + 1
      }
    }
    return messages.length
  }

  /** Load messages up to a specific turn */
  loadUpToTurn(turn: number): Message[] {
    const messages = this.load()
    let currentTurn = 0
    for (let i = 0; i < messages.length; i++) {
      if (messages[i]!.role === 'user' && typeof messages[i]!.content === 'string') {
        currentTurn++
        if (currentTurn === turn) return messages.slice(0, i + 1)
      }
    }
    return messages
  }
}
```

**集成点**: `loop.ts` 的 `onTurnComplete` 回调中追加快照。

### C3: HistoryReplayBridge

**问题**: 当前恢复会话时 `p.load()` → `session.replaceMessages()` → 无渲染。恢复的会话只显示 JSONL 原始数据，无工具卡片、无结构化展示。

**方案**: 在 `app.tsx` 的 session restore 流程中，遍历加载的 messages 重建 `staticItems`。

```typescript
// src/tui/history-replay.ts

import type { Message, ContentBlock } from '../api/types.js'
import type { LogEntry } from './log-state.js'
import { createLogEntry } from './log-state.js'

export interface ReplayResult {
  entries: LogEntry[]
  toolCount: number
  turnCount: number
}

/** Rebuild LogEntry[] from persisted messages for visual replay */
export function replayMessagesToLogEntries(messages: Message[]): ReplayResult {
  const entries: LogEntry[] = []
  let toolCount = 0
  let turnCount = 0

  for (const msg of messages) {
    if (msg.role === 'user' && typeof msg.content === 'string') {
      turnCount++
      entries.push(createLogEntry({ type: 'text', content: `> ${msg.content}` }))
      continue
    }

    if (msg.role === 'assistant' && Array.isArray(msg.content)) {
      for (const block of msg.content as ContentBlock[]) {
        if (block.type === 'text') {
          entries.push(createLogEntry({ type: 'text', content: block.text }))
        } else if (block.type === 'tool_use') {
          // Just note the tool call; result follows in next user message
          toolCount++
        }
      }
      continue
    }

    if (msg.role === 'user' && Array.isArray(msg.content)) {
      for (const block of msg.content as ContentBlock[]) {
        if (block.type === 'tool_result') {
          const isError = block.is_error ?? false
          entries.push(createLogEntry({
            type: 'tool',
            content: block.content,
            isError,
          }))
          toolCount++
        }
      }
      continue
    }
  }

  return { entries, toolCount, turnCount }
}
```

**集成点**: `app.tsx` 的 session restore 流程（`sessionPrompt === 'waiting'` 时按 `r` 恢复）。

当前代码:
```typescript
const msgs = p.load()
session.replaceMessages(msgs)
pushStatic(createLogEntry({ type: 'text', content: `Restored session...` }))
```

改为:
```typescript
const msgs = p.load()
session.loadMessages(msgs)
const { entries, toolCount, turnCount } = replayMessagesToLogEntries(msgs)
for (const entry of entries) {
  pushStatic(entry)
}
pushStatic(createLogEntry({ type: 'text', content: `Restored session ${id.slice(0,8)}... (${turnCount} turns, ${toolCount} tools)` }))
```

### C4: PromptQueue

**问题**: `handleSubmit` 直接调用 `agent.run()`，无串行化保护。

**方案**: 使用 Promise chain 串行化提交。

```typescript
// 在 App 组件中增加:
const promptQueueRef = useRef<Promise<void>>(Promise.resolve())

const handleSubmit = useCallback(async (userInput: string) => {
  const run = async () => {
    // ... 现有 handleSubmit 的全部逻辑 ...
  }

  const prev = promptQueueRef.current
  const next = prev.then(run).catch((err) => {
    // 保证链不断
    console.error('Prompt queue error:', err)
  })
  promptQueueRef.current = next
  await next
}, [/* 现有 deps */])
```

**集成点**: `app.tsx` 的 `handleSubmit` 包装。

### C5: SessionEviction

**问题**: `listSessions()` 返回所有 session 文件，无上限。

**方案**: 在 `SessionPersist` 中增加淘汰逻辑。

```typescript
// 扩展 src/agent/session-persist.ts

const MAX_SESSIONS = 50

/** Evict oldest sessions beyond the limit */
export function evictOldSessions(keepSessionId: string): string[] {
  const sessions = SessionPersist.listSessions()
  if (sessions.length <= MAX_SESSIONS) return []

  const sorted = [...sessions].sort()  // UUIDv7 时间排序
  const toEvict = sorted
    .filter(id => id !== keepSessionId)
    .slice(0, sessions.length - MAX_SESSIONS)

  for (const id of toEvict) {
    const persist = new SessionPersist(id)
    persist.delete()
    // Also clean snapshot file
    const snapPath = join(SESSION_DIR, `${id}.snapshots.jsonl`)
    try { unlinkSync(snapPath) } catch { /* ignore */ }
  }

  return toEvict
}
```

**集成点**: `main.tsx` 的 session 创建后调用 `evictOldSessions(newSessionId)`。

## 文件变更清单

| 文件 | 操作 | 职责 |
|------|------|------|
| `src/tui/block-stream-writer.ts` | 创建 | 语义断点流式写入器 |
| `src/tui/__tests__/block-stream-writer.test.ts` | 创建 | BlockStreamWriter 单元测试 |
| `src/tui/history-replay.ts` | 创建 | 消息→LogEntry 回放转换 |
| `src/tui/__tests__/history-replay.test.ts` | 创建 | replayMessagesToLogEntries 测试 |
| `src/tui/app.tsx` | 修改 | 集成 BlockStreamWriter, PromptQueue, HistoryReplayBridge |
| `src/agent/session-persist.ts` | 修改 | 增加 TurnSnapshot + SessionEviction |
| `src/agent/__tests__/session-persist.test.ts` | 修改 | 增加 turn snapshot 和 eviction 测试 |
| `src/main.tsx` | 修改 | 创建 session 后调用 evictOldSessions |

## 依赖关系

```
C1 (BlockStreamWriter) ──独立，无依赖
C2 (TurnSnapshot) ──依赖 SessionPersist 扩展
C3 (HistoryReplayBridge) ──依赖 LogEntry 类型 + Message 类型
C4 (PromptQueue) ──依赖 app.tsx handleSubmit
C5 (SessionEviction) ──依赖 SessionPersist 扩展

执行顺序：C1 → C2 → C3 → C4 → C5
(C2 和 C5 共用 session-persist.ts，先后修改)
```

## 性能考量

- **BlockStreamWriter**: `findBreakPoint` 是 O(maxChars) 字符串扫描，maxChars=800 时微不足道
- **TurnSnapshot**: 追加写入，每 turn 一次 appendFileSync（~100 bytes），IO 开销极小
- **HistoryReplayBridge**: O(messages) 重建，对于 1000 条消息的会话约 1-2ms
- **SessionEviction**: 只在创建新 session 时运行，O(sessions) 文件删除

## 测试策略

- BlockStreamWriter: 边界条件（空输入、超长行、无断点）、定时器行为、串行化发送
- TurnSnapshot: 写入/读取、损坏恢复、turn 索引计算
- HistoryReplayBridge: 各消息类型覆盖、空会话、混合消息序列
- PromptQueue: 连续提交、中间失败不阻断后续
- SessionEviction: 上限淘汰、保留当前 session、空目录
