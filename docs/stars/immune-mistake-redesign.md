# Immune + Mistake 系统重设计

> 状态：诊断完成，待确认后实现
> 日期：2026-05-25

## 一、当前架构总览

```
┌──────────────────────────────────────────────────┐
│                   tool-pipeline.ts                │
│                                                   │
│  ┌─ 读路径 (err) ─┐    ┌─ 写路径 (ok) ─────────┐ │
│  │ getMistakeHints │    │ detectMistakeResolution│ │
│  │   ↓             │    │   ↓                    │ │
│  │ 注入到错误输出   │    │ recordMistake          │ │
│  │                 │    │   ↓                    │ │
│  │                 │    │ recordRepairSuccess ─┐  │ │
│  └─────────────────┘    └──────────────────────┼─┘ │
│                                                 │  │
└─────────────────────────────────────────────────┼──┘
                                                  │
     ┌────────────────────────────────────────────┘
     │
     ▼
┌─────────────┐     ┌──────────────┐
│ P3Integration│◄────│MistakeNotebook│
│  (facade)   │     │ SHA256 dedup │
│             │     │ token overlap│
└─────────────┘     └──────────────┘

     ┌────────────────────────────────────────────┐
     │            immune-hook.ts (主钩子)           │
     │                                              │
     │  loop.ts 每轮调用 run():                      │
     │  0.feed_physarum → 1.innate → 2.trajectory   │
     │  → 3.physarum_anomaly → 4.collect_APC        │
     │  → 5.gating → 6.adaptive → 7.apply           │
     │  → 8.stigmergy                               │
     │                                              │
     │  外部 API:                                    │
     │  - recordRepairSuccess(fingerprint, resp)     │
     │  - recordRepairFailure(fingerprint)           │
     │  - injectSignal(signal)                       │
     └──────────────┬───────────────────────────────┘
                    │
       ┌────────────┼────────────┐
       ▼            ▼            ▼
  ┌─────────┐ ┌──────────┐ ┌─────────┐
  │ innate  │ │ adaptive │ │   APC   │
  │ 2规则   │ │ 记忆系统  │ │ 聚合门控 │
  │ tool_   │ │ 亲和分   │ │ 双信号  │
  │ repeat  │ │ 负选择   │ │ ≥1.2   │
  │ token_  │ │ 衰减     │ │         │
  │ spike   │ │ max=100  │ │ win=10  │
  └─────────┘ └──────────┘ └─────────┘
```

### 关键数字

| 指标 | 值 |
|------|-----|
| 源文件 | 9 个 |
| 测试文件 | 9 个 |
| 信号类型 | 7 种 |
| 内部可触发的信号 | 4 种（tool_repeat, token_spike, prediction_error, graph_anomaly） |
| 外部注入才能触发的信号 | 3 种（compaction_fail, repair_exhaustion, sycophancy_detected） |
| 记忆上限 | 100 |
| 记忆衰减阈值 | >100 turn |
| 记忆删除阈值 | >200 turn + 低亲和 |
| APC 信号窗口 | 10 turns |
| APC 激活门槛 | dangerScore ≥ 1.2 |
| Mistake 查询阈值 | token overlap > 0.2 |
| Mistake 查询长度 | 300 chars |

---

## 二、问题诊断

### P0: 两个系统之间没有真正的闭环

文档说 "Mistake ↔ Immune 闭环"，实际代码中是**单向的**：

```
tool 成功 → detectMistakeResolution → recordMistake
                                     → recordRepairSuccess (immune)
```

- Mistake 存入了 notebook，Immune 更新了记忆亲和分
- 但 Immune 做决策时**从不查询 Mistake 历史**
- Mistake 做匹配时**从不参考 Immune 的模式记忆**
- 完全是两条平行线，在 tool-pipeline 的同一段代码里被先后调用，仅此而已

### P1: Immune 的学习成果不会注入上下文

Immune 学习了哪些文件危险、哪些模式有害。但这些信息**从未进入模型的上下文窗口**。Immune 只影响 Physarum 图结构（隔离边、修剪毒性边、增强健康边），不产生任何文本输出。

对比 Mistake：`getMistakeHints()` 返回 XML 格式的提示文本，直接注入到工具错误输出中，模型能看到。

结果：模型见过 mistake hints，但从未见过 immune 的"这是危险模式"警告。

### P2: 7 种信号，3 种靠外部注入

| 信号 | 触发方式 | 实际来源 |
|------|----------|----------|
| tool_repeat | innate 层自动检测 | ✅ 内部 |
| token_spike | innate 层自动检测 | ✅ 内部 |
| prediction_error | hook 从 trajectory 推断 | ✅ 内部 |
| graph_anomaly | hook 从 physarum 推断 | ✅ 内部 |
| compaction_fail | **仅 injectSignal** | ❌ 无人调用 |
| repair_exhaustion | **仅 injectSignal** | ❌ 无人调用 |
| sycophancy_detected | **仅 injectSignal** | ❌ 无人调用 |

后三种信号在当前代码中**没有任何内生触发逻辑**。它们只是类型定义中的占位符。

### P3: APC 双信号门控 + 纯求和阈值

```typescript
// immune-apc.ts
const ACTIVATION_THRESHOLD = 1.2
const SIGNAL_WINDOW = 10  // turns

evaluate(patternMatch: boolean, currentTurn: number): ActivationDecision {
  if (!patternMatch) return { shouldActivate: false, ... }  // ← 先决条件

  const recent = this.signals.filter(s => currentTurn - s.turn <= SIGNAL_WINDOW)
  const dangerScore = recent.reduce((sum, s) => sum + s.severity, 0)  // ← 纯求和，非均值
  const shouldActivate = dangerScore >= ACTIVATION_THRESHOLD
  ...
}
```

问题：
1. **必须先有 patternMatch**：`patternMatch` 来自 adaptive 层记忆匹配，如果从未有过相关记忆（冷启动），则即使 dangerScore 再高也不会激活
2. **纯求和式阈值**：severity ∈ [0,1]，10-turn 窗口内需要累计 ≥1.2。虽然比均值式宽松，但结合 patternMatch 前置条件，实际可达性是：patternMatch **且** 至少有 2 个中等 severity 信号在 10 turns 内
3. 冷启动时 adaptive 记忆为空 → patternMatch 永远不会 true → 免疫系统在会话早期完全静默

### P4: Mistake 查询召回率不足

```typescript
// mistake-notebook.ts
const queryTokens = tokenize(query.slice(0, 300))  // 最多 300 chars
const overlap = intersection(entryTokens, queryTokens).size / union(...).size
return overlap > 0.2  // 阈值 0.2
```

问题：
1. 300 chars 的切片可能截断关键信息
2. 简单 token overlap 无法捕获语义相似性（"file not found" vs "ENOENT" → 0 overlap）
3. 阈值 0.2 对短错误消息不友好

### P5: Mistake hints 只在错误发生后注入

`getMistakeHints()` 只在工具返回 `isError` 时才被调用。但最有价值的提示应该是**阻止错误发生**，而不是在错误发生后才告知"你以前犯过这个错"。

### P6: 没有 Immune 有效性度量

Immune 执行了隔离/修剪/增强操作后，没有任何反馈回路来测量这些操作是否真的改善了后续行为。系统不知道自己的干预是帮助了还是阻碍了。

---

## 三、目标设计原则

1. **Mistake → Immune 真正闭环**：Immune 在做激活决策时查询 Mistake 历史，Mistake 的匹配也参考 Immune 的模式
2. **Immune 学习成果注入上下文**：模型能看到 immune 的警告和建议，不只是 physarum 图的变化
3. **信号内生化**：compaction_fail、repair_exhaustion、sycophancy_detected 应该有实际的触发逻辑
4. **APC 门控合理化**：降低门槛或改用更灵活的激活策略
5. **Mistake 前置化**：在工具执行前注入相关提示，而非仅在错误后
6. **可度量**：每次 immune 响应后跟踪效果

---

## 四、重设计方案

### 4.1 闭环：ImmuneContextInjector

新增一个轻量模块，在 Immune 做出激活决策后、Physarum 操作执行前，生成可注入上下文的文本：

```typescript
// 新文件: src/agent/immune-context.ts

interface ImmuneContextHint {
  level: 'warning' | 'danger' | 'ban'
  signalKinds: DangerSignalKind[]
  matchedMistakes: MistakeEntry[]    // ← 闭环！查询 MistakeNotebook
  suggestion: string                  // 人类可读的建议
}

function generateImmuneContext(
  decision: ActivationDecision,
  notebook: MistakeNotebook,
  turn: number
): ImmuneContextHint | null
```

这个 hint 会被注入到**下一轮**的 system context 中，或在当前轮作为工具的额外 metadata 返回。模型能看到类似：

```
<immune-signal level="warning">
  Pattern "read_file on already-open files" has 3 prior incidents.
  Matching mistakes: [2026-05-24: read_file returned [pruned], fixed by using smaller offset]
  Suggestion: use smaller offset/limit values when re-reading files.
</immune-signal>
```

### 4.2 APC 门控调整

```typescript
// 修改 immune-apc.ts

// 现有逻辑：
//   patternMatch === false → 直接返回不激活（冷启动盲区）
//   dangerScore = sum(severity)  // 纯求和
//   threshold = dangerScore >= 1.2

// 新：三档门控 + patternMatch 软化
evaluate(patternMatch: boolean, currentTurn: number, mistakeCount: number): ActivationDecision {
  const recent = this.signals.filter(s => currentTurn - s.turn <= SIGNAL_WINDOW)
  const dangerScore = recent.reduce((sum, s) => sum + s.severity, 0)

  // 软化 patternMatch：如果有 mistake 佐证，降低对记忆匹配的依赖
  const effectiveMatch = patternMatch || (mistakeCount > 0 && dangerScore >= 0.8)

  if (!effectiveMatch) {
    return { shouldActivate: false, confidence: 0, signals: [] }
  }

  // 三档门控
  let responseType: ImmuneResponseType | null = null
  if (dangerScore >= 1.5)    responseType = 'quarantine'       // 高置信
  else if (dangerScore >= 1.0) responseType = 'prune_toxic'    // 中置信
  else if (dangerScore >= 0.6) responseType = 'deposit_warning' // 低置信但有佐证

  return {
    shouldActivate: responseType !== null,
    confidence: Math.min(dangerScore / 2, 1),
    signals: recent,
    responseType,
  }
}
```

关键变更：
- `patternMatch` 不再是一票否决，`mistakeCount > 0` 可作为替代佐证
- 三档阈值替代单阈值，最低档 (0.6) 只 deposit_warning
- 冷启动时，只要 innate 层产生 ≥ 0.8 的信号 + 有 mistake 记录，就可以走到激活路径

### 4.3 信号内生化

给三种"空壳"信号添加实际检测：

**compaction_fail**：
- 在 `tool-pipeline.ts` 中检测：如果 read_file 返回 `[pruned]` 或 `[diet:redundant]`，且文件 < 500 行 → 说明压缩系统出错 → inject signal

**repair_exhaustion**：
- 在 `immune-hook.ts` 中检测：如果同一 fingerprint 的 `recordRepairFailure` 连续 ≥ 3 次 → inject signal

**sycophancy_detected**：
- 在 `loop.ts` 中检测：如果连续 N 轮模型的响应都是"是的，你说得对"模式 → inject signal。检测方法：计算响应中肯定性短语 (agreement phrases) 的密度，超过阈值触发。

### 4.4 Mistake 前置注入

```typescript
// 修改 tool-pipeline.ts，在工具执行前插入

// 新：P3-A pre-exec hook
const preHints = deps.p3.getMistakeHints(tu.name, tu.args?.filePath ?? '')
// 不等待错误发生就查询是否有相关 mistake
// 在 tool call 参数中附加 hint（通过 metadata 而非 content）
```

对于能确定目标的工具（如 read_file, write_file），在调用前查询该目标文件是否有相关 mistake 记录，如果有则作为额外上下文传递给工具执行环境。

### 4.5 Immune 有效性反馈

```typescript
// 修改 immune-hook.ts: recordRepairSuccess

// 在记录修复成功后，额外记录一个"免疫效果评估"
interface ImmuneEffectRecord {
  turn: number
  activation: ActivationDecision
  outcome: 'success' | 'failure' | 'unknown'
  turnsToResolve: number         // 从激活到解决的轮数
  fingerprint: string
}
```

定期（每 30 turns）汇总：
- 哪些免疫响应的成功率 > 80%
- 哪些响应类型从未生效 → 降级或移除

---

## 五、实现计划

### Phase 1: 闭环 + 上下文注入（3 文件）

1. **新建 `src/agent/immune-context.ts`** (~80 行)
   - `generateImmuneContext()` 函数
   - 查询 MistakeNotebook，生成可注入 text

2. **修改 `src/agent/immune-hook.ts`** 
   - 接受 `MistakeNotebook` 引用
   - 在 step 7 (apply) 之前调用 `generateImmuneContext`
   - 返回 `ImmuneContextHint | null` 供调用方注入

3. **修改 `src/agent/loop.ts`**
   - 在 system context 中注入 immune hint
   - 使用 `<immune-signal>` wrapper

### Phase 2: APC 门控 + 信号内生（3 文件）

4. **修改 `src/agent/immune-apc.ts`**
   - 三档门控替代单阈值

5. **修改 `src/agent/tool-pipeline.ts`**
   - 检测 `[pruned]` / `[diet:redundant]` → inject compaction_fail signal

6. **修改 `src/agent/immune-hook.ts`**
   - 检测 repair 连续失败 → inject repair_exhaustion signal

### Phase 3: Mistake 前置 + 效果度量 + TDD Gate（5 子任务，4 文件）

> **进度标注（2026-05-25）：**
> - 7a ✅ 已实现 | 7b 🔲 待实现 | 8 🔲 待实现 | 9 ✅ 已实现 | 10 🔲 待实现

#### 7a. [已完成] 后置 Mistake 注入（错误路径）

- 位置：`src/agent/tool-pipeline.ts:586-591`
- 触发：工具执行失败后，在错误输出末尾追加 `<mistake-hints>`
- 查询输入：`finalContent.slice(0, 300)` + 工具名+目标
- 适用场景：同一工具重复犯同一个错（如 read_file offset 过大返回 `[pruned]`）
- 无需修改。

#### 7b. [新增] 前置 Mistake 注入（写操作预防）

**为什么需要前置**：后置只能在错误发生后补救。对于写操作（edit_file, write_file），错误成本更高（已经写入了错误内容，需要回滚）。前置可以在 agent 动手前就提醒已知陷阱。

**触发条件**：
- `tu.name ∈ {edit_file, write_file}`
- 目标文件在 MistakeNotebook 中有相关记录
- read_file / bash / grep 不触发（读操作失败成本低）

**注入方式**：不修改工具参数，而是通过 `immuneHook.injectSignal` 注入低严重度信号：

```typescript
// tool-pipeline.ts，工具执行前（约 line 488，Execute via TurnHarness 之前）
if (deps.p3 && (tu.name === 'edit_file' || tu.name === 'write_file')) {
  const preHints = deps.p3.getMistakeHints('', `${tu.name} ${toolTarget}`)
  if (preHints && deps.immuneHook) {
    deps.immuneHook.injectSignal({
      kind: 'prediction_error',  // 复用已有信号类型
      severity: 0.3,             // 低严重度，不单独触发激活
      turn,
      source: 'mistake-preempt',
      context: preHints.slice(0, 200),
    })
  }
}
```

**severity 0.3 的理由**：前置是预防性的，不应单独触发免疫激活。它的价值是：当 agent 真的犯错时，0.3 + 后续 tool_repeat/token_spike 会更快达到 APC 门槛（0.6 最低档）。

#### 8. [新增] ImmuneEffectRecord 跟踪

**目标**：度量免疫响应的实际有效性，为后续自动调参提供数据。

**数据结构**：

```typescript
// immune-hook.ts 新增
interface ImmuneEffectRecord {
  turn: number
  fingerprint: string
  responseType: ImmuneResponseType
  outcome: 'success' | 'failure'
  turnsToResolve: number  // 从激活到解决的轮数
}
```

**记录时机**：
- `recordRepairSuccess` 时：outcome='success'，turnsToResolve = currentTurn - activationTurn
- `recordRepairFailure` 且连续 ≥ 3 次时：outcome='failure'

**状态追踪**：
- 新增 `activationTurns: Map<string, number>`（fingerprint → 激活时的 turn）
- 免疫激活时写入：`this.activationTurns.set(fingerprint, currentTurn)`
- 记录 effect 后删除：`this.activationTurns.delete(fingerprint)`

**汇总逻辑**（在 `maybeRunMaintenance` 中，每 30 turns）：

```typescript
summarizeEffectiveness(): { highSuccess: ImmuneResponseType[]; neverWorked: ImmuneResponseType[] } {
  const byType = new Map<ImmuneResponseType, { success: number; total: number }>()
  for (const r of this.effectLog) {
    const entry = byType.get(r.responseType) ?? { success: 0, total: 0 }
    entry.total++
    if (r.outcome === 'success') entry.success++
    byType.set(r.responseType, entry)
  }
  const highSuccess: ImmuneResponseType[] = []
  const neverWorked: ImmuneResponseType[] = []
  for (const [type, stats] of byType) {
    if (stats.total >= 3 && stats.success / stats.total > 0.8) highSuccess.push(type)
    if (stats.total >= 3 && stats.success === 0) neverWorked.push(type)
  }
  return { highSuccess, neverWorked }
}
```

**汇总结果的消费**：
- `highSuccess` 类型 → 提升对应 adaptive memory 的亲和分（+0.1）
- `neverWorked` 类型 → 降级（亲和分 × 0.5），连续两次汇总都 neverWorked → 从 adaptive 中移除

#### 9. [已完成] sycophancy_detected 信号

- 位置：`src/agent/loop.ts:1149-1161`
- 实现：SycophancyTrap rising-edge 触发 → `immuneHook.injectSignal`
- 只在状态从 inactive→active 时注入一次（`sycActive && !this.sycophancyWasActive`）
- 无需修改。

#### 10. [新增] TDD Gate

**问题**：agent 从 planning 进入 executing 时，如果没有先接触测试文件，会追求速度跳过 TDD。当前系统只有 prompt 层面的建议（`static.ts <tdd>` 标签），无 harness 强制。

**触发点**：`advanceContractStatus` 的 `planning→executing` 状态跃迁（one-shot，不重复）

```typescript
// loop.ts:1105 附近
if (this.taskContract && contractStatus) {
  const prevStatus = this.taskContract.status
  this.taskContract = advanceContractStatus(this.taskContract, contractStatus, this.session.getTurnCount())
  // TDD Gate: one-shot check on planning→executing transition
  if (prevStatus === 'planning' && this.taskContract.status === 'executing') {
    const tddHint = checkTddGate({
      filesRead: this.evidence.getState().filesRead,
      filesModified: this.evidence.getState().filesModified,
      isActionable: this.taskContract.isActionable,
    })
    if (tddHint) this._lastImmuneHint = tddHint
  }
}
```

**检查逻辑**（`src/agent/tdd-gate.ts`）：
- `filesModified` 或 `filesRead` 中有 `__tests__`/`.test.`/`.spec.`/`test/` 路径 → 通过
- 否则：`filesModified` 有新非测试 `.ts` 文件 → level='danger'（hard gate）
- 否则：level='warning'（soft gate）

**注入方式**：赋值 `_lastImmuneHint`，走 cognitive projection 管线，consume-once。不用 intent-veto，不阻断执行。

**不触发的场景**：
- chat mode（`taskContract` 为 undefined）
- 非 actionable 任务（问候、确认等）
- 已经接触过测试文件的正常 TDD 流程

**详细实现计划**：见 `docs/superpowers/plans/2026-05-24-tdd-gate.md`

---

## 六、测试策略

每个 Phase 需要对应的测试文件：

| Phase | 测试文件 |
|-------|----------|
| Phase 1 | `immune-context.test.ts` (新), 更新 `immune-hook.test.ts` |
| Phase 2 | 更新 `immune-apc.test.ts` 或已有测试, `tool-pipeline.test.ts` |
| Phase 3-7b | 更新 `tool-pipeline.test.ts`（前置注入场景） |
| Phase 3-8 | 更新 `immune-hook.test.ts`（effect record + summarize） |
| Phase 3-10 | `tdd-gate.test.ts` (新), 更新 `loop.test.ts`（集成） |

---

## 七、风险评估

| 风险 | 缓解 |
|------|------|
| Immune context 注入增加 token 消耗 | 只在 activation 时注入，非每轮 |
| Mistake 前置查询增加延迟 | 查询是纯内存操作，< 1ms |
| Sycophancy 检测误报 | 使用 agreement phrase 密度 + 阈值可调 |
| 门控降低导致过度激活 | 三档设计，最低档只 deposit_warning |
| 前置 hint 被 agent 忽略 | severity 0.3 不单独触发，但与后续信号叠加加速激活 |
| TDD Gate 误杀 hotfix | 只对 actionable 任务触发；soft gate 不阻断；read 过测试文件即通过 |
| EffectRecord 内存增长 | effectLog 在 summarize 后清空已消费的记录；上限 200 条 |
