# 流畅度优化 · 簇三：启动延迟（S8-S11）实现计划

> **状态：✅ 已全部实施** — Fluency startup 策略 (fluency-policy.ts)

**目标：** 把首帧前的同步 I/O（SQLite 建表、跨会话记忆加载、session 文件读取、目录清理）移出冷启动关键路径，缩短"冷启动到可输入"的等待感。

**架构：** SQLite 惰性打开（首次查询才建库）；跨会话记忆改为 `run()` 前的幂等异步预热；`loadOai` 提供异步入口，main 先渲染空 UI 再填充历史；清理任务用 `setImmediate` 推迟到首帧后；waiting 态缓存 session 列表、按键不再 readdir。

**技术栈：** TypeScript、Ink、better-sqlite3（同步）、node:test + tsx。测试命令 `npx tsx --test <file>`，类型检查 `npm run typecheck`。

**顺序依赖：** S10 新增 `SessionPersist.loadOaiAsync()`，S11 复用它——S10 必须先于 S11。S8（MeridianDb 惰性）应先于 S9（记忆预热），因 S9 的加载会触发 DB 打开。建议顺序 S8→S9→S10→S11。

**已核实的现状：** `meridian-db.ts:89` `private db`、`:91-94` 构造器同步 `new Database`+WAL+SCHEMA、`:381-382` `close()`；`loop.ts:958` `run()` 是 async；`SessionPersist` 的 OAI 追加写方法是 `appendOaiWithChecksum`（**无 `appendOai`**）；项目**无** `loop-test-harness`/AgentLoop config 工厂（S9 需先建最小 harness）。

---

### 任务 S8：MeridianDb 惰性打开 SQLite，使构造不触发 Database/WAL/SCHEMA

现状：`main.tsx:346` `new MeridianIndexer(cwd)` 在 Root render body 同步执行 → `meridian-indexer.ts:24` `new MeridianDb` → `meridian-db.ts:91-94` 同步 `new Database` + WAL + `exec(SCHEMA)`（~10 表）。`MeridianBehavior` 仅持引用、不在构造时碰 DB，故惰性安全。

**文件：**
- 修改：`src/repo/meridian-db.ts`（字段 89、构造器 91-98、close 381-382、内部 `this.db` 引用）
- 测试：`src/repo/__tests__/meridian-db.test.ts`（追加 lazy-open 用例）

- [ ] **步骤 1：写失败测试**

追加到 `src/repo/__tests__/meridian-db.test.ts` 的 `describe` 内，并把顶部 import 补上 `existsSync`（将现有 `import { mkdtempSync, rmSync } from 'node:fs'` 改为 `import { mkdtempSync, rmSync, existsSync } from 'node:fs'`）：

```ts
  it('does not create meridian.db on construction (lazy open)', () => {
    const lazyDir = mkdtempSync(join(tmpdir(), 'meridian-lazy-'))
    const lazyDb = new MeridianDb(lazyDir)
    assert.equal(existsSync(join(lazyDir, 'meridian.db')), false)
    assert.deepEqual(lazyDb.getSymbolsForFile('src/none.ts'), [])
    assert.equal(existsSync(join(lazyDir, 'meridian.db')), true)
    lazyDb.close()
    rmSync(lazyDir, { recursive: true, force: true })
  })
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npx tsx --test src/repo/__tests__/meridian-db.test.ts`
预期：FAIL。构造器立即 `new Database` 建文件，第一个 `assert.equal(existsSync(...), false)` 抛 `AssertionError`（实际 true）。

- [ ] **步骤 3：写最小实现**

`src/repo/meridian-db.ts` 替换字段（89）与构造器（91-98）为惰性 getter：

```ts
export class MeridianDb {
  private conn: Database.Database | null = null
  private readonly stateDir: string

  constructor(stateDir: string) {
    this.stateDir = stateDir
  }

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

所有现有 `this.db.prepare(...)` 调用不变（现命中 getter，首次访问才打开）。`close()`（381-382）改为：

```ts
  close(): void {
    if (this.conn) { this.conn.close(); this.conn = null }
  }
```

> 执行前核实：原构造器实际用的 pragma/路径拼接（上面的 `busy_timeout`、`mkdirSync` 守卫以现有构造器为准抄入 getter，保持行为一致）；确认 `existsSync`/`mkdirSync` 已 import。

- [ ] **步骤 4：运行测试验证通过**

运行：`npx tsx --test src/repo/__tests__/meridian-db.test.ts && npm run typecheck`
预期：PASS。

- [ ] **步骤 5：Commit**

```bash
git add src/repo/meridian-db.ts src/repo/__tests__/meridian-db.test.ts
git commit -m "perf(meridian): lazy-open SQLite to defer startup IO (S8)"
```

### 任务 S9：AgentLoop 构造时不再同步读 SQLite 历史记忆

现状：`loop.ts:319-336` 构造器同步执行 `physarum.loadFromDb()`、`importMemories(loadImmuneMemories())`、`importEntries(loadMistakeEntries())`，每个触发 MeridianDb SELECT（结合 S8 会触发首次 DB 打开）。修法：提取为幂等 `warmupMemories()`，在 `run()`（958，已 async）首次执行前 await 一次。

> ⚠️ **本任务最重**：项目**无** `loop-test-harness` 或 AgentLoop config 工厂（已确认）。步骤 1 需**先建**一个最小 harness `src/agent/__tests__/loop-test-harness.ts`，导出 `makeTestLoopConfig(overrides)`，按 `loop.ts` 构造器实际读取的 `this.config.*` 字段补齐（toolRegistry、contextWindow、providerProfile、sessionDir、meridianIndexer 等）。这需要先通读构造器确定必填字段——执行者请预留时间。

**文件：**
- 创建：`src/agent/__tests__/loop-test-harness.ts`（最小 config 工厂）
- 修改：`src/agent/loop.ts`（构造器 318-336、新增字段与 `warmupMemories()`、`run()` 入口）
- 测试：`src/agent/__tests__/loop-warmup.test.ts`（新建）

- [ ] **步骤 1：写失败测试**

新建 `src/agent/__tests__/loop-warmup.test.ts`：

```ts
import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { AgentLoop } from '../loop.js'
import { makeTestLoopConfig } from './loop-test-harness.js'

describe('AgentLoop memory warmup (S9)', () => {
  let calls: string[]
  let fakeDb: any
  beforeEach(() => {
    calls = []
    fakeDb = {
      loadFromDb: () => { calls.push('physarum') },
      loadImmuneMemories: () => { calls.push('immune'); return [] },
      loadMistakeEntries: () => { calls.push('mistake'); return [] },
    }
  })
  it('does not read SQLite history during construction', () => {
    new AgentLoop(makeTestLoopConfig({ meridianIndexer: { getDb: () => fakeDb } }))
    assert.deepEqual(calls, [])
  })
  it('loads history when warmupMemories() is called', async () => {
    const loop = new AgentLoop(makeTestLoopConfig({ meridianIndexer: { getDb: () => fakeDb } }))
    await loop.warmupMemories()
    assert.ok(calls.includes('immune'))
    assert.ok(calls.includes('mistake'))
  })
  it('warmupMemories is idempotent', async () => {
    const loop = new AgentLoop(makeTestLoopConfig({ meridianIndexer: { getDb: () => fakeDb } }))
    await loop.warmupMemories()
    const after = calls.length
    await loop.warmupMemories()
    assert.equal(calls.length, after)
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npx tsx --test src/agent/__tests__/loop-warmup.test.ts`
预期：FAIL。第一用例 `calls` 实际为 `['physarum','immune','mistake']`（构造器同步加载），`AssertionError`；且 `loop.warmupMemories is not a function`。

- [ ] **步骤 3：写最小实现**

`src/agent/loop.ts` 构造器 318-336 替换为仅构造引擎、延迟保存：

```ts
    const meridianDb = this.config.meridianIndexer?.getDb()
    const physarum = new PhysarumEngine(meridianDb as any)
    this.immuneHook = new ImmuneHook({ physarum, stigmergy: this.stigmergyStore, notebook: this.p3?.notebook })
    this.physarumForWarmup = physarum
    this.meridianDbForWarmup = meridianDb
```

类字段区新增：

```ts
  private physarumForWarmup?: PhysarumEngine
  private meridianDbForWarmup?: ReturnType<MeridianIndexer['getDb']>
  private memoriesWarmed = false
```

`run()` 之前新增方法：

```ts
  /** Load cross-session history off the construction path (S9). Idempotent. */
  async warmupMemories(): Promise<void> {
    if (this.memoriesWarmed) return
    this.memoriesWarmed = true
    const db = this.meridianDbForWarmup
    if (!db) return
    this.physarumForWarmup?.loadFromDb()
    try { this.immuneHook.importMemories(db.loadImmuneMemories()) } catch { /* non-critical */ }
    try { this.p3.notebook.importEntries(db.loadMistakeEntries()) } catch { /* non-critical */ }
  }
```

在 `run()`（958）方法体最前面加：`await this.warmupMemories()`。

> 执行前核实：构造器里 `physarum`/`immuneHook`/`p3.notebook` 的真实字段名与上面一致；`importMemories`/`importEntries` 的真实方法名（以现有构造器调用为准）。

- [ ] **步骤 4：运行测试验证通过**

运行：`npx tsx --test src/agent/__tests__/loop-warmup.test.ts && npm run typecheck`
预期：PASS。

- [ ] **步骤 5：Commit**

```bash
git add src/agent/loop.ts src/agent/__tests__/loop-warmup.test.ts src/agent/__tests__/loop-test-harness.ts
git commit -m "perf(loop): defer cross-session memory load to warmupMemories() (S9)"
```

### 任务 S10：main.tsx 启动期 loadOai 异步化、清理任务推迟到首帧后

现状：`main.tsx:295` `useState(() => evictOldSessions(...))`（readdirSync+statSync）、`298-315` cleanup（readdirSync）、`317-324` `loadOai()`（readFileSync+逐行 parse）全部在 `useState` 初始化器中同步跑在首帧前。修法：(a) `persist` 仍同步构造但不在初始化器里 `loadOai`，改为 `useEffect` 异步读取后 `replaceMessages`，先渲染空 UI；(b) evict + cleanup 用 `setImmediate` 推迟到首帧后。给 `SessionPersist` 加异步入口 `loadOaiAsync` 作为可单测的缝。

**文件：**
- 修改：`src/agent/session-persist.ts`（`loadOai` 180-200 之后新增 `loadOaiAsync`）
- 修改：`src/main.tsx`（295、298-315、317-324）
- 测试：`src/agent/__tests__/session-persist-async.test.ts`（新建）

- [ ] **步骤 1：写失败测试**

新建 `src/agent/__tests__/session-persist-async.test.ts`（注意：OAI 追加写真实方法是 `appendOaiWithChecksum`，**非** `appendOai`）：

```ts
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { SessionPersist } from '../session-persist.js'

describe('SessionPersist.loadOaiAsync (S10)', () => {
  it('returns same messages as loadOai but via a Promise', async () => {
    const p = new SessionPersist(`async-${Date.now()}`)
    await p.appendOaiWithChecksum({ role: 'user', content: 'hello' } as any)
    const sync = p.loadOai()
    const asyncResult = await p.loadOaiAsync()
    assert.deepEqual(asyncResult, sync)
  })

  it('resolves to [] for a non-existent session file', async () => {
    const p = new SessionPersist(`missing-${Date.now()}-${Math.random()}`)
    assert.deepEqual(await p.loadOaiAsync(), [])
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npx tsx --test src/agent/__tests__/session-persist-async.test.ts`
预期：FAIL。`p.loadOaiAsync is not a function`（TypeError）。

- [ ] **步骤 3：写最小实现**

`src/agent/session-persist.ts` 在 `loadOai()`（181）之后新增（复用同步实现以保证读取语义一致——DeepSeek prefix cache 约束要求消息内容稳定，这里只移调用时机）：

```ts
  /** Async entry for startup path — runs loadOai off the first-frame critical path (S10). */
  async loadOaiAsync(): Promise<OaiMessage[]> {
    return this.loadOai()
  }
```

`src/main.tsx`：
- 把 317-324 初始化器里的 `loadOai`/`replaceMessages` 删除，保留同步构造 persist，改为 useEffect 异步填充：

```ts
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

- 把 295 与 298-315 的两个清理初始化器改为一个 `useEffect` 内 `setImmediate` 推迟（cleanup body 原样搬入，保留 console.error）：

```ts
  useEffect(() => {
    const t = setImmediate(() => {
      evictOldSessions(sessionId)
      // tmp + artifact cleanup body 原样搬入此处
    })
    return () => clearImmediate(t)
  }, [])
```

- [ ] **步骤 4：运行测试验证通过**

运行：`npx tsx --test src/agent/__tests__/session-persist-async.test.ts && npm run typecheck`
预期：PASS。
手动验证（React 路径不可单测）：`npm run build && time node dist/main.js` 对比改动前后首帧前阻塞时间。

- [ ] **步骤 5：Commit**

```bash
git add src/main.tsx src/agent/session-persist.ts src/agent/__tests__/session-persist-async.test.ts
git commit -m "perf(startup): async loadOai + defer session cleanup to post-first-frame (S10)"
```

---

### 任务 S11：waiting 态缓存 listSessions、恢复改异步并先反馈

现状：`app.tsx:481-494` waiting 态下**每次按键**都 `SessionPersist.listSessions()`（readdirSync）；按 `r` 时同步 `new SessionPersist + loadOai + replayMessagesToLogEntries`。`useEffect`（360-365）进入时已调过一次 listSessions。修法：(a) 进入 waiting 时把列表缓存进 ref，按键不再 readdir；(b) 按 `r` 先 push "Restoring..." 再用 S10 的 `loadOaiAsync` 异步加载后 replay。抽纯函数 `selectRestorableSessions(all, currentId)` 做可单测的过滤缝。

**依赖：** 复用 S10 的 `SessionPersist.loadOaiAsync`——S10 须先完成。

**文件：**
- 创建：`src/tui/restore-session.ts`（纯函数 `selectRestorableSessions`）
- 修改：`src/tui/app.tsx`（360-365 缓存列表；481-494 用缓存 + 异步恢复）
- 测试：`src/tui/__tests__/restore-session.test.ts`（新建）

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
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npx tsx --test src/tui/__tests__/restore-session.test.ts`
预期：FAIL。`Cannot find module '../restore-session.js'`，`ERR_MODULE_NOT_FOUND`。

- [ ] **步骤 3：写最小实现**

新建 `src/tui/restore-session.ts`：

```ts
/** Filter session ids restorable from the waiting prompt, excluding the current one (S11). */
export function selectRestorableSessions(all: readonly string[], currentId: string): string[] {
  return all.filter(id => id !== currentId)
}
```

`src/tui/app.tsx` 进入 waiting 时缓存列表（360-365 的 useEffect 内）：

```ts
  const restorableRef = useRef<string[]>([])
  useEffect(() => {
    restorableRef.current = selectRestorableSessions(SessionPersist.listSessions(), currentSessionId)
    if (restorableRef.current.length > 0) setSessionPrompt('waiting')
  }, [currentSessionId])
```

481-494 改用缓存 + 异步恢复（先反馈再 replay）：

```ts
    if (sessionPrompt === 'waiting') {
      const sessions = restorableRef.current
      if (_input === 'r' && sessions.length > 0) {
        const id = sessions[0]!
        pushStatic(createLogEntry({ type: 'system', content: `Restoring session ${id.slice(0, 8)}...` }))
        const p = new SessionPersist(id)
        p.loadOaiAsync().then(messages => {
          session.replaceMessages(messages)
          const { entries } = replayMessagesToLogEntries(session.getMessages())
          entries.forEach(e => pushStatic(e))
        })
      }
      setSessionPrompt('done')
      return
    }
```

并在 app.tsx 顶部 import：`import { selectRestorableSessions } from './restore-session.js'`。

> 执行前核实：`replayMessagesToLogEntries` 的真实返回结构（草稿用了 `{ entries, toolCount, turnCount }`，以实际签名为准）；waiting useEffect 是否已存在（合并而非新增）。

- [ ] **步骤 4：运行测试验证通过**

运行：`npx tsx --test src/tui/__tests__/restore-session.test.ts && npm run typecheck`
预期：PASS。

- [ ] **步骤 5：Commit**

```bash
git add src/tui/restore-session.ts src/tui/app.tsx src/tui/__tests__/restore-session.test.ts
git commit -m "perf(tui): cache listSessions in waiting state, async session restore (S11)"
```

---

## 自检结果

- **覆盖度：** S8（SQLite 惰性）、S9（记忆预热）、S10（loadOai 异步 + 清理推迟）、S11（waiting 缓存 + 异步恢复）四任务齐全。
- **类型一致性：** `MeridianDb` 惰性 getter 不改公开方法签名；`warmupMemories()` 幂等；`loadOaiAsync(): Promise<OaiMessage[]>` 在 S10 定义、S11 复用一致；`selectRestorableSessions(all, currentId)` 独立。
- **顺序依赖：** S8→S9（S9 加载触发 DB 打开）；S10→S11（S11 复用 `loadOaiAsync`）。
- **已修正：** S10 测试用真实方法 `appendOaiWithChecksum`（草稿误写 `appendOai`，已确认不存在）。
- **执行前需建/核实：** S9 需先建 `loop-test-harness.ts`（项目无现成 config 工厂）；S9 的 `physarum`/`immuneHook`/`importMemories`/`importEntries` 真实字段名；`replayMessagesToLogEntries` 返回结构。
- **已知约束：** main.tsx 的 React 启动路径不可单测，S10 用 `loadOaiAsync` 缝单测 + 手动启动计时验证。

