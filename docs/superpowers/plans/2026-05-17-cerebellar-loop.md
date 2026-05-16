# Cerebellar Loop: Prediction-Error Accumulator 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 实现一个小脑前向模型启发的 prediction-error 系统，在 doom loop 触发前 1-2 turns 预警，并比例地升级干预（提示 → 强制 read-before-edit → 建议 rollback），同时动态调整 reasoning effort。

**架构：** tool call 前记录预期结果 → 执行后比对 → 滑动窗口累积误差 → 误差率驱动分级干预 + reasoning effort 调整 → 连续成功后自动降级（tipping point reset）。

**技术栈：** TypeScript, node:test, existing TraceStore/tool-pipeline/auto-reasoning infrastructure.

**灵感来源：** 小脑前向模型（predict-verify-update）+ 植物生长素 tipping point（比例纠错 + 防过冲）

**设计过程：** [`docs/superpowers/specs/2026-05-17-cerebellar-loop-brainstorm.md`](../specs/2026-05-17-cerebellar-loop-brainstorm.md)

**前置条件：** 无（独立于 multi-provider Phase 1）

**验收标准：**
| 标准 | 验证方法 |
|------|---------|
| TraceStore 记录 prediction error | 单元测试 |
| 滑动窗口 error rate 正确计算 | 单元测试 |
| error rate > 60% 触发 read-before-edit gate | 单元测试 + 集成测试 |
| 连续 3 次正确预测后降级 | 单元测试 |
| reasoning effort 动态调整 | 单元测试 |
| 现有测试全部通过 | `npm test`: 890+ pass, 0 fail |

---

## Scope

### 本计划包含

- `PredictionAccumulator` 数据结构 + 滑动窗口计算
- Tool-pipeline 集成（tool call 后记录 prediction error）
- 分级干预逻辑（prompt injection + read-before-edit gate）
- `auto-reasoning.ts` 动态调整联动
- Tipping point reset（连续成功后降级）
- 单元测试覆盖

### 本计划不包含

- Cockpit 面板可视化（Phase 3）
- Delivery gate 联动（Phase 3）
- 从 thinking block 提取预测（Phase 2 — 本计划用 heuristic）
- 跨 session 持久化 prediction patterns

---

## 文件结构

### 新建文件

| 文件 | 职责 |
|------|------|
| `src/agent/prediction-error.ts` | PredictionAccumulator + 滑动窗口 + 干预级别计算 |
| `src/agent/__tests__/prediction-error.test.ts` | 单元测试 |

### 修改文件

| 文件 | 变更 |
|------|------|
| `src/agent/trace-store.ts` | TraceEvent 加 `predictedSuccess?: boolean` 字段 |
| `src/agent/tool-pipeline.ts` | tool call 后记录 prediction + 检查干预级别 |
| `src/agent/auto-reasoning.ts` | 新增 `adjustReasoningEffort(current, errorRate)` 函数 |
| `src/agent/turn-end.ts` | turn 结束时检查 prediction error rate，注入干预 |
| `src/agent/loop.ts` | 初始化 PredictionAccumulator；reasoning effort 动态更新 |

---

## 任务 1：PredictionAccumulator 数据结构

**文件：**
- 创建：`src/agent/prediction-error.ts`
- 创建：`src/agent/__tests__/prediction-error.test.ts`

- [ ] **步骤 1：编写失败测试**

创建 `src/agent/__tests__/prediction-error.test.ts`：

```typescript
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  createPredictionAccumulator,
  recordPrediction,
  getErrorRate,
  getInterventionLevel,
  type PredictionAccumulator,
} from '../prediction-error.js'

describe('PredictionAccumulator', () => {
  it('starts with zero error rate', () => {
    const acc = createPredictionAccumulator()
    assert.equal(getErrorRate(acc), 0)
  })

  it('computes error rate over sliding window', () => {
    let acc = createPredictionAccumulator(5)
    acc = recordPrediction(acc, true)   // correct
    acc = recordPrediction(acc, true)   // correct
    acc = recordPrediction(acc, false)  // error
    assert.equal(getErrorRate(acc), 1 / 3)
  })

  it('sliding window drops old entries', () => {
    let acc = createPredictionAccumulator(3)
    acc = recordPrediction(acc, false)  // error (will be dropped)
    acc = recordPrediction(acc, false)  // error (will be dropped)
    acc = recordPrediction(acc, true)   // correct
    acc = recordPrediction(acc, true)   // correct
    acc = recordPrediction(acc, true)   // correct
    // window = [true, true, true], old errors dropped
    assert.equal(getErrorRate(acc), 0)
  })

  it('intervention level: none when error rate < 0.4', () => {
    let acc = createPredictionAccumulator(5)
    acc = recordPrediction(acc, true)
    acc = recordPrediction(acc, false)
    // 1/2 = 0.5 but only 2 samples, need minimum 3
    assert.equal(getInterventionLevel(acc), 'none')
  })

  it('intervention level: hint when error rate >= 0.4', () => {
    let acc = createPredictionAccumulator(5)
    acc = recordPrediction(acc, true)
    acc = recordPrediction(acc, false)
    acc = recordPrediction(acc, false)
    // 2/3 = 0.67
    assert.equal(getInterventionLevel(acc), 'hint')
  })

  it('intervention level: gate when error rate >= 0.6', () => {
    let acc = createPredictionAccumulator(5)
    acc = recordPrediction(acc, false)
    acc = recordPrediction(acc, false)
    acc = recordPrediction(acc, false)
    acc = recordPrediction(acc, true)
    // 3/4 = 0.75
    assert.equal(getInterventionLevel(acc), 'gate')
  })

  it('intervention level: escalate when error rate >= 0.8', () => {
    let acc = createPredictionAccumulator(5)
    acc = recordPrediction(acc, false)
    acc = recordPrediction(acc, false)
    acc = recordPrediction(acc, false)
    acc = recordPrediction(acc, false)
    acc = recordPrediction(acc, true)
    // 4/5 = 0.8
    assert.equal(getInterventionLevel(acc), 'escalate')
  })

  it('tipping point reset: 3 consecutive correct → drops to none', () => {
    let acc = createPredictionAccumulator(5)
    acc = recordPrediction(acc, false)
    acc = recordPrediction(acc, false)
    acc = recordPrediction(acc, false)
    // error rate = 1.0 → escalate
    acc = recordPrediction(acc, true)
    acc = recordPrediction(acc, true)
    acc = recordPrediction(acc, true)
    // window = [false, false, true, true, true] → 2/5 = 0.4 → hint
    // But consecutive correct = 3 → tipping point reset
    assert.equal(getInterventionLevel(acc), 'none')
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npm test -- src/agent/__tests__/prediction-error.test.ts`
预期：FAIL（`prediction-error.ts` 不存在）

- [ ] **步骤 3：实现 PredictionAccumulator**

创建 `src/agent/prediction-error.ts`：

```typescript
export type InterventionLevel = 'none' | 'hint' | 'gate' | 'escalate'

export interface PredictionAccumulator {
  window: boolean[]  // true = correct prediction, false = error
  windowSize: number
  consecutiveCorrect: number
}

export function createPredictionAccumulator(windowSize = 5): PredictionAccumulator {
  return { window: [], windowSize, consecutiveCorrect: 0 }
}

export function recordPrediction(acc: PredictionAccumulator, correct: boolean): PredictionAccumulator {
  const window = [...acc.window, correct].slice(-acc.windowSize)
  const consecutiveCorrect = correct ? acc.consecutiveCorrect + 1 : 0
  return { ...acc, window, consecutiveCorrect }
}

export function getErrorRate(acc: PredictionAccumulator): number {
  if (acc.window.length === 0) return 0
  const errors = acc.window.filter(x => !x).length
  return errors / acc.window.length
}

const MIN_SAMPLES = 3
const TIPPING_POINT_THRESHOLD = 3

export function getInterventionLevel(acc: PredictionAccumulator): InterventionLevel {
  if (acc.window.length < MIN_SAMPLES) return 'none'
  if (acc.consecutiveCorrect >= TIPPING_POINT_THRESHOLD) return 'none'

  const rate = getErrorRate(acc)
  if (rate >= 0.8) return 'escalate'
  if (rate >= 0.6) return 'gate'
  if (rate >= 0.4) return 'hint'
  return 'none'
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`npm test -- src/agent/__tests__/prediction-error.test.ts`
预期：PASS

- [ ] **步骤 5：Commit**

```bash
git add src/agent/prediction-error.ts src/agent/__tests__/prediction-error.test.ts
git commit -m "feat(agent): add PredictionAccumulator with sliding window + intervention levels"
```

---

## 任务 2：Heuristic Prediction 逻辑

**文件：**
- 修改：`src/agent/prediction-error.ts`
- 修改：`src/agent/__tests__/prediction-error.test.ts`

- [ ] **步骤 1：编写失败测试**

在测试文件中追加：

```typescript
import { predictToolOutcome } from '../prediction-error.js'

describe('predictToolOutcome', () => {
  it('predicts edit_file → success (optimistic)', () => {
    assert.equal(predictToolOutcome('edit_file', {}), true)
  })

  it('predicts write_file → success (optimistic)', () => {
    assert.equal(predictToolOutcome('write_file', {}), true)
  })

  it('predicts bash with test command → success', () => {
    assert.equal(predictToolOutcome('bash', { command: 'npm test' }), true)
  })

  it('predicts read_file → success (always)', () => {
    assert.equal(predictToolOutcome('read_file', {}), true)
  })

  it('predicts unknown tool → success (optimistic default)', () => {
    assert.equal(predictToolOutcome('web_fetch', {}), true)
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npm test -- src/agent/__tests__/prediction-error.test.ts`
预期：FAIL（`predictToolOutcome` 不存在）

- [ ] **步骤 3：实现 predictToolOutcome**

在 `src/agent/prediction-error.ts` 末尾添加：

```typescript
export function predictToolOutcome(toolName: string, _input: Record<string, unknown>): boolean {
  // Heuristic: agent always predicts success (optimistic forward model)
  // A prediction error means "the agent expected this to work but it didn't"
  // This is the simplest useful forward model — it detects when reality
  // diverges from the agent's optimistic mental model
  return true
}
```

注意：这是 Phase 1 的 heuristic — 总是预测成功。这意味着 prediction error = tool call 失败。看起来简单，但它的价值在于：当 error rate 高时，说明 agent 连续失败但还在乐观地尝试 — 这正是需要干预的时刻。Phase 2 可以从 thinking block 提取更精确的预测。

- [ ] **步骤 4：运行测试验证通过**

运行：`npm test -- src/agent/__tests__/prediction-error.test.ts`
预期：PASS

- [ ] **步骤 5：Commit**

```bash
git add src/agent/prediction-error.ts src/agent/__tests__/prediction-error.test.ts
git commit -m "feat(agent): add heuristic predictToolOutcome (optimistic forward model)"
```

---

## 任务 3：Tool-Pipeline 集成

**文件：**
- 修改：`src/agent/tool-pipeline.ts`
- 修改：`src/agent/tool-pipeline.ts` 的 `ToolPipelineDeps` 接口

- [ ] **步骤 1：扩展 ToolPipelineDeps**

在 `src/agent/tool-pipeline.ts` 的 `ToolPipelineDeps` 接口中添加：

```typescript
import type { PredictionAccumulator } from './prediction-error.js'

export interface ToolPipelineDeps {
  // ... existing fields ...
  predictionAccumulator: PredictionAccumulator
  onPredictionUpdate: (acc: PredictionAccumulator) => void
}
```

- [ ] **步骤 2：在 tool call 完成后记录 prediction**

在 `executeToolUse` 函数中，在 trace recording 之后（约 line 251 之后），添加 prediction error 记录：

```typescript
import { predictToolOutcome, recordPrediction, getInterventionLevel } from './prediction-error.js'

// After: traceStore = recordToolFingerprint(traceStore, fp)
// Add prediction error tracking
const predicted = predictToolOutcome(tu.name, tu.input)
const actual = !harnessResult.isError
const correct = predicted === actual
const updatedAcc = recordPrediction(deps.predictionAccumulator, correct)
deps.onPredictionUpdate(updatedAcc)
```

- [ ] **步骤 3：在 tool call 前检查 intervention level（read-before-edit gate）**

在 `executeToolUse` 函数中，在 strategy shift 检查之后（约 line 120-134 之间），添加 prediction-error gate：

```typescript
// Cerebellar gate: block edit when prediction error rate is high
const interventionLevel = getInterventionLevel(deps.predictionAccumulator)
if (interventionLevel === 'gate' || interventionLevel === 'escalate') {
  if (tu.name === 'edit_file' || tu.name === 'write_file') {
    const recent = deps.trajectory.getEntries().slice(-3)
    const hasRecentRead = recent.some(e => e.tool === 'read_file')
    if (!hasRecentRead) {
      const gateMsg = interventionLevel === 'escalate'
        ? 'Prediction error rate critical (>80%). Your mental model appears stale. Read the target file and surrounding context before editing. Consider rolling back recent changes.'
        : 'Prediction error rate high (>60%). Read the target file before editing to refresh your mental model.'
      callbacks.onToolResult(tu.id, tu.name, gateMsg, true)
      return { toolResult: { type: 'tool_result', tool_use_id: tu.id, content: gateMsg, is_error: true }, traceStore, importGraph, lastConflictCheckCount, checkpointCreated, latestRisk }
    }
  }
}
```

- [ ] **步骤 4：运行 typecheck**

运行：`npx tsc --noEmit`
预期：可能有类型错误需要修复（ToolPipelineDeps 的调用方需要传入新字段）

- [ ] **步骤 5：修复调用方**

在 `src/agent/loop.ts` 中，找到 `executeToolUse` 的调用处，传入 `predictionAccumulator` 和 `onPredictionUpdate`。初始化 accumulator 在 loop 开始时：

```typescript
import { createPredictionAccumulator, type PredictionAccumulator } from './prediction-error.js'

// In the agent loop class/function, add state:
let predictionAccumulator = createPredictionAccumulator(5)

// In the deps passed to executeToolUse:
predictionAccumulator,
onPredictionUpdate: (acc) => { predictionAccumulator = acc },
```

- [ ] **步骤 6：运行 typecheck + 测试**

运行：`npx tsc --noEmit && npm test`
预期：全部通过

- [ ] **步骤 7：Commit**

```bash
git add src/agent/tool-pipeline.ts src/agent/loop.ts
git commit -m "feat(agent): integrate prediction-error tracking into tool pipeline + read-before-edit gate"
```

---

## 任务 4：Dynamic Reasoning Effort

**文件：**
- 修改：`src/agent/auto-reasoning.ts`
- 修改：`src/agent/__tests__/prediction-error.test.ts`（追加测试）

- [ ] **步骤 1：编写失败测试**

在测试文件中追加：

```typescript
import { adjustReasoningEffort } from '../auto-reasoning.js'

describe('adjustReasoningEffort', () => {
  it('escalates from medium to high when error rate >= 0.6', () => {
    assert.equal(adjustReasoningEffort('medium', 'gate'), 'high')
  })

  it('escalates from high to max when error rate >= 0.8', () => {
    assert.equal(adjustReasoningEffort('high', 'escalate'), 'max')
  })

  it('does not change when intervention is none', () => {
    assert.equal(adjustReasoningEffort('medium', 'none'), 'medium')
  })

  it('does not change when intervention is hint', () => {
    assert.equal(adjustReasoningEffort('medium', 'hint'), 'medium')
  })

  it('does not exceed max', () => {
    assert.equal(adjustReasoningEffort('max', 'escalate'), 'max')
  })

  it('de-escalates from high to medium when intervention drops to none', () => {
    assert.equal(adjustReasoningEffort('high', 'none'), 'medium')
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npm test -- src/agent/__tests__/prediction-error.test.ts`
预期：FAIL（`adjustReasoningEffort` 不存在）

- [ ] **步骤 3：实现 adjustReasoningEffort**

在 `src/agent/auto-reasoning.ts` 末尾添加：

```typescript
import type { InterventionLevel } from './prediction-error.js'

const EFFORT_ORDER: ReasoningEffort[] = ['off', 'low', 'medium', 'high', 'max']

export function adjustReasoningEffort(current: ReasoningEffort, intervention: InterventionLevel): ReasoningEffort {
  const idx = EFFORT_ORDER.indexOf(current)

  if (intervention === 'escalate') {
    return EFFORT_ORDER[Math.min(idx + 1, EFFORT_ORDER.length - 1)]!
  }
  if (intervention === 'gate') {
    return EFFORT_ORDER[Math.min(idx + 1, EFFORT_ORDER.length - 1)]!
  }
  if (intervention === 'none' && idx > 2) {
    // De-escalate back toward medium when predictions recover
    return EFFORT_ORDER[idx - 1]!
  }
  return current
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`npm test -- src/agent/__tests__/prediction-error.test.ts`
预期：PASS

- [ ] **步骤 5：联动 loop.ts**

在 `src/agent/loop.ts` 中，在 turn 结束时（调用 `processTurnEnd` 之后），添加 reasoning effort 动态调整：

```typescript
import { getInterventionLevel } from './prediction-error.js'
import { adjustReasoningEffort } from './auto-reasoning.js'

// After processTurnEnd:
if (this.config.autoReasoning) {
  const level = getInterventionLevel(predictionAccumulator)
  this.config.reasoningEffort = adjustReasoningEffort(this.config.reasoningEffort, level)
}
```

- [ ] **步骤 6：运行 typecheck + 测试**

运行：`npx tsc --noEmit && npm test`
预期：全部通过

- [ ] **步骤 7：Commit**

```bash
git add src/agent/auto-reasoning.ts src/agent/loop.ts src/agent/__tests__/prediction-error.test.ts
git commit -m "feat(agent): dynamic reasoning effort adjustment based on prediction error rate"
```

---

## 任务 5：Turn-End Intervention Prompt Injection

**文件：**
- 修改：`src/agent/turn-end.ts`

- [ ] **步骤 1：在 turn-end 中注入 prediction-error hint**

在 `processTurnEnd` 函数中，在 behavior-mirror 检查之后，添加 prediction-error 干预提示：

扩展 `TurnEndDeps` 接口：

```typescript
import type { PredictionAccumulator } from './prediction-error.js'
import { getInterventionLevel, getErrorRate } from './prediction-error.js'

export interface TurnEndDeps {
  // ... existing fields ...
  predictionAccumulator: PredictionAccumulator
}
```

在 `processTurnEnd` 函数体中，在 `config.promptEngine.setBehaviorMirror(mirror)` 之后添加：

```typescript
const interventionLevel = getInterventionLevel(deps.predictionAccumulator)
if (interventionLevel !== 'none') {
  const rate = Math.round(getErrorRate(deps.predictionAccumulator) * 100)
  const hints: Record<string, string> = {
    hint: `Prediction accuracy low (${rate}% error). Your recent tool calls are failing more than expected. Consider reading more context before your next action.`,
    gate: `Prediction accuracy critical (${rate}% error). You must read relevant files before any edit. Your mental model of the code appears stale.`,
    escalate: `Prediction accuracy severe (${rate}% error). Stop editing. Read the target files, check git diff, and consider rolling back to the last known-good state.`,
  }
  config.promptEngine.setCerebellarHint(hints[interventionLevel] ?? null)
} else {
  config.promptEngine.setCerebellarHint(null)
}
```

- [ ] **步骤 2：添加 setCerebellarHint 到 PromptEngine**

在 `src/prompt/` 中找到 PromptEngine 类，添加 `setCerebellarHint(hint: string | null)` 方法。这应该将 hint 注入到 system prompt 的 agent state 部分（类似于 behavior-mirror 和 strategy-shift 的注入方式）。

查看现有的 `setBehaviorMirror` 和 `setStrategyShift` 实现模式，用相同方式添加 `setCerebellarHint`。

- [ ] **步骤 3：运行 typecheck + 测试**

运行：`npx tsc --noEmit && npm test`
预期：全部通过

- [ ] **步骤 4：Commit**

```bash
git add src/agent/turn-end.ts src/prompt/
git commit -m "feat(agent): inject cerebellar hint into prompt based on prediction error rate"
```

---

## 任务 6：集成验证

**文件：** 无新文件

- [ ] **步骤 1：运行完整测试套件**

运行：`npm test`
预期：890+ pass, 0 fail

- [ ] **步骤 2：运行 typecheck**

运行：`npx tsc --noEmit`
预期：无错误

- [ ] **步骤 3：验证 prediction error 数据流**

手动验证或写集成测试：
1. 模拟 5 次 tool call，其中 4 次失败
2. 确认 `getInterventionLevel` 返回 `escalate`
3. 确认 `adjustReasoningEffort('medium', 'escalate')` 返回 `'high'`
4. 模拟 3 次连续成功
5. 确认 tipping point reset 生效，intervention 降回 `none`

- [ ] **步骤 4：验证 read-before-edit gate**

模拟场景：
1. 设置 prediction error rate > 60%
2. 尝试执行 `edit_file`（最近 3 个 trajectory entry 中无 `read_file`）
3. 确认 tool call 被 gate 拦截，返回错误消息

- [ ] **步骤 5：最终 Commit（如有修复）**

```bash
git add -A
git commit -m "fix(agent): cerebellar loop integration fixes"
```

---

## 风险与防线

| 风险 | 应对 |
|------|------|
| Heuristic "always predict success" 太简单，所有失败都算 prediction error | 这正是 Phase 1 的设计意图 — 检测"agent 连续失败但还在乐观尝试"。Phase 2 可以从 thinking 提取更精确预测 |
| read-before-edit gate 太激进，阻止正常编辑 | 需要最近 3 个 entry 中无 read_file 才触发；如果 agent 正常工作（read → edit），gate 不会触发 |
| reasoning effort 震荡（升级 → 降级 → 升级） | tipping point 需要连续 3 次正确才降级，防止单次成功就 reset |
| PromptEngine 没有 setCerebellarHint 方法 | 参考 setBehaviorMirror 的实现模式，同样方式添加 |
| loop.ts 中 predictionAccumulator 的生命周期 | 与 session 同生命周期，在 loop 开始时创建，每次 tool call 后更新 |

---

## 任务复杂度评估（作为 Rivet 长链路测试样本）

| 维度 | 评分 | 说明 |
|------|------|------|
| 新概念引入 | ★★★★★ | prediction error 是全新概念，不是现有模式重组 |
| 架构理解 | ★★★★★ | 需要理解 trace-store + tool-pipeline + turn-end + auto-reasoning + prompt-engine 五层交互 |
| 判断力要求 | ★★★★ | gate 逻辑需要理解 trajectory entry 结构；prompt injection 需要找到正确的注入点 |
| 文件跨度 | ★★★★ | 6 文件修改/创建 |
| 测试设计 | ★★★★ | 需要构造"连续失败"场景验证 intervention 触发 |
| 链路长度 | ★★★☆ | 6 个任务，每个 4-7 步，总计 ~30 步 |
| 与 multi-provider 互补 | ★★★★★ | multi-provider 测试"接口提取+安全迁移"；cerebellar loop 测试"新概念引入+多层联动" |

**适合测试的能力维度：**
1. 新抽象引入（PredictionAccumulator 是全新数据结构）
2. 多层联动（tool-pipeline → accumulator → turn-end → prompt-engine → auto-reasoning）
3. 条件逻辑正确性（gate 触发条件：error rate + 无 recent read + edit tool）
4. 不破坏现有行为（所有新逻辑在 error rate < 0.4 时完全透明）
5. 理解 prompt injection 模式（找到 PromptEngine 的注入点）
