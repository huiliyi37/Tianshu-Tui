# Immune System 补完实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 补完 Physarum + 免疫系统设计的"最后一公里"——修复 5/7 信号未发射、adaptive 反馈循环断开、跨 session 记忆丢失三大缺陷。

**架构：** (1) 把 trajectoryHealth + tokenUsage 接入 immuneHook；(2) 在 compaction-controller / sycophancy-trap / repair-hint 失败点发射 danger signal；(3) 把 immune memory 持久化到 SQLite；(4) 在 repair pipeline 完成后调用 recordRepairSuccess/Failure；(5) fastRepair 根据 memory.response 选择具体策略。

**技术栈：** TypeScript / better-sqlite3 / node:test / 现有 immune-hook + meridian-db + compaction-controller

**Token 节省路径（间接）：** 修复反馈回路后，doom loop 二次响应从 ~10 turns 降到 <3 turns，每次 doom loop 节省 30-50K tokens。免疫记忆持久化让跨 session 的相同问题不再重复探索。

---

## 背景：Scout 调研发现

| Scout | 发现 |
|-------|------|
| Scout A | 5/7 danger signal 类型从未被发射；recordRepairSuccess/Failure 从未被调用；trajectoryHealth + tokenUsage 字段定义但不传 |
| Scout B | meridian-db.ts 已有 physarum 持久化模式可直接复用，immune_memory 表加在 schema 第 63 行 |
| Scout C | 免疫系统当前 **token 成本为 0**——所有输出都是 harness 内部的，不进入模型 prompt。优化方向是修复反馈回路而非压缩输出 |

---

## 文件结构

| 文件 | 职责 | 状态 |
|------|------|------|
| `src/repo/meridian-db.ts` | 添加 immune_memory 表 + save/load 方法 | 修改 |
| `src/agent/immune-hook.ts` | fastRepair 根据 memory.response 选择策略；新增 injectSignal 方法 | 修改 |
| `src/agent/immune-adaptive.ts` | recordSuccess 存 response 类型而非纯文本 | 修改 |
| `src/agent/immune-types.ts` | ImmuneMemory.response 改为结构化（type + payload） | 修改 |
| `src/agent/loop.ts` | 在 5 个点发射信号 + 持久化 + adaptive 反馈调用 | 修改 |
| `src/agent/__tests__/immune-persistence.test.ts` | DB 往返测试 | 新建 |
| `src/agent/__tests__/immune-signal-wiring.test.ts` | 5 个信号源端到端测试 | 新建 |
| `src/agent/__tests__/immune-fast-repair.test.ts` | fastRepair 策略选择测试 | 新建 |

---

## 任务 1：ImmuneMemory.response 改为结构化

**文件：**
- 修改：`src/agent/immune-types.ts`

- [ ] **步骤 1：编写失败的测试**

测试文件：`src/agent/__tests__/immune-types-shape.test.ts`

```typescript
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { ImmuneMemory, ImmuneResponse } from '../immune-types.js'

describe('ImmuneMemory.response shape', () => {
  it('stores ImmuneResponse, not raw string', () => {
    const memory: ImmuneMemory = {
      id: 'abc',
      pattern: 'fp123',
      response: { type: 'quarantine', targetFile: 'src/foo.ts', duration: 20 },
      affinityScore: 0.5,
      hitCount: 1,
      lastHit: 100,
      createdAt: 50,
    }
    const r: ImmuneResponse = memory.response
    assert.equal(r.type, 'quarantine')
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npx tsx --test src/agent/__tests__/immune-types-shape.test.ts`
预期：FAIL — 类型错误，response 当前是 string

- [ ] **步骤 3：修改 immune-types.ts**

修改 `src/agent/immune-types.ts` 的 `ImmuneMemory` 接口，把 `response: string` 改为 `response: ImmuneResponse`：

```typescript
export interface ImmuneMemory {
  id: string
  pattern: string
  response: ImmuneResponse  // changed from string
  affinityScore: number
  hitCount: number
  lastHit: number
  createdAt: number
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`npx tsx --test src/agent/__tests__/immune-types-shape.test.ts`
预期：PASS

- [ ] **步骤 5：修复 immune-adaptive.ts 的类型错误**

`recordSuccess` 当前接受 `response: string`，改为接受 `response: ImmuneResponse`：

```typescript
recordSuccess(pattern: string, response: ImmuneResponse, turn: number): void {
  const id = this.patternId(pattern)
  const existing = this.memories.get(id)

  if (existing) {
    existing.hitCount++
    existing.lastHit = turn
    existing.affinityScore = Math.min(1, existing.affinityScore + AFFINITY_BOOST)
    existing.response = response
  } else {
    if (this.normalPatterns.has(pattern)) return
    const memory: ImmuneMemory = {
      id, pattern, response,
      affinityScore: 0.5,
      hitCount: 1,
      lastHit: turn,
      createdAt: turn,
    }
    this.memories.set(id, memory)
    if (this.memories.size > MAX_MEMORIES) this.evictLowest()
  }
}
```

记得在文件顶部把 import 改为：
```typescript
import type { ImmuneMemory, ImmuneResponse } from './immune-types.js'
```

- [ ] **步骤 6：修复 immune-hook.ts 的 recordRepairSuccess 签名**

```typescript
recordRepairSuccess(fingerprint: string, response: ImmuneResponse, turn: number): void {
  this.adaptive.recordSuccess(fingerprint, response, turn)
}
```

在文件顶部 import 中加入 `ImmuneResponse`。

- [ ] **步骤 7：修改 fastRepair 直接返回 memory.response**

```typescript
fastRepair(memory: ImmuneMemory): ImmuneResponse {
  // Memory now stores the structured response that previously succeeded
  return memory.response
}
```

- [ ] **步骤 8：修复测试中的旧用法**

运行 `npx tsc --noEmit` 找到所有受影响的测试文件，把 `recordSuccess(fp, 'some string', turn)` 改为 `recordSuccess(fp, { type: 'deposit_warning', targetFile: ... }, turn)`。

预期受影响：`src/agent/__tests__/immune-system.test.ts`、`src/agent/__tests__/immune-hook.test.ts`

- [ ] **步骤 9：运行全量测试 + typecheck**

运行：`npx tsc --noEmit && npx tsx --test 'src/agent/__tests__/immune-*.test.ts'`
预期：PASS

- [ ] **步骤 10：Commit**

```bash
git add src/agent/immune-types.ts src/agent/immune-adaptive.ts src/agent/immune-hook.ts src/agent/__tests__/immune-types-shape.test.ts src/agent/__tests__/immune-system.test.ts src/agent/__tests__/immune-hook.test.ts
git commit -m "refactor(immune): store structured ImmuneResponse in memory instead of string"
```

---

## 任务 2：immune_memory 持久化到 SQLite

**文件：**
- 修改：`src/repo/meridian-db.ts`
- 创建：`src/agent/__tests__/immune-persistence.test.ts`

- [ ] **步骤 1：编写失败的测试**

```typescript
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MeridianDb } from '../../repo/meridian-db.js'
import type { ImmuneMemory } from '../immune-types.js'

describe('MeridianDb immune memory persistence', () => {
  it('round-trips immune memories through DB', () => {
    const dir = mkdtempSync(join(tmpdir(), 'immune-db-'))
    try {
      const db = new MeridianDb(dir)
      const memory: ImmuneMemory = {
        id: 'abc123',
        pattern: 'tool:bash:fp_xyz',
        response: { type: 'quarantine', targetFile: 'src/foo.ts', duration: 20 },
        affinityScore: 0.7,
        hitCount: 3,
        lastHit: 120,
        createdAt: 50,
      }
      db.saveImmuneMemories([memory])
      db.close()

      const db2 = new MeridianDb(dir)
      const loaded = db2.loadImmuneMemories()
      assert.equal(loaded.length, 1)
      assert.equal(loaded[0]!.id, 'abc123')
      assert.equal(loaded[0]!.affinityScore, 0.7)
      assert.equal(loaded[0]!.response.type, 'quarantine')
      assert.equal(loaded[0]!.response.targetFile, 'src/foo.ts')
      db2.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('replaces all memories on save (not append)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'immune-db-'))
    try {
      const db = new MeridianDb(dir)
      const m1: ImmuneMemory = {
        id: 'a', pattern: 'p1',
        response: { type: 'deposit_warning', targetFile: 'f1' },
        affinityScore: 0.5, hitCount: 1, lastHit: 1, createdAt: 1,
      }
      const m2: ImmuneMemory = {
        id: 'b', pattern: 'p2',
        response: { type: 'boost_healthy', healthyEdges: [{ fileA: 'a', fileB: 'b' }] },
        affinityScore: 0.6, hitCount: 2, lastHit: 2, createdAt: 2,
      }
      db.saveImmuneMemories([m1, m2])
      db.saveImmuneMemories([m1]) // m2 should be gone
      const loaded = db.loadImmuneMemories()
      assert.equal(loaded.length, 1)
      assert.equal(loaded[0]!.id, 'a')
      db.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npx tsx --test src/agent/__tests__/immune-persistence.test.ts`
预期：FAIL — `db.saveImmuneMemories is not a function`

- [ ] **步骤 3：在 meridian-db.ts SCHEMA 末尾添加 immune_memory 表**

修改 `src/repo/meridian-db.ts`，在第 62 行（`physarum_edges` 表的 `PRIMARY KEY` 之后）和第 63 行的反引号之前插入：

```sql
CREATE TABLE IF NOT EXISTS immune_memory (
  id TEXT PRIMARY KEY,
  pattern TEXT NOT NULL,
  response_json TEXT NOT NULL,
  affinity_score REAL NOT NULL DEFAULT 0.5,
  hit_count INTEGER NOT NULL DEFAULT 0,
  last_hit INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_immune_pattern ON immune_memory(pattern);
```

注意：response 是结构化对象，序列化为 JSON 字符串存储在 `response_json` 列。

- [ ] **步骤 4：在文件顶部 import ImmuneMemory 类型**

```typescript
import type { ImmuneMemory } from '../agent/immune-types.js'
```

- [ ] **步骤 5：在 loadPhysarumEdges 之后（约 269 行）添加 save/load 方法**

```typescript
  // ─── Immune memory persistence ───────────────────────────────────────

  saveImmuneMemories(memories: ImmuneMemory[]): void {
    const tx = this.db.transaction(() => {
      this.db.prepare('DELETE FROM immune_memory').run()
      const stmt = this.db.prepare(
        'INSERT INTO immune_memory (id, pattern, response_json, affinity_score, hit_count, last_hit, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
      )
      for (const m of memories) {
        stmt.run(
          m.id,
          m.pattern,
          JSON.stringify(m.response),
          m.affinityScore,
          m.hitCount,
          m.lastHit,
          m.createdAt,
        )
      }
    })
    tx()
  }

  loadImmuneMemories(): ImmuneMemory[] {
    const rows = this.db.prepare('SELECT * FROM immune_memory').all() as Array<Record<string, unknown>>
    const result: ImmuneMemory[] = []
    for (const r of rows) {
      try {
        const response = JSON.parse(r.response_json as string)
        result.push({
          id: r.id as string,
          pattern: r.pattern as string,
          response,
          affinityScore: r.affinity_score as number,
          hitCount: r.hit_count as number,
          lastHit: r.last_hit as number,
          createdAt: r.created_at as number,
        })
      } catch {
        // Corrupt row — skip
      }
    }
    return result
  }
```

- [ ] **步骤 6：运行测试验证通过**

运行：`npx tsx --test src/agent/__tests__/immune-persistence.test.ts`
预期：PASS

- [ ] **步骤 7：在 loop.ts 第 295 行后添加加载调用**

修改 `src/agent/loop.ts` 第 295 行附近：

```typescript
this.immuneHook = new ImmuneHook({ physarum, stigmergy: this.stigmergyStore })
// Load persisted immune memories from previous sessions
if (meridianDb) {
  try {
    this.immuneHook.importMemories(meridianDb.loadImmuneMemories())
  } catch { /* non-critical */ }
}
```

- [ ] **步骤 8：在 loop.ts 第 765 行后添加保存调用**

```typescript
// Persist Physarum edge state to MeridianDb
try { this.immuneHook.getPhysarum().save() } catch { /* non-critical */ }

// Persist immune memories for cross-session secondary response
try {
  const db = this.config.meridianIndexer?.getDb()
  if (db) db.saveImmuneMemories(this.immuneHook.exportMemories())
} catch { /* non-critical */ }
```

- [ ] **步骤 9：运行 typecheck + 全量 immune 测试**

运行：`npx tsc --noEmit && npx tsx --test 'src/agent/__tests__/immune-*.test.ts' src/repo/__tests__/meridian-db.test.ts`
预期：PASS

- [ ] **步骤 10：Commit**

```bash
git add src/repo/meridian-db.ts src/agent/loop.ts src/agent/__tests__/immune-persistence.test.ts
git commit -m "feat(immune): persist immune memories to SQLite for cross-session secondary response"
```

---

## 任务 3：接入 trajectoryHealth + tokenUsage 到 immuneHook

**文件：**
- 修改：`src/agent/loop.ts`
- 创建：`src/agent/__tests__/immune-signal-wiring.test.ts`（部分）

- [ ] **步骤 1：在 loop.ts 找到 immuneHook.run 调用点（534 行）**

当前代码：
```typescript
const fp = this.traceStore.toolFingerprints[this.traceStore.toolFingerprints.length - 1] ?? name
this.immuneHook.run({
  toolName: name,
  fingerprint: fp,
  turn: this.session.getTurnCount(),
  doomLevel: this.getDoomLoopLevel(),
  targetFile: target,
})
```

- [ ] **步骤 2：找到 trajectoryHealth signal 的来源**

第 524 行已经计算了 `signal`，但只用于 model switch。把 signal 提升到外层作用域以供 immuneHook 使用：

```typescript
// P3-D Atropos: assess trajectory health → auto-escalate Flash→Pro on repeated failures
let trajectoryHealthSignal: 'healthy' | 'degrading' | 'escalate' = 'healthy'
if (this.config.onModelSwitch && this.config.getCurrentModel) {
  const currentModelId = this.config.getCurrentModel()
  const tier: 'flash' | 'pro' = currentModelId.includes('pro') ? 'pro' : 'flash'
  if (tier === 'flash') {
    const recentEvents = this.traceStore.events.slice(-10).map(e => ({
      status: (e.status === 'passed' ? 'passed' : 'failed') as 'passed' | 'failed',
      turn: e.turn,
    }))
    trajectoryHealthSignal = this.p3.assessHealth(recentEvents, this.session.getTurnCount(), tier)
    if (trajectoryHealthSignal === 'escalate') {
      const proModel = currentModelId.replace('flash', 'pro')
      try { this.config.onModelSwitch(proModel) } catch { /* non-fatal */ }
    }
  }
}
```

- [ ] **步骤 3：找到 tokenUsage 的来源**

在 loop.ts 顶部找 `getEstimatedTokens`：

```typescript
grep -n "getEstimatedTokens" src/agent/loop.ts
```

找到方法后，在 immuneHook.run 调用前获取当前估算 token 数。

- [ ] **步骤 4：修改 immuneHook.run 调用，传入 tokenUsage 和 trajectoryHealth**

```typescript
this.immuneHook.run({
  toolName: name,
  fingerprint: fp,
  turn: this.session.getTurnCount(),
  doomLevel: this.getDoomLoopLevel(),
  targetFile: target,
  tokenUsage: this.session.getEstimatedTokens(),
  trajectoryHealth: trajectoryHealthSignal,
})
```

- [ ] **步骤 5：编写端到端测试**

```typescript
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { ImmuneHook } from '../immune-hook.js'
import { PhysarumEngine } from '../../repo/physarum-engine.js'

describe('immune signal wiring', () => {
  it('emits prediction_error signal when trajectoryHealth is escalate', () => {
    const physarum = new PhysarumEngine(null as any)
    const hook = new ImmuneHook({ physarum })

    // Pre-fill APC with a doom-level pattern by running with patterns that match
    const result = hook.run({
      toolName: 'bash',
      fingerprint: 'fp1',
      turn: 1,
      doomLevel: 'warn',
      trajectoryHealth: 'escalate',
    })

    const errorSignals = result.signals.filter(s => s.kind === 'prediction_error')
    assert.equal(errorSignals.length, 1)
    assert.equal(errorSignals[0]!.severity, 0.9)
  })

  it('emits token_spike signal when tokenUsage doubles average', () => {
    const physarum = new PhysarumEngine(null as any)
    const hook = new ImmuneHook({ physarum })

    // Establish baseline
    for (let i = 0; i < 4; i++) {
      hook.run({
        toolName: 'bash', fingerprint: `fp${i}`, turn: i,
        doomLevel: 'none', tokenUsage: 1000,
      })
    }
    // Spike
    const result = hook.run({
      toolName: 'bash', fingerprint: 'fp_spike', turn: 5,
      doomLevel: 'none', tokenUsage: 5000,
    })

    const spikes = result.signals.filter(s => s.kind === 'token_spike')
    assert.equal(spikes.length, 1)
  })
})
```

- [ ] **步骤 6：运行测试验证通过**

运行：`npx tsx --test src/agent/__tests__/immune-signal-wiring.test.ts`
预期：PASS

- [ ] **步骤 7：Commit**

```bash
git add src/agent/loop.ts src/agent/__tests__/immune-signal-wiring.test.ts
git commit -m "feat(immune): wire trajectoryHealth + tokenUsage into immune hook context"
```

---

## 任务 4：发射 compaction_fail danger signal

**文件：**
- 修改：`src/agent/immune-hook.ts`（添加 injectSignal 方法）
- 修改：`src/agent/loop.ts`（compaction 失败时调用）

- [ ] **步骤 1：编写失败的测试**

追加到 `src/agent/__tests__/immune-signal-wiring.test.ts`：

```typescript
describe('immune injectSignal', () => {
  it('accepts external compaction_fail signal', () => {
    const physarum = new PhysarumEngine(null as any)
    const hook = new ImmuneHook({ physarum })

    hook.injectSignal({
      kind: 'compaction_fail',
      severity: 0.8,
      turn: 10,
      source: 'compaction-controller',
    })

    // Trigger evaluation by running with doom pattern
    const result = hook.run({
      toolName: 'bash', fingerprint: 'fp1', turn: 11,
      doomLevel: 'warn',
    })

    const compactSignals = result.signals.concat(
      hook.apc['signals'] as any
    ).filter((s: any) => s.kind === 'compaction_fail')
    assert.ok(compactSignals.length >= 1)
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npx tsx --test src/agent/__tests__/immune-signal-wiring.test.ts`
预期：FAIL — `hook.injectSignal is not a function`

- [ ] **步骤 3：在 immune-hook.ts 添加 injectSignal 方法**

在 `recordRepairFailure` 方法之后（约 154 行）添加：

```typescript
/** Inject external danger signal (e.g., from compaction failure, sycophancy trap) */
injectSignal(signal: DangerSignal): void {
  this.apc.collect(signal)
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`npx tsx --test src/agent/__tests__/immune-signal-wiring.test.ts`
预期：PASS

- [ ] **步骤 5：在 loop.ts compaction 失败处发射信号**

找到 compaction 调用处（约 871 行）：

```typescript
const compactResult = await this.compaction.maybeCompact({
  loopTurn: turn,
  failures: this.compactFailures,
})
this.compactFailures = compactResult.failures
if (compactResult.compacted) {
  this.lastCompactTurn = turn
  if (typeof globalThis.gc === 'function') globalThis.gc()
} else if (this.compactFailures.consecutiveFailures > 0) {
  // Emit danger signal for immune system
  this.immuneHook.injectSignal({
    kind: 'compaction_fail',
    severity: Math.min(0.5 + this.compactFailures.consecutiveFailures * 0.2, 1),
    turn,
    source: 'compaction-controller',
    context: `consecutive failures: ${this.compactFailures.consecutiveFailures}`,
  })
}
```

- [ ] **步骤 6：运行 typecheck + 测试**

运行：`npx tsc --noEmit && npx tsx --test 'src/agent/__tests__/immune-*.test.ts'`
预期：PASS

- [ ] **步骤 7：Commit**

```bash
git add src/agent/immune-hook.ts src/agent/loop.ts src/agent/__tests__/immune-signal-wiring.test.ts
git commit -m "feat(immune): emit compaction_fail signal when compaction fails repeatedly"
```

---

## 任务 5：发射 sycophancy_detected + repair_exhaustion signals

**文件：**
- 修改：`src/agent/loop.ts`
- 测试：追加到 `src/agent/__tests__/immune-signal-wiring.test.ts`

- [ ] **步骤 1：编写测试**

追加：

```typescript
describe('sycophancy + repair_exhaustion signals', () => {
  it('accepts sycophancy_detected signal', () => {
    const physarum = new PhysarumEngine(null as any)
    const hook = new ImmuneHook({ physarum })

    hook.injectSignal({
      kind: 'sycophancy_detected',
      severity: 0.7,
      turn: 5,
      source: 'sycophancy-trap',
    })

    const level = hook.getDangerLevel(5)
    assert.ok(level >= 0.7)
  })

  it('accepts repair_exhaustion signal', () => {
    const physarum = new PhysarumEngine(null as any)
    const hook = new ImmuneHook({ physarum })

    hook.injectSignal({
      kind: 'repair_exhaustion',
      severity: 0.9,
      turn: 5,
      source: 'repair-hint',
    })

    const level = hook.getDangerLevel(5)
    assert.ok(level >= 0.9)
  })
})
```

- [ ] **步骤 2：运行测试验证通过（injectSignal 已实现）**

运行：`npx tsx --test src/agent/__tests__/immune-signal-wiring.test.ts`
预期：PASS

- [ ] **步骤 3：在 loop.ts 找到 sycophancyTrap.getHint 调用（约 1040 行）**

当前代码：
```typescript
const sycophancyHint = isChatMode ? undefined : this.sycophancyTrap.getHint()
```

修改为：
```typescript
const sycophancyHint = isChatMode ? undefined : this.sycophancyTrap.getHint()
if (sycophancyHint && !isChatMode) {
  this.immuneHook.injectSignal({
    kind: 'sycophancy_detected',
    severity: 0.7,
    turn: this.session.getTurnCount(),
    source: 'sycophancy-trap',
  })
}
```

- [ ] **步骤 4：找到 repair-hint 耗尽点**

```bash
grep -n "EXHAUSTION_LIMIT\|repairHintTracker\|repair-hint" src/agent/loop.ts | head -10
```

预期看到 `this.repairHintTracker.getHint()` 调用。在该调用之后检查返回值是否为 null，如果之前 fingerprint 失败次数已达上限就发射信号：

```typescript
// Find: const hint = this.repairHintTracker.getHint(...)
// Add after:
if (hint === null && this.repairHintTracker.isExhausted?.(fp)) {
  this.immuneHook.injectSignal({
    kind: 'repair_exhaustion',
    severity: 0.9,
    turn: this.session.getTurnCount(),
    source: 'repair-hint-tracker',
    context: `pattern: ${fp}`,
  })
}
```

注意：如果 `RepairHintTracker` 没有 `isExhausted` 方法，需要先在 `src/agent/repair-hint.ts` 中添加：

```typescript
isExhausted(fingerprint: string): boolean {
  const entry = this.entries.get(fingerprint)
  return entry !== undefined && entry.failures >= EXHAUSTION_LIMIT
}
```

（先 grep 确认实际成员名后再写）

- [ ] **步骤 5：运行 typecheck + 测试**

运行：`npx tsc --noEmit && npx tsx --test 'src/agent/__tests__/immune-*.test.ts' src/agent/__tests__/repair-hint.test.ts`
预期：PASS

- [ ] **步骤 6：Commit**

```bash
git add src/agent/loop.ts src/agent/repair-hint.ts src/agent/__tests__/immune-signal-wiring.test.ts
git commit -m "feat(immune): emit sycophancy_detected and repair_exhaustion danger signals"
```

---

## 任务 6：fastRepair 策略丰富化

**文件：**
- 修改：`src/agent/immune-adaptive.ts`（确认 fastRepair 已在任务 1 改好）
- 修改：`src/agent/immune-hook.ts`（首次响应时存储有意义的 response）
- 创建：`src/agent/__tests__/immune-fast-repair.test.ts`

- [ ] **步骤 1：编写失败的测试**

```typescript
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { ImmuneHook } from '../immune-hook.js'
import { PhysarumEngine } from '../../repo/physarum-engine.js'

describe('fastRepair strategy selection', () => {
  it('returns quarantine response if memory was learned from quarantine success', async () => {
    const physarum = new PhysarumEngine(null as any)
    const hook = new ImmuneHook({ physarum })

    // Simulate: first encounter, repair succeeded with quarantine
    hook.recordRepairSuccess(
      'fp_doom_xyz',
      { type: 'quarantine', targetFile: 'src/foo.ts', duration: 20 },
      10,
    )

    // Second encounter: should fast-repair with same strategy
    // Need to trigger doom + danger signals to activate adaptive layer
    hook.injectSignal({
      kind: 'tool_repeat', severity: 0.8, turn: 20, source: 'test',
    })
    hook.injectSignal({
      kind: 'token_spike', severity: 0.8, turn: 20, source: 'test',
    })

    const result = hook.run({
      toolName: 'bash',
      fingerprint: 'fp_doom_xyz',
      turn: 20,
      doomLevel: 'warn',
      targetFile: 'src/foo.ts',
    })

    assert.ok(result.activated)
    assert.equal(result.response?.type, 'quarantine')
    assert.equal(result.response?.targetFile, 'src/foo.ts')
  })

  it('falls back to deposit_warning for unknown patterns', () => {
    const physarum = new PhysarumEngine(null as any)
    const hook = new ImmuneHook({ physarum })

    hook.injectSignal({ kind: 'tool_repeat', severity: 0.8, turn: 5, source: 'test' })
    hook.injectSignal({ kind: 'token_spike', severity: 0.8, turn: 5, source: 'test' })

    const result = hook.run({
      toolName: 'bash',
      fingerprint: 'fp_unseen',
      turn: 5,
      doomLevel: 'warn',
      targetFile: 'src/bar.ts',
    })

    assert.ok(result.activated)
    assert.equal(result.response?.type, 'deposit_warning')
  })
})
```

- [ ] **步骤 2：运行测试验证**

运行：`npx tsx --test src/agent/__tests__/immune-fast-repair.test.ts`
预期：第二个测试 PASS（已有逻辑），第一个 PASS（任务 1 中 fastRepair 已改为返回 memory.response）

如果第一个测试失败（很可能因为 evictLowest 或 negativeSelection 把记忆丢了），检查 `recordSuccess` 流程：fingerprint 必须**不**在 normalPatterns 中。在测试 setup 中，**不**调用 registerNormal。

如果 `recordRepairSuccess` 之前 fingerprint 已被 `registerNormal`（来自之前的 hook.run 调用），negative selection 会拒绝。修复方法：在 `recordSuccess` 中如果是 explicit 教学就允许覆盖，或在测试中不预先 run：

实际行为已经正确——测试中没有先 run，所以 normalPatterns 是空的。

- [ ] **步骤 3：在 loop.ts 中调用 recordRepairSuccess**

需要找到 repair pipeline 成功的点。先 grep：

```bash
grep -n "repair\|Repair" src/agent/loop.ts | grep -v "// " | head -20
```

理想情况下，theta-check 通过后调用 recordRepairSuccess。如果当前没有合适的钩子，先在 `runPostSession` 末尾把当前 turn 的 immune activated response（如果有）传回：

修改 `immune-hook.ts` 的 `run` 方法末尾：

```typescript
// Track activated responses so loop can call recordRepairSuccess later
if (response) {
  this.lastResponse = { fingerprint: ctx.fingerprint, response, turn: ctx.turn }
}
```

并添加：
```typescript
private lastResponse: { fingerprint: string; response: ImmuneResponse; turn: number } | null = null

/** Confirm last response succeeded — called when next turn doesn't repeat the pattern */
confirmLastResponseSuccess(currentFingerprint: string, turn: number): void {
  if (this.lastResponse && this.lastResponse.fingerprint !== currentFingerprint) {
    this.recordRepairSuccess(this.lastResponse.fingerprint, this.lastResponse.response, turn)
    this.lastResponse = null
  }
}
```

在 loop.ts immuneHook.run 之后：
```typescript
this.immuneHook.confirmLastResponseSuccess(fp, this.session.getTurnCount())
```

- [ ] **步骤 4：运行测试**

运行：`npx tsx --test 'src/agent/__tests__/immune-*.test.ts'`
预期：PASS

- [ ] **步骤 5：Commit**

```bash
git add src/agent/immune-hook.ts src/agent/loop.ts src/agent/__tests__/immune-fast-repair.test.ts
git commit -m "feat(immune): track and confirm repair responses for adaptive learning loop"
```

---

## 任务 7：Pheromone 信号完整化

**文件：**
- 修改：`src/agent/immune-hook.ts`
- 修改：`src/context/stigmergy.ts`（新增信号类型）
- 测试：`src/agent/__tests__/immune-pheromone.test.ts`

- [ ] **步骤 1：检查 stigmergy 当前支持的 signal 类型**

```bash
grep -n "type.*Signal\|signal:" src/context/stigmergy.ts | head -10
```

- [ ] **步骤 2：在 stigmergy.ts 的 PheromoneSignal 类型中添加新类型**

如果当前是 `'fragile' | 'dead-end' | ...`，扩展为：

```typescript
export type PheromoneSignal =
  | 'fragile'      // existing
  | 'dead-end'     // existing
  | 'hot'          // NEW: high-flow file (Physarum producer)
  | 'repaired'     // NEW: recently successfully repaired (immune producer)
  | 'toxic'        // NEW: doom-loop path (immune producer)
  // (preserve any other existing variants)
```

- [ ] **步骤 3：在 immune-hook.ts applyResponse 中按 response 类型 deposit 不同信号**

修改 `applyResponse` 方法：

```typescript
private applyResponse(response: ImmuneResponse): void {
  switch (response.type) {
    case 'quarantine':
      if (response.targetFile) {
        this.deps.physarum.freezeNode(response.targetFile, response.duration ?? 20)
        // NEW: deposit toxic pheromone
        if (this.deps.stigmergy) {
          this.deps.stigmergy.deposit({
            path: response.targetFile,
            signal: 'toxic',
            strength: 0.9,
            halfLifeMs: 1800_000, // 30 min
            context: 'immune-quarantine',
          })
        }
      }
      break
    case 'prune_toxic':
      if (response.toxicEdges) {
        this.deps.physarum.forcePrune(response.toxicEdges)
        // NEW: deposit toxic on each pruned file
        if (this.deps.stigmergy) {
          for (const edge of response.toxicEdges) {
            this.deps.stigmergy.deposit({
              path: edge.fileA,
              signal: 'toxic',
              strength: 0.7,
              halfLifeMs: 1800_000,
              context: 'immune-prune',
            })
          }
        }
      }
      break
    case 'boost_healthy':
      if (response.healthyEdges) {
        const files = response.healthyEdges.flatMap(e => [e.fileA, e.fileB])
        this.deps.physarum.boostEdges(files, 0.5)
        // NEW: deposit repaired pheromone on healthy paths
        if (this.deps.stigmergy) {
          for (const file of new Set(files)) {
            this.deps.stigmergy.deposit({
              path: file,
              signal: 'repaired',
              strength: 0.6,
              halfLifeMs: 3600_000,
              context: 'immune-boost',
            })
          }
        }
      }
      break
    case 'deposit_warning':
      if (this.deps.stigmergy && response.targetFile) {
        this.deps.stigmergy.deposit({
          path: response.targetFile,
          signal: 'fragile',
          strength: 0.8,
          halfLifeMs: 3600_000,
          context: 'immune-warning',
        })
      }
      break
  }
}
```

也要从 `run` 方法的步骤 8 中删除重复的 fragile deposit（避免双写）。

- [ ] **步骤 4：在 Physarum 高流量文件上 deposit hot pheromone**

在 `physarum-engine.ts` 的 `recordFlow` 中检测高流量边时通知 stigmergy。但更简单：在 immune-hook.ts run 方法开头检查是否高流量：

```typescript
// After recordFlow:
if (ctx.targetFile) {
  this.deps.physarum.recordFlow(ctx.toolName, ctx.targetFile, ctx.turn)
  this.adaptive.registerNormal(ctx.fingerprint)

  // Mark hot files (Physarum producer of pheromone)
  const edges = this.deps.physarum.getEdgesFor(ctx.targetFile)
  const maxWeight = edges.reduce((m, e) => Math.max(m, e.weight), 0)
  if (maxWeight > 5.0 && this.deps.stigmergy) {
    this.deps.stigmergy.deposit({
      path: ctx.targetFile,
      signal: 'hot',
      strength: Math.min(maxWeight / 10, 1),
      halfLifeMs: 600_000, // 10 min
      context: 'physarum-hot',
    })
  }
}
```

- [ ] **步骤 5：编写测试**

```typescript
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { ImmuneHook } from '../immune-hook.js'
import { PhysarumEngine } from '../../repo/physarum-engine.js'

class FakeStigmergy {
  deposits: any[] = []
  deposit(d: any) { this.deposits.push(d) }
}

describe('immune pheromone signals', () => {
  it('deposits toxic pheromone on quarantine response', () => {
    const physarum = new PhysarumEngine(null as any)
    const stig = new FakeStigmergy()
    const hook = new ImmuneHook({ physarum, stigmergy: stig as any })

    hook.recordRepairSuccess(
      'fp1',
      { type: 'quarantine', targetFile: 'src/foo.ts', duration: 20 },
      1,
    )

    // Trigger fast repair
    hook.injectSignal({ kind: 'tool_repeat', severity: 0.8, turn: 5, source: 't' })
    hook.injectSignal({ kind: 'token_spike', severity: 0.8, turn: 5, source: 't' })
    hook.run({
      toolName: 'bash', fingerprint: 'fp1', turn: 5,
      doomLevel: 'warn', targetFile: 'src/foo.ts',
    })

    const toxicDeposits = stig.deposits.filter(d => d.signal === 'toxic')
    assert.ok(toxicDeposits.length >= 1)
  })

  it('deposits repaired pheromone on boost_healthy', () => {
    const physarum = new PhysarumEngine(null as any)
    const stig = new FakeStigmergy()
    const hook = new ImmuneHook({ physarum, stigmergy: stig as any })

    hook.recordRepairSuccess(
      'fp2',
      { type: 'boost_healthy', healthyEdges: [{ fileA: 'a.ts', fileB: 'b.ts' }] },
      1,
    )

    hook.injectSignal({ kind: 'tool_repeat', severity: 0.8, turn: 5, source: 't' })
    hook.injectSignal({ kind: 'token_spike', severity: 0.8, turn: 5, source: 't' })
    hook.run({
      toolName: 'bash', fingerprint: 'fp2', turn: 5,
      doomLevel: 'warn', targetFile: 'a.ts',
    })

    const repairedDeposits = stig.deposits.filter(d => d.signal === 'repaired')
    assert.ok(repairedDeposits.length >= 1)
  })
})
```

- [ ] **步骤 6：运行测试**

运行：`npx tsx --test src/agent/__tests__/immune-pheromone.test.ts`
预期：PASS

- [ ] **步骤 7：Commit**

```bash
git add src/context/stigmergy.ts src/agent/immune-hook.ts src/agent/__tests__/immune-pheromone.test.ts
git commit -m "feat(immune): deposit hot/repaired/toxic pheromones to complete signal cycle"
```

---

## 任务 8：MistakeNotebook 同步

**文件：**
- 修改：`src/agent/immune-hook.ts`
- 修改：`src/agent/loop.ts`

- [ ] **步骤 1：在 ImmuneHookDeps 中添加 mistakeNotebook 引用**

```typescript
export interface ImmuneHookDeps {
  physarum: PhysarumEngine
  stigmergy?: StigmergyStore
  recordMistake?: (entry: { error: string; context: string; resolution: string; tags: string[] }) => void
}
```

- [ ] **步骤 2：在 recordRepairSuccess 时同步到 MistakeNotebook**

```typescript
recordRepairSuccess(fingerprint: string, response: ImmuneResponse, turn: number): void {
  this.adaptive.recordSuccess(fingerprint, response, turn)
  // Sync to MistakeNotebook for playbook-reflect
  if (this.deps.recordMistake) {
    this.deps.recordMistake({
      error: fingerprint,
      context: response.targetFile ?? 'unknown',
      resolution: `${response.type}: ${JSON.stringify(response).slice(0, 200)}`,
      tags: ['immune-adaptive'],
    })
  }
}
```

- [ ] **步骤 3：在 loop.ts 创建 immuneHook 时传入 recordMistake**

修改第 295 行：

```typescript
this.immuneHook = new ImmuneHook({
  physarum,
  stigmergy: this.stigmergyStore,
  recordMistake: (entry) => {
    try {
      this.p3.notebook.record({
        timestamp: new Date().toISOString(),
        ...entry,
      })
    } catch { /* non-critical */ }
  },
})
```

- [ ] **步骤 4：编写测试**

追加到 `src/agent/__tests__/immune-fast-repair.test.ts`：

```typescript
describe('MistakeNotebook sync', () => {
  it('calls recordMistake on recordRepairSuccess', () => {
    const physarum = new PhysarumEngine(null as any)
    const captured: any[] = []
    const hook = new ImmuneHook({
      physarum,
      recordMistake: (entry) => captured.push(entry),
    })

    hook.recordRepairSuccess(
      'fp_xyz',
      { type: 'quarantine', targetFile: 'src/foo.ts', duration: 10 },
      5,
    )

    assert.equal(captured.length, 1)
    assert.equal(captured[0].error, 'fp_xyz')
    assert.equal(captured[0].context, 'src/foo.ts')
    assert.ok(captured[0].tags.includes('immune-adaptive'))
  })
})
```

- [ ] **步骤 5：运行测试 + typecheck**

运行：`npx tsc --noEmit && npx tsx --test 'src/agent/__tests__/immune-*.test.ts'`
预期：PASS

- [ ] **步骤 6：Commit**

```bash
git add src/agent/immune-hook.ts src/agent/loop.ts src/agent/__tests__/immune-fast-repair.test.ts
git commit -m "feat(immune): sync repair memories to MistakeNotebook for playbook-reflect"
```

---

## 任务 9：选择性 prompt 注入（可选 token 优化）

> **注意：** 此任务**会增加 token 成本**，但收益是模型主动避坑。仅在高 danger level 时注入紧凑摘要。如果团队认为不值得就跳过此任务。

**文件：**
- 修改：`src/prompt/engine.ts` 或 `src/prompt/volatile.ts`
- 修改：`src/agent/loop.ts`

- [ ] **步骤 1：决定是否实施**

询问用户：是否希望模型在 doom loop 高 danger 时收到一个 ~50 token 的免疫警告？如果"否"，跳过此任务。

如果"是"继续。

- [ ] **步骤 2：在 immune-hook.ts 添加 getActiveWarning 方法**

```typescript
/** Get a compact warning string for prompt injection (only if danger is high) */
getActiveWarning(turn: number): string | null {
  const level = this.getDangerLevel(turn)
  if (level < 1.5) return null  // below activation threshold * 1.25

  const recentMemories = this.adaptive.export()
    .filter(m => turn - m.lastHit < 50 && m.affinityScore > 0.6)
    .slice(0, 3)

  if (recentMemories.length === 0) {
    return `[immune-alert] danger level ${level.toFixed(1)} — recent tool patterns suggest doom loop risk. Consider changing approach.`
  }

  const hints = recentMemories
    .map(m => `${m.response.type}@${m.response.targetFile ?? '?'}`)
    .join(', ')
  return `[immune-alert] danger level ${level.toFixed(1)} — past successful repairs: ${hints}`
}
```

- [ ] **步骤 3：在 loop.ts 把警告注入 promptEngine**

找到 `setSessionState` 或类似的入口：

```bash
grep -n "setSessionState\|promptEngine\\." src/agent/loop.ts | head -10
```

在合适的注入点（例如计算 cognitive projection 之后）：

```typescript
const immuneWarning = this.immuneHook.getActiveWarning(this.session.getTurnCount())
if (immuneWarning) {
  this.config.promptEngine.setImmuneWarning?.(immuneWarning)
}
```

需要在 promptEngine 中添加 setImmuneWarning + 在 volatile block 中渲染：

```typescript
// In src/prompt/engine.ts
private immuneWarning: string | null = null
setImmuneWarning(warning: string | null): void { this.immuneWarning = warning }

// In buildVolatileBlock or similar:
if (this.immuneWarning) {
  sections.push(`<immune-alert>${this.immuneWarning}</immune-alert>`)
}
```

- [ ] **步骤 4：测试 token 成本**

```typescript
// in src/prompt/__tests__/immune-warning.test.ts
it('only injects warning when danger > 1.5', () => {
  // construct PromptEngine, set warning, verify it's in output
  // construct PromptEngine, no warning set, verify section absent
})
it('warning is under 80 tokens', () => {
  // estimateTokens(warning) < 80
})
```

- [ ] **步骤 5：运行测试**

运行：`npx tsx --test src/prompt/__tests__/immune-warning.test.ts`
预期：PASS

- [ ] **步骤 6：Commit**

```bash
git add src/agent/immune-hook.ts src/prompt/engine.ts src/agent/loop.ts src/prompt/__tests__/immune-warning.test.ts
git commit -m "feat(immune): selectively inject compact warning into prompt at high danger levels"
```

---

## 任务 10：集成验证 + 性能基准

**文件：**
- 创建：`src/agent/__tests__/immune-integration.test.ts`

- [ ] **步骤 1：编写集成测试**

```typescript
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ImmuneHook } from '../immune-hook.js'
import { PhysarumEngine } from '../../repo/physarum-engine.js'
import { MeridianDb } from '../../repo/meridian-db.js'

describe('immune system integration', () => {
  it('full cycle: detect → repair → memorize → fast-repair → persist', () => {
    const dir = mkdtempSync(join(tmpdir(), 'immune-int-'))
    try {
      // Session 1: encounter doom loop, learn
      let db = new MeridianDb(dir)
      let physarum = new PhysarumEngine(db as any)
      let hook = new ImmuneHook({ physarum })

      // Simulate doom: same fingerprint repeats + token spike
      for (let i = 0; i < 3; i++) {
        hook.run({
          toolName: 'bash', fingerprint: 'doom_fp', turn: i,
          doomLevel: 'warn', targetFile: 'src/foo.ts',
          tokenUsage: 5000 * (i + 1),
        })
      }

      // Manually record success of quarantine strategy
      hook.recordRepairSuccess(
        'doom_fp',
        { type: 'quarantine', targetFile: 'src/foo.ts', duration: 20 },
        4,
      )

      // Persist
      db.saveImmuneMemories(hook.exportMemories())
      db.close()

      // Session 2: same doom pattern → should fast-repair
      db = new MeridianDb(dir)
      physarum = new PhysarumEngine(db as any)
      hook = new ImmuneHook({ physarum })
      hook.importMemories(db.loadImmuneMemories())

      hook.injectSignal({ kind: 'tool_repeat', severity: 0.8, turn: 1, source: 't' })
      hook.injectSignal({ kind: 'token_spike', severity: 0.8, turn: 1, source: 't' })
      const result = hook.run({
        toolName: 'bash', fingerprint: 'doom_fp', turn: 1,
        doomLevel: 'warn', targetFile: 'src/foo.ts',
      })

      assert.ok(result.activated)
      assert.equal(result.response?.type, 'quarantine', 'should fast-repair with learned strategy')
      db.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('immune hook overhead < 5ms per call', () => {
    const physarum = new PhysarumEngine(null as any)
    const hook = new ImmuneHook({ physarum })

    // Warm up
    for (let i = 0; i < 50; i++) {
      hook.run({
        toolName: 'bash', fingerprint: `fp${i}`, turn: i,
        doomLevel: 'none', targetFile: `src/f${i}.ts`,
      })
    }

    const start = performance.now()
    for (let i = 100; i < 200; i++) {
      hook.run({
        toolName: 'bash', fingerprint: `fp${i}`, turn: i,
        doomLevel: 'none', targetFile: `src/f${i}.ts`,
      })
    }
    const avgMs = (performance.now() - start) / 100
    assert.ok(avgMs < 5, `avg ${avgMs.toFixed(2)}ms exceeds 5ms budget`)
  })
})
```

- [ ] **步骤 2：运行集成测试**

运行：`npx tsx --test src/agent/__tests__/immune-integration.test.ts`
预期：PASS

- [ ] **步骤 3：运行全量回归**

运行：`npx tsc --noEmit && npm test`
预期：PASS（注意：现有 meridian + physarum + immune 测试都应通过）

- [ ] **步骤 4：Commit**

```bash
git add src/agent/__tests__/immune-integration.test.ts
git commit -m "test(immune): add full-cycle integration test + 5ms perf budget"
```

---

## 调研发现摘要（供参考）

### Scout A（信号接入断点）

| 信号 | 类型已定义 | 生产代码已发射 | 缺口位置 |
|------|----------|--------------|---------|
| compaction_fail | ✓ | ✗ | loop.ts:875 后 |
| sycophancy_detected | ✓ | ✗ | loop.ts:1040 |
| repair_exhaustion | ✓ | ✗ | loop.ts repair-hint 调用处 |
| token_spike | ✓ | ✗（tokenUsage 字段未传） | loop.ts:534 |
| prediction_error | ✓ | ✗（trajectoryHealth 字段未传） | loop.ts:534 |
| recordRepairSuccess/Failure | ✓ | ✗（从未调用） | loop.ts immune.run 之后 |

### Scout B（持久化模式）

- meridian-db.ts SCHEMA 第 63 行前插入 immune_memory 表
- 第 269 行后插入 saveImmuneMemories / loadImmuneMemories 方法
- loop.ts 第 295 行后加 importMemories 调用
- loop.ts 第 765 行后加 saveImmuneMemories 调用

### Scout C（token 成本）

- **当前免疫系统 token 成本 = 0**（所有输出都是 harness 内部）
- 修复反馈回路是间接节省 token 的最大机会（doom loop 二次响应从 ~10 turns 降到 <3 turns）
- 选择性注入紧凑警告（任务 9）是新增 token 但模型可主动避坑——需团队权衡

---

## 优先级总结

| 任务 | 优先级 | 工作量 | 收益 |
|------|--------|--------|------|
| 1. ImmuneMemory 结构化 | P0 前置 | 30 分钟 | 后续任务依赖 |
| 2. SQLite 持久化 | P1 | 1 小时 | 跨 session 二次响应 |
| 3. trajectoryHealth + tokenUsage 接入 | P1 | 30 分钟 | 5/7 信号其中 2 个 |
| 4. compaction_fail 发射 | P1 | 30 分钟 | 5/7 信号 |
| 5. sycophancy + repair_exhaustion | P1 | 1 小时 | 5/7 信号 |
| 6. fastRepair 策略丰富化 | P2 | 1.5 小时 | 真正的快速修复 |
| 7. Pheromone 完整化 | P2 | 1 小时 | Physarum↔Immune 闭环 |
| 8. MistakeNotebook 同步 | P3 | 30 分钟 | playbook 利用学习 |
| 9. 选择性 prompt 注入 | P4（可选）| 1.5 小时 | 模型主动避坑 |
| 10. 集成验证 | 必做 | 30 分钟 | 防止回归 |

总计 P0-P3：约 6 小时（1 个工作日）。P4 可选 1.5 小时。
