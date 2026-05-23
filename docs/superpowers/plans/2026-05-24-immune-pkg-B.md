# Immune 包 B：3 类 danger signal 接入

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（强制使用，每任务一个新 agent）。步骤使用复选框（`- [ ]`）语法跟踪进度。
>
> **🛑 关键执行规则：**
> 1. **每个任务结尾有 STOP 标记**——完成后必须停止，等待用户审查
> 2. **TDD 红绿循环必须留下证据**：测试 commit 在前，实现 commit 在后
> 3. **每任务独立 commit**——不要批量
> 4. **typecheck 用 CLI 真跑**：`npx tsc --noEmit; echo "exit: $?"`
> 5. **集成步骤不可省**：每个 signal 都要有 production caller 可以 grep 验证
> 6. **忽略所有 IDE/LSP 诊断推送**：CLI tsc 是唯一真相，IDE 诊断都跳过
>
> **包 B 共 3 个任务，做完就停。** 不要碰包 C/D。

**包 B 在索引中的位置：** 见 `2026-05-24-immune-completion-index.md`。本包是 P1，依赖包 A（已完成 commits `48e5aec`-`9ebfaf0`）。

**目标：** 让免疫系统能感知到 3 类外部信号（trajectoryHealth + tokenUsage 已经在 ctx 接口里但调用点没传，compaction 失败和 sycophancy 触发完全无信号）。

**架构：** 现状是 `immune-hook.ts:26-34` 的 `ImmuneHookContext` 已声明了 `tokenUsage?` 和 `trajectoryHealth?` 字段，但 `loop.ts:542-548` 的 `immuneHook.run({...})` 调用点没传这两个值——纯 wire 任务。compaction 和 sycophancy 需要新增一个 `injectSignal(signal)` 方法供外部主动注入。

**技术栈：** TypeScript / 现有 ImmuneHook + ApcAggregator + InnateLayer

**前置阅读（执行前必读，不要跳过）：**

读这些再开始，避免基于错误假设动手：

- `src/agent/immune-hook.ts` 行 26-145——`ImmuneHookContext` 接口、`run` 方法、可见 `apc` 字段（行 47），便于加 `injectSignal`
- `src/agent/immune-types.ts` 行 8-17——`DangerSignalKind` 已有 `'compaction_fail'` 和 `'sycophancy_detected'` 枚举值
- `src/agent/immune-apc.ts` 行 18-19——`apc.collect(signal)` 是注入入口
- `src/agent/loop.ts` 行 524-548——trajectoryHealth signal 在 524-538 计算（变量名 `signal`，目前只用于 model switch），542-548 是 `immuneHook.run()` 调用点
- `src/agent/loop.ts` 行 898-907——compaction 调用点；`compactResult.failures.consecutiveFailures` 是失败计数
- `src/agent/loop.ts` 行 1047-1067——sycophancy trap recordTurn 和 getHint 调用点
- `src/agent/sycophancy-trap.ts` 行 36-51——`shouldInjectChallenge()` 是触发判断（已存在的公共方法）

**关键架构发现：**
1. `trajectoryHealth` 已经在 `loop.ts:532` 算出来了（变量 `signal`），只需把它**提升到外层作用域**并传给 immuneHook（原 1389 行计划提示了这点）
2. `getEstimatedTokens()` 在 session 上是公共方法，可直接调用（loop.ts 多处已用）
3. `ImmuneHook` 当前没有 `injectSignal`，但 `apc` 字段是 `readonly public`，外部可以直接 `hook.apc.collect(...)`——但加个 `injectSignal` 包装更干净
4. `DangerSignalKind` 已包含 `compaction_fail` 和 `sycophancy_detected`，**不需要扩展类型**

---

## 任务 3：trajectoryHealth + tokenUsage 接入 immuneHook.run()

**文件：**
- 修改：`src/agent/loop.ts`（提升 trajectoryHealth signal 作用域 + 传 tokenUsage）
- 创建：`src/agent/__tests__/immune-context-wiring.test.ts`

**关键架构点：**
- 不动 `ImmuneHookContext` 接口（字段已存在）
- 不动 `immune-hook.ts` 内部逻辑（trajectoryHealth 处理在 74-84 行已实现）
- 只在 loop.ts 把 `signal` 变量从 if 块内提升到外层，然后传给 `immuneHook.run({..., tokenUsage, trajectoryHealth: signal})`

- [ ] **步骤 1：编写失败的测试**

文件 `src/agent/__tests__/immune-context-wiring.test.ts`：

```typescript
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { ImmuneHook } from '../immune-hook.js'
import { PhysarumEngine } from '../../repo/physarum-engine.js'

describe('ImmuneHook context wiring', () => {
  it('emits prediction_error severity 0.9 when trajectoryHealth=escalate', () => {
    const hook = new ImmuneHook({ physarum: new PhysarumEngine(null as any) })
    const result = hook.run({
      toolName: 'bash', fingerprint: 'fp_x', turn: 1,
      doomLevel: 'none', trajectoryHealth: 'escalate',
    })
    const sigs = result.signals.filter(s => s.kind === 'prediction_error' && s.source === 'atropos')
    assert.equal(sigs.length, 1)
    assert.equal(sigs[0]!.severity, 0.9)
  })

  it('emits prediction_error severity 0.5 when trajectoryHealth=degrading', () => {
    const hook = new ImmuneHook({ physarum: new PhysarumEngine(null as any) })
    const result = hook.run({
      toolName: 'bash', fingerprint: 'fp_y', turn: 1,
      doomLevel: 'none', trajectoryHealth: 'degrading',
    })
    const sigs = result.signals.filter(s => s.kind === 'prediction_error' && s.source === 'atropos')
    assert.equal(sigs.length, 1)
    assert.equal(sigs[0]!.severity, 0.5)
  })

  it('does not emit prediction_error when trajectoryHealth=healthy', () => {
    const hook = new ImmuneHook({ physarum: new PhysarumEngine(null as any) })
    const result = hook.run({
      toolName: 'bash', fingerprint: 'fp_z', turn: 1,
      doomLevel: 'none', trajectoryHealth: 'healthy',
    })
    const sigs = result.signals.filter(s => s.source === 'atropos')
    assert.equal(sigs.length, 0)
  })

  it('passes tokenUsage to InnateLayer for token_spike detection', () => {
    const hook = new ImmuneHook({ physarum: new PhysarumEngine(null as any) })
    // Establish baseline at low token count
    for (let i = 0; i < 4; i++) {
      hook.run({
        toolName: 'bash', fingerprint: `fp_base_${i}`, turn: i,
        doomLevel: 'none', tokenUsage: 1000,
      })
    }
    // Spike at 5x baseline
    const result = hook.run({
      toolName: 'bash', fingerprint: 'fp_spike', turn: 5,
      doomLevel: 'none', tokenUsage: 5000,
    })
    const spikes = result.signals.filter(s => s.kind === 'token_spike')
    assert.ok(spikes.length >= 1, `expected token_spike signal, got: ${JSON.stringify(result.signals)}`)
  })
})
```

- [ ] **步骤 2：运行测试验证 FAIL（红色阶段）**

运行：`npx tsx --test src/agent/__tests__/immune-context-wiring.test.ts`

预期结果分析：
- 测试 1、2、3、4 应该都 PASS——因为 `ImmuneHook.run` 内部已经处理 trajectoryHealth 和 tokenUsage 字段（72-84 行 + InnateLayer 通过 ctx.tokenUsage）

如果测试 1-3 实际 PASS，说明 immune-hook 内部逻辑已经支持。但**任务 3 的真正问题是 loop.ts 调用点没传字段**——所以这是个**集成测试**，不是单元测试。

调整方向：**步骤 1 的测试是验证 ImmuneHook.run 行为正确**（应该 PASS）。任务 3 的核心红绿循环是在 loop.ts 上做集成，但 loop.ts 集成测试很重。改用更小范围的"行为存在"断言：

**步骤 1（修订）：** 把测试改成 ImmuneHook 单元行为测试（应该已 PASS），然后在步骤 2 改用 grep 验证 loop.ts 调用点。

实际操作：
1. 跑步骤 1 的测试，应该 4/4 PASS（说明 ImmuneHook 端已就绪）
2. 跑 `grep -n "trajectoryHealth\|tokenUsage" src/agent/loop.ts` ——如果 immuneHook.run 调用点没出现这两个字段名，就是红色信号

```bash
grep -A 8 "this.immuneHook.run" src/agent/loop.ts
```

预期当前输出（红色）：

```
this.immuneHook.run({
  toolName: name,
  fingerprint: fp,
  turn: this.session.getTurnCount(),
  doomLevel: this.getDoomLoopLevel(),
  targetFile: target,
})
```

没有 `trajectoryHealth` 和 `tokenUsage`。任务目标就是补上。

- [ ] **步骤 3：先 commit 测试**

```bash
git add src/agent/__tests__/immune-context-wiring.test.ts
git commit -m "test(immune): assert hook handles trajectoryHealth + tokenUsage context"
```

- [ ] **步骤 4：在 loop.ts 提升 trajectoryHealth signal 到外层**

读 `src/agent/loop.ts` 行 520-548，定位精确。

当前结构：
```typescript
if (this.config.onModelSwitch && this.config.getCurrentModel) {
  // ...
  if (tier === 'flash') {
    // ...
    const signal = this.p3.assessHealth(recentEvents, this.session.getTurnCount(), tier)
    if (signal === 'escalate') {
      const proModel = currentModelId.replace('flash', 'pro')
      try { this.config.onModelSwitch(proModel) } catch { /* non-fatal */ }
    }
  }
}

// Physarum + Immune: postTool danger signal collection + adaptive response
const fp = this.traceStore.toolFingerprints[...]
this.immuneHook.run({
  toolName: name,
  fingerprint: fp,
  turn: this.session.getTurnCount(),
  doomLevel: this.getDoomLoopLevel(),
  targetFile: target,
})
```

改成：

```typescript
// P3-D Atropos: assess trajectory health → auto-escalate Flash→Pro on repeated failures
let trajectoryHealth: HealthSignal = 'healthy'
if (this.config.onModelSwitch && this.config.getCurrentModel) {
  const currentModelId = this.config.getCurrentModel()
  const tier: 'flash' | 'pro' = currentModelId.includes('pro') ? 'pro' : 'flash'
  if (tier === 'flash') {
    const recentEvents = this.traceStore.events.slice(-10).map(e => ({
      status: (e.status === 'passed' ? 'passed' : 'failed') as 'passed' | 'failed',
      turn: e.turn,
    }))
    trajectoryHealth = this.p3.assessHealth(recentEvents, this.session.getTurnCount(), tier)
    if (trajectoryHealth === 'escalate') {
      const proModel = currentModelId.replace('flash', 'pro')
      try { this.config.onModelSwitch(proModel) } catch { /* non-fatal */ }
    }
  }
}

// Physarum + Immune: postTool danger signal collection + adaptive response
const fp = this.traceStore.toolFingerprints[this.traceStore.toolFingerprints.length - 1] ?? name
this.immuneHook.run({
  toolName: name,
  fingerprint: fp,
  turn: this.session.getTurnCount(),
  doomLevel: this.getDoomLoopLevel(),
  targetFile: target,
  tokenUsage: this.session.getEstimatedTokens(),
  trajectoryHealth,
})
```

注意：
- `HealthSignal` 类型可能需要 import：`import type { HealthSignal } from './trajectory-health.js'`——先 grep 看 loop.ts 顶部是否已 import；没有就加
- `let trajectoryHealth: HealthSignal = 'healthy'` 这行用 let，因为 if 块内可能改写
- `this.p3.assessHealth` 不变，只是把返回值赋给外层变量
- 改写时**保留原 escalate 时 model switch 的逻辑**，不要破坏

- [ ] **步骤 5：跑 typecheck**

运行：`npx tsc --noEmit; echo "exit: $?"`

预期：exit 0

如果失败：
- `Cannot find name 'HealthSignal'` — 加 import
- `Type ... is not assignable to type 'HealthSignal'` — 看 trajectory-health.ts 实际类型，可能是 `'healthy' | 'degrading' | 'escalate'`

- [ ] **步骤 6：跑测试验证集成**

运行：`npx tsx --test src/agent/__tests__/immune-context-wiring.test.ts`

预期：4/4 PASS

跑 grep 验证 loop.ts 集成：

```bash
grep -A 9 "this.immuneHook.run" src/agent/loop.ts
```

预期输出包含 `trajectoryHealth` 和 `tokenUsage` 两行。

- [ ] **步骤 7：跑全量 immune 测试无回归**

```bash
npx tsx --test 'src/agent/__tests__/immune-*.test.ts'
```

预期：所有 immune 测试通过（包 A 完成时为 27/27 + 任务 3 新增的 4 = 31/31）

- [ ] **步骤 8：Commit**

```bash
git add src/agent/loop.ts
git commit -m "feat(immune): wire trajectoryHealth + tokenUsage into immune hook context"
```

- [ ] 🛑 **STOP** —— 任务 3 完成。报告：
  - 两个 commit SHA
  - `npx tsc --noEmit; echo "exit: $?"` 输出
  - `grep -A 9 "this.immuneHook.run" src/agent/loop.ts` 输出（确认 trajectoryHealth 和 tokenUsage 都在）
  - immune 测试通过数

  **不要继续任务 4。**

---

## 任务 4：injectSignal 方法 + compaction_fail 接入

**文件：**
- 修改：`src/agent/immune-hook.ts`（添加 `injectSignal` 方法）
- 修改：`src/agent/loop.ts`（compaction 失败时调用 `injectSignal`）
- 修改：`src/agent/__tests__/immune-context-wiring.test.ts`（追加 injectSignal 测试）

**关键架构点：**
- `ApcAggregator` 已有 `collect(signal)`，`injectSignal` 是薄包装
- compaction 失败的判定信号：`compactResult.failures.consecutiveFailures > 0`，越高越严重
- severity 计算：`Math.min(1.0, consecutiveFailures * 0.3)`——1 次 0.3、2 次 0.6、3+ 次 0.9-1.0

- [ ] **步骤 1：在测试文件追加 injectSignal 测试**

追加到 `src/agent/__tests__/immune-context-wiring.test.ts`：

```typescript
describe('ImmuneHook injectSignal', () => {
  it('accepts external compaction_fail signal and surfaces it via apc', () => {
    const hook = new ImmuneHook({ physarum: new PhysarumEngine(null as any) })
    hook.injectSignal({
      kind: 'compaction_fail',
      severity: 0.6,
      turn: 10,
      source: 'compaction-controller',
    })
    // Trigger evaluation by running with doom pattern matching window
    // (apc.evaluate filters signals by SIGNAL_WINDOW; injecting at turn 10 then running at turn 11 must keep it)
    const result = hook.run({
      toolName: 'bash', fingerprint: 'fp_xx', turn: 11,
      doomLevel: 'warn',
    })
    // Both pattern (doom warn) and danger signal present → activated
    assert.equal(result.activated, true, `expected activation, got signals: ${JSON.stringify(result.signals)}`)
  })

  it('injectSignal does not crash when called many times', () => {
    const hook = new ImmuneHook({ physarum: new PhysarumEngine(null as any) })
    for (let i = 0; i < 200; i++) {
      hook.injectSignal({
        kind: 'compaction_fail', severity: 0.5,
        turn: i, source: 'test',
      })
    }
    // Should not throw — apc has internal cap (MAX_SIGNALS)
    assert.ok(true)
  })
})
```

- [ ] **步骤 2：跑测试验证 FAIL**

运行：`npx tsx --test src/agent/__tests__/immune-context-wiring.test.ts`

预期：新加的 2 个测试 FAIL，错误为 `hook.injectSignal is not a function`。

- [ ] **步骤 3：commit 测试**

```bash
git add src/agent/__tests__/immune-context-wiring.test.ts
git commit -m "test(immune): assert injectSignal entry point"
```

- [ ] **步骤 4：在 immune-hook.ts 添加 injectSignal 方法**

在 `src/agent/immune-hook.ts` 找到 `recordRepairFailure` 方法（约行 153）：

```typescript
/** Record failed repair */
recordRepairFailure(fingerprint: string): void {
  this.adaptive.recordFailure(fingerprint)
}
```

在它**之后**添加：

```typescript
/** Inject external danger signal (e.g., from compaction failure, sycophancy trap, prompt injection detection) */
injectSignal(signal: DangerSignal): void {
  this.apc.collect(signal)
}
```

注意：`DangerSignal` 已经在文件顶部 import（行 15）。如果没有就加。

- [ ] **步骤 5：跑测试验证通过**

运行：`npx tsx --test src/agent/__tests__/immune-context-wiring.test.ts`

预期：6/6 PASS（4 + 2）

- [ ] **步骤 6：在 loop.ts compaction 失败处发射信号**

读 `src/agent/loop.ts` 行 898-907：

```typescript
const compactResult = await this.compaction.maybeCompact({
  loopTurn: turn,
  failures: this.compactFailures,
})
this.compactFailures = compactResult.failures
if (compactResult.compacted) {
  this.lastCompactTurn = turn
  // Hint V8 to release freed message objects sooner
  if (typeof globalThis.gc === 'function') globalThis.gc()
}
```

在 `this.compactFailures = compactResult.failures` **之后**、`if (compactResult.compacted)` **之前**插入：

```typescript

// Immune signal: surface compaction failures as danger signal for dual-signal gating
if (this.compactFailures.consecutiveFailures > 0) {
  try {
    this.immuneHook.injectSignal({
      kind: 'compaction_fail',
      severity: Math.min(1.0, this.compactFailures.consecutiveFailures * 0.3),
      turn,
      source: 'compaction-controller',
    })
  } catch { /* non-critical */ }
}
```

注意：
- `turn` 是 loop 中已存在的局部变量（从 `for/while` 循环来）。grep 验证一下：`grep -B 2 "compactResult = await" src/agent/loop.ts | head -10`
- 缩进与上下文一致（应该是 8 空格——在 try/catch 或 while 块内）

- [ ] **步骤 7：跑 typecheck**

运行：`npx tsc --noEmit; echo "exit: $?"`

预期：exit 0

- [ ] **步骤 8：跑全量测试**

```bash
npx tsx --test 'src/agent/__tests__/immune-*.test.ts'
npm test 2>&1 | tail -20
```

预期：immune 测试全过；npm test 仅 startup-memory 预存失败。

- [ ] **步骤 9：grep 验证集成**

```bash
grep -n "injectSignal\|compaction_fail" src/agent/loop.ts src/agent/immune-hook.ts
```

预期：
- `immune-hook.ts` 有 `injectSignal` 方法定义
- `loop.ts` 有 `injectSignal({ kind: 'compaction_fail', ...})` 调用

- [ ] **步骤 10：Commit**

```bash
git add src/agent/immune-hook.ts src/agent/loop.ts
git commit -m "feat(immune): emit compaction_fail danger signal on persistent compaction failures"
```

- [ ] 🛑 **STOP** —— 任务 4 完成。报告：
  - 两个 commit SHA（test commit + impl/wire commit）
  - `npx tsc --noEmit` exit code
  - grep 验证输出
  - 测试通过数

  **不要继续任务 5。**

---

## 任务 5：sycophancy_detected signal 接入

**文件：**
- 修改：`src/agent/loop.ts`（sycophancy trap 触发时 injectSignal）
- 修改：`src/agent/__tests__/immune-context-wiring.test.ts`（追加 sycophancy 测试）

**关键架构点：**
- `sycophancyTrap.shouldInjectChallenge()` 是已有公共方法（行 18）
- 不动 sycophancy-trap.ts 内部逻辑
- 只在 loop.ts `recordTurn` 之后检查 `shouldInjectChallenge()` 是否首次返回 true，发射 signal
- 防重复发射：用一个 flag 跟踪上次发射状态，只在 false→true 跃迁时发射（避免每 turn 都发）

- [ ] **步骤 1：追加测试**

追加到 `src/agent/__tests__/immune-context-wiring.test.ts`：

```typescript
describe('ImmuneHook sycophancy_detected signal', () => {
  it('accepts injected sycophancy_detected signal', () => {
    const hook = new ImmuneHook({ physarum: new PhysarumEngine(null as any) })
    hook.injectSignal({
      kind: 'sycophancy_detected',
      severity: 0.7,
      turn: 5,
      source: 'sycophancy-trap',
    })
    const result = hook.run({
      toolName: 'bash', fingerprint: 'fp_syc', turn: 6,
      doomLevel: 'warn',
    })
    assert.equal(result.activated, true)
    // Signal should be in the activation evidence (apc returns recent signals)
  })
})
```

- [ ] **步骤 2：跑测试验证 PASS（已 wire `injectSignal`）**

运行：`npx tsx --test src/agent/__tests__/immune-context-wiring.test.ts`

预期：所有 7 个测试 PASS（任务 4 后 injectSignal 已就绪，任务 5 步骤 1 的测试是验证不同 signal kind 可注入）

- [ ] **步骤 3：commit 测试**

```bash
git add src/agent/__tests__/immune-context-wiring.test.ts
git commit -m "test(immune): assert sycophancy_detected signal can be injected"
```

- [ ] **步骤 4：在 loop.ts 添加 sycophancy 状态跟踪字段**

找到 `private sycophancyTrap: SycophancyTrap = createSycophancyTrap()`（约 202 行）。在它之后添加：

```typescript
private sycophancyWasActive = false
```

- [ ] **步骤 5：在 sycophancy.recordTurn 之后发射 signal**

读 `src/agent/loop.ts` 行 1047 附近的 `this.sycophancyTrap.recordTurn(...)` 调用：

```typescript
this.sycophancyTrap.recordTurn({
  agreedWithUser: ...,
  confidence: ...,
})
```

在 recordTurn **之后**插入：

```typescript

// Immune signal: surface new sycophancy detection as danger signal (rising edge only)
const sycActive = this.sycophancyTrap.shouldInjectChallenge()
if (sycActive && !this.sycophancyWasActive) {
  try {
    this.immuneHook.injectSignal({
      kind: 'sycophancy_detected',
      severity: 0.7,
      turn: this.session.getTurnCount(),
      source: 'sycophancy-trap',
    })
  } catch { /* non-critical */ }
}
this.sycophancyWasActive = sycActive
```

注意：
- 缩进与 recordTurn 调用同级
- "rising edge only"——避免每 turn 都发射，只在 false→true 跃迁发射一次
- 等到 sycophancy 自然 reset 或不满足条件回到 false，下次再触发才会再发射

- [ ] **步骤 6：跑 typecheck**

运行：`npx tsc --noEmit; echo "exit: $?"`

预期：exit 0

- [ ] **步骤 7：跑全量测试**

```bash
npx tsx --test 'src/agent/__tests__/immune-*.test.ts'
npm test 2>&1 | tail -10
```

预期：immune 测试全过；npm test 仅 startup-memory 预存失败。

- [ ] **步骤 8：grep 验证集成**

```bash
grep -n "sycophancy_detected\|sycophancyWasActive" src/agent/loop.ts
```

预期：3 个匹配（1 个字段声明 + 1 个 signal kind 字符串 + 1 个 wasActive 状态更新）。

- [ ] **步骤 9：Commit**

```bash
git add src/agent/loop.ts
git commit -m "feat(immune): emit sycophancy_detected signal on rising-edge trap activation"
```

- [ ] 🛑 **STOP** —— 任务 5 完成（包 B 全部完成）。报告：
  - 6 个 commit SHA（任务 3、4、5 各 2 个）
  - `npx tsc --noEmit` exit code
  - 全量 grep 验证：
    ```bash
    grep -n "trajectoryHealth\|tokenUsage" src/agent/loop.ts | grep "immuneHook"
    grep -n "compaction_fail\|sycophancy_detected" src/agent/loop.ts
    grep -n "injectSignal" src/agent/immune-hook.ts src/agent/loop.ts
    ```
  - 全量测试通过统计
  - 一句话总结：包 B 是否可以交付包 C

  **包 B 到此结束。** 包 C 在用户审查后写。

---

## 包 B 自检清单（用户审查时用）

- [ ] 6 个独立 commit（不批量）
- [ ] TDD 痕迹：每任务都是先 test commit、后 impl/wire commit
- [ ] `loop.ts` immuneHook.run 调用点有 trajectoryHealth + tokenUsage（grep 验证）
- [ ] `loop.ts` 有 `injectSignal({ kind: 'compaction_fail', ... })` 真调用（不只是定义）
- [ ] `loop.ts` 有 `injectSignal({ kind: 'sycophancy_detected', ... })` 真调用（rising edge）
- [ ] `immune-hook.ts` 新增 `injectSignal(signal: DangerSignal)` 方法
- [ ] `npx tsc --noEmit` exit 0
- [ ] 全量测试无新增失败

## 包 B 之外（不做）

- 任务 6：fastRepair 策略丰富化（包 C）
- 任务 7：Pheromone 完整化（包 C）
- 任务 8：notebook 双向同步（包 D）
- `recordRepairSuccess` 孤儿清理（包 D）

如果发现包 B 修改间接破坏了别的功能（比如某测试在改 loop.ts 后报错），**只修该测试**，不要扩大范围。
