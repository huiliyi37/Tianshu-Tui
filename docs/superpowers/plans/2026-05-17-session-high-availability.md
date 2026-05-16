# 会话高可用（Session HA）实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 将 Rivet 的会话可靠性从 append-only 无恢复提升到 turn 级快照 + 语义流式 + 恢复一致性

**架构：** 五个独立组件按序实施：BlockStreamWriter 替换固定定时 flush，TurnSnapshot 增加 turn 级恢复点，HistoryReplayBridge 恢复时走渲染管线，PromptQueue 串行化提交，SessionEviction 自动淘汰旧会话。

**技术栈：** TypeScript, Node.js fs/appendFileSync, Ink React, Vitest

**设计文档：** `docs/superpowers/specs/2026-05-17-session-high-availability-design.md`
**头脑风暴背景：** `docs/superpowers/specs/2026-05-17-session-high-availability-brainstorm.md`

---

## 文件结构

| 文件 | 操作 | 职责 |
|------|------|------|
| `src/tui/block-stream-writer.ts` | 创建 | 语义断点流式写入器，替代固定 setTimeout flush |
| `src/tui/__tests__/block-stream-writer.test.ts` | 创建 | BlockStreamWriter 单元测试 |
| `src/tui/history-replay.ts` | 创建 | 消息→LogEntry 回放转换器 |
| `src/tui/__tests__/history-replay.test.ts` | 创建 | HistoryReplayBridge 单元测试 |
| `src/tui/app.tsx` | 修改 | 集成 BlockStreamWriter, PromptQueue, HistoryReplayBridge |
| `src/agent/session-persist.ts` | 修改 | 增加 TurnSnapshot 写读 + SessionEviction |
| `src/agent/__tests__/session-persist.test.ts` | 修改 | 增加 turn snapshot 和 eviction 测试 |
| `src/main.tsx` | 修改 | 创建 session 后调用 evictOldSessions |

---

## 任务 1：BlockStreamWriter 核心

**文件：**
- 创建：`src/tui/block-stream-writer.ts`
- 测试：`src/tui/__tests__/block-stream-writer.test.ts`

- [ ] **步骤 1：编写失败的测试**

创建 `src/tui/__tests__/block-stream-writer.test.ts`：

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { BlockStreamWriter, type BlockStreamConfig } from '../block-stream-writer.js'

describe('BlockStreamWriter', () => {
  let emitted: string[]
  let writer: BlockStreamWriter

  const config: BlockStreamConfig = { minChars: 10, maxChars: 20, idleMs: 50 }

  beforeEach(() => {
    vi.useFakeTimers()
    emitted = []
    writer = new BlockStreamWriter(config, (text) => { emitted.push(text) })
  })

  it('emits when buffer exceeds maxChars at a break point', () => {
    writer.push('A'.repeat(25))
    // Should have emitted because > maxChars (20)
    expect(emitted.length).toBeGreaterThanOrEqual(1)
  })

  it('does not emit when buffer is below minChars', () => {
    writer.push('short')
    expect(emitted).toHaveLength(0)
  })

  it('emits remaining on flush', async () => {
    writer.push('hello')
    expect(emitted).toHaveLength(0)
    await writer.flush()
    expect(emitted).toEqual(['hello'])
  })

  it('emits on idle timeout', () => {
    writer.push('above min chars')
    expect(emitted).toHaveLength(0)
    vi.advanceTimersByTime(51)
    expect(emitted.length).toBeGreaterThanOrEqual(1)
  })

  it('prefers paragraph break over newline', () => {
    // Build text with paragraph break inside min-max range
    const text = 'A'.repeat(8) + '\n\n' + 'B'.repeat(8)
    writer.push(text) // 8 + 2 + 8 = 18, above minChars=10
    // Should split at paragraph boundary
    expect(emitted.length).toBeGreaterThanOrEqual(1)
    if (emitted.length > 0) {
      expect(emitted[0]).toContain('A')
    }
  })

  it('handles empty chunks', () => {
    writer.push('')
    expect(emitted).toHaveLength(0)
  })

  it('serializes blocks in order', async () => {
    const order: string[] = []
    const slowWriter = new BlockStreamWriter(
      { minChars: 5, maxChars: 10, idleMs: 100 },
      (text) => { order.push(text) },
    )
    slowWriter.push('A'.repeat(15))
    slowWriter.push('B'.repeat(15))
    await slowWriter.flush()
    expect(order.length).toBeGreaterThanOrEqual(2)
    // First emission should start with A, second with B
    expect(order[0]![0]).toBe('A')
    expect(order[1]![0]).toBe('B')
  })

  it('flush with empty buffer does not call onBlock', async () => {
    await writer.flush()
    expect(emitted).toHaveLength(0)
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npx vitest run src/tui/__tests__/block-stream-writer.test.ts`
预期：FAIL — `Cannot find module '../block-stream-writer.js'`

- [ ] **步骤 3：编写 BlockStreamWriter 实现**

创建 `src/tui/block-stream-writer.ts`：

```typescript
export interface BlockStreamConfig {
  minChars: number
  maxChars: number
  idleMs: number
}

const DEFAULT_CONFIG: BlockStreamConfig = {
  minChars: 300,
  maxChars: 800,
  idleMs: 1200,
}

export class BlockStreamWriter {
  private buffer = ''
  private idleTimer: ReturnType<typeof setTimeout> | null = null
  private sending: Promise<void> = Promise.resolve()
  private readonly config: BlockStreamConfig
  private readonly onBlock: (text: string) => void

  constructor(config: Partial<BlockStreamConfig>, onBlock: (text: string) => void) {
    this.config = { ...DEFAULT_CONFIG, ...config }
    this.onBlock = onBlock
  }

  push(chunk: string): void {
    if (!chunk) return
    this.buffer += chunk
    this.resetIdleTimer()
    this.checkEmit()
  }

  async flush(): Promise<void> {
    this.clearIdleTimer()
    if (!this.buffer) return
    const text = this.buffer
    this.buffer = ''
    this.enqueue(text)
    await this.sending
  }

  private resetIdleTimer(): void {
    this.clearIdleTimer()
    this.idleTimer = setTimeout(() => { this.flush() }, this.config.idleMs)
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer)
      this.idleTimer = null
    }
  }

  private checkEmit(): void {
    if (this.buffer.length < this.config.minChars) return

    if (this.buffer.length >= this.config.maxChars) {
      const pos = this.findBreakPoint(this.buffer, this.config.maxChars)
      const block = this.buffer.slice(0, pos)
      this.buffer = this.buffer.slice(pos)
      this.enqueue(block)
      // After splitting, check if remaining buffer still exceeds thresholds
      if (this.buffer.length >= this.config.maxChars) {
        this.checkEmit()
      }
      return
    }

    // Between min and max: look for paragraph boundary
    const paraIdx = this.buffer.lastIndexOf('\n\n')
    if (paraIdx !== -1 && paraIdx >= Math.floor(this.config.minChars * 0.5)) {
      const block = this.buffer.slice(0, paraIdx + 2)
      this.buffer = this.buffer.slice(paraIdx + 2)
      this.enqueue(block)
    }
  }

  private findBreakPoint(text: string, maxPos: number): number {
    const para = text.lastIndexOf('\n\n', maxPos)
    if (para !== -1 && para > Math.floor(maxPos * 0.3)) return para + 2
    const nl = text.lastIndexOf('\n', maxPos)
    if (nl !== -1 && nl > Math.floor(maxPos * 0.3)) return nl + 1
    const sp = text.lastIndexOf(' ', maxPos)
    if (sp !== -1 && sp > Math.floor(maxPos * 0.3)) return sp + 1
    return maxPos
  }

  private enqueue(text: string): void {
    this.sending = this.sending.then(() => this.onBlock(text))
  }
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`npx vitest run src/tui/__tests__/block-stream-writer.test.ts`
预期：PASS（所有 8 个测试）

- [ ] **步骤 5：运行类型检查**

运行：`npx tsc --noEmit`
预期：无错误

- [ ] **步骤 6：Commit**

```bash
git add src/tui/block-stream-writer.ts src/tui/__tests__/block-stream-writer.test.ts
git commit -m "feat(tui): add BlockStreamWriter with semantic break points"
```

---

## 任务 2：TurnSnapshot

**文件：**
- 修改：`src/agent/session-persist.ts`（增加 TurnSnapshot 类型和方法）
- 修改：`src/agent/__tests__/session-persist.test.ts`（增加快照测试）

- [ ] **步骤 1：编写失败的测试**

在 `src/agent/__tests__/session-persist.test.ts` 末尾追加：

```typescript
describe('TurnSnapshot', () => {
  const tmpDir = join(tmpdir(), `rivet-snap-test-${Date.now()}`)

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('writes and reads turn snapshots', () => {
    const sp = new SessionPersist('snap-test-1')
    // Override paths for testing
    const persist = Object.create(sp) as SessionPersist
    persist.filePath = join(tmpDir, 'snap-test-1.jsonl')
    persist.metadataPath = join(tmpDir, 'snap-test-1.meta.json')
    persist.snapshotPath = join(tmpDir, 'snap-test-1.snapshots.jsonl')
    persist.sessionId = 'snap-test-1'

    persist.appendTurnSnapshot({ turn: 1, timestamp: 1000, messageCount: 3, estimatedTokens: 500 })
    persist.appendTurnSnapshot({ turn: 2, timestamp: 2000, messageCount: 6, estimatedTokens: 1000 })

    const last = persist.loadLastSnapshot()
    expect(last).toEqual({ turn: 2, timestamp: 2000, messageCount: 6, estimatedTokens: 1000 })
  })

  it('returns null when no snapshots exist', () => {
    const sp = new SessionPersist('snap-empty-test')
    const persist = Object.create(sp) as SessionPersist
    persist.snapshotPath = join(tmpDir, 'snap-empty.snapshots.jsonl')
    persist.sessionId = 'snap-empty-test'

    expect(persist.loadLastSnapshot()).toBeNull()
  })

  it('skips corrupted snapshot lines', () => {
    const sp = new SessionPersist('snap-corrupt-test')
    const persist = Object.create(sp) as SessionPersist
    persist.snapshotPath = join(tmpDir, 'snap-corrupt.snapshots.jsonl')
    persist.sessionId = 'snap-corrupt-test'

    // Write valid then corrupt then valid
    persist.appendTurnSnapshot({ turn: 1, timestamp: 1000, messageCount: 3, estimatedTokens: 500 })
    writeFileSync(persist.snapshotPath, 'corrupted\n', { flag: 'a' })
    persist.appendTurnSnapshot({ turn: 3, timestamp: 3000, messageCount: 9, estimatedTokens: 1500 })

    const last = persist.loadLastSnapshot()
    expect(last).toEqual({ turn: 3, timestamp: 3000, messageCount: 9, estimatedTokens: 1500 })
  })

  it('loads messages up to a specific turn', () => {
    const sp = new SessionPersist('snap-turn-test')
    const persist = Object.create(sp) as SessionPersist
    persist.filePath = join(tmpDir, 'snap-turn.jsonl')
    persist.metadataPath = join(tmpDir, 'snap-turn.meta.json')
    persist.snapshotPath = join(tmpDir, 'snap-turn.snapshots.jsonl')
    persist.sessionId = 'snap-turn-test'

    // Write 3 turns worth of messages
    persist.append({ role: 'user', content: 'turn 1' } as any)
    persist.append({ role: 'assistant', content: [{ type: 'text', text: 'reply 1' }] } as any)
    persist.append({ role: 'user', content: 'turn 2' } as any)
    persist.append({ role: 'assistant', content: [{ type: 'text', text: 'reply 2' }] } as any)
    persist.append({ role: 'user', content: 'turn 3' } as any)
    persist.append({ role: 'assistant', content: [{ type: 'text', text: 'reply 3' }] } as any)

    const upTo2 = persist.loadUpToTurn(2)
    // Should include turn 1 and turn 2 messages but not turn 3
    const userTurns = upTo2.filter(m => m.role === 'user' && typeof m.content === 'string')
    expect(userTurns).toHaveLength(2)
  })
})
```

需要在测试文件顶部确认已有导入，如缺少 `writeFileSync` 则添加：
```typescript
import { writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { rmSync } from 'fs'
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npx vitest run src/agent/__tests__/session-persist.test.ts -t TurnSnapshot`
预期：FAIL — `persist.appendTurnSnapshot is not a function`

- [ ] **步骤 3：实现 TurnSnapshot**

在 `src/agent/session-persist.ts` 中：

1. 在文件顶部 `appendFile` 导入旁增加 `appendFileSync`：
```typescript
import { appendFile, appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, readdirSync } from 'fs'
```

2. 在 `SessionPersist` 类中，构造函数里增加 `snapshotPath`：
```typescript
constructor(sessionId: string) {
  assertValidSessionId(sessionId)
  ensureDir(SESSION_DIR)
  this.sessionId = sessionId
  this.filePath = join(SESSION_DIR, `${sessionId}.jsonl`)
  this.metadataPath = join(SESSION_DIR, `${sessionId}.meta.json`)
  this.snapshotPath = join(SESSION_DIR, `${sessionId}.snapshots.jsonl`)
}
```

3. 增加 `snapshotPath` 属性声明（在 `private metadataPath` 旁）：
```typescript
private snapshotPath: string
```

4. 增加方法：
```typescript
appendTurnSnapshot(snapshot: { turn: number; timestamp: number; messageCount: number; estimatedTokens: number }): void {
  const line = JSON.stringify(snapshot) + '\n'
  try {
    appendFileSync(this.snapshotPath, line)
  } catch {
    // Ignore write failures — snapshots are best-effort
  }
}

loadLastSnapshot(): { turn: number; timestamp: number; messageCount: number; estimatedTokens: number } | null {
  if (!existsSync(this.snapshotPath)) return null
  try {
    const lines = readFileSync(this.snapshotPath, 'utf-8').trim().split('\n')
    for (let i = lines.length - 1; i >= 0; i--) {
      try { return JSON.parse(lines[i]!) } catch { continue }
    }
  } catch { /* ignore */ }
  return null
}

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
```

- [ ] **步骤 4：运行测试验证通过**

运行：`npx vitest run src/agent/__tests__/session-persist.test.ts -t TurnSnapshot`
预期：PASS（4 个测试）

- [ ] **步骤 5：运行全量测试**

运行：`npx vitest run`
预期：所有现有测试继续通过

- [ ] **步骤 6：Commit**

```bash
git add src/agent/session-persist.ts src/agent/__tests__/session-persist.test.ts
git commit -m "feat(agent): add turn-level snapshots for crash recovery"
```

---

## 任务 3：HistoryReplayBridge

**文件：**
- 创建：`src/tui/history-replay.ts`
- 测试：`src/tui/__tests__/history-replay.test.ts`

- [ ] **步骤 1：编写失败的测试**

创建 `src/tui/__tests__/history-replay.test.ts`：

```typescript
import { describe, it, expect } from 'vitest'
import { replayMessagesToLogEntries } from '../history-replay.js'
import type { Message } from '../../api/types.js'

describe('replayMessagesToLogEntries', () => {
  it('handles empty messages', () => {
    const result = replayMessagesToLogEntries([])
    expect(result.entries).toHaveLength(0)
    expect(result.turnCount).toBe(0)
    expect(result.toolCount).toBe(0)
  })

  it('replays user text messages', () => {
    const messages: Message[] = [
      { role: 'user', content: 'hello' },
    ]
    const result = replayMessagesToLogEntries(messages)
    expect(result.entries).toHaveLength(1)
    expect(result.entries[0]!.content).toBe('> hello')
    expect(result.turnCount).toBe(1)
  })

  it('replays assistant text blocks', () => {
    const messages: Message[] = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: [{ type: 'text', text: 'Hello!' }] },
    ]
    const result = replayMessagesToLogEntries(messages)
    // user prompt + assistant text
    expect(result.entries).toHaveLength(2)
    expect(result.entries[1]!.content).toBe('Hello!')
  })

  it('replays tool results with error flag', () => {
    const messages: Message[] = [
      { role: 'user', content: 'do it' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'bash', input: { command: 'ls' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'file1.ts\nfile2.ts' }] },
    ]
    const result = replayMessagesToLogEntries(messages)
    // user prompt + tool_result (tool_use is counted but not added as entry)
    expect(result.entries).toHaveLength(2)
    expect(result.entries[1]!.type).toBe('tool')
    expect(result.entries[1]!.isError).toBeFalsy()
    expect(result.toolCount).toBe(1)
  })

  it('replays error tool results', () => {
    const messages: Message[] = [
      { role: 'user', content: 'fail' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't2', name: 'bash', input: { command: 'bad' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't2', content: 'command not found', is_error: true }] },
    ]
    const result = replayMessagesToLogEntries(messages)
    expect(result.entries[1]!.isError).toBe(true)
  })

  it('handles multi-turn conversation', () => {
    const messages: Message[] = [
      { role: 'user', content: 'turn 1' },
      { role: 'assistant', content: [{ type: 'text', text: 'reply 1' }] },
      { role: 'user', content: 'turn 2' },
      { role: 'assistant', content: [{ type: 'text', text: 'reply 2' }] },
    ]
    const result = replayMessagesToLogEntries(messages)
    expect(result.turnCount).toBe(2)
    expect(result.entries).toHaveLength(4) // 2 prompts + 2 replies
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npx vitest run src/tui/__tests__/history-replay.test.ts`
预期：FAIL — `Cannot find module '../history-replay.js'`

- [ ] **步骤 3：实现 HistoryReplayBridge**

创建 `src/tui/history-replay.ts`：

```typescript
import type { Message, ContentBlock, ContentBlockToolResult } from '../api/types.js'
import { createLogEntry, type LogEntry } from './log-state.js'

export interface ReplayResult {
  entries: LogEntry[]
  toolCount: number
  turnCount: number
}

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
          toolCount++
        }
      }
      continue
    }

    if (msg.role === 'user' && Array.isArray(msg.content)) {
      for (const block of msg.content as ContentBlock[]) {
        if (block.type === 'tool_result') {
          const tb = block as ContentBlockToolResult
          entries.push(createLogEntry({
            type: 'tool',
            content: tb.content,
            isError: tb.is_error ?? false,
          }))
          toolCount++
        }
      }
    }
  }

  return { entries, toolCount, turnCount }
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`npx vitest run src/tui/__tests__/history-replay.test.ts`
预期：PASS（6 个测试）

- [ ] **步骤 5：运行类型检查**

运行：`npx tsc --noEmit`
预期：无错误

- [ ] **步骤 6：Commit**

```bash
git add src/tui/history-replay.ts src/tui/__tests__/history-replay.test.ts
git commit -m "feat(tui): add HistoryReplayBridge for session restore rendering"
```

---

## 任务 4：集成 BlockStreamWriter 到 App

**文件：**
- 修改：`src/tui/app.tsx`

- [ ] **步骤 1：添加 BlockStreamWriter 导入和初始化**

在 `src/tui/app.tsx` 顶部导入区增加：

```typescript
import { BlockStreamWriter } from './block-stream-writer.js'
```

在 App 组件内，替换 stream 相关的 ref 和 state：

找到这几行（约 155-160 行区域）：
```typescript
const streamBuf = useRef('')
const lastFlushedStream = useRef('')
const streamTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
```

替换为：
```typescript
const blockWriterRef = useRef<BlockStreamWriter | null>(null)
```

- [ ] **步骤 2：修改 handleSubmit 初始化**

在 `handleSubmit` 函数开头（约 296 行区域），找到：
```typescript
streamBuf.current = ''
```
及后续两行 `lastFlushedStream.current = ''` 和 `streamTimer.current` 的清理。

替换 stream 相关清理为：
```typescript
if (blockWriterRef.current) {
  await blockWriterRef.current.flush()
}
blockWriterRef.current = new BlockStreamWriter({}, (text) => {
  setStreamingText(prev => prev + text)
})
```

同时移除 `for (const ref of [streamTimer, thinkTimer, toolTimer])` 中 `streamTimer` 的引用。清理逻辑改为：
```typescript
for (const ref of [thinkTimer, toolTimer]) {
  if (ref.current) {
    clearTimeout(ref.current)
    ref.current = null
  }
}
```

- [ ] **步骤 3：修改 onTextDelta 回调**

在 `agent.run()` 的 callbacks 中，找到：
```typescript
onTextDelta: (text) => {
  streamBuf.current += text
  if (!streamTimer.current) {
    streamTimer.current = setTimeout(flushStream, STREAM_FLUSH_MS)
  }
},
```

替换为：
```typescript
onTextDelta: (text) => {
  blockWriterRef.current?.push(text)
},
```

- [ ] **步骤 4：修改 onTurnComplete 回调**

在 `onTurnComplete` 中，找到 stream finalization 部分：
```typescript
if (streamTimer.current) {
  clearTimeout(streamTimer.current)
  streamTimer.current = null
}
const finalText = streamBuf.current
if (finalText) {
  pushStatic(createLogEntry({ type: 'text', content: finalText }))
}
streamBuf.current = ''
lastFlushedStream.current = ''
setStreamingText('')
```

替换为：
```typescript
const writer = blockWriterRef.current
if (writer) {
  await writer.flush()
  const finalText = streamingText
  if (finalText) {
    pushStatic(createLogEntry({ type: 'text', content: finalText }))
  }
}
blockWriterRef.current = null
setStreamingText('')
```

注意：`onTurnComplete` 现在需要是 async。检查 `AgentCallbacks.onTurnComplete` 类型是否支持 async。如果回调类型不允许 async，则在 flush 完成后同步设置状态，改用 `.then()` 模式：

```typescript
// Alternative if onTurnComplete cannot be async
const writer = blockWriterRef.current
if (writer) {
  writer.flush().then(() => {
    blockWriterRef.current = null
    setStreamingText('')
  })
  const finalText = streamingText
  if (finalText) {
    pushStatic(createLogEntry({ type: 'text', content: finalText }))
  }
}
```

- [ ] **步骤 5：清理不再使用的变量**

移除以下不再使用的声明：
- `const STREAM_FLUSH_MS = 80` 常量
- `const streamBuf = useRef('')`
- `const lastFlushedStream = useRef('')`
- `const streamTimer = useRef<...>(null)`
- `flushStream` callback 函数
- `streamBuf` 和 `lastFlushedStream` 在 handleSubmit 中的重置

检查所有 `streamTimer` 引用并移除。

- [ ] **步骤 6：运行类型检查**

运行：`npx tsc --noEmit`
预期：无错误

- [ ] **步骤 7：运行全量测试**

运行：`npx vitest run`
预期：所有测试通过

- [ ] **步骤 8：Commit**

```bash
git add src/tui/app.tsx
git commit -m "feat(tui): integrate BlockStreamWriter replacing fixed-interval flush"
```

---

## 任务 5：集成 HistoryReplayBridge + TurnSnapshot 到 App

**文件：**
- 修改：`src/tui/app.tsx`（session restore 流程）
- 修改：`src/agent/loop.ts`（turn 完成时记录快照）

- [ ] **步骤 1：添加 HistoryReplayBridge 导入**

在 `src/tui/app.tsx` 顶部导入区增加：

```typescript
import { replayMessagesToLogEntries } from './history-replay.js'
```

- [ ] **步骤 2：修改 session restore 流程**

在 `useInput` 回调中找到 session restore 逻辑（约 263-269 行）：

```typescript
if (_input === 'r' && sessions.length > 0) {
  const p = new SessionPersist(sessions[0]!)
  const msgs = p.load()
  session.replaceMessages(msgs)
  pushStatic(createLogEntry({ type: 'text', content: `Restored session ${sessions[0]!.slice(0, 8)}... (${msgs.length} messages)` }))
}
```

替换为：

```typescript
if (_input === 'r' && sessions.length > 0) {
  const id = sessions[0]!
  const p = new SessionPersist(id)
  const msgs = p.load()
  session.loadMessages(msgs)
  const { entries, toolCount, turnCount } = replayMessagesToLogEntries(msgs)
  for (const entry of entries) {
    pushStatic(entry)
  }
  const tcPct = Math.min(session.getEstimatedTokens() / maxTokens, 1)
  setCacheHitRate(session.getCacheHitRate())
  setSummaryState(prev => ({ ...prev, contextPct: tcPct, tokenHistory: pushTokenHistory(tcPct) }))
  pushStatic(createLogEntry({ type: 'text', content: `Restored session ${id.slice(0, 8)}... (${turnCount} turns, ${toolCount} tools)` }))
}
```

- [ ] **步骤 3：在 loop.ts 中记录 turn 快照**

在 `src/agent/loop.ts` 的 `run` 方法中，找到 `callbacks.onTurnComplete` 调用的位置（约 465 行和 481 行）。在 `onTurnComplete` 之前的适当位置（例如 `continue` 之前和 `break` 之前），增加快照记录。

找到两处 `callbacks.onTurnComplete(...)` 调用：

**第一处**（有工具的 turn，约 465 行 `continue` 之前）：
```typescript
// 在 callbacks.onTurnComplete(...) 之前增加：
if (this.config.sessionId) {
  const persist = new SessionPersist(this.config.sessionId)
  persist.appendTurnSnapshot({
    turn: this.session.getTurnCount(),
    timestamp: Date.now(),
    messageCount: this.session.getMessages().length,
    estimatedTokens: this.session.getEstimatedTokens(),
  })
}
```

**第二处**（无工具的最终 turn，约 481 行 `break` 之前）：
增加相同的快照记录代码。

注意：需要确认 `SessionPersist` 已在 loop.ts 中导入。检查文件顶部，如果缺少则添加：
```typescript
import { SessionPersist } from './session-persist.js'
```

- [ ] **步骤 4：运行类型检查**

运行：`npx tsc --noEmit`
预期：无错误

- [ ] **步骤 5：运行全量测试**

运行：`npx vitest run`
预期：所有测试通过

- [ ] **步骤 6：Commit**

```bash
git add src/tui/app.tsx src/agent/loop.ts
git commit -m "feat: integrate HistoryReplayBridge + TurnSnapshot for session recovery"
```

---

## 任务 6：PromptQueue

**文件：**
- 修改：`src/tui/app.tsx`

- [ ] **步骤 1：添加 promptQueueRef**

在 App 组件的 ref 声明区域增加：

```typescript
const promptQueueRef = useRef<Promise<void>>(Promise.resolve())
```

- [ ] **步骤 2：包装 handleSubmit**

将现有 `handleSubmit` 的 useCallback 内部逻辑包装在 Promise chain 中。

找到 `const handleSubmit = useCallback(async (userInput: string) => {`（约 295 行）。

在函数体最外层，将所有现有逻辑包装到内部 `run` 函数中：

```typescript
const handleSubmit = useCallback((userInput: string) => {
  const run = async () => {
    // ... 所有现有的 handleSubmit 逻辑不变，从 setIsStreaming(true) 开始 ...
  }

  promptQueueRef.current = promptQueueRef.current
    .then(run)
    .catch((err: Error) => {
      // 保证链不断
      pushStatic(createLogEntry({ type: 'text', content: `Queue error: ${err.message}` }))
      setIsStreaming(false)
    })
}, [agent, session, pushStatic, flushThink, flushTools, model, maxTokens, availableModels, onModelSwitch, currentSessionId, cost, cacheHitRate, setVerbose, setAutoSafe, pushTokenHistory])
```

关键变化：
1. `handleSubmit` 从 `async` 变为同步函数（返回 void 而非 Promise）
2. 内部逻辑包装到 `run` async 函数
3. 通过 `promptQueueRef.current = prev.then(run).catch(...)` 串行化
4. catch 中保证 setIsStreaming(false) 恢复 UI 状态

- [ ] **步骤 3：验证编译**

运行：`npx tsc --noEmit`
预期：无错误（handleSubmit 的调用点不需要 await，因为它现在返回 void）

- [ ] **步骤 4：运行全量测试**

运行：`npx vitest run`
预期：所有测试通过

- [ ] **步骤 5：Commit**

```bash
git add src/tui/app.tsx
git commit -m "feat(tui): add PromptQueue to serialize concurrent submissions"
```

---

## 任务 7：SessionEviction

**文件：**
- 修改：`src/agent/session-persist.ts`
- 修改：`src/main.tsx`
- 修改：`src/agent/__tests__/session-persist.test.ts`

- [ ] **步骤 1：编写失败的测试**

在 `src/agent/__tests__/session-persist.test.ts` 末尾追加：

```typescript
describe('SessionEviction', () => {
  const evictDir = join(tmpdir(), `rivet-evict-test-${Date.now()}`)

  beforeAll(() => {
    mkdirSync(evictDir, { recursive: true })
  })

  afterAll(() => {
    rmSync(evictDir, { recursive: true, force: true })
  })

  it('does not evict when below limit', () => {
    // Create fewer sessions than limit
    for (let i = 0; i < 3; i++) {
      writeFileSync(join(evictDir, `session-${i}.jsonl`), '{}\n')
    }
    const evicted = evictOldSessionsInternal(evictDir, 'session-keep', 50)
    expect(evicted).toHaveLength(0)
  })

  it('evicts oldest sessions beyond limit keeping current', () => {
    for (let i = 0; i < 12; i++) {
      writeFileSync(join(evictDir, `ev-${i}.jsonl`), '{}\n')
    }
    writeFileSync(join(evictDir, 'ev-keep.jsonl'), '{}\n')
    const evicted = evictOldSessionsInternal(evictDir, 'ev-keep', 10)
    // 13 total - 10 limit = 3 should be evicted
    expect(evicted.length).toBe(3)
    expect(evicted).not.toContain('ev-keep')
    // Keep file should still exist
    expect(existsSync(join(evictDir, 'ev-keep.jsonl'))).toBe(true)
  })

  it('handles empty directory', () => {
    const emptyDir = join(evictDir, 'empty')
    mkdirSync(emptyDir, { recursive: true })
    const evicted = evictOldSessionsInternal(emptyDir, 'none', 10)
    expect(evicted).toHaveLength(0)
  })
})
```

需要在测试文件导入区增加对 `evictOldSessionsInternal` 的导入。同时，需要在 session-persist.ts 中导出一个接受目录参数的内部函数用于测试。

- [ ] **步骤 2：运行测试验证失败**

运行：`npx vitest run src/agent/__tests__/session-persist.test.ts -t SessionEviction`
预期：FAIL — `evictOldSessionsInternal is not defined`

- [ ] **步骤 3：实现 SessionEviction**

在 `src/agent/session-persist.ts` 底部增加：

```typescript
const MAX_SESSIONS = 50

export function evictOldSessions(keepSessionId: string): string[] {
  return evictOldSessionsInternal(SESSION_DIR, keepSessionId, MAX_SESSIONS)
}

export function evictOldSessionsInternal(dir: string, keepSessionId: string, limit: number): string[] {
  ensureDir(dir)
  let sessions: string[]
  try {
    sessions = readdirSync(dir)
      .filter((f: string) => f.endsWith('.jsonl'))
      .map((f: string) => f.replace('.jsonl', ''))
  } catch {
    return []
  }

  if (sessions.length <= limit) return []

  const sorted = [...sessions].sort()
  const toEvict = sorted
    .filter(id => id !== keepSessionId)
    .slice(0, sessions.length - limit)

  for (const id of toEvict) {
    try { unlinkSync(join(dir, `${id}.jsonl`)) } catch { /* ignore */ }
    try { unlinkSync(join(dir, `${id}.meta.json`)) } catch { /* ignore */ }
    try { unlinkSync(join(dir, `${id}.snapshots.jsonl`)) } catch { /* ignore */ }
    try { unlinkSync(join(dir, `${id}.memory.json`)) } catch { /* ignore */ }
    try { unlinkSync(join(dir, `${id}.claims.jsonl`)) } catch { /* ignore */ }
  }

  return toEvict
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`npx vitest run src/agent/__tests__/session-persist.test.ts -t SessionEviction`
预期：PASS（3 个测试）

- [ ] **步骤 5：集成到 main.tsx**

在 `src/main.tsx` 中找到 session 创建逻辑。在创建新 session 后（`new SessionPersist(sessionId)` 之后），增加：

```typescript
import { evictOldSessions } from './agent/session-persist.js'
// ... 在 session 创建后 ...
evictOldSessions(sessionId)
```

具体位置需确认 main.tsx 的 session 创建代码。搜索 `SessionPersist` 的使用位置来确定。

- [ ] **步骤 6：运行全量测试**

运行：`npx vitest run`
预期：所有测试通过

- [ ] **步骤 7：运行类型检查**

运行：`npx tsc --noEmit`
预期：无错误

- [ ] **步骤 8：Commit**

```bash
git add src/agent/session-persist.ts src/agent/__tests__/session-persist.test.ts src/main.tsx
git commit -m "feat(agent): add session eviction with 50 session limit"
```

---

## 任务 8：最终验证 + 文档更新

**文件：**
- 修改：`README.md`（更新 architecture section）
- 修改：`CHANGELOG.md`（新增条目）

- [ ] **步骤 1：运行完整测试套件**

运行：`npx vitest run`
预期：所有测试通过，0 failures

- [ ] **步骤 2：运行类型检查**

运行：`npx tsc --noEmit`
预期：无错误

- [ ] **步骤 3：更新 README architecture section**

在 `README.md` 的 Architecture / Key paths 部分增加：

```markdown
- `src/tui/block-stream-writer.ts` — Semantic break-point streaming for text rendering
- `src/tui/history-replay.ts` — Session history visual replay bridge
```

在现有 session 相关路径说明中补充：

```markdown
- `src/agent/session-persist.ts` — Session persistence (JSONL + turn snapshots + eviction)
```

- [ ] **步骤 4：更新 CHANGELOG**

在 `CHANGELOG.md` 顶部增加：

```markdown
## Session High Availability (Wave 12)

### New Features
- **BlockStreamWriter**: Semantic break-point streaming replaces fixed 80ms flush — respects paragraph/newline boundaries for coherent long-text rendering
- **TurnSnapshot**: Turn-level JSONL snapshots for crash recovery — survive process crashes without data loss
- **HistoryReplayBridge**: Restored sessions now render through the full visual pipeline (tool cards, structured output) — no more raw JSON display
- **PromptQueue**: Serialized prompt submission prevents race conditions on rapid input
- **SessionEviction**: Automatic LRU eviction caps sessions at 50 — prevents unbounded disk growth

### Inspired By
- Qwen Code BlockStreamer (semantic streaming), Session snapshots, HistoryReplayer
- OpenCode session-cache (LRU eviction), terminal-writer (batch scheduling)
```

- [ ] **步骤 5：Final commit**

```bash
git add README.md CHANGELOG.md
git commit -m "docs: update README + CHANGELOG for Session HA (Wave 12)"
```

---

## 自检清单

### 规格覆盖度

| 规格需求 | 对应任务 |
|---------|---------|
| C1 BlockStreamWriter 语义断点 | 任务 1（创建）+ 任务 4（集成） |
| C2 TurnSnapshot turn 级快照 | 任务 2（创建）+ 任务 5（集成到 loop） |
| C3 HistoryReplayBridge 恢复渲染 | 任务 3（创建）+ 任务 5（集成到 app） |
| C4 PromptQueue 串行化 | 任务 6 |
| C5 SessionEviction 淘汰 | 任务 7 |
| 类型检查 | 每个任务均有 `tsc --noEmit` 步骤 |
| 全量测试 | 每个任务均有 `vitest run` 步骤 |
| 文档更新 | 任务 8 |

### 占位符扫描

- 无 "TODO"、"TBD"、"待定" 出现
- 每个代码步骤包含完整代码
- 每个测试步骤包含完整测试代码
- 所有文件路径精确

### 类型一致性

- `BlockStreamWriter` 构造函数签名：`(config: Partial<BlockStreamConfig>, onBlock: (text: string) => void)` — 任务 1 定义，任务 4 使用
- `replayMessagesToLogEntries(messages: Message[]): ReplayResult` — 任务 3 定义，任务 5 使用
- `appendTurnSnapshot` 参数类型：`{ turn: number; timestamp: number; messageCount: number; estimatedTokens: number }` — 任务 2 定义，任务 5 使用
- `evictOldSessions(keepSessionId: string): string[]` — 任务 7 定义，任务 7 使用
