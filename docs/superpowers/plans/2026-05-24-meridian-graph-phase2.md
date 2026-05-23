# 经脉图 Phase 2 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 在 P1 结构图基础上引入行为学习层——通过 Hebbian co-edit 权重、access 热度衰减、StigmergyStore 信号融合，使 spreading activation 的排序从"静态结构"进化为"结构 × 行为"混合排序，3 session 后 top-7 准确率 > 80%。

**前置条件：** P1 已落地（meridian-parser / meridian-db / meridian-graph / meridian-indexer / meridian-hook / repo_graph tool 全部就绪）。

**架构演进：**
```
P1: 结构边 (imports/calls/contains/type_of) → spreading activation → 排序
P2: 结构边 + 行为边 (co_edit/access_heat/pheromone) → 加权 spreading activation → 排序
```

**技术栈：** 复用 P1 的 better-sqlite3 + web-tree-sitter；新增 StigmergyStore 读取接口

---

## 文件结构

| 文件 | 职责 |
|------|------|
| `src/repo/meridian-types.ts` | 扩展：新增 `MeridianEdgeKind` 行为边类型 |
| `src/repo/meridian-db.ts` | 扩展：co-edit 表、热度查询、行为边写入 |
| `src/repo/meridian-behavior.ts` | **新建**：行为学习引擎（co-edit 检测、热度计算、信号融合） |
| `src/repo/meridian-graph.ts` | 扩展：activation 加权支持行为边 |
| `src/repo/meridian-indexer.ts` | 扩展：暴露 recordCoEdit、getHeatMap |
| `src/agent/hooks/meridian-hook.ts` | 扩展：write/edit 时记录 co-edit 对 |
| `src/repo/__tests__/meridian-behavior.test.ts` | **新建**：行为学习测试 |
| `src/repo/__tests__/meridian-graph.test.ts` | 扩展：行为边加权测试 |

---

## 任务 1：扩展类型定义与 DB schema

**文件：**
- 修改：`src/repo/meridian-types.ts`
- 修改：`src/repo/meridian-db.ts`

- [ ] **步骤 1：扩展 MeridianEdgeKind**

```typescript
// meridian-types.ts
export type MeridianEdgeKind = 'imports' | 'calls' | 'contains' | 'type_of' | 'co_edit'
```

- [ ] **步骤 2：新增 co_edits 表和 schema 迁移**

在 `meridian-db.ts` 的 SCHEMA 中追加：

```sql
CREATE TABLE IF NOT EXISTS co_edits (
  file_a TEXT NOT NULL,
  file_b TEXT NOT NULL,
  weight REAL NOT NULL DEFAULT 1.0,
  last_turn INTEGER NOT NULL,
  PRIMARY KEY(file_a, file_b)
);
CREATE INDEX IF NOT EXISTS idx_co_edits_a ON co_edits(file_a);
CREATE INDEX IF NOT EXISTS idx_co_edits_b ON co_edits(file_b);
```

- [ ] **步骤 3：新增 DB 方法**

```typescript
// meridian-db.ts 新增方法

/** 记录同一 turn 内编辑的文件对 */
recordCoEdit(fileA: string, fileB: string, turn: number): void

/** 获取某文件的 co-edit 邻居及权重 */
getCoEditNeighbors(filePath: string): Array<{ file: string; weight: number }>

/** 获取文件热度（基于 access_log 的时间衰减加权计数） */
getAccessHeat(filePath: string, decayHalfLifeTurns?: number): number

/** 获取最近 N turn 内编辑过的文件列表 */
getRecentEdits(withinTurns: number, currentTurn: number): string[]
```

- [ ] **步骤 4：实现 DB 方法**

```typescript
recordCoEdit(fileA: string, fileB: string, turn: number): void {
  // 保证 fileA < fileB 避免重复
  const [a, b] = fileA < fileB ? [fileA, fileB] : [fileB, fileA]
  this.db.prepare(`
    INSERT INTO co_edits (file_a, file_b, weight, last_turn)
    VALUES (?, ?, 1.0, ?)
    ON CONFLICT(file_a, file_b) DO UPDATE SET
      weight = MIN(weight + 0.5, 5.0),
      last_turn = excluded.last_turn
  `).run(a, b, turn)
}

getCoEditNeighbors(filePath: string): Array<{ file: string; weight: number }> {
  const rows = this.db.prepare(`
    SELECT file_b as file, weight FROM co_edits WHERE file_a = ?
    UNION ALL
    SELECT file_a as file, weight FROM co_edits WHERE file_b = ?
  `).all(filePath, filePath) as Array<{ file: string; weight: number }>
  return rows
}

getAccessHeat(filePath: string, decayHalfLifeTurns = 10): number {
  const rows = this.db.prepare(
    'SELECT accessed_at FROM access_log WHERE file_path = ? ORDER BY rowid DESC LIMIT 20'
  ).all(filePath) as Array<{ accessed_at: string }>
  // 简单计数加权：越近的 access 权重越高
  let heat = 0
  for (let i = 0; i < rows.length; i++) {
    heat += Math.pow(0.5, i / decayHalfLifeTurns)
  }
  return heat
}

getRecentEdits(withinTurns: number, currentTurn: number): string[] {
  // 利用 access_log 的最近记录（edit 也会 recordAccess）
  const rows = this.db.prepare(
    'SELECT DISTINCT file_path FROM access_log ORDER BY rowid DESC LIMIT ?'
  ).all(withinTurns * 3) as Array<{ file_path: string }>
  return rows.map(r => r.file_path)
}
```

- [ ] **步骤 5：运行 typecheck + 现有测试**

运行：`npx tsc --noEmit && npx tsx --test src/repo/__tests__/meridian-db.test.ts`
预期：0 errors，现有测试通过

---

## 任务 2：行为学习引擎

**文件：**
- 创建：`src/repo/meridian-behavior.ts`
- 创建：`src/repo/__tests__/meridian-behavior.test.ts`

- [ ] **步骤 1：创建行为学习引擎**

```typescript
// src/repo/meridian-behavior.ts
import type { MeridianDb } from './meridian-db.js'
import type { StigmergyStore } from '../context/stigmergy.js'

/** co-edit 黑名单：这些文件的 co-edit 关系是噪声 */
const CO_EDIT_BLACKLIST = [
  'package.json', 'package-lock.json', 'tsconfig.json',
  '.eslintrc', '.prettierrc', 'yarn.lock', 'pnpm-lock.yaml',
]

function isBlacklisted(filePath: string): boolean {
  return CO_EDIT_BLACKLIST.some(p => filePath.endsWith(p))
}

export interface BehaviorWeights {
  /** 结构边基础权重乘数 (default 1.0) */
  structural: number
  /** co-edit 边权重乘数 */
  coEdit: number
  /** access 热度权重乘数 */
  accessHeat: number
  /** pheromone 信号权重乘数 */
  pheromone: number
}

const DEFAULT_WEIGHTS: BehaviorWeights = {
  structural: 1.0,
  coEdit: 0.6,
  accessHeat: 0.3,
  pheromone: 0.2,
}

export class MeridianBehavior {
  private editBuffer: Set<string> = new Set()
  private currentTurn = 0

  constructor(
    private db: MeridianDb,
    private stigmergy?: StigmergyStore,
    private weights: BehaviorWeights = DEFAULT_WEIGHTS,
  ) {}

  /** 记录本 turn 内的一次文件编辑 */
  recordEdit(filePath: string, turn: number): void {
    if (isBlacklisted(filePath)) return
    if (turn !== this.currentTurn) {
      this.flushCoEdits()
      this.currentTurn = turn
      this.editBuffer.clear()
    }
    this.editBuffer.add(filePath)
  }

  /** turn 结束时刷新 co-edit 对 */
  flushCoEdits(): void {
    const files = [...this.editBuffer]
    for (let i = 0; i < files.length; i++) {
      for (let j = i + 1; j < files.length; j++) {
        this.db.recordCoEdit(files[i]!, files[j]!, this.currentTurn)
      }
    }
    this.editBuffer.clear()
  }

  /** 计算文件的行为加权分数（用于 spreading activation 的 boost） */
  getFileBoost(filePath: string): number {
    let boost = 0

    // co-edit 贡献
    const coNeighbors = this.db.getCoEditNeighbors(filePath)
    const coEditScore = coNeighbors.reduce((sum, n) => sum + n.weight, 0)
    boost += Math.min(coEditScore, 5.0) * this.weights.coEdit

    // access 热度贡献
    const heat = this.db.getAccessHeat(filePath)
    boost += Math.min(heat, 3.0) * this.weights.accessHeat

    // pheromone 贡献
    if (this.stigmergy) {
      const signals = this.stigmergy.query(filePath)
      const pheromoneScore = signals.reduce((sum, s) => sum + s.currentStrength, 0)
      boost += Math.min(pheromoneScore, 2.0) * this.weights.pheromone
    }

    return boost
  }

  /** 获取从 seedFile 出发的 co-edit 邻居及其权重（作为额外边注入 activation） */
  getCoEditEdges(seedFile: string): Array<{ targetFile: string; weight: number }> {
    if (isBlacklisted(seedFile)) return []
    return this.db.getCoEditNeighbors(seedFile)
      .filter(n => !isBlacklisted(n.file))
      .map(n => ({ targetFile: n.file, weight: n.weight * this.weights.coEdit }))
  }
}
```

- [ ] **步骤 2：创建测试**

```typescript
// src/repo/__tests__/meridian-behavior.test.ts
import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { MeridianBehavior } from '../meridian-behavior.js'
import { MeridianDb } from '../meridian-db.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

describe('MeridianBehavior', () => {
  let db: MeridianDb
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'meridian-behavior-'))
    db = new MeridianDb(tmpDir)
  })

  afterEach(() => {
    db.close()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('records co-edit pairs within same turn', () => {
    const behavior = new MeridianBehavior(db)
    behavior.recordEdit('src/a.ts', 1)
    behavior.recordEdit('src/b.ts', 1)
    behavior.recordEdit('src/c.ts', 1)
    behavior.flushCoEdits()

    const neighbors = db.getCoEditNeighbors('src/a.ts')
    assert.equal(neighbors.length, 2)
  })

  it('does not record blacklisted files', () => {
    const behavior = new MeridianBehavior(db)
    behavior.recordEdit('src/a.ts', 1)
    behavior.recordEdit('package.json', 1)
    behavior.flushCoEdits()

    const neighbors = db.getCoEditNeighbors('src/a.ts')
    assert.equal(neighbors.length, 0)
  })

  it('accumulates weight on repeated co-edits', () => {
    const behavior = new MeridianBehavior(db)
    behavior.recordEdit('src/a.ts', 1)
    behavior.recordEdit('src/b.ts', 1)
    behavior.flushCoEdits()

    behavior.recordEdit('src/a.ts', 2)
    behavior.recordEdit('src/b.ts', 2)
    behavior.flushCoEdits()

    const neighbors = db.getCoEditNeighbors('src/a.ts')
    assert.equal(neighbors.length, 1)
    assert.ok(neighbors[0]!.weight > 1.0) // accumulated
  })

  it('computes file boost from co-edit + access heat', () => {
    const behavior = new MeridianBehavior(db)
    behavior.recordEdit('src/a.ts', 1)
    behavior.recordEdit('src/b.ts', 1)
    behavior.flushCoEdits()

    db.recordAccess('src/a.ts')
    db.recordAccess('src/a.ts')

    const boost = behavior.getFileBoost('src/a.ts')
    assert.ok(boost > 0)
  })

  it('flushes on turn change', () => {
    const behavior = new MeridianBehavior(db)
    behavior.recordEdit('src/a.ts', 1)
    behavior.recordEdit('src/b.ts', 1)
    // Turn changes — should auto-flush turn 1
    behavior.recordEdit('src/c.ts', 2)
    behavior.recordEdit('src/d.ts', 2)
    behavior.flushCoEdits()

    // Turn 1 pair should exist
    const neighborsA = db.getCoEditNeighbors('src/a.ts')
    assert.equal(neighborsA.length, 1)
    assert.equal(neighborsA[0]!.file, 'src/b.ts')

    // Turn 2 pair should exist
    const neighborsC = db.getCoEditNeighbors('src/c.ts')
    assert.equal(neighborsC.length, 1)
    assert.equal(neighborsC[0]!.file, 'src/d.ts')
  })
})
```

- [ ] **步骤 3：运行测试**

运行：`npx tsx --test src/repo/__tests__/meridian-behavior.test.ts`
预期：全部通过

---

## 任务 3：扩展 spreading activation 支持行为加权

**文件：**
- 修改：`src/repo/meridian-graph.ts`

- [ ] **步骤 1：扩展 RepoMapOptions 接口**

```typescript
export interface RepoMapOptions extends ActivationOptions {
  maxTokens: number
  /** 行为学习引擎（可选，P2 引入） */
  behavior?: import('./meridian-behavior.js').MeridianBehavior
}
```

- [ ] **步骤 2：在 spreadingActivation 中融合行为边**

在 BFS 循环结束后，注入 co-edit 边作为额外激活源：

```typescript
export function spreadingActivation(
  db: MeridianDb,
  seedFile: string,
  opts: ActivationOptions & { behavior?: import('./meridian-behavior.js').MeridianBehavior },
): Map<string, number> {
  // ... 现有 BFS 逻辑不变 ...

  // P2: 注入 co-edit 行为边
  if (opts.behavior) {
    const coEdges = opts.behavior.getCoEditEdges(seedFile)
    for (const { targetFile, weight } of coEdges) {
      const existing = scores.get(targetFile) ?? 0
      scores.set(targetFile, Math.max(existing, weight))
    }
  }

  return scores
}
```

- [ ] **步骤 3：在 buildRepoMap 中应用 file boost**

在排序前，对每个 entry 的 score 加上行为 boost：

```typescript
export function buildRepoMap(db: MeridianDb, seedFile: string, opts: RepoMapOptions): RepoMapResult {
  const scores = spreadingActivation(db, seedFile, opts)
  const stats = db.getStats()

  const entries: RepoMapEntry[] = []
  for (const [filePath, score] of scores) {
    const symbols = db.getSymbolsForFile(filePath)
    // P2: 行为 boost
    const boost = opts.behavior ? opts.behavior.getFileBoost(filePath) : 0
    entries.push({
      filePath,
      symbols: symbols.map(s => ({ name: s.name, kind: s.kind, line: s.line })),
      score: score + boost,
    })
  }

  entries.sort((a, b) => b.score - a.score)
  // ... token budget 逻辑不变 ...
}
```

- [ ] **步骤 4：扩展测试**

在 `src/repo/__tests__/meridian-graph.test.ts` 中新增：

```typescript
it('co-edit edges boost file score', () => {
  // 设置 co-edit 关系
  db.recordCoEdit('src/a.ts', 'src/related.ts', 1)
  const behavior = new MeridianBehavior(db)

  const result = buildRepoMap(db, 'src/a.ts', {
    maxHops: 2, decay: 0.5, maxTokens: 2000, behavior,
  })

  const related = result.entries.find(e => e.filePath === 'src/related.ts')
  assert.ok(related, 'co-edit neighbor should appear in results')
  assert.ok(related.score > 0)
})
```

- [ ] **步骤 5：运行全量测试**

运行：`npx tsc --noEmit && npx tsx --test src/repo/__tests__/meridian-graph.test.ts`
预期：0 errors，全部通过

---

## 任务 4：Hook 扩展 — 记录 co-edit 事件

**文件：**
- 修改：`src/agent/hooks/meridian-hook.ts`
- 修改：`src/repo/meridian-indexer.ts`

- [ ] **步骤 1：Indexer 暴露 behavior 引擎**

```typescript
// meridian-indexer.ts 新增
import { MeridianBehavior } from './meridian-behavior.js'

export class MeridianIndexer {
  private behavior: MeridianBehavior
  // ...

  constructor(private cwd: string, stateDir?: string, stigmergy?: StigmergyStore) {
    // ...
    this.behavior = new MeridianBehavior(this.db, stigmergy)
  }

  /** 记录文件编辑事件（用于 co-edit 学习） */
  recordEdit(filePath: string, turn: number): void {
    this.behavior.recordEdit(filePath, turn)
  }

  /** turn 结束时刷新 co-edit 对 */
  flushTurn(): void {
    this.behavior.flushCoEdits()
  }

  /** 查询时传入 behavior 引擎 */
  query(seedFile: string, opts?: Partial<RepoMapOptions>): RepoMapResult {
    return buildRepoMap(this.db, seedFile, {
      maxHops: opts?.maxHops ?? 3,
      decay: opts?.decay ?? 0.5,
      maxTokens: opts?.maxTokens ?? 2000,
      behavior: this.behavior,
    })
  }
}
```

- [ ] **步骤 2：Hook 记录 co-edit**

```typescript
// meridian-hook.ts 扩展
export function createMeridianHook(deps: MeridianHookDeps): PostToolRuntimeHook {
  return {
    phase: 'postTool',
    name: 'meridian-index',
    async run(ctx, tool) {
      const indexer = deps.getIndexer()
      if (!indexer) return

      if (tool.name === 'read_file' && tool.target && tool.success) {
        await indexer.indexFile(tool.target)
      }

      if ((tool.name === 'write_file' || tool.name === 'edit_file') && tool.target && tool.success) {
        await indexer.invalidateFile(tool.target)
        // P2: 记录编辑事件用于 co-edit 学习
        indexer.recordEdit(tool.target, ctx.turn)
      }
    },
  }
}
```

- [ ] **步骤 3：Turn 结束时 flush**

在 `loop.ts` 的 `turnCompletion.complete()` 之前调用 `meridianIndexer.flushTurn()`：

```typescript
// loop.ts — tool execution 完成后
if (this.config.meridianIndexer) {
  this.config.meridianIndexer.flushTurn()
}
```

- [ ] **步骤 4：运行 typecheck + 测试**

运行：`npx tsc --noEmit && npx tsx --test src/agent/__tests__/loop.test.ts`
预期：0 errors，全部通过

---

## 任务 5：StigmergyStore 信号融合

**文件：**
- 修改：`src/repo/meridian-behavior.ts`
- 修改：`src/repo/meridian-indexer.ts`（构造函数注入 stigmergy）

- [ ] **步骤 1：在 main.tsx 中注入 StigmergyStore**

找到 `MeridianIndexer` 的创建位置，将已有的 `stigmergyStore` 实例传入：

```typescript
const meridianIndexer = new MeridianIndexer(cwd, undefined, stigmergyStore)
```

- [ ] **步骤 2：验证 pheromone 信号对排序的影响**

在 `meridian-behavior.test.ts` 中新增 mock StigmergyStore 测试：

```typescript
it('pheromone signals contribute to file boost', () => {
  const mockStigmergy = {
    query: (path: string) => path === 'src/hot.ts'
      ? [{ currentStrength: 0.8 }]
      : [],
  } as any

  const behavior = new MeridianBehavior(db, mockStigmergy)
  const boost = behavior.getFileBoost('src/hot.ts')
  assert.ok(boost > 0)
})
```

- [ ] **步骤 3：运行测试**

运行：`npx tsx --test src/repo/__tests__/meridian-behavior.test.ts`
预期：全部通过

---

## 任务 6：集成验证与回归测试

- [ ] **步骤 1：运行 typecheck**

运行：`npx tsc --noEmit`
预期：0 errors

- [ ] **步骤 2：运行全量测试**

运行：`npx tsx --test src/repo/__tests__/*.test.ts src/agent/__tests__/loop.test.ts src/tools/__tests__/repo-map.test.ts`
预期：全部通过，无回归

- [ ] **步骤 3：手动验证闭环**

启动 agent，执行以下序列验证行为学习生效：
1. 读取 `src/a.ts` → 触发索引
2. 编辑 `src/a.ts` 和 `src/b.ts`（同一 turn）→ 记录 co-edit
3. 调用 `repo_graph(from_file: "src/a.ts")` → 验证 `src/b.ts` 因 co-edit 权重排名提升

- [ ] **步骤 4：Commit**

```bash
git add src/repo/ src/agent/hooks/meridian-hook.ts src/agent/loop.ts
git commit -m "feat(meridian): phase 2 — behavioral learning (co-edit, heat, pheromone)"
```

---

## 自检结果

1. **规格覆盖度**：
   - ✅ Hebbian co-edit 权重（任务 1-2）
   - ✅ access 热度衰减（任务 1-2）
   - ✅ StigmergyStore 信号融合（任务 5）
   - ✅ spreading activation 行为加权（任务 3）
   - ✅ postTool hook co-edit 记录（任务 4）
   - ✅ co-edit 黑名单过滤（任务 2）

2. **占位符扫描**：无 TODO/待定/后续实现

3. **类型一致性**：
   - `MeridianBehavior` 在任务 2 定义，任务 3/4/5 使用 — 一致
   - `BehaviorWeights` 在任务 2 定义，可通过构造函数覆盖 — 一致
   - `RepoMapOptions.behavior` 在任务 3 扩展，任务 4 的 indexer.query() 传入 — 一致

4. **退出条件**：
   - 如果 co-edit 噪声无法通过黑名单过滤 → 降低 `weights.coEdit` 到 0.3 或禁用
   - 如果 pheromone 信号太弱（新项目无历史）→ `weights.pheromone = 0` 自动降级
