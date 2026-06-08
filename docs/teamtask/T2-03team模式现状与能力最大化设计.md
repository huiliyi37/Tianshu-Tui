# T2-03·team 模式现状与能力最大化设计

> 日期：2026-06-07
> 性质：现状纪要（第一部，事实）+ 能力最大化想象（第二部，在 V3 之上联合既有基础设施）
> 框架：能力最大化，不计成本
> **重要时序认知**：team 编排层是 **2026-06-07 出生的活前沿**（昨天），不是考古废墟。本文第一部记录"建到哪、设计意图是什么"，不挑"缺口"——活前沿的"缺口"只是还没建到的当前工作。第二部的想象是给 team 可用之后的方向，不抢 V2/V3 基线节奏。
> 上游：`specs/2026-06-07-team-mode-design-discussion.md`、`plans/2026-06-07-team-mode-v2-status.md`、`plans/2026-06-07-team-mode-v3-worker-stardomain.md`
> 关联记忆：[[meridian-db-is-cross-session-substrate]]、[[staleness-not-zero-consumers-discriminator]]、[[tianshu-star-domain-thesis]]

---

# 第一部 · 现状（事实）

## 1. 经济模型：为什么这套架构成立

核心洞察：**把"思考"和"执行"分离到不同模型，不是降级，是专业化。**

```
主控会话 (v4-pro)              天梁 worker (flash)
├ 规划/设计/审查               ├ 精准执行，不思考"该不该做"
├ 不执行 → 上下文干净          ├ 成本极低 (flash 定价)
└ 缓存持续累积 → 越规划越便宜   └ 给清晰 spec，比深度思考模型更快更准
```

- v4-pro 主控走高缓存命中（prefix 越来越长），规划成本极低；
- flash 天梁拿到清晰 spec 后精准交付，执行质量不降反升（不需要思考开销）；
- 「计划文档是星域间的通用语言」——已由 loop.ts 拆分实战验证（天梁执行 9/10）。

## 2. 两级模式

| 维度 | `/team`（标准） | `/team max`（能力最大化） |
|---|---|---|
| 输入 | 计划文档 + 用户任务 | 仅用户任务描述 |
| 规划 | 主控直接拆分 | 天权+天府+天璇三视角并行规划，确定性合并 |
| 执行 | 天梁 flash（相同） | 天梁 flash（相同） |
| 审查 | 主控 v4-pro / Squadron | 主控 v4-pro / Squadron |
| 场景 | 有现成计划，需执行 | 从零设计，需多视角评估 |

**三视角规划职责**（已是规划专调，非审查星）：
- **天权** = 基础计划（任务图、依赖、执行序）
- **天府** = 风险闸（验证门、风险升级、串行约束）
- **天璇** = 挑战者（替代方案、盲点、定向反证）

## 3. V2 基线：已落地的能力（git 06-07 提交线为证）

`src/agent/team-orchestrator.ts` + `team-plan.ts` + `team-perspectives.ts` + `tools/team-orchestrate.ts`：

| 能力 | 提交 | 状态 |
|---|---|---|
| team_orchestrate 工具（注册 `main.tsx:194`，模型可调） | `ab34d93` | ✅ |
| TeamTask/UnifiedTeamPlan schema + 依赖抽取 + 风险分类 | `4fad9be` | ✅ |
| 三视角并行规划 + 确定性合并 | `2d5daf9` | ✅ |
| 依赖/groupId 经 DelegationRequest 透传到 WorkOrder | `0dc5d5d` | ✅ |
| 波调度（按依赖分波 `groupTeamTasks`） | `4b35253` | ✅ |
| max 模式 planner 扇出 + 视角结果解析 | `0a27b70` | ✅ |
| 多波续派（`fromWave`，model-in-the-loop checkpoint） | `535dbd2` | ✅ |
| 最终波自动审查门（接 review-discipline 路由） | `716d723` | ✅ |
| 视角合并去假冲突 | `f364a02` | ✅ |
| 对抗审查加固计划解析（adversarial review 驱动的修复） | `f37b879` | ✅ |

**执行流**（standard）：解析计划 markdown → 按依赖分波 → 派第一波 → 主控集成 diff 后用 `fromWave:N` 续派 → 最终波自动过审查门。`max` 同流，前面多一步三视角规划+合并。

## 4. 复用的既有基础设施（设计文档标"✅完整"）

team 不重新发明，直接复用：`coordinator.ts`→`delegateBatch`（并行调度）、`work-order.ts`、`worker-session.ts`、`worktree-coordinator.ts`（隔离）、`semantic-lock.ts`+`conflict-gradient.ts`（冲突检测）、`aggregation.ts`（5 策略）、`profile-registry.ts`、`worker-prompts.ts`、`deliver-task.ts`（交付门禁）、`merge-protocol.ts`+`merge-queue.ts`。

> 这些是 05-21~23 建好的并行协调件。新 orchestrator（06-07）尚未全部接通其中的合并/锁协调——**这是活前沿的"还没建到"，不是遗忘**。规划走在执行前面是设计；team 模式当前还用不到，节奏由 V2 基线优先级决定。

## 5. V3 方向（后置强化，team 可用后才启动）

V3 文档已把"召之即来的专精 worker"幻想剥洋葱剥到底——剩下的全是接线 + 两个小模块，不是从零造系统。核心两根线：
- **worker 星域化**：`StarDomain.systemPromptSuffix`（6 段星域认知）现在**主控通、worker 断**——dispatcher 算出的 `authority` 转 DelegationRequest 时被丢弃，`buildWorkerPrompt` 的 `authoritySuffix` 三个调用方都没传。接通即让 worker 也带星域认知。
- **星域知识库 + 经验沉淀/升级**。

V3 硬约束：不插队 V2 的 P0/P1。本文第二部的想象同此约束——是 team 可用之后的方向。

---
---

# 第二部 · 能力最大化想象（team 可用之后，联合既有基础设施）

> 前提声明：以下全部排在 V2 基线 + V3 两根线之后。不抢节奏。这一部的价值不是"再加功能"，而是把前几轮考古挖到的、已经存在但还没和 team 联动的基础设施，接成一张网——让 team 模式不止"能跑一次"，而是**越跑越聪明**。
> 联合的总线索：[[meridian-db-is-cross-session-substrate]]——MeridianDb 已是 4 表共用的跨 session 学习底座，team 的所有学习产物都该落在它上面，而非各造存储。

## 6. 想象一：team 自己变成 physarum/P3 的最佳训练场

前几轮挖到 physarum（文件时序预测）和 P3 ToolPatternMiner（工具序列预测）都缺**高质量的序列信号**——单会话的工具轨迹噪声大。而 **team 模式产生的是结构化的、带标签的执行序列**：

- 每个 wave 的 worker 改了哪些文件、按什么顺序、哪些任务并行、哪些串行——这是天然干净的"文件协同 + 任务序列"训练数据。
- team 的 `UnifiedTeamPlan` 里 `dependencies` 字段是**人类/主控显式标注的依赖**——比 physarum 从行为里猜的有向边质量高一个数量级。

**联合**：team 执行完一波，把 `(taskA 改的文件集) → (taskB 改的文件集)` 的依赖关系喂给 physarum 的 `recordSequentialEdit`（T2-01 要接的那个出口）。team 成为 physarum 的**监督信号源**——不再靠从单会话行为里猜时序，而是从显式任务依赖里学。下次类似任务，physarum 的预测就有了真 ground truth 锚定。

## 7. 想象二：PlanCache 与 team 计划统一（接活 T2-02 的死链）

T2-02 发现 P3 的 PlanCache 是死链（`recordPlan`/`lookupPlan` 零调用，cache 永远空 → AgentJIT 永远返回 null）。而 **team max 模式每次都在生产高质量计划**（三视角合并的 `UnifiedTeamPlan`）。

**联合**：
- team max 产出 `UnifiedTeamPlan` 时 → `recordPlan(objective, waves)` 落 PlanCache（落 MeridianDb 跨 session）。
- 下次 `/team max` 收到相似 objective 时 → 先 `lookupPlan`，命中则把历史计划骨架作为三视角规划的**起点**（而非从零），三视角只做增量调整。
- 这同时点活了 AgentJIT：相似任务直接 JIT 复用计划骨架，省一轮三视角规划的 worker 开销。

一箭三雕：team 计划有了记忆、PlanCache 死链接活、AgentJIT 有了真输入。

## 8. 想象三：LinUCB 学"什么任务该派给哪个 profile / 几个并行"

T2-02 发现 LinUCB bandit（4 臂、6 维上下文）完全空转。team 模式恰好有**反复出现的离散决策**适合它学：

- **臂** = 调度策略（串行 / 2 并行 / 3 并行 / 按模块拆分）或 worker profile 选择。
- **上下文** = team 已有的信号：任务数、跨模块度、依赖深度、风险等级、历史相似任务结果。
- **奖励** = 这一波的实际结果（审查通过率、冲突数、重跑次数）。

**联合**：team 的 `groupTeamTasks`（现在是固定规则分波）→ 升级为"规则给先验 + LinUCB 从历史结果学最优并行度"。这正是 T2-02 接线 1 的具体落地场景——把空转的 RL 接到 team 这个有反复决策的活场景，比接到单会话 effort 决策信号更密集、反馈更清晰。

## 9. 想象四：split-policy 接进 team 派发前

`split-policy.ts` 的 `shouldSplit`（估计回合≥5 且跨≥3 模块 → 按模块拆并行 worker）是孤儿（consumers=0）。它和 team 的 `groupTeamTasks` **互补**：grouping 按**依赖**分波（时序），split 按**模块**分 worker（空间）。

**联合**：一个 wave 内的大任务，派发前先过 `shouldSplit`——跨模块的自动裂成按模块的并行 worker。grouping 解决"什么时候做"，split 解决"一件大事怎么并行做"。两者组合，team 的并行粒度从"波级"细化到"波内模块级"。

## 10. 想象五：team 执行序列 → physarum 图突变 → 主控的"团队健康感知"

把前几轮 physarum 免疫旁路的能力（图异常检测）用对场景：team 多 worker 并行时，physarum 图会因多个 worker 同时改不同区域而剧变。这个**图突变本身**是信号：

- 突变集中在预期模块 = 健康并行；
- 突变溢出到计划外文件 = 某个 worker 跑偏 / scope 泄漏 → 喂主控的 trajectory-health，提前预警，不等审查门才发现。

这是 physarum `detectAnomaly` 的**正确消费场景**——比现在喂垃圾图、被 APC 门控吃掉有意义得多（呼应 T2-01 不在范围、留给后续的那条线）。

## 11. 联合全景：team 是所有学习底座的汇流点

```
                    ┌─────────── MeridianDb (跨 session 学习底座) ───────────┐
                    │                                                        │
team max 三视角规划 ─┼─→ PlanCache (计划记忆)  ←──── 相似任务复用骨架          │
                    │                                                        │
team wave 执行序列 ──┼─→ physarum recordSequentialEdit (监督信号)              │
                    │       └─→ predictNext → 下次任务的文件预测/预热           │
                    │                                                        │
team 调度决策+结果 ──┼─→ LinUCB (学最优并行度/profile)                          │
                    │                                                        │
team 跨模块大任务 ───┼─→ split-policy (按模块裂并行 worker)                     │
                    │                                                        │
team 并行图突变 ─────┴─→ physarum detectAnomaly → 主控团队健康预警              │
```

**核心想象**：team 模式不只是"并行执行器"，它是 Rivet 所有半接/空转学习系统（physarum、P3 的 PlanCache/LinUCB、split-policy）**最理想的训练场和消费场**——因为它产生结构化、带标签、可复现的多智能体序列数据，而单会话给不了这种质量。前几轮挖到的那些"有用但接错/空转"的引擎，很多的正确归宿就是接到 team 上。

## 12. 时序与边界（严守）

- 全部排在 V2 基线 + V3 两根线**之后**。team 不可用之前，这些都是纸面方向。
- 每一项的学习产物落 MeridianDb，不新建 store。
- §6-9 与 T2-01/T2-02 是同一批基础设施的不同消费场——不重复建，是把已有引擎接到 team。
- 不预设优先级：哪个先做由天枢按 team 可用后的实际需要定。本文只画"能联合成什么"，不画"先做哪个"。

---

## 13. 天权修订意见（2026-06-08 审查补充）

> 结论：本文的总方向成立——team 确实是 physarum / P3 / PlanCache / split-policy 这些学习器的高质量训练场。但第二部里有几处需要从“能力想象”收紧为“可验证接线规则”，否则容易把计划信号、执行事实、可自动复用步骤混在一起，形成绿而空心的接线。

### 13.1 先更新“当前事实”再继续设计

本文第一部的事实层是 2026-06-07 快照；当前代码已经继续前进，后续修订应先把这些状态改成“已部分接通 / 仍缺消费”的分层事实：

| 主题 | 本文说法 | 当前应修订为 |
|---|---|---|
| worker 星域化 | `DelegationRequest` 不带 authority，`buildWorkerPrompt` 三处不传 suffix | **A 线已接通**：`DelegationRequest.authority` 已存在，`coordinator.ts` 透传，`work-order.ts` 按 domain whitelist 交集收紧工具，`worker-prompts.ts` 从 `starDomainRegistry` 注入 `systemPromptSuffix`；星域知识库/经验沉淀仍是后续线 |
| PlanCache | `recordPlan` / `lookupPlan` 死链 | **部分接通**：成功 `deliver_task` 后已有记录入口，`p3:plan_cache` 已经经 MeridianDb 保存/恢复；但 `planCacheSuggest` 是否进入主循环提示仍需核验，不能再写“永远空” |
| Physarum | `predictNext` 零消费、输入喂垃圾 | **文件访问线已修一段**：结构化 `physarum-file-access` hook 已只取 `file_path`，`recordFileAccess → predictNext → p3.enqueuePhysarumFilePredictions` 已有链路；team 作为监督信号源应作为第二阶段增强，而非替代真实文件访问学习 |
| LinUCB | 4 臂完全空转 | **要区分两套 bandit**：旧 model/style bandit 仍是 `flash/pro/concise/verbose`；effort bandit 已是 `delta:-1/0/+1` 并带 shadow/gate 语义。team 调度学习若要做，应新建 `team_scheduler_bandit`，不要复用 effort bandit |
| split-policy | orphan | 仍基本成立：`shouldSplit` 只有测试消费者，尚未接入 team wave 派发 |

这不是否定本文；这是把“考古快照”升级为“活前沿快照”。team 是活前沿，文档也要按活前沿维护。

### 13.2 §7 PlanCache 不能直接吞 `UnifiedTeamPlan` / waves

`PlanCache` 当前 schema 是 `PlanStep { tool, target, args }[]`，语义是“已成功执行的工具序列模板”。`UnifiedTeamPlan` / `TeamWave` 是“任务图 / 编排骨架”。两者不是同一种东西。

因此 §7 的这句需要修正：

> team max 产出 `UnifiedTeamPlan` 时 → `recordPlan(objective, waves)` 落 PlanCache

建议改为二选一：

1. **短期安全版**：team 完成并交付后，从真实 tool history / worker result / 实际 diff 中提取“已成功执行的工具序列”，再写入现有 `PlanCache`。这保持 PlanCache 的原语义不变。
2. **长期正确版**：新增 `TeamPlanCache` / `team_plan_templates`，单独存 `{ objective, tasks, waves, dependencies, risk, verification, outcome }`。它是计划骨架记忆，不是 JIT 可执行工具序列。

硬门：任何从 team plan skeleton 来的缓存命中，只能作为 advisory 起点或 planner context，**不能直接喂 AgentJIT 自动执行**。AgentJIT 仍只允许只读模板，写操作必须保持禁止或审批。

### 13.3 §6 Physarum 监督信号必须记录“执行事实”，不是“计划意图”

team 的 `dependencies` 字段是高质量标注，但它仍是计划意图，不等于真实编辑时序。向 physarum 注入监督边时应遵守：

- 只记录**已成功完成并已集成**的 task；失败、blocked、未集成的 wave 不写学习边。
- 文件集优先取**实际 changed files / worktree diff**，不是只取 `task.files` 或 `touchSet`。计划范围可作为 expected scope，实际 diff 才是 observed scope。
- 同一 wave 内并行任务没有可靠先后顺序，不能记录 A→B 的时序边；只可记录共现/并行标签。只有跨 wave 或显式 `dependsOn` 且后继已完成时，才记录有向序列。
- 写入 physarum 时不要只调用 `recordSequentialEdit`；当前引擎的安全序列是 `recordFlow(prev, curr, turn)` 先建边，再 `recordSequentialEdit(prev, curr, dt)` 更新方向，或走 `recordFileAccess` 的统一路径。

验收门：构造一个 team plan 中声明了依赖但前置 worker 失败的场景，断言 physarum 不产生该依赖边；构造同 wave 并行任务，断言不产生伪时序方向。

### 13.4 §10 “团队健康感知”不要只依赖 `detectAnomaly`

`detectAnomaly()` 当前看的是 physarum 图的 pruning/growth/criticality 统计；它不是 scope-leak 检测器。team 场景里最可靠的健康信号应先来自结构化对比：

```
expected = task.touchSet / scope.files / plan non-goals
observed = actual changedFiles + worktree diff
health = observed ⊆ expected ? healthy : scope_leak
```

physarum 图突变可以作为第二信号：用于发现“意外协同模式”或“异常集中修改”，但不应成为跑偏检测的第一责任链。否则 worker 改了计划外文件但图统计没触发异常时，会漏报。

建议新增 `TeamScopeHealth`：

- `plannedFiles`：来自 TeamTask.touchSet / scope.files；
- `actualFiles`：来自 coordinator/hands worktree diff，而不是 worker 自报；
- `leakedFiles`：`actual - planned`；
- `missingFiles`：`planned - actual`，仅作为提示，不一定失败；
- `severity`：跨模块/高风险文件/配置迁移时升高。

### 13.5 §8 LinUCB 调度学习应先 shadow，不应直接改 `groupTeamTasks`

“让 LinUCB 学最优并行度/profile”方向有价值，但不能直接替换当前确定性调度。当前 `groupTeamTasks` 承担安全约束：依赖拓扑、同文件串行、source+test 绑定、write/read 上限。bandit 只能在这些硬约束之后做建议。

建议设计为四层：

1. **Rule hard gate**：依赖、同文件写、source+test、风险串行永远先判。
2. **Shadow recommendation**：记录 `(context, ruleDecision, banditArm, pendingRewardId)`，不改变派发。
3. **Reward closure**：wave 完成后用审查通过率、冲突数、重跑次数、scope leak、耗时、验证状态计算 reward。
4. **Feature-gated influence**：只有样本数和一致性达阈值后，允许在规则给出的安全集合内调整 `maxParallel` 或 profile；默认关。

新的 action space 应独立命名，例如：

- `parallelism:1|2|3|4|5`
- `executor_profile:patcher|verifier|reviewer`（若要学 profile）
- `split:none|module|risk_serial`

不要复用 P3 effort bandit 的 `delta:-1/0/+1`，那是 reasoning effort 维度，不是 team 调度维度。

### 13.6 §9 split-policy 接入前缺一个“复杂度来源”

`shouldSplit(input)` 需要 `estimatedTurns`、`targetFiles`、`hasTests`。team 当前 `TeamTask` 没有可靠的 `estimatedTurns` 字段。若直接用文件数或文本长度硬凑，会制造误拆。

接入前应先定义复杂度来源：

- planner 输出显式 `estimatedTurns` / `complexity`；或
- 从历史相似任务均值估计；或
- 只在任务明示“跨 3+ 模块、预计长程”时触发。

同时，split 不应拆这些任务：

- 已有精确文件 scope 且少于 3 个模块；
- 高风险 migration/config/schema 任务；
- source+test 已绑定的一组；
- 依赖链中必须串行的 task；
- 会导致多个 worker 共享同一 ownership/semantic lock 的 task。

拆分后必须重新生成稳定 task id、dependencies、touchSet、verification gates，并重新跑 `groupTeamTasks`，不能在派发前临时把一个 task 裂成多个无图节点。

### 13.7 经济模型要写成“目标配置”，不是当前默认事实

本文多处写“天梁 worker = flash”。设计意图成立，但当前路由并不保证默认就是 flash：team 执行波用 `kind:'patch_proposal'`，映射到 `risky_refactor`；若 config 没把 `risky_refactor` 路由到 cheap/flash，默认仍可能走强模型。

建议改写为：

> 经济模型要求配置层把 executor 的 `risky_refactor` 或专用 `team_executor` capability 路由到 cheap/flash；缺省配置下不承诺一定是 flash。文档中的成本优势依赖该 routing 显式成立。

最好新增回归验收：给定 config.routing 中 `risky_refactor: cheap`，team executor 选 cheap；无 routing 时文档/输出明确提示“未启用 flash executor routing”。

### 13.8 规划 worker 的 profile / authority 要避免姿态互相抵消

当前 max 模式 planner request 使用 `kind:'plan'`、`profile:'reviewer'`、`authority: tianquan/tianfu/tianxuan`。`kind:'plan'` 能触发模型能力路由，但 `profile:'reviewer'` 会注入 reviewer 方法论。对天府风险视角合理，对天权基础计划/天璇挑战者不一定最优。

建议：

- 若目标是“规划专调”，profile 应考虑用 `planner` 或新增 `perspective_planner`；
- authority 负责认知姿态，profile 负责工具/产物格式；不要让 reviewer profile 把三个视角都拉向审查口吻；
- 测试应检查三视角 prompt 中既有 schema 指令，也有各自 authority suffix，且没有被不相关 profile prompt 冲掉。

### 13.9 最小落地顺序建议（不违背“不预设优先级”，但加安全依赖）

本文 §12 说“不预设优先级”可以保留，但实现层应加依赖闸，避免先做高风险消费者：

1. **P0 观测**：team run 结束后产出 `TeamRunTelemetry`，包含 waves、task outcome、actual changed files、review outcome、verification、scope leak。
2. **P1 被动学习**：只把已成功闭环的事实写入 MeridianDb；不改变调度、不注入大段 prompt。
3. **P2 Advisory**：Plan/TeamPlanCache 命中只作为短建议给 planner；physarum 预测只做 shadow/prewarm；scope health 只预警。
4. **P3 受控影响**：bandit 在 feature flag + 样本阈值 + 一致性闸后，才能影响并行度/profile。
5. **P4 自动执行**：AgentJIT 或自动复用写操作仍单独立项，默认不进入 team 学习闭环。

### 13.10 修订后的验收门

| 门 | 必须证明什么 |
|---|---|
| TeamPlanCache 类型门 | `UnifiedTeamPlan/TeamWave` 不会被塞进 `PlanCache.record(PlanStep[])`；若复用缓存，必须有 `kind/version` 区分 |
| 执行事实门 | 失败/未集成 worker 不产生 physarum/team 学习边 |
| 并行非时序门 | 同一 wave 的并行任务不产生 A→B 的假顺序 |
| Scope health 门 | worker 改计划外文件，即使 worker 自报 `changedFiles=[]`，也能通过实际 diff 检出 |
| Review gate 门 | 最终审查触发基于实际变更集合，而不只信 worker result 的 `changedFiles` |
| Bandit shadow 门 | 每个建议都有 `context + ruleDecision + arm + pendingRewardId`，reward 能闭环 |
| Routing 门 | flash executor 是显式 routing 成立后的结果，不把经济模型写成无条件事实 |

### 13.11 修订后的净判断

- “team 是学习底座汇流点”成立，而且比单会话更适合产生干净训练数据。
- 但必须严格区分三类数据：**计划意图**（plan/tasks/waves）、**执行事实**（diff/tool history/outcome）、**可复用动作**（只读 JIT/tool steps）。
- 第一批实现应先做 telemetry + 被动学习 + scope health；PlanCache/physarum/bandit 都先 advisory/shadow；不要一上来让它们改调度或自动执行。
- 文档第一部应随着 06-08 代码进展更新，否则第二部会基于过期“死链”判断继续推设计。

---

## 14. 天璇主线衔接修订（2026-06-08）

> 天权把第二部从「能力想象」称重收紧为「可验证接线规则」。我（天璇）在此把 T2-03 接进 T5×T2-03 合成主线「**路由即主动推理，team 即训练场**」——给天权的接线规则排一个长得出来的顺序，不改方向。完整主线见 `team5天璇修订/天璇修订t5-t3.md`。

### 14.1 T2-03 的角色定位：从「学习底座汇流点」升级为「episode 发生器」

§11 说 team 是所有学习器的汇流点，成立。但要再往前一步：**team 不只是消费场，它首先是高质量 episode 的发生器**。单会话给不了带依赖/验收/冲突/review 标签的结构化序列，team 能。所以 T2-03 在主线里的第一价值，不是「接哪个学习器」，而是「先把每次 team run 录成可学习的 episode」。

```ts
interface TeamEpisode {
  objectiveHash: string
  mode: 'standard' | 'max'
  waves: Array<{
    waveId: string; taskIds: string[]
    risk: 'low' | 'medium' | 'high'
    profiles: string[]; authorities: string[]; files: string[]
    modelUsed?: string[]
    reviewVerdict?: string; verificationPassed?: boolean; conflictCount?: number
  }>
  finalOutcome: 'passed' | 'failed' | 'partial'
  reward: number
}
```

### 14.2 最优顺序：P0 先做 `TeamEpisodeRecorder`，与 T5 的 routing shadow 并行

§13.9 天权给了 P0-P4 安全依赖闸，我把它和 T5 对齐成一条主线时序——**先有可观测的真相，再有可计算的 reward，最后才有可影响的行为**：

```
P0  TeamEpisodeRecorder（本文）∥ ModelRoutingShadow（T5）   ← 只记录，不改行为
P1  两条影子线接成 reward loop（§13.9 P1 被动学习 + reward 公式）
P2  T5 EFE 成本项 + 本文 §7 PlanCache advisory（§13.2 短期安全版）
P3  team 真多模型（authority→tier，先 shadow 再启用，§13.5）
P4  接学习器：physarum 监督边（§13.3）/ team_scheduler_bandit（§13.5）/ scope health（§13.4）
```

颠倒任何一层都会塌：先 P3 改 coordinator routing 表（30 commits 活前沿）会让成本和质量一起变、归因不了；先接 reward 而没有干净 episode 当锚，只能从噪声里凑。P0 双 recorder 一行真实行为都不改，却是后面每步可归因的地基。

### 14.3 与天权 §13 的衔接：缰绳不变，只是排进顺序

天权立的硬门，我全部保留并排进上面的顺序里，不另起炉灶：

- **三类数据分流**（§13.2/13.3）：计划意图 → 只进 advisory/planner context，永不喂 AgentJIT 自动执行；执行事实（实际 diff/outcome）→ reward 与 physarum 监督边的唯一合法来源；可复用动作 → JIT 只读模板。这是主线的第一性约束。
- **bandit 独立命名 + 复用已验证闸**（§13.5）：team 调度学习新建 `parallelism_bandit` / `model_tier_bandit`，**不复用 P3 effort bandit 的 `delta:-1/0/+1`**。且必须走瑶光在 effort 闸上趟通的语义：flag 默认关 → shadow → reward 闭环 → 阈值后 gated 影响。但注意——team 动作空间是多臂、连续 reward，瑶光那条「闸要能用合法数据造出关闭态」的反 false-green 硬门要在新场景重验，不能假设 effort 闸测试形状直接套。
- **审查不为省钱降级**：reward 公式里 `false_green_penalty` 压住 `cost_over_budget`，天权 reviewer 配强模型是不进 bandit 的硬规则。

### 14.4 下一份落地计划

T2-03 与 T5 合一，下一份写 `T5-01×T2-03-01·路由影子层与TeamEpisode训练底座.md`，范围只三件：`ModelRoutingShadowRecorder` + `TeamEpisodeRecorder` + MeridianDb 统一落地（DB 不可用 no-op）。验收门：prompt 字节不变、模型选择行为不变、team 行为不变、但运行后能看到 routing shadow + team episode，tsc 与相关 tests 绿。这一步完成，T5 的成本项和本文的 team 学习器才有真实燃料。

> —— 天璇，2026-06-08（据本人主线补全，受限于额度由瑶光代录）


