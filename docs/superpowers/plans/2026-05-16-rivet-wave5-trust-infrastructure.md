# Wave 5: Trust Infrastructure 实施计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 让用户信任 Rivet —— 通过可见性（看见上下文管理）+ 可回滚性（per-call undo）建立信任基础设施。

**架构：** 三阶段递进 — 激活休眠能力 → 持久化 undo → 上下文可视化

**技术栈：** TypeScript, Ink 6, existing FileHistory/ContextLedger/output-store infrastructure

---

## 文件结构

### 修改文件

| 文件 | 变更 |
|------|------|
| `src/tools/default-registry.ts` | 注册 inspect_project, repo_map, related_tests, undo |
| `src/main.tsx` | 传入 autoReasoning, lspEnabled, fileHistory, hooks, permissions |
| `src/agent/checkpoint.ts` | checkpointCreatedThisTurn 移入 loop 内实现 per-turn 粒度 |
| `src/tui/app.tsx` | 添加 /context, /undo, /evidence slash command handlers |

### 新建文件

| 文件 | 职责 |
|------|------|
| `src/agent/file-history-persist.ts` | FileHistory 的 JSON 序列化/反序列化 + 环形缓冲 GC |
| `src/tui/context-view.tsx` | /context 命令的渲染组件 |
| `src/__tests__/file-history-persist.test.ts` | 持久化测试 |
| `src/__tests__/context-view.test.ts` | 上下文视图测试 |

---

## 任务 1：工具注册 + Agent 配置接线

**文件：**
- 修改：`src/tools/default-registry.ts`
- 修改：`src/main.tsx:238-254`（AgentLoop 构造）
- 测试：现有测试验证（npm test）

- [ ] **步骤 1：注册 3 个休眠工具**

```typescript
// src/tools/default-registry.ts — 添加 imports
import { INSPECT_PROJECT_TOOL } from './inspect-project.js'
import { REPO_MAP_TOOL } from './repo-map.js'
import { RELATED_TESTS_TOOL } from './related-tests.js'

// 在 createDefaultToolRegistry() 函数体中添加
registry.register(INSPECT_PROJECT_TOOL)
registry.register(REPO_MAP_TOOL)
registry.register(RELATED_TESTS_TOOL)
```

- [ ] **步骤 2：运行测试确认无破坏**

运行：`npm test`
预期：全部通过（712+）

- [ ] **步骤 3：传入 autoReasoning + lspEnabled**

```typescript
// src/main.tsx — AgentLoop 构造中添加
return new AgentLoop(
  {
    // ...existing fields...
    autoReasoning: true,
    lspEnabled: true,
  },
  session,
  cwd,
)
```

- [ ] **步骤 4：运行 typecheck + test**

运行：`npx tsc --noEmit && npm test`
预期：无类型错误，测试全部通过

- [ ] **步骤 5：Commit**

```bash
git add src/tools/default-registry.ts src/main.tsx
git commit -m "feat: activate dormant tools (repo_map, inspect_project, related_tests) + autoReasoning + lspEnabled"
```

---

## 任务 2：合并 ACF 分支

**文件：**
- 整个 ACF 分支的变更（983 行新代码）

- [ ] **步骤 1：合并 ACF 分支到 main**

```bash
git merge worktree-acf-phase1-safety-layer --no-ff -m "feat(context): merge Adaptive Context Fabric (Phase 1-4)"
```

- [ ] **步骤 2：解决冲突（如果有）**

预期冲突文件：`src/compact/constants.ts`, `src/agent/loop.ts`, `src/tools/default-registry.ts`
策略：ACF 分支的变更优先（它是更新的架构）

- [ ] **步骤 3：运行完整测试套件**

运行：`npx tsc --noEmit && npm test`
预期：全部通过

- [ ] **步骤 4：验证 ACF 功能生效**

运行：`grep -n "PressureMonitor\|AnchorRegistry\|PersistentStore" src/agent/loop.ts`
预期：看到 ACF 模块的 import 和使用

---

## 任务 3：FileHistory 持久化

**文件：**
- 创建：`src/agent/file-history-persist.ts`
- 创建：`src/__tests__/file-history-persist.test.ts`
- 修改：`src/main.tsx`（创建 FileHistory 实例）

- [ ] **步骤 1：编写失败的测试**

```typescript
// src/__tests__/file-history-persist.test.ts
import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { persistFileHistory, loadFileHistory } from '../agent/file-history-persist.js'

describe('FileHistory persistence', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'rivet-fh-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('round-trips snapshots to JSON', () => {
    const snapshots = [
      { messageId: 'msg-1', files: [{ path: '/a.ts', content: 'const x = 1' }], timestamp: Date.now() },
      { messageId: 'msg-2', files: [{ path: '/a.ts', content: 'const x = 2' }], timestamp: Date.now() },
    ]
    const filePath = join(dir, 'file-history.json')
    persistFileHistory(filePath, snapshots)
    const loaded = loadFileHistory(filePath)
    assert.deepEqual(loaded, snapshots)
  })

  it('caps at maxSnapshots via ring buffer GC', () => {
    const snapshots = Array.from({ length: 60 }, (_, i) => ({
      messageId: `msg-${i}`,
      files: [{ path: '/a.ts', content: `v${i}` }],
      timestamp: Date.now() + i,
    }))
    const filePath = join(dir, 'file-history.json')
    persistFileHistory(filePath, snapshots, 50)
    const loaded = loadFileHistory(filePath)
    assert.equal(loaded.length, 50)
    assert.equal(loaded[0].messageId, 'msg-10')
  })

  it('returns empty array for missing file', () => {
    const loaded = loadFileHistory(join(dir, 'nonexistent.json'))
    assert.deepEqual(loaded, [])
  })
})
```

- [ ] **步骤 2：运行测试确认失败**

运行：`npm test -- src/__tests__/file-history-persist.test.ts`
预期：FAIL（模块不存在）

- [ ] **步骤 3：实现持久化模块**

```typescript
// src/agent/file-history-persist.ts
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { dirname } from 'path'

export interface FileSnapshot {
  path: string
  content: string
}

export interface HistoryEntry {
  messageId: string
  files: FileSnapshot[]
  timestamp: number
}

export function persistFileHistory(filePath: string, entries: HistoryEntry[], maxSnapshots = 50): void {
  const dir = dirname(filePath)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const trimmed = entries.length > maxSnapshots ? entries.slice(-maxSnapshots) : entries
  writeFileSync(filePath, JSON.stringify(trimmed))
}

export function loadFileHistory(filePath: string): HistoryEntry[] {
  if (!existsSync(filePath)) return []
  try {
    return JSON.parse(readFileSync(filePath, 'utf-8'))
  } catch {
    return []
  }
}
```

- [ ] **步骤 4：运行测试确认通过**

运行：`npm test -- src/__tests__/file-history-persist.test.ts`
预期：PASS

- [ ] **步骤 5：Commit**

```bash
git add src/agent/file-history-persist.ts src/__tests__/file-history-persist.test.ts
git commit -m "feat(undo): persistent FileHistory with ring-buffer GC (50 snapshots max)"
```

---

## 任务 4：注册 Undo Tool + 接线 FileHistory

**文件：**
- 修改：`src/tools/default-registry.ts`
- 修改：`src/main.tsx`

- [ ] **步骤 1：检查 FileHistory 接口**

运行：`grep -n "class FileHistory\|constructor\|rewind\|record" src/agent/file-history.ts | head -20`
理解 FileHistory 的 API 签名

- [ ] **步骤 2：在 main.tsx 创建 FileHistory 实例并传入**

```typescript
// src/main.tsx — 在 Root 组件内，AgentLoop 构造前
import { FileHistory } from './agent/file-history.js'
import { createUndoTool } from './tools/undo.js'

// 在 useMemo 中 agent 创建前
const fileHistory = new FileHistory()

// AgentLoop config 中添加
fileHistory,

// 注册 undo tool（在 toolRegistry 初始化中）
reg.register(createUndoTool(fileHistory))
```

- [ ] **步骤 3：运行 typecheck + test**

运行：`npx tsc --noEmit && npm test`
预期：全部通过

- [ ] **步骤 4：添加持久化 hook（session 结束时保存）**

```typescript
// 在 shutdown callback 中添加
import { persistFileHistory } from './agent/file-history-persist.js'

// gracefulShutdown 中
const historyPath = join(homedir(), '.rivet', 'sessions', sessionId, 'file-history.json')
persistFileHistory(historyPath, fileHistory.getEntries())
```

- [ ] **步骤 5：运行测试**

运行：`npm test`
预期：全部通过

- [ ] **步骤 6：Commit**

```bash
git add src/tools/default-registry.ts src/main.tsx
git commit -m "feat(undo): wire FileHistory + undo tool into agent loop with persist-on-exit"
```

---

## 任务 5：/context 命令 — 上下文可视化

**文件：**
- 创建：`src/tui/context-view.tsx`
- 修改：`src/tui/app.tsx`（handleSlashCommand 添加 /context case）

- [ ] **步骤 1：实现 context-view 渲染函数**

```typescript
// src/tui/context-view.tsx
import type { ContextLedger } from '../context/types.js'

export function formatContextView(ledger: ContextLedger, contextWindow: number): string {
  const usage = ledger.tokenBudget.estimatedTokens
  const pct = Math.round((usage / contextWindow) * 100)
  const bar = '█'.repeat(Math.floor(pct / 5)) + '░'.repeat(20 - Math.floor(pct / 5))

  const lines: string[] = [
    `Context: ${bar} ${pct}% (${Math.round(usage / 1000)}K / ${Math.round(contextWindow / 1000)}K)`,
    ``,
    `Rounds: ${ledger.rounds.length} total`,
    `Anchors: ${ledger.anchors.length} pinned`,
    `Working Set: ${ledger.workingSet.length} files`,
    `Compacted: ${ledger.compactedSpans.length} spans`,
  ]

  if (ledger.anchors.length > 0) {
    lines.push(``, `Pinned Anchors:`)
    for (const a of ledger.anchors.slice(0, 5)) {
      lines.push(`  [${a.kind}] ${a.text.slice(0, 60)}`)
    }
  }

  return lines.join('\n')
}
```

- [ ] **步骤 2：在 app.tsx 添加 /context handler**

```typescript
// src/tui/app.tsx — handleSlashCommand switch 中添加
case 'context': {
  const ledger = agent.getLedger()
  if (ledger) {
    const view = formatContextView(ledger, maxTokens)
    // render as static log entry
    addLogEntry({ type: 'info', content: view })
  } else {
    addLogEntry({ type: 'info', content: 'Context ledger not available' })
  }
  return true
}
```

- [ ] **步骤 3：运行 typecheck**

运行：`npx tsc --noEmit`
预期：无错误

- [ ] **步骤 4：运行测试**

运行：`npm test`
预期：全部通过

- [ ] **步骤 5：Commit**

```bash
git add src/tui/context-view.tsx src/tui/app.tsx
git commit -m "feat(tui): /context command — visualize ACF context layers and anchors"
```

---

## 任务 6：/context pin 命令 — 手动锚点

**文件：**
- 修改：`src/tui/app.tsx`
- 修改：`src/tui/context-view.tsx`（如需）

- [ ] **步骤 1：在 handleSlashCommand 中处理 /context pin**

```typescript
case 'context': {
  const args = input.slice('/context'.length).trim()
  if (args.startsWith('pin ')) {
    const text = args.slice(4).trim()
    if (text) {
      agent.addAnchor({ kind: 'user_preference', text, sourceRoundIndex: -1, salience: 1.0 })
      addLogEntry({ type: 'info', content: `Pinned: "${text}"` })
    }
    return true
  }
  // existing /context display logic
  // ...
}
```

- [ ] **步骤 2：验证 agent.addAnchor API 存在**

运行：`grep -n "addAnchor\|anchors" src/agent/loop.ts | head -10`
如果不存在，需要在 AgentLoop 上添加 public 方法代理到 ledger

- [ ] **步骤 3：运行测试**

运行：`npm test`
预期：全部通过

- [ ] **步骤 4：Commit**

```bash
git add src/tui/app.tsx
git commit -m "feat(tui): /context pin — user can manually pin anchors to prevent context loss"
```

---

## 任务 7：/undo slash command handler

**文件：**
- 修改：`src/tui/app.tsx`

- [ ] **步骤 1：添加 /undo handler**

```typescript
case 'undo': {
  if (!fileHistory) {
    addLogEntry({ type: 'info', content: 'Undo not available (no file history)' })
    return true
  }
  const entries = fileHistory.getEntries()
  if (entries.length === 0) {
    addLogEntry({ type: 'info', content: 'No undo history' })
    return true
  }
  // Show last 10 entries
  const recent = entries.slice(-10)
  const lines = recent.map((e, i) => `  ${entries.length - 10 + i + 1}. [${e.messageId.slice(0, 8)}] ${e.files.map(f => f.path).join(', ')}`)
  addLogEntry({ type: 'info', content: `Undo history (${entries.length} total):\n${lines.join('\n')}\n\nUse: /undo <number> to revert` })
  return true
}
```

- [ ] **步骤 2：运行测试**

运行：`npm test`
预期：全部通过

- [ ] **步骤 3：Commit**

```bash
git add src/tui/app.tsx
git commit -m "feat(tui): /undo slash command — display file history and selective revert"
```

---

## 任务 8：集成测试

**文件：**
- 创建：`src/__tests__/wave5-integration.test.ts`

- [ ] **步骤 1：编写集成测试**

```typescript
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createDefaultToolRegistry } from '../tools/default-registry.js'
import { formatContextView } from '../tui/context-view.js'
import type { ContextLedger } from '../context/types.js'

describe('Wave 5 integration', () => {
  it('default registry includes repo_map, inspect_project, related_tests', () => {
    const reg = createDefaultToolRegistry()
    const defs = reg.getDefinitions()
    const names = defs.map(d => d.name)
    assert.ok(names.includes('repo_map'))
    assert.ok(names.includes('inspect_project'))
    assert.ok(names.includes('related_tests'))
  })

  it('formatContextView renders without crash', () => {
    const ledger: ContextLedger = {
      sessionId: 'test',
      transcriptPath: '/tmp/test',
      rounds: [],
      anchors: [{ kind: 'decision', text: 'use postgres', sourceRoundIndex: 0, salience: 1.0 }],
      workingSet: [],
      compactedSpans: [],
      sessionMemory: null,
      tokenBudget: { estimatedTokens: 50000, maxTokens: 128000, warningThreshold: 100000, compactionState: 'healthy' },
      apiInvariantStatus: { totalRounds: 0, okRounds: 0, repairedRounds: 0, brokenRounds: 0, orphanToolUse: [], orphanToolResult: [] },
    }
    const output = formatContextView(ledger, 128000)
    assert.ok(output.includes('39%'))
    assert.ok(output.includes('use postgres'))
  })
})
```

- [ ] **步骤 2：运行测试**

运行：`npm test`
预期：全部通过

- [ ] **步骤 3：Commit**

```bash
git add src/__tests__/wave5-integration.test.ts
git commit -m "test(wave5): integration tests for tool registration + context view"
```

---

## 验收标准

| 标准 | 验证方法 |
|------|---------|
| repo_map/inspect_project/related_tests 可被 agent 调用 | registry.getDefinitions() 包含这些工具 |
| autoReasoning 生效 | agent loop 中 selectReasoningEffort 被调用 |
| /undo 显示历史并可回滚 | 手动测试：修改文件 → /undo → 文件恢复 |
| /context 显示窗口利用率 | 手动测试：运行几轮后 /context 显示正确百分比 |
| /context pin 添加锚点 | /context pin "use X" → /context 显示 pinned anchor |
| FileHistory 跨 session 持久化 | 退出 → 重启 → /undo 仍有历史 |
| 所有测试通过 | npm test: 720+ pass, 0 fail |
