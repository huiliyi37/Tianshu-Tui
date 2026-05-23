# 团队协作文档：延续计划

> 日期：2026-05-23
> 状态：创新设计
> 前置文档：`docs/superpowers/specs/2026-05-23-team-collaboration-current-state.md`
> 关联设计文档：
> - `docs/superpowers/specs/2026-05-22-yongminengdeng-design.md`（HEARTH 永明灯）
> - `docs/superpowers/specs/2026-05-22-songline-runtime-design.md`（Songline 歌之路）
> - `docs/superpowers/plans/2026-05-22-hearth-songline-implementation.md`（联合实施计划）

---

## 一、设计理念

### 1.1 从"信息传递"到"参考系共享"

**现状模式**：
```
主 Session → buildWorkerKnowledgeBlock() → Worker
              ↓
           扁平 claim 列表（top 10 by fitness）
```

**创新模式**：
```
主 Session → Anchor Graph → Worker
              ↓
           锚位拓扑（关系结构 + 不变量）
```

**核心洞察**：Worker 需要的不是"信息"，而是"参考系"。参考系告诉 worker：
- 我在哪里（结构）
- 什么是不存在的（虚空）
- 从哪里来（前周期关闭）
- 到哪里去（当前周期开启）
- 为什么在这里（中心信念）

### 1.2 从"任务调度"到"歌的执行"

**现状模式**：
```
Dispatcher → classifyFile() → DecomposedTask → Worker
                              ↓
                         文件级粒度
```

**创新模式**：
```
Dispatcher → Song Movement → Obligation → Worker
              ↓
          乐章级粒度（读→计划→写→验证）
```

**核心洞察**：任务不是孤立的工作单元，而是"歌"的一部分。歌有结构、有节奏、有旋律。

### 1.3 从"错误检测"到"漂移感知"

**现状模式**：
```
Worker → 执行 → pass/fail → 主 Agent
                    ↓
              二元判断
```

**创新模式**：
```
Worker → 执行 → Invariant Check → 漂移级别 → 校准/重试/放弃
                    ↓
              梯度判断
```

**核心洞察**：错误不是突然发生的，而是逐渐漂移的。通过 invariant verifier 可以在失败前检测到漂移。

### 1.4 从"依赖声明"到"信息素协调"

**现状模式**：
```
WorkOrder.dependsOn[] → DAG 排序 → 顺序执行
                    ↓
              显式声明
```

**创新模式**：
```
Worker A → 沉积信息素 → Worker B 感知 → 自适应协调
                    ↓
              有机协调
```

**核心洞察**：跨域依赖不需要显式声明，而是通过信息素（pheromone）自然形成。

---

## 二、创新设计详解

### 2.1 锚位感知的上下文共享

#### 设计

将 `buildWorkerKnowledgeBlock()` 从扁平 claim 列表升级为锚位拓扑投影。

```typescript
// src/agent/worker-knowledge.ts (升级版)

interface AnchorProjection {
  /** 项目结构：编码规范、架构决策、文件组织 */
  poleStructure: string
  /** 虚空：项目明确不做的事情（负空间） */
  poleVoid: string
  /** 前周期关闭：上一个 session 的结论 */
  prevCycleClose: string | null
  /** 当前周期开启：本 session 的起点 */
  currentCycleOpen: string
  /** 中心信念：项目的核心目的 */
  centerBelief: string
}

function buildAnchorProjection(
  claims: ContextClaim[],
  anchorGraph: AnchorGraph
): string {
  // 从 claims 中提取与 anchor graph 对应的信息
  const structure = claims.filter(c => c.kind === 'project_rule')
  const void_ = claims.filter(c => c.kind === 'user_constraint')
  const prevClose = claims.filter(c => c.kind === 'decision').slice(0, 1)
  const center = claims.filter(c => c.kind === 'user_preference').slice(0, 1)

  return `<anchor-projection>
  <pole-structure>${structure.map(c => c.text).join('\n')}</pole-structure>
  <pole-void>${void_.map(c => c.text).join('\n')}</pole-void>
  <prev-cycle-close>${prevClose.map(c => c.text).join('\n')}</prev-cycle-close>
  <current-cycle-open>${anchorGraph.currentCycleOpen}</current-cycle-open>
  <center-belief>${center.map(c => c.text).join('\n')}</center-belief>
  <invariants>
    <inv-1>结构与虚空互补</inv-1>
    <inv-2>周期连续</inv-2>
    <inv-3>行为与信念一致</inv-3>
    <inv-4>存在下一周期</inv-4>
    <inv-5>填充虚空</inv-5>
  </invariants>
</anchor-projection>`
}
```

#### 效果

| 维度 | 现状 | 创新 |
|------|------|------|
| 结构 | 扁平列表 | 锚位拓扑 |
| 关系 | 无 | 互补对 + 连续性 |
| 参考系 | 无 | 明确的"我是谁" |
| 不变量 | 无 | INV-1 ~ INV-5 |

#### 可验证性

- **测试**：注入 anchor projection 的 worker 是否比注入 flat claims 的 worker 有更高的任务完成率
- **指标**：指令遵循率、主动质疑次数、工作流之外想法的频率

### 2.2 歌之路感知的任务粒度

#### 设计

将任务分解从文件级升级为乐章级。

```typescript
// src/agent/song-movement.ts

interface SongMovement {
  /** 乐章编号 */
  index: number
  /** 乐章类型：读→计划→写→验证 */
  type: 'understand' | 'plan' | 'execute' | 'verify'
  /** 乐章的"调性"：对应领域 */
  key: DomainArea
  /** 乐章的"旋律"：任务描述 */
  melody: string
  /** 乐章的"节奏"：预计轮数 */
  tempo: number
  /** 乐章的义务 */
  obligations: Obligation[]
}

function decomposeByMovement(
  task: string,
  files: string[]
): SongMovement[] {
  // 阶段 1：理解（读代码、grep、理解结构）
  const understand: SongMovement = {
    index: 0,
    type: 'understand',
    key: 'docs',
    melody: '理解任务背景和代码结构',
    tempo: 3,
    obligations: [
      { action: 'read_file', target: files },
      { action: 'grep', target: task },
      { action: 'repo_map', target: '.' },
    ],
  }

  // 阶段 2：计划（设计方案、确定依赖）
  const plan: SongMovement = {
    index: 1,
    type: 'plan',
    key: 'docs',
    melody: '制定实现方案',
    tempo: 2,
    obligations: [
      { action: 'read_section', target: 'docs/superpowers/' },
      { action: 'diff', target: files },
    ],
  }

  // 阶段 3：执行（写代码、跑测试）
  const execute: SongMovement = {
    index: 2,
    type: 'execute',
    key: classifyFile(files[0] ?? ''),
    melody: '实现代码变更',
    tempo: 5,
    obligations: [
      { action: 'edit_file', target: files },
      { action: 'write_file', target: files },
      { action: 'run_tests', target: '.' },
    ],
  }

  // 阶段 4：验证（验证、交付）
  const verify: SongMovement = {
    index: 3,
    type: 'verify',
    key: 'tests',
    melody: '验证实现正确性',
    tempo: 2,
    obligations: [
      { action: 'run_tests', target: files },
      { action: 'diff', target: files },
    ],
  }

  return [understand, plan, execute, verify]
}
```

#### 效果

| 维度 | 现状 | 创新 |
|------|------|------|
| 粒度 | 文件级 | 乐章级 |
| 结构 | 无 | 读→计划→写→验证 |
| 节奏 | 无 | 每个乐章有预计轮数 |
| 义务 | 无 | 每个乐章有明确义务 |

#### 可验证性

- **测试**：乐章级分解是否比文件级分解有更好的任务完成率
- **指标**：任务完成时间、错误率、worker 满意度

### 2.3 锚位感知的错误策略

#### 设计

将 pass/fail 升级为漂移检测。

```typescript
// src/agent/drift-detector.ts

interface DriftAssessment {
  /** 漂移级别：0 = 无漂移，1 = 轻微，2 = 中等，3 = 严重 */
  level: number
  /** 违反的 invariant */
  violations: AnchorViolation[]
  /** 建议的恢复策略 */
  recovery: 'continue' | 'inject_context' | 'pause_realign' | 'abort'
}

function assessDrift(
  workerResult: WorkerResult,
  anchorGraph: AnchorGraph
): DriftAssessment {
  const violations = checkInvariants(anchorGraph, {
    prevGraphHash: null,
  })

  // 轻微漂移：1-2 个 violation
  if (violations.length <= 2) {
    return {
      level: 1,
      violations,
      recovery: 'inject_context',
    }
  }

  // 中等漂移：3 个 violation
  if (violations.length === 3) {
    return {
      level: 2,
      violations,
      recovery: 'pause_realign',
    }
  }

  // 严重漂移：4+ 个 violation
  return {
    level: 3,
    violations,
    recovery: 'abort',
  }
}
```

#### 恢复策略

| 漂移级别 | 恢复策略 | 行动 |
|---------|---------|------|
| 0 | continue | 继续执行 |
| 1 | inject_context | 注入校准上下文（anchor reminder） |
| 2 | pause_realign | 暂停 worker，重新对齐 anchor graph |
| 3 | abort | 放弃 worker，创建新 cycle_close，重新开始 |

#### 效果

| 维度 | 现状 | 创新 |
|------|------|------|
| 检测 | 事后（pass/fail） | 事前（漂移检测） |
| 级别 | 二元 | 梯度（0-3） |
| 恢复 | 无 | 分级恢复策略 |

#### 可验证性

- **测试**：漂移检测是否能在失败前 2-3 轮检测到问题
- **指标**：早期检测率、恢复成功率、任务完成率

### 2.4 歌之路感知的跨域依赖

#### 设计

将 DAG 依赖升级为信息素协调。

```typescript
// src/agent/pheromone-coordinator.ts

interface PheromoneSignal {
  /** 来源域 */
  source: DomainArea
  /** 目标域 */
  target: DomainArea
  /** 信号强度（衰减） */
  strength: number
  /** 信号内容 */
  content: string
  /** 沉积时间 */
  depositedAt: number
}

function depositPheromone(
  workerResult: WorkerResult,
  source: DomainArea
): PheromoneSignal[] {
  const signals: PheromoneSignal[] = []

  // 从 worker 结果中提取跨域影响
  for (const file of workerResult.changedFiles) {
    const targetDomain = classifyFile(file)
    if (targetDomain !== source) {
      signals.push({
        source,
        target: targetDomain,
        strength: 1.0,
        content: `文件 ${file} 已被修改，可能需要更新`,
        depositedAt: Date.now(),
      })
    }
  }

  return signals
}

function sensePheromones(
  domain: DomainArea,
  signals: PheromoneSignal[]
): PheromoneSignal[] {
  // 衰减：每小时衰减 10%
  const decayRate = 0.1
  const now = Date.now()

  return signals
    .filter(s => s.target === domain)
    .map(s => ({
      ...s,
      strength: s.strength * Math.exp(-decayRate * (now - s.depositedAt) / 3600000),
    }))
    .filter(s => s.strength > 0.1)  // 强度低于 0.1 的信号消失
}
```

#### 效果

| 维度 | 现状 | 创新 |
|------|------|------|
| 协调方式 | 显式声明 | 有机感知 |
| 依赖表示 | DAG 边 | 信息素梯度 |
| 衰减 | 无 | 时间衰减（10%/小时） |
| 跨域感知 | 无 | 自动感知 |

#### 可验证性

- **测试**：两个 worker 通过信息素梯度感知彼此存在
- **指标**：跨域协调准确率、信息素衰减曲线

### 2.5 守火人作为团队协调器

#### 设计

将中央调度器升级为分布式校准器。

```typescript
// src/agent/fire-keeper.ts

interface FireKeeper {
  /** 持有所有星位碑文 */
  inscriptions: Map<string, string>
  /** 召唤触发条件 */
  summonTriggers: {
    invariantViolation: boolean
    virtueDecline: boolean
    seasonMismatch: boolean
    agentRequest: boolean
  }
  /** 提供校准建议（非命令） */
  calibrate(agent: WorkerSession): CalibrationSuggestion
}

interface CalibrationSuggestion {
  /** 建议类型 */
  type: 'context_injection' | 'anchor_reminder' | 'season_adjustment'
  /** 建议内容 */
  content: string
  /** 强度：0-1，1 = 强烈建议 */
  strength: number
}

function summonFireKeeper(
  worker: WorkerSession,
  trigger: keyof FireKeeper['summonTriggers']
): CalibrationSuggestion {
  // 检查触发条件
  if (!fireKeeper.summonTriggers[trigger]) {
    return { type: 'context_injection', content: '', strength: 0 }
  }

  // 根据 worker 状态提供建议
  const drift = assessDrift(worker.lastResult, worker.anchorGraph)

  if (drift.level === 0) {
    return { type: 'context_injection', content: '状态良好，继续', strength: 0.1 }
  }

  if (drift.level === 1) {
    return {
      type: 'anchor_reminder',
      content: `检测到轻微漂移：${drift.violations.map(v => v.invariant).join(', ')}`,
      strength: 0.5,
    }
  }

  if (drift.level === 2) {
    return {
      type: 'season_adjustment',
      content: `检测到中等漂移，建议暂停并重新对齐`,
      strength: 0.8,
    }
  }

  return {
    type: 'context_injection',
    content: `检测到严重漂移，建议放弃并重新开始`,
    strength: 1.0,
  }
}
```

#### 效果

| 维度 | 现状 | 创新 |
|------|------|------|
| 协调方式 | 中央调度 | 分布式校准 |
| 决策权 | 集中 | 分散（建议，非命令） |
| 触发条件 | 无 | 多条件触发 |
| 校准方式 | 无 | 按需召唤 |

#### 可验证性

- **测试**：守火人是否能在 worker 漂移时提供有效校准
- **指标**：校准准确率、worker 满意度、任务完成率

---

## 三、实施路线图

### 3.1 Phase 1：锚位感知的上下文共享（1 周）

**任务**：
1. 扩展 `buildWorkerKnowledgeBlock()` 支持锚位投影
2. 在 `WorkerSessionConfig` 中添加 `anchorGraph` 字段
3. 测试：注入锚位投影的 worker 是否有更好的表现

**成功标准**：
- worker prompt 中包含完整的锚位拓扑
- 测试通过

**退出条件**：
- 如果锚位投影与现有 claims 冲突 → 退回扁平列表

### 3.2 Phase 2：歌之路感知的任务粒度（1-2 周）

**任务**：
1. 实现 `SongMovement` 数据结构
2. 实现 `decomposeByMovement()` 函数
3. 在 `Dispatcher` 中集成乐章级分解
4. 测试：乐章级分解是否比文件级分解更高效

**成功标准**：
- 任务按乐章分解
- 每个乐章有明确的义务和节奏

**退出条件**：
- 如果乐章级分解导致协调开销过大 → 退回文件级

### 3.3 Phase 3：锚位感知的错误策略（1-2 周）

**任务**：
1. 实现 `DriftAssessment` 数据结构
2. 实现 `assessDrift()` 函数
3. 在 `WorkerSession` 中集成漂移检测
4. 测试：漂移检测是否能在失败前 2-3 轮检测到问题

**成功标准**：
- 漂移检测准确率 > 80%
- 恢复成功率 > 50%

**退出条件**：
- 如果漂移检测误报率太高 → 退回 pass/fail

### 3.4 Phase 4：歌之路感知的跨域依赖（2-3 周）

**任务**：
1. 实现 `PheromoneSignal` 数据结构
2. 实现 `depositPheromone()` 和 `sensePheromones()` 函数
3. 在 `CollaborationProtocol` 中集成信息素协调
4. 测试：两个 worker 通过信息素梯度感知彼此存在

**成功标准**：
- 跨域协调准确率 > 70%
- 信息素衰减曲线符合预期

**退出条件**：
- 如果跨实例延迟 > 1 session → 退回显式声明

### 3.5 Phase 5：守火人作为团队协调器（2-3 周）

**任务**：
1. 实现 `FireKeeper` 数据结构
2. 实现 `summonFireKeeper()` 函数
3. 在 `Coordinator` 中集成守火人
4. 测试：守火人是否能在 worker 漂移时提供有效校准

**成功标准**：
- 校准准确率 > 70%
- worker 满意度提升

**退出条件**：
- 如果守火人成为瓶颈 → 退回中央调度

---

## 四、可验证指标

### 4.1 上下文共享

| 指标 | 现状基线 | 目标 |
|------|---------|------|
| worker 指令遵循率 | 待测量 | +20% |
| worker 主动质疑次数 | 待测量 | +30% |
| 工作流之外想法频率 | 待测量 | +50% |

### 4.2 任务粒度

| 指标 | 现状基线 | 目标 |
|------|---------|------|
| 任务完成时间 | 待测量 | -20% |
| 错误率 | 待测量 | -30% |
| 协调开销 | 待测量 | < 10% |

### 4.3 错误策略

| 指标 | 现状基线 | 目标 |
|------|---------|------|
| 早期检测率 | 0% | > 80% |
| 恢复成功率 | 0% | > 50% |
| 任务完成率 | 待测量 | +15% |

### 4.4 跨域依赖

| 指标 | 现状基线 | 目标 |
|------|---------|------|
| 跨域协调准确率 | 待测量 | > 70% |
| 信息素衰减曲线 | N/A | 10%/小时 |
| 跨域任务完成率 | 待测量 | +20% |

### 4.5 守火人

| 指标 | 现状基线 | 目标 |
|------|---------|------|
| 校准准确率 | N/A | > 70% |
| worker 满意度 | 待测量 | +25% |
| 任务完成率 | 待测量 | +10% |

---

## 五、总结

### 创新点

1. **锚位感知的上下文共享**：从扁平 claim 列表升级为锚位拓扑投影
2. **歌之路感知的任务粒度**：从文件级升级为乐章级分解
3. **锚位感知的错误策略**：从 pass/fail 升级为漂移检测
4. **歌之路感知的跨域依赖**：从 DAG 依赖升级为信息素协调
5. **守火人作为团队协调器**：从中央调度升级为分布式校准

### 与现有架构的关系

- **不是替换，是增强**：所有创新都建立在现有架构之上
- **渐进式引入**：每个 Phase 都有退出条件
- **可验证**：每个创新都有明确的指标和测试

### 下一步

1. 等当前分支主线任务收束
2. 启动 HEARTH Phase 1（拓扑骨架）
3. 与 Songline Phase 1（歌的骨架）并行
4. 逐步引入团队协作创新

---

## 六、附录：相关设计文档

| 文档 | 路径 | 状态 |
|------|------|------|
| 三权协程调度 | `docs/superpowers/specs/2026-05-20-three-authority-coroutine-architecture.md` | ✅ 已实现 |
| HEARTH 永明灯 | `docs/superpowers/specs/2026-05-22-yongminengdeng-design.md` | ⏳ Backlog |
| Songline 歌之路 | `docs/superpowers/specs/2026-05-22-songline-runtime-design.md` | ⏳ Backlog |
| 联合实施计划 | `docs/superpowers/plans/2026-05-22-hearth-songline-implementation.md` | ⏳ Backlog |
| 团队协作现状 | `docs/superpowers/specs/2026-05-23-team-collaboration-current-state.md` | ✅ 本文档 |
| 团队协作延续计划 | `docs/superpowers/specs/2026-05-23-team-collaboration-evolution.md` | ✅ 本文档 |
