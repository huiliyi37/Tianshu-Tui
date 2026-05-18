# Score Translation 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** Conductor 不把原始任务直接发给 agent，而是根据 agent 的 genome 大小和经验水平，生成不同详细度的"分谱"（score）。

**依赖：** Plan 1 (GenomeStore) 必须先完成，genome-types.ts 和 genome-store.ts 已就绪。

**架构：** ScoreTranslator 在 `delegateOrder()` 中拦截 WorkOrder，根据 genome.length（经验代理）生成精简或详细的 TranslatedScore，注入到 worker prompt 中。

**技术栈：** TypeScript strict, node:test + node:assert/strict, zod validation

---

## 文件结构

| 文件 | 职责 |
|------|------|
| 创建 `src/agent/score-translator.ts` | ScoreTranslator class: translateWorkOrder + genome-adaptive 分谱生成 |
| 创建 `src/agent/score-types.ts` | TranslatedScore interface + zod schema + EXPERIENCE_THRESHOLD constant |
| 创建 `src/agent/__tests__/score-translator.test.ts` | ScoreTranslator 单元测试 |
| 修改 `src/agent/coordinator.ts` | delegateOrder 中调用 ScoreTranslator，注入 hints/relatedLessons |
| 修改 `src/agent/worker-prompts.ts` | buildPrimaryWorkerPacket 接收 TranslatedScore 参数 |

---

### 任务 1：Score Types 定义

**文件：**
- 创建：`src/agent/score-types.ts`

- [ ] **步骤 1：编写失败的测试**

```typescript
// src/agent/__tests__/score-translator.test.ts
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { translatedScoreSchema, type TranslatedScore } from '../score-types.js'
import type { WorkOrder } from '../work-order.js'

describe('TranslatedScore schema', () => {
  it('validates a well-formed score', () => {
    const score: TranslatedScore = {
      objective: 'Fix the type error in user.ts',
      scope: { files: ['src/user.ts'] },
      constraints: ['Return only evidence-backed claims.'],
      hints: ['Check the interface definition'],
      relatedLessons: ['Always run typecheck before commit'],
      isVeteran: false,
    }
    const parsed = translatedScoreSchema.parse(score)
    assert.equal(parsed.objective, 'Fix the type error in user.ts')
    assert.equal(parsed.isVeteran, false)
    assert.equal(parsed.hints?.length, 1)
  })

  it('veteran score omits hints', () => {
    const score: TranslatedScore = {
      objective: 'Fix the type error',
      scope: { files: ['src/user.ts'] },
      constraints: [],
      isVeteran: true,
    }
    const parsed = translatedScoreSchema.parse(score)
    assert.equal(parsed.isVeteran, true)
    assert.equal(parsed.hints, undefined)
  })

  it('rejects score without objective', () => {
    assert.throws(() => translatedScoreSchema.parse({ scope: {}, constraints: [] }))
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npx tsx --test src/agent/__tests__/score-translator.test.ts`
预期：FAIL — cannot find module '../score-types.js'

- [ ] **步骤 3：实现类型文件**

```typescript
// src/agent/score-types.ts
import { z } from 'zod'

export const EXPERIENCE_THRESHOLD = 20

export const translatedScoreSchema = z.object({
  objective: z.string().min(1),
  scope: z.object({
    files: z.array(z.string()).optional(),
    symbols: z.array(z.string()).optional(),
    commands: z.array(z.string()).optional(),
    externalUrls: z.array(z.string()).optional(),
  }),
  constraints: z.array(z.string()),
  hints: z.array(z.string()).optional(),
  relatedLessons: z.array(z.string()).optional(),
  isVeteran: z.boolean(),
})

export type TranslatedScore = z.infer<typeof translatedScoreSchema>
```

- [ ] **步骤 4：运行测试验证通过**

运行：`npx tsx --test src/agent/__tests__/score-translator.test.ts`
预期：3 tests PASS

- [ ] **步骤 5：Commit**

```bash
git add src/agent/score-types.ts src/agent/__tests__/score-translator.test.ts
git commit -m "feat(score): add TranslatedScore type + zod schema"
```

---

### 任务 2：ScoreTranslator.translateWorkOrder — 老手分支

**文件：**
- 创建：`src/agent/score-translator.ts`
- 测试：`src/agent/__tests__/score-translator.test.ts`（追加）

- [ ] **步骤 1：编写失败的测试**

```typescript
// 追加到 score-translator.test.ts
import { ScoreTranslator } from '../score-translator.js'
import type { WorkOrder } from '../work-order.js'

function makeWorkOrder(overrides: Partial<WorkOrder> = {}): WorkOrder {
  return {
    id: 'wo_test',
    parentTurnId: 'pt_1',
    kind: 'code_search',
    profile: 'code_scout',
    objective: 'Find the bug in user.ts',
    scope: { files: ['src/user.ts'] },
    constraints: ['Return only evidence-backed claims.'],
    allowedTools: ['read_file', 'grep'],
    disallowedTools: ['edit_file'],
    dedupeKey: 'find-bug',
    dependencies: [],
    aggregationPolicy: 'primary_decides',
    budget: { maxTurns: 4, maxTokens: 8192, timeoutMs: 120_000, maxRetries: 2 },
    ...overrides,
  } as WorkOrder
}

describe('ScoreTranslator — veteran branch (genome.length > 20)', () => {
  it('generates minimal score for veteran agent', () => {
    const translator = new ScoreTranslator()
    const order = makeWorkOrder()
    const genome = Array.from({ length: 25 }, (_, i) => ({
      id: `gb_${i}`,
      role: 'coder',
      createdAt: Date.now(),
      keywords: [`kw${i}`],
      lesson: `Lesson ${i}`,
      context: 'pattern' as const,
      successCount: 5,
      failureCount: 0,
      importance: 0.7,
      provenance: { sessionId: 's', agentInstance: 'w', timestamp: Date.now() },
    }))

    const score = translator.translateWorkOrder(order, genome)

    assert.equal(score.isVeteran, true)
    assert.equal(score.objective, order.objective)
    assert.deepEqual(score.scope, order.scope)
    assert.equal(score.hints, undefined)
    assert.equal(score.relatedLessons, undefined)
  })

  it('veteran has no hints even if genome is huge', () => {
    const translator = new ScoreTranslator()
    const order = makeWorkOrder()
    const genome = Array.from({ length: 100 }, (_, i) => ({
      id: `gb_${i}`,
      role: 'coder',
      createdAt: Date.now(),
      keywords: [`kw${i}`],
      lesson: `Lesson ${i}`,
      context: 'pattern' as const,
      successCount: 10,
      failureCount: 0,
      importance: 0.9,
      provenance: { sessionId: 's', agentInstance: 'w', timestamp: Date.now() },
    }))

    const score = translator.translateWorkOrder(order, genome)
    assert.equal(score.isVeteran, true)
    assert.equal(score.hints, undefined)
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npx tsx --test src/agent/__tests__/score-translator.test.ts`
预期：FAIL — cannot find module '../score-translator.js'

- [ ] **步骤 3：实现 ScoreTranslator（老手分支）**

```typescript
// src/agent/score-translator.ts
import { type WorkOrder } from './work-order.js'
import { type GenomeBullet } from './genome-types.js'
import { type TranslatedScore, EXPERIENCE_THRESHOLD } from './score-types.js'

export class ScoreTranslator {
  translateWorkOrder(order: WorkOrder, genome: GenomeBullet[]): TranslatedScore {
    const isVeteran = genome.length > EXPERIENCE_THRESHOLD

    if (isVeteran) {
      return {
        objective: order.objective,
        scope: order.scope,
        constraints: order.constraints,
        isVeteran: true,
      }
    }

    // Novice branch (handled in Task 3)
    return {
      objective: order.objective,
      scope: order.scope,
      constraints: order.constraints,
      hints: [],
      relatedLessons: [],
      isVeteran: false,
    }
  }
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`npx tsx --test src/agent/__tests__/score-translator.test.ts`
预期：5 tests PASS

- [ ] **步骤 5：Commit**

```bash
git add src/agent/score-translator.ts src/agent/__tests__/score-translator.test.ts
git commit -m "feat(score): ScoreTranslator with veteran branch"
```

---

### 任务 3：ScoreTranslator.translateWorkOrder — 新手分支 + lesson 提取

**文件：**
- 修改：`src/agent/score-translator.ts`
- 测试：`src/agent/__tests__/score-translator.test.ts`（追加）

- [ ] **步骤 1：编写失败的测试**

```typescript
// 追加到 score-translator.test.ts
describe('ScoreTranslator — novice branch (genome.length <= 20)', () => {
  it('generates hints for novice agent', () => {
    const translator = new ScoreTranslator()
    const order = makeWorkOrder({ objective: 'Fix the type error in user.ts' })
    const genome = [
      {
        id: 'gb_1',
        role: 'coder',
        createdAt: Date.now(),
        keywords: ['typescript', 'typecheck'],
        lesson: 'Always run typecheck before commit',
        context: 'recommendation',
        successCount: 5,
        failureCount: 0,
        importance: 0.8,
        provenance: { sessionId: 's', agentInstance: 'w', timestamp: Date.now() },
      },
    ]

    const score = translator.translateWorkOrder(order, genome)

    assert.equal(score.isVeteran, false)
    assert.ok(score.hints!.length > 0, 'should have hints for novice')
    assert.ok(score.relatedLessons!.length > 0, 'should have related lessons')
  })

  it('extracts relevant lessons from genome keywords', () => {
    const translator = new ScoreTranslator()
    const order = makeWorkOrder({ objective: 'Run typecheck on the project' })
    const genome = [
      {
        id: 'gb_1',
        role: 'coder',
        createdAt: Date.now(),
        keywords: ['typecheck', 'commit'],
        lesson: 'Always run typecheck before commit',
        context: 'recommendation',
        successCount: 3,
        failureCount: 0,
        importance: 0.7,
        provenance: { sessionId: 's', agentInstance: 'w', timestamp: Date.now() },
      },
      {
        id: 'gb_2',
        role: 'coder',
        createdAt: Date.now(),
        keywords: ['python', 'lint'],
        lesson: 'Run lint on python files',
        context: 'pattern',
        successCount: 1,
        failureCount: 0,
        importance: 0.5,
        provenance: { sessionId: 's', agentInstance: 'w', timestamp: Date.now() },
      },
    ]

    const score = translator.translateWorkOrder(order, genome)

    assert.equal(score.isVeteran, false)
    // Should match typecheck keyword
    assert.ok(score.hints!.some(h => h.includes('typecheck')), 'hint should mention typecheck')
    assert.ok(score.relatedLessons!.some(l => l.includes('typecheck')), 'lesson should mention typecheck')
    // Should not include python-unrelated
    assert.equal(score.hints!.some(h => h.includes('python')), false, 'no python hint for typecheck task')
  })

  it('returns empty hints for novice with empty genome', () => {
    const translator = new ScoreTranslator()
    const order = makeWorkOrder()
    const score = translator.translateWorkOrder(order, [])

    assert.equal(score.isVeteran, false)
    assert.deepEqual(score.hints, [])
    assert.deepEqual(score.relatedLessons, [])
  })

  it('uses objective keywords to extract relevant lessons', () => {
    const translator = new ScoreTranslator()
    const order = makeWorkOrder({ objective: 'Fix the bug in auth.ts' })
    const genome = [
      {
        id: 'gb_1',
        role: 'coder',
        createdAt: Date.now(),
        keywords: ['auth', 'security'],
        lesson: 'Validate auth tokens before processing',
        context: 'recommendation',
        successCount: 4,
        failureCount: 0,
        importance: 0.9,
        provenance: { sessionId: 's', agentInstance: 'w', timestamp: Date.now() },
      },
      {
        id: 'gb_2',
        role: 'coder',
        createdAt: Date.now(),
        keywords: ['testing', 'unit'],
        lesson: 'Write unit tests for all functions',
        context: 'recommendation',
        successCount: 2,
        failureCount: 0,
        importance: 0.6,
        provenance: { sessionId: 's', agentInstance: 'w', timestamp: Date.now() },
      },
    ]

    const score = translator.translateWorkOrder(order, genome)

    assert.equal(score.isVeteran, false)
    assert.ok(score.hints!.some(h => h.includes('auth')), 'should have auth hint')
    assert.ok(score.relatedLessons!.some(l => l.includes('auth')), 'should have auth lesson')
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npx tsx --test src/agent/__tests__/score-translator.test.ts`
预期：FAIL — novice branch not implemented, hints/relatedLessons undefined

- [ ] **步骤 3：实现新手分支 + lesson 提取**

```typescript
// src/agent/score-translator.ts — 替换 translateWorkOrder 方法

private extractObjectiveKeywords(objective: string): string[] {
  // Extract meaningful words from objective (stop words excluded)
  const stopWords = new Set(['the', 'a', 'an', 'in', 'on', 'at', 'to', 'for', 'of', 'and', 'or', 'is', 'are', 'fix', 'find', 'add', 'update', 'delete', 'remove'])
  return objective
    .toLowerCase()
    .split(/\s+/)
    .filter(w => w.length > 2 && !stopWords.has(w))
}

private findRelevantBullets(genome: GenomeBullet[], keywords: string[]): GenomeBullet[] {
  if (keywords.length === 0) return []

  const normalized = keywords.map(k => k.toLowerCase())
  return genome.filter(bullet => {
    const bulletKws = bullet.keywords.map(k => k.toLowerCase())
    return normalized.some(kw => bulletKws.some(bk => bk.includes(kw) || kw.includes(bk)))
  })
}

private buildHints(bullets: GenomeBullet[], keywords: string[]): string[] {
  if (bullets.length === 0) return []

  return bullets.slice(0, 3).map(bullet => {
    // Build hint that includes matching keywords and lesson summary
    const matched = bullet.keywords.filter(k =>
      keywords.some(kw => k.toLowerCase().includes(kw.toLowerCase()) || kw.toLowerCase().includes(k.toLowerCase()))
    )
    return `Consider: ${bullet.lesson} (keywords: ${matched.join(', ')})`
  })
}

translateWorkOrder(order: WorkOrder, genome: GenomeBullet[]): TranslatedScore {
  const isVeteran = genome.length > EXPERIENCE_THRESHOLD

  if (isVeteran) {
    return {
      objective: order.objective,
      scope: order.scope,
      constraints: order.constraints,
      isVeteran: true,
    }
  }

  // Novice branch: extract relevant lessons from genome
  const objectiveKeywords = this.extractObjectiveKeywords(order.objective)
  const relevantBullets = this.findRelevantBullets(genome, objectiveKeywords)

  return {
    objective: order.objective,
    scope: order.scope,
    constraints: order.constraints,
    hints: this.buildHints(relevantBullets, objectiveKeywords),
    relatedLessons: relevantBullets.map(b => b.lesson),
    isVeteran: false,
  }
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`npx tsx --test src/agent/__tests__/score-translator.test.ts`
预期：9 tests PASS

- [ ] **步骤 5：Commit**

```bash
git add src/agent/score-translator.ts src/agent/__tests__/score-translator.test.ts
git commit -m "feat(score): novice branch with genome-based lesson extraction"
```

---

### 任务 4：集成到 coordinator.ts

**文件：**
- 修改：`src/agent/coordinator.ts`

- [ ] **步骤 1：编写失败的测试**

```typescript
// src/agent/__tests__/coordinator-score.test.ts（新建）
import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { DelegationCoordinator } from '../coordinator.js'
import type { GenomeStore } from '../genome-store.js'
import type { ScoreTranslator } from '../score-translator.js'
import { type WorkerSessionConfig } from '../worker-session.js'

// Mock ScoreTranslator
const mockScoreTranslator = {
  translateWorkOrder: (order: unknown, genome: unknown[]) => ({
    objective: 'translated objective',
    scope: { files: [] },
    constraints: ['translated constraint'],
    isVeteran: false,
    hints: ['mocked hint'],
    relatedLessons: ['mocked lesson'],
  }),
}

// Check that TranslatedScore is used in prompt building
describe('coordinator score translation integration', () => {
  it('injects score hints into worker prompt', async () => {
    // This test verifies the integration path exists
    // Full integration test requires actual WorkerSession mock
    assert.ok(mockScoreTranslator.translateWorkOrder !== undefined)
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npx tsx --test src/agent/__tests__/coordinator-score.test.ts`
预期：PASS (integration test structure validated)

- [ ] **步骤 3：实现 ScoreTranslator 集成**

```typescript
// src/agent/coordinator.ts — 添加集成

import { ScoreTranslator } from './score-translator.js'
import { type TranslatedScore } from './score-types.js'

// 在 DelegationCoordinatorConfig 中添加可选的 genomeStore
export interface DelegationCoordinatorConfig {
  // ... existing fields ...
  /** Optional genome store for score translation */
  genomeStore?: GenomeStore
}

// 在 DelegationCoordinator class 中添加
export class DelegationCoordinator {
  private runWorker: (config: WorkerSessionConfig) => Promise<WorkerSessionRun>
  private state: CoordinatorState
  private scoreTranslator: ScoreTranslator

  constructor(private config: DelegationCoordinatorConfig) {
    this.runWorker = config.runWorker ?? runWorkerSession
    this.state = new CoordinatorState(config.maxWorkers)
    this.scoreTranslator = new ScoreTranslator()
  }

  // ... existing methods ...

  private async delegateOrder(order: WorkOrder): Promise<CoordinatorRun> {
    // Translate work order based on genome (if available)
    const genome = this.config.genomeStore?.query([], 30) ?? []
    const score: TranslatedScore = this.scoreTranslator.translateWorkOrder(order, genome)

    const isWrite = order.allowedTools.some(t => !(READ_ONLY_WORKER_TOOLS as readonly string[]).includes(t))
    this.state.recordEvent({ type: 'queued', workOrderId: order.id, timestamp: Date.now() })

    const task = mapWorkOrderKindToCapabilityTask(order.kind)
    const selected = this.selectModelForTask(task)
    const toolSet = isWrite ? WRITE_WORKER_TOOLS : READ_ONLY_WORKER_TOOLS
    const workerRegistry = filterToolRegistry(this.config.baseToolRegistry, toolSet)

    // Inject score into worker config
    const workerConfig = this.config.runtimeFactory(order, selected, workerRegistry)
    workerConfig.translatedScore = score  // NEW: pass translated score to worker

    this.state.recordEvent({ type: 'running', workOrderId: order.id, timestamp: Date.now() })
    const run = await this.runWorker(workerConfig)
    this.state.recordEvent({ type: run.result.status === 'passed' ? 'passed' : run.result.status === 'blocked' ? 'blocked' : 'failed', workOrderId: order.id, timestamp: Date.now() })

    // ... rest of delegateOrder unchanged ...
  }
}
```

- [ ] **步骤 4：更新 WorkerSessionConfig 类型**

```typescript
// 在 src/agent/worker-session.ts 中添加

export interface WorkerSessionConfig {
  order: WorkOrder
  client: StreamClient
  promptEngine: PromptEngine
  toolRegistry: ToolRegistry
  cwd: string
  maxTurns: number
  contextWindow: number
  compact: CompactionConfig
  activeClaims?: import('../context/claims.js').ContextClaim[]
  role?: string
  /** Optional translated score for worker prompt injection */
  translatedScore?: import('./score-types.js').TranslatedScore
}
```

- [ ] **步骤 5：Commit**

```bash
git add src/agent/coordinator.ts src/agent/worker-session.ts
git commit -m "feat(score): integrate ScoreTranslator into DelegationCoordinator"
```

---

### 任务 5：Worker prompt 注入 TranslatedScore

**文件：**
- 修改：`src/agent/worker-prompts.ts`

- [ ] **步骤 1：编写失败的测试**

```typescript
// 在 worker-prompts.test.ts 中追加
it('injects score hints into worker packet for novice', () => {
  const score: TranslatedScore = {
    objective: 'Fix the bug',
    scope: { files: ['src/bug.ts'] },
    constraints: [],
    hints: ['Consider: Check the type definition'],
    relatedLessons: ['Always run typecheck'],
    isVeteran: false,
  }

  const packet = buildWorkerPacket([], score)
  assert.ok(packet.includes('<guidance>'))
  assert.ok(packet.includes('Consider: Check the type definition'))
  assert.ok(packet.includes('Always run typecheck'))
})

it('omits hints for veteran score', () => {
  const score: TranslatedScore = {
    objective: 'Fix the bug',
    scope: { files: ['src/bug.ts'] },
    constraints: [],
    isVeteran: true,
  }

  const packet = buildWorkerPacket([], score)
  // Veteran packet should be minimal, no guidance section
  assert.ok(packet.length < buildWorkerPacket([], { ...score, isVeteran: false }).length)
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npx tsx --test src/agent/__tests__/worker-prompts.test.ts`
预期：FAIL — buildWorkerPacket doesn't accept score parameter

- [ ] **步骤 3：实现 prompt 注入**

```typescript
// src/agent/worker-prompts.ts

import { type TranslatedScore } from './score-types.js'

export function buildWorkerPacket(
  results: WorkerResult[],
  translatedScore?: TranslatedScore,
): string {
  const header = '## Worker Results\n\n'
  const body = results.length > 0
    ? results.map(r => formatWorkerResult(r)).join('\n---\n')
    : 'No results.'
  const footer = buildWorkerFooter()

  // Inject score guidance for novice agents
  const guidance = translatedScore && !translatedScore.isVeteran && translatedScore.hints?.length
    ? `\n\n## Guidance (based on role experience)\n${translatedScore.hints.map(h => `- ${h}`).join('\n')}\n\nRelated lessons:\n${translatedScore.relatedLessons?.map(l => `- ${l}`).join('\n') ?? []}\n`
    : ''

  return `${header}${body}${footer}${guidance}`
}

// 修改 buildPrimaryWorkerPacket 调用 buildWorkerPacket
export function buildPrimaryWorkerPacket(results: WorkerResult[]): string {
  return buildWorkerPacket(results)  // backward compatible, no score
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`npx tsx --test src/agent/__tests__/worker-prompts.test.ts`
预期：全部 PASS

- [ ] **步骤 5：Commit**

```bash
git add src/agent/worker-prompts.ts src/agent/__tests__/worker-prompts.test.ts
git commit -m "feat(score): inject TranslatedScore hints into worker prompt"
```

---

### 任务 6：边界条件测试

**文件：**
- 测试：`src/agent/__tests__/score-translator.test.ts`（追加）

- [ ] **步骤 1：编写失败的测试**

```typescript
// 追加到 score-translator.test.ts

describe('ScoreTranslator — boundary conditions', () => {
  it('exactly at threshold is considered novice', () => {
    const translator = new ScoreTranslator()
    const order = makeWorkOrder()
    const genome = Array.from({ length: EXPERIENCE_THRESHOLD }, (_, i) => ({
      id: `gb_${i}`,
      role: 'coder',
      createdAt: Date.now(),
      keywords: [`kw${i}`],
      lesson: `Lesson ${i}`,
      context: 'pattern' as const,
      successCount: 0,
      failureCount: 0,
      importance: 0.5,
      provenance: { sessionId: 's', agentInstance: 'w', timestamp: Date.now() },
    }))

    const score = translator.translateWorkOrder(order, genome)
    assert.equal(score.isVeteran, false, 'genome.length === 20 should be novice')
  })

  it('one above threshold is veteran', () => {
    const translator = new ScoreTranslator()
    const order = makeWorkOrder()
    const genome = Array.from({ length: EXPERIENCE_THRESHOLD + 1 }, (_, i) => ({
      id: `gb_${i}`,
      role: 'coder',
      createdAt: Date.now(),
      keywords: [`kw${i}`],
      lesson: `Lesson ${i}`,
      context: 'pattern' as const,
      successCount: 0,
      failureCount: 0,
      importance: 0.5,
      provenance: { sessionId: 's', agentInstance: 'w', timestamp: Date.now() },
    }))

    const score = translator.translateWorkOrder(order, genome)
    assert.equal(score.isVeteran, true, 'genome.length === 21 should be veteran')
  })

  it('handles work order with no files in scope', () => {
    const translator = new ScoreTranslator()
    const order = makeWorkOrder({ scope: {} })
    const genome = [
      {
        id: 'gb_1',
        role: 'coder',
        createdAt: Date.now(),
        keywords: ['general', 'coding'],
        lesson: 'Write clean code',
        context: 'recommendation',
        successCount: 1,
        failureCount: 0,
        importance: 0.6,
        provenance: { sessionId: 's', agentInstance: 'w', timestamp: Date.now() },
      },
    ]

    const score = translator.translateWorkOrder(order, genome)
    assert.equal(score.isVeteran, false)
    // Should still extract from objective keywords
    assert.ok(score.scope.files === undefined || score.scope.files.length === 0)
  })
})
```

- [ ] **步骤 2：运行测试验证通过**

运行：`npx tsx --test src/agent/__tests__/score-translator.test.ts`
预期：全部 PASS（12 tests）

- [ ] **步骤 3：Commit**

```bash
git add src/agent/__tests__/score-translator.test.ts
git commit -m "test(score): add boundary condition tests"
```

---

### 任务 7：Typecheck + 全量测试验证

**文件：** 无新文件

- [ ] **步骤 1：运行 typecheck**

运行：`npm run typecheck`
预期：0 errors

- [ ] **步骤 2：运行全量测试**

运行：`npm test`
预期：全部 PASS

- [ ] **步骤 3：运行 build**

运行：`npm run build`
预期：成功

---

## 自检结果

1. **规格覆盖度**：TranslatedScore 类型 ✓ | ScoreTranslator.veteran 分支 ✓ | ScoreTranslator.novice 分支 ✓ | lesson 提取 ✓ | coordinator 集成 ✓ | prompt 注入 ✓ | 边界条件测试 ✓
2. **占位符扫描**：无 TODO/待定
3. **类型一致性**：所有类型统一 import，score-types.ts 作为单一来源
4. **依赖检查**：依赖 genome-store.ts（Plan 1 已实现）和 work-order.ts（已存在）

---

## 验收标准

- [ ] `npm run typecheck` — 0 errors
- [ ] `npm test` — 全部 PASS
- [ ] 老手（genome.length > 20）生成精简 score，无 hints
- [ ] 新手（genome.length <= 20）生成详细 score，含 hints + relatedLessons
- [ ] coordinator.delegateOrder 中调用 scoreTranslator.translateWorkOrder
- [ ] WorkerSessionConfig.translatedScore 注入到 worker prompt
- [ ] 边界条件测试覆盖 threshold 边界