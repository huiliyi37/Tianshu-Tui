# 调查报告：1M 窗口压缩与前缀缓存的矛盾

> 调查时间：2026-06-23 | 状态：已验证，原审查部分准确
> 核实时间：2026-06-23 | 核实结论：文档核心断言全部成立；补充了 token 估算口径偏差（第 3 节）、partial compact 无 TaskAnchor 交叉缺口（第 4 节）、测试 P2.1 虚假绿灯根因（第 5 节）、中文会话影响评估（第 6 节）、优先级修订（第 7 节）
> 实现时间：2026-06-23 | 实现状态：P0~P7 全部落地，见第 8 节「实现记录」。提交 `a1731b79` / `cd76b582` / `06cf5ab5`，loop.ts P3 热更新随对方 `87ebf037` 入库。

## 结论

原审查方向正确，但部分过度悲观。1M 窗口的 60%/75% LLM 压缩路径**确实存在**且**不经过** `isCachePreservingProvider` / `shouldDelayCompact` 保护，会打破 anchor 之后的前缀缓存。但 Rivet 已通过 T7 请求时折叠、多级 skip 等机制大幅缓解，且 75% 阈值（750K tokens）在典型会话中较难触发。

**严重程度**：设计不一致为中等，生产影响偏低。

---

## 1. 矛盾的真实面貌

### 1.1 两条互不相通的策略路径

代码里存在两套压缩策略，**互不引用**：

| 维度 | cache-preserving 策略（非 1M） | 1M 专用分支 |
|------|------|------|
| 首次干预 | 72% watch（micro compact） | **60% partial LLM** |
| 重度 compact | 86% compact | **75% full LLM** |
| 紧急 | 95% ceiling | 86% session split → 95% ceiling |
| 保护机制 | `shouldDelayCompact` + `adaptiveCompactPolicyRatios` | 仅 circuit breaker + 消息数门槛 |
| 代码位置 | `context/compact-policy.ts` + `cache/advisor.ts` | `compaction-controller.ts:359-411` |

`compactPolicyRatios` 中 `cache-preserving` 策略的 72%/86% 是为 DeepSeek 专门设计的延迟阈值（`compact/constants.ts:56`），但 1M 分支**完全绕过**了它，用了更激进的 60%/75%。

### 1.2 Gate 条件清单

| Gate | 是否保护 1M 60%/75% |
|------|------|
| `compactEnabled === false` | 是（行 334-336） |
| Circuit breaker（3 次失败 → 停 3 turn） | 是（行 361-366） |
| `primaryClient` 必须存在 | 是（行 369, 380） |
| `isCachePreservingProvider()` | **否** |
| `shouldDelayCompact()` | **否**（仅非 1M 路径使用，行 430） |
| `turn === 0`（用户边界约束） | **否** |
| 消息数 > 66 条（partial 门槛） | 是（行 820-822），但仅限 partial |

### 1.3 60% 和 75% 实际触发条件

- **60-75%**（partial compact）：需要 >66 条消息 + LLM partial 成功。消息数不足时返回 false，**不 fallback 到 full**
- **≥75%**（full compact）：先尝试 partial，失败后走 full `llmCompact` + `replaceWithCheckpoint`。只需 ≥4 条消息

### 1.4 缓存 miss 代价

compact 执行后，`safeReplaceMessages` 使 anchor（前 2 条）之后的前缀**全部失效**。

`prompt/engine.ts:564-576` 注释实测：T7 full pass 误触发时单次请求 cache miss 重建约 240K tokens（~0.71 元）。full compact 后的重建代价更高（整个历史被替换）。

---

## 2. 已有的缓解措施

开发者已意识到矛盾，实现了多层减压：

| 机制 | 作用 | 位置 |
|------|------|------|
| **T7 请求时折叠** | 不改 session 存储，50% 轻量、85% 全量折叠请求副本 | `prompt/engine.ts:540-591` |
| **跳过 micro compact** | 1M 不走 micro 路径（注释："skip micro compact"） | `compaction-controller.ts:350` |
| **跳过 stale-round** | 1M 不做陈旧轮截断 | `compact-boundary-coordinator.ts:117` |
| **DeepSeek 跳过 T9** | T9 质量 partial compact 被 `isCachePreservingProvider` 阻止 | `compact-boundary-coordinator.ts:90-93` |
| **跳过 observation mask/prune/dedup** | 1M+ 不 mutate 历史消息 | `prompt/engine.ts:447-489` |
| **CACHE_ANCHOR_MESSAGES=2** | compact/split 保留前 2 条 | `constants.ts:110`; `replaceWithCheckpoint:779-781` |
| **partial 保留 recent 60 条** | 只摘要 old zone，近期消息完整保留 | `tryPartialCompact:815-902` |
| **shouldDelayCompact** | 非 1M 路径 + 1M heap 非压力场景有保护 | `cache/advisor.ts:79-102` |

T7 请求时折叠是主要减压阀——它在 50-85% 区间用**不改存储**的方式减压，让存储层 compact 延后触发。

> **核实补充**：T7 的 `COLLAPSE_FLOOR_FILL_RATIO` gate 不是用 `session.getEstimatedTokens()`（session 层），而是用 `estChars / 4` 重新估算（含 `reasoning_content`，`engine.ts:548-558`）。这两套 token 估算口径不同——详见第 3.1 节。这使得 T7 的触发时机与 maybeCompact 的 ratio 计算存在系统性偏差，但不影响 issue 1 的核心结论。

---

## 3. 两套 token 估算口径的系统性偏差

`maybeCompact` 与 T7 折叠使用**完全不同的 token 估算方法**，对同一个会话可能给出显著差异的 fillRatio：

| 维度 | T7 折叠（`engine.ts:548-558`） | maybeCompact（`context.ts:331-333`） |
|------|---|---|
| 估算方法 | `m.content.length + m.reasoning_content.length`，统一 `/4` | `estimateOaiMessageTokens`：CJK `/1.2`，ASCII `/4` |
| 前缀开销 | **不含** prefixOverhead | 含 `prefixOverhead`（system prompt + tool schema） |
| 校准 | **无** | 乘 `contextCalibrationRatio`（用最近一轮 API 真实 prompt_tokens 校准） |
| tool_calls | **不计** | 含 `JSON.stringify(msg.tool_calls)` |

**关键影响**：对**中文会话**，偏差远超预期。CJK 字符在 T7 按 `1/4 = 0.25 token`，session 按 `1/1.2 ≈ 0.83 token`——同一个中文字，session 估值是 T7 的 **3.3 倍**。这意味着：

- 中文 agent 会话中，session 层的 compact 阈值会远先于 T7 折叠被触发
- T7 折叠作为"主要减压阀"的作用在中文会话中被大幅削弱
- 两个子系统的决策不协调：maybeCompact 认为"58% 不触发"时，T7 可能认为"65% 开始折叠"——反之亦然
- 加上 `contextCalibrationRatio` 的放大效应，偏差可进一步放大

**含义**：如果要统一决策路径（改进方向 1），必须**先统一 token 估算口径**。最小修复：T7 的 `estChars` 累积改用 `estimateOaiTokens(result)` 复用 CJK 感知估算。

---

## 4. partial compact 不注入 TaskAnchor（issue 1 × issue 2 交叉点）

`tryPartialCompact` 成功后仅调 `safeReplaceMessages` + `resetAppendixBaseline` + `refreshLedger`（行 902-905），**不调 `buildTaskAnchorAppendix`**。对比 `replaceWithCheckpoint`（full compact / session split 路径）会注入 task-anchor（行 787-793）。

**后果**：如果 partial compact 的 LLM 摘要丢失了 constraints/scope 信息，**没有确定性后备来补救**——recent 60 条消息可能不包含原始约束声明。这是 issue 1（缓存矛盾）和 issue 2（摘要质量）的交叉缺口。

---

## 5. 文档与测试漂移

代码已演化，但文档和测试未跟上：

- **测试 P2.1 虚假绿灯**：`P2.1: skips compaction on 1M+`（`compaction-controller.test.ts:191-234`）注释写"regular compaction permanently disabled"，但 `makeController` 默认不含 `primaryClient`（`test:21-32`），测试也未 override。60%/75% 分支的 `this.deps.primaryClient` 为 `undefined` → 两个 `if` 直接跳过 → 返回 `compacted: false`。**测试通过是因为走不进分支，不是因为代码正确跳过了 compact**。这是虚假安全感——后续任何 compact 逻辑改动都可能因为这个测试"通过了"而漏掉回归。
- `CLAUDE.md:59`："1M 窗口跳过/延迟一切重写；shouldDelayCompact 在缓存健康时不压"——对 1M maybeCompact LLM 路径不准确
- `docs/superpowers/baselines/2026-05-26-cache-hit-rate-baseline.md:123`："1M+ skip regular compaction"——已不准确

---

## 6. 严重程度评估（含核实修正）

| 维度 | 评级 | 理由 |
|------|------|------|
| 设计一致性 | **中** | 1M 分支与 cache-preserving 策略、shouldDelayCompact、文档三方不一致 |
| 典型会话影响（英文） | **低** | 750K token 门槛极高；T7 在 50-85% 区间用请求时折叠减压 |
| 典型会话影响（中文） | **低~中** | T7 的 `chars/4` 对 CJK 低估 3.3 倍，折叠几乎不触发，session 层 compact 成为事实上的唯一减压阀 |
| 极端长会话 | **中高** | 越过 75% + 66+ 消息 → 存储层 LLM compact 触发，anchor 后 prefix 全 miss |
| partial compact 无 TaskAnchor | **中高** | issue 1 × issue 2 交叉缺口，LLM 摘要丢 constraints 后无确定性后备 |
| 测试 P2.1 虚假绿灯 | **高（基础设施）** | 当前测试不覆盖 60%/75% 分支，后续改动无回归保护 |
| 紧急路径 | **可接受** | 86% split / 95% ceiling 有意接受 cache break，避免 API 溢出 |

---

## 7. 改进方向（含核实后优先级修订）

综合调查发现和逐条核实，按依赖关系排序：

1. **P0：修测试 P2.1 的虚假绿灯**（前置条件）
   不改生产逻辑，只改测试——给 `makeController` 传 mock `primaryClient`，让 60%/75% 分支真正被走到，断言 partial compact 确实触发。后续所有 compact 改动才有正确的回归保护。

2. **P1：partial compact 路径注入 TaskAnchor**
   在 `tryPartialCompact` 的 `safeReplaceMessages` 之后加 `buildTaskAnchorAppendix()` 调用。一行代码，补上 issue 1 × issue 2 交叉缺口的确定性保护。

3. **P2：1M 路径加 `isCachePreservingProvider` gate**
   对齐方向 1——1M + exact-prefix provider 时，把 60%/75% 提升到 72%/86%，或至少接入 `shouldDelayCompact`。

4. **P3：maybeCompact / partial persist memory + 热更新**
   issue 2 的 P0，但比 P0-P2 复杂，涉及 memory block 的 prompt 注入时机。**执行顺序陷阱**：`persistExtractedMemories` 内部调 `extractSessionMemories(this.deps.session.getMessages())`——必须在 `safeReplaceMessages` **之前**调用才有意义（`enforceContextCeiling` 已遵循此顺序：行 517 persist → 行 527 replace）。

5. **P4：统一 token 估算口径**
   两套 token 估算口径是"统一决策路径"方向的技术前提。最小修复：T7 的 `estChars` 累积改用 `estimateOaiTokens(result)` 复用 CJK 感知估算。

6. **用户边界约束**：1M LLM compact 限制在 `turn === 0`（与 stale-round/heap 策略一致）
7. **文档同步**：更新 `CLAUDE.md`、baseline 文档，反映 Phase 2 LLM compact 路径的真实行为
8. **监控**：compact 触发时记录 cache advisor 的 hitRate 和 protection 值，用于事后分析 compact 是否必要

---

## 8. 实现记录（2026-06-23）

P0~P7 全部落地，分三次提交。下表为方向 → 实现的对照。

| 项 | 状态 | 实现摘要 | 落点 | 提交 |
|----|------|---------|------|------|
| **P0** 修测试 P2.1 虚假绿灯 | ✅ | 原测试无 `primaryClient`，60%/75% 分支从未走到。重写为带 mock client 的「消息不足 → 不 compact」，并加 P2.1b（真正触发 partial）、P2.1c（cache-hot 延迟）、P2.1d（注入 anchor） | `compaction-controller.test.ts` | `a1731b79` |
| **P1** partial 注入 TaskAnchor | ✅ | `tryPartialCompact` 在 `safeReplaceMessages` 后追加 `buildTaskAnchorAppendix()`，对齐 `replaceWithCheckpoint` | `compaction-controller.ts:tryPartialCompact` | `a1731b79` |
| **P2** 1M 路径接入缓存保护 | ✅ | **未改阈值**（改 86% 会与 `trySessionSplit` 撞车）。改为 60%/75% 分支接入 `isCachePreservingProvider() && cacheAdvisor.shouldDelayCompact(tier)`，与非 1M 路径(L430) 统一 | `compaction-controller.ts:maybeCompact` | `a1731b79` |
| **P3** persist memory + 热更新 | ✅ | persist 在 replace 前（partial）/ llmCompact 后（full，保护压缩请求自身 prefix cache）。热更新：`persistMemories` 回调追加 `updateSessionMemory(buildMemoryBlock())`，复用既有 `rebuildFrozenBase` 机制（延迟到 user 边界，cache-safe） | `loop.ts` 回调 + `compaction-controller.ts` 时序 | loop 部分随 `87ebf037`；时序 `cd76b582` |
| **P4** 统一 token 估算口径 | ✅ | T7 手工 `chars/4` 改用 `estimateOaiTokens(result)`（CJK 感知 cjk/1.2 + tool_calls），消除中文会话 ~3.3× 低估 | `engine.ts` T7 块 | `a1731b79` |
| 用户边界约束 | ⏸️ 未做 | 1M LLM compact 限制 `turn===0`——当前靠 `shouldDelayCompact` 缓解，未单独加 turn gate | — | — |
| 文档同步 | ⏸️ 部分 | 本文件已更新；`CLAUDE.md` / baseline 文档仍待改 | — | — |
| 监控 | ⏸️ 未做 | 对方 `095757f0 feat(observability)` 已加 cache 影响归因，部分覆盖 | — | — |

### 实现中的发现 / 与方向的偏差

- **P2 没按字面改阈值**：调度器 `runCompaction` 先调 `trySessionSplit`(86%) 再 `maybeCompact`(60%/75%)，把 full compact 提到 86% 会与 split 撞车。改为接入 `shouldDelayCompact`（方向 1 的备选项），既保护缓存又不破坏调度。75%+ 压力下 `protection = hitRate×(1−0.75) ≤ 0.25 < 0.45`，gate 自然很少拦截——只在 75-80% 且缓存极热时延迟，符合预期。
- **P3 时序拆成两处**：partial 的 LLM 请求在 persist 前已完成，persist 放 `safeReplaceMessages` 前即可；full 的 `llmCompact` 在 persist 后才发，故 persist 移到 `llmCompact` 之后、`replaceWithCheckpoint` 之前——否则热更新的 `rebuildFrozenBase` 会破坏压缩请求自身的 prefix cache 复用。
- **P3 热更新无需新接口**：`PromptEngine.updateSessionMemory`/`rebuildFrozenBase`/`sessionMemoryOverride` 已存在（`/remember` 用），直接复用。
- **测试 P1.2 预存失败**：与本次无关，经干净 HEAD（`ff0a8ad7`）复现确认，是 128K 路径 micro compact 行为 vs 测试期望的预存不一致。

### 验证

- `compaction-controller.test.ts`：38 pass / 1 fail（P1.2 预存）
- `full-collapse-threshold.test.ts`（T7）：4/4
- typecheck：改动文件零新错误（`findSafeSplitPoint:66/72` 两个 TS2352 为预存 OaiMessage union cast）

---

## 涉及文件

- `src/agent/compaction-controller.ts` — 1M 专用分支（359-411）、tryPartialCompact（815-912）、llmCompact（922-995）
- `src/agent/compact-boundary-coordinator.ts` — isCachePreservingProvider 保护点（93）、stale-round 跳过（117）
- `src/compact/constants.ts` — cache-preserving ratios（52-63）、summaryOutputBudgetChars（128-132）
- `src/cache/advisor.ts` — shouldDelayCompact（79-102）
- `src/context/compact-policy.ts` — decideCompactTier（40-47）
- `src/prompt/engine.ts` — T7 请求时折叠（540-591）、1M 跳过 prune/mask（447-489）

---

## 9. 后续：分层归档召回压缩（2026-06-23）

P0~P4 解决的是「压缩何时触发、触发时保不保缓存」。但本文档核心矛盾的另一半——**压缩真发生时历史被一次性丢弃且不可恢复**（JSONL atomic 覆盖）——P0~P4 未触及。长线程（几百轮）里模型只能靠有损 LLM 摘要转述，反复"失忆"。

按 plan「分层归档召回压缩」实现**三层上下文 + 按需召回**，把"保缓存 vs 防失忆"从二选一变为兼得：

| 维度 | 实现 | 缓存安全性 |
|------|------|-----------|
| **归档**（Cold） | 被压的 oldZone/discarded 序列化为 `compact-history` artifact 写盘 | 只写磁盘，完全不碰 prompt 前缀 |
| **引用注入**（Warm） | `[artifact:id]` + turn→行目录嵌进本就新写的 summary/checkpoint 消息 | 不影响 anchor 前缀 |
| **召回**（Hot） | 模型 `read_section(id, L范围)` 取原文，作为尾部 tool result | 前缀缓存完整保留 |

**关键决策**：因为归档/引用/召回都不动 anchor 前缀，**可以继续为 DeepSeek 推迟压缩（P2 的 cache-preserving 策略不变）**，压缩真发生时也不再丢历史。这消解了本文档标题的"矛盾"——不再需要在缓存与记忆间权衡。

| 项 | 落点 | 缓存关联 |
|----|------|---------|
| 序列化（固定分隔头 `--- turn:N role:ROLE ---`，section 按消息切） | `compact-archive.ts`（新） | — |
| `archiveDiscardedHistory` fail-soft 归档 + 引用块 | `compaction-controller.ts` | 归档失败不阻断压缩 |
| `tryPartialCompact` / `replaceWithCheckpoint`(async) 归档被丢历史 | `compaction-controller.ts` | 断言前两条 anchor 字节不变 |
| **T7 请求层折叠保留 `[artifact:id]`** | `context-collapse.ts` | 消除请求层折叠召回盲区（本文档第 3 节 T7 的延伸） |
| `safeReplaceMessages` 单点接 pre-compact JSONL 快照 | `compaction-controller.ts` + `loop.ts` | 灾备，独立于召回 |
| 召回观测（次数/turn 距离，observe-only） | `cache/recall-metrics.ts`（新）+ `advisor.ts` | 不反馈调节阈值 |

**与 T7 的分层定位**（本文档第 3 节的收口）：存储层压缩（永久）归档 oldZone；请求层 T7（临时、不改存储）现也保留已有 `[artifact:id]`，使两层折叠都可召回。未在请求热路径做 `save()`（避免 `buildOaiRequest` 每轮异步写盘竞态）——无引用的小结果其存储原文完整，fillRatio 回落自然恢复，符合 T7 既有契约。

验证：`compact-archive.test.ts` 13、`recall-metrics.test.ts`、controller 集成 4（归档+引用 / ceiling 归档 / fail-soft / 快照）、read-section 召回 2、context-collapse T7 保留引用 3；`src/compact` 全套 98 通过。

---

## 10. 收口：分层归档召回 A 期硬化（2026-06-23）

第 9 节落地后留三处未闭合，使特性在目标场景（几百轮 `single_long`）名存实亡。A 期补完：

**A1 — 召回"回不来"准 bug（最高优先）。** 双重失败：`read-section.ts` 对 raw `>2MB` 整体拒绝，且 `store.ts` 的 `readRaw` 把整文件读进内存再切。几百轮的 `compact-history` 必然超 2MB —— 摘要里嵌了目录，`read_section` 却拉不回原文，第 9 节的"召回"形同空头支票。修法：

- `store.ts` 新增 `readLineRange(id, start, end)`：`createReadStream + readline` 逐行流式只读所需区间，越过窗口即 break，**不整文件入内存**；返回 `{ content, totalLines, capped }`。权衡：范围读无法做整文件 SHA-256，**冷归档跳过校验、以可读性优先**。
- `read-section.ts` 加 compact-history 行区间快路径：`tool === COMPACT_HISTORY_TOOL` 且为 `L起-L止` 时走 `readLineRange`、**绕过 2MB 整文件 gate**，输出仍经 `computeModelReadCap` 截断 + 召回标记。char 区间 / 普通 artifact 维持原路径。
- `MAX_RANGE_LINES = 5000` 防单次拉太多（命中返回 cap 提示让模型分页）。

**A2 — 召回观测落地。** 第 9 节的 `recall-metrics` 只有自测调用、无生产消费点，"先观测"空转。`CacheAdvisorDiagnostic` 增 `recall` 字段，`getDiagnostic()` 带上汇总（经 `loop.getDebugInfo()` 可见）；`loop.runPostSession` 写一条 `{ kind:'recall-summary', ... }` 遥测（`RIVET_DEBUG_TELEMETRY` gated）。**只记录不调阈值**——召回率高义本身二义（"压太狠" vs "任务确实要回看早期决策"），攒数据后再议 adaptive-window。

**A3 — recentZone 主动淘汰。** 第 9 节只在序列化 oldZone 时被动折召回块；刚召回、仍留在 recentZone 的大块长期累积会抵消压缩空间。`tryPartialCompact` 算出 recentZone 后，把其中除最近 `RECALL_KEEP_RECENT≈10` 条外的老化召回块（`parseRecallMarker` 命中）就地折成一行指针。保留最近 K 条不折（模型刚拉回的是它当前要的上下文）；原文仍在 artifact，指针可再召回；折叠幂等。

**缓存安全**：A1 只读磁盘；A2 只读诊断/遥测；A3 改写的是压缩本就要替换的 recentZone（压缩已重写该区）—— 均不动 anchor 前缀，P2 的 cache-preserving 策略不变。

验证：`store.test.ts` 范围读 4（>2MB 流式取行 / cap / 越界 total / 未知 null）、`read-section.test.ts` >2MB 召回回归、`recall-metrics.test.ts` `getDiagnostic().recall` 汇总、`compaction-controller.test.ts` `foldAgedRecallBlocks` 4（折老化保最近 K / 非召回不动 / K 内 no-op / 幂等）；4 文件 79 pass。涉及文件：`src/artifact/store.ts`、`src/tools/read-section.ts`、`src/cache/{types,advisor}.ts`、`src/agent/{telemetry-writer,loop,compaction-controller}.ts`。
