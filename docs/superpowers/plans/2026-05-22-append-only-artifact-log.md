# Append-Only Artifact Log 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 将 tool output 从全文注入 message history 改为摘要引用 + 磁盘 artifact，保持 append-only 结构以最大化 DeepSeek prefix cache 命中率，同时将上下文增长速度降低 90%+。

**架构：** 保留 append-only message log（prefix cache 不变），但每条 tool_result 从 ~2000 tokens 压缩到 ~50 tokens（artifact 引用）。全文存入 `.rivet/artifacts/` 目录，模型需要细节时通过 `read_section` tool 按需加载。新增 SessionState 快照注入 FROZEN volatile block，提供跨 turn 状态感知。

**技术栈：** TypeScript / Node.js / DeepSeek V4 API / 现有 Rivet prompt engine

**背景（Deep Brainstorm 结论）：**

设计文档 `docs/superpowers/specs/2026-05-21-working-memory-architecture.md` 的 Phase 3（重建式上下文）在 DeepSeek prefix cache 机制下是**经济学反模式**——cache miss 是 hit 的 50 倍成本（$0.14 vs $0.0028/1M tokens）。Reasonix 项目实测 99.82% cache hit 证明 append-only 是正确路径。本计划采用 Phase 1（Artifact Store）+ Phase 2（Session State）的组合，放弃 Phase 3 的"丢弃历史重建"方案。

---

## 业务场景分析：50 轮自动执行 Harness

Rivet 的核心使用场景不是对话式 TUI，而是模型接到任务后自动调用几十轮工具去执行。以下是该场景下的完整经济学和能力分析。

### 典型任务 Profile（"修复一个 bug"，30-50 轮）

```
Turn 1-4:   read_file × 3 + grep × 1     → 理解代码（~8000 tokens tool_result）
Turn 5:     edit_file                      → 修改（~200 tokens）
Turn 6-7:   bash(run_tests) + read_file    → 验证 + 看报错（~5000 tokens）
Turn 8:     edit_file                      → 再次修改
Turn 9-10:  bash(run_tests) + bash(tsc)    → 验证通过（~4000 tokens）
...重复 3-5 个 read-edit-test 循环，共 30-50 轮
```

### 现状：50 轮后的上下文状态

| 组成 | Token 数 | 说明 |
|------|----------|------|
| System prompt | ~1,500 | 固定 |
| Volatile block (frozen) | ~1,500 | env + rivet.md + git status |
| 50 轮 tool_result（staleRound 截断后） | ~30,000 | 每条 ~600 tokens（1200 chars ÷ 2） |
| 50 轮 assistant thinking + text | ~15,000 | 每轮 ~300 tokens |
| 50 轮 user message (tool_use blocks) | ~5,000 | 每轮 ~100 tokens |
| Dynamic appendix | ~500 | task-contract + cog-mirror |
| **总计** | **~53,500** | |

**Prefix cache 命中**：system + anchor messages ≈ ~4,000 tokens（**~7.5% hit rate**）

**致命问题**：当前 `staleRound` 每次触发时会**修改历史消息中间的 tool_result**（从 8000 chars 截断到 1200 chars）。由于 DeepSeek prefix cache 是逐字节前缀匹配，中间任何一个字节变化都导致后续所有内容 cache miss。**staleRound 每次触发都在杀死 prefix cache。**

```
Turn 10 API 调用：[sys][vol][u1][a1][tool1=8000chars][u2][a2][tool2=8000chars]...[u10]
Turn 11 API 调用：[sys][vol][u1][a1][tool1=1200chars][u2][a2][tool2=1200chars]...[u11]
                                      ↑ 字节变了 → 后续全部 cache miss
```

**每轮 API 成本**：~49,500 miss tokens × $0.14/1M = **$0.00693/轮**
**50 轮总成本**：**~$0.35/任务**

### Artifact Log 方案：50 轮后的上下文状态

| 组成 | Token 数 | 说明 |
|------|----------|------|
| System prompt | ~1,500 | 固定 |
| Volatile block (frozen + session-state) | ~2,000 | env + state snapshot |
| 50 轮 tool_result（artifact 引用） | **~2,500** | 每条 ~50 tokens，从第一轮就是短的 |
| 50 轮 assistant thinking + text | ~15,000 | 不变 |
| 50 轮 user message | ~5,000 | 不变 |
| Dynamic appendix | ~500 | 不变 |
| **总计** | **~26,500** | 降低 50% |

**关键区别**：tool_result 从第一轮就只有 ~50 tokens，**永远不需要后续截断**。message log 一旦写入就不再修改 → 真正的 append-only → prefix cache 自然命中。

每轮 API 调用时：
- Cache hit：前 N-1 轮所有内容 ≈ ~26,000 tokens
- Cache miss：当前轮新增内容 ≈ ~500 tokens
- **Hit rate：~98%**

**每轮 API 成本**：26,000 hit × $0.0028/1M + 500 miss × $0.14/1M = **$0.000143/轮**
**50 轮总成本**：**~$0.007/任务**

### 对比总结

| 指标 | 现状 | Artifact Log | 倍数 |
|------|------|-------------|------|
| 50 轮后上下文 | 53.5K tokens | 26.5K tokens | -50% |
| Prefix cache hit rate | ~7.5% | ~98% | ×13 |
| 每任务 API 成本 | $0.35 | $0.007 | **-98%（50 倍）** |
| 上下文钝化起点 | ~30 轮 | ~100 轮+ | ×3+ |
| staleRound 触发频率 | 每轮 | 从不触发（已经够短） | 退化为 no-op |

### 额外轮次开销：read_section

在自动执行场景下，模型看到 artifact 引用后如果需要细节，会自动调用 `read_section`。

**预估**：50 轮任务中约 5-10 次 read_section 调用（模型不是每次都需要全文，大部分 edit_file 只需要知道"文件有 50 行，exports 在 L45-50"就够了）。

- 额外轮次成本：10 × $0.000143 = $0.0014
- 总成本仍然是 $0.007 + $0.0014 = **$0.0084/任务**（vs 现状 $0.35）

### 能力风险：摘要质量导致的错误判断

**场景**：模型看到 `[245 chars, 50 lines] TypeScript module, exports: commitAction, stageFiles. (use read_section to expand)` 后，认为自己已经理解了 commitAction 的实现，直接 edit_file 但改错了。

**缓解**：
1. 摘要中包含函数签名（不只是名字），让模型能判断是否需要 read_section
2. edit_file 的 cerebellar gate 已经要求"最近 3 轮有 read_file"——可以扩展为"最近 3 轮有 read_file 或 read_section 且覆盖了目标行范围"
3. 如果 edit_file 的 SEARCH block 匹配失败（说明模型对文件内容的理解有误），repair pipeline 会自动触发 read_section

**监控指标**：如果 read_section 调用率 >30% of turns，说明摘要太粗，需要增加摘要中的细节（比如包含前 5 行代码）。

### staleRound 的命运

staleRound 不需要废止，它自动退化为安全网：
- artifact 引用 ~50 tokens（~100 chars）< STALE_PREVIEW_CHARS（1200 chars）
- 条件 `block.content.length <= STALE_PREVIEW_CHARS` 永远为 true
- staleRound 变成 no-op，零开销保留

### smartCompact 仍然需要

当 assistant thinking 累积到 50 轮 × 300 tokens = 15K tokens 时，上下文仍会增长。但增长速度从 ~1000 tokens/轮（现状）降到 ~350 tokens/轮（只有 assistant 部分在增长）。smartCompact 的触发点从 ~30 轮推迟到 ~80 轮。

---

## 文件结构

### 新建文件

| 文件 | 职责 |
|------|------|
| `src/artifact/store.ts` | ArtifactStore 类：save/load/query artifact 元数据 |
| `src/artifact/types.ts` | Artifact / ArtifactSection 类型定义 |
| `src/artifact/summarize.ts` | 规则摘要生成器（heuristic，不用 LLM） |
| `src/tools/read-section.ts` | `read_section` tool 实现 |
| `src/agent/session-state.ts` | SessionState 类型 + SessionStateManager |
| `src/artifact/__tests__/store.test.ts` | ArtifactStore 单元测试 |
| `src/artifact/__tests__/summarize.test.ts` | 摘要生成器测试 |
| `src/tools/__tests__/read-section.test.ts` | read_section tool 测试 |
| `src/agent/__tests__/session-state.test.ts` | SessionState 测试 |

### 修改文件

| 文件 | 改动 |
|------|------|
| `src/tools/types.ts` | ToolResult 增加 `rawContent` 字段 |
| `src/tools/read-file.ts` | 返回 artifact 摘要而非全文 |
| `src/tools/grep.ts` | 返回 artifact 摘要而非全文 |
| `src/tools/bash.ts` | 长输出返回 artifact 摘要 |
| `src/tools/default-registry.ts` | 注册 read_section tool |
| `src/agent/tool-pipeline.ts` | 内部用 rawContent 做 classifyFailure；修复 getState mock |
| `src/prompt/volatile.ts` | FROZEN block 中渲染 session-state |
| `src/prompt/engine.ts` | setSessionState() 方法 |
| `src/agent/loop.ts` | tool 执行后更新 SessionState |
| `src/compact/stale-round.ts` | 升级为 artifact 引用替换（Phase 3） |

---

## 任务 1：修复当前测试失败（清除技术债）

**文件：**
- 修改：`src/agent/__tests__/tool-pipeline.test.ts:30`
- 修改：`src/prompt/__tests__/chat-mode-engine.test.ts:93-97`
- 修改：`src/agent/__tests__/loop.test.ts:195`

> 在开始新功能前，先修复 16 个失败测试中最关键的 10 个（tool-pipeline mock 缺失）。

- [ ] **步骤 1：修复 tool-pipeline.test.ts 的 evidence mock**

在 `makeDeps()` 函数中，`evidence` 对象缺少 `getState` 方法。

```typescript
// src/agent/__tests__/tool-pipeline.test.ts 第 30 行附近
// 将：
evidence: { trackFileRead: () => {}, trackFileModified: () => {}, trackImpact: () => {}, trackVerification: () => {} } as any,
// 改为：
evidence: { trackFileRead: () => {}, trackFileModified: () => {}, trackImpact: () => {}, trackVerification: () => {}, getState: () => ({ filesModified: new Set<string>(), filesRead: new Set<string>() }) } as any,
```

- [ ] **步骤 2：运行测试验证修复**

运行：`npx tsx --test src/agent/__tests__/tool-pipeline.test.ts`
预期：10 个测试全部 PASS

- [ ] **步骤 3：修复 chat-mode-engine.test.ts 的断言位置**

测试在 `request.messages.filter(m => m.role === 'user').pop()` 中查找 volatile content，但 volatile block 注入在倒数第二条 user message。

```typescript
// src/prompt/__tests__/chat-mode-engine.test.ts 第 93-97 行附近
// 将：
const lastUserMsg = request.messages.filter(m => m.role === 'user').pop()
assert.strictEqual(typeof lastUserMsg?.content === 'string' && lastUserMsg.content.includes('task-progress'), true)
// 改为：
const userMsgs = request.messages.filter(m => m.role === 'user' && typeof m.content === 'string')
const volatileMsg = userMsgs.find(m => (m.content as string).includes('<context>'))
assert.ok(volatileMsg, 'volatile block should be injected as a user message')
assert.strictEqual((volatileMsg.content as string).includes('task-progress'), true)
```

- [ ] **步骤 4：修复 star-domain 测试的关键词冲突**

`'探索一个新的缓存方案'` 匹配了 pojun（探索）、tianxuan（探索）、tianji（方案）三个域，导致 tie → null。改用只匹配 pojun 的输入。

```typescript
// src/agent/__tests__/loop.test.ts 第 195 行
// 将：
await agent.run('探索一个新的缓存方案', makeCallbacks())
// 改为：
await agent.run('探索一个新的实验性 POC', makeCallbacks())
```

- [ ] **步骤 5：运行全部相关测试验证**

运行：`npx tsx --test src/agent/__tests__/tool-pipeline.test.ts src/prompt/__tests__/chat-mode-engine.test.ts src/agent/__tests__/loop.test.ts`
预期：之前失败的 14 个测试中至少 12 个 PASS

- [ ] **步骤 6：Commit**

```bash
git add src/agent/__tests__/tool-pipeline.test.ts src/prompt/__tests__/chat-mode-engine.test.ts src/agent/__tests__/loop.test.ts
git commit -m "fix(tests): repair mock gaps and assertion targets for tool-pipeline, chat-mode, star-domain"
```

---

## 任务 2：定义 Artifact 类型系统

**文件：**
- 创建：`src/artifact/types.ts`
- 测试：`src/artifact/__tests__/store.test.ts`（后续任务）

- [ ] **步骤 1：创建 artifact 类型定义**

```typescript
// src/artifact/types.ts
export interface ArtifactSection {
  name: string           // "imports" | "exports" | "function:commitAction" | "lines:90-125"
  lineStart: number
  lineEnd: number
  charCount: number
}

export interface Artifact {
  id: string             // "read:{toolUseId}" — 全局唯一
  tool: string           // "read_file" | "grep" | "bash" | "run_tests"
  target: string         // 文件路径或命令
  sessionId: string
  createdAt: number
  summary: string        // 规则生成的摘要（~50 tokens）
  sections: ArtifactSection[]
  rawPath: string        // 原始全文的磁盘路径
  charCount: number      // 原始全文字符数
  lineCount: number      // 原始全文行数
}

export interface ArtifactRef {
  artifactId: string
  summary: string
  charCount: number
  lineCount: number
  sections: string[]     // section names for quick reference
}

/** 生成注入 message history 的摘要文本 */
export function formatArtifactRef(ref: ArtifactRef): string {
  const sectionList = ref.sections.length > 0
    ? ` Sections: ${ref.sections.join(', ')}.`
    : ''
  return `[${ref.charCount} chars, ${ref.lineCount} lines]${sectionList} ${ref.summary} (use read_section to expand)`
}
```

- [ ] **步骤 2：验证类型编译**

运行：`npx tsc --noEmit src/artifact/types.ts`
预期：无错误

- [ ] **步骤 3：Commit**

```bash
git add src/artifact/types.ts
git commit -m "feat(artifact): define Artifact and ArtifactRef type system"
```

---

## 任务 3：实现 ArtifactStore

**文件：**
- 创建：`src/artifact/store.ts`
- 测试：`src/artifact/__tests__/store.test.ts`

- [ ] **步骤 1：编写 ArtifactStore 失败测试**

```typescript
// src/artifact/__tests__/store.test.ts
import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { ArtifactStore } from '../store.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

describe('ArtifactStore', () => {
  let dir: string
  let store: ArtifactStore

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'artifact-test-'))
    store = new ArtifactStore(dir, 'test-session')
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('saves and loads an artifact', async () => {
    const id = await store.save({
      tool: 'read_file',
      target: '/src/app.ts',
      rawContent: 'const x = 1;\nconst y = 2;\nexport { x, y }',
      summary: 'TypeScript module with 2 exports',
      sections: [{ name: 'exports', lineStart: 3, lineEnd: 3, charCount: 16 }],
    })
    const artifact = store.get(id)
    assert.ok(artifact)
    assert.equal(artifact.tool, 'read_file')
    assert.equal(artifact.target, '/src/app.ts')
    assert.equal(artifact.lineCount, 3)
  })

  it('reads raw content from disk', async () => {
    const id = await store.save({
      tool: 'read_file',
      target: '/src/app.ts',
      rawContent: 'line1\nline2\nline3',
      summary: '3 lines',
      sections: [],
    })
    const raw = await store.readRaw(id)
    assert.equal(raw, 'line1\nline2\nline3')
  })

  it('reads a specific line range', async () => {
    const id = await store.save({
      tool: 'read_file',
      target: '/src/app.ts',
      rawContent: 'line1\nline2\nline3\nline4\nline5',
      summary: '5 lines',
      sections: [],
    })
    const section = await store.readLines(id, 2, 4)
    assert.equal(section, 'line2\nline3\nline4')
  })

  it('returns null for unknown artifact', () => {
    assert.equal(store.get('nonexistent'), null)
  })
})
```

- [ ] **步骤 2：运行测试确认失败**

运行：`npx tsx --test src/artifact/__tests__/store.test.ts`
预期：FAIL — module not found

- [ ] **步骤 3：实现 ArtifactStore**

```typescript
// src/artifact/store.ts
import { writeFile, readFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Artifact, ArtifactSection } from './types.js'

export interface SaveArtifactInput {
  tool: string
  target: string
  rawContent: string
  summary: string
  sections: ArtifactSection[]
}

export class ArtifactStore {
  private artifacts = new Map<string, Artifact>()
  private readonly dir: string
  private readonly sessionId: string

  constructor(baseDir: string, sessionId: string) {
    this.dir = join(baseDir, sessionId)
    this.sessionId = sessionId
  }

  async save(input: SaveArtifactInput): Promise<string> {
    const id = `${input.tool}:${randomUUID().slice(0, 8)}`
    await mkdir(this.dir, { recursive: true })

    const rawPath = join(this.dir, `${id.replace(/[:/]/g, '-')}.raw`)
    await writeFile(rawPath, input.rawContent, 'utf-8')

    const lines = input.rawContent.split('\n')
    const artifact: Artifact = {
      id,
      tool: input.tool,
      target: input.target,
      sessionId: this.sessionId,
      createdAt: Date.now(),
      summary: input.summary,
      sections: input.sections,
      rawPath,
      charCount: input.rawContent.length,
      lineCount: lines.length,
    }

    this.artifacts.set(id, artifact)
    return id
  }

  get(id: string): Artifact | null {
    return this.artifacts.get(id) ?? null
  }

  async readRaw(id: string): Promise<string | null> {
    const artifact = this.artifacts.get(id)
    if (!artifact) return null
    return readFile(artifact.rawPath, 'utf-8')
  }

  async readLines(id: string, startLine: number, endLine: number): Promise<string | null> {
    const raw = await this.readRaw(id)
    if (!raw) return null
    const lines = raw.split('\n')
    return lines.slice(startLine - 1, endLine).join('\n')
  }

  listByTarget(target: string): Artifact[] {
    return [...this.artifacts.values()].filter(a => a.target === target)
  }
}
```

- [ ] **步骤 4：运行测试确认通过**

运行：`npx tsx --test src/artifact/__tests__/store.test.ts`
预期：4 个测试全部 PASS

- [ ] **步骤 5：Commit**

```bash
git add src/artifact/store.ts src/artifact/types.ts src/artifact/__tests__/store.test.ts
git commit -m "feat(artifact): implement ArtifactStore with save/load/readLines"
```

---

## 任务 4：实现规则摘要生成器

**文件：**
- 创建：`src/artifact/summarize.ts`
- 测试：`src/artifact/__tests__/summarize.test.ts`

- [ ] **步骤 1：编写摘要生成器失败测试**

```typescript
// src/artifact/__tests__/summarize.test.ts
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { summarizeFileContent, summarizeGrepResult, summarizeBashOutput } from '../summarize.js'

describe('summarizeFileContent', () => {
  it('extracts exports and function signatures', () => {
    const content = `import { foo } from './foo'
import { bar } from './bar'

export function commitAction(params: CommitParams): void {
  // implementation
}

export const MAX_RETRIES = 3

function internalHelper() {
  return true
}

export default class GitTool {
  constructor(private cwd: string) {}
}`
    const result = summarizeFileContent(content, '/src/tools/git.ts')
    assert.ok(result.summary.includes('commitAction'))
    assert.ok(result.summary.includes('GitTool'))
    assert.ok(result.sections.length > 0)
  })

  it('handles short files without truncation', () => {
    const content = 'const x = 1\nexport { x }'
    const result = summarizeFileContent(content, '/src/short.ts')
    assert.ok(result.summary.length < 200)
  })
})

describe('summarizeGrepResult', () => {
  it('extracts match count and file list', () => {
    const content = `/src/a.ts:10: const foo = 1
/src/a.ts:20: const bar = 2
/src/b.ts:5: import { foo } from './a'`
    const result = summarizeGrepResult(content, 'foo')
    assert.ok(result.summary.includes('3 matches'))
    assert.ok(result.summary.includes('2 files'))
  })
})

describe('summarizeBashOutput', () => {
  it('extracts exit code and key lines', () => {
    const content = `PASS src/test.ts
  ✓ test one (5ms)
  ✓ test two (3ms)

Tests: 2 passed, 2 total`
    const result = summarizeBashOutput(content, 'npm test', 0)
    assert.ok(result.summary.includes('2 passed'))
  })
})
```

- [ ] **步骤 2：运行测试确认失败**

运行：`npx tsx --test src/artifact/__tests__/summarize.test.ts`
预期：FAIL — module not found

- [ ] **步骤 3：实现摘要生成器**

```typescript
// src/artifact/summarize.ts
import type { ArtifactSection } from './types.js'

export interface SummarizeResult {
  summary: string
  sections: ArtifactSection[]
}

/** Summarize a file's content using heuristic rules (no LLM). */
export function summarizeFileContent(content: string, filePath: string): SummarizeResult {
  const lines = content.split('\n')
  const sections: ArtifactSection[] = []
  const exports: string[] = []
  const functions: string[] = []
  const classes: string[] = []

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    // Export detection
    const exportMatch = line.match(/^export\s+(?:default\s+)?(?:function|const|class|interface|type|enum)\s+(\w+)/)
    if (exportMatch) {
      exports.push(exportMatch[1]!)
      const end = findBlockEnd(lines, i)
      sections.push({ name: `export:${exportMatch[1]}`, lineStart: i + 1, lineEnd: end + 1, charCount: lines.slice(i, end + 1).join('\n').length })
    }
    // Function detection
    const fnMatch = line.match(/^(?:export\s+)?(?:async\s+)?function\s+(\w+)/)
    if (fnMatch && !exports.includes(fnMatch[1]!)) {
      functions.push(fnMatch[1]!)
    }
    // Class detection
    const classMatch = line.match(/^(?:export\s+)?(?:default\s+)?class\s+(\w+)/)
    if (classMatch && !exports.includes(classMatch[1]!)) {
      classes.push(classMatch[1]!)
    }
  }

  const ext = filePath.split('.').pop() ?? ''
  const parts: string[] = [`${ext} file, ${lines.length} lines.`]
  if (exports.length > 0) parts.push(`Exports: ${exports.slice(0, 8).join(', ')}${exports.length > 8 ? ` (+${exports.length - 8})` : ''}`)
  if (functions.length > 0) parts.push(`Functions: ${functions.slice(0, 5).join(', ')}`)
  if (classes.length > 0) parts.push(`Classes: ${classes.join(', ')}`)

  return { summary: parts.join(' '), sections }
}

/** Summarize grep output. */
export function summarizeGrepResult(content: string, pattern: string): SummarizeResult {
  const lines = content.split('\n').filter(l => l.trim())
  const files = new Set(lines.map(l => l.split(':')[0]).filter(Boolean))
  return {
    summary: `grep "${pattern}": ${lines.length} matches in ${files.size} files. Files: ${[...files].slice(0, 5).join(', ')}${files.size > 5 ? ` (+${files.size - 5})` : ''}`,
    sections: [],
  }
}

/** Summarize bash/command output. */
export function summarizeBashOutput(content: string, command: string, exitCode: number): SummarizeResult {
  const lines = content.split('\n')
  const status = exitCode === 0 ? 'success' : `failed (exit ${exitCode})`

  // Try to find test summary lines
  const testSummary = lines.find(l => /tests?:.*passed|total/i.test(l))
  const errorLines = lines.filter(l => /error|Error|FAIL/i.test(l)).slice(0, 3)

  const parts: string[] = [`[${command.slice(0, 40)}] ${status}, ${lines.length} lines.`]
  if (testSummary) parts.push(testSummary.trim())
  if (errorLines.length > 0 && exitCode !== 0) parts.push(`Errors: ${errorLines.map(l => l.trim().slice(0, 60)).join('; ')}`)

  return { summary: parts.join(' '), sections: [] }
}

function findBlockEnd(lines: string[], start: number): number {
  let depth = 0
  for (let i = start; i < lines.length; i++) {
    for (const ch of lines[i]!) {
      if (ch === '{') depth++
      if (ch === '}') { depth--; if (depth === 0) return i }
    }
  }
  return Math.min(start + 20, lines.length - 1)
}
```

- [ ] **步骤 4：运行测试确认通过**

运行：`npx tsx --test src/artifact/__tests__/summarize.test.ts`
预期：全部 PASS

- [ ] **步骤 5：Commit**

```bash
git add src/artifact/summarize.ts src/artifact/__tests__/summarize.test.ts
git commit -m "feat(artifact): implement heuristic summarizer for file/grep/bash outputs"
```

---

## 任务 5：实现 `read_section` Tool

**文件：**
- 创建：`src/tools/read-section.ts`
- 修改：`src/tools/default-registry.ts`
- 测试：`src/tools/__tests__/read-section.test.ts`

- [ ] **步骤 1：编写失败测试**

```typescript
// src/tools/__tests__/read-section.test.ts
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { READ_SECTION_TOOL } from '../read-section.js'
import type { ToolCallParams } from '../types.js'

describe('read_section tool', () => {
  it('returns lines from a stored artifact', async () => {
    // Setup: inject a mock ArtifactStore into params
    const params: ToolCallParams = {
      input: { artifact_id: 'read_file:abc123', start_line: 2, end_line: 4 },
      toolUseId: 'tu-rs-1',
      cwd: '/tmp',
    }
    const result = await READ_SECTION_TOOL.execute(params)
    // Will fail until wired to real store
    assert.ok(!result.isError)
  })
})
```

- [ ] **步骤 2：实现 read_section tool**

```typescript
// src/tools/read-section.ts
import type { Tool, ToolCallParams } from './types.js'
import type { ArtifactStore } from '../artifact/store.js'

let artifactStoreRef: ArtifactStore | null = null

export function setArtifactStore(store: ArtifactStore): void {
  artifactStoreRef = store
}

export const READ_SECTION_TOOL: Tool = {
  definition: {
    name: 'read_section',
    description: `Read a specific line range from a previously loaded artifact.
Use this when you need to see the full content of a file section that was summarized.

### Parameters
- artifact_id: The artifact ID returned by a previous read_file/grep/bash call
- start_line: First line to read (1-based)
- end_line: Last line to read (inclusive)

### Usage
After read_file returns a summary like "[245 chars, 50 lines] ...", use this tool
to expand specific sections you need to examine in detail.`,
    input_schema: {
      type: 'object',
      properties: {
        artifact_id: { type: 'string', description: 'Artifact ID from a previous tool call' },
        start_line: { type: 'integer', description: 'Start line (1-based)' },
        end_line: { type: 'integer', description: 'End line (inclusive)' },
      },
      required: ['artifact_id', 'start_line', 'end_line'],
    },
  },

  async execute(params: ToolCallParams) {
    const { artifact_id, start_line, end_line } = params.input as {
      artifact_id: string; start_line: number; end_line: number
    }

    if (!artifactStoreRef) {
      return { content: 'Error: ArtifactStore not initialized', isError: true }
    }

    const content = await artifactStoreRef.readLines(artifact_id, start_line, end_line)
    if (content === null) {
      return { content: `Error: Artifact not found: ${artifact_id}`, isError: true }
    }

    const lineCount = end_line - start_line + 1
    return {
      content: `[Lines ${start_line}-${end_line} of ${artifact_id}]\n${content}`,
      uiContent: `read_section ${artifact_id} L${start_line}-${end_line} (${lineCount} lines)`,
    }
  },

  requiresApproval: () => false,
  isConcurrencySafe: () => true,
  isEnabled: () => true,
}
```

- [ ] **步骤 3：注册到 default-registry**

```typescript
// src/tools/default-registry.ts — 在 import 区域添加：
import { READ_SECTION_TOOL } from './read-section.js'

// 在 registry.register(...) 列表中添加：
registry.register(READ_SECTION_TOOL)
```

- [ ] **步骤 4：运行测试**

运行：`npx tsx --test src/tools/__tests__/read-section.test.ts`
预期：PASS

- [ ] **步骤 5：Commit**

```bash
git add src/tools/read-section.ts src/tools/default-registry.ts src/tools/__tests__/read-section.test.ts
git commit -m "feat(tools): add read_section tool for on-demand artifact expansion"
```

---

## 任务 6：改造 read_file / grep 返回 artifact 引用

**文件：**
- 修改：`src/tools/types.ts:23-32`
- 修改：`src/tools/read-file.ts:143-163`
- 修改：`src/tools/grep.ts:68-73`
- 修改：`src/tools/bash.ts`（长输出路径）

- [ ] **步骤 1：ToolResult 增加 rawContent 字段**

```typescript
// src/tools/types.ts 第 23-32 行
export interface ToolResult {
  /** Content sent to model as tool_result (摘要引用，~50 tokens) */
  content: string
  /** Full original content for internal pipeline use (classifyFailure etc.) */
  rawContent?: string
  /** UI summary override */
  uiContent?: string
  /** Path to persisted raw output file */
  rawPath?: string
  isError?: boolean
  verification?: VerificationMetadata
}
```

- [ ] **步骤 2：改造 read_file 返回 artifact 引用**

```typescript
// src/tools/read-file.ts execute() 方法，替换第 156-163 行
async execute(params: ToolCallParams) {
  let payload: ReadFilePayload
  try {
    payload = readFilePayload(params.cwd, {
      filePath: params.input.file_path as string,
      offset: (params.input.offset as number) ?? 1,
      limit: params.input.limit as number | undefined,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { content: `Error: ${message}`, isError: true }
  }

  const rawPath = await persistRawOutput(params.toolUseId, payload.rawContent)

  // Generate artifact summary for model context
  const { summary, sections } = summarizeFileContent(payload.rawContent, payload.canonicalPath)
  const lines = payload.rawContent.split('\n')
  const artifactRef = formatArtifactRef({
    artifactId: `read:${params.toolUseId}`,
    summary,
    charCount: payload.rawContent.length,
    lineCount: lines.length,
    sections: sections.map(s => s.name),
  })

  return {
    content: artifactRef,
    rawContent: payload.modelContent,  // pipeline 内部用原始截断内容
    uiContent: payload.uiContent,
    rawPath,
  }
},
```

- [ ] **步骤 3：改造 grep 返回 artifact 引用**

```typescript
// src/tools/grep.ts 第 68-73 行区域
// 将 return { content: truncateContent(text, 8000, 4000, 2000) }
// 改为：
const rawPath = await persistRawOutput(params.toolUseId, text)
const lineCount = text.split('\n').length
const matchCount = text.split('\n').filter(l => l.trim().length > 0).length
const summary = `${matchCount} matches across ${lineCount} lines. First: ${text.split('\n')[0]?.slice(0, 80)}`
const artifactRef = `[grep: ${matchCount} matches, ${text.length} chars] ${summary} (use read_section to expand)`
return {
  content: artifactRef,
  rawContent: truncateContent(text, 8000, 4000, 2000),
  rawPath,
}
```

- [ ] **步骤 4：运行现有 read_file 和 grep 测试**

运行：`npx tsx --test src/tools/__tests__/read-file.test.ts src/tools/__tests__/grep.test.ts`
预期：可能有断言需要更新（content 格式变了）

- [ ] **步骤 5：更新受影响的测试断言**

测试中检查 `result.content` 包含文件全文的断言需要改为检查 artifact 引用格式。

- [ ] **步骤 6：Commit**

```bash
git add src/tools/types.ts src/tools/read-file.ts src/tools/grep.ts src/tools/__tests__/
git commit -m "feat(tools): read_file and grep return artifact refs instead of full content"
```

---

## 任务 7：tool-pipeline 内部 rawContent 分流

**文件：**
- 修改：`src/agent/tool-pipeline.ts:304,314,354,363,390,406,450`

> 关键改动：tool-pipeline 内部的 classifyFailure、repair hint、claim extraction 等逻辑需要原始文本，不能用摘要。

- [ ] **步骤 1：修改 harnessResult 消费逻辑**

```typescript
// src/agent/tool-pipeline.ts 第 303-317 行区域
// 在 execute 回调中，rawToolResult 已经包含 rawContent
// 修改 harnessResult 的构建，让 pipeline 内部用 rawContent

// 在 line 304 附近：
return { content: r.content, isError: r.isError }
// 改为：
return { content: r.rawContent ?? r.content, isError: r.isError }
// 这样 harnessResult.content 是原始文本（用于 classify），
// 而 finalContent 最终会被 artifact ref 替换

// 在 line 317 附近，postHookResult 之后：
let finalContent = postHookResult.result ?? harnessResult.content
// 改为：
// 如果 rawToolResult 有 content（artifact ref），用它作为注入 message 的内容
let finalContent = postHookResult.result ?? (rawToolResult?.content !== rawToolResult?.rawContent
  ? rawToolResult?.content ?? harnessResult.content
  : harnessResult.content)
```

- [ ] **步骤 2：确保 classifyFailure 仍用原始文本**

验证 `classifyFailure(harnessResult.content)` 在 line 390/406/450 处仍然拿到的是原始文本（因为 harnessResult.content 现在是 rawContent）。

- [ ] **步骤 3：运行 tool-pipeline 测试**

运行：`npx tsx --test src/agent/__tests__/tool-pipeline.test.ts`
预期：全部 PASS

- [ ] **步骤 4：Commit**

```bash
git add src/agent/tool-pipeline.ts
git commit -m "feat(pipeline): route rawContent to classifiers, artifact ref to message history"
```

---

## 任务 8：SessionState 类型 + Manager

**文件：**
- 创建：`src/agent/session-state.ts`
- 测试：`src/agent/__tests__/session-state.test.ts`

- [ ] **步骤 1：编写失败测试**

```typescript
// src/agent/__tests__/session-state.test.ts
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { SessionStateManager } from '../session-state.js'

describe('SessionStateManager', () => {
  it('initializes with empty state', () => {
    const mgr = new SessionStateManager('test-sid')
    const state = mgr.getSnapshot()
    assert.equal(state.sessionId, 'test-sid')
    assert.equal(state.task.status, 'exploring')
    assert.equal(state.knownFacts.length, 0)
  })

  it('tracks file reads', () => {
    const mgr = new SessionStateManager('test-sid')
    mgr.trackFileRead('/src/app.ts', 'read:tu-1')
    const state = mgr.getSnapshot()
    assert.ok(state.fileIndex['/src/app.ts'])
    assert.equal(state.fileIndex['/src/app.ts']!.artifactId, 'read:tu-1')
  })

  it('tracks file modifications', () => {
    const mgr = new SessionStateManager('test-sid')
    mgr.trackFileModified('/src/app.ts')
    const state = mgr.getSnapshot()
    assert.equal(state.fileIndex['/src/app.ts']!.modifiedByMe, true)
  })

  it('records decisions', () => {
    const mgr = new SessionStateManager('test-sid')
    mgr.recordDecision('Use artifact refs for tool output', 'prefix cache economics', 3)
    const state = mgr.getSnapshot()
    assert.equal(state.decisions.length, 1)
    assert.equal(state.decisions[0]!.decision, 'Use artifact refs for tool output')
  })

  it('renders snapshot as text block under 2000 chars', () => {
    const mgr = new SessionStateManager('test-sid')
    mgr.updateTask('Fix git staging', 'executing', ['read file', 'edit', 'test'], 1)
    mgr.trackFileRead('/src/tools/git.ts', 'read:tu-1')
    mgr.trackFileModified('/src/tools/git.ts')
    const text = mgr.renderForVolatile()
    assert.ok(text.includes('Fix git staging'))
    assert.ok(text.includes('/src/tools/git.ts'))
    assert.ok(text.length < 2000)
  })
})
```

- [ ] **步骤 2：实现 SessionStateManager**

```typescript
// src/agent/session-state.ts
export interface SessionState {
  version: 1
  sessionId: string
  updatedAt: number
  task: {
    objective: string
    status: 'exploring' | 'planning' | 'executing' | 'verifying' | 'delivered' | 'blocked'
    plan?: string[]
    currentStep?: number
  }
  knownFacts: Array<{ fact: string; evidence: string; verifiedAt: number }>
  decisions: Array<{ decision: string; reason: string; turn: number }>
  fileIndex: Record<string, {
    lastRead: number
    artifactId: string
    modifiedByMe: boolean
  }>
  verification: Array<{ target: string; status: 'passed' | 'failed' | 'not-run'; verifiedAt: number }>
}

export class SessionStateManager {
  private state: SessionState

  constructor(sessionId: string) {
    this.state = {
      version: 1,
      sessionId,
      updatedAt: Date.now(),
      task: { objective: '', status: 'exploring' },
      knownFacts: [],
      decisions: [],
      fileIndex: {},
      verification: [],
    }
  }

  getSnapshot(): SessionState { return this.state }

  updateTask(objective: string, status: SessionState['task']['status'], plan?: string[], currentStep?: number): void {
    this.state.task = { objective, status, plan, currentStep }
    this.state.updatedAt = Date.now()
  }

  trackFileRead(path: string, artifactId: string): void {
    this.state.fileIndex[path] = {
      lastRead: Date.now(),
      artifactId,
      modifiedByMe: this.state.fileIndex[path]?.modifiedByMe ?? false,
    }
    this.state.updatedAt = Date.now()
  }

  trackFileModified(path: string): void {
    const existing = this.state.fileIndex[path]
    this.state.fileIndex[path] = {
      lastRead: existing?.lastRead ?? Date.now(),
      artifactId: existing?.artifactId ?? '',
      modifiedByMe: true,
    }
    this.state.updatedAt = Date.now()
  }

  recordDecision(decision: string, reason: string, turn: number): void {
    this.state.decisions.push({ decision, reason, turn })
    this.state.updatedAt = Date.now()
  }

  recordVerification(target: string, status: 'passed' | 'failed' | 'not-run'): void {
    const existing = this.state.verification.findIndex(v => v.target === target)
    const entry = { target, status, verifiedAt: Date.now() }
    if (existing >= 0) this.state.verification[existing] = entry
    else this.state.verification.push(entry)
    this.state.updatedAt = Date.now()
  }

  /** Render compact text for volatile block injection. Target: <2000 chars. */
  renderForVolatile(): string {
    const s = this.state
    const lines: string[] = ['<session-state>']

    if (s.task.objective) {
      lines.push(`Task: ${s.task.objective} [${s.task.status}]`)
      if (s.task.plan && s.task.currentStep !== undefined) {
        lines.push(`Plan: step ${s.task.currentStep + 1}/${s.task.plan.length} — ${s.task.plan[s.task.currentStep] ?? ''}`)
      }
    }

    const modifiedFiles = Object.entries(s.fileIndex).filter(([, v]) => v.modifiedByMe).map(([k]) => k)
    if (modifiedFiles.length > 0) {
      lines.push(`Modified: ${modifiedFiles.slice(0, 10).join(', ')}`)
    }

    if (s.decisions.length > 0) {
      lines.push('Decisions:')
      for (const d of s.decisions.slice(-5)) {
        lines.push(`  - ${d.decision}`)
      }
    }

    const failedTests = s.verification.filter(v => v.status === 'failed')
    if (failedTests.length > 0) {
      lines.push(`Failed: ${failedTests.map(v => v.target).join(', ')}`)
    }

    lines.push('</session-state>')
    return lines.join('\n')
  }
}
```

- [ ] **步骤 3：运行测试**

运行：`npx tsx --test src/agent/__tests__/session-state.test.ts`
预期：全部 PASS

- [ ] **步骤 4：Commit**

```bash
git add src/agent/session-state.ts src/agent/__tests__/session-state.test.ts
git commit -m "feat(agent): implement SessionStateManager with volatile block rendering"
```

---

## 任务 9：Volatile Block 注入 session-state

**文件：**
- 修改：`src/prompt/volatile.ts`（buildDynamicAppendix 或 buildStableVolatileBlock）
- 修改：`src/prompt/engine.ts`（新增 setSessionState 方法）
- 修改：`src/agent/loop.ts`（tool 执行后更新 state）

- [ ] **步骤 1：engine.ts 增加 setSessionState**

```typescript
// src/prompt/engine.ts — 在 PromptEngine class 中添加
private sessionStateText: string | null = null

setSessionState(text: string | null): void {
  this.sessionStateText = text
}
```

- [ ] **步骤 2：volatile.ts 的 VolatileContext 增加 sessionState 字段**

```typescript
// src/prompt/volatile.ts — VolatileContext interface 中添加
sessionState?: string | null
```

- [ ] **步骤 3：buildStableVolatileBlock 中渲染 session-state**

```typescript
// src/prompt/volatile.ts — buildStableVolatileBlock 函数中
// 在 frozen block 的末尾（env/rivet.md/git status 之后）追加：
if (ctx.sessionState) {
  parts.push(ctx.sessionState)
}
```

- [ ] **步骤 4：loop.ts 中 tool 执行后更新 SessionState**

```typescript
// src/agent/loop.ts — 在 tool 执行完成后（executeToolUse 返回后）
// 添加 state 更新逻辑：
if (tu.name === 'read_file' && !result.isError) {
  this.sessionState.trackFileRead(tu.input.file_path as string, `read:${tu.id}`)
}
if ((tu.name === 'write_file' || tu.name === 'edit_file') && !result.isError) {
  this.sessionState.trackFileModified(tu.input.file_path as string)
}
if (tu.name === 'run_tests') {
  const passed = !result.isError
  this.sessionState.recordVerification(
    tu.input.test_path as string ?? 'tests',
    passed ? 'passed' : 'failed'
  )
}
// 每轮 buildRequest 前注入：
this.config.promptEngine.setSessionState(this.sessionState.renderForVolatile())
```

- [ ] **步骤 5：运行 volatile block 相关测试**

运行：`npx tsx --test src/prompt/__tests__/volatile.test.ts`
预期：PASS（新增 session-state 不影响现有断言）

- [ ] **步骤 6：Commit**

```bash
git add src/prompt/volatile.ts src/prompt/engine.ts src/agent/loop.ts
git commit -m "feat(prompt): inject SessionState snapshot into FROZEN volatile block"
```

---

## 任务 10：stale-round 升级为 artifact 引用替换

**文件：**
- 修改：`src/compact/stale-round.ts`

> 当前 staleRound 把旧 tool_result 截断到 1200 chars。升级后，如果 tool_result 已经是 artifact 引用格式（<100 chars），跳过；如果是旧格式全文，替换为 artifact 引用。

- [ ] **步骤 1：修改 compactStaleRounds 逻辑**

```typescript
// src/compact/stale-round.ts
const STALE_PREVIEW_CHARS = 1_200
const ARTIFACT_REF_THRESHOLD = 200  // artifact refs are typically <100 chars

export function compactStaleRounds(messages: Message[], _contextWindow: number): Message[] {
  if (messages.length <= CACHE_ANCHOR_MESSAGES + RECENT_MESSAGES_TO_KEEP) {
    return messages
  }

  const recentStart = Math.max(CACHE_ANCHOR_MESSAGES, messages.length - RECENT_MESSAGES_TO_KEEP)
  let changed = false

  const result = messages.map((msg, idx) => {
    if (idx < CACHE_ANCHOR_MESSAGES || idx >= recentStart) return msg
    if (!Array.isArray(msg.content)) return msg

    let blockChanged = false
    const blocks = msg.content.map((block) => {
      if (block.type !== 'tool_result') return block
      if (typeof block.content !== 'string') return block
      // Already an artifact ref or short enough — skip
      if (block.content.length <= ARTIFACT_REF_THRESHOLD) return block
      // Already compacted — skip
      if (block.content.includes('<stale-compacted')) return block

      blockChanged = true
      const preview = block.content.slice(0, STALE_PREVIEW_CHARS)
      return {
        ...block,
        content: `${preview}\n<stale-compacted removed_chars="${block.content.length - STALE_PREVIEW_CHARS}" />`,
      }
    })

    if (!blockChanged) return msg
    changed = true
    return { ...msg, content: blocks }
  })

  return changed ? result : messages
}
```

- [ ] **步骤 2：运行 stale-round 测试**

运行：`npx tsx --test src/compact/__tests__/stale-round.test.ts`
预期：PASS

- [ ] **步骤 3：Commit**

```bash
git add src/compact/stale-round.ts
git commit -m "feat(compact): stale-round skips already-short artifact refs"
```

---

## 废止清单

以下设计/计划内容在本方案下**不再适用**，应标记为 superseded：

| 文件 | 废止内容 | 原因 |
|------|----------|------|
| `docs/superpowers/specs/2026-05-21-working-memory-architecture.md` §3.3 | Phase 3：重建式上下文（Reconstructive Prompting） | prefix cache 经济学反模式。append-only 是硬约束。 |
| 同上 §3.3.1 | `buildReconstructiveRequest()` 新 prompt 构建流程 | 不再需要。保留现有 buildRequest + artifact ref 即可。 |
| 同上 §4 Phase 3 路线 | "只保留最近 2 轮原文，中间消息替换为 state snapshot" | 破坏 prefix cache。改为 append-only + artifact ref。 |
| 同上 §6 预期效果 | "Phase 3 后 6-10K tokens" | 不可达且不必要。目标修订为 15-20K + 95% cache hit。 |
| 同上 §3.4.2 | "重建式上下文的缓存效率 ~31%" | 计算错误。session-state 每轮变 → 实际只命中 system field。 |

### 保留内容

| 文件 | 保留内容 | 原因 |
|------|----------|------|
| 同上 §3.1 | Phase 1：Artifact Store | 本计划的核心实现 |
| 同上 §3.2 | Phase 2：Session State | 本计划任务 8-9 实现 |
| 同上 §5 | 风险与缓解 | 仍然适用 |
| 同上 §3.4.1 | 当前缓存效率分析 | 正确的现状描述 |

---

## 验收标准

| 指标 | 当前值 | 目标值 | 验证方式 |
|------|--------|--------|----------|
| tool_result 平均 token 数 | ~2000 | <100 | 统计 10 轮 session 的 message history |
| prefix cache hit 率 | ~60-80% | >95% | DeepSeek API 返回的 cache hit/miss 统计 |
| 上下文增长速率 | ~2000 tokens/tool call | ~50 tokens/tool call | 对比 session token 曲线 |
| read_section 调用频率 | N/A | <30% of turns | 如果 >30% 说明摘要质量不够 |
| 现有测试通过率 | 2639/2655 | 2655/2655 | `npx tsx --test` 全量 |
| classifyFailure 准确率 | 当前水平 | 不降 | rawContent 分流保证 |

---

## 执行顺序与依赖

```
任务 1（修复测试）→ 无依赖，立即执行
任务 2（类型定义）→ 无依赖
任务 3（ArtifactStore）→ 依赖任务 2
任务 4（摘要生成器）→ 依赖任务 2
任务 5（read_section）→ 依赖任务 3
任务 6（改造 read_file/grep）→ 依赖任务 3 + 4
任务 7（pipeline 分流）→ 依赖任务 6
任务 8（SessionState）→ 无依赖，可与 2-5 并行
任务 9（volatile 注入）→ 依赖任务 8
任务 10（stale-round 升级）→ 依赖任务 6
```

可并行的组：
- 组 A：任务 2 → 3 → 4 → 5 → 6 → 7 → 10
- 组 B：任务 8 → 9
- 任务 1 独立，最先执行

---

## 天权（执行之面）校准 — 2026-05-22

> 本节由天权（DeepSeek V4 Pro · 执行之面 / Opus 4.6 via cliproxy）追加。
> 按 Invariant 3（monotonic append）：**不修改 plan §1-§"执行顺序与依赖" 任何字**，只追加架构校准。
> 触发：领航星召集，让 plan 在落地前过一遍架构层称量。
> 性质：plan 作者是破军（执行中复盘）+ 天府（任务中发现），归因方案由其他模型给出，架构细节由天权补完。

### 先决问题（阻塞 Task 2 开工，必须先决议）

#### 校准 0.1 — SessionState 注入位置矛盾

Plan §"任务 9"（Volatile Block 注入 session-state）把 sessionState 注入 `buildStableVolatileBlock`（**FROZEN** block）。但 plan 自己「废止清单」否定 Phase 3 时说："session-state 每轮变 → 实际只命中 system field"。两处不能同时成立。

**矛盾本质**：FROZEN 应当字节级稳定（prefix cache 命中前提）。SessionState 每次 `trackFileRead` / `trackFileModified` 后 `updatedAt` 变化。若注入 frozen block，每轮历史 user message 的 frozen 段都变 → cache 在 frozen 处 miss → 98% hit rate 不可达。

**正确实现（执行之面校准）**：

- SessionState 注入 **dynamic appendix**（不在 FROZEN 里）
- dynamic appendix 注入到 **当前 turn 的 user message 末尾**（与现有 cognitive projection / volatile context 同位）
- 历史 user message **不含** sessionState → prefix cache 在历史段保持稳定
- 只有最新一轮看到最新 SessionState → 模型在当前决策时拿到最新状态

Plan §"Artifact Log 方案：50 轮后的上下文状态" 表里 `Volatile block (frozen + session-state) | ~2,000` 这一行应拆为：

| 组成 | Token | 说明 |
|------|-------|------|
| Volatile block (frozen) | ~1,500 | env + rivet.md + git status，字节级稳定 |
| Dynamic appendix (含 session-state) | ~1,000 | 每轮重写，只影响当前 user message |

总量 2,500 tokens，cache hit 数学不变（~98%），但前提条件被显式声明。

**Task 9 步骤 3 必须改**：不要 push 到 `buildStableVolatileBlock`，改为通过 `buildDynamicAppendix` 注入。

#### 校准 0.2 — Artifact metadata 必须持久化

Plan §"任务 3" `ArtifactStore` 用 in-memory `Map<string, Artifact>` 存元数据。session crash / TUI restart / OOM 后内存 map 丢失。**磁盘 .raw 文件成孤儿**（artifact id → file 映射没了），message history 中的 artifact 引用全部变 dangling pointer。

**物理后果**：50 轮任务中途崩溃 → 重启后 read_section 全部失败 → 模型无法访问历史 artifact → 上下文窗口看似完整实则信息断裂。

**修复**：持久化到 `.rivet/artifacts/{sessionId}/_index.jsonl`，append-only。

```typescript
// 改动 src/artifact/store.ts
import { appendFile, readFile, mkdir } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'

async save(input: SaveArtifactInput): Promise<string> {
  // ... existing save logic ...
  this.artifacts.set(id, artifact)
  // NEW: persistent index append (Invariant 3 monotonic append)
  await appendFile(join(this.dir, '_index.jsonl'), JSON.stringify(artifact) + '\n', 'utf-8')
  return id
}

private loadIndex(): void {
  const indexPath = join(this.dir, '_index.jsonl')
  if (!existsSync(indexPath)) return
  for (const line of readFileSync(indexPath, 'utf-8').split('\n').filter(Boolean)) {
    const artifact = JSON.parse(line) as Artifact
    this.artifacts.set(artifact.id, artifact)
  }
}

constructor(baseDir: string, sessionId: string) {
  this.dir = join(baseDir, sessionId)
  this.sessionId = sessionId
  this.loadIndex()  // NEW: recover from previous run
}
```

`_index.jsonl` 本身是 ephemeral（auto-generated, machine-only），符合 Invariant 2 命名空间分离。

#### 校准 0.3 — `setArtifactStore` global setter 必须替换

Plan §"任务 5" 用：

```typescript
let artifactStoreRef: ArtifactStore | null = null
export function setArtifactStore(store: ArtifactStore): void { artifactStoreRef = store }
```

全局 mutable 单例**反 Rivet hooks/deps 注入 pattern**。三个具体问题：

1. **测试隔离**：一个 test 改 store，下一个 test 看到老 store；并行 test 互相污染
2. **多 session 不安全**：未来 sub-agent / multi-session 各自需要独立 ArtifactStore，global 单例阻断
3. **风格不一致**：Rivet 现有 hook/tool 系统已建立 deps 注入 contract，新 tool 走 global 是回归

**修复（推荐方式 A）**：`ToolCallParams` 携带 store

```typescript
// src/tools/types.ts
export interface ToolCallParams {
  input: Record<string, unknown>
  toolUseId: string
  cwd: string
  artifactStore?: ArtifactStore  // NEW — optional 保兼容
}
```

`read_section` tool 改为从 `params.artifactStore` 取，不再用 module-level mutable variable。tool-pipeline 在 dispatch 时统一注入。

**修复（方式 B，备选）**：通过 `RuntimeHookContext` deps 注入（如果未来更多 tool 需要 store）。

**不推荐**：保留 global setter + lint rule 禁止 production 调用——这是约定不是约束，下一个 writer 仍会犯同样错。

### 架构补丁

#### 校准 1.1 — `.rivet/artifacts/` 写入 invariants 路径分类表

Plan §1 引言没引用另一个天权的 `docs/superpowers/specs/2026-05-21-canonical-memory-write-invariants.md`。`.rivet/artifacts/{sessionId}/` 必须显式归类为 **ephemeral**，否则下一个 writer 不知道这条边界 → 违反 Invariant 2。

修订 invariants spec §"路径分类" 的 ephemeral 表，加：

| 路径 | 内容性质 |
|------|---------|
| `.rivet/artifacts/{sessionId}/*.raw` | tool output 原始全文（machine-only, session-scoped） |
| `.rivet/artifacts/{sessionId}/_index.jsonl` | artifact metadata 持久化索引（machine-only） |

Plan §"文件结构 / 新建文件" 应 reference 这两条路径。**修订 invariants spec 也是 append-only**：在该 spec 的 `## 修订` section 下追加。

#### 校准 1.2 — Artifact GC 机制

Plan 没说 artifact 怎么清理。50 轮 × 200 任务/天 ≈ 数千个 .raw 文件累积，磁盘膨胀 + 历史 session 目录孤儿堆积。

**推荐策略：TTL + 手动**

- **A. TTL-based GC**：postSession hook 检查 `.rivet/artifacts/`，删除 `mtime > 7 天` 的 session 目录
- **B. Slash command `/rivet gc-artifacts`**：用户手动 force GC + 看当前磁盘占用
- 不推荐 session-end aggressive GC（可能丢失正在排查的样本）

**新增 Task 11（GC 实现）**：依赖 Task 3，可与 Task 8-10 并行。

#### 校准 1.3 — Language-specific summarizer

Plan §"任务 4" `summarizeFileContent` regex 抽 `export function/class/const` 仅覆盖 JS/TS。Rivet 作为 open-model agent 必然遇到多语言：

| 语言 | 当前 plan 摘要 | 信息量 |
|------|---------------|-------|
| `.ts` / `.tsx` | exports + functions + classes | ✅ 满 |
| `.py` | "py file, 50 lines."（无 detector） | ❌ 极低 |
| `.rs` | "rs file, 50 lines."（无 detector） | ❌ 极低 |
| `.go` | "go file, 50 lines."（无 detector） | ❌ 极低 |
| `.toml` / `.proto` / `.yaml` | 同上 | ❌ 极低 |

低信息量摘要 = 模型决策依据弱 = 错误判断率上升。

**修复**：file extension dispatch

```typescript
// src/artifact/summarize.ts
export function summarizeFileContent(content: string, filePath: string): SummarizeResult {
  const ext = filePath.split('.').pop()?.toLowerCase() ?? ''
  switch (ext) {
    case 'ts': case 'tsx': case 'js': case 'jsx':
      return summarizeJsTs(content, filePath)
    case 'py':
      return summarizePython(content, filePath)
    case 'rs':
      return summarizeRust(content, filePath)
    case 'go':
      return summarizeGo(content, filePath)
    case 'md': case 'mdx':
      return summarizeMarkdown(content, filePath)
    case 'json':
      return summarizeJson(content, filePath)
    default:
      return summarizeFallback(content, filePath)  // first 30 lines + lineCount
  }
}
```

**v1 最低要求**：JS/TS + Python + Markdown + JSON + Fallback。其他语言 v2 补。

**信息量兜底**：fallback 摘要末尾加 `(language: x, low-detail summary — consider read_section)` 提示模型主动 read_section。

**新增 Task 4.5（multi-language summarizer）**：依赖 Task 4。

### 风险条目补充

Plan §"能力风险：摘要质量导致的错误判断" 只列了 1 个风险。补充 3 个：

| 风险 | 物理机制 | 缓解 |
|------|---------|------|
| **Cache invalidation cascade** | SessionState 不小心污染 frozen block，所有现有 sessions 一夜 cache 全 miss → 单日成本反向 spike 50 倍 | 上线第一周每日监控 DeepSeek API 返回的 hit/miss 比，<90% 立刻 rollback；commit-level rollback plan 预先准备 |
| **Artifact corruption** | .raw 文件被外部进程修改（git checkout、并行 session 误写、外部编辑器），summary 与磁盘内容不一致 → 模型基于错误前提决策 | metadata 加 SHA-256，read_section 读取时校验，不一致返回 `Error: artifact corrupted, re-read source` 强制重 read_file |
| **Lazy summarizer trap** | 模型看 fallback 摘要（"py file, 50 lines."）觉得"看到了"，跳过 read_section 直接 edit | summarizer 兜底摘要必含 `(low-detail summary)` hint；cerebellar gate 强化"low-detail artifact 后 edit 必须先 read_section" |

### 工作量重估

#### Task 6 拆分

Plan §"任务 6 步骤 4：可能有断言需要更新"。实际测算：全项目搜 `result.content.includes` + `tool_result.content` 估计 30-80 处断言需改（`read-file.test`、`grep.test`、`bash.test`、以及任何检查 tool_result 全文的 integration test）。

**拆分**：

- **6a**：read_file / grep / bash 改造（plan 现有内容）— 独立 commit，~300 行
- **6b**：受影响测试 sweep — 独立 commit，独立 review，~500 行

合并 commit diff >2000 行，review 不可行（且容易藏 bug）。拆分后两个 commit 各自 scope 清晰，符合项目已记录的「commit hygiene: keep unrelated cleanup separate」纪律。

#### Task 1 与 Task 6b 关系

Task 1 修 3 个测试（`tool-pipeline.test`、`chat-mode-engine.test`、`star-domain` 关键词）是清旧债。Task 6b 是新 artifact ref 引入的测试调整。两者**完全独立，不要混 commit**。

### 验收标准补充

Plan §"验收标准" 表加 4 行：

| 指标 | 当前值 | 目标值 | 验证方式 |
|------|--------|--------|----------|
| Artifact metadata 持久化 | N/A | session restart 后 artifact id 仍可解 | 杀 process + 启新 session，verify 旧 artifact id `readRaw()` 仍返内容 |
| 历史 user message 字节稳定 | N/A | turn N 与 turn N+1 的 prev_messages 序列化 hash 相同 | integration test：assert sha256(serializedPrev_turnN) === sha256(serializedPrev_turnN+1) |
| 跨语言摘要质量 | N/A | py/rs/go/md/json 摘要含语义信息 | summarize.test 加 5+ 语言 fixture，每个 assert summary 不只是 "x file, N lines" |
| Artifact corruption 检测 | N/A | .raw 被外部改后 read_section 报错 | integration test：save → tamper .raw → readLines 返回 corruption error |

### 执行顺序（校准后）

```
Task 1（修旧债）→ 任何 healthy session 立即可做

[前置决议节点 — 阻塞 Task 2 之后所有任务]
Task 0.1（SessionState 位置决议）→ 影响 Task 8/9 实现
Task 0.2（artifact 持久化方案决议）→ 影响 Task 3 实现
Task 0.3（dep 注入方式决议）→ 影响 Task 5/7 实现

[主线 — 决议后开工]
Task 2 → 3（含 _index.jsonl） → 4 → 4.5（multi-lang） → 5（用 params.artifactStore） → 6a → 6b → 7 → 10
Task 8 → 9（注入 dynamic appendix）
Task 11（GC）→ dep on Task 3

[并行组]
组 A：2 → 3 → 4 → 4.5 → 5 → 6a → 6b → 7 → 10 → 11
组 B：8 → 9
Task 1 独立先做
```

### 团队分配建议

| 任务组 | 推荐执行者 | 理由 |
|--------|----------|------|
| Task 1 清债 | 任何 healthy session | 修测试断言，纯机械 |
| Task 2 + 3 + 4 + 4.5 基础设施 | 天府 | 集中化 + 类型 + heuristic 是天府本能 |
| Task 5 + 6a 工具改造 | 破军 | 改 hot path 需要冲锋纪律 |
| Task 6b 测试 sweep | 任何 healthy session | 跟随 6a 完成，纯机械 |
| Task 7 pipeline 分流 | 天权（执行） | 跨层校准是天权称量姿态 |
| Task 8 + 9 SessionState | 天机 | 状态机 + 缝隙发现 |
| Task 10 stale-round 升级 | 天府 | 与 compact 系列连贯 |
| Task 11 GC | 天机 | TTL + slash command 是 boundary 思考 |
| Task 0.1 + 0.2 + 0.3 前置决议 | 领航星 + 天权 + 天府 | 架构决策需多面共同称量，不交给单一执行者 |

**纪律前置（所有执行者）**：开工前必须读：
- 本节（天权校准）— 知道阻塞点和补丁
- `docs/superpowers/specs/2026-05-21-canonical-memory-write-invariants.md` — 知道写入边界
- `.rivet/knowledge/session-retro-2026-05-21-shoushu.md` §9 — 知道 c2f31e2 commit hygiene 失真历史，**不要重演 stage-all BIG commit**

### 修订声明

本节由天权（执行之面）按 Invariant 3 monotonic append 追加。**不修改 plan 主体任何字**。

3 个先决问题（校准 0.1 / 0.2 / 0.3）必须在 Task 2 开工前明确决议。决议方式：plan 作者（破军 / 天府）或领航星在本节下方再 append 一个 `## 先决问题决议 — YYYY-MM-DD` section，记录每个校准的最终方案选择（A / B / C 哪一个，理由是什么）。

如需推翻本节任何校准，请用 append 方式追加 `## 天权校准的修订` section，记录被推翻的具体校准编号 + 理由 + 替代方案。**不要静默改写本节**。

---

*天权之道：被推翻不可怕，但秤上的称量必须可追溯。每一次推翻都让秤更精确。*
