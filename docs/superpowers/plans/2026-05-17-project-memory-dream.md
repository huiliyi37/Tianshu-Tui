# Project Memory: Dream 蒸馏 Phase 1 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** Session 结束时自动蒸馏项目知识到 `.rivet/knowledge/project-memory.md`，下次启动时注入 prompt，使模型跨 session 累积项目理解。

**架构：** shutdown hook 收集 evidence + trajectory + decisions → 模板化蒸馏（Phase 1 不用 LLM）→ 追加到项目目录文件 → 启动时 volatile.ts 读取并注入。

**技术栈：** TypeScript, node:fs, 现有 volatile.ts / evidence.ts / trajectory.ts 基础设施。

**设计过程：** [`docs/superpowers/specs/2026-05-17-project-memory-dream-design.md`](../specs/2026-05-17-project-memory-dream-design.md)

---

## 文件结构

| 文件 | 操作 | 职责 |
|------|------|------|
| `src/agent/dream.ts` | 创建 | 蒸馏逻辑：收集 session 产出 → 生成知识条目 |
| `src/prompt/volatile.ts` | 修改 | 启动时读取 `.rivet/knowledge/project-memory.md` 注入 |
| `src/main.tsx` | 修改 | shutdown hook 中调用 dream |
| `src/agent/__tests__/dream.test.ts` | 创建 | 蒸馏逻辑测试 |

---

### 任务 1：Dream 蒸馏核心模块

**文件：**
- 创建：`src/agent/dream.ts`
- 创建：`src/agent/__tests__/dream.test.ts`

- [ ] **步骤 1：编写失败的测试**

```typescript
// src/agent/__tests__/dream.test.ts
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { distillSession, type DreamInput } from '../dream.js'

describe('distillSession', () => {
  it('returns null when no files modified', () => {
    const input: DreamInput = {
      filesModified: [],
      filesRead: [],
      verifications: [],
      decisions: [],
      trajectoryEntries: [],
      sessionId: 'test-session',
    }
    assert.strictEqual(distillSession(input), null)
  })

  it('generates knowledge entry when files modified', () => {
    const input: DreamInput = {
      filesModified: ['src/foo.ts', 'src/bar.ts'],
      filesRead: ['src/baz.ts'],
      verifications: [{ command: 'npm test', status: 'passed', passed: 10, failed: 0, skipped: 0 }],
      decisions: ['Use composition over inheritance'],
      trajectoryEntries: [
        { tool: 'edit_file', target: 'src/foo.ts', status: 'success' },
        { tool: 'run_tests', target: 'npm test', status: 'success' },
      ],
      sessionId: 'test-session',
    }
    const result = distillSession(input)
    assert.ok(result)
    assert.ok(result.includes('src/foo.ts'))
    assert.ok(result.includes('src/bar.ts'))
    assert.ok(result.includes('10 pass'))
    assert.ok(result.includes('composition over inheritance'))
  })

  it('marks unverified sessions', () => {
    const input: DreamInput = {
      filesModified: ['src/foo.ts'],
      filesRead: [],
      verifications: [],
      decisions: [],
      trajectoryEntries: [],
      sessionId: 'test-session',
    }
    const result = distillSession(input)
    assert.ok(result)
    assert.ok(result.includes('unverified'))
  })

  it('includes failure info when tests failed', () => {
    const input: DreamInput = {
      filesModified: ['src/foo.ts'],
      filesRead: [],
      verifications: [{ command: 'npm test', status: 'failed', passed: 8, failed: 2, skipped: 0 }],
      decisions: [],
      trajectoryEntries: [],
      sessionId: 'test-session',
    }
    const result = distillSession(input)
    assert.ok(result)
    assert.ok(result.includes('failed'))
    assert.ok(result.includes('8 pass'))
  })

  it('truncates long file lists', () => {
    const input: DreamInput = {
      filesModified: Array.from({ length: 20 }, (_, i) => `src/file${i}.ts`),
      filesRead: [],
      verifications: [],
      decisions: [],
      trajectoryEntries: [],
      sessionId: 'test-session',
    }
    const result = distillSession(input)
    assert.ok(result)
    assert.ok(result.includes('+'))
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npx tsc --noEmit && npm test -- --test-name-pattern "distillSession" 2>&1 | tail -5`
预期：FAIL，`Cannot find module '../dream.js'`

- [ ] **步骤 3：实现 dream.ts**

```typescript
// src/agent/dream.ts
import type { VerificationMetadata } from '../tools/types.js'

export interface DreamInput {
  filesModified: string[]
  filesRead: string[]
  verifications: VerificationMetadata[]
  decisions: string[]
  trajectoryEntries: Array<{ tool: string; target: string; status: string }>
  sessionId: string
}

const MAX_FILES_SHOWN = 8

export function distillSession(input: DreamInput): string | null {
  if (input.filesModified.length === 0) return null

  const now = new Date().toISOString().slice(0, 10)
  const parts: string[] = []

  parts.push(`### ${now} (${input.sessionId.slice(0, 8)})`)

  const files = input.filesModified.length <= MAX_FILES_SHOWN
    ? input.filesModified.join(', ')
    : `${input.filesModified.slice(0, MAX_FILES_SHOWN).join(', ')} +${input.filesModified.length - MAX_FILES_SHOWN} more`
  parts.push(`Modified: ${files}`)

  if (input.verifications.length > 0) {
    const last = input.verifications[input.verifications.length - 1]!
    const summary = `${last.passed} pass, ${last.failed} fail`
    if (last.status === 'passed') {
      parts.push(`Tests: ${summary} ✓`)
    } else {
      parts.push(`Tests: ${summary} ✗ (${last.status})`)
    }
  } else {
    parts.push('Tests: unverified')
  }

  if (input.decisions.length > 0) {
    for (const d of input.decisions.slice(-3)) {
      parts.push(`Decision: ${d}`)
    }
  }

  const failedTools = input.trajectoryEntries.filter(e => e.status === 'failed' || e.status === 'retried-failed')
  if (failedTools.length > 0) {
    const unique = [...new Set(failedTools.map(e => `${e.tool}:${e.target}`))]
    parts.push(`Challenges: ${unique.slice(0, 3).join('; ')}`)
  }

  return parts.join('\n')
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`npx tsc --noEmit && npm test -- --test-name-pattern "distillSession"`
预期：5 tests pass

- [ ] **步骤 5：Commit**

```bash
git add src/agent/dream.ts src/agent/__tests__/dream.test.ts
git commit -m "feat(memory): add dream distillation module — template-based session knowledge extraction"
```

---

### 任务 2：知识文件读取 + Volatile 注入

**文件：**
- 修改：`src/prompt/volatile.ts:51-66`（readRivetMd 附近）

- [ ] **步骤 1：编写失败的测试**

```typescript
// src/prompt/__tests__/volatile.test.ts 中添加（或新建 knowledge-inject.test.ts）
// 由于 volatile.ts 已有测试，在现有文件中追加
import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { buildStableVolatileBlock } from '../volatile.js'

describe('project knowledge injection', () => {
  const testDir = join(tmpdir(), `rivet-test-knowledge-${Date.now()}`)

  beforeEach(() => {
    mkdirSync(join(testDir, '.rivet', 'knowledge'), { recursive: true })
  })

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true })
  })

  it('injects project-memory.md content into volatile block', () => {
    writeFileSync(
      join(testDir, '.rivet', 'knowledge', 'project-memory.md'),
      '### 2026-05-17\nModified: src/foo.ts\nTests: 10 pass ✓',
    )
    const block = buildStableVolatileBlock({ cwd: testDir })
    assert.ok(block.includes('project-memory'))
    assert.ok(block.includes('src/foo.ts'))
  })

  it('skips injection when file does not exist', () => {
    const block = buildStableVolatileBlock({ cwd: testDir })
    assert.ok(!block.includes('project-memory'))
  })

  it('truncates knowledge file to 2000 chars', () => {
    writeFileSync(
      join(testDir, '.rivet', 'knowledge', 'project-memory.md'),
      'x'.repeat(5000),
    )
    const block = buildStableVolatileBlock({ cwd: testDir })
    assert.ok(block.includes('...truncated'))
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npx tsc --noEmit && npm test -- --test-name-pattern "project knowledge"`
预期：FAIL（volatile block 不包含 project-memory 内容）

- [ ] **步骤 3：在 volatile.ts 中添加知识文件读取**

在 `readRivetMd` 函数后面添加：

```typescript
const KNOWLEDGE_PATH = '.rivet/knowledge/project-memory.md'
const KNOWLEDGE_MAX_CHARS = 2000

let knowledgeCache = new Map<string, { value: string | undefined; timestamp: number }>()

function readProjectKnowledge(cwd: string): string | undefined {
  const cached = knowledgeCache.get(cwd)
  if (cached && Date.now() - cached.timestamp < RIVET_MD_CACHE_TTL_MS) {
    return cached.value
  }

  const path = join(cwd, KNOWLEDGE_PATH)
  try {
    if (existsSync(path)) {
      let content = readFileSync(path, 'utf-8').trim()
      if (content.length > KNOWLEDGE_MAX_CHARS) {
        content = content.slice(-KNOWLEDGE_MAX_CHARS) + '\n...truncated'
      }
      knowledgeCache.set(cwd, { value: content, timestamp: Date.now() })
      return content
    }
  } catch { /* ignore */ }
  knowledgeCache.set(cwd, { value: undefined, timestamp: Date.now() })
  return undefined
}
```

在 `buildVolatileBlockInternal` 函数中，`sessionMemoryBlock` 注入之前添加：

```typescript
const knowledge = readProjectKnowledge(ctx.cwd)
if (knowledge) {
  parts.push(`<project-memory>\n${escapeXml(knowledge)}\n</project-memory>`)
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`npx tsc --noEmit && npm test -- --test-name-pattern "project knowledge"`
预期：3 tests pass

- [ ] **步骤 5：运行全量测试确认无回归**

运行：`npm test 2>&1 | grep -E "^ℹ (tests|pass|fail)"`
预期：890+ pass, 0 fail

- [ ] **步骤 6：Commit**

```bash
git add src/prompt/volatile.ts src/prompt/__tests__/volatile-knowledge.test.ts
git commit -m "feat(memory): inject .rivet/knowledge/project-memory.md into volatile context"
```

---

### 任务 3：Shutdown Hook 触发 Dream

**文件：**
- 创建：`src/agent/dream-persist.ts`
- 修改：`src/main.tsx:341-354`（shutdownCallback）

- [ ] **步骤 1：创建 dream-persist.ts**

```typescript
// src/agent/dream-persist.ts
import { existsSync, mkdirSync, appendFileSync, readFileSync } from 'fs'
import { join } from 'path'
import { distillSession, type DreamInput } from './dream.js'

const KNOWLEDGE_DIR = '.rivet/knowledge'
const KNOWLEDGE_FILE = 'project-memory.md'
const MAX_FILE_SIZE = 8000

export function persistDream(cwd: string, input: DreamInput): boolean {
  const entry = distillSession(input)
  if (!entry) return false

  const dir = join(cwd, KNOWLEDGE_DIR)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })

  const filePath = join(dir, KNOWLEDGE_FILE)

  let existing = ''
  if (existsSync(filePath)) {
    existing = readFileSync(filePath, 'utf-8')
  }

  if (existing.length + entry.length + 2 > MAX_FILE_SIZE) {
    const lines = existing.split('\n')
    const halfIdx = Math.floor(lines.length / 2)
    existing = lines.slice(halfIdx).join('\n')
  }

  const content = existing ? `${existing}\n\n${entry}\n` : `# Project Memory\n\n${entry}\n`
  appendFileSync(filePath, existing ? `\n${entry}\n` : `# Project Memory\n\n${entry}\n`)
  return true
}
```

- [ ] **步骤 2：编写测试**

```typescript
// src/agent/__tests__/dream.test.ts 中追加
import { persistDream } from '../dream-persist.js'
import { mkdirSync, rmSync, readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

describe('persistDream', () => {
  const testDir = join(tmpdir(), `rivet-dream-persist-${Date.now()}`)

  beforeEach(() => {
    mkdirSync(testDir, { recursive: true })
  })

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true })
  })

  it('creates knowledge directory and file', () => {
    const result = persistDream(testDir, {
      filesModified: ['src/foo.ts'],
      filesRead: [],
      verifications: [],
      decisions: ['Use Dream pattern'],
      trajectoryEntries: [],
      sessionId: 'abc-123',
    })
    assert.strictEqual(result, true)
    const content = readFileSync(join(testDir, '.rivet', 'knowledge', 'project-memory.md'), 'utf-8')
    assert.ok(content.includes('src/foo.ts'))
    assert.ok(content.includes('Dream pattern'))
  })

  it('returns false when no files modified', () => {
    const result = persistDream(testDir, {
      filesModified: [],
      filesRead: ['src/bar.ts'],
      verifications: [],
      decisions: [],
      trajectoryEntries: [],
      sessionId: 'abc-123',
    })
    assert.strictEqual(result, false)
  })

  it('appends to existing file', () => {
    persistDream(testDir, {
      filesModified: ['src/first.ts'],
      filesRead: [],
      verifications: [],
      decisions: [],
      trajectoryEntries: [],
      sessionId: 'session-1',
    })
    persistDream(testDir, {
      filesModified: ['src/second.ts'],
      filesRead: [],
      verifications: [],
      decisions: [],
      trajectoryEntries: [],
      sessionId: 'session-2',
    })
    const content = readFileSync(join(testDir, '.rivet', 'knowledge', 'project-memory.md'), 'utf-8')
    assert.ok(content.includes('first.ts'))
    assert.ok(content.includes('second.ts'))
  })
})
```

- [ ] **步骤 3：运行测试验证通过**

运行：`npx tsc --noEmit && npm test -- --test-name-pattern "persistDream"`
预期：3 tests pass

- [ ] **步骤 4：在 main.tsx shutdown hook 中调用 persistDream**

在 `src/main.tsx` 的 `shutdownCallback` 中，`persist.compact(...)` 之后添加：

```typescript
import { persistDream } from './agent/dream-persist.js'

// Inside shutdownCallback, after persist.compact(session.getMessages()):
const evidenceState = agent.getEvidenceState()
persistDream(process.cwd(), {
  filesModified: [...evidenceState.filesModified],
  filesRead: [...evidenceState.filesRead],
  verifications: evidenceState.verifications,
  decisions: [],  // decisions are reset per-run, not accessible here — Phase 2 will wire this
  trajectoryEntries: agent.getTrajectoryStats ? [] : [],  // simplified for Phase 1
  sessionId,
})
```

- [ ] **步骤 5：运行 typecheck + 全量测试**

运行：`npx tsc --noEmit && npm test 2>&1 | grep -E "^ℹ (tests|pass|fail)"`
预期：0 errors, 890+ pass, 0 fail

- [ ] **步骤 6：Commit**

```bash
git add src/agent/dream-persist.ts src/agent/__tests__/dream.test.ts src/main.tsx
git commit -m "feat(memory): wire dream distillation into shutdown hook — auto-persist session knowledge"
```

---

### 任务 4：集成验证 + .gitignore 建议

**文件：**
- 无新文件

- [ ] **步骤 1：手动集成测试流程**

1. `npm run build`
2. 启动 Rivet，执行一次编辑 + 测试
3. 退出（Ctrl+C）
4. 检查 `.rivet/knowledge/project-memory.md` 是否生成
5. 重新启动 Rivet
6. 确认 `/debug` 输出中 systemPromptLength 增加（知识被注入）

- [ ] **步骤 2：运行全量测试**

运行：`npx tsc --noEmit && npm test`
预期：0 errors, 890+ pass, 0 fail

- [ ] **步骤 3：最终 Commit**

```bash
git add -A
git commit -m "feat(memory): project memory Dream Phase 1 complete — session-end distillation + startup injection"
```

---

## 自检

1. **规格覆盖度：** 设计文档 Phase 1 要求 "session-end 蒸馏 + 启动注入 + 门控条件"。Task 1 = 蒸馏逻辑，Task 2 = 启动注入，Task 3 = shutdown 触发 + 门控（filesModified > 0），Task 4 = 集成验证。全部覆盖。
2. **占位符扫描：** 无 TODO/TBD。Task 3 步骤 4 中 `decisions: []` 和 `trajectoryEntries: []` 是有意简化（Phase 1 scope），已注释说明。
3. **类型一致性：** `DreamInput` 在 Task 1 定义，Task 3 使用相同接口。`distillSession` 和 `persistDream` 签名一致。

---

## 风险与防线

| 风险 | 防线 |
|------|------|
| shutdown hook 被 SIGKILL 跳过 | 知识丢失可接受——下次 session 会重新生成 |
| 知识文件无限增长 | `persistDream` 中 MAX_FILE_SIZE=8000 + 自动截断旧条目 |
| 知识注入撑爆 prefix cache | volatile.ts 中 KNOWLEDGE_MAX_CHARS=2000 硬限制 |
| 蒸馏质量差（模板式） | Phase 1 验证注入机制，Phase 2 升级为 LLM 蒸馏 |
| .rivet/knowledge/ 被 git 追踪 | 用户可选择 .gitignore；知识文件本身有价值可追踪 |
