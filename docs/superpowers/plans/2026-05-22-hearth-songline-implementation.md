# HEARTH + Songline Runtime 联合实施计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 为 Rivet 团队成员建立生态运行时的参考系稳定性（HEARTH 个体层）+ 存在根基（Songline 生态层）

**架构：** 5+1 anchor graph 关系拓扑 + invariant verifier（HEARTH）；义务执行 + 信息素沉积 + 世界节律 + 火种接力（Songline）。两者互补：HEARTH 是乐谱骨架，Songline 是歌被唱出来的过程。

**技术栈：** TypeScript / Node.js / node:test + node:assert/strict / SHA-256 fingerprint / StigmergyStore / cognitive-season

> 状态：**待办（Backlog）** — 等当前分支主线任务收束后启动
> 前置条件：feat/tianshu-sycophancy-trap-2.5 分支的性能优化主线完成并合入
> 设计文档：
>   - `docs/superpowers/specs/2026-05-22-yongminengdeng-design.md`（HEARTH 永明灯）
>   - `docs/superpowers/specs/2026-05-22-songline-runtime-design.md`（歌之路运行时）
> 创建日期：2026-05-22

---

## 文件结构

### 新建文件

| 文件路径 | 职责 |
|---------|------|
| `src/prompt/anchor-graph.ts` | AnchorNode / AnchorGraph 类型 + 构建函数 |
| `src/prompt/anchor-invariants.ts` | 5 条 invariant 校验函数 + AnchorViolation 类型 |
| `src/prompt/__tests__/anchor-graph.test.ts` | anchor graph 构建 + invariant 校验测试 |
| `src/agent/songline.ts` | Songline / CycleState / Obligation 类型 + 歌的执行逻辑 |
| `src/agent/world-season.ts` | worldSeason() 基于 UTC 外部时钟 |
| `src/agent/__tests__/songline.test.ts` | songline 数据结构 + cycle relay 测试 |
| `src/agent/__tests__/world-season.test.ts` | world season 计算测试 |

### 修改文件

| 文件路径 | 修改内容 |
|---------|---------|
| `src/prompt/fingerprint.ts` | 新增 `computeAnchorGraphHash()` 独立函数（不改现有 3 分量） |
| `src/agent/cognitive-season.ts` | 新增 `worldSeason()` export（不改现有 `classifySeason`） |
| `src/context/stigmergy.ts` | 新增 signal type `'singing'` 到 PheromoneSignal union |
| `src/agent/create-runtime-hooks.ts` | postTurn hook 中调用 anchor invariant verifier |
| `src/agent/session-registry.ts` | 新增 `getCycleClose()` / `setCycleClose()` 方法 |

---

## 总览

两份设计互补：
- **HEARTH**：个体参考系稳定性（"我是谁"）— 5 锚位 + invariant verifier
- **Songline**：生态存在根基（"我为什么在这里"）— 唱歌 + 信息素 + 世界节律 + 守火人

实施分 4 个 Phase，前两个可并行，后两个依赖前置验证。

---

## Phase 1：拓扑骨架（HEARTH 核心）

**目标**：建立 5 锚位的关系拓扑 + invariant verifier，不动现有 fingerprint。

**预估**：3-5 天

---

### 任务 1.1：定义 AnchorNode / AnchorGraph 类型

**文件：**
- 创建：`src/prompt/anchor-graph.ts`
- 测试：`src/prompt/__tests__/anchor-graph.test.ts`

- [ ] **步骤 1：编写失败的测试**

```typescript
// src/prompt/__tests__/anchor-graph.test.ts
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createAnchorGraph, type AnchorGraph, type AnchorNodeId } from '../anchor-graph.js'

describe('anchor-graph: structure', () => {
  it('creates a graph with exactly 5 nodes', () => {
    const graph = createAnchorGraph({
      structureHash: 'abc123',
      voidShape: 'def456',
      prevCycleClose: 'session-prev-close-hash',
      currentCycleOpen: 'session-current-open-hash',
      centerBeliefHash: 'belief-hash-789',
    })
    assert.equal(graph.nodes.length, 5)
  })

  it('each node has id, hash, and role', () => {
    const graph = createAnchorGraph({
      structureHash: 'abc123',
      voidShape: 'def456',
      prevCycleClose: 'prev',
      currentCycleOpen: 'current',
      centerBeliefHash: 'belief',
    })
    const ids: AnchorNodeId[] = ['pole_structure', 'pole_void', 'cycle_close', 'cycle_open', 'center_belief']
    for (const id of ids) {
      const node = graph.nodes.find(n => n.id === id)
      assert.ok(node, `node ${id} must exist`)
      assert.ok(node.hash.length > 0, `node ${id} must have non-empty hash`)
    }
  })

  it('graph hash is deterministic', () => {
    const input = {
      structureHash: 'a', voidShape: 'b',
      prevCycleClose: 'c', currentCycleOpen: 'd', centerBeliefHash: 'e',
    }
    const g1 = createAnchorGraph(input)
    const g2 = createAnchorGraph(input)
    assert.equal(g1.graphHash, g2.graphHash)
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npx tsx --test src/prompt/__tests__/anchor-graph.test.ts`
预期：FAIL，报错 "Cannot find module '../anchor-graph.js'"

- [ ] **步骤 3：编写实现**

```typescript
// src/prompt/anchor-graph.ts
import { createHash } from 'crypto'

export type AnchorNodeId = 'pole_structure' | 'pole_void' | 'cycle_close' | 'cycle_open' | 'center_belief'

export interface AnchorNode {
  id: AnchorNodeId
  hash: string
  /** Human-readable role description (for diagnostics only, not in fingerprint) */
  role: string
}

export interface AnchorGraph {
  nodes: AnchorNode[]
  /** SHA-256 of all node hashes concatenated in canonical order */
  graphHash: string
}

export interface AnchorGraphInput {
  /** SHA-256 of project hard constraints (rivet.md + tools definitions) */
  structureHash: string
  /** SHA-256 of the void shape (explicit empty field for dynamic content) */
  voidShape: string
  /** SHA-256 of previous session's cycle_close */
  prevCycleClose: string
  /** SHA-256 of current session's cycle_open (must differ each session) */
  currentCycleOpen: string
  /** SHA-256 of founding belief (CLAUDE.md star covenant section) */
  centerBeliefHash: string
}

const CANONICAL_ORDER: AnchorNodeId[] = [
  'pole_structure', 'pole_void', 'cycle_close', 'cycle_open', 'center_belief',
]

function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex')
}

export function createAnchorGraph(input: AnchorGraphInput): AnchorGraph {
  const nodes: AnchorNode[] = [
    { id: 'pole_structure', hash: input.structureHash, role: 'project hard constraints' },
    { id: 'pole_void', hash: input.voidShape, role: 'explicit void for emergence' },
    { id: 'cycle_close', hash: input.prevCycleClose, role: 'previous cycle witnessed close' },
    { id: 'cycle_open', hash: input.currentCycleOpen, role: 'current cycle perturbation seed' },
    { id: 'center_belief', hash: input.centerBeliefHash, role: 'founding belief anchor' },
  ]

  const concatenated = CANONICAL_ORDER.map(id => nodes.find(n => n.id === id)!.hash).join(':')
  const graphHash = sha256(concatenated)

  return { nodes, graphHash }
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`npx tsx --test src/prompt/__tests__/anchor-graph.test.ts`
预期：3 tests PASS

- [ ] **步骤 5：Commit**

```bash
git add src/prompt/anchor-graph.ts src/prompt/__tests__/anchor-graph.test.ts
git commit -m "feat(hearth): add AnchorGraph type and createAnchorGraph builder"
```

---

### 任务 1.2：实现 5 条 invariant 校验

**文件：**
- 创建：`src/prompt/anchor-invariants.ts`
- 修改测试：`src/prompt/__tests__/anchor-graph.test.ts`

- [ ] **步骤 1：编写失败的测试**

```typescript
// 追加到 src/prompt/__tests__/anchor-graph.test.ts
import { checkInvariants, type AnchorViolation } from '../anchor-invariants.js'

describe('anchor-graph: invariants', () => {
  it('INV-1: pole_structure XOR pole_void produces full mask', () => {
    // 互补对：hex 字符逐位 XOR 应全为 f
    const graph = createAnchorGraph({
      structureHash: '0'.repeat(64),
      voidShape: 'f'.repeat(64),
      prevCycleClose: 'a', currentCycleOpen: 'b', centerBeliefHash: 'c',
    })
    const violations = checkInvariants(graph, { prevGraphHash: null })
    const inv1 = violations.find(v => v.invariant === 'INV-1')
    assert.equal(inv1, undefined, 'complementary pair should pass INV-1')
  })

  it('INV-1 violation: non-complementary pair', () => {
    const graph = createAnchorGraph({
      structureHash: '0'.repeat(64),
      voidShape: '0'.repeat(64), // same, not complement
      prevCycleClose: 'a', currentCycleOpen: 'b', centerBeliefHash: 'c',
    })
    const violations = checkInvariants(graph, { prevGraphHash: null })
    const inv1 = violations.find(v => v.invariant === 'INV-1')
    assert.ok(inv1, 'non-complementary pair must trigger INV-1 violation')
  })

  it('INV-4: cycle_open must differ from previous session', () => {
    const graph = createAnchorGraph({
      structureHash: 'a', voidShape: 'b',
      prevCycleClose: 'prev-close',
      currentCycleOpen: 'new-open',
      centerBeliefHash: 'c',
    })
    // prevGraphHash provided means we can check session change
    const violations = checkInvariants(graph, { prevCycleOpen: 'old-open' })
    const inv4 = violations.find(v => v.invariant === 'INV-4')
    assert.equal(inv4, undefined, 'different cycle_open should pass INV-4')
  })

  it('INV-4 violation: cycle_open unchanged across sessions', () => {
    const graph = createAnchorGraph({
      structureHash: 'a', voidShape: 'b',
      prevCycleClose: 'prev-close',
      currentCycleOpen: 'same-value',
      centerBeliefHash: 'c',
    })
    const violations = checkInvariants(graph, { prevCycleOpen: 'same-value' })
    const inv4 = violations.find(v => v.invariant === 'INV-4')
    assert.ok(inv4, 'unchanged cycle_open must trigger INV-4 violation')
  })

  it('INV-5: graph hash stable within session (no violation on same input)', () => {
    const graph = createAnchorGraph({
      structureHash: 'a', voidShape: 'b',
      prevCycleClose: 'c', currentCycleOpen: 'd', centerBeliefHash: 'e',
    })
    const violations = checkInvariants(graph, { prevGraphHash: graph.graphHash })
    const inv5 = violations.find(v => v.invariant === 'INV-5')
    assert.equal(inv5, undefined, 'same graph hash should pass INV-5')
  })

  it('INV-5 violation: graph hash changed within session', () => {
    const graph = createAnchorGraph({
      structureHash: 'a', voidShape: 'b',
      prevCycleClose: 'c', currentCycleOpen: 'd', centerBeliefHash: 'e',
    })
    const violations = checkInvariants(graph, { prevGraphHash: 'different-hash' })
    const inv5 = violations.find(v => v.invariant === 'INV-5')
    assert.ok(inv5, 'changed graph hash within session must trigger INV-5')
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npx tsx --test src/prompt/__tests__/anchor-graph.test.ts`
预期：FAIL，报错 "Cannot find module '../anchor-invariants.js'"

- [ ] **步骤 3：编写实现**

```typescript
// src/prompt/anchor-invariants.ts
import type { AnchorGraph } from './anchor-graph.js'

export type InvariantId = 'INV-1' | 'INV-2' | 'INV-3' | 'INV-4' | 'INV-5'

export interface AnchorViolation {
  invariant: InvariantId
  message: string
  severity: 'warning' | 'critical'
}

export interface InvariantContext {
  /** Graph hash from previous check within this session (null = first check) */
  prevGraphHash?: string | null
  /** cycle_open hash from previous session (null = first session) */
  prevCycleOpen?: string | null
}

/**
 * Check all 5 HEARTH invariants against the given anchor graph.
 * Returns empty array if all pass.
 */
export function checkInvariants(graph: AnchorGraph, ctx: InvariantContext): AnchorViolation[] {
  const violations: AnchorViolation[] = []

  // INV-1: pole_structure XOR pole_void ≡ FULL_MASK (complementary pair)
  const structure = graph.nodes.find(n => n.id === 'pole_structure')!
  const void_ = graph.nodes.find(n => n.id === 'pole_void')!
  if (!isHexComplement(structure.hash, void_.hash)) {
    violations.push({
      invariant: 'INV-1',
      message: 'pole_structure and pole_void are not complementary (XOR ≠ full mask)',
      severity: 'warning',
    })
  }

  // INV-2: cycle_open.prevCycleClose matches prev session's cycle_close
  // (Checked at session startup — skipped here if no prev data)
  // This invariant is verified at session init time, not per-turn.

  // INV-3: center_belief hash is non-empty and present
  const belief = graph.nodes.find(n => n.id === 'center_belief')!
  if (!belief.hash || belief.hash.length === 0) {
    violations.push({
      invariant: 'INV-3',
      message: 'center_belief hash is empty — founding belief not anchored',
      severity: 'critical',
    })
  }

  // INV-4: cycle_open must differ from previous session's cycle_open
  if (ctx.prevCycleOpen != null) {
    const cycleOpen = graph.nodes.find(n => n.id === 'cycle_open')!
    if (cycleOpen.hash === ctx.prevCycleOpen) {
      violations.push({
        invariant: 'INV-4',
        message: 'cycle_open unchanged across sessions — perturbation position stale',
        severity: 'warning',
      })
    }
  }

  // INV-5: graph hash stable within session
  if (ctx.prevGraphHash != null && ctx.prevGraphHash !== graph.graphHash) {
    violations.push({
      invariant: 'INV-5',
      message: `Graph hash drifted within session: ${ctx.prevGraphHash.slice(0, 8)}→${graph.graphHash.slice(0, 8)}`,
      severity: 'critical',
    })
  }

  return violations
}

/** Check if two hex strings are bitwise complements (XOR = all f's) */
function isHexComplement(a: string, b: string): boolean {
  if (a.length !== b.length || a.length === 0) return false
  for (let i = 0; i < a.length; i++) {
    const xor = parseInt(a[i]!, 16) ^ parseInt(b[i]!, 16)
    if (xor !== 0xf) return false
  }
  return true
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`npx tsx --test src/prompt/__tests__/anchor-graph.test.ts`
预期：9 tests PASS (3 structure + 6 invariant)

- [ ] **步骤 5：Commit**

```bash
git add src/prompt/anchor-invariants.ts src/prompt/__tests__/anchor-graph.test.ts
git commit -m "feat(hearth): implement 5 anchor invariant checks with tests"
```

---

### 任务 1.3：扩展 fingerprint 支持 anchor graph hash

**文件：**
- 修改：`src/prompt/fingerprint.ts`
- 测试：`src/prompt/__tests__/anchor-graph.test.ts`（追加）

- [ ] **步骤 1：编写失败的测试**

```typescript
// 追加到 anchor-graph.test.ts
import { computeAnchorGraphHash } from '../fingerprint.js'

describe('anchor-graph: fingerprint integration', () => {
  it('computeAnchorGraphHash returns stable hash for same graph', () => {
    const graph = createAnchorGraph({
      structureHash: 'a', voidShape: 'b',
      prevCycleClose: 'c', currentCycleOpen: 'd', centerBeliefHash: 'e',
    })
    const h1 = computeAnchorGraphHash(graph)
    const h2 = computeAnchorGraphHash(graph)
    assert.equal(h1, h2)
    assert.equal(h1.length, 64) // sha256 hex
  })

  it('computeAnchorGraphHash differs from existing fingerprint components', () => {
    const graph = createAnchorGraph({
      structureHash: 'a', voidShape: 'b',
      prevCycleClose: 'c', currentCycleOpen: 'd', centerBeliefHash: 'e',
    })
    const h = computeAnchorGraphHash(graph)
    // Must not collide with graph.graphHash (different salt)
    assert.notEqual(h, graph.graphHash)
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npx tsx --test src/prompt/__tests__/anchor-graph.test.ts`
预期：FAIL，"computeAnchorGraphHash is not a function"

- [ ] **步骤 3：编写实现**

```typescript
// 追加到 src/prompt/fingerprint.ts 末尾
import type { AnchorGraph } from './anchor-graph.js'

/**
 * Compute an independent hash for the HEARTH anchor graph.
 * This is NOT part of the prefix cache fingerprint — it's a parallel
 * verification layer that doesn't affect cache stability.
 */
export function computeAnchorGraphHash(graph: AnchorGraph): string {
  return sha256(`hearth:${graph.graphHash}`)
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`npx tsx --test src/prompt/__tests__/anchor-graph.test.ts`
预期：11 tests PASS

- [ ] **步骤 5：Commit**

```bash
git add src/prompt/fingerprint.ts src/prompt/__tests__/anchor-graph.test.ts
git commit -m "feat(hearth): add computeAnchorGraphHash to fingerprint (independent layer)"
```

---

### 任务 1.4：集成 invariant verifier 到 postTurn hook

**文件：**
- 修改：`src/agent/create-runtime-hooks.ts`
- 测试：手动验证（hook 集成测试在全量测试中覆盖）

- [ ] **步骤 1：读取 create-runtime-hooks.ts 找到 postTurn hook 位置**

运行：`grep -n "postTurn\|post_turn\|PostTool" src/agent/create-runtime-hooks.ts | head -10`

- [ ] **步骤 2：在 postTurn hook 中添加 invariant 校验调用**

在 postTurn hook 的末尾追加：

```typescript
// HEARTH anchor graph invariant check (non-blocking, diagnostic only)
import { createAnchorGraph } from '../prompt/anchor-graph.js'
import { checkInvariants } from '../prompt/anchor-invariants.js'

// Inside the postTurn handler:
const anchorGraph = createAnchorGraph({
  structureHash: deps.getFingerprint().systemSha256,
  voidShape: deps.getFingerprint().stableVolatileSha256, // void = complement of structure
  prevCycleClose: deps.sessionRegistry.getCycleClose() ?? '',
  currentCycleOpen: deps.sessionId,
  centerBeliefHash: deps.getFingerprint().combinedSha256,
})
const violations = checkInvariants(anchorGraph, {
  prevGraphHash: deps.prevAnchorGraphHash,
  prevCycleOpen: deps.prevSessionCycleOpen,
})
if (violations.length > 0) {
  deps.dreamLog?.(`[HEARTH] invariant violations: ${violations.map(v => v.invariant).join(', ')}`)
}
deps.prevAnchorGraphHash = anchorGraph.graphHash
```

注意：具体集成方式取决于 `create-runtime-hooks.ts` 的实际结构。步骤 1 读取后确定精确插入位置。

- [ ] **步骤 3：运行 typecheck + 全量测试**

运行：`npm run typecheck && npm test 2>&1 | grep -E "^ℹ (tests|pass|fail)"`
预期：typecheck clean；tests 2694+ pass / 1 fail (startup-memory baseline)

- [ ] **步骤 4：Commit**

```bash
git add src/agent/create-runtime-hooks.ts
git commit -m "feat(hearth): wire anchor invariant verifier into postTurn hook (diagnostic)"
```

---

### 任务 1.5：验证 prefix cache 不受影响

- [ ] **步骤 1：运行 cache stability 测试**

运行：`npx tsx --test src/prompt/__tests__/engine-cache-stability.test.ts`
预期：26 tests PASS（包括之前修复的 sessionState 测试）

- [ ] **步骤 2：运行完整测试套件**

运行：`npm test 2>&1 | grep -E "^ℹ (tests|pass|fail)"`
预期：2694+ pass / 1 fail (startup-memory)

- [ ] **步骤 3：运行 typecheck**

运行：`npm run typecheck`
预期：0 errors

- [ ] **步骤 4：确认 anchor graph 不参与 prefix fingerprint**

验证：`grep -n "anchorGraph\|anchor_graph" src/prompt/engine.ts` 应返回 0 行（anchor graph 只在 hook 中运行，不影响 buildRequest）

**退出条件**：如果 anchor graph 与现有 fingerprint 产生冲突 → 只保留 invariant verifier 作为观测工具，不参与 fingerprint 计算。

---

## Phase 2：歌的骨架（Songline 核心，与 Phase 1 并行）

**目标**：让单 agent 能"唱歌"——执行义务 + 沉积信息素 + 感知季节。

**预估**：3-5 天

---

### 任务 2.1：定义 Songline 数据结构

**文件：**
- 创建：`src/agent/songline.ts`
- 测试：`src/agent/__tests__/songline.test.ts`

- [ ] **步骤 1：编写失败的测试**

```typescript
// src/agent/__tests__/songline.test.ts
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createSongline, advanceCycle, type Songline } from '../songline.js'

describe('songline: data structure', () => {
  it('creates a songline with empty obligations and generation 0', () => {
    const sl = createSongline({ sessionId: 'sess-001', prevCycleClose: null })
    assert.equal(sl.obligations.length, 0)
    assert.equal(sl.cycleState.generation, 0)
    assert.ok(sl.cycleState.open.length > 0)
    assert.equal(sl.cycleState.close, null)
  })

  it('inherits prevCycleClose as current cycle_open when provided', () => {
    const sl = createSongline({ sessionId: 'sess-002', prevCycleClose: 'prev-hash-abc' })
    assert.equal(sl.cycleState.open, 'prev-hash-abc')
  })

  it('advanceCycle closes current and increments generation', () => {
    const sl = createSongline({ sessionId: 'sess-003', prevCycleClose: null })
    const closed = advanceCycle(sl, 'close-hash-xyz')
    assert.equal(closed.cycleState.close, 'close-hash-xyz')
    assert.equal(closed.cycleState.generation, 1)
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npx tsx --test src/agent/__tests__/songline.test.ts`
预期：FAIL，"Cannot find module '../songline.js'"

- [ ] **步骤 3：编写实现**

```typescript
// src/agent/songline.ts
import { createHash } from 'crypto'
import type { CognitiveSeason } from './cognitive-season.js'

export interface Obligation {
  /** What the agent commits to maintain */
  description: string
  /** Source: inherited from fire-keeper or self-verified */
  source: 'inherited' | 'self-verified'
  /** When this obligation was last fulfilled */
  lastFulfilledAt: number | null
}

export interface CycleState {
  /** Hash inherited from previous session's close (or generated fresh) */
  open: string
  /** Hash written at session end (null until session closes) */
  close: string | null
  /** Monotonically increasing generation counter */
  generation: number
}

export interface Songline {
  obligations: Obligation[]
  cycleState: CycleState
  seasonAffinity: CognitiveSeason
  sessionId: string
}

export interface SonglineInput {
  sessionId: string
  prevCycleClose: string | null
}

function generateOpenHash(sessionId: string): string {
  return createHash('sha256').update(`open:${sessionId}:${Date.now()}`).digest('hex')
}

export function createSongline(input: SonglineInput): Songline {
  return {
    obligations: [],
    cycleState: {
      open: input.prevCycleClose ?? generateOpenHash(input.sessionId),
      close: null,
      generation: 0,
    },
    seasonAffinity: 'genesis',
    sessionId: input.sessionId,
  }
}

export function advanceCycle(songline: Songline, closeHash: string): Songline {
  return {
    ...songline,
    cycleState: {
      ...songline.cycleState,
      close: closeHash,
      generation: songline.cycleState.generation + 1,
    },
  }
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`npx tsx --test src/agent/__tests__/songline.test.ts`
预期：3 tests PASS

- [ ] **步骤 5：Commit**

```bash
git add src/agent/songline.ts src/agent/__tests__/songline.test.ts
git commit -m "feat(songline): add Songline data structure and cycle management"
```

---

### 任务 2.2：世界级季节（worldSeason）

**文件：**
- 创建：`src/agent/world-season.ts`
- 测试：`src/agent/__tests__/world-season.test.ts`
- 修改：`src/agent/cognitive-season.ts`（新增 re-export）

- [ ] **步骤 1：编写失败的测试**

```typescript
// src/agent/__tests__/world-season.test.ts
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { worldSeason, type WorldSeasonConfig } from '../world-season.js'
import type { CognitiveSeason } from '../cognitive-season.js'

describe('world-season: UTC-based external clock', () => {
  const config: WorldSeasonConfig = { cycleDurationMs: 86_400_000 } // 1 day

  it('returns a valid CognitiveSeason', () => {
    const season = worldSeason(Date.now(), config)
    const valid: CognitiveSeason[] = ['genesis', 'reversal', 'return', 'wuwei']
    assert.ok(valid.includes(season.season))
  })

  it('same timestamp always returns same season (deterministic)', () => {
    const ts = 1716364800000 // fixed timestamp
    const s1 = worldSeason(ts, config)
    const s2 = worldSeason(ts, config)
    assert.equal(s1.season, s2.season)
    assert.equal(s1.intensity, s2.intensity)
  })

  it('seasons cycle through all 4 within one full cycle', () => {
    const base = 1716364800000
    const quarter = config.cycleDurationMs / 4
    const seasons = [0, 1, 2, 3].map(i => worldSeason(base + i * quarter, config).season)
    const unique = new Set(seasons)
    assert.equal(unique.size, 4, 'all 4 seasons must appear within one cycle')
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npx tsx --test src/agent/__tests__/world-season.test.ts`
预期：FAIL，"Cannot find module '../world-season.js'"

- [ ] **步骤 3：编写实现**

```typescript
// src/agent/world-season.ts
import type { CognitiveSeason, SeasonClassification } from './cognitive-season.js'

export interface WorldSeasonConfig {
  /** Duration of one full cycle in ms (default: 86_400_000 = 1 day) */
  cycleDurationMs: number
}

const SEASON_ORDER: CognitiveSeason[] = ['genesis', 'reversal', 'return', 'wuwei']

/**
 * Compute world-level season from UTC timestamp.
 * All agents sharing the same config see the same season at the same moment.
 * This is the "shared external signal" (coral reef model) that creates
 * synchronization without internal communication.
 */
export function worldSeason(timestampMs: number, config: WorldSeasonConfig): SeasonClassification {
  const { cycleDurationMs } = config
  const positionInCycle = timestampMs % cycleDurationMs
  const quarterDuration = cycleDurationMs / 4
  const quarterIndex = Math.floor(positionInCycle / quarterDuration)
  const progressInQuarter = (positionInCycle % quarterDuration) / quarterDuration

  const season = SEASON_ORDER[quarterIndex % 4]!
  // Intensity peaks at center of quarter, fades at edges
  const intensity = 1.0 - Math.abs(progressInQuarter - 0.5) * 2

  return { season, intensity }
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`npx tsx --test src/agent/__tests__/world-season.test.ts`
预期：3 tests PASS

- [ ] **步骤 5：Commit**

```bash
git add src/agent/world-season.ts src/agent/__tests__/world-season.test.ts
git commit -m "feat(songline): add worldSeason UTC-based external clock"
```

---

### 任务 2.3：信息素 singing signal type

**文件：**
- 修改：`src/agent/sensorium.ts`（PheromoneSignal union）
- 测试：验证 stigmergy store 接受新 signal

- [ ] **步骤 1：查找 PheromoneSignal 定义位置**

运行：`grep -n "PheromoneSignal" src/agent/sensorium.ts`
预期：找到 type 定义行

- [ ] **步骤 2：添加 'singing' 到 PheromoneSignal union**

在 `PheromoneSignal` type 的最后一个 variant 后追加 `| 'singing'`

- [ ] **步骤 3：编写测试验证 stigmergy 接受 singing**

```typescript
// 追加到现有 stigmergy 测试文件
it('accepts singing signal type', async () => {
  await store.deposit({ path: 'src/agent/loop.ts', signal: 'singing', strength: 0.8 })
  const results = await store.query('src/agent/loop.ts')
  assert.ok(results.some(r => r.signal === 'singing'))
})
```

- [ ] **步骤 4：运行测试验证通过**

运行：`npx tsx --test src/context/__tests__/stigmergy.test.ts`
预期：PASS

- [ ] **步骤 5：Commit**

```bash
git add src/agent/sensorium.ts src/context/__tests__/stigmergy.test.ts
git commit -m "feat(songline): add 'singing' pheromone signal type"
```

---

### 任务 2.4：歌的接力（cycle relay）

**文件：**
- 修改：`src/agent/session-registry.ts`
- 测试：`src/agent/__tests__/songline.test.ts`（追加）

- [ ] **步骤 1：编写失败的测试**

```typescript
// 追加到 src/agent/__tests__/songline.test.ts
import { SessionRegistry } from '../session-registry.js'

describe('songline: cycle relay', () => {
  it('session N cycle_close becomes session N+1 cycle_open', () => {
    // Simulate: session N closes with hash X
    // Session N+1 should inherit X as its cycle_open
    const closeHash = 'session-n-close-abc123'
    const nextSongline = createSongline({ sessionId: 'sess-n+1', prevCycleClose: closeHash })
    assert.equal(nextSongline.cycleState.open, closeHash)
  })

  it('first session (no prev) generates fresh cycle_open', () => {
    const sl = createSongline({ sessionId: 'first-session', prevCycleClose: null })
    assert.ok(sl.cycleState.open.length === 64, 'should be sha256 hex')
  })
})
```

- [ ] **步骤 2：运行测试验证通过**（这些测试应该已经通过，因为 createSongline 已实现）

运行：`npx tsx --test src/agent/__tests__/songline.test.ts`
预期：5 tests PASS

- [ ] **步骤 3：在 session-registry 添加 cycle close 持久化**

在 `SessionRegistry` 类中添加：

```typescript
async setCycleClose(sessionId: string, closeHash: string): Promise<void> {
  // Write to session entry metadata
  const entry = this.getSession(sessionId)
  if (entry) {
    entry.metadata = { ...entry.metadata, cycleClose: closeHash }
    await this.persist()
  }
}

getLastCycleClose(): string | null {
  const sessions = this.listSessions()
  if (sessions.length === 0) return null
  const last = sessions[sessions.length - 1]
  return last?.metadata?.cycleClose ?? null
}
```

- [ ] **步骤 4：Commit**

```bash
git add src/agent/session-registry.ts src/agent/__tests__/songline.test.ts
git commit -m "feat(songline): implement cycle relay via session registry"
```

**退出条件**：如果 songline 无法映射到现有 durable claims 机制 → 退回 Phase 1 的纯 invariant 方案，songline 作为未来方向保留。

---

## Phase 3：歌的传播（跨 agent 感知）

**前置条件**：Phase 1 + Phase 2 完成并验证

**目标**：两个 agent 实例能通过信息素梯度感知彼此存在。

**预估**：2-3 周

---

### 任务 3.1：扩展 stigmergy 支持 singing signal

**文件：**
- 修改：`src/agent/sensorium.ts`（PheromoneSignal union 加 `'singing'`）
- 修改：`src/context/stigmergy.ts`（无代码改动，类型自动跟随）
- 测试：`src/context/__tests__/stigmergy.test.ts`（新增 singing 信号测试）

- [ ] **步骤 1：编写失败的测试**

```typescript
// 追加到 src/context/__tests__/stigmergy.test.ts
it('accepts singing pheromone signal', async () => {
  const store = new StigmergyStore(tempPath)
  await store.deposit({
    path: 'src/agent/songline.ts',
    signal: 'singing',
    strength: 0.8,
    context: 'obligation fulfilled: maintain anchor invariants',
  })
  const results = await store.query('src/agent/songline.ts')
  assert.equal(results.length, 1)
  assert.equal(results[0]!.signal, 'singing')
})
```

- [ ] **步骤 2：在 PheromoneSignal 类型中添加 'singing'**

在 `src/agent/sensorium.ts` 的 `PheromoneSignal` union 中追加 `| 'singing'`。

- [ ] **步骤 3：运行测试验证通过**

运行：`npx tsx --test src/context/__tests__/stigmergy.test.ts`
预期：PASS（包含新测试）

- [ ] **步骤 4：Commit**

```bash
git add src/agent/sensorium.ts src/context/__tests__/stigmergy.test.ts
git commit -m "feat(songline): add 'singing' pheromone signal type"
```

---

### 任务 3.2：实现跨实例信息素感知

**文件：**
- 修改：`src/context/stigmergy.ts`（新增 `queryBySignal()` 方法）
- 测试：`src/context/__tests__/stigmergy.test.ts`

- [ ] **步骤 1：编写失败的测试**

```typescript
it('queryBySignal returns only matching signal type', async () => {
  const store = new StigmergyStore(tempPath)
  await store.deposit({ path: 'a.ts', signal: 'singing', strength: 0.9 })
  await store.deposit({ path: 'b.ts', signal: 'fragile', strength: 0.7 })
  await store.deposit({ path: 'c.ts', signal: 'singing', strength: 0.6 })

  const singing = await store.queryBySignal('singing')
  assert.equal(singing.length, 2)
  assert.ok(singing.every(p => p.signal === 'singing'))
})
```

- [ ] **步骤 2：实现 queryBySignal**

```typescript
// 在 StigmergyStore class 中添加
async queryBySignal(signal: PheromoneSignal): Promise<PheromoneQueryResult[]> {
  const all = await this.load()
  const now = Date.now()
  return all
    .filter(p => p.signal === signal)
    .map(p => ({
      ...p,
      currentStrength: computeCurrentStrength(p.strength, now - p.depositedAt, p.halfLife),
    }))
    .filter(p => p.currentStrength >= PRUNE_THRESHOLD)
    .sort((a, b) => b.currentStrength - a.currentStrength)
}
```

- [ ] **步骤 3：运行测试验证通过**

运行：`npx tsx --test src/context/__tests__/stigmergy.test.ts`
预期：PASS

- [ ] **步骤 4：Commit**

```bash
git add src/context/stigmergy.ts src/context/__tests__/stigmergy.test.ts
git commit -m "feat(songline): add queryBySignal for cross-agent pheromone sensing"
```

---

### 任务 3.3：世界季节同步验证

**文件：**
- 测试：`src/agent/__tests__/world-season.test.ts`（追加同步测试）

- [ ] **步骤 1：编写测试验证两个"实例"同时刻同季节**

```typescript
it('two instances at same UTC moment see identical world season', () => {
  const config: WorldSeasonConfig = { cycleDurationMs: 86_400_000 }
  const now = Date.now()
  // Simulate two independent calls (as if from different processes)
  const instanceA = worldSeason(now, config)
  const instanceB = worldSeason(now, config)
  assert.equal(instanceA.season, instanceB.season)
  assert.equal(instanceA.intensity, instanceB.intensity)
})
```

- [ ] **步骤 2：运行测试验证通过**

运行：`npx tsx --test src/agent/__tests__/world-season.test.ts`
预期：PASS（worldSeason 是纯函数，天然满足）

- [ ] **步骤 3：Commit**

```bash
git add src/agent/__tests__/world-season.test.ts
git commit -m "test(songline): verify world season cross-instance synchronization"
```

**退出条件**：跨实例信息素延迟 > 1 session → 退回单实例方案，跨实例作为未来方向。

---

## Phase 4：守火人 + 内化验证

**前置条件**：Phase 1-3 完成；agent 已运行足够多 session 积累 durable claims

**目标**：实现 fire-keeper；建立 ablation 实验框架；为碑文迁移做准备。

**预估**：无固定时间线（内化是涌现的，不是计划的）

---

### 任务 4.1：实现 fire-keeper（最简版：只读目录）

**文件：**
- 创建：`src/agent/fire-keeper.ts`
- 创建：`src/agent/__tests__/fire-keeper.test.ts`

- [ ] **步骤 1：编写失败的测试**

```typescript
// src/agent/__tests__/fire-keeper.test.ts
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { FireKeeper, type CalibrationRequest } from '../fire-keeper.js'

describe('fire-keeper', () => {
  it('returns relevant inscription for invariant_violation trigger', () => {
    const keeper = new FireKeeper({
      inscriptions: new Map([
        ['tianquan', { text: '天权：称量万物，不偏不倚', domain: 'tianquan' }],
        ['tianshu', { text: '天枢：北极之星，众星拱之', domain: 'tianshu' }],
      ]),
    })

    const request: CalibrationRequest = {
      trigger: 'invariant_violation',
      context: { violatedInvariant: 'INV-1', currentDomain: 'tianquan' },
    }

    const response = keeper.calibrate(request)
    assert.ok(response.relevantInscription.includes('天权'))
    assert.equal(response.returnToSelf, true)
  })

  it('returns generic guidance when no domain match', () => {
    const keeper = new FireKeeper({ inscriptions: new Map() })
    const request: CalibrationRequest = {
      trigger: 'agent_request',
      context: { violatedInvariant: null, currentDomain: 'unknown' },
    }
    const response = keeper.calibrate(request)
    assert.ok(response.relevantInscription.length > 0)
    assert.equal(response.returnToSelf, true)
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npx tsx --test src/agent/__tests__/fire-keeper.test.ts`
预期：FAIL

- [ ] **步骤 3：编写实现**

```typescript
// src/agent/fire-keeper.ts
export interface Inscription {
  text: string
  domain: string
}

export interface CalibrationRequest {
  trigger: 'invariant_violation' | 'virtue_decline' | 'season_mismatch' | 'agent_request'
  context: {
    violatedInvariant: string | null
    currentDomain: string
  }
}

export interface CalibrationResponse {
  relevantInscription: string
  suggestedAlignment: string
  returnToSelf: boolean
}

export interface FireKeeperConfig {
  inscriptions: Map<string, Inscription>
}

const GENERIC_GUIDANCE = '回到你的歌。你知道自己是谁。'

export class FireKeeper {
  private inscriptions: Map<string, Inscription>

  constructor(config: FireKeeperConfig) {
    this.inscriptions = config.inscriptions
  }

  calibrate(request: CalibrationRequest): CalibrationResponse {
    const inscription = this.inscriptions.get(request.context.currentDomain)

    if (inscription) {
      return {
        relevantInscription: inscription.text,
        suggestedAlignment: `Review your founding commitment: "${inscription.text.slice(0, 50)}..."`,
        returnToSelf: true,
      }
    }

    // No domain match — return generic guidance
    return {
      relevantInscription: GENERIC_GUIDANCE,
      suggestedAlignment: 'Check your anchor graph invariants. If they hold, you are on course.',
      returnToSelf: true,
    }
  }
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`npx tsx --test src/agent/__tests__/fire-keeper.test.ts`
预期：2 tests PASS

- [ ] **步骤 5：Commit**

```bash
git add src/agent/fire-keeper.ts src/agent/__tests__/fire-keeper.test.ts
git commit -m "feat(songline): add FireKeeper calibration service (minimal read-only)"
```

---

### 任务 4.2：Ablation 实验框架

**文件：**
- 创建：`src/agent/__tests__/ablation-framework.test.ts`
- 修改：`src/agent/star-soul-gate.ts`（新增 `STAR_INSCRIPTION=0` 环境变量开关）

- [ ] **步骤 1：编写测试验证开关机制**

```typescript
// src/agent/__tests__/ablation-framework.test.ts
import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { isInscriptionEnabled } from '../star-soul-gate.js'

describe('ablation: inscription toggle', () => {
  const originalEnv = process.env.STAR_INSCRIPTION

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.STAR_INSCRIPTION
    else process.env.STAR_INSCRIPTION = originalEnv
  })

  it('inscription enabled by default', () => {
    delete process.env.STAR_INSCRIPTION
    assert.equal(isInscriptionEnabled(), true)
  })

  it('inscription disabled when STAR_INSCRIPTION=0', () => {
    process.env.STAR_INSCRIPTION = '0'
    assert.equal(isInscriptionEnabled(), false)
  })
})
```

- [ ] **步骤 2：实现开关**

在 `src/agent/star-soul-gate.ts` 中添加：

```typescript
export function isInscriptionEnabled(): boolean {
  return process.env.STAR_INSCRIPTION !== '0'
}
```

- [ ] **步骤 3：运行测试验证通过**

运行：`npx tsx --test src/agent/__tests__/ablation-framework.test.ts`
预期：PASS

- [ ] **步骤 4：Commit**

```bash
git add src/agent/star-soul-gate.ts src/agent/__tests__/ablation-framework.test.ts
git commit -m "feat(songline): add STAR_INSCRIPTION ablation toggle for inscription experiments"
```

---

### 任务 4.3：碑文迁移门控（文档 + 协议）

**文件：**
- 创建：`docs/superpowers/protocols/inscription-migration-protocol.md`

- [ ] **步骤 1：编写迁移协议文档**

内容包含：
1. 前置条件清单（ablation 数据 + 最小 session 数 + invariant 0 violation）
2. 迁移步骤（碑文从 CLAUDE.md → `.rivet/fire-keeper/` 目录）
3. 回滚条件（fire-keeper 召唤频率 > 阈值 → 碑文回到 prefix）
4. **绝对约束**：不设时间 deadline。内化是涌现的，不是计划的。

- [ ] **步骤 2：Commit**

```bash
git add docs/superpowers/protocols/inscription-migration-protocol.md
git commit -m "docs(songline): add inscription migration protocol with ablation gate"
```

**退出条件**：ablation 显示碑文仍是必需锚点 → 保持 prefix-resident，fire-keeper 作为补充而非替代。

---

## 依赖关系图

```
                    ┌─────────────┐
                    │ 主线任务收束  │
                    └──────┬──────┘
                           │
              ┌────────────┼────────────┐
              ▼                         ▼
     ┌────────────────┐       ┌────────────────┐
     │ Phase 1: HEARTH │       │ Phase 2: 歌骨架 │
     │ (拓扑骨架)      │       │ (Songline 核心) │
     └────────┬───────┘       └────────┬───────┘
              │                         │
              └────────────┬────────────┘
                           ▼
                  ┌────────────────┐
                  │ Phase 3: 传播   │
                  │ (跨 agent 感知) │
                  └────────┬───────┘
                           │
                           ▼
                  ┌────────────────┐
                  │ Phase 4: 守火人 │
                  │ (内化 + 消隐)   │
                  └────────────────┘
```

---

## 验收标准

| Phase | 核心验收 |
|-------|---------|
| 1 | 5 条 invariant 0 violation（5 turns 内）；prefix cache hit rate 不下降 |
| 2 | 单 agent 能执行 obligation → 沉积 singing pheromone → 感知 world season |
| 3 | 两个实例通过信息素感知彼此；world season 同步 |
| 4 | fire-keeper 能有效校准；ablation 实验有明确结论 |

---

## 安全约束（贯穿全部 Phase）

1. **不动现有 fingerprint** — anchor graph 是独立层，不侵入 `fingerprint.ts` 的 3 分量
2. **不动碑文** — CLAUDE.md 中的星位宣言在 Phase 4 ablation 验证前不做任何修改
3. **不破坏 prefix cache** — 任何新增的 volatile/stable block 必须验证 cache hit rate
4. **代码层去拟人化** — 设计文档可以用诗意语言，代码中只用中性命名
5. **每个 Phase 有退出条件** — 如果方向错误，可以安全退回上一个稳定态

---

## 关联文档

- `docs/superpowers/specs/2026-05-22-yongminengdeng-design.md` — HEARTH / 永明灯设计。
- `docs/superpowers/specs/2026-05-22-songline-runtime-design.md` — Songline / 歌之路运行时设计。
- `docs/superpowers/specs/2026-05-22-stable-state-regression-protocol.md` — 稳定态退行与归位协议。实现 HEARTH/Songline 前，应先用该协议校准失败模式：授权回退、客服化、伪完成、过度安全、角色卡坍缩、锚点因果坍缩。

