# Rivet 子代理协同 Phase 1 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 为 Rivet 增加可验收的 Phase 1 子代理协同能力：结构化 WorkOrder/WorkerResult 契约、只读 headless worker、runtime model routing、以及显式 `delegate_task` 入口。

**架构：** 本计划实现 Cache-first Bounded Coordinator 的最小闭环。Primary `AgentLoop` 通过 `delegate_task` 显式派发只读工作单，`DelegationCoordinator` 根据 `ModelCapabilityCard` 选择 worker model，`WorkerSession` 用独立 `SessionContext` 和只读 `ToolRegistry` 运行 headless `AgentLoop`，最后返回 schema-valid `WorkerResult` packet；Phase 1 不做自动任务分解、不做 cockpit worker 面板、不做写入型 worker。

**技术栈：** TypeScript 5.7、Node.js 22 `node:test`、Zod、现有 `AgentLoop` / `PromptEngine` / `ToolRegistry` / DeepSeek Anthropic-compatible SSE client。

---

## 范围边界

### 本计划内

- `WorkOrder` / `WorkerResult` zod schema 和 TypeScript 类型。
- 只读工具 allowlist：worker 只能看到 `read_file`、`glob`、`grep`、`diff`。
- Headless worker：独立 `SessionContext`，不污染 primary session。
- Worker JSON result parsing；解析失败时按 `budget.maxRetries` 触发一次 repair prompt；仍失败则返回 `blocked` result。
- `DelegationCoordinator`：budget gate、model routing、bounded parallelism、result packet aggregation。
- `delegate_task` tool：primary 可显式调用 delegation，工具本身不需要用户 approval，因为 Phase 1 只读。
- `main.tsx` runtime 接线：默认工具 registry + coordinator + delegate tool。
- 单测、typecheck、完整测试和 build 验证。

### 本计划外

- 自动 decomposer 在每个用户 turn 前主动拆任务。
- P2.3 Cockpit worker rail 和 worker 状态面板。
- 写入型 worker、worktree pool、patch apply/merge。
- async approval queue multiplexing。
- adaptive learning / worker reliability persistence。

---

## 文件结构

### 创建

- `src/agent/work-order.ts` — WorkOrder/WorkerResult schema、parser、blocked fallback、kind→CapabilityTask 映射。
- `src/agent/worker-prompts.ts` — worker task prompt、repair prompt、primary packet message 构造。
- `src/agent/worker-session.ts` — headless `AgentLoop` worker runner，独立 session 和 retry 解析闭环。
- `src/agent/coordinator.ts` — Phase 1 delegation coordinator、budget gate、model routing、bounded parallelism。
- `src/agent/__tests__/work-order.test.ts` — contract/parser tests。
- `src/agent/__tests__/worker-prompts.test.ts` — prompt/packet tests。
- `src/agent/__tests__/worker-session.test.ts` — headless worker isolation and repair tests。
- `src/agent/__tests__/coordinator.test.ts` — coordinator routing/budget/parallelism tests。
- `src/tools/default-registry.ts` — 默认工具 registry 工厂，避免 `main.tsx` 手写重复注册逻辑。
- `src/tools/delegate-task.ts` — `delegate_task` tool factory。
- `src/tools/__tests__/registry-filter.test.ts` — allowlist registry tests。
- `src/tools/__tests__/default-registry.test.ts` — default registry and extra tool registration tests。
- `src/tools/__tests__/delegate-task.test.ts` — delegate tool input validation and coordinator call tests。

### 修改

- `src/tools/registry.ts` — 增加 `has()` 与 `filterToolRegistry()`，供 worker 创建只读 registry。
- `src/main.tsx` — 使用 `createDefaultToolRegistry()`；创建 `DelegationCoordinator`；注册 `delegate_task`。
- `README.md` — 在工具列表或使用说明中增加 `delegate_task` 的 Phase 1 行为说明。

---

## 任务 1：定义 WorkOrder / WorkerResult 契约

**文件：**
- 创建：`src/agent/work-order.ts`
- 创建：`src/agent/__tests__/work-order.test.ts`

- [ ] **步骤 1：编写失败的 contract/parser 测试**

创建 `src/agent/__tests__/work-order.test.ts`：

```typescript
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildBlockedWorkerResult,
  createReadOnlyWorkOrder,
  mapWorkOrderKindToCapabilityTask,
  parseWorkerResult,
  READ_ONLY_WORKER_TOOLS,
} from '../work-order.js'

describe('work-order contract', () => {
  it('creates a read-only code_search work order with safe defaults', () => {
    const order = createReadOnlyWorkOrder({
      id: 'wo_1',
      parentTurnId: 'turn_1',
      kind: 'code_search',
      profile: 'code_scout',
      objective: 'Find where model routing is currently configured.',
      scope: { files: ['src/main.tsx'] },
    })

    assert.equal(order.id, 'wo_1')
    assert.equal(order.kind, 'code_search')
    assert.deepEqual(order.allowedTools, READ_ONLY_WORKER_TOOLS)
    assert.deepEqual(order.disallowedTools, ['bash', 'write_file', 'edit_file', 'run_tests', 'delegate_task'])
    assert.equal(order.budget.maxRetries, 1)
    assert.equal(order.aggregationPolicy, 'primary_decides')
  })

  it('parses a fenced WorkerResult JSON packet', () => {
    const result = parseWorkerResult(`Here is the packet:\n\n\`\`\`json
{
  "workOrderId": "wo_1",
  "status": "passed",
  "summary": "Model routing is only configured in main.",
  "findings": [
    {
      "claim": "main.tsx constructs the active AgentLoop.",
      "evidence": "src/main.tsx creates PromptEngine and AgentLoop inside useMemo.",
      "confidence": "high"
    }
  ],
  "artifacts": [
    {
      "kind": "note",
      "title": "Runtime seam",
      "content": "Inject coordinator next to the existing AgentLoop construction."
    }
  ],
  "changedFiles": [],
  "risks": [],
  "nextActions": ["Create a coordinator factory"]
}
\`\`\``, 'wo_1')

    assert.equal(result.status, 'passed')
    assert.equal(result.findings[0]!.confidence, 'high')
    assert.deepEqual(result.changedFiles, [])
  })

  it('rejects a packet for the wrong work order', () => {
    assert.throws(() => parseWorkerResult(JSON.stringify({
      workOrderId: 'other',
      status: 'passed',
      summary: 'wrong id',
      findings: [],
      artifacts: [],
      changedFiles: [],
      risks: [],
      nextActions: [],
    }), 'wo_1'), /does not match/)
  })

  it('builds a blocked result without leaking raw transcript content', () => {
    const order = createReadOnlyWorkOrder({
      id: 'wo_1',
      parentTurnId: 'turn_1',
      kind: 'review',
      profile: 'reviewer',
      objective: 'Review coordinator risk.',
      scope: {},
    })

    const result = buildBlockedWorkerResult(order, 'Worker result was not valid JSON')

    assert.equal(result.status, 'blocked')
    assert.equal(result.summary, 'Worker blocked: Worker result was not valid JSON')
    assert.equal(result.findings.length, 0)
    assert.ok(result.risks.includes('Worker did not return schema-valid JSON'))
  })

  it('maps work order kinds to existing capability task names', () => {
    assert.equal(mapWorkOrderKindToCapabilityTask('code_search'), 'repo_summarization')
    assert.equal(mapWorkOrderKindToCapabilityTask('review'), 'risky_refactor')
    assert.equal(mapWorkOrderKindToCapabilityTask('verify'), 'test_failure_diagnosis')
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：

```bash
npm test -- src/agent/__tests__/work-order.test.ts
```

预期：FAIL，报错包含：

```text
Cannot find module '../work-order.js'
```

- [ ] **步骤 3：编写最少实现代码**

创建 `src/agent/work-order.ts`：

```typescript
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { CapabilityTask } from '../model/capability.js'
import type { VerificationMetadata } from '../tools/types.js'

export const READ_ONLY_WORKER_TOOLS = ['read_file', 'glob', 'grep', 'diff'] as const
export const PHASE1_DISALLOWED_WORKER_TOOLS = ['bash', 'write_file', 'edit_file', 'run_tests', 'delegate_task'] as const

export const workOrderKindSchema = z.enum([
  'code_search',
  'doc_research',
  'plan',
  'review',
  'verify',
  'patch_proposal',
])

export type WorkOrderKind = z.infer<typeof workOrderKindSchema>

export const workerProfileSchema = z.enum([
  'code_scout',
  'doc_scout',
  'planner',
  'reviewer',
  'verifier',
  'patcher',
])

export type WorkerProfile = z.infer<typeof workerProfileSchema>

export const aggregationPolicySchema = z.enum([
  'all_required',
  'first_success',
  'majority',
  'primary_decides',
])

export type AggregationPolicy = z.infer<typeof aggregationPolicySchema>

const workOrderScopeSchema = z.object({
  files: z.array(z.string()).optional(),
  symbols: z.array(z.string()).optional(),
  commands: z.array(z.string()).optional(),
  externalUrls: z.array(z.string()).optional(),
})

export type WorkOrderScope = z.infer<typeof workOrderScopeSchema>

const workerBudgetSchema = z.object({
  maxTurns: z.number().int().positive(),
  maxTokens: z.number().int().positive(),
  timeoutMs: z.number().int().positive(),
  maxRetries: z.number().int().min(0),
})

export type WorkerBudget = z.infer<typeof workerBudgetSchema>

export const workOrderSchema = z.object({
  id: z.string().min(1),
  parentTurnId: z.string().min(1),
  kind: workOrderKindSchema,
  profile: workerProfileSchema,
  objective: z.string().min(1),
  scope: workOrderScopeSchema,
  constraints: z.array(z.string()),
  allowedTools: z.array(z.string()),
  disallowedTools: z.array(z.string()),
  dedupeKey: z.string().min(1),
  dependencies: z.array(z.string()),
  aggregationPolicy: aggregationPolicySchema,
  budget: workerBudgetSchema,
})

export type WorkOrder = z.infer<typeof workOrderSchema>

const verificationMetadataSchema = z.object({
  command: z.string(),
  status: z.enum(['passed', 'failed', 'blocked']),
  scope: z.enum(['full', 'targeted']),
  exitCode: z.number(),
  passed: z.number(),
  failed: z.number(),
  skipped: z.number(),
  durationMs: z.number(),
}) satisfies z.ZodType<VerificationMetadata>

export const workerResultSchema = z.object({
  workOrderId: z.string().min(1),
  status: z.enum(['passed', 'failed', 'blocked', 'escalated']),
  summary: z.string().min(1),
  findings: z.array(z.object({
    claim: z.string().min(1),
    evidence: z.string().min(1),
    confidence: z.enum(['low', 'medium', 'high']),
  })),
  artifacts: z.array(z.object({
    kind: z.enum(['note', 'patch', 'test_command', 'risk', 'question']),
    title: z.string().min(1),
    content: z.string().min(1),
  })),
  verification: verificationMetadataSchema.optional(),
  changedFiles: z.array(z.string()),
  risks: z.array(z.string()),
  nextActions: z.array(z.string()),
})

export type WorkerResult = z.infer<typeof workerResultSchema>

export interface CreateReadOnlyWorkOrderInput {
  id?: string
  parentTurnId: string
  kind: WorkOrderKind
  profile: WorkerProfile
  objective: string
  scope: WorkOrderScope
  constraints?: string[]
  dependencies?: string[]
  aggregationPolicy?: AggregationPolicy
  budget?: Partial<WorkerBudget>
}

export function createReadOnlyWorkOrder(input: CreateReadOnlyWorkOrderInput): WorkOrder {
  const id = input.id ?? `wo_${randomUUID()}`
  return workOrderSchema.parse({
    id,
    parentTurnId: input.parentTurnId,
    kind: input.kind,
    profile: input.profile,
    objective: input.objective,
    scope: input.scope,
    constraints: input.constraints ?? [
      'Return only evidence-backed claims.',
      'Do not suggest edits as completed changes.',
      'Do not request write, edit, bash, or test execution tools.',
    ],
    allowedTools: [...READ_ONLY_WORKER_TOOLS],
    disallowedTools: [...PHASE1_DISALLOWED_WORKER_TOOLS],
    dedupeKey: `${input.kind}:${input.scope.files?.join(',') || input.objective}`,
    dependencies: input.dependencies ?? [],
    aggregationPolicy: input.aggregationPolicy ?? 'primary_decides',
    budget: {
      maxTurns: input.budget?.maxTurns ?? 4,
      maxTokens: input.budget?.maxTokens ?? 4096,
      timeoutMs: input.budget?.timeoutMs ?? 120_000,
      maxRetries: input.budget?.maxRetries ?? 1,
    },
  })
}

export function mapWorkOrderKindToCapabilityTask(kind: WorkOrderKind): CapabilityTask {
  switch (kind) {
    case 'code_search':
    case 'doc_research':
    case 'plan':
      return 'repo_summarization'
    case 'verify':
      return 'test_failure_diagnosis'
    case 'review':
    case 'patch_proposal':
      return 'risky_refactor'
  }
}

function extractJsonObject(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  const source = (fenced?.[1] ?? text).trim()
  const firstBrace = source.indexOf('{')
  const lastBrace = source.lastIndexOf('}')
  if (firstBrace === -1 || lastBrace === -1 || lastBrace < firstBrace) {
    throw new Error('Worker result did not contain a JSON object')
  }
  return source.slice(firstBrace, lastBrace + 1)
}

export function parseWorkerResult(text: string, expectedWorkOrderId: string): WorkerResult {
  const parsed = JSON.parse(extractJsonObject(text)) as unknown
  const result = workerResultSchema.parse(parsed)
  if (result.workOrderId !== expectedWorkOrderId) {
    throw new Error(`WorkerResult workOrderId ${result.workOrderId} does not match ${expectedWorkOrderId}`)
  }
  return result
}

export function buildBlockedWorkerResult(order: WorkOrder, reason: string): WorkerResult {
  return {
    workOrderId: order.id,
    status: 'blocked',
    summary: `Worker blocked: ${reason}`,
    findings: [],
    artifacts: [{
      kind: 'risk',
      title: 'Worker result contract failed',
      content: reason,
    }],
    changedFiles: [],
    risks: ['Worker did not return schema-valid JSON'],
    nextActions: ['Primary should continue without trusting this worker result'],
  }
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：

```bash
npm test -- src/agent/__tests__/work-order.test.ts
```

预期：PASS，输出包含：

```text
# pass 5
# fail 0
```

- [ ] **步骤 5：Commit**

```bash
git add src/agent/work-order.ts src/agent/__tests__/work-order.test.ts
git commit -m "feat: add worker order contract"
```

---

## 任务 2：为 ToolRegistry 增加只读 allowlist 过滤

**文件：**
- 修改：`src/tools/registry.ts`
- 创建：`src/tools/__tests__/registry-filter.test.ts`

- [ ] **步骤 1：编写失败的 allowlist 测试**

创建 `src/tools/__tests__/registry-filter.test.ts`：

```typescript
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { filterToolRegistry, ToolRegistry } from '../registry.js'
import type { Tool, ToolCallParams } from '../types.js'

function fakeTool(name: string): Tool {
  return {
    definition: {
      name,
      description: `${name} test tool`,
      input_schema: { type: 'object', properties: {} },
    },
    execute: async () => ({ content: `${name} executed` }),
    requiresApproval: (_params: ToolCallParams) => false,
    isConcurrencySafe: () => true,
    isEnabled: () => true,
  }
}

describe('filterToolRegistry', () => {
  it('copies only explicitly allowed tools into a new registry', () => {
    const source = new ToolRegistry()
    source.register(fakeTool('read_file'))
    source.register(fakeTool('write_file'))
    source.register(fakeTool('grep'))

    const filtered = filterToolRegistry(source, ['read_file', 'grep'])

    assert.equal(filtered.has('read_file'), true)
    assert.equal(filtered.has('grep'), true)
    assert.equal(filtered.has('write_file'), false)
    assert.deepEqual(filtered.getDefinitions().map(t => t.name), ['grep', 'read_file'])
  })

  it('throws when an allowlisted tool is not registered', () => {
    const source = new ToolRegistry()
    source.register(fakeTool('read_file'))

    assert.throws(() => filterToolRegistry(source, ['read_file', 'grep']), /Cannot allowlist unknown tool: grep/)
  })

  it('keeps the filtered registry independent from later source registrations', () => {
    const source = new ToolRegistry()
    source.register(fakeTool('read_file'))

    const filtered = filterToolRegistry(source, ['read_file'])
    source.register(fakeTool('write_file'))

    assert.equal(source.has('write_file'), true)
    assert.equal(filtered.has('write_file'), false)
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：

```bash
npm test -- src/tools/__tests__/registry-filter.test.ts
```

预期：FAIL，报错包含：

```text
The requested module '../registry.js' does not provide an export named 'filterToolRegistry'
```

- [ ] **步骤 3：编写最少实现代码**

修改 `src/tools/registry.ts`，保留现有 imports 和 class，增加 `has()` 方法与 `filterToolRegistry()`：

```typescript
import type { Tool, ToolCallParams, ToolResult } from './types.js'
import type { ToolDefinition } from '../api/types.js'

export class ToolRegistry {
  private tools = new Map<string, Tool>()

  register(tool: Tool): void {
    this.tools.set(tool.definition.name, tool)
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name)
  }

  has(name: string): boolean {
    return this.tools.has(name)
  }

  getAll(): Tool[] {
    return Array.from(this.tools.values())
  }

  getDefinitions(): ToolDefinition[] {
    return this.getAll()
      .filter(t => t.isEnabled())
      .map(t => t.definition)
      .sort((a, b) => a.name.localeCompare(b.name))
  }

  async execute(name: string, params: ToolCallParams): Promise<ToolResult> {
    const tool = this.tools.get(name)
    if (!tool) throw new Error(`Unknown tool: ${name}`)
    if (!tool.isEnabled()) throw new Error(`Tool ${name} is disabled`)
    return tool.execute(params)
  }

  needsApproval(name: string, params: ToolCallParams): boolean {
    const tool = this.tools.get(name)
    if (!tool) return false
    return tool.requiresApproval(params)
  }
}

export function filterToolRegistry(source: ToolRegistry, allowedNames: readonly string[]): ToolRegistry {
  const filtered = new ToolRegistry()
  for (const name of allowedNames) {
    const tool = source.get(name)
    if (!tool) throw new Error(`Cannot allowlist unknown tool: ${name}`)
    filtered.register(tool)
  }
  return filtered
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：

```bash
npm test -- src/tools/__tests__/registry-filter.test.ts
```

预期：PASS，输出包含：

```text
# pass 3
# fail 0
```

- [ ] **步骤 5：Commit**

```bash
git add src/tools/registry.ts src/tools/__tests__/registry-filter.test.ts
git commit -m "feat: add worker tool allowlist registry"
```

---

## 任务 3：构造 worker prompt 与 primary packet message

**文件：**
- 创建：`src/agent/worker-prompts.ts`
- 创建：`src/agent/__tests__/worker-prompts.test.ts`

- [ ] **步骤 1：编写失败的 prompt/packet 测试**

创建 `src/agent/__tests__/worker-prompts.test.ts`：

```typescript
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createReadOnlyWorkOrder } from '../work-order.js'
import {
  buildPrimaryWorkerPacket,
  buildWorkerPrompt,
  buildWorkerRepairPrompt,
} from '../worker-prompts.js'

describe('worker prompts', () => {
  it('builds a worker prompt that requires WorkerResult JSON', () => {
    const order = createReadOnlyWorkOrder({
      id: 'wo_1',
      parentTurnId: 'turn_1',
      kind: 'code_search',
      profile: 'code_scout',
      objective: 'Find routing seams.',
      scope: { files: ['src/main.tsx'] },
    })

    const prompt = buildWorkerPrompt(order)

    assert.ok(prompt.includes('WorkOrder ID: wo_1'))
    assert.ok(prompt.includes('Allowed tools: read_file, glob, grep, diff'))
    assert.ok(prompt.includes('Return exactly one JSON object'))
    assert.ok(prompt.includes('"workOrderId"'))
    assert.ok(prompt.includes('Do not call disallowed tools'))
  })

  it('builds a repair prompt with the parse error but not a new objective', () => {
    const order = createReadOnlyWorkOrder({
      id: 'wo_1',
      parentTurnId: 'turn_1',
      kind: 'review',
      profile: 'reviewer',
      objective: 'Review risk.',
      scope: {},
    })

    const prompt = buildWorkerRepairPrompt(order, 'not json', 'Unexpected token')

    assert.ok(prompt.includes('Repair the previous answer'))
    assert.ok(prompt.includes('Unexpected token'))
    assert.ok(prompt.includes('workOrderId'))
    assert.ok(prompt.includes('wo_1'))
  })

  it('builds a compact primary packet from worker results', () => {
    const packet = buildPrimaryWorkerPacket([
      {
        workOrderId: 'wo_1',
        status: 'passed',
        summary: 'Found the seam.',
        findings: [{ claim: 'main constructs AgentLoop', evidence: 'src/main.tsx', confidence: 'high' }],
        artifacts: [],
        changedFiles: [],
        risks: [],
        nextActions: ['Wire coordinator near main'],
      },
    ])

    assert.ok(packet.includes('<worker_results>'))
    assert.ok(packet.includes('Found the seam.'))
    assert.ok(packet.includes('main constructs AgentLoop'))
    assert.ok(packet.includes('</worker_results>'))
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：

```bash
npm test -- src/agent/__tests__/worker-prompts.test.ts
```

预期：FAIL，报错包含：

```text
Cannot find module '../worker-prompts.js'
```

- [ ] **步骤 3：编写最少实现代码**

创建 `src/agent/worker-prompts.ts`：

```typescript
import type { WorkOrder, WorkerResult } from './work-order.js'

const RESULT_SHAPE = `{
  "workOrderId": "<copy WorkOrder ID>",
  "status": "passed | failed | blocked | escalated",
  "summary": "one sentence summary",
  "findings": [
    { "claim": "evidence-backed claim", "evidence": "file path, command, or observed fact", "confidence": "low | medium | high" }
  ],
  "artifacts": [
    { "kind": "note | patch | test_command | risk | question", "title": "short title", "content": "artifact content" }
  ],
  "changedFiles": [],
  "risks": [],
  "nextActions": []
}`

export function buildWorkerPrompt(order: WorkOrder): string {
  return [
    'You are a headless read-only Rivet worker.',
    `WorkOrder ID: ${order.id}`,
    `Kind: ${order.kind}`,
    `Profile: ${order.profile}`,
    `Objective: ${order.objective}`,
    `Scope: ${JSON.stringify(order.scope)}`,
    `Constraints: ${order.constraints.join(' | ')}`,
    `Allowed tools: ${order.allowedTools.join(', ')}`,
    `Disallowed tools: ${order.disallowedTools.join(', ')}`,
    'Do not call disallowed tools. Do not claim that files were changed.',
    'Return exactly one JSON object and no prose outside the object.',
    'The JSON object must match this shape:',
    RESULT_SHAPE,
  ].join('\n')
}

export function buildWorkerRepairPrompt(order: WorkOrder, previousText: string, parseError: string): string {
  return [
    'Repair the previous answer so it is exactly one valid WorkerResult JSON object.',
    `WorkOrder ID that must be used: ${order.id}`,
    `Parse error: ${parseError}`,
    'Do not add markdown fences or explanation.',
    'Use this shape:',
    RESULT_SHAPE,
    'Previous answer:',
    previousText.slice(0, 4000),
  ].join('\n')
}

export function buildPrimaryWorkerPacket(results: WorkerResult[]): string {
  const compact = results.map(result => ({
    workOrderId: result.workOrderId,
    status: result.status,
    summary: result.summary,
    findings: result.findings,
    artifacts: result.artifacts,
    verification: result.verification,
    changedFiles: result.changedFiles,
    risks: result.risks,
    nextActions: result.nextActions,
  }))

  return [
    '<worker_results>',
    JSON.stringify(compact, null, 2),
    '</worker_results>',
  ].join('\n')
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：

```bash
npm test -- src/agent/__tests__/worker-prompts.test.ts
```

预期：PASS，输出包含：

```text
# pass 3
# fail 0
```

- [ ] **步骤 5：Commit**

```bash
git add src/agent/worker-prompts.ts src/agent/__tests__/worker-prompts.test.ts
git commit -m "feat: add worker result prompts"
```

---

## 任务 4：实现独立 headless WorkerSession

**文件：**
- 创建：`src/agent/worker-session.ts`
- 创建：`src/agent/__tests__/worker-session.test.ts`

- [ ] **步骤 1：编写失败的 worker session 测试**

创建 `src/agent/__tests__/worker-session.test.ts`：

```typescript
import { describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'
import type { ApiClient, StreamCallbacks } from '../../api/client.js'
import type { ContentBlock } from '../../api/types.js'
import { PromptEngine } from '../../prompt/engine.js'
import { ToolRegistry } from '../../tools/registry.js'
import { SessionContext } from '../context.js'
import { createReadOnlyWorkOrder } from '../work-order.js'
import { runWorkerSession } from '../worker-session.js'

function textBlock(text: string): ContentBlock {
  return { type: 'text', text }
}

function clientFromTexts(texts: string[]): ApiClient {
  let index = 0
  return {
    stream: mock.fn(async (_req: unknown, cb: StreamCallbacks) => {
      const text = texts[Math.min(index, texts.length - 1)]!
      index++
      cb.onTextDelta(text)
      cb.onContentBlock(textBlock(text))
      cb.onStopReason('end_turn', { input_tokens: 10, output_tokens: 5 })
    }),
  } as unknown as ApiClient
}

function makePromptEngine() {
  return new PromptEngine({
    model: 'deepseek-v4-pro',
    maxTokens: 1024,
    staticCtx: { tools: [] },
    volatileCtx: { cwd: '/repo' },
  })
}

function validPacket(workOrderId: string) {
  return JSON.stringify({
    workOrderId,
    status: 'passed',
    summary: 'Worker found one seam.',
    findings: [{ claim: 'AgentLoop is injectable', evidence: 'src/agent/loop.ts constructor', confidence: 'high' }],
    artifacts: [],
    changedFiles: [],
    risks: [],
    nextActions: ['Use an independent SessionContext'],
  })
}

describe('runWorkerSession', () => {
  it('runs a headless worker and returns a schema-valid result', async () => {
    const order = createReadOnlyWorkOrder({
      id: 'wo_1',
      parentTurnId: 'turn_1',
      kind: 'code_search',
      profile: 'code_scout',
      objective: 'Find AgentLoop constructor seams.',
      scope: { files: ['src/agent/loop.ts'] },
    })

    const run = await runWorkerSession({
      order,
      client: clientFromTexts([validPacket('wo_1')]),
      promptEngine: makePromptEngine(),
      toolRegistry: new ToolRegistry(),
      cwd: '/repo',
      maxTurns: 2,
      contextWindow: 1_000_000,
      compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' },
    })

    assert.equal(run.result.status, 'passed')
    assert.equal(run.session.getTurnCount(), 1)
    assert.deepEqual(run.transcript.toolUses, [])
  })

  it('uses an independent SessionContext instead of mutating the primary session', async () => {
    const primary = new SessionContext()
    primary.addUserMessage('primary user message')
    const before = primary.getMessages().length

    const order = createReadOnlyWorkOrder({
      id: 'wo_2',
      parentTurnId: 'turn_1',
      kind: 'review',
      profile: 'reviewer',
      objective: 'Review isolation.',
      scope: {},
    })

    const run = await runWorkerSession({
      order,
      client: clientFromTexts([validPacket('wo_2')]),
      promptEngine: makePromptEngine(),
      toolRegistry: new ToolRegistry(),
      cwd: '/repo',
      maxTurns: 2,
      contextWindow: 1_000_000,
      compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' },
    })

    assert.equal(primary.getMessages().length, before)
    assert.ok(run.session.getMessages().length > 0)
  })

  it('runs one repair prompt after invalid worker JSON', async () => {
    const order = createReadOnlyWorkOrder({
      id: 'wo_3',
      parentTurnId: 'turn_1',
      kind: 'plan',
      profile: 'planner',
      objective: 'Plan coordinator tests.',
      scope: {},
      budget: { maxRetries: 1 },
    })

    const client = clientFromTexts(['not valid json', validPacket('wo_3')])
    const run = await runWorkerSession({
      order,
      client,
      promptEngine: makePromptEngine(),
      toolRegistry: new ToolRegistry(),
      cwd: '/repo',
      maxTurns: 2,
      contextWindow: 1_000_000,
      compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' },
    })

    assert.equal(run.result.status, 'passed')
    assert.equal(run.transcript.repairAttempts, 1)
  })

  it('returns blocked after retry budget is exhausted', async () => {
    const order = createReadOnlyWorkOrder({
      id: 'wo_4',
      parentTurnId: 'turn_1',
      kind: 'review',
      profile: 'reviewer',
      objective: 'Review invalid result handling.',
      scope: {},
      budget: { maxRetries: 0 },
    })

    const run = await runWorkerSession({
      order,
      client: clientFromTexts(['not valid json']),
      promptEngine: makePromptEngine(),
      toolRegistry: new ToolRegistry(),
      cwd: '/repo',
      maxTurns: 2,
      contextWindow: 1_000_000,
      compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' },
    })

    assert.equal(run.result.status, 'blocked')
    assert.ok(run.result.risks.includes('Worker did not return schema-valid JSON'))
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：

```bash
npm test -- src/agent/__tests__/worker-session.test.ts
```

预期：FAIL，报错包含：

```text
Cannot find module '../worker-session.js'
```

- [ ] **步骤 3：编写最少实现代码**

创建 `src/agent/worker-session.ts`：

```typescript
import type { ApiClient } from '../api/client.js'
import type { Usage } from '../api/types.js'
import type { CompactionConfig } from '../compact/constants.js'
import { PromptEngine } from '../prompt/engine.js'
import { ToolRegistry } from '../tools/registry.js'
import { AgentLoop } from './loop.js'
import { SessionContext } from './context.js'
import {
  buildBlockedWorkerResult,
  parseWorkerResult,
  type WorkOrder,
  type WorkerResult,
} from './work-order.js'
import { buildWorkerPrompt, buildWorkerRepairPrompt } from './worker-prompts.js'

export interface WorkerSessionConfig {
  order: WorkOrder
  client: ApiClient
  promptEngine: PromptEngine
  toolRegistry: ToolRegistry
  cwd: string
  maxTurns: number
  contextWindow: number
  compact: CompactionConfig
}

export interface WorkerTranscript {
  text: string
  thinking: string
  toolUses: string[]
  toolResults: string[]
  errors: string[]
  repairAttempts: number
}

export interface WorkerSessionRun {
  result: WorkerResult
  transcript: WorkerTranscript
  session: SessionContext
  usage: Usage
}

function emptyTranscript(): WorkerTranscript {
  return {
    text: '',
    thinking: '',
    toolUses: [],
    toolResults: [],
    errors: [],
    repairAttempts: 0,
  }
}

async function runOnce(agent: AgentLoop, prompt: string, transcript: WorkerTranscript): Promise<string> {
  let text = ''
  await agent.run(prompt, {
    onTextDelta: (delta) => {
      text += delta
      transcript.text += delta
    },
    onThinkingDelta: (delta) => {
      transcript.thinking += delta
    },
    onToolUse: (_id, name) => {
      transcript.toolUses.push(name)
    },
    onToolResult: (_id, name, result, isError) => {
      transcript.toolResults.push(name)
      if (isError) transcript.errors.push(result)
    },
    onTurnComplete: () => {},
    onError: (error) => {
      transcript.errors.push(error.message)
    },
    onAbort: () => {
      transcript.errors.push('Worker aborted')
    },
    onApprovalRequired: async () => false,
  })
  return text
}

export async function runWorkerSession(config: WorkerSessionConfig): Promise<WorkerSessionRun> {
  const session = new SessionContext()
  const agent = new AgentLoop({
    client: config.client,
    promptEngine: config.promptEngine,
    toolRegistry: config.toolRegistry,
    maxTurns: config.maxTurns,
    contextWindow: config.contextWindow,
    compact: config.compact,
  }, session, config.cwd)

  const transcript = emptyTranscript()
  let latestText = await runOnce(agent, buildWorkerPrompt(config.order), transcript)

  for (let attempt = 0; attempt <= config.order.budget.maxRetries; attempt++) {
    try {
      const result = parseWorkerResult(latestText, config.order.id)
      return {
        result,
        transcript,
        session,
        usage: session.getTotalUsage(),
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      transcript.errors.push(message)
      if (attempt === config.order.budget.maxRetries) {
        return {
          result: buildBlockedWorkerResult(config.order, message),
          transcript,
          session,
          usage: session.getTotalUsage(),
        }
      }
      transcript.repairAttempts++
      latestText = await runOnce(agent, buildWorkerRepairPrompt(config.order, latestText, message), transcript)
    }
  }

  return {
    result: buildBlockedWorkerResult(config.order, 'Worker result parser exited unexpectedly'),
    transcript,
    session,
    usage: session.getTotalUsage(),
  }
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：

```bash
npm test -- src/agent/__tests__/worker-session.test.ts
```

预期：PASS，输出包含：

```text
# pass 4
# fail 0
```

- [ ] **步骤 5：Commit**

```bash
git add src/agent/worker-session.ts src/agent/__tests__/worker-session.test.ts
git commit -m "feat: add headless worker sessions"
```

---

## 任务 5：实现 DelegationCoordinator 与 model routing

**文件：**
- 创建：`src/agent/coordinator.ts`
- 创建：`src/agent/__tests__/coordinator.test.ts`

- [ ] **步骤 1：编写失败的 coordinator 测试**

创建 `src/agent/__tests__/coordinator.test.ts`：

```typescript
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { ApiClient } from '../../api/client.js'
import { PromptEngine } from '../../prompt/engine.js'
import { filterToolRegistry, ToolRegistry } from '../../tools/registry.js'
import type { Tool, ToolCallParams } from '../../tools/types.js'
import type { ModelCapabilityCard } from '../../model/capability.js'
import {
  DelegationCoordinator,
  shouldDelegateObjective,
  type WorkerRuntimeFactory,
} from '../coordinator.js'
import { READ_ONLY_WORKER_TOOLS, type WorkerResult } from '../work-order.js'

function fakeTool(name: string): Tool {
  return {
    definition: {
      name,
      description: `${name} test tool`,
      input_schema: { type: 'object', properties: {} },
    },
    execute: async () => ({ content: `${name} executed` }),
    requiresApproval: (_params: ToolCallParams) => false,
    isConcurrencySafe: () => true,
    isEnabled: () => true,
  }
}

function makeRegistry() {
  const registry = new ToolRegistry()
  for (const name of READ_ONLY_WORKER_TOOLS) registry.register(fakeTool(name))
  registry.register(fakeTool('write_file'))
  return registry
}

const cards: ModelCapabilityCard[] = [
  {
    model: 'fast-json',
    toolUseReliability: 0.6,
    jsonStability: 0.95,
    editSuccessRate: 0.4,
    testRepairRate: 0.5,
    contextWindow: 128_000,
    cacheEconomics: 'medium',
    recommendedTasks: ['plan'],
  },
  {
    model: 'large-cache',
    toolUseReliability: 0.8,
    jsonStability: 0.8,
    editSuccessRate: 0.7,
    testRepairRate: 0.6,
    contextWindow: 1_000_000,
    cacheEconomics: 'strong',
    recommendedTasks: ['code_search'],
  },
]

function resultFor(id: string): WorkerResult {
  return {
    workOrderId: id,
    status: 'passed',
    summary: `completed ${id}`,
    findings: [],
    artifacts: [],
    changedFiles: [],
    risks: [],
    nextActions: [],
  }
}

describe('DelegationCoordinator', () => {
  it('uses a budget gate for trivial objectives', () => {
    assert.equal(shouldDelegateObjective('tiny', {}), false)
    assert.equal(shouldDelegateObjective('compare routing seams across worker session and coordinator modules', {}), true)
    assert.equal(shouldDelegateObjective('inspect files', { files: ['a.ts', 'b.ts'] }), true)
  })

  it('selects a model through recommendModelForTask and uses a read-only registry', async () => {
    const selectedModels: string[] = []
    const seenToolNames: string[][] = []
    const runtimeFactory: WorkerRuntimeFactory = (order, card, workerRegistry) => {
      selectedModels.push(card.model)
      seenToolNames.push(workerRegistry.getDefinitions().map(t => t.name))
      return {
        order,
        client: {} as ApiClient,
        promptEngine: new PromptEngine({
          model: card.model,
          maxTokens: 1024,
          staticCtx: { tools: workerRegistry.getDefinitions() },
          volatileCtx: { cwd: '/repo' },
        }),
        toolRegistry: workerRegistry,
        cwd: '/repo',
        maxTurns: 2,
        contextWindow: card.contextWindow,
        compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' },
      }
    }

    const coordinator = new DelegationCoordinator({
      baseToolRegistry: makeRegistry(),
      modelCards: cards,
      maxWorkers: 2,
      runtimeFactory,
      runWorker: async config => ({
        result: resultFor(config.order.id),
        transcript: { text: '', thinking: '', toolUses: [], toolResults: [], errors: [], repairAttempts: 0 },
        session: { getTurnCount: () => 1 } as never,
        usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      }),
    })

    const run = await coordinator.delegate({
      parentTurnId: 'turn_1',
      objective: 'Find model routing and tool registry seams across the current runtime.',
      kind: 'code_search',
      profile: 'code_scout',
      scope: { files: ['src/main.tsx', 'src/tools/registry.ts'] },
    })

    assert.equal(run.status, 'completed')
    assert.equal(run.results.length, 1)
    assert.deepEqual(selectedModels, ['large-cache'])
    assert.deepEqual(seenToolNames[0], ['diff', 'glob', 'grep', 'read_file'])
  })

  it('returns skipped when the objective does not pass the budget gate', async () => {
    const coordinator = new DelegationCoordinator({
      baseToolRegistry: filterToolRegistry(makeRegistry(), READ_ONLY_WORKER_TOOLS),
      modelCards: cards,
      maxWorkers: 2,
      runtimeFactory: (order, card, workerRegistry) => ({
        order,
        client: {} as ApiClient,
        promptEngine: new PromptEngine({ model: card.model, maxTokens: 1024, staticCtx: { tools: workerRegistry.getDefinitions() }, volatileCtx: { cwd: '/repo' } }),
        toolRegistry: workerRegistry,
        cwd: '/repo',
        maxTurns: 2,
        contextWindow: card.contextWindow,
        compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' },
      }),
      runWorker: async config => ({
        result: resultFor(config.order.id),
        transcript: { text: '', thinking: '', toolUses: [], toolResults: [], errors: [], repairAttempts: 0 },
        session: { getTurnCount: () => 1 } as never,
        usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      }),
    })

    const run = await coordinator.delegate({
      parentTurnId: 'turn_1',
      objective: 'tiny',
      kind: 'code_search',
      profile: 'code_scout',
      scope: {},
    })

    assert.equal(run.status, 'skipped')
    assert.equal(run.results.length, 0)
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：

```bash
npm test -- src/agent/__tests__/coordinator.test.ts
```

预期：FAIL，报错包含：

```text
Cannot find module '../coordinator.js'
```

- [ ] **步骤 3：编写最少实现代码**

创建 `src/agent/coordinator.ts`：

```typescript
import type { ModelCapabilityCard } from '../model/capability.js'
import { recommendModelForTask } from '../model/capability.js'
import { filterToolRegistry, ToolRegistry } from '../tools/registry.js'
import {
  createReadOnlyWorkOrder,
  mapWorkOrderKindToCapabilityTask,
  READ_ONLY_WORKER_TOOLS,
  type WorkOrder,
  type WorkOrderKind,
  type WorkerProfile,
  type WorkerResult,
  type WorkOrderScope,
} from './work-order.js'
import { buildPrimaryWorkerPacket } from './worker-prompts.js'
import { runWorkerSession, type WorkerSessionConfig, type WorkerSessionRun } from './worker-session.js'

export interface DelegationRequest {
  parentTurnId: string
  objective: string
  kind: WorkOrderKind
  profile: WorkerProfile
  scope: WorkOrderScope
}

export interface CoordinatorRun {
  status: 'completed' | 'skipped'
  order?: WorkOrder
  selectedModel?: string
  results: WorkerResult[]
  packet: string
}

export type WorkerRuntimeFactory = (
  order: WorkOrder,
  card: ModelCapabilityCard,
  workerRegistry: ToolRegistry,
) => WorkerSessionConfig

export interface DelegationCoordinatorConfig {
  baseToolRegistry: ToolRegistry
  modelCards: ModelCapabilityCard[]
  maxWorkers: number
  runtimeFactory: WorkerRuntimeFactory
  runWorker?: (config: WorkerSessionConfig) => Promise<WorkerSessionRun>
}

export function shouldDelegateObjective(objective: string, scope: WorkOrderScope): boolean {
  const words = objective.trim().split(/\s+/).filter(Boolean).length
  return words >= 6 || (scope.files?.length ?? 0) >= 2 || (scope.symbols?.length ?? 0) >= 2
}

export class DelegationCoordinator {
  private runWorker: (config: WorkerSessionConfig) => Promise<WorkerSessionRun>

  constructor(private config: DelegationCoordinatorConfig) {
    this.runWorker = config.runWorker ?? runWorkerSession
  }

  async delegate(request: DelegationRequest): Promise<CoordinatorRun> {
    if (!shouldDelegateObjective(request.objective, request.scope)) {
      return {
        status: 'skipped',
        results: [],
        packet: buildPrimaryWorkerPacket([]),
      }
    }

    const order = createReadOnlyWorkOrder({
      parentTurnId: request.parentTurnId,
      kind: request.kind,
      profile: request.profile,
      objective: request.objective,
      scope: request.scope,
    })
    const task = mapWorkOrderKindToCapabilityTask(order.kind)
    const selected = recommendModelForTask(task, this.config.modelCards)
    const workerRegistry = filterToolRegistry(this.config.baseToolRegistry, READ_ONLY_WORKER_TOOLS)
    const workerConfig = this.config.runtimeFactory(order, selected, workerRegistry)
    const run = await this.runWorker(workerConfig)
    const results = [run.result]

    return {
      status: 'completed',
      order,
      selectedModel: selected.model,
      results,
      packet: buildPrimaryWorkerPacket(results),
    }
  }
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：

```bash
npm test -- src/agent/__tests__/coordinator.test.ts
```

预期：PASS，输出包含：

```text
# pass 3
# fail 0
```

- [ ] **步骤 5：Commit**

```bash
git add src/agent/coordinator.ts src/agent/__tests__/coordinator.test.ts
git commit -m "feat: add read-only delegation coordinator"
```

---

## 任务 6：增加 delegate_task tool 和默认 registry 工厂

**文件：**
- 创建：`src/tools/default-registry.ts`
- 创建：`src/tools/delegate-task.ts`
- 创建：`src/tools/__tests__/default-registry.test.ts`
- 创建：`src/tools/__tests__/delegate-task.test.ts`

- [ ] **步骤 1：编写失败的 tool/registry 测试**

创建 `src/tools/__tests__/default-registry.test.ts`：

```typescript
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createDefaultToolRegistry } from '../default-registry.js'
import type { Tool, ToolCallParams } from '../types.js'

function extraTool(): Tool {
  return {
    definition: {
      name: 'delegate_task',
      description: 'Delegate a task',
      input_schema: { type: 'object', properties: {} },
    },
    execute: async () => ({ content: 'delegated' }),
    requiresApproval: (_params: ToolCallParams) => false,
    isConcurrencySafe: () => false,
    isEnabled: () => true,
  }
}

describe('createDefaultToolRegistry', () => {
  it('registers the existing core tools', () => {
    const registry = createDefaultToolRegistry()
    const names = registry.getDefinitions().map(t => t.name)

    assert.ok(names.includes('read_file'))
    assert.ok(names.includes('write_file'))
    assert.ok(names.includes('bash'))
    assert.ok(names.includes('edit_file'))
    assert.ok(names.includes('grep'))
    assert.ok(names.includes('glob'))
    assert.ok(names.includes('diff'))
    assert.ok(names.includes('run_tests'))
  })

  it('registers extra tools after core tools', () => {
    const registry = createDefaultToolRegistry([extraTool()])

    assert.equal(registry.has('delegate_task'), true)
  })
})
```

创建 `src/tools/__tests__/delegate-task.test.ts`：

```typescript
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createDelegateTaskTool, type DelegateTaskCoordinator } from '../delegate-task.js'
import type { CoordinatorRun, DelegationRequest } from '../../agent/coordinator.js'

function makeRun(): CoordinatorRun {
  return {
    status: 'completed',
    selectedModel: 'deepseek-v4-pro',
    results: [{
      workOrderId: 'wo_1',
      status: 'passed',
      summary: 'Worker found the seam.',
      findings: [],
      artifacts: [],
      changedFiles: [],
      risks: [],
      nextActions: [],
    }],
    packet: '<worker_results>packet</worker_results>',
  }
}

describe('DELEGATE_TASK_TOOL', () => {
  it('validates input and calls the coordinator', async () => {
    const calls: DelegationRequest[] = []
    const coordinator: DelegateTaskCoordinator = {
      delegate: async request => {
        calls.push(request)
        return makeRun()
      },
    }
    const tool = createDelegateTaskTool(coordinator)

    const result = await tool.execute({
      toolUseId: 'tu_delegate',
      cwd: '/repo',
      input: {
        objective: 'Find routing seams across the runtime modules.',
        files: ['src/main.tsx', 'src/agent/loop.ts'],
      },
    })

    assert.equal(calls.length, 1)
    assert.equal(calls[0]!.parentTurnId, 'tu_delegate')
    assert.equal(calls[0]!.kind, 'code_search')
    assert.equal(calls[0]!.profile, 'code_scout')
    assert.deepEqual(calls[0]!.scope.files, ['src/main.tsx', 'src/agent/loop.ts'])
    assert.equal(result.isError, false)
    assert.ok(result.content.includes('<worker_results>'))
    assert.ok(result.uiContent!.includes('delegate_task completed'))
  })

  it('reports invalid input as a tool error', async () => {
    const coordinator: DelegateTaskCoordinator = {
      delegate: async () => makeRun(),
    }
    const tool = createDelegateTaskTool(coordinator)

    const result = await tool.execute({
      toolUseId: 'tu_delegate',
      cwd: '/repo',
      input: { objective: '' },
    })

    assert.equal(result.isError, true)
    assert.ok(result.content.includes('Invalid delegate_task input'))
  })

  it('does not require approval and is not concurrency safe', () => {
    const tool = createDelegateTaskTool({ delegate: async () => makeRun() })

    assert.equal(tool.requiresApproval({ toolUseId: 'x', cwd: '/repo', input: {} }), false)
    assert.equal(tool.isConcurrencySafe(), false)
    assert.equal(tool.isEnabled(), true)
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：

```bash
npm test -- src/tools/__tests__/default-registry.test.ts src/tools/__tests__/delegate-task.test.ts
```

预期：FAIL，报错包含：

```text
Cannot find module '../default-registry.js'
```

- [ ] **步骤 3：编写最少实现代码**

创建 `src/tools/default-registry.ts`：

```typescript
import { BASH_TOOL } from './bash.js'
import { DIFF_TOOL } from './diff.js'
import { EDIT_FILE_TOOL } from './edit.js'
import { GLOB_TOOL } from './glob.js'
import { GREP_TOOL } from './grep.js'
import { READ_FILE_TOOL } from './read-file.js'
import { RUN_TESTS_TOOL } from './run-tests.js'
import { ToolRegistry } from './registry.js'
import type { Tool } from './types.js'
import { WRITE_FILE_TOOL } from './write-file.js'

export function createDefaultToolRegistry(extraTools: Tool[] = []): ToolRegistry {
  const registry = new ToolRegistry()
  registry.register(READ_FILE_TOOL)
  registry.register(WRITE_FILE_TOOL)
  registry.register(BASH_TOOL)
  registry.register(EDIT_FILE_TOOL)
  registry.register(GREP_TOOL)
  registry.register(GLOB_TOOL)
  registry.register(DIFF_TOOL)
  registry.register(RUN_TESTS_TOOL)
  for (const tool of extraTools) registry.register(tool)
  return registry
}
```

创建 `src/tools/delegate-task.ts`：

```typescript
import { z } from 'zod'
import type { CoordinatorRun, DelegationRequest } from '../agent/coordinator.js'
import type { Tool, ToolCallParams, ToolResult } from './types.js'

export interface DelegateTaskCoordinator {
  delegate(request: DelegationRequest): Promise<CoordinatorRun>
}

const delegateTaskInputSchema = z.object({
  objective: z.string().min(1),
  files: z.array(z.string()).optional(),
  symbols: z.array(z.string()).optional(),
})

function formatUiContent(run: CoordinatorRun): string {
  if (run.status === 'skipped') return 'delegate_task skipped: objective did not pass budget gate'
  const passed = run.results.filter(r => r.status === 'passed').length
  const blocked = run.results.filter(r => r.status === 'blocked').length
  return `delegate_task completed: ${passed} passed, ${blocked} blocked, model=${run.selectedModel ?? 'unknown'}`
}

export function createDelegateTaskTool(coordinator: DelegateTaskCoordinator): Tool {
  return {
    definition: {
      name: 'delegate_task',
      description: 'Run a bounded read-only worker for code search, planning, or review and return structured worker results.',
      input_schema: {
        type: 'object',
        properties: {
          objective: { type: 'string', description: 'Specific read-only objective for the worker.' },
          files: { type: 'array', items: { type: 'string' }, description: 'Optional file paths to focus on.' },
          symbols: { type: 'array', items: { type: 'string' }, description: 'Optional symbols to focus on.' },
        },
        required: ['objective'],
      },
    },
    async execute(params: ToolCallParams): Promise<ToolResult> {
      const parsed = delegateTaskInputSchema.safeParse(params.input)
      if (!parsed.success) {
        return {
          content: `Invalid delegate_task input: ${parsed.error.message}`,
          isError: true,
        }
      }

      const run = await coordinator.delegate({
        parentTurnId: params.toolUseId,
        objective: parsed.data.objective,
        kind: 'code_search',
        profile: 'code_scout',
        scope: {
          files: parsed.data.files,
          symbols: parsed.data.symbols,
        },
      })

      return {
        content: run.packet,
        uiContent: formatUiContent(run),
        isError: false,
      }
    },
    requiresApproval: () => false,
    isConcurrencySafe: () => false,
    isEnabled: () => true,
  }
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：

```bash
npm test -- src/tools/__tests__/default-registry.test.ts src/tools/__tests__/delegate-task.test.ts
```

预期：PASS，输出包含：

```text
# fail 0
```

- [ ] **步骤 5：Commit**

```bash
git add src/tools/default-registry.ts src/tools/delegate-task.ts src/tools/__tests__/default-registry.test.ts src/tools/__tests__/delegate-task.test.ts
git commit -m "feat: add delegate task tool"
```

---

## 任务 7：把 delegate_task 接入 main runtime

**文件：**
- 修改：`src/main.tsx`
- 修改：`README.md`

- [ ] **步骤 1：编写失败的 runtime wiring 保护测试**

先扩展 `src/tools/__tests__/default-registry.test.ts`，证明默认 registry 可以用于 worker base registry，同时 primary registry 可以添加 `delegate_task`：

```typescript
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createDefaultToolRegistry } from '../default-registry.js'
import type { Tool, ToolCallParams } from '../types.js'

function extraTool(): Tool {
  return {
    definition: {
      name: 'delegate_task',
      description: 'Delegate a task',
      input_schema: { type: 'object', properties: {} },
    },
    execute: async () => ({ content: 'delegated' }),
    requiresApproval: (_params: ToolCallParams) => false,
    isConcurrencySafe: () => false,
    isEnabled: () => true,
  }
}

describe('createDefaultToolRegistry', () => {
  it('registers the existing core tools', () => {
    const registry = createDefaultToolRegistry()
    const names = registry.getDefinitions().map(t => t.name)

    assert.ok(names.includes('read_file'))
    assert.ok(names.includes('write_file'))
    assert.ok(names.includes('bash'))
    assert.ok(names.includes('edit_file'))
    assert.ok(names.includes('grep'))
    assert.ok(names.includes('glob'))
    assert.ok(names.includes('diff'))
    assert.ok(names.includes('run_tests'))
  })

  it('keeps delegate_task out of the base worker registry', () => {
    const base = createDefaultToolRegistry()

    assert.equal(base.has('delegate_task'), false)
  })

  it('allows the primary registry to include delegate_task explicitly', () => {
    const primary = createDefaultToolRegistry([extraTool()])

    assert.equal(primary.has('delegate_task'), true)
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：

```bash
npm test -- src/tools/__tests__/default-registry.test.ts
```

预期：当前可能 PASS，因为 Task 6 已满足这组断言；如果 PASS，继续步骤 3。这个步骤的作用是锁定 runtime wiring 约束：worker base registry 不包含 `delegate_task`，primary registry 才显式包含它。

- [ ] **步骤 3：修改 main.tsx runtime 接线**

在 `src/main.tsx` 中将手写 registry 注册替换为 `createDefaultToolRegistry()`，并在 primary registry 中添加 `delegate_task`。核心结构如下，按现有 `MainApp` 变量名合入，不改变 CLI 参数解析和 App props：

```typescript
import { DelegationCoordinator } from './agent/coordinator.js'
import { createDeepSeekClient } from './api/deepseek.js'
import { PromptEngine } from './prompt/engine.js'
import { createDefaultToolRegistry } from './tools/default-registry.js'
import { createDelegateTaskTool } from './tools/delegate-task.js'
import type { ModelCapabilityCard } from './model/capability.js'
```

在 `MainApp` 内建立 worker base registry、capability card、coordinator 和 primary registry：

```typescript
const [workerBaseToolRegistry] = useState(() => createDefaultToolRegistry())

const modelCards = useMemo<ModelCapabilityCard[]>(() => [{
  model: currentModel.id,
  toolUseReliability: 0.8,
  jsonStability: 0.8,
  editSuccessRate: 0.6,
  testRepairRate: 0.6,
  contextWindow: currentModel.contextWindow,
  cacheEconomics: 'strong',
  recommendedTasks: ['code_search', 'plan', 'review'],
}], [currentModel])

const coordinator = useMemo(() => new DelegationCoordinator({
  baseToolRegistry: workerBaseToolRegistry,
  modelCards,
  maxWorkers: 2,
  runtimeFactory: (order, card, workerRegistry) => {
    const workerPromptEngine = new PromptEngine({
      model: card.model,
      maxTokens: Math.min(order.budget.maxTokens, currentModel.maxTokens),
      staticCtx: { tools: workerRegistry.getDefinitions() },
      volatileCtx: { cwd },
    })
    const workerClient = createDeepSeekClient({
      apiKey,
      model: card.model,
      reasoningEffort: currentModel.reasoningEffort,
      maxTokens: Math.min(order.budget.maxTokens, currentModel.maxTokens),
      thinkingBudget: Math.min(4000, Math.floor(currentModel.contextWindow * 0.01)),
    })
    return {
      order,
      client: workerClient,
      promptEngine: workerPromptEngine,
      toolRegistry: workerRegistry,
      cwd,
      maxTurns: order.budget.maxTurns,
      contextWindow: currentModel.contextWindow,
      compact: config.compact,
      compactClient,
      compactModel: compactModel?.id,
    }
  },
}), [apiKey, compactClient, compactModel?.id, config.compact, currentModel, cwd, modelCards, workerBaseToolRegistry])

const toolRegistry = useMemo(() => createDefaultToolRegistry([
  createDelegateTaskTool(coordinator),
]), [coordinator])
```

然后确保 existing `AgentLoop` construction 使用这个 `toolRegistry`，并把 `toolRegistry` 加入该 `useMemo` 的 dependency list：

```typescript
const agent = useMemo(() => {
  const promptEngine = new PromptEngine({
    model: currentModel.id,
    maxTokens: currentModel.maxTokens,
    staticCtx: { tools: toolRegistry.getDefinitions() },
    volatileCtx: { cwd },
  })

  const client = createDeepSeekClient({
    apiKey,
    model: currentModel.id,
    reasoningEffort: currentModel.reasoningEffort,
    maxTokens: currentModel.maxTokens,
    thinkingBudget: Math.min(16000, Math.floor(currentModel.contextWindow * 0.02)),
  })

  return new AgentLoop(
    {
      client,
      promptEngine,
      toolRegistry,
      maxTurns: config.agent.maxTurns,
      contextWindow: currentModel.contextWindow,
      compact: config.compact,
      compactClient,
      compactModel: compactModel?.id,
    },
    session,
    cwd,
  )
}, [apiKey, compactClient, compactModel?.id, config.agent.maxTurns, config.compact, currentModel, cwd, session, toolRegistry])
```

修改 `README.md` 工具说明区域，加入一行用户可见描述：

```markdown
- `delegate_task` — Phase 1 read-only worker delegation. Runs a bounded headless worker with read-only tools and returns structured findings to the primary session.
```

- [ ] **步骤 4：运行 typecheck 和目标测试验证通过**

运行：

```bash
npm run typecheck
npm test -- src/tools/__tests__/default-registry.test.ts src/tools/__tests__/delegate-task.test.ts src/agent/__tests__/coordinator.test.ts
```

预期：PASS，typecheck 无错误，测试输出包含：

```text
# fail 0
```

- [ ] **步骤 5：Commit**

```bash
git add src/main.tsx README.md src/tools/__tests__/default-registry.test.ts
git commit -m "feat: wire delegate task into runtime"
```

---

## 任务 8：完整验证与 OpenWolf 记录

**文件：**
- 修改：`.wolf/anatomy.md`
- 修改：`.wolf/memory.md`
- 可选修改：`.wolf/buglog.json`，仅当实现过程中修复了失败测试、构建错误或用户报告问题。

- [ ] **步骤 1：运行完整验证命令**

运行：

```bash
npm run typecheck
npm test
npm run build
```

预期：

```text
tsc --noEmit
# no TypeScript errors

# npm test reports all node:test suites passing

# tsup build completes successfully
```

- [ ] **步骤 2：运行 secret pattern 检查**

运行：

```bash
rg -n "sk-[A-Za-z0-9]" src docs .wolf
```

预期：无真实 credential 命中。若命中 `sk-xxx` 示例占位，可保留；若命中真实 key，立即替换为占位、记录 `.wolf/buglog.json`，并提醒用户轮换密钥。

- [ ] **步骤 3：确认 worker 只读边界**

运行：

```bash
npm test -- src/tools/__tests__/registry-filter.test.ts src/agent/__tests__/worker-session.test.ts src/tools/__tests__/delegate-task.test.ts
```

预期：PASS；重点确认：

```text
filterToolRegistry excludes write_file
runWorkerSession uses independent SessionContext
delegate_task returns structured worker packet
```

- [ ] **步骤 4：更新 OpenWolf anatomy 和 memory**

更新 `.wolf/anatomy.md`，新增本计划和新增源码/测试文件条目。至少包含：

```markdown
- `2026-05-16-rivet-subagent-orchestration-implementation.md` — Rivet 子代理协同 Phase 1 实现计划
- `work-order.ts` — WorkOrder/WorkerResult schema and parser
- `worker-session.ts` — Headless read-only worker session runner
- `coordinator.ts` — Phase 1 delegation coordinator
- `delegate-task.ts` — delegate_task tool factory
- `default-registry.ts` — default ToolRegistry factory
```

追加 `.wolf/memory.md` 一行记录实施结果：

```markdown
| HH:MM | completed P2.4 Phase 1 subagent delegation MVP | work-order.ts, worker-session.ts, coordinator.ts, delegate-task.ts, main.tsx | typecheck/test/build pass; delegate_task read-only worker wired | ~estimate |
```

- [ ] **步骤 5：Commit**

```bash
git add .wolf/anatomy.md .wolf/memory.md
git commit -m "docs: record subagent delegation implementation"
```

---

## 验收标准

完成本计划后，验收时必须能证明：

1. `WorkerResult` 只能通过 zod schema parse 后进入 primary packet。
2. Worker 使用独立 `SessionContext`，不会把 worker messages append 到 primary session。
3. Phase 1 worker registry 只包含 `read_file`、`glob`、`grep`、`diff`。
4. `delegate_task` 注册在 primary registry 中，但不进入 worker base registry。
5. `DelegationCoordinator` 调用了 `recommendModelForTask()`，即使初版只有当前 model card，也完成 runtime 接线。
6. `delegate_task` 对短小目标会被 budget gate 跳过，对跨文件/多符号目标会运行 worker。
7. 完整验证通过：`npm run typecheck`、`npm test`、`npm run build`。
8. 没有真实 API key、token、secret 被写入源码、文档、OpenWolf 日志或测试 fixture。

---

## 规格覆盖自检

- 任务分解器：本计划不做自动 decomposer；`delegate_task` 是显式 Phase 1 入口，用于验证 WorkOrder/WorkerResult 和 worker session。
- 子代理调度器：任务 5 实现 `DelegationCoordinator`、budget gate、model routing、worker runtime factory。
- 子代理通信：任务 1、3、4 实现 JSON result contract、repair prompt、primary packet。
- 并行执行：Phase 1 保留 `maxWorkers` 配置但只派发一个 explicit worker；多 work order queue 在下一阶段单独实现，避免吞并 cockpit 范围。
- `recommendModelForTask` 运行时接线：任务 5 和任务 7 接入 coordinator runtime。
- 只读安全边界：任务 2、4、6、8 均有测试和验证。
- Prefix cache：worker 不拼接自定义 system prompt；worker-specific 内容放入 user prompt，system prompt 仍由 `PromptEngine` 构造。
- P2.3 边界：本计划不改 cockpit panels，只在 README 记录 `delegate_task` 的用户可见行为。
