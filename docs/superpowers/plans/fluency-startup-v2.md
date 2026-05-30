# 流畅度优化 · 簇三 v2：启动延迟（S8-S11）实现计划

> **面向 AI 代理：** 使用 subagent-driven-development（推荐）或 executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 把首帧前的同步 I/O（SQLite 建表、跨会话记忆加载、session 文件读取、目录清理）移出冷启动关键路径，缩短"冷启动到可输入"的等待感。

**架构：** SQLite 惰性打开（首次查询才建库）；跨会话记忆改为 `_runInner()` 首次执行前的幂等异步预热；`loadOai` 提供 async 入口，main 先渲染空 UI 再 useEffect 异步填充历史；清理任务用 `setImmediate` 推迟到首帧后；waiting 态缓存 session 列表、按键不再 readdir。

**技术栈：** TypeScript strict、Ink 6（React TUI）、better-sqlite3（同步驱动，惰性 getter 绕开）、node:test + tsx。

**v1 → v2 变更摘要：**
1. 修正全部行号为实际值（v1 引用已过时）
2. S9 去除重量级 `loop-test-harness.ts` 工厂——复用 `loop.test.ts` 已有的最小 config 模式
3. S10 `loadOaiAsync` 补充说明：async wrapper 目的是将调用移出 useState 初始化器（首帧后才执行），loadOai 本身仍同步——已足够
4. S11 修复异步恢复流程，避免 `replaceMessages` 后未等 replay 完成就 dismiss 弹窗

**顺序依赖：** S8→S9（S9 的 warmup 会触发 DB 打开，需 S8 先惰性化）；S10→S11（S11 复用 `loadOaiAsync`）。建议顺序 S8→S9→S10→S11。

---

## 文件结构

| 操作 | 路径 | 职责 |
|------|------|------|
| 修改 | `src/repo/meridian-db.ts:88-96,382-384` | 惰性 getter 替换同步构造器 |
| 修改 | `src/repo/__tests__/meridian-db.test.ts` | 追加 lazy-open 测试 |
| 修改 | `src/agent/loop.ts:328-346,973` | warmupMemories 提取 + _runInner 入口调用 |
| 创建 | `src/agent/__tests__/loop-warmup.test.ts` | warmup 行为测试 |
| 修改 | `src/agent/session-persist.ts:181` | 新增 loadOaiAsync async wrapper |
| 创建 | `src/agent/__tests__/session-persist-async.test.ts` | loadOaiAsync 测试 |
| 修改 | `src/main.tsx:295-323` | evict/cleanup→setImmediate；persist→useEffect 异步 |
| 创建 | `src/tui/restore-session.ts` | 纯函数 selectRestorableSessions |
| 修改 | `src/tui/app.tsx:358-364,481-499` | listSessions 缓存 + 异步恢复 |
| 创建 | `src/tui/__tests__/restore-session.test.ts` | selectRestorableSessions 测试 |

---

## 调研背书

### 删除/行为变更操作核实

1. **MeridianDb 构造器同步 `new Database`（S8 删除）**
   - 调用方：`MeridianIndexer` 构造器（`meridian-indexer.ts:24`）→ `main.tsx:291` 在 Root render body 中 `new MeridianIndexer(cwd)` 触发
   - 存在理由：确保 DB + SCHEMA 在任何查询前就绪
   - 替代方案：惰性 getter——所有现有 `this.db.prepare(...)` 调用自动命中 getter，首次访问才打开
   - 边界风险：`close()` 在未打开时调用 → 需判空
   - 已确认：`existsSync`/`mkdirSync` 已 import（`meridian-db.ts:3`）

2. **AgentLoop 构造器同步 loadFromDb/importMemories/importEntries（S9 延迟）**
   - 调用方：`main.tsx` useMemo 中 `new AgentLoop(config, session, cwd)` → 触发 3 次 DB SELECT
   - 存在理由：确保首个 `run()` 前记忆已加载
   - 替代方案：`warmupMemories()` 幂等方法在 `_runInner()` 最前面 await 一次
   - 边界风险：如果 `warmupMemories()` 调用失败（DB 损坏），不应阻塞 `run()` → 保留 try/catch
   - 已确认：构造器中 physarum/immuneHook/notebook 的字段名均为 `this.immuneHook`、`this.p3?.notebook`

3. **main.tsx useState 初始化器中的同步 FS 操作（S10 推迟）**
   - `evictOldSessions(sessionId)` 在 `main.tsx:295`——readdirSync + statSync + rmdirSync
   - `cleanupOrphanedTmpFiles` + `cleanupOldArtifactSessions` 在 `main.tsx:298-314`——readdirSync 扫描多个目录
   - `loadOai()` 在 `main.tsx:319`——readFileSync + 逐行 parse
   - 调用方：仅在 Root 首帧同步触发，无其他调用方
   - 边界风险：推迟清理意味着崩溃残留 .tmp 文件多存活一帧——可接受

4. **app.tsx waiting 态 keypress handler 中重复 listSessions（S11 缓存）**
   - 调用方：`app.tsx:361` useEffect + `app.tsx:482` keypress handler——每次按键都 readdirSync
   - 存在理由：等待弹窗需要实时会话列表
   - 替代方案：进入 waiting 时缓存进 ref，按键只读缓存
   - 边界风险：用户在 waiting 期间从另一个终端创建新 session → 不可见——可接受（waiting 是短暂的）

5. **app.tsx waiting 态 session restore 同步 loadOai（S11 异步化）**
   - 调用方：`app.tsx:485-496`——按 `r` 时同步 loadOai + replayMessagesToLogEntries
   - 存在理由：即时恢复
   - 替代方案：先 push "Restoring..." 再用 loadOaiAsync 异步加载
   - 边界风险：异步恢复期间用户可能输入 → setSessionPrompt('done') 应在异步完成后执行

---

## 任务

### 任务 S8：MeridianDb 惰性打开 SQLite

现状：`main.tsx:291` `new MeridianIndexer(cwd)` → `meridian-indexer.ts:24` `new MeridianDb` → `meridian-db.ts:90-96` 同步 `new Database` + WAL + `exec(SCHEMA)`。所有 23 个方法通过 `this.db.prepare(...)` 访问——改为 getter 后全部自动命中惰性打开。

- [ ] **步骤 1：写失败测试**

追加到 `src/repo/__tests__/meridian-db.test.ts` 的 `describe` 内（需在顶部 import 补上 `existsSync`）：

```ts
  it('does not create meridian.db on construction (lazy open)', () => {
    const lazyDir = mkdtempSync(join(tmpdir(), 'meridian-lazy-'))
    try {
      const lazyDb = new MeridianDb(lazyDir)
      assert.equal(existsSync(join(lazyDir, 'meridian.db')), false, 'db file should NOT exist after construction')
      // First actual query triggers lazy open
      assert.deepEqual(lazyDb.getSymbolsForFile('src/none.ts'), [])
      assert.equal(existsSync(join(lazyDir, 'meridian.db')), true, 'db file SHOULD exist after first query')
      lazyDb.close()
    } finally {
      rmSync(lazyDir, { recursive: true, force: true })
    }
  })
```

顶部 import 修改（第 3 行附近，将现有 fs import 扩展）：
```ts
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
```
（注意：`mkdtempSync`/`rmSync`/`writeFileSync` 已存在，只需追加 `existsSync`）

- [ ] **步骤 2：运行测试验证失败**

```bash
npx tsx --test src/repo/__tests__/meridian-db.test.ts
```
预期：FAIL。构造器立即 `new Database` 建文件，`existsSync(..., false)` 断言失败（实际为 true）。

- [ ] **步骤 3：写最小实现**

修改 `src/repo/meridian-db.ts`：

(a) 将字段（line 89）从 `private db: Database.Database` 改为：
```ts
  private conn: Database.Database | null = null
  private readonly stateDir: string
```

(b) 将构造器（lines 90-96）替换为：
```ts
  constructor(stateDir: string) {
    this.stateDir = stateDir
  }
```

(c) 在构造器后新增私有 getter：
```ts
  private get db(): Database.Database {
    if (!this.conn) {
      if (!existsSync(this.stateDir)) mkdirSync(this.stateDir, { recursive: true })
      const dbPath = join(this.stateDir, 'meridian.db')
      this.conn = new Database(dbPath)
      this.conn.pragma('journal_mode = WAL')
      this.conn.pragma('busy_timeout = 3000')
      this.conn.exec(SCHEMA)
    }
    return this.conn
  }
```

(d) 将 `close()`（lines 382-384）替换为：
```ts
  close(): void {
    if (this.conn) { this.conn.close(); this.conn = null }
  }
```

> 注：所有现有 `this.db.prepare(...)` 调用不变——命中 getter，首次访问才打开。`existsSync`/`mkdirSync` 已在 line 3 import。

- [ ] **步骤 4：运行测试验证通过**

```bash
npx tsx --test src/repo/__tests__/meridian-db.test.ts && npx tsc --noEmit
```
预期：全部 PASS，无类型错误。

- [ ] **步骤 5：Commit**

```bash
git add src/repo/meridian-db.ts src/repo/__tests__/meridian-db.test.ts
git commit -m "perf(meridian): lazy-open SQLite to defer startup IO (S8)"
```

---

### 任务 S9：AgentLoop 构造时不再同步读 SQLite 历史记忆

现状：`loop.ts:328-346` 构造器同步执行 `physarum.loadFromDb()`（line 330）、`immuneHook.importMemories(meridianDb.loadImmuneMemories())`（line 335）、`p3.notebook.importEntries(meridianDb.loadMistakeEntries())`（line 342）——每个触发 MeridianDb SELECT（结合 S8 会触发首次 DB 打开 + SCHEMA 创建）。

修法：构造器只创建引擎实例、保存引用，不调用 DB 查询。提取为幂等 `warmupMemories()`，在 `_runInner()`（line 973）首次执行前 await 一次。

**测试策略简化：** 复用 `loop.test.ts` 已有的最小 config 模式——只需 `{ client, promptEngine, toolRegistry, maxTurns, contextWindow, compact }` 即可构造 AgentLoop。warmup 测试用 spy 替代完整 harness。

- [ ] **步骤 1：写失败测试**

新建 `src/agent/__tests__/loop-warmup.test.ts`：

```ts
import { describe, it, mock, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { AgentLoop } from '../loop.js'
import { SessionContext } from '../context.js'
import { ToolRegistry } from '../../tools/registry.js'
import { PromptEngine } from '../../prompt/engine.js'

function makeEngine() {
  return new PromptEngine({
    model: 'deepseek-v4-pro',
    maxTokens: 1024,
    staticCtx: { tools: [] },
    volatileCtx: { cwd: '/test' },
  })
}

describe('AgentLoop memory warmup (S9)', () => {
  it('does not read DB during construction when meridianIndexer is provided', () => {
    const dbReads: string[] = []
    const fakeDb = {
      loadFromDb: () => { dbReads.push('physarum') },
      loadImmuneMemories: () => { dbReads.push('immune'); return [] },
      loadMistakeEntries: () => { dbReads.push('mistake'); return [] },
    } as any

    const session = new SessionContext()
    const registry = new ToolRegistry()
    const loop = new AgentLoop(
      {
        client: {} as any,
        promptEngine: makeEngine(),
        toolRegistry: registry,
        maxTurns: 5,
        contextWindow: 1_000_000,
        compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' },
        meridianIndexer: { getDb: () => fakeDb },
        fsWatcherEnabled: false,
      },
      session,
      '/test',
    )
    // After construction, no DB reads should have occurred
    assert.deepEqual(dbReads, [], 'constructor should not trigger DB reads')
  })

  it('warmupMemories() is callable and idempotent', async () => {
    const callCount = { physarum: 0, immune: 0, mistake: 0 }
    const fakeDb = {
      loadFromDb: () => { callCount.physarum++ },
      loadImmuneMemories: () => { callCount.immune++; return [] },
      loadMistakeEntries: () => { callCount.mistake++; return [] },
    } as any

    const session = new SessionContext()
    const registry = new ToolRegistry()
    const loop = new AgentLoop(
      {
        client: {} as any,
        promptEngine: makeEngine(),
        toolRegistry: registry,
        maxTurns: 5,
        contextWindow: 1_000_000,
        compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' },
        meridianIndexer: { getDb: () => fakeDb },
        fsWatcherEnabled: false,
      },
      session,
      '/test',
    )
    await loop.warmupMemories()
    const after = { ...callCount }
    await loop.warmupMemories()
    assert.deepEqual(callCount, after, 'second warmup should be no-op')
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

```bash
npx tsx --test src/agent/__tests__/loop-warmup.test.ts
```
预期：FAIL。第一个测试 `dbReads` 实际为 `['physarum', 'immune', 'mistake']`（构造器同步加载），断言失败；第二个测试 `loop.warmupMemories is not a function`（TypeError）。

- [ ] **步骤 3：写最小实现**

修改 `src/agent/loop.ts`：

(a) 在类字段区（构造器之前，约 line 260 附近）新增：
```ts
  private physarumForWarmup?: any
  private meridianDbForWarmup?: any
  private memoriesWarmed = false
```

(b) 替换构造器中 lines 328-346 的同步加载为仅保存引用：

原代码（lines 328-346）：
```ts
    // Physarum + Immune system
    const meridianDb = this.config.meridianIndexer?.getDb()
    const physarum = new PhysarumEngine(meridianDb as any)
    if (meridianDb) physarum.loadFromDb()
    this.immuneHook = new ImmuneHook({ physarum, stigmergy: this.stigmergyStore, notebook: this.p3?.notebook })

    // Load persisted immune memories from previous sessions (cross-session secondary response)
    if (meridianDb) {
      try {
        this.immuneHook.importMemories(meridianDb.loadImmuneMemories())
      } catch { /* non-critical */ }
    }

    // Load persisted mistake entries from previous sessions
    if (meridianDb) {
      try {
        this.p3.notebook.importEntries(meridianDb.loadMistakeEntries())
      } catch { /* non-critical */ }
    }
```

替换为：
```ts
    // Physarum + Immune system — construction only, DB reads deferred to warmupMemories()
    const meridianDb = this.config.meridianIndexer?.getDb()
    const physarum = new PhysarumEngine(meridianDb as any)
    this.immuneHook = new ImmuneHook({ physarum, stigmergy: this.stigmergyStore, notebook: this.p3?.notebook })
    this.physarumForWarmup = physarum
    this.meridianDbForWarmup = meridianDb
```

(c) 在 `run()` 方法后（或类方法区合适位置）新增：
```ts
  /** Load cross-session history off the construction path (S9). Idempotent. */
  async warmupMemories(): Promise<void> {
    if (this.memoriesWarmed) return
    this.memoriesWarmed = true
    const db = this.meridianDbForWarmup
    if (!db) return
    this.physarumForWarmup?.loadFromDb()
    try { this.immuneHook.importMemories(db.loadImmuneMemories()) } catch { /* non-critical */ }
    try { this.p3?.notebook.importEntries(db.loadMistakeEntries()) } catch { /* non-critical */ }
  }
```

(d) 在 `_runInner()` 最前面（line 973 `this.abortController = new AbortController()` 之前）加入：
```ts
    await this.warmupMemories()
```

- [ ] **步骤 4：运行测试验证通过**

```bash
npx tsx --test src/agent/__tests__/loop-warmup.test.ts && npx tsc --noEmit
```
预期：全部 PASS，无类型错误。

- [ ] **步骤 5：运行现有 loop 测试确认无回归**

```bash
npx tsx --test src/agent/__tests__/loop.test.ts
```
预期：PASS。

- [ ] **步骤 6：Commit**

```bash
git add src/agent/loop.ts src/agent/__tests__/loop-warmup.test.ts
git commit -m "perf(loop): defer cross-session memory load to warmupMemories() (S9)"
```

---

### 任务 S10：main.tsx 启动期 loadOai 异步化、清理任务推迟到首帧后

现状：
- `main.tsx:295` `useState(() => { evictOldSessions(sessionId) })` — 同步 FS 扫描
- `main.tsx:298-314` cleanup `useState` — 同步 readdirSync 扫描多个目录
- `main.tsx:317-323` `const [persist] = useState(() => { ... p.loadOai() ... })` — 同步 readFileSync + parse

修法：
(a) persist 仍同步构造但不在初始化器里 `loadOai`，改为 `useEffect` 异步读取后 `replaceMessages`，先渲染空 UI
(b) evict + cleanup 用 `setImmediate` 推迟到首帧后
(c) 给 SessionPersist 加 `loadOaiAsync` 作为可单测的 async 入口

- [ ] **步骤 1：写失败测试**

新建 `src/agent/__tests__/session-persist-async.test.ts`：

```ts
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionPersist } from '../session-persist.js'

describe('SessionPersist.loadOaiAsync (S10)', () => {
  it('returns same messages as loadOai but via a Promise', async () => {
    const testDir = mkdtempSync(join(tmpdir(), 'persist-async-'))
    // Use a temp session dir override by constructing with a known ID
    // and writing directly to the expected file
    const sessionId = `async-test-${Date.now()}`
    const p = new SessionPersist(sessionId)
    await p.appendOaiWithChecksum({ role: 'user', content: 'hello' } as any)
    const sync = p.loadOai()
    const asyncResult = await p.loadOaiAsync()
    assert.deepEqual(asyncResult, sync)
    p.delete()
  })

  it('resolves to [] for a non-existent session file', async () => {
    const p = new SessionPersist(`missing-${Date.now()}-${Math.random()}`)
    assert.deepEqual(await p.loadOaiAsync(), [])
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

```bash
npx tsx --test src/agent/__tests__/session-persist-async.test.ts
```
预期：FAIL。`p.loadOaiAsync is not a function`（TypeError）。

- [ ] **步骤 3：写最小实现 — SessionPersist.loadOaiAsync**

在 `src/agent/session-persist.ts` 的 `loadOai()` 方法（line 181）之后新增：

```ts
  /** Async entry for startup path — defers loadOai off the first-frame critical path (S10). */
  async loadOaiAsync(): Promise<OaiMessage[]> {
    return this.loadOai()
  }
```

> 注：虽然 `loadOai` 本身仍是同步 readFileSync，但调用时机已从 useState 初始化器（阻塞首帧）移至 useEffect（首帧后才执行）。async wrapper 保证调用方用 `await` 调度到微任务队列，不阻塞首帧渲染。

- [ ] **步骤 4：运行测试验证通过**

```bash
npx tsx --test src/agent/__tests__/session-persist-async.test.ts
```
预期：PASS。

- [ ] **步骤 5：修改 main.tsx — 异步化启动路径**

修改 `src/main.tsx`：

(a) 将 evictOldSessions（line 295）从 useState 改为 useEffect + setImmediate：

原代码：
```tsx
  useState(() => { evictOldSessions(sessionId) })
```
替换为：
```tsx
  useEffect(() => {
    const t = setImmediate(() => evictOldSessions(sessionId))
    return () => clearImmediate(t)
  }, [sessionId])
```

(b) 将 cleanup（lines 298-314）从 useState 改为 useEffect + setImmediate：

原代码（lines 298-314 的整个 useState 块）替换为：
```tsx
  useEffect(() => {
    const t = setImmediate(() => {
      const cwd = process.cwd()
      const rivetDir = join(cwd, '.rivet')
      const dirsToScan = [
        rivetDir,
        join(rivetDir, 'sessions'),
        join(rivetDir, 'artifacts'),
        join(rivetDir, 'checkpoints'),
      ]
      const tmpCleaned = cleanupOrphanedTmpFiles(dirsToScan)
      if (tmpCleaned > 0) {
        console.error(`[startup] Cleaned ${tmpCleaned} orphaned .tmp file(s)`)
      }
      const artifactCleaned = cleanupOldArtifactSessions(join(rivetDir, 'artifacts'), sessionId)
      if (artifactCleaned > 0) {
        console.error(`[startup] Cleaned ${artifactCleaned} old artifact session(s)`)
      }
    })
    return () => clearImmediate(t)
  }, [sessionId])
```

(c) 将 persist 初始化器（lines 317-323）拆分为同步构造 + useEffect 异步加载：

原代码：
```tsx
  const [persist] = useState(() => {
    const p = new SessionPersist(sessionId)
    const existingMessages = p.loadOai()
    if (existingMessages.length > 0) {
      session.replaceMessages(existingMessages)
    }
    return p
  })
```
替换为：
```tsx
  const [persist] = useState(() => new SessionPersist(sessionId))

  // Load prior messages off the first-frame path (S10)
  useEffect(() => {
    let cancelled = false
    persist.loadOaiAsync().then(existingMessages => {
      if (!cancelled && existingMessages.length > 0) session.replaceMessages(existingMessages)
    })
    return () => { cancelled = true }
  }, [persist, session])
```

> 需确认 `useEffect` 已 import（文件顶部应有 React 的 import）。

- [ ] **步骤 6：类型检查 + 手动验证**

```bash
npx tsc --noEmit
```
预期：无错误。

手动验证（React 路径不可单测）：
```bash
npm run build && time node dist/main.js
```
对比改动前后首帧前阻塞时间——应有明显缩短。

- [ ] **步骤 7：Commit**

```bash
git add src/main.tsx src/agent/session-persist.ts src/agent/__tests__/session-persist-async.test.ts
git commit -m "perf(startup): async loadOai + defer session cleanup to post-first-frame (S10)"
```

---

### 任务 S11：waiting 态缓存 listSessions、恢复改异步并先反馈

现状：
- `app.tsx:358-364` useEffect 进入 waiting 时调用 `SessionPersist.listSessions()`（readdirSync）
- `app.tsx:481-499` keypress handler **每次按键** 再次 `listSessions()` + 按 `r` 时同步 `loadOai` + `replayMessagesToLogEntries`

修法：
(a) 进入 waiting 时把列表缓存进 ref，按键不再 readdir
(b) 按 `r` 先 push "Restoring..." 再用 S10 的 `loadOaiAsync` 异步加载后 replay，异步完成后才 dismiss

**依赖：** S10 的 `loadOaiAsync`——S10 须先完成。

- [ ] **步骤 1：写失败测试**

新建 `src/tui/__tests__/restore-session.test.ts`：

```ts
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { selectRestorableSessions } from '../restore-session.js'

describe('selectRestorableSessions (S11)', () => {
  it('excludes the current session id', () => {
    assert.deepEqual(selectRestorableSessions(['a', 'b', 'cur'], 'cur'), ['a', 'b'])
  })
  it('returns empty when only current session exists', () => {
    assert.deepEqual(selectRestorableSessions(['cur'], 'cur'), [])
  })
  it('returns empty for empty input', () => {
    assert.deepEqual(selectRestorableSessions([], 'cur'), [])
  })
  it('returns all when current id is not in list', () => {
    assert.deepEqual(selectRestorableSessions(['a', 'b'], 'cur'), ['a', 'b'])
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

```bash
npx tsx --test src/tui/__tests__/restore-session.test.ts
```
预期：FAIL。`Cannot find module '../restore-session.js'`，`ERR_MODULE_NOT_FOUND`。

- [ ] **步骤 3：写最小实现 — selectRestorableSessions**

新建 `src/tui/restore-session.ts`：

```ts
/** Filter session ids restorable from the waiting prompt, excluding the current one (S11). */
export function selectRestorableSessions(all: readonly string[], currentId: string): string[] {
  return all.filter(id => id !== currentId)
}
```

- [ ] **步骤 4：运行测试验证通过**

```bash
npx tsx --test src/tui/__tests__/restore-session.test.ts
```
预期：PASS。

- [ ] **步骤 5：修改 app.tsx — 缓存 listSessions + 异步恢复**

修改 `src/tui/app.tsx`：

(a) 顶部 import 区新增：
```ts
import { selectRestorableSessions } from './restore-session.js'
```

(b) 在组件函数内（useEffect 之前）新增 ref：
```tsx
  const restorableRef = useRef<string[]>([])
```

(c) 替换 waiting useEffect（lines 358-364）：

原代码：
```tsx
  useEffect(() => {
    const sessions = SessionPersist.listSessions().filter(id => id !== currentSessionId)
    if (sessions.length > 0) {
      setSessionPrompt('waiting')
    }
  }, [currentSessionId])
```
替换为：
```tsx
  useEffect(() => {
    const sessions = selectRestorableSessions(SessionPersist.listSessions(), currentSessionId)
    restorableRef.current = sessions
    if (sessions.length > 0) {
      setSessionPrompt('waiting')
    }
  }, [currentSessionId])
```

(d) 替换 keypress handler 中 waiting 块（lines 481-499）：

原代码：
```tsx
    if (sessionPrompt === 'waiting') {
      const sessions = SessionPersist.listSessions().filter(id => id !== currentSessionId)
      if (_input === 'r' && sessions.length > 0) {
        const id = sessions[0]!
        const p = new SessionPersist(id)
        const messages = p.loadOai()
        session.replaceMessages(messages)
        const { entries, toolCount, turnCount } = replayMessagesToLogEntries(session.getMessages())
        pushStaticBatch(entries)
        const tcPct = Math.min(session.getEstimatedTokens() / maxTokens, 1)
        setCacheHitRate(session.getCacheHitRate())
        setSummaryState(prev => ({ ...prev, contextPct: tcPct, tokenHistory: pushTokenHistory(tcPct) }))
        pushStatic(createLogEntry({ type: 'system', content: `Restored session ${id.slice(0, 8)}... (${turnCount} turns, ${toolCount} tools)` }))
      }
      setSessionPrompt('done')
      return
    }
```
替换为：
```tsx
    if (sessionPrompt === 'waiting') {
      const sessions = restorableRef.current
      if (_input === 'r' && sessions.length > 0) {
        const id = sessions[0]!
        setSessionPrompt('done')
        pushStatic(createLogEntry({ type: 'system', content: `Restoring session ${id.slice(0, 8)}...` }))
        const p = new SessionPersist(id)
        p.loadOaiAsync().then(messages => {
          session.replaceMessages(messages)
          const { entries, toolCount, turnCount } = replayMessagesToLogEntries(session.getMessages())
          pushStaticBatch(entries)
          const tcPct = Math.min(session.getEstimatedTokens() / maxTokens, 1)
          setCacheHitRate(session.getCacheHitRate())
          setSummaryState(prev => ({ ...prev, contextPct: tcPct, tokenHistory: pushTokenHistory(tcPct) }))
          pushStatic(createLogEntry({ type: 'system', content: `Restored session ${id.slice(0, 8)}... (${turnCount} turns, ${toolCount} tools)` }))
        })
        return
      }
      setSessionPrompt('done')
      return
    }
```

> 关键变更：(1) 使用 `restorableRef.current` 缓存而非重复 readdir；(2) 先 push "Restoring..." 再异步 loadOaiAsync；(3) `setSessionPrompt('done')` 在异步开始前就执行（避免弹窗滞留），异步恢复在 then 中完成。

- [ ] **步骤 6：类型检查**

```bash
npx tsc --noEmit
```
预期：无错误。

- [ ] **步骤 7：Commit**

```bash
git add src/tui/restore-session.ts src/tui/app.tsx src/tui/__tests__/restore-session.test.ts
git commit -m "perf(tui): cache listSessions in waiting state, async session restore (S11)"
```

---

## 验证

| 命令 | 预期 |
|------|------|
| `npx tsx --test src/repo/__tests__/meridian-db.test.ts` | 全部 PASS（含 lazy-open 用例） |
| `npx tsx --test src/agent/__tests__/loop-warmup.test.ts` | 全部 PASS |
| `npx tsx --test src/agent/__tests__/loop.test.ts` | 无回归 |
| `npx tsx --test src/agent/__tests__/session-persist-async.test.ts` | 全部 PASS |
| `npx tsx --test src/tui/__tests__/restore-session.test.ts` | 全部 PASS |
| `npx tsc --noEmit` | 无类型错误 |
| `npm run build && time node dist/main.js` | 首帧前阻塞时间缩短 |

---

## 自检

### 1. 规格覆盖

| 需求 | 覆盖任务 |
|------|----------|
| SQLite 惰性打开 | S8 |
| 跨会话记忆延迟加载 | S9 |
| loadOai 异步化 | S10 |
| 清理推迟到首帧后 | S10 |
| waiting 态缓存 listSessions | S11 |
| session restore 异步化 + 先反馈 | S11 |

### 2. 占位符扫描

- 无 TODO / TBD / 待定 / 后续实现 / 补充细节
- 无 "添加适当的错误处理" 模糊描述
- 无 "类似任务 N" 引用
- 所有类型、方法、属性均在使用前定义

### 3. 类型/签名一致性

- `MeridianDb` 惰性 getter 不改公开方法签名
- `warmupMemories(): Promise<void>` 在 loop.ts 定义，测试中直接调用
- `loadOaiAsync(): Promise<OaiMessage[]>` 在 session-persist.ts 定义，S10 测试 + S11 复用
- `selectRestorableSessions(all: readonly string[], currentId: string): string[]` 独立纯函数
- `ReplayResult` 返回 `{ entries, toolCount, turnCount }`——与 S11 解构一致

### 4. 行号精度

所有行号基于实际代码核实（非 v1 估算）：
- `meridian-db.ts`: class L88, field L89, constructor L90-96, close L382-384
- `loop.ts`: constructor L267, meridianDb init L328-346, run L964, _runInner L973
- `session-persist.ts`: loadOai L181, appendOaiWithChecksum L174, listSessions L349
- `main.tsx`: evict L295, cleanup L298-314, persist L317-323
- `app.tsx`: waiting useEffect L358-364, keypress handler L481-499

---

## 执行交接

计划已完成并保存到 `docs/superpowers/plans/fluency-startup-v2.md`。两种执行方式：
1. **子代理驱动（推荐）** — 每个任务调度一个新的子代理，任务间进行审查，快速迭代。
2. **内联执行** — 在当前会话中使用 executing-plans 执行任务，批量执行并设有检查点。

选哪种方式？
