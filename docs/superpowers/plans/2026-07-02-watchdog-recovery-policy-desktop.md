# WatchdogRecoveryPolicy 共享类提取 + 桌面端 session-manager 接线 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 把 TUI 已落地的 watchdog stall 自动恢复三件套（consecutive cap / session-total cap / 进度感知配额）提取为共享状态机，并接入桌面 sidecar 的 session-manager，让桌面端长跑不再在第一次 watchdog 误报就死掉。

**架构：** 新建纯状态机 `src/agent/watchdog-recovery-policy.ts`（无 UI / 无计时器 / 无 I/O），TuiApp 改为委托该类（行为零变化，现有 15 个 abort-resubmit 测试是提取正确性的守门员）；session-manager 在 `onAbort` 接住 reason、在 `run().finally` 之后经 `setImmediate` 延迟决策并复核用户是否抢跑，向事件流追加 `watchdog_recovery` 事件供桌面 UI 观测。

**技术栈：** TypeScript strict / node:test + node:assert/strict / 无新依赖。

**前置状态（已核实，2026-07-02）：**
- TUI 侧 v3 已完成并修正（提交 `05b8b32f` + `b6739aed`）：进度单元只计终态工具结果，不计流式 chunk。
- `AgentCallbacks.onAbort` 类型签名**本来就是** `(reason?: string) => void`（`src/agent/loop-types.ts:213`），session-manager 只是没接参数——不需要改回调类型。
- watchdog reason 标签来源：`loop.ts:785` `abortReason()` 返回 `'watchdog:goal'` / `'watchdog'` / `undefined`（用户中止）；convergence 家族走 `stopReasonAbortTag`（`'convergence'` / `'convergence:no-tool'`）。
- 桌面 event-reducer 对未知事件类型有 `default: return next` 兜底（`desktop/src/state/event-reducer.ts:535`），新增事件类型不会打坏旧桌面端。
- `RuntimeSessionManager` 构造参数有可注入 `now`（`session-manager.ts:388`），审批拒绝 grace 窗口测试不需要真实睡眠。

---

## 文件结构

| 文件 | 操作 | 职责 |
|---|---|---|
| `src/agent/watchdog-recovery-policy.ts` | 创建 | 共享状态机：三计数器 + onStall 决策，两端唯一语义来源 |
| `src/agent/__tests__/watchdog-recovery-policy.test.ts` | 创建 | 状态机单元测试（不依赖 TUI/server） |
| `src/tui/engine/app.ts` | 修改 | 删除三对私有计数器/常量，委托 policy；`_lastApprovalDeniedAt` + grace 窗口**留在 TuiApp**（抑制条件判定是调用方职责） |
| `src/server/session-manager.ts` | 修改 | `onAbort` 接 reason、进度计数接线、`run()` 生命周期挂 policy、finally 后延迟自动续跑、`watchdog_recovery` 事件 |
| `src/server/__tests__/session-manager.test.ts` | 修改 | FakeAgent 扩展（prompts 记录 + watchdogAbort helper）+ 桌面端恢复测试 |
| `desktop/src/runtime/types.ts` | 修改 | 事件类型 union 补 `'watchdog_recovery'`（仅类型同步，一行） |

**分工边界（为什么抑制条件不进 policy）：** 抑制来源两端不同——TUI 看输入框草稿 + 本地审批态 + 拒绝 grace 时间戳；桌面看 HTTP 审批 pending map + 自己的拒绝时间戳。policy 只接收布尔结论 `onStall({ suppressed })`，保证「抑制时不消耗任何状态」这一共享语义，判定本身留给调用方。这样 TUI 现有测试（包括直接回拨 `_lastApprovalDeniedAt` 的测试 D）零改动。

---

## 任务 1：WatchdogRecoveryPolicy 状态机（TDD）

**文件：**
- 创建：`src/agent/watchdog-recovery-policy.ts`
- 测试：`src/agent/__tests__/watchdog-recovery-policy.test.ts`

- [ ] **步骤 1：编写失败的测试**

```typescript
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { WatchdogRecoveryPolicy } from '../watchdog-recovery-policy.js'

describe('WatchdogRecoveryPolicy', () => {
  test('consecutive cap：无进度的连续 stall 第 4 次起停止，stopReason=consecutive', () => {
    const p = new WatchdogRecoveryPolicy()
    // 前 3 次续跑（每次都是密集 stall，同时消耗 session 配额）
    for (let i = 0; i < 3; i++) {
      const d = p.onStall()
      assert.equal(d.autoContinue, true, `第 ${i + 1} 次应续跑`)
      assert.equal(d.dense, true, '无进度 → 密集')
    }
    const d4 = p.onStall()
    assert.equal(d4.autoContinue, false)
    assert.equal(d4.stopReason, 'consecutive')
  })

  test('recordTurnComplete 重置 consecutive，恢复续跑预算', () => {
    const p = new WatchdogRecoveryPolicy()
    for (let i = 0; i < 3; i++) p.onStall()
    assert.equal(p.onStall().autoContinue, false)
    p.recordTurnComplete()
    assert.equal(p.onStall().autoContinue, true, 'turn 完成后应恢复预算')
  })

  test('recordUserSubmit 重置 consecutive 但不加进度', () => {
    const p = new WatchdogRecoveryPolicy()
    for (let i = 0; i < 3; i++) p.onStall()
    p.recordUserSubmit()
    const d = p.onStall()
    assert.equal(d.autoContinue, true)
    assert.equal(d.dense, true, 'user submit 不产生进度单元，stall 仍判密集')
  })

  test('session-total cap：tiny-turn 重置循环 12 次后停止，stopReason=session-total', () => {
    const p = new WatchdogRecoveryPolicy()
    let continues = 0
    for (let i = 0; i < 15; i++) {
      p.recordTurnComplete()          // tiny-turn：重置 consecutive，+1 进度（1 < 4 仍密集）
      if (p.onStall().autoContinue) continues++
    }
    assert.equal(continues, 12)
    const d = p.onStall()
    assert.equal(d.autoContinue, false)
    assert.equal(d.stopReason, 'session-total')
  })

  test('稀疏 stall（>= 4 进度单元）不消耗 session 配额', () => {
    const p = new WatchdogRecoveryPolicy()
    let continues = 0
    for (let i = 0; i < 20; i++) {
      // 2 个完整工具批 = 2 completion + 2 tool result = 4 单元
      p.recordToolResult(); p.recordTurnComplete()
      p.recordToolResult(); p.recordTurnComplete()
      const d = p.onStall()
      if (d.autoContinue) { continues++; assert.equal(d.dense, false) }
    }
    assert.equal(continues, 20, '稀疏 stall 永不触顶')
  })

  test('两 cap 同时越界时 stopReason 优先报 session-total（对齐 TUI 消息优先级）', () => {
    const p = new WatchdogRecoveryPolicy({ maxConsecutive: 1, maxSessionTotal: 1 })
    assert.equal(p.onStall().autoContinue, true)   // consecutive=1, sessionTotal=1
    const d = p.onStall()
    assert.equal(d.stopReason, 'session-total')
  })

  test('suppressed stall 不消耗任何状态', () => {
    const p = new WatchdogRecoveryPolicy()
    p.recordToolResult(); p.recordToolResult()
    p.recordToolResult(); p.recordTurnComplete()   // 4 单元
    const d = p.onStall({ suppressed: true })
    assert.equal(d.autoContinue, false)
    assert.equal(d.stopReason, 'suppressed')
    assert.deepEqual(p.snapshot(), { consecutive: 0, sessionTotal: 0, progressUnits: 4 },
      'suppressed 不清进度、不加 consecutive、不计配额')
  })

  test('cap 越界的 stall 不消耗状态（进度保留到下一次判定）', () => {
    const p = new WatchdogRecoveryPolicy({ maxConsecutive: 1 })
    p.onStall()                                    // consecutive=1（顶满）
    p.recordToolResult()                           // 1 单元
    const rejected = p.onStall()                   // consecutive=1 >= 1 → 拒绝
    assert.equal(rejected.autoContinue, false)
    assert.equal(p.snapshot().progressUnits, 1, '被拒的 stall 不得清零进度')
  })

  test('snapshot 暴露遥测三元组', () => {
    const p = new WatchdogRecoveryPolicy()
    p.recordTurnComplete()
    p.onStall()
    assert.deepEqual(p.snapshot(), { consecutive: 1, sessionTotal: 1, progressUnits: 0 })
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`node --import tsx --test-force-exit --test src/agent/__tests__/watchdog-recovery-policy.test.ts`
预期：FAIL，报错 Cannot find module `watchdog-recovery-policy.js`

- [ ] **步骤 3：编写实现**

```typescript
/**
 * WatchdogRecoveryPolicy — watchdog stall 自动恢复的共享状态机（TUI 与桌面 sidecar 共用）。
 *
 * 三件套语义（与 TuiApp v3 实现对齐，设计溯源见
 * docs/superpowers/plans/2026-07-02-watchdog-session-total-stall-gap.md）：
 * - consecutive cap（默认 3）：连续自动续跑无 turn 完成即停。turn 完成 / 用户提交时归零。
 * - session-total cap（默认 12）：永不重置的会话级配额。只有**密集** stall（自上次续跑
 *   以来进度单元 < 阈值）才消耗；稀疏 stall（>= 2 个完整工具批的真实工作）免费。
 * - 进度单元 = turn 完成次数 + 终态工具结果次数。调用方负责过滤流式 chunk：
 *   isError === undefined 的中间更新不得调用 recordToolResult（否则单次长输出工具
 *   就能凑满阈值，把密集 stall 伪装成稀疏——TUI 侧已修过这个 bug）。
 *
 * 纯状态机：无 UI、无计时器、无 I/O。抑制条件（审批挂起、输入草稿、拒绝 grace 窗口）
 * 由调用方判定后经 onStall({ suppressed }) 传入——两端抑制来源不同（TUI 看输入框与
 * 本地审批态，桌面看 HTTP 审批 pending map），但抑制后的语义相同：不续跑、不消耗状态。
 */
export interface StallDecision {
  autoContinue: boolean
  /** autoContinue=false 时的停止原因。 */
  stopReason?: 'suppressed' | 'consecutive' | 'session-total'
  /** autoContinue=true 时标记本次是否消耗了 session 配额（密集 stall）。 */
  dense?: boolean
}

export class WatchdogRecoveryPolicy {
  private consecutiveCount = 0
  private sessionTotalCount = 0
  private progressUnits = 0
  private readonly maxConsecutive: number
  private readonly maxSessionTotal: number
  private readonly progressThreshold: number

  constructor(opts?: { maxConsecutive?: number; maxSessionTotal?: number; progressThreshold?: number }) {
    this.maxConsecutive = opts?.maxConsecutive ?? 3
    this.maxSessionTotal = opts?.maxSessionTotal ?? 12
    this.progressThreshold = opts?.progressThreshold ?? 4
  }

  /** turn 完成（含中间 isFinal:false）：真实前进——重置 consecutive 并 +1 进度。 */
  recordTurnComplete(): void {
    this.consecutiveCount = 0
    this.progressUnits++
  }

  /** 终态工具结果 +1 进度。流式 chunk（isError === undefined）不得调用。 */
  recordToolResult(): void {
    this.progressUnits++
  }

  /** 用户主动提交：恢复完整续跑预算。进度不清（submit 前后合计仍是真实工作）。 */
  recordUserSubmit(): void {
    this.consecutiveCount = 0
  }

  /**
   * watchdog 家族 stall 的决策入口。suppressed=true 时不消耗任何状态直接拒绝；
   * cap 越界时同样不消耗（进度保留到下一次判定）；只有真正续跑的 stall 才
   * consecutive+1、按密集判定计配额、清零进度。
   */
  onStall(opts?: { suppressed?: boolean }): StallDecision {
    if (opts?.suppressed) return { autoContinue: false, stopReason: 'suppressed' }
    const sessionTotalExhausted = this.sessionTotalCount >= this.maxSessionTotal
    if (sessionTotalExhausted || this.consecutiveCount >= this.maxConsecutive) {
      return { autoContinue: false, stopReason: sessionTotalExhausted ? 'session-total' : 'consecutive' }
    }
    this.consecutiveCount++
    const dense = this.progressUnits < this.progressThreshold
    if (dense) this.sessionTotalCount++
    this.progressUnits = 0
    return { autoContinue: true, dense }
  }

  /** 遥测快照（watchdog_recovery 事件负载 / 调试用）。 */
  snapshot(): { consecutive: number; sessionTotal: number; progressUnits: number } {
    return {
      consecutive: this.consecutiveCount,
      sessionTotal: this.sessionTotalCount,
      progressUnits: this.progressUnits,
    }
  }
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`node --import tsx --test-force-exit --test src/agent/__tests__/watchdog-recovery-policy.test.ts`
预期：PASS 全绿

- [ ] **步骤 5：Commit**

```bash
git add src/agent/watchdog-recovery-policy.ts src/agent/__tests__/watchdog-recovery-policy.test.ts
git commit -m "feat(agent): extract WatchdogRecoveryPolicy shared stall-recovery state machine"
```

---

## 任务 2：TuiApp 委托 policy（行为零变化）

**文件：**
- 修改：`src/tui/engine/app.ts`（字段区 ~L313-340、用户提交 ~L399、`handleTurnComplete` ~L2317、`handleToolResult` ~L2157、`handleAbort` ~L2480-2548）

**守门员：** 本任务**不写新测试**——现有 `abort-resubmit.test.ts` 15 个用例（含变异验证过的 A3/D）必须原样全绿，这就是提取无损的证明。若任何一个转红，说明委托语义有偏差，修实现而不是改测试。

- [ ] **步骤 1：字段替换**

删除以下六个成员（保留 `_lastApprovalDeniedAt` 与 `APPROVAL_STALL_GRACE_MS` 不动——测试 D 直接回拨该时间戳，抑制判定留在 TuiApp）：

```typescript
// 删除：
private _watchdogAutoContinues = 0
private static readonly MAX_WATCHDOG_AUTO_CONTINUES = 3
private _watchdogSessionTotal = 0
private static readonly MAX_WATCHDOG_SESSION_TOTAL = 12
private _progressSinceLastStall = 0
private static readonly WATCHDOG_PROGRESS_THRESHOLD = 4
```

替换为（原字段注释的语义已收进 policy 类的 doc comment，此处只留指针）：

```typescript
/** Watchdog stall 自动恢复状态机（consecutive/session-total/进度感知配额），
 *  与桌面 sidecar 共享同一实现 — 见 src/agent/watchdog-recovery-policy.ts。 */
private readonly watchdogPolicy = new WatchdogRecoveryPolicy()
```

并在 app.ts 头部补 import：

```typescript
import { WatchdogRecoveryPolicy } from '../../agent/watchdog-recovery-policy.js'
```

- [ ] **步骤 2：三个计数点改为委托**

用户提交（~L399，`if (trimmed) this._watchdogAutoContinues = 0` 一行）：

```typescript
if (trimmed) this.watchdogPolicy.recordUserSubmit()
```

`handleTurnComplete`（~L2317-2320，两行合一）：

```typescript
// A completed turn (even intermediate) is forward progress: the stream
// produced output, so the prior boundary stall cleared.
this.watchdogPolicy.recordTurnComplete()
```

`handleToolResult`（~L2157-2163，终态位置的 `this._progressSinceLastStall++`，保留现有位置注释）：

```typescript
this.watchdogPolicy.recordToolResult()
```

- [ ] **步骤 3：`handleAbort` 决策块改为单次 onStall 调用**

将现有 L2496-2512 的布尔计算（`sessionTotalExhausted` / `autoContinueExhausted` / `suppressForApproval` / `yieldToUser` / `shouldAutoContinue`）替换为：

```typescript
const suppressForApproval = isWatchdog && approvalBlocked
// v3 yield-to-user guard: if the input line has an unsubmitted draft, the
// user is present and about to act — don't inject 'continue' and race them.
const yieldToUser = isWatchdog && this.inputLine.value.trim().length > 0
// Single decision point: the SAME StallDecision drives both the message and
// the behavior branch below — the v3 "shows Auto-recovering but never
// recovers" lie came from computing them separately. Suppressed/exhausted
// stalls consume no policy state (progress carries over to the next stall).
const decision = isWatchdog
  ? this.watchdogPolicy.onStall({ suppressed: suppressForApproval || yieldToUser })
  : null
const shouldAutoContinue = decision?.autoContinue === true
const sessionTotalExhausted = decision?.stopReason === 'session-total'
const autoContinueExhausted = sessionTotalExhausted || decision?.stopReason === 'consecutive'
```

消息分支（`commitAbove` 内的 ternary 链）**保持原样**——它引用的 `suppressForApproval` / `yieldToUser` / `shouldAutoContinue` / `autoContinueExhausted` / `sessionTotalExhausted` 名字与取值语义都没变。

行为分支（原 L2539-2548）收缩为：

```typescript
if (shouldAutoContinue) {
  this.onSubmitCallback?.('continue')
}
```

（consecutive++、密集判定计配额、进度清零已全部发生在 `onStall` 内部。）

- [ ] **步骤 4：类型检查 + 现有测试全绿**

运行：`npm run typecheck && node --import tsx --test-force-exit --test src/tui/engine/__tests__/abort-resubmit.test.ts`
预期：typecheck 通过；15/15 PASS。**注意 `isWatchdogGoal` 变量（L2481）可能因此不再被行为分支引用**——若 lint 报 unused，确认消息分支是否还在用，不用则一并删除。

- [ ] **步骤 5：engine 目录全量回归**

运行：`ls src/tui/engine/__tests__/*.test.ts | xargs node --import tsx --test-force-exit --test 2>&1 | grep -E '^ℹ (tests|pass|fail)'`
预期：`fail 0`（当前基线 208 个用例）

- [ ] **步骤 6：Commit**

```bash
git add src/tui/engine/app.ts
git commit -m "refactor(tui): delegate watchdog stall recovery to shared WatchdogRecoveryPolicy"
```

---

## 任务 3：桌面端 session-manager 接线（TDD）

**文件：**
- 修改：`src/server/session-manager.ts`
- 修改：`src/server/__tests__/session-manager.test.ts`
- 修改：`desktop/src/runtime/types.ts`

**关键时序事实（实现前必读）：**
1. `onAbort` 触发时 `run()` promise 尚未 settle，`session.running` 仍为 true——续跑决策必须延迟到 `run().finally` 之后。
2. `run().finally`（L970-979）里 `rejectAllPending` 会清空审批 pending map——「stall 时是否卡在审批上」必须在 `onAbort` 时刻捕获，到 finally 再看已经晚了。
3. 用户 abort（`manager.abort()`）经真实 agent 的 `abortReason()` 产出 `undefined` reason；watchdog 自中止产出 `'watchdog'` / `'watchdog:goal'`——家族判定只看 reason 前缀，与 TUI 一致。
4. 时间读数一律用 `this.now()`（可注入），不用 `Date.now()`——grace 窗口测试靠假时钟。

- [ ] **步骤 1：扩展 FakeAgent + 编写第一个失败测试**

在 `src/server/__tests__/session-manager.test.ts` 的 FakeAgent 中加两个成员：

```typescript
class FakeAgent implements ManagedAgent {
  // ...现有成员不动...
  /** 每次 run 收到的 prompt，按序记录（含自动续跑注入的 'continue'）。 */
  prompts: string[] = []

  run(prompt: string, cb: AgentCallbacks): Promise<void> {
    this.prompts.push(prompt)
    this.callbacks = cb
    return new Promise<void>((res) => { this.resolveRun = res })
  }

  /** 模拟 agent 内部 watchdog 自中止：带 reason 的 onAbort + run settle。
   *  与 abort()（用户中止，无 reason）区分——manager.abort 不走这条路。 */
  watchdogAbort(reason = 'watchdog:goal'): void {
    this.callbacks?.onAbort(reason)
    this.resolveRun?.()
  }
}
```

文件顶部加辅助函数（finally 是微任务、续跑决策在 setImmediate 宏任务——一个 setTimeout(5) 覆盖两者）：

```typescript
const settle = () => new Promise((r) => setTimeout(r, 5))
```

新增第一个测试：

```typescript
test('watchdog:goal 中止后自动续跑：agent 收到第二次 run(continue)，status 回到 running', async () => {
  const { manager, agents } = makeManager()
  const s = manager.createSession({ prompt: 'go' })
  agents[0]!.watchdogAbort('watchdog:goal')
  await settle()

  assert.deepEqual(agents[0]!.prompts, ['go', 'continue'])
  assert.equal(manager.getSession(s.id)!.status, 'running', '续跑后不停留在 aborted')
  const ev = manager.getEvents(s.id, 0)!.events.find((e) => e.type === 'watchdog_recovery')
  assert.ok(ev, '必须追加 watchdog_recovery 事件')
  assert.equal(ev!.data.autoContinue, true)
})
```

- [ ] **步骤 2：运行验证失败**

运行：`node --import tsx --test-force-exit --test src/server/__tests__/session-manager.test.ts`
预期：新用例 FAIL（`prompts` 只有 `['go']`，无 `watchdog_recovery` 事件）；存量用例全绿。

- [ ] **步骤 3：session-manager 实现**

3a. `SessionEventType` union（L53-86）追加一项：

```typescript
  | 'watchdog_recovery'
```

3b. 模块级常量（放在 `SessionStatus` 定义附近）：

```typescript
/** 审批拒绝后的 watchdog 续跑抑制窗口——与 TuiApp.APPROVAL_STALL_GRACE_MS 对齐：
 *  拒绝后立刻 stall 的自动 continue 只会重发同一个被拒调用（deny→continue→deny 环）。 */
const WATCHDOG_APPROVAL_GRACE_MS = 5_000
```

3c. `InternalSession`（L431）追加字段：

```typescript
  /** Watchdog stall 恢复状态机（与 TUI 共享实现），随 session 生命周期。 */
  watchdogPolicy?: WatchdogRecoveryPolicy
  /** 最近一次 onAbort 携带的 reason（watchdog 家族判定用）。每次 run 起跑清空。 */
  lastAbortReason?: string
  /** onAbort 时刻是否有审批挂起——必须在此捕获，run().finally 的 rejectAllPending 会清掉 pending map。 */
  abortWhileApprovalPending?: boolean
  /** 最近一次审批被拒的时刻（this.now() 读数），驱动 grace 窗口抑制。 */
  lastApprovalDeniedAt?: number
  /** 标记下一次 run 是 watchdog 自动续跑（跳过 recordUserSubmit，与 TUI 的
   *  onSubmitCallback 直呼路径对齐——自动续跑不得重置 consecutive）。 */
  watchdogAutoResubmit?: boolean
```

头部 import：

```typescript
import { WatchdogRecoveryPolicy } from '../agent/watchdog-recovery-policy.js'
```

3d. `buildCallbacks`（~L2035-2063）三处接线：

```typescript
onToolResult: (toolId, name, result, isError, _rawPath, uiContent) => {
  // 终态才计进度单元；isError === undefined 是流式 chunk（TUI 侧同款过滤，
  // 否则单次长输出工具就能伪装稀疏 stall）。
  if (isError !== undefined) session.watchdogPolicy?.recordToolResult()
  // ...现有 append 逻辑不动...
},
onTurnComplete: (usage, turnNumber, isFinal, evidenceSummary) => {
  session.watchdogPolicy?.recordTurnComplete()
  this.append(session, 'turn_complete', { usage, turnNumber, isFinal: !!isFinal, ...(isFinal && evidenceSummary ? { evidence: evidenceSummary } : {}) })
},
onAbort: (reason) => {
  session.lastAbortReason = reason
  // 在 finally 的 rejectAllPending 清场之前捕获审批挂起态。
  session.abortWhileApprovalPending =
    [...session.pending.values()].some((p) => p.kind === 'approval')
  if (session.record.status === 'running') session.record.status = 'aborted'
},
```

3e. `answerIntervention`（L1713-1741）拒绝时记时间戳（`pend.resolve(result)` 之后）：

```typescript
if (!approved) s.lastApprovalDeniedAt = this.now()
```

审批超时自动拒绝（`requestApproval` 内 L2108-2114 的 timer 回调）与 `rejectAllPending`（L2140，循环体前）各加同一行：

```typescript
session.lastApprovalDeniedAt = this.now()   // rejectAllPending 中仅当 pending.size > 0 时记
```

3f. `run()`（L926）起跑处（`session.running = true` 之前）：

```typescript
const wasAutoResubmit = session.watchdogAutoResubmit === true
session.watchdogAutoResubmit = false
session.lastAbortReason = undefined
session.abortWhileApprovalPending = false
session.watchdogPolicy ??= new WatchdogRecoveryPolicy()
// 用户主动提交恢复续跑预算；自动续跑注入的 'continue' 不算（与 TUI 的
// onSubmitCallback 直呼路径一致，否则 consecutive cap 形同虚设）。
if (!wasAutoResubmit) session.watchdogPolicy.recordUserSubmit()
```

3g. `run().finally`（L970-979）末尾（`persistRecord` 之后）追加一行调用，并新增私有方法：

```typescript
.finally(() => {
  // ...现有清理不动...
  this.persistRecord(session)
  this.maybeWatchdogAutoContinue(session)
})
```

```typescript
/**
 * Watchdog stall 自动恢复（桌面端对齐 TUI v3）：run settle 后判定是否注入
 * 'continue'。必须经 setImmediate 延迟——给排队中的用户 HTTP 动作（run/archive）
 * 让路，执行前复核会话仍处 aborted 且无人抢跑（TUI「让位守卫」的桌面对应物）。
 */
private maybeWatchdogAutoContinue(session: InternalSession): void {
  const reason = session.lastAbortReason
  if (!reason?.startsWith('watchdog')) return
  const policy = session.watchdogPolicy
  if (!policy) return
  const suppressed = session.abortWhileApprovalPending === true
    || (session.lastApprovalDeniedAt != null
        && this.now() - session.lastApprovalDeniedAt < WATCHDOG_APPROVAL_GRACE_MS)
  setImmediate(() => {
    // 让位守卫：用户已重新驱动（running）、状态被改（非 aborted）或已归档 → 放弃。
    if (session.running || session.record.status !== 'aborted' || session.record.archived) return
    const decision = policy.onStall({ suppressed })
    this.append(session, 'watchdog_recovery', {
      reason,
      autoContinue: decision.autoContinue,
      ...(decision.stopReason ? { stopReason: decision.stopReason } : {}),
      ...(decision.autoContinue ? { dense: decision.dense === true } : {}),
      ...policy.snapshot(),
    })
    if (!decision.autoContinue) return
    session.watchdogAutoResubmit = true
    if (!this.run(session.record.id, 'continue')) session.watchdogAutoResubmit = false
  })
}
```

3h. `desktop/src/runtime/types.ts` 事件类型 union（L156 附近）追加 `| 'watchdog_recovery'`（reducer 的 `default: return next` 已天然忽略，不需要渲染改动——桌面 UI 渲染「⟳ 自动恢复中」是后续独立工作）。

- [ ] **步骤 4：运行第一个测试验证通过**

运行：`node --import tsx --test-force-exit --test src/server/__tests__/session-manager.test.ts`
预期：步骤 1 的用例 PASS；存量用例全绿（重点盯 L110「abort is isolated」与 L278「done event」——用户 abort 无 reason，不得触发续跑）。

- [ ] **步骤 5：补齐其余桌面端测试**

追加到 `session-manager.test.ts`：

```typescript
test('普通 watchdog（非 goal）同样自动续跑', async () => {
  const { manager, agents } = makeManager()
  const s = manager.createSession({ prompt: 'go' })
  agents[0]!.watchdogAbort('watchdog')
  await settle()
  assert.deepEqual(agents[0]!.prompts, ['go', 'continue'])
  assert.equal(manager.getSession(s.id)!.status, 'running')
})

test('用户 abort（无 reason）与 convergence 中止不自动续跑', async () => {
  const { manager, agents } = makeManager()
  const a = manager.createSession({ prompt: 'a' })
  manager.abort(a.id)                       // FakeAgent.abort → onAbort() 无 reason
  await settle()
  assert.deepEqual(agents[0]!.prompts, ['a'], '用户中止不得续跑')
  assert.equal(manager.getSession(a.id)!.status, 'aborted')

  const b = manager.createSession({ prompt: 'b' })
  agents[1]!.callbacks!.onAbort('convergence:no-tool')
  agents[1]!.finish()
  await settle()
  assert.deepEqual(agents[1]!.prompts, ['b'], 'convergence 中止不得续跑')
})

test('密集 stall（tiny-turn 循环）12 次后停手，事件含 stopReason=session-total', async () => {
  const { manager, agents } = makeManager()
  const s = manager.createSession({ prompt: 'go' })
  const a = agents[0]!
  for (let i = 0; i < 15; i++) {
    a.callbacks!.onTurnComplete({}, 1, false)   // tiny-turn：重置 consecutive
    a.watchdogAbort('watchdog:goal')
    await settle()
  }
  const continues = a.prompts.filter((p) => p === 'continue').length
  assert.equal(continues, 12, `session-total cap 应在 12 次后停手，实得 ${continues}`)
  assert.equal(manager.getSession(s.id)!.status, 'aborted', '停手后落 aborted 等用户')
  const evs = manager.getEvents(s.id, 0)!.events.filter((e) => e.type === 'watchdog_recovery')
  assert.equal(evs[evs.length - 1]!.data.stopReason, 'session-total')
})

test('稀疏 stall（每次间隔 2 个工具批）不消耗配额，15 次全续跑', async () => {
  const { manager, agents } = makeManager()
  manager.createSession({ prompt: 'go' })
  const a = agents[0]!
  for (let i = 0; i < 15; i++) {
    for (let j = 0; j < 2; j++) {
      a.callbacks!.onToolResult(`t${i}-${j}`, 'read_file', 'ok', false)
      a.callbacks!.onTurnComplete({}, 1, false)
    }
    a.watchdogAbort('watchdog:goal')
    await settle()
  }
  assert.equal(a.prompts.filter((p) => p === 'continue').length, 15)
})

test('流式 chunk（isError=undefined）不计进度：密集 stall 仍 12 次停手', async () => {
  const { manager, agents } = makeManager()
  manager.createSession({ prompt: 'go' })
  const a = agents[0]!
  for (let i = 0; i < 15; i++) {
    for (let j = 0; j < 4; j++) a.callbacks!.onToolResult(`t${i}`, 'bash', `chunk${j}`)  // 无 isError
    a.callbacks!.onToolResult(`t${i}`, 'bash', 'done', false)   // 终态
    a.callbacks!.onTurnComplete({}, 1, false)
    // 每周期真实进度 = 2 单元 < 4 → 密集
    a.watchdogAbort('watchdog:goal')
    await settle()
  }
  const continues = a.prompts.filter((p) => p === 'continue').length
  assert.equal(continues, 12, `chunk 若被误计会伪装稀疏无限续跑，实得 ${continues}`)
})

test('审批挂起时 stall → suppressed：不续跑，事件可观测', async () => {
  const { manager, agents } = makeManager()
  const s = manager.createSession({ prompt: 'go' })
  const a = agents[0]!
  void a.callbacks!.onApprovalRequired('t1', 'bash', { command: 'rm x' })  // 挂起不答复
  a.watchdogAbort('watchdog:goal')
  await settle()
  assert.deepEqual(a.prompts, ['go'], '审批挂起的 stall 不得续跑')
  const ev = manager.getEvents(s.id, 0)!.events.find((e) => e.type === 'watchdog_recovery')
  assert.equal(ev!.data.stopReason, 'suppressed')
})

test('审批拒绝后 5s grace 窗口内的 stall 被抑制，窗口外恢复续跑（假时钟）', async () => {
  let clock = 1_000_000
  const agents: FakeAgent[] = []
  const manager = new RuntimeSessionManager({
    createAgent: () => { const a = new FakeAgent(); agents.push(a); return a },
    defaultCwd: '/tmp/work',
    now: () => clock,
  })
  const s = manager.createSession({ prompt: 'go' })
  const sid = s.id
  const a = agents[0]!
  const pending = a.callbacks!.onApprovalRequired('t1', 'bash', { command: 'rm x' })
  // requestApproval 用 toolId 作 requestId（session-manager.ts:2101 已核实）
  manager.answerIntervention(sid, 't1', 'reject')
  assert.deepEqual(await pending, { approved: false })

  clock += 1_000                              // 拒绝后 1s——窗口内
  a.watchdogAbort('watchdog:goal')
  await settle()
  assert.deepEqual(a.prompts, ['go'], 'grace 窗口内不得续跑')

  clock += 10_000                             // 拒绝后 11s——窗口外
  manager.run(sid, 'again')                   // 用户重新驱动
  a.watchdogAbort('watchdog:goal')
  await settle()
  assert.equal(a.prompts.filter((p) => p === 'continue').length, 1, '窗口外恢复续跑')
})

test('abort 后用户抢先提交新 prompt：自动续跑让位', async () => {
  const { manager, agents } = makeManager()
  const s = manager.createSession({ prompt: 'go' })
  const a = agents[0]!
  a.watchdogAbort('watchdog:goal')
  // 只排干微任务（run().finally 是 promise 回调），不让 setImmediate 宏任务先跑
  for (let i = 0; i < 10; i++) await Promise.resolve()
  assert.equal(manager.run(s.id, '用户新指令'), true, '此刻 running 已清，用户可提交')
  await settle()
  assert.deepEqual(a.prompts, ['go', '用户新指令'], '自动 continue 必须让位给用户')
  const ev = manager.getEvents(s.id, 0)!.events.find((e) => e.type === 'watchdog_recovery')
  assert.equal(ev, undefined, '让位时不产生 recovery 事件')
})
```

**注意**：`requestApproval` 以 toolId 作 requestId（`session-manager.ts:2101`，现有 L184-196 用例同此惯例），grace 窗口用例的 `answerIntervention(sid, 't1', ...)` 直接可用。

- [ ] **步骤 6：全量验证**

运行：

```bash
npm run typecheck
node --import tsx --test-force-exit --test src/server/__tests__/session-manager.test.ts
node --import tsx --test-force-exit --test src/agent/__tests__/watchdog-recovery-policy.test.ts src/tui/engine/__tests__/abort-resubmit.test.ts
```

预期：全部 PASS，`fail 0`。

- [ ] **步骤 7：Commit**

```bash
git add src/server/session-manager.ts src/server/__tests__/session-manager.test.ts desktop/src/runtime/types.ts
git commit -m "feat(server): watchdog stall auto-recovery for desktop sessions via shared policy"
```

---

## 验证命令（汇总）

```bash
npm run typecheck
node --import tsx --test-force-exit --test src/agent/__tests__/watchdog-recovery-policy.test.ts
node --import tsx --test-force-exit --test src/tui/engine/__tests__/abort-resubmit.test.ts
node --import tsx --test-force-exit --test src/server/__tests__/session-manager.test.ts
# sibling 全量
ls src/tui/engine/__tests__/*.test.ts | xargs node --import tsx --test-force-exit --test
```

## 已知风险与边界

1. **配额消耗与让位的竞态取舍**：决策（`onStall` 消耗状态）放在 setImmediate 内、让位复核之后——用户抢跑时策略状态完全不动，也不产生事件。代价是极端情况下同一 stall 的事件可能缺失（被抢跑），可接受：用户动作本身就是更强的信号。
2. **suppressed 抑制判定的时点**：`abortWhileApprovalPending` 在 `onAbort` 捕获、grace 时间在 setImmediate 内读取（`this.now()`）——两者时间差是微任务级，不影响 5s 量级的窗口语义。
3. **自动续跑会产生 `user` 事件**：`run(id, 'continue')` 复用现有路径，事件流里会出现 `text: 'continue'` 的 user 事件。这是刻意的——与 TUI 的 `onSubmitCallback('continue')` 一致，且桌面时间线能看到恢复动作。UI 若想特殊渲染，靠紧邻的 `watchdog_recovery` 事件区分。
4. **steer 清空**：`run()` 起跑会 `session.steer.clear()`——自动续跑也会清。watchdog abort 时 run 已终止，steer 队列本就随 `rejectAllPending` 语义作废（TUI 的保留策略针对的是同一 run 内的中断，桌面跨 run 不保留），不额外处理。
5. **桌面 UI 渲染**：本计划只保证事件可观测（`watchdog_recovery` + reducer default 兜底不炸）。时间线上渲染「⟳ 自动恢复中 / ⏹ 配额耗尽」是后续独立 PR（`desktop/src/state/event-reducer.ts` + 对应 block 组件）。
6. **policy 实例不随 agent 重建复位**：`watchdogPolicy` 挂在 `InternalSession` 上，`switchModel` 重建 agent 不清配额——session-total 的语义就是会话级，正确。归档/删除随 session 一起消失。

## 与上游计划的关系

本计划实现 `2026-07-02-watchdog-session-total-stall-gap.md` 的任务 D1-D3（该文档 §「桌面端（sidecar server）覆盖」）。TUI 侧任务 1-4 与测试 A-G 已由提交 `05b8b32f` + `b6739aed` 交付；本计划的任务 2 将其内部实现替换为共享 policy，行为契约不变。
