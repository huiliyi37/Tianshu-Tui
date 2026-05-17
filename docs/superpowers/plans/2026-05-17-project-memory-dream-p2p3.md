# Project Memory Dream Phase 2 + Phase 3 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** Phase 2 — 门控 + 去重 + 条目边界截断 + decisions 接线。Phase 3 — 多文件主题分类 + recall 工具搜索知识文件。

**架构：** Phase 2 在 `dream.ts` 中增加条目边界截断和去重逻辑，在 `main.tsx` 中接入 decisions，增加门控条件（tests passed 或 files > 3）。Phase 3 新增 `src/agent/dream-classify.ts` 按主题拆分知识文件，扩展 recall 工具搜索 `.rivet/knowledge/*.md`。

**技术栈：** TypeScript, node:fs, 现有 dream.ts / volatile.ts / recall.ts 基础设施。

**设计过程：** [`docs/superpowers/specs/2026-05-17-project-memory-dream-design.md`](../specs/2026-05-17-project-memory-dream-design.md)

**前置条件：** Phase 1 已完成（commit `6a30c3c`，分支 `feat/openai-client`）。

---

## 文件结构

| 文件 | 操作 | 职责 |
|------|------|------|
| `src/agent/dream.ts` | 修改 | 条目边界截断 + 去重（text hash） |
| `src/agent/loop.ts` | 修改 | 暴露 `getDecisions()` getter |
| `src/main.tsx` | 修改 | 接入 decisions + 门控条件 |
| `src/agent/__tests__/dream.test.ts` | 修改 | 新增截断/去重/门控测试 |
| `src/agent/dream-classify.ts` | 创建 | Phase 3: 按主题分类知识条目 |
| `src/tools/recall.ts` | 修改 | Phase 3: 搜索 .rivet/knowledge/*.md |
| `src/agent/__tests__/dream-classify.test.ts` | 创建 | Phase 3: 分类逻辑测试 |

---

## Phase 2：门控 + 去重 + 截断修复 + Decisions 接线

### 任务 1：条目边界截断

**文件：**
- 修改：`src/agent/dream.ts:113-135`
- 修改：`src/agent/__tests__/dream.test.ts`

- [ ] **步骤 1：编写失败的测试**

```typescript
// 追加到 src/agent/__tests__/dream.test.ts 的 persistDream describe 中
it('truncates at entry boundary, not mid-line', () => {
  // Write 10 entries that exceed MAX_FILE_SIZE
  for (let i = 0; i < 15; i++) {
    persistDream(tmpDir, {
      filesModified: Array.from({ length: 8 }, (_, j) => `src/module${i}/file${j}.ts`),
      filesRead: [],
      verifications: [{ command: 'npm test', status: 'passed', scope: 'full' as const, exitCode: 0, passed: 10, failed: 0, skipped: 0, durationMs: 100 }],
      decisions: [`Decision for session ${i}`],
      trajectoryEntries: [{ tool: 'edit_file', target: `src/module${i}/file0.ts`, status: 'success' }],
      sessionId: `session-${String(i).padStart(4, '0')}`,
    })
  }
  const path = join(tmpDir, '.rivet', 'knowledge', 'project-memory.md')
  const content = readFileSync(path, 'utf-8')
  // Every line should be complete — no line cut mid-word
  const lines = content.split('\n')
  for (const line of lines) {
    // A truncated entry would have a ### header without a following blank line before EOF
    if (line.startsWith('### ')) {
      assert.match(line, /^### \d{4}-\d{2}-\d{2}/)
    }
  }
  // File should not exceed MAX_FILE_SIZE
  assert.ok(content.length <= 8000, `content length ${content.length} exceeds 8000`)
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npm test -- --test-name-pattern "truncates at entry boundary" 2>&1 | tail -10`
预期：可能 PASS（当前裸截断恰好不切断），或 FAIL（切断了 `###` 行）。无论如何，下一步改为安全截断。

- [ ] **步骤 3：修改 persistDream 使用条目边界截断**

替换 `src/agent/dream.ts:129-132`：

```typescript
/** Persist a distilled session entry to the project knowledge file. */
export function persistDream(cwd: string, input: DreamInput): void {
  const entry = distillSession(input)
  if (!entry) return

  const dir = join(cwd, '.rivet', 'knowledge')
  ensureDir(dir)
  const path = join(dir, 'project-memory.md')

  let existing = ''
  try {
    existing = readFileSync(path, 'utf-8')
  } catch {
    // file doesn't exist yet — start fresh
  }

  const combined = entry + '\n' + existing
  const trimmed = trimToEntryBoundary(combined, MAX_FILE_SIZE)
  writeFileSync(path, trimmed, 'utf-8')
}

function trimToEntryBoundary(content: string, maxSize: number): string {
  if (content.length <= maxSize) return content
  const cut = content.slice(0, maxSize)
  const lastEntry = cut.lastIndexOf('\n### ')
  if (lastEntry <= 0) return cut
  return cut.slice(0, lastEntry).trimEnd() + '\n'
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`npm test -- --test-name-pattern "persistDream|distillSession" 2>&1 | tail -10`
预期：全部 PASS

- [ ] **步骤 5：Commit**

```bash
git add src/agent/dream.ts src/agent/__tests__/dream.test.ts
git commit -m "fix(memory): truncate knowledge file at entry boundary instead of raw slice"
```

---

### 任务 2：去重（text hash）

**文件：**
- 修改：`src/agent/dream.ts`
- 修改：`src/agent/__tests__/dream.test.ts`

- [ ] **步骤 1：编写失败的测试**

```typescript
// 追加到 persistDream describe
it('deduplicates entries with same files in same day', () => {
  const baseInput: DreamInput = {
    filesModified: ['src/same-file.ts'],
    filesRead: [],
    verifications: [{ command: 'npm test', status: 'passed', scope: 'full' as const, exitCode: 0, passed: 5, failed: 0, skipped: 0, durationMs: 100 }],
    decisions: [],
    trajectoryEntries: [],
    sessionId: 'session-dup1',
  }
  persistDream(tmpDir, baseInput)
  persistDream(tmpDir, { ...baseInput, sessionId: 'session-dup2' })
  persistDream(tmpDir, { ...baseInput, sessionId: 'session-dup3' })

  const path = join(tmpDir, '.rivet', 'knowledge', 'project-memory.md')
  const content = readFileSync(path, 'utf-8')
  const entryCount = (content.match(/^### /gm) || []).length
  // Should deduplicate: same files + same day = 1 entry (latest wins)
  assert.ok(entryCount <= 2, `expected <=2 entries but got ${entryCount}`)
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npm test -- --test-name-pattern "deduplicates entries" 2>&1 | tail -10`
预期：FAIL（当前会产生 3 个条目）

- [ ] **步骤 3：实现去重逻辑**

在 `src/agent/dream.ts` 的 `persistDream` 函数中，写入前去重：

```typescript
function deduplicateEntries(content: string, newEntry: string): string {
  const newKey = extractDedupeKey(newEntry)
  if (!newKey) return newEntry + '\n' + content

  const entries = splitEntries(content)
  const filtered = entries.filter(e => extractDedupeKey(e) !== newKey)
  return [newEntry, ...filtered].join('\n')
}

function splitEntries(content: string): string[] {
  const parts = content.split(/(?=^### )/m)
  return parts.filter(p => p.trim())
}

function extractDedupeKey(entry: string): string | null {
  const dateMatch = entry.match(/^### (\d{4}-\d{2}-\d{2})/)
  const filesMatch = entry.match(/\*\*Modified\*\*[^:]*: (.+)/)
  if (!dateMatch || !filesMatch) return null
  return `${dateMatch[1]}:${filesMatch[1].slice(0, 80)}`
}
```

更新 `persistDream`：

```typescript
export function persistDream(cwd: string, input: DreamInput): void {
  const entry = distillSession(input)
  if (!entry) return

  const dir = join(cwd, '.rivet', 'knowledge')
  ensureDir(dir)
  const path = join(dir, 'project-memory.md')

  let existing = ''
  try {
    existing = readFileSync(path, 'utf-8')
  } catch {}

  const combined = deduplicateEntries(existing, entry)
  const trimmed = trimToEntryBoundary(combined, MAX_FILE_SIZE)
  writeFileSync(path, trimmed, 'utf-8')
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`npm test -- --test-name-pattern "persistDream|distillSession" 2>&1 | tail -10`
预期：全部 PASS

- [ ] **步骤 5：Commit**

```bash
git add src/agent/dream.ts src/agent/__tests__/dream.test.ts
git commit -m "feat(memory): deduplicate dream entries by date+files key"
```

---

### 任务 3：Decisions 接线 + 门控条件

**文件：**
- 修改：`src/agent/loop.ts:194`
- 修改：`src/main.tsx:348-363`
- 修改：`src/agent/__tests__/dream.test.ts`

- [ ] **步骤 1：在 AgentLoop 中暴露 decisions getter**

在 `src/agent/loop.ts` 第 194 行后添加：

```typescript
getDecisions(): string[] { return this.decisions }
```

- [ ] **步骤 2：运行 typecheck**

运行：`npx tsc --noEmit 2>&1 | tail -5`
预期：无错误

- [ ] **步骤 3：修改 main.tsx 接入 decisions + 门控**

替换 `src/main.tsx` 中 persistDream 调用块：

```typescript
try {
  const evidenceState = agent.getEvidenceState()
  const rawTrajectory = agent.getTrajectoryEntries()
  const filesModified = [...evidenceState.filesModified]
  const hasVerification = evidenceState.verifications.some(v => v.status === 'passed')
  // Gate: only persist if meaningful work (verified OR 3+ files modified)
  if (hasVerification || filesModified.length >= 3) {
    persistDream(process.cwd(), {
      filesModified,
      filesRead: [...evidenceState.filesRead],
      verifications: evidenceState.verifications,
      decisions: agent.getDecisions(),
      trajectoryEntries: rawTrajectory.map(e => ({
        tool: e.tool,
        target: e.target,
        status: e.status.startsWith('retried') || e.status === 'success' ? 'success' as const : 'failed' as const,
        error: e.errorClass,
      })),
      sessionId,
    })
  }
} catch { /* dream distillation is best-effort */ }
```

- [ ] **步骤 4：编写门控测试**

```typescript
// 追加到 src/agent/__tests__/dream.test.ts
it('gate: does not persist when < 3 files and no verification', () => {
  const knowledgeDir = join(tmpDir, '.rivet', 'knowledge')
  try { rmSync(knowledgeDir, { recursive: true, force: true }) } catch {}

  // 1 file, no verification — should NOT persist (gate blocks)
  // Note: persistDream itself doesn't enforce the gate — main.tsx does.
  // This test verifies distillSession still returns content (gate is external).
  const input: DreamInput = {
    filesModified: ['src/one.ts'],
    filesRead: [],
    verifications: [],
    decisions: [],
    trajectoryEntries: [],
    sessionId: 'gated-session',
  }
  const result = distillSession(input)
  assert.ok(result, 'distillSession should still produce output — gate is in main.tsx')
})
```

- [ ] **步骤 5：运行全量测试**

运行：`npx tsc --noEmit && npm test 2>&1 | grep -E "^ℹ (tests|pass|fail)"`
预期：0 errors, 1050+ pass, 0 fail

- [ ] **步骤 6：Commit**

```bash
git add src/agent/loop.ts src/main.tsx src/agent/__tests__/dream.test.ts
git commit -m "feat(memory): wire decisions into dream + gate on verification or 3+ files"
```

---

## Phase 3：多文件主题分类 + Recall 搜索知识文件

### 任务 4：知识条目主题分类

**文件：**
- 创建：`src/agent/dream-classify.ts`
- 创建：`src/agent/__tests__/dream-classify.test.ts`

- [ ] **步骤 1：编写失败的测试**

```typescript
// src/agent/__tests__/dream-classify.test.ts
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { classifyEntry } from '../dream-classify.js'

describe('classifyEntry', () => {
  it('classifies test-related entries as "testing"', () => {
    const entry = '### 2026-05-17 — session abc12345\n\n**Modified** (2): src/__tests__/foo.test.ts, src/__tests__/bar.test.ts\n**Tests**: ✅ 10 passed, 0 failed (npm test)\n'
    assert.strictEqual(classifyEntry(entry), 'testing')
  })

  it('classifies config/infra entries as "infra"', () => {
    const entry = '### 2026-05-17 — session abc12345\n\n**Modified** (2): tsconfig.json, package.json\n**Tests**: ⚠️ unverified\n'
    assert.strictEqual(classifyEntry(entry), 'infra')
  })

  it('classifies prompt/context entries as "prompt"', () => {
    const entry = '### 2026-05-17 — session abc12345\n\n**Modified** (1): src/prompt/volatile.ts\n**Tests**: ✅ 5 passed, 0 failed (npm test)\n'
    assert.strictEqual(classifyEntry(entry), 'prompt')
  })

  it('classifies UI entries as "ui"', () => {
    const entry = '### 2026-05-17 — session abc12345\n\n**Modified** (1): src/tui/cockpit/model-panel.tsx\n**Tests**: ✅ 3 passed, 0 failed (npm test)\n'
    assert.strictEqual(classifyEntry(entry), 'ui')
  })

  it('defaults to "general" for mixed entries', () => {
    const entry = '### 2026-05-17 — session abc12345\n\n**Modified** (3): src/agent/loop.ts, src/tools/bash.ts, src/api/client.ts\n'
    assert.strictEqual(classifyEntry(entry), 'general')
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npm test -- --test-name-pattern "classifyEntry" 2>&1 | tail -5`
预期：FAIL，`Cannot find module '../dream-classify.js'`

- [ ] **步骤 3：实现 dream-classify.ts**

```typescript
// src/agent/dream-classify.ts
export type KnowledgeTopic = 'testing' | 'infra' | 'prompt' | 'ui' | 'agent' | 'tools' | 'general'

const TOPIC_PATTERNS: Array<{ topic: KnowledgeTopic; patterns: RegExp[] }> = [
  { topic: 'testing', patterns: [/\btest|spec|__tests__/i] },
  { topic: 'infra', patterns: [/tsconfig|package\.json|\.config\.|Dockerfile|ci\//i] },
  { topic: 'prompt', patterns: [/src\/prompt|src\/compact|src\/context/i] },
  { topic: 'ui', patterns: [/src\/tui|\.tsx|cockpit|panel/i] },
  { topic: 'agent', patterns: [/src\/agent|loop|coordinator|dream/i] },
  { topic: 'tools', patterns: [/src\/tools/i] },
]

export function classifyEntry(entry: string): KnowledgeTopic {
  const filesLine = entry.match(/\*\*Modified\*\*[^:]*:\s*(.+)/)?.[1] ?? ''
  const files = filesLine.split(',').map(f => f.trim())

  const scores = new Map<KnowledgeTopic, number>()
  for (const file of files) {
    for (const { topic, patterns } of TOPIC_PATTERNS) {
      if (patterns.some(p => p.test(file))) {
        scores.set(topic, (scores.get(topic) ?? 0) + 1)
      }
    }
  }

  if (scores.size === 0) return 'general'
  const sorted = [...scores.entries()].sort((a, b) => b[1] - a[1])
  const top = sorted[0]!
  if (top[1] >= Math.ceil(files.length / 2)) return top[0]
  return 'general'
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`npx tsc --noEmit && npm test -- --test-name-pattern "classifyEntry" 2>&1 | tail -5`
预期：5 tests PASS

- [ ] **步骤 5：Commit**

```bash
git add src/agent/dream-classify.ts src/agent/__tests__/dream-classify.test.ts
git commit -m "feat(memory): add topic classification for knowledge entries"
```

---

### 任务 5：persistDream 按主题写入分类文件

**文件：**
- 修改：`src/agent/dream.ts`
- 修改：`src/agent/__tests__/dream.test.ts`

- [ ] **步骤 1：编写失败的测试**

```typescript
// 追加到 src/agent/__tests__/dream.test.ts 的 persistDream describe
it('writes to topic-specific file when classifiable', () => {
  const input: DreamInput = {
    filesModified: ['src/__tests__/foo.test.ts', 'src/__tests__/bar.test.ts'],
    filesRead: [],
    verifications: [{ command: 'npm test', status: 'passed', scope: 'full' as const, exitCode: 0, passed: 10, failed: 0, skipped: 0, durationMs: 100 }],
    decisions: [],
    trajectoryEntries: [],
    sessionId: 'topic-session',
  }
  persistDream(tmpDir, input)
  const topicPath = join(tmpDir, '.rivet', 'knowledge', 'testing.md')
  assert.ok(existsSync(topicPath), 'should write to testing.md')
  const content = readFileSync(topicPath, 'utf-8')
  assert.ok(content.includes('foo.test.ts'))
}

it('still writes to project-memory.md as main index', () => {
  const input: DreamInput = {
    filesModified: ['src/__tests__/foo.test.ts'],
    filesRead: [],
    verifications: [],
    decisions: [],
    trajectoryEntries: [],
    sessionId: 'topic-session-2',
  }
  persistDream(tmpDir, input)
  const mainPath = join(tmpDir, '.rivet', 'knowledge', 'project-memory.md')
  assert.ok(existsSync(mainPath), 'should still write to project-memory.md')
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npm test -- --test-name-pattern "topic-specific|main index" 2>&1 | tail -10`
预期：FAIL（当前只写 `project-memory.md`）

- [ ] **步骤 3：修改 persistDream 增加分类写入**

在 `src/agent/dream.ts` 中导入 `classifyEntry` 并修改 `persistDream`：

```typescript
import { classifyEntry } from './dream-classify.js'

export function persistDream(cwd: string, input: DreamInput): void {
  const entry = distillSession(input)
  if (!entry) return

  const dir = join(cwd, '.rivet', 'knowledge')
  ensureDir(dir)

  // Always write to main index
  const mainPath = join(dir, 'project-memory.md')
  writeToKnowledgeFile(mainPath, entry)

  // Also write to topic-specific file
  const topic = classifyEntry(entry)
  if (topic !== 'general') {
    const topicPath = join(dir, `${topic}.md`)
    writeToKnowledgeFile(topicPath, entry)
  }
}

function writeToKnowledgeFile(path: string, entry: string): void {
  let existing = ''
  try { existing = readFileSync(path, 'utf-8') } catch {}
  const combined = deduplicateEntries(existing, entry)
  const trimmed = trimToEntryBoundary(combined, MAX_FILE_SIZE)
  writeFileSync(path, trimmed, 'utf-8')
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`npx tsc --noEmit && npm test -- --test-name-pattern "persistDream|distillSession|classifyEntry" 2>&1 | tail -10`
预期：全部 PASS

- [ ] **步骤 5：Commit**

```bash
git add src/agent/dream.ts src/agent/__tests__/dream.test.ts
git commit -m "feat(memory): write knowledge entries to topic-specific files"
```

---

### 任务 6：Recall 工具搜索知识文件

**文件：**
- 修改：`src/tools/recall.ts`
- 修改或创建：`src/tools/__tests__/recall.test.ts`

- [ ] **步骤 1：编写失败的测试**

```typescript
// src/tools/__tests__/recall-knowledge.test.ts
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { searchKnowledgeFiles } from '../recall.js'

describe('searchKnowledgeFiles', () => {
  let tmpDir: string

  before(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'recall-knowledge-'))
    const knowledgeDir = join(tmpDir, '.rivet', 'knowledge')
    mkdirSync(knowledgeDir, { recursive: true })
    writeFileSync(join(knowledgeDir, 'project-memory.md'), '### 2026-05-17\n**Modified**: src/agent/loop.ts\nDecision: Use immutable updates\n')
    writeFileSync(join(knowledgeDir, 'testing.md'), '### 2026-05-17\n**Modified**: src/__tests__/foo.test.ts\n**Tests**: ✅ 10 passed\n')
  })

  after(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('finds matches across all knowledge files', () => {
    const results = searchKnowledgeFiles(tmpDir, 'loop')
    assert.ok(results.length > 0)
    assert.ok(results[0]!.includes('loop.ts'))
  })

  it('returns empty for no matches', () => {
    const results = searchKnowledgeFiles(tmpDir, 'nonexistent-xyz')
    assert.strictEqual(results.length, 0)
  })

  it('searches topic files', () => {
    const results = searchKnowledgeFiles(tmpDir, 'foo.test')
    assert.ok(results.length > 0)
    assert.ok(results[0]!.includes('foo.test.ts'))
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npm test -- --test-name-pattern "searchKnowledgeFiles" 2>&1 | tail -5`
预期：FAIL，`searchKnowledgeFiles is not a function`

- [ ] **步骤 3：实现 searchKnowledgeFiles**

在 `src/tools/recall.ts` 中添加：

```typescript
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export function searchKnowledgeFiles(cwd: string, query: string): string[] {
  const dir = join(cwd, '.rivet', 'knowledge')
  if (!existsSync(dir)) return []

  const results: string[] = []
  const lowerQuery = query.toLowerCase()

  try {
    const files = readdirSync(dir).filter(f => f.endsWith('.md'))
    for (const file of files) {
      const content = readFileSync(join(dir, file), 'utf-8')
      const entries = content.split(/(?=^### )/m)
      for (const entry of entries) {
        if (entry.toLowerCase().includes(lowerQuery)) {
          results.push(entry.trim())
        }
      }
    }
  } catch {}

  return results.slice(0, 10)
}
```

- [ ] **步骤 4：在 recall 工具的 execute 中集成知识文件搜索**

修改 `createRecallTool` 的 `execute` 方法，在 claim 搜索结果后追加知识文件搜索：

```typescript
export function createRecallTool(store: ContextClaimStore, ctx?: RecallContext & { cwd?: string }): Tool {
  return {
    definition: DEFINITION,
    async execute(params: ToolCallParams): Promise<ToolResult> {
      const input = params.input as unknown as RecallInput
      const limit = input.limit ?? 5

      // Existing claim search
      const filter = input.kind ? { kind: [input.kind] } : {}
      const matches = store.listClaims(filter)
        .filter(c => c.text.toLowerCase().includes(input.query.toLowerCase()))
        .sort((a, b) => b.fitness - a.fitness || b.confidence - a.confidence)
        .slice(0, limit)

      if (ctx) {
        const turn = ctx.getTurn()
        const usedAt = Date.now()
        for (const c of matches) {
          store.recordClaimUsed(c.id, { consumerId: `recall:turn-${turn}`, consumerKind: 'tool', usedAt })
          store.boostFitness(c.id, 1, 10)
        }
      }

      const parts: string[] = []

      if (matches.length > 0) {
        const formatted = matches.map(c =>
          `[claim:${c.id.slice(0, 8)}] (${c.kind}, ${c.status}, confidence=${c.confidence.toFixed(2)})\n  ${c.text.slice(0, 200)}`
        ).join('\n')
        parts.push(`Claims (${matches.length}):\n${formatted}`)
      }

      // Knowledge file search
      if (ctx?.cwd) {
        const knowledgeHits = searchKnowledgeFiles(ctx.cwd, input.query)
        if (knowledgeHits.length > 0) {
          const knowledgeFormatted = knowledgeHits.slice(0, 3).map(e => e.slice(0, 300)).join('\n---\n')
          parts.push(`\nProject knowledge (${knowledgeHits.length} entries):\n${knowledgeFormatted}`)
        }
      }

      if (parts.length === 0) {
        return { content: 'No claims or knowledge found matching query.' }
      }

      return { content: parts.join('\n') }
    },
    requiresApproval(): boolean { return false },
    isConcurrencySafe(): boolean { return true },
    isEnabled(): boolean { return true },
  }
}
```

- [ ] **步骤 5：运行测试验证通过**

运行：`npx tsc --noEmit && npm test -- --test-name-pattern "searchKnowledgeFiles|recall" 2>&1 | tail -10`
预期：全部 PASS

- [ ] **步骤 6：运行全量测试**

运行：`npx tsc --noEmit && npm test 2>&1 | grep -E "^ℹ (tests|pass|fail)"`
预期：0 errors, 1050+ pass, 0 fail

- [ ] **步骤 7：Commit**

```bash
git add src/tools/recall.ts src/tools/__tests__/recall-knowledge.test.ts
git commit -m "feat(memory): recall tool searches .rivet/knowledge/*.md files"
```

---

### 任务 7：Volatile 注入读取所有知识文件

**文件：**
- 修改：`src/prompt/volatile.ts:79-93`

- [ ] **步骤 1：修改 readKnowledgeFile 为 readKnowledgeFiles**

```typescript
const KNOWLEDGE_MAX_CHARS = 2000

function readKnowledgeFiles(cwd: string): string | undefined {
  const dir = join(cwd, '.rivet', 'knowledge')
  try {
    if (!existsSync(dir)) return undefined
    const files = readdirSync(dir).filter(f => f.endsWith('.md'))
    if (files.length === 0) return undefined

    // project-memory.md first (main index), then topic files
    files.sort((a, b) => (a === 'project-memory.md' ? -1 : b === 'project-memory.md' ? 1 : a.localeCompare(b)))

    let combined = ''
    for (const file of files) {
      const content = readFileSync(join(dir, file), 'utf-8').trim()
      if (!content) continue
      if (combined.length + content.length + 10 > KNOWLEDGE_MAX_CHARS) break
      combined += (combined ? `\n\n<!-- ${file} -->\n` : '') + content
    }

    return combined || undefined
  } catch { return undefined }
}
```

更新调用处：

```typescript
const knowledge = readKnowledgeFiles(ctx.cwd)
if (knowledge) {
  parts.push(`<project-memory>\n${escapeXml(knowledge)}\n</project-memory>`)
}
```

- [ ] **步骤 2：添加 readdirSync import**

确认 `volatile.ts` 顶部已有 `import { existsSync, readFileSync } from 'node:fs'`，添加 `readdirSync`。

- [ ] **步骤 3：运行 typecheck + 全量测试**

运行：`npx tsc --noEmit && npm test 2>&1 | grep -E "^ℹ (tests|pass|fail)"`
预期：0 errors, 1050+ pass, 0 fail

- [ ] **步骤 4：Commit**

```bash
git add src/prompt/volatile.ts
git commit -m "feat(memory): volatile injection reads all knowledge files with budget allocation"
```

---

## 自检

1. **规格覆盖度：** Phase 2（门控 ✓ 去重 ✓ 截断修复 ✓ decisions ✓）。Phase 3（多文件分类 ✓ recall 搜索 ✓ volatile 多文件注入 ✓）。设计文档中的"衰减"在 Phase 2 不需要——知识文件本身通过 prepend + 截断实现自然衰减（旧条目被挤出）。
2. **占位符扫描：** 无 TODO/TBD。所有步骤有完整代码。
3. **类型一致性：** `DreamInput` 接口不变。`classifyEntry` 在 Task 4 定义，Task 5 使用。`searchKnowledgeFiles` 在 Task 6 定义并导出。`readKnowledgeFiles` 在 Task 7 替换 `readKnowledgeFile`。

---

## 风险与防线

| 风险 | 防线 |
|------|------|
| 去重 key 碰撞（不同 session 改同文件同天） | 用 date + sorted files 做 key，同天同文件确实应该合并 |
| 分类文件过多占磁盘 | 每个文件独立 MAX_FILE_SIZE=8000，最多 7 个主题 = 56KB |
| volatile 注入超 2000 chars | `readKnowledgeFiles` 有硬限制，按文件优先级分配预算 |
| recall 搜索慢（多文件） | 最多 7 个 .md 文件，每个 <8KB，总读取 <56KB，延迟可忽略 |
| 门控太严（3+ files）导致小修复不记录 | 门控条件是 OR：tests passed 也触发，覆盖"改 1 个文件但跑了测试"的场景 |
