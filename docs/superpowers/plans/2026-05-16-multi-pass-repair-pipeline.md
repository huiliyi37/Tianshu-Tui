# Multi-Pass Repair Pipeline 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 实现 5-pass 工具输入修复管线——从 SSE 流输出到工具执行之间，依次经过结构恢复、schema 校验、四骑士修复、语义修复、自适应注入，将 DeepSeek V4 Pro 的 tool_use 成功率从 ~70% 提升到 ~92%。

**架构：** `src/agent/repair-pipeline.ts` 定义 `RepairPass` 接口和 `RepairPipeline` 类，各 pass 为独立纯函数模块。Pass 2 (Schema Gate) 在 `api/client.ts` 的 `content_block_stop` 处拦截；Pass 3-4 在 `agent/loop.ts` 工具执行前通过管线运行；Pass 5 通过 `PromptEngine.setRepairHint()` 注入下一轮 volatile block。每个 pass 产生遥测记录。

**技术栈：** TypeScript，`node:test` + `tsx` runner，无新依赖。

---

## 文件结构

| 文件 | 职责 | 操作 |
|------|------|------|
| `src/agent/repair-pipeline.ts` | RepairPass 接口 + RepairPipeline 类 + 遥测类型 | **新建** |
| `src/agent/repair-passes.ts` | Pass 3 (四骑士) + Pass 4 (语义修复) 的纯函数实现 | **新建** |
| `src/agent/__tests__/repair-pipeline.test.ts` | 管线 + 各 pass 单元测试 | **新建** |
| `src/agent/loop.ts` | 工具执行前调用 RepairPipeline.run() | **修改** |
| `src/api/client.ts` | content_block_stop 中加 schema gate (Pass 2) | **修改** |
| `src/api/__tests__/schema-gate.test.ts` | Schema gate 单元测试 | **新建** |
| `src/agent/repair-hint.ts` | Pass 5: 自适应注入逻辑 (失败计数 + hint 生成) | **新建** |
| `src/agent/__tests__/repair-hint.test.ts` | Pass 5 单元测试 | **新建** |
| `src/prompt/engine.ts` | 添加 setRepairHint() 方法 | **修改** |
| `src/prompt/volatile.ts` | buildLatestTurnVolatileBlock 增加 repairHint 参数 | **修改** |
| `src/__tests__/repair-parity.test.ts` | 端到端集成测试 | **新建** |

---

## 任务 1：管线骨架 — RepairPass 接口 + RepairPipeline

**文件：**
- 创建：`src/agent/repair-pipeline.ts`
- 创建：`src/agent/__tests__/repair-pipeline.test.ts`

- [x] **步骤 1：编写失败测试**

`src/agent/__tests__/repair-pipeline.test.ts`:

```typescript
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { RepairPipeline } from '../repair-pipeline.js'
import type { RepairPass, RepairContext, RepairResult } from '../repair-pipeline.js'

describe('RepairPipeline', () => {
  it('runs passes in order and collects telemetry', () => {
    const pass1: RepairPass = {
      name: 'test-pass-1',
      run(input, _ctx) {
        return { output: { ...input, added: true }, applied: true, fixType: 'test1' }
      },
    }
    const pass2: RepairPass = {
      name: 'test-pass-2',
      run(input, _ctx) {
        return { output: input, applied: false }
      },
    }

    const pipeline = new RepairPipeline([pass1, pass2])
    const ctx: RepairContext = { toolName: 'bash', schema: { type: 'object', properties: {}, required: [] } }
    const result = pipeline.run({ command: 'ls' }, ctx)

    assert.equal(result.output.added, true)
    assert.equal(result.output.command, 'ls')
    assert.equal(result.telemetry.length, 1)
    assert.equal(result.telemetry[0]!.pass, 'test-pass-1')
    assert.equal(result.telemetry[0]!.fixType, 'test1')
  })

  it('passes output of one pass as input to next', () => {
    const upper: RepairPass = {
      name: 'upper',
      run(input, _ctx) {
        const cmd = input.command as string
        return { output: { ...input, command: cmd.toUpperCase() }, applied: true, fixType: 'upper' }
      },
    }
    const trim: RepairPass = {
      name: 'trim',
      run(input, _ctx) {
        return { output: input, applied: false }
      },
    }

    const pipeline = new RepairPipeline([upper, trim])
    const ctx: RepairContext = { toolName: 'bash', schema: { type: 'object', properties: {}, required: [] } }
    const result = pipeline.run({ command: 'hello' }, ctx)

    assert.equal(result.output.command, 'HELLO')
  })

  it('returns empty telemetry when no pass applied', () => {
    const noop: RepairPass = {
      name: 'noop',
      run(input) { return { output: input, applied: false } },
    }
    const pipeline = new RepairPipeline([noop])
    const ctx: RepairContext = { toolName: 'bash', schema: { type: 'object', properties: {}, required: [] } }
    const result = pipeline.run({ x: 1 }, ctx)

    assert.equal(result.telemetry.length, 0)
    assert.equal(result.output.x, 1)
  })
})
```

- [x] **步骤 2：运行测试验证失败**

运行：`npx tsx --test src/agent/__tests__/repair-pipeline.test.ts`
预期：FAIL — `Cannot find module '../repair-pipeline.js'`

- [x] **步骤 3：实现管线骨架**

`src/agent/repair-pipeline.ts`:

```typescript
import type { ToolDefinition } from '../api/types.js'

export interface RepairContext {
  toolName: string
  schema: ToolDefinition['input_schema']
}

export interface RepairResult {
  output: Record<string, unknown>
  applied: boolean
  fixType?: string
}

export interface RepairPass {
  name: string
  run(input: Record<string, unknown>, ctx: RepairContext): RepairResult
}

export interface RepairTelemetryEntry {
  pass: string
  fixType: string
  toolName: string
  timestamp: number
}

export interface PipelineResult {
  output: Record<string, unknown>
  telemetry: RepairTelemetryEntry[]
}

export class RepairPipeline {
  constructor(private passes: RepairPass[]) {}

  run(input: Record<string, unknown>, ctx: RepairContext): PipelineResult {
    const telemetry: RepairTelemetryEntry[] = []
    let current = input

    for (const pass of this.passes) {
      const result = pass.run(current, ctx)
      if (result.applied) {
        current = result.output
        telemetry.push({
          pass: pass.name,
          fixType: result.fixType ?? pass.name,
          toolName: ctx.toolName,
          timestamp: Date.now(),
        })
      }
    }

    return { output: current, telemetry }
  }
}
```

- [x] **步骤 4：运行测试验证通过**

运行：`npx tsx --test src/agent/__tests__/repair-pipeline.test.ts`
预期：PASS

- [x] **步骤 5：Commit**

```bash
git add src/agent/repair-pipeline.ts src/agent/__tests__/repair-pipeline.test.ts
git commit -m "feat(agent): add RepairPipeline + RepairPass interface"
```

---

## 任务 2：Pass 3 — 四骑士修复 (Four Horsemen)

**文件：**
- 创建：`src/agent/repair-passes.ts`
- 修改：`src/agent/__tests__/repair-pipeline.test.ts`

- [x] **步骤 1：编写失败测试**

追加到 `src/agent/__tests__/repair-pipeline.test.ts`:

```typescript
import { fourHorsemenPass, semanticRepairPass } from '../repair-passes.js'

const editSchema = {
  type: 'object' as const,
  properties: {
    file_path: { type: 'string' },
    old_string: { type: 'string' },
    new_string: { type: 'string' },
    replace_all: { type: 'boolean' },
  },
  required: ['file_path', 'old_string', 'new_string'],
}

const grepSchema = {
  type: 'object' as const,
  properties: {
    pattern: { type: 'string' },
    include: { type: 'array', items: { type: 'string' } },
  },
  required: ['pattern'],
}

describe('fourHorsemenPass', () => {
  it('Fix 1: removes null for optional fields', () => {
    const ctx: RepairContext = { toolName: 'edit_file', schema: editSchema }
    const result = fourHorsemenPass.run(
      { file_path: '/a.ts', old_string: 'x', new_string: 'y', replace_all: null },
      ctx,
    )
    assert.equal(result.applied, true)
    assert.equal(result.output.replace_all, undefined)
    assert.equal(result.output.file_path, '/a.ts')
  })

  it('Fix 1: keeps null for required fields', () => {
    const ctx: RepairContext = { toolName: 'edit_file', schema: editSchema }
    const result = fourHorsemenPass.run(
      { file_path: null, old_string: 'x', new_string: 'y' },
      ctx,
    )
    assert.equal(result.output.file_path, null)
  })

  it('Fix 2: parses JSON array string into actual array', () => {
    const ctx: RepairContext = { toolName: 'grep', schema: grepSchema }
    const result = fourHorsemenPass.run(
      { pattern: 'TODO', include: '["*.ts","*.tsx"]' },
      ctx,
    )
    assert.deepEqual(result.output.include, ['*.ts', '*.tsx'])
    assert.equal(result.applied, true)
  })

  it('Fix 3: unwraps numeric-keyed object to array', () => {
    const ctx: RepairContext = { toolName: 'grep', schema: grepSchema }
    const result = fourHorsemenPass.run(
      { pattern: 'TODO', include: { '0': '*.ts', '1': '*.tsx' } },
      ctx,
    )
    assert.deepEqual(result.output.include, ['*.ts', '*.tsx'])
  })

  it('Fix 4: wraps bare string into array', () => {
    const ctx: RepairContext = { toolName: 'grep', schema: grepSchema }
    const result = fourHorsemenPass.run(
      { pattern: 'TODO', include: '*.ts' },
      ctx,
    )
    assert.deepEqual(result.output.include, ['*.ts'])
  })

  it('no-op on valid input', () => {
    const ctx: RepairContext = { toolName: 'grep', schema: grepSchema }
    const result = fourHorsemenPass.run(
      { pattern: 'TODO', include: ['*.ts'] },
      ctx,
    )
    assert.equal(result.applied, false)
    assert.deepEqual(result.output.include, ['*.ts'])
  })
})
```

- [x] **步骤 2：运行测试验证失败**

运行：`npx tsx --test src/agent/__tests__/repair-pipeline.test.ts`
预期：FAIL — `Cannot find module '../repair-passes.js'`

- [x] **步骤 3：实现四骑士 pass**

`src/agent/repair-passes.ts`:

```typescript
import type { RepairPass, RepairContext, RepairResult } from './repair-pipeline.js'

export const fourHorsemenPass: RepairPass = {
  name: 'four-horsemen',
  run(input: Record<string, unknown>, ctx: RepairContext): RepairResult {
    let applied = false
    const required = new Set(ctx.schema.required ?? [])
    const props = ctx.schema.properties ?? {}

    // Fix 1: null → omit for optional fields
    const step1: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(input)) {
      if (value === null && !required.has(key)) {
        applied = true
        continue
      }
      step1[key] = value
    }

    // Fixes 2-4: per-field array coercion
    const result = { ...step1 }
    for (const [key, value] of Object.entries(result)) {
      const fieldSchema = props[key] as { type?: string } | undefined
      if (fieldSchema?.type !== 'array' || Array.isArray(value)) continue

      // Fix 2: JSON array string → actual array
      if (typeof value === 'string') {
        const trimmed = value.trim()
        if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
          try {
            const parsed = JSON.parse(trimmed)
            if (Array.isArray(parsed)) { result[key] = parsed; applied = true; continue }
          } catch { /* not valid JSON */ }
        }
      }

      // Fix 3: numeric-keyed object → array
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        const keys = Object.keys(value as Record<string, unknown>)
        if (keys.length > 0 && keys.every(k => /^\d+$/.test(k))) {
          result[key] = keys.sort((a, b) => +a - +b).map(k => (value as Record<string, unknown>)[k]!)
          applied = true
          continue
        }
      }

      // Fix 4: bare string → single-element array
      if (typeof value === 'string') {
        result[key] = [value]
        applied = true
      }
    }

    return { output: result, applied, fixType: applied ? 'fourHorsemen' : undefined }
  },
}

// --- Pass 4: Semantic Repair ---

const AUTO_LINK_RE = /\[([^\]]+)\]\(\s*(?:https?:\/\/)?\s*\S*?\b([^\s)]+)\s*\)/g

export function fixAutoLinks(str: string): { fixed: string; count: number } {
  let count = 0
  const fixed = str.replace(AUTO_LINK_RE, (match, linkText: string, urlPath: string) => {
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

function fixAutoLinksDeep(value: unknown): { fixed: unknown; count: number } {
  if (typeof value === 'string') return fixAutoLinks(value)
  if (Array.isArray(value)) {
    let total = 0
    const fixed = value.map(item => { const r = fixAutoLinksDeep(item); total += r.count; return r.fixed })
    return { fixed, count: total }
  }
  if (value && typeof value === 'object') {
    let total = 0
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const r = fixAutoLinksDeep(v); out[k] = r.fixed; total += r.count
    }
    return { fixed: out, count: total }
  }
  return { fixed: value, count: 0 }
}

export const semanticRepairPass: RepairPass = {
  name: 'semantic-repair',
  run(input: Record<string, unknown>, _ctx: RepairContext): RepairResult {
    const { fixed, count } = fixAutoLinksDeep(input)
    if (count > 0) {
      return { output: fixed as Record<string, unknown>, applied: true, fixType: 'autoLink' }
    }
    return { output: input, applied: false }
  },
}
```

- [x] **步骤 4：运行测试验证通过**

运行：`npx tsx --test src/agent/__tests__/repair-pipeline.test.ts`
预期：PASS

- [x] **步骤 5：Commit**

```bash
git add src/agent/repair-passes.ts src/agent/__tests__/repair-pipeline.test.ts
git commit -m "feat(agent): add fourHorsemen + semanticRepair passes"
```

---

## 任务 2b：Pass 4 — 语义修复测试 (autolink)

**文件：**
- 修改：`src/agent/__tests__/repair-pipeline.test.ts`

- [x] **步骤 1：编写测试**

追加到 `src/agent/__tests__/repair-pipeline.test.ts`:

```typescript
import { fixAutoLinks } from '../repair-passes.js'

describe('semanticRepairPass — autolink cleanup', () => {
  it('strips degraded autolinks', () => {
    const ctx: RepairContext = { toolName: 'edit_file', schema: editSchema }
    const result = semanticRepairPass.run(
      { file_path: '[notes.md](http:// notes.md)', old_string: 'x', new_string: 'y' },
      ctx,
    )
    assert.equal(result.output.file_path, 'notes.md')
    assert.equal(result.applied, true)
  })

  it('preserves real markdown links', () => {
    const ctx: RepairContext = { toolName: 'edit_file', schema: editSchema }
    const result = semanticRepairPass.run(
      { file_path: '[click](https://example.com/docs)', old_string: 'x', new_string: 'y' },
      ctx,
    )
    assert.equal(result.output.file_path, '[click](https://example.com/docs)')
    assert.equal(result.applied, false)
  })
})

describe('fixAutoLinks — unit', () => {
  it('fixes https autolink', () => {
    const r = fixAutoLinks('[src/index.ts](https://src/index.ts)')
    assert.equal(r.fixed, 'src/index.ts')
    assert.equal(r.count, 1)
  })

  it('fixes http with space autolink', () => {
    const r = fixAutoLinks('[README.md](http://README.md)')
    assert.equal(r.fixed, 'README.md')
    assert.equal(r.count, 1)
  })
})
```

- [x] **步骤 2：运行测试验证通过**

运行：`npx tsx --test src/agent/__tests__/repair-pipeline.test.ts`
预期：PASS（实现已在任务 2 完成）

- [x] **步骤 3：Commit**

```bash
git add src/agent/__tests__/repair-pipeline.test.ts
git commit -m "test(agent): add semantic repair autolink tests"
```

---

## 任务 3：Pass 2 — Schema Gate (在 client.ts 中拦截)

**文件：**
- 修改：`src/api/client.ts:320-342`
- 创建：`src/api/__tests__/schema-gate.test.ts`

- [x] **步骤 1：编写失败测试**

`src/api/__tests__/schema-gate.test.ts`:

```typescript
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { validateRequiredFields } from '../client.js'

describe('validateRequiredFields (schema gate)', () => {
  it('returns missing fields when required fields are absent', () => {
    const missing = validateRequiredFields({}, ['command'])
    assert.deepEqual(missing, ['command'])
  })

  it('returns missing fields when required fields are null', () => {
    const missing = validateRequiredFields({ command: null }, ['command'])
    assert.deepEqual(missing, ['command'])
  })

  it('returns empty array when all required fields present', () => {
    const missing = validateRequiredFields({ command: 'pwd' }, ['command'])
    assert.deepEqual(missing, [])
  })

  it('returns empty array when no required fields defined', () => {
    const missing = validateRequiredFields({ x: 1 }, [])
    assert.deepEqual(missing, [])
  })
})
```

- [x] **步骤 2：运行测试验证失败**

运行：`npx tsx --test src/api/__tests__/schema-gate.test.ts`
预期：FAIL — `validateRequiredFields` not exported from `../client.js`

- [x] **步骤 3：实现 schema gate**

在 `src/api/client.ts` 中，`recoverTruncatedJSON` 函数之后添加：

```typescript
export function validateRequiredFields(
  input: Record<string, unknown>,
  required: string[],
): string[] {
  if (required.length === 0) return []
  return required.filter(f => input[f] === undefined || input[f] === null)
}
```

在 `stream()` 方法开头（`const finalRequest` 之前）提取 tool schemas：

```typescript
    const toolSchemas = new Map<string, string[]>()
    if (request.tools) {
      for (const tool of request.tools) {
        toolSchemas.set(tool.name, tool.input_schema.required ?? [])
      }
    }
```

修改 `content_block_stop` 中 tool_use 交付（约 326-339 行），在 `callbacks.onContentBlock` 之前插入：

```typescript
                  const requiredFields = toolSchemas.get(toolUseBuffer.name)
                  if (requiredFields && requiredFields.length > 0) {
                    const missing = validateRequiredFields(input, requiredFields)
                    if (missing.length > 0) {
                      callbacks.onContentBlock({
                        type: 'text',
                        text: `[schema-gate] Suppressed ${toolUseBuffer.name}: missing required (${missing.join(', ')}). Retry with complete parameters.`,
                      })
                      toolUseBuffer = null
                      break
                    }
                  }
```

- [x] **步骤 4：运行测试验证通过**

运行：`npx tsx --test src/api/__tests__/schema-gate.test.ts`
预期：PASS

- [x] **步骤 5：Commit**

```bash
git add src/api/client.ts src/api/__tests__/schema-gate.test.ts
git commit -m "feat(api): add schema gate to suppress incomplete tool_use"
```

---

## 任务 4：Wire Pipeline into AgentLoop

**文件：**
- 修改：`src/agent/loop.ts`

- [x] **步骤 1：添加 import 和管线实例**

在 `src/agent/loop.ts` 顶部添加：

```typescript
import { RepairPipeline } from './repair-pipeline.js'
import { fourHorsemenPass, semanticRepairPass } from './repair-passes.js'
```

在 `AgentLoop` 类中（`private trajectory` 之后）添加属性：

```typescript
  private repairPipeline = new RepairPipeline([fourHorsemenPass, semanticRepairPass])
```

- [x] **步骤 2：在工具执行前调用管线**

在 `loop.ts` 工具执行循环中，`preHookResult` 处理之后（约 316 行）、`doomLevel` 检查之前，添加：

```typescript
              // Multi-pass tool input repair
              const toolDef = this.config.toolRegistry.get(tu.name)
              if (toolDef) {
                const repairResult = this.repairPipeline.run(
                  tu.input as Record<string, unknown>,
                  { toolName: tu.name, schema: toolDef.definition.input_schema },
                )
                if (repairResult.telemetry.length > 0) {
                  tu.input = repairResult.output
                  params.input = repairResult.output
                }
              }
```

- [x] **步骤 3：运行全量测试 + typecheck**

运行：`npm test && npm run typecheck`
预期：全部 PASS，无类型错误

- [x] **步骤 4：Commit**

```bash
git add src/agent/loop.ts
git commit -m "feat(agent): wire repair pipeline into AgentLoop before tool execution"
```

---

## 任务 5：Pass 5 — 自适应注入 (Adaptive Injection)

**文件：**
- 创建：`src/agent/repair-hint.ts`
- 创建：`src/agent/__tests__/repair-hint.test.ts`
- 修改：`src/prompt/engine.ts`
- 修改：`src/prompt/volatile.ts`
- 修改：`src/agent/loop.ts`

- [x] **步骤 1：编写失败测试**

`src/agent/__tests__/repair-hint.test.ts`:

```typescript
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { RepairHintTracker } from '../repair-hint.js'

describe('RepairHintTracker', () => {
  it('returns null when no consecutive failures', () => {
    const tracker = new RepairHintTracker()
    tracker.recordFailure('edit_file', 'type_error')
    assert.equal(tracker.getHint(), null)
  })

  it('returns hint after 2 consecutive same-type failures on same tool', () => {
    const tracker = new RepairHintTracker()
    tracker.recordFailure('edit_file', 'type_error')
    tracker.recordFailure('edit_file', 'type_error')
    const hint = tracker.getHint()
    assert.ok(hint)
    assert.ok(hint.includes('edit_file'))
  })

  it('resets on success', () => {
    const tracker = new RepairHintTracker()
    tracker.recordFailure('edit_file', 'type_error')
    tracker.recordSuccess('edit_file')
    tracker.recordFailure('edit_file', 'type_error')
    assert.equal(tracker.getHint(), null)
  })

  it('does not trigger for different failure types', () => {
    const tracker = new RepairHintTracker()
    tracker.recordFailure('edit_file', 'type_error')
    tracker.recordFailure('edit_file', 'assertion')
    assert.equal(tracker.getHint(), null)
  })

  it('stops hinting after 3 consecutive failures (hint exhaustion)', () => {
    const tracker = new RepairHintTracker()
    tracker.recordFailure('bash', 'timeout')
    tracker.recordFailure('bash', 'timeout')
    // hint fires
    assert.ok(tracker.getHint())
    tracker.recordFailure('bash', 'timeout')
    // 3rd failure = hint exhausted, stop hinting
    assert.equal(tracker.getHint(), null)
  })
})
```

- [x] **步骤 2：运行测试验证失败**

运行：`npx tsx --test src/agent/__tests__/repair-hint.test.ts`
预期：FAIL — `Cannot find module '../repair-hint.js'`

- [x] **步骤 3：实现 RepairHintTracker**

`src/agent/repair-hint.ts`:

```typescript
const HINT_THRESHOLD = 2
const HINT_EXHAUSTION = 3

interface FailureRecord {
  tool: string
  failureType: string
  count: number
}

const HINT_TEMPLATES: Record<string, string> = {
  type_error: 'Ensure all parameters match the expected types exactly.',
  assertion: 'The previous edit did not match. Re-read the file before editing.',
  timeout: 'The command timed out. Use a shorter operation or add a timeout parameter.',
  missing_dep: 'A dependency is missing. Install it before retrying.',
}

export class RepairHintTracker {
  private current: FailureRecord | null = null

  recordFailure(tool: string, failureType: string): void {
    if (this.current && this.current.tool === tool && this.current.failureType === failureType) {
      this.current.count++
    } else {
      this.current = { tool, failureType, count: 1 }
    }
  }

  recordSuccess(tool: string): void {
    if (this.current?.tool === tool) {
      this.current = null
    }
  }

  getHint(): string | null {
    if (!this.current) return null
    if (this.current.count < HINT_THRESHOLD) return null
    if (this.current.count >= HINT_EXHAUSTION) return null

    const template = HINT_TEMPLATES[this.current.failureType] ?? `Avoid repeating the same error with ${this.current.tool}.`
    return `<repair-hint tool="${this.current.tool}">${template}</repair-hint>`
  }
}
```

- [x] **步骤 4：运行测试验证通过**

运行：`npx tsx --test src/agent/__tests__/repair-hint.test.ts`
预期：PASS

- [x] **步骤 5：添加 setRepairHint 到 PromptEngine**

在 `src/prompt/engine.ts` 中，`setStrategyShift` 方法之后添加：

```typescript
  private repairHint?: string | null

  setRepairHint(hint: string | null): void {
    this.repairHint = hint
  }
```

在 `buildLatestTurnVolatileBlock` 调用处（约 137 行），将 `repairHint` 传入：

```typescript
          const freshBlock = buildLatestTurnVolatileBlock({ ...this.config.volatileCtx, toolHistory, taskProgress: this.taskProgress, behaviorMirror: this.behaviorMirror, strategyShift: this.strategyShift, decisions: this.decisions, repairHint: this.repairHint })
```

- [x] **步骤 6：修改 volatile.ts 接受 repairHint**

在 `src/prompt/volatile.ts` 的 `buildLatestTurnVolatileBlock` 函数参数中添加 `repairHint?: string | null`，并在输出末尾追加：

```typescript
  if (repairHint) {
    parts.push(repairHint)
  }
```

- [x] **步骤 7：在 AgentLoop 中接入 RepairHintTracker**

在 `src/agent/loop.ts` 中：

添加 import：
```typescript
import { RepairHintTracker } from './repair-hint.js'
```

添加属性：
```typescript
  private repairHintTracker = new RepairHintTracker()
```

在工具执行成功后（tool_result 不是 error 时）：
```typescript
  this.repairHintTracker.recordSuccess(tu.name)
```

在工具执行失败后（tool_result is_error 时），使用 failure-classifier 的类型：
```typescript
  this.repairHintTracker.recordFailure(tu.name, failureClass)
```

在每轮开始时注入 hint：
```typescript
  const hint = this.repairHintTracker.getHint()
  this.config.promptEngine.setRepairHint(hint)
```

- [x] **步骤 8：运行全量测试 + typecheck**

运行：`npm test && npm run typecheck`
预期：全部 PASS

- [x] **步骤 9：Commit**

```bash
git add src/agent/repair-hint.ts src/agent/__tests__/repair-hint.test.ts src/prompt/engine.ts src/prompt/volatile.ts src/agent/loop.ts
git commit -m "feat(agent): add Pass 5 adaptive injection via RepairHintTracker"
```

---

## 任务 6：端到端集成测试

**文件：**
- 创建：`src/__tests__/repair-parity.test.ts`

- [x] **步骤 1：编写集成测试**

`src/__tests__/repair-parity.test.ts`:

```typescript
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { RepairPipeline } from '../agent/repair-pipeline.js'
import { fourHorsemenPass, semanticRepairPass, fixAutoLinks } from '../agent/repair-passes.js'
import { validateRequiredFields } from '../api/client.js'

describe('CTCL parity — full pipeline', () => {
  const pipeline = new RepairPipeline([fourHorsemenPass, semanticRepairPass])
  const bashSchema = {
    type: 'object' as const,
    properties: { command: { type: 'string' }, timeout: { type: 'number' }, args: { type: 'array', items: { type: 'string' } } },
    required: ['command'],
  }

  it('null optional → omit', () => {
    const { output, telemetry } = pipeline.run({ command: 'ls', timeout: null }, { toolName: 'bash', schema: bashSchema })
    assert.equal(output.command, 'ls')
    assert.equal('timeout' in output, false)
    assert.ok(telemetry.length > 0)
  })

  it('JSON array string → array', () => {
    const { output } = pipeline.run({ command: 'ls', args: '["-la","-h"]' }, { toolName: 'bash', schema: bashSchema })
    assert.deepEqual(output.args, ['-la', '-h'])
  })

  it('bare string → array', () => {
    const { output } = pipeline.run({ command: 'ls', args: '-la' }, { toolName: 'bash', schema: bashSchema })
    assert.deepEqual(output.args, ['-la'])
  })

  it('autolink in path field gets cleaned', () => {
    const editSchema = {
      type: 'object' as const,
      properties: { file_path: { type: 'string' }, old_string: { type: 'string' }, new_string: { type: 'string' } },
      required: ['file_path', 'old_string', 'new_string'],
    }
    const { output } = pipeline.run(
      { file_path: '[notes.md](http://notes.md)', old_string: 'x', new_string: 'y' },
      { toolName: 'edit_file', schema: editSchema },
    )
    assert.equal(output.file_path, 'notes.md')
  })

  it('no fix on valid input', () => {
    const { output, telemetry } = pipeline.run({ command: 'ls', args: ['-la'] }, { toolName: 'bash', schema: bashSchema })
    assert.deepEqual(output.args, ['-la'])
    assert.equal(telemetry.length, 0)
  })

  it('schema gate catches missing required fields', () => {
    const missing = validateRequiredFields({}, ['command'])
    assert.deepEqual(missing, ['command'])
  })

  it('schema gate passes valid input', () => {
    const missing = validateRequiredFields({ command: 'pwd' }, ['command'])
    assert.deepEqual(missing, [])
  })
})
```

- [x] **步骤 2：运行测试验证通过**

运行：`npx tsx --test src/__tests__/repair-parity.test.ts`
预期：PASS

- [x] **步骤 3：运行全量测试 + typecheck**

运行：`npm test && npm run typecheck`
预期：全部 PASS

- [x] **步骤 4：Commit**

```bash
git add src/__tests__/repair-parity.test.ts
git commit -m "test: add CTCL parity integration tests for repair pipeline"
```

---

## 自检

### 1. 规格覆盖度

| 设计需求 | 对应任务 |
|---------|---------|
| RepairPipeline + RepairPass 接口 | 任务 1 |
| Pass 3: 四骑士 (null/jsonStr/objUnwrap/bareWrap) | 任务 2 |
| Pass 4: 语义修复 (autolink) | 任务 2b |
| Pass 2: Schema Gate | 任务 3 |
| Wire into AgentLoop | 任务 4 |
| Pass 5: 自适应注入 | 任务 5 |
| 修复遥测 | 任务 1 (RepairTelemetryEntry) |
| CCH strip (确认不需要) | N/A — Rivet 原生规避 |
| 端到端验证 | 任务 6 |

### 2. 占位符扫描

无 "TODO"、"待定"、"补充细节" 等占位符。

### 3. 类型一致性

- `RepairPass.run(input, ctx)` → `RepairResult { output, applied, fixType? }` — 贯穿任务 1-2-4-6
- `RepairContext { toolName, schema }` — 贯穿任务 1-2-4-6
- `RepairPipeline.run(input, ctx)` → `PipelineResult { output, telemetry }` — 贯穿任务 1-4-6
- `validateRequiredFields(input, required)` → `string[]` — 贯穿任务 3-6
- `RepairHintTracker.getHint()` → `string | null` — 贯穿任务 5
- `PromptEngine.setRepairHint(hint)` — 任务 5
