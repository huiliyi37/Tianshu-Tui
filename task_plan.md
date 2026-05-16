# Adaptive Context Fabric (ACF) 实施计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 让 Rivet 在 8K-1M 全范围窗口模型上零溢出运行长会话，保持 DeepSeek V4 99% 缓存命中率，超越所有竞品的上下文管理能力。

**架构：** 三层存储（L1 全文 / L2 摘要+锚点 / L3 冷存储+recall）+ 结构性锚点（关键信息零丢失）+ PSI 风格分级压力响应 + Provider-aware 消息组装策略。

**技术栈：** TypeScript, Node.js, Zod (validation), existing Rivet infrastructure (rounds, ledger, output-store)

---

## 文件结构

### 新建文件

| 文件 | 职责 |
|------|------|
| `src/context/pressure-monitor.ts` | PSI 风格压力检测：利用率 + 压缩频率 → tier 决策 |
| `src/context/anchor-registry.ts` | 不可驱逐锚点的提取、存储、预算管理 |
| `src/context/proactive-inject.ts` | 每轮前基于 task-state 主动从冷存储注入相关上下文 |
| `src/context/persistent-store.ts` | 冷存储：SHA-256 索引的 tool_result 归档 |
| `src/api/provider-profile.ts` | 各 Provider 缓存配置（窗口、缓存类型、最小 token、粒度） |
| `src/api/cache-strategy.ts` | 策略模式：按 provider 差异化消息组装 |
| `src/tools/recall.ts` | recall 内置工具：从 persistent-store 检索已归档内容 |
| `src/__tests__/pressure-monitor.test.ts` | 压力监控测试 |
| `src/__tests__/anchor-registry.test.ts` | 锚点注册表测试 |
| `src/__tests__/persistent-store.test.ts` | 冷存储测试 |
| `src/__tests__/provider-profile.test.ts` | Provider 配置测试 |
| `src/__tests__/recall.test.ts` | recall 工具测试 |

### 修改文件

| 文件 | 变更 |
|------|------|
| `src/compact/constants.ts` | 绝对值阈值 → `contextWindow` 百分比函数 |
| `src/context/compact-policy.ts` | 成为唯一压缩决策者（不再需要 auto.ts 同意） |
| `src/agent/loop.ts:229-257` | 压缩触发逻辑重构：PressureMonitor 驱动 |
| `src/agent/loop.ts` | 每轮前调用 proactive-inject |
| `src/config/schema.ts` | 增加 provider profile 配置 |
| `src/tools/default-registry.ts` | 注册 recall 工具 |

---

## Phase 1：基础安全层（零溢出保证）

### 任务 1.1：百分比化阈值

**文件：**
- 修改：`src/compact/constants.ts`
- 测试：`src/__tests__/compact-constants.test.ts`（已有，验证新导出）

- [ ] **步骤 1：修改 constants.ts 导出百分比计算函数**

```typescript
// src/compact/constants.ts - 替换绝对值为工厂函数

export const CACHE_ANCHOR_MESSAGES = 2
export const KEEP_RECENT_MESSAGES = 4
export const MIN_SUMMARIZE_MESSAGES = 6

// 百分比化阈值（替代旧的绝对值）
export function compactThresholds(contextWindow: number) {
  return {
    autoFloor: Math.floor(contextWindow * 0.5),
    autoThreshold: Math.floor(contextWindow * 0.8),
    ceilingThreshold: Math.floor(contextWindow * 0.95),
    toolResultMaxTokens: Math.min(Math.floor(contextWindow * 0.3), 100_000),
  }
}

// 保留旧常量用于向后兼容（默认 1M 窗口）
export const AUTO_COMPACT_THRESHOLD = 800_000
export const MINIMUM_AUTO_COMPACT_TOKENS = 500_000

// Summary 限制保持不变
export const SUMMARY_INPUT_MAX_CHARS = 24_000
export const SUMMARY_INPUT_HEAD_CHARS = 14_000
export const SUMMARY_INPUT_TAIL_CHARS = 6_000
export const LARGE_CONTEXT_WINDOW_TOKENS = 500_000
export const LARGE_CONTEXT_SUMMARY_INPUT_MAX_CHARS = 120_000
export const LARGE_CONTEXT_SUMMARY_INPUT_HEAD_CHARS = 72_000
export const LARGE_CONTEXT_SUMMARY_INPUT_TAIL_CHARS = 36_000
export const LARGE_CONTEXT_SUMMARY_MAX_TOKENS = 2_048
export const CACHE_ALIGNED_BUDGET_PERCENT = 85
export const COMPACTION_SUMMARY_MAX_TOKENS = 1_024
export const TOOL_RESULT_PREVIEW_CHARS = 1200

export interface CompactionConfig {
  enabled: boolean
  autoThreshold: number
  autoFloor: number
  model: string
}
```

- [ ] **步骤 2：编写测试验证 compactThresholds**

```typescript
// src/__tests__/compact-thresholds.test.ts
import { describe, it, expect } from 'vitest'
import { compactThresholds } from '../compact/constants.js'

describe('compactThresholds', () => {
  it('scales to 128K window', () => {
    const t = compactThresholds(128_000)
    expect(t.autoFloor).toBe(64_000)
    expect(t.autoThreshold).toBe(102_400)
    expect(t.ceilingThreshold).toBe(121_600)
    expect(t.toolResultMaxTokens).toBe(38_400)
  })

  it('scales to 1M window', () => {
    const t = compactThresholds(1_000_000)
    expect(t.autoFloor).toBe(500_000)
    expect(t.autoThreshold).toBe(800_000)
    expect(t.ceilingThreshold).toBe(950_000)
    expect(t.toolResultMaxTokens).toBe(100_000) // capped
  })

  it('scales to 8K window', () => {
    const t = compactThresholds(8_000)
    expect(t.autoFloor).toBe(4_000)
    expect(t.autoThreshold).toBe(6_400)
    expect(t.toolResultMaxTokens).toBe(2_400)
  })
})
```

- [ ] **步骤 3：运行测试验证通过**

运行：`npm test -- src/__tests__/compact-thresholds.test.ts`
预期：PASS

- [ ] **步骤 4：Commit**

```bash
git add src/compact/constants.ts src/__tests__/compact-thresholds.test.ts
git commit -m "feat(context): add percentage-based compactThresholds factory"
```

---

### 任务 1.2：解除 AND 关系 — compact-policy 独立驱动

**文件：**
- 修改：`src/agent/loop.ts:229-257`
- 修改：`src/context/compact-policy.ts`
- 测试：已有 compact-policy 测试覆盖

- [ ] **步骤 1：修改 loop.ts 压缩触发逻辑**

将 `loop.ts:236` 的 `if (compactDecision.shouldCompact && legacyDecision.shouldCompact)` 改为仅依赖 compact-policy：

```typescript
// src/agent/loop.ts - 替换双重判断
const compactDecision = decideCompactTier({
  estimatedTokens: estTokens,
  maxTokens: this.config.contextWindow,
  turn: this.session.getTurnCount(),
  failures: this.compactFailures,
})
// 去掉 legacyDecision，compact-policy 独立驱动
if (compactDecision.shouldCompact) {
  // ... existing compact logic
}
```

- [ ] **步骤 2：在 compact-policy 中增加 ceiling 硬保护**

```typescript
// src/context/compact-policy.ts - 增加 ceiling tier
function tierForRatio(ratio: number): CompactTier {
  if (ratio >= 0.95) return 4  // ceiling: last-resort
  if (ratio >= 0.88) return 3  // aggressive
  if (ratio >= 0.78) return 2  // reactive
  if (ratio >= 0.6) return 1   // gentle
  return 0
}
```

（已经是这样实现的，无需修改——验证即可）

- [ ] **步骤 3：运行现有测试确保无回归**

运行：`npm test -- src/__tests__/compact-policy.test.ts`
预期：PASS

- [ ] **步骤 4：运行全量测试**

运行：`npm test`
预期：705 tests PASS

- [ ] **步骤 5：Commit**

```bash
git add src/agent/loop.ts
git commit -m "refactor(agent): compact-policy independently drives compaction decisions"
```

---

### 任务 1.3：单次 tool_result 大小限制（防单次溢出）

**文件：**
- 修改：`src/tools/truncation.ts`
- 测试：`src/__tests__/tool-truncation.test.ts`

- [ ] **步骤 1：编写失败的测试**

```typescript
// src/__tests__/tool-truncation.test.ts
import { describe, it, expect } from 'vitest'
import { truncateToolOutput } from '../tools/truncation.js'

describe('truncateToolOutput with contextWindow limit', () => {
  it('truncates output exceeding 30% of contextWindow', () => {
    const output = 'x'.repeat(50_000)
    const result = truncateToolOutput(output, { contextWindow: 128_000 })
    // 30% of 128K = 38,400 chars ≈ 9,600 tokens
    expect(result.length).toBeLessThanOrEqual(38_400)
    expect(result).toContain('[truncated')
  })

  it('caps at 100K chars regardless of window size', () => {
    const output = 'x'.repeat(500_000)
    const result = truncateToolOutput(output, { contextWindow: 1_000_000 })
    expect(result.length).toBeLessThanOrEqual(100_000)
  })

  it('preserves short output unchanged', () => {
    const output = 'hello world'
    const result = truncateToolOutput(output, { contextWindow: 128_000 })
    expect(result).toBe('hello world')
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npm test -- src/__tests__/tool-truncation.test.ts`
预期：FAIL（truncateToolOutput 签名不匹配或不存在 contextWindow 参数）

- [ ] **步骤 3：实现 contextWindow-aware truncation**

查看现有 `src/tools/truncation.ts` 实现，添加 `contextWindow` 参数支持：

```typescript
// src/tools/truncation.ts - 添加 contextWindow-aware 截断
export interface TruncationOptions {
  contextWindow?: number
  maxChars?: number
}

export function truncateToolOutput(
  output: string,
  options: TruncationOptions = {},
): string {
  const contextWindow = options.contextWindow ?? 1_000_000
  const maxChars = Math.min(
    options.maxChars ?? Infinity,
    Math.floor(contextWindow * 0.3),
    100_000,
  )
  if (output.length <= maxChars) return output

  const half = Math.floor(maxChars / 2) - 50
  const head = output.slice(0, half)
  const tail = output.slice(-half)
  return `${head}\n\n[truncated: ${output.length} chars total, showing head+tail]\n\n${tail}`
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`npm test -- src/__tests__/tool-truncation.test.ts`
预期：PASS

- [ ] **步骤 5：Commit**

```bash
git add src/tools/truncation.ts src/__tests__/tool-truncation.test.ts
git commit -m "feat(tools): contextWindow-aware tool output truncation prevents single-response overflow"
```

---

### 任务 1.4：Ceiling 硬保护（last-resort checkpoint-resume）

**文件：**
- 修改：`src/agent/loop.ts`
- 依赖：`src/agent/checkpoint.ts`（已有）, `src/agent/task-state.ts`（已有）

- [ ] **步骤 1：在 loop.ts 中添加 ceiling 保护**

在压缩决策之后、API 调用之前，增加硬 ceiling 检查：

```typescript
// src/agent/loop.ts - 在 compactDecision 处理之后添加
if (this.session.getEstimatedTokens() > this.config.contextWindow * 0.95) {
  // Last resort: micro-compact + if still over, extract task state and restart
  const { messages: emergency } = microCompact(
    this.session.getMessages(),
    this.config.contextWindow,
    this.session.getEstimatedTokens(),
  )
  this.session.replaceMessages(emergency)

  if (this.session.getEstimatedTokens() > this.config.contextWindow * 0.95) {
    // Extract task state and synthesize a resume message
    const taskState = extractTaskState(this.trajectory, this.session.getMessages())
    const anchorMessages = this.session.getMessages().slice(0, CACHE_ANCHOR_MESSAGES)
    const resumeMsg: Message = {
      role: 'user',
      content: `<context-resume reason="ceiling_protection">\n${taskState}\n</context-resume>\nPlease continue the current task.`,
    }
    this.session.replaceMessages([...anchorMessages, resumeMsg])
    callbacks.onNotification?.('Context ceiling reached — resumed with task state.')
  }
}
```

- [ ] **步骤 2：运行全量测试确保无回归**

运行：`npm test`
预期：705+ tests PASS

- [ ] **步骤 3：Commit**

```bash
git add src/agent/loop.ts
git commit -m "feat(agent): ceiling protection — last-resort checkpoint-resume at 95% capacity"
```

---

## Phase 2：结构性锚点 + 主动预注入

### 任务 2.1：PressureMonitor（PSI 风格压力检测）

**文件：**
- 创建：`src/context/pressure-monitor.ts`
- 测试：`src/__tests__/pressure-monitor.test.ts`

- [ ] **步骤 1：编写失败的测试**

```typescript
// src/__tests__/pressure-monitor.test.ts
import { describe, it, expect } from 'vitest'
import { PressureMonitor } from '../context/pressure-monitor.js'

describe('PressureMonitor', () => {
  it('returns tier 0 when under 60%', () => {
    const pm = new PressureMonitor(100_000)
    const result = pm.check(50_000, 5)
    expect(result.tier).toBe(0)
    expect(result.shouldCompact).toBe(false)
  })

  it('returns tier 2 at 80% utilization', () => {
    const pm = new PressureMonitor(100_000)
    const result = pm.check(80_000, 5)
    expect(result.tier).toBe(2)
    expect(result.shouldCompact).toBe(true)
  })

  it('detects thrashing when compact frequency > 1 per 2 turns', () => {
    const pm = new PressureMonitor(100_000)
    pm.recordCompaction(1)
    pm.recordCompaction(2)
    pm.recordCompaction(3)
    const result = pm.check(70_000, 4)
    expect(result.thrashing).toBe(true)
  })

  it('suggests task decomposition when thrashing', () => {
    const pm = new PressureMonitor(100_000)
    pm.recordCompaction(1)
    pm.recordCompaction(2)
    pm.recordCompaction(3)
    const result = pm.check(70_000, 4)
    expect(result.suggestion).toBe('task_decomposition')
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npm test -- src/__tests__/pressure-monitor.test.ts`
预期：FAIL（模块不存在）

- [ ] **步骤 3：实现 PressureMonitor**

```typescript
// src/context/pressure-monitor.ts
import type { CompactTier } from './types.js'

export interface PressureResult {
  tier: CompactTier
  shouldCompact: boolean
  thrashing: boolean
  suggestion?: 'task_decomposition'
  ratio: number
}

export class PressureMonitor {
  private compactionTurns: number[] = []

  constructor(private contextWindow: number) {}

  check(estimatedTokens: number, currentTurn: number): PressureResult {
    const ratio = this.contextWindow > 0 ? estimatedTokens / this.contextWindow : 1
    const tier = this.tierForRatio(ratio)
    const thrashing = this.detectThrashing(currentTurn)

    return {
      tier,
      shouldCompact: tier > 0,
      thrashing,
      suggestion: thrashing ? 'task_decomposition' : undefined,
      ratio,
    }
  }

  recordCompaction(turn: number): void {
    this.compactionTurns.push(turn)
    if (this.compactionTurns.length > 10) this.compactionTurns.shift()
  }

  private tierForRatio(ratio: number): CompactTier {
    if (ratio >= 0.95) return 4
    if (ratio >= 0.88) return 3
    if (ratio >= 0.78) return 2
    if (ratio >= 0.6) return 1
    return 0
  }

  private detectThrashing(currentTurn: number): boolean {
    const recentWindow = 4
    const recentCompactions = this.compactionTurns.filter(
      t => currentTurn - t <= recentWindow
    )
    return recentCompactions.length >= 3
  }
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`npm test -- src/__tests__/pressure-monitor.test.ts`
预期：PASS

- [ ] **步骤 5：Commit**

```bash
git add src/context/pressure-monitor.ts src/__tests__/pressure-monitor.test.ts
git commit -m "feat(context): PressureMonitor with PSI-style thrashing detection"
```

---

### 任务 2.2：Anchor Registry（结构性锚点）

**文件：**
- 创建：`src/context/anchor-registry.ts`
- 测试：`src/__tests__/anchor-registry.test.ts`

- [ ] **步骤 1：编写失败的测试**

```typescript
// src/__tests__/anchor-registry.test.ts
import { describe, it, expect } from 'vitest'
import { AnchorRegistry } from '../context/anchor-registry.js'

describe('AnchorRegistry', () => {
  it('extracts constraint from user message with imperative language', () => {
    const registry = new AnchorRegistry(10_000) // 10K token budget
    registry.processUserMessage('不要动缓存代码，只改 loop.ts', 5)
    const anchors = registry.getAnchors()
    expect(anchors).toHaveLength(1)
    expect(anchors[0].kind).toBe('user_constraint')
    expect(anchors[0].text).toContain('不要动缓存代码')
  })

  it('extracts decision from assistant message', () => {
    const registry = new AnchorRegistry(10_000)
    registry.processDecision('选择方案 V3：三层存储 + 结构性锚点', 8)
    const anchors = registry.getAnchors()
    expect(anchors[0].kind).toBe('decision')
  })

  it('respects budget limit', () => {
    const registry = new AnchorRegistry(100) // tiny budget
    for (let i = 0; i < 20; i++) {
      registry.processUserMessage(`constraint ${i}: do not touch file${i}.ts`, i)
    }
    const totalTokens = registry.estimateTokens()
    expect(totalTokens).toBeLessThanOrEqual(100)
  })

  it('evicts lowest salience when over budget', () => {
    const registry = new AnchorRegistry(50)
    registry.processUserMessage('CRITICAL: never delete the database', 1)
    registry.processUserMessage('maybe use tabs instead of spaces', 2)
    registry.processUserMessage('IMPORTANT: always run tests before commit', 3)
    // Budget exceeded → lowest salience evicted
    const anchors = registry.getAnchors()
    const texts = anchors.map(a => a.text)
    expect(texts.some(t => t.includes('never delete'))).toBe(true)
    expect(texts.some(t => t.includes('always run tests'))).toBe(true)
  })

  it('renders anchors as compact text block', () => {
    const registry = new AnchorRegistry(10_000)
    registry.processUserMessage('use TDD workflow', 1)
    registry.processDecision('chose Zod for validation', 2)
    const block = registry.renderBlock()
    expect(block).toContain('<pinned-anchors>')
    expect(block).toContain('use TDD')
    expect(block).toContain('chose Zod')
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npm test -- src/__tests__/anchor-registry.test.ts`
预期：FAIL

- [ ] **步骤 3：实现 AnchorRegistry**

```typescript
// src/context/anchor-registry.ts
import type { ContextAnchor } from './types.js'

const CONSTRAINT_PATTERNS = [
  /不要|不能|禁止|必须|一定要|always|never|don'?t|must|do not/i,
]

const DECISION_KEYWORDS = [
  '选择', '决定', '用', 'chose', 'decided', 'selected', 'using',
]

function estimateAnchorTokens(text: string): number {
  return Math.ceil(text.length / 3)
}

function scoreSalience(text: string, round: number): number {
  let score = 1
  if (/CRITICAL|IMPORTANT|重要|关键/i.test(text)) score += 3
  if (CONSTRAINT_PATTERNS.some(p => p.test(text))) score += 2
  // Recency bonus (decays)
  score += Math.max(0, 5 - Math.floor(round / 10))
  return score
}

export class AnchorRegistry {
  private anchors: ContextAnchor[] = []

  constructor(private budgetTokens: number) {}

  processUserMessage(text: string, round: number): void {
    if (CONSTRAINT_PATTERNS.some(p => p.test(text))) {
      this.addAnchor({
        kind: 'user_preference',
        text: text.slice(0, 200),
        sourceRoundIndex: round,
        salience: scoreSalience(text, round),
      })
    }
  }

  processDecision(text: string, round: number): void {
    this.addAnchor({
      kind: 'decision',
      text: text.slice(0, 200),
      sourceRoundIndex: round,
      salience: scoreSalience(text, round),
    })
  }

  getAnchors(): ContextAnchor[] {
    return [...this.anchors]
  }

  estimateTokens(): number {
    return this.anchors.reduce((sum, a) => sum + estimateAnchorTokens(a.text), 0)
  }

  renderBlock(): string {
    if (this.anchors.length === 0) return ''
    const entries = this.anchors.map(a =>
      `  <anchor kind="${a.kind}" round="${a.sourceRoundIndex}">${a.text}</anchor>`
    )
    return `<pinned-anchors>\n${entries.join('\n')}\n</pinned-anchors>`
  }

  private addAnchor(anchor: ContextAnchor): void {
    this.anchors.push(anchor)
    this.enforceBudget()
  }

  private enforceBudget(): void {
    while (this.estimateTokens() > this.budgetTokens && this.anchors.length > 1) {
      let minIdx = 0
      let minSalience = Infinity
      for (let i = 0; i < this.anchors.length; i++) {
        if (this.anchors[i].salience < minSalience) {
          minSalience = this.anchors[i].salience
          minIdx = i
        }
      }
      this.anchors.splice(minIdx, 1)
    }
  }
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`npm test -- src/__tests__/anchor-registry.test.ts`
预期：PASS

- [ ] **步骤 5：Commit**

```bash
git add src/context/anchor-registry.ts src/__tests__/anchor-registry.test.ts
git commit -m "feat(context): AnchorRegistry — pinned anchors with budget enforcement"
```

---

### 任务 2.3：Persistent Store（冷存储归档）

**文件：**
- 创建：`src/context/persistent-store.ts`
- 测试：`src/__tests__/persistent-store.test.ts`

- [ ] **步骤 1：编写失败的测试**

```typescript
// src/__tests__/persistent-store.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { PersistentStore } from '../context/persistent-store.js'

describe('PersistentStore', () => {
  let dir: string
  let store: PersistentStore

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rivet-ps-'))
    store = new PersistentStore(dir)
  })

  it('archives and retrieves tool result by id', () => {
    const id = store.archive({
      toolName: 'read_file',
      content: 'file contents here',
      sessionId: 'sess-1',
      roundNumber: 5,
    })
    const retrieved = store.retrieve(id)
    expect(retrieved?.content).toBe('file contents here')
    expect(retrieved?.toolName).toBe('read_file')
  })

  it('searches by tool name', () => {
    store.archive({ toolName: 'bash', content: 'npm test output', sessionId: 's', roundNumber: 1 })
    store.archive({ toolName: 'read_file', content: 'src/main.tsx', sessionId: 's', roundNumber: 2 })
    const results = store.search({ toolName: 'bash', limit: 5 })
    expect(results).toHaveLength(1)
    expect(results[0].content).toContain('npm test')
  })

  it('respects disk limit', () => {
    store = new PersistentStore(dir, { maxDiskBytes: 100 })
    store.archive({ toolName: 'bash', content: 'x'.repeat(200), sessionId: 's', roundNumber: 1 })
    // Should still work but evict oldest when over limit
    const all = store.search({ limit: 100 })
    expect(all.length).toBeLessThanOrEqual(1)
  })
})
```

- [ ] **步骤 2：实现 PersistentStore**

```typescript
// src/context/persistent-store.ts
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'

interface ArchiveEntry {
  id: string
  toolName: string
  content: string
  sessionId: string
  roundNumber: number
  timestamp: string
  size: number
}

interface ArchiveInput {
  toolName: string
  content: string
  sessionId: string
  roundNumber: number
}

interface SearchQuery {
  toolName?: string
  query?: string
  since?: string
  limit?: number
}

interface StoreOptions {
  maxDiskBytes?: number
}

export class PersistentStore {
  private dir: string
  private maxDiskBytes: number

  constructor(dir: string, options?: StoreOptions) {
    this.dir = dir
    this.maxDiskBytes = options?.maxDiskBytes ?? 100 * 1024 * 1024 // 100MB
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  }

  archive(input: ArchiveInput): string {
    const timestamp = new Date().toISOString()
    const id = createHash('sha256')
      .update(`${input.sessionId}:${input.roundNumber}:${input.toolName}:${timestamp}`)
      .digest('hex').slice(0, 16)
    const entry: ArchiveEntry = {
      id, ...input, timestamp, size: input.content.length,
    }
    writeFileSync(join(this.dir, `${id}.json`), JSON.stringify(entry))
    this.enforceLimit()
    return id
  }

  retrieve(id: string): ArchiveEntry | null {
    const path = join(this.dir, `${id}.json`)
    if (!existsSync(path)) return null
    return JSON.parse(readFileSync(path, 'utf-8'))
  }

  search(query: SearchQuery): ArchiveEntry[] {
    const limit = query.limit ?? 5
    const files = readdirSync(this.dir).filter(f => f.endsWith('.json'))
    const entries: ArchiveEntry[] = []
    for (const file of files) {
      const entry: ArchiveEntry = JSON.parse(readFileSync(join(this.dir, file), 'utf-8'))
      if (query.toolName && entry.toolName !== query.toolName) continue
      if (query.query && !entry.content.includes(query.query)) continue
      if (query.since && entry.timestamp < query.since) continue
      entries.push(entry)
    }
    return entries.sort((a, b) => b.timestamp.localeCompare(a.timestamp)).slice(0, limit)
  }

  private enforceLimit(): void {
    const files = readdirSync(this.dir).filter(f => f.endsWith('.json'))
    let totalSize = 0
    const entries: { file: string; time: string; size: number }[] = []
    for (const file of files) {
      const stat = statSync(join(this.dir, file))
      totalSize += stat.size
      entries.push({ file, time: file, size: stat.size })
    }
    if (totalSize <= this.maxDiskBytes) return
    entries.sort((a, b) => a.time.localeCompare(b.time))
    while (totalSize > this.maxDiskBytes && entries.length > 0) {
      const oldest = entries.shift()!
      unlinkSync(join(this.dir, oldest.file))
      totalSize -= oldest.size
    }
  }
}
```

- [ ] **步骤 3：运行测试验证通过**

运行：`npm test -- src/__tests__/persistent-store.test.ts`
预期：PASS

- [ ] **步骤 4：Commit**

```bash
git add src/context/persistent-store.ts src/__tests__/persistent-store.test.ts
git commit -m "feat(context): PersistentStore — SHA-256 indexed cold storage for evicted content"
```

---

## Phase 3：Provider-Aware 消息组装

### 任务 3.1：Provider Profile 配置

**文件：**
- 创建：`src/api/provider-profile.ts`
- 测试：`src/__tests__/provider-profile.test.ts`

- [ ] **步骤 1：编写测试**

```typescript
// src/__tests__/provider-profile.test.ts
import { describe, it, expect } from 'vitest'
import { getProviderProfile, type ProviderProfile } from '../api/provider-profile.js'

describe('getProviderProfile', () => {
  it('returns deepseek profile', () => {
    const p = getProviderProfile('deepseek')
    expect(p.cacheType).toBe('exact-prefix')
    expect(p.persistent).toBe(true)
    expect(p.minCacheTokens).toBe(64)
  })

  it('returns claude profile', () => {
    const p = getProviderProfile('anthropic')
    expect(p.cacheType).toBe('explicit-breakpoint')
    expect(p.minCacheTokens).toBe(1024)
  })

  it('returns openai profile', () => {
    const p = getProviderProfile('openai')
    expect(p.cacheType).toBe('partial-prefix')
    expect(p.cacheGranularity).toBe(128)
  })

  it('returns none profile for unknown', () => {
    const p = getProviderProfile('unknown-local')
    expect(p.cacheType).toBe('none')
  })
})
```

- [ ] **步骤 2：实现 provider-profile**

```typescript
// src/api/provider-profile.ts
export type CacheType = 'exact-prefix' | 'explicit-breakpoint' | 'partial-prefix' | 'block-kv' | 'none'

export interface ProviderProfile {
  cacheType: CacheType
  persistent: boolean
  minCacheTokens: number
  cacheGranularity?: number
  ttlSeconds?: number
  contextWindow: number
}

const PROFILES: Record<string, Omit<ProviderProfile, 'contextWindow'>> = {
  deepseek: { cacheType: 'exact-prefix', persistent: true, minCacheTokens: 64 },
  anthropic: { cacheType: 'explicit-breakpoint', persistent: false, minCacheTokens: 1024, ttlSeconds: 300 },
  openai: { cacheType: 'partial-prefix', persistent: false, minCacheTokens: 1024, cacheGranularity: 128, ttlSeconds: 600 },
  google: { cacheType: 'explicit-breakpoint', persistent: false, minCacheTokens: 4096, ttlSeconds: 3600 },
  qwen: { cacheType: 'explicit-breakpoint', persistent: false, minCacheTokens: 1024, ttlSeconds: 300 },
  vllm: { cacheType: 'block-kv', persistent: false, minCacheTokens: 0 },
}

export function getProviderProfile(provider: string, contextWindow?: number): ProviderProfile {
  const base = PROFILES[provider] ?? { cacheType: 'none' as CacheType, persistent: false, minCacheTokens: 0 }
  return { ...base, contextWindow: contextWindow ?? 128_000 }
}
```

- [ ] **步骤 3：运行测试**

运行：`npm test -- src/__tests__/provider-profile.test.ts`
预期：PASS

- [ ] **步骤 4：Commit**

```bash
git add src/api/provider-profile.ts src/__tests__/provider-profile.test.ts
git commit -m "feat(api): ProviderProfile — cache configuration per provider"
```

---

### 任务 3.2：Cache Strategy（消息组装策略）

**文件：**
- 创建：`src/api/cache-strategy.ts`
- 测试：`src/__tests__/cache-strategy.test.ts`

- [ ] **步骤 1：编写测试**

```typescript
// src/__tests__/cache-strategy.test.ts
import { describe, it, expect } from 'vitest'
import { applyCacheStrategy } from '../api/cache-strategy.js'
import type { Message } from '../api/types.js'

describe('applyCacheStrategy', () => {
  const messages: Message[] = [
    { role: 'user', content: 'system prompt here' },
    { role: 'assistant', content: 'acknowledged' },
    { role: 'user', content: 'do something' },
  ]

  it('deepseek: returns messages unchanged (auto prefix cache)', () => {
    const result = applyCacheStrategy(messages, { cacheType: 'exact-prefix', persistent: true, minCacheTokens: 64, contextWindow: 1_000_000 })
    expect(result).toEqual(messages)
  })

  it('anthropic: injects cache_control after anchor messages', () => {
    const result = applyCacheStrategy(messages, { cacheType: 'explicit-breakpoint', persistent: false, minCacheTokens: 1024, contextWindow: 200_000 })
    // Should have cache_control on the system/tools boundary
    expect(result[1]).toHaveProperty('cache_control')
  })

  it('none: returns messages unchanged', () => {
    const result = applyCacheStrategy(messages, { cacheType: 'none', persistent: false, minCacheTokens: 0, contextWindow: 32_000 })
    expect(result).toEqual(messages)
  })
})
```

- [ ] **步骤 2：实现 cache-strategy**

```typescript
// src/api/cache-strategy.ts
import type { Message } from './types.js'
import type { ProviderProfile } from './provider-profile.js'
import { CACHE_ANCHOR_MESSAGES } from '../compact/constants.js'

export function applyCacheStrategy(messages: Message[], profile: ProviderProfile): Message[] {
  switch (profile.cacheType) {
    case 'exact-prefix':
    case 'none':
    case 'block-kv':
      return messages

    case 'explicit-breakpoint':
      return applyExplicitBreakpoints(messages, profile)

    case 'partial-prefix':
      return messages // OpenAI auto-handles partial matching
  }
}

function applyExplicitBreakpoints(messages: Message[], profile: ProviderProfile): Message[] {
  if (messages.length <= CACHE_ANCHOR_MESSAGES) return messages
  return messages.map((msg, idx) => {
    if (idx === CACHE_ANCHOR_MESSAGES - 1) {
      return { ...msg, cache_control: { type: 'ephemeral' } }
    }
    return msg
  })
}
```

- [ ] **步骤 3：运行测试**

运行：`npm test -- src/__tests__/cache-strategy.test.ts`
预期：PASS

- [ ] **步骤 4：Commit**

```bash
git add src/api/cache-strategy.ts src/__tests__/cache-strategy.test.ts
git commit -m "feat(api): CacheStrategy — provider-aware message assembly"
```

---

## Phase 4：Recall 工具 + 主动预注入

### 任务 4.1：Recall 工具

**文件：**
- 创建：`src/tools/recall.ts`
- 测试：`src/__tests__/recall.test.ts`
- 修改：`src/tools/default-registry.ts`

- [ ] **步骤 1：编写测试**

```typescript
// src/__tests__/recall.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createRecallTool } from '../tools/recall.js'
import { PersistentStore } from '../context/persistent-store.js'

describe('recall tool', () => {
  let store: PersistentStore
  let tool: ReturnType<typeof createRecallTool>

  beforeEach(() => {
    const dir = mkdtempSync(join(tmpdir(), 'rivet-recall-'))
    store = new PersistentStore(dir)
    store.archive({ toolName: 'bash', content: 'npm test: 705 passed', sessionId: 's1', roundNumber: 3 })
    store.archive({ toolName: 'read_file', content: 'export function main() {}', sessionId: 's1', roundNumber: 5 })
    tool = createRecallTool(store)
  })

  it('retrieves by tool name', async () => {
    const result = await tool.execute({ query: '', type: 'tool_result', toolName: 'bash', limit: 5 })
    expect(result.content).toContain('npm test')
  })

  it('retrieves by keyword', async () => {
    const result = await tool.execute({ query: 'main', type: 'all', limit: 5 })
    expect(result.content).toContain('export function main')
  })
})
```

- [ ] **步骤 2：实现 recall 工具**

```typescript
// src/tools/recall.ts
import type { PersistentStore } from '../context/persistent-store.js'

interface RecallInput {
  query: string
  type: 'tool_result' | 'all'
  toolName?: string
  since?: string
  limit?: number
}

export function createRecallTool(store: PersistentStore) {
  return {
    name: 'recall',
    description: 'Retrieve archived tool results from persistent memory',
    input_schema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'Search keyword or file path' },
        type: { type: 'string', enum: ['tool_result', 'all'], default: 'all' },
        toolName: { type: 'string', description: 'Filter by tool name' },
        since: { type: 'string', description: 'ISO 8601 timestamp filter' },
        limit: { type: 'number', default: 5 },
      },
      required: ['query'],
    },
    async execute(input: RecallInput) {
      const results = store.search({
        query: input.query || undefined,
        toolName: input.toolName,
        since: input.since,
        limit: input.limit ?? 5,
      })
      if (results.length === 0) {
        return { content: 'No archived results found matching query.' }
      }
      const formatted = results.map(r =>
        `[${r.toolName}] round ${r.roundNumber} (${r.timestamp}):\n${r.content.slice(0, 2000)}`
      ).join('\n---\n')
      return { content: formatted }
    },
  }
}
```

- [ ] **步骤 3：运行测试**

运行：`npm test -- src/__tests__/recall.test.ts`
预期：PASS

- [ ] **步骤 4：Commit**

```bash
git add src/tools/recall.ts src/__tests__/recall.test.ts
git commit -m "feat(tools): recall — retrieve archived content from persistent store"
```

---

### 任务 4.2：Proactive Inject（主动预注入）

**文件：**
- 创建：`src/context/proactive-inject.ts`
- 测试：`src/__tests__/proactive-inject.test.ts`

- [ ] **步骤 1：编写测试**

```typescript
// src/__tests__/proactive-inject.test.ts
import { describe, it, expect } from 'vitest'
import { buildProactiveContext } from '../context/proactive-inject.js'
import type { ContextAnchor } from '../context/types.js'

describe('buildProactiveContext', () => {
  const anchors: ContextAnchor[] = [
    { kind: 'user_preference', text: 'Use TDD for all new features', sourceRoundIndex: 2, salience: 0.9 },
    { kind: 'decision', text: 'Chose Zod for validation', sourceRoundIndex: 5, salience: 0.7 },
  ]

  it('builds XML block from anchors', () => {
    const block = buildProactiveContext(anchors, [])
    expect(block).toContain('<active-constraints>')
    expect(block).toContain('Use TDD')
    expect(block).toContain('Chose Zod')
  })

  it('respects token budget', () => {
    const block = buildProactiveContext(anchors, [], { maxTokens: 10 })
    // Should include highest salience first
    expect(block).toContain('Use TDD')
  })

  it('returns empty string when no anchors', () => {
    const block = buildProactiveContext([], [])
    expect(block).toBe('')
  })
})
```

- [ ] **步骤 2：实现 proactive-inject**

```typescript
// src/context/proactive-inject.ts
import type { ContextAnchor } from './types.js'
import { estimateMessageTokens } from './token-estimate.js'

interface ProactiveOptions {
  maxTokens?: number
}

export function buildProactiveContext(
  anchors: ContextAnchor[],
  _sessionMemoryEntries: { text: string }[],
  options?: ProactiveOptions,
): string {
  if (anchors.length === 0) return ''

  const maxTokens = options?.maxTokens ?? 5000
  const sorted = [...anchors].sort((a, b) => b.salience - a.salience)

  const lines: string[] = []
  let tokenCount = 0
  for (const anchor of sorted) {
    const lineTokens = Math.ceil(anchor.text.length / 4)
    if (tokenCount + lineTokens > maxTokens) break
    lines.push(`- [${anchor.kind}] ${anchor.text}`)
    tokenCount += lineTokens
  }

  if (lines.length === 0) return ''
  return `<active-constraints>\n${lines.join('\n')}\n</active-constraints>`
}
```

- [ ] **步骤 3：运行测试**

运行：`npm test -- src/__tests__/proactive-inject.test.ts`
预期：PASS

- [ ] **步骤 4：Commit**

```bash
git add src/context/proactive-inject.ts src/__tests__/proactive-inject.test.ts
git commit -m "feat(context): proactive-inject — system-level context pre-loading from anchors"
```

---

## Phase 5：集成 + 端到端验证

### 任务 5.1：Agent Loop 集成

**文件：**
- 修改：`src/agent/loop.ts`
- 修改：`src/config/schema.ts`

- [ ] **步骤 1：在 AgentLoop config 中增加 provider profile**

在 `AgentLoopConfig` 接口中增加：
```typescript
providerProfile?: ProviderProfile
persistentStoreDir?: string
```

- [ ] **步骤 2：在 loop.run() 每轮前注入 proactive context**

在 `loop.ts` 的 `for (let turn = 0; ...)` 循环开头，压缩检查之后、API 调用之前：
```typescript
// Proactive injection
if (this.anchorRegistry && this.config.providerProfile) {
  const proactiveBlock = buildProactiveContext(
    this.anchorRegistry.getAnchors(),
    [],
    { maxTokens: Math.floor(this.config.contextWindow * 0.03) }
  )
  if (proactiveBlock) {
    this.session.setVolatileContext(proactiveBlock)
  }
}
```

- [ ] **步骤 3：在压缩时归档到 persistent store**

在 `compactMessages` 方法中，压缩前将被移除的 tool_result 归档：
```typescript
// Archive evicted tool results before compaction
if (this.persistentStore) {
  for (const msg of oldMessages) {
    if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === 'tool_result' && block.content.length > 500) {
          this.persistentStore.archive({
            toolName: block.tool_use_id ?? 'unknown',
            content: block.content,
            sessionId: this.config.sessionId ?? 'session',
            roundNumber: this.session.getTurnCount(),
          })
        }
      }
    }
  }
}
```

- [ ] **步骤 4：应用 cache strategy 到 API 调用前**

在发送消息到 API 前：
```typescript
const finalMessages = this.config.providerProfile
  ? applyCacheStrategy(messages, this.config.providerProfile)
  : messages
```

- [ ] **步骤 5：运行全量测试**

运行：`npm test`
预期：所有测试 PASS

- [ ] **步骤 6：Commit**

```bash
git add src/agent/loop.ts src/config/schema.ts
git commit -m "feat(agent): integrate ACF — pressure monitor, anchors, proactive inject, cache strategy"
```

---

### 任务 5.2：端到端模拟测试

**文件：**
- 创建：`src/__tests__/acf-integration.test.ts`

- [ ] **步骤 1：编写 128K 窗口模拟测试**

```typescript
// src/__tests__/acf-integration.test.ts
import { describe, it, expect } from 'vitest'
import { decideCompactTier } from '../context/compact-policy.js'
import { compactThresholds } from '../compact/constants.js'
import { PressureMonitor } from '../context/pressure-monitor.js'

describe('ACF integration: 128K window', () => {
  const contextWindow = 128_000
  const thresholds = compactThresholds(contextWindow)

  it('triggers compaction at 78% of 128K', () => {
    const decision = decideCompactTier({
      estimatedTokens: 100_000, // ~78%
      maxTokens: contextWindow,
      turn: 10,
      failures: { consecutiveFailures: 0 },
    })
    expect(decision.shouldCompact).toBe(true)
    expect(decision.tier).toBe(2)
  })

  it('triggers emergency at 95% of 128K', () => {
    const decision = decideCompactTier({
      estimatedTokens: 122_000, // ~95%
      maxTokens: contextWindow,
      turn: 10,
      failures: { consecutiveFailures: 0 },
    })
    expect(decision.tier).toBe(4)
  })

  it('pressure monitor detects thrashing', () => {
    const monitor = new PressureMonitor(contextWindow)
    // Simulate 3 compactions in 3 turns
    monitor.recordCompaction(1)
    monitor.recordCompaction(2)
    monitor.recordCompaction(3)
    expect(monitor.isThrashing()).toBe(true)
  })
})
```

- [ ] **步骤 2：运行测试**

运行：`npm test -- src/__tests__/acf-integration.test.ts`
预期：PASS

- [ ] **步骤 3：Commit**

```bash
git add src/__tests__/acf-integration.test.ts
git commit -m "test(acf): integration tests for 128K window compaction + thrashing detection"
```

---

## 验收标准

| 标准 | 验证方法 |
|------|---------|
| 128K 窗口零溢出 | 模拟 100 轮，token 估算永不超 contextWindow |
| DeepSeek 99% 缓存命中 | 前 2 条消息不变，运行时验证 response header |
| 锚点零丢失 | 注入约束后 50 轮验证仍存在 |
| 压缩不破坏 API 不变量 | 压缩后 round 的 tool_use/tool_result 配对完整 |
| 反抖动生效 | 连续 3 轮压缩后 isThrashing() = true |
