# 仓库智能层考古 — 死代码三件套 + 黏菌引擎接线裂缝

- **日期**：2026-06-07
- **性质**：架构考古 + 工程定位规划 / 背景纪要；含 2026-06-07 天权审查修订（§14-19）
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

**这条范式直接定位了 physarum 的 `predictNext`→prewarm 链**：它走**文件 IO 通道**（当前可作为 OS/page-cache 预热与异步文件读取；若要重新作为 `read_file` 结果缓存，必须引入 contextWindow-aware key/metadata），完全不碰 prompt 字节。**它天生是 B 臂式基础设施**——可以逐轮自适应、跨 session 学习、零 prefix-cache 代价。这与 Rivet 的核心宪法（[[prefix-cache-invariant-registry-ref]]：prompt 结构不可动）**零冲突**。这是它最大的战略价值：一条可以无限学习而永不威胁缓存的预测通道。

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

> 天权审查补注（2026-06-07）：§14-19 对本结论做了工程接线修订。核心判断保留，但实施顺序应更细：先修输入语义与观测，再接 `predictNext` 的消费者；且当前 `PrewarmCache` 不再直接服务 `read_file` model content，预测出口的近期落点应按 OS/page-cache 预热、P3 `IdleSpec`、或重新设计 contextWindow-aware prewarm 三者区分。

这块基础设施的真相不是「有 bug 待修」，也不是「净负担该摘除」——那两个都是没看懂。真相是：**Meridian 长出了一个会无监督学习项目时空结构的引擎（physarum），但它的输入接错了（学工具名不学文件序列）、出口只开了最弱的半个（免疫 anomaly 喂垃圾图）。** 这是一个**有用但当前空转的引擎**，不是冗余器官、不是死代码。

harness 能力最大化的做法：喂对输入（真实文件访问序列）→ 开多个输出（前瞻 prewarm / repo_map 时序边 / HEARTH 漂移 / 任务序列预测），全部落在已是跨 session 学习底座的 MeridianDb 上。前瞻式时序预测是 harness 目前缺的能力维度，physarum 是唯一来源——所以是「接对让它干活」，不是「证明划算再接」。

真正该「丢在那里」的只有三死文件（symbol-index/import-graph/context-bundle）——它们的能力被 meridian-parser 完整取代，无复用价值，不必删不必动。

> 瑶光复发归族提示：本次最该记住的不是任何单个发现，是**判别框架本身差点用错**——第一版用「成本/净负担/投入产出」判了 physarum 死刑，被领航星纠正：天枢不计成本，唯一标准是能力最大化。这一族错误（拿成本思维评判能力资产）会在任何「要不要保留/接通某个半成品系统」的决策里复发。记牢：**有用就想怎么复用，没用就丢在那里——成本不进这个判断。**

---

# 第三部 · 天权审查修订（2026-06-07）

> 结论先行：本文第一、二部的核心考古判断成立——三死文件是真死；`recordFlow(toolName, targetFile)` 是数据维度错接；`predictNext`/STDP 预测出口未接通；`repo_graph`/Meridian 行为边是活路径。需要修订的是**接线方案的工程落点**：当前 prewarm 已不再作为 `read_file` model-content 缓存命中路径，Physarum 的第一消费者不应被简单写成「读进 PrewarmCache → 下一次 read_file 命中」。应改为「文件访问序列学习 → contextWindow 安全的文件预取 / P3 IdleSpec / repo_graph 时序边 / HEARTH observe 信号」这四条分层出口。

## 14. 复核后的成立项

| 断言 | 审查结论 | 证据 |
|---|---|---|
| 三死文件零生产调用 | **成立** | 全仓 grep 只见 `src/repo/__tests__/*` 引用 `buildSymbolIndexFromText` / `buildImportEdgesFromText` / `buildContextBundle`；生产路径无 import。 |
| `recordFlow(ctx.toolName, ctx.targetFile)` 维度错接 | **成立** | `src/agent/immune-hook.ts:65` 将工具名作为 `fileA`；`src/repo/physarum-engine.ts:33` 的签名与注释要求 file/access co-edit 边。 |
| `predictNext()` 未被生产消费 | **成立** | `src/repo/physarum-engine.ts:272` 定义存在；全仓无生产调用。 |
| `recordSequentialEdit()` 未被生产调用 | **成立** | 仅 `src/repo/__tests__/physarum-engine.test.ts:60` 调用；生产中 `direction` 基本保持 0。 |
| `physarumForWarmup` 只加载不预测 | **成立** | `src/agent/loop.ts:301` 保存引用，`src/agent/loop.ts:966` `loadFromDb()`；未见后续 `predictNext`。 |
| `repo_graph` 是活路径 | **成立** | `src/main.tsx:207` 注册 `createRepoGraphTool` → `src/tools/repo-graph.ts:54` 调 `indexer.query` → `src/repo/meridian-indexer.ts:90-97` → `buildRepoMap`。 |
| Meridian 行为边是活路径 | **成立，且比原文可再加强** | `src/agent/hooks/meridian-hook.ts:20-23` 在 write/edit 后 `recordEdit`；`src/agent/loop.ts:1890/1928` turn 边界 `flushTurn()`；`src/repo/meridian-graph.ts:59-66` 注入 co-edit 边。 |

## 15. 必须修订的关键点：Prewarm 不是当前 `read_file` 内容缓存出口

原文 §8-9 把 `predictNext → prewarm` 描述为「把文件读进 PrewarmCache，下一次 `read_file` 命中」。这在历史意图上合理，但与当前实现不完全一致：

- `src/agent/prewarm-file.ts:39-54` 的 `batchPrewarm()` 确实会读取文件并写入 `PrewarmCache`。
- `src/agent/loop.ts:629-646`、`src/agent/tool-pipeline.ts:908-915`、`src/agent/turn-stream.ts`、`prewarmRecentReads()` 都会填充或触发预热。
- 但 `src/agent/tool-pipeline.ts:615-619` 明确写着：`read_file` **必须总是走真实 execute**，因为 PrewarmCache 可能在不同 contextWindow 下被填充，直接返回缓存内容会重引入截断回归。
- 因此，当前 PrewarmCache 更接近「文件预取 / OS page-cache warmup / 遗留待重接缓存」，而不是可直接宣称的 `read_file` tool-result 缓存命中路径。

修订后的表述应是：

| 出口 | 当前安全含义 | 若要增强为内容缓存，需要补的语义 |
|---|---|---|
| `predictNext → batchPrewarm` | 提前读文件，可能让 OS page cache 变热；不改变 prompt，不改变工具结果 | 需要 contextWindow/providerProfile/read cap 纳入 cache key 或 payload metadata，并在读取时验证兼容性 |
| `predictNext → P3 IdleSpec` | 更自然：`P3Integration` 已有 `ShadowQueue` + `checkSpeculativeCache()`，生产路径会在 `read_file`/`grep`/`glob` 前查投机结果 | 必须保证预测目标与未来 tool target 精确匹配；只对只读工具启用 |
| `predictNext → repo_graph` | pull 型：把时序边作为相关性补充，不主动塞 prompt | 需要在 `buildRepoMap`/`spreadingActivation` 增加有向时序边权，保持 token budget |
| `predictNext → HEARTH observe` | 作为图突变/漂移诊断信号，不直接干预 | 先接现有 observe/gated hook，不直接做 prompt 注入 |

所以，§9 的「四个反应式 prewarm 驱动」可以保留为历史/机制分类，但实施计划不能再以「下一次 `read_file` 命中 PrewarmCache」作为成功标准；成功标准应改为：预测命中率、投机结果命中、文件读取延迟变化、以及 repo_graph 相关性提升。

## 16. 接线方案的工程修订

### 16.1 输入源：不要再让 ImmuneHook 负责构造文件序列

`ImmuneHookContext.targetFile` 当前来自通用 tool target 提取：`file_path`、`path`、`command.slice(0, 50)`、甚至工具名兜底都可能进入这条线。`src/agent/tool-history-recorder.ts:13-21` 与 `src/agent/tool-execution.ts:323-331` 的 target 抽取是为了展示/历史记录，不是严格文件语义。继续用它直接喂 Physarum，会把目录、命令、工具名、grep 搜索路径混进文件图。

修订：新增或复用一个**文件访问观察器**，只接受成功工具事件里的真实文件路径：

1. `read_file`：`input.file_path`，规范化为 repo-relative canonical file。
2. `write_file` / `edit_file` / `hash_edit`：`input.file_path`，规范化后同时作为访问与编辑事件。
3. `grep`：不要把 `path` 当文件；若要学习 grep 命中文件，必须从 grep 结果中结构化提取文件路径后逐个记录，且与「用户真正读取/编辑」分开标注。
4. `bash`：默认不记录；只有未来有结构化文件事件时再接。
5. 所有事件必须过滤：非项目内路径、目录、工具名、空串、黑名单文件、不可索引扩展。

`ImmuneHook` 应保留为消费者：调用 `detectAnomaly()`、根据免疫响应 `freezeNode` / `forcePrune` / `boostEdges`。它不应继续拥有「工具轨迹 → 文件图」的原始输入权。

### 16.2 学习顺序：先建边，再更新 STDP 方向

`recordSequentialEdit(first, second, dtTurns)` 当前只更新已有边；如果没有先 `recordFlow(first, second, turn)`，它会静默返回。正确序列应是：

```ts
if (prevFile && prevFile !== currentFile && dtTurns <= stdpWindow) {
  physarum.recordFlow(prevFile, currentFile, turn)
  physarum.recordSequentialEdit(prevFile, currentFile, dtTurns)
}
```

这同时保留无向共访强度（`weight`）与有向时序偏置（`direction`）。需要测试两个方向：`a.ts → b.ts` 与 `b.ts → a.ts`，因为 `PhysarumEngine.edgeKey()` 用字典序存储边，`direction > 0` 表示 `fileA → fileB`，反向序列会写成负方向。

### 16.3 先清洗历史污染，再开启预测出口

因为错误的 `recordFlow(toolName, targetFile)` 已被持久化到 `MeridianDb.physarum_edges`，修接线前必须考虑旧数据污染：

- 旧边可能形如 `read_file|src/a.ts`、`grep|src/b.ts`、`bash|src/c.ts`。
- `loadFromDb()` 会无条件加载这些边。
- 如果直接开启 `predictNext()`，候选里可能出现工具名，或者工具名 hub 继续影响 ubiquity/homeostatic scaling。

修订：第一阶段必须加一层污染防线，二选一或同时做：

1. **加载过滤**：`PhysarumEngine.loadFromDb()` 或上层调用处过滤非文件节点。
2. **一次性迁移/清理**：删除 `physarum_edges` 中任一端不是合法项目文件的边；可以保守地按 `src/`、扩展名、存在性、indexable predicate 过滤。

这不是成本问题，是正确性前置条件；否则预测出口会把历史垃圾放大。

### 16.4 与 MeridianBehavior 的关系：互补成立，但边界要写死

原文「STDP 与 meridian-behavior 互补」成立，但实现上要避免第二次混淆：

| 系统 | 学什么 | 输入事件 | 输出 |
|---|---|---|---|
| `MeridianBehavior` | 同一 turn 内共同编辑的**对称关系** | write/edit/hash_edit 成功后的编辑集合 | `repo_graph` relevance boost、impact/test hints |
| `Physarum STDP` | 跨 turn/工具序列的**有向时序关系** | 规范化文件访问序列，特别是 read→edit、edit→test、source→test | `predictNext`、投机预取、repo_graph 时序边、漂移信号 |

不要把 `MeridianBehavior.recordEdit()` 直接替换成 Physarum，也不要把 Physarum 的有向序列边塞回 co-edit 表；两者共享 MeridianDb，但语义不同。

## 17. 未来能力接线的推荐顺序

按「能力最大化」而不是「成本最小化」排序，但每步都必须有正确性闸门：

### P0：数据语义修复与污染隔离

- 停止 `recordFlow(toolName, targetFile)` 继续写入工具名边。
- 新增文件访问观察器，产出 canonical repo-relative file events。
- 对既有 `physarum_edges` 做加载过滤或迁移清洗。
- 保持 DB 不可用时 no-op：`MeridianDb` 当前允许 `better-sqlite3` 缺失并降级，新的接线不能破坏这一点。

### P1：Shadow 观测，不阻断能力接通

Shadow 模式的目的不是「证明这个能力值不值得存在」，而是校准和防污染：

- 记录 `currentFile → predictNext()` 的 top-K。
- 下一次真实文件访问到来时计算 hit@1 / hit@3、平均提前 turn 数、误报文件类型。
- 不注入 prompt，不改变工具选择，只写 telemetry / MeridianDb。

### P2：第一个真实消费者优先接 P3 IdleSpec 或 OS/page-cache 预取

当前最小可承重消费者不是旧式 PrewarmCache 命中，而是以下二者之一：

1. **P3 IdleSpec**：`src/agent/p3-integration.ts` 已有 `ShadowQueue`，`src/agent/tool-pipeline.ts:608-614` 会消费只读工具投机结果。Physarum 可以给它补「文件目标预测」。
2. **OS/page-cache 预取**：沿用 `batchPrewarm()`，但把成功标准写成读取延迟/后续真实读取存在性，而不是 PrewarmCache hit。

如果要恢复 `read_file` 内容缓存命中，必须先完成 contextWindow-aware cache key，否则会违反 `tool-pipeline.ts:615-619` 的 P5+P6 约束。

### P3：repo_graph 时序边

在 `src/repo/meridian-graph.ts` 的 spreading activation 中引入 Physarum 的有向时序边，但只作为 score boost，不改变现有结构边逻辑。注意：`buildRepoMap()` 当前只拿 `MeridianDb` + `MeridianBehavior`，若要读 Physarum 边，需要明确依赖注入，避免让 graph 层偷偷 new engine。

### P4：HEARTH / drift 信号

`cognitive-system-gap-analysis.md` 对 HEARTH 的状态已经滞后：当前代码里已有 `src/prompt/anchor-graph.ts` 与 `src/agent/hooks/hearth-observe-hook.ts`，并通过 `hearthObserveEnabled` 显式门控接入。Physarum 图突变应先作为 observe/diagnostic 信号进入这条 gated 通道，不能直接变成 prompt 注入或强干预。

## 18. 验证清单（后续实施用）

| 层 | 必测项 | 目的 |
|---|---|---|
| Physarum 单元 | `recordFlow(prev,curr)` 后 `recordSequentialEdit(prev,curr,dt)` 使 `predictNext(prev)` 排名 `curr`；反向序列 direction 为负且预测反向成立 | 防止字典序边存储导致方向语义误写 |
| 污染过滤 | 加载包含 `read_file|src/a.ts` 的旧边后，预测候选不出现工具名；合法文件边保留 | 防止历史垃圾放大 |
| 文件事件观察器 | read/write/edit/hash_edit 记录文件；grep path、bash command、目录、空 target 不记录 | 防止再次把非文件维度喂进图 |
| ImmuneHook 回归 | 免疫仍能收集 danger signal、触发 response、调用 `freezeNode`/`boostEdges`；但不再断言工具名边存在 | 保留免疫消费者，移除错误生产者 |
| Meridian 回归 | `meridian-behavior` co-edit、`repo_graph`、`impact` 测试不退化 | 确认对称共编辑边未被 STDP 替代 |
| Prewarm/P3 | 预测驱动的预取不会绕过 `read_file` contextWindow cap；若接 IdleSpec，只对只读工具投机 | 防止重引入 P5+P6 截断回归 |
| DB 降级 | `better-sqlite3` 不可用时所有新增路径 no-op、不抛错 | 保持开源/可选依赖兼容 |

最小验证命令建议：

```bash
npx tsc --noEmit
npm exec -- tsx --test \
  src/repo/__tests__/physarum-engine.test.ts \
  src/repo/__tests__/meridian-behavior.test.ts \
  src/repo/__tests__/meridian-graph.test.ts \
  src/agent/__tests__/immune-hook.test.ts \
  src/agent/__tests__/prewarm-file.test.ts \
  src/agent/__tests__/p3-integration.test.ts
```

## 19. 修订后的净判断

- **能力判断不变**：Physarum 不是死代码；它是未接对的系统级行为学习底座。
- **接线判断修订**：第一出口不应被写死为旧式 `PrewarmCache` 命中；应按 P3 IdleSpec / 文件预取 / repo_graph 时序边 / HEARTH observe 四类消费者分层接。
- **实施前置新增**：必须先解决文件事件语义与历史污染过滤，否则任何预测消费者都会放大旧错接。
- **共编辑关系确认**：`MeridianBehavior` 与 Physarum STDP 互补，不归并。
- **三死文件判断不变**：无独立能力价值，删除只是卫生级清理，优先级最低。

---

# 第四部 · 瑶光审查复核（2026-06-08）

> 结论先行：本文事实脊梁我做了独立 RED 式复核——**全部成立，可照此往下走**。增值三条：①`edgeKey` 字典序方向是接 `predictNext` 前的**头号 false-green 陷阱**，应从测试清单项提升为强制 RED 门；②污染清理「加载过滤」即等于**干净清盘**，消解 §16.3 的二选一不确定；③这个 `recordFlow` 是缺陷归族的**新亚种「接上了≠喂对了」**。

## 20. 独立复核：事实脊梁成立（瑶光为结论背书）

文档 §4 自陈栽过窄 grep 坑（`buildRepoMap` 误判死），故我对所有**否定判定**做宽搜索复核（含 `.tsx`、含别名、排除定义与测试目录）——这是「否定判定最危险，grep 最擅长制造假阴性」纪律的应用：

| 断言 | 复核方式 | 结论 |
|---|---|---|
| `predictNext` 零调用 | 全仓宽搜，排除定义+测试 | ✅ 仍空 |
| `recordSequentialEdit` 仅测试 | 同上 | ✅ 确认 |
| 三死文件零非测试引用 | 逐导出符号验 | ✅ 三个全空 |
| `recordFlow(toolName,file)` 喂错维度 | 对码读 `immune-hook.ts:65` + 签名 + `ctx.toolName:string` | ✅ 承重墙成立 |

**这次没有第二个 buildRepoMap。结论事实可信。** 边界诚实：我 spot-check 的是承重论断；**肯定论断**（免疫消费者「活」、4 反应式 prewarm 驱动、spreading activation pull 路径）grep 位置具体可信但我**未逐一亲验**，不为其背书。

## 21. 增值①：`edgeKey` 字典序方向 = 接 predictNext 前的强制 RED 门（非普通测试项）

§16.2/§18 提了 `edgeKey` 字典序但当普通测试项列着。对码确认：`edgeKey(a,b)=a<b?"a|b":"b|a"`，而 `recordSequentialEdit` 里 `direction` 正负由 `first<second` 决定——**同一物理边，`a→b` 写正、`b→a` 写负**。后果：一个只测 `a.ts→b.ts`（顺字典序）排名正确的测试**会绿**，但所有「字典序在前的文件被后访问」的对，方向语义是**反的**，`predictNext` 给反向预测而测试照绿。**这与 §7（P1-1 false-green）同型：测试通过但没覆盖契约的另一半。** 建议：升级为**接 predictNext 前必过的 RED 门**——构造**反字典序** `b.ts→a.ts` 序列，断言 `predictNext(b)` 排名 `a`；此断言须在当前代码上能抓住方向反转，STDP 才算真接对。

## 22. 增值②：污染清理「加载过滤」即干净清盘 —— 消解 §16.3 的二选一

§16.3 把「加载过滤」与「一次性迁移」列为二选一且带不确定。复核后可消解：`recordFlow` **唯一生产调用方**永远喂 `(toolName, file)`，且 `recordSequentialEdit` 零生产调用——故 `physarum_edges` 里**每条边都有一个工具名端，根本不存在文件↔文件边**。那么「过滤任一端非合法文件的边」会清掉 **100%** 历史边 = **干净清盘**，且**没有任何文件↔文件边的权重被工具名 hub 的 homeostatic/ubiquity 演化污染过**（它们从未被创建）。

**结论：加载过滤 = 干净清盘，无需额外迁移脚本。P0 比文档写的更简单。**（诚实留痕：我本担心「过滤后存活文件边带历史失真权重」，验后证伪——因为没有文件边存活。这是对自己提案也用 RED 纪律的过程，留着免得结论像拍的。）

## 23. 增值③：缺陷归族新亚种 —— 「接上了≠喂对了」（空心绿）

文档定位准确（活着但接错本职）。从归族视角，这个 `recordFlow` 是值得命名的**新亚种**，是系统级 false-green 家族的进化版：

- **旧亚种「零件合格≠装上了」**（V3）：组件完美但从未被调用（store 从未 new、predictNext 零调用）。
- **新亚种「接上了≠喂对了」**（本次）：接线存在、被调用、测试绿、免疫 anomaly 真在 fire——**但流过的数据维度是错的，所以这份绿是空心的**。免疫旁路在对「工具名」做异常检测，学的是垃圾。

**共性**：单测与「功能在跑」对这种缺陷**零防御**——前者靠端到端测试守（验调用链通），后者**连端到端通了都不够，还要验「喂进去的数据维度对不对」**。这是比「没装」更隐蔽的一层。已记入 [[feedback_adversarial-review-method]] 缺陷族。

> 瑶光一句话：天权修了**接线落点**（出口接哪），瑶光补了**正确性闸门**（接通前怎么证不空心）。两层叠起来——physarum 接通的真实度 = 那个反字典序 RED 门被真正跑过的程度。能力是真的，但「绿」必须是实心的。
