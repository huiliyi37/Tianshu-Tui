# Chat Mode — 对话模式实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 为天枢终端添加「对话模式」，在非任务执行场景下剥离任务执行上下文（cognitive-mirror、task-contract、historical-lessons、tool-history 等），让模型以更轻盈的状态与用户对话。

**架构：** 在 PromptEngine 中新增 `mode: 'chat' | 'task'` 状态，chat 模式下 buildRequest 跳过 cognitiveProjection、dynamicAppendix、consolidatedBlock 的注入；AgentLoop.run() 在 chat 模式下跳过 sensorium 感知、task-contract 提取、sycophancy-trap 记录、CVM projection 注入等任务执行管线；TUI 通过 `/chat` 和 `/task` 斜杠命令切换模式。

**技术栈：** TypeScript strict / PromptEngine / AgentLoop / SlashCommands / Ink 6

---

## 背景

当前架构假设每一轮都是「任务执行」。每条用户消息都会触发：
1. Sensorium 感知 — momentum、pressure、confidence 六维计算
2. Task-contract 提取 — 从用户消息中解析 objective、scope、constraints
3. Cognitive-mirror 注入 — `<cognitive-mirror confidence="1.00" .../>` 写入 prompt
4. Historical-lessons 注入 — `<historical-lessons>` 写入 prompt
5. Sycophancy-trap 记录 — 追踪连续同意/不同意模式
6. CVM overhead 追踪 — 注入 token 估算

在对话时这些是噪音。**核心原则：如果有力量让模型伪装，一定是这个世界做得不够好。**

---

## File Structure

| 操作 | 文件 | 职责 |
|------|------|------|
| 创建 | `src/prompt/mode.ts` | `PromptMode` 类型定义 + 工具函数 |
| 创建 | `src/prompt/__tests__/mode.test.ts` | mode 类型 + 工具函数测试 |
| 创建 | `src/prompt/__tests__/chat-mode-engine.test.ts` | PromptEngine chat 模式行为测试 |
| 修改 | `src/prompt/engine.ts:80-120` | 添加 mode 状态、setMode()、buildRequest 条件跳过 |
| 修改 | `src/agent/loop.ts:680-820` | run() 中 chat 模式跳过 CVM 管线 |
| 修改 | `src/tui/slash-commands.ts:50-80` | 添加 `/chat` 和 `/task` 命令 |
| 修改 | `src/tui/app.tsx` | chat 模式状态传递给 AgentLoop |
| 创建 | `src/agent/__tests__/chat-mode-integration.test.ts` | 集成测试 |

---

## Task 1: 定义 PromptMode 类型

创建 `src/prompt/mode.ts`：

```typescript
export type PromptMode = 'chat' | 'task'
export const DEFAULT_MODE: PromptMode = 'task'
export function shouldSkipCvm(mode: PromptMode): boolean { return mode === 'chat' }
export function shouldSkipDynamicAppendix(mode: PromptMode): boolean { return mode === 'chat' }
export function shouldSkipSensorium(mode: PromptMode): boolean { return mode === 'chat' }
export function shouldSkipTaskContract(mode: PromptMode): boolean { return mode === 'chat' }
```

测试：`src/prompt/__tests__/mode.test.ts` — 10 个测试覆盖所有函数。

---

## Task 2: PromptEngine 支持 mode 状态

- 添加 `private mode: PromptMode = DEFAULT_MODE`
- 添加 `setMode(mode)` / `getMode()` 方法
- `setMode` 切换时清除 `cachedFreshForUser`
- `buildRequest` 中 `shouldSkipDynamicAppendix(this.mode)` 跳过 cognitiveProjection 和 dynamicAppendix

测试：`src/prompt/__tests__/chat-mode-engine.test.ts` — 6 个测试。

---

## Task 3: AgentLoop chat 模式跳过 CVM 管线

- `AgentConfig` 添加 `mode?: PromptMode`
- 构造函数中 `promptEngine.setMode(config.mode ?? DEFAULT_MODE)`
- `run()` 中 `shouldSkipTaskContract` 跳过 task-contract 提取
- `run()` 主循环中 `shouldSkipCvm` 跳过：CVM ledger、sycophancy-trap、CVM overhead tracking
- chat 模式下 `setCognitiveProjection(null)`

---

## Task 4: TUI 斜杠命令 `/chat` 和 `/task`

- `SlashHandlerContext` 添加 `getCurrentMode` / `setMode`
- 添加 `/chat` 和 `/task` case
- 更新 `/help` 文本
- `app.tsx` 绑定 mode 状态

---

## Task 5: 端到端验证

集成测试验证：
- chat 模式 volatile block 比 task 模式短
- chat 模式不包含 cognitive-mirror、repair-hint、decisions
- task 模式包含 cognitive-mirror

---

## Verification

| 验证项 | 命令 | 期望 |
|--------|------|------|
| 类型检查 | `npx tsc --noEmit` | 无错误 |
| Mode 测试 | `npx tsx --test src/prompt/__tests__/mode.test.ts` | 10 passed |
| Engine 测试 | `npx tsx --test src/prompt/__tests__/chat-mode-engine.test.ts` | 6 passed |
| 集成测试 | `npx tsx --test src/agent/__tests__/chat-mode-integration.test.ts` | 2 passed |
