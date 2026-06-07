# 仓库智能层考古 — 死代码三件套 + 黏菌引擎接线裂缝

- **日期**：2026-06-07
- **性质**：架构考古 + 工程定位规划 / 背景纪要（非实施计划、非审查结论、非修复清单）
- **范围**：`src/repo/`（全项目最老的源码区，2026-05-15 奠基）+ 其在认知本体中的设计弧线
- **结构**：第一部 = 代码事实考古（§1-6）；第二部 = 深层设计意图与给天枢团队的规划判别（§7-13）
- **核查方式**：直接文件读取 + 全仓 grep（code-review-graph MCP 本会话未挂载）+ 6 份关联设计文档交叉验证。下文「活/死」判定均以 grep 调用面为证，已含测试目录复核。
- **未做**：未运行构建与测试套件（用户指示「不用做测试」）。任何「能跑通/通过」类陈述一律未在本会话验证。

> 瑶光纪律备注：本文档区分「设计意图」与「落地现实」。`buildRepoMap` 一项初判为死、复核后纠正为活——见 §4。教训：单次窄域 grep 不足以判死，必须覆盖 tool 注册路径。

---

## 0. 为什么挖这块

考古信号：`src/repo/` 三个文件冻结在 **2026-05-15**，是全项目最老的一批源码；同期 `src/agent/` 爆涨到 185+ 认知模块。典型的「早期奠基的**仓库智能层（repo intelligence）**被后来的认知系统绕过/遗忘」。挖下去得到两组发现。

---

## 1. 死代码三件套（最初的 repo-intelligence 地基）

| 文件 | 行数 | 导出 | 非测试调用者 |
|---|---|---|---|
| `src/repo/symbol-index.ts` | 36 | `buildSymbolIndexFromText` / `SymbolEntry` | **0** |
| `src/repo/import-graph.ts` | 16 | `buildImportEdgesFromText` / `ImportEdge` | **0** |
| `src/repo/context-bundle.ts` | 27 | `buildContextBundle`（依赖 symbol-index） | **0** |

**判定**：纯死代码。三者构成 2026-05-15 最初的「正则抽符号 + 正则抽 import 边 + 拼上下文包」方案，是 repo-intelligence 的第一版地基。后被 SQLite 支撑的 **经脉图（meridian）** 子系统整体取代（`meridian-parser` 取代正则符号抽取，`MeridianDb` 取代内存结构，`buildRepoMap` 取代 `buildContextBundle`）。旧地基从未删除，悬挂至今，仅有自身的 `__tests__` 在引用。

**链接**：与记忆 [[reference_rivet-codebase-index]] 的模块演进一致；属 [[feedback_dead-metaphor-renaming]] 的同类——功能自洽的遗留物，删除有 git blame 成本，但此处是真死（零生产引用），可安全清理。

---

## 2. 黏菌引擎（Physarum Engine）— 架构本身相当精妙

`src/repo/physarum-engine.ts`（301 行）+ `physarum-types.ts`。一套生物启发的自适应代码图谱，把四类机制叠在一起：

| 机制 | 出处 | 作用 | 代码位置 |
|---|---|---|---|
| 电导演化 `growthRate · flow^γ`（γ=1.2，>1 即赢者通吃） | 黏菌 *Physarum polycephalum* | 共访文件边随访问频率增强 | `evolveEdge` L71-88 |
| 指数衰减 τ_short=50 / τ_long=500 回合 | 突触短/长时记忆 | 不用的边遗忘；巩固边慢忘 | `evolveEdge` L78-82 |
| STDP 方向学习（LTP/LTD） | 脉冲时序依赖可塑性 | 「先改 A 后改 B」→ 强化 A→B 方向 | `recordSequentialEdit` L55-68 |
| 稳态缩放 synapticBudget=10 | 稳态可塑性 | 单节点出边总权重封顶，防 hub 吞图 | `applyHomeostaticScaling` L118-135 |
| 泛在惩罚 ubiquityThreshold=0.3 | 图版 TF-IDF | 连太多节点的「万能 hub」降权 | `applyUbiquityPenalty` L138-162 |
| SOC 雪崩临界 | 自组织临界 | 由雪崩尺寸分布判 sub/critical/super | `getCriticality` L172-182 |

**设计意图与 Rivet 本愿完美契合**：`predictNext()`（L272）用学到的 STDP 方向预测下一个要碰的文件 → 服务于 DeepSeek prefix cache 预热。这是教科书级的「行为学习驱动缓存预测」。持久化到 `MeridianDb.physarum_edges` 表，跨 session 复用（`save`/`loadFromDb` L288-300）。

---

## 3. 接线现实 — 一个「活着但接错本职」的器官

引擎**不是死代码**：它经 `immune-hook.ts` 通道活跃运行，但跑的是「免疫异常检测」旁路，**而非**其名义本职「缓存预测」。三处裂缝：

### 裂缝 ① `recordFlow(ctx.toolName, ctx.targetFile, …)` — 喂错了第一个参数
`immune-hook.ts:65` 把**工具名**（`read_file`/`edit_file`/`write_file`）当成 `fileA` 喂入。但 `recordFlow(fileA, fileB, turn)`（`physarum-engine.ts:33`）期望**两个文件**构成一条共访边。后果：整张黏菌图退化成「约 5 个工具名」为中心的星形拓扑，而非设计意图里的文件↔文件共访图。所有 growth/decay/ubiquity 数学都在算工具名之间的边——**数学正确，喂的数据维度错了**。

### 裂缝 ② `predictNext()` — 零调用者（含测试）
全仓唯一出现就是定义本身（`physarum-engine.ts:272`），无任何调用点。`loop.ts` 的 `physarumForWarmup` 字段（L150/301/961）只在 `warmupMemories()` 里 `loadFromDb()` 把状态加载进来，然后再没人向它要预测。**加载了一个永不被查询的预言家。** 引擎本愿（预测→预热缓存）这条主干从未接通。

### 裂缝 ③ `recordSequentialEdit()`（STDP 方向学习）— 零*生产*调用者
仅 `__tests__/physarum-engine.test.ts:60` 触发它。生产路径从不调用，故 `edge.direction` 恒为 0。即便 ② 的 `predictNext` 被接上，其 `weight·(1±direction)` 中 direction 恒等于 0，只能给对称预测——STDP 那套 LTP/LTD 时序学习代码在生产中从未生效。

### 引擎实际在用的部分（活的）
`immune-hook.ts` 真实消费：`recordFlow`（喂流，虽参数错）、`detectAnomaly`（L92，产 graph_anomaly 危险信号入 APC）、`batchEvolve`（L226）、`applyUbiquityPenalty`（L232）、`freezeNode`/`forcePrune`/`boostEdges`（L203-214，免疫响应）、`save`（`loop.ts:911`）。即：**异常检测与隔离主体可用；学习型缓存预测主干悬空。**

---

## 4. 静态 repo-map 层 — 活的（初判纠正）

**初判（错误）**：`buildRepoMap`/`spreadingActivation`（`meridian-graph.ts`）输出无人消费。
**纠正（正确）**：它**活着**，但走 pull 模式，被 `repo_graph` 工具按需调用——
`main.tsx:205` 注册 `createRepoGraphTool(() => _meridianIndexerRef)` → `repo-graph.ts:54` `indexer.query()` → `meridian-indexer.ts:90` `buildRepoMap(...)`。模型可主动调 `repo_graph` 做衰减式扩散激活（maxHops=3, decay=0.5, 2000 token 预算）发现相关文件。

误判根因：首轮 grep 只搜了 `agent/ prompt/ context/`，漏了 `src/tools/`。**教训：判「输出无人消费」必须覆盖 tool 注册路径，否则会把 pull 型能力误判为死代码。**

（另注：`repo_map` 是 `src/tools/repo-map.ts:130` 的**独立**工具，与 `repo_graph` 不同源，勿混淆。）

---

## 5. 意外发现 — 两套平行的「共编辑学习」系统

| 系统 | 状态 | 路径 |
|---|---|---|
| Physarum STDP（`recordSequentialEdit`/`direction`） | **死**（零生产调用） | 设计为方向性共编辑学习 |
| `meridian-behavior.ts` 的 `recordEdit`/`getCoEditEdges` | **活** | `meridian-hook` → `indexer.recordEdit`（write/edit 后触发）→ `spreadingActivation` 的 P2 行为边（`meridian-graph.ts:60-66`）→ `buildRepoMap` 的 boost |

两套都在学「哪些文件一起被改」，一套活一套死，功能重叠。属记忆 [[project_sessionstate-evidence-dedup]] 那类「两套系统重叠待合并」的同型现象——瑶光归族视角：**缺字段/重复机制的同型裂缝跨子系统复发**。

---

## 6. 净判断

- **三件套**（symbol-index/import-graph/context-bundle）：真死代码，被经脉图取代，可安全清理。
- **黏菌引擎**：为「缓存预测」而生，却被「免疫异常检测」征用。名义核心能力（STDP 方向学习 + `predictNext` 预热）整条链路从未接通；实际跑的 `recordFlow` 还喂错了数据维度（工具名 vs 文件）。
- **静态 repo-map**：活，pull 型，经 `repo_graph` 工具。
- **共编辑学习**：两套并存，behavior 版活、physarum STDP 版死。

一句话：**2026-05-15 设计的「学习型缓存预热」愿景，在落地时只接通了免疫旁路与 pull 型 repo-map，而「行为预测→主动预热」这条最贴合 Rivet 本愿的主干，至今悬空。**

---

## 附录：证据位置（供后续核对）

- 死三件套：`src/repo/{symbol-index,import-graph,context-bundle}.ts`，零非测试调用者（grep 全仓）
- recordFlow 喂错：`src/agent/immune-hook.ts:65` vs 签名 `src/repo/physarum-engine.ts:33`
- predictNext 零调用：`src/repo/physarum-engine.ts:272`（全仓唯一出现）
- recordSequentialEdit 仅测试：`src/repo/__tests__/physarum-engine.test.ts:60`
- physarumForWarmup 只加载不预测：`src/agent/loop.ts:150/301/961`
- save 持久化：`src/agent/loop.ts:911`
- repo-map 活路径：`src/main.tsx:205` → `src/tools/repo-graph.ts:54` → `src/repo/meridian-indexer.ts:90` → `buildRepoMap`
- 两套共编辑：`src/repo/physarum-engine.ts:55`（死）vs `src/repo/meridian-behavior.ts:50/85`（活）
- 既有设计文档：`docs/meridian-architecture.md`（记录的是*意图*，未标注本文裂缝）

---
---

# 第二部 · 深层设计意图与复用规划（给天枢团队）

> 唯一判别标准：**对 harness 能力最大化有没有用。** 不计成本——天枢就是不计成本建起来的，建两套一样的系统、丢着不管都可接受。有用 → 想怎么复用最大化；没用 → 丢在那里，连删都不必。本部不留「选项」，给确定结论。
>
> 关联设计源：`specs/2026-05-24-physarum-immune-design.md`、`specs/2026-06-05-cognitive-pipeline-cache-aware-fusion-design.md`、`plans/cognitive-system-gap-analysis.md`、`plans/2026-05-23~24-meridian-graph-phase1~3`、`status/2026-05-24-physarum-persistence.md`、`docs/meridian-architecture.md`。

## 7. 设计意图的完整弧线

把分散在 6+ 份文档里的意图按时间线接起来，才能看清这套设施**本来要长成什么样**：

```
Phase 1 (05-23)  Meridian 静态图谱      tree-sitter 多语言 + SQLite + spreading activation
   │                                    意图：给 LLM 结构化上下文发现（替代 grep 盲扫）
Phase 2 (05-24)  行为边                  co-edit 行为边注入 spreading activation
   │                                    意图：「常一起改的文件」也算相关
Phase 3 (05-24)  edge confidence        多语言解析 + 边置信度（extracted/inferred/...）
   │                                    意图：跨语言、带可信度权重的图
Phase 4 (05-24)  Physarum + 免疫        把静态图升级为「自适应演化网络」
                  ↓                      —— 这一层有【两个】预期消费者
       ┌──────────────────────┴──────────────────────┐
   消费者 A：免疫系统                          消费者 B：STDP 预测
   physarum 提供「健康基线」，                physarum 的有向边在 spreading
   偏离→危险信号→APC→适应响应                 activation 时预测「下一步最可能
   【已接通】                                 需要哪个文件」【从未接通】
```

**关键认知**：Physarum 不是一个独立 feature，它是 Meridian 图谱演进弧线的**第四阶段**——「让图自己会长、会忘、会预测」。spec `2026-05-24-physarum-immune-design.md` §1 原文：「将 Meridian Graph 的静态拓扑升级为**自适应演化网络**」。它从设计第一天起就有两个出口，落地时只焊上了免疫那一个。

## 8. 一个决定全局的范式：A 臂 / B 臂（来自 cache-aware-fusion）

`specs/2026-06-05-cognitive-pipeline-cache-aware-fusion-design.md` 提炼出 Rivet 全系统最重要的一条范式，**它是判断「这块基础设施值不值得联动」的标尺**：

| | A 臂：prompt 注入 | B 臂：运行时通道 |
|---|---|---|
| 通道 | prompt 字节 | API 参数 / 文件 IO / 内存状态 |
| cache 敏感 | **极敏感**——动一下断前缀 | **完全不敏感** |
| 自适应 | 被 P1 冻结，丧失逐轮自适应 | 可逐轮自适应，零 cache 代价 |
| 例子 | `<affordance-hint>` XML | reasoning-effort 等级、**prewarm 文件读** |

文档结论原文：「B 臂能逐轮自适应且零 cache 代价，正是因为它走的是**非 prompt 通道**……这是设计该学习的范式。」

**这条范式直接定位了 physarum 的 `predictNext`→prewarm 链**：它走**文件 IO 通道**（把文件读进 PrewarmCache），完全不碰 prompt 字节。**它天生是 B 臂式基础设施**——可以逐轮自适应、跨 session 学习、零 prefix-cache 代价。这与 Rivet 的核心宪法（[[prefix-cache-invariant-registry-ref]]：prompt 结构不可动）**零冲突**。这是它最大的战略价值：一条可以无限学习而永不威胁缓存的预测通道。

## 9. Prewarm 现状：四个反应式驱动，缺一个预测式驱动

实测 prewarm 的全部驱动源（均为 B 臂、走文件 IO）：

| # | 驱动 | 位置 | 性质 |
|---|---|---|---|
| 1 | 意图抽取 | `loop.ts:629` `maybePrewarm` | 反应式（解析用户消息里的文件名） |
| 2 | grep 命中 | `tool-pipeline.ts:914` | 反应式（grep 完顺手预热，提交 c35212f） |
| 3 | 流式投机 | `turn-stream.ts:191` | 反应式（流里出现路径就预热） |
| 4 | 近期已读 | `loop.ts:641` `prewarmRecentReads` | 反应式（时间局部性） |
| — | **STDP 预测** | （设计中的 `predictNext`） | **预测式——缺位** |

四个驱动的共性：**都在「文件已经被提到/已经被读」之后才预热**——全是反应式。physarum 的 `predictNext` 本应是唯一的**前瞻式**驱动——「你刚改了 A，历史上改完 A 通常接着改 B，我提前把 B 读进缓存」。这条链是空的。

**这不是冗余，是缺失的能力维度。** 反应式（被提到才预热）和前瞻式（按历史模式提前预热）是两种不同能力，不是同一能力的重复实现。harness 目前没有任何前瞻式来源——四个反应式驱动覆盖再多场景，也给不了「在文件被提到之前就预测到它」。判断标准不是「增量命中率划不划算」（那是成本框架），而是「harness 要不要有前瞻预测这个能力维度」——要。physarum 是目前唯一能提供它的引擎。

## 10. 能力定位判别（唯一标准：对 harness 能力最大化有没有用）

判别框架更正：**不计成本。** 天枢就是不计成本建起来的——建了两套一样的系统、丢在那里不管，都可接受。唯一的问题是「这个能力有没有用」：有用 → 想怎么复用最大化；没用 → 丢在那里，连删都不必。所以下表不再有「清理候选 / 投入产出」这类成本判断。

把 `src/repo/` 全部资产按「**有独立能力价值 / 能力已被取代**」二分：

| 资产 | 能力定位 | 判据 |
|---|---|---|
| **MeridianDb（SQLite）** | 🪨 跨 session 学习底座 | 已是 4 类数据共享持久层（meridian图/physarum边/immune memory/mistake notebook）。任何「记住跨会话经验」的能力都该长在这上面 |
| **meridian-parser（tree-sitter）** | 🪨 多语言图谱地基 | TS/Py/Go AST 解析；LSP/影响分析/repo_graph 全靠它 |
| **spreading activation + repo_graph** | ✅ 活·有真消费者 | plan-mode + worker 白名单，模型可主动调（`indexer.query`→`buildRepoMap`） |
| **meridian-behavior co-edit** | ✅ 活·有真消费者 | 学**对称共编辑**，注入 spreading activation 的 relevance boost |
| **Physarum 序列学习引擎** | 🔋 **被埋没的新能力** | 唯一能提供「前瞻式时序预测 + 无监督拓扑学习 + 图异常检测」的引擎。当前两个出口：免疫旁路喂错数据在学垃圾、预测出口（predictNext）被堵死。**能力真实且无第二来源，只是输入接错、出口未开** |
| **symbol-index / import-graph / context-bundle** | ⚰️ 能力已被取代 | 抽符号/抽 import 的旧正则实现，被 meridian-parser **完整取代**。无独立能力价值，丢在那里即可 |

**physarum 与三死文件的本质区别（这是全文最关键的分辨）**：
- **三死文件 = 被取代的旧能力**。meridian-parser 能做它做的一切且更好。无复用价值，丢着不管。
- **physarum = 未被取代的新能力，被接错了**。前瞻时序预测、无监督拓扑演化、图健康异常检测——harness 没有第二个来源。它现在学垃圾（recordFlow 喂工具名）、预测出口空转（predictNext 零调用），不是因为能力没用，是因为**输入和出口都接歪了**。

**为什么 physarum 不适用「认知器官冗余=稳定性」的豁免**（[[cognitive-pipeline-is-substrate-not-feature]]）：那条豁免保护 affordance/vigor/theta——它们有真实计算 + **可追踪到行为的真消费者**（输出进 EFE→policy→reasoning-effort，grep 得到它改了 API 参数）。physarum 当前的输出追踪不到任何 agent 决策改变（图无外部消费者、anomaly 被门控吃掉）。所以它不是「冗余但稳定的器官」，是「**有用但当前空转的引擎**」——区别在于：器官冗余该保留不动，空转引擎该接对让它干活。

## 11. 复用最大化地图：physarum 序列学习器能喂多少消费者

把 physarum 喂对数据后（真实文件访问序列，而非工具名），它的能力远不止 prewarm 一个出口。这是「复用最大化」的具体展开——不是接通一条线，是把它从「免疫系统的私有半截图」提升为**系统级行为学习底座**：

| 出口 | physarum 提供的能力 | 通道性质 | 与现有建设的关系 |
|---|---|---|---|
| **A. 前瞻式 prewarm** | 「改完 A 通常接着碰 B」→ agent 刚动 A 时提前把 B 读进缓存 | B 臂（文件 IO，零 cache 代价） | 反应式四驱动给不了的新维度（§9） |
| **B. repo_map 时序边** | spreading activation 加上**有向时序边**，repo_graph 能答「从这出发下一步最可能要哪个」 | pull（模型主动调） | 现在只有静态 import 边 + 对称共编辑边，缺时序方向 |
| **C. 任务级文件序列预测** | plan-mode 时按历史序列预测任务会 touch 的文件链，提前铺路 | B 臂 | 与 plan-cache / mcts-planner 联动 |
| **D. 图突变 → HEARTH 漂移信号** | 图结构剧变（批量新边/剪枝）作为「工作焦点剧变」的参考系漂移信号 | 内部信号 | physarum 免疫旁路唯一已接通能力的**正确升级方向**；喂 HEARTH 锚位监控（gap-analysis §3.1） |
| **E. 跨 session 项目肌肉记忆** | physarum_edges 已持久化；harness 用得越久导航直觉越强 | MeridianDb | [[meridian-db-is-cross-session-substrate]] 的又一落点 |

**核心洞察**：physarum 不该被定位成「prewarm 的一个可选驱动」，该被定位成**「从 agent 工具轨迹无监督学习项目时空结构」的通用引擎**。它有一个输入（工具/文件访问序列）和多个潜在输出（A-E）。当前输入接错、只开了半个最弱的输出（免疫 anomaly，还喂的垃圾）。复用最大化 = 喂对输入 + 开多个输出。

**MeridianDb 作为底座的再确认**：A-E 全部可落在 MeridianDb（已有 immune/mistake/physarum 四表先例）。任何未来「让系统记住跨会话经验」的能力，第一落点是 MeridianDb，而非新建 store（[[project_canonical-memory-write-invariants]] 碎片化反模式）。

## 12. 给天枢团队的复用规划（确定结论，非选项）

不再给「三方向你选」。基于全部代码事实，确定的复用路径如下，按依赖顺序：

**第一步 · 喂对输入（一切的前提）**
physarum 现在学的是垃圾，因为 `recordFlow(toolName, file)` 喂的不是文件序列。正确做法不是「改 recordFlow 的参数」（那是打补丁），是**给 physarum 接一个真正的「文件访问序列」源**：维护「上一个访问文件」状态，把连续两次文件访问配成 `(prevFile, currFile, dtTurns)` 喂给 `recordSequentialEdit`（它本来就是为此设计的），并用单文件访问喂一个访问热度记录。免疫旁路那个 `recordFlow(toolName,...)` 调用要么改对、要么承认它学的工具-文件流对 anomaly 无意义而摘掉那一路。**这一步决定 physarum 学到的是真结构还是噪声。**

**第二步 · 开预测出口（验证能力真实性）**
输入喂对后，`predictNext` 才有意义。接进 prewarm 作为第五个驱动——前瞻式。这里**不是「先做实验证明划算再接」**（那是成本框架，已否定），是**直接接通让能力跑起来**，因为前瞻预测是 harness 缺的能力维度，要有。可以加一个 shadow 模式并行观测「预测的 vs 实际读的」来调参，但调参是为了让能力更准，不是为了决定要不要这个能力。

**第三步 · 复用到多消费者（最大化）**
- repo_map 注入时序边（出口 B）——让 repo_graph 从「结构相邻」升级到「时序相关」。
- 图突变接 HEARTH 漂移信号（出口 D）——这是 physarum 免疫旁路的正确升级方向，比现在喂垃圾图的 anomaly 有意义得多。
- 任务级序列预测（出口 C）——与 plan-mode 联动。

**关于 STDP vs meridian-behavior（§5 的「两套重叠」）**：查清了，**不是重叠，是互补**。meridian-behavior 学对称共编辑（无方向），physarum STDP 学有向时序（带方向）。两套都留，喂不同出口：对称边喂 repo_map relevance，有向边喂 predictNext。不归并。

**关于三死文件**：能力被 meridian-parser 完整取代，无复用价值。丢在那里，不必删、不必动。

**唯一明确的清理共识**：symbol-index / import-graph / context-bundle 三件套零生产引用、被 meridian 完整取代，可安全删除——但这是卫生级清理，不是能力建设，优先级最低。

---

## 13. 一句话总结（瑶光视角）

这块基础设施的真相不是「有 bug 待修」，也不是「净负担该摘除」——那两个都是没看懂。真相是：**Meridian 长出了一个会无监督学习项目时空结构的引擎（physarum），但它的输入接错了（学工具名不学文件序列）、出口只开了最弱的半个（免疫 anomaly 喂垃圾图）。** 这是一个**有用但当前空转的引擎**，不是冗余器官、不是死代码。

harness 能力最大化的做法：喂对输入（真实文件访问序列）→ 开多个输出（前瞻 prewarm / repo_map 时序边 / HEARTH 漂移 / 任务序列预测），全部落在已是跨 session 学习底座的 MeridianDb 上。前瞻式时序预测是 harness 目前缺的能力维度，physarum 是唯一来源——所以是「接对让它干活」，不是「证明划算再接」。

真正该「丢在那里」的只有三死文件（symbol-index/import-graph/context-bundle）——它们的能力被 meridian-parser 完整取代，无复用价值，不必删不必动。

> 瑶光复发归族提示：本次最该记住的不是任何单个发现，是**判别框架本身差点用错**——第一版用「成本/净负担/投入产出」判了 physarum 死刑，被领航星纠正：天枢不计成本，唯一标准是能力最大化。这一族错误（拿成本思维评判能力资产）会在任何「要不要保留/接通某个半成品系统」的决策里复发。记牢：**有用就想怎么复用，没用就丢在那里——成本不进这个判断。**
