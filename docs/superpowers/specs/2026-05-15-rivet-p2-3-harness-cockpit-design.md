# Rivet P2.3 Harness Cockpit TUI 设计

## 背景

Rivet 的长期目标是面向开源/开放模型构建一个可靠的终端编码代理，让 DeepSeek、Qwen、GLM 等开放模型在真实 repo 修改、长会话、多工具执行和验证恢复场景下，具备接近 Claude Code、opencode 等主流工具的开发能力和高可用能力。

P2.1 侧重性能层和开发能力层建设，P2.2 侧重能力可靠性地基：路径边界、checkpoint v2、安全 rollback、raw output 安全、compaction 预算、测试基线、失败证据和模型能力卡。P2.3 不再继续堆工具，而是把这些 harness 能力在 TUI 中变成用户可观察、可控制、可验证的工作状态。

本设计基于两类调研：

- 项目代码调研：当前 `src/tui/app.tsx` 已经汇集 agent callback、tool log、checkpoint、cache diagnostic 和 approval；`src/agent/loop.ts` 是工具执行和 evidence 记录的中心；`src/tools/run-tests.ts` 已能解析测试结果但结构化数据尚未上抛；`src/model/capability.ts` 已有模型能力卡入口。
- 开源 harness 调研：agenttrace 的本地 trace TUI、OpenHands/OpenDev 的 context condensation 和 doom-loop 检测、SWE-ReX/SWE-agent 的 command-observation trace、OpenTelemetry GenAI span 语义、Inspect AI/Harbor/Terminal-Bench 的 solver/scorer/report 思路，都表明可靠 agent 的关键不是更像聊天窗口，而是把运行时、工具、上下文、验证和恢复状态显性化。

## 目标

P2.3 的目标是把 Rivet TUI 从“对话 + 工具输出列表”升级为 **Harness Cockpit**：用户在一个终端界面里就能判断 agent 当前是否可信、是否验证充分、是否处于高风险操作、上下文是否健康，以及失败后能否恢复。

成功标准：

- 每个 turn 都有可见 trace 摘要，展示模型响应、工具调用、状态、耗时和 raw output 入口。
- 每次测试运行都形成结构化 verification 状态，而不是从文本 badge 反推。
- 任何需要审批的工具调用都展示风险等级、原因、目标和潜在破坏性。
- cache、token、compaction、fingerprint drift 不再只存在于 `/debug`，而是可以在 Cockpit 面板中查看。
- checkpoint 和 rollback 状态能展示“是否可回滚”和“回滚影响哪些 agent-owned 文件”。
- 模型能力卡作为 Open Model Capability Lab 的入口在 TUI 中可见，但不在 P2.3 实现完整 eval runner。

## 非目标

P2.3 不做以下事情：

- 不做完整多 agent 编排。
- 不做 git worktree isolation。
- 不接入 Terminal-Bench、SWE-bench 或 Harbor 的完整评测运行器。
- 不引入 OpenTelemetry SDK 或外部观测后端。
- 不做浏览器 dashboard。
- 不做复杂快捷键系统。
- 不重构 provider、prompt engine 或 tool registry 的整体架构。
- 不把 TUI 变成大而全的 IDE；P2.3 只建设 terminal-native cockpit rail 和结构化状态源。

## 推荐方案

采用 **Trace/Verification Rail** 作为 P2.3 的最小可行 Harness Cockpit，并为后续完整 Cockpit 和 Open Model Capability Lab 预留数据结构。

不采用纯状态栏增强方案，因为它只能改善可见性，无法建立 trace、verification 和 approval risk 的结构化状态。不采用一次性完整 Harness Cockpit，因为它会把 P2.3 范围扩大到多 agent、eval lab 和复杂布局，超过一个阶段能稳定交付的边界。

P2.3 的核心形态：

```text
┌ status bar ─────────────────────────────────────┐
│ model | cache | cost | tokens | verify | risk  │
├ conversation / tool cards ──────────────────────┤
│ user input, streaming answer, thinking, tools   │
├ cockpit rail ───────────────────────────────────┤
│ Trace: 3 tools | Verify: failed | Safe: warn    │
└ input ──────────────────────────────────────────┘
```

Cockpit rail 可以通过 slash command 切换视图：

```text
/cockpit trace
/cockpit verify
/cockpit context
/cockpit safety
/cockpit model
```

P2.3 先使用 slash command，不引入新的全局快捷键，避免与当前 `useInput` 分发冲突。

## 架构

新增一层 `CockpitState`，把 agent loop、tool execution、verification、approval、cache diagnostic、checkpoint 和 model capability 转成结构化状态，再由 Ink 组件渲染。

```text
AgentLoop / ToolRegistry / SessionContext
  ↓ emits structured events
TraceEvent / VerificationRun / ApprovalRisk / ContextSnapshot / SafetySnapshot
  ↓
CockpitState
  ↓
Ink components
  - CockpitRail
  - TracePanel
  - VerificationPanel
  - ContextPanel
  - SafetyPanel
  - ModelPanel
  - ApprovalRiskCard
```

设计原则：

- Agent 层只负责产生事实事件，不直接决定 TUI 展示。
- TUI 层只消费结构化状态，不从截断文本中重新解析测试结果。
- Tool 输出继续保持三层：model output、UI output、raw output。
- Cockpit 状态保持本地内存结构，不在 P2.3 引入外部数据库或 telemetry backend。
- 数据结构命名尽量贴近 OpenTelemetry GenAI span 的概念，但不依赖 OTel SDK。

## 文件边界

建议新增文件：

```text
src/agent/trace-store.ts
src/agent/verification-state.ts
src/agent/approval-risk.ts
src/tui/cockpit/cockpit-rail.tsx
src/tui/cockpit/trace-panel.tsx
src/tui/cockpit/verification-panel.tsx
src/tui/cockpit/context-panel.tsx
src/tui/cockpit/safety-panel.tsx
src/tui/cockpit/model-panel.tsx
src/tui/cockpit/approval-risk-card.tsx
```

建议修改文件：

```text
src/tools/types.ts
src/tools/run-tests.ts
src/tools/registry.ts
src/agent/loop.ts
src/agent/evidence.ts
src/agent/context.ts
src/tui/app.tsx
src/tui/status-bar.tsx
src/tui/tool-card.tsx
src/tui/log-state.ts
src/model/capability.ts
```

边界说明：

- `trace-store.ts` 只负责记录 turn/tool/model/cache/checkpoint 事件，不依赖 React。
- `verification-state.ts` 只负责测试运行和修改后验证状态，不解析 UI 文本。
- `approval-risk.ts` 只负责风险分类和展示所需摘要，不执行审批。
- `cockpit/*` 组件只负责渲染，不直接调用工具或修改 session。
- `app.tsx` 作为当前 TUI 汇流点，负责把 callbacks 转成 CockpitState 更新。

## 数据模型

### TraceEvent

```typescript
export type TraceEventKind = 'model' | 'tool' | 'verification' | 'checkpoint' | 'cache'
export type TraceEventStatus = 'running' | 'passed' | 'failed' | 'blocked'

export interface TraceEvent {
  id: string
  turn: number
  kind: TraceEventKind
  name: string
  status: TraceEventStatus
  startedAt: number
  endedAt?: number
  durationMs?: number
  summary?: string
  rawPath?: string
}
```

用途：Trace panel 显示最近 N 个事件。工具事件从 `onToolUse` 开始，到最终 `onToolResult` 结束。测试事件可以同时产生 `tool` 和 `verification` 两种视角。

### VerificationRun

```typescript
export interface VerificationRun {
  command: string
  scope: 'targeted' | 'full'
  status: 'passed' | 'failed' | 'blocked'
  exitCode: number
  passed: number
  failed: number
  skipped: number
  durationMs: number
  rawPath?: string
}
```

用途：Verification panel 和 evidence badge 使用同一份结构化测试结果。`run_tests` 必须把 `ParsedResult` 上抛为 metadata，而不是只返回格式化字符串。

### ApprovalRisk

```typescript
export interface ApprovalRisk {
  toolName: string
  level: 'low' | 'medium' | 'high'
  reason: string
  targets: string[]
  destructive: boolean
  outsideProject: boolean
}
```

用途：ApprovalRiskCard 替代简单 `[y/n]` 提示。风险由 tool name、参数、路径校验结果和命令分类共同决定。

### ContextSnapshot

```typescript
export interface ContextSnapshot {
  estimatedTokens: number
  maxTokens: number
  cacheHitRate: number
  lastCacheReason?: string
  lastCacheSeverity?: 'info' | 'warn' | 'error'
  compactedThisTurn: boolean
  fingerprintDrift: boolean
}
```

用途：Context panel 展示 token、cache、compaction 和 drift 状态。数据来自 `SessionContext`、`diagnoseCacheMiss()` 和 `agent.getDebugInfo()`。

### SafetySnapshot

```typescript
export interface SafetySnapshot {
  checkpointHash?: string
  rollbackAvailable: boolean
  rollbackFiles: string[]
  protectedDirtyFiles: boolean
  lastApprovalRisk?: ApprovalRisk
  doomLoopLevel: 'none' | 'warn' | 'blocked'
}
```

用途：Safety panel 展示 checkpoint、rollback、审批风险和循环检测状态。

## 数据流

### 普通 turn

```text
InputBar submit
  → App.handleSubmit
  → AgentLoop.run
  → ApiClient.stream
  → onTextDelta / onThinkingDelta
  → onContentBlock(tool_use)
  → CockpitState records model/tool running events
  → ToolRegistry.execute
  → CockpitState marks tool passed/failed/blocked
  → SessionContext records usage/cache
  → CockpitState records ContextSnapshot
  → TUI renders rail + panels
```

### 测试工具

```text
run_tests.execute
  → detects command
  → spawns process
  → parses output into ParsedResult
  → returns ToolResult.content + rawPath + verification metadata
  → AgentLoop records VerificationRun
  → EvidenceTracker consumes VerificationRun
  → CockpitState updates VerificationPanel
```

### 审批工具

```text
ToolRegistry evaluates approval need
  → approval-risk builds ApprovalRisk
  → App shows ApprovalRiskCard
  → user approves or denies
  → TraceEvent status passed/blocked
  → SafetySnapshot remembers last approval risk
```

### rollback

```text
/rollback
  → getRollbackPreview
  → SafetySnapshot stores rollback files + token availability
  → /rollback confirm
  → rollbackToCheckpoint with token
  → TraceEvent checkpoint passed/failed
  → SafetySnapshot refreshes rollback availability
```

## TUI 面板设计

### StatusBar

当前状态栏继续显示 model、cache、cost、tokens。P2.3 增加两个短状态：

```text
verify:pass|fail|none
risk:none|warn|high
```

避免状态栏过载，详细内容进入 cockpit rail。

### CockpitRail

Rail 是常驻底部区域，默认一行摘要：

```text
Trace: 3 tools, 1 failed | Verify: targeted failed | Context: cache 86% | Safety: checkpoint ok
```

当用户输入 `/cockpit trace` 等命令时，rail 展开为对应 panel 的多行视图。

### TracePanel

示例：

```text
Trace
#12 model          ✓ 1.4s
#12 read_file      ✓ 31ms
#12 edit_file      ✓ 24ms
#12 run_tests      ✗ 2.3s   raw:/tmp/rivet-raw/xxxx.raw
```

设计约束：

- 只展示最近 N 个事件。
- 不展示完整工具输出，完整输出仍由 ToolCard 和 raw output 负责。
- blocked 与 failed 分开显示，避免把用户拒绝审批误判为测试失败。

### VerificationPanel

示例：

```text
Verification
Last: targeted failed
Command: npm test -- src/agent/loop.test.ts
Result: 159 passed, 3 failed, 0 skipped
Risk: full suite not run
Raw: /tmp/rivet-raw/xxxx.raw
```

如果修改后没有测试：

```text
Verification
Status: unverified
Reason: files modified after last test run
```

### ContextPanel

示例：

```text
Context
Tokens: 143,202 / 1,000,000
Cache: 86.2%
Compaction: not needed
Drift: none
Last miss: normal growth
```

当 cache drift 或 compaction 发生时，显示 warn/error，但不打断主流程。

### SafetyPanel

示例：

```text
Safety
Checkpoint: 4bb7768
Rollback: 2 agent-owned files
Protected dirty files: yes
Doom-loop: none
Last approval: bash / high
```

P2.3 初版可以先展示 checkpoint、rollback availability 和 last approval risk；doom-loop 检测作为同阶段后续任务，但数据结构必须预留。

### ModelPanel

示例：

```text
Model Capability
deepseek-v4
Tool use: 0.82
Edit success: 0.76
Test repair: 0.61
Recommended: repo_summarization, code_edit
```

ModelPanel 是 Open Model Capability Lab 的入口。P2.3 只展示已有 capability card，不运行 benchmark。

### ApprovalRiskCard

替代当前简单审批框：

```text
Tool Approval
Tool: bash
Risk: high
Reason: command may modify git state
Targets: unknown
Destructive: possible

[y] approve  [n] deny
```

P2.3 不实现 `[d] diff` 或 `[v] full input`，但组件接口保留扩展空间。

## 风险分类规则

初始规则：

- `read_file`、`grep`、`glob`、`diff`：low，通常不需要审批。
- `write_file`、`edit_file`：medium，展示目标路径。
- `bash`：根据命令分类。
  - 只读命令：low。
  - 会写文件、安装依赖、运行脚本：medium。
  - `rm`、`git reset --hard`、`git clean`、force push、kill 进程：high。
- rollback：high，但如果已有 confirmation token 且只影响 agent-owned 文件，则展示为 controlled high risk。
- cwd 外路径：high，优先由 path validation 拒绝，不进入普通审批。

风险分类不替代现有安全边界；它只是让用户知道为什么要审批。

## Doom-loop 检测

P2.3 可以引入轻量循环检测，避免 agent 在相同工具调用或相同失败修复路径中无限消耗上下文。

设计：

```typescript
interface ToolFingerprint {
  name: string
  inputHash: string
  outputClass?: string
}
```

规则：

- 最近 20 次工具调用中同一 fingerprint 出现 3 次：SafetyPanel 显示 warn。
- 同一 fingerprint 出现 5 次：下一次相同工具调用需要人工审批。
- 用户批准后只放行一次，不永久关闭检测。

P2.3 初版只记录和展示；阻断策略可以作为后续实现步骤。

## 错误处理

必须明确区分以下状态：

- `failed`：工具或测试真实失败，例如 exit code 非 0。
- `blocked`：用户拒绝审批、测试超时、环境缺失、缺少 credentials、路径被拒绝。
- `unverified`：修改发生后没有新的测试或验证。
- `warn`：cache miss、compaction、checkpoint 不可用、doom-loop 预警。

错误处理规则：

- ToolCard 继续显示工具输出摘要，即使 Cockpit metadata 缺失。
- raw output path 丢失时，panel 显示 `raw unavailable`，不影响主流程。
- Verification metadata 缺失时，VerificationPanel 显示 `unknown`，并提示该 tool 尚未接入 metadata。
- ApprovalRisk 生成失败时，退回当前 `[y/n]` 机制，但记录 SafetyPanel warning。
- SessionContext 内部状态变化不会自动触发 React re-render，因此 App 层必须在 `onToolUse`、`onToolResult`、`onTurnComplete` 中显式 setState。

## 测试策略

以单元测试和轻量 TUI render 测试为主。

建议测试文件：

```text
src/agent/__tests__/trace-store.test.ts
src/agent/__tests__/verification-state.test.ts
src/agent/__tests__/approval-risk.test.ts
src/tui/cockpit/__tests__/trace-panel.test.tsx
src/tui/cockpit/__tests__/verification-panel.test.tsx
src/tui/cockpit/__tests__/context-panel.test.tsx
src/tui/cockpit/__tests__/safety-panel.test.tsx
src/tools/__tests__/run-tests.test.ts
```

测试覆盖点：

- TraceStore 能记录 start/end、duration、status，并限制最大事件数。
- VerificationState 能识别 passed、failed、blocked、unverified。
- ApprovalRisk 能分类 read/write/edit/bash/rollback/path outside project。
- run_tests 能把 parsed result 上抛为 metadata。
- TracePanel 能渲染 passed/failed/blocked 工具事件。
- VerificationPanel 能渲染 targeted/full、failed/blocked、raw path 和 full-suite 风险。
- ContextPanel 能渲染 cache warning 和 fingerprint drift。
- SafetyPanel 能渲染 checkpoint、rollback 文件和 last approval risk。
- App slash command 能切换 cockpit panel。

验证命令：

```bash
npm run typecheck
npm test
npm run build
```

手动验证：

```text
npm start
/cockpit trace
/cockpit verify
/cockpit context
/cockpit safety
/cockpit model
/rollback
```

## 分阶段落地建议

### Phase 1：结构化状态地基

- 扩展 `ToolResult` metadata。
- 新增 `TraceStore`。
- 新增 `VerificationState`。
- 让 `run_tests` 上抛结构化 verification。
- 让 `AgentLoop` 发出 trace start/end。

### Phase 2：Cockpit Rail 初版

- 新增 `CockpitRail`。
- 新增 TracePanel 和 VerificationPanel。
- 在 `App` 中支持 `/cockpit trace`、`/cockpit verify`。
- StatusBar 增加 verify/risk 摘要。

### Phase 3：Safety / Context / Approval

- 新增 `ApprovalRisk`。
- 替换 approval UI 为 ApprovalRiskCard。
- 新增 ContextPanel。
- 新增 SafetyPanel。
- 接入 checkpoint preview 和 cache diagnostic。

### Phase 4：Model / Doom-loop / Lab 入口

- 新增 ModelPanel。
- 接入 `ModelCapabilityCard`。
- 新增 doom-loop 检测状态。
- 为后续 eval runner 预留 `RivetEvaluator` 接口，但不实现完整 benchmark。

## 设计风险与规避

### Ink 布局过载

风险：Ink 不适合复杂 overlay 和多窗口布局。  
规避：P2.3 采用底部 rail + slash command 切换，不做复杂浮层。

### 状态源分散

风险：App 继续从 callback、session、tool text 多处拼 UI，后续难维护。  
规避：引入 CockpitState，把 trace、verification、context、safety 统一成结构化状态。

### 从文本反解析测试结果

风险：测试输出被截断后无法可靠生成 verification。  
规避：`run_tests` 在 tool 内部直接返回 metadata，Evidence 和 TUI 都消费 metadata。

### 快捷键冲突

风险：`useInput` 已存在于 App、Input 和 Thinking 相关组件，新增面板快捷键容易冲突。  
规避：P2.3 初版只用 slash command；快捷键留到布局稳定后再做。

### scope 膨胀

风险：Cockpit 容易滑向完整 IDE、多 agent 和 eval 平台。  
规避：P2.3 明确只做 Trace/Verification Rail 和基础面板，不做多 agent、worktree、外部 eval runner。

## 规格自检

- 占位符检查：本文没有保留待填章节，也没有使用未定义的核心概念。
- 内部一致性检查：目标、非目标、架构、数据模型、TUI 面板和测试策略都围绕 Trace/Verification Rail 展开。
- 范围检查：P2.3 聚焦一个实现计划可覆盖的 TUI Harness Cockpit，不包含多 agent 和完整 eval lab。
- 模糊性检查：Cockpit 初版采用 slash command 切换，不采用快捷键或 overlay；verification 必须来自 structured metadata，不从截断文本反推。

## 下一步

如果该规格通过审查，下一步应创建 P2.3 实施计划，按 Phase 1 到 Phase 4 拆成测试先行的小任务，并优先实现结构化状态地基，再实现 TUI rail。
