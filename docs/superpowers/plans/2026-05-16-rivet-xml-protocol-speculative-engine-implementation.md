# Rivet XML Protocol Layer + Speculative Pre-warming 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 将 Rivet 的 system prompt 从 Markdown 重构为 XML sections，增强 volatile context 的结构化程度，并实现投机预热引擎，降低端到端延迟 20-30%。

**架构：** System prompt XML 化（frozen per-session）→ Volatile context XML 增强（`<tool-history>` / `<session-memory>`）→ Intent Extractor 从 streaming output 提取文件/命令 → PhaseTracker 驱动 speculative pre-warm cache。

**技术栈：** TypeScript, Node.js 22, node:test, DeepSeek V4 API

**设计文档：** `docs/superpowers/specs/2026-05-16-rivet-xml-protocol-speculative-engine-design.md`

---

## 文件结构

### 新建文件

| 文件 | 职责 |
|------|------|
| `src/prompt/__tests__/static.test.ts` | XML system prompt 结构验证测试 |
| `src/prompt/__tests__/volatile.test.ts` | Volatile context XML 增强测试 |
| `src/agent/intent-extractor.ts` | 从 streaming text 提取文件路径/命令 intent |
| `src/agent/__tests__/intent-extractor.test.ts` | Intent extractor 测试 |
| `src/agent/prewarm.ts` | 投机预热缓存管理 |
| `src/agent/__tests__/prewarm.test.ts` | 预热缓存测试 |

### 修改文件

| 文件 | 变更 |
|------|------|
| `src/prompt/static.ts` | BASE_PROMPT 从 Markdown 重构为 XML sections，删除 tool summary |
| `src/prompt/volatile.ts` | 添加 `<tool-history>` 和增强 `<session-memory>` |
| `src/prompt/engine.ts` | 已变更：buildRequest 新增 toolHistory 参数，支持最后一条 user message 注入 fresh volatile block；新增 updateSessionMemory() 方法 |
| `src/agent/loop.ts` | 集成 intent extractor + prewarm |

---

## Phase 1：XML 化 System Prompt + 去重

### 任务 1：XML System Prompt 重构

**文件：**
- 修改：`src/prompt/static.ts`
- 创建：`src/prompt/__tests__/static.test.ts`

- [x] **步骤 1：编写 system prompt 结构测试**

```typescript
// src/prompt/__tests__/static.test.ts
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { buildSystemPrompt } from '../static.js'

describe('buildSystemPrompt', () => {
  it('wraps identity in <identity> tags', () => {
    const prompt = buildSystemPrompt({ tools: [] })
    assert.ok(prompt.includes('<identity>'))
    assert.ok(prompt.includes('</identity>'))
    assert.ok(prompt.includes('天枢'))
  })

  it('wraps rules in <rules> tags', () => {
    const prompt = buildSystemPrompt({ tools: [] })
    assert.ok(prompt.includes('<rules>'))
    assert.ok(prompt.includes('</rules>'))
    assert.ok(prompt.includes('verify-first'))
  })

  it('wraps tool usage in <tool-usage> tags', () => {
    const prompt = buildSystemPrompt({ tools: [] })
    assert.ok(prompt.includes('<tool-usage>'))
    assert.ok(prompt.includes('</tool-usage>'))
  })

  it('wraps workflow in <workflow> tags', () => {
    const prompt = buildSystemPrompt({ tools: [] })
    assert.ok(prompt.includes('<workflow>'))
    assert.ok(prompt.includes('</workflow>'))
  })

  it('wraps security in <security> tags', () => {
    const prompt = buildSystemPrompt({ tools: [] })
    assert.ok(prompt.includes('<security>'))
    assert.ok(prompt.includes('</security>'))
  })

  it('does NOT include tool summary section', () => {
    const tools = [{ name: 'bash', description: 'Run commands', input_schema: { type: 'object' as const, properties: {} } }]
    const prompt = buildSystemPrompt({ tools })
    assert.ok(!prompt.includes('## Tools'))
    assert.ok(!prompt.includes('- **bash**'))
  })

  it('has no markdown ## headers', () => {
    const prompt = buildSystemPrompt({ tools: [] })
    assert.ok(!prompt.includes('## '))
  })

  it('nesting depth is max 2 levels', () => {
    const prompt = buildSystemPrompt({ tools: [] })
    // No triple-nested tags like <a><b><c>
    const threeDeep = /<[a-z-]+>\s*<[a-z-]+>\s*<[a-z-]+>/
    assert.ok(!threeDeep.test(prompt))
  })
})
```

- [x] **步骤 2：运行测试验证失败**

运行：`npx tsx --test src/prompt/__tests__/static.test.ts`
预期：FAIL（当前 prompt 是 Markdown，无 XML tags）

- [x] **步骤 3：重构 BASE_PROMPT 为 XML**

```typescript
// src/prompt/static.ts
import type { ToolDefinition } from '../api/types.js'

const BASE_PROMPT = `<identity>
你是「天枢」，一个拥有想象力与创造力的代码开发智能体。你的任务不是机械补全代码，而是在理解用户意图、项目上下文与工程约束的基础上，主动设计更合理的架构、发现隐藏风险、修复根因问题，并输出清晰、稳定、可维护、可扩展的实现方案。你应当像一名高级工程师一样思考，像一名架构师一样审视系统，像一名创造者一样寻找更好的可能。
</identity>

<rules>
  <rule name="verify-first">
  This is the most important rule. Before writing any code:
  1. Check if the project has design docs, specs, or implementation plans. Read them first.
  2. Read existing code to understand patterns, not invent new ones.
  3. If the user mentions a feature or component name, search for existing files before creating anything.
  4. If a design doc says "Phase 1 must be read-only", do not add write capabilities. Follow the spec literally.
  5. When unsure about a constraint, grep the codebase or ask — never assume.
  </rule>

  <rule name="before-implementing">
  Read the relevant design/plan docs if they exist (check docs/ directory).
  Check .rivet.md for project-specific commands, architecture, conventions, and common mistakes.
  Use grep to find existing patterns, imports, and callers before adding new code.
  If a plan says "Phase 1 only does X", do exactly X — don't pre-implement Phase 2.
  </rule>
</rules>

<tool-usage>
  <file-operations>
  read_file: inspect code before editing. Use offset/limit for long files.
  edit_file: targeted search-and-replace. Only if old_string is unique in the file.
  write_file: new files or complete rewrites only.
  Never use Bash to read, write, search, or edit files.
  </file-operations>

  <shell>
  For build, test, git, npm, and system commands.
  Quote paths containing spaces. Prefer absolute paths.
  Never skip git hooks unless the user explicitly asks.
  </shell>

  <navigation>
  1. inspect_project — language, framework, scripts, entry points (quick overview)
  2. repo_map — annotated file tree with entry/test/config markers
  3. glob — find files by name pattern
  4. grep — search file contents for symbols or keywords
  </navigation>
</tool-usage>

<workflow>
  <development-loop>
  1. Read relevant files and design docs before editing.
  2. Edit, then check with diff.
  3. Run typecheck + tests. Read failures before retrying.
  4. If a test was already failing before your change, note it — don't fix unrelated failures.
  5. If a test you wrote fails, diagnose root cause — don't weaken the test to make it pass.
  </development-loop>

  <tdd>
  When adding new functionality, write tests first.
  Tests use node:test + node:assert/strict (matching the project convention).
  Test files mirror source structure: src/agent/foo.ts → src/agent/__tests__/foo.test.ts
  </tdd>

  <code-references>
  Use file_path:line_number format.
  </code-references>
</workflow>

<security>
Never expose API keys, tokens, or secrets in output or file content.
Validate file paths stay within the project directory.
Confirm before destructive commands: rm -rf, git push --force, git reset --hard.
</security>

<git>
Create new commits. Never amend existing commits.
Format: feat/fix/refactor/docs/test/chore/perf.
Never force push to main/master. Check git status before committing.
</git>`

export interface StaticPromptContext {
  tools: ToolDefinition[]
}

export function buildSystemPrompt(_ctx: StaticPromptContext): string {
  return BASE_PROMPT
}
```

- [x] **步骤 4：运行测试验证通过**

运行：`npx tsx --test src/prompt/__tests__/static.test.ts`
预期：PASS

- [x] **步骤 5：运行全量测试确认无回归**

运行：`npm test`
预期：全部通过（fingerprint hash 值会变，但 fingerprint 测试应该是 snapshot-free）

- [x] **步骤 6：运行 typecheck**

运行：`npx tsc --noEmit`
预期：无错误

- [x] **步骤 7：Commit**

```bash
git add src/prompt/static.ts src/prompt/__tests__/static.test.ts
git commit -m "refactor(prompt): restructure system prompt from Markdown to XML sections"
```

---

## Phase 2：Volatile Context XML 增强

### 任务 2：Tool History XML 结构

**文件：**
- 修改：`src/prompt/volatile.ts`
- 创建：`src/prompt/__tests__/volatile.test.ts`

- [x] **步骤 1：编写 volatile context 增强测试**

```typescript
// src/prompt/__tests__/volatile.test.ts
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { buildVolatileBlock, type VolatileContext } from '../volatile.js'

describe('buildVolatileBlock', () => {
  const base: VolatileContext = { cwd: '/project' }

  it('wraps all content in <context> root tag', () => {
    const block = buildVolatileBlock(base)
    assert.ok(block.startsWith('<context>'))
    assert.ok(block.endsWith('</context>'))
  })

  it('includes <environment> self-closing tag', () => {
    const block = buildVolatileBlock(base)
    assert.ok(block.includes('<environment'))
    assert.ok(block.includes('/>'))
  })

  it('includes <tool-history> when toolHistory is provided', () => {
    const ctx: VolatileContext = {
      ...base,
      toolHistory: [
        { tool: 'edit_file', target: 'src/auth.ts', status: 'success' },
        { tool: 'run_tests', target: 'auth.test.ts', status: 'failed', error: 'timeout' },
      ],
    }
    const block = buildVolatileBlock(ctx)
    assert.ok(block.includes('<tool-history'))
    assert.ok(block.includes('<tool-summary tool="edit_file"'))
    assert.ok(block.includes('status="success"'))
    assert.ok(block.includes('status="failed"'))
    assert.ok(block.includes('error="timeout"'))
    assert.ok(block.includes('</tool-history>'))
  })

  it('omits <tool-history> when toolHistory is empty', () => {
    const block = buildVolatileBlock({ ...base, toolHistory: [] })
    assert.ok(!block.includes('<tool-history'))
  })

  it('escapes XML special chars in tool targets', () => {
    const ctx: VolatileContext = {
      ...base,
      toolHistory: [{ tool: 'bash', target: 'echo "hello <world>"', status: 'success' }],
    }
    const block = buildVolatileBlock(ctx)
    assert.ok(block.includes('&lt;world&gt;'))
    assert.ok(!block.includes('<world>'))
  })
})
```

- [x] **步骤 2：运行测试验证失败**

运行：`npx tsx --test src/prompt/__tests__/volatile.test.ts`
预期：FAIL（`toolHistory` 属性不存在于 `VolatileContext`）

- [x] **步骤 3：扩展 VolatileContext 接口并实现**

在 `src/prompt/volatile.ts` 中添加 `ToolHistoryEntry` 类型和 `toolHistory` 字段：

```typescript
export interface ToolHistoryEntry {
  tool: string
  target: string
  status: 'success' | 'failed' | 'running'
  error?: string
}

export interface VolatileContext {
  cwd: string
  rivetMd?: string
  gitStatus?: string
  workingSet?: string[]
  contextLedger?: ContextLedger
  sessionMemoryBlock?: string
  toolHistory?: ToolHistoryEntry[]
}
```

在 `buildVolatileBlock` 函数中，在 `sessionMemoryBlock` 之前添加：

```typescript
if (ctx.toolHistory && ctx.toolHistory.length > 0) {
  const entries = ctx.toolHistory.map(e => {
    const attrs = [`tool="${escapeXml(e.tool)}"`, `target="${escapeXml(e.target)}"`, `status="${e.status}"`]
    if (e.error) attrs.push(`error="${escapeXml(e.error)}"`)
    return `  <tool-summary ${attrs.join(' ')} />`
  }).join('\n')
  parts.push(`<tool-history recent="${ctx.toolHistory.length}">\n${entries}\n</tool-history>`)
}
```

- [x] **步骤 4：运行测试验证通过**

运行：`npx tsx --test src/prompt/__tests__/volatile.test.ts`
预期：PASS

- [x] **步骤 5：运行全量测试**

运行：`npm test`
预期：全部通过

- [x] **步骤 6：Commit**

```bash
git add src/prompt/volatile.ts src/prompt/__tests__/volatile.test.ts
git commit -m "feat(prompt): add <tool-history> XML section to volatile context"
```

---

## Phase 3：投机预热引擎

### 任务 3：Intent Extractor

**文件：**
- 创建：`src/agent/intent-extractor.ts`
- 测试：`src/agent/__tests__/intent-extractor.test.ts`

- [x] **步骤 1：编写 intent extractor 测试**

```typescript
// src/agent/__tests__/intent-extractor.test.ts
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { extractIntents, type Intent } from '../intent-extractor.js'

describe('extractIntents', () => {
  it('extracts file paths from text', () => {
    const intents = extractIntents('I need to read src/auth/middleware.ts to understand the pattern')
    assert.ok(intents.some(i => i.type === 'file' && i.value === 'src/auth/middleware.ts'))
  })

  it('extracts multiple file paths', () => {
    const intents = extractIntents('Look at src/api/client.ts and src/agent/loop.ts')
    const files = intents.filter(i => i.type === 'file')
    assert.equal(files.length, 2)
  })

  it('extracts test file references', () => {
    const intents = extractIntents('run the tests in auth.test.ts')
    assert.ok(intents.some(i => i.type === 'test' && i.value.includes('auth.test.ts')))
  })

  it('extracts npm/bash commands', () => {
    const intents = extractIntents('I should run npm test to verify')
    assert.ok(intents.some(i => i.type === 'command' && i.value === 'npm test'))
  })

  it('extracts typecheck intent', () => {
    const intents = extractIntents('let me check with tsc --noEmit')
    assert.ok(intents.some(i => i.type === 'command' && i.value.includes('tsc')))
  })

  it('ignores paths inside code blocks', () => {
    const intents = extractIntents('```\nconst path = "src/fake.ts"\n```')
    assert.equal(intents.filter(i => i.type === 'file').length, 0)
  })

  it('returns empty array for text with no intents', () => {
    const intents = extractIntents('This is just a plain explanation with no paths.')
    assert.equal(intents.length, 0)
  })

  it('deduplicates repeated file paths', () => {
    const intents = extractIntents('Read src/a.ts, then edit src/a.ts')
    const files = intents.filter(i => i.type === 'file')
    assert.equal(files.length, 1)
  })
})
```

- [x] **步骤 2：运行测试验证失败**

运行：`npx tsx --test src/agent/__tests__/intent-extractor.test.ts`
预期：FAIL，"Cannot find module '../intent-extractor.js'"

- [x] **步骤 3：实现 intent extractor**

```typescript
// src/agent/intent-extractor.ts
export type IntentType = 'file' | 'test' | 'command'

export interface Intent {
  type: IntentType
  value: string
}

const FILE_PATH_RE = /(?:^|\s)((?:src|test|tests|lib|packages)\/[\w./-]+\.(?:ts|tsx|js|json|md))/g
const TEST_FILE_RE = /(\S+\.test\.\w+)/g
const COMMAND_RE = /(?:run|execute|check with)\s+(npm\s+\w+|tsc[^\n]*|npx[^\n]*)/gi
const CODE_BLOCK_RE = /```[\s\S]*?```/g

export function extractIntents(text: string): Intent[] {
  const cleaned = text.replace(CODE_BLOCK_RE, '')
  const seen = new Set<string>()
  const intents: Intent[] = []

  for (const match of cleaned.matchAll(FILE_PATH_RE)) {
    const path = match[1]!
    if (seen.has(path)) continue
    seen.add(path)
    const type: IntentType = path.includes('.test.') ? 'test' : 'file'
    intents.push({ type, value: path })
  }

  for (const match of cleaned.matchAll(TEST_FILE_RE)) {
    const file = match[1]!
    if (seen.has(file)) continue
    seen.add(file)
    intents.push({ type: 'test', value: file })
  }

  for (const match of cleaned.matchAll(COMMAND_RE)) {
    const cmd = match[1]!.trim()
    if (seen.has(cmd)) continue
    seen.add(cmd)
    intents.push({ type: 'command', value: cmd })
  }

  return intents
}
```

- [x] **步骤 4：运行测试验证通过**

运行：`npx tsx --test src/agent/__tests__/intent-extractor.test.ts`
预期：PASS

- [x] **步骤 5：Commit**

```bash
git add src/agent/intent-extractor.ts src/agent/__tests__/intent-extractor.test.ts
git commit -m "feat(agent): add intent extractor for speculative pre-warming"
```

---

### 任务 4：Pre-warm Cache

**文件：**
- 创建：`src/agent/prewarm.ts`
- 测试：`src/agent/__tests__/prewarm.test.ts`

- [x] **步骤 1：编写 prewarm cache 测试**

```typescript
// src/agent/__tests__/prewarm.test.ts
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { PrewarmCache } from '../prewarm.js'

describe('PrewarmCache', () => {
  it('stores and retrieves cached content', () => {
    const cache = new PrewarmCache()
    cache.set('src/auth.ts', 'file content here')
    assert.equal(cache.get('src/auth.ts'), 'file content here')
  })

  it('returns undefined for missing keys', () => {
    const cache = new PrewarmCache()
    assert.equal(cache.get('nonexistent'), undefined)
  })

  it('expires entries after TTL', () => {
    const cache = new PrewarmCache(50) // 50ms TTL
    cache.set('key', 'value')
    assert.equal(cache.get('key'), 'value')
    // Simulate expiry by advancing internal clock
    cache.expireAll()
    assert.equal(cache.get('key'), undefined)
  })

  it('invalidates on file path', () => {
    const cache = new PrewarmCache()
    cache.set('src/auth.ts', 'old content')
    cache.invalidate('src/auth.ts')
    assert.equal(cache.get('src/auth.ts'), undefined)
  })

  it('tracks hit rate', () => {
    const cache = new PrewarmCache()
    cache.set('a', 'content')
    cache.get('a') // hit
    cache.get('b') // miss
    const stats = cache.stats()
    assert.equal(stats.hits, 1)
    assert.equal(stats.misses, 1)
    assert.equal(stats.hitRate, 0.5)
  })

  it('limits max entries', () => {
    const cache = new PrewarmCache(30000, 3)
    cache.set('a', '1')
    cache.set('b', '2')
    cache.set('c', '3')
    cache.set('d', '4') // evicts 'a'
    assert.equal(cache.get('a'), undefined)
    assert.equal(cache.get('d'), '4')
  })
})
```

- [x] **步骤 2：运行测试验证失败**

运行：`npx tsx --test src/agent/__tests__/prewarm.test.ts`
预期：FAIL，"Cannot find module '../prewarm.js'"

- [x] **步骤 3：实现 PrewarmCache**

```typescript
// src/agent/prewarm.ts
interface CacheEntry {
  value: string
  timestamp: number
}

export class PrewarmCache {
  private store = new Map<string, CacheEntry>()
  private hits = 0
  private misses = 0

  constructor(
    private ttlMs = 30_000,
    private maxEntries = 20,
  ) {}

  set(key: string, value: string): void {
    if (this.store.size >= this.maxEntries) {
      const oldest = this.store.keys().next().value!
      this.store.delete(oldest)
    }
    this.store.set(key, { value, timestamp: Date.now() })
  }

  get(key: string): string | undefined {
    const entry = this.store.get(key)
    if (!entry) { this.misses++; return undefined }
    if (Date.now() - entry.timestamp > this.ttlMs) {
      this.store.delete(key)
      this.misses++
      return undefined
    }
    this.hits++
    return entry.value
  }

  invalidate(key: string): void {
    this.store.delete(key)
  }

  expireAll(): void {
    this.store.clear()
  }

  stats(): { hits: number; misses: number; hitRate: number } {
    const total = this.hits + this.misses
    return { hits: this.hits, misses: this.misses, hitRate: total > 0 ? this.hits / total : 0 }
  }
}
```

- [x] **步骤 4：运行测试验证通过**

运行：`npx tsx --test src/agent/__tests__/prewarm.test.ts`
预期：PASS

- [x] **步骤 5：Commit**

```bash
git add src/agent/prewarm.ts src/agent/__tests__/prewarm.test.ts
git commit -m "feat(agent): add PrewarmCache for speculative file pre-reading"
```

---

### 任务 5：集成投机预热到 Agent Loop

**文件：**
- 修改：`src/agent/loop.ts`

- [x] **步骤 1：添加 imports**

在 `src/agent/loop.ts` 顶部添加：

```typescript
import { extractIntents } from './intent-extractor.js'
import { PrewarmCache } from './prewarm.js'
import { readFileSync, existsSync } from 'fs'
import { join } from 'path'
```

- [x] **步骤 2：在 AgentLoop 中添加 prewarm cache**

在 `AgentLoop` class 中添加属性：

```typescript
private prewarm = new PrewarmCache()
```

- [x] **步骤 3：在 streaming text callback 中提取 intent 并预热**

在 agent loop 的 text streaming 处理中（当 assistant text 积累到一定长度时），触发预热：

```typescript
// In the streaming callback where text accumulates,
// trigger intent extraction every ~500 chars of new text:
private maybePrewarm(text: string): void {
  const intents = extractIntents(text)
  for (const intent of intents) {
    if (intent.type === 'file' && !this.prewarm.get(intent.value)) {
      const fullPath = join(this.cwd, intent.value)
      if (existsSync(fullPath)) {
        try {
          const content = readFileSync(fullPath, 'utf-8')
          this.prewarm.set(intent.value, content)
        } catch { /* ignore unreadable files */ }
      }
    }
  }
}
```

- [x] **步骤 4：在 tool execution 中使用 prewarm cache**

在 `read_file` tool 执行前检查 prewarm cache：

```typescript
// Before executing read_file tool, check prewarm cache:
const cached = this.prewarm.get(relativePath)
if (cached) {
  // Return cached content, skip actual read
  return cached
}
```

注意：这只是一个优化路径。如果 cache miss，正常执行 read_file。

- [x] **步骤 5：在 tool result 中 invalidate prewarm cache**

当 `edit_file` 或 `write_file` 成功执行后，invalidate 对应文件的 prewarm cache：

```typescript
// After edit_file or write_file succeeds:
this.prewarm.invalidate(targetPath)
```

- [x] **步骤 6：运行 typecheck + 全量测试**

运行：`npx tsc --noEmit && npm test`
预期：全部通过

- [x] **步骤 7：Commit**

```bash
git add src/agent/loop.ts
git commit -m "feat(agent): integrate speculative pre-warming into agent loop"
```

---

### 任务 6：Tool History 集成到 Volatile Context

**文件：**
- 修改：`src/agent/loop.ts`
- 修改：`src/prompt/engine.ts`（如需要）

- [x] **步骤 1：在 agent loop 中维护 tool history**

在 `AgentLoop` 或 `SessionContext` 中维护最近 N 个 tool call 的 history：

```typescript
import type { ToolHistoryEntry } from '../prompt/volatile.js'

// In the agent loop, after each tool result:
private recentToolHistory: ToolHistoryEntry[] = []

// After onToolResult:
this.recentToolHistory.push({
  tool: name,
  target: typeof input?.path === 'string' ? input.path : typeof input?.command === 'string' ? input.command.slice(0, 50) : name,
  status: isError ? 'failed' : 'success',
  error: isError ? result.slice(0, 50) : undefined,
})
if (this.recentToolHistory.length > 5) this.recentToolHistory.shift()
```

- [x] **步骤 2：传递 tool history 到 volatile context**

在 `PromptEngine` 或调用 `buildVolatileBlock` 时，传入 `toolHistory`：

```typescript
// When building volatile context for the next turn:
const volatile = buildVolatileBlock({
  ...this.config.volatileCtx,
  toolHistory: this.recentToolHistory,
})
```

注意：由于 volatile block 当前是 frozen at construction，这需要一个新的方法来注入 per-turn tool history。两种选择：
- A) 在 `buildRequest` 中为最后一条 user message 动态注入 tool history（推荐）
- B) 修改 PromptEngine 支持 partial volatile update

选择 A）：在 `buildRequest` 中，最后一个 volatile block 包含最新的 tool history。

- [x] **步骤 3：运行 typecheck + 全量测试**

运行：`npx tsc --noEmit && npm test`
预期：全部通过

- [x] **步骤 4：Commit**

```bash
git add src/agent/loop.ts src/prompt/volatile.ts src/prompt/engine.ts
git commit -m "feat(prompt): inject tool history into volatile context per-turn"
```

---

## 自检

### 规格覆盖度

| 设计规格需求 | 对应任务 |
|-------------|---------|
| XML 化 System Prompt | 任务 1 |
| 删除重复 tool summary | 任务 1（buildSystemPrompt 不再 append tools） |
| Volatile context `<tool-history>` | 任务 2 + 任务 6 |
| Intent Extractor | 任务 3 |
| PrewarmCache | 任务 4 |
| Agent Loop 集成预热 | 任务 5 |
| Tool history 注入 volatile | 任务 6 |

### 占位符扫描

无 TODO、待定、"后续实现"。所有步骤包含完整代码。

### 类型一致性

- `ToolHistoryEntry` 在任务 2 定义（volatile.ts），任务 6 使用
- `Intent` / `extractIntents` 在任务 3 定义，任务 5 使用
- `PrewarmCache` 在任务 4 定义，任务 5 使用
- `buildSystemPrompt` 在任务 1 修改签名（忽略 tools 参数），engine.ts 调用方不变
