# 终端会话高可用与高稳定性 实施计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 实现两层会话高可用——LWT 遗嘱自动恢复 + WAL 校验和数据完整性保障

**架构：** Phase 1 创建 alive 标记机制，异常退出后自动调用 recovery-trigger 决策恢复会话；Phase 2 给 JSONL 追加行级 CRC32 校验和 + compact 操作的 fuzzy checkpoint 标记，确保半写入和 compact 中途崩溃均可恢复

**技术栈：** TypeScript, Node.js test runner, 现有 session-persist / recovery-trigger / fs-atomic 基础设施

---

## 文件结构

| 文件 | 职责 | 变更类型 |
|------|------|----------|
| `src/agent/lwt-guard.ts` | alive 标记管理 + 异常退出检测 | 新建 |
| `src/agent/__tests__/lwt-guard.test.ts` | LWT 守卫测试 | 新建 |
| `src/agent/session-persist.ts` | 会话持久化，添加校验和读写 | 修改 |
| `src/agent/__tests__/session-persist.test.ts` | 持久化校验和测试 | 修改 |
| `src/main.tsx` | 入口点，接入 LWT 检查 | 修改 |
| `src/fs-atomic.ts` | 原子写入（已有） | 不变 |

---

### 任务 1：LWT 守卫 — alive 标记管理

**文件：**
- 创建：`src/agent/lwt-guard.ts`
- 创建：`src/agent/__tests__/lwt-guard.test.ts`

- [ ] **步骤 1：编写 LWT 守卫模块**

在 `src/agent/lwt-guard.ts` 中：

```typescript
import { existsSync, writeFileSync, unlinkSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { writeFileAtomicSync } from '../fs-atomic.js'

export interface LWTGuardConfig {
  /** Directory for the alive marker file */
  stateDir: string
  /** Session ID to track (empty = no session active) */
  sessionId: string
}

const ALIVE_FILE = 'agent.alive'
const PID_FILE = 'agent.pid'

export class LWTGuard {
  private alivePath: string
  private pidPath: string
  private registered = false

  constructor(private config: LWTGuardConfig) {
    mkdirSync(config.stateDir, { recursive: true })
    this.alivePath = join(config.stateDir, ALIVE_FILE)
    this.pidPath = join(config.stateDir, PID_FILE)
  }

  /**
   * Check if the previous run exited abnormally.
   * Returns the session ID of the crashed session, or null.
   */
  checkPreviousCrash(): string | null {
    if (!existsSync(this.alivePath)) return null
    try {
      const data = JSON.parse(
        require('node:fs').readFileSync(this.alivePath, 'utf-8'),
      ) as { sessionId: string; pid: number; startedAt: string }
      // If the PID file exists and matches a running process, it's not a crash
      // (another instance might be running)
      if (existsSync(this.pidPath)) {
        const pid = parseInt(
          require('node:fs').readFileSync(this.pidPath, 'utf-8'),
          10,
        )
        if (pid && this.isProcessRunning(pid)) return null
      }
      return data.sessionId || null
    } catch {
      // Corrupted alive file — treat as potential crash
      return null
    }
  }

  /**
   * Register alive marker for this session.
   * Call when a session starts running.
   */
  register(sessionId: string): void {
    if (this.registered) return
    this.registered = true

    writeFileAtomicSync(
      this.alivePath,
      JSON.stringify({
        sessionId,
        pid: process.pid,
        startedAt: new Date().toISOString(),
      }),
    )

    writeFileSync(this.pidPath, String(process.pid))

    // Clear the marker on normal exit
    const clear = () => this.clear()
    process.on('exit', clear)
    process.on('SIGINT', () => { this.clear(); process.exit(0) })
    process.on('SIGTERM', () => { this.clear(); process.exit(0) })
  }

  /**
   * Clear the alive marker (normal exit).
   */
  clear(): void {
    try { unlinkSync(this.alivePath) } catch { /* already cleared */ }
    try { unlinkSync(this.pidPath) } catch { /* already cleared */ }
    this.registered = false
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

- [ ] **步骤 2：编写 LWT 测试**

在 `src/agent/__tests__/lwt-guard.test.ts` 中：

```typescript
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { LWTGuard } from '../lwt-guard.js'

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'lwt-test-'))
}

test('checkPreviousCrash returns null when no alive file', () => {
  const dir = makeTempDir()
  try {
    const guard = new LWTGuard({ stateDir: dir, sessionId: '' })
    assert.equal(guard.checkPreviousCrash(), null)
  } finally {
    rmSync(dir, { recursive: true })
  }
})

test('register creates alive file, clear removes it', () => {
  const dir = makeTempDir()
  try {
    const guard = new LWTGuard({ stateDir: dir, sessionId: 's1' })
    guard.register('s1')
    assert.ok(existsSync(join(dir, 'agent.alive')))
    guard.clear()
    assert.ok(!existsSync(join(dir, 'agent.alive')))
  } finally {
    rmSync(dir, { recursive: true })
  }
})

test('checkPreviousCrash returns sessionId when alive file exists (simulated crash)', () => {
  const dir = makeTempDir()
  try {
    // Simulate crash: write alive file without registering (so no exit handler clears it)
    writeFileSync(join(dir, 'agent.alive'), JSON.stringify({
      sessionId: 'crashed-session',
      pid: 99999,
      startedAt: new Date().toISOString(),
    }))

    const guard = new LWTGuard({ stateDir: dir, sessionId: '' })
    const crashed = guard.checkPreviousCrash()
    assert.equal(crashed, 'crashed-session')
  } finally {
    rmSync(dir, { recursive: true })
  }
})

test('checkPreviousCrash returns null after clear', () => {
  const dir = makeTempDir()
  try {
    const guard = new LWTGuard({ stateDir: dir, sessionId: 's2' })
    guard.register('s2')
    guard.clear()
    assert.equal(guard.checkPreviousCrash(), null)
  } finally {
    rmSync(dir, { recursive: true })
  }
})

test('checkPreviousCrash returns null for corrupted alive file', () => {
  const dir = makeTempDir()
  try {
    writeFileSync(join(dir, 'agent.alive'), 'not json{')
    const guard = new LWTGuard({ stateDir: dir, sessionId: '' })
    assert.equal(guard.checkPreviousCrash(), null)
  } finally {
    rmSync(dir, { recursive: true })
  }
})
```

- [ ] **步骤 3：运行测试验证通过**

运行：`npm test -- src/agent/__tests__/lwt-guard.test.ts`
预期：全部 PASS

- [ ] **步骤 4：Commit**

```bash
git add src/agent/lwt-guard.ts src/agent/__tests__/lwt-guard.test.ts
git commit -m "feat(agent): add LWT guard for crash detection via alive marker"
```

---

### 任务 2：接入 LWT 到主入口

**文件：**
- 修改：`src/main.tsx`

- [ ] **步骤 1：在 main.tsx 中接入 LWT 检查**

在 `src/main.tsx` 的启动流程中，在创建 session 之前添加 LWT 检查。

找到 session 创建的位置（通常在 CLI 参数解析之后），在创建 App 组件之前添加：

```typescript
import { LWTGuard } from './agent/lwt-guard.js'

// After CLI args parsed, before App creation:
const stateDir = join(process.cwd(), '.rivet')
const lwtGuard = new LWTGuard({ stateDir, sessionId: '' })

const crashedSessionId = lwtGuard.checkPreviousCrash()
if (crashedSessionId) {
  // Auto-resume: pass crashedSessionId to the App as initialSession
  // The App's session restore logic will handle loading and validation
}
```

具体接入方式取决于 `src/main.tsx` 的当前结构。需要：
1. 创建 `LWTGuard` 实例
2. 检查 `checkPreviousCrash()`
3. 如果有崩溃的 session，将其 ID 传给 App 作为自动恢复目标
4. 当 session 开始运行时调用 `lwtGuard.register(sessionId)`

- [ ] **步骤 2：运行 typecheck**

运行：`npm run typecheck`
预期：无错误

- [ ] **步骤 3：Commit**

```bash
git add src/main.tsx
git commit -m "feat: integrate LWT guard into main entry for auto-recovery"
```

---

### 任务 3：JSONL 行级 CRC32 校验和

**文件：**
- 修改：`src/agent/session-persist.ts`
- 修改：`src/agent/__tests__/session-persist.test.ts`（如果存在）

- [ ] **步骤 1：添加校验和工具函数**

在 `src/agent/session-persist.ts` 中添加校验和函数：

```typescript
// CRC32 lookup table (polynomial 0xEDB88320)
const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let j = 0; j < 8; j++) {
      c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1)
    }
    table[i] = c
  }
  return table
})()

function crc32(str: string): number {
  let crc = 0xFFFFFFFF
  for (let i = 0; i < str.length; i++) {
    crc = CRC_TABLE[(crc ^ str.charCodeAt(i)) & 0xFF]! ^ (crc >>> 8)
  }
  return (crc ^ 0xFFFFFFFF) >>> 0
}

export function appendChecksum(line: string): string {
  return `${line}|${crc32(line).toString(16).padStart(8, '0')}`
}

export function verifyChecksum(line: string): { json: string; valid: boolean } {
  const pipeIdx = line.lastIndexOf('|')
  if (pipeIdx === -1) {
    // Old format without checksum — try to parse as-is
    return { json: line, valid: true }
  }
  const json = line.slice(0, pipeIdx)
  const checksum = line.slice(pipeIdx + 1)
  if (!/^[0-9a-f]{8}$/.test(checksum)) {
    // Pipe belongs to the JSON content (e.g. base64 data), not a checksum delimiter
    return { json: line, valid: true }
  }
  const expected = crc32(json).toString(16).padStart(8, '0')
  return { json, valid: checksum === expected }
}
```

- [ ] **步骤 2：修改写入和读取**

在 session-persist.ts 的写入路径中，将每行 JSON 用 `appendChecksum()` 包装：

```typescript
// When appending a line:
const jsonLine = JSON.stringify(entry)
const line = appendChecksum(jsonLine)
await appendFile(this.logPath, line + '\n')
```

在读取路径中，用 `verifyChecksum()` 验证每行：

```typescript
// When reading lines:
for (const raw of lines) {
  const { json, valid } = verifyChecksum(raw.trim())
  if (!valid) {
    // Corrupted or incomplete line — stop replay here
    break
  }
  try {
    const entry = JSON.parse(json)
    messages.push(entry)
  } catch {
    break // Unparseable — stop
  }
}
```

- [ ] **步骤 3：编写校验和测试**

在 `src/agent/__tests__/session-persist.test.ts`（或新建测试文件）中：

```typescript
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { appendChecksum, verifyChecksum } from '../session-persist.js'

test('appendChecksum adds CRC32 hex suffix', () => {
  const result = appendChecksum('{"type":"message"}')
  const pipeIdx = result.lastIndexOf('|')
  assert.ok(pipeIdx > 0)
  assert.ok(/^[0-9a-f]{8}$/.test(result.slice(pipeIdx + 1)))
})

test('verifyChecksum validates correct checksum', () => {
  const tagged = appendChecksum('{"type":"message"}')
  const { json, valid } = verifyChecksum(tagged)
  assert.equal(valid, true)
  assert.equal(json, '{"type":"message"}')
})

test('verifyChecksum rejects corrupted checksum', () => {
  const tagged = appendChecksum('{"type":"message"}')
  const corrupted = tagged.slice(0, -2) + 'ff'
  const { valid } = verifyChecksum(corrupted)
  assert.equal(valid, false)
})

test('verifyChecksum handles old format without checksum', () => {
  const { json, valid } = verifyChecksum('{"type":"message"}')
  assert.equal(valid, true)
  assert.equal(json, '{"type":"message"}')
})

test('verifyChecksum handles JSON with pipe characters', () => {
  const tagged = appendChecksum('{"data":"a|b|c"}')
  const { json, valid } = verifyChecksum(tagged)
  assert.equal(valid, true)
  assert.equal(json, '{"data":"a|b|c"}')
})

test('verifyChecksum rejects truncated line', () => {
  const tagged = appendChecksum('{"type":"message"}')
  const truncated = tagged.slice(0, -10) // remove checksum and part of JSON
  const { valid } = verifyChecksum(truncated)
  // Either the remaining string doesn't end with valid checksum, or CRC doesn't match
  assert.equal(valid, false)
})
```

- [ ] **步骤 4：运行测试验证通过**

运行：`npm test`
预期：全部 PASS

- [ ] **步骤 5：Commit**

```bash
git add src/agent/session-persist.ts src/agent/__tests__/session-persist.test.ts
git commit -m "feat(persist): add CRC32 checksum to JSONL lines for crash-safe recovery"
```

---

### 任务 4：Fuzzy Checkpoint 标记

**文件：**
- 修改：`src/agent/session-persist.ts`（或 `src/compact/auto.ts`，取决于 compact 调用位置）

- [ ] **步骤 1：在 compact 操作前后写入标记**

在执行 compact 的位置，添加 fuzzy checkpoint 标记：

```typescript
// Before compact:
await this.persist.appendLine({
  type: 'compact_start',
  turn: currentTurn,
  messageCount: messages.length,
})

// Execute compact (existing logic)
const compacted = await compact(messages)

// After compact succeeds:
await this.persist.appendLine({
  type: 'compact_end',
  turn: currentTurn,
  messageCount: compacted.length,
})
```

- [ ] **步骤 2：在恢复时检查 incomplete compact**

在 `loadRecoverableMessages()` 中，添加 incomplete compact 检测：

```typescript
// After loading all entries, scan backwards for compact markers
let compactStartIdx = -1
for (let i = entries.length - 1; i >= 0; i--) {
  if (entries[i]?.type === 'compact_end') break
  if (entries[i]?.type === 'compact_start') {
    compactStartIdx = i
    break
  }
}

if (compactStartIdx >= 0) {
  // Compact was interrupted — discard everything from compact_start onwards
  entries = entries.slice(0, compactStartIdx)
}
```

- [ ] **步骤 3：运行测试验证通过**

运行：`npm test`
预期：全部 PASS

- [ ] **步骤 4：Commit**

```bash
git add src/agent/session-persist.ts
git commit -m "feat(persist): add fuzzy checkpoint markers around compact operations"
```

---

### 任务 5：集成验证

**文件：**
- 无新文件

- [ ] **步骤 1：运行完整测试套件**

运行：`npm test`
预期：全部 PASS

- [ ] **步骤 2：TypeScript 类型检查**

运行：`npm run typecheck`
预期：无错误

- [ ] **步骤 3：手动端到端测试**

1. 启动 Rivet，开始一个对话
2. `kill -9 <pid>` 强制终止
3. 重新启动 Rivet
4. 验证：自动显示"检测到上次异常退出，已恢复会话"
5. 验证：恢复的会话上下文完整

- [ ] **步骤 4：最终 Commit**

```bash
git add -A
git commit -m "chore: session HA and stability hardening complete"
```
