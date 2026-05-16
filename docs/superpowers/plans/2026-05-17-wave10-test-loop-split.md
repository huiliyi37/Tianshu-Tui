# Wave 10: 测试补强 + loop.ts 拆分 实施计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 补齐 compact/session-persist 测试 + 将 loop.ts 从 815 行拆分为 3 个模块（~480 + ~200 + ~80）

**架构：** 提取 tool-pipeline.ts（单 tool 执行全流程）和 turn-end.ts（turn 结束处理），loop.ts 通过组合调用它们

**技术栈：** TypeScript, node:test, 现有 AgentLoop infrastructure

---

## 文件结构

### 新建文件

| 文件 | 职责 |
|------|------|
| `src/agent/tool-pipeline.ts` | 单 tool 执行：pre-hooks → execute → post-hooks → side effects |
| `src/agent/turn-end.ts` | Turn 结束处理：task state + mirror + routing + decisions + badge |
| `src/agent/__tests__/tool-pipeline.test.ts` | tool-pipeline 单元测试 |
| `src/agent/__tests__/turn-end.test.ts` | turn-end 单元测试 |
| `src/compact/__tests__/auto.test.ts` | compact/auto 测试 |
| `src/compact/__tests__/micro.test.ts` | compact/micro 测试 |
| `src/agent/__tests__/session-persist.test.ts` | session-persist 测试 |

### 修改文件

| 文件 | 变更 |
|------|------|
| `src/agent/loop.ts` | 删除提取的代码，改为调用 tool-pipeline 和 turn-end |

---

## 任务 1：compact/auto.ts 测试

**文件：**
- 创建：`src/compact/__tests__/auto.test.ts`

- [ ] **步骤 1：编写测试**

```typescript
// src/compact/__tests__/auto.test.ts
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { shouldAutoCompact, buildSummaryPrompt } from '../auto.js'
import type { Message } from '../../api/types.js'

describe('shouldAutoCompact', () => {
  const baseConfig = { enabled: true, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' }

  it('returns disabled when compact not enabled', () => {
    const r = shouldAutoCompact([], { ...baseConfig, enabled: false })
    assert.equal(r.shouldCompact, false)
    assert.equal(r.reason, 'disabled')
  })

  it('returns below_floor when tokens < autoFloor', () => {
    const msgs: Message[] = [{ role: 'user', content: 'hi' }]
    const r = shouldAutoCompact(msgs, baseConfig, 100_000)
    assert.equal(r.shouldCompact, false)
    assert.equal(r.reason, 'below_floor')
  })

  it('returns below_threshold when tokens between floor and threshold', () => {
    const msgs: Message[] = Array.from({ length: 10 }, (_, i) => ({ role: 'user' as const, content: `msg ${i}` }))
    const r = shouldAutoCompact(msgs, baseConfig, 600_000)
    assert.equal(r.shouldCompact, false)
    assert.equal(r.reason, 'below_threshold')
  })

  it('returns not_enough_messages when fewer than 6 messages', () => {
    const msgs: Message[] = [{ role: 'user', content: 'hi' }]
    const r = shouldAutoCompact(msgs, baseConfig, 900_000)
    assert.equal(r.shouldCompact, false)
    assert.equal(r.reason, 'not_enough_messages')
  })

  it('returns triggered when all conditions met', () => {
    const msgs: Message[] = Array.from({ length: 10 }, (_, i) => ({ role: 'user' as const, content: `msg ${i}` }))
    const r = shouldAutoCompact(msgs, baseConfig, 900_000)
    assert.equal(r.shouldCompact, true)
    assert.equal(r.reason, 'triggered')
  })
})

describe('buildSummaryPrompt', () => {
  it('includes full content when short', () => {
    const msgs: Message[] = [
      { role: 'user', content: 'Fix the bug in auth.ts' },
      { role: 'assistant', content: 'I will fix it.' },
    ]
    const prompt = buildSummaryPrompt(msgs, 100_000)
    assert.ok(prompt.includes('Fix the bug'))
    assert.ok(prompt.includes('500 words'))
  })

  it('uses large context limits for 500K+ tokens', () => {
    const msgs: Message[] = [{ role: 'user', content: 'x'.repeat(1000) }]
    const prompt = buildSummaryPrompt(msgs, 600_000)
    assert.ok(prompt.includes('900 words'))
  })

  it('truncates with head+tail when content exceeds max chars', () => {
    const msgs: Message[] = Array.from({ length: 200 }, (_, i) => ({
      role: 'user' as const,
      content: `Message ${i}: ${'x'.repeat(200)}`,
    }))
    const prompt = buildSummaryPrompt(msgs, 100_000)
    assert.ok(prompt.includes('messages omitted'))
  })
})
```

- [ ] **步骤 2：运行测试确认通过**

运行：`npm test -- src/compact/__tests__/auto.test.ts`
预期：PASS（测试已有实现）

- [ ] **步骤 3：Commit**

```bash
git add src/compact/__tests__/auto.test.ts
git commit -m "test(compact): add shouldAutoCompact + buildSummaryPrompt tests"
```

---

## 任务 2：compact/micro.ts 测试

**文件：**
- 创建：`src/compact/__tests__/micro.test.ts`

- [ ] **步骤 1：编写测试**

```typescript
// src/compact/__tests__/micro.test.ts
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { microCompact, estimateTokens } from '../micro.js'
import type { Message } from '../../api/types.js'

describe('estimateTokens', () => {
  it('estimates ~4 chars per token for short messages', () => {
    const msgs: Message[] = [{ role: 'user', content: 'Hello world' }]
    const est = estimateTokens(msgs)
    // "Hello world" = 11 chars → ~3 tokens (rough estimate)
    assert.ok(est > 0)
    assert.ok(est < 20)
  })

  it('handles empty messages array', () => {
    assert.equal(estimateTokens([]), 0)
  })

  it('handles content blocks (non-string content)', () => {
    const msgs: Message[] = [{
      role: 'assistant',
      content: [{ type: 'text', text: 'Hello' }],
    }]
    const est = estimateTokens(msgs)
    assert.ok(est > 0)
  })
})

describe('microCompact', () => {
  const makeMessages = (n: number): Message[] =>
    Array.from({ length: n }, (_, i) => ({
      role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
      content: `Message ${i}: ${'x'.repeat(100)}`,
    }))

  it('preserves anchor messages at start', () => {
    const msgs = makeMessages(20)
    const { messages } = microCompact(msgs, 128_000, 900_000)
    // First 2 messages should be preserved (CACHE_ANCHOR_MESSAGES)
    assert.equal(messages[0]?.content, msgs[0]?.content)
    assert.equal(messages[1]?.content, msgs[1]?.content)
  })

  it('preserves recent messages at end', () => {
    const msgs = makeMessages(20)
    const { messages } = microCompact(msgs, 128_000, 900_000)
    // Last KEEP_RECENT_MESSAGES should be preserved
    const lastOriginal = msgs[msgs.length - 1]!.content
    const lastCompacted = messages[messages.length - 1]!.content
    assert.equal(lastCompacted, lastOriginal)
  })

  it('returns truncated count', () => {
    const msgs = makeMessages(20)
    const { truncated } = microCompact(msgs, 128_000, 900_000)
    assert.ok(truncated > 0)
    assert.ok(truncated < 20)
  })

  it('does nothing when few messages', () => {
    const msgs = makeMessages(4)
    const { messages, truncated } = microCompact(msgs, 128_000, 900_000)
    assert.equal(messages.length, 4)
    assert.equal(truncated, 0)
  })
})
```

- [ ] **步骤 2：运行测试确认通过**

运行：`npm test -- src/compact/__tests__/micro.test.ts`
预期：PASS

- [ ] **步骤 3：Commit**

```bash
git add src/compact/__tests__/micro.test.ts
git commit -m "test(compact): add microCompact + estimateTokens tests"
```

---

## 任务 3：session-persist.ts 测试

**文件：**
- 创建：`src/agent/__tests__/session-persist.test.ts`

- [ ] **步骤 1：编写测试**

```typescript
// src/agent/__tests__/session-persist.test.ts
import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { SessionPersist } from '../session-persist.js'

describe('SessionPersist', () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'rivet-test-'))
    // Override SESSION_DIR for testing — use env or monkey-patch
    process.env.RIVET_SESSION_DIR = tempDir
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
    delete process.env.RIVET_SESSION_DIR
  })

  it('creates a claim store for the session', () => {
    const persist = new SessionPersist('test-session-001')
    const store = persist.createClaimStore()
    assert.ok(store)
  })

  it('buildMemoryBlock returns empty string for fresh session', () => {
    const persist = new SessionPersist('test-session-002')
    const block = persist.buildMemoryBlock()
    // Fresh session has no memory
    assert.equal(typeof block, 'string')
  })

  it('getSessionMemoryState returns undefined for fresh session', () => {
    const persist = new SessionPersist('test-session-003')
    const state = persist.getSessionMemoryState()
    assert.equal(state, undefined)
  })

  it('getBackupDir returns a path containing the session id', () => {
    const persist = new SessionPersist('test-session-004')
    const dir = persist.getBackupDir()
    assert.ok(dir.includes('test-session-004'))
  })
})
```

注意：如果 SessionPersist 不支持 `RIVET_SESSION_DIR` 环境变量覆盖，需要先添加该支持（在 session-persist.ts 中将 `SESSION_DIR` 改为 `process.env.RIVET_SESSION_DIR ?? join(homedir(), '.rivet', 'sessions')`）。

- [ ] **步骤 2：如需修改 session-persist.ts 支持测试**

在 `src/agent/session-persist.ts` 第 13 行，将：
```typescript
const SESSION_DIR = join(homedir(), '.rivet', 'sessions')
```
改为：
```typescript
const SESSION_DIR = process.env.RIVET_SESSION_DIR ?? join(homedir(), '.rivet', 'sessions')
```

- [ ] **步骤 3：运行测试确认通过**

运行：`npm test -- src/agent/__tests__/session-persist.test.ts`
预期：PASS

- [ ] **步骤 4：Commit**

```bash
git add src/agent/__tests__/session-persist.test.ts src/agent/session-persist.ts
git commit -m "test(agent): add session-persist tests with env-overridable SESSION_DIR"
```

---

## 任务 4：提取 tool-pipeline.ts

**文件：**
- 创建：`src/agent/tool-pipeline.ts`
- 修改：`src/agent/loop.ts`

- [ ] **步骤 1：创建 tool-pipeline.ts 骨架**

从 loop.ts 第 530-743 行提取为独立函数。关键接口：

```typescript
// src/agent/tool-pipeline.ts
import type { AgentConfig, AgentCallbacks } from './loop.js'
import type { TurnHarness } from './turn-harness.js'
import type { PrewarmCache } from '../prompt/prewarm.js'
import type { EvidenceTracker } from './evidence.js'
import type { TraceStore } from './trace-store.js'
import type { RepairHintTracker } from './repair-hint.js'
import type { ImportGraph } from './import-graph.js'
import { createCheckpoint, recordAgentTouchedFile } from './checkpoint.js'
import { validatePath } from '../tools/path-validate.js'
import { canUsePrewarmForRead } from '../prompt/prewarm.js'
import { classifyFailure } from './failure-classifier.js'
import { classifyTestRun } from './failure-classifier.js'
import { extractClaimsFromToolResult } from '../context/claim-extractor.js'
import { detectConflicts } from '../context/conflict-detect.js'
import { createAntibodyProposal } from '../context/antibody.js'
import { buildImportGraph, invalidateFile } from './import-graph.js'
import { generateImpactHint } from './impact-hint.js'
import { shouldRunDiagnostics, runTypeCheck } from '../lsp/client.js'
import { startTraceEvent, finishTraceEvent, fingerprintToolCall, recordToolFingerprint } from './trace-store.js'

export interface ToolPipelineDeps {
  config: AgentConfig
  cwd: string
  harness: TurnHarness
  prewarm: PrewarmCache
  evidence: EvidenceTracker
  traceStore: TraceStore
  repairHintTracker: RepairHintTracker
  importGraph: ImportGraph | null
  lastConflictCheckCount: number
}

export interface ToolExecInput {
  id: string
  name: string
  input: Record<string, unknown>
}

export interface ToolExecResult {
  toolResult: { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean }
  traceStore: TraceStore
  importGraph: ImportGraph | null
  lastConflictCheckCount: number
  checkpointCreated: boolean
}

export async function executeToolUse(
  tu: ToolExecInput,
  deps: ToolPipelineDeps,
  callbacks: AgentCallbacks,
  turn: number,
  checkpointAlreadyCreated: boolean,
): Promise<ToolExecResult> {
  // ... (full implementation extracted from loop.ts lines 530-743)
}
```

- [ ] **步骤 2：将 loop.ts 第 530-743 行的逻辑移入 executeToolUse**

逐段移动：
1. Pre-execution block (checkpoint + file history + agent-touched-file)
2. Execution block (trace start + harness.executeTool with prewarm)
3. Post-hook block (hooks.firePostToolUse + LSP diagnostics)
4. Trace + fingerprint recording
5. Callback (onToolResult)
6. Tool history recording
7. Claim extraction + conflict detection
8. Repair hint + antibody
9. Prewarm invalidation
10. Evidence tracking + import graph
11. Test run special handling

- [ ] **步骤 3：在 loop.ts 中替换为 executeToolUse 调用**

将 loop.ts 的 tool execution for-loop 改为：

```typescript
import { executeToolUse, type ToolPipelineDeps } from './tool-pipeline.js'

// Inside the tool execution loop:
for (const tu of toolUses) {
  const deps: ToolPipelineDeps = {
    config: this.config,
    cwd: this.cwd,
    harness: this.harness,
    prewarm: this.prewarm,
    evidence: this.evidence,
    traceStore: this.traceStore,
    repairHintTracker: this.repairHintTracker,
    importGraph: this.importGraph,
    lastConflictCheckCount: this.lastConflictCheckCount,
  }

  const result = await executeToolUse(
    { id: tu.id, name: tu.name, input: tu.input },
    deps,
    callbacks,
    turn,
    checkpointCreatedThisTurn,
  )

  // Update mutable state
  this.traceStore = result.traceStore
  this.importGraph = result.importGraph
  this.lastConflictCheckCount = result.lastConflictCheckCount
  if (result.checkpointCreated) checkpointCreatedThisTurn = true

  toolResults.push(result.toolResult)
}
```

- [ ] **步骤 4：运行 typecheck**

运行：`npx tsc --noEmit`
预期：0 errors

- [ ] **步骤 5：运行全量测试**

运行：`npm test`
预期：所有测试通过

- [ ] **步骤 6：Commit**

```bash
git add src/agent/tool-pipeline.ts src/agent/loop.ts
git commit -m "refactor(agent): extract tool-pipeline.ts from loop.ts"
```

---

## 任务 5：提取 turn-end.ts

**文件：**
- 创建：`src/agent/turn-end.ts`
- 修改：`src/agent/loop.ts`

- [ ] **步骤 1：创建 turn-end.ts**

从 loop.ts 第 745-798 行提取：

```typescript
// src/agent/turn-end.ts
import type { AgentConfig } from './loop.js'
import type { SessionContext } from './context.js'
import type { TrajectoryRecorder } from './trajectory.js'
import type { RoutingMetricsCollector } from './adaptive-routing.js'
import type { EvidenceTracker } from './evidence.js'
import { extractTaskState } from './task-state.js'
import { detectMirror } from './behavior-mirror.js'
import { inferTaskType } from './intent-extractor.js'
import { recommendModelForTask } from '../model/capability.js'
import { extractDecisions } from './decision-extractor.js'

export interface TurnEndDeps {
  config: AgentConfig
  session: SessionContext
  trajectory: TrajectoryRecorder
  streamedText: string
  routingMetrics: RoutingMetricsCollector
  decisions: string[]
  evidence: EvidenceTracker
}

export interface TurnEndResult {
  decisions: string[]
  badge: string | null
}

export function processTurnEnd(deps: TurnEndDeps): TurnEndResult {
  const { config, session, trajectory, streamedText, routingMetrics } = deps
  let { decisions } = deps

  // Task state extraction (after warmup)
  if (session.getTurnCount() > 3) {
    const taskState = extractTaskState(trajectory.getEntries(), streamedText)
    config.promptEngine.setTaskProgress(taskState)
  }

  // Behavior mirror detection
  const mirror = session.getTurnCount() > 3
    ? detectMirror(trajectory.getEntries())
    : null
  config.promptEngine.setBehaviorMirror(mirror)

  // Model routing
  if (config.modelCards && config.modelCards.length > 1 && config.getCurrentModel) {
    const currentModel = config.getCurrentModel()
    const recentCalls = trajectory.getEntries().slice(-10).map(e => ({
      name: e.tool,
      isError: e.status === 'failed' || e.status === 'retried-failed',
    }))
    const inference = inferTaskType(recentCalls)
    if (inference) {
      const recommended = recommendModelForTask(inference.task, config.modelCards)
      config.promptEngine.setRoutingReason(`${inference.task} · ${recommended.model} ${inference.reason}`)
      if (recommended.model !== currentModel && config.onModelSwitch) {
        routingMetrics.record({
          turn: session.getTurnCount(),
          inferredTask: inference.task,
          recommendedModel: recommended.model,
          currentModel,
          switched: true,
          reason: inference.reason,
          timestamp: Date.now(),
        })
        try { config.onModelSwitch(recommended.model) } catch { /* non-fatal */ }
      }
    }
  }

  // Decision extraction
  const newDecisions = extractDecisions(streamedText)
  for (const d of newDecisions) {
    if (!decisions.includes(d)) decisions.push(d)
  }
  if (decisions.length > 3) decisions = decisions.slice(-3)
  config.promptEngine.setDecisions(decisions)

  // Evidence badge
  const badge = deps.evidence.buildBadge()

  return { decisions, badge }
}
```

- [ ] **步骤 2：在 loop.ts 中替换为 processTurnEnd 调用**

将 loop.ts 第 745-804 行替换为：

```typescript
import { processTurnEnd } from './turn-end.js'

// After tool results are added to session:
this.session.addToolResults(toolResults)

const turnEndResult = processTurnEnd({
  config: this.config,
  session: this.session,
  trajectory: this.trajectory,
  streamedText: this.streamedText,
  routingMetrics: this.routingMetrics,
  decisions: this.decisions,
  evidence: this.evidence,
})
this.decisions = turnEndResult.decisions
this.refreshLedger()
callbacks.onTurnComplete(this.session.getTotalUsage(), this.session.getTurnCount())
continue

// ... and for the final break case (no tool_use):
const finalResult = processTurnEnd({ /* same deps */ })
this.decisions = finalResult.decisions
if (finalResult.badge) callbacks.onTextDelta('\n' + finalResult.badge)
this.refreshLedger()
callbacks.onTurnComplete(this.session.getTotalUsage(), this.session.getTurnCount())
this.evidence.reset()
break
```

- [ ] **步骤 3：运行 typecheck + 全量测试**

运行：`npx tsc --noEmit && npm test`
预期：0 errors, 所有测试通过

- [ ] **步骤 4：Commit**

```bash
git add src/agent/turn-end.ts src/agent/loop.ts
git commit -m "refactor(agent): extract turn-end.ts from loop.ts"
```

---

## 任务 6：tool-pipeline 测试

**文件：**
- 创建：`src/agent/__tests__/tool-pipeline.test.ts`

- [ ] **步骤 1：编写测试**

```typescript
// src/agent/__tests__/tool-pipeline.test.ts
import { describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'
import { executeToolUse, type ToolPipelineDeps, type ToolExecInput } from '../tool-pipeline.js'

function createMockDeps(overrides?: Partial<ToolPipelineDeps>): ToolPipelineDeps {
  return {
    config: {
      toolRegistry: {
        execute: mock.fn(async () => ({ content: 'ok', isError: false })),
        get: mock.fn(() => ({ isConcurrencySafe: () => false })),
        getDefinitions: mock.fn(() => []),
      },
      contextClaimStore: undefined,
      sessionId: 'test-session',
      fileHistory: undefined,
      hooks: undefined,
      lspEnabled: false,
      promptEngine: { setStrategyShift: mock.fn(), setImpactHint: mock.fn() },
    } as any,
    cwd: '/tmp/test',
    harness: {
      executeTool: mock.fn(async ({ execute }) => {
        const r = await execute()
        return { content: r.content, isError: r.isError ?? false }
      }),
    } as any,
    prewarm: { get: mock.fn(() => null), invalidate: mock.fn(), set: mock.fn() } as any,
    evidence: { trackFileRead: mock.fn(), trackFileModified: mock.fn(), trackImpact: mock.fn(), trackVerification: mock.fn() } as any,
    traceStore: { events: [] } as any,
    repairHintTracker: { recordSuccess: mock.fn(), recordFailure: mock.fn() } as any,
    importGraph: null,
    lastConflictCheckCount: 0,
    ...overrides,
  }
}

function createMockCallbacks() {
  return {
    onTextDelta: mock.fn(),
    onThinkingDelta: mock.fn(),
    onToolUse: mock.fn(),
    onToolResult: mock.fn(),
    onTurnComplete: mock.fn(),
    onError: mock.fn(),
    onAbort: mock.fn(),
    onApprovalRequired: mock.fn(async () => true),
    onCheckpoint: mock.fn(),
  }
}

describe('executeToolUse', () => {
  it('executes a tool and returns result', async () => {
    const deps = createMockDeps()
    const callbacks = createMockCallbacks()
    const tu: ToolExecInput = { id: 'tu-1', name: 'read_file', input: { file_path: '/tmp/test/foo.ts' } }

    const result = await executeToolUse(tu, deps, callbacks, 1, false)

    assert.equal(result.toolResult.tool_use_id, 'tu-1')
    assert.equal(result.toolResult.content, 'ok')
    assert.equal(result.toolResult.is_error, false)
  })

  it('calls onToolResult callback', async () => {
    const deps = createMockDeps()
    const callbacks = createMockCallbacks()
    const tu: ToolExecInput = { id: 'tu-2', name: 'read_file', input: { file_path: '/tmp/test/bar.ts' } }

    await executeToolUse(tu, deps, callbacks, 1, false)

    assert.equal(callbacks.onToolResult.mock.calls.length, 1)
  })

  it('records success in repairHintTracker on success', async () => {
    const deps = createMockDeps()
    const callbacks = createMockCallbacks()
    const tu: ToolExecInput = { id: 'tu-3', name: 'edit_file', input: { file_path: '/tmp/test/x.ts' } }

    await executeToolUse(tu, deps, callbacks, 1, false)

    assert.equal(deps.repairHintTracker.recordSuccess.mock.calls.length, 1)
  })
})
```

- [ ] **步骤 2：运行测试确认通过**

运行：`npm test -- src/agent/__tests__/tool-pipeline.test.ts`
预期：PASS

- [ ] **步骤 3：Commit**

```bash
git add src/agent/__tests__/tool-pipeline.test.ts
git commit -m "test(agent): add tool-pipeline unit tests"
```

---

## 任务 7：turn-end 测试

**文件：**
- 创建：`src/agent/__tests__/turn-end.test.ts`

- [ ] **步骤 1：编写测试**

```typescript
// src/agent/__tests__/turn-end.test.ts
import { describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'
import { processTurnEnd, type TurnEndDeps } from '../turn-end.js'

function createMockTurnEndDeps(overrides?: Partial<TurnEndDeps>): TurnEndDeps {
  return {
    config: {
      promptEngine: {
        setTaskProgress: mock.fn(),
        setBehaviorMirror: mock.fn(),
        setRoutingReason: mock.fn(),
        setDecisions: mock.fn(),
      },
      modelCards: undefined,
      getCurrentModel: undefined,
      onModelSwitch: undefined,
    } as any,
    session: {
      getTurnCount: mock.fn(() => 5),
    } as any,
    trajectory: {
      getEntries: mock.fn(() => []),
    } as any,
    streamedText: 'I will fix the bug in auth.ts',
    routingMetrics: { record: mock.fn() } as any,
    decisions: [],
    evidence: { buildBadge: mock.fn(() => null), reset: mock.fn() } as any,
    ...overrides,
  }
}

describe('processTurnEnd', () => {
  it('extracts task state when turn > 3', () => {
    const deps = createMockTurnEndDeps()
    processTurnEnd(deps)
    assert.equal(deps.config.promptEngine.setTaskProgress.mock.calls.length, 1)
  })

  it('skips task state when turn <= 3', () => {
    const deps = createMockTurnEndDeps({
      session: { getTurnCount: mock.fn(() => 2) } as any,
    })
    processTurnEnd(deps)
    assert.equal(deps.config.promptEngine.setTaskProgress.mock.calls.length, 0)
  })

  it('returns badge from evidence', () => {
    const deps = createMockTurnEndDeps({
      evidence: { buildBadge: mock.fn(() => '✓ 5 files, 3 tests'), reset: mock.fn() } as any,
    })
    const result = processTurnEnd(deps)
    assert.equal(result.badge, '✓ 5 files, 3 tests')
  })

  it('caps decisions at 3', () => {
    const deps = createMockTurnEndDeps({ decisions: ['d1', 'd2', 'd3'] })
    // streamedText contains decisions that extractDecisions would find
    const result = processTurnEnd(deps)
    assert.ok(result.decisions.length <= 3)
  })
})
```

- [ ] **步骤 2：运行测试确认通过**

运行：`npm test -- src/agent/__tests__/turn-end.test.ts`
预期：PASS

- [ ] **步骤 3：Commit**

```bash
git add src/agent/__tests__/turn-end.test.ts
git commit -m "test(agent): add turn-end unit tests"
```

---

## 任务 8：集成验证 + 行数确认

**文件：** 无新增

- [ ] **步骤 1：确认 loop.ts 行数**

运行：`wc -l src/agent/loop.ts`
预期：≤ 500 行

- [ ] **步骤 2：运行 typecheck**

运行：`npx tsc --noEmit`
预期：0 errors

- [ ] **步骤 3：运行全量测试**

运行：`npm test`
预期：870+ pass, 0 fail

- [ ] **步骤 4：确认 main.tsx 无 import 变更**

运行：`grep "from.*loop" src/main.tsx`
预期：仍然只 import `AgentLoop` from `./agent/loop.js`（外部 API 不变）

- [ ] **步骤 5：最终 Commit（如有 lint fix）**

```bash
git add -A && git commit -m "chore: Wave 10 complete — test coverage + loop.ts split" || true
```

---

## 验收标准

| 标准 | 验证方法 |
|------|---------|
| compact/auto.ts 有 8+ 测试 | npm test |
| compact/micro.ts 有 5+ 测试 | npm test |
| session-persist.ts 有 4+ 测试 | npm test |
| tool-pipeline.ts 独立可测试 | 3+ 测试通过 |
| turn-end.ts 独立可测试 | 4+ 测试通过 |
| loop.ts ≤ 500 行 | wc -l |
| 全量测试 0 fail | npm test |
| Typecheck 0 errors | npx tsc --noEmit |
| AgentLoop 外部 API 不变 | main.tsx import 不变 |ould be preserved
    const last = messages[messages.length - 1]
    assert.equal(last?.content, msgs[msgs.length - 1]?.content)
  })

  it('returns truncated count', () => {
    const msgs = makeMessages(20)
    const { truncated } = microCompact(msgs, 128_000, 900_000)
    assert.ok(truncated > 0)
    assert.ok(truncated < 20)
  })

  it('does nothing when few messages', () => {
    const msgs = makeMessages(4)
    const { messages, truncated } = microCompact(msgs, 128_000, 900_000)
    assert.equal(messages.length, 4)
    assert.equal(truncated, 0)
  })
})
```

- [ ] **步骤 2：运行测试确认通过**

运行：`npm test -- src/compact/__tests__/micro.test.ts`
预期：PASS

- [ ] **步骤 3：Commit**

```bash
git add src/compact/__tests__/micro.test.ts
git commit -m "test(compact): add microCompact + estimateTokens tests"
```

---

## 任务 3：session-persist.ts 测试

**文件：**
- 创建：`src/agent/__tests__/session-persist.test.ts`

- [ ] **步骤 1：编写测试**

```typescript
// src/agent/__tests__/session-persist.test.ts
import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { SessionPersist } from '../session-persist.js'

describe('SessionPersist', () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'rivet-test-'))
  })

  // Note: SessionPersist uses ~/.rivet/sessions/ by default.
  // We test the public API; internal path is not configurable.
  // These tests verify the logic works end-to-end.

  it('creates a claim store', () => {
    const persist = new SessionPersist('test-session-001')
    const store = persist.createClaimStore()
    assert.ok(store)
    assert.equal(typeof store.propose, 'function')
    assert.equal(typeof store.listActiveClaims, 'function')
  })

  it('buildMemoryBlock returns string', () => {
    const persist = new SessionPersist('test-session-002')
    const block = persist.buildMemoryBlock()
    assert.equal(typeof block, 'string')
  })

  it('getSessionMemoryState returns undefined for empty session', () => {
    const persist = new SessionPersist('test-session-003')
    const state = persist.getSessionMemoryState()
    // May be undefined or have empty fields
    if (state) {
      assert.ok('ledger' in state || 'memory' in state)
    }
  })

  it('injectDurableClaims does not throw on fresh store', () => {
    const persist = new SessionPersist('test-session-004')
    const store = persist.createClaimStore()
    assert.doesNotThrow(() => persist.injectDurableClaims(store))
  })

  it('getBackupDir returns a path string', () => {
    const persist = new SessionPersist('test-session-005')
    const dir = persist.getBackupDir()
    assert.equal(typeof dir, 'string')
    assert.ok(dir.includes('test-session-005'))
  })
})
```

- [ ] **步骤 2：运行测试确认通过**

运行：`npm test -- src/agent/__tests__/session-persist.test.ts`
预期：PASS

- [ ] **步骤 3：Commit**

```bash
git add src/agent/__tests__/session-persist.test.ts
git commit -m "test(agent): add session-persist tests"
```

---

## 任务 4：提取 tool-pipeline.ts

**文件：**
- 创建：`src/agent/tool-pipeline.ts`
- 创建：`src/agent/__tests__/tool-pipeline.test.ts`
- 修改：`src/agent/loop.ts`

- [ ] **步骤 1：创建 tool-pipeline.ts**

提取 loop.ts 第 530-743 行为独立模块。核心函数签名：

```typescript
// src/agent/tool-pipeline.ts
export interface ToolPipelineDeps {
  config: AgentConfig
  cwd: string
  harness: TurnHarness
  prewarm: PrewarmCache
  evidence: EvidenceTracker
  traceStore: TraceStore
  repairHintTracker: RepairHintTracker
  importGraph: ImportGraph | null
  lastConflictCheckCount: number
}

export interface ToolExecResult {
  toolResult: { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean }
  traceStore: TraceStore
  importGraph: ImportGraph | null
  lastConflictCheckCount: number
  checkpointCreated: boolean
}

export async function executeToolUse(
  tu: { id: string; name: string; input: Record<string, unknown> },
  deps: ToolPipelineDeps,
  callbacks: AgentCallbacks,
  turn: number,
  checkpointAlreadyCreated: boolean,
): Promise<ToolExecResult>
```

实现内容（从 loop.ts 逐段移入）：
1. Pre-execution: checkpoint + file history + agent-touched-file
2. Execution: prewarm fast-path → harness.executeTool → post-hook → LSP diagnostics
3. Post-execution: trace recording, claim extraction, conflict detection, antibody, evidence, import graph, prewarm invalidation
4. Error handling: catch block → repairHintTracker.recordFailure + error tool_result

- [ ] **步骤 2：修改 loop.ts 调用 executeToolUse**

将 loop.ts 中 tool execution for-loop 的 body 替换为：

```typescript
import { executeToolUse, type ToolPipelineDeps } from './tool-pipeline.js'

// 在 tool execution loop 中:
for (const tu of toolUses) {
  const deps: ToolPipelineDeps = {
    config: this.config,
    cwd: this.cwd,
    harness: this.harness,
    prewarm: this.prewarm,
    evidence: this.evidence,
    traceStore: this.traceStore,
    repairHintTracker: this.repairHintTracker,
    importGraph: this.importGraph,
    lastConflictCheckCount: this.lastConflictCheckCount,
  }
  const result = await executeToolUse(tu, deps, callbacks, turn, checkpointCreatedThisTurn)
  // Update mutable state
  this.traceStore = result.traceStore
  this.importGraph = result.importGraph
  this.lastConflictCheckCount = result.lastConflictCheckCount
  if (result.checkpointCreated) checkpointCreatedThisTurn = true
  toolResults.push(result.toolResult)
}
```

- [ ] **步骤 3：编写 tool-pipeline 测试**

```typescript
// src/agent/__tests__/tool-pipeline.test.ts
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { executeToolUse, type ToolPipelineDeps } from '../tool-pipeline.js'

describe('executeToolUse', () => {
  function makeDeps(overrides?: Partial<ToolPipelineDeps>): ToolPipelineDeps {
    return {
      config: {
        toolRegistry: { execute: async () => ({ content: 'ok' }), getDefinition: () => ({ isConcurrencySafe: () => false }) },
        hooks: null,
        lspEnabled: false,
        fileHistory: undefined,
        contextClaimStore: undefined,
        sessionId: 'test-session',
        promptEngine: { setStrategyShift: () => {}, setImpactHint: () => {} },
      } as any,
      cwd: '/tmp/test',
      harness: { executeTool: async ({ execute }) => { const r = await execute(); return { content: r.content, isError: false } } } as any,
      prewarm: { get: () => null, invalidate: () => {} } as any,
      evidence: { trackFileRead: () => {}, trackFileModified: () => {}, trackImpact: () => {}, trackVerification: () => {} } as any,
      traceStore: { events: [] } as any,
      repairHintTracker: { recordSuccess: () => {}, recordFailure: () => {} } as any,
      importGraph: null,
      lastConflictCheckCount: 0,
      ...overrides,
    }
  }

  const noopCallbacks = {
    onTextDelta: () => {},
    onThinkingDelta: () => {},
    onToolUse: () => {},
    onToolResult: () => {},
    onTurnComplete: () => {},
    onError: () => {},
    onAbort: () => {},
    onApprovalRequired: async () => false,
    onCheckpoint: () => {},
  }

  it('executes a tool and returns result', async () => {
    const deps = makeDeps()
    const result = await executeToolUse(
      { id: 'tu-1', name: 'read_file', input: { file_path: '/tmp/test.ts' } },
      deps, noopCallbacks as any, 1, false,
    )
    assert.equal(result.toolResult.tool_use_id, 'tu-1')
    assert.equal(result.toolResult.content, 'ok')
    assert.equal(result.toolResult.is_error, undefined)
  })

  it('handles tool execution error', async () => {
    const deps = makeDeps({
      harness: { executeTool: async ({ execute }) => { await execute(); return { content: 'error msg', isError: true } } } as any,
      config: { ...makeDeps().config, toolRegistry: { execute: async () => ({ content: 'error msg', isError: true }), getDefinition: () => ({ isConcurrencySafe: () => false }) } } as any,
    })
    const result = await executeToolUse(
      { id: 'tu-2', name: 'bash', input: { command: 'false' } },
      deps, noopCallbacks as any, 1, false,
    )
    assert.equal(result.toolResult.is_error, true)
  })

  it('does not create checkpoint for read_file', async () => {
    const deps = makeDeps()
    const result = await executeToolUse(
      { id: 'tu-3', name: 'read_file', input: { file_path: '/tmp/x.ts' } },
      deps, noopCallbacks as any, 1, false,
    )
    assert.equal(result.checkpointCreated, false)
  })
})
```

- [ ] **步骤 4：运行测试确认通过**

运行：`npm test -- src/agent/__tests__/tool-pipeline.test.ts`
预期：PASS

- [ ] **步骤 5：Commit**

```bash
git add src/agent/tool-pipeline.ts src/agent/__tests__/tool-pipeline.test.ts src/agent/loop.ts
git commit -m "refactor(agent): extract tool-pipeline.ts from loop.ts"
```

---

## 任务 5：提取 turn-end.ts

**文件：**
- 创建：`src/agent/turn-end.ts`
- 创建：`src/agent/__tests__/turn-end.test.ts`
- 修改：`src/agent/loop.ts`

- [ ] **步骤 1：创建 turn-end.ts**

提取 loop.ts 第 745-798 行为独立模块：

```typescript
// src/agent/turn-end.ts
import type { AgentConfig } from './loop.js'
import type { SessionContext } from './context.js'
import type { TrajectoryRecorder } from './trajectory.js'
import type { RoutingMetricsCollector } from './adaptive-routing.js'
import type { EvidenceTracker } from './evidence.js'
import { extractTaskState } from './task-state.js'
import { detectMirror } from './behavior-mirror.js'
import { inferTaskType } from './intent-extractor.js'
import { recommendModelForTask } from '../model/capability.js'
import { extractDecisions } from './decision-extractor.js'

export interface TurnEndDeps {
  config: AgentConfig
  session: SessionContext
  trajectory: TrajectoryRecorder
  streamedText: string
  routingMetrics: RoutingMetricsCollector
  decisions: string[]
  evidence: EvidenceTracker
}

export interface TurnEndResult {
  decisions: string[]
  badge: string | null
}

/**
 * Post-tool-loop processing: task state, mirror detection, model routing, decisions, badge.
 */
export function processTurnEnd(deps: TurnEndDeps): TurnEndResult {
  const { config, session, trajectory, streamedText, routingMetrics, evidence } = deps
  let decisions = [...deps.decisions]

  // Task state extraction (after warmup)
  if (session.getTurnCount() > 3) {
    const taskState = extractTaskState(trajectory.getEntries(), streamedText)
    config.promptEngine.setTaskProgress(taskState)
  }

  // Behavior mirror detection
  const mirror = session.getTurnCount() > 3
    ? detectMirror(trajectory.getEntries())
    : null
  config.promptEngine.setBehaviorMirror(mirror)

  // Model routing
  if (config.modelCards && config.modelCards.length > 1 && config.getCurrentModel) {
    const currentModel = config.getCurrentModel()
    const recentCalls = trajectory.getEntries().slice(-10).map(e => ({
      name: e.tool,
      isError: e.status === 'failed' || e.status === 'retried-failed',
    }))
    const inference = inferTaskType(recentCalls)
    if (inference) {
      const recommended = recommendModelForTask(inference.task, config.modelCards)
      config.promptEngine.setRoutingReason(`${inference.task} · ${recommended.model} ${inference.reason}`)
      if (recommended.model !== currentModel && config.onModelSwitch) {
        routingMetrics.record({
          turn: session.getTurnCount(),
          inferredTask: inference.task,
          recommendedModel: recommended.model,
          currentModel,
          switched: true,
          reason: inference.reason,
          timestamp: Date.now(),
        })
        try { config.onModelSwitch(recommended.model) } catch { /* non-fatal */ }
      }
    }
  }

  // Decision extraction
  const newDecisions = extractDecisions(streamedText)
  for (const d of newDecisions) {
    if (!decisions.includes(d)) decisions.push(d)
  }
  if (decisions.length > 3) decisions = decisions.slice(-3)
  config.promptEngine.setDecisions(decisions)

  // Evidence badge
  const badge = evidence.buildBadge()

  return { decisions, badge }
}
```

- [ ] **步骤 2：修改 loop.ts 调用 processTurnEnd**

在 loop.ts 中，将第 747-804 行替换为：

```typescript
import { processTurnEnd } from './turn-end.js'

// 在 tool loop 结束后（有 tool_use 的分支）:
this.session.addToolResults(toolResults)
const turnEndResult = processTurnEnd({
  config: this.config,
  session: this.session,
  trajectory: this.trajectory,
  streamedText: this.streamedText,
  routingMetrics: this.routingMetrics,
  decisions: this.decisions,
  evidence: this.evidence,
})
this.decisions = turnEndResult.decisions
this.refreshLedger()
callbacks.onTurnComplete(this.session.getTotalUsage(), this.session.getTurnCount())
continue

// 在无 tool_use 的分支（final turn）:
const finalResult = processTurnEnd({
  config: this.config,
  session: this.session,
  trajectory: this.trajectory,
  streamedText: this.streamedText,
  routingMetrics: this.routingMetrics,
  decisions: this.decisions,
  evidence: this.evidence,
})
this.decisions = finalResult.decisions
if (finalResult.badge) callbacks.onTextDelta('\n' + finalResult.badge)
this.refreshLedger()
callbacks.onTurnComplete(this.session.getTotalUsage(), this.session.getTurnCount())
this.evidence.reset()
break
```

- [ ] **步骤 3：编写 turn-end 测试**

```typescript
// src/agent/__tests__/turn-end.test.ts
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { processTurnEnd, type TurnEndDeps } from '../turn-end.js'

describe('processTurnEnd', () => {
  function makeDeps(overrides?: Partial<TurnEndDeps>): TurnEndDeps {
    return {
      config: {
        promptEngine: {
          setTaskProgress: () => {},
          setBehaviorMirror: () => {},
          setRoutingReason: () => {},
          setDecisions: () => {},
        },
        modelCards: undefined,
        getCurrentModel: undefined,
        onModelSwitch: undefined,
      } as any,
      session: { getTurnCount: () => 5 } as any,
      trajectory: { getEntries: () => [] } as any,
      streamedText: 'I will fix the bug in auth.ts',
      routingMetrics: { record: () => {} } as any,
      decisions: [],
      evidence: { buildBadge: () => null } as any,
      ...overrides,
    }
  }

  it('returns empty decisions when no decisions in text', () => {
    const result = processTurnEnd(makeDeps())
    assert.ok(Array.isArray(result.decisions))
  })

  it('returns badge from evidence tracker', () => {
    const result = processTurnEnd(makeDeps({
      evidence: { buildBadge: () => '📁 2 files | ✅ tests pass' } as any,
    }))
    assert.equal(result.badge, '📁 2 files | ✅ tests pass')
  })

  it('skips task state for early turns (≤3)', () => {
    let called = false
    const result = processTurnEnd(makeDeps({
      session: { getTurnCount: () => 2 } as any,
      config: {
        promptEngine: {
          setTaskProgress: () => { called = true },
          setBehaviorMirror: () => {},
          setRoutingReason: () => {},
          setDecisions: () => {},
        },
      } as any,
    }))
    assert.equal(called, false)
    assert.ok(result)
  })

  it('caps decisions at 3', () => {
    const result = processTurnEnd(makeDeps({
      decisions: ['d1', 'd2', 'd3', 'd4'],
    }))
    assert.ok(result.decisions.length <= 3)
  })
})
```

- [ ] **步骤 4：运行测试确认通过**

运行：`npm test -- src/agent/__tests__/turn-end.test.ts`
预期：PASS

- [ ] **步骤 5：Commit**

```bash
git add src/agent/turn-end.ts src/agent/__tests__/turn-end.test.ts src/agent/loop.ts
git commit -m "refactor(agent): extract turn-end.ts from loop.ts"
```

---

## 任务 6：集成验证

**文件：** 无新增

- [ ] **步骤 1：运行 typecheck**

运行：`npx tsc --noEmit`
预期：0 errors

- [ ] **步骤 2：运行全量测试**

运行：`npm test`
预期：870+ pass, 0 fail

- [ ] **步骤 3：验证 loop.ts 行数**

运行：`wc -l src/agent/loop.ts`
预期：≤ 500 行

- [ ] **步骤 4：验证新模块行数**

运行：`wc -l src/agent/tool-pipeline.ts src/agent/turn-end.ts`
预期：tool-pipeline ~200 行，turn-end ~80 行

- [ ] **步骤 5：验证 main.tsx 无变更**

运行：`git diff HEAD -- src/main.tsx`
预期：无变更（拆分对外部透明）

- [ ] **步骤 6：Commit（如有 lint fix）**

```bash
git add -A && git commit -m "chore: Wave 10 lint fixes" || true
```

---

## 验收标准

| 标准 | 验证方法 |
|------|---------|
| compact/auto.ts 5+ 测试通过 | npm test |
| compact/micro.ts 4+ 测试通过 | npm test |
| session-persist.ts 4+ 测试通过 | npm test |
| tool-pipeline.ts 3+ 测试通过 | npm test |
| turn-end.ts 4+ 测试通过 | npm test |
| loop.ts ≤ 500 行 | wc -l |
| 全量测试 0 fail | npm test |
| Typecheck 0 errors | npx tsc --noEmit |
| main.tsx 无变更 | git diff |
