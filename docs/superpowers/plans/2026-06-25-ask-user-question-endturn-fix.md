# ask_user_question 重复调用修复计划

> **面向 AI 代理：** 使用 `executing-plans` 逐任务实现。

**目标：** 修复 `ask_user_question` 工具被模型在同一 turn 内重复调用的 bug。

**架构：** 在 ToolResult 类型上新增 `endTurn` 信号字段，ask_user_question 返回 `endTurn: true`，turn-orchestrator 在执行完工具批次后检查该信号，若为 true 则结束 turn（`isFinal: true`），不回入循环。

**技术栈：** TypeScript strict, node:test + assert/strict

---

## 背景：Bug 根因

### 现象

模型调用 `ask_user_question` 后，在没有收到用户回复的情况下，同一个 turn 内再次调用 `ask_user_question`（或其他工具），形成无效循环。用户看到多个相同的提问。

### 根因

`ask_user_question` 的设计是"提问后结束 turn，等用户下一条消息作为回答"。但这个"结束 turn"的意图**没有在任何系统层面被强制执行**：

1. `ToolResult` 类型（`src/tools/types.ts`）没有 `endTurn` / `stopTurn` 字段。
2. `ask_user_question.execute()` 返回正常的 `{ content: '[Awaiting your response…]', uiContent }`——和任何普通工具结果无异。
3. `turn-orchestrator.ts:760` 的逻辑是 `if (toolUses.length > 0)` → 执行工具 → `completeTurn(isFinal: false)` → `continue`（回入循环）。只要模型发出工具调用，turn 就不结束。
4. 模型收到 `'[Awaiting your response…]'` 作为 tool_result，理解为"可以继续工作"，于是又调一次 ask_user_question。
5. Phantom continuation 检查不触发——因为 ask_user_question 路径上有工具调用（不是 no-tool turn）。

本质：**工具的语义意图（"我需要等用户回复"）和 loop 的控制流（"有工具调用就继续"）之间断了**。

### 修复策略

在 `ToolResult` 上新增 `endTurn?: boolean` 字段。ask_user_question 返回 `endTurn: true`。turn-orchestrator 在工具批次执行后检查：如果任一工具返回 `endTurn: true`，则 `completeTurn(isFinal: true)` 并跳出循环，而不是 `continue`。

---

## 当前系统调研

### 关键文件

| 文件 | 职责 | 关键位置 |
|------|------|----------|
| `src/tools/types.ts` | ToolResult 类型定义 | L122-145 `ToolResult` 接口 |
| `src/tools/ask-user-question.ts` | ask_user_question 工具 | L59-62 execute 返回值 |
| `src/agent/turn-orchestrator.ts` | turn 循环主逻辑 | L760-825 工具执行→completeTurn→continue |
| `src/agent/tool-execution.ts` | 工具批次执行 | executeBatch 返回 ExecuteBatchResult |

### 消费方枚举

- `ToolResult` 被 40+ 个工具返回。新增 optional 字段不破坏任何现有工具。
- `turn-orchestrator.ts:821` 是唯一的 `completeTurn(isFinal: false)` + `continue` 路径（工具调用后）。
- `executeBatch` 返回 `ExecuteBatchResult`——需要透传 `endTurn` 信号。

---

## 任务

### 任务 1：ToolResult 新增 endTurn 字段 + ask_user_question 标记

- [ ] 修改 `src/tools/types.ts:ToolResult` — 新增 `endTurn?: boolean`
- [ ] 修改 `src/tools/ask-user-question.ts:execute()` — 返回 `endTurn: true`
- [ ] 修改 `src/agent/tool-execution.ts` — ExecuteBatchResult 透传 endTurn 信号
- [ ] 创建 `src/tools/__tests__/ask-user-question-endturn.test.ts` — 验证 endTurn 信号

**目标：** 让 ask_user_question 在工具结果层面声明"此工具调用后应结束 turn"。

**实现：**

`src/tools/types.ts` ToolResult 新增字段：
```typescript
export interface ToolResult {
  // ...现有字段不变...
  /** Signal the turn loop to end after this tool result (e.g. ask_user_question
   *  needs the user's next message as the answer). When true, the orchestrator
   *  completes the turn as final instead of continuing the tool loop. */
  endTurn?: boolean
}
```

`src/tools/ask-user-question.ts` execute 返回值新增：
```typescript
return {
  content: '[Awaiting your response…]',
  uiContent,
  endTurn: true,
}
```

`src/agent/tool-execution.ts` ExecuteBatchResult 新增透传：
```typescript
// 在 ExecuteBatchResult 接口新增：
endTurn?: boolean

// 在 executeBatch 完成后检查：
const endTurn = results.some(r => r.endTurn === true)
return { ...existingFields, endTurn }
```

**验证：**
```bash
npx tsc --noEmit
npm exec -- tsx --test src/tools/__tests__/ask-user-question-endturn.test.ts
```

**提交：**
```
fix(tools): add endTurn signal to ToolResult — ask_user_question declares turn-ending intent
```

---

### 任务 2：turn-orchestrator 响应 endTurn 信号

- [ ] 修改 `src/agent/turn-orchestrator.ts:760-825` — 工具执行后检查 endTurn
- [ ] 修改 `src/agent/__tests__/turn-orchestrator-goal.test.ts` 或新建测试

**目标：** turn-orchestrator 在工具批次执行后，如果任一工具返回 `endTurn: true`，则以 `isFinal: true` 结束 turn，不回入循环。

**实现：**

`turn-orchestrator.ts` L818-825 变更：

现有代码：
```typescript
this.deps.flushMeridianTurn()
await rejectOnAbort(
  this.deps.completeTurn({ turn, isFinal: false, callbacks }),
  signal!,
  'post-turn',
)
continue
```

改为：
```typescript
this.deps.flushMeridianTurn()

// endTurn signal: a tool (e.g. ask_user_question) requested turn termination.
// Complete as final and break out of the loop instead of continuing.
if (r.endTurn) {
  await rejectOnAbort(
    this.deps.completeTurn({ turn, isFinal: true, emitBadge: true, callbacks }),
    signal!,
    'post-turn-endTurn',
  )
  finalTurnCompleted = true
  break
}

await rejectOnAbort(
  this.deps.completeTurn({ turn, isFinal: false, callbacks }),
  signal!,
  'post-turn',
)
continue
```

**验证：**
```bash
npx tsc --noEmit
npm exec -- tsx --test src/tools/__tests__/ask-user-question-endturn.test.ts
npm exec -- tsx --test src/agent/__tests__/repair-parity.test.ts
# 全量确认无回归
npm exec -- tsx --test src/**/__tests__/*.test.ts
```

**预期认知影响：**
- ask_user_question 调用后 turn 立即结束，模型不会重复调用同一工具。
- 用户看到一个问题后，输入回复才触发下一 turn。行为符合工具设计意图。
- 不影响其他工具——只有显式返回 `endTurn: true` 的工具触发此路径。

**提交：**
```
fix(agent): turn-orchestrator respects endTurn signal — stops loop after ask_user_question
```
