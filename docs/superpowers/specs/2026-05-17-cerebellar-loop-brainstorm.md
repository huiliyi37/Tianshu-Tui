# Cerebellar Loop: Deep Brainstorm 过程记录

> 关联实施计划：[`docs/superpowers/plans/2026-05-17-cerebellar-loop.md`](../plans/2026-05-17-cerebellar-loop.md)

## 背景

用户要求为 Rivet 设计一个新开发任务，作为 DeepSeek 长链路执行能力的测试样本。要求从生物/神经科学领域获取跨领域灵感。

## 调研（3 + 1 Scout 模式）

### Scout 1: Rivet 架构空位

扫描代码中的 TODO/FIXME、retry 逻辑、doom loop 检测、compaction 策略。

**关键发现（8 个 gap）：**

| # | Gap | 证据 | 影响 |
|---|-----|------|------|
| 1 | 无跨 session 学习 | session-memory.ts 按 sessionId 隔离 | 每次重复犯同样错误 |
| 2 | Reasoning effort 静态 | auto-reasoning.ts 只在 loop 开始调用一次 | 简单任务浪费 token，复杂任务 reasoning 不足 |
| 3 | Doom loop 是反应式的 | trace-store.ts:87 — fingerprint count ≥ 2 才触发 | 浪费 3+ turns 才检测到 |
| 4 | 无 turn 级 ROI 追踪 | loop.ts:371 — 简单 for 循环，无进度检查 | 不知道是否在浪费 budget |
| 5 | 失败知识 session 后丢失 | antibody.ts TTL=4h, scope=session | 跨 session 重复同样失败 |
| 6 | 无验证强制执行 | delivery-gate.ts canClaimComplete 未被 loop 检查 | agent 未验证就声称完成 |
| 7 | Goal loop 无轨迹感知 | goal-loop.ts:44 只传 lastOutput.slice(-1500) | 重试时重复失败方法 |
| 8 | Compaction 破坏决策上下文 | auto.ts:90 通用 summarization，不保留 antibodies/decisions | compaction 后重走死路 |

### Scout 2: 生物系统

搜索非常见生物隐喻（排除神经网络、遗传算法、群体智能）。

**关键发现（8 个机制）：**

| # | 机制 | 自然界问题 | Agent 类比 |
|---|------|-----------|-----------|
| 1 | 细菌群体感应 | 个体感知噪声大 | Sub-agent 信心聚合：pool 局部估计，阈值后才行动 |
| 2 | 免疫亲和力成熟 | 靶向新威胁不自伤 | Claim 质量选择：负选择（去重复）+ 生发中心竞争 |
| 3 | 黏菌网络优化 | 无地图找高效路径 | Context window 形状优化：局部强化 + 全局衰减 |
| 4 | 蚂蚁信息素 | 集体寻路 + 自纠正 | Tool 使用模式学习：蒸发权重 + 失败时随机偏离 |
| 5 | 章鱼臂自主 | 无限自由度运动控制 | Sub-agent 委托：目标级命令 + 嵌入式 motor program |
| 6 | 生长素 tipping point | 方向生长不过冲 | 错误纠正比例降级：多通道反馈调节 |
| 7 | 自噬 vs 凋亡 | 分级细胞清理 | Context compaction（自噬）vs session reset（凋亡） |
| 8 | 群体感应作弊抵抗 | 维持合作行为 | Sub-agent 质量执行：peer 评估 + 频率依赖选择 |

### Scout 3: 神经科学

搜索认知/神经机制（排除基础 NN 概念）。

**关键发现（7 个机制）：**

| # | 机制 | 大脑问题 | Agent 类比 |
|---|------|---------|-----------|
| 1 | 前额叶抑制控制 | 固着（perseveration） | 固着检测器 + 强制策略切换 |
| 2 | 海马体 replay | 记忆脆弱性 | 选择性巩固到 project-memory |
| 3 | 小脑前向模型 | 慢反馈循环 | **Predict-then-verify on tool calls** |
| 4 | 基底节 RPE | 探索-利用权衡 | 价值加权策略选择 |
| 5 | 默认模式网络 | 固着/卡住 | 卡住时切换到广泛阅读模式 |
| 6 | 前扣带回元认知 | 错误检测 | **Confidence 阈值监控** |
| 7 | 认知负荷分块 | 容量限制 | 层次化压缩摘要 |

---

## 假设合成（Step 0.4）

**交叉点假设：**

基于 [scout-gaps: doom loop 反应式 + 无 turn 级追踪 + reasoning 静态] + [scout-neuro: 小脑前向模型 predict-verify-update] + [scout-bio: 生长素 tipping point 比例纠错 + 防过冲]：

> Rivet 应实现一个 Prediction-Error Accumulator，在每次 tool call 前记录预期结果，执行后计算误差，用累积误差比例地升级干预强度，并在预测恢复准确时自动降级。

**隐含前提反证：**

| 前提 | 性质 | 结论 |
|------|------|------|
| LLM 能可靠预测 tool call 结果 | 假设 | 不需要精确，方向性正确即可（"expect tsc pass" vs "expect error"） |
| 预测步骤不会显著增加 token | 事实约束 | ~20 tokens/call × 50 turns = 1000 tokens，可接受 |
| 累积误差比 fingerprint 更好 | 假设 | 互补关系：fingerprint 检测精确重复，误差累积检测"软循环" |
| 比例升级比二元阈值更好 | 惯例 | 允许中间态（提高 reasoning、强制 read-before-edit、建议换方向） |

---

## 三轮演化

### 第一轮：变异

| 方案 | 生态位 | 核心选择 |
|------|--------|---------|
| V1 Prediction-Error Accumulator | 主流 | 每次 tool call 前预测结果，执行后比对，滑动窗口累积误差率驱动分级干预 |
| V2 Progress Velocity Monitor | 邻近 | 不预测，追踪客观进度信号（test pass count delta, error count delta），速度为零→干预 |
| V3 Cerebellar Forward Model | 空位 | 维护结构化 codebase mental model，预测影响范围，误差更新 model，uncertain 区域强制 read |
| V4 Auxin Gradient | 突变 | 追踪"纠错强度"（每 turn 花多少比例修复上一 turn 的问题），持续 >70% → tipping point reset |

### 第二轮：选择

**灭绝：**
- V3 — 维护结构化 codebase model 的 token overhead 远超 5% 硬约束
- V4 — "区分纠错 vs 新进度"需要额外 LLM 判断，成本高且覆盖面窄

**存活：** V1（强）、V2（中）

**discarded_trait 回收：**
- V3 → "uncertain 区域强制 read-before-edit" → 吸收到 V1（error rate 高时触发）
- V4 → "tipping point reset" → 吸收到 V1（连续 3 次正确后降级）
- V4 → "rollback 建议" → 吸收到 V1（累积误差极高时建议 undo）

### 第三轮：适应

**收敛洞察：** V1 和 V2 收敛到「卡住的本质不是重复（症状），而是 agent 的 mental model 与代码实际状态的偏差在累积」。

**扩展适应：** TraceStore 已有 tool call 记录 → 只需加 `predictedSuccess` 字段（零新基础设施）。

**最终方案：** Prediction-Error Accumulator + 比例干预（hint → gate → escalate）+ tipping point reset + reasoning effort 动态调整。

**命名：Cerebellar Loop** — 预测-验证-适应循环。

---

## 最终方案架构

```
tool call 即将执行
  → heuristic 预测结果（edit → expect tsc pass; test → expect exit 0）
    → 执行 tool call
      → 比对实际结果 vs 预测
        → 更新 PredictionAccumulator 滑动窗口
          → 计算 error rate
            ├── < 0.4 → none（透明，不干预）
            ├── ≥ 0.4 → hint（prompt 注入"mental model 可能过时"）
            ├── ≥ 0.6 → gate（block edit_file 直到先 read_file）
            └── ≥ 0.8 → escalate（建议 rollback + 升级 reasoning effort）
          → 连续 3 次正确 → tipping point reset → 降级一档
```

**一个信号（prediction error rate）驱动三个下游：**
1. Doom loop 预警（在 fingerprint 触发前 1-2 turns）
2. Reasoning effort 动态调整（medium → high → max）
3. Delivery gate 联动（error rate > 0 时 block completion claim）

---

## 与 Multi-Provider Phase 1 的互补性

| 维度 | Multi-Provider | Cerebellar Loop |
|------|---------------|-----------------|
| 核心能力测试 | 接口提取 + 安全迁移 | 新概念引入 + 多层联动 |
| 改动模式 | 替换现有代码（callsite 迁移） | 新增代码（新数据结构 + hook） |
| 风险类型 | 破坏现有行为 | 干预太频繁影响正常工作 |
| 验证方式 | typecheck + 现有测试通过 | 构造"卡住"场景验证干预触发 |
| 架构理解深度 | config → factory → client（3 层） | trace-store → tool-pipeline → turn-end → auto-reasoning → prompt-engine（5 层） |
