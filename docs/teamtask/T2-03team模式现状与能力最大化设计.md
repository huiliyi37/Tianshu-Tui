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

