# 上下文入口治理 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 在内容进入模型上下文前完成文件类型识别、默认预览、精确范围提示，避免日志、JSONL、生成物和中等体积工具输出成为长期上下文负债。

**架构：** 新增纯函数 `decideReadPolicy()` 统一判定文件读取策略；`read_file` 使用该策略决定 full、preview、reject-with-range；`grep` 在单文件日志定位时输出可执行的 `offset/limit` 建议。策略函数不读文件、不访问磁盘，便于测试。

**技术栈：** TypeScript strict、node:test、现有 `ToolResult`、`read_file`、`grep`、`truncateContent`

---

> 总索引：`docs/superpowers/plans/2026-05-25-把这些写到计划里-可能文档太长了-分三个文档来做-d1-d2-d3.md`

## 1. Scope check

本计划只处理“内容进入模型上下文前”的入口治理：

| 范围 | 包含 | 不包含 |
|---|---|---|
| 文件读取策略 | 日志、JSONL、生成物、minified 文件、普通源码的默认读取行为 | PromptEngine 消息布局 |
| 范围边界提示 | head/tail 边界、`offset/limit` 建议、单文件 grep 定位 | 全项目扫描策略 |
| 工具输出可见性 | `read_file` 和 `grep` 的模型输出文本 | artifact store 存储格式重构 |

独立性判断：该计划不修改 `src/prompt/engine.ts`，不修改 cache usage 解析，不修改 delivery gate。完成后可单独验证工具行为。

---

## 2. File structure

| 文件 | 职责 | 操作 |
|---|---|---|
| `src/tools/read-policy.ts` | 纯函数：读取策略判定，不做 I/O | 创建 |
| `src/tools/__tests__/read-policy.test.ts` | read policy TDD 测试 | 创建 |
| `src/tools/read-file.ts:90-210` | 调用 read policy 并保持显式 `offset/limit` 放行 | 修改 |
| `src/tools/__tests__/read-file.test.ts` | 覆盖日志、JSONL、源码、显式 range | 修改 |
| `src/tools/grep.ts:40-120` | 单文件日志 grep 输出范围建议 | 修改 |
| `src/tools/__tests__/grep.test.ts` | 验证单文件日志 grep 的建议文本 | 修改 |

---

## 3. Tasks

### Task 1：为读取策略创建失败测试

**文件：**
- 创建：`src/tools/__tests__/read-policy.test.ts`
- 参考：`src/tools/read-file.ts:90-210`

- [ ] **步骤 1：创建测试文件**

创建 `src/tools/__tests__/read-policy.test.ts`：

```typescript
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { decideReadPolicy } from '../read-policy.js'

describe('decideReadPolicy', () => {
  it('previews log-like files over the guard size when no explicit range is provided', () => {
    const decision = decideReadPolicy({ filePath: '/repo/logs/app.log', sizeBytes: 20_000, hasExplicitRange: false })
    assert.equal(decision.kind, 'log')
    assert.equal(decision.action, 'preview')
    assert.equal(decision.previewLines, 80)
    assert.equal(decision.maxRangeLines, 200)
  })

  it('allows explicit ranges for JSONL files', () => {
    const decision = decideReadPolicy({ filePath: '/repo/logs/app.jsonl', sizeBytes: 20_000, hasExplicitRange: true })
    assert.equal(decision.kind, 'jsonl')
    assert.equal(decision.action, 'full')
  })

  it('allows normal source files below the hard size guard', () => {
    const decision = decideReadPolicy({ filePath: '/repo/src/app.ts', sizeBytes: 20_000, hasExplicitRange: false })
    assert.equal(decision.kind, 'source')
    assert.equal(decision.action, 'full')
  })

  it('rejects generated minified files unless a range is explicit', () => {
    const decision = decideReadPolicy({ filePath: '/repo/dist/app.min.js', sizeBytes: 20_000, hasExplicitRange: false })
    assert.equal(decision.kind, 'minified')
    assert.equal(decision.action, 'reject-with-range')
  })
})
```

- [ ] **步骤 2：运行测试确认失败**

```bash
npx tsx --test src/tools/__tests__/read-policy.test.ts
```

预期结果：失败，错误包含 `Cannot find module '../read-policy.js'`。

---

### Task 2：实现 `decideReadPolicy()` 纯函数

**文件：**
- 创建：`src/tools/read-policy.ts`
- 测试：`src/tools/__tests__/read-policy.test.ts`

- [ ] **步骤 1：创建实现文件**

创建 `src/tools/read-policy.ts`：

```typescript
export type ReadPolicyKind = 'source' | 'log' | 'jsonl' | 'generated' | 'minified' | 'unknown'
export type ReadPolicyAction = 'full' | 'preview' | 'reject-with-range'

export interface ReadPolicyInput {
  filePath: string
  sizeBytes: number
  hasExplicitRange: boolean
}

export interface ReadPolicyDecision {
  kind: ReadPolicyKind
  action: ReadPolicyAction
  reason: string
  previewLines: number
  maxRangeLines: number
}

const LOG_PREVIEW_GUARD_BYTES = 16 * 1024
const DEFAULT_PREVIEW_LINES = 80
const DEFAULT_MAX_RANGE_LINES = 200

function classifyPath(filePath: string): ReadPolicyKind {
  const lower = filePath.toLowerCase()
  if (/\.(?:jsonl|ndjson)(?:\.\d+)?$/.test(lower)) return 'jsonl'
  if (/\.(?:log|out|err|trace)(?:\.\d+)?$/.test(lower)) return 'log'
  if (/\.min\.(?:js|css)$/.test(lower)) return 'minified'
  if (/(?:^|\/)(?:dist|build|coverage|\.next)\//.test(lower)) return 'generated'
  if (/\.(?:ts|tsx|js|jsx|mjs|cjs|json|md|css|scss|html|yml|yaml)$/.test(lower)) return 'source'
  return 'unknown'
}

export function decideReadPolicy(input: ReadPolicyInput): ReadPolicyDecision {
  const kind = classifyPath(input.filePath)
  const base = { kind, previewLines: DEFAULT_PREVIEW_LINES, maxRangeLines: DEFAULT_MAX_RANGE_LINES }

  if (input.hasExplicitRange) {
    return { ...base, action: 'full', reason: 'explicit range requested' }
  }
  if ((kind === 'log' || kind === 'jsonl') && input.sizeBytes > LOG_PREVIEW_GUARD_BYTES) {
    return { ...base, action: 'preview', reason: 'log-like file over preview guard' }
  }
  if (kind === 'generated' || kind === 'minified') {
    return { ...base, action: 'reject-with-range', reason: 'generated or minified file requires an explicit range' }
  }
  return { ...base, action: 'full', reason: 'safe default read' }
}
```

- [ ] **步骤 2：运行测试确认通过**

```bash
npx tsx --test src/tools/__tests__/read-policy.test.ts
```

预期结果：4 tests pass。

- [ ] **步骤 3：提交读取策略**

```bash
git add src/tools/read-policy.ts src/tools/__tests__/read-policy.test.ts
git commit -m "feat(tools): add read policy classifier"
```

预期结果：生成一个只包含 policy 和测试的提交。

---

### Task 3：集成 read policy 到 `read_file`

**文件：**
- 修改：`src/tools/read-file.ts:90-210`
- 修改：`src/tools/__tests__/read-file.test.ts`
- 测试：`src/tools/__tests__/read-policy.test.ts`

- [ ] **步骤 1：扩展 read-file 测试**

在 `src/tools/__tests__/read-file.test.ts` 中新增两个测试：

```typescript
it('uses read policy preview for first full reads of large log-like files', () => {
  mkdirSync(join(dir, 'logs'), { recursive: true })
  const log = Array.from({ length: 500 }, (_, i) => `event ${i} ${'x'.repeat(80)}`).join('\n')
  writeFileSync(join(dir, 'logs/app.log'), log, 'utf-8')

  const payload = readFilePayload(dir, { filePath: 'logs/app.log' })

  assert.equal(payload.rawContent, log)
  assert.ok(payload.modelContent.includes('looks like a log/JSONL output file'))
  assert.ok(payload.modelContent.includes('Preview boundaries: head offset=1 limit=80; tail offset=421 limit=80'))
  assert.ok(payload.modelContent.includes('offset=<known line>, limit<=200'))
  assert.ok(payload.modelContent.includes('Do not scan the whole project for this log'))
  assert.ok(payload.modelContent.length < log.length)
})

it('rejects generated minified files without an explicit range', () => {
  mkdirSync(join(dir, 'dist'), { recursive: true })
  writeFileSync(join(dir, 'dist/app.min.js'), 'x'.repeat(20_000), 'utf-8')
  assert.throws(
    () => readFilePayload(dir, { filePath: 'dist/app.min.js' }),
    /Use offset and limit to read a specific range/,
  )
})
```

- [ ] **步骤 2：运行 read-file 测试确认新增用例失败**

```bash
npx tsx --test src/tools/__tests__/read-file.test.ts
```

预期结果：至少 minified 文件拒绝测试失败，因为 `read_file` 尚未调用 `decideReadPolicy()`。

- [ ] **步骤 3：修改 `read-file.ts`**

在 `src/tools/read-file.ts` 顶部新增：

```typescript
import { decideReadPolicy } from './read-policy.js'
```

在 `statSync(filePath).size` 后构造：

```typescript
const policy = decideReadPolicy({
  filePath,
  sizeBytes: fileSize,
  hasExplicitRange: options.offset !== undefined || options.limit !== undefined,
})
```

在硬性 `MAX_TOOL_INPUT_BYTES` 检查之后、`readFileSync()` 之前加入：

```typescript
if (policy.action === 'reject-with-range') {
  throw new Error(`${policy.reason}. Use offset and limit to read a specific range.`)
}
```

保留当前日志 preview 分支，但将 magic numbers 替换为 `policy.previewLines` 和 `policy.maxRangeLines`，模型提示必须包含：

```txt
Preview boundaries: head offset=1 limit=<n>; tail offset=<m> limit=<k>
Next step: use read_file(file_path=..., offset=<known line>, limit<=200)
```

- [ ] **步骤 4：运行相关测试确认通过**

```bash
npx tsx --test src/tools/__tests__/read-policy.test.ts
npx tsx --test src/tools/__tests__/read-file.test.ts
```

预期结果：两个测试文件全部 pass。

- [ ] **步骤 5：提交 read_file 集成**

```bash
git add src/tools/read-file.ts src/tools/__tests__/read-file.test.ts
git commit -m "fix(tools): apply read policy to file reads"
```

预期结果：生成 read_file 集成提交。

---

### Task 4：让 grep 对单文件日志输出范围建议

**文件：**
- 修改：`src/tools/grep.ts:40-120`
- 修改：`src/tools/__tests__/grep.test.ts`

- [ ] **步骤 1：新增 grep 测试**

在 `src/tools/__tests__/grep.test.ts` 新增测试：

```typescript
it('suggests bounded read_file ranges for single-file log matches', async () => {
  const logsDir = join(dir, 'logs')
  mkdirSync(logsDir, { recursive: true })
  const lines = Array.from({ length: 200 }, (_, i) => i === 120 ? `L${i} ERROR failed` : `L${i} ok`)
  writeFileSync(join(logsDir, 'app.log'), lines.join('\n'), 'utf-8')

  const result = await GREP_TOOL.execute({
    toolUseId: 'grep-log',
    cwd: dir,
    input: { pattern: 'ERROR', path: 'logs/app.log', max_results: 10 },
  })

  assert.equal(result.isError, undefined)
  assert.ok(result.content.includes('Suggested next reads:'))
  assert.ok(result.content.includes('read_file(file_path="logs/app.log"'))
  assert.ok(result.content.includes('limit<=80'))
  assert.ok(!result.content.includes('scan the whole project'))
})
```

- [ ] **步骤 2：运行 grep 测试确认失败**

```bash
npx tsx --test src/tools/__tests__/grep.test.ts
```

预期结果：新增测试失败，输出不包含 `Suggested next reads:`。

- [ ] **步骤 3：修改 `grep.ts`**

在 `src/tools/grep.ts:40-120` 添加两个本地 helper：

```typescript
function isLogLikeFilePath(path: string): boolean {
  return /\.(?:log|jsonl|ndjson|out|err|trace)(?:\.\d+)?$/i.test(path)
}

function appendLogRangeHints(content: string, searchPath: string): string {
  if (!isLogLikeFilePath(searchPath)) return content
  const lines = content.split('\n')
  const hints = lines
    .map(line => line.match(/:(\d+):/)?.[1])
    .filter((lineNo): lineNo is string => Boolean(lineNo))
    .slice(0, 5)
    .map(lineNo => {
      const offset = Math.max(1, Number(lineNo) - 20)
      return `- read_file(file_path="${searchPath}", offset=${offset}, limit<=80)`
    })
  if (hints.length === 0) return content
  return `${content}\n\nSuggested next reads:\n${hints.join('\n')}`
}
```

在 native fallback 和 ripgrep 成功路径返回前，对 `content` 调用 `appendLogRangeHints(content, searchPath)`。如果 ripgrep helper 在内部构造返回值，优先在最终 `ToolResult.content` 处追加，避免重复逻辑。

- [ ] **步骤 4：运行 grep 测试确认通过**

```bash
npx tsx --test src/tools/__tests__/grep.test.ts
```

预期结果：grep tests 全部 pass。

- [ ] **步骤 5：提交 grep 范围建议**

```bash
git add src/tools/grep.ts src/tools/__tests__/grep.test.ts
git commit -m "feat(tools): suggest bounded log reads from grep"
```

预期结果：生成 grep 行为提交。

---

## 4. Verification

```bash
npx tsx --test src/tools/__tests__/read-policy.test.ts
# 预期：read policy tests 全部 pass

npx tsx --test src/tools/__tests__/read-file.test.ts
# 预期：read-file tests 全部 pass

npx tsx --test src/tools/__tests__/grep.test.ts
# 预期：grep tests 全部 pass

npx tsc --noEmit
# 预期：TypeScript 0 errors
```

最终提交后运行：

```bash
git log --oneline -3
# 预期：包含 read policy、read_file 集成、grep 范围建议三个 conventional commits
```

---

## 5. Self-check

1. **Spec coverage:**
   - 日志首次全量读取浪费上下文 → Task 1、Task 2、Task 3。
   - 明确范围边界，不做全项目扫描 → Task 3、Task 4。
   - 普通源码不受影响 → Task 1 的 source case、Task 3 的 read-file 回归测试。
   - 每步独立可测 → 每个 Task 都有单独测试和提交。

2. **Placeholder scan:**
   - 本计划不包含禁用占位语句。
   - 所有函数名、类型名、路径均在任务中明确定义。

3. **Type consistency:**
   - `ReadPolicyKind`、`ReadPolicyAction`、`ReadPolicyDecision` 在测试和实现中一致。
   - `decideReadPolicy()` 只接收 `ReadPolicyInput`，不读取文件，符合纯函数设计。
   - `readFilePayload()` 继续返回 `ReadFilePayload`，未改变 public return shape。

---

## 6. Execution handoff

计划已完成并保存到 `docs/superpowers/plans/2026-05-25-d1-context-ingress.md`。两种执行方式：
1. 子代理驱动（推荐）— 每个任务调度一个新的子代理，任务间进行审查，快速迭代。
2. 内联执行 — 在当前会话中使用 executing-plans 执行任务，批量执行并设有检查点。
选哪种方式？
