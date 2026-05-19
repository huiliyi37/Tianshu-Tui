# 冰鉴 v2 — 习惯化巩固引擎 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 在 DeepSeek/MiMO 百万 token 上下文的长 session（30-50 turn）中，将缓存命中率从 v1 的 60% 提升到 90%+。

**架构：** 新增 FieldHabituationTracker，追踪每个动态字段的内容 hash。连续 5 turn 内容不变的字段自动晋升到巩固区（字节固化到前缀中）。内容变化时降级回工作区。三区布局：`<context>frozen</context>\n<consolidated>habituated</consolidated>\n<context-update>active</context-update>`。

**技术栈：** TypeScript / Node.js 22+ / node:test + node:assert/strict / crypto SHA-256

**分支：** 基于 `feat/tianshu-star-soul`（v1 已合并）

**规格来源：** `docs/superpowers/specs/2026-05-19-ice-mirror-v2-multi-provider-cache-engine-design.md` Phase 2

**优先 provider：** DeepSeek V4 + MiMO（100 万上下文，exact-prefix 缓存）

---

## v1 基线数据（校准依据）

```
FROZEN volatile = ~4,800 tokens（含 git status, rivetMd, knowledge, working-set）
每轮 FRESH dynamic appendix = ~3,000 tokens（tool-history, claims, lessons, ledger 等）
Turn 5 cache hit rate = 61%（持续增长趋势）
每轮新增 miss ≈ 7-8K tokens（FRESH appendix + user msg + assistant response）
```

v2 的目标：把 ~3,000 tokens 的 dynamic appendix 中稳定的字段（activeDomain, playbookLessons, behaviorMirror, strategyShift, routingReason）晋升到巩固区，减少每轮 miss 到 ~1,500 tokens。

---

## 设计决策（来自 Opus 审查修正）

| 决策 | 规格原文 | 修正 | 理由 |
|------|---------|------|------|
| 习惯化阈值 | 3 turn | **5 turn** | 防止晋升后快速降级造成 cache break |
| 巩固区位置 | 未明确 | **方案 B：context 和 context-update 之间** | FROZEN 永远不变，巩固区变化只影响其后内容 |
| Phase 1（多 provider） | 优先 | **延后** | v1 测试验证 DeepSeek 已工作，先做长 session 优化 |
| Phase 3（成本指标） | 计划内 | **可选追加** | 不阻塞核心缓存提升 |

---

## 三区字节布局

```
v1 (当前):
  <context>...frozen...</context>\n<context-update>...ALL dynamic...</context-update>

v2 (目标):
  <context>...frozen...</context>\n<consolidated>...habituated fields...</consolidated>\n<context-update>...active fields only...</context-update>

字节关系:
  FROZEN          = <context>...</context>                              (永不变)
  FROZEN+CONSOL   = <context>...</context>\n<consolidated>...</consol>  (晋升后单调递增)
  FULL            = FROZEN+CONSOL + \n<context-update>...</ctx-update>  (FROZEN+CONSOL 是字节前缀)
```

晋升时的一次性 cache break：巩固区增长 → consolidated 之后的 bytes 变化 → 一次 miss。之后 N 个 turn 都命中扩展的前缀。ROI = 1 turn break / N turn 持续命中。

---

## 文件结构

### 新建文件

| 文件 | 职责 |
|------|------|
| `src/prompt/field-habituation.ts` | FieldHabituationTracker — 追踪每个动态字段的 hash + 稳定计数器，决定晋升/降级 |
| `src/prompt/__tests__/field-habituation.test.ts` | 晋升、降级、阈值、多字段并行测试 |
| `src/prompt/__tests__/volatile-consolidation.test.ts` | 三区字节布局稳定性测试 |

### 修改文件

| 文件 | 变更 |
|------|------|
| `src/prompt/volatile.ts` | 新增 `buildConsolidatedBlock(fields)`；修改 `buildLatestTurnVolatileBlock` 渲染三区 |
| `src/prompt/engine.ts` | 持有 `FieldHabituationTracker`；每轮 buildRequest 时调用 tracker.recordTurn + 分区渲染 |

---

## 任务列表

### 任务 1：FieldHabituationTracker 核心实现

**文件：**
- 创建：`src/prompt/field-habituation.ts`
- 测试：`src/prompt/__tests__/field-habituation.test.ts`

- [ ] **步骤 1：编写失败的测试**

```typescript
// src/prompt/__tests__/field-habituation.test.ts
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { FieldHabituationTracker } from '../field-habituation.js'

describe('FieldHabituationTracker', () => {
  it('field stays active until reaching habituation threshold', () => {
    const tracker = new FieldHabituationTracker({ threshold: 5 })

    // 4 turns with same content — not yet habituated
    for (let i = 0; i < 4; i++) {
      tracker.recordTurn({ domain: 'tianshu-planning' })
    }
    assert.ok(tracker.getActive().has('domain'))
    assert.ok(!tracker.getHabituated().has('domain'))
  })

  it('field promotes to habituated after threshold consecutive stable turns', () => {
    const tracker = new FieldHabituationTracker({ threshold: 5 })

    for (let i = 0; i < 5; i++) {
      tracker.recordTurn({ domain: 'tianshu-planning' })
    }
    assert.ok(tracker.getHabituated().has('domain'))
    assert.ok(!tracker.getActive().has('domain'))
  })

  it('field demotes on content change (dehabituation)', () => {
    const tracker = new FieldHabituationTracker({ threshold: 5 })

    // Promote
    for (let i = 0; i < 5; i++) {
      tracker.recordTurn({ domain: 'tianshu-planning' })
    }
    assert.ok(tracker.getHabituated().has('domain'))

    // Content changes → dehabituation
    tracker.recordTurn({ domain: 'tianji-decomposing' })
    assert.ok(!tracker.getHabituated().has('domain'))
    assert.ok(tracker.getActive().has('domain'))
  })

  it('counter resets on content change', () => {
    const tracker = new FieldHabituationTracker({ threshold: 5 })

    for (let i = 0; i < 3; i++) {
      tracker.recordTurn({ domain: 'value-a' })
    }
    // Content changes → counter resets
    tracker.recordTurn({ domain: 'value-b' })

    // Need another 5 consecutive to promote
    for (let i = 0; i < 4; i++) {
      tracker.recordTurn({ domain: 'value-b' })
    }
    assert.ok(!tracker.getHabituated().has('domain'))

    tracker.recordTurn({ domain: 'value-b' })
    assert.ok(tracker.getHabituated().has('domain'))
  })

  it('tracks multiple fields independently', () => {
    const tracker = new FieldHabituationTracker({ threshold: 5 })

    for (let i = 0; i < 5; i++) {
      tracker.recordTurn({
        domain: 'stable',
        lessons: 'stable-lesson',
        toolHistory: `tool-call-${i}`,  // changes every turn
      })
    }

    assert.ok(tracker.getHabituated().has('domain'))
    assert.ok(tracker.getHabituated().has('lessons'))
    assert.ok(!tracker.getHabituated().has('toolHistory'))
    assert.ok(tracker.getActive().has('toolHistory'))
  })

  it('getHabituatedContent returns frozen content at promotion time', () => {
    const tracker = new FieldHabituationTracker({ threshold: 5 })

    for (let i = 0; i < 5; i++) {
      tracker.recordTurn({ domain: 'tianshu-planning' })
    }

    const content = tracker.getHabituatedContent()
    assert.equal(content.get('domain'), 'tianshu-planning')
  })

  it('field absent in a turn is treated as content change (empty string)', () => {
    const tracker = new FieldHabituationTracker({ threshold: 5 })

    for (let i = 0; i < 5; i++) {
      tracker.recordTurn({ domain: 'stable' })
    }
    assert.ok(tracker.getHabituated().has('domain'))

    // domain absent → dehabituation
    tracker.recordTurn({})
    assert.ok(!tracker.getHabituated().has('domain'))
  })

  it('empty tracker returns empty sets', () => {
    const tracker = new FieldHabituationTracker({ threshold: 5 })
    assert.equal(tracker.getHabituated().size, 0)
    assert.equal(tracker.getActive().size, 0)
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`./node_modules/.bin/tsx --test src/prompt/__tests__/field-habituation.test.ts`
预期：FAIL，"Cannot find module '../field-habituation.js'"

- [ ] **步骤 3：编写实现**

```typescript
// src/prompt/field-habituation.ts
import { createHash } from 'crypto'

export interface HabituationConfig {
  threshold: number  // consecutive stable turns to promote (default: 5)
}

interface FieldState {
  hash: string
  content: string
  stableCount: number
  habituated: boolean
}

function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex').slice(0, 16)
}

export class FieldHabituationTracker {
  private fields = new Map<string, FieldState>()
  private readonly threshold: number

  constructor(config: HabituationConfig) {
    this.threshold = config.threshold
  }

  recordTurn(fieldValues: Record<string, string>): void {
    const seen = new Set<string>()

    for (const [name, content] of Object.entries(fieldValues)) {
      seen.add(name)
      const hash = sha256(content)
      const existing = this.fields.get(name)

      if (!existing) {
        this.fields.set(name, { hash, content, stableCount: 1, habituated: false })
        continue
      }

      if (existing.hash === hash) {
        existing.stableCount++
        if (existing.stableCount >= this.threshold && !existing.habituated) {
          existing.habituated = true
        }
      } else {
        existing.hash = hash
        existing.content = content
        existing.stableCount = 1
        existing.habituated = false
      }
    }

    // Fields not present in this turn → dehabituation
    for (const [name, state] of this.fields) {
      if (!seen.has(name)) {
        state.hash = sha256('')
        state.content = ''
        state.stableCount = 1
        state.habituated = false
      }
    }
  }

  getHabituated(): Set<string> {
    const result = new Set<string>()
    for (const [name, state] of this.fields) {
      if (state.habituated) result.add(name)
    }
    return result
  }

  getActive(): Set<string> {
    const result = new Set<string>()
    for (const [name, state] of this.fields) {
      if (!state.habituated) result.add(name)
    }
    return result
  }

  getHabituatedContent(): Map<string, string> {
    const result = new Map<string, string>()
    for (const [name, state] of this.fields) {
      if (state.habituated) result.set(name, state.content)
    }
    return result
  }
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`./node_modules/.bin/tsx --test src/prompt/__tests__/field-habituation.test.ts`
预期：8/8 PASS

- [ ] **步骤 5：Commit**

```bash
git add src/prompt/field-habituation.ts src/prompt/__tests__/field-habituation.test.ts
git commit -m "feat(prompt): add FieldHabituationTracker for dynamic field promotion"
```

---

### 任务 2：buildConsolidatedBlock + 三区渲染

**文件：**
- 修改：`src/prompt/volatile.ts`
- 测试：`src/prompt/__tests__/volatile-consolidation.test.ts`（新建）

- [ ] **步骤 1：编写失败的测试**

```typescript
// src/prompt/__tests__/volatile-consolidation.test.ts
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { buildStableVolatileBlock, buildConsolidatedBlock, buildDynamicAppendix } from '../volatile.js'

describe('three-zone layout: frozen + consolidated + working', () => {
  const baseCtx = {
    cwd: '/test',
    gitStatus: 'Current branch: main\nStatus:\nM src/foo.ts',
    rivetMd: '# Project',
  }

  it('buildConsolidatedBlock renders habituated fields in <consolidated> tag', () => {
    const consolidated = buildConsolidatedBlock(new Map([
      ['activeDomain', '<star-domain name="tianshu" motto="test">block</star-domain>'],
      ['lessons', '<historical-lessons>\n- lesson 1\n</historical-lessons>'],
    ]))
    assert.ok(consolidated.startsWith('<consolidated>'))
    assert.ok(consolidated.endsWith('</consolidated>'))
    assert.ok(consolidated.includes('star-domain'))
    assert.ok(consolidated.includes('historical-lessons'))
  })

  it('buildConsolidatedBlock returns empty string when no habituated fields', () => {
    const consolidated = buildConsolidatedBlock(new Map())
    assert.equal(consolidated, '')
  })

  it('three-zone: FROZEN is byte prefix of FROZEN+CONSOLIDATED', () => {
    const frozen = buildStableVolatileBlock(baseCtx)
    const consolidated = buildConsolidatedBlock(new Map([
      ['domain', '<star-domain name="test" motto="m">b</star-domain>'],
    ]))

    const frozenPlusConsol = frozen + '\n' + consolidated
    assert.ok(frozenPlusConsol.startsWith(frozen))
  })

  it('three-zone: FROZEN+CONSOLIDATED is byte prefix of full output', () => {
    const frozen = buildStableVolatileBlock(baseCtx)
    const consolidated = buildConsolidatedBlock(new Map([
      ['domain', '<star-domain name="test" motto="m">b</star-domain>'],
    ]))
    const dynamic = buildDynamicAppendix({
      ...baseCtx,
      toolHistory: [{ tool: 'read_file', target: 'x', status: 'success' as const }],
    })

    const full = frozen + '\n' + consolidated + '\n' + dynamic
    assert.ok(full.startsWith(frozen + '\n' + consolidated))
  })

  it('consolidated block content is deterministic for same input', () => {
    const fields = new Map([['a', 'content-a'], ['b', 'content-b']])
    const c1 = buildConsolidatedBlock(fields)
    const c2 = buildConsolidatedBlock(fields)
    assert.equal(c1, c2)
  })

  it('consolidated block sorts fields by key for deterministic ordering', () => {
    const fields1 = new Map([['b', 'bb'], ['a', 'aa']])
    const fields2 = new Map([['a', 'aa'], ['b', 'bb']])
    assert.equal(buildConsolidatedBlock(fields1), buildConsolidatedBlock(fields2))
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`./node_modules/.bin/tsx --test src/prompt/__tests__/volatile-consolidation.test.ts`
预期：FAIL，"Module has no exported member 'buildConsolidatedBlock'"

- [ ] **步骤 3：在 volatile.ts 中新增 buildConsolidatedBlock**

在 `buildDynamicAppendix` 之前添加：

```typescript
/**
 * Render habituated fields into a <consolidated> block.
 * Fields are sorted by key for deterministic byte ordering.
 * Returns empty string if no habituated fields.
 */
export function buildConsolidatedBlock(habituatedContent: Map<string, string>): string {
  if (habituatedContent.size === 0) return ''
  const sorted = [...habituatedContent.entries()].sort(([a], [b]) => a.localeCompare(b))
  const parts = sorted.map(([, content]) => content)
  return `<consolidated>\n${parts.join('\n\n')}\n</consolidated>`
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`./node_modules/.bin/tsx --test src/prompt/__tests__/volatile-consolidation.test.ts`
预期：6/6 PASS

- [ ] **步骤 5：运行已有 volatile 测试确认无回归**

运行：`./node_modules/.bin/tsx --test src/prompt/__tests__/volatile*.test.ts`
预期：全部 PASS

- [ ] **步骤 6：Commit**

```bash
git add src/prompt/volatile.ts src/prompt/__tests__/volatile-consolidation.test.ts
git commit -m "feat(prompt): add buildConsolidatedBlock for three-zone layout"
```

---

### 任务 3：PromptEngine 集成 — tracker + 三区 buildRequest

**文件：**
- 修改：`src/prompt/engine.ts`
- 修改：`src/prompt/volatile.ts`（修改 `buildLatestTurnVolatileBlock` 签名）
- 测试：扩展 `src/prompt/__tests__/engine-cache-stability.test.ts`

这是核心集成任务。PromptEngine 需要：
1. 持有 FieldHabituationTracker
2. 每次 buildRequest 时：收集动态字段内容 → recordTurn → 区分 habituated/active → 渲染三区

- [ ] **步骤 1：编写失败的测试**

在 `src/prompt/__tests__/engine-cache-stability.test.ts` 末尾追加：

```typescript
describe('habituation: three-zone consolidation', () => {
  function createEngineWithTracker() {
    return new PromptEngine({
      model: 'test-model',
      maxTokens: 4096,
      staticCtx: { tools: [] },
      volatileCtx: {
        cwd: '/test/project',
        gitStatus: 'Current branch: main',
        rivetMd: '# Test',
      },
      habituationThreshold: 5,
    })
  }

  function simulateTurns(engine: PromptEngine, turns: number, stableDomain: string) {
    const messages: Message[] = []
    for (let t = 1; t <= turns; t++) {
      messages.push({ role: 'user', content: `msg ${t}` })
      if (t < turns) messages.push({ role: 'assistant', content: `resp ${t}` })

      // Set stable domain
      engine.setActiveDomain({ name: stableDomain, volatileBlock: 'block', motto: 'motto' })
    }
    return engine.buildRequest(messages)
  }

  it('field not promoted before threshold (4 turns with threshold=5)', () => {
    const engine = createEngineWithTracker()

    const req = simulateTurns(engine, 4, 'tianshu')

    // Latest volatile should NOT have <consolidated> (domain not yet habituated)
    const lastVol = findLastVolatile(req)
    assert.ok(!lastVol.includes('<consolidated>'),
      'Should not have consolidated block before threshold')
  })

  it('field promoted after threshold turns — consolidated block appears', () => {
    const engine = createEngineWithTracker()

    const req = simulateTurns(engine, 6, 'tianshu')

    const lastVol = findLastVolatile(req)
    assert.ok(lastVol.includes('<consolidated>'),
      'Should have consolidated block after threshold')
    assert.ok(lastVol.includes('tianshu'),
      'Consolidated block should contain habituated domain')
  })

  it('consolidated block is byte-stable after promotion', () => {
    const engine = createEngineWithTracker()

    const req6 = simulateTurns(engine, 6, 'tianshu')
    const req7 = simulateTurns(engine, 7, 'tianshu')

    const vol6 = findFirstVolatile(req6)
    const vol7 = findFirstVolatile(req7)
    // After promotion, the frozen+consolidated prefix should be the same
    // (first volatile block for historical messages)
    assert.equal(vol6, vol7,
      'Historical volatile should be stable after promotion')
  })
})

function findLastVolatile(req: { messages: Message[] }): string {
  for (let i = req.messages.length - 1; i >= 0; i--) {
    const m = req.messages[i] as { role: string; content: string }
    if (m.role === 'user' && typeof m.content === 'string' && m.content.includes('<context>')) {
      return m.content
    }
  }
  return ''
}

function findFirstVolatile(req: { messages: Message[] }): string {
  const m = req.messages[0] as { content: string }
  return m.content
}
```

- [ ] **步骤 2：修改 PromptEngineConfig 增加 habituationThreshold**

在 `src/prompt/engine.ts` 的 `PromptEngineConfig` 接口中添加：

```typescript
export interface PromptEngineConfig {
  model: string
  maxTokens: number
  staticCtx: StaticPromptContext
  volatileCtx: VolatileContext
  habituationThreshold?: number  // default: 5, set 0 to disable
}
```

- [ ] **步骤 3：在 PromptEngine constructor 中初始化 tracker**

添加 import 和成员变量：

```typescript
import { FieldHabituationTracker } from './field-habituation.js'
import { buildConsolidatedBlock } from './volatile.js'
```

在 constructor 中：

```typescript
private tracker: FieldHabituationTracker | null
private consolidatedBlock: string = ''

constructor(config: PromptEngineConfig) {
  // ...existing code...
  this.tracker = config.habituationThreshold !== 0
    ? new FieldHabituationTracker({ threshold: config.habituationThreshold ?? 5 })
    : null
}
```

- [ ] **步骤 4：修改 buildRequest — 三区渲染逻辑**

在 `buildRequest` 方法中，替换 latest-turn volatile block 构建逻辑：

```typescript
if (i === lastUserTextIdx) {
  // Collect dynamic field rendered content for habituation tracking
  const dynamicCtx = { ...this.config.volatileCtx, toolHistory, taskProgress: this.taskProgress, behaviorMirror: this.behaviorMirror, strategyShift: this.strategyShift, repairHint: this.repairHint, impactHint: this.impactHint, routingReason: this.routingReason, cerebellarHint: this.cerebellarHint, decisions: this.decisions }

  if (this.tracker) {
    // Record rendered content of each dynamic field for habituation
    const fieldValues: Record<string, string> = {}
    if (dynamicCtx.activeDomain) fieldValues['activeDomain'] = JSON.stringify(dynamicCtx.activeDomain)
    if (dynamicCtx.behaviorMirror) fieldValues['behaviorMirror'] = dynamicCtx.behaviorMirror
    if (dynamicCtx.strategyShift) fieldValues['strategyShift'] = dynamicCtx.strategyShift
    if (dynamicCtx.routingReason) fieldValues['routingReason'] = dynamicCtx.routingReason
    if (dynamicCtx.playbookLessons && dynamicCtx.playbookLessons.length > 0) {
      fieldValues['playbookLessons'] = dynamicCtx.playbookLessons.map(b => b.lesson).join('|')
    }
    this.tracker.recordTurn(fieldValues)

    // Build three-zone volatile: FROZEN + CONSOLIDATED + DYNAMIC(active only)
    const habituatedContent = this.tracker.getHabituatedContent()
    // Render habituated fields into their XML form for consolidated block
    const renderedHabituated = new Map<string, string>()
    for (const [name, content] of habituatedContent) {
      if (name === 'activeDomain') {
        const d = JSON.parse(content) as { name: string; volatileBlock: string; motto: string }
        renderedHabituated.set(name, `<star-domain name="${d.name}" motto="${d.motto}">${d.volatileBlock}</star-domain>`)
      } else if (name === 'behaviorMirror') {
        renderedHabituated.set(name, `<behavior-mirror>\n${content}\n</behavior-mirror>`)
      } else if (name === 'strategyShift') {
        renderedHabituated.set(name, `<strategy-shift>\n${content}\n</strategy-shift>`)
      } else if (name === 'routingReason') {
        renderedHabituated.set(name, `<routing-reason>\n${content}\n</routing-reason>`)
      } else if (name === 'playbookLessons') {
        renderedHabituated.set(name, `<historical-lessons>\n${content.split('|').map(l => `- ${l}`).join('\n')}\n</historical-lessons>`)
      }
    }

    const consolidated = buildConsolidatedBlock(renderedHabituated)
    if (consolidated !== this.consolidatedBlock) {
      this.consolidatedBlock = consolidated
      // Update volatile block to include consolidated
      this.volatileBlock = consolidated
        ? buildStableVolatileBlock(this.config.volatileCtx) + '\n' + consolidated
        : buildStableVolatileBlock(this.config.volatileCtx)
    }

    // Build active-only appendix (exclude habituated fields from dynamic)
    const activeCtx = { ...dynamicCtx }
    const habituated = this.tracker.getHabituated()
    if (habituated.has('activeDomain')) activeCtx.activeDomain = undefined
    if (habituated.has('behaviorMirror')) activeCtx.behaviorMirror = undefined
    if (habituated.has('strategyShift')) activeCtx.strategyShift = undefined
    if (habituated.has('routingReason')) activeCtx.routingReason = undefined
    if (habituated.has('playbookLessons')) activeCtx.playbookLessons = undefined

    const activeAppendix = buildDynamicAppendix(activeCtx)
    const freshBlock = activeAppendix
      ? this.volatileBlock + '\n' + activeAppendix
      : this.volatileBlock
    result.push({ role: 'user', content: freshBlock })
  } else {
    // No tracker — v1 behavior
    const freshBlock = buildLatestTurnVolatileBlock(dynamicCtx)
    result.push({ role: 'user', content: freshBlock })
  }
} else {
  result.push({ role: 'user', content: this.volatileBlock })
}
```

- [ ] **步骤 5：运行测试**

运行：`./node_modules/.bin/tsx --test src/prompt/__tests__/engine-cache-stability.test.ts`
预期：全部 PASS（包括新加的 habituation 测试）

- [ ] **步骤 6：运行 typecheck**

运行：`npx tsc --noEmit`
预期：0 errors

- [ ] **步骤 7：运行全量 prompt + agent 测试确认无回归**

运行：`./node_modules/.bin/tsx --test src/prompt/__tests__/*.test.ts src/api/__tests__/*.test.ts`
预期：全部 PASS

- [ ] **步骤 8：Commit**

```bash
git add src/prompt/engine.ts src/prompt/__tests__/engine-cache-stability.test.ts
git commit -m "feat(prompt): integrate FieldHabituationTracker into PromptEngine — three-zone consolidation"
```

---

### 任务 4：create-agent-config 传入 habituationThreshold

**文件：**
- 修改：`src/agent/create-agent-config.ts`

- [ ] **步骤 1：在 AgentConfigInput 中添加 habituationThreshold**

```typescript
export interface AgentConfigInput {
  // ...existing fields...
  habituationThreshold?: number
}
```

- [ ] **步骤 2：传入 PromptEngine**

```typescript
const promptEngine = new PromptEngine({
  model: model.id,
  maxTokens: model.maxTokens,
  staticCtx: { tools: input.toolDefinitions },
  volatileCtx: createVolatileSnapshot({
    cwd,
    sessionMemoryBlock: input.sessionMemoryBlock,
  }),
  habituationThreshold: input.habituationThreshold ?? 5,
})
```

- [ ] **步骤 3：typecheck + commit**

运行：`npx tsc --noEmit`

```bash
git add src/agent/create-agent-config.ts
git commit -m "feat(agent): wire habituationThreshold into PromptEngine"
```

---

### 任务 5：更新验证脚本 + 长 session 模拟

**文件：**
- 修改：`scripts/verify-cache-hit-rate.ts`

- [ ] **步骤 1：扩展脚本到 10 轮并添加 habituationThreshold**

在脚本的 engine 创建中添加 `habituationThreshold: 5`。

将 PROMPTS 数组扩展到 10 项：

```typescript
const PROMPTS = [
  '你好，介绍一下你自己',
  '读一下 package.json 的内容',
  '这个项目用了什么技术栈',
  '解释一下 src/prompt/engine.ts 的作用',
  '总结一下前面的对话',
  '读一下 src/prompt/volatile.ts',
  '分析 buildStableVolatileBlock 函数',
  '这个函数有什么问题',
  '给出改进建议',
  '总结整个分析过程',
]
```

在输出表格中新增 Consolidated 列，显示巩固区有多少字段已晋升。

- [ ] **步骤 2：Commit**

```bash
git add scripts/verify-cache-hit-rate.ts
git commit -m "test(scripts): extend cache verification to 10 turns with habituation tracking"
```

---

### 任务 6：全量测试 + typecheck

- [ ] **步骤 1：TypeScript 类型检查**

运行：`npx tsc --noEmit`
预期：0 errors

- [ ] **步骤 2：全量 prompt 测试**

运行：`./node_modules/.bin/tsx --test src/prompt/__tests__/*.test.ts`
预期：全部 PASS

- [ ] **步骤 3：全量 API 测试**

运行：`./node_modules/.bin/tsx --test src/api/__tests__/*.test.ts`
预期：全部 PASS

- [ ] **步骤 4：全量 agent 测试**

运行：`./node_modules/.bin/tsx --test src/agent/__tests__/*.test.ts`
预期：全部 PASS（除 pre-existing failures）

---

## 预期效果

| Turn | v1 hit rate | v2 预期（5-turn 阈值） | 说明 |
|------|------------|----------------------|------|
| 1 | 0% | 0% | 首轮无缓存 |
| 2 | 58% | 58% | 同 v1（无字段晋升） |
| 5 | 61% | 61% | 同 v1（刚到阈值，无字段晋升） |
| 6 | ~63% | ~68% | activeDomain + strategyShift 晋升 → 巩固区 +~500 tokens |
| 10 | ~72% | ~80% | + playbookLessons + behaviorMirror 晋升 → 巩固区 +~1.5K |
| 20 | ~80% | ~88% | 巩固区稳定，多数字段已晋升 |
| 30+ | ~83% | ~92% | 巩固区最大化，工作区仅剩 toolHistory + contextLedger |

## 自检

**1. 规格覆盖度：**
- FieldHabituationTracker ✓（任务 1）
- buildConsolidatedBlock ✓（任务 2）
- 三区渲染集成 ✓（任务 3）
- config 穿透 ✓（任务 4）
- 验证脚本 ✓（任务 5）
- 全量测试 ✓（任务 6）
- Phase 1（多 provider）：延后，不在此计划
- Phase 3（成本指标）：延后，不在此计划

**2. 占位符扫描：** 无 TODO / 待定 / 后续实现。

**3. 类型一致性：**
- `FieldHabituationTracker` 在任务 1 定义，任务 3 使用 — 构造函数 `{ threshold: number }` ✓
- `buildConsolidatedBlock` 在任务 2 定义，任务 3 使用 — 签名 `(Map<string, string>): string` ✓
- `habituationThreshold` 在任务 3 的 PromptEngineConfig 定义，任务 4 传入 ✓
- `getHabituated()`, `getActive()`, `getHabituatedContent()` 在任务 1 定义，任务 3 调用 ✓
