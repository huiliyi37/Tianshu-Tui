# Immune 包 D：MistakeNotebook 持久化 + recordRepairSuccess 接入

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（强制使用，每任务一个新 agent）。步骤使用复选框（`- [ ]`）语法跟踪进度。
>
> **🛑 关键执行规则：**
> 1. **每个任务结尾有 STOP 标记**——完成后必须停止，等待用户审查
> 2. **TDD 红绿循环必须留下证据**：测试 commit 在前，实现 commit 在后
> 3. **每任务独立 commit**——不要批量
> 4. **typecheck 用 CLI 真跑**：`npx tsc --noEmit; echo "exit: $?"`
> 5. **集成步骤不可省**：每个 wire 都要有 production caller 可以 grep 验证
> 6. **忽略所有 IDE/LSP 诊断推送**：CLI tsc 是唯一真相，IDE 诊断都跳过
>
> **包 D 共 2 个任务，做完就停。** 这是免疫系统完整化的最后一个包。

**包 D 在索引中的位置：** 见 `2026-05-24-immune-completion-index.md`。本包是 P3，依赖包 A（已完成）。包 B 已完成，包 C 调查后无活（fastRepair 和 Pheromone 已闭环）。

**目标：**
1. **任务 8**：MistakeNotebook 加 SQLite 跨 session 持久化（与包 A 任务 2 同样的模式）。当前每次 agent 重启所有学到的教训丢失。
2. **任务 9**：repair pipeline 成功 → ImmuneHook.recordRepairSuccess 接入 + 修正 `as ImmuneResponseType` 静默 cast。当前 immune adaptive 层永远学不到东西，因为没有 caller 调 recordRepairSuccess。

**技术栈：** TypeScript + better-sqlite3（已在包 A 任务 2 使用过）

**前置阅读（执行前必读）：**

- `src/agent/mistake-notebook.ts` 全部 72 行——内部用 `Map<string, MistakeEntry>`，已有 record/query/formatHints
- `src/agent/p3-integration.ts` 行 25, 40, 74-86——`P3Integration.notebook` 字段、recordMistake/getMistakeHints 委托
- `src/repo/meridian-db.ts` 行 65-74——immune_memory 表（包 A 模板）、行 285-330——save/load 方法（包 A 模板）
- `src/agent/loop.ts` 行 298-303（包 A 加的 importMemories 调用）、行 776-779（包 A 加的 saveImmuneMemories 调用）——同位置加 mistake notebook 的 load/save
- `src/agent/immune-hook.ts` 行 145-155——recordRepairSuccess、recordRepairFailure 当前实现
- `src/agent/tool-pipeline.ts` 行 573-590——已有的 mistake-resolution 检测点（包 mistake-notebook-wire 加的，commit `a471b50`）
- `src/agent/mistake-detector.ts` 全部——`detectMistakeResolution` 函数，可复用

**关键架构发现：**
1. MistakeNotebook 是 in-memory Map，没有任何持久化代码——是干净的添加
2. P3Integration 持有 `notebook` 字段（readonly public，外部可访问）
3. recordRepairSuccess 在 immune-hook.ts:147 用 `as ImmuneResponseType` 静默 cast（包 A agent 留的妥协）——签名要改成接受 `ImmuneResponse` 对象而不是 string strategy
4. tool-pipeline.ts:577-590 已经在 `!harnessResult.isError && deps.p3` 时调 `p3.recordMistake`——immune 学习应该在同一位置或紧邻位置
5. 现有的 `detectMistakeResolution(traceStore, traceId, toolName)` 已经检测了 failed→passed 跃迁——可以复用同样的判断给 immune 系统

---

## 任务 8：MistakeNotebook SQLite 持久化

**文件：**
- 修改：`src/agent/mistake-notebook.ts`（加 entries() 和 importEntries() 方法）
- 修改：`src/repo/meridian-db.ts`（加 mistake_entries 表 + save/load 方法）
- 修改：`src/agent/loop.ts`（startup load + session-end save）
- 创建：`src/agent/__tests__/mistake-persistence.test.ts`

**关键架构点：**
- 与包 A 任务 2 完全同构：DELETE-then-INSERT 事务、JSON.parse 行级 try/catch、try/catch 优雅降级
- MistakeEntry 已有 id/timestamp/error/context/resolution/tags 字段——id 作主键、tags 存 JSON 字符串
- 不动 record/query/formatHints 现有逻辑

- [ ] **步骤 1：在 MistakeNotebook 加 entries() + importEntries() 方法**

读 `src/agent/mistake-notebook.ts` 当前状态。在 `size()` 方法之后（约行 60）加：

```typescript
  /** Export all entries for persistence */
  entries(): MistakeEntry[] {
    return [...this.entries.values()]
  }

  /** Import entries from external source (e.g., SQLite). Skips duplicates by id. */
  importEntries(entries: MistakeEntry[]): void {
    for (const entry of entries) {
      if (!this.entries.has(entry.id)) {
        this.entries.set(entry.id, entry)
      }
    }
  }
```

**注意：** `entries` 已是私有 Map 字段名。新方法叫 `entries()` 会和字段同名冲突。改名：方法叫 `getAllEntries()`。

修订：

```typescript
  /** Export all entries for persistence */
  getAllEntries(): MistakeEntry[] {
    return [...this.entries.values()]
  }

  /** Import entries from external source (e.g., SQLite). Skips duplicates by id. */
  importEntries(entries: MistakeEntry[]): void {
    for (const entry of entries) {
      if (!this.entries.has(entry.id)) {
        this.entries.set(entry.id, entry)
      }
    }
  }
```

- [ ] **步骤 2：编写失败的持久化测试**

文件 `src/agent/__tests__/mistake-persistence.test.ts`：

```typescript
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MeridianDb } from '../../repo/meridian-db.js'
import type { MistakeEntry } from '../mistake-notebook.js'

describe('MistakeNotebook SQLite persistence', () => {
  let tmpDir: string
  let dbPath: string

  before(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'mistake-persist-'))
    dbPath = join(tmpDir, 'test.db')
  })

  after(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('round-trips mistake entries through SQLite', () => {
    const db = new MeridianDb(dbPath)
    const entries: MistakeEntry[] = [
      {
        id: 'abc123',
        timestamp: '2026-05-24',
        error: 'ENOENT: no such file',
        context: 'file: foo.ts',
        resolution: 'use list_dir first',
        tags: ['filesystem', 'read'],
      },
      {
        id: 'def456',
        timestamp: '2026-05-24',
        error: 'permission denied',
        context: 'file: /etc/passwd',
        resolution: 'never read system files',
        tags: ['security'],
      },
    ]

    db.saveMistakeEntries(entries)
    const loaded = db.loadMistakeEntries()
    db.close()

    assert.equal(loaded.length, 2)
    assert.equal(loaded[0]!.id, 'abc123')
    assert.deepEqual(loaded[0]!.tags, ['filesystem', 'read'])
    assert.equal(loaded[1]!.error, 'permission denied')
  })

  it('replaces all entries on save (snapshot semantics, not append)', () => {
    const db = new MeridianDb(dbPath)
    db.saveMistakeEntries([{
      id: 'first', timestamp: '2026-05-24', error: 'e1',
      context: 'c1', resolution: 'r1', tags: [],
    }])
    db.saveMistakeEntries([{
      id: 'second', timestamp: '2026-05-24', error: 'e2',
      context: 'c2', resolution: 'r2', tags: [],
    }])
    const loaded = db.loadMistakeEntries()
    db.close()

    assert.equal(loaded.length, 1)
    assert.equal(loaded[0]!.id, 'second')
  })

  it('returns empty array on fresh db', () => {
    const fresh = mkdtempSync(join(tmpdir(), 'mistake-fresh-'))
    const db = new MeridianDb(join(fresh, 'fresh.db'))
    const loaded = db.loadMistakeEntries()
    db.close()
    rmSync(fresh, { recursive: true, force: true })

    assert.deepEqual(loaded, [])
  })
})
```

- [ ] **步骤 3：跑测试验证 FAIL（红色阶段）**

```bash
npx tsx --test src/agent/__tests__/mistake-persistence.test.ts
```

预期：FAIL with `db.saveMistakeEntries is not a function`

- [ ] **步骤 4：commit 失败的测试**

```bash
git add src/agent/__tests__/mistake-persistence.test.ts src/agent/mistake-notebook.ts
git commit -m "test(mistake): assert persistence round-trip + replace-on-save"
```

注意：mistake-notebook.ts 的 `getAllEntries`/`importEntries` 也一并提交，因为下一步 wire 需要它们。

- [ ] **步骤 5：在 MeridianDb 加 mistake_entries 表**

读 `src/repo/meridian-db.ts` 找到 SCHEMA 常量（行 65 附近 immune_memory 表的位置）。在 `immune_memory` 表 + 索引之后**加新表**：

```sql
CREATE TABLE IF NOT EXISTS mistake_entries (
  id TEXT PRIMARY KEY,
  timestamp TEXT NOT NULL,
  error TEXT NOT NULL,
  context TEXT NOT NULL,
  resolution TEXT NOT NULL,
  tags_json TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX IF NOT EXISTS idx_mistake_error ON mistake_entries(error);
```

注意：与 immune_memory 表用 `response_json` 同样的命名习惯——`tags_json` 表示 JSON 字符串列。

- [ ] **步骤 6：在 MeridianDb 加 saveMistakeEntries + loadMistakeEntries 方法**

在 `loadImmuneMemories` 之后插入：

```typescript
  saveMistakeEntries(entries: MistakeEntry[]): void {
    const insert = this.db.prepare(
      'INSERT INTO mistake_entries (id, timestamp, error, context, resolution, tags_json) VALUES (?, ?, ?, ?, ?, ?)'
    )
    const tx = this.db.transaction((items: MistakeEntry[]) => {
      this.db.prepare('DELETE FROM mistake_entries').run()
      for (const e of items) {
        insert.run(e.id, e.timestamp, e.error, e.context, e.resolution, JSON.stringify(e.tags))
      }
    })
    tx(entries)
  }

  loadMistakeEntries(): MistakeEntry[] {
    const rows = this.db.prepare('SELECT * FROM mistake_entries').all() as Array<{
      id: string
      timestamp: string
      error: string
      context: string
      resolution: string
      tags_json: string
    }>
    const result: MistakeEntry[] = []
    for (const r of rows) {
      try {
        result.push({
          id: r.id,
          timestamp: r.timestamp,
          error: r.error,
          context: r.context,
          resolution: r.resolution,
          tags: JSON.parse(r.tags_json),
        })
      } catch {
        // skip corrupt row
      }
    }
    return result
  }
```

记得在文件顶部 import：

```typescript
import type { MistakeEntry } from '../agent/mistake-notebook.js'
```

- [ ] **步骤 7：跑持久化测试验证 PASS**

```bash
npx tsx --test src/agent/__tests__/mistake-persistence.test.ts
```

预期：3/3 PASS

- [ ] **步骤 8：跑 typecheck**

```bash
npx tsc --noEmit; echo "exit: $?"
```

预期：exit 0

- [ ] **步骤 9：commit 持久化实现**

```bash
git add src/repo/meridian-db.ts
git commit -m "feat(mistake): SQLite persistence for MistakeNotebook cross-session"
```

- [ ] **步骤 10：在 loop.ts 加载/保存 mistake notebook**

读 `src/agent/loop.ts` 行 298-303（包 A 加的 immune 加载块）。在它之后**插入**：

```typescript
    // Load persisted mistake entries from previous sessions
    if (meridianDb) {
      try {
        this.p3.notebook.importEntries(meridianDb.loadMistakeEntries())
      } catch { /* non-critical: missing table or corrupt data */ }
    }
```

但等一下——**`this.p3` 在这位置可能还没构造**。grep 验证：

```bash
grep -n "this.p3 =\|new P3Integration" src/agent/loop.ts
```

如果 `this.p3` 在 immuneHook 之后才构造，把 mistake load 移到 p3 构造之后。

读 `src/agent/loop.ts` 行 776-779（包 A 加的 immune 保存块）。在它之后**插入**：

```typescript
    // Persist mistake notebook for cross-session learning
    try {
      const db = this.config.meridianIndexer?.getDb()
      if (db) db.saveMistakeEntries(this.p3.notebook.getAllEntries())
    } catch { /* non-critical */ }
```

- [ ] **步骤 11：跑 typecheck**

```bash
npx tsc --noEmit; echo "exit: $?"
```

预期：exit 0

- [ ] **步骤 12：跑全量测试**

```bash
npx tsx --test 'src/agent/__tests__/mistake-*.test.ts'
npm test 2>&1 | tail -10
```

预期：mistake 测试全过；npm test 仅 startup-memory 预存失败。

- [ ] **步骤 13：grep 验证集成**

```bash
grep -n "loadMistakeEntries\|saveMistakeEntries\|importEntries" src/agent/loop.ts
```

预期：3 个匹配（1 load + 1 save + 1 importEntries 调用）。

- [ ] **步骤 14：Commit wire**

```bash
git add src/agent/loop.ts
git commit -m "feat(mistake): load+save mistake notebook at session boundaries"
```

- [ ] 🛑 **STOP** —— 任务 8 完成。报告：
  - 3 个 commit SHA
  - mistake-persistence 测试 3/3 通过
  - tsc exit 0
  - grep 验证集成存在
  - 全量测试只剩 startup-memory 预存失败

---

## 任务 9：recordRepairSuccess 接入 + cast 修正

**文件：**
- 修改：`src/agent/immune-hook.ts`（recordRepairSuccess 改签名）
- 修改：`src/agent/__tests__/immune-hook.test.ts`（更新 cast 已经写过的测试）
- 修改：`src/agent/tool-pipeline.ts`（在 mistake-detection 旁边加 immune learning）
- 创建：`src/agent/__tests__/immune-learning-wire.test.ts`

**关键架构点：**
- 当前 `recordRepairSuccess(fingerprint, strategy: string, turn)` 内部 `as ImmuneResponseType` 是包 A 时的妥协。**实际无 production caller**——可以放心改签名。
- 改签名为 `recordRepairSuccess(fingerprint, response: ImmuneResponse, turn)`——直接接受结构化对象，去掉 cast。
- production wire 点：`tool-pipeline.ts:577-590` 已检测 mistake resolution（包 mistake-notebook-wire 加的）。在那里**复用同一判断**给 immune 系统：当 `detectMistakeResolution` 返回非 null（即 failed→passed 跃迁），如果 `deps.immuneHook?` 可用，调 `recordRepairSuccess`。
- ImmuneHook 当前**没有**作为 dep 传给 tool-pipeline。需要：
  - 在 `ToolPipelineDeps` 加 `immuneHook?: ImmuneHook`
  - 在 `tool-execution.ts` 的 `ToolExecutionDeps` 加（如果需要传递）
  - 在 `loop.ts` 构造 ToolExecution 时把 `this.immuneHook` 传下去

但要注意 import cycle：immune-hook.ts 不能 import tool-pipeline.ts（应该没问题，因为 tool-pipeline 是底层）。验证：

```bash
grep -n "import.*tool-pipeline\|import.*tool-execution" src/agent/immune-hook.ts
```

预期：无匹配。

- [ ] **步骤 1：修改 recordRepairSuccess 签名**

读 `src/agent/immune-hook.ts` 行 145-155。改：

```typescript
  /** Record successful repair (called externally after repair pipeline succeeds) */
  recordRepairSuccess(fingerprint: string, response: ImmuneResponse, turn: number): void {
    this.adaptive.recordSuccess(fingerprint, response, turn)
  }
```

去掉 `as ImmuneResponseType` cast 和包装对象的代码。同时确认 `ImmuneResponse` 在文件顶部已 import（应该是的——packageA 改过）。

- [ ] **步骤 2：更新现有测试**

`src/agent/__tests__/immune-hook.test.ts` 在包 A 时 agent 改成传 `'quarantine'` 字符串。现在改回真正的对象：

```bash
grep -n "recordRepairSuccess" src/agent/__tests__/immune-hook.test.ts
```

找到调用行，把 `'quarantine'` 改成 `{ type: 'quarantine' }`。

- [ ] **步骤 3：跑 immune-hook 测试**

```bash
npx tsx --test src/agent/__tests__/immune-hook.test.ts
```

预期：全 PASS（签名改了，测试同步改）。

- [ ] **步骤 4：commit 签名修正**

```bash
git add src/agent/immune-hook.ts src/agent/__tests__/immune-hook.test.ts
git commit -m "refactor(immune): recordRepairSuccess takes ImmuneResponse instead of string"
```

- [ ] **步骤 5：编写失败的 wire 测试**

文件 `src/agent/__tests__/immune-learning-wire.test.ts`：

```typescript
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { ImmuneHook } from '../immune-hook.js'
import { PhysarumEngine } from '../../repo/physarum-engine.js'

describe('Immune learning wire — recordRepairSuccess via tool-pipeline', () => {
  it('adaptive memory grows when recordRepairSuccess is called with structured response', () => {
    const hook = new ImmuneHook({ physarum: new PhysarumEngine(null as any) })
    const fingerprint = 'bash:ls /tmp'

    assert.equal(hook.adaptive.lookup(fingerprint), null, 'memory empty initially')

    hook.recordRepairSuccess(fingerprint, {
      type: 'quarantine',
      targetFile: '/tmp/foo.ts',
      duration: 30,
    }, 5)

    const memory = hook.adaptive.lookup(fingerprint)
    assert.ok(memory, 'memory should be created')
    assert.equal(memory.response.type, 'quarantine')
    assert.equal(memory.response.targetFile, '/tmp/foo.ts')
  })

  it('hitCount accumulates across multiple successes', () => {
    const hook = new ImmuneHook({ physarum: new PhysarumEngine(null as any) })
    const fingerprint = 'edit:file.ts'

    hook.recordRepairSuccess(fingerprint, { type: 'boost_healthy' }, 1)
    hook.recordRepairSuccess(fingerprint, { type: 'boost_healthy' }, 2)
    hook.recordRepairSuccess(fingerprint, { type: 'boost_healthy' }, 3)

    const memory = hook.adaptive.lookup(fingerprint)
    assert.ok(memory)
    assert.equal(memory.hitCount, 3)
  })
})
```

- [ ] **步骤 6：跑测试验证 PASS（任务 9 步骤 1 已让 ImmuneHook 端就绪）**

```bash
npx tsx --test src/agent/__tests__/immune-learning-wire.test.ts
```

预期：2/2 PASS。**真正的红色信号是 grep tool-pipeline.ts 看 immune 是否真被 wire——稍后验证。**

- [ ] **步骤 7：commit 单元测试**

```bash
git add src/agent/__tests__/immune-learning-wire.test.ts
git commit -m "test(immune): assert adaptive learning via recordRepairSuccess"
```

- [ ] **步骤 8：把 immuneHook 加到 tool-pipeline deps**

读 `src/agent/tool-pipeline.ts` ToolPipelineDeps 接口（行 80-95 附近）。加：

```typescript
  /** Immune system hook for recording repair success (failed→passed transitions) */
  immuneHook?: import('./immune-hook.js').ImmuneHook
```

注意：使用 inline import 形式。**项目规则**：之前清理过 inline imports 引起 LSP 假阳性，但**那是因为类型实际被使用**。如果 ImmuneHook 类型只在这一处用，inline 可接受；如果担心 LSP，改成顶部 import：

```typescript
import type { ImmuneHook } from './immune-hook.js'
```

然后接口里用 `immuneHook?: ImmuneHook`。**优先选顶部 import**（与 commit `3600a9b` 的清理保持一致）。

- [ ] **步骤 9：在 tool-pipeline.ts 加 immune learning wire**

读 `src/agent/tool-pipeline.ts` 行 573-590（已有的 mistake resolution 检测）：

```typescript
    // P3-A: write path — when a tool resolves a prior failure of itself,
    // record the mistake into MistakeNotebook so getMistakeHints can find
    // it next time. Read path is already wired above (line ~558).
    if (!harnessResult.isError && deps.p3) {
      const resolution = detectMistakeResolution(traceStore, traceId, tu.name)
      if (resolution) {
        try {
          const inputDigest = JSON.stringify(tu.input).slice(0, 200)
          deps.p3.recordMistake(
            resolution.error,
            resolution.context,
            inputDigest,
            [tu.name],
          )
        } catch { /* non-critical: notebook learning is best-effort */ }
      }
    }
```

在这个 if 块的 `if (resolution) { ... }` 内部、p3.recordMistake 调用旁边，**追加**immune learning：

```typescript
        // Immune adaptive learning: record successful repair fingerprint
        if (deps.immuneHook) {
          try {
            const fingerprint = `${tu.name}:${JSON.stringify(tu.input).slice(0, 100)}`
            deps.immuneHook.recordRepairSuccess(
              fingerprint,
              { type: 'quarantine', targetFile: undefined },
              turn,
            )
          } catch { /* non-critical: immune learning is best-effort */ }
        }
```

注意：
- response 类型用 `'quarantine'` 是个**默认占位策略**。真实策略选择需要更多上下文（比如查看 immune 系统当前的 doom level、recent signals），那是更大范围的工作，超出包 D 范围。
- `turn` 变量在这个作用域可用——验证：grep 周围确认。

- [ ] **步骤 10：把 immuneHook 通过 ToolExecution 传到 tool-pipeline**

读 `src/agent/tool-execution.ts` ToolExecutionDeps 接口（行 65 附近）。加：

```typescript
  /** Immune system hook (forwarded to tool-pipeline for adaptive learning) */
  immuneHook?: import('./immune-hook.js').ImmuneHook
```

或顶部 import 形式（按之前约定）。

然后找到 `executeToolUse` 调用点（应该在 ~150 或 ~200 行），在传给 tool-pipeline 的 deps 对象里加 `immuneHook: this.deps.immuneHook`。

- [ ] **步骤 11：在 loop.ts 把 immuneHook 传给 ToolExecution**

读 `src/agent/loop.ts` 行 457（已有 `repairPipeline: this.repairPipeline`）。在那个对象（构造 ToolExecution 的 deps）里加：

```typescript
      immuneHook: this.immuneHook,
```

grep 验证位置：

```bash
grep -n "repairPipeline: this.repairPipeline" src/agent/loop.ts
```

- [ ] **步骤 12：跑 typecheck**

```bash
npx tsc --noEmit; echo "exit: $?"
```

预期：exit 0。如果有错，常见原因：
- ImmuneHook import 路径
- ToolExecutionDeps 没传给 tool-pipeline.ts 的 ToolPipelineDeps
- 顺序问题（loop.ts 构造 ToolExecution 在 immuneHook 之后？验证 line numbers）

- [ ] **步骤 13：跑全量测试**

```bash
npx tsx --test 'src/agent/__tests__/immune-*.test.ts'
npm test 2>&1 | tail -10
```

预期：immune 测试全过；npm test 仅 startup-memory 预存失败。

- [ ] **步骤 14：grep 验证集成链路**

```bash
grep -n "immuneHook" src/agent/loop.ts src/agent/tool-execution.ts src/agent/tool-pipeline.ts
```

预期至少 5 个匹配：
- loop.ts: 1+ (传给 ToolExecution)
- tool-execution.ts: 2 (deps 接口 + forward)
- tool-pipeline.ts: 2 (deps 接口 + 调用 recordRepairSuccess)

```bash
grep -n "recordRepairSuccess" src/agent/tool-pipeline.ts
```

预期：1 匹配（生产调用）。

- [ ] **步骤 15：Commit wire**

```bash
git add src/agent/tool-pipeline.ts src/agent/tool-execution.ts src/agent/loop.ts
git commit -m "feat(immune): wire recordRepairSuccess to tool-pipeline failed→passed detection"
```

- [ ] 🛑 **STOP** —— 任务 9 完成（包 D 全部完成）。报告：
  - 3 个 commit SHA（签名修正 + 单元测试 + wire）
  - immune-learning-wire 测试 2/2 通过
  - tsc exit 0
  - grep 验证至少 5 处 immuneHook 匹配 + 1 处 recordRepairSuccess 生产调用
  - 全量测试只剩 startup-memory 预存失败
  - 列出包 D 全部 6 个 commit（任务 8 的 3 个 + 任务 9 的 3 个）

---

## 包 D 自检清单（用户审查时用）

- [ ] 6 个独立 commit（不批量）
- [ ] TDD 痕迹：每任务都是先 test commit、后 impl/wire commit
- [ ] mistake_entries 表已在 meridian-db schema
- [ ] saveMistakeEntries / loadMistakeEntries 方法存在
- [ ] loop.ts 有 startup load + session-end save 真调用（grep）
- [ ] recordRepairSuccess 签名已改为 `(fingerprint, response: ImmuneResponse, turn)`
- [ ] tool-pipeline.ts 有 recordRepairSuccess 真生产调用
- [ ] `npx tsc --noEmit` exit 0
- [ ] 全量测试无新增失败

## 包 D 之外（不做）

- 改进 immune learning 的 response 选择策略（默认用 'quarantine' 占位，真实策略选择是后续工作）
- repair pipeline 的 telemetry 接入（input repair 不等于工具执行成功，是不同信号源）

如果发现包 D 修改间接破坏了别的功能（比如某测试在改 tool-pipeline 后报错），**只修该测试**，不要扩大范围。
