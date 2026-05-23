# Context Diet 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 为 Rivet 添加三层上下文瘦身机制，让长 session 的 context 利用率提升 30-50%，同时保护 DeepSeek prefix cache。

**架构：** 在现有 `compaction-controller.ts` 的 `maybeCompact` 流程之前插入轻量级 prune 步骤（不调用 LLM），清理旧 tool_result；在 `tool-pipeline.ts` 的 artifact intercept 之后添加 per-message 聚合预算检查；提升 read 工具的 artifact 阈值到不截断。

**技术栈：** TypeScript strict / node:test / OAI message format / 现有 compact 基础设施

---

## 文件结构

| 文件 | 职责 | 操作 |
|------|------|------|
| `src/compact/prune.ts` | 历史 tool_result 清理逻辑（纯函数） | 创建 |
| `src/compact/__tests__/prune.test.ts` | prune 单元测试 | 创建 |
| `src/agent/compaction-controller.ts` | 在 maybeCompact 前调用 prune | 修改 |
| `src/agent/tool-pipeline.ts:134-141` | 提升 READ_TOOL_THRESHOLD / 添加 per-message budget | 修改 |
| `src/agent/__tests__/tool-pipeline-budget.test.ts` | per-message budget 测试 | 创建 |
| `src/compact/constants.ts` | 新增 prune 相关常量 | 修改 |

---

### 任务 1：历史 tool_result 清理（prune）

**文件：**
- 创建：`src/compact/prune.ts`
- 创建：`src/compact/__tests__/prune.test.ts`
- 修改：`src/compact/constants.ts`

- [ ] **步骤 1：编写失败的测试**

```typescript
// src/compact/__tests__/prune.test.ts
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { pruneStaleToolResults } from '../prune.js'
import type { OaiMessage } from '../../api/oai-types.js'

function toolMsg(content: string): OaiMessage {
  return { role: 'tool', content, tool_call_id: `call_${Math.random().toString(36).slice(2)}` }
}
function userMsg(content: string): OaiMessage { return { role: 'user', content } }
function assistantMsg(content: string): OaiMessage { return { role: 'assistant', content } }

describe('pruneStaleToolResults', () => {
  it('preserves recent tool results within protect window', () => {
    const messages: OaiMessage[] = [
      userMsg('system'), assistantMsg('anchor'),  // cache anchors (idx 0,1)
      userMsg('q1'),
      assistantMsg('a1'),
      toolMsg('recent-output-1'),
      userMsg('q2'),
      assistantMsg('a2'),
      toolMsg('recent-output-2'),
    ]
    const result = pruneStaleToolResults(messages, { protectRecentMessages: 6 })
    // All within protect window — nothing pruned
    assert.equal(result.prunedCount, 0)
    assert.deepEqual(result.messages, messages)
  })

  it('clears stale tool results beyond protect window', () => {
    const longContent = 'x'.repeat(5000)
    const messages: OaiMessage[] = [
      userMsg('system'), assistantMsg('anchor'),
      userMsg('old-q'), assistantMsg('old-a'), toolMsg(longContent),  // stale
      userMsg('old-q2'), assistantMsg('old-a2'), toolMsg(longContent), // stale
      userMsg('recent-q'), assistantMsg('recent-a'), toolMsg('short-recent'),
    ]
    const result = pruneStaleToolResults(messages, { protectRecentMessages: 4 })
    assert.equal(result.prunedCount, 2)
    // Stale tool messages replaced with stub
    assert.ok(result.messages[4].content.includes('[pruned:'))
    assert.ok(result.messages[7].content.includes('[pruned:'))
    // Recent preserved
    assert.equal(result.messages[10].content, 'short-recent')
  })

  it('skips tool results already pruned or short', () => {
    const messages: OaiMessage[] = [
      userMsg('system'), assistantMsg('anchor'),
      userMsg('q'), assistantMsg('a'), toolMsg('short'),
      userMsg('q2'), assistantMsg('a2'), toolMsg('also-short'),
      userMsg('recent'), assistantMsg('recent-a'), toolMsg('recent'),
    ]
    const result = pruneStaleToolResults(messages, { protectRecentMessages: 4 })
    assert.equal(result.prunedCount, 0)
  })

  it('never touches cache anchor messages', () => {
    const longContent = 'x'.repeat(5000)
    const messages: OaiMessage[] = [
      userMsg(longContent), assistantMsg(longContent),  // anchors — never touch
      userMsg('q'), assistantMsg('a'), toolMsg(longContent),
      userMsg('recent'), assistantMsg('recent-a'), toolMsg('r'),
    ]
    const result = pruneStaleToolResults(messages, { protectRecentMessages: 4 })
    assert.equal(result.messages[0].content, longContent)
    assert.equal(result.messages[1].content, longContent)
  })

  it('respects minimum content threshold', () => {
    const messages: OaiMessage[] = [
      userMsg('system'), assistantMsg('anchor'),
      userMsg('q'), assistantMsg('a'), toolMsg('x'.repeat(800)),  // below 1200 threshold
      userMsg('recent'), assistantMsg('recent-a'), toolMsg('r'),
    ]
    const result = pruneStaleToolResults(messages, { protectRecentMessages: 4 })
    assert.equal(result.prunedCount, 0)
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`node --test src/compact/__tests__/prune.test.ts`
预期：FAIL，报错 "Cannot find module '../prune.js'"

- [ ] **步骤 3：添加常量到 constants.ts**

在 `src/compact/constants.ts` 末尾追加：

```typescript
/** Prune: number of recent messages to protect from clearing */
export const PRUNE_PROTECT_RECENT_MESSAGES = 8

/** Prune: minimum content length to bother clearing (shorter results cost little) */
export const PRUNE_MIN_CONTENT_CHARS = 1_200
```

- [ ] **步骤 4：实现 prune.ts**

```typescript
// src/compact/prune.ts
import type { OaiMessage } from '../api/oai-types.js'
import { CACHE_ANCHOR_MESSAGES, PRUNE_PROTECT_RECENT_MESSAGES, PRUNE_MIN_CONTENT_CHARS } from './constants.js'

export interface PruneOptions {
  protectRecentMessages?: number
  minContentChars?: number
}

export interface PruneResult {
  messages: OaiMessage[]
  prunedCount: number
  freedChars: number
}

export function pruneStaleToolResults(
  messages: OaiMessage[],
  options: PruneOptions = {},
): PruneResult {
  const protectRecent = options.protectRecentMessages ?? PRUNE_PROTECT_RECENT_MESSAGES
  const minChars = options.minContentChars ?? PRUNE_MIN_CONTENT_CHARS

  if (messages.length <= CACHE_ANCHOR_MESSAGES + protectRecent) {
    return { messages, prunedCount: 0, freedChars: 0 }
  }

  const recentStart = messages.length - protectRecent
  let prunedCount = 0
  let freedChars = 0

  const result = messages.map((msg, idx) => {
    if (idx < CACHE_ANCHOR_MESSAGES) return msg
    if (idx >= recentStart) return msg
    if (msg.role !== 'tool') return msg
    if (msg.content.length <= minChars) return msg
    if (msg.content.startsWith('[pruned:')) return msg

    prunedCount++
    freedChars += msg.content.length
    return {
      ...msg,
      content: `[pruned: ${msg.content.length} chars from tool_call ${msg.tool_call_id ?? 'unknown'}]`,
    }
  })

  return { messages: prunedCount > 0 ? result : messages, prunedCount, freedChars }
}
```

- [ ] **步骤 5：运行测试验证通过**

运行：`node --test src/compact/__tests__/prune.test.ts`
预期：5 tests PASS

- [ ] **步骤 6：Commit**

```bash
git add src/compact/prune.ts src/compact/__tests__/prune.test.ts src/compact/constants.ts
git commit -m "feat(compact): add prune for stale tool_result clearing"
```

---

### 任务 2：集成 prune 到 compaction controller

**文件：**
- 修改：`src/agent/compaction-controller.ts:43-60`

- [ ] **步骤 1：编写失败的测试**

```typescript
// src/compact/__tests__/prune.test.ts — 追加到已有文件
import { pruneStaleToolResults } from '../prune.js'

describe('pruneStaleToolResults integration', () => {
  it('returns freed chars for token estimate adjustment', () => {
    const longContent = 'x'.repeat(10_000)
    const messages: OaiMessage[] = [
      userMsg('system'), assistantMsg('anchor'),
      userMsg('q1'), assistantMsg('a1'), toolMsg(longContent),
      userMsg('q2'), assistantMsg('a2'), toolMsg(longContent),
      userMsg('q3'), assistantMsg('a3'), toolMsg(longContent),
      userMsg('recent'), assistantMsg('recent-a'), toolMsg('r'),
    ]
    const result = pruneStaleToolResults(messages, { protectRecentMessages: 4 })
    assert.equal(result.prunedCount, 3)
    assert.equal(result.freedChars, 30_000)
  })
})
```

- [ ] **步骤 2：运行测试验证通过**

运行：`node --test src/compact/__tests__/prune.test.ts`
预期：PASS（prune 逻辑已实现）

- [ ] **步骤 3：修改 compaction-controller.ts**

在 `src/agent/compaction-controller.ts` 的 `maybeCompact` 方法开头（L44，`const messages = ...` 之后）插入 prune 调用：

```typescript
import { pruneStaleToolResults } from '../compact/prune.js'
```

在 `maybeCompact` 方法中，`const messages = this.deps.session.getMessages()` 之后、`const compactDecision = ...` 之前插入：

```typescript
    const pruneResult = pruneStaleToolResults(messages)
    if (pruneResult.prunedCount > 0) {
      this.deps.session.replaceMessages(pruneResult.messages)
    }
```

完整的 `maybeCompact` 方法前半段变为：

```typescript
  async maybeCompact(input: MaybeCompactInput): Promise<MaybeCompactResult> {
    const messages = this.deps.session.getMessages()

    // Lightweight prune: clear stale tool results before checking compact thresholds.
    // This is free (no LLM call) and stabilizes the prefix for cache hits.
    const pruneResult = pruneStaleToolResults(messages)
    if (pruneResult.prunedCount > 0) {
      this.deps.session.replaceMessages(pruneResult.messages)
    }

    const estimatedTokens = this.deps.session.getEstimatedTokens()
    const compactDecision = decideCompactTier({
      // ... rest unchanged
```

- [ ] **步骤 4：运行 typecheck**

运行：`npm run typecheck`
预期：PASS

- [ ] **步骤 5：运行全量测试**

运行：`npm test 2>&1 | tail -5`
预期：全绿

- [ ] **步骤 6：Commit**

```bash
git add src/agent/compaction-controller.ts
git commit -m "feat(compact): integrate prune into compaction controller"
```

---

### 任务 3：Per-message 聚合预算

**文件：**
- 创建：`src/agent/__tests__/tool-pipeline-budget.test.ts`
- 修改：`src/agent/tool-pipeline.ts:134`
- 修改：`src/compact/constants.ts`

- [ ] **步骤 1：添加常量**

在 `src/compact/constants.ts` 追加：

```typescript
/** Per-message aggregate budget: max total chars across all tool results in one turn */
export const PER_MESSAGE_TOOL_RESULT_BUDGET_CHARS = 120_000
```

- [ ] **步骤 2：编写失败的测试**

```typescript
// src/agent/__tests__/tool-pipeline-budget.test.ts
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { enforcePerMessageBudget } from '../per-message-budget.js'

describe('enforcePerMessageBudget', () => {
  it('returns results unchanged when under budget', () => {
    const results = [
      { toolUseId: 'a', content: 'x'.repeat(1000), toolName: 'grep' },
      { toolUseId: 'b', content: 'x'.repeat(2000), toolName: 'read_file' },
    ]
    const enforced = enforcePerMessageBudget(results, 120_000)
    assert.equal(enforced[0].content, results[0].content)
    assert.equal(enforced[1].content, results[1].content)
  })

  it('replaces largest results first when over budget', () => {
    const results = [
      { toolUseId: 'a', content: 'x'.repeat(50_000), toolName: 'grep' },
      { toolUseId: 'b', content: 'x'.repeat(80_000), toolName: 'bash' },
      { toolUseId: 'c', content: 'x'.repeat(10_000), toolName: 'read_file' },
    ]
    // Total = 140K, budget = 120K. Must evict 'b' (largest, 80K) to get under.
    const enforced = enforcePerMessageBudget(results, 120_000)
    assert.ok(enforced[1].content.startsWith('[budget-evicted:'))
    assert.equal(enforced[0].content, results[0].content)
    assert.equal(enforced[2].content, results[2].content)
  })

  it('evicts multiple results if needed', () => {
    const results = [
      { toolUseId: 'a', content: 'x'.repeat(60_000), toolName: 'grep' },
      { toolUseId: 'b', content: 'x'.repeat(50_000), toolName: 'bash' },
      { toolUseId: 'c', content: 'x'.repeat(40_000), toolName: 'grep' },
    ]
    // Total = 150K, budget = 80K. Must evict 'a' (60K) + 'b' (50K).
    const enforced = enforcePerMessageBudget(results, 80_000)
    assert.ok(enforced[0].content.startsWith('[budget-evicted:'))
    assert.ok(enforced[1].content.startsWith('[budget-evicted:'))
    assert.equal(enforced[2].content, results[2].content)
  })

  it('never evicts read_file results', () => {
    const results = [
      { toolUseId: 'a', content: 'x'.repeat(100_000), toolName: 'read_file' },
      { toolUseId: 'b', content: 'x'.repeat(50_000), toolName: 'bash' },
    ]
    // Total = 150K, budget = 120K. 'a' is read_file (protected), evict 'b'.
    const enforced = enforcePerMessageBudget(results, 120_000)
    assert.equal(enforced[0].content, results[0].content)
    assert.ok(enforced[1].content.startsWith('[budget-evicted:'))
  })
})
```

- [ ] **步骤 3：运行测试验证失败**

运行：`node --test src/agent/__tests__/tool-pipeline-budget.test.ts`
预期：FAIL，"Cannot find module '../per-message-budget.js'"

- [ ] **步骤 4：实现 per-message-budget.ts**

```typescript
// src/agent/per-message-budget.ts
import { PER_MESSAGE_TOOL_RESULT_BUDGET_CHARS } from '../compact/constants.js'

const PROTECTED_TOOLS = new Set(['read_file'])

export interface BudgetEntry {
  toolUseId: string
  content: string
  toolName: string
}

export function enforcePerMessageBudget(
  results: BudgetEntry[],
  budget: number = PER_MESSAGE_TOOL_RESULT_BUDGET_CHARS,
): BudgetEntry[] {
  const total = results.reduce((sum, r) => sum + r.content.length, 0)
  if (total <= budget) return results

  // Sort candidates by size descending; protected tools excluded from eviction
  const indexed = results.map((r, i) => ({ ...r, idx: i }))
  const evictable = indexed
    .filter(r => !PROTECTED_TOOLS.has(r.toolName))
    .sort((a, b) => b.content.length - a.content.length)

  const evictSet = new Set<number>()
  let remaining = total
  for (const candidate of evictable) {
    if (remaining <= budget) break
    evictSet.add(candidate.idx)
    remaining -= candidate.content.length
  }

  return results.map((r, i) => {
    if (!evictSet.has(i)) return r
    return {
      ...r,
      content: `[budget-evicted: ${r.content.length} chars from ${r.toolName}. Use read_file with offset/limit to retrieve.]`,
    }
  })
}
```

- [ ] **步骤 5：运行测试验证通过**

运行：`node --test src/agent/__tests__/tool-pipeline-budget.test.ts`
预期：4 tests PASS

- [ ] **步骤 6：Commit**

```bash
git add src/agent/per-message-budget.ts src/agent/__tests__/tool-pipeline-budget.test.ts src/compact/constants.ts
git commit -m "feat(agent): add per-message tool result budget enforcement"
```

---

### 任务 4：集成 per-message budget 到 tool-execution

**文件：**
- 修改：`src/agent/tool-execution.ts:148-159`

- [ ] **步骤 1：修改 tool-execution.ts**

在 `src/agent/tool-execution.ts` 顶部添加 import：

```typescript
import { enforcePerMessageBudget } from './per-message-budget.js'
```

在 `executeBatch` 方法中，`this.deps.addToolResults(toolResults)` 之前（L159），插入 budget enforcement：

```typescript
    // Enforce per-message aggregate budget before adding to conversation.
    // This prevents N parallel tools from collectively overwhelming context.
    const budgetEntries = toolResults
      .filter((r): r is ContentBlock & { type: 'tool_result' } => r.type === 'tool_result')
      .map(r => ({
        toolUseId: r.tool_use_id,
        content: typeof r.content === 'string' ? r.content : '',
        toolName: input.toolUses.find(tu => tu.id === r.tool_use_id)?.name ?? '',
      }))

    const enforced = enforcePerMessageBudget(budgetEntries)
    for (const entry of enforced) {
      const idx = toolResults.findIndex(r => r.type === 'tool_result' && r.tool_use_id === entry.toolUseId)
      if (idx >= 0 && toolResults[idx].type === 'tool_result') {
        const original = toolResults[idx] as ContentBlock & { type: 'tool_result' }
        if (entry.content !== (typeof original.content === 'string' ? original.content : '')) {
          toolResults[idx] = { ...original, content: entry.content }
        }
      }
    }

    this.deps.addToolResults(toolResults)
```

- [ ] **步骤 2：运行 typecheck**

运行：`npm run typecheck`
预期：PASS

- [ ] **步骤 3：运行全量测试**

运行：`npm test 2>&1 | tail -5`
预期：全绿

- [ ] **步骤 4：Commit**

```bash
git add src/agent/tool-execution.ts
git commit -m "feat(agent): integrate per-message budget into tool execution batch"
```

---

### 任务 5：提升 Read 工具 artifact 阈值

**文件：**
- 修改：`src/agent/tool-pipeline.ts:134-141`
- 修改：`src/compact/__tests__/prune.test.ts`（验证 read 不被截断）

- [ ] **步骤 1：修改 tool-pipeline.ts**

将 `src/agent/tool-pipeline.ts` L141 的 `READ_TOOL_THRESHOLD` 从 8000 改为 `Infinity`：

```typescript
const READ_TOOL_THRESHOLD = Infinity // read tools never artifact-intercept; rely on per-message budget + hard truncation
```

同时更新 `artifactIntercept` 函数中的逻辑（L160-165）。当 threshold 为 Infinity 时直接 return：

在 `artifactIntercept` 函数体开头（L158 `if (!artifactStore) return content` 之后）添加：

```typescript
  const isReadTool = READ_TOOLS.has(toolName) || (toolName === 'bash' && isBashReadOnly(toolInput))
  if (isReadTool) return content // read tools bypass artifact intercept entirely
```

并删除后续重复的 `isReadTool` 计算（L160）。最终 L149-180 变为：

```typescript
async function artifactIntercept(
  content: string,
  toolName: string,
  toolInput: Record<string, unknown>,
  artifactStore: ArtifactStore | undefined,
  isError = false,
  thresholdOverride?: number,
  remainingBudgetFraction?: number,
): Promise<string> {
  if (!artifactStore) return content
  // Read-class tools bypass artifact intercept entirely — rely on per-message budget + hard truncation.
  const isReadTool = READ_TOOLS.has(toolName) || (toolName === 'bash' && isBashReadOnly(toolInput))
  if (isReadTool) return content

  let threshold = thresholdOverride ?? (isError ? ARTIFACT_ERROR_THRESHOLD : ARTIFACT_INTERCEPT_THRESHOLD)

  // Budget-aware scaling: when context budget is ample, inline more aggressively
  if (remainingBudgetFraction != null) {
    if (remainingBudgetFraction > 0.5) {
      threshold = Math.max(threshold, threshold * 3)
    } else if (remainingBudgetFraction > 0.3) {
      threshold = Math.max(threshold, threshold * 1.5)
    }
  }

  if (content.length <= threshold) return content
  if (content.startsWith('[artifact:')) return content
```

- [ ] **步骤 2：运行 typecheck**

运行：`npm run typecheck`
预期：PASS

- [ ] **步骤 3：运行全量测试**

运行：`npm test 2>&1 | tail -5`
预期：全绿

- [ ] **步骤 4：Commit**

```bash
git add src/agent/tool-pipeline.ts
git commit -m "perf(agent): read tools bypass artifact intercept — eliminates matryoshka reads"
```

---

### 任务 6：端到端验证

**文件：** 无新文件

- [ ] **步骤 1：运行 typecheck**

运行：`npm run typecheck`
预期：PASS

- [ ] **步骤 2：运行全量测试**

运行：`npm test`
预期：全绿（2340+ tests）

- [ ] **步骤 3：验证 prune 不破坏 cache anchor**

运行：`node --test src/compact/__tests__/prune.test.ts`
预期：全绿

- [ ] **步骤 4：验证 per-message budget**

运行：`node --test src/agent/__tests__/tool-pipeline-budget.test.ts`
预期：全绿

- [ ] **步骤 5：Final commit（如有遗漏修复）**

```bash
git status
# 如果有遗漏的修复，commit
```

---

## 自检

**规格覆盖度：**
- ✅ P0 历史 tool_result 清理 → 任务 1 + 2
- ✅ P1 Per-message 聚合预算 → 任务 3 + 4
- ✅ P2 Read 工具阈值提升 → 任务 5
- ⏭️ P3 Time-based 清理 — 不在本计划范围（需要 session 时间戳追踪，独立计划）

**占位符扫描：** 无 TODO/待定。

**类型一致性：**
- `pruneStaleToolResults` 签名在测试和实现中一致
- `enforcePerMessageBudget` 签名在测试和实现中一致
- `BudgetEntry` 类型在 per-message-budget.ts 中定义，tool-execution.ts 中构造时字段匹配
- `OaiMessage` 的 `tool_call_id` 字段在 prune 中使用 — 需确认 oai-types.ts 中存在（已在 stale-round.ts 中使用过，确认存在）

---

计划已完成并保存到 `docs/superpowers/plans/2026-05-23-context-diet-plan.md`。两种执行方式：

**1. 子代理驱动（推荐）** - 每个任务调度一个新的子代理，任务间进行审查，快速迭代

**2. 内联执行** - 在当前会话中使用 executing-plans 执行任务，批量执行并设有检查点

选哪种方式？
