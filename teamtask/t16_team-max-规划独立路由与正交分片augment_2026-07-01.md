# t16 — Team max 对齐横向正交分片:规划模型独立路由 + 合并 augment(已落地)

> 2026-07-01。承接 [t14](./t14_team-横向正交分片-共享worktree重构_2026-07-01.md)。
> t14 把 team(标准)模式改成横向正交分片 + 同分支共享直写;本轮把 **team max**(多视角规划 fanout)对齐同一形态。
> 共享工作区执行侧 max 已自动继承 t14(bootstrap `sharedWorktree:true`),**执行侧不动**。

## 背景与意图

team max 的链路:`selectExpertSet` 选 base+constraint+challenger 三视角 → 3 个 planner 并行出计划 → `mergePerspectivesByRole` 仲裁 → `groupTeamTasks` 分波 → 派发。

两个根本问题:

1. **规划模型没有独立 provider 开关**。planner 原先借用 `reviewer` profile(`tierLock:'cheap'` → 锁死 flash),且 `kind:'plan'` 被 `mapWorkOrderKindToCapabilityTask` 映射成 `code_edit`(默认 cheap-flash)。即规划模型同时和「改代码子代理」「审查子代理」共用身份,**无法单独指认强 provider**。而新形态里 base planner 吐出的就是被执行的分片图——规划质量直接决定并行拆分好坏,必须能用强模型。
   > 用户原话:「我们不是有设置子代理的路由和强模型的路由吗。规划模型可以自定义模型的 provider」——正是这个缺口。
2. **base 拆太粗时 challenger 的细分片被丢弃**。原合并把 challenger 的 extra task 一律 deferred 不执行,并行度白白损失。

## 落地改造(4 块)

### 改造 0:规划模型独立路由 + 默认强档(前置)

让「规划模型」成为可单独换 provider 的一等身份,与改代码/审查彻底解耦,默认走强档:

- **新 profile `perspective_planner`**(`src/agent/profile-registry.ts`):`role:'readonly'` + 只读工具 + `defaultKind:'plan'` + `defaultTimeoutMs:600_000`,**故意不设 tierLock**(对齐 `council_expert`,放开 authority→tier 升级)。expertisePrompt 精简,产出契约由 `buildPlannerObjective` 驱动(避免与 council_expert 的 seat-contribution 冲突)。
- **team-perspectives 改用它**:三视角 planner 委派 profile 从 `'reviewer'` → `'perspective_planner'`(`src/agent/team-orchestrator.ts`),摆脱 cheap 锁。
- **新增能力键 `planning`**(`src/model/capability.ts` 的 `CapabilityTask`),`mapWorkOrderKindToCapabilityTask('plan')` 由 `'code_edit'` → `'planning'`(`src/agent/work-order.ts`),与改代码路由解耦;`score()` 新增 planning 评分分支(偏好强推理 + 大上下文 + 稳定 JSON)。
- **默认路由**:`src/config/default.ts` 与 `src/config/schema.ts` 的 `workers.routing` 新增 `planning:'capable'`(deepseek-v4-pro)。用户随时可改这条键指向任意 provider/模型。
- **档位推荐定强档**:`src/agent/model-tier-policy.ts` `recommendModelTier` 对 `perspective_planner` 直接返回 `{tier:'strong', hardFloor:'strong'}`。**关键**:不做这一步,plan-kind 会被 `isExploration` 判成便宜探索 → `preferredTier='cheap'` → 把 capable 卡过滤掉 → 路由落不到强档。
- **解耦验证**:planner 不再被 `review.profiles.reviewer` 覆盖卡牵连;想单独覆盖规划模型(任意 tier/provider,绕过档位过滤)可配 `review.profiles.perspective_planner`。

### 改造 1:planner brief 教正交分片

`src/agent/team-perspectives.ts` 的 `ROLE_BRIEFS` + `buildPlannerObjective`,与 t14 已写进 `team_orchestrate`/`ecosystem-workflows`/`plan_task` 的措辞同口径:

- `base`:把任务横向切成正交自包含分片(每片实现 + 自跑 tsc/lint/相关测试至全绿),按模块/关注点边界切,分片间文件尽量两两不相交可并行,有先后才标 dependsOn;**禁止按 explore/lint/type/import/test 工序竖切**。
- `constraint`:聚焦**跨分片**的集成验证门禁与串行约束(每片已自验),指出哪些分片因共享文件/接口须串行并标 dependsOn,不重新竖切别人的分片。
- `challenger`:除反证/盲区外,**base 拆得过粗时提更细的正交分片(标明 files,可被采纳进执行图)**。
- `buildPlannerObjective` 追加一行分片契约(profile=patcher、kind=patch_proposal、files 取真实路径、禁工序竖切)。

### 改造 2:合并 augment(核心)

`mergePerspectivesByRole` 把原来「challenger extra 一律 deferred」改成分级判定(记 `filesOf=touchSet?.length?touchSet:files`):

- **A. gap-fill 补入**:challenger/specialist 的 extra 分片,`filesOf` 非空且与所有现有分片文件**两两不相交** → 规范化(`adoptShard`:补全 patcher/patch_proposal/medium 缺省、id 冲突改名)后加入 `tasks`,记 `augmented`。
- **B. monolith-split 替换**:某 base 分片 `b`(files≥2)被同一来源的 ≥2 个 extra **干净切分**(各 extra 两两不相交、并集 ⊆ `b.files`)→ 用这些分片替换 `b`,并**依赖重连**(原依赖 `b.id` 的任务改依赖全部替换分片,替换分片继承 `b.dependsOn`),记 `augmented`。
- **C. 其余**(与现有分片重叠、切分不干净、无 files)→ 维持 `deferred`,绝不静默写回,避免双写/踩踏。
- 结果过一次 `validateTaskGraph` 兜底,剥离悬空依赖。
- `MergedPlan` 新增 `augmented: Array<{source;title;reason}>`,区别于 `accepted`(纯参考意见)——`augmented` 真正改了执行图。

### 改造 3:重叠提醒 + 呈现

- 从 `src/agent/unified-plan.ts` 抽出可复用的 `detectOverlapWithoutOrder(tasks)`(t14 写在 `validateUnifiedPlan` 内的重叠 + 传递可达逻辑),`validateUnifiedPlan` 改为调它,行为不变。
- `src/agent/team-orchestrator.ts` max 分支对最终 `mergedTasks`(含 cached)跑该函数得 advisories;`TeamRunSummary` 新增 `advisories?: string[]` 与 `planMerge.augmented`,两处 return 填入。
- `src/tools/team-orchestrate.ts`:`formatPlanMerge` 增「已补入执行图的分片」栏,`formatTeamSummary` 增「分片建议(不阻断)」栏渲染 advisories。

## 验证

- `src/agent/__tests__/work-order.test.ts`:`mapWorkOrderKindToCapabilityTask('plan')==='planning'`。
- `src/config/__tests__/schema.test.ts`:`workers.routing.planning==='capable'`,其余任务仍 cheap-flash(旧「全部非 Pro」不变式按设计更新)。
- `src/agent/__tests__/team-perspectives.test.ts`:gap-fill 补入(disjoint extra → tasks)、overlap 仍 deferred、monolith-split 替换 + 依赖重连三分支。
- `src/agent/__tests__/team-orchestrator.test.ts`:max 把 augmented 分片纳入派发;summary 带 advisories。修了 t14 漏改的并行上限断言(2→3)。
- `src/tools/__tests__/team-orchestrate.test.ts`:渲染 augmented 栏 + advisories 栏。
- `npx tsc --noEmit` 全绿;`npm test` 全量套件全绿(退出码 0)。

## 已知偏差 / 待办

- **规划默认强档用了 `hardFloor:'strong'`**(不被自动降级到便宜档)。代价:规划这 3 个短任务不参与便宜档自动调优;换来拆分质量稳定,符合「规划质量决定一切」取向。想完全自定义(含降级)走 `review.profiles.perspective_planner` 覆盖卡。
- **augment 改图有边界**:仅在「干净切分 + 文件不相交 + 分片数增加」时替换/补入,否则 fail-safe 回退 deferred,依赖重连后过 `validateTaskGraph`。
- 手动 `/team max` 跑一个多模块真实任务、验证强模型规划 + augment 补片成形——需真实模型环境,留作人工验收。
