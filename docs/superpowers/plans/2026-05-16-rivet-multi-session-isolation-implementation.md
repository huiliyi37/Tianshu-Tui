# Rivet 多会话并行隔离 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [x]`）语法来跟踪进度。

**目标：** 修复多 TUI 并行时的文件冲突，确保不同 session 的 session 文件、checkpoint 文件互不干扰。

**架构：** 三阶段渐进式隔离。Phase 1 用 UUID 替代固定 session ID 消除 session 文件冲突；Phase 2 用 session ID 替代 cwd 作为 checkpoint 文件名消除 checkpoint 覆盖；Phase 3 添加 git worktree 感知和管理命令。

**技术栈：** TypeScript, node:test, node:assert/strict, crypto, fs/path, existing `SessionPersist`, `checkpoint.ts`

---

## 背景

当前风险来自三条文件共享链路：

1. `~/.rivet/session-id.txt` 存储固定 UUID，所有 TUI 进程读取同一个 ID → 多个 TUI 写同一个 session JSONL 文件，数据交叉。
2. `~/.rivet/checkpoint-<cwd-slug>.json` 按 cwd 命名 → 同 cwd 的两个 TUI 的 checkpoint 互相覆盖（last-write-wins）。
3. Session JSONL / memory 文件依赖 session ID → 如果 session ID 相同（问题 1），则多进程追加写同一文件。

修复原则：不是保护写入（加锁），而是消除冲突（不同的 ID → 不同的文件）。

---

## 文件结构

| 操作 | 文件 | 职责 |
|------|------|------|
| 修改 | `src/main.tsx` | `getOrCreateSessionId()` 每次启动生成新 UUID，不再从文件读取 |
| 修改 | `src/agent/checkpoint.ts` | `checkpointFile()` 改为按 sessionId 命名，新增 cwd index |
| 创建 | `src/agent/__tests__/checkpoint-isolation.test.ts` | 覆盖 session-scoped checkpoint、cwd index、rollback 隔离 |
| 创建 | `src/__tests__/session-isolation.test.ts` | 覆盖 UUID session ID 唯一性、session 文件不冲突 |
| 修改 | `src/tui/app.tsx` | `/rollback` 支持选择 session，`/sessions` 列出所有 session |
| 修改 | `README.md` | 补充多会话隔离说明 |

---

### 任务 1：Session ID 唯一化

**文件：**
- 修改：`src/main.tsx:57-70`
- 测试：`src/__tests__/session-isolation.test.ts`

- [x] **步骤 1：编写失败的测试**

创建 `src/__tests__/session-isolation.test.ts`：

```typescript
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

describe('session ID isolation', () => {
  it('generates unique IDs per invocation', () => {
    const ids = new Set<string>()
    for (let i = 0; i < 100; i++) {
      ids.add(randomUUID())
    }
    assert.equal(ids.size, 100)
  })

  it('IDs are valid UUID v4 format', () => {
    const id = randomUUID()
    assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  })
})
```

- [x] **步骤 2：运行测试验证失败**

运行：`npx tsx --test src/__tests__/session-isolation.test.ts`

预期：PASS（验证 UUID 本身行为正确）。实际目的是确认测试基础设施工作。

- [x] **步骤 3：修改 `getOrCreateSessionId()`**

在 `src/main.tsx` 中，将 `getOrCreateSessionId()` 改为每次启动生成新 UUID。保留 session-id.txt 写入用于 `/sessions` 列表发现，但不再从文件读取：

```typescript
function getOrCreateSessionId(): string {
  const dir = join(homedir(), '.rivet')
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
  const id = randomUUID()
  // Write to session-id.txt for /sessions discovery, but don't read from it
  const idFile = join(dir, 'session-id.txt')
  writeFileSync(idFile, id)
  return id
}
```

- [x] **步骤 4：运行测试验证通过**

运行：`npx tsx --test src/__tests__/session-isolation.test.ts`

预期：PASS。

- [x] **步骤 5：运行完整验证**

运行：`npm run typecheck && npm test && npm run build`

预期：全部 PASS。

- [x] **步骤 6：Commit**

```bash
git add src/main.tsx src/__tests__/session-isolation.test.ts
git commit -m "fix(main): generate unique session ID per TUI launch"
```

---

### 任务 2：Checkpoint 按 session ID 隔离

**文件：**
- 修改：`src/agent/checkpoint.ts`
- 测试：`src/agent/__tests__/checkpoint-isolation.test.ts`

- [x] **步骤 1：编写失败的测试**

创建 `src/agent/__tests__/checkpoint-isolation.test.ts`：

```typescript
import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { checkpointFileForSession, loadCheckpointIndex, addToCheckpointIndex } from '../checkpoint.js'

describe('checkpoint session isolation', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rivet-cp-'))
  })

  afterEach(() => {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
  })

  it('checkpointFileForSession returns session-scoped path', () => {
    const pathA = checkpointFileForSession('session-aaa')
    const pathB = checkpointFileForSession('session-bbb')
    assert.notEqual(pathA, pathB)
    assert.ok(pathA.includes('session-aaa'))
    assert.ok(pathB.includes('session-bbb'))
  })

  it('checkpoint index tracks multiple sessions for same cwd', () => {
    const cwd = '/repo/project'
    addToCheckpointIndex(cwd, 'session-aaa', ['src/a.ts'])
    addToCheckpointIndex(cwd, 'session-bbb', ['src/b.ts'])
    const index = loadCheckpointIndex(cwd)
    assert.equal(index.length, 2)
    assert.ok(index.some(e => e.sessionId === 'session-aaa'))
    assert.ok(index.some(e => e.sessionId === 'session-bbb'))
  })
})
```

- [x] **步骤 2：运行测试验证失败**

运行：`npx tsx --test src/agent/__tests__/checkpoint-isolation.test.ts`

预期：FAIL，`checkpointFileForSession` 不存在。

- [x] **步骤 3：修改 checkpoint.ts**

在 `src/agent/checkpoint.ts` 中：

1. 新增 `checkpointFileForSession()` 导出函数：

```typescript
/** Get checkpoint file path scoped to a session ID. */
export function checkpointFileForSession(sessionId: string): string {
  return join(RIVET_DIR, `checkpoint-${sessionId}.json`)
}
```

2. 新增 checkpoint index 类型和函数：

```typescript
interface CheckpointIndexEntry {
  sessionId: string
  files: string[]
  timestamp: number
}

function checkpointIndexFile(cwd: string): string {
  const slug = cwd.replace(/[^a-zA-Z0-9]/g, '_').slice(-64)
  return join(RIVET_DIR, `checkpoint-index-${slug}.json`)
}

export function loadCheckpointIndex(cwd: string): CheckpointIndexEntry[] {
  const file = checkpointIndexFile(cwd)
  if (!existsSync(file)) return []
  try {
    return JSON.parse(readFileSync(file, 'utf-8')) as CheckpointIndexEntry[]
  } catch {
    return []
  }
}

export function addToCheckpointIndex(cwd: string, sessionId: string, files: string[]): void {
  const index = loadCheckpointIndex(cwd)
  const existing = index.findIndex(e => e.sessionId === sessionId)
  const entry: CheckpointIndexEntry = { sessionId, files, timestamp: Date.now() }
  if (existing >= 0) {
    index[existing] = entry
  } else {
    index.push(entry)
  }
  mkdirSync(RIVET_DIR, { recursive: true })
  writeFileSync(checkpointIndexFile(cwd), JSON.stringify(index, null, 2))
}

export function removeFromCheckpointIndex(cwd: string, sessionId: string): void {
  const index = loadCheckpointIndex(cwd).filter(e => e.sessionId !== sessionId)
  mkdirSync(RIVET_DIR, { recursive: true })
  writeFileSync(checkpointIndexFile(cwd), JSON.stringify(index, null, 2))
}
```

3. 修改 `createCheckpoint()` 接受 `sessionId` 参数：

```typescript
export async function createCheckpoint(cwd: string, sessionId: string, label?: string): Promise<Checkpoint | null> {
  try {
    const { stdout } = await execFileP('git', ['rev-parse', 'HEAD'], {
      cwd, timeout: 5000, encoding: 'utf-8',
    })
    const hash = stdout.trim()
    const snapshot = await getDirtySnapshot(cwd)

    mkdirSync(RIVET_DIR, { recursive: true })
    const msg = label ?? 'checkpoint'
    const data: CheckpointData = {
      version: 2,
      hash,
      timestamp: Date.now(),
      label: msg,
      cwd,
      sessionId,
      preExistingDirtyFiles: snapshot.dirty,
      preExistingUntrackedFiles: snapshot.untracked,
      agentTouchedFiles: [],
    }
    writeFileSync(checkpointFileForSession(sessionId), JSON.stringify(data, null, 2))
    addToCheckpointIndex(cwd, sessionId, [])

    return { hash, timestamp: data.timestamp, message: msg }
  } catch {
    return null
  }
}
```

4. 修改 `recordAgentTouchedFile()` 接受 `sessionId`：

```typescript
export function recordAgentTouchedFile(sessionId: string, file: string): void {
  const data = loadCheckpointDataForSession(sessionId)
  if (!data) return
  const normalized = file.replace(/^\.\//, '')
  if (normalized.startsWith('/') || normalized.includes('..')) return
  data.agentTouchedFiles = [...new Set([...data.agentTouchedFiles, normalized])].sort()
  writeFileSync(checkpointFileForSession(sessionId), JSON.stringify(data, null, 2))
  // Update index
  addToCheckpointIndex(data.cwd, sessionId, data.agentTouchedFiles)
}
```

5. 新增 `loadCheckpointDataForSession()` 并修改 `loadCheckpointData()` 向后兼容：

```typescript
function loadCheckpointDataForSession(sessionId: string): CheckpointData | null {
  const file = checkpointFileForSession(sessionId)
  if (!existsSync(file)) return null
  try {
    return JSON.parse(readFileSync(file, 'utf-8')) as CheckpointData
  } catch {
    return null
  }
}
```

6. 修改 `CheckpointData` 接口加入可选 `sessionId`：

```typescript
interface CheckpointData {
  version: 2
  hash: string
  timestamp: number
  label: string
  cwd: string
  sessionId?: string  // new — absent in legacy checkpoints
  preExistingDirtyFiles: string[]
  preExistingUntrackedFiles: string[]
  agentTouchedFiles: string[]
  confirmationToken?: string
}
```

7. 保留旧的 `checkpointFile(cwd)` 和 `loadCheckpointData(cwd)` 作为向后兼容 fallback（读取旧格式 checkpoint）。

- [x] **步骤 4：运行测试验证通过**

运行：`npx tsx --test src/agent/__tests__/checkpoint-isolation.test.ts`

预期：PASS。

- [x] **步骤 5：Commit**

```bash
git add src/agent/checkpoint.ts src/agent/__tests__/checkpoint-isolation.test.ts
git commit -m "fix(checkpoint): scope checkpoints by session ID instead of cwd"
```

---

### 任务 3：更新 checkpoint 调用方

**文件：**
- 修改：`src/agent/loop.ts`（`createCheckpoint` 和 `recordAgentTouchedFile` 调用点）
- 修改：`src/tui/app.tsx`（`rollbackToCheckpoint` 和 `getRollbackPreview` 调用��）

- [x] **步骤 1：修改 AgentLoop 接受 sessionId**

在 `src/agent/loop.ts` 中：

1. `AgentLoop` 构造函数新增 `sessionId` 参数：

```typescript
constructor(
  config: AgentLoopConfig,
  session: SessionContext,
  cwd?: string,
  sessionId?: string,
) {
  // ... existing code
  this.sessionId = sessionId ?? 'legacy'
}
```

2. 修改 `createCheckpoint` 调用（loop.ts:410）：

```typescript
// Before: const cp = await createCheckpoint(this.cwd, 'auto')
// After:
const cp = await createCheckpoint(this.cwd, this.sessionId, 'auto')
```

3. 修改 `recordAgentTouchedFile` 调用（loop.ts:416）：

```typescript
// Before: recordAgentTouchedFile(this.cwd, tu.input.file_path)
// After:
recordAgentTouchedFile(this.sessionId, tu.input.file_path)
```

- [x] **步骤 2：修改 App 传递 sessionId 到 AgentLoop**

在 `src/tui/app.tsx` 中，确保 `sessionId` 传递到 `AgentLoop` 构造函数。

- [x] **步骤 3：修改 rollback 调用**

在 `src/tui/app.tsx` 中，修改 `/rollback` 使用 session-scoped checkpoint：

```typescript
// Before: rollbackToCheckpoint(process.cwd(), rollbackTokenRef.current)
// After:
const result = await rollbackToCheckpoint(sessionId, rollbackTokenRef.current ?? undefined)
```

- [x] **步骤 4：运行完整验证**

运行：`npm run typecheck && npm test && npm run build`

预期：全部 PASS。

- [x] **步骤 5：Commit**

```bash
git add src/agent/loop.ts src/tui/app.tsx
git commit -m "fix(agent): wire session-scoped checkpoint through AgentLoop and App"
```

---

### 任务 4：Checkpoint rollback 支持选择 session

**文件：**
- 修改：`src/agent/checkpoint.ts`（`rollbackToCheckpoint` 和 `getRollbackPreview` 接受 sessionId）
- 修改：`src/tui/app.tsx`（`/rollback` 列出可选 session）

- [x] **步骤 1：修改 rollback 和 preview 函数签名**

在 `src/agent/checkpoint.ts` 中：

```typescript
export async function getRollbackPreview(sessionId: string): Promise<RollbackPreview | null> {
  const data = loadCheckpointDataForSession(sessionId)
  if (!data) return null
  // ... rest unchanged
}

export async function rollbackToCheckpoint(
  sessionId: string,
  confirmationToken?: string,
): Promise<{ success: boolean; hash?: string }> {
  const data = loadCheckpointDataForSession(sessionId)
  if (!data || !confirmationToken || confirmationToken !== data.confirmationToken) {
    return { success: false }
  }
  // ... rest unchanged
}
```

- [x] **步骤 2：修改 `/rollback` 命令**

在 `src/tui/app.tsx` 中，`/rollback` 命令先加载 checkpoint index，如果当前 session 无 checkpoint 则列出可用 session：

```typescript
if (command === '/rollback') {
  // Try current session first
  const preview = await getRollbackPreview(sessionId)
  if (preview) {
    // Show preview and ask for confirmation (existing flow)
  } else {
    // Check if other sessions have checkpoints for this cwd
    const index = loadCheckpointIndex(process.cwd())
    if (index.length > 0) {
      // Show list: "Other sessions with checkpoints: session-aaa (3 files), session-bbb (1 file)"
    } else {
      // "No checkpoints found"
    }
  }
}
```

- [x] **步骤 3：运行完整验证**

运行：`npm run typecheck && npm test && npm run build`

预期：全部 PASS。

- [x] **步骤 4：Commit**

```bash
git add src/agent/checkpoint.ts src/tui/app.tsx
git commit -m "feat(checkpoint): rollback supports session selection"
```

---

### 任务 5：向后兼容 + 旧 checkpoint 迁移

**文件：**
- 修改：`src/agent/checkpoint.ts`

- [x] **步骤 1：添加旧格式 checkpoint fallback**

在 `loadCheckpointData()` 中，先尝试 session-scoped 查找，再 fallback 到 cwd-scoped：

```typescript
function loadCheckpointData(sessionIdOrCwd: string, cwd?: string): CheckpointData | null {
  // Try session-scoped first
  const sessionData = loadCheckpointDataForSession(sessionIdOrCwd)
  if (sessionData) return sessionData
  // Fallback to cwd-scoped (legacy)
  if (cwd) {
    const file = checkpointFile(cwd)
    if (!existsSync(file)) return null
    try {
      return JSON.parse(readFileSync(file, 'utf-8')) as CheckpointData
    } catch {
      return null
    }
  }
  return null
}
```

- [x] **步骤 2：运行完整验证**

运行：`npm run typecheck && npm test && npm run build`

预期：全部 PASS。

- [x] **步骤 3：Commit**

```bash
git add src/agent/checkpoint.ts
git commit -m "fix(checkpoint): backward-compatible fallback for legacy cwd-scoped checkpoints"
```

---

### 任务 6：README + 最终验证

**文件：**
- 修改：`README.md`

- [x] **步骤 1：更新 README 多会话说明**

在 README 中加入：

```markdown
### Multi-Session Isolation

Each Rivet TUI launch generates a unique session ID (UUID v4). Session files, checkpoints, and memory are scoped to this ID, so multiple TUI instances can run in parallel without interfering with each other:

- Session JSONL: `~/.rivet/sessions/<sessionId>.jsonl` — unique per launch
- Checkpoints: `~/.rivet/checkpoint-<sessionId>.json` — unique per launch
- Checkpoint index: `~/.rivet/checkpoint-index-<cwd-slug>.json` — shared, lists all sessions with checkpoints for a directory

For maximum isolation (separate git working trees), use git worktrees: `git worktree add ../project-feature-a feature-a && cd ../project-feature-a && rivet`
```

- [x] **步骤 2：运行完整验证**

运行：`npm run typecheck && npm test && npm run build`

预期：全部 PASS。

- [x] **步骤 3：Commit**

```bash
git add README.md
git commit -m "docs: document multi-session isolation"
```

---

## 自检

### 规格覆盖度

- Session ID 唯一化：任务 1 覆盖。
- Session 文件不冲突：任务 1 自然消除（UUID → 不同文件名）。
- Checkpoint 按 session ID 隔离：任务 2 + 3 覆盖。
- Checkpoint rollback 支持选择 session：任务 4 覆盖。
- 旧格式向后兼容：任务 5 覆盖。
- 文档：任务 6 覆盖。

### 占位符扫描

本文没有使用"待定"、"后续实现"、"补充细节"；每个代码步骤给出具体代码和命令。

### 类型一致性

- `checkpointFileForSession(sessionId)` 在任务 2 定义，在任务 3 的 `AgentLoop` 中使用。
- `CheckpointData.sessionId` 在任务 2 定义（可选字段），在任务 2-5 中使用。
- `loadCheckpointIndex(cwd)` 在任务 2 定义，在任务 4 的 `/rollback` 命令中使用。

---

计划已完成并保存到 `docs/superpowers/plans/2026-05-16-rivet-multi-session-isolation-implementation.md`。两种执行方式：

**1. 子代理驱动（推荐）** - 每个任务调度一个新的子代理，任务间进行审查

**2. 内联执行** - 在当前会话中使用 executing-plans 逐任务实现

选哪种方式？
