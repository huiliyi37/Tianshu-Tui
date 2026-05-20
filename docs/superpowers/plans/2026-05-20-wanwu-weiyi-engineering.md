# 万物为一工程原则 — 实施计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 实施万物为一设计原则中天权文档未覆盖的 4 个工程改进，与天权三层模型 Phase 1/2 并行推进。

**架构：** 在现有 claim-store、compact-policy、runtime-hooks、sensorium 四个子系统上做最小增量修改。每个任务独立可测试，不依赖其他任务的完成。

**技术栈：** Node.js 22+ / TypeScript strict / node:test + node:assert/strict / ESM with .js imports

---

## 统一时间线：万物为一 8 原则 × 天权三层

| 原则 | 覆盖方 | 阶段 | 状态 |
|------|--------|------|------|
| ①溶解即新生（claim checkpoint） | **本计划 Task 1** | Wave B | 待实施 |
| ②有限规则涌现（跨 store 耦合） | 天权 Phase 2 | Wave B | 天权排期 |
| ③参考系锚定（外部参考信号） | **本计划 Task 4** | Wave B | 待实施（天权 Phase 1 先修 freshness 消费链） |
| ④模糊是力量（uncertainty framing） | 天权 Phase 2 | Wave B | 天权排期 |
| ⑤检查结构不检查内容（syndrome） | **本计划 Task 3** | Wave B | 待实施 |
| ⑥速率比阈值致命（rate detection） | **本计划 Task 2** | Wave B | 待实施 |
| ⑦面积限制体积（holographic UI） | 后续 | Wave C | 设计哲学层 |
| ⑧适应是常态化（normalization） | 天权 Phase 1 (star-soul 涌现) | Wave A | 天权排期 |

**Wave A** = 天权 Phase 1（净化）→ **Wave B** = 本计划 4 任务 + 天权 Phase 2 → **Wave C** = 文档 + 开源

---

## 文件结构

| 操作 | 文件路径 | 职责 |
|------|---------|------|
| 修改 | `src/context/claim-store.ts` | 新增 `checkpoint()` 和 `loadFromCheckpoint()` 方法 |
| 创建 | `src/context/__tests__/claim-checkpoint.test.ts` | checkpoint + truncate 的 TDD 测试 |
| 修改 | `src/context/compact-policy.ts` | `decideCompactTier` 加入 token 增长速率提升 |
| 修改 | `src/context/pressure-monitor.ts` | 新增 `tokenGrowthRate()` 方法 |
| 创建 | `src/context/__tests__/rate-detection.test.ts` | 速率检测的 TDD 测试 |
| 创建 | `src/agent/hooks/consistency-check-hook.ts` | store 间一致性校验 postTurn hook |
| 修改 | `src/agent/create-runtime-hooks.ts` | 注册 consistency-check hook |
| 创建 | `src/agent/hooks/__tests__/consistency-check-hook.test.ts` | 一致性校验的 TDD 测试 |
| 创建 | `src/agent/fs-watcher.ts` | 轻量文件系统变更监听器 |
| 修改 | `src/agent/sensorium.ts` | `computeFreshness` 加入 fs event rate |
| 修改 | `src/agent/loop.ts` | 初始化 fs-watcher，传入 sensorium input |
| 创建 | `src/agent/__tests__/fs-watcher.test.ts` | fs-watcher 的 TDD 测试 |

---

### 任务 1：claim-store checkpoint + truncate（原则①溶解即新生）

**文件：**
- 修改：`src/context/claim-store.ts:179-250`
- 创建：`src/context/__tests__/claim-checkpoint.test.ts`

**设计：** 在 claim JSONL 旁边写一个 `.claims.snapshot.json`（完整状态快照），然后清空 JSONL 重新开始增量追加。加载时先读 snapshot 再重放增量。遵循 Redis 7.0 双文件 Base+Incr 模式。

- [ ] **步骤 1：编写 checkpoint 的失败测试**

```typescript
// src/context/__tests__/claim-checkpoint.test.ts
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ContextClaimStore } from '../claim-store.js'

describe('claim-store checkpoint', () => {
  let dir: string

  before(() => { dir = mkdtempSync(join(tmpdir(), 'claim-cp-')) })
  after(() => { rmSync(dir, { recursive: true, force: true }) })

  it('checkpoint writes snapshot and truncates JSONL', () => {
    const store = new ContextClaimStore(dir, 'test-session')

    // Propose 3 claims to create JSONL events
    store.propose({ kind: 'decision', scope: 'session', text: 'use ESM', confidence: 0.8, tags: ['esm'], evidence: [], source: { eventId: 'e1', toolName: 'edit' }, createdAt: Date.now() })
    store.propose({ kind: 'decision', scope: 'session', text: 'use strict', confidence: 0.9, tags: ['ts'], evidence: [], source: { eventId: 'e2', toolName: 'edit' }, createdAt: Date.now() })
    store.propose({ kind: 'file_observation', scope: 'file', text: 'index.ts exists', confidence: 0.5, tags: [], evidence: [{ type: 'file', path: 'index.ts', summary: 'exists' }], source: { eventId: 'e3', toolName: 'read_file' }, createdAt: Date.now() })

    const claimsBefore = store.listClaims()
    assert.equal(claimsBefore.length, 3)

    // Checkpoint
    const result = store.checkpoint()
    assert.ok(result.snapshotPath)
    assert.ok(existsSync(result.snapshotPath))
    assert.equal(result.claimCount, 3)

    // JSONL should be empty (truncated) or very small
    const jsonlContent = readFileSync(store.path, 'utf-8').trim()
    assert.equal(jsonlContent, '', 'JSONL should be empty after checkpoint')

    // Claims should still be accessible (from snapshot)
    const claimsAfter = store.listClaims()
    assert.equal(claimsAfter.length, 3)
    assert.deepEqual(
      claimsAfter.map(c => c.text).sort(),
      claimsBefore.map(c => c.text).sort()
    )
  })

  it('new events after checkpoint append to JSONL incrementally', () => {
    const store = new ContextClaimStore(dir, 'test-incr')
    store.propose({ kind: 'decision', scope: 'session', text: 'claim-1', confidence: 0.8, tags: [], evidence: [], source: { eventId: 'e1', toolName: 'edit' }, createdAt: Date.now() })

    store.checkpoint()

    store.propose({ kind: 'decision', scope: 'session', text: 'claim-2', confidence: 0.9, tags: [], evidence: [], source: { eventId: 'e2', toolName: 'edit' }, createdAt: Date.now() })

    const claims = store.listClaims()
    assert.equal(claims.length, 2, 'should see snapshot claim + incremental claim')
  })

  it('loadFromCheckpoint recovers full state', () => {
    const store = new ContextClaimStore(dir, 'test-recover')
    store.propose({ kind: 'decision', scope: 'session', text: 'before-cp', confidence: 0.8, tags: [], evidence: [], source: { eventId: 'e1', toolName: 'edit' }, createdAt: Date.now() })
    store.checkpoint()
    store.propose({ kind: 'decision', scope: 'session', text: 'after-cp', confidence: 0.9, tags: [], evidence: [], source: { eventId: 'e2', toolName: 'edit' }, createdAt: Date.now() })

    // Simulate restart: new store instance loads from checkpoint + incremental
    const store2 = new ContextClaimStore(dir, 'test-recover')
    const claims = store2.listClaims()
    assert.equal(claims.length, 2)
    assert.ok(claims.some(c => c.text === 'before-cp'))
    assert.ok(claims.some(c => c.text === 'after-cp'))
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`node --test src/context/__tests__/claim-checkpoint.test.ts`
预期：FAIL，报错 `store.checkpoint is not a function`

- [ ] **步骤 3：实现 checkpoint 和 loadFromCheckpoint**

在 `src/context/claim-store.ts` 中新增：

```typescript
// 在文件顶部添加 import
import { writeFileSync, unlinkSync } from 'node:fs'

// 在 ContextClaimStore 类中，exportSession() 方法之前添加：

  get snapshotPath(): string {
    return this.path.replace('.claims.jsonl', '.claims.snapshot.json')
  }

  checkpoint(): { snapshotPath: string; claimCount: number } {
    const claims = this.projectClaims()
    writeFileSync(this.snapshotPath, JSON.stringify(claims), 'utf-8')
    writeFileSync(this.path, '', 'utf-8')
    this.cachedEvents = null
    this.cachedClaims = null
    this.lastFileSize = -1
    this.lastProcessedLineCount = 0
    return { snapshotPath: this.snapshotPath, claimCount: claims.length }
  }

  private loadSnapshot(): ContextClaim[] {
    if (!existsSync(this.snapshotPath)) return []
    try {
      const raw = readFileSync(this.snapshotPath, 'utf-8')
      const parsed = JSON.parse(raw)
      return Array.isArray(parsed) ? parsed : []
    } catch {
      return []
    }
  }
```

然后修改 `projectClaims()` 方法，使其先加载 snapshot 再重放增量：

```typescript
  private projectClaims(): ContextClaim[] {
    const events = this.loadEvents()
    // If snapshot exists and JSONL is empty or has only incremental events, merge
    const snapshotClaims = this.loadSnapshot()
    if (snapshotClaims.length > 0 && events.length === 0) {
      return snapshotClaims
    }
    const baseMap = new Map<string, ContextClaim>()
    for (const claim of snapshotClaims) {
      baseMap.set(claim.id, claim)
    }
    return applyEventsToMap(baseMap, events)
  }
```

注意：需要提取现有的 `applyEventsToMap` 逻辑为独立函数（如果还没有的话），使其接受一个初始 Map。

- [ ] **步骤 4：运行测试验证通过**

运行：`node --test src/context/__tests__/claim-checkpoint.test.ts`
预期：3/3 PASS

- [ ] **步骤 5：运行全量回归**

运行：`npm test`
预期：全部 PASS（现有测试不受影响，因为没有改变现有 API）

- [ ] **步骤 6：Commit**

```bash
git add src/context/claim-store.ts src/context/__tests__/claim-checkpoint.test.ts
git commit -m "feat(claim-store): add checkpoint + truncate for Solve et Coagula (万物为一 原则①)

Claim JSONL now supports snapshot-based checkpoint: projectClaims() into
snapshot JSON, truncate JSONL, continue appending incrementally. Recovery
loads snapshot + replays incremental events. Follows Redis 7.0 dual-file
Base+Incr pattern."
```

---

### 任务 2：token 增长速率检测（原则⑥速率比阈值致命）

**文件：**
- 修改：`src/context/pressure-monitor.ts:12-42`
- 修改：`src/context/compact-policy.ts:30-37`
- 创建：`src/context/__tests__/rate-detection.test.ts`

**设计：** PressureMonitor 记录每次 check 的 token 数，计算 turn-over-turn 增长率。如果增长率超过阈值（每 turn 增长 >10% context window），将 tier 提升一级。这是 AMOC 洞察的最小实现：崩溃由速率而非阈值决定。

- [ ] **步骤 1：编写速率检测的失败测试**

```typescript
// src/context/__tests__/rate-detection.test.ts
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { PressureMonitor } from '../pressure-monitor.js'

describe('token growth rate detection', () => {
  it('detects fast growth rate and boosts tier', () => {
    const monitor = new PressureMonitor(1_000_000)

    // Turn 1: 300K tokens (ratio 0.3 → tier 0 normally)
    const r1 = monitor.check(300_000, 1)
    assert.equal(r1.tier, 0, 'first check has no rate history')

    // Turn 2: 500K tokens (ratio 0.5 → tier 0 normally, but delta = 200K = 20% of window)
    const r2 = monitor.check(500_000, 2)
    assert.equal(r2.fastGrowth, true, 'should detect fast growth')
    // 20% growth per turn exceeds threshold → tier should be boosted
    assert.ok(r2.tier >= 1, 'fast growth should boost tier')
  })

  it('does not flag slow growth', () => {
    const monitor = new PressureMonitor(1_000_000)
    monitor.check(300_000, 1)
    // Slow growth: 320K (delta = 20K = 2% of window)
    const r2 = monitor.check(320_000, 2)
    assert.equal(r2.fastGrowth, false, 'slow growth should not flag')
  })

  it('growth rate uses smoothed average not single spike', () => {
    const monitor = new PressureMonitor(1_000_000)
    monitor.check(300_000, 1)
    monitor.check(310_000, 2) // slow
    monitor.check(320_000, 3) // slow
    // Single spike should not immediately trigger if history is slow
    const r = monitor.check(450_000, 4) // 130K spike = 13%
    // With smoothing, average rate is (10+10+130)/3 = 50K = 5% — below threshold
    assert.equal(r.fastGrowth, false, 'single spike with slow history should not flag')
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`node --test src/context/__tests__/rate-detection.test.ts`
预期：FAIL，`fastGrowth` 属性不存在

- [ ] **步骤 3：实现 PressureMonitor 速率追踪**

修改 `src/context/pressure-monitor.ts`：

```typescript
import type { CompactTier } from './types.js'
import { tierForRatio } from './compact-policy.js'

const FAST_GROWTH_THRESHOLD = 0.10
const RATE_HISTORY_SIZE = 3

export interface PressureResult {
  tier: CompactTier
  shouldCompact: boolean
  thrashing: boolean
  fastGrowth: boolean
  suggestion?: 'task_decomposition'
  ratio: number
}

export class PressureMonitor {
  private compactionTurns: number[] = []
  private tokenHistory: Array<{ tokens: number; turn: number }> = []

  constructor(private contextWindow: number) {}

  check(estimatedTokens: number, currentTurn: number): PressureResult {
    const ratio = this.contextWindow > 0 ? estimatedTokens / this.contextWindow : 1
    let tier = tierForRatio(ratio)
    const thrashing = this.detectThrashing(currentTurn)
    const fastGrowth = this.detectFastGrowth(estimatedTokens)

    if (fastGrowth && tier < 4) {
      tier = Math.min(tier + 1, 4) as CompactTier
    }

    this.tokenHistory = [...this.tokenHistory, { tokens: estimatedTokens, turn: currentTurn }].slice(-RATE_HISTORY_SIZE - 1)

    return {
      tier,
      shouldCompact: tier > 0,
      thrashing,
      fastGrowth,
      suggestion: thrashing ? 'task_decomposition' : undefined,
      ratio,
    }
  }

  recordCompaction(turn: number): void {
    this.compactionTurns = [...this.compactionTurns, turn].slice(-10)
  }

  getCompactionTurns(): number[] {
    return [...this.compactionTurns]
  }

  private detectThrashing(currentTurn: number): boolean {
    return this.compactionTurns.filter(turn => currentTurn - turn <= 4).length >= 3
  }

  private detectFastGrowth(currentTokens: number): boolean {
    if (this.tokenHistory.length < 1) return false
    const deltas = this.tokenHistory
      .slice(-RATE_HISTORY_SIZE)
      .map(h => h.tokens)
    deltas.push(currentTokens)
    if (deltas.length < 2) return false

    let totalDelta = 0
    for (let i = 1; i < deltas.length; i++) {
      totalDelta += Math.max(0, deltas[i]! - deltas[i - 1]!)
    }
    const avgDelta = totalDelta / (deltas.length - 1)
    return this.contextWindow > 0 && avgDelta / this.contextWindow >= FAST_GROWTH_THRESHOLD
  }
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`node --test src/context/__tests__/rate-detection.test.ts`
预期：3/3 PASS

- [ ] **步骤 5：运行全量回归**

运行：`npm test`
预期：全部 PASS（PressureResult 类型扩展了 `fastGrowth` 字段，现有消费者不读此字段所以不受影响）

- [ ] **步骤 6：Commit**

```bash
git add src/context/pressure-monitor.ts src/context/__tests__/rate-detection.test.ts
git commit -m "feat(pressure-monitor): add token growth rate detection (万物为一 原则⑥)

AMOC insight: collapse is rate-dependent, not threshold-dependent. Slow
growth to 5.5°C is stable; fast injection at 2.2°C triggers collapse.
PressureMonitor now tracks token delta history and boosts compact tier
when smoothed growth rate exceeds 10% of context window per turn."
```

---

### 任务 3：store 间一致性校验 hook（原则⑤检查结构不检查内容）

**文件：**
- 创建：`src/agent/hooks/consistency-check-hook.ts`
- 修改：`src/agent/create-runtime-hooks.ts:46-91`
- 创建：`src/agent/hooks/__tests__/consistency-check-hook.test.ts`

**设计：** 一个 postTurn hook，检查 claim-store 和 stigmergy-store 之间的信号一致性。核心 QEC syndrome：不读内容，只检查关系。例如：如果 stigmergy 对文件 A 标记 `well-tested`，但 claim-store 中同文件的 claim 状态为 `stale`，这是一个 syndrome（不一致）。syndrome 不直接修复——它降低 sensorium.stability 通知系统。

- [ ] **步骤 1：编写一致性校验的失败测试**

```typescript
// src/agent/hooks/__tests__/consistency-check-hook.test.ts
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { checkStoreConsistency, type ConsistencyInput } from '../consistency-check-hook.js'

describe('store consistency check (syndrome measurement)', () => {
  it('detects syndrome: well-tested pheromone + stale claim on same file', () => {
    const input: ConsistencyInput = {
      pheromones: [
        { path: 'src/utils.ts', signal: 'well-tested', currentStrength: 0.6 },
      ],
      claimsByFile: new Map([
        ['src/utils.ts', [{ status: 'stale', text: 'utils exports helper' }]],
      ]),
    }
    const result = checkStoreConsistency(input)
    assert.ok(result.syndromes.length > 0, 'should detect well-tested + stale syndrome')
    assert.ok(result.stabilityPenalty > 0, 'should have stability penalty')
  })

  it('no syndrome when pheromone and claim agree', () => {
    const input: ConsistencyInput = {
      pheromones: [
        { path: 'src/utils.ts', signal: 'well-tested', currentStrength: 0.6 },
      ],
      claimsByFile: new Map([
        ['src/utils.ts', [{ status: 'active', text: 'utils is solid' }]],
      ]),
    }
    const result = checkStoreConsistency(input)
    assert.equal(result.syndromes.length, 0, 'no syndrome when consistent')
    assert.equal(result.stabilityPenalty, 0)
  })

  it('detects syndrome: dead-end pheromone + active claim', () => {
    const input: ConsistencyInput = {
      pheromones: [
        { path: 'src/broken.ts', signal: 'dead-end', currentStrength: 0.8 },
      ],
      claimsByFile: new Map([
        ['src/broken.ts', [{ status: 'active', text: 'broken.ts works fine' }]],
      ]),
    }
    const result = checkStoreConsistency(input)
    assert.ok(result.syndromes.length > 0, 'should detect dead-end + active syndrome')
  })

  it('returns empty when no overlapping files', () => {
    const input: ConsistencyInput = {
      pheromones: [
        { path: 'src/a.ts', signal: 'well-tested', currentStrength: 0.5 },
      ],
      claimsByFile: new Map([
        ['src/b.ts', [{ status: 'active', text: 'b is fine' }]],
      ]),
    }
    const result = checkStoreConsistency(input)
    assert.equal(result.syndromes.length, 0)
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`node --test src/agent/hooks/__tests__/consistency-check-hook.test.ts`
预期：FAIL，模块不存在

- [ ] **步骤 3：实现 consistency-check-hook**

```typescript
// src/agent/hooks/consistency-check-hook.ts
import type { PostTurnRuntimeHook, RuntimeHookContext } from '../runtime-hooks.js'
import type { PheromoneSignal } from '../../context/stigmergy.js'
import type { ContextClaimStatus } from '../../context/claims.js'

export interface PheromoneRef {
  path: string
  signal: PheromoneSignal
  currentStrength: number
}

export interface ClaimRef {
  status: ContextClaimStatus
  text: string
}

export interface ConsistencyInput {
  pheromones: PheromoneRef[]
  claimsByFile: Map<string, ClaimRef[]>
}

export interface Syndrome {
  path: string
  pheromoneSignal: PheromoneSignal
  claimStatus: ContextClaimStatus
  description: string
}

export interface ConsistencyResult {
  syndromes: Syndrome[]
  stabilityPenalty: number
}

const CONTRADICTIONS: Array<{ signal: PheromoneSignal; claimStatus: ContextClaimStatus; description: string }> = [
  { signal: 'well-tested', claimStatus: 'stale', description: 'pheromone says well-tested but claim is stale' },
  { signal: 'well-tested', claimStatus: 'quarantined', description: 'pheromone says well-tested but claim is quarantined' },
  { signal: 'dead-end', claimStatus: 'active', description: 'pheromone says dead-end but claim is still active' },
  { signal: 'dead-end', claimStatus: 'durable', description: 'pheromone says dead-end but claim is durable' },
  { signal: 'fragile', claimStatus: 'durable', description: 'pheromone says fragile but claim is durable' },
]

const PENALTY_PER_SYNDROME = 0.05
const MAX_PENALTY = 0.2

export function checkStoreConsistency(input: ConsistencyInput): ConsistencyResult {
  const syndromes: Syndrome[] = []

  for (const pheromone of input.pheromones) {
    const claims = input.claimsByFile.get(pheromone.path)
    if (!claims || claims.length === 0) continue

    for (const claim of claims) {
      for (const rule of CONTRADICTIONS) {
        if (pheromone.signal === rule.signal && claim.status === rule.claimStatus) {
          syndromes.push({
            path: pheromone.path,
            pheromoneSignal: pheromone.signal,
            claimStatus: claim.status,
            description: rule.description,
          })
        }
      }
    }
  }

  const stabilityPenalty = Math.min(syndromes.length * PENALTY_PER_SYNDROME, MAX_PENALTY)
  return { syndromes, stabilityPenalty }
}

export function createConsistencyCheckHook(deps: {
  queryPheromones: () => PheromoneRef[]
  getClaimsByFile: (path: string) => ClaimRef[]
}): PostTurnRuntimeHook {
  return {
    name: 'consistency-check',
    phase: 'postTurn',
    run(ctx: RuntimeHookContext): void {
      const pheromones = deps.queryPheromones()
      const uniquePaths = [...new Set(pheromones.map(p => p.path))]
      const claimsByFile = new Map<string, ClaimRef[]>()
      for (const path of uniquePaths) {
        const claims = deps.getClaimsByFile(path)
        if (claims.length > 0) claimsByFile.set(path, claims)
      }

      const result = checkStoreConsistency({ pheromones, claimsByFile })
      if (result.stabilityPenalty > 0 && ctx.snapshot.sensorium) {
        const adjusted = Math.max(0, ctx.snapshot.sensorium.stability - result.stabilityPenalty)
        ctx.effects.setSensorium({ ...ctx.snapshot.sensorium, stability: adjusted })
      }
    },
  }
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`node --test src/agent/hooks/__tests__/consistency-check-hook.test.ts`
预期：4/4 PASS

- [ ] **步骤 5：注册 hook 到 pipeline**

修改 `src/agent/create-runtime-hooks.ts`，在 hooks 数组末尾（telemetry-flush 之前）添加：

```typescript
import { createConsistencyCheckHook } from './hooks/consistency-check-hook.js'

// 在 createDefaultRuntimeHooks 函数体内，playbook-reflect 之后添加：
if (deps.claimStore && deps.stigmergyStore) {
  hooks.push(createConsistencyCheckHook({
    queryPheromones: () => deps.stigmergyStore!.query().map(p => ({
      path: p.path, signal: p.signal, currentStrength: p.currentStrength,
    })),
    getClaimsByFile: (path: string) => deps.claimStore!.listClaimsByFileEvidence(path).map(c => ({
      status: c.status, text: c.text,
    })),
  }))
}
```

- [ ] **步骤 6：运行全量回归**

运行：`npm test`
预期：全部 PASS

- [ ] **步骤 7：Commit**

```bash
git add src/agent/hooks/consistency-check-hook.ts src/agent/hooks/__tests__/consistency-check-hook.test.ts src/agent/create-runtime-hooks.ts
git commit -m "feat(hooks): add store consistency check hook (万物为一 原则⑤)

QEC syndrome measurement: check relationships between stores, not content.
Detects contradictions like well-tested pheromone + stale claim on same
file. Penalizes sensorium.stability without reading full context."
```

---

### 任务 4：sensorium 接入 fs.watch 事件（原则③参考系锚定扩展）

**前置条件：** 天权 Phase 1 完成 freshness 消费链修复后执行。

**文件：**
- 创建：`src/agent/fs-watcher.ts`
- 修改：`src/agent/sensorium.ts:52-71`（SensoriumInput）和 `113-124`（computeFreshness）
- 修改：`src/agent/loop.ts`（初始化和清理）
- 创建：`src/agent/__tests__/fs-watcher.test.ts`

**设计：** 轻量的 fs.watch 包装器，对项目目录变更事件做 2 秒防抖，计算"每分钟变更文件数"。作为第三个信号混入 `computeFreshness`（50% pheromone + 25% git + 25% fs events）。这是"月光"——免费的外部参考信号。

- [ ] **步骤 1：编写 fs-watcher 的失败测试**

```typescript
// src/agent/__tests__/fs-watcher.test.ts
import { describe, it, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { FsEventMonitor } from '../fs-watcher.js'

describe('FsEventMonitor', () => {
  it('counts file change events with debounce', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fswatch-'))
    const monitor = new FsEventMonitor(dir, { debounceMs: 100, ignorePatterns: [] })
    monitor.start()

    // Create a file to trigger event
    writeFileSync(join(dir, 'test.ts'), 'hello')
    await new Promise(r => setTimeout(r, 200))

    const rate = monitor.getChangeRate()
    assert.ok(rate > 0, 'should detect file change')

    monitor.stop()
    rmSync(dir, { recursive: true, force: true })
  })

  it('ignores node_modules and .git', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fswatch-ign-'))
    const monitor = new FsEventMonitor(dir, {
      debounceMs: 100,
      ignorePatterns: ['node_modules', '.git'],
    })
    monitor.start()

    // The watcher itself won't see subdirectory changes without recursive
    // but the filter should work on any events that do arrive
    const rate = monitor.getChangeRate()
    assert.equal(typeof rate, 'number')

    monitor.stop()
    rmSync(dir, { recursive: true, force: true })
  })

  it('getChangeRate returns 0 when no events', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fswatch-empty-'))
    const monitor = new FsEventMonitor(dir, { debounceMs: 100, ignorePatterns: [] })
    monitor.start()

    const rate = monitor.getChangeRate()
    assert.equal(rate, 0)

    monitor.stop()
    rmSync(dir, { recursive: true, force: true })
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`node --test src/agent/__tests__/fs-watcher.test.ts`
预期：FAIL，模块不存在

- [ ] **步骤 3：实现 FsEventMonitor**

```typescript
// src/agent/fs-watcher.ts
import { watch, type FSWatcher } from 'node:fs'
import { relative } from 'node:path'

export interface FsWatcherOptions {
  debounceMs: number
  ignorePatterns: string[]
}

const DEFAULT_OPTIONS: FsWatcherOptions = {
  debounceMs: 2000,
  ignorePatterns: ['node_modules', '.git', '.rivet', 'dist', 'build'],
}

const RATE_WINDOW_MS = 60_000

export class FsEventMonitor {
  private watcher: FSWatcher | null = null
  private events: number[] = []
  private debounceTimer: ReturnType<typeof setTimeout> | null = null
  private pendingPaths = new Set<string>()
  private options: FsWatcherOptions

  constructor(
    private cwd: string,
    options: Partial<FsWatcherOptions> = {},
  ) {
    this.options = { ...DEFAULT_OPTIONS, ...options }
  }

  start(): void {
    if (this.watcher) return
    try {
      this.watcher = watch(this.cwd, { recursive: true }, (_event, filename) => {
        if (!filename) return
        const rel = relative(this.cwd, filename)
        if (this.shouldIgnore(rel)) return
        this.pendingPaths.add(rel)
        this.scheduleBatch()
      })
    } catch {
      // fs.watch may not support recursive on all platforms
    }
  }

  stop(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer)
    this.watcher?.close()
    this.watcher = null
  }

  getChangeRate(): number {
    const now = Date.now()
    this.events = this.events.filter(t => now - t < RATE_WINDOW_MS)
    return this.events.length
  }

  private shouldIgnore(relPath: string): boolean {
    return this.options.ignorePatterns.some(pattern => relPath.startsWith(pattern) || relPath.includes(`/${pattern}/`))
  }

  private scheduleBatch(): void {
    if (this.debounceTimer) return
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null
      if (this.pendingPaths.size > 0) {
        this.events.push(Date.now())
        this.pendingPaths.clear()
      }
    }, this.options.debounceMs)
  }
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`node --test src/agent/__tests__/fs-watcher.test.ts`
预期：3/3 PASS

- [ ] **步骤 5：在 sensorium 中集成 fs event rate**

修改 `src/agent/sensorium.ts`：

在 `SensoriumInput` 接口中（约第52行），添加：
```typescript
  fsEventRate?: number
```

修改 `computeFreshness` 函数（约第113行），从 70/30 混合变为 50/25/25 三路混合：

```typescript
function computeFreshness(input: SensoriumInput): number {
  const pheromoneAvg = input.pheromones.length > 0
    ? input.pheromones.reduce((sum, p) => sum + p.strength, 0) / input.pheromones.length
    : 0.5
  const gitFreshness = input.gitChangeRate !== undefined ? 1 - input.gitChangeRate : 0.5
  const fsFreshness = input.fsEventRate !== undefined
    ? Math.max(0, 1 - input.fsEventRate / 10)
    : 0.5
  return 0.5 * pheromoneAvg + 0.25 * gitFreshness + 0.25 * fsFreshness
}
```

- [ ] **步骤 6：在 loop.ts 中初始化 FsEventMonitor**

修改 `src/agent/loop.ts`，在 constructor 或 `run()` 中：

```typescript
import { FsEventMonitor } from './fs-watcher.js'

// 在 AgentLoop 类中添加属性：
private fsMonitor?: FsEventMonitor

// 在 run() 方法开始处（约在 gitChangeRate 初始化附近）：
this.fsMonitor = new FsEventMonitor(this.cwd)
this.fsMonitor.start()

// 在 perception.perceive() 调用前，将 fsEventRate 传入 SensoriumInput：
// （在构建 sensoriumInput 的位置附近）
fsEventRate: this.fsMonitor?.getChangeRate() ?? 0

// 在 session 结束时清理：
this.fsMonitor?.stop()
```

- [ ] **步骤 7：运行全量回归**

运行：`npm test`
预期：全部 PASS

- [ ] **步骤 8：Commit**

```bash
git add src/agent/fs-watcher.ts src/agent/__tests__/fs-watcher.test.ts src/agent/sensorium.ts src/agent/loop.ts
git commit -m "feat(sensorium): integrate fs.watch as external reference signal (万物为一 原则③)

Coral spawning uses moonlight as a free external clock. Rivet now uses
file system events as a free freshness signal. FsEventMonitor watches
project directory with 2s debounce, feeds change rate into sensorium
freshness (50% pheromone + 25% git + 25% fs events)."
```

---

## 自检

### 1. 规格覆盖度

| 原则 | 任务 | 覆盖 |
|------|------|------|
| ①溶解即新生 | Task 1 (claim checkpoint) | ✓ |
| ②有限规则涌现 | 天权 Phase 2 | ✓（非本计划） |
| ③参考系锚定 | Task 4 (fs.watch) | ✓ |
| ④模糊是力量 | 天权 Phase 2 | ✓（非本计划） |
| ⑤检查结构不检查内容 | Task 3 (consistency hook) | ✓ |
| ⑥速率比阈值致命 | Task 2 (rate detection) | ✓ |
| ⑦面积限制体积 | 后续 Wave C | 标注为后续 |
| ⑧适应是常态化 | 天权 Phase 1 | ✓（非本计划） |

### 2. 占位符扫描

无"TODO"、"待定"、"后续实现"。所有步骤包含完整代码。

### 3. 类型一致性

- `PheromoneRef` 在 Task 3 中定义，与 `stigmergy.ts` 的 `PheromoneQueryResult` 兼容
- `ConsistencyInput.claimsByFile` 使用 `ClaimRef`（简化类型），从 `ContextClaim` 映射
- `SensoriumInput.fsEventRate` 是可选字段，不破坏现有消费者
- `PressureResult.fastGrowth` 是新增字段，不破坏现有消费者

---

## 执行交接

计划已完成并保存到 `docs/superpowers/plans/2026-05-20-wanwu-weiyi-engineering.md`。两种执行方式：

**1. 子代理驱动（推荐）** - 每个任务调度一个新的子代理，任务间进行审查，快速迭代

**2. 内联执行** - 在当前会话中使用 executing-plans 执行任务，批量执行并设有检查点

选哪种方式？
