# Rivet P2.3 Harness Cockpit TUI 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 将 Rivet TUI 从“对话 + 工具输出列表”升级为可验收的 Harness Cockpit，让 trace、verification、approval risk、context/cache、safety/checkpoint 和 model capability 在终端中可见。

**架构：** P2.3 在现有 `AgentLoop → App callbacks → Ink components` 链路上新增结构化 Cockpit 状态层，不重构 provider、prompt engine 或 tool registry。Agent 层产生 trace、verification 和 safety 事实事件，TUI 层通过底部 Cockpit Rail 与 `/cockpit <panel>` 面板展示状态；已有 `VerificationMetadata`、`EvidenceTracker`、checkpoint v2、cache diagnostic 和 model capability card 作为地基复用。

**技术栈：** TypeScript 5.7、Node.js 22、Ink 6、React 19、node:test、tsx、tsup、DeepSeek Anthropic-compatible SSE API。

---

## 背景与约束

P2.3 规格文档位于：

`docs/superpowers/specs/2026-05-15-rivet-p2-3-harness-cockpit-design.md`

当前 P2.2 已经落地的能力：

- `src/tools/types.ts` 已定义 `VerificationMetadata`，`ToolResult` 已有 `verification?: VerificationMetadata`。
- `src/tools/run-tests.ts` 已在 `run_tests` 中返回 verification metadata。
- `src/agent/evidence.ts` 已消费 verification metadata 并生成 Evidence badge。
- `src/agent/checkpoint.ts` 已支持 checkpoint v2、安全 rollback preview、confirmation token 和 agent-owned 文件回滚。
- `src/tools/output-store.ts` 已使用安全 raw output 文件名。
- `src/model/capability.ts` 已有 `ModelCapabilityCard` 和 `recommendModelForTask()`。
- `src/tui/app.tsx` 是当前 TUI 汇流点，负责 slash command、tool card、checkpoint log、approval prompt、cache diagnostic。

P2.3 实施时不要重复创建已有 verification 基础设施；应该扩展它，让 Cockpit 复用同一份结构化事实。

实现限制：

- 不引入外部 telemetry SDK。
- 不做多 agent 编排。
- 不做 git worktree isolation。
- 不做浏览器 UI。
- 不做复杂快捷键系统；初版只使用 `/cockpit trace|verify|context|safety|model|off`。
- 不从截断后的 tool output 文本反解析测试状态；必须使用 `VerificationMetadata`。
- 不破坏已有 `/debug`、`/rollback`、`/sessions`、`/model`、`/verbose` 行为。

## 文件结构

### 新增文件

- 创建：`src/agent/trace-store.ts`  
  职责：定义 `TraceEvent`、`TraceStore` 和纯函数，用于记录 tool/model/verification/checkpoint/cache 的 start/end/status/duration，并提供最近事件列表与 doom-loop 检测。

- 创建：`src/agent/__tests__/trace-store.test.ts`  
  职责：测试 trace start/end、event cap、blocked/failed 状态、重复工具调用 fingerprint 检测。

- 创建：`src/agent/approval-risk.ts`  
  职责：定义 `ApprovalRisk` 和 `classifyApprovalRisk()`，根据工具名和输入参数生成审批风险摘要。

- 创建：`src/agent/__tests__/approval-risk.test.ts`  
  职责：测试 read/write/edit/bash/rollback/path outside project 的风险分级。

- 创建：`src/tui/cockpit/state.ts`  
  职责：定义 `CockpitState`、`CockpitPanel`、`ContextSnapshot`、`SafetySnapshot`，提供纯函数更新 trace、verification、context、safety、model 状态。

- 创建：`src/tui/cockpit/__tests__/state.test.ts`  
  职责：测试 Cockpit state 的 panel 切换、verification summary、context snapshot、safety snapshot。

- 创建：`src/tui/cockpit/cockpit-rail.tsx`  
  职责：渲染底部 Cockpit Rail，根据当前 panel 展示摘要或具体面板。

- 创建：`src/tui/cockpit/trace-panel.tsx`  
  职责：渲染最近 trace events。

- 创建：`src/tui/cockpit/verification-panel.tsx`  
  职责：渲染最近 verification run、full-suite 风险、raw output path。

- 创建：`src/tui/cockpit/context-panel.tsx`  
  职责：渲染 tokens、cache hit、compaction、fingerprint drift、last cache diagnostic。

- 创建：`src/tui/cockpit/safety-panel.tsx`  
  职责：渲染 checkpoint、rollback availability、last approval risk、doom-loop 状态。

- 创建：`src/tui/cockpit/model-panel.tsx`  
  职责：渲染当前模型能力卡；没有 card 时显示明确的 unavailable 状态。

- 创建：`src/tui/cockpit/approval-risk-card.tsx`  
  职责：替代当前简单审批框，展示工具名、风险等级、原因、目标和确认键。

- 创建：`src/tui/cockpit/__tests__/panels.test.tsx`  
  职责：用 Ink testing library 或 React renderer 测试 panel 输出文本。

### 修改文件

- 修改：`src/tools/types.ts`  
  保持已有 `VerificationMetadata`，新增通用 `ToolResultMetadata` 或扩展 `ToolResult` 的可选 `metadata` 字段，用于 trace summary；不要破坏现有 `verification` 字段。

- 修改：`src/agent/loop.ts`  
  扩展 `AgentCallbacks`，让 tool result 能把 `verification` 和 trace metadata 传到 TUI；在 tool 执行失败、审批拒绝、checkpoint 创建时发出结构化事件。

- 修改：`src/agent/evidence.ts`  
  增加 `snapshot()` 方法，返回结构化 files read/modified/verifications，供 Cockpit state 使用；保留 `buildBadge()`。

- 修改：`src/agent/context.ts`  
  如果需要，为 Cockpit 提供只读 snapshot 方法；不要让 React 直接读取可变内部 state。

- 修改：`src/tui/app.tsx`  
  引入 Cockpit state、slash command `/cockpit`、ApprovalRiskCard、CockpitRail；把 callbacks 中的工具、verification、checkpoint、cache diagnostic 转成 Cockpit 状态更新。

- 修改：`src/tui/status-bar.tsx`  
  增加 `verificationStatus` 和 `riskLevel` 的短摘要显示。

- 修改：`src/tui/log-state.ts`  
  如需展示 trace/cockpit 特殊日志，扩展类型；优先让 Cockpit 使用独立 state，避免把所有 cockpit 数据塞进 log。

- 修改：`src/model/capability.ts`  
  增加一个 `defaultCapabilityCards()` 或 `findCapabilityCard()` 纯函数，方便 ModelPanel 在没有配置系统时展示当前 model 的内置保守卡。

- 修改：`src/main.tsx`  
  如果 `App` 需要当前 model capability cards，从 main 传入；没有必要时不修改。

## 任务 1：建立 TraceStore 结构化事件地基

**文件：**
- 创建：`src/agent/trace-store.ts`
- 创建：`src/agent/__tests__/trace-store.test.ts`

- [ ] **步骤 1：编写失败的 trace store 测试**

创建 `src/agent/__tests__/trace-store.test.ts`：

```typescript
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  createTraceStore,
  startTraceEvent,
  finishTraceEvent,
  recordTraceEvent,
  getDoomLoopLevel,
  fingerprintToolCall,
  type TraceEvent,
} from '../trace-store.js'

describe('trace-store', () => {
  it('records a running event and finishes it with duration', () => {
    let store = createTraceStore(10)
    store = startTraceEvent(store, {
      id: 'tool-1',
      turn: 3,
      kind: 'tool',
      name: 'run_tests',
      startedAt: 1000,
      summary: 'npm test',
    })

    assert.equal(store.events.length, 1)
    assert.equal(store.events[0]!.status, 'running')

    store = finishTraceEvent(store, 'tool-1', {
      status: 'failed',
      endedAt: 1250,
      rawPath: '/tmp/rivet-raw/x.raw',
    })

    assert.equal(store.events[0]!.status, 'failed')
    assert.equal(store.events[0]!.durationMs, 250)
    assert.equal(store.events[0]!.rawPath, '/tmp/rivet-raw/x.raw')
  })

  it('caps events to the configured maximum', () => {
    let store = createTraceStore(2)
    const event = (id: string): TraceEvent => ({
      id,
      turn: 1,
      kind: 'tool',
      name: id,
      status: 'passed',
      startedAt: 1,
      endedAt: 2,
      durationMs: 1,
    })

    store = recordTraceEvent(store, event('a'))
    store = recordTraceEvent(store, event('b'))
    store = recordTraceEvent(store, event('c'))

    assert.deepEqual(store.events.map(e => e.id), ['b', 'c'])
  })

  it('detects repeated tool call fingerprints', () => {
    const fp = fingerprintToolCall('read_file', { file_path: 'src/a.ts' }, 'passed')
    const fingerprints = [fp, fp, fp]

    assert.equal(getDoomLoopLevel(fingerprints), 'warn')
    assert.equal(getDoomLoopLevel([...fingerprints, fp, fp]), 'blocked')
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：

```bash
npx tsx --test src/agent/__tests__/trace-store.test.ts
```

预期：FAIL，报错包含：

```text
Cannot find module '../trace-store.js'
```

- [ ] **步骤 3：实现 TraceStore 最小代码**

创建 `src/agent/trace-store.ts`：

```typescript
import { createHash } from 'node:crypto'

export type TraceEventKind = 'model' | 'tool' | 'verification' | 'checkpoint' | 'cache'
export type TraceEventStatus = 'running' | 'passed' | 'failed' | 'blocked'
export type DoomLoopLevel = 'none' | 'warn' | 'blocked'

export interface TraceEvent {
  id: string
  turn: number
  kind: TraceEventKind
  name: string
  status: TraceEventStatus
  startedAt: number
  endedAt?: number
  durationMs?: number
  summary?: string
  rawPath?: string
}

export interface TraceStore {
  maxEvents: number
  events: TraceEvent[]
  toolFingerprints: string[]
}

export function createTraceStore(maxEvents = 50): TraceStore {
  return { maxEvents, events: [], toolFingerprints: [] }
}

function capEvents(store: TraceStore, events: TraceEvent[]): TraceEvent[] {
  return events.slice(-store.maxEvents)
}

export function recordTraceEvent(store: TraceStore, event: TraceEvent): TraceStore {
  return { ...store, events: capEvents(store, [...store.events, event]) }
}

export function startTraceEvent(
  store: TraceStore,
  input: Omit<TraceEvent, 'status'>,
): TraceStore {
  return recordTraceEvent(store, { ...input, status: 'running' })
}

export function finishTraceEvent(
  store: TraceStore,
  id: string,
  update: Pick<TraceEvent, 'status' | 'endedAt'> & Partial<Pick<TraceEvent, 'summary' | 'rawPath'>>,
): TraceStore {
  const events = store.events.map(event => {
    if (event.id !== id) return event
    return {
      ...event,
      ...update,
      durationMs: Math.max(0, update.endedAt - event.startedAt),
    }
  })
  return { ...store, events }
}

export function fingerprintToolCall(
  name: string,
  input: Record<string, unknown>,
  outputClass: string,
): string {
  const payload = JSON.stringify({ name, input, outputClass }, Object.keys({ name, input, outputClass }).sort())
  return createHash('sha256').update(payload).digest('hex').slice(0, 16)
}

export function recordToolFingerprint(store: TraceStore, fingerprint: string): TraceStore {
  return { ...store, toolFingerprints: [...store.toolFingerprints, fingerprint].slice(-20) }
}

export function getDoomLoopLevel(fingerprints: string[]): DoomLoopLevel {
  const counts = new Map<string, number>()
  for (const fp of fingerprints) counts.set(fp, (counts.get(fp) ?? 0) + 1)
  const max = Math.max(0, ...counts.values())
  if (max >= 5) return 'blocked'
  if (max >= 3) return 'warn'
  return 'none'
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：

```bash
npx tsx --test src/agent/__tests__/trace-store.test.ts
```

预期：PASS，输出包含：

```text
# pass 3
# fail 0
```

- [ ] **步骤 5：Commit**

```bash
git add src/agent/trace-store.ts src/agent/__tests__/trace-store.test.ts
git commit -m "feat(agent): add trace store for cockpit"
```

## 任务 2：建立 ApprovalRisk 风险分类

**文件：**
- 创建：`src/agent/approval-risk.ts`
- 创建：`src/agent/__tests__/approval-risk.test.ts`

- [ ] **步骤 1：编写失败的 approval risk 测试**

创建 `src/agent/__tests__/approval-risk.test.ts`：

```typescript
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { classifyApprovalRisk } from '../approval-risk.js'

describe('approval-risk', () => {
  it('classifies write_file as medium with target path', () => {
    const risk = classifyApprovalRisk('write_file', { file_path: 'src/a.ts' })

    assert.equal(risk.level, 'medium')
    assert.equal(risk.destructive, false)
    assert.deepEqual(risk.targets, ['src/a.ts'])
  })

  it('classifies destructive bash commands as high', () => {
    const risk = classifyApprovalRisk('bash', { command: 'git reset --hard HEAD~1' })

    assert.equal(risk.level, 'high')
    assert.equal(risk.destructive, true)
    assert.match(risk.reason, /destructive/i)
  })

  it('classifies read-only commands as low', () => {
    const risk = classifyApprovalRisk('bash', { command: 'git status --short' })

    assert.equal(risk.level, 'low')
    assert.equal(risk.destructive, false)
  })

  it('marks outside-project paths as high', () => {
    const risk = classifyApprovalRisk('edit_file', { file_path: '../outside.ts' })

    assert.equal(risk.level, 'high')
    assert.equal(risk.outsideProject, true)
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：

```bash
npx tsx --test src/agent/__tests__/approval-risk.test.ts
```

预期：FAIL，报错包含：

```text
Cannot find module '../approval-risk.js'
```

- [ ] **步骤 3：实现风险分类代码**

创建 `src/agent/approval-risk.ts`：

```typescript
export type RiskLevel = 'low' | 'medium' | 'high'

export interface ApprovalRisk {
  toolName: string
  level: RiskLevel
  reason: string
  targets: string[]
  destructive: boolean
  outsideProject: boolean
}

function extractTargets(input: Record<string, unknown>): string[] {
  const keys = ['file_path', 'path', 'target']
  const targets: string[] = []
  for (const key of keys) {
    const value = input[key]
    if (typeof value === 'string' && value.length > 0) targets.push(value)
  }
  return [...new Set(targets)]
}

function isOutsideProject(targets: string[]): boolean {
  return targets.some(target => target.startsWith('/') || target.split('/').includes('..'))
}

function isDestructiveCommand(command: string): boolean {
  return /\b(rm\s+-|git\s+reset\s+--hard|git\s+clean\s+-|push\s+--force|killall|pkill|drop\s+table)\b/i.test(command)
}

function isReadOnlyCommand(command: string): boolean {
  return /^(git status|git diff|git log|ls\b|pwd\b|npm run typecheck|npm test\b|npx tsx --test)/.test(command.trim())
}

export function classifyApprovalRisk(toolName: string, input: Record<string, unknown>): ApprovalRisk {
  const targets = extractTargets(input)
  const outsideProject = isOutsideProject(targets)

  if (outsideProject) {
    return {
      toolName,
      level: 'high',
      reason: 'Target path appears to escape the project directory',
      targets,
      destructive: false,
      outsideProject,
    }
  }

  if (toolName === 'bash') {
    const command = typeof input.command === 'string' ? input.command : ''
    if (isDestructiveCommand(command)) {
      return { toolName, level: 'high', reason: 'Command matches destructive shell or git pattern', targets, destructive: true, outsideProject }
    }
    if (isReadOnlyCommand(command)) {
      return { toolName, level: 'low', reason: 'Command appears read-only or verification-only', targets, destructive: false, outsideProject }
    }
    return { toolName, level: 'medium', reason: 'Shell command may modify workspace or environment', targets, destructive: false, outsideProject }
  }

  if (toolName === 'write_file' || toolName === 'edit_file') {
    return { toolName, level: 'medium', reason: 'Tool modifies project files', targets, destructive: false, outsideProject }
  }

  if (toolName === 'rollback') {
    return { toolName, level: 'high', reason: 'Rollback changes workspace state', targets, destructive: true, outsideProject }
  }

  return { toolName, level: 'low', reason: 'Tool is not classified as mutating', targets, destructive: false, outsideProject }
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：

```bash
npx tsx --test src/agent/__tests__/approval-risk.test.ts
```

预期：PASS，输出包含：

```text
# pass 4
# fail 0
```

- [ ] **步骤 5：Commit**

```bash
git add src/agent/approval-risk.ts src/agent/__tests__/approval-risk.test.ts
git commit -m "feat(agent): classify tool approval risk"
```

## 任务 3：扩展 CockpitState 纯状态层

**文件：**
- 创建：`src/tui/cockpit/state.ts`
- 创建：`src/tui/cockpit/__tests__/state.test.ts`

- [ ] **步骤 1：编写失败的 CockpitState 测试**

创建 `src/tui/cockpit/__tests__/state.test.ts`：

```typescript
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  createCockpitState,
  setCockpitPanel,
  recordVerification,
  recordContextSnapshot,
  recordSafetySnapshot,
  summarizeCockpit,
} from '../state.js'

describe('cockpit state', () => {
  it('switches active panel', () => {
    const state = setCockpitPanel(createCockpitState(), 'trace')
    assert.equal(state.activePanel, 'trace')
  })

  it('records latest verification and summary', () => {
    const state = recordVerification(createCockpitState(), {
      command: 'npm test',
      status: 'failed',
      scope: 'targeted',
      exitCode: 1,
      passed: 10,
      failed: 2,
      skipped: 0,
      durationMs: 1234,
    })

    assert.equal(state.verification.runs.length, 1)
    assert.match(summarizeCockpit(state), /Verify: targeted failed/)
  })

  it('records context and safety snapshots', () => {
    let state = createCockpitState()
    state = recordContextSnapshot(state, {
      estimatedTokens: 100,
      maxTokens: 1000,
      cacheHitRate: 0.86,
      compactedThisTurn: false,
      fingerprintDrift: false,
    })
    state = recordSafetySnapshot(state, {
      rollbackAvailable: true,
      rollbackFiles: ['src/a.ts'],
      protectedDirtyFiles: true,
      doomLoopLevel: 'warn',
    })

    assert.equal(state.context?.cacheHitRate, 0.86)
    assert.equal(state.safety?.doomLoopLevel, 'warn')
    assert.match(summarizeCockpit(state), /Context: cache 86%/)
    assert.match(summarizeCockpit(state), /Safety: warn/)
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：

```bash
npx tsx --test src/tui/cockpit/__tests__/state.test.ts
```

预期：FAIL，报错包含：

```text
Cannot find module '../state.js'
```

- [ ] **步骤 3：实现 CockpitState**

创建 `src/tui/cockpit/state.ts`：

```typescript
import type { VerificationMetadata } from '../../tools/types.js'
import type { TraceStore } from '../../agent/trace-store.js'
import { createTraceStore, getDoomLoopLevel } from '../../agent/trace-store.js'
import type { ApprovalRisk } from '../../agent/approval-risk.js'
import type { ModelCapabilityCard } from '../../model/capability.js'

export type CockpitPanel = 'summary' | 'trace' | 'verify' | 'context' | 'safety' | 'model' | 'off'

export interface ContextSnapshot {
  estimatedTokens: number
  maxTokens: number
  cacheHitRate: number
  lastCacheReason?: string
  lastCacheSeverity?: 'info' | 'warn' | 'error'
  compactedThisTurn: boolean
  fingerprintDrift: boolean
}

export interface SafetySnapshot {
  checkpointHash?: string
  rollbackAvailable: boolean
  rollbackFiles: string[]
  protectedDirtyFiles: boolean
  lastApprovalRisk?: ApprovalRisk
  doomLoopLevel: 'none' | 'warn' | 'blocked'
}

export interface CockpitState {
  activePanel: CockpitPanel
  trace: TraceStore
  verification: { runs: VerificationMetadata[] }
  context: ContextSnapshot | null
  safety: SafetySnapshot | null
  modelCard: ModelCapabilityCard | null
}

export function createCockpitState(): CockpitState {
  return {
    activePanel: 'summary',
    trace: createTraceStore(50),
    verification: { runs: [] },
    context: null,
    safety: null,
    modelCard: null,
  }
}

export function setCockpitPanel(state: CockpitState, activePanel: CockpitPanel): CockpitState {
  return { ...state, activePanel }
}

export function recordVerification(state: CockpitState, run: VerificationMetadata): CockpitState {
  return { ...state, verification: { runs: [...state.verification.runs, run].slice(-20) } }
}

export function recordContextSnapshot(state: CockpitState, context: ContextSnapshot): CockpitState {
  return { ...state, context }
}

export function recordSafetySnapshot(state: CockpitState, safety: SafetySnapshot): CockpitState {
  return { ...state, safety }
}

export function recordModelCard(state: CockpitState, modelCard: ModelCapabilityCard | null): CockpitState {
  return { ...state, modelCard }
}

function verificationSummary(state: CockpitState): string {
  const last = state.verification.runs[state.verification.runs.length - 1]
  if (!last) return 'Verify: none'
  return `Verify: ${last.scope} ${last.status}`
}

function contextSummary(state: CockpitState): string {
  if (!state.context) return 'Context: none'
  return `Context: cache ${(state.context.cacheHitRate * 100).toFixed(0)}%`
}

function safetySummary(state: CockpitState): string {
  const level = state.safety?.doomLoopLevel ?? getDoomLoopLevel(state.trace.toolFingerprints)
  if (!state.safety) return `Safety: ${level}`
  if (state.safety.lastApprovalRisk?.level === 'high') return 'Safety: high'
  return `Safety: ${level}`
}

export function summarizeCockpit(state: CockpitState): string {
  const toolCount = state.trace.events.filter(e => e.kind === 'tool').length
  return [
    `Trace: ${toolCount} tools`,
    verificationSummary(state),
    contextSummary(state),
    safetySummary(state),
  ].join(' | ')
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：

```bash
npx tsx --test src/tui/cockpit/__tests__/state.test.ts
```

预期：PASS，输出包含：

```text
# pass 3
# fail 0
```

- [ ] **步骤 5：Commit**

```bash
git add src/tui/cockpit/state.ts src/tui/cockpit/__tests__/state.test.ts
git commit -m "feat(tui): add cockpit state model"
```

## 任务 4：实现 Cockpit 面板组件

**文件：**
- 创建：`src/tui/cockpit/cockpit-rail.tsx`
- 创建：`src/tui/cockpit/trace-panel.tsx`
- 创建：`src/tui/cockpit/verification-panel.tsx`
- 创建：`src/tui/cockpit/context-panel.tsx`
- 创建：`src/tui/cockpit/safety-panel.tsx`
- 创建：`src/tui/cockpit/model-panel.tsx`
- 创建：`src/tui/cockpit/approval-risk-card.tsx`
- 创建：`src/tui/cockpit/__tests__/panels.test.tsx`

- [ ] **步骤 1：编写失败的 panel render 测试**

创建 `src/tui/cockpit/__tests__/panels.test.tsx`：

```typescript
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import React from 'react'
import { render } from 'ink-testing-library'
import { CockpitRail } from '../cockpit-rail.js'
import { ApprovalRiskCard } from '../approval-risk-card.js'
import { createCockpitState, recordContextSnapshot, recordSafetySnapshot, recordVerification, setCockpitPanel } from '../state.js'

describe('cockpit panels', () => {
  it('renders summary rail', () => {
    const state = recordVerification(createCockpitState(), {
      command: 'npm test',
      status: 'passed',
      scope: 'full',
      exitCode: 0,
      passed: 12,
      failed: 0,
      skipped: 0,
      durationMs: 900,
    })

    const { lastFrame } = render(<CockpitRail state={state} />)
    assert.match(lastFrame() ?? '', /Trace:/)
    assert.match(lastFrame() ?? '', /Verify: full passed/)
  })

  it('renders verification panel details', () => {
    let state = createCockpitState()
    state = setCockpitPanel(state, 'verify')
    state = recordVerification(state, {
      command: 'npx tsx --test src/a.test.ts',
      status: 'failed',
      scope: 'targeted',
      exitCode: 1,
      passed: 10,
      failed: 2,
      skipped: 0,
      durationMs: 1234,
    })

    const { lastFrame } = render(<CockpitRail state={state} />)
    assert.match(lastFrame() ?? '', /Verification/)
    assert.match(lastFrame() ?? '', /targeted failed/)
    assert.match(lastFrame() ?? '', /full suite not run/)
  })

  it('renders context and safety panels', () => {
    let state = setCockpitPanel(createCockpitState(), 'safety')
    state = recordContextSnapshot(state, {
      estimatedTokens: 200,
      maxTokens: 1000,
      cacheHitRate: 0.5,
      compactedThisTurn: false,
      fingerprintDrift: false,
    })
    state = recordSafetySnapshot(state, {
      rollbackAvailable: true,
      rollbackFiles: ['src/a.ts'],
      protectedDirtyFiles: true,
      doomLoopLevel: 'warn',
    })

    const { lastFrame } = render(<CockpitRail state={state} />)
    assert.match(lastFrame() ?? '', /Safety/)
    assert.match(lastFrame() ?? '', /src\/a.ts/)
  })

  it('renders approval risk card', () => {
    const { lastFrame } = render(<ApprovalRiskCard risk={{
      toolName: 'bash',
      level: 'high',
      reason: 'Command matches destructive shell or git pattern',
      targets: [],
      destructive: true,
      outsideProject: false,
    }} />)

    assert.match(lastFrame() ?? '', /Tool Approval/)
    assert.match(lastFrame() ?? '', /Risk: high/)
    assert.match(lastFrame() ?? '', /\[y\] approve/)
  })
})
```

如果 `ink-testing-library` 不在依赖中，先确认 `package.json`。若缺失，执行本任务的智能体应优先添加 devDependency：

```bash
npm install -D ink-testing-library
```

然后把 `package.json` 和 `package-lock.json` 纳入本任务提交。

- [ ] **步骤 2：运行测试验证失败**

运行：

```bash
npx tsx --test src/tui/cockpit/__tests__/panels.test.tsx
```

预期：FAIL，报错包含：

```text
Cannot find module '../cockpit-rail.js'
```

如果先缺少 `ink-testing-library`，预期失败是：

```text
Cannot find package 'ink-testing-library'
```

此时先安装该 devDependency，再重新运行测试确认失败点转为缺少 panel 模块。

- [ ] **步骤 3：实现 TracePanel**

创建 `src/tui/cockpit/trace-panel.tsx`：

```tsx
import { Box, Text } from 'ink'
import type { TraceEvent } from '../../agent/trace-store.js'

function statusIcon(status: TraceEvent['status']): string {
  if (status === 'passed') return '✓'
  if (status === 'failed') return '✗'
  if (status === 'blocked') return '■'
  return '…'
}

export function TracePanel({ events }: { events: TraceEvent[] }) {
  const recent = events.slice(-8)
  return (
    <Box flexDirection="column" paddingX={1} borderStyle="single" borderColor="gray">
      <Text bold color="cyan">Trace</Text>
      {recent.length === 0 ? <Text dimColor>No trace events yet</Text> : recent.map(event => (
        <Text key={event.id}>
          #{event.turn} {event.name} {statusIcon(event.status)}{event.durationMs !== undefined ? ` ${event.durationMs}ms` : ''}{event.rawPath ? ` raw:${event.rawPath}` : ''}
        </Text>
      ))}
    </Box>
  )
}
```

- [ ] **步骤 4：实现 VerificationPanel**

创建 `src/tui/cockpit/verification-panel.tsx`：

```tsx
import { Box, Text } from 'ink'
import type { VerificationMetadata } from '../../tools/types.js'

export function VerificationPanel({ runs }: { runs: VerificationMetadata[] }) {
  const last = runs[runs.length - 1]
  return (
    <Box flexDirection="column" paddingX={1} borderStyle="single" borderColor={last?.status === 'failed' ? 'red' : 'green'}>
      <Text bold color="cyan">Verification</Text>
      {!last ? (
        <Text dimColor>Status: unverified</Text>
      ) : (
        <>
          <Text>Last: {last.scope} {last.status}</Text>
          <Text>Command: {last.command}</Text>
          <Text>Result: {last.passed} passed, {last.failed} failed, {last.skipped} skipped</Text>
          {last.scope === 'targeted' && <Text color="yellow">Risk: full suite not run</Text>}
        </>
      )}
    </Box>
  )
}
```

- [ ] **步骤 5：实现 ContextPanel、SafetyPanel、ModelPanel、ApprovalRiskCard**

创建 `src/tui/cockpit/context-panel.tsx`：

```tsx
import { Box, Text } from 'ink'
import type { ContextSnapshot } from './state.js'

export function ContextPanel({ context }: { context: ContextSnapshot | null }) {
  return (
    <Box flexDirection="column" paddingX={1} borderStyle="single" borderColor="gray">
      <Text bold color="cyan">Context</Text>
      {!context ? <Text dimColor>No context snapshot yet</Text> : (
        <>
          <Text>Tokens: {context.estimatedTokens.toLocaleString()} / {context.maxTokens.toLocaleString()}</Text>
          <Text>Cache: {(context.cacheHitRate * 100).toFixed(1)}%</Text>
          <Text>Compaction: {context.compactedThisTurn ? 'ran this turn' : 'not needed'}</Text>
          <Text>Drift: {context.fingerprintDrift ? 'detected' : 'none'}</Text>
          {context.lastCacheReason && <Text>Last miss: {context.lastCacheReason}</Text>}
        </>
      )}
    </Box>
  )
}
```

创建 `src/tui/cockpit/safety-panel.tsx`：

```tsx
import { Box, Text } from 'ink'
import type { SafetySnapshot } from './state.js'

export function SafetyPanel({ safety }: { safety: SafetySnapshot | null }) {
  return (
    <Box flexDirection="column" paddingX={1} borderStyle="single" borderColor={safety?.doomLoopLevel === 'blocked' ? 'red' : 'yellow'}>
      <Text bold color="cyan">Safety</Text>
      {!safety ? <Text dimColor>No safety snapshot yet</Text> : (
        <>
          <Text>Checkpoint: {safety.checkpointHash ?? 'none'}</Text>
          <Text>Rollback: {safety.rollbackAvailable ? `${safety.rollbackFiles.length} agent-owned files` : 'not available'}</Text>
          <Text>Protected dirty files: {safety.protectedDirtyFiles ? 'yes' : 'no'}</Text>
          <Text>Doom-loop: {safety.doomLoopLevel}</Text>
          {safety.lastApprovalRisk && <Text>Last approval: {safety.lastApprovalRisk.toolName} / {safety.lastApprovalRisk.level}</Text>}
        </>
      )}
    </Box>
  )
}
```

创建 `src/tui/cockpit/model-panel.tsx`：

```tsx
import { Box, Text } from 'ink'
import type { ModelCapabilityCard } from '../../model/capability.js'

export function ModelPanel({ card }: { card: ModelCapabilityCard | null }) {
  return (
    <Box flexDirection="column" paddingX={1} borderStyle="single" borderColor="gray">
      <Text bold color="cyan">Model Capability</Text>
      {!card ? <Text dimColor>No model capability card configured</Text> : (
        <>
          <Text>{card.model}</Text>
          <Text>Tool use: {card.toolUseReliability.toFixed(2)}</Text>
          <Text>Edit success: {card.editSuccessRate.toFixed(2)}</Text>
          <Text>Test repair: {card.testRepairRate.toFixed(2)}</Text>
          <Text>Recommended: {card.recommendedTasks.join(', ')}</Text>
        </>
      )}
    </Box>
  )
}
```

创建 `src/tui/cockpit/approval-risk-card.tsx`：

```tsx
import { Box, Text } from 'ink'
import type { ApprovalRisk } from '../../agent/approval-risk.js'

export function ApprovalRiskCard({ risk }: { risk: ApprovalRisk }) {
  const color = risk.level === 'high' ? 'red' : risk.level === 'medium' ? 'yellow' : 'green'
  return (
    <Box flexDirection="column" paddingX={2} borderStyle="single" borderColor={color}>
      <Text bold color={color}>Tool Approval</Text>
      <Text>Tool: {risk.toolName}</Text>
      <Text>Risk: {risk.level}</Text>
      <Text>Reason: {risk.reason}</Text>
      <Text>Targets: {risk.targets.length > 0 ? risk.targets.join(', ') : 'unknown'}</Text>
      <Text>Destructive: {risk.destructive ? 'possible' : 'no'}</Text>
      <Text> [y] approve  [n] deny </Text>
    </Box>
  )
}
```

- [ ] **步骤 6：实现 CockpitRail 组合组件**

创建 `src/tui/cockpit/cockpit-rail.tsx`：

```tsx
import { Box, Text } from 'ink'
import type { CockpitState } from './state.js'
import { summarizeCockpit } from './state.js'
import { TracePanel } from './trace-panel.js'
import { VerificationPanel } from './verification-panel.js'
import { ContextPanel } from './context-panel.js'
import { SafetyPanel } from './safety-panel.js'
import { ModelPanel } from './model-panel.js'

export function CockpitRail({ state }: { state: CockpitState }) {
  if (state.activePanel === 'off') return null
  if (state.activePanel === 'trace') return <TracePanel events={state.trace.events} />
  if (state.activePanel === 'verify') return <VerificationPanel runs={state.verification.runs} />
  if (state.activePanel === 'context') return <ContextPanel context={state.context} />
  if (state.activePanel === 'safety') return <SafetyPanel safety={state.safety} />
  if (state.activePanel === 'model') return <ModelPanel card={state.modelCard} />

  return (
    <Box paddingX={1} borderStyle="single" borderColor="gray">
      <Text>{summarizeCockpit(state)}</Text>
    </Box>
  )
}
```

- [ ] **步骤 7：运行 panel 测试验证通过**

运行：

```bash
npx tsx --test src/tui/cockpit/__tests__/panels.test.tsx
```

预期：PASS，输出包含：

```text
# pass 4
# fail 0
```

- [ ] **步骤 8：Commit**

```bash
git add src/tui/cockpit/cockpit-rail.tsx src/tui/cockpit/trace-panel.tsx src/tui/cockpit/verification-panel.tsx src/tui/cockpit/context-panel.tsx src/tui/cockpit/safety-panel.tsx src/tui/cockpit/model-panel.tsx src/tui/cockpit/approval-risk-card.tsx src/tui/cockpit/__tests__/panels.test.tsx package.json package-lock.json
git commit -m "feat(tui): add cockpit rail panels"
```

## 任务 5：把 ToolResult metadata 和 AgentLoop callbacks 接入 Cockpit

**文件：**
- 修改：`src/tools/types.ts`
- 修改：`src/agent/loop.ts`
- 修改：`src/agent/__tests__/loop.test.ts`

- [ ] **步骤 1：编写失败的 AgentLoop metadata 传播测试**

在 `src/agent/__tests__/loop.test.ts` 中新增测试：

```typescript
it('passes verification metadata to tool result callback', async () => {
  const client = mockClientWithToolUse('run_tests', { filter: 'src/agent/loop.test.ts' })
  const registry = new ToolRegistry()
  registry.register({
    definition: { name: 'run_tests', description: 'test', input_schema: { type: 'object' } },
    async execute() {
      return {
        content: '1 passed, 0 failed, 0 skipped',
        isError: false,
        verification: {
          command: 'npx tsx --test src/agent/loop.test.ts',
          status: 'passed',
          scope: 'targeted',
          exitCode: 0,
          passed: 1,
          failed: 0,
          skipped: 0,
          durationMs: 12,
        },
      }
    },
    requiresApproval: () => false,
    isConcurrencySafe: () => false,
    isEnabled: () => true,
  })

  const loop = new AgentLoop({
    client,
    promptEngine: makePromptEngine(),
    toolRegistry: registry,
    maxTurns: 3,
    contextWindow: 100_000,
    compact: { enabled: false, threshold: 0.8, keepRecent: 10 },
  }, new SessionContext())

  const verifications: unknown[] = []
  await loop.run('run tests', makeCallbacks({
    onToolResult: (_id, _name, _result, _isError, _rawPath, metadata) => {
      if (metadata?.verification) verifications.push(metadata.verification)
    },
  }))

  assert.equal(verifications.length, 1)
})
```

如果当前 `loop.test.ts` 没有 `mockClientWithToolUse`、`makePromptEngine`、`makeCallbacks` helpers，就在该测试文件顶部或测试附近添加最小 helper，复用现有 mock client 风格。不要引入真实 API。

- [ ] **步骤 2：运行测试验证失败**

运行：

```bash
npx tsx --test src/agent/__tests__/loop.test.ts
```

预期：FAIL，TypeScript 或 runtime 报错表明 `onToolResult` 第六个参数不存在或 metadata 未传递。

- [ ] **步骤 3：扩展 ToolResult 回调类型**

修改 `src/agent/loop.ts` 中 `AgentCallbacks`：

```typescript
export interface ToolResultCallbackMetadata {
  verification?: VerificationMetadata
}

export interface AgentCallbacks {
  onTextDelta: (text: string) => void
  onThinkingDelta: (thinking: string) => void
  onToolUse: (id: string, name: string, input: Record<string, unknown>) => void
  onToolResult: (
    id: string,
    name: string,
    result: string,
    isError?: boolean,
    rawPath?: string,
    metadata?: ToolResultCallbackMetadata,
  ) => void
  onTurnComplete: (usage: Partial<Usage>, turnNumber: number) => void
  onError: (error: Error) => void
  onAbort: () => void
  onApprovalRequired: (id: string, name: string, input: Record<string, unknown>) => Promise<boolean>
  onCheckpoint?: (hash: string) => void
}
```

同时在文件顶部引入类型：

```typescript
import type { ToolCallParams, VerificationMetadata } from '../tools/types.js'
```

- [ ] **步骤 4：把 verification 传给 TUI callback**

修改 `src/agent/loop.ts` 工具执行后回调：

```typescript
const result = await this.config.toolRegistry.execute(tu.name, params)
callbacks.onToolResult(tu.id, tu.name, result.content, result.isError ?? false, result.rawPath, {
  verification: result.verification,
})
```

对 streaming chunk 保持原样：

```typescript
onOutput: (chunk) => {
  callbacks.onToolResult(tu.id, tu.name, chunk)
},
```

拒绝审批和 catch error 路径不传 verification。

- [ ] **步骤 5：运行测试验证通过**

运行：

```bash
npx tsx --test src/agent/__tests__/loop.test.ts
```

预期：PASS，输出包含：

```text
# fail 0
```

- [ ] **步骤 6：Commit**

```bash
git add src/agent/loop.ts src/agent/__tests__/loop.test.ts
git commit -m "feat(agent): pass tool metadata to callbacks"
```

## 任务 6：在 App 中接入 Cockpit state 和 `/cockpit` 命令

**文件：**
- 修改：`src/tui/app.tsx`
- 修改：`src/tui/status-bar.tsx`
- 创建或修改：`src/tui/__tests__/app-cockpit.test.tsx`

- [ ] **步骤 1：编写失败的 status bar 测试**

如果项目已有 TUI 测试框架，把测试放到 `src/tui/__tests__/app-cockpit.test.tsx`；如果没有，先创建此文件：

```tsx
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import React from 'react'
import { render } from 'ink-testing-library'
import { StatusBar } from '../status-bar.js'

describe('cockpit status bar', () => {
  it('renders verification and risk summary', () => {
    const { lastFrame } = render(
      <StatusBar
        model="deepseek-v4"
        cacheHitRate={0.8}
        totalCost="0.01"
        currentTokens={100}
        maxTokens={1000}
        verificationStatus="failed"
        riskLevel="high"
      />,
    )

    assert.match(lastFrame() ?? '', /verify:failed/)
    assert.match(lastFrame() ?? '', /risk:high/)
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：

```bash
npx tsx --test src/tui/__tests__/app-cockpit.test.tsx
```

预期：FAIL，TypeScript 报错包含：

```text
Property 'verificationStatus' does not exist
```

- [ ] **步骤 3：扩展 StatusBar props**

修改 `src/tui/status-bar.tsx`：

```tsx
interface StatusBarProps {
  model: string
  cacheHitRate: number
  totalCost: string
  currentTokens: number
  maxTokens: number
  verificationStatus?: 'none' | 'passed' | 'failed' | 'blocked'
  riskLevel?: 'none' | 'low' | 'medium' | 'high'
}
```

修改组件签名：

```tsx
export const StatusBar = memo(function StatusBar({
  model,
  cacheHitRate,
  totalCost,
  currentTokens,
  maxTokens,
  verificationStatus = 'none',
  riskLevel = 'none',
}: StatusBarProps) {
```

在左侧 Box 中加入：

```tsx
<Text color={verificationStatus === 'failed' || verificationStatus === 'blocked' ? 'red' : verificationStatus === 'passed' ? 'green' : 'gray'}>
  verify:{verificationStatus}
</Text>
<Text color={riskLevel === 'high' ? 'red' : riskLevel === 'medium' ? 'yellow' : riskLevel === 'low' ? 'green' : 'gray'}>
  risk:{riskLevel}
</Text>
```

- [ ] **步骤 4：在 App 中创建 Cockpit state**

修改 `src/tui/app.tsx` imports：

```typescript
import { CockpitRail } from './cockpit/cockpit-rail.js'
import {
  createCockpitState,
  recordContextSnapshot,
  recordModelCard,
  recordSafetySnapshot,
  recordVerification,
  setCockpitPanel,
  type CockpitPanel,
} from './cockpit/state.js'
import { classifyApprovalRisk, type ApprovalRisk } from '../agent/approval-risk.js'
import { finishTraceEvent, recordToolFingerprint, startTraceEvent, fingerprintToolCall } from '../agent/trace-store.js'
```

修改 `PendingApproval`：

```typescript
interface PendingApproval {
  id: string
  name: string
  input: Record<string, unknown>
  risk: ApprovalRisk
  resolve: (approved: boolean) => void
}
```

在 `App` 内新增 state：

```typescript
const [cockpit, setCockpit] = useState(() => createCockpitState())
```

- [ ] **步骤 5：实现 `/cockpit` slash command**

在 `src/tui/app.tsx` slash command switch 中新增 case，放在 `/debug` 附近：

```typescript
case '/cockpit': {
  const panel = (parts[1] ?? 'summary') as CockpitPanel
  const allowed: CockpitPanel[] = ['summary', 'trace', 'verify', 'context', 'safety', 'model', 'off']
  if (!allowed.includes(panel)) {
    addLog({ type: 'text', content: 'Usage: /cockpit [summary|trace|verify|context|safety|model|off]' })
  } else {
    setCockpit(prev => setCockpitPanel(prev, panel))
    addLog({ type: 'text', content: `Cockpit panel: ${panel}` })
  }
  setIsStreaming(false)
  return
}
```

- [ ] **步骤 6：把 callbacks 写入 Cockpit state**

在 `onToolUse` 中：

```typescript
onToolUse: (id, name, input) => {
  addLog({ type: 'tool', id, content: `Calling ${name}...`, toolName: name })
  setCockpit(prev => startTraceEvent(prev.trace, {
    id,
    turn: session.getTurnCount(),
    kind: 'tool',
    name,
    startedAt: Date.now(),
    summary: JSON.stringify(input).slice(0, 120),
  }) && { ...prev, trace: startTraceEvent(prev.trace, {
    id,
    turn: session.getTurnCount(),
    kind: 'tool',
    name,
    startedAt: Date.now(),
    summary: JSON.stringify(input).slice(0, 120),
  }) })
},
```

为了避免重复调用 `startTraceEvent`，实际写入时使用局部变量：

```typescript
setCockpit(prev => {
  const trace = startTraceEvent(prev.trace, {
    id,
    turn: session.getTurnCount(),
    kind: 'tool',
    name,
    startedAt: Date.now(),
    summary: JSON.stringify(input).slice(0, 120),
  })
  return { ...prev, trace }
})
```

在 `onToolResult` 最终结果分支：

```typescript
onToolResult: (id, name, result, isError, rawPath, metadata) => {
  if (isError === undefined) {
    const prev = toolOutputAccumRef.current.get(id) || ''
    toolOutputAccumRef.current.set(id, prev + result)
    scheduleToolFlush(id, name)
  } else {
    toolOutputAccumRef.current.delete(id)
    toolNamesRef.current.delete(id)
    updateLogEntry(id, name, result, isError, rawPath)
    setCockpit(prev => {
      let trace = finishTraceEvent(prev.trace, id, {
        status: isError ? 'failed' : 'passed',
        endedAt: Date.now(),
        rawPath,
      })
      trace = recordToolFingerprint(trace, fingerprintToolCall(name, {}, isError ? 'failed' : 'passed'))
      const next = { ...prev, trace }
      return metadata?.verification ? recordVerification(next, metadata.verification) : next
    })
  }
},
```

如果需要准确 input fingerprint，可在 `onToolUse` 中把 input 存入 ref：

```typescript
const toolInputsRef = useRef<Map<string, Record<string, unknown>>>(new Map())
```

`onToolUse` 设置，`onToolResult` 读取后删除。

- [ ] **步骤 7：在 onTurnComplete 写入 ContextSnapshot**

在 `onTurnComplete` 现有 cache diagnostic 后增加：

```typescript
const debugInfo = agent.getDebugInfo()
const latestDiag = diagnoseCacheMiss(
  session.getCacheHistory(),
  turnNumber,
  debugInfo.drift,
  session.wasCompactedAt(turnNumber),
)
setCockpit(prev => recordContextSnapshot(prev, {
  estimatedTokens: session.getEstimatedTokens(),
  maxTokens,
  cacheHitRate: session.getCacheHitRate(),
  lastCacheReason: latestDiag?.reason,
  lastCacheSeverity: latestDiag?.severity,
  compactedThisTurn: session.wasCompactedAt(turnNumber),
  fingerprintDrift: !!debugInfo.drift,
}))
```

避免重复调用 `diagnoseCacheMiss()` 两次：把现有 `diag` 变量复用。

- [ ] **步骤 8：渲染 StatusBar、ApprovalRiskCard、CockpitRail**

修改 StatusBar 调用：

```tsx
<StatusBar
  model={model}
  cacheHitRate={cacheHitRate}
  totalCost={cost.toFixed(2)}
  currentTokens={currentTokens}
  maxTokens={maxTokens}
  verificationStatus={cockpit.verification.runs[cockpit.verification.runs.length - 1]?.status ?? 'none'}
  riskLevel={cockpit.safety?.lastApprovalRisk?.level ?? 'none'}
/>
```

替换 pending approval UI：

```tsx
{pendingApproval && (
  <ApprovalRiskCard risk={pendingApproval.risk} />
)}
```

在 InputBar 前渲染 CockpitRail：

```tsx
<CockpitRail state={cockpit} />
<InputBar onSubmit={handleSubmit} disabled={isStreaming || !!pendingApproval} />
```

- [ ] **步骤 9：在 approval callback 中设置 risk**

修改 `onApprovalRequired`：

```typescript
onApprovalRequired: async (id, name, input) => {
  const risk = classifyApprovalRisk(name, input)
  setCockpit(prev => recordSafetySnapshot(prev, {
    rollbackAvailable: prev.safety?.rollbackAvailable ?? false,
    rollbackFiles: prev.safety?.rollbackFiles ?? [],
    protectedDirtyFiles: prev.safety?.protectedDirtyFiles ?? false,
    checkpointHash: prev.safety?.checkpointHash,
    doomLoopLevel: prev.safety?.doomLoopLevel ?? 'none',
    lastApprovalRisk: risk,
  }))
  return new Promise<boolean>((resolve) => {
    setPendingApproval({ id, name, input, risk, resolve })
  })
},
```

- [ ] **步骤 10：运行测试验证通过**

运行：

```bash
npx tsx --test src/tui/__tests__/app-cockpit.test.tsx
npm run typecheck
```

预期：测试 PASS，typecheck PASS。

- [ ] **步骤 11：Commit**

```bash
git add src/tui/app.tsx src/tui/status-bar.tsx src/tui/__tests__/app-cockpit.test.tsx
git commit -m "feat(tui): wire cockpit rail into app"
```

## 任务 7：接入 checkpoint、rollback 和 safety snapshot

**文件：**
- 修改：`src/agent/checkpoint.ts`
- 修改：`src/tui/app.tsx`
- 修改：`src/agent/__tests__/checkpoint.test.ts`
- 修改或创建：`src/tui/cockpit/__tests__/safety-panel.test.tsx`

- [ ] **步骤 1：编写失败的 rollback preview 文件列表测试**

如果 `getRollbackPreview()` 当前只返回 text 和 token，需要让 SafetyPanel 获取结构化文件列表。先在 `src/agent/__tests__/checkpoint.test.ts` 新增测试：

```typescript
it('includes agent-owned rollback files in preview metadata', async () => {
  const repo = makeTempGitRepo()
  try {
    await createCheckpoint(repo, 'auto')
    writeFileSync(join(repo, 'agent.txt'), 'agent change')
    recordAgentTouchedFile(repo, 'agent.txt')

    const preview = await getRollbackPreview(repo)

    assert.ok(preview)
    assert.deepEqual(preview.files, ['agent.txt'])
    assert.equal(preview.protectedDirtyFiles, false)
  } finally {
    cleanupRepo(repo)
  }
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：

```bash
npx tsx --test src/agent/__tests__/checkpoint.test.ts
```

预期：FAIL，TypeScript 报错包含：

```text
Property 'files' does not exist on type 'RollbackPreview'
```

- [ ] **步骤 3：扩展 RollbackPreview**

修改 `src/agent/checkpoint.ts`：

```typescript
export interface RollbackPreview {
  text: string
  confirmationToken: string
  files: string[]
  protectedDirtyFiles: boolean
}
```

修改 `getRollbackPreview()` return：

```typescript
return {
  text,
  confirmationToken: token,
  files: rollbackFiles,
  protectedDirtyFiles: data.preExistingDirtyFiles.length > 0 || data.preExistingUntrackedFiles.length > 0,
}
```

- [ ] **步骤 4：在 App rollback 命令写入 safety snapshot**

修改 `src/tui/app.tsx` `/rollback` preview 分支：

```typescript
const preview = await getRollbackPreview(process.cwd())
if (preview) {
  rollbackTokenRef.current = preview.confirmationToken
  setCockpit(prev => recordSafetySnapshot(prev, {
    rollbackAvailable: true,
    rollbackFiles: preview.files,
    protectedDirtyFiles: preview.protectedDirtyFiles,
    checkpointHash: prev.safety?.checkpointHash,
    lastApprovalRisk: prev.safety?.lastApprovalRisk,
    doomLoopLevel: prev.safety?.doomLoopLevel ?? 'none',
  }))
  addLog({ type: 'text', content: `⚠️  Agent-owned changes to revert:\n${preview.text}\n\nType /rollback confirm to proceed.` })
} else {
  setCockpit(prev => recordSafetySnapshot(prev, {
    rollbackAvailable: false,
    rollbackFiles: [],
    protectedDirtyFiles: false,
    checkpointHash: prev.safety?.checkpointHash,
    lastApprovalRisk: prev.safety?.lastApprovalRisk,
    doomLoopLevel: prev.safety?.doomLoopLevel ?? 'none',
  }))
  addLog({ type: 'text', content: 'No agent-owned changes to rollback.' })
}
```

修改 `onCheckpoint`：

```typescript
onCheckpoint: (hash) => {
  addLog({ type: 'checkpoint', content: `Checkpoint saved: ${hash.slice(0, 7)} — /rollback to restore` })
  setCockpit(prev => recordSafetySnapshot(prev, {
    rollbackAvailable: prev.safety?.rollbackAvailable ?? false,
    rollbackFiles: prev.safety?.rollbackFiles ?? [],
    protectedDirtyFiles: prev.safety?.protectedDirtyFiles ?? false,
    checkpointHash: hash.slice(0, 7),
    lastApprovalRisk: prev.safety?.lastApprovalRisk,
    doomLoopLevel: prev.safety?.doomLoopLevel ?? 'none',
  }))
},
```

- [ ] **步骤 5：运行 checkpoint 测试和 typecheck**

运行：

```bash
npx tsx --test src/agent/__tests__/checkpoint.test.ts
npm run typecheck
```

预期：全部 PASS。

- [ ] **步骤 6：Commit**

```bash
git add src/agent/checkpoint.ts src/agent/__tests__/checkpoint.test.ts src/tui/app.tsx
git commit -m "feat(tui): expose checkpoint state in cockpit"
```

## 任务 8：接入 ModelPanel 的能力卡数据

**文件：**
- 修改：`src/model/capability.ts`
- 修改：`src/model/__tests__/capability.test.ts`
- 修改：`src/tui/app.tsx`
- 修改：`src/tui/cockpit/model-panel.tsx`

- [ ] **步骤 1：编写失败的 capability lookup 测试**

修改 `src/model/__tests__/capability.test.ts`，新增：

```typescript
import { findCapabilityCard } from '../capability.js'

it('finds a built-in capability card by model id prefix', () => {
  const card = findCapabilityCard('deepseek-v4')

  assert.ok(card)
  assert.equal(card.model, 'deepseek-v4')
  assert.ok(card.recommendedTasks.includes('code_edit'))
})

it('returns null for unknown models', () => {
  assert.equal(findCapabilityCard('unknown-model'), null)
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：

```bash
npx tsx --test src/model/__tests__/capability.test.ts
```

预期：FAIL，报错包含：

```text
Module '../capability.js' has no exported member 'findCapabilityCard'
```

- [ ] **步骤 3：实现内置能力卡 lookup**

修改 `src/model/capability.ts`：

```typescript
const BUILTIN_CAPABILITY_CARDS: ModelCapabilityCard[] = [
  {
    model: 'deepseek-v4',
    toolUseReliability: 0.78,
    jsonStability: 0.76,
    editSuccessRate: 0.72,
    testRepairRate: 0.62,
    contextWindow: 1_000_000,
    cacheEconomics: 'strong',
    recommendedTasks: ['repo_summarization', 'code_edit', 'compaction'],
  },
]

export function defaultCapabilityCards(): ModelCapabilityCard[] {
  return [...BUILTIN_CAPABILITY_CARDS]
}

export function findCapabilityCard(model: string, cards = BUILTIN_CAPABILITY_CARDS): ModelCapabilityCard | null {
  return cards.find(card => model === card.model || model.startsWith(card.model)) ?? null
}
```

- [ ] **步骤 4：在 App 初始化 model card**

修改 `src/tui/app.tsx` import：

```typescript
import { findCapabilityCard } from '../model/capability.js'
```

在 `App` 初始化后增加 effect：

```typescript
useEffect(() => {
  setCockpit(prev => recordModelCard(prev, findCapabilityCard(model)))
}, [model])
```

确保 `recordModelCard` 已从 `./cockpit/state.js` import。

- [ ] **步骤 5：运行测试验证通过**

运行：

```bash
npx tsx --test src/model/__tests__/capability.test.ts
npm run typecheck
```

预期：全部 PASS。

- [ ] **步骤 6：Commit**

```bash
git add src/model/capability.ts src/model/__tests__/capability.test.ts src/tui/app.tsx
git commit -m "feat(model): expose capability card to cockpit"
```

## 任务 9：把 EvidenceTracker 暴露为结构化 snapshot

**文件：**
- 修改：`src/agent/evidence.ts`
- 修改：`src/agent/__tests__/loop.test.ts` 或创建：`src/agent/__tests__/evidence.test.ts`

- [ ] **步骤 1：编写失败的 evidence snapshot 测试**

创建 `src/agent/__tests__/evidence.test.ts`：

```typescript
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { EvidenceTracker } from '../evidence.js'

describe('EvidenceTracker snapshot', () => {
  it('returns structured files and verifications', () => {
    const evidence = new EvidenceTracker()
    evidence.trackFileRead('src/a.ts')
    evidence.trackFileModified('src/b.ts')
    evidence.trackVerification({
      command: 'npm test',
      status: 'passed',
      scope: 'full',
      exitCode: 0,
      passed: 12,
      failed: 0,
      skipped: 0,
      durationMs: 100,
    })

    const snapshot = evidence.snapshot()

    assert.deepEqual(snapshot.filesRead, ['src/a.ts'])
    assert.deepEqual(snapshot.filesModified, ['src/b.ts'])
    assert.equal(snapshot.verifications.length, 1)
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：

```bash
npx tsx --test src/agent/__tests__/evidence.test.ts
```

预期：FAIL，报错包含：

```text
Property 'snapshot' does not exist
```

- [ ] **步骤 3：实现 snapshot 方法**

修改 `src/agent/evidence.ts`：

```typescript
export interface EvidenceSnapshot {
  filesRead: string[]
  filesModified: string[]
  verifications: VerificationMetadata[]
}
```

在 `EvidenceTracker` 中增加：

```typescript
snapshot(): EvidenceSnapshot {
  return {
    filesRead: [...this.state.filesRead].sort(),
    filesModified: [...this.state.filesModified].sort(),
    verifications: [...this.state.verifications],
  }
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：

```bash
npx tsx --test src/agent/__tests__/evidence.test.ts
```

预期：PASS。

- [ ] **步骤 5：Commit**

```bash
git add src/agent/evidence.ts src/agent/__tests__/evidence.test.ts
git commit -m "feat(agent): expose structured evidence snapshot"
```

## 任务 10：补齐 cockpit 命令帮助和 README 用户说明

**文件：**
- 修改：`src/tui/app.tsx`
- 修改：`README.md`

- [ ] **步骤 1：更新 `/help` 输出测试或手动断言**

如果已有 App command 测试，新增断言：`/help` 输出包含 `/cockpit`。如果没有可用 App 测试，执行本任务时至少在 `app-cockpit.test.tsx` 中增加 StatusBar 和 panel 渲染测试，不强行搭完整交互测试。

在 `src/tui/app.tsx` `/help` 文本中新增：

```text
/cockpit [summary|trace|verify|context|safety|model|off] — Show Harness Cockpit panel
```

- [ ] **步骤 2：更新 README 用户手册**

在 `README.md` 的命令或用户手册部分加入：

```markdown
### Harness Cockpit

Rivet includes a terminal-native Harness Cockpit for inspecting agent reliability state during a session.

Commands:

- `/cockpit summary` — show one-line trace, verification, context, and safety summary
- `/cockpit trace` — show recent model/tool/checkpoint/cache trace events
- `/cockpit verify` — show the latest structured test verification result
- `/cockpit context` — show token, cache, compaction, and drift status
- `/cockpit safety` — show checkpoint, rollback, approval risk, and doom-loop status
- `/cockpit model` — show the current model capability card
- `/cockpit off` — hide the cockpit rail
```

- [ ] **步骤 3：运行文档相关验证**

运行：

```bash
npm run typecheck
```

预期：PASS。

- [ ] **步骤 4：Commit**

```bash
git add src/tui/app.tsx README.md
git commit -m "docs: document harness cockpit commands"
```

## 任务 11：全量验证与手动 TUI 验收

**文件：**
- 不创建源文件
- 如发现缺陷，修改对应任务文件并补充测试

- [ ] **步骤 1：运行全量测试**

运行：

```bash
npm test
```

预期：PASS，输出包含：

```text
# fail 0
```

- [ ] **步骤 2：运行类型检查**

运行：

```bash
npm run typecheck
```

预期：PASS，无 TypeScript error。

- [ ] **步骤 3：运行构建**

运行：

```bash
npm run build
```

预期：PASS，`dist/` 生成成功。

- [ ] **步骤 4：手动启动 TUI 验收**

运行：

```bash
npm start
```

在 TUI 中执行：

```text
/cockpit summary
/cockpit trace
/cockpit verify
/cockpit context
/cockpit safety
/cockpit model
/cockpit off
```

预期：

- `/cockpit summary` 显示一行 summary rail。
- `/cockpit trace` 显示 Trace 面板。
- `/cockpit verify` 在未测试时显示 `Status: unverified` 或最近测试状态。
- `/cockpit context` 显示 token/cache 信息。
- `/cockpit safety` 显示 checkpoint/rollback/safety 状态。
- `/cockpit model` 显示当前模型能力卡或明确的 unavailable 状态。
- `/cockpit off` 隐藏 rail。

- [ ] **步骤 5：执行真实工具链路验收**

在 TUI 中让 agent 执行一次只读任务和一次测试任务，例如：

```text
请读取 package.json 并运行相关测试，不要修改文件。
```

预期：

- Trace panel 出现 `read_file` 和 `run_tests`。
- Verification panel 出现 `passed`、`failed` 或 `blocked` 的结构化结果。
- ToolCard 仍正常显示 raw output path。
- Evidence badge 仍正常出现在最终回答中。

- [ ] **步骤 6：执行 approval card 验收**

触发一个需要审批的工具调用，例如让 agent 执行 mutating bash 命令前必须审批。不要真的批准 destructive 操作；验证 UI 后选择 `n`。

预期：

- ApprovalRiskCard 显示 tool、risk、reason、targets、destructive。
- 选择 `n` 后 trace 显示 blocked。
- 主流程不崩溃。

- [ ] **步骤 7：最终 Commit**

如果前面任务已逐项提交，此处只提交验收修复。若没有额外修复，不创建空提交。

```bash
git status --short
```

如果有修复文件：

```bash
git add <fixed-files>
git commit -m "fix(tui): polish cockpit validation issues"
```

## 验收清单

P2.3 完成时必须满足：

- `npm test` 通过。
- `npm run typecheck` 通过。
- `npm run build` 通过。
- `/cockpit summary|trace|verify|context|safety|model|off` 均可用。
- `run_tests` 的 verification metadata 能进入 Cockpit verification panel。
- 工具调用能进入 Trace panel，并展示状态和耗时。
- ApprovalRiskCard 替代简单 approval prompt。
- StatusBar 显示 verify/risk 摘要。
- Safety panel 能显示 checkpoint hash 和 rollback 文件数量。
- Context panel 能显示 token/cache/compaction/drift 状态。
- Model panel 能显示当前模型 capability card 或明确 unavailable 状态。
- Evidence badge 原有能力不退化。
- `/debug cache`、`/rollback`、`/model`、`/sessions`、`/verbose` 原有命令不退化。

## 规格覆盖度自检

- Trace 摘要：任务 1、4、5、6 覆盖。
- Verification 结构化状态：任务 3、5、6、9 覆盖，并复用 P2.2 `VerificationMetadata`。
- Approval risk：任务 2、4、6 覆盖。
- Context/cache panel：任务 3、4、6 覆盖。
- Checkpoint/rollback safety：任务 7 覆盖。
- Model capability panel：任务 8 覆盖。
- Slash command 切换：任务 6、10 覆盖。
- 测试和手动验收：任务 11 覆盖。
- 非目标约束：计划未引入多 agent、worktree isolation、外部 telemetry SDK、browser dashboard 或完整 eval runner。

## 类型一致性自检

本计划统一使用以下类型名：

- `TraceEvent`
- `TraceEventKind`
- `TraceEventStatus`
- `TraceStore`
- `ApprovalRisk`
- `RiskLevel`
- `CockpitState`
- `CockpitPanel`
- `ContextSnapshot`
- `SafetySnapshot`
- `VerificationMetadata`
- `ModelCapabilityCard`

`VerificationMetadata` 复用 `src/tools/types.ts` 的现有定义，不创建重复类型。

## 执行建议

给 Revit 或协作智能体执行时，建议按任务顺序逐个提交。任务 1-3 是纯状态地基，任务 4 是纯 UI，任务 5-7 是主链路接入，任务 8-10 是体验补齐，任务 11 是验收。每个任务完成后先跑该任务的 targeted test，再跑 `npm run typecheck`；最后统一跑 `npm test` 和 `npm run build`。
