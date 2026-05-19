# 多会话并发 Phase 1：Session Registry + File Claim 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 替换全局单实例锁为 SQLite session 注册表 + 文件级 claim，允许同一项目目录的多个 Rivet 实例并行运行

**架构：** 使用 `better-sqlite3`（同步 API，WAL 模式）作为跨进程共享状态。每个 Rivet 实例启动时向 registry 注册 session（含 PID + heartbeat），写文件前检查 claim。旧的 `LWTGuard` 被新的 `SessionRegistry` 替代，保留崩溃检测能力。

**技术栈：** Node.js 22, TypeScript strict, better-sqlite3 (WAL mode), node:test + node:assert/strict

**设计文档：** `docs/superpowers/specs/2026-05-19-multi-session-orchestration-design.md`

---

## 文件结构

| 文件 | 职责 | 操作 |
|------|------|------|
| `src/agent/session-registry.ts` | SQLite session 注册 + 心跳 + 崩溃检测 + claim 管理 | 创建 |
| `src/agent/__tests__/session-registry.test.ts` | SessionRegistry 全部测试 | 创建 |
| `src/main.tsx` | 替换 LWTGuard 为 SessionRegistry | 修改 |
| `package.json` | 添加 better-sqlite3 依赖 | 修改 |

---

### 任务 1：添加 better-sqlite3 依赖

**文件：**
- 修改：`package.json`

- [ ] **步骤 1：安装 better-sqlite3**

```bash
npm install better-sqlite3
npm install -D @types/better-sqlite3
```

- [ ] **步骤 2：验证安装**

运行：`node -e "require('better-sqlite3')"`
预期：EXIT 0，无报错

- [ ] **步骤 3：验证类型**

运行：`npx tsc --noEmit`
预期：EXIT 0

- [ ] **步骤 4：Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: add better-sqlite3 for cross-process session registry"
```

---

### 任务 2：实现 SessionRegistry 核心（注册 + 心跳 + 崩溃检测）

**文件：**
- 创建：`src/agent/session-registry.ts`
- 创建：`src/agent/__tests__/session-registry.test.ts`

- [ ] **步骤 1：编写 session 注册测试**

```typescript
// src/agent/__tests__/session-registry.test.ts
import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { SessionRegistry } from '../session-registry.js'

describe('SessionRegistry', () => {
  let dbDir: string
  let registry: SessionRegistry

  beforeEach(() => {
    dbDir = mkdtempSync(join(tmpdir(), 'sr-test-'))
    registry = new SessionRegistry(dbDir)
  })

  afterEach(() => {
    registry.close()
    rmSync(dbDir, { recursive: true, force: true })
  })

  describe('register', () => {
    it('registers a session with pid and cwd', () => {
      registry.register('sess-1', '/project')
      const sessions = registry.listActive()
      assert.equal(sessions.length, 1)
      assert.equal(sessions[0].id, 'sess-1')
      assert.equal(sessions[0].pid, process.pid)
      assert.equal(sessions[0].cwd, '/project')
    })

    it('allows multiple sessions in same cwd', () => {
      registry.register('sess-1', '/project')
      // Simulate another process by inserting directly
      registry.registerExternal('sess-2', 99998, '/project')
      const sessions = registry.listActive()
      assert.equal(sessions.length, 2)
    })
  })

  describe('heartbeat', () => {
    it('updates heartbeat timestamp', () => {
      registry.register('sess-1', '/project')
      const before = registry.listActive()[0].heartbeatAt
      // Small delay to ensure timestamp differs
      registry.heartbeat('sess-1')
      const after = registry.listActive()[0].heartbeatAt
      assert.ok(after >= before)
    })
  })

  describe('unregister', () => {
    it('removes session from registry', () => {
      registry.register('sess-1', '/project')
      registry.unregister('sess-1')
      assert.equal(registry.listActive().length, 0)
    })
  })

  describe('detectCrashedSessions', () => {
    it('returns sessions whose pid is not running', () => {
      registry.registerExternal('dead-sess', 99999, '/project')
      const crashed = registry.detectCrashedSessions()
      assert.equal(crashed.length, 1)
      assert.equal(crashed[0].id, 'dead-sess')
    })

    it('does not return sessions whose pid is alive', () => {
      registry.register('alive-sess', '/project')
      const crashed = registry.detectCrashedSessions()
      assert.equal(crashed.length, 0)
    })
  })

  describe('reapStale', () => {
    it('removes crashed sessions and returns their ids', () => {
      registry.registerExternal('dead-sess', 99999, '/project')
      const reaped = registry.reapStale()
      assert.deepEqual(reaped, ['dead-sess'])
      assert.equal(registry.listActive().length, 0)
    })
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npx tsx --test src/agent/__tests__/session-registry.test.ts`
预期：FAIL — Cannot find module '../session-registry.js'

- [ ] **步骤 3：实现 SessionRegistry**

```typescript
// src/agent/session-registry.ts
import Database from 'better-sqlite3'
import { join } from 'node:path'
import { mkdirSync } from 'node:fs'

export interface SessionRecord {
  id: string
  pid: number
  cwd: string
  startedAt: string
  heartbeatAt: string
}

export class SessionRegistry {
  private db: Database.Database

  constructor(stateDir: string) {
    mkdirSync(stateDir, { recursive: true })
    this.db = new Database(join(stateDir, 'registry.db'))
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('busy_timeout = 3000')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        pid INTEGER NOT NULL,
        cwd TEXT NOT NULL,
        started_at TEXT NOT NULL,
        heartbeat_at TEXT NOT NULL
      )
    `)
  }

  register(sessionId: string, cwd: string): void {
    const now = new Date().toISOString()
    this.db.prepare(`
      INSERT OR REPLACE INTO sessions (id, pid, cwd, started_at, heartbeat_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(sessionId, process.pid, cwd, now, now)
  }

  registerExternal(sessionId: string, pid: number, cwd: string): void {
    const now = new Date().toISOString()
    this.db.prepare(`
      INSERT OR REPLACE INTO sessions (id, pid, cwd, started_at, heartbeat_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(sessionId, pid, cwd, now, now)
  }

  heartbeat(sessionId: string): void {
    this.db.prepare(`
      UPDATE sessions SET heartbeat_at = ? WHERE id = ?
    `).run(new Date().toISOString(), sessionId)
  }

  unregister(sessionId: string): void {
    this.db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId)
  }

  listActive(): SessionRecord[] {
    return this.db.prepare('SELECT id, pid, cwd, started_at as startedAt, heartbeat_at as heartbeatAt FROM sessions').all() as SessionRecord[]
  }

  detectCrashedSessions(): SessionRecord[] {
    return this.listActive().filter(s => !this.isProcessRunning(s.pid))
  }

  reapStale(): string[] {
    const crashed = this.detectCrashedSessions()
    if (crashed.length === 0) return []
    const ids = crashed.map(s => s.id)
    const placeholders = ids.map(() => '?').join(',')
    this.db.prepare(`DELETE FROM sessions WHERE id IN (${placeholders})`).run(...ids)
    return ids
  }

  close(): void {
    this.db.close()
  }

  private isProcessRunning(pid: number): boolean {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`npx tsx --test src/agent/__tests__/session-registry.test.ts`
预期：全部 PASS

- [ ] **步骤 5：Commit**

```bash
git add src/agent/session-registry.ts src/agent/__tests__/session-registry.test.ts
git commit -m "feat(agent): add SessionRegistry with SQLite WAL for multi-instance support"
```

---

### 任务 3：实现文件 Claim 管理

**文件：**
- 修改：`src/agent/session-registry.ts`
- 修改：`src/agent/__tests__/session-registry.test.ts`

- [ ] **步骤 1：编写 claim 测试**

在 `src/agent/__tests__/session-registry.test.ts` 末尾追加：

```typescript
  describe('claims', () => {
    it('acquires exclusive claim on unclaimed file', () => {
      registry.register('sess-1', '/project')
      const result = registry.acquireClaim('sess-1', 'src/foo.ts', 'exclusive')
      assert.equal(result, true)
    })

    it('rejects exclusive claim on already-claimed file', () => {
      registry.register('sess-1', '/project')
      registry.register('sess-2', '/project')
      registry.acquireClaim('sess-1', 'src/foo.ts', 'exclusive')
      const result = registry.acquireClaim('sess-2', 'src/foo.ts', 'exclusive')
      assert.equal(result, false)
    })

    it('allows same session to re-claim its own file', () => {
      registry.register('sess-1', '/project')
      registry.acquireClaim('sess-1', 'src/foo.ts', 'exclusive')
      const result = registry.acquireClaim('sess-1', 'src/foo.ts', 'exclusive')
      assert.equal(result, true)
    })

    it('releases claim', () => {
      registry.register('sess-1', '/project')
      registry.acquireClaim('sess-1', 'src/foo.ts', 'exclusive')
      registry.releaseClaim('sess-1', 'src/foo.ts')
      registry.register('sess-2', '/project')
      const result = registry.acquireClaim('sess-2', 'src/foo.ts', 'exclusive')
      assert.equal(result, true)
    })

    it('releases all claims when session unregisters', () => {
      registry.register('sess-1', '/project')
      registry.acquireClaim('sess-1', 'src/a.ts', 'exclusive')
      registry.acquireClaim('sess-1', 'src/b.ts', 'exclusive')
      registry.unregister('sess-1')
      registry.register('sess-2', '/project')
      assert.equal(registry.acquireClaim('sess-2', 'src/a.ts', 'exclusive'), true)
      assert.equal(registry.acquireClaim('sess-2', 'src/b.ts', 'exclusive'), true)
    })

    it('allows multiple shared_read claims on same file', () => {
      registry.register('sess-1', '/project')
      registry.register('sess-2', '/project')
      assert.equal(registry.acquireClaim('sess-1', 'src/foo.ts', 'shared_read'), true)
      assert.equal(registry.acquireClaim('sess-2', 'src/foo.ts', 'shared_read'), true)
    })

    it('rejects exclusive claim when shared_read exists from other session', () => {
      registry.register('sess-1', '/project')
      registry.register('sess-2', '/project')
      registry.acquireClaim('sess-1', 'src/foo.ts', 'shared_read')
      const result = registry.acquireClaim('sess-2', 'src/foo.ts', 'exclusive')
      assert.equal(result, false)
    })

    it('getClaimHolder returns session holding exclusive claim', () => {
      registry.register('sess-1', '/project')
      registry.acquireClaim('sess-1', 'src/foo.ts', 'exclusive')
      assert.equal(registry.getClaimHolder('src/foo.ts'), 'sess-1')
    })

    it('getClaimHolder returns null for unclaimed file', () => {
      assert.equal(registry.getClaimHolder('src/foo.ts'), null)
    })

    it('reapStale also removes claims of crashed sessions', () => {
      registry.registerExternal('dead', 99999, '/project')
      registry.acquireClaim('dead', 'src/foo.ts', 'exclusive')
      registry.reapStale()
      assert.equal(registry.getClaimHolder('src/foo.ts'), null)
    })
  })
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npx tsx --test src/agent/__tests__/session-registry.test.ts`
预期：FAIL — registry.acquireClaim is not a function

- [ ] **步骤 3：实现 Claim 管理**

在 `src/agent/session-registry.ts` 的 constructor 中追加建表：

```typescript
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS claims (
        session_id TEXT NOT NULL,
        file_path TEXT NOT NULL,
        claim_type TEXT NOT NULL CHECK(claim_type IN ('exclusive','shared_read')),
        acquired_at TEXT NOT NULL,
        PRIMARY KEY(session_id, file_path)
      )
    `)
```

在 `SessionRegistry` 类中追加方法：

```typescript
  acquireClaim(sessionId: string, filePath: string, claimType: 'exclusive' | 'shared_read'): boolean {
    const existing = this.db.prepare(
      'SELECT session_id, claim_type FROM claims WHERE file_path = ?'
    ).all(filePath) as Array<{ session_id: string; claim_type: string }>

    if (claimType === 'exclusive') {
      const otherClaims = existing.filter(c => c.session_id !== sessionId)
      if (otherClaims.length > 0) return false
    } else {
      const exclusiveOther = existing.find(c => c.session_id !== sessionId && c.claim_type === 'exclusive')
      if (exclusiveOther) return false
    }

    this.db.prepare(`
      INSERT OR REPLACE INTO claims (session_id, file_path, claim_type, acquired_at)
      VALUES (?, ?, ?, ?)
    `).run(sessionId, filePath, claimType, new Date().toISOString())
    return true
  }

  releaseClaim(sessionId: string, filePath: string): void {
    this.db.prepare('DELETE FROM claims WHERE session_id = ? AND file_path = ?').run(sessionId, filePath)
  }

  getClaimHolder(filePath: string): string | null {
    const row = this.db.prepare(
      "SELECT session_id FROM claims WHERE file_path = ? AND claim_type = 'exclusive'"
    ).get(filePath) as { session_id: string } | undefined
    return row?.session_id ?? null
  }
```

修改 `unregister` 方法，追加 claim 清理：

```typescript
  unregister(sessionId: string): void {
    this.db.prepare('DELETE FROM claims WHERE session_id = ?').run(sessionId)
    this.db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId)
  }
```

修改 `reapStale` 方法，在删除 session 前先删除 claims：

```typescript
  reapStale(): string[] {
    const crashed = this.detectCrashedSessions()
    if (crashed.length === 0) return []
    const ids = crashed.map(s => s.id)
    const placeholders = ids.map(() => '?').join(',')
    this.db.prepare(`DELETE FROM claims WHERE session_id IN (${placeholders})`).run(...ids)
    this.db.prepare(`DELETE FROM sessions WHERE id IN (${placeholders})`).run(...ids)
    return ids
  }
```

- [ ] **步骤 4：运行测试验证通过**

运行：`npx tsx --test src/agent/__tests__/session-registry.test.ts`
预期：全部 PASS

- [ ] **步骤 5：Commit**

```bash
git add src/agent/session-registry.ts src/agent/__tests__/session-registry.test.ts
git commit -m "feat(agent): add file claim management to SessionRegistry"
```

---

### 任务 4：替换 main.tsx 中的 LWTGuard

**文件：**
- 修改：`src/main.tsx`

- [ ] **步骤 1：替换 import**

将 `src/main.tsx:39` 的：
```typescript
import { LWTGuard } from './agent/lwt-guard.js'
```
替换为：
```typescript
import { SessionRegistry } from './agent/session-registry.js'
```

- [ ] **步骤 2：替换初始化逻辑**

将 `src/main.tsx:700-745`（LWTGuard 相关代码块）替换为：

```typescript
  // Session Registry: 多实例共存 + 崩溃检测
  const stateDir = join(homedir(), '.rivet', 'state')
  const registry = new SessionRegistry(stateDir)

  // 清理崩溃的 session
  const reaped = registry.reapStale()
  if (reaped.length > 0) {
    console.log(`\n🔄 检测到 ${reaped.length} 个异常退出的会话，已清理`)
  }

  // 检查是否有可恢复的崩溃会话（检查 alive 文件兼容旧逻辑）
  const crashedSessionId = reaped[0] ?? null
  if (crashedSessionId) {
    try {
      const persist = new SessionPersist(crashedSessionId)
      const { messages, usedSnapshot, snapshotTurn, hadIncompleteCompact } = persist.loadRecoverableMessages()

      if (hadIncompleteCompact) {
        console.log('   ⚠️  检测到 incomplete compact，已从快照恢复')
      }

      if (usedSnapshot && snapshotTurn !== undefined) {
        console.log(`   📸 使用快照恢复到 turn ${snapshotTurn}`)
      }

      console.log(`   ✅ 恢复完成：${messages.length} 条消息\n`)
      registry.register(crashedSessionId, process.cwd())
    } catch (err) {
      console.error(`   ❌ 恢复失败: ${(err as Error).message}`)
      console.log('   启动新会话...')
      const sessionId = getOrCreateSessionId()
      registry.register(sessionId, process.cwd())
    }
  } else {
    const sessionId = getOrCreateSessionId()
    registry.register(sessionId, process.cwd())
  }

  // 心跳定时器
  const heartbeatInterval = setInterval(() => {
    try { registry.heartbeat(getOrCreateSessionId()) } catch { /* ignore */ }
  }, 10_000)

  // 退出时清理
  process.on('exit', () => {
    clearInterval(heartbeatInterval)
    try {
      registry.unregister(getOrCreateSessionId())
      registry.close()
    } catch { /* ignore during exit */ }
  })
```

- [ ] **步骤 3：移除旧的 exit handler**

删除 `src/main.tsx` 中旧的：
```typescript
  process.on('exit', () => {
    lwtGuard.releaseLock()
  })
```
（已被上面新代码中的 exit handler 替代）

- [ ] **步骤 4：typecheck**

运行：`npx tsc --noEmit`
预期：EXIT 0

- [ ] **步骤 5：运行相关测试**

运行：`npx tsx --test src/agent/__tests__/session-registry.test.ts`
预期：全部 PASS

- [ ] **步骤 6：Commit**

```bash
git add src/main.tsx
git commit -m "feat: replace global lock with SQLite session registry for multi-instance support"
```

---

### 任务 5：接入工具执行链路（Claim 门控）

**文件：**
- 修改：`src/agent/tool-pipeline.ts`
- 修改：`src/agent/tool-execution.ts`（传递 registry 到 deps）

**前置调查：** `ToolPipelineDeps` 需要新增 `sessionRegistry?: SessionRegistry` 字段。写工具（`write_file`、`edit_file`、`git`、`bash`）执行前自动 acquire claim，执行后保持 claim 直到 session 结束。

- [ ] **步骤 1：在 ToolPipelineDeps 中添加 registry 字段**

在 `src/agent/tool-pipeline.ts` 的 `ToolPipelineDeps` interface 中追加：

```typescript
  sessionRegistry?: import('./session-registry.js').SessionRegistry
```

- [ ] **步骤 2：在 tool-execution.ts 中传递 registry**

在 `src/agent/tool-execution.ts` 构建 `pipelineDeps` 对象时，从上层传入 `sessionRegistry`。具体位置需 grep `pipelineDeps:` 确认。

- [ ] **步骤 3：在 executeToolUse 中添加 claim 门控**

在 `src/agent/tool-pipeline.ts` 的 `executeToolUse` 函数中，在 `execute` 回调之前（约 line 240 附近），添加 claim 检查：

```typescript
    // Claim gate: acquire file claim for non-concurrency-safe tools
    const isSafe = toolDef?.isConcurrencySafe() ?? true
    if (!isSafe && deps.sessionRegistry && deps.sessionId) {
      const filePath = tu.input.file_path as string | undefined
      if (filePath) {
        const acquired = deps.sessionRegistry.acquireClaim(deps.sessionId, filePath, 'exclusive')
        if (!acquired) {
          const holder = deps.sessionRegistry.getClaimHolder(filePath)
          return {
            toolResult: { type: 'tool_result', tool_use_id: tu.id, content: `Error: File "${filePath}" is being edited by another session (${holder}). Wait for it to finish or use a different file.`, is_error: true },
            traceStore: deps.traceStore,
            importGraph: deps.importGraph,
            lastConflictCheckCount: deps.lastConflictCheckCount,
            checkpointCreated: false,
            latestRisk: deps.latestRisk,
          }
        }
      }
    }
```

注意：此代码插入在 `const harnessResult = await deps.harness.executeTool({` 之前。

- [ ] **步骤 4：typecheck**

运行：`npx tsc --noEmit`
预期：EXIT 0

- [ ] **步骤 5：运行 tool-pipeline 相关测试**

运行：`npx tsx --test src/agent/__tests__/tool-pipeline*.test.ts`
预期：全部 PASS（现有测试不传 sessionRegistry，所以 claim 门控不触发）

- [ ] **步骤 6：Commit**

```bash
git add src/agent/tool-pipeline.ts src/agent/tool-execution.ts
git commit -m "feat(agent): wire file claim check into tool execution pipeline"
```

---

### 任务 6：集成验证

- [ ] **步骤 1：全量 typecheck**

运行：`npx tsc --noEmit`
预期：EXIT 0

- [ ] **步骤 2：运行 agent 相关测试**

运行：`npx tsx --test src/agent/__tests__/*.test.ts`
预期：全部 PASS（lwt-guard.test.ts 仍然独立可通过，因为 LWTGuard 类未被删除）

- [ ] **步骤 3：全量测试**

运行：`npx tsx --test 'src/**/__tests__/*.test.ts'`
预期：全部 PASS

- [ ] **步骤 4：手动验证多实例**

在两个终端中分别启动 Rivet：
```bash
# Terminal 1
node dist/main.js

# Terminal 2 (同一目录)
node dist/main.js
```
预期：两个实例都成功启动，无 "另一个实例正在运行" 报错。

验证 SQLite 数据库：
```bash
sqlite3 ~/.rivet/state/registry.db "SELECT id, pid, cwd FROM sessions"
```
预期：显示两条 session 记录。

- [ ] **步骤 5：验证退出清理**

在 Terminal 2 中退出 Rivet (Ctrl+C)：
```bash
sqlite3 ~/.rivet/state/registry.db "SELECT id, pid, cwd FROM sessions"
```
预期：只剩 Terminal 1 的 session。

- [ ] **步骤 6：验证崩溃检测**

在 Terminal 1 中 `kill -9` Rivet 进程，然后重新启动：
预期：启动时显示 "检测到 1 个异常退出的会话，已清理"。

---

## 设计要求覆盖矩阵（追溯补充）

> 2026-05-19 补充：基于 workflow iteration 教训，回查设计文档成功标准并映射到计划任务。

| 设计文档要求 | 对应计划任务 | 状态 | 备注 |
|-------------|-------------|------|------|
| 实现 ClaimRegistry 类（acquire/release/check/reap_stale） | Task 3 | ✅ | 已实现，包含在 SessionRegistry 中 |
| **现有 DelegationCoordinator 的 hands worker 使用 claim 检查** | ~~缺失~~ → 补充 commit a5afe29 | ✅ | 原计划遗漏，已追溯补充 |
| 允许多 Rivet 实例同时运行（各自注册，claim 互斥） | Task 4 | ✅ | main.tsx 已替换 LWTGuard |
| SQLite WAL 模式 | Task 1 + Task 2 | ✅ | better-sqlite3 + WAL pragma |
| 崩溃检测（PID 探测） | Task 2 | ✅ | detectCrashedSessions + reap |

**教训**：原计划覆盖了 4/5 条设计要求，遗漏了"hands worker 使用 claim 棚查"这条。原因是 Worker 生成计划时没有逐条对照设计文档的成功标准。后续计划文档必须包含此矩阵。

---

## 注意事项

- `LWTGuard` 类和测试**不删除**——保持向后兼容，避免破坏其他可能的引用
- `better-sqlite3` 是 native addon，需要 Node.js 22 兼容的预编译二进制
- SQLite WAL 模式在 APFS (macOS) 和 ext4 (Linux) 上完全支持
- 心跳间隔 10s，stale 检测阈值依赖 `isProcessRunning`（PID 探测），不依赖时间
- Phase 2 将在此基础上添加 Unix socket IPC 和依赖通知
