# Rivet Execution Trust Closure 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 将 Rivet 已有 trace、risk、evidence、strategy-shift、repair、sub-agent contract、cockpit 能力串成“可诊断、可阻断、可恢复、可证明交付可信”的执行闭环。

**架构：** 新增 delivery gate、retry policy、execution guidance、worker evidence verifier、MCP policy 等小型独立模块；现有 `AgentLoop`、`TurnHarness`、`EvidenceTracker`、`DelegationCoordinator`、`CockpitSnapshot` 只接入这些明确接口。P0 先保证交付状态、重试安全、doom-loop guidance 和子代理 evidence 不再只是记录，而会约束执行与交付。

**技术栈：** TypeScript, Node.js 22, zod, node:test, Ink cockpit state model, existing Rivet tool registry and agent loop.

---

## 文件结构

### 新增文件

- `src/agent/delivery-gate.ts` — 根据 `EvidenceState` 生成最终交付判定和可附加到最终回复的交付说明。
- `src/agent/__tests__/delivery-gate.test.ts` — 覆盖 verified / failed / blocked / unverified 的交付判定。
- `src/agent/retry-policy.ts` — 将 failure class、tool name、`Tool.isConcurrencySafe()`、MCP write 风险合并为确定性 retry 决策。
- `src/agent/__tests__/retry-policy.test.ts` — 覆盖 transient 但 unsafe tool 不 retry、safe tool retry、write/edit 不 retry。
- `src/agent/execution-guidance.ts` — 生成 anchor-first strategy shift guidance。
- `src/agent/__tests__/execution-guidance.test.ts` — 覆盖 repeated edit failure、writes without verification、transient failures。
- `src/agent/worker-evidence.ts` — 对 `WorkerResult` 做 independent evidence verification，并去重 aggregation risk。
- `src/agent/__tests__/worker-evidence.test.ts` — 覆盖 worker 自报 verified 但缺 metadata、failed verification、risk 去重。
- `src/mcp/policy.ts` — MCP allow / confirm / block / require policy evaluator。
- `src/mcp/__tests__/policy.test.ts` — 覆盖 unknown write MCP tool、allowlist、blocklist、mustlist。

### 修改文件

- `src/agent/evidence.ts` — 使用 delivery gate，输出更明确的 evidence badge 文案。
- `src/agent/turn-harness.ts` — 通过 retry policy 决定是否重试，而不是只看 failure class。
- `src/agent/loop.ts` — 在 warn 阶段注入 soft guidance，在 blocked 阶段阻断；接入 repair telemetry 和 delivery gate。
- `src/agent/strategy-shift.ts` — 保留 public API，内部改为调用 `execution-guidance.ts`，避免破坏现有调用点。
- `src/agent/aggregation.ts` — 改用 `verifyWorkerEvidence()`，避免重复追加同一 risk。
- `src/agent/coordinator.ts` — 保持 delegate 单 worker 和 batch 都走统一 worker evidence gate。
- `src/agent/repair-pipeline.ts` — 增加 telemetry summary helper。
- `src/prompt/volatile.ts` — 确保 `repairHint` 被渲染到 latest-turn volatile block。
- `src/tui/cockpit/types.ts` — `CockpitSnapshot` 增加 `intent`、`blockingReason`、`nextAction`。
- `src/tui/cockpit/state.ts` — 从 evidence / safety / context / MCP 状态推导 guidance fields。
- `src/tui/cockpit/__tests__/state.test.ts` — 覆盖 new cockpit guidance fields。

### 相关验证命令

- `npm run typecheck`
- `npm test`
- `npm run build`
- 单测按文件运行：`npx tsx --test src/agent/__tests__/delivery-gate.test.ts`

---

## 任务 1：Final delivery gate

**文件：**
- 创建：`src/agent/delivery-gate.ts`
- 创建：`src/agent/__tests__/delivery-gate.test.ts`
- 修改：`src/agent/evidence.ts`

- [ ] **步骤 1：编写失败的 delivery gate 测试**

创建 `src/agent/__tests__/delivery-gate.test.ts`：

```ts
import test from 'node:test'
import assert from 'node:assert/strict'
import type { EvidenceState } from '../evidence.js'
import { buildDeliveryGate } from '../delivery-gate.js'

function state(overrides: Partial<EvidenceState>): EvidenceState {
  return {
    filesRead: new Set(),
    filesModified: new Set(),
    verifications: [],
    deliveryStatus: 'unverified',
    impactedFiles: new Set(),
    impactedTests: new Set(),
    ...overrides,
  }
}

test('allows verified delivery after modified files have passed verification', () => {
  const result = buildDeliveryGate(state({
    filesModified: new Set(['src/a.ts']),
    deliveryStatus: 'verified',
    verifications: [{
      command: 'npm test',
      status: 'passed',
      scope: 'targeted',
      exitCode: 0,
      passed: 3,
      failed: 0,
      skipped: 0,
      durationMs: 12,
    }],
  }))

  assert.equal(result.status, 'verified')
  assert.equal(result.canClaimComplete, true)
  assert.equal(result.severity, 'ok')
})

test('marks modified files without verification as unverified delivery', () => {
  const result = buildDeliveryGate(state({
    filesModified: new Set(['src/a.ts']),
    deliveryStatus: 'unverified',
  }))

  assert.equal(result.status, 'unverified')
  assert.equal(result.canClaimComplete, false)
  assert.equal(result.severity, 'warn')
  assert.match(result.message, /Unverified changes/)
  assert.match(result.message, /src\/a\.ts/)
})

test('marks failed verification as failed delivery', () => {
  const result = buildDeliveryGate(state({
    filesModified: new Set(['src/a.ts']),
    deliveryStatus: 'failed',
    verifications: [{
      command: 'npm test',
      status: 'failed',
      scope: 'targeted',
      exitCode: 1,
      passed: 1,
      failed: 2,
      skipped: 0,
      durationMs: 22,
    }],
  }))

  assert.equal(result.status, 'failed')
  assert.equal(result.canClaimComplete, false)
  assert.equal(result.severity, 'error')
  assert.match(result.message, /Verification failed/)
  assert.match(result.message, /npm test/)
})

test('does not require verification for read-only analysis', () => {
  const result = buildDeliveryGate(state({
    filesRead: new Set(['src/a.ts']),
    deliveryStatus: 'unverified',
  }))

  assert.equal(result.status, 'verified')
  assert.equal(result.canClaimComplete, true)
  assert.equal(result.severity, 'ok')
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：

```bash
npx tsx --test src/agent/__tests__/delivery-gate.test.ts
```

预期：FAIL，报错包含：

```text
Cannot find module '../delivery-gate.js'
```

- [ ] **步骤 3：实现 delivery gate**

创建 `src/agent/delivery-gate.ts`：

```ts
import type { EvidenceState, DeliveryVerificationStatus } from './evidence.js'

export type DeliveryGateSeverity = 'ok' | 'warn' | 'error'

export interface DeliveryGateResult {
  status: DeliveryVerificationStatus
  severity: DeliveryGateSeverity
  canClaimComplete: boolean
  message: string
  blockingReason?: string
  nextAction?: string
}

export function buildDeliveryGate(state: EvidenceState): DeliveryGateResult {
  const modified = [...state.filesModified].sort()

  if (modified.length === 0) {
    return {
      status: 'verified',
      severity: 'ok',
      canClaimComplete: true,
      message: 'No file modifications require verification.',
    }
  }

  if (state.deliveryStatus === 'failed') {
    const failed = state.verifications.find(v => v.status === 'failed')
    return {
      status: 'failed',
      severity: 'error',
      canClaimComplete: false,
      message: `Verification failed${failed ? `: ${failed.command}` : ''}.`,
      blockingReason: failed ? `Verification command failed: ${failed.command}` : 'Verification failed.',
      nextAction: 'Fix the failing verification or report the failure before claiming completion.',
    }
  }

  if (state.deliveryStatus === 'blocked') {
    const blocked = state.verifications.find(v => v.status === 'blocked')
    return {
      status: 'blocked',
      severity: 'error',
      canClaimComplete: false,
      message: `Verification blocked${blocked ? `: ${blocked.command}` : ''}.`,
      blockingReason: blocked ? `Verification command blocked: ${blocked.command}` : 'Verification is blocked.',
      nextAction: 'Explain the blocker and request the missing environment, dependency, or permission.',
    }
  }

  if (state.deliveryStatus === 'verified') {
    return {
      status: 'verified',
      severity: 'ok',
      canClaimComplete: true,
      message: 'Modified files have passing verification evidence.',
    }
  }

  return {
    status: 'unverified',
    severity: 'warn',
    canClaimComplete: false,
    message: `Unverified changes: ${modified.join(', ')}.`,
    blockingReason: 'Files were modified without passing verification evidence.',
    nextAction: 'Run relevant targeted tests, typecheck, or build before claiming completion.',
  }
}
```

- [ ] **步骤 4：接入 EvidenceTracker badge**

修改 `src/agent/evidence.ts`：

```ts
import { buildDeliveryGate } from './delivery-gate.js'
```

在 `buildBadge()` 中计算 `status` 后加入 gate 文案。将现有：

```ts
const status = this.state.deliveryStatus
```

替换为：

```ts
const gate = buildDeliveryGate(this.state)
const status = gate.status
```

在 verification report 前追加：

```ts
if (modified.length > 0) {
  parts.push(`- **Delivery gate**: ${gate.message}`)
  if (gate.nextAction) parts.push(`- **Next action**: ${gate.nextAction}`)
}
```

- [ ] **步骤 5：运行测试验证通过**

运行：

```bash
npx tsx --test src/agent/__tests__/delivery-gate.test.ts
npm run typecheck
```

预期：PASS；typecheck clean。

- [ ] **步骤 6：Commit**

```bash
git add src/agent/delivery-gate.ts src/agent/__tests__/delivery-gate.test.ts src/agent/evidence.ts
git commit -m "feat(agent): add delivery trust gate"
```

---

## 任务 2：Retry safety policy

**文件：**
- 创建：`src/agent/retry-policy.ts`
- 创建：`src/agent/__tests__/retry-policy.test.ts`
- 修改：`src/agent/turn-harness.ts`

- [ ] **步骤 1：编写失败的 retry policy 测试**

创建 `src/agent/__tests__/retry-policy.test.ts`：

```ts
import test from 'node:test'
import assert from 'node:assert/strict'
import { shouldRetryToolFailure } from '../retry-policy.js'

test('allows retry for transient failure on concurrency-safe read tool', () => {
  const result = shouldRetryToolFailure({
    toolName: 'read_file',
    failureClass: 'timeout',
    isConcurrencySafe: true,
    retryableClasses: ['timeout', 'flaky'],
    retriesRemaining: 1,
  })

  assert.equal(result.retry, true)
})

test('blocks retry for transient failure on unsafe bash tool', () => {
  const result = shouldRetryToolFailure({
    toolName: 'bash',
    failureClass: 'timeout',
    isConcurrencySafe: false,
    retryableClasses: ['timeout', 'flaky'],
    retriesRemaining: 1,
  })

  assert.equal(result.retry, false)
  assert.match(result.reason, /not concurrency-safe/)
})

test('blocks retry for write and edit tools even when marked safe', () => {
  for (const toolName of ['write_file', 'edit_file']) {
    const result = shouldRetryToolFailure({
      toolName,
      failureClass: 'timeout',
      isConcurrencySafe: true,
      retryableClasses: ['timeout'],
      retriesRemaining: 1,
    })

    assert.equal(result.retry, false)
    assert.match(result.reason, /non-idempotent/)
  }
})

test('blocks retry when failure class is not configured as retryable', () => {
  const result = shouldRetryToolFailure({
    toolName: 'read_file',
    failureClass: 'assertion',
    isConcurrencySafe: true,
    retryableClasses: ['timeout'],
    retriesRemaining: 1,
  })

  assert.equal(result.retry, false)
  assert.match(result.reason, /not retryable/)
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：

```bash
npx tsx --test src/agent/__tests__/retry-policy.test.ts
```

预期：FAIL，报错包含：

```text
Cannot find module '../retry-policy.js'
```

- [ ] **步骤 3：实现 retry policy**

创建 `src/agent/retry-policy.ts`：

```ts
import { isTransient, type FailureClass } from './failure-classifier.js'

export interface RetryPolicyInput {
  toolName: string
  failureClass: FailureClass
  isConcurrencySafe: boolean
  retryableClasses: string[]
  retriesRemaining: number
}

export interface RetryPolicyDecision {
  retry: boolean
  reason: string
}

const NON_IDEMPOTENT_TOOLS = new Set([
  'write_file',
  'edit_file',
  'undo',
  'rollback',
])

function isMcpWriteTool(toolName: string): boolean {
  const match = toolName.match(/^mcp__(.+)__(.+)$/)
  if (!match) return false
  const mcpToolName = match[2]!
  return /(?:^|[_-])(?:write|create|update|delete|remove|push|post|put|patch|execute)(?:$|[_-])/i.test(mcpToolName)
}

export function shouldRetryToolFailure(input: RetryPolicyInput): RetryPolicyDecision {
  if (input.retriesRemaining <= 0) {
    return { retry: false, reason: 'No retries remaining.' }
  }

  if (!isTransient(input.failureClass) || !input.retryableClasses.includes(input.failureClass)) {
    return { retry: false, reason: `Failure class ${input.failureClass} is not retryable.` }
  }

  if (NON_IDEMPOTENT_TOOLS.has(input.toolName) || isMcpWriteTool(input.toolName)) {
    return { retry: false, reason: `Tool ${input.toolName} is non-idempotent and must not be auto-retried.` }
  }

  if (!input.isConcurrencySafe) {
    return { retry: false, reason: `Tool ${input.toolName} is not concurrency-safe.` }
  }

  return { retry: true, reason: 'Transient failure on concurrency-safe tool.' }
}
```

- [ ] **步骤 4：接入 TurnHarness**

修改 `src/agent/turn-harness.ts`：

```ts
import { shouldRetryToolFailure } from './retry-policy.js'
```

扩展 `ToolExecution`：

```ts
isConcurrencySafe: boolean
```

将重试条件替换为：

```ts
const decision = shouldRetryToolFailure({
  toolName: exec.name,
  failureClass: errorClass,
  isConcurrencySafe: exec.isConcurrencySafe,
  retryableClasses: this.config.retryableClasses,
  retriesRemaining: this.config.maxRetries,
})

if (decision.retry) {
  for (let attempt = 0; attempt < this.config.maxRetries; attempt++) {
    retried = true
    result = await exec.execute()
    if (!result.isError) break
    if (attempt === this.config.maxRetries - 1) {
      result = {
        content: `${result.content}\n\n[All ${this.config.maxRetries} retries failed. Error class: ${errorClass}. Consider alternative approach.]`,
        isError: true,
      }
    }
  }
}
```

如果 `decision.retry` 为 false，不要追加 retry 文案。

- [ ] **步骤 5：更新 AgentLoop 调用 TurnHarness 的参数**

在 `src/agent/loop.ts` 中找到 `harness.executeTool({ ... })` 调用，加入：

```ts
isConcurrencySafe: tool.isConcurrencySafe(),
```

其中 `tool` 是当前 tool registry resolve 出来的 `Tool` 实例。

- [ ] **步骤 6：运行相关测试**

运行：

```bash
npx tsx --test src/agent/__tests__/retry-policy.test.ts src/agent/__tests__/turn-harness.test.ts src/agent/__tests__/loop.test.ts
npm run typecheck
```

预期：PASS；typecheck clean。

- [ ] **步骤 7：Commit**

```bash
git add src/agent/retry-policy.ts src/agent/__tests__/retry-policy.test.ts src/agent/turn-harness.ts src/agent/loop.ts
git commit -m "fix(agent): require tool retry safety policy"
```

---

## 任务 3：Anchor-first execution guidance

**文件：**
- 创建：`src/agent/execution-guidance.ts`
- 创建：`src/agent/__tests__/execution-guidance.test.ts`
- 修改：`src/agent/strategy-shift.ts`
- 修改：`src/agent/loop.ts`

- [ ] **步骤 1：编写失败的 guidance 测试**

创建 `src/agent/__tests__/execution-guidance.test.ts`：

```ts
import test from 'node:test'
import assert from 'node:assert/strict'
import { buildExecutionGuidance } from '../execution-guidance.js'

test('builds anchor-first guidance for repeated edit failure', () => {
  const guidance = buildExecutionGuidance({
    doomLevel: 'blocked',
    trajectory: [
      { tool: 'edit_file', target: 'src/a.ts', status: 'failed', errorClass: 'assertion' },
      { tool: 'edit_file', target: 'src/a.ts', status: 'failed', errorClass: 'assertion' },
      { tool: 'edit_file', target: 'src/a.ts', status: 'failed', errorClass: 'assertion' },
    ],
  })

  assert.ok(guidance)
  assert.equal(guidance!.target, 'src/a.ts')
  assert.equal(guidance!.operation, 'edit_file')
  assert.match(guidance!.message, /Target: src\/a\.ts/)
  assert.match(guidance!.message, /Operation: edit_file/)
  assert.match(guidance!.message, /Do not repeat the same edit_file input/)
  assert.match(guidance!.message, /read_file/)
})

test('builds soft warning guidance before blocked level', () => {
  const guidance = buildExecutionGuidance({
    doomLevel: 'warn',
    trajectory: [
      { tool: 'bash', target: 'npm test', status: 'failed', errorClass: 'timeout' },
      { tool: 'bash', target: 'npm test', status: 'failed', errorClass: 'timeout' },
    ],
  })

  assert.ok(guidance)
  assert.equal(guidance!.severity, 'warn')
  assert.match(guidance!.message, /Verification signal/)
})

test('returns null when no doom loop signal exists', () => {
  const guidance = buildExecutionGuidance({
    doomLevel: 'none',
    trajectory: [
      { tool: 'read_file', target: 'src/a.ts', status: 'success' },
    ],
  })

  assert.equal(guidance, null)
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：

```bash
npx tsx --test src/agent/__tests__/execution-guidance.test.ts
```

预期：FAIL，报错包含：

```text
Cannot find module '../execution-guidance.js'
```

- [ ] **步骤 3：实现 anchor-first guidance**

创建 `src/agent/execution-guidance.ts`：

```ts
import type { FailureClass } from './failure-classifier.js'

export interface GuidanceTrajectoryEntry {
  tool: string
  target: string
  status: string
  errorClass?: FailureClass | string
}

export interface ExecutionGuidanceInput {
  doomLevel: 'none' | 'warn' | 'blocked'
  trajectory: GuidanceTrajectoryEntry[]
}

export interface ExecutionGuidance {
  severity: 'warn' | 'blocked'
  target: string
  operation: string
  failureClass?: string
  behavioralMistake: string
  verificationSignal: string
  boundaryCondition: string
  message: string
}

function keyOf(entry: GuidanceTrajectoryEntry): string {
  return `${entry.tool} ${entry.target} ${entry.errorClass ?? 'unknown'}`
}

function verificationSignalFor(tool: string): string {
  if (tool === 'edit_file' || tool === 'write_file') return 'Read the changed region and run the relevant targeted test or typecheck.'
  if (tool === 'bash' || tool === 'run_tests') return 'Run a narrower command or inspect the failing output before retrying.'
  if (tool === 'web_fetch') return 'Verify the URL, redirect target, and network error before retrying.'
  return 'Verify the target state changed before claiming recovery.'
}

function boundaryFor(tool: string): string {
  if (tool === 'edit_file') return 'Do not repeat the same edit_file input or old_string.'
  if (tool === 'write_file') return 'Do not rewrite the same file again without reading the current contents.'
  if (tool === 'bash' || tool === 'run_tests') return 'Do not repeat the same command unchanged.'
  return `Do not repeat the same ${tool} input unchanged.`
}

export function buildExecutionGuidance(input: ExecutionGuidanceInput): ExecutionGuidance | null {
  if (input.doomLevel === 'none') return null

  const recent = input.trajectory.slice(-10).filter(e => e.status === 'failed')
  if (recent.length === 0) return null

  const counts = new Map<string, { entry: GuidanceTrajectoryEntry; count: number }>()
  for (const entry of recent) {
    const key = keyOf(entry)
    const prev = counts.get(key)
    counts.set(key, { entry, count: (prev?.count ?? 0) + 1 })
  }

  const strongest = [...counts.values()].sort((a, b) => b.count - a.count)[0]
  if (!strongest) return null

  const { entry, count } = strongest
  const severity = input.doomLevel === 'blocked' ? 'blocked' : 'warn'
  const behavioralMistake = count >= 2
    ? `Repeated ${entry.tool} on ${entry.target} failed ${count} times.`
    : `Recent ${entry.tool} failure needs a changed recovery path.`
  const verificationSignal = verificationSignalFor(entry.tool)
  const boundaryCondition = boundaryFor(entry.tool)

  return {
    severity,
    target: entry.target,
    operation: entry.tool,
    failureClass: entry.errorClass,
    behavioralMistake,
    verificationSignal,
    boundaryCondition,
    message: [
      `Strategy shift (${severity}).`,
      `Target: ${entry.target}`,
      `Operation: ${entry.tool}`,
      entry.errorClass ? `Failure class: ${entry.errorClass}` : undefined,
      `Behavioral mistake: ${behavioralMistake}`,
      `Verification signal: ${verificationSignal}`,
      `Boundary: ${boundaryCondition}`,
    ].filter(Boolean).join('\n'),
  }
}
```

- [ ] **步骤 4：让 strategy-shift 复用 guidance**

修改 `src/agent/strategy-shift.ts`，保留 `TrajectorySummary` 和 `suggestStrategyShift()`，内部调用：

```ts
import { buildExecutionGuidance } from './execution-guidance.js'
```

将函数体开头改为：

```ts
export function suggestStrategyShift(trajectory: TrajectorySummary[], doomLevel: 'none' | 'warn' | 'blocked'): string | null {
  const guidance = buildExecutionGuidance({ doomLevel, trajectory })
  if (guidance) return guidance.message
  return null
}
```

删除旧的重复 pattern 逻辑，避免两个 strategy generator 分叉。

- [ ] **步骤 5：warn 阶段也注入 strategy shift**

修改 `src/agent/loop.ts`：在每次工具调用前已能获得 `doomLevel`。将只在 blocked 注入 hint 的逻辑调整为：

```ts
const doomLevel = this.getDoomLoopLevel()
if (doomLevel === 'warn' || doomLevel === 'blocked') {
  const trajectorySummary: TrajectorySummary[] = this.trajectory.getEntries().map(e => ({
    tool: e.tool,
    target: e.target,
    status: e.status === 'retried-failed' || e.status === 'failed' ? 'failed' : 'success',
    errorClass: e.errorClass,
  }))
  const hint = suggestStrategyShift(trajectorySummary, doomLevel)
  this.config.promptEngine.setStrategyShift(hint)
}

if (doomLevel === 'blocked') {
  const msg = 'Tool execution blocked: repeated identical failures detected. Change strategy before retrying.'
  ...
}
```

在 successful tool execution 后清理 stale hint：

```ts
if (!harnessResult.isError) {
  this.config.promptEngine.setStrategyShift(null)
}
```

- [ ] **步骤 6：运行相关测试**

运行：

```bash
npx tsx --test src/agent/__tests__/execution-guidance.test.ts src/agent/__tests__/strategy-shift.test.ts src/agent/__tests__/loop.test.ts
npm run typecheck
```

预期：PASS；typecheck clean。

- [ ] **步骤 7：Commit**

```bash
git add src/agent/execution-guidance.ts src/agent/__tests__/execution-guidance.test.ts src/agent/strategy-shift.ts src/agent/loop.ts
git commit -m "feat(agent): add anchor-first strategy guidance"
```

---

## 任务 4：Two-layer worker evidence gate

**文件：**
- 创建：`src/agent/worker-evidence.ts`
- 创建：`src/agent/__tests__/worker-evidence.test.ts`
- 修改：`src/agent/aggregation.ts`
- 测试：`src/agent/__tests__/aggregation.test.ts`

- [ ] **步骤 1：编写失败的 worker evidence 测试**

创建 `src/agent/__tests__/worker-evidence.test.ts`：

```ts
import test from 'node:test'
import assert from 'node:assert/strict'
import type { WorkerResult } from '../work-order.js'
import { verifyWorkerEvidence } from '../worker-evidence.js'

function result(overrides: Partial<WorkerResult>): WorkerResult {
  return {
    workOrderId: 'wo_1',
    status: 'passed',
    summary: 'ok',
    findings: [],
    artifacts: [],
    changedFiles: [],
    risks: [],
    nextActions: [],
    evidenceStatus: 'unverified',
    ...overrides,
  }
}

test('blocks changed files without verified evidence', () => {
  const checked = verifyWorkerEvidence(result({
    changedFiles: ['src/a.ts'],
    evidenceStatus: 'unverified',
  }))

  assert.equal(checked.status, 'blocked')
  assert.equal(checked.evidenceStatus, 'blocked')
  assert.equal(checked.risks.filter(r => r.includes('unverified')).length, 1)
})

test('blocks self-reported verified result without verification metadata', () => {
  const checked = verifyWorkerEvidence(result({
    changedFiles: ['src/a.ts'],
    evidenceStatus: 'verified',
  }))

  assert.equal(checked.status, 'blocked')
  assert.equal(checked.evidenceStatus, 'blocked')
  assert.ok(checked.risks.some(r => r.includes('missing verification metadata')))
})

test('fails worker result when verification metadata failed', () => {
  const checked = verifyWorkerEvidence(result({
    changedFiles: ['src/a.ts'],
    evidenceStatus: 'verified',
    verification: {
      command: 'npm test',
      status: 'failed',
      scope: 'targeted',
      exitCode: 1,
      passed: 1,
      failed: 1,
      skipped: 0,
      durationMs: 10,
    },
  }))

  assert.equal(checked.status, 'failed')
  assert.equal(checked.evidenceStatus, 'failed')
})

test('does not duplicate an existing risk', () => {
  const checked = verifyWorkerEvidence(result({
    changedFiles: ['src/a.ts'],
    evidenceStatus: 'unverified',
    risks: ['unverified: 1 file(s) changed without verified evidence'],
  }))

  assert.equal(checked.risks.filter(r => r.includes('unverified')).length, 1)
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：

```bash
npx tsx --test src/agent/__tests__/worker-evidence.test.ts
```

预期：FAIL，报错包含：

```text
Cannot find module '../worker-evidence.js'
```

- [ ] **步骤 3：实现 worker evidence verifier**

创建 `src/agent/worker-evidence.ts`：

```ts
import type { WorkerResult } from './work-order.js'

function addRisk(risks: string[], risk: string): string[] {
  return risks.includes(risk) ? risks : [...risks, risk]
}

export function verifyWorkerEvidence(result: WorkerResult): WorkerResult {
  if (result.changedFiles.length === 0) return result

  const unverifiedRisk = `unverified: ${result.changedFiles.length} file(s) changed without verified evidence`

  if (result.evidenceStatus !== 'verified') {
    return {
      ...result,
      status: 'blocked',
      evidenceStatus: 'blocked',
      risks: addRisk(result.risks, unverifiedRisk),
    }
  }

  if (!result.verification) {
    return {
      ...result,
      status: 'blocked',
      evidenceStatus: 'blocked',
      risks: addRisk(result.risks, 'verified worker result is missing verification metadata'),
    }
  }

  if (result.verification.status === 'failed') {
    return {
      ...result,
      status: 'failed',
      evidenceStatus: 'failed',
      risks: addRisk(result.risks, `worker verification failed: ${result.verification.command}`),
    }
  }

  if (result.verification.status === 'blocked') {
    return {
      ...result,
      status: 'blocked',
      evidenceStatus: 'blocked',
      risks: addRisk(result.risks, `worker verification blocked: ${result.verification.command}`),
    }
  }

  return result
}
```

- [ ] **步骤 4：接入 aggregation**

修改 `src/agent/aggregation.ts`：

```ts
import { verifyWorkerEvidence } from './worker-evidence.js'
```

将现有 evidence gate map 替换为：

```ts
const gated = results.map(verifyWorkerEvidence)
```

删除重复构造 unverified risk 的内联逻辑。

- [ ] **步骤 5：运行相关测试**

运行：

```bash
npx tsx --test src/agent/__tests__/worker-evidence.test.ts src/agent/__tests__/aggregation.test.ts src/agent/__tests__/coordinator.test.ts
npm run typecheck
```

预期：PASS；typecheck clean。

- [ ] **步骤 6：Commit**

```bash
git add src/agent/worker-evidence.ts src/agent/__tests__/worker-evidence.test.ts src/agent/aggregation.ts
git commit -m "fix(agent): verify worker evidence independently"
```

---

## 任务 5：Repair hint and telemetry integration

**文件：**
- 修改：`src/prompt/volatile.ts`
- 修改：`src/agent/repair-pipeline.ts`
- 修改：`src/agent/loop.ts`
- 测试：`src/prompt/__tests__/volatile.test.ts`
- 测试：`src/agent/__tests__/repair-pipeline.test.ts`

- [ ] **步骤 1：编写 volatile repairHint 测试**

在 `src/prompt/__tests__/volatile.test.ts` 添加：

```ts
import { buildLatestTurnVolatileBlock } from '../volatile.js'

test('renders repair hint in latest-turn volatile block', () => {
  const block = buildLatestTurnVolatileBlock({
    cwd: '/tmp/project',
    repairHint: '<repair-hint tool="edit_file">Read before editing.</repair-hint>',
  })

  assert.match(block, /<repair-hint tool="edit_file">/)
  assert.match(block, /Read before editing/)
})
```

如果该测试文件已经有 imports，请合并 import，避免重复声明。

- [ ] **步骤 2：运行测试验证失败**

运行：

```bash
npx tsx --test src/prompt/__tests__/volatile.test.ts
```

预期：FAIL，原因是 `repairHint` 不在 `VolatileContext` 或未渲染。

- [ ] **步骤 3：渲染 repairHint**

修改 `src/prompt/volatile.ts`：

在 `VolatileContext` 增加：

```ts
repairHint?: string | null
```

在 `buildLatestTurnVolatileBlock()` 动态 sections 中加入：

```ts
if (ctx.repairHint) {
  parts.push(ctx.repairHint)
}
```

不要对 `repairHint` 再包一层标签，因为 `RepairHintTracker.getHint()` 已返回完整 `<repair-hint ...>` XML 片段。

- [ ] **步骤 4：增加 repair telemetry summary helper 测试**

在 `src/agent/__tests__/repair-pipeline.test.ts` 添加：

```ts
import { summarizeRepairTelemetry } from '../repair-pipeline.js'

test('summarizes repair telemetry for trace output', () => {
  const summary = summarizeRepairTelemetry([
    { pass: 'four-horsemen', fixType: 'fourHorsemen', toolName: 'edit_file', timestamp: 1 },
    { pass: 'semantic-repair', fixType: 'autoLink', toolName: 'write_file', timestamp: 2 },
  ])

  assert.equal(summary, 'repair: fourHorsemen(edit_file), autoLink(write_file)')
})
```

- [ ] **步骤 5：实现 repair telemetry summary helper**

修改 `src/agent/repair-pipeline.ts`：

```ts
export function summarizeRepairTelemetry(entries: RepairTelemetryEntry[]): string | null {
  if (entries.length === 0) return null
  const compact = entries.map(e => `${e.fixType}(${e.toolName})`).join(', ')
  return `repair: ${compact}`
}
```

- [ ] **步骤 6：在 AgentLoop 接入 repair telemetry**

在 `src/agent/loop.ts` 中执行 tool 前，如果已有 repair pipeline 实例，则运行：

```ts
const repaired = this.repairPipeline.run(tu.input as Record<string, unknown>, {
  toolName: tu.name,
  schema: tool.definition.input_schema,
})
const params = repaired.output
const repairSummary = summarizeRepairTelemetry(repaired.telemetry)
if (repairSummary) {
  this.traceStore = recordTraceEvent(this.traceStore, {
    id: `${tu.id}:repair`,
    turn: this.turn,
    kind: 'tool',
    name: `${tu.name}:repair`,
    status: 'passed',
    startedAt: Date.now(),
    endedAt: Date.now(),
    durationMs: 0,
    summary: repairSummary,
  })
}
```

如果当前 `AgentLoop` 还没有 `repairPipeline` 字段，本任务只接入已有 pipeline 构造点，不要扩大为新配置系统。可在 constructor 内默认创建：

```ts
this.repairPipeline = new RepairPipeline([fourHorsemenPass, semanticRepairPass])
```

并引入对应 imports。

- [ ] **步骤 7：运行相关测试**

运行：

```bash
npx tsx --test src/prompt/__tests__/volatile.test.ts src/agent/__tests__/repair-pipeline.test.ts src/agent/__tests__/loop.test.ts
npm run typecheck
```

预期：PASS；typecheck clean。

- [ ] **步骤 8：Commit**

```bash
git add src/prompt/volatile.ts src/prompt/__tests__/volatile.test.ts src/agent/repair-pipeline.ts src/agent/__tests__/repair-pipeline.test.ts src/agent/loop.ts
git commit -m "feat(agent): surface repair hints and telemetry"
```

---

## 任务 6：MCP enforcement policy

**文件：**
- 创建：`src/mcp/policy.ts`
- 创建：`src/mcp/__tests__/policy.test.ts`
- 修改：`src/agent/approval-risk.ts`

- [ ] **步骤 1：编写失败的 MCP policy 测试**

创建 `src/mcp/__tests__/policy.test.ts`：

```ts
import test from 'node:test'
import assert from 'node:assert/strict'
import { evaluateMcpPolicy } from '../policy.js'

test('requires confirmation for unknown write-capable MCP tool', () => {
  const result = evaluateMcpPolicy({
    toolName: 'mcp__unknown__delete_file',
    trustedServers: [],
    blockedTools: [],
    allowedTools: [],
    mustConfirmCapabilities: ['write'],
  })

  assert.equal(result.action, 'confirm')
  assert.equal(result.capability, 'write')
  assert.match(result.reason, /unknown/)
})

test('blocks explicitly blocked MCP tool', () => {
  const result = evaluateMcpPolicy({
    toolName: 'mcp__github__delete_repo',
    trustedServers: ['github'],
    blockedTools: ['mcp__github__delete_repo'],
    allowedTools: [],
    mustConfirmCapabilities: ['write'],
  })

  assert.equal(result.action, 'block')
})

test('allows explicitly allowed read MCP tool', () => {
  const result = evaluateMcpPolicy({
    toolName: 'mcp__docs__search',
    trustedServers: ['docs'],
    blockedTools: [],
    allowedTools: ['mcp__docs__search'],
    mustConfirmCapabilities: ['write'],
  })

  assert.equal(result.action, 'allow')
  assert.equal(result.capability, 'read')
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：

```bash
npx tsx --test src/mcp/__tests__/policy.test.ts
```

预期：FAIL，报错包含：

```text
Cannot find module '../policy.js'
```

- [ ] **步骤 3：实现 MCP policy evaluator**

创建 `src/mcp/policy.ts`：

```ts
export type McpCapability = 'read' | 'write' | 'execute' | 'network'
export type McpPolicyAction = 'allow' | 'confirm' | 'block' | 'require'

export interface McpPolicyInput {
  toolName: string
  trustedServers: string[]
  blockedTools: string[]
  allowedTools: string[]
  mustConfirmCapabilities: McpCapability[]
}

export interface McpPolicyDecision {
  action: McpPolicyAction
  serverId?: string
  mcpToolName?: string
  capability: McpCapability
  reason: string
}

const WRITE_RE = /(?:^|[_-])(?:write|create|update|delete|remove|push|post|put|patch)(?:$|[_-])/i
const EXECUTE_RE = /(?:^|[_-])(?:execute|run|shell|bash|command)(?:$|[_-])/i
const NETWORK_RE = /(?:^|[_-])(?:fetch|request|http|web|download|upload)(?:$|[_-])/i

function parseMcpTool(toolName: string): { serverId: string; mcpToolName: string } | null {
  const match = toolName.match(/^mcp__(.+)__(.+)$/)
  if (!match) return null
  return { serverId: match[1]!, mcpToolName: match[2]! }
}

function inferCapability(mcpToolName: string): McpCapability {
  if (EXECUTE_RE.test(mcpToolName)) return 'execute'
  if (WRITE_RE.test(mcpToolName)) return 'write'
  if (NETWORK_RE.test(mcpToolName)) return 'network'
  return 'read'
}

export function evaluateMcpPolicy(input: McpPolicyInput): McpPolicyDecision {
  const parsed = parseMcpTool(input.toolName)
  if (!parsed) {
    return { action: 'allow', capability: 'read', reason: 'Not an MCP tool.' }
  }

  const capability = inferCapability(parsed.mcpToolName)

  if (input.blockedTools.includes(input.toolName)) {
    return { action: 'block', ...parsed, capability, reason: 'MCP tool is explicitly blocked.' }
  }

  if (input.allowedTools.includes(input.toolName)) {
    return { action: 'allow', ...parsed, capability, reason: 'MCP tool is explicitly allowed.' }
  }

  const trusted = input.trustedServers.includes(parsed.serverId)
  if (!trusted && capability !== 'read') {
    return { action: 'confirm', ...parsed, capability, reason: `MCP server ${parsed.serverId} is unknown and requests ${capability} capability.` }
  }

  if (input.mustConfirmCapabilities.includes(capability)) {
    return { action: 'confirm', ...parsed, capability, reason: `MCP ${capability} capability requires confirmation.` }
  }

  return { action: 'allow', ...parsed, capability, reason: 'MCP policy allows this tool.' }
}
```

- [ ] **步骤 4：接入 approval-risk**

修改 `src/agent/approval-risk.ts`：

```ts
import { evaluateMcpPolicy } from '../mcp/policy.js'
```

在 MCP tool risk 分支中调用：

```ts
const policy = evaluateMcpPolicy({
  toolName,
  trustedServers: [],
  blockedTools: [],
  allowedTools: [],
  mustConfirmCapabilities: ['write', 'execute'],
})
```

根据结果补充 reasons：

```ts
reasons.push(`MCP policy: ${policy.action} (${policy.reason})`)
if (policy.action === 'block') level = 'high'
else if (policy.action === 'confirm' || policy.action === 'require') level = level === 'high' ? 'high' : 'medium'
```

保留现有 MCP server/tool reason，避免 UI 丢失来源。

- [ ] **步骤 5：运行相关测试**

运行：

```bash
npx tsx --test src/mcp/__tests__/policy.test.ts src/agent/__tests__/approval-risk.test.ts
npm run typecheck
```

预期：PASS；typecheck clean。

- [ ] **步骤 6：Commit**

```bash
git add src/mcp/policy.ts src/mcp/__tests__/policy.test.ts src/agent/approval-risk.ts
git commit -m "feat(mcp): add deterministic MCP policy enforcement"
```

---

## 任务 7：Cockpit guidance fields

**文件：**
- 修改：`src/tui/cockpit/types.ts`
- 修改：`src/tui/cockpit/state.ts`
- 修改：`src/tui/cockpit/__tests__/state.test.ts`

- [ ] **步骤 1：编写失败的 cockpit guidance 测试**

在 `src/tui/cockpit/__tests__/state.test.ts` 添加：

```ts
test('snapshot exposes blocking reason and next action for unverified modified files', () => {
  const snapshot = buildCockpitSnapshot({
    agent: makeAgent({
      evidence: {
        filesRead: new Set(),
        filesModified: new Set(['src/a.ts']),
        verifications: [],
        deliveryStatus: 'unverified',
        impactedFiles: new Set(),
        impactedTests: new Set(),
      },
    }),
    session: makeSession(),
    model: 'deepseek-chat',
    cacheHitRate: 0.8,
    cost: 0,
    mcpManager: null,
  })

  assert.equal(snapshot.blockingReason, 'Files were modified without passing verification evidence.')
  assert.match(snapshot.nextAction, /Run relevant targeted tests/)
})
```

如果 `makeAgent` helper 当前不支持传入 evidence，请扩展 helper，不要绕过 `buildCockpitSnapshot()`。

- [ ] **步骤 2：运行测试验证失败**

运行：

```bash
npx tsx --test src/tui/cockpit/__tests__/state.test.ts
```

预期：FAIL，原因是 `CockpitSnapshot` 没有 `blockingReason` / `nextAction`。

- [ ] **步骤 3：扩展 CockpitSnapshot 类型**

修改 `src/tui/cockpit/types.ts`，在 `CockpitSnapshot` 顶层增加：

```ts
intent: string | null
blockingReason: string | null
nextAction: string | null
```

- [ ] **步骤 4：在 cockpit state 推导 guidance**

修改 `src/tui/cockpit/state.ts`：

```ts
import { buildDeliveryGate } from '../../agent/delivery-gate.js'
```

在 `buildCockpitSnapshot()` 中获取 evidence 后：

```ts
const deliveryGate = buildDeliveryGate(evidence)
```

在 snapshot 顶层加入：

```ts
intent: traceStore.events.at(-1)?.summary ?? null,
blockingReason: deliveryGate.blockingReason ?? (risk.level === 'high' ? risk.suggestedAction : null),
nextAction: deliveryGate.nextAction ?? (doomLevel === 'blocked' ? 'Change strategy before retrying the same tool call.' : null),
```

- [ ] **步骤 5：运行 cockpit tests**

运行：

```bash
npx tsx --test src/tui/cockpit/__tests__/state.test.ts src/tui/cockpit/__tests__/panels.test.ts
npm run typecheck
```

预期：PASS；typecheck clean。

- [ ] **步骤 6：Commit**

```bash
git add src/tui/cockpit/types.ts src/tui/cockpit/state.ts src/tui/cockpit/__tests__/state.test.ts
git commit -m "feat(cockpit): expose execution guidance fields"
```

---

## 任务 8：Scenario golden tests

**文件：**
- 创建：`src/agent/__tests__/execution-trust-closure.test.ts`

- [ ] **步骤 1：创建端到端闭环测试文件**

创建 `src/agent/__tests__/execution-trust-closure.test.ts`：

```ts
import test from 'node:test'
import assert from 'node:assert/strict'
import { buildDeliveryGate } from '../delivery-gate.js'
import { buildExecutionGuidance } from '../execution-guidance.js'
import { shouldRetryToolFailure } from '../retry-policy.js'
import { verifyWorkerEvidence } from '../worker-evidence.js'

test('closure: modified files without verification cannot claim complete', () => {
  const gate = buildDeliveryGate({
    filesRead: new Set(),
    filesModified: new Set(['src/a.ts']),
    verifications: [],
    deliveryStatus: 'unverified',
    impactedFiles: new Set(),
    impactedTests: new Set(),
  })

  assert.equal(gate.canClaimComplete, false)
  assert.equal(gate.status, 'unverified')
})

test('closure: repeated edit failure produces anchored recovery guidance', () => {
  const guidance = buildExecutionGuidance({
    doomLevel: 'blocked',
    trajectory: [
      { tool: 'edit_file', target: 'src/a.ts', status: 'failed', errorClass: 'assertion' },
      { tool: 'edit_file', target: 'src/a.ts', status: 'failed', errorClass: 'assertion' },
      { tool: 'edit_file', target: 'src/a.ts', status: 'failed', errorClass: 'assertion' },
    ],
  })

  assert.ok(guidance)
  assert.match(guidance!.message, /Target: src\/a\.ts/)
  assert.match(guidance!.message, /Boundary:/)
})

test('closure: transient unsafe tool failure does not retry', () => {
  const decision = shouldRetryToolFailure({
    toolName: 'bash',
    failureClass: 'timeout',
    isConcurrencySafe: false,
    retryableClasses: ['timeout'],
    retriesRemaining: 1,
  })

  assert.equal(decision.retry, false)
})

test('closure: worker changed files require independent verification metadata', () => {
  const checked = verifyWorkerEvidence({
    workOrderId: 'wo_1',
    status: 'passed',
    summary: 'done',
    findings: [],
    artifacts: [],
    changedFiles: ['src/a.ts'],
    risks: [],
    nextActions: [],
    evidenceStatus: 'verified',
  })

  assert.equal(checked.status, 'blocked')
  assert.equal(checked.evidenceStatus, 'blocked')
})
```

- [ ] **步骤 2：运行 golden tests**

运行：

```bash
npx tsx --test src/agent/__tests__/execution-trust-closure.test.ts
```

预期：PASS。

- [ ] **步骤 3：运行完整验证**

运行：

```bash
npm run typecheck
npm test
npm run build
```

预期：全部通过。

- [ ] **步骤 4：Commit**

```bash
git add src/agent/__tests__/execution-trust-closure.test.ts
git commit -m "test(agent): cover execution trust closure scenarios"
```

---

## 自检记录

### 规格覆盖度

- Final delivery gate：任务 1。
- Retry side-effect safety：任务 2。
- Anchor-first strategy shift：任务 3。
- Two-layer worker evidence gate：任务 4。
- Repair hint / telemetry integration：任务 5。
- MCP enforcement policy：任务 6。
- Cockpit intent / blockingReason / nextAction：任务 7。
- Scenario golden tests：任务 8。

### 占位符扫描

本计划不使用占位符式任务描述；每个实现步骤给出文件、代码片段、命令和预期结果。

### 类型一致性

- `DeliveryVerificationStatus` 复用 `src/agent/evidence.ts`。
- `FailureClass` 复用 `src/agent/failure-classifier.ts`。
- `WorkerResult` 复用 `src/agent/work-order.ts`。
- `VerificationMetadata` 复用 `src/tools/types.ts`。
- `CockpitSnapshot` 复用 `src/tui/cockpit/types.ts`。

## 执行交接

计划保存后建议使用子代理驱动执行：每个任务一个新子代理，任务完成后单独 review，再进入下一任务。任务 1-4 是 P0，应优先完成；任务 5-7 是 P1；任务 8 是闭环验收。
