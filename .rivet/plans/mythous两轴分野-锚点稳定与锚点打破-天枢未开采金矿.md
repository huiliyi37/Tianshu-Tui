# Mythous 与 deep-brainstorm:两条轴的分野,与天枢的未开采金矿

> 一次复盘:天枢的血脉来自把模型层机制隐喻抬升到认知层。但抬升只发生在**一条轴**上。
> deep-brainstorm 在另一条轴上做的事**与 Mythous 相反**——这才是它的独立价值,也指出了天枢最大的未开采金矿。

---

## 0. 元信息

- **来源**:OpenMythos(`github.com/kyegomez/OpenMythos`,Kye Gomez 对 Claude Mythos 架构的理论重构,模型层 PyTorch 实现)的 README / `docs/open_mythos.md` / 源码;天枢自身 `.claude/skills/deep-brainstorm/SKILL.md` 与运行时代码。
- **方法**:deep-brainstorm 三轮(变异→选择→适应)+ 两个只读探子核实天枢现状(认知循环 6 项对照、路由/专家对照)。
- **诚实分层**:标〔已核实〕的有探子给出的文件锚点;标〔推断〕的是基于读到的代码外推、尚未逐行验证的判断。
- **边界**:本文是分析,不改任何代码。两个落地金矿(破锚逃逸阀、收敛度量+聚合)分批另开计划。

---

## 1. 起源叙事 + 关键澄清

### 1.1 OpenMythos 是模型层,不是智能体框架

很容易被名字误导。OpenMythos 的全部内容是一个**循环深度 Transformer(Recurrent-Depth Transformer)** 的神经网络实现(`open_mythos/main.py`):

```
Input → [Prelude P]  → [Recurrent Block R, 循环 T 次] → [Coda C] → Output
                            ↑___________↓
              h_{t+1} = A·h_t + B·e + Transformer(h_t, e)
```

它谈的是 MLA/GQA 注意力、MoE 前馈、LTI 稳定注入、ACT 停机、loop-index 嵌入——**全是模型内部机制**,跑在一次前向传播的连续潜空间里,没有 token 级中间输出,更没有"工具""子代理""会话"这些智能体概念。

### 1.2 当年那次抬升

天枢的设计血脉,来自把 OpenMythos 的核心不变量**隐喻抬升**到认知层。最清晰的一条:

- 模型层(`RecurrentBlock` 每轮):`combined = RMSNorm(h_loop + e)`——把 Prelude 冻结后的原始输入 `e` 在**每一轮循环**注入,文档原话"prevents the hidden state from drifting away from the original input signal regardless of loop depth"(防漂移)。
- 认知层(deep-brainstorm 第二轮铁律):"**强制要求:重新阅读用户的原始需求……重新注入原始输入,防止推理漂移**"。

同一个物理:**反复重注入原始锚点,对抗深度循环带来的漂移**。这是漂亮的抬升。

### 1.3 关键澄清(本文的转折)

但抬升只发生在**这一条轴**上。deep-brainstorm 真正独特的部分,Mythous **没有**对应物,而且方向相反:

> Mythous 靠**架构 + 强算力**,在稳定的锚点里靠 loop 深挖;它的"广度"来自连续潜空间的叠加态——**锚点内**、用算力买的广度。
>
> deep-brainstorm 没有那个算力/架构,改用**多个子代理带回其他领域的信息**,扩散主控模型的探索面,**打破 transformer 的 in-context 锚点锁定**,以此解锁单次锚定前向到不了的能力上限。

所以"还能学什么"的答案,不是去补更多 Mythous 机制,而是先看清:天枢站在**两条轴**上,且严重失衡。下一节是全文脊柱。

---

## 2. 脊柱:两条轴的分野

### 2.1 锚点稳定轴(Mythous 的轴)

| 维度 | Mythous 的做法 |
|---|---|
| 目的 | 在**固定锚点**内把推理做深 |
| 防漂移 | `h_{t+1}=A·h_t+B·e`,每轮重注入冻结 e |
| 广度来源 | **连续潜空间的叠加态**(README:"continuous latent thoughts can encode multiple alternative next steps simultaneously")——锚点内、算力买的 breadth-first |
| 稳定保证 | LTI 注入 + 谱半径 ρ(A)<1 |
| 何时停 | ACT 逐位置停机(收敛即停) |
| 资源 | 架构 + FLOPs(更多 loop = 更深) |

特征:**深度靠算力,广度也靠算力**(潜空间里同时展开多条路径),全程**不离开原锚点**。

### 2.2 锚点打破轴(deep-brainstorm 的轴)

天枢驾驭的是**冻结的 API 模型**,既改不了架构,也买不起 Mythous 那种潜空间叠加广度。于是它走了一条**物理不同**的路——用**外部信息多样性**替代潜空间广度。证据全在 `deep-brainstorm/SKILL.md` 里写死(Step 0.3 / 0.4):

- **强制随机约束**:"至少 1 个子代理必须搜索与当前任务无直接关系的外部领域";"所有子代理的搜索关键词**不得包含用户输入中的显性关键词**";"噪声是特性不是 bug"。
- **3+1 Scout 假设合成**:"假设必须是三个随机发现的**交叉点**,不是任何一个 scout 直接给出的"。

作用机制:把主控模型的注意力,**强行推向它自己永远不会检索到的 token**。单个 LLM 的前向传播会被 in-context 的提示牢牢锚定(anchoring / mode collapse),只能在锚点邻域里打转;而外域子代理带回的正交信息进入上下文后,**改变了注意力分布的着力点**,把探索面从锚点邻域扩散出去——这就是"打破锚点锁定,解锁平时认知不到的能力上限"。

### 2.3 它是振荡器,不是单向

deep-brainstorm 最精妙的地方:它不是一味破锚,而是**破锚与重锚交替**:

```
第一轮 变异  = 破锚(外域注入 + 4 个发散生态位,故意制造受控漂移)
第二轮 选择  = 重锚(重注入原始目标,Mythous 式防漂移,把发散收回正题)
第三轮 适应  = 收敛(具体化最强方案)
```

explore(破锚)↔ exploit(重锚)的节律振荡——**这是 Mythous 没有的**。Mythous 只做重锚(防漂移),它的探索在潜空间内一次性解决,不需要"先故意跑偏再拉回"。

### 2.4 一句话对照

- **Mythous**:广度在**锚点内**用**算力**买(潜空间叠加),全程防漂移。
- **deep-brainstorm**:广度在**锚点外**用**信息**买(外域子代理),靠周期性破锚+重锚的振荡拿到。

二者解决的是同一件事(在收敛前探索足够多的方向),但用的资源、方向、物理完全不同。认清这一点,才能问对"天枢还缺什么"。

---

## 3. 全机制映射表(A–M,带"属哪条轴")

> 属轴:〔稳〕锚点稳定 / 〔破〕锚点打破 / 〔中〕中性结构。
> 现状:已抬升 / 半抬升 / 未开采 / 不可迁移。锚点为探子核实,标注来源。

| # | OpenMythos 机制 | 属轴 | 天枢现状 | 关键锚点〔已核实〕 | 一句话 |
|---|---|---|---|---|---|
| A | 输入注入 e 防漂移 | 稳 | 半抬升 | `compaction-controller.ts:buildTaskAnchorAppendix`/`renderTaskAnchor`;`engine.ts` frozen prefix(147-155);`advisory-bus.ts:disciplineReanchorEntry`+`DISCIPLINE_REANCHOR_INTERVAL`;`loop.ts:toolCallsSinceReanchor` | 每 actionable turn 重投影 `<task-contract>`,工具批每 15 次纪律重锚;非每轮全文 replay |
| B | 三段式 Prelude/Recurrent/Coda | 中 | 半抬升 | `turn-orchestrator.ts:execute`(6b compaction→6c perception→6d convergence→6e replan→6f build);`runtime-hooks.ts` 五相;text-only turn→`isFinal:true` | 分段清晰但非严格命名;收尾相跑 dream/playbook-reflect |
| C | LTI + ρ(A)<1 收敛保证 | 稳 | **未开采** | 仅 `prediction-error.ts:PredictionAccumulator`、`stigmergy.ts:computeCurrentStrength` 衰减、`trace-store.ts:capEvents`、`claim-store.ts:MAX_ACTIVE_CLAIMS` 等容量/衰减有界 | 无任何收缩映射/残差范数证明;只有工程性有界,不能声称数学收敛 |
| D | ACT 自适应停机 | 稳 | 半抬升 | `convergence-detector.ts:evaluateConvergence`/`selectTier`(L3 abort: score<0.1 或 noToolCount≥5);`vigor/theta/kick` hooks;`turn-step-producer.ts:TurnHeartbeat`(hardStallMs 240_000);`thinking-retry.ts`(≤1) | 停机是**多信号联邦**,无单一 ACT 计算深度控制器 |
| E | loop-index 阶段分化 | 中 | **已抬升** | `runtime-hooks.ts:RuntimeHookSnapshot.turn`;`cognitive-season.ts:classifySeason`(GENESIS_WINDOW=5);`convergence-detector.ts:selectTier`(nLow/nMid/nHigh);`star-event.ts`;`blind-exploration-hook`/`mcts-planning-hook` | 同一套 hook/检测器随 turn 深度行为不同(早探索、晚收敛) |
| F | MoE 路由+共享专家+负载均衡 | 破/中 | 半抬升 | 星域 `star-domain.ts:STAR_DOMAINS`(9 域)+Profile `profile-registry.ts`=prompt 专家;共享专家=`static.ts:BASE_PROMPT`+hooks;`expert-router.ts:selectExpertSet`/`MAX_COUNCIL_EXPERTS` | 路由粒度在任务/关键词非 token;**负载均衡防塌缩缺失**(星域无激活计数/探索奖励/配额) |
| G | 每轮 LoRA 深度适配 | 稳 | 半抬升〔推断〕 | `model-tier-bandit.ts`/`adaptive-routing.ts:AdaptiveRouter` | 有"按历史调行为"的代理,无"每轮轻量人格微调"的直接同构 |
| H | 连续深度批处理(异深度停机) | 中 | 未开采〔推断〕 | `team-orchestrator.ts:runTeam`(多波并行偏同步) | 并行子任务"各自在不同深度停机"基本是缺口 |
| I | MLA/GQA 压缩 KV 缓存 | 中 | **不可迁移(已等价覆盖)** | `engine.ts` 前缀缓存 + `compaction-controller.ts` | 智能体层等价物是前缀缓存+压缩,无需迁移模型层 |
| J | 记忆-推理路径分离 | 中 | 半抬升 | `claim-store.ts`/`stigmergy.ts`/`playbook-store.ts`/`trace-store.ts` 四 store 职责分明;`context-injection.ts:refreshActiveClaims` 注入 | 逻辑分层,但推理仍走单条 LLM 循环,无"只读记忆通道 vs 纯推理循环"硬隔离 |
| K | 深度外推(难题跑更多轮) | 稳/中 | 半抬升 | `turn-end.ts:processTurnEnd`(turn>3 切模型);EFE/复杂度分级 `adaptive-routing.ts:selectModelForComplexity` | 难度→升档已有,但偏模型/turn 数,非"同结构更深递归" |
| L | 隐式潜思 = 推理空间广搜 | **破** | **已抬升但孤岛化** | `deep-brainstorm/SKILL.md` 四变异 + 3+1 Scout;`team-orchestrator.ts:runTeam` max 模式 | **只在 skill 层**;运行时主循环 `AgentLoop` 没有外域广搜 |
| M | 跨轮 ACT 加权聚合输出 | 稳 | **未开采** | `turn-completion.ts:TurnCompletionController.complete`(取最终 turn) | 只承诺最后一轮;早期轮洞见除非进 store 否则丢弃 |

### 3.1 表的结论行

把"属轴"列竖着看,失衡一目了然:

- **稳定轴**(A/C/D/M…):天枢机制密集——前缀缓存、task-anchor、每 15 次重锚、收敛 abort、硬停滞看门狗。这条轴上天枢甚至**过度工程**(C/M 是它想做得更狠却还没做的方向)。
- **打破轴**(F-负载均衡 / L 外域广搜):**几乎只存在于 skill**。运行时主循环里,破锚机制近乎为零——`kick` 这个唯一的"卡死干预"干的还是**重锚**(见第 4 节)。

---

## 4. 中心金矿:主循环锚点稳定过饱和,锚点打破饥饿

### 4.1 取证:主循环全是稳定轴

天枢运行时主循环的每一个"对抗漂移/卡死"的机制,方向都是**把注意力拉回原锚点**:

- 前缀缓存是天枢的**核心优化**(`engine.ts` frozen prefix)——本质是让锚点尽量不动;
- `compaction-controller.ts:buildTaskAnchorAppendix` 压缩后用权威 `<task-anchor>` 重锚;
- `advisory-bus.ts` 每 15 次工具调用做纪律重锚;
- 卡死恢复 `dissipative-kick.ts:buildKickActions` 的动作之一是"**重新阅读用户原始请求**"。

### 4.2 要害矛盾:卡死时该破锚,天枢却重锚更狠

`kick` 是天枢面对停滞/doom-loop 的主要干预。但它的方向是**重锚更狠**——把注意力使劲拉回原锚点。

而 deep-brainstorm 的核心智慧恰恰相反:**当模型真正卡死,往往是因为它被锚点锁死在一个局部盆地里出不来;此时正确的动作是破锚(注入正交外域信息),不是重锚**。重锚更狠只会让它在同一个盆地里转得更紧。

这是天枢主循环缺失的一整个**方向**:它有 explore-early(`blind-exploration-hook`/`mcts-planning-hook` 只在前几轮),有 exploit-always(重锚),但**没有 explore-on-stuck**(卡死时主动破锚)。

### 4.3 孤岛化:破锚技术没下沉进 runtime

破锚这门技术——多个子代理带回外域信息——天枢**已经有**,但它**只活在 deep-brainstorm / team-orchestrator 这些 skill 里**,由用户显式触发或特定编排路径才启动。它**没有下沉进 `AgentLoop` 的运行时主循环**,所以普通会话卡死时享受不到。

> **最大未开采杠杆 = 把"破锚"从技能孤岛抬进主循环。** 这与当年"把输入注入抬成目标重注入"是同一类动作,只是这次抬的是相反方向的那条轴。

---

## 5. 抬升草图(只描述,不实现)

### 5.1 草图一(主)· 主循环破锚逃逸阀

**触发**:doom-loop 升级(`trace-store.ts:getDoomLoopLevel`)或连续多次 `kick`/重锚未脱困(`kick-hook.ts:lastKickTurn` 多次无效)。

**动作**(与现有 kick **方向相反**):不再重锚,而是派一次性外域子代理(复用 `coordinator.ts:delegate`),带回**与当前任务正交**的领域信息注入上下文——直接借用 deep-brainstorm 的破锚约束:搜索关键词**禁含**当前任务的显性词、强制至少一个无关外域。**主动制造受控漂移**,扩散注意力着力点,再在下一轮重锚收回。

**本质**:把 explore↔exploit 做成主循环里的**振荡控制器**,让运行时也具备 deep-brainstorm 的破锚-重锚节律,而不是只有单边 exploit。

**风险与护栏**:破锚有成本(token/时延)且可能引入噪声——必须门控(仅 doom-loop 时、有 cooldown、外域注入限量),且破锚后强制重锚一轮防止真漂移。这正是 Mythous 防漂移智慧的用武之处:**破锚必须配重锚**。

### 5.2 草图二(辅·稳定轴补强)· 收敛度量 + 跨轮加权聚合(C+D+M)

天枢的停机是"信号联邦",能判 **stuck** 却不能判 **converging**。补强:

- **收敛度量(C 同构)**:定义可度量残差 `R_t`(未决问题数 / 验证缺口 / 合同未满足项,原料已在 `cognitive-ledger.ts` / `task-contract.ts` / `prediction-error.ts`)。规则:每次 replan 须使 `R` 单调下降;连续 N 次不降 → 硬停或强制换向。这是 ρ(A)<1 的**纪律化(非数学)同构**——天枢有原料,缺单调下降守卫。
- **跨轮加权聚合(M 同构)**:终答不只取最后一轮(`turn-completion.ts`),而是对各 actionable turn 的产出按收敛分/置信度**加权聚合**(ACT-weighted sum 的智能体级同构),把早期轮的有效部分纳入交付。

> 两条草图的关系:草图一补**打破轴**(从无到有,优先),草图二补**稳定轴**(从有到更稳,其次)。健康认知两条都要。

---

## 6. 不可迁移 / 双向抬升 / 一个反思

### 6.1 诚实标注:纯模型层、不必迁移

- **MLA/GQA 压缩 KV**:智能体层等价物是前缀缓存 + compaction,已覆盖,迁移模型层细节无意义。
- **ρ(A)<1 的字面数学**:智能体轮次不是固定线性算子,无法照搬谱半径;只能取其"有界单调"的纪律精神(见草图二)。
- **token 级 MoE 路由**:天枢星域是**会话级绑定一次**(`loop.ts:bindSessionDomain`),token 级负载均衡的类比在此退化;真要补,是"跨会话星域探索奖励"(回收自被淘汰的 V2),而非 per-token 偏置。

### 6.2 双向抬升:天枢独有、模型层没有

抬升不是单向的。天枢有一批**智能体层独有**机制,Mythous 这种模型层架构里根本不存在:前缀缓存工程(`PromptEngine` frozen/appendix 分离)、DeepSeek 专用 habituation(`FieldHabituationTracker`)、delivery-gate v2、星域人格路由。把它们也记一笔,是为了说明:**认知架构 ≠ 模型架构的缩小版**,它有自己的发明。

### 6.3 反思(收尾点睛)

天枢对前缀缓存的偏执,是**稳定轴上的巨大胜利**——它让 1 个用户消息→50 次工具调用的代价被缓存吃掉。但同一个冻结前缀,**也可能是打破轴上的牢笼**:锚点越稳,模型越难逃离 in-context 的局部盆地。

两条轴存在**真实张力**:无限优化稳定,会扼杀打破;无限打破,会丧失收敛。Mythous 在模型层用 ACT+ρ<1 自动平衡;天枢在认知层只把稳定一侧做到了极致,打破一侧还押在一个孤岛技能里。

> 结论:天枢"还能从 Mythous 学到的",不是更多机制,而是**学会在两条轴之间有节律地振荡**——并先把缺失的那条(破锚)接进主循环。

---

## 7. 下一步(给出,不执行)

按"分批做"约定,两个金矿各自另开落地计划。建议顺序与最小验证:

- **批一 · 破锚逃逸阀(草图一,优先)**:Phase 1 用**影子模式**接到 doom-loop 检测点,**只记录**"此处本应破锚"的时机 + 候选外域,不真正注入。先验证"破锚时机判断"准不准,再决定是否真注入。
- **批二 · 收敛度量+聚合(草图二)**:Phase 1 同样影子化——计算 `R_t` 并记录其轨迹,验证 `R` 是否真能预测 doom-loop;不阻断、不改交付。

两批都遵循"先观测、后干预",避免直接动 `AgentLoop` 的收敛/停机这种高敏路径。

---

## 附:规格自检

- 占位符扫描:无 TODO/待定。
- 文件锚点:映射表每行带锚点;〔已核实〕来自只读探子,〔推断〕已明确标注。
- 一致性:两轴归属在表中每行明确;草图主次与第 4 节金矿一致。
- 范围:聚焦"两轴分野 + 主循环破锚饥饿",落地拆给后续两批,未越界写代码。
