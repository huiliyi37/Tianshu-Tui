# 天枢 Prefix Cache 优化实录：从 56% 崩溃到 99.6% 稳态

> **技术领域**: Agent Engineering, Prompt Harness, Exact-Prefix Cache Optimization
> **模型**: DeepSeek V4 (1M context window, exact-prefix cache)
> **优化周期**: 2026-06-01 ~ 2026-06-02
> **最终指标**: 全局命中率 98.7%，稳态命中率 99.6%，稳态 p50 cacheCreate = 342 tokens

---

## 一、问题背景

### 1.1 Exact-Prefix Cache 的工作机制

DeepSeek V4 的 prompt caching 采用 **exact-prefix matching**：请求的 message 序列从前向后做字节级比对。如果请求 N+1 的前 K 条消息与请求 N 完全相同（字节级），则前 K 条消息的 token 全部命中缓存，不计费。一旦在某条消息处出现字节差异，从该位置起所有后续 token 都需要重新计算。

这意味着：**任何一条历史消息的字节变化，都会导致该消息之后的整个 suffix 缓存失效。**

### 1.2 天枢的消息结构

天枢的 prompt harness 将每个 API 请求构建为：

```
[system_prompt] [user_msg_1 + frozen_volatile_context] [asst_1] [tool_1] ... [user_msg_N + frozen_volatile_context + dynamic_appendix]
```

其中 `dynamic_appendix` 包含当前会话的实时状态：工具历史、任务进度、关键决策、会话状态、git 状态等。这些信息在每个 turn 都会变化（新增工具调用、任务步骤推进、文件变更等），变化量通常在 800-3000 tokens。

### 1.3 初始架构的问题

在优化前的架构中，`dynamic_appendix` 被直接拼接到最后一条 user message 的正文之前（"trailer merge"），形成：

```
[frozen_volatile + dynamic_appendix] + "---" + [user_input]
```

当用户发送第二条消息时，第一条消息从"最新消息"变为"历史消息"，其内容通过 **frozen snapshot** 机制保留。在正常情况下，frozen snapshot 能保证历史消息的字节完全不变，缓存命中率可达 98-99%。

但 frozen snapshot 的存储有容量上限（64 条目）。当会话足够长（30+ 轮对话），旧消息的 snapshot 可能被 evict。此时 fallback 路径会重新计算消息内容——而重新计算时 `dynamic_appendix` 的内容已经变了（工具的累积、进度的推进），导致这条历史消息的字节与首次发送时不同。

**结果：Turn 2 缓存命中率从 93.5% 暴跌至 56.2%，约 8,000 tokens 的 prefix 缓存全部失效。**

---

## 二、优化过程

### 2.1 Phase 0：消除 ABORT 路径的消息污染

**发现**：用户按 ESC 中断 agent 后，abort 路径会将已收集的部分 assistant 回复（`collectedBlocks`）写入 session 的消息列表。这些部分回复在下一轮请求中被包含进 message 序列，改变了中间消息的数量和内容，导致 prefix cache 断裂。

**修复**：在 abort 和 streamError 路径中跳过 `addAssistantBlocks` 调用。部分回复不应进入持久化的消息存储。

**效果**：消除了 ESC 中断后发送新消息时的缓存断裂问题。

### 2.2 Phase 1 (v1→v2)：动态附录独立化

**假设**：将 `dynamic_appendix` 从 trailer merge 改为一条独立的、追加在消息列表末尾的 user-role 消息。

**预期**：最后一条 user message 的字节与历史消息完全一致（都只包含 frozen volatile context），不再因为 appendix 变化而改变。

**消息结构变化**：
```
Before: [sys] ... [user_msg_N + frozen + appendix] 
After:  [sys] ... [user_msg_N + frozen] [appendix_msg]
```

**结果**：
- Turn 2 命中率从 56.2% 提升至 84.7%（+28.5pp）
- 但稳态命中率只有 ~90%，远低于优化前的 99%

**根因分析**：虽然最后一条 user message 稳定了，但 `appendix_msg` 作为独立消息追加在末尾——它每次都在不同的字节偏移位置（因为新的 assistant/tool 消息插入在它之前）。DeepSeek 的 exact-prefix cache 是**位置敏感**的——即使 appendix 内容完全不变，因为字节偏移位置变了，也无法命中缓存。

**物理天花板**：独立 appendix 的架构下，每 turn 至少有 ~1000 tokens 的 appendix 内容无法缓存，命中率理论上限约 98%（在 100K context 下）。

### 2.3 Phase 1b：缓存友好的附录排版

**优化**：
1. 去掉 XML 标签中的动态计数属性（`recent="3" total="10"` → 无属性），这些属性每 turn 变化导致 exact match 断裂
2. 将最稳定的 section（star domain, historical lessons, decisions）排在最前面，最易变的 section（session state, repair hint）排在最后
3. 缩减 `read-file-dedup-hint` 从多行列表到单行

**效果**：稳态峰值从 97.0% 提升到 98.3%（+1.3pp），但仍无法突破独立 appendix 的物理天花板。

### 2.4 Phase 1c (Final)：Frozen Appendix — 突破天花板

**关键洞察**：独立 appendix 的根本问题是"位置偏移导致无法缓存"。如果 appendix 不是独立消息，而是**嵌入**在 user message 内部——且在 user content **之后**——那么：

1. 当前 turn：`frozen_volatile + "---" + user_input + "\n\n" + appendix` — appendix 在末尾，变化不影响前面的 prefix
2. 下一 turn：该消息变为历史消息，**frozen snapshot 保留了完整的字节（包括当时的 appendix）** — 检索时返回完全一致的字节
3. DeepSeek cache：历史消息字节完全匹配 → **全量缓存命中**

**消息结构（最终版）**：
```
[sys] ... [user_msg_1 + frozen + appendix_t1] [asst_1] [tool_1] ... [user_msg_N + frozen + appendix_tN]
                                                                              ↑ prefix 精确命中至此
```

**实现要点**：
- `appendix` 从独立消息变为 user message 的尾部追加
- frozen snapshot 自动捕获完整内容（含 appendix）
- 无需额外的 appendix 缓存机制——复用现有的 frozen snapshot 基础设施
- 代码改动量：~30 行（主要删除了独立 appendix 消息的 push 逻辑）

---

## 三、最终成果

### 3.1 v4-pro 长会话验证数据

> 会话 ID: `61300fa0`, 时间: 2026-06-02 12:27~13:16 (49分钟), 113 turns, 15 子会话

| 指标 | 数值 |
|------|------|
| 全局命中率 | **98.7%** |
| 稳态命中率（排除 turn=0 和大 create） | **99.6%** |
| 稳态 p50 cacheCreate | **342 tokens/turn** |
| 稳态 p90 cacheCreate | 1,066 tokens/turn |
| ≥99% 的 turn 占比 | 75% (85/113) |
| ≥99.9% 的 turn 占比 | 27% (31/113) |
| 100% 命中 turn | 3 次 |
| 12:23→12:50 区间命中率 | 98.5%（11.4M tokens） |

### 3.2 深度工作段表现

在 S3 子会话（turns 9-47，共 39 轮连续对话）中：
- 命中率稳定在 99.4-100%
- cacheCreate 中位数 ~200 tokens
- 3 次达到 100% 命中（0 新 token）
- 即使在 160K+ tokens 的 context 下仍保持稳定

### 3.3 与优化前的对比

| 指标 | 优化前 (trailer-merge) | 独立 appendix | 最终 (frozen appendix) |
|------|:---:|:---:|:---:|
| Turn 2 命中率 | 56.2% (崩溃) | 84.7% | 99.4% |
| 全局命中率 | 99.0% (但不稳定) | 89.6% | **98.7%** |
| 稳态命中率 | 99.1% | 90.2% | **99.6%** |
| p50 cacheCreate | 312 | 2,632 | **342** |
| ≥99% turn 占比 | 90% | 0% | **75%** |
| 架构脆弱性 | 高（frozen eviction 可致崩溃） | 低 | **低** |

---

## 四、技术方法论

本次优化体现了以下几个 agent engineering 原则：

### 4.1 缓存是字节级的，不是语义级的

DeepSeek 的 exact-prefix cache 不关心"内容是否相同"，只关心"字节是否相同"。XML 属性 `total="10"` 改为 `total="11"` 虽然语义上只是计数更新，但字节变化导致从此处起全部缓存失效。优化中去除动态属性、冻结 appendix 等操作，本质上是在**保持语义信息的前提下，最小化字节级变化**。

### 4.2 Frozen Snapshot 是缓存稳定性的基石

天枢的 frozen snapshot 机制是本优化的核心技术：在消息从"最新"变为"历史"时，将当时的完整内容（含上下文 appendix）冻结保存。后续检索时返回字节完全一致的副本。这相当于在 prompt harness 层面实现了一个**内容寻址的缓存层**——与 DeepSeek 的 exact-prefix cache 形成了双层缓存架构。

### 4.3 独立消息 ≠ 独立缓存

初始的独立 appendix 设计直觉上正确（将变化隔离到独立消息），但忽略了 exact-prefix cache 的**位置敏感性**。在 append-only 的消息序列中，任何新插入的消息都会偏移后续所有消息的字节位置。正确的做法是将变化嵌入已有消息的内部末尾——利用 frozen snapshot 在消息级别冻结内容，而非在消息序列级别隔离内容。

### 4.4 实证驱动的优化循环

每个版本的优化都有对应的真实会话数据进行验证：
- v1 (trailer-merge): 405 turns, 99.0% 但脆弱
- v2 (standalone): 41 turns, 89.6% — 验证了"消除 crash"但发现新天花板
- v3 (frozen): 50 turns, 97.5% — 初步验证 frozen 方案有效
- v4-pro (frozen, 长会话): 113 turns, 98.7% — 最终验证

总计约 600+ API calls 的实证数据支撑了优化决策。

---

## 五、成本影响

在 DeepSeek V4 的定价模型下，cache hit 的 input token 成本为 0.1 元/百万 token，cache miss 为 1 元/百万 token（约 10x 差异）。

以本次 49 分钟的会话为例：
- 优化后：16.6M cache hit + 0.21M cache create = ¥17.9
- 如果用独立 appendix 方案：约 ¥41.1（2.3x）
- 如果用完全无缓存的方案：约 ¥167.6（9.4x）

**在长会话场景下（100K+ tokens context，50+ turns），frozen appendix 架构相比独立 appendix 节省约 55% 的 API 成本。**

---

## 六、总结

通过三轮迭代优化，天枢的 prompt harness 在 DeepSeek V4 上实现了 **99.6% 的稳态 prefix cache 命中率**，p50 每 turn 仅产生 342 个新 token。核心突破在于认识到 exact-prefix cache 的位置敏感性，并将动态上下文从独立消息改为嵌入消息内部的 frozen snapshot 方案。

这一优化使得天枢在长时间、多轮次的 agent 编码会话中，能够以接近零缓存损耗的成本运行，为复杂任务的持续执行提供了经济可行的基础设施。
