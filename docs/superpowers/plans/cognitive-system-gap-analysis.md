# 认知系统闭环审计

> 日期: 2026-06-05
> 状态: Gap Analysis — 记录未整合/不完整部分，待讨论方案

---

## 已完成的认知管线（✅ 全部接入 loop.ts）

| 模块 | 行数 | 测试数 | 接入点 |
|------|------|--------|--------|
| `affordance.ts` | 361 | 16 | loop.ts:1230 `renderAffordanceHint` |
| `sensorium.ts` | 279 | 28 | turn-perception.ts → loop.ts:1207 |
| `vigor.ts` | 217 | 20 | turn-perception.ts → loop.ts:1208 |
| `cognitive-season.ts` | 68 | 21 | loop.ts:1213 `classifySeason` |
| `star-event.ts` | 285 | 32 | loop.ts:1206 `getThetaPhase` |
| `policy-selection.ts` | 137 | 13 | loop.ts:1236 `selectPolicy` |
| `prediction-error.ts` | 132 | — | loop.ts:1188 `computeEFE` |
| `turn-perception.ts` | 223 | — | loop.ts:1183 `perception.perceive` |
| `tool-execution.ts` | 379 | — | 预测误差记录 + 干预升级 |
| `theta-check.ts` | 79 | — | 外部 theta 信号触发 |
| `theta-controller.ts` | 68 | — | loop.ts:696 `requestThetaCheck` |
| `context/cognitive-ledger.ts` | — | — | loop.ts:1061-1078 CVM 投影 |

**集成管线流程**（每轮执行）:
```
perceive() → sensorium + vigor + theta
    → classifySeason()
    → computeAffordanceScores()
    → computeEFE() → selectPolicy()
    → renderAffordanceHint() + renderPolicyGuidance()
    → promptEngine.set*() 注入提示
    → 每10轮 adaptAffordanceFromHistory() 反馈
```

**集成测试**: `cognitive-pipeline.test.ts` (7 tests) 验证端到端管线。

---

## 未整合 / 不完整的部分

### 1. 🟡 `world-season.ts` — 世界级季节信号（未接入）

- **文件**: `src/agent/world-season.ts` (46 行)
- **状态**: 已实现，但 **零 import**。没有任何文件引用它。
- **设计意图**: 基于"一天中的时间"和"会话持续时间"计算世界级季节（晨/午/暮/夜），作为 `cognitive-season` 的外部输入。
- **当前问题**: `cognitive-season.ts` 的 `classifySeason` 完全基于内部信号（turn、doom level、stability），没有消费 world-season。
- **闭环方案**: 
  - A) 在 `classifySeason` 的输入中增加 `worldSeason` 字段，作为季节分类的额外因子（权重低，例如 0.1）
  - B) 删除 `world-season.ts`，如果认为内部信号已足够

### 2. 🟡 `ask_user_question` affordance 分类粗糙

- **当前**: `{ epistemic: 0.5, instrumental: 0.5 }` — 完全中性
- **问题**: 提问行为有明确的认知语义——"获取缺失信息"是 epistemic，"确认执行意图"是 instrumental。静态 0.5/0.5 丢失了这个信号。
- **影响**: 对工具选择影响小（ask_user_question 不常被 policy 推荐），但作为认知系统完整性的 gap 值得修复。
- **方案**:
  - A) 保持 0.5/0.5，因为它确实取决于上下文，affordance 系统的设计就是"静态基线 + 动态调制"
  - B) 改为 `{ epistemic: 0.65, instrumental: 0.35 }`，因为提问的主要目的是减少不确定性

### 3. 🟡 Prediction Error 反馈链未验证

- **现状**: `tool-execution.ts` 中有 `recordPrediction(correct)` 调用，`prediction-error.ts` 有 `computeEFE` 和干预级别系统。
- **问题**: 预测的"正确性"判定逻辑是什么？`tool-execution.ts:158-161` 中 `correct` 是怎么算的？这条链路缺少独立测试。
- **需要**: 确认 prediction → error → EFE → policy 这条反馈链是否真正在影响行为，还是只是"计算了但没用上"。

### 4. 🟢 `contextualModulator` 中的 `fileTools` Set 每次重建

- **现状**: `contextualModulator` 在每次调用时 `new Set([...])`。N=40+ 工具时，每轮创建 40 个 Set。
- **严重性**: 极低。40 个 Set 创建 < 0.1ms，不会成为瓶颈。
- **是否修复**: 可以提取为模块级常量，但不是优先级。

### 5. 🟢 Cognitive Pipeline 集成测试覆盖范围

- **现有**: 7 个测试覆盖基本管线流转
- **缺失场景**:
  - sensorimotor 反馈触发 affordance 适配（需要 mock MeridianDb）
  - 连续重复工具触发渐进惩罚
  - world-season 输入（如果整合的话）
  - theta phase 变化对 policy 的影响

---

## 总结

| 类别 | 数量 | 说明 |
|------|------|------|
| ✅ 已完成并接入 | 12 模块 | 核心管线完整 |
| 🟡 需要决策 | 3 项 | world-season、ask_user_question、prediction 反馈链验证 |
| 🟢 可选优化 | 2 项 | Set 提取、测试覆盖扩展 |

**核心管线已闭环**。剩余的 gap 都是"增强"而非"缺失"——认知系统的主要信号流（感知 → 季节 → 可供性 → 策略 → 提示注入 → 行动反馈 → 自适应）已经完整运行。

下一步建议按优先级：
1. **验证 prediction feedback chain** — 确认 EFE → policy 是否真正影响模型行为
2. **决定 world-season 去留** — 要么接入，要么删除死代码
3. **ask_user_question 分类** — 低优先级，5 分钟修复
