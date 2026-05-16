# ECF Phase 5: Recall 正反馈 + Claim 质量信号

## 概述

当 recall tool 返回 claims 给 agent 时，记录这些 claims 被"消费"了，并提升其 fitness。被频繁 recall 的 claims 加速晋升为 durable，在 prompt projection 中排名更高，更不容易被 budget eviction 淘汰。

## 架构

recall tool 在返回匹配 claims 后：
1. 对每个匹配的 claim 调用 `store.recordClaimUsed()`（consumer ID 为 `recall:turn-N`）
2. 对每个匹配的 claim 提升 fitness +1（cap 为 10）

这形成正反馈循环：被搜索的 claim → consumer 增加 → 满足 promotion 阈值 → 晋升 durable → 跨 session 持久化。

## 组件

### 1. Recall consumer 记录

recall tool 返回结果后，对每个匹配 claim 调用 `store.recordClaimUsed(claim.id, { id: 'recall:turn-N', usedAt })`。

### 2. Fitness boost

新增 `store.boostFitness(id: string, delta: number, cap: number)` 方法。recall 命中后调用 `boostFitness(claim.id, 1, 10)`。

### 3. 已有链路（无需新增）

- claim-extractor 产生新 file_observation → conflict-detect 标记旧 claim conflicted
- evaluatePromotion 检查 unique consumers >= 3/5 → 自动晋升
- budget eviction 按 fitness 排序 → fitness 高的不被淘汰

## 数据流

```
agent calls recall("port config")
  → claim store: listClaims + text match
  → for each match: recordClaimUsed(claim.id, {id: "recall:turn-5", usedAt})
  → for each match: boostFitness(claim.id, 1, 10)
  → return formatted results to agent

后续效果：
  claim.consumers.length >= 3 → promote to durable_candidate
  claim.consumers.length >= 5 + age > 10min → promote to durable
  claim.fitness 提升 → prompt projection 排名更高
  claim.fitness 提升 → budget eviction 更不容易被淘汰
```

## 测试策略

- recall 返回结果后，claim 的 consumers 增加
- recall 命中后 fitness 增加（不超过 cap=10）
- 多次 recall 同一 claim → 满足 promotion 条件 → 自动晋升

## 技术栈

TypeScript, node:test, existing ClaimStore/recall tool infrastructure.
