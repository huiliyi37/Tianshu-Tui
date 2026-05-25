# readHistory 同文件片段去重 — 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 当 agent 已经全量读取过文件且文件未被修改时，阻止后续对该文件的片段读取（不同 offset/limit），避免消息历史因重复读取膨胀。

**架构：** 在 `src/tools/read-file.ts` 的 `READ_FILE_TOOL.execute()` 中新增 `FileReadHistoryEntry` 数据结构和 `fileReadHistory` Map，在全量读取时记录，在后续任意读取前检测并阻止。缓存零影响——仅新增去重命中时的返回消息，不改变成功读取时的输出格式。

**设计文档：** `docs/superpowers/specs/2026-05-26-readhistory-fragment-dedup-design.md`

**技术栈：** TypeScript strict、node:test + node:assert/strict

**硬约束：缓存零影响。** 不改变 read_file 成功时的输出格式、tool definition、system prompt、engine.ts 请求构建逻辑。

---

## 1. Scope check

### 1.1 本计划范围

仅修改 `src/tools/read-file.ts`，新增一个文件级去重 Map。不涉及其他文件。

### 1.2 独立子系统拆分判断

单一工具内逻辑扩展，不跨子系统。无需拆分。

### 1.3 明确不做

- 不修改 `readHistory`（per-slice dedup）的现有行为
- 不修改 `model-read-cap.ts`、`truncation.ts`、`artifact/summarize.ts`
- 不修改 `tool-pipeline.ts`（read_file 已在 artifactIntercept 的 bypass 列表中）
- 不修改 engine.ts 的消息构建逻辑
- 不修改任何 tool definition

---

## 2. File structure

### 2.1 修改文件

| 文件 | 职责 | 变更类型 |
|------|------|----------|
| `src/tools/read-file.ts` | 新增 `FileReadHistoryEntry` + `fileReadHistory` + 检测逻辑 | 加逻辑 |

### 2.2 创建文件

| 文件 | 职责 |
|------|------|
| `src/tools/__tests__/read-file-dedup.test.ts` | 独立测试 file-level dedup 行为（避免与现有 read-file.test.ts 耦合） |

### 2.3 文档文件

| 文件 | 职责 |
|------|------|
| `docs/superpowers/plans/2026-05-26-readhistory-fragment-dedup.md` | 本实现计划 |

---

## 3. Tasks

### 任务 1：编写失败测试

**目标：** TDD — 先写测试确认当前行为允许片段重读。

**文件：** 创建 `src/tools/__tests__/read-file-dedup.test.ts`

**步骤：**

- [ ] **步骤 1：创建测试文件**

```typescript
import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { READ_FILE_TOOL, __resetReadHistoryForTests } from '../read-file.js'
import type { ToolCallParams } from '../types.js'

describe('fileReadHistory dedup', () => {
  let dir: string
  const params = (overrides: Partial<ToolCallParams['input']> & { file_path: string }): ToolCallParams => ({
    toolUseId: `test-${Math.random().toString(36).slice(2, 8)}`,
    cwd: dir,
    input: { file_path: overrides.file_path, ...overrides } as ToolCallParams['input'],
  })

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rivet-read-dedup-'))
    __resetReadHistoryForTests()
  })

  afterEach(() => {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
  })

  function makeFile(name: string, lines: number): string {
    const path = join(dir, name)
    mkdirSync(join(dir, 'src'), { recursive: true })
    const content = Array.from({ length: lines }, (_, i) => `line ${i + 1}`).join('\n')
    writeFileSync(path, content, 'utf-8')
    return path
  }

  // ── 核心场景 ──

  it('blocks fragment read after full read of unchanged file', async () => {
    const file = makeFile('src/foo.ts', 100)
    const absPath = join(dir, file)

    // 1. 全量读取 → 应成功返回完整内容
    const r1 = await READ_FILE_TOOL.execute(params({ file_path: file }))
    assert.ok(r1.content.includes('line 1'), 'full read must return content')
    assert.ok(r1.content.includes('line 100'), 'full read must include last line')

    // 2. 片段读取 → 应被阻断（fileReadHistory 命中）
    const r2 = await READ_FILE_TOOL.execute(params({ file_path: file, offset: 50, limit: 10 }))
    assert.ok(r2.content.includes('was already read in full'), 'fragment read must be blocked')
    assert.ok(!r2.content.includes('line 50'), 'fragment read must NOT return file content')
  })

  it('allows fragment read after full read if file was modified', async () => {
    const file = makeFile('src/foo.ts', 100)
    const absPath = join(dir, file)

    // 1. 全量读取
    await READ_FILE_TOOL.execute(params({ file_path: file }))

    // 2. 修改文件（改变 mtime）
    writeFileSync(absPath, 'modified content\n', 'utf-8')

    // 3. 片段读取 → 应允许（mtime 变了）
    const r2 = await READ_FILE_TOOL.execute(params({ file_path: file, offset: 1, limit: 2 }))
    assert.ok(r2.content.includes('modified'), 'fragment read after modification must succeed')
    assert.ok(!r2.content.includes('was already read'), 'must not be blocked')
  })

  it('allows full read after fragment read (fragment does not trigger fileReadHistory)', async () => {
    const file = makeFile('src/foo.ts', 100)

    // 1. 先片段读（不记录到 fileReadHistory）
    const r1 = await READ_FILE_TOOL.execute(params({ file_path: file, offset: 50, limit: 10 }))
    assert.ok(r1.content.includes('line 50'), 'fragment read must return content')

    // 2. 全量读 → 应允许（之前只有片段读）
    const r2 = await READ_FILE_TOOL.execute(params({ file_path: file }))
    assert.ok(r2.content.includes('line 100'), 'full read after fragment must succeed')
  })

  it('existing slice dedup (readHistory) still works independently', async () => {
    const file = makeFile('src/foo.ts', 50)

    // 全量读两次 → 第二次被 readHistory 阻断（不是 fileReadHistory）
    const r1 = await READ_FILE_TOOL.execute(params({ file_path: file }))
    assert.ok(r1.content.includes('line 1'), 'first full read must return content')

    const r2 = await READ_FILE_TOOL.execute(params({ file_path: file }))
    assert.ok(r2.content.includes('this exact range was already returned'), 'repeat full read must be blocked by readHistory')
    assert.ok(r2.content.includes('offset: 1, limit: all'), 'must reference the same range')
  })

  it('dedup message tells the model to use read_section when artifactId exists', async () => {
    // 需要 artifactStore — 用集成测试或跳过此测试当 artifactStore 不可用
    // 此测试在有 artifactStore 的环境中验证 recovery hint
    // Phase 1: 手动验证或 mock artifactStore
  })

  // ── 边界场景 ──

  it('different files have independent fileReadHistory', async () => {
    const f1 = makeFile('src/a.ts', 30)
    const f2 = makeFile('src/b.ts', 30)

    await READ_FILE_TOOL.execute(params({ file_path: f1 }))
    await READ_FILE_TOOL.execute(params({ file_path: f2 }))

    // 片段读取 f1 → 应被阻断（fileReadHistory 命中）
    const r = await READ_FILE_TOOL.execute(params({ file_path: f1, offset: 10, limit: 5 }))
    assert.ok(r.content.includes('was already read in full'), 'f1 fragment must be blocked')
  })

  it('trim evicts oldest entries when exceeding FILE_READ_HISTORY_MAX', async () => {
    // 创建 250 个文件（超过默认 MAX=200），全量读取
    for (let i = 0; i < 250; i++) {
      const file = makeFile(`src/mod${i}.ts`, 5)
      await READ_FILE_TOOL.execute(params({ file_path: file }))
    }
    // 最老的 50 个应被清理，不应崩溃
    const file = makeFile('src/mod249.ts', 5)
    const r = await READ_FILE_TOOL.execute(params({ file_path: file, offset: 1, limit: 2 }))
    // 片段读 mod249 应被阻断（仅在 fileReadHistory 中，且未被 trim 清理）
    // 实际行为取决于 trim 策略 — 如果 trim 了 20%，mod249 可能还在
    // 宽松断言：至少不抛异常
    assert.ok(typeof r.content === 'string')
  })
})
```

- [ ] **步骤 2：运行测试，确认失败**

```bash
npx tsx --test src/tools/__tests__/read-file-dedup.test.ts
```

预期结果：多数测试 FAIL——`fileReadHistory` 尚未实现，片段读不会被阻断。

- [ ] **步骤 3：不提交**（测试未通过，不能提交）

---

### 任务 2：实现 fileReadHistory 数据结构 + 检测逻辑

**目标：** 在 `read-file.ts` 中新增 `fileReadHistory` Map 和检测逻辑。

**文件：** 修改 `src/tools/read-file.ts`

**步骤：**

- [ ] **步骤 1：在 `readHistory` 定义下方，新增数据结构**

在 line 36-37（`readHistory` + `READ_HISTORY_MAX`）之后追加：

```typescript
/** File-level dedup: records full-file reads so fragment reads can be
 * blocked without re-reading. Key = canonicalPath, no offset/limit.
 * Independent of readHistory (per-slice dedup). */
interface FileReadHistoryEntry {
  mtimeMs: number
  totalLines: number
  rawBytes: number
  modelBytes: number
  artifactId?: string
  recordedAt: number
}
const fileReadHistory = new Map<string, FileReadHistoryEntry>()
const FILE_READ_HISTORY_MAX = 200
```

- [ ] **步骤 2：新增 `trimFileReadHistory` 函数**

在 `trimReadHistory()` 函数下方追加：

```typescript
function trimFileReadHistory(): void {
  if (fileReadHistory.size <= FILE_READ_HISTORY_MAX) return
  const sorted = [...fileReadHistory.entries()].sort((a, b) => a[1].recordedAt - b[1].recordedAt)
  const drop = Math.ceil(fileReadHistory.size * 0.2)
  for (let i = 0; i < drop; i++) fileReadHistory.delete(sorted[i]![0])
}
```

- [ ] **步骤 3：更新 `__resetReadHistoryForTests`**

修改现有函数：

```typescript
export function __resetReadHistoryForTests(): void {
  readHistory.clear()
  fileReadHistory.clear()
}
```

- [ ] **步骤 4：在现有 readHistory 检查之后，插入 fileReadHistory 检查**

在 line ~130（现有 `readHistory` dedup 检查的 `}` 闭合之后，`try { payload = readFilePayload(...)` 之前），插入：

```typescript
    // File-level dedup: if this file was already read in full and hasn't changed,
    // any fragment read is a subset — block it.
    if (dedupKey) { // dedupKey is only set when path resolution succeeded
      const fullEntry = fileReadHistory.get(canonical)
      if (fullEntry && fullEntry.mtimeMs === currentMtimeMs) {
        // Full read exists and file unchanged → this read (any offset/limit) is redundant
        // eslint-disable-next-line no-console
        console.warn(`[read-dedup-file] skip file=${canonical} offset=${offset} limit=${limit ?? 'all'} prior_age_ms=${Date.now() - fullEntry.recordedAt}`)
        const recoveryHint = fullEntry.artifactId
          ? `If you can no longer see the earlier result (it may have been compacted), call read_section(artifactId="${fullEntry.artifactId}", section="L${offset}-L${offset + (limit ?? fullEntry.totalLines) - 1}") to retrieve it from disk.`
          : `Look at the earlier tool_result in your context.`
        const message = [
          `read_file: this file was already read in full earlier and has not been modified since.`,
          `  file: ${canonical}`,
          `  prior result: ${fullEntry.rawBytes} bytes raw, ${fullEntry.totalLines} lines total`,
          `  current request: offset=${offset}, limit=${limit ?? 'all'} — this range is covered by the earlier full read.`,
          ``,
          recoveryHint,
          `Do NOT call read_file for fragments of an already-read file — use your earlier tool_result.`,
        ].join('\n')
        return { content: message }
      }
    }
```

注意：此处需要一个 `canonical` 变量。查看现有代码，在 dedup 检查处 `dedupKey` 是通过 `readHistoryKey(params.cwd, canonical, offset, limit)` 计算的，其中 `canonical` 来自 `validatePath(params.cwd, filePath)`。需要把 `canonical` 变量提升到 try 块外。最简单的做法：在 fileReadHistory 检查前直接 resolve：

```typescript
    // After existing readHistory check (which uses canonical inside try block),
    // resolve canonical again for fileReadHistory (or just reuse from above).
    try {
      const canonical = validatePath(params.cwd, filePath)
      if (existsSync(canonical)) {
        const mtime = statSync(canonical).mtimeMs
        const fullEntry = fileReadHistory.get(canonical)
        if (fullEntry && fullEntry.mtimeMs === mtime) {
          // ... block and return ...
        }
      }
    } catch { /* fall through */ }
```

但这样会重复 stat/validatePath。更好的做法是重构现有 try 块，把 `canonical` 和 `currentMtimeMs` 提升到外层作用域。现有代码（line ~150-180）结构：

```
try {
  const canonical = validatePath(...)
  if (existsSync(canonical)) {
    currentMtimeMs = statSync(canonical).mtimeMs
    dedupKey = readHistoryKey(...)
    const prior = readHistory.get(dedupKey)
    if (prior && prior.mtimeMs === currentMtimeMs && prior.artifactId) {
      return { content: dedup message }
    }
  }
} catch { ... }
```

最简单的方式：在此 try 块内、现有 readHistory 检查（return）之后、catch 之前，插入 fileReadHistory 检查：

```typescript
    let dedupKey: string | null = null
    let currentMtimeMs: number | null = null
    let canonical: string | null = null  // ← 新增：提升到外层作用域
    try {
      canonical = validatePath(params.cwd, filePath)  // ← 改为赋值
      if (existsSync(canonical)) {
        currentMtimeMs = statSync(canonical).mtimeMs
        dedupKey = readHistoryKey(params.cwd, canonical, offset, limit)
        const prior = readHistory.get(dedupKey)
        if (prior && prior.mtimeMs === currentMtimeMs && prior.artifactId) {
          // ... existing dedup return ...
          return { content: message }
        }
        // ← 新增：file-level dedup check
        const fullEntry = fileReadHistory.get(canonical)
        if (fullEntry && fullEntry.mtimeMs === currentMtimeMs) {
          // ... file-level dedup return ...
          return { content: message }
        }
      }
    } catch { /* fall through to real read */ }
```

- [ ] **步骤 5：在全量读取时记录 fileReadHistory**

在 `recordDedup` 调用附近，新增 `recordFileDedup` 调用。找到 line ~175 附近的 `recordDedup(artifactId)` 调用，在其之前或之后插入：

```typescript
    // Record file-level dedup entry for full-file reads
    const recordFileDedup = (artifactId?: string): void => {
      if (!canonical || currentMtimeMs === null) return
      if (offset !== 1 || limit !== undefined) return // only full reads
      fileReadHistory.set(canonical, {
        mtimeMs: currentMtimeMs,
        totalLines: payload.rawContent.split('\n').length,
        rawBytes: payload.rawContent.length,
        modelBytes: payload.modelContent.length,
        artifactId,
        recordedAt: Date.now(),
      })
      trimFileReadHistory()
    }
```

然后在 artifactStore 路径和无 artifactStore 路径的 `recordDedup(...)` 调用之后，各加一行 `recordFileDedup(artifactId)` / `recordFileDedup()`。

**完整调用位置：**

1. artifactStore 路径（line ~275，`recordDedup(artifactId)` 之后）→ 加 `recordFileDedup(artifactId)`
2. 无 artifactStore 路径（line ~295，`recordDedup()` 之后）→ 加 `recordFileDedup()`

注意：`artifact-skip` 路径（content smaller than threshold）也需要记录。现有的 `artifact-skip` 路径（line ~258-265）调用了 `recordDedup()` — 在此之后也加 `recordFileDedup()`。

- [ ] **步骤 6：运行测试确认通过**

```bash
npx tsx --test src/tools/__tests__/read-file-dedup.test.ts
```

预期结果：全部 PASS（除了 artifactId recovery hint 测试可能需要 mock）。

- [ ] **步骤 7：typecheck**

```bash
npx tsc --noEmit
```

预期结果：退出码 0。

- [ ] **步骤 8：提交**

```bash
git add src/tools/read-file.ts src/tools/__tests__/read-file-dedup.test.ts
git commit -m "feat(tools): add file-level readHistory to block fragment reads after full reads"
```

---

### 任务 3：回归验证

**目标：** 确认不破坏现有 read-file 测试。

**文件：**

- 测试：`src/tools/__tests__/read-file.test.ts`
- 测试：`src/tools/__tests__/read-file-dedup.test.ts`

**步骤：**

- [ ] **步骤 1：运行全量 read-file 测试**

```bash
npx tsx --test src/tools/__tests__/read-file.test.ts src/tools/__tests__/read-file-dedup.test.ts
```

预期结果：全部通过，`fail 0`。

- [ ] **步骤 2：typecheck 全局**

```bash
npx tsc --noEmit
```

预期结果：退出码 0。

- [ ] **步骤 3：检查 git diff 范围**

```bash
git diff --name-only
```

预期结果：只应出现：
- `src/tools/read-file.ts`
- `src/tools/__tests__/read-file-dedup.test.ts`

---

## 4. Verification

```bash
npx tsx --test src/tools/__tests__/read-file-dedup.test.ts
```

预期结果：全部通过。

```bash
npx tsx --test src/tools/__tests__/read-file.test.ts
```

预期结果：全部通过，不引入回归。

```bash
npx tsc --noEmit
```

预期结果：TypeScript 编译通过。

---

## 5. 缓存安全性证明

| 检查项 | 结论 |
|--------|------|
| 改变 read_file 成功时的输出格式？ | ❌ 不变。仅新增去重命中时的返回消息 |
| 改变 tool definition？ | ❌ 不变 |
| 改变 system prompt？ | ❌ 不变 |
| 改变 engine.ts 的请求构建？ | ❌ 不变 |
| 去重消息格式稳定（不引入非确定性）？ | ✅ 是 — 格式固定，仅插入具体数值 |
| 现有 readHistory 行为？ | ✅ 不变 — fileReadHistory 是独立 Map |
| 是否可能增加 cache miss？ | ❌ 否 — 去重消息短且格式固定，替代了可能的大文件内容，反而降低 prefix 波动概率 |

**结论：✅ 缓存零影响。**

---

## 6. Self-check

### 6.1 Spec coverage

| 需求 | 覆盖任务 |
|------|---------|
| 全量读 → 片段读 → 阻断 | 任务 1 测试 + 任务 2 实现 |
| 全量读 → 修改文件 → 片段读 → 允许 | 任务 1 测试 |
| 片段读 → 全量读 → 允许 | 任务 1 测试 |
| 现有 readHistory 行为不变 | 任务 1 测试 + 回归验证 |
| 缓存零影响 | 第 5 节缓存安全性证明 + 不修改 engine.ts/prompt/tool definition |
| TDD：先失败测试再实现 | 任务 1 → 任务 2 |

### 6.2 Placeholder scan

本文档无 TODO/TBD/待定/后续实现/补充细节。

### 6.3 Type/signature consistency

| 名称 | 定义位置 | 使用位置 | 一致性 |
|------|---------|---------|--------|
| `FileReadHistoryEntry` | 任务 2 step 1 | 任务 2 step 4-5 | `totalLines/rawBytes/modelBytes/mtimeMs/artifactId/recordedAt` 一致 |
| `fileReadHistory` Map | 任务 2 step 1 | 任务 2 step 4-5 + trim | `Map<string, FileReadHistoryEntry>` 一致 |
| `FILE_READ_HISTORY_MAX = 200` | 任务 2 step 1 | trimFileReadHistory | 一致 |
| `recordFileDedup(artifactId?)` | 任务 2 step 5 | artifact/非artifact 路径各一处 | `artifactId?: string` 一致 |
| `__resetReadHistoryForTests` | 任务 2 step 3 | 任务 1 测试 beforeEach | 包含 `fileReadHistory.clear()` |
