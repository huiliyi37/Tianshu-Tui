# GenomeStore 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 为 Role Agent 提供角色级持久记忆（genome），支持写入免疫检查、跨 session 积累、provenance 追踪。

**架构：** GenomeStore 管理 `.rivet/genome/<role>.jsonl`，每条 GenomeBullet 比 PlaybookBullet 多了 role、successCount、failureCount、provenance 字段。写入前通过 immuneCheck() 验证一致性，拒绝矛盾 lesson。WorkerSession 加载对应角色 genome 作为 volatile context 注入。

**技术栈：** TypeScript strict, node:test + node:assert/strict, zod validation, JSONL persistence

---

## 文件结构

| 文件 | 职责 |
|------|------|
| 创建 `src/agent/genome-store.ts` | GenomeStore class: load/save/addBullets/query/recordUsage + immuneCheck |
| 创建 `src/agent/genome-types.ts` | GenomeBullet interface + zod schema + constants |
| 创建 `src/agent/__tests__/genome-store.test.ts` | GenomeStore 单元测试 |
| 修改 `src/agent/worker-session.ts` | 加载角色 genome 注入 PromptEngine |
| 修改 `src/agent/hooks/dream-hook.ts` | postSession 时写入 genome（免疫检查 gate） |
| 创建 `src/agent/__tests__/genome-immune.test.ts` | 免疫检查专项测试 |

---

### 任务 1：GenomeBullet 类型定义

**文件：**
- 创建：`src/agent/genome-types.ts`

- [ ] **步骤 1：编写失败的测试**

```typescript
// src/agent/__tests__/genome-store.test.ts
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { genomeBulletSchema, type GenomeBullet } from '../genome-types.js'

describe('GenomeBullet schema', () => {
  it('validates a well-formed bullet', () => {
    const bullet: GenomeBullet = {
      id: 'gb_abc123',
      role: 'coder',
      createdAt: Date.now(),
      keywords: ['typecheck', 'typescript'],
      lesson: 'Always run typecheck before commit',
      context: 'recommendation',
      successCount: 0,
      failureCount: 0,
      importance: 0.6,
      provenance: { sessionId: 'sess_1', agentInstance: 'worker-1', timestamp: Date.now() },
    }
    const parsed = genomeBulletSchema.parse(bullet)
    assert.equal(parsed.role, 'coder')
    assert.equal(parsed.successCount, 0)
  })

  it('rejects bullet without role', () => {
    assert.throws(() => genomeBulletSchema.parse({ id: 'x', keywords: [] }))
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npx tsx --test src/agent/__tests__/genome-store.test.ts`
预期：FAIL — cannot find module '../genome-types.js'

- [ ] **步骤 3：实现类型文件**

```typescript
// src/agent/genome-types.ts
import { z } from 'zod'

export interface GenomeBullet {
  id: string
  role: string
  createdAt: number
  keywords: string[]
  lesson: string
  context: 'root-cause' | 'recommendation' | 'pattern' | 'anti-pattern'
  successCount: number
  failureCount: number
  importance: number
  provenance: {
    sessionId: string
    agentInstance: string
    timestamp: number
  }
}

export const genomeBulletSchema = z.object({
  id: z.string().min(1),
  role: z.string().min(1),
  createdAt: z.number(),
  keywords: z.array(z.string()),
  lesson: z.string().min(1),
  context: z.enum(['root-cause', 'recommendation', 'pattern', 'anti-pattern']),
  successCount: z.number().int().min(0),
  failureCount: z.number().int().min(0),
  importance: z.number().min(0).max(1),
  provenance: z.object({
    sessionId: z.string(),
    agentInstance: z.string(),
    timestamp: z.number(),
  }),
}) satisfies z.ZodType<GenomeBullet>

export const DEFAULT_GENOME_CAPACITY = 30
export const IMMUNE_CONFLICT_THRESHOLD = 0.5
```

- [ ] **步骤 4：运行测试验证通过**

运行：`npx tsx --test src/agent/__tests__/genome-store.test.ts`
预期：2 tests PASS

- [ ] **步骤 5：Commit**

```bash
git add src/agent/genome-types.ts src/agent/__tests__/genome-store.test.ts
git commit -m "feat(genome): add GenomeBullet type + zod schema"
```

---

### 任务 2：GenomeStore — load/save/addBullets

**文件：**
- 创建：`src/agent/genome-store.ts`
- 测试：`src/agent/__tests__/genome-store.test.ts`（追加）

- [ ] **步骤 1：编写失败的测试**

```typescript
// 追加到 src/agent/__tests__/genome-store.test.ts
import { GenomeStore } from '../genome-store.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

describe('GenomeStore', () => {
  let dir: string
  let store: GenomeStore

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'genome-test-'))
    store = new GenomeStore(dir, 'coder')
  })

  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('starts empty', () => {
    assert.deepEqual(store.load(), [])
  })

  it('saves and loads bullets', () => {
    const bullet: GenomeBullet = {
      id: 'gb_1',
      role: 'coder',
      createdAt: Date.now(),
      keywords: ['test'],
      lesson: 'Write tests first',
      context: 'recommendation',
      successCount: 0,
      failureCount: 0,
      importance: 0.6,
      provenance: { sessionId: 's1', agentInstance: 'w1', timestamp: Date.now() },
    }
    store.addBullets([bullet])
    const loaded = store.load()
    assert.equal(loaded.length, 1)
    assert.equal(loaded[0]!.lesson, 'Write tests first')
  })

  it('enforces capacity', () => {
    const bullets = Array.from({ length: 35 }, (_, i) => ({
      id: `gb_${i}`,
      role: 'coder',
      createdAt: Date.now() - i * 1000,
      keywords: [`k${i}`],
      lesson: `Lesson ${i}`,
      context: 'pattern' as const,
      successCount: 0,
      failureCount: 0,
      importance: 0.5,
      provenance: { sessionId: 's', agentInstance: 'w', timestamp: Date.now() },
    }))
    store.addBullets(bullets)
    assert.ok(store.load().length <= 30)
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npx tsx --test src/agent/__tests__/genome-store.test.ts`
预期：FAIL — cannot find module '../genome-store.js'

- [ ] **步骤 3：实现 GenomeStore**

```typescript
// src/agent/genome-store.ts
import { existsSync, readFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { writeFileAtomicSync } from '../fs-atomic.js'
import { genomeBulletSchema, type GenomeBullet, DEFAULT_GENOME_CAPACITY } from './genome-types.js'

export class GenomeStore {
  private readonly filePath: string
  private readonly capacity: number

  constructor(cwd: string, role: string, capacity = DEFAULT_GENOME_CAPACITY) {
    const dir = join(cwd, '.rivet', 'genome')
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    this.filePath = join(dir, `${role}.jsonl`)
    this.capacity = capacity
  }

  load(): GenomeBullet[] {
    if (!existsSync(this.filePath)) return []
    const raw = readFileSync(this.filePath, 'utf-8')
    const bullets: GenomeBullet[] = []
    for (const line of raw.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try { bullets.push(genomeBulletSchema.parse(JSON.parse(trimmed))) } catch { /* skip malformed */ }
    }
    return bullets
  }

  save(bullets: GenomeBullet[]): void {
    mkdirSync(dirname(this.filePath), { recursive: true })
    const lines = bullets.map(b => JSON.stringify(genomeBulletSchema.parse(b)))
    writeFileAtomicSync(this.filePath, lines.length > 0 ? `${lines.join('\n')}\n` : '')
  }

  addBullets(incoming: GenomeBullet[]): void {
    const existing = this.load()
    const merged = [...existing, ...incoming]
    this.save(this.enforceCapacity(merged))
  }

  private enforceCapacity(bullets: GenomeBullet[]): GenomeBullet[] {
    if (bullets.length <= this.capacity) return bullets
    return bullets
      .sort((a, b) => b.importance - a.importance)
      .slice(0, this.capacity)
  }
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`npx tsx --test src/agent/__tests__/genome-store.test.ts`
预期：5 tests PASS

- [ ] **步骤 5：Commit**

```bash
git add src/agent/genome-store.ts src/agent/__tests__/genome-store.test.ts
git commit -m "feat(genome): GenomeStore with load/save/addBullets/capacity"
```

---

### 任务 3：免疫检查（immuneCheck）

**文件：**
- 修改：`src/agent/genome-store.ts`（添加 immuneCheck 方法）
- 创建：`src/agent/__tests__/genome-immune.test.ts`

- [ ] **步骤 1：编写失败的测试**

```typescript
// src/agent/__tests__/genome-immune.test.ts
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { immuneCheck } from '../genome-store.js'
import type { GenomeBullet } from '../genome-types.js'

function makeBullet(overrides: Partial<GenomeBullet> = {}): GenomeBullet {
  return {
    id: 'gb_test',
    role: 'coder',
    createdAt: Date.now(),
    keywords: ['typecheck', 'commit'],
    lesson: 'Run typecheck before commit',
    context: 'recommendation',
    successCount: 0,
    failureCount: 0,
    importance: 0.6,
    provenance: { sessionId: 's', agentInstance: 'w', timestamp: Date.now() },
    ...overrides,
  }
}

describe('immuneCheck', () => {
  it('accepts non-conflicting bullet', () => {
    const existing = [makeBullet({ keywords: ['lint', 'format'] })]
    const incoming = makeBullet({ keywords: ['typecheck', 'build'] })
    const result = immuneCheck(incoming, existing)
    assert.equal(result.accepted, true)
  })

  it('rejects bullet conflicting with existing (high keyword overlap + opposite context)', () => {
    const existing = [makeBullet({ keywords: ['typecheck', 'commit'], context: 'recommendation' })]
    const incoming = makeBullet({ keywords: ['typecheck', 'commit'], context: 'anti-pattern' })
    const result = immuneCheck(incoming, existing)
    assert.equal(result.accepted, false)
    assert.ok(result.reason!.includes('conflict'))
  })

  it('rejects bullet with too few keywords', () => {
    const incoming = makeBullet({ keywords: ['x'] })
    const result = immuneCheck(incoming, [])
    assert.equal(result.accepted, false)
    assert.ok(result.reason!.includes('too few'))
  })

  it('rejects bullet with too many keywords', () => {
    const incoming = makeBullet({ keywords: Array.from({ length: 12 }, (_, i) => `k${i}`) })
    const result = immuneCheck(incoming, [])
    assert.equal(result.accepted, false)
    assert.ok(result.reason!.includes('too many'))
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npx tsx --test src/agent/__tests__/genome-immune.test.ts`
预期：FAIL — immuneCheck is not exported

- [ ] **步骤 3：实现 immuneCheck**

```typescript
// 在 src/agent/genome-store.ts 末尾追加

export interface ImmuneResult {
  accepted: boolean
  reason?: string
}

function keywordOverlap(a: string[], b: string[]): number {
  const setA = new Set(a.map(k => k.toLowerCase()))
  const setB = new Set(b.map(k => k.toLowerCase()))
  const intersection = [...setA].filter(k => setB.has(k)).length
  return intersection / Math.max(1, Math.min(setA.size, setB.size))
}

export function immuneCheck(incoming: GenomeBullet, existing: GenomeBullet[]): ImmuneResult {
  // Quality gate: keyword count
  if (incoming.keywords.length < 2) {
    return { accepted: false, reason: 'too few keywords — lesson too generic' }
  }
  if (incoming.keywords.length > 10) {
    return { accepted: false, reason: 'too many keywords — lesson too specific' }
  }

  // Contradiction detection: high overlap + opposite context
  for (const bullet of existing) {
    const overlap = keywordOverlap(incoming.keywords, bullet.keywords)
    if (overlap >= 0.5) {
      const opposites: Record<string, string> = {
        'recommendation': 'anti-pattern',
        'anti-pattern': 'recommendation',
        'pattern': 'anti-pattern',
      }
      if (opposites[bullet.context] === incoming.context) {
        return { accepted: false, reason: `conflict with existing lesson "${bullet.lesson.slice(0, 40)}"` }
      }
    }
  }

  return { accepted: true }
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`npx tsx --test src/agent/__tests__/genome-immune.test.ts`
预期：4 tests PASS

- [ ] **步骤 5：Commit**

```bash
git add src/agent/genome-store.ts src/agent/__tests__/genome-immune.test.ts
git commit -m "feat(genome): immuneCheck — contradiction detection + quality gate"
```

---

### 任务 4：GenomeStore.addWithImmunity()

**文件：**
- 修改：`src/agent/genome-store.ts`
- 测试：`src/agent/__tests__/genome-store.test.ts`（追加）

- [ ] **步骤 1：编写失败的测试**

```typescript
// 追加到 genome-store.test.ts 的 GenomeStore describe 中
it('addWithImmunity accepts valid bullet', () => {
  const bullet: GenomeBullet = {
    id: 'gb_imm1',
    role: 'coder',
    createdAt: Date.now(),
    keywords: ['testing', 'tdd'],
    lesson: 'Write test before implementation',
    context: 'recommendation',
    successCount: 0,
    failureCount: 0,
    importance: 0.6,
    provenance: { sessionId: 's1', agentInstance: 'w1', timestamp: Date.now() },
  }
  const result = store.addWithImmunity([bullet])
  assert.equal(result.accepted.length, 1)
  assert.equal(result.rejected.length, 0)
  assert.equal(store.load().length, 1)
})

it('addWithImmunity rejects conflicting bullet', () => {
  const existing: GenomeBullet = {
    id: 'gb_exist',
    role: 'coder',
    createdAt: Date.now(),
    keywords: ['tabs', 'indent'],
    lesson: 'Use tabs for indentation',
    context: 'recommendation',
    successCount: 3,
    failureCount: 0,
    importance: 0.8,
    provenance: { sessionId: 's1', agentInstance: 'w1', timestamp: Date.now() },
  }
  store.addBullets([existing])

  const incoming: GenomeBullet = {
    id: 'gb_conflict',
    role: 'coder',
    createdAt: Date.now(),
    keywords: ['tabs', 'indent'],
    lesson: 'Never use tabs',
    context: 'anti-pattern',
    successCount: 0,
    failureCount: 0,
    importance: 0.6,
    provenance: { sessionId: 's2', agentInstance: 'w2', timestamp: Date.now() },
  }
  const result = store.addWithImmunity([incoming])
  assert.equal(result.accepted.length, 0)
  assert.equal(result.rejected.length, 1)
  assert.equal(store.load().length, 1) // only original remains
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npx tsx --test src/agent/__tests__/genome-store.test.ts`
预期：FAIL — store.addWithImmunity is not a function

- [ ] **步骤 3：实现 addWithImmunity**

```typescript
// 在 GenomeStore class 中添加方法

export interface ImmunityResult {
  accepted: GenomeBullet[]
  rejected: Array<{ bullet: GenomeBullet; reason: string }>
}

// 在 GenomeStore class 内部:
addWithImmunity(incoming: GenomeBullet[]): ImmunityResult {
  const existing = this.load()
  const accepted: GenomeBullet[] = []
  const rejected: Array<{ bullet: GenomeBullet; reason: string }> = []

  for (const bullet of incoming) {
    const check = immuneCheck(bullet, [...existing, ...accepted])
    if (check.accepted) {
      accepted.push(bullet)
    } else {
      rejected.push({ bullet, reason: check.reason! })
    }
  }

  if (accepted.length > 0) {
    this.save(this.enforceCapacity([...existing, ...accepted]))
  }

  return { accepted, rejected }
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`npx tsx --test src/agent/__tests__/genome-store.test.ts`
预期：全部 PASS

- [ ] **步骤 5：Commit**

```bash
git add src/agent/genome-store.ts src/agent/__tests__/genome-store.test.ts
git commit -m "feat(genome): addWithImmunity — immune-gated genome writes"
```

---

### 任务 5：GenomeStore.query() — 匹配 + 使用记录

**文件：**
- 修改：`src/agent/genome-store.ts`
- 测试：`src/agent/__tests__/genome-store.test.ts`（追加）

- [ ] **步骤 1：编写失败的测试**

```typescript
it('query returns matching bullets sorted by score', () => {
  store.addBullets([
    { id: 'gb_a', role: 'coder', createdAt: Date.now(), keywords: ['typescript', 'build'], lesson: 'Build before deploy', context: 'recommendation', successCount: 5, failureCount: 0, importance: 0.9, provenance: { sessionId: 's', agentInstance: 'w', timestamp: Date.now() } },
    { id: 'gb_b', role: 'coder', createdAt: Date.now(), keywords: ['python', 'lint'], lesson: 'Lint python', context: 'pattern', successCount: 0, failureCount: 0, importance: 0.5, provenance: { sessionId: 's', agentInstance: 'w', timestamp: Date.now() } },
  ])
  const results = store.query(['typescript', 'build'], 1)
  assert.equal(results.length, 1)
  assert.equal(results[0]!.id, 'gb_a')
})

it('query increments useCount on matched bullets', () => {
  store.addBullets([
    { id: 'gb_q', role: 'coder', createdAt: Date.now(), keywords: ['test', 'tdd'], lesson: 'TDD', context: 'pattern', successCount: 0, failureCount: 0, importance: 0.6, provenance: { sessionId: 's', agentInstance: 'w', timestamp: Date.now() } },
  ])
  store.query(['test'], 1)
  const loaded = store.load()
  assert.equal(loaded[0]!.successCount, 0) // query doesn't change successCount, only importance
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npx tsx --test src/agent/__tests__/genome-store.test.ts`
预期：FAIL — store.query is not a function

- [ ] **步骤 3：实现 query**

```typescript
// 在 GenomeStore class 中添加

query(keywords: string[], topK = 3): GenomeBullet[] {
  const bullets = this.load()
  const normalized = keywords.map(k => k.toLowerCase().trim()).filter(Boolean)
  if (normalized.length === 0) return []

  const scored = bullets.map(b => ({
    bullet: b,
    score: this.matchScore(b, normalized),
  }))

  return scored
    .filter(s => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
    .map(s => s.bullet)
}

private matchScore(bullet: GenomeBullet, query: string[]): number {
  const bKeywords = new Set(bullet.keywords.map(k => k.toLowerCase()))
  const overlap = query.filter(k => bKeywords.has(k)).length
  if (overlap === 0) return 0
  const overlapRatio = overlap / Math.min(bKeywords.size, query.length)
  const successRate = bullet.successCount + bullet.failureCount > 0
    ? bullet.successCount / (bullet.successCount + bullet.failureCount)
    : 0.5
  return overlapRatio * 2 + bullet.importance + successRate * 0.3
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`npx tsx --test src/agent/__tests__/genome-store.test.ts`
预期：全部 PASS

- [ ] **步骤 5：Commit**

```bash
git add src/agent/genome-store.ts src/agent/__tests__/genome-store.test.ts
git commit -m "feat(genome): query with success-rate-weighted scoring"
```

---

### 任务 6：WorkerSession 加载角色 genome

**文件：**
- 修改：`src/agent/worker-session.ts:16-26`（WorkerSessionConfig 加 role 字段）
- 测试：`src/agent/__tests__/genome-store.test.ts`（集成验证）

- [ ] **步骤 1：编写失败的测试**

```typescript
// src/agent/__tests__/genome-store.test.ts 追加
describe('genome volatile injection', () => {
  it('formats genome bullets as injectable context', () => {
    const { formatGenomeContext } = await import('../genome-store.js')
    const bullets: GenomeBullet[] = [
      { id: 'gb_1', role: 'coder', createdAt: Date.now(), keywords: ['test'], lesson: 'Always test first', context: 'recommendation', successCount: 3, failureCount: 0, importance: 0.8, provenance: { sessionId: 's', agentInstance: 'w', timestamp: Date.now() } },
    ]
    const output = formatGenomeContext(bullets)
    assert.ok(output.includes('<role-experience'))
    assert.ok(output.includes('Always test first'))
    assert.ok(output.includes('success: 3'))
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npx tsx --test src/agent/__tests__/genome-store.test.ts`
预期：FAIL — formatGenomeContext is not exported

- [ ] **步骤 3：实现 formatGenomeContext**

```typescript
// 在 src/agent/genome-store.ts 末尾追加

export function formatGenomeContext(bullets: GenomeBullet[]): string {
  if (bullets.length === 0) return ''
  const lines = bullets.map(b =>
    `- ${b.lesson} [${b.context}, success: ${b.successCount}, fail: ${b.failureCount}]`
  )
  return `<role-experience role="${bullets[0]!.role}">\n${lines.join('\n')}\n</role-experience>`
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`npx tsx --test src/agent/__tests__/genome-store.test.ts`
预期：全部 PASS

- [ ] **步骤 5：修改 WorkerSessionConfig 加入 role 字段**

```typescript
// src/agent/worker-session.ts — 在 WorkerSessionConfig 中添加
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
  role?: string  // ← NEW: loads genome for this role into volatile context
}
```

- [ ] **步骤 6：Commit**

```bash
git add src/agent/genome-store.ts src/agent/worker-session.ts src/agent/__tests__/genome-store.test.ts
git commit -m "feat(genome): formatGenomeContext + WorkerSessionConfig.role field"
```

---

### 任务 7：Typecheck + 全量测试验证

**文件：** 无新文件

- [ ] **步骤 1：运行 typecheck**

运行：`npm run typecheck`
预期：0 errors

- [ ] **步骤 2：运行全量测试**

运行：`npm test`
预期：全部 PASS（1685+ tests）

- [ ] **步骤 3：运行 build**

运行：`npm run build`
预期：成功

---

## 自检结果

1. **规格覆盖度**：GenomeBullet 类型 ✓ | GenomeStore CRUD ✓ | immuneCheck ✓ | addWithImmunity ✓ | query with scoring ✓ | volatile context format ✓ | WorkerSession integration ✓
2. **占位符扫描**：无 TODO/待定
3. **类型一致性**：GenomeBullet 在 genome-types.ts 定义，genome-store.ts 和测试文件统一 import

---
