# Physarum 拓扑重塑 + 免疫防御分层：统一设计

> 日期：2026-05-24
> 阶段：Phase 4 Week 1
> 前置：Meridian Graph Phase 3 (multi-lang parser + edge confidence)
> 理论基础：Physarum polycephalum 网络优化 + Matzinger Danger Theory + STDP

## 1. 设计目标

将 Meridian Graph 的静态拓扑升级为**自适应演化网络**，同时引入**分层免疫系统**保护图的健康。两者的交互点是核心：

- Physarum 提供"健康基线"——正常的图演化模式
- 免疫系统检测偏离基线的"危险信号"并响应
- 免疫响应的结果反馈到图的拓扑调整

## 2. 架构概览

```
┌─────────────────────────────────────────────────────────────┐
│                    Agent Loop (每 turn)                       │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  ┌─────────────┐    danger signals    ┌──────────────────┐ │
│  │  Physarum   │ ──────────────────→  │  Immune Layer    │ │
│  │  Topology   │                      │  (3-tier)        │ │
│  │  Engine     │ ←────────────────── │                  │ │
│  │             │    repair feedback   │  Innate → APC    │ │
│  │  • flow     │                      │  → Adaptive      │ │
│  │  • decay    │                      │  → Memory        │ │
│  │  • scaling  │                      └──────────────────┘ │
│  │  • pruning  │                                           │
│  └──────┬──────┘                                           │
│         │                                                   │
│         ↓                                                   │
│  ┌─────────────┐                                           │
│  │  Meridian   │  ← co-edit / access / tool results        │
│  │  Graph DB   │                                           │
│  └─────────────┘                                           │
└─────────────────────────────────────────────────────────────┘
```

## 3. Physarum 拓扑引擎

### 3.1 导管方程（核心）

每条边的权重按以下方程演化：

```typescript
interface PhysarumEdgeState {
  weight: number           // 当前导管粗细
  flow: number             // 最近 N turns 的流量（access count）
  consolidated: boolean    // 是否已巩固（长期记忆）
  activationCount: number  // 累计激活次数
  lastActivated: number    // 最后激活 turn
  direction: number        // STDP 方向性 [-1, 1]
}

// 每 turn 结束时执行
function evolveEdge(edge: PhysarumEdgeState, now: number): void {
  // 1. 流量驱动增长（Physarum 正反馈）
  const growth = GROWTH_RATE * Math.pow(edge.flow, GAMMA) // γ>1 赢者通吃

  // 2. 衰减（Physarum 负反馈）
  const decayRate = edge.consolidated ? TAU_LONG : TAU_SHORT
  const decay = edge.weight * (1 - Math.exp(-(now - edge.lastActivated) / decayRate))

  // 3. 更新
  edge.weight = Math.max(0, edge.weight + growth - decay)

  // 4. 巩固检查（LTP → L-LTP 转换）
  if (!edge.consolidated && edge.activationCount >= CONSOLIDATION_THRESHOLD) {
    edge.consolidated = true
  }

  // 5. 剪枝（结构可塑性）
  if (edge.weight < PRUNE_THRESHOLD && !edge.consolidated) {
    // 标记为待删除
  }
}
```

### 3.2 Homeostatic Scaling（防止超级节点）

```typescript
function synapticScaling(nodeId: string, edges: PhysarumEdgeState[]): void {
  const totalWeight = edges.reduce((sum, e) => sum + e.weight, 0)
  if (totalWeight > SYNAPTIC_BUDGET) {
    const scale = SYNAPTIC_BUDGET / totalWeight
    edges.forEach(e => { e.weight *= scale })
  }
}
```

### 3.3 Anti-Hebbian Ubiquity Penalty

```typescript
function ubiquityPenalty(nodeId: string, connectivity: number, totalNodes: number): number {
  const ratio = connectivity / totalNodes
  if (ratio > UBIQUITY_THRESHOLD) { // 如 0.3
    return Math.log(ratio / UBIQUITY_THRESHOLD) // IDF-like penalty
  }
  return 0
}
```

### 3.4 STDP 有向边（预测性）

```typescript
### 3.4 STDP 有向边（预测性）

在现有无向 co-edit 权重基础上，增加有向 STDP 权重用于预测"接下来可能编辑哪个文件"：

```typescript
function updateSTDP(fileA: string, fileB: string, dtTurns: number): void {
  // dtTurns = editTurn(B) - editTurn(A)，正值表示 A 先于 B
  if (dtTurns > 0 && dtTurns < TAU_WINDOW) {
    // A→B 方向增强
    const delta = A_PLUS * Math.exp(-dtTurns / TAU_PLUS)
    db.updateDirectionalWeight(fileA, fileB, delta)
  } else if (dtTurns < 0 && Math.abs(dtTurns) < TAU_WINDOW) {
    // A→B 方向抑制
    const delta = -A_MINUS * Math.exp(dtTurns / TAU_MINUS)
    db.updateDirectionalWeight(fileA, fileB, delta)
  }
}
```

用途：spreading activation 时，有向权重用于预测"从当前文件出发，下一步最可能需要哪个文件"。

### 3.5 SOC 临界态监控

监控 spreading activation 的"雪崩"分布，自动调参：

```typescript
interface AvalancheStats {
  sizes: number[]  // 最近 100 次激活的影响节点数
}

function checkCriticality(stats: AvalancheStats): 'subcritical' | 'critical' | 'supercritical' {
  // 拟合幂律指数 α
  const alpha = fitPowerLaw(stats.sizes)
  if (alpha > 2.5) return 'subcritical'   // decay 太强，雪崩全是小的
  if (alpha < 1.5) return 'supercritical' // decay 太弱，雪崩经常很大
  return 'critical'                        // α ≈ 2.0，最优
}

function adaptDecay(criticality: string, currentDecay: number): number {
  switch (criticality) {
    case 'subcritical': return currentDecay * 0.95   // 降低衰减
    case 'supercritical': return currentDecay * 1.05 // 增加衰减
    default: return currentDecay                      // 保持
  }
}
```

### 3.6 参数表

| 参数 | 默认值 | 含义 |
|------|--------|------|
| GROWTH_RATE | 0.1 | 流量驱动增长系数 |
| GAMMA | 1.2 | 流量指数（>1 赢者通吃） |
| TAU_SHORT | 7 天 | 未巩固边的衰减时间常数 |
| TAU_LONG | 90 天 | 已巩固边的衰减时间常数 |
| CONSOLIDATION_THRESHOLD | 5 | 激活次数达到此值后巩固 |
| PRUNE_THRESHOLD | 0.05 | 低于此权重的未巩固边被删除 |
| SYNAPTIC_BUDGET | 10.0 | 每节点出边权重总和上限 |
| UBIQUITY_THRESHOLD | 0.3 | 连接比例超过此值触发 penalty |
| TAU_WINDOW | 5 turns | STDP 时间窗口 |
| A_PLUS / A_MINUS | 0.3 / 0.1 | STDP 增强/抑制学习率 |

---

## 4. 免疫防御分层

### 4.1 三层架构

```
Layer 1: INNATE（先天免疫）
├─ 响应时间：<1 turn
├─ 机制：固定规则，无需学习
├─ 组件：
│   ├─ CircuitBreaker（现有）：compaction 连续失败 → 熔断
│   ├─ DoomPatternMatcher（现有 trace-store 升级）：指纹重复检测
│   └─ RateLimiter（新增）：同一工具连续调用频率限制
└─ 输出：danger signal（DAMP）

Layer 2: APC AGGREGATOR（抗原呈递层）
├─ 响应时间：1-3 turns
├─ 机制：收集多个弱信号，双信号门控
├─ 组件：
│   └─ DangerSignalAggregator（新增）
│       ├─ 信号源：compaction-fail, token-spike, tool-repeat,
│       │          prediction-error-spike, graph-anomaly
│       ├─ 门控：pattern_match AND danger_signal 同时满足
│       └─ 阈值：累积 danger score > ACTIVATION_THRESHOLD
└─ 输出：co-stimulation signal → 激活适应性层

Layer 3: ADAPTIVE（适应性免疫）
├─ 响应时间：3-10 turns
├─ 机制：学习新响应，记忆成功策略
├─ 组件：
│   ├─ MemoryLookup：查询 ImmuneMemoryStore
│   │   ├─ hit → fast repair（二次响应，1-2 turns）
│   │   └─ miss → full repair pipeline（首次响应）
│   ├─ ClonalSelection：成功策略克隆 + 超突变
│   └─ NegativeSelection：新 detector 验证
└─ 输出：repair action + memory formation
```

### 4.2 Danger Signal 类型

```typescript
type DangerSignalKind =
  | 'compaction_fail'      // compaction 失败
  | 'token_spike'          // token 使用突然飙升（>2x 平均）
  | 'tool_repeat'          // 同一工具+参数重复 3+ 次
  | 'prediction_error'     // PredictionAccumulator 误差突增
  | 'graph_anomaly'        // Physarum 检测到异常拓扑变化
  | 'repair_exhaustion'    // RepairHintTracker 达到上限
  | 'sycophancy_detected'  // SycophancyTrap 触发

interface DangerSignal {
  kind: DangerSignalKind
  severity: number       // [0, 1]
  turn: number
  source: string         // 产生信号的文件/工具
  context?: string       // 附加上下文
}
```

### 4.3 双信号门控（Danger Theory 核心）

```typescript
interface ActivationDecision {
  shouldActivate: boolean
  confidence: number
  signals: DangerSignal[]
}

function evaluateActivation(
  patternMatch: boolean,        // Signal 1: 模式匹配（doom pattern）
  dangerSignals: DangerSignal[] // Signal 2: 危险信号
): ActivationDecision {
  // 双信号门控：两者都需要满足
  if (!patternMatch) return { shouldActivate: false, confidence: 0, signals: [] }

  const dangerScore = dangerSignals.reduce((sum, s) => sum + s.severity, 0)
  const shouldActivate = dangerScore >= ACTIVATION_THRESHOLD

  return { shouldActivate, confidence: Math.min(dangerScore / 2, 1), signals: dangerSignals }
}
```

**为什么双信号比单信号好**：
- 单独的 doom pattern 匹配可能是误报（正常的重试行为）
- 单独的 danger signal 可能是噪声（偶尔的 token spike）
- 两者同时出现 → 高置信度的真实问题

### 4.4 免疫记忆（ImmuneMemoryStore）

```typescript
interface ImmuneMemory {
  id: string
  pattern: string          // 触发模式的指纹
  response: string         // 成功的修复策略描述
  affinityScore: number    // 亲和力（成功率）
  hitCount: number         // 命中次数
  lastHit: number          // 最后命中时间
  createdAt: number
  variants: string[]       // 超突变产生的变体 ID
}

class ImmuneMemoryStore {
  lookup(pattern: string): ImmuneMemory | null
  record(pattern: string, response: string, success: boolean): void
  mature(id: string): void  // 亲和力成熟
  decay(): void             // 定期衰减未命中的记忆
}
```

### 4.5 负选择验证

新的 doom detector 上线前必须通过验证：

```typescript
function negativeSelection(
  newDetector: DoomPattern,
  normalBehaviorSamples: ToolFingerprint[]
): boolean {
  // 检查新 detector 是否会匹配正常行为
  for (const sample of normalBehaviorSamples) {
    if (newDetector.matches(sample)) {
      return false // 拒绝：会产生误报
    }
  }
  return true // 通过：不匹配正常行为
}
```

---

## 5. 交互点：Physarum × 免疫

这是本设计的核心——两个子系统如何相互增强。

### 5.1 Physarum → 免疫：健康基线 + 异常检测

Physarum 引擎维护图的"正常演化模式"。偏离此模式产生 `graph_anomaly` danger signal：

```typescript
function detectGraphAnomaly(stats: PhysarumStats): DangerSignal | null {
  // 异常 1：突然大量边被剪枝（可能是错误的批量操作）
  if (stats.prunedThisTurn > stats.avgPruneRate * 3) {
    return { kind: 'graph_anomaly', severity: 0.7, ... }
  }

  // 异常 2：单节点权重暴涨（可能是 doom loop 反复访问同一文件）
  if (stats.maxNodeGrowth > stats.avgGrowth * 5) {
    return { kind: 'graph_anomaly', severity: 0.8, ... }
  }

  // 异常 3：SOC 偏离临界态
  if (stats.criticality === 'supercritical') {
    return { kind: 'graph_anomaly', severity: 0.5, ... }
  }

  return null
}
```

### 5.2 免疫 → Physarum：修复反馈 + 拓扑保护

免疫系统的响应结果反馈到图的拓扑调整：

```typescript
function applyImmuneResponse(response: ImmuneResponse, engine: PhysarumEngine): void {
  switch (response.type) {
    case 'quarantine':
      // 隔离：暂时冻结问题节点的边权演化
      engine.freezeNode(response.targetFile, response.duration)
      break

    case 'prune_toxic':
      // 剪除：doom loop 产生的虚假边（如反复 grep 同一模式产生的 co-edit）
      engine.forceprune(response.toxicEdges)
      break

    case 'boost_healthy':
      // 增强：修复成功后，正确路径的边权获得 bonus
      engine.boostEdges(response.healthyEdges, REPAIR_BONUS)
      break

    case 'deposit_warning':
      // 沉积：在问题区域留下 pheromone 警告
      stigmergyStore.deposit(response.targetFile, 'fragile', 0.8, WARN_HALFLIFE)
      break
  }
}
```

### 5.3 共享数据流

```
Tool Execution
    │
    ├─→ Physarum Engine: recordFlow(file, turn)
    │       → 更新 edge.flow
    │       → evolveEdge() 每 turn
    │       → detectGraphAnomaly() → danger signal
    │
    ├─→ Innate Layer: recordFingerprint(tool, input, output)
    │       → doom pattern check
    │       → rate limit check
    │
    └─→ APC Aggregator: collectSignal(signal)
            → 累积 danger score
            → 双信号门控
            → 激活 Adaptive Layer
                → memory lookup
                → repair or learn
                → feedback to Physarum
```

### 5.4 Pheromone 作为免疫信号载体

StigmergyStore 的 pheromone 同时服务两个系统：

| Signal | 含义 | 生产者 | 消费者 |
|--------|------|--------|--------|
| `fragile` | 此文件容易导致问题 | 免疫系统 | Physarum（降低增长率） |
| `hot` | 此文件正在被频繁访问 | Physarum | 免疫系统（高 hot + doom = 高危） |
| `repaired` | 此文件刚被成功修复 | 免疫系统 | Physarum（boost 相关边） |
| `toxic` | 此路径导致 doom loop | 免疫系统 | Physarum（force prune） |

---

## 6. DB Schema 变更

### 6.1 edges 表扩展

```sql
ALTER TABLE edges ADD COLUMN flow REAL DEFAULT 0;
ALTER TABLE edges ADD COLUMN consolidated INTEGER DEFAULT 0;
ALTER TABLE edges ADD COLUMN activation_count INTEGER DEFAULT 0;
ALTER TABLE edges ADD COLUMN last_activated INTEGER DEFAULT 0;
ALTER TABLE edges ADD COLUMN direction REAL DEFAULT 0;
```

### 6.2 新表：immune_memory

```sql
CREATE TABLE immune_memory (
  id TEXT PRIMARY KEY,
  pattern TEXT NOT NULL,          -- doom pattern 指纹
  response TEXT NOT NULL,         -- 修复策略 JSON
  affinity_score REAL DEFAULT 0.5,
  hit_count INTEGER DEFAULT 0,
  last_hit INTEGER,
  created_at INTEGER NOT NULL,
  UNIQUE(pattern)
);
```

### 6.3 新表：danger_signals（滑动窗口）

```sql
CREATE TABLE danger_signals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  severity REAL NOT NULL,
  turn INTEGER NOT NULL,
  source TEXT,
  context TEXT,
  consumed INTEGER DEFAULT 0     -- 是否已被 APC 消费
);
```

---

## 7. 模块结构

```
src/repo/
├─ physarum-engine.ts        # PhysarumEngine class
├─ physarum-types.ts         # PhysarumEdgeState, AvalancheStats, etc.
├─ physarum-monitor.ts       # SOC 监控 + anomaly detection
└─ meridian-behavior.ts      # 现有，增加 Physarum 集成

src/agent/
├─ immune-innate.ts          # 先天免疫层（升级 trace-store）
├─ immune-apc.ts             # APC 聚合层（双信号门控）
├─ immune-adaptive.ts        # 适应性免疫层（记忆 + 克隆选择）
├─ immune-memory-store.ts    # ImmuneMemoryStore
├─ immune-types.ts           # DangerSignal, ImmuneMemory, etc.
└─ immune-hook.ts            # RuntimeHook 集成
```

---

## 8. Hook 集成

```typescript
// immune-hook.ts
export function createImmuneHook(deps: ImmuneDeps): RuntimeHook {
  return {
    name: 'immune',
    phase: 'postTool',
    run: async (ctx) => {
      // 1. 先天免疫检查
      const innateSignals = deps.innate.check(ctx.toolName, ctx.fingerprint)

      // 2. Physarum 异常检测
      const graphSignal = deps.physarum.detectAnomaly()

      // 3. 收集到 APC
      const allSignals = [...innateSignals, ...(graphSignal ? [graphSignal] : [])]
      for (const signal of allSignals) {
        deps.apc.collect(signal)
      }

      // 4. APC 评估
      const activation = deps.apc.evaluate(ctx.doomLevel !== 'none')
      if (!activation.shouldActivate) return

      // 5. 适应性免疫响应
      const memory = deps.adaptive.lookup(ctx.fingerprint)
      if (memory) {
        // 二次响应：快速修复
        const response = deps.adaptive.fastRepair(memory, ctx)
        deps.physarum.applyResponse(response)
      } else {
        // 首次响应：完整 repair pipeline + 记忆形成
        const result = await deps.repairPipeline.run(ctx.input, ctx.schema)
        if (result.applied) {
          deps.adaptive.recordSuccess(ctx.fingerprint, result.strategy)
          deps.physarum.applyResponse({ type: 'boost_healthy', ... })
        }
      }
    }
  }
}
```

---

## 8.5 与已有 P3 模块的集成

以下已落地模块直接复用为 Physarum+Immune 的组件：

| 已有模块 | 角色 | 集成方式 |
|----------|------|---------|
| `MistakeNotebook` | 免疫记忆的初始形态 | ImmuneMemoryStore 继承其 record/query 模式，增加 affinity + decay |
| `TrajectoryHealth` | 先天免疫 danger signal 源 | `'degrading'` → severity 0.5, `'escalate'` → severity 0.9 |
| `AgentDiet` | Physarum 冷路径萎缩的协同 | diet 标记的 redundant/expired 文件路径 → 降低对应边的 flow |
| `IdleSpec` | Physarum 热路径预测的消费者 | STDP 有向边的 top-K 预测喂给 IdleSpec.onToolStart() |
| `RepairHintTracker` | APC 层 danger signal | hint exhaustion → `repair_exhaustion` signal |

关键集成代码：

```typescript
// 在 immune-hook.ts 中
if (trajectoryHealth === 'escalate') {
  apc.collect({ kind: 'prediction_error', severity: 0.9, turn, source: 'atropos' })
}
if (trajectoryHealth === 'degrading') {
  apc.collect({ kind: 'prediction_error', severity: 0.5, turn, source: 'atropos' })
}

// 免疫记忆成功记录同步到 MistakeNotebook
if (repairSuccess) {
  mistakeNotebook.record({
    timestamp: new Date().toISOString(),
    error: pattern,
    context: toolName,
    resolution: strategy,
    tags: ['immune-adaptive'],
  })
}
```

---

## 9. 演化时机

Physarum 边权演化不是每 turn 都对所有边执行（太昂贵），而是：

1. **热路径**：每次 access 时立即更新该边的 flow + weight
2. **冷路径**：每 10 turns 批量执行一次全图衰减 + 剪枝
3. **巩固检查**：每 session 结束时检查哪些边达到巩固阈值
4. **SOC 监控**：每 20 turns 计算一次雪崩分布，调整全局 decay

---

## 10. 测试策略

| 层 | 测试重点 |
|----|---------|
| Physarum 单元 | evolveEdge 数学正确性、scaling 归一化、pruning 阈值 |
| 免疫单元 | 双信号门控逻辑、memory CRUD、negative selection |
| 集成 | doom loop → danger signal → APC → adaptive → physarum feedback |
| 回归 | 现有 meridian 测试全部通过、spreading activation 结果不退化 |

---

## 11. 成功标准

1. **图不再无限膨胀**：边数/节点数比维持在合理范围（<8:1）
2. **Doom loop 误报率下降**：双信号门控使误报减少 50%+
3. **二次响应加速**：相同 doom pattern 第二次出现时，修复时间 <3 turns
4. **SOC 临界态**：spreading activation 雪崩分布近似幂律（α ≈ 2.0）
5. **无性能退化**：Physarum 演化 + 免疫检查总开销 <5ms/turn
