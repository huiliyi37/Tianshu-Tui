# 轮间首请求 cacheCreate 最高收益优化：append-only 增量附录

> 2026-06-19 | deep-brainstorm 三轮演化结论 | 源文档：`2026-06-19-轮间首请求-cacheCreate-12K-根因分析与优化方向.md`
> 约束：不考虑实现成本，取最高收益方向并给出落地路径。

## 背景

每个用户新消息的首请求（turn=0）cacheCreate 恒定 ~12K，不随上下文增长。源文档归因为「dynamic appendix 全量重建」，给出三方向（收紧预算 / 拆独立消息 / 增量重建），建议先做最简单的方向 1。

本设计在三轮演化分析 + 两路调研（本仓库机制 + 外部工程实践）后，**改写了源文档的判断**，选定方向 3（增量）为最高收益方案，并把它从"高风险"重估为"中风险"。

## 调研校准的两个关键事实

1. **frozen snapshot 存的是含 appendix 的完整 merged**（`engine.ts:356-380`，尤其 360-368、377）。
   - 推论：上一轮的 appendix 已经在缓存历史里命中。每轮全量重发，约 8-10K 是**重发模型已缓存的内容**——纯浪费。
   - 源文档"12K 是 exact-prefix 物理必然"只对一半：新 user message 是真 miss（地板，~几百 token），但绑在它后面的 12K appendix 不是必然。

2. **外部主流框架无人每轮全量重建大块塞尾部**（Claude Code 每会话 memoize 一次 / aider 只发 diff hunk / Manus append-only + 大块外置引用 + 指令 supersede）。这正是被点名的反模式。

## 方案对比（三轮演化结论）

| 方案 | 机制 | 收益 | 致命问题 | 结论 |
|------|------|------|----------|------|
| V1 收紧预算常量 | 48K→24K，GWT 丢低 salience 块 | ~50%（12K→6K），上限低 | 降到 6K 开始丢 git-status，影响行为 | 降级为兜底/二级保护 |
| V2 拆独立消息 | appendix 移出 user message | **≈0** | frozen 机制下历史 user message 本就 byte-identical 命中，当前轮无论内外都是新 miss；收益建立在误解上 | **灭绝** |
| **V3 增量附录** | append-only delta + supersede，旧块留 frozen 历史命中 | **最高**（趋近地板，普通轮 1-3K） | stale 累积（可治理） | **采纳** |
| V4 提升稳定块 | 把分类后稳定块移到 prefix 区 | 中（部分被 V3 覆盖） | consolidatedBlock 变更同样花 cacheCreate，对每轮变的块无效 | 价值并入 V3 |
| V5 大块外置 artifact | git/tool-history 写盘，appendix 留指针 | 反目标 | 模型每轮要主动读→增工具往返→抬高总延迟 | 灭绝（细节并入 V3） |

**核心真相（多方案收敛）**：每轮重发模型已缓存的内容是纯浪费。

## 最终方案：append-only 增量附录

把 `<context-update>` 从「每轮全量重建」改为「append-only delta 流」：

```
[user_turn_N   = vb + consolidated + --- + userMsg_N + <context-update seq=N>仅本轮变化的子块 + tombstone</context-update>]
```

- 旧 appendix 已在 frozen 历史里（缓存命中），模型靠读历史 context-update 链补全完整上下文。
- 本轮只发 changed/new 子块 + 消失块的 `<context-removed name=.../>` tombstone。
- `seq` 号 + supersede 语义：后出现的同名块覆盖先前的；未出现=未变。

### 为什么风险比源文档说的低（最强适应点）

源文档说方向 3「需重构成增量 diff、与 frozen 机制复杂交互、易引入缓存不一致 bug」。**但 frozen-snapshot 本身就是 append-only**：delta 块照常 merge 进 user message、照常写 `frozenUserMerged`、历史检索仍 byte-identical 命中。**frozen 机制零改动**。这把"高风险"降为"中风险"。

### 复用的既有基础设施（扩展适应）

- `frozenUserMerged` append-only 性质 → delta 块照常 freeze，历史命中不变。
- `gitDirty` / `refreshGit`（`engine.ts:292-298`）→ git-status 子块只在 commit 后内容变，diff 天然只在 commit 轮重发它（吸收 V5：平时不发=隐式引用旧值）。
- GWT salience（`volatile.ts:466-602`）→ delta 内仍按 salience 排序，预算保护不丢。
- 分类后稳定块（task-depth / plan-methodology）→ delta 下自动只发一次（吸收 V4）。

## 实施路径

### Phase 1：结构化 + diff（开关默认关）
1. `volatile.ts`：拆出 `buildDynamicAppendixParts(ctx, maxChars): {name, content}[]`（GWT 选完后返回带 tag name 的块）；`buildDynamicAppendix` 改为薄包装，保持现有全量行为。
2. `engine.ts`：新增 `lastEmittedParts: Map<string,string>` + 单调 `appendixSeq`。在 fresh 路径（`engine.ts:278-355`）对 parts 做 diff：changed/new 收入、上轮有本轮无→tombstone、unchanged→跳过。包成 `<context-update seq=N mode=delta>`；全无变化→`<context-update seq=N/>` 空块。
3. 静态(frozen)提示挂一句 supersede 语义说明（稳定、进缓存）："context-update 块是累积的；后出现的同名子块覆盖先前的；未出现表示未变。"
4. `RIVET_APPENDIX_DELTA` 开关，默认关。

- **成功标准**：开关开，新会话 cache-log 轮间首请求 cacheCreate 从 ~12K → <4K（非 commit 轮）；恒等式 `input=cacheRead+cacheCreate` 成立。
- **退出条件**：frozen 历史命中率掉 >5pp（delta 进 frozen 出一致性问题）→ 回退全量。

### Phase 2：stale 治理 + 边界
1. compaction / `historyRewritten` / frozen anchor 变 → 重置 `lastEmittedParts`，强制下轮全量 baseline。
2. tombstone + seq 验证模型不读旧 git-status / 旧 progress。

- **成功标准**：压缩后首轮自动发全量 baseline；人工核验模型引用的是最新 git/progress。
- **退出条件**：模型引用过期状态 → 缩短 baseline 重发周期（每 N 轮强制全量）。

### Phase 3：灰度放量 + 清理
1. 默认开启 delta，观察整体命中率与行为。
2. 稳定后把 `appendixMaxChars` 收紧作为 delta 的二级保护（吸收 V1）。

- **成功标准**：整体命中率 ≥ 改前，无行为退化，轮间 cacheCreate 中位数 <3K。
- **退出条件**：行为退化 → 保留 delta 但调高 baseline 重发频率。

## 风险与应对

| 脆弱点 | 应对 |
|--------|------|
| stale 累积（模型读旧 git-status） | seq 号 + 静态提示 supersede 说明 + tombstone + 压缩边界强制 baseline |
| 模型不懂 delta 语义 | 静态提示一句话说明 + 灰度开关随时回退全量 |
| 首轮 / 压缩后无 lastEmitted | 自动 fallback 全量 baseline（天然处理，无需额外逻辑） |
| delta 块进 frozen 一致性 | frozen 机制零改动，delta 块照常 freeze；退出条件监控命中率 |

## 验证方法

1. 改动后新会话观察 `.rivet/sessions/<id>/cache-log.jsonl` 轮间首请求 cacheCreate。
2. 恒等式 `input = cacheRead + cacheCreate` 确认量纲。
3. 对比改前后同等工作量整体命中率（不应下降）。
4. 人工核验模型在 commit 后引用的是最新 git-status，未引用 stale 状态。
5. 监控 `frozenClamped` / `frozenEvicted` breadcrumb，确认 delta 未触发异常 eviction。

## 参考文件

- `src/prompt/engine.ts:278-380` — 新用户边界 + trailer 合并 + frozen snapshot（delta 注入点）
- `src/prompt/engine.ts:292-298` — gitDirty / refreshGit（git-status 事件门控复用）
- `src/prompt/volatile.ts:302-476` — buildDynamicAppendix（拆结构化的目标）
- `src/prompt/volatile.ts:466-602` — GWT salience / selectTopKBlocks
- `src/agent/loop-factory.ts:48-109` — cache-log 写入（验证数据源）
- 调研子代理：[缓存与快照机制梳理](50151b6b-1150-43b4-b121-df606d4989b6) / [prefix cache 外部工程实践](887b89aa-810e-4cad-9744-7606ff18ad1f)
