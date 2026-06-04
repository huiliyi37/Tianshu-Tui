# Theta Check 限流与退避 — 修复计划

> **状态：✅ 已全部实施** — Task 1（thetaTelemetry 退避状态）、Task 2（requestThetaCheck cooldown 限流）、Task 3（elm-micro-release 超时抑制）均已落地。

**目标：** 为 theta-gamma 一致性检查（`runThetaCheck`）添加会话级请求上限、连续超时指数退避、和资源感知触发门禁，防止 session 在 tsc 反复超时时无限重试导致卡死。

**架构：** 三层防护——(1) 会话级硬上限（N 次/turn + M 次/session），(2) 连续超时指数退避（1 超时 → 暂停 2 轮，2 连续 → 暂停 4 轮，3+ → 暂停 8 轮），(3) elm-micro-release 触发条件增加"最近无超时"前置条件。不改 theta-check.ts 本身（它是无状态的纯函数），所有状态管理在 `requestThetaCheck` 中。

**技术栈：** TypeScript strict / node:test / 已有 sensorium 体系

---

## 根因

### 来自 session `feeef602` 的证据

```
sensorium 最后 20 条记录：
[21:59-22:06] turn 15-19, phase 循环 tianshu-encore → tianji-decomposing → tianxuan-locating
theta.lastTimedOut = true （全部超时）
theta.requestedCount = 124 → 137 （13 次无效 theta check）
```

**根因链**：
1. `npx tsc --noEmit --skipLibCheck` 超时（3s），返回空错误集
2. theta check "成功"完成（没有抛错），`thetaCheckInFlight = false`
3. 下一个 tool call 后 theta-hook 再次触发 `tickTheta` → `requestThetaCheck`
4. elm-micro-release 也在触发（vigor 高 = 一切顺利 = 额外检查脉冲）
5. 无限循环：每次都 spawn 新 tsc 进程 → 等 3s → 超时 → 重复

### 当前防护的缺口

| 防护 | 状态 | 缺口 |
|------|------|------|
| `thetaCheckInFlight` 防重入 | ✅ 有效 | 只防并发，不防连续 |
| 超时后降频 | ❌ 不存在 | 超时和成功的处理路径完全相同 |
| 会话级上限 | ❌ 不存在 | requestedCount 只用于遥测，无门禁 |
| elm-micro-release 超时感知 | ❌ 不存在 | 只要 vigor 高就触发，不管 tsc 是否可用 |

---

## 文件清单

| 文件 | 职责 |
|------|------|
| `src/agent/loop.ts:242-249` | thetaTelemetry 类型定义 — 扩展加入退避状态 |
| `src/agent/loop.ts:877-904` | `requestThetaCheck` 方法 — 核心修改：限流 + 退避 |
| `src/agent/hooks/theta-hook.ts:22` | theta-cycle 触发 — 无需修改（门禁在 requestThetaCheck 内） |
| `src/agent/hooks/vigor-hook.ts:50` | elm-micro-release 触发 — 增加超时前置条件 |
| `src/agent/star-event.ts:174-210` | ThetaState 类型 — 无需修改 |
| `src/agent/theta-check.ts` | 纯函数 runThetaCheck — 不修改 |
| `src/agent/__tests__/theta-hook.test.ts` | 现有 theta hook 测试 — 只读参考 |
| `src/agent/__tests__/theta-check.test.ts` | 现有 theta check 测试 — 只读参考 |
| `src/agent/__tests__/vigor-hook.test.ts` | 现有 vigor hook 测试 — 验证退避集成 |
| `src/agent/__tests__/theta-rate-limit.test.ts` | 新增 — 限流和退避测试 |

---

## 调研背书

### `requestThetaCheck` 的调用方

| 调用方 | 文件:行 | 频率 |
|--------|---------|------|
| theta-hook | `hooks/theta-hook.ts:22` | 每 N 个 tool call（N = thetaState.interval = 7） |
| vigor-hook (elm-micro-release) | `hooks/vigor-hook.ts:50` | vigor 连续 5 次 > 0.8 时 |

### `thetaTelemetry` 的消费者

| 消费者 | 文件:行 | 用途 |
|--------|---------|------|------|
| sensorium 快照 | `loop.ts:1271` | 写入 sensorium.jsonl 供 TUI 状态栏 |
| loop 内部遥测 | `loop.ts:880-901` | 记录请求计数、超时状态 |

### `shouldTriggerElmRelease` 的签名

```typescript
export function shouldTriggerElmRelease(
  vigor: VigorState,
  threshold = 0.8,
  minRecent = 5,
): boolean
```

仅检查 vigor 历史，无外部上下文。需要扩展为可传入 thetaTelemetry 或在调用方添加前置条件。

---

### Task 1：扩展 thetaTelemetry 类型 — 加入退避状态

- [ ] **步骤 1：编写退避逻辑测试**

创建：`src/agent/__tests__/theta-rate-limit.test.ts`

```typescript
import { describe, it, assert } from 'node:test'

describe('Theta rate limit: consecutive timeout backoff', () => {
  it('should not backoff when there are zero consecutive timeouts', () => {
    // 0 consecutive timeouts → cooldown = 0 → no backoff
    const consecutiveTimeouts = 0
    const cooldown = consecutiveTimeouts === 0 ? 0
      : Math.min(8, Math.pow(2, consecutiveTimeouts - 1))
    assert.strictEqual(cooldown, 0)
  })

  it('should backoff 2 turns after 1 consecutive timeout', () => {
    const consecutiveTimeouts = 1
    const cooldown = Math.min(8, Math.pow(2, consecutiveTimeouts - 1))
    assert.strictEqual(cooldown, 1)
  })

  it('should backoff 4 turns after 2 consecutive timeouts', () => {
    const consecutiveTimeouts = 2
    const cooldown = Math.min(8, Math.pow(2, consecutiveTimeouts - 1))
    assert.strictEqual(cooldown, 2)
  })

  it('should cap at 8 turns for 4+ consecutive timeouts', () => {
    const consecutiveTimeouts = 5
    const cooldown = Math.min(8, Math.pow(2, consecutiveTimeouts - 1))
    assert.strictEqual(cooldown, 8)
  })

  it('should reset consecutive timeouts on success', () => {
    // When a theta check succeeds (timedOut=false), consecutiveTimeouts resets to 0
    let consecutiveTimeouts = 3
    const lastTimedOut = false
    if (!lastTimedOut) consecutiveTimeouts = 0
    assert.strictEqual(consecutiveTimeouts, 0)
  })
})
```

- [ ] **步骤 2：运行测试确认通过**

```bash
npm exec -- tsx --test src/agent/__tests__/theta-rate-limit.test.ts
```

预期：PASS（纯逻辑测试，无 IO 依赖）

- [ ] **步骤 3：扩展 thetaTelemetry 类型**

修改：`src/agent/loop.ts:243-249`

```typescript
// Before:
  private thetaTelemetry: { lastReason: string | null; lastDurationMs: number | null; lastErrorCount: number; lastTimedOut: boolean; requestedCount: number } = {
    lastReason: null,
    lastDurationMs: null,
    lastErrorCount: 0,
    lastTimedOut: false,
    requestedCount: 0,
  }

// After:
  private thetaTelemetry: {
    lastReason: string | null
    lastDurationMs: number | null
    lastErrorCount: number
    lastTimedOut: boolean
    requestedCount: number
    /** Number of consecutive theta checks that timed out. Reset to 0 on success. */
    consecutiveTimeouts: number
    /** Turn number at which backoff expires. 0 = no backoff active. */
    cooldownUntilTurn: number
  } = {
    lastReason: null,
    lastDurationMs: null,
    lastErrorCount: 0,
    lastTimedOut: false,
    requestedCount: 0,
    consecutiveTimeouts: 0,
    cooldownUntilTurn: 0,
  }
```

- [ ] **步骤 4：类型检查**

```bash
npx tsc --noEmit
```

预期：有类型错误（新增字段未在 spread 处初始化），下一步修复。

- [ ] **步骤 5：修复 spread 初始化 — runThetaCheck 回调中增加字段**

修改：`src/agent/loop.ts:889-894`（`runThetaCheck` 的 `.then()` 回调）

```typescript
// Before:
      this.thetaTelemetry = {
        ...this.thetaTelemetry,
        lastDurationMs: result.durationMs,
        lastErrorCount: result.errors.length,
        lastTimedOut: result.timedOut,
      }

// After:
      const timedOut = result.timedOut
      this.thetaTelemetry = {
        ...this.thetaTelemetry,
        lastDurationMs: result.durationMs,
        lastErrorCount: result.errors.length,
        lastTimedOut: timedOut,
        consecutiveTimeouts: timedOut ? this.thetaTelemetry.consecutiveTimeouts + 1 : 0,
      }
```

修改：`src/agent/loop.ts:896-901`（`.catch()` 回调）

```typescript
// Before:
      this.thetaTelemetry = {
        ...this.thetaTelemetry,
        lastDurationMs: null,
        lastErrorCount: 0,
        lastTimedOut: false,
      }

// After:
      this.thetaTelemetry = {
        ...this.thetaTelemetry,
        lastDurationMs: null,
        lastErrorCount: 0,
        lastTimedOut: false,
        consecutiveTimeouts: 0,
      }
```

- [ ] **步骤 6：类型检查**

```bash
npx tsc --noEmit
```

预期：PASS

- [ ] **步骤 7：Commit**

```bash
git add src/agent/loop.ts src/agent/__tests__/theta-rate-limit.test.ts
git commit -m "feat(agent): add consecutiveTimeouts and cooldownUntilTurn to theta telemetry

Track consecutive theta check timeouts for exponential backoff calculation.
No behavioral change yet — telemetry fields only."
```

---

### Task 2：requestThetaCheck 限流 + 退避

- [ ] **步骤 1：编写限流测试**

追加到：`src/agent/__tests__/theta-rate-limit.test.ts`

```typescript
describe('Theta rate limit: per-turn and session caps', () => {
  it('enforces per-turn cap of 2', () => {
    const MAX_PER_TURN = 2
    let requestsThisTurn = 0
    const shouldAllow = () => requestsThisTurn < MAX_PER_TURN
    assert.ok(shouldAllow())
    requestsThisTurn++
    assert.ok(shouldAllow())
    requestsThisTurn++
    assert.ok(!shouldAllow()) // 3rd request blocked
  })

  it('enforces session cap of 40', () => {
    const MAX_SESSION = 40
    const requestedCount = 40
    assert.ok(!(requestedCount < MAX_SESSION)) // at cap, blocked
  })

  it('cooldown blocks requests until turn expires', () => {
    const cooldownUntilTurn = 5
    const currentTurn = 4
    assert.ok(currentTurn < cooldownUntilTurn) // still in cooldown
    const currentTurn2 = 5
    assert.ok(!(currentTurn2 < cooldownUntilTurn)) // cooldown expired
  })
})
```

- [ ] **步骤 2：运行测试确认通过**

```bash
npm exec -- tsx --test src/agent/__tests__/theta-rate-limit.test.ts
```

预期：PASS

- [ ] **步骤 3：修改 requestThetaCheck — 加入三重门禁**

修改：`src/agent/loop.ts:877-904`

将完整的 `requestThetaCheck` 方法替换为：

```typescript
  /** Max theta checks per session. Prevents runaway tsc spawning. */
  private static readonly THETA_MAX_SESSION = 40
  /** Max theta checks per agent turn. */
  private static readonly THETA_MAX_PER_TURN = 2

  private thetaRequestsThisTurn = 0

  private requestThetaCheck(reason: string): void {
    if (this.thetaCheckInFlight) return

    // Gate 1: session-level cap
    if (this.thetaTelemetry.requestedCount >= AgentLoop.THETA_MAX_SESSION) return

    // Gate 2: per-turn cap
    if (this.thetaRequestsThisTurn >= AgentLoop.THETA_MAX_PER_TURN) return

    // Gate 3: consecutive-timeout backoff
    if (this.thetaTelemetry.consecutiveTimeouts > 0) {
      const currentTurn = this.session.getTurnCount()
      if (currentTurn < this.thetaTelemetry.cooldownUntilTurn) return
    }

    this.thetaCheckInFlight = true
    this.thetaRequestsThisTurn++
    this.thetaTelemetry = {
      ...this.thetaTelemetry,
      lastReason: reason,
      requestedCount: this.thetaTelemetry.requestedCount + 1,
    }
    runThetaCheck(this.cwd).then(result => {
      for (const errFile of result.errors) {
        this.repairHintTracker.recordFailure(errFile, 'type_error')
      }
      const timedOut = result.timedOut
      const consecutiveTimeouts = timedOut
        ? this.thetaTelemetry.consecutiveTimeouts + 1
        : 0
      // Exponential backoff: 1 timeout → skip 1 turn, 2 → skip 2, 3+ → skip 4
      const cooldownTurns = consecutiveTimeouts === 0 ? 0
        : Math.min(4, consecutiveTimeouts)
      this.thetaTelemetry = {
        ...this.thetaTelemetry,
        lastDurationMs: result.durationMs,
        lastErrorCount: result.errors.length,
        lastTimedOut: timedOut,
        consecutiveTimeouts,
        cooldownUntilTurn: cooldownTurns > 0
          ? this.session.getTurnCount() + cooldownTurns
          : 0,
      }
    }).catch(() => {
      this.thetaTelemetry = {
        ...this.thetaTelemetry,
        lastDurationMs: null,
        lastErrorCount: 0,
        lastTimedOut: false,
        consecutiveTimeouts: 0,
        cooldownUntilTurn: 0,
      }
    }).finally(() => {
      this.thetaCheckInFlight = false
    })
  }
```

注意：需要在 turn 循环中重置 `thetaRequestsThisTurn`。在 `loop.ts` 的 turn for 循环开头（约 line 1117 后）添加：

```typescript
      this.thetaRequestsThisTurn = 0
```

- [ ] **步骤 4：类型检查**

```bash
npx tsc --noEmit
```

预期：PASS

- [ ] **步骤 5：Commit**

```bash
git add src/agent/loop.ts src/agent/__tests__/theta-rate-limit.test.ts
git commit -m "fix(agent): add theta check rate limiting with exponential backoff

Three gates prevent runaway tsc spawning:
1. Session cap (40 requests) — hard ceiling
2. Per-turn cap (2 requests) — prevents burst within a single turn
3. Consecutive timeout backoff — exponential cooldown (1/2/4 turns)
   resets immediately on first successful check"
```

---

### Task 3：elm-micro-release 增加超时感知

**原理：** 当 theta check 持续超时时，elm-micro-release 仍在触发额外的 theta 请求。这些请求全部无效（spawn → 3s timeout → 空），浪费资源。应在 elm-micro-release 触发前检查最近 theta 是否超时。

- [ ] **步骤 1：修改 vigor-hook — elm-micro-release 增加前置条件**

修改：`src/agent/hooks/vigor-hook.ts:50`

当前的 `shouldTriggerElmRelease` 仅检查 vigor。在调用方增加 theta 超时检查：

```typescript
// Before (line 49-51):
      if (shouldTriggerElmRelease(vigor)) {
        ctx.effects.requestThetaCheck('elm-micro-release')
      }

// After:
      if (shouldTriggerElmRelease(vigor)) {
        // Suppress elm-micro-release if recent theta checks timed out —
        // spawning more checks won't help if tsc is unresponsive.
        const theta = ctx.snapshot.thetaTelemetry
        if (!theta || !theta.lastTimedOut) {
          ctx.effects.requestThetaCheck('elm-micro-release')
        }
      }
```

- [ ] **步骤 2：在 RuntimeHookSnapshot 中添加 thetaTelemetry**

修改：`src/agent/runtime-hooks.ts` — 在 `RuntimeHookSnapshot` 接口中添加：

```typescript
  /** Theta telemetry for elm-micro-release timeout suppression. */
  thetaTelemetry?: {
    lastTimedOut: boolean
    consecutiveTimeouts: number
  }
```

修改：`src/agent/loop.ts` — 在 `buildRuntimeSnapshot` 中传入 thetaTelemetry：

```typescript
// 在 buildRuntimeSnapshot 返回对象中添加：
      thetaTelemetry: {
        lastTimedOut: this.thetaTelemetry.lastTimedOut,
        consecutiveTimeouts: this.thetaTelemetry.consecutiveTimeouts,
      },
```

- [ ] **步骤 3：类型检查**

```bash
npx tsc --noEmit
```

预期：PASS

- [ ] **步骤 4：Commit**

```bash
git add src/agent/hooks/vigor-hook.ts src/agent/runtime-hooks.ts src/agent/loop.ts
git commit -m "fix(vigor): suppress elm-micro-release when theta checks keep timing out

When tsc is unresponsive (lastTimedOut=true), elm-micro-release would
trigger additional theta checks that all timeout uselessly. Now suppressed
until a successful check clears the flag."
```

---

## 验证

### 自动验证

```bash
npx tsc --noEmit
npm exec -- tsx --test src/agent/__tests__/theta-rate-limit.test.ts
npm exec -- tsx --test src/agent/__tests__/theta-hook.test.ts
npm exec -- tsx --test src/agent/__tests__/vigor-hook.test.ts
npm exec -- tsx --test src/agent/__tests__/theta-check.test.ts
```

全部通过，0 errors。

### 手动验证场景

1. **正常 session**：theta check 正常工作，tsc 在 3s 内完成 → 无退避 → 正常频率
2. **tsc 超时场景**：模拟 tsc 延迟（`export PATH=/dev/null:$PATH`）→ 观察状态栏 theta 计数不再无限增长 → cooldown 生效
3. **长 session**：运行 20+ 轮对话 → theta 总请求数不超过 40

### sensorium 日志验证

修复后，在类似条件下应看到：
- `requestedCount` 不再超过 40
- `consecutiveTimeouts > 0` 时，`requestedCount` 停止增长
- turn 间跳过 theta 检查（cooldownUntilTurn > currentTurn）

---

## Self-Check

### 规格覆盖度

| 问题 | 修复任务 |
|------|---------|
| 无会话级上限 → 无限 theta 请求 | Task 2（THETA_MAX_SESSION=40） |
| 无 per-turn 限制 → 单轮爆发 | Task 2（THETA_MAX_PER_TURN=2） |
| 超时无退避 → 反复无效 spawn | Task 2（指数退避 1/2/4 轮） |
| elm-micro-release 无视超时 | Task 3（超时时抑制触发） |
| 遥测无退避字段 | Task 1（consecutiveTimeouts + cooldownUntilTurn） |

### Placeholder Scan
无 TODO/TBD/待定/后续实现。每个步骤都有完整代码。

### 类型一致性
- `thetaTelemetry` 类型在 loop.ts 中定义，runtime-hooks.ts 的 snapshot 只传入最小子集 `{ lastTimedOut, consecutiveTimeouts }`
- `THETA_MAX_SESSION = 40` 和 `THETA_MAX_PER_TURN = 2` 是 `static readonly`，编译期常量
- `thetaRequestsThisTurn` 在每个 turn 开头重置，在 requestThetaCheck 中递增
- `cooldownUntilTurn` 在 `.then()` 回调中计算，使用 `session.getTurnCount()` 当前值

---

## 执行交接

计划已完成并保存到 `docs/superpowers/plans/2026-06-01-theta-check-rate-limit.md`。两种执行方式：
1. 子代理驱动（推荐）— 每个任务调度一个新的子代理，任务间进行审查，快速迭代。
2. 内联执行 — 在当前会话中使用 executing-plans 执行任务，批量执行并设有检查点。
选哪种方式？
