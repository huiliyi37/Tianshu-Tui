# P1 剩余缺口修复计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 闭合 Cockpit 状态聚合、doom-loop strategy shift、MCP 风险统一三个 P1/P2 缺口。

**架构：** 三个独立子系统，每个任务组可独立 commit 和验证。CockpitState 是纯 TUI 聚合层，从 agent/session/mcp 收集数据产生单一 snapshot；Strategy Shift 在 doom-loop blocked 时向 volatile context 注入替代策略建议；MCP Risk 扩展 `assessToolRisk()` 覆盖 `mcp__*` 工具。

**技术栈：** TypeScript, Node.js test runner, Ink 6 (React TUI)

---

## 文件结构

### 创建
- `src/tui/cockpit/state.ts` — CockpitSnapshot 聚合器，统一收集 safety/verification/context/model/trace/mcp 状态
- `src/agent/strategy-shift.ts` — doom-loop blocked 时生成替代策略建议
- `src/agent/__tests__/strategy-shift.test.ts` — strategy shift 测试

### 修改
- `src/tui/app.tsx:344-376` — CockpitView 改用 CockpitSnapshot，CockpitRail 传入 status 指示器
- `src/tui/cockpit/rail.tsx` — 接受每个 panel 的状态指示器（ok/warn/error）
- `src/tui/cockpit/types.ts` — 新增 CockpitSnapshot 类型定义
- `src/agent/approval-risk.ts` — 新增 MCP 工具风险规则
- `src/agent/loop.ts:317-333` — doom-loop blocked 路径注入 strategy shift
- `src/agent/__tests__/approval-risk.test.ts` — 新增 MCP tool risk 测试

---

## 任务组 A：CockpitState 聚合器

### 任务 A1：定义 CockpitSnapshot 类型

**文件：**
- 修改：`src/tui/cockpit/types.ts`

- [ ] **步骤 1：编写类型定义**

在 `src/tui/cockpit/types.ts` 末尾追加：

```typescript
export type PanelStatus = 'ok' | 'warn' | 'error' | 'idle'

export interface CockpitSnapshot {
  safety: {
    doomLoopLevel: 'none' | 'warn' | 'blocked'
    riskLevel: 'none' | 'low' | 'medium' | 'high'
    riskReasons: string[]
    suggestedAction: string
    recentFingerprints: number
  }
  verification: {
    filesRead: number
    filesModified: number
    runs: Array<{ tool: string; status: string; summary: string }>
    deliveryStatus: 'verified' | 'failed' | 'blocked' | 'unverified'
  }
  trace: {
    events: Array<{
      id: string
      turn: number
      kind: string
      name: string
      status: string
      durationMs?: number
      summary?: string
    }>
    totalEvents: number
  }
  context: {
    estimatedTokens: number
    maxTokens: number
    rounds: number
    compactionState: string
    brokenRounds: number
    layers: CockpitContextLayerView[]
  } | null
  model: {
    name: string
    cacheHitRate: number
    inputTokens: number
    outputTokens: number
    cacheReadTokens: number
    cacheWriteTokens: number
    cost: number
  }
  mcp: {
    servers: Array<{
      serverId: string
      status: string
      toolCount: number
    }>
    totalTools: number
    connectedServers: number
  }
  panelStatuses: Record<Panel, PanelStatus>
}
```

- [ ] **步骤 2：Commit**

```bash
git add src/tui/cockpit/types.ts
git commit -m "feat(cockpit): define CockpitSnapshot type"
```

---

### 任务 A2：创建 buildCockpitSnapshot 聚合函数

**文件：**
- 创建：`src/tui/cockpit/state.ts`

- [ ] **步骤 1：实现聚合函数**

```typescript
import type { AgentLoop } from '../../agent/loop.js'
import type { SessionContext } from '../../context/session.js'
import type { McpManager } from '../../mcp/manager.js'
import type { CockpitSnapshot, Panel, PanelStatus } from './types.js'
import { getDoomLoopLevel } from '../../agent/trace-store.js'

export interface CockpitSnapshotSources {
  agent: AgentLoop
  session: SessionContext
  model: string
  cacheHitRate: number
  cost: number
  mcpManager: McpManager | null
}

function computePanelStatuses(snapshot: Omit<CockpitSnapshot, 'panelStatuses'>): Record<Panel, PanelStatus> {
  const safety: PanelStatus = snapshot.safety.riskLevel === 'high' || snapshot.safety.doomLoopLevel === 'blocked'
    ? 'error'
    : snapshot.safety.riskLevel === 'medium' || snapshot.safety.doomLoopLevel === 'warn'
      ? 'warn'
      : 'ok'

  const verify: PanelStatus = snapshot.verification.deliveryStatus === 'failed' || snapshot.verification.deliveryStatus === 'blocked'
    ? 'error'
    : snapshot.verification.deliveryStatus === 'unverified' && snapshot.verification.filesModified > 0
      ? 'warn'
      : 'ok'

  const context: PanelStatus = snapshot.context
    ? snapshot.context.brokenRounds > 0
      ? 'error'
      : snapshot.context.compactionState === 'critical'
        ? 'error'
        : snapshot.context.compactionState === 'warning'
          ? 'warn'
          : 'ok'
    : 'idle'

  const model: PanelStatus = 'ok'
  const trace: PanelStatus = snapshot.trace.events.some(e => e.status === 'failed')
    ? 'error'
    : 'ok'
  const summary: PanelStatus = safety === 'error' || verify === 'error'
    ? 'error'
    : safety === 'warn' || verify === 'warn'
      ? 'warn'
      : 'ok'

  return { summary, trace, verify, context, safety, model }
}

export function buildCockpitSnapshot(sources: CockpitSnapshotSources): CockpitSnapshot {
  const { agent, session, model, cacheHitRate, cost, mcpManager } = sources

  const traceStore = agent.getTraceStore()
  const evidence = agent.getEvidenceState()
  const doomLevel = agent.getDoomLoopLevel()
  const usage = session.getTotalUsage()
  const risk = agent.getLatestRisk()

  const ledger = session.getContextLedger()
  const contextReport = agent.getContextLayerReport()

  const mcpStates = mcpManager?.getStates() ?? []

  const snapshot: Omit<CockpitSnapshot, 'panelStatuses'> = {
    safety: {
      doomLoopLevel: doomLevel,
      riskLevel: risk.level,
      riskReasons: risk.reasons,
      suggestedAction: risk.suggestedAction,
      recentFingerprints: new Set(traceStore.toolFingerprints).size,
    },
    verification: {
      filesRead: evidence.filesRead.size,
      filesModified: evidence.filesModified.size,
      runs: evidence.verifications.map(v => ({
        tool: v.command,
        status: v.status,
        summary: `${v.passed}✓ ${v.failed}✗ ${v.skipped}skip`,
      })),
      deliveryStatus: evidence.deliveryStatus,
    },
    trace: {
      events: traceStore.events.map(e => ({
        id: e.id,
        turn: e.turn,
        kind: e.kind,
        name: e.name,
        status: e.status,
        durationMs: e.durationMs,
        summary: e.summary,
      })),
      totalEvents: traceStore.events.length,
    },
    context: ledger
      ? {
          estimatedTokens: ledger.tokenBudget.estimatedTokens,
          maxTokens: ledger.tokenBudget.maxTokens,
          rounds: ledger.rounds.length,
          compactionState: ledger.tokenBudget.compactionState,
          brokenRounds: ledger.apiInvariantStatus.brokenRounds,
          layers: contextReport.layers.map(l => ({
            id: l.id,
            label: l.label,
            stability: l.stability,
            channel: l.channel,
            fingerprint: l.fingerprint,
            digest: l.digest,
            tokenEstimate: l.tokenEstimate,
          })),
        }
      : null,
    model: {
      name: model,
      cacheHitRate,
      inputTokens: usage.input_tokens,
      outputTokens: usage.output_tokens,
      cacheReadTokens: usage.cache_read_input_tokens,
      cacheWriteTokens: usage.cache_creation_input_tokens,
      cost,
    },
    mcp: {
      servers: mcpStates.map(s => ({
        serverId: s.serverId,
        status: s.status,
        toolCount: s.toolCount,
      })),
      totalTools: mcpManager?.getAllTools().length ?? 0,
      connectedServers: mcpStates.filter(s => s.status === 'connected').length,
    },
  }

  return {
    ...snapshot,
    panelStatuses: computePanelStatuses(snapshot),
  }
}
```

- [ ] **步骤 2：Commit**

```bash
git add src/tui/cockpit/state.ts
git commit -m "feat(cockpit): add buildCockpitSnapshot aggregator"
```

---

### 任务 A3：CockpitRail 显示状态指示器

**文件：**
- 修改：`src/tui/cockpit/rail.tsx`

- [ ] **步骤 1：修改 CockpitRailProps 接受 panelStatuses**

```typescript
import { Box, Text } from 'ink'
import { memo } from 'react'
import { type Panel, PANELS, PANEL_LABELS, type PanelStatus } from './types.js'
import { getTheme } from '../theme.js'

export interface CockpitRailProps {
  activePanel: Panel
  panelStatuses: Record<Panel, PanelStatus>
  onSelect: (panel: Panel) => void
}

function statusIndicator(status: PanelStatus): string {
  if (status === 'error') return '●'
  if (status === 'warn') return '◐'
  return ''
}

function statusColor(status: PanelStatus, theme: ReturnType<typeof getTheme>): string {
  if (status === 'error') return theme.error
  if (status === 'warn') return theme.warning
  return theme.dim
}

export const CockpitRail = memo(function CockpitRail({ activePanel, panelStatuses }: CockpitRailProps) {
  const theme = getTheme()

  return (
    <Box gap={1}>
      {PANELS.map(panel => {
        const active = panel === activePanel
        const status = panelStatuses[panel]
        const indicator = statusIndicator(status)
        return (
          <Text
            key={panel}
            color={active ? theme.primary : theme.dim}
            bold={active}
          >
            {indicator && <Text color={statusColor(status, theme)}>{indicator}</Text>}
            {active ? `[${PANEL_LABELS[panel]}]` : ` ${PANEL_LABELS[panel]} `}
          </Text>
        )
      })}
    </Box>
  )
})
```

- [ ] **步骤 2：Commit**

```bash
git add src/tui/cockpit/rail.tsx
git commit -m "feat(cockpit): rail shows per-panel status indicators"
```

---

### 任务 A4：CockpitView 改用 CockpitSnapshot

**文件：**
- 修改：`src/tui/app.tsx:344-376`

- [ ] **步骤 1：重写 CockpitView 使用 buildCockpitSnapshot**

将 `CockpitViewProps` 和 `CockpitView` 函数替换为：

```typescript
import { buildCockpitSnapshot, type CockpitSnapshotSources } from './cockpit/state.js'

interface CockpitViewProps {
  panel: Panel
  agent: AgentLoop
  session: SessionContext
  model: string
  cacheHitRate: number
  cost: number
  summaryState: SummaryState
  mcpManager: McpManager | null
}

function CockpitView({ panel, agent, session, model, cacheHitRate, cost, summaryState, mcpManager }: CockpitViewProps) {
  const theme = getTheme()
  const snap = buildCockpitSnapshot({ agent, session, model, cacheHitRate, cost, mcpManager })

  return (
    <Box flexDirection="column" paddingX={1} borderStyle="round" borderColor={theme.primary}>
      <Text color={theme.primary} bold>─── COCKPIT ───</Text>
      <CockpitRail activePanel={panel} panelStatuses={snap.panelStatuses} onSelect={() => {}} />
      {panel === 'summary' && <SummaryBar state={summaryState} />}
      {panel === 'trace' && <TracePanel events={snap.trace.events} />}
      {panel === 'verify' && <VerificationPanel filesRead={snap.verification.filesRead} filesModified={snap.verification.filesModified} verifications={snap.verification.runs} deliveryStatus={snap.verification.deliveryStatus} />}
      {panel === 'context' && snap.context && <ContextPanel estimatedTokens={snap.context.estimatedTokens} maxTokens={snap.context.maxTokens} rounds={snap.context.rounds} compactionState={snap.context.compactionState} brokenRounds={snap.context.brokenRounds} compactEvents={session.getCompactEvents().map(e => ({ turn: e.turn, tier: e.tier, beforeTokens: e.beforeTokens, afterTokens: e.afterTokens }))} layers={snap.context.layers} />}
      {panel === 'safety' && <SafetyPanel doomLoopLevel={snap.safety.doomLoopLevel} riskLevel={snap.safety.riskLevel} riskReasons={snap.safety.riskReasons} suggestedAction={snap.safety.suggestedAction} recentFingerprints={snap.safety.recentFingerprints} />}
      {panel === 'model' && <ModelPanel model={snap.model.name} cacheHitRate={snap.model.cacheHitRate} inputTokens={snap.model.inputTokens} outputTokens={snap.model.outputTokens} cacheReadTokens={snap.model.cacheReadTokens} cacheWriteTokens={snap.model.cacheWriteTokens} cost={snap.model.cost} />}
    </Box>
  )
}
```

- [ ] **步骤 2：更新 CockpitView 调用点**

在 `App` 组件的 JSX 中找到 `<CockpitView .../>` 调用，添加 `mcpManager={mcpManagerRef.current}` prop。

- [ ] **步骤 3：运行测试验证无回归**

运行：`npm test`
预期：553+ tests pass, 0 fail

- [ ] **步骤 4：Commit**

```bash
git add src/tui/app.tsx
git commit -m "refactor(tui): CockpitView uses unified CockpitSnapshot"
```

---

### 任务 A5：CockpitSnapshot 聚合器测试

**文件：**
- 创建：`src/tui/cockpit/__tests__/state.test.ts`

- [ ] **步骤 1：编写 buildCockpitSnapshot 测试**

```typescript
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { buildCockpitSnapshot } from '../state.js'
import type { CockpitSnapshotSources } from '../state.js'
import type { AgentLoop } from '../../../agent/loop.js'
import type { SessionContext } from '../../../context/session.js'
import type { McpManager } from '../../../mcp/manager.js'
import { createTraceStore } from '../../../agent/trace-store.js'

function makeAgent(overrides: Partial<AgentLoop> = {}): AgentLoop {
  return {
    getTraceStore: () => createTraceStore(),
    getEvidenceState: () => ({ filesRead: new Set(), filesModified: new Set(), verifications: [], deliveryStatus: 'unverified' as const }),
    getDoomLoopLevel: () => 'none' as const,
    getLatestRisk: () => ({ level: 'none' as const, reasons: [], suggestedAction: '' }),
    getContextLayerReport: () => ({ layers: [] }),
    ...overrides,
  } as unknown as AgentLoop
}

function makeSession(overrides: Partial<SessionContext> = {}): SessionContext {
  return {
    getTotalUsage: () => ({ input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 80, cache_creation_input_tokens: 20 }),
    getContextLedger: () => null,
    getCompactEvents: () => [],
    ...overrides,
  } as unknown as SessionContext
}

function makeMcpManager(overrides: Partial<McpManager> = {}): McpManager {
  return {
    getStates: () => [],
    getAllTools: () => [],
    ...overrides,
  } as unknown as McpManager
}

describe('buildCockpitSnapshot', () => {
  it('returns idle panel statuses with no data', () => {
    const snap = buildCockpitSnapshot({
      agent: makeAgent(),
      session: makeSession(),
      model: 'test-model',
      cacheHitRate: 0,
      cost: 0,
      mcpManager: null,
    })
    assert.equal(snap.safety.doomLoopLevel, 'none')
    assert.equal(snap.safety.riskLevel, 'none')
    assert.equal(snap.verification.deliveryStatus, 'unverified')
    assert.equal(snap.model.name, 'test-model')
    assert.equal(snap.mcp.totalTools, 0)
    assert.equal(snap.mcp.connectedServers, 0)
    assert.equal(snap.panelStatuses.safety, 'ok')
    assert.equal(snap.panelStatuses.model, 'ok')
    assert.equal(snap.panelStatuses.context, 'idle')
  })

  it('sets safety panel to error when doom-loop blocked', () => {
    const snap = buildCockpitSnapshot({
      agent: makeAgent({
        getDoomLoopLevel: () => 'blocked',
        getLatestRisk: () => ({ level: 'high', reasons: ['doom loop'], suggestedAction: 'stop' }),
      }),
      session: makeSession(),
      model: 'test',
      cacheHitRate: 0,
      cost: 0,
      mcpManager: null,
    })
    assert.equal(snap.panelStatuses.safety, 'error')
    assert.equal(snap.panelStatuses.summary, 'error')
  })

  it('sets verify panel to warn when files modified without verification', () => {
    const snap = buildCockpitSnapshot({
      agent: makeAgent({
        getEvidenceState: () => ({
          filesRead: new Set(['a.ts']),
          filesModified: new Set(['b.ts', 'c.ts']),
          verifications: [],
          deliveryStatus: 'unverified' as const,
        }),
      }),
      session: makeSession(),
      model: 'test',
      cacheHitRate: 0,
      cost: 0,
      mcpManager: null,
    })
    assert.equal(snap.panelStatuses.verify, 'warn')
    assert.equal(snap.verification.filesModified, 2)
  })

  it('includes MCP server states', () => {
    const snap = buildCockpitSnapshot({
      agent: makeAgent(),
      session: makeSession(),
      model: 'test',
      cacheHitRate: 0,
      cost: 0,
      mcpManager: makeMcpManager({
        getStates: () => [
          { serverId: 'ctx7', status: 'connected' as const, toolCount: 3 },
          { serverId: 'broken', status: 'error' as const, toolCount: 0, error: 'refused' },
        ],
        getAllTools: () => [{ definition: { name: 't1' } }] as any[],
      }),
    })
    assert.equal(snap.mcp.servers.length, 2)
    assert.equal(snap.mcp.connectedServers, 1)
    assert.equal(snap.mcp.totalTools, 1)
  })
})
```

- [ ] **步骤 2：运行测试验证通过**

运行：`npx tsx --test src/tui/cockpit/__tests__/state.test.ts`
预期：4 tests pass

- [ ] **步骤 3：Commit**

```bash
git add src/tui/cockpit/__tests__/state.test.ts
git commit -m "test(cockpit): add buildCockpitSnapshot tests"
```

---

## 任务组 B：Doom-loop Strategy Shift

### 任务 B1：创建 strategy-shift 模块

**文件：**
- 创建：`src/agent/strategy-shift.ts`

- [ ] **步骤 1：编写失败测试**

创建 `src/agent/__tests__/strategy-shift.test.ts`：

```typescript
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { suggestStrategyShift, type TrajectorySummary } from '../strategy-shift.js'

describe('suggestStrategyShift', () => {
  it('returns null when not in doom loop', () => {
    const result = suggestStrategyShift([], 'none')
    assert.equal(result, null)
  })

  it('suggests alternative approach for repeated edit failures', () => {
    const trajectory: TrajectorySummary[] = [
      { tool: 'edit_file', target: 'src/agent/loop.ts', status: 'failed', errorClass: 'type_error' },
      { tool: 'edit_file', target: 'src/agent/loop.ts', status: 'failed', errorClass: 'type_error' },
      { tool: 'edit_file', target: 'src/agent/loop.ts', status: 'failed', errorClass: 'type_error' },
    ]
    const result = suggestStrategyShift(trajectory, 'blocked')
    assert.ok(result !== null)
    assert.ok(result.includes('edit_file'), `hint should mention the tool, got: ${result}`)
    assert.ok(result.includes('alternative'), `hint should suggest alternative, got: ${result}`)
  })

  it('suggests verification for repeated unverified writes', () => {
    const trajectory: TrajectorySummary[] = [
      { tool: 'write_file', target: 'src/a.ts', status: 'success' },
      { tool: 'write_file', target: 'src/b.ts', status: 'success' },
      { tool: 'write_file', target: 'src/c.ts', status: 'success' },
      { tool: 'write_file', target: 'src/a.ts', status: 'success' },
    ]
    const result = suggestStrategyShift(trajectory, 'warn')
    assert.ok(result !== null)
    assert.ok(result.includes('verification') || result.includes('test') || result.includes('verify'), `should suggest verification, got: ${result}`)
  })

  it('suggests reading error output for transient failures', () => {
    const trajectory: TrajectorySummary[] = [
      { tool: 'bash', target: 'npm test', status: 'failed', errorClass: 'timeout' },
      { tool: 'bash', target: 'npm test', status: 'failed', errorClass: 'timeout' },
    ]
    const result = suggestStrategyShift(trajectory, 'blocked')
    assert.ok(result !== null)
    assert.ok(result.includes('timeout') || result.includes('retry') || result.includes('different'), `should address timeout, got: ${result}`)
  })

  it('provides generic fallback for unknown patterns', () => {
    const trajectory: TrajectorySummary[] = [
      { tool: 'grep', target: 'pattern', status: 'failed', errorClass: undefined },
      { tool: 'grep', target: 'pattern', status: 'failed', errorClass: undefined },
      { tool: 'grep', target: 'pattern', status: 'failed', errorClass: undefined },
    ]
    const result = suggestStrategyShift(trajectory, 'blocked')
    assert.ok(result !== null)
    assert.ok(result.length > 20, 'fallback hint should be substantive')
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npx tsx --test src/agent/__tests__/strategy-shift.test.ts`
预期：FAIL — `Cannot find module '../strategy-shift.js'`

- [ ] **步骤 3：实现 strategy-shift**

创建 `src/agent/strategy-shift.ts`：

```typescript
export interface TrajectorySummary {
  tool: string
  target: string
  status: string
  errorClass?: string
}

export function suggestStrategyShift(trajectory: TrajectorySummary[], doomLevel: 'none' | 'warn' | 'blocked'): string | null {
  if (doomLevel === 'none') return null

  const recent = trajectory.slice(-10)

  // Pattern 1: repeated same tool+target failure
  const failCounts = new Map<string, number>()
  for (const e of recent) {
    if (e.status === 'failed') {
      const key = `${e.tool}:${e.target}`
      failCounts.set(key, (failCounts.get(key) ?? 0) + 1)
    }
  }
  for (const [key, count] of failCounts) {
    if (count >= 3) {
      const [tool, ...rest] = key.split(':')
      const target = rest.join(':')
      if (tool === 'edit_file' || tool === 'write_file') {
        return `Strategy shift: ${tool} on ${target} has failed ${count} times. Read the error output carefully, consider whether the edit is targeting the right location, or try a different approach (e.g., read the surrounding code first).`
      }
      return `Strategy shift: ${tool} on ${target} has failed ${count} times. Consider an alternative approach or ask the user for guidance.`
    }
  }

  // Pattern 2: multiple writes without verification
  const writes = recent.filter(e => e.tool === 'edit_file' || e.tool === 'write_file')
  const verifies = recent.filter(e => e.tool === 'bash' || e.tool === 'run_tests')
  if (writes.length >= 4 && verifies.length === 0) {
    return `Strategy shift: ${writes.length} file modifications without any verification. Run tests or read the changed files to validate before continuing.`
  }

  // Pattern 3: transient failures (timeout/network)
  const transients = recent.filter(e => e.status === 'failed' && (e.errorClass === 'timeout' || e.errorClass === 'flaky'))
  if (transients.length >= 2) {
    return `Strategy shift: ${transients[0]!.errorClass} failures detected. Try a different command, reduce scope, or increase timeout instead of repeating the same operation.`
  }

  // Pattern 4: repeated same tool calls (any status)
  const toolCounts = new Map<string, number>()
  for (const e of recent) {
    const key = `${e.tool}:${e.target}`
    toolCounts.set(key, (toolCounts.get(key) ?? 0) + 1)
  }
  for (const [key, count] of toolCounts) {
    if (count >= 3) {
      const [tool, ...rest] = key.split(':')
      const target = rest.join(':')
      return `Strategy shift: Repeated ${tool} on ${target} (${count} times). The current approach may not be working. Step back, re-read the relevant code, and consider a different strategy.`
    }
  }

  // Generic fallback when doom-loop is active but no specific pattern matched
  if (doomLevel === 'blocked') {
    return 'Strategy shift: Doom loop detected. Stop repeating the same actions. Re-read the error output, reconsider the approach, or ask the user for clarification.'
  }

  return null
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`npx tsx --test src/agent/__tests__/strategy-shift.test.ts`
预期：5 tests pass

- [ ] **步骤 5：Commit**

```bash
git add src/agent/strategy-shift.ts src/agent/__tests__/strategy-shift.test.ts
git commit -m "feat(agent): add strategy-shift suggestions for doom-loop recovery"
```

---

### 任务 B2：在 loop.ts doom-loop blocked 路径注入 strategy shift

**文件：**
- 修改：`src/agent/loop.ts`

- [ ] **步骤 1：在 doom-loop blocked 路径注入 strategy shift hint**

在 `loop.ts` 顶部 import 区域添加：

```typescript
import { suggestStrategyShift, type TrajectorySummary } from './strategy-shift.js'
```

在 doom-loop blocked 分支中（当前是直接 return blocked result 的位置），找到 `this.getDoomLoopLevel()` 返回 `'blocked'` 的分支，在阻止工具执行后、return 之前，构建 trajectory summary 并注入 strategy hint：

在 doom-loop blocked 处理逻辑中，现有代码类似：

```typescript
if (doomLevel === 'blocked') {
  // ... existing block logic
  return { content: '...', isError: true }
}
```

在此 return 之前插入 strategy shift hint 注入：

```typescript
const trajectorySummary: TrajectorySummary[] = this.trajectory.getEntries().map(e => ({
  tool: e.tool,
  target: e.target,
  status: e.status === 'retried-failed' || e.status === 'failed' ? 'failed' : 'success',
  errorClass: e.errorClass,
}))
const hint = suggestStrategyShift(trajectorySummary, doomLevel)
if (hint) {
  this.config.promptEngine.injectVolatile('strategy_shift', hint)
}
```

注意：具体插入位置取决于 `loop.ts` 中 doom-loop blocked 的实际处理代码。需读取 `this.trajectory`（TrajectoryRecorder 实例）的 entries。如果 loop.ts 中 trajectory 引用名不同，需对齐。

- [ ] **步骤 2：运行全部测试验证无回归**

运行：`npm test`
预期：全部 pass

- [ ] **步骤 3：Commit**

```bash
git add src/agent/loop.ts
git commit -m "feat(agent): inject strategy shift hint on doom-loop block"
```

---

## 任务组 C：MCP Risk Unification

### 任务 C1：扩展 assessToolRisk 覆盖 MCP 工具

**文件：**
- 修改：`src/agent/approval-risk.ts`
- 修改：`src/agent/__tests__/approval-risk.test.ts`

- [ ] **步骤 1：编写 MCP tool risk 失败测试**

在 `src/agent/__tests__/approval-risk.test.ts` 末尾追加：

```typescript
describe('MCP tool risk', () => {
  it('flags MCP write-pattern tools as medium risk', () => {
    const result = assessToolRisk('mcp__myserver__write_file', { path: 'config.json', content: 'data' })
    assert.equal(result.level, 'medium')
    assert.ok(result.reasons.some(r => r.includes('MCP')))
  })

  it('treats MCP read-only tools as low risk', () => {
    const result = assessToolRisk('mcp__myserver__search', { query: 'test' })
    assert.equal(result.level, 'low')
    assert.ok(result.reasons.some(r => r.includes('MCP')))
  })

  it('elevates MCP tool to high risk under doom-loop blocked', () => {
    const result = assessToolRisk('mcp__myserver__update_resource', { id: '123' }, 'blocked')
    assert.equal(result.level, 'high')
  })

  it('extracts server ID from MCP tool name', () => {
    const result = assessToolRisk('mcp__context7__resolve-library-id', { query: 'react' })
    assert.ok(result.reasons.some(r => r.includes('context7')), `should mention server name, got: ${result.reasons}`)
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npx tsx --test src/agent/__tests__/approval-risk.test.ts`
预期：新测试 FAIL（MCP 工具不匹配现有规则，write 工具不会被 flag 为 medium）

- [ ] **步骤 3：在 assessToolRisk 中添加 MCP 工具规则**

在 `approval-risk.ts` 的 `assessToolRisk` 函数中，在 rollback/undo 规则之后、`suggestedAction` 计算之前，添加 MCP 规则：

```typescript
  // MCP tool risk
  const mcpMatch = toolName.match(/^mcp__(.+)__(.+)$/)
  if (mcpMatch) {
    const serverId = mcpMatch[1]!
    const mcpToolName = mcpMatch[2]!
    reasons.push(`MCP tool from server "${serverId}"`)
    level = level === 'none' ? 'low' : level
    const mcpWritePattern = /\b(write|create|update|delete|remove|push|post|put|patch|execute)\b/i
    if (mcpWritePattern.test(mcpToolName)) {
      reasons.push('MCP write-capable tool')
      level = level === 'high' ? 'high' : 'medium'
    }
  }
```

- [ ] **步骤 4：运行测试验证通过**

运行：`npx tsx --test src/agent/__tests__/approval-risk.test.ts`
预期：全部 pass（包括原有测试和新 MCP 测试）

- [ ] **步骤 5：运行全部测试**

运行：`npm test`
预期：全部 pass

- [ ] **步骤 6：Commit**

```bash
git add src/agent/approval-risk.ts src/agent/__tests__/approval-risk.test.ts
git commit -m "feat(safety): extend assessToolRisk to cover MCP tools"
```

---

## 自检

### 1. 规格覆盖度

| 缺口审查项 | 对应任务 |
|-----------|---------|
| CockpitState 聚合器 | A1-A5 |
| "is deliverable" 单一判断 | A2 (computePanelStatuses summary) |
| 面板数据来源统一 | A4 (CockpitView 使用 snapshot) |
| Status 指示器 | A3 (Rail 显示 ●/◐) |
| MCP server 状态在 cockpit | A2 (mcp section in snapshot) |
| Doom-loop strategy shift | B1-B2 |
| MCP tool 不在 risk model | C1 |

### 2. 占位符扫描

无 TODO、TBD、"待定"等占位符。所有步骤含完整代码。

### 3. 类型一致性

- `CockpitSnapshot.panelStatuses` 类型 `Record<Panel, PanelStatus>` 与 `CockpitRailProps.panelStatuses` 一致
- `PanelStatus = 'ok' | 'warn' | 'error' | 'idle'` 与 `statusIndicator` / `statusColor` 函数处理一致
- `TrajectorySummary` 接口与 `suggestStrategyShift` 参数类型一致
- MCP regex `mcp__(.+)__(.+)$` 与 `mcpToolName()` 函数 (wrapper.ts:3) 的命名模式一致
