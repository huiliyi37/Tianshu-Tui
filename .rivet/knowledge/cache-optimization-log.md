# 缓存优化变更日志

> 每项缓存相关改动在此登记：基线 → 预期 → 实施 → 实测。对比前后 `cache-log.jsonl` 数据，不做盲改。
> 基线来源：`analysis-user-boundary-cache-ceiling.md`（2026-06-17）
> 关联：`debug-t7-collapse-cache-cliff.md`（T7 阈值修复，非本线）

## 约定

- **数据来源**：`.rivet/sessions/{sid}/cache-log.jsonl`，逐 API 请求一条，取 provider 实回 `usage.prompt_tokens_details`
- **命中率**：`cacheRead / (cacheRead + cacheCreate)`，用 `input = cache_read + cache_create` 自检量纲
- **user 边界**：每个 turn 的首请求（`turnIndex` 跳变后的第一条）
- **轮内**：同一 turn 内的 tool-loop 请求
- **变更条目**：每次改动一条 entry，记录 commit、改了什么、预期影响、实测数据

---

## Entry #0 — 基线（未改动）

**日期**：2026-06-17
**commit**：`a80c250e`（T7 阈值修复，非本线变更）
**状态**：快照，无代码变更

### 字节布局（engine.ts:322-330）

```
merged = volatileBlock(frozen) + '\n---\n' + userContent(每轮新) + '\n\n' + cachedAppendix
cachedAppendix = [projection, consolidatedBlock, activeAppendix]
```

userContent 每轮新 → 从 userContent 首个变字节起，后续全部 miss（含整段 appendix）。

### 实测数据（跨 4 会话，deepseek-v4-pro + glm-5.2）

| 指标 | user 边界 | 轮内 tool-loop |
|------|----------|---------------|
| 命中率中位 | 91–96% | 99.8% |
| cacheCreate 中位 | ~11K tokens | ~0.1–0.5K tokens |
| ≥99% 占比 | 0 个 | 绝大多数 |

### appendix 构成（~11–12K chars，1M 窗口下 maxChars=48K chars）

| 块 | salience | 刷新频率 | 预估 chars |
|----|---------|---------|-----------|
| star-domain | 1.0 | 会话级不变 | ~2K |
| plan-mode | 0.95 | plan 模式才有 | ~1.5K |
| historical-lessons | 0.8 | 每轮可能变 | ~0.5K |
| progress (session-state + task + decisions) | 0.8 | 每轮变 | ~1.5K |
| active-plan-pointer | 0.8 | 低频 | ~0.2K |
| git-status / recent-commits | 0.7 | commit 才变 | ~1.5K |
| tool-context (theta+EFE) | 0.7 | 每轮变 | ~0.5K |
| intent-retrieval-route | 0.7 | 每轮变 | ~0.5K |
| task-depth / plan-methodology | 0.7 | 低频 | ~0.3K |
| tool-history | 0.5 | 每轮变 | ~1K |
| cross-session-memory / mentions | 0.4–0.8 | 低频 | ~0.5K |
| companion-presence | 0.4 | 低频 | ~0.2K |
| harness-advisory / worktree-warning | 0.7 | 条件触发 | ~0.3K |
| read-file-dedup-hint | 0.3 | 增量变 | ~0.3K |
| cognitive-projection (sycophancy+yaoguang) | — | 每轮变 | ~0.5K |

### 受限方向速查

| 方向 | 做法 | 致命问题 |
|------|------|---------|
| appendix 内部排序优化 | 改 `selectTopKBlocks` 让低频块排前面 | 无效——appendix 整块在 userContent 之后，从 userContent 起就 miss |
| 块移入 frozen volatileBlock | 会话不变块进 `buildStableVolatileBlock` | killer #5：frozen 字节变 → system prefix 全失效（5-20% 持续掉） |

---

## Entry #2.1 — 基线实测（当前 deepseek 会话，改前）

**日期**：2026-06-17
**commit**：`a80c250e`（T7 阈值修复，引擎未变）
**数据来源**：`.rivet/cache-log.jsonl`（项目根，1206 行，跨 58 会话），取最新 deepseek 会话（8 turns，22 API 请求）
**状态**：实测，无代码变更

### 会话特征

- 模型：deepseek（有 prefix cache — cacheRead > 0 区分于 GLM 会话）
- 会话长度：8 turns（turn 0–7），22 次 API 请求
- turn 内 tool-loop 数：1–5 次/轮

### 实测数据

| 指标 | user 边界 | 轮内 tool-loop |
|------|----------|---------------|
| 命中率中位 | 96.7–97.0% | 99.2% |
| 命中率范围 | 88.9–99.9% | 78.9–99.9% |
| cacheCreate 中位 | ~5.2K tokens | ~1.4K tokens |
| ≥99% 占比 | 25%（2/8） | 57%（8/14） |

### 逐 turn user 边界明细

| turn | input tokens | cacheRead | cacheCreate | hitRate |
|------|-------------|-----------|-------------|---------|
| 0 | 157,430 | 152,192 | 5,238 | 96.7% |
| 1 | 158,124 | 157,824 | 300 | 99.8% |
| 2 | 159,656 | 159,488 | 168 | 99.9% |
| 3 | 160,442 | 160,256 | 186 | 99.9% |
| 4 | 167,016 | 166,784 | 232 | 99.9% |
| 5 | 167,175 | 167,040 | 135 | 99.9% |
| 6 | 167,667 | 167,168 | 499 | 99.7% |
| 7 | 172,693 | 167,936 | 4,757 | 97.2% |

> turn 0 cacheCreate ~5.2K 是 appendix 首次出现的 miss。
> turn 1–6 cacheCreate ~150–500 说明消息历史前缀几乎全命中，只有最新 tool result 是新字节。
> turn 7 cacheCreate 回升到 ~4.8K，可能是上下文增长触发轻度压缩。
> turn 0 之后的 8 个边界中只有 2 个 ≥99%（turn 2 和 turn 4），其余在 96.7–99.9% 之间。与分析文档的"user 边界 0 个 ≥99%"不完全一致——本会话较短（8 turns），历史前缀体量小，部分边界仍能到 99%+。

---

## Entry #2.2 — consolidatedBlock 前置

**日期**：2026-06-17
**commit**：（待提交）
**方案**：consolidatedBlock 从 cachedAppendix 中拆出，放到 userContent 之前，与 volatileBlock 相邻
**改动文件**：`src/prompt/engine.ts`（+12/-8 行）
**预期影响**：稳定块（star-domain、稳定的 playbookLessons）进入前缀缓存，user 边界 cacheCreate 降低 ~3-4K tokens

### 改动描述

新增 `cachedConsolidated` 字段，与 `cachedAppendix` 平行管理。在 tracker 路径下，`consolidatedBlock` 不再嵌入 `cachedAppendix` 尾部，而是单独存入 `cachedConsolidated`。在 merge 时，`cachedConsolidated` 被插入到 `volatileBlock` 和 `userContent` 之间。

### 字节布局变化

```
改前: volatileBlock + '\n---\n' + userContent + '\n\n' + [projection, consolidatedBlock, activeAppendix]
改后: volatileBlock + '\n' + consolidatedBlock + '\n---\n' + userContent + '\n\n' + [projection, activeAppendix]
```

consolidatedBlock 为空时（tracker 未激活或未提升）→ 行为完全不变，无额外字节。

### 改动点清单

1. 新增 `private cachedConsolidated: string = ''` 字段
2. tracker 路径：`this.cachedConsolidated = this.consolidatedBlock`，`fullAppendix` 中移除 `this.consolidatedBlock`
3. 非 tracker 路径：`this.cachedConsolidated = this.consolidatedBlock`（恒为 ''）
4. merge 逻辑：`volatileBlock → cachedConsolidated → '---' → userContent → cachedAppendix`
5. frozen 快照 eviction fallback 两条路径均包含 cachedConsolidated
6. `invalidateFreshCache()` 同步清除 cachedConsolidated

### 安全分析

| 风险 | 判断 |
|------|------|
| frozen 重建触发（killer #5） | **不触发**。consolidatedBlock 不在 frozen volatileBlock 中，变化只影响当前 user message 前缀，不波及 system prompt |
| consolidatedBlock 首次提升导致一次性断裂 | **是**，但仅一次。tracker 将星域/历史教训提升为 stable 时，下个 user 边界 miss 该块的首次缓存。之后稳定命中 |
| 轮内 tool-loop 缓存 | **不受影响**。cachedConsolidated 与 cachedAppendix 一起在 user 边界重建，轮内复用不变 |
| 非 tracker 路径（habituationThreshold=0） | **零影响**。consolidatedBlock 和 cachedConsolidated 恒为空 |
| frozenUserMerged 兼容 | **兼容**。consolidatedBlock 变化时 merged 变化 → 新快照入队；历史快照保持原格式，getNextFrozen 返回字节一致的旧内容 |

### 实测数据对比

| 指标 | 改前（Entry #2.1） | 改后（Entry #2.2） |
|------|-------------------|-------------------|
| user 边界命中率中位 | 96.7–97.0% | （待本会话积累数据后填入） |
| user 边界 cacheCreate 中位 | ~5.2K tokens | （待填入） |
| 轮内命中率 | 99.2% | （待填入） |

### 结论
（待实测数据后填入）
