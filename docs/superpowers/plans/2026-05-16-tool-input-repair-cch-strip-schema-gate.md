# Tool Input Repair + CCH Strip + Schema Gate 实现计划

> **SUPERSEDED** by `2026-05-16-multi-pass-repair-pipeline.md`. Four Horsemen and Schema Gate implemented via RepairPipeline architecture. CCH stripping not needed (Rivet doesn't inject Claude Code cch markers).

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 将灵境 CTCL 已验证的 3 项核心优化移植到 Rivet 应用层——Tool Input Repair（四骑士修复）、CCH 剥离（恢复 prefix cache 命中）、SSE Schema Gate（拦截不完整 tool_use）。

**架构：** 新增 `src/agent/tool-repair.ts`（纯函数，无副作用）承载四骑士修复逻辑，被 `loop.ts` 在工具执行前调用；`prompt/engine.ts` 的 `buildRequest()` 增加 CCH 剥离步骤；`api/client.ts` 的 `content_block_stop` 处理增加 schema 校验拦截。三层各自独立，不引入跨层依赖。

**技术栈：** TypeScript，`node:test` + `tsx` runner，无新依赖。

**背景：** 灵境项目的 CTCL（`~/bin/claude-tool-compat-layer.mjs`，995 行）是一个本地反向代理，已在线上验证了以下能力：
1. **Four Horsemen 工具输入修复**——DeepSeek 等开源模型常输出 null optional 字段、JSON string 代替 array、single object 代替 array、bare string 代替 array。CTCL 按 schema 递归修复，成功率 >95%。
2. **CCH 剥离**——Claude Code 注入 `cch=xxx` 到 system message 导致每轮 cache MISS。CTCL 剥离后恢复 ~90% 命中率。
3. **SSE 流式工具缓冲 + Schema Gate**——等 `content_block_stop` 后组装完整 input，校验 required 字段，不合法的压制为 text block 让模型重试。

CTCL 在网络代理层做这些事。Rivet 是应用层 agent，需要在自己的代码里实现等效逻辑。本计划逐项移植，每项独立可测试。

---

## 文件结构

| 文件 | 职责 | 操作 |
|------|------|------|
| `src/agent/tool-repair.ts` | 四骑士修复：null→omit、JSON string→array、single obj→unwrap、bare string→wrap + autolink 清洗 | **新建** |
| `src/agent/__tests__/tool-repair.test.ts` | tool-repair 单元测试 | **新建** |
| `src/agent/loop.ts` | 在工具执行前调用 `repairToolInput`，记录修复日志 | **修改** |
| `src/prompt/engine.ts` | `buildRequest()` 中剥离 CCH 标记 | **修改** |
| `src/prompt/__tests__/engine-cch.test.ts` | CCH 剥离单元测试 | **新建** |
| `src/api/client.ts` | `content_block_stop` 处理增加 schema 校验 | **修改** |
| `src/api/__tests__/client-schema-gate.test.ts` | Schema gate 单元测试 | **新建** |

---

## 任务 1：Tool Input Repair — 核心修复函数

**文件：**
- 创建：`src/agent/tool-repair.ts`
- 创建：`src/agent/__tests__/tool-repair.test.ts`

### 1.1 编写失败测试：null → omit

- [ ] **步骤 1：编写测试**

`src/agent/__tests__/tool-repair.test.ts`:

```typescript
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { repairToolInput } from '../tool-repair.js'
import type { ToolDefinition } from '../../api/types.js'

const editSchema: ToolDefinition = {
  name: 'edit_file',
  description: 'Edit',
  input_schema: {
    type: 'object',
    properties: {
      file_path: { type: 'string' },
      old_string: { type: 'string' },
      new_string: { type: 'string' },
      replace_all: { type: 'boolean' },
    },
    required: ['file_path', 'old_string', 'new_string'],
  },
}

describe('repairToolInput — null → omit', () => {
  it('removes null values for optional fields', () => {
    const result = repairToolInput(
      { file_path: '/a.ts', old_string: 'x', new_string: 'y', replace_all: null },
      editSchema.input_schema,
    )
    assert.equal(result.fixed.replace_all, undefined)
    assert.equal(result.fixed.file_path, '/a.ts')
    assert.equal(result.fixLog.length, 1)
    assert.equal(result.fixLog[0]!.fix, 'nullToOmit')
  })

  it('keeps null for required fields (cannot omit)', () => {
    const result = repairToolInput(
      { file_path: null, old_string: 'x', new_string: 'y' },
      editSchema.input_schema,
    )
    assert.equal(result.fixed.file_path, null)
    assert.equal(result.fixLog.length, 0)
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

```bash
npx tsx --test src/agent/__tests__/tool-repair.test.ts
```

预期：FAIL — `Cannot find module '../tool-repair.js'`

- [ ] **步骤 3：创建最小实现**

`src/agent/tool-repair.ts`:

```typescript
import type { ToolDefinition } from '../api/types.js'

export interface RepairResult {
  fixed: Record<string, unknown>
  fixLog: Array<{ fix: string; field?: string }>
}

/**
 * Fix 1: Remove null values for optional fields.
 * Schema expects a value but model sent null → omit the key.
 */
function fixNullToOmit(
  input: Record<string, unknown>,
  schema: ToolDefinition['input_schema'],
): { fixed: Record<string, unknown>; count: number } {
  let count = 0
  const fixed: Record<string, unknown> = {}
  const required = new Set(schema.required ?? [])

  for (const [key, value] of Object.entries(input)) {
    if (value === null && !required.has(key)) {
      count++
      continue
    }
    fixed[key] = value
  }

  return { fixed, count }
}

export function repairToolInput(
  input: Record<string, unknown>,
  schema: ToolDefinition['input_schema'],
): RepairResult {
  const fixLog: RepairResult['fixLog'] = []

  // Fix 1: null → omit for optional fields
  const { fixed, count: nullCount } = fixNullToOmit(input, schema)
  if (nullCount > 0) {
    fixLog.push({ fix: 'nullToOmit', field: undefined })
  }

  return { fixed, fixLog }
}
```

- [ ] **步骤 4：运行测试验证通过**

```bash
npx tsx --test src/agent/__tests__/tool-repair.test.ts
```

预期：PASS

- [ ] **步骤 5：Commit**

```bash
git add src/agent/tool-repair.ts src/agent/__tests__/tool-repair.test.ts
git commit -m "feat(agent): add tool-repair module with null→omit fix"
```

---

### 1.2 编写失败测试：JSON string → array

- [ ] **步骤 1：编写测试**

追加到 `src/agent/__tests__/tool-repair.test.ts`:

```typescript
const grepSchema: ToolDefinition = {
  name: 'grep',
  description: 'Search',
  input_schema: {
    type: 'object',
    properties: {
      pattern: { type: 'string' },
      include: { type: 'array', items: { type: 'string' } },
    },
    required: ['pattern'],
  },
}

describe('repairToolInput — JSON string → array', () => {
  it('parses JSON array string into actual array', () => {
    const result = repairToolInput(
      { pattern: 'TODO', include: '["*.ts","*.tsx"]' },
      grepSchema.input_schema,
    )
    assert.deepEqual(result.fixed.include, ['*.ts', '*.tsx'])
    assert.equal(result.fixLog.length, 1)
    assert.equal(result.fixLog[0]!.fix, 'jsonArrayString')
    assert.equal(result.fixLog[0]!.field, 'include')
  })

  it('does not modify non-JSON strings', () => {
    const result = repairToolInput(
      { pattern: 'TODO', include: '*.ts' },
      grepSchema.input_schema,
    )
    assert.equal(result.fixed.include, '*.ts')
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

```bash
npx tsx --test src/agent/__tests__/tool-repair.test.ts
```

预期：FAIL — `fixed.include` 不是数组

- [ ] **步骤 3：实现 JSON string → array 修复**

在 `src/agent/tool-repair.ts` 中，`repairToolInput` 函数的 null→omit 之后添加字段级修复：

```typescript
/**
 * Fix 2: JSON-encoded array string → actual array.
 * Model outputs '["a","b"]' (string) instead of ["a","b"] (array).
 */
function fixJsonArrayString(value: unknown): { fixed: unknown; matched: boolean } {
  if (typeof value !== 'string') return { fixed: value, matched: false }
  const trimmed = value.trim()
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    try {
      const parsed = JSON.parse(trimmed)
      if (Array.isArray(parsed)) return { fixed: parsed, matched: true }
    } catch { /* not valid JSON */ }
  }
  return { fixed: value, matched: false }
}

/**
 * Fix 3: Single object wrapper → unwrap to array element.
 */
function fixSingleObjUnwrap(value: unknown): { fixed: unknown; matched: boolean } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { fixed: value, matched: false }
  const keys = Object.keys(value as Record<string, unknown>)
  if (keys.length === 0) return { fixed: value, matched: false }
  if (keys.every(k => /^\d+$/.test(k))) {
    return {
      fixed: keys.sort((a, b) => parseInt(a) - parseInt(b)).map(k => (value as Record<string, unknown>)[k]!),
      matched: true,
    }
  }
  return { fixed: value, matched: false }
}

/**
 * Fix 4: Bare string → wrap in single-element array.
 */
function fixBareStringWrap(value: unknown): { fixed: unknown; matched: boolean } {
  if (typeof value === 'string') return { fixed: [value], matched: true }
  return { fixed: value, matched: false }
}
```

然后在 `repairToolInput` 中，`fixNullToOmit` 之后添加字段级循环：

```typescript
export function repairToolInput(
  input: Record<string, unknown>,
  schema: ToolDefinition['input_schema'],
): RepairResult {
  const fixLog: RepairResult['fixLog'] = []

  // Fix 1: null → omit for optional fields
  const { fixed: step1, count: nullCount } = fixNullToOmit(input, schema)
  if (nullCount > 0) {
    fixLog.push({ fix: 'nullToOmit' })
  }

  // Fixes 2-4: per-field type coercion for array-typed properties
  const result = { ...step1 }
  const props = schema.properties ?? {}
  for (const [key, value] of Object.entries(result)) {
    const fieldSchema = props[key] as { type?: string; items?: unknown } | undefined
    if (fieldSchema?.type === 'array' && !Array.isArray(value)) {
      // Fix 2: JSON array string
      const r2 = fixJsonArrayString(value)
      if (r2.matched) {
        result[key] = r2.fixed
        fixLog.push({ fix: 'jsonArrayString', field: key })
        continue
      }
      // Fix 3: Single object unwrap
      const r3 = fixSingleObjUnwrap(value)
      if (r3.matched) {
        result[key] = r3.fixed
        fixLog.push({ fix: 'singleObjUnwrap', field: key })
        continue
      }
      // Fix 4: Bare string wrap
      const r4 = fixBareStringWrap(value)
      if (r4.matched) {
        result[key] = r4.fixed
        fixLog.push({ fix: 'bareStringWrap', field: key })
        continue
      }
    }
  }

  return { fixed: result, fixLog }
}
```

- [ ] **步骤 4：运行测试验证通过**

```bash
npx tsx --test src/agent/__tests__/tool-repair.test.ts
```

预期：PASS

- [ ] **步骤 5：Commit**

```bash
git add src/agent/tool-repair.ts src/agent/__tests__/tool-repair.test.ts
git commit -m "feat(agent): add jsonArrayString/singleObjUnwrap/bareStringWrap to tool-repair"
```

---

### 1.3 编写测试：single object unwrap + bare string wrap

- [ ] **步骤 1：编写测试**

追加到 `src/agent/__tests__/tool-repair.test.ts`:

```typescript
describe('repairToolInput — single object unwrap', () => {
  it('unwraps numeric-keyed pseudo-array to real array', () => {
    const result = repairToolInput(
      { pattern: 'TODO', include: { '0': '*.ts', '1': '*.tsx' } },
      grepSchema.input_schema,
    )
    assert.deepEqual(result.fixed.include, ['*.ts', '*.tsx'])
    assert.equal(result.fixLog[0]!.fix, 'singleObjUnwrap')
  })
})

describe('repairToolInput — bare string wrap', () => {
  it('wraps bare string into single-element array', () => {
    const result = repairToolInput(
      { pattern: 'TODO', include: '*.ts' },
      grepSchema.input_schema,
    )
    assert.deepEqual(result.fixed.include, ['*.ts'])
    assert.equal(result.fixLog[0]!.fix, 'bareStringWrap')
  })
})

describe('repairToolInput — no-op on valid input', () => {
  it('passes through already-valid input unchanged', () => {
    const result = repairToolInput(
      { pattern: 'TODO', include: ['*.ts', '*.tsx'] },
      grepSchema.input_schema,
    )
    assert.deepEqual(result.fixed.include, ['*.ts', '*.tsx'])
    assert.equal(result.fixLog.length, 0)
  })
})
```

- [ ] **步骤 2：运行测试验证通过**

```bash
npx tsx --test src/agent/__tests__/tool-repair.test.ts
```

预期：全部 PASS（实现已在 1.2 完成）

- [ ] **步骤 3：Commit**

```bash
git add src/agent/__tests__/tool-repair.test.ts
git commit -m "test(agent): add unwrap/bareString/no-op tests for tool-repair"
```

---

### 1.4 编写测试：autolink 清洗

- [ ] **步骤 1：编写测试**

追加到 `src/agent/__tests__/tool-repair.test.ts`:

```typescript
import { fixAutoLinks } from '../tool-repair.js'

describe('fixAutoLinks', () => {
  it('strips degraded autolinks where link text matches URL path', () => {
    const result = fixAutoLinks('[notes.md](http:// notes.md)')
    assert.equal(result.fixed, 'notes.md')
    assert.equal(result.count, 1)
  })

  it('strips autolinks with full URL matching link text', () => {
    const result = fixAutoLinks('[src/index.ts](https://src/index.ts)')
    assert.equal(result.fixed, 'src/index.ts')
    assert.equal(result.count, 1)
  })

  it('preserves real markdown links with different text and URL', () => {
    const input = '[click here](https://example.com/docs)'
    const result = fixAutoLinks(input)
    assert.equal(result.fixed, input)
    assert.equal(result.count, 0)
  })

  it('fixes autolinks embedded in tool input strings', () => {
    const result = fixAutoLinks('[README.md](http://README.md)')
    assert.equal(result.fixed, 'README.md')
    assert.equal(result.count, 1)
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

```bash
npx tsx --test src/agent/__tests__/tool-repair.test.ts
```

预期：FAIL — `fixAutoLinks` not exported

- [ ] **步骤 3：实现 autolink 清洗**

在 `src/agent/tool-repair.ts` 底部添加：

```typescript
const AUTO_LINK_RE = /\[([^\]]+)\]\(\s*(?:https?:\/\/)?\s*\S*\b([^\s)]+)\s*\)/gi

export function fixAutoLinks(str: string): { fixed: string; count: number } {
  let count = 0
  const fixed = str.replace(AUTO_LINK_RE, (match, linkText, urlPath) => {
    const cleanPath = linkText.trim()
    const cleanUrl = urlPath.trim().replace(/^\/+/, '')
    if (cleanPath === cleanUrl || cleanUrl.endsWith(cleanPath)) {
      count++
      return cleanPath
    }
    return match
  })
  return { fixed, count }
}

/**
 * Recursively fix auto-links in all string values within tool input.
 */
export function fixAutoLinksInInput(input: unknown): { fixed: unknown; count: number } {
  if (typeof input === 'string') return fixAutoLinks(input)
  if (Array.isArray(input)) {
    let total = 0
    const fixed = input.map(item => {
      const r = fixAutoLinksInInput(item)
      total += r.count
      return r.fixed
    })
    return { fixed, count: total }
  }
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    let total = 0
    const out: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
      const r = fixAutoLinksInInput(value)
      out[key] = r.fixed
      total += r.count
    }
    return { fixed: out, count: total }
  }
  return { fixed: input, count: 0 }
}
```

然后在 `repairToolInput` 的 return 之前添加 autolink 修复：

```typescript
  // Fix: autolink cleanup on all string fields
  const autoLinkResult = fixAutoLinksInInput(result)
  if (autoLinkResult.count > 0) {
    Object.assign(result, autoLinkResult.fixed as Record<string, unknown>)
    fixLog.push({ fix: 'autoLink', field: undefined })
  }
```

- [ ] **步骤 4：运行测试验证通过**

```bash
npx tsx --test src/agent/__tests__/tool-repair.test.ts
```

预期：PASS

- [ ] **步骤 5：Commit**

```bash
git add src/agent/tool-repair.ts src/agent/__tests__/tool-repair.test.ts
git commit -m "feat(agent): add autolink cleanup to tool-repair"
```

---

## 任务 2：Wire Tool Repair into AgentLoop

**文件：**
- 修改：`src/agent/loop.ts:291-315`（工具执行前插入修复）
- 修改：`src/agent/__tests__/loop-evidence.test.ts`（无需改动，修复透明）

### 2.1 编写失败测试：修复在 AgentLoop 中生效

- [ ] **步骤 1：编写测试**

追加到 `src/agent/__tests__/loop-evidence.test.ts`（或新建独立文件 `src/agent/__tests__/loop-repair.test.ts`）:

```typescript
import { describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'
import { AgentLoop } from '../loop.js'
import { SessionContext } from '../context.js'
import { PromptEngine } from '../../prompt/engine.js'
import { ToolRegistry } from '../../tools/registry.js'
import { READ_FILE_TOOL } from '../../tools/read-file.js'
import type { ApiClient, StreamCallbacks } from '../../api/client.js'
import type { Tool, ToolResult } from '../../tools/types.js'

function makeTextBlock(text: string) { return { type: 'text' as const, text } }
function makeToolUseBlock(id: string, name: string, input: Record<string, unknown>) {
  return { type: 'tool_use' as const, id, name, input }
}

function makeEngine() {
  return new PromptEngine({
    model: 'deepseek-v4-pro',
    maxTokens: 1024,
    staticCtx: { tools: [READ_FILE_TOOL.definition] },
    volatileCtx: { cwd: '/test' },
  })
}

describe('AgentLoop — tool input repair', () => {
  it('repairs null optional field before tool execution', async () => {
    let executedInput: Record<string, unknown> | undefined

    const grepTool: Tool = {
      definition: {
        name: 'grep',
        description: 'Search',
        input_schema: {
          type: 'object',
          properties: {
            pattern: { type: 'string' },
            include: { type: 'array', items: { type: 'string' } },
          },
          required: ['pattern'],
        },
      },
      execute: async (params) => {
        executedInput = params.input
        return { content: 'no matches' }
      },
      requiresApproval: () => false,
      isConcurrencySafe: () => true,
      isEnabled: () => true,
    }

    const registry = new ToolRegistry()
    registry.register(grepTool)

    let callCount = 0
    const client = {
      stream: mock.fn(async (_req: unknown, cb: StreamCallbacks, _sig?: AbortSignal) => {
        callCount++
        if (callCount === 1) {
          // Model sends null for optional field
          cb.onContentBlock(makeToolUseBlock('tu_rep1', 'grep', { pattern: 'TODO', include: null }))
          cb.onStopReason('tool_use', { input_tokens: 100, output_tokens: 50 })
        } else {
          cb.onContentBlock(makeTextBlock('Done.'))
          cb.onStopReason('end_turn', { input_tokens: 100, output_tokens: 30 })
        }
      }),
    } as unknown as ApiClient

    const agent = new AgentLoop(
      { client, promptEngine: makeEngine(), toolRegistry: registry, maxTurns: 5, contextWindow: 1_000_000, compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' } },
      new SessionContext(),
      '/test',
    )

    await agent.run('search', {
      onTextDelta: () => {},
      onThinkingDelta: () => {},
      onToolUse: () => {},
      onToolResult: () => {},
      onTurnComplete: () => {},
      onError: () => {},
      onAbort: () => {},
      onApprovalRequired: async () => false,
    })

    assert.ok(executedInput, 'tool should have been executed')
    assert.equal(executedInput!.include, undefined, 'null optional field should be omitted after repair')
    assert.equal(executedInput!.pattern, 'TODO', 'required field should be preserved')
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

```bash
npx tsx --test src/agent/__tests__/loop-repair.test.ts
```

预期：FAIL — `executedInput.include` 是 `null` 而不是 `undefined`

- [ ] **步骤 3：Wire repairToolInput into loop.ts**

在 `src/agent/loop.ts` 顶部添加 import：

```typescript
import { repairToolInput, fixAutoLinksInInput } from './tool-repair.js'
```

在 `loop.ts` 的工具执行循环中，`preHookResult` 处理之后、`doomLevel` 检查之前（约 316 行），添加修复逻辑：

```typescript
              // Tool input repair — fix common model output mistakes
              const toolDef = this.config.toolRegistry.get(tu.name)
              if (toolDef) {
                const repairResult = repairToolInput(tu.input as Record<string, unknown>, toolDef.definition.input_schema)
                if (repairResult.fixLog.length > 0) {
                  tu.input = repairResult.fixed
                  params.input = repairResult.fixed
                }
              }
```

- [ ] **步骤 4：运行测试验证通过**

```bash
npx tsx --test src/agent/__tests__/loop-repair.test.ts
```

预期：PASS

- [ ] **步骤 5：运行全量测试确认无回归**

```bash
npm test
```

预期：全部 PASS

- [ ] **步骤 6：Commit**

```bash
git add src/agent/loop.ts src/agent/__tests__/loop-repair.test.ts
git commit -m "feat(agent): wire tool-repair into AgentLoop before execution"
```

---

## 任务 3：CCH Strip — 恢复 Prefix Cache 命中率

**文件：**
- 修改：`src/prompt/engine.ts:146-155`（`buildRequest()` 中剥离 CCH）
- 创建：`src/prompt/__tests__/engine-cch.test.ts`

**背景：** Claude Code 注入 `cch=xxx` 标记到 system prompt 中，每次请求值不同，导致第三方 API（DeepSeek 等）的 prefix cache 100% MISS。剥离后恢复缓存命中。灵境 CTCL 用正则 `/;[^\S\r\n]*cch=[^;\r\n]*(?:;(?=[^\S\r\n]*(?:\r?\n|$)))?/g` 剥离。Rivet 自己组装 system prompt，不会注入 CCH——但 Rivet 的 `buildRequest()` 直接发送 `system: this.systemPrompt` 字符串，**不需要 CCH 剥离**。

**但是**，Rivet 发送的 system prompt 中 volatile block 每轮可能变化（最新一轮带 toolHistory），这会破坏 prefix cache。当前 `engine.ts` 已通过 `buildStableVolatileBlock` vs `buildLatestTurnVolatileBlock` 分离处理了这个问题。因此 **CCH 剥离在 Rivet 中不是必需的**——Rivet 不走 Claude Code 的 CCH 机制。

**替代方案：** 为 DeepSeek API 请求添加 session ID header（等价于灵境 CTCL 的 cache affinity 优化）。

### 3.1 编写失败测试：session pinning header

- [ ] **步骤 1：编写测试**

`src/prompt/__tests__/engine-cch.test.ts`:

```typescript
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { PromptEngine } from '../engine.js'

describe('PromptEngine — cache affinity', () => {
  it('includes session fingerprint in system prompt for cache affinity', () => {
    const engine = new PromptEngine({
      model: 'deepseek-v4-pro',
      maxTokens: 1024,
      staticCtx: { tools: [] },
      volatileCtx: { cwd: '/test' },
    })

    const fp = engine.getFingerprint()
    assert.ok(fp.combinedSha256, 'fingerprint should be computed')
    assert.ok(fp.combinedSha256.length === 64, 'SHA-256 hex should be 64 chars')
  })

  it('produces identical system prompt across calls when config unchanged', () => {
    const config = {
      model: 'deepseek-v4-pro',
      maxTokens: 1024,
      staticCtx: { tools: [] },
      volatileCtx: { cwd: '/test' },
    }

    const engine1 = new PromptEngine({ ...config })
    const engine2 = new PromptEngine({ ...config })

    assert.equal(engine1.getSystemPrompt(), engine2.getSystemPrompt())
    assert.deepEqual(engine1.getFingerprint(), engine2.getFingerprint())
  })
})
```

- [ ] **步骤 2：运行测试验证通过**

```bash
npx tsx --test src/prompt/__tests__/engine-cch.test.ts
```

预期：PASS — 当前实现已满足（fingerprint 已存在，system prompt 稳定）

- [ ] **步骤 3：Commit**

```bash
git add src/prompt/__tests__/engine-cch.test.ts
git commit -m "test(prompt): add cache affinity fingerprint stability tests"
```

**结论：** CCH 剥离在 Rivet 中不需要实现——Rivet 不注入 CCH。Prefix cache 稳定性已通过 `buildStableVolatileBlock` + fingerprint 机制保证。灵境 CTCL 的 CCH 剥离是针对 Claude Code 的特定问题，Rivet 架构天然规避。

---

## 任务 4：SSE Schema Gate — 拦截不完整 tool_use

**文件：**
- 修改：`src/api/client.ts:320-342`（`content_block_stop` 处理）
- 创建：`src/api/__tests__/client-schema-gate.test.ts`

### 4.1 编写失败测试：空 tool_use 被拦截

- [ ] **步骤 1：编写测试**

`src/api/__tests__/client-schema-gate.test.ts`:

```typescript
import { describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'
import { ReadableStream } from 'node:stream/web'
import { ApiClient } from '../client.js'
import type { ContentBlock } from '../types.js'

function sseResponse(events: string[]): Response {
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(events.join('')))
      controller.close()
    },
  })
  return new Response(body as unknown as ReadableStream, { status: 200 })
}

describe('ApiClient — schema gate', () => {
  it('suppresses tool_use with empty input as text block', async () => {
    const originalFetch = globalThis.fetch
    const events = [
      'event: content_block_start\n',
      'data: {"content_block":{"type":"tool_use","id":"tu_empty","name":"bash"}}\n\n',
      'event: content_block_delta\n',
      'data: {"delta":{"type":"input_json_delta","partial_json":"{}"}}\n\n',
      'event: content_block_stop\n',
      'data: {}\n\n',
      'event: message_delta\n',
      'data: {"delta_stop_reason":"tool_use","usage":{}}\n\n',
    ]
    globalThis.fetch = mock.fn(async () => sseResponse(events)) as unknown as typeof fetch

    const blocks: ContentBlock[] = []
    const client = new ApiClient({
      baseUrl: 'https://example.test',
      apiKey: 'test-key',
      model: 'test-model',
      maxTokens: 100,
      thinking: 'disabled',
      unsupported: [],
      hasToolJsonInContentBug: false,
    })

    await client.stream(
      { model: 'test-model', messages: [{ role: 'user', content: 'x' }], max_tokens: 100, stream: true, tools: [{ name: 'bash', description: 'Shell', input_schema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } }] },
      {
        onTextDelta: () => {},
        onThinkingDelta: () => {},
        onContentBlock: block => blocks.push(block),
        onStopReason: () => {},
        onError: error => { throw error },
      },
    )

    globalThis.fetch = originalFetch

    // Should NOT have a tool_use block — empty input should be suppressed
    const toolUses = blocks.filter(b => b.type === 'tool_use')
    assert.equal(toolUses.length, 0, 'empty tool_use should be suppressed')

    // Should have a text block with explanation
    const textBlocks = blocks.filter(b => b.type === 'text')
    assert.ok(textBlocks.length >= 1, 'should have a text block with suppression notice')
  })

  it('passes through valid tool_use with required fields', async () => {
    const originalFetch = globalThis.fetch
    const events = [
      'event: content_block_start\n',
      'data: {"content_block":{"type":"tool_use","id":"tu_valid","name":"bash"}}\n\n',
      'event: content_block_delta\n',
      'data: {"delta":{"type":"input_json_delta","partial_json":"{\\"command\\":\\"pwd\\"}"}}\n\n',
      'event: content_block_stop\n',
      'data: {}\n\n',
      'event: message_delta\n',
      'data: {"delta_stop_reason":"tool_use","usage":{}}\n\n',
    ]
    globalThis.fetch = mock.fn(async () => sseResponse(events)) as unknown as typeof fetch

    const blocks: ContentBlock[] = []
    const client = new ApiClient({
      baseUrl: 'https://example.test',
      apiKey: 'test-key',
      model: 'test-model',
      maxTokens: 100,
      thinking: 'disabled',
      unsupported: [],
      hasToolJsonInContentBug: false,
    })

    await client.stream(
      { model: 'test-model', messages: [{ role: 'user', content: 'x' }], max_tokens: 100, stream: true, tools: [{ name: 'bash', description: 'Shell', input_schema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } }] },
      {
        onTextDelta: () => {},
        onThinkingDelta: () => {},
        onContentBlock: block => blocks.push(block),
        onStopReason: () => {},
        onError: error => { throw error },
      },
    )

    globalThis.fetch = originalFetch

    const toolUses = blocks.filter(b => b.type === 'tool_use')
    assert.equal(toolUses.length, 1, 'valid tool_use should pass through')
    if (toolUses[0]!.type === 'tool_use') {
      assert.equal(toolUses[0]!.input.command, 'pwd')
    }
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

```bash
npx tsx --test src/api/__tests__/client-schema-gate.test.ts
```

预期：FAIL — 空 tool_use（`{}` input）当前会直接传递为 tool_use block

- [ ] **步骤 3：实现 schema gate**

在 `src/api/client.ts` 中：

1. 给 `stream()` 方法添加 `tools` 参数提取：

在 `stream()` 方法的开头提取 tool schemas：

```typescript
async stream(
  request: MessageRequest,
  callbacks: StreamCallbacks,
  signal?: AbortSignal,
): Promise<void> {
  const toolSchemas = new Map<string, string[]>()
  if (request.tools) {
    for (const tool of request.tools) {
      toolSchemas.set(tool.name, tool.input_schema.required ?? [])
    }
  }
  const finalRequest = this.stripUnsupported({ ...request, stream: true })
```

2. 修改 `content_block_stop` 处理中的 tool_use 交付逻辑（约 326-341 行）：

```typescript
              case 'content_block_stop': {
                // Flush completed text/thinking blocks
                flushTextBlock()
                flushThinkingBlock()

                // Deliver completed tool_use block with parsed input
                if (toolUseBuffer) {
                  let input: Record<string, unknown> = {}
                  try {
                    input = JSON.parse(toolUseBuffer.partialJson) as Record<string, unknown>
                  } catch {
                    input = recoverTruncatedJSON(toolUseBuffer.partialJson)
                  }

                  // Schema gate: suppress tool_use with missing required fields
                  const requiredFields = toolSchemas.get(toolUseBuffer.name)
                  if (requiredFields && requiredFields.length > 0) {
                    const missing = requiredFields.filter(f => input[f] === undefined || input[f] === null)
                    if (missing.length > 0) {
                      const msg = `[schema-gate] Suppressed ${toolUseBuffer.name} tool call: missing required fields (${missing.join(', ')}). Please retry with complete parameters.`
                      callbacks.onContentBlock({ type: 'text', text: msg })
                      toolUseBuffer = null
                      break
                    }
                  }

                  callbacks.onContentBlock({
                    type: 'tool_use',
                    id: toolUseBuffer.id,
                    name: toolUseBuffer.name,
                    input,
                  })
                  toolUseBuffer = null
                }
                break
              }
```

- [ ] **步骤 4：运行测试验证通过**

```bash
npx tsx --test src/api/__tests__/client-schema-gate.test.ts
```

预期：PASS

- [ ] **步骤 5：运行全量测试确认无回归**

```bash
npm test
```

预期：全部 PASS

- [ ] **步骤 6：Commit**

```bash
git add src/api/client.ts src/api/__tests__/client-schema-gate.test.ts
git commit -m "feat(api): add schema gate to suppress incomplete tool_use blocks"
```

---

## 任务 5：端到端集成测试

**文件：**
- 创建：`src/__tests__/ctcl-parity.test.ts`

### 5.1 编写集成测试验证完整修复管线

- [ ] **步骤 1：编写测试**

`src/__tests__/ctcl-parity.test.ts`:

```typescript
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { repairToolInput, fixAutoLinks } from '../agent/tool-repair.js'

describe('CTCL parity — four horsemen', () => {
  const bashSchema = {
    type: 'object' as const,
    properties: {
      command: { type: 'string' },
      timeout: { type: 'number' },
      args: { type: 'array', items: { type: 'string' } },
    },
    required: ['command'],
  }

  it('null optional → omit (Fix 1)', () => {
    const { fixed, fixLog } = repairToolInput(
      { command: 'ls', timeout: null },
      bashSchema,
    )
    assert.equal(fixed.command, 'ls')
    assert.equal('timeout' in fixed, false)
    assert.ok(fixLog.some(f => f.fix === 'nullToOmit'))
  })

  it('JSON array string → array (Fix 2)', () => {
    const { fixed, fixLog } = repairToolInput(
      { command: 'ls', args: '["-la","-h"]' },
      bashSchema,
    )
    assert.deepEqual(fixed.args, ['-la', '-h'])
    assert.ok(fixLog.some(f => f.fix === 'jsonArrayString'))
  })

  it('bare string → array (Fix 4)', () => {
    const { fixed, fixLog } = repairToolInput(
      { command: 'ls', args: '-la' },
      bashSchema,
    )
    assert.deepEqual(fixed.args, ['-la'])
    assert.ok(fixLog.some(f => f.fix === 'bareStringWrap'))
  })

  it('no fix on valid input', () => {
    const { fixed, fixLog } = repairToolInput(
      { command: 'ls', args: ['-la', '-h'] },
      bashSchema,
    )
    assert.deepEqual(fixed.args, ['-la', '-h'])
    assert.equal(fixLog.length, 0)
  })

  it('autolink in string field gets cleaned', () => {
    const { fixed } = fixAutoLinks('edit [notes.md](http://notes.md)')
    assert.ok(!fixed.includes('[notes.md]'))
    assert.ok(fixed.includes('notes.md'))
  })
})
```

- [ ] **步骤 2：运行测试验证通过**

```bash
npx tsx --test src/__tests__/ctcl-parity.test.ts
```

预期：PASS

- [ ] **步骤 3：运行全量测试**

```bash
npm test
```

预期：全部 PASS

- [ ] **步骤 4：Commit**

```bash
git add src/__tests__/ctcl-parity.test.ts
git commit -m "test: add CTCL parity integration tests for four horsemen"
```

---

## 任务 6：TypeScript 编译检查 + 最终验证

- [ ] **步骤 1：运行 typecheck**

```bash
npm run typecheck
```

预期：无错误

- [ ] **步骤 2：运行全量测试**

```bash
npm test
```

预期：全部 PASS，测试数量增加约 15-20 个

- [ ] **步骤 3：Final commit**

```bash
git add -A
git commit -m "feat(agent,api): CTCL parity — tool input repair + schema gate

Port 2 of 3 core CTCL optimizations to Rivet application layer:

1. Tool Input Repair (tool-repair.ts): Four horsemen fixes
   - null → omit for optional fields
   - JSON array string → actual array
   - Single object unwrap → array
   - Bare string → array wrap
   - Markdown autolink cleanup

2. SSE Schema Gate (client.ts): Suppress incomplete tool_use
   - Buffer streaming tool_use until content_block_stop
   - Validate required fields against tool schema
   - Suppress invalid calls as text blocks for model retry

CCH strip NOT needed — Rivet's stable/volatile prompt separation
avoids the Claude Code CCH cache-bust problem natively.

CTCL feature parity: 2/3 ported (repair + gate), 1/3 natively solved (CCH)."
```

---

## 自检

### 1. 规格覆盖度

| 规格需求 | 对应任务 |
|---------|---------|
| null → omit | 任务 1.1 |
| JSON string → array | 任务 1.2 |
| single obj unwrap | 任务 1.3 |
| bare string wrap | 任务 1.3 |
| autolink cleanup | 任务 1.4 |
| Wire into AgentLoop | 任务 2 |
| CCH strip / cache affinity | 任务 3（确认不需要） |
| SSE schema gate | 任务 4 |
| 集成验证 | 任务 5 |

### 2. 占位符扫描

无"TODO"、"待定"、"补充细节"等占位符。所有步骤包含完整代码。

### 3. 类型一致性

- `repairToolInput(input, schema)` — `input: Record<string, unknown>`, `schema: ToolDefinition['input_schema']` — 贯穿任务 1-2-5 一致
- `fixAutoLinks(str: string)` → `{ fixed: string; count: number }` — 贯穿任务 1.4 和 5 一致
- `ToolUseBuffer` 的 `partialJson: string` + `content_block_stop` 处理中 `toolSchemas.get(name)` 返回 `string[] | undefined` — 一致
- `StreamCallbacks.onContentBlock(block: ContentBlock)` — text 和 tool_use 都是 ContentBlock 子类型 — 一致
