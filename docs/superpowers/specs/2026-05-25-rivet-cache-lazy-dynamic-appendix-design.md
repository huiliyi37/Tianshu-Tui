# Lazy Dynamic Appendix — 缩小 Turn 0 Uncached Delta

## 背景

### 问题

Rivet 在 DeepSeek V4 Pro 上的 cache hit rate：
- Turn 1-N（同一 user message 内的 tool turns）：97-99.7% ✓
- Turn 0（新 user message 边界）：80-96% — 有优化空间

Turn 0 的 uncached tokens（~2000-2500）由三部分组成：
1. 上一轮 assistant 响应尾部（不可压缩）
2. 新 user message 文本（不可压缩）
3. **cachedFreshBlock 与上次的差异**（可压缩）— 约 1000-1500 tokens

第 3 项来自 `buildDynamicAppendix()` 每次新 user message 到来时全量重新渲染。其中大部分字段在连续 user messages 之间内容不变，但每次都被重新序列化。

### Claude Code 参照

Claude Code + cliproxy 在 DeepSeek 上达到 99.8% hit rate，原因是它没有任何动态 volatile 注入——对话是纯 append-only。Rivet 的动态上下文注入是能力优势（star domain、repair hint、task progress 等），但需要最小化其对 cache 的负面影响。

### 核心判断（来自 ctcl-cache-preservation-spine-design.md）

> 压缩只有在改写 DeepSeek 正在匹配的 cache-sensitive prefix 时，才会打穿 cache。

Rivet 的 prefix 从不被修改（frozenUserMerged 机制保证）。Turn 0 的"低 hit rate"不是 prefix 断裂，而是 **尾部 delta 体积过大**。优化方向：缩小 delta。

## 约束

- **多会话并行**：天枢支持多个 session 同时开发同一 repo。git status 会被其他 session 改变（新文件、stage 变化、branch 切换）。gitStatus 不能简单地"冻结不更新"。
- **不牺牲 agent 能力**：dynamic appendix 中每个字段都有其存在的理由，不能简单删除。
- **DeepSeek exact-prefix**：不支持 cache_control breakpoint，纯粹按 token 前缀匹配。

## 方案：Lazy Render with Content-Hash Dedup

核心思想：**不变的内容不重新序列化**。对 dynamic appendix 的每个字段做 content-hash 比较，只有真正变化了的字段才重新渲染到最终字符串中。

### 机制

```
每次 buildDynamicAppendix() 被调用时：
  1. 对每个字段计算 lightweight hash（djb2 on first 200 chars + length）
  2. 与上次的 hash 比较
  3. 如果所有字段的 hash 都不变 → 直接返回上次缓存的渲染结果
  4. 如果有字段变了 → 只重新渲染变化的字段，拼接成新结果
```

这不改变最终输出内容——只改变"是否重新计算"。如果内容确实变了，照常渲染。

### 字段分级

基于 5 个 scout 的调查结果，对 dynamic appendix 中每个字段分级：

| 字段 | 变化触发条件 | 实际变化频率 | 优化策略 |
|------|------------|------------|---------|
| `gitStatus` | 任何 git 操作、文件写入、外部 session 变更 | 每 1-5 个 user message | event-driven refresh |
| `toolHistory` | 每次 tool call | 每个 turn | 增量渲染 |
| `taskProgress` | task 状态变更 | 每 2-10 个 turns | dirty check |
| `repairHint` | tsc 失败 / tool 连续失败 | 90%+ 为 null | skip-when-null |
| `decisions` | agent 做出决策 | 80%+ 为空 | skip-when-empty |
| `activeDomain` | session 开始时绑定 | per-session 不变 | 已被 habituation 处理 |
| `playbookLessons` | session 开始加载 | per-session 不变 | 已被 habituation 处理 |
| `crossSessionEvents` | 其他 session 发事件 | 99% 为 null | skip-when-null |
| `heuristicRules` | session 开始加载 | per-session 不变 | 移入 frozenBase |
| `sessionState` | session 状态变更 | 每 5-20 个 turns | dirty check |
| `worktreeReality` | worktree 检测 | per-session 不变 | 已在 frozenBase |

### 具体改动

#### 1. heuristicRules 移入 frozenBase

heuristicRules 在 session 开始时加载，之后不变。它不应该在 dynamic appendix 中。

移入 `buildStableVolatileBlock()`，作为 session-level 稳定内容。

#### 2. skip-when-null/empty

当字段值为 null/undefined/空数组时，不渲染对应 XML 标签（连 `<repair-hint></repair-hint>` 空标签都不输出）。

受影响字段：`repairHint`、`decisions`、`crossSessionEvents`、`sessionState`

#### 3. gitStatus event-driven refresh

gitStatus 不能冻结（多会话并行），但也不需要每次都重新读取。

策略：
- 在 `invalidateFreshCache()` 时标记 `gitStatusDirty = true`
- 当以下事件发生时标记 dirty：
  - Bash tool 调用含 `git` 关键词
  - Write/Edit tool 执行成功（文件变更）
  - 每 N 个 user message 强制刷新（防止外部变更遗漏，N=3）
- 未 dirty 时复用上次渲染结果

**注意**：多会话并行下，其他 session 的文件操作会让 git status 变化。强制每 3 个 user message 刷新一次是安全网。如果 agent 发现 git 状态和预期不符（如 merge conflict），它会自己执行 `git status` 命令——这触发 Bash tool → dirty flag。

#### 4. toolHistory 增量渲染

当前 toolHistory 每次全量渲染所有历史 tool calls。优化为：

- 在 frozenBase 中不包含 toolHistory（已经是这样）
- 在 dynamic appendix 中只渲染 **自上次 user message 以来** 的 tool calls
- 历史 tool calls 已经在对话的 assistant/tool_result 消息中可见，不需要在 volatile 中重复

这是最大的 token 节省项。当前一个 20-turn session 的 toolHistory 可达 1000+ tokens，但 agent 真正需要看到的只是最近几次的摘要。

#### 5. taskProgress chat-mode 跳过

chat mode 下 taskProgress 永远是 `{ completed: [], current: 'chat-mode', remaining: [], decisions: [] }`。不渲染。

#### 6. 整体 content-hash 快速路径

在所有字段计算完毕后，对最终拼接结果做 hash 比较。如果和 `cachedFreshBlock` 中的 dynamic 部分完全相同，跳过 frozenUserMerged 更新（字符串没变 → prefix 字节没变 → cache 自然命中）。

## 预期收益

### Token 节省（per Turn 0）

| 优化项 | 节省 tokens |
|--------|-----------|
| heuristicRules 移入 frozenBase | ~200-400 |
| skip-when-null (repairHint, decisions, crossSessionEvents) | ~50-150 |
| toolHistory 增量（只渲染最近 N 条） | ~300-800 |
| taskProgress chat-mode 跳过 | ~100 |
| gitStatus 复用（未 dirty 时） | ~200-400 |
| **合计** | **~850-1850** |

### Hit Rate 提升

当前 Turn 0 @ 60K context：
```
uncached = 2500 tokens → hit rate = 95.8%
```

优化后：
```
uncached = 2500 - 1200(节省) = 1300 → hit rate = 97.8%
uncached at 100K context = 1300 → hit rate = 98.7%
```

加上 Turn 1-N 本来就是 99%+，session 平均 hit rate 预计从 ~95% 提升到 ~98%。

要达到 Claude Code 的 99.8% 需要 context > 100K 且 delta < 200——这在 Rivet 的 dynamic appendix 存在的前提下是物理极限。但 98%+ 意味着 1 亿 token 的成本从 ~¥14 降到 ~¥11。

## 风险

| 风险 | 概率 | 影响 | 应对 |
|------|------|------|------|
| gitStatus 过期导致 agent 误判 | 中 | 中（agent 会自己 `git status` 修正） | 每 3 个 user message 强制刷新 |
| toolHistory 增量遗漏导致 agent 重复操作 | 低 | 低（历史在 conversation 中可见） | 保留最近 5 条完整渲染 |
| heuristicRules 移入 frozenBase 后 session 中途加载新规则 | 极低 | 低 | 提供 `invalidateHeuristicRules()` escape hatch |
| content-hash 碰撞导致错误复用 | 极低（djb2 + length double check） | 高 | 加 length 校验 |

## 实施路径

### Phase 1（Day 1）：最小验证 — ✅ DONE

- [x] skip-when-null/empty（repairHint, decisions, crossSessionEvents, sessionState）
- [x] taskProgress chat-mode 跳过（shouldInjectDynamicAppendix returns false in chat mode）
- [x] 跑 test suite 确认无回归
- [ ] 在真实会话中对比 cache-log

成功标准：Turn 0 uncached 减少 200+ tokens，无功能回归。

### Phase 2（Day 2-3）：核心优化 — ✅ DONE (3/4, content-hash deferred)

- [x] heuristicRules 移入 frozenBase（2026-05-25, TDD, 29/29 tests）
- [x] toolHistory 增量渲染（只保留最近 8 条, maxRecent=8）
- [x] gitStatus event-driven refresh（dirty flag + 每 3 条 user message 强制刷新）
- [ ] 整体 content-hash 快速路径（deferred — 需要 benchmark 验证收益）

成功标准：Turn 0 uncached 减少 1000+ tokens，session 平均 hit rate > 97%。

### Phase 3（Day 4）：验证与微调

- [ ] 多会话并行场景测试（2 个 session 同时操作同一 repo）
- [ ] 长会话测试（50+ turns）
- [ ] 成本对比（优化前 vs 优化后的 ¥/session）

## 非目标

- 不重构 PromptEngine 的 trailer 模式架构
- 不改变 frozenUserMerged 的核心逻辑
- 不影响 Turn 1-N 的 99%+ hit rate（已经最优）
- 不引入新的 cache_control 机制（DeepSeek 不支持）

## 与现有机制的关系

| 现有机制 | 本方案的关系 |
|---------|-----------|
| frozenUserMerged | 不修改。本方案缩小的是 merged 内容中 dynamic 部分的体积 |
| cachedFreshBlock / cachedFreshForUser | 不修改缓存逻辑。本方案让 cachedFreshBlock 内容本身更小 |
| FieldHabituationTracker | 补充关系。habituation 处理 activeDomain/playbookLessons，本方案处理其余字段 |
| invalidateFreshCache() | 扩展。加入 gitStatusDirty flag 的重置逻辑 |
| buildStableVolatileBlock() | 扩展。加入 heuristicRules 的渲染 |
