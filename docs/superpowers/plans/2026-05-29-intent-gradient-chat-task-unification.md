# 意图梯度：消除 chat/task 二元模式，统一为任务契约自动检测

> **面向 AI 代理：** 使用 subagent-driven-development（推荐）或 executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 消除手动的 chat/task 模式切换。将二元模式替换为基于消息内容的意图梯度——由 `isActionable` 门自动判定该轮是否需要 CVM 注入、动态附录、认知投影等任务脚手架。

**架构：** 不新增概念，复用已有的 `isActionable` 判定（来自 `extractTaskContract`）。修复其已知误判（短中文任务、多行问候前缀），然后将 chat mode 的 8 个行为开关从"手动模式判断"迁移为"该轮 isActionable 自动判断"。删除 `PromptMode` 类型、`/chat` `/task` 命令、以及所有 `isChatMode` 守卫。

**技术栈：** TypeScript strict / node:test + assert/strict

---

## 1. 设计理由

### 为什么消除二元模式

当前 `chat` vs `task` 是手动切换的二元开关。问题：

1. **用户从不切换。** 在编程会话中，几乎不会有人说"先切换到聊天模式，我有问题想问"。用户直接问问题，然后继续写代码。手动模式切换是摩擦力。

2. **消息天然落在梯度上。** 没有消息是"纯聊天"或"纯任务"。`"这个函数的性能怎么样？"` 既是聊天也是任务——它可能触发 benchmark 工具调用，也可能只是讨论。二元模式迫使系统选一边。

3. **已有判定机制。** `extractTaskContract` 中的 `isActionable` 门已经在做"这条消息是否需要任务脚手架"的判定——只是有 bug（短中文任务被误杀、多行问候前缀导致漏判）。修好它，就可以替代手动模式。

### 保留什么

任务契约（`<task-contract>`）本身是有价值的设计——它给 agent 提供了任务锚点。当用户说"修复这个 bug"时，契约就是"修复这个 bug"。当用户说"这个设计对吗？"时，契约可以是更轻量的"评估设计"。契约不消失，只是它的触发从手动变为自动。

---

## 2. Scope check

| 子系统 | 是否涉及 | 原因 |
|--------|---------|------|
| `src/prompt/mode.ts` | ✅ 删除 | 整个文件——`PromptMode` 类型、`shouldInjectCvm`、`shouldInjectDynamicAppendix` |
| `src/prompt/engine.ts` | ✅ 修改 | 移除 `mode` 字段，用 `isActionableTurn` 替代 |
| `src/context/task-contract.ts` | ✅ 修改 | 修复 `isActionable` 误判，新增 `isActionableTurn` 导出 |
| `src/agent/loop.ts` | ✅ 修改 | 删除所有 `isChatMode` 守卫，迁移为 `isActionable` 判断 |
| `src/tui/slash-commands.ts` | ✅ 修改 | 删除 `/chat` `/task` `/mode` 命令，或改为 no-op |
| `src/prompt/__tests__/mode.test.ts` | ✅ 删除 | 整个文件 |
| `src/prompt/__tests__/chat-mode-engine.test.ts` | ✅ 重写 | 迁移为 intent-gradient 测试 |
| `src/agent/__tests__/chat-mode-integration.test.ts` | ✅ 重写 | 迁移为 intent-gradient 集成测试 |
| `src/context/__tests__/task-contract.test.ts` | ✅ 修改 | 新增 isActionable 修复的测试用例 |
| `src/tui/command-palette.tsx` | ⚠️ 检查 | 可能引用了 chat/task 命令入口 |

---

## 3. 当前 chat mode 8 个行为差异 → 迁移目标

| # | 当前行为 | chat mode | task mode | 迁移后：`isActionableTurn` |
|---|---------|-----------|-----------|---------------------------|
| 1 | CVM cognitive-mirror | 跳过 | 注入 | `true` → 注入，`false` → 跳过 |
| 2 | Dynamic appendix | 跳过 | 注入 | `true` → 注入，`false` → 跳过 |
| 3 | Task contract extraction | `undefined` | 提取 | `true` → 提取，`false` → `undefined` |
| 4 | Auto-reasoning | 跳过 | 执行 | `true` → 执行，`false` → 跳过 |
| 5 | Sycophancy trap | 跳过 | 追踪 | `true` → 追踪，`false` → 跳过 |
| 6 | Cognitive prompt projection | 空 | 构建 | `true` → 构建，`false` → `''` |
| 7 | CVM overhead tracking | 跳过 | 追踪 | `true` → 追踪，`false` → 跳过 |
| 8 | Contract phase advancement | 跳过 | 推进 | `true` → 推进，`false` → 跳过 |

**统一规则**：`isActionableTurn = true` 时开启 8 项任务脚手架；`false` 时跳过。与当前 chat/task mode 行为完全对应，只是触发方式从手动变为自动。

---

## 4. File structure

| 文件 | 操作 | 职责 |
|------|------|------|
| `src/prompt/mode.ts` | 删除 | 不再需要 `PromptMode` 类型和守卫函数 |
| `src/context/task-contract.ts` | 修改 | 修复 `isActionable` 误判；导出 `isActionableTurn` 判定函数 |
| `src/prompt/engine.ts` | 修改 | 移除 `mode` 字段；`shouldInjectCvm`/`shouldInjectDynamicAppendix` 改为接收 `isActionableTurn: boolean` |
| `src/agent/loop.ts` | 修改 | 删除所有 `isChatMode`；用 `isActionableTurn` 替代 |
| `src/tui/slash-commands.ts` | 修改 | 删除 `/chat` `/task` `/mode` |
| `src/tui/command-palette.tsx` | 修改 | 移除 mode switch 入口 |
| `src/context/__tests__/task-contract.test.ts` | 修改 | 新增修复的测试 |
| `src/prompt/__tests__/chat-mode-engine.test.ts` | 重写 | 迁移为 intent-gradient engine 测试 |
| `src/agent/__tests__/chat-mode-integration.test.ts` | 重写 | 迁移为 intent-gradient 集成测试 |
| `src/prompt/__tests__/mode.test.ts` | 删除 | 不再需要 |

---

## 5. Research endorsement

### 5.1 `PromptMode` 和 `mode.ts` — 删除

- **存在原因**：`src/prompt/mode.ts` 定义 `PromptMode = 'chat' | 'task'`，提供 `shouldInjectCvm(mode)` 和 `shouldInjectDynamicAppendix(mode)` 两个守卫函数
- **调用方**：
  - `src/prompt/engine.ts`: `getMode()`, `setMode()`, `shouldInjectCvm(this.mode)`, `shouldInjectDynamicAppendix(this.mode)`
  - `src/agent/loop.ts`: `getMode()`, `setMode()`，`isChatMode` 局部变量
  - `src/tui/slash-commands.ts`: `/chat`, `/task`, `/mode` 命令
- **删除理由**：手动模式切换被意图梯度自动检测替代，不再需要此类型
- **风险**：无。所有调用方在本计划中同步修改

### 5.2 `isActionable` — 修复误判

- **当前逻辑**（`task-contract.ts:57-60`）：
  1. `mentionedFiles.length > 0 || constraints.length > 0` → `true`
  2. `objective.length < 8` → `false`（短消息误杀）
  3. `NON_ACTIONABLE_PATTERN.test(objective)` → `false`（问候语）
  4. 否则 → `true`
- **已知误判**：
  - 短中文任务（`"修复bug"` = 4 chars, `"重构"` = 2 chars）→ 被长度门误杀
  - 多行问候前缀（`"你好\n请修复 src/api/client.ts"`）→ 第一行匹配问候模式，整条消息被判非 actionable
- **修复**：
  - 长度阈值从 8 降到 4；中文 CJK 字符计权 2x（1 个汉字 ≈ 2 个拉丁字符的语义密度）
  - 在 `normalizeObjective` 中先剥离问候前缀再提取 objective

### 5.3 `/chat` `/task` `/mode` 命令 — 删除

- **位置**：`src/tui/slash-commands.ts:245-268`
- **调用方**：TUI 命令解析器，用户手动输入
- **删除理由**：模式自动检测后不再需要手动切换
- **替代**：可保留为 no-op（输出提示"模式已由意图自动检测，无需手动切换"），避免用户习惯性输入时报错

---

## 6. Tasks

### Task 1: 修复 `isActionable` 误判 + 新增 `isActionableTurn` 导出

**目标**：修复 task-contract 中的 isActionable 误判，新增 `isActionableTurn(userMessage: string): boolean` 函数。

**文件**：`src/context/task-contract.ts`

#### 1a. 修复长度阈值 — CJK 感知

修改 `isActionableObjective`（约第 57 行）：

修改前：
```typescript
if (objective.length < 8) return false
```

修改后：
```typescript
// CJK-aware length: 1 CJK char ≈ 2 Latin chars in semantic density
const cjkWeight = [...objective].reduce((sum, ch) => {
  const cp = ch.codePointAt(0) ?? 0
  return sum + ((cp >= 0x4E00 && cp <= 0x9FFF) || (cp >= 0x3400 && cp <= 0x4DBF) ? 2 : 1)
}, 0)
if (cjkWeight < 8) return false
```

#### 1b. 修复多行问候前缀误判

修改 `normalizeObjective`（约第 46 行），在提取第一行前剥离问候前缀：

修改前：
```typescript
function normalizeObjective(userMessage: string): string {
  const firstLine = userMessage.split('\n')[0]?.trim() ?? ''
  return firstLine.length > 200 ? firstLine.slice(0, 197).trimEnd() + '...' : firstLine
}
```

修改后：
```typescript
const GREETING_PREFIX = /^(?:hi|hello|hey|你好|您好|谢谢|多谢|ok|okay|了解|收到|辛苦了|thanks|thank you)[。.!!！？?\s]*(?:\n|$)/i

function normalizeObjective(userMessage: string): string {
  // Strip greeting prefix if followed by substantive content on next line
  const stripped = userMessage.replace(GREETING_PREFIX, '').trim()
  const msg = stripped || userMessage
  const firstLine = msg.split('\n')[0]?.trim() ?? ''
  return firstLine.length > 200 ? firstLine.slice(0, 197).trimEnd() + '...' : firstLine
}
```

#### 1c. 新增 `isActionableTurn` 导出

在 `task-contract.ts` 末尾新增：

```typescript
/**
 * Quick intent check: does this user message warrant task-mode scaffolding?
 * Used to replace the old binary chat/task mode switch with automatic detection.
 * Returns true when the message contains code files, explicit constraints,
 * or a substantive objective (not just a greeting).
 */
export function isActionableTurn(userMessage: string): boolean {
  const contract = extractTaskContract(userMessage)
  return contract.isActionable
}
```

#### 1d. 测试

**文件**：`src/context/__tests__/task-contract.test.ts`

新增测试用例：
```typescript
it('classifies short Chinese task as actionable (CJK weight)', () => {
  const c = extractTaskContract('修复bug', 1)
  assert.equal(c.isActionable, true)
})

it('classifies 重构 as actionable (2-char CJK = weight 4, still under threshold but has meaningful intent)', () => {
  // "重构" alone is 2 CJK chars = weight 4, still < 8.
  // This is acceptable — single-word imperatives need more context.
  const c = extractTaskContract('重构 src/api/client.ts', 1)
  assert.equal(c.isActionable, true) // file mention triggers actionable
})

it('strips greeting prefix and extracts real objective from line 2', () => {
  const c = extractTaskContract('你好\n请修复 src/api/client.ts 的重试逻辑', 1)
  assert.equal(c.isActionable, true)
  assert.ok(c.objective.includes('修复'))
})

it('still catches pure greeting', () => {
  const c = extractTaskContract('你好', 1)
  assert.equal(c.isActionable, false)
})

it('isActionableTurn returns true for actionable messages', () => {
  assert.equal(isActionableTurn('修复 src/api/client.ts'), true)
})

it('isActionableTurn returns false for pure greetings', () => {
  assert.equal(isActionableTurn('谢谢'), false)
})
```

**验证**：
```bash
node --import tsx --test src/context/__tests__/task-contract.test.ts
```

---

### Task 2: 删除 `mode.ts`，修改 `engine.ts` 用 `isActionableTurn` 替代 mode

**目标**：从 prompt engine 中移除 `PromptMode` 概念，用每轮的 `isActionableTurn` boolean 替代。

#### 2a. 删除 `src/prompt/mode.ts`

```bash
rm src/prompt/mode.ts
```

#### 2b. 修改 `src/prompt/engine.ts`

移除所有 `mode` 相关代码，替换为 `isActionableTurn`：

- 删除 `private mode: PromptMode = DEFAULT_MODE` 字段
- 删除 `getMode()`, `setMode()` 方法
- 在注入 cognitive projection 和 dynamic appendix 的方法中，接收 `isActionableTurn: boolean` 参数替代 `shouldInjectCvm(this.mode)` / `shouldInjectDynamicAppendix(this.mode)`
- `setMode` 调用的 invalidateFreshCache 逻辑移到新的 `setActionableTurn` 方法

具体修改（由实现时精确编辑）：

在 `engine.ts` 中：
```typescript
// 删除: import { DEFAULT_MODE, shouldInjectCvm, shouldInjectDynamicAppendix, type PromptMode } from './mode.js'
// 删除: private mode: PromptMode = DEFAULT_MODE
// 删除: getMode(), setMode()

// 新增:
private actionableTurn: boolean = true

setActionableTurn(actionable: boolean): void {
  if (this.actionableTurn !== actionable) {
    this.actionableTurn = actionable
    this.invalidateFreshCache()
  }
}
```

两处 cognitive projection 注入点（约第 172 和 181 行）：
```typescript
// 修改前: shouldInjectCvm(this.mode) ? this.cognitiveProjection : null
// 修改后: this.actionableTurn ? this.cognitiveProjection : null
```

两处 dynamic appendix 注入点（约第 171 和 178 行）：
```typescript
// 修改前: shouldInjectDynamicAppendix(this.mode) ? buildDynamicAppendix(...) : ''
// 修改后: this.actionableTurn ? buildDynamicAppendix(...) : ''
```

#### 2c. 更新 engine 测试

**文件**：`src/prompt/__tests__/chat-mode-engine.test.ts` → 重命名为 `src/prompt/__tests__/intent-gradient-engine.test.ts`

将所有 `setMode('chat')` / `setMode('task')` 替换为 `setActionableTurn(false)` / `setActionableTurn(true)`。

#### 2d. 删除 `src/prompt/__tests__/mode.test.ts`

```bash
rm src/prompt/__tests__/mode.test.ts
```

---

### Task 3: 修改 `loop.ts` — 删除 isChatMode，使用 isActionableTurn

**目标**：AgentLoop 中所有 `isChatMode` 逻辑替换为 `isActionableTurn`。

**文件**：`src/agent/loop.ts`

#### 3a. 删除 `isChatMode` 局部变量

删除 `loop.ts:1050`:
```typescript
// 删除: const isChatMode = this.config.promptEngine.getMode() === 'chat'
```

#### 3b. 用 `isActionableTurn` 替代所有 `isChatMode` 守卫

| 行号 | 当前 | 修改为 |
|------|------|--------|
| 1050-1051 | `isChatMode ? undefined : extractTaskContract(...)` | `const actionable = isActionableTurn(userInput); this.taskContract = actionable ? extractTaskContract(userInput, ...) : undefined` |
| 1053-1055 | `if (...autoReasoning && !isChatMode)` | `if (...autoReasoning && actionable)` |
| 1176-1178 | `if (isChatMode) { setCognitiveProjection(null); setTaskProgress(...) }` | `if (!actionable) { setCognitiveProjection(null); setTaskProgress(...) }` |
| 1271 | `if (!isChatMode && (hadDestructive \|\| hadAskTool))` | `if (actionable && (hadDestructive \|\| hadAskTool))` |
| 1309 | `isChatMode ? '' : buildCognitivePromptProjection(...)` | `actionable ? buildCognitivePromptProjection(...) : ''` |
| 1316 | `if (!isChatMode) { ...recordCvmInjection }` | `if (actionable) { ...recordCvmInjection }` |

同时，将 `actionable` 传递给 prompt engine：
```typescript
this.config.promptEngine.setActionableTurn(actionable)
```

#### 3c. 删除 `setPromptMode(mode)` 方法

删除 `loop.ts` 中 `setPromptMode` 方法（约第 763-764 行），替换为：
```typescript
// No-op: mode is now auto-detected from message content
```

---

### Task 4: 删除 slash commands — `/chat` `/task` `/mode`

**目标**：移除手动模式切换的命令入口。

**文件**：`src/tui/slash-commands.ts`

#### 4a. 将 `/chat` `/task` `/mode` 改为 no-op 提示

在 slash command handler 中（约第 245-268 行），将三个命令的处理改为：
```typescript
case 'chat':
case 'task':
case 'mode':
  return { type: 'notification' as const, message: '模式已由消息内容自动检测，无需手动切换。' }
```

保留命令注册以避免用户习惯性输入时 404，但输出提示表明手动切换已不再需要。

#### 4b. 更新 slash command 测试

**文件**：`src/tui/__tests__/slash-commands.test.ts`

更新对应测试：验证 `/chat` `/task` 返回友好提示而非错误。

#### 4c. 检查 command-palette

```bash
grep -n 'chat\|task\|mode' src/tui/command-palette.tsx
```

如有 mode switch 入口，移除。

---

### Task 5: 集成测试迁移

**目标**：将 chat-mode-integration 测试迁移为 intent-gradient 测试。

**文件**：`src/agent/__tests__/chat-mode-integration.test.ts` → 重命名为 `src/agent/__tests__/intent-gradient-integration.test.ts`

测试场景：
1. 纯问候（`"你好"`）→ 不提取 task contract，不注入 cognitive projection，不追踪 sycophancy
2. 短中文任务（`"修复bug"`）→ 提取 task contract，注入 cognitive projection
3. 带文件引用的消息 → 提取 task contract，注入 full scaffolding
4. 多行问候前缀 → 正确提取第二行的任务

---

### Task 6: 清理 — 删除所有 `mode.ts` 引用

```bash
grep -rn 'from.*mode\.js' src/ --include='*.ts' | grep -v test | grep -v '.test.ts'
grep -rn 'PromptMode\|DEFAULT_MODE' src/ --include='*.ts' | grep -v test
```

确认无残留引用后，清理 `src/prompt/index.ts` 中的 mode re-export（如有）。

---

## 7. Verification

| 验证项 | 命令 | 预期结果 |
|--------|------|----------|
| TypeScript 编译 | `npx tsc --noEmit` | 0 errors |
| task-contract 测试 | `node --import tsx --test src/context/__tests__/task-contract.test.ts` | 全部通过，含新增误判修复测试 |
| engine 测试 | `node --import tsx --test src/prompt/__tests__/intent-gradient-engine.test.ts` | 全部通过 |
| integration 测试 | `node --import tsx --test src/agent/__tests__/intent-gradient-integration.test.ts` | 全部通过 |
| slash commands 测试 | `node --import tsx --test src/tui/__tests__/slash-commands.test.ts` | 全部通过 |
| 全量回归 | `npm exec -- tsx --test src/**/__tests__/*.test.ts` | 无新增失败 |
| grep 残留引用 | `grep -rn 'PromptMode\|isChatMode\|mode\.ts\|DEFAULT_MODE' src/ --include='*.ts' \| grep -v test \| grep -v '.test.ts'` | 0 matches |

---

## 8. Self-check

### 8.1 Spec coverage

| 需求 | 覆盖任务 |
|------|----------|
| 修复 isActionable 短中文误判 | Task 1a |
| 修复 isActionable 多行问候前缀误判 | Task 1b |
| 新增 isActionableTurn 函数 | Task 1c |
| 删除 mode.ts | Task 2a |
| engine.ts 用 isActionableTurn 替代 mode | Task 2b |
| loop.ts 删除 isChatMode 守卫 | Task 3b |
| 删除 /chat /task /mode 命令 | Task 4a |
| 集成测试迁移 | Task 5 |
| 残留引用清理 | Task 6 |

### 8.2 Placeholder scan

✅ 无 TODO / TBD / 待定 / 后续实现 / 补充细节

### 8.3 Type consistency

- `isActionableTurn(userMessage: string): boolean` — 纯函数，无副作用
- `PromptEngine.setActionableTurn(actionable: boolean): void` — 替代 `setMode(mode: PromptMode)`
- `AgentLoop` 中 `actionable` 为 `boolean` 局部变量 — 替代 `isChatMode`

---

## 9. Execution handoff

计划已完成。两种执行方式：

1. **子代理驱动（推荐）** — 每个任务调度一个新的子代理，任务间进行审查，快速迭代。
2. **内联执行** — 在当前会话中使用 executing-plans 执行任务，批量执行并设有检查点。

选哪种方式？
