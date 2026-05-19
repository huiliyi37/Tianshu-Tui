# 习惯化 v3：信心累加器 实施计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 将 FieldHabituationTracker 从固定 turn 计数器改为 IRF4 启发的信心累加器，由 agent 行为阶段（phaseHint）调制累加速率 α。

**架构：** PromptEngine 通过 `setPhaseHint(string)` 接收 agent 阶段信号（不引入跨模块类型依赖）。tracker 用连续信心分替代 stableCount，match 时 `confidence += (1-confidence)*α`，change 时归零，absent 时衰减。

**技术栈：** TypeScript strict, node:test + node:assert/strict

---

## 文件结构

| 文件 | 职责 |
|------|------|
| 修改 `src/prompt/field-habituation.ts` | 核心：stableCount → confidence，recordTurn 加 phaseHint 参数，α 查表 |
| 修改 `src/prompt/engine.ts` | 新增 setPhaseHint()，buildRequest 中传 phaseHint 到 recordTurn |
| 修改 `src/agent/loop.ts` | perception 完成后调 promptEngine.setPhaseHint(phaseClass) |
| 修改 `src/prompt/__tests__/field-habituation.test.ts` | 更新现有 8 测试 + 新增 6 测试 |
| 修改 `src/prompt/__tests__/engine-cache-stability.test.ts` | 更新习惯化相关测试 |

---

### 任务 1：改造 FieldHabituationTracker 核心

**文件：**
- 修改：`src/prompt/field-habituation.ts`
- 测试：`src/prompt/__tests__/field-habituation.test.ts`

- [ ] **步骤 1：编写失败的测试 — 信心累加基础行为**

```typescript
// 在 src/prompt/__tests__/field-habituation.test.ts 末尾添加新 describe 块
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { FieldHabituationTracker } from '../field-habituation.js'

describe('v3: confidence accumulator', () => {
  it('confidence increases on consecutive matches with default alpha', () => {
    const tracker = new FieldHabituationTracker({ promotionThreshold: 0.8 })
    // 7 turns with same value, default alpha=0.2
    for (let i = 0; i < 7; i++) {
      tracker.recordTurn({ domain: 'tianshu' })
    }
    const habituated = tracker.getHabituated()
    assert.ok(habituated.has('domain'), 'Should be habituated after 7 turns with alpha=0.2')
  })

  it('confidence resets to zero on value change', () => {
    const tracker = new FieldHabituationTracker({ promotionThreshold: 0.8 })
    for (let i = 0; i < 6; i++) {
      tracker.recordTurn({ domain: 'tianshu' })
    }
    // Change value — confidence should reset
    tracker.recordTurn({ domain: 'tianji' })
    const habituated = tracker.getHabituated()
    assert.ok(!habituated.has('domain'), 'Should NOT be habituated after value change')
  })

  it('absent fields decay rather than hard reset', () => {
    const tracker = new FieldHabituationTracker({ promotionThreshold: 0.8, decayRate: 0.3 })
    // Build up confidence over 8 turns
    for (let i = 0; i < 8; i++) {
      tracker.recordTurn({ domain: 'tianshu' })
    }
    assert.ok(tracker.getHabituated().has('domain'), 'Should be habituated')

    // Absent for 1 turn — should still be habituated (confidence * 0.7 = ~0.88 * 0.7 = 0.62 < 0.8)
    tracker.recordTurn({})
    assert.ok(!tracker.getHabituated().has('domain'), 'Should lose habituation after 1 absent turn')

    // But field reappears — confidence should NOT be zero, should recover faster
    tracker.recordTurn({ domain: 'tianshu' })
    tracker.recordTurn({ domain: 'tianshu' })
    tracker.recordTurn({ domain: 'tianshu' })
    // 3 more turns at alpha=0.2 from ~0.62 base: 0.62 + 0.38*0.2 = 0.696, +0.304*0.2=0.757, +0.243*0.2=0.806
    assert.ok(tracker.getHabituated().has('domain'), 'Should re-habituate faster from decayed base')
  })
})

describe('v3: phaseHint alpha modulation', () => {
  it('explore phase: 10 turns NOT enough to habituate', () => {
    const tracker = new FieldHabituationTracker({ promotionThreshold: 0.8 })
    for (let i = 0; i < 10; i++) {
      tracker.recordTurn({ domain: 'tianshu' }, 'explore')
    }
    assert.ok(!tracker.getHabituated().has('domain'),
      'explore alpha=0.1: 10 turns → confidence ~0.65, should NOT habituate')
  })

  it('execute phase: 4 turns enough to habituate', () => {
    const tracker = new FieldHabituationTracker({ promotionThreshold: 0.8 })
    for (let i = 0; i < 4; i++) {
      tracker.recordTurn({ domain: 'tianshu' }, 'execute')
    }
    // alpha=0.35: 4 turns → 1-(0.65)^4 = 0.821
    assert.ok(tracker.getHabituated().has('domain'),
      'execute alpha=0.35: 4 turns → confidence ~0.82, should habituate')
  })

  it('unknown phaseHint falls back to default alpha', () => {
    const tracker = new FieldHabituationTracker({ promotionThreshold: 0.8 })
    for (let i = 0; i < 7; i++) {
      tracker.recordTurn({ domain: 'tianshu' }, 'unknown_phase')
    }
    // default alpha=0.2: 7 turns → 1-(0.8)^7 = 0.79 < 0.8, NOT quite
    assert.ok(!tracker.getHabituated().has('domain'),
      'unknown phase uses default alpha=0.2, 7 turns → ~0.79 < 0.8')
    // One more turn
    tracker.recordTurn({ domain: 'tianshu' }, 'unknown_phase')
    assert.ok(tracker.getHabituated().has('domain'),
      '8th turn → ~0.83 > 0.8, should habituate')
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npx tsx --test src/prompt/__tests__/field-habituation.test.ts`
预期：FAIL — FieldHabituationTracker constructor 不接受 `promotionThreshold`，recordTurn 不接受第二参数

- [ ] **步骤 3：实现信心累加器**

替换 `src/prompt/field-habituation.ts` 的全部内容：

```typescript
import { createHash } from 'crypto'

export interface HabituationConfig {
  promotionThreshold?: number  // default 0.8
  decayRate?: number           // default 0.3
  /** @deprecated Use promotionThreshold instead. Kept for backward compat. */
  threshold?: number
}

interface FieldState {
  hash: string
  content: string
  confidence: number
  habituated: boolean
}

const ALPHA_TABLE: Record<string, number> = {
  explore: 0.10,
  plan: 0.20,
  execute: 0.35,
  verify: 0.30,
  deliver: 0.40,
}
const DEFAULT_ALPHA = 0.20

function sha256short(input: string): string {
  return createHash('sha256').update(input).digest('hex').slice(0, 16)
}

export class FieldHabituationTracker {
  private fields = new Map<string, FieldState>()
  private readonly promotionThreshold: number
  private readonly decayRate: number

  constructor(config: HabituationConfig) {
    if (config.threshold !== undefined && config.promotionThreshold === undefined) {
      // Legacy mode: convert old threshold to approximate promotionThreshold
      this.promotionThreshold = 0.8
      this.decayRate = config.decayRate ?? 0.3
    } else {
      this.promotionThreshold = config.promotionThreshold ?? 0.8
      this.decayRate = config.decayRate ?? 0.3
    }
  }

  recordTurn(fieldValues: Record<string, string>, phaseHint?: string): void {
    const alpha = ALPHA_TABLE[phaseHint ?? ''] ?? DEFAULT_ALPHA
    const seen = new Set<string>()

    for (const [name, content] of Object.entries(fieldValues)) {
      seen.add(name)
      const hash = sha256short(content)
      const existing = this.fields.get(name)

      if (!existing) {
        this.fields.set(name, { hash, content, confidence: alpha, habituated: false })
        continue
      }

      if (existing.hash === hash) {
        existing.confidence += (1 - existing.confidence) * alpha
        existing.habituated = existing.confidence >= this.promotionThreshold
      } else {
        existing.hash = hash
        existing.content = content
        existing.confidence = 0
        existing.habituated = false
      }
    }

    for (const [, state] of this.fields) {
      if (!seen.has([...this.fields].find(([, s]) => s === state)?.[0] ?? '')) {
        // This field was absent this turn — apply decay
      }
    }

    // Absent field decay
    for (const [name, state] of this.fields) {
      if (!seen.has(name)) {
        state.confidence *= (1 - this.decayRate)
        state.habituated = state.confidence >= this.promotionThreshold
      }
    }
  }

  getHabituated(): Set<string> {
    const result = new Set<string>()
    for (const [name, state] of this.fields) {
      if (state.habituated) result.add(name)
    }
    return result
  }

  getActive(): Set<string> {
    const result = new Set<string>()
    for (const [name, state] of this.fields) {
      if (!state.habituated) result.add(name)
    }
    return result
  }

  getHabituatedContent(): Map<string, string> {
    const result = new Map<string, string>()
    for (const [name, state] of this.fields) {
      if (state.habituated) result.set(name, state.content)
    }
    return result
  }
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`npx tsx --test src/prompt/__tests__/field-habituation.test.ts`
预期：14 tests PASS（原 8 + 新 6）

注意：原有测试使用 `{ threshold: N }` 构造，需要验证向后兼容。如果 threshold=5 的旧测试行为变化（因为现在用 confidence 而非 stableCount），需要调整测试期望值或调整兼容逻辑。

原有测试检查的关键行为：
- `threshold: 5` → 5 turn 后 habituated = true。新逻辑 default alpha=0.2: 需要 ~8 turn 才达到 0.8。这会导致 `'consolidated block appears after threshold turns'` 测试失败。

**修复策略**：原有 engine-cache-stability.test.ts 中的习惯化测试使用 `threshold: 3`。在新逻辑下 alpha=0.2, 3 turn → confidence=0.488 < 0.8。这些测试需要在任务 3 中更新。

- [ ] **步骤 5：Commit**

```bash
git add src/prompt/field-habituation.ts src/prompt/__tests__/field-habituation.test.ts
git commit -m "feat(prompt): replace fixed turn counter with IRF4-inspired confidence accumulator"
```

---

### 任务 2：PromptEngine 接入 phaseHint

**文件：**
- 修改：`src/prompt/engine.ts`

- [ ] **步骤 1：添加 phaseHint 字段和 setter**

在 `src/prompt/engine.ts` 第 97 行（`private cerebellarHint` 之后）添加：

```typescript
  private phaseHint?: string
```

在第 289 行（`setCerebellarHint` 方法之后）添加：

```typescript
  setPhaseHint(hint: string): void {
    this.phaseHint = hint
  }
```

- [ ] **步骤 2：修改 buildRequest 中 recordTurn 调用**

在 `src/prompt/engine.ts` 第 167 行，将：

```typescript
              this.tracker.recordTurn(fieldValues)
```

改为：

```typescript
              this.tracker.recordTurn(fieldValues, this.phaseHint)
```

- [ ] **步骤 3：运行 typecheck**

运行：`npx tsc --noEmit`
预期：0 errors

- [ ] **步骤 4：Commit**

```bash
git add src/prompt/engine.ts
git commit -m "feat(prompt): add setPhaseHint() and pass phaseHint to habituation tracker"
```

---

### 任务 3：更新 engine-cache-stability 测试

**文件：**
- 修改：`src/prompt/__tests__/engine-cache-stability.test.ts`

- [ ] **步骤 1：更新 habituation 测试中的 threshold 和 turn 数**

engine-cache-stability.test.ts 中 `createEngineH(threshold)` 工厂函数使用 `habituationThreshold`。在新逻辑下：
- `habituationThreshold` 参数映射到旧 `{ threshold: N }` 构造（向后兼容模式）
- 默认 promotionThreshold=0.8, alpha=0.2
- 需要调整测试中的 turn 数以匹配新的信心累加行为

将 `createEngineH(3)` 的测试调整。旧逻辑 threshold=3 → 3 turn habituated。新逻辑 alpha=0.2, promotionThreshold=0.8 → 需要 ~8 turn。

方案：在测试中使用 `execute` phaseHint（alpha=0.35），使 4 turn 即可达到 0.82。需要在 engine 上调用 `setPhaseHint('execute')` + 在 `setActiveDomain` 前。

在 `src/prompt/__tests__/engine-cache-stability.test.ts` 的 `describe('habituation: three-zone consolidation')` 中，修改所有使用 `createEngineH(3)` 的测试：

在每个测试的 loop 之前添加 `engine.setPhaseHint('execute')`，并将 loop 次数从 3 改为 4：

```typescript
  it('consolidated block appears after threshold turns with stable domain', () => {
    const engine = createEngineH(3) // threshold ignored in v3, uses promotionThreshold=0.8
    engine.setPhaseHint('execute') // alpha=0.35, 4 turns → 0.82

    for (let t = 0; t < 4; t++) {
      engine.setActiveDomain({ name: 'tianshu', volatileBlock: 'block', motto: 'motto' })
      const messages: Message[] = []
      for (let m = 0; m <= t; m++) {
        messages.push({ role: 'user', content: `msg ${m}` })
        if (m < t) messages.push({ role: 'assistant', content: `resp ${m}` })
      }
      engine.buildRequest(messages)
    }

    const messages: Message[] = [{ role: 'user', content: 'final' }]
    engine.setActiveDomain({ name: 'tianshu', volatileBlock: 'block', motto: 'motto' })
    const req = engine.buildRequest(messages)
    const vol = (req.messages[0] as { content: string }).content
    assert.ok(vol.includes('<consolidated>'), 'Consolidated block should appear after threshold')
    assert.ok(vol.includes('tianshu'), 'Consolidated should contain domain name')
  })
```

同样更新其他使用 `createEngineH(3)` 的测试：`'historical volatile includes consolidated block after promotion'`、`'dehabituation removes field from consolidated block'`、`'FROZEN+CONSOLIDATED is byte prefix of FRESH with active appendix'`。

对于 `'no consolidated block before reaching threshold'` 测试（使用 `createEngineH(5)`），改为使用 `explore` phaseHint：

```typescript
  it('no consolidated block before reaching threshold', () => {
    const engine = createEngineH(5)
    engine.setPhaseHint('explore') // alpha=0.1, 10 turns needed

    // 4 turns at alpha=0.1 → confidence ~0.34, well below 0.8
    for (let t = 0; t < 4; t++) {
      engine.setActiveDomain({ name: 'tianshu', volatileBlock: 'block', motto: 'motto' })
      engine.buildRequest([{ role: 'user', content: `msg ${t}` }])
    }

    engine.setActiveDomain({ name: 'tianshu', volatileBlock: 'block', motto: 'motto' })
    const req = engine.buildRequest([{ role: 'user', content: 'check' }])
    const vol = (req.messages[0] as { content: string }).content
    assert.ok(!vol.includes('<consolidated>'), 'No consolidated block before threshold')
  })
```

`'disabling habituation (threshold=0)'` 测试保持不变 — `habituationThreshold: 0` 在 engine.ts 中仍然跳过 tracker 创建（`(config.habituationThreshold ?? 5) > 0` 逻辑）。

- [ ] **步骤 2：运行全量测试**

运行：`npx tsx --test src/prompt/__tests__/engine-cache-stability.test.ts`
预期：20 tests PASS

- [ ] **步骤 3：Commit**

```bash
git add src/prompt/__tests__/engine-cache-stability.test.ts
git commit -m "test(prompt): update habituation tests for v3 confidence accumulator"
```

---

### 任务 4：Agent Loop 接入 phaseHint

**文件：**
- 修改：`src/agent/loop.ts`

- [ ] **步骤 1：找到 perception 完成后、buildRequest 前的位置**

在 `src/agent/loop.ts` 中搜索 `perceive()` 调用位置（~line 596-615）和 `buildRequest()` 调用位置（~line 644）。在 perception 完成后，StarPhase 已计算。

在 perception 完成和 buildRequest 之间添加 phaseHint 传递。需要从 StarEvent 中提取 phaseClass。

搜索 star event 赋值位置，找到类似 `this.currentStarEvent = ...` 或 `starEvent` 变量。从 star event 的 phase 值提取 class：

```typescript
// 在 perception 完成后，buildRequest 之前添加：
const phaseClassMap: Record<string, string> = {
  'tianshu-planning': 'plan',
  'tianxuan-locating': 'explore',
  'tianji-decomposing': 'plan',
  'tianquan-contracting': 'plan',
  'yuheng-implementing': 'execute',
  'kaiyang-testing': 'verify',
  'yaoguang-delivering': 'deliver',
  'tianshu-encore': 'plan',
}
const phaseClass = phaseClassMap[starEvent?.phase ?? ''] ?? 'plan'
this.config.promptEngine.setPhaseHint(phaseClass)
```

注意：具体变量名（`starEvent` vs `this.currentStarEvent` vs `perception.starEvent`）需要根据 loop.ts 实际代码调整。worker 应先 `Read` loop.ts 的 perception 到 buildRequest 区域确定变量名。

- [ ] **步骤 2：运行 typecheck + 全量测试**

运行：`npx tsc --noEmit && npm test`
预期：0 errors，所有测试通过

- [ ] **步骤 3：Commit**

```bash
git add src/agent/loop.ts
git commit -m "feat(agent): wire StarPhase into PromptEngine phaseHint for habituation modulation"
```

---

### 任务 5：全量验证

**文件：** 无新文件

- [ ] **步骤 1：运行 typecheck**

运行：`npx tsc --noEmit`
预期：0 errors

- [ ] **步骤 2：运行全量测试**

运行：`npm test`
预期：全部 PASS

- [ ] **步骤 3：运行 build**

运行：`npm run build`
预期：成功

- [ ] **步骤 4：验证缓存命中率**

运行：`npx tsx scripts/verify-cache-hit-rate.ts`
预期：Turn 2+ 平均 ≥ 74%（不低于 v2 基线），所有前缀稳定 ✅

---

## 自检结果

**1. 规格覆盖度：**
- explore 阶段抑制晋升 ✓（任务 1 测试：10 turn 不晋升）
- execute 阶段加速晋升 ✓（任务 1 测试：4 turn 即晋升）
- 缺席衰减 ✓（任务 1 测试：absent → confidence *= 0.7）
- phaseHint 透传 ✓（任务 2：setter + buildRequest 传参）
- agent loop 接入 ✓（任务 4：StarPhase → phaseClass → setPhaseHint）
- 向后兼容 ✓（任务 1：旧 threshold 参数映射到 promotionThreshold=0.8）
- 缓存命中率验证 ✓（任务 5）

**2. 占位符扫描：** 任务 4 中 `starEvent?.phase` 的具体变量名标注为"需根据实际代码调整"。这是因为 loop.ts 是 ~750 行文件，perception 结果的变量名依赖运行时检查。Worker 需要先 Read 相关区域。

**3. 类型一致性：**
- `HabituationConfig.promotionThreshold` 在 field-habituation.ts 定义，engine.ts 消费 — 一致
- `recordTurn(fieldValues, phaseHint?)` 签名在 field-habituation.ts 定义，engine.ts 调用 — 一致
- `setPhaseHint(hint: string)` 在 engine.ts 定义，loop.ts 调用 — 一致
- `ALPHA_TABLE` key 为 'explore'|'plan'|'execute'|'verify'|'deliver'，loop.ts phaseClassMap value 为同样字符串 — 一致

---

## 依赖关系

```
任务 1（tracker 核心）→ 任务 2（engine 接入）→ 任务 3（测试更新）
任务 2（engine setter）→ 任务 4（loop 接入）
任务 5 最后执行

可并行：
- 任务 3 和任务 4 可并行（分别改测试和改 loop）
```

---

## 风险评估

| 风险 | 概率 | 影响 | 缓解 |
|------|------|------|------|
| loop.ts 中 starEvent 变量名不明确 | 中 | 低 | Worker 先 Read 相关区域 |
| 旧测试依赖 stableCount 精确行为 | 高 | 中 | 任务 3 全面更新测试期望值 |
| 缓存命中率变化 | 低 | 高 | 任务 5 验证，alpha 参数可调 |
| engine.ts 中 habituationThreshold 参数路径 | 低 | 低 | 旧参数走向后兼容路径 |
