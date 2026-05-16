# Rivet P2 补强设计：Model Routing + MCP Integration + Repo Intelligence

## 背景

Rivet 的 P0/P1 缺口已闭合（Tool Safety、Verification/Evidence、Execution Resilience、Sub-agent Orchestration、Cockpit State）。P2 三个缺口需要补强，让 agent 在执行时拥有更多上下文智能。

## 外部调研结论

| 领域 | 关键发现 |
|------|---------|
| Model Routing | 开源社区做"可解释 task 推断 + 用户可见选模原因"，无人做自动 verification feedback 调权重。Continue 的 ClawRouter 按复杂度+成本路由是最好参考。 |
| MCP | MCP SDK 有 `ProtocolError`/`SdkError` 但无标准错误本体。GitHub MCP Server 的 toolset+permission 模式值得借鉴。 |
| Repo Intelligence | `dependency-tree`/`dpdm` 是最轻量方案，aider 的 repomap（graph → ranked relevance）是好模型。自建正则 import graph 更轻。 |

---

## 1. Model Routing

### 现状

`model/capability.ts` 有 `recommendModelForTask()` 按 5 种 task type 评分选模型，但只在 coordinator（子代理）使用。主 AgentLoop 不做 task routing。

### 设计

**数据流：** 每 turn 推断 task type → `recommendModelForTask()` → 如果推荐不同模型则切换 → TUI 显示 reason → 验证结果写入 metrics（仅记录）。

#### 1.1 TaskInferrer

纯函数 `inferTaskType(recentTools)` 从当前 turn 的 tool 调用序列推断 task type。

文件：`src/model/task-inferrer.ts`

推断规则：

| 最近 tool 序列 | 推断 task type |
|---------------|---------------|
| `edit_file` / `write_file` | `code_edit` |
| `run_tests` + 结果含 failure | `test_failure_diagnosis` |
| `grep` / `glob` / `read_file` 密集（≥3 次无 edit） | `repo_summarization` |
| `edit_file` 多文件 + `run_tests` | `risky_refactor` |
| 默认 | `null`（不切换） |

输入：`Array<{ name: string; isError: boolean }>`（最近 5-10 个 tool 调用）
输出：`CapabilityTask | null` + `reason: string`

```typescript
export interface TaskInference {
  task: CapabilityTask
  reason: string
}

export function inferTaskType(
  recentCalls: Array<{ name: string; isError: boolean }>,
): TaskInference | null
```

#### 1.2 Turn-level Routing

文件：`src/agent/loop.ts` 修改

每个 turn 结束时：
1. 从 trajectory 取最近 tool 调用
2. 调用 `inferTaskType()`
3. 如果返回非 null，调用 `recommendModelForTask(task, cards)`
4. 如果推荐模型 ≠ 当前模型 且 用户未手动锁定（`modelLocked: boolean` flag）：
   - 切换模型（调用 `onModelSwitch(recommended.model)`）
   - 记录 routing event 到 RoutingMetrics
5. 将 routing reason 注入 volatile context（`<model_routing>` block）

#### 1.3 RoutingMetrics

文件：`src/model/routing-metrics.ts`

纯数据记录，不影响 routing 逻辑。

```typescript
export interface RoutingEvent {
  turn: number
  inferredTask: CapabilityTask
  recommendedModel: string
  currentModel: string
  switched: boolean
  reason: string
  timestamp: number
  verificationOutcome?: 'passed' | 'failed' | 'blocked'
}

export class RoutingMetricsCollector {
  private events: RoutingEvent[] = []
  
  record(event: RoutingEvent): void
  getEvents(): RoutingEvent[]
  getStats(): { total: number; switches: number; byTask: Map<string, number> }
}
```

#### 1.4 TUI

文件：`src/tui/cockpit/model-panel.tsx` 修改

ModelPanel 增加 `routingReason?: string` prop。显示如：

```
Model
deepseek-v4
Cache: ████████ 85%
Selected for: code_edit · fast-json recommended
```

CockpitSnapshot.model 扩展增加 `routingReason: string | null`。

### 不做的事

- 不做 verification 自动反馈到 model 权重
- 不做跨 session model 偏好持久化
- 不做用户手动 override 以外的模型锁定

---

## 2. MCP Integration

### 现状

MCP manager 有连接生命周期、工具发现、error state。wrapper.ts 有 write-pattern approval heuristic。CockpitSnapshot 有 MCP section。缺少 failure 分类恢复、cockpit 展示、用户可见权限。

### 设计

**数据流：** MCP tool 调用 → `classifyMcpError()` 分类 → retryable 走 TurnHarness → non-retryable 直接返回 + cockpit 标记。

#### 2.1 McpFailureClassifier

文件：`src/mcp/failure-classifier.ts`

```typescript
export type McpErrorClass = 'config' | 'auth' | 'network' | 'protocol' | 'tool_error'

export interface ClassifiedMcpError {
  class: McpErrorClass
  retryable: boolean
  suggestion: string
}

export function classifyMcpError(error: unknown): ClassifiedMcpError
```

分类规则：

| class | 匹配条件 | retryable | suggestion |
|-------|---------|-----------|------------|
| `config` | ENOENT、invalid JSON、bad command、server launch fail | 否 | Check MCP server config |
| `auth` | 401、403、permission denied、scope mismatch | 否 | Check API key / OAuth config |
| `network` | ECONNREFUSED、ETIMEDOUT、socket hang up、transport close | 是 | Retry may succeed |
| `protocol` | InvalidParams、capability mismatch、malformed response | 否 | Check tool input schema |
| `tool_error` | 正常返回但 `isError: true` | 视 error message | Read error output |

#### 2.2 Wrapper 增强

文件：`src/mcp/wrapper.ts` 修改

`execute()` 方法中：
1. 捕获 thrown exception → `classifyMcpError()` → 如果 retryable 且 TurnHarness 可用则 retry
2. 对于 `isError: true` 的正常返回，提取 error class 附加到 result content
3. 更新 `McpConnectionState` 的 `lastErrorClass` 和 `lastErrorAt`

McpConnectionState 扩展：

```typescript
export interface McpConnectionState {
  serverId: string
  status: 'disconnected' | 'connecting' | 'connected' | 'error'
  toolCount: number
  error?: string
  lastConnectedAt?: number
  lastErrorClass?: string
  lastErrorAt?: number
}
```

#### 2.3 Cockpit MCP Panel

文件：`src/tui/cockpit/mcp-panel.tsx`（新建）

展示内容：
- 每个 server：名称、状态（●connected / ◐connecting / ✗error）、tool count
- error 状态时显示 error class 和建议
- 总计：N servers, M tools

CockpitSnapshot.mcp 扩展：

```typescript
mcp: {
  servers: Array<{
    serverId: string
    status: string
    toolCount: number
    lastErrorClass?: string
    lastErrorAt?: number
  }>
  totalTools: number
  connectedServers: number
}
```

`types.ts` 中 Panel 增加 `'mcp'`。

#### 2.4 Tool 来源可见

wrapper.ts 的 tool result 追加标注行：
```
[MCP: serverId · write-capable]
```

error 时：
```
[MCP: serverId · write-capable · error: network · Retry may succeed]
```

### 不做的事

- 不做 MCP tool permission group 系统
- 不做跨 session MCP 状态持久化
- 不改 MCP config schema

---

## 3. Repo Intelligence

### 现状

`related-tests.ts` 基于路径约定找测试。`repo-map.ts` 做文件树。没有 import graph，edit 后无 impact hint。

### 设计

**数据流：** edit/write 执行后 → 查 reverse dependency → 生成 impact hint → 注入 volatile context → evidence badge 列出 impacted。

#### 3.1 ImportGraph

文件：`src/agent/import-graph.ts`

轻量静态 import graph，正则提取，无外部依赖。

```typescript
export interface ImportGraph {
  // forward: file → files it imports
  forward: Map<string, Set<string>>
  // reverse: file → files that import it
  reverse: Map<string, Set<string>>
}

export function buildImportGraph(cwd: string, maxFiles?: number): ImportGraph | null
export function getReverseDeps(graph: ImportGraph, file: string): Set<string>
export function invalidateFile(graph: ImportGraph, cwd: string, file: string): ImportGraph
```

提取规则（正则）：
- `import ... from './xxx'` / `import ... from "../xxx"`
- `require('./xxx')` / `require("../xxx")`
- 路径解析：相对路径 → 基于 cwd 的绝对路径，补全 `.ts`/`.tsx`/`.js` 后缀

缓存策略：
- 首次 edit/write 时 lazy 构建
- 每次 edit/write 后 `invalidateFile()` 增量更新变更文件
- 最大 1000 文件，超出返回 null（防大仓库）

#### 3.2 ImpactHint

文件：`src/agent/impact-hint.ts`

edit/write 工具执行后生成 impact hint。

```typescript
export interface ImpactHint {
  changedFile: string
  impactedFiles: string[]
  relatedTests: string[]
  summary: string
}

export function generateImpactHint(
  graph: ImportGraph | null,
  changedFile: string,
  cwd: string,
): ImpactHint | null
```

逻辑：
1. `getReverseDeps(graph, changedFile)` → 直接依赖方
2. 对每个依赖方调用 `findTestsForSource()` 查关联测试
3. 生成 summary：`"Changed: loop.ts → Impacts: coordinator.ts, app.tsx → Tests: coordinator.test.ts"`

#### 3.3 Agent Loop 集成

文件：`src/agent/loop.ts` 修改

在 edit_file / write_file 的 PostToolUse 路径中：
1. 如果 ImportGraph 未构建且文件数 ≤ 1000，lazy 构建
2. 调用 `generateImpactHint()`
3. 如果返回非 null：
   - 注入 volatile context（`<impact_hint>` XML block）
   - 更新 `EvidenceState.impactedFiles`
4. 如果文件已存在 graph 中，`invalidateFile()` 增量更新

EvidenceState 扩展：

```typescript
export interface EvidenceState {
  filesRead: Set<string>
  filesModified: Set<string>
  verifications: VerificationMetadata[]
  deliveryStatus: DeliveryVerificationStatus
  impactedFiles: Set<string>      // 新增
  impactedTests: Set<string>      // 新增
}
```

#### 3.4 Evidence Badge 集成

文件：`src/agent/evidence.ts` 修改

`buildBadge()` 末尾追加：

```typescript
if (this.state.impactedFiles.size > 0) {
  parts.push(`- **Impacted files**: ${[...this.state.impactedFiles].join(', ')}`)
}
if (this.state.impactedTests.size > 0) {
  parts.push(`- **Tests to verify**: ${[...this.state.impactedTests].join(', ')}`)
}
```

#### 3.5 Cockpit 集成

VerificationPanel 增加一行 `Impacts: N files │ N tests to run`。
数据从 CockpitSnapshot.verification 扩展传入：

```typescript
verification: {
  ...
  impactedFiles: number
  impactedTests: number
}
```

### 不做的事

- 不做 AST 解析（Tree-sitter 太重）
- 不做 symbol-level graph（file-level 足够）
- 不做 graph 持久化（进程内缓存）
- 不做跨 repo import 追踪
- 不引入外部 npm 依赖（dependency-tree / dpdm）

---

## 文件结构总览

### 新建
| 文件 | 职责 |
|------|------|
| `src/model/task-inferrer.ts` | Task type 推断（纯函数） |
| `src/model/routing-metrics.ts` | Routing 事件记录 |
| `src/mcp/failure-classifier.ts` | MCP 错误分类 |
| `src/tui/cockpit/mcp-panel.tsx` | MCP cockpit 面板 |
| `src/agent/import-graph.ts` | 轻量 import graph |
| `src/agent/impact-hint.ts` | Edit impact 生成 |

### 修改
| 文件 | 变更 |
|------|------|
| `src/agent/loop.ts` | Turn-level routing + impact hint 注入 |
| `src/agent/evidence.ts` | impactedFiles/Tests 追踪 |
| `src/mcp/wrapper.ts` | 错误分类 + retry + 来源标注 |
| `src/mcp/types.ts` | McpConnectionState 扩展 |
| `src/tui/cockpit/types.ts` | Panel 增加 mcp，各 snapshot 扩展 |
| `src/tui/cockpit/state.ts` | Snapshot 增加新字段 |
| `src/tui/cockpit/model-panel.tsx` | routingReason 显示 |
| `src/tui/cockpit/verification-panel.tsx` | impact count 显示 |
| `src/tui/app.tsx` | MCP panel 路由 |

### 测试
| 文件 | 覆盖 |
|------|------|
| `src/model/__tests__/task-inferrer.test.ts` | 5 条推断规则 + 默认 |
| `src/model/__tests__/routing-metrics.test.ts` | record/getStats |
| `src/mcp/__tests__/failure-classifier.test.ts` | 5 种错误分类 |
| `src/agent/__tests__/import-graph.test.ts` | build/reverseDeps/invalidate |
| `src/agent/__tests__/impact-hint.test.ts` | hint 生成 |

---

## 依赖关系

三个子系统完全独立，可并行实现：
- Model Routing 只改 `src/model/` + `loop.ts` + `model-panel.tsx`
- MCP Integration 只改 `src/mcp/` + `mcp-panel.tsx` + `types.ts`
- Repo Intelligence 只改 `src/agent/import-graph.ts` + `loop.ts` + `evidence.ts`

唯一共享修改点是 `loop.ts`（三组都会碰），需要按顺序或合并处理。
