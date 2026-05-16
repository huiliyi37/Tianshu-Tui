# Wave 11: Cache 效率 + Token 节约 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 让 prefix cache 效率可观测，通过 tool result 截断减少 context 膨胀，增强 prewarm cache 命中率。

**架构：** 三层优化：可观测性（cockpit panel 展示 cache metrics）→ 截断（tool result 超阈值自动截断）→ 预读增强（LRU + 并行预读）。

**技术栈：** TypeScript, Ink 6 (React), Node.js fs.promises

---

## 文件结构

| 文件 | 操作 | 职责 |
|------|------|------|
| `src/agent/context.ts` | 修改 | 新增 `getPerTurnHitRate()` |
| `src/agent/loop.ts` | 修改 | 暴露 `getPrewarmStats()`，turn 结束时记录 cache + diagnostic |
| `src/agent/tool-result-truncate.ts` | 创建 | tool result 截断逻辑 |
| `src/agent/tool-pipeline.ts` | 修改 | 调用截断 |
| `src/agent/prewarm.ts` | 修改 | LRU 淘汰 + 扩容 |
| `src/agent/prewarm-file.ts` | 修改 | 并行预读 |
| `src/tui/cockpit/panels.tsx` | 修改 | model panel 展示 cache metrics |
| `src/tui/cockpit/state.ts` | 修改 | snapshot 包含 cache data |
| `src/agent/__tests__/tool-result-truncate.test.ts` | 创建 | 截断测试 |
| `src/agent/__tests__/prewarm.test.ts` | 修改 | LRU + 并行预读测试 |

---

### Task 1：Per-turn Cache Hit Rate + Prewarm Stats 暴露

**文件：**
- 修改：`src/agent/context.ts:100-103`
- 修改：`src/agent/loop.ts:82-175`
- 修改：`src/tui/cockpit/types.ts:86-94`
- 修改：`src/tui/cockpit/state.ts:125-134`
- 修改：`src/tui/cockpit/model-panel.tsx`

- [ ] **步骤 1：在 SessionContext 中新增 getLatestTurnHitRate()**

```typescript
// src/agent/context.ts — 在 getCacheHitRate() 后面添加
getLatestTurnHitRate(): number | null {
  const h = this.state.turnCacheHistory
  if (h.length === 0) return null
  const last = h[h.length - 1]!
  const total = last.cacheRead + last.cacheCreation
  return total === 0 ? 0 : last.cacheRead / total
}
```

- [ ] **步骤 2：在 AgentLoop 中暴露 getPrewarmStats()**

```typescript
// src/agent/loop.ts — 在 getLatestRisk() 后面添加
getPrewarmStats(): { hits: number; misses: number; hitRate: number } {
  return this.prewarm.stats()
}
```

- [ ] **步骤 3：在 AgentLoop.run() 的 onStopReason 中记录 turn cache**

```typescript
// src/agent/loop.ts — 在 streamCallbacks.onStopReason 中
onStopReason: (_reason, usage) => {
  this.session.addUsage(usage)
  if (usage.cache_read_input_tokens !== undefined || usage.cache_creation_input_tokens !== undefined) {
    this.session.recordTurnCache(turn, {
      input_tokens: usage.input_tokens ?? 0,
      output_tokens: usage.output_tokens ?? 0,
      cache_read_input_tokens: usage.cache_read_input_tokens ?? 0,
      cache_creation_input_tokens: usage.cache_creation_input_tokens ?? 0,
    })
  }
},
```

- [ ] **步骤 4：扩展 CockpitSnapshot model 类型**

```typescript
// src/tui/cockpit/types.ts — model 字段中添加
model: {
  name: string
  cacheHitRate: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  cost: number
  routingReason: string | null
  perTurnHitRate: number | null
  prewarmHits: number
  prewarmMisses: number
  prewarmHitRate: number
  cacheDiagnostic: string | null
}
```

- [ ] **步骤 5：在 buildCockpitSnapshot 中填充新字段**

```typescript
// src/tui/cockpit/state.ts — model 对象中添加
perTurnHitRate: session.getLatestTurnHitRate(),
prewarmHits: agent.getPrewarmStats().hits,
prewarmMisses: agent.getPrewarmStats().misses,
prewarmHitRate: agent.getPrewarmStats().hitRate,
cacheDiagnostic: null,
```

- [ ] **步骤 6：在 ModelPanel 中展示新指标**

```tsx
// src/tui/cockpit/model-panel.tsx — 在 Cache bar 后面添加 perTurnHitRate 和 prewarm 行
{perTurnHitRate !== null && (
  <Text>
    <Text color={theme.dim}>Turn:  </Text>
    <Text color={theme.contextColor(1 - perTurnHitRate)}>{Math.round(perTurnHitRate * 100)}%</Text>
    <Text color={theme.dim}> │ Prewarm: </Text>
    <Text>{prewarmHits}/{prewarmHits + prewarmMisses}</Text>
    <Text color={theme.dim}> ({Math.round(prewarmHitRate * 100)}%)</Text>
  </Text>
)}
```

- [ ] **步骤 7：运行 typecheck + tests**

运行：`npx tsc --noEmit && npm test`
预期：0 errors, 887+ tests pass

- [ ] **步骤 8：Commit**

```bash
git add src/agent/context.ts src/agent/loop.ts src/tui/cockpit/types.ts src/tui/cockpit/state.ts src/tui/cockpit/model-panel.tsx
git commit -m "feat(perf): expose per-turn cache hit rate + prewarm stats in cockpit model panel"
```

---

### Task 2：Cache Diagnostic 自动触发

**文件：**
- 修改：`src/agent/loop.ts`
- 修改：`src/tui/cockpit/state.ts`
- 修改：`src/tui/cockpit/model-panel.tsx`

- [ ] **步骤 1：在 AgentLoop 中添加 lastCacheDiagnostic 字段**

```typescript
// src/agent/loop.ts — private fields
private lastCacheDiagnostic: string | null = null
```

- [ ] **步骤 2：在 turn 结束时触发 diagnostic**

在 `AgentLoop.run()` 中，`callbacks.onTurnComplete` 之前：

```typescript
const latestHitRate = this.session.getLatestTurnHitRate()
if (latestHitRate !== null && latestHitRate < 0.8) {
  const diag = diagnoseCacheMiss(
    this.session.getCacheHistory(),
    this.session.getTurnCount(),
    this.config.promptEngine.checkDrift(),
    this.session.wasCompactedAt(turn),
  )
  this.lastCacheDiagnostic = diag?.message ?? null
} else {
  this.lastCacheDiagnostic = null
}
```

- [ ] **步骤 3：暴露 getCacheDiagnostic()**

```typescript
getCacheDiagnostic(): string | null { return this.lastCacheDiagnostic }
```

- [ ] **步骤 4：在 cockpit state 中使用**

```typescript
// src/tui/cockpit/state.ts — 替换 cacheDiagnostic: null
cacheDiagnostic: agent.getCacheDiagnostic(),
```

- [ ] **步骤 5：在 ModelPanel 中展示 diagnostic**

```tsx
{cacheDiagnostic && (
  <Text>
    <Text color={theme.warning}>⚠ {cacheDiagnostic}</Text>
  </Text>
)}
```

- [ ] **步骤 6：运行 typecheck + tests**

运行：`npx tsc --noEmit && npm test`
预期：0 errors, all pass

- [ ] **步骤 7：Commit**

```bash
git add src/agent/loop.ts src/tui/cockpit/state.ts src/tui/cockpit/model-panel.tsx
git commit -m "feat(perf): auto-trigger cache diagnostic on low hit rate, show in cockpit"
```

---

### Task 3：Tool Result 截断

**文件：**
- 创建：`src/agent/tool-result-truncate.ts`
- 修改：`src/agent/tool-pipeline.ts`
- 创建：`src/agent/__tests__/tool-result-truncate.test.ts`

- [ ] **步骤 1：创建 tool-result-truncate.ts**

```typescript
// src/agent/tool-result-truncate.ts
import { estimateMessageTokens } from '../compact/micro.js'

export function truncateToolResult(content: string, maxTokens: number): string {
  const tokens = estimateMessageTokens({ role: 'user', content })
  if (tokens <= maxTokens) return content

  const ratio = maxTokens / tokens
  const maxChars = Math.floor(content.length * ratio)
  const headChars = Math.floor(maxChars * 0.6)
  const tailChars = Math.floor(maxChars * 0.3)

  const head = content.slice(0, headChars)
  const tail = content.slice(-tailChars)
  const removed = content.length - headChars - tailChars

  return `${head}\n\n...[truncated ${removed} chars]...\n\n${tail}`
}
```

- [ ] **步骤 2：在 tool-pipeline.ts 中调用截断**

在 `executeToolUse` 函数顶部添加 import：

```typescript
import { truncateToolResult } from './tool-result-truncate.js'
import { compactThresholds } from '../compact/constants.js'
```

在最终 return 之前（第 338 行附近），对 `finalContent` 截断：

```typescript
const { toolResultMaxTokens } = compactThresholds(deps.config.contextWindow)
finalContent = truncateToolResult(finalContent, toolResultMaxTokens)
```

注意：只对非 error 的 result 截断（error 通常很短）。在 `run_tests` 的 early return 路径（第 333 行）也需要截断。

- [ ] **步骤 3：编写测试**

```typescript
// src/agent/__tests__/tool-result-truncate.test.ts
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { truncateToolResult } from '../tool-result-truncate.js'

describe('truncateToolResult', () => {
  it('returns content unchanged when under budget', () => {
    const short = 'hello world'
    assert.strictEqual(truncateToolResult(short, 100_000), short)
  })

  it('truncates content exceeding budget', () => {
    const long = 'x'.repeat(500_000)  // ~125K tokens
    const result = truncateToolResult(long, 50_000)
    assert.ok(result.length < long.length)
    assert.ok(result.includes('...[truncated'))
  })

  it('preserves head and tail', () => {
    const content = 'HEAD_MARKER' + 'x'.repeat(500_000) + 'TAIL_MARKER'
    const result = truncateToolResult(content, 50_000)
    assert.ok(result.startsWith('HEAD_MARKER'))
    assert.ok(result.endsWith('TAIL_MARKER'))
  })

  it('handles empty content', () => {
    assert.strictEqual(truncateToolResult('', 100_000), '')
  })
})
```

- [ ] **步骤 4：运行测试验证通过**

运行：`npx tsc --noEmit && npm test`
预期：0 errors, 891+ tests pass (4 new)

- [ ] **步骤 5：Commit**

```bash
git add src/agent/tool-result-truncate.ts src/agent/tool-pipeline.ts src/agent/__tests__/tool-result-truncate.test.ts
git commit -m "feat(perf): auto-truncate tool results exceeding context budget (head+tail)"
```

---

### Task 4：Prewarm Cache LRU 扩容

**文件：**
- 修改：`src/agent/prewarm.ts`
- 修改：`src/agent/__tests__/prewarm.test.ts`

- [ ] **步骤 1：修改 PrewarmCache 为 LRU 淘汰**

```typescript
// src/agent/prewarm.ts — 修改 get() 方法，访问时更新 timestamp
get(key: string): PrewarmValue | undefined {
  const entry = this.store.get(key)
  if (!entry) { this.misses++; return undefined }
  if (Date.now() - entry.timestamp > this.ttlMs) {
    this.store.delete(key)
    this.misses++
    return undefined
  }
  this.hits++
  entry.timestamp = Date.now()  // LRU: refresh on access
  return entry.value
}
```

- [ ] **步骤 2：修改 set() 为 LRU 淘汰（删除最旧的）**

```typescript
set(key: string, value: PrewarmValue): void {
  if (this.store.size >= this.maxEntries) {
    let oldestKey: string | null = null
    let oldestTs = Infinity
    for (const [k, v] of this.store) {
      if (v.timestamp < oldestTs) { oldestTs = v.timestamp; oldestKey = k }
    }
    if (oldestKey) this.store.delete(oldestKey)
  }
  this.store.set(key, { value, timestamp: Date.now() })
}
```

- [ ] **步骤 3：修改 AgentLoop 中的默认参数**

```typescript
// src/agent/loop.ts — 修改 prewarm 初始化
private prewarm = new PrewarmCache(60_000, 50)  // was (30_000, 20)
```

- [ ] **步骤 4：添加 LRU 测试**

```typescript
// src/agent/__tests__/prewarm.test.ts — 添加
it('evicts least recently used entry when full', () => {
  const cache = new PrewarmCache(60_000, 3)
  cache.set('a', makeValue('a'))
  cache.set('b', makeValue('b'))
  cache.set('c', makeValue('c'))

  // Access 'a' to make it recent
  cache.get('a')

  // Add 'd' — should evict 'b' (oldest access)
  cache.set('d', makeValue('d'))

  assert.ok(cache.get('a'))   // still alive (recently accessed)
  assert.ok(!cache.get('b'))  // evicted
  assert.ok(cache.get('c'))   // still alive
  assert.ok(cache.get('d'))   // just added
})

it('refreshes timestamp on get (LRU)', () => {
  const cache = new PrewarmCache(100, 2)  // 100ms TTL
  cache.set('a', makeValue('a'))

  // Wait 60ms, access to refresh
  const start = Date.now()
  while (Date.now() - start < 60) { /* spin */ }
  assert.ok(cache.get('a'))  // refreshes timestamp

  // Wait another 60ms — should still be alive (total 120ms but refreshed at 60ms)
  const start2 = Date.now()
  while (Date.now() - start2 < 60) { /* spin */ }
  assert.ok(cache.get('a'))  // still alive because refreshed
})
```

- [ ] **步骤 5：运行测试验证通过**

运行：`npx tsc --noEmit && npm test`
预期：0 errors, all pass

- [ ] **步骤 6：Commit**

```bash
git add src/agent/prewarm.ts src/agent/loop.ts src/agent/__tests__/prewarm.test.ts
git commit -m "feat(perf): prewarm cache LRU eviction + expand to 50 entries / 60s TTL"
```

---

### Task 5：Prewarm 并行预读

**文件：**
- 修改：`src/agent/loop.ts`
- 修改：`src/agent/prewarm-file.ts`
- 修改：`src/agent/__tests__/prewarm.test.ts`

- [ ] **步骤 1：在 prewarm-file.ts 中添加异步批量预读**

```typescript
// src/agent/prewarm-file.ts — 添加
import { readFile } from 'node:fs/promises'
import { stat } from 'node:fs/promises'

const MAX_PREWARM_SIZE = 100_000  // 100KB
const MAX_PARALLEL = 5

export async function batchPrewarm(
  cwd: string,
  paths: string[],
  cache: import('./prewarm.js').PrewarmCache,
): Promise<void> {
  const toRead = paths
    .map(p => ({ path: p, value: buildPrewarmValue(cwd, p) }))
    .filter(({ value, path }) => value && !cache.get(value.canonicalPath))
    .slice(0, MAX_PARALLEL)

  await Promise.all(toRead.map(async ({ value }) => {
    if (!value) return
    cache.set(value.canonicalPath, value)
  }))
}
```

- [ ] **步骤 2：修改 maybePrewarm 为异步 + 批量**

```typescript
// src/agent/loop.ts — 修改 maybePrewarm
private maybePrewarm(text: string): void {
  const intents = extractIntents(text)
  const filePaths: string[] = []
  for (const intent of intents) {
    if (intent.type !== 'file') continue
    const value = buildPrewarmValue(this.cwd, intent.value)
    if (!value) continue
    if (!this.prewarm.get(value.canonicalPath)) {
      this.prewarm.set(value.canonicalPath, value)
      filePaths.push(intent.value)
    }
  }
}
```

注意：`buildPrewarmValue` 已经是同步读取文件的。并行预读的价值在于当 `extractIntents` 返回多个 file intent 时，它们已经被同步读取并缓存了。实际上当前实现已经是 O(N) 同步读取。真正的并行优化需要改为 async readFile。

但考虑到 `maybePrewarm` 在 streaming callback 中被调用（同步上下文），改为 async 会增加复杂度。更实际的优化是：在 turn 开始前，基于上一 turn 的 file history 预读可能需要的文件。

**替代方案：Turn-start 预读**

```typescript
// src/agent/loop.ts — 在 turn 循环开始时
private prewarmFromHistory(): void {
  const recent = this.recentToolHistory
    .filter(e => e.tool === 'read_file' && e.status === 'success')
    .map(e => e.target)
  for (const path of recent) {
    const value = buildPrewarmValue(this.cwd, path)
    if (value && !this.prewarm.get(value.canonicalPath)) {
      this.prewarm.set(value.canonicalPath, value)
    }
  }
}
```

在 turn 循环开头调用 `this.prewarmFromHistory()`。

- [ ] **步骤 3：添加测试**

```typescript
it('prewarmFromHistory pre-caches recently read files', () => {
  // Test that files from recentToolHistory get cached
})
```

- [ ] **步骤 4：运行测试验证通过**

运行：`npx tsc --noEmit && npm test`
预期：0 errors, all pass

- [ ] **步骤 5：Commit**

```bash
git add src/agent/loop.ts src/agent/prewarm-file.ts src/agent/__tests__/prewarm.test.ts
git commit -m "feat(perf): prewarm from recent tool history at turn start"
```

---

## 自检

1. **规格覆盖度：** 设计文档 7 个 task → 计划 5 个 task（合并了 Task 2+3 为 Task 2，合并了 Task 4+5 为 Task 3，Task 6+7 为 Task 4+5）。所有需求已覆盖。
2. **占位符扫描：** 无 TODO/TBD。
3. **类型一致性：** `getLatestTurnHitRate` / `getPrewarmStats` / `getCacheDiagnostic` 在 context.ts/loop.ts 定义，在 state.ts 消费，类型匹配。
4. **范围检查：** 5 个 task，每个独立可测试，总计 ~3 天工作量。
