# W3 深化：Approval Path B + /tasks + Worker Permission Badge

# W3 深化：Approval Path B + /tasks + Worker Permission Badge

> 2026-06-13 · `t9-ui-refactor` 分支  
> 前置：W3.1 (Ctrl+R) + W3.2 (worker pills) 已落地

---

## 1. 问题描述

W3 剩余三项都需要跨越 UI ↔ agent 边界，无法纯 UI 层完成：

### W3.3 — Approval Path B

当前审批流程：
1. agent 调用 `onApprovalRequired(id, name, input)` → UI 弹出 y/n 提示
2. UI 的 `handleApprovalRequired` 只返回 `boolean`（批准/拒绝）
3. `approval-edit.ts` 已定义 `ApprovalResult { approved, editedInput? }` 和 `applyApprovalEdit`
4. 但 `editedInput` 从未被填充 —— Path B 是死代码

**目标**：用户审批时可以编辑工具输入参数再批准。

### W3.4 — `/tasks` overlay

Claude Code 的 `/tasks` 显示所有后台运行 agent 的列表（profile、状态、耗时）。天枢当前：
- `pendingTools` 追踪进行中工具，但只限于主 agent 的工具调用
- 子代理状态通过 coordinator 内部管理，未暴露给 UI
- 没有"列出所有运行中 agent"的 API

**目标**：`/tasks` 打开 overlay，显示运行中 worker 列表。

### W3.5 — Worker permission badge

子代理通过 coordinator 派发时，审批设置（auto-safe / dangerously-skip-permissions）未 relay 给 worker：
- `WorkerSessionConfig` 无 `permissionLevel` / `approvalMode` 字段
- 主 agent 的审批策略不传递给子 agent
- UI 无法显示"此 worker 需要审批"的 badge

**目标**：coordinator → worker 权限 relay + UI badge 显示。

---

## 2. 事实流图

```mermaid
flowchart TD
    subgraph W33["W3.3: Approval Path B"]
        AG[agent 请求审批] --> UI_APPROVAL[UI: y/n/e 提示]
        UI_APPROVAL --> |e 键| EDIT[ApprovalEditOverlay]
        EDIT --> |编辑 input| RESULT[ApprovalResult.editedInput]
        RESULT --> APPLY[applyApprovalEdit]
        APPLY --> TOOL[tool-pipeline 使用编辑后 input]
    end

    subgraph W34["W3.4: /tasks overlay"]
        COORD[Coordinator] --> |暴露| RUNNING[getRunningWorkers API]
        RUNNING --> TASKS[/tasks overlay]
        TASKS --> RENDER[renderTasksList ANSI]
    end

    subgraph W35["W3.5: Worker permission badge"]
        MAIN[主 agent 审批模式] --> |relay| WS[WorkerSessionConfig.approvalMode]
        WS --> BADGE[footer pill badge]
        COORD --> |onActivity| BADGE
    end

    classDef agent fill:#0f172a,stroke:#818cf8,color:#e0e7ff
    classDef ui fill:#1e293b,stroke:#38bdf8,color:#e0f2fe
    class AG,COORD,MAIN agent
    class UI_APPROVAL,EDIT,TASKS,RENDER,BADGE ui
```

---

## 3. W3.3: Approval Path B — 详细设计

### 3.1 当前状态

```
approval-edit.ts:
  ApprovalResult { approved: boolean; editedInput?: Record<string,unknown> }
  applyApprovalEdit(input, result) → edited input or null

tui/engine/app.ts:
  handleApprovalRequired → Promise<ApprovalResult | boolean>
  → 当前只 resolve({ approved: true/false }), 从不返回 editedInput

tui/app.tsx (Ink):
  onApprovalRequired → Promise<boolean>  ← 类型窄化，失去 Path B
```

### 3.2 变更

#### A. `app.ts` — 审批模式扩展

审批提示行从 `[y] approve  [n] deny` 扩展为 `[y] approve  [n] deny  [e] edit`。

当用户按 `e`：
1. 进入 `approval-edit` 模式
2. 显示当前 tool 的 input JSON（格式化）
3. 用户可以用输入框编辑
4. Enter 提交编辑后 input → resolve `{ approved: true, editedInput: parsed }`
5. Esc 取消编辑 → 回到 y/n 提示

实现：在 `app.ts` 的审批态处理中加 `e` 分支，切换到 `approval-edit` 子模式。子模式下输入框的内容是 JSON 文本，Enter 时尝试 `JSON.parse`。

```typescript
// 审批态按键处理扩展
if (c === 'e') {
  this.input.setMode('input')  // 允许输入编辑
  this.approvalEditMode = true
  const prettyInput = JSON.stringify(this.approvalPending.input, null, 2)
  this.setInput(prettyInput)
  this.renderLive()
  return
}
// ...在 approval 模式的 Enter 处理中:
if (this.approvalEditMode) {
  try {
    const edited = JSON.parse(this.inputLine.value)
    this.approvalEditMode = false
    this.resolveApproval({ approved: true, editedInput: edited })
  } catch {
    // JSON 解析失败，保持编辑模式
  }
}
```

#### B. 审批提示行渲染更新

```
 ╭─ Approval Required ──────────────────────────────
 │ Tool: write_file
 │ Input: {"file_path":"src/foo.ts","content":"..."}
 ╰─ [y] approve  [n] deny  [e] edit ────────────────
```

编辑模式时：
```
 ╭─ Edit Tool Input ────────────────────────────────
 │ Edit the JSON below, then Enter to confirm:
 │ { "file_path": "src/foo.ts", ... }
 ╰─ Enter confirm  Esc cancel ──────────────────────
```

### 3.3 风险

- `JSON.parse` 失败时需妥善处理（保持编辑态，显示错误提示）
- 编辑模式与普通输入的 keybinding 冲突（Ctrl+C / Esc 语义需明确）

---

## 4. W3.4: `/tasks` overlay — 详细设计

### 4.1 当前状态

```
Coordinator:
  - 内部 `activeOrders: Map<string, WorkOrder>`
  - 无公开 API 暴露运行中 worker 列表

TuiApp:
  - pendingTools: 主 agent 的工具调用
  - 不感知 coordinator 的 worker 状态
```

### 4.2 变更

#### A. Coordinator 暴露 API

```typescript
// src/agent/coordinator.ts
interface RunningWorker {
  workOrderId: string
  profile: string
  objective: string
  startMs: number
  status: 'running' | 'waiting' | 'retrying'
}

getRunningWorkers(): RunningWorker[] {
  return [...this.activeOrders.entries()].map(([id, order]) => ({
    workOrderId: id,
    profile: order.profile ?? 'unknown',
    objective: order.objective.slice(0, 80),
    startMs: order.startMs ?? 0,
    status: order.status === 'completed' ? 'running' : 'running',
  }))
}
```

#### B. `/tasks` overlay

新 ANSI 渲染器 `src/tui/format/tasks.ts`：

```
┌─ ⚙ Running Agents ───────────────────────────────
│ ▶ patcher    Fix type errors in src/agent/loop.ts  (12s)
│ ▶ reviewer   Review commit 9b4524aa                (3s)
│ ○ code_scout Search for claim-store references      (pending)
│
│ 3 workers running
└──────────────────────────────────────────────────
```

#### C. 接线

- `slash-router.ts`: `/tasks` → `app.activateOverlay('tasks')`
- `app.ts`: register `tasks` overlay + `tasksData` provider
- `main.ts`: `tasksData` 从 coordinator 取 `getRunningWorkers()`

### 4.3 依赖

- Coordinator 需要暴露 `getRunningWorkers()` —— 纯 agent 层改动，不影响 UI
- 如果 coordinator 不可用（单 agent 模式），显示空列表

---

## 5. W3.5: Worker permission badge — 详细设计

### 5.1 当前状态

```
WorkerSessionConfig (src/agent/worker-session.ts):
  abortSignal?: AbortSignal
  reviewDepth?: number
  authority?: string
  // 无 permissionLevel / approvalMode

Coordinator.delegate():
  → 构造 WorkerSessionConfig 时无权限 relay
```

### 5.2 变更

#### A. WorkerSessionConfig 扩展

```typescript
interface WorkerSessionConfig {
  // ...现有字段...
  /** 审批模式：继承自主 agent */
  approvalMode?: 'auto-safe' | 'dangerously-skip-permissions'
}
```

#### B. Coordinator relay

```typescript
// coordinator.ts: delegate()
const workerConfig: WorkerSessionConfig = {
  // ...现有字段...
  approvalMode: this.approvalMode,  // 从主 agent 配置读取
}
```

#### C. UI badge

在 worker pills 中追加权限标记：

```
 ⚙ patcher (12s) [auto]    ← 无审批，安全
 ⚙ reviewer (3s)  [ask]    ← 需要审批
```

`[auto]` = dangerously-skip-permissions，绿色  
`[ask]` = auto-safe，黄色

在 `app.ts` 的 worker pills 渲染中读取 `pendingTools` 元数据中的 `approvalMode`（需要在 `pendingTools` Map 中存储此信息）。

### 5.3 轻量实现

由于 coordinator 的 `approvalMode` 需要从 bootstrap config 层传递，W3.5 的 MVP 可以更轻量：
- 在 `handleToolUse` 中，记录 delegation tool 的审批模式（从 ctx.config 读取）
- footer pills 渲染时显示 badge

---

## 6. 执行顺序

```
W3.3 (Path B) ──→ W3.4 (/tasks) ──→ W3.5 (badge)
    ↑                    ↑                ↑
  纯 UI 层          需 coordinator     需 coordinator
  app.ts 改动       暴露 API           relay + UI
```

**推荐**：W3.3 先做（纯 UI，不依赖 agent 层），W3.4 和 W3.5 一起做（都需要 coordinator 配合）。

---

## 7. 验证计划

| 项 | 测试 |
|----|------|
| W3.3 | 审批时按 e → 编辑 input → Enter 提交 → 工具使用编辑后参数 |
| W3.3 | 编辑时输入非法 JSON → 保持编辑态 → 错误提示 |
| W3.4 | `/tasks` 显示运行中 worker 列表 → worker 结束后消失 |
| W3.5 | 子代理派发时 footer pill 显示权限 badge |

---

## 8. 不做事项

- W3.3 不做完整 JSON Schema 校验（只做 `JSON.parse` + 基本类型检查）
- W3.4 不做 worker transcript 嵌入（那是 W4 的事）
- W3.5 不做 worker 独立审批流程 relay（子代理仍继承主 agent 的审批设置）
