# 三版本缓存命中率对比分析

> **日期**: 2026-06-02
> **关联提交**: `ce34bdc` (frozen appendix)
> **会话 ID**:
> - v1: `51e76a8b` (旧代码, trailer-merge)
> - v2: `4db79137` (P1b standalone appendix)
> - v3: `2f0d8e6a` (ce34bdc frozen appendix)

## 总览

| 指标 | v1 trailer-merge | v2 standalone | v3 frozen |
|------|:---:|:---:|:---:|
| 条目数 | 405 | 41 | 50 |
| 总输入 tokens | 101.1M | 1.70M | 3.88M |
| **总命中率** | **99.0%** | **89.6%** | **97.5%** |
| 平均命中率 | 98.7% | 87.0% | 95.7% |
| cacheCreate p50 | 347 | 2,726 | 446 |
| cacheCreate p90 | 2,075 | 7,830 | 6,838 |
| cacheCreate p99 | 27,749 | 13,909 | 12,676 |
| min cacheCreate | 45 | 1,270 | 96 |
| max cacheCreate | 261,482 | 13,909 | 12,676 |
| ≥99% 轮次 | 363 (90%) | 0 (0%) | **31 (62%)** |
| ≥99.9% 轮次 | 196 | 0 | 2 |
| 最大 input | 424,833 | 92,599 | 112,255 |

## 稳态对比（跳过热身轮次）

| 指标 | v1 trailer-merge | v2 standalone | v3 frozen |
|------|:---:|:---:|:---:|
| 稳态轮数 | 378 | 35 | 47 |
| **p50 cacheCreate** | **312** | **2,632** | **431** |
| **稳态命中率** | **99.1%** | **90.2%** | **97.5%** |
| ≥99% 占比 | 93% | 0% | 66% |

## 关键发现

### 1. v2 → v3 改善显著

v3 (frozen appendix) 相比 v2 (standalone appendix) 改善：
- 总命中率：89.6% → 97.5%（**+7.9pp**）
- p50 cacheCreate：2,726 → 446（**6.1x 降低**）
- ≥99% 轮次：0% → 62%（**从无到有**）

根因：v2 的 standalone appendix 因位置偏移导致每轮 ~1000 tokens 无法缓存。v3 将 appendix 冻结进 user message，frozen snapshot 保留完整内容，历史检索返回字节一致 → 缓存命中。

### 2. v3 vs v1 仍有小幅差距

v3 相比 v1 仍有差距：
- 命中率：99.1% → 97.5%（**-1.6pp**）
- p50 create：312 → 431（**+38%**，约 +119 tokens/轮）

可能原因：
- v1 有 378 轮稳态（样本量大），v3 只有 47 轮（样本量小，统计波动）
- v1 appendix 在 user content 之前（`cachedFreshBlock + userContent`），v3 在之后（`userContent + appendix`），字节顺序差异可能影响缓存行为
- v3 的最大 input 仅 112K vs v1 的 425K — 更小的 context 意味着相同的 appendix 占比更高

### 3. 成本影响估算

在 400K tokens 上下文下（v1 相同规模）：
- v1 (312 create/turn): cacheCreate 占比 0.08%，几乎零成本
- v2 (2632 create/turn): cacheCreate 占比 0.66%，**8x v1 成本**
- v3 (431 create/turn): cacheCreate 占比 0.11%，**1.4x v1 成本**

v3 相比 v2 节省 **83% cacheCreate**，相比 v1 仅多 **38%**。

## 结论

1. **v3 frozen appendix 架构成功**：将 standalone appendix 的 98% 天花板打破，恢复到 97.5%+ 命中率
2. **距 v1 的 99.1% 仍有 1.6pp 差距**，但在 47 轮小样本下可能被统计噪声放大；需要更长会话验证
3. **v3 已消除 v2 的位置偏移问题**：≥99% 轮次从 0% 恢复到 62%
4. **推荐**: 继续使用 v3 frozen appendix，在更长会话中收集数据确认是否能稳定达到 99%+
