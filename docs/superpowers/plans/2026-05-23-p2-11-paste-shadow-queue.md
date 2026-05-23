# P2-11: PASTE-lite Shadow Queue 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 从 trace-store 挖掘工具调用序列模式（如 "grep 后 55% 概率 read_file 匹配文件"），维护 shadow queue 在 LLM 生成时预执行高概率下一步工具，命中时直接返回缓存结果。

**架构：** 新建 `ToolPatternMiner` 从历史 trace events 中提取 bigram 转移概率。新建 `ShadowQueue` 在 LLM streaming 期间根据最近 tool call 预测下一步并预执行。结果存入现有 `PrewarmCache`。

**技术栈：** TypeScript / `trace-store.ts` / `prewarm.ts` / `tool-pipeline.ts`

**来源论文**：PASTE（48.5% 任务完成时间减少，93.8% 命中率）

---

## 文件结构

| 文件 | 职责 | 状态 |
|------|------|------|
| `src/agent/tool-pattern-miner.ts` | 从 trace events 提取工具调用 bigram + trigram 转移概率 | ✅ 已实现 |
| `src/agent/__tests__/tool-pattern-miner.test.ts` | miner bigram 测试 | ✅ 已实现 |
| `src/agent/__tests__/tool-pattern-miner-trigram.test.ts` | miner trigram 测试 | ✅ 已实现 |
| `src/agent/shadow-queue.ts` | 预测 + 预执行 + 缓存命中检查 | 待实现 |
| `src/agent/__tests__/shadow-queue.test.ts` | shadow queue 测试 | 待实现 |
| `src/agent/tool-pipeline.ts` | 集成：tool 执行前检查 shadow cache | 待实现 |

---

### 任务 1：Tool Pattern Miner

**文件：**
- 创建：`src/agent/tool-pattern-miner.ts`
- 测试：`src/agent/__tests__/tool-pattern-miner.test.ts`

- [ ] **步骤 1：编写失败的测试**

```typescript
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { ToolPatternMiner } from '../tool-pattern-miner.js'

describe('ToolPatternMiner', () => {
  it('extracts bigram transition probabilities', () => {
    const miner = new ToolPatternMiner()
    // Simulate: grep → read_file (3 times), grep → edit_file (1 time)
    miner.record('grep', 'read_file')
    miner.record('grep', 'read_file')
    miner.record('grep', 'read_file')
    miner.record('grep', 'edit_file')

    const predictions = miner.predict('grep')
    assert.equal(predictions[0].tool, 'read_file')
    assert.equal(predictions[0].probability, 0.75)
  })

  it('returns empty for unknown tool', () => {
    const miner = new ToolPatternMiner()
    const predictions = miner.predict('unknown_tool')
    assert.equal(predictions.length, 0)
  })

  it('filters predictions below threshold', () => {
    const miner = new ToolPatternMiner()
    miner.record('grep', 'read_file')
    miner.record('grep', 'edit_file')
    miner.record('grep', 'bash')
    miner.record('grep', 'write_file')

    // Each has 25% probability, below default 0.3 threshold
    const predictions = miner.predict('grep', 0.3)
    assert.equal(predictions.length, 0)
  })

  it('includes target path from recent history', () => {
    const miner = new ToolPatternMiner()
    miner.record('grep', 'read_file', { targetPath: 'src/foo.ts' })
    miner.record('grep', 'read_file', { targetPath: 'src/foo.ts' })
    miner.record('grep', 'read_file', { targetPath: 'src/bar.ts' })

    const predictions = miner.predict('grep')
    assert.equal(predictions[0].tool, 'read_file')
    assert.equal(predictions[0].likelyTarget, 'src/foo.ts')
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npx tsx --test src/agent/__tests__/tool-pattern-miner.test.ts`
预期：FAIL

- [ ] **步骤 3：实现 miner**

```typescript
export interface ToolPrediction {
  tool: string
  probability: number
  likelyTarget?: string
}

interface BigramEntry {
  tool: string
  targetPath?: string
}

export class ToolPatternMiner {
  private bigrams = new Map<string, BigramEntry[]>()

  record(fromTool: string, toTool: string, meta?: { targetPath?: string }): void {
    const entries = this.bigrams.get(fromTool) ?? []
    entries.push({ tool: toTool, targetPath: meta?.targetPath })
    this.bigrams.set(fromTool, entries.slice(-200))
  }

  predict(fromTool: string, threshold = 0.3): ToolPrediction[] {
    const entries = this.bigrams.get(fromTool)
    if (!entries || entries.length === 0) return []

    const counts = new Map<string, { count: number; targets: string[] }>()
    for (const e of entries) {
      const existing = counts.get(e.tool) ?? { count: 0, targets: [] }
      existing.count++
      if (e.targetPath) existing.targets.push(e.targetPath)
      counts.set(e.tool, existing)
    }

    const total = entries.length
    const predictions: ToolPrediction[] = []
    for (const [tool, { count, targets }] of counts) {
      const probability = count / total
      if (probability < threshold) continue
      const targetCounts = new Map<string, number>()
      for (const t of targets) targetCounts.set(t, (targetCounts.get(t) ?? 0) + 1)
      let likelyTarget: string | undefined
      let maxCount = 0
      for (const [t, c] of targetCounts) {
        if (c > maxCount) { maxCount = c; likelyTarget = t }
      }
      predictions.push({ tool, probability, likelyTarget })
    }

    return predictions.sort((a, b) => b.probability - a.probability)
  }
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`npx tsx --test src/agent/__tests__/tool-pattern-miner.test.ts`
预期：PASS

- [ ] **步骤 5：Commit**

```bash
git add src/agent/tool-pattern-miner.ts src/agent/__tests__/tool-pattern-miner.test.ts
git commit -m "feat(agent): add ToolPatternMiner for tool call sequence prediction"
```

---

### 任务 2：Shadow Queue

**文件：**
- 创建：`src/agent/shadow-queue.ts`
- 测试：`src/agent/__tests__/shadow-queue.test.ts`

- [ ] **步骤 1：编写失败的测试**

```typescript
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { ShadowQueue } from '../shadow-queue.js'

describe('ShadowQueue', () => {
  it('enqueues predicted tool execution', () => {
    const executed: string[] = []
    const queue = new ShadowQueue({
      execute: async (tool, target) => { executed.push(`${tool}:${target}`); return 'result' },
    })

    queue.enqueue({ tool: 'read_file', probability: 0.8, likelyTarget: 'src/foo.ts' })
    assert.equal(queue.pending(), 1)
  })

  it('returns cached result on hit', async () => {
    const queue = new ShadowQueue({
      execute: async () => 'cached-content',
    })

    queue.enqueue({ tool: 'read_file', probability: 0.8, likelyTarget: 'src/foo.ts' })
    // Wait for execution
    await new Promise(r => setTimeout(r, 10))

    const hit = queue.checkHit('read_file', 'src/foo.ts')
    assert.equal(hit, 'cached-content')
  })

  it('returns undefined on miss', () => {
    const queue = new ShadowQueue({
      execute: async () => 'content',
    })
    const hit = queue.checkHit('read_file', 'src/bar.ts')
    assert.equal(hit, undefined)
  })

  it('evicts stale entries after max age', async () => {
    const queue = new ShadowQueue({
      execute: async () => 'content',
      maxAgeMs: 50,
    })

    queue.enqueue({ tool: 'read_file', probability: 0.8, likelyTarget: 'src/foo.ts' })
    await new Promise(r => setTimeout(r, 60))

    const hit = queue.checkHit('read_file', 'src/foo.ts')
    assert.equal(hit, undefined)
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npx tsx --test src/agent/__tests__/shadow-queue.test.ts`
预期：FAIL

- [ ] **步骤 3：实现 shadow queue**

```typescript
import type { ToolPrediction } from './tool-pattern-miner.js'

interface ShadowEntry {
  tool: string
  target: string
  result: Promise<string>
  resolvedAt?: number
  value?: string
}

export interface ShadowQueueDeps {
  execute: (tool: string, target: string) => Promise<string>
  maxAgeMs?: number
}

export class ShadowQueue {
  private cache = new Map<string, ShadowEntry>()
  private readonly maxAgeMs: number
  private readonly execute: ShadowQueueDeps['execute']

  constructor(deps: ShadowQueueDeps) {
    this.execute = deps.execute
    this.maxAgeMs = deps.maxAgeMs ?? 30_000
  }

  private key(tool: string, target: string): string {
    return `${tool}:${target}`
  }

  enqueue(prediction: ToolPrediction): void {
    if (!prediction.likelyTarget) return
    const k = this.key(prediction.tool, prediction.likelyTarget)
    if (this.cache.has(k)) return

    const entry: ShadowEntry = {
      tool: prediction.tool,
      target: prediction.likelyTarget,
      result: this.execute(prediction.tool, prediction.likelyTarget).then(v => {
        entry.value = v
        entry.resolvedAt = Date.now()
        return v
      }),
    }
    this.cache.set(k, entry)
  }

  checkHit(tool: string, target: string): string | undefined {
    const k = this.key(tool, target)
    const entry = this.cache.get(k)
    if (!entry || entry.value === undefined) return undefined
    if (Date.now() - (entry.resolvedAt ?? 0) > this.maxAgeMs) {
      this.cache.delete(k)
      return undefined
    }
    this.cache.delete(k)
    return entry.value
  }

  pending(): number {
    return this.cache.size
  }

  clear(): void {
    this.cache.clear()
  }
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`npx tsx --test src/agent/__tests__/shadow-queue.test.ts`
预期：PASS

- [ ] **步骤 5：Commit**

```bash
git add src/agent/shadow-queue.ts src/agent/__tests__/shadow-queue.test.ts
git commit -m "feat(agent): add ShadowQueue for speculative tool pre-execution"
```

---

### 任务 3：集成到 tool-pipeline

**文件：**
- 修改：`src/agent/tool-pipeline.ts`

- [ ] **步骤 1：在 tool 执行前检查 shadow cache**

在 `tool-pipeline.ts` 的工具执行逻辑中，实际执行前检查 shadow queue：

```typescript
// Before actual tool execution:
const shadowHit = this.shadowQueue?.checkHit(toolUse.name, toolUse.input?.file_path ?? toolUse.input?.path ?? '')
if (shadowHit !== undefined) {
  // Use cached result, skip actual execution
  return { content: shadowHit, fromShadow: true }
}
```

- [ ] **步骤 2：在 tool 执行后 feed pattern miner**

在工具执行完成后，记录 bigram：

```typescript
// After tool execution completes:
if (this.patternMiner && previousToolName) {
  this.patternMiner.record(previousToolName, toolUse.name, { targetPath: toolUse.input?.file_path })
}
```

- [ ] **步骤 3：在 LLM streaming 期间触发预测**

在 turn 开始（LLM 开始生成）时，根据最近一次 tool call 预测并 enqueue：

```typescript
const predictions = this.patternMiner.predict(lastToolName)
for (const pred of predictions.slice(0, 2)) {
  this.shadowQueue.enqueue(pred)
}
```

- [ ] **步骤 4：运行 typecheck + 全量测试**

运行：`npx tsc --noEmit && npm test`
预期：PASS

- [ ] **步骤 5：Commit**

```bash
git add src/agent/tool-pipeline.ts
git commit -m "feat(agent): integrate shadow queue into tool pipeline"
```
