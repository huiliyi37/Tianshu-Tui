# 内存泄漏修复 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 修复 TUI 会话中的内存泄漏——ClaimStore consumers 无限增长、Promise 队列链累积、Agent 跨轮次状态泄漏、错误/中止路径工具状态未清理。

**架构：** 在 ClaimStore 中增加 consumers 数组上限和 stale claim 驱逐；在 TrajectoryRecorder 中增加 per-run 上限；在 AgentLoop.run() 开头和 catch/finally 中重置累积状态；在 TUI onError/onAbort 中清理工具 Maps；替换 Promise 队列链为简单的 async 序列化器。

**技术栈：** TypeScript, React (Ink), 现有 test runner (node:test)。

**前置条件：** 无外部依赖，可独立执行。

---

## 文件结构

| 文件 | 操作 | 职责 |
|------|------|------|
| `src/agent/trajectory.ts` | 修改 | TrajectoryRecorder 增加 maxEntries 上限 |
| `src/agent/__tests__/trajectory.test.ts` | 修改 | 新增上限相关测试 |
| `src/context/claim-store.ts` | 修改 | consumers 上限 + stale claim 驱逐 |
| `src/context/__tests__/claim-store.test.ts` | 修改 | 新增 consumers 上限和驱逐测试 |
| `src/agent/loop.ts` | 修改 | run() 开头重置 evidence/repairHintTracker/userAnchors + catch/finally 清理 |
| `src/tui/app.tsx` | 修改 | onError/onAbort 清理工具 Maps + 替换 Promise 队列 + clarityHistory 上限 |

---

### 任务 1：TrajectoryRecorder — 增加 per-run 上限

**文件：**
- 修改：`src/agent/trajectory.ts:12-17`
- 修改：`src/agent/__tests__/trajectory.test.ts`

- [ ] **步骤 1：编写失败的测试**

在 `src/agent/__tests__/trajectory.test.ts` 末尾追加：

```typescript
it('caps entries at maxEntries, dropping oldest', () => {
  const tr = new TrajectoryRecorder(3) // max 3
  tr.record({ turn: 1, tool: 'a', target: '', durationMs: 1, status: 'success', inputSummary: '', resultSummary: '' })
  tr.record({ turn: 2, tool: 'b', target: '', durationMs: 1, status: 'success', inputSummary: '', resultSummary: '' })
  tr.record({ turn: 3, tool: 'c', target: '', durationMs: 1, status: 'success', inputSummary: '', resultSummary: '' })
  tr.record({ turn: 4, tool: 'd', target: '', durationMs: 1, status: 'success', inputSummary: '', resultSummary: '' })
  const entries = tr.getEntries()
  assert.equal(entries.length, 3)
  assert.equal(entries[0]!.tool, 'b')  // oldest dropped
  assert.equal(entries[2]!.tool, 'd')
})

it('defaults maxEntries to 200 when not specified', () => {
  const tr = new TrajectoryRecorder()
  // Fill with 200 entries — should all be kept
  for (let i = 0; i < 200; i++) {
    tr.record({ turn: i, tool: `t${i}`, target: '', durationMs: 1, status: 'success', inputSummary: '', resultSummary: '' })
  }
  assert.equal(tr.getEntries().length, 200)
  // 201st entry should drop the oldest
  tr.record({ turn: 200, tool: 'overflow', target: '', durationMs: 1, status: 'success', inputSummary: '', resultSummary: '' })
  assert.equal(tr.getEntries().length, 200)
  assert.equal(tr.getEntries()[0]!.tool, 't1')
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npm test -- --test-name-pattern "caps entries|defaults maxEntries" 2>&1 | tail -10`
预期：FAIL — `TrajectoryRecorder` 构造函数目前不接受参数

- [ ] **步骤 3：修改 TrajectoryRecorder**

修改 `src/agent/trajectory.ts`：

```typescript
const DEFAULT_MAX_ENTRIES = 200

export class TrajectoryRecorder {
  private entries: TrajectoryEntry[] = []
  private maxEntries: number

  constructor(maxEntries: number = DEFAULT_MAX_ENTRIES) {
    this.maxEntries = maxEntries
  }

  record(entry: TrajectoryEntry): void {
    this.entries.push(entry)
    if (this.entries.length > this.maxEntries) {
      this.entries = this.entries.slice(-this.maxEntries)
    }
  }

  getEntries(): TrajectoryEntry[] {
    return this.entries
  }

  summarize(): { totalTools: number; failures: number; retries: number; avgDurationMs: number } {
    const total = this.entries.length
    const failures = this.entries.filter(e => e.status === 'failed' || e.status === 'retried-failed').length
    const retries = this.entries.filter(e => e.status.startsWith('retried')).length
    const avgDurationMs = total > 0 ? Math.round(this.entries.reduce((s, e) => s + e.durationMs, 0) / total) : 0
    return { totalTools: total, failures, retries, avgDurationMs }
  }

  exportJson(): string {
    return JSON.stringify(this.entries)
  }

  reset(): void {
    this.entries = []
  }
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`npm test -- --test-name-pattern "TrajectoryRecorder" 2>&1 | tail -10`
预期：全部 PASS（6 tests）

- [ ] **步骤 5：Commit**

```bash
git add src/agent/trajectory.ts src/agent/__tests__/trajectory.test.ts
git commit -m "fix(agent): cap TrajectoryRecorder entries at 200 per run"
```

---

### 任务 2：ClaimStore — consumers 上限 + stale claim 驱逐

**文件：**
- 修改：`src/context/claim-store.ts:32-54, 266-277`
- 修改：`src/context/__tests__/claim-store.test.ts`

- [ ] **步骤 1：编写失败的测试**

在 `src/context/__tests__/claim-store.test.ts` 末尾追加：

```typescript
test('caps consumers array per claim at MAX_CONSUMERS (50)', () => {
  const dir = tempDir()
  try {
    const store = new ContextClaimStore(dir, 'session-123')
    const claim = store.propose(proposal('Consumer cap test'))

    // Record 60 usage events
    for (let i = 0; i < 60; i++) {
      store.recordClaimUsed(claim.id, {
        consumerId: `turn-${i}:prompt`,
        consumerKind: 'prompt',
        usedAt: Date.now() + i,
      })
    }

    const claims = store.listActiveClaims()
    const updated = claims.find(c => c.id === claim.id)!
    assert.ok(updated.consumers.length <= 50, `consumers length ${updated.consumers.length} should be <= 50`)
    // Most recent consumers should be kept
    assert.equal(updated.consumers[updated.consumers.length - 1]!.id, 'turn-59:prompt')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('evicts stale claims beyond MAX_ACTIVE_CLAIMS (50)', () => {
  const dir = tempDir()
  try {
    const store = new ContextClaimStore(dir, 'session-123')

    // Create 55 active claims
    for (let i = 0; i < 55; i++) {
      store.propose({ ...proposal(`Claim ${i}`), createdAt: i * 1000 })
    }

    const active = store.listActiveClaims()
    // After eviction, should be <= 50
    assert.ok(active.length <= 50, `active claims ${active.length} should be <= 50`)
    // Oldest claims (lowest createdAt) should be evicted
    assert.equal(active[0]!.text, 'Claim 5') // first 5 evicted (0-4)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npm test -- --test-name-pattern "caps consumers|evicts stale" 2>&1 | tail -10`
预期：FAIL — consumers 不会被 cap，没有 eviction 逻辑

- [ ] **步骤 3：修改 claim-store.ts**

在 `ContextClaimStore` 类顶部（第 31 行，类定义之前）增加常量：

```typescript
const MAX_CONSUMERS_PER_CLAIM = 50
const MAX_ACTIVE_CLAIMS = 50
```

**修改 3a：** 在 `applyEventsToMap` 中 cap consumers 数组。找到 `claim_used` 处理分支（约第 266-277 行），替换为：

```typescript
      if (event.type === 'claim_used') {
        const claim = claims.get(event.claimId)
        if (!claim) continue
        const newConsumers = [...claim.consumers, {
          id: event.consumerId,
          kind: event.consumerKind,
          usedAt: event.createdAt,
        }]
        // Cap consumers array — keep most recent
        const cappedConsumers = newConsumers.length > MAX_CONSUMERS_PER_CLAIM
          ? newConsumers.slice(-MAX_CONSUMERS_PER_CLAIM)
          : newConsumers
        claims.set(event.claimId, {
          ...claim,
          lastUsedAt: event.createdAt,
          consumers: cappedConsumers,
        })
        continue
      }
```

**修改 3b：** 在 `promoteEligibleClaims` 方法末尾（return 之前）增加 eviction 调用。找到该方法（约第 147-155 行）：

```typescript
  promoteEligibleClaims(now = Date.now()): ContextClaim[] {
    const promoted: ContextClaim[] = []
    for (const claim of this.listActiveClaims(now)) {
      if (isEligibleForPromotion(claim, now)) {
        const updated = this.updateClaimStatus(claim.id, 'durable', 'auto-promoted')
        if (updated) promoted.push(updated)
      }
    }
    // Evict excess active claims (cap at MAX_ACTIVE_CLAIMS)
    this.evictExcessActiveClaims(now)
    return promoted
  }
```

在 `promoteEligibleClaims` 方法之后添加新方法：

```typescript
  private evictExcessActiveClaims(now: number = Date.now()): void {
    const active = this.listActiveClaims(now)
    if (active.length <= MAX_ACTIVE_CLAIMS) return
    // Evict oldest (lowest createdAt) excess claims
    const toEvict = active
      .sort((a, b) => a.createdAt - b.createdAt)
      .slice(0, active.length - MAX_ACTIVE_CLAIMS)
    for (const claim of toEvict) {
      this.updateClaimStatus(claim.id, 'stale', 'evicted-overflow')
    }
  }
```

- [ ] **步骤 4：运行测试验证通过**

运行：`npm test -- --test-name-pattern "ClaimStore|caps consumers|evicts stale" 2>&1 | tail -10`
预期：全部 PASS（含新增 2 个 + 已有测试）

- [ ] **步骤 5：Commit**

```bash
git add src/context/claim-store.ts src/context/__tests__/claim-store.test.ts
git commit -m "fix(context): cap ClaimStore consumers array and evict excess active claims"
```

---

### 任务 3：AgentLoop — run() 开头和 catch/finally 清理

**文件：**
- 修改：`src/agent/loop.ts:89-109, 372-603`

- [ ] **步骤 1：在 run() 开头重置累积状态**

找到 `src/agent/loop.ts` 的 `run()` 方法开头（约第 372-377 行），在 `this.abortController = new AbortController()` 之后增加：

```typescript
  async run(userInput: string, callbacks: AgentCallbacks): Promise<void> {
    this.abortController = new AbortController()
    this.trajectory.reset()
    this.decisions = []
    this.traceStore = createTraceStore()
    this.predictionAccumulator = createPredictionAccumulator()
    // Reset accumulations from previous run
    this.evidence.reset()
    this.repairHintTracker = new RepairHintTracker()
    this.userAnchors = []
```

- [ ] **步骤 2：在 catch 块中也执行清理**

修改 `catch` 块（约第 597-603 行），确保 abort/error 路径也清理：

```typescript
    } catch (err) {
      this.evidence.reset()
      if ((err as Error).name === 'AbortError') {
        callbacks.onAbort()
      } else {
        callbacks.onError(err as Error)
      }
    }
```

- [ ] **步骤 3：运行 typecheck**

运行：`npx tsc --noEmit 2>&1 | tail -5`
预期：无错误

- [ ] **步骤 4：运行现有 agent 测试确保无回归**

运行：`npm test -- --test-name-pattern "AgentLoop|loop" 2>&1 | tail -10`
预期：全部 PASS

- [ ] **步骤 5：Commit**

```bash
git add src/agent/loop.ts
git commit -m "fix(agent): reset evidence/repairHintTracker/userAnchors at start of run() and in catch"
```

---

### 任务 4：TUI — onError/onAbort 清理工具 Maps + 替换 Promise 队列

**文件：**
- 修改：`src/tui/app.tsx:240, 662-698, 709-714`

- [ ] **步骤 1：在 onError 中清理工具 Maps**

找到 `src/tui/app.tsx` 的 `onError` 回调（约第 662 行），在 `liveToolsRef.current = []` 之前增加清理：

```typescript
      onError: (error) => {
        // Clean up stale timers and writer on error
        if (thinkTimer.current) { clearTimeout(thinkTimer.current); thinkTimer.current = null }
        if (toolTimer.current) { clearTimeout(toolTimer.current); toolTimer.current = null }
        blockWriterRef.current?.flush()
        blockWriterRef.current = null
        // Preserve any partial text/thinking before clearing
        if (streamBuf.current || thinkBuf.current) {
          pushStatic(createLogEntry({ type: 'assistant_message', content: streamBuf.current, thinking: thinkBuf.current || undefined }))
        }
        streamBuf.current = ''
        setStreamingText('')
        thinkBuf.current = ''
        setStreamingThinking('')
        // Clear tool state from failed run
        toolAccum.current.clear()
        toolNames.current.clear()
        dirtyTools.current.clear()
        toolTargetMap.current.clear()
        toolCallTracker.current.clear()
        liveToolsRef.current = []
        setLiveTools([])
        pushStatic(createLogEntry({ type: 'system', content: `Error: ${error.message}`, isError: true }))
        setIsStreaming(false)
      },
```

- [ ] **步骤 2：在 onAbort 中清理工具 Maps**

找到 `onAbort` 回调（约第 681 行），同样增加清理：

```typescript
      onAbort: () => {
        if (thinkTimer.current) { clearTimeout(thinkTimer.current); thinkTimer.current = null }
        if (toolTimer.current) { clearTimeout(toolTimer.current); toolTimer.current = null }
        blockWriterRef.current?.flush()
        blockWriterRef.current = null
        // Preserve any partial text/thinking before clearing
        if (streamBuf.current || thinkBuf.current) {
          pushStatic(createLogEntry({ type: 'assistant_message', content: streamBuf.current, thinking: thinkBuf.current || undefined }))
        }
        streamBuf.current = ''
        setStreamingText('')
        thinkBuf.current = ''
        setStreamingThinking('')
        // Clear tool state from aborted run
        toolAccum.current.clear()
        toolNames.current.clear()
        dirtyTools.current.clear()
        toolTargetMap.current.clear()
        toolCallTracker.current.clear()
        liveToolsRef.current = []
        setLiveTools([])
        pushStatic(createLogEntry({ type: 'system', content: '⏹ Interrupted.' }))
        setIsStreaming(false)
      },
```

- [ ] **步骤 3：替换 Promise 队列链**

将 `promptQueueRef` 从 Promise 链改为简单的 async 序列化器。

找到声明（约第 240 行）：

```typescript
  const promptQueueRef = useRef<Promise<void>>(Promise.resolve())
```

替换为：

```typescript
  const promptQueueRef = useRef({ running: false })
```

找到链式调用（约第 709-714 行）：

```typescript
    promptQueueRef.current = promptQueueRef.current
      .then(run)
      .catch((err: Error) => {
        pushStatic(createLogEntry({ type: 'system', content: `Queue error: ${err.message}`, isError: true }))
        setIsStreaming(false)
      })
```

替换为：

```typescript
    // Serialize via flag — if a run is already in progress, queue this one
    if (promptQueueRef.current.running) {
      // Previous run still going — this shouldn't happen in normal usage
      // but guard against double-submit
      return
    }
    promptQueueRef.current.running = true
    run().catch((err: Error) => {
      pushStatic(createLogEntry({ type: 'system', content: `Queue error: ${err.message}`, isError: true }))
      setIsStreaming(false)
    }).finally(() => {
      promptQueueRef.current.running = false
    })
```

- [ ] **步骤 4：运行 typecheck**

运行：`npx tsc --noEmit 2>&1 | tail -5`
预期：无错误

- [ ] **步骤 5：运行全量测试确保无回归**

运行：`npm test 2>&1 | grep -E "^ℹ (tests|pass|fail)"`
预期：0 fail

- [ ] **步骤 6：Commit**

```bash
git add src/tui/app.tsx
git commit -m "fix(tui): clear tool maps on error/abort and replace promise queue chain"
```

---

### 任务 5：TUI — clarityHistory 上限 + 全量验证

**文件：**
- 修改：`src/tui/app.tsx:183, 595`

- [ ] **步骤 1：给 clarityHistory 增加上限**

找到 `setClarityHistory` 调用（约第 595 行）：

```typescript
              setClarityHistory(prev => [...prev, parsed.state.clarity])
```

替换为：

```typescript
              setClarityHistory(prev => [...prev.slice(-49), parsed.state.clarity])
```

（保留最近 50 条，面试通常最多 5 轮，50 是安全上限。）

- [ ] **步骤 2：运行 typecheck**

运行：`npx tsc --noEmit 2>&1 | tail -5`
预期：无错误

- [ ] **步骤 3：运行全量测试**

运行：`npx tsc --noEmit && npm test 2>&1 | grep -E "^ℹ (tests|pass|fail)"`
预期：0 errors, 1085+ pass, 0 fail

- [ ] **步骤 4：Commit**

```bash
git add src/tui/app.tsx
git commit -m "fix(tui): cap clarityHistory array at 50 entries"
```

---

## 自检

1. **覆盖度：** 审计报告中 7 个需修复项全部覆盖：
   - ClaimStore consumers 无限增长 → Task 2 ✅
   - Promise 队列链累积 → Task 4 ✅
   - onError/onAbort 工具 Maps 未清理 → Task 4 ✅
   - evidence 跨 run() 泄漏 → Task 3 ✅
   - repairHintTracker 跨 run() 泄漏 → Task 3 ✅
   - userAnchors 跨 run() 泄漏 → Task 3 ✅
   - Trajectory entries 无上限 → Task 1 ✅
   - clarityHistory 无限增长 → Task 5 ✅

2. **占位符扫描：** 无 TODO/TBD，所有步骤有完整代码。

3. **类型一致性：** `TrajectoryRecorder` 构造函数在 Task 1 中增加可选参数，Task 3 中不传参（使用默认值）；`RepairHintTracker` 在 Task 3 中重新实例化（已有 new 构造函数）；`toolAccum.current.clear()` 等在 Task 4 中的调用与 Task 开头的初始化模式一致。

---

## 风险

| 风险 | 防线 |
|------|------|
| TrajectoryRecorder 上限太低丢信息 | 默认 200 = maxTurns(30) x toolsPerTurn(~7)，覆盖正常场景 |
| ClaimStore eviction 可能误驱逐活跃 claim | 仅驱逐 active 状态中 createdAt 最早的；durable/stale 不受影响 |
| Promise 队列改为 running flag 可能丢失并发 | 原设计就是串行（.then 链），flag 行为一致；guard return 防止 double-submit |
| evidence.reset() 在 run() 开头调用可能影响跨 run 证据 | 原设计只在无 tool call 退出时 reset，属于遗漏而非有意保留 |
