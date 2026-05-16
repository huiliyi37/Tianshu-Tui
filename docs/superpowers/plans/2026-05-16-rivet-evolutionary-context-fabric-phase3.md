# Evolutionary Context Fabric Phase 3 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 在 Phase 2 的 claim lifecycle 基础上，实现 worker claim 归因、failure/security antibody 生成、claim conflict 检测、以及 approval-risk 消费 antibody 信号。让子代理不再只是"返回文本"，而是贡献可检验的知识；让重复失败和安全风险形成保护性免疫记忆。

**架构：** Phase 3 不引入新存储后端。复用现有 `ContextClaimStore` JSONL 事件流，增加三个 claim 来源（worker findings 归因加强、failure-classifier antibody、trace-store 重复模式检测），以及两个消费者（approval-risk antibody boost、conflict detection gate）。Cockpit 增加 conflict/antibody drill-down。

**技术栈：** TypeScript, node:test, existing ClaimStore/TraceStore/failure-classifier/approval-risk/coordinator/delegate-task infrastructure.

**前置条件：** Phase 2 已完成（claim lifecycle + staleness + observability）✅

---

## Scope

### 本计划包含

- Worker claim 归因加强：给 delegate-task 产生的 worker_finding claim 补上文件 evidence path。
- Failure antibody：bash/test 工具失败后，failure-classifier 产生 `failure_pattern` claim 作为 antibody。
- Conflict detection：同一文件两个 active claim 语义矛盾时标记 `conflicted`。
- Approval-risk antibody boost：assessToolRisk 读取 active `failure_pattern` claims，相似操作提高风险等级。
- Cockpit/TUI 面板：`/context antibodies` 列出 failure_pattern claims；conflict 面板展示冲突 claims。
- P2 审查遗留修复：`evaluatePromotion` 使用 unique consumer count 而非 `consumers.length`。

### 本计划不包含

- SQLite/WAL/vector。
- 跨 session global memory。
- 交互式 conflict adjudication（用户手动 resolve）。
- Security finding 自动提取（需要 hook 系统支持，属于 Phase 4）。
- Worker prompt 中注入 parent claims（需要更复杂的 prompt assembly）。

---

## 文件结构

### 新建文件

| 文件 | 职责 |
|------|------|
| `src/context/antibody.ts` | Antibody claim 生成：从 ClassifiedFailure 和 TraceEvent 转 ClaimProposal |
| `src/context/conflict-detect.ts` | Conflict detection：同文件多 claim 冲突标记 |
| `src/context/__tests__/antibody.test.ts` | Antibody 生成测试 |
| `src/context/__tests__/conflict-detect.test.ts` | Conflict detection 测试 |

### 修改文件

| 文件 | 变更 |
|------|------|
| `src/context/promotion.ts` | `evaluatePromotion` 使用 unique consumer IDs |
| `src/context/__tests__/promotion.test.ts` | 覆盖重复 consumer 不提前晋升 |
| `src/agent/loop.ts` | 工具失败后调用 antibody 生成；每轮前跑 conflict detection |
| `src/agent/__tests__/loop.test.ts` | 覆盖 antibody 产生和 conflict 标记 |
| `src/agent/approval-risk.ts` | 增加 antibody claims 参数，匹配时 boost risk |
| `src/agent/__tests__/approval-risk.test.ts` | 新建，覆盖 antibody boost |
| `src/tools/delegate-task.ts` | Worker finding claim 追加 file evidence path |
| `src/tui/slash-commands.ts` | 增加 `/context antibodies` 和 `/context conflicts` |

---

## 任务 1：修复 P2 遗留 — unique consumer promotion

**文件：**
- 修改：`src/context/promotion.ts`
- 修改：`src/context/__tests__/promotion.test.ts`

- [ ] **步骤 1：编写失败测试**

在 `src/context/__tests__/promotion.test.ts` 追加：

```ts
test('does not promote when consumers are duplicates of same turn', () => {
  const result = evaluatePromotion(claim({
    consumers: [
      { id: 'turn-1:prompt', kind: 'prompt', usedAt: 1 },
      { id: 'turn-1:prompt', kind: 'prompt', usedAt: 1 },
      { id: 'turn-1:prompt', kind: 'prompt', usedAt: 1 },
    ],
  }), 4)

  assert.equal(result, null)
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npm test -- src/context/__tests__/promotion.test.ts`
预期：FAIL（当前 `consumers.length >= 3` 返回 `durable_candidate`）

- [ ] **步骤 3：修改 evaluatePromotion 使用 unique count**

修改 `src/context/promotion.ts`：

```ts
export function evaluatePromotion(claim: ContextClaim, now = Date.now()): ContextClaimStatus | null {
  if (claim.status !== 'active') return null
  if (!isPromptEligibleClaim(claim, now)) return null
  if (claim.counterevidence.length > 0) return null
  const uniqueConsumers = new Set(claim.consumers.map(c => c.id)).size
  if (uniqueConsumers < 3) return null
  return 'durable_candidate'
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`npm test -- src/context/__tests__/promotion.test.ts`
预期：PASS

- [ ] **步骤 5：Commit**

```bash
git add src/context/promotion.ts src/context/__tests__/promotion.test.ts
git commit -m "fix(context): use unique consumer IDs for promotion threshold"
```

---

## 任务 2：Antibody claim 生成

**文件：**
- 创建：`src/context/antibody.ts`
- 创建：`src/context/__tests__/antibody.test.ts`

- [ ] **步骤 1：编写失败测试**

创建 `src/context/__tests__/antibody.test.ts`：

```ts
import test from 'node:test'
import assert from 'node:assert/strict'
import { createAntibodyProposal } from '../antibody.js'
import type { ClassifiedFailure } from '../../agent/failure-classifier.js'

test('creates failure_pattern claim from classified failure', () => {
  const failure: ClassifiedFailure = {
    class: 'type_error',
    suggestion: 'Fix type annotation or interface. Do not change business logic.',
    confidence: 0.9,
    retryable: false,
  }

  const proposal = createAntibodyProposal(failure, {
    toolName: 'bash',
    command: 'npx tsc --noEmit',
    sessionId: 'session-1',
    turn: 5,
    eventId: 'turn-5:bash:tsc',
  })

  assert.equal(proposal.kind, 'failure_pattern')
  assert.equal(proposal.scope, 'session')
  assert.ok(proposal.text.includes('type_error'))
  assert.ok(proposal.text.includes('Fix type annotation'))
  assert.equal(proposal.confidence, 0.9)
  assert.equal(proposal.evidence[0]?.kind, 'tool_result')
  assert.deepEqual(proposal.tags, ['antibody', 'type_error'])
})

test('retryable failures get lower fitness', () => {
  const retryable: ClassifiedFailure = {
    class: 'timeout',
    suggestion: 'Check for infinite loops.',
    confidence: 0.8,
    retryable: true,
  }

  const proposal = createAntibodyProposal(retryable, {
    toolName: 'bash',
    command: 'npm test',
    sessionId: 'session-1',
    turn: 3,
    eventId: 'turn-3:bash:test',
  })

  assert.equal(proposal.fitness, 2)
})

test('non-retryable failures get higher fitness', () => {
  const nonRetryable: ClassifiedFailure = {
    class: 'module_resolution',
    suggestion: 'Check import path.',
    confidence: 0.9,
    retryable: false,
  }

  const proposal = createAntibodyProposal(nonRetryable, {
    toolName: 'bash',
    command: 'npx tsc --noEmit',
    sessionId: 'session-1',
    turn: 4,
    eventId: 'turn-4:bash:tsc',
  })

  assert.equal(proposal.fitness, 5)
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npm test -- src/context/__tests__/antibody.test.ts`
预期：FAIL（模块不存在）

- [ ] **步骤 3：实现 antibody.ts**

创建 `src/context/antibody.ts`：

```ts
import type { ClassifiedFailure } from '../agent/failure-classifier.js'
import type { ClaimProposal } from './claims.js'

export interface AntibodyContext {
  toolName: string
  command?: string
  sessionId: string
  turn: number
  eventId: string
}

export function createAntibodyProposal(failure: ClassifiedFailure, ctx: AntibodyContext): ClaimProposal {
  const createdAt = Date.now()
  return {
    kind: 'failure_pattern',
    scope: 'session',
    text: `[${failure.class}] ${failure.suggestion}`,
    confidence: failure.confidence,
    fitness: failure.retryable ? 2 : 5,
    source: { actor: 'tool', sessionId: ctx.sessionId, turn: ctx.turn, eventId: ctx.eventId },
    evidence: [{
      id: `${ctx.eventId}:failure`,
      kind: 'tool_result',
      summary: `${ctx.toolName}: ${failure.class}${ctx.command ? ` (${ctx.command.slice(0, 80)})` : ''}`,
      createdAt,
    }],
    createdAt,
    tags: ['antibody', failure.class],
  }
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`npm test -- src/context/__tests__/antibody.test.ts`
预期：PASS

- [ ] **步骤 5：Commit**

```bash
git add src/context/antibody.ts src/context/__tests__/antibody.test.ts
git commit -m "feat(context): antibody claim generation from classified failures"
```

---

## 任务 3：Conflict detection

**文件：**
- 创建：`src/context/conflict-detect.ts`
- 创建：`src/context/__tests__/conflict-detect.test.ts`

- [ ] **步骤 1：编写失败测试**

创建 `src/context/__tests__/conflict-detect.test.ts`：

```ts
import test from 'node:test'
import assert from 'node:assert/strict'
import { detectConflicts } from '../conflict-detect.js'
import type { ContextClaim } from '../claims.js'

function claim(overrides: Partial<ContextClaim>): ContextClaim {
  return {
    id: 'c1',
    kind: 'file_observation',
    scope: 'session',
    status: 'active',
    text: 'config uses port 3000',
    confidence: 0.8,
    fitness: 4,
    source: { actor: 'tool', sessionId: 's1', turn: 1, eventId: 'e1' },
    evidence: [{ id: 'f1', kind: 'file', summary: 'read config', path: '/repo/config.ts', createdAt: 1 }],
    counterevidence: [],
    consumers: [],
    createdAt: 1,
    lastUsedAt: 1,
    tags: [],
    ...overrides,
  }
}

test('detects conflict when two active claims share file evidence but contradict', () => {
  const a = claim({ id: 'c1', text: 'config uses port 3000', createdAt: 1 })
  const b = claim({ id: 'c2', text: 'config uses port 8080', createdAt: 5 })

  const conflicts = detectConflicts([a, b])

  assert.equal(conflicts.length, 1)
  assert.deepEqual(conflicts[0], { olderClaimId: 'c1', newerClaimId: 'c2', sharedPath: '/repo/config.ts' })
})

test('does not conflict claims on different files', () => {
  const a = claim({ id: 'c1', evidence: [{ id: 'f1', kind: 'file', summary: 'a', path: '/a.ts', createdAt: 1 }] })
  const b = claim({ id: 'c2', evidence: [{ id: 'f2', kind: 'file', summary: 'b', path: '/b.ts', createdAt: 2 }] })

  assert.deepEqual(detectConflicts([a, b]), [])
})

test('does not conflict non-file-observation claims', () => {
  const a = claim({ id: 'c1', kind: 'user_constraint' })
  const b = claim({ id: 'c2', kind: 'user_constraint' })

  assert.deepEqual(detectConflicts([a, b]), [])
})

test('does not conflict claims already stale or quarantined', () => {
  const a = claim({ id: 'c1', status: 'stale' })
  const b = claim({ id: 'c2' })

  assert.deepEqual(detectConflicts([a, b]), [])
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npm test -- src/context/__tests__/conflict-detect.test.ts`
预期：FAIL（模块不存在）

- [ ] **步骤 3：实现 conflict-detect.ts**

创建 `src/context/conflict-detect.ts`：

```ts
import type { ContextClaim } from './claims.js'

export interface ClaimConflict {
  olderClaimId: string
  newerClaimId: string
  sharedPath: string
}

const CONFLICTABLE_KINDS: ContextClaim['kind'][] = ['file_observation', 'verification_fact']
const ACTIVE_STATUSES: ContextClaim['status'][] = ['active', 'durable_candidate', 'durable']

export function detectConflicts(claims: ContextClaim[]): ClaimConflict[] {
  const eligible = claims.filter(c => CONFLICTABLE_KINDS.includes(c.kind) && ACTIVE_STATUSES.includes(c.status))
  const byPath = new Map<string, ContextClaim[]>()

  for (const claim of eligible) {
    for (const ev of claim.evidence) {
      if (!ev.path) continue
      const group = byPath.get(ev.path) ?? []
      group.push(claim)
      byPath.set(ev.path, group)
    }
  }

  const conflicts: ClaimConflict[] = []
  for (const [path, group] of byPath) {
    if (group.length < 2) continue
    const sorted = group.sort((a, b) => a.createdAt - b.createdAt)
    for (let i = 0; i < sorted.length - 1; i++) {
      conflicts.push({
        olderClaimId: sorted[i]!.id,
        newerClaimId: sorted[i + 1]!.id,
        sharedPath: path,
      })
    }
  }
  return conflicts
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`npm test -- src/context/__tests__/conflict-detect.test.ts`
预期：PASS

- [ ] **步骤 5：Commit**

```bash
git add src/context/conflict-detect.ts src/context/__tests__/conflict-detect.test.ts
git commit -m "feat(context): detect conflicting file-evidence claims on same path"
```

---

## 任务 4：AgentLoop 接线 — antibody 生成 + conflict 标记

**文件：**
- 修改：`src/agent/loop.ts`
- 修改：`src/agent/__tests__/loop.test.ts`

- [ ] **步骤 1：编写失败测试**

在 `src/agent/__tests__/loop.test.ts` 追加：

```ts
describe('AgentLoop — antibody generation', () => {
  it('generates failure_pattern claim after bash tool error with classifiable failure', async () => {
    const session = new SessionContext()
    const registry = new ToolRegistry()
    const engine = makeEngine()
    const claimDir = mkdtempSync(join(tmpdir(), 'rivet-loop-antibody-'))
    const claimStore = new ContextClaimStore(claimDir, 'session-ab')

    let toolCalled = false
    const client: ApiClient = {
      stream: mock.fn(async (_req: unknown, cb: StreamCallbacks, _sig?: AbortSignal) => {
        if (!toolCalled) {
          toolCalled = true
          cb.onContentBlock({ type: 'tool_use', id: 'tu1', name: 'bash', input: { command: 'npx tsc --noEmit' } } as ContentBlock)
          cb.onStopReason('tool_use', { input_tokens: 100, output_tokens: 50 })
          return
        }
        cb.onContentBlock(makeTextBlock('done'))
        cb.onStopReason('end_turn', { input_tokens: 100, output_tokens: 50 })
      }),
    } as unknown as ApiClient

    registry.register({
      name: 'bash',
      description: 'run bash',
      parameters: { type: 'object', properties: { command: { type: 'string' } } },
      execute: async () => ({ content: 'error TS2345: Type \'string\' is not assignable to type \'number\'', isError: true }),
    })

    const agent = new AgentLoop({
      client, promptEngine: engine, toolRegistry: registry,
      maxTurns: 2, contextWindow: 1_000_000,
      compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' },
      sessionId: 'session-ab', contextClaimStore: claimStore,
    }, session, '/test')

    await agent.run('fix types', {
      onTextDelta: () => {}, onThinkingDelta: () => {},
      onToolUse: () => {}, onToolResult: () => {},
      onError: () => {}, onAbort: () => {},
      onTurnComplete: () => {}, onApprovalRequired: async () => true,
    })

    const antibodies = claimStore.listClaims({ kind: ['failure_pattern'] })
    assert.ok(antibodies.length >= 1)
    assert.ok(antibodies[0]?.tags.includes('antibody'))
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npm test -- src/agent/__tests__/loop.test.ts`
预期：FAIL（antibody 生成逻辑不存在）

- [ ] **步骤 3：在 loop.ts 工具失败路径添加 antibody 生成**

在 `src/agent/loop.ts` 中，在工具执行失败后（`harnessResult.isError` 为 true 的分支），添加：

```ts
import { createAntibodyProposal } from '../context/antibody.js'
import { classifyFailure } from './failure-classifier.js'
import { detectConflicts } from '../context/conflict-detect.js'
```

在工具结果处理的 `isError` 分支中：

```ts
if (harnessResult.isError && this.config.contextClaimStore && this.config.sessionId) {
  const errorText = typeof harnessResult.content === 'string' ? harnessResult.content : ''
  if (errorText.length > 20) {
    const failure = classifyFailure(errorText)
    if (failure.class !== 'unknown') {
      const proposal = createAntibodyProposal(failure, {
        toolName: tu.name,
        command: typeof tu.input.command === 'string' ? tu.input.command : undefined,
        sessionId: this.config.sessionId,
        turn: this.session.getTurnCount(),
        eventId: `turn-${this.session.getTurnCount()}:${tu.name}:${tu.id}`,
      })
      this.config.contextClaimStore.propose(proposal)
    }
  }
}
```

- [ ] **步骤 4：在 refreshActiveClaims 中添加 conflict detection**

在 `refreshActiveClaims()` 中，promotion 之后、projection 之前：

```ts
const allClaims = this.config.contextClaimStore.listClaims()
const conflicts = detectConflicts(allClaims)
for (const conflict of conflicts) {
  this.config.contextClaimStore.updateClaimStatus(
    conflict.olderClaimId, 'conflicted',
    `superseded by newer observation ${conflict.newerClaimId} on ${conflict.sharedPath}`,
  )
}
```

- [ ] **步骤 5：运行测试验证通过**

运行：`npm test -- src/agent/__tests__/loop.test.ts`
预期：PASS

- [ ] **步骤 6：运行全部测试**

运行：`npm test`
预期：全部通过（800+）

- [ ] **步骤 7：Commit**

```bash
git add src/agent/loop.ts src/agent/__tests__/loop.test.ts
git commit -m "feat(context): wire antibody generation + conflict detection into agent loop"
```

---

## 任务 5：Approval-risk antibody boost

**文件：**
- 修改：`src/agent/approval-risk.ts`
- 创建：`src/agent/__tests__/approval-risk.test.ts`

- [ ] **步骤 1：编写失败测试**

创建 `src/agent/__tests__/approval-risk.test.ts`：

```ts
import test from 'node:test'
import assert from 'node:assert/strict'
import { assessToolRisk } from '../approval-risk.js'
import type { ContextClaim } from '../../context/claims.js'

function antibodyClaim(text: string): ContextClaim {
  return {
    id: 'ab1',
    kind: 'failure_pattern',
    scope: 'session',
    status: 'active',
    text,
    confidence: 0.9,
    fitness: 5,
    source: { actor: 'tool', sessionId: 's1', turn: 1, eventId: 'e1' },
    evidence: [{ id: 'ev1', kind: 'tool_result', summary: text, createdAt: 1 }],
    counterevidence: [],
    consumers: [],
    createdAt: 1,
    lastUsedAt: 1,
    tags: ['antibody', 'type_error'],
  }
}

test('boosts risk when antibody matches tool name in evidence', () => {
  const antibodies = [antibodyClaim('[type_error] Fix type annotation. Do not change business logic.')]

  const result = assessToolRisk('bash', { command: 'npx tsc --noEmit' }, 'none', antibodies)

  assert.equal(result.level, 'low')
  assert.ok(result.reasons.some(r => r.includes('antibody')))
})

test('no boost when no antibodies match', () => {
  const antibodies = [antibodyClaim('[module_resolution] Check import path.')]

  const result = assessToolRisk('read_file', { file_path: '/a.ts' }, 'none', antibodies)

  assert.equal(result.level, 'none')
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npm test -- src/agent/__tests__/approval-risk.test.ts`
预期：FAIL（`assessToolRisk` 不接受 4th 参数）

- [ ] **步骤 3：修改 approval-risk.ts 增加 antibodies 参数**

修改 `src/agent/approval-risk.ts` 的 `assessToolRisk` 签名：

```ts
import type { ContextClaim } from '../context/claims.js'

export function assessToolRisk(
  toolName: string,
  input: Record<string, unknown>,
  doomLoopLevel: 'none' | 'warn' | 'blocked' = 'none',
  antibodies: ContextClaim[] = [],
): RiskAssessment {
  // ... existing logic ...

  // Antibody boost: if a failure_pattern claim's evidence mentions the same tool
  for (const ab of antibodies) {
    const evidenceSummary = ab.evidence[0]?.summary ?? ''
    if (evidenceSummary.includes(toolName)) {
      reasons.push(`antibody match: ${ab.text.slice(0, 60)}`)
      if (level === 'none') level = 'low'
      break
    }
  }

  // ... return ...
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`npm test -- src/agent/__tests__/approval-risk.test.ts`
预期：PASS

- [ ] **步骤 5：运行全部测试确认无 regression**

运行：`npm test`
预期：全部通过

- [ ] **步骤 6：Commit**

```bash
git add src/agent/approval-risk.ts src/agent/__tests__/approval-risk.test.ts
git commit -m "feat(context): approval-risk reads antibody claims to boost risk on repeat failures"
```

---

## 任务 6：Worker finding file evidence 加强

**文件：**
- 修改：`src/tools/delegate-task.ts`

- [ ] **步骤 1：修改 delegate-task 的 claim proposal 补上文件路径**

在 `src/tools/delegate-task.ts` 的 worker finding → claim 循环中，追加 `changedFiles` 作为 evidence path：

```ts
for (const result of run.results) {
  if (result.status !== 'passed') continue
  for (const finding of result.findings) {
    const claimText = typeof finding === 'string' ? finding : finding.claim
    const evidencePaths = result.changedFiles.slice(0, 3)
    const proposal: ClaimProposal = {
      kind: 'worker_finding',
      scope: 'session',
      text: claimText,
      confidence: finding.confidence === 'high' ? 0.85 : finding.confidence === 'medium' ? 0.7 : 0.55,
      fitness: finding.confidence === 'high' ? 5 : finding.confidence === 'medium' ? 3 : 2,
      source: { actor: 'worker', sessionId: sid, turn: 0, eventId: `${params.toolUseId}:worker` },
      evidence: [{
        id: `${params.toolUseId}:finding`,
        kind: 'worker',
        summary: typeof finding === 'string' ? finding : finding.evidence,
        path: evidencePaths[0],
        createdAt,
      }],
      createdAt,
      tags: ['worker', result.workOrderId],
    }
    claimStore.propose(proposal)
  }
}
```

- [ ] **步骤 2：运行 typecheck**

运行：`npx tsc --noEmit`
预期：无错误

- [ ] **步骤 3：运行全部测试**

运行：`npm test`
预期：全部通过

- [ ] **步骤 4：Commit**

```bash
git add src/tools/delegate-task.ts
git commit -m "feat(context): worker finding claims include file evidence path + confidence mapping"
```

---

## 任务 7：TUI slash commands — /context antibodies + /context conflicts

**文件：**
- 修改：`src/tui/slash-commands.ts`

- [ ] **步骤 1：添加 /context antibodies handler**

在 `/context` 的 args 处理 switch 中添加：

```ts
if (args === 'antibodies') {
  const store = slashCtx.claimStoreRef.current
  if (!store) { pushStatic({ type: 'info', content: 'Claim store not available' }); return true }
  const antibodies = store.listClaims({ kind: ['failure_pattern'], status: ['active', 'durable_candidate', 'durable'] })
  if (antibodies.length === 0) { pushStatic({ type: 'info', content: 'No active antibodies' }); return true }
  const lines = antibodies.map(c => `  [${c.tags.filter(t => t !== 'antibody')[0] ?? c.kind}] ${c.text.slice(0, 80)}`)
  pushStatic({ type: 'info', content: `Antibodies (${antibodies.length}):\n${lines.join('\n')}` })
  return true
}

if (args === 'conflicts') {
  const store = slashCtx.claimStoreRef.current
  if (!store) { pushStatic({ type: 'info', content: 'Claim store not available' }); return true }
  const conflicted = store.listClaims({ status: ['conflicted'] })
  if (conflicted.length === 0) { pushStatic({ type: 'info', content: 'No conflicted claims' }); return true }
  const lines = conflicted.map(c => `  [${c.id.slice(0, 8)}] ${c.text.slice(0, 80)}`)
  pushStatic({ type: 'info', content: `Conflicts (${conflicted.length}):\n${lines.join('\n')}` })
  return true
}
```

- [ ] **步骤 2：运行 typecheck**

运行：`npx tsc --noEmit`
预期：无错误

- [ ] **步骤 3：运行全部测试**

运行：`npm test`
预期：全部通过

- [ ] **步骤 4：Commit**

```bash
git add src/tui/slash-commands.ts
git commit -m "feat(tui): /context antibodies and /context conflicts slash commands"
```

---

## 任务 8：AgentLoop 调用 assessToolRisk 时传入 antibodies

**文件：**
- 修改：`src/agent/loop.ts`

- [ ] **步骤 1：在 assessToolRisk 调用处传入 failure_pattern claims**

在 `src/agent/loop.ts` 中调用 `assessToolRisk` 的位置（tool approval 流程），增加第 4 个参数：

```ts
const antibodies = this.config.contextClaimStore?.listClaims({ kind: ['failure_pattern'], status: ['active', 'durable_candidate', 'durable'] }) ?? []
const risk = assessToolRisk(tu.name, tu.input as Record<string, unknown>, this.getDoomLoopLevel(), antibodies)
```

- [ ] **步骤 2：运行 typecheck + test**

运行：`npx tsc --noEmit && npm test`
预期：全部通过

- [ ] **步骤 3：Commit**

```bash
git add src/agent/loop.ts
git commit -m "feat(context): pass antibody claims to approval-risk for repeat-failure detection"
```

---

## 验收标准

| 标准 | 验证方法 |
|------|---------|
| Duplicate consumer IDs 不提前晋升 | `evaluatePromotion` 测试：3 个重复 consumer → null |
| Bash 失败产生 failure_pattern claim | Loop 测试：tsc error → antibody in claim store |
| 同文件两个 active file_observation → older 标记 conflicted | Conflict detection 测试 |
| assessToolRisk 读取 antibodies 并 boost | approval-risk 测试：matching antibody → level='low' |
| Worker finding 带 file evidence path | delegate-task 写入的 claim.evidence[0].path 非空 |
| `/context antibodies` 列出 active failure_pattern claims | 手动验证 |
| `/context conflicts` 列出 conflicted claims | 手动验证 |
| 所有测试通过 | `npm test`: 800+ pass, 0 fail |
| Typecheck 通过 | `npx tsc --noEmit`: 无错误 |

---

## 风险与防线

| 风险 | 应对 |
|------|------|
| Antibody 产生过多（每次 tsc 失败都记录） | 同一 `failure.class` + 同一 turn 只生成一个 antibody（用 eventId dedup） |
| Conflict detection O(n²) on large claim sets | Phase 3 scope 内 claim 数量 <100，可接受；Phase 4 如果需要可加索引 |
| approval-risk 签名变更破坏现有调用 | 新参数默认 `[]`，现有调用无需改动 |
| Worker finding confidence 映射丢失粒度 | 三级 low/medium/high → 0.55/0.7/0.85 足够 Phase 3 |
