# Rivet Cockpit + Capability Ledger 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 把 Rivet cockpit 从多个独立展示面板升级为统一状态控制面，并建立核心能力实现状态台账，防止设计文档、计划和真实代码继续漂移。

**架构：** 新增 `CockpitState` 聚合器，从 trace、verification、context、safety、model、MCP 等来源生成单一 snapshot；TUI panels 只消费 snapshot。新增 capability ledger 文档，记录每个核心能力的 design、plan、implementation files、validation status、known gaps 和 next action。

**技术栈：** TypeScript, Ink, node:test, node:assert/strict, existing `TraceStore`, `EvidenceTracker`, cockpit panels, docs/superpowers status docs

---

## 背景

Rivet 已有 cockpit panel 文件：Trace、Verification、Context、Safety、Model、Rail。但它们更像 UI 组件集合，还不是统一控制面。用户需要一眼看到当前 agent 是否安全、是否验证、上下文是否健康、模型为什么这样选、MCP 是否可用。

同时，Rivet 的设计和计划推进很快，已经有多份 specs/plans/validations。缺少状态台账会导致后续工程师误把“文档完成”当成“能力完成”。

---

## 文件结构

| 操作 | 文件 | 职责 |
|------|------|------|
| 创建 | `src/tui/cockpit/state.ts` | 聚合 trace、verification、context、safety、model、mcp 为 `CockpitState` |
| 创建 | `src/tui/cockpit/__tests__/state.test.ts` | 覆盖 cockpit summary 状态灯和 degraded 状态 |
| 修改 | `src/tui/cockpit/types.ts` | 定义统一 CockpitState / CockpitSummaryStatus |
| 修改 | `src/tui/cockpit/rail.tsx` | 展示 safety/verification/context/model/mcp 状态灯 |
| 修改 | `src/tui/cockpit/__tests__/panels.test.ts` | 覆盖 rail status lights |
| 修改 | `src/tui/app.tsx` | 从 runtime 状态构造 CockpitState 后传入 cockpit view |
| 创建 | `docs/superpowers/status/2026-05-16-rivet-core-capability-ledger.md` | 核心能力台账 |
| 修改 | `README.md` | 说明 cockpit snapshot 与 capability ledger 维护规则 |

---

### 任务 1：定义统一 CockpitState

**文件：**
- 修改：`src/tui/cockpit/types.ts`
- 创建：`src/tui/cockpit/state.ts`
- 测试：`src/tui/cockpit/__tests__/state.test.ts`

- [x] **步骤 1：编写失败的测试**

创建 `src/tui/cockpit/__tests__/state.test.ts`：

```typescript
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { buildCockpitState } from '../state.js'

describe('buildCockpitState', () => {
  it('marks summary degraded when verification failed', () => {
    const state = buildCockpitState({
      traceEvents: [],
      verification: { deliveryStatus: 'failed', runs: [{ command: 'npm test', status: 'failed', scope: 'full' }] },
      safety: { doomLoopLevel: 'none' },
      context: { estimatedTokens: 1000, maxTokens: 10000, compactionState: 'healthy' },
      model: { current: 'deepseek-chat', reason: 'default' },
      mcp: { connectedServers: 0, failedServers: 0, toolCount: 0 },
    })

    assert.equal(state.summary.verification, 'degraded')
    assert.equal(state.summary.overall, 'degraded')
  })

  it('marks safety blocked when doom loop is blocked', () => {
    const state = buildCockpitState({
      traceEvents: [],
      verification: { deliveryStatus: 'verified', runs: [] },
      safety: { doomLoopLevel: 'blocked' },
      context: { estimatedTokens: 1000, maxTokens: 10000, compactionState: 'healthy' },
      model: { current: 'deepseek-chat', reason: 'default' },
      mcp: { connectedServers: 0, failedServers: 0, toolCount: 0 },
    })

    assert.equal(state.summary.safety, 'blocked')
    assert.equal(state.summary.overall, 'blocked')
  })
})
```

- [x] **步骤 2：运行测试验证失败**

运行：

```bash
npm test -- src/tui/cockpit/__tests__/state.test.ts
```

预期：FAIL，`../state.js` 不存在。

- [x] **步骤 3：实现 state 类型和聚合器**

修改 `src/tui/cockpit/types.ts`：

```typescript
export type CockpitSummaryStatus = 'healthy' | 'degraded' | 'blocked'

export interface CockpitSummary {
  overall: CockpitSummaryStatus
  safety: CockpitSummaryStatus
  verification: CockpitSummaryStatus
  context: CockpitSummaryStatus
  model: CockpitSummaryStatus
  mcp: CockpitSummaryStatus
}

export interface CockpitState {
  summary: CockpitSummary
  traceEvents: unknown[]
  verification: {
    deliveryStatus: 'verified' | 'failed' | 'blocked' | 'unverified'
    runs: Array<{ command: string; status: string; scope: string; target?: string }>
  }
  safety: {
    doomLoopLevel: 'none' | 'warn' | 'blocked'
    currentRisk?: { level: 'low' | 'medium' | 'high'; reasons: string[]; suggestedAction: string }
  }
  context: {
    estimatedTokens: number
    maxTokens: number
    compactionState: string
    layers?: Array<{ id: string; label: string; stability: string; channel: string; fingerprint: string; digest: string; tokenEstimate: number }>
  }
  model: {
    current: string
    reason: string
  }
  mcp: {
    connectedServers: number
    failedServers: number
    toolCount: number
  }
}
```

创建 `src/tui/cockpit/state.ts`：

```typescript
import type { CockpitState, CockpitSummaryStatus } from './types.js'

function worst(statuses: CockpitSummaryStatus[]): CockpitSummaryStatus {
  if (statuses.includes('blocked')) return 'blocked'
  if (statuses.includes('degraded')) return 'degraded'
  return 'healthy'
}

export function buildCockpitState(input: Omit<CockpitState, 'summary'>): CockpitState {
  const safety: CockpitSummaryStatus = input.safety.doomLoopLevel === 'blocked'
    ? 'blocked'
    : input.safety.doomLoopLevel === 'warn' || input.safety.currentRisk?.level === 'high'
      ? 'degraded'
      : 'healthy'

  const verification: CockpitSummaryStatus = input.verification.deliveryStatus === 'blocked'
    ? 'blocked'
    : input.verification.deliveryStatus === 'failed' || input.verification.deliveryStatus === 'unverified'
      ? 'degraded'
      : 'healthy'

  const contextRatio = input.context.maxTokens > 0 ? input.context.estimatedTokens / input.context.maxTokens : 0
  const context: CockpitSummaryStatus = contextRatio >= 0.9 || input.context.compactionState === 'emergency'
    ? 'blocked'
    : contextRatio >= 0.75
      ? 'degraded'
      : 'healthy'

  const model: CockpitSummaryStatus = 'healthy'
  const mcp: CockpitSummaryStatus = input.mcp.failedServers > 0 ? 'degraded' : 'healthy'
  const overall = worst([safety, verification, context, model, mcp])

  return {
    ...input,
    summary: { overall, safety, verification, context, model, mcp },
  }
}
```

- [x] **步骤 4：运行测试验证通过**

运行：

```bash
npm test -- src/tui/cockpit/__tests__/state.test.ts
```

预期：PASS。

- [x] **步骤 5：Commit**

```bash
git add src/tui/cockpit/types.ts src/tui/cockpit/state.ts src/tui/cockpit/__tests__/state.test.ts
git commit -m "feat(tui): aggregate cockpit state snapshot"
```

---

### 任务 2：Rail 显示统一状态灯

**文件：**
- 修改：`src/tui/cockpit/rail.tsx`
- 测试：`src/tui/cockpit/__tests__/panels.test.ts`

- [x] **步骤 1：编写失败的测试**

在 `src/tui/cockpit/__tests__/panels.test.ts` 增加：

```typescript
it('renders cockpit rail summary statuses', () => {
  const output = renderToString(<CockpitRail
    active="summary"
    state={{
      overall: 'degraded',
      safety: 'healthy',
      verification: 'degraded',
      context: 'healthy',
      model: 'healthy',
      mcp: 'healthy',
    }}
  />)

  assert.match(output, /verification/i)
  assert.match(output, /degraded/i)
})
```

Adapt props to existing `CockpitRail` signature; preserve visible expectations.

- [x] **步骤 2：运行测试验证失败**

运行：

```bash
npm test -- src/tui/cockpit/__tests__/panels.test.ts
```

预期：FAIL，rail does not render status.

- [x] **步骤 3：渲染状态灯**

修改 `src/tui/cockpit/rail.tsx`：

```tsx
import type { CockpitSummary } from './types.js'

const statusColor = (status: string) => status === 'blocked' ? 'red' : status === 'degraded' ? 'yellow' : 'green'

export function CockpitRail({ active, state }: { active: Panel; state?: CockpitSummary }) {
  return (
    <Box flexDirection="column">
      {PANELS.map(panel => (
        <Text key={panel} color={active === panel ? 'cyan' : undefined}>
          {PANEL_LABELS[panel]}{state && panel in state ? ` · ${state[panel as keyof CockpitSummary]}` : ''}
        </Text>
      ))}
      {state && <Text color={statusColor(state.overall)}>overall · {state.overall}</Text>}
    </Box>
  )
}
```

If existing `CockpitRail` already renders horizontally, keep layout and add status text near each label.

- [x] **步骤 4：运行测试验证通过**

运行：

```bash
npm test -- src/tui/cockpit/__tests__/panels.test.ts
```

预期：PASS。

- [x] **步骤 5：Commit**

```bash
git add src/tui/cockpit/rail.tsx src/tui/cockpit/__tests__/panels.test.ts
git commit -m "feat(tui): show cockpit summary status lights"
```

---

### 任务 3：App 接入 CockpitState snapshot

**文件：**
- 修改：`src/tui/app.tsx`
- 测试：`src/tui/cockpit/__tests__/state.test.ts`

- [x] **步骤 1：编写失败的测试**

在 `src/tui/cockpit/__tests__/state.test.ts` 增加纯函数测试，避免直接测试大 App：

```typescript
it('builds blocked overall state when context is near capacity', () => {
  const state = buildCockpitState({
    traceEvents: [],
    verification: { deliveryStatus: 'verified', runs: [] },
    safety: { doomLoopLevel: 'none' },
    context: { estimatedTokens: 9500, maxTokens: 10000, compactionState: 'healthy' },
    model: { current: 'deepseek-chat', reason: 'default' },
    mcp: { connectedServers: 1, failedServers: 0, toolCount: 3 },
  })

  assert.equal(state.summary.context, 'blocked')
  assert.equal(state.summary.overall, 'blocked')
})
```

- [x] **步骤 2：运行测试验证失败**

运行：

```bash
npm test -- src/tui/cockpit/__tests__/state.test.ts
```

预期：If task 1 threshold differs, this FAILS until context threshold is implemented as specified.

- [x] **步骤 3：在 App 构造 snapshot**

In `src/tui/app.tsx`, import:

```typescript
import { buildCockpitState } from './cockpit/state.js'
```

Before rendering cockpit view, build a snapshot from existing app state:

```typescript
const cockpitState = buildCockpitState({
  traceEvents: agentLoopRef.current?.getTraceStore().events ?? [],
  verification: {
    deliveryStatus: verificationState.deliveryStatus ?? 'unverified',
    runs: verificationState.runs ?? [],
  },
  safety: {
    doomLoopLevel: agentLoopRef.current?.getDoomLoopLevel() ?? 'none',
    currentRisk: currentRisk ?? undefined,
  },
  context: {
    estimatedTokens: contextLedger?.tokenBudget.estimatedTokens ?? estimatedTokens,
    maxTokens: contextLedger?.tokenBudget.maxTokens ?? currentModel.maxTokens,
    compactionState: contextLedger?.tokenBudget.state ?? 'healthy',
    layers: promptEngineRef.current?.getContextLayerReport?.().layers,
  },
  model: {
    current: currentModel.id,
    reason: modelSelectionReason ?? 'current selection',
  },
  mcp: {
    connectedServers: mcpManagerRef.current?.getConnectedServers?.().length ?? 0,
    failedServers: mcpManagerRef.current?.getFailedServers?.().length ?? 0,
    toolCount: mcpManagerRef.current?.getToolDefinitions?.().length ?? 0,
  },
})
```

Use actual variable names from `app.tsx`. If a field is not yet available, derive a safe default in the adapter; do not introduce fake state elsewhere.

Pass `cockpitState.summary` to rail and full `cockpitState` to panels.

- [x] **步骤 4：运行 focused tests**

运行：

```bash
npm test -- src/tui/cockpit/__tests__/state.test.ts src/tui/cockpit/__tests__/panels.test.ts
```

预期：PASS。

- [x] **步骤 5：Commit**

```bash
git add src/tui/app.tsx src/tui/cockpit/__tests__/state.test.ts
git commit -m "feat(tui): feed cockpit panels from unified state"
```

---

### 任务 4：建立核心能力状态台账

**文件：**
- 创建：`docs/superpowers/status/2026-05-16-rivet-core-capability-ledger.md`

- [x] **步骤 1：创建 status 目录并写台账**

创建 `docs/superpowers/status/2026-05-16-rivet-core-capability-ledger.md`：

```markdown
# Rivet Core Capability Ledger

## 状态定义

| 状态 | 含义 |
|------|------|
| Designed | 有 spec，但没有可执行 plan |
| Planned | 有 TDD implementation plan |
| MVP | 有代码实现，但只覆盖核心路径 |
| Verified | 有测试和验证报告覆盖目标行为 |
| Gap | 已知实现偏离设计 |

## 能力台账

| 能力 | 状态 | Design | Plan | 主要代码 | 验证 | 已知缺口 | 下一步 |
|------|------|--------|------|----------|------|----------|--------|
| Context Layer + Cache Architecture | Planned | `docs/superpowers/specs/2026-05-16-rivet-context-layer-cache-architecture-gap.md` | `docs/superpowers/plans/2026-05-16-rivet-context-layer-boundary-implementation.md` | `src/prompt/*` | 待执行计划验证 | 逻辑层被压进 volatile block | 执行 context layer boundary plan |
| Cache Safety | Planned | `docs/superpowers/specs/2026-05-16-rivet-cache-safety-design.md` | `docs/superpowers/plans/2026-05-16-rivet-cache-safety-implementation.md` | `src/agent/prewarm.ts`, `src/agent/loop.ts`, `src/tools/read-file.ts` | 待执行计划验证 | prewarm 绕过 read_file 安全边界 | 执行 cache safety plan |
| Tool Safety + Verification Evidence | Planned | `docs/superpowers/specs/2026-05-16-rivet-core-business-gap-review.md` | `docs/superpowers/plans/2026-05-16-rivet-tool-safety-verification-evidence.md` | `src/agent/approval-risk.ts`, `src/agent/evidence.ts`, `src/tools/web-fetch.ts` | 待执行计划验证 | high-risk policy 和 evidence gate 未闭环 | 执行 P0 plan |
| Execution Resilience + Sub-agent Evidence | Planned | `docs/superpowers/specs/2026-05-16-rivet-core-business-gap-review.md` | `docs/superpowers/plans/2026-05-16-rivet-execution-resilience-subagent-evidence.md` | `src/agent/turn-harness.ts`, `src/agent/coordinator.ts`, `src/agent/aggregation.ts` | 待执行计划验证 | retry/failure/subagent evidence 未统一 | 执行 P1 plan |
| Cockpit Observability | Planned | `docs/superpowers/specs/2026-05-16-rivet-core-business-gap-review.md` | `docs/superpowers/plans/2026-05-16-rivet-cockpit-capability-ledger.md` | `src/tui/cockpit/*`, `src/tui/app.tsx` | 待执行计划验证 | panels 缺统一 state snapshot | 执行 cockpit state plan |
| MCP Integration | MVP | `CLAUDE.md`, README architecture notes | `docs/superpowers/plans/2026-05-16-rivet-mcp-client-implementation.md` | `src/mcp/*` | 单元测试覆盖 config/manager/wrapper | 未纳入统一 safety/trace/evidence | 后续写 MCP hardening plan |
| Model Routing | MVP | `docs/superpowers/specs/2026-05-16-rivet-core-business-gap-review.md` | 无独立 plan | `src/model/capability.ts` | `src/model/__tests__/capability.test.ts` | 未进入 AgentLoop/coordinator 策略 | 后续写 model routing plan |
| Repo Intelligence | MVP | P2.2 records / README | 无独立 plan | `src/repo/*` | symbol-index 单元测试 | 未进入默认 impact/test selection | 后续写 repo intelligence plan |

## 维护规则

- 新增 design/spec 时，状态不能超过 Designed。
- 新增 implementation plan 后，状态升为 Planned。
- 合并代码但没有完整验证，只能标 MVP。
- `npm run typecheck`、`npm test`、`npm run build` 和目标行为测试通过后，才能标 Verified。
- 审查发现偏离时，状态必须标 Gap 或在“已知缺口”列写明。
```

- [x] **步骤 2：检查文档格式**

运行：

```bash
git diff --check -- docs/superpowers/status/2026-05-16-rivet-core-capability-ledger.md
```

预期：无输出。

- [x] **步骤 3：Commit**

```bash
git add docs/superpowers/status/2026-05-16-rivet-core-capability-ledger.md
git commit -m "docs: add Rivet core capability ledger"
```

---

### 任务 5：README 记录维护规则并最终验证

**文件：**
- 修改：`README.md`

- [x] **步骤 1：更新 README**

加入：

```markdown
### Cockpit State and Capability Ledger

Cockpit panels are driven by a single `CockpitState` snapshot so safety, verification, context, model, and MCP status agree on the same turn state. The cockpit rail summarizes each area as healthy, degraded, or blocked.

Core capability progress is tracked in `docs/superpowers/status/2026-05-16-rivet-core-capability-ledger.md`. A capability is only marked verified after targeted behavior tests and full validation pass; design and plan documents alone do not imply implementation completion.
```

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

预期：无真实密钥或 credential 片段命中。

- [x] **步骤 4：Commit**

```bash
git add README.md
git commit -m "docs: document cockpit state and capability ledger"
```

---

## 自检

### 规格覆盖度

- Cockpit unified state：任务 1-3 覆盖。
- Rail summary status：任务 2 覆盖。
- App snapshot adapter：任务 3 覆盖。
- Capability ledger：任务 4 覆盖。
- README 与最终验证：任务 5 覆盖。

### 占位符扫描

本文没有留下未具体化的占位描述；每个代码任务都包含具体测试、实现片段、命令和预期结果。

### 类型一致性

- `CockpitSummaryStatus` 在任务 1 定义，在任务 2 rail 和任务 3 app snapshot 中使用。
- `CockpitState` 在任务 1 定义，任务 3 负责从 app runtime 状态构造。
- Capability ledger 的状态定义与任务 4 表格状态一致。

---

计划已完成并保存到 `docs/superpowers/plans/2026-05-16-rivet-cockpit-capability-ledger.md`。两种执行方式：

**1. 子代理驱动（推荐）** - 每个任务调度一个新的子代理，任务间进行审查，快速迭代

**2. 内联执行** - 在当前会话中使用 executing-plans 执行任务，批量执行并设有检查点

选哪种方式？
