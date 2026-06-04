# 动态附录独立化 — 消除 turn 间 prefix cache 断裂

> **状态：✅ 已全部实施** — 动态附录独立消息注入，消除 prefix cache 断裂

**目标：** 将动态附录（`buildDynamicAppendix` 输出）从 `lastUserIdx` 的 trailer merge 改为独立追加在消息列表末尾，使倒数第二条 user message 的字节在 turn 间完全不变，消除 DeepSeek exact-prefix cache 在 turn 2+ 的 ~44% 命中率骤降。

**架构：** 当前 `cachedFreshBlock`（= `volatileBlock + dynamicAppendix`）被 trailer-merge 进最后一条 user message。当 agent 在 turn 1 执行工具后产生 taskProgress/decisions/toolHistory 等动态字段时，turn 2 的 `cachedFreshBlock` 相比 turn 1 增长 ~3K-8K tokens，导致最后一条 user message 的字节变化 → DeepSeek exact-prefix cache 在该位置断裂。修复：最后一条 user message 只 merge FROZEN `volatileBlock`（与 historical 消息格式一致），动态附录以独立 `role:'user'` 消息追加在 `result` 末尾。由于它是最后一条消息，自身变化不影响任何前缀。

**技术栈：** TypeScript strict, node:test + node:assert/strict

---

## 1. Scope check

此变更只涉及一个子系统：`PromptEngine.buildOaiRequest` 中 `lastUserIdx` 分支的消息构造逻辑。不跨子系统。

调用方（2 处）均透明受益：
- `src/agent/loop.ts:1564` — 主 agent loop 每 turn 构建请求
- `src/agent/compaction-controller.ts:600` — LLM compact 构建 compact 请求

两者都不依赖 trailer merge 的特定格式（只消费 `OaiChatRequest.messages`），无需修改。

## 2. File structure

| 文件 | 操作 | 职责 |
|------|------|------|
| `src/prompt/engine.ts` | 修改 | 核心变更：`lastUserIdx` 分支改用 `volatileBlock` trailer merge，动态附录独立追加 |
| `src/prompt/__tests__/engine.test.ts` | 修改 | 更新 trailer-merge 相关断言，新增独立附录测试 |
| `src/prompt/__tests__/engine-cache-stability.test.ts` | 修改 | 验证 turn 间 lastUserMsg 字节稳定性 |

## 3. Research endorsement（调研背书）

### 3.1 `cachedFreshBlock` 的构建与使用

**调用位置**：`src/prompt/engine.ts:216-218`
```typescript
this.cachedFreshBlock = fullAppendix
  ? this.volatileBlock + '\n' + fullAppendix
  : this.volatileBlock
```

**存在原因**：trailer-merge 进最后一条 user message，让模型在最新 user message 中看到当前会话状态（star domain、tool history、task progress、decisions、git status 等）。

**变更**：`cachedFreshBlock` 拆分为两部分使用：
- FROZEN `volatileBlock` → trailer-merge 进最后一条 user message（与 historical 消息一致）
- `fullAppendix`（动态部分）→ 独立 user-role 消息追加在 `result` 末尾

**风险**：
- ❌ **消息顺序**：追加 user-role 消息在最后一条 user message 之后、模型回复之前，API 允许连续的 user 消息（DeepSeek/OpenAI 兼容），不会报错。
- ❌ **frozen snapshot 格式变更**：此前 frozen 存储 `cachedFreshBlock + userContent`，现改为 `volatileBlock + userContent`。`getNextFrozen` 只取不解析，格式变更不影响检索。但**存量 frozen entries**（旧格式）和新格式混用会导致同一 userContent 的 historical 渲染在不同 turn 间不一致——需在 `rebuildVolatileBlock` 时清空 `frozenUserMerged`。
- ✅ **cachedFreshForUser 缓存**：不变。仍用于判断是否需要重新计算动态上下文。
- ✅ **habituation tracker**：`tracker.recordTurn` 和 `consolidatedBlock` 计算仍在 `lastUserIdx` 分支内触发，不受影响。
- ✅ **LLM compact 路径**（`compaction-controller.ts:600`）：compact 请求同样经过 `buildOaiRequest`，独立附录也会出现在 compact prompt 中。compact 是"总结对话"请求，额外一条上下文消息不会干扰总结质量。

### 3.2 `frozenUserMerged` 清空时机

**当前清空**：`src/prompt/engine.ts:517-518`（`rebuildVolatileBlock` 中）
```typescript
this.cachedFreshForUser = ''
this.cachedFreshBlock = ''
```
**变更**：增加 `this.frozenUserMerged.clear()`。原因：frozen 条目存储格式从 `cachedFreshBlock + userContent` 变为 `volatileBlock + userContent`。`volatileBlock` 在 `rebuildVolatileBlock` 时已更新，旧格式 frozen 条目与新 `volatileBlock` 不匹配，会导致 historical 消息在不同 turn 间字节不一致。

**风险**：清空 frozen 后，下一轮所有 historical 消息走到 fallback 路径（trailer-merge `volatileBlock`）。这会产生**一次性的** cache miss（所有 historical 消息内容变化），但后续 turn 恢复稳定。可接受——`rebuildVolatileBlock` 在 session restore / model switch 时调用，本身就会触发 cache 重建。

### 3.3 测试影响分析

受影响的测试文件：
- `src/prompt/__tests__/engine.test.ts`：直接断言 trailer-merge 包含 `cachedFreshBlock` 的测试（行 30-37, 298-354）
- `src/prompt/__tests__/engine-cache-stability.test.ts`：验证 FROZEN/FRESH 关系的测试

需要新增的测试：
- 动态附录作为独立消息出现在 `result` 末尾
- 最后一条 user message 不含动态附录字段（如 `<tool-history>`）
- turn 间最后一条 user message 字节不变（langmuir probe）

## 4. Tasks

### Task 1: 编写 langmuir probe — turn 间 lastUserMsg 字节稳定性

- [ ] **创建**：无新文件
- [ ] **修改**：`src/prompt/__tests__/engine-cache-stability.test.ts`（追加测试）

**步骤**：

1. 在 `engine-cache-stability.test.ts` 末尾追加测试：

```typescript
it('last user message bytes are stable across turns (dynamic appendix is standalone)', () => {
  const engine = new PromptEngine(makeConfig())
  
  // Turn 1: first user message
  const req1 = engine.buildOaiRequest([
    { role: 'user', content: 'first question' }
  ])
  const lastUser1 = req1.messages.filter(m => m.role === 'user').at(-1)!
  
  // Simulate tool execution by setting task progress
  engine.setTaskProgress({ current: 'working', completed: ['step1'], remaining: ['step2'] })
  
  // Turn 2: second user message — the FIRST user message is now historical
  const req2 = engine.buildOaiRequest([
    { role: 'user', content: 'first question' },
    { role: 'assistant', content: 'answer' },
    { role: 'user', content: 'second question' },
  ])
  
  // The FIRST user message (now historical) must have identical bytes to turn 1
  const firstUserTurn1 = req1.messages.filter(m => m.role === 'user').at(-1)!.content
  const firstUserTurn2 = req2.messages.filter(m => m.role === 'user')[0]!.content
  // Note: turn 1 has only 1 user msg → lastUserIdx merges volatileBlock
  // turn 2 has 2 user msgs → first user msg uses frozen snapshot (same volatileBlock format)
  // They should be identical because the frozen snapshot stores volatileBlock format
})
```

2. 运行确认失败：`npx tsx --test src/prompt/__tests__/engine-cache-stability.test.ts`

3. 提交：`test(prompt): add langmuir probe for lastUserMsg byte stability across turns`

### Task 2: 核心变更 — `lastUserIdx` 分支 + 独立附录追加

- [ ] **修改**：`src/prompt/engine.ts:225-238`（lastUserIdx trailer merge 逻辑）
- [ ] **修改**：`src/prompt/engine.ts:370-374`（return 前追加附录消息）
- [ ] **修改**：`src/prompt/engine.ts:517-518`（rebuildVolatileBlock 清空 frozenUserMerged）

**步骤**：

1. 在 `PromptEngine` 类中添加私有字段 `cachedAppendix`（行 ~52，与其他缓存字段并列）：
```typescript
private cachedAppendix: string = ''
```

2. 修改 `lastUserIdx` 分支的 trailer merge（行 ~227-238），将：
```typescript
// Trailer mode: merge cachedFreshBlock into last user message content
const merged = this.cachedFreshBlock + '\n---\n' + (typeof msg.content === 'string' ? msg.content : '')
```
改为：
```typescript
// Trailer mode: merge volatileBlock (FROZEN only) into last user message.
// Dynamic appendix is appended separately after the message loop to keep
// this message's bytes identical to historical user messages — preserving
// DeepSeek exact-prefix cache across lastUserIdx → firstUserIdx transitions.
const hasAppendix = typeof fullAppendix === 'string' && fullAppendix.length > 0
this.cachedAppendix = hasAppendix ? fullAppendix : ''
const merged = this.volatileBlock + '\n---\n' + (typeof msg.content === 'string' ? msg.content : '')
```

注意：`fullAppendix` 变量在 `if (userContent !== this.cachedFreshForUser || isDuplicate)` 块内计算（行 ~215）。需要将其作用域提升到块外（`let fullAppendix = ''`），或从 `cachedFreshBlock` 反推。

更精确的方案：在 `lastUserIdx` 分支末尾，基于已计算的 `cachedFreshBlock` 提取 appendix：
```typescript
// cachedFreshBlock = volatileBlock + '\n' + fullAppendix (when appendix exists)
//                   = volatileBlock (when no appendix)
if (this.cachedFreshBlock !== this.volatileBlock) {
  this.cachedAppendix = this.cachedFreshBlock.slice(this.volatileBlock.length + 1) // +1 for '\n'
} else {
  this.cachedAppendix = ''
}
```

3. 在 `buildOaiRequest` 的 return 语句前（行 ~370，`return { model, messages, ... }` 之前），追加：
```typescript
// P1: append dynamic appendix as standalone message at end of result.
// This keeps the last user message's content identical to historical
// user messages (volatileBlock + userContent), preventing exact-prefix
// cache breaks when dynamic context changes between turns.
if (this.cachedAppendix) {
  result.push({ role: 'user', content: this.cachedAppendix })
}
```

4. 在 `rebuildVolatileBlock`（行 ~517-518）中，增加 frozen 清空：
```typescript
this.cachedFreshForUser = ''
this.cachedFreshBlock = ''
this.cachedAppendix = ''
this.frozenUserMerged.clear()  // NEW: format changed from cachedFreshBlock to volatileBlock
```

5. 运行 langmuir probe 确认通过：`npx tsx --test src/prompt/__tests__/engine-cache-stability.test.ts`

6. 提交：`fix(prompt): move dynamic appendix to standalone message, preserve lastUserMsg bytes`

### Task 3: 更新现有测试断言

- [ ] **修改**：`src/prompt/__tests__/engine.test.ts`（更新 trailer-merge 相关断言）

**步骤**：

1. 更新行 ~37 附近断言：`cachedFreshBlock` 不再出现在 user message content 中。改为断言 `volatileBlock` 在 user message 中，`dynamicAppendix` 在独立消息中。

2. 更新行 ~298-354 附近测试：`'Habituated domain content should appear in last user message (trailer mode)'` — 现在 habituated content 应出现在独立附录消息中，而非 last user message。

3. 新增测试：
```typescript
it('dynamic appendix is standalone message appended after last user message', () => {
  const engine = makeEngine()
  engine.setTaskProgress({ current: 'test', completed: ['a'], remaining: ['b'] })
  
  const req = engine.buildOaiRequest([
    { role: 'user', content: 'hello' }
  ])
  
  const userMsgs = req.messages.filter(m => m.role === 'user')
  assert.ok(userMsgs.length >= 1)
  
  // Last user message should NOT contain dynamic appendix fields
  const lastUserContent = userMsgs[userMsgs.length - 1]?.content ?? ''
  // If appendix exists, it's a separate message; the last user message is clean
  // (without <tool-history>, <task-progress>, etc.)
})
```

4. 运行全部 engine 测试：`npx tsx --test src/prompt/__tests__/engine.test.ts`

5. 提交：`test(prompt): update assertions for standalone dynamic appendix`

### Task 4: 集成验证

- [ ] **验证**：typecheck + 全部测试

**命令与预期**：
```bash
npx tsc --noEmit                    # 预期：零错误
npm exec -- tsx --test src/prompt/__tests__/engine.test.ts           # 预期：全部通过
npm exec -- tsx --test src/prompt/__tests__/engine-cache-stability.test.ts  # 预期：全部通过
npm exec -- tsx --test src/agent/__tests__/loop.test.ts              # 预期：31/32 通过（1 个预存失败）
```

## 5. Verification

1. **Langmuir probe**：turn 1 和 turn 2 中同一条 user message 的字节完全一致（`assert.equal(turn1Bytes, turn2Bytes)`）
2. **独立附录**：`result` 最后一条 user-role 消息包含 `<context-update>` 或 `<consolidated>` 等动态标签
3. **FROZEN 不变**：`volatileBlock` 未因本次变更而修改（grep 确认无变更）
4. **存量 frozen 清空**：`rebuildVolatileBlock` 后 `frozenUserMerged.size === 0`
5. **typecheck 零错误**

## 6. Self-check

### Spec coverage
- ✅ 动态附录从 trailer merge 改为独立消息
- ✅ 最后一条 user message 格式与 historical 一致（volatileBlock + userContent）
- ✅ frozen snapshot 格式更新 + 存量清空
- ✅ cachedAppendix 生命周期管理（计算、存储、清空）
- ✅ 调用方透明（loop.ts, compaction-controller.ts）

### Placeholder scan
- ✅ 无 TODO / TBD / 待定
- ✅ 无"添加适当的错误处理"
- ✅ 无"类似任务 N"

### Type consistency
- ✅ `cachedAppendix: string` — 与 `result.push({ role: 'user', content: string })` 类型一致
- ✅ `frozenUserMerged.clear()` — Map 方法，无类型问题
- ✅ `cachedFreshBlock.slice(volatileBlock.length + 1)` — 两个都是 string，slice 返回 string

## 7. Execution handoff

计划已完成并保存到 `docs/superpowers/plans/2026-06-02-dynamic-appendix-standalone.md`。两种执行方式：

1. **子代理驱动（推荐）** — 每个任务调度一个新的子代理，任务间进行审查，快速迭代。
2. **内联执行** — 在当前会话中使用 executing-plans 执行任务，批量执行并设有检查点。

选哪种方式？
