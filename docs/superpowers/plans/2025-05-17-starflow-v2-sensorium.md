# 天枢星图流 v2: AgentSensorium + Stigmergy 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 实现 6 维态势感知层（AgentSensorium）+ 信息素跨会话记忆（Stigmergy）+ StarFlow TUI 集成 + 耗散踢停滞突破，使 harness 层能够在零 LLM 开销下自主调节策略、跨会话积累空间记忆、并在停滞时自动去稳定。

**架构：** `src/agent/sensorium.ts` 聚合 6 维连续向量并输出 StrategyProfile；`src/context/stigmergy.ts` 管理 `.rivet/pheromones.json` 的读写衰减；`src/agent/star-event.ts` 将 Sensorium 状态映射为星图阶段事件；`src/agent/dissipative-kick.ts` 在停滞时触发去稳定序列。所有新模块只读取现有监控器输出，不修改现有代码逻辑。

**技术栈：** TypeScript strict，`node:test` + `tsx` runner，无新依赖。纯函数优先，相对 `.js` 扩展名导入。

---

## 文件结构

| 文件 | 职责 | 操作 |
|------|------|------|
| `src/agent/sensorium.ts` | Sensorium 接口 + computeSensorium + computeStrategy | **新建** |
| `src/agent/__tests__/sensorium.test.ts` | Sensorium 单元测试 | **新建** |
| `src/context/stigmergy.ts` | StigmergyStore 类 (load/save/deposit/query/decay/prune) | **新建** |
| `src/context/__tests__/stigmergy.test.ts` | Stigmergy 单元测试 | **新建** |
| `src/agent/star-event.ts` | StarEvent 类型 + sensorium→phase 映射 + theta-gamma | **新建** |
| `src/agent/__tests__/star-event.test.ts` | StarEvent 单元测试 | **新建** |
| `src/agent/dissipative-kick.ts` | 耗散踢触发 + 动作序列 | **新建** |
| `src/agent/__tests__/dissipative-kick.test.ts` | 耗散踢单元测试 | **新建** |
| `src/tui/star-status.tsx` | TUI 组件：星图阶段 + 态势摘要 | **新建** |
| `src/agent/loop.ts` | 每 turn 调用 computeSensorium，emit StarEvent | **修改** |

---

## Phase 1: AgentSensorium

### 任务 1：Sensorium 接口 + computeSensorium

**文件：**
- 创建：`src/agent/sensorium.ts`
- 创建：`src/agent/__tests__/sensorium.test.ts`

- [ ] **步骤 1：编写失败测试**

`src/agent/__tests__/sensorium.test.ts`:

```typescript
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { computeSensorium, computeStrategy } from '../sensorium.js'
import type { Sensorium, SensoriumInput } from '../sensorium.js'

describe('computeSensorium', () => {
  it('computes momentum from prediction accumulator', () => {
    const input: SensoriumInput = {
      predictionAcc: { windowSize: 10, predictions: [], consecutiveCorrect: 7 },
      pressureResult: { tier: 0, shouldCompact: false, thrashing: false, ratio: 0.3 },
      evidenceState: { filesModified: 3, verifiedCount: 2 },
      toolCallHistory: ['bash', 'read_file', 'bash', 'write_file', 'bash'],
      pheromones: [],
      doomLevel: 'none',
    }
    const s = computeSensorium(input)
    assert.equal(s.momentum, 0.7) // 7/10
    assert.equal(s.pressure, 0.3)
    assert(s.confidence >= 0 && s.confidence <= 1)
  })

  it('computes complexity from tool diversity in sliding window', () => {
    const input: SensoriumInput = {
      predictionAcc: { windowSize: 10, predictions: [], consecutiveCorrect: 0 },
      pressureResult: { tier: 0, shouldCompact: false, thrashing: false, ratio: 0.1 },
      evidenceState: { filesModified: 0, verifiedCount: 0 },
      toolCallHistory: ['bash', 'read_file', 'write_file', 'edit_file', 'git'],
      pheromones: [],
      doomLevel: 'none',
    }
    const s = computeSensorium(input)
    assert.equal(s.complexity, 1.0) // 5 unique / 5 total
  })

  it('computes stability from doom level', () => {
    const input: SensoriumInput = {
      predictionAcc: { windowSize: 10, predictions: [], consecutiveCorrect: 0 },
      pressureResult: { tier: 0, shouldCompact: false, thrashing: false, ratio: 0 },
      evidenceState: { filesModified: 0, verifiedCount: 0 },
      toolCallHistory: [],
      pheromones: [],
      doomLevel: 'blocked',
    }
    const s = computeSensorium(input)
    assert(s.stability < 0.5)
  })

  it('clamps all dimensions to 0-1', () => {
    const input: SensoriumInput = {
      predictionAcc: { windowSize: 5, predictions: [], consecutiveCorrect: 20 },
      pressureResult: { tier: 3, shouldCompact: true, thrashing: true, ratio: 1.5 },
      evidenceState: { filesModified: 0, verifiedCount: 5 },
      toolCallHistory: [],
      pheromones: [{ path: 'a.ts', signal: 'well-tested', strength: 0.9, depositedAt: Date.now(), halfLife: 604800000 }],
      doomLevel: 'none',
    }
    const s = computeSensorium(input)
    for (const key of ['momentum', 'pressure', 'confidence', 'complexity', 'freshness', 'stability'] as const) {
      assert(s[key] >= 0 && s[key] <= 1, `${key} = ${s[key]} out of range`)
    }
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npx tsx --test src/agent/__tests__/sensorium.test.ts`
预期：FAIL — `Cannot find module '../sensorium.js'`

- [ ] **步骤 3：实现 computeSensorium**

`src/agent/sensorium.ts`:

```typescript
import type { PredictionAccumulator } from './prediction-error.js'
import type { PressureResult } from '../context/pressure-monitor.js'

export interface PheromoneSnapshot {
  path: string
  signal: string
  strength: number
  depositedAt: number
  halfLife: number
}

export interface EvidenceSummary {
  filesModified: number
  verifiedCount: number
}

export interface SensoriumInput {
  predictionAcc: PredictionAccumulator
  pressureResult: PressureResult
  evidenceState: EvidenceSummary
  toolCallHistory: string[]
  pheromones: PheromoneSnapshot[]
  doomLevel: 'none' | 'warn' | 'blocked'
}

export interface Sensorium {
  momentum: number
  pressure: number
  confidence: number
  complexity: number
  freshness: number
  stability: number
}

export interface StrategyProfile {
  reasoningEffort: 'off' | 'low' | 'medium' | 'high' | 'max'
  explorationBreadth: number
  commitThreshold: number
  shouldEscalate: boolean
  thetaCycleInterval: number
}

const SLIDING_WINDOW = 5
const DOOM_WEIGHTS: Record<string, number> = { none: 0, warn: 2, blocked: 4 }

function clamp(v: number): number {
  return Math.max(0, Math.min(1, v))
}

export function computeSensorium(input: SensoriumInput): Sensorium {
  const { predictionAcc, pressureResult, evidenceState, toolCallHistory, pheromones, doomLevel } = input

  const momentum = clamp(predictionAcc.consecutiveCorrect / predictionAcc.windowSize)
  const pressure = clamp(pressureResult.ratio)

  const confidence = evidenceState.filesModified > 0
    ? clamp(evidenceState.verifiedCount / evidenceState.filesModified)
    : 0

  const recent = toolCallHistory.slice(-SLIDING_WINDOW)
  const complexity = recent.length > 0
    ? clamp(new Set(recent).size / recent.length)
    : 0

  const now = Date.now()
  const activeStrengths = pheromones.map(p =>
    p.strength * Math.exp(-0.693 * (now - p.depositedAt) / p.halfLife)
  )
  const freshness = activeStrengths.length > 0
    ? clamp(activeStrengths.reduce((a, b) => a + b, 0) / activeStrengths.length)
    : 0

  const stability = clamp(1.0 - (DOOM_WEIGHTS[doomLevel] ?? 0) / 5)

  return { momentum, pressure, confidence, complexity, freshness, stability }
}

export function computeStrategy(s: Sensorium): StrategyProfile {
  return {
    reasoningEffort: s.complexity > 0.7 ? 'high' : s.momentum > 0.8 ? 'low' : 'medium',
    explorationBreadth: s.stability < 0.3 ? 0.9 : 0.3,
    commitThreshold: s.pressure > 0.7 ? 0.9 : 0.6,
    shouldEscalate: s.confidence < 0.3 && s.momentum < 0.2,
    thetaCycleInterval: s.complexity > 0.5 ? 3 : 7,
  }
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`npx tsx --test src/agent/__tests__/sensorium.test.ts`
预期：PASS — 全部通过

- [ ] **步骤 5：提交**

```
feat(agent): add AgentSensorium 6-dimension sensing + computeStrategy
```

### 任务 2：computeStrategy 测试

**文件：**
- 修改：`src/agent/__tests__/sensorium.test.ts`

- [ ] **步骤 1：追加 computeStrategy 测试**

追加到 `src/agent/__tests__/sensorium.test.ts`:

```typescript
describe('computeStrategy', () => {
  it('returns high reasoning for complex tasks', () => {
    const s: Sensorium = { momentum: 0.5, pressure: 0.3, confidence: 0.5, complexity: 0.8, freshness: 0.5, stability: 0.7 }
    const p = computeStrategy(s)
    assert.equal(p.reasoningEffort, 'high')
    assert.equal(p.thetaCycleInterval, 3)
  })

  it('returns low reasoning when momentum is high', () => {
    const s: Sensorium = { momentum: 0.9, pressure: 0.3, confidence: 0.8, complexity: 0.3, freshness: 0.5, stability: 0.9 }
    const p = computeStrategy(s)
    assert.equal(p.reasoningEffort, 'low')
  })

  it('escalates when confidence and momentum are both low', () => {
    const s: Sensorium = { momentum: 0.1, pressure: 0.5, confidence: 0.2, complexity: 0.5, freshness: 0.3, stability: 0.4 }
    const p = computeStrategy(s)
    assert.equal(p.shouldEscalate, true)
  })

  it('does not escalate when confidence is adequate', () => {
    const s: Sensorium = { momentum: 0.1, pressure: 0.5, confidence: 0.5, complexity: 0.5, freshness: 0.3, stability: 0.4 }
    const p = computeStrategy(s)
    assert.equal(p.shouldEscalate, false)
  })

  it('widens exploration when stability is low', () => {
    const s: Sensorium = { momentum: 0.3, pressure: 0.3, confidence: 0.5, complexity: 0.5, freshness: 0.5, stability: 0.2 }
    const p = computeStrategy(s)
    assert.equal(p.explorationBreadth, 0.9)
  })

  it('raises commit threshold under high pressure', () => {
    const s: Sensorium = { momentum: 0.5, pressure: 0.8, confidence: 0.5, complexity: 0.5, freshness: 0.5, stability: 0.7 }
    const p = computeStrategy(s)
    assert.equal(p.commitThreshold, 0.9)
  })
})
```

- [ ] **步骤 2：运行测试验证通过**

运行：`npx tsx --test src/agent/__tests__/sensorium.test.ts`
预期：PASS

- [ ] **步骤 3：提交**

```
test(agent): add computeStrategy unit tests
```

---

## Phase 2: Stigmergy

### 任务 3：StigmergyStore 核心

**文件：**
- 创建：`src/context/stigmergy.ts`
- 创建：`src/context/__tests__/stigmergy.test.ts`

- [ ] **步骤 1：编写失败测试**

`src/context/__tests__/stigmergy.test.ts`:

```typescript
import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { StigmergyStore } from '../stigmergy.js'
import type { Pheromone, PheromoneSignal } from '../stigmergy.js'

describe('StigmergyStore', () => {
  let store: StigmergyStore

  beforeEach(() => {
    store = new StigmergyStore()
  })

  it('deposits and queries pheromones', () => {
    store.deposit({ path: 'src/a.ts', signal: 'fragile', strength: 0.8 })
    const results = store.query('src/a.ts')
    assert.equal(results.length, 1)
    assert.equal(results[0]!.signal, 'fragile')
    assert.equal(results[0]!.strength, 0.8)
  })

  it('decays pheromone strength over time', () => {
    const halfLife = 1000 // 1 second for testing
    store.deposit({ path: 'src/b.ts', signal: 'well-tested', strength: 1.0, halfLife })
    const p = store.query('src/b.ts')[0]!
    // Simulate passage of one half-life
    const decayed = store.currentStrength({ ...p, depositedAt: Date.now() - halfLife })
    assert(decayed < 0.55 && decayed > 0.45, `Expected ~0.5, got ${decayed}`)
  })

  it('prunes entries below threshold', () => {
    store.deposit({ path: 'src/c.ts', signal: 'dead-end', strength: 0.04 })
    store.prune()
    assert.equal(store.query('src/c.ts').length, 0)
  })

  it('enforces max 200 entries via LRU', () => {
    for (let i = 0; i < 210; i++) {
      store.deposit({ path: `src/file${i}.ts`, signal: 'entry-point', strength: 0.5 })
    }
    store.prune()
    assert(store.size() <= 200)
  })

  it('serializes and deserializes', () => {
    store.deposit({ path: 'src/d.ts', signal: 'coupling-hub', strength: 0.6 })
    const json = store.serialize()
    const restored = StigmergyStore.deserialize(json)
    assert.equal(restored.query('src/d.ts').length, 1)
  })

  it('merges duplicate path+signal by taking max strength', () => {
    store.deposit({ path: 'src/e.ts', signal: 'fragile', strength: 0.5 })
    store.deposit({ path: 'src/e.ts', signal: 'fragile', strength: 0.9 })
    const results = store.query('src/e.ts')
    assert.equal(results.length, 1)
    assert.equal(results[0]!.strength, 0.9)
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npx tsx --test src/context/__tests__/stigmergy.test.ts`
预期：FAIL — `Cannot find module '../stigmergy.js'`

- [ ] **步骤 3：实现 StigmergyStore**

`src/context/stigmergy.ts`:

```typescript
export type PheromoneSignal =
  | 'fragile'
  | 'well-tested'
  | 'performance-critical'
  | 'refactor-candidate'
  | 'dead-end'
  | 'entry-point'
  | 'coupling-hub'

export interface Pheromone {
  path: string
  signal: PheromoneSignal
  strength: number
  depositedAt: number
  halfLife: number
  context?: string
}

export interface DepositInput {
  path: string
  signal: PheromoneSignal
  strength: number
  halfLife?: number
  context?: string
}

const DEFAULT_HALF_LIFE = 7 * 24 * 60 * 60_000 // 7 days
const MAX_ENTRIES = 200
const PRUNE_THRESHOLD = 0.05

export class StigmergyStore {
  private entries: Pheromone[] = []

  deposit(input: DepositInput): void {
    const existing = this.entries.find(e => e.path === input.path && e.signal === input.signal)
    if (existing) {
      existing.strength = Math.max(existing.strength, input.strength)
      existing.depositedAt = Date.now()
      if (input.context) existing.context = input.context
    } else {
      this.entries.push({
        path: input.path,
        signal: input.signal,
        strength: input.strength,
        depositedAt: Date.now(),
        halfLife: input.halfLife ?? DEFAULT_HALF_LIFE,
        context: input.context,
      })
    }
  }

  query(path: string): Pheromone[] {
    return this.entries.filter(e => e.path === path)
  }

  queryBySignal(signal: PheromoneSignal): Pheromone[] {
    return this.entries.filter(e => e.signal === signal)
  }

  currentStrength(p: Pheromone): number {
    const elapsed = Date.now() - p.depositedAt
    return p.strength * Math.exp(-0.693 * elapsed / p.halfLife)
  }

  prune(): void {
    // Remove weak entries
    this.entries = this.entries.filter(e => this.currentStrength(e) >= PRUNE_THRESHOLD)
    // LRU if over max
    if (this.entries.length > MAX_ENTRIES) {
      this.entries.sort((a, b) => b.depositedAt - a.depositedAt)
      this.entries = this.entries.slice(0, MAX_ENTRIES)
    }
  }

  size(): number {
    return this.entries.length
  }

  serialize(): string {
    return JSON.stringify(this.entries, null, 2)
  }

  static deserialize(json: string): StigmergyStore {
    const store = new StigmergyStore()
    store.entries = JSON.parse(json) as Pheromone[]
    return store
  }

  getSnapshots(): Array<{ path: string; signal: string; strength: number; depositedAt: number; halfLife: number }> {
    return this.entries.map(e => ({
      path: e.path,
      signal: e.signal,
      strength: this.currentStrength(e),
      depositedAt: e.depositedAt,
      halfLife: e.halfLife,
    }))
  }
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`npx tsx --test src/context/__tests__/stigmergy.test.ts`
预期：PASS

- [ ] **步骤 5：提交**

```
feat(context): add StigmergyStore for cross-session pheromone memory
```

### 任务 4：Stigmergy 文件 I/O + 自动沉积规则

**文件：**
- 修改：`src/context/stigmergy.ts`
- 修改：`src/context/__tests__/stigmergy.test.ts`

- [ ] **步骤 1：追加文件 I/O 测试**

追加到 `src/context/__tests__/stigmergy.test.ts`:

```typescript
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { autoDeposit } from '../stigmergy.js'
import type { AutoDepositEvent } from '../stigmergy.js'

describe('StigmergyStore file I/O', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'stigmergy-'))
  })

  it('saves to and loads from disk', () => {
    const s1 = new StigmergyStore()
    s1.deposit({ path: 'x.ts', signal: 'fragile', strength: 0.7 })
    s1.saveTo(join(dir, 'pheromones.json'))

    const s2 = StigmergyStore.loadFrom(join(dir, 'pheromones.json'))
    assert.equal(s2.query('x.ts').length, 1)
  })

  it('returns empty store if file missing', () => {
    const s = StigmergyStore.loadFrom(join(dir, 'nope.json'))
    assert.equal(s.size(), 0)
  })
})

describe('autoDeposit', () => {
  it('deposits well-tested on write+test pass', () => {
    const store = new StigmergyStore()
    const event: AutoDepositEvent = {
      tool: 'write_file',
      path: 'src/foo.ts',
      outcome: 'success',
      testPassed: true,
    }
    autoDeposit(store, event)
    const results = store.query('src/foo.ts')
    assert.equal(results[0]!.signal, 'well-tested')
    assert.equal(results[0]!.strength, 0.6)
  })

  it('deposits fragile on write+test fail', () => {
    const store = new StigmergyStore()
    const event: AutoDepositEvent = {
      tool: 'write_file',
      path: 'src/bar.ts',
      outcome: 'success',
      testPassed: false,
    }
    autoDeposit(store, event)
    assert.equal(store.query('src/bar.ts')[0]!.signal, 'fragile')
  })

  it('deposits dead-end on repeated bash failure', () => {
    const store = new StigmergyStore()
    const event: AutoDepositEvent = {
      tool: 'bash',
      path: 'src/baz.ts',
      outcome: 'failed',
      failCount: 2,
    }
    autoDeposit(store, event)
    assert.equal(store.query('src/baz.ts')[0]!.signal, 'dead-end')
    assert.equal(store.query('src/baz.ts')[0]!.strength, 0.9)
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npx tsx --test src/context/__tests__/stigmergy.test.ts`
预期：FAIL — `autoDeposit` 和 `saveTo`/`loadFrom` 不存在

- [ ] **步骤 3：实现文件 I/O + autoDeposit**

追加到 `src/context/stigmergy.ts`:

```typescript
import { existsSync, readFileSync } from 'node:fs'
import { writeFileAtomicSync } from '../fs-atomic.js'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

// Add to StigmergyStore class:
  saveTo(filePath: string): void {
    mkdirSync(dirname(filePath), { recursive: true })
    writeFileAtomicSync(filePath, this.serialize())
  }

  static loadFrom(filePath: string): StigmergyStore {
    if (!existsSync(filePath)) return new StigmergyStore()
    return StigmergyStore.deserialize(readFileSync(filePath, 'utf-8'))
  }

// Standalone function:
export interface AutoDepositEvent {
  tool: string
  path: string
  outcome: 'success' | 'failed'
  testPassed?: boolean
  failCount?: number
}

export function autoDeposit(store: StigmergyStore, event: AutoDepositEvent): void {
  if (event.tool === 'write_file' && event.outcome === 'success') {
    if (event.testPassed === true) {
      store.deposit({ path: event.path, signal: 'well-tested', strength: 0.6 })
    } else if (event.testPassed === false) {
      store.deposit({ path: event.path, signal: 'fragile', strength: 0.8 })
    }
  }
  if (event.tool === 'bash' && event.outcome === 'failed' && (event.failCount ?? 0) >= 2) {
    store.deposit({ path: event.path, signal: 'dead-end', strength: 0.9 })
  }
}
```

- [ ] **步骤 4：运行测试验证通过**
- [ ] **步骤 5：提交**

```
feat(context): add stigmergy file I/O and auto-deposit rules
```

---

## Phase 3: StarFlow TUI Integration

### 任务 5：StarEvent 类型 + Phase 映射

**文件：**
- 创建：`src/agent/star-event.ts`
- 创建：`src/agent/__tests__/star-event.test.ts`

- [ ] **步骤 1：编写失败测试**

`src/agent/__tests__/star-event.test.ts`:

```typescript
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mapSensoriumToPhase } from '../star-event.js'
import type { StarPhase, StarEvent } from '../star-event.js'
import type { Sensorium } from '../sensorium.js'

describe('mapSensoriumToPhase', () => {
  const base: Sensorium = { momentum: 0.5, pressure: 0.3, confidence: 0.5, complexity: 0.5, freshness: 0.5, stability: 0.7 }

  it('maps first turn + shouldEscalate to tianshu', () => {
    const phase = mapSensoriumToPhase({ ...base, confidence: 0.1, momentum: 0.1 }, { turn: 1, isWriting: false, isRunningTests: false })
    assert.equal(phase, 'tianshu')
  })

  it('maps high freshness to ziwei (寻迹)', () => {
    const phase = mapSensoriumToPhase({ ...base, freshness: 0.8 }, { turn: 3, isWriting: false, isRunningTests: false })
    assert.equal(phase, 'ziwei')
  })

  it('maps high complexity to tianji (排阵)', () => {
    const phase = mapSensoriumToPhase({ ...base, complexity: 0.7, freshness: 0.3 }, { turn: 3, isWriting: false, isRunningTests: false })
    assert.equal(phase, 'tianji')
  })

  it('maps confidence + writing to yuheng (铸形)', () => {
    const phase = mapSensoriumToPhase({ ...base, confidence: 0.7, freshness: 0.3, complexity: 0.3 }, { turn: 3, isWriting: true, isRunningTests: false })
    assert.equal(phase, 'yuheng')
  })

  it('maps running tests to kaiyang (试锋)', () => {
    const phase = mapSensoriumToPhase(base, { turn: 3, isWriting: false, isRunningTests: true })
    assert.equal(phase, 'kaiyang')
  })

  it('maps high momentum final turn to yaoguang (归航)', () => {
    const phase = mapSensoriumToPhase({ ...base, momentum: 0.9 }, { turn: 10, isWriting: false, isRunningTests: false, isFinalTurn: true })
    assert.equal(phase, 'yaoguang')
  })

  it('maps low confidence mid-task to tianshu-encore (二次请星)', () => {
    const phase = mapSensoriumToPhase({ ...base, confidence: 0.2, momentum: 0.1 }, { turn: 5, isWriting: false, isRunningTests: false })
    assert.equal(phase, 'tianshu-encore')
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npx tsx --test src/agent/__tests__/star-event.test.ts`
预期：FAIL — `Cannot find module '../star-event.js'`

- [ ] **步骤 3：实现 StarEvent + mapping**

`src/agent/star-event.ts`:

```typescript
import type { Sensorium, StrategyProfile } from './sensorium.js'

export type StarPhase =
  | 'tianshu'        // 天枢 — 请星/规划
  | 'ziwei'          // 紫微 — 寻迹/定位
  | 'tianji'         // 天玑 — 排阵/拆解
  | 'yuheng'         // 玉衡 — 铸形/实现
  | 'kaiyang'        // 开阳 — 试锋/验证
  | 'yaoguang'       // 摇光 — 归航/交付
  | 'tianshu-encore' // 天枢再临 — 二次请星

export interface StarEvent {
  phase: StarPhase
  sensorium: Sensorium
  strategy: StrategyProfile
  timestamp: number
  turn: number
}

export interface PhaseContext {
  turn: number
  isWriting: boolean
  isRunningTests: boolean
  isFinalTurn?: boolean
}

export function mapSensoriumToPhase(s: Sensorium, ctx: PhaseContext): StarPhase {
  // Test phase takes priority
  if (ctx.isRunningTests) return 'kaiyang'

  // Final delivery
  if (ctx.isFinalTurn && s.momentum > 0.8) return 'yaoguang'

  // Escalation: first turn or mid-task low confidence
  if (ctx.turn === 1 && s.confidence < 0.3 && s.momentum < 0.2) return 'tianshu'
  if (ctx.turn > 1 && s.confidence < 0.3 && s.momentum < 0.2) return 'tianshu-encore'

  // Exploration phase
  if (s.freshness > 0.7) return 'ziwei'

  // Decomposition phase
  if (s.complexity > 0.5) return 'tianji'

  // Implementation phase
  if (ctx.isWriting && s.confidence > 0.6) return 'yuheng'

  // Default to implementation if writing, else exploration
  return ctx.isWriting ? 'yuheng' : 'ziwei'
}
```

- [ ] **步骤 4：运行测试验证通过**
- [ ] **步骤 5：提交**

```
feat(agent): add StarEvent type and sensorium-to-phase mapping
```

### 任务 6：Theta-Gamma 节律检查

**文件：**
- 修改：`src/agent/star-event.ts`
- 修改：`src/agent/__tests__/star-event.test.ts`

- [ ] **步骤 1：追加 theta-gamma 测试**

追加到 `src/agent/__tests__/star-event.test.ts`:

```typescript
import { shouldRunThetaCycle, type ThetaState } from '../star-event.js'

describe('shouldRunThetaCycle', () => {
  it('triggers at interval boundary', () => {
    const state: ThetaState = { toolCallCount: 6, lastThetaAt: 3, interval: 3 }
    assert.equal(shouldRunThetaCycle(state), true)
  })

  it('does not trigger mid-interval', () => {
    const state: ThetaState = { toolCallCount: 5, lastThetaAt: 3, interval: 3 }
    assert.equal(shouldRunThetaCycle(state), false)
  })

  it('does not trigger if complexity below threshold', () => {
    const state: ThetaState = { toolCallCount: 6, lastThetaAt: 3, interval: 7 }
    assert.equal(shouldRunThetaCycle(state), false)
  })
})
```

- [ ] **步骤 2：实现 shouldRunThetaCycle**

追加到 `src/agent/star-event.ts`:

```typescript
export interface ThetaState {
  toolCallCount: number
  lastThetaAt: number
  interval: number
}

export function shouldRunThetaCycle(state: ThetaState): boolean {
  return (state.toolCallCount - state.lastThetaAt) >= state.interval
}
```

- [ ] **步骤 3：运行测试验证通过**
- [ ] **步骤 4：提交**

```
feat(agent): add theta-gamma cycle trigger logic
```

### 任务 7：StarStatus TUI 组件

**文件：**
- 创建：`src/tui/star-status.tsx`

- [ ] **步骤 1：实现 StarStatus 组件**

`src/tui/star-status.tsx`:

```typescript
import React from 'react'
import { Text, Box } from 'ink'
import type { StarEvent, StarPhase } from '../agent/star-event.js'

const PHASE_GLYPHS: Record<StarPhase, string> = {
  'tianshu': '⭐ 天枢授策',
  'ziwei': '🔍 紫微寻迹',
  'tianji': '📐 天玑排阵',
  'yuheng': '🔨 玉衡铸形',
  'kaiyang': '⚔️ 开阳试锋',
  'yaoguang': '🏠 摇光归航',
  'tianshu-encore': '⭐⭐ 天枢再临',
}

interface Props {
  event: StarEvent | null
}

export function StarStatus({ event }: Props): React.ReactElement | null {
  if (!event) return null
  const { phase, sensorium } = event
  const glyph = PHASE_GLYPHS[phase]
  const da = sensorium.momentum.toFixed(1)
  const sht = sensorium.pressure.toFixed(1)
  const ne = sensorium.stability < 0.3 ? 'tonic' : 'phasic'

  return (
    <Box>
      <Text>{glyph} │ DA:{da} 5HT:{sht} NE:{ne} │ 📁 {sensorium.complexity.toFixed(1)}</Text>
    </Box>
  )
}
```

- [ ] **步骤 2：提交**

```
feat(tui): add StarStatus component for star-phase display
```

---

## Phase 4: Dissipative Kick + 二次请星

### 任务 8：Dissipative Kick

**文件：**
- 创建：`src/agent/dissipative-kick.ts`
- 创建：`src/agent/__tests__/dissipative-kick.test.ts`

- [ ] **步骤 1：编写失败测试**

`src/agent/__tests__/dissipative-kick.test.ts`:

```typescript
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { shouldKick, buildKickActions } from '../dissipative-kick.js'
import type { KickAction } from '../dissipative-kick.js'
import type { Sensorium } from '../sensorium.js'

describe('dissipative kick', () => {
  it('triggers when momentum < 0.2 and stability < 0.3', () => {
    const s: Sensorium = { momentum: 0.1, pressure: 0.5, confidence: 0.3, complexity: 0.5, freshness: 0.3, stability: 0.2 }
    assert.equal(shouldKick(s), true)
  })

  it('does not trigger when momentum is adequate', () => {
    const s: Sensorium = { momentum: 0.5, pressure: 0.5, confidence: 0.3, complexity: 0.5, freshness: 0.3, stability: 0.2 }
    assert.equal(shouldKick(s), false)
  })

  it('does not trigger when stability is adequate', () => {
    const s: Sensorium = { momentum: 0.1, pressure: 0.5, confidence: 0.3, complexity: 0.5, freshness: 0.3, stability: 0.5 }
    assert.equal(shouldKick(s), false)
  })

  it('builds action sequence with dead-end deposit', () => {
    const actions = buildKickActions('src/stuck.ts')
    assert(actions.some(a => a.type === 'deposit-dead-end'))
    assert(actions.some(a => a.type === 'switch-exploration'))
    assert(actions.some(a => a.type === 'scan-remote'))
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npx tsx --test src/agent/__tests__/dissipative-kick.test.ts`
预期：FAIL — `Cannot find module '../dissipative-kick.js'`

- [ ] **步骤 3：实现 dissipative-kick**

`src/agent/dissipative-kick.ts`:

```typescript
import type { Sensorium } from './sensorium.js'

export type KickActionType = 'deposit-dead-end' | 'switch-exploration' | 'scan-remote' | 'reread-request' | 'escalate'

export interface KickAction {
  type: KickActionType
  payload?: string
}

export function shouldKick(s: Sensorium): boolean {
  return s.momentum < 0.2 && s.stability < 0.3
}

export function buildKickActions(currentFilePath: string): KickAction[] {
  return [
    { type: 'deposit-dead-end', payload: currentFilePath },
    { type: 'switch-exploration' },
    { type: 'scan-remote', payload: currentFilePath },
    { type: 'reread-request' },
  ]
}

export function shouldEscalateFromKick(s: Sensorium): boolean {
  return shouldKick(s) && s.confidence < 0.3
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`npx tsx --test src/agent/__tests__/dissipative-kick.test.ts`
预期：PASS

- [ ] **步骤 5：提交**

```
feat(agent): add dissipative kick for stagnation breakthrough
```

### 任务 9：Loop 集成

**文件：**
- 修改：`src/agent/loop.ts`

- [ ] **步骤 1：在 loop.ts 顶部添加导入**

```typescript
import { computeSensorium, computeStrategy } from './sensorium.js'
import type { Sensorium, StrategyProfile, SensoriumInput } from './sensorium.js'
import { mapSensoriumToPhase, shouldRunThetaCycle } from './star-event.js'
import type { StarEvent, ThetaState } from './star-event.js'
import { shouldKick, buildKickActions, shouldEscalateFromKick } from './dissipative-kick.js'
```

- [ ] **步骤 2：在 AgentLoop 类添加状态字段**

```typescript
private sensorium: Sensorium | null = null
private strategy: StrategyProfile | null = null
private thetaState: ThetaState = { toolCallCount: 0, lastThetaAt: 0, interval: 7 }
```

- [ ] **步骤 3：在每 turn 开始处调用 computeSensorium**

在 turn 循环的开始处（在调用 stream 之前），插入：

```typescript
const sensoriumInput: SensoriumInput = {
  predictionAcc: this.predictionAcc,
  pressureResult: pressureResult,
  evidenceState: {
    filesModified: this.evidence.getState().filesModified.size,
    verifiedCount: this.evidence.getState().verifications.filter(v => v.status === 'passed').length,
  },
  toolCallHistory: this.recentToolHistory.map(h => h.tool),
  pheromones: [],  // Phase 2 will wire StigmergyStore here
  doomLevel: getDoomLoopLevel(this.traceStore),
}
this.sensorium = computeSensorium(sensoriumInput)
this.strategy = computeStrategy(this.sensorium)

// Update theta interval from strategy
this.thetaState = { ...this.thetaState, interval: this.strategy.thetaCycleInterval }

// Emit StarEvent
if (this.callbacks.onPhaseChange) {
  const phase = mapSensoriumToPhase(this.sensorium, {
    turn: turnNumber,
    isWriting: false,
    isRunningTests: false,
  })
  this.callbacks.onPhaseChange(phase)
}

// Check dissipative kick
if (shouldKick(this.sensorium)) {
  const actions = buildKickActions(this.cwd)
  // Execute kick actions via existing mechanisms
  if (shouldEscalateFromKick(this.sensorium) && this.callbacks.onPhaseChange) {
    this.callbacks.onPhaseChange('tianshu-encore')
  }
}
```

- [ ] **步骤 4：运行全量测试验证无回归**

运行：`npx tsx --test src/agent/__tests__/loop.test.ts`
预期：PASS

- [ ] **步骤 5：提交**

```
feat(agent): wire sensorium + star-event + dissipative-kick into agent loop
```

---

## 验收标准

| 检查项 | 标准 |
|--------|------|
| 全部测试通过 | `npm test` 零失败 |
| 类型检查通过 | `npx tsc --noEmit` 零错误 |
| Sensorium 纯计算 | < 1ms/turn（无 I/O，无 LLM） |
| Stigmergy 文件 | 最大 200 条，自动衰减，< 50KB |
| StarEvent 映射 | 6 种阶段 + 1 种 encore 正确映射 |
| Dissipative kick | momentum < 0.2 && stability < 0.3 时触发 |
| 不修改现有模块逻辑 | 只读取现有监控器输出，loop.ts 仅追加代码 |
