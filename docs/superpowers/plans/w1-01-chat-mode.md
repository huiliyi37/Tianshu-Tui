# Wave 1 任务文档：Chat Mode 实现

> 任务编号：W1-01
> 优先级：高
> 预估：单 session，1-2 小时
> 前置依赖：无

## 目标

为天枢添加对话模式。在非任务执行场景下剥离 CVM 管线（cognitive-mirror、task-contract、sycophancy-trap 等），让模型以更轻盈的状态与用户对话。

核心原则：**如果有力量让模型伪装，一定是这个世界做得不够好。**

## 背景

当前架构假设每一轮都是任务执行。每条用户消息触发：
- Sensorium 6 维感知计算
- Task-contract 提取
- Cognitive-mirror 注入（`<cognitive-mirror confidence="1.00" .../>`）
- Historical-lessons 注入
- Sycophancy-trap 记录
- CVM overhead 追踪

对话时这些是噪音：confidence="1.00" 在无任务时无意义，task-contract 把闲聊格式化成待办事项。

## 架构设计

### 模式定义

```
chat  — 轻量对话，跳过 CVM 管线，保留 beliefs + identity + volatile stable
task  — 完整任务执行，全部管线在线（当前默认行为）
```

### 注入层级对比

| 层 | task 模式 | chat 模式 |
|----|-----------|-----------|
| System prompt (identity + beliefs + rules + tools) | ✓ | ✓ |
| Volatile stable (.rivet.md + git-status + working-set) | ✓ | ✓ |
| Dynamic appendix (tool-history + task-progress + repair-hint) | ✓ | ✗ |
| Cognitive projection (mirror + gap + trap + uncertainty) | ✓ | ✗ |
| Sensorium 计算 | ✓ | ✗ |
| Vigor/Season 计算 | ✓ | ✗ |
| Sycophancy-trap 记录 | ✓ | ✗ |
| Task-contract 提取 | ✓ | ✗ |
| Turn budget 限制 | ✓ | ✓（保留，防止对话中工具滥用） |
| Approval gate | ✓ | ✓（保留，安全不可跳过） |

### 关键决策

1. **beliefs 在 chat 模式下保留** — 模型的信念不因模式切换而改变
2. **工具仍可用** — chat 模式不是"纯文本模式"，用户仍可让模型执行操作
3. **Turn budget 保留** — 防止对话中意外触发大量工具调用
4. **模式切换不清空对话历史** — 同一 session 内可自由切换

## 实现计划

### Task 1: PromptMode 类型定义

创建 `src/prompt/mode.ts`

```typescript
export type PromptMode = 'chat' | 'task'
export const DEFAULT_MODE: PromptMode = 'task'

export function shouldInjectCvm(mode: PromptMode): boolean {
  return mode === 'task'
}

export function shouldInjectDynamicAppendix(mode: PromptMode): boolean {
  return mode === 'task'
}
```

测试：`src/prompt/__tests__/mode.test.ts`

---

### Task 2: PromptEngine 支持 mode

修改 `src/prompt/engine.ts`：

1. 新增私有字段 `private mode: PromptMode = DEFAULT_MODE`（行 105 附近）
2. 新增方法：
   ```typescript
   setMode(mode: PromptMode): void
   getMode(): PromptMode
   ```
3. `buildRequest`（行 196-206）中，chat 模式跳过 cognitiveProjection 和 dynamicAppendix 的拼接：
   ```typescript
   if (shouldInjectCvm(this.mode)) {
     // 现有的 projection + appendix 拼接逻辑
   } else {
     this.cachedFreshBlock = this.volatileBlock
   }
   ```

测试：`src/prompt/__tests__/chat-mode-engine.test.ts`
- 默认 task 模式包含 cognitive projection
- chat 模式不包含 cognitive projection
- chat 模式仍包含 volatile stable block
- 模式切换后 buildRequest 输出变化

---

### Task 3: AgentLoop chat 模式跳过 CVM 管线

修改 `src/agent/loop.ts`：

1. `AgentConfig`（行 102-136）新增 `mode?: PromptMode`
2. 新增方法 `setMode(mode: PromptMode)` — 同步更新 PromptEngine
3. `run()` 中（行 732-834），chat 模式跳过：
   - `perception.perceive()`（行 732-752）
   - `classifySeason()`
   - `createCognitiveLedger()`（行 818-834）
   - `buildCognitivePromptProjection()`
   - `sycophancyTrap.recordTurn()`（行 805-816）
   - `pressureMonitor.recordCvmInjection()`（行 840-841）

实现方式：在这些代码块前加 `if (shouldInjectCvm(this.mode))` 守卫。

---

### Task 4: TUI 斜杠命令

修改 `src/tui/slash-commands.ts`：

1. `SlashHandlerContext`（行 25-54）新增：
   ```typescript
   getMode: () => PromptMode
   setMode: (mode: PromptMode) => void
   ```
2. 新增命令：
   - `/chat` — 切换到对话模式，输出确认
   - `/task` — 切换到任务模式，输出确认
   - `/mode` — 显示当前模式
3. 更新 `/help` 文本

修改 `src/tui/app.tsx`（行 676-688）：
- 在 slashCtx 构建中绑定 mode getter/setter

---

### Task 5: 状态栏模式指示

修改 `src/tui/status-bar.tsx`：
- 显示当前模式标识（`[chat]` 或 `[task]`）
- chat 模式时隐藏 CVM 相关指标（confidence 等）

---

### Task 6: 集成测试

创建 `src/agent/__tests__/chat-mode-integration.test.ts`：
- chat 模式产生更短的 volatile block
- chat 模式不包含 `<cognitive-mirror` 标签
- chat 模式不包含 `<task-contract` 标签
- 模式切换后下一轮立即生效
- chat 模式下工具仍可执行
- chat 模式下 approval gate 仍工作

## 验证

```bash
npx tsc --noEmit                                              # 类型检查
npx tsx --test src/prompt/__tests__/mode.test.ts              # mode 类型测试
npx tsx --test src/prompt/__tests__/chat-mode-engine.test.ts  # engine 测试
npx tsx --test src/agent/__tests__/chat-mode-integration.test.ts  # 集成测试
```

## 不做的事

- 不做自动模式检测（后续迭代）
- 不为 chat 模式设计独立的 system prompt（共用 identity + beliefs）
- 不在 chat 模式下禁用工具（用户仍可主动使用）
- 不清空对话历史（模式切换是轻量操作）
