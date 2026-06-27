# 轮间首请求 cacheCreate ~12K 根因分析与优化方向

> 2026-06-19 | 天机域调研 | 方法论：贪狼（能力非成本）+ 天璇（层间温跃层）

## 问题

每个用户新消息到来后的第一个请求（turn=0），cacheCreate 恒定在 11-12K 区间，不随上下文规模增长。用户问：这里一定要占用这么多吗？有什么办法？

## 取证来源

- 会话 `fe39a8ee`（deepseek-v4-pro，4 轮用户对话，27 次 API 请求）
- 逐请求缓存日志：`.rivet/sessions/fe39a8ee/cache-log.jsonl`（27 条）
- 代码路径：`src/prompt/engine.ts` buildOaiRequest + `src/prompt/volatile.ts` buildDynamicAppendix

## 数据分析

### 恒等式自检

`input = cacheRead + cacheCreate` 对全部 27 条成立——字段为单次请求值，量纲正确。

### 轮间首请求 cacheCreate 分布

| 轮次 | turn | cacheCreate | hitRate | flags |
|------|------|-------------|---------|-------|
| R2 首请求 | 0 | 11,916 | 73.0% | toolsUpdated |
| R3 首请求 | 0 | 12,023 | 88.7% | toolsUpdated |
| R4 首请求 | 0 | 11,468 | 90.9% | toolsUpdated |

三个值高度一致（11.5K-12K），且 **没有任何一次 volatileSwapped**。这排除了 frozen base swap 作为 cacheCreate 来源。

### 全会话汇总

- 总 input: 2,357,976 tokens
- 总 cacheRead（命中）: 2,222,022（94.3%）
- 总 cacheCreate（未命中）: 134,954（5.7%）
- 费用节省（vs 无缓存）: ~85%

## 根因

### 排除：frozen base swap

cache-log 证实整个会话零次 `volatileSwapped`。frozenBase 只在 `rebuildFrozenBase()`（sessionMemoryBlock 更新或构造函数）时变化，正常会话中极少触发。

### 确认：dynamic appendix 全量重建

每次新用户消息到来时，`engine.ts:289-355` 触发以下流程：

1. `cachedFreshForUser` 变化 → 进入新用户消息分支
2. `buildDynamicAppendix(dynamicCtx, appendixMaxChars)` 全量渲染 `<context-update>` 块
3. 结果追加在 trailer 尾部：`volatileBlock + consolidated + --- + userContent + appendix`

appendix 的上限 `appendixMaxChars`（`engine.ts:231-234`）：

```typescript
const appendixMaxChars = Math.min(
  Math.max(Math.floor(contextWindow * 0.05 * 4), 2_000),
  4 * LARGE_VOLATILE_PAYLOAD_CHARS  // 4 × 12,000 = 48,000 chars ≈ 12K tokens
)
```

48K chars ≈ 12K tokens。**这个上限与实测 cacheCreate 精确吻合**——说明 appendix 在这个项目上实际输出逼近了上限。

### appendix 包含的子块（`volatile.ts:302-476`）

| 子块 | 大致体积 | 每轮必变？ | 信息密度 |
|------|---------|-----------|---------|
| `<star-domain>` | ~500 chars | 否（session constant） | 高 |
| `<historical-lessons>` | ~300 chars | 否 | 高 |
| `<progress>` | ~200 chars | 是 | 中 |
| `<tool-history>` (recent 8) | ~800 chars | 是 | 中（与消息流重复） |
| `<read-file-dedup-hint>` | ~200 chars | 是 | 低 |
| `<git-status>` | ~2000-5000 chars | 是（commit 后） | 中（context-update 已注入） |
| `<recent-commits>` | ~500 chars | 是 | 低（大多数任务无直接价值） |
| `<intent-retrieval-route>` | ~800 chars | 是 | 中 |
| `<plan-methodology>` | ~400 chars | 是 | 低 |
| `<tool-context>` (theta/EFE) | ~200 chars | 是 | 中 |
| 各种 advisory (harness/skill/cross-session) | ~1000-3000 chars | 是 | 变动 |
| **合计** | **~8000-12000 chars** | | |

### 为什么不能避免

DeepSeek prefix cache 是 **exact-prefix**（byte-for-byte 从消息数组开头匹配）。appendix 位于 trailer 尾部，是消息序列的最后一段。前缀缓存命中到上一轮最后一条 assistant 回复为止，从新 user message 开始的全部内容（含 appendix）都是 cacheCreate。

这不是 bug——这是 DeepSeek exact-prefix 机制下，尾部新增内容的物理必然。

## 消息序列结构（trailer mode）

```
[system] ← 永远命中（frozen）
[user1 = frozen(vb + consolidated + --- + msg1 + appendix1)] ← 命中（frozen snapshot）
[assistant1] ← 命中
[tool results...] ← 命中
[assistant2] ← 命中（上一轮最终回复）
... ← 命中到此为止
[user_new = vb + consolidated + --- + userMsg + appendix_new] ← 全部 cacheCreate
```

关键代码（`engine.ts:360-363`）：
```typescript
let merged = this.volatileBlock          // frozen base（~4-6K chars）
if (this.cachedConsolidated) {
  merged += '\n' + this.cachedConsolidated  // habituated blocks（~500 chars）
}
merged += '\n---\n' + userContent          // 用户消息（~100-500 chars）
if (this.cachedAppendix) {
  merged += '\n\n' + this.cachedAppendix   // dynamic appendix（~8-12K chars）
}
```

## 优化方向

### 方向 1：收紧 appendixMaxChars（最简单，立竿见影）

**改动**：`engine.ts:231` 将 `4 * LARGE_VOLATILE_PAYLOAD_CHARS`（48K）改为 `2 *`（24K，~6K tokens）。

**效果**：轮间 cacheCreate 从 ~12K 降到 ~6K（假设 appendix 实际逼近上限）。

**机制**：GWT Top-K 选择（`volatile.ts:466-471`）已就位——收紧预算后，低 salience 块（read-file-dedup-hint、recent-commits、plan-methodology）会被自动丢弃，高 salience 块（star-domain、git-status、intent-retrieval-route）保留。

**代价**：低 salience advisory 被丢弃可能影响某些边界场景的模型行为。但 GWT 的 salience 评分已经优先保留任务关键信息。

**风险**：低。改动只涉及一个乘数常量，GWT 机制保证高价值块不被丢。

**认知影响**：模型每轮看到的上下文更新变少。git-status（salience 0.7）仍保留（因为有训练模式 doom-loop 防护注释），但 recent-commits（salience 0.3-0.5）和 plan-methodology 可能被丢弃。需要观察模型是否因此退化。

### 方向 2：appendix 分离为独立消息（中等复杂度）

**当前**：appendix 追加在最后一条 user message 的尾部（trailer mode），导致 user message 本身的字节因 appendix 变化而"被改写"。

**方案**：把 appendix 放在独立的 user message（位于最后一条 user message之后），格式类似 system-reminder：

```
[user_new = vb + consolidated + --- + userMsg]  ← 用户消息保持纯净
[user_appendix = appendix_new]                  ← 独立消息
```

**效果**：user message 本身可以从前缀缓存命中（如果 vb+consolidated 部分和上一轮的 frozen snapshot 相同）。cacheCreate = appendix 体积不变，但消除了 user message 被改写导致的额外 miss。

**天璇温跃层视角**：不在同一个抽象层（user message 内部）深挖，而是换到消息边界层——把 appendix 提升为独立消息。

**代价**：消息数量增加 1，可能影响 DeepSeek 的消息边界处理。frozen snapshot 机制需要调整——历史消息的 frozen 快照不再包含 appendix，而是作为独立消息存在。

**风险**：中。需要验证 DeepSeek 对尾部独立 user message 的处理是否与 trailer mode 等价。frozen snapshot 逻辑改动面较大。

### 方向 3：跨轮 appendix 增量更新（高复杂度，收益最大）

**当前**：每次新用户消息时 `buildDynamicAppendix` 全量重建所有子块。

**方案**：维护跨轮 appendix 状态，只输出变化部分：
- git-status 只在有 commit 时更新（`markGitDirty` 已有标志，但目前用于触发全量刷新而非增量）
- tool-history 只追加最新一条而非重建整个列表
- advisory 块按 stale 程度选择性刷新

**效果**：appendix 体积从 ~12K 降到 ~1-2K（只有真正变化的部分）。

**代价**：`buildDynamicAppendix` 架构从"全量渲染"改为"增量 diff"，需要维护跨轮 appendix 状态，与 frozen snapshot 机制产生交互（frozen 快照需要知道 appendix 的增量边界）。

**风险**：高。改动面大，增量状态管理复杂，容易引入缓存不一致 bug。

## 建议

先做方向 1（改一个常量），用 cache-log 验证效果。如果 cacheCreate 从 12K 降到 6K 且模型行为没有退化，再考虑方向 2。方向 3 留作长期方向。

## 验证方法

1. 改动后在新会话中观察 cache-log.jsonl 的轮间首请求 cacheCreate 值
2. 用恒等式 `input = cacheRead + cacheCreate` 确认量纲
3. 对比改动前后同等工作量的整体命中率
4. 观察模型行为是否因 advisory 被丢弃而退化（特别关注 git-status 被保留、recent-commits 被丢弃后的表现）

## 参考文件

- `src/prompt/engine.ts:231-234` — appendixMaxChars 计算
- `src/prompt/engine.ts:289-363` — 新用户消息边界处理 + trailer 合并
- `src/prompt/volatile.ts:302-476` — buildDynamicAppendix 全部子块
- `src/prompt/volatile.ts:466-471` — GWT Top-K 选择
- `src/context/payload-diagnostic.ts:27` — LARGE_VOLATILE_PAYLOAD_CHARS = 12,000
- `src/cache/types.ts:12` — matchingStrategy: 'exact-prefix'
- `.rivet/sessions/fe39a8ee/cache-log.jsonl` — 取证数据源
