# team 真实感知闭环 —— 密集视角审查门 + council 表面化 + scope-health 接通

> 实现记录。两拨提交，围绕同一目标：**让 team 流程在不引入重型 GAN 循环的前提下，补回"视角层"与"可观测闭环"**。
>
> - 第一拨 `d621e499` —— 给 team 执行边界接上密集视角审查门
> - 第二拨（本拨）—— team 流程优化为真实感知闭环（规划/执行/合并三层各补一处真实缺口）

## 背景与立场

对标 Anthropic「Build Agents That Run for Hours」的三 Agent（Planner / Generator / Evaluator）GAN 闭环：其核心是**自评靠不住**，必须拆出独立的、拿 Playwright 真机验证的 Evaluator 来打破"Ralph Wiggum 循环"（agent 自认为做完就退出，循环空烧 token）。

天枢与之的关键差异：**两端终端本质不同**。天枢用异构模型经济学——强模型做规划/审查，Flash 做执行。Flash 执行端"更容易保持清醒"，能完成目标任务，但**视角层容易缺失**。而 `review max` 的审查门视角本就很密（L3 五检察官 squadron：Security / Lifecycle / Data Flow / Silence / Wiring），能抓到大量风险。

所以结论不是照搬 GAN 重型生成/评判循环，而是：

1. **把已有的密集审查能力，钉到 team 执行边界上**（第一拨）——给缺视角的 Flash 执行补上对抗式视角层。
2. **把 team 流程补成真实感知闭环**（第二拨）——规划层不再丢弃 council 产出，执行层对整波失败给出别推进警示，合并层接通已建好但未接线的 scope-health。

全部 **advisory / 可观测**，不改派发逻辑、不自动续波、不自动合并 worktree。

---

## 第一拨：密集视角审查门（`d621e499`）

> Flash executors complete target tasks but lack the perspective layer；把 review-max squadron 接到 team final-wave gate，而非重型 generator/evaluator GAN loop。

改动文件：`src/tools/team-orchestrate.ts`、`src/agent/diff-collector.ts`。

三个机制（均为 `team-orchestrate.ts` 导出的纯 helper + 审查门接线）：

- **`teamReviewForceLevel(mode, change, waveTasks)` —— 强制视角密度**
  Flash 执行缺的就是视角密度，所以用 `ChangeSet.forceLevel` 程序化抬档：
  - `max` 模式 → **永远 L3**（完整五检察官 squadron），不论改动大小；
  - `standard` 模式 → 把地板抬到 **≥ L2**（消灭"小改动静默 L1 nudge 不审"），并在结构性风险信号下升 L3：cross-module / 单波 ≥3 任务 / 任一 high-risk 任务。
  - 只抬不降——`classifyChangeScale` 已判 L3 的（cross-module / ≥5 文件 / 安全边界）保持 L3。

- **`teamReviewChangedFiles(run)` —— 诚实变更文件**
  审查门触发依据从"worker 自报 `changedFiles`"改为**权威 diff**：从 worker `kind:'diff'` artifact 解析真实文件（与自报取并集）。这样一个少报/瞒报 changedFiles 的 worker **无法静默跳过整个审查门**。为此把 `diff-collector.ts` 的 `extractChangedFiles` 导出复用。

- **`teamReviewFocusHint(waveTasks)` —— 验收门喂审查焦点**
  把合并计划里每个 `TeamTask.verification` 的验收门拼成 reviewer 的 `focusHint`，让 squadron/verifier 按计划者定义的验收标准去查，而不是瞎猜（"verify these, do not just trust green"）。

接线点：`createTeamOrchestrateTool` execute 内，最后一波（`isLastWave`）且有权威变更文件时，构造 `ChangeSet` → `teamReviewForceLevel` 设 `forceLevel` → `teamReviewFocusHint` 设 `focusHint` → `routeReviewWorkflow`。

---

## 第二拨：真实感知闭环（本拨）

三个已核实的缺口，规划/执行/合并三层各补一处。全部增量、复用现有件、`try/catch` 静默，绝不影响派发与审查门结论。

```
规划: mergePerspectivesByRole → MergedPlan{tasks,conflicts,risks,deferred,verification}
        现状只取 .tasks，其余全丢 → 盲点/冲突/风险账本/合并验收门 全部消失
执行: dispatchWaveAt 一波
        整波 worker 失败也照样提示 call fromWave N+1 → 主控可能在失败/stale 态推进
合并: 真实 diff 已进 telemetry.observedChangedFiles
        但 buildTeamWaveScopeHealth 运行期零调用 → scope 泄漏(改计划外文件)不可见
```

### 规划层

**1. 折叠合并验收门到任务** —— `src/agent/team-perspectives.ts` 新增导出 `foldVerificationIntoTasks(tasks, verification)`：

`mergePerspectivesByRole` 返回合并任务（base 骨架图）**加一个独立的 `verification` 账本**，账本里含约束视角（天府）新增的验收门。不折叠的话，这些约束门**永远到不了任务**，也就永远进不了读 `TeamTask.verification` 的审查 focusHint。该 helper 把带 `taskId` 的门去重 append 进对应任务（untagged 计划级门不误折进每个任务，避免噪声）；纯函数，返回新对象不改输入。

在 `team-orchestrator.ts` max 路径 `merged = mergePerspectivesByRole(...)` 后、`saveTeamPlanSkeleton` 前调用：

```
mergedTasks = foldVerificationIntoTasks(merged.tasks, merged.verification)
```

折在缓存**之前**，所以每一波（含从 plan-cache 恢复的后续波）的审查 focusHint 都能拿到约束视角的验收门。

**2. 表面化 council 合并产出** —— `TeamRunSummary` 加可选字段：

```ts
planMerge?: Pick<MergedPlan, 'conflicts' | 'risks' | 'deferred' | 'rejected'>
```

仅 max 非 cache 命中时填充（首波）；cache 命中波为空，不重复刷屏。`formatTeamSummary` 的 `formatPlanMerge` 渲染三段——**冲突条目**（council 意见分歧待裁决）、**延后备选**（不在 base 计划中的备选方案）、**风险账本**（severity + taskId + claim）。每段截断 `CAP=3` 条 + `(+N more)` 计数，保持面板可读。

### 执行层

**3. 整波失败别推进警示** —— `formatTeamSummary`：

用 `summary.run` 判定 `allFailed = run.results.length > 0 && run.results.every(r => r.status !== 'passed')`。整波全失败时，把"call team_orchestrate again with fromWave: N+1"替换为告警：

```
⚠ wave N: all M workers failed — integrate/retry before advancing; do NOT dispatch fromWave N+1 until fixed.
```

只在有真实 `run`（派发后）时触发；`onPlanReady` 预渲染（`run` 缺省）不触发，正常续波提示照旧。防止主控在失败/stale 态上叠加破坏。

### 合并层

**4. 接通 scope-health（advisory）** —— `src/tools/team-orchestrate.ts` execute：

`team-scope-health.ts`（planned vs actual → leaked/missing/severity）此前完整但**运行期零调用**（仅测试用），而 `team-wave-telemetry.ts` 早已把真实 diff 填进 `observedChangedFiles`。本拨把它接上：`runTeamSkeleton` 返回后、审查门前，用已捕获的 `telemetryEvent`（含 `planned.files` 与 `changedFiles.observedChangedFiles`）调 `buildTeamWaveScopeHealth`：

- `persistTeamScopeHealth(store, health)` —— 落 reward store 供学习；store 不可用（无 `saveBanditState`）则 no-op。
- severity `medium`/`high` 时，把 `leakedFiles`（改了计划外文件）/`missingFiles`（计划内未触碰）写进返回内容的 `Scope health` 段。
- 把 `leakedFiles` 并进审查 `focusHint`（与第 1 项的规划验收门、第一拨的 verification focus 合并），让 squadron/verifier **重点点名计划外改动**。
- 全程 `try/catch`，遵循"遥测绝不影响派发/审查"约束。

**不阻断**：泄漏不 reject、不升级 review tier、不要求审批（用户明确选 advisory）。

---

## 不变量与边界

- 不改 `dispatchWaveAt` 派发逻辑、不自动续波、不自动合并 worktree、不改 bandit/plan-cache 行为。
- scope-health 仅 advisory：泄漏不 reject、不升级 review tier。
- 所有新增遥测/表面化均 `try/catch`，失败静默。
- 复用第一拨的 `teamReviewFocusHint`/`teamReviewChangedFiles`，只是把 leaked files 与规划验收门并入 focus。

## 明确不做（范围外）

- 不做执行闭环（一次调用内自动续多波 / 重驱动）。
- 不做合并闭环（worker worktree → 主干自动合并）。
- scope-health 不做硬阻断 / 不做 review tier 升级。
- 不做 Playwright/browser 真机 Evaluator（天枢的 review squadron 已是密集静态视角层，按差异分析无需照搬）。

## 测试

| 文件 | 覆盖 |
|------|------|
| `src/agent/__tests__/team-perspectives.test.ts` | `foldVerificationIntoTasks`：taskId 匹配折进、去重、untagged 不误折、不改输入 |
| `src/agent/__tests__/team-orchestrator.test.ts` | max 首波 `summary.planMerge` 带 conflicts/risks/deferred；mergedTasks 的 verification 含折叠门 |
| `src/tools/__tests__/team-orchestrate.test.ts` | 第一拨：forceLevel 三档、honest diff、focusHint；本拨：planMerge 渲染、cache 命中无 ledger、整波失败告警、run 缺省不告警、scope 泄漏表面化 + 喂 focus + 持久化、无泄漏无噪声、store 不可用不抛 |

三套件合计 64 项全绿；三个改动源文件 typecheck 干净（仓库其余预存报错与本功能无关）。
