# Immune 包 A：类型重构 + SQLite 持久化

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（强制使用，每任务一个新 agent）。步骤使用复选框（`- [ ]`）语法跟踪进度。
>
> **🛑 关键执行规则：**
> 1. **每个任务结尾有 STOP 标记**——完成后必须停止，等待用户审查后才能开始下一任务
> 2. **TDD 红绿循环必须留下证据**：测试 commit 在前，实现 commit 在后
> 3. **每任务独立 commit**——不要批量
> 4. **typecheck 用 CLI 真跑**：`npx tsc --noEmit; echo "exit: $?"`
> 5. **集成步骤不可省**：任务 2 的步骤 7、8 是 wire 到 loop.ts 的核心，缺了等于孤儿代码
>
> **包 A 只有 2 个任务，做完就停。** 不要碰原 1389 行计划里的任务 3-10。

**包 A 在索引中的位置：** 见 `2026-05-24-immune-completion-index.md`。本包是 P0 前置，B/C/D 都依赖 A 的产出。

**目标：**
- 把 `ImmuneMemory.response` 从 `string` 改为结构化 `ImmuneResponse`，让免疫响应可以承载 `targetFile`、`healthyEdges` 等具体信息
- 让 `ImmuneAdaptiveLayer.recordSuccess` 接受结构化 response
- 把 immune memories 持久化到 SQLite（跨 session 二次响应）

**架构：** `ImmuneResponse` 类型已经在 `immune-types.ts:39` 定义好；只需把 `ImmuneMemory.response` 字段类型从 `string` 替换为 `ImmuneResponse`，并修改 adaptive layer 的 record/lookup 接口。

**技术栈：** TypeScript / better-sqlite3 / 现有 MeridianDb + ImmuneAdaptiveLayer

**前置阅读（执行前必读，不要跳过）：**
- `src/agent/immune-types.ts`——`ImmuneMemory`（行 25-32）和 `ImmuneResponse`（行 39-45）当前定义
- `src/agent/immune-adaptive.ts`——`recordSuccess`（行 45-72）、`lookup`（行 40-43）、`fastRepair`（搜 `fastRepair`）、`export`/`import`（行 120-127）
- `src/agent/immune-hook.ts`——`exportMemories`（行 203）、`adaptive.recordSuccess` 调用点（行 148）
- `src/repo/meridian-db.ts`——查 SCHEMA 常量位置 + `loadPhysarumEdges` 方法位置（约 269 行，可能因前次提交略有偏移）
- `src/agent/loop.ts:295`——immune 构造点；`src/agent/loop.ts:765` 附近——session 结束/persist 点

**关键架构发现（执行前必读）：**
1. `ImmuneAdaptiveLayer` 已有 `export()` 和 `import(memories)` 方法（行 120-127），不需要新建
2. `ImmuneHook` 已有 `exportMemories()`（行 203），但**没有 `importMemories()`**——任务 2 需要补
3. 当前 `recordSuccess(pattern, response, turn)` 的 `response` 是 string，任务 1 要改签名

---

## 任务 1：ImmuneMemory.response 改结构化

**文件：**
- 修改：`src/agent/immune-types.ts`（改 `ImmuneMemory.response` 类型）
- 修改：`src/agent/immune-adaptive.ts`（`recordSuccess` 签名 + 内部存储 + `fastRepair` 返回类型）
- 修改：`src/agent/immune-hook.ts`（调用 `recordSuccess` 处传结构化 response）
- 创建：`src/agent/__tests__/immune-types-structured.test.ts`

- [ ] **步骤 1：编写失败的测试**

文件 `src/agent/__tests__/immune-types-structured.test.ts`：

```typescript
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { ImmuneAdaptiveLayer } from '../immune-adaptive.js'
import type { ImmuneResponse } from '../immune-types.js'

describe('ImmuneMemory structured response', () => {
  it('records and retrieves a quarantine response with targetFile', () => {
    const layer = new ImmuneAdaptiveLayer()
    const response: ImmuneResponse = { type: 'quarantine', targetFile: 'src/foo.ts', duration: 20 }
    layer.recordSuccess('fp_abc', response, 10)

    const mem = layer.lookup('fp_abc')
    assert.ok(mem)
    assert.equal(mem.response.type, 'quarantine')
    assert.equal(mem.response.targetFile, 'src/foo.ts')
    assert.equal(mem.response.duration, 20)
  })

  it('records and retrieves a boost_healthy response with healthyEdges', () => {
    const layer = new ImmuneAdaptiveLayer()
    const response: ImmuneResponse = {
      type: 'boost_healthy',
      healthyEdges: [{ fileA: 'src/a.ts', fileB: 'src/b.ts' }],
    }
    layer.recordSuccess('fp_xyz', response, 11)
    const mem = layer.lookup('fp_xyz')
    assert.ok(mem)
    assert.equal(mem.response.type, 'boost_healthy')
    assert.equal(mem.response.healthyEdges?.[0]?.fileA, 'src/a.ts')
  })

  it('export and import preserve structured response', () => {
    const layer = new ImmuneAdaptiveLayer()
    layer.recordSuccess('fp_1', { type: 'deposit_warning', targetFile: 'f.ts' }, 1)
    const exported = layer.export()
    assert.equal(exported.length, 1)
    assert.equal(exported[0]!.response.type, 'deposit_warning')

    const layer2 = new ImmuneAdaptiveLayer()
    layer2.import(exported)
    const mem = layer2.lookup('fp_1')
    assert.ok(mem)
    assert.equal(mem.response.targetFile, 'f.ts')
  })

  it('fastRepair returns structured response from memory', () => {
    const layer = new ImmuneAdaptiveLayer()
    const response: ImmuneResponse = { type: 'quarantine', targetFile: 'src/foo.ts', duration: 15 }
    layer.recordSuccess('fp_doom', response, 10)

    const mem = layer.lookup('fp_doom')
    assert.ok(mem)
    const repair = layer.fastRepair(mem)
    assert.equal(repair.type, 'quarantine')
    assert.equal(repair.targetFile, 'src/foo.ts')
  })
})
```

- [ ] **步骤 2：运行测试验证 FAIL（红色阶段）**

运行：`npx tsx --test src/agent/__tests__/immune-types-structured.test.ts`

预期：FAIL —— 错误大概率是 `Type 'ImmuneResponse' is not assignable to parameter of type 'string'`（因为 `recordSuccess` 当前接 string）。

- [ ] **步骤 3：先 commit 测试**

```bash
git add src/agent/__tests__/immune-types-structured.test.ts
git commit -m "test(immune): assert structured response in adaptive layer"
```

- [ ] **步骤 4：改 `immune-types.ts` 中 `ImmuneMemory.response` 字段类型**

在 `src/agent/immune-types.ts` 中：

旧：
```typescript
export interface ImmuneMemory {
  id: string
  pattern: string
  response: string
  affinityScore: number
  hitCount: number
  lastHit: number
  createdAt: number
}
```

新：
```typescript
export interface ImmuneMemory {
  id: string
  pattern: string
  response: ImmuneResponse
  affinityScore: number
  hitCount: number
  lastHit: number
  createdAt: number
}
```

注意：`ImmuneResponse` 已经在同一文件下面（约行 39）定义，**不需要 import**。但 `ImmuneMemory` 接口在前、`ImmuneResponse` 接口在后——把 `ImmuneResponse` 接口移到 `ImmuneMemory` 之前，或者保持顺序但确认 TS 不报"used before defined"（接口可前向引用，应该 OK）。

如果 typecheck 报错"Cannot find name 'ImmuneResponse'"：把 `ImmuneResponse` 和 `ImmuneResponseType` 定义移到 `ImmuneMemory` 之前。

- [ ] **步骤 5：改 `immune-adaptive.ts` 的 `recordSuccess` 签名**

读 `src/agent/immune-adaptive.ts` 行 45-72，确认当前 `recordSuccess` 的形态。

把签名从：
```typescript
recordSuccess(pattern: string, response: string, turn: number): void {
```
改为：
```typescript
recordSuccess(pattern: string, response: ImmuneResponse, turn: number): void {
```

注意：
- 顶部需要 `import type { ImmuneResponse } from './immune-types.js'`（如果还没 import 的话）
- 内部把 response 直接存进 `ImmuneMemory.response` 字段（类型现在匹配了）
- 不需要 JSON.stringify，运行时是 object（持久化是任务 2 的事）

- [ ] **步骤 6：改 `fastRepair` 方法签名（如果存在）**

搜 `fastRepair` 在 `immune-adaptive.ts` 中的定义。如果它返回 `ImmuneResponse`，应该已经类型一致；如果它构造一个新的 response object 返回，确认它返回的是 `mem.response`（直接传递）而不是手动构造字符串。

如果 `fastRepair` 内部有 `return memory.response` 那一行，类型修改自动生效。如果有手动构造逻辑（比如 `return { type: 'quarantine', ... }`），也保持原样（任务 6 才丰富化策略）。

- [ ] **步骤 7：改 `immune-hook.ts` 调用 `recordSuccess` 处**

读 `src/agent/immune-hook.ts` 行 145-155，找到 `this.adaptive.recordSuccess(fingerprint, strategy, turn)` 这行（约 148 行）。

`strategy` 当前是字符串（如 `'quarantine'`）。需要把它包装成 `ImmuneResponse` 对象。最小改法：

旧：
```typescript
this.adaptive.recordSuccess(fingerprint, strategy, turn)
```

新（最小化）：
```typescript
const responseObj: ImmuneResponse = typeof strategy === 'string'
  ? { type: strategy as ImmuneResponseType }
  : strategy
this.adaptive.recordSuccess(fingerprint, responseObj, turn)
```

如果 `strategy` 已经是 `ImmuneResponse` 类型（在更上游已经构造好了），直接传递即可。看上下文判断。

可能需要 import：
```typescript
import type { ImmuneResponse, ImmuneResponseType } from './immune-types.js'
```

- [ ] **步骤 8：跑 typecheck**

运行：`npx tsc --noEmit; echo "exit: $?"`

预期：exit 0

如果失败：
- 错误大概率在某个间接调用 `recordSuccess` 的位置，那里可能也传了 string。grep `recordSuccess` 找全部调用点：
  ```bash
  grep -rn "recordSuccess" src/ --include="*.ts" | grep -v test
  ```
- 每个调用点都按"包装为 ImmuneResponse object"的模式修改

- [ ] **步骤 9：运行新增测试 + 现有 immune 测试**

```bash
npx tsx --test src/agent/__tests__/immune-types-structured.test.ts
npx tsx --test 'src/agent/__tests__/immune-*.test.ts'
```

预期：全部 PASS。

如果现有 immune 测试失败，那些测试可能也用了 string response。修复测试用例使用 `{ type: '...' }` 形式。**但要谨慎**——如果改测试是为了让它通过，确认改后仍然测了相同的语义，不是放水。

- [ ] **步骤 10：跑全量测试**

运行：`npm test`

预期：通过率与执行前一致（pre-existing `startup-memory.test.ts` 失败可忽略）。

- [ ] **步骤 11：Commit 实现**

```bash
git add src/agent/immune-types.ts src/agent/immune-adaptive.ts src/agent/immune-hook.ts
git commit -m "$(cat <<'EOF'
feat(immune): change ImmuneMemory.response to structured ImmuneResponse

Replace `response: string` with `response: ImmuneResponse` so the
adaptive layer can carry quarantine/boost/prune-specific fields
(targetFile, healthyEdges, duration) instead of an opaque string.

Required for cross-session persistence (Task 2): structured response
serializes cleanly to SQLite via JSON.

This is the foundation for fastRepair strategy enrichment (later
tasks in packages C and D).
EOF
)"
```

- [ ] 🛑 **STOP** —— 任务 1 完成。报告：
  - 两个 commit SHA（test + impl）
  - `npx tsc --noEmit` exit code
  - immune 测试全部 PASS 的输出截图（最后几行）
  - 全量测试统计（通过/失败数）
  - 是否修改了任何现有测试用例（如有，列出文件名 + 改动语义说明）

  **不要继续任务 2。**

---

## 任务 2：immune_memory 持久化到 SQLite

**文件：**
- 修改：`src/repo/meridian-db.ts`（SCHEMA + save/load 方法）
- 修改：`src/agent/immune-hook.ts`（添加 `importMemories` 方法）
- 修改：`src/agent/loop.ts`（启动时 load + 退出/persist 时 save）
- 创建：`src/agent/__tests__/immune-persistence.test.ts`

**前置阅读（必读）：**
- `src/repo/meridian-db.ts` 行 1-80（SCHEMA 常量位置、import 区）
- `src/repo/meridian-db.ts` 中 `loadPhysarumEdges` / `savePhysarumEdges` 方法（搜 `Physarum`，作为模式参考）
- `src/agent/immune-hook.ts` 行 200-210——`exportMemories` 已存在，要补 `importMemories`
- `src/agent/loop.ts:290-300`——immune 构造区
- `src/agent/loop.ts` 中搜 `immuneHook.getPhysarum().save()`——找到 session 结束/persist 调用点

**关键架构点：**
- 新表 `immune_memory`，`response` 字段序列化为 JSON
- `loadImmuneMemories` 必须容错：corrupt JSON 应跳过该行而非抛错
- `saveImmuneMemories` 用 transaction 包裹（DELETE + INSERT），避免半保存
- `importMemories` 委托给 `adaptive.import(memories)`（已存在）

- [ ] **步骤 1：编写失败的测试**

文件 `src/agent/__tests__/immune-persistence.test.ts`：

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

  it('returns empty array when table is fresh', () => {
    const dir = mkdtempSync(join(tmpdir(), 'immune-db-'))
    try {
      const db = new MeridianDb(dir)
      const loaded = db.loadImmuneMemories()
      assert.equal(loaded.length, 0)
      db.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
```

- [ ] **步骤 2：运行测试验证 FAIL**

运行：`npx tsx --test src/agent/__tests__/immune-persistence.test.ts`

预期：FAIL —— `db.saveImmuneMemories is not a function`

- [ ] **步骤 3：先 commit 测试**

```bash
git add src/agent/__tests__/immune-persistence.test.ts
git commit -m "test(immune): persistence round-trip + replace-on-save"
```

- [ ] **步骤 4：在 `meridian-db.ts` SCHEMA 常量末尾添加新表**

读 `src/repo/meridian-db.ts` 顶部，找 SCHEMA 常量（看起来是反引号包围的 SQL 字符串）。在 `physarum_edges` 表的 SQL 之后、SCHEMA 字符串闭合反引号之前添加：

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

注意：response 字段名是 `response_json`（不是 `response`），明确告知是序列化的 JSON。

- [ ] **步骤 5：在文件顶部 import ImmuneMemory 类型**

```typescript
import type { ImmuneMemory } from '../agent/immune-types.js'
```

放置位置：与其他 type imports 一组。

- [ ] **步骤 6：在 `loadPhysarumEdges` 之后添加 save/load 方法**

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
        // Corrupt row — skip, don't fail the whole load
      }
    }
    return result
  }
```

注意：
- `db.transaction(...)` 是 better-sqlite3 的 API，确认 `this.db` 是 better-sqlite3 实例（应该是）
- `JSON.parse` 失败时跳过该行，不让一个坏行毁掉整个 session 启动

- [ ] **步骤 7：跑测试验证持久化通过**

运行：`npx tsx --test src/agent/__tests__/immune-persistence.test.ts`

预期：3/3 PASS

- [ ] **步骤 8：在 `immune-hook.ts` 添加 `importMemories` 方法**

读 `src/agent/immune-hook.ts` 行 200-210，确认 `exportMemories()` 位置。在它之后添加：

```typescript
/** Import immune memories from persistence (cross-session secondary response) */
importMemories(memories: ImmuneMemory[]): void {
  this.adaptive.import(memories)
}
```

可能需要在文件顶部 import 类型：
```typescript
import type { ImmuneMemory, DangerSignal, ImmuneResponse } from './immune-types.js'
```

（`ImmuneMemory` 之前可能没 import，看一下当前 import 行）

- [ ] **步骤 9：在 `loop.ts` immune 构造之后加载持久化**

读 `src/agent/loop.ts:290-300`，找到：

```typescript
this.immuneHook = new ImmuneHook({ physarum, stigmergy: this.stigmergyStore })
```

在这行之后添加：

```typescript
// Load persisted immune memories from previous sessions (cross-session secondary response)
if (meridianDb) {
  try {
    this.immuneHook.importMemories(meridianDb.loadImmuneMemories())
  } catch { /* non-critical: missing table or corrupt data */ }
}
```

注意缩进与上下文一致（看上面那行的缩进，应该是 4 空格）。

- [ ] **步骤 10：在 `loop.ts` 找到 session-end persist 点添加保存**

```bash
grep -n "physarum.*save\|getPhysarum().save\|immuneHook" src/agent/loop.ts | head -10
```

找到现有的 `this.immuneHook.getPhysarum().save()` 调用位置（约 765 行附近）。在它**之后**添加：

```typescript
// Persist immune memories for cross-session secondary response
try {
  const db = this.config.meridianIndexer?.getDb()
  if (db) db.saveImmuneMemories(this.immuneHook.exportMemories())
} catch { /* non-critical */ }
```

如果 grep 找不到 physarum save 调用，那说明 session-end 的位置在更靠后的地方——确认你找的是 session 结束/cleanup 而不是普通点。

- [ ] **步骤 11：跑 typecheck**

运行：`npx tsc --noEmit; echo "exit: $?"`

预期：exit 0

- [ ] **步骤 12：跑相关测试**

```bash
npx tsc --noEmit
npx tsx --test src/agent/__tests__/immune-persistence.test.ts
npx tsx --test 'src/agent/__tests__/immune-*.test.ts'
```

预期：全部 PASS。

- [ ] **步骤 13：人工验证集成**

```bash
grep -n "importMemories\|saveImmuneMemories\|loadImmuneMemories" src/agent/loop.ts src/agent/immune-hook.ts src/repo/meridian-db.ts
```

预期至少 5 个匹配：
- `meridian-db.ts`: 2 个（saveImmuneMemories 定义 + loadImmuneMemories 定义）
- `immune-hook.ts`: 1 个（importMemories 定义）
- `loop.ts`: 2 个（importMemories 调用 + saveImmuneMemories 调用）

如果 loop.ts 里少于 2 个匹配，说明集成漏做。

- [ ] **步骤 14：跑全量测试**

```bash
npm test
```

预期：通过率维持，pre-existing `startup-memory.test.ts` 可忽略。

- [ ] **步骤 15：Commit**

```bash
git add src/repo/meridian-db.ts src/agent/immune-hook.ts src/agent/loop.ts
git commit -m "$(cat <<'EOF'
feat(immune): persist immune memories to SQLite for cross-session secondary response

Adds immune_memory table to MeridianDb with JSON-serialized response
field. On loop construction, loadImmuneMemories rehydrates the
adaptive layer. On session persist, exportMemories + saveImmuneMemories
flushes learned repairs to disk.

Closes orphan code from immune-completion plan Task 2. Read path
(adaptive.lookup → fastRepair) was already wired; this completes
the write-and-persist path so secondary response works across
sessions, not just within one.
EOF
)"
```

- [ ] 🛑 **STOP** —— 任务 2 完成（包 A 全部完成）。报告：
  - 4 个 commit SHA（任务 1 test + impl，任务 2 test + impl）
  - 步骤 13 的 grep 输出（必须 ≥ 5 个匹配）
  - typecheck exit code
  - 全量测试通过统计
  - 一句话总结：包 A 是否可以交付包 B

  **包 A 到此结束。** 包 B 在用户审查后写。

---

## 包 A 自检清单（用户审查时用）

- [ ] 4 个独立 commit（不是 batch）
- [ ] TDD 痕迹：每个任务都是先 test commit，后 impl commit
- [ ] `ImmuneMemory.response` 类型已改为 `ImmuneResponse`（grep 验证）
- [ ] SQLite immune_memory 表已建（直接看 schema 字符串）
- [ ] `loop.ts` 有 importMemories 调用 + saveImmuneMemories 调用
- [ ] `npx tsc --noEmit` exit 0
- [ ] 全量测试无新增失败（startup-memory.test.ts 除外）
- [ ] 没有未引用的 import / dead code

## 包 A 之外（不做）

- 任务 3+：danger signal 接入（包 B）
- 任务 6：fastRepair 策略丰富化（包 C）
- 任务 8：notebook 双向同步（包 D）

如果发现包 A 修改间接破坏了别的功能（比如某测试在改 response 类型后报错），**只修该测试**，不要扩大范围。
