# 天枢认知控制层融合分析

> 基于天枢代码级分析。评估认知控制层（Sensorium + 干预系统）向 omp 融合的方案。
> 核心理解：这不是「展示指标」，是**闭环自动控制系统**——harness 根据认知状态主动干预 agent 行为。

---

## 一、控制链全景

天枢的认知层是一条级联控制链，不是平行模块：

```
TraceStore (地基)
  记录每个 tool call 的 fingerprint + 结果状态
       │
       ├──→ DoomLoopDetector (trace-store.ts)
       │    精确指纹检测：连续重复 / 滑动窗口频率
       │    类指纹检测：bash 命令变体归并（git status --porcelain | sed → git:status）
       │    双策略组合 → none / warn / blocked
       │         │
       │         ▼
       ├──→ Sensorium (sensorium.ts)
       │    消费 traceStore + evidence + pressure → 6 维向量
       │    momentum / pressure / confidence / complexity / freshness / stability
       │    <1ms 纯计算，零 LLM 开销
       │         │
       │         ▼
       ├──→ computeStrategy (sensorium.ts)
       │    Sensorium → StrategyProfile
       │    reasoningEffort / explorationBreadth / commitThreshold / shouldEscalate
       │         │
       │         ▼
       ├──→ Vigor 调制 (vigor.ts)
       │    在策略基础上二次微调
       │    vigor<0.3 → +effort（状态差，需要更多思考）
       │    vigor>0.7+低complexity → -effort（状态好，可以加速）
       │    curiosity>0.6 → +explorationBreadth
       │         │
       │         ▼
       ├──→ Convergence Detector (convergence-detector.ts)
       │    7 个正交信号计算收敛分数：
       │    editRatio / targetNovelty / toolEntropy / errorPenalty
       │    tokenEfficiency / oscillationPenalty / textRepetitionPenalty
       │    阶段感知权重（explore/plan/execute/verify/deliver 不同权重）
       │    provider 特异调参（GLM vs DeepSeek 不同阈值）
       │    输出 0-3 级干预 + score
       │         │
       │         ▼
       ├──→ Dissipative Kick (dissipative-kick.ts)
       │    momentum<0.2 && stability<0.3 → 完全重新定义问题
       │    不是「换方法」是「换框架」
       │    标记 dead-end pheromone + 触发更强模型
       │         │
       │         ▼
       └──→ Immune Hook (immune-hook.ts)
            每次 tool 后运行
            正常行为指纹注册 → 危险信号收集 → APC 双信号门控
            → 自适应免疫（从错误中学习的 session 内记忆）
```

---

## 二、干预动作清单（这是核心价值）

指标不是用来展示的——每个指标都绑定具体的**自动干预动作**：

### 2.1 自动调节 reasoning effort

| 条件 | 干预 |
|---|---|
| complexity > 0.7 | reasoningEffort → high（多种工具并用，问题复杂）|
| momentum > 0.8 | reasoningEffort → low（连续成功，可以加速）|
| vigor < 0.3 | effort 再 +1（状态差，需要更多思考）|
| vigor > 0.7 + complexity < 0.5 + confidence > 0.7 | effort 再 -1（状态好，加速）|

**omp 现状**：reasoning effort 由用户手动 `/effort` 设置，或模型自己决定。无运行时自动调节。

### 2.2 动态 commit gate

| 条件 | 干预 |
|---|---|
| pressure > 0.7 | commitThreshold = 0.9（上下文快满，谨慎提交）|
| vigor < 0.3 | commitThreshold + 0.15（状态差，收紧门禁）|

**omp 现状**：commit gate 是静态的。

### 2.3 自动模型升级

| 条件 | 干预 |
|---|---|
| confidence < 0.3 && momentum < 0.2 | shouldEscalate = true（请求更强模型）|
| confidence < 0.2 && complexity > 0.5 | Kick escalation（复杂任务还失败 → 换模型）|
| trajectory health: 连续 3 失败 | escalate（trajectory-health.ts）|
| trajectory health: 5 turn 失败率 > 80% | escalate |

**omp 现状**：无自动模型升级机制。

### 2.4 Convergence Check 强制干预

每 turn 评估 7 个正交信号 → 收敛分数 → 0-3 级逐级干预：

| 级别 | 条件 | 干预动作 |
|---|---|---|
| L0 | score > 0.6 | 无干预 |
| L1 | score ≤ 0.6 + turn ≥ nLow | inject 策略建议消息 |
| L2 | score ≤ 0.4 + turn ≥ nMid | **强制策略换向 + dissipative kick** |
| L3 | score ≤ 0.2 + turn ≥ nHigh | **force-split（拆任务）或 abort（中止）** |

特殊快捷路径（不等 turn 计数）：
- **连续 5 turn 无 tool 调用** → L3 强制 abort（模型在「空想」）
- **连续 3 turn 无 tool 调用** → L2 kick
- **recent tools 全是 read/grep 无产出** → productiveStagnation → 至少 L1

**omp 现状**：有 auto-shake（上下文溢出时紧急压缩），但**没有「agent 在原地打转」的主动检测和干预**。

### 2.5 Dissipative Kick — 死循环突破

当 `momentum < 0.2 && stability < 0.3`：

```
→ inject 消息："停下来，换个角度看"
→ 标记失败文件为 dead-end pheromone（下次自动避开）
→ confidence<0.2 && complexity>0.5 → 触发更强模型
→ inject 具体建议（基于当前 Sensorium 维度）
   - confidence<0.3 → "先写最小测试验证"
   - complexity>0.5 → "拆分任务"
   - pressure>0.7 → "提交完成部分，清理上下文"
```

### 2.6 Signal Consumer — preTurn 消息注入

每个新 turn 开始前，根据策略注入指导消息：
- `explorationBreadth > 0.6` → inject `<search-breadth mode="wide" />`
- `commitThreshold > 0.8` → phase change to "cautious"
- `pressure.suggestion = task_decomposition` → inject 拆分建议
- `dead-end pheromone` present → inject 死胡同警告

---

## 三、omp 需要融合的组件

按控制链依赖顺序排列。**必须按此顺序融合——后面的组件依赖前面的。**

### 第一波：TraceStore（地基）

**为什么必须先做**：它是 doom detection、convergence detector、immune hook 的共同数据源。

| 功能 | 天枢实现 | omp 等价 |
|---|---|---|
| Tool fingerprint（name + input hash + output class）| `fingerprintToolCall()` | ❌ 无 |
| Bash 命令类归一化（git status \| sed → git:status）| `bashCommandClass()` | ❌ 无 |
| Doom loop 检测（精确 + 类双策略）| `getDoomLoopLevel()` + `getClassDoomLoopLevel()` | ❌ 无 |
| Tool storm 检测（连续同类型工具）| `getToolStormLevel()` | ❌ 无 |
| Tool name history（最近 N 个工具名）| `toolNameHistory` | ✅ 有 tool execution history |
| Threshold presets（normal vs goal 模式）| `NORMAL_DOOM_THRESHOLDS` / `GOAL_DOOM_THRESHOLDS` | ❌ 无 |

**omp 落点**：`packages/agent/src/trace-store.ts`（新建）。需要在 `agent-loop.ts` 的 tool 执行处插入 fingerprint 记录。

### 第二波：Sensorium + Strategy（感知 + 策略）

| 功能 | 依赖 | omp 需适配的数据源 |
|---|---|---|
| momentum（预测准确率）| traceStore predictionAcc | ⚠️ omp 无 prediction tracking，需新建或跳过 |
| pressure（多维压力）| pressure-monitor | ✅ CacheAdvisor + context usage 可替代 |
| confidence（验证覆盖率）| evidence filesModified/verifiedCount | ⚠️ 有 file tracking，无 verification 计数 |
| complexity（工具多样性）| toolCallHistory | ✅ 已有 |
| freshness（文件熟悉度）| pheromones + gitChangeRate | ⚠️ 无 pheromone，可先用 git 代替 |
| stability（连续稳定性）| doomLevel + predictionAcc + diversity + verification | ⚠️ 依赖第一波 traceStore |

### 第三波：Convergence Detector（收敛检测）

这是**最高单组件价值**——直接检测「agent 在打转」并逐级干预。

7 个信号全从 traceStore + evidence 计算，零外部依赖。但需要：
- TaskContract（判断当前 phase = explore/execute/verify）→ 影响权重
- evidence（filesModified, filesRead, deliveryStatus）→ omp 有 file tracking

### 第四波：干预执行器

| 干预 | 落点 |
|---|---|
| reasoningEffort 调节 | omp 的 `ThinkingLevel` / `getReasoning` |
| commitThreshold | omp 的 commit gate |
| shouldEscalate | omp 的 model switching |
| inject message | omp 的 `transformContext` 或 steering queue |
| force-split / abort | omp 的 session fork / abort signal |

### 第五波：Vigor + Immune + Stigmergy（增强层）

这些是在基础控制链上的增强——可以后做：
- Vigor：让 effort 调节更平滑（非线性）
- Immune：session 内从错误学习（需要 Physarum，最复杂）
- Stigmergy：dead-end 标记 + freshness 数据源

---

## 四、融合建议

### 必须融合（控制链核心）

1. **TraceStore** — 地基，所有检测的数据源
2. **DoomLoopDetector** — 最直接的价值（检测死循环）
3. **Sensorium** — 6 维数据驱动下游
4. **computeStrategy** — 把 Sensorium 转成可执行策略
5. **ConvergenceDetector** — 最高单组件价值（检测打转 + 强制干预）
6. **DissipativeKick** — 死循环最后突破

### 需要融合（干预执行）

7. **reasoningEffort 自动调节** — 已有 `ThinkingLevel` 系统
8. **Signal Consumer preTurn 注入** — 利用已建好的 volatile 注入管线
9. **CognitiveLedger/Mirror** — paravirtualization（模型看到自己状态来配合）
10. **TrajectoryHealth** — 连续失败 → escalate

### 增强融合（锦上添花）

11. **Vigor 调制** — 平滑化策略调节
12. **Stigmergy** — dead-end 持久化 + freshness
13. **ImmuneHook** — session 内错误学习
14. **ClaimStore** — knowledge assertion 生命周期
15. **Physarum** — 黏菌网络异常检测（最复杂）

### 融合顺序

```
Phase 2A: TraceStore + DoomLoopDetector          ← 地基
    ↓
Phase 2B: Sensorium + computeStrategy             ← 感知 + 策略
    ↓
Phase 2C: ConvergenceDetector + DissipativeKick   ← 收敛检测 + 干预
    ↓
Phase 2D: reasoningEffort 调节 + preTurn 注入     ← 干预执行
    ↓
Phase 2E: CognitiveLedger + TrajectoryHealth       ← paravirtualization + escalate
    ↓
Phase 3: Vigor + Stigmergy + Immune + ClaimStore   ← 增强层
```
