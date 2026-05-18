# Genome-Immune Team Architecture — 多智能体团队协同设计

> Date: 2026-05-19
> Status: Design Draft — pending review with Opus 4.6 + Rivet
> Origin: Deep Brainstorm (9 cross-domain scouts + 3-round evolution)

---

## 核心洞察

> **"协同的本质不是共享记忆，而是在正确的时机传递正确粒度的信息。"**

所有成功的团队系统（手术室、交响乐团、蜂群、军事 C2、开源社区）都避免完整记忆共享，选择了选择性翻译、主动降维、时机同步。

---

## 设计目标

1. **记忆零污染**：一个 agent 的错误不能静默传播到其他 agent
2. **角色可进化**：每个角色越用越强，基因组自动积累经验
3. **团队越用越强**：信息素网络让间接协调越来越精准
4. **面向世界**：架构支持从单用户到千万用户的扩展

---

## 架构概览

```
┌─────────────────────────────────────────────────────────┐
│                      User Input                          │
└─────────────────────┬───────────────────────────────────┘
                      │
┌─────────────────────▼───────────────────────────────────┐
│                   Conductor                               │
│  - 任务拆解                                              │
│  - 分谱生成（根据 agent 经验水平动态调整详细度）           │
│  - 手术暂停（合并前 provenance + 冲突检查）              │
│  - 裁决冲突                                              │
└──┬──────────┬──────────┬──────────┬─────────────────────┘
   │          │          │          │
   ▼          ▼          ▼          ▼
┌──────┐  ┌──────┐  ┌──────┐  ┌──────┐
│Coder │  │Review│  │Tester│  │Plan  │  ← Role Agents
│      │  │      │  │      │  │      │
│genome│  │genome│  │genome│  │genome│  ← 角色级持久记忆
│ephem │  │ephem │  │ephem │  │ephem │  ← session 级短暂记忆
└──┬───┘  └──┬───┘  └──┬───┘  └──┬───┘
   │          │          │          │
   └──────────┴──────────┴──────────┘
                      │
         ┌────────────▼────────────┐
         │   Pheromone Space        │
         │   (共享信息素网络)        │
         │   文件路径 → 信号         │
         │   间接协调，非直接共享    │
         └──────────────────────────┘
```

---

## 五层记忆模型

| 层级 | 名称 | 生命周期 | 可见性 | 存储 |
|------|------|---------|--------|------|
| L1 | Ephemeral | session 内 | 仅当前 agent 实例 | 内存 |
| L2 | Genome | 永久（有衰减） | 仅同角色的实例 | `.rivet/genome/<role>.jsonl` |
| L3 | Pheromone | 7天半衰期 | 所有 agent（只读） | `.rivet/pheromones.json` |
| L4 | Staging | 合并前临时 | Conductor 可见 | `.rivet/staging/<session>/` |
| L5 | Archive | 永久 | 人类可读 | `.rivet/knowledge/` |

### L1: Ephemeral Memory（表型记忆）

当前 session 的工作上下文。session 结束即清除。

```typescript
interface EphemeralMemory {
  toolHistory: ToolHistoryEntry[]
  decisions: string[]
  sensoriumSnapshots: SensoriumSnapshot[]
  trajectory: TrajectoryEntry[]
}
```

### L2: Genome（角色基因组）

角色级持久记忆。跨 session 积累，有免疫保护。

```typescript
interface GenomeBullet {
  id: string
  role: string              // 所属角色
  createdAt: number
  keywords: string[]
  lesson: string
  context: 'root-cause' | 'recommendation' | 'pattern' | 'anti-pattern'
  successCount: number      // 被应用且成功的次数
  failureCount: number      // 被应用但失败的次数
  importance: number        // 0-1, 衰减 + 使用提升
  provenance: {
    sessionId: string
    agentInstance: string
    timestamp: number
  }
}
```

### L3: Pheromone Space（信息素空间）

跨 agent 间接协调通道。每个 agent 可写入自己的信号。

```typescript
interface TeamPheromone extends Pheromone {
  depositedBy: string       // 哪个角色写入的
  confidence: number        // 写入者的置信度
}
```

### L4: Staging Area（暂存区）

并行 worker 的输出在合并前暂存于此。Conductor 在此做手术暂停检查。

### L5: Archive（知识存档）

Dream 蒸馏的输出。人类可读，不自动回流到 agent。

---

## 核心机制

### 1. 分谱生成（Score Translation）

Conductor 不把原始任务直接发给 agent，而是根据 agent 的 genome 大小和经验水平，生成不同详细度的"分谱"。

```
if agent.genome.size > 20:
  # 老手：精简指令
  score = { objective, scope, constraints }
else:
  # 新手：详细指令
  score = { objective, scope, constraints, hints, examples, relatedLessons }
```

灵感来源：交响乐团的分谱不是总谱的子集，而是为特定执行者重构的表达。

### 2. 手术暂停（Surgical Pause）

并行 worker 执行完毕后，输出不直接合并，而是进入 staging area。Conductor 触发暂停检查：

```
preCommitCheck(stagingResults):
  1. Provenance 验证：每个结果标注来源 agent + session
  2. Scope 越界检测：agent 是否修改了分谱范围外的文件？
  3. 冲突检测：多个 agent 是否修改了同一文件？
  4. 一致性检查：结果之间是否有逻辑矛盾？
  
  if conflict:
    escalate to conductor for resolution
  else:
    merge to mainline
```

灵感来源：手术室的 Time-out 协议 + BGP 的历史轨迹环路检测。

### 3. 免疫检查（Immune Validation）

新经验写入 genome 前必须通过免疫检查：

```
immuneCheck(newLesson, existingGenome):
  1. 矛盾检测：新 lesson 是否与已有 lesson 直接矛盾？
     - keyword overlap > 0.5 且 context 相反 → 标记为 conflict
  2. 质量检测：新 lesson 是否过于泛化/过于具体？
     - keywords.length < 2 → 拒绝（太泛）
     - keywords.length > 10 → 拒绝（太具体）
  3. 来源可信度：写入者的历史成功率
     - agent.successRate < 0.3 → 降低 importance
  
  if conflict:
    mark as pending, escalate to conductor/user
  else:
    write to genome with provenance
```

灵感来源：免疫系统的自我/非自我识别 + 印刷术的集体纠错。

### 4. 自评竞标（Self-Scoring Bid）

任务分配不是固定路由，而是 agent 根据经验自评：

```
selfScore(task, genome):
  relevantLessons = genome.query(task.keywords)
  historicalSuccess = relevantLessons.avg(l => l.successCount / (l.successCount + l.failureCount))
  experienceDepth = relevantLessons.length / genome.totalSize
  
  return confidence = historicalSuccess * 0.6 + experienceDepth * 0.4
```

Conductor 选择置信度最高的 agent，但保留 10% 随机分配给低置信度 agent（探索 vs 利用）。

灵感来源：GradientHQ Beacon-Selection + 蜜蜂舞蹈的质量编码。

### 5. 角色涌现（Role Emergence）

当某类任务反复出现但没有高置信度的 agent 时：

```
if task.type appears > 5 times AND max(selfScores) < 0.3:
  suggest_new_role(task.type)
  # 新角色的初始 genome 从最相近的已有角色 fork
  newGenome = closestRole.genome.filter(relevantTo(task.type))
```

灵感来源：V5 的 discarded_trait "从任务压力中涌现角色"。

---

## 与现有架构的映射

| 现有组件 | 演化方向 |
|---------|---------|
| `AgentLoop` (Primary) | → Conductor |
| `WorkerSession` (stateless) | → Role Agent (with genome) |
| `DelegationCoordinator` | → 加入 selfScore + 分谱生成 |
| `WorkOrder` | → Score（分谱） |
| `WorkerResult` | → 加入 provenance 字段 |
| `PlaybookStore` | → GenomeStore（加 role 字段） |
| `StigmergyStore` | → TeamStigmergyStore（加 depositedBy） |
| `RuntimeHookPipeline` | → 加入 preCommit phase（手术暂停） |
| `dream-hook` | → 加入免疫检查 gate |

---

## 风险与应对

| 风险 | 影响 | 应对 |
|------|------|------|
| 免疫检查误杀有效 lesson | 角色学习变慢 | 初期宽松阈值，逐步收紧 |
| 自评置信度不准 | 任务分配给错误 agent | 加入校准机制（实际成功率 vs 自评） |
| Genome 膨胀 | context 超限 | enforceCapacity + 衰减 |
| Conductor 成为瓶颈 | 并行度受限 | 简单任务跳过 conductor 直接执行 |
| 信息素空间噪音 | 信号失去意义 | 半衰期衰减 + 置信度加权 |

---

## 成功标准

1. 同一角色的第 10 次执行比第 1 次快 30%+
2. 记忆零跨角色泄漏（genome A 的 lesson 不出现在 genome B）
3. 手术暂停检测到至少 1 次真实冲突并正确处理
4. 系统自动涌现出至少 1 个用户未预定义的角色
5. 信息素空间的信号准确率 > 80%（well-tested 文件确实测试通过）
