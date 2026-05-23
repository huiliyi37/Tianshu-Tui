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
