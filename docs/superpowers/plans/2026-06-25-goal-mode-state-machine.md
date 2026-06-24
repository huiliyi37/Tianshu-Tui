# GoalMode 状态机升级计划

> **面向 AI 代理：** 使用 `executing-plans` 逐任务实现。

**目标：** 把现有的二元 active/inactive GoalTracker 升级为 active/paused/blocked/complete 四态有限状态机，加入 wall-clock 预算、模型自主控制工具、持久化恢复能力。

**架构：** 在现有 GoalTracker 类上扩展状态模型，保留已有的 goal-judge/criteria-extraction/doom-loop 集成不变。新增 `UpdateGoal` 工具让模型自主声明 paused/blocked/complete。持久化通过 session 目录下的 `.goal.json` 实现，session 恢复时自动降级 active→paused。

**技术栈：** TypeScript strict, node:test + assert/strict

---

## 背景：为什么需要这个

当前 GoalTracker 是二元状态——要么 active 要么死亡。一旦 budget_exhausted 或 context_limit 触发，目标永久丢失，没有恢复路径。对比 kimi-code 的 GoalMode：active/paused/blocked/complete 四态，paused 和 blocked 都可 resume，进程崩溃后 active 自动降级为 paused。

天枢已有的优势保留：goal-judge 独立验证（kimi-code 没有）、criteria extraction、doom-loop 阈值放宽。

## 当前系统调研

### 现有文件和类型

| 文件 | 职责 | 关键类型 |
|------|------|----------|
| `src/agent/goal-tracker.ts` | GoalTracker 类，161 行 | `GoalTrackerConfig`, `GoalCheckResult`, `GoalDeactivationReason` |
| `src/agent/turn-orchestrator.ts:854-950` | goal continuation 检查循环 | 读 `goalTracker.check()` 决定 isFinal |
| `src/agent/loop.ts:659-668` | setGoalTracker/isGoalActive | 暴露给 loop-factory 和 doom-loop |
| `src/agent/loop-factory.ts:194` | isGoalActive 注入 prompt engine | |
| `src/agent/deliver-task.ts:649-664` | goal active 时抑制 review，achieved 时升级 L3 | |
| `src/tui/slash-commands.ts:510-572` | /goal 和 /cancel-goal 入口 | |
| `src/agent/goal-judge.ts` | completion judge（保留不动） | |
| `src/agent/goal-criteria.ts` | criteria extraction（保留不动） | |

### 现有消费方枚举（isGoalActive / goalTracker 调用点）

- `turn-orchestrator.ts:859` — `tracker.isActive()` + `tracker.check()`
- `turn-orchestrator.ts:873-898` — `tracker.advanceIteration()` / `tracker.deactivate()`
- `loop.ts:667` — `goalTracker?.isActive()`
- `loop.ts:851` — `goalTracker?.isActive()` (doom-loop 阈值)
- `loop.ts:896` — `isGoalActive()` (reliability mode)
- `loop-factory.ts:194` — `isGoalActive()` (prompt engine)
- `deliver-task.ts:649` — `isGoalActive?.()` (review 抑制)
- `deliver-task.ts:651` — `isGoalAchieved?.()` (L3 触发)
- `deliver-task.ts:664` — `goalActive` flag
- `tool-execution.ts:197,266` — `isGoalActive` (pipeline 注入)
- `tool-pipeline.ts:208` — `isGoalActive` (risk 评估)
- `slash-commands.ts:525,567` — `setGoalTracker()` / `setGoalTracker(null)`

---

## 任务

### 任务 1：GoalTracker 状态机核心升级

- [x] 创建 `src/agent/goal-state.ts` — 状态类型和持久化接口
- [x] 修改 `src/agent/goal-tracker.ts` — 替换 `_active` 为 `_status`，新增 paused/blocked/complete 转换
- [x] 创建 `src/agent/__tests__/goal-state.test.ts` — 状态机转换测试
- [x] 修改 `src/agent/__tests__/goal-tracker.test.ts` — 适配新 API

**目标：** GoalTracker 从二元 active/inactive 升级为 active/paused/blocked/complete 四态 FSM。这是纯类型+逻辑变更，不涉及 I/O。

**调研背书：**
- `_active: boolean`（goal-tracker.ts:60）：13 处调用方读 `isActive()`。修改策略：`isActive()` 语义不变（仅 active 时 true），所有调用方行为不变。
- `deactivate(reason)`（goal-tracker.ts:148）：3 处调用（turn-orchestrator 的 achieved/budget/context 路径）。修改策略：保留 `deactivate()` 作为内部实现细节，公开 `pause()/markBlocked()/markComplete()/cancel()` 四个语义方法。
- `GoalCheckResult.reason`（goal-tracker.ts:51）：消费方 turn-orchestrator 做 switch 分支。新增 reason 值需同步更新 switch。

**实现：**

`src/agent/goal-state.ts`:
```typescript
/** Goal lifecycle status — mirrors kimi-code's GoalStatus with Tianshu extensions. */
export type GoalStatus = 'active' | 'paused' | 'blocked' | 'complete'

/** Who triggered a status transition. */
export type GoalActor = 'user' | 'model' | 'runtime'

/** Budget limits for a goal. undefined = unlimited on that dimension. */
export interface GoalBudgetLimits {
  readonly maxIterations: number
  readonly contextWindow: number
  readonly wallClockMs?: number
}

/** Serializable goal state for persistence. */
export interface GoalStateRecord {
  readonly goalId: string
  readonly objective: string
  readonly status: GoalStatus
  readonly iterationsUsed: number
  readonly wallClockAccumMs: number
  readonly budgetLimits: GoalBudgetLimits
  readonly terminalReason?: string
  readonly completionCriterion?: string
  readonly savedAt: number
}

/** Transitions that the FSM allows. Anything else throws. */
export function validateTransition(from: GoalStatus, to: GoalStatus): boolean {
  const ALLOWED: Record<GoalStatus, readonly GoalStatus[]> = {
    active: ['paused', 'blocked', 'complete'],
    paused: ['active'],
    blocked: ['active'],
    complete: [],  // terminal — no outgoing
  }
  return ALLOWED[from]?.includes(to) ?? false
}
```

`src/agent/goal-tracker.ts` 变更（增量，保留所有现有字段和方法）:

```typescript
// 新增 import
import type { GoalStatus, GoalActor, GoalBudgetLimits, GoalStateRecord } from './goal-state.js'
import { validateTransition } from './goal-state.js'
import { randomUUID } from 'crypto'

// _active 替换为：
private _status: GoalStatus = 'active'  // 构造时设为 active

// 新增字段
private readonly _goalId: string
private readonly _wallClockBudgetMs?: number
private _wallClockAccumMs = 0
private _wallClockResumedAt: number  // Date.now() at construction
private _terminalReason: string | null = null

// 构造函数扩展
constructor(config: GoalTrackerConfig) {
  // ...现有字段不变...
  this._goalId = randomUUID()
  this._wallClockBudgetMs = config.wallClockMs
  this._wallClockResumedAt = Date.now()
}

// isActive() 不变（仅 active 时 true）
isActive(): boolean {
  return this._status === 'active'
}

// 新增状态查询
getStatus(): GoalStatus {
  return this._status
}

getGoalId(): string {
  return this._goalId
}

// 新增 wall-clock 查询
getWallClockElapsedMs(): number {
  if (this._status === 'active') {
    return this._wallClockAccumMs + (Date.now() - this._wallClockResumedAt)
  }
  return this._wallClockAccumMs
}

// 四个语义化状态转换方法
pause(reason?: string, actor: GoalActor = 'runtime'): void {
  this.transitionTo('paused', actor)
  this._terminalReason = reason ?? `Paused by ${actor}`
  this.foldWallClock()  // 把当前 active 间隔折叠到累计值
}

markBlocked(reason: string, actor: GoalActor = 'model'): void {
  this.transitionTo('blocked', actor)
  this._terminalReason = reason
  this.foldWallClock()
}

markComplete(actor: GoalActor = 'model'): void {
  this.transitionTo('complete', actor)
  this.foldWallClock()
}

resume(actor: GoalActor = 'user'): void {
  this.transitionTo('active', actor)
  this._wallClockResumedAt = Date.now()
  this._terminalReason = null
}

cancel(): void {
  // 取消 = 直接 detach，与现有 setGoalTracker(null) 等效
  this._status = 'complete'  // prevent continuation
  this._terminalReason = 'cancelled'
}

// 内部转换守卫
private transitionTo(target: GoalStatus, _actor: GoalActor): void {
  if (!validateTransition(this._status, target)) {
    throw new Error(`Invalid goal transition: ${this._status} → ${target}`)
  }
  this._status = target
}

// wall-clock 折叠
private foldWallClock(): void {
  if (this._status === 'active') {
    this._wallClockAccumMs += Date.now() - this._wallClockResumedAt
  }
}

// check() 扩展：新增 wall-clock 预算检查
check(streamedText: string, estimatedTokens: number, aborted: boolean): GoalCheckResult {
  if (this._status !== 'active') {
    return { shouldContinue: false, reason: 'no_goal', iteration: this._iteration }
  }
  if (aborted) {
    return { shouldContinue: false, reason: 'no_goal', iteration: this._iteration }
  }
  // 现有 regex 检测不变
  if (/GOAL ACHIEVED|目标已?完成|任务已?完成/i.test(streamedText)) {
    return { shouldContinue: false, reason: 'achieved', iteration: this._iteration }
  }
  // 现有 iteration 预算
  if (this._iteration >= this._maxIterations) {
    return { shouldContinue: false, reason: 'budget_exhausted', iteration: this._iteration }
  }
  // 现有 context 预算
  if (estimatedTokens > this._contextWindow * 0.95) {
    return { shouldContinue: false, reason: 'context_limit', iteration: this._iteration }
  }
  // 新增 wall-clock 预算
  if (this._wallClockBudgetMs !== undefined && this.getWallClockElapsedMs() >= this._wallClockBudgetMs) {
    return { shouldContinue: false, reason: 'wall_clock_exhausted', iteration: this._iteration }
  }
  return { shouldContinue: true, reason: 'continue', iteration: this._iteration }
}

// 持久化序列化
toRecord(): GoalStateRecord {
  this.foldWallClock()
  return {
    goalId: this._goalId,
    objective: this._goal,
    status: this._status,
    iterationsUsed: this._iteration,
    wallClockAccumMs: this._wallClockAccumMs,
    budgetLimits: {
      maxIterations: this._maxIterations,
      contextWindow: this._contextWindow,
      ...(this._wallClockBudgetMs !== undefined ? { wallClockMs: this._wallClockBudgetMs } : {}),
    },
    ...(this._terminalReason ? { terminalReason: this._terminalReason } : {}),
    ...(this._successCriteria.length > 0 ? { completionCriterion: this._successCriteria.join('\n') } : {}),
    savedAt: Date.now(),
  }
}

// 持久化反序列化（静态工厂）
static fromRecord(record: GoalStateRecord, extra?: { successCriteria?: string[]; maxJudgeRuns?: number }): GoalTracker {
  const tracker = new GoalTracker({
    goal: record.objective,
    maxIterations: record.budgetLimits.maxIterations,
    contextWindow: record.budgetLimits.contextWindow,
    ...(record.budgetLimits.wallClockMs !== undefined ? { wallClockMs: record.budgetLimits.wallClockMs } : {}),
    ...(record.completionCriterion ? { successCriteria: record.completionCriterion.split('\n') } : {}),
    ...(extra?.successCriteria ? { successCriteria: extra.successCriteria } : {}),
    ...(extra?.maxJudgeRuns !== undefined ? { maxJudgeRuns: extra.maxJudgeRuns } : {}),
  })
  // 恢复状态
  tracker._goalId = record.goalId
  tracker._iteration = record.iterationsUsed
  tracker._wallClockAccumMs = record.wallClockAccumMs
  // normalizeAfterResume: active → paused (kimi-code 模式)
  tracker._status = record.status === 'active' ? 'paused' : record.status
  tracker._terminalReason = record.status === 'active' ? 'Paused after session resume' : record.terminalReason
  return tracker
}
```

`GoalTrackerConfig` 扩展：
```typescript
export interface GoalTrackerConfig {
  goal: string
  maxIterations: number
  contextWindow: number
  successCriteria?: string[]
  maxJudgeRuns?: number
  wallClockMs?: number  // 新增：wall-clock 预算（毫秒）
}
```

`GoalCheckResult.reason` 扩展：
```typescript
export interface GoalCheckResult {
  shouldContinue: boolean
  reason: 'achieved' | 'budget_exhausted' | 'context_limit' | 'wall_clock_exhausted' | 'continue' | 'no_goal'
  iteration: number
}
```

`buildGoalModePrompt` 扩展（告知模型新的控制工具）：
```typescript
export function buildGoalModePrompt(goal: string): string {
  return `[GOAL MODE] ${goal}\n\nYou are now in goal-driven mode. Work toward this goal continuously. When fully complete, output "GOAL ACHIEVED" on its own line. If you encounter a blocker you cannot resolve, output "GOAL BLOCKED" on its own line followed by a brief explanation.`
}
```

**验证：**
```bash
npx tsc --noEmit
npm exec -- tsx --test src/agent/__tests__/goal-state.test.ts
npm exec -- tsx --test src/agent/__tests__/goal-tracker.test.ts
```

**提交：**
```
feat(agent): upgrade GoalTracker to 4-state FSM (active/paused/blocked/complete)
```

---

### 任务 2：UpdateGoal 工具——模型自主状态控制

- [x] 创建 `src/tools/update-goal.ts` — UpdateGoal 工具定义
- [x] 创建 `src/tools/__tests__/update-goal.test.ts` — 工具测试
- [ ] 修改 `src/tools/default-registry.ts` — 注册工具（**偏离：改为在 bootstrap.ts + main.ts 注册，用了闭包模式而非 default-registry**）
- [x] 修改 `src/main.tsx` — 注册工具（实际为 `src/main.ts`，headless 路径注册了 createUpdateGoalTool）

**目标：** 让模型通过工具调用主动声明 paused/blocked/complete，而不是只能靠 regex 输出 "GOAL ACHIEVED"。

**调研背书：**
- 工具注册路径：`default-registry.ts` 负责组装默认工具集。新工具加在这里。
- GoalTracker 通过 `ctx.agent` 可达——但工具上下文没有直接 agent 引用。需要通过 ToolExecContext 传 `goalTracker` 引用或回调。
- 现有模式：deliver_task 通过 `ctx.isGoalActive()` / `ctx.isGoalAchieved()` 读 goal 状态。写入需要新增 `ctx.updateGoalStatus` 回调。

**实现：**

`src/tools/update-goal.ts`:
```typescript
import { z } from 'zod'
import type { ToolDefinition, ToolResult } from './types.js'
import type { GoalStatus } from '../agent/goal-state.js'

const updateGoalSchema = z.object({
  status: z.enum(['paused', 'blocked', 'complete']).describe(
    'The lifecycle status to set for the current goal. Use "complete" when all work is done. Use "blocked" when an external condition prevents progress. Use "paused" only when you need user input.'
  ),
  reason: z.string().optional().describe('Brief explanation of why this status is being set.'),
})

export const updateGoalTool: ToolDefinition = {
  name: 'update_goal',
  description: 'Update the current goal lifecycle status. Only available when a goal is active. Use this to signal completion, report a blocker, or request a pause for user input.',
  parameters: updateGoalSchema,
  async execute(args, ctx): Promise<ToolResult> {
    const updateGoalStatus = (ctx as any).updateGoalStatus as
      | ((status: GoalStatus, reason?: string) => { ok: boolean; message: string })
      | undefined
    if (!updateGoalStatus) {
      return { content: 'No active goal to update.', isError: true }
    }
    const result = updateGoalStatus(args.status as GoalStatus, args.reason)
    return {
      content: result.message,
      ...(result.ok ? {} : { isError: true }),
    }
  },
}
```

`src/agent/tool-execution.ts` 扩展 `ToolExecContext`:
```typescript
// 在 ToolExecContext 接口新增（约 line 100 附近）：
/** Update the active goal's status. Only valid when a goal is active. */
updateGoalStatus?: (status: import('../agent/goal-state.js').GoalStatus, reason?: string) => { ok: boolean; message: string }
```

`src/agent/loop-factory.ts` 注入回调（在 deps 对象里，约 line 194 附近）:
```typescript
updateGoalStatus: (status, reason) => {
  return self.handleUpdateGoalStatus(status, reason)
},
```

`src/agent/loop.ts` 新增方法:
```typescript
handleUpdateGoalStatus(status: GoalStatus, reason?: string): { ok: boolean; message: string } {
  const tracker = this.turnOrchestrator.goalTracker
  if (!tracker) {
    return { ok: false, message: 'No active goal.' }
  }
  if (tracker.getStatus() !== 'active') {
    return { ok: false, message: `Goal is ${tracker.getStatus()}, cannot update.` }
  }
  try {
    if (status === 'complete') tracker.markComplete('model')
    else if (status === 'blocked') tracker.markBlocked(reason ?? 'Blocked by model', 'model')
    else if (status === 'paused') tracker.pause(reason ?? 'Paused by model', 'model')
    else return { ok: false, message: `Cannot set status to ${status} via UpdateGoal.` }
    return { ok: true, message: `Goal status updated to ${status}.` }
  } catch (e) {
    return { ok: false, message: `Transition failed: ${(e as Error).message}` }
  }
}
```

`src/tools/default-registry.ts` 注册:
```typescript
import { updateGoalTool } from './update-goal.js'
// 在工具数组中加入：
updateGoalTool,
```

**验证：**
```bash
npx tsc --noEmit
npm exec -- tsx --test src/tools/__tests__/update-goal.test.ts
```

测试要点：
- 无 goal 时调用 → isError: true
- goal active 时调用 status='blocked' → tracker.getStatus() === 'blocked'
- goal active 时调用 status='complete' → tracker.getStatus() === 'complete'
- goal active 时调用 status='paused' → tracker.getStatus() === 'paused'
- 非法转换（如 complete→active）→ isError: true

**提交：**
```
feat(tools): add UpdateGoal tool for model-driven goal lifecycle control
```

---

### 任务 3：Turn-orchestrator 集成——暂停/阻断/恢复的 continuation 逻辑

- [x] 修改 `src/agent/turn-orchestrator.ts:854-950` — 适配新状态模型（保留 deactivate() 兼容调用，通过向后兼容映射正确工作）
- [x] 修改 `src/agent/turn-orchestrator.ts` — 新增 wall_clock_exhausted reason 处理（映射到 budget_exhausted deactivation）+ continuation 消息加 wall-clock 信息和 GOAL BLOCKED 提示
- [x] 修改 `src/agent/__tests__/turn-orchestrator-goal.test.ts`（现有测试 11/11 通过，未需新建）

**目标：** turn-orchestrator 的 goal continuation 检查正确处理 paused/blocked/complete/wall_clock_exhausted 四种新情况。

**调研背书：**
- `turn-orchestrator.ts:859-898`：现有逻辑分三个分支：continue / achieved (走 judge) / else (deactivate)。需要扩展 else 分支。
- `tracker.deactivate(reason)` 现有3处调用（achieved/budget/context 路径）——改为语义方法后，budget_exhausted → markBlocked, context_limit → pause, wall_clock → markBlocked。
- achieved 路径的 goal-judge 逻辑完全保留不变。

**实现：**

`turn-orchestrator.ts:854-950` 变更（差异部分）：

```typescript
// 现有逻辑（保留不变的部分省略）...
// 关键变更在 else 分支：

} else {
  // budget/context/wall-clock: 转换到适当的非活跃状态
  if (goalResult.reason === 'budget_exhausted') {
    tracker.markBlocked('Iteration budget exhausted', 'runtime')
  } else if (goalResult.reason === 'context_limit') {
    tracker.pause('Context window 95% reached', 'runtime')
  } else if (goalResult.reason === 'wall_clock_exhausted') {
    tracker.markBlocked('Wall-clock budget exhausted', 'runtime')
  } else {
    tracker.cancel()
  }
}
```

**注意**：`tracker.deactivate()` 不再直接调用。现有 `_deactivationReason` 字段被 `_terminalReason` 替代。`isGoalAchieved()` 改为 `getStatus() === 'complete'`。

deliver-task.ts 适配：
```typescript
// deliver-task.ts:651 现有：
const goalAchieved = ctx.isGoalAchieved?.() === true
// 改为：
const goalAchieved = ctx.getGoalStatus?.() === 'complete'
```

loop.ts 适配：
```typescript
// isGoalAchieved 方法改为：
isGoalAchieved(): boolean {
  return this.turnOrchestrator.goalTracker?.getStatus() === 'complete'
}
```

**验证：**
```bash
npx tsc --noEmit
npm exec -- tsx --test src/agent/__tests__/goal-tracker.test.ts
npm exec -- tsx --test src/agent/__tests__/repair-parity.test.ts  # 确保 deliver_task 集成未断
```

**提交：**
```
refactor(agent): adapt turn-orchestrator to 4-state goal FSM
```

---

### 任务 4：持久化——goal 状态文件

- [x] 创建 `src/agent/goal-persist.ts` — save/load/delete goal state
- [x] 创建 `src/agent/__tests__/goal-persist.test.ts` — 持久化测试
- [ ] 修改 `src/agent/loop.ts` — 定期保存 + normalizeAfterResume（**未完成：loop.ts 中的定期保存调用未接线**）
- [ ] 修改 `src/main.tsx` 和 `src/tui/slash-commands.ts` — 启动时恢复 goal（**未完成：bootstrap/main.ts resume 路径的 restoreGoalTracker 调用未接线**）

**目标：** goal 状态持久化到 `<session-dir>/<id>.goal.json`，session 恢复时自动降级 active→paused。

**调研背书：**
- 持久化路径模式：`session-persist.ts:169` 用 `join(getSessionDir(cwd), '${sessionId}.meta.json')`。goal 状态文件用同目录 `${sessionId}.goal.json`。
- SessionPersist 使用 `writeFileAtomicSync`（fs-atomic.ts）。复用同一原子写入。
- Session 恢复入口：`session-registry.ts` 的 resume 路径 + `main.tsx` 启动流程。

**实现：**

`src/agent/goal-persist.ts`:
```typescript
import { join } from 'path'
import { writeFileAtomicSync } from '../fs-atomic.js'
import { readFileSync, existsSync, unlinkSync } from 'fs'
import type { GoalStateRecord } from './goal-state.js'
import { GoalTracker } from './goal-tracker.js'
import type { GoalTrackerConfig } from './goal-tracker.js'

export function goalStatePath(sessionDir: string, sessionId: string): string {
  return join(sessionDir, `${sessionId}.goal.json`)
}

export function saveGoalState(sessionDir: string, sessionId: string, tracker: GoalTracker): void {
  const record = tracker.toRecord()
  writeFileAtomicSync(goalStatePath(sessionDir, sessionId), JSON.stringify(record, null, 2) + '\n')
}

export function loadGoalState(sessionDir: string, sessionId: string): GoalStateRecord | null {
  const path = goalStatePath(sessionDir, sessionId)
  if (!existsSync(path)) return null
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as GoalStateRecord
  } catch {
    return null
  }
}

export function deleteGoalState(sessionDir: string, sessionId: string): void {
  const path = goalStatePath(sessionDir, sessionId)
  if (existsSync(path)) {
    unlinkSync(path)
  }
}

/** 恢复 goal tracker：active→paused 自动降级（normalizeAfterResume）。 */
export function restoreGoalTracker(
  sessionDir: string,
  sessionId: string,
  config: Pick<GoalTrackerConfig, 'maxJudgeRuns'>,
): GoalTracker | null {
  const record = loadGoalState(sessionDir, sessionId)
  if (!record) return null
  if (record.status === 'complete') return null  // 已完成不恢复
  // fromRecord 内部执行 normalizeAfterResume（active→paused）
  return GoalTracker.fromRecord(record, config)
}
```

`src/main.tsx` 和 `slash-commands.ts` 集成点：
- `/goal` 启动时：创建 tracker 后调用 `saveGoalState`
- continuation 每轮结束后：调用 `saveGoalState` 更新迭代计数
- `/cancel-goal`：调用 `deleteGoalState`
- session resume：调用 `restoreGoalTracker`，如果返回非 null 则 `agent.setGoalTracker(tracker)` 并提示用户 "目标已恢复（暂停状态），使用 /goal-resume 继续"

**验证：**
```bash
npx tsc --noEmit
npm exec -- tsx --test src/agent/__tests__/goal-persist.test.ts
```

测试要点：
- save → load 往返一致
- active 状态保存后 load，状态降级为 paused
- complete 状态保存后 restoreGoalTracker 返回 null
- 文件不存在时 load 返回 null

**提交：**
```
feat(agent): add goal state persistence with normalizeAfterResume
```

---

### 任务 5：Slash 命令和 Prompt 更新

- [x] 修改 `src/tui/slash-commands.ts` — 新增 `/goal-resume`，更新 `/goal` 和 `/cancel-goal`
- [ ] 修改 `src/prompt/volatile.ts` — goal continuation 提示更新（**未完成：volatile.ts 未改动，continuation 提示更新已在 turn-orchestrator.ts 内联完成**）
- [x] 修改 `src/tui/slash-commands.ts` — `/goal` 显示 wall-clock 预算信息（通过 /goal-resume 显示）+ command-palette.tsx 注册 /goal-resume

**目标：** 用户 UI 适配新状态——可以 resume 暂停的目标，可以看到 wall-clock 预算消耗。

**调研背书：**
- slash-commands.ts:510-572：现有 /goal 和 /cancel-goal 实现。
- volatile.ts:27-32：plan-methodology route 注入。goal continuation 提示在 turn-orchestrator.ts:910-918（`[GOAL CONTINUATION]` 消息）。

**实现：**

`slash-commands.ts` 新增 `/goal-resume`:
```typescript
case '/goal-resume': {
  const tracker = ctx.goalTrackerRef?.current
  if (!tracker) {
    pushStatic(createLogEntry({ type: 'system', content: 'No paused or blocked goal to resume.' }))
    setIsStreaming(false)
    return true
  }
  const status = tracker.getStatus()
  if (status !== 'paused' && status !== 'blocked') {
    pushStatic(createLogEntry({ type: 'system', content: `Goal is ${status}, cannot resume.` }))
    setIsStreaming(false)
    return true
  }
  tracker.resume('user')
  pushStatic(createLogEntry({ type: 'system', content: `▶️ Goal resumed: ${tracker.getGoal()}\nIteration: ${tracker.getIteration()}/${tracker.getMaxIterations()}\nWall-clock: ${Math.round(tracker.getWallClockElapsedMs() / 1000)}s elapsed.` }))
  ctx.submitToAgent?.(`[GOAL RESUME] 继续执行目标: ${tracker.getGoal()}`)
  return true
}
```

更新 `/goal` 显示：
```typescript
// /goal 激活时增加 wall-clock 提示
const wallClockBudget = ctx.agent.config.goalWallClockMs  // 可选配置
const tracker = new GoalTracker({
  goal: goalText,
  maxIterations,
  contextWindow: ctx.maxTokens,
  maxJudgeRuns: ctx.agent.config.goalJudge?.maxRuns,
  ...(wallClockBudget ? { wallClockMs: wallClockBudget } : {}),
})
// 提示信息增加：
// `Wall-clock budget: ${wallClockBudget ? Math.round(wallClockBudget / 60000) + 'min' : 'unlimited'}`
// `Output "GOAL ACHIEVED" to complete, "GOAL BLOCKED" to report a blocker.`
// `Cancel with /cancel-goal. Pause/resume with the system or /goal-resume.`
```

turn-orchestrator.ts 的 continuation 提示更新：
```typescript
// 现有（turn-orchestrator.ts:910-918）：
this.deps.appendSystemReminder(
  `[GOAL CONTINUATION ${iter}/${maxIter}] 目标尚未达成。继续执行。\n` +
  `目标: ${tracker!.getGoal()}\n` +
  `上轮输出摘要: ${this.deps.getStreamedText().slice(-500)}\n` +
  `完成后输出 "GOAL ACHIEVED" 声明完成。`
)
// 新增 wall-clock 信息和 blocked 提示：
const wallClockElapsed = Math.round(tracker!.getWallClockElapsedMs() / 1000)
const wallClockBudget = tracker!.getWallClockBudgetMs()
const wallClockInfo = wallClockBudget
  ? ` | ⏱ ${wallClockElapsed}s/${Math.round(wallClockBudget / 1000)}s`
  : ` | ⏱ ${wallClockElapsed}s`
this.deps.appendSystemReminder(
  `[GOAL CONTINUATION ${iter}/${maxIter}${wallClockInfo}] 目标尚未达成。继续执行。\n` +
  `目标: ${tracker!.getGoal()}\n` +
  `上轮输出摘要: ${this.deps.getStreamedText().slice(-500)}\n` +
  `完成后输出 "GOAL ACHIEVED" 声明完成。遇到无法解决的阻塞时输出 "GOAL BLOCKED"。`
)
```

**验证：**
```bash
npx tsc --noEmit
npm exec -- tsx --test src/__tests__/headless.test.ts  # 确保现有 goal 入口不破
npm exec -- tsx --test src/agent/__tests__/goal-tracker.test.ts
```

**提交：**
```
feat(tui): add /goal-resume and wall-clock display to goal mode
```

---

### 任务 6：全量验证和回归测试

- [x] 运行 `npx tsc --noEmit` — 确保 0 错误
- [x] 运行 `npm exec -- tsx --test src/**/__tests__/*.test.ts` — 全量测试（148/148 goal 相关测试全绿；全量 agent 套件 320 fail 均来自 worktree-scope.test.ts 的 pre-existing EPERM）
- [ ] 手动验证：启动 agent，/goal 测试 → continuation → blocked → resume → complete 全流程（**未完成：未做端到端手动验证**）

**目标：** 确认所有现有集成（deliver-task、doom-loop、goal-judge、prompt engine）未断裂。

**验证命令：**
```bash
npx tsc --noEmit
npm exec -- tsx --test src/agent/__tests__/goal-tracker.test.ts
npm exec -- tsx --test src/agent/__tests__/goal-state.test.ts
npm exec -- tsx --test src/agent/__tests__/goal-persist.test.ts
npm exec -- tsx --test src/tools/__tests__/update-goal.test.ts
npm exec -- tsx --test src/__tests__/headless.test.ts
npm exec -- tsx --test src/agent/__tests__/repair-parity.test.ts
npm exec -- tsx --test src/__tests__/delegate-task.test.ts
# 全量
npm exec -- tsx --test src/**/__tests__/*.test.ts
```

**预期认知影响（prompt/agent 行为变更）：**
- `buildGoalModePrompt` 增加 "GOAL BLOCKED" 指令——模型获得了显式声明阻塞的能力，不再只靠"GOAL ACHIEVED"一个出口。
- `UpdateGoal` 工具——当 goal active 时，模型可以在工具调用中自主声明完成/阻塞/暂停，不需要在文本里输出特殊标记。
- continuation 提示新增 wall-clock 信息——模型能感知时间预算消耗。
- session 恢复后 goal 自动降级为 paused——需要用户 /goal-resume 显式恢复，避免进程崩溃后盲目继续。

---

## 状态转换图

```
                    createGoal / /goal
                          │
                          ▼
                       ┌────────┐
              ┌─────── │ active │ ────────┐
              │        └────────┘          │
              │           │  │             │
         pause()    complete()  markBlocked()
         (user/int    (model/     (model/
         errupt)      judge)      runtime)
              │           │             │
              ▼           ▼             ▼
         ┌────────┐  ┌──────────┐  ┌─────────┐
         │ paused │  │ complete │  │ blocked │
         └────────┘  └──────────┘  └─────────┘
              │        (terminal)        │
              │                          │
           resume()                   resume()
              │                          │
              └──────→ active ←──────────┘

  cancel() → detaches tracker entirely (setGoalTracker(null))
```

---

## 执行状态（2026-06-25 更新）

### 已完成（5 个提交）

| 提交 | 任务 | 文件 |
|------|------|------|
| `51a27f45` | 任务 1: FSM 核心 | goal-state.ts, goal-tracker.ts, goal-state.test.ts, goal-tracker.test.ts |
| `a131fbfa` | 任务 2: UpdateGoal 工具 | update-goal.ts, update-goal.test.ts, bootstrap.ts, main.ts |
| `e326b455` | 任务 3: turn-orchestrator | turn-orchestrator.ts |
| `6904c17e` | 任务 4: 持久化层 | goal-persist.ts, goal-persist.test.ts |
| `893563c5` | 任务 5: slash 命令 | slash-commands.ts, command-palette.tsx |

### 未完成（3 项）

1. **loop.ts 定期保存接线** — `saveGoalState` 在 turn-orchestrator 的 continuation 循环中未被调用。需要在每次 `advanceIteration()` 后或 turn 结束时调用 `saveGoalState(sessionDir, sessionId, tracker)`。涉及 loop.ts / turn-orchestrator.ts 需要获取 sessionDir 和 sessionId。
2. **bootstrap/main.ts resume 路径接线** — `restoreGoalTracker` 函数已实现但未接入 session resume 流程。需要在 bootstrap.ts 的 resume 路径（`switchAgentSession` 或 `bootstrapInteractiveSession` 的 wasSessionResumed 分支）中调用它，并将返回的 tracker 通过 `agent.setGoalTracker()` + `goalTrackerRef.current` 恢复。同时需要向用户显示 "目标已恢复（暂停状态），使用 /goal-resume 继续" 的提示。
3. **手动端到端验证** — 启动 agent 运行 /goal → continuation → blocked → resume → complete 全流程。

### 设计偏离

- **UpdateGoal 工具注册路径**：计划要求通过 `ToolExecContext` 传 `updateGoalStatus` 回调，但代码库没有 `ToolExecContext` 类型。实际用了 `deliver_task` 同款闭包模式（在注册时捕获 `goalTrackerRef`），零 pipeline 改动。
- **turn-orchestrator deactivate() 调用**：保留了 `deactivate()` 调用而非替换为语义方法（`pause()/markBlocked()/markComplete()`），因为任务 1 的向后兼容映射已正确工作。
- **main.tsx vs main.ts**：计划引用 `src/main.tsx`，实际入口是 `src/main.ts`（main.tsx 已从仓库移除）。
