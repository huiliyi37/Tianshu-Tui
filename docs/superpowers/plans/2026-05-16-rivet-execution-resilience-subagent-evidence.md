# Rivet Execution Resilience + Sub-agent Orchestration 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 把 Rivet 的点状 retry、failure classifier、trajectory、delegate_task 能力升级为可恢复、可审查、可验证的长任务执行系统。

**架构：** 在 `TurnHarness` 中明确 retry policy 与 failure class；将 doom-loop / behavior mirror 从观察信号接入 block/strategy-shift；升级 work order result contract，要求 worker 返回 files/read/changed/verification/risks，Aggregator 拒绝无 evidence 的实现结果；主控汇总 worker evidence 并在 cockpit/trace 中可见。

**技术栈：** TypeScript, node:test, node:assert/strict, existing `TurnHarness`, `failure-classifier`, `TrajectoryRecorder`, `WorkOrder`, `DelegationCoordinator`, `aggregateResults`, `WorkerSession`

---

## 背景

Rivet 已经具备 Execution Resilience 的多个零件：

- `TurnHarness`：工具执行 retry + trajectory recording。
- `failure-classifier`：识别 timeout/flaky/error 等失败。
- `trace-store` / `trajectory`：记录执行轨迹。
- `behavior-mirror` / `decision-anchor`：检测重复行为和决策。
- `delegate_task` / `coordinator` / `work-order`：子代理 MVP。

当前偏离在于：这些能力还没有形成统一 runtime policy。长任务失败时，系统还不能稳定判断“重试、换策略、派 repair worker、停止并请求用户”。

---

## 文件结构

| 操作 | 文件 | 职责 |
|------|------|------|
| 修改 | `src/agent/turn-harness.ts` | 明确 maxRetries 语义、retryable class policy、retry summary |
| 修改 | `src/agent/__tests__/turn-harness.test.ts` | 覆盖 retry 次数、non-retryable 不重试、retry summary |
| 修改 | `src/agent/failure-classifier.ts` | 输出 failure class + suggested next action |
| 修改 | `src/agent/__tests__/failure-classifier.test.ts` | 覆盖 deterministic failure、timeout、flaky、permission denied |
| 修改 | `src/agent/trace-store.ts` | 增加 repeated failure/doom-loop summary helper |
| 修改 | `src/agent/__tests__/trace-store.test.ts` | 覆盖 repeated fingerprint block |
| 修改 | `src/agent/work-order.ts` | 扩展 worker result contract：filesRead/filesChanged/verification/risks/evidenceStatus |
| 修改 | `src/agent/__tests__/work-order.test.ts` | 覆盖 worker result schema |
| 修改 | `src/agent/aggregation.ts` | 拒绝 implementation worker 的 missing evidence result |
| 修改 | `src/agent/__tests__/aggregation.test.ts` | 覆盖 aggregation gate |
| 修改 | `src/agent/coordinator.ts` | 失败 worker 产生 repair work order，汇总 worker evidence |
| 修改 | `src/agent/__tests__/coordinator.test.ts` | 覆盖 failed worker repair 与 evidence aggregation |
| 修改 | `src/agent/worker-prompts.ts` | 要求 worker 输出结构化 evidence fields |
| 修改 | `src/agent/__tests__/worker-prompts.test.ts` | 覆盖 prompt contract |
| 修改 | `README.md` | 补充 execution resilience 和 sub-agent evidence 说明 |

---

### 任务 1：修正 TurnHarness retry policy

**文件：**
- 修改：`src/agent/turn-harness.ts`
- 测试：`src/agent/__tests__/turn-harness.test.ts`

- [x] **步骤 1：编写失败的测试**

在 `src/agent/__tests__/turn-harness.test.ts` 增加：

```typescript
it('treats maxRetries as retry attempts after the first execution', async () => {
  let attempts = 0
  const harness = new TurnHarness({ maxRetries: 2, retryableClasses: ['timeout'] }, recorder)

  const result = await harness.executeTool({
    id: 'tu1',
    name: 'bash',
    input: { command: 'npm test' },
    turn: 1,
    execute: async () => {
      attempts++
      return { content: attempts < 3 ? 'Command timed out' : 'ok', isError: attempts < 3 }
    },
    classify: content => content.includes('timed out') ? 'timeout' : 'unknown',
  })

  assert.equal(attempts, 3)
  assert.equal(result.isError, false)
})

it('does not retry non-retryable failures', async () => {
  let attempts = 0
  const harness = new TurnHarness({ maxRetries: 2, retryableClasses: ['timeout'] }, recorder)

  const result = await harness.executeTool({
    id: 'tu1',
    name: 'bash',
    input: { command: 'npm test' },
    turn: 1,
    execute: async () => {
      attempts++
      return { content: 'TypeScript error TS2305', isError: true }
    },
    classify: () => 'compile',
  })

  assert.equal(attempts, 1)
  assert.equal(result.isError, true)
})
```

- [x] **步骤 2：运行测试验证失败**

运行：

```bash
npm test -- src/agent/__tests__/turn-harness.test.ts
```

预期：若当前 retry 少一次，第一个测试 FAIL。

- [x] **步骤 3：实现明确 retry 循环**

修改 `src/agent/turn-harness.ts` 的 retry loop：

```typescript
let attempt = 0
let lastResult: ToolExecutionResult | undefined

while (attempt <= this.config.maxRetries) {
  const startedAt = Date.now()
  const result = await execution.execute()
  const failureClass = result.isError ? execution.classify(result.content) : 'unknown'
  this.trajectory.record({
    id: execution.id,
    tool: execution.name,
    input: execution.input,
    turn: execution.turn,
    attempt,
    status: result.isError ? 'failed' : 'success',
    durationMs: Date.now() - startedAt,
    failureClass: result.isError ? failureClass : undefined,
  })

  if (!result.isError) return { ...result, attempts: attempt + 1 }
  lastResult = result
  if (!this.config.retryableClasses.includes(failureClass)) break
  if (attempt === this.config.maxRetries) break
  attempt++
}

return { ...lastResult!, attempts: attempt + 1 }
```

Adapt field names to existing `TrajectoryEntry` / `ToolExecutionResult`; preserve public API compatibility where possible.

- [x] **步骤 4：运行测试验证通过**

运行：

```bash
npm test -- src/agent/__tests__/turn-harness.test.ts
```

预期：PASS。

- [x] **步骤 5：Commit**

```bash
git add src/agent/turn-harness.ts src/agent/__tests__/turn-harness.test.ts
git commit -m "fix(agent): clarify TurnHarness retry semantics"
```

---

### 任务 2：让 failure classifier 输出建议动作

**文件：**
- 修改：`src/agent/failure-classifier.ts`
- 测试：`src/agent/__tests__/failure-classifier.test.ts`

- [x] **步骤 1：编写失败的测试**

在 `src/agent/__tests__/failure-classifier.test.ts` 增加：

```typescript
it('suggests not retrying deterministic TypeScript failures', () => {
  const result = classifyFailure('error TS2305: Module has no exported member')
  assert.equal(result.class, 'compile')
  assert.match(result.suggestion, /fix/i)
  assert.equal(result.retryable, false)
})

it('suggests retrying timeouts', () => {
  const result = classifyFailure('Command timed out after 120000ms')
  assert.equal(result.class, 'timeout')
  assert.equal(result.retryable, true)
  assert.match(result.suggestion, /retry/i)
})
```

- [x] **步骤 2：运行测试验证失败**

运行：

```bash
npm test -- src/agent/__tests__/failure-classifier.test.ts
```

预期：FAIL，`retryable` may not exist.

- [x] **步骤 3：扩展分类结果**

修改 `src/agent/failure-classifier.ts`：

```typescript
export interface FailureClassification {
  class: FailureClass
  confidence: number
  suggestion: string
  retryable: boolean
}
```

Set retryable per class:

```typescript
const retryable = failureClass === 'timeout' || failureClass === 'flaky'
const suggestion = retryable
  ? 'Retry once, then inspect logs if the same failure repeats.'
  : failureClass === 'compile'
    ? 'Fix the compile error before rerunning the command.'
    : 'Inspect the error output and change strategy before retrying.'
```

- [x] **步骤 4：运行测试验证通过**

运行：

```bash
npm test -- src/agent/__tests__/failure-classifier.test.ts
```

预期：PASS。

- [x] **步骤 5：Commit**

```bash
git add src/agent/failure-classifier.ts src/agent/__tests__/failure-classifier.test.ts
git commit -m "feat(agent): attach retry guidance to failure classification"
```

---

### 任务 3：阻断重复失败 doom loop

**文件：**
- 修改：`src/agent/trace-store.ts`
- 修改：`src/agent/loop.ts`
- 测试：`src/agent/__tests__/trace-store.test.ts`

- [x] **步骤 1：编写失败的测试**

在 `src/agent/__tests__/trace-store.test.ts` 增加：

```typescript
it('marks repeated failed tool fingerprints as blocked doom loop', () => {
  let store = createTraceStore()
  const fp = { tool: 'bash', target: 'npm test', outcome: 'error' as const }
  store = recordToolFingerprint(store, fp)
  store = recordToolFingerprint(store, fp)
  store = recordToolFingerprint(store, fp)

  assert.equal(getDoomLoopLevel(store.toolFingerprints), 'blocked')
})
```

- [x] **步骤 2：运行测试验证失败**

运行：

```bash
npm test -- src/agent/__tests__/trace-store.test.ts
```

预期：FAIL if threshold or API does not classify repeated failed fingerprints as blocked.

- [x] **步骤 3：实现 block threshold**

修改 `src/agent/trace-store.ts`：

```typescript
export function getDoomLoopLevel(fingerprints: ToolFingerprint[]): DoomLoopLevel {
  const counts = new Map<string, number>()
  for (const fp of fingerprints) {
    if (fp.outcome !== 'error') continue
    const key = `${fp.tool}:${fp.target}:${fp.outcome}`
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  const max = Math.max(0, ...counts.values())
  if (max >= 3) return 'blocked'
  if (max >= 2) return 'warn'
  return 'none'
}
```

In `src/agent/loop.ts`, before executing a tool, if `getDoomLoopLevel(...) === 'blocked'`, return tool result:

```typescript
const doomLevel = getDoomLoopLevel(this.traceStore.toolFingerprints)
if (doomLevel === 'blocked') {
  const msg = 'Tool execution blocked: repeated identical failures detected. Change strategy before retrying.'
  callbacks.onToolResult(tu.id, tu.name, msg, true)
  toolResults.push({ type: 'tool_result', tool_use_id: tu.id, content: msg, is_error: true })
  continue
}
```

- [x] **步骤 4：运行测试验证通过**

运行：

```bash
npm test -- src/agent/__tests__/trace-store.test.ts
```

预期：PASS。

- [x] **步骤 5：Commit**

```bash
git add src/agent/trace-store.ts src/agent/loop.ts src/agent/__tests__/trace-store.test.ts
git commit -m "feat(agent): block repeated failed tool loops"
```

---

### 任务 4：扩展 worker result contract

**文件：**
- 修改：`src/agent/work-order.ts`
- 测试：`src/agent/__tests__/work-order.test.ts`

- [x] **步骤 1：编写失败的测试**

在 `src/agent/__tests__/work-order.test.ts` 增加：

```typescript
it('validates worker result evidence fields', () => {
  const result = workerResultSchema.parse({
    status: 'completed',
    summary: 'Implemented retry policy',
    filesRead: ['src/agent/turn-harness.ts'],
    filesChanged: ['src/agent/turn-harness.ts'],
    verification: [{ command: 'npm test -- src/agent/__tests__/turn-harness.test.ts', status: 'passed', scope: 'targeted' }],
    risks: [],
    evidenceStatus: 'verified',
  })

  assert.equal(result.evidenceStatus, 'verified')
  assert.equal(result.verification.length, 1)
})
```

- [x] **步骤 2：运行测试验证失败**

运行：

```bash
npm test -- src/agent/__tests__/work-order.test.ts
```

预期：FAIL，schema does not include fields.

- [x] **步骤 3：实现 schema**

In `src/agent/work-order.ts`, add:

```typescript
export const workerVerificationSchema = z.object({
  command: z.string(),
  status: z.enum(['passed', 'failed', 'blocked']),
  scope: z.enum(['targeted', 'full']).or(z.string()),
  target: z.string().optional(),
})

export const workerResultSchema = z.object({
  status: z.enum(['completed', 'failed', 'blocked']),
  summary: z.string(),
  filesRead: z.array(z.string()).default([]),
  filesChanged: z.array(z.string()).default([]),
  verification: z.array(workerVerificationSchema).default([]),
  risks: z.array(z.string()).default([]),
  evidenceStatus: z.enum(['verified', 'failed', 'blocked', 'unverified']),
})

export type WorkerResult = z.infer<typeof workerResultSchema>
```

If a `WorkerSessionRun` or existing result type already exists, extend it with these exact fields rather than creating an incompatible duplicate.

- [x] **步骤 4：运行测试验证通过**

运行：

```bash
npm test -- src/agent/__tests__/work-order.test.ts
```

预期：PASS。

- [x] **步骤 5：Commit**

```bash
git add src/agent/work-order.ts src/agent/__tests__/work-order.test.ts
git commit -m "feat(agent): require evidence fields in worker results"
```

---

### 任务 5：Aggregator 拒绝无 evidence 的实现结果

**文件：**
- 修改：`src/agent/aggregation.ts`
- 测试：`src/agent/__tests__/aggregation.test.ts`

- [x] **步骤 1：编写失败的测试**

在 `src/agent/__tests__/aggregation.test.ts` 增加：

```typescript
it('marks implementation result without verification as blocked', () => {
  const aggregate = aggregateResults([{
    id: 'wo1',
    kind: 'implement',
    status: 'completed',
    summary: 'Changed files',
    filesRead: [],
    filesChanged: ['src/agent/loop.ts'],
    verification: [],
    risks: [],
    evidenceStatus: 'unverified',
  }])

  assert.equal(aggregate.status, 'blocked')
  assert.match(aggregate.summary, /unverified/i)
})
```

- [x] **步骤 2：运行测试验证失败**

运行：

```bash
npm test -- src/agent/__tests__/aggregation.test.ts
```

预期：FAIL，aggregate currently accepts completed result.

- [x] **步骤 3：实现 evidence gate**

Modify `src/agent/aggregation.ts`:

```typescript
const unverifiedImplementations = results.filter(result =>
  result.kind === 'implement'
  && result.filesChanged.length > 0
  && result.evidenceStatus !== 'verified'
)

if (unverifiedImplementations.length > 0) {
  return {
    status: 'blocked',
    summary: `Blocked: ${unverifiedImplementations.length} implementation result(s) changed files without verified evidence.`,
    results,
  }
}
```

Adapt field names to existing aggregation result shape; keep the summary text containing `unverified`.

- [x] **步骤 4：运行测试验证通过**

运行：

```bash
npm test -- src/agent/__tests__/aggregation.test.ts
```

预期：PASS。

- [x] **步骤 5：Commit**

```bash
git add src/agent/aggregation.ts src/agent/__tests__/aggregation.test.ts
git commit -m "feat(agent): block unverified implementation worker results"
```

---

### 任务 6：Worker prompt 要求结构化 evidence

**文件：**
- 修改：`src/agent/worker-prompts.ts`
- 测试：`src/agent/__tests__/worker-prompts.test.ts`

- [x] **步骤 1：编写失败的测试**

在 `src/agent/__tests__/worker-prompts.test.ts` 增加：

```typescript
it('requires worker evidence fields in primary worker packet', () => {
  const prompt = buildPrimaryWorkerPacket({
    id: 'wo1',
    kind: 'implement',
    objective: 'Fix retry policy',
    scope: { files: ['src/agent/turn-harness.ts'] },
  })

  assert.match(prompt, /filesRead/)
  assert.match(prompt, /filesChanged/)
  assert.match(prompt, /verification/)
  assert.match(prompt, /evidenceStatus/)
})
```

- [x] **步骤 2：运行测试验证失败**

运行：

```bash
npm test -- src/agent/__tests__/worker-prompts.test.ts
```

预期：FAIL，prompt does not mention all evidence fields.

- [x] **步骤 3：更新 worker prompt contract**

In `src/agent/worker-prompts.ts`, add to worker output instructions:

```text
Return a final structured report containing:
- summary: one paragraph of what you did or found
- filesRead: exact file paths you read
- filesChanged: exact file paths you modified, empty for read-only work
- verification: commands run and passed/failed/blocked status
- risks: unresolved concerns or follow-up risks
- evidenceStatus: verified, failed, blocked, or unverified

If you changed files and did not run relevant verification, evidenceStatus must be unverified.
```

- [x] **步骤 4：运行测试验证通过**

运行：

```bash
npm test -- src/agent/__tests__/worker-prompts.test.ts
```

预期：PASS。

- [x] **步骤 5：Commit**

```bash
git add src/agent/worker-prompts.ts src/agent/__tests__/worker-prompts.test.ts
git commit -m "docs(agent): require evidence in worker prompts"
```

---

### 任务 7：README 与最终验证

**文件：**
- 修改：`README.md`

- [x] **步骤 1：更新 README**

加入：

```markdown
### Execution Resilience and Sub-agents

Rivet records tool attempts through TurnHarness and only retries retryable failures such as timeouts or flaky commands. Repeated identical failed tool fingerprints are treated as doom loops and blocked until the agent changes strategy.

Sub-agent workers must return evidence fields (`filesRead`, `filesChanged`, `verification`, `risks`, `evidenceStatus`). Implementation results that change files without verified evidence are blocked by aggregation instead of being treated as complete.
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
git commit -m "docs: describe execution resilience and worker evidence"
```

---

## 自检

### 规格覆盖度

- retry semantics：任务 1 覆盖。
- failure action guidance：任务 2 覆盖。
- doom-loop blocking：任务 3 覆盖。
- worker evidence contract：任务 4 + 6 覆盖。
- aggregation evidence gate：任务 5 覆盖。
- README 与验证：任务 7 覆盖。

### 占位符扫描

本文没有留下未具体化的占位描述；每个任务都包含具体测试、实现片段、命令和预期结果。

### 类型一致性

- `retryable` 在任务 2 的 `FailureClassification` 中定义，可由任务 1 的 retry policy 后续使用。
- `workerResultSchema` 在任务 4 定义，在任务 5 aggregation 和任务 6 prompt contract 中保持字段一致。
- `evidenceStatus` 使用 verified/failed/blocked/unverified，与 Tool Safety + Verification Evidence 计划保持一致。

---

计划已完成并保存到 `docs/superpowers/plans/2026-05-16-rivet-execution-resilience-subagent-evidence.md`。两种执行方式：

**1. 子代理驱动（推荐）** - 每个任务调度一个新的子代理，任务间进行审查，快速迭代

**2. 内联执行** - 在当前会话中使用 executing-plans 执行任务，批量执行并设有检查点

选哪种方式？
