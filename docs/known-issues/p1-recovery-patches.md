# P1 Recovery 修复补丁

> **状态：✅ 全部已落地（2026-06-06 确认）**
>
> - 压#7: `session-persist.ts:200,204` — `repairOrphanToolCalls()` (commit `edd2935`)
> - 中#5: `loop.ts:141,561,677-694,708,725,869` — `_turnInterruptCount` + `detectPendingTools()` + `computeSessionIntegrity()`
> - 网#1: `openai-client.ts:79,245,448-451,529,604` — `_textAccum` + `tryParseToolJsonFromContent()`
>
> 以下设计记录保留供参考。

以下 3 个修复因共享工作区并发编辑冲突未能直接应用到代码。
变更以 diff 形式记录，可在无并发编辑时通过 `git apply` 应用。

---

## 压#7: session-persist 孤立 tool_call 配对校验

**文件:** `src/agent/session-persist.ts`
**位置:** `loadOai()` 方法末尾，`return messages` 之前

将:
```ts
    return messages
```
改为:
```ts
    // 压#7: Validate tool_call/tool_result pairing
    return this.repairOrphanToolCalls(messages)
```

在类中新增方法 (在 `compact()` 之前):
```ts
  /**
   * 压#7: Remove orphan tool_use blocks that have no matching tool_result,
   * and orphan tool_result blocks that reference non-existent tool_use.
   * Prevents providers from rejecting the entire request.
   */
  private repairOrphanToolCalls(messages: OaiMessage[]): OaiMessage[] {
    const toolCallIds = new Set<string>()
    const toolResultIndices = new Map<string, number>() // id → message index

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i]!
      if (msg.role === 'assistant' && msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          if (tc.id) toolCallIds.add(tc.id)
        }
      }
      if (msg.role === 'tool' && msg.tool_call_id) {
        toolResultIndices.set(msg.tool_call_id, i)
      }
    }

    const orphanResultIdx = new Set<number>()
    for (const [id, idx] of toolResultIndices) {
      if (!toolCallIds.has(id)) orphanResultIdx.add(idx)
    }

    return messages.filter((msg, idx) => {
      if (orphanResultIdx.has(idx)) return false
      if (msg.role === 'assistant' && msg.tool_calls) {
        const valid = msg.tool_calls.filter(tc => tc.id && toolResultIndices.has(tc.id))
        if (valid.length === 0) {
          const { tool_calls: _, ...rest } = msg
          Object.assign(msg, rest)
        } else if (valid.length < msg.tool_calls.length) {
          msg.tool_calls = valid
        }
      }
      return true
    })
  }
```

---

## 中#5: recovery-trigger 接真实数据

**文件:** `src/agent/loop.ts`

### 1. 添加计数器字段 (在 `abortController` 之后):
```ts
  abortController: AbortController | null = null
  /** Count of user interrupts within the current turn. */
  private _turnInterruptCount = 0
```

### 2. 在 `abort()` 中递增:
```ts
  abort(): void {
    this._turnInterruptCount++
    this.abortController?.abort()
```

### 3. 在 `initializeRun()` 中重置 (在 `this.abortController = new AbortController()` 之后):
```ts
    this.abortController = new AbortController()
    this._turnInterruptCount = 0
```

### 4. 替换 `refreshReliabilityDecision()` 中的硬编码值:

将 `interruptCountThisTurn: 0` 改为 `interruptCountThisTurn: this._turnInterruptCount`

将 `hasPendingTools: false` 改为 `hasPendingTools: this.detectPendingTools()`

将整个 `integrity: { ... }` 块替换为 `integrity: this.computeSessionIntegrity()`

### 5. 在类中新增两个方法 (在 `refreshReliabilityDecision` 之后):
```ts
  private detectPendingTools(): boolean {
    const msgs = this.session.getMessages()
    const pendingIds = new Set<string>()
    for (const msg of msgs) {
      if (msg.role === 'assistant' && msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          if (tc.id) pendingIds.add(tc.id)
        }
      }
      if (msg.role === 'tool' && msg.tool_call_id) {
        pendingIds.delete(msg.tool_call_id)
      }
    }
    return pendingIds.size > 0
  }

  private computeSessionIntegrity() {
    const msgs = this.session.getMessages()
    const toolCallIds = new Set<string>()
    const toolResultIds = new Set<string>()
    for (const msg of msgs) {
      if (msg.role === 'assistant' && msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          if (tc.id) toolCallIds.add(tc.id)
        }
      }
      if (msg.role === 'tool' && msg.tool_call_id) {
        toolResultIds.add(msg.tool_call_id)
      }
    }
    return {
      orphanToolUseCount: [...toolCallIds].filter(id => !toolResultIds.has(id)).length,
      orphanToolResultCount: [...toolResultIds].filter(id => !toolCallIds.has(id)).length,
      wasRepaired: false,
      syntheticResultsInserted: 0,
      messageCount: msgs.length,
    }
  }
```

---

## 网#1: DeepSeek tool-JSON-in-content 兜底解析

**文件:** `src/api/openai-client.ts`

### 1. 添加字段 (在 `pendingStopReason` 之后):
```ts
  private pendingStopReason: string | null = null
  /** Accumulated text for DeepSeek tool-JSON-in-content fallback */
  private _textAccum = ''
```

### 2. 在 `withStructuredRetry` 中重置 (在 `this.toolCallHintFired.clear()` 之后):
```ts
      this._textAccum = ''
```

### 3. 在 `processDelta` 的 `delta.content` 处理中累加:
```ts
    if (delta.content) {
      callbacks.onTextDelta?.(delta.content)
      if (this.config.capabilities?.hasToolJsonInContentBug) {
        this._textAccum += delta.content
      }
    }
```

### 4. 在 `choice.finish_reason` 处理中添加兜底 (在 `this.flushToolCalls(callbacks)` 之后):
```ts
    if (choice.finish_reason) {
      this.flushToolCalls(callbacks)
      if (this.toolCallBuffer.size === 0 && this._textAccum && this.config.capabilities?.hasToolJsonInContentBug) {
        this.tryParseToolJsonFromContent(this._textAccum, callbacks)
      }
      this._textAccum = ''
```

### 5. 在类中新增方法 (在 `flushToolCalls` 之后):
```ts
  private tryParseToolJsonFromContent(
    text: string,
    callbacks: Partial<Pick<StreamCallbacks, 'onContentBlock'>>,
  ): void {
    const trimmed = text.trim()
    if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return
    try {
      const parsed: unknown = JSON.parse(trimmed)
      const toolCalls = Array.isArray(parsed) ? parsed : [parsed]
      let emitted = 0
      for (const tc of toolCalls) {
        if (typeof tc !== 'object' || tc === null) continue
        const obj = tc as Record<string, unknown>
        if (typeof obj.name !== 'string') continue
        const input = typeof obj.arguments === 'object' && obj.arguments !== null
          ? obj.arguments as Record<string, unknown>
          : typeof obj.arguments === 'string'
            ? (() => { try { return JSON.parse(obj.arguments) as Record<string, unknown> } catch { return {} } })()
            : {}
        callbacks.onContentBlock?.({ type: 'tool_use', id: `fallback_${obj.name}_${emitted}`, name: obj.name, input })
        emitted++
      }
    } catch { /* Not valid JSON */ }
  }
```
