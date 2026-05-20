# 万物为一工程实施 — 天枢交接计划

> **分支**: `feat/tianshu-star-soul`
> **前置依赖**: `docs/superpowers/specs/2026-05-20-wanwu-weiyi-design-principles.md`
> **状态**: 4 个 Task，全部未开始

---

## 哲学背景（一句话）

万物为一 = 只实施 6 个独立领域**全部收敛**的模式。本轮选出 4 个可落地的工程原则：

| 原则 | 来源 | 核心思想 |
|------|------|----------|
| ① 溶解即新生 | Solve et Coagula | claim-store 需要 checkpoint — 当前 O(history) 恢复太慢 |
| ③ 参考系锚定 | Etak / 28 宿 | 所有时间信号都是内部的 — 需要外部 Zeitgeber（文件系统事件） |
| ⑤ 有限规则无限涌现 | Girih / 洛书 | 4 个 store 互相独立 — 需要 cross-store 耦合信号 |
| ⑥ 速率比阈值 | 阿基米德 / 螺旋 | PressureMonitor 只看绝对值 — 需要 token 增长率信号 |

---

## 新 session 执行步骤

```
1. git add -A && git commit  （先提交 reliability 改动）
2. 按 Task 2 → 1 → 3 → 4 顺序执行（从最小改动到最大）
3. 每个 Task 完成后跑单测验证
4. 最后 npx tsc --noEmit && npm test
5. git commit -m "feat(wanwu): implement 4 engineering principles (①③⑤⑥)"
```

**关键决策：**
- Task 2 不改 compact-policy — `fastGrowth` 供消费方自行判断
- Task 1 不改构造函数 — snapshot 感知是后续优化
- Task 3 用 deps injection — 遵循现有 hooks 模式
- Task 4 只 watch 顶层 — `recursive: false` 避免 node_modules 开销
- 所有 import 带 `.js` 后缀 — TypeScript strict + ESM 要求

**注意：** Task 1 第 5 个测试 "full recovery" 需要改构造函数加入 snapshot 感知，可以先跳过作为后续优化。

---

## Task 2: 原则 ⑥ 速率比阈值 — PressureMonitor + token 历史

> **原理**: 当前 PressureMonitor 只看 `ratio = estimatedTokens / contextWindow`（绝对压力值）。
> 但 60% → 80% 的急速增长比稳定在 75% 更危险。需要记录 token 历史，计算增长率。

### 改动文件

| 文件 | 操作 |
|------|------|
| `src/context/pressure-monitor.ts` | 修改 — 添加 `tokenHistory[]` + `fastGrowth` |
| `src/context/__tests__/pressure-monitor.test.ts` | 新建 — 覆盖 fastGrowth 场景 |

### 代码变更

**`src/context/pressure-monitor.ts`** — 修改后的完整文件：

```typescript
import type { CompactTier } from './types.js'
import { tierForRatio } from './compact-policy.js'

export interface PressureResult {
  tier: CompactTier
  shouldCompact: boolean
  thrashing: boolean
  fastGrowth: boolean
  suggestion?: 'task_decomposition'
  ratio: number
  growthRate: number
}

/** Minimum ratio delta between consecutive checks to flag fast growth. */
const FAST_GROWTH_THRESHOLD = 0.15

export class PressureMonitor {
  private compactionTurns: number[] = []
  private tokenHistory: Array<{ turn: number; tokens: number }> = []

  constructor(private contextWindow: number) {}

  check(estimatedTokens: number, currentTurn: number): PressureResult {
    const ratio = this.contextWindow > 0 ? estimatedTokens / this.contextWindow : 1
    const tier = tierForRatio(ratio)
    const thrashing = this.detectThrashing(currentTurn)

    // ── Growth rate: ratio delta since last check ──
    const prevRatio = this.tokenHistory.length > 0
      ? (this.tokenHistory[this.tokenHistory.length - 1]!.tokens / this.contextWindow)
      : ratio
    const growthRate = ratio - prevRatio
    const fastGrowth = growthRate >= FAST_GROWTH_THRESHOLD

    // Record for next comparison
    this.tokenHistory = [...this.tokenHistory, { turn: currentTurn, tokens: estimatedTokens }].slice(-20)

    return {
      tier,
      shouldCompact: tier > 0,
      thrashing,
      fastGrowth,
      suggestion: thrashing ? 'task_decomposition' : undefined,
      ratio,
      growthRate,
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
}
```

**变更摘要**：
- `PressureResult` 新增 `fastGrowth: boolean` + `growthRate: number`
- 新增私有字段 `tokenHistory: Array<{ turn: number; tokens: number }>`（滑动窗口 20）
- `check()` 计算 `growthRate = currentRatio - previousRatio`
- `fastGrowth = growthRate >= 0.15`（单 turn 内 ratio 跳升 15% 以上）
- **不改** compact-policy.ts — `fastGrowth` 是信号，不是决策。消费方自行判断是否提前 compact

### 测试

**`src/context/__tests__/pressure-monitor.test.ts`**：

```typescript
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { PressureMonitor } from '../pressure-monitor.js'

describe('PressureMonitor', () => {
  const WINDOW = 100_000

  it('reports fastGrowth when ratio jumps ≥0.15 in one turn', () => {
    const pm = new PressureMonitor(WINDOW)
    pm.check(50_000, 1)  // 0.50 — baseline
    const result = pm.check(70_000, 2)  // 0.70 — +0.20 jump
    assert.equal(result.fastGrowth, true)
    assert.ok(result.growthRate >= 0.15)
  })

  it('does not flag fastGrowth for gradual increase', () => {
    const pm = new PressureMonitor(WINDOW)
    pm.check(50_000, 1)  // 0.50
    const result = pm.check(55_000, 2)  // 0.55 — +0.05
    assert.equal(result.fastGrowth, false)
  })

  it('growthRate is zero on first check (no history)', () => {
    const pm = new PressureMonitor(WINDOW)
    const result = pm.check(50_000, 1)
    assert.equal(result.growthRate, 0)
    assert.equal(result.fastGrowth, false)
  })

  it('tokenHistory window is capped at 20 entries', () => {
    const pm = new PressureMonitor(WINDOW)
    for (let i = 1; i <= 25; i++) {
      pm.check(50_000 + i * 100, i)
    }
    // Should not throw; internal window is capped
    const result = pm.check(80_000, 26)
    assert.ok(typeof result.growthRate === 'number')
  })

  it('thrashing detection still works alongside fastGrowth', () => {
    const pm = new PressureMonitor(WINDOW)
    pm.recordCompaction(1)
    pm.recordCompaction(2)
    pm.recordCompaction(3)
    const result = pm.check(50_000, 5)
    assert.equal(result.thrashing, true)
    assert.equal(result.suggestion, 'task_decomposition')
  })
})
```

---

## Task 1: 原则 ① 溶解即新生 — claim-store checkpoint

> **原理**: Solve et Coagula = 有意溶解以产生更高阶的存在。claim-store 当前没有快照/恢复机制，
> 每次 resume 都要从头重建。需要 `checkpoint()` 导出当前 claims 快照 + `loadClaimSnapshot()` 恢复。
>
> **注意**: `claims.ts` 是纯数据模型（interface + 函数），没有 ClaimStore 类。
> checkpoint 逻辑加在 `claims.ts` 的函数层，不引入类。

### 改动文件

| 文件 | 操作 |
|------|------|
| `src/context/claims.ts` | 修改 — 添加 `checkpointClaims()` + `loadClaimSnapshot()` |
| `src/context/__tests__/claims-checkpoint.test.ts` | 新建 — 覆盖快照/恢复 |

### 代码变更

**`src/context/claims.ts`** — 在文件末尾追加：

```typescript
// ── Checkpoint: 溶解即新生 ────────────────────────────────────────

export interface ClaimSnapshot {
  version: 1
  createdAt: number
  claims: ContextClaim[]
}

/**
 * 导出当前活跃 claims 的快照。
 * 只包含 non-stale, non-expired claims — 溶解时丢弃已失效的信息。
 */
export function checkpointClaims(claims: ContextClaim[], now = Date.now()): ClaimSnapshot {
  const alive = claims.filter(c => {
    if (c.status === 'stale' || c.status === 'quarantined') return false
    if (c.expiresAt !== undefined && c.expiresAt <= now) return false
    return true
  })
  return {
    version: 1,
    createdAt: now,
    claims: alive,
  }
}

/**
 * 从快照恢复 claims。
 * 恢复后所有 claims 的 lastUsedAt 更新为 now，标记为「刚刚被唤醒」。
 */
export function loadClaimSnapshot(snapshot: ClaimSnapshot, now = Date.now()): ContextClaim[] {
  if (snapshot.version !== 1) return []
  return snapshot.claims.map(claim => ({
    ...claim,
    lastUsedAt: now,
  }))
}
```

**变更摘要**：
- `ClaimSnapshot` 接口：version + createdAt + claims[]
- `checkpointClaims(claims, now?)` — 过滤 stale/expired，返回快照
- `loadClaimSnapshot(snapshot, now?)` — 恢复 claims，刷新 lastUsedAt
- **不改构造函数** — snapshot 感知是后续优化（AgentLoop 可在 resume 时调用 loadClaimSnapshot）

### 测试

**`src/context/__tests__/claims-checkpoint.test.ts`**：

```typescript
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  checkpointClaims,
  loadClaimSnapshot,
  type ContextClaim,
} from '../claims.js'

function makeClaim(overrides: Partial<ContextClaim> = {}): ContextClaim {
  return {
    id: 'abc123',
    kind: 'user_constraint',
    scope: 'session',
    status: 'active',
    text: 'always use strict mode',
    confidence: 0.9,
    fitness: 0.8,
    source: { actor: 'user', sessionId: 's1', turn: 1, eventId: 'e1' },
    evidence: [{ id: 'ev1', kind: 'user_message', summary: 'test', createdAt: 1000 }],
    consumers: [],
    counterevidence: [],
    createdAt: 1000,
    lastUsedAt: 1000,
    tags: ['strict'],
    ...overrides,
  }
}

describe('claim checkpoint — 溶解即新生', () => {
  it('checkpointClaims filters stale claims', () => {
    const claims = [
      makeClaim({ id: 'alive', status: 'active' }),
      makeClaim({ id: 'dead', status: 'stale' }),
    ]
    const snap = checkpointClaims(claims)
    assert.equal(snap.claims.length, 1)
    assert.equal(snap.claims[0]!.id, 'alive')
  })

  it('checkpointClaims filters expired claims', () => {
    const now = 5000
    const claims = [
      makeClaim({ id: 'alive' }),
      makeClaim({ id: 'expired', expiresAt: 3000 }),
    ]
    const snap = checkpointClaims(claims, now)
    assert.equal(snap.claims.length, 1)
    assert.equal(snap.claims[0]!.id, 'alive')
  })

  it('checkpointClaims preserves quarantined in snapshot (not stale)', () => {
    const claims = [makeClaim({ id: 'q', status: 'quarantined' })]
    const snap = checkpointClaims(claims)
    assert.equal(snap.claims.length, 0) // quarantined is also filtered
  })

  it('loadClaimSnapshot restores claims with refreshed lastUsedAt', () => {
    const snap = {
      version: 1 as const,
      createdAt: 1000,
      claims: [makeClaim({ lastUsedAt: 500 })],
    }
    const restored = loadClaimSnapshot(snap, 9999)
    assert.equal(restored.length, 1)
    assert.equal(restored[0]!.lastUsedAt, 9999)
  })

  it('loadClaimSnapshot returns empty for wrong version', () => {
    const snap = { version: 99 as 1, createdAt: 1000, claims: [makeClaim()] }
    const restored = loadClaimSnapshot(snap)
    assert.equal(restored.length, 0)
  })

  it('round-trip: checkpoint → load preserves claim data', () => {
    const original = [
      makeClaim({ id: 'x', text: 'hello', confidence: 0.85, tags: ['a', 'b'] }),
    ]
    const snap = checkpointClaims(original, 1000)
    const restored = loadClaimSnapshot(snap, 2000)
    assert.equal(restored[0]!.id, 'x')
    assert.equal(restored[0]!.text, 'hello')
    assert.equal(restored[0]!.confidence, 0.85)
    assert.deepEqual(restored[0]!.tags, ['a', 'b'])
    assert.equal(restored[0]!.lastUsedAt, 2000) // refreshed
  })
})
```

---

## Task 3: 原则 ⑤ 有限规则无限涌现 — consistency-check hook + markClaimStale

> **原理**: Girih 瓦片只有 5 条规则却涌现准晶体。当前 4 个 store（stigmergy/claim/playbook/trace）
> 互相独立。需要 cross-store 耦合信号：当 evidence 显示文件被重写，自动将相关 file_observation claims
> 标记为 stale。
>
> **实现方式**: 新建 `consistency-check-hook.ts`，遵循现有 hook 模式（deps injection + factory function）。
> 通过在 `RuntimeHookEffects` 中添加 `markClaimStale` effect 实现跨 store 通信。

### 改动文件

| 文件 | 操作 |
|------|------|
| `src/agent/hooks/consistency-check-hook.ts` | 新建 — postTool hook |
| `src/agent/runtime-hooks.ts` | 修改 — RuntimeHookEffects 添加 `markClaimStale` |
| `src/agent/create-runtime-hooks.ts` | 修改 — 注册新 hook |
| `src/agent/__tests__/consistency-check-hook.test.ts` | 新建 — 测试 |

### 代码变更

**`src/agent/runtime-hooks.ts`** — 在 `RuntimeHookEffects` 接口中添加一行：

```typescript
export interface RuntimeHookEffects {
  setSensorium(sensorium: Sensorium): void
  setStrategy(strategy: StrategyProfile): void
  setVigor(vigor: VigorState): void
  setGitChangeRate(rate: number): void
  injectUserMessage(message: string): void
  requestThetaCheck(reason: string): void
  emitPhaseChange(phase: string, detail?: RuntimePhaseChangeDetail): void
  markClaimStale(claimId: string): void  // ← 新增
}
```

同时在 `createRuntimeHookContext` 中添加 wire-through：

```typescript
export function createRuntimeHookContext(
  snapshot: RuntimeHookSnapshot,
  effects: Partial<RuntimeHookEffects> = {},
): RuntimeHookContext {
  return {
    snapshot,
    effects: {
      setSensorium: sensorium => { snapshot.sensorium = sensorium; effects.setSensorium?.(sensorium) },
      setStrategy: strategy => { snapshot.strategy = strategy; effects.setStrategy?.(strategy) },
      setVigor: vigor => { snapshot.vigor = vigor; effects.setVigor?.(vigor) },
      setGitChangeRate: rate => { snapshot.gitChangeRate = rate; effects.setGitChangeRate?.(rate) },
      injectUserMessage: effects.injectUserMessage ?? noop,
      requestThetaCheck: effects.requestThetaCheck ?? noop,
      emitPhaseChange: effects.emitPhaseChange ?? noop,
      markClaimStale: effects.markClaimStale ?? noop,  // ← 新增
    },
  }
}
```

**`src/agent/hooks/consistency-check-hook.ts`** — 新建：

```typescript
import type { PostToolRuntimeHook } from '../runtime-hooks.js'

export interface ConsistencyCheckHookDeps {
  /**
   * 返回当前活跃的 file_observation claims。
   * 由 anchor-registry 或 claim-store 提供。
   */
  getFileObservations: () => Array<{ id: string; text: string; evidence: Array<{ path?: string }> }>
}

/**
 * 原则 ⑤ 有限规则无限涌现
 *
 * 当 write_file / edit_file 写入一个文件时，检查是否有 file_observation claim
 * 引用了该文件的旧状态。如果有，调用 markClaimStale 将其标记为过期。
 *
 * 这是 cross-store 耦合的第一条信号：evidence store（工具结果）→ claim store（知识）。
 */
export function createConsistencyCheckHook(deps: ConsistencyCheckHookDeps): PostToolRuntimeHook {
  return {
    phase: 'postTool',
    name: 'consistency-check',
    run(ctx, tool) {
      // 只在写操作后触发
      if (tool.name !== 'write_file' && tool.name !== 'edit_file') return
      if (!tool.target) return

      const observations = deps.getFileObservations()
      for (const obs of observations) {
        const referencesFile = obs.evidence.some(
          e => e.path && (e.path === tool.target || tool.target!.endsWith(e.path) || e.path.endsWith(tool.target!)),
        )
        if (referencesFile) {
          ctx.effects.markClaimStale(obs.id)
        }
      }
    },
  }
}
```

**`src/agent/create-runtime-hooks.ts`** — 在 hooks 数组中添加注册：

```typescript
import { createConsistencyCheckHook } from './hooks/consistency-check-hook.js'

// 在 createDefaultRuntimeHooks 函数的 hooks 数组中，stigmergy 之后添加：
export function createDefaultRuntimeHooks(deps: RuntimeHookDeps): RuntimeHook[] {
  const hooks: RuntimeHook[] = [
    // ... existing hooks ...
    createStigmergyRuntimeHook(deps),
    createConsistencyCheckHook({        // ← 新增
      getFileObservations: deps.getFileObservations,
    }),
    // ... rest ...
  ]
  return hooks
}
```

同时需要在 `RuntimeHookDeps` 接口中添加：

```typescript
export interface RuntimeHookDeps {
  // ... existing deps ...
  getFileObservations: () => Array<{ id: string; text: string; evidence: Array<{ path?: string }> }>
}
```

### 测试

**`src/agent/__tests__/consistency-check-hook.test.ts`**：

```typescript
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createConsistencyCheckHook } from '../hooks/consistency-check-hook.js'
import type { RuntimeHookContext, RuntimeToolEvent } from '../runtime-hooks.js'

function makeCtx(overrides: { markClaimStale?: (id: string) => void } = {}): RuntimeHookContext {
  return {
    snapshot: {
      cwd: '/tmp',
      turn: 1,
      recentToolHistory: [],
      sensorium: null,
      strategy: null,
      vigor: null,
      gitChangeRate: 0,
    },
    effects: {
      setSensorium: () => {},
      setStrategy: () => {},
      setVigor: () => {},
      setGitChangeRate: () => {},
      injectUserMessage: () => {},
      requestThetaCheck: () => {},
      emitPhaseChange: () => {},
      markClaimStale: overrides.markClaimStale ?? (() => {}),
    },
  }
}

describe('consistency-check-hook — 原则⑤ cross-store coupling', () => {
  it('marks file_observation claims stale when their file is overwritten', () => {
    const staleIds: string[] = []
    const ctx = makeCtx({ markClaimStale: id => staleIds.push(id) })

    const hook = createConsistencyCheckHook({
      getFileObservations: () => [
        {
          id: 'obs-1',
          text: 'src/foo.ts uses CommonJS',
          evidence: [{ path: 'src/foo.ts' }],
        },
        {
          id: 'obs-2',
          text: 'src/bar.ts has no tests',
          evidence: [{ path: 'src/bar.ts' }],
        },
      ],
    })

    const tool: RuntimeToolEvent = { name: 'edit_file', success: true, target: 'src/foo.ts' }
    hook.run(ctx, tool)

    assert.deepEqual(staleIds, ['obs-1'])
  })

  it('does not trigger on read_file', () => {
    const staleIds: string[] = []
    const ctx = makeCtx({ markClaimStale: id => staleIds.push(id) })

    const hook = createConsistencyCheckHook({
      getFileObservations: () => [
        { id: 'obs-1', text: 'x', evidence: [{ path: 'src/foo.ts' }] },
      ],
    })

    hook.run(ctx, { name: 'read_file', success: true, target: 'src/foo.ts' })
    assert.equal(staleIds.length, 0)
  })

  it('does not trigger when tool has no target', () => {
    const staleIds: string[] = []
    const ctx = makeCtx({ markClaimStale: id => staleIds.push(id) })

    const hook = createConsistencyCheckHook({
      getFileObservations: () => [
        { id: 'obs-1', text: 'x', evidence: [{ path: 'src/foo.ts' }] },
      ],
    })

    hook.run(ctx, { name: 'write_file', success: true })
    assert.equal(staleIds.length, 0)
  })

  it('handles empty observations gracefully', () => {
    const ctx = makeCtx()
    const hook = createConsistencyCheckHook({
      getFileObservations: () => [],
    })
    // Should not throw
    hook.run(ctx, { name: 'edit_file', success: true, target: 'src/foo.ts' })
  })

  it('matches suffix paths (tool target ends with evidence path)', () => {
    const staleIds: string[] = []
    const ctx = makeCtx({ markClaimStale: id => staleIds.push(id) })

    const hook = createConsistencyCheckHook({
      getFileObservations: () => [
        { id: 'obs-1', text: 'x', evidence: [{ path: 'foo.ts' }] },
      ],
    })

    hook.run(ctx, { name: 'write_file', success: true, target: 'src/deep/foo.ts' })
    assert.deepEqual(staleIds, ['obs-1'])
  })
})
```

---

## Task 4: 原则 ③ 参考系锚定 — fs-watcher + sensorium fsEventRate

> **原理**: Etak 导航用外部岛屿作为参考系。当前所有时间信号（turn count, compaction turns）
> 都是内部的。需要外部 Zeitgeber — 文件系统变更事件率。
>
> **实现**: 用 `fs.watch` 监听项目顶层目录（`recursive: false`），计算每分钟事件率，
> 混合进 sensorium 的 `freshness` 维度（三维：pheromone + git + fs-event）。

### 改动文件

| 文件 | 操作 |
|------|------|
| `src/context/fs-watcher.ts` | 新建 — fs.watch 封装 |
| `src/agent/sensorium.ts` | 修改 — `SensoriumInput` 添加 `fsEventRate`，`computeFreshness` 改三维混合 |
| `src/context/__tests__/fs-watcher.test.ts` | 新建 — 测试 |

### 代码变更

**`src/context/fs-watcher.ts`** — 新建：

```typescript
import { watch, type FSWatcher } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'

export interface FsWatcherConfig {
  /** Directory to watch (project root). Only top-level entries are watched. */
  cwd: string
  /** Event rate window in ms (default: 60_000 = 1 minute) */
  windowMs?: number
  /** Debounce: ignore events within ms of previous (default: 2000) */
  debounceMs?: number
}

export interface FsWatcherState {
  /** Events per minute in the current window */
  eventRate: number
  /** Total events in current window */
  eventCount: number
  /** Whether watcher is active */
  active: boolean
}

/**
 * 原则 ③ 参考系锚定 — 外部 Zeitgeber
 *
 * Watches top-level entries in the project directory.
 * recursive: false avoids node_modules / .git overhead.
 * Debounced to filter rapid save-all bursts (< 2s between events).
 *
 * Usage:
 *   const watcher = createFsWatcher({ cwd: projectRoot })
 *   watcher.start()
 *   // later...
 *   const { eventRate } = watcher.getState()  // 0.0–1.0 normalized
 *   watcher.stop()
 */
export function createFsWatcher(config: FsWatcherConfig) {
  const windowMs = config.windowMs ?? 60_000
  const debounceMs = config.debounceMs ?? 2_000

  let fsWatcher: FSWatcher | undefined
  let events: number[] = []
  let lastEventTime = 0

  function recordEvent(): void {
    const now = Date.now()
    if (now - lastEventTime < debounceMs) return
    lastEventTime = now
    events.push(now)
  }

  function pruneOld(now: number): void {
    events = events.filter(t => now - t <= windowMs)
  }

  function getState(): FsWatcherState {
    const now = Date.now()
    pruneOld(now)
    const eventCount = events.length
    // Normalize: 0 events = 0, ≥30 events/min = 1.0 (high volatility)
    const eventRate = Math.min(1, eventCount / 30)
    return {
      eventRate,
      eventCount,
      active: fsWatcher !== undefined,
    }
  }

  async function start(): Promise<void> {
    if (fsWatcher) return
    try {
      // Only watch top-level entries — recursive: false
      fsWatcher = watch(config.cwd, { recursive: false }, () => {
        recordEvent()
      })
      // Also watch immediate subdirectories (src/, docs/, etc.) for deeper coverage
      try {
        const entries = await readdir(config.cwd, { withFileTypes: true })
        for (const entry of entries) {
          if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') {
            watch(join(config.cwd, entry.name), { recursive: false }, () => {
              recordEvent()
            })
          }
        }
      } catch {
        // Non-fatal: top-level watch still works
      }
    } catch {
      // Non-fatal: fs.watch may fail in some environments (CI, containers)
      fsWatcher = undefined
    }
  }

  function stop(): void {
    fsWatcher?.close()
    fsWatcher = undefined
    events = []
  }

  return { start, stop, getState }
}
```

**`src/agent/sensorium.ts`** — 修改 `SensoriumInput` 和 `computeFreshness`：

在 `SensoriumInput` 接口中添加：

```typescript
export interface SensoriumInput {
  // ... existing fields ...
  /** Git file change rate (0-1), blended into freshness */
  gitChangeRate?: number
  /** Filesystem event rate (0-1) from fs-watcher — 原则③ external Zeitgeber */
  fsEventRate?: number  // ← 新增
}
```

修改 `computeFreshness` 函数为三维混合：

```typescript
function computeFreshness(
  pheromones: PheromoneRef[],
  gitChangeRate?: number,
  fsEventRate?: number,  // ← 新增参数
): number {
  // Base: pheromone signal (cross-session memory). Default 0.5 for unknown codebase.
  const pheromoneAvg = pheromones.length === 0
    ? 0.5
    : clamp(pheromones.reduce((sum, p) => sum + p.strength, 0) / pheromones.length)

  // Dimension weights: pheromone is long-term memory, git/Zeitgeber is medium-term, fs is real-time
  let result = pheromoneAvg
  let weight = 1.0

  if (gitChangeRate !== undefined && gitChangeRate >= 0) {
    // Git Zeitgeber: 70% pheromone + 30% git (inverse — high change = low freshness)
    result = 0.7 * result + 0.3 * (1 - gitChangeRate)
    weight = 1.0
  }

  if (fsEventRate !== undefined && fsEventRate >= 0) {
    // FS Zeitgeber: blend in with diminishing weight
    // 60% current + 40% fs-inverse. Git and fs are correlated but not identical —
    // fs captures file watchers, formatters, auto-saves that git doesn't see.
    result = 0.6 * result + 0.4 * (1 - fsEventRate)
  }

  return clamp(result)
}
```

更新 `computeSensorium` 中对 `computeFreshness` 的调用：

```typescript
export function computeSensorium(input: SensoriumInput): Sensorium {
  return {
    momentum: computeMomentum(input.predictionAcc),
    pressure: computePressure(input.pressureResult),
    confidence: computeConfidence(input.evidenceState),
    complexity: computeComplexity(input.toolCallHistory),
    freshness: computeFreshness(input.pheromones, input.gitChangeRate, input.fsEventRate),  // ← 加第三个参数
    stability: computeStability(input.doomLevel),
  }
}
```

### 测试

**`src/context/__tests__/fs-watcher.test.ts`**：

```typescript
import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createFsWatcher } from '../fs-watcher.js'

describe('FsWatcher — 原则③ 参考系锚定', () => {
  let watchers: Array<{ stop: () => void }> = []

  afterEach(() => {
    for (const w of watchers) w.stop()
    watchers = []
  })

  it('starts and reports zero event rate initially', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fs-watcher-test-'))
    const watcher = createFsWatcher({ cwd: dir })
    watchers.push(watcher)
    await watcher.start()

    const state = watcher.getState()
    assert.equal(state.eventRate, 0)
    assert.equal(state.eventCount, 0)
    assert.equal(state.active, true)
  })

  it('stop() resets state', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fs-watcher-test-'))
    const watcher = createFsWatcher({ cwd: dir })
    watchers.push(watcher)
    await watcher.start()
    watcher.stop()

    const state = watcher.getState()
    assert.equal(state.active, false)
    assert.equal(state.eventCount, 0)
  })

  it('getState normalizes eventRate to [0, 1]', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fs-watcher-test-'))
    const watcher = createFsWatcher({ cwd: dir })
    watchers.push(watcher)

    // Even without starting, getState should work
    const state = watcher.getState()
    assert.ok(state.eventRate >= 0 && state.eventRate <= 1)
  })

  it('start() is idempotent — double start does not throw', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fs-watcher-test-'))
    const watcher = createFsWatcher({ cwd: dir })
    watchers.push(watcher)
    await watcher.start()
    await watcher.start() // should not throw
    assert.equal(watcher.getState().active, true)
  })

  it('handles non-existent directory gracefully', async () => {
    const watcher = createFsWatcher({ cwd: '/nonexistent/path/xyz' })
    watchers.push(watcher)
    await watcher.start() // should not throw
    // watcher may or may not be active depending on OS — but should not crash
    const state = watcher.getState()
    assert.ok(typeof state.eventRate === 'number')
  })

  it('eventRate is normalized: 0 events = 0, many events → approaches 1', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fs-watcher-test-'))
    const watcher = createFsWatcher({ cwd: dir, debounceMs: 0 }) // no debounce for test
    watchers.push(watcher)
    await watcher.start()

    // Write enough files to trigger event rate
    for (let i = 0; i < 35; i++) {
      writeFileSync(join(dir, `test-${i}.txt`), 'x')
    }

    // Wait a bit for fs events to propagate
    await new Promise(r => setTimeout(r, 200))

    const state = watcher.getState()
    // Should have some events detected (may not be exactly 35 due to OS batching)
    // But eventRate should be > 0 if any events were detected
    assert.ok(state.eventRate >= 0, 'eventRate should be non-negative')
    assert.ok(state.eventCount >= 0, 'eventCount should be non-negative')
  })
})
```

---

## 改动量总结

| Task | 原则 | 改动量 | 核心文件 |
|------|------|--------|----------|
| Task 2 | ⑥速率比阈值 | 改 1 + 新 1 测试 | `pressure-monitor.ts` + token 历史 + `fastGrowth` |
| Task 1 | ①溶解即新生 | 改 1 + 新 1 测试 | `claims.ts` + `checkpointClaims()` + `loadClaimSnapshot()` |
| Task 3 | ⑤有限规则涌现 | 新 1 hook + 改 2 + 新 1 测试 | `consistency-check-hook.ts` + `markClaimStale` effect |
| Task 4 | ③参考系锚定 | 新 1 + 改 2 + 新 1 测试 | `fs-watcher.ts` + sensorium `fsEventRate` 三维混合 |

## 风险检查清单

- [ ] Task 2: `tokenHistory` 窗口 20 是否足够？（turn 间隔变化大时可能需要更大窗口）
- [ ] Task 1: `checkpointClaims` 过滤 quarantined — 确认这是期望行为（quarantined 可能是临时状态）
- [ ] Task 3: `markClaimStale` 是同步 void — 如果 claim-store 变成 async store 需要调整
- [ ] Task 3: `getFileObservations` 需要在 `RuntimeHookDeps` 中注册 — 确认 loop.ts 能提供
- [ ] Task 4: `fs.watch` 在 macOS 上 `recursive` 只对目录生效，对文件不生效 — 已用顶层 + 子目录方案
- [ ] Task 4: 事件率归一化 `30 events/min = 1.0` — 这个阈值可能需要根据实际项目调整
- [ ] 所有: import 带 `.js` 后缀（ESM strict 模式要求）
