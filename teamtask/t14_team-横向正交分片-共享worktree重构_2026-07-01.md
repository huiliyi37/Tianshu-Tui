# t14 — Team 模式重构:横向正交分片 + 同分支共享 worktree(已落地)

> 2026-07-01。本文件记录 **实际落地的新版方案**,不是早期草案的 map-reduce + 自动合并版。
> 早期草案(`.cursor/plans/team-map-reduce-refactor_*.plan.md` 的标题与附件)写的是「激活自动合并 reduce + 每 worker worktree」,
> 经两轮用户纠正后**已推翻**,改为下面的形态。阅读时以本文件为准。

## 背景与意图

Team 模式存在的目的是「让任务完成更快」,不是把一个连贯改动喂成一堆弱角色的流水线碎片。
天梁 flash 能力足够独立扛一个完整子任务(实现 + 自查 + 本地验证一气呵成)。
目标形态:**一个任务横向切成若干正交分片 → 2-4 个 flash 在同一分支/同一工作区并行各写各的 → 不需要事后合并,直接成形**。
对标 5/30 那条提交线的真实工作流:多个并行会话在同一分支上交错执行复杂任务,靠分片正交 + 文件级识别防踩踏。

## 与早期草案的关键偏差(为什么改方向)

| 维度 | 早期草案(已废) | 落地新版 |
|------|----------------|----------|
| 拆分 | 纵向角色流水线(explore→patch→import→test→lint→type→verify) | 横向正交分片,每片自包含(改+测+本地验证),一个 flash 全程 |
| 隔离 | 每写 worker 各开 git worktree | 主控单一共享工作区,所有 flash 直接写 |
| 合并 | 接线 `merge-protocol` 自动 reduce 合并到集成 worktree | **不需要合并**,改动直接落在共享工作区 |
| 防踩踏 | 靠 worktree 物理隔离 + 事后合并 | 靠 `SessionRegistry` 文件占用 claim + `groupTeamTasks` 同文件分波串行 |

用户原话依据:
- 「flash 可以独立完成一个 plan 计划文档…3 个 flash 并行,一人一个独立任务,最后合并才是我们想要的」
- 「他不用非得开 worktree,或者只要主控单开 worktree 就可以了。一个分支可以支持四个并行会话同时执行任何交错的任务」(并指向 5/30 凌晨到 14 点的提交线为证)
- 「即便重叠也没关系,说明依赖顺序就行了。我们有文件级的识别不会互相踩踏」

## 落地改造(5 块)

### 1. 拆分去碎片化(核心)
`src/agent/task-planner.ts` 的 `decomposeObjective` 从「按工序竖切」改为「按模块边界横切」:
- 删除 `import_organizer` / `lint_fixer` / `type_fixer` / `test_scaffolder` / 独立 `verify` 角色节点。
- 每个分片是一个自包含 patcher,objective 里写明「实现后自行跑 tsc/lint/相关测试至通过」。
- 多模块按 `moduleKey`(路径前两段,如 `src/tui`)分组,一模块一分片,文件互斥 → 可并行。
- `explore` 仅在 system/wiring/refactor/文件数 ≥4 时保留一个前置分片;小任务直接单分片。
- 启发式分片天然正交(文件不重叠);重叠-定序是主控手写计划的职责,下游有兜底。

### 2. 隔离:主控单一共享工作区直写
`src/agent/hands-session.ts` + `src/agent/coordinator.ts`:
- `HandsSessionConfig` 新增 `sharedWorkspace` 开关。开启时写 worker **直接在 `cwd`(主控共享工作区)里跑**,不再 `wtCoordinator.create` 各开 worktree、不再 `collectDiff` 回流、不再要主控 `apply_patch` 合并(复用原 git-absent 的 in-place 代码路径)。
- `DelegationCoordinatorConfig` 新增 `sharedWorktree`,三处 `runHands` 调用透传给 `sharedWorkspace`。
- `src/bootstrap.ts` 主协调器默认 `sharedWorktree: true`(正式运行默认走共享直写)。
- 兜底不变:`SessionRegistry` exclusive claim + `groupTeamTasks` 同文件分波串行。共享模式不收集单 worker diff,主控用 `git diff`/`git status` 看聚合结果。
- 测试默认 `sharedWorktree` 关,保留旧 worktree 路径与 diff 行为基线不破。

### 3. 主控正交拆分引导 + 重叠校验
- `src/workflows/ecosystem-workflows.ts` 团队工作流提示、`plan_task`/`team_orchestrate` 工具描述:引导主控「横向切正交分片(像 S1-S16),每片自包含、一个 flash 全程;文件尽量不重叠,重叠就标 dependsOn;禁止按 lint/type/import 工序竖切」,并说明共享工作区直写、看聚合 git diff。
- `src/agent/unified-plan.ts` `validateUnifiedPlan` 新增 `warnings`:检测两分片 `files`/`touchSet` 重叠却无 dependsOn(含传递依赖)定序时,提示补依赖顺序(advisory,不阻断 `valid`)。`team_orchestrate` 把告警附在执行回执后,`renderUnifiedPlanSummary` 也打印。

### 4. 并发度 + 单 flash 预算
- `src/agent/team-grouping.ts` `MAX_WRITE_WORKERS` 2 → 3。
- `src/agent/work-order.ts` `createWriteWorkOrder` 默认 `maxTurns` 8 → 14。
- `src/agent/profile-registry.ts` `patcher` 档 `defaultMaxTokens` 16384 → 24576,新增 `defaultTimeoutMs` 300_000(长程分片不被中途掐断,且低于 team 工具 600s 上限)。

### 5. 验证
- `src/agent/__tests__/task-planner.test.ts`:断言普通/refactor/lint 任务不再产出 lint/type/import/verify 角色节点;多模块切成正交不重叠分片。
- `src/agent/__tests__/hands-session.test.ts`:共享模式不开 worktree、直写 cwd、无单 worker diff;两正交分片并行写不同文件不踩踏。
- `src/agent/__tests__/unified-plan.test.ts`(新):重叠无依赖告警 / 显式或传递定序不告警 / 正交不告警 / touchSet 优先。
- `team-grouping`、`work-order` 旧断言同步更新。
- `npx tsc --noEmit` 全绿;上述与 coordinator/team-e2e/plan-task/team-orchestrate 套件全绿。

## 已知偏差 / 待办
- `sharedWorktree` 目前**全局**默认开(不只团队模式,单独 delegate_task 写 worker 也走共享直写,因此不再生成单 worker diff 对照包,主控改看聚合 git diff)。若要收窄到仅团队模式,需在派发层加 team-only 标记透传。
- 手动 `/team` 跑一个多模块真实任务、验证多 flash 同分支并行成形——需真实模型环境,留作人工验收。

## 下一步:team max

team max 模式(多视角规划 fanout:依赖分析 / 风险审计 / 对抗盲点搜索 → 汇成计划 → 执行)在本次重构后需对齐新形态:让 max 规划产出的也是**横向正交分片计划**(而非角色流水线),并继承共享工作区直写 + 重叠校验。具体设计另开任务。
