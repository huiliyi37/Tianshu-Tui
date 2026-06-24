# Subagent 持久化与 Resume 能力计划

> **面向 AI 代理：** 使用 `executing-plans` 逐任务实现。

**目标：** 让 delegate_task 的 worker 从一次性函数调用升级为可 resume 的持久 agent 实例——模型可以指定 `resume: "worker_id"` 继续上次的工作上下文，而不必每次从头重建。

**架构：** 现有 coordinator 已有 result 持久化（`~/.rivet/subagents/<orderId>.json`）和 fingerprint-based resume（返回上次的 summary）。本计划在此基础上增加 worker session 历史持久化（`~/.rivet/subagents/<orderId>.session.jsonl`）和 delegate_task 的 `resume` 参数，让 coordinator 能重建 worker 的对话历史并继续执行。

**技术栈：** TypeScript strict, node:test + assert/strict

---

## 背景：为什么需要这个

当前 delegate_task 的 worker 是 fire-and-forget——每次调用创建全新 worker session，传 objective，返 result，结束。如果主 agent 想对同一个 worker 说"继续上次的任务，但换个方向"，没有办法做到：必须重新传全部上下文。

对比 kimi-code：`Agent` 工具有 `resume: "agent_id"` 参数。resume 时 `SessionSubagentHost` 用保存的 wire.jsonl 重建 worker 的完整对话历史，worker 能看到自己上次做了什么。还有 summary 质量保障——如果子 agent 返回的 summary 短于 200 字符，自动触发 follow-up 让它扩展。

天枢已有的优势保留：result 持久化 + fingerprint resume（缓存命中返回上次结果）、circuit breaker（profile 级故障隔离）、worker liveness（stall 检测）。

## 当前系统调研

### 现有文件和类型

| 文件 | 职责 | 关键类型 |
|------|------|----------|
| `src/agent/coordinator.ts:304-320` | persistWorkerResult — 写 `~/.rivet/subagents/<orderId>.json` | `WorkerResult` |
| `src/agent/coordinator.ts:325-360` | loadPersistedResult / resumeFromFingerprint — 读取上次 result | fingerprint-based cache |
| `src/agent/coordinator.ts:224-225` | resumeEnabled config — 控制 fingerprint resume | opt-in |
| `src/agent/worker-session.ts` | runWorkerSession — 创建并运行 worker session | `WorkerSessionConfig`, `WorkerSessionRun` |
| `src/tools/delegate-task.ts` | delegate_task 工具定义 | 无 resume 参数 |
| `src/tools/delegate-batch.ts` | delegate_batch 工具定义 | 无 resume 参数 |
| `src/agent/work-order.ts` | WorkOrder 类型 + createReadOnlyWorkOrder/createWriteWorkOrder | `WorkOrder`, `WorkerProfile` |

### 现有 worker 生命周期

```
delegate_task({ objective })
  → coordinator.delegate({ parentTurnId, objective, profile, ... })
    → createWorkOrder(objective, profile)
    → runWorkerSession(workOrder, config)  // 全新 session，无历史
    → persistWorkerResult(result)          // 写 result 到磁盘
    → return result                        // 主 agent 收到 summary
```

### 现有消费方枚举（resume 相关）

- `coordinator.ts:224` — `resumeEnabled` config（控制 fingerprint cache resume）
- `coordinator.ts:340-360` — `resumeFromFingerprint`（返回上次的 cached result）
- `coordinator-resume.test.ts` — 已有 resume 测试（但是 fingerprint cache，不是 session resume）

### 关键 gap

1. **delegate_task 无 resume 参数** — 模型无法表达"继续上次的工作"
2. **worker session 历史不持久化** — `runWorkerSession` 创建全新 session，不加载历史
3. **无 summary 质量保障** — worker 返回短 summary 时没有 follow-up 机制

---

## 任务

### 任务 1：Worker session 历史持久化

- [x] 创建 `src/agent/worker-session-persist.ts` — save/load worker session 历史
- [x] 创建 `src/agent/__tests__/worker-session-persist.test.ts` — 持久化测试
- [x] 修改 `src/agent/coordinator.ts:304-320` — persistWorkerResult 同时保存 session 历史

**目标：** worker 执行结束后，将其对话历史（user prompt + assistant responses + tool calls）持久化到 `~/.rivet/subagents/<orderId>.session.jsonl`，供 resume 时重建。

**调研背书：**
- `persistWorkerResult`（coordinator.ts:304-320）：已写 result JSON。在同一个函数里追加 session 历史写入，不改变现有 result 写入逻辑。
- `runWorkerSession`（worker-session.ts）：返回 `WorkerSessionRun`，其中包含 worker 的 messages 数组。这些 messages 就是需要持久化的内容。
- `WorkerSessionRun` 的 messages 字段——需要确认它是否包含完整的 tool_call/tool_result 历史。

**实现：**

`src/agent/worker-session-persist.ts`:
```typescript
import { join } from 'node:path'
import { homedir } from 'node:os'
import { mkdirSync, writeFileSync, readFileSync, existsSync, appendFileSync } from 'node:fs'
import type { OaiMessage } from '../api/oai-types.js'

export interface WorkerSessionRecord {
  readonly workOrderId: string
  readonly profile: string
  readonly objective: string
  readonly messages: readonly OaiMessage[]
  readonly savedAt: number
}

export function workerSessionPath(workOrderId: string, homeDir: string = homedir()): string {
  return join(homeDir, '.rivet', 'subagents', `${workOrderId}.session.jsonl`)
}

export function saveWorkerSession(
  workOrderId: string,
  profile: string,
  objective: string,
  messages: readonly OaiMessage[],
  homeDir: string = homedir(),
): void {
  try {
    const dir = join(homeDir, '.rivet', 'subagents')
    mkdirSync(dir, { recursive: true })
    const record: WorkerSessionRecord = {
      workOrderId,
      profile,
      objective,
      messages,
      savedAt: Date.now(),
    }
    writeFileSync(workerSessionPath(workOrderId, homeDir), JSON.stringify(record) + '\n', 'utf-8')
  } catch {
    // Best-effort: never block primary session on persistence failure
  }
}

export function loadWorkerSession(workOrderId: string, homeDir: string = homedir()): WorkerSessionRecord | null {
  const path = workerSessionPath(workOrderId, homeDir)
  if (!existsSync(path)) return null
  try {
    const content = readFileSync(path, 'utf-8').trim()
    if (!content) return null
    return JSON.parse(content) as WorkerSessionRecord
  } catch {
    return null
  }
}
```

**验证：**
```bash
npx tsc --noEmit
npm exec -- tsx --test src/agent/__tests__/worker-session-persist.test.ts
```

测试要点：
- save → load 往返一致
- 文件不存在时 load 返回 null
- 损坏 JSON 时 load 返回 null（不抛异常）
- 空消息数组可以保存和加载

**提交：**
```
feat(agent): add worker session history persistence for resume support
```

---

### 任务 2：delegate_task resume 参数

- [x] 修改 `src/tools/delegate-task.ts` — 新增 `resume` 参数到 input_schema 和 zod schema
- [x] 修改 `src/agent/coordinator.ts` — delegate 方法接受 resume 参数，加载历史 messages 传给 runWorkerSession
- [x] 修改 `src/agent/work-order.ts` — DelegationRequest 新增 `resumeWorkOrderId?: string`
- [x] 修改 `src/agent/worker-session.ts` — runWorkerSession 接受 optional `priorMessages` 参数
- [x] 修改 `src/tools/__tests__/delegate-task.test.ts` — resume 参数测试
- [x] 创建 `src/agent/__tests__/coordinator-session-resume.test.ts` — coordinator 级 resume 测试

**目标：** 模型调用 `delegate_task({ objective, resume: "wo_abc123" })` 时，coordinator 加载该 worker 的历史对话，worker 在已有上下文基础上继续工作。

**调研背书：**
- `delegateTaskInputSchema`（delegate-task.ts:38-45）：zod schema 无 resume 字段。新增 optional `resume: z.string().optional()`。
- `DelegationRequest`（coordinator.ts 中定义）：需新增 `resumeWorkOrderId?: string`。
- `runWorkerSession`（worker-session.ts）：当前创建全新 session。需确认它是否能接受 preseeded messages——如果它内部直接构造 messages 数组（`[{role:'system',...}, {role:'user', content: objective}]`），需要改为在 priorMessages 存在时替换初始 user message。
- `coordinator.delegate` 的调用链：delegate_task.ts:130+ 调用 `coordinator.delegate(request)`，request 是 DelegationRequest 类型。

**实现：**

`delegate-task.ts` schema 扩展：
```typescript
const delegateTaskInputSchema = z.object({
  objective: z.string().min(1),
  kind: z.enum(['code_search', 'doc_research', 'plan', 'review', 'verify', 'patch_proposal']).optional(),
  profile: profileStringSchema.optional(),
  authority: authorityStringSchema.optional(),
  files: z.array(z.string()).optional(),
  symbols: z.array(z.string()).optional(),
  resume: z.string().optional().describe(
    'Optional worker ID to resume instead of creating a new worker. When provided, the worker continues from its previous session history. The objective should describe the continuation task.'
  ),
})
```

`delegate-task.ts` input_schema 扩展：
```typescript
// 在 input_schema.properties 中新增：
resume: { type: 'string', description: 'Worker ID to resume. The worker continues from its previous session context.' },
```

`delegate-task.ts` execute 传递 resume：
```typescript
const run = await coordinator.delegate({
  parentTurnId: params.toolUseId,
  objective: parsed.data.objective,
  // ...现有字段...
  resumeWorkOrderId: parsed.data.resume,
})
```

`work-order.ts` DelegationRequest 扩展：
```typescript
// 在 DelegationRequest 接口中新增：
resumeWorkOrderId?: string
```

`coordinator.ts` delegate 方法扩展——在调用 runWorkerSession 之前检查 resume：
```typescript
// 在 delegate 方法内，调用 runWorkerSession 之前：
let priorMessages: OaiMessage[] | undefined
if (request.resumeWorkOrderId) {
  const record = loadWorkerSession(request.resumeWorkOrderId)
  if (record) {
    priorMessages = record.messages
    // 向 worker 注入 continuation 提示而不是完全替换
    // priorMessages 的最后一条是上次的 assistant 响应
    // 本次 objective 作为新的 user message 追加
  }
}
// 传给 runWorkerSession：
const sessionRun = await runWorkerSession(workOrder, {
  ...config,
  priorMessages,
})
```

`worker-session.ts` 扩展——接受 priorMessages：
```typescript
export interface WorkerSessionConfig {
  // ...现有字段...
  /** Prior conversation history to resume from. When provided, the worker
   *  starts with these messages instead of a fresh [system, user] pair. */
  priorMessages?: readonly OaiMessage[]
}

// 在 runWorkerSession 内部：
const messages = config.priorMessages
  ? [...config.priorMessages, { role: 'user', content: workOrder.objective }]
  : [{ role: 'system', content: systemPrompt }, { role: 'user', content: workOrder.objective }]
```

**验证：**
```bash
npx tsc --noEmit
npm exec -- tsx --test src/tools/__tests__/delegate-task.test.ts
npm exec -- tsx --test src/agent/__tests__/coordinator-session-resume.test.ts
```

测试要点：
- resume 参数不提供时，行为与现有完全一致（全新 worker）
- resume="wo_abc" 且历史存在时，worker session 包含 priorMessages + 新 objective
- resume="wo_abc" 但历史不存在时，降级为全新 worker（不报错，在 result.summary 中标注 "[no prior session found, started fresh]"）
- resume 的 worker 使用上次的 profile（如果 profile 参数省略）

**提交：**
```
feat(tools): add resume parameter to delegate_task for persistent worker sessions
```

---

### 任务 3：Summary 质量保障

- [x] 修改 `src/agent/coordinator.ts` — worker 返回短 summary 时自动触发一轮 follow-up
- [x] 创建 `src/agent/__tests__/worker-summary-expansion.test.ts` — summary 扩展测试

**目标：** worker 返回的 summary 短于阈值时（默认 200 字符），自动追加一轮 follow-up 让 worker 扩展 summary，确保主 agent 收到技术完整的交接信息。

**调研背书：**
- `WorkerResult.summary`（work-order.ts）：worker 返回给主 agent 的最终摘要。
- kimi-code 的 `SUMMARY_MIN_LENGTH = 200` 和 `SUMMARY_CONTINUATION_ATTEMPTS = 1`（subagent-host.ts）。

**实现：**

`coordinator.ts` 在 runWorkerSession 返回后检查 summary 长度：
```typescript
const SUMMARY_MIN_LENGTH = 200
const SUMMARY_CONTINUATION_ATTEMPTS = 1

// 在获取 sessionRun 后、persistWorkerResult 之前：
let finalSummary = sessionRun.summary
let continuationAttempts = 0
while (finalSummary.length < SUMMARY_MIN_LENGTH && continuationAttempts < SUMMARY_CONTINUATION_ATTEMPTS) {
  continuationAttempts++
  const expansionRun = await runWorkerSession(workOrder, {
    ...config,
    priorMessages: sessionRun.messages,  // 继续当前 session
    expansionPrompt: `Your previous summary was too brief. Expand it to at least ${SUMMARY_MIN_LENGTH} characters. Include: what you found, what you changed, what remains open. Previous summary: "${finalSummary}"`,
  })
  if (expansionRun.summary.length > finalSummary.length) {
    finalSummary = expansionRun.summary
  }
}
```

**验证：**
```bash
npx tsc --noEmit
npm exec -- tsx --test src/agent/__tests__/worker-summary-expansion.test.ts
```

测试要点：
- summary >= 200 字符时不触发 follow-up
- summary < 200 字符时触发一次 follow-up
- follow-up 返回更长的 summary 时使用新 summary
- follow-up 返回更短的 summary 时保留原 summary（不退步）
- continuationAttempts 达到上限后停止

**提交：**
```
feat(agent): auto-expand brief worker summaries for better parent handoff
```

---

### 任务 4：全量验证和回归测试

- [x] 运行 `npx tsc --noEmit` — 确保 0 错误
- [x] 运行相关测试全量
- [x] 确认现有 coordinator-resume.test.ts（fingerprint cache）未断裂

**验证命令：**
```bash
npx tsc --noEmit
npm exec -- tsx --test src/agent/__tests__/worker-session-persist.test.ts
npm exec -- tsx --test src/agent/__tests__/coordinator-session-resume.test.ts
npm exec -- tsx --test src/agent/__tests__/coordinator-resume.test.ts
npm exec -- tsx --test src/agent/__tests__/worker-summary-expansion.test.ts
npm exec -- tsx --test src/tools/__tests__/delegate-task.test.ts
npm exec -- tsx --test src/tools/__tests__/delegate-batch.test.ts
npm exec -- tsx --test src/agent/__tests__/coordinator-progress.test.ts
# 全量 agent 测试
npm exec -- tsx --test src/agent/__tests__/*.test.ts
```

**预期认知影响（prompt/agent 行为变更）：**
- delegate_task 工具描述新增 resume 参数说明——模型知道可以 resume 上次的 worker
- summary 质量保障——主 agent 收到的 worker summary 更完整，减少"不知道 worker 做了什么"的信息不对称
- worker session 持久化——进程崩溃后 worker 的工作不丢失，可被后续 delegate_task resume

---

## 数据流图

```
delegate_task({ objective, resume: "wo_abc" })
    │
    ▼
coordinator.delegate({ resumeWorkOrderId: "wo_abc" })
    │
    ├── loadWorkerSession("wo_abc") → priorMessages
    │
    ├── runWorkerSession(workOrder, { priorMessages })
    │       │
    │       ├── messages = [...priorMessages, { role:'user', content: objective }]
    │       └── worker runs with full context
    │
    ├── [if summary < 200 chars] → follow-up expansion turn
    │
    ├── persistWorkerResult(result)
    ├── saveWorkerSession(workOrderId, profile, objective, sessionRun.messages)
    │
    └── return result to main agent
```
