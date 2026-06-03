# loop.ts 拆分 v2 — 从 1856 行到 1785 行

> **面向 AI 代理：** 逐任务实现。每完成一个任务立即 typecheck + test + commit。

**目标：** 将 `src/agent/loop.ts`（1856 行，120 个私有字段，职责过载）拆分为类型层 + 工厂层 + 编排层。

**当前进度：** Task 1-2 完成（类型层提取），Task 3 受限于 TypeScript private 属性约束暂停。loop.ts 从 1856 → 1785 行。

**架构核心决策：**

1. **类型先行（无风险）** — `AgentConfig`、`AgentCallbacks` 是多达 12 个文件的共同依赖，抽出为 `loop-types.ts` 是纯机械操作
2. **工厂模式（已有先例）** — `CompactionController`、`ToolExecutionController` 等都用 options bag 接收回调；提取工厂不改变任何行为
3. **不引入新抽象** — 不做中间件链、不做洋葱模型。不改现有的 controller 注入模式。只把 loop.ts 里 **不属于 AgentLoop 类本身** 的逻辑移走
4. **保持向后兼容** — `import { AgentLoop } from './loop.js'` 对外不变，loop.ts 重导出所有符号

**技术栈：** TypeScript strict, node:test + assert/strict

---

## Scope Check

| 子系统 | 是否涉及 | 原因 |
|--------|---------|------|
| `src/agent/loop.ts` | ✅ 是 | 拆分主体 |
| `src/agent/loop-types.ts` | ✅ 新建 | AgentConfig + AgentCallbacks + ApprovalMode |
| `src/agent/loop-factory.ts` | ✅ 新建 | 构造函数体 → 工厂函数 |
| `src/agent/turn-orchestrator.ts` | ✅ 新建 | `_runInner` 主体 → 编排器 |
| `src/agent/tool-history-recorder.ts` | ✅ 新建 | recordToolHistory 函数 |
| `src/agent/theta-controller.ts` | ✅ 新建 | requestThetaCheck 状态机 |
| `src/agent/turn-preflight.ts` | ✅ 新建 | turn 前置准备（compact/split/perception/intent/CVM） |
| `src/tui/app.tsx` | ❌ 否 | 通过 loop.ts 重导出，无需修改 |
| `src/agent/worker-session.ts` | ❌ 否 | 同上 |
| `src/agent/tool-execution.ts` | ⚠️ 最小 | AgentConfig import 路径改为 loop-types.ts |
| `src/agent/turn-completion.ts` | ⚠️ 最小 | 同上 |
| `src/agent/tool-pipeline.ts` | ⚠️ 最小 | 同上 |
| `src/agent/create-agent-config.ts` | ⚠️ 最小 | 同上 |
| `src/api/` `src/prompt/` `src/tools/` | ❌ 否 | 不相干 |

---

## 调研背书

### loop.ts 当前结构（1856 行分解）

| 区域 | 行数（估） | 当前位置 | 可提取？ | 理由 |
|------|-----------|---------|---------|------|
| import 块 | ~90 | 文件头 | 否 | 分散后各自管理 |
| `AgentConfig` interface | ~70 | loop.ts L101-170 | **是 → loop-types.ts** | 纯类型，12 个文件依赖 |
| `AgentCallbacks` interface | ~30 | loop.ts L172-200 | **是 → loop-types.ts** | 纯类型 |
| `ApprovalMode` type | ~1 | loop.ts L100 | **是 → loop-types.ts** | 纯类型 |
| `AgentLoop` 私有字段 | ~60 | 类体 | 否 | 是类状态，属于 AgentLoop |
| `constructor`（含控制器创建） | ~220 | L240-460 | **是 → loop-factory.ts** | 纯装配逻辑 |
| `createTurnStreamController` | ~45 | L462-507 | **是 → loop-factory.ts** | 工厂方法，不在热路径 |
| `createTurnCompletionController` | ~30 | L509-539 | **是 → loop-factory.ts** | 同上 |
| `createToolExecutionController` | ~55 | L541-596 | **是 → loop-factory.ts** | 同上 |
| `buildRuntimeSnapshot` | ~15 | L597-612 | **是 → loop-factory.ts** | 简单投影 |
| `recordToolHistory` | ~75 | L620-695 | **是 → tool-history-recorder.ts** | 复杂，含 setImmediate 延迟处理 |
| `bindSessionDomain` + `buildAnchorGraph` + `callAntiAnchoringSeedModel` | ~55 | L697-752 | 否 | 与 AgentLoop 状态紧耦合 |
| `maybePrewarm` + `prewarmRecentReads` | ~20 | L754-773 | 否 | 行数小，用 prewarm 私有字段 |
| 公共 getter/setter（~20 个方法） | ~100 | L775-875 | 否 | 是 AgentLoop 公共 API |
| `requestThetaCheck` | ~55 | L876-931 | **是 → theta-controller.ts** | 自含状态机，只依赖 cwd + session |
| `refreshReliabilityDecision` | ~55 | L932-987 | 否 | 与多个私有字段交互 |
| `runPostSession` | ~25 | L989-1014 | 否 | 行数小 |
| `startFsWatcher` / `stopFsWatcher` | ~10 | L1016-1025 | 否 | 行数小 |
| `run` + `_runInner` | ~370 | L1027-1397 | **部分 → turn-orchestrator.ts + turn-preflight.ts** | 核心逻辑，预检可独立 |
| `warmupMemories` | ~12 | L1399-1411 | 否 | 行数小 |
| `wrapCallbacksWithHeartbeat` | ~25 | L1413-1438 | 否 | 行数小 |
| `hexComplement` | ~8 | L1440-1448 | 否 | 工具函数 |

### 调用方 blast radius

```
src/agent/loop.ts 被以下文件导入：
├── AgentLoop (class): src/tui/app.tsx, src/agent/worker-session.ts
├── AgentLoop (type): src/tui/slash-commands.ts, src/tui/cockpit-view.tsx
├── AgentConfig (type): src/agent/tool-execution.ts, src/agent/turn-completion.ts,
│                       src/agent/turn-end.ts, src/agent/tool-pipeline.ts,
│                       src/agent/create-agent-config.ts
├── AgentCallbacks (type): src/agent/tool-execution.ts, src/agent/tool-pipeline.ts,
│                          src/agent/hands-session.ts, src/__tests__/*.test.ts
└── ApprovalMode (type): (inline in AgentConfig)
```

**策略：** loop.ts 保留所有公共 API 的重导出，外部文件逐步迁移 import 路径。不会 break 任何调用方。

---

## 任务

### Task 1: 提取类型层 — `loop-types.ts`

**文件：** `src/agent/loop-types.ts`（新建）、`src/agent/loop.ts`（改）

**做什么：** 将 `AgentConfig`、`AgentCallbacks`、`ApprovalMode` 三个纯类型定义移到 `loop-types.ts`。loop.ts 改为从 `loop-types.ts` 导入并重导出。外部 import 路径暂不变（后续任务统一迁移）。

**验证：** `npx tsc --noEmit` 零错误。

- [ ] 创建 `src/agent/loop-types.ts`，移入 `AgentConfig`、`AgentCallbacks`、`ApprovalMode`
- [ ] loop.ts 从 `./loop-types.js` 导入并重导出这三个符号
- [ ] typecheck 通过

### Task 2: 迁移外部 import 路径

**文件：** `src/agent/tool-execution.ts`、`src/agent/turn-completion.ts`、`src/agent/turn-end.ts`、`src/agent/tool-pipeline.ts`、`src/agent/create-agent-config.ts`、`src/agent/hands-session.ts`、`src/__tests__/goal-loop.test.ts`、`src/__tests__/goal-loop-integration.test.ts`

**做什么：** 将所有 `import type { AgentConfig, AgentCallbacks } from './loop.js'` 改为从 `./loop-types.js` 导入。loop.ts 仍然重导出以保证向后兼容。

**验证：** typecheck + `npm exec -- tsx --test src/__tests__/goal-loop.test.ts src/__tests__/goal-loop-integration.test.ts`

- [ ] 逐个修改 8 个文件的 import 路径
- [ ] typecheck + 测试通过

### Task 3: 提取工厂函数 — `loop-factory.ts`

**文件：** `src/agent/loop-factory.ts`（新建）、`src/agent/loop.ts`（改）

**做什么：** 将构造函数体中 3 个控制器的创建逻辑 + `buildRuntimeSnapshot` 提取为独立工厂函数 `createAgentLoopControllers(config, session)`。返回 `{ turnStream, turnCompletion, toolExecution, buildRuntimeSnapshot }` 等。AgentLoop 构造函数调用此工厂。

**理由：** 这是 loop.ts 中最大的单一代码块（~200 行），纯装配逻辑无业务含义，放在工厂中不会增加认知负载。且工厂函数可独立测试。

- [ ] 创建 `src/agent/loop-factory.ts`
- [ ] 移入 `createTurnStreamController`、`createTurnCompletionController`、`createToolExecutionController`、`buildRuntimeSnapshot` 的逻辑（参数化所有 `this.xxx` 引用）
- [ ] AgentLoop 构造函数调用工厂函数，赋值给私有字段
- [ ] typecheck 通过

### Task 4: 提取 toolHistoryRecorder

**文件：** `src/agent/tool-history-recorder.ts`（新建）、`src/agent/loop.ts`（改）

**做什么：** 提取 `recordToolHistory` 及其 setImmediate 延迟处理逻辑为独立函数 `createToolHistoryRecorder(deps)`。返回 `(name, input, isError, result) => void`。

**理由：** 75 行业务逻辑 + setImmediate 异步副作用。提取后：
- 可独立测试 record + deferred processing
- AgentLoop 中简化为 `this.recordToolHistory = createToolHistoryRecorder({...})`

- [ ] 创建 `src/agent/tool-history-recorder.ts`
- [ ] 提取 recordToolHistory 全量逻辑（含 P3/Immune/Physarum 延迟处理）
- [ ] AgentLoop 构造函数中赋值 `this.recordToolHistory = createToolHistoryRecorder(...)`
- [ ] typecheck 通过

### Task 5: 提取 theta-controller

**文件：** `src/agent/theta-controller.ts`（新建）、`src/agent/loop.ts`（改）

**做什么：** 提取 `requestThetaCheck` 及 theta 状态机（gate logic、backoff、cooldown）为 `createThetaController(deps)`。返回 `{ requestCheck, getTelemetry, resetPerTurn }`。

**理由：** 55 行自含状态机 + 静态常量。提取后：
- theta 逻辑可独立测试（门控、退避、超时处理）
- AgentLoop 中 `requestThetaCheck` 变为代理调用

- [ ] 创建 `src/agent/theta-controller.ts`
- [ ] 移入 thetaTelemetry 状态、静态常量、requestThetaCheck 全量逻辑
- [ ] AgentLoop 中使用 thetaController 代理
- [ ] typecheck 通过

### Task 6: 提取 turn-preflight（turn 前置准备阶段）

**文件：** `src/agent/turn-preflight.ts`（新建）、`src/agent/loop.ts`（改）

**做什么：** `_runInner` 的 for 循环中，每个 turn 的 compaction + perception + intent + CVM 阶段提取为 `executeTurnPreflight(deps)` → `TurnPreflightResult`。函数式：输入状态，返回新状态。

**理由：** 这是 `_runInner` 中最长的连续代码块（~180 行），包含：
- trySessionSplit + maybeCompact + stale-round compaction + heap compaction
- perception（sensorium 计算 + 季节分类 + 收敛检测）
- intent evaluation
- CVM（认知投影 + 谄媚陷阱 + 免疫信号 + 跨会话事件）

每块有清晰的输入/输出边界，适合函数式提取。

- [ ] 创建 `src/agent/turn-preflight.ts`
- [ ] 提取 compaction block（~60 行）
- [ ] 提取 perception block（~30 行）
- [ ] 提取 CVM + sycophancy + cross-session block（~50 行）
- [ ] `_runInner` 中调用 `executeTurnPreflight(deps)`
- [ ] typecheck 通过

### Task 7: 收尾 — loop.ts 最终清理

**文件：** `src/agent/loop.ts`

**做什么：** 确认 loop.ts 行数降到目标（&lt;600 行）。移除不再需要的 import。确保所有符号正确重导出。

**验证：** `npx tsc --noEmit` + 全量测试 `npm exec -- tsx --test src/**/__tests__/*.test.ts`

- [ ] loop.ts 清理死 import
- [ ] 确认 `AgentLoop` 类所有公共 API 不变
- [ ] typecheck + 全量测试通过

---

## 验证

```bash
# 每个任务完成后
npx tsc --noEmit

# Task 2 特定测试
npm exec -- tsx --test src/__tests__/goal-loop.test.ts src/__tests__/goal-loop-integration.test.ts

# Task 7 全量
npm exec -- tsx --test src/**/__tests__/*.test.ts
```

---

## 自检

- AgentConfig / AgentCallbacks 类型定义不变 → Task 1-2 覆盖
- AgentLoop 公共 API（run/abort/setApprovalMode/getDebugInfo 等 20+ 方法）不变 → 所有任务保持
- 外部 import `{ AgentLoop } from './loop.js'` 不 break → Task 1-2 确保重导出
- 构造函数行为不变（只是装配方式从 inline 改为工厂调用）→ Task 3
- recordToolHistory 行为不变 → Task 4
- theta check 门控逻辑不变 → Task 5
- run 循环行为不变 → Task 6
- loop.ts ≤ 600 行 → Task 7 验证
- 无 TODO/待定/后续实现
