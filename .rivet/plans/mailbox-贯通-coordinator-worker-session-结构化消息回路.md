# Mailbox 贯通：coordinator → worker session 结构化消息回路

# Mailbox 贯通：coordinator → worker session 结构化消息回路

> **状态：✅ 已完成** · 2 commits  
> `c097720c` — 接线：WorkerSessionConfig + mailbox sender + drain  
> `21de9182` — 修复：单 delegate() 调用也 drain mailbox  

## 1. 问题

`worker-mailbox.ts` 实现了完整的结构化消息协议（finding / request / artifact / progress / escalation），`DelegationCoordinator` 构造时创建了 `InMemoryMailbox` 实例并每波清除。但：

- `WorkerSessionConfig` 没有 mailbox 字段
- `runWorkerSession` 从未接收 mailbox——worker 工具调用链路无法发送结构化消息
- 波完成后 coordinator 不消费 mailbox 消息——findings/escalations 被静默丢弃

**结果**：mailbox 是写端+读端双断的装饰性组件。

## 2. 数据流设计

```mermaid
flowchart TD
    COORD[DelegationCoordinator] --> |创建| MB[(InMemoryMailbox)]
    COORD --> |注入 mailbox 到| WSC[WorkerSessionConfig]
    WSC --> |传给| RWS[runWorkerSession]
    RWS --> |createWorkerMailboxSender| SEND[mailbox.send()]
    SEND --> |progress/finding/escalation/artifact| MB
    COORD --> |波完成后 drain| DRAIN{findings/escalations?}
    DRAIN --> |findings| PKT[追加到 packet]
    DRAIN --> |escalations| RISK[追加到 risks]
    
    classDef coord fill:#1e293b,stroke:#38bdf8,color:#e0f2fe
    classDef store fill:#1e1b4b,stroke:#a78bfa,color:#ede9fe
    classDef worker fill:#0f172a,stroke:#818cf8,color:#e0e7ff
    class COORD coord
    class MB store
    class WSC,RWS,SEND worker
    class DRAIN,PKT,RISK coord
```

## 3. 变更清单

### 3.1 `WorkerSessionConfig` 加 mailbox 字段

`src/agent/worker-session.ts:36` — 新增：

```typescript
export interface WorkerSessionConfig {
  // ... existing fields ...
  /** Structured mailbox for inter-agent communication. Worker tools
   *  report progress, findings, and escalations through this channel. */
  mailbox?: WorkerMailbox
}
```

### 3.2 Coordinator 注入 mailbox

`src/agent/coordinator.ts` — `delegateOrder` 中，在调用 `this.config.runtimeFactory` 之后：

```typescript
const workerConfig = this.config.runtimeFactory(order, selected, workerRegistry)
workerConfig.mailbox = this.mailbox  // ← 新增
```

### 3.3 `runWorkerSession` 消费 mailbox

`src/agent/worker-session.ts` — 在 `runWorkerSession` 中：

```typescript
// 为 worker 创建 scoped mailbox sender
if (config.mailbox) {
  const workerSender = createWorkerMailboxSender(config.mailbox, config.order.id)
  // 注入到 tool execution context，供工具通过 params.mailbox 发送结构化消息
  config.toolContextExtras = { mailbox: workerSender }
}
```

Tool execution 侧：`ToolCallParams` 已有扩展点——在工具 pipeline 中，params 里有 `onOutput` 和 `onActivity`，可以新增 `mailbox` 字段。但为最小侵入，**此 phase 只做 worker session 侧的 mailbox sender 创建，不延伸到 tool params**。worker session 在 turn 边界通过 agent callbacks 主动上报 progress。

### 3.4 Coordinator 波完成后 drain mailbox

`src/agent/coordinator.ts` — `delegateBatch` 方法完成后：

```typescript
// Drain mailbox: append findings to run packet, escalations to risks
const findings = this.mailbox.byType('finding')
const escalations = this.mailbox.byType('escalation')
if (findings.length > 0 || escalations.length > 0) {
  const notes: string[] = []
  for (const f of findings) notes.push(`📬 ${f.from}: ${f.payload.summary}`)
  for (const e of escalations) notes.push(`🚨 ${e.from}: ${e.payload.summary}`)
  // append to run.packet
}
this.mailbox.clear()
```

## 4. 不变的部分

- `InMemoryMailbox` 类不变——已是正确实现
- `createWorkerMailboxSender` 不变——已是正确封装
- 消息协议（`MailboxMessage` types）不变
- 每波清除行为不变

## 5. 文件清单

| 文件 | 变更类型 | 行数估计 |
|------|----------|----------|
| `src/agent/worker-session.ts` | 修改 — 加 mailbox 字段 + sender 创建 | +15 |
| `src/agent/coordinator.ts` | 修改 — 注入 mailbox + drain | +20 |
| `src/agent/__tests__/worker-mailbox.test.ts` | 保持 | 0 |

## 6. 验证

```bash
npx tsc --noEmit
npm exec -- tsx --test src/agent/__tests__/worker-mailbox.test.ts
```
