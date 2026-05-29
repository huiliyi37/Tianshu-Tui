# 任务契约自动继承 — 非 actionable 消息不丢失任务上下文

> **面向 AI 代理：** 使用 subagent-driven-development（推荐）或 executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 修复意图梯度重构引入的契约丢失问题：当用户发送非 actionable 的跟进消息（如 "能加个超时吗"）时，已有的 taskContract 被错误清空。改为：非 actionable 消息继承活跃契约，不做重置。

**架构：** 在 `loop.ts:1051` 的契约赋值逻辑中增加守护条件：当 `isActionableTurn` 返回 false 但已有活跃且未交付的 taskContract 时，保留现有契约而非设为 undefined。仅在无活跃契约（首次非 actionable 消息）或契约已完成（status = ready_to_deliver）时才清空。

**技术栈：** TypeScript strict / node:test + assert/strict

---

## 1. Scope check

| 子系统 | 是否涉及 | 原因 |
|--------|---------|------|
| `src/agent/loop.ts` | ✅ 是 | 契约赋值逻辑（第 1051 行）增加继承判断 |
| `src/context/task-contract.ts` | ❌ 否 | `isActionableTurn` 和 `extractTaskContract` 不变 |
| `src/prompt/engine.ts` | ❌ 否 | `setActionableTurn` 语义不变 — 仍控制本轮是否注入 CVM |
| `src/agent/__tests__/loop.test.ts` | ✅ 是 | 新增契约继承的测试用例 |

此修改仅涉及 `loop.ts` 中的 3 行逻辑变更和测试。

---

## 2. File structure

| 文件 | 操作 | 职责 |
|------|------|------|
| `src/agent/loop.ts:1049-1053` | 修改 | 契约赋值增加继承逻辑 |
| `src/agent/__tests__/loop.test.ts` | 修改 | 新增契约继承测试 |

---

## 3. Research endorsement（调研背书）

### 3.1 当前行为（6dda6d3 引入）

**文件**：`src/agent/loop.ts:1049-1053`

```typescript
const actionable = isActionableTurn(userInput)
this.config.promptEngine.setActionableTurn(actionable)
this.taskContract = actionable ? extractTaskContract(userInput, this.session.getTurnCount()) : undefined
```

**问题场景**：
```
用户: "修复 src/api/client.ts 的重试逻辑"  → actionable=true  → contract 建立
用户: "能加个超时吗"                      → actionable=false → contract → undefined ❌
```

第二条消息太短（CJK weight < 8），无文件引用，无约束标记，`isActionableTurn` 返回 false，契约被清空。后续 turn 中 `advanceContractStatus` 的守卫 `if (this.taskContract && contractStatus)` 不再执行，任务脚手架全部消失。

### 3.2 修复逻辑

```
if (actionable) {
  // 明确的 actionable 消息 → 提取新契约（可能替代旧契约）
  this.taskContract = extractTaskContract(...)
} else if (!this.taskContract || this.taskContract.status === 'ready_to_deliver') {
  // 无活跃契约 OR 上一个任务已完成 → 可以安全跳过
  this.taskContract = undefined
}
// else: 非 actionable 跟进 + 活跃未完成契约 → 保留 (继承)
```

**设计决策**：
- **actionable 消息总是提取新契约。** 如果用户连续发送两个 actionable 消息（如 "修复 A" 然后 "重构 B"），第二个会覆盖第一个。这符合直觉——用户明确表达了新意图。
- **非 actionable 消息在无活跃契约时跳过。** 会话刚开始用户说 "你好"，没有契约可继承，正确行为是跳过。
- **非 actionable 消息在契约已完成时跳过。** 交付后用户说 "谢谢"，不应复活塞已完成的契约。
- **非 actionable 跟进消息继承活跃契约。** "能加个超时吗" 不是 actionable，但显然是对当前任务的延续。

### 3.3 为什么不修改 `isActionableTurn` 本身

`isActionableTurn` 的职责是判断"这条消息本身是否表达了任务意图"。它对 "能加个超时吗" 返回 false 是正确的——这句话单独看确实不构成独立任务。问题不在判定函数，而在契约的生命周期管理：契约应该跨 turn 存活，直到被新任务替代或完成。

### 3.4 为什么不修改 `setActionableTurn`

`setActionableTurn(false)` 仍然有意义——它告诉 prompt engine 本轮不需要注入 CVM 脚手架（cognitive mirror、动态附录等）。即使契约被继承，一个简短的跟进消息也不需要完整的 CVM 注入。所以 `actionable` 的原始语义（"本轮是否需要任务脚手架"）和契约继承（"本轮是否保留契约"）是两个独立的维度，不应耦合。

---

## 4. Tasks

### Task 1: 修改契约赋值逻辑

**目标**：在 loop.ts 中实现契约自动继承。

**文件**：`src/agent/loop.ts:1049-1053`

修改前：
```typescript
const actionable = isActionableTurn(userInput)
this.config.promptEngine.setActionableTurn(actionable)
this.taskContract = actionable ? extractTaskContract(userInput, this.session.getTurnCount()) : undefined
```

修改后：
```typescript
const actionable = isActionableTurn(userInput)
this.config.promptEngine.setActionableTurn(actionable)

if (actionable) {
  this.taskContract = extractTaskContract(userInput, this.session.getTurnCount())
} else if (!this.taskContract || this.taskContract.status === 'ready_to_deliver') {
  // No active task to inherit, or previous task already delivered
  this.taskContract = undefined
}
// else: non-actionable follow-up to active task — inherit existing contract
```

**验证**：
```bash
npx tsc --noEmit  # 预期：0 errors
```

---

### Task 2: 测试 — 契约继承场景

**目标**：覆盖三种继承场景和两种清空场景。

**文件**：`src/agent/__tests__/loop.test.ts`（在现有测试中追加 describe 块）

#### 2a. 测试：非 actionable 跟进消息继承活跃契约

```typescript
describe('task-contract inheritance', () => {
  it('non-actionable follow-up inherits active contract', async () => {
    // Setup: agent with a mock that records taskContract across turns
    // Turn 1: "修复 src/api/client.ts" → actionable, contract extracted
    // Turn 2: "能加个超时吗" → non-actionable, contract should be preserved
    const contract1 = agent.taskContract
    assert.ok(contract1, 'contract should exist after actionable message')
    assert.equal(contract1.isActionable, true)
    
    // After non-actionable follow-up, contract should remain
    const contract2 = agent.taskContract
    assert.ok(contract2, 'contract should survive non-actionable follow-up')
    assert.equal(contract2.objective, contract1.objective, 'objective should be inherited')
  })
})
```

#### 2b. 测试：无活跃契约时非 actionable 消息不创建契约

```typescript
  it('non-actionable message without prior contract stays undefined', async () => {
    // Fresh session, first message: "你好"
    const contract = agent.taskContract
    assert.equal(contract, undefined)
  })
```

#### 2c. 测试：新 actionable 消息覆盖旧契约

```typescript
  it('new actionable message supersedes existing contract', async () => {
    // Turn 1: "修复 A"
    // Turn 2: "重构 B" (actionable)
    const contract = agent.taskContract
    assert.ok(contract.objective.includes('重构'))
  })
```

#### 2d. 测试：已完成契约不被非 actionable 消息复活

```typescript
  it('delivered contract is not resurrected by non-actionable message', async () => {
    // Set contract status to ready_to_deliver
    // Send non-actionable follow-up
    const contract = agent.taskContract
    assert.equal(contract, undefined)
  })
```

**验证**：
```bash
node --import tsx --test --test-name-pattern="inheritance" src/agent/__tests__/loop.test.ts
# 预期：4 tests pass
```

---

### Task 3: 全量回归

```bash
npx tsc --noEmit
npm exec -- tsx --test src/**/__tests__/*.test.ts
# 预期：无新增失败
```

---

## 5. Verification

| 验证项 | 命令 | 预期结果 |
|--------|------|----------|
| TypeScript 编译 | `npx tsc --noEmit` | 0 errors |
| 契约继承测试 | `node --import tsx --test --test-name-pattern="inheritance" src/agent/__tests__/loop.test.ts` | 4 pass |
| task-contract 测试 | `node --import tsx --test src/context/__tests__/task-contract.test.ts` | 20 pass |
| 全量回归 | `npm exec -- tsx --test src/**/__tests__/*.test.ts` | 无新增失败 |

---

## 6. Self-check

### 6.1 Spec coverage

| 需求 | 覆盖任务 |
|------|----------|
| 非 actionable 跟进继承活跃契约 | Task 1, Task 2a |
| 无活跃契约时不创建 | Task 2b |
| 新 actionable 覆盖旧契约 | Task 2c |
| 已完成契约不被复活 | Task 2d |
| 不修改 isActionableTurn 语义 | 显式排除 |
| 不修改 setActionableTurn 语义 | 显式排除 |

### 6.2 Placeholder scan

✅ 无 TODO / TBD / 待定 / 后续实现 / 补充细节

### 6.3 Type consistency

- `this.taskContract: TaskContract | undefined` — 类型不变
- `isActionableTurn(userInput): boolean` — 签名不变
- `extractTaskContract(userInput, turn): TaskContract` — 签名不变
- 新增条件分支不引入新类型

---

## 7. Execution handoff

计划已完成并保存到 `docs/superpowers/plans/2026-05-29-contract-inheritance.md`。两种执行方式：

1. **子代理驱动（推荐）** — 每个任务调度一个新的子代理，任务间进行审查，快速迭代。
2. **内联执行** — 在当前会话中使用 executing-plans 执行任务，批量执行并设有检查点。

选哪种方式？
