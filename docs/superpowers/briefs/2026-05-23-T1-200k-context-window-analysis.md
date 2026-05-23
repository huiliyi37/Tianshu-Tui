# 200K 上下文窗口优化分析

> 日期：2026-05-23
> 状态：事实调查 + 方案设想，不是实现计划
> 触发：worktree-reality session 复盘中用户提出"200k 窗口没有细致规划"

---

## 1. 当前上下文消耗账本

### 1.1 每轮固定开销（per-turn，进 dynamic appendix）

| 块 | 估算 tokens | 变化频率 | 位置 |
|---|---|---|---|
| `<environment>` | ~40 | 静态 | frozen base |
| `<project-instructions>` (.rivet.md) | 200-800 | 罕见变化 | frozen base |
| `<git-status>` + recent commits | 100-500 | 每 turn | dynamic appendix |
| `<tool-history>` (5条) | 100-300 | 每 turn | dynamic appendix |
| `<session-state>` | 100-400 | 每 turn | dynamic appendix |
| `<historical-lessons>` | 50-200 | 每 turn（relevance filtered） | dynamic appendix |
| `<active-claims>` | 50-300 | 每 turn（relevance filtered） | dynamic appendix |
| `<cross-session-events>` | 0-200 | 偶尔 | dynamic appendix |

**单轮 dynamic 开销**：~400-1900 tokens（取决于 git diff 大小和 claims 数量）

### 1.2 累积开销（across turns）

| 来源 | 增长模式 | 当前处理 |
|---|---|---|
| 对话历史（user + assistant） | 线性增长，每轮 1-5k | 无处理（直到 compact 阈值） |
| tool 调用结果 | 爆发增长（read_file, grep 等） | `microCompactOai` 截断到 1200 字符 |
| thinking/reasoning | 每轮 0.5-3k | 截断到 500 字符 |
| stale rounds tool results | N-2+ 轮的 tool 结果 | `compactStaleRoundsOai` 截断到 1200 字符 |

### 1.3 系统提示开销（per-request）

| 块 | 估算 tokens | 备注 |
|---|---|---|
| static.ts 系统提示 | ~3000-5000 | 每次请求都有，但可缓存 |
| frozen volatile block | ~500-1500 | prefix cache 主体 |
| dynamic appendix | ~400-1900 | 每 turn 重建 |
| **合计系统提示** | ~4000-8400 | |

### 1.4 200K 预算分配现状

```
总预算:          200,000 tokens (DeepSeek V4)
系统提示:        ~5,000-8,000 (2.5-4%)
compact 阈值:    ~156,000 (78% ratio × 200K)
reactive 阈值:   ~176,000 (88% ratio × 200K)
ceiling:         ~190,000 (95% ratio × 200K)
```

**可用对话空间**：~190,000 - 8,000 = ~182,000 tokens
**安全工作区**：< 156,000 tokens (78%)

---

## 2. 瓶颈分析

### 2.1 最大消耗者：对话历史中的 tool 结果

一个典型的长 session：
- 20 轮对话 × 平均 3 次 tool 调用 × 平均 2k chars/tool = 120k chars ≈ 30k tokens
- 加上 assistant thinking: 20 × 1k = 20k tokens
- 加上 user messages: 20 × 500 = 10k tokens
- **合计**：~60k tokens（还没到 compact 阈值）

但爆发场景（如本次 session 的大规模代码阅读）：
- 30 轮 × 5 次 tool 调用 × 4k chars/tool = 600k chars ≈ 150k tokens
- **直接接近 78% 阈值**

### 2.2 已有的缓解机制

| 机制 | 文件 | 效果 |
|---|---|---|
| `microCompactOai` | `src/compact/micro.ts` | 新 tool 结果 >1200 chars 立即截断 |
| `compactStaleRoundsOai` | `src/compact/stale-round.ts` | N-2+ 轮 tool 结果截断到 1200 chars |
| `compactOaiReasoning` | `src/compact/micro.ts` | thinking 截断到 500 chars |
| CVM throttle | `src/context/pressure-monitor.ts` | CVM 注入超过 5% 时节流 |
| `PressureMonitor.check()` | 同上 | 检测 fast growth（15% 增量）和 thrashing |
| CompactionController | `src/agent/compaction-controller.ts` | 多级 compact 策略（tier 0-4） |

### 2.3 缺失的机制

1. **没有 tool 调用频率感知** — agent 不知道自己已经在同一轮做了 15 次 grep，可以停下来综合判断
2. **stale round 定义太简单** — 只看 message index（N-4），不看内容价值
3. **没有"信息密度"指标** — 两次 grep 结果可能高度重叠，但都被保留
4. **volatile block 的 frozen/dynamic 边界** — 刚修好 git-status，但 working-set、session-memory 仍在 frozen 里，它们变化时也会破坏 cache

---

## 3. 优化设想（按 ROI 排序）

### P0. 已完成 ✅

- **git-status 移到 dynamic appendix** — 已在 `d9256bc` 完成。效果：每 turn 的 git diff 变化不再破坏 prefix cache。

### P1. 高 ROI，低风险（建议下一阶段实施）

#### 3.1 Stale round 截断阈值动态化

当前：硬编码 `STALE_PREVIEW_CHARS = 1200`。
建议：根据 `pressureMonitor.ratio` 动态调整。

```
ratio < 60% → 保留 2000 chars
ratio 60-78% → 保留 1200 chars（当前默认）
ratio 78-88% → 保留 600 chars
ratio > 88% → 保留 200 chars
```

文件：`src/compact/stale-round.ts`
工作量：~30 行改动 + 20 行测试

#### 3.2 Tool 调用去重

同一个 tool 对同一个 target 连续调用两次（如 `read_file` 同一路径），第二次结果可以只保留 diff 或标记 `<duplicate-of-idx-N>`。

文件：`src/compact/micro.ts` 新增 `deduplicateToolResults()`
工作量：~50 行 + 30 行测试

### P2. 中 ROI，中风险（需要设计讨论）

#### 3.3 Frozen block 敏感度分析

`workingSet` 和 `sessionMemoryBlock` 在 frozen base 中。如果它们变化频繁（比如每 3-5 turns 更新一次），也会破坏 prefix cache。

建议：测量实际 cache miss rate。如果 >30% 的 turns 因为 frozen block 变化导致 miss，考虑把 `workingSet` 也移到 dynamic appendix。

文件：`src/prompt/volatile.ts` + `src/prompt/engine.ts`
工作量：~40 行改动 + 更新 cache stability 测试

#### 3.4 主动信息摘要（Proactive Summary）

当前 compact 是被动的——等到 ratio 到阈值才触发。建议在 `watch` tier（60%）时就对 stale rounds 做**摘要替换**而非仅截断：用 compact model 把旧 round 的关键信息压缩成 2-3 句话。

文件：`src/agent/compaction-controller.ts` + 新文件 `src/compact/proactive-summary.ts`
工作量：~100 行 + 60 行测试
前提：compact client 可用且稳定

### P3. 低 ROI 或高风险（不建议近期实施）

#### 3.5 200K → 更大窗口

DeepSeek V4 的 200K 已经是当前模型的硬上限。不能改。

#### 3.6 多 session 分片

把长任务拆成多个 session，每个 session 独立上下文。理论上好，实践上需要：
- session 间状态传递协议
- 用户手动触发或 agent 自动判断
- 复杂度高，收益不确定

---

## 4. 实际建议

对于稳定态迭代阶段：

1. **不急着做 P1/P2 优化**——当前 compact 机制在 200K 窗口下对大多数 session 够用
2. **在 brief 中记录这个分析**——下次遇到上下文压力问题时可以快速召唤
3. **如果要做，优先做 3.1（stale round 动态截断）**——改动最小、效果最直接
4. **3.3 需要 data backing**——先加 cache miss 计数，再决定是否把 workingSet 移到 dynamic

---

## 5. 关键代码路径索引

| 关注点 | 入口文件 |
|---|---|
| Compact 策略阈值 | `src/compact/constants.ts:30-50` |
| Stale round 截断 | `src/compact/stale-round.ts:8-26` |
| Micro compact（tool 结果截断） | `src/compact/micro.ts:14-25` |
| Pressure monitor | `src/context/pressure-monitor.ts:1-139` |
| Compact tier 决策 | `src/context/compact-policy.ts:14-50` |
| Compaction controller | `src/agent/compaction-controller.ts:1-145` |
| Volatile block 构建 | `src/prompt/volatile.ts:252-355` |
| Frozen vs Dynamic 分界 | `src/prompt/volatile.ts:118-136` |
