# 背景分析:user 边界缓存命中率 ~95% 结构性天花板

> 起点:观察到"几乎没有轮次到缓存命中 99% 以上"。
> 结论:99%+ 一直存在(轮内 tool-loop),没到 99% 的是 **user 边界**(每个 turn 的首请求),它有一个 ~95% 的结构性天花板,由"每轮刷新的认知 appendix 排在每轮变化的用户输入之后"决定。
> 决策(2026-06-17):**维持现状,不动代码**。这 ~5% 损失是常驻认知场的设计税。本文档记录成因与三个优化方向的权衡,供日后真有性能压力时回来决策。
> 关联:`.rivet/knowledge/debug-t7-collapse-cache-cliff.md`(同次排查的前一个问题)。

## 一、现象:99%+ 只在轮内,user 边界从不到 99%

cache-log(`.rivet/sessions/{sid}/cache-log.jsonl`,逐 API 请求一条)跨 4 个会话、跨模型(deepseek-v4-pro + glm-5.2)统计,模式高度一致:

| 请求类型 | 命中率中位 | ≥99% 占比 |
|---|---|---|
| 轮内 tool-loop(turn>0) | **99.8%** | 绝大多数 |
| user 边界(turn 0) | **91–96%** | **0 个** |

TUI 上每个 user turn 展示的命中率基本就是 user 边界值,所以体感"几乎没到 99"。这先于任何近期改动就存在,**不是 bug,不是 T7 阈值修复(a80c250e)引入的**。

## 二、根因:appendix 整块坐在每轮变化的 userContent 之后

`engine.ts:322-330`,最新 user message 的字节组装顺序:

```
merged = volatileBlock(frozen,命中) + '\n---\n' + userContent(本轮输入) 
merged += '\n\n' + cachedAppendix(认知 appendix)
```

字节序列:**frozen volatileBlock(命中) → 本轮 userContent(每轮新字节,miss 起点) → appendix(全 miss)**。

DeepSeek exact-prefix 从第一个变化字节往后全断。`userContent` 每轮是新的用户输入,**从它开始就 miss**,排在其后的 appendix 整块跟着 miss。数据印证:user 边界 cacheCreate **稳定卡在 ~11K**(≈ appendix 体量 + 小段 userContent),不随 assistant 回复长短波动——因为上一轮的 assistant 输出在该轮 tool-loop 末次请求里已发送过、已缓存。

历史轮次的 appendix 不重复 miss:user message 变历史后,其 trailer(含当时 appendix)被 `frozenUserMerged` 冻结,后续命中。每个 user 边界只 miss"最新轮"的 appendix 一次。

## 三、appendix 构成(~11–12K,1M 下 maxChars=48K chars,走 selectTopKBlocks 按 salience 降序)

按刷新频率分类(salience 见 `volatile.ts:542`)。**关键澄清:"会话级不变" ≠ "命中缓存"**——下表所有块(含 consolidatedBlock 路径的稳定块)都物理排在每轮变化的 userContent 之后,因此**每轮都 miss**,无论它内容变不变。"刷新频率"只决定它在相邻轮之间字节是否相同(影响历史轮冻结后的命中),不改变"最新轮整块 miss"。

渲染路径三条(`engine.ts:309-316`,字节顺序:**projection → consolidatedBlock → activeAppendix**):
- **projection**(`buildCognitivePromptProjection`):courage-hook 宪法消息 + 瑶光 afterPerception 门禁,变长 200–600 字符。排最前。
- **consolidatedBlock**(`buildConsolidatedBlock`):被 habituation tracker 判稳后、从 activeCtx 抹掉(`engine.ts:304-306`)的 star-domain / historical-lessons 搬到这里。仅 tracker 路径下存在。
- **activeAppendix**(`buildDynamicAppendix`):下表其余块。

| 块 | salience | 刷新频率 | 渲染路径 |
|---|---|---|---|
| (cognitive projection) | — | 触发时变(200-600字符) | projection |
| star-domain | 1.0 | 会话级**不变** | 判稳前 activeAppendix,判稳后 consolidatedBlock |
| plan-mode | 0.95 | plan 模式才有 | activeAppendix |
| historical-lessons | 0.8 | 每轮可能变(按当轮 query 重选) | 判稳前 activeAppendix,判稳后 consolidatedBlock |
| progress | 0.8 | **每轮变** | activeAppendix |
| active-plan-pointer | 0.8 | 低频(计划定后不变) | activeAppendix |
| mentions | 0.8 | 一次性 | activeAppendix |
| tool-context(theta+EFE) | 0.7 | **每轮变** | activeAppendix |
| git-status / recent-commits | 0.7 | commit 才变 | activeAppendix |
| task-depth / plan-methodology | 0.7 | 低频(任务类型定后不变) | activeAppendix |
| intent-retrieval-route | 0.7 | 每轮变 | activeAppendix |
| plan-execution-trace | 0.7 | 压缩时才刷新 | activeAppendix |
| tool-history | 0.5 | **每轮变** | activeAppendix |
| cross-session | 0.4 | 低频(会话级几乎不变) | activeAppendix |
| companion-presence | 0.4 | 低频(会话级几乎不变) | activeAppendix |
| read-file-dedup-hint | 0.3 | 增量变 | activeAppendix |

**体量修正**:不再给"~11K"这个假精确单值。实际 = activeAppendix 主体 + projection(变长 200-600 字符)+ consolidatedBlock(judging 后)+ **promotion 抖动**——habituation tracker 把某块判稳、`consolidatedBlock` 内容变化的那一轮(`engine.ts:295`),appendix 字节阶跃变化,触发一次额外 miss;稳态下不变。所以 user 边界 miss 是"~11K 稳态 + projection 变长 + promotion 阶跃"的合成,稳态值约 11K 但有结构性抖动。

## 三'、独立成本线:trySessionSplit cold start(非稳态)

user 边界稳态 miss(~11K/turn)之外,还有一条**量级完全不同**的成本线:`compaction-controller.ts:529` `trySessionSplit`——contextWindow ≥ 500K 且占用 ≥ 86% 时触发,`replaceWithCheckpoint` 重建整个 session = 完整 cold start,**全部前缀缓存归零**(百万级 token 一次性 miss)。一次 split 的成本远淹没数十个 user 边界的稳态 miss。本文档主体聚焦稳态;若 split 频繁(长会话反复撞 86%),它才是缓存成本的主导项,而非 user 边界的 11K。第六节"成本超预算"触发条件隐含了它,此处显式记一笔以免误以为 user 边界 miss 是唯一成本。

## 四、被推翻的方案:改 appendix 内部排序(无效)

排查中曾提出"修 `selectTopKBlocks` 让 salience 只管取舍不管顺序,恢复 stable-first 排列,让低频块连续排前面以命中前缀"。**核实 `engine.ts:322-330` 后推翻**:appendix 物理上整块排在每轮变化的 userContent 之后,从 userContent 起就 miss,appendix 内部块怎么排都改变不了"整块 miss"这个事实。stable-first 排序(`volatile.ts:305-308` 注释的本意)在 appendix 作为 userContent 尾部时,对跨 user 边界命中**零收益**——它只在 appendix 能独立对齐起始位置时才有意义,而它对不齐(前面挂着每轮变长的 userContent)。

教训:提缓存优化方案前,先确认目标内容在**字节序列里的物理位置**和它前面有没有每轮变化的内容,而非只看"块内部排序乱不乱"。

## 五、三个真正成立的优化方向(各踩不同的雷)

参照 `docs/superpowers/analysis/2026-05-27-prefix-cache-invariant-registry.md`(8 个 killer + 6 条不变量):

**方向 A — 低频块移进 frozen volatileBlock。** 把会话级不变的块(star-domain 等)移进 frozen 前缀,跨所有轮命中。收益最大,**风险最高**:踩 killer #5——任何一块中途变字节就触发 frozen 重建 → system prefix 全失效(5-20% 持续掉)。只有"绝对 session 常量"够格(star-domain ✓;active-plan-pointer ✗,批准计划后才出现;companion 需确认会话内是否真不变)。

**方向 B(曾推荐)— 缩小 appendix 体量。** 把低频/可按需获取的块(cross-session-memory、available-skills、低频 advisory)移出每轮注入,改 advisory bus 按需投递。不碰 frozen、不拆 message,纯减小每轮 miss 绝对值(11K→~6-7K,天花板 ~95%→~97%)。风险最低。代价:这些认知内容从"常驻"变"按需",与 `[[guardrails-must-be-resident-not-on-demand]]` 原则张力——护栏起作用的时刻正是 agent 没意识到跑偏时(不会主动 recall),所以哪些块能降级为按需必须逐块判断,不能一刀切。

**方向 C(已选)— 维持现状。** ~11K/turn 是常驻认知场的设计税,user 边界 ~95% 是物理天花板(每轮必有新 userContent + 认知刷新)。认知场(projection/advisory/claims/playbook)是天枢本体非 feature(`[[cognitive-pipeline-is-substrate-not-feature]]`),~5% 命中损失换常驻清醒态,当前判定值得。

## 六、当前决策与重启触发条件

**⚠ 决策已更新（2026-06-17）**：原文档"方向 C — 维持现状"已过时。`1044fa1b`（consolidatedBlock 前置）已突破天花板——会话 `ed32f759` 实测 user 边界 p50=99.6%（原 91-96%）、cc p50=634（原 ~11K）、≥99% = 69%（原 0%）。详见 `cache-optimization-log.md` Entry 2.3。

当前状态：consolidatedBlock 前置已生效，剩余 appendix 块（progress/tool-context/tool-history/intent-retrieval-route 等每轮变的块）仍在 userContent 后面，但体量已大幅缩小。进一步优化（方向 B：低频块降级为按需）的边际收益已不大。

**日后回来重新评估的触发条件**（满足任一）：
- 单会话成本因 user 边界 miss 显著超预算（贵档 miss 3 元/M）。
- user 边界 TTFT 延迟成为体感瓶颈。
- appendix 体量因新增认知块继续膨胀（>15K），把天花板压回 95% 以下。

**重新评估时的优先动作**：先做方向 B 的**逐块审计**——量出 appendix 里每块的实际 token，用 `[[guardrails-must-be-resident-not-on-demand]]` 判据逐块判定"必须常驻 vs 可按需"，只降级真正低频且非护栏的块。方向 A 仅对 star-domain 这类铁定 session 常量考虑（已由 consolidatedBlock 前置部分覆盖），且必须先对照 invariant 登记表确认不踩 killer #5。

---

## 七、12K cacheCreate 精确构成拆解（2026-06-19 取证）

> 来源：会话 `mqjrprcfgrhujyr2` 的 `cache-log.jsonl`，10 个 user boundary 样本。

### 7.1 核心等式

每次 user boundary 的 `cacheCreate ≈ input growth`（误差 <200 token，128-token 对齐粒度）。即：老前缀 100% 命中，新增内容 100% 未命中。这是 exact-prefix 缓存的结构性底线——未见过的字节不可能命中。

### 7.2 三大构成

新增内容 = **上轮 assistant 响应** + **新 user message（含 merged trailer）** + **dynamic appendix 刷新**。

| 组分 | 典型占比 | 可压缩？ |
|------|---------|---------|
| **上轮 assistant 响应**（思考链 + 工具调用 + 文本） | ~5–7K（50–65%） | **不可压缩**：上轮 output 变本轮 input，首次出现 |
| **新 user message**（用户输入 + volatile merged） | ~1–3K（10–25%） | **不可压缩**：用户新输入 |
| **dynamic appendix 刷新** | ~2–3K（20–30%） | **部分可优化** |

**结论**：12K 的主体是 assistant 历史响应（~60%），属于对话增量的物理必然，dynamic appendix 只占 ~2–3K。

### 7.3 Dynamic Appendix 子块逐项分析

| 子块 | ~token | 每轮变？ | 优化余地 |
|------|--------|---------|---------|
| `<star-domain>` | ~200 | **会话内不变**（DeepSeek） | ✅ 可立即进 frozen |
| `<historical-lessons>` | ~300 | 缓慢变化（按 query 重选） | ⚠ habituation 已覆盖，可加速 |
| `<progress>` | ~400 | **每轮变** | ✗ 结构性必要 |
| `<tool-history>` 最近 8 条 | ~600 | **每轮变** | ⚠ 可减到 5 条或去重 |
| `<read-file-dedup-hint>` | ~100 | 增量变 | ⚠ 信息密度低，可裁 |
| `<git-status>` + `<recent-commits>` | ~800–1200 | commit 才变 | ⚠ commit 间可提升到 consolidated |
| 各 advisory/hint 块（intent-route, task-depth, plan-methodology, skill, harness） | ~200–500 | 按需变化 | ✗ 多为一次性/低频，体量已小 |

### 7.4 DeepSeek vs 其他模型的策略分化

**核心观察**（用户确认）：DeepSeek 的 star-domain 整个会话几乎不变；其他模型（GLM 等）有 code plan 不在乎缓存，可随意切换。

当前 `FieldHabituationTracker` 对 `activeDomain` 和 `playbookLessons` 做稳定性追踪（`engine.ts:297-327`），连续不变几轮后提升到 `consolidatedBlock`（在 userContent 之前，进入前缀缓存）。但 **promotion 需要 3-5 轮观测才触发**（`promotionThreshold: 0.8`, `decayRate: 0.3`）。

**可行优化**：对 DeepSeek 模型，star-domain 可跳过 habituation 等待期，首轮绑定后直接进 frozen/consolidated。实现方式：
- 方案 a：`engine.ts` 构造 dynamicCtx 时，若 `model.startsWith('deepseek')` 且 `activeDomain` 已绑定且 `sessionDomain !== undefined`，直接把 activeDomain 写入 consolidatedBlock、从 appendix 抹掉。
- 方案 b：`FieldHabituationTracker` 支持 `immediatePromote(fieldName)` 接口，首轮就把 star-domain 标记为 habituated。

**节省量**：~200 token/轮（star-domain 本体），边际收益有限但实现成本也极低。

### 7.5 不动的理由与决策

12K 中 60% 是 assistant 历史响应（不可压缩），20% 是每轮必变的 progress/tool-history（结构性必要），剩余 20%（~2K）中可优化的子块（star-domain ~200t, recent-commits ~800t, read-file-dedup ~100t）加起来 ~1K token。全部优化掉也只是从 12K 降到 ~11K，命中率从 98.6% 提到 ~98.8%。

**决策（2026-06-19）**：star-domain 首轮进 frozen 可作为低成本改进随手做，但不构成优先级。整体 12K user boundary miss 是健康的对话增量，不需要专门治理。
