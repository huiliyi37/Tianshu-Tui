# removeLastMessage role 类型守卫 实现计划

> **面向 AI 代理：** 使用 subagent-driven-development（推荐）或 executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 为 `removeLastMessage` 添加 `role === 'user'` 运行时守卫，使该方法不再依赖调用者的控制流不变式来保证安全。

**架构：** `removeLastMessage` 当前是无差别 pop（任何 role 都可删除），但文档和 4 个生产调用者都假定它只删除 user 消息。方案：在 `pop()` 后检查 role，若非 user 则 `push` 回去并抛出错误。这使契约变为机器检查的，未来调用者无法误删 assistant/tool 消息。

**技术栈：** TypeScript strict, `node:test` + `node:assert/strict`

---

## 1. 范围检查

范围极窄——仅涉及 `src/agent/context.ts` 一个方法和其测试文件，无子系统交叉。

**不变更：**
- `loop.ts` 的 4 个调用点——它们已通过 `!assistantResponded` 保证 top 是 user 消息，无需改动。
- `MessageMutation` 类型——无需新增 `remove` 变体（上一 commit 已用 `replace` 解决持久化）。

---

## 2. 文件结构

| 文件 | 操作 | 职责 |
|------|------|------|
| `src/agent/context.ts:99-115` | 修改 | `removeLastMessage` 方法体——添加 role 守卫 |
| `src/agent/__tests__/context.test.ts:356-443` | 修改 | 更新 3 个测试 + 新增 1 个守卫测试 |

---

## 3. 调研背书

### 3a. `removeLastMessage` 方法 — 存在理由

- **定义：** `src/agent/context.ts:99-115`
- **文档注释（94-98 行）：** "Used to roll back a user message when the turn is aborted or fails before any assistant response is produced."
- **调用者（仅 4 处）：**
  1. `src/agent/loop.ts:1081` — turn 循环开始时检测到 abort，`if (!assistantResponded)` 守卫
  2. `src/agent/loop.ts:1427` — stream 完成后检测到 abort，先尝试 `addAssistantBlocks`，仅当 `!assistantResponded` 才 remove
  3. `src/agent/loop.ts:1433` — stream 出错，同上守卫
  4. `src/agent/loop.ts:1502` — outer catch，同上守卫
- **不变式证明：** 4 处调用均在 `!assistantResponded` 为 true 时执行。`assistantResponded` 在 `addAssistantBlocks` 后翻 true（只在有实际内容时）。因此 remove 时栈顶消息必然是 `role: 'user'`。

### 3b. 行为变更风险

- **不会破坏现有生产调用者：** 4 个调用点的守卫保证 top 消息是 user。
- **会破坏测试中"移除 assistant 消息"的行为：** 测试 "removes assistant message without decrementing turnCount" 和 "rollbacks a complete user→assistant→tool sequence in reverse" 依赖移除非 user 消息——这些测试需要更新为期望抛出异常。
- **"emits replace mutation" 测试：** 先移除 assistant 再移除 user。assistant 移除现在会抛出异常。需重写为仅测试 user 消息移除的 mutation。

### 3c. 边界情况

- 空 session：`pop()` 返回 undefined → 跳过守卫 → 返回 undefined（无变化）。
- 连续调用：每次只移除栈顶 user 消息，若中间夹了 assistant/tool 则抛出（正确行为）。
- mutation 事件：仅在成功移除时 emit `replace`（守卫通过后的现有逻辑不变）。

---

## 4. 任务

### Task 1: 添加 role 守卫到 removeLastMessage

- [ ] **修改：** `src/agent/context.ts:99-115`

将 `removeLastMessage` 方法体从：

```typescript
removeLastMessage(): OaiMessage | undefined {
    const msg = this.state.oaiMessages.pop()
    if (msg) {
      this.state.estimatedTokens -= estimateOaiMessageTokens(msg)
      if (msg.role === 'user') this.state.turnCount--
      this.onMutation?.({ type: 'replace', messages: this.state.oaiMessages.slice() })
    }
    return msg
  }
```

改为：

```typescript
removeLastMessage(): OaiMessage | undefined {
    const msg = this.state.oaiMessages.pop()
    if (msg) {
      if (msg.role !== 'user') {
        // Put the message back — this method is contractually for user-message
        // rollback only. Non-user removal indicates a caller bug.
        this.state.oaiMessages.push(msg)
        throw new Error(
          `removeLastMessage: expected user message but top was ${msg.role}. ` +
          'This method may only be used to roll back user messages on abort/error.',
        )
      }
      this.state.estimatedTokens -= estimateOaiMessageTokens(msg)
      this.state.turnCount--
      this.onMutation?.({ type: 'replace', messages: this.state.oaiMessages.slice() })
    }
    return msg
  }
```

**关键变化：**
1. `if (msg.role !== 'user')` 守卫——非 user 消息触发 throw
2. throw 前 `push(msg)` 回去——恢复状态一致性（不丢失消息）
3. `turnCount--` 移出条件分支——守卫已保证是 user，无条件递减

**验证命令：**
```bash
npx tsc --noEmit
```
**期望：** 编译通过，零错误。

- [ ] **提交：** `refactor(agent): add role guard to removeLastMessage — throw on non-user`

---

### Task 2: 更新现有测试 + 新增守卫测试

- [ ] **修改：** `src/agent/__tests__/context.test.ts`

#### 2a. 更新 "removes assistant message" 测试

将（约第 363 行）：

```typescript
it('removes assistant message without decrementing turnCount', () => {
    const ctx = new SessionContext()
    ctx.addUserMessage('hello')
    ctx.addAssistantBlocks([{ type: 'text', text: 'world' }])
    assert.equal(ctx.getTurnCount(), 1)

    const removed = ctx.removeLastMessage()
    assert.equal(removed!.role, 'assistant')
    assert.equal(ctx.getTurnCount(), 1) // turnCount stays at 1 (user message still present)
  })
```

改为：

```typescript
it('throws when top message is assistant (not user)', () => {
    const ctx = new SessionContext()
    ctx.addUserMessage('hello')
    ctx.addAssistantBlocks([{ type: 'text', text: 'world' }])
    assert.equal(ctx.getTurnCount(), 1)
    assert.equal(ctx.getMessages().length, 2)

    assert.throws(
      () => ctx.removeLastMessage(),
      /removeLastMessage: expected user message but top was assistant/,
    )
    // State must be restored — assistant message should still be on the stack
    assert.equal(ctx.getMessages().length, 2)
    assert.equal(ctx.getMessages()[1]!.role, 'assistant')
  })
```

#### 2b. 更新 "rollbacks a complete sequence" 测试

将（约第 399 行）：

```typescript
it('rollbacks a complete user→assistant→tool sequence in reverse', () => {
    const ctx = new SessionContext()
    ctx.addUserMessage('do stuff')
    ctx.addAssistantBlocks([
      { type: 'tool_use', id: 'c1', name: 'bash', input: { command: 'ls' } },
    ])
    ctx.addToolResults([{ type: 'tool_result', tool_use_id: 'c1', content: 'file.ts' }])

    assert.equal(ctx.getMessages().length, 3)
    ctx.removeLastMessage() // tool
    ctx.removeLastMessage() // assistant
    ctx.removeLastMessage() // user
    assert.equal(ctx.getMessages().length, 0)
    assert.equal(ctx.getTurnCount(), 0)
  })
```

改为：

```typescript
it('throws when attempting to rollback tool or assistant messages', () => {
    const ctx = new SessionContext()
    ctx.addUserMessage('do stuff')
    ctx.addAssistantBlocks([
      { type: 'tool_use', id: 'c1', name: 'bash', input: { command: 'ls' } },
    ])
    ctx.addToolResults([{ type: 'tool_result', tool_use_id: 'c1', content: 'file.ts' }])

    assert.equal(ctx.getMessages().length, 3)

    // Tool message is on top — removeLastMessage must throw
    assert.throws(
      () => ctx.removeLastMessage(),
      /removeLastMessage: expected user message but top was tool/,
    )
    // State unchanged after throw
    assert.equal(ctx.getMessages().length, 3)
    assert.equal(ctx.getTurnCount(), 1)
  })

  it('rollbacks a lone user message after failed turn (no assistant response)', () => {
    const ctx = new SessionContext()
    ctx.addUserMessage('do stuff')
    // Simulate: turn was aborted before assistant responded
    // (in production, loop.ts guarantees this via !assistantResponded)
    assert.equal(ctx.getMessages().length, 1)
    assert.equal(ctx.getTurnCount(), 1)

    const removed = ctx.removeLastMessage()
    assert.equal(removed!.role, 'user')
    assert.equal(ctx.getMessages().length, 0)
    assert.equal(ctx.getTurnCount(), 0)
  })
```

#### 2c. 更新 "emits replace mutation" 测试

将（约第 413 行）：

```typescript
it('emits replace mutation so persistence layer can rewrite the file', () => {
    const ctx = new SessionContext()
    const events: Array<{ type: string; messages?: OaiMessage[] }> = []
    ctx.setMutationListener(m => {
      if (m.type === 'replace') events.push({ type: 'replace', messages: m.messages.slice() })
      else events.push({ type: 'append' })
    })

    ctx.addUserMessage('hello')
    ctx.addAssistantBlocks([{ type: 'text', text: 'world' }])
    assert.deepEqual(events, [
      { type: 'append' },
      { type: 'append' },
    ])

    // Remove the assistant message — should emit replace with the remaining user message
    events.length = 0
    ctx.removeLastMessage()
    assert.equal(events.length, 1)
    assert.equal(events[0]!.type, 'replace')
    assert.equal(events[0]!.messages!.length, 1)
    assert.equal(events[0]!.messages![0]!.role, 'user')

    // Remove the user message — should emit replace with empty array
    events.length = 0
    ctx.removeLastMessage()
    assert.equal(events.length, 1)
    assert.equal(events[0]!.type, 'replace')
    assert.equal(events[0]!.messages!.length, 0)
  })
```

改为：

```typescript
it('emits replace mutation on user message removal', () => {
    const ctx = new SessionContext()
    const events: Array<{ type: string; messages?: OaiMessage[] }> = []
    ctx.setMutationListener(m => {
      if (m.type === 'replace') events.push({ type: 'replace', messages: m.messages.slice() })
      else events.push({ type: 'append' })
    })

    ctx.addUserMessage('hello')
    ctx.addAssistantBlocks([{ type: 'text', text: 'world' }])
    assert.deepEqual(events, [
      { type: 'append' },
      { type: 'append' },
    ])

    // Cannot remove assistant — guard throws, no mutation emitted
    events.length = 0
    assert.throws(
      () => ctx.removeLastMessage(),
      /removeLastMessage: expected user message but top was assistant/,
    )
    assert.equal(events.length, 0, 'no mutation emitted on failed removal')

    // Remove messages in correct order: assistant first (via replaceMessages),
    // then the user message (via removeLastMessage)
    ctx.replaceMessages([ctx.getMessages()[0]!]) // keep only user
    events.length = 0
    const removed = ctx.removeLastMessage()
    assert.equal(removed!.role, 'user')
    assert.equal(events.length, 1)
    assert.equal(events[0]!.type, 'replace')
    assert.equal(events[0]!.messages!.length, 0)
  })
```

#### 2d. 新增 "does not emit mutation on failed guard" 测试

在 "does not emit mutation when session is empty" 之后添加：

```typescript
it('does not emit mutation and restores state when guard throws', () => {
    const ctx = new SessionContext()
    ctx.addUserMessage('hello')
    ctx.addAssistantBlocks([{ type: 'text', text: 'world' }])

    let mutationFired = false
    ctx.setMutationListener(() => { mutationFired = true })

    assert.throws(
      () => ctx.removeLastMessage(),
      /removeLastMessage: expected user message but top was assistant/,
    )
    assert.equal(mutationFired, false, 'no mutation when guard throws')
    assert.equal(ctx.getMessages().length, 2, 'state fully restored')
    assert.equal(ctx.getEstimatedTokens() > 0, true, 'tokens not corrupted')
  })
```

**验证命令：**
```bash
npm exec -- tsx --test src/agent/__tests__/context.test.ts
```
**期望：** 全部通过，0 fail。

- [ ] **提交：** `test(agent): update removeLastMessage tests for role guard contract`

---

## 5. 验证

```bash
# 1. 类型检查
npx tsc --noEmit
# 期望：编译通过，零错误

# 2. context 测试
npm exec -- tsx --test src/agent/__tests__/context.test.ts
# 期望：全部通过

# 3. persist 集成测试（确认 mutation 监听器未被破坏）
npm exec -- tsx --test src/agent/__tests__/persist-integration.test.ts
# 期望：全部通过

# 4. 全量测试（确认无回归）
npm exec -- tsx --test 'src/**/__tests__/*.test.ts'
# 期望：全部通过
```

---

## 6. 自检

### 6a. 规格覆盖

| 需求 | 任务 |
|------|------|
| `removeLastMessage` 只能移除 user 消息 | Task 1（守卫）+ Task 2a/2b（测试） |
| 非用户消息触发异常，状态恢复 | Task 1（push back）+ Task 2a/2d（测试） |
| mutation 事件不变（仅成功移除时触发） | Task 2c/2d（测试） |
| 空会话返回 undefined | 现有测试不变 |

### 6b. 占位符扫描

无 TODO / TBD / 待定 / 后续实现 / 补充细节。

### 6c. 类型一致性

- `removeLastMessage()` 返回类型 `OaiMessage | undefined`——不变。
- `OaiMessage.role` 类型为 `'user' | 'assistant' | 'system' | 'tool'`——守卫检查 `!== 'user'` 覆盖所有非 user 变体。
- `this.state.oaiMessages.push(msg)` 签名接受 `OaiMessage`——push back 类型一致。

---

## 7. 执行交接

计划已完成并保存到 `docs/superpowers/plans/2026-05-30-removelast-role-guard.md`。两种执行方式：
1. 子代理驱动（推荐）— 每个任务调度一个新的子代理，任务间进行审查，快速迭代。
2. 内联执行 — 在当前会话中使用 executing-plans 执行任务，批量执行并设有检查点。

选哪种方式？
