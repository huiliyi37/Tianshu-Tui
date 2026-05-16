# Rivet Cache Safety Layer 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [x]`）语法来跟踪进度。

**目标：** 修复 Rivet 当前 prewarm / volatile / prompt fingerprint 缓存边界问题，确保缓存不绕过文件安全校验、不返回 stale 内容、不隐形打穿 prefix cache。

**架构：** 把文件读取安全逻辑集中到 `read-file.ts` 可复用 helper；prewarm 只缓存通过同一安全 helper 产生的 canonical full-file preview，并只在无 offset/limit 时命中。volatile 本地缓存按 cwd 分桶，PromptEngine fingerprint 扩展到 stable volatile block，动态 tool/task context 只注入最新 turn。

**技术栈：** TypeScript, node:test, node:assert/strict, fs/path, existing `validatePath`, `GitignoreFilter`, `PromptEngine`

---

## 背景

当前风险来自四条链路：

1. `AgentLoop.maybePrewarm()` 直接用 `readFileSync(join(cwd, intent.value))` 读取文件，绕过 `READ_FILE_TOOL.execute()` 的 `validatePath`、gitignore、truncation 和 raw output 逻辑。
2. `PrewarmCache` 使用原始字符串作为 key，set 时多为相对路径，invalidate 时多为绝对路径，导致编辑后 cache 不失效。
3. `.rivet.md` 和 git status 的 TTL cache 是模块级单值，不按 cwd 隔离。
4. `PromptEngine` fingerprint 只覆盖 system prompt 和 tool definitions，不覆盖 frozen volatile block，实际 prefix 变化时 drift 检测可能假绿。

修复原则：缓存层只能优化已经允许的读取与注入，不能成为第二套权限系统。

---

## 文件结构

| 操作 | 文件 | 职责 |
|------|------|------|
| 修改 | `src/tools/read-file.ts` | 导出共享的安全文件读取 helper，供 `read_file` 和 prewarm 使用 |
| 修改 | `src/agent/prewarm.ts` | 将 cache value 改成 canonical prewarm result，支持 canonical key 命中与失效 |
| 创建 | `src/agent/prewarm-file.ts` | 将 prewarm 文件安全读取、大小限制、offset/limit 命中判断集中到独立模块 |
| 创建 | `src/agent/__tests__/prewarm-file.test.ts` | 覆盖路径逃逸、gitignored 文件、大文件、canonical key、offset/limit 不命中 |
| 修改 | `src/agent/loop.ts` | 使用 `prewarm-file.ts` 进行 speculative read、cache hit 和 write invalidation |
| 修改 | `src/prompt/volatile.ts` | `.rivet.md` cache 改成 per-cwd Map |
| 修改 | `src/prompt/volatile-git.ts` | git status cache 改成 per-cwd Map |
| 创建 | `src/prompt/__tests__/volatile-cache.test.ts` | 覆盖不同 cwd 的 `.rivet.md` / git status 不串值 |
| 修改 | `src/prompt/fingerprint.ts` | fingerprint 增加 stable volatile block hash |
| 修改 | `src/prompt/engine.ts` | 计算 stable volatile fingerprint，动态 context 只放最新 turn |
| 修改 | `src/prompt/__tests__/engine.test.ts` | 覆盖 stable volatile drift 与 dynamic context 注入位置 |
| 修改 | `README.md` | 补充 cache safety 设计说明和验证命令 |

---

### 任务 1：集中 `read_file` 安全读取逻辑

**文件：**
- 修改：`src/tools/read-file.ts`
- 测试：`src/tools/__tests__/read-file.test.ts`

- [x] **步骤 1：编写失败的测试**

在 `src/tools/__tests__/read-file.test.ts` 增加以下测试。如果文件不存在，创建该测试文件并保留现有测试风格：

```typescript
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { readFilePayload } from '../read-file.js'

describe('readFilePayload', () => {
  it('rejects path traversal outside cwd', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rivet-read-'))
    const outside = join(tmpdir(), `outside-${Date.now()}.md`)
    writeFileSync(outside, 'secret', 'utf-8')
    try {
      assert.throws(
        () => readFilePayload(dir, { filePath: 'src/../../outside.md' }),
        /outside project directory/i,
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
      rmSync(outside, { force: true })
    }
  })

  it('rejects gitignored files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rivet-read-'))
    mkdirSync(join(dir, 'node_modules'), { recursive: true })
    writeFileSync(join(dir, 'node_modules/pkg.js'), 'module.exports = 1', 'utf-8')
    try {
      assert.throws(
        () => readFilePayload(dir, { filePath: 'node_modules/pkg.js' }),
        /gitignored/i,
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('returns canonical path and truncated model content', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rivet-read-'))
    mkdirSync(join(dir, 'src'), { recursive: true })
    const long = 'a'.repeat(12_000)
    writeFileSync(join(dir, 'src/a.ts'), long, 'utf-8')
    try {
      const payload = readFilePayload(dir, { filePath: 'src/a.ts' })
      assert.equal(payload.canonicalPath, join(dir, 'src/a.ts'))
      assert.ok(payload.modelContent.length < long.length)
      assert.ok(payload.uiContent.includes('1│'))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
```

- [x] **步骤 2：运行测试验证失败**

运行：

```bash
npm test -- src/tools/__tests__/read-file.test.ts
```

预期：FAIL，报错包含：

```text
The requested module '../read-file.js' does not provide an export named 'readFilePayload'
```

- [x] **步骤 3：实现共享 helper**

修改 `src/tools/read-file.ts`，在 `READ_FILE_TOOL` 前加入：

```typescript
export interface ReadFilePayloadOptions {
  filePath: string
  offset?: number
  limit?: number
}

export interface ReadFilePayload {
  canonicalPath: string
  rawContent: string
  modelContent: string
  uiContent: string
}

export function readFilePayload(cwd: string, options: ReadFilePayloadOptions): ReadFilePayload {
  const filePath = validatePath(cwd, options.filePath)
  if (!existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`)
  }

  const filter = getGitignoreFilter(cwd)
  if (filter.isIgnored(cwd, filePath)) {
    throw new Error(`File is gitignored (node_modules, build artifacts, etc.): ${filePath}`)
  }

  let content = readFileSync(filePath, 'utf-8')
  const offset = options.offset ?? 1
  const limit = options.limit

  if (offset > 1 || limit) {
    const lines = content.split('\n')
    const startIdx = offset - 1
    const endIdx = limit ? startIdx + limit : undefined
    content = lines.slice(startIdx, endIdx).join('\n')
  }

  return {
    canonicalPath: filePath,
    rawContent: content,
    modelContent: truncateContent(content, MODEL_MAX_CHARS, MODEL_HEAD_CHARS, MODEL_TAIL_CHARS),
    uiContent: buildFileUiOutput(content, 50),
  }
}
```

Then replace the body of `READ_FILE_TOOL.execute()` with:

```typescript
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

  return {
    content: payload.modelContent,
    uiContent: payload.uiContent,
    rawPath,
  }
},
```

- [x] **步骤 4：运行测试验证通过**

运行：

```bash
npm test -- src/tools/__tests__/read-file.test.ts
```

预期：PASS。

- [x] **步骤 5：Commit**

```bash
git add src/tools/read-file.ts src/tools/__tests__/read-file.test.ts
git commit -m "fix(read-file): centralize safe file payload construction"
```

---

### 任务 2：实现 safe prewarm 文件读取与 canonical key

**文件：**
- 创建：`src/agent/prewarm-file.ts`
- 修改：`src/agent/prewarm.ts`
- 测试：`src/agent/__tests__/prewarm-file.test.ts`

- [x] **步骤 1：编写失败的测试**

创建 `src/agent/__tests__/prewarm-file.test.ts`：

```typescript
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { buildPrewarmValue, canUsePrewarmForRead } from '../prewarm-file.js'

describe('buildPrewarmValue', () => {
  it('returns undefined for path traversal', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rivet-prewarm-'))
    try {
      const value = buildPrewarmValue(dir, 'src/../../outside.md')
      assert.equal(value, undefined)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('returns undefined for gitignored files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rivet-prewarm-'))
    mkdirSync(join(dir, 'dist'), { recursive: true })
    writeFileSync(join(dir, 'dist/app.js'), 'compiled', 'utf-8')
    try {
      const value = buildPrewarmValue(dir, 'dist/app.js')
      assert.equal(value, undefined)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('returns canonical key and model content for safe small file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rivet-prewarm-'))
    mkdirSync(join(dir, 'src'), { recursive: true })
    writeFileSync(join(dir, 'src/a.ts'), 'export const a = 1\n', 'utf-8')
    try {
      const value = buildPrewarmValue(dir, 'src/a.ts')
      assert.ok(value)
      assert.equal(value.canonicalPath, join(dir, 'src/a.ts'))
      assert.equal(value.content, 'export const a = 1\n')
      assert.ok(value.uiContent.includes('1│'))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('canUsePrewarmForRead', () => {
  it('allows full file reads only', () => {
    assert.equal(canUsePrewarmForRead({ file_path: 'src/a.ts' }), true)
    assert.equal(canUsePrewarmForRead({ file_path: 'src/a.ts', offset: 2 }), false)
    assert.equal(canUsePrewarmForRead({ file_path: 'src/a.ts', limit: 10 }), false)
  })
})
```

- [x] **步骤 2：运行测试验证失败**

运行：

```bash
npm test -- src/agent/__tests__/prewarm-file.test.ts
```

预期：FAIL，报错包含：

```text
Cannot find module '../prewarm-file.js'
```

- [x] **步骤 3：实现 prewarm 文件 helper**

创建 `src/agent/prewarm-file.ts`：

```typescript
import { statSync } from 'node:fs'
import { readFilePayload } from '../tools/read-file.js'

const MAX_PREWARM_BYTES = 100_000

export interface PrewarmValue {
  canonicalPath: string
  content: string
  uiContent: string
}

export function canUsePrewarmForRead(input: Record<string, unknown>): boolean {
  return typeof input.file_path === 'string'
    && input.offset === undefined
    && input.limit === undefined
}

export function buildPrewarmValue(cwd: string, filePath: string): PrewarmValue | undefined {
  try {
    const payload = readFilePayload(cwd, { filePath })
    const stat = statSync(payload.canonicalPath)
    if (stat.size > MAX_PREWARM_BYTES) return undefined
    return {
      canonicalPath: payload.canonicalPath,
      content: payload.modelContent,
      uiContent: payload.uiContent,
    }
  } catch {
    return undefined
  }
}
```

修改 `src/agent/prewarm.ts`：

```typescript
import type { PrewarmValue } from './prewarm-file.js'

interface CacheEntry {
  value: PrewarmValue
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

  set(key: string, value: PrewarmValue): void {
    if (this.store.size >= this.maxEntries) {
      const oldest = this.store.keys().next().value!
      this.store.delete(oldest)
    }
    this.store.set(key, { value, timestamp: Date.now() })
  }

  get(key: string): PrewarmValue | undefined {
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

运行：

```bash
npm test -- src/agent/__tests__/prewarm-file.test.ts
```

预期：PASS。

- [x] **步骤 5：Commit**

```bash
git add src/agent/prewarm.ts src/agent/prewarm-file.ts src/agent/__tests__/prewarm-file.test.ts
git commit -m "fix(agent): make prewarm cache use safe canonical file reads"
```

---

### 任务 3：将 AgentLoop 接到 safe prewarm

**文件：**
- 修改：`src/agent/loop.ts:103-118,354-365,384-387`
- 测试：`src/agent/__tests__/loop.test.ts`

- [x] **步骤 1：编写失败的测试**

在 `src/agent/__tests__/loop.test.ts` 增加测试。测试使用 mock client 先输出包含安全文件路径的文本触发 prewarm，再发出 `read_file` tool_use，断言 tool registry 没被调用且返回缓存内容；再增加 offset 读测试，断言不会使用缓存。

```typescript
it('uses prewarm cache only for canonical full-file read_file calls', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rivet-loop-prewarm-'))
  mkdirSync(join(dir, 'src'), { recursive: true })
  writeFileSync(join(dir, 'src/a.ts'), 'export const a = 1\n', 'utf-8')

  let executeCalls = 0
  const registry = new ToolRegistry()
  registry.register({
    definition: { name: 'read_file', description: '', input_schema: { type: 'object', properties: {}, required: [] } },
    async execute() {
      executeCalls++
      return { content: 'registry read' }
    },
    requiresApproval: () => false,
    isConcurrencySafe: () => true,
    isEnabled: () => true,
  })

  const client = createMockClient([
    { type: 'text', text: 'I will inspect src/a.ts. '.repeat(30) },
    { type: 'tool_use', id: 'tu1', name: 'read_file', input: { file_path: join(dir, 'src/a.ts') } },
  ])

  const session = new SessionContext()
  const promptEngine = new PromptEngine({ model: 'test', maxTokens: 1000, staticCtx: { tools: registry.getDefinitions() }, volatileCtx: { cwd: dir } })
  const loop = new AgentLoop({ client, promptEngine, toolRegistry: registry, maxTurns: 2, contextWindow: 10000, compact: { enabled: false, autoThreshold: 9000, autoFloor: 7000, model: 'test' } }, session, dir)

  const results: string[] = []
  await loop.run('start', makeCallbacks({ onToolResult: (_id, _name, result) => results.push(result) }))

  assert.equal(executeCalls, 0)
  assert.ok(results.some(r => r.includes('export const a = 1')))

  rmSync(dir, { recursive: true, force: true })
})
```

Add the offset/limit test in the same file:

```typescript
it('does not use prewarm cache for read_file with offset or limit', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rivet-loop-prewarm-'))
  mkdirSync(join(dir, 'src'), { recursive: true })
  writeFileSync(join(dir, 'src/a.ts'), 'line1\nline2\n', 'utf-8')

  let executeCalls = 0
  const registry = new ToolRegistry()
  registry.register({
    definition: { name: 'read_file', description: '', input_schema: { type: 'object', properties: {}, required: [] } },
    async execute() {
      executeCalls++
      return { content: 'line2' }
    },
    requiresApproval: () => false,
    isConcurrencySafe: () => true,
    isEnabled: () => true,
  })

  const client = createMockClient([
    { type: 'text', text: 'I will inspect src/a.ts. '.repeat(30) },
    { type: 'tool_use', id: 'tu1', name: 'read_file', input: { file_path: join(dir, 'src/a.ts'), offset: 2, limit: 1 } },
  ])

  const session = new SessionContext()
  const promptEngine = new PromptEngine({ model: 'test', maxTokens: 1000, staticCtx: { tools: registry.getDefinitions() }, volatileCtx: { cwd: dir } })
  const loop = new AgentLoop({ client, promptEngine, toolRegistry: registry, maxTurns: 2, contextWindow: 10000, compact: { enabled: false, autoThreshold: 9000, autoFloor: 7000, model: 'test' } }, session, dir)

  await loop.run('start', makeCallbacks())

  assert.equal(executeCalls, 1)
  rmSync(dir, { recursive: true, force: true })
})
```

Use existing test helpers in `loop.test.ts`; if helper names differ, adapt only the wrapper calls, not the assertions.

- [x] **步骤 2：运行测试验证失败**

运行：

```bash
npm test -- src/agent/__tests__/loop.test.ts
```

预期：第一个测试 FAIL，`executeCalls` 为 1 或 cache content 不返回；第二个测试可能 PASS/FAIL，取决于当前 cache key 是否命中。

- [x] **步骤 3：修改 AgentLoop 接线**

在 `src/agent/loop.ts` 顶部新增 import：

```typescript
import { buildPrewarmValue, canUsePrewarmForRead } from './prewarm-file.js'
import { validatePath } from '../tools/path-validate.js'
```

替换 `maybePrewarm()` 为：

```typescript
private maybePrewarm(text: string): void {
  const intents = extractIntents(text)
  for (const intent of intents) {
    if (intent.type !== 'file') continue
    const value = buildPrewarmValue(this.cwd, intent.value)
    if (!value) continue
    if (!this.prewarm.get(value.canonicalPath)) {
      this.prewarm.set(value.canonicalPath, value)
    }
  }
}
```

替换 read_file fast-path：

```typescript
if (tu.name === 'read_file' && canUsePrewarmForRead(tu.input)) {
  try {
    const canonicalPath = validatePath(this.cwd, tu.input.file_path as string)
    const cached = this.prewarm.get(canonicalPath)
    if (cached) {
      rawToolResult = { content: cached.content, uiContent: cached.uiContent }
      return { content: cached.content }
    }
  } catch {
    // Fall through to the real tool so it can return the standard error.
  }
}
```

Replace invalidation logic:

```typescript
if ((tu.name === 'write_file' || tu.name === 'edit_file') && !harnessResult.isError && typeof tu.input.file_path === 'string') {
  try {
    this.prewarm.invalidate(validatePath(this.cwd, tu.input.file_path))
  } catch {
    this.prewarm.invalidate(tu.input.file_path)
  }
}
```

- [x] **步骤 4：运行测试验证通过**

运行：

```bash
npm test -- src/agent/__tests__/loop.test.ts src/agent/__tests__/prewarm-file.test.ts
```

预期：PASS。

- [x] **步骤 5：Commit**

```bash
git add src/agent/loop.ts src/agent/__tests__/loop.test.ts
git commit -m "fix(agent): enforce safe prewarm cache hits in AgentLoop"
```

---

### 任务 4：按 cwd 隔离 volatile 本地缓存

**文件：**
- 修改：`src/prompt/volatile.ts:26-43`
- 修改：`src/prompt/volatile-git.ts:29-59`
- 测试：`src/prompt/__tests__/volatile-cache.test.ts`

- [x] **步骤 1：编写失败的测试**

创建 `src/prompt/__tests__/volatile-cache.test.ts`：

```typescript
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { buildVolatileBlock } from '../volatile.js'
import { createGitStatusCache } from '../volatile-git.js'

describe('volatile local caches', () => {
  it('does not share .rivet.md content across cwd values', () => {
    const a = mkdtempSync(join(tmpdir(), 'rivet-cwd-a-'))
    const b = mkdtempSync(join(tmpdir(), 'rivet-cwd-b-'))
    writeFileSync(join(a, '.rivet.md'), 'Project A rules', 'utf-8')
    writeFileSync(join(b, '.rivet.md'), 'Project B rules', 'utf-8')
    try {
      const blockA = buildVolatileBlock({ cwd: a })
      const blockB = buildVolatileBlock({ cwd: b })
      assert.ok(blockA.includes('Project A rules'))
      assert.ok(!blockA.includes('Project B rules'))
      assert.ok(blockB.includes('Project B rules'))
      assert.ok(!blockB.includes('Project A rules'))
    } finally {
      rmSync(a, { recursive: true, force: true })
      rmSync(b, { recursive: true, force: true })
    }
  })

  it('stores git status cache values per cwd', async () => {
    const values = new Map<string, string | undefined>()
    const cache = createGitStatusCache({
      ttlMs: 60_000,
      now: () => 100,
      load: async (cwd) => values.get(cwd),
    })
    values.set('/repo/a', 'Current branch: a\nStatus:\n(clean)')
    values.set('/repo/b', 'Current branch: b\nStatus:\n M file.ts')
    await cache.refresh('/repo/a')
    await cache.refresh('/repo/b')
    assert.equal(cache.get('/repo/a'), 'Current branch: a\nStatus:\n(clean)')
    assert.equal(cache.get('/repo/b'), 'Current branch: b\nStatus:\n M file.ts')
  })
})
```

- [x] **步骤 2：运行测试验证失败**

运行：

```bash
npm test -- src/prompt/__tests__/volatile-cache.test.ts
```

预期：FAIL，第二个 cwd 读到第一个 cwd 的 cache 值。

- [x] **步骤 3：实现 per-cwd cache**

修改 `src/prompt/volatile.ts`：

```typescript
let rivetMdCache = new Map<string, { value: string | undefined; timestamp: number }>()
const RIVET_MD_CACHE_TTL_MS = 30_000

function readRivetMd(cwd: string): string | undefined {
  const cached = rivetMdCache.get(cwd)
  if (cached && Date.now() - cached.timestamp < RIVET_MD_CACHE_TTL_MS) {
    return cached.value
  }

  const path = join(cwd, '.rivet.md')
  try {
    if (existsSync(path)) {
      const value = readFileSync(path, 'utf-8')
      rivetMdCache.set(cwd, { value, timestamp: Date.now() })
      return value
    }
  } catch { /* ignore */ }
  rivetMdCache.set(cwd, { value: undefined, timestamp: Date.now() })
  return undefined
}
```

修改 `src/prompt/volatile-git.ts` 的 `createGitStatusCache()`：

```typescript
export function createGitStatusCache(options: GitStatusCacheOptions) {
  const values = new Map<string, { value: string | undefined; timestamp: number }>()
  const refreshing = new Map<string, Promise<void>>()

  const isFresh = (cwd: string) => {
    const entry = values.get(cwd)
    return !!entry && options.now() - entry.timestamp < options.ttlMs
  }

  return {
    get(cwd: string): string | undefined {
      if (!isFresh(cwd) && !refreshing.has(cwd)) {
        void this.refresh(cwd)
      }
      return values.get(cwd)?.value
    },

    prime(cwd: string, nextValue: string | undefined): void {
      values.set(cwd, { value: nextValue, timestamp: options.now() })
    },

    async refresh(cwd: string): Promise<void> {
      const existing = refreshing.get(cwd)
      if (existing) return existing
      const work = options.load(cwd).then(nextValue => {
        values.set(cwd, { value: nextValue, timestamp: options.now() })
      }).finally(() => {
        refreshing.delete(cwd)
      })
      refreshing.set(cwd, work)
      return work
    },
  }
}
```

Update existing callers/tests of `prime()` to pass cwd explicitly:

```typescript
gitStatusCache.prime(cwd, status)
```

- [x] **步骤 4：运行测试验证通过**

运行：

```bash
npm test -- src/prompt/__tests__/volatile-cache.test.ts src/prompt/__tests__/volatile-git.test.ts
```

If `volatile-git.test.ts` does not exist, run only `volatile-cache.test.ts`.

预期：PASS。

- [x] **步骤 5：Commit**

```bash
git add src/prompt/volatile.ts src/prompt/volatile-git.ts src/prompt/__tests__/volatile-cache.test.ts src/prompt/__tests__/volatile-git.test.ts
git commit -m "fix(prompt): isolate volatile caches by cwd"
```

---

### 任务 5：让 prefix fingerprint 覆盖 stable volatile block

**文件：**
- 修改：`src/prompt/fingerprint.ts`
- 修改：`src/prompt/engine.ts`
- 测试：`src/prompt/__tests__/engine.test.ts`

- [x] **步骤 1：编写失败的测试**

在 `src/prompt/__tests__/engine.test.ts` 增加：

```typescript
it('detects stable volatile block drift in fingerprint', () => {
  const engineA = new PromptEngine({
    model: 'test',
    maxTokens: 1000,
    staticCtx: { tools: [] },
    volatileCtx: { cwd: '/repo/a', sessionMemoryBlock: '<session-memory session_id="a" />' },
  })
  const engineB = new PromptEngine({
    model: 'test',
    maxTokens: 1000,
    staticCtx: { tools: [] },
    volatileCtx: { cwd: '/repo/b', sessionMemoryBlock: '<session-memory session_id="b" />' },
  })

  assert.notEqual(engineA.getFingerprint().combinedSha256, engineB.getFingerprint().combinedSha256)
})
```

Add dynamic context placement test:

```typescript
it('injects tool history only into the latest volatile block', () => {
  const engine = new PromptEngine({
    model: 'test',
    maxTokens: 1000,
    staticCtx: { tools: [] },
    volatileCtx: { cwd: '/repo' },
  })
  const request = engine.buildRequest([
    { role: 'user', content: 'first' },
    { role: 'assistant', content: 'ok' },
    { role: 'user', content: 'second' },
  ], [{ tool: 'read_file', target: 'src/a.ts', status: 'success' }])

  const contextMessages = request.messages.filter(m => typeof m.content === 'string' && m.content.includes('<context>'))
  assert.equal(contextMessages.length, 2)
  assert.equal((contextMessages[0]!.content as string).includes('<tool-history'), false)
  assert.equal((contextMessages[1]!.content as string).includes('<tool-history'), true)
})
```

- [x] **步骤 2：运行测试验证失败**

运行：

```bash
npm test -- src/prompt/__tests__/engine.test.ts
```

预期：第一个新增测试 FAIL，因为 fingerprint 当前不包含 volatile block。

- [x] **步骤 3：扩展 fingerprint 类型与计算**

修改 `src/prompt/fingerprint.ts`：

```typescript
export interface PrefixFingerprint {
  systemSha256: string
  toolsSha256: string
  stableVolatileSha256: string
  combinedSha256: string
}

export function computeFingerprint(
  systemText: string,
  tools: ToolDefinition[] | undefined,
  stableVolatileBlock = '',
): PrefixFingerprint {
  const systemSha256 = sha256(systemText)
  const toolsSha256 = tools && tools.length > 0
    ? sha256(stableStringify([...tools].sort((a, b) => a.name.localeCompare(b.name))))
    : sha256('')
  const stableVolatileSha256 = sha256(stableVolatileBlock)
  const combinedSha256 = sha256(`${systemSha256}:${toolsSha256}:${stableVolatileSha256}`)
  return { systemSha256, toolsSha256, stableVolatileSha256, combinedSha256 }
}
```

Update `detectDrift()`:

```typescript
const volatileChanged = baseline.stableVolatileSha256 !== current.stableVolatileSha256
if (volatileChanged) parts.push('stable volatile context')
return { systemChanged, toolsChanged, volatileChanged, message }
```

Also update `DriftEvent`:

```typescript
export interface DriftEvent {
  systemChanged: boolean
  toolsChanged: boolean
  volatileChanged: boolean
  message: string
}
```

修改 `src/prompt/engine.ts` constructor 和 `checkDrift()`：

```typescript
this.volatileBlock = buildVolatileBlock(config.volatileCtx)
this.fingerprint = computeFingerprint(this.systemPrompt, config.staticCtx.tools, this.volatileBlock)
```

```typescript
const current = computeFingerprint(this.systemPrompt, this.config.staticCtx.tools, this.volatileBlock)
```

- [x] **步骤 4：运行测试验证通过**

运行：

```bash
npm test -- src/prompt/__tests__/engine.test.ts
```

预期：PASS。

- [x] **步骤 5：Commit**

```bash
git add src/prompt/fingerprint.ts src/prompt/engine.ts src/prompt/__tests__/engine.test.ts
git commit -m "fix(prompt): include stable volatile context in prefix fingerprint"
```

---

### 任务 6：补充 README 与最终验证

**文件：**
- 修改：`README.md`

- [x] **步骤 1：更新 README cache safety 说明**

在 README 的 prompt/cache 架构章节加入：

```markdown
### Cache Safety

Rivet uses several local caches to improve DeepSeek prefix-cache behavior and reduce repeated filesystem work. Cache layers must not bypass tool security boundaries:

- `read_file` and speculative prewarm share the same path validation and gitignore filtering.
- Prewarm cache keys are canonical absolute paths and are invalidated after `edit_file` / `write_file`.
- Prewarm is used only for full-file reads; ranged reads with `offset` or `limit` execute the normal tool path.
- `.rivet.md` and git status caches are scoped by cwd.
- Prefix fingerprints include system prompt, tool definitions, and stable volatile context.

Validation commands:

```bash
npm run typecheck
npm test
npm run build
```
```

- [x] **步骤 2：运行完整验证**

运行：

```bash
npm run typecheck
npm test
npm run build
```

预期：全部 PASS。

- [x] **步骤 3：检查 diff 中无真实 secrets**

运行：

```bash
git diff --cached --check
git diff --check
git diff -- src docs README.md | grep -Ei "sk-[a-zA-Z0-9]|api[_-]?key\s*=|password\s*=|secret\s*=" || true
```

预期：

- `git diff --check` 无输出。
- secret grep 无真实密钥命中。文档中出现 `API key` 字样可以接受，但不能出现真实 key 或 token 片段。

- [x] **步骤 4：Commit**

```bash
git add README.md
git commit -m "docs: document cache safety boundaries"
```

---

## 自检

### 规格覆盖度

- prewarm 路径逃逸：任务 1 + 2 + 3 覆盖。
- gitignored 文件进入 prewarm：任务 1 + 2 覆盖。
- stale cache：任务 2 + 3 覆盖 canonical key 与 write invalidation。
- offset/limit 错误命中：任务 2 + 3 覆盖。
- cwd 串缓存：任务 4 覆盖。
- prefix drift 假绿：任务 5 覆盖。
- 文档与验证：任务 6 覆盖。

### 占位符扫描

本文没有使用“待定”、“后续实现”、“补充细节”作为实施内容；每个代码步骤都给出具体代码和命令。

### 类型一致性

- `readFilePayload()` 在任务 1 定义，在任务 2 的 `buildPrewarmValue()` 中使用。
- `PrewarmValue` 在任务 2 定义，在 `PrewarmCache` 和 `AgentLoop` 中使用。
- `canUsePrewarmForRead()` 在任务 2 定义，在任务 3 的 `AgentLoop` fast-path 中使用。
- `stableVolatileSha256` 在任务 5 定义，并进入 `PrefixFingerprint` 与 `computeFingerprint()` 返回值。

---

计划已完成并保存到 `docs/superpowers/plans/2026-05-16-rivet-cache-safety-implementation.md`。两种执行方式：

**1. 子代理驱动（推荐）** - 每个任务调度一个新的子代理，任务间进行审查，快速迭代

**2. 内联执行** - 在当前会话中使用 executing-plans 执行任务，批量执行并设有检查点

选哪种方式？
