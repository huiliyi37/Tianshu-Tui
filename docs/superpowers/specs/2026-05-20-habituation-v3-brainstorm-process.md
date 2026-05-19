# 习惯化 v3 深度头脑风暴过程记录

**日期**: 2026-05-20
**触发**: 用户要求将固定 turn 计数器改为 sensorium 状态驱动的习惯化引擎
**方法**: deep-brainstorm（4 scout + 1 反证 + 三轮演化）

---

## Step 0：前置调研

### Scout 1（内部运行时）— Explore agent

**任务**：理解 Rivet agent loop 运行时结构
**关键发现**：
- Sensorium 6 维（momentum, pressure, confidence, complexity, freshness, stability），全 0-1 连续值
- 已被 commit f191be1 简化为 3 维（momentum, pressure, confidence）
- 8 个 StarPhase 分为 5 个行为类：explore / plan / execute / verify / deliver
- Sensorium 在 preTurn 阶段计算完毕，在 buildRequest() 之前
- FieldHabituationTracker.recordTurn() 仅在新 user message 到达时调用
- PromptEngine 对 sensorium 零引用

### Scout 2（随机领域）— 神经科学/生态学/工业控制/节拍追踪

**任务**：跨领域寻找稳定检测机制
**关键发现**：
- **Cao-Rhinehart R 统计量**（工业过程控制）：R = V_filtered / V_unfiltered，纯状态检测，零时间依赖。但在二值数据上退化为计数器。
- **Tag-Trigger-Consolidation**（神经科学）：双门控 — 个体信号超阈值打标记 + 标记总数超群体阈值触发巩固。神经调质状态降低阈值。
- **生态演替**（生态学）：变化率衰减 + 方差比 → 1.0 = 稳定
- **节拍追踪**（音乐）：多假设竞争 + 可靠性累加器，假设熵下降 = 锁定

**核心洞察**：4 个领域都不用固定计数器。全部检测统计相变。

### Scout 3（热力学/共识/博弈论/地震学）

**任务**：更多跃迁域
**关键发现**：
- **经典核化理论 (CNT)**：簇 > 临界半径 → 不可逆生长；簇 < 临界半径 → 自然溶解。防早产的自然机制。
- **Raft 共识**：term + heartbeat + quorum 三信号联锁
- **NashConv**：偏离激励 → 0 = 无人有动机改变
- **Omori 余震衰减**：`n(t) = K/(c+t)^p`，Z-value > 2.0 区分"正常衰减"和"真正静默"

### Scout 4（免疫/格斗/爵士/粘菌）

**任务**：生物学深层机制
**关键发现**：
- **B 细胞 IRF4 累加器**：不是计数器，是信号质量的积分。正反馈加速稳定。SHP-1/FoxO1/Cfp1 三重防早产。双稳态开关 — 一旦翻转不可逆。
- **格斗自由度坍缩**：重心转移 = 承诺，姿势保持选择性 = 试探。二值检测。
- **爵士临界慢化**：rising AR(1) + rising variance = 接近相变
- **粘菌 Physarum**：`dD/dt = f(|Q|) - D`。当前流量驱动强化，衰减项持续挑战。零历史依赖。

### Scout 5（反证）

**任务**：找到假设依赖的隐含前提
**致命发现**：
1. **sensorium.stability 语义错误** — 测量 doom loop 严重度，与字段稳定性无关。doom loop 时 stability↓ → R_critical↓ → 更容易晋升，完全反转！
2. **stability 维度已被删除**（f191be1 简化为 3D）
3. **PromptEngine 无 sensorium 数据路径** — 架构边界
4. **R 统计量在二值数据上退化** — hash match/no-match 是 0/1，方差比 ≈ 计数器
5. **~30 行估计偏低** — 实际 50-80 行产品码 + 40-60 行测试

---

## 第一轮：变异（4 方案）

| ID | 生态位 | 核心选择 |
|----|--------|----------|
| V1 | 主流·外部信号注入 | PromptEngine 加 setPhaseHint()，tracker 按 phase 选不同固定阈值 |
| V2 | 邻近·Omori 衰减 | 不看外部信号，字段自身的 lastChangeTurn → 自适应阈值 |
| V3 | 空位·IRF4 信心累加器 | 连续信心分 + phaseHint α 调制 + 正反馈 |
| V4 | 突变·粘菌 flow+decay | 连续 flow 分 + 常数衰减项，零外部依赖 |

---

## 第二轮：选择

**灭绝**：
- **V2** — 不感知 agent 行为阶段，无法满足"感知期 10 turn 不晋升"核心需求
- **V4** — 同 V2，衰减是常数，不感知外部状态

**存活**：
- **V1**（强·直接）— 最简单实现
- **V3**（强·生物学启发）— 信心累加器 + 正反馈 + α 调制

**回收特征**：
- V2 的 `lastChangeTurn` → 可作为 V3 的冷却期参考（未采纳，YAGNI）
- V4 的衰减项 → **采纳** — 缺席字段信心衰减而非硬归零

---

## 第三轮：适应

**最终方案**：V3 + V1 + V4 衰减项的组合

- V3 的信心累加器替代固定计数器
- V1 的 phaseHint setter 模式传入阶段信号（不引入 import 依赖）
- V4 的衰减项处理缺席字段

**收敛验证**：V1 和 V3 收敛到"agent 行为阶段是外部门控，字段稳定性是内部累加器"。V2 和 V4 收敛到"字段历史有价值"→ 被吸收为缺席衰减。

---

## 关键决策记录

| 决策 | 选择 | 理由 |
|------|------|------|
| 不用 sensorium.stability | 是 | 语义错误 + 已被删除 |
| 不用 R 统计量 | 是 | 二值数据上退化为计数器 |
| 用 phaseHint: string 而非 StarPhase 类型 | 是 | 避免跨模块类型依赖 |
| 信心累加器而非计数器 | 是 | 正反馈机制有生物学支撑，连续分比离散计数器信息量更大 |
| 缺席衰减 0.7 而非硬归零 | 是 | 粘菌启发 — 允许偶尔缺席不打断稳定化过程 |
| promotionThreshold = 0.8 | 是 | 对应 execute 阶段 4 turn、explore 阶段 15 turn |
