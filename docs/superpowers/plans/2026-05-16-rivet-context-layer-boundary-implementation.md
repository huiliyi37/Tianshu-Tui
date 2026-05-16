# Rivet Context Layer Boundary 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [x]`）语法来跟踪进度。

**目标：** 在不推翻现有 cache-first 请求结构的前提下，把 Rivet 原始六层上下文设计落成可测试的代码边界和可观测报告。

**架构：** 保留 `system + tools + volatile user message` 的物理通道；新增 context layer model 描述每层的稳定性、注入通道、fingerprint 参与方式和 digest。将当前 `buildVolatileBlock()` 拆为 stable/latest 两类 volatile section，PromptEngine 基于 layer report 构造请求并暴露 debug/cockpit 可消费的 context report。

**技术栈：** TypeScript, node:test, node:assert/strict, existing `PromptEngine`, `buildVolatileBlock`, `ContextLedger`, `truncateContent`

---

## 背景

原始 Rivet 设计是 cache-first：DeepSeek V4 不可靠支持 `cache_control: ephemeral`，因此必须让 system prompt、tool definitions 和稳定上下文形成尽可能稳定的 token prefix。Progressive Context Engine 进一步定义了六个逻辑层：

```text
L1 Stable System Prompt
L2 Tool Definitions
L3 Session Memory
L4 Active Working Set
L5 Recent Raw Turns
L6 User Current Request
```

当前实现保留了正确的物理请求结构：

```text
system + tools + volatile user message
```

但 session memory、working set、tool history、task progress、behavior mirror、decisions 等逻辑层被压进同一个 volatile block。后续修复不应改成六个 API message；真正需要的是让六个逻辑层在代码、fingerprint、测试和 TUI 诊断里有明确边界。

本计划假设 Cache Safety Layer 已经或将并行执行：

```text
docs/superpowers/plans/2026-05-16-rivet-cache-safety-implementation.md
```

如果该计划尚未完成，先执行其 P0 任务，避免本计划在不安全缓存边界上继续扩展。

---

## 文件结构

| 操作 | 文件 | 职责 |
|------|------|------|
| 创建 | `src/prompt/context-layer.ts` | 定义 context layer 数据模型、稳定性、注入通道、fingerprint 策略、digest helper |
| 创建 | `src/prompt/__tests__/context-layer.test.ts` | 覆盖 layer digest 稳定、排序稳定、report 结构 |
| 修改 | `src/prompt/volatile.ts` | 拆分 stable/latest volatile block builder，保留兼容 wrapper |
| 修改 | `src/prompt/__tests__/volatile.test.ts` | 覆盖 stable block 不包含 latest dynamic sections，latest block 包含 tool/task sections |
| 修改 | `src/prompt/engine.ts` | 使用 context layer model 构建请求，暴露 `getContextLayerReport()` |
| 修改 | `src/prompt/fingerprint.ts` | 如果 Cache Safety 计划未完成，在这里补 `stableVolatileSha256`；如果已完成，只接入 layer digest |
| 修改 | `src/prompt/__tests__/engine.test.ts` | 覆盖 dynamic context 只进入 latest turn、context report 和 fingerprint |
| 修改 | `src/tui/cockpit/context-panel.tsx` | 展示 context layer report 的摘要信息 |
| 修改 | `src/tui/cockpit/__tests__/panels.test.ts` | 覆盖 context panel 能显示 layer 状态 |
| 修改 | `docs/superpowers/specs/2026-05-16-rivet-context-layer-cache-architecture-gap.md` | 实施后补充状态，说明哪些差距已关闭 |
| 修改 | `README.md` | 补充 context layer/cache-first 架构说明 |

---

### 任务 1：定义 context layer model

**文件：**
- 创建：`src/prompt/context-layer.ts`
- 测试：`src/prompt/__tests__/context-layer.test.ts`

- [x] **步骤 1：编写失败的测试**

创建 `src/prompt/__tests__/context-layer.test.ts`：

```typescript
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  createContextLayer,
  createContextLayerReport,
  stableLayerDigest,
} from '../context-layer.js'

describe('context-layer', () => {
  it('creates stable digests independent of object key order', () => {
    const a = stableLayerDigest({ b: 2, a: 1 })
    const b = stableLayerDigest({ a: 1, b: 2 })
    assert.equal(a, b)
  })

  it('records stability channel and fingerprint policy', () => {
    const layer = createContextLayer({
      id: 'session-memory',
      label: 'Session Memory',
      stability: 'stable-volatile',
      channel: 'volatile-user-message',
      fingerprint: 'included',
      content: '<session-memory />',
    })

    assert.equal(layer.id, 'session-memory')
    assert.equal(layer.stability, 'stable-volatile')
    assert.equal(layer.channel, 'volatile-user-message')
    assert.equal(layer.fingerprint, 'included')
    assert.ok(layer.digest.startsWith('sha256:'))
  })

  it('creates a report with layers in explicit order', () => {
    const report = createContextLayerReport([
      createContextLayer({
        id: 'current-request',
        label: 'Current Request',
        stability: 'dynamic',
        channel: 'current-user-message',
        fingerprint: 'excluded',
        content: 'fix bug',
      }),
      createContextLayer({
        id: 'system',
        label: 'Stable System Prompt',
        stability: 'stable',
        channel: 'system',
        fingerprint: 'included',
        content: 'system prompt',
      }),
    ])

    assert.deepEqual(report.layers.map(l => l.id), ['system', 'current-request'])
    assert.equal(report.fingerprintIncluded.length, 1)
    assert.equal(report.fingerprintIncluded[0]!.id, 'system')
  })
})
```

- [x] **步骤 2：运行测试验证失败**

运行：

```bash
npm test -- src/prompt/__tests__/context-layer.test.ts
```

预期：FAIL，报错包含：

```text
Cannot find module '../context-layer.js'
```

- [x] **步骤 3：实现 context layer model**

创建 `src/prompt/context-layer.ts`：

```typescript
import { createHash } from 'node:crypto'

export type ContextLayerId =
  | 'system'
  | 'tools'
  | 'session-memory'
  | 'working-set'
  | 'recent-raw-turns'
  | 'current-request'
  | 'project-instructions'
  | 'git-status'
  | 'tool-history'
  | 'task-progress'
  | 'behavior-mirror'
  | 'decisions'

export type ContextLayerStability = 'stable' | 'stable-volatile' | 'dynamic'
export type ContextLayerChannel = 'system' | 'tools' | 'volatile-user-message' | 'raw-messages' | 'current-user-message'
export type ContextLayerFingerprint = 'included' | 'excluded' | 'partial'

export interface ContextLayerInput {
  id: ContextLayerId
  label: string
  stability: ContextLayerStability
  channel: ContextLayerChannel
  fingerprint: ContextLayerFingerprint
  content: string
  tokenEstimate?: number
}

export interface ContextLayer extends ContextLayerInput {
  digest: string
  tokenEstimate: number
}

export interface ContextLayerReport {
  layers: ContextLayer[]
  fingerprintIncluded: ContextLayer[]
  dynamicLayers: ContextLayer[]
}

const LAYER_ORDER: ContextLayerId[] = [
  'system',
  'tools',
  'project-instructions',
  'git-status',
  'session-memory',
  'working-set',
  'recent-raw-turns',
  'tool-history',
  'task-progress',
  'behavior-mirror',
  'decisions',
  'current-request',
]

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const object = value as Record<string, unknown>
  return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${stableStringify(object[key])}`).join(',')}}`
}

export function stableLayerDigest(value: unknown): string {
  return `sha256:${createHash('sha256').update(stableStringify(value)).digest('hex')}`
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

export function createContextLayer(input: ContextLayerInput): ContextLayer {
  return {
    ...input,
    digest: stableLayerDigest(input.content),
    tokenEstimate: input.tokenEstimate ?? estimateTokens(input.content),
  }
}

export function createContextLayerReport(layers: ContextLayer[]): ContextLayerReport {
  const ordered = [...layers].sort((a, b) => LAYER_ORDER.indexOf(a.id) - LAYER_ORDER.indexOf(b.id))
  return {
    layers: ordered,
    fingerprintIncluded: ordered.filter(layer => layer.fingerprint === 'included'),
    dynamicLayers: ordered.filter(layer => layer.stability === 'dynamic'),
  }
}
```

- [x] **步骤 4：运行测试验证通过**

运行：

```bash
npm test -- src/prompt/__tests__/context-layer.test.ts
```

预期：PASS。

- [x] **步骤 5：Commit**

```bash
git add src/prompt/context-layer.ts src/prompt/__tests__/context-layer.test.ts
git commit -m "feat(prompt): define context layer model"
```

---

### 任务 2：拆分 stable/latest volatile block builder

**文件：**
- 修改：`src/prompt/volatile.ts`
- 测试：`src/prompt/__tests__/volatile.test.ts`

- [x] **步骤 1：编写失败的测试**

在 `src/prompt/__tests__/volatile.test.ts` 增加：

```typescript
import {
  buildLatestTurnVolatileBlock,
  buildStableVolatileBlock,
} from '../volatile.js'

it('keeps latest dynamic sections out of the stable volatile block', () => {
  const stable = buildStableVolatileBlock({
    cwd: '/repo',
    sessionMemoryBlock: '<session-memory><entry>remember decision</entry></session-memory>',
    toolHistory: [{ tool: 'read_file', target: 'src/a.ts', status: 'success' }],
    taskProgress: { currentGoal: 'fix cache', completed: ['read docs'], next: ['write tests'] },
  })

  assert.ok(stable.includes('<context>'))
  assert.ok(stable.includes('<session-memory>'))
  assert.equal(stable.includes('<tool-history'), false)
  assert.equal(stable.includes('<task-progress'), false)
})

it('puts latest dynamic sections in latest turn volatile block', () => {
  const latest = buildLatestTurnVolatileBlock({
    cwd: '/repo',
    toolHistory: [{ tool: 'read_file', target: 'src/a.ts', status: 'success' }],
    taskProgress: { currentGoal: 'fix cache', completed: ['read docs'], next: ['write tests'] },
  })

  assert.ok(latest.includes('<tool-history'))
  assert.ok(latest.includes('<task-progress'))
})
```

- [x] **步骤 2：运行测试验证失败**

运行：

```bash
npm test -- src/prompt/__tests__/volatile.test.ts
```

预期：FAIL，报错包含：

```text
The requested module '../volatile.js' does not provide an export named 'buildStableVolatileBlock'
```

- [x] **步骤 3：实现 stable/latest builder**

修改 `src/prompt/volatile.ts`，保留现有 `VolatileContext` 类型，新增：

```typescript
export function buildStableVolatileBlock(ctx: VolatileContext): string {
  return buildVolatileBlockInternal({
    ...ctx,
    toolHistory: undefined,
    taskProgress: undefined,
    behaviorMirror: undefined,
    decisions: undefined,
  })
}

export function buildLatestTurnVolatileBlock(ctx: VolatileContext): string {
  return buildVolatileBlockInternal(ctx)
}

export function buildVolatileBlock(ctx: VolatileContext): string {
  return buildLatestTurnVolatileBlock(ctx)
}
```

Rename the current `buildVolatileBlock(ctx: VolatileContext)` implementation to:

```typescript
function buildVolatileBlockInternal(ctx: VolatileContext): string {
  // existing implementation body goes here unchanged
}
```

If `behaviorMirror` and `decisions` are currently not declared on `VolatileContext`, add them:

```typescript
behaviorMirror?: string | null
decisions?: string[]
```

- [x] **步骤 4：运行测试验证通过**

运行：

```bash
npm test -- src/prompt/__tests__/volatile.test.ts
```

预期：PASS。

- [x] **步骤 5：Commit**

```bash
git add src/prompt/volatile.ts src/prompt/__tests__/volatile.test.ts
git commit -m "feat(prompt): split stable and latest volatile context"
```

---

### 任务 3：让 PromptEngine 使用 context layer report

**文件：**
- 修改：`src/prompt/engine.ts`
- 测试：`src/prompt/__tests__/engine.test.ts`

- [x] **步骤 1：编写失败的测试**

在 `src/prompt/__tests__/engine.test.ts` 增加：

```typescript
it('reports context layers with channels and fingerprint policy', () => {
  const engine = new PromptEngine({
    model: 'test',
    maxTokens: 1000,
    staticCtx: { tools: [] },
    volatileCtx: {
      cwd: '/repo',
      sessionMemoryBlock: '<session-memory><entry>decision</entry></session-memory>',
      workingSet: ['src/prompt/engine.ts'],
    },
  })

  const report = engine.getContextLayerReport()
  assert.deepEqual(report.layers.map(layer => layer.id), [
    'system',
    'tools',
    'project-instructions',
    'git-status',
    'session-memory',
    'working-set',
  ])
  assert.ok(report.fingerprintIncluded.some(layer => layer.id === 'system'))
  assert.ok(report.fingerprintIncluded.some(layer => layer.id === 'session-memory'))
})
```

- [x] **步骤 2：运行测试验证失败**

运行：

```bash
npm test -- src/prompt/__tests__/engine.test.ts
```

预期：FAIL，报错包含：

```text
engine.getContextLayerReport is not a function
```

- [x] **步骤 3：实现 report 生成**

修改 `src/prompt/engine.ts` imports：

```typescript
import { buildLatestTurnVolatileBlock, buildStableVolatileBlock } from './volatile.js'
import { createContextLayer, createContextLayerReport, type ContextLayerReport } from './context-layer.js'
```

在 class 字段增加：

```typescript
private contextLayerReport: ContextLayerReport
```

在 constructor 中使用 stable builder：

```typescript
this.volatileBlock = buildStableVolatileBlock(config.volatileCtx)
this.contextLayerReport = createContextLayerReport([
  createContextLayer({
    id: 'system',
    label: 'Stable System Prompt',
    stability: 'stable',
    channel: 'system',
    fingerprint: 'included',
    content: this.systemPrompt,
  }),
  createContextLayer({
    id: 'tools',
    label: 'Tool Definitions',
    stability: 'stable',
    channel: 'tools',
    fingerprint: 'included',
    content: JSON.stringify(config.staticCtx.tools),
  }),
  createContextLayer({
    id: 'project-instructions',
    label: 'Project Instructions',
    stability: 'stable-volatile',
    channel: 'volatile-user-message',
    fingerprint: 'included',
    content: config.volatileCtx.rivetMd ?? '',
  }),
  createContextLayer({
    id: 'git-status',
    label: 'Git Status',
    stability: 'stable-volatile',
    channel: 'volatile-user-message',
    fingerprint: 'included',
    content: config.volatileCtx.gitStatus ?? '',
  }),
  createContextLayer({
    id: 'session-memory',
    label: 'Session Memory',
    stability: 'stable-volatile',
    channel: 'volatile-user-message',
    fingerprint: 'included',
    content: config.volatileCtx.sessionMemoryBlock ?? '',
  }),
  createContextLayer({
    id: 'working-set',
    label: 'Working Set',
    stability: 'stable-volatile',
    channel: 'volatile-user-message',
    fingerprint: 'partial',
    content: (config.volatileCtx.workingSet ?? []).join('\n'),
  }),
].filter(layer => layer.content.length > 0 || layer.id === 'system' || layer.id === 'tools'))
```

Add method:

```typescript
getContextLayerReport(): ContextLayerReport {
  return this.contextLayerReport
}
```

In `buildRequest()`, replace fresh block construction with `buildLatestTurnVolatileBlock()`:

```typescript
const freshBlock = buildLatestTurnVolatileBlock({
  ...this.config.volatileCtx,
  toolHistory,
  taskProgress: this.taskProgress,
  behaviorMirror: this.behaviorMirror,
  decisions: this.decisions,
})
```

- [x] **步骤 4：运行测试验证通过**

运行：

```bash
npm test -- src/prompt/__tests__/engine.test.ts src/prompt/__tests__/context-layer.test.ts
```

预期：PASS。

- [x] **步骤 5：Commit**

```bash
git add src/prompt/engine.ts src/prompt/__tests__/engine.test.ts
git commit -m "feat(prompt): expose context layer report"
```

---

### 任务 4：将 fingerprint 接到 stable volatile layer digest

**文件：**
- 修改：`src/prompt/fingerprint.ts`
- 修改：`src/prompt/engine.ts`
- 测试：`src/prompt/__tests__/fingerprint.test.ts`
- 测试：`src/prompt/__tests__/engine.test.ts`

- [x] **步骤 1：编写失败的测试**

如果 Cache Safety Layer 尚未完成，在 `src/prompt/__tests__/fingerprint.test.ts` 增加：

```typescript
it('includes stable volatile context in combined fingerprint', () => {
  const a = computeFingerprint('system', [], '<context><session>A</session></context>')
  const b = computeFingerprint('system', [], '<context><session>B</session></context>')
  assert.notEqual(a.combinedSha256, b.combinedSha256)
  assert.notEqual(a.stableVolatileSha256, b.stableVolatileSha256)
})
```

如果 Cache Safety Layer 已完成，改为在 `engine.test.ts` 断言：

```typescript
it('aligns context report fingerprint layers with PromptEngine fingerprint', () => {
  const engine = new PromptEngine({
    model: 'test',
    maxTokens: 1000,
    staticCtx: { tools: [] },
    volatileCtx: { cwd: '/repo', sessionMemoryBlock: '<session-memory>A</session-memory>' },
  })

  const report = engine.getContextLayerReport()
  assert.ok(report.fingerprintIncluded.some(layer => layer.id === 'session-memory'))
  assert.ok(engine.getFingerprint().stableVolatileSha256)
})
```

- [x] **步骤 2：运行测试验证失败**

运行：

```bash
npm test -- src/prompt/__tests__/fingerprint.test.ts src/prompt/__tests__/engine.test.ts
```

预期：若尚未完成 Cache Safety Layer，新增 fingerprint 测试 FAIL；若已完成，则 engine/report 对齐测试可能 FAIL。

- [x] **步骤 3：接入 stable volatile fingerprint**

如果 `PrefixFingerprint` 还没有 `stableVolatileSha256`，按 cache safety 计划增加：

```typescript
export interface PrefixFingerprint {
  systemSha256: string
  toolsSha256: string
  stableVolatileSha256: string
  combinedSha256: string
}
```

让 `computeFingerprint()` 支持第三个参数：

```typescript
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

In `PromptEngine` constructor and `checkDrift()` use:

```typescript
this.fingerprint = computeFingerprint(this.systemPrompt, config.staticCtx.tools, this.volatileBlock)
```

```typescript
const current = computeFingerprint(this.systemPrompt, this.config.staticCtx.tools, this.volatileBlock)
```

- [x] **步骤 4：运行测试验证通过**

运行：

```bash
npm test -- src/prompt/__tests__/fingerprint.test.ts src/prompt/__tests__/engine.test.ts
```

预期：PASS。

- [x] **步骤 5：Commit**

```bash
git add src/prompt/fingerprint.ts src/prompt/engine.ts src/prompt/__tests__/fingerprint.test.ts src/prompt/__tests__/engine.test.ts
git commit -m "fix(prompt): align fingerprint with stable context layers"
```

---

### 任务 5：让 ContextPanel 展示 layer report

**文件：**
- 修改：`src/tui/cockpit/context-panel.tsx`
- 修改：`src/tui/cockpit/types.ts`
- 测试：`src/tui/cockpit/__tests__/panels.test.ts`

- [x] **步骤 1：编写失败的测试**

在 `src/tui/cockpit/__tests__/panels.test.ts` 增加：

```typescript
it('renders context layer summary when report is present', () => {
  const output = renderToString(<ContextPanel state={{
    estimatedTokens: 1200,
    maxTokens: 10000,
    compactionState: 'healthy',
    layers: [
      { id: 'system', label: 'Stable System Prompt', stability: 'stable', channel: 'system', fingerprint: 'included', digest: 'sha256:a', tokenEstimate: 100 },
      { id: 'session-memory', label: 'Session Memory', stability: 'stable-volatile', channel: 'volatile-user-message', fingerprint: 'included', digest: 'sha256:b', tokenEstimate: 40 },
      { id: 'tool-history', label: 'Tool History', stability: 'dynamic', channel: 'volatile-user-message', fingerprint: 'excluded', digest: 'sha256:c', tokenEstimate: 20 },
    ],
  }} />)

  assert.match(output, /Stable System Prompt/)
  assert.match(output, /Session Memory/)
  assert.match(output, /Tool History/)
  assert.match(output, /fingerprint/)
})
```

Use the existing render helper/import style in `panels.test.ts`. If `ContextPanel` currently takes different props, adapt the prop wrapper while preserving the same expected visible strings.

- [x] **步骤 2：运行测试验证失败**

运行：

```bash
npm test -- src/tui/cockpit/__tests__/panels.test.ts
```

预期：FAIL，output 不包含 layer labels。

- [x] **步骤 3：扩展 cockpit context state**

修改 `src/tui/cockpit/types.ts`，新增或扩展 context state 类型：

```typescript
export interface CockpitContextLayerView {
  id: string
  label: string
  stability: string
  channel: string
  fingerprint: string
  digest: string
  tokenEstimate: number
}

export interface CockpitContextState {
  estimatedTokens: number
  maxTokens: number
  compactionState: string
  layers?: CockpitContextLayerView[]
}
```

修改 `src/tui/cockpit/context-panel.tsx`，在现有 token/compact 信息下方加入：

```tsx
{state.layers && state.layers.length > 0 && (
  <Box flexDirection="column" marginTop={1}>
    <Text color="cyan">Context layers</Text>
    {state.layers.map(layer => (
      <Text key={layer.id}>
        {layer.label} · {layer.stability} · {layer.channel} · fingerprint:{layer.fingerprint} · {layer.tokenEstimate}t
      </Text>
    ))}
  </Box>
)}
```

- [x] **步骤 4：运行测试验证通过**

运行：

```bash
npm test -- src/tui/cockpit/__tests__/panels.test.ts
```

预期：PASS。

- [x] **步骤 5：Commit**

```bash
git add src/tui/cockpit/context-panel.tsx src/tui/cockpit/types.ts src/tui/cockpit/__tests__/panels.test.ts
git commit -m "feat(tui): show context layer report in cockpit"
```

---

### 任务 6：更新架构文档与 README

**文件：**
- 修改：`docs/superpowers/specs/2026-05-16-rivet-context-layer-cache-architecture-gap.md`
- 修改：`README.md`

- [x] **步骤 1：更新架构文档实施状态**

在 `docs/superpowers/specs/2026-05-16-rivet-context-layer-cache-architecture-gap.md` 的“修复路线”后加入：

```markdown
## 实施完成后的目标形态

代码层应能回答以下问题：

| 问题 | 回答来源 |
|------|----------|
| 哪些内容属于 stable cache anchor？ | `PromptEngine.getContextLayerReport()` |
| 哪些内容只进入 latest turn？ | `ContextLayer.stability === 'dynamic'` |
| 哪些内容参与 fingerprint？ | `ContextLayer.fingerprint` |
| 哪一层导致 drift？ | `PrefixFingerprint` + layer digest |
| 每层 token 成本是多少？ | `ContextLayer.tokenEstimate` |

这不是把请求改成六条 message，而是让六层业务语义成为代码边界。
```

- [x] **步骤 2：更新 README**

在 README 的 architecture 或 prompt/cache 相关章节加入：

```markdown
### Cache-first Context Layers

Rivet keeps the provider-facing request cache-friendly by separating physical channels from logical context layers:

- Physical channels: stable `system`, stable `tools`, and volatile user-message context.
- Logical layers: stable prompt, tool definitions, session memory, active working set, recent raw turns, and current request.

The logical layers are represented in code so Rivet can explain which sections participate in prefix fingerprints, which sections are dynamic-only, and which sections consume the context budget. This preserves DeepSeek prefix-cache stability without hiding session memory or working-set state from the model.
```

- [x] **步骤 3：运行文档检查命令**

运行：

```bash
git diff --check docs/superpowers/specs/2026-05-16-rivet-context-layer-cache-architecture-gap.md README.md
```

预期：无输出。

- [x] **步骤 4：Commit**

```bash
git add docs/superpowers/specs/2026-05-16-rivet-context-layer-cache-architecture-gap.md README.md
git commit -m "docs: describe cache-first context layer architecture"
```

---

### 任务 7：最终验证

**文件：**
- 无新增业务文件；验证整个变更集

- [x] **步骤 1：运行 focused tests**

运行：

```bash
npm test -- src/prompt/__tests__/context-layer.test.ts src/prompt/__tests__/volatile.test.ts src/prompt/__tests__/engine.test.ts src/prompt/__tests__/fingerprint.test.ts src/tui/cockpit/__tests__/panels.test.ts
```

预期：PASS。

- [x] **步骤 2：运行完整验证**

运行：

```bash
npm run typecheck
npm test
npm run build
```

预期：全部 PASS。

- [x] **步骤 3：检查没有真实 secrets**

运行：

```bash
git diff -- src docs README.md | grep -Ei "sk-[a-zA-Z0-9]|api[_-]?key\s*=|password\s*=|secret\s*=" || true
```

预期：无真实密钥或 credential 片段命中。文档中出现 “API key” 字样可以接受，但不能出现真实 key/token。

- [x] **步骤 4：Commit**

如果前面每个任务都已 commit，本步骤不需要新 commit。若验证修复产生小改动：

```bash
git add <changed-files>
git commit -m "test: verify context layer boundaries"
```

---

## 自检

### 规格覆盖度

- 原始 cache-first 思想：任务 6 文档覆盖。
- physical channel 与 logical layer 区分：任务 1、3、6 覆盖。
- stable/latest volatile 拆分：任务 2、3 覆盖。
- stable volatile fingerprint：任务 4 覆盖。
- context layer 可观测：任务 3、5 覆盖。
- 完整验证：任务 7 覆盖。

### 占位符扫描

本文没有使用“待定”、“后续实现”、“补充细节”作为实施内容；所有代码任务都给出具体文件、代码片段、命令和预期结果。

### 类型一致性

- `ContextLayer`、`ContextLayerReport` 在任务 1 定义，在任务 3 和任务 5 使用。
- `buildStableVolatileBlock()`、`buildLatestTurnVolatileBlock()` 在任务 2 定义，在任务 3 使用。
- `stableVolatileSha256` 在任务 4 中与 cache safety 计划保持一致。
- `CockpitContextLayerView` 在任务 5 定义，只承载 UI 展示所需字段，不依赖 prompt 内部实现。

---

计划已完成并保存到 `docs/superpowers/plans/2026-05-16-rivet-context-layer-boundary-implementation.md`。两种执行方式：

**1. 子代理驱动（推荐）** - 每个任务调度一个新的子代理，任务间进行审查，快速迭代

**2. 内联执行** - 在当前会话中使用 executing-plans 执行任务，批量执行并设有检查点

选哪种方式？
