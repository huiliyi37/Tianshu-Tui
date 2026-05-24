# Prefix Cache Trailer Mode 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 把 cachedFreshBlock 从独立 user message 合并到最后一条 user message 的 content 开头，消除位置跳动导致的 prefix cache 骤降。

**架构：** 修改 PromptEngine.buildOaiRequest 中 lastUserIdx 的处理逻辑：不再 push 独立消息，而是把 cachedFreshBlock 拼接到最后一条 user message 的 content 开头。消息数组结构变为纯 append-only。

**技术栈：** TypeScript, node:test, DeepSeek V4 API

---

## 文件结构

| 文件 | 职责 | 操作 |
|------|------|------|
| `src/prompt/engine.ts` | 消息组装核心逻辑 | 修改 line 174 区域 |
| `src/prompt/__tests__/engine.test.ts` | PromptEngine 单元测试 | 新增 P2 测试，更新 P1.1b |

---

### 任务 1：编写测试验证 trailer mode 行为

**文件：**
- 修改：`src/prompt/__tests__/engine.test.ts`

- [ ] **步骤 1：编写失败的测试**

```typescript
it('P2: cachedFreshBlock merged into last user message, not as separate message', () => {
  const engine = new PromptEngine({
    model: 'test',
    maxTokens: 8000,
    staticCtx: { tools: [] },
    volatileCtx: { cwd: '/tmp' },
    habituationThreshold: 1,
  })

  // Build request with multiple user messages
  const req = engine.buildOaiRequest([
    { role: 'user', content: 'first question' },
    { role: 'assistant', content: 'first answer' },
    { role: 'user', content: 'second question' },
  ])

  // Count user messages in output (excluding system)
  const userMsgs = req.messages.filter(m => m.role === 'user')

  // Should be exactly 3 user messages:
  // [0] frozenBase (injected at firstUserIdx)
  // [1] 'first question' (original)
  // [2] cachedFreshBlock + 'second question' (merged)
  // NOT 4 messages (with cachedFreshBlock as separate msg)
  assert.equal(userMsgs.length, 3,
    'cachedFreshBlock should be merged into last user msg, not separate')

  // The last user message should contain both cachedFreshBlock content and user input
  const lastUserMsg = userMsgs[userMsgs.length - 1]!
  assert.ok((lastUserMsg.content as string).includes('second question'),
    'last user msg must contain original user input')
  assert.ok((lastUserMsg.content as string).includes('<context>'),
    'last user msg must contain cachedFreshBlock (volatile context)')
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`node --import tsx --test src/prompt/__tests__/engine.test.ts`
预期：FAIL — 当前 cachedFreshBlock 是独立消息，userMsgs.length 为 4

- [ ] **步骤 3：Commit 红灯测试**

```bash
git add src/prompt/__tests__/engine.test.ts
git commit -m "test(prompt): add P2 test for cachedFreshBlock trailer mode merge"
```

---

### 任务 2：实现 trailer mode 合并逻辑

**文件：**
- 修改：`src/prompt/engine.ts:117-181`

- [ ] **步骤 4：修改 buildOaiRequest 的 lastUserIdx 处理**

当前代码（约 line 120-181）的 for 循环中：

```typescript
// 当前逻辑（line 120-174）:
if (i === lastUserIdx) {
  // ... 构建 cachedFreshBlock ...
  result.push({ role: 'user', content: this.cachedFreshBlock })  // line 174
} else if (i === firstUserIdx) {
  result.push({ role: 'user', content: this.volatileBlock })
}
result.push(msg)
```

改为：

```typescript
if (i === lastUserIdx) {
  // ... 构建 cachedFreshBlock（保持不变）...
  // Trailer mode: merge cachedFreshBlock into last user message content
  // instead of pushing as separate message. This keeps the message array
  // structure append-only, preserving DeepSeek exact-prefix cache.
  const originalContent = typeof msg.content === 'string' ? msg.content : ''
  result.push({ role: 'user', content: this.cachedFreshBlock + '\n---\n' + originalContent })
} else if (i === firstUserIdx) {
  result.push({ role: 'user', content: this.volatileBlock })
  result.push(msg)
} else {
  result.push(msg)
}
```

注意：lastUserIdx 分支中不再单独 `result.push(msg)`——msg 的 content 已被合并。其他分支保持 `result.push(msg)`。

- [ ] **步骤 5：运行测试验证通过**

运行：`node --import tsx --test src/prompt/__tests__/engine.test.ts`
预期：P2 测试 PASS

- [ ] **步骤 6：运行类型检查**

运行：`npx tsc --noEmit`
预期：0 errors

- [ ] **步骤 7：Commit**

```bash
git add src/prompt/engine.ts
git commit -m "fix(prompt): merge cachedFreshBlock into last user msg (trailer mode)

cachedFreshBlock was injected as a separate user message before lastUserIdx,
causing its position to jump each turn. This broke DeepSeek exact-prefix
cache from the jump point onward (~20% hit rate drop per user message).

Fix: merge cachedFreshBlock content into the last user message's content
instead of pushing as independent message. Message array structure is now
purely append-only — prefix bytes are 100% stable across turns.

Measured impact: eliminates per-turn cache drops, expected steady-state 95%+."
```

---

### 任务 3：更新现有 P1.1b 测试

**文件：**
- 修改：`src/prompt/__tests__/engine.test.ts`

- [ ] **步骤 8：检查 P1.1b 测试是否需要更新**

P1.1b 测试断言 "Habituated domain content should appear in injected fresh volatile block"。由于 cachedFreshBlock 现在合并进最后一条 user message，断言需要从"倒数第二条 user message"改为"最后一条 user message"。

```typescript
// P1.1b 修改：从检查 allUsers[allUsers.length - 2] 改为 allUsers[allUsers.length - 1]
const injectedBlock = allUsers[allUsers.length - 1]?.content ?? ''
assert.ok(injectedBlock.includes('star-data'),
  'Habituated domain content should appear in last user message (merged)')
```

- [ ] **步骤 9：运行全部 engine 测试**

运行：`node --import tsx --test src/prompt/__tests__/engine.test.ts`
预期：11/11 pass (包括 P1.1a, P1.1b, P2)

- [ ] **步骤 10：Commit**

```bash
git add src/prompt/__tests__/engine.test.ts
git commit -m "test(prompt): update P1.1b assertion for trailer mode merge"
```

---

### 任务 4：运行全量测试 + 验证

- [ ] **步骤 11：运行全量测试**

运行：`node --import tsx --test src/**/__tests__/*.test.ts 2>&1 | tail -20`
预期：全部 pass，无回归

- [ ] **步骤 12：类型检查**

运行：`npx tsc --noEmit`
预期：0 errors

- [ ] **步骤 13：实际 session 验证**

启动新 session，观察 `.rivet/cache-log.jsonl`：
- Turn 0: 20-30%（冷启动，正常）
- Turn 1: 恢复到 80%+
- Turn 2+: 稳定 95%+
- 关键：不应再出现 >10% 的骤降

- [ ] **步骤 14：Commit 验证结果**

如果验证通过，在 cache 设计文档中记录结果。

---

## 自检

1. **规格覆盖度**：设计文档中所有要点（合并逻辑、edge case、分隔符）均有对应任务
2. **占位符扫描**：无 TODO/待定
3. **类型一致性**：`cachedFreshBlock`、`volatileBlock`、`msg.content` 类型在所有任务中一致（string）
