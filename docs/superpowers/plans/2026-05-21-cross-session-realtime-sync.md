# 跨 Session 实时状态同步 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 让多个并行 session 通过 SQLite events 表 + hook 被动注入，实时感知彼此的文件变更和接口状态，不破坏 prompt cache。

**架构：** SessionRegistry SQLite 新增 events 表（append-only），postTool hook 写入事件，preTurn hook 读取新事件并注入 dynamic appendix。启动时异步跑 tsc --noEmit 检测未接通接口。

**技术栈：** better-sqlite3 (WAL mode), TypeScript, Node.js child_process

**设计文档：** `docs/superpowers/specs/2026-05-21-cross-session-realtime-sync-design.md`

---

## 文件结构

| 文件 | 职责 |
|------|------|
| `src/agent/session-registry.ts` | 修改：新增 events 表 schema + publish/consume/cleanup 方法 |
| `src/agent/hooks/cross-session-hook.ts` | 创建：preTurn hook，读取新事件，格式化注入 |
| `src/agent/hooks/stigmergy-hook.ts` | 修改：postTool 时写入 file_changed 事件 |
| `src/agent/create-runtime-hooks.ts` | 修改：注册 cross-session-hook |
| `src/prompt/volatile.ts` | 修改：buildDynamicAppendix 接受 crossSessionEvents 参数 |
| `src/agent/loop.ts` | 修改：preTurn 阶段调用 cross-session hook |
| `src/agent/startup-health-check.ts` | 创建：启动时异步跑 tsc，结果写入 events |
| `src/agent/__tests__/session-registry-events.test.ts` | 创建：events 表的单元测试 |
| `src/agent/__tests__/cross-session-hook.test.ts` | 创建：hook 的单元测试 |
| `src/agent/__tests__/startup-health-check.test.ts` | 创建：tsc 检查的单元测试 |

---

## 任务 1：SessionRegistry 新增 events 表

**文件：**
- 修改：`src/agent/session-registry.ts`
- 测试：`src/agent/__tests__/session-registry-events.test.ts`

- [ ] **步骤 1：编写 events 表的测试**

```typescript
// src/agent/__tests__/session-registry-events.test.ts
import { test, describe, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { SessionRegistry } from '../session-registry.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

describe('SessionRegistry events', () => {
  let registry: SessionRegistry
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'reg-test-'))
    registry = new SessionRegistry(tmpDir)
  })

  afterEach(() => {
    registry.close()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  test('publishEvent inserts and consumeEvents reads', () => {
    registry.register('session-a', '/tmp', 'standalone')
    registry.publishEvent('session-a', {
      eventType: 'file_changed',
      filePath: 'src/foo.ts',
      detail: 'Modified function bar',
      priority: 0,
    })

    const events = registry.consumeEvents('session-b', 0)
    assert.equal(events.length, 1)
    assert.equal(events[0]!.sessionId, 'session-a')
    assert.equal(events[0]!.eventType, 'file_changed')
    assert.equal(events[0]!.filePath, 'src/foo.ts')
  })

  test('consumeEvents excludes own session events', () => {
    registry.register('session-a', '/tmp', 'standalone')
    registry.publishEvent('session-a', {
      eventType: 'file_changed',
      filePath: 'src/foo.ts',
      detail: 'test',
      priority: 0,
    })

    const events = registry.consumeEvents('session-a', 0)
    assert.equal(events.length, 0)
  })

  test('consumeEvents returns only events after lastSeenId', () => {
    registry.register('session-a', '/tmp', 'standalone')
    registry.publishEvent('session-a', {
      eventType: 'file_changed',
      filePath: 'src/a.ts',
      detail: 'first',
      priority: 0,
    })
    registry.publishEvent('session-a', {
      eventType: 'file_changed',
      filePath: 'src/b.ts',
      detail: 'second',
      priority: 0,
    })

    const all = registry.consumeEvents('session-b', 0)
    assert.equal(all.length, 2)

    const afterFirst = registry.consumeEvents('session-b', all[0]!.id)
    assert.equal(afterFirst.length, 1)
    assert.equal(afterFirst[0]!.filePath, 'src/b.ts')
  })

  test('cleanupOldEvents removes expired entries', () => {
    registry.register('session-a', '/tmp', 'standalone')
    registry.publishEvent('session-a', {
      eventType: 'file_changed',
      filePath: 'src/old.ts',
      detail: 'old event',
      priority: 0,
    })

    // Manually backdate the event
    registry['db'].prepare(
      "UPDATE events SET created_at = datetime('now', '-3 hours')"
    ).run()

    const removed = registry.cleanupOldEvents(2 * 60 * 60 * 1000) // 2h TTL
    assert.equal(removed, 1)

    const events = registry.consumeEvents('session-b', 0)
    assert.equal(events.length, 0)
  })

  test('priority=1 events appear first', () => {
    registry.register('session-a', '/tmp', 'standalone')
    registry.publishEvent('session-a', {
      eventType: 'file_changed',
      filePath: 'src/normal.ts',
      detail: 'normal',
      priority: 0,
    })
    registry.publishEvent('session-a', {
      eventType: 'type_error',
      filePath: 'src/urgent.ts',
      detail: 'Type error: expected 3 args',
      priority: 1,
    })

    const events = registry.consumeEvents('session-b', 0)
    assert.equal(events[0]!.priority, 1)
    assert.equal(events[0]!.filePath, 'src/urgent.ts')
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npx tsx --test src/agent/__tests__/session-registry-events.test.ts`
预期：FAIL，`publishEvent` 方法不存在

- [ ] **步骤 3：实现 events 表 schema 和方法**

在 `src/agent/session-registry.ts` 的 SCHEMA 常量中追加：

```typescript
// 在 SCHEMA 字符串末尾追加
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  file_path TEXT,
  detail TEXT,
  priority INTEGER DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id);
CREATE INDEX IF NOT EXISTS idx_events_created ON events(created_at);
```

在 `SessionRegistry` class 中新增方法：

```typescript
export interface EventInput {
  eventType: string
  filePath?: string
  detail?: string
  priority?: number
}

export interface EventRecord {
  id: number
  sessionId: string
  eventType: string
  filePath: string | null
  detail: string | null
  priority: number
  createdAt: string
}

publishEvent(sessionId: string, input: EventInput): void {
  this.db.prepare(`
    INSERT INTO events (session_id, event_type, file_path, detail, priority)
    VALUES (?, ?, ?, ?, ?)
  `).run(sessionId, input.eventType, input.filePath ?? null, input.detail ?? null, input.priority ?? 0)
}

consumeEvents(mySessionId: string, lastSeenId: number, limit = 10): EventRecord[] {
  return this.db.prepare(`
    SELECT id, session_id AS sessionId, event_type AS eventType,
           file_path AS filePath, detail, priority, created_at AS createdAt
    FROM events
    WHERE id > ? AND session_id != ?
    ORDER BY priority DESC, id ASC
    LIMIT ?
  `).all(lastSeenId, mySessionId, limit) as EventRecord[]
}

cleanupOldEvents(maxAgeMs: number): number {
  const cutoff = new Date(Date.now() - maxAgeMs).toISOString()
  const result = this.db.prepare('DELETE FROM events WHERE created_at < ?').run(cutoff)
  return result.changes
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`npx tsx --test src/agent/__tests__/session-registry-events.test.ts`
预期：5/5 PASS

- [ ] **步骤 5：Commit**

```bash
git add src/agent/session-registry.ts src/agent/__tests__/session-registry-events.test.ts
git commit -m "feat(registry): add events table for cross-session communication"
```

---

## 任务 2：postTool hook 写入事件

**文件：**
- 修改：`src/agent/hooks/stigmergy-hook.ts`
- 修改：`src/agent/__tests__/stigmergy-hook.test.ts`

- [ ] **步骤 1：扩展 StigmergyRuntimeHookDeps 接口**

在 `src/agent/hooks/stigmergy-hook.ts` 的 `StigmergyRuntimeHookDeps` 接口中新增：

```typescript
export interface StigmergyRuntimeHookDeps {
  deposit: (deposit: PheromoneDeposit) => Promise<void>
  query: () => Promise<PheromoneQueryResult[]>
  getEvidenceState: () => { verifications: Array<{ status: string }> }
  setLoadedPheromones: (pheromones: PheromoneQueryResult[]) => void
  /** 新增：发布跨 session 事件 */
  publishEvent?: (input: { eventType: string; filePath?: string; detail?: string; priority?: number }) => void
  /** 新增：当前 session ID */
  sessionId?: string
}
```

- [ ] **步骤 2：在 postTool hook 中写入 file_changed 事件**

在 `createStigmergyRuntimeHook` 的 `run` 方法中，在 pheromone deposits 之后追加：

```typescript
// Publish cross-session event for file modifications
if (deps.publishEvent && deps.sessionId) {
  if ((tool.name === 'write_file' || tool.name === 'edit_file') && tool.target && tool.success) {
    deps.publishEvent({
      eventType: 'file_changed',
      filePath: tool.target,
      detail: `Modified by session ${deps.sessionId.slice(0, 8)}`,
      priority: 0,
    })
  }
}
```

- [ ] **步骤 3：更新测试验证事件发布**

在 `src/agent/__tests__/stigmergy-hook.test.ts` 中新增测试：

```typescript
test('publishes cross-session event on file edit', async () => {
  const published: Array<{ eventType: string; filePath?: string }> = []
  const hook = createStigmergyRuntimeHook({
    ...baseDeps,
    publishEvent: (input) => { published.push(input) },
    sessionId: 'test-session-123',
  })

  await hook.run(makeCtx({ recentToolHistory: [] }), {
    name: 'edit_file',
    target: 'src/foo.ts',
    success: true,
  })

  assert.equal(published.length, 1)
  assert.equal(published[0]!.eventType, 'file_changed')
  assert.equal(published[0]!.filePath, 'src/foo.ts')
})
```

- [ ] **步骤 4：运行测试验证通过**

运行：`npx tsx --test src/agent/__tests__/stigmergy-hook.test.ts`
预期：全部 PASS

- [ ] **步骤 5：Commit**

```bash
git add src/agent/hooks/stigmergy-hook.ts src/agent/__tests__/stigmergy-hook.test.ts
git commit -m "feat(hook): publish cross-session events on file modifications"
```

---

## 任务 3：创建 cross-session preTurn hook

**文件：**
- 创建：`src/agent/hooks/cross-session-hook.ts`
- 测试：`src/agent/__tests__/cross-session-hook.test.ts`

- [ ] **步骤 1：编写 cross-session hook 测试**

```typescript
// src/agent/__tests__/cross-session-hook.test.ts
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { createCrossSessionHook, formatEventsForAppendix } from '../hooks/cross-session-hook.js'
import type { EventRecord } from '../session-registry.js'

describe('cross-session-hook', () => {
  test('formatEventsForAppendix formats events correctly', () => {
    const events: EventRecord[] = [
      { id: 1, sessionId: 'abc', eventType: 'file_changed', filePath: 'src/foo.ts', detail: 'Modified by session abc12345', priority: 0, createdAt: '2026-05-21T10:00:00Z' },
      { id: 2, sessionId: 'def', eventType: 'type_error', filePath: 'src/bar.ts', detail: 'Expected 3 args, got 2', priority: 1, createdAt: '2026-05-21T10:01:00Z' },
    ]

    const result = formatEventsForAppendix(events)
    assert.ok(result.includes('<cross-session-events>'))
    assert.ok(result.includes('src/foo.ts'))
    assert.ok(result.includes('Expected 3 args'))
    assert.ok(result.includes('</cross-session-events>'))
  })

  test('formatEventsForAppendix returns empty string for no events', () => {
    assert.equal(formatEventsForAppendix([]), '')
  })

  test('createCrossSessionHook reads events and updates state', () => {
    let lastSeenId = 0
    let appendixContent = ''
    const mockEvents: EventRecord[] = [
      { id: 5, sessionId: 'other', eventType: 'file_changed', filePath: 'src/x.ts', detail: 'test', priority: 0, createdAt: '2026-05-21T10:00:00Z' },
    ]

    const hook = createCrossSessionHook({
      consumeEvents: (sessionId, afterId) => {
        assert.equal(afterId, 0)
        return mockEvents
      },
      sessionId: 'my-session',
      setCrossSessionAppendix: (content) => { appendixContent = content },
      getLastSeenEventId: () => lastSeenId,
      setLastSeenEventId: (id) => { lastSeenId = id },
    })

    hook.run()
    assert.equal(lastSeenId, 5)
    assert.ok(appendixContent.includes('src/x.ts'))
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npx tsx --test src/agent/__tests__/cross-session-hook.test.ts`
预期：FAIL，模块不存在

- [ ] **步骤 3：实现 cross-session hook**

```typescript
// src/agent/hooks/cross-session-hook.ts
import type { EventRecord } from '../session-registry.js'

export interface CrossSessionHookDeps {
  consumeEvents: (sessionId: string, afterId: number) => EventRecord[]
  sessionId: string
  setCrossSessionAppendix: (content: string) => void
  getLastSeenEventId: () => number
  setLastSeenEventId: (id: number) => void
}

export function formatEventsForAppendix(events: EventRecord[]): string {
  if (events.length === 0) return ''

  const lines = events.map(e => {
    const prefix = e.priority >= 1 ? '[ALERT]' : '[info]'
    const file = e.filePath ? ` ${e.filePath}` : ''
    return `  ${prefix} ${e.eventType}${file}: ${e.detail ?? 'no detail'}`
  })

  return `<cross-session-events>\n${lines.join('\n')}\n</cross-session-events>`
}

export function createCrossSessionHook(deps: CrossSessionHookDeps) {
  return {
    name: 'cross-session-sync',
    run(): void {
      const lastSeen = deps.getLastSeenEventId()
      const events = deps.consumeEvents(deps.sessionId, lastSeen)

      if (events.length > 0) {
        const maxId = Math.max(...events.map(e => e.id))
        deps.setLastSeenEventId(maxId)
        deps.setCrossSessionAppendix(formatEventsForAppendix(events))
      }
    },
  }
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`npx tsx --test src/agent/__tests__/cross-session-hook.test.ts`
预期：3/3 PASS

- [ ] **步骤 5：Commit**

```bash
git add src/agent/hooks/cross-session-hook.ts src/agent/__tests__/cross-session-hook.test.ts
git commit -m "feat(hook): create cross-session preTurn hook for event consumption"
```

---

## 任务 4：集成到 agent loop + dynamic appendix

**文件：**
- 修改：`src/agent/loop.ts`
- 修改：`src/prompt/volatile.ts`
- 修改：`src/agent/create-runtime-hooks.ts`

- [ ] **步骤 1：在 volatile.ts 的 VolatileContext 中新增 crossSessionEvents 字段**

在 `src/prompt/volatile.ts` 的 `VolatileContext` interface 中追加：

```typescript
/** Cross-session events formatted for injection (cache-safe: only in dynamic appendix) */
crossSessionEvents?: string
```

- [ ] **步骤 2：在 buildDynamicAppendix 中注入 crossSessionEvents**

在 `buildDynamicAppendix` 函数中，在现有内容之后追加：

```typescript
if (ctx.crossSessionEvents) {
  parts.push(ctx.crossSessionEvents)
}
```

- [ ] **步骤 3：在 loop.ts 中初始化 cross-session hook 并在 preTurn 调用**

在 `AgentLoop` 的构造函数中（stigmergyStore 初始化附近）：

```typescript
private lastSeenEventId = 0
private crossSessionAppendix = ''
```

在 turn 开始前（`buildRequest` 调用之前），调用 hook：

```typescript
// Cross-session sync: read events from other sessions
const events = this.registry.consumeEvents(this.sessionId, this.lastSeenEventId)
if (events.length > 0) {
  this.lastSeenEventId = Math.max(...events.map(e => e.id))
  this.crossSessionAppendix = formatEventsForAppendix(events)
}
```

在传递给 PromptEngine 的 volatile context 中加入：

```typescript
crossSessionEvents: this.crossSessionAppendix,
```

- [ ] **步骤 4：在 create-runtime-hooks.ts 中传递 publishEvent 依赖**

在创建 stigmergy hook 的 deps 中追加：

```typescript
publishEvent: (input) => this.registry.publishEvent(this.sessionId, input),
sessionId: this.sessionId,
```

- [ ] **步骤 5：运行 build 验证编译通过**

运行：`npx tsup`
预期：Build success

- [ ] **步骤 6：运行全量测试**

运行：`npx tsx --test src/agent/__tests__/session-registry-events.test.ts src/agent/__tests__/cross-session-hook.test.ts src/agent/__tests__/stigmergy-hook.test.ts`
预期：全部 PASS

- [ ] **步骤 7：Commit**

```bash
git add src/agent/loop.ts src/prompt/volatile.ts src/agent/create-runtime-hooks.ts
git commit -m "feat(loop): integrate cross-session events into agent loop + dynamic appendix"
```

---

## 任务 5：启动时 tsc 健康检查（任务完成度快照）

**文件：**
- 创建：`src/agent/startup-health-check.ts`
- 测试：`src/agent/__tests__/startup-health-check.test.ts`
- 修改：`src/agent/loop.ts`（启动时调用）

- [ ] **步骤 1：编写 tsc 健康检查测试**

```typescript
// src/agent/__tests__/startup-health-check.test.ts
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { parseTypeErrors, type TypeErrorEntry } from '../startup-health-check.js'

describe('startup-health-check', () => {
  test('parseTypeErrors extracts file and message from tsc output', () => {
    const tscOutput = `src/agent/coordinator.ts(322,5): error TS2554: Expected 3 arguments, but got 2.
src/agent/work-order.ts(45,10): error TS2345: Argument of type 'string' is not assignable.`

    const errors = parseTypeErrors(tscOutput)
    assert.equal(errors.length, 2)
    assert.equal(errors[0]!.file, 'src/agent/coordinator.ts')
    assert.equal(errors[0]!.line, 322)
    assert.ok(errors[0]!.message.includes('Expected 3 arguments'))
    assert.equal(errors[1]!.file, 'src/agent/work-order.ts')
  })

  test('parseTypeErrors returns empty for clean output', () => {
    const errors = parseTypeErrors('')
    assert.equal(errors.length, 0)
  })

  test('parseTypeErrors handles malformed lines gracefully', () => {
    const tscOutput = `Some random warning
src/foo.ts(10,1): error TS1234: Real error.
Another random line`

    const errors = parseTypeErrors(tscOutput)
    assert.equal(errors.length, 1)
    assert.equal(errors[0]!.file, 'src/foo.ts')
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npx tsx --test src/agent/__tests__/startup-health-check.test.ts`
预期：FAIL，模块不存在

- [ ] **步骤 3：实现 parseTypeErrors 和 runStartupHealthCheck**

```typescript
// src/agent/startup-health-check.ts
import { spawn } from 'node:child_process'

export interface TypeErrorEntry {
  file: string
  line: number
  column: number
  code: string
  message: string
}

const TSC_ERROR_RE = /^(.+?)\((\d+),(\d+)\): error (TS\d+): (.+)$/

export function parseTypeErrors(output: string): TypeErrorEntry[] {
  const entries: TypeErrorEntry[] = []
  for (const line of output.split('\n')) {
    const match = TSC_ERROR_RE.exec(line.trim())
    if (match) {
      entries.push({
        file: match[1]!,
        line: parseInt(match[2]!, 10),
        column: parseInt(match[3]!, 10),
        code: match[4]!,
        message: match[5]!,
      })
    }
  }
  return entries
}

export interface HealthCheckDeps {
  publishEvent: (input: { eventType: string; filePath?: string; detail?: string; priority?: number }) => void
  cwd: string
}

/**
 * Run tsc --noEmit asynchronously at session startup.
 * Publishes type errors as priority=1 events for other sessions to see.
 * Non-blocking: errors in tsc execution are silently ignored.
 */
export function runStartupHealthCheck(deps: HealthCheckDeps): void {
  const child = spawn('npx', ['tsc', '--noEmit', '--pretty', 'false'], {
    cwd: deps.cwd,
    timeout: 15_000,
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  let stderr = ''
  child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
  child.stdout.on('data', (chunk: Buffer) => { stderr += chunk.toString() })

  child.on('close', (code) => {
    if (code !== 0 && stderr.length > 0) {
      const errors = parseTypeErrors(stderr)
      for (const err of errors.slice(0, 10)) { // max 10 events
        deps.publishEvent({
          eventType: 'type_error',
          filePath: err.file,
          detail: `${err.code}: ${err.message} (line ${err.line})`,
          priority: 1,
        })
      }
    }
  })

  child.on('error', () => { /* silently ignore spawn failures */ })
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`npx tsx --test src/agent/__tests__/startup-health-check.test.ts`
预期：3/3 PASS

- [ ] **步骤 5：在 loop.ts 启动阶段调用 runStartupHealthCheck**

在 `AgentLoop` 的 `start()` 或初始化方法中（session 注册之后）：

```typescript
import { runStartupHealthCheck } from './startup-health-check.js'

// After session registration, async health check (non-blocking)
runStartupHealthCheck({
  publishEvent: (input) => this.registry.publishEvent(this.sessionId, input),
  cwd: this.cwd,
})
```

- [ ] **步骤 6：运行 build 验证编译通过**

运行：`npx tsup`
预期：Build success

- [ ] **步骤 7：Commit**

```bash
git add src/agent/startup-health-check.ts src/agent/__tests__/startup-health-check.test.ts src/agent/loop.ts
git commit -m "feat(startup): async tsc health check publishes type errors as cross-session alerts"
```

---

## 任务 6：events 自动清理 + busy_timeout 配置

**文件：**
- 修改：`src/agent/session-registry.ts`
- 修改：`src/agent/loop.ts`

- [ ] **步骤 1：在 SessionRegistry 构造函数中设置 busy_timeout**

```typescript
// 在 this.db.pragma('journal_mode = WAL') 之后追加
this.db.pragma('busy_timeout = 3000')
```

- [ ] **步骤 2：在 agent loop 的 session 结束时清理过期事件**

在 `AgentLoop` 的 cleanup/shutdown 方法中：

```typescript
// Cleanup events older than 2 hours
this.registry.cleanupOldEvents(2 * 60 * 60 * 1000)
```

- [ ] **步骤 3：运行全量测试确认无回归**

运行：`npx tsx --test src/agent/__tests__/session-registry-events.test.ts src/agent/__tests__/cross-session-hook.test.ts src/agent/__tests__/startup-health-check.test.ts src/agent/__tests__/stigmergy-hook.test.ts`
预期：全部 PASS

- [ ] **步骤 4：运行 build**

运行：`npx tsup`
预期：Build success

- [ ] **步骤 5：Commit**

```bash
git add src/agent/session-registry.ts src/agent/loop.ts
git commit -m "feat(registry): add busy_timeout + auto-cleanup for events TTL"
```

---

## 自检

### 规格覆盖度

| 设计文档需求 | 对应任务 |
|-------------|---------|
| SQLite events 表 | 任务 1 |
| postTool hook 写入事件 | 任务 2 |
| preTurn hook 读取事件 | 任务 3 |
| dynamic appendix 注入（cache-safe） | 任务 4 |
| 启动时 tsc 健康检查 | 任务 5 |
| events TTL 自动清理 | 任务 6 |
| busy_timeout 防 SQLITE_BUSY | 任务 6 |
| priority=1 alarm 事件优先 | 任务 1（ORDER BY priority DESC） |

### 类型一致性

- `EventInput` / `EventRecord`：任务 1 定义，任务 2-5 消费
- `formatEventsForAppendix`：任务 3 定义，任务 4 调用
- `publishEvent` 签名：任务 1 定义 `(sessionId, input)`，任务 2 通过 deps 传递 `(input)`（loop 层绑定 sessionId）
- `consumeEvents` 签名：任务 1 定义 `(mySessionId, lastSeenId, limit?)`，任务 3/4 调用

### 占位符扫描

无 TODO、无"待定"、无"类似任务 N"。所有代码步骤都有完整代码块。
