# 跨系统联动创意收集

> 日期：2026-05-24
> 来源：10 Scout 并行调研（80+ 论文，30+ 开源项目）
> 状态：创意收集阶段，待逐步展开为正式设计

## 调研覆盖方向

| # | Scout | 方向 | 关联子系统 |
|---|-------|------|-----------|
| 1 | Predictive Coding / Free Energy | Karl Friston 自由能原理、主动推理 | PredictionAccumulator + Sensorium |
| 2 | Hebbian + STDP | 突触可塑性、时序依赖、突触修剪 | Meridian co-edit + edge confidence |
| 3 | Stigmergy + Swarm | 数字痕迹通信、蚁群优化、自适应衰减 | StigmergyStore + 多会话协调 |
| 4 | Theta-Gamma Oscillations | 神经振荡、相位-幅度耦合、记忆编码 | ThetaState + Vigor + Season |
| 5 | Embodied Cognition | 具身认知、可供性、感知运动环路 | 工具选择 + Meridian 认知地图 |
| 6 | Memory Consolidation | CLS 理论、经验回放、睡眠巩固 | 多层记忆(context→stigmergy→SQLite) |
| 7 | Attention + Salience | 全局工作空间理论、显著性网络 | spreading activation + token budget |
| 8 | Immune System | 人工免疫、危险信号理论、克隆选择 | doom loop + repair pipeline |
| 9 | HCI Flow + Cognitive Load | 心流检测、认知负荷、ZPD | Vigor + Season + Pressure |
| 10 | Morphogenesis | 反应-扩散、Physarum、自组织临界 | spreading activation + pheromone |

---

## 联动 1：自由能引擎 — 统一决策框架

**连接**：PredictionAccumulator + Sensorium + Vigor + CognitiveSeason

**核心思想**：将现有子系统重新诠释为 Karl Friston 自由能框架的组件，用 Expected Free Energy (EFE) 统一"下一步做什么"的决策。

### 映射关系

| Active Inference 概念 | Rivet 子系统 | 映射方式 |
|----------------------|-------------|----------|
| Variational Free Energy | PredictionAccumulator | prediction error 的加权累积 ≈ F |
| Generative Model (A,B,C,D) | Meridian Graph + context | 知识图谱=A/B矩阵；task goals=C矩阵 |
| Expected Free Energy | Policy/action selection | 下一步 tool call 选择 = argmin G(π) |
| Precision (gamma) | Vigor 能量状态机 | 高 vigor = 高 precision = exploitation |
| Epistemic Value | Theta rhythm 探索模式 | theta-gamma 耦合驱动信息搜索 |
| Pragmatic Value | CognitiveSeason | harvest 季=高 pragmatic; explore 季=高 epistemic |

### 关键论文

- Telogenesis (arXiv:2603.09476) — 三个认知缺口生成观测优先级
- APEX Agent — Active Inference + 层级世界模型，94% 循环预防率
- ReCAPA (ICLR 2026) — 三层级预测性校正
- pymdp (GitHub, 625 stars) — 最成熟的离散 active inference 实现

### 实施建议

1. PredictionAccumulator 增加 EFE 计算（epistemic + pragmatic value）
2. Vigor 值直接作为 softmax temperature gamma
3. CognitiveSeason 控制 EFE 中 epistemic vs pragmatic 权重比
4. Theta rhythm 作为层级推断时钟（theta=策略层，gamma=tool层）

---

## 联动 2：Physarum 拓扑重塑 — 图的自适应演化

**连接**：Meridian Graph + StigmergyStore + Co-edit Hebbian

**核心思想**：将 co-edit growth + heat decay + pheromone evaporation 统一为黏菌导管方程，让图拓扑自适应收敛到"最优传输网络"。

### 机制

```
dWeight/dt = f(accessFlow) - μ·Weight

叠加：
1. Physarum 流量适应：高频路径增粗，冷路径萎缩
2. STDP 有向边：编辑 A→B 时序产生方向性预测
3. Homeostatic Scaling：每节点出边总权重归一化
4. BCM 滑动阈值：活动低于阈值→LTD，高于→LTP
5. Anti-Hebbian 剪枝：ubiquity penalty（>30% 连接的节点降权）
```

### 关键论文

- 自适应网络 Turing 模式 (arXiv:2509.10124)
- BambooKG (arXiv:2510.25724) — 频率加权 KG 超越 RAG 18%
- DYNAMO-GAT (arXiv:2412.07243) — Anti-Hebbian 图剪枝
- Physarum 导管方程收敛证明 (Bonifaci 2012)

---

## 联动 3：记忆巩固管道 — NREM/REM 双阶段

**连接**：Context Window + StigmergyStore + Meridian Graph + Playbook

**核心思想**：将 compaction 和 playbook-reflect 重新设计为"睡眠巩固"双阶段。

### 机制

```
NREM（compaction 时）：
├─ Recall-gate：只巩固能被成功检索验证的信息
├─ Schema 匹配：与 Graph 一致 → 快速写入；不一致 → 缓冲
└─ Surprise 优先级：prediction error 高的经验优先

REM（playbook-reflect 时）：
├─ 泛化重放：提取通用模式（非逐字重放）
├─ 抑制性过滤：只保留跨 session 重复的结构
└─ 自我修复：生成式回放修复过时条目

Wuwei = SWR 整合期
```

### 关键论文

- Recall-gated plasticity (Lindsey 2024) — 信噪比大幅提升
- Singh et al. 2022 — 自主海马-皮层交互模型
- Schema Theory (van Kesteren 2012) — schema-congruent 信息快速巩固
- Reconsolidation (Spens & Burgess 2024) — 检索时记忆可更新

---

## 联动 4：全局工作空间竞争 — 注意力经济学

**连接**：Spreading Activation + Access Heat + Token Budget + RuntimeHookPipeline

**核心思想**：将 context window 显式建模为 Global Workspace，多信息源竞争进入有限 slot。

### 机制

```
GWT Competition：
├─ 每个 hook 输出带 salience score
├─ priority = salience × goal_alignment × history - staleness
├─ Token budget = market clearing price
└─ Top-K 进入 context，其余存 artifact store

Activator-Inhibitor 注意力岛：
├─ Activator：种子向外扩散（短程）
├─ Inhibitor：已索引节点向外扩散（长程）
└─ 自然形成高内聚工作上下文（Turing 斑点）

Attention Schema（自我监控）：
├─ 维护"我在注意什么"的简化模型
├─ 预测 → 偏差检测 → 校正
└─ 连续高偏差 → re-planning
```

### 关键论文

- Dossa et al. 2024 — GWT agent 更小 WM 表现更好
- Graziano 2024 — 自我建模作为涌现正则化器
- ECAN (OpenCog) — 注意力经济学（STI/LTI/Wages/Rent）
- Morgan et al. 2024 — Biased Competition + RL

---

## 联动 5：免疫防御分层 — Danger Theory 双信号门控

**连接**：Doom Loop Detection + Repair Pipeline + Playbook + Sycophancy Trap

**核心思想**：将 doom detection 重构为分层免疫系统，Danger Theory 双信号门控减少误报。

### 机制

```
先天免疫（<1 turn）：circuit breaker + doom pattern + rate limit
    ↓ danger signals
APC 聚合层：compaction-fail + token-spike + tool-repeat
    双信号门控：pattern AND danger 同时满足才激活
    ↓ co-stimulation
适应性免疫：
├─ Playbook hit → fast repair（二次响应）
├─ No hit → full repair（首次响应）
├─ 成功 → 克隆到 playbook（affinity score）
├─ 失败 → 超突变（策略变体）
└─ 负选择验证：新 detector 不匹配正常行为才上线

免疫记忆：hit_count + success_rate + last_hit + 衰减
```

### 关键论文

- Matzinger Danger Theory — 检测"危险信号"而非"外来物"
- Slips IPS — 最成熟免疫启发 IDS
- Vertice-MAXIMUS — 9 层生物防御架构
- Clonal Selection (de Castro 2000) — 策略扩增 + 超突变

---

## 联动 6：Theta 相位机 — 认知节律升级

**连接**：ThetaState + Vigor + CognitiveSeason + ELM Release

**核心思想**：ThetaState 从计数器升级为有相位的振荡器，theta phase 调制认知模式切换。

### 机制

```
Theta Phase Machine：
├─ [0, π)：ENCODING — 接收新信息
├─ [π, 2π)：RETRIEVAL — 反思整合
└─ Vigor.energy 调制相位比例

Adaptive Frequency：
├─ theta_freq = base / task_complexity
└─ 金发姑娘效应：适度 theta → 成功切换

Momentum-gated Interruption：
├─ momentum 上升 → 绝不中断
├─ momentum 触底 → 安全介入窗口
└─ 一阶导数比绝对值更重要

Dynamic Output Budget：
├─ budget = base × vigor × (1/pressure) × season_factor
├─ wuwei + momentum高 → 静默模式
└─ reversal + energy低 → 救援模式
```

### 关键论文

- Pirazzini & Ursino 2024 — 三层 theta-gamma 耦合模型
- Lisman-Idiart 1995 — theta/gamma 嵌套 = WM 容量
- Adobe "Streaming, Fast and Slow" — 自适应输出速率 -16.8% 资源
- Iqbal & Bailey — 断点理论，随机中断 +30% 恢复时间

---

## 联动 7：具身认知闭环 — Affordance-gated 工具选择

**连接**：Tool Registry + Sensorium + Meridian Graph + Sensorimotor Learning

**核心思想**：工具选择根据认知状态计算 affordance score，不是 flat list。

### 机制

```
Affordance Score：
├─ epistemic_affordance：减少不确定性的能力
├─ instrumental_affordance：推进目标的能力
└─ contextual_affordance：当前状态下的可用性

EFE-driven Selection：
├─ 高不确定性 → 偏好 epistemic tools (grep/read)
├─ 高信心 → 偏好 instrumental tools (write/bash)
└─ Vigor + Theta 联合决定 explore/exploit 比例

Sensorimotor Contingency Learning：
├─ 记录 (context, tool, outcome) 三元组
└─ 预测模型驱动 affordance 更新

Autopoietic Maintenance：
├─ Graph 区域过时 → 自发 refresh
└─ 从被动 hook → 主动自创生
```

### 关键论文

- GIBSONA 2025 — self-affordance vs other-affordance
- A4-Agent — 零样本 affordance 推理
- APEX Agent — Active Inference + 层级世界模型
- Hemion 2016 — SMCT + 预测处理

---

## 优先级矩阵

| # | 联动方向 | 复杂度 | 收益 | 理论支撑 | 建议阶段 |
|---|---------|--------|------|---------|---------|
| 2 | Physarum 拓扑重塑 | 低-中 | 高 | 强 | Phase 4 Week 1 |
| 5 | 免疫防御分层 | 中 | 极高 | 强 | Phase 4 Week 1 |
| 6 | Theta 相位机 | 低 | 高 | 强 | Phase 4 Week 2 |
| 3 | 记忆巩固管道 | 中 | 极高 | 极强 | Phase 4 Week 2 |
| 4 | 全局工作空间竞争 | 中-高 | 极高 | 强 | Phase 5 |
| 1 | 自由能引擎 | 高 | 极高 | 极强 | Phase 5 |
| 7 | 具身认知闭环 | 高 | 高 | 中-强 | Phase 6 |

---

## 实施计划：自由能引擎（#1） + 具身认知闭环（#7）

> 评估日期：2026-06-11 天枢域
> 状态：待执行

### 前置依赖分析

两个联动共享相同的前置子系统，可以协同推进：

| 子系统 | 当前状态 | #1 依赖 | #7 依赖 |
|--------|---------|---------|---------|
| PredictionAccumulator | ✅ 已实现 | 需扩展 EFE 计算 | 间接使用 |
| VigorState | ✅ 已实现 | gamma/precision | explore/exploit 调制 |
| ThetaState (相位) | ✅ 已实现 (#6) | 层级推断时钟 | 相位门控 |
| CognitiveSeason | ✅ 已实现 | pragmatic vs epistemic 权重 | contextual_affordance |
| Sensorium | ✅ 已实现 | — | 环境感知输入 |
| Meridian Graph | ✅ 已实现 | generative model (A/B) | 工具-上下文映射 |

**结论**：所有前置子系统已就位。两个联动都是"连接已有模块"而非"从零构建"。

---

### 阶段 A：具身认知闭环（先做，#7）

**理由**：复杂度更低（只涉及 prompt 层改动），收益立即可见，为自由能引擎提供 affordance 信号源。

#### Step A1：工具 Affordance 注册表（~0.5h）

新建 `src/agent/affordance.ts`，定义集中式工具 affordance 映射：

```typescript
interface BaseAffordance {
  epistemic: number    // 减少不确定性（读/search/查看）
  instrumental: number // 推进目标（写/执行/修改）
}

const toolAffordanceRegistry: Record<string, BaseAffordance> = {
  read_file:      { epistemic: 0.9, instrumental: 0.1 },
  grep:           { epistemic: 0.85, instrumental: 0.15 },
  glob:           { epistemic: 0.8, instrumental: 0.2 },
  repo_map:       { epistemic: 0.85, instrumental: 0.15 },
  lsp_find_references: { epistemic: 0.7, instrumental: 0.3 },
  bash:           { epistemic: 0.2, instrumental: 0.8 },
  write_file:     { epistemic: 0.0, instrumental: 1.0 },
  edit_file:      { epistemic: 0.1, instrumental: 0.9 },
  run_tests:      { epistemic: 0.2, instrumental: 0.8 },
  // ... 其余工具按此模式
}
```

**优势**（对比原方案"修改每个工具 description"）：
1. 一处修改：40+ 个工具的基础 affordance 集中管理
2. 不污染 LLM prompt：元数据不在 description 字符串里
3. 静态值与动态值分离：registry 存基础值，A2 叠加运行时状态

#### Step A2：Affordance 评分引擎（~2h）

新建 `src/agent/affordance.ts`：

```typescript
interface AffordanceScore {
  epistemic: number    // 减少不确定性
  instrumental: number // 推进目标
  contextual: number   // 当前状态下的可用性
}
```

基于当前 agent 状态计算每种工具的 affordance：

- **epistemic** = f(uncertainty in context, theta phase is ENCODING)
- **instrumental** = f(goal proximity, vigor is high)
- **contextual** = f(files in scope, recent tool history, season)

#### Step A3：Prompt 注入（~1h）

修改 `src/prompt/volatile.ts`，在 context-update 中注入"工具可供性提示"：

```markdown
<affordance-context>
Current cognitive state: theta=ENCODING, vigor=0.7, season=genesis
Prefer epistemic tools (grep, read_file, glob) — uncertainty is high.
Consider instrumental tools (bash, write_file) when confidence builds.
</affordance-context>
```

不强制工具选择，只是为模型提供认知状态感知的上下文提示。

**交付物**：`src/agent/affordance.ts` (new), `src/prompt/volatile.ts` (modified)

---

### 阶段 B：自由能引擎（后做，#1）

**理由**：需要 PredictionAccumulator 扩展，涉及决策逻辑变更，需更谨慎。

#### Step B1：EFE 计算核心（~2h）

扩展 `src/agent/prediction-error.ts`：

```typescript
export interface EFEComponents {
  epistemicValue: number   // 信息增益预期
  pragmaticValue: number   // 目标推进预期
  noveltyBonus: number     // 探索奖励（缓解 stagnation）
  precision: number        // 置信度加权（gamma = vigor）
}

export function computeEFE(
  acc: PredictionAccumulator,
  season: CognitiveSeason,
  vigor: VigorState,
): EFEComponents
```

#### Step B2：softmax 动作选择（~2h）

新建 `src/agent/policy-selection.ts`：

```typescript
// 基于 EFE 的 softmax 工具选择
// G(π) = epistemic × α + pragmatic × (1-α)
// α = season === 'genesis' ? 0.8 : season === 'wuwei' ? 0.2 : 0.5
// p(tool_i) = softmax(-G(π_i) / gamma)
```

注意：这个不替代 LLM 的工具调用，而是作为 context 注入影响 LLM 的选择（与 A3 类似）。

#### Step B3：感知-行动闭环（~2h）

在 `src/agent/turn-perception.ts` 中接入 EFE：

```
工具执行 → PredictionAccumulator.recordPrediction() → computeEFE() → policy温度 → 下一轮 context 注入
```

#### Step B4：Sensorimotor 学习（~1.5h）

扩展 Meridian Graph，记录 `(context, tool, outcome)` 三元组，驱动 affordance 更新。

**交付物**：`src/agent/prediction-error.ts` (extended), `src/agent/policy-selection.ts` (new), `src/agent/turn-perception.ts` (modified)

---

### 执行顺序

```
A1 (工具元数据) → A2 (评分引擎) → A3 (prompt注入) → 验证 → 提交
                    ↓
B1 (EFE计算) → B2 (动作选择) → B3 (闭环) → B4 (学习) → 验证 → 提交
```

### 估算

| 阶段 | 文件 | 工作量 |
|------|------|--------|
| A1 | `src/agent/affordance.ts` (new) — registry + 基础 affordance | 0.5h |
| A2 | `src/agent/affordance.ts` (extend) — 动态评分引擎 | 2h |
| A3 | `src/prompt/volatile.ts` (modify) — affordance 上下文注入 | 1h |
| B1 | `src/agent/prediction-error.ts` (extend) — EFE 计算 | 2h |
| B2 | `src/agent/policy-selection.ts` (new) — softmax 动作选择 | 2h |
| B3 | `src/agent/turn-perception.ts` (modify) — 感知-行动闭环 | 2h |
| B4 | `src/repo/meridian-db.ts` (extend) — sensorimotor 学习 | 1.5h |
| **总计** | | **~11h**, 6 个文件, 可拆成 5 个独立提交 |

---

## 执行记录

> 2026-06-04 天枢域会话 — 推进 #6 → #3 → #4（Step 1）

### ✅ 联动 #6：Theta 相位机 — `89a5516`

将 ThetaState 从简单计数器升级为相位振荡器：

- `phase ∈ [0,1)`：[0, 0.5) = ENCODING（接收信息），[0.5, 1) = RETRIEVAL（反思整合）
- phase 随每次工具调用推进，由 vigor 和 complexity 联合调制
- 高 vigor → 慢推进（保护心流），高 complexity → 快推进（更多检查）
- theta check 仅在 retrieval 阶段 + interval 满足时触发（双重门控）
- 新增 `getThetaPhase()`、`advanceThetaCounter(state, phaseInput?)`

文件：`src/agent/star-event.ts`、`src/agent/hooks/theta-hook.ts`

### ✅ 联动 #3：记忆巩固管道（NREM 阶段）— `0800c05`

实现 recall-gated consolidation — promotion 前验证 evidence 文件仍存在：

- 新增 `canRecallClaim(claim, cwd)`：检查 claim 的 evidence 文件是否仍可访问
- `promoteEligibleClaims()` 接入 recall-gate：证据不可检索 → 标记 stale，阻止晋升
- `ClaimStatusCounts` 新增 `recallBlocked` 计数器
- 无 cwd 时优雅降级（非阻塞）

文件：`src/context/promotion.ts`、`src/context/claim-store.ts`、`src/agent/context-injection.ts`

### ✅ 联动 #4：全局工作空间竞争（Step 1）— `aae8cd3`

给 context-update 子块赋 salience 分数，在 token budget 内做 Top-K 选择：

- 新增 `SalientBlock { content, salience }` 接口
- `assignSalience(content)`：根据 XML 标签名返回 0.3~1.0 的显著性分数
- `selectTopKBlocks(blocks, maxChars)`：按 salience 降序选择，直到预算耗尽
- `buildDynamicAppendix(ctx, maxChars?)`：可选 maxChars 参数启用 GWT

文件：`src/prompt/volatile.ts`

### ✅ 天枢种子胶囊 — `e52219a`

创建天枢域种子胶囊（北斗第一星，执中者），定义 9 条认知方法：
全貌定向、意图高于指令、适时委派、步步为营、收束意识、方案择优、证据驱动、沉默即失职、上下文流动。

文件：`docs/seed-capsule-tianshu.md`

### ✅ Skill-as-Profile — `9637fcc`

将 deerflow P1 skill 系统重新设计为子代理 profile 模式：
- 新增内置 profile：`architect`（架构分析）、`troubleshooter`（根因诊断）
- 示例 `.rivet/agents/` 文件：`research.md`、`security-auditor.md`
- 用户可通过 `.rivet/agents/*.md` 扩展自定义 skill profile

文件：`src/agent/profile-registry.ts`、`.rivet/agents/`

### ⏳ 待推进

| # | 联动 | 下一步 |
|---|------|--------|
| 3 | 记忆巩固（REM 阶段） | playbook-reflect 增加跨 session 重复模式检测 |
| 4 | 全局工作空间（Step 2+） | 在 engine 层接入 maxChars 预算；动态 salience 基于 goal-alignment |
| 1 | 自由能引擎 | 需要 PredictionAccumulator 扩展，工程量大 |
| 7 | 具身认知闭环 | 工具 affordance 评分，EFE-driven 工具选择 |
